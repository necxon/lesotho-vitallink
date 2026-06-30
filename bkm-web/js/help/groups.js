/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function groupsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR Group</strong> resources. Groups associate a set of patients with a ' +
      'managing organisation or village, forming patient panels for VHW catchment areas. ' +
      'Each VHW village has one group containing the patients they are responsible for.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Group display name (e.g. "Ha Mokoena Patients")</td></tr>' +
          '<tr><td><strong>Type</strong></td><td>FHIR group type — always <em>person</em> for patient groups</td></tr>' +
          '<tr><td><strong>Members</strong></td><td>Count of patients in the group (<code>Group.quantity</code>)</td></tr>' +
          '<tr><td><strong>Managing Entity</strong></td><td>Organisation responsible for this group (usually the facility)</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Reads from HAPI FHIR: <code>GET /fhir/Group?_count=100</code>. Click a group name to view its members.</p>' +
    '</div>'
  );
}
