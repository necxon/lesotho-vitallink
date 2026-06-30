/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function tasksHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>The <strong>Stock Tasks</strong> page shows FHIR <code>Task</code> resources stored in HAPI FHIR ' +
      '(port 8079). Tasks move through a four-stage lifecycle as a VHW stock order travels from request ' +
      'through facility approval, dispatch, and final VHW acceptance.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Stock flow — end to end</h4>' +
      '<div class="help-flow">' +
        '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; FW places order</strong><small>Orders page → mediator</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" style="border-color:#9c27b0">On-hold Task created<small>queued for dispatch</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; Dispatch Now</strong><small>Orders page → FHIR Task</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" style="border-color:#1565c0">Task → In-Progress<small>delivery in transit</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; Mark Complete</strong><small>FW accepts → CREDIT OpenLMIS</small></span>' +
        '<span class="flow-arrow">→</span>' +
        '<span class="flow-step">Stock credited<small>VHW can collect</small></span>' +
      '</div>' +
      '<p style="font-size:12px;margin-top:8px"><strong style="color:#1565c0">&#127968; Facility Worker steps</strong> — ' +
      'all stock flow actions (place order, dispatch, accept delivery) are done by facility workers via this web app. ' +
      'VHWs collect stock from the facility once it is credited.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Task statuses</h4>' +
      '<table>' +
        '<thead><tr><th>Badge</th><th>FHIR status</th><th>Meaning</th><th>Next step</th></tr></thead>' +
        '<tbody>' +
          '<tr>' +
            '<td><span class="badge" style="background:#ede7f6;color:#6a1b9a">&#9679; Awaiting Approval</span></td>' +
            '<td><code>on-hold</code></td>' +
            '<td>Facility worker has placed a stock order; waiting for the batch to be dispatched</td>' +
            '<td>Click <strong>Dispatch Now</strong> on the Orders page — the task automatically moves to Dispatched</td>' +
          '</tr>' +
          '<tr>' +
            '<td><span class="badge" style="background:#e3f2fd;color:#1565c0">&#9679; Dispatched</span></td>' +
            '<td><code>in-progress</code></td>' +
            '<td>Order has been sent to OpenLMIS; facility worker has received a receipt task on their device</td>' +
            '<td>Facility worker syncs app and submits the stock-acceptance form</td>' +
          '</tr>' +
          '<tr>' +
            '<td><span class="badge" style="background:#fff3e0;color:#e65100">&#9679; Pending</span></td>' +
            '<td><code>requested</code></td>' +
            '<td>Task sent to the worker\'s Android device but not yet acknowledged</td>' +
            '<td>Worker syncs app and confirms receipt or stock issue</td>' +
          '</tr>' +
          '<tr>' +
            '<td><span class="badge active">&#10003; Complete</span></td>' +
            '<td><code>completed</code></td>' +
            '<td>Worker confirmed receipt on device, or task marked complete here</td>' +
            '<td>No further action needed</td>' +
          '</tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">You can click <strong>Mark Complete</strong> on any <em>Pending</em> task here ' +
      'in the web UI — useful for testing or to unblock a flow when the device is unavailable.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>How tasks are created</h4>' +
      '<ul>' +
        '<li><strong>FW stock order (on-hold)</strong> — when a facility worker submits a stock order ' +
        'via the Orders page, the mediator creates an <em>on-hold</em> Task. It waits here until the ' +
        'batch is dispatched. (Only facility workers can place orders — VHWs are not authorised.)</li>' +
        '<li><strong>On dispatch (in-progress)</strong> — when "Dispatch Now" fires, on-hold Tasks for the ' +
        'dispatched orderables are automatically transitioned to <em>in-progress</em> and a receipt Task ' +
        '(<em>requested</em>) is created to track the incoming delivery.</li>' +
        '<li><strong>On facility worker receipt (Mark Complete)</strong> — when a facility worker marks the ' +
        'delivery complete, the mediator posts a CREDIT to OpenLMIS and completes the Task so the stock ' +
        'is now available for VHWs to collect.</li>' +
      '</ul>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Column reference</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Status</strong></td><td>Current FHIR Task status — see statuses table above</td></tr>' +
          '<tr><td><strong>Medicine</strong></td><td>Orderable medicine linked to this task (resolved from OpenLMIS catalogue)</td></tr>' +
          '<tr><td><strong>Qty</strong></td><td>Units the worker is expected to receive or issue</td></tr>' +
          '<tr><td><strong>Issue Ref</strong></td><td>Reference to the originating order batch (e.g. <code>ORD-202605-…</code>)</td></tr>' +
          '<tr><td><strong>Created</strong></td><td>Date the Task was authored in HAPI FHIR (<code>Task.authoredOn</code>)</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Tasks are read from <strong>HAPI FHIR</strong> (port 8079) via ' +
      '<code>GET /fhir/Task?_sort=-_lastUpdated&amp;_count=500</code>. ' +
      'Worker names come from <code>GET /fhir/Practitioner</code>. ' +
      'Medicine names are resolved from OpenLMIS <code>GET /api/orderables</code>. ' +
      'Completing a task calls <code>POST /mediator-api/aggregate/tasks/{id}/complete</code> which ' +
      'patches <code>Task.status = completed</code> in HAPI FHIR.</p>' +
    '</div>'
  );
}
