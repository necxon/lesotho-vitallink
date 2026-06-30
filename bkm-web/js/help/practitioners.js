/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function practitionersHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>A read-only view of all <strong>FHIR Practitioner</strong> resources in HAPI FHIR. ' +
      'Practitioners represent health workers — VHWs, facility workers, and supervisors. ' +
      'You can edit an existing practitioner\'s name, phone, role, and location here, but ' +
      '<strong>you cannot register a new field worker from this page</strong>. See below.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Why can\'t I create a new worker here?</h4>' +
      '<p>A fully functional field worker requires three things to work together:</p>' +
      '<ol style="margin:8px 0 0 16px;line-height:1.8">' +
        '<li><strong>Keycloak account</strong> — login credentials so the person can open the Android app</li>' +
        '<li><strong>FHIR Practitioner + PractitionerRole</strong> — identity record in HAPI FHIR so the app knows their name, facility, and location</li>' +
        '<li><strong>Mediator PERFORMER_MAP entry</strong> — every dispense or receipt event the person submits includes their <code>Practitioner/&lt;id&gt;</code> reference. ' +
        'The mediator\'s <code>resolveIdentity()</code> function looks this up in PERFORMER_MAP to obtain the routing keys used by each downstream system:' +
        '<ul style="margin:6px 0 4px 16px;line-height:1.9">' +
          '<li><code>facilityId</code> + <code>programId</code> — OpenLMIS UUIDs; used to POST a stock event to the correct facility programme. Without these the event fails with a missing-facility error.</li>' +
          '<li><code>dhis2OrgUnit</code> — DHIS2 org unit UID; used to POST the aggregated data value to the correct reporting unit. Without this the data value is skipped or goes to the wrong place.</li>' +
          '<li><code>role</code> — distinguishes VHW from facility worker; governs which business rules apply (e.g. facility workers bypass the allocation check).</li>' +
        '</ul>' +
        'If the practitioner has no PERFORMER_MAP entry and <code>REJECT_UNKNOWN_PERFORMER</code> is enabled, the event is rejected immediately with a <strong>BR-07</strong> unknown-performer error before any fan-out occurs. ' +
        'If the setting is disabled the mediator falls back to the default facility, which may record the event against the wrong facility.</li>' +
      '</ol>' +
      '<p style="margin-top:8px">Creating a Practitioner on this page only does step 2. ' +
      'Without steps 1 and 3 the person <strong>cannot log in</strong> to the Android app and their dispenses ' +
      '<strong>will not be recorded</strong> in OpenLMIS or DHIS2 — they will be rejected with a BR-07 unknown-performer error.</p>' +
      '<p style="margin-top:8px">👉 Use the <strong>+ New Field Worker</strong> button on the ' +
      '<a href="#/mappings">Mappings page</a> instead. That single form creates all three in one step.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>When is editing here appropriate?</h4>' +
      '<p>Use the <strong>Edit</strong> button on an existing row to update a practitioner\'s display name, ' +
      'phone number, role title, or assigned location. These changes are safe — they only update the FHIR ' +
      'resources and do not affect Keycloak credentials or mediator routing.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Full name from <code>Practitioner.name</code></td></tr>' +
          '<tr><td><strong>ID</strong></td><td>FHIR logical ID — referenced as <code>performer.actor.reference</code> in dispense events and matched against the mediator PERFORMER_MAP</td></tr>' +
          '<tr><td><strong>Role</strong></td><td>From linked <code>PractitionerRole.code</code> (e.g. community-health-worker, facility-worker, supervisor)</td></tr>' +
          '<tr><td><strong>Organization</strong></td><td>Facility the practitioner is attached to via <code>PractitionerRole.organization</code></td></tr>' +
          '<tr><td><strong>Location</strong></td><td>Village or catchment site from <code>PractitionerRole.location</code></td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Reads from HAPI FHIR: <code>GET /fhir/Practitioner</code> and <code>GET /fhir/PractitionerRole</code>. ' +
      'Roles are joined client-side by matching <code>PractitionerRole.practitioner.reference</code>. ' +
      'Keycloak account status and mediator mapping status are <em>not</em> shown here — use the ' +
      '<a href="#/mappings">Mappings page</a> to see the full picture.</p>' +
    '</div>'
  );
}
