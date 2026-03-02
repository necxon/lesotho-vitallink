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
//let _kcToken = null, _kcExpires = 0, refreshingKC = null;

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

// ---  STOCK CARD MANAGEMENT  ---
async function ensureStockCard(identity) {
  const token = await getOpenLMISToken();
  
  // Stock cards are auto-created on first stock event — just check existence for logging.
  // /api/stockCards returns 500; use stockCardSummaries (facility/program/orderable params).
  const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
    params: { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.data.content && res.data.content.length === 0) {
    logger.info(`Stock card not yet provisioned for facility ${identity.facilityId} — first stock event will create it.`);
  }
}

// ---  DOWNSTREAM INTEGRATION METHODS ---
async function pushToOpenLMIS(resource, identity) {
  const token = await getOpenLMISToken();
  const quantity = resource.quantity?.value || 0;
  
  // OpenLMIS stockEvents requires a reason UUID (seeded by stockmanagement Flyway — "Consumed"/DEBIT)
  const reasonId = process.env.OPENLMIS_REASON_ID || 'b5c27da7-bdda-4790-925a-9484c5dfb594';

  return axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, {
    facilityId: identity.facilityId,
    programId: identity.programId,
    lineItems: [{
      orderableId: identity.orderableId,
      quantity: quantity,
      occurredDate: new Date().toISOString().split('T')[0],
      reasonId: reasonId,
      documentationNo: `BKM-${resource.id || Date.now()}`
    }]
  }, { headers: { Authorization: `Bearer ${token}` } });
}

async function pushToDHIS2(resource) {
  const payload = {
    dataValues: [{
      dataElement: CONFIG.dhis2.de,
      orgUnit: process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
      period: new Date().toISOString().slice(0, 7).replace('-', ''), 
      value: String(resource.quantity?.value || 0)
    }]
  };
  return axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, payload, { 
    auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass } 
  });
}

// ---  MAIN ORCHESTRATION ROUTE ---
const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

app.post('/fhir/MedicationDispense', async (req, res) => {
  const resource = req.body;
  const t0 = Date.now();

  try {
    //  Resolve Identity
    const performer = resource.performer?.[0]?.actor?.reference;
    const medCode = resource.medicationCodeableConcept?.coding?.[0]?.code;
    
    const identity = PERFORMER_MAP[performer] || PERFORMER_MAP['default'];
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'];

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`Incomplete mapping for Performer: ${performer} or Med: ${medCode}`);
    }

    //  Ensure Stock Card 
    await ensureStockCard(identity);

    //  Orchestrate Fan-Out (eLMIS and  DHIS2)
    const [lmis, dhis] = await Promise.allSettled([
      pushToOpenLMIS(resource, identity),
      pushToDHIS2(resource)
    ]);

    const allOk = [lmis, dhis].every(r => r.status === 'fulfilled');

    //  Return Detailed Multi-Status
    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'Successful' : 'PartialSuccess',
      results: {
        eLMIS: lmis.status === 'fulfilled' ? 'OK' : lmis.reason?.message,
        DHIS2: dhis.status === 'fulfilled' ? 'OK' : dhis.reason?.message
      }
    });

    logger.info(`Transaction processed in ${Date.now() - t0}ms`);

  } catch (err) {
    logger.error(`Orchestration Failed: ${err.message}`);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// ---  QUESTIONNAIRERESPONSE ROUTE (Stock Management form → fan-out) ---
app.post('/fhir/QuestionnaireResponse', async (req, res) => {
  const qr = req.body;
  const t0 = Date.now();

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

    // Build synthetic MedicationDispense for identity resolution
    const resource = {
      id: qr.id || `qr-${Date.now()}`,
      status: 'completed',
      performer: [{ actor: { reference: performer } }],
      medicationCodeableConcept: { coding: [{ code: medCode }] },
      quantity: { value: quantity }
    };

    const identity = { ...(PERFORMER_MAP[performer] || PERFORMER_MAP['default']) };
    identity.orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'];

    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`No mapping for performer: ${performer} or medication: ${medCode}`);
    }

    await ensureStockCard(identity);

    const [lmis, dhis] = await Promise.allSettled([
      pushToOpenLMIS(resource, identity),
      pushToDHIS2(resource)
    ]);

    const allOk = [lmis, dhis].every(r => r.status === 'fulfilled');
    logger.info(`QR fan-out in ${Date.now() - t0}ms — eLMIS: ${lmis.status}, DHIS2: ${dhis.status}`);

    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'Successful' : 'PartialSuccess',
      results: {
        eLMIS: lmis.status === 'fulfilled' ? 'OK' : lmis.reason?.message,
        DHIS2: dhis.status === 'fulfilled' ? 'OK' : dhis.reason?.message
      }
    });
  } catch (err) {
    logger.error(`QR fan-out failed: ${err.message}`);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// ---  STARTUP ---
loadMappings();
utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
  if (err) {
    logger.error('Failed to register with OpenHIM');
    process.exit(1);
  }
  app.listen(3000, () => logger.info('Vital-Link Lesotho v1.0.0 Active on port 3000'));
});