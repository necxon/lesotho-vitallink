/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

var SETTINGS_SCHEMA = [
  {
    group: 'Notification Channels',
    hint: 'Enable or disable outbound notification delivery channels',
    fields: [
      { key: 'NOTIFY_SMS_ENABLED',   label: 'SMS Notifications',   type: 'bool' },
      { key: 'NOTIFY_PUSH_ENABLED',  label: 'Push Notifications',  type: 'bool' },
      { key: 'NOTIFY_EMAIL_ENABLED', label: 'Email Notifications', type: 'bool' },
    ]
  },
  {
    group: 'Notification Events',
    hint: 'Which stock events trigger outbound notifications to VHWs',
    fields: [
      { key: 'NOTIFY_ON_DISPENSE',  label: 'Notify on dispense',   type: 'bool' },
      { key: 'NOTIFY_ON_RECEIPT',   label: 'Notify on receipt',    type: 'bool' },
      { key: 'NOTIFY_ON_LOW_STOCK', label: 'Notify on low stock',  type: 'bool' },
    ]
  },
  {
    group: 'OpenLMIS Bell Notifications',
    hint: 'Which events create in-app notifications in the OpenLMIS bell icon',
    fields: [
      { key: 'NOTIFY_LMIS_ON_DISPENSE',       label: 'Dispense events',   type: 'bool' },
      { key: 'NOTIFY_LMIS_ON_RECEIPT',        label: 'Receipt events',    type: 'bool' },
      { key: 'NOTIFY_LMIS_ON_LOW_STOCK',      label: 'Low stock alerts',  type: 'bool' },
      { key: 'NOTIFY_LMIS_ON_ORDER_DISPATCH', label: 'Order dispatches',  type: 'bool' },
    ]
  },
  {
    group: 'Thresholds & Throttles',
    fields: [
      { key: 'NOTIFY_LOW_STOCK_THRESHOLD', label: 'Low stock threshold (units)', type: 'number', min: 0 },
      { key: 'NOTIFY_SMS_THROTTLE_MS',     label: 'SMS throttle (ms)',           type: 'number', min: 0 },
      { key: 'NOTIFY_PUSH_THROTTLE_MS',    label: 'Push throttle (ms)',          type: 'number', min: 0 },
      { key: 'NOTIFY_EMAIL_THROTTLE_MS',   label: 'Email throttle (ms)',         type: 'number', min: 0 },
    ]
  },
  {
    group: 'Business Rules',
    hint: 'Controls validation logic and fan-out routing for incoming events',
    fields: [
      { key: 'REJECT_DISPENSE_EXCEEDS_STOCK', label: 'Reject dispense if quantity exceeds stock on hand', type: 'bool',
        hint: 'When enabled, dispenses are rejected with HTTP 422 if the requested quantity exceeds the current stock on hand in OpenLMIS. Disable to allow dispensing without stock validation.' },
      { key: 'REJECT_UNKNOWN_PERFORMER', label: 'Reject unknown performer (BR-07)', type: 'bool',
        hint: 'When enabled, dispense events from a performer not in the mappings table are rejected with HTTP 422 instead of silently falling back to the default facility.' },
      { key: 'REJECT_UNKNOWN_MEDICINE', label: 'Reject unknown medicine code (BR-07)', type: 'bool',
        hint: 'When enabled, events with a medicine code not found in explicit aliases or the live OpenLMIS orderable list are rejected with HTTP 422 instead of using the default orderable.' },
      { key: 'REJECT_DUPLICATE_DISPENSE', label: 'Reject duplicate dispense events', type: 'bool',
        hint: 'When enabled, a MedicationDispense with the same resource id submitted more than once within the idempotency window is rejected with HTTP 409.' },
      { key: 'IDEMPOTENCY_WINDOW_MS', label: 'Idempotency window (ms)', type: 'number', min: 0,
        hint: 'How long a processed resource id is remembered. Default 300000 (5 min). Set to 0 to disable time-based expiry.' },
      { key: 'FANOUT_OPENSRP_ENABLED',  label: 'Fan-out to OpenSRP',   type: 'bool',
        hint: 'When disabled, OpenSRP receives no events. The response will show "disabled" for the opensrp result.' },
      { key: 'FANOUT_DHIS2_ENABLED',    label: 'Fan-out to DHIS2',     type: 'bool',
        hint: 'When disabled, no data values or SOH are pushed to DHIS2.' },
      { key: 'FANOUT_OPENLMIS_ENABLED', label: 'Fan-out to OpenLMIS',  type: 'bool',
        hint: 'When disabled, no stock events are recorded in OpenLMIS. Notifications and SOH updates are also suppressed.' },
      { key: 'REQUIRE_DELIVERY_BEFORE_ALLOCATION', label: 'Require accepted delivery before allocation', type: 'bool',
        hint: 'When enabled, a facility worker cannot allocate stock to VHWs until the facility has accepted a real delivery (a non-seed CREDIT receipt in OpenLMIS) — seeded opening stock does not count. Allocation is rejected with HTTP 422 until then. Disable to allow allocating against any stock on hand (useful for quick testing on seeded stock).' },
    ]
  },
  {
    group: 'Integration',
    fields: [
      { key: 'FHIR_LEDGER_ENABLED', label: 'FHIR Stock Ledger sync', type: 'bool',
        hint: 'When enabled, the mediator writes live Stock on Hand values from OpenLMIS into HAPI FHIR Observations after every dispense or receipt. These Observations power the Stock by Facility view. Disable to reduce HAPI FHIR write load in high-volume environments.' },
      { key: 'VHW_TASK_POLL_ENABLED',  label: 'OpenLMIS → Facility Worker Task fan-out', type: 'bool',
        hint: 'When enabled, the mediator polls OpenLMIS stock levels every interval and creates a FHIR Task (requested) for facility workers when an out-of-band SOH increase is detected — i.e. a receipt recorded directly in OpenLMIS that was not posted by this mediator. NOTE: OpenLMIS 3.x has no webhook/push support — this is polling only. Tasks appear within 0–60 seconds of the OpenLMIS receipt, not instantly. A 5-minute grace window suppresses duplicates after the mediator posts its own CREDIT.' },
      { key: 'DOWNSTREAM_TIMEOUT_MS', label: 'Downstream timeout (ms)',  type: 'number', min: 1000 },
      { key: 'POLL_INTERVAL_MS',      label: 'Event poll interval (ms)',   type: 'number', min: 5000,
        hint: 'How often the mediator polls HAPI FHIR (dispenses/QRs) and OpenLMIS (stock) for new events. Default 60000 (60s). Takes effect from the next poll cycle — no restart needed.' },
      { key: 'POLL_BATCH_SIZE',       label: 'Events collected per poll',  type: 'number', min: 1, max: 1000,
        hint: 'Maximum number of new events fetched from FHIR / OpenLMIS in a single poll cycle (the _count page size). Default 50. Lower it (e.g. 20) to spread load; raise it to drain large backlogs faster. ' +
              'IMPORTANT: keep this at or above the most events you expect within one poll interval. If MORE than this many events arrive between two polls, the extra ones beyond the batch can be skipped (the poller advances its checkpoint past them). With the default 50 every 60s this is rarely a concern — only lower it if your event volume is well under the new value per interval.' },
    ]
  },
];

var CONNECTIONS_SCHEMA = [
  { key: 'fhir',
    label: 'HAPI FHIR URL',
    placeholder: 'http://localhost:8079/fhir',
    hint: 'Where the web app reads/writes FHIR resources (Patients, Practitioners, Groups, Observations, etc.). ' +
          'Sandbox default: <code>http://localhost:8079/fhir</code>. ' +
          'Production: change to your HAPI FHIR server base URL.' },
  { key: 'keycloakUrl',
    label: 'Keycloak URL',
    placeholder: 'http://localhost:8083',
    hint: 'Keycloak server used for login. The Keycloak JS adapter is loaded from this URL. ' +
          'Sandbox default: <code>http://localhost:8083</code>. ' +
          'Production: change to your Keycloak server (e.g. <code>https://auth.yourdomain.org</code>).' },
  { key: 'realm',
    label: 'Keycloak Realm',
    placeholder: 'opensrp',
    hint: 'Keycloak realm name. Sandbox default: <code>opensrp</code>. Change if your production realm has a different name.' },
  { key: 'openhim',
    label: 'OpenHIM Channel URL',
    placeholder: 'http://localhost:5001',
    hint: 'OpenHIM client channel where <code>MedicationDispense</code> events are posted. The mediator picks these up and fans out to OpenLMIS + DHIS2. ' +
          'Sandbox default: <code>http://localhost:5001</code> (HTTP channel). ' +
          'Production: change to your OpenHIM channel URL.' },
  { key: 'lmis',
    label: 'OpenLMIS Base URL',
    placeholder: '/lmis-api',
    hint: 'Base URL for all OpenLMIS REST API calls. ' +
          'Sandbox default: <code>/lmis-api</code> (reverse-proxied through this server\'s nginx). ' +
          'Production: change to your OpenLMIS server URL (e.g. <code>https://openlmis.yourdomain.org</code>).' },
  { key: 'lmisFacility',
    label: 'OpenLMIS Facility ID',
    placeholder: '28de536f-b826-4eeb-a3c4-d65221a1120d',
    hint: 'UUID of the OpenLMIS facility to scope stock queries to. ' +
          'Sandbox default: <code>28de536f-b826-4eeb-a3c4-d65221a1120d</code> (Maseru District Clinic A — seeded by seed.sh). ' +
          'Production: <strong>this UUID will be different</strong>. Find it via ' +
          '<code>GET /api/facilities?name=YourFacilityName</code> on your OpenLMIS and copy the <code>id</code> field.' },
  { key: 'lmisProgram',
    label: 'OpenLMIS Program ID',
    placeholder: '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c',
    hint: 'UUID of the OpenLMIS supply programme to scope stock queries to. ' +
          'Sandbox default: <code>31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c</code> (Essential Medicines — seeded by seed.sh). ' +
          'Production: <strong>this UUID will be different</strong>. Find it via ' +
          '<code>GET /api/programs</code> on your OpenLMIS and copy the <code>id</code> of the relevant programme.' },
  { key: 'dhis2',
    label: 'DHIS2 URL',
    placeholder: 'http://localhost:8081',
    hint: 'DHIS2 server URL. Stock on Hand values are pushed here after each successful dispense. ' +
          'Sandbox default: <code>http://localhost:8081</code>. ' +
          'Production: change to your DHIS2 server URL (e.g. <code>https://dhis2.yourdomain.org</code>).' },
];

function accordionSection(id, title, hint, bodyHtml, expanded) {
  return (
    '<article style="margin-bottom:8px">' +
      '<div class="accordion-header" data-acc="' + id + '">' +
        '<div>' +
          '<span style="font-size:15px;font-weight:600">' + title + '</span>' +
          (hint ? '<div style="font-size:11px;color:var(--dhis2-text-muted);margin-top:2px">' + hint + '</div>' : '') +
        '</div>' +
        '<span class="accordion-chevron" id="chev-' + id + '">' + (expanded ? '▼' : '▶') + '</span>' +
      '</div>' +
      '<div class="accordion-body ' + (expanded ? 'expanded' : 'collapsed') + '" id="body-' + id + '" style="max-height:' + (expanded ? '2000px' : '0') + '">' +
        '<div style="padding-top:14px">' + bodyHtml + '</div>' +
      '</div>' +
    '</article>'
  );
}

function wireAccordions() {
  document.querySelectorAll('[data-acc]').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var id   = hdr.getAttribute('data-acc');
      var body = document.getElementById('body-' + id);
      var chev = document.getElementById('chev-' + id);
      var open = body.classList.contains('expanded');
      body.classList.toggle('expanded',  !open);
      body.classList.toggle('collapsed',  open);
      body.style.maxHeight = open ? '0' : '2000px';
      chev.textContent = open ? '▶' : '▼';
    });
  });
}

function renderConnectionsSection() {
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem('bkm-connections') || '{}'); } catch(e) {}

  var hint = 'Stored in browser localStorage — point to external services in production. Saving reloads the page.';
  var body = '';

  CONNECTIONS_SCHEMA.forEach(function(f) {
    var val = stored[f.key] !== undefined ? stored[f.key] : CONFIG_DEFAULTS[f.key];
    body += '<div class="form-row" style="max-width:560px;margin-bottom:14px">';
    body += '<label for="conn-' + f.key + '">' + esc(f.label) + '</label>';
    body += '<input type="text" id="conn-' + f.key + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder) + '">';
    if (f.hint) body += '<div class="hint" style="margin-top:4px;font-size:11px;color:#757575;line-height:1.5">' + f.hint + '</div>';
    body += '</div>';
  });

  body += '<div style="display:flex;align-items:center;gap:14px;margin-top:12px">';
  body += '<button class="btn btn-primary" id="btn-save-connections">Save Connections</button>';
  body += '<button class="btn btn-outline" id="btn-reset-connections">Reset to Defaults</button>';
  body += '<span id="conn-status" style="font-size:13px"></span>';
  body += '</div>';

  return accordionSection('connections', 'Service Connections', hint, body, false);
}

function wireConnectionsSection() {
  document.getElementById('btn-save-connections').onclick = function() {
    var values = {};
    CONNECTIONS_SCHEMA.forEach(function(f) {
      var v = document.getElementById('conn-' + f.key).value.trim();
      if (v && v !== CONFIG_DEFAULTS[f.key]) values[f.key] = v;
    });
    localStorage.setItem('bkm-connections', JSON.stringify(values));
    var s = document.getElementById('conn-status');
    s.style.color = '#2e7d32'; s.textContent = '✓ Saved — reloading…';
    setTimeout(function() { location.reload(); }, 800);
  };
  document.getElementById('btn-reset-connections').onclick = function() {
    localStorage.removeItem('bkm-connections');
    CONNECTIONS_SCHEMA.forEach(function(f) {
      document.getElementById('conn-' + f.key).value = CONFIG_DEFAULTS[f.key];
    });
    var s = document.getElementById('conn-status');
    s.style.color = '#2e7d32'; s.textContent = '✓ Reset to defaults';
    setTimeout(function() { s.textContent = ''; }, 2000);
  };
}

function renderSettings(el) {
  el.innerHTML = '<p aria-busy="true">Loading settings…</p>';
  mediatorFetch('config')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(cfg) {
      var html = '<div class="page-header"><h2>Settings</h2></div>' + renderConnectionsSection();

      SETTINGS_SCHEMA.forEach(function(section, idx) {
        var body = '';
        section.fields.forEach(function(f) {
          if (f.type === 'bool') {
            var checked = cfg[f.key] === 'true' ? ' checked' : '';
            body += '<label style="display:flex;align-items:center;gap:10px;margin-bottom:10px;cursor:pointer;user-select:none">';
            body += '<input type="checkbox" role="switch" id="setting-' + f.key + '"' + checked + '>';
            body += '<span style="font-size:13px">' + esc(f.label) + '</span>';
            if (f.hint) body += '<span style="font-size:11px;color:var(--dhis2-text-muted);margin-left:4px">' + esc(f.hint) + '</span>';
            body += '</label>';
          } else {
            body += '<div class="form-row" style="max-width:320px">';
            body += '<label for="setting-' + f.key + '">' + esc(f.label) + '</label>';
            body += '<input type="number" id="setting-' + f.key + '" value="' + esc(cfg[f.key] || '') + '"';
            if (f.min !== undefined) body += ' min="' + f.min + '"';
            body += '>';
            if (f.hint) body += '<div class="hint">' + esc(f.hint) + '</div>';
            body += '</div>';
          }
        });
        html += accordionSection('sec-' + idx, section.group, section.hint || null, body, false);
      });

      html +=
        '<div style="display:flex;align-items:center;gap:14px;margin-top:12px">' +
          '<button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>' +
          '<span id="settings-status" style="font-size:13px"></span>' +
        '</div>';

      el.innerHTML = html;
      wireConnectionsSection();
      wireAccordions();
    })
    .catch(function(e) {
      errMsg(el, 'Could not load settings: ' + e.message);
    });
}

function saveSettings() {
  var allFields = [];
  SETTINGS_SCHEMA.forEach(function(s) { allFields = allFields.concat(s.fields); });

  var updates = {};
  allFields.forEach(function(f) {
    var input = document.getElementById('setting-' + f.key);
    if (!input) return;
    updates[f.key] = f.type === 'bool' ? (input.checked ? 'true' : 'false') : input.value;
  });

  var btn      = document.querySelector('[onclick="saveSettings()"]');
  var statusEl = document.getElementById('settings-status');
  if (btn)      { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (statusEl) { statusEl.textContent = ''; }

  mediatorFetch('config', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(updates),
  })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function() {
      if (btn)      { btn.disabled = false; btn.textContent = 'Save Settings'; }
      if (statusEl) { statusEl.style.color = '#2e7d32'; statusEl.textContent = '✓ Saved'; }
      setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
    })
    .catch(function(e) {
      if (btn)      { btn.disabled = false; btn.textContent = 'Save Settings'; }
      if (statusEl) { statusEl.style.color = '#c62828'; statusEl.textContent = '✗ ' + e.message; }
    });
}
