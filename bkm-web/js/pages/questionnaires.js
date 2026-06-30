/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// ── Questionnaire Builder ─────────────────────────────────────────────────────
// Inline oninput/onchange handlers update state directly — no re-render on type,
// so focus is never lost. Re-render only on structural changes (add/del/type-change).
// Supports 2-level nesting: top-level items + sub-questions inside 'group' items.

var Q_TYPES   = ['group','string','text','integer','decimal','date','dateTime','boolean','choice','display'];
var _qItems   = [];
var _qItemSeq = 0;

function _qNewItem(pfx) {
  _qItemSeq++;
  return { linkId: (pfx || 'q') + _qItemSeq, text: '', type: 'string', required: false, answerOption: [], children: [] };
}
function _qGet(ti, ci) {
  return (ci !== '' && ci !== undefined) ? _qItems[ti].children[parseInt(ci)] : _qItems[ti];
}

// Called via inline oninput — never re-renders, preserves focus
function _qText(el, ti, ci)    { _qGet(ti, ci).text = el.value; }
function _qReq(el, ti, ci)     { _qGet(ti, ci).required = el.checked; }
function _qOpt(el, ti, ci, oi) { _qGet(ti, ci).answerOption[oi] = { valueString: el.value }; }

// Called via onchange/onclick — may re-render
function _qType(el, ti, ci) {
  var item = _qGet(ti, ci);
  item.type = el.value;
  if (el.value === 'choice' && !item.answerOption.length) item.answerOption = [{ valueString: '' }];
  renderQBuilderItems();
}
function _qDel(ti, ci) {
  if (ci !== '') { _qItems[ti].children.splice(parseInt(ci), 1); }
  else           { _qItems.splice(ti, 1); }
  renderQBuilderItems();
}
function _qAddChild(ti) {
  _qItems[ti].children.push(_qNewItem(_qItems[ti].linkId + '-'));
  renderQBuilderItems();
}
function _qAddOpt(ti, ci) {
  _qGet(ti, ci).answerOption.push({ valueString: '' });
  renderQBuilderItems();
}
function _qDelOpt(ti, ci, oi) {
  _qGet(ti, ci).answerOption.splice(oi, 1);
  renderQBuilderItems();
}

function _qRowHtml(item, ti, ci) {
  var ciStr   = (ci !== undefined && ci >= 0) ? String(ci) : '';
  var isChild = ciStr !== '';
  var isGroup = item.type === 'group';
  var label   = isChild ? ((ti + 1) + '.' + (ci + 1)) : String(ti + 1);

  var typeOpts = Q_TYPES
    .filter(function(t) { return !isChild || t !== 'group'; })
    .map(function(t) {
      return '<option value="' + t + '"' + (item.type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

  var choiceHtml = '';
  if (item.type === 'choice') {
    choiceHtml = '<div class="qb-opts">' +
      (item.answerOption || []).map(function(opt, oi) {
        var v = opt.valueString || (opt.valueCoding && (opt.valueCoding.display || opt.valueCoding.code)) || '';
        return '<div class="qb-opt-row">' +
          '<input type="text" class="qb-opt" value="' + esc(v) + '" placeholder="Option ' + (oi + 1) + '"' +
          ' oninput="_qOpt(this,' + ti + ',\'' + ciStr + '\',' + oi + ')">' +
          '<button type="button" class="btn btn-sm btn-danger" onclick="_qDelOpt(' + ti + ',\'' + ciStr + '\',' + oi + ')">&times;</button>' +
        '</div>';
      }).join('') +
      '<button type="button" class="btn btn-sm btn-outline" onclick="_qAddOpt(' + ti + ',\'' + ciStr + '\')">+ Add option</button>' +
    '</div>';
  }

  return '<div class="qb-row' + (isChild ? ' qb-child' : '') + '">' +
    '<div class="qb-row-top">' +
      '<span class="qb-num' + (isGroup ? ' qb-num-group' : '') + '">' + label + '</span>' +
      '<input type="text" class="qb-text" value="' + esc(item.text || '') + '"' +
      ' placeholder="' + (isGroup ? 'Section title…' : 'Question text…') + '"' +
      ' oninput="_qText(this,' + ti + ',\'' + ciStr + '\')">' +
      '<select class="qb-type" onchange="_qType(this,' + ti + ',\'' + ciStr + '\')">' + typeOpts + '</select>' +
      (!isGroup && item.type !== 'display'
        ? '<label class="qb-req-lbl"><input type="checkbox"' + (item.required ? ' checked' : '') +
          ' onchange="_qReq(this,' + ti + ',\'' + ciStr + '\')"> Req</label>'
        : '') +
      '<button type="button" class="btn btn-sm btn-danger" onclick="_qDel(' + ti + ',\'' + ciStr + '\')">&times;</button>' +
    '</div>' +
    choiceHtml +
  '</div>';
}

function renderQBuilderItems() {
  var el = document.getElementById('qb-items');
  if (!el) return;
  if (!_qItems.length) {
    el.innerHTML = '<p class="qb-empty">No questions yet — click &ldquo;+ Add question&rdquo; below.</p>';
    return;
  }
  el.innerHTML = _qItems.map(function(item, ti) {
    var html = _qRowHtml(item, ti, -1);
    if (item.type === 'group') {
      html += '<div class="qb-children">' +
        (item.children || []).map(function(child, ci) { return _qRowHtml(child, ti, ci); }).join('') +
        '<button type="button" class="btn btn-sm btn-outline" style="margin:6px 0 2px" onclick="_qAddChild(' + ti + ')">+ Add sub-question</button>' +
      '</div>';
    }
    return '<div class="qb-wrap">' + html + '</div>';
  }).join('');
}

function _loadQItems(fhirItems, depth) {
  return (fhirItems || []).map(function(it) {
    var num = parseInt((it.linkId || '').replace(/\D/g, '') || '0');
    if (num > _qItemSeq) _qItemSeq = num;
    return {
      linkId:       it.linkId || ('q' + (++_qItemSeq)),
      text:         it.text    || '',
      type:         it.type    || 'string',
      required:     !!it.required,
      answerOption: (it.answerOption || []).map(function(o) {
        return { valueString: o.valueString || (o.valueCoding && (o.valueCoding.display || o.valueCoding.code)) || '' };
      }),
      children: depth < 1 ? _loadQItems(it.item, 1) : [],
    };
  });
}

function buildQuestionnaire(existing) {
  var r = Object.assign({}, existing || {}, { resourceType: 'Questionnaire' });
  r.title       = (document.getElementById('qb-title').value || '').trim();
  r.description = (document.getElementById('qb-desc').value  || '').trim() || undefined;
  r.status      = document.getElementById('qb-status').value;
  function toFhir(it) {
    var item = { linkId: it.linkId, text: it.text.trim(), type: it.type };
    if (it.required) item.required = true;
    if (it.type === 'choice') {
      item.answerOption = (it.answerOption || [])
        .filter(function(o) { return (o.valueString || '').trim(); })
        .map(function(o) { return { valueString: o.valueString.trim() }; });
    }
    if (it.type === 'group' && it.children && it.children.length) {
      item.item = it.children
        .filter(function(c) { return c.text.trim() || c.type === 'display'; })
        .map(toFhir);
    }
    return item;
  }
  r.item = _qItems
    .filter(function(it) { return it.text.trim() || it.type === 'display'; })
    .map(toFhir);
  return r;
}

// ── Questionnaire list ────────────────────────────────────────────────────────

// Static help panel lives in js/help/questionnaires.js (questionnairesHelpHTML, global).

var _qSort = { col: null, dir: 1 };
function _qVal(q, col) {
  if (col === 'title')  return q.title || q.id;
  if (col === 'status') return q.status || '';
  if (col === 'items')  return String((q.item || []).length);
  return '';
}

function renderQuestionnaires(el) {
  loading(el);
  fhir('Questionnaire?_count=100&_sort=-_lastUpdated').then(function(b) {
    var qs = entries(b);
    el.innerHTML =
      '<div class="page-header">' +
        '<h2>Phone Menus (BKM) ' + badge(qs.length) + '</h2>' +
        '<span style="display:flex;gap:8px">' +
          '<a class="btn btn-outline" href="https://formbuilder.nlm.nih.gov/#" target="_blank" rel="noopener" ' +
            'title="NLM Form Builder — design a FHIR Questionnaire visually, export it as FHIR R4 JSON, then Import it here.">&#128295; Form Builder &#8599;</a>' +
          '<button class="btn btn-outline" id="q-import">&#8593; Import JSON</button>' +
          '<button class="btn btn-primary" id="q-new">+ New Phone Menu</button>' +
        '</span>' +
      '</div>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="q-data">Phone Menus</button>' +
        '<button class="page-tab" data-tab="q-help">? Help</button>' +
      '</div>' +
      '<div id="q-data">' +
        '<details style="margin-bottom:12px">' +
          '<summary style="cursor:pointer;font-weight:600;padding:8px 0;user-select:none">Phone Menus (' + qs.length + ') ▶</summary>' +
          (function() {
            var sorted = sortedRows(qs, _qSort, _qVal);
            if (!sorted.length) return '<p>No phone menus yet. Click &ldquo;+ New Phone Menu&rdquo; to create one.</p>';
            return '<div class="tbl-wrap"><table><thead><tr>' +
              sortTh('Title','title',_qSort) + sortTh('Status','status',_qSort) + sortTh('Items','items',_qSort) + '<th></th>' +
              '</tr></thead><tbody>' +
              sorted.map(function(q) {
                var count = (q.item || []).length;
                return '<tr>' +
                  '<td><strong>' + esc(q.title || q.id) + '</strong></td>' +
                  '<td>' + badge(q.status || 'unknown', q.status === 'active' ? 'green' : '') + '</td>' +
                  '<td>' + esc(count) + ' top-level</td>' +
                  '<td style="white-space:nowrap">' +
                    '<a href="#/questionnaires/fill/' + esc(q.id) + '" class="btn btn-sm btn-primary">Fill</a> ' +
                    '<a href="#/questionnaires/responses/' + esc(q.id) + '" class="btn btn-sm btn-outline">Responses</a> ' +
                    (window.BKM_ROLE === 'admin'
                      ? '<button class="btn btn-sm btn-outline q-edit" data-id="' + esc(q.id) + '">Edit</button> ' +
                        '<button class="btn btn-sm btn-danger q-del" data-id="' + esc(q.id) + '" data-name="' + esc(q.title || q.id) + '">Del</button>'
                      : '') +
                  '</td>' +
                  '</tr>';
              }).join('') + '</tbody></table></div>';
          })() +
        '</details>' +
      '</div>' +
      '<div id="q-help" class="help-panel" hidden>' + questionnairesHelpHTML() + '</div>';

    wirePageTabs(el);

    wireSortHeaders(el, _qSort, function() { renderQuestionnaires(el); });

    if (window.BKM_ROLE !== 'admin') {
      document.getElementById('q-new').style.display = 'none';
      document.getElementById('q-import').style.display = 'none';
    }
    document.getElementById('q-new').onclick = function() { openQEditor(null, el); };
    document.getElementById('q-import').onclick = function() { openQImport(el); };

    el.querySelectorAll('.q-edit').forEach(function(btn) {
      btn.onclick = function() {
        fhir('Questionnaire/' + btn.getAttribute('data-id')).then(function(q) {
          openQEditor(q, el);
        });
      };
    });

    el.querySelectorAll('.q-del').forEach(function(btn) {
      btn.onclick = function() {
        var qid  = btn.getAttribute('data-id');
        var name = btn.getAttribute('data-name');
        showConfirm('Delete Form', 'Delete "' + name + '"?', function() {
          fhirDelete('Questionnaire', qid).then(function() {
            closeModal(); renderQuestionnaires(el);
          }).catch(function(e) { alert('Error: ' + e.message); });
        });
      };
    });
  }).catch(function(e) { errMsg(el, e.message); });
}

// ── Import a FHIR Questionnaire (paste JSON or upload a file) ──────────────────

// R5 → R4 compatibility fixups so a Questionnaire from either version imports into
// the R4 HAPI server: R5 renamed item type "choice" → "coding"; map it back, and
// drop an R5 meta.profile (HAPI R4 rejects the .../5.0/... profile on validation).
function _qSanitizeR4(res) {
  if (res.meta && res.meta.profile) delete res.meta.profile;
  (function walk(items) {
    (items || []).forEach(function(it) {
      if (it.type === 'coding') it.type = 'choice';
      if (it.item) walk(it.item);
    });
  })(res.item);
  return res;
}

function openQImport(parentEl) {
  showModal('Import FHIR Questionnaire',
    '<p style="font-size:12px;color:#4a5768;margin:0 0 10px">Paste a FHIR <code>Questionnaire</code> JSON, or choose a <code>.json</code> file. ' +
      'R5 forms are auto-converted to R4 (item type <code>coding</code>&rarr;<code>choice</code>). It is upserted to HAPI by its <code>id</code>.</p>' +
    '<div class="form-row">' +
      '<textarea id="qimp-json" rows="11" style="width:100%;font-family:monospace;font-size:12px" placeholder=\'{ "resourceType": "Questionnaire", "id": "...", "title": "...", "item": [ ... ] }\'></textarea>' +
    '</div>' +
    '<div class="form-row"><label>…or choose a file</label>' +
      '<input type="file" id="qimp-file" accept=".json,application/json,application/fhir+json"></div>' +
    '<p id="qimp-msg" style="font-size:12px;min-height:18px;margin:4px 0;color:#6b7a8d"></p>' +
    '<div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn btn-outline" id="qimp-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="qimp-go">Import</button>' +
    '</div>'
  );
  var ta  = document.getElementById('qimp-json');
  var msg = document.getElementById('qimp-msg');
  function say(text, err) { msg.style.color = err ? '#c62828' : '#6b7a8d'; msg.textContent = text; }

  document.getElementById('qimp-file').onchange = function(e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function(ev) { ta.value = ev.target.result; say('Loaded ' + f.name); };
    r.readAsText(f);
  };
  document.getElementById('qimp-cancel').onclick = closeModal;
  document.getElementById('qimp-go').onclick = function() {
    var raw = (ta.value || '').trim();
    if (!raw) { say('Paste JSON or choose a file first.', true); return; }
    var res;
    try { res = JSON.parse(raw); } catch (err) { say('Invalid JSON: ' + err.message, true); return; }
    if (!res || res.resourceType !== 'Questionnaire') {
      say('Not a Questionnaire — "resourceType" must be "Questionnaire".', true); return;
    }
    _qSanitizeR4(res);
    var go = document.getElementById('qimp-go'); go.disabled = true; say('Importing…');
    var p = res.id ? fhirPut('Questionnaire', res.id, res) : fhirPost('Questionnaire', res);
    p.then(function() { closeModal(); renderQuestionnaires(parentEl); })
     .catch(function(e) { go.disabled = false; say('Import failed: ' + (e.message || e), true); });
  };
}

// ── Questionnaire Form Builder ────────────────────────────────────────────────

function openQEditor(q, parentEl) {
  var isNew = !q;
  _qItemSeq = 0;

  // Load existing items (with nested children), or seed one blank question for new forms
  var seedItems = (q && q.item && q.item.length) ? q.item : [{ linkId: 'q1', text: '', type: 'string', required: false }];
  _qItems = _loadQItems(seedItems, 0);

  var statusVal  = (q && q.status) || 'active';
  var statusOpts = ['draft','active','retired'].map(function(s) {
    return '<option value="' + s + '"' + (statusVal === s ? ' selected' : '') + '>' + s + '</option>';
  }).join('');

  showModal(isNew ? 'New Phone Menu' : 'Edit: ' + (q.title || q.id),
    '<div class="form-row">' +
      '<label>Form title <span style="color:#c62828">*</span></label>' +
      '<input id="qb-title" value="' + esc(q && q.title || '') + '" placeholder="e.g. Malaria Screening">' +
    '</div>' +
    '<div class="form-row">' +
      '<label>Description</label>' +
      '<input id="qb-desc" value="' + esc(q && q.description || '') + '" placeholder="Optional">' +
    '</div>' +
    '<div class="form-row">' +
      '<label>Status</label>' +
      '<select id="qb-status">' + statusOpts + '</select>' +
    '</div>' +
    '<div class="qb-section-title">Questions</div>' +
    '<div id="qb-items"></div>' +
    '<button type="button" class="btn btn-outline" id="qb-add" style="margin-top:8px">+ Add question</button>' +
    '<div id="qb-err" style="color:#c62828;font-size:12px;margin-top:6px"></div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );

  // Widen modal for the builder
  document.querySelector('.modal-box').style.width = '700px';

  renderQBuilderItems();

  document.getElementById('form-cancel').onclick = closeModal;

  document.getElementById('qb-add').onclick = function() {
    _qItems.push(_qNewItem());
    renderQBuilderItems();
  };

  document.getElementById('form-save').onclick = function() {
    var resource = buildQuestionnaire(q);
    var errEl = document.getElementById('qb-err');
    if (!resource.title) { errEl.textContent = 'Form title is required.'; return; }
    errEl.textContent = '';
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    var op = isNew ? fhirPost('Questionnaire', resource) : fhirPut('Questionnaire', q.id, resource);
    op.then(function() { closeModal(); renderQuestionnaires(parentEl); })
      .catch(function(err) {
        btn.disabled = false; btn.textContent = 'Save';
        errEl.textContent = 'Error: ' + err.message;
      });
  };
}

// ── Questionnaire form renderer ───────────────────────────────────────────────

function renderQFill(el, id) {
  loading(el);
  fhir('Questionnaire/' + esc(id)).then(function(q) {
    el.innerHTML =
      '<a href="#/questionnaires" class="back">← Phone Menus</a>' +
      '<article class="q-form">' +
        '<header><h2>' + esc(q.title || q.id) + '</h2></header>' +
        '<div class="form-row"><label>Subject (optional — e.g. Patient/patient-001)</label>' +
          '<input id="q-subject" placeholder="Patient/id or leave blank">' +
        '</div>' +
        renderQItems(q.item || []) +
        '<div class="q-actions">' +
          '<a href="#/questionnaires" class="btn btn-outline">Cancel</a>' +
          '<button class="btn btn-primary" id="q-submit">Submit</button>' +
        '</div>' +
      '</article>';

    document.getElementById('q-submit').onclick = function() {
      var btn = document.getElementById('q-submit');
      btn.disabled = true; btn.textContent = 'Submitting…';
      var subj = document.getElementById('q-subject').value.trim();
      var response = {
        resourceType: 'QuestionnaireResponse',
        questionnaire: 'Questionnaire/' + q.id,
        status: 'completed',
        authored: new Date().toISOString(),
        item: collectQAnswers(q.item || []),
      };
      if (subj) response.subject = { reference: subj };
      fhirPost('QuestionnaireResponse', response).then(function() {
        el.innerHTML =
          '<a href="#/questionnaires" class="back">← Phone Menus</a>' +
          '<article><p>✅ Response submitted.</p>' +
            '<a href="#/questionnaires/fill/' + esc(id) + '" class="btn btn-primary">Fill again</a> ' +
            '<a href="#/questionnaires/responses/' + esc(id) + '" class="btn btn-outline">View responses</a>' +
          '</article>';
      }).catch(function(err) {
        btn.disabled = false; btn.textContent = 'Submit';
        alert('Error: ' + err.message);
      });
    };
  }).catch(function(e) { errMsg(el, e.message); });
}

function renderQItems(items) {
  return (items || []).map(function(item) {
    var fid = 'qf-' + item.linkId.replace(/[^a-zA-Z0-9]/g, '_');
    if (item.type === 'group') {
      return '<div class="q-group">' +
        '<div class="q-group-title">' + esc(item.text || '') + '</div>' +
        renderQItems(item.item || []) +
        '</div>';
    }
    if (item.type === 'display') {
      return '<div class="q-item"><div class="q-display">' + esc(item.text || '') + '</div></div>';
    }
    var req = item.required ? '<span class="required">*</span>' : '';
    return '<div class="q-item" data-linkid="' + esc(item.linkId) + '">' +
      '<label for="' + fid + '">' + esc(item.text || item.linkId) + req + '</label>' +
      renderQInput(item, fid) +
      '</div>';
  }).join('');
}

function renderQInput(item, fid) {
  var t = item.type;
  if (t === 'boolean') {
    return '<div class="q-bool"><input type="checkbox" id="' + fid + '"><label for="' + fid + '">Yes</label></div>';
  }
  if (t === 'choice' || t === 'open-choice') {
    var opts = (item.answerOption || []).map(function(opt) {
      var val  = (opt.valueCoding && (opt.valueCoding.display || opt.valueCoding.code)) || opt.valueString || '';
      var code = (opt.valueCoding && opt.valueCoding.code) || opt.valueString || val;
      return '<option value="' + esc(String(code)) + '">' + esc(String(val)) + '</option>';
    });
    return '<select id="' + fid + '"><option value="">-- select --</option>' + opts.join('') + '</select>';
  }
  if (t === 'text')          return '<textarea id="' + fid + '"></textarea>';
  if (t === 'integer')       return '<input type="number" step="1" id="' + fid + '">';
  if (t === 'decimal')       return '<input type="number" step="0.01" id="' + fid + '">';
  if (t === 'date')          return '<input type="date" id="' + fid + '">';
  if (t === 'dateTime')      return '<input type="datetime-local" id="' + fid + '">';
  if (t === 'time')          return '<input type="time" id="' + fid + '">';
  return '<input type="text" id="' + fid + '">';
}

function collectQAnswers(items) {
  var result = [];
  (items || []).forEach(function(item) {
    if (item.type === 'display') return;
    if (item.type === 'group') {
      result.push({ linkId: item.linkId, text: item.text, item: collectQAnswers(item.item || []) });
      return;
    }
    var fid = 'qf-' + item.linkId.replace(/[^a-zA-Z0-9]/g, '_');
    var el2 = document.getElementById(fid);
    if (!el2) return;
    var answer = null;
    var t = item.type;
    if (t === 'boolean') {
      answer = { valueBoolean: el2.checked };
    } else if (t === 'integer') {
      if (el2.value !== '') answer = { valueInteger: parseInt(el2.value, 10) };
    } else if (t === 'decimal') {
      if (el2.value !== '') answer = { valueDecimal: parseFloat(el2.value) };
    } else if (t === 'date') {
      if (el2.value) answer = { valueDate: el2.value };
    } else if (t === 'dateTime') {
      if (el2.value) answer = { valueDateTime: el2.value + ':00' };
    } else if (t === 'choice' || t === 'open-choice') {
      if (el2.value) answer = { valueCoding: { code: el2.value } };
    } else {
      if (el2.value.trim()) answer = { valueString: el2.value.trim() };
    }
    if (answer) result.push({ linkId: item.linkId, text: item.text, answer: [answer] });
  });
  return result;
}

// ── QuestionnaireResponse list ────────────────────────────────────────────────

function renderQResponses(el, qid) {
  loading(el);
  fhir('Questionnaire/' + esc(qid)).then(function(q) {
    return fhir('QuestionnaireResponse?questionnaire=Questionnaire/' + esc(qid) + '&_count=100&_sort=-_lastUpdated')
      .then(function(b) {
        var responses = entries(b);
        el.innerHTML =
          '<a href="#/questionnaires" class="back">← Phone Menus</a>' +
          '<div class="page-header">' +
            '<h2>' + esc(q.title || qid) + ' — Responses ' + badge(responses.length) + '</h2>' +
            '<a href="#/questionnaires/fill/' + esc(qid) + '" class="btn btn-primary">+ Fill Phone Menu</a>' +
          '</div>' +
          table(
            ['Submitted', 'Subject', 'Status', ''],
            responses.map(function(r) {
              var subj = (r.subject && r.subject.reference) || '—';
              return '<tr>' +
                '<td>' + fmtDate(r.authored) + '</td>' +
                '<td>' + esc(subj) + '</td>' +
                '<td>' + badge(r.status || 'unknown', r.status === 'completed' ? 'green' : '') + '</td>' +
                '<td>' +
                  '<button class="btn btn-sm btn-outline qr-view" data-id="' + esc(r.id) + '">View</button> ' +
                  '<button class="btn btn-sm btn-danger qr-del" data-id="' + esc(r.id) + '">Del</button>' +
                '</td>' +
                '</tr>';
            }),
            'No responses yet.'
          );

        el.querySelectorAll('.qr-view').forEach(function(btn) {
          btn.onclick = function() {
            fhir('QuestionnaireResponse/' + btn.getAttribute('data-id')).then(function(r) {
              showModal('Response — ' + fmtDate(r.authored),
                '<div class="modal-body"><pre style="font-size:11px;overflow:auto;max-height:400px">' +
                  esc(JSON.stringify(r, null, 2)) +
                '</pre></div>'
              );
            });
          };
        });

        el.querySelectorAll('.qr-del').forEach(function(btn) {
          btn.onclick = function() {
            var rid = btn.getAttribute('data-id');
            showConfirm('Delete Response', 'Delete this response?', function() {
              fhirDelete('QuestionnaireResponse', rid).then(function() {
                closeModal(); renderQResponses(el, qid);
              }).catch(function(e) { alert('Error: ' + e.message); });
            });
          };
        });
      });
  }).catch(function(e) { errMsg(el, e.message); });
}
