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
 * Job 4 — Backup Plan:       Retry queue for transient downstream failures
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
    url:  requiredEnv('DHIS2_URL'),
    user: requiredEnv('DHIS2_USER'),
    pass: requiredEnv('DHIS2_PASS'),
    de:   process.env.DHIS2_DE_STOCK_DISPENSED || 'ujPSJuS9pph'
  },
  lmis: {
    authUrl: requiredEnv('OPENLMIS_AUTH_URL'),
    mgmtUrl: requiredEnv('OPENLMIS_MGMT_URL'),
    user:    requiredEnv('OPENLMIS_USER'),
    pass:    requiredEnv('OPENLMIS_PASS'),
    client:  requiredEnv('OPENLMIS_CLIENT_ID'),
    secret:  requiredEnv('OPENLMIS_CLIENT_SECRET'),
    program: requiredEnv('OPENLMIS_PROGRAM_ID')
  }
};

const mediatorConfig = {
  urn: 'urn:mediator:lesotho-vital-link',
  version: '1.1.0',
  name: 'Vital-Link Lesotho Mediator',
  description: 'Hardened Medication Inventory Lifecycle Plugin',
  endpoints: [{
    name: 'Vital-Link Endpoint',
    host: 'vital-link',
    port: 3000,
    path: '/fhir/MedicationDispense',
    primary: true,
    type: 'http'
  }]
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
          programId: row.target_program_id?.trim() || CONFIG.lmis.program
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
// RETRY QUEUE  (Job 4 — Backup Plan)
// =============================================================================

const _retryTimers = [];

function scheduleRetry(fn) {
  const tid = setTimeout(() => {
    const idx = _retryTimers.indexOf(tid);
    if (idx !== -1) _retryTimers.splice(idx, 1);
    fn();
  }, parseInt(process.env.RETRY_DELAY_MS || '10000', 10));
  _retryTimers.push(tid);
}

function clearRetryQueue() {
  _retryTimers.forEach(clearTimeout);
  _retryTimers.length = 0;
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
    if (soh >= quantity) return { ok: true };
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

    // Job 3: Safety Gate
    const qty   = resource.quantity?.value || 0;
    const stock = await checkStock(identity, qty);
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

    // Job 4: Retry queue
    if (opensrp.status === 'rejected') {
      scheduleRetry(() => forwardToOpenSRP(resource, identity)
        .catch(e => logger.warn(`OpenSRP retry failed: ${e.message}`)));
    }
    if (lmis.status === 'rejected') {
      scheduleRetry(() => pushToOpenLMIS(resource, identity, isReceipt)
        .catch(e => logger.warn(`OpenLMIS retry failed: ${e.message}`)));
    }

    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      _lastSoH += isReceipt ? qty : -qty;
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
    const quantity  = answers['quantity']?.valueInteger ?? 0;
    const performer = qr.author?.reference || 'Practitioner/opensrp-admin';

    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt   = answers['type']?.valueCoding?.code === receiptCode;
    const dhis2DE     = isReceipt ? process.env.DHIS2_DE_STOCK_RECEIVED : undefined;

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

    const stock = await checkStock(identity, quantity);
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

    if (lmis.status === 'rejected') {
      scheduleRetry(() => pushToOpenLMIS(resource, identity, isReceipt)
        .catch(e => logger.warn(`QR OpenLMIS retry: ${e.message}`)));
    }
    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      _lastSoH += isReceipt ? quantity : -quantity;
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

module.exports = { app, mediatorConfig, clearRetryQueue };
