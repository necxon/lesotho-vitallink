/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

var OU_LABELS = {
  'MhVktPWEah5': { village: 'Mafeteng Hospital', region: 'Mafeteng District', facility: 'Mafeteng Hospital', lmisFacility: '565674bc-791c-5baf-8ad8-44203a4291de', fhirLocation: 'loc-mafeteng-hospital' },
  'MxDywFDTRp9': { village: 'Samaria HC', region: 'Mafeteng District', facility: 'Samaria HC', lmisFacility: '88a0ba9b-285a-56d0-a5d9-b16f0371d37f', fhirLocation: 'loc-samaria' },
  'M08eNfUcluG': { village: 'Mt Tabor HC', region: 'Mafeteng District', facility: 'Mt Tabor HC', lmisFacility: '5f86b62d-8d9a-5da5-8515-b896835b6d81', fhirLocation: 'loc-mt-tabor' },
  'MXUJeJpd527': { village: 'Thabana-Morena HC', region: 'Mafeteng District', facility: 'Thabana-Morena HC', lmisFacility: '75d31b75-8678-53f4-9275-f47d64c33e3d', fhirLocation: 'loc-thabana-morena' },
  'Mpm3anAFHbG': { village: 'Mt Olivet HC', region: 'Mafeteng District', facility: 'Mt Olivet HC', lmisFacility: 'a5558f08-4ea7-502f-8d72-e3d3322c2f47', fhirLocation: 'loc-mt-olivet' },
  'MTmalx6GDQh': { village: 'Thaba-Tsoeu HC', region: 'Mafeteng District', facility: 'Thaba-Tsoeu HC', lmisFacility: '6bf59525-e671-5e5b-9053-1de926bf222f', fhirLocation: 'loc-thaba-tsoeu' },
  'MoRm4JeA36j': { village: 'Kolo HC', region: 'Mafeteng District', facility: 'Kolo HC', lmisFacility: '6ab5c0d1-bffb-5a82-a6d6-0b2ede8cf872', fhirLocation: 'loc-kolo' },
  'M6QoWeMH7eE': { village: 'Sekameng HC', region: 'Mafeteng District', facility: 'Sekameng HC', lmisFacility: '364d604f-8749-521d-b1dc-858e59f84b4a', fhirLocation: 'loc-sekameng' },
  'M2X6u3DJHnD': { village: 'Tsakholo HC', region: 'Mafeteng District', facility: 'Tsakholo HC', lmisFacility: '1e2443d7-cb1c-5c38-8011-ee70c9fb693d', fhirLocation: 'loc-tsakholo' },
  'MPIlF8CgTor': { village: 'Litsoeneng HC', region: 'Mafeteng District', facility: 'Litsoeneng HC', lmisFacility: '59dc144f-206c-5062-bb7e-01a6d8283dbc', fhirLocation: 'loc-litsoeneng' },
  'MTL8jPRRuz6': { village: 'Ribaneng HC', region: 'Mafeteng District', facility: 'Ribaneng HC', lmisFacility: 'b27e844d-9f46-54c3-b3ed-fafa7a9aa9b2', fhirLocation: 'loc-ribaneng' },
  'M5kgucFmUvb': { village: 'Masemouse HC', region: 'Mafeteng District', facility: 'Masemouse HC', lmisFacility: 'e61834df-cffb-5e03-8469-8f4d791a3ff4', fhirLocation: 'loc-masemouse' },
  'MprL0Q9KK5s': { village: 'St. Andrews HC', region: 'Mafeteng District', facility: 'St. Andrews HC', lmisFacility: '04a8e13d-f434-50d7-96d6-26edc264f327', fhirLocation: 'loc-st-andrews' },
  'MTYfpHurTt7': { village: 'Emmause HC', region: 'Mafeteng District', facility: 'Emmause HC', lmisFacility: 'f1acc7fa-a085-5743-be4a-8e467e6f6ec2', fhirLocation: 'loc-emmause' },
  'MXoJ83iRlEx': { village: 'Matelile HC', region: 'Mafeteng District', facility: 'Matelile HC', lmisFacility: 'ce613609-d766-58cf-a9ee-b59a6c2ac295', fhirLocation: 'loc-matelile' },
  'MSJuHbEkMai': { village: 'Malealea HC', region: 'Mafeteng District', facility: 'Malealea HC', lmisFacility: '5184d3d1-de9a-54e2-a52a-424eedf0c717', fhirLocation: 'loc-malealea' },
  'MdrVFmVscxi': { village: 'Motsekuoa HC', region: 'Mafeteng District', facility: 'Motsekuoa HC', lmisFacility: 'f0d9855b-0a6d-5716-909b-171af1687764', fhirLocation: 'loc-motsekuoa' },
  'MDt7yKbmU1b': { village: 'Lecoop HC', region: 'Mafeteng District', facility: 'Lecoop HC', lmisFacility: '75605da0-dc3f-5a6f-9569-ce1a4dfd74d2', fhirLocation: 'loc-lecoop' },
};

// Localhost fallbacks. Overridden per-environment by window.__BKM_CONFIG__ (config.js,
// loaded before this file), which is itself overridden by the Settings page (localStorage).
// So the SAME committed code runs in dev and prod — only config.js differs.
var CONFIG_DEFAULTS = Object.assign({
  keycloakUrl:  'http://localhost:8083',
  realm:        'opensrp',
  clientId:     'bkm-web',
  fhir:         'http://localhost:8079/fhir',
  lmis:         '/lmis-api',
  lmisFacility: '28de536f-b826-4eeb-a3c4-d65221a1120d',
  lmisProgram:  '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c',
  openhim:      'http://localhost:5001',
  dhis2:        'http://localhost:8081',
}, (window.__BKM_CONFIG__ || {}));

var CONFIG = (function() {
  try {
    var stored = JSON.parse(localStorage.getItem('bkm-connections') || '{}');
    return Object.assign({}, CONFIG_DEFAULTS, stored);
  } catch(e) {
    return Object.assign({}, CONFIG_DEFAULTS);
  }
})();

// ── Auth ─────────────────────────────────────────────────────────────────────

var kc = new Keycloak({
  url:      CONFIG.keycloakUrl,
  realm:    CONFIG.realm,
  clientId: CONFIG.clientId,
});

// ── Single-seat session lock ───────────────────────────────────────────────
// Only one user may use the portal at a time. We acquire a seat from the
// mediator on login, heartbeat to hold it, and release on logout/unload.
var BKM_SESSION_ID = (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2);
var _seatHeartbeat = null;

function _seatPost(action) {
  return mediatorFetch('session/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: BKM_SESSION_ID }),
  });
}

function acquireSeat() {
  return _seatPost('acquire').then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, data: d }; });
  });
}

// Force-disconnect the current seat holder using the secret unlock key.
// Used by the "secret link" (?unlock=KEY) and the hidden trigger on the locked screen.
function forceUnlock(key) {
  return mediatorFetch('session/force-release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key }),
  }).then(function(r) { return r.ok; }).catch(function() { return false; });
}

function startSeatHeartbeat() {
  if (_seatHeartbeat) clearInterval(_seatHeartbeat);
  _seatHeartbeat = setInterval(function() {
    _seatPost('heartbeat').then(function(r) {
      if (r.status === 409) {  // lost the seat (another user took over after we went stale)
        clearInterval(_seatHeartbeat);
        r.json().then(function(d) { showSeatLocked((d && d.activeUser) || 'another user'); });
      }
    }).catch(function() {});
  }, 30000);
  // Best-effort release when the tab closes
  window.addEventListener('pagehide', function() {
    try {
      mediatorFetch('session/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: BKM_SESSION_ID }),
        keepalive: true,
      });
    } catch (e) {}
  });
}

function showSeatLocked(activeUser) {
  document.getElementById('loading').hidden = true;
  var appEl = document.getElementById('app');
  appEl.hidden = false;
  appEl.innerHTML =
    '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f7fa">' +
      '<div style="text-align:center;padding:48px 32px;background:#fff;border-radius:12px;' +
           'box-shadow:0 4px 24px rgba(0,0,0,0.1);max-width:440px;width:90%">' +
        '<div onclick="promptForceUnlock()" title="" style="font-size:46px;line-height:1;margin-bottom:18px;cursor:default;user-select:none">🔒</div>' +
        '<h2 style="margin:0 0 12px;color:#212934;font-size:22px">Portal in use</h2>' +
        '<p style="color:#4a5768;margin-bottom:8px">The BKM portal is currently being used by ' +
          '<strong>' + esc(activeUser) + '</strong>. Only one user can be signed in at a time.</p>' +
        '<p style="color:#4a5768;margin-bottom:28px">Please try again shortly, or ask them to log out.</p>' +
        '<button onclick="location.reload()" style="padding:10px 24px;border:1px solid #6b7a8d;border-radius:6px;' +
               'background:#fff;cursor:pointer;font-size:14px;color:#212934;font-weight:500;margin-right:8px">Retry</button>' +
        '<button onclick="kc.logout({ redirectUri: location.href.split(\'#\')[0] })" ' +
          'style="padding:10px 24px;border:none;border-radius:6px;background:#1565c0;cursor:pointer;' +
                 'font-size:14px;color:#fff;font-weight:500">Logout</button>' +
      '</div>' +
    '</div>';
}

// Hidden escape hatch on the locked screen: click the lock icon, enter the secret
// key, and force-disconnect the current holder. Same effect as the ?unlock= link.
function promptForceUnlock() {
  var key = window.prompt('Enter the unlock key to disconnect the current user:');
  if (!key) return;
  forceUnlock(key).then(function(ok) {
    if (ok) location.reload();
    else window.alert('Unlock failed — wrong key, or the session service is unavailable.');
  });
}

function enterApp() {
  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
  var parsed = kc.tokenParsed || {};
  var _uname = parsed.preferred_username || '';
  var _unameEl = document.getElementById('username');
  if (_unameEl) {
    window.BKM_ROLE = _resolveRole(parsed);
    _unameEl.style.cssText = 'font-size:13px;line-height:1.4;display:block';
    _unameEl.innerHTML =
      '<span style="font-weight:700;color:#212934">' + esc(_uname) + '</span>' +
      (window.BKM_ROLE ? '<br><span style="font-size:11px;opacity:0.55;text-transform:uppercase;letter-spacing:0.4px">' + esc(window.BKM_ROLE) + '</span>' : '');
  }
  document.getElementById('logout-btn').onclick = function(e) {
    e.preventDefault();
    _seatPost('release').catch(function(){}).finally(function() {
      kc.logout({ redirectUri: location.href.split('#')[0] });
    });
  };
  if (!window.BKM_ROLE) window.BKM_ROLE = _resolveRole(parsed);
  applyNavAccess();
  startSeatHeartbeat();
  if (window.BKM_ROLE === 'vhw') return;
  // Facility-scoped roles are locked to their own health centre before any page renders.
  _applyFacilityScope(parsed).then(function() { route(); });
}

kc.init({ onLoad: 'login-required', pkceMethod: 'S256' })
  .then(function(auth) {
    if (!auth) return;
    // VHWs are blocked from the web portal anyway — don't consume the single seat for them.
    var role = _resolveRole(kc.tokenParsed || {});
    if (role === 'vhw') { window.BKM_ROLE = 'vhw'; enterApp(); return; }

    // Secret "force disconnect" link: ?unlock=<KEY>. If present, kick the current
    // holder, strip the param from the URL, then continue and grab the seat.
    var _unlockKey = new URLSearchParams(location.search).get('unlock');
    var _proceed = function() {
      acquireSeat().then(function(r) {
        if (r.ok && r.data && r.data.held) enterApp();
        else showSeatLocked((r.data && r.data.activeUser) || 'another user');
      }).catch(function() {
        // If the seat service is unreachable, fail open (don't block login)
        enterApp();
      });
    };
    if (_unlockKey) {
      forceUnlock(_unlockKey).then(function() {
        var u = new URL(location.href); u.searchParams.delete('unlock');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
        _proceed();
      });
      return;
    }
    _proceed();
  })
  .catch(function() {
    document.getElementById('loading').innerHTML =
      '<p>Authentication failed. Is Keycloak running?</p>';
  });

// ── Role resolution ──────────────────────────────────────────────────────────

function _resolveRole(parsed) {
  var roles = (parsed && parsed.realm_access && parsed.realm_access.roles) || [];
  // Roles: admin > coordinator > vhw. admin can do everything and is never
  // facility-locked. VHWs carry 'vhw' or the OpenSRP 'FIELD_WORKER' role (they
  // keep OPENMRS/MANAGE_* for the app, but the web portal is app-only). The
  // store_manager role was removed — legacy tokens fall through to coordinator.
  if (roles.indexOf('admin') !== -1) return 'admin';
  var isVhw = roles.indexOf('vhw') !== -1 || roles.indexOf('FIELD_WORKER') !== -1;
  if (isVhw && roles.indexOf('coordinator') === -1) return 'vhw';
  return 'coordinator';
}

// ── Facility scope ─────────────────────────────────────────────────────────────

// Admins (realm-management/realm-admin) see all facilities; every other role is
// locked to its own health centre.
function _isAdmin(parsed) {
  var realmRoles = (parsed && parsed.realm_access && parsed.realm_access.roles) || [];
  if (realmRoles.indexOf('admin') >= 0) return true;
  var ra = (parsed && parsed.resource_access) || {};
  var rm = ra['realm-management'] || {};
  return (rm.roles || []).indexOf('realm-admin') >= 0;
}

// Resolves the caller's facility from the mediator (whoami returns ONLY their own
// facility) and locks CONFIG.lmisFacility to it. Fail-open: on error keep the default.
function _applyFacilityScope(parsed) {
  window.BKM_FACILITY_LOCKED = false;
  if (_isAdmin(parsed)) return Promise.resolve();
  return mediatorFetch('aggregate/whoami')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.facilityId) {
        CONFIG.lmisFacility = d.facilityId;
        window.BKM_FACILITY = { id: d.facilityId, name: d.facilityName || d.facilityId };
        window.BKM_FACILITY_LOCKED = true;
        _showFacilityLabel(window.BKM_FACILITY.name);
      }
    })
    .catch(function() { /* fail open — keep default facility, unlocked */ });
}

// Show the locked facility under the username so the user can see their scope.
function _showFacilityLabel(name) {
  var el = document.getElementById('username');
  if (el && name && el.innerHTML.indexOf('bkm-facility-label') < 0) {
    el.innerHTML += '<br><span id="bkm-facility-label" style="font-size:11px;color:#1976d2">' + esc(name) + '</span>';
  }
}

// ── Nav access ───────────────────────────────────────────────────────────────

function applyNavAccess() {
  if (window.BKM_ROLE === 'vhw') {
    document.getElementById('app').innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f7fa">' +
        '<div style="text-align:center;padding:48px 32px;background:#fff;border-radius:12px;' +
             'box-shadow:0 4px 24px rgba(0,0,0,0.1);max-width:420px;width:90%">' +
          '<div style="font-size:48px;line-height:1;margin-bottom:20px;color:#6b7a8d">[VHW]</div>' +
          '<h2 style="margin:0 0 12px;color:#212934;font-size:22px">Web Portal Access Restricted</h2>' +
          '<p style="color:#4a5768;margin-bottom:8px">Field workers (VHW) access the BKM system via the Android app only.</p>' +
          '<p style="color:#4a5768;margin-bottom:28px">Contact your supervisor if you need portal access.</p>' +
          '<button onclick="kc.logout({ redirectUri: location.href.split(\'#\')[0] })" ' +
            'style="padding:10px 28px;border:1px solid #6b7a8d;border-radius:6px;background:#fff;' +
                   'cursor:pointer;font-size:14px;color:#212934;font-weight:500">' +
            'Logout' +
          '</button>' +
        '</div>' +
      '</div>';
    return;
  }

  if (window.BKM_ROLE === 'coordinator') {
    ['#/settings', '#/tests'].forEach(function(href) {
      var a = document.querySelector('#nav-links a[href="' + href + '"]');
      if (a) a.hidden = true;
    });
    var sysBlock = document.querySelector('.nav-block.system');
    if (sysBlock) sysBlock.hidden = true;
  }
}

// ── FHIR helpers ─────────────────────────────────────────────────────────────

function fhir(path) {
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/' + path, {
        headers: { Authorization: 'Bearer ' + kc.token },
      });
    })
    .then(function(res) {
      if (!res.ok) throw new Error('FHIR ' + res.status + ' on ' + path);
      return res.json();
    });
}

function fhirFull(url) {
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(url, { headers: { Authorization: 'Bearer ' + kc.token } });
    })
    .then(function(res) {
      if (!res.ok) throw new Error('FHIR ' + res.status);
      return res.json();
    });
}

function bundleLink(bundle, relation) {
  var links = bundle.link || [];
  for (var i = 0; i < links.length; i++) {
    if (links[i].relation === relation) return links[i].url;
  }
  return null;
}

// Resource types that ONLY bkm-admin may create/edit/delete. Coordinators get a
// read-only view of these (Patients, Locations, Groups, Care Teams, Questionnaire
// definitions, Practitioners/Roles/Orgs, app-nav Binary). Operational writes
// (Observation/stock, QuestionnaireResponse, Task, MedicationDispense) stay open.
var FHIR_ADMIN_ONLY_TYPES = {
  Patient: 1, Location: 1, Group: 1, CareTeam: 1, Questionnaire: 1,
  Practitioner: 1, PractitionerRole: 1, Organization: 1, Binary: 1,
};
function fhirEditBlocked(resourceType) {
  if (window.BKM_ROLE === 'admin') return false;
  if (!FHIR_ADMIN_ONLY_TYPES[resourceType]) return false;
  alert('Only an administrator (bkm-admin) can create, edit, or delete ' +
        resourceType + ' records. Your role has read-only access here.');
  return true;
}

function fhirPost(resourceType, body) {
  if (fhirEditBlocked(resourceType)) return Promise.reject(new Error('Edit not permitted for ' + resourceType));
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/' + resourceType, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + kc.token,
          'Content-Type': 'application/fhir+json',
        },
        body: JSON.stringify(body),
      });
    })
    .then(function(res) {
      if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
      return res.json();
    });
}

function fhirPut(resourceType, id, body) {
  if (fhirEditBlocked(resourceType)) return Promise.reject(new Error('Edit not permitted for ' + resourceType));
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/' + resourceType + '/' + id, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + kc.token,
          'Content-Type': 'application/fhir+json',
        },
        body: JSON.stringify(body),
      });
    })
    .then(function(res) {
      if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
      return res.json();
    });
}

function fhirDelete(resourceType, id) {
  if (fhirEditBlocked(resourceType)) return Promise.reject(new Error('Edit not permitted for ' + resourceType));
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/' + resourceType + '/' + id + '?_cascade=delete', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + kc.token },
      });
    })
    .then(function(res) {
      if (!res.ok) throw new Error('FHIR DELETE ' + res.status);
    });
}

function entries(bundle) {
  var list = (bundle && bundle.entry) || [];
  return list.map(function(e) { return e.resource; }).filter(Boolean);
}

function get(obj /*, ...keys */) {
  var keys = Array.prototype.slice.call(arguments, 1);
  var cur = obj;
  for (var i = 0; i < keys.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[keys[i]];
  }
  return cur;
}

// ── Mediator helpers ──────────────────────────────────────────────────────────

function mediatorFetch(path, opts) {
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      var o = opts || {};
      return fetch('/mediator-api/' + path, {
        method:  o.method,
        headers: Object.assign({ Authorization: 'Bearer ' + kc.token }, o.headers),
        body:    o.body,
      });
    });
}

// ── OpenLMIS helpers ──────────────────────────────────────────────────────────

var _lmisToken    = null;
var _lmisTokenExp = 0;

function lmisToken() {
  if (_lmisToken && Date.now() < _lmisTokenExp) return Promise.resolve(_lmisToken);
  return fetch('/lmis-token', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _lmisToken    = d.access_token;
      _lmisTokenExp = Date.now() + ((d.expires_in || 3600) * 1000) - 30000;
      return _lmisToken;
    });
}

function lmisGet(path) {
  return lmisToken().then(function(token) {
    // cache:'no-store' so the browser never serves a stale stock card / SOH —
    // OpenLMIS GETs are otherwise eligible for the HTTP cache, which made the
    // View Log show old balances after a dispense.
    return fetch(CONFIG.lmis + path, { cache: 'no-store', headers: { 'Authorization': 'Bearer ' + token } });
  }).then(function(r) {
    if (!r.ok) throw new Error('OpenLMIS ' + r.status + ' on ' + path);
    return r.json();
  });
}

// Posts a MedicationDispense through the OpenHIM channel (fans out to DHIS2 + OpenLMIS)
function openhimPost(body) {
  return kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.openhim + '/fhir/MedicationDispense', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/fhir+json',
          'Authorization': 'Bearer ' + kc.token,
        },
        body: JSON.stringify(body),
      });
    })
    .then(function(r) {
      if (!r.ok) throw new Error('OpenHIM ' + r.status);
      return r.json();
    });
}
