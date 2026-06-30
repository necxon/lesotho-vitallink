/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/locations.js (locationsHelpHTML, global).

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

function renderLocations(el) {
  listPage({
    el: el,
    prefix: 'loc',
    title: 'Locations (BKM)',
    dataTabLabel: 'Locations',
    helpHTML: locationsHelpHTML(),
    searchPlaceholder: 'Search by name…',
    pageSizes: [10, 20, 50, 100],
    pageSize: _locPageSize,
    onPageSize: function(n) { _locPageSize = n; },
    canNew: window.BKM_ROLE === 'admin',
    newLabel: '+ New Location',
    onNew: function(reload) {
      openLocationForm(null, _allLocs, function(saved) { if (saved) _allLocs.push(saved); reload(); });
    },
    preload: function() {
      return fhir('Location?_count=500&_sort=name').then(function(ab) { _allLocs = entries(ab); });
    },
    query: function(search, pageSize) { return _locQuery(search, pageSize); },
    items: function(bundle) { return entries(bundle); },
    renderData: function(locs) {
      if (!locs.length) return '<p>No locations found.</p>';
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
      return '<div class="tbl-wrap"><table><thead><tr>' +
        sortTh('Name', 'name', _locSort) + sortTh('Type', 'type', _locSort) +
        sortTh('Parent', 'parent', _locSort) + sortTh('Status', 'status', _locSort) + '<th></th>' +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    },
    wireItems: function(dataEl, locs, reload, reRender) {
      wireSortHeaders(dataEl, _locSort, reRender);
      dataEl.querySelectorAll('.loc-edit').forEach(function(btn) {
        btn.onclick = function() {
          fhir('Location/' + btn.getAttribute('data-id')).then(function(l) { openLocationForm(l, _allLocs, reload); });
        };
      });
      dataEl.querySelectorAll('.loc-del').forEach(function(btn) {
        btn.onclick = function() {
          var lid = btn.getAttribute('data-id'), name = btn.getAttribute('data-name');
          showConfirm('Delete Location', 'Delete "' + name + '"?', function() {
            fhirDelete('Location', lid).then(function() {
              _allLocs = _allLocs.filter(function(x) { return x.id !== lid; });
              closeModal(); reload();
            }).catch(function(e) { alert('Error: ' + e.message); });
          });
        };
      });
    }
  });
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
