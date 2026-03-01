'use strict';

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const csv     = require('csv-parser');
const utils   = require('openhim-mediator-utils');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

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
    clientId: requiredEnv('OPENSRP_CLIENT_ID'),
    clientSecret: requiredEnv('OPENSRP_CLIENT_SECRET')
  },
  keycloak: {
    url: requiredEnv('KEYCLOAK_URL'),
  },
  dhis2: {
    url:  requiredEnv('DHIS2_URL'),
    user: requiredEnv('DHIS2_USER'),
    pass: requiredEnv('DHIS2_PASS'),
    de:   process.env.DHIS2_DE_STOCK_DISPENSED || 'ujPSJuS9pph',
    ou:   process.env.DHIS2_ORG_UNIT           || 'dwx1Yz4BwNX'
  },
  lmis: {
    authUrl: requiredEnv('OPENLMIS_AUTH_URL'),
    mgmtUrl: requiredEnv('OPENLMIS_MGMT_URL'),
    user:    requiredEnv('OPENLMIS_USER'),
    pass:    requiredEnv('OPENLMIS_PASS'),
    client:  requiredEnv('OPENLMIS_CLIENT_ID'),
    secret:  requiredEnv('OPENLMIS_CLIENT_SECRET'),
    reason:  process.env.OPENLMIS_REASON_ID || 'd159376d-a95f-4a26-9af9-0541e444a927'
  }
};

const mediatorConfig = {
  urn: 'urn:mediator:bkm-stock-mediator',
  version: '1.2.0',
  name: 'BKM Stock Mediator',
  description: 'Orchestrator for BKM Stock Management',
  endpoints: [{ name: 'BKM Mediator', host: 'bkm-mediator', port: 3000, path: '/fhir/MedicationDispense', primary: true, type: 'http' }]
};

// LOGGER (30 Day Rotation) ---
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/vital-link-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d'
    })
  ],
});

//  DYNAMIC MAPPING and  IDENTITY RESOLUTION ---
let PERFORMER_MAP = {};
let MEDICATION_MAP = {};

function loadMappings() {
  if (!fs.existsSync('mappings.csv')) {
    logger.error('CRITICAL: mappings.csv not found.');
    return;
  }
  fs.createReadStream('mappings.csv')
    .pipe(csv())
    .on('data', (row) => {
      if (row.type === 'performer' && row.source_id) {
        PERFORMER_MAP[row.source_id.trim()] = { 
          facilityId: row.target_facility_id.trim(), 
          programId: row.target_program_id.trim() 
        };
      } else if (row.type === 'medication' && row.source_id) {
        MEDICATION_MAP[row.source_id.trim()] = row.target_orderable_id.trim();
      }
    })
    .on('end', () => logger.info('Validated CSV Mappings Loaded.'));
}

function resolveIdentity(resource) {
  const performerRef = resource.performer?.[0]?.actor?.reference;
  const medCode = resource.medicationCodeableConcept?.coding?.[0]?.code ?? 
                  resource.medicationCodeableConcept?.coding?.[0]?.display ?? 
                  resource.medicationCodeableConcept?.text;

  const identity = PERFORMER_MAP[performerRef] || PERFORMER_MAP['default'];
  if (!identity) throw new Error(`Mapping failed: No facility for performer ${performerRef}`);

  const orderableId = MEDICATION_MAP[medCode] || MEDICATION_MAP['default'];
  if (!orderableId) throw new Error(`Mapping failed: No orderable for medication ${medCode}`);

  return { ...identity, orderableId };
}

// ---  CONCURRENCY SAFE AUTH ---
let _lmisToken = null, _lmisExpires = 0, refreshingLMIS = null;
let _kcToken = null, _kcExpires = 0, refreshingKC = null;

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

async function getKeycloakToken() {
  if (_kcToken && Date.now() < _kcExpires) return _kcToken;
  if (refreshingKC) return refreshingKC;

  refreshingKC = (async () => {
    try {
      const res = await axios.post(`${CONFIG.keycloak.url}/realms/opensrp/protocol/openid-connect/token`,
        `grant_type=password&client_id=${CONFIG.opensrp.clientId}&client_secret=${CONFIG.opensrp.clientSecret}&username=opensrp-admin&password=admin`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      _kcToken = res.data.access_token;
      _kcExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _kcToken;
    } finally { refreshingKC = null; }
  })();
  return refreshingKC;
}

// --- DOWNSTREAM INTEGRATIONS ---

async function forwardToOpenSRP(resource) {
  const token = await getKeycloakToken();
  const event = {
    events: [{
      baseEntityId: resource.subject?.reference?.split('/')[1] || 'unknown',
      eventType: 'MedicationDispense',
      eventDate: (resource.whenHandedOver || new Date().toISOString()).split('T')[0],
      obs: [{ fieldCode: 'quantity', values: [String(resource.quantity?.value || 0)] }]
    }]
  };
  return axios.post(`${CONFIG.opensrp.url}/opensrp/rest/event/add`, event, { headers: { Authorization: `Bearer ${token}` } });
}

async function pushToDHIS2(resource) {
  const payload = {
    dataValues: [{
      dataElement: CONFIG.dhis2.de,
      orgUnit: CONFIG.dhis2.ou,
      period: new Date().toISOString().slice(0, 7).replace('-', ''), 
      value: String(resource.quantity?.value || 0)
    }]
  };
  return axios.post(`${CONFIG.dhis2.url}/dataValueSets`, payload, { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass } });
}

async function pushToOpenLMIS(resource, identity) {
  const token = await getOpenLMISToken();
  return axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, {
    facilityId: identity.facilityId,
    programId: identity.programId,
    lineItems: [{
      orderableId: identity.orderableId,
      quantity: resource.quantity.value,
      occurredDate: (resource.whenHandedOver || new Date().toISOString()).split('T')[0],
      reasonId: CONFIG.lmis.reason,
      documentationNo: `VITAL-${Date.now()}`
    }]
  }, { headers: { Authorization: `Bearer ${token}` } });
}

// --- MAIN ROUTE ---
const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

app.post('/fhir/MedicationDispense', async (req, res) => {
  const resource = req.body;
  const t0 = Date.now();
  
  try {
    const quantity = resource.quantity?.value || 0;
    if (quantity <= 0) return res.status(422).json({ status: 'Rejected', reason: 'invalid-quantity' });

    const identity = resolveIdentity(resource);

    const [opensrp, dhis2, openlmis] = await Promise.allSettled([
      forwardToOpenSRP(resource),
      pushToDHIS2(resource),
      pushToOpenLMIS(resource, identity)
    ]);

    const allOk = [opensrp, dhis2, openlmis].every(r => r.status === 'fulfilled');
    
    logger.info({ 
      msg: 'Fan-out complete', 
      opensrp: opensrp.status, 
      dhis2: dhis2.status, 
      openlmis: openlmis.status,
      duration: Date.now() - t0 
    });

    res.status(allOk ? 200 : 207).json({
      status: allOk ? 'Successful' : 'PartialSuccess',
      results: {
        openSRP:  opensrp.status === 'fulfilled' ? 'OK' : opensrp.reason?.message,
        dhis2:    dhis2.status   === 'fulfilled' ? 'OK' : dhis2.reason?.message,
        openLMIS: openlmis.status === 'fulfilled' ? 'OK' : openlmis.reason?.message,
      }
    });

  } catch (err) {
    logger.error({ msg: 'Mediator Error', error: err.message });
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// - BOOT  Me---
loadMappings();
utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
  if (!err) app.listen(3000, () => logger.info('Vital-Link 1.2.0 Plugin Active.'));
});