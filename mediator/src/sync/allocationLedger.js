/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 *
 * Per-VHW allocation ledger → FHIR.
 *
 * Mirrors each VHW's remaining allocation (allocated − dispensed) for a medicine
 * into a HAPI FHIR Observation, upserted on every allocation change (allocate +
 * dispense). The BKM app syncs these (subject/performer = the VHW) so the dispense
 * form can show the remaining balance and block over-dispense AT ENTRY — the
 * mediator's allocation gate stays the authoritative backstop.
 *
 * Deterministic id (alloc-<period>-<practitioner>-<medicine>) → idempotent PUT,
 * no read-then-create race.
 */
'use strict';

const axios = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const runtimeConfig = require('../config/runtimeConfig');
const { PERFORMER_MAP } = require('../mappings/mappings');

const HAPI = CONFIG.fhir.url;
const FHIR_JSON = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' };

function slug(s) { return String(s || '').replace(/^Practitioner\//, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24); }

// Stable Observation id per (period × VHW × medicine), ≤64 chars for HAPI.
function balanceObsId(period, practitioner, medication) {
  return `alloc-${period}-${slug(practitioner)}-${slug(medication)}`.slice(0, 64);
}

function buildObservation({ period, practitioner, medication, allocated, dispensed, remaining, facilityId }) {
  const pid = String(practitioner).replace(/^Practitioner\//, '');
  // The app's syncStrategy is ["Location"] → it downloads resources tagged with the
  // user's location-tag-id. Tag with the VHW's FHIR location so the device syncs it;
  // also keep the practitioner tag so the form can pick this VHW's row.
  const locId = (PERFORMER_MAP[practitioner] && PERFORMER_MAP[practitioner].locationId) || null;
  const tags = [{ system: 'https://smartregister.org/practitioner-tag-id', code: pid, display: 'Practitioner' }];
  if (locId) tags.push({ system: 'https://smartregister.org/location-tag-id', code: locId, display: 'Practitioner Location' });
  return {
    resourceType: 'Observation',
    id: balanceObsId(period, practitioner, medication),
    // Carry the VHW as smartregister tags + an identifier-based performer, NOT a
    // literal Practitioner reference: the OpenSRP app syncs by these tags, and a
    // deleted/missing Practitioner resource in HAPI can't block the write (HAPI
    // enforces referential integrity on literal references).
    meta: { tag: tags },
    status: 'preliminary',
    identifier: [{ system: 'http://bkm/allocation', value: `${period}|${medication}` }],
    code: { text: medication },                       // dispense form matches on the chosen medicine
    performer: [{ identifier: { system: 'http://bkm/practitioner', value: pid } }],
    effectiveDateTime: new Date().toISOString(),
    component: [
      { code: { text: 'Remaining' }, valueQuantity: { value: remaining, unit: 'units' } },
      { code: { text: 'Allocated' }, valueQuantity: { value: allocated, unit: 'units' } },
      { code: { text: 'Dispensed' }, valueQuantity: { value: dispensed, unit: 'units' } },
    ],
    ...(facilityId ? { extension: [{ url: 'http://bkm/facility-id', valueString: facilityId }] } : {}),
  };
}

// Best-effort: never throws — a failed publish must not break allocate/dispense.
async function publishBalance(args) {
  if (runtimeConfig.get('FHIR_LEDGER_ENABLED') === 'false') return false;
  if (!args || !args.practitioner || !args.medication) return false;
  const body = buildObservation(args);
  try {
    await axios.put(`${HAPI}/Observation/${body.id}`, body, { timeout: TIMEOUT_MS, headers: FHIR_JSON });
    logger.info(`alloc ledger: ${body.meta.tag[0].code} / ${args.medication} → remaining=${args.remaining} (Observation/${body.id})`);
    return true;
  } catch (e) {
    logger.warn(`alloc ledger upsert failed (${body.subject.reference} / ${args.medication}): ${e.message}`);
    return false;
  }
}

module.exports = { publishBalance, balanceObsId };
