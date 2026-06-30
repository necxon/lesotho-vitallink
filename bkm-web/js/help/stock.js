/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function stockHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>Data Source</h4>' +
      '<p>Stock data is read from <strong>OpenLMIS stockmanagement</strong> ' +
      '(<a href="http://localhost:8082" target="_blank">localhost:8082</a>) using two APIs:</p>' +
      '<ul>' +
        '<li><code>GET /api/stockCardSummaries?facility=…&program=…</code> &mdash; current Stock on Hand per product</li>' +
        '<li><code>GET /api/stockCards/{id}</code> &mdash; full transaction line history per stock card</li>' +
      '</ul>' +
      '<p><strong>Facility:</strong> Maseru District Clinic A &nbsp;(<code>28de536f-b826-…</code>)<br>' +
      '<strong>Program:</strong> Essential Medicines &nbsp;(<code>31ef5fd8-cef9-…</code>)</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>How a Dispense Gets Here</h4>' +
      '<div class="help-flow">' +
        '<span class="flow-step">Android BKM app<small>VHW records dispense</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step">OpenHIM channel<small>port 5001</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step">bkm-mediator<small>FHIR fan-out</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step">OpenLMIS<small>stockEvent (DEBIT)</small></span>' +
      '</div>' +
      '<p>Each <code>MedicationDispense</code> FHIR resource posted to the OpenHIM channel triggers a ' +
      '<code>POST /api/stockEvents</code> in OpenLMIS with reason <em>Consumed</em> (DEBIT). ' +
      'After every successful event the mediator also pushes the updated Stock on Hand value to ' +
      'DHIS2 (data element <code>StockOnHnd1</code>), keeping the SOH line chart in sync.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Transaction Types</h4>' +
      '<table>' +
        '<thead><tr><th>OpenLMIS type</th><th>Reason name</th><th>Meaning</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><span class="badge green">CREDIT</span></td><td>Receipts</td>' +
              '<td>Stock received at the facility (warehouse resupply or initial load)</td></tr>' +
          '<tr><td><span class="badge red">DEBIT</span></td><td>Consumed</td>' +
              '<td>Medicines dispensed to a patient by a VHW in the field</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Stock on Hand Thresholds</h4>' +
      '<p>OpenLMIS maintains a running balance. The large number on each product card is the current SOH ' +
      'after all transactions. Status colours used on this page:</p>' +
      '<ul>' +
        '<li><strong style="color:#2e7d32">Adequate</strong> &mdash; 100 or more units on hand</li>' +
        '<li><strong style="color:#e65100">Low stock</strong> &mdash; 1&ndash;99 units; consider resupply</li>' +
        '<li><strong style="color:#c62828">Stock-out</strong> &mdash; 0 units; no stock available for dispensing</li>' +
      '</ul>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>App Inventory tab</h4>' +
      '<p>The <strong>App Inventory</strong> tab shows commodity balances as stored in <strong>HAPI FHIR</strong> — ' +
      'specifically as <code>Observation</code> resources attached to commodity <code>Group</code> resources. ' +
      'This is the view the <strong>Android BKM app reads</strong> when a VHW checks stock availability before dispensing.</p>' +
      '<p>It is a <em>separate, parallel</em> inventory from OpenLMIS. Both are updated when a dispense is recorded through the normal fan-out pipeline, but they can drift apart if stock is adjusted directly in OpenLMIS without going through the mediator.</p>' +
      '<table>' +
        '<thead><tr><th>Field</th><th>Meaning</th><th>Source</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Balance</strong></td><td>Current units on hand at the facility</td><td>FHIR <code>Observation.component.valueQuantity</code></td></tr>' +
          '<tr><td><strong>AMC</strong></td><td>Average Monthly Consumption — historical rate of use (units/month)</td><td>FHIR <code>MeasureReport</code></td></tr>' +
          '<tr><td><strong>MOS</strong></td><td>Months of Stock = Balance ÷ AMC. How many months stock will last at current consumption</td><td>Calculated</td></tr>' +
          '<tr><td><strong>Status</strong></td><td>Stockout (MOS ≤ 0.5), Understock (&lt;1), Satisfactory (1–3), Overstock (&gt;3)</td><td>Calculated from MOS</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">The <strong>Dispense</strong> button on each card records a dispense directly from this view: it posts a <code>MedicationDispense</code> to OpenHIM (fan-out to OpenLMIS + DHIS2) <em>and</em> subtracts the quantity from the FHIR Observation so the app-side balance stays in sync.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>+ Record Dispense Button</h4>' +
      '<p>Opens a form that posts a <code>MedicationDispense</code> FHIR resource directly to the ' +
      'OpenHIM channel, simulating what the Android app does. Useful for manual data entry or testing ' +
      'the fan-out pipeline without the mobile app.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Useful Links</h4>' +
      '<ul>' +
        '<li><a href="http://localhost:8082" target="_blank">OpenLMIS UI</a> &mdash; Full stock management interface &nbsp;(admin / password)</li>' +
        '<li><a href="http://localhost:8081/dhis-web-dashboard/index.html#/BKMDashbrd1" target="_blank">DHIS2 Stock Dashboard</a> &mdash; SOH line chart, dispensing bar chart, full pivot table</li>' +
        '<li><a href="http://localhost:9285" target="_blank">OpenHIM Console</a> &mdash; Inspect raw transaction logs (root@openhim.org / openhim-password)</li>' +
      '</ul>' +
    '</div>'
  );
}
