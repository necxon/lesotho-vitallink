/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

var SERVICES = [
  {
    id: 'opensrp', name: 'OpenSRP Web', color: '#0277bd',
    icon: '👤', helpUrl: 'https://opensrp.io/',
    desc: 'Community health worker portal — patients, care teams, practitioners, questionnaires',
    url: 'http://localhost:9901', ping: '/ping/opensrp-web/',
    creds: 'opensrp-admin / password',
  },
  {
    id: 'openhim', name: 'OpenHIM Console', color: '#1565c0',
    icon: '🔀', helpUrl: 'https://openhim.org/',
    desc: 'Integration middleware — inspect transactions, manage channels & clients',
    url: 'http://localhost:9285', ping: '/ping/openhim/',
    creds: 'root@openhim.org / openhim-password',
  },
  {
    id: 'keycloak', name: 'Keycloak', color: '#4527a0',
    icon: '🔑', helpUrl: 'https://www.keycloak.org/documentation',
    desc: 'Identity & access management — users, roles, clients, realms',
    url: 'http://localhost:8083/auth', ping: '/ping/keycloak/',
    creds: 'admin / (see KEYCLOAK_ADMIN_PASSWORD in .env)  |  realm: opensrp',
    exportKeycloak: true,
  },
  {
    id: 'fhir', name: 'HAPI FHIR', color: '#00695c',
    icon: '🏥', helpUrl: 'https://hapifhir.io/',
    desc: 'FHIR R4 server — Patient, Practitioner, CareTeam, Group, Binary resources',
    url: 'http://localhost:8079', ping: '/ping/fhir/',
    creds: 'No auth required',
    exportFhir: true,
  },
  {
    id: 'dhis2', name: 'DHIS2', color: '#2e7d32',
    icon: '📊', helpUrl: 'https://docs.dhis2.org/',
    desc: 'Health data platform — aggregate stock data, dashboards, analytics',
    url: 'http://localhost:8081', ping: '/ping/dhis2/',
    creds: 'admin / district',
  },
  {
    id: 'openlmis', name: 'OpenLMIS', color: '#e65100',
    icon: '💊', helpUrl: 'https://github.com/OpenLMIS',
    desc: 'Logistics management — stock cards, programs, facilities, ordering',
    url: 'http://localhost:8082', ping: '/ping/openlmis/',
    creds: 'admin / password',
    exportLmis: true,
  },
  {
    id: 'grafana', name: 'Grafana', color: '#e65100',
    icon: '📈', helpUrl: 'https://grafana.com/docs/',
    desc: 'Monitoring dashboards — container metrics, logs (Loki), Prometheus',
    url: 'http://localhost:3005', ping: '/ping/grafana/',
    creds: 'admin / (see GF_SECURITY_ADMIN_PASSWORD in .env)',
  },
  {
    id: 'prometheus', name: 'Prometheus', color: '#b71c1c',
    icon: '🔭', helpUrl: 'https://prometheus.io/docs/',
    desc: 'Metrics store — query raw time-series, check scrape targets & alerts',
    url: 'http://localhost:9090', ping: '/ping/prometheus/',
    creds: 'No auth required',
  },
  {
    id: 'mailhog', name: 'MailHog', color: '#6d4c41',
    icon: '📧', helpUrl: 'https://github.com/mailhog/MailHog',
    desc: 'SMTP sink — inspect notification emails sent by the mediator (VHW alerts, stock notifications)',
    url: 'http://localhost:8025', ping: '/ping/mailhog/',
    creds: 'No auth required',
  },
  {
    id: 'postgres', name: 'PostgreSQL', color: '#336791',
    icon: '🐘', helpUrl: 'https://www.postgresql.org/docs/',
    desc: 'Two instances — sandbox DB (OpenSRP, DHIS2) and OpenLMIS DB (stock, reference data, auth)',
    noOpen: true, noPing: true, exportPostgres: true,
    creds: [
      { label: 'Sandbox DB',  host: 'docker exec health-db-postgres psql', port: null, user: 'admin', pass: 'password123', databases: 'opensrp, dhis2, openhim (no host port — docker exec only)' },
      { label: 'OpenLMIS DB', host: 'localhost', port: 5432, user: 'postgres', pass: '(no password)', databases: 'open_lmis' },
    ],
  },
];

var MEDIATOR_API = [
  {
    group: 'FHIR Intake',
    note: 'Received via OpenHIM on port 5001 — these are the entry points from the Android app',
    endpoints: [
      { method: 'POST', path: '/fhir/QuestionnaireResponse', desc: 'Handle dispense, order, receipt, or adjustment QR from device' },
      { method: 'POST', path: '/fhir/MedicationDispense',    desc: 'Direct dispense fan-out to DHIS2 + OpenLMIS' },
      { method: 'POST', path: '/fhir/bundle-sync',           desc: 'Real-time bundle sync — called by OpenHIM mirror on every app transaction' },
      { method: 'POST', path: '/fhir/SupplyDelivery',        desc: 'Supply delivery processing' },
    ]
  },
  {
    group: 'Order Management',
    note: 'Direct access on port 3000 — manage the VHW order buffer and batch dispatch to OpenLMIS',
    endpoints: [
      { method: 'GET',    path: '/aggregate/status',              desc: 'Current period status: order buffer, dispatch schedule, next run, performers by org unit' },
      { method: 'GET',    path: '/aggregate/orders',              desc: 'Inspect pending order totals in the buffer for the current period', fetchable: 'buffer' },
      { method: 'POST',   path: '/aggregate/orders',              desc: 'Dispatch order batch to OpenLMIS now. Body: { force: true } to re-dispatch already-sent period' },
      { method: 'DELETE', path: '/aggregate/orders/dispatch-log', desc: 'Clear the dispatch log — allows re-dispatching the current period' },
      { method: 'PUT',    path: '/aggregate/schedule',            desc: 'Change batch dispatch frequency. Body: { frequency: "daily" | "weekly" | "monthly" }' },
      { method: 'POST',   path: '/aggregate',                     desc: 'Manually trigger facility-level stock aggregation. Body: { period: "YYYYMM" }' },
      { method: 'GET',    path: '/aggregate/dispatch-history',    desc: 'Full audit log of all dispatches to OpenLMIS. Query: ?period=YYYYMM&limit=N' },
    ]
  },
  {
    group: 'Tasks',
    note: 'Create and manage FHIR Tasks that are pushed to the Android app on next sync',
    endpoints: [
      { method: 'POST', path: '/aggregate/tasks',             desc: 'Create stock-issue Tasks for one or more VHWs. Body: { practitioners, entries: [{medication, quantity}] }' },
      { method: 'POST', path: '/aggregate/tasks/:id/complete', desc: 'Mark a stock-issue Task as completed (status → completed)' },
    ]
  },
  {
    group: 'Mappings & Performers',
    note: 'Medication code → OpenLMIS orderable UUID mappings, and practitioner → facility mappings',
    endpoints: [
      { method: 'GET',  path: '/aggregate/mappings',   desc: 'Read current medication + performer mappings (mappings.json + store overrides merged)' },
      { method: 'POST', path: '/aggregate/mappings',   desc: 'Update mappings at runtime without restart' },
      { method: 'GET',  path: '/aggregate/performers', desc: 'Per-practitioner details: village, region, facility, phone, email, role' },
    ]
  },
  {
    group: 'Utilities',
    note: 'Helper endpoints for debugging and integration',
    endpoints: [
      { method: 'GET',  path: '/config',      desc: 'Read mediator runtime configuration (OpenHIM heartbeat values)' },
      { method: 'POST', path: '/lmis-token',  desc: 'Fetch a live OpenLMIS OAuth token (useful for debugging API calls)' },
    ]
  },
];

var METHOD_COLOR = {
  GET:    { bg: '#e8f5e9', color: '#2e7d32', border: '#a5d6a7' },
  POST:   { bg: '#e3f2fd', color: '#1565c0', border: '#90caf9' },
  PUT:    { bg: '#fff3e0', color: '#e65100', border: '#ffcc80' },
  DELETE: { bg: '#fce4ec', color: '#c62828', border: '#f48fb1' },
};

function renderApiRef() {
  return '<div class="api-ref-section">' +
    '<div class="api-ref-header">' +
      '<span class="api-ref-icon">⚡</span>' +
      '<div>' +
        '<h3 style="margin:0 0 2px 0">Mediator API Reference</h3>' +
        '<span style="color:var(--dhis2-text-muted);font-size:12px">Via OpenHIM: <code>' + esc((typeof CONFIG !== 'undefined' && CONFIG.openhim) || 'http://localhost:5001') + '</code></span>' +
      '</div>' +
    '</div>' +
    MEDIATOR_API.map(function(group) {
      var COLLAPSED_BY_DEFAULT = ['FHIR Intake', 'Order Management', 'Tasks', 'Mappings & Performers', 'Utilities'];
      var collapsed = COLLAPSED_BY_DEFAULT.indexOf(group.group) !== -1;
      var groupId = 'api-group-' + group.group.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      return '<div class="api-group">' +
        '<div class="api-group-title api-group-toggle" data-target="' + groupId + '" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none">' +
          '<span>' + esc(group.group) + '</span>' +
          '<span class="api-group-chevron" style="font-size:11px;color:#888;transition:transform .2s;transform:' + (collapsed ? 'rotate(-90deg)' : 'rotate(0deg)') + '">&#9660;</span>' +
        '</div>' +
        '<div id="' + groupId + '"' + (collapsed ? ' hidden' : '') + '>' +
          '<div class="api-group-note">' + esc(group.note) + '</div>' +
          '<table class="api-table">' +
          '<thead><tr><th style="width:70px">Method</th><th style="width:280px">Path</th><th>Description</th></tr></thead>' +
          '<tbody>' +
          group.endpoints.map(function(ep) {
            var mc = METHOD_COLOR[ep.method] || METHOD_COLOR.GET;
            var descCell = esc(ep.desc);
            if (ep.fetchable) {
              descCell += ' <button class="btn btn-outline btn-sm api-fetch-btn" data-fetch="' + ep.fetchable + '" style="margin-left:8px;font-size:11px">&#9654; View</button>' +
                '<div class="api-fetch-result" id="api-result-' + ep.fetchable + '" style="display:none"></div>';
            }
            return '<tr>' +
              '<td><span class="api-method" style="background:' + mc.bg + ';color:' + mc.color + ';border-color:' + mc.border + '">' + ep.method + '</span></td>' +
              '<td><code class="api-path">' + esc(ep.path) + '</code></td>' +
              '<td class="api-desc">' + descCell + '</td>' +
              '</tr>';
          }).join('') +
          '</tbody></table>' +
        '</div>' +
      '</div>';
    }).join('') +
    '</div>';
}

function exportLmisData(btn) {
  btn.disabled = true;
  btn.textContent = '⟳ Exporting…';

  var token;

  function lmisGet(path) {
    return fetch('/lmis-api' + path, { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); });
  }

  function lmisGetAll(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return lmisGet(path + sep + 'page=0&size=500').then(function(body) {
      return body.content || body || [];
    });
  }

  fetch('/lmis-token', { method: 'POST' }).then(function(r) { return r.json(); })
    .then(function(t) {
      token = t.access_token;
      return Promise.all([
        lmisGetAll('/api/facilities'),
        lmisGetAll('/api/programs'),
        lmisGetAll('/api/orderables'),
        lmisGetAll('/api/users'),
        lmisGetAll('/api/roles'),
        lmisGetAll('/api/stockCardSummaries?facility=28de536f-b826-4eeb-a3c4-d65221a1120d&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c'),
        lmisGetAll('/api/stockCards?facility=28de536f-b826-4eeb-a3c4-d65221a1120d&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c'),
        lmisGetAll('/api/reasonCategories'),
      ]);
    })
    .then(function(results) {
      var data = {
        exportedAt: new Date().toISOString(),
        facilities:        results[0],
        programs:          results[1],
        orderables:        results[2],
        users:             results[3],
        roles:             results[4],
        stockCardSummaries: results[5],
        stockCards:        results[6],
        reasonCategories:  results[7],
      };
      var total = results.reduce(function(n, r) { return n + (Array.isArray(r) ? r.length : 0); }, 0);

      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'openlmis-export-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      btn.disabled = false;
      btn.textContent = 'Export data (' + total + ')';
    })
    .catch(function(err) {
      alert('OpenLMIS export failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Export data';
    });
}

function exportFhirData(btn) {
  var FHIR_BASE = (typeof CONFIG !== 'undefined' && CONFIG.fhir) || 'http://localhost:8079/fhir';
  var TYPES = [
    'Patient', 'Practitioner', 'PractitionerRole', 'Organization', 'Location',
    'Group', 'CareTeam', 'Condition', 'Observation', 'MedicationDispense',
    'Task', 'QuestionnaireResponse', 'Binary', 'Composition', 'StructureMap',
    'Questionnaire', 'PlanDefinition',
  ];

  btn.disabled = true;
  btn.textContent = '⟳ Exporting…';

  function fetchAllPages(url, acc) {
    return fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(bundle) {
        var entries = (bundle.entry || []).map(function(e) { return e.resource; });
        acc = acc.concat(entries);
        var next = (bundle.link || []).find(function(l) { return l.relation === 'next'; });
        return next ? fetchAllPages(next.url, acc) : acc;
      });
  }

  Promise.all(TYPES.map(function(type) {
    return fetchAllPages(FHIR_BASE + '/' + type + '?_count=500', [])
      .then(function(resources) { return { type: type, resources: resources }; })
      .catch(function() { return { type: type, resources: [] }; });
  })).then(function(results) {
    var all = {};
    results.forEach(function(r) { if (r.resources.length) all[r.type] = r.resources; });
    var total = results.reduce(function(n, r) { return n + r.resources.length; }, 0);

    var json = JSON.stringify(all, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fhir-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    btn.disabled = false;
    btn.textContent = 'Export data (' + total + ')';
  }).catch(function(err) {
    alert('Export failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Export data';
  });
}

function kcAdminToken() {
  return fetch('/keycloak-api/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&client_id=admin-cli&username=admin&password=admin',
  }).then(function(r) { return r.json(); }).then(function(t) { return t.access_token; });
}

function exportKeycloakRealm(btn) {
  btn.disabled = true;
  btn.textContent = '⟳ Exporting…';

  kcAdminToken().then(function(token) {
    var h = { 'Authorization': 'Bearer ' + token };
    return Promise.all([
      fetch('/keycloak-api/admin/realms/opensrp/partial-export?exportClients=true&exportGroupsAndRoles=true', {
        method: 'POST', headers: h,
      }).then(function(r) { return r.json(); }),
      fetch('/keycloak-api/admin/realms/opensrp/users?max=1000', { headers: h })
        .then(function(r) { return r.json(); }),
    ]);
  }).then(function(results) {
    var realm = results[0];
    realm.users = results[1];

    var blob = new Blob([JSON.stringify(realm, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keycloak-opensrp-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    btn.disabled = false;
    btn.textContent = 'Export realm';
  }).catch(function(err) {
    alert('Keycloak export failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Export realm';
  });
}

function importKeycloakRealm(file, input) {
  if (!confirm('Import will DELETE the opensrp realm and recreate it from the file. Users will need to reset passwords (seed.sh handles this). Continue?')) {
    input.value = '';
    return;
  }

  var reader = new FileReader();
  reader.onload = function(e) {
    var realm;
    try { realm = JSON.parse(e.target.result); } catch (err) {
      alert('Invalid JSON: ' + err.message);
      input.value = '';
      return;
    }
    realm.id = 'opensrp';
    realm.realm = 'opensrp';

    kcAdminToken().then(function(token) {
      var h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
      return fetch('/keycloak-api/admin/realms/opensrp', { method: 'DELETE', headers: h })
        .then(function() {
          return fetch('/keycloak-api/admin/realms', {
            method: 'POST', headers: h, body: JSON.stringify(realm),
          });
        });
    }).then(function(r) {
      if (r.ok || r.status === 201) {
        alert('Realm imported successfully. Run seed.sh to restore user passwords and FHIR links.');
      } else {
        return r.text().then(function(t) { alert('Import failed (' + r.status + '): ' + t.slice(0, 300)); });
      }
    }).catch(function(err) {
      alert('Import failed: ' + err.message);
    }).finally(function() {
      input.value = '';
    });
  };
  reader.readAsText(file);
}

function exportPostgresData(btn) {
  btn.disabled = true;
  btn.textContent = '⟳ Exporting…';

  fetch('/mediator-api/db-export')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function(sql) {
      var rowMatch = sql.match(/-- Rows: (\d+)/);
      var total = rowMatch ? rowMatch[1] : '?';

      var blob = new Blob([sql], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'postgres-export-' + new Date().toISOString().slice(0, 10) + '.sql';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      btn.disabled = false;
      btn.textContent = 'Export SQL (' + total + ' rows)';
    })
    .catch(function(err) {
      alert('PostgreSQL export failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Export SQL';
    });
}

function renderServices(el) {
  el.innerHTML =
    '<div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
    '<h2 style="margin:0">Administrator Portal</h2>' +
    '<span style="color:var(--dhis2-text-muted);font-size:12px">System Administrator use only. Click any card to open the service.</span>' +
    '<a href="#/tests" class="btn btn-primary btn-sm" style="margin-left:auto;text-decoration:none">&#9656; E2E Tests</a>' +
    '</div>' +
    '<details style="margin-bottom:16px">' +
    '<summary style="cursor:pointer;font-weight:600;padding:8px 0;user-select:none">Service Status (' + SERVICES.length + ' services) ▶</summary>' +
    '<div class="svc-grid" style="margin-top:12px">' +
    SERVICES.map(function(s) {
      // Per-env URL: prod (config.prod.js) provides a `services` map of id -> URL;
      // otherwise fall back to the localhost default baked into the SERVICES list.
      var url = (typeof CONFIG !== 'undefined' && CONFIG.services && CONFIG.services[s.id]) || s.url;
      return (
        '<div class="svc-card" id="svc-' + s.id + '">' +
          '<div class="svc-card-header" style="background:' + s.color + '">' +
            '<span class="svc-icon">' + s.icon + '</span>' +
            '<span class="svc-name">' + esc(s.name) + '</span>' +
            (s.helpUrl ? '<a href="' + esc(s.helpUrl) + '" target="_blank" rel="noopener" title="Documentation" style="color:rgba(255,255,255,0.7);font-size:14px;text-decoration:none;margin-right:6px" onmouseover="this.style.color=\'#fff\'" onmouseout="this.style.color=\'rgba(255,255,255,0.7)\'">ⓘ</a>' : '') +
            '<span class="svc-status-dot" id="dot-' + s.id + '" title="' + (s.noPing ? 'No HTTP endpoint' : 'Checking…') + '">&#9679;</span>' +
          '</div>' +
          '<div class="svc-card-body">' +
            '<p class="svc-desc">' + esc(s.desc) + '</p>' +
            (Array.isArray(s.creds)
              ? s.creds.map(function(db) {
                  return '<div style="margin-top:8px;padding:8px 10px;background:#f5f7fa;border-radius:6px;border-left:3px solid #336791">' +
                    '<div style="font-weight:600;font-size:12px;color:#336791;margin-bottom:4px">' + esc(db.label) + '</div>' +
                    '<table style="width:100%;font-size:11px;border-collapse:collapse">' +
                    '<tr><td style="color:#888;width:70px;padding:1px 0">Host</td><td><code>' + esc(db.host) + (db.port ? ':' + db.port : '') + '</code></td></tr>' +
                    '<tr><td style="color:#888;padding:1px 0">User</td><td><code>' + esc(db.user) + '</code></td></tr>' +
                    '<tr><td style="color:#888;padding:1px 0">Password</td><td><code>' + esc(db.pass) + '</code></td></tr>' +
                    '<tr><td style="color:#888;padding:1px 0">Databases</td><td style="color:#555">' + esc(db.databases) + '</td></tr>' +
                    '</table></div>';
                }).join('')
              : '<div class="svc-meta"><span class="svc-creds">' + esc(s.creds) + '</span></div>'
            ) +
          '</div>' +
          '<div class="svc-card-foot">' +
            (!s.noOpen ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Open &rarr;</a>' : '') +
            (s.exportFhir ? '<button class="btn btn-outline btn-sm export-fhir-btn" style="margin-left:6px">Export data</button>' : '') +
            (s.exportKeycloak ? '<button class="btn btn-outline btn-sm kc-export-btn" style="margin-left:6px">Export realm</button>' : '') +
            (s.exportKeycloak ? '<label class="btn btn-outline btn-sm" style="margin-left:6px;cursor:pointer">Import realm<input type="file" accept=".json" class="kc-import-input" style="display:none"></label>' : '') +
            (s.exportLmis ? '<button class="btn btn-outline btn-sm lmis-export-btn" style="margin-left:6px">Export data</button>' : '') +
            (s.exportPostgres ? '<button class="btn btn-outline btn-sm pg-export-btn" style="margin-left:6px">Export SQL</button>' : '') +
            (!s.noOpen ? '<code class="svc-url">' + esc(url) + '</code>' : '<code class="svc-url">localhost:5432</code>') +
          '</div>' +
        '</div>'
      );
    }).join('') +
    '</div>' +
    '</details>' +
    '<details>' +
    '<summary style="cursor:pointer;font-weight:600;padding:8px 0;user-select:none">Mediator API Reference ▶</summary>' +
    '<div style="margin-top:8px">' + renderApiRef() + '</div>' +
    '</details>';

  // Wire up accordion toggles for API groups
  document.querySelectorAll('.api-group-toggle').forEach(function(header) {
    header.addEventListener('click', function() {
      var targetId = header.getAttribute('data-target');
      var body     = document.getElementById(targetId);
      var chevron  = header.querySelector('.api-group-chevron');
      if (!body) return;
      var isHidden = body.hidden;
      body.hidden = !isHidden;
      if (chevron) chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
    });
  });

  // Wire up inline fetch buttons in the API reference table
  document.querySelectorAll('.api-fetch-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.getAttribute('data-fetch');
      var resultEl = document.getElementById('api-result-' + key);
      if (!resultEl) return;
      btn.disabled = true;
      btn.textContent = '⟳ Loading…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<span style="color:#888;font-size:11px">Fetching…</span>';

      if (key === 'buffer') {
        Promise.all([
          fetch('/mediator-api/aggregate/orders').then(function(r) { return r.json(); }),
          fetch('/mediator-api/aggregate/mappings').then(function(r) { return r.json(); }),
        ]).then(function(results) {
          var bufferData = results[0];
          var mappings   = results[1];

          // Build reverse map: orderable UUID → best human-readable name
          var medMap = mappings.medications || {};
          var reverseMap = {};
          Object.keys(medMap).forEach(function(name) {
            var uuid = medMap[name];
            var existing = reverseMap[uuid];
            if (!existing || (name.indexOf(' ') !== -1 && existing.indexOf(' ') === -1) || name.length > existing.length) {
              reverseMap[uuid] = name;
            }
          });

          var buffer = bufferData.buffer || {};
          var entries = Object.values(buffer).filter(function(e) { return e.totalQty > 0; });

          if (!entries.length) {
            resultEl.innerHTML = '<span style="color:#888;font-size:11px">✓ Buffer is empty — no pending orders this period.</span>';
          } else {
            var rows = entries.map(function(e) {
              var name = reverseMap[e.orderableId] || e.orderableId.slice(-8);
              var ous  = Object.entries(e.byOrgUnit || {}).map(function(kv) { return kv[0] + ': ' + kv[1]; }).join(', ');
              return '<tr><td style="font-weight:600">' + esc(name) + '</td><td style="text-align:right;font-weight:600;color:#1565c0">' + e.totalQty + '</td><td style="color:#888;font-size:11px">' + esc(ous) + '</td></tr>';
            }).join('');
            resultEl.innerHTML =
              '<table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:12px">' +
              '<thead><tr style="background:#eceff1"><th style="text-align:left;padding:4px 8px">Medicine</th><th style="text-align:right;padding:4px 8px">Qty (this period)</th><th style="text-align:left;padding:4px 8px">By org unit</th></tr></thead>' +
              '<tbody>' + rows + '</tbody></table>';
          }
          btn.disabled = false;
          btn.innerHTML = '&#9654; Refresh';
        }).catch(function(err) {
          resultEl.innerHTML = '<span style="color:#c62828;font-size:11px">Error: ' + esc(err.message) + '</span>';
          btn.disabled = false;
          btn.innerHTML = '&#9654; Retry';
        });
      }
    });
  });

  // Wire up FHIR export button
  var exportBtn = el.querySelector('.export-fhir-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', function() { exportFhirData(exportBtn); });
  }

  // Wire up Keycloak export/import buttons
  var kcExportBtn = el.querySelector('.kc-export-btn');
  if (kcExportBtn) {
    kcExportBtn.addEventListener('click', function() { exportKeycloakRealm(kcExportBtn); });
  }
  var kcImportInput = el.querySelector('.kc-import-input');
  if (kcImportInput) {
    kcImportInput.addEventListener('change', function() {
      if (!kcImportInput.files[0]) return;
      importKeycloakRealm(kcImportInput.files[0], kcImportInput);
    });
  }

  var lmisExportBtn = el.querySelector('.lmis-export-btn');
  if (lmisExportBtn) {
    lmisExportBtn.addEventListener('click', function() { exportLmisData(lmisExportBtn); });
  }

  var pgExportBtn = el.querySelector('.pg-export-btn');
  if (pgExportBtn) {
    pgExportBtn.addEventListener('click', function() { exportPostgresData(pgExportBtn); });
  }

  // Ping each service and update the status dot
  SERVICES.forEach(function(s) {
    var dot = document.getElementById('dot-' + s.id);
    if (!dot) return;
    if (s.noPing) {
      dot.style.color = '#90a4ae';
      dot.title = 'No HTTP endpoint — use psql / docker exec';
      return;
    }
    fetch(s.ping, { method: 'HEAD', cache: 'no-store' })
      .then(function(r) {
        dot.style.color = (r.status < 500) ? '#43a047' : '#e53935';
        dot.title = 'HTTP ' + r.status;
      })
      .catch(function() {
        dot.style.color = '#e53935';
        dot.title = 'Unreachable';
      });
  });

}
