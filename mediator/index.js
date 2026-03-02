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
 * app (OpenSRP 2) to two national systems simultaneously:
 *
 *   OpenSRP 2 (Android app)
 *     └─▶ OpenHIM (intercept + audit)
 *           └─▶ Vital-Link Mediator (this service, port 3000)
 *                 ├─▶ OpenLMIS  — records stock events (DEBIT or CREDIT)
 *                 └─▶ DHIS2     — writes aggregate data values for dashboards
 *
 * Two intake routes:
 *   POST /fhir/MedicationDispense      — primary path used by the Android app
 *   POST /fhir/QuestionnaireResponse   — alternative path via app form engine
 *
 * Both routes support dispense (stock out) and receipt (stock in) events.
 * A background poller also watches OpenLMIS SOH for receipts entered directly
 * in the eLMIS web UI and forwards the delta to DHIS2.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Reads a required environment variable; crashes at startup if missing.
 * This ensures misconfigured deployments fail fast instead of silently
 * producing bad data.
 */
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
    url: requiredEnv('OPENSRP_URL'),
    clientId: process.env.OPENSRP_CLIENT_ID || '',
    clientSecret: process.env.OPENSRP_CLIENT_SECRET || ''
  },
  keycloak: {
    url: requiredEnv('KEYCLOAK_URL'),
  },
  dhis2: {
    url:  requiredEnv('DHIS2_URL'),
    user: requiredEnv('DHIS2_USER'),
    pass: requiredEnv('DHIS2_PASS'),
    // Default data element for stock dispensed (AL 20/120mg); override via env
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

// OpenHIM mediator registration descriptor — tells OpenHIM this mediator's
// URN, version, and which HTTP endpoint to proxy inbound traffic to.
const mediatorConfig = {
  urn: 'urn:mediator:lesotho-vital-link',
  version: '1.0.0',
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

// Structured JSON logs to console + daily rotating files (30-day retention).
// Set LOG_LEVEL=debug in docker-compose.yml to see full request/response bodies.
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
// DYNAMIC IDENTITY MAPPING
// =============================================================================

// PERFORMER_MAP  — maps a Practitioner reference (e.g. "Practitioner/opensrp-admin")
//                  to an OpenLMIS { facilityId, programId } pair.
// MEDICATION_MAP — maps a medication code (e.g. "AL-20-120") to an OpenLMIS orderableId UUID.
//
// Both are loaded at startup from mappings.csv (columns: type, source_id,
// target_facility_id, target_program_id, target_orderable_id).
// If the CSV is absent or a key is not found, env-var defaults are used instead.
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

// OpenLMIS uses OAuth2 password-grant tokens with a finite lifetime.
// We cache the token in memory and reuse it until 60 seconds before expiry.
// The refreshingLMIS promise prevents concurrent requests from all triggering
// a token refresh at the same time (thundering-herd protection).
let _lmisToken = null, _lmisExpires = 0, refreshingLMIS = null;

// Per-call timeout applied to every downstream HTTP request (OpenLMIS + DHIS2).
const TIMEOUT_MS = parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10);

/**
 * Returns a valid OpenLMIS Bearer token, fetching a new one when needed.
 * Concurrent callers waiting on a refresh will all receive the same promise
 * rather than each triggering their own token request.
 */
async function getOpenLMISToken() {
  if (_lmisToken && Date.now() < _lmisExpires) {
    logger.debug(`OpenLMIS token cache hit (expires in ${Math.round((_lmisExpires - Date.now()) / 1000)}s)`);
    return _lmisToken;
  }
  if (refreshingLMIS) {
    logger.debug('OpenLMIS token refresh already in flight — awaiting');
    return refreshingLMIS;
  }

  logger.debug(`Fetching fresh OpenLMIS token from ${CONFIG.lmis.authUrl}`);
  refreshingLMIS = (async () => {
    try {
      const res = await axios.post(`${CONFIG.lmis.authUrl}/api/oauth/token`,
        `grant_type=password&username=${CONFIG.lmis.user}&password=${CONFIG.lmis.pass}`, {
        auth: { username: CONFIG.lmis.client, password: CONFIG.lmis.secret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      _lmisToken = res.data.access_token;
      // Subtract 60s from the server-reported lifetime so we refresh before
      // the token actually expires and never send a request with a stale token.
      _lmisExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      logger.debug(`OpenLMIS token acquired (expires_in=${res.data.expires_in}s)`);
      return _lmisToken;
    } finally { refreshingLMIS = null; }
  })();
  return refreshingLMIS;
}

// =============================================================================
// STOCK CARD PRE-CHECK
// =============================================================================

/**
 * Queries OpenLMIS to confirm whether a stock card exists for the resolved
 * identity (facility + program + orderable). Logs a notice if absent — the
 * card will be auto-created by OpenLMIS on the first stock event.
 *
 * This is intentionally non-fatal: a failed check must never block the fan-out.
 * Errors are swallowed and logged as warnings.
 */
async function ensureStockCard(identity) {
  logger.debug(`ensureStockCard: facility=${identity.facilityId} program=${identity.programId} orderable=${identity.orderableId}`);
  try {
    const token = await getOpenLMISToken();
    const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params: { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });
    const content = res.data.content || [];
    if (content.length === 0) {
      logger.info(`Stock card not yet provisioned for facility ${identity.facilityId} — first stock event will create it.`);
    } else {
      logger.debug(`Stock card found: SOH=${content[0].stockOnHand}, orderable=${content[0].orderable?.id}`);
    }
  } catch (err) {
    logger.warn(`ensureStockCard check failed (non-fatal): ${err.message}`);
  }
}

// =============================================================================
// DOWNSTREAM INTEGRATION: OPENLMIS
// =============================================================================

/**
 * Posts a stock event to OpenLMIS stockmanagement.
 *
 * @param {object} resource  - FHIR MedicationDispense (or synthetic equivalent)
 * @param {object} identity  - Resolved { facilityId, programId, orderableId }
 * @param {boolean} isReceipt - true → CREDIT (Receipts reason); false → DEBIT (Consumed reason)
 *
 * OpenLMIS reason UUIDs:
 *   CREDIT (receipt)  — OPENLMIS_RECEIPT_REASON_ID  (default: 313f2f5f-...)
 *   DEBIT  (dispense) — OPENLMIS_REASON_ID           (default: b5c27da7-...)
 *
 * A user-scoped OAuth token is required because stockEvents.userid is NOT NULL
 * in the DB — a service-account token has no userId and causes a constraint error.
 */
async function pushToOpenLMIS(resource, identity, isReceipt = false) {
  const token = await getOpenLMISToken();
  const quantity = resource.quantity?.value || 0;

  const reasonId = isReceipt
    ? (process.env.OPENLMIS_RECEIPT_REASON_ID || '313f2f5f-0c22-4626-8c49-3554ef763de3')
    : (process.env.OPENLMIS_REASON_ID         || 'b5c27da7-bdda-4790-925a-9484c5dfb594');

  const body = {
    facilityId: identity.facilityId,
    programId: identity.programId,
    lineItems: [{
      orderableId: identity.orderableId,
      quantity: quantity,
      occurredDate: new Date().toISOString().split('T')[0],
      reasonId: reasonId,
      documentationNo: `BKM-${resource.id || Date.now()}`
    }]
  };
  logger.debug(`OpenLMIS stockEvents POST: ${JSON.stringify(body)}`);
  const res = await axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, body,
    { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
  logger.debug(`OpenLMIS stockEvents response: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
  return res;
}

// =============================================================================
// DOWNSTREAM INTEGRATION: DHIS2
// =============================================================================

/**
 * Posts an aggregate data value to DHIS2 for the current month.
 *
 * @param {object} resource     - FHIR MedicationDispense (or synthetic equivalent)
 * @param {string} [dataElement] - DHIS2 data element UID. Defaults to the
 *                                 "Stock Dispensed" DE (DHIS2_DE_STOCK_DISPENSED).
 *                                 Pass DHIS2_DE_STOCK_RECEIVED for receipt events.
 *
 * The period is always the current calendar month (YYYYMM). DHIS2 will
 * accumulate multiple imports for the same period/orgUnit/DE by replacing
 * the stored value — so the national dashboard shows the latest reported figure,
 * not a running total.
 */
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
  logger.debug(`DHIS2 dataValueSets POST: de=${de} value=${payload.dataValues[0].value} period=${payload.dataValues[0].period}`);
  const res = await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, payload, {
    auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass },
    timeout: TIMEOUT_MS
  });
  logger.debug(`DHIS2 dataValueSets response: HTTP ${res.status} status=${res.data?.status}`);
  return res;
}

// =============================================================================
// BACKGROUND STOCK RECEIPT POLLER
// =============================================================================

// Tracks the last known stock-on-hand figure so we can detect changes.
// Initialised to null; first poll establishes the baseline without pushing.
// Updated after every successful app-posted event so the poller doesn't
// double-count quantities already forwarded through the mediator routes.
let _lastSoH = null;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);

/**
 * Polls OpenLMIS stockCardSummaries on a fixed interval and compares the
 * current stock-on-hand against the last recorded value (_lastSoH).
 *
 * delta > 0  → SOH increased — stock was received directly in eLMIS (e.g. via
 *              the OpenLMIS web UI, not through this mediator). Forward the
 *              delta to DHIS2 so the national dashboard stays accurate.
 *
 * delta < 0  → SOH decreased — an out-of-band dispense was recorded in eLMIS.
 *              Logged as an informational notice only; no DHIS2 push (we cannot
 *              reliably distinguish which medication was dispensed).
 *
 * delta = 0  → No change; logged at debug level only.
 *
 * This function is non-fatal: any error (network, auth expiry, etc.) is caught,
 * logged as a warning, and the next scheduled poll will retry.
 */
async function pollStockLevels() {
  const facilityId  = process.env.OPENLMIS_FACILITY_ID;
  const programId   = process.env.OPENLMIS_PROGRAM_ID;
  const orderableId = process.env.OPENLMIS_ORDERABLE_ID;
  if (!facilityId || !programId || !orderableId) {
    logger.debug('Stock poll skipped: OPENLMIS_FACILITY_ID/PROGRAM_ID/ORDERABLE_ID not set');
    return;
  }

  logger.debug(`Stock poll: querying SOH (lastKnown=${_lastSoH})`);
  try {
    const token = await getOpenLMISToken();
    const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params: { facility: facilityId, program: programId, orderable: orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });

    const content = res.data.content || [];
    if (content.length === 0) {
      logger.debug('Stock poll: no stock card found yet');
      return;
    }
    const currentSoH = content[0].stockOnHand;
    logger.debug(`Stock poll: currentSoH=${currentSoH} lastSoH=${_lastSoH}`);

    if (_lastSoH === null) {
      // First successful poll — record baseline, do not push anything to DHIS2
      _lastSoH = currentSoH;
      logger.info(`Stock poll: baseline SOH = ${currentSoH}`);
      return;
    }

    const delta = currentSoH - _lastSoH;
    if (delta > 0) {
      logger.info(`Stock receipt detected via poll: SOH ${_lastSoH} → ${currentSoH} (+${delta})`);
      const deReceived = process.env.DHIS2_DE_STOCK_RECEIVED;
      if (deReceived) {
        logger.debug(`Stock poll: pushing ${delta} units to DHIS2 DE=${deReceived}`);
        const dhisRes = await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, {
          dataValues: [{
            dataElement: deReceived,
            orgUnit: process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
            period: new Date().toISOString().slice(0, 7).replace('-', ''),
            value: String(delta)
          }]
        }, {
          auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass },
          timeout: TIMEOUT_MS
        });
        logger.info(`Stock receipt synced to DHIS2: ${delta} units → ${deReceived}`);
        logger.debug(`DHIS2 poll sync response: HTTP ${dhisRes.status} status=${dhisRes.data?.status}`);
      } else {
        logger.debug('Stock poll: DHIS2_DE_STOCK_RECEIVED not set — receipt logged only');
      }
    } else if (delta < 0) {
      logger.info(`Stock dispense detected via poll (not through mediator): SOH ${_lastSoH} → ${currentSoH} (${delta})`);
    } else {
      logger.debug(`Stock poll: SOH unchanged at ${currentSoH}`);
    }
    _lastSoH = currentSoH;
  } catch (err) {
    logger.warn(`Stock poll failed (non-fatal): ${err.message}`);
    logger.debug(`Stock poll error detail: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
  }
}

// =============================================================================
// EXPRESS APP + ROUTES
// =============================================================================

const app = express();
// Accept both generic JSON and FHIR JSON content types
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

// -----------------------------------------------------------------------------
// POST /fhir/MedicationDispense
// Primary intake route. The Android BKM app (OpenSRP 2) POSTs a FHIR
// MedicationDispense resource here after each medication transaction.
//
// Identity resolution:
//   performer[0].actor.reference → PERFORMER_MAP → { facilityId, programId }
//   medicationCodeableConcept.coding[0].code → MEDICATION_MAP → orderableId
//   Falls back to OPENLMIS_* env vars when the CSV map has no matching entry.
//
// Receipt detection:
//   type.coding[].code === RECEIPT_TYPE_CODE (default "RECEIPT") → credit event
//   Absent or any other code → debit (dispense) event
// -----------------------------------------------------------------------------
app.post('/fhir/MedicationDispense', async (req, res) => {
  const resource = req.body;
  const t0 = Date.now();
  logger.debug(`MedicationDispense request: subject=${resource.subject?.reference} status=${resource.status} type=${JSON.stringify(resource.type)}`);

  try {
    // Resolve facility + orderable from performer and medication code
    const performer = resource.performer?.[0]?.actor?.reference;
    const medCode = resource.medicationCodeableConcept?.coding?.[0]?.code;
    logger.debug(`Identity lookup: performer=${performer} medCode=${medCode}`);

    const fromMap = PERFORMER_MAP[performer] || PERFORMER_MAP['default'];
    const identity = fromMap || {
      facilityId: process.env.OPENLMIS_FACILITY_ID,
      programId: process.env.OPENLMIS_PROGRAM_ID
    };
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'] || process.env.OPENLMIS_ORDERABLE_ID;
    logger.debug(`Identity resolved (source=${fromMap ? 'CSV map' : 'env vars'}): facility=${identity.facilityId} program=${identity.programId} orderable=${identity.orderableId}`);

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`Incomplete mapping for Performer: ${performer} or Med: ${medCode}`);
    }

    // Detect receipt vs dispense via MedicationDispense.type coding
    // App POSTs type.coding[0].code = RECEIPT_TYPE_CODE (default "RECEIPT") for stock arrivals
    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt = resource.type?.coding?.some(c => c.code === receiptCode) ?? false;
    const dhis2DE = isReceipt ? process.env.DHIS2_DE_STOCK_RECEIVED : undefined;

    logger.info(`MedicationDispense: ${isReceipt ? 'RECEIPT (credit)' : 'DISPENSE (debit)'}, qty=${resource.quantity?.value}`);

    // Pre-flight SOH check (non-fatal — stock card auto-created on first event)
    await ensureStockCard(identity);

    // Fan out to both systems in parallel; use allSettled so a single failure
    // does not cancel the other leg — we report both results independently
    const [lmis, dhis] = await Promise.allSettled([
      pushToOpenLMIS(resource, identity, isReceipt),
      pushToDHIS2(resource, dhis2DE)
    ]);

    // Adjust the poller's baseline so it doesn't double-count this event on
    // the next poll cycle (poller compares SOH to _lastSoH to detect receipts)
    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      const qty = resource.quantity?.value || 0;
      const prev = _lastSoH;
      _lastSoH += isReceipt ? qty : -qty;
      logger.debug(`Poll baseline adjusted: ${prev} → ${_lastSoH} (${isReceipt ? '+' : '-'}${qty})`);
    }

    const allOk = [lmis, dhis].every(r => r.status === 'fulfilled');
    const errDetail = (r) => r.reason?.response?.data ?? r.reason?.message ?? 'unknown error';

    // HTTP 200 when both legs succeed; 207 Multi-Status when one or both fail
    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'Successful' : 'PartialSuccess',
      type: isReceipt ? 'receipt' : 'dispense',
      results: {
        eLMIS: lmis.status === 'fulfilled' ? 'OK' : errDetail(lmis),
        DHIS2: dhis.status === 'fulfilled' ? 'OK' : errDetail(dhis)
      }
    });

    logger.info(`Transaction processed in ${Date.now() - t0}ms (eLMIS=${lmis.status} DHIS2=${dhis.status})`);

  } catch (err) {
    logger.error(`Orchestration Failed: ${err.message}`);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /fhir/QuestionnaireResponse
// Alternative intake route for the OpenSRP 2 form engine. The app can POST a
// FHIR QuestionnaireResponse instead of a MedicationDispense when the stock
// transaction is captured through a structured data-entry form.
//
// Expected answer linkIds:
//   medication  (valueCoding.code) — medication code, e.g. "AL-20-120"
//   quantity    (valueInteger)     — number of units
//   type        (valueCoding.code) — omit for dispense; set to RECEIPT_TYPE_CODE
//                                    (default "RECEIPT") for stock arrivals
//
// A synthetic MedicationDispense is built from the extracted answers so that
// the same identity resolution and fan-out functions can be reused.
// -----------------------------------------------------------------------------
app.post('/fhir/QuestionnaireResponse', async (req, res) => {
  const qr = req.body;
  const t0 = Date.now();
  logger.debug(`QuestionnaireResponse request: id=${qr.id} author=${qr.author?.reference} items=${qr.item?.length}`);

  try {
    // Flatten the QR item array into a linkId → first-answer map for easy lookup
    const answers = {};
    for (const item of (qr.item || [])) {
      const ans = item.answer?.[0];
      if (ans) answers[item.linkId] = ans;
    }

    const medCode  = answers['medication']?.valueCoding?.code || 'AL-20-120';
    const quantity = answers['quantity']?.valueInteger ?? 0;
    const performer = qr.author?.reference || 'Practitioner/opensrp-admin';

    // Detect receipt vs dispense via a QR answer with linkId "type"
    // App form sets type.valueCoding.code = RECEIPT_TYPE_CODE for stock arrivals
    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt = answers['type']?.valueCoding?.code === receiptCode;
    const dhis2DE = isReceipt ? process.env.DHIS2_DE_STOCK_RECEIVED : undefined;

    logger.debug(`QR extracted: medCode=${medCode} quantity=${quantity} performer=${performer} isReceipt=${isReceipt}`);
    logger.info(`QuestionnaireResponse: ${isReceipt ? 'RECEIPT (credit)' : 'DISPENSE (debit)'}, qty=${quantity}`);

    // Build a synthetic MedicationDispense so we can reuse the identity
    // resolution functions (PERFORMER_MAP, MEDICATION_MAP) unchanged
    const resource = {
      id: qr.id || `qr-${Date.now()}`,
      status: 'completed',
      performer: [{ actor: { reference: performer } }],
      medicationCodeableConcept: { coding: [{ code: medCode }] },
      quantity: { value: quantity }
    };

    // Identity resolution — same lookup order as the MedicationDispense route
    const identity = PERFORMER_MAP[performer] || PERFORMER_MAP['default'] || {
      facilityId: process.env.OPENLMIS_FACILITY_ID,
      programId: process.env.OPENLMIS_PROGRAM_ID
    };
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'] || process.env.OPENLMIS_ORDERABLE_ID;

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`No mapping for performer: ${performer} or medication: ${medCode}`);
    }

    await ensureStockCard(identity);

    const [lmis, dhis] = await Promise.allSettled([
      pushToOpenLMIS(resource, identity, isReceipt),
      pushToDHIS2(resource, dhis2DE)
    ]);

    // Keep polling baseline in sync — prevents poller double-counting app-posted events
    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      const prev = _lastSoH;
      _lastSoH += isReceipt ? quantity : -quantity;
      logger.debug(`Poll baseline adjusted: ${prev} → ${_lastSoH} (${isReceipt ? '+' : '-'}${quantity})`);
    }

    const allOk = [lmis, dhis].every(r => r.status === 'fulfilled');
    const errDetail = (r) => r.reason?.response?.data ?? r.reason?.message ?? 'unknown error';
    logger.info(`QR fan-out in ${Date.now() - t0}ms — eLMIS: ${lmis.status}, DHIS2: ${dhis.status}`);

    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'Successful' : 'PartialSuccess',
      type: isReceipt ? 'receipt' : 'dispense',
      results: {
        eLMIS: lmis.status === 'fulfilled' ? 'OK' : errDetail(lmis),
        DHIS2: dhis.status === 'fulfilled' ? 'OK' : errDetail(dhis)
      }
    });
  } catch (err) {
    logger.error(`QR fan-out failed: ${err.message}`);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// =============================================================================
// STARTUP
// =============================================================================

loadMappings();
logger.debug('Startup config: ' + JSON.stringify({
  openhimUrl: CONFIG.openhim.apiURL,
  opensrpUrl: CONFIG.opensrp.url,
  dhis2Url: CONFIG.dhis2.url,
  dhis2DE: CONFIG.dhis2.de,
  dhis2DEReceived: process.env.DHIS2_DE_STOCK_RECEIVED,
  lmisAuthUrl: CONFIG.lmis.authUrl,
  lmisMgmtUrl: CONFIG.lmis.mgmtUrl,
  lmisProgram: CONFIG.lmis.program,
  facilityId: process.env.OPENLMIS_FACILITY_ID,
  orderableId: process.env.OPENLMIS_ORDERABLE_ID,
  pollIntervalMs: POLL_INTERVAL_MS,
  timeoutMs: TIMEOUT_MS,
  receiptTypeCode: process.env.RECEIPT_TYPE_CODE || 'RECEIPT',
  logLevel: process.env.LOG_LEVEL || 'info'
}));

// Register with OpenHIM so it appears in the mediator dashboard and its
// channel configuration is managed centrally.
utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
  if (err) {
    logger.error('Failed to register with OpenHIM');
    process.exit(1);
  }
  app.listen(3000, () => {
    logger.info('Vital-Link Lesotho v1.0.0 Active on port 3000');
    // Wait 10s for downstream services to be ready before the first SOH poll,
    // then poll on the configured interval thereafter.
    setTimeout(pollStockLevels, 10000);
    setInterval(pollStockLevels, POLL_INTERVAL_MS);
  });
});
