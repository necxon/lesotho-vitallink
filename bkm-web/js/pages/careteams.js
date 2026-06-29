/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

function careTeamsHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>Lists all <strong>FHIR CareTeam</strong> resources. A CareTeam groups practitioners — ' +
      'for example, a VHW team under a supervisor covering a catchment area. CareTeams define which ' +
      'health workers operate together and who supervises them.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>CareTeam structure</h4>' +
      '<table>' +
        '<thead><tr><th>Field</th><th>Description</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Name</strong></td><td>Human-readable team name (e.g. "Maseru North VHW Team")</td></tr>' +
          '<tr><td><strong>Status</strong></td><td>active / proposed / inactive</td></tr>' +
          '<tr><td><strong>Member</strong></td><td>Practitioner reference — each row is one team member</td></tr>' +
          '<tr><td><strong>Role</strong></td><td>Member\'s role within this team (supervisor, community-health-worker, etc.)</td></tr>' +
          '<tr><td><strong>Period</strong></td><td>When this member joined the team</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>Reads from HAPI FHIR: <code>GET /fhir/CareTeam?_count=50</code>.<br>' +
      'The seeded team is <code>team-maseru-north</code> (1 supervisor + 3 VHWs).</p>' +
    '</div>'
  );
}

// ── Care Team forms ───────────────────────────────────────────────────────────

var _ctFormParticipants = [];

function _ctRenderParticipantsList() {
  var listEl = document.getElementById('ct-participants-list');
  if (!listEl) return;
  if (!_ctFormParticipants.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:var(--dhis2-muted);margin:4px 0">No members yet.</p>';
  } else {
    listEl.innerHTML =
      '<table style="width:100%;margin-bottom:4px"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>' +
      _ctFormParticipants.map(function(p, idx) {
        var ref     = (p.member && p.member.reference) || '';
        var bareId  = ref.replace('Practitioner/', '');
        var display = (p.member && p.member.display) || _ctPracNames[bareId] || _ctPracNames[ref] || ref;
        var roleArr    = p.role && p.role[0];
        var roleCoding = roleArr && roleArr.coding && roleArr.coding[0];
        var roleText   = (roleCoding && (roleCoding.display || roleCoding.code)) || (roleArr && roleArr.text) || '—';
        return '<tr>' +
          '<td>' + esc(display) + '</td>' +
          '<td>' + esc(roleText) + '</td>' +
          '<td><button type="button" class="btn btn-sm btn-danger ct-rm-participant" data-idx="' + idx + '">Remove</button></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }
  listEl.querySelectorAll('.ct-rm-participant').forEach(function(btn) {
    btn.onclick = function() {
      _ctFormParticipants.splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
      _ctRenderParticipantsList();
    };
  });
}

function careTeamFormHtml(t) {
  return (
    '<div class="form-row"><label>Team name</label>' +
      '<input id="f-name" value="' + esc(t && t.name || '') + '"></div>' +
    '<div class="form-row"><label>Status</label>' +
      '<select id="f-status">' +
        ['proposed','active','suspended','inactive','entered-in-error'].map(function(s) {
          return '<option value="' + s + '"' + (t && t.status === s ? ' selected' : '') + '>' + s + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-row"><label>Description (optional)</label>' +
      '<input id="f-desc" value="' + esc(t && t.note && t.note[0] && t.note[0].text || '') + '"></div>' +
    '<div class="form-row" style="flex-direction:column;gap:6px">' +
      '<label style="font-weight:600">Members</label>' +
      '<div id="ct-participants-list"></div>' +
      '<div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">' +
        '<div style="flex:2;min-width:160px"><label style="font-size:12px;font-weight:400">Practitioner</label>' +
          '<select id="f-add-member">' +
            '<option value="">— select —</option>' +
            Object.keys(_ctPracNames)
              .filter(function(k) { return k.indexOf('Practitioner/') !== 0; })
              .sort(function(a, b) { return (_ctPracNames[a] || a).localeCompare(_ctPracNames[b] || b); })
              .map(function(id) {
                return '<option value="Practitioner/' + esc(id) + '">' + esc(_ctPracNames[id] || id) + '</option>';
              }).join('') +
          '</select></div>' +
        '<div style="flex:1;min-width:120px"><label style="font-size:12px;font-weight:400">Role</label>' +
          '<input id="f-add-role" placeholder="supervisor / community-health-worker"></div>' +
        '<button type="button" class="btn btn-outline" id="ct-add-participant" style="flex-shrink:0;align-self:flex-end">+ Add</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function careTeamFromForm(existing) {
  var r = Object.assign({}, existing || {}, { resourceType: 'CareTeam' });
  r.name        = document.getElementById('f-name').value.trim();
  r.status      = document.getElementById('f-status').value;
  var desc      = document.getElementById('f-desc').value.trim();
  r.note        = desc ? [{ text: desc }] : [];
  r.participant = _ctFormParticipants.slice();
  return r;
}

function openCareTeamForm(t, onSave) {
  var isNew = !t;
  _ctFormParticipants = (t && t.participant) ? t.participant.slice() : [];
  showModal(isNew ? 'New Care Team' : 'Edit Care Team', careTeamFormHtml(t));
  _ctRenderParticipantsList();

  document.getElementById('f-add-member').onchange = function() {
    var val = this.value;
    var roleInput = document.getElementById('f-add-role');
    if (roleInput) roleInput.value = val ? (_ctPracRoles[val] || '') : '';
  };

  document.getElementById('ct-add-participant').onclick = function() {
    var memberVal = document.getElementById('f-add-member').value;
    var roleVal   = document.getElementById('f-add-role').value.trim();
    if (!memberVal) return;
    var bareId  = memberVal.replace('Practitioner/', '');
    var display = _ctPracNames[bareId] || _ctPracNames[memberVal] || '';
    var participant = { member: { reference: memberVal, display: display || undefined } };
    if (roleVal) {
      participant.role = [{ coding: [{ code: roleVal, display: roleVal }] }];
    }
    _ctFormParticipants.push(participant);
    document.getElementById('f-add-member').selectedIndex = 0;
    document.getElementById('f-add-role').value = '';
    _ctRenderParticipantsList();
  };

  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = careTeamFromForm(t);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('CareTeam', resource) : fhirPut('CareTeam', t.id, resource);
    op.then(function(saved) { closeModal(); onSave(saved); })
      .catch(function(err) { btn.disabled = false; btn.textContent = 'Save'; alert('Error: ' + err.message); });
  };
}

// ── Care Teams ────────────────────────────────────────────────────────────────

var _ctSearchTimer = null;
var _ctPageSize    = 10;
var _ctPracNames   = {};  // practitioner id → display name, loaded once per page visit
var _ctPracRoles   = {};  // practitioner reference → role text, loaded once per page visit

function _ctQuery(search, pageSize) {
  var q = 'CareTeam?_count=' + pageSize + '&_sort=-_lastUpdated';
  if (search) q += '&name:contains=' + encodeURIComponent(search);
  return q;
}

function _ctTeamCard(team) {
  var participants = (team.participant || []).map(function(p) {
    var member = p.member || {};
    var ref    = member.reference || '';
    var bareId = ref.replace('Practitioner/', '');
    var memberText = member.display
      || _ctPracNames[bareId]
      || _ctPracNames[ref]
      || bareId
      || '—';
    var roleArr    = p.role && p.role[0];
    var roleCoding = roleArr && roleArr.coding && roleArr.coding[0];
    var roleText   = (roleCoding && (roleCoding.display || roleCoding.code)) || (roleArr && roleArr.text) || '—';
    return '<tr>' +
      '<td>' + esc(memberText) + '</td>' +
      '<td>' + esc(roleText) + '</td>' +
      '<td>' + (p.period && p.period.start ? fmtDate(p.period.start) : '—') + '</td>' +
      '</tr>';
  });
  var mgOrg = team.managingOrganization && team.managingOrganization[0];
  var memberCount = (team.participant || []).length;
  return '<article>' +
    '<details>' +
      '<summary>' +
        '<h3>' + esc(team.name || team.id) + '</h3>' +
        badge(team.status || 'unknown') +
        badge(memberCount + ' member' + (memberCount !== 1 ? 's' : ''), 'secondary') +
        (window.BKM_ROLE === 'admin'
          ? '<div style="margin-left:auto;display:flex;gap:8px" onclick="event.stopPropagation()">' +
              '<button class="btn btn-sm btn-outline ct-edit" data-id="' + esc(team.id) + '">Edit</button>' +
              '<button class="btn btn-sm btn-danger ct-del" data-id="' + esc(team.id) + '" data-name="' + esc(team.name || team.id) + '">Delete</button>' +
            '</div>'
          : '') +
      '</summary>' +
      '<p><strong>ID:</strong> <code>' + esc(team.id) + '</code></p>' +
      (mgOrg ? '<p><strong>Organization:</strong> ' + esc(mgOrg.display || mgOrg.reference) + '</p>' : '') +
      table(['Member', 'Role', 'Period'], participants, 'No participants.') +
    '</details>' +
    '</article>';
}

function _ctRenderCards(el, bundle, search, pageSize) {
  var teams   = entries(bundle).filter(function(r) { return r.resourceType === 'CareTeam'; });
  var total   = bundle.total !== undefined ? bundle.total : '?';
  var nextUrl = bundleLink(bundle, 'next');
  var prevUrl = bundleLink(bundle, 'previous');

  var pager =
    '<div class="pager">' +
      '<span class="pager-info">Showing ' + teams.length + ' of ' + total + '</span>' +
      '<div class="pager-btns">' +
        '<button class="btn btn-sm btn-outline" id="ct-prev"' + (prevUrl ? '' : ' disabled') + '>← Prev</button>' +
        '<button class="btn btn-sm btn-outline" id="ct-next"' + (nextUrl ? '' : ' disabled') + '>Next →</button>' +
      '</div>' +
    '</div>';

  document.getElementById('ct-data').innerHTML =
    (teams.length ? teams.map(_ctTeamCard).join('') : '<p>No care teams found.</p>') + pager;

  el.querySelectorAll('.ct-edit').forEach(function(btn) {
    btn.onclick = function() {
      fhir('CareTeam/' + btn.getAttribute('data-id')).then(function(t) {
        openCareTeamForm(t, function() { _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize); });
      });
    };
  });
  el.querySelectorAll('.ct-del').forEach(function(btn) {
    btn.onclick = function() {
      var tid = btn.getAttribute('data-id'), name = btn.getAttribute('data-name');
      showConfirm('Delete Care Team', 'Delete "' + name + '"?', function() {
        fhirDelete('CareTeam', tid).then(function() {
          closeModal(); _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize);
        }).catch(function(e) { alert('Error: ' + e.message); });
      });
    };
  });
  document.getElementById('ct-prev').onclick = function() {
    if (prevUrl) _ctLoadFull(el, prevUrl, search, pageSize);
  };
  document.getElementById('ct-next').onclick = function() {
    if (nextUrl) _ctLoadFull(el, nextUrl, search, pageSize);
  };
}

function _ctLoadPage(el, query, search, pageSize) {
  document.getElementById('ct-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhir(query)
    .then(function(b) { _ctRenderCards(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('ct-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function _ctLoadFull(el, url, search, pageSize) {
  document.getElementById('ct-data').innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>';
  fhirFull(url)
    .then(function(b) { _ctRenderCards(el, b, search, pageSize); })
    .catch(function(e) { document.getElementById('ct-data').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
}

function renderCareTeams(el) {
  var search   = '';
  var pageSize = _ctPageSize;

  el.innerHTML =
    '<div class="page-header">' +
      '<h2>Care Teams (BKM)</h2>' +
      '<input type="search" id="ct-search" placeholder="Search by name…" style="max-width:240px">' +
      '<select id="ct-pagesize" style="width:auto">' +
        [5,10,20,50].map(function(n) {
          return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + ' per page</option>';
        }).join('') +
      '</select>' +
      '<button class="btn btn-primary" id="ct-new">+ New Care Team</button>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="ct-data">Care Teams</button>' +
      '<button class="page-tab" data-tab="ct-help">? Help</button>' +
    '</div>' +
    '<div id="ct-data"></div>' +
    '<div id="ct-help" class="help-panel" hidden>' + careTeamsHelpHTML() + '</div>';

  wirePageTabs(el);

  Promise.all([
    fhir('Practitioner?_count=200').catch(function() { return { entry: [] }; }),
    fhir('PractitionerRole?_count=200').catch(function() { return { entry: [] }; })
  ]).then(function(results) {
    var pb = results[0], rb = results[1];
    _ctPracNames = {};
    entries(pb).forEach(function(p) {
      var n      = p.name && p.name[0];
      var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
      var family = n ? (n.family || '') : '';
      var name   = [given, family].filter(Boolean).join(' ') || p.id;
      _ctPracNames[p.id]                   = name;
      _ctPracNames['Practitioner/' + p.id] = name;
    });
    _ctPracRoles = {};
    entries(rb).forEach(function(pr) {
      var pracRef = pr.practitioner && pr.practitioner.reference;
      if (!pracRef) return;
      var code     = pr.code && pr.code[0] && pr.code[0].coding && pr.code[0].coding[0];
      var roleText = (code && (code.display || code.code)) || (pr.code && pr.code[0] && pr.code[0].text) || '';
      if (roleText) _ctPracRoles[pracRef] = roleText;
    });
    _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize);
  });

  if (window.BKM_ROLE !== 'admin') document.getElementById('ct-new').style.display = 'none';
  document.getElementById('ct-new').onclick = function() {
    openCareTeamForm(null, function() { _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize); });
  };
  document.getElementById('ct-pagesize').onchange = function() {
    pageSize = parseInt(this.value, 10);
    _ctPageSize = pageSize;
    _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize);
  };
  document.getElementById('ct-search').addEventListener('input', function(e) {
    clearTimeout(_ctSearchTimer);
    var val = e.target.value.trim();
    _ctSearchTimer = setTimeout(function() {
      search = val;
      _ctLoadPage(el, _ctQuery(search, pageSize), search, pageSize);
    }, 350);
  });
}
