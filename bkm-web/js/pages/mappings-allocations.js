/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Per-VHW stock allocation feature for the Staff Management page (#/mappings).
// Split out of mappings.js. renderMappings (mappings.js) calls into the globals
// defined here (_myFacilityId, openAllocateForm, renderAllocationsInto, ...).

var _allocSort  = { col: null, dir: 1 };
var _allocCache = { rows: [], performers: {}, period: '', containerId: null };

// ── Per-VHW stock allocation ──────────────────────────────────────────────────
function allocateStock(body) {
  return mediatorFetch('aggregate/stock/allocate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(r) {
    if (!r.ok) return r.json().then(function(d) { throw new Error(d.message || r.statusText); });
    return r.json();
  });
}

// Resolves the logged-in user's facility by matching their Keycloak id (token.sub)
// to a performer's id/alias in the staff map. Used to scope a facility worker's view.
function _myFacilityId(performers) {
  var sub = (typeof kc !== 'undefined' && kc.tokenParsed && kc.tokenParsed.sub) || null;
  if (!sub) return null;
  var ref = 'Practitioner/' + sub;
  var ids = Object.keys(performers || {});
  for (var i = 0; i < ids.length; i++) {
    var p = performers[ids[i]] || {};
    if (ids[i] === ref || ids[i] === sub || (p.aliases && p.aliases.indexOf(ref) >= 0)) {
      return p.facilityId || null;
    }
  }
  return null;
}

function fetchAllocations() {
  return mediatorFetch('aggregate/stock/allocations').then(function(r) { return r.json(); });
}

// Clears all allocations for the current period (mediator DELETE).
function clearAllocations() {
  return mediatorFetch('aggregate/stock/allocations', { method: 'DELETE' }).then(function(r) {
    if (!r.ok) return r.json().then(function(d) { throw new Error(d.message || r.statusText); });
    return r.json();
  });
}

// Builds <option>s for the allocate dropdown — ONE per orderable, even when a medicine
// has several aliases (e.g. "Amoxicillin 250mg" + "AMOX250" both map to one UUID).
// Prefers a human-readable alias (one with a space or lowercase) as the label; the value
// is still a valid alias, so resolveOrderableId on the mediator matches it.
function medicationOptions(medications) {
  var chosen = {}; // orderableId -> chosen alias code
  Object.keys(medications)
    .filter(function(code) { return !/^[a-z0-9]+$/.test(code); }) // skip normalised lowercase dupes
    .forEach(function(code) {
      var oid = medications[code];
      if (!oid) return;
      var readable = /[ a-z]/.test(code);
      var curReadable = chosen[oid] ? /[ a-z]/.test(chosen[oid]) : false;
      if (!chosen[oid] || (readable && !curReadable)) chosen[oid] = code;
    });
  return Object.keys(chosen)
    .map(function(oid) { return chosen[oid]; })
    .sort()
    .map(function(code) { return '<option value="' + esc(code) + '">' + esc(code) + '</option>'; })
    .join('');
}

function openAllocateForm(vhwId, vhw, medications, onDone) {
  var name = (vhw && vhw.name) || vhwId;
  showModal('Allocate Stock to VHW',
    '<div class="modal-body">' +
      '<p style="font-size:12px;color:#4a5768;margin:0 0 12px">' +
        'Assign a per-month budget of a medicine to <strong>' + esc(name) + '</strong>. ' +
        'The VHW can only dispense up to what they are allocated this period (once enforcement is on). ' +
        'Facility stock is the ceiling — you cannot allocate more than is on hand.' +
      '</p>' +
      '<div class="form-row"><label>VHW</label>' +
        '<input value="' + esc(name) + '" readonly style="background:#f5f5f5"></div>' +
      '<div class="form-row"><label>Medicine</label>' +
        '<select id="al-med"><option value="">— select —</option>' + medicationOptions(medications) + '</select></div>' +
      '<div class="form-row"><label>Lot / Batch <small style="color:#6b7a8d">(optional — use the batch expiring soonest first)</small></label>' +
        '<select id="al-lot"><option value="">— select a medicine first —</option></select></div>' +
      '<div class="form-row"><label>Quantity</label>' +
        '<input id="al-qty" type="number" min="1" placeholder="e.g. 50"></div>' +
      '<div id="al-result" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:12px"></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="al-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="al-save">Allocate</button>' +
      '</div>' +
    '</div>'
  );

  document.getElementById('al-cancel').onclick = closeModal;

  // When a medicine is picked, load its OpenLMIS lots (batches) into the Lot dropdown.
  document.getElementById('al-med').onchange = function() {
    var med = this.value;
    var lotSel = document.getElementById('al-lot');
    if (!med) { lotSel.innerHTML = '<option value="">— select a medicine first —</option>'; return; }
    lotSel.innerHTML = '<option value="">Loading lots…</option>';
    mediatorFetch('aggregate/stock/lots?medication=' + encodeURIComponent(med))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var lots = (d && d.lots) || [];   // FEFO order from the mediator: earliest expiry first
        lotSel.innerHTML = '<option value="">— none / not specified —</option>' +
          lots.map(function(l, i) {
            var label = esc(l.lotCode || l.id) + (l.expirationDate ? ' (exp ' + esc(l.expirationDate) + ')' : '') +
                        (i === 0 ? '  ← expiring soonest, use first' : '');
            // Pre-select the soonest-to-expire batch to nudge first-expiry-first-out.
            return '<option value="' + esc(l.lotCode || '') + '"' + (i === 0 ? ' selected' : '') + '>' + label + '</option>';
          }).join('');
        if (!lots.length) lotSel.innerHTML = '<option value="">— no lots recorded for this medicine —</option>';
      })
      .catch(function() { lotSel.innerHTML = '<option value="">— could not load lots —</option>'; });
  };

  document.getElementById('al-save').onclick = function() {
    var medication = document.getElementById('al-med').value;
    var lotCode    = document.getElementById('al-lot').value || null;
    var quantity   = parseInt(document.getElementById('al-qty').value, 10);
    var resultEl   = document.getElementById('al-result');
    if (!medication)              { alert('Select a medicine'); return; }
    if (!quantity || quantity <= 0) { alert('Enter a positive quantity'); return; }

    var btn = document.getElementById('al-save');
    btn.disabled = true; btn.textContent = 'Allocating…';
    allocateStock({ vhwId: vhwId, medication: medication, quantity: quantity, lotCode: lotCode })
      .then(function(d) {
        resultEl.style.display = 'block';
        resultEl.style.background = '#edf7ed';
        resultEl.style.border = '1px solid #a3d9a5';
        resultEl.innerHTML = 'Allocated. <b>' + esc(medication) + '</b> for ' + esc(name) +
          ' — allocated <b>' + d.allocatedQty + '</b>, remaining <b>' + d.remainingQty + '</b> (period ' + esc(d.period) + ').';
        btn.textContent = 'Done';
        document.getElementById('al-cancel').textContent = 'Close';
        document.getElementById('al-cancel').onclick = function() { closeModal(); if (onDone) onDone(); };
      })
      .catch(function(e) {
        resultEl.style.display = 'block';
        resultEl.style.background = '#fdecea';
        resultEl.style.border = '1px solid #f5c6cb';
        resultEl.textContent = 'Error: ' + e.message;
        btn.disabled = false; btn.textContent = 'Allocate';
      });
  };
}

function renderAllocationsInto(containerId, performers) {
  var box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '<p style="color:#888;font-size:13px">Loading allocations…</p>';
  fetchAllocations().then(function(d) {
    _allocCache = {
      rows:        (d && d.allocations) || [],
      performers:  performers || {},
      period:      (d && d.period) || '',
      containerId: containerId,
    };
    _renderAllocTable();
  }).catch(function(e) {
    box.innerHTML = '<p style="color:#c62828;font-size:13px">Could not load allocations: ' + esc(e.message) + '</p>';
  });
}

// Sort key for an allocation row by column (numeric columns return numbers).
function _allocSortVal(r, col, performers) {
  if (col === 'vhw') return ((performers[r.practitioner] && performers[r.practitioner].name) || r.practitioner || '').toLowerCase();
  if (col === 'locationName') return ((performers[r.practitioner] && performers[r.practitioner].locationName) || '').toLowerCase();
  if (col === 'medication') return (r.medication || '').toLowerCase();
  if (col === 'lot_code') return (r.lot_code || '').toLowerCase();
  if (col === 'allocated_qty') return r.allocated_qty;
  if (col === 'dispensed_qty') return r.dispensed_qty;
  if (col === 'remaining_qty') return r.remaining_qty;
  if (col === 'updated_at') return r.updated_at ? new Date(r.updated_at).getTime() : 0;
  return '';
}

function exportAllocationsJSON() {
  var performers = _allocCache.performers || {};
  var data = {
    period:      _allocCache.period,
    exportedAt:  new Date().toISOString(),
    allocations: (_allocCache.rows || []).map(function(r) {
      var perf = performers[r.practitioner] || {};
      return {
        practitioner:  r.practitioner,
        name:          perf.name || null,
        medication:    r.medication,
        lot_code:      r.lot_code || null,
        allocated_qty: r.allocated_qty,
        dispensed_qty: r.dispensed_qty,
        remaining_qty: r.remaining_qty,
        period:        r.period,
        updated_at:    r.updated_at,
      };
    }),
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'allocations-' + (_allocCache.period || 'export') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function _renderAllocTable() {
  var box = document.getElementById(_allocCache.containerId);
  if (!box) return;
  var performers = _allocCache.performers;
  var rows = _allocCache.rows.slice();

  if (!rows.length) {
    box.innerHTML = '<p style="color:#888;font-size:13px">No allocations for this period (' + esc(_allocCache.period) + '). ' +
      'Use the <strong>Allocate</strong> button on a VHW row to assign stock.</p>';
    return;
  }

  // Force sort by VHW field worker if no explicit sort column is selected yet
  var col = _allocSort.col || 'vhw';
  var dir = _allocSort.dir;
  
  rows.sort(function(a, b) {
    var av = _allocSortVal(a, col, performers), bv = _allocSortVal(b, col, performers);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  // Group allocations by Practitioner/Fieldworker ID
  var grouped = [];
  var groupMap = {};
  rows.forEach(function(r) {
    var key = r.practitioner || 'unknown';
    if (!groupMap[key]) {
      groupMap[key] = [];
      grouped.push({ practitionerId: key, items: groupMap[key] });
    }
    groupMap[key].push(r);
  });

  var cols = [['vhw','VHW'],['locationName','Health Facility'],['medication','Medicine'],['lot_code','Lot'],['allocated_qty','Allocated'],['dispensed_qty','Dispensed'],['remaining_qty','Remaining'],['updated_at','Allocated At']];
  var thead = cols.map(function(c) {
    var active = col === c[0];
    var cls = 'sortable' + (active ? (' sort-' + (dir === 1 ? 'asc' : 'desc')) : '');
    var arrow = '<span class="sort-arrow">' + (active ? (dir === 1 ? '▲' : '▼') : '⇅') + '</span>';
    return '<th class="' + cls + '" data-alloc-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
  }).join('');

  var tbodyHtml = '';
  grouped.forEach(function(grp, gIdx) {
    var pId = grp.practitionerId;
    var perf = performers[pId] || {};
    var nm = perf.name || pId;
    var aliasNote = (perf.aliases && perf.aliases.length)
      ? ' <small style="color:#888" title="Aliases mapped to this worker">(' + perf.aliases.join(', ') + ')</small>'
      : '';
    
    var hasMultiple = grp.items.length > 1;
    var groupIdClass = 'alloc-group-' + gIdx;

    if (hasMultiple) {
      // Header row for fieldworkers with more than one allocation dispatch
      tbodyHtml += 
        '<tr class="group-header-row" style="background:#f1f3f5;cursor:pointer;font-weight:600" data-toggle-group="' + groupIdClass + '">' +
          '<td colspan="8" style="padding:10px;color:#212934">' +
            '<span class="toggle-icon" style="margin-right:8px;display:inline-block;width:12px">▼</span>' +
            esc(nm) + ' <small style="color:#6b7a8d;font-weight:400">(' + pId + ')</small>' + aliasNote +
            ' <span class="badge badge-gray" style="margin-left:8px;font-size:11px">' + grp.items.length + ' Dispatches</span>' +
          '</td>' +
        '</tr>';
    }

    grp.items.forEach(function(r) {
      var low = r.remaining_qty <= 0;
      // If there's only one item, don't inject headers or collapse flags; render cleanly inline
      var rowStyle = hasMultiple ? 'class="' + groupIdClass + '"' : '';
      var nameCell = hasMultiple 
        ? '<td style="color:#6b7a8d;padding-left:24px">↳ <small>Dispatch Line</small></td>'
        : '<td>' + esc(nm) + '<br><small style="color:#aaa">' + esc(r.practitioner) + '</small>' + 
            ((perf.aliases && perf.aliases.length) ? '<div style="font-size:11px;color:#888;margin-top:2px">aliases: ' + perf.aliases.map(function(a) { return '<code>' + esc(a) + '</code>'; }).join(', ') + '</div>' : '') + 
          '</td>';

      tbodyHtml += 
        '<tr ' + rowStyle + '>' +
          nameCell +
          '<td title="Location ID: ' + esc(perf.locationId || '—') + '">' + esc(perf.locationName || '') + '</td>' +
          '<td><code>' + esc(r.medication) + '</code></td>' +
          '<td>' + (r.lot_code ? '<code>' + esc(r.lot_code) + '</code>' : '<small style="color:#aaa">—</small>') + '</td>' +
          '<td>' + r.allocated_qty + '</td>' +
          '<td>' + r.dispensed_qty + '</td>' +
          '<td style="font-weight:600;color:' + (low ? '#c62828' : '#2e7d32') + '">' + r.remaining_qty + '</td>' +
          '<td><small style="color:#6b7a8d">' + (r.updated_at ? esc(new Date(r.updated_at).toLocaleString()) : '—') + '</small></td>' +
        '</tr>';
    });
  });

  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 10px">' +
      '<p style="font-size:12px;color:#4a5768;margin:0">Per-VHW budgets for period <strong>' + esc(_allocCache.period) + '</strong>. ' +
        'Remaining = allocated − dispensed.</p>' +
      '<div style="display:flex;gap:8px;flex-shrink:0">' +
        '<button class="btn btn-outline btn-sm" id="alloc-export-json">⬇ Export JSON</button>' +
        '<button class="btn btn-outline btn-sm" id="alloc-clear-all" style="color:#c62828;border-color:#c62828">🗑 Clear All</button>' +
      '</div>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr>' + thead + '</tr></thead><tbody>' + tbodyHtml + '</tbody></table></div>';

  // Wire Sort Click Events
  box.querySelectorAll('th[data-alloc-sort]').forEach(function(th) {
    th.onclick = function() {
      var targetCol = th.getAttribute('data-alloc-sort');
      if (_allocSort.col === targetCol) _allocSort.dir *= -1;
      else { _allocSort.col = targetCol; _allocSort.dir = 1; }
      _renderAllocTable();
    };
  });

  // Wire Expand/Collapse Clicking Logic for Grouped Rows
  box.querySelectorAll('tr[data-toggle-group]').forEach(function(headerRow) {
    headerRow.onclick = function() {
      var targetClass = headerRow.getAttribute('data-toggle-group');
      var childRows = box.querySelectorAll('tr.' + targetClass);
      var icon = headerRow.querySelector('.toggle-icon');
      
      var dynamicHidden = (childRows.length > 0 && childRows[0].style.display === 'none');
      
      childRows.forEach(function(row) {
        row.style.display = dynamicHidden ? '' : 'none';
      });
      
      if (icon) {
        icon.textContent = dynamicHidden ? '▼' : '►';
      }
    };
  });

  var _allocExportBtn = document.getElementById('alloc-export-json');
  if (_allocExportBtn) _allocExportBtn.onclick = exportAllocationsJSON;

  var _allocClearBtn = document.getElementById('alloc-clear-all');
  if (_allocClearBtn) _allocClearBtn.onclick = function() {
    if (window.BKM_ROLE !== 'coordinator' && window.BKM_ROLE !== 'admin') {
      alert('Only a coordinator or admin can clear allocations.');
      return;
    }
    if (!confirm('Clear ALL stock allocations for period ' + _allocCache.period + '? This cannot be undone.')) return;
    _allocClearBtn.disabled = true;
    clearAllocations().then(function(d) {
      renderAllocationsInto(_allocCache.containerId, _allocCache.performers);
    }).catch(function(e) {
      alert('Clear failed: ' + e.message);
      _allocClearBtn.disabled = false;
    });
  };
}
