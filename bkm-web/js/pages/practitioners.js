/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/practitioners.js (practitionersHelpHTML, global).

// ── Practitioner forms ────────────────────────────────────────────────────────

var _ROLE_OPTIONS = [
  { value: '',                label: '— none —' },
  { value: 'vhw',          label: 'VHW (Village Health Worker)' },
  { value: 'coordinator',  label: 'Coordinator' },
];

var _FHIR_ROLE = {
  vhw:           { code: 'FIELD_WORKER',    display: 'VHW' },
  coordinator:   { code: 'FACILITY_WORKER', display: 'Coordinator' },
};

var _FHIR_CODE_TO_MEDIATOR = {
  FIELD_WORKER:    'vhw',
  FACILITY_WORKER: 'coordinator',
  SUPERVISOR:      'coordinator', // legacy store_manager/supervisor code → coordinator
};

function _ouOptions(selectedOU) {
  var opts = '<option value="">— none —</option>';
  Object.keys(OU_LABELS).forEach(function(uid) {
    var lbl = OU_LABELS[uid];
    opts += '<option value="' + esc(uid) + '"' + (uid === selectedOU ? ' selected' : '') + '>' +
      esc(lbl.village) + '</option>';
  });
  return opts;
}

function practitionerFormHtml(p, existingRole) {
  var n      = (p && p.name && p.name[0]) || {};
  var given  = Array.isArray(n.given) ? n.given.join(' ') : (n.given || '');
  var family = n.family || '';
  var phone  = '', email = '';
  if (p && p.telecom) {
    for (var i = 0; i < p.telecom.length; i++) {
      if (p.telecom[i].system === 'phone')  phone = p.telecom[i].value;
      if (p.telecom[i].system === 'email')  email = p.telecom[i].value;
    }
  }

  // Derive current role + location from existing PractitionerRole
  var currentRole = '';
  var currentOU   = '';
  if (existingRole) {
    var rc = existingRole.code && existingRole.code[0];
    var coding = rc && rc.coding && rc.coding[0];
    var fhirCode = (coding && coding.code) || '';
    currentRole = _FHIR_CODE_TO_MEDIATOR[fhirCode] || fhirCode.toLowerCase() || '';
    var locRef = existingRole.location && existingRole.location[0] && existingRole.location[0].reference;
    var locFhirId = locRef ? locRef.replace('Location/', '') : '';
    Object.keys(OU_LABELS).forEach(function(uid) {
      if (OU_LABELS[uid].fhirLocation === locFhirId) currentOU = uid;
    });
  }

  var roleOpts = _ROLE_OPTIONS.map(function(o) {
    return '<option value="' + esc(o.value) + '"' + (o.value === currentRole ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }).join('');

  return (
    '<div class="form-row"><label>Given name(s)</label>' +
      '<input id="f-given" value="' + esc(given) + '"></div>' +
    '<div class="form-row"><label>Family name</label>' +
      '<input id="f-family" value="' + esc(family) + '"></div>' +
    '<div class="form-row"><label>Phone</label>' +
      '<input id="f-phone" value="' + esc(phone) + '"></div>' +
    '<div class="form-row"><label>Email</label>' +
      '<input id="f-email" type="email" value="' + esc(email) + '"></div>' +
    '<div class="form-row"><label>Role</label>' +
      '<select id="f-role">' + roleOpts + '</select></div>' +
    '<div class="form-row"><label>Village / Location</label>' +
      '<select id="f-ou">' + _ouOptions(currentOU) + '</select></div>' +
    '<div class="form-row"><label>Active</label>' +
      '<select id="f-active">' +
        '<option value="true"' + ((!p || p.active !== false) ? ' selected' : '') + '>Yes</option>' +
        '<option value="false"' + (p && p.active === false ? ' selected' : '') + '>No</option>' +
      '</select></div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function practitionerFromForm(existing) {
  var given  = document.getElementById('f-given').value.trim();
  var family = document.getElementById('f-family').value.trim();
  var phone  = document.getElementById('f-phone').value.trim();
  var email  = document.getElementById('f-email').value.trim();
  var active = document.getElementById('f-active').value === 'true';
  var r = Object.assign({}, existing || {}, { resourceType: 'Practitioner' });
  r.name   = [{ given: given ? [given] : undefined, family: family || undefined }];
  r.active = active;
  var telecom = [];
  if (phone) telecom.push({ system: 'phone', value: phone });
  if (email) telecom.push({ system: 'email', value: email });
  r.telecom = telecom;
  return r;
}

function _savePractitionerRole(practId, existingRole) {
  var roleVal = document.getElementById('f-role').value;
  var ouVal   = document.getElementById('f-ou').value;
  if (!roleVal) return Promise.resolve();

  var fhirRoleDef = _FHIR_ROLE[roleVal] || { code: roleVal.toUpperCase(), display: roleVal };
  var ouEntry     = ouVal && OU_LABELS[ouVal];
  var locFhirId   = ouEntry && ouEntry.fhirLocation;

  var resource = {
    resourceType: 'PractitionerRole',
    active: true,
    practitioner: { reference: 'Practitioner/' + practId },
    code: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/practitioner-role', code: fhirRoleDef.code, display: fhirRoleDef.display }] }],
  };
  if (locFhirId) {
    resource.location  = [{ reference: 'Location/' + locFhirId }];
    resource.organization = { reference: 'Organization/maseru-clinic-a' };
  }

  var phone = document.getElementById('f-phone').value.trim();
  var email = document.getElementById('f-email').value.trim();

  var fhirOp;
  if (existingRole && existingRole.id) {
    resource.id = existingRole.id;
    fhirOp = fhirPut('PractitionerRole', existingRole.id, resource);
  } else {
    fhirOp = fhirPost('PractitionerRole', resource);
  }

  return fhirOp.then(function() {
    var mediatorData = {
      id:           'Practitioner/' + practId,
      role:         roleVal,
      dhis2OrgUnit: ouVal || null,
      phone:        phone || null,
      email:        email || null,
    };
    return mediatorFetch('aggregate/mappings/performers', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(mediatorData),
    });
  });
}

function openPractitionerForm(p, existingRole, onSave) {
  var isNew = !p;
  showModal(isNew ? 'New Practitioner' : 'Edit Practitioner', practitionerFormHtml(p, existingRole));
  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = practitionerFromForm(p);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('Practitioner', resource) : fhirPut('Practitioner', p.id, resource);
    op.then(function(saved) {
      return _savePractitionerRole(saved.id, existingRole).then(function() {
        closeModal(); onSave(saved);
      });
    }).catch(function(err) { btn.disabled = false; btn.textContent = 'Save'; alert('Error: ' + err.message); });
  };
}

// ── Practitioners ─────────────────────────────────────────────────────────────

var _pracSearchTimer = null;
var _pracPageSize    = 20;
var _pracRoleMap     = {};  // cached — roles are few, practitioners may be many

function _pracRenderTable(el, bundle, roleMap, search, pageSize) {
  var pracs   = entries(bundle);
  var total   = bundle.total !== undefined ? bundle.total : '?';
  var nextUrl = bundleLink(bundle, 'next');
  var prevUrl = bundleLink(bundle, 'previous');

  var tableHtml = table(
    ['Name', 'ID', 'Role', 'Organization', 'Location', ''],
    pracs.map(function(p) {
      var role    = roleMap[p.id];
      var code    = role && role.code && role.code[0];
      var coding  = code && code.coding && code.coding[0];
      var roleText = (coding && (coding.display || coding.code)) || (code && code.text) || '—';
      var org     = role && role.organization;
      var orgText = (org && org.display) || (org && org.reference && org.reference.split('/')[1]) || '—';
      var loc     = role && role.location && role.location[0];
      var locText = (loc && loc.display) || (loc && loc.reference && loc.reference.split('/')[1]) || '—';
      return '<tr>' +
        '<td>' + esc(ptName(p)) + '</td>' +
        '<td><code>' + esc(p.id) + '</code></td>' +
        '<td>' + esc(roleText) + '</td>' +
        '<td>' + esc(orgText) + '</td>' +
        '<td>' + esc(locText) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-outline prac-edit" data-id="' + esc(p.id) + '">Edit</button> ' +
          '<button class="btn btn-sm btn-danger prac-del" data-id="' + esc(p.id) + '" data-name="' + esc(ptName(p)) + '">Del</button>' +
        '</td>' +
        '</tr>';
    }),
    'No practitioners found.'
  );

  var pager =
    '<div class="pager">' +
      '<span class="pager-info">Showing ' + pracs.length + ' of ' + total + '</span>' +
      '<div class="pager-btns">' +
        '<button class="btn btn-sm btn-outline" id="prac-prev"' + (prevUrl ? '' : ' disabled') + '>← Prev</button>' +
        '<button class="btn btn-sm btn-outline" id="prac-next"' + (nextUrl ? '' : ' disabled') + '>Next →</button>' +
      '</div>' +
    '</div>';

  document.getElementById('prac-data').innerHTML = tableHtml + pager;

  el.querySelectorAll('.prac-edit').forEach(function(btn) {
    btn.onclick = function() {
      var pid = btn.getAttribute('data-id');
      fhir('Practitioner/' + pid).then(function(p) {
        openPractitionerForm(p, _pracRoleMap[pid] || null, function() { _pracLoadPage(el, _pracQuery(search, pageSize), search, pageSize); });
      });
    };
  });
  el.querySelectorAll('.prac-del').forEach(function(btn) {
    btn.onclick = function() {
      showConfirm('Delete Practitioner', 'Delete ' + btn.getAttribute('data-name') + '?', function() {
        fhirDelete('Practitioner', btn.getAttribute('data-id')).then(function() {
          closeModal(); _pracLoadPage(el, _pracQuery(search, pageSize), search, pageSize);
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };
  });

  document.getElementById('prac-prev').onclick = function() {
    if (prevUrl) _pracLoadFull(el, prevUrl, search, pageSize);
  };
  document.getElementById('prac-next').onclick = function() {
    if (nextUrl) _pracLoadFull(el, nextUrl, search, pageSize);
  };
}

function _pracQuery(search, pageSize) {
  var q = 'Practitioner?_count=' + pageSize + '&_sort=-_lastUpdated';
  if (search) q += '&name:contains=' + encodeURIComponent(search);
  return q;
}

function _pracLoadPage(el, query, search, pageSize) {
  document.getElementById('prac-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhir(query)
    .then(function(b) { _pracRenderTable(el, b, _pracRoleMap, search, pageSize); })
    .catch(function(e) { document.getElementById('prac-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function _pracLoadFull(el, url, search, pageSize) {
  document.getElementById('prac-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhirFull(url)
    .then(function(b) { _pracRenderTable(el, b, _pracRoleMap, search, pageSize); })
    .catch(function(e) { document.getElementById('prac-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function renderPractitioners(el) {
  var search   = '';
  var pageSize = _pracPageSize;
  loading(el);

  fhir('PractitionerRole?_count=500').then(function(rb) {
    _pracRoleMap = {};
    entries(rb).forEach(function(r) {
      var ref = get(r, 'practitioner', 'reference');
      var pid = ref && ref.split('/')[1];
      if (pid) _pracRoleMap[pid] = r;
    });

    el.innerHTML =
      '<div class="page-header">' +
        '<h2>Practitioners</h2>' +
        '<input type="search" id="prac-search" placeholder="Search by name…" style="max-width:240px">' +
        '<select id="prac-pagesize" style="width:auto">' +
          [10,20,50,100].map(function(n) {
            return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + ' per page</option>';
          }).join('') +
        '</select>' +
        '<a href="#/mappings" class="btn btn-outline" style="font-size:13px">+ New Field Worker → go to Mappings</a>' +
      '</div>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="prac-data">Practitioners</button>' +
        '<button class="page-tab" data-tab="prac-help">? Help</button>' +
      '</div>' +
      '<div id="prac-data"></div>' +
      '<div id="prac-help" class="help-panel" hidden>' + practitionersHelpHTML() + '</div>';

    wirePageTabs(el);
    _pracLoadPage(el, _pracQuery(search, pageSize), search, pageSize);


    document.getElementById('prac-pagesize').onchange = function() {
      pageSize = parseInt(this.value, 10);
      _pracPageSize = pageSize;
      _pracLoadPage(el, _pracQuery(search, pageSize), search, pageSize);
    };
    document.getElementById('prac-search').addEventListener('input', function(e) {
      clearTimeout(_pracSearchTimer);
      var val = e.target.value.trim();
      _pracSearchTimer = setTimeout(function() {
        search = val;
        _pracLoadPage(el, _pracQuery(search, pageSize), search, pageSize);
      }, 350);
    });
  }).catch(function(e) { errMsg(el, e.message); });
}
