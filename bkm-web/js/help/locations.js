/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function locationsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR Location</strong> resources. Locations form a hierarchy used to ' +
      'organise facilities and villages: <strong>Country → District → Facility → Village</strong>. ' +
      'VHW org units in the mediator map to village-level Location IDs so that stock orders are ' +
      'attributed to the right catchment area.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Location display name</td></tr>' +
          '<tr><td><strong>Type</strong></td><td>Physical type: country, district, facility, village, etc.</td></tr>' +
          '<tr><td><strong>Parent</strong></td><td>Parent location resolved from <code>Location.partOf</code></td></tr>' +
          '<tr><td><strong>Status</strong></td><td>active / inactive / suspended</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Facility types</h4>' +
      '<p>Every facility in the hierarchy is classified as one of two types:</p>' +
      '<table>' +
        '<thead><tr><th>Type</th><th>FHIR code</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Hospital</strong></td><td><code>HOSP</code></td><td>Has inpatient beds and 24-hour care — district hospitals, referral hospitals, mission hospitals (e.g. Berea Hospital, Scott Hospital, Seboche Hospital)</td></tr>' +
          '<tr><td><strong>Health Centre</strong></td><td><code>HC</code></td><td>Primary or outpatient care only — health centres, clinics, health posts (e.g. Roma Clinic, Maqhaka HC, Sani HP)</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">Non-facility levels use <code>AREA</code> (district) and <code>COMM</code> (village/community).</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>National hierarchy</h4>' +
      '<p>All 10 Lesotho districts are seeded with their main hospitals and representative health centres:</p>' +
      '<table>' +
        '<thead><tr><th>District</th><th>Main Hospital</th><th>Other Hospital</th><th>HCs / Clinics</th></tr></thead>' +
        '<tbody>' +
          '<tr><td>Maseru</td><td>Maseru District Hospital, Queen Mamohato Memorial</td><td>Scott Hospital</td><td>Roma Clinic, Semonkong HC, Thetsane HC</td></tr>' +
          '<tr><td>Berea</td><td>Berea Hospital (Teyateyaneng)</td><td>Maluti Adventist Hospital</td><td>Maqhaka, Khubetsoana, Mapheleng</td></tr>' +
          '<tr><td>Butha-Buthe</td><td>Butha-Buthe Hospital</td><td>Seboche Hospital</td><td>Fobane, Motete</td></tr>' +
          '<tr><td>Leribe</td><td>Motebang Hospital (Hlotse)</td><td>Mamohau Hospital</td><td>Hlotse, Maputsoe, Tsikoane</td></tr>' +
          '<tr><td>Mafeteng</td><td>Mafeteng Hospital</td><td>—</td><td>Mohalalitoe, Ramabanta, Mafeteng Urban Clinic</td></tr>' +
          '<tr><td>Mohale\'s Hoek</td><td>Mohale\'s Hoek Hospital</td><td>—</td><td>Moyeni, Sekake</td></tr>' +
          '<tr><td>Mokhotlong</td><td>Mokhotlong Hospital</td><td>—</td><td>Mapholaneng, Sani HP</td></tr>' +
          '<tr><td>Qacha\'s Nek</td><td>Qacha\'s Nek Hospital</td><td>—</td><td>Qacha\'s Nek HC, Marakabei</td></tr>' +
          '<tr><td>Quthing</td><td>Quthing Hospital</td><td>—</td><td>Mount Moorosi, Mphaki</td></tr>' +
          '<tr><td>Thaba-Tseka</td><td>Thaba-Tseka Hospital</td><td>—</td><td>Katse, Thaba-Tseka Rural HC</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px;font-size:11px;color:var(--dhis2-text-muted)">Note: facility counts are representative, not exhaustive. Most primary facilities are run by the Government or CHAL (Christian Health Association of Lesotho).</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Maseru catchment detail</h4>' +
      '<p><code>loc-lesotho</code> → <code>loc-maseru-district</code> → <code>loc-maseru-clinic-a</code> → ' +
      '<code>loc-ha-mokoena</code>, <code>loc-ha-sehlabane</code>, <code>loc-matsieng</code></p>' +
      '<p>Data source: <code>GET /fhir/Location?_count=200</code></p>' +
    '</div>'
  );
}
