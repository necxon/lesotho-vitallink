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
 * Integrates OpenSRP 2 (BKM) -> OpenLMIS (eLMIS) -> DHIS2
 */

// ---  SECURE CONFIGURATION  ---
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

// --- LOGGING  ---
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

// ---  DYNAMIC MAPPING and IDENTITY RESOLUTION ---
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

// ---  AUTH and CONCURRENCY LOCKING ---
let _lmisToken = null, _lmisExpires = 0, refreshingLMIS = null;
const TIMEOUT_MS = parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10);

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
      _lmisExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      logger.debug(`OpenLMIS token acquired (expires_in=${res.data.expires_in}s)`);
      return _lmisToken;
    } finally { refreshingLMIS = null; }
  })();
  return refreshingLMIS;
}

// ---  STOCK CARD MANAGEMENT  ---
async function ensureStockCard(identity) {
  // Fire-and-forget: stock cards are auto-created on first stock event.
  // Never throw — a logging check must not block the fan-out.
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

// ---  DOWNSTREAM INTEGRATION METHODS ---
// isReceipt=true → CREDIT (stock arriving); false → DEBIT (stock dispensed)
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

// dataElement defaults to the dispensed DE; pass DHIS2_DE_STOCK_RECEIVED for receipts
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

// ---  STOCK RECEIPT POLLING (OpenLMIS → DHIS2) ---
// Detects SOH increases (receipts entered directly in OpenLMIS) and forwards
// the delta to DHIS2 so the national dashboard stays in sync.
let _lastSoH = null;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);

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

// ---  MAIN ORCHESTRATION ROUTE ---
const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

app.post('/fhir/MedicationDispense', async (req, res) => {
  const resource = req.body;
  const t0 = Date.now();
  logger.debug(`MedicationDispense request: subject=${resource.subject?.reference} status=${resource.status} type=${JSON.stringify(resource.type)}`);

  try {
    //  Resolve Identity
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

    //  Ensure Stock Card
    await ensureStockCard(identity);

    //  Orchestrate Fan-Out (eLMIS and DHIS2)
    const [lmis, dhis] = await Promise.allSettled([
      pushToOpenLMIS(resource, identity, isReceipt),
      pushToDHIS2(resource, dhis2DE)
    ]);

    // Keep polling baseline in sync — prevents poller double-counting app-posted events
    if (lmis.status === 'fulfilled' && _lastSoH !== null) {
      const qty = resource.quantity?.value || 0;
      const prev = _lastSoH;
      _lastSoH += isReceipt ? qty : -qty;
      logger.debug(`Poll baseline adjusted: ${prev} → ${_lastSoH} (${isReceipt ? '+' : '-'}${qty})`);
    }

    const allOk = [lmis, dhis].every(r => r.status === 'fulfilled');
    const errDetail = (r) => r.reason?.response?.data ?? r.reason?.message ?? 'unknown error';

    //  Return Detailed Multi-Status
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

// ---  QUESTIONNAIRERESPONSE ROUTE (Stock Management form → fan-out) ---
app.post('/fhir/QuestionnaireResponse', async (req, res) => {
  const qr = req.body;
  const t0 = Date.now();
  logger.debug(`QuestionnaireResponse request: id=${qr.id} author=${qr.author?.reference} items=${qr.item?.length}`);

  try {
    // Extract answers by linkId
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

    // Build synthetic MedicationDispense for identity resolution
    const resource = {
      id: qr.id || `qr-${Date.now()}`,
      status: 'completed',
      performer: [{ actor: { reference: performer } }],
      medicationCodeableConcept: { coding: [{ code: medCode }] },
      quantity: { value: quantity }
    };

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

// ---  STARTUP ---
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
utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
  if (err) {
    logger.error('Failed to register with OpenHIM');
    process.exit(1);
  }
  app.listen(3000, () => {
    logger.info('Vital-Link Lesotho v1.0.0 Active on port 3000');
    // Establish SOH baseline after services are ready, then poll on interval
    setTimeout(pollStockLevels, 10000);
    setInterval(pollStockLevels, POLL_INTERVAL_MS);
  });
});