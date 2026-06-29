/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const axios  = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { getOpenLMISToken } = require('../tokens');
const { getOrderableDeMap } = require('../integrations/dhis2');
const { PERFORMER_MAP, MEDICATION_MAP, LMIS_ORDERABLE_MAP } = require('../mappings/mappings');



/**
 * Queries DHIS2 analytics for dispensed totals per org unit for the given
 * period, then posts one consolidated DEBIT stock event per facility to OpenLMIS.
 */
async function runFacilityAggregation(period) {
  let facilityMap = {};
  try {
    const raw = process.env.DHIS2_FACILITY_MAP;
    if (raw) facilityMap = JSON.parse(raw);
  } catch (e) {
    logger.warn(`DHIS2_FACILITY_MAP parse error: ${e.message} — using default`);
  }
  if (Object.keys(facilityMap).length === 0) {
    const defaultOu  = process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX';
    const defaultFac = process.env.OPENLMIS_FACILITY_ID;
    if (defaultOu && defaultFac) facilityMap[defaultOu] = defaultFac;
  }

  const orderableDeMap = getOrderableDeMap();
  const deOrderableMap = Object.fromEntries(
    Object.entries(orderableDeMap).map(([oid, de]) => [de, oid])
  );
  let lotMap = {};
  try { lotMap = JSON.parse(process.env.OPENLMIS_LOT_MAP || '{}'); } catch (e) {/* ignore */}

  const allDes    = Object.values(orderableDeMap);
  const deList    = allDes.length > 0 ? allDes : [CONFIG.dhis2.de];
  const ouList    = Object.keys(facilityMap);
  const programId = CONFIG.lmis.program;
  const reasonId  = process.env.OPENLMIS_REASON_ID || 'b5c27da7-bdda-4790-925a-9484c5dfb594';
  const occurredDate = new Date().toISOString().slice(0, 10);

  logger.info({
    event: 'aggregation-start', period,
    orgUnits: ouList.length, medicines: deList.length,
    facilityMap, dataElements: deList,
  });

  let rows = [];
  try {
    const analyticsRes = await axios.get(`${CONFIG.dhis2.url}/api/analytics`, {
      auth:    { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass },
      params:  {
        dimension: [`dx:${deList.join(';')}`, `ou:${ouList.join(';')}`],
        filter:    `pe:${period}`,
        skipMeta:  true
      },
      timeout: TIMEOUT_MS
    });
    rows = analyticsRes.data.rows || [];
    logger.info({ event: 'aggregation-dhis2-raw', period, rowCount: rows.length, rows });
  } catch (err) {
    logger.error({
      event:  'aggregation-dhis2-error', period, error: err.message,
      status: err.response?.status, body: err.response?.data,
    });
    throw err;
  }

  if (rows.length === 0) {
    logger.info({ event: 'aggregation-dhis2-ok', period, rowCount: 0, outcome: 'no-data' });
    return { period, facilities: 0, results: [], message: 'No DHIS2 data for period' };
  }
  logger.info({ event: 'aggregation-dhis2-ok', period, rowCount: rows.length });

  const byOu = {};
  for (const [deId, ouId, value] of rows) {
    const qty = Math.round(parseFloat(value) || 0);
    if (qty <= 0) {
      logger.info({ event: 'aggregation-row-skip', period, ouId, deId, value, reason: 'qty-zero-or-negative' });
      continue;
    }
    if (!byOu[ouId]) byOu[ouId] = [];
    byOu[ouId].push({ deId, qty });
  }
  logger.info({ event: 'aggregation-grouped', period, orgUnitsWithData: Object.keys(byOu).length, byOu });

  const lmisToken = await getOpenLMISToken();
  const results   = [];

  for (const [ouId, medicines] of Object.entries(byOu)) {
    const facilityId = facilityMap[ouId];
    if (!facilityId) {
      logger.warn({ event: 'aggregation-skip', period, ouId, reason: 'no-facility-mapping', knownMappings: facilityMap });
      continue;
    }

    const lineItems = [];
    for (const { deId, qty } of medicines) {
      const orderableId = deOrderableMap[deId] || process.env.OPENLMIS_ORDERABLE_ID;
      if (!orderableId) {
        logger.warn({ event: 'aggregation-de-unresolved', period, ouId, deId, qty, reason: 'no-orderable-mapping', deOrderableMap });
        continue;
      }
      const lineItem = { orderableId, quantity: qty, occurredDate, reasonId, documentationNo: `AGG-${period}-${ouId}-${deId}` };
      const lotId = lotMap[orderableId] || process.env.OPENLMIS_LOT_ID;
      if (lotId) lineItem.lotId = lotId;
      lineItems.push(lineItem);
    }

    logger.info({ event: 'aggregation-lineitems', period, ouId, facilityId, lineItems });

    if (lineItems.length === 0) {
      logger.warn({ event: 'aggregation-skip', period, ouId, facilityId, reason: 'all-items-unresolved' });
      continue;
    }

    try {
      const payload = { facilityId, programId, lineItems };
      const res     = await axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, payload,
        { headers: { Authorization: `Bearer ${lmisToken}` }, timeout: TIMEOUT_MS });
      const summary = lineItems.map(l => `${l.orderableId.slice(-4)}×${l.quantity}`).join(' ');
      results.push({ ouId, facilityId, medicines: lineItems.length, lmisStatus: res.status });
      logger.info({
        event: 'aggregation-posted', period, ouId, facilityId,
        medicines: lineItems.length, summary, lmisStatus: res.status,
        lmisResponse: res.data,
      });
    } catch (err) {
      const httpStatus  = err.response?.status;
      const lmisErrBody = err.response?.data;
      results.push({ ouId, facilityId, medicines: lineItems.length, error: err.message, lmisStatus: httpStatus });
      logger.error({
        event: 'aggregation-lmis-error', period, ouId, facilityId,
        error: err.message, lmisStatus: httpStatus, lmisResponse: lmisErrBody,
      });
    }
  }

  logger.info({
    event:   'aggregation-complete', period,
    posted:  results.filter(r => !r.error).length,
    errors:  results.filter(r =>  r.error).length,
    results,
  });
  return { period, facilities: results.length, results };
}

/**
 * Runs at 00:05 on the 1st of each month. Writes a period-end SOH snapshot
 * to DHIS2 for every (facilityId, programId, orderableId) in the CSV mappings.
 */
async function runPeriodEndSnapshot() {
  const now       = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period    = prevMonth.toISOString().slice(0, 7).replace('-', '');

  const seen   = new Set();
  const combos = [];
  for (const perf of Object.values(PERFORMER_MAP)) {
    const orderableIds = Object.keys(LMIS_ORDERABLE_MAP).length
      ? [...new Set(Object.values(LMIS_ORDERABLE_MAP))]
      : [...new Set(Object.values(MEDICATION_MAP))];
    for (const orderableId of orderableIds) {
      const key = `${perf.facilityId}|${perf.programId}|${orderableId}`;
      if (!seen.has(key)) {
        seen.add(key);
        combos.push({ facilityId: perf.facilityId, programId: perf.programId, orderableId });
      }
    }
  }

  if (combos.length === 0) {
    logger.warn({ event: 'period-end-snapshot', period, outcome: 'skipped', reason: 'no-mappings' });
    return;
  }

  // DHIS2 SOH sync is now handled by the dhis2-integration service on its own schedule.
  logger.info({ event: 'period-end-snapshot', period, combos: combos.length, outcome: 'skipped', reason: 'delegated-to-dhis2-integration' });
}

function schedulePeriodEndSnapshot() {
  const now     = new Date();
  const nextRun = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 5, 0);
  const msUntil = nextRun - now;
  // Node.js setTimeout clamps values > 2^31-1 ms (~24.8 days) to 1ms, causing an infinite loop.
  // If the next run is more than 24 days away, schedule an intermediate wakeup.
  const MAX_TIMEOUT = 2 ** 31 - 1;
  if (msUntil > MAX_TIMEOUT) {
    setTimeout(schedulePeriodEndSnapshot, MAX_TIMEOUT);
    return;
  }
  logger.info(`Period-end snapshot scheduled for ${nextRun.toISOString()} (in ${Math.round(msUntil / 3600000)}h)`);
  setTimeout(async () => {
    try { await runPeriodEndSnapshot(); } catch (err) { logger.error(`Period-end snapshot error: ${err.message}`); }
    schedulePeriodEndSnapshot();
  }, msUntil);
}

module.exports = { runFacilityAggregation, runPeriodEndSnapshot, schedulePeriodEndSnapshot };
