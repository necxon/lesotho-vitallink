/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const axios         = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger        = require('../logger');
const { getOpenLMISToken, withOpenLMISToken } = require('../tokens');
const runtimeConfig = require('../config/runtimeConfig');
const { pool }      = require('../db');

const SOH_LEGACY_KEY = '__legacy__'; // row key for the single-orderable _lastSoH tracker

// How many events to collect per poll (configurable on the Settings page).
function pollBatchSize() {
  const n = parseInt(runtimeConfig.get('POLL_BATCH_SIZE') || '50', 10);
  return (n >= 1 && n <= 1000) ? n : 50;
}

async function _loadSohFromDb() {
  try {
    const { rows } = await pool.query('SELECT orderable_id, soh FROM soh_tracker');
    return Object.fromEntries(rows.map(r => [r.orderable_id, r.soh]));
  } catch (err) {
    logger.warn(`soh_tracker load failed (non-fatal): ${err.message}`);
    return {};
  }
}

async function _saveSohToDb(orderableId, soh) {
  try {
    await pool.query(
      `INSERT INTO soh_tracker (orderable_id, soh, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (orderable_id) DO UPDATE SET soh = $2, updated_at = NOW()`,
      [orderableId, soh]
    );
  } catch (err) {
    logger.warn(`soh_tracker save failed (non-fatal): ${err.message}`);
  }
}

// ── HAPI FHIR stock-order QR poller ──────────────────────────────────────────
// Polls HAPI FHIR every 30 s for new stock-order QuestionnaireResponses and
// forwards them directly to the mediator's /fhir/QuestionnaireResponse handler
// so the order fan-out fires without relying on the fhir-proxy mirror.

const HAPI_URL       = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
const QR_STOCK_Q     = process.env.QR_STOCK_QUESTIONNAIRE   || 'a3b8260b-d474-42ef-9ab2-a7794a0a27bc';
const QR_DISPENSE_Q  = process.env.QR_DISPENSE_QUESTIONNAIRE || 'd5e6f708-1a2b-3c4d-5e6f-7a8b9c0d1e2f';
const QR_ORDER_Q     = process.env.QR_ORDER_QUESTIONNAIRE    || 'e1f2a3b4-c5d6-7e8f-9a0b-c1d2e3f4a5b6';
const QR_ACCEPT_Q    = process.env.QR_ACCEPT_QUESTIONNAIRE   || 'qn-stock-accept-delivery';
const QR_PROCESSED_SYSTEM = 'http://mediator/tags';
const QR_PROCESSED_CODE   = 'mediator-processed';
let _lastQrCheck = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // look back 24 h on first run — catches unprocessed QRs after restart

async function _forwardQr(qr) {
  let permanent = false;
  try {
    await axios.post('http://localhost:3000/fhir/QuestionnaireResponse', qr, {
      headers: { 'Content-Type': 'application/fhir+json' },
      timeout: TIMEOUT_MS
    });
    permanent = true; // success — tag
  } catch (err) {
    const status = err.response?.status;
    if (status && status < 500) {
      // 4xx = permanent failure (deleted task, already-accepted, bad QR) — tag to skip future retries
      logger.warn(`QR forward permanent failure (HTTP ${status}): id=${qr.id} — tagging to prevent retry`);
      permanent = true;
    }
    // 5xx or network error = transient — leave untagged so next poll retries
    if (!permanent) throw err;
  }
  // Tag so we never re-process across restarts
  if (qr.id && permanent) {
    await axios.post(`${HAPI_URL}/QuestionnaireResponse/${qr.id}/$meta-add`, {
      resourceType: 'Parameters',
      parameter: [{ name: 'meta', valueMeta: {
        tag: [{ system: QR_PROCESSED_SYSTEM, code: QR_PROCESSED_CODE }]
      }}]
    }, { headers: { 'Content-Type': 'application/fhir+json' }, timeout: TIMEOUT_MS }).catch(() => {});
  }
}

async function _pollQuestionnaire(questionnaireId, label) {
  const res = await axios.get(`${HAPI_URL}/QuestionnaireResponse`, {
    params: {
      questionnaire:  `Questionnaire/${questionnaireId}`,
      _sort:          '_lastUpdated',
      _lastUpdated:   `gt${_lastQrCheck}`,
      '_tag:not':     `${QR_PROCESSED_SYSTEM}|${QR_PROCESSED_CODE}`,
      _count:         pollBatchSize()
    },
    timeout: TIMEOUT_MS
  });
  const entries = res.data.entry || [];
  if (!entries.length) return 0;
  logger.info(`HAPI QR poll [${label}]: found ${entries.length} new QR(s)`);
  for (const e of entries) {
    const qr = e.resource;
    if (!qr?.item?.length) continue;
    try { await _forwardQr(qr); }
    catch (err) { logger.error(`HAPI QR poll dispatch error [${label}]: ${err.message}`); }
  }
  return entries.length;
}

async function pollHapiFhirOrders() {
  try {
    const ts = new Date().toISOString();
    const n1 = await _pollQuestionnaire(QR_STOCK_Q,    'stock-order');
    const n2 = await _pollQuestionnaire(QR_DISPENSE_Q, 'dispense');
    const n3 = await _pollQuestionnaire(QR_ORDER_Q,    'order-request');
    const n4 = await _pollQuestionnaire(QR_ACCEPT_Q,   'accept-delivery');
    if (n1 + n2 + n3 + n4 > 0) _lastQrCheck = ts;
  } catch (err) {
    logger.warn(`HAPI QR poll failed (non-fatal): ${err.message}`);
  }
}

// Local SOH tracker — kept in sync by the fan-out routes and the poll loop
// so the poller can detect out-of-band receipts without false positives.
// Seeded from Postgres on first use; written back on every change.
let _lastSoH = null;
let _sohLoaded = false;

async function _ensureSohLoaded() {
  if (_sohLoaded) return;
  _sohLoaded = true;
  const stored = await _loadSohFromDb();
  if (stored[SOH_LEGACY_KEY] !== undefined) {
    _lastSoH = stored[SOH_LEGACY_KEY];
    logger.info(`soh_tracker: restored _lastSoH=${_lastSoH} from Postgres`);
  }
}

/** Called by fanout after a successful eLMIS stock event to keep _lastSoH in sync. */
function updateLastSoH(delta) {
  if (_lastSoH !== null) {
    _lastSoH += delta;
    _saveSohToDb(SOH_LEGACY_KEY, _lastSoH);
  }
}

async function pollStockLevels() {
  const facilityId  = process.env.OPENLMIS_FACILITY_ID;
  const programId   = process.env.OPENLMIS_PROGRAM_ID;
  const orderableId = process.env.OPENLMIS_ORDERABLE_ID;
  if (!facilityId || !programId || !orderableId) return;

  try {
    const res = await withOpenLMISToken(t => axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params:  { facility: facilityId, program: programId, orderable: orderableId },
      headers: { Authorization: `Bearer ${t}` },
      timeout: TIMEOUT_MS
    }));

    const content = res.data.content || [];
    if (content.length === 0) return;
    const currentSoH = content[0].stockOnHand;

    await _ensureSohLoaded();
    if (_lastSoH === null) { _lastSoH = currentSoH; _saveSohToDb(SOH_LEGACY_KEY, currentSoH); return; }

    const delta = currentSoH - _lastSoH;
    if (delta > 0) {
      logger.info(`Stock receipt detected via poll: SOH ${_lastSoH} → ${currentSoH} (+${delta})`);
      const deReceived = process.env.DHIS2_DE_STOCK_RECEIVED;
      if (deReceived) {
        await axios.post(`${CONFIG.dhis2.url}/api/dataValueSets`, {
          dataValues: [{
            dataElement: deReceived,
            orgUnit:     process.env.DHIS2_ORG_UNIT || 'dwx1Yz4BwNX',
            period:      new Date().toISOString().slice(0, 7).replace('-', ''),
            value:       String(delta)
          }]
        }, { auth: { username: CONFIG.dhis2.user, password: CONFIG.dhis2.pass }, timeout: TIMEOUT_MS });
        logger.info(`Stock receipt synced to DHIS2: ${delta} units → ${deReceived}`);
      }
    } else if (delta < 0) {
      logger.info(`Out-of-band dispense via poll: SOH ${_lastSoH} → ${currentSoH} (${delta})`);
    }
    _lastSoH = currentSoH;
    _saveSohToDb(SOH_LEGACY_KEY, currentSoH);
  } catch (err) {
    logger.warn(`Stock poll failed (non-fatal): ${err.message}`);
  }
}

// ── OpenLMIS → HAPI FHIR Task fan-out for VHWs ───────────────────────────────
// Polls stockCardSummaries for ALL medicines. When SOH increases and the rise
// is NOT explained by a recent mediator dispatch (which already creates Tasks),
// creates a deterministic FHIR Task per VHW so the Android app shows the pending
// stock acceptance on the next sync.

const _lastSoHByOrderable = {};
let _sohByOrderableLoaded = false;
const DISPATCH_GRACE_MS   = 5 * 60 * 1000; // ignore SOH rises within 5 min of our dispatch
let _lastCreditTs = 0; // updated whenever the mediator itself posts a CREDIT to OpenLMIS

function notifyReceipt() { _lastCreditTs = Date.now(); }

async function _ensureSohByOrderableLoaded() {
  if (_sohByOrderableLoaded) return;
  _sohByOrderableLoaded = true;
  const stored = await _loadSohFromDb();
  for (const [k, v] of Object.entries(stored)) {
    if (k !== SOH_LEGACY_KEY) _lastSoHByOrderable[k] = v;
  }
  const count = Object.keys(_lastSoHByOrderable).length;
  if (count > 0) logger.info(`soh_tracker: restored ${count} orderable SOH entries from Postgres`);
}

async function pollLmisForVhwTasks() {
  if (runtimeConfig.get('VHW_TASK_POLL_ENABLED') === 'false') return;

  const facilityId = process.env.OPENLMIS_FACILITY_ID;
  const programId  = process.env.OPENLMIS_PROGRAM_ID;
  if (!facilityId || !programId) return;

  await _ensureSohByOrderableLoaded();

  // Determine whether tasks should be suppressed (our own dispatch/credit is the cause).
  // We still fetch and update the baseline regardless — otherwise the stale baseline
  // causes a false-positive spike when the grace window finally expires.
  const { getLastDispatchTs } = require('../orders/orderBuffer');
  const suppressTasks =
    Date.now() - getLastDispatchTs() < DISPATCH_GRACE_MS ||
    Date.now() - _lastCreditTs       < DISPATCH_GRACE_MS;

  try {
    const res = await withOpenLMISToken(t => axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
      params:  { facility: facilityId, program: programId },
      headers: { Authorization: `Bearer ${t}` },
      timeout: TIMEOUT_MS
    }));

    const period  = new Date().toISOString().slice(0, 7).replace('-', '');
    const raw = res.data.content || [];

    // Aggregate by orderable — OpenLMIS may return multiple stock-card entries
    // for the same orderable (one per lot/receipt batch). Sum them so the loop
    // sees a single stable total per orderable instead of spurious card-level swings.
    const byOrderable = new Map();
    for (const item of raw) {
      const id = item.orderable?.id;
      if (!id || item.stockOnHand == null) continue;
      byOrderable.set(id, (byOrderable.get(id) || 0) + item.stockOnHand);
    }
    const content = Array.from(byOrderable.entries()).map(([orderableId, stockOnHand]) => ({ orderable: { id: orderableId }, stockOnHand }));

    for (const item of content) {
      const orderableId = item.orderable?.id;
      const currentSoH  = item.stockOnHand;
      if (!orderableId || currentSoH === undefined || currentSoH === null) continue;

      const prevSoH = _lastSoHByOrderable[orderableId];
      // Always update baseline so the next cycle has an accurate reference point.
      _lastSoHByOrderable[orderableId] = currentSoH;
      _saveSohToDb(orderableId, currentSoH);
      if (prevSoH === undefined) continue; // first observation — baseline only

      const delta = currentSoH - prevSoH;
      if (delta <= 0) continue;

      if (suppressTasks) {
        logger.debug(`VHW task poll: SOH +${delta} for orderable=${orderableId} within grace window — baseline updated, task creation suppressed`);
        continue;
      }

      logger.info(`External receipt detected: orderable=${orderableId} SOH +${delta} (${prevSoH}→${currentSoH})`);
      await _createFacilityReceiptTasks(orderableId, delta, period);
    }
  } catch (err) {
    logger.warn(`VHW task poll failed (non-fatal): ${err.message}`);
  }
}

// Creates Tasks for facility workers on out-of-band OpenLMIS SOH rises.
// Falls back to all practitioners if no facility_worker role is defined yet.
async function _createFacilityReceiptTasks(orderableId, qty, period) {
  const { PERFORMER_MAP }   = require('../mappings/mappings');
  const { createStockTask } = require('../tasks/tasks');

  const all             = Object.entries(PERFORMER_MAP).filter(([k]) => k !== 'default');
  const facilityWorkers = all.filter(([, m]) => m.role === 'facility_worker');
  const targets         = facilityWorkers.length ? facilityWorkers : all;

  if (targets.length === 0) return;

  const shortOid = orderableId.replace(/-/g, '').slice(-8);
  let created = 0;

  for (const [practId] of targets) {
    const shortPract = practId.replace(/[^a-z0-9]/gi, '').slice(-8);
    // Deterministic ID → PUT is idempotent; safe to call multiple times per period
    const taskId = `task-rcpt-${period}-${shortOid}-${shortPract}`;
    try {
      await createStockTask({
        performer:  practId,
        medication: orderableId,
        quantity:   qty,
        issueRef:   `LMIS-RCPT-${period}`,
        taskId,
      });
      created++;
    } catch (err) {
      logger.warn(`Facility receipt task failed: pract=${practId} orderable=${orderableId} err=${err.message}`);
    }
  }
  logger.info(`Facility receipt tasks: orderable=${orderableId} qty=${qty} period=${period} created=${created}`);
}

// ── HAPI FHIR MedicationDispense poller ──────────────────────────────────────
// Polls HAPI FHIR for completed MedicationDispenses synced by the Android app
// and fans them out to OpenLMIS + DHIS2.  Resources are tagged after dispatch
// so the mediator never double-processes them across restarts.

const PROCESSED_TAG_SYSTEM = 'http://mediator/tags';
const PROCESSED_TAG_CODE   = 'mediator-processed';
let _lastDispenseCheck = new Date(Date.now() - 60_000).toISOString();

async function pollHapiFhirDispenses() {
  if (runtimeConfig.get('DISPENSE_POLL_ENABLED') === 'false') return;

  try {
    const res = await axios.get(`${HAPI_URL}/MedicationDispense`, {
      params: {
        status:       'completed',
        _sort:        '_lastUpdated',
        _lastUpdated: `gt${_lastDispenseCheck}`,
        '_tag:not':   `${PROCESSED_TAG_SYSTEM}|${PROCESSED_TAG_CODE}`,
        _count:       pollBatchSize()
      },
      timeout: TIMEOUT_MS
    });

    const entries = res.data.entry || [];
    if (!entries.length) return;

    logger.info(`HAPI dispense poll: ${entries.length} unprocessed MedicationDispense(s)`);
    _lastDispenseCheck = new Date().toISOString();

    const { executeFanout, resolveIdentity } = require('./fanout');
    const receiptCode = process.env.RECEIPT_TYPE_CODE || 'RECEIPT';

    const _tagProcessed = (id) => axios.post(
      `${HAPI_URL}/MedicationDispense/${id}/$meta-add`,
      { resourceType: 'Parameters', parameter: [{ name: 'meta', valueMeta: {
        tag: [{ system: PROCESSED_TAG_SYSTEM, code: PROCESSED_TAG_CODE }]
      }}]},
      { headers: { 'Content-Type': 'application/fhir+json' }, timeout: TIMEOUT_MS }
    ).catch(() => {});

    for (const e of entries) {
      const resource  = e.resource;
      const performer = resource.performer?.[0]?.actor?.reference;
      const medCode   = resource.medicationCodeableConcept?.coding?.[0]?.code;
      const qty       = resource.quantity?.value || 0;
      const isReceipt = resource.type?.coding?.some(c => c.code === receiptCode) ?? false;

      if (!performer) {
        logger.warn(`Dispense poll: skipping id=${resource.id} — MedicationDispense has no performer (created outside bundleSync)`);
        await _tagProcessed(resource.id);
        continue;
      }

      try {
        const identity = resolveIdentity(performer, medCode);
        if (!identity.facilityId || !identity.orderableId) {
          logger.warn(`Dispense poll: permanently skipping id=${resource.id} — no mapping (performer=${performer} med=${medCode})`);
          await _tagProcessed(resource.id); // prevent repeat warnings on every cycle
          continue;
        }

        const { validation, stock } = await executeFanout(resource, identity, isReceipt, {
          qty,
          medCode,
          patient:     resource.subject?.reference || 'unknown',
          triggeredBy: `HAPI-POLL-${resource.id || 'unknown'}`
        });

        if (!validation.ok) {
          // Permanent failure (e.g. unknown-performer) — tag so it doesn't repeat
          logger.warn(`Dispense poll: permanently skipping id=${resource.id} — ${JSON.stringify(validation)}`);
          await _tagProcessed(resource.id);
          continue;
        }
        if (!stock?.ok) {
          // Transient failure (e.g. insufficient stock) — leave untagged so it retries
          logger.warn(`Dispense poll: transient rejection id=${resource.id} — ${JSON.stringify(stock)}`);
          continue;
        }

        // Mark as processed so it's never re-dispatched after a mediator restart
        await _tagProcessed(resource.id);
        logger.info(`Dispense poll: dispatched id=${resource.id} performer=${performer} med=${medCode} qty=${qty}`);
      } catch (err) {
        logger.error(`Dispense poll: error id=${resource.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`Dispense poll failed (non-fatal): ${err.message}`);
  }
}

module.exports = { pollStockLevels, updateLastSoH, pollHapiFhirOrders, pollLmisForVhwTasks, pollHapiFhirDispenses, notifyReceipt };
