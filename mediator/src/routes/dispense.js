/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const { Router } = require('express');
const logger        = require('../logger');
const reply         = require('../reply');
const { PERFORMER_MAP }  = require('../mappings/mappings');
const { executeFanout, resolveIdentity, fmtResult } = require('../sync/fanout');
const runtimeConfig = require('../config/runtimeConfig');
const { pool }      = require('../db');
const { mirrorDispenseToHapi } = require('../sync/hapiMirror');
const { voidRejectedDispense } = require('../sync/reconcile');

const router = Router();

// Idempotency store backed by Postgres (idempotency_cache table) so a mediator
// restart inside the window can't let a duplicate dispense fan out again. TODO #6.
// Returns true if `id` was already seen within the window (i.e. it's a duplicate).
// Fails OPEN (returns false) on any DB error — never blocks a valid dispense.
async function checkDuplicate(id) {
  const windowMs = parseInt(runtimeConfig.get('IDEMPOTENCY_WINDOW_MS') || '300000', 10);
  try {
    // Drop expired entries first so an old id outside the window is not a duplicate.
    await pool.query(
      `DELETE FROM idempotency_cache WHERE accepted_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
      [windowMs]
    );
    // Atomic check-and-insert: a returned row means we inserted (first time → not dup);
    // no row means it already existed within the window (→ duplicate).
    const r = await pool.query(
      `INSERT INTO idempotency_cache (resource_id) VALUES ($1)
       ON CONFLICT (resource_id) DO NOTHING RETURNING resource_id`,
      [id]
    );
    return r.rowCount === 0;
  } catch (err) {
    logger.warn({ event: 'idempotency-check-failed', resourceId: id, error: err.message });
    return false;
  }
}

async function clearSeenIds() {
  try { await pool.query('DELETE FROM idempotency_cache'); }
  catch (err) { logger.warn({ event: 'idempotency-clear-failed', error: err.message }); }
}

// Build OpenHIM orchestrations from the fan-out results so the Console visualizer
// (#!/visualizer) lights up each downstream system. The `name` of each orchestration
// MUST match the eventName of the corresponding visualizer component (see
// scripts/setup-visualizer.sh): "HAPI FHIR (OpenSRP)", "OpenLMIS", "DHIS2".
function buildOrchestrations(opensrp, dhis, lmis) {
  const now = () => new Date().toISOString();
  const one = (name, host, path, r) => {
    let httpStatus, body;
    if (r.status === 'fulfilled' && r.value?._disabled) {
      httpStatus = 0; body = 'disabled (fan-out toggle off)';
    } else if (r.status === 'fulfilled') {
      httpStatus = typeof r.value?.status === 'number' ? r.value.status : 200;
      body = `HTTP ${httpStatus}`;
    } else {
      httpStatus = r.reason?.response?.status || r.reason?.status || 500;
      body = r.reason?.message || 'error';
    }
    return {
      name,
      request:  { method: 'POST', host, path, timestamp: now() },
      response: { status: httpStatus, headers: {}, body: String(body), timestamp: now() },
    };
  };
  return [
    one('HAPI FHIR (OpenSRP)', 'opensrp',  '/fhir',             opensrp),
    one('OpenLMIS',            'openlmis', '/api/stockEvents',  lmis),
    one('DHIS2',               'dhis2',    '/api/dataValueSets', dhis),
  ];
}

// POST /fhir/MedicationDispense
router.post('/', async (req, res) => {
  const resource = req.body;
  const t0       = Date.now();

  try {
    const resourceId = resource.id;
    const performer  = resource.performer?.[0]?.actor?.reference;
    const medCode    = resource.medicationCodeableConcept?.coding?.[0]?.code;
    const qty        = resource.quantity?.value || 0;
    const subject    = resource.subject?.reference || 'unknown';

    logger.info({
      event: 'dispense-received',
      resourceId, performer, medCode, qty, subject,
      whenHandedOver: resource.whenHandedOver,
    });

    // Idempotency gate
    if (resourceId && runtimeConfig.get('REJECT_DUPLICATE_DISPENSE') !== 'false') {
      if (await checkDuplicate(resourceId)) {
        logger.warn({ event: 'dispense-duplicate', resourceId, performer, medCode });
        return reply(res, { status: 'Rejected', reason: 'duplicate-dispense', id: resourceId }, 409);
      }
    }

    const identity = resolveIdentity(performer, medCode);
    logger.info({
      event:          'dispense-identity-resolved',
      performer,      medCode,
      performerKnown: identity.performerKnown,
      medicineKnown:  identity.medicineKnown,
      facilityId:     identity.facilityId,
      facilityName:   identity.facilityName,
      programId:      identity.programId,
      orderableId:    identity.orderableId,
      dhis2OrgUnit:   identity.dhis2OrgUnit,
      role:           identity.role,
    });

    if (!identity.facilityId || !identity.orderableId) {
      logger.error({ event: 'dispense-mapping-incomplete', performer, medCode, identity });
      throw new Error(`Incomplete mapping: performer=${performer} medication=${medCode}`);
    }

    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';
    const isReceipt   = resource.type?.coding?.some(c => c.code === receiptCode) ?? false;
    const vhw         = PERFORMER_MAP[performer] || {};

    logger.info({ event: 'dispense-fanout-start', resourceId, isReceipt, qty, medCode, facilityId: identity.facilityId });

    const { validation, stock, opensrp, dhis, lmis } = await executeFanout(resource, identity, isReceipt, {
      qty,
      medCode,
      patient:     subject,
      triggeredBy: `BKM-${resourceId || 'dispense'}`,
      phone:       vhw.phone || null,
      email:       vhw.email || null,
    });

    if (!validation.ok) {
      logger.warn({ event: 'dispense-validation-rejected', resourceId, reason: validation.reason, validation });
      voidRejectedDispense(resource, validation.reason).catch(() => {});
      return reply(res, { status: 'Rejected', ...validation }, 422);
    }

    if (!stock.ok) {
      logger.warn({ event: 'dispense-stock-rejected', resourceId, stockOnHand: stock.stockOnHand, requested: stock.requested });
      voidRejectedDispense(resource, 'insufficient-stock').catch(() => {});
      return reply(res, { status: 'Rejected', reason: 'insufficient-stock', stockOnHand: stock.stockOnHand, requested: stock.requested }, 422);
    }

    const allOk = [opensrp, dhis, lmis].every(r => r.status === 'fulfilled');
    const elapsedMs = Date.now() - t0;

    // Mirror to HAPI FHIR so the Stock Log page can cross-reference dispenses by date+qty.
    // Tagged as mediator-processed so the HAPI poller doesn't fan-out again.
    if (lmis.status === 'fulfilled') mirrorDispenseToHapi(resource, resourceId);

    logger.info({
      event: 'dispense-complete',
      resourceId, isReceipt, elapsedMs,
      opensrp:  { status: opensrp.status,  result: fmtResult(opensrp),  error: opensrp.reason?.message  },
      dhis2:    { status: dhis.status,     result: fmtResult(dhis),     error: dhis.reason?.message     },
      openlmis: { status: lmis.status,     result: fmtResult(lmis),     error: lmis.reason?.message     },
    });

    const body = {
      status:  allOk ? 'Successful' : 'Completed with errors',
      type:    isReceipt ? 'receipt' : 'dispense',
      results: { opensrp: fmtResult(opensrp), dhis2: fmtResult(dhis), openlmis: fmtResult(lmis) },
    };
    const httpStatus = allOk ? 200 : 207;

    // Emit the OpenHIM mediator envelope (with orchestrations) so the Console
    // visualizer animates each downstream system. OpenHIM unwraps response.body
    // back to the client, so the Android app still receives `body`. Toggle off with
    // MEDIATOR_ORCHESTRATIONS=false (falls back to the plain JSON reply).
    if (runtimeConfig.get('MEDIATOR_ORCHESTRATIONS') !== 'false') {
      reply.replyMediator(res, body, httpStatus, {
        orchestrations:    buildOrchestrations(opensrp, dhis, lmis),
        transactionStatus: allOk ? 'Successful' : 'Completed with error(s)',
      });
    } else {
      reply(res, body, httpStatus);
    }
  } catch (err) {
    logger.error({ event: 'dispense-error', error: err.message, stack: err.stack, elapsedMs: Date.now() - t0 });
    reply(res, { status: 'Error', message: err.message }, 500);
  }
});

router.clearSeenIds = clearSeenIds;
module.exports = router;
