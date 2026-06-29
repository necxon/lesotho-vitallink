/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 *
 * Per-VHW stock allocation API (mounted at /aggregate/stock).
 *   POST /allocate    — facility worker assigns a per-period budget to a VHW
 *   GET  /allocations — list allocations for a period (optionally by facility)
 */
'use strict';

const { Router } = require('express');
const logger     = require('../logger');
const reply      = require('../reply');
const { PERFORMER_MAP, resolveOrderableId, isKnownMedicineCode, canonicalMed } = require('../mappings/mappings');
const { decodeJwtSub } = require('../auth/jwt');
const { checkStock, listLots } = require('../integrations/openlmis');
const { facilityHasDelivery } = require('../db');
const { canAllocate, isVhw } = require('../config/roles');
const runtimeConfig = require('../config/runtimeConfig');
const { createStockTask } = require('../tasks/tasks');
const {
  currentPeriod, committedForMedication, addAllocation, listAllocations, clearAllocations,
} = require('../allocations/allocationStore');

const router = Router();

/** Resolve a performer key as sent by the UI, trying the bare id and the Practitioner/ form. */
function resolvePerformer(id) {
  if (!id) return null;
  if (PERFORMER_MAP[id]) return { ref: id, entry: PERFORMER_MAP[id] };
  const pref = `Practitioner/${id}`;
  if (PERFORMER_MAP[pref]) return { ref: pref, entry: PERFORMER_MAP[pref] };
  return null;
}

// POST /aggregate/stock/allocate
// Body: { vhwId, medication, quantity, facilityWorkerId? }
router.post('/allocate', async (req, res) => {
  const { vhwId, medication, facilityWorkerId } = req.body || {};
  const lotCode = (req.body && req.body.lotCode) || null;   // optional batch, traceability only
  const quantity = parseInt(req.body && req.body.quantity, 10);

  if (!vhwId)               return reply(res, { status: 'error', message: 'vhwId is required' }, 400);
  if (!medication)          return reply(res, { status: 'error', message: 'medication is required' }, 400);
  if (!quantity || quantity <= 0) return reply(res, { status: 'error', message: 'quantity must be a positive integer' }, 400);

  // Resolve the VHW (must exist and NOT be a facility worker)
  const vhw = resolvePerformer(vhwId);
  if (!vhw)                          return reply(res, { status: 'error', message: `Unknown VHW "${vhwId}"` }, 400);
  if (!isVhw(vhw.entry.role)) return reply(res, { status: 'error', message: 'Allocations can only be made to a VHW' }, 400);
  // Always key the allocation on the canonical performer id (vhwId may be an alias),
  // so dispenses by either the canonical id or an alias deduct from the same row.
  vhw.ref = (vhw.entry && vhw.entry._canonical) || vhw.ref;

  // Authoritative facility scoping: derive the CALLER from their token (KC sub is a
  // performer alias). A facility worker may only allocate to VHWs at their OWN facility;
  // supervisors/admins are exempt. NOTE: the token is decoded, not signature-verified
  // (hardened separately) — this stops accidental cross-facility allocation; tamper-proof
  // enforcement arrives with JWT verification.
  const caller = resolvePerformer(decodeJwtSub(req.headers.authorization));
  if (caller && canAllocate(caller.entry.role)
      && caller.entry.facilityId && caller.entry.facilityId !== vhw.entry.facilityId) {
    logger.warn(`allocate: cross-facility blocked — ${caller.entry.role} ${caller.ref} (${caller.entry.facilityId}) → VHW ${vhw.ref} (${vhw.entry.facilityId})`);
    return reply(res, {
      status: 'error', reason: 'cross-facility',
      message: `You can only allocate to VHWs at your own facility (${caller.entry.facilityName || caller.entry.facilityId}).`,
    }, 403);
  }

  // Optional allocator check: if provided, must be a coordinator (or admin) at the same facility
  if (facilityWorkerId) {
    const fw = resolvePerformer(facilityWorkerId);
    if (!fw || !canAllocate(fw.entry.role)) {
      return reply(res, { status: 'error', message: 'facilityWorkerId is not a store manager or coordinator' }, 400);
    }
    if (fw.entry.facilityId !== vhw.entry.facilityId) {
      return reply(res, { status: 'error', message: 'Facility worker and VHW are at different facilities' }, 400);
    }
  }

  const facilityId  = vhw.entry.facilityId || process.env.OPENLMIS_FACILITY_ID;
  const programId   = vhw.entry.programId  || process.env.OPENLMIS_PROGRAM_ID;
  const orderableId = resolveOrderableId(medication);
  if (!orderableId) return reply(res, { status: 'error', message: `Unknown medication "${medication}"` }, 400);

  // Require an accepted delivery first: the facility must have received a real delivery
  // (a non-seed CREDIT) before any stock can be allocated to VHWs. Seeded opening stock
  // does NOT count. Fail-open on a DB hiccup so a transient error can't block all work.
  if (runtimeConfig.get('REQUIRE_DELIVERY_BEFORE_ALLOCATION') !== 'false') {
    let delivered = true;
    try { delivered = await facilityHasDelivery(facilityId); }
    catch (e) { logger.warn(`allocate: delivery check failed (allowing): ${e.message}`); }
    if (!delivered) {
      return reply(res, {
        status: 'error', reason: 'no-delivery-accepted',
        message: 'No delivery has been accepted at this facility yet. Accept a stock delivery before allocating to VHWs.',
      }, 422);
    }
  }

  // Canonical medicine key — stable across the medicine's aliases/codes so a
  // dispense (which keys on the app code) deducts from this allocation regardless
  // of which alias the facility worker picked in the dropdown.
  const medKey = canonicalMed(medication);

  const period = currentPeriod();

  // Facility SOH must cover everything already committed this period + this new request.
  const committed = await committedForMedication(facilityId, medKey, period);
  const soh = await checkStock({ facilityId, programId, orderableId }, committed + quantity);
  if (!soh.ok) {
    return reply(res, {
      status: 'error', reason: 'insufficient-facility-stock',
      message: `Facility stock (${soh.stockOnHand}) cannot cover committed allocations (${committed}) + ${quantity}`,
      stockOnHand: soh.stockOnHand, committed, requested: quantity,
    }, 422);
  }

  try {
    await addAllocation({ period, facilityId, practitioner: vhw.ref, medication: medKey, quantity, lotCode });
  } catch (err) {
    logger.error(`allocate: DB upsert failed: ${err.message}`);
    return reply(res, { status: 'error', message: `Allocation write failed: ${err.message}` }, 502);
  }

  // Create a FHIR Task so the VHW sees the allocation on the Android app (best-effort).
  createStockTask({
    performer: vhw.ref, medication: medKey, quantity,
    taskId: `task-alloc-${period}-${vhw.ref.replace(/[^a-zA-Z0-9]/g, '')}-${medKey.replace(/[^a-zA-Z0-9]/g, '')}`,
    taskType: 'allocation',
  }).catch(e => logger.warn(`allocate: FHIR Task creation failed (continuing): ${e.message}`));

  // Re-read remaining for an accurate response
  const updated = await listAllocations({ period, facilityId });
  const row = updated.find(r => r.practitioner === vhw.ref && r.medication === medKey) || {};

  logger.info(`allocate: ${quantity} ${medKey} -> ${vhw.ref} (period ${period}, committed now ${committed + quantity})`);
  reply(res, {
    status: 'ok', period, vhwId: vhw.ref, medication: medKey,
    allocatedQty: row.allocated_qty, dispensedQty: row.dispensed_qty,
    remainingQty: row.remaining_qty, facilityId,
    medicineKnown: isKnownMedicineCode(medication),
  });
});

// GET /aggregate/stock/lots?medication=CODE
// Lists the OpenLMIS lots (batches) for a medicine, to populate the allocate form's
// lot dropdown. Returns [{ id, lotCode, expirationDate }]. Empty when none/unknown.
router.get('/lots', async (req, res) => {
  const medication = req.query.medication;
  if (!medication) return reply(res, { status: 'error', message: 'medication is required' }, 400);
  const orderableId = resolveOrderableId(medication);
  if (!orderableId) return reply(res, { lots: [] });
  try {
    const lots = await listLots(orderableId);
    reply(res, { medication, orderableId, lots });
  } catch (err) {
    logger.warn(`lots lookup failed for ${medication}: ${err.message}`);
    reply(res, { lots: [] });
  }
});

// DELETE /aggregate/stock/allocations?period=YYYYMM&facilityId=...&all=true
// Clears the current period's allocations (or a single facility, or everything with all=true).
router.delete('/allocations', async (req, res) => {
  const period     = req.query.period || currentPeriod();
  const facilityId = req.query.facilityId || null;
  const all        = req.query.all === 'true';
  try {
    const cleared = await clearAllocations({ period, facilityId, all });
    logger.info(`allocations cleared: ${cleared} row(s) (${all ? 'ALL periods' : 'period ' + period}${facilityId ? ', facility ' + facilityId : ''})`);
    reply(res, { status: 'ok', cleared, period: all ? 'all' : period });
  } catch (err) {
    reply(res, { status: 'error', message: err.message }, 502);
  }
});

// GET /aggregate/stock/allocations?period=YYYYMM&facilityId=...
router.get('/allocations', async (req, res) => {
  const period     = req.query.period || currentPeriod();
  const facilityId = req.query.facilityId || null;
  try {
    const rows = await listAllocations({ period, facilityId });
    reply(res, { status: 'ok', period, count: rows.length, allocations: rows });
  } catch (err) {
    reply(res, { status: 'error', message: err.message }, 502);
  }
});

module.exports = router;
