/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

function renderHome(el) {
  el.innerHTML = '<p aria-busy="true" style="padding:32px">Loading…</p>';

  Promise.all([
    fhir('Patient?_summary=count').catch(function()       { return { total: '—' }; }),
    fhir('Practitioner?_summary=count').catch(function()  { return { total: '—' }; }),
    fhir('CareTeam?_summary=count').catch(function()      { return { total: '—' }; }),
    fhir('Questionnaire?_summary=count').catch(function() { return { total: '—' }; }),
    mediatorFetch('aggregate/status').then(function(r) { return r.json(); }).catch(function() { return null; }),
    fhir('Task?_count=500&_elements=id,status,owner').catch(function() { return { entry: [] }; }),
    mediatorFetch('aggregate/performers').then(function(r) { return r.json(); }).catch(function() { return {}; }),
  ]).then(function(res) {
    var orderStatus = res[4];
    var taskBundle  = res[5];
    var performers  = res[6] || {};

    el.innerHTML =
      '<div class="home-hero">' +
        '<div class="home-hero-flag-stack">' +
          '<img src="lesotho-flag.jpg" class="home-hero-flag" alt="Lesotho flag">' +
          // necxon flag removed from landing page per request:
          // '<img src="oip.webp" class="home-hero-flag-sub" alt="">' +
        '</div>' +
        '<div class="home-hero-title">BKM Digital Health Management Portal (v1.1.0 - 2026-06-22)</div>' +
        (function() {
          var parsed = (typeof kc !== 'undefined' && kc.tokenParsed) || {};
          var uname  = parsed.preferred_username || parsed.name || '';
          var role   = window.BKM_ROLE || '';
          if (!uname) return '';
          // Resolve the logged-in user's facility (KC sub is a performer alias key).
          var sub  = parsed.sub;
          var perf = (sub && (performers['Practitioner/' + sub] || performers[sub])) || {};
          var facName = perf.facilityName || '';
          return '<div class="home-hero-user">' +
            esc(uname) +
            (role ? ' <span class="home-hero-user-role">(' + esc(role) + ')</span>' : '') +
            (facName ? '<div class="home-hero-user-facility" style="font-size:13px;color:#fff;margin-top:3px">&#128205; ' + esc(facName) + '</div>' : '') +
          '</div>';
        })() +
      '</div>' +

      '<div class="home-stats">' +
        _hStat(res[0].total, 'BKM Patients',      '#/patients') +
        _hStat(res[1].total, 'BKM Field Workers', '#/practitioners') +
        _hStat(res[2].total, 'BKM Care Teams',    '#/care-teams') +
        _hStat(res[3].total, 'BKM Menus',     '#/questionnaires') +
      '</div>' +

      '<div class="home-ops">' +
        // Order Management + Tasks cards hidden for now (not needed) —
        // _hOrderSummary(orderStatus) + _hTaskSummary(taskBundle, performers) +
        '' +
      '</div>' +

      '<div class="home-cards">' +
        _hCard('opensrp', 'OpenSRP (BKM)', 'https://opensrp.io/', 'opensrp.io',
          'Community health worker management — patients, practitioners, care teams, locations, groups, forms and Android app navigation.',
          [
            ['Patients',      '#/patients'],
            ['Practitioners', '#/practitioners'],
            ['Care Teams',    '#/care-teams'],
            ['Locations',     '#/locations'],
            ['Groups',        '#/groups'],
            ['Forms',         '#/questionnaires'],
            ['App Nav',       '#/navigation'],
            ['FHIR Browser',  '#/fhir'],
          ]
        ) +
        _hCard('mediator', 'Mediator', 'https://www.nec.africa/', 'nec.africa',
          'BKM integration engine — routes dispense and receipt events from the Android app to OpenLMIS and DHIS2. Manages field-worker mappings, settings and order dispatch.',
          (function() {
            var links = [
              // Tasks + Order Management hidden for now (not needed)
              ['Mappings',   '#/mappings'],
            ];
            if (window.BKM_ROLE === 'admin') {
              links.push(['Settings', '#/settings']);
            }
            return links;
          })()
        ) +
        _hCard('openlmis', 'LMIS', 'https://github.com/OpenLMIS', 'github.com/OpenLMIS',
          'Logistics management information system — stock cards, dispense events, stock on hand per facility and programme.',
          [
            ['Stock Log',      '#/stock'],
            ['LMIS Live Data', '#/openlmis'],
          ]
        ) +
        (window.BKM_ROLE === 'admin'
          ? _hCard('system', 'System Monitoring & Administration', null, null,
              'Infrastructure health, service status, integration flow visualisation and system administration tools.',
              [
                ['Flow',     '#/flow'],
                ['Services', '#/services'],
              ]
            )
          : '') +
        // QR code (right corner, next to System Monitoring & Administration).
        // Just displays the Android team's QR at bkm-web/image.png — scanning it with a
        // phone camera opens whatever install link that QR encodes. Replace the image to
        // change the target. Card hides itself if the image is missing.
        '<div class="home-qr-card" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;background:#fff;border:1px solid #e3e8ef;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-left:auto;align-self:start;max-width:210px">' +
          '<img src="image.png" alt="Scan to install the BKM app" width="150" height="150" style="display:block;border-radius:6px" ' +
            'onerror="this.closest(\'.home-qr-card\').style.display=\'none\'">' +
          '<div style="text-align:center">' +
            '<div style="font-weight:600;color:#212934;font-size:14px">Get the BKM app</div>' +
            '<div style="font-size:12px;color:#4a5768;margin-top:2px">Scan with your phone camera to install</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  });
}

function _hOrderSummary(status) {
  if (!status) {
    return '<a href="#/orders" class="home-ops-card home-ops-card-orders">' +
      '<div class="home-ops-title">Order Management</div>' +
      '<div class="home-ops-unavail">Mediator unavailable</div>' +
    '</a>';
  }

  var period    = status.period || '—';
  var periodFmt = period.length === 6 ? period.slice(0, 4) + '-' + period.slice(4) : period;
  var frequency = status.frequency || 'disabled';
  var dispatched = !!status.lastDispatched;

  // Count pending order lines (medicine × village combos with qty > 0)
  var buffer       = status.buffer || {};
  var pendingLines = 0;
  var pendingVillages = {};
  Object.values(buffer).forEach(function(entry) {
    Object.keys(entry.byOrgUnit || {}).forEach(function(ou) {
      if ((entry.byOrgUnit[ou] || 0) > 0) {
        pendingLines++;
        pendingVillages[ou] = true;
      }
    });
  });
  var villageCount = Object.keys(pendingVillages).length;

  var freqLabel    = frequency === 'disabled' ? 'Manual dispatch only'
                   : frequency.charAt(0).toUpperCase() + frequency.slice(1) + ' auto-dispatch active';

  var dispatchLine = dispatched
    ? '<div class="home-ops-status" style="color:#2e7d32">✓ Dispatched to OpenLMIS</div>'
    : '';

  var bufferColor = pendingLines > 0 ? '#e65100' : '#6b7a8d';
  var bufferLabel = pendingLines > 0
    ? pendingLines + ' order line' + (pendingLines !== 1 ? 's' : '') + ' in buffer'
      + ' (' + villageCount + ' village' + (villageCount !== 1 ? 's' : '') + ')'
    : 'Buffer empty — no pending orders';

  return '<a href="#/orders" class="home-ops-card home-ops-card-orders">' +
    '<div class="home-ops-title">Order Management</div>' +
    '<div class="home-ops-period">' + esc(periodFmt) + '</div>' +
    dispatchLine +
    '<div class="home-ops-status" style="color:' + bufferColor + '">' + esc(bufferLabel) + '</div>' +
    '<div class="home-ops-meta">' + esc(freqLabel) + '</div>' +
  '</a>';
}

function _hTaskSummary(bundle, performers) {
  var taskEntries = (bundle && bundle.entry) || [];
  var total = taskEntries.length;

  // Split tasks into Facility Worker vs VHW buckets, then count active vs completed
  var fw  = { active: 0, completed: 0 };
  var vhw = { active: 0, completed: 0 };

  taskEntries.forEach(function(e) {
    var t      = e.resource || {};
    var ref    = (t.owner && t.owner.reference) || '';
    var practId = ref.replace('Practitioner/', '');
    var perf   = performers[practId] || performers['Practitioner/' + practId] || {};
    var isFW   = perf.role === 'coordinator';
    var bucket = isFW ? fw : vhw;
    if (t.status === 'completed') bucket.completed++;
    else bucket.active++;
  });

  function _row(icon, label, active, completed, color) {
    if (active + completed === 0) return '';
    return '<div class="home-ops-task-row">' +
      '<span style="font-size:13px">' + icon + '</span>' +
      '<span class="home-ops-task-label">' + esc(label) + '</span>' +
      (active > 0
        ? '<span class="home-ops-task-pill" style="background:' + color + '15;color:' + color + '">' + active + ' active</span>'
        : '') +
      (completed > 0
        ? '<span class="home-ops-task-pill" style="background:#f0f0f0;color:#6b7a8d">' + completed + ' done</span>'
        : '') +
    '</div>';
  }

  var rowsHtml =
    _row('🏥', 'Facility Workers', fw.active,  fw.completed,  '#1565c0') +
    _row('👤', 'VHW / Field Workers', vhw.active, vhw.completed, '#6a1b9a');

  if (!rowsHtml) rowsHtml = '<div style="font-size:12px;color:var(--dhis2-text-muted)">No tasks yet</div>';

  return '<a href="#/tasks" class="home-ops-card home-ops-card-tasks">' +
    '<div class="home-ops-title">Tasks <span class="home-ops-total">' + total + '</span></div>' +
    '<div class="home-ops-task-rows">' + rowsHtml + '</div>' +
  '</a>';
}

function _hStat(value, label, href) {
  return '<a href="' + href + '" class="home-stat">' +
    '<span class="home-stat-value">' + value + '</span>' +
    '<span class="home-stat-label">' + esc(label) + '</span>' +
  '</a>';
}

function _hCard(type, title, extHref, extLabel, desc, links) {
  var ext = extHref
    ? ' <a href="' + extHref + '" target="_blank" rel="noopener" class="home-card-ext" title="' + esc(extLabel) + '">ⓘ</a>'
    : '';
  return '<div class="home-card home-card-' + type + '">' +
    '<div class="home-card-hdr">' +
      '<span class="home-card-title">' + esc(title) + '</span>' + ext +
    '</div>' +
    '<p class="home-card-desc">' + esc(desc) + '</p>' +
    '<div class="home-card-links">' +
      links.map(function(l) {
        return '<a href="' + l[1] + '" class="home-card-link">' + esc(l[0]) + '</a>';
      }).join('') +
    '</div>' +
  '</div>';
}
