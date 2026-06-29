/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router } = require('express');
const logger = require('../logger');
const reply = require('../reply');
const { runFacilityAggregation } = require('../orders/aggregation');
const { dispatchOrders, dispatchOrderByMedicine, getBufferSnapshot, loadDispatchLog, clearDispatchLog, cancelOrdersByOU, cancelAllOrders, cancelOrderByMedicine } = require('../orders/orderBuffer');
const { setFrequency, getFrequency, nextDispatchTime, FREQ_MAP } = require('../orders/scheduleState');
const { createStockTask, completeStockTask } = require('../tasks/tasks');
const { pool } = require('../db');

const router = Router();

// POST /aggregate — manually trigger facility aggregation
// Body (optional): { period: "YYYYMM" }
router.post('/', async (req, res) => {
  const period = req.body?.period || new Date().toISOString().slice(0, 7).replace('-', '');
  logger.info(`Manual aggregation triggered: period=${period}`);
  try {
    const result = await runFacilityAggregation(period);
    reply(res, { status: 'ok', ...result });
  } catch (err) {
    logger.error(`Aggregation endpoint error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// POST /orders — manually trigger order batch dispatch
// Body (optional): { force: true } — bypass the already-dispatched-this-period guard
router.post('/orders', async (req, res) => {
  const force = req.body?.force === true || req.query.force === 'true';
  logger.info(`Manual order dispatch triggered${force ? ' (force)' : ''}`);
  try {
    const result = await dispatchOrders({ force });
    reply(res, { status: 'ok', ...result });
  } catch (err) {
    logger.error(`Order dispatch endpoint error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// DELETE /orders/dispatch-log — clear the dispatch log so the current period can be re-dispatched
router.delete('/orders/dispatch-log', async (req, res) => {
  await clearDispatchLog();
  reply(res, { status: 'ok', message: 'Dispatch log cleared' });
});

// DELETE /orders — zero out ALL buffer entries for the current period
router.delete('/orders', async (req, res) => {
  try {
    const cancelled = await cancelAllOrders();
    reply(res, { status: 'ok', cancelled });
  } catch (err) {
    logger.error(`Cancel all orders error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// POST /orders/ou/:ou/medicine/:orderable — dispatch a single medicine line for one org unit
router.post('/orders/ou/:ou/medicine/:orderable', async (req, res) => {
  const { ou, orderable } = req.params;
  try {
    const result = await dispatchOrderByMedicine(ou, orderable);
    reply(res, { status: 'ok', ...result });
  } catch (err) {
    logger.error(`Single dispatch error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// DELETE /orders/ou/:ou/medicine/:orderable — zero one medicine line for one org unit
router.delete('/orders/ou/:ou/medicine/:orderable', async (req, res) => {
  const { ou, orderable } = req.params;
  try {
    const cancelled = await cancelOrderByMedicine(ou, orderable);
    reply(res, { status: 'ok', ou, orderable, cancelled });
  } catch (err) {
    logger.error(`Cancel order by medicine error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// DELETE /orders/ou/:ou — zero out all buffer entries for one org unit in the current period
router.delete('/orders/ou/:ou', async (req, res) => {
  const { ou } = req.params;
  if (!ou) return reply(res, { status: 'error', message: 'ou is required' }, 400);
  try {
    const cancelled = await cancelOrdersByOU(ou);
    reply(res, { status: 'ok', ou, cancelled });
  } catch (err) {
    logger.error(`Cancel orders by OU error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// GET /orders — inspect current period order totals from DHIS2
router.get('/orders', async (req, res) => {
  try {
    const buffer = await getBufferSnapshot();
    reply(res, { status: 'ok', buffer });
  } catch (err) {
    logger.error(`Order snapshot error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// GET /status — combined status: buffer snapshot + dispatch history + next run time
router.get('/status', async (req, res) => {
  try {
    const period    = new Date().toISOString().slice(0, 7).replace('-', '');
    const log       = await loadDispatchLog();
    const buffer    = await getBufferSnapshot();
    // Buffer rows can carry the alias form of the originating practitioner
    // (e.g. "Practitioner/opensrp-admin") because that's what the BKM app sent.
    // Resolve each origin to its canonical id so the "Ordered by" lookup on
    // the Orders page finds the human-readable name.
    {
      const { PERFORMER_MAP } = require('../mappings/mappings');
      for (const entry of Object.values(buffer)) {
        const origins = entry.byOrigin || {};
        for (const [ou, origin] of Object.entries(origins)) {
          const m = PERFORMER_MAP[origin];
          if (m && m._canonical && m._canonical !== origin) origins[ou] = m._canonical;
        }
      }
    }
    const frequency = getFrequency();
    const schedule  = FREQ_MAP[frequency];
    const next      = nextDispatchTime(frequency);

    // Performer map: org unit → { practitionerId, name, phone, email, facilityId }
    // Skip alias entries (m._canonical points at another key) so the same person
    // isn't listed multiple times in the "VHW: …" header on the Orders page.
    const { PERFORMER_MAP } = require('../mappings/mappings');
    const byOrgUnit = {};
    for (const [practId, m] of Object.entries(PERFORMER_MAP)) {
      const ou = m.dhis2OrgUnit;
      if (!ou) continue;
      if (m._canonical && m._canonical !== practId) continue; // skip alias key
      if (!byOrgUnit[ou]) byOrgUnit[ou] = [];
      byOrgUnit[ou].push({ practitionerId: practId, name: m.name || null, role: m.role || null, facilityId: m.facilityId, phone: m.phone, email: m.email });
    }

    reply(res, {
      status:         'ok',
      period,
      frequency,
      schedule,
      nextDispatch:   next ? next.toISOString() : null,
      dispatchLog:    log,
      lastDispatched: log[period] || null,
      buffer,
      performersByOU: byOrgUnit,
    });
  } catch (err) {
    logger.error(`Status endpoint error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// PUT /schedule — change dispatch frequency (daily / weekly / monthly)
router.put('/schedule', (req, res) => {
  const { frequency } = req.body || {};
  try {
    const schedule = setFrequency(frequency);
    logger.info(`Order batch schedule changed to frequency="${frequency}" expr="${schedule}"`);
    reply(res, { status: 'ok', frequency, schedule });
  } catch (err) {
    reply(res, { status: 'error', message: err.message }, 400);
  }
});

// POST /tasks — create stock-issue Tasks on HAPI FHIR for one or more VHWs.
// Body: { practitioners: ["Practitioner/id", ...], entries: [{medication, quantity, orderableId?}], issueRef? }
// The Android app picks Tasks up on the next FHIR sync (status=requested, code=373748001).
router.post('/tasks', async (req, res) => {
  const { practitioners = [], entries = [], issueRef } = req.body || {};
  if (!practitioners.length || !entries.length) {
    return reply(res, { status: 'error', message: 'practitioners (array) and entries (array) are required' }, 400);
  }
  const ref   = issueRef || `ORD-${new Date().toISOString().slice(0, 7).replace('-', '')}-${Date.now()}`;
  const tasks = [];
  const errs  = [];
  for (const practitioner of practitioners) {
    for (const entry of entries) {
      try {
        const task = await createStockTask({
          performer:  practitioner,
          medication: entry.medication,
          quantity:   Number(entry.quantity),
          issueRef:   ref,
        });
        tasks.push(task.id);
        logger.info(`Stock Task created for ${practitioner}: ${entry.medication} x${entry.quantity}`);
      } catch (err) {
        logger.error(`Task creation failed for ${practitioner}: ${err.message}`);
        errs.push({ practitioner, medication: entry.medication, error: err.message });
      }
    }
  }
  reply(res, { status: 'ok', created: tasks, errors: errs });
});

// DELETE /dispatch-history — delete all dispatch history records
router.delete('/dispatch-history', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM dispatch_history');
    reply(res, { status: 'ok', deleted: result.rowCount });
  } catch (err) {
    logger.error(`Delete all dispatch history error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// DELETE /dispatch-history/:id — delete one dispatch history record by id
router.delete('/dispatch-history/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM dispatch_history WHERE id = $1', [req.params.id]);
    reply(res, { status: 'ok', deleted: result.rowCount });
  } catch (err) {
    logger.error(`Delete dispatch history record error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// GET /dispatch-history — full audit log of what was sent to OpenLMIS
// Query params: period=YYYYMM (optional filter), limit=N (default 100)
router.get('/dispatch-history', async (req, res) => {
  try {
    const { period, limit = 100 } = req.query;
    const params = [];
    let where = '';
    if (period) { params.push(period); where = `WHERE period = $1`; }
    params.push(parseInt(limit, 10));
    const result = await pool.query(
      `SELECT id, dispatched_at, period, orderable_id, org_unit, qty, lmis_status, forced, performer_ids
       FROM dispatch_history ${where}
       ORDER BY dispatched_at DESC
       LIMIT $${params.length}`,
      params
    );
    reply(res, { status: 'ok', rows: result.rows });
  } catch (err) {
    logger.error(`Dispatch history error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// GET /performers — per-practitioner details: village, region, facility, phone
router.get('/performers', (req, res) => {
  const { PERFORMER_MAP, OU_LABELS } = require('../mappings/mappings');
  const result = {};
  for (const [practId, m] of Object.entries(PERFORMER_MAP)) {
    if (practId === 'default') continue;
    const ou     = m.dhis2OrgUnit;
    const labels = ou ? (OU_LABELS[ou] || {}) : {};
    result[practId] = {
      practitionerId: practId,
      facilityId:     m.facilityId   || null,
      facilityName:   m.facilityName || labels.facility || null,
      dhis2OrgUnit:   ou             || null,
      village:        labels.village || null,
      region:         labels.region  || null,
      phone:          m.phone        || null,
      email:          m.email        || null,
      name:           m.name         || null,
      role:           m.role         || 'vhw',
    };
  }
  reply(res, result);
});

// POST /tasks/:id/complete — mark a stock-issue Task as completed
router.post('/tasks/:id/complete', async (req, res) => {
  try {
    await completeStockTask(req.params.id);
    reply(res, { status: 'ok', taskId: req.params.id });
  } catch (err) {
    logger.error(`Task complete endpoint error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

// GET /aggregate/org-units — live DHIS2 organisation units [{id,name,level}].
// Lets the portal resolve a location to its real DHIS2 UID by name (data-driven,
// so new villages added in DHIS2 appear without a code change). Cached 5 min.
let _ouCache = { at: 0, units: null };
router.get('/org-units', async (_req, res) => {
  const axios      = require('axios');
  const { CONFIG } = require('../config/config');
  const TTL_MS = 5 * 60 * 1000;
  if (_ouCache.units && Date.now() - _ouCache.at < TTL_MS) {
    return reply(res, { status: 'ok', cached: true, count: _ouCache.units.length, orgUnits: _ouCache.units });
  }
  try {
    const r = await axios.get(
      `${CONFIG.dhis2.url}/api/organisationUnits.json?fields=id,name,level&paging=false`,
      { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass }, timeout: 10000 }
    );
    const units = (r.data.organisationUnits || []).map(u => ({ id: u.id, name: u.name, level: u.level }));
    _ouCache = { at: Date.now(), units };
    reply(res, { status: 'ok', cached: false, count: units.length, orgUnits: units });
  } catch (err) {
    logger.warn(`org-units fetch failed: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 502);
  }
});

module.exports = router;
