/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function fhirHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>A live browser for all <strong>FHIR R4 resources</strong> stored in <strong>HAPI FHIR</strong> ' +
      '(port 8079). It has two tabs:</p>' +
      '<ul>' +
        '<li><strong>Explorer</strong> — click any resource-type chip to inspect raw records. ' +
        'The count badge on each chip is fetched on page load using <code>?_summary=count</code>.</li>' +
        '<li><strong>Stock by Facility</strong> — a pre-built view that cross-references commodity ' +
        '<code>Group</code> resources, stock <code>Observation</code>s, and <code>MeasureReport</code>s ' +
        'to show Balance / AMC / MOS / Status per commodity for every facility. ' +
        'Each facility row is collapsed by default; click to expand.</li>' +
      '</ul>' +
      '<p>HAPI FHIR is the clinical and administrative backbone of this sandbox — the Android BKM app ' +
      'reads and writes FHIR resources here, and the mediator resolves practitioner → facility/village ' +
      'mappings from PractitionerRole records.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Stock by Facility — how it works</h4>' +
      '<p>The tab fetches four resource types and joins them in the browser:</p>' +
      '<table>' +
        '<thead><tr><th>Resource</th><th>Query</th><th>Used for</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><code>Organization</code></td><td><code>?_count=100</code></td><td>Facility names</td></tr>' +
          '<tr><td><code>Group</code></td><td><code>?type=device&amp;_count=200</code></td><td>Commodity names (one Group per medicine)</td></tr>' +
          '<tr><td><code>Observation</code></td><td><code>?status=preliminary&amp;_count=500</code></td>' +
            '<td>Stock balance — <code>subject</code> = Group, <code>performer</code> = Organization, ' +
            '<code>component.valueQuantity.value</code> = units on hand</td></tr>' +
          '<tr><td><code>MeasureReport</code></td><td><code>?_count=200</code></td>' +
            '<td>Average Monthly Consumption (AMC) — stored as a contained <code>Medication.code.coding[0].code</code></td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">MOS (Months of Stock) = Balance ÷ AMC. Status thresholds:</p>' +
      '<ul>' +
        '<li><strong style="color:#DD0000">Stockout</strong> — MOS &le; 0.5</li>' +
        '<li><strong style="color:#FFA500">Understock</strong> — MOS &lt; 1</li>' +
        '<li><strong style="color:#38B500">Satisfactory</strong> — MOS 1–3</li>' +
        '<li><strong style="color:#006EB8">Overstock</strong> — MOS &gt; 3</li>' +
      '</ul>' +
      '<p>Commodities are seeded by <code>scripts/seed_inventory.py</code> and the Group JSON files ' +
      'in <code>config/fhir-bkm/fhir_content/group/commodities/</code>. ' +
      'Re-run <code>python scripts/seed_inventory.py</code> after a <code>make reset</code> to restore balances.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Explorer — resource types</h4>' +
      '<table>' +
        '<thead><tr><th>Type</th><th>What it stores</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Patient</strong></td><td>Community members registered in the BKM system — selected by VHWs when dispensing</td></tr>' +
          '<tr><td><strong>Practitioner</strong></td><td>Health workers: VHWs, facility workers, supervisors</td></tr>' +
          '<tr><td><strong>PractitionerRole</strong></td><td>Links a Practitioner to an Organization and Location; defines their role code</td></tr>' +
          '<tr><td><strong>Organization</strong></td><td>Health facilities (e.g. Maseru District Clinic A)</td></tr>' +
          '<tr><td><strong>Location</strong></td><td>Geographic hierarchy: country → district → facility → village</td></tr>' +
          '<tr><td><strong>Group</strong></td><td>Two uses: (1) patient panels assigned to a VHW catchment area; (2) commodity groups (<code>type=device</code>) used by the inventory system</td></tr>' +
          '<tr><td><strong>CareTeam</strong></td><td>Groups of practitioners working together under a supervisor</td></tr>' +
          '<tr><td><strong>Observation</strong></td><td>Stock balance records — one per commodity per facility, updated by <code>seed_inventory.py</code> or when a dispense is recorded through the app</td></tr>' +
          '<tr><td><strong>MeasureReport</strong></td><td>Average Monthly Consumption (AMC) — one per commodity, shared across facilities</td></tr>' +
          '<tr><td><strong>Questionnaire</strong></td><td>Form definitions used by the Android app (dispense, receipt, order, adjustment)</td></tr>' +
          '<tr><td><strong>QuestionnaireResponse</strong></td><td>Completed form submissions from the Android app — trigger the mediator fan-out pipeline</td></tr>' +
          '<tr><td><strong>MedicationDispense</strong></td><td>Direct dispense events (alternative entry point to the mediator alongside QR)</td></tr>' +
          '<tr><td><strong>Task</strong></td><td>Stock-issue instructions sent to a practitioner\'s device (created by the mediator after dispatch)</td></tr>' +
          '<tr><td><strong>Binary / ImplementationGuide</strong></td><td>App configuration bundles and FHIR IG metadata loaded by the Android app on first sync</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Delete buttons</h4>' +
      '<p>The red buttons in the page header bulk-delete all resources of that type from HAPI FHIR. ' +
      'Use with care — deletions are immediate and cannot be undone without running <code>make seed</code>.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>All reads use <code>GET http://localhost:8079/fhir/{ResourceType}</code> ' +
      'authenticated via the Keycloak token (opensrp realm, opensrp-admin user). ' +
      'The dedicated pages (Patients, Practitioners, Locations, etc.) in the sidebar provide ' +
      'richer views with create/edit/delete for each type.</p>' +
    '</div>'
  );
}
