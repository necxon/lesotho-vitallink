/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

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
    username:        requiredEnv('OPENHIM_USER'),
    password:        requiredEnv('OPENHIM_PASS'),
    apiURL:          process.env.OPENHIM_URL || 'https://openhim-core:8080',
    trustSelfSigned: process.env.NODE_ENV !== 'production'
  },
  opensrp: {
    url:          requiredEnv('OPENSRP_URL'),
    clientId:     process.env.OPENSRP_CLIENT_ID     || '',
    clientSecret: process.env.OPENSRP_CLIENT_SECRET || ''
  },
  keycloak: {
    url: requiredEnv('KEYCLOAK_URL')
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
    refUrl:  process.env.OPENLMIS_REF_URL  || 'http://openlmis-referencedata:8080',
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

const TIMEOUT_MS = parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10);

const mediatorConfig = {
  urn:         'urn:mediator:lesotho-vital-link',
  version:     '1.1.0',
  name:        'Vital-Link Lesotho Mediator',
  description: 'Hardened Medication Inventory Lifecycle Plugin',
  endpoints: [
    { name: 'Vital-Link Endpoint',              host: 'bkm-mediator', port: 3000, path: '/fhir/MedicationDispense',    primary: true,  type: 'http' },
    { name: 'Vital-Link SupplyDelivery',        host: 'bkm-mediator', port: 3000, path: '/fhir/SupplyDelivery',        primary: false, type: 'http' },
    { name: 'Vital-Link QuestionnaireResponse', host: 'bkm-mediator', port: 3000, path: '/fhir/QuestionnaireResponse', primary: false, type: 'http' }
  ],
  defaultChannelConfig: [
    {
      name: 'BKM MedicationDispense',
      urlPattern: '^/fhir/MedicationDispense$',
      methods: ['POST'], type: 'http', status: 'enabled', allow: [], authType: 'public',
      routes: [{ name: 'Vital-Link Endpoint', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }]
    },
    {
      name: 'BKM SupplyDelivery',
      urlPattern: '^/fhir/SupplyDelivery$',
      methods: ['POST'], type: 'http', status: 'enabled', allow: [], authType: 'public',
      routes: [{ name: 'Vital-Link SupplyDelivery', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }]
    },
    {
      name: 'BKM QuestionnaireResponse',
      urlPattern: '^/fhir/QuestionnaireResponse$',
      methods: ['POST'], type: 'http', status: 'enabled', allow: [], authType: 'public',
      routes: [{ name: 'Vital-Link QuestionnaireResponse', host: 'bkm-mediator', port: 3000, primary: true, type: 'http' }]
    }
  ],
  // Mapping config managed via OpenHIM console (Mediators → Vital-Link → Config).
  // If left empty the mediator falls back to mappings.json.
  configDefs: [
    {
      param:        'performerMappings',
      displayName:  'Performer Mappings',
      description:  'JSON array of performer → facility mappings. Format: [{sourceId, facilityId, programId, phone, email}]. Leave empty to use mappings.json.',
      type:         'string',
      defaultValue: ''
    },
    {
      param:        'medicationMappings',
      displayName:  'Medication Mappings',
      description:  'JSON array of medication code → orderable mappings. Format: [{sourceId, orderableId}]. Leave empty to use mappings.json.',
      type:         'string',
      defaultValue: ''
    }
  ]
};

module.exports = { CONFIG, TIMEOUT_MS, mediatorConfig, requiredEnv };
