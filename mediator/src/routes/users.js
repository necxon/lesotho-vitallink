/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router } = require('express');
const axios      = require('axios');
const { randomUUID } = require('crypto');
const logger     = require('../logger');
const { CONFIG } = require('../config/config');
const store      = require('../mappings/mappingsStore');
const { PERFORMER_MAP } = require('../mappings/mappings');
const { canCreateRole, ADMIN, COORDINATOR } = require('../config/roles');
const { decodeJwt, decodeJwtSub } = require('../auth/jwt');
const reply      = require('../reply');

// Resolve the calling user (KC sub → performer map) and whether they're a realm admin.
function resolveCaller(authHeader) {
  const sub = decodeJwtSub(authHeader);
  if (!sub) return null;
  return PERFORMER_MAP[sub] || PERFORMER_MAP[`Practitioner/${sub}`] || null;
}

// Unique performer entries (PERFORMER_MAP has one key per alias → dedupe on canonical).
function uniquePerformers() {
  const seen = new Set(), out = [];
  for (const p of Object.values(PERFORMER_MAP)) {
    const key = p._canonical || p;
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out;
}
function isRealmAdmin(authHeader) {
  const ra = (decodeJwt(authHeader) || {}).resource_access || {};
  return ((ra['realm-management'] || {}).roles || []).includes('realm-admin');
}

const KC_URL   = CONFIG.keycloak.url;
const FHIR_URL = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
const KC_REALM = process.env.KEYCLOAK_REALM || 'opensrp';
// Realm that issues the admin token. opensrp-admin (realm-admin role) lives in
// the opensrp realm, so we authenticate there rather than against master.
const KC_ADMIN_REALM = process.env.KEYCLOAK_ADMIN_REALM || KC_REALM;

const FACILITY_ID   = process.env.OPENLMIS_FACILITY_ID || '28de536f-b826-4eeb-a3c4-d65221a1120d';
const FACILITY_NAME = 'Maseru District Clinic A';
const PROGRAM_ID    = process.env.OPENLMIS_PROGRAM_ID  || '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c';
const DHIS2_OU      = process.env.DHIS2_ORG_UNIT       || 'dwx1Yz4BwNX';

async function getKcAdminToken() {
  const res = await axios.post(
    `${KC_URL}/realms/${KC_ADMIN_REALM}/protocol/openid-connect/token`,
    new URLSearchParams({
      grant_type: 'password',
      client_id:  'admin-cli',
      username:   process.env.KEYCLOAK_ADMIN_USER     || 'bkm-admin',
      password:   process.env.KEYCLOAK_ADMIN_PASSWORD || 'password',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

const router = Router();

// POST /aggregate/users/field-worker
// Creates a Keycloak user, FHIR Practitioner, and performer mapping in one shot.
router.post('/field-worker', async (req, res) => {
  const {
    firstName, lastName, username, password,
    role         = 'facility_worker',
    phone        = null,
    email        = null,
    facilityId   = FACILITY_ID,
    facilityName = FACILITY_NAME,
    programId    = PROGRAM_ID,
    dhis2OrgUnit = DHIS2_OU,
    locationId   = null,
    locationName = null,
    organizationId = null,
  } = req.body || {};

  if (!firstName || !lastName) return reply(res, { status: 'error', message: 'firstName and lastName are required' }, 400);
  if (!username)               return reply(res, { status: 'error', message: 'username is required' }, 400);
  if (!password)               return reply(res, { status: 'error', message: 'password is required' }, 400);

  // ── Role + facility gate ───────────────────────────────────────────────────
  // A caller may only create roles strictly below their own (admin →
  // coordinator/vhw, coordinator → vhw), and only at their OWN facility.
  // Realm admins (opensrp-admin) bypass both checks.
  let eff = { facilityId, facilityName, programId, dhis2OrgUnit, locationId, locationName };
  const caller = resolveCaller(req.headers.authorization);
  // Admins (the 'admin' workflow role, or realm-admin) bypass the hierarchy, the
  // same-facility rule, and the one-per-facility limit — they can do everything.
  const adminBypass = isRealmAdmin(req.headers.authorization) || (caller && caller.role === ADMIN);
  if (!adminBypass) {
    if (!caller || !caller.role) {
      return reply(res, { status: 'error', message: 'Your account could not be identified — cannot create users' }, 403);
    }
    if (!canCreateRole(caller.role, role)) {
      return reply(res, { status: 'error', message: `A ${caller.role} cannot create a ${role}.` }, 403);
    }
    eff = {
      facilityId:   caller.facilityId   || facilityId,
      facilityName: caller.facilityName || facilityName,
      programId:    caller.programId    || programId,
      dhis2OrgUnit: caller.dhis2OrgUnit || dhis2OrgUnit,
      locationId:   caller.locationId   || locationId,
      locationName: caller.locationName || locationName,
      organizationId: caller.organizationId || organizationId,
    };
  } else {
    eff.organizationId = organizationId;
  }

  // ── One coordinator per facility (VHWs unlimited) ────────────────────────────
  // Structural limit — applies to EVERYONE, including admin. (Admin may still pick
  // the facility + role; it just can't exceed one coordinator per facility.)
  if (role === COORDINATOR) {
    const taken = uniquePerformers().some((p) => p.role === role && p.facilityId === eff.facilityId);
    if (taken) {
      return reply(res, {
        status: 'error', reason: 'role-already-filled',
        message: `${eff.facilityName || 'This facility'} already has a ${role}. Only one ${role} is allowed per facility.`,
      }, 409);
    }
  }

  let kcToken, kcUserId, practitionerId;

  // ── 1. Keycloak: get admin token ──────────────────────────────────────────
  try {
    kcToken = await getKcAdminToken();
  } catch (err) {
    logger.error(`Create field-worker: KC admin token failed: ${err.message}`);
    return reply(res, { status: 'error', message: `Keycloak admin auth failed: ${err.message}` }, 502);
  }

  // ── 2. Keycloak: create user ──────────────────────────────────────────────
  try {
    const createRes = await axios.post(
      `${KC_URL}/admin/realms/${KC_REALM}/users`,
      {
        username,
        firstName,
        lastName,
        email:       email || undefined,
        enabled:     true,
        credentials: [{ type: 'password', value: password, temporary: false }],
      },
      { headers: { Authorization: `Bearer ${kcToken}`, 'Content-Type': 'application/json' } }
    );
    // KC returns 201 with Location: .../users/{uuid}
    const location = createRes.headers.location || '';
    kcUserId = location.split('/').pop();
    if (!kcUserId) throw new Error('No user ID in KC Location header');
    logger.info(`Create field-worker: KC user created id=${kcUserId}`);
  } catch (err) {
    const detail = err.response?.data?.errorMessage || err.message;
    logger.error(`Create field-worker: KC user creation failed: ${detail}`);
    return reply(res, { status: 'error', message: `Keycloak user creation failed: ${detail}` }, 409);
  }

  // ── 3. Keycloak: assign role ───────────────────────────────────────────────
  try {
    const roleRes = await axios.get(
      `${KC_URL}/admin/realms/${KC_REALM}/roles/${encodeURIComponent(role)}`,
      { headers: { Authorization: `Bearer ${kcToken}` } }
    );
    await axios.post(
      `${KC_URL}/admin/realms/${KC_REALM}/users/${kcUserId}/role-mappings/realm`,
      [roleRes.data],
      { headers: { Authorization: `Bearer ${kcToken}`, 'Content-Type': 'application/json' } }
    );
    logger.info(`Create field-worker: KC role "${role}" assigned to ${kcUserId}`);
  } catch (err) {
    logger.warn(`Create field-worker: KC role assignment failed (continuing): ${err.message}`);
  }

  // ── 4. FHIR: create Practitioner ──────────────────────────────────────────
  try {
    practitionerId = randomUUID();
    await axios.put(
      `${FHIR_URL}/Practitioner/${practitionerId}`,
      {
        resourceType: 'Practitioner',
        id:           practitionerId,
        identifier: [
          { system: 'http://keycloak/user-id',   value: kcUserId },
          { system: 'http://keycloak/username',   value: username },
        ],
        name: [{ use: 'official', given: [firstName], family: lastName }],
        telecom: [
          ...(phone ? [{ system: 'phone', value: phone }] : []),
          ...(email ? [{ system: 'email', value: email }] : []),
        ],
      },
      { headers: { 'Content-Type': 'application/fhir+json' } }
    );
    logger.info(`Create field-worker: FHIR Practitioner/${practitionerId} created`);
  } catch (err) {
    logger.error(`Create field-worker: FHIR Practitioner creation failed: ${err.message}`);
    return reply(res, { status: 'error', message: `FHIR Practitioner creation failed: ${err.message}` }, 502);
  }

  // ── 5. FHIR: create PractitionerRole ──────────────────────────────────────
  try {
    const roleId = randomUUID();
    await axios.put(
      `${FHIR_URL}/PractitionerRole/${roleId}`,
      {
        resourceType:  'PractitionerRole',
        id:            roleId,
        practitioner:  { reference: `Practitioner/${practitionerId}` },
        // Link to the worker's real facility. Prefer an explicit organizationId;
        // otherwise omit organization rather than point at a wrong/deleted default
        // (the location below still identifies the facility).
        ...(eff.organizationId ? { organization: { reference: `Organization/${eff.organizationId}`, display: eff.facilityName || undefined } } : {}),
        code: [{ coding: [{ system: 'http://snomed.info/sct', code: role, display: role }] }],
        ...(eff.locationId ? { location: [{ reference: `Location/${eff.locationId}`, display: eff.locationName || eff.locationId }] } : {}),
      },
      { headers: { 'Content-Type': 'application/fhir+json' } }
    );
  } catch (err) {
    logger.warn(`Create field-worker: FHIR PractitionerRole creation failed (continuing): ${err.message}`);
  }

  // ── 6. Performer mapping ───────────────────────────────────────────────────
  const perfId  = `Practitioner/${practitionerId}`;
  const kcAlias = `Practitioner/${kcUserId}`;   // the app/JWT often identifies the worker by KC sub
  const fullName = `${firstName} ${lastName}`;
  const data = {
    name:         fullName,
    role,
    facilityId:   eff.facilityId,
    facilityName: eff.facilityName,
    programId:    eff.programId,
    dhis2OrgUnit: eff.dhis2OrgUnit,
    phone:        phone        || null,
    email:        email        || null,
    locationId:   eff.locationId   || null,
    locationName: eff.locationName || null,
    // Canonical id + KC-sub alias so allocations + dispenses resolve to the SAME
    // performer no matter which id the app/JWT sends (else per-VHW deduction misses).
    _canonical:   perfId,
    aliases:      [kcAlias],
  };
  store.setPerformer(perfId, data);
  PERFORMER_MAP[perfId]  = data;
  PERFORMER_MAP[kcAlias] = data;
  logger.info(`Create field-worker: performer mapping added for ${perfId}`);

  reply(res, {
    status:          'ok',
    practitionerId,
    kcUserId,
    performerMapId:  perfId,
    name:            fullName,
    username,
    role,
  });
});

// POST /aggregate/users/statuses
// Body: { practitionerIds: [...] } — batch status lookup for the table view.
router.post('/statuses', async (req, res) => {
  const { practitionerIds = [] } = req.body || {};
  if (!practitionerIds.length) return reply(res, { statuses: {} });

  let kcToken;
  try { kcToken = await getKcAdminToken(); } catch (err) {
    return reply(res, { status: 'error', message: err.message }, 502);
  }

  const results = await Promise.all(practitionerIds.map(async (pid) => {
    const fhirId = pid.replace(/^Practitioner\//, '');
    try {
      const fhirRes = await axios.get(`${FHIR_URL}/Practitioner/${fhirId}`, { headers: { Accept: 'application/fhir+json' } });
      const kcId = (fhirRes.data.identifier || []).find(i => i.system === 'http://keycloak/user-id');
      if (!kcId) return [pid, { linked: false }];
      const userRes = await axios.get(
        `${KC_URL}/admin/realms/${KC_REALM}/users/${kcId.value}`,
        { headers: { Authorization: `Bearer ${kcToken}` } }
      );
      return [pid, { linked: true, enabled: userRes.data.enabled, username: userRes.data.username, kcUserId: kcId.value }];
    } catch (e) {
      return [pid, { linked: false }];
    }
  }));

  reply(res, { statuses: Object.fromEntries(results) });
});

// GET /aggregate/users/status?practitionerId=...
// Returns the Keycloak enabled flag for a practitioner.
router.get('/status', async (req, res) => {
  const practitionerId = req.query.practitionerId;
  if (!practitionerId) return reply(res, { status: 'error', message: 'practitionerId is required' }, 400);

  const fhirId = practitionerId.replace(/^Practitioner\//, '');
  let kcUserId, kcToken;

  try {
    const fhirRes = await axios.get(`${FHIR_URL}/Practitioner/${fhirId}`, { headers: { Accept: 'application/fhir+json' } });
    const kcId = (fhirRes.data.identifier || []).find(i => i.system === 'http://keycloak/user-id');
    if (!kcId) throw new Error('No Keycloak user-id identifier on this Practitioner');
    kcUserId = kcId.value;
  } catch (err) {
    return reply(res, { status: 'error', message: `FHIR lookup failed: ${err.message}` }, 404);
  }

  try {
    kcToken = await getKcAdminToken();
    const userRes = await axios.get(
      `${KC_URL}/admin/realms/${KC_REALM}/users/${kcUserId}`,
      { headers: { Authorization: `Bearer ${kcToken}` } }
    );
    reply(res, { status: 'ok', kcUserId, enabled: userRes.data.enabled, username: userRes.data.username });
  } catch (err) {
    reply(res, { status: 'error', message: `Keycloak lookup failed: ${err.message}` }, 502);
  }
});

// POST /aggregate/users/set-enabled
// Blocks or unblocks a Keycloak user.
router.post('/set-enabled', async (req, res) => {
  const { practitionerId, enabled } = req.body || {};
  if (!practitionerId)  return reply(res, { status: 'error', message: 'practitionerId is required' }, 400);
  if (enabled === undefined) return reply(res, { status: 'error', message: 'enabled is required' }, 400);

  const fhirId = practitionerId.replace(/^Practitioner\//, '');
  let kcUserId, kcToken;

  try {
    const fhirRes = await axios.get(`${FHIR_URL}/Practitioner/${fhirId}`, { headers: { Accept: 'application/fhir+json' } });
    const kcId = (fhirRes.data.identifier || []).find(i => i.system === 'http://keycloak/user-id');
    if (!kcId) throw new Error('No Keycloak user-id identifier on this Practitioner');
    kcUserId = kcId.value;
  } catch (err) {
    return reply(res, { status: 'error', message: `FHIR lookup failed: ${err.message}` }, 404);
  }

  try {
    kcToken = await getKcAdminToken();
    await axios.put(
      `${KC_URL}/admin/realms/${KC_REALM}/users/${kcUserId}`,
      { enabled: !!enabled },
      { headers: { Authorization: `Bearer ${kcToken}`, 'Content-Type': 'application/json' } }
    );
    logger.info(`set-enabled: KC user ${kcUserId} enabled=${enabled}`);
    reply(res, { status: 'ok', kcUserId, enabled: !!enabled });
  } catch (err) {
    const detail = err.response?.data?.errorMessage || err.message;
    reply(res, { status: 'error', message: `Keycloak update failed: ${detail}` }, 502);
  }
});

// POST /aggregate/users/reset-password
// Resets a Keycloak user's password looked up via the FHIR Practitioner identifier.
router.post('/reset-password', async (req, res) => {
  const { practitionerId, newPassword } = req.body || {};

  if (!practitionerId) return reply(res, { status: 'error', message: 'practitionerId is required' }, 400);
  if (!newPassword)    return reply(res, { status: 'error', message: 'newPassword is required' }, 400);
  if (newPassword.length < 8) return reply(res, { status: 'error', message: 'Password must be at least 8 characters' }, 400);

  // Strip leading "Practitioner/" if caller includes it
  const fhirId = practitionerId.replace(/^Practitioner\//, '');

  let kcUserId, kcToken;

  // ── 1. Look up KC user ID from FHIR Practitioner identifier ──────────────
  try {
    const fhirRes = await axios.get(`${FHIR_URL}/Practitioner/${fhirId}`, {
      headers: { Accept: 'application/fhir+json' },
    });
    const identifiers = fhirRes.data.identifier || [];
    const kcId = identifiers.find(i => i.system === 'http://keycloak/user-id');
    if (!kcId) throw new Error('No Keycloak user-id identifier on this Practitioner');
    kcUserId = kcId.value;
  } catch (err) {
    logger.error(`reset-password: FHIR lookup failed for ${fhirId}: ${err.message}`);
    return reply(res, { status: 'error', message: `Could not find Keycloak user: ${err.message}` }, 404);
  }

  // ── 2. Get KC admin token ─────────────────────────────────────────────────
  try {
    kcToken = await getKcAdminToken();
  } catch (err) {
    logger.error(`reset-password: KC admin token failed: ${err.message}`);
    return reply(res, { status: 'error', message: `Keycloak admin auth failed: ${err.message}` }, 502);
  }

  // ── 3. Reset password ─────────────────────────────────────────────────────
  try {
    await axios.put(
      `${KC_URL}/admin/realms/${KC_REALM}/users/${kcUserId}/reset-password`,
      { type: 'password', value: newPassword, temporary: false },
      { headers: { Authorization: `Bearer ${kcToken}`, 'Content-Type': 'application/json' } }
    );
    logger.info(`reset-password: password reset for KC user ${kcUserId} (practitioner ${fhirId})`);
    reply(res, { status: 'ok', kcUserId });
  } catch (err) {
    const detail = err.response?.data?.errorMessage || err.message;
    logger.error(`reset-password: KC reset failed for ${kcUserId}: ${detail}`);
    reply(res, { status: 'error', message: `Password reset failed: ${detail}` }, 502);
  }
});

module.exports = router;
