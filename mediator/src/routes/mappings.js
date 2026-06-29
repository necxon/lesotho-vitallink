/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const { Router } = require('express');
const axios  = require('axios');
const logger = require('../logger');
const { CONFIG } = require('../config/config');
const reply  = require('../reply');
const store  = require('../mappings/mappingsStore');
const { PERFORMER_MAP, MEDICATION_MAP } = require('../mappings/mappings');

const router = Router();

//TODO: consider adding a periodic refresh for better eventual consistency, and to cover changes made outside the BKM app. For now, the expectation is that mappings and config changes are deployed alongside code changes, so they will be picked up on mediator restarts, but if there are manual changes made in OpenLMIS or DHIS2 that need to be reflected in the mediator's behavior, a restart would be required to pick those up. Adding a periodic refresh (e.g. every hour) could help with that, but would add complexity and load to the system, so it's a tradeoff to consider based on how frequently we expect those external changes to happen and how critical it is for the mediator to pick them up in near real-time.
//TODO: consider adding more detailed logging and error reporting for the mappings management, to make it easier to debug issues when they arise. For example, logging the incoming payloads for upsert and delete operations, as well as any errors that occur during database operations, could help with troubleshooting. We want to be careful not to log sensitive information, but having more visibility into the mappings management process would be valuable for maintenance and support.
//TODO: consider adding authentication and authorization for these endpoints, since they allow modifying the behavior of the mediator. This could be as simple as a shared secret or API key for now, but would help prevent unauthorized changes to the mappings.
//TODO: consider adding validation for the incoming payloads to ensure that required fields are present and correctly formatted, which would help catch issues early and provide clearer error messages to clients when they send invalid data.
//TODO: consider adding support for bulk updates to the mappings, in case there are many changes that need to be made at once. This could be a separate endpoint that accepts an array of upsert and delete operations, which would be more efficient than making multiple individual requests.
//TODO: consider adding support for retrieving the mappings in a more structured format (e.g. JSON) instead of just returning the raw maps, which would make it easier for clients to consume and understand the mappings. The current GET /aggregate/mappings endpoint could be enhanced to return a more comprehensive response that includes metadata about the mappings, such as timestamps of last updates, counts of total entries, etc.



// GET /aggregate/mappings — returns the live merged maps (CSV + store overrides).
// Each performer is registered under its canonical sourceId AND each alias (so a
// dispense by either id resolves). The Staff page wants one row per person, so
// return canonical keys only — skip alias keys (entry._canonical points elsewhere).
// Also collapse "<X>" and "Practitioner/<X>" (same person under a bare id and a
// Practitioner/ ref — e.g. a sync-fhir / app-dispense stub that duplicates a real
// staff entry). Keep the richer entry (the one carrying a facility).
router.get('/', (req, res) => {
  const byBare = {}; // bareId -> { key, entry }
  for (const [id, entry] of Object.entries(PERFORMER_MAP)) {
    if (!entry || (entry._canonical && entry._canonical !== id)) continue; // alias row
    const bare = id.replace(/^[A-Za-z]+\//, '');
    const cur = byBare[bare];
    // Prefer the entry that has a facility (the real staff record) over a
    // facility-less stub; otherwise keep the first one seen.
    if (!cur || (!cur.entry.facilityId && entry.facilityId)) byBare[bare] = { key: id, entry };
  }
  const performers = {};
  for (const { key, entry } of Object.values(byBare)) performers[key] = entry;
  reply(res, { performers, medications: MEDICATION_MAP });
});

// POST /aggregate/mappings/performers — upsert
router.post('/performers', (req, res) => {
  const { id, name, role, facilityId, facilityName, programId, dhis2OrgUnit, phone, email, locationId, locationName } = req.body || {};
  if (!id) return reply(res, { status: 'error', message: 'id is required' }, 400);
  const data = {
    name:         name         || null,
    role:         role         || 'vhw',
    facilityId:   facilityId   || '',
    facilityName: facilityName || null,
    programId:    programId    || '',
    dhis2OrgUnit: dhis2OrgUnit || null,
    phone:        phone        || null,
    email:        email        || null,
    locationId:   locationId   || null,
    locationName: locationName || null,
  };
  store.setPerformer(id, data);
  PERFORMER_MAP[id] = { ...(PERFORMER_MAP[id] || {}), ...data };
  logger.info(`Mappings: performer upserted: ${id}`);
  reply(res, { status: 'ok', id });
});

// DELETE /aggregate/mappings/performers — remove
router.delete('/performers', (req, res) => {
  const { id } = req.body || {};
  if (!id) return reply(res, { status: 'error', message: 'id is required' }, 400);
  store.deletePerformer(id);
  delete PERFORMER_MAP[id];
  logger.info(`Mappings: performer deleted: ${id}`);
  reply(res, { status: 'ok', id });
});

// POST /aggregate/mappings/medications — upsert
router.post('/medications', (req, res) => {
  const { code, orderableId } = req.body || {};
  if (!code || !orderableId) {
    return reply(res, { status: 'error', message: 'code and orderableId are required' }, 400);
  }
  store.setMedication(code, orderableId);
  MEDICATION_MAP[code] = orderableId;
  logger.info(`Mappings: medication upserted: ${code} → ${orderableId}`);
  reply(res, { status: 'ok', code });
});

// DELETE /aggregate/mappings/medications — remove
router.delete('/medications', (req, res) => {
  const { code } = req.body || {};
  if (!code) return reply(res, { status: 'error', message: 'code is required' }, 400);
  store.deleteMedication(code);
  delete MEDICATION_MAP[code];
  logger.info(`Mappings: medication deleted: ${code}`);
  reply(res, { status: 'ok', code });
});

// POST /aggregate/mappings/sync-fhir — pull Practitioners from HAPI FHIR, add new ones
router.post('/sync-fhir', async (req, res) => {
  try {
    const token   = req.headers.authorization || '';
    const headers = token ? { Authorization: token } : {};
    const fhirUrl = CONFIG.fhir.url;

    const [practRes, roleRes] = await Promise.all([
      axios.get(`${fhirUrl}/Practitioner?_count=200`,     { headers }),
      axios.get(`${fhirUrl}/PractitionerRole?_count=200`, { headers }),
    ]);

    const practitioners = (practRes.data.entry || []).map(e => e.resource);
    const roles         = (roleRes.data.entry  || []).map(e => e.resource);

    const roleByPract = {};
    for (const r of roles) {
      const ref = r.practitioner?.reference;
      if (!ref) continue;
      const practId = ref.replace(/^Practitioner\//, '');
      roleByPract[practId] = r.code?.[0]?.coding?.[0]?.code || 'vhw';
    }

    let added = 0;
    for (const p of practitioners) {
      const fullId = `Practitioner/${p.id}`;
      if (PERFORMER_MAP[fullId]) continue;
      const name = [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family]
        .filter(Boolean).join(' ') || p.id;
      const data = {
        name, role: roleByPract[p.id] || 'vhw',
        facilityId: '', programId: '', dhis2OrgUnit: null, phone: null, email: null,
      };
      store.setPerformer(fullId, data);
      PERFORMER_MAP[fullId] = data;
      added++;
    }

    logger.info(`Mappings sync-fhir: ${added} new practitioners added (${practitioners.length} total)`);
    reply(res, { status: 'ok', added, total: practitioners.length });
  } catch (err) {
    logger.error(`Mappings sync-fhir error: ${err.message}`);
    reply(res, { status: 'error', message: err.message }, 500);
  }
});

module.exports = router;
