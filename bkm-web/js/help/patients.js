/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function patientsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR Patient</strong> resources stored in HAPI FHIR (port 8079). ' +
      'Patients represent community members registered in the BKM system. VHWs select a patient ' +
      'on their Android device when recording a medicine dispense.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Patient\'s given + family name from <code>Patient.name</code></td></tr>' +
          '<tr><td><strong>ID</strong></td><td>FHIR logical ID used in MedicationDispense references</td></tr>' +
          '<tr><td><strong>Date of Birth</strong></td><td><code>Patient.birthDate</code></td></tr>' +
          '<tr><td><strong>Age</strong></td><td>Calculated from birthDate</td></tr>' +
          '<tr><td><strong>Gender</strong></td><td><code>Patient.gender</code></td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Reads from HAPI FHIR: <code>GET /fhir/Patient?_count=100&amp;_sort=-_lastUpdated</code>.<br>' +
      'Click a patient name to view their full record and dispense history.</p>' +
    '</div>'
  );
}
