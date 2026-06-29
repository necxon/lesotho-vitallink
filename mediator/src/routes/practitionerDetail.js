/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 *
 * Dynamic OpenSRP custom endpoints that plain HAPI FHIR does not implement, but the
 * FHIR-Core Android app calls on login to resolve the user's team/org/location:
 *   GET /PractitionerDetail?keycloak-uuid=<uuid>
 *   GET /LocationHierarchy?identifier=<locationId>   (best-effort)
 *
 * Replaces the static per-user practitioner_details_*.json stubs in the fhir-proxy:
 * builds the PractitionerDetail bundle on the fly from FHIR (Practitioner by keycloak
 * identifier -> PractitionerRole -> Organization/Location, + a CareTeam and Group),
 * so EVERY user (present and future) resolves real data — no per-VHW files.
 */
'use strict';

const { Router } = require('express');
const axios  = require('axios');
const logger = require('../logger');

const router = Router();
const FHIR = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';

async function fhirGet(path) {
  const r = await axios.get(`${FHIR}${path}`, {
    headers: { Accept: 'application/fhir+json' }, timeout: 15000,
  });
  return r.data;
}
const first = (bundle) => ((bundle && bundle.entry) || [])[0] && bundle.entry[0].resource;
const bareId = (ref) => (ref || '').split('/').pop();

function emptyBundle() {
  return { resourceType: 'Bundle', id: 'practitioner-details-bundle', type: 'searchset', total: 0, entry: [] };
}

// GET /PractitionerDetail?keycloak-uuid=<uuid>
router.get('/', async (req, res) => {
  const kcUuid = req.query['keycloak-uuid'];
  res.type('application/fhir+json');
  if (!kcUuid) return res.json(emptyBundle());

  try {
    // 1. Practitioner by Keycloak user-id identifier
    const pBundle = await fhirGet(`/Practitioner?identifier=${encodeURIComponent(kcUuid)}`);
    const practitioner = first(pBundle);
    if (!practitioner) {
      logger.info(`PractitionerDetail: no Practitioner for keycloak-uuid ${kcUuid} — empty bundle`);
      return res.json(emptyBundle());
    }
    const pid  = practitioner.id;
    const name = (practitioner.name && practitioner.name[0]) || {};

    // 2. PractitionerRole -> org + location + role code
    const role = first(await fhirGet(`/PractitionerRole?practitioner=Practitioner/${pid}`));
    const orgRef  = role && role.organization && role.organization.reference;
    const locRef  = role && (role.location || [])[0] && role.location[0].reference;
    const roleCode = (role && (role.code || [])[0] && (role.code[0].coding || [])[0] && role.code[0].coding[0].code) || 'vhw';

    // 3. Organization + Location (fall back gracefully if missing)
    const org = orgRef ? await fhirGet(`/${orgRef}`).catch(() => null) : null;
    const loc = locRef ? await fhirGet(`/${locRef}`).catch(() => null) : null;

    // 4. CareTeam: use an existing one this practitioner is on, else synthesise a
    //    facility team so the app shows a team (and a non-empty careTeamIds list).
    let careTeam = first(await fhirGet(`/CareTeam?participant=Practitioner/${pid}`).catch(() => ({})));
    if (!careTeam) {
      careTeam = {
        resourceType: 'CareTeam', id: `team-${bareId(locRef) || pid}`, status: 'active',
        name: `${(org && org.name) || (loc && loc.name) || 'Facility'} Team`,
        participant: [{ member: { reference: `Practitioner/${pid}` } }],
        ...(orgRef ? { managingOrganization: [{ reference: orgRef }] } : {}),
      };
    }

    // 5. Group: the VHW's caseload group if one exists, else synthesise.
    let group = first(await fhirGet(`/Group?managing-entity=Practitioner/${pid}&type=person`).catch(() => ({})));
    if (!group) {
      group = {
        resourceType: 'Group', id: `group-vhw-${pid}`, type: 'person', actual: true, active: true,
        name: `${[(name.given || [])[0], name.family].filter(Boolean).join(' ') || pid} caseload`,
        managingEntity: { reference: `Practitioner/${pid}` },
      };
    }

    // 6. Assemble PractitionerDetail (contained), mirroring the shape the app parses.
    const contained = [
      {
        resourceType: 'Practitioner', id: pid,
        identifier: [{ use: 'secondary', value: kcUuid }],
        active: true, name: [{ use: 'official', family: name.family, given: name.given || [] }],
      },
      ...(org ? [{ resourceType: 'Organization', id: org.id, active: true, name: org.name }] : []),
      careTeam,
      ...(loc ? [{ resourceType: 'Location', id: loc.id, status: loc.status || 'active', name: loc.name, mode: 'instance',
                   ...(loc.partOf ? { partOf: loc.partOf } : {}) }] : []),
      ...(role ? [{
        resourceType: 'PractitionerRole', id: role.id, active: true,
        practitioner: { reference: `Practitioner/${pid}` },
        ...(orgRef ? { organization: { reference: orgRef } } : {}),
        ...(locRef ? { location: [{ reference: locRef, display: loc && loc.name }] } : {}),
        code: [{ coding: [{ system: 'http://snomed.info/sct', code: roleCode, display: roleCode }] }],
      }] : []),
      group,
    ];

    logger.info(`PractitionerDetail: built for ${kcUuid} (practitioner ${pid}, org ${bareId(orgRef)}, loc ${bareId(locRef)})`);
    return res.json({
      resourceType: 'Bundle', id: 'practitioner-details-bundle', type: 'searchset', total: 1,
      entry: [{ resource: {
        resourceType: 'PractitionerDetail', id: `pd-${pid}`,
        // The app reads PractitionerDetails.fhirPractitionerDetails.id and writes it to
        // SharedPreferences as PRACTITIONER_ID (LoginViewModel.writePractitionerDetailsToShredPref);
        // without it the device's practitioner-tag-id stays "Not defined", so dispenses aren't
        // tagged with the VHW and the per-VHW balance can't be filtered on-device.
        // CRITICAL: the HAPI @Child name for that field is "fhir" (NOT "fhirPractitionerDetails")
        // — confirmed by decompiling org.smartregister:fhir-common-utils. The parser reads the
        // JSON key "fhir"; any other key is silently ignored and the field stays null.
        fhir: { id: pid, practitionerId: pid },
        contained,
      } }],
    });
  } catch (err) {
    logger.error(`PractitionerDetail error for ${kcUuid}: ${err.message}`);
    return res.json(emptyBundle()); // never break login
  }
});

module.exports = router;
