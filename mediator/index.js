'use strict';

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const csv     = require('csv-parser');
const utils   = require('openhim-mediator-utils');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

/**
 * VITAL-LINK MEDIATOR
 *  Plugin for Lesotho Health Department
 *
 * Sits behind OpenHIM and fans out stock movement events from the Android BKM
 * app (OpenSRP 2) to three national systems simultaneously:
 *
 *   OpenSRP 2 (Android app)
 *     └─▶ OpenHIM (intercept + audit)
 *           └─▶ Vital-Link Mediator (this service, port 3000)
 *                 ├─▶ OpenSRP   — records clinical event
 *                 ├─▶ OpenLMIS  — records stock events (DEBIT or CREDIT)
 *                 └─▶ DHIS2     — writes aggregate data values for dashboards
 *
 * Two intake routes:
 *   POST /fhir/MedicationDispense      — primary path used by the Android app
 *   POST /fhir/QuestionnaireResponse   — alternative path via app form engine
 *
 * Job 1 — Passport Control:  CSV identity mapping (performer → facility/program,
 *                             medication code → orderable)
 * Job 2 — Fan-out:           Parallel dispatch to OpenSRP + DHIS2 + OpenLMIS
 * Job 3 — Safety Gate:       Stock-on-hand pre-check; rejects (422) if insufficient
 * Job 4 — Notifications:     VHW alerts via SMS, push, and email (throttled)
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const CONFIG = {
  openhim: {
    username: requiredEnv('OPENHIM_USER'),
    password: requiredEnv('OPENHIM_PASS'),
    apiURL:   process.env.OPENHIM_URL || 'https://openhim-core:8080',
    trustSelfSigned: process.env.NODE_ENV !== 'production'
  },
  opensrp: {
    url:          requiredEnv('OPENSRP_URL'),
    clientId:     process.env.OPENSRP_CLIENT_ID     || '',
    clientSecret: process.env.OPENSRP_CLIENT_SECRET || ''
  },
  keycloak: {
    url: requiredEnv('KEYCLOAK_URL'),
  },
  dhis2: {
    url:   requiredEnv('DHIS2_URL'),
    user:  requiredEnv('DHIS2_USER'),
    pass:  requiredEnv('DHIS2_PASS'),
    de:    process.env.DHIS2_DE_STOCK_DISPENSED || 'ujPSJuS9pph',
    deSoh: process.env.DHIS2_DE_STOCK_ON_HAND   || 'StockOnHnd1'
  },
  lmis: {
    authUrl: requiredEnv('OPENLMIS_AUTH_URL'),
    mgmtUrl: requiredEnv('OPENLMIS_MGMT_URL'),
    user:    requiredEnv('OPENLMIS_USER'),
    pass:    requiredEnv('OPENLMIS_PASS'),
    client:  requiredEnv('OPENLMIS_CLIENT_ID'),
    secret:  requiredEnv('OPENLMIS_CLIENT_SECRET'),
    program: requiredEnv('OPENLMIS_PROGRAM_ID')
  },
  fhir: {
    url: process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir'
  }
};

const mediatorConfig = {
  urn: 'urn:mediator:lesotho-vital-link',
  version: '1.1.0',
  name: 'Vital-Link Lesotho Mediator',
  description: 'Hardened Medication Inventory Lifecycle Plugin',
  endpoints: [
    {
      name: 'Vital-Link Endpoint',
      host: 'bkm-mediator',
      port: 3000,
      path: '/fhir/MedicationDispense',
      primary: true,
      type: 'http'
    },
    {
      name: 'Vital-Link SupplyDelivery',
      host: 'bkm-mediator',
      port: 3000,
      path: '/fhir/SupplyDelivery',
      primary: false,
      type: 'http'
    },
    {
      name: 'Vital-Link QuestionnaireResponse',
      host: 'bkm-mediator',
      port: 3000,
      path: '/fhir/QuestionnaireResponse',
      primary: false,
      type: 'http'
    }
  ],
  defaultChannelConfig: [
    {
      name: 'BKM MedicationDispense',
      urlPattern: '^/fhir/MedicationDispense$',
      methods: ['POST'],
      type: 'http',
      status: 'enabled',
      routes: [{ name: 'Vital-Link Endpoint', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }],
      allow: [],
      authType: 'public'
    },
    {
      name: 'BKM SupplyDelivery',
      urlPattern: '^/fhir/SupplyDelivery$',
      methods: ['POST'],
      type: 'http',
      status: 'enabled',
      routes: [{ name: 'Vital-Link SupplyDelivery', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }],
      allow: [],
      authType: 'public'
    },
    {
      name: 'BKM QuestionnaireResponse',
      urlPattern: '^/fhir/QuestionnaireResponse$',
      methods: ['POST'],
      type: 'http',
      status: 'enabled',
      routes: [{ name: 'Vital-Link QuestionnaireResponse', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }],
      allow: [],
      authType: 'public'
    }
  ]
};

// =============================================================================
// LOGGING
// =============================================================================

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/vital-link-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d'
    })
  ],
});

// =============================================================================
// DYNAMIC IDENTITY MAPPING  (Job 1 — Passport Control)
// =============================================================================

let PERFORMER_MAP = {};
let MEDICATION_MAP = {};

function loadMappings() {
  if (!fs.existsSync('mappings.csv')) {
    logger.error('CRITICAL: mappings.csv missing. Use default mappings.');
    return;
  }
  fs.createReadStream('mappings.csv')
    .pipe(csv())
    .on('data', (row) => {
      if (row.type === 'performer' && row.source_id) {
        PERFORMER_MAP[row.source_id.trim()] = {
          facilityId: row.target_facility_id.trim(),
          programId: row.target_program_id?.trim() || CONFIG.lmis.program,
          phone: row.phone?.trim() || null,
          email: row.email?.trim() || null
        };
      } else if (row.type === 'medication' && row.source_id) {
        MEDICATION_MAP[row.source_id.trim()] = row.target_orderable_id.trim();
      }
    })
    .on('end', () => logger.info('Validated CSV Mappings Loaded.'));
}

// =============================================================================
// OPENLMIS TOKEN CACHE
// =============================================================================

let _lmisToken = null, _lmisExpires = 0, refreshingLMIS = null;

const TIMEOUT_MS = parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10);

async function getOpenLMISToken() {
  if (_lmisToken && Date.now() < _lmisExpires) return _lmisToken;
  if (refreshingLMIS) return refreshingLMIS;

  refreshingLMIS = (async () => {
    try {
      const res = await axios.post(`${CONFIG.lmis.authUrl}/api/oauth/token`,
        `grant_type=password&username=${CONFIG.lmis.user}&password=${CONFIG.lmis.pass}`, {
        auth: { username: CONFIG.lmis.client, password: CONFIG.lmis.secret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      _lmisToken = res.data.access_token;
      _lmisExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _lmisToken;
    } finally { refreshingLMIS = null; }
  })();
  return refreshingLMIS;
}

// =============================================================================
// KEYCLOAK TOKEN CACHE
// =============================================================================

let _kcToken = null, _kcExpires = 0, refreshingKC = null;

async function getKeycloakToken() {
  if (_kcToken && Date.now() < _kcExpires) return _kcToken;
  if (refreshingKC) return refreshingKC;

  refreshingKC = (async () => {
    try {
      const res = await axios.post(
        `${CONFIG.keycloak.url}/realms/opensrp/protocol/openid-connect/token`,
        'grant_type=client_credentials',
        {
          auth: { username: CONFIG.opensrp.clientId, password: CONFIG.opensrp.clientSecret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
      _kcToken = res.data.access_token;
      _kcExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _kcToken;
    } finally { refreshingKC = null; }
  })();
  return refreshingKC;
}


// =============================================================================
// NOTIFICATION THROTTLE
// =============================================================================
//
// Prevents notification spam by enforcing a per-channel, per-recipient,
// per-event cooldown window.
//
// Env vars (0 = no throttle; defaults are set in docker-compose.yml):
//   NOTIFY_SMS_THROTTLE_MS    — min ms between SMS to the same recipient+event
//   NOTIFY_PUSH_THROTTLE_MS   — same for push
//   NOTIFY_EMAIL_THROTTLE_MS  — same for email

const _notifCooldowns = new Map(); // key → timestamp of last successful send

function _throttleKey(channel, eventType, recipient) {
  return `${channel}:${eventType}:${recipient || '_'}`;
}

function _throttleMs(channel) {
  const envKey = `NOTIFY_${channel.toUpperCase()}_THROTTLE_MS`;
  return parseInt(process.env[envKey] || '0', 10);
}

function _canSend(channel, eventType, recipient) {
  const ms = _throttleMs(channel);
  if (ms <= 0) return true;
  const last = _notifCooldowns.get(_throttleKey(channel, eventType, recipient)) || 0;
  return (Date.now() - last) >= ms;
}

function _markSent(channel, eventType, recipient) {
  const ms = _throttleMs(channel);
  if (ms <= 0) return;
  _notifCooldowns.set(_throttleKey(channel, eventType, recipient), Date.now());
}

function clearNotifCooldowns() {
  _notifCooldowns.clear();
}

// =============================================================================
// VHW NOTIFICATIONS  (Job 4 — Notifications)
// =============================================================================
//
// Configurable via environment variables:
//   NOTIFY_SMS_ENABLED=true|false   — master SMS toggle (default: false)
//   NOTIFY_PUSH_ENABLED=true|false  — master push toggle (default: false)
//   NOTIFY_ON_DISPENSE=true|false   — fire after confirmed dispense
//   NOTIFY_ON_LOW_STOCK=true|false  — fire when post-dispense SOH < threshold
//   NOTIFY_ON_RECEIPT=true|false    — fire after confirmed receipt
//   NOTIFY_LOW_STOCK_THRESHOLD=20   — SOH units that trigger low-stock alert
//   NOTIFY_SMS_URL                  — HTTP(S) endpoint for SMS gateway
//   NOTIFY_PUSH_URL                 — HTTP(S) endpoint for push gateway (FCM-style)
//   NOTIFY_PUSH_API_KEY             — Authorization key for push gateway
//   NOTIFY_EMAIL_ENABLED=true|false — master email toggle (default: false)
//   NOTIFY_EMAIL_URL                — HTTP(S) endpoint that accepts {to,subject,body,event}
//   NOTIFY_EMAIL_FROM               — From address shown in delivered emails

function _notifMessage(ev) {
  switch (ev.type) {
    case 'dispense':
      return `Dispense confirmed: ${ev.qty} units of ${ev.medication} dispensed to ${ev.patient}`;
    case 'receipt':
      return `Receipt recorded: ${ev.qty} units of ${ev.medication} received at facility`;
    case 'low-stock':
      return `ALERT: Stock low — ${ev.medication} has ${ev.newSoh} units remaining (threshold: ${ev.threshold})`;
    default:
      return `Notification: ${ev.type}`;
  }
}

/**
 * Sends SMS, push, and/or email notifications for one or more events.
 * All failures are swallowed — notifications must never block the main flow.
 *
 * @param {Array<{type,medication,qty,patient?,newSoh?,threshold?}>} events
 * @param {string|null} phone  VHW phone number (from PERFORMER_MAP)
 * @param {string|null} email  VHW email address (from PERFORMER_MAP)
 */
async function sendNotifications(events, phone, email) {
  const smsEnabled   = process.env.NOTIFY_SMS_ENABLED   === 'true';
  const pushEnabled  = process.env.NOTIFY_PUSH_ENABLED  === 'true';
  const emailEnabled = process.env.NOTIFY_EMAIL_ENABLED === 'true';
  if (!smsEnabled && !pushEnabled && !emailEnabled) return;

  const smsUrl   = process.env.NOTIFY_SMS_URL;
  const pushUrl  = process.env.NOTIFY_PUSH_URL;
  const emailUrl = process.env.NOTIFY_EMAIL_URL;
  const apiKey   = process.env.NOTIFY_PUSH_API_KEY || '';
  const emailFrom = process.env.NOTIFY_EMAIL_FROM || 'mediator@lesotho.health';

  // Log a failed notification with its full payload so it can be extracted
  // from the log file and re-submitted later:
  //   grep '"failedNotification":true' logs/vital-link-*.log | jq '.'
  // Each entry contains channel, url, payload, error — everything needed to replay.
  function logFailed(channel, url, payload, err) {
    logger.error('Notification delivery failed', {
      failedNotification: true,
      channel,
      url,
      payload,
      error: err.message,
      code:  err.code || null
    });
  }

  const promises = [];

  for (const ev of events) {
    const message = _notifMessage(ev);
    const title   = ev.type === 'low-stock' ? 'Low Stock Alert' : 'Stock Update';

    if (smsEnabled && smsUrl && phone) {
      if (_canSend('sms', ev.type, phone)) {
        const smsPayload = { to: phone, message, event: ev.type };
        promises.push(
          axios.post(smsUrl, smsPayload, { timeout: TIMEOUT_MS })
            .then(() => { _markSent('sms', ev.type, phone); logger.info(`SMS sent: event=${ev.type} to=${phone}`); })
            .catch(e => logFailed('sms', smsUrl, smsPayload, e))
        );
      } else {
        logger.info(`SMS throttled: event=${ev.type} to=${phone} (cooldown active)`);
      }
    }

    if (pushEnabled && pushUrl) {
      const pushRecipient = phone || 'vhw';
      if (_canSend('push', ev.type, pushRecipient)) {
        const pushHeaders  = apiKey ? { Authorization: `key=${apiKey}` } : {};
        const pushPayload  = { to: pushRecipient, title, body: message, event: ev.type };
        promises.push(
          axios.post(pushUrl, pushPayload, { headers: pushHeaders, timeout: TIMEOUT_MS })
            .then(() => { _markSent('push', ev.type, pushRecipient); logger.info(`Push sent: event=${ev.type}`); })
            .catch(e => logFailed('push', pushUrl, pushPayload, e))
        );
      } else {
        logger.info(`Push throttled: event=${ev.type} (cooldown active)`);
      }
    }

    if (emailEnabled && emailUrl && email) {
      if (_canSend('email', ev.type, email)) {
        const emailPayload = { to: email, from: emailFrom, subject: title, body: message, event: ev.type };
        promises.push(
          axios.post(emailUrl, emailPayload, { timeout: TIMEOUT_MS })
            .then(() => { _markSent('email', ev.type, email); logger.info(`Email sent: event=${ev.type} to=${email}`); })
            .catch(e => logFailed('email', emailUrl, emailPayload, e))
        );
      } else {
        logger.info(`Email throttled: event=${ev.type} to=${email} (cooldown active)`);
      }
    }
  }

  await Promise.all(promises);
}

// =============================================================================
// STOCK VALIDATION GATE  (Job 3 — Safety Gate)
// =============================================================================

/**
 * Checks OpenLMIS stock-on-hand BEFORE fan-out.
 * Fail-open: network/auth errors always return ok=true so patient care
 * is never blocked by a monitoring outage.
 */
async function checkStock(identity, quantity) {
  try {
    const token = await getOpenLMISToken();
    const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params: { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });
    const content = res.data.content || [];
    if (content.length === 0) {
      logger.info('No stock card yet — first dispense will create it');
      return { ok: true };
    }
    const soh = content[0].stockOnHand;
    logger.debug(`Stock check: SOH=${soh} requested=${quantity}`);
    if (soh >= quantity) return { ok: true, stockOnHand: soh };
    return { ok: false, stockOnHand: soh, requested: quantity };
  } catch (err) {
    logger.warn(`Stock check failed (fail-open): ${err.message}`);
    return { ok: true };
  }
}

// =============================================================================
// DOWNSTREAM INTEGRATION: OPENSRP
// =============================================================================

async function forwardToOpenSRP(resource, identity) {
  const token = await getKeycloakToken();
  const eventDate = resource.whenHandedOver?.split('T')[0]
    || new Date().toISOString().split('T')[0];

  const body = {
    clients: [],
    events: [{
      eventType:    'MedicationDispense',
      baseEntityId: resource.subject?.reference             || 'unknown',
      providerId:   resource.performer?.[0]?.actor?.reference || 'unknown',
      eventDate,
      obs: [{
        fieldCode: 'quantity',
        values:    [String(resource.quantity?.value || 0)]
      }]
    }]
  };

  logger.debug(`OpenSRP event/add POST: eventDate=${eventDate}`);
  const res = await axios.post(`${CONFIG.opensrp.url}/opensrp/rest/event/add`, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_MS
  });
  logger.debug(`OpenSRP event/add response: HTTP ${res.status}`);
  return res;
}

// =============================================================================
// DOWNSTREAM INTEGRATION: OPENLMIS
// =============================================================================

async function pushToOpenLMIS(resource, identity, isReceipt = false) {
  const token    = await getOpenLMISToken();
  const quantity = resource.quantity?.value || 0;

  const reasonId = isReceipt
    ? (process.env.OPENLMIS_RECEIPT_REASON_ID || '313f2f5f-0c22-4626-8c49-3554ef763de3')
    : (process.env.OPENLMIS_REASON_ID         || 'b5c27da7-bdda-4790-925a-9484c5dfb594');

  const occurredDate = resource.whenHandedOver?.split('T')[0]
    || new Date().toISOString().split('T')[0];

  const lineItem = {
    orderableId:     identity.orderableId,
    quantity,
    occurredDate,
    reasonId,
    documentationNo: `BKM-${resource.id || Date.now()}`
  };
  if (process.env.OPENLMIS_LOT_ID) lineItem.lotId = process.env.OPENLMIS_LOT_ID;

  const body = {
    facilityId: identity.facilityId,
    programId:  identity.programId,
    lineItems:  [lineItem]
  };
  logger.debug(`OpenLMIS stockEvents POST: ${JSON.stringify(body)}`);
  const res = await axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, body,
    { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
  logger.debug(`OpenLMIS stockEvents response: HTTP ${res.status}`);
  return res;
}

// =============================================================================
// DOWNSTREAM INTEGRATION: DHIS2
// =============================================================================

async function pushToDHIS2(resource, dataElement) {
  const de = dataElement || CONFIG.dhis2.de;
  const payload = {
    dataValues: [{
      dataElement: de,
      orgUnit: process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
      period: new Date().toISOString().slice(0, 7).replace('-', ''),
      value: String(resource.quantity?.value || 0)
    }]
  };
  logger.debug(`DHIS2 dataValueSets POST: de=${de} value=${payload.dataValues[0].value}`);
  const res = await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, payload, {
    auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass },
    timeout: TIMEOUT_MS
  });
  logger.debug(`DHIS2 dataValueSets response: HTTP ${res.status}`);
  return res;
}

// =============================================================================
// POST-EVENT SOH SYNC TO DHIS2
// =============================================================================

/**
 * After a successful eLMIS stock event, queries the updated stock-on-hand
 * from OpenLMIS and writes it to DHIS2 as a separate data element.
 * Fail-open: errors are logged but never surface to the caller.
 */
async function pushSohToDHIS2(identity) {
  try {
    const token = await getOpenLMISToken();
    const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params: { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });
    const content = res.data.content || [];
    if (content.length === 0) return;
    const soh = content[0].stockOnHand;
    await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, {
      dataValues: [{
        dataElement: CONFIG.dhis2.deSoh,
        orgUnit:     process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
        period:      new Date().toISOString().slice(0, 7).replace('-', ''),
        value:       String(soh)
      }]
    }, { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass }, timeout: TIMEOUT_MS });
    logger.info(`SOH synced to DHIS2: ${soh} units (de=${CONFIG.dhis2.deSoh})`);
  } catch (err) {
    logger.warn(`SOH sync to DHIS2 failed (non-fatal): ${err.message}`);
  }
}

// =============================================================================
// BACKGROUND STOCK RECEIPT POLLER
// =============================================================================

let _lastSoH = null;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);

async function pollStockLevels() {
  const facilityId  = process.env.OPENLMIS_FACILITY_ID;
  const programId   = process.env.OPENLMIS_PROGRAM_ID;
  const orderableId = process.env.OPENLMIS_ORDERABLE_ID;
  if (!facilityId || !programId || !orderableId) return;

  try {
    const token = await getOpenLMISToken();
    const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params: { facility: facilityId, program: programId, orderable: orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });

    const content = res.data.content || [];
    if (content.length === 0) return;
    const currentSoH = content[0].stockOnHand;

    if (_lastSoH === null) { _lastSoH = currentSoH; return; }

    const delta = currentSoH - _lastSoH;
    if (delta > 0) {
      logger.info(`Stock receipt detected via poll: SOH ${_lastSoH} → ${currentSoH} (+${delta})`);
      const deReceived = process.env.DHIS2_DE_STOCK_RECEIVED;
      if (deReceived) {
        await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, {
          dataValues: [{
            dataElement: deReceived,
            orgUnit: process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
            period: new Date().toISOString().slice(0, 7).replace('-', ''),
            value: String(delta)
          }]
        }, { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass }, timeout: TIMEOUT_MS });
        logger.info(`Stock receipt synced to DHIS2: ${delta} units → ${deReceived}`);
      }
    } else if (delta < 0) {
      logger.info(`Out-of-band dispense via poll: SOH ${_lastSoH} → ${currentSoH} (${delta})`);
    }
    _lastSoH = currentSoH;
  } catch (err) {
    logger.warn(`Stock poll failed (non-fatal): ${err.message}`);
  }
}

// =============================================================================
// STOCK ACCEPTANCE  (BR-03, BR-04, BR-05)
// =============================================================================

/**
 * Creates a FHIR Task on HAPI FHIR representing a stock issue pending acceptance.
 * Called when eLMIS issues stock to a VHW (POST /fhir/SupplyDelivery).
 * Returns the created Task resource.
 */
async function createStockTask({ performer, medication, quantity, issueRef, taskId }) {
  const id = taskId || `task-stock-${Date.now()}`;
  const task = {
    resourceType: 'Task',
    id,
    status:   'requested',
    intent:   'order',
    code: {
      coding: [{ system: 'http://snomed.info/sct', code: '373748001', display: 'Stock Issue' }]
    },
    description: `${medication} — ${quantity} units (ref: ${issueRef || id})`,
    for:     { reference: performer },
    owner:   { reference: performer },
    authoredOn: new Date().toISOString(),
    input: [
      { type: { text: 'product'  }, valueString:  medication },
      { type: { text: 'quantity' }, valueInteger: quantity   },
      { type: { text: 'issueRef' }, valueString:  issueRef || id }
    ]
  };
  const res = await axios.put(`${CONFIG.fhir.url}/Task/${id}`, task, {
    headers: { 'Content-Type': 'application/fhir+json' },
    timeout: TIMEOUT_MS
  });
  logger.info(`Stock Task created: Task/${id} for ${performer} — ${medication} x${quantity}`);
  return res.data;
}

/**
 * Fetches a Task from HAPI FHIR. Returns null on 404.
 */
async function fetchStockTask(taskId) {
  try {
    const res = await axios.get(`${CONFIG.fhir.url}/Task/${taskId}`, { timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Marks a stock acceptance Task as completed on HAPI FHIR.
 * Fail-open: errors are logged but never surface to the caller.
 */
async function completeStockTask(taskId) {
  try {
    const task = await fetchStockTask(taskId);
    if (!task) { logger.warn(`completeStockTask: Task/${taskId} not found`); return; }
    task.status = 'completed';
    task.lastModified = new Date().toISOString();
    await axios.put(`${CONFIG.fhir.url}/Task/${taskId}`, task, {
      headers: { 'Content-Type': 'application/fhir+json' },
      timeout: TIMEOUT_MS
    });
    logger.info(`Stock Task completed: Task/${taskId}`);
  } catch (err) {
    logger.warn(`completeStockTask failed (non-fatal): ${err.message}`);
  }
}

// =============================================================================
// EXPRESS APP + ROUTES
// =============================================================================

const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

const fmtResult = (r) => r.status === 'fulfilled'
  ? `HTTP ${r.value.status}`
  : (r.reason?.message || 'unknown error');

// -----------------------------------------------------------------------------
// POST /fhir/MedicationDispense
// -----------------------------------------------------------------------------
app.post('/fhir/MedicationDispense', async (req, res) => {
  const resource = req.body;
  const t0 = Date.now();
  logger.debug(`MedicationDispense: subject=${resource.subject?.reference} qty=${resource.quantity?.value}`);

  try {
    // Job 1: Identity resolution
    const performer = resource.performer?.[0]?.actor?.reference;
    const medCode   = resource.medicationCodeableConcept?.coding?.[0]?.code;

    const fromMap  = PERFORMER_MAP[performer] || PERFORMER_MAP['default'];
    const identity = fromMap
      ? { ...fromMap }
      : { facilityId: process.env.OPENLMIS_FACILITY_ID, programId: process.env.OPENLMIS_PROGRAM_ID };
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'] || process.env.OPENLMIS_ORDERABLE_ID;

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`Incomplete mapping: performer=${performer} medication=${medCode}`);
    }

    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt   = resource.type?.coding?.some(c => c.code === receiptCode) ?? false;
    const dhis2DE     = isReceipt ? process.env.DHIS2_DE_STOCK_RECEIVED : undefined;

    // Job 3: Safety Gate (skip for receipts — adding stock is never blocked)
    const qty   = resource.quantity?.value || 0;
    const stock = isReceipt ? { ok: true } : await checkStock(identity, qty);
    if (!stock.ok) {
      logger.warn(`Insufficient stock: SOH=${stock.stockOnHand} requested=${stock.requested}`);
      return res
        .status(422)
        .set('x-mediator-urn', mediatorConfig.urn)
        .json({ status: 'Rejected', reason: 'insufficient-stock',
                stockOnHand: stock.stockOnHand, requested: stock.requested });
    }

    // Job 2: Fan-out
    const [opensrp, dhis, lmis] = await Promise.allSettled([
      forwardToOpenSRP(resource, identity),
      pushToDHIS2(resource, dhis2DE),
      pushToOpenLMIS(resource, identity, isReceipt)
    ]);

    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      _lastSoH += isReceipt ? qty : -qty;
    }
    if (lmis.status === 'fulfilled') { pushSohToDHIS2(identity).catch(() => {}); }

    // Job 4: VHW Notifications (non-blocking; failures are swallowed inside sendNotifications)
    if (lmis.status === 'fulfilled') {
      const vhw       = PERFORMER_MAP[performer] || {};
      const phone     = vhw.phone || null;
      const vhwEmail  = vhw.email || null;
      const medCode   = resource.medicationCodeableConcept?.coding?.[0]?.code || 'unknown';
      const patient   = resource.subject?.reference || 'unknown';
      const threshold = parseInt(process.env.NOTIFY_LOW_STOCK_THRESHOLD || '20', 10);
      const eventsToNotify = [];

      if (!isReceipt && process.env.NOTIFY_ON_DISPENSE === 'true') {
        eventsToNotify.push({ type: 'dispense', qty, medication: medCode, patient });
      }
      if (isReceipt && process.env.NOTIFY_ON_RECEIPT === 'true') {
        eventsToNotify.push({ type: 'receipt', qty, medication: medCode, patient });
      }
      if (!isReceipt && process.env.NOTIFY_ON_LOW_STOCK === 'true' && stock.stockOnHand !== undefined) {
        const newSoh = stock.stockOnHand - qty;
        if (newSoh < threshold) {
          eventsToNotify.push({ type: 'low-stock', medication: medCode, newSoh, threshold });
        }
      }

      if (eventsToNotify.length > 0) {
        sendNotifications(eventsToNotify, phone, vhwEmail)
          .catch(e => logger.warn(`Notification batch failed: ${e.message}`));
      }
    }

    const allOk = [opensrp, dhis, lmis].every(r => r.status === 'fulfilled');
    logger.info(`MedicationDispense in ${Date.now() - t0}ms (opensrp=${opensrp.status} dhis2=${dhis.status} lmis=${lmis.status})`);

    res
      .status(allOk ? 200 : 207)
      .set('x-mediator-urn', mediatorConfig.urn)
      .json({
        status:  allOk ? 'Successful' : 'Completed with errors',
        type:    isReceipt ? 'receipt' : 'dispense',
        results: { opensrp: fmtResult(opensrp), dhis2: fmtResult(dhis), openlmis: fmtResult(lmis) }
      });

  } catch (err) {
    logger.error(`Orchestration failed: ${err.message}`);
    res.status(500).set('x-mediator-urn', mediatorConfig.urn)
      .json({ status: 'Error', message: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /fhir/SupplyDelivery  — eLMIS issues stock to a VHW
// Creates a FHIR Task on HAPI FHIR representing a pending acceptance (BR-03).
// Body: { performer, medication, quantity, issueRef? }
// -----------------------------------------------------------------------------
app.post('/fhir/SupplyDelivery', async (req, res) => {
  const { performer, medication, quantity, issueRef } = req.body;
  try {
    if (!performer || !medication || !quantity) {
      return res.status(400).set('x-mediator-urn', mediatorConfig.urn)
        .json({ status: 'Error', message: 'performer, medication, and quantity are required' });
    }
    const task = await createStockTask({ performer, medication, quantity: Number(quantity), issueRef });
    res.status(201).set('x-mediator-urn', mediatorConfig.urn)
      .json({ status: 'Created', taskId: task.id, task });
  } catch (err) {
    logger.error(`SupplyDelivery failed: ${err.message}`);
    res.status(500).set('x-mediator-urn', mediatorConfig.urn)
      .json({ status: 'Error', message: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /fhir/QuestionnaireResponse
// -----------------------------------------------------------------------------
app.post('/fhir/QuestionnaireResponse', async (req, res) => {
  const qr = req.body;
  const t0 = Date.now();

  try {
    const answers = {};
    for (const item of (qr.item || [])) {
      const ans = item.answer?.[0];
      if (ans) answers[item.linkId] = ans;
    }

    const medCode   = answers['medication']?.valueCoding?.code || 'AL-20-120';
    const quantity  = answers['quantity']?.valueInteger ?? answers['quantity_accepted']?.valueInteger ?? 0;
    const performer = qr.author?.reference || 'Practitioner/opensrp-admin';

    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt   = answers['type']?.valueCoding?.code === receiptCode;
    const dhis2DE     = isReceipt ? process.env.DHIS2_DE_STOCK_RECEIVED : undefined;

    // BR-04: if this QR is based on a stock acceptance Task, validate it hasn't
    // already been accepted (prevents duplicate acceptance of same stock issue).
    const taskRef = qr.basedOn?.[0]?.reference || (answers['task_id'] ? `Task/${answers['task_id'].valueString}` : null);
    const taskId  = taskRef?.startsWith('Task/') ? taskRef.split('/')[1] : null;
    if (taskId) {
      const task = await fetchStockTask(taskId);
      if (!task) {
        return res.status(404).set('x-mediator-urn', mediatorConfig.urn)
          .json({ status: 'Error', message: `Task/${taskId} not found` });
      }
      if (task.status !== 'requested') {
        logger.warn(`BR-04 violation: Task/${taskId} already has status=${task.status}`);
        return res.status(409).set('x-mediator-urn', mediatorConfig.urn)
          .json({ status: 'Rejected', reason: 'already-accepted', taskId, taskStatus: task.status });
      }
    }

    const resource = {
      id:       qr.id || `qr-${Date.now()}`,
      status:   'completed',
      performer: [{ actor: { reference: performer } }],
      medicationCodeableConcept: { coding: [{ code: medCode }] },
      quantity: { value: quantity }
    };

    const fromMap  = PERFORMER_MAP[performer] || PERFORMER_MAP['default'];
    const identity = fromMap
      ? { ...fromMap }
      : { facilityId: process.env.OPENLMIS_FACILITY_ID, programId: process.env.OPENLMIS_PROGRAM_ID };
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'] || process.env.OPENLMIS_ORDERABLE_ID;

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`No mapping for performer=${performer} medication=${medCode}`);
    }

    const stock = isReceipt ? { ok: true } : await checkStock(identity, quantity);
    if (!stock.ok) {
      return res.status(422).set('x-mediator-urn', mediatorConfig.urn).json({
        status: 'Rejected', reason: 'insufficient-stock',
        stockOnHand: stock.stockOnHand, requested: stock.requested
      });
    }

    const [opensrp, dhis, lmis] = await Promise.allSettled([
      forwardToOpenSRP(resource, identity),
      pushToDHIS2(resource, dhis2DE),
      pushToOpenLMIS(resource, identity, isReceipt)
    ]);

    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      _lastSoH += isReceipt ? quantity : -quantity;
    }
    if (lmis.status === 'fulfilled') { pushSohToDHIS2(identity).catch(() => {}); }

    // BR-04: mark Task completed so it can't be accepted again
    if (lmis.status === 'fulfilled' && taskId) {
      completeStockTask(taskId).catch(() => {});
    }

    // Job 4: VHW Notifications
    if (lmis.status === 'fulfilled') {
      const vhw       = PERFORMER_MAP[performer] || {};
      const phone     = vhw.phone || null;
      const vhwEmail  = vhw.email || null;
      const threshold = parseInt(process.env.NOTIFY_LOW_STOCK_THRESHOLD || '20', 10);
      const patient   = qr.subject?.reference || 'unknown';
      const eventsToNotify = [];

      if (!isReceipt && process.env.NOTIFY_ON_DISPENSE === 'true') {
        eventsToNotify.push({ type: 'dispense', qty: quantity, medication: medCode, patient });
      }
      if (isReceipt && process.env.NOTIFY_ON_RECEIPT === 'true') {
        eventsToNotify.push({ type: 'receipt', qty: quantity, medication: medCode, patient });
      }
      if (!isReceipt && process.env.NOTIFY_ON_LOW_STOCK === 'true' && stock.stockOnHand !== undefined) {
        const newSoh = stock.stockOnHand - quantity;
        if (newSoh < threshold) {
          eventsToNotify.push({ type: 'low-stock', medication: medCode, newSoh, threshold });
        }
      }

      if (eventsToNotify.length > 0) {
        sendNotifications(eventsToNotify, phone, vhwEmail)
          .catch(e => logger.warn(`QR notification batch failed: ${e.message}`));
      }
    }

    const allOk = [opensrp, dhis, lmis].every(r => r.status === 'fulfilled');
    logger.info(`QR fan-out in ${Date.now() - t0}ms — opensrp=${opensrp.status} dhis2=${dhis.status} lmis=${lmis.status}`);

    res.status(allOk ? 200 : 207).set('x-mediator-urn', mediatorConfig.urn).json({
      status:  allOk ? 'Successful' : 'Completed with errors',
      type:    isReceipt ? 'receipt' : 'dispense',
      results: { opensrp: fmtResult(opensrp), dhis2: fmtResult(dhis), openlmis: fmtResult(lmis) }
    });
  } catch (err) {
    logger.error(`QR fan-out failed: ${err.message}`);
    res.status(500).set('x-mediator-urn', mediatorConfig.urn)
      .json({ status: 'Error', message: err.message });
  }
});

// =============================================================================
// STARTUP
// =============================================================================

loadMappings();

utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
  if (err) {
    logger.error('Failed to register with OpenHIM');
    process.exit(1);
  }
  app.listen(3000, () => {
    logger.info('Vital-Link Lesotho v1.1.0 Active on port 3000');
    setTimeout(pollStockLevels, 10000);
    setInterval(pollStockLevels, POLL_INTERVAL_MS);
  });
});

// =============================================================================
// EXPORTS  (used by Jest unit tests)
// =============================================================================

module.exports = { app, mediatorConfig, clearNotifCooldowns };
