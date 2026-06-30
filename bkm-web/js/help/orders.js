/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function ordersHelpHTML() {
  var tip = 'cursor:help;border-bottom:1px dotted #999';
  return (
    '<div class="help-section">' +
      '<h4>How orders accumulate</h4>' +
      '<div class="help-flow">' +
        '<span class="flow-step" title="A Village Health Worker submits a stock order form on the Android app. The app posts a FHIR QuestionnaireResponse to the FHIR proxy (port 8088), which mirrors it to OpenHIM → mediator.">' +
          'VHW places stock order<small>Android app → FHIR proxy</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" title="The mediator reads the JWT token from the request. Only users with the Keycloak role \'facility_worker\' may place orders. A VHW submitting their own order gets HTTP 403 Forbidden.">' +
          'Mediator validates role<small>facility_worker only; VHWs rejected</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" title="The mediator adds the quantity to the order_buffer table in PostgreSQL (one row per village + medicine + period). Multiple submissions for the same village and medicine are summed. Simultaneously an on-hold FHIR Task is created for the VHW so they can track their order.">' +
          'Buffer + on-hold Task<small>per village · per medicine</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" title="When dispatched (manually via Dispatch Now, or automatically on schedule), the mediator reads the buffer totals and sends one stock requisition line per medicine to OpenLMIS, then creates a receipt Task for the facility worker.">' +
          'Dispatch Now or schedule<small>consolidated to OpenLMIS</small></span>' +
      '</div>' +
      '<p>Stock orders are submitted by <strong title="Facility workers — the health workers based at the clinic who manage stock. Only they have the facility_worker Keycloak role that the mediator requires." style="' + tip + '">facility workers</strong> via the Android app as a ' +
      '<abbr title="FHIR R4 resource — the completed form submission from the Android app. It contains the medicine, quantity, and org unit (village). The mediator reads these fields to update the order buffer." style="' + tip + '">QuestionnaireResponse</abbr>. ' +
      '<abbr title="Village Health Worker — a community-based health worker assigned to a specific village catchment area. VHWs dispense medicine but cannot place stock orders directly; only facility workers can." style="' + tip + '">VHW</abbr> orders are rejected at the mediator ' +
      '(<abbr title="HTTP 403 Forbidden — the mediator checked the JWT and found no facility_worker role. The request is rejected before touching the buffer." style="' + tip + '">HTTP 403</abbr> — only ' +
      '<code title="The Keycloak realm role that grants permission to place stock orders. Assigned to facility-worker accounts in the opensrp realm." style="' + tip + '">facility_worker</code> Keycloak role is permitted). ' +
      'Quantities from multiple orders for the same village and medicine are summed into a single consolidated line per period.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Dispatch process — what actually happens</h4>' +
      '<p><strong title="Dispatch Now triggers FHIR Task creation and transitions VHW tasks, but the actual OpenLMIS stock event only fires when the facility worker accepts the delivery on their Android device." style="' + tip + '">Dispatch Now does NOT immediately update OpenLMIS.</strong> It does two things:</p>' +
      '<ol style="margin:6px 0 10px;padding-left:20px;font-size:14px">' +
        '<li>Creates one FHIR <strong title="A FHIR R4 Task resource with status=\'requested\'. It appears on the Tasks page and syncs to the facility worker\'s Android app on next pull. The task tells the worker which medicine and how many units to expect." style="' + tip + '">Task</strong> ' +
        '(<code title="FHIR Task.status = requested — the task has been sent to the device but not yet acknowledged by the worker." style="' + tip + '">requested</code>) per medicine for the facility worker — visible on the Tasks page.</li>' +
        '<li>Transitions any pending VHW <span style="background:#ede7f6;color:#6a1b9a;padding:1px 5px;border-radius:3px;font-size:12px;' + tip + '" title="FHIR Task.status = on-hold. Created when the facility worker placed the order. Means the VHW\'s order is buffered and waiting for dispatch approval.">Awaiting Approval</span> Tasks to ' +
          '<span style="background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:3px;font-size:12px;' + tip + '" title="FHIR Task.status = in-progress. The order has been dispatched to OpenLMIS. The VHW can see this status in the app — it means their stock request is being fulfilled.">Dispatched</span>.</li>' +
      '</ol>' +
      '<p><strong title="OpenLMIS is updated via a POST /api/stockEvents call only when the facility worker submits the stock-acceptance form on their Android device. Before that, OpenLMIS knows nothing about the order." style="' + tip + '">OpenLMIS is updated when the facility worker accepts the delivery in the Android app.</strong> ' +
      'On acceptance the mediator posts <code title="The OpenLMIS stockmanagement API endpoint. Accepts a JSON body with facilityId, programId, orderableId, quantity, reasonId, and userId." style="' + tip + '">POST /api/stockEvents</code> to OpenLMIS stockmanagement with:</p>' +
      '<table style="margin:6px 0 10px">' +
        '<thead><tr><th>Field</th><th>Value</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><abbr title="The direction of stock movement in OpenLMIS." style="' + tip + '">Event type</abbr></td>' +
          '<td><strong title="CREDIT = stock coming IN to the facility. Increases the Stock on Hand (SOH) count in OpenLMIS by the received quantity." style="' + tip + '">CREDIT</strong> (stock in)</td></tr>' +
          '<tr><td>Reason</td><td><abbr title="The OpenLMIS stock card line item reason used for facility receipts. This UUID is Flyway-seeded and fixed across restarts." style="' + tip + '">Receipts</abbr> &mdash; UUID <code>313f2f5f-0c22-4626-8c49-3554ef763de3</code></td></tr>' +
          '<tr><td>Effect</td><td><abbr title="Stock on Hand — the current quantity of medicine physically available at the facility as recorded in OpenLMIS." style="' + tip + '">Facility SOH</abbr> increases by the quantity received</td></tr>' +
          '<tr><td><abbr title="If the worker receives fewer units than ordered (e.g. 80 of 100), the mediator posts a CREDIT for 80 and creates a new requested Task for the remaining 20." style="' + tip + '">Partial receipt</abbr></td>' +
          '<td>CREDIT posted for received qty; follow-up Task created for outstanding balance</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p>Each <abbr title="A calendar month expressed as YYYYMM (e.g. 202605). All orders placed within the same month are batched together and sent as a single consolidated dispatch." style="' + tip + '">period</abbr> can only be dispatched once — duplicate dispatches are blocked by the <abbr title="A JSON log file stored by the mediator that records which periods have already been dispatched. Prevents double-sending the same batch to OpenLMIS." style="' + tip + '">dispatch log</abbr>. ' +
      'Use <strong>Dispatch Now</strong> (force) to override.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Full OpenLMIS event lifecycle</h4>' +
      '<table>' +
        '<thead><tr><th>Step</th><th>OpenLMIS event</th><th>Type</th><th><abbr title="Stock on Hand — current physical quantity at the facility in OpenLMIS." style="' + tip + '">SOH</abbr> change</th></tr></thead>' +
        '<tbody>' +
          '<tr title="The order is saved to the PostgreSQL order_buffer table. OpenLMIS is not touched at this stage.">' +
            '<td>VHW places stock order</td>' +
            '<td><em>None</em> — buffered in <abbr title="PostgreSQL database (order_buffer table) inside the health-db-postgres container. Stores the running monthly totals per village and medicine. Survives container restarts." style="' + tip + '">PostgreSQL</abbr></td>' +
            '<td>—</td><td>—</td>' +
          '</tr>' +
          '<tr title="Dispatch Now only creates FHIR Tasks and transitions VHW task statuses. The OpenLMIS stock event fires later when the facility worker accepts on-device.">' +
            '<td>Dispatch Now / scheduled dispatch</td>' +
            '<td><em>None</em> — <abbr title="FHIR Task resources (status=requested for facility worker, status=in-progress for VHW tasks) are created in HAPI FHIR. The Android app syncs these on next pull." style="' + tip + '">FHIR Tasks</abbr> created only</td>' +
            '<td>—</td><td>—</td>' +
          '</tr>' +
          '<tr style="background:#e8f5e9" title="This is the step that actually records stock in OpenLMIS. The facility worker submits the acceptance form on the Android app → mediator posts a stockEvent with reason=Receipts.">' +
            '<td><strong>Facility worker accepts delivery</strong></td>' +
            '<td><code title="OpenLMIS stockmanagement API. Body includes facilityId, programId, orderableId, quantity, reasonId (Receipts UUID), and the facility worker\'s userId." style="' + tip + '">POST /api/stockEvents</code> · Reason: <strong title="The OpenLMIS reason code for incoming stock. UUID: 313f2f5f-0c22-4626-8c49-3554ef763de3." style="' + tip + '">Receipts</strong></td>' +
            '<td><strong style="color:#2e7d32;' + tip + '" title="CREDIT = stock IN. OpenLMIS increases the facility\'s Stock on Hand by the accepted quantity.">CREDIT (IN)</strong></td>' +
            '<td>+qty received</td>' +
          '</tr>' +
          '<tr title="The district warehouse shipping step is not modelled in this sandbox. In a real deployment this would be a separate ISSUE event from the warehouse system.">' +
            '<td>District warehouse issues/ships stock</td>' +
            '<td><em>Not modelled in this sandbox</em></td>' +
            '<td>—</td><td>—</td>' +
          '</tr>' +
          '<tr style="background:#fff3e0" title="When a VHW dispenses medicine to a patient via the Android app, the mediator posts a DEBIT stockEvent to OpenLMIS with reason=Consumed.">' +
            '<td>VHW dispenses to patient</td>' +
            '<td><code title="Same OpenLMIS endpoint as receipt, but with reasonId = Consumed (DEBIT). Triggered by a MedicationDispense or QuestionnaireResponse dispense submission." style="' + tip + '">POST /api/stockEvents</code> · Reason: <strong title="The OpenLMIS reason code for stock going out. UUID: b5c27da7-bdda-4790-925a-9484c5dfb594." style="' + tip + '">Consumed</strong></td>' +
            '<td><strong style="color:#e65100;' + tip + '" title="DEBIT = stock OUT. OpenLMIS decreases the facility\'s Stock on Hand by the dispensed quantity.">DEBIT (OUT)</strong></td>' +
            '<td>−qty dispensed</td>' +
          '</tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px;font-size:13px;color:var(--dhis2-text-muted)">' +
      'The district warehouse ISSUE step (supply chain sending side) is out of scope for this sandbox. ' +
      'OpenLMIS only sees the facility-level CREDIT on receipt and DEBIT on dispense.</p>' +
      '<div style="margin-top:10px;padding:8px 12px;background:#fff8e1;border-left:3px solid #f9a825;border-radius:3px;font-size:13px">' +
        '<strong>&#9888; OpenLMIS does not push events.</strong> ' +
        'OpenLMIS 3.x has no webhook or outbound notification system. When stock is received directly in OpenLMIS ' +
        '(e.g. district warehouse records a receipt), the mediator detects it by <strong title="The mediator calls GET /api/stockCardSummaries every 60 seconds to detect new receipts posted directly in OpenLMIS. This is how FHIR Tasks are generated without a webhook." style="' + tip + '">polling</strong> ' +
        '<code title="OpenLMIS stockmanagement endpoint. Returns current Stock on Hand per orderable per facility. The mediator compares this against the last-known SOH to detect new receipts." style="' + tip + '">GET /api/stockCardSummaries</code> every 60 seconds. ' +
        'FHIR Tasks appear within 0&ndash;60 seconds of the OpenLMIS receipt &mdash; not instantly. ' +
        'Enable <strong>OpenLMIS &rarr; Facility Worker Task fan-out</strong> in Settings to activate this polling.' +
      '</div>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Approval gate (on-hold Tasks)</h4>' +
      '<p>When a facility worker submits a stock order on the Android app, the mediator immediately ' +
      'creates an <strong title="FHIR Task with status=on-hold. Visible on the Tasks page. Means the order is buffered and waiting for a facility worker to trigger dispatch via Dispatch Now." style="' + tip + '">on-hold Task</strong> (visible on the Tasks page as ' +
      '<span style="background:#ede7f6;color:#6a1b9a;padding:1px 6px;border-radius:3px;font-size:12px;' + tip + '" title="FHIR Task.status = on-hold. The order is in the buffer. Nothing has been sent to OpenLMIS yet. Use Dispatch Now on the Orders page to advance this.">&#9679; Awaiting Approval</span>). ' +
      'This task transitions automatically to ' +
      '<span style="background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:3px;font-size:12px;' + tip + '" title="FHIR Task.status = in-progress. The order batch has been dispatched to OpenLMIS. The facility worker now has a receipt Task on their device.">&#9679; Dispatched</span> ' +
      'when the order batch is dispatched to OpenLMIS.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Cancel Order</h4>' +
      '<p>Each village card with pending orders shows a red <strong title="Sets all buffer quantities for that village to zero for the current period. The mediator will not include this village in the next dispatch. The VHW must re-submit an order to start again." style="' + tip + '">Cancel Order</strong> button. ' +
      'Cancelling zeroes all buffer quantities for that village in the current <abbr title="Calendar month expressed as YYYYMM. All orders within the same month are batched together." style="' + tip + '">period</abbr>. ' +
      'This cannot be undone — the quantities must be re-ordered.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Dispatch schedule</h4>' +
      '<table>' +
        '<thead><tr><th>Mode</th><th>Auto-fires</th></tr></thead>' +
        '<tbody>' +
          '<tr title="Every day at 06:00 server time the mediator reads the order buffer and dispatches all pending quantities to OpenLMIS.">' +
            '<td><abbr title="Dispatches once per day at 06:00. Good for high-throughput demos where you want near-real-time dispatch." style="' + tip + '">Daily</abbr></td><td>Every day at 06:00</td></tr>' +
          '<tr title="Every Monday at 06:00 the mediator dispatches the accumulated weekly total to OpenLMIS. Default mode.">' +
            '<td><abbr title="Dispatches once per week on Monday at 06:00. Reflects a realistic weekly restocking cycle for rural clinics." style="' + tip + '">Weekly</abbr></td><td>Every Monday at 06:00</td></tr>' +
          '<tr title="On the first day of each month at 06:00 the mediator dispatches the accumulated monthly total.">' +
            '<td><abbr title="Dispatches once per month on the 1st at 06:00. Suitable for facilities that order on a monthly cycle." style="' + tip + '">Monthly</abbr></td><td>First day of each month at 06:00</td></tr>' +
          '<tr title="No automatic dispatch will fire. You must click Dispatch Now manually each time you want to send orders to OpenLMIS.">' +
            '<td><abbr title="Auto-dispatch is off. Orders accumulate in the buffer indefinitely until you click Dispatch Now. A red warning banner appears on the Current Period cell." style="' + tip + '">&#9940; Disabled</abbr></td>' +
            '<td>No automatic dispatch — manual only</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">Change the schedule using the buttons in the ' +
      '<strong title="The banner row at the top of the Order Management tab showing current period, dispatch status, schedule, and total pending tablets." style="' + tip + '">Dispatch Schedule</strong> banner cell. <strong title="Forces a dispatch regardless of the schedule or whether this period has already been dispatched. Useful for testing or to unblock a stuck flow." style="' + tip + '">Dispatch Now</strong> always works ' +
      'regardless of the selected schedule. When disabled, a red notice appears in the Current Period cell.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Villages <abbr title="Org Units — organisational units in DHIS2 that represent geographic areas (villages). Each village maps to a DHIS2 org unit UID and a FHIR Location resource." style="' + tip + '">(org units)</abbr></h4>' +
      '<table>' +
        '<thead><tr><th>Village</th><th>Region</th><th><abbr title="The FHIR Location resource ID in HAPI FHIR (port 8079). Used by the mediator to resolve which org unit a VHW\'s order belongs to." style="' + tip + '">FHIR Location ID</abbr></th></tr></thead>' +
        '<tbody>' +
          '<tr title="Ha Mokoena village, served by VHW Thabo Mokoena. DHIS2 org unit: VilHaMokoe1.">' +
            '<td>Ha Mokoena</td><td>Maseru North</td><td><code>loc-ha-mokoena</code></td></tr>' +
          '<tr title="Ha Sehlabane village. DHIS2 org unit: VilHaSehl01.">' +
            '<td>Ha Sehlabane</td><td>Maseru North</td><td><code>loc-ha-sehlabane</code></td></tr>' +
          '<tr title="Matsieng village. DHIS2 org unit: VilMatsien1.">' +
            '<td>Matsieng</td><td>Maseru East</td><td><code>loc-matsieng</code></td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px"><abbr title="Village Health Workers — community-based health workers assigned to a specific village." style="' + tip + '">VHWs</abbr> are assigned to villages via the <abbr title="FHIR R4 CareTeam resource in HAPI FHIR. Links practitioners to a team and identifies the supervising facility worker." style="' + tip + '">CareTeam FHIR resource</abbr>. ' +
      'Practitioner names are resolved from HAPI FHIR. <abbr title="Stock on Hand — the current quantity of medicine at the facility as reported by OpenLMIS stockCardSummaries." style="' + tip + '">Stock on Hand</abbr> values come from ' +
      'OpenLMIS <code title="Returns current stock levels per orderable per facility. Queried on every page load to show live SOH next to each medicine line." style="' + tip + '">GET /api/stockCardSummaries</code>. ' +
      'The <abbr title="PostgreSQL table (order_buffer) inside the health-db-postgres container. Stores cumulative order quantities keyed by period + orderable + org_unit. Survives container restarts." style="' + tip + '">order buffer</abbr> is stored in PostgreSQL (<code>order_buffer</code> table) and survives restarts.</p>' +
    '</div>'
  );
}
