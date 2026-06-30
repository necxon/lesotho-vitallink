/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';


// Static help panel lives in js/help/tasks.js (tasksHelpHTML, global).

var _tasksFilter = 'pending';

function renderTasks(el) {
  el.innerHTML = '<p aria-busy="true">Loading tasks…</p>';
  Promise.all([
    fhir('Task?_sort=-_lastUpdated&_count=500'),
    fhir('Practitioner?_count=100'),
    lmisGet('/api/orderables?page=0&size=500').catch(function() { return { content: [] }; }),
    mediatorFetch('aggregate/performers').then(function(r) { return r.json(); }).catch(function() { return {}; }),
    lmisGet('/api/facilities?size=100').catch(function() { return { content: [] }; }),
  ]).then(function(results) {
    var tasks       = entries(results[0]);
    var pracNames   = {};
    entries(results[1]).forEach(function(p) {
      var n      = p.name && p.name[0];
      var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
      var family = n ? (n.family || '') : '';
      pracNames[p.id] = [given, family].filter(Boolean).join(' ') || p.id;
    });
    var orderableNames = {};
    (results[2].content || []).forEach(function(o) {
      if (o.id) orderableNames[o.id] = o.fullProductName || (o.productCode && o.productCode.value) || o.id;
    });
    var performers = results[3];
    var facilityNames = {};
    (results[4].content || []).forEach(function(f) {
      if (f.id) facilityNames[f.id] = f.name || f.id;
    });
    _renderTasksPage(el, tasks, pracNames, orderableNames, performers, facilityNames);
  }).catch(function(e) {
    errMsg(el, 'Could not load tasks: ' + e.message);
  });
}

function _renderTasksPage(el, tasks, pracNames, orderableNames, performers, facilityNames) {
  performers    = performers    || {};
  facilityNames = facilityNames || {};
  var filter    = _tasksFilter;
  var pending   = tasks.filter(function(t) { return t.status === 'requested' || t.status === 'on-hold' || t.status === 'in-progress'; });
  var completed = tasks.filter(function(t) { return t.status === 'completed'; });
  var filtered  = filter === 'pending' ? pending : filter === 'completed' ? completed : tasks;

  var html =
    '<div class="page-header">' +
      '<h2>Stock Tasks</h2>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<span style="font-size:12px;color:var(--dhis2-text-muted)">' +
          (function() {
            var awaitingApproval = tasks.filter(function(t) { return t.status === 'on-hold'; }).length;
            var parts = [pending.length + ' pending', completed.length + ' completed'];
            if (awaitingApproval > 0) parts.splice(1, 0, awaitingApproval + ' awaiting approval');
            return parts.join(' &nbsp;&bull;&nbsp; ');
          })() +
        '</span>' +
        '<button class="btn btn-outline btn-sm" onclick="renderTasks(document.getElementById(\'content\'))">&#8635; Refresh</button>' +
        (tasks.length > 0
          ? '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" onclick="deleteAllTasks()">&#128465; Delete All</button>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="tasks-data">Tasks</button>' +
      '<button class="page-tab" data-tab="tasks-help">? Help</button>' +
    '</div>' +
    '<div id="tasks-data">' +
    '<div class="help-flow" style="margin-bottom:16px;flex-wrap:wrap">' +
      '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; FW places order</strong><small>Orders page</small></span>' +
      '<span class="flow-arrow">→</span>' +
      '<span class="flow-step" style="border-color:#9c27b0">On-hold Task<small>awaiting dispatch</small></span>' +
      '<span class="flow-arrow">→</span>' +
      '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; Dispatch Now</strong><small>Orders page</small></span>' +
      '<span class="flow-arrow">→</span>' +
      '<span class="flow-step" style="border-color:#1565c0">In-Progress Task<small>delivery pending</small></span>' +
      '<span class="flow-arrow">→</span>' +
      '<span class="flow-step" style="border-color:#1565c0"><strong style="color:#1565c0">&#127968; Mark Complete</strong><small>FW accepts delivery</small></span>' +
      '<span class="flow-arrow">→</span>' +
      '<span class="flow-step">Stock credited<small>VHW can collect</small></span>' +
    '</div>' +
    '';

  // Filter bar
  html += '<div style="display:flex;border-bottom:2px solid var(--dhis2-border);margin-bottom:16px">';
  [['all', 'All', tasks.length], ['pending', 'Pending', pending.length], ['completed', 'Completed', completed.length]]
    .forEach(function(f) {
      var active = _tasksFilter === f[0];
      html += '<button onclick="_setTasksFilter(\'' + f[0] + '\')" style="padding:6px 18px;font-size:13px;' +
        'border:none;background:none;cursor:pointer;margin-bottom:-2px;' +
        (active
          ? 'border-bottom:2px solid var(--dhis2-blue);color:var(--dhis2-blue);font-weight:600'
          : 'border-bottom:2px solid transparent;color:var(--dhis2-text-muted)') + '">' +
        f[1] + ' (' + f[2] + ')</button>';
    });
  html += '</div>';

  // Search + summary bar
  html += '<div style="display:flex;gap:10px;margin-bottom:16px;align-items:center;flex-wrap:wrap">' +
    '<input type="search" id="tasks-search" placeholder="Filter by name, village or medicine…" ' +
      'style="padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;width:260px">' +
    '<span id="tasks-shown" style="font-size:13px;color:var(--dhis2-text-muted)"></span>' +
    '<button id="tasks-toggle-all" class="btn btn-outline btn-sm" style="margin-left:auto">Collapse All</button>' +
  '</div>';

  if (filtered.length === 0) {
    html += '<p style="color:var(--dhis2-text-muted)">No ' + (filter === 'all' ? '' : filter + ' ') + 'tasks found.</p>';
    html += '</div>'; // #tasks-data
    html += '<div id="tasks-help" class="help-panel" hidden>' + tasksHelpHTML() + '</div>';
    el.innerHTML = html;
    el.querySelectorAll('.page-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var target = tab.getAttribute('data-tab');
        document.getElementById('tasks-data').hidden  = (target !== 'tasks-data');
        document.getElementById('tasks-help').hidden  = (target !== 'tasks-help');
      });
    });
    return;
  }

  // Group tasks by owner practitioner
  var byPrac = {};
  filtered.forEach(function(t) {
    var ref     = (t.owner && t.owner.reference) || (t.for && t.for.reference) || 'unknown';
    var practId = ref.replace('Practitioner/', '');
    if (!byPrac[practId]) byPrac[practId] = [];
    byPrac[practId].push(t);
  });

  function getPractRole(practId) {
    var perf = performers[practId] || performers['Practitioner/' + practId] || {};
    return perf.role || 'vhw';
  }

  function sortByPending(ids) {
    return ids.sort(function(a, b) {
      var pa = byPrac[a].filter(function(t) { return t.status === 'requested'; }).length;
      var pb = byPrac[b].filter(function(t) { return t.status === 'requested'; }).length;
      return pb - pa;
    });
  }

  var allIds  = Object.keys(byPrac);
  var fwIds   = sortByPending(allIds.filter(function(id) { return getPractRole(id) === 'coordinator'; }));
  var vhwIds  = sortByPending(allIds.filter(function(id) { return getPractRole(id) !== 'coordinator'; }));

  function renderPractCard(practId, roleLabel, roleColor) {
    var TASK_ROW_LIMIT = 8;
    var pracTasks    = byPrac[practId];
    var name         = pracNames[practId] || practId;
    var pendingCount = pracTasks.filter(function(t) { return t.status === 'requested'; }).length;
    var perf         = performers[practId] || performers['Practitioner/' + practId] || {};
    var village      = perf.village   || null;
    var region       = perf.region    || null;
    var facilityId   = perf.facilityId || null;
    var facName      = (facilityId && facilityNames[facilityId]) || facilityId || null;
    var phone        = perf.phone     || null;
    var email        = perf.email     || null;
    var medicinesList = pracTasks.map(function(t) {
      var pi = (t.input || []).find(function(i) { return i.type && i.type.text === 'product'; });
      return pi ? (pi.valueString || '') : '';
    }).filter(Boolean).join(' ');

    var out = '<article class="task-card"' +
      ' data-name="' + esc(name) + '"' +
      ' data-village="' + esc(village || '') + '"' +
      ' data-medicines="' + esc(medicinesList) + '"' +
      ' style="margin-bottom:16px">';
    out += '<header class="task-card-header" style="padding-bottom:10px;border-bottom:1px solid var(--dhis2-border);margin-bottom:12px;cursor:pointer;user-select:none">';
    out += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">';
    out += '<strong style="font-size:14px">' + esc(name) + '</strong>';
    out += '<span class="badge" style="background:' + roleColor + ';font-size:11px">' + esc(roleLabel) + '</span>';
    if (pendingCount > 0) {
      out += '<span class="badge" style="background:#fff3e0;color:#e65100">' + pendingCount + ' pending</span>';
    }
    out += '<span class="task-collapse-icon" style="margin-left:auto;color:var(--dhis2-text-muted);font-size:12px">&#9662;</span>';
    out += '</div>';
    var details = [];
    if (village && region) details.push('&#128205; ' + esc(village) + ' &middot; ' + esc(region));
    else if (village)      details.push('&#128205; ' + esc(village));
    if (facName)           details.push('&#127968; ' + esc(facName));
    if (phone)             details.push('&#128222; ' + esc(phone));
    if (email)             details.push('&#9993; ' + esc(email));
    if (details.length) {
      out += '<div style="font-size:12px;color:var(--dhis2-text-muted);display:flex;flex-wrap:wrap;gap:16px">' +
        details.map(function(d) { return '<span>' + d + '</span>'; }).join('') +
      '</div>';
    }
    out += '</header>';

    var allRows = [];
    pracTasks.forEach(function(t) {
      var isPending     = t.status === 'requested';
      var productInput  = (t.input || []).find(function(i) { return i.type && i.type.text === 'product'; });
      var qtyInput      = (t.input || []).find(function(i) { return i.type && i.type.text === 'quantity'; });
      var issueRefInput = (t.input || []).find(function(i) { return i.type && i.type.text === 'issueRef'; });
      var productId     = productInput ? productInput.valueString : null;
      var medName       = (productId && orderableNames[productId]) || productId || (t.description || '').split(' — ')[0] || t.id;
      var qty           = qtyInput ? qtyInput.valueInteger : '—';
      var issueRef      = issueRefInput ? issueRefInput.valueString : '—';
      var statusBadge = t.status === 'on-hold'
        ? '<span class="badge" style="background:#ede7f6;color:#6a1b9a;cursor:help" ' +
            'title="Awaiting Approval — VHW has placed a stock order. Waiting for a facility worker to dispatch it to OpenLMIS. Use Dispatch Now on the Orders page to move this forward.">' +
            '&#9679; Awaiting Approval</span>'
        : t.status === 'in-progress'
          ? '<span class="badge" style="background:#e3f2fd;color:#1565c0;cursor:help" ' +
              'title="Dispatched — The order has been sent to OpenLMIS. A receipt task has been created for the facility worker. Waiting for the facility worker to sync the app and accept the delivery.">' +
              '&#9679; Dispatched</span>'
          : isPending
            ? '<span class="badge" style="background:#fff3e0;color:#e65100;cursor:help" ' +
                'title="Pending — Task is on the worker\'s device waiting to be acknowledged. The worker needs to sync the app and confirm receipt or stock issue. Click Mark Complete here to unblock manually.">' +
                '&#9679; Pending</span>'
            : '<span class="badge active" style="cursor:help" ' +
                'title="Complete — Worker confirmed receipt on their device, or the task was manually completed here.">' +
                '&#10003; Complete</span>';
      var row = '<tr>';
      row += '<td>' + statusBadge + '</td>';
      row += '<td><strong>' + esc(medName) + '</strong></td>';
      row += '<td>' + esc(String(qty)) + '</td>';
      row += '<td style="font-size:11px;color:var(--dhis2-text-muted)">' + esc(issueRef) + '</td>';
      row += '<td style="white-space:nowrap">' + fmtDateTime(t.authoredOn) + '</td>';
      row += '<td style="white-space:nowrap">';
      if (t.status === 'requested') {
        row += '<button class="btn btn-outline btn-sm" style="margin-right:4px" ' +
          'onclick="completeTask(\'' + esc(t.id) + '\', this)">Mark Complete</button>';
      }
      row += '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" ' +
        'onclick="deleteTask(\'' + esc(t.id) + '\', this)">Delete</button>';
      row += '</td></tr>';
      allRows.push(row);
    });

    var visRows = allRows.slice(0, TASK_ROW_LIMIT);
    var extRows = allRows.slice(TASK_ROW_LIMIT);
    var thead   = '<thead><tr><th>Status</th><th>Medicine</th><th>Qty</th><th>Issue Ref</th><th>Created</th><th></th></tr></thead>';

    out += '<div class="task-body">';
    out += '<div class="tbl-wrap"><table>' + thead + '<tbody>' + visRows.join('') + '</tbody></table></div>';
    if (extRows.length > 0) {
      out += '<div class="tasks-extra" hidden>' +
        '<div class="tbl-wrap"><table><tbody>' + extRows.join('') + '</tbody></table></div>' +
        '</div>';
      out += '<button class="tasks-show-more" style="font-size:12px;color:var(--dhis2-blue);' +
        'background:none;border:none;cursor:pointer;padding:4px 0 8px">Show ' + extRows.length + ' more &#9662;</button>';
    }
    out += '</div>'; // .task-body
    out += '</article>';
    return out;
  }

  if (fwIds.length > 0) {
    html += '<h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;' +
      'color:var(--dhis2-text-muted);margin:0 0 12px">&#127968; Facility Workers — Pending Receipt</h3>';
    fwIds.forEach(function(id) {
      html += renderPractCard(id, 'Facility Worker', '#e3f2fd;color:#1565c0');
    });
  }

  if (vhwIds.length > 0) {
    if (fwIds.length > 0) html += '<hr style="margin:20px 0">';
    html += '<h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;' +
      'color:var(--dhis2-text-muted);margin:0 0 12px">&#128101; Field Workers (VHW) — Pending Acceptance</h3>';
    vhwIds.forEach(function(id) {
      html += renderPractCard(id, 'VHW', '#e8f5e9;color:#2e7d32');
    });
  }

  html += '</div>'; // #tasks-data
  html += '<div id="tasks-help" class="help-panel" hidden>' + tasksHelpHTML() + '</div>';

  el.innerHTML = html;

  el.querySelectorAll('.page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('tasks-data').hidden = (target !== 'tasks-data');
      document.getElementById('tasks-help').hidden = (target !== 'tasks-help');
    });
  });

  // Card header → collapse/expand body
  el.querySelectorAll('.task-card-header').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var card = hdr.closest('.task-card');
      var body = card && card.querySelector('.task-body');
      var icon = hdr.querySelector('.task-collapse-icon');
      if (body) body.hidden = !body.hidden;
      if (icon) icon.textContent = body && body.hidden ? '▸' : '▾';
    });
  });

  // Collapse All / Expand All toggle
  var _tasksAllCollapsed = false;
  var toggleAllBtn = el.querySelector('#tasks-toggle-all');
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', function() {
      _tasksAllCollapsed = !_tasksAllCollapsed;
      el.querySelectorAll('.task-card .task-body').forEach(function(body) {
        body.hidden = _tasksAllCollapsed;
      });
      el.querySelectorAll('.task-card-header .task-collapse-icon').forEach(function(icon) {
        icon.textContent = _tasksAllCollapsed ? '▸' : '▾';
      });
      toggleAllBtn.textContent = _tasksAllCollapsed ? 'Expand All' : 'Collapse All';
    });
  }

  // Show more rows
  el.querySelectorAll('.tasks-show-more').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var body = btn.closest('.task-body');
      if (body) {
        var extra = body.querySelector('.tasks-extra');
        if (extra) extra.hidden = false;
      }
      btn.hidden = true;
    });
  });

  // Search / filter cards
  function applyTasksSearch() {
    var q = ((el.querySelector('#tasks-search') || {}).value || '').toLowerCase();
    var cards = el.querySelectorAll('.task-card');
    var shown = 0;
    cards.forEach(function(card) {
      var match = !q ||
        (card.getAttribute('data-name')      || '').toLowerCase().includes(q) ||
        (card.getAttribute('data-village')   || '').toLowerCase().includes(q) ||
        (card.getAttribute('data-medicines') || '').toLowerCase().includes(q);
      card.hidden = !match;
      if (match) shown++;
    });
    var shownEl = el.querySelector('#tasks-shown');
    if (shownEl) {
      var total = cards.length;
      shownEl.textContent = total > 0
        ? (shown + ' of ' + total + ' practitioner' + (total !== 1 ? 's' : '') + ' shown')
        : '';
    }
  }
  var searchInput = el.querySelector('#tasks-search');
  if (searchInput) searchInput.addEventListener('input', applyTasksSearch);
  applyTasksSearch();
}

function _setTasksFilter(f) {
  _tasksFilter = f;
  renderTasks(document.getElementById('content'));
}

function deleteTask(taskId, btn) {
  if (!confirm('Delete Task/' + taskId + '?')) return;
  btn.disabled = true;
  btn.textContent = '…';
  fetch('/mediator-api/fhir/Task/' + taskId, { method: 'DELETE' })
    .then(function() { renderTasks(document.getElementById('content')); })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = 'Delete';
      alert('Could not delete task: ' + e.message);
    });
}

function deleteAllTasks() {
  if (!confirm('Delete ALL tasks? This cannot be undone.')) return;
  fhir('Task?_count=500&_elements=id').then(function(data) {
    var ids = (data.entry || []).map(function(e) { return e.resource && e.resource.id; }).filter(Boolean);
    return Promise.all(ids.map(function(id) {
      return fetch('/mediator-api/fhir/Task/' + id, { method: 'DELETE' });
    }));
  }).then(function() {
    renderTasks(document.getElementById('content'));
  }).catch(function(e) { alert('Error: ' + e.message); });
}

function completeTask(taskId, btn) {
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  mediatorFetch('aggregate/tasks/' + taskId + '/complete', { method: 'POST' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      renderTasks(document.getElementById('content'));
    })
    .catch(function(e) {
      btn.disabled    = false;
      btn.textContent = 'Mark Complete';
      alert('Could not complete task: ' + e.message);
    });
}
