/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function mappingsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>The <strong>Mappings</strong> page controls how the mediator translates BKM app identifiers ' +
      'into OpenLMIS and DHIS2 identifiers at fan-out time. ' +
      'Changes take effect immediately — no container restart needed.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>New Field Worker</h4>' +
      '<p>Creates a complete user account in one step — no need to visit Keycloak or HAPI FHIR separately.</p>' +
      '<table class="help-table"><thead><tr><th>What gets created</th><th>Details</th></tr></thead><tbody>' +
        '<tr><td>Keycloak login</td><td>User can immediately log into the Android app with the chosen username and password</td></tr>' +
        '<tr><td>FHIR Practitioner</td><td>Resource stored in HAPI FHIR, linked to the Keycloak user UUID via identifier</td></tr>' +
        '<tr><td>Staff member mapping</td><td>Entry added to this Staff Members table so dispenses fan out to OpenLMIS and DHIS2</td></tr>' +
      '</tbody></table>' +
      '<p style="margin-top:8px;font-size:12px;color:#4a5768">' +
        '<strong>DHIS2 Org Unit</strong> defaults to <code>dwx1Yz4BwNX</code> (Maseru Clinic A). ' +
        'Change it after creation via the Edit button if the worker is based at a village (VilHaMokoe1, VilHaSehl01, VilMatsien1).' +
      '</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Staff Members tab</h4>' +
      '<p>Maps a FHIR Practitioner ID (e.g. <code>Practitioner/93b47b21-7311-416a-a6a4-7be8426b1fc3</code>) to the facility, ' +
      'DHIS2 org unit, role, and contact details used when that worker submits a dispense, order, or receipt. ' +
      'Entries here override the bundled <code>mappings.json</code>.</p>' +
      '<table class="help-table"><thead><tr><th>Field</th><th>Used for</th></tr></thead><tbody>' +
        '<tr><td>Role</td><td>' +
          '<code>vhw</code> — village health worker: dispense to patients + accept internal stock; <strong>cannot</strong> place orders<br>' +
          '<code>coordinator</code> — facility coordinator: place orders, requisition, accept stock, allocate to VHWs (top facility role)' +
        '</td></tr>' +
        '<tr><td>Facility Name / ID</td><td>Human label and OpenLMIS facility UUID — stock events and order checks are scoped to this facility</td></tr>' +
        '<tr><td>DHIS2 Org Unit</td><td>11-char DHIS2 UID — dispensing data values are posted to this org unit</td></tr>' +
        '<tr><td>Phone / Email</td><td>Used for SMS / email notifications when stock runs low</td></tr>' +
      '</tbody></table>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Medicine Aliases tab</h4>' +
      '<p>Maps BKM app medication codes (e.g. <code>AL-20-120</code>) to OpenLMIS orderable UUIDs. ' +
      'The mediator resolves codes in this order:</p>' +
      '<ol style="margin:0;padding-left:20px;font-size:13px">' +
        '<li>Explicit alias stored here</li>' +
        '<li>Live lookup against OpenLMIS product codes (auto-refreshed)</li>' +
        '<li>Env var fallback: <code>OPENLMIS_ORDERABLE_ID</code></li>' +
      '</ol>' +
    '</div>' +

    /* '↺ Sync from FHIR' help section removed (button commented out per request):
    '<div class="help-section">' +
      '<h4>↺ Sync from FHIR</h4>' +
      '<p>Fetches all Practitioners (and their PractitionerRoles) from HAPI FHIR and adds any not yet in the ' +
      'Staff Members table. Existing entries are <strong>not</strong> overwritten — safe to run at any time. ' +
      'Use this after creating a user in Keycloak or OpenSRP to pull them in automatically. ' +
      'New entries arrive with an empty Facility ID and DHIS2 Org Unit — fill those in before the worker goes live.</p>' +
    '</div>' +
    */

    '<div class="help-section">' +
      '<h4>⬇ Export JSON</h4>' +
      '<p>Downloads the live Staff Members and Medicine Aliases as <code>mappings.json</code>. ' +
      'The file reflects the <em>merged</em> state: boot defaults from <code>mappings.json</code> on disk ' +
      'plus any runtime overrides saved via this UI. ' +
      'Use it to back up your mappings, migrate to another environment, or edit offline and re-import.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>⬆ Import JSON</h4>' +
      '<p>Uploads a <code>mappings.json</code> file and upserts every entry into the live store <strong>immediately</strong> — ' +
      'no mediator restart needed. Both in-memory maps and the persistent store are updated in the same request. ' +
      'Existing entries are overwritten; entries not present in the file are left untouched.</p>' +
      '<p>Expected format (same as Export output):</p>' +
      '<pre style="background:#f5f7fa;border-radius:4px;padding:8px;font-size:11px;overflow:auto">{\n' +
      '  "performers": [\n' +
      '    { "sourceId": "Practitioner/…", "facilityId": "…", "programId": "…",\n' +
      '      "dhis2OrgUnit": "…", "name": "…", "role": "vhw", "phone": "…", "email": "…" }\n' +
      '  ],\n' +
      '  "medications": [\n' +
      '    { "sourceId": "AL-20-120", "orderableId": "3be1d20f-…" }\n' +
      '  ]\n' +
      '}</pre>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Runtime overrides are stored in <code>/data/mappings-store.json</code> inside the mediator container ' +
      'and survive container restarts. The file <code>mappings.json</code> (mounted at <code>/app/mappings.json</code>) ' +
      'provides the boot-time defaults; the store is merged on top at startup. ' +
      'Both are wiped by <code>make reset</code>.</p>' +
    '</div>'
  );
}
