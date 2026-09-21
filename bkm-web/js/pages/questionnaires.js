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

/*
 * Forms the app expects but that are not on the server.
 *
 * The Composition is the manifest the phone downloads: every questionnaire it
 * publishes, the app will try to fetch. One that was never uploaded is invisible
 * here otherwise - this list only ever showed what DOES exist, so six missing
 * clinical forms looked exactly like six forms nobody had asked for.
 *
 * Compared by id against the list already fetched rather than probing each one,
 * so this costs a single extra request.
 */
function _qMissingBanner(qs, composition) {
  if (!composition) return '';
  var have = {};
  qs.forEach(function(q) { have[q.id] = true; });

  var missing = [];
  (composition.section || []).forEach(function(sec) {
    if (sec.title !== 'Questionnaires') return;
    (sec.section || []).forEach(function(sub) {
      var focus = sub.focus || {};
      var ref = focus.reference || '';
      var id = ref.split('/').pop();
      if (!id || have[id]) return;
      missing.push({
        name: (focus.identifier && focus.identifier.value) || sub.title || id,
        ref: ref,
      });
    });
  });

  if (!missing.length) return '';

  return '<div style="border-left:4px solid #ef6c00;background:#fff8f0;padding:12px 16px;margin-bottom:16px">' +
    '<strong style="color:#ef6c00">' + missing.length + ' form(s) the app expects are not on this server</strong>' +
    '<p style="margin:6px 0 0"><small>The app config publishes these to every phone, but they were never ' +
    'uploaded, so the phone downloads a menu pointing at forms it cannot fetch. They cannot be listed ' +
    'below, because they do not exist here.</small></p>' +
    '<ul style="margin:8px 0 0 18px;font-size:12px;color:#4a5768">' +
      missing.map(function(m) {
        return '<li><strong>' + esc(m.name) + '</strong> &mdash; <code>' + esc(m.ref) + '</code></li>';
      }).join('') +
    '</ul>' +
    '<p style="margin:8px 0 0"><small>Either import the missing forms, or remove them from the app ' +
    'config so the phone stops asking for them. <code>make test-menus</code> reports the same thing ' +
    'on the server.</small></p>' +
    '</div>';
}

function renderQuestionnaires(el) {
  loading(el);
  Promise.all([
    fhir('Questionnaire?_count=100&_sort=-_lastUpdated'),
    // Optional: the page is still useful without it, so a failure here must not
    // take the whole list down.
    fhir('Composition?identifier=app&_count=1').catch(function() { return null; }),
  ]).then(function(results) {
    var b = results[0];
    var compBundle = results[1];
    var composition = compBundle && entries(compBundle)[0];
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
        '<button class="page-tab" data-tab="q-nav">App Nav</button>' +
        '<button class="page-tab" data-tab="q-help">? Help</button>' +
      '</div>' +
      '<div id="q-data">' +
        _qMissingBanner(qs, composition) +
        // Open by default: this is the page's main content, not an aside, and
        // making people click to see the list they came for is a step for
        // nothing. The toggle stays so a long list can still be folded away.
        //
        // No manual arrow here. This <details> is not inside an <article>, so
        // the rule in style.css that hides the native disclosure marker does
        // not apply to it - a literal arrow in the label rendered a second one
        // next to the browser's own, pointing the wrong way once open.
        '<details open style="margin-bottom:12px">' +
          '<summary style="cursor:pointer;font-weight:600;padding:8px 0;user-select:none">Phone Menus (' + qs.length + ')</summary>' +
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
      // The app's side menu, on the same page as the forms it launches. A menu
      // item points at one of the questionnaires listed in the first tab, so
      // keeping them apart meant editing two pages to make one change.
      '<div id="q-nav" hidden></div>' +
      '<div id="q-help" class="help-panel" hidden>' + questionnairesHelpHTML() + navigationHelpHTML() + '</div>';

    wirePageTabs(el);

    // Mounted on first open rather than up front: it costs another two round
    // trips, and most visits to this page never touch the menu.
    var navMounted = false;
    function mountNavOnce() {
      if (navMounted) return;
      navMounted = true;
      mountNavPanel(document.getElementById('q-nav'));
    }
    var navTab = null;
    el.querySelectorAll('.page-tab').forEach(function(tab) {
      if (tab.getAttribute('data-tab') !== 'q-nav') return;
      navTab = tab;
      tab.addEventListener('click', mountNavOnce);
    });

    // #/questionnaires/nav opens straight onto the menu. That is where
    // #/navigation now lands, so an old bookmark still arrives at the menu
    // rather than at the forms list.
    if (navTab && /#\/questionnaires\/nav/.test(location.hash)) navTab.click();

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

/*
 * Fill / preview a Questionnaire, rendered by LHC-Forms.
 *
 * This is the "what does the health worker actually see" view. LHC-Forms
 * implements enableWhen, itemControl, calculated expressions, repeats and
 * initial values; the hand-rolled renderer this replaced implemented none of
 * them and drew every item unconditionally, so a form the phone shows as five
 * questions rendered here as twenty.
 *
 * It models the phone rather than being it - the phone runs the Android FHIR
 * SDK's SDC renderer, a different implementation of the same specification. It
 * is close enough to catch the mistakes that matter (a question that never
 * appears, a skip that does not fire) and honest about not being identical.
 */
function renderQFill(el, id) {
  loading(el);
  fhir('Questionnaire/' + esc(id)).then(function(q) {
    el.innerHTML =
      '<a href="#/questionnaires" class="back">← Phone Menus</a>' +
      '<article class="q-form">' +
        '<header><h2>' + esc(q.title || q.id) + '</h2>' +
          '<small>Rendered with LHC-Forms, which applies the same conditional logic the ' +
          'phone does. Questions appear and disappear as you answer.</small>' +
        '</header>' +
        '<div class="form-row"><label>Subject (optional — e.g. Patient/patient-001)</label>' +
          '<input id="q-subject" placeholder="Patient/id or leave blank">' +
        '</div>' +
        '<div id="lforms-container"><p><small>Loading the form renderer…</small></p></div>' +
        '<div class="q-actions">' +
          '<a href="#/questionnaires" class="btn btn-outline">Cancel</a>' +
          '<button class="btn btn-primary" id="q-submit" disabled>Submit</button>' +
        '</div>' +
        '<p id="q-msg"></p>' +
      '</article>';

    lformsRender(q, 'lforms-container').then(function() {
      document.getElementById('q-submit').disabled = false;
    }).catch(function(e) {
      // A form that will not render is itself the finding, so say which form
      // and why rather than leaving an empty panel.
      document.getElementById('lforms-container').innerHTML =
        '<div style="border-left:4px solid #c62828;background:#fafafa;padding:12px 16px">' +
        '<strong style="color:#c62828">This questionnaire did not render</strong>' +
        '<p><small>' + esc(e.message) + '</small></p>' +
        '<p><small>Run <code>make test-menus</code> to check every questionnaire at once.</small></p>' +
        '</div>';
    });

    document.getElementById('q-submit').onclick = function() {
      var btn = document.getElementById('q-submit');
      var msg = document.getElementById('q-msg');
      btn.disabled = true; btn.textContent = 'Submitting…';
      msg.innerHTML = '';

      var response;
      try {
        response = lformsResponse('lforms-container');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Submit';
        msg.innerHTML = '<small style="color:#c62828">Could not read the answers: ' + esc(e.message) + '</small>';
        return;
      }

      // LHC-Forms fills in the answers; the rest is what makes it a valid
      // QuestionnaireResponse on this server.
      response.status = 'completed';
      response.authored = new Date().toISOString();
      response.questionnaire = 'Questionnaire/' + q.id;

      var subj = document.getElementById('q-subject').value.trim();
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
        msg.innerHTML = '<small style="color:#c62828">' + esc(err.message) + '</small>';
      });
    };
  }).catch(function(e) { errMsg(el, e.message); });
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
