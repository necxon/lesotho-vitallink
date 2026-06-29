/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const logger = require('../logger');
const { CONFIG }              = require('../config/config');
const { PERFORMER_MAP, OU_LABELS, resolveOrderableId, isKnownMedicineCode, canonicalMed } = require('../mappings/mappings');
const { forwardToOpenSRP }    = require('../integrations/opensrp');
const { checkStock, pushToOpenLMIS } = require('../integrations/openlmis');
const { pushToDHIS2, pushSohToDHIS2 } = require('../integrations/dhis2');
const { updateLastSoH }       = require('./poller');
const { syncOrderableToFhir } = require('./fhirLedger');
const { sendNotifications }    = require('./notifications');
const { postLmisNotification } = require('../routes/lmisNotifications');
const runtimeConfig            = require('../config/runtimeConfig');

//TODO: consider adding a periodic refresh for better eventual consistency, and to cover changes made outside the BKM app. For now, the expectation is that mappings and config changes are deployed alongside code changes, so they will be picked up on mediator restarts, but if there are manual changes made in OpenLMIS or DHIS2 that need to be reflected in the mediator's behavior, a restart would be required to pick those up. Adding a periodic refresh (e.g. every hour) could help with that, but would add complexity and load to the system, so it's a tradeoff to consider based on how frequently we expect those external changes to happen and how critical it is for the mediator to pick them up in near real-time.
//TODO: consider adding a "dry run" mode for testing and debugging, where the fan-out logic runs but the actual API calls to OpenSRP/OpenLMIS/DHIS2 are skipped or mocked, so we can verify the behavior without affecting external systems. This could be controlled by an environment variable like FANOUT_DRY_RUN=true, and would be useful for development and staging environments.
//TODO: consider adding more detailed logging and error reporting for the fan-out process, to make it easier to debug issues when they arise. For example, logging the resolved identity and the payloads being sent to each system, as well as any errors that occur during the API calls, could help with troubleshooting. We want to be careful not to log sensitive information, but having more visibility into the fan-out process would be valuable for maintenance and support.

// DHIS2_PUSH_MODE=direct (default): mediator pushes dataValueSets directly to DHIS2 after each event.
// DHIS2_PUSH_MODE=delegation: mediator delegates to the dhis2-integration service (requires that
//   service to be configured with dataset/data-element mappings; not suitable for the ref-distro
//   because dhis2-integration wipes its DB on every restart).
const DHIS2_PUSH_MODE = (process.env.DHIS2_PUSH_MODE || 'direct').toLowerCase();

/** Formats a Promise.allSettled result for the JSON response body. */
function fmtResult(r) {
  if (r.status === 'fulfilled' && r.value?._disabled) return 'disabled';
  return r.status === 'fulfilled'
    ? `HTTP ${r.value.status}`
    : (r.reason?.message || 'unknown error');
}

/**
 * Resolves the LMIS/DHIS2 identity for a given performer + medication code.
 * Falls back to 'default' entries in the maps and then to process.env defaults.
 */
function resolveIdentity(performer, medCode) {
  const performerKnown = performer && Object.prototype.hasOwnProperty.call(PERFORMER_MAP, performer)
                         && performer !== 'default';
  const fromMap  = PERFORMER_MAP[performer] || PERFORMER_MAP['default'];
  const identity = fromMap
    ? { ...fromMap }
    : { facilityId: process.env.OPENLMIS_FACILITY_ID, programId: process.env.OPENLMIS_PROGRAM_ID };

  // Program is the same for every VHW (Essential Medicines); some performer-map entries
  // lack it (programId-blanking drift), leaving identity.programId empty — which makes
  // OpenLMIS stockEvents fail 500. Fall back to the env default so a blank program in the
  // mapping doesn't break the dispense. (facilityId stays per-performer — never defaulted,
  // to avoid mis-routing a dispense to the wrong facility.)
  identity.programId = identity.programId || process.env.OPENLMIS_PROGRAM_ID;

  identity.orderableId    = resolveOrderableId(medCode);
  identity.performerId    = performer;
  // Canonical performer id (a dispense may arrive under an alias, e.g. a Keycloak
  // UUID). Per-VHW allocations are keyed by the canonical sourceId, so allocation
  // checks/deductions must use this — not the raw (possibly-alias) performerId.
  identity.performerCanonical = (fromMap && fromMap._canonical) || performer;
  identity.performerKnown = performerKnown;
  identity.medicineKnown  = isKnownMedicineCode(medCode);
  return identity;
}

/**
 * Runs the full fan-out pipeline for a resolved resource + identity:
 *   1. Stock safety gate (skipped for receipts)
 *   2. Parallel dispatch to OpenSRP + OpenLMIS + DHIS2
 *   3. Update local SOH tracker
 *   4. Fire-and-forget VHW notifications
 *
 * DHIS2 push mode is controlled by DHIS2_PUSH_MODE env var:
 *   direct (default) — mediator pushes dataValueSets directly after each event
 *   delegation       — delegates to dhis2-integration service (requires that service to be configured)
 *
 * Returns { opensrp, dhis, lmis, stock } — all Promise.allSettled results + the
 * stock check result — so the caller can build its HTTP response.
 */
async function executeFanout(resource, identity, isReceipt, {
  qty,
  medCode,
  patient,
  phone,
  email,
  reasonId   = null
} = {}) {
  // BR-07 — Mapping validation gate
  if (runtimeConfig.get('REJECT_UNKNOWN_PERFORMER') === 'true' && !identity.performerKnown) {
    logger.warn(`BR-07: unknown performer "${identity.performerId}" rejected`);
    return { validation: { ok: false, reason: 'unknown-performer', performer: identity.performerId },
             stock: null, opensrp: null, dhis: null, lmis: null };
  }
  if (runtimeConfig.get('REJECT_UNKNOWN_MEDICINE') === 'true' && !identity.medicineKnown) {
    logger.warn(`BR-07: unknown medicine "${identity.orderableId}" rejected`);
    return { validation: { ok: false, reason: 'unknown-medicine', medication: medCode },
             stock: null, opensrp: null, dhis: null, lmis: null };
  }

  // Per-VHW allocation gate — runs only for dispenses (not receipts/adjustments).
  // If the VHW has an allocation row for this medicine+period, the dispense must fit
  // within their remaining budget. With REQUIRE_VHW_ALLOCATION=true, a VHW with no
  // allocation is blocked; otherwise they fall through to the facility SOH check.
  if (!isReceipt) {
    const { checkAllocation } = require('../allocations/allocationStore');
    let alloc = { hasAllocation: false };
    try { alloc = await checkAllocation(identity.performerCanonical, canonicalMed(medCode), qty); }
    catch (e) { logger.warn(`allocation check failed (fail-open): ${e.message}`); }

    // FEFO (option B): if the VHW's allocation specifies a batch, the dispense debits
    // THAT lot (and its per-lot stock is checked) instead of the env-default lot — so
    // the soonest-expiring batch the coordinator allocated actually depletes first.
    if (alloc.hasAllocation && alloc.lotCode) identity.allocationLotCode = alloc.lotCode;

    if (alloc.hasAllocation && !alloc.ok) {
      return { validation: { ok: false, reason: 'insufficient-allocation',
                             allocated: alloc.allocated, dispensed: alloc.dispensed,
                             remaining: alloc.remaining, requested: qty },
               stock: null, opensrp: null, dhis: null, lmis: null };
    }
    if (!alloc.hasAllocation && runtimeConfig.get('REQUIRE_VHW_ALLOCATION') === 'true') {
      logger.warn(`no allocation for "${identity.performerId}" / "${medCode}" — rejected (REQUIRE_VHW_ALLOCATION)`);
      return { validation: { ok: false, reason: 'no-allocation',
                             performer: identity.performerId, medication: medCode },
               stock: null, opensrp: null, dhis: null, lmis: null };
    }
  }

  // Job 3 — Safety Gate (also applied to adjustments — can't adjust more than SOH)
  const enforceStock = runtimeConfig.get('REJECT_DISPENSE_EXCEEDS_STOCK') !== 'false';
  const stock = (isReceipt || !enforceStock) ? { ok: true } : await checkStock(identity, qty);
  if (!stock.ok) {
    return { validation: { ok: true }, stock, opensrp: null, dhis: null, lmis: null };
  }

  // Job 2 — Fan-out to OpenSRP + OpenLMIS + DHIS2 (parallel)
  const opensrpEnabled = runtimeConfig.get('FANOUT_OPENSRP_ENABLED')  !== 'false';
  const dhis2Enabled   = runtimeConfig.get('FANOUT_DHIS2_ENABLED')    !== 'false';
  const lmisEnabled    = runtimeConfig.get('FANOUT_OPENLMIS_ENABLED') !== 'false';

  const DISABLED = { _disabled: true };

  let dhisPromise;
  if (!dhis2Enabled) {
    dhisPromise = Promise.resolve(DISABLED);
  } else if (DHIS2_PUSH_MODE === 'direct') {
    dhisPromise = pushToDHIS2(resource, null, identity);
  } else {
    dhisPromise = Promise.resolve({ status: 'delegated-to-dhis2-integration' });
  }

  const [opensrp, lmis, dhis] = await Promise.allSettled([
    opensrpEnabled ? forwardToOpenSRP(resource, identity)                    : Promise.resolve(DISABLED),
    lmisEnabled    ? pushToOpenLMIS(resource, identity, isReceipt, reasonId) : Promise.resolve(DISABLED),
    dhisPromise
  ]);

  const lmisOk = lmis.status === 'fulfilled' && !lmis.value?._disabled;

  // After a successful eLMIS event, push the authoritative SOH to DHIS2 (direct mode only)
  if (DHIS2_PUSH_MODE === 'direct' && dhis2Enabled && lmisOk) {
    pushSohToDHIS2(identity, { triggeredBy: isReceipt ? 'receipt' : 'dispense' })
      .catch(() => {}); // fail-open — pushSohToDHIS2 already logs internally
  }

  // Update local SOH tracker (non-blocking)
  if (lmisOk) {
    updateLastSoH(isReceipt ? qty : -qty);
    syncOrderableToFhir(identity, medCode).catch(() => {}); // fail-open
  }

  // Per-VHW allocation: deduct the dispensed amount from the VHW's budget (non-blocking).
  if (lmisOk && !isReceipt) {
    const { recordDispense } = require('../allocations/allocationStore');
    recordDispense(identity.performerCanonical, canonicalMed(medCode), qty).catch(() => {}); // no-op if no allocation row
  }

  // Job 4 — VHW Notifications (non-blocking)
  if (lmisOk) {
    const threshold = parseInt(runtimeConfig.get('NOTIFY_LOW_STOCK_THRESHOLD') || '20', 10);
    const eventsToNotify = [];

    if (!isReceipt && runtimeConfig.get('NOTIFY_ON_DISPENSE') === 'true') {
      eventsToNotify.push({ type: 'dispense', qty, medication: medCode, patient });
    }
    if (isReceipt && runtimeConfig.get('NOTIFY_ON_RECEIPT') === 'true') {
      eventsToNotify.push({ type: 'receipt', qty, medication: medCode, patient });
    }
    if (!isReceipt && runtimeConfig.get('NOTIFY_ON_LOW_STOCK') === 'true' && stock.stockOnHand !== undefined) {
      const newSoh = stock.stockOnHand - qty;
      if (newSoh < threshold) {
        eventsToNotify.push({ type: 'low-stock', medication: medCode, newSoh, threshold });
      }
    }

    if (eventsToNotify.length > 0) {
      sendNotifications(eventsToNotify, phone, email)
        .catch(e => logger.warn(`Notification batch failed: ${e.message}`));
    }

    // OpenLMIS in-app bell notifications (always fire on success — for facility staff)
    // Build VHW / location context suffix: "Thabo Mokoena · Ha Mokoena (Maseru District)"
    const vhwInfo   = identity.performerId ? PERFORMER_MAP[identity.performerId] : null;
    const vhwName   = vhwInfo?.name || null;
    const ouLabel   = vhwInfo?.dhis2OrgUnit ? OU_LABELS[vhwInfo.dhis2OrgUnit] : null;
    let   locSuffix = '';
    if (vhwName && ouLabel) {
      locSuffix = ` — ${vhwName} · ${ouLabel.village} (${ouLabel.region})`;
    } else if (vhwName) {
      locSuffix = ` — ${vhwName}`;
    } else if (ouLabel) {
      locSuffix = ` — ${ouLabel.village} (${ouLabel.region})`;
    }

    if (!isReceipt && runtimeConfig.get('NOTIFY_LMIS_ON_DISPENSE') !== 'false') {
      postLmisNotification(
        'Stock Dispensed',
        `${qty} unit${qty !== 1 ? 's' : ''} of ${medCode} dispensed` +
          (patient ? ` to ${patient}` : '') + locSuffix
      );
    } else if (isReceipt && runtimeConfig.get('NOTIFY_LMIS_ON_RECEIPT') !== 'false') {
      postLmisNotification(
        'Stock Received',
        `${qty} unit${qty !== 1 ? 's' : ''} of ${medCode} received at facility` + locSuffix
      );
    }
    if (!isReceipt && runtimeConfig.get('NOTIFY_LMIS_ON_LOW_STOCK') !== 'false' && stock.stockOnHand !== undefined) {
      const threshold = parseInt(runtimeConfig.get('NOTIFY_LOW_STOCK_THRESHOLD') || '20', 10);
      const newSoh = stock.stockOnHand - qty;
      if (newSoh < threshold) {
        postLmisNotification(
          '⚠ Low Stock Alert',
          `${medCode} stock on hand is ${newSoh} unit${newSoh !== 1 ? 's' : ''} — ` +
            `below threshold of ${threshold}. Consider requesting resupply.` + locSuffix
        );
      }
    }
  }

  return { validation: { ok: true }, stock, opensrp, dhis, lmis };
}

module.exports = { executeFanout, resolveIdentity, fmtResult };
