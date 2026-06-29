/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Builds the Stock-on-Hand table HTML for a stockCardSummaries + stockCards payload.
// Extracted so the facility selector can re-render it without reloading the page.
function lmisStockTableHtml(stockData, cardsData) {
  // An orderable can have MORE THAN ONE stock card (e.g. opening stock vs lot-keyed
  // dispenses), so collect ALL card ids per orderable — View Log merges them.
  var cardIdsByOrderable = {};
  if (cardsData && !cardsData.error) {
    (cardsData.content || []).forEach(function(c) {
      var oid = c.orderable && c.orderable.id;
      if (oid && c.id) (cardIdsByOrderable[oid] = cardIdsByOrderable[oid] || []).push(c.id);
    });
  }
  if (stockData && stockData.error) return '<p class="err">Error: ' + esc(stockData.error) + '</p>';
  var summaries = (stockData && stockData.content) || [];
  return '<div style="margin:0 0 12px;padding:10px 14px;background:#eef4fb;border-left:3px solid var(--dhis2-blue);border-radius:4px;font-size:13px;color:#33485f">' +
      'Stock on Hand below is queried live from <strong>OpenLMIS</strong>. ' +
      'Click <strong>View Log</strong> on any product to pull its latest transaction history (every receipt and dispense) straight from OpenLMIS.' +
    '</div>' +
    table(
    ['Product', 'Stock on Hand', 'Facility', 'Program', 'Details'],
    summaries.map(function(s) {
      var soh = s.stockOnHand;
      var sohBadge = (soh === null || soh === undefined) ? badge('Unknown', '') :
        (soh <= 0 ? badge('Stock-out: ' + soh, 'red') :
         soh < 100 ? badge('Low: ' + soh, 'inactive') :
         badge('' + soh, 'active'));
      return '<tr>' +
        '<td>' + esc((s.orderable && s.orderable.fullProductName) || (s.orderable && s.orderable.id) || '') + '</td>' +
        '<td>' + sohBadge + '</td>' +
        '<td>' + esc((s.facility && s.facility.name) || '') + '</td>' +
        '<td>' + esc((s.program && s.program.name) || '') + '</td>' +
        '<td>' + ((cardIdsByOrderable[s.orderable && s.orderable.id] || []).length
          ? '<a href="#/openlmis" class="btn btn-outline btn-sm" onclick="lmisShowCard(\'' + cardIdsByOrderable[s.orderable.id].join(',') + '\');return false;">View Log</a>'
          : '<span style="color:var(--dhis2-text-muted);font-size:12px">—</span>') + '</td>' +
        '</tr>';
    }),
    'No stock cards found for this facility/program.'
  );
}

// Resolves the logged-in Keycloak user's OpenLMIS facility by matching their KC id
// (token.sub) to a performer's sourceId/alias in the mediator's staff map. Falls back
// to the configured default facility. Lets the Stock page open on the worker's own clinic.
function resolveUserFacility() {
  var sub = (typeof kc !== 'undefined' && kc.tokenParsed && kc.tokenParsed.sub) || null;
  if (!sub) return Promise.resolve(CONFIG.lmisFacility);
  return mediatorFetch('aggregate/mappings').then(function(r) { return r.json(); }).then(function(d) {
    var perfs = (d && d.performers) || {};
    var key = 'Practitioner/' + sub;
    var fac = null;
    Object.keys(perfs).forEach(function(pid) {
      var p = perfs[pid] || {};
      if (pid === key || (p.aliases && p.aliases.indexOf(key) >= 0)) fac = p.facilityId;
    });
    return fac || CONFIG.lmisFacility;
  }).catch(function() { return CONFIG.lmisFacility; });
}

function renderOpenLMIS(el) {
  el.innerHTML =
    '<div class="page-header"><h2>OpenLMIS Data</h2>' +
    '<span style="color:var(--dhis2-text-muted);font-size:12px">Live data from OpenLMIS via API</span>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="lmis-data">Data</button>' +
      '<button class="page-tab" data-tab="lmis-help">? Help</button>' +
    '</div>' +
    '<div id="lmis-data"><div id="lmis-sections"><p aria-busy="true">Loading…</p></div></div>' +
    '<div id="lmis-help" class="help-panel" hidden>' +
      '<div class="help-section">' +
        '<h4>What is OpenLMIS?</h4>' +
        '<p><strong>OpenLMIS</strong> (Open Logistics Management Information System) is the health supply-chain ' +
        'backend for this sandbox. It tracks stock on hand, records every stock movement (receipts, dispenses, ' +
        'adjustments), manages facilities and programmes, and generates supply reports.</p>' +
        '<p>The full OpenLMIS web UI is at <a href="http://localhost:80" target="_blank">localhost:80</a> ' +
        '(admin / password).</p>' +
      '</div>' +
      '<div class="help-section">' +
        '<h4>What this page shows</h4>' +
        '<p>This page reads <strong>live data directly from the OpenLMIS REST API</strong> and displays it in ' +
        'tables for quick inspection without leaving this dashboard. All data is fetched fresh on every page load.</p>' +
        '<table>' +
          '<thead><tr><th>Section</th><th>What it shows</th></tr></thead>' +
          '<tbody>' +
            '<tr><td><strong>Facilities</strong></td><td>Health facilities registered in OpenLMIS (e.g. Maseru District Clinic A)</td></tr>' +
            '<tr><td><strong>Programs</strong></td><td>Supply programmes (e.g. Essential Medicines) that group products and facilities</td></tr>' +
            '<tr><td><strong>Orderables</strong></td><td>The product catalogue — medicines the system can order, dispense, and track</td></tr>' +
            '<tr><td><strong>Stock on Hand</strong></td><td>Current balance per product at the configured facility. "View Log" opens the full transaction history</td></tr>' +
            '<tr><td><strong>Adjustment Reasons</strong></td><td>Reasons used when posting stock movements (Consumed, Receipts, Expired, etc.)</td></tr>' +
            '<tr><td><strong>Users</strong></td><td>OpenLMIS user accounts</td></tr>' +
            '<tr><td><strong>Roles</strong></td><td>Role definitions and their associated access rights</td></tr>' +
          '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="help-section">' +
        '<h4>How the mediator connects to OpenLMIS</h4>' +
        '<p>Every time a VHW dispenses medicine on their Android device, the event flows through OpenHIM → ' +
        'bkm-mediator → <strong>POST /api/stockEvents</strong> on OpenLMIS. This debits the stock on hand and ' +
        'creates a line on the stock card visible in the "Stock on Hand → View Log" column above.</p>' +
        '<p>Batch orders dispatched from the <strong>Orders</strong> page are also posted as stock events ' +
        '(CREDIT — Receipts) so the facility balance increases when new stock arrives.</p>' +
      '</div>' +
      '<div class="help-section">' +
        '<h4>Why can Stock on Hand go negative?</h4>' +
        '<p>OpenLMIS has <strong>no database-level constraint</strong> preventing a DEBIT from taking stock below zero — ' +
        'it records exactly what the mediator sends. The mediator runs a pre-flight stock check before every dispense, ' +
        'but there are three reasons it can still result in negative stock:</p>' +
        '<table>' +
          '<thead><tr><th>Cause</th><th>Why it happens</th><th>How to fix</th></tr></thead>' +
          '<tbody>' +
            '<tr>' +
              '<td><strong>Fail-open safety gate</strong></td>' +
              '<td>If the stock-check API call to OpenLMIS times out or returns an error, the mediator ' +
              'deliberately allows the dispense through anyway. Patient care is never blocked by a ' +
              'monitoring outage.</td>' +
              '<td>Check mediator logs for <code>Stock check failed (fail-open)</code> warnings. Fix the ' +
              'underlying connectivity issue, then post a corrective receipt to restore the balance.</td>' +
            '</tr>' +
            '<tr>' +
              '<td><strong>Race condition</strong></td>' +
              '<td>Two dispense events arrive at nearly the same time. Both check stock, both see ' +
              'sufficient balance, both pass — but OpenLMIS debits both, leaving the balance negative.</td>' +
              '<td>Post a corrective receipt via the Orders page or directly via the mediator ' +
              '<code>POST /api/receipt</code> endpoint.</td>' +
            '</tr>' +
            '<tr>' +
              '<td><strong>Safety gate disabled</strong></td>' +
              '<td>The runtime setting <code>REJECT_DISPENSE_EXCEEDS_STOCK</code> is set to <code>false</code>, ' +
              'which skips the pre-flight check entirely.</td>' +
              '<td>Re-enable the check in the mediator Settings page and ensure it is set to <code>true</code>.</td>' +
            '</tr>' +
          '</tbody>' +
        '</table>' +
        '<p style="margin-top:10px;font-size:12px;color:var(--dhis2-text-muted)">To restore a negative balance: ' +
        'dispatch a receipt order from the <strong>Orders</strong> page for the affected product and facility. ' +
        'This posts a CREDIT stock event that brings the balance back above zero.</p>' +
      '</div>' +
    '</div>';

  el.querySelectorAll('.page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('lmis-data').hidden  = (target !== 'lmis-data');
      document.getElementById('lmis-help').hidden  = (target !== 'lmis-help');
    });
  });

  var sec = document.getElementById('lmis-sections');

  // Fetch all sections in parallel
  Promise.all([
    lmisGet('/api/facilities?size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/programs?size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/orderables?size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/users?size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/stockCardSummaries?facility=' + CONFIG.lmisFacility + '&program=' + CONFIG.lmisProgram + '&size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/validReasons?facilityType=health_center&program=' + CONFIG.lmisProgram).catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/roles?size=100').catch(function(e) { return {error: e.message}; }),
    lmisGet('/api/stockCards?facility=' + CONFIG.lmisFacility + '&program=' + CONFIG.lmisProgram + '&size=200').catch(function(e) { return {error: e.message}; }),
  ]).then(function(results) {
    var facilitiesData  = results[0];
    var programsData    = results[1];
    var orderablesData  = results[2];
    var usersData       = results[3];
    var stockData       = results[4];
    var reasonsData     = results[5];
    var rolesData       = results[6];
    var cardsData       = results[7];

    var html = '';

    // ── Stock Card Summaries (facility-selectable for multi-facility setups) ────
    var facList = (facilitiesData && facilitiesData.content) || [];
    if (!Array.isArray(facList)) facList = [];
    var facOptions = facList.slice().sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .map(function(f) { return '<option value="' + esc(f.id) + '"' + (f.id === CONFIG.lmisFacility ? ' selected' : '') + '>' + esc(f.name || f.id) + '</option>'; }).join('');
    var stockSelector;
    if (window.BKM_FACILITY_LOCKED) {
      // Facility-scoped roles can't switch facilities — show their own as a fixed label.
      var _myFac  = facList.filter(function(f) { return f.id === CONFIG.lmisFacility; })[0];
      var _myName = (_myFac && (_myFac.name || _myFac.id)) || (window.BKM_FACILITY && window.BKM_FACILITY.name) || CONFIG.lmisFacility;
      stockSelector = '<div style="margin:0 0 10px"><label style="font-size:13px;color:#4a5768">Facility: <strong>' + esc(_myName) + '</strong></label></div>';
    } else {
      stockSelector = facOptions
        ? '<div style="margin:0 0 10px"><label style="font-size:13px;color:#4a5768">Facility:' +
          ' <select id="lmis-fac-select" style="margin-left:6px;padding:4px 8px">' + facOptions + '</select></label></div>'
        : '';
    }
    var stockSection = stockSelector + '<div id="lmis-stock-table">' + lmisStockTableHtml(stockData, cardsData) + '</div>';
    html += accordionSection('lmis-stock', 'Stock on Hand', null, stockSection, true);

    // ── Facilities ────────────────────────────────────────────────────────────
    var facsHtml;
    if (facilitiesData.error) {
      facsHtml = '<p class="err">Error: ' + esc(facilitiesData.error) + '</p>';
    } else {
      var facs = facilitiesData.content || facilitiesData || [];
      if (!Array.isArray(facs)) facs = [];
      if (window.BKM_FACILITY_LOCKED) facs = facs.filter(function(f) { return f.id === CONFIG.lmisFacility; });
      facsHtml = table(
        ['Name', 'Code', 'Type', 'Active'],
        facs.map(function(f) {
          return '<tr>' +
            '<td>' + esc(f.name || '') + '</td>' +
            '<td><code>' + esc(f.code || '') + '</code></td>' +
            '<td>' + esc((f.type && f.type.name) || '') + '</td>' +
            '<td>' + badge(f.active ? 'Active' : 'Inactive', f.active ? 'active' : 'inactive') + '</td>' +
            '</tr>';
        }),
        'No facilities found.'
      );
    }
    html += accordionSection('lmis-facilities', 'Facilities', null, facsHtml, false);

    // ── Programs ──────────────────────────────────────────────────────────────
    var progsHtml;
    if (programsData.error) {
      progsHtml = '<p class="err">Error: ' + esc(programsData.error) + '</p>';
    } else {
      var progs = programsData || [];
      if (!Array.isArray(progs)) progs = [];
      progsHtml = table(
        ['Name', 'Code', 'Active'],
        progs.map(function(p) {
          return '<tr>' +
            '<td>' + esc(p.name || '') + '</td>' +
            '<td><code>' + esc(p.code || '') + '</code></td>' +
            '<td>' + badge(p.active ? 'Active' : 'Inactive', p.active ? 'active' : 'inactive') + '</td>' +
            '</tr>';
        }),
        'No programs found.'
      );
    }
    html += accordionSection('lmis-programs', 'Programs', null, progsHtml, false);

    // ── Orderables ────────────────────────────────────────────────────────────
    var ordsHtml;
    if (orderablesData.error) {
      ordsHtml = '<p class="err">Error: ' + esc(orderablesData.error) + '</p>';
    } else {
      var ords = orderablesData.content || orderablesData || [];
      if (!Array.isArray(ords)) ords = [];
      ordsHtml = table(
        ['Full Product Name', 'Product Code', 'Net Content', 'Dispensable'],
        ords.map(function(o) {
          return '<tr>' +
            '<td>' + esc(o.fullProductName || '') + '</td>' +
            '<td><code>' + esc((o.productCode && o.productCode.value) || '') + '</code></td>' +
            '<td>' + esc(o.netContent || '') + '</td>' +
            '<td>' + esc((o.dispensable && o.dispensable.dispensingUnit) || '') + '</td>' +
            '</tr>';
        }),
        'No orderables found.'
      );
    }
    html += accordionSection('lmis-orderables', 'Orderables (Products)', null, ordsHtml, false);

    // ── Adjustment Reasons ────────────────────────────────────────────────────
    var reasonsHtml;
    if (reasonsData.error) {
      reasonsHtml = '<p class="err">Error: ' + esc(reasonsData.error) + '</p>';
    } else {
      var reasons = reasonsData || [];
      if (!Array.isArray(reasons)) reasons = [];
      reasonsHtml = table(
        ['Name', 'Category', 'Type'],
        reasons.map(function(r) {
          return '<tr>' +
            '<td>' + esc(r.name || '') + '</td>' +
            '<td>' + esc(r.reasonCategory || '') + '</td>' +
            '<td>' + esc(r.reasonType || '') + '</td>' +
            '</tr>';
        }),
        'No reasons found.'
      );
    }
    html += accordionSection('lmis-reasons', 'Adjustment Reasons', null, reasonsHtml, false);

    // ── Users ─────────────────────────────────────────────────────────────────
    var usersHtml;
    if (usersData.error) {
      usersHtml = '<p class="err">Error: ' + esc(usersData.error) + '</p>';
    } else {
      var users = usersData.content || usersData || [];
      if (!Array.isArray(users)) users = [];
      usersHtml = table(
        ['Username', 'First Name', 'Last Name', 'Email', 'Active'],
        users.map(function(u) {
          return '<tr>' +
            '<td><strong>' + esc(u.username || '') + '</strong></td>' +
            '<td>' + esc(u.firstName || '') + '</td>' +
            '<td>' + esc(u.lastName || '') + '</td>' +
            '<td>' + esc(u.email || '') + '</td>' +
            '<td>' + badge(u.active ? 'Active' : 'Inactive', u.active ? 'active' : 'inactive') + '</td>' +
            '</tr>';
        }),
        'No users found.'
      );
    }
    html += accordionSection('lmis-users', 'Users', null, usersHtml, false);

    // ── Roles ─────────────────────────────────────────────────────────────────
    var rolesHtml;
    if (rolesData.error) {
      rolesHtml = '<p class="err">Error: ' + esc(rolesData.error) + '</p>';
    } else {
      var roles = rolesData || [];
      if (!Array.isArray(roles)) roles = [];
      rolesHtml = table(
        ['Name', 'Description', 'Rights'],
        roles.map(function(r) {
          var rights = r.rights || [];
          return '<tr>' +
            '<td><strong>' + esc(r.name || '') + '</strong></td>' +
            '<td>' + esc(r.description || '') + '</td>' +
            '<td style="font-size:11px;color:var(--dhis2-text-muted)">' + rights.map(function(rt) { return esc(rt.name || ''); }).join(', ') + '</td>' +
            '</tr>';
        }),
        'No roles found.'
      );
    }
    html += accordionSection('lmis-roles', 'Roles', null, rolesHtml, false);

    sec.innerHTML = html;
    wireAccordions();

    // Facility selector: re-query Stock on Hand for the chosen facility without a full reload.
    var _facSel = document.getElementById('lmis-fac-select');
    if (_facSel) _facSel.onchange = function() {
      var fid = _facSel.value;
      var tdiv = document.getElementById('lmis-stock-table');
      if (tdiv) tdiv.innerHTML = '<p style="color:#888;font-size:13px">Loading…</p>';
      Promise.all([
        lmisGet('/api/stockCardSummaries?facility=' + fid + '&program=' + CONFIG.lmisProgram + '&size=100').catch(function(e) { return { error: e.message }; }),
        lmisGet('/api/stockCards?facility=' + fid + '&program=' + CONFIG.lmisProgram + '&size=200').catch(function(e) { return { error: e.message }; }),
      ]).then(function(r) { if (tdiv) tdiv.innerHTML = lmisStockTableHtml(r[0], r[1]); });
    };

    // Auto-select the logged-in worker's own facility (e.g. fw.clinic.b → Clinic B).
    if (_facSel) {
      resolveUserFacility().then(function(fac) {
        if (!fac || fac === _facSel.value) return;
        var has = Array.prototype.some.call(_facSel.options, function(o) { return o.value === fac; });
        if (has) { _facSel.value = fac; _facSel.onchange(); }
      });
    }
  }).catch(function(e) {
    sec.innerHTML = '<article class="err"><strong>Error loading OpenLMIS data:</strong> ' + esc(e.message) + '</article>';
  });
}

function lmisShowCard(cardIds) {
  if (!cardIds) return;
  var _ids = String(cardIds).split(',').filter(Boolean);
  Promise.all(_ids.map(function(id) { return lmisGet('/api/stockCards/' + id); })).then(function(cards) {
    // An orderable may have several cards (opening stock + lot-keyed dispenses).
    // Merge all their line items chronologically; total SOH = sum of each card's latest balance.
    var lineItems = [], soh = 0, _sohKnown = false, _ordName = '';
    cards.forEach(function(card) {
      var _li = (card && card.lineItems) || [];
      _li.forEach(function(x) { lineItems.push(x); });
      var _latest = _li.length ? _li[_li.length - 1] : null;   // each card is oldest-first
      if (_latest && _latest.stockOnHand !== undefined && _latest.stockOnHand !== null) { soh += _latest.stockOnHand; _sohKnown = true; }
      if (!_ordName && card && card.orderable && card.orderable.fullProductName) _ordName = card.orderable.fullProductName;
    });
    if (!_sohKnown) soh = null;
    lineItems.sort(function(a, b) {
      var da = a.processedDate || a.occurredDate || '', db = b.processedDate || b.occurredDate || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    var statusBadge;
    if (soh === null || soh === undefined) statusBadge = badge('Unknown', '');
    else if (soh <= 0)                     statusBadge = badge('Stock-out', 'red');
    else if (soh < 100)                    statusBadge = badge('Low', 'inactive');
    else                                   statusBadge = badge('Adequate', 'active');

    var receipts = 0, dispenses = 0;
    lineItems.forEach(function(li) {
      var t = li.reasonType || li.type;
      if (t === 'CREDIT') receipts++; else if (t === 'DEBIT') dispenses++;
    });

    var header =
      '<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:14px;padding:12px 16px;background:#f5f8fb;border-radius:6px">' +
        '<div>' +
          '<div style="font-size:11px;color:#757575;text-transform:uppercase;letter-spacing:.04em">Stock on Hand</div>' +
          '<div style="font-size:26px;font-weight:700;line-height:1.1">' +
            esc(soh !== undefined && soh !== null ? soh : '—') + ' &nbsp;' + statusBadge +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#33485f">' +
          '<span style="color:#2e7d32;font-weight:600">' + receipts + '</span> receipt' + (receipts !== 1 ? 's' : '') +
          ' &nbsp;·&nbsp; ' +
          '<span style="color:#b71c1c;font-weight:600">' + dispenses + '</span> dispense' + (dispenses !== 1 ? 's' : '') +
        '</div>' +
        '<button class="btn btn-outline btn-sm" style="margin-left:auto" ' +
          'onclick="lmisShowCard(\'' + esc(cardIds) + '\');return false;">&#8635; Refresh</button>' +
      '</div>';

    var tableHtml = table(
      ['Date / Time', 'Reason', 'Type', 'Qty', 'SOH', 'Source / Destination', 'Reference'],
      lineItems.slice().reverse().map(function(li) {
        var when = li.processedDate
          ? '<span title="' + esc(li.processedDate) + '">' + esc(fmtDateTime(li.processedDate)) + '</span>'
          : esc(fmtDate(li.occurredDate || ''));
        var srcDst = (li.source && li.source.name) || (li.destination && li.destination.name) || '';
        var note   = li.reasonFreeText
          ? '<div style="font-size:11px;color:#9e9e9e">' + esc(li.reasonFreeText) + '</div>' : '';
        return '<tr>' +
          '<td>' + when + '</td>' +
          '<td>' + esc((li.reason && li.reason.name) || '') + note + '</td>' +
          '<td>' + badge(li.reasonType || li.type || '', li.reasonType === 'DEBIT' ? 'inactive' : 'active') + '</td>' +
          '<td>' + esc(li.quantity !== undefined ? li.quantity : '') + '</td>' +
          '<td><strong>' + esc(li.stockOnHand !== undefined ? li.stockOnHand : '') + '</strong></td>' +
          '<td>' + (srcDst ? esc(srcDst) : '<span style="color:#ccc">—</span>') + '</td>' +
          '<td>' + (li.documentNumber ? esc(li.documentNumber) : '<span style="color:#ccc">—</span>') + '</td>' +
          '</tr>';
      }),
      'No line items.'
    );

    var html = header + '<div style="max-height:55vh;overflow-y:auto">' + tableHtml + '</div>';
    showModal('Stock Card Log — ' + esc(_ordName || _ids[0]), html);
  }).catch(function(e) {
    alert('Error loading stock card: ' + e.message);
  });
}
