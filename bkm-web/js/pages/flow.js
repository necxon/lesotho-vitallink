/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function renderFlow(el) {
  el.innerHTML = `
<style>
.flow-wrap {
  font-family: "Roboto", sans-serif;
  padding: 24px;
  background: #f3f5f7;
  min-height: calc(100vh - 96px);
}
.flow-page-title { font-size: 18px; font-weight: 600; color: #212934; margin-bottom: 4px; }
.flow-page-sub   { font-size: 12px; color: #6b7a8d; margin-bottom: 28px; }

.flow-event { background: #fff; border: 1px solid #e1e2e4; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
.flow-event-header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #e1e2e4; }
.flow-event-num { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
.flow-event-title { font-size: 14px; font-weight: 700; color: #212934; }
.flow-event-actor { margin-left: auto; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }
.flow-event-body { padding: 16px 20px; }

.flow-steps { display: flex; flex-direction: column; gap: 0; }
.flow-step { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; position: relative; }
.flow-step:not(:last-child)::after { content: ''; position: absolute; left: 15px; top: 36px; bottom: 0; width: 2px; background: #e1e2e4; }
.flow-step-dot { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; position: relative; z-index: 1; }
.flow-step-content { flex: 1; padding-top: 4px; }
.flow-step-label { font-size: 13px; font-weight: 600; color: #212934; line-height: 1.3; }
.flow-step-detail { font-size: 11px; color: #6b7a8d; margin-top: 2px; line-height: 1.4; }

.flow-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.flow-tag { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; letter-spacing: .3px; text-transform: uppercase; }
.tag-lmis    { background: #ebf8ff; color: #2b6cb0; }
.tag-fhir    { background: #f0fff4; color: #276749; }
.tag-dhis    { background: #fff5f5; color: #c53030; }
.tag-openhim { background: #faf5ff; color: #553c9a; }
.tag-android { background: #fffaf0; color: #744210; }
.tag-task    { background: #fefcbf; color: #744210; }

.ev-order    .flow-event-num    { background: #ebf8ff; color: #2b6cb0; }
.ev-order    .flow-event-header { border-left: 4px solid #4299e1; }
.ev-order    .flow-event-actor  { background: #ebf8ff; color: #2b6cb0; }
.ev-receipt  .flow-event-num    { background: #fffaf0; color: #744210; }
.ev-receipt  .flow-event-header { border-left: 4px solid #ed8936; }
.ev-receipt  .flow-event-actor  { background: #fffaf0; color: #744210; }
.ev-dispense .flow-event-num    { background: #f0fff4; color: #276749; }
.ev-dispense .flow-event-header { border-left: 4px solid #48bb78; }
.ev-dispense .flow-event-actor  { background: #f0fff4; color: #276749; }

.dot-order   { background: #ebf8ff; }
.dot-receipt { background: #fffaf0; }
.dot-dispense{ background: #f0fff4; }

.flow-note { background: #fffff0; border: 1px solid #f6e05e; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #744210; margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start; }

@media print {
  nav, #flow-tabs-bar, #flow-export { display: none !important; }
  #flow-content { display: block !important; }
  .flow-wrap { padding: 12px; background: #fff !important; }
  .flow-event { break-inside: avoid; }
  @page { size: A4 landscape; margin: 12mm; }
}
</style>

<div id="flow-tabs-bar" class="page-tabs" style="margin-bottom:0;padding:0 24px;background:#fff;border-bottom:1px solid #e1e2e4">
  <button class="page-tab active" data-tab="flow-content">Flow</button>
  <button class="page-tab" data-tab="flow-export">&#8681; Export</button>
</div>

<!-- ── FLOW CONTENT ── -->
<div id="flow-content">
<div class="flow-wrap">
  <div class="flow-page-title">Production Stock Flow — Lesotho Health System</div>
  <div class="flow-page-sub">All stock events are per-facility. Each performer is mapped to a specific OpenLMIS facility ID via mappings.json.</div>

  <div class="flow-note">
    ⚠️ <span><strong>Per-facility tracking:</strong> every OpenLMIS stock event carries the performer's <code>facilityId</code> from
    mappings.json — CREDIT and DEBIT events hit only that facility's stock card. Only facility workers can place orders;
    the order questionnaire is not assigned to VHW role in the Android app config.</span>
  </div>

  <!-- EVENT 1 -->
  <div class="flow-event ev-order">
    <div class="flow-event-header">
      <div class="flow-event-num">1</div>
      <div class="flow-event-title">Facility Worker Orders Stock</div>
      <div class="flow-event-actor">👷 Facility Worker</div>
    </div>
    <div class="flow-event-body"><div class="flow-steps">
      <div class="flow-step">
        <div class="flow-step-dot dot-order">📱</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Facility worker submits stock-order QuestionnaireResponse on Android app</div>
          <div class="flow-step-detail">Questionnaire type = ORDER; includes medicine code + quantity needed. Only facility workers receive this questionnaire at login.</div>
          <div class="flow-tags"><span class="flow-tag tag-android">BKM Android</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-order">🔀</div>
        <div class="flow-step-content">
          <div class="flow-step-label">OpenHIM intercepts → routes to BKM mediator</div>
          <div class="flow-step-detail">Channel: POST /fhir/QuestionnaireResponse → mediator port 3000</div>
          <div class="flow-tags"><span class="flow-tag tag-openhim">OpenHIM</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-order">📦</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Mediator buffers order into current period batch</div>
          <div class="flow-step-detail">Orders accumulate per (medicine, org-unit) per calendar month; batched dispatch avoids duplicate requisitions.</div>
          <div class="flow-tags"><span class="flow-tag tag-lmis">Order Buffer</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-order">🏭</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Batch dispatched to OpenLMIS as a stock event (DEBIT — Consumed)</div>
          <div class="flow-step-detail">POST /api/stockEvents with facilityId + orderableId + quantity; stock on hand reduced at that facility. DHIS2 SOH synced.</div>
          <div class="flow-tags"><span class="flow-tag tag-lmis">OpenLMIS DEBIT</span><span class="flow-tag tag-dhis">DHIS2 SOH sync</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-order">✅</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Facility Worker Task created in HAPI FHIR (status: requested)</div>
          <div class="flow-step-detail">One Task per (facility, medicine) assigned to the facility worker — device picks it up on next sync.</div>
          <div class="flow-tags"><span class="flow-tag tag-task">FHIR Task</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
    </div></div>
  </div>

  <!-- EVENT 2 -->
  <div class="flow-event ev-receipt">
    <div class="flow-event-header">
      <div class="flow-event-num">2</div>
      <div class="flow-event-title">Stock Arrives — Facility Worker Accepts Delivery</div>
      <div class="flow-event-actor">👷 Facility Worker</div>
    </div>
    <div class="flow-event-body"><div class="flow-steps">
      <div class="flow-step">
        <div class="flow-step-dot dot-receipt">📱</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Facility worker opens pending Task on Android app and confirms receipt quantity</div>
          <div class="flow-step-detail">Submits stock-acceptance QuestionnaireResponse (qn-stock-accept-delivery); links to Task via basedOn. Partial receipt supported — creates a follow-up Task for outstanding balance.</div>
          <div class="flow-tags"><span class="flow-tag tag-android">BKM Android</span><span class="flow-tag tag-task">FHIR Task ref</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-receipt">🔀</div>
        <div class="flow-step-content">
          <div class="flow-step-label">OpenHIM intercepts → routes to BKM mediator</div>
          <div class="flow-step-detail">Channel: POST /fhir/QuestionnaireResponse; mediator identifies type = RECEIPT + role = facility_worker.</div>
          <div class="flow-tags"><span class="flow-tag tag-openhim">OpenHIM</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-receipt">🏭</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Mediator posts CREDIT to OpenLMIS for this facility</div>
          <div class="flow-step-detail">POST /api/stockEvents with isReceipt=true (Receipts reason); SOH rises at the specific facilityId mapped to this facility worker.</div>
          <div class="flow-tags"><span class="flow-tag tag-lmis">OpenLMIS CREDIT</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-receipt">✅</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Facility Worker Task marked completed in HAPI FHIR</div>
          <div class="flow-step-detail">Task.status = completed — prevents duplicate acceptance; Task disappears from device on next sync.</div>
          <div class="flow-tags"><span class="flow-tag tag-task">FHIR Task</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-receipt">📨</div>
        <div class="flow-step-content">
          <div class="flow-step-label">VHW Tasks created for every field worker at this facility</div>
          <div class="flow-step-detail">One Task per (VHW, medicine) with status = requested; VHWs see the notification on next Android sync that stock is available for collection.</div>
          <div class="flow-tags"><span class="flow-tag tag-task">FHIR Task fan-out</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
    </div></div>
  </div>

  <!-- EVENT 3 -->
  <div class="flow-event ev-dispense">
    <div class="flow-event-header">
      <div class="flow-event-num">3</div>
      <div class="flow-event-title">VHW Dispenses Medicine to Patient</div>
      <div class="flow-event-actor">👩‍⚕️ Village Health Worker</div>
    </div>
    <div class="flow-event-body"><div class="flow-steps">
      <div class="flow-step">
        <div class="flow-step-dot dot-dispense">📱</div>
        <div class="flow-step-content">
          <div class="flow-step-label">VHW records dispense on Android app</div>
          <div class="flow-step-detail">MedicationDispense FHIR resource or dispense QuestionnaireResponse; includes patient reference, medicine code, quantity dispensed.</div>
          <div class="flow-tags"><span class="flow-tag tag-android">BKM Android</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-dispense">🔀</div>
        <div class="flow-step-content">
          <div class="flow-step-label">OpenHIM intercepts → routes to BKM mediator</div>
          <div class="flow-step-detail">Channel: POST /fhir/QuestionnaireResponse or /fhir/MedicationDispense; duplicate suppressed within 5-minute idempotency window.</div>
          <div class="flow-tags"><span class="flow-tag tag-openhim">OpenHIM</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-dispense">🏭</div>
        <div class="flow-step-content">
          <div class="flow-step-label">Mediator posts DEBIT to OpenLMIS for the VHW's facility</div>
          <div class="flow-step-detail">POST /api/stockEvents reason = Consumed (DEBIT); SOH reduced at the facilityId mapped to this VHW. Stock check runs first — rejects if SOH insufficient.</div>
          <div class="flow-tags"><span class="flow-tag tag-lmis">OpenLMIS DEBIT</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-dispense">📊</div>
        <div class="flow-step-content">
          <div class="flow-step-label">DHIS2 data value and SOH updated</div>
          <div class="flow-step-detail">Data value set posted to DHIS2 org unit for the VHW's village; Stock-on-Hand synced as aggregationType=LAST data element.</div>
          <div class="flow-tags"><span class="flow-tag tag-dhis">DHIS2 DEBIT</span><span class="flow-tag tag-dhis">SOH sync</span></div>
        </div>
      </div>
      <div class="flow-step">
        <div class="flow-step-dot dot-dispense">✅</div>
        <div class="flow-step-content">
          <div class="flow-step-label">VHW Task marked completed (if dispense was Task-linked)</div>
          <div class="flow-step-detail">If the dispense QR references a Task via basedOn, that Task is completed — closes the loop on the stock allocation.</div>
          <div class="flow-tags"><span class="flow-tag tag-task">FHIR Task</span><span class="flow-tag tag-fhir">HAPI FHIR</span></div>
        </div>
      </div>
    </div></div>
  </div>

</div>
</div><!-- #flow-content -->

<!-- ── EXPORT TAB ── -->
<div id="flow-export" hidden style="padding:32px 24px;background:#f3f5f7;min-height:calc(100vh - 96px)">
  <div style="max-width:560px">
    <div style="font-size:16px;font-weight:700;color:#212934;margin-bottom:6px">Export Flow</div>
    <div style="font-size:13px;color:#6b7a8d;margin-bottom:24px">Save the production stock flow as a PDF or copy as plain text.</div>

    <div style="background:#fff;border:1px solid #e1e2e4;border-radius:10px;padding:24px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:#212934;margin-bottom:4px">&#128438; Save as PDF</div>
      <div style="font-size:12px;color:#6b7a8d;margin-bottom:16px">Opens the browser print dialog — choose <em>Save as PDF</em> as the destination. Formatted for A4 landscape.</div>
      <button onclick="exportFlowPdf()" class="btn" style="background:#1565c0;color:#fff;border:none;padding:8px 20px;font-size:13px;border-radius:6px;cursor:pointer">&#128438; Print / Save as PDF</button>
    </div>

    <div style="background:#fff;border:1px solid #e1e2e4;border-radius:10px;padding:24px">
      <div style="font-size:13px;font-weight:700;color:#212934;margin-bottom:4px">&#128203; Copy as Plain Text</div>
      <div style="font-size:12px;color:#6b7a8d;margin-bottom:16px">Copies a structured text summary to your clipboard — paste into Word, email or any document.</div>
      <button onclick="exportFlowText()" class="btn btn-outline" style="padding:8px 20px;font-size:13px;border-radius:6px;cursor:pointer">&#128203; Copy to Clipboard</button>
      <span id="flow-copy-ok" style="display:none;margin-left:12px;font-size:12px;color:#276749;font-weight:600">&#10003; Copied!</span>
    </div>
  </div>
</div>`;

  // Wire up tab switching
  el.querySelectorAll('#flow-tabs-bar .page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('#flow-tabs-bar .page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('flow-content').hidden = (target !== 'flow-content');
      document.getElementById('flow-export').hidden  = (target !== 'flow-export');
    });
  });
}

function exportFlowPdf() {
  var style = document.createElement('style');
  style.id = 'flow-print-style';
  style.textContent = '@media print { nav, #flow-tabs-bar, #flow-export { display:none!important } #flow-content { display:block!important } .flow-wrap { padding:12px; background:#fff!important } .flow-event { break-inside:avoid } @page { size:A4 landscape; margin:12mm } }';
  document.head.appendChild(style);
  window.print();
  setTimeout(function() { var s = document.getElementById('flow-print-style'); if (s) s.remove(); }, 1000);
}

function exportFlowText() {
  var lines = [
    'PRODUCTION STOCK FLOW — LESOTHO HEALTH SYSTEM',
    '==============================================',
    '',
    'EVENT 1: Facility Worker Orders Stock',
    '--------------------------------------',
    '1. Facility worker submits stock-order QuestionnaireResponse on Android app (type=ORDER).',
    '   Only facility workers receive this questionnaire at login.',
    '2. OpenHIM intercepts and routes to BKM mediator.',
    '3. Mediator buffers order into the current period batch (per medicine, per org-unit, per month).',
    '4. Batch dispatched to OpenLMIS as a stock event (DEBIT — Consumed) at that facility. DHIS2 SOH synced.',
    '5. FHIR Task created for the facility worker in HAPI FHIR (status: requested).',
    '',
    'EVENT 2: Stock Arrives — Facility Worker Accepts Delivery',
    '----------------------------------------------------------',
    '1. Facility worker opens pending Task on Android app and confirms receipt quantity.',
    '   Partial receipt supported — a follow-up Task is created for any outstanding balance.',
    '2. OpenHIM intercepts and routes to BKM mediator (type=RECEIPT, role=facility_worker).',
    '3. Mediator posts CREDIT to OpenLMIS for this specific facility (SOH rises).',
    '4. Facility Worker Task marked completed in HAPI FHIR (prevents duplicate acceptance).',
    '5. VHW Tasks created for every field worker at this facility (status: requested).',
    '',
    'EVENT 3: VHW Dispenses Medicine to Patient',
    '-------------------------------------------',
    '1. VHW records dispense on Android app (MedicationDispense or dispense QR).',
    '2. OpenHIM intercepts and routes to BKM mediator. Duplicates suppressed (5-min window).',
    '3. Mediator posts DEBIT to OpenLMIS for the VHW\'s mapped facility (Consumed reason).',
    '   Stock check runs first — request rejected if SOH insufficient.',
    '4. DHIS2 data value and Stock-on-Hand updated for the VHW\'s village org unit.',
    '5. VHW Task marked completed if the dispense was linked to a Task via basedOn.',
    '',
    'NOTES',
    '------',
    '- All stock events are per-facility. Each performer maps to a specific OpenLMIS facilityId',
    '  via mappings.json. CREDIT and DEBIT events hit only that facility\'s stock card.',
    '- Unknown performers are rejected (REJECT_UNKNOWN_PERFORMER = true).',
  ];
  var text = lines.join('\n');
  var ok = document.getElementById('flow-copy-ok');
  var show = function() { if (ok) { ok.style.display = 'inline'; setTimeout(function() { ok.style.display = 'none'; }, 2500); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(show);
  } else {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); show();
  }
}
