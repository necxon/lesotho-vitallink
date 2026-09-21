/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function questionnairesHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p><strong>Phone Menus</strong> are <strong>FHIR Questionnaire</strong> resources stored in HAPI FHIR (port 8079). ' +
      'Each phone menu defines a structured set of questions that a VHW fills in on the Android app. ' +
      'Responses are saved as <strong>QuestionnaireResponse</strong> resources and can be reviewed here.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Phone Menu builder</h4>' +
      '<p>Click <strong>+ New Phone Menu</strong> to open the visual builder. You can add questions, ' +
      'group them into sections, mark fields as required, and set the status (draft / active / retired). ' +
      'Active phone menus appear in the App Navigation picker so they can be linked to a menu item.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Importing a form (NLM Form Builder)</h4>' +
      '<p>Instead of building from scratch you can design a form in the ' +
      '<a href="https://formbuilder.nlm.nih.gov/#" target="_blank" rel="noopener"><strong>NLM Form Builder</strong> &#8599;</a> ' +
      '(<code>formbuilder.nlm.nih.gov</code>) — a visual FHIR Questionnaire editor — then bring it in here:</p>' +
      '<ol style="margin:6px 0 8px 18px;line-height:1.7">' +
        '<li>Build / edit the form in the Form Builder.</li>' +
        '<li><strong>Export</strong> it as <strong>FHIR Questionnaire (R4)</strong> JSON (or upload an existing <code>.json</code>).</li>' +
        '<li>Click <strong>&#8593; Import JSON</strong> here, paste or choose the file, and Import.</li>' +
      '</ol>' +
      '<p style="font-size:12px;color:#6b7a8d">The importer auto-converts R5 forms to R4 (item type <code>coding</code>&rarr;<code>choice</code>) and upserts by <code>id</code>. ' +
      'Imported forms appear in this list and sync to the Android app. Note: a <em>dispense</em> only fans out to OpenLMIS if the form carries a medication + quantity; measurement-only forms (e.g. weight/height) are stored but skip the stock fan-out.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Previewing a form the way the phone shows it</h4>' +
      '<p><strong>Fill</strong> renders the form with <a href="https://lhncbc.github.io/lforms/" ' +
      'target="_blank" rel="noopener"><strong>LHC-Forms</strong> &#8599;</a>, the NLM&rsquo;s reference ' +
      'FHIR Questionnaire renderer &mdash; the same engine behind the Form Builder above. So what ' +
      'you see here is what the Form Builder shows, and close to what the phone shows.</p>' +
      '<p>It applies the form&rsquo;s <strong>conditional logic</strong>: questions appear and disappear ' +
      'as you answer, drop-downs and radio buttons honour their display hints, calculated fields ' +
      'compute, and repeating groups repeat. The previous preview did none of that &mdash; it drew ' +
      'every question all the time, so a form the phone shows as 8 questions looked like 22 here.</p>' +
      '<p>It is a close model, not the phone itself: the app runs the Android FHIR SDK&rsquo;s renderer, ' +
      'a different implementation of the same specification. Use this to catch the mistakes that ' +
      'matter &mdash; a question that never appears, a skip that does not fire, an empty drop-down ' +
      '&mdash; and a real device for final sign-off.</p>' +
      '<p>To check every form and menu item at once, on the server: <code>make test-menus</code>.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Question types</h4>' +
      '<table class="help-table"><thead><tr><th>Type</th><th>What it renders on the app</th></tr></thead><tbody>' +
        '<tr><td><code>string</code></td><td>Single-line text input</td></tr>' +
        '<tr><td><code>text</code></td><td>Multi-line text area</td></tr>' +
        '<tr><td><code>integer</code></td><td>Whole number input</td></tr>' +
        '<tr><td><code>decimal</code></td><td>Decimal number input</td></tr>' +
        '<tr><td><code>date</code></td><td>Date picker</td></tr>' +
        '<tr><td><code>dateTime</code></td><td>Date + time picker</td></tr>' +
        '<tr><td><code>boolean</code></td><td>Yes / No checkbox</td></tr>' +
        '<tr><td><code>choice</code></td><td>Dropdown with predefined options</td></tr>' +
        '<tr><td><code>group</code></td><td>Section header — contains sub-questions</td></tr>' +
        '<tr><td><code>display</code></td><td>Read-only label or instruction text</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Linking phone menus to the app</h4>' +
      '<p>Phone menus do not appear in the app automatically. Go to <a href="#/navigation">App Navigation</a> ' +
      'and add a menu item that points to the phone menu. The app loads it when the VHW taps that menu item.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Responses</h4>' +
      '<p>Click <strong>Responses</strong> next to any form to see all submitted answers. ' +
      'Each response is a <code>QuestionnaireResponse</code> resource linked back to the form by ID. ' +
      'You can view the raw FHIR JSON or delete individual responses.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>HAPI FHIR &mdash; <code>GET /fhir/Questionnaire</code> and <code>GET /fhir/QuestionnaireResponse</code> (port 8079).</p>' +
    '</div>'
  );
}
