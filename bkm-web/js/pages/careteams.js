/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/careteams.js (careTeamsHelpHTML, global).

// ── Care Team forms ───────────────────────────────────────────────────────────

var _ctFormParticipants = [];

function _ctRenderParticipantsList() {
  var listEl = document.getElementById('ct-participants-list');
  if (!listEl) return;
  if (!_ctFormParticipants.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:var(--dhis2-muted);margin:4px 0">No members yet.</p>';
  } else {
    listEl.innerHTML =
      `<table style="width:100%;margin-bottom:4px"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>` +
      _ctFormParticipants.map(function(p, idx) {
        var ref     = (p.member && p.member.reference) || '';
        var bareId  = ref.replace('Practitioner/', '');
        var display = (p.member && p.member.display) || _ctPracNames[bareId] || _ctPracNames[ref] || ref;
        var roleArr    = p.role && p.role[0];
        var roleCoding = roleArr && roleArr.coding && roleArr.coding[0];
        var roleText   = (roleCoding && (roleCoding.display || roleCoding.code)) || (roleArr && roleArr.text) || '—';
        return `<tr><td>${esc(display)}</td><td>${esc(roleText)}</td>` +
          `<td><button type="button" class="btn btn-sm btn-danger ct-rm-participant" data-idx="${idx}">Remove</button></td></tr>`;
      }).join('') +
      `</tbody></table>`;
  }
  listEl.querySelectorAll('.ct-rm-participant').forEach(function(btn) {
    btn.onclick = function() {
      _ctFormParticipants.splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
      _ctRenderParticipantsList();
    };
  });
}

function careTeamFormHtml(t) {
  var statusOpts = ['proposed','active','suspended','inactive','entered-in-error'].map(function(s) {
    return `<option value="${s}"${t && t.status === s ? ' selected' : ''}>${s}</option>`;
  }).join('');
  var memberOpts = Object.keys(_ctPracNames)
    .filter(function(k) { return k.indexOf('Practitioner/') !== 0; })
    .sort(function(a, b) { return (_ctPracNames[a] || a).localeCompare(_ctPracNames[b] || b); })
    .map(function(id) {
      return `<option value="Practitioner/${esc(id)}">${esc(_ctPracNames[id] || id)}</option>`;
    }).join('');
  return `
    <div class="form-row"><label>Team name</label>
      <input id="f-name" value="${esc(t && t.name || '')}"></div>
    <div class="form-row"><label>Status</label>
      <select id="f-status">${statusOpts}</select></div>
    <div class="form-row"><label>Description (optional)</label>
      <input id="f-desc" value="${esc(t && t.note && t.note[0] && t.note[0].text || '')}"></div>
    <div class="form-row" style="flex-direction:column;gap:6px">
      <label style="font-weight:600">Members</label>
      <div id="ct-participants-list"></div>
      <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:2;min-width:160px"><label style="font-size:12px;font-weight:400">Practitioner</label>
          <select id="f-add-member">
            <option value="">— select —</option>
            ${memberOpts}
          </select></div>
        <div style="flex:1;min-width:120px"><label style="font-size:12px;font-weight:400">Role</label>
          <input id="f-add-role" placeholder="supervisor / community-health-worker"></div>
        <button type="button" class="btn btn-outline" id="ct-add-participant" style="flex-shrink:0;align-self:flex-end">+ Add</button>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-outline" id="form-cancel">Cancel</button>
      <button class="btn btn-primary" id="form-save">Save</button>
    </div>`;
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
    return `<tr><td>${esc(memberText)}</td><td>${esc(roleText)}</td>` +
      `<td>${p.period && p.period.start ? fmtDate(p.period.start) : '—'}</td></tr>`;
  });
  var mgOrg = team.managingOrganization && team.managingOrganization[0];
  var memberCount = (team.participant || []).length;
  var adminActions = window.BKM_ROLE === 'admin'
    ? `<div style="margin-left:auto;display:flex;gap:8px" onclick="event.stopPropagation()">` +
        `<button class="btn btn-sm btn-outline ct-edit" data-id="${esc(team.id)}">Edit</button>` +
        `<button class="btn btn-sm btn-danger ct-del" data-id="${esc(team.id)}" data-name="${esc(team.name || team.id)}">Delete</button>` +
      `</div>`
    : '';
  return `<article><details>` +
      `<summary>` +
        `<h3>${esc(team.name || team.id)}</h3>` +
        badge(team.status || 'unknown') +
        badge(memberCount + ' member' + (memberCount !== 1 ? 's' : ''), 'secondary') +
        adminActions +
      `</summary>` +
      `<p><strong>ID:</strong> <code>${esc(team.id)}</code></p>` +
      (mgOrg ? `<p><strong>Organization:</strong> ${esc(mgOrg.display || mgOrg.reference)}</p>` : '') +
      table(['Member', 'Role', 'Period'], participants, 'No participants.') +
    `</details></article>`;
}

function renderCareTeams(el) {
  listPage({
    el: el,
    prefix: 'ct',
    title: 'Care Teams (BKM)',
    dataTabLabel: 'Care Teams',
    helpHTML: careTeamsHelpHTML(),
    searchPlaceholder: 'Search by name…',
    pageSize: _ctPageSize,
    onPageSize: function(n) { _ctPageSize = n; },
    canNew: window.BKM_ROLE === 'admin',
    newLabel: '+ New Care Team',
    onNew: function(reload) { openCareTeamForm(null, reload); },
    preload: function() {
      return Promise.all([
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
      });
    },
    query: function(search, pageSize) { return _ctQuery(search, pageSize); },
    items: function(bundle) { return entries(bundle).filter(function(r) { return r.resourceType === 'CareTeam'; }); },
    renderItem: _ctTeamCard,
    emptyText: 'No care teams found.',
    wireItems: function(dataEl, teams, reload) {
      dataEl.querySelectorAll('.ct-edit').forEach(function(btn) {
        btn.onclick = function() {
          fhir('CareTeam/' + btn.getAttribute('data-id')).then(function(t) { openCareTeamForm(t, reload); });
        };
      });
      dataEl.querySelectorAll('.ct-del').forEach(function(btn) {
        btn.onclick = function() {
          var tid = btn.getAttribute('data-id'), name = btn.getAttribute('data-name');
          showConfirm('Delete Care Team', 'Delete "' + name + '"?', function() {
            fhirDelete('CareTeam', tid).then(function() { closeModal(); reload(); })
              .catch(function(e) { alert('Error: ' + e.message); });
          });
        };
      });
    }
  });
}
