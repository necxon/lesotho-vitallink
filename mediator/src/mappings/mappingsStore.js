/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const STORE_FILE = process.env.MAPPINGS_STORE_FILE || '/data/mappings-store.json';

let _store = { performers: {}, medications: {} };

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    _store.performers  = raw.performers  || {};
    _store.medications = raw.medications || {};
  }
} catch (e) {
  console.warn(`[mappingsStore] Could not load ${STORE_FILE}: ${e.message}`);
}

function _save() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2));
  } catch (e) {
    console.warn(`[mappingsStore] Could not write ${STORE_FILE}: ${e.message}`);
  }
}

function getAll() {
  return {
    performers:  { ..._store.performers },
    medications: { ..._store.medications },
  };
}

function setPerformer(id, data) {
  _store.performers[id] = { ...(_store.performers[id] || {}), ...data };
  _save();
}

function deletePerformer(id) {
  delete _store.performers[id];
  _save();
}

function setMedication(code, orderableId) {
  _store.medications[code] = orderableId;
  _save();
}

function deleteMedication(code) {
  delete _store.medications[code];
  _save();
}

/**
 * Merges stored overrides into the live PERFORMER_MAP and MEDICATION_MAP in-place.
 * Store entries take priority over CSV (called after loadMappings()).
 */
function applyToMaps(PERFORMER_MAP, MEDICATION_MAP) {
  for (const [id, data] of Object.entries(_store.performers)) {
    const entry = { ...(PERFORMER_MAP[id] || {}), ...data };
    if (!entry._canonical) entry._canonical = id;
    PERFORMER_MAP[id] = entry;
    // Register each alias as its own key → a dispense/allocation under an alias
    // (e.g. the Keycloak sub) resolves to the same canonical performer.
    for (const alias of (entry.aliases || [])) {
      if (alias && alias !== id) PERFORMER_MAP[alias] = entry;
    }
  }
  for (const [code, orderableId] of Object.entries(_store.medications)) {
    MEDICATION_MAP[code] = orderableId;
  }
}

module.exports = { getAll, setPerformer, deletePerformer, setMedication, deleteMedication, applyToMaps };
