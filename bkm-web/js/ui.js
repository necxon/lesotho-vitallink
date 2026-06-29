/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

// ── UI helpers ───────────────────────────────────────────────────────────────

function loading(el) { el.innerHTML = '<p aria-busy="true">Loading…</p>'; }

function errMsg(el, msg) {
  el.innerHTML = '<article class="err"><strong>Error:</strong> ' + esc(msg) + '</article>';
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ptName(r) {
  if (!r) return '—';
  var n = r.name && r.name[0];
  if (!n) return r.id || '—';
  var given = Array.isArray(n.given) ? n.given.join(' ') : (n.given || '');
  var full = [given, n.family].filter(Boolean).join(' ');
  return full || r.id || '—';
}

function age(dob) {
  if (!dob) return '';
  var y = Math.floor((Date.now() - new Date(dob)) / 31557600000);
  return y + 'y';
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(s) {
  if (!s) return '—';
  var d = new Date(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function table(headers, rows, emptyMsg) {
  if (!rows.length) return '<p>' + (emptyMsg || 'No records found.') + '</p>';
  return '<div class="tbl-wrap"><table>' +
    '<thead><tr>' + headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + rows.join('') + '</tbody>' +
    '</table></div>';
}

function sortTh(label, col, sortState) {
  var active = sortState && sortState.col === col;
  var cls = 'sortable' + (active ? ' sort-' + (sortState.dir === 1 ? 'asc' : 'desc') : '');
  var arrow = '<span class="sort-arrow">' + (active ? (sortState.dir === 1 ? '▲' : '▼') : '⇅') + '</span>';
  return '<th class="' + cls + '" data-sort-col="' + col + '">' + label + arrow + '</th>';
}

function sortedRows(arr, sortState, getter) {
  if (!sortState || !sortState.col) return arr;
  return arr.slice().sort(function(a, b) {
    return (getter(a, sortState.col) || '').localeCompare(getter(b, sortState.col) || '') * sortState.dir;
  });
}

function wireSortHeaders(container, sortState, redraw) {
  container.querySelectorAll('th[data-sort-col]').forEach(function(th) {
    th.onclick = function() {
      var col = th.getAttribute('data-sort-col');
      if (sortState.col === col) { sortState.dir *= -1; } else { sortState.col = col; sortState.dir = 1; }
      redraw();
    };
  });
}

function badge(text, cls) {
  return '<span class="badge ' + esc(cls || '') + '">' + esc(text) + '</span>';
}

// ── Modal system ─────────────────────────────────────────────────────────────

function showModal(title, bodyHtml) {
  var modal = document.getElementById('modal');
  document.getElementById('modal-body').innerHTML =
    '<div class="modal-header">' +
      '<h3>' + esc(title) + '</h3>' +
      '<button class="modal-close" id="modal-close-btn">×</button>' +
    '</div>' +
    '<div class="modal-body">' + bodyHtml + '</div>';
  modal.hidden = false;
  document.getElementById('modal-close-btn').onclick = closeModal;
  modal.onclick = function(e) { if (e.target === modal) closeModal(); };
}

function closeModal() {
  document.getElementById('modal').hidden = true;
  document.getElementById('modal-body').innerHTML = '';
}

function showConfirm(title, msg, onConfirm) {
  showModal(title,
    '<div class="confirm-box">' +
      '<p>' + esc(msg) + '</p>' +
      '<div class="actions">' +
        '<button class="btn btn-outline" id="confirm-cancel">Cancel</button>' +
        '<button class="btn btn-danger" id="confirm-ok">Delete</button>' +
      '</div>' +
    '</div>'
  );
  document.getElementById('confirm-cancel').onclick = closeModal;
  document.getElementById('confirm-ok').onclick = onConfirm;
}

// ── Shared help-tab wiring ───────────────────────────────────────────────────
function wirePageTabs(el) {
  el.querySelectorAll('.page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      var tabs = tab.closest('.page-tabs');
      if (!tabs) return;
      var node = tabs.nextElementSibling;
      while (node) {
        if (node.id) node.hidden = (node.id !== target);
        node = node.nextElementSibling;
      }
    });
  });
}
