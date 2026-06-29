/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function groupsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR Group</strong> resources. Groups associate a set of patients with a ' +
      'managing organisation or village, forming patient panels for VHW catchment areas. ' +
      'Each VHW village has one group containing the patients they are responsible for.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Columns</h4>' +
      '<table>' +
        '<thead><tr><th>Column</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Group display name (e.g. "Ha Mokoena Patients")</td></tr>' +
          '<tr><td><strong>Type</strong></td><td>FHIR group type — always <em>person</em> for patient groups</td></tr>' +
          '<tr><td><strong>Members</strong></td><td>Count of patients in the group (<code>Group.quantity</code>)</td></tr>' +
          '<tr><td><strong>Managing Entity</strong></td><td>Organisation responsible for this group (usually the facility)</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Reads from HAPI FHIR: <code>GET /fhir/Group?_count=100</code>. Click a group name to view its members.</p>' +
    '</div>'
  );
}

// ── Group form ────────────────────────────────────────────────────────────────

var _grpPatNames   = {};  // patient id → display name, loaded once per page visit
var _grpFormMembers = [];

function _grpRenderMembersList() {
  var listEl = document.getElementById('grp-members-list');
  if (!listEl) return;
  if (!_grpFormMembers.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:var(--dhis2-muted);margin:4px 0">No members yet.</p>';
  } else {
    listEl.innerHTML =
      '<table style="width:100%;margin-bottom:4px"><thead><tr><th>Patient</th><th></th></tr></thead><tbody>' +
      _grpFormMembers.map(function(m, idx) {
        var ref     = (m.entity && m.entity.reference) || '';
        var bareId  = ref.replace('Patient/', '');
        var display = (m.entity && m.entity.display) || _grpPatNames[bareId] || _grpPatNames[ref] || ref;
        return '<tr>' +
          '<td>' + esc(display) + '</td>' +
          '<td><button type="button" class="btn btn-sm btn-danger grp-rm-member-form" data-idx="' + idx + '">Remove</button></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }
  listEl.querySelectorAll('.grp-rm-member-form').forEach(function(btn) {
    btn.onclick = function() {
      _grpFormMembers.splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
      _grpRenderMembersList();
    };
  });
}

function groupFormHtml(g) {
  var mgRef = g && g.managingEntity && g.managingEntity.reference || '';
  return (
    '<div class="form-row"><label>Group name</label>' +
      '<input id="f-name" value="' + esc(g && g.name || '') + '"></div>' +
    '<div class="form-row"><label>Type</label>' +
      '<select id="f-type">' +
        ['person','practitioner','device'].map(function(t) {
          return '<option value="' + t + '"' + ((g && g.type || 'person') === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-row"><label>Active</label>' +
      '<select id="f-active">' +
        '<option value="true"' + ((!g || g.active !== false) ? ' selected' : '') + '>Yes</option>' +
        '<option value="false"' + (g && g.active === false ? ' selected' : '') + '>No</option>' +
      '</select></div>' +
    '<div class="form-row"><label>Managing entity (e.g. Organization/maseru-clinic-a)</label>' +
      '<input id="f-managing" value="' + esc(mgRef) + '" placeholder="Organization/id"></div>' +
    '<div class="form-row" style="flex-direction:column;gap:6px">' +
      '<label style="font-weight:600">Members</label>' +
      '<div id="grp-members-list"></div>' +
      '<div style="display:flex;gap:6px;align-items:flex-end">' +
        '<div style="flex:1"><label style="font-size:12px;font-weight:400">Patient</label>' +
          '<select id="f-add-member">' +
            '<option value="">— select —</option>' +
            Object.keys(_grpPatNames)
              .filter(function(k) { return k.indexOf('Patient/') !== 0; })
              .sort(function(a, b) { return (_grpPatNames[a] || a).localeCompare(_grpPatNames[b] || b); })
              .map(function(id) {
                return '<option value="Patient/' + esc(id) + '">' + esc(_grpPatNames[id] || id) + '</option>';
              }).join('') +
          '</select></div>' +
        '<button type="button" class="btn btn-outline" id="grp-add-member-btn" style="flex-shrink:0;align-self:flex-end">+ Add</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function groupFromForm(existing) {
  var r = Object.assign({}, existing || {}, { resourceType: 'Group' });
  r.name   = document.getElementById('f-name').value.trim();
  r.type   = document.getElementById('f-type').value;
  r.actual = true;
  r.active = document.getElementById('f-active').value === 'true';
  var mg   = document.getElementById('f-managing').value.trim();
  r.managingEntity = mg ? { reference: mg } : undefined;
  r.member   = _grpFormMembers.slice();
  r.quantity = r.member.length;
  return r;
}

function openGroupForm(g, onSave) {
  var isNew = !g;
  _grpFormMembers = (g && g.member) ? g.member.slice() : [];
  showModal(isNew ? 'New Group' : 'Edit Group', groupFormHtml(g));
  _grpRenderMembersList();

  document.getElementById('grp-add-member-btn').onclick = function() {
    var val = document.getElementById('f-add-member').value;
    if (!val) return;
    var bareId  = val.replace('Patient/', '');
    var display = _grpPatNames[bareId] || _grpPatNames[val] || '';
    _grpFormMembers.push({ entity: { reference: val, display: display || undefined } });
    document.getElementById('f-add-member').selectedIndex = 0;
    _grpRenderMembersList();
  };

  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = groupFromForm(g);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('Group', resource) : fhirPut('Group', g.id, resource);
    op.then(function(saved) { closeModal(); onSave(saved); })
      .catch(function(err) { btn.disabled = false; btn.textContent = 'Save'; alert('Error: ' + err.message); });
  };
}

// ── Groups page ───────────────────────────────────────────────────────────────

var _grpSearchTimer = null;
var _grpPageSize    = 20;
var _grpSort        = { col: null, dir: 1 };
function _grpVal(g, col) {
  if (col === 'name')    return g.name || g.id;
  if (col === 'type')    return g.type || '';
  if (col === 'members') return String(g.quantity !== undefined ? g.quantity : (g.member ? g.member.length : 0));
  if (col === 'entity')  return (g.managingEntity && (g.managingEntity.display || g.managingEntity.reference)) || '';
  return '';
}

function _grpQuery(search, pageSize) {
  var q = 'Group?type=person&_count=' + pageSize + '&_sort=-_lastUpdated';
  if (search) q += '&name:contains=' + encodeURIComponent(search);
  return q;
}

function _grpRenderTable(el, bundle, search, pageSize) {
  var groups  = entries(bundle);
  var total   = bundle.total !== undefined ? bundle.total : '?';
  var nextUrl = bundleLink(bundle, 'next');
  var prevUrl = bundleLink(bundle, 'previous');

  var rows = sortedRows(groups, _grpSort, _grpVal).map(function(g) {
    var mg  = g.managingEntity && (g.managingEntity.display || g.managingEntity.reference) || '—';
    var qty = g.quantity !== undefined ? g.quantity : (g.member ? g.member.length : '—');
    return '<tr>' +
      '<td><a href="#/groups/' + esc(g.id) + '">' + esc(g.name || g.id) + '</a></td>' +
      '<td>' + esc(g.type || '—') + '</td>' +
      '<td>' + esc(qty) + '</td>' +
      '<td>' + esc(mg) + '</td>' +
      '<td>' +
        (window.BKM_ROLE === 'admin'
          ? '<button class="btn btn-sm btn-outline grp-edit" data-id="' + esc(g.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger grp-del" data-id="' + esc(g.id) + '" data-name="' + esc(g.name || g.id) + '">Del</button>'
          : '') +
      '</td>' +
      '</tr>';
  });

  var pager =
    '<div class="pager">' +
      '<span class="pager-info">Showing ' + groups.length + ' of ' + total + '</span>' +
      '<div class="pager-btns">' +
        '<button class="btn btn-sm btn-outline" id="grp-prev"' + (prevUrl ? '' : ' disabled') + '>← Prev</button>' +
        '<button class="btn btn-sm btn-outline" id="grp-next"' + (nextUrl ? '' : ' disabled') + '>Next →</button>' +
      '</div>' +
    '</div>';

  var grpTableHtml = !groups.length ? '<p>No groups found.</p>' :
    '<div class="tbl-wrap"><table><thead><tr>' +
    sortTh('Name','name',_grpSort) + sortTh('Type','type',_grpSort) +
    sortTh('Members','members',_grpSort) + sortTh('Managing Entity','entity',_grpSort) + '<th></th>' +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  document.getElementById('grp-data').innerHTML = grpTableHtml + pager;
  wireSortHeaders(document.getElementById('grp-data'), _grpSort, function() {
    _grpRenderTable(el, bundle, search, pageSize);
  });

  el.querySelectorAll('.grp-edit').forEach(function(btn) {
    btn.onclick = function() {
      fhir('Group/' + btn.getAttribute('data-id')).then(function(g) {
        openGroupForm(g, function() { _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize); });
      });
    };
  });
  el.querySelectorAll('.grp-del').forEach(function(btn) {
    btn.onclick = function() {
      var gid = btn.getAttribute('data-id'), name = btn.getAttribute('data-name');
      showConfirm('Delete Group', 'Delete "' + name + '"?', function() {
        fhirDelete('Group', gid).then(function() {
          closeModal(); _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize);
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };
  });
  document.getElementById('grp-prev').onclick = function() {
    if (prevUrl) _grpLoadFull(el, prevUrl, search, pageSize);
  };
  document.getElementById('grp-next').onclick = function() {
    if (nextUrl) _grpLoadFull(el, nextUrl, search, pageSize);
  };
}

function _grpLoadPage(el, query, search, pageSize) {
  document.getElementById('grp-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhir(query)
    .then(function(b) { _grpRenderTable(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('grp-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function _grpLoadFull(el, url, search, pageSize) {
  document.getElementById('grp-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhirFull(url)
    .then(function(b) { _grpRenderTable(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('grp-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function renderGroups(el) {
  var search   = '';
  var pageSize = _grpPageSize;

  el.innerHTML =
    '<div class="page-header">' +
      '<h2>Groups (BKM)</h2>' +
      '<input type="search" id="grp-search" placeholder="Search by name…" style="max-width:240px">' +
      '<select id="grp-pagesize" style="width:auto">' +
        [10,20,50,100].map(function(n) {
          return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + ' per page</option>';
        }).join('') +
      '</select>' +
      '<button class="btn btn-primary" id="grp-new">+ New Group</button>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="grp-data">Groups</button>' +
      '<button class="page-tab" data-tab="grp-help">? Help</button>' +
    '</div>' +
    '<div id="grp-data"></div>' +
    '<div id="grp-help" class="help-panel" hidden>' + groupsHelpHTML() + '</div>';

  wirePageTabs(el);

  fhir('Patient?_count=200').catch(function() { return { entry: [] }; }).then(function(pb) {
    _grpPatNames = {};
    entries(pb).forEach(function(p) {
      var name = ptName(p);
      _grpPatNames[p.id]              = name;
      _grpPatNames['Patient/' + p.id] = name;
    });
  });

  _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize);

  if (window.BKM_ROLE !== 'admin') document.getElementById('grp-new').style.display = 'none';
  document.getElementById('grp-new').onclick = function() {
    openGroupForm(null, function() { _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize); });
  };
  document.getElementById('grp-pagesize').onchange = function() {
    pageSize = parseInt(this.value, 10);
    _grpPageSize = pageSize;
    _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize);
  };
  document.getElementById('grp-search').addEventListener('input', function(e) {
    clearTimeout(_grpSearchTimer);
    var val = e.target.value.trim();
    _grpSearchTimer = setTimeout(function() {
      search = val;
      _grpLoadPage(el, _grpQuery(search, pageSize), search, pageSize);
    }, 350);
  });
}

// ── Group detail ──────────────────────────────────────────────────────────────

function renderGroupDetail(el, id) {
  loading(el);
  fhir('Group/' + esc(id)).then(function(g) {
    var members = g.member || [];
    var mg = g.managingEntity && (g.managingEntity.display || g.managingEntity.reference) || '—';

    el.innerHTML =
      '<a href="#/groups" class="back">← Groups</a>' +
      '<div class="detail-grid">' +
        '<article>' +
          '<header><h2>' + esc(g.name || g.id) + '</h2>' +
            badge(g.active === false ? 'inactive' : 'active', g.active === false ? 'inactive' : 'green') +
          '</header>' +
          '<dl>' +
            '<dt>ID</dt><dd><code>' + esc(g.id) + '</code></dd>' +
            '<dt>Type</dt><dd>' + esc(g.type || '—') + '</dd>' +
            '<dt>Members</dt><dd>' + esc(members.length) + '</dd>' +
            '<dt>Managing Entity</dt><dd>' + esc(mg) + '</dd>' +
          '</dl>' +
          '<div class="detail-actions">' +
            (window.BKM_ROLE === 'admin'
              ? '<button class="btn btn-outline" id="grp-edit">Edit</button>' +
                '<button class="btn btn-primary" id="grp-add-member">+ Add Member</button>' +
                '<button class="btn btn-danger" id="grp-delete">Delete</button>'
              : '') +
          '</div>' +
        '</article>' +

        '<article>' +
          '<header><h3>Members ' + badge(members.length) + '</h3></header>' +
          table(
            ['Reference', 'Inactive', ''],
            members.map(function(m, idx) {
              var ref = m.entity && m.entity.reference || '—';
              var refId = ref.split('/')[1] || '';
              var isPatient = ref.indexOf('Patient/') === 0;
              return '<tr>' +
                '<td>' + (isPatient
                  ? '<a href="#/patients/' + esc(refId) + '">' + esc(ref) + '</a>'
                  : esc(ref)) + '</td>' +
                '<td>' + (m.inactive ? 'Yes' : 'No') + '</td>' +
                '<td>' + (window.BKM_ROLE === 'admin' ? '<button class="btn btn-sm btn-danger grp-rm-member" data-idx="' + idx + '">Remove</button>' : '') + '</td>' +
                '</tr>';
            }),
            'No members in this group.'
          ) +
        '</article>' +
      '</div>';

    if (window.BKM_ROLE === 'admin') {
    document.getElementById('grp-edit').onclick = function() {
      openGroupForm(g, function() { renderGroupDetail(el, id); });
    };

    document.getElementById('grp-delete').onclick = function() {
      showConfirm('Delete Group', 'Delete "' + (g.name || g.id) + '"?', function() {
        fhirDelete('Group', id).then(function() {
          closeModal(); location.hash = '#/groups';
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };

    document.getElementById('grp-add-member').onclick = function() {
      showModal('Add Member', '<div class="modal-body"><p aria-busy="true">Loading patients…</p></div>');
      // Populate from the existing patient list (exclude patients already in this group).
      fhir('Patient?_count=500').catch(function() { return { entry: [] }; }).then(function(pb) {
        var existing = {};
        (g.member || []).forEach(function(m) {
          var r = m.entity && m.entity.reference; if (r) existing[r] = true;
        });
        var opts = entries(pb)
          .filter(function(p) { return !existing['Patient/' + p.id]; })
          .map(function(p) { return '<option value="Patient/' + esc(p.id) + '">' + esc(ptName(p)) + ' (' + esc(p.id) + ')</option>'; })
          .join('');
        showModal('Add Member',
          '<div class="modal-body">' +
            '<div class="form-row"><label>Patient</label>' +
              '<select id="f-member-ref">' +
                (opts || '<option value="">— no patients available —</option>') +
              '</select></div>' +
            '<div class="hint" style="font-size:12px;color:#4a5768;margin-top:4px">Pick an existing patient. Patients already in this group are not listed.</div>' +
            '<div class="form-actions">' +
              '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
              '<button class="btn btn-primary" id="form-save">Add</button>' +
            '</div>' +
          '</div>'
        );
        document.getElementById('form-cancel').onclick = closeModal;
        document.getElementById('form-save').onclick = function() {
          var ref = document.getElementById('f-member-ref').value;
          if (!ref) return;
          var updated = Object.assign({}, g);
          updated.member = (g.member || []).concat([{ entity: { reference: ref } }]);
          fhirPut('Group', id, updated).then(function() {
            closeModal(); renderGroupDetail(el, id);
          }).catch(function(e) { alert('Error: ' + e.message); });
        };
      });
    };
    }

    el.querySelectorAll('.grp-rm-member').forEach(function(btn) {
      btn.onclick = function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var updated = Object.assign({}, g);
        updated.member = g.member.filter(function(_, i) { return i !== idx; });
        fhirPut('Group', id, updated).then(function() {
          renderGroupDetail(el, id);
        }).catch(function(e) { alert('Error: ' + e.message); });
      };
    });
  }).catch(function(e) { errMsg(el, e.message); });
}
