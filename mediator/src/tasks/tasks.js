/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const axios  = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { resolveOrderableName } = require('../mappings/mappings');

/**
 * Creates a FHIR Task on HAPI FHIR.
 * taskType: 'stock-issue' (default, for VHWs) | 'facility-receipt' (for facility workers to accept delivery)
 */
async function createStockTask({ performer, medication, quantity, issueRef, taskId, taskType }) {
  const id          = taskId || `task-stock-${Date.now()}`;
  const ref         = performer.includes('/') ? performer : `Practitioner/${performer}`;
  const medDisplay  = resolveOrderableName(medication) || medication;
  const isFwReceipt = taskType === 'facility-receipt';

  const input = [
    { type: { text: 'product'  }, valueString:  medDisplay },
    { type: { text: 'quantity' }, valueInteger: quantity   },
    { type: { text: 'issueRef' }, valueString:  issueRef || id }
  ];

  if (isFwReceipt) {
    input.push({
      type:           { coding: [{ system: 'http://hl7.org/fhir/uv/sdc/CodeSystem/temp', code: 'questionnaire' }] },
      valueReference: { reference: 'Questionnaire/qn-stock-accept-delivery' }
    });
  }

  const task = {
    resourceType: 'Task',
    id,
    status: 'requested',
    intent: 'order',
    code: { coding: [{ system: 'http://snomed.info/sct', code: '373748001', display: 'Stock Issue' }] },
    description: isFwReceipt
      ? `Accept delivery: ${medDisplay} — ${quantity} units (ref: ${issueRef || id})`
      : `${medDisplay} — ${quantity} units (ref: ${issueRef || id})`,
    for:        { reference: ref },
    owner:      { reference: ref },
    authoredOn: new Date().toISOString(),
    input,
  };

  const res = await axios.put(`${CONFIG.fhir.url}/Task/${id}`, task, {
    headers: { 'Content-Type': 'application/fhir+json' },
    timeout: TIMEOUT_MS
  });
  logger.info(`Stock Task created: Task/${id} for ${performer} — ${medication} x${quantity}`);
  return res.data;
}

/** Fetches a Task from HAPI FHIR. Returns null on 404/410 (not found or deleted). */
async function fetchStockTask(taskId) {
  try {
    const res = await axios.get(`${CONFIG.fhir.url}/Task/${taskId}`, { timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    const s = err.response?.status;
    if (s === 404 || s === 410) return null;
    throw err;
  }
}

/** Marks a stock acceptance Task as completed. Fail-open. */
async function completeStockTask(taskId) {
  try {
    const task = await fetchStockTask(taskId);
    if (!task) { logger.warn(`completeStockTask: Task/${taskId} not found`); return; }
    task.status       = 'completed';
    task.lastModified = new Date().toISOString();
    await axios.put(`${CONFIG.fhir.url}/Task/${taskId}`, task, {
      headers: { 'Content-Type': 'application/fhir+json' },
      timeout: TIMEOUT_MS
    });
    logger.info(`Stock Task completed: Task/${taskId}`);
  } catch (err) {
    logger.warn(`completeStockTask failed (non-fatal): ${err.message}`);
  }
}

/**
 * After a facility worker accepts stock, creates one Task per VHW at the same
 * facility so they see the pending stock on their next Android sync.
 * Returns an array of practitioner IDs for which Tasks were created.
 */
async function createVhwTasksForFacility({ facilityWorkerId, medication, qty, issueRef, period }) {
  const { PERFORMER_MAP } = require('../mappings/mappings');

  const fwEntry = PERFORMER_MAP[facilityWorkerId]
    || PERFORMER_MAP[`Practitioner/${facilityWorkerId}`];
  if (!fwEntry) {
    logger.warn(`createVhwTasksForFacility: ${facilityWorkerId} not in PERFORMER_MAP`);
    return [];
  }

  const facilityId = fwEntry.facilityId;
  const vhws = Object.entries(PERFORMER_MAP)
    .filter(([id, m]) => id !== 'default' && m.role !== 'facility_worker' && m.facilityId === facilityId);

  if (vhws.length === 0) {
    logger.warn(`createVhwTasksForFacility: no VHWs for facilityId=${facilityId}`);
    return [];
  }

  const p = period || new Date().toISOString().slice(0, 7).replace('-', '');
  const created = [];

  for (const [practId] of vhws) {
    const shortOid   = medication.replace(/[^a-z0-9]/gi, '').slice(-8);
    const shortPract = practId.replace(/[^a-z0-9]/gi, '').slice(-8);
    const taskId = `task-vhw-${p}-${shortOid}-${shortPract}`;
    try {
      await createStockTask({
        performer:  practId,
        medication,
        quantity:   qty,
        issueRef:   issueRef || `FW-RCPT-${p}`,
        taskId,
      });
      created.push(practId);
    } catch (err) {
      logger.warn(`createVhwTasksForFacility: task failed for ${practId}: ${err.message}`);
    }
  }
  logger.info(`VHW Tasks created after facility acceptance: facility=${facilityId} medicine=${medication} qty=${qty} created=${created.length}`);
  return created;
}

/**
 * Creates an on-hold FHIR Task representing a VHW stock order awaiting approval.
 * Uses a deterministic taskId so multiple orders in the same period are idempotent (PUT updates qty).
 */
async function createOnHoldTask({ performer, medication, quantity, taskId }) {
  const id         = taskId || `task-ord-${Date.now()}`;
  const ref        = performer.includes('/') ? performer : `Practitioner/${performer}`;
  const medDisplay = resolveOrderableName(medication) || medication;

  const task = {
    resourceType: 'Task',
    id,
    status: 'on-hold',
    intent: 'order',
    code: { coding: [{ system: 'http://snomed.info/sct', code: '373748001', display: 'Stock Order' }] },
    description: `Awaiting approval: ${medDisplay} — ${quantity} units`,
    for:        { reference: ref },
    owner:      { reference: ref },
    authoredOn: new Date().toISOString(),
    input: [
      { type: { text: 'product'  }, valueString:  medDisplay },
      { type: { text: 'quantity' }, valueInteger: quantity   },
    ],
  };

  const res = await axios.put(`${CONFIG.fhir.url}/Task/${id}`, task, {
    headers: { 'Content-Type': 'application/fhir+json' },
    timeout: TIMEOUT_MS
  });
  logger.info(`On-hold order Task created: Task/${id} for ${performer} — ${medication} x${quantity}`);
  return res.data;
}

async function _transitionOrderTasks(orderableId, period, fromStatus, toStatus) {
  const prefix = `task-ord-${period}-${orderableId.replace(/-/g, '').slice(-8)}-`;
  try {
    const res   = await axios.get(`${CONFIG.fhir.url}/Task`, { params: { status: fromStatus, _count: 50 }, timeout: TIMEOUT_MS });
    const tasks = (res.data.entry || []).map(e => e.resource).filter(t => t?.id?.startsWith(prefix));
    for (const task of tasks) {
      task.status       = toStatus;
      task.lastModified = new Date().toISOString();
      await axios.put(`${CONFIG.fhir.url}/Task/${task.id}`, task, { headers: { 'Content-Type': 'application/fhir+json' }, timeout: TIMEOUT_MS });
      logger.info(`Order Task ${fromStatus}→${toStatus}: Task/${task.id}`);
    }
    if (tasks.length) logger.info(`_transitionOrderTasks: ${tasks.length} task(s) orderable=${orderableId} period=${period}`);
  } catch (err) {
    logger.warn(`_transitionOrderTasks failed (non-fatal): ${err.message}`);
  }
}

/** Transitions on-hold order Tasks to in-progress (dispatched). */
function approveOrderTasks(orderableId, period) {
  return _transitionOrderTasks(orderableId, period, 'on-hold', 'in-progress');
}

/** Completes all in-progress order tasks after FW acceptance. */
function completeOrderTasksForOrderable(orderableId, period) {
  return _transitionOrderTasks(orderableId, period, 'in-progress', 'completed');
}

module.exports = { createStockTask, fetchStockTask, completeStockTask, createVhwTasksForFacility, createOnHoldTask, approveOrderTasks, completeOrderTasksForOrderable };
