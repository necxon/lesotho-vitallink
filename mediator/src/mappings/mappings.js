/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const fs     = require('fs');
const axios  = require('axios');
const logger = require('../logger');
const { CONFIG } = require('../config/config');

const PERFORMER_MAP    = {};
const MEDICATION_MAP   = {};   // explicit aliases: app-code → orderable UUID (CSV / OpenHIM)
const LMIS_ORDERABLE_MAP = {}; // live from OpenLMIS: normalized productCode → orderable UUID

/** Maps DHIS2 org unit UIDs to human-readable village/region labels (mirrors bkm-web OU_LABELS). */
const OU_LABELS = {
  'VilHaMokoe1': { village: 'Ha Mokoena',    region: 'Maseru District' },
  'VilHaSehl01': { village: 'Ha Sehlabane',  region: 'Maseru District' },
  'VilMatsien1': { village: 'Matsieng',      region: 'Maseru District' },
  'dwx1Yz4BwNX': { village: 'Maseru Clinic A', region: 'Maseru District' },
};

/** Strips hyphens, underscores, spaces and lowercases — so AL-20-120 matches AL20120 */
function normalizeCode(code) {
  return code.toLowerCase().replace(/[-_\s]/g, '');
}

function loadMappings() {
  if (!fs.existsSync('mappings.json')) {
    logger.error('CRITICAL: mappings.json missing.');
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync('mappings.json', 'utf8'));
  } catch (e) {
    logger.error(`CRITICAL: mappings.json parse error: ${e.message}`);
    return;
  }

  for (const row of (data.performers || [])) {
    if (!row.sourceId) continue;
    // The store_manager role was retired (model is admin > coordinator > vhw). The
    // reseed-generated mappings.json may still contain store_manager rows; skip them
    // on load so deleted store managers don't reappear after a mediator restart.
    if ((row.role || '').toLowerCase() === 'store_manager') continue;
    const entry = {
      facilityId:   row.facilityId   || '',
      facilityName: row.facilityName || null,
      programId:    row.programId    || '',
      phone:        row.phone        || null,
      email:        row.email        || null,
      dhis2OrgUnit: row.dhis2OrgUnit || null,
      name:         row.name         || null,
      role:         row.role         || 'vhw',
      locationId:   row.locationId   || null,
      locationName: row.locationName || null,
      aliases:      Array.isArray(row.aliases) ? row.aliases.slice() : [],
      _canonical:   row.sourceId,
    };
    PERFORMER_MAP[row.sourceId] = entry;
    // Register each alias as a separate key pointing to the same mapping,
    // so a dispense with performer=alias resolves to the canonical's facility/program.
    for (const alias of entry.aliases) {
      if (alias && alias !== row.sourceId) PERFORMER_MAP[alias] = entry;
    }
  }

  for (const row of (data.medications || [])) {
    if (!row.sourceId || !row.orderableId) continue;
    MEDICATION_MAP[row.sourceId]               = row.orderableId;
    MEDICATION_MAP[normalizeCode(row.sourceId)] = row.orderableId;
  }

  require('./mappingsStore').applyToMaps(PERFORMER_MAP, MEDICATION_MAP);
  logger.info('Mappings loaded from mappings.json.');
}

/**
 * Applies mapping config received from OpenHIM (via heartbeat or fetchConfig).
 * Overwrites whichever maps have data in the config; leaves the other unchanged
 * so CSV values survive if only one side is configured in OpenHIM.
 *
 * Format:
 *   config.performerMappings  — JSON string: [{sourceId, facilityId, programId, phone, email}]
 *   config.medicationMappings — JSON string: [{sourceId, orderableId}]
 *
 * Returns true if at least one map was updated from OpenHIM.
 */
function applyOpenHIMConfig(config) {
  if (!config || typeof config !== 'object') return false;
  let applied = false;

  const perfJson = config.performerMappings;
  if (perfJson && perfJson.trim()) {
    try {
      const rows = JSON.parse(perfJson);
      // Merge: OpenHIM entries override CSV entries by sourceId; CSV-only entries are preserved.
      // This keeps dhis2OrgUnit (and other CSV-only fields) for VHWs not in OpenHIM config.
      for (const row of rows) {
        PERFORMER_MAP[row.sourceId] = {
          ...(PERFORMER_MAP[row.sourceId] || {}),
          facilityId:   row.facilityId,
          programId:    row.programId    || '',
          phone:        row.phone        || null,
          email:        row.email        || null,
          dhis2OrgUnit: row.dhis2OrgUnit || PERFORMER_MAP[row.sourceId]?.dhis2OrgUnit || null,
          name:         row.name         || PERFORMER_MAP[row.sourceId]?.name         || null,
          role:         row.role         || PERFORMER_MAP[row.sourceId]?.role         || 'vhw',
        };
      }
      applied = true;
      logger.info(`Performer mappings loaded from OpenHIM (${rows.length} entries)`);
    } catch (e) {
      logger.warn(`OpenHIM performerMappings parse error: ${e.message} — keeping existing`);
    }
  }

  const medJson = config.medicationMappings;
  if (medJson && medJson.trim()) {
    try {
      const rows = JSON.parse(medJson);
      Object.keys(MEDICATION_MAP).forEach(k => delete MEDICATION_MAP[k]);
      for (const row of rows) {
        MEDICATION_MAP[row.sourceId] = row.orderableId;
      }
      applied = true;
      logger.info(`Medication mappings loaded from OpenHIM (${rows.length} entries)`);
    } catch (e) {
      logger.warn(`OpenHIM medicationMappings parse error: ${e.message} — keeping existing`);
    }
  }

  return applied;
}

/**
 * Queries OpenLMIS /api/orderables and rebuilds LMIS_ORDERABLE_MAP.
 * Keyed by normalizeCode(productCode) so app codes with hyphens still match.
 * Safe to call multiple times (hot-refresh).
 */
async function refreshOrderablesFromLMIS() {
  const { getOpenLMISToken } = require('../tokens');
  try {
    const token = await getOpenLMISToken();
    const res   = await axios.get(
      `${CONFIG.lmis.refUrl}/api/orderables?page=0&size=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const items = res.data.content || [];
    Object.keys(LMIS_ORDERABLE_MAP).forEach(k => delete LMIS_ORDERABLE_MAP[k]);
    for (const item of items) {
      if (item.productCode && item.id) {
        LMIS_ORDERABLE_MAP[normalizeCode(item.productCode)] = item.id;
      }
    }
    logger.info(`OpenLMIS orderable map refreshed (${items.length} products)`);
  } catch (err) {
    logger.warn(`Could not refresh OpenLMIS orderables (keeping existing): ${err.message}`);
  }
}

/**
 * Resolves a BKM app medication code to an OpenLMIS orderable UUID.
 * Priority: explicit alias (CSV/OpenHIM) → live LMIS lookup → env fallback.
 */
function resolveOrderableId(code) {
  if (!code) return process.env.OPENLMIS_ORDERABLE_ID;
  const resolved = MEDICATION_MAP[code]
    || LMIS_ORDERABLE_MAP[normalizeCode(code)]
    || process.env.OPENLMIS_ORDERABLE_ID;
  if (!resolved) {
    logger.error(
      `Unknown medication code "${code}" — no match in OpenHIM aliases, OpenLMIS product codes, or OPENLMIS_ORDERABLE_ID env var. ` +
      `Add an alias in OpenHIM console (Mediators → Vital-Link → Config → Medication Mappings): ` +
      `[{"sourceId":"${code}","orderableId":"<openlmis-uuid>"}]`
    );
  }
  return resolved;
}

/** Returns true only when the code resolves via an explicit alias or live LMIS lookup (not env fallback). */
function isKnownMedicineCode(code) {
  if (!code) return false;
  return !!(MEDICATION_MAP[code] || LMIS_ORDERABLE_MAP[normalizeCode(code)]);
}

// Reverse lookup: orderable UUID → human-readable medicine name.
// Prefers names containing spaces (full product names like "Paracetamol syrup"
// over abbreviations like "PARA" or codes like "paracetamol-syrup").
function resolveOrderableName(orderableId) {
  if (!orderableId) return orderableId;
  const matches = Object.entries(MEDICATION_MAP)
    .filter(([, id]) => id === orderableId)
    .map(([name]) => name);
  if (!matches.length) return orderableId;
  const withSpaces = matches.filter(n => /\s/.test(n));
  const pool = withSpaces.length ? withSpaces : matches;
  return pool.reduce((a, b) => a.length >= b.length ? a : b);
}

/**
 * Stable canonical key for a medicine, identical across all its aliases/codes/labels.
 * Resolves a known alias to its orderable, then back to the canonical display name —
 * so a VHW allocation made under "Male Condoms" matches a dispense coded "MCONDOM".
 * Unknown codes are returned unchanged (NOT collapsed onto the env-default orderable),
 * so unmapped medicines never share an allocation bucket.
 */
function canonicalMed(code) {
  if (!code || !isKnownMedicineCode(code)) return code;
  return resolveOrderableName(resolveOrderableId(code)) || code;
}

module.exports = {
  PERFORMER_MAP, MEDICATION_MAP, LMIS_ORDERABLE_MAP, OU_LABELS,
  loadMappings, applyOpenHIMConfig,
  refreshOrderablesFromLMIS, resolveOrderableId, isKnownMedicineCode, resolveOrderableName, canonicalMed
};
