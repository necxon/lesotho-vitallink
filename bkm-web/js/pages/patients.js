/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/patients.js (patientsHelpHTML, global).

// ── Patient forms ─────────────────────────────────────────────────────────────

function patientFormHtml(p) {
  var n      = (p && p.name && p.name[0]) || {};
  var given  = Array.isArray(n.given) ? n.given.join(' ') : (n.given || '');
  var family = n.family || '';
  var phone  = '';
  if (p && p.telecom) {
    for (var i = 0; i < p.telecom.length; i++) {
      if (p.telecom[i].system === 'phone') { phone = p.telecom[i].value; break; }
    }
  }
  var addr = (p && p.address && p.address[0]) || {};
  return (
    '<div class="form-row"><label>Given name(s)</label>' +
      '<input id="f-given" value="' + esc(given) + '"></div>' +
    '<div class="form-row"><label>Family name</label>' +
      '<input id="f-family" value="' + esc(family) + '"></div>' +
    '<div class="form-row"><label>Date of birth</label>' +
      '<input id="f-dob" type="date" value="' + esc(p && p.birthDate || '') + '"></div>' +
    '<div class="form-row"><label>Gender</label>' +
      '<select id="f-gender">' +
        '<option value="">— select —</option>' +
        ['male','female','other','unknown'].map(function(g) {
          return '<option value="' + g + '"' + (p && p.gender === g ? ' selected' : '') + '>' + g + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-row"><label>Phone</label>' +
      '<input id="f-phone" value="' + esc(phone) + '"></div>' +
    '<div class="form-row"><label>Village / district</label>' +
      '<input id="f-district" value="' + esc(addr.district || '') + '" placeholder="e.g. Maseru"></div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function patientFromForm(existing) {
  var given  = document.getElementById('f-given').value.trim();
  var family = document.getElementById('f-family').value.trim();
  var dob    = document.getElementById('f-dob').value;
  var gender = document.getElementById('f-gender').value;
  var phone  = document.getElementById('f-phone').value.trim();
  var dist   = document.getElementById('f-district').value.trim();

  var resource = Object.assign({}, existing || {}, { resourceType: 'Patient' });
  resource.name = [{ given: given ? [given] : undefined, family: family || undefined }];
  if (dob) resource.birthDate = dob; else delete resource.birthDate;
  if (gender) resource.gender = gender; else delete resource.gender;
  resource.telecom = phone ? [{ system: 'phone', value: phone, use: 'mobile' }] : [];
  resource.address = dist ? [{ district: dist, country: 'LSO' }] : [];
  return resource;
}

function openPatientForm(p, onSave) {
  var isNew = !p;
  showModal(isNew ? 'New Patient' : 'Edit Patient', patientFormHtml(p));
  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = patientFromForm(p);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('Patient', resource) : fhirPut('Patient', p.id, resource);
    op.then(function(saved) {
      console.log('Patient saved:', saved && saved.id);
      closeModal();
      onSave(saved);
    }).catch(function(err) {
      console.error('Patient save error:', err);
      btn.disabled = false; btn.textContent = 'Save';
      alert('Error: ' + err.message);
    });
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function csvCell(val) {
  var s = (val === undefined || val === null) ? '' : String(val);
  return '"' + s.replace(/"/g, '""') + '"';
}

function downloadCsv(filename, rows) {
  var content = rows.map(function(r) { return r.map(csvCell).join(','); }).join('\r\n');
  var blob = new Blob([content], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function exportPatientsCsv(btn) {
  btn.disabled = true; btn.textContent = 'Exporting…';
  fhir('Patient?_count=1000&_sort=-_lastUpdated').then(function(b) {
    var patients = entries(b);
    var dispenseRequests = patients.map(function(p) {
      return fhir('MedicationDispense?subject=Patient/' + p.id + '&_count=200&_sort=-_lastUpdated')
        .then(function(db) { return { patient: p, dispenses: entries(db) }; })
        .catch(function() { return { patient: p, dispenses: [] }; });
    });
    return Promise.all(dispenseRequests);
  }).then(function(results) {
    var headers = [
      'Patient ID','First Name','Last Name','Date of Birth','Age','Gender','Phone','Address',
      'Dispense Date','Medication Code','Medication','Quantity','Unit','Performer','Status'
    ];
    var rows = [headers];
    results.forEach(function(r) {
      var p = r.patient;
      var name  = p.name && p.name[0] || {};
      var given = (name.given || []).join(' ');
      var family = name.family || '';
      var phone = '';
      (p.telecom || []).forEach(function(t) { if (t.system === 'phone') phone = t.value; });
      var addr = p.address && p.address[0];
      var addrStr = addr ? [addr.city, addr.state, addr.country].filter(Boolean).join(', ') : '';

      if (r.dispenses.length === 0) {
        rows.push([p.id, given, family, p.birthDate || '', age(p.birthDate), p.gender || '', phone, addrStr,
                   '', '', '', '', '', '', '']);
      } else {
        r.dispenses.forEach(function(d) {
          var coding = get(d, 'medicationCodeableConcept', 'coding', '0') || {};
          var performer = get(d, 'performer', '0', 'actor', 'reference') || '';
          rows.push([
            p.id, given, family, p.birthDate || '', age(p.birthDate), p.gender || '', phone, addrStr,
            d.whenHandedOver || '', coding.code || '', coding.display || '',
            (d.quantity && d.quantity.value) || '', (d.quantity && d.quantity.unit) || '',
            performer, d.status || ''
          ]);
        });
      }
    });
    downloadCsv('bkm-patients-' + new Date().toISOString().slice(0,10) + '.csv', rows);
  }).catch(function(e) {
    alert('Export failed: ' + e.message);
  }).then(function() {
    btn.disabled = false; btn.textContent = 'Export CSV';
  });
}

// ── Patients list ─────────────────────────────────────────────────────────────

var _ptPageSize = 20;
var _ptSearchTimer = null;
var _ptSort = { col: null, dir: 1 };
function _ptVal(p, col) {
  if (col === 'name')      return ptName(p);
  if (col === 'id')        return p.id;
  if (col === 'birthDate') return p.birthDate || '';
  if (col === 'gender')    return p.gender || '';
  return '';
}

function _ptQuery(search, pageSize) {
  var q = 'Patient?_count=' + pageSize + '&_sort=-_lastUpdated';
  if (search) q += '&name:contains=' + encodeURIComponent(search);
  return q;
}

function renderPatients(el) {
  listPage({
    el: el,
    prefix: 'pt',
    title: 'Patients (BKM)',
    dataTabLabel: 'Patients',
    helpHTML: patientsHelpHTML(),
    searchPlaceholder: 'Search by name…',
    pageSizes: [10, 20, 50, 100],
    pageSize: _ptPageSize,
    onPageSize: function(n) { _ptPageSize = n; },
    canNew: false,
    headerExtra: '<button class="btn btn-outline" id="pt-export">Export CSV</button>',
    onChrome: function() {
      document.getElementById('pt-export').onclick = function() { exportPatientsCsv(this); };
    },
    query: function(search, pageSize) { return _ptQuery(search, pageSize); },
    items: function(bundle) { return entries(bundle); },
    renderData: function(patients) {
      if (!patients.length) return '<p>No patients found.</p>';
      var rows = sortedRows(patients, _ptSort, _ptVal).map(function(p) {
        return '<tr>' +
          '<td><a href="#/patients/' + esc(p.id) + '">' + esc(ptName(p)) + '</a></td>' +
          '<td>' + esc(p.id) + '</td>' +
          '<td>' + esc(p.birthDate || '—') + '</td>' +
          '<td>' + esc(age(p.birthDate)) + '</td>' +
          '<td>' + esc(p.gender || '—') + '</td>' +
          '<td>' + (window.BKM_ROLE === 'admin' ? '<button class="btn btn-sm btn-outline pt-edit-btn" data-id="' + esc(p.id) + '">Edit</button>' : '') + '</td>' +
          '</tr>';
      });
      return '<div class="tbl-wrap"><table><thead><tr>' +
        sortTh('Name', 'name', _ptSort) + sortTh('ID', 'id', _ptSort) +
        sortTh('Date of Birth', 'birthDate', _ptSort) + '<th>Age</th>' +
        sortTh('Gender', 'gender', _ptSort) + '<th></th>' +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    },
    wireItems: function(dataEl, patients, reload, reRender) {
      wireSortHeaders(dataEl, _ptSort, reRender);
      dataEl.querySelectorAll('.pt-edit-btn').forEach(function(btn) {
        btn.onclick = function() {
          fhir('Patient/' + btn.getAttribute('data-id')).then(function(p) { openPatientForm(p, reload); });
        };
      });
    }
  });
}

// ── Patient detail ────────────────────────────────────────────────────────────

function renderPatientDetail(el, id) {
  loading(el);
  Promise.all([
    fhir('Patient/' + esc(id)),
    fhir('MedicationDispense?subject=Patient/' + esc(id) + '&_sort=-_lastUpdated&_count=20'),
    fhir('Group?member=Patient/' + esc(id) + '&_count=10'),
  ]).then(function(results) {
    var patient    = results[0];
    var dispBundle = results[1];
    var groups     = entries(results[2]);
    var familyHtml = groups.length
      ? groups.map(function(g) { return '<a href="#/groups/' + esc(g.id) + '">' + esc(g.name || g.id) + '</a>'; }).join(', ')
      : '<span style="color:#888">Not in any household</span>';
    var addr    = patient.address && patient.address[0];
    var telecom = patient.telecom || [];
    var phone   = '—';
    for (var i = 0; i < telecom.length; i++) {
      if (telecom[i].system === 'phone') { phone = telecom[i].value; break; }
    }
    var dispenses = entries(dispBundle);

    var addrStr = addr
      ? esc([(addr.line || []).join(', '), addr.city, addr.district].filter(Boolean).join(', '))
      : '—';

    el.innerHTML =
      '<a href="#/patients" class="back">← Patients</a>' +
      '<div class="detail-grid">' +
        '<article>' +
          '<header>' +
            '<h2>' + esc(ptName(patient)) + '</h2>' +
            badge(patient.active === false ? 'Inactive' : 'Active',
                  patient.active === false ? 'red' : 'green') +
          '</header>' +
          '<dl>' +
            '<dt>Patient ID</dt><dd><code>' + esc(patient.id) + '</code></dd>' +
            '<dt>Date of Birth</dt><dd>' + esc(patient.birthDate || '—') + (patient.birthDate ? ' (' + age(patient.birthDate) + ')' : '') + '</dd>' +
            '<dt>Gender</dt><dd>' + esc(patient.gender || '—') + '</dd>' +
            '<dt>Phone</dt><dd>' + esc(phone) + '</dd>' +
            '<dt>Address</dt><dd>' + addrStr + '</dd>' +
            '<dt>Household / Family</dt><dd>' + familyHtml + '</dd>' +
          '</dl>' +
          '<div class="detail-actions">' +
            (window.BKM_ROLE === 'admin'
              ? '<button class="btn btn-outline" id="pt-edit">Edit</button>' +
                '<button class="btn btn-danger" id="pt-delete">Delete</button>'
              : '') +
          '</div>' +
        '</article>' +

        '<article>' +
          '<header><h3>Dispense History ' + badge(dispenses.length) + '</h3></header>' +
          table(
            ['Date', 'Medication', 'Qty', 'Dispensed by', 'Status'],
            dispenses.map(function(d) {
              var coding = get(d, 'medicationCodeableConcept', 'coding', '0');
              var med = (coding && (coding.display || coding.code)) ||
                        get(d, 'medicationCodeableConcept', 'text') || '—';
              var qty  = get(d, 'quantity', 'value');
              var unit = get(d, 'quantity', 'unit') || '';
              var by = get(d, 'performer', '0', 'actor', 'display') ||
                       (get(d, 'performer', '0', 'actor', 'reference') || '—').replace(/^Practitioner\//, '');
              return '<tr>' +
                '<td>' + fmtDate(d.whenHandedOver) + '</td>' +
                '<td>' + esc(med) + '</td>' +
                '<td>' + esc(qty !== undefined ? qty : '—') + ' ' + esc(unit) + '</td>' +
                '<td>' + esc(by) + '</td>' +
                '<td>' + badge(d.status) + '</td>' +
                '</tr>';
            }),
            'No dispense records for this patient.'
          ) +
        '</article>' +
      '</div>';

    if (window.BKM_ROLE === 'admin') {
    document.getElementById('pt-edit').onclick = function() {
      openPatientForm(patient, function() { renderPatientDetail(el, id); });
    };
    document.getElementById('pt-delete').onclick = function() {
      showConfirm('Delete Patient', 'Delete ' + ptName(patient) + '? This cannot be undone.', function() {
        fhirDelete('Patient', id).then(function() {
          closeModal();
          location.hash = '#/patients';
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };
    }
  }).catch(function(e) { errMsg(el, e.message); });
}
