/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

// Live FHIR stock ledger.
//
// Mirrors OpenLMIS stock-on-hand into HAPI FHIR Observations so the
// "Stock by Facility" view (bkm-web/js/pages/fhir-browser.js) reflects current
// state rather than frozen seed values. Each (Group × Organization) gets one
// preliminary Observation that is upserted on every successful OpenLMIS write.
//
// HAPI_FACILITY_MAP env: JSON map from OpenLMIS facilityId -> HAPI Organization
// reference (e.g. "Organization/maseru-clinic-a"). When unset, the configured
// OPENLMIS_FACILITY_ID is mapped to HAPI_DEFAULT_ORGANIZATION_REF (default
// "Organization/maseru-clinic-a") so the single-facility demo works out of the box.

//TODO: add a periodic refresh for better eventual consistency, and to cover changes made outside the BKM app.  
//TODO: consider seeding Group resources in HAPI from the OpenLMIS catalog instead of relying on name matching; that would be more robust but require more setup and maintenance.
//TODO: consider caching the Group ID <-> name mapping in memory, refreshing it periodically since Groups are rarely changed.
//TODO: consider caching the orderableId -> fullProductName mapping to avoid repeated /api/orderables/{id} calls for the same meds.
//TODO: consider upserting Observations on a schedule instead of on every write, to reduce load and avoid hitting HAPI rate limits when many writes happen in a short time. 


const axios = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { withOpenLMISToken } = require('../tokens');
const { MEDICATION_MAP, LMIS_ORDERABLE_MAP } = require('../mappings/mappings');
const runtimeConfig = require('../config/runtimeConfig');

const HAPI = CONFIG.fhir.url;
const FHIR_JSON = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' };

function parseFacilityMap() {
  let map = {};
  try { map = JSON.parse(process.env.HAPI_FACILITY_MAP || '{}'); } catch (_) { map = {}; }
  if (Object.keys(map).length === 0) {
    const defaultId  = process.env.OPENLMIS_FACILITY_ID;
    const defaultOrg = process.env.HAPI_DEFAULT_ORGANIZATION_REF || 'Organization/maseru-clinic-a';
    if (defaultId) map[defaultId] = defaultOrg;
  }
  return map;
}

const FACILITY_MAP = parseFacilityMap();

// HAPI Group lookup is cached by name — Groups are seeded once and rarely change.
let _groupCache = null;
let _groupCacheLoadedAt = 0;
let _groupCacheFailedAt = 0;
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const GROUP_CACHE_FAIL_BACKOFF_MS = 30 * 1000;

async function loadGroupCache() {
  const now = Date.now();
  if (_groupCache && now - _groupCacheLoadedAt < GROUP_CACHE_TTL_MS) return _groupCache;
  // Backoff after a failure so a burst of lookups (e.g. init walking N orderables)
  // doesn't fan out into N×candidates hits against an unreachable HAPI.
  if (now - _groupCacheFailedAt < GROUP_CACHE_FAIL_BACKOFF_MS) return _groupCache || {};
  try {
    const r = await axios.get(`${HAPI}/Group`, { params: { type: 'device', _count: 200 }, timeout: TIMEOUT_MS });
    const map = {};
    (r.data.entry || []).forEach(e => {
      const name = e.resource && e.resource.name;
      if (name) map[name] = e.resource.id;
    });
    _groupCache = map;
    _groupCacheLoadedAt = now;
    _groupCacheFailedAt = 0;
    return map;
  } catch (e) {
    _groupCacheFailedAt = now;
    logger.warn(`fhirLedger: Group cache load failed (backing off ${GROUP_CACHE_FAIL_BACKOFF_MS / 1000}s): ${e.message}`);
    return _groupCache || {};
  }
}

async function findGroupIdByName(name) {
  if (!name) return null;
  const cache = await loadGroupCache();
  return cache[name] || null;
}

function lookupMedNameByOrderableId(orderableId) {
  for (const [name, id] of Object.entries(MEDICATION_MAP || {})) {
    if (id === orderableId) return name;
  }
  const fromLmis = LMIS_ORDERABLE_MAP || {};
  for (const [normalised, id] of Object.entries(fromLmis)) {
    if (id === orderableId) return normalised;
  }
  return null;
}

// Deterministic Observation ID per (Group × Organization). PUTting to a fixed
// ID is idempotent — no read-then-create race window, so parallel calls during
// init (e.g. AL-20-120 + Oxytocin 10 IU resolving to the same Group) can't
// create duplicate rows.
function ledgerObsId(groupId, orgRef) {
  const orgKey = String(orgRef).replace(/[^A-Za-z0-9-]/g, '-');
  return `stock-${groupId}-${orgKey}`.slice(0, 64); // HAPI accepts up to 64 chars
}

function buildObservation(groupId, orgRef, balance, occurredAt) {
  return {
    resourceType: 'Observation',
    id: ledgerObsId(groupId, orgRef),
    status: 'preliminary',
    code: { text: 'Stock on hand' },
    subject: { reference: `Group/${groupId}` },
    performer: [{ reference: orgRef }],
    effectiveDateTime: occurredAt || new Date().toISOString(),
    component: [{
      code: { text: 'Balance' },
      valueQuantity: { value: balance, unit: 'units' },
    }],
  };
}

async function upsertObservation(groupId, orgRef, balance) {
  const body = buildObservation(groupId, orgRef, balance);
  try {
    await axios.put(`${HAPI}/Observation/${body.id}`, body, { timeout: TIMEOUT_MS, headers: FHIR_JSON });
    return true;
  } catch (e) {
    logger.warn(`fhirLedger: upsert failed (Group/${groupId} @ ${orgRef}): ${e.message}`);
    return false;
  }
}

// Auto-create the medicine's stock Group (type=device) when one doesn't exist yet,
// so a newly-added OpenLMIS product shows up in the Stock-by-Facility view without
// manual setup. Shape mirrors the seeded device Groups (SNOMED "Supply management").
async function createMedicineGroup(name, code) {
  const group = {
    resourceType: 'Group',
    active: true,
    type:   'device',
    actual: false,
    code:   { coding: [{ system: 'http://snomed.info/sct', code: '386452003', display: 'Supply management' }] },
    name,
    ...(code ? { identifier: [{ use: 'secondary', value: code }] } : {}),
  };
  try {
    const r  = await axios.post(`${HAPI}/Group`, group, { timeout: TIMEOUT_MS, headers: FHIR_JSON });
    const id = r.data && r.data.id;
    if (id) {
      if (_groupCache) _groupCache[name] = id; // keep cache in sync so we don't recreate
      logger.info(`fhirLedger: auto-created stock Group "${name}" (${id})`);
    }
    return id || null;
  } catch (e) {
    logger.warn(`fhirLedger: auto-create Group "${name}" failed: ${e.message}`);
    return null;
  }
}

// orderableId -> fullProductName (cached; OpenLMIS orderable names are static)
const _orderableNameCache = {};
async function fetchOpenLmisOrderableName(orderableId) {
  if (_orderableNameCache[orderableId] !== undefined) return _orderableNameCache[orderableId];
  try {
    const res = await withOpenLMISToken(t =>
      axios.get(`${CONFIG.lmis.refUrl}/api/orderables/${orderableId}`, {
        headers: { Authorization: `Bearer ${t}` },
        timeout: TIMEOUT_MS,
      })
    );
    const name = (res.data && res.data.fullProductName) || null;
    _orderableNameCache[orderableId] = name;
    return name;
  } catch (e) {
    _orderableNameCache[orderableId] = null;
    return null;
  }
}

async function fetchOpenLmisStock(facilityId, programId, orderableId) {
  // Returns { soh, productName } for the orderable. productName is the
  // OpenLMIS canonical fullProductName (used to find the HAPI Group when the
  // BKM-app medication code doesn't match). soh is 0 when no card exists /
  // no line items yet; null on transport failure.
  try {
    const res = await withOpenLMISToken(t =>
      axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
        params: { facility: facilityId, program: programId, orderable: orderableId },
        headers: { Authorization: `Bearer ${t}` },
        timeout: TIMEOUT_MS,
      })
    );
    const content = res.data.content || [];
    // Strict match by orderable id — OpenLMIS sometimes returns unrelated cards
    // when the requested orderable has no stock card; falling back to content[0]
    // would broadcast that other card's SOH onto every medicine.
    const card = content.find(c => c.orderable && c.orderable.id === orderableId);
    if (!card) return { soh: 0, productName: null };
    const soh = card.stockOnHand;
    return {
      soh: (soh === null || soh === undefined) ? 0 : soh,
      productName: (card.orderable && card.orderable.fullProductName) || null,
    };
  } catch (e) {
    logger.warn(`fhirLedger: SOH fetch failed (orderable=${orderableId}): ${e.message}`);
    return { soh: null, productName: null };
  }
}

/**
 * Sync the live OpenLMIS SOH for one (facility × orderable) into HAPI.
 * Best-effort: failures are logged but never throw.
 *
 * @param {{facilityId, programId, orderableId}} identity
 * @param {string?} medCode — medication name, used to look up the HAPI Group
 */
async function syncOrderableToFhir(identity, medCode) {
  if (runtimeConfig.get('FHIR_LEDGER_ENABLED') === 'false') return;
  if (!identity || !identity.facilityId || !identity.programId || !identity.orderableId) return;
  const orgRef = FACILITY_MAP[identity.facilityId];
  if (!orgRef) {
    logger.debug(`fhirLedger: no HAPI Organization mapped for facility=${identity.facilityId}`);
    return;
  }

  const { soh, productName } = await fetchOpenLmisStock(identity.facilityId, identity.programId, identity.orderableId);
  if (soh === null) return; // transport failure — don't clobber HAPI

  // stockCardSummaries returns the orderable as {id, href, versionNumber} only.
  // /api/orderables/{id} carries the canonical fullProductName needed to match
  // HAPI Group names when the BKM-app code is a SKU (e.g. "AL-20-120" → "Oxytocin 10 IU").
  const canonical = productName || await fetchOpenLmisOrderableName(identity.orderableId);

  // Group lookup order: BKM-app medCode, then OpenLMIS canonical name, then
  // a name derived from the orderable id via MEDICATION_MAP reverse lookup.
  const candidates = [medCode, canonical, lookupMedNameByOrderableId(identity.orderableId)].filter(Boolean);
  let groupId = null;
  let matched = null;
  for (const n of candidates) {
    groupId = await findGroupIdByName(n);
    if (groupId) { matched = n; break; }
  }
  if (!groupId) {
    // No ledger Group yet — auto-create one named after the OpenLMIS product so
    // new medicines appear in the Stock-by-Facility view automatically.
    const newName = canonical || medCode;
    groupId = await createMedicineGroup(newName, medCode);
    matched = newName;
    if (!groupId) {
      logger.debug(`fhirLedger: no Group and auto-create failed for ${JSON.stringify(candidates)} — skipping`);
      return;
    }
  }

  const ok = await upsertObservation(groupId, orgRef, soh);
  if (ok) logger.info(`FHIR ledger updated: Group/${groupId} (${matched}) @ ${orgRef} → SOH=${soh}`);
}

/**
 * Wait for HAPI FHIR to respond on /metadata. Polls every 5s up to maxWaitMs,
 * then returns whatever the latest state is. Logs once on first wait + once on
 * success so quiet startups don't add noise.
 */
async function waitForHapi(maxWaitMs = 120000, intervalMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const r = await axios.get(`${HAPI}/metadata`, { timeout: 5000 });
      if (r.status === 200) {
        if (attempt > 1) logger.info(`fhirLedger: HAPI ready after ${attempt} attempts`);
        return true;
      }
    } catch (_) {
      if (attempt === 1) logger.info(`fhirLedger: waiting for HAPI at ${HAPI}/metadata ...`);
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  logger.warn(`fhirLedger: HAPI not ready after ${maxWaitMs / 1000}s — proceeding anyway`);
  return false;
}

/**
 * One-shot startup sync: walk every (facility × orderable) we know about, fetch
 * the current OpenLMIS SOH, and upsert HAPI Observations.
 */
async function initFromOpenLmis() {
  const programId = process.env.OPENLMIS_PROGRAM_ID;
  if (!programId) return;
  const meds = Object.entries(MEDICATION_MAP || {});
  const facilityIds = Object.keys(FACILITY_MAP);
  if (facilityIds.length === 0 || meds.length === 0) {
    logger.info(`FHIR ledger init skipped: facilities=${facilityIds.length} meds=${meds.length}`);
    return;
  }
  await waitForHapi();
  let synced = 0;
  for (const facilityId of facilityIds) {
    for (const [medName, orderableId] of meds) {
      await syncOrderableToFhir({ facilityId, programId, orderableId }, medName);
      synced++;
    }
  }
  logger.info(`FHIR ledger init complete: ${synced} commodity×facility pairs across ${facilityIds.length} facilities`);
}

module.exports = { syncOrderableToFhir, initFromOpenLmis, _facilityMap: FACILITY_MAP };
