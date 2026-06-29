/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function locationsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR Location</strong> resources. Locations form a hierarchy used to ' +
      'organise facilities and villages: <strong>Country → District → Facility → Village</strong>. ' +
      'VHW org units in the mediator map to village-level Location IDs so that stock orders are ' +
      'attributed to the right catchment area.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Location display name</td></tr>' +
          '<tr><td><strong>Type</strong></td><td>Physical type: country, district, facility, village, etc.</td></tr>' +
          '<tr><td><strong>Parent</strong></td><td>Parent location resolved from <code>Location.partOf</code></td></tr>' +
          '<tr><td><strong>Status</strong></td><td>active / inactive / suspended</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Facility types</h4>' +
      '<p>Every facility in the hierarchy is classified as one of two types:</p>' +
      '<table>' +
        '<thead><tr><th>Type</th><th>FHIR code</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Hospital</strong></td><td><code>HOSP</code></td><td>Has inpatient beds and 24-hour care — district hospitals, referral hospitals, mission hospitals (e.g. Berea Hospital, Scott Hospital, Seboche Hospital)</td></tr>' +
          '<tr><td><strong>Health Centre</strong></td><td><code>HC</code></td><td>Primary or outpatient care only — health centres, clinics, health posts (e.g. Roma Clinic, Maqhaka HC, Sani HP)</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">Non-facility levels use <code>AREA</code> (district) and <code>COMM</code> (village/community).</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>National hierarchy</h4>' +
      '<p>All 10 Lesotho districts are seeded with their main hospitals and representative health centres:</p>' +
      '<table>' +
        '<thead><tr><th>District</th><th>Main Hospital</th><th>Other Hospital</th><th>HCs / Clinics</th></tr></thead>' +
        '<tbody>' +
          '<tr><td>Maseru</td><td>Maseru District Hospital, Queen Mamohato Memorial</td><td>Scott Hospital</td><td>Roma Clinic, Semonkong HC, Thetsane HC</td></tr>' +
          '<tr><td>Berea</td><td>Berea Hospital (Teyateyaneng)</td><td>Maluti Adventist Hospital</td><td>Maqhaka, Khubetsoana, Mapheleng</td></tr>' +
          '<tr><td>Butha-Buthe</td><td>Butha-Buthe Hospital</td><td>Seboche Hospital</td><td>Fobane, Motete</td></tr>' +
          '<tr><td>Leribe</td><td>Motebang Hospital (Hlotse)</td><td>Mamohau Hospital</td><td>Hlotse, Maputsoe, Tsikoane</td></tr>' +
          '<tr><td>Mafeteng</td><td>Mafeteng Hospital</td><td>—</td><td>Mohalalitoe, Ramabanta, Mafeteng Urban Clinic</td></tr>' +
          '<tr><td>Mohale\'s Hoek</td><td>Mohale\'s Hoek Hospital</td><td>—</td><td>Moyeni, Sekake</td></tr>' +
          '<tr><td>Mokhotlong</td><td>Mokhotlong Hospital</td><td>—</td><td>Mapholaneng, Sani HP</td></tr>' +
          '<tr><td>Qacha\'s Nek</td><td>Qacha\'s Nek Hospital</td><td>—</td><td>Qacha\'s Nek HC, Marakabei</td></tr>' +
          '<tr><td>Quthing</td><td>Quthing Hospital</td><td>—</td><td>Mount Moorosi, Mphaki</td></tr>' +
          '<tr><td>Thaba-Tseka</td><td>Thaba-Tseka Hospital</td><td>—</td><td>Katse, Thaba-Tseka Rural HC</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px;font-size:11px;color:var(--dhis2-text-muted)">Note: facility counts are representative, not exhaustive. Most primary facilities are run by the Government or CHAL (Christian Health Association of Lesotho).</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Maseru catchment detail</h4>' +
      '<p><code>loc-lesotho</code> → <code>loc-maseru-district</code> → <code>loc-maseru-clinic-a</code> → ' +
      '<code>loc-ha-mokoena</code>, <code>loc-ha-sehlabane</code>, <code>loc-matsieng</code></p>' +
      '<p>Data source: <code>GET /fhir/Location?_count=200</code></p>' +
    '</div>'
  );
}

// ── Location helpers ──────────────────────────────────────────────────────────

var LOC_TYPES = ['Country','Province','District','Facility','Village','Community'];

function locType(loc) {
  var coding = get(loc, 'type', '0', 'coding', '0');
  return (coding && (coding.display || coding.code)) ||
         get(loc, 'type', '0', 'text') || '—';
}

function locParentId(loc) {
  var ref = loc && loc.partOf && loc.partOf.reference;
  return ref ? ref.split('/')[1] : null;
}

function locParentName(loc, allLocs) {
  var pid = locParentId(loc);
  if (!pid) return '—';
  for (var i = 0; i < allLocs.length; i++) {
    if (allLocs[i].id === pid) return allLocs[i].name || pid;
  }
  return pid;
}

// ── Location form ─────────────────────────────────────────────────────────────

function locationFormHtml(l, allLocs) {
  var parentId = locParentId(l) || '';
  var typeVal  = locType(l) !== '—' ? locType(l) : '';
  return (
    '<div class="form-row"><label>Name</label>' +
      '<input id="f-name" value="' + esc(l && l.name || '') + '"></div>' +
    '<div class="form-row"><label>Type</label>' +
      '<select id="f-type">' +
        '<option value="">— select —</option>' +
        LOC_TYPES.map(function(t) {
          return '<option value="' + t + '"' + (typeVal === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-row"><label>Status</label>' +
      '<select id="f-status">' +
        ['active','suspended','inactive'].map(function(s) {
          return '<option value="' + s + '"' + ((l && l.status || 'active') === s ? ' selected' : '') + '>' + s + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-row"><label>Parent location</label>' +
      '<select id="f-parent">' +
        '<option value="">— none (top level) —</option>' +
        allLocs.filter(function(x) { return !l || x.id !== l.id; }).map(function(x) {
          return '<option value="' + esc(x.id) + '"' + (parentId === x.id ? ' selected' : '') + '>' + esc(x.name || x.id) + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function locationFromForm(existing) {
  var r = Object.assign({}, existing || {}, { resourceType: 'Location' });
  r.name   = document.getElementById('f-name').value.trim();
  r.status = document.getElementById('f-status').value;
  var t = document.getElementById('f-type').value;
  r.type   = t ? [{ coding: [{ code: t, display: t }], text: t }] : [];
  var pid  = document.getElementById('f-parent').value;
  r.partOf = pid ? { reference: 'Location/' + pid } : undefined;
  return r;
}

function openLocationForm(l, allLocs, onSave) {
  var isNew = !l;
  showModal(isNew ? 'New Location' : 'Edit Location', locationFormHtml(l, allLocs));
  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = locationFromForm(l);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('Location', resource) : fhirPut('Location', l.id, resource);
    op.then(function(saved) { closeModal(); onSave(saved); })
      .catch(function(err) { btn.disabled = false; btn.textContent = 'Save'; alert('Error: ' + err.message); });
  };
}

// ── Locations page ────────────────────────────────────────────────────────────

var _locSearchTimer = null;
var _locPageSize    = 20;
var _allLocs        = [];
var _locSort        = { col: null, dir: 1 };
function _locVal(l, col) {
  if (col === 'name')   return l.name || l.id;
  if (col === 'type')   return locType(l);
  if (col === 'parent') return locParentName(l, _allLocs);
  if (col === 'status') return l.status || '';
  return '';
}

function _locQuery(search, pageSize) {
  var q = 'Location?_count=' + pageSize + '&_sort=name';
  if (search) q += '&name:contains=' + encodeURIComponent(search);
  return q;
}

function _locRenderTable(el, bundle, search, pageSize) {
  var locs    = entries(bundle);
  var total   = bundle.total !== undefined ? bundle.total : '?';
  var nextUrl = bundleLink(bundle, 'next');
  var prevUrl = bundleLink(bundle, 'previous');

  var rows = sortedRows(locs, _locSort, _locVal).map(function(l) {
    return '<tr>' +
      '<td><a href="#/locations/' + esc(l.id) + '">' + esc(l.name || l.id) + '</a></td>' +
      '<td>' + esc(locType(l)) + '</td>' +
      '<td>' + esc(locParentName(l, _allLocs)) + '</td>' +
      '<td>' + badge(l.status || 'unknown', l.status === 'active' ? 'green' : 'inactive') + '</td>' +
      '<td>' +
        (window.BKM_ROLE === 'admin'
          ? '<button class="btn btn-sm btn-outline loc-edit" data-id="' + esc(l.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger loc-del" data-id="' + esc(l.id) + '" data-name="' + esc(l.name || l.id) + '">Del</button>'
          : '') +
      '</td>' +
      '</tr>';
  });

  var pager =
    '<div class="pager">' +
      '<span class="pager-info">Showing ' + locs.length + ' of ' + total + '</span>' +
      '<div class="pager-btns">' +
        '<button class="btn btn-sm btn-outline" id="loc-prev"' + (prevUrl ? '' : ' disabled') + '>← Prev</button>' +
        '<button class="btn btn-sm btn-outline" id="loc-next"' + (nextUrl ? '' : ' disabled') + '>Next →</button>' +
      '</div>' +
    '</div>';

  var locTableHtml = !locs.length ? '<p>No locations found.</p>' :
    '<div class="tbl-wrap"><table><thead><tr>' +
    sortTh('Name','name',_locSort) + sortTh('Type','type',_locSort) +
    sortTh('Parent','parent',_locSort) + sortTh('Status','status',_locSort) + '<th></th>' +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  document.getElementById('loc-data').innerHTML = locTableHtml + pager;
  wireSortHeaders(document.getElementById('loc-data'), _locSort, function() {
    _locRenderTable(el, bundle, search, pageSize);
  });

  el.querySelectorAll('.loc-edit').forEach(function(btn) {
    btn.onclick = function() {
      fhir('Location/' + btn.getAttribute('data-id')).then(function(l) {
        openLocationForm(l, _allLocs, function() { _locLoadPage(el, _locQuery(search, pageSize), search, pageSize); });
      });
    };
  });
  el.querySelectorAll('.loc-del').forEach(function(btn) {
    btn.onclick = function() {
      var lid = btn.getAttribute('data-id'), name = btn.getAttribute('data-name');
      showConfirm('Delete Location', 'Delete "' + name + '"?', function() {
        fhirDelete('Location', lid).then(function() {
          _allLocs = _allLocs.filter(function(x) { return x.id !== lid; });
          closeModal(); _locLoadPage(el, _locQuery(search, pageSize), search, pageSize);
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };
  });
  document.getElementById('loc-prev').onclick = function() {
    if (prevUrl) _locLoadFull(el, prevUrl, search, pageSize);
  };
  document.getElementById('loc-next').onclick = function() {
    if (nextUrl) _locLoadFull(el, nextUrl, search, pageSize);
  };
}

function _locLoadPage(el, query, search, pageSize) {
  document.getElementById('loc-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhir(query)
    .then(function(b) { _locRenderTable(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('loc-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function _locLoadFull(el, url, search, pageSize) {
  document.getElementById('loc-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhirFull(url)
    .then(function(b) { _locRenderTable(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('loc-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function renderLocations(el) {
  var search   = '';
  var pageSize = _locPageSize;
  loading(el);

  fhir('Location?_count=500&_sort=name').then(function(ab) {
    _allLocs = entries(ab);

    el.innerHTML =
      '<div class="page-header">' +
        '<h2>Locations (BKM)</h2>' +
        '<input type="search" id="loc-search" placeholder="Search by name…" style="max-width:240px">' +
        '<select id="loc-pagesize" style="width:auto">' +
          [10,20,50,100].map(function(n) {
            return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + ' per page</option>';
          }).join('') +
        '</select>' +
        '<button class="btn btn-primary" id="loc-new">+ New Location</button>' +
      '</div>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="loc-data">Locations</button>' +
        '<button class="page-tab" data-tab="loc-help">? Help</button>' +
      '</div>' +
      '<div id="loc-data"></div>' +
      '<div id="loc-help" class="help-panel" hidden>' + locationsHelpHTML() + '</div>';

    wirePageTabs(el);
    _locLoadPage(el, _locQuery(search, pageSize), search, pageSize);

    if (window.BKM_ROLE !== 'admin') document.getElementById('loc-new').style.display = 'none';
    document.getElementById('loc-new').onclick = function() {
      openLocationForm(null, _allLocs, function(saved) {
        if (saved) _allLocs.push(saved);
        _locLoadPage(el, _locQuery(search, pageSize), search, pageSize);
      });
    };
    document.getElementById('loc-pagesize').onchange = function() {
      pageSize = parseInt(this.value, 10);
      _locPageSize = pageSize;
      _locLoadPage(el, _locQuery(search, pageSize), search, pageSize);
    };
    document.getElementById('loc-search').addEventListener('input', function(e) {
      clearTimeout(_locSearchTimer);
      var val = e.target.value.trim();
      _locSearchTimer = setTimeout(function() {
        search = val;
        _locLoadPage(el, _locQuery(search, pageSize), search, pageSize);
      }, 350);
    });
  }).catch(function(e) { errMsg(el, e.message); });
}

// ── Location detail ───────────────────────────────────────────────────────────

function renderLocationDetail(el, id) {
  loading(el);
  fhir('Location/' + esc(id)).then(function(l) {
    var parentRef = l.partOf && l.partOf.reference || null;
    var parentId  = parentRef ? parentRef.split('/')[1] : null;

    function renderDetail(parentName) {
      el.innerHTML =
        '<a href="#/locations" class="back">← Locations</a>' +
        '<div class="detail-grid">' +
          '<article>' +
            '<header>' +
              '<h2>' + esc(l.name || l.id) + '</h2>' +
              badge(l.status || 'unknown', l.status === 'active' ? 'green' : 'inactive') +
            '</header>' +
            '<dl>' +
              '<dt>ID</dt><dd><code>' + esc(l.id) + '</code></dd>' +
              '<dt>Type</dt><dd>' + esc(locType(l)) + '</dd>' +
              '<dt>Part Of</dt><dd>' + (parentId
                ? '<a href="#/locations/' + esc(parentId) + '">' + esc(parentName) + '</a>'
                : '—') + '</dd>' +
              '<dt>Mode</dt><dd>' + esc(l.mode || '—') + '</dd>' +
              (l.address ? '<dt>Address</dt><dd>' + esc([l.address.line, l.address.city, l.address.country].filter(Boolean).join(', ')) + '</dd>' : '') +
            '</dl>' +
            '<div class="detail-actions">' +
              (window.BKM_ROLE === 'admin'
                ? '<button class="btn btn-outline" id="loc-edit">Edit</button>' +
                  '<button class="btn btn-danger" id="loc-delete">Delete</button>'
                : '') +
            '</div>' +
          '</article>' +

          '<article>' +
            '<header><h3>Child Locations</h3></header>' +
            '<div id="loc-children"><p aria-busy="true">Loading…</p></div>' +
          '</article>' +
        '</div>';

      if (window.BKM_ROLE === 'admin') {
        document.getElementById('loc-edit').onclick = function() {
          fhir('Location?_count=500&_sort=name').then(function(ab) {
            openLocationForm(l, entries(ab), function() { renderLocationDetail(el, id); });
          });
        };
        document.getElementById('loc-delete').onclick = function() {
          showConfirm('Delete Location', 'Delete "' + (l.name || l.id) + '"?', function() {
            fhirDelete('Location', id).then(function() {
              closeModal(); location.hash = '#/locations';
            }).catch(function(e) { alert('Error: ' + e.message); });
          });
        };
      }

      fhir('Location?partof=Location/' + esc(id) + '&_count=50').then(function(cb) {
        var children = entries(cb);
        var childEl = document.getElementById('loc-children');
        if (!childEl) return;
        if (!children.length) {
          childEl.innerHTML = '<p style="color:#6b7a8d;font-size:13px">No child locations.</p>';
          return;
        }
        childEl.innerHTML = table(
          ['Name', 'Type', 'Status'],
          children.map(function(c) {
            return '<tr>' +
              '<td><a href="#/locations/' + esc(c.id) + '">' + esc(c.name || c.id) + '</a></td>' +
              '<td>' + esc(locType(c)) + '</td>' +
              '<td>' + badge(c.status || 'unknown', c.status === 'active' ? 'green' : 'inactive') + '</td>' +
              '</tr>';
          }),
          ''
        );
      }).catch(function() {
        var childEl = document.getElementById('loc-children');
        if (childEl) childEl.innerHTML = '<p class="error">Could not load children.</p>';
      });
    }

    if (parentId) {
      fhir('Location/' + parentId)
        .then(function(p) { renderDetail(p.name || parentId); })
        .catch(function()  { renderDetail(parentId); });
    } else {
      renderDetail(null);
    }
  }).catch(function(e) { errMsg(el, e.message); });
}
