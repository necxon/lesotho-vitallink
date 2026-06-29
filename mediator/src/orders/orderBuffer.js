/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

/**
 * Order buffer backed by PostgreSQL.
 *
 * addOrder() does a single atomic INSERT ... ON CONFLICT DO UPDATE SET qty = qty + delta,
 * which is safe under any level of concurrency — no read-modify-write race condition.
 *
 * dispatchOrders() reads the current period totals, posts one consolidated stock event
 * to OpenLMIS, then zeroes the buffer rows for that period. A small JSON dispatch log
 * (mounted volume) prevents duplicate dispatch within the same calendar month.
 *
 * Dispatch log: /data/dispatched-orders.json  (Docker volume: mediator-data)
 */



const axios  = require('axios');
const { pool }                   = require('../db');
const { CONFIG, TIMEOUT_MS }     = require('../config/config');
const logger                     = require('../logger');
const { createStockTask }        = require('../tasks/tasks');
const { postLmisNotification }   = require('../routes/lmisNotifications');
const { canAccept }              = require('../config/roles');
const runtimeConfig              = require('../config/runtimeConfig');

const ORG_UNIT     = process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX';
let   _lastDispatchTs = 0;

function getLastDispatchTs() { return _lastDispatchTs; }

function currentPeriod() {
  return new Date().toISOString().slice(0, 7).replace('-', '');
}

// ─── Dispatch log helpers (Postgres-backed — survives mediator restart) ──────
// dispatch_log: one row per dispatched period. Replaces the old JSON file so a
// restart can't reset the guard and allow a double-dispatch. TODO #5.

// Returns { [period]: ISOtimestamp } to preserve the prior in-memory shape.
async function loadDispatchLog() {
  try {
    const r = await pool.query('SELECT period, dispatched_at FROM dispatch_log');
    const log = {};
    for (const row of r.rows) log[row.period] = new Date(row.dispatched_at).toISOString();
    return log;
  } catch (e) {
    logger.warn(`Could not read dispatch log: ${e.message}`);
    return {};
  }
}

// Mark a period dispatched (upsert; refreshes timestamp on force re-dispatch).
async function markDispatched(period) {
  await pool.query(
    `INSERT INTO dispatch_log (period, dispatched_at) VALUES ($1, NOW())
     ON CONFLICT (period) DO UPDATE SET dispatched_at = NOW()`,
    [period]
  );
}

// Clear a single period (used by force re-dispatch).
async function unmarkDispatched(period) {
  await pool.query('DELETE FROM dispatch_log WHERE period = $1', [period]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Atomically increments the running total for one medicine in the PostgreSQL
 * buffer table. Safe under any concurrency — no read-modify-write race.
 */
async function addOrder({ medicineCode, orderableId, qty, orgUnit, origin = null }) {
  if (!orderableId) {
    logger.warn({ event: 'order-skip', medicineCode, reason: 'no-orderable-id' });
    return { ok: false, reason: 'no-orderable-id' };
  }

  const targetOU = orgUnit || ORG_UNIT;
  const period   = currentPeriod();

  const result = await pool.query(
    `INSERT INTO order_buffer (period, orderable, org_unit, qty, origin)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (period, orderable, org_unit) DO UPDATE
       SET qty    = order_buffer.qty + EXCLUDED.qty,
           origin = EXCLUDED.origin
     RETURNING qty, origin`,
    [period, orderableId, targetOU, qty, origin]
  );

  const { qty: newTotal, origin: savedOrigin } = result.rows[0];
  logger.info({ event: 'order-saved', medicineCode, orderableId, qty, newTotal, period, orgUnit: targetOU, origin: savedOrigin });
  return { ok: true, totalQty: newTotal };
}

/**
 * Returns current pending order totals per medicine for this period.
 */
async function getBufferSnapshot() {
  const period = currentPeriod();
  const result = await pool.query(
    `SELECT orderable, org_unit, qty, origin FROM order_buffer WHERE period = $1 AND qty > 0`,
    [period]
  );

  const totals = {};
  for (const row of result.rows) {
    const { orderable, org_unit, qty, origin } = row;
    if (!totals[orderable]) {
      totals[orderable] = { orderableId: orderable, totalQty: 0, byOrgUnit: {}, byOrigin: {} };
    }
    totals[orderable].totalQty += qty;
    totals[orderable].byOrgUnit[org_unit] = (totals[orderable].byOrgUnit[org_unit] || 0) + qty;
    if (origin) totals[orderable].byOrigin[org_unit] = origin;
  }
  return totals;
}

/**
 * Reads current period totals from the buffer, sends one consolidated stock
 * event to OpenLMIS, then zeroes the buffer. The dispatch log prevents
 * duplicate dispatch within the same calendar month.
 */
async function dispatchOrders({ force = false } = {}) {
  const period = currentPeriod();
  const log    = await loadDispatchLog();

  if (log[period] && !force) {
    logger.info({ event: 'order-dispatch', outcome: 'already-dispatched', period, dispatchedAt: log[period] });
    return { period, dispatched: 0, outcome: 'already-dispatched', dispatchedAt: log[period] };
  }
  if (log[period] && force) {
    logger.info({ event: 'order-dispatch', outcome: 'force-redispatch', period });
    await unmarkDispatched(period);
    delete log[period];
  }

  const snapshot = await getBufferSnapshot();
  const entries  = Object.values(snapshot).filter(e => e.totalQty > 0);

  if (entries.length === 0) {
    logger.info({ event: 'order-dispatch', outcome: 'skipped', reason: 'no-orders', period });
    return { period, dispatched: 0, outcome: 'skipped' };
  }

  // Stock is NOT credited to OpenLMIS at dispatch time.
  // A facility-worker Task is created per medicine; when the FW physically
  // accepts the delivery in the app, THAT submission posts the CREDIT stockEvent.
  logger.info({ event: 'order-dispatch-start', period, medicines: entries.length });

  _lastDispatchTs = Date.now();
  await markDispatched(period);
  log[period] = new Date().toISOString();
  refreshDashboardText(log).catch(() => {});

  // Persist granular dispatch record
  const { PERFORMER_MAP } = require('../mappings/mappings');
  const historyRows = [];
  for (const entry of Object.values(snapshot)) {
    for (const [orgUnit, qty] of Object.entries(entry.byOrgUnit || {})) {
      if (qty <= 0) continue;
      const ouPerformers = (role) => Object.entries(PERFORMER_MAP)
        .filter(([id, m]) => id !== 'default' && m.dhis2OrgUnit === orgUnit && m.role === role)
        .map(([id]) => id).join(',');
      const vhwIds = ouPerformers('vhw') || ouPerformers('coordinator') || ouPerformers('facility_worker') || null;
      historyRows.push([period, entry.orderableId, orgUnit, qty, 'pending-receipt', force || false, vhwIds]);
    }
  }
  Promise.all(historyRows.map(r =>
    pool.query(
      `INSERT INTO dispatch_history (period, orderable_id, org_unit, qty, lmis_status, forced, performer_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      r
    )
  )).catch(err => logger.warn({ event: 'dispatch-history-write-error', error: err.message }));

  // Zero out the buffer — pending receipt is tracked via FHIR Tasks
  pool.query(`UPDATE order_buffer SET qty = 0 WHERE period = $1`, [period])
    .catch(err => logger.warn({ event: 'order-reset-pg-error', error: err.message }));

  // Create facility-worker Tasks — stock will be credited when FW accepts delivery
  createTasksForDispatch(snapshot, period).catch(err =>
    logger.warn({ event: 'auto-task-creation-error', error: err.message })
  );

  const totalUnits = entries.reduce((s, e) => s + e.totalQty, 0);
  if (runtimeConfig.get('NOTIFY_LMIS_ON_ORDER_DISPATCH') !== 'false') {
    postLmisNotification(
      'Order Dispatched — Awaiting Facility Receipt',
      `${entries.length} medicine line${entries.length !== 1 ? 's' : ''} ordered for period ` +
        `${period.slice(0, 4)}-${period.slice(4)} (${totalUnits} units total). ` +
        `Facility worker must accept delivery to update stock.`
    );
  }

  logger.info({ event: 'order-dispatch-complete', period, dispatched: entries.length, outcome: 'pending-receipt' });
  return {
    period, dispatched: entries.length, outcome: 'pending-receipt', summary: snapshot,
    results: [{ system: 'openlmis', status: 'pending-receipt', note: 'Stock credited on facility-worker acceptance' }],
  };
}

// ─── Auto Task creation after dispatch ───────────────────────────────────────

async function createTasksForDispatch(snapshot, period) {
  const { PERFORMER_MAP }    = require('../mappings/mappings');
  const { approveOrderTasks } = require('../tasks/tasks');

  const issueRef = `ORD-${period}-${Date.now()}`;
  let created = 0;
  let errors  = 0;

  const byFacility = {};
  const ouFallback  = {};

  for (const entry of Object.values(snapshot)) {
    const { orderableId, byOrgUnit: qtyByOU } = entry;
    if (!qtyByOU) continue;
    for (const [ou, qty] of Object.entries(qtyByOU)) {
      if (qty <= 0) continue;
      const facilityId = Object.values(PERFORMER_MAP).find(m => m.dhis2OrgUnit === ou)?.facilityId;
      if (facilityId) {
        if (!byFacility[facilityId]) byFacility[facilityId] = {};
        byFacility[facilityId][orderableId] = (byFacility[facilityId][orderableId] || 0) + qty;
      }
      if (!ouFallback[ou]) ouFallback[ou] = {};
      ouFallback[ou][orderableId] = (ouFallback[ou][orderableId] || 0) + qty;
    }
  }

  const facilityWorkers = Object.entries(PERFORMER_MAP)
    .filter(([id, m]) => id !== 'default' && canAccept(m.role));

  if (facilityWorkers.length === 0) {
    const byOU = {};
    for (const [id, m] of Object.entries(PERFORMER_MAP)) {
      if (id === 'default' || !m.dhis2OrgUnit) continue;
      if (!byOU[m.dhis2OrgUnit]) byOU[m.dhis2OrgUnit] = [];
      byOU[m.dhis2OrgUnit].push(id);
    }
    for (const [ou, meds] of Object.entries(ouFallback)) {
      for (const practId of (byOU[ou] || [])) {
        for (const [orderableId, qty] of Object.entries(meds)) {
          try {
            await createStockTask({ performer: practId, medication: orderableId, quantity: qty, issueRef, taskType: 'facility-receipt' });
            created++;
          } catch (err) {
            logger.warn({ event: 'auto-task-create-failed', practId, orderableId, ou, error: err.message });
            errors++;
          }
        }
      }
    }
  } else {
    for (const [facilityId, meds] of Object.entries(byFacility)) {
      const workers = facilityWorkers.filter(([, m]) => m.facilityId === facilityId);
      if (workers.length === 0) {
        logger.warn({ event: 'auto-task-no-facility-worker', facilityId });
        continue;
      }
      // One task per (facility, medicine) — prefer UUID-format IDs so the app can match the owner.
      const preferred = workers.find(([id]) => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) || workers[0];
      for (const [practId] of [preferred]) {
        for (const [orderableId, qty] of Object.entries(meds)) {
          const shortOid   = orderableId.replace(/-/g, '').slice(-8);
          const shortPract = practId.replace(/[^a-z0-9]/gi, '').slice(-8);
          const taskId = `task-fw-${period}-${shortOid}-${shortPract}`;
          try {
            await createStockTask({ performer: practId, medication: orderableId, quantity: qty, issueRef, taskId, taskType: 'facility-receipt' });
            created++;
          } catch (err) {
            logger.warn({ event: 'auto-task-create-failed', practId, orderableId, facilityId, error: err.message });
            errors++;
          }
        }
      }
    }
  }

  // Transition VHW on-hold Tasks (Awaiting Approval) → in-progress (Dispatched)
  const seenOrderables = new Set(Object.values(snapshot).filter(e => e.totalQty > 0).map(e => e.orderableId));
  for (const orderableId of seenOrderables) {
    await approveOrderTasks(orderableId, period);
  }

  logger.info({ event: 'auto-tasks-created', issueRef, created, errors });
}

// ─── Dashboard status update ──────────────────────────────────────────────────

async function refreshDashboardText(log) {
  const dashId  = process.env.ORDER_DASHBOARD_ID || 'BKMOrdDsh01';
  const dhisUrl = CONFIG.dhis2.url;
  const auth    = { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass };

  const period     = currentPeriod();
  const dispatched = log[period];
  const { getFrequency, nextDispatchTime } = require('./scheduleState');
  const freq    = getFrequency();
  const nextDt  = nextDispatchTime(freq);
  const nextRun = nextDt ? nextDt.toDateString() + ' at 06:00' : 'Disabled — manual dispatch only';

  const statusLine = dispatched
    ? `DISPATCHED  — ${new Date(dispatched).toUTCString()}`
    : `PENDING     — not yet dispatched this period`;

  const allPeriods = Object.entries(log)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 5)
    .map(([p, ts]) => `  ${p.slice(0,4)}-${p.slice(4)}  ${new Date(ts).toUTCString()}`)
    .join('\n') || '  (none)';

  const text =
`ORDER GATE — LIVE DISPATCH STATUS
Updated: ${new Date().toUTCString()}

CURRENT PERIOD
  Period:    ${period.slice(0,4)}-${period.slice(4)}
  Status:    ${statusLine}
  Schedule:  ${freq.charAt(0).toUpperCase() + freq.slice(1)}
  Next run:  ${nextRun}
  Target:    FHIR Tasks for FW receipt → CREDIT on acceptance; DEBIT on VHW dispense

ROLE ENFORCEMENT
  Only facility_worker Keycloak role may submit stock orders.
  VHW order attempts are rejected at the mediator with HTTP 403.
  Buffer is stored in PostgreSQL (order_buffer table) — survives restarts.

RECENT DISPATCH HISTORY
${allPeriods}

RECOVERY
  Failed dispatch: PostgreSQL totals preserved — next scheduled run retries automatically.
  Manual retry:    POST /mediator-api/aggregate/orders  (bkm-web Order Gate page)
  Already sent:    Endpoint returns already-dispatched — safe to call repeatedly.`;

  try {
    const dashRes = await axios.get(`${dhisUrl}/api/dashboards/${dashId}?fields=id,name,dashboardItems`, { auth, timeout: TIMEOUT_MS });
    const items   = (dashRes.data.dashboardItems || []).map(item =>
      item.type === 'TEXT' ? { ...item, text } : item
    );
    await axios.put(`${dhisUrl}/api/dashboards/${dashId}`,
      { id: dashId, name: dashRes.data.name, dashboardItems: items },
      { auth, timeout: TIMEOUT_MS }
    );
    logger.info({ event: 'order-dashboard-updated', period, dispatched: !!dispatched });
  } catch (_) {
    // best-effort — dashboard may not exist yet (run seed.sh to create it)
  }
}

async function updateBuffer(query, params, event, logData) {
  try {
    const result = await pool.query(query, params);
    logger.info({ event, ...logData, rows: result.rowCount });
    return result.rowCount;
  } catch (err) {
    logger.warn(`${event} failed: ${err.message}`);
    return 0;
  }
}

const markDispatchReceived = (orderableId, period) => updateBuffer(
  `UPDATE dispatch_history SET lmis_status = 'received' WHERE period = $1 AND orderable_id = $2 AND lmis_status = 'pending-receipt'`,
  [period, orderableId], 'dispatch-received', { orderableId, period }
);

// Archives the buffer rows about to be cancelled into dispatch_history with
// lmis_status='cancelled' so the History tab can show that the order existed
// and was deliberately cancelled rather than dispatched. Then zeroes the
// buffer rows. Returns the number of rows cancelled.
async function _cancelAndArchive(whereSql, params, event, logData) {
  const period = currentPeriod();
  try {
    // 1. SELECT the rows about to be cancelled (qty > 0 only — already-zero rows don't need a history record).
    const sel = await pool.query(
      `SELECT orderable, org_unit, qty, origin FROM order_buffer WHERE period = $1 ${whereSql} AND qty > 0`,
      [period, ...params]
    );
    if (sel.rowCount === 0) {
      logger.info({ event, ...logData, rows: 0 });
      return 0;
    }
    // 2. INSERT a 'cancelled' row per buffer row.
    for (const r of sel.rows) {
      await pool.query(
        `INSERT INTO dispatch_history (period, orderable_id, org_unit, qty, lmis_status, forced, performer_ids)
         VALUES ($1, $2, $3, $4, 'cancelled', FALSE, $5)`,
        [period, r.orderable, r.org_unit, r.qty, r.origin || null]
      );
    }
    // 3. Zero the buffer rows.
    await pool.query(
      `UPDATE order_buffer SET qty = 0 WHERE period = $1 ${whereSql} AND qty > 0`,
      [period, ...params]
    );
    logger.info({ event, ...logData, rows: sel.rowCount });
    return sel.rowCount;
  } catch (err) {
    logger.warn(`${event} failed: ${err.message}`);
    return 0;
  }
}

const cancelOrdersByOU = (orgUnit) =>
  _cancelAndArchive(`AND org_unit = $2`, [orgUnit], 'order-cancel-ou', { orgUnit });

const cancelAllOrders = () =>
  _cancelAndArchive(``, [], 'order-cancel-all', {});

const cancelOrderByMedicine = (orgUnit, orderable) =>
  _cancelAndArchive(`AND org_unit = $2 AND orderable = $3`, [orgUnit, orderable], 'order-cancel-medicine', { orgUnit, orderable });

async function dispatchOrderByMedicine(orgUnit, orderable) {
  const period = currentPeriod();

  const snap = await pool.query(
    `SELECT qty FROM order_buffer WHERE period = $1 AND org_unit = $2 AND orderable = $3`,
    [period, orgUnit, orderable]
  );
  const qty = snap.rows[0]?.qty || 0;
  if (qty <= 0) return { dispatched: 0, outcome: 'no-orders' };

  const { PERFORMER_MAP } = require('../mappings/mappings');
  const ouPerformers = (role) => Object.entries(PERFORMER_MAP)
    .filter(([id, m]) => id !== 'default' && m.dhis2OrgUnit === orgUnit && m.role === role)
    .map(([id]) => id).join(',');
  const vhwIds = ouPerformers('vhw') || ouPerformers('coordinator') || ouPerformers('facility_worker') || null;

  await pool.query(
    `INSERT INTO dispatch_history (period, orderable_id, org_unit, qty, lmis_status, forced, performer_ids)
     VALUES ($1, $2, $3, $4, 'pending-receipt', false, $5)`,
    [period, orderable, orgUnit, qty, vhwIds]
  );

  await pool.query(
    `UPDATE order_buffer SET qty = 0 WHERE period = $1 AND org_unit = $2 AND orderable = $3`,
    [period, orgUnit, orderable]
  );
  const { approveOrderTasks } = require('../tasks/tasks');
  const issueRef = `ORD-${period}-${Date.now()}`;
  let taskCreated = false;

  const facilityId = Object.values(PERFORMER_MAP).find(m => m.dhis2OrgUnit === orgUnit)?.facilityId;
  if (facilityId) {
    const workers = Object.entries(PERFORMER_MAP)
      .filter(([id, m]) => id !== 'default' && canAccept(m.role) && m.facilityId === facilityId);
    const preferred = workers.find(([id]) => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) || workers[0];
    if (preferred) {
      const [practId] = preferred;
      const shortOid   = orderable.replace(/-/g, '').slice(-8);
      const shortPract = practId.replace(/[^a-z0-9]/gi, '').slice(-8);
      const taskId = `task-fw-${period}-${shortOid}-${shortPract}`;
      try {
        await createStockTask({ performer: practId, medication: orderable, quantity: qty, issueRef, taskId, taskType: 'facility-receipt' });
        taskCreated = true;
      } catch (err) {
        logger.warn({ event: 'single-dispatch-task-failed', practId, orderable, error: err.message });
      }
    }
  }

  await approveOrderTasks(orderable, period);

  logger.info({ event: 'order-dispatch-single', orgUnit, orderable, qty, period, taskCreated });
  return { dispatched: 1, qty, outcome: 'pending-receipt', taskCreated };
}

async function clearDispatchLog() {
  try { await pool.query('DELETE FROM dispatch_log'); }
  catch (e) { logger.warn(`Could not clear dispatch log: ${e.message}`); }
  logger.info({ event: 'dispatch-log-cleared' });
}

module.exports = { addOrder, getBufferSnapshot, dispatchOrders, dispatchOrderByMedicine, refreshDashboardText, loadDispatchLog, clearDispatchLog, getLastDispatchTs, cancelOrdersByOU, cancelAllOrders, cancelOrderByMedicine, markDispatchReceived };
