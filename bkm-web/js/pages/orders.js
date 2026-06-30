/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/orders.js (ordersHelpHTML, global).

// Static label map — matches the dhis2OrgUnit field in mappings.json

function nextMonday0600() {
  var now  = new Date();
  var days = (7 - now.getDay()) % 7 || 7;
  var next = new Date(now);
  next.setDate(now.getDate() + days);
  next.setHours(6, 0, 0, 0);
  return next;
}

function countdown(target) {
  var ms   = target - Date.now();
  if (ms <= 0) return 'imminent';
  var h    = Math.floor(ms / 3600000);
  var m    = Math.floor((ms % 3600000) / 60000);
  var days = Math.floor(h / 24);
  h        = h % 24;
  if (days > 0) return days + 'd ' + h + 'h ' + m + 'm';
  if (h  > 0)  return h + 'h ' + m + 'm';
  return m + 'm';
}

function renderOrders(el) {
  var now    = new Date();
  var yr     = now.getFullYear();
  var mo     = String(now.getMonth() + 1).padStart(2, '0');
  var period = yr + '-' + mo;

  el.innerHTML =
    '<div class="page-header">' +
      '<h2>Order Management</h2>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-left:auto">' +
        '<button class="btn btn-sm" id="btn-cancel-all" style="background:#fce4ec;color:#c62828;border-color:#f48fb1">&#128465; Cancel All Orders</button>' +
        '<button class="btn btn-primary btn-sm" id="btn-dispatch">&#128228; Order All</button>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:16px;padding:8px 14px;background:#f5f7fa;border:1px solid #e0e4ea;border-radius:6px;margin-bottom:12px;flex-wrap:wrap">' +
      '<div style="display:flex;flex-direction:column">' +
        '<span style="font-size:11px;color:#6b7a8d;text-transform:uppercase;letter-spacing:.5px">Current Period</span>' +
        '<span style="font-size:16px;font-weight:700;color:#1a2332" id="hdr-period">' + period + '</span>' +
        '<span style="font-size:11px;color:#6b7a8d">Monthly accumulation window</span>' +
      '</div>' +
      '<div style="width:1px;height:36px;background:#d0d5dd;flex-shrink:0"></div>' +
      '<div id="hdr-dispatch-status" style="font-size:13px;color:#6b7a8d">Loading schedule…</div>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="orders-data">Order Management</button>' +
      '<button class="page-tab" data-tab="orders-history">&#128203; History</button>' +
      '<button class="page-tab" data-tab="orders-help">? Help</button>' +
    '</div>' +
    '<div id="orders-content"><p aria-busy="true">Loading…</p></div>' +
    '<div id="orders-history" hidden></div>' +
    '<div id="orders-help" class="help-panel" hidden>' + ordersHelpHTML() + '</div>';

  var historyLoaded = false;
  var _histSort = { col: 'dispatched_at', dir: -1 }; // default: newest first
  var _histPage = 0;
  var _histPageSize = 25;

  function loadHistoryTab() {
    var panel = document.getElementById('orders-history');
    panel.innerHTML = '<p aria-busy="true">Loading history…</p>';
    Promise.all([
      mediatorFetch('aggregate/dispatch-history?limit=200').then(function(r) { return r.json(); }),
      lmisGet('/api/orderables?size=100').catch(function() { return { content: [] }; }),
      fhir('Practitioner?_count=50').catch(function() { return { entry: [] }; }),
      fhir('PractitionerRole?_count=50').catch(function() { return { entry: [] }; }),
    ]).then(function(results) {
      var rows       = results[0].rows || [];
      var orderables = results[1].content || [];
      var pracBundle = results[2];
      var roleBundle = results[3];

      var names = {};
      orderables.forEach(function(o) {
        names[o.id] = o.fullProductName || (o.productCode && o.productCode.value) || o.id;
      });

      // Build practitioner ID → display name (handles "Practitioner/id" and bare "id" forms)
      var pracNames = {};
      entries(pracBundle).forEach(function(p) {
        var n      = p.name && p.name[0];
        var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
        var family = n ? (n.family || '') : '';
        var display = [given, family].filter(Boolean).join(' ') || p.id;
        pracNames[p.id]                   = display;
        pracNames['Practitioner/' + p.id] = display;
      });

      // Build FHIR location ID → field-worker name from PractitionerRole (FIELD_WORKER role only)
      var locationWorkerMap = {};
      entries(roleBundle).forEach(function(role) {
        var code = (role.code || [])[0];
        var coding = code && (code.coding || [])[0];
        if (!coding || coding.code !== 'FIELD_WORKER') return;
        var practRef = role.practitioner && role.practitioner.reference;
        if (!practRef) return;
        (role.location || []).forEach(function(locRef) {
          var locId = (locRef.reference || '').replace('Location/', '');
          if (locId) locationWorkerMap[locId] = pracNames[practRef] || pracNames[practRef.replace('Practitioner/', '')] || practRef;
        });
      });

      // Resolve VHW name: prefer stored performer_ids; fall back to FHIR PractitionerRole via OU_LABELS
      function resolveVhwNames(performerIds, orgUnit) {
        if (performerIds) {
          var resolved = performerIds.split(',').map(function(id) {
            return pracNames[id] || pracNames[id.replace('Practitioner/', '')] || id;
          }).filter(function(n) { return n; });
          if (resolved.length) return resolved.map(esc).join(', ');
        }
        var fhirLocId = (OU_LABELS[orgUnit] || {}).fhirLocation;
        var name = fhirLocId && locationWorkerMap[fhirLocId];
        return name ? esc(name) : '<span style="color:#bbb">—</span>';
      }

      if (!rows.length) {
        panel.innerHTML = '<p style="color:var(--dhis2-text-muted);font-size:13px;padding:8px 0">No dispatch history recorded yet.</p>';
        return;
      }

      // Sortable column definitions — value() returns the comparable key for each row
      var HIST_COLS = [
        { key: 'dispatched_at', label: 'Dispatched At', value: function(r) { return new Date(r.dispatched_at).getTime(); } },
        { key: 'period',        label: 'Period',        value: function(r) { return r.period || ''; } },
        { key: 'medicine',      label: 'Medicine',      value: function(r) { return (names[r.orderable_id] || r.orderable_id || '').toLowerCase(); } },
        { key: 'village',       label: 'Village',       value: function(r) { return ((OU_LABELS[r.org_unit] || {}).village || r.org_unit || '').toLowerCase(); } },
        { key: 'worker',        label: 'Field Worker',  value: function(r) { return (r.performer_ids || '').toLowerCase(); } },
        { key: 'qty',           label: 'Qty',           value: function(r) { return Number(r.qty) || 0; } },
        { key: 'lmis_status',   label: 'OpenLMIS',      value: function(r) { return (r.lmis_status || '').toLowerCase(); } },
        { key: 'forced',        label: 'Forced',        value: function(r) { return r.forced ? 1 : 0; } },
      ];

      function _renderHist() {
        var sorted = rows.slice();
        var col = HIST_COLS.find(function(c) { return c.key === _histSort.col; });
        if (col) {
          sorted.sort(function(a, b) {
            var av = col.value(a), bv = col.value(b);
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * _histSort.dir;
            return String(av).localeCompare(String(bv)) * _histSort.dir;
          });
        }
        var total      = sorted.length;
        var pageSize   = _histPageSize === 'all' ? total : _histPageSize;
        var maxPage    = pageSize > 0 ? Math.max(0, Math.ceil(total / pageSize) - 1) : 0;
        if (_histPage > maxPage) _histPage = maxPage;
        var start      = pageSize > 0 ? _histPage * pageSize : 0;
        var end        = pageSize > 0 ? Math.min(start + pageSize, total) : total;
        var pageRows   = sorted.slice(start, end);

        var headerCells = HIST_COLS.map(function(c) {
          var active = _histSort.col === c.key;
          var cls    = 'sortable' + (active ? (' sort-' + (_histSort.dir === 1 ? 'asc' : 'desc')) : '');
          var arrow  = '<span class="sort-arrow">' + (active ? (_histSort.dir === 1 ? '▲' : '▼') : '⇅') + '</span>';
          return '<th class="' + cls + '" data-sort-col="' + c.key + '">' + esc(c.label) + arrow + '</th>';
        }).join('') + '<th></th>';

        panel.innerHTML =
          '<article>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">' +
              '<h3 style="margin:0">Dispatch History</h3>' +
              '<span style="font-size:13px;color:var(--dhis2-text-muted)">' + total + ' record(s)</span>' +
              '<select id="hist-page-size" class="btn btn-sm" style="margin-left:8px">' +
                [25, 50, 100, 'all'].map(function(n) {
                  var sel = (_histPageSize === n) ? ' selected' : '';
                  return '<option value="' + n + '"' + sel + '>' + (n === 'all' ? 'Show all' : (n + ' per page')) + '</option>';
                }).join('') +
              '</select>' +
              '<button id="btn-refresh-history" class="btn btn-sm" style="margin-left:auto">&#8635; Refresh</button>' +
              '<button id="btn-delete-all-history" class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1">&#128465; Delete All</button>' +
            '</div>' +
            '<div class="table-wrap">' +
              '<table><thead><tr>' + headerCells + '</tr></thead><tbody>' +
              (pageRows.length === 0
                ? '<tr><td colspan="' + (HIST_COLS.length + 1) + '" style="color:#888;padding:14px">No records on this page.</td></tr>'
                : pageRows.map(function(r) {
                    var st = r.lmis_status || '';
                    var stColor = st === 'received'       ? '#2e7d32' :
                                  st === 'pending-receipt'? '#e65100' :
                                  st === 'cancelled'      ? '#6a1b9a' :
                                  st.startsWith('error')  ? '#c62828' : '#555';
                    var stBg    = st === 'received'       ? '#e8f5e9' :
                                  st === 'pending-receipt'? '#fff3e0' :
                                  st === 'cancelled'      ? '#f3e5f5' :
                                  st.startsWith('error')  ? '#fce4ec' : '#f5f5f5';
                    var stLabel = st === 'received'       ? '&#10003; Received' :
                                  st === 'pending-receipt'? '&#9679; Pending Receipt' :
                                  st === 'cancelled'      ? '&#10006; Cancelled' :
                                  st.startsWith('error')  ? '&#9888; ' + esc(st) : esc(st || '—');
                    return '<tr>' +
                      '<td>' + esc(new Date(r.dispatched_at).toLocaleString()) + '</td>' +
                      '<td>' + esc(r.period.slice(0,4) + '-' + r.period.slice(4)) + '</td>' +
                      '<td>' + esc(names[r.orderable_id] || r.orderable_id) + '</td>' +
                      '<td>' + esc((OU_LABELS[r.org_unit] || {}).village || r.org_unit) + '</td>' +
                      '<td style="font-size:12px">' + resolveVhwNames(r.performer_ids, r.org_unit) + '</td>' +
                      '<td><strong>' + r.qty + '</strong></td>' +
                      '<td><span class="badge" style="background:' + stBg + ';color:' + stColor + '">' + stLabel + '</span></td>' +
                      '<td style="color:' + (r.forced ? '#e65100' : 'inherit') + '">' + (r.forced ? 'Yes' : '—') + '</td>' +
                      '<td><button class="btn btn-sm btn-del-hist" ' +
                        'style="background:#fce4ec;color:#c62828;border-color:#f48fb1;padding:2px 8px;font-size:11px" ' +
                        'data-id="' + esc(String(r.id)) + '">&#128465;</button></td>' +
                    '</tr>';
                  }).join('')
              ) +
              '</tbody></table>' +
            '</div>' +
            (pageSize !== total && total > 0
              ? '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px">' +
                  '<button id="hist-prev" class="btn btn-sm btn-outline"' + (_histPage <= 0 ? ' disabled' : '') + '>&laquo; Prev</button>' +
                  '<span>Page ' + (_histPage + 1) + ' of ' + (maxPage + 1) + ' &middot; rows ' + (start + 1) + '–' + end + ' of ' + total + '</span>' +
                  '<button id="hist-next" class="btn btn-sm btn-outline"' + (_histPage >= maxPage ? ' disabled' : '') + '>Next &raquo;</button>' +
                '</div>'
              : '') +
          '</article>';

        // Wire sort handlers
        panel.querySelectorAll('th[data-sort-col]').forEach(function(th) {
          th.addEventListener('click', function() {
            var key = th.getAttribute('data-sort-col');
            if (_histSort.col === key) _histSort.dir *= -1;
            else { _histSort.col = key; _histSort.dir = 1; }
            _histPage = 0;
            _renderHist();
          });
        });
        // Wire page-size + pagination
        document.getElementById('hist-page-size').onchange = function() {
          var v = this.value;
          _histPageSize = v === 'all' ? 'all' : parseInt(v, 10);
          _histPage = 0;
          _renderHist();
        };
        var prev = document.getElementById('hist-prev'); if (prev) prev.onclick = function() { _histPage = Math.max(0, _histPage - 1); _renderHist(); };
        var next = document.getElementById('hist-next'); if (next) next.onclick = function() { _histPage = Math.min(maxPage, _histPage + 1); _renderHist(); };
        // Re-wire action handlers each render
        _wireHistoryActions(panel, rows);
      }

      _renderHist();

      function _wireHistoryActions() {
        document.getElementById('btn-refresh-history').onclick = function() {
          historyLoaded = false;
          loadHistoryTab();
          historyLoaded = true;
        };
        document.getElementById('btn-delete-all-history').onclick = function() {
          if (!confirm('Delete ALL ' + rows.length + ' dispatch history record(s)?\n\nThis cannot be undone.')) return;
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Deleting…';
          mediatorFetch('aggregate/dispatch-history', { method: 'DELETE' })
            .then(function(r) { return r.json(); })
            .then(function() { historyLoaded = false; loadHistoryTab(); historyLoaded = true; })
            .catch(function(e) { btn.disabled = false; btn.innerHTML = '&#128465; Delete All'; alert('Error: ' + e.message); });
        };
        panel.querySelectorAll('.btn-del-hist').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var id = btn.getAttribute('data-id');
            if (!confirm('Delete this dispatch history record?')) return;
            btn.disabled = true;
            btn.textContent = '…';
            mediatorFetch('aggregate/dispatch-history/' + encodeURIComponent(id), { method: 'DELETE' })
              .then(function(r) { return r.json(); })
              .then(function() { historyLoaded = false; loadHistoryTab(); historyLoaded = true; })
              .catch(function(e) { btn.disabled = false; btn.innerHTML = '&#128465;'; alert('Error: ' + e.message); });
          });
        });
      }
    }).catch(function(e) {
      panel.innerHTML = '<article class="err"><strong>Error loading history:</strong> ' + esc(e.message) + '</article>';
    });
  }

  el.querySelectorAll('.page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('orders-content').hidden = (target !== 'orders-data');
      document.getElementById('orders-history').hidden = (target !== 'orders-history');
      document.getElementById('orders-help').hidden    = (target !== 'orders-help');
      if (target === 'orders-history' && !historyLoaded) {
        historyLoaded = true;
        loadHistoryTab();
      }
    });
  });

  document.getElementById('btn-cancel-all').onclick = function() {
    if (!confirm('Cancel ALL pending orders for every village this period?\n\nThis cannot be undone.')) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
    mediatorFetch('aggregate/orders', { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        btn.disabled = false;
        btn.innerHTML = '&#128465; Cancel All Orders';
        if (d.status === 'ok') {
          renderOrders(el);
        } else {
          alert('Cancel failed: ' + (d.message || JSON.stringify(d)));
        }
      })
      .catch(function(e) {
        btn.disabled = false;
        btn.innerHTML = '&#128465; Cancel All Orders';
        alert('Error: ' + e.message);
      });
  };

  document.getElementById('btn-dispatch').onclick = function() {
    if (!confirm('Send all pending orders to OpenLMIS now?\n\nThis action cannot be undone for the current period.')) return;
    this.disabled = true;
    this.textContent = 'Ordering…';
    var btn = this;
    mediatorFetch('aggregate/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        btn.disabled = false;
        btn.innerHTML = '&#128228; Order All';
        if (d.outcome === 'already-dispatched') {
          alert('Already dispatched for period ' + d.period + ' at ' + new Date(d.dispatchedAt).toLocaleString() + '.\nNo duplicate will be sent.');
        } else if (d.dispatched > 0) {
          alert('Dispatched ' + d.dispatched + ' medicine line(s) to OpenLMIS successfully.');
        } else {
          alert('Dispatch result: ' + (d.outcome || 'ok') + '\n' + (d.reason || ''));
        }
        renderOrders(el);
      })
      .catch(function(e) {
        btn.disabled = false;
        btn.innerHTML = '&#128228; Order All';
        alert('Dispatch error: ' + e.message);
      });
  };

  Promise.all([
    mediatorFetch('aggregate/status').then(function(r) { return r.json(); }),
    lmisGet('/api/orderables?size=100').catch(function() { return { content: [] }; }),
    fhir('Practitioner?_count=50').catch(function() { return { entry: [] }; }),
    lmisGet('/api/stockCardSummaries?facility=' + CONFIG.lmisFacility + '&program=' + CONFIG.lmisProgram + '&size=100').catch(function() { return { content: [] }; }),
  ]).then(function(results) {
    var status     = results[0];
    var orderables = (results[1].content || []);
    var pracBundle = results[2];
    var sohCards   = (results[3].content || []);

    // Build orderable ID → stock on hand map
    var sohMap = {};
    sohCards.forEach(function(c) {
      if (c.orderable && c.orderable.id != null) sohMap[c.orderable.id] = c.stockOnHand != null ? c.stockOnHand : '—';
    });

    // Build orderable ID → name map
    var orderableNames = {};
    orderables.forEach(function(o) {
      orderableNames[o.id] = o.fullProductName || (o.productCode && o.productCode.value) || o.id;
    });

    // Build practitioner ID → display name map
    var pracNames = {};
    entries(pracBundle).forEach(function(p) {
      var n = p.name && p.name[0];
      var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
      var family = n ? (n.family || '') : '';
      pracNames['Practitioner/' + p.id] = [given, family].filter(Boolean).join(' ') || p.id;
    });

    var period       = status.period || '';
    var nextDt       = status.nextDispatch ? new Date(status.nextDispatch) : null;
    var lastDt       = status.lastDispatched ? new Date(status.lastDispatched) : null;
    var frequency    = status.frequency || 'disabled';

    // Update the always-visible header strip with real period + dispatch status
    var hdrPeriod = document.getElementById('hdr-period');
    if (hdrPeriod) hdrPeriod.textContent = period.slice(0,4) + '-' + period.slice(4);
    var hdrStatus = document.getElementById('hdr-dispatch-status');
    if (hdrStatus) {
      if (frequency === 'disabled') {
        hdrStatus.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:#ffebee;color:#c62828;border-radius:4px;font-weight:600;font-size:13px">&#9940; Auto-dispatch disabled &mdash; use <strong style="text-decoration:underline;cursor:pointer" id="hdr-dispatch-now">Order All</strong> to send manually</span>';
        var hdrDispatchNow = document.getElementById('hdr-dispatch-now');
        if (hdrDispatchNow) hdrDispatchNow.onclick = function() { document.getElementById('btn-dispatch').click(); };
      } else {
        hdrStatus.innerHTML = '<span style="font-size:13px;color:#2e7d32;font-weight:600">&#10003; ' + (frequency.charAt(0).toUpperCase() + frequency.slice(1)) + ' auto-dispatch active</span>' +
          (nextDt ? '<span style="font-size:12px;color:#6b7a8d;margin-left:8px">Next: ' + esc(nextDt.toDateString()) + '</span>' : '');
      }
    }
    var FREQ_LABELS  = { daily: 'Daily — 06:00', weekly: 'Weekly — Mon 06:00', monthly: 'Monthly — 1st 06:00', disabled: 'Disabled' };
    var buffer       = status.buffer || {};
    var performersByOU = status.performersByOU || {};

    // Facility scope: facility-locked roles only see org units at their own health
    // centre. An OU's facility is taken from its performers' facilityId.
    var _ouFacility = function(ou) {
      var ps = performersByOU[ou] || [];
      for (var i = 0; i < ps.length; i++) { if (ps[i].facilityId) return ps[i].facilityId; }
      // Fall back to the OU's configured facility so village OUs (which usually have
      // no performer mapped directly) still scope to a facility instead of failing open.
      return (OU_LABELS[ou] || {}).lmisFacility || null;
    };
    var _ouInScope = function(ou) {
      if (!window.BKM_FACILITY_LOCKED) return true;
      var f = _ouFacility(ou);
      return f == null || f === CONFIG.lmisFacility;  // hide OUs known to be at another facility
    };

    // Build ordered medicines list (merge buffer + DE map)
    var allDEs = Object.values(buffer);

    // Drop out-of-scope org units from each medicine's breakdown so totals + cards scope too.
    if (window.BKM_FACILITY_LOCKED) {
      allDEs.forEach(function(entry) {
        if (!entry.byOrgUnit) return;
        Object.keys(entry.byOrgUnit).forEach(function(ou) { if (!_ouInScope(ou)) delete entry.byOrgUnit[ou]; });
        if (typeof entry.totalQty === 'number') {
          entry.totalQty = Object.keys(entry.byOrgUnit).reduce(function(s, ou) { return s + (entry.byOrgUnit[ou] || 0); }, 0);
        }
      });
    }

    // Compute per-org-unit totals
    var ouTotals = {};
    allDEs.forEach(function(entry) {
      Object.keys(entry.byOrgUnit || {}).forEach(function(ou) {
        if (!ouTotals[ou]) ouTotals[ou] = 0;
        ouTotals[ou] += entry.byOrgUnit[ou] || 0;
      });
    });

    // ── Dispatch Status Banner ─────────────────────────────────────────────
    var alreadyDispatched = !!status.lastDispatched;
    var html =
      '<div class="dispatch-banner">' +
        '<div class="dispatch-cell">' +
          '<div class="dispatch-cell-label">Current Period</div>' +
          '<div class="dispatch-cell-value">' + esc(period.slice(0,4) + '-' + period.slice(4)) + '</div>' +
          '<div class="dispatch-cell-sub">Monthly accumulation window</div>' +
          (frequency === 'disabled'
            ? '<div style="margin-top:6px;padding:4px 8px;background:#ffebee;color:#c62828;border-radius:4px;font-size:12px;font-weight:600">&#9940; Auto-dispatch disabled — use Order All to send manually</div>'
            : '') +
        '</div>' +
        '<div class="dispatch-cell">' +
          '<div class="dispatch-cell-label">This Period Status</div>' +
          '<div class="dispatch-cell-value ' + (alreadyDispatched ? 'green' : 'amber') + '">' +
            (alreadyDispatched ? '&#10003; Dispatched' : '&#9679; Pending') +
          '</div>' +
          '<div class="dispatch-cell-sub">' + (lastDt ? 'Sent ' + lastDt.toLocaleString() : 'Not yet sent to OpenLMIS') + '</div>' +
        '</div>' +
        '<div class="dispatch-cell">' +
          '<div class="dispatch-cell-label">Dispatch Schedule</div>' +
          '<div class="dispatch-cell-value">' + esc(FREQ_LABELS[frequency] || frequency) + '</div>' +
          '<div class="dispatch-cell-sub">' + (nextDt ? 'Next: ' + esc(nextDt.toDateString() + ' 06:00') + ' &mdash; in ' + countdown(nextDt) : 'Auto-dispatch is off') + '</div>' +
          '<div class="schedule-btns">' +
            ['daily','weekly','monthly','disabled'].map(function(f) {
              var label = f === 'disabled' ? '&#9940; Disable' : f.charAt(0).toUpperCase() + f.slice(1);
              var style = f === 'disabled' ? (f === frequency ? ' style="background:#b71c1c;color:#fff"' : ' style="color:#c62828"') : '';
              return '<button class="sched-btn' + (f === frequency ? ' active' : '') + '" data-freq="' + f + '"' + style + '>' + label + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="dispatch-cell">' +
          '<div class="dispatch-cell-label">Total Pending Tablets' +
            '<span class="help-tip" title="Sum of all tablet quantities ordered by VHWs this period, across every village and medicine. &quot;Medicine line&quot; = one distinct medicine (e.g. AL 20/120mg). This total will be sent to OpenLMIS when you click Dispatch Now or when the scheduled dispatch fires.">?</span>' +
          '</div>' +
          '<div class="dispatch-cell-value ' + (allDEs.length ? 'amber' : '') + '">' +
            allDEs.reduce(function(s, e) { return s + (e.totalQty || 0); }, 0) +
          '</div>' +
          '<div class="dispatch-cell-sub">' + allDEs.length + ' medicine line(s) across all villages</div>' +
        '</div>' +
      '</div>';

    // ── Dispatch History ───────────────────────────────────────────────────
    var logEntries = Object.entries(status.dispatchLog || {}).sort(function(a, b) { return b[0].localeCompare(a[0]); });
    html += '<article style="margin-bottom:16px">';
    html += '<h3 style="margin:0 0 10px">Dispatch History</h3>';
    if (logEntries.length === 0) {
      html += '<p style="color:var(--dhis2-text-muted);font-size:13px">No dispatches recorded yet.</p>';
    } else {
      var MAX_HIST = 5;
      var histRows = function(es) {
        return es.map(function(kv) {
          return '<tr>' +
            '<td><strong>' + esc(kv[0].slice(0,4) + '-' + kv[0].slice(4)) + '</strong></td>' +
            '<td>' + esc(new Date(kv[1]).toLocaleString()) + '</td>' +
            '<td>' + badge('Sent', 'active') + '</td>' +
          '</tr>';
        });
      };
      html += table(['Period', 'Dispatched At', 'Status'], histRows(logEntries.slice(0, MAX_HIST)), 'No history.');
      if (logEntries.length > MAX_HIST) {
        html += '<p style="margin:4px 0 0;font-size:13px">' +
          '<a href="#" id="hist-expand" style="color:var(--dhis2-blue)">Show all ' + logEntries.length + ' entries ▾</a>' +
        '</p>';
        html += '<div id="hist-extra" hidden>' +
          table(['Period', 'Dispatched At', 'Status'], histRows(logEntries.slice(MAX_HIST)), '') +
        '</div>';
      }
    }
    html += '</article>';

    // ── Per-Village Order Cards ────────────────────────────────────────────
    var knownOUs = Object.keys(OU_LABELS).filter(_ouInScope);
    // Include any org units from buffer that we don't know (ouTotals is already scoped)
    Object.keys(ouTotals).forEach(function(ou) {
      if (knownOUs.indexOf(ou) === -1) knownOUs.push(ou);
    });

    var villagesWithOrders = knownOUs.filter(function(ou) { return (ouTotals[ou] || 0) > 0; }).length;

    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap">';
    html += '<h3 style="margin:0">Pending Orders by Village / VHW</h3>';
    html += '<span style="font-size:13px;color:var(--dhis2-text-muted)">' +
      villagesWithOrders + ' village' + (villagesWithOrders !== 1 ? 's' : '') + ' with orders' +
      (knownOUs.length > villagesWithOrders ? ' (' + knownOUs.length + ' total)' : '') + '</span>';
    html += '</div>';

    html += '<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center">';
    html += '<input type="search" id="village-search" placeholder="Filter by village or VHW…" ' +
      'style="padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;width:240px">';
    html += '<label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer">' +
      '<input type="checkbox" id="hide-empty-villages" checked> Hide villages with no orders</label>';
    html += '</div>';

    html += '<div id="village-cards">';
    knownOUs.forEach(function(ou) {
      var label      = OU_LABELS[ou] || { village: ou, region: '', facility: '' };
      var performers = performersByOU[ou] || [];
      // For facility-level OUs (label includes "(Facility)" or has a facility
      // field), the village VHW listing is misleading — show only "Ordered by"
      // on those cards. For village OUs, list the actual VHW(s) so the
      // operator knows who's going to receive the stock.
      var isFacility = !!label.facility || /\(Facility\)/i.test(label.village || '');
      var vhws       = performers.filter(function(p) { return (p.role || '').toLowerCase() === 'vhw'; });
      var shown      = isFacility ? [] : (vhws.length ? vhws : performers);
      var vhwLabel   = isFacility ? null : (vhws.length ? 'VHW' : 'Staff');
      var vhwNames   = shown.map(function(p) {
        return p.name || pracNames[p.practitionerId] || p.practitionerId;
      }).filter(function(v, i, a) { return v && a.indexOf(v) === i; }).join(', ') || '—';
      var vhwPhone   = shown.map(function(p) { return p.phone; })
        .filter(function(v, i, a) { return v && a.indexOf(v) === i; }).join(', ');

      // Who placed the actual pending orders for this OU? Read byOrigin from
      // every buffer entry that has an order quantity for this OU. Dedupe and
      // map Practitioner reference -> display name.
      var orderedByIds = [];
      allDEs.forEach(function(e) {
        var origin = (e.byOrigin || {})[ou];
        if (origin && orderedByIds.indexOf(origin) === -1) orderedByIds.push(origin);
      });
      var orderedByLabel = orderedByIds.map(function(id) {
        var p = performers.find(function(q) { return q.practitionerId === id; });
        if (p && p.name) return p.name;
        return pracNames[id] || id;
      }).join(', ');
      var total      = ouTotals[ou] || 0;
      var hasOrders  = total > 0;

      // Per-medicine orders for this org unit
      var medicineRows = allDEs.map(function(entry) {
        var qty = (entry.byOrgUnit || {})[ou] || 0;
        if (qty === 0) return null;
        var name = orderableNames[entry.orderableId] || entry.orderableId || entry.de;
        var soh  = sohMap[entry.orderableId];
        var sohCell = soh == null ? '<span style="color:#aaa">—</span>'
          : '<strong style="color:' + (soh <= 0 ? '#c62828' : soh < qty ? '#e65100' : '#2e7d32') + '">' + soh + '</strong>';
        return '<tr>' +
          '<td>' + esc(name) + '</td>' +
          '<td><strong>' + qty + '</strong></td>' +
          '<td>' + sohCell + '</td>' +
          '<td style="white-space:nowrap">' +
          '<button class="btn btn-sm btn-dispatch-medicine" ' +
          'style="background:#e8f5e9;color:#2e7d32;border-color:#a5d6a7;padding:2px 8px;font-size:11px;margin-right:4px" ' +
          'data-ou="' + esc(ou) + '" data-orderable="' + esc(entry.orderableId) + '" data-name="' + esc(name) + '" data-qty="' + qty + '" title="Order this medicine for this village now">' +
          '&#128228; Order</button>' +
          '<button class="btn btn-sm btn-cancel-medicine" ' +
          'style="background:#fce4ec;color:#c62828;border-color:#f48fb1;padding:2px 8px;font-size:11px" ' +
          'data-ou="' + esc(ou) + '" data-orderable="' + esc(entry.orderableId) + '" data-name="' + esc(name) + '">' +
          '&#128465;</button>' +
          '</td>' +
        '</tr>';
      }).filter(Boolean);

      html += '<div class="order-village-card"' +
        ' data-has-orders="' + hasOrders + '"' +
        ' data-village="' + esc(label.village.toLowerCase()) + '"' +
        ' data-vhw="' + esc(vhwNames.toLowerCase()) + '"' +
        ' data-ou="' + esc(ou) + '">';
      html += '<div class="order-village-header">' +
        '<span class="order-village-name">&#128205; ' + esc(label.village) + '</span>' +
        (vhwLabel ? '<span class="order-village-vhw">' + esc(vhwLabel) + ': ' + esc(vhwNames) + (vhwPhone ? ' &bull; ' + esc(vhwPhone) : '') + '</span>' : '') +
        (orderedByLabel ? '<span class="order-village-vhw" style="margin-left:8px;font-weight:600;background:rgba(255,255,255,0.18);color:#fff;padding:2px 8px;border-radius:10px">Ordered by: ' + esc(orderedByLabel) + '</span>' : '') +
        '<span class="order-village-total">' + total + ' units</span>' +
        (hasOrders
          ? '<button class="btn-cancel-order" data-ou="' + esc(ou) + '" data-village="' + esc(label.village) + '" ' +
              'style="margin-left:auto;padding:4px 10px;font-size:12px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer">' +
              '&#10006; Cancel Order' +
            '</button>'
          : '') +
      '</div>';

      if (medicineRows.length === 0) {
        html += '<p style="padding:10px 14px;margin:0;color:var(--dhis2-text-muted);font-size:13px">No pending orders this period.</p>';
      } else {
        html += '<div style="padding:0">' +
          table(['Medicine', 'Ordered Qty', 'Facility SOH', ''], medicineRows, '') +
        '</div>';
      }
      html += '</div>';
    });
    html += '</div>'; // #village-cards

    // ── Facility Totals ────────────────────────────────────────────────────
    html += '<article style="margin-top:16px">';
    html += '<h3 style="margin:0 0 10px">Facility Total — All Villages Combined</h3>';
    if (allDEs.length === 0) {
      html += '<p style="color:var(--dhis2-text-muted);font-size:13px">No pending orders in buffer.</p>';
    } else {
      html += table(
        ['Medicine', 'Total Ordered (all villages)', 'Facility SOH'],
        allDEs.map(function(entry) {
          var soh = sohMap[entry.orderableId];
          var sohCell = soh == null ? '<span style="color:#aaa">—</span>'
            : '<strong style="font-size:15px;color:' + (soh <= 0 ? '#c62828' : soh < entry.totalQty ? '#e65100' : '#2e7d32') + '">' + soh + '</strong>';
          return '<tr>' +
            '<td>' + esc(orderableNames[entry.orderableId] || entry.de) + '</td>' +
            '<td><strong style="font-size:15px">' + entry.totalQty + '</strong></td>' +
            '<td>' + sohCell + '</td>' +
          '</tr>';
        }),
        'No orders.'
      );
    }
    html += '</article>';

    document.getElementById('orders-content').innerHTML = html;

    // Dispatch history expand
    var histExpand = document.getElementById('hist-expand');
    if (histExpand) {
      histExpand.addEventListener('click', function(e) {
        e.preventDefault();
        document.getElementById('hist-extra').hidden = false;
        histExpand.parentElement.hidden = true;
      });
    }

    // Village cards: search + empty-village filter
    function applyVillageFilter() {
      var query     = (document.getElementById('village-search').value || '').toLowerCase().trim();
      var hideEmpty = document.getElementById('hide-empty-villages').checked;
      document.querySelectorAll('#village-cards .order-village-card').forEach(function(card) {
        var hasOrders   = card.getAttribute('data-has-orders') === 'true';
        var villageName = card.getAttribute('data-village') || '';
        var vhwName     = card.getAttribute('data-vhw') || '';
        var matchSearch = !query || villageName.indexOf(query) !== -1 || vhwName.indexOf(query) !== -1;
        var matchFilter = !hideEmpty || hasOrders;
        card.style.display = (matchSearch && matchFilter) ? '' : 'none';
      });
    }
    document.getElementById('village-search').addEventListener('input', applyVillageFilter);
    document.getElementById('hide-empty-villages').addEventListener('change', applyVillageFilter);
    applyVillageFilter();

    document.querySelectorAll('.sched-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var freq = this.getAttribute('data-freq');
        mediatorFetch('aggregate/schedule', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frequency: freq }),
        })
          .then(function(r) { return r.json(); })
          .then(function() { renderOrders(el); })
          .catch(function(e) { alert('Schedule update failed: ' + e.message); });
      });
    });

    document.querySelectorAll('.btn-dispatch-medicine').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ou        = btn.getAttribute('data-ou');
        var orderable = btn.getAttribute('data-orderable');
        var name      = btn.getAttribute('data-name');
        var qty       = btn.getAttribute('data-qty');
        if (!confirm('Order ' + name + ' (' + qty + ' units) for this village?\n\nA delivery Task will be created for the facility worker.')) return;
        btn.disabled = true;
        btn.textContent = '…';
        mediatorFetch('aggregate/orders/ou/' + encodeURIComponent(ou) + '/medicine/' + encodeURIComponent(orderable), { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.status === 'ok') {
              renderOrders(el);
            } else {
              btn.disabled = false;
              btn.innerHTML = '&#128228; Order';
              alert('Dispatch failed: ' + (d.message || JSON.stringify(d)));
            }
          })
          .catch(function(e) {
            btn.disabled = false;
            btn.innerHTML = '&#128228; Order';
            alert('Error: ' + e.message);
          });
      });
    });

    document.querySelectorAll('.btn-cancel-medicine').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ou       = btn.getAttribute('data-ou');
        var orderable = btn.getAttribute('data-orderable');
        var name     = btn.getAttribute('data-name');
        if (!confirm('Remove ' + name + ' order for this village?\n\nThis cannot be undone.')) return;
        btn.disabled = true;
        btn.textContent = '…';
        mediatorFetch('aggregate/orders/ou/' + encodeURIComponent(ou) + '/medicine/' + encodeURIComponent(orderable), { method: 'DELETE' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.status === 'ok') {
              renderOrders(el);
            } else {
              btn.disabled = false;
              btn.innerHTML = '&#128465;';
              alert('Delete failed: ' + (d.message || JSON.stringify(d)));
            }
          })
          .catch(function(e) {
            btn.disabled = false;
            btn.innerHTML = '&#128465;';
            alert('Error: ' + e.message);
          });
      });
    });

    document.querySelectorAll('.btn-cancel-order').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var ou      = btn.getAttribute('data-ou');
        var village = btn.getAttribute('data-village');
        if (!confirm('Cancel all pending orders for ' + village + ' this period?\n\nThis cannot be undone — the quantities will be zeroed in the buffer.')) return;
        btn.disabled = true;
        btn.textContent = 'Cancelling…';
        mediatorFetch('aggregate/orders/ou/' + encodeURIComponent(ou), { method: 'DELETE' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.status === 'ok') {
              renderOrders(el);
            } else {
              btn.disabled = false;
              btn.innerHTML = '&#10006; Cancel Order';
              alert('Cancel failed: ' + (d.message || JSON.stringify(d)));
            }
          })
          .catch(function(e) {
            btn.disabled = false;
            btn.innerHTML = '&#10006; Cancel Order';
            alert('Error cancelling order: ' + e.message);
          });
      });
    });
  }).catch(function(e) {
    document.getElementById('orders-content').innerHTML =
      '<article class="err"><strong>Error loading order data:</strong> ' + esc(e.message) + '</article>';
  });
}
