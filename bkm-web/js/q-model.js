/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// ── Questionnaire builder model ───────────────────────────────────────────────
// Pure logic behind the phone-menu builder (no DOM), so it can be unit tested in
// node: `make test-web`.
//
// The builder only edits a handful of fields per item (text, type, required,
// answer options). A real Questionnaire carries much more - enableWhen,
// extensions such as itemControl, initial values, calculated expressions - and
// the builder used to rebuild every item from scratch, so opening a form and
// pressing Save silently deleted all of it. Each builder item therefore keeps the
// FHIR item it came from in `raw`, and building starts from that and overlays
// only what the builder owns.

var Q_TYPES = ['group','string','text','integer','decimal','date','dateTime','boolean','choice','display'];

// Fields the builder owns. Everything else on an item rides through in `raw`.
var Q_OWNED = { linkId: 1, text: 1, type: 1, required: 1, answerOption: 1, item: 1 };

function qNewItem(seq, pfx) {
  return { linkId: (pfx || 'q') + seq, text: '', type: 'string', required: false, answerOption: [], children: [], raw: {}, rawSub: null };
}

function _qNum(linkId) {
  var m = String(linkId || '').match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : 0;
}

// Load FHIR items into builder items. The UI edits two levels (sections and the
// questions inside them); anything nested deeper is kept verbatim in `rawSub`
// rather than being dropped. Returns the highest numeric linkId suffix seen via
// `seen.max` so new ids never collide with loaded ones.
function qLoadItems(fhirItems, depth, seen) {
  seen = seen || { max: 0 };
  return (fhirItems || []).map(function(it) {
    var n = _qNum(it.linkId);
    if (n > seen.max) seen.max = n;
    var raw = {};
    Object.keys(it).forEach(function(k) { if (!Q_OWNED[k]) raw[k] = it[k]; });
    var nested = it.item || [];
    return {
      linkId:       it.linkId || ('q' + (++seen.max)),
      text:         it.text || '',
      type:         it.type || 'string',
      required:     !!it.required,
      answerOption: JSON.parse(JSON.stringify(it.answerOption || [])),
      children:     depth < 1 ? qLoadItems(nested, 1, seen) : [],
      raw:          raw,
      rawSub:       depth >= 1 && nested.length ? JSON.parse(JSON.stringify(nested)) : null,
    };
  });
}

function qOptionLabel(opt) {
  if (!opt) return '';
  return opt.valueString || (opt.valueCoding && (opt.valueCoding.display || opt.valueCoding.code)) || '';
}

// Edit an option's label without discarding its code/system when it is coded.
function qSetOptionLabel(opt, label) {
  if (opt && opt.valueCoding) { opt.valueCoding.display = label; return opt; }
  return { valueString: label };
}

function _qToFhir(it) {
  var item = JSON.parse(JSON.stringify(it.raw || {}));
  item.linkId = it.linkId;
  item.text = (it.text || '').trim();
  item.type = it.type;
  if (it.required && it.type !== 'group' && it.type !== 'display') item.required = true;
  else delete item.required;

  if (it.type !== 'choice') delete item.answerValueSet; // a value set only means something on a choice
  if (it.type === 'choice') {
    var opts = (it.answerOption || []).filter(function(o) { return qOptionLabel(o).trim(); })
      .map(function(o) {
        if (o.valueString !== undefined) return { valueString: o.valueString.trim() };
        return o;
      });
    if (opts.length) item.answerOption = opts;
  }
  if (it.type === 'group') {
    var kids = (it.children || [])
      .filter(function(c) { return (c.text || '').trim() || c.type === 'display'; })
      .map(_qToFhir);
    if (kids.length) item.item = kids;
    else if (it.rawSub) item.item = it.rawSub;
  } else if (it.rawSub) {
    item.item = it.rawSub;
  }
  return item;
}

function qBuildItems(items) {
  return (items || [])
    .filter(function(it) { return (it.text || '').trim() || it.type === 'display'; })
    .map(_qToFhir);
}

// Returns a list of { path, msg } problems that would produce a form the phone
// cannot use. Blocking ones are errors; the rest are warnings.
function qValidate(title, items) {
  var problems = [];
  if (!(title || '').trim()) problems.push({ level: 'error', path: 'title', msg: 'Form title is required.' });

  var seen = {};
  var any = false;
  (items || []).forEach(function(it, ti) {
    var where = 'Item ' + (ti + 1);
    if (it.type !== 'group' || it.children.length) any = true;
    check(it, where);
    if (it.type === 'group') {
      if (!it.children.length) problems.push({ level: 'warn', path: where, msg: where + ' is an empty section.' });
      it.children.forEach(function(c, ci) { check(c, where + '.' + (ci + 1)); });
    }
  });
  if (!any) problems.push({ level: 'error', path: 'items', msg: 'Add at least one question.' });

  function check(it, where) {
    if (seen[it.linkId]) problems.push({ level: 'error', path: where, msg: where + ': linkId "' + it.linkId + '" is used more than once.' });
    seen[it.linkId] = true;
    if (!(it.text || '').trim() && it.type !== 'display') {
      problems.push({ level: 'warn', path: where, msg: where + ' has no text and will be dropped on save.' });
    }
    if (it.type === 'choice') {
      var labels = (it.answerOption || []).map(function(o) { return qOptionLabel(o).trim(); }).filter(Boolean);
      if (!labels.length && !(it.raw && (it.raw.answerValueSet || it.raw.answerConstraint))) problems.push({ level: 'error', path: where, msg: where + ' is a choice with no options.' });
      var dup = {};
      labels.forEach(function(l) {
        if (dup[l.toLowerCase()]) problems.push({ level: 'warn', path: where, msg: where + ' has the option "' + l + '" twice.' });
        dup[l.toLowerCase()] = true;
      });
    }
  }
  return problems;
}

// Reorder within an array; returns true if it moved.
function qMove(arr, i, delta) {
  var j = i + delta;
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return false;
  var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  return true;
}

// Deep copy of an item with fresh linkIds (children too) so it can sit beside
// the original. `nextSeq()` supplies the numbers.
function qDuplicate(it, nextSeq, parentId) {
  var copy = JSON.parse(JSON.stringify(it));
  copy.linkId = (parentId ? parentId + '-' : 'q') + nextSeq();
  copy.text = copy.text ? copy.text + ' (copy)' : '';
  copy.children = (it.children || []).map(function(c) { return qDuplicate(c, nextSeq, copy.linkId); });
  if (copy.raw) delete copy.raw.enableWhen; // a copy must not inherit a skip rule aimed at the original
  return copy;
}

// Skip rules point at linkIds. Deleting an item leaves any enableWhen that names
// it dangling, which the phone treats as never-shown. Report who is affected.
function qDependents(items, linkId) {
  var out = [];
  (function walk(list) {
    (list || []).forEach(function(it) {
      ((it.raw && it.raw.enableWhen) || []).forEach(function(w) {
        if (w.question === linkId) out.push(it.linkId);
      });
      walk(it.children);
    });
  })(items);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Q_TYPES: Q_TYPES, qNewItem: qNewItem, qLoadItems: qLoadItems, qBuildItems: qBuildItems,
    qValidate: qValidate, qMove: qMove, qDuplicate: qDuplicate, qDependents: qDependents,
    qOptionLabel: qOptionLabel, qSetOptionLabel: qSetOptionLabel,
  };
}
