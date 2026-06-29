/*
 * NEC XON (c) Copyright 2025.
 *
 * Per-VHW stock allocation store. A facility worker assigns a per-period budget
 * of a medicine to a VHW; dispenses deduct from it. OpenLMIS stock stays
 * facility-level — this is the per-VHW split tracked in the mediator's Postgres.
 */
'use strict';

const { pool } = require('../db');
const { publishBalance } = require('../sync/allocationLedger');

/** Current allocation period as YYYYMM (UTC). */
function currentPeriod() {
  return new Date().toISOString().slice(0, 7).replace('-', '');
}

/**
 * Re-read the row and mirror its remaining balance to FHIR (best-effort, fire-and-
 * forget). Called after any allocation change so the device can sync the live
 * remaining and block over-dispense at entry.
 */
function refreshBalance(period, practitioner, medication) {
  pool.query(
    `SELECT allocated_qty, dispensed_qty, facility_id FROM vhw_allocations
     WHERE period = $1 AND practitioner = $2 AND medication = $3`,
    [period, practitioner, medication]
  ).then(({ rows }) => {
    if (!rows.length) return;
    const r = rows[0];
    return publishBalance({
      period, practitioner, medication,
      allocated: r.allocated_qty, dispensed: r.dispensed_qty,
      remaining: r.allocated_qty - r.dispensed_qty, facilityId: r.facility_id,
    });
  }).catch(() => {});
}

/**
 * Returns the VHW's remaining budget for a medicine this period.
 *   { hasAllocation: false }                              — no allocation row
 *   { hasAllocation: true, ok, allocated, dispensed, remaining }
 */
async function checkAllocation(performer, medication, qty, period = currentPeriod()) {
  const { rows } = await pool.query(
    `SELECT allocated_qty, dispensed_qty, lot_code FROM vhw_allocations
     WHERE period = $1 AND practitioner = $2 AND medication = $3`,
    [period, performer, medication]
  );
  if (rows.length === 0) return { hasAllocation: false };
  const allocated = rows[0].allocated_qty;
  const dispensed = rows[0].dispensed_qty;
  const remaining = allocated - dispensed;
  return { hasAllocation: true, ok: remaining >= qty, allocated, dispensed, remaining, lotCode: rows[0].lot_code || null };
}

/** Increments dispensed_qty after a successful dispense (no-op if no allocation row). */
async function recordDispense(performer, medication, qty, period = currentPeriod()) {
  await pool.query(
    `UPDATE vhw_allocations SET dispensed_qty = dispensed_qty + $1, updated_at = NOW()
     WHERE period = $2 AND practitioner = $3 AND medication = $4`,
    [qty, period, performer, medication]
  );
  refreshBalance(period, performer, medication);
}

/** Sum of remaining (allocated − dispensed) committed to all VHWs for a medicine at a facility this period. */
async function committedForMedication(facilityId, medication, period = currentPeriod()) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(allocated_qty - dispensed_qty), 0) AS committed
     FROM vhw_allocations WHERE period = $1 AND facility_id = $2 AND medication = $3`,
    [period, facilityId, medication]
  );
  return parseInt(rows[0].committed, 10) || 0;
}

/** Upserts an allocation, ADDING to allocated_qty if a row already exists this period.
 *  lotCode (optional) is recorded for traceability; a re-allocation updates it to the latest. */
async function addAllocation({ period = currentPeriod(), facilityId, practitioner, medication, quantity, lotCode = null }) {
  await pool.query(
    `INSERT INTO vhw_allocations (period, facility_id, practitioner, medication, allocated_qty, lot_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (period, practitioner, medication)
     DO UPDATE SET allocated_qty = vhw_allocations.allocated_qty + EXCLUDED.allocated_qty,
                   lot_code      = COALESCE(EXCLUDED.lot_code, vhw_allocations.lot_code),
                   updated_at    = NOW()`,
    [period, facilityId, practitioner, medication, quantity, lotCode]
  );
  refreshBalance(period, practitioner, medication);
}

/** Clears allocations for a period (optionally a single facility), or all when all=true. Returns rows deleted. */
async function clearAllocations({ period = currentPeriod(), facilityId = null, all = false } = {}) {
  if (all) {
    const { rowCount } = await pool.query('DELETE FROM vhw_allocations');
    return rowCount;
  }
  const params = [period];
  let where = 'period = $1';
  if (facilityId) { params.push(facilityId); where += ' AND facility_id = $2'; }
  const { rowCount } = await pool.query(`DELETE FROM vhw_allocations WHERE ${where}`, params);
  return rowCount;
}

/** Lists allocations for a period (optionally filtered by facility). */
async function listAllocations({ period = currentPeriod(), facilityId = null } = {}) {
  const params = [period];
  let where = 'period = $1';
  if (facilityId) { params.push(facilityId); where += ' AND facility_id = $2'; }
  const { rows } = await pool.query(
    `SELECT period, facility_id, practitioner, medication, allocated_qty, dispensed_qty,
            (allocated_qty - dispensed_qty) AS remaining_qty, lot_code, updated_at
     FROM vhw_allocations WHERE ${where} ORDER BY practitioner, medication`,
    params
  );
  return rows;
}

module.exports = {
  currentPeriod, checkAllocation, recordDispense,
  committedForMedication, addAllocation, listAllocations, clearAllocations,
};
