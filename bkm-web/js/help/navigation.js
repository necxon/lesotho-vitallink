/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function navigationHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>The <strong>App Navigation</strong> page controls the side-drawer menu on the Android BKM app. ' +
      'Each menu item links to a FHIR Questionnaire (form) that opens when the VHW taps it. ' +
      'Changes here are stored in a FHIR Binary resource and picked up by the app on next sync.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>How is it stored?</h4>' +
      '<p>The menu config lives in a single <strong>FHIR Binary</strong> resource ' +
      '(ID&nbsp;<code>d7ce0167-ee6a-4f8f-b644-50b0242513239e</code>) on HAPI FHIR (port 8079). ' +
      'It is a JSON document with a <code>staticMenu</code> array — one object per menu item. ' +
      'This portal reads and writes that document directly via PUT.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Menu item fields</h4>' +
      '<table class="help-table"><thead><tr><th>Field</th><th>What it controls</th></tr></thead><tbody>' +
        '<tr><td><strong>Display name</strong></td><td>Label shown in the app side menu</td></tr>' +
        '<tr><td><strong>Icon</strong></td><td>Icon rendered next to the label (mapped from <code>ic_*</code> refs)</td></tr>' +
        '<tr><td><strong>Form (Questionnaire)</strong></td><td>The FHIR Questionnaire that launches when the item is tapped</td></tr>' +
        '<tr><td><strong>Save button text</strong></td><td>Label on the submit button inside the form (default: Submit)</td></tr>' +
        '<tr><td><strong>Set practitioner details</strong></td><td>Auto-fills the logged-in VHW\'s details into the form before display</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Applying changes to a device</h4>' +
      '<ol style="margin:0;padding-left:20px;font-size:13px">' +
        '<li>Save the change here (the Binary is updated immediately).</li>' +
        '<li>On the Android device, open the app and trigger a FHIR sync.</li>' +
        '<li>If the menu does not update, clear app data and re-enter the <code>app-composition</code> config to force a full reload.</li>' +
      '</ol>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>HAPI FHIR &mdash; <code>GET /fhir/Binary/' + NAV_BINARY_ID + '</code> (port 8079). ' +
      'Forms list from <code>GET /fhir/Questionnaire</code>.</p>' +
    '</div>'
  );
}
