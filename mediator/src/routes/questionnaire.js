/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router } = require('express');
const logger = require('../logger');
const reply  = require('../reply');

function decodeJwtRoles(authHeader) {
  try {
    const token   = (authHeader || '').replace(/^Bearer\s+/i, '');
    const payload = token.split('.')[1];
    if (!payload) return [];
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return claims?.realm_access?.roles || [];
  } catch {
    return [];
  }
}
const { PERFORMER_MAP } = require('../mappings/mappings');
const { executeFanout, resolveIdentity, fmtResult } = require('../sync/fanout');
const { voidRejectedDispense } = require('../sync/reconcile');
const { createStockTask, fetchStockTask, completeStockTask, createOnHoldTask, completeOrderTasksForOrderable } = require('../tasks/tasks');
const { notifyReceipt } = require('../sync/poller');
const { addOrder, dispatchOrders, markDispatchReceived } = require('../orders/orderBuffer');
const { checkStock, pushToOpenLMIS } = require('../integrations/openlmis');
const { canPlaceOrder, canAccept } = require('../config/roles');
const { syncOrderableToFhir } = require('../sync/fhirLedger');

const router = Router();
const runtimeConfig = require('../config/runtimeConfig');

// Content-based dedup: key=(authored_minute:patient:commodity:qty) → first-seen timestamp
// Catches app retries that generate a new resource ID for the same logical dispense.
const _seenContent = new Map();

function _isDuplicateQr(authored, patient, commodity, qty) {
  const windowMs = parseInt(runtimeConfig.get('IDEMPOTENCY_WINDOW_MS') || '300000', 10);
  if (!windowMs) return false;
  const now = Date.now();
  for (const [k, ts] of _seenContent) {
    if (now - ts > windowMs) _seenContent.delete(k);
  }
  // Truncate authored to the minute so minor clock skew between retries doesn't break dedup
  const authoredMin = authored ? authored.slice(0, 16) : '';
  const key = `${authoredMin}:${patient}:${commodity}:${qty}`;
  if (_seenContent.has(key)) return true;
  _seenContent.set(key, now);
  return false;
}

const ADJUSTMENT_REASON_MAP = {
  expired:     () => process.env.OPENLMIS_REASON_EXPIRED_ID || 'ae6be2ea-4a95-4e7e-b8d3-000000000001',
  damaged:     () => process.env.OPENLMIS_REASON_DAMAGED_ID || 'ae6be2ea-4a95-4e7e-b8d3-000000000002',
  lost_stolen: () => process.env.OPENLMIS_REASON_LOST_ID    || 'ae6be2ea-4a95-4e7e-b8d3-000000000003'
};

// POST /fhir/QuestionnaireResponse
router.post('/', async (req, res) => {
  const qr = req.body;
  const t0  = Date.now();

  try {
    // Parse QR answers into a flat map (recursive — handles nested group items)
    const answers = {};
    const flattenItems = (items) => {
      for (const item of (items || [])) {
        const ans = item.answer?.[0];
        if (ans) answers[item.linkId] = ans;
        if (item.item) flattenItems(item.item);
      }
    };
    flattenItems(qr.item);

    // UUID link IDs from the physical-inventory/restock questionnaire (a3b8260b)
    const STOCK_Q_COMMODITY = '650dd00d-c60b-4a3d-838a-128aad04827f';
    const STOCK_Q_QTY       = '35f0cdc3-7c3f-4a7a-8299-62fd801b9510';

    const medCode   = answers['medication']?.valueCoding?.code
                   || answers['medication_name']?.valueCoding?.code
                   || answers['commodity']?.valueCoding?.code
                   || answers['d-commodity-name']?.valueString
                   || answers[STOCK_Q_COMMODITY]?.valueString
                   || 'AL-20-120';
    const quantity  = answers['quantity']?.valueInteger
                   ?? answers['quantity_dispensed']?.valueInteger
                   ?? answers['quantity_accepted']?.valueInteger
                   ?? answers['quantity_received']?.valueInteger
                   ?? answers['quantity_ordered']?.valueInteger
                   ?? answers['d-quantity']?.valueInteger
                   ?? answers[STOCK_Q_QTY]?.valueInteger
                   ?? 0;
    const performer = qr.author?.reference || 'Practitioner/opensrp-admin';

    if (!qr.item?.length || quantity === 0) {
      logger.info(`QR fan-out skipped: questionnaire=${qr.questionnaire} itemCount=${qr.item?.length ?? 0} quantity=${quantity} answers=${JSON.stringify(Object.keys(answers))}`);
      return reply(res, { status: 'Ignored' });
    }

    const typeCode     = answers['type']?.valueCoding?.code || '';
    const qRef         = qr.questionnaire || '';
    // Physical inventory/restock questionnaire — treat Quantity Restocked as a receipt
    const isStockInventoryQ = qRef.includes('a3b8260b-d474-42ef-9ab2-a7794a0a27bc');
    const isReceipt    = isStockInventoryQ
                      || typeCode === (process.env.RECEIPT_TYPE_CODE || 'RECEIPT')
                      || /qn-stock-accept/i.test(qRef);
    const isAdjustment = typeCode === 'ADJUSTMENT' || /qn-stock-adjustment/i.test(qRef);
    const isOrder      = typeCode === (process.env.ORDER_TYPE_CODE || 'ORDER')
                      || /qn-stock-order/i.test(qRef)
                      || qRef.includes('e1f2a3b4-c5d6-7e8f-9a0b-c1d2e3f4a5b6');

    // Resolve adjustment reason → OpenLMIS reasonId
    let adjustmentReasonId = null;
    if (isAdjustment) {
      const reasonCode = answers['adjustmentReason']?.valueCoding?.code;
      const resolveReason = ADJUSTMENT_REASON_MAP[reasonCode];
      if (!resolveReason) {
        return reply(res, {
          status: 'Error',
          message: `Unknown adjustmentReason "${reasonCode}" — must be: expired, damaged, lost_stolen`
        }, 400);
      }
      adjustmentReasonId = resolveReason();
      logger.info(`Stock adjustment: reason=${reasonCode} reasonId=${adjustmentReasonId} medication=${medCode} qty=${quantity}`);
    }

    // Stock order — buffer for batch dispatch; return SOH info
    if (isOrder) {
      // JWT role check: if the request carries a Keycloak token, enforce that the
      // user may place orders (coordinator or admin).
      const jwtRoles = decodeJwtRoles(req.headers.authorization);
      const hasJwt   = jwtRoles.length > 0;
      if (hasJwt && !jwtRoles.some(r => canPlaceOrder(r.toLowerCase()))) {
        logger.warn(`Order rejected: JWT roles [${jwtRoles.join(',')}] cannot place orders`);
        return reply(res, { status: 'Rejected', reason: 'not-authorised', message: 'Only store managers or coordinators can place stock orders' }, 403);
      }
      // PERFORMER_MAP fallback when no JWT: block VHW (and any other) roles from ordering
      if (!hasJwt) {
        const performerRole = PERFORMER_MAP[performer]?.role || PERFORMER_MAP[`Practitioner/${performer}`]?.role;
        if (performerRole && !canPlaceOrder(performerRole)) {
          logger.warn(`Order rejected: performer=${performer} role=${performerRole} — only store managers or coordinators may order stock`);
          return reply(res, { status: 'Rejected', reason: 'not-authorised', message: 'Only store managers or coordinators can place stock orders' }, 403);
        }
      }

      const immediate = req.query.immediate === 'true'
                     || answers['immediate_dispatch']?.valueBoolean === true;

      const identity = resolveIdentity(performer, medCode);
      if (!identity.orderableId) {
        return reply(res, { status: 'Error', message: `No orderable mapping for medication=${medCode}` }, 400);
      }
      const [orderResult, sohCheck] = await Promise.all([
        addOrder({ medicineCode: medCode, orderableId: identity.orderableId, qty: quantity, orgUnit: identity.dhis2OrgUnit || null, origin: performer || null }),
        checkStock(identity, 0)
      ]);
      if (!orderResult.ok) {
        return reply(res, { status: 'Error', message: `Order not saved: ${orderResult.reason}` }, 400);
      }
      logger.info(`Stock order saved: medication=${medCode} qty=${quantity} total=${orderResult.totalQty} vhw=${performer} soh=${sohCheck.stockOnHand ?? 'unknown'} immediate=${immediate}`);

      if (immediate) {
        const dispatch = await dispatchOrders({ force: true });
        return reply(res, {
          status:          'Successful',
          type:            'order-immediate',
          medicineCode:    medCode,
          quantityOrdered: quantity,
          totalOrderedThisPeriod: orderResult.totalQty,
          stockOnHand:     sohCheck.stockOnHand ?? null,
          dispatch,
        });
      }

      return reply(res, {
        status:          'Queued',
        type:            'order',
        medicineCode:    medCode,
        quantityOrdered: quantity,
        totalOrderedThisPeriod: orderResult.totalQty,
        stockOnHand:     sohCheck.stockOnHand ?? null,
        message:         'Order saved to DHIS2 — dispatched in next batch'
      }, 202);
    }

    // BR-04: resolve task reference (adjustments bypass — no Task involved)
    const taskRef = !isAdjustment
      ? (qr.basedOn?.[0]?.reference || (answers['task_id'] ? `Task/${answers['task_id'].valueString}` : null))
      : null;
    const taskId  = taskRef?.startsWith('Task/') ? taskRef.split('/')[1] : null;

    let fetchedTask = null;
    if (taskId) {
      fetchedTask = await fetchStockTask(taskId);
      if (!fetchedTask) {
        return reply(res, { status: 'Error', message: `Task/${taskId} not found` }, 404);
      }
      if (fetchedTask.status !== 'requested') {
        logger.warn(`BR-04 violation: Task/${taskId} already has status=${fetchedTask.status}`);
        return reply(res, { status: 'Rejected', reason: 'already-accepted', taskId, taskStatus: fetchedTask.status }, 409);
      }
    }

    // If the referenced task is owned by a VHW, treat this as a VHW stock confirmation —
    // just complete the task. The performer may have fallen back to opensrp-admin (facility_worker)
    // because the QR has no author field, so we use task ownership rather than performer role.
    if (isReceipt && taskId && fetchedTask) {
      const taskOwnerRef = fetchedTask.owner?.reference || fetchedTask.for?.reference || '';
      const taskOwnerId  = taskOwnerRef.replace('Practitioner/', '');
      const ownerEntry   = PERFORMER_MAP[taskOwnerRef] || PERFORMER_MAP[taskOwnerId];
      if (ownerEntry && !canAccept(ownerEntry.role)) {
        await completeStockTask(taskId);
        logger.info(`VHW task confirmed: Task/${taskId} owner=${taskOwnerRef} medicine=${medCode} qty=${quantity}`);
        return reply(res, { status: 'Successful', type: 'vhw-confirmation', taskId, medicineCode: medCode, quantity });
      }
    }

    // Store-manager / coordinator acceptance: post CREDIT to OpenLMIS, complete the task, fan VHW Tasks out.
    const _accRole = PERFORMER_MAP[performer]?.role;
    if (isReceipt && canAccept(_accRole)) {
      const period   = new Date().toISOString().slice(0, 7).replace('-', '');
      const identity = resolveIdentity(performer, medCode);

      if (!identity.facilityId || !identity.orderableId) {
        return reply(res, { status: 'Error', message: `No mapping for performer=${performer} medication=${medCode}` }, 400);
      }

      // Determine ordered qty for partial receipt calculation.
      // Primary: prepopulated quantity_ordered from the acceptance questionnaire.
      // Fallback: task.input where type.text = 'quantity' (the original dispatch task).
      const quantityOrdered = answers['quantity_ordered']?.valueInteger
        ?? fetchedTask?.input?.find(i => i.type?.text === 'quantity')?.valueInteger
        ?? quantity; // if we can't determine ordered qty, assume fully received
      const quantityOutstanding = Math.max(0, quantityOrdered - quantity);

      const syntheticResource = { id: qr.id || `fw-rcpt-${Date.now()}`, quantity: { value: quantity } };
      let lmisStatus = 'error';
      try {
        await pushToOpenLMIS(syntheticResource, identity, true); // isReceipt=true → CREDIT received qty only
        lmisStatus = 'fulfilled';
        notifyReceipt();
        syncOrderableToFhir(identity, medCode).catch(() => {}); // mirror new SOH into HAPI ledger
        markDispatchReceived(identity.orderableId, period).catch(() => {});
        logger.info(`FW acceptance CREDIT: performer=${performer} medicine=${medCode} received=${quantity}/${quantityOrdered} facility=${identity.facilityId}`);
      } catch (err) {
        logger.warn(`FW acceptance CREDIT failed (non-fatal): ${err.message}`);
        lmisStatus = `error: ${err.message}`;
      }

      // Complete original task — done regardless of LMIS outcome
      if (taskId) completeStockTask(taskId).catch(() => {});
      // Complete the matching in-progress order task (task-ord-*) so it disappears from the Tasks page
      completeOrderTasksForOrderable(identity.orderableId, period).catch(() => {});

      // If partially received, create a follow-up facility-receipt task for the outstanding balance
      let followUpTaskId = null;
      if (quantityOutstanding > 0) {
        try {
          const followUp = await createStockTask({
            performer,
            medication: medCode,
            quantity:   quantityOutstanding,
            issueRef:   taskId ? `Task/${taskId}` : `FW-${Date.now()}`,
            taskType:   'facility-receipt',
          });
          followUpTaskId = followUp?.id || null;
          logger.info(`Partial receipt: outstanding=${quantityOutstanding} followUpTask=${followUpTaskId}`);
        } catch (err) {
          logger.warn(`Follow-up task creation failed: ${err.message}`);
        }
      }

      logger.info(`Facility worker receipt: performer=${performer} medicine=${medCode} received=${quantity} ordered=${quantityOrdered} outstanding=${quantityOutstanding} lmis=${lmisStatus}`);
      return reply(res, {
        status:              lmisStatus === 'fulfilled' ? 'Successful' : 'Completed with errors',
        type:                'facility-receipt',
        quantityReceived:    quantity,
        quantityOrdered,
        quantityOutstanding,
        followUpTaskId,
        results:             { opensrp: 'skipped', dhis2: 'skipped', openlmis: lmisStatus }
      });
    }

    // Content-based duplicate check for dispense QRs from the Android app.
    // The app sometimes retries with a fresh UUID — this catches same (authored, patient, commodity, qty)
    // within the idempotency window and returns 409 without double-deducting stock.
    if (!isReceipt && !isAdjustment && !isOrder) {
      const patient = qr.subject?.reference || '';
      if (_isDuplicateQr(qr.authored, patient, medCode, quantity)) {
        logger.warn(`Duplicate QR rejected (content match): authored=${qr.authored} patient=${patient} medication=${medCode} qty=${quantity}`);
        return reply(res, { status: 'Rejected', reason: 'duplicate-qr' }, 409);
      }
    }

    // Build a synthetic resource the fan-out functions understand. Carry the
    // patient (qr.subject) and a handover date so it can be mirrored to HAPI as a
    // per-patient MedicationDispense (powers the patient page's dispense history).
    const resource = {
      resourceType: 'MedicationDispense',
      id:       qr.id || `qr-${Date.now()}`,
      status:   'completed',
      subject:  qr.subject || undefined,
      performer: [{ actor: { reference: performer } }],
      medicationCodeableConcept: { coding: [{ code: medCode }] },
      quantity: { value: quantity },
      whenHandedOver: qr.authored || new Date().toISOString()
    };

    const identity = resolveIdentity(performer, medCode);
    if (!identity.facilityId || !identity.orderableId) {
      throw new Error(`No mapping for performer=${performer} medication=${medCode}`);
    }

    const vhw = PERFORMER_MAP[performer] || {};

    const { validation, stock, opensrp, dhis, lmis } = await executeFanout(resource, identity, isReceipt, {
      qty:         quantity,
      medCode,
      patient:     qr.subject?.reference || 'unknown',
      triggeredBy: taskId ? `Task/${taskId}` : `BKM-${resource.id}`,
      phone:       vhw.phone || null,
      email:       vhw.email || null,
      reasonId:    adjustmentReasonId,
      reasonCode:  isAdjustment ? answers['adjustmentReason']?.valueCoding?.code : null
    });

    if (!validation.ok) {
      logger.warn(`BR-07 rejection: ${validation.reason}`);
      voidRejectedDispense(qr, validation.reason).catch(() => {});
      return reply(res, { status: 'Rejected', ...validation }, 422);
    }

    if (!stock.ok) {
      voidRejectedDispense(qr, 'insufficient-stock').catch(() => {});
      return reply(res, { status: 'Rejected', reason: 'insufficient-stock', stockOnHand: stock.stockOnHand, requested: stock.requested }, 422);
    }

    // BR-04: mark Task completed so it cannot be accepted again
    if (lmis.status === 'fulfilled' && taskId) {
      completeStockTask(taskId).catch(() => {});
    }

    // Mirror patient dispenses to HAPI as a MedicationDispense so they appear in
    // the patient's dispense history. Only for actual dispenses (not receipts,
    // adjustments, or orders) and only when the QR carries a patient subject.
    if (lmis.status === 'fulfilled' && !isReceipt && !isAdjustment && !isOrder && qr.subject?.reference) {
      const { mirrorDispenseToHapi } = require('../sync/hapiMirror');
      mirrorDispenseToHapi(resource, resource.id).catch(() => {});
    }

    // Update HAPI FHIR Observation with new SOH so the app sees the correct balance after next sync
    if (lmis.status === 'fulfilled' && !isAdjustment) {
      const obsId = answers['d-observation-id']?.valueString;
      const newSoh = stock.stockOnHand != null
        ? stock.stockOnHand - quantity   // optimistic: deduct from last-known SOH
        : null;
      if (obsId && newSoh != null && newSoh >= 0) {
        const axios = require('axios');
        const hapiUrl = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
        axios.get(`${hapiUrl}/Observation/${obsId}`, { timeout: 5000 })
          .then(r => {
            const obs = r.data;
            if (obs.component?.[0]?.valueQuantity) {
              obs.component[0].valueQuantity.value = newSoh;
            } else if (obs.valueQuantity) {
              obs.valueQuantity.value = newSoh;
            }
            obs.effectiveDateTime = new Date().toISOString();
            return axios.put(`${hapiUrl}/Observation/${obsId}`, obs, {
              headers: { 'Content-Type': 'application/fhir+json' }, timeout: 5000
            });
          })
          .then(() => logger.info(`Observation ${obsId} updated: SOH=${newSoh}`))
          .catch(e => logger.warn(`Observation SOH update failed: ${e.message}`));
      }
    }

    const allOk = [opensrp, dhis, lmis].every(r => r.status === 'fulfilled');
    const eventType = isAdjustment
      ? `adjustment:${answers['adjustmentReason']?.valueCoding?.code}`
      : isReceipt ? 'receipt' : 'dispense';

    logger.info(`QR fan-out in ${Date.now() - t0}ms — type=${eventType} opensrp=${opensrp.status} dhis2=${dhis.status} lmis=${lmis.status}`);

    reply(res, {
      status:  allOk ? 'Successful' : 'Completed with errors',
      type:    eventType,
      results: { opensrp: fmtResult(opensrp), dhis2: fmtResult(dhis), openlmis: fmtResult(lmis) }
    }, allOk ? 200 : 207);
  } catch (err) {
    logger.error(`QR fan-out failed: ${err.message}`);
    reply(res, { status: 'Error', message: err.message }, 500);
  }
});

// HAPI FHIR rest-hook subscription delivers via PUT /:id — delegate to POST handler
router.put('/:id', (req, res, next) => {
  req.body = req.body || {};
  if (!req.body.id && req.params.id) req.body.id = req.params.id;
  req.method = 'POST';
  router.handle(req, res, next);
});

module.exports = router;
