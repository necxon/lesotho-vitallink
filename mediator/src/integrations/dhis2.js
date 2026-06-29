/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const axios  = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { getOpenLMISToken } = require('../tokens');

// Lazy-parsed env var maps: orderable ID → DHIS2 data element UID
let _orderableDeMap  = null;
let _orderableSohDeMap = null;
let _performerCocMap = null;

function getOrderableDeMap() {
  if (_orderableDeMap) return _orderableDeMap;
  try { _orderableDeMap = JSON.parse(process.env.DHIS2_ORDERABLE_DE_MAP || '{}'); }
  catch (e) { logger.warn(`DHIS2_ORDERABLE_DE_MAP parse error: ${e.message}`); _orderableDeMap = {}; }
  return _orderableDeMap;
}

function getOrderableSohDeMap() {
  if (_orderableSohDeMap) return _orderableSohDeMap;
  try { _orderableSohDeMap = JSON.parse(process.env.DHIS2_ORDERABLE_SOH_DE_MAP || '{}'); }
  catch (e) { logger.warn(`DHIS2_ORDERABLE_SOH_DE_MAP parse error: ${e.message}`); _orderableSohDeMap = {}; }
  return _orderableSohDeMap;
}

function getPerformerCocMap() {
  if (_performerCocMap) return _performerCocMap;
  try { _performerCocMap = JSON.parse(process.env.DHIS2_PERFORMER_CATEGORY_OPTION_MAP || '{}'); }
  catch (e) { logger.warn(`DHIS2_PERFORMER_CATEGORY_OPTION_MAP parse error: ${e.message}`); _performerCocMap = {}; }
  return _performerCocMap;
}

async function pushToDHIS2(resource, dataElement, identity) {
  const de  = dataElement
    || (identity?.orderableId && getOrderableDeMap()[identity.orderableId])
    || CONFIG.dhis2.de;
  const coc = identity?.performerId && getPerformerCocMap()[identity.performerId];

  const dataValue = {
    dataElement: de,
    orgUnit:     process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
    period:      new Date().toISOString().slice(0, 7).replace('-', ''),
    value:       String(resource.quantity?.value || 0),
    ...(coc && { categoryOptionCombo: coc })
  };

  logger.debug(`DHIS2 dataValueSets POST: de=${de} value=${dataValue.value}`);
  const res = await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, { dataValues: [dataValue] }, {
    auth:    { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass },
    timeout: TIMEOUT_MS
  });
  logger.debug(`DHIS2 dataValueSets response: HTTP ${res.status}`);
  return res;
}

/**
 * After a successful eLMIS stock event, queries the authoritative SOH from
 * OpenLMIS and writes it to DHIS2. Fail-open — errors are logged, never surfaced.
 */
async function pushSohToDHIS2(identity, { triggeredBy, period: periodOverride } = {}) {
  const period    = periodOverride || new Date().toISOString().slice(0, 7).replace('-', '');
  const orgUnit   = process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX';
  const datasetId = (identity?.orderableId && getOrderableSohDeMap()[identity.orderableId])
    || CONFIG.dhis2.deSoh;

  const auditBase = {
    event:           'aggregation-run',
    reportingPeriod: period,
    datasetId,
    facilityId:      identity.facilityId,
    programId:       identity.programId,
    orderableId:     identity.orderableId,
    orgUnit,
    triggeredBy:     triggeredBy || 'unknown'
  };

  try {
    const token = await getOpenLMISToken();
    const res   = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params:  { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    });
    const content = res.data.content || [];
    if (content.length === 0) {
      logger.info({ ...auditBase, outcome: 'skipped', reason: 'no-stock-card' });
      return;
    }
    const soh     = content[0].stockOnHand;
    const dhisRes = await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, {
      dataValues: [{ dataElement: datasetId, orgUnit, period, value: String(soh), comment: triggeredBy || 'unknown' }]
    }, { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass }, timeout: TIMEOUT_MS });

    logger.info({ ...auditBase, outcome: 'success', soh, dhis2Status: dhisRes.status });
  } catch (err) {
    const httpStatus = err.response?.status;
    const body       = err.response?.data;
    const isLocked   = httpStatus === 409 ||
      (typeof body?.message === 'string' && /period.*lock|lock.*period/i.test(body.message));
    logger.warn({ ...auditBase, outcome: isLocked ? 'period-locked' : 'failed', dhis2Status: httpStatus, error: err.message });
  }
}

module.exports = { pushToDHIS2, pushSohToDHIS2, getOrderableDeMap, getOrderableSohDeMap, getPerformerCocMap };
