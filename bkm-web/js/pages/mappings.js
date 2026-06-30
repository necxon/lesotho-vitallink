/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel lives in js/help/mappings.js (mappingsHelpHTML, global).

var _perfSort     = { col: null, dir: 1 };
var _perfPage     = 0;
var _perfPageSize = 25;

var _allocSort  = { col: null, dir: 1 };
var _allocCache = { rows: [], performers: {}, period: '', containerId: null };

var ROLE_COLORS = {
  vhw:             'green',
  facility_worker: 'blue',
  supervisor:      'purple',
};

// Resolve a performer's facility name. Prefer the stored facilityName, but fall
// back to reverse-looking-up facilityId in OU_LABELS (keyed by lmisFacility) so
// VHWs saved with a blank facilityName (e.g. created before an OU_LABELS reseed)
// still show their facility.
function _facNameFor(p) {
  if (!p) return '';
  if (p.facilityName) return p.facilityName;
  if (!p.facilityId || typeof OU_LABELS === 'undefined') return '';
  for (var ou in OU_LABELS) {
    if (OU_LABELS[ou] && OU_LABELS[ou].lmisFacility === p.facilityId) {
      return OU_LABELS[ou].facility || '';
    }
  }
  return '';
}

function roleBadge(role) {
  var color = ROLE_COLORS[role] || 'gray';
  return '<span class="badge badge-' + color + '">' + esc(role || 'vhw') + '</span>';
}

function exportMappingsJSON(performers, medications) {
  function build(allocations) {
    var data = {
      performers: Object.keys(performers).map(function(id) {
        var p = performers[id];
        return {
          sourceId:     id,
          facilityId:   p.facilityId   || '',
          facilityName: p.facilityName || '',
          programId:    p.programId    || '',
          phone:        p.phone        || null,
          email:        p.email        || null,
          dhis2OrgUnit: p.dhis2OrgUnit || null,
          name:         p.name         || null,
          role:         p.role         || 'vhw',
        };
      }),
      medications: Object.keys(medications)
        .filter(function(code) { return !/^[a-z0-9]+$/.test(code); }) // skip normalised duplicates
        .map(function(code) { return { sourceId: code, orderableId: medications[code] }; }),
      allocations: (allocations || []).map(function(r) {
        return {
          practitioner:  r.practitioner,
          name:          (performers[r.practitioner] && performers[r.practitioner].name) || null,
          medication:    r.medication,
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
    a.download = 'mappings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  // Pull current allocations so the export includes them; fall back to none on error.
  fetchAllocations()
    .then(function(d) { build((d && d.allocations) || []); })
    .catch(function() { build([]); });
}

function fetchMappings() {
  return mediatorFetch('aggregate/mappings')
    .then(function(r) { return r.json(); });
}

function mappingsPost(path, body) {
  return mediatorFetch('aggregate/mappings' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(r) {
    if (!r.ok) return r.json().then(function(d) { throw new Error(d.message || r.statusText); });
    return r.json();
  });
}

function mappingsDelete(path, body) {
  return mediatorFetch('aggregate/mappings' + path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(r) {
    if (!r.ok) return r.json().then(function(d) { throw new Error(d.message || r.statusText); });
    return r.json();
  });
}

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

function importMappingsJSON(file, onDone) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var data;
    try { data = JSON.parse(e.target.result); } catch (err) {
      alert('Invalid JSON: ' + err.message);
      return;
    }

    var performers  = data.performers  || [];
    var medications = data.medications || [];
    if (!performers.length && !medications.length) {
      alert('File contains no performers or medications.');
      return;
    }

    var perfCalls = performers.map(function(p) {
      return mappingsPost('/performers', {
        id:           p.sourceId,
        name:         p.name         || null,
        role:         p.role         || 'vhw',
        facilityId:   p.facilityId   || '',
        facilityName: p.facilityName || null,
        programId:    p.programId    || '',
        dhis2OrgUnit: p.dhis2OrgUnit || null,
        phone:        p.phone        || null,
        email:        p.email        || null,
      });
    });

    var medCalls = medications.map(function(m) {
      return mappingsPost('/medications', { code: m.sourceId, orderableId: m.orderableId });
    });

    Promise.all(perfCalls.concat(medCalls))
      .then(function() {
        alert('Imported ' + performers.length + ' performer(s) and ' + medications.length + ' medication(s).');
        onDone();
      })
      .catch(function(err) {
        alert('Import failed: ' + err.message);
      });
  };
  reader.readAsText(file);
}

function renderMappings(el) {
  loading(el);
  fetchMappings().then(function(data) {
    var performers  = data.performers  || {};
    var medications = data.medications || {};
    // Hide alias entries (rows whose key is listed as an alias of another canonical
    // entry). The mediator returns the same object under both keys; we keep only
    // the canonical id in the table and show the aliases inline on that row.
    var perfKeys = Object.keys(performers).filter(function(id) {
      var p = performers[id];
      return !p._canonical || p._canonical === id;
    });

    // Facility scoping: facility-locked roles (coordinator + vhw) only see staff
    // at their OWN health centre; only admin sees every facility.
    if (window.BKM_FACILITY_LOCKED) {
      var myFac = (window.BKM_FACILITY && window.BKM_FACILITY.id) || _myFacilityId(performers);
      if (myFac) {
        perfKeys = perfKeys.filter(function(id) { return performers[id].facilityId === myFac; });
      }
    }

    var _canDelete = (window.BKM_ROLE === 'coordinator' || window.BKM_ROLE === 'admin');

  el.innerHTML =
      '<div class="page-header">' +
        '<h2>Staff Management</h2>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-outline" id="map-refresh" title="Reload staff + stock allocations from the mediator (e.g. after an allocation or dispense).">↻ Refresh</button>' +
          (_canDelete ? '<button class="btn btn-outline" id="map-export-csv" title="Download all current performer and medication mappings as mappings.json. Use this to back up the live store or copy it to another environment.">⬇ Export JSON</button>' : '') +
          (_canDelete ? '<label class="btn btn-outline" style="cursor:pointer" title="Upload a mappings.json file. Every performer and medication in the file is upserted into the live store immediately — no mediator restart needed. Existing entries are overwritten; entries not in the file are left untouched.">⬆ Import JSON<input type="file" id="map-import-json" accept=".json" style="display:none"></label>' : '') +
          // '↺ Sync from FHIR' button removed (commented out per request):
          // '<button class="btn btn-outline" id="map-sync-fhir" title="Pull all Practitioners from HAPI FHIR and add any that are not already in the Staff Members table. Existing entries are not overwritten. Fill in Facility ID and DHIS2 Org Unit for new entries after syncing.">↺ Sync from FHIR</button>' +
          '<button class="btn btn-primary" id="map-new-worker">+ New Field Worker</button>' +
        '</div>' +
      '</div>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="map-performers">Staff Members (' + perfKeys.length + ')</button>' +
        '<button class="page-tab" data-tab="map-allocations">Stock Allocations</button>' +
        '<button class="page-tab" data-tab="map-help">? Help</button>' +
      '</div>' +

      '<div id="map-performers">' +
        '<div class="page-header" style="margin-bottom:12px">' +
          '<p style="font-size:12px;color:#4a5768;margin:0">' +
            'Maps a FHIR Practitioner ID to a facility, DHIS2 org unit, and role. ' +
            'Stored entries override the bundled <code>mappings.json</code> on next mediator startup. ' +
            'All authentication for OpenSRP and BKM web occurs in Keycloak.' +
          '</p>' +
        '</div>' +
        (perfKeys.length === 0
          ? '<p style="color:#888;font-size:13px">No performers stored yet. Use + New Field Worker.</p>'
          : '<div class="table-wrap">' +
              '<table><thead><tr>' +
                [['id','Practitioner ID'],['name','Name'],['role','Role'],
                 ['facilityName','Facility Name'],
                 ['locationName','Health Facility'],
                 ['dhis2OrgUnit','DHIS2 Org Unit'],['phone','Phone'],['email','Email']
                ].map(function(c) {
                  var col = c[0], label = c[1];
                  var active = _perfSort.col === col;
                  var cls = 'sortable' + (active ? (' sort-' + (_perfSort.dir === 1 ? 'asc' : 'desc')) : '');
                  var arrow = '<span class="sort-arrow">' + (active ? (_perfSort.dir === 1 ? '▲' : '▼') : '⇅') + '</span>';
                  return '<th class="' + cls + '" data-sort-col="' + col + '">' + label + arrow + '</th>';
                }).join('') +
                '<th title="Keycloak login account state — controls whether the user can sign in to the BKM app or the OpenSRP/bkm-web admin UIs. Independent of any clinical status on the FHIR Practitioner.">Login</th><th></th>' +
              '</tr></thead><tbody>' +
              (function() {
                var keys = perfKeys.slice();
                if (_perfSort.col) {
                  var col = _perfSort.col, dir = _perfSort.dir;
                  keys.sort(function(a, b) {
                    var av = col === 'id' ? a : (performers[a][col] || '');
                    var bv = col === 'id' ? b : (performers[b][col] || '');
                    return av.localeCompare(bv) * dir;
                  });
                }
                // Paginate after sort. _perfPageSize === 'all' shows everything.
                var total    = keys.length;
                var pageSize = _perfPageSize === 'all' ? total : _perfPageSize;
                var maxPage  = pageSize > 0 ? Math.max(0, Math.ceil(total / pageSize) - 1) : 0;
                if (_perfPage > maxPage) _perfPage = maxPage;
                var start    = pageSize > 0 ? _perfPage * pageSize : 0;
                return keys.slice(start, pageSize > 0 ? start + pageSize : total);
              })().map(function(id) {
                var p = performers[id];
                var _an = (p.aliases && p.aliases.length) || 0;
                var aliasNote = _an
                  ? '<div style="font-size:11px;margin-top:2px">' +
                      '<a href="#" onclick="var s=this.nextElementSibling;s.hidden=!s.hidden;return false;" ' +
                        'style="color:#999;text-decoration:none" ' +
                        'title="Alternate IDs the mediator treats as the same person — the Keycloak login id and the OpenSRP app Practitioner id.">' +
                        '▸ ' + _an + ' alias' + (_an > 1 ? 'es' : '') + '</a>' +
                      '<span hidden style="color:#888"> ' +
                        p.aliases.map(function(a) { return '<code>' + esc(a) + '</code>'; }).join(' ') + '</span>' +
                    '</div>'
                  : '';
                return '<tr>' +
                  '<td><code>' + esc(id) + '</code>' + aliasNote + '</td>' +
                  '<td>' + esc(p.name || '') + '</td>' +
                  '<td>' + roleBadge(p.role) + '</td>' +
                  '<td title="Facility ID: ' + esc(p.facilityId || '—') + '">' + esc(_facNameFor(p)) + '</td>' +
                  '<td title="Location ID: ' + esc(p.locationId || '—') + '">' + esc(p.locationName || '') + '</td>' +
                  '<td><small>' + esc(p.dhis2OrgUnit || '') + '</small></td>' +
                  '<td>' + esc(p.phone || '') + '</td>' +
                  '<td>' + esc(p.email || '') + '</td>' +
                  '<td class="perf-status-cell" data-perf-id="' + esc(id) + '" style="white-space:nowrap"><small style="color:#bbb">…</small></td>' +
                  '<td style="white-space:nowrap">' +
                    '<button class="btn btn-sm btn-outline map-edit-perf" data-id="' + esc(id) + '">Edit</button>' +
                    (p.role !== 'coordinator' ? ' <button class="btn btn-sm btn-outline map-alloc-perf" data-id="' + esc(id) + '" title="Assign this VHW a per-month budget of a medicine">Allocate</button>' : '') +
                    (_canDelete ? ' <button class="btn btn-sm btn-danger map-del-perf" data-id="' + esc(id) + '">Remove</button>' : '') +
                  '</td>' +
                '</tr>';
              }).join('') +
              '</tbody></table></div>' +
              // Pagination controls (only shown when there's more than one page)
              (function() {
                var total    = perfKeys.length;
                var pageSize = _perfPageSize === 'all' ? total : _perfPageSize;
                var maxPage  = pageSize > 0 ? Math.max(0, Math.ceil(total / pageSize) - 1) : 0;
                var start    = pageSize > 0 ? _perfPage * pageSize : 0;
                var end      = pageSize > 0 ? Math.min(start + pageSize, total) : total;
                var sizeOpts = [25, 50, 100, 'all'].map(function(n) {
                  var sel = (_perfPageSize === n) ? ' selected' : '';
                  return '<option value="' + n + '"' + sel + '>' + (n === 'all' ? 'Show all' : (n + ' per page')) + '</option>';
                }).join('');
                return '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px">' +
                  '<select id="perf-page-size" class="btn btn-sm">' + sizeOpts + '</select>' +
                  (pageSize !== total && total > 0
                    ? '<button id="perf-prev" class="btn btn-sm btn-outline"' + (_perfPage <= 0 ? ' disabled' : '') + '>&laquo; Prev</button>' +
                      '<span>Page ' + (_perfPage + 1) + ' of ' + (maxPage + 1) + ' &middot; rows ' + (start + 1) + '–' + end + ' of ' + total + '</span>' +
                      '<button id="perf-next" class="btn btn-sm btn-outline"' + (_perfPage >= maxPage ? ' disabled' : '') + '>Next &raquo;</button>'
                    : '<span style="color:var(--dhis2-text-muted)">' + total + ' record(s)</span>') +
                  '</div>';
              })()
        ) +
      '</div>' +

      '<div id="map-allocations" hidden>' +
        '<div class="page-header" style="margin-bottom:12px">' +
          '<p style="font-size:12px;color:#4a5768;margin:0">Per-VHW stock budgets for the current month. ' +
            'Assign with the <strong>Allocate</strong> button on a VHW row in the Staff Members tab.</p>' +
        '</div>' +
        '<div id="map-allocations-body"></div>' +
      '</div>' +

      '<div id="map-help" class="help-panel" hidden>' + mappingsHelpHTML() + '</div>';

    wirePageTabs(el);
    renderAllocationsInto('map-allocations-body', performers);

    el.querySelectorAll('th[data-sort-col]').forEach(function(th) {
      th.onclick = function() {
        var col = th.getAttribute('data-sort-col');
        if (_perfSort.col === col) {
          _perfSort.dir *= -1;
        } else {
          _perfSort.col = col;
          _perfSort.dir = 1;
        }
        _perfPage = 0;
        renderMappings(el);
      };
    });

    var pageSizeSel = document.getElementById('perf-page-size');
    if (pageSizeSel) pageSizeSel.onchange = function() {
      var v = this.value;
      _perfPageSize = (v === 'all') ? 'all' : parseInt(v, 10);
      _perfPage = 0;
      renderMappings(el);
    };
    var prevBtn = document.getElementById('perf-prev');
    if (prevBtn) prevBtn.onclick = function() { _perfPage = Math.max(0, _perfPage - 1); renderMappings(el); };
    var nextBtn = document.getElementById('perf-next');
    if (nextBtn) nextBtn.onclick = function() { _perfPage = _perfPage + 1; renderMappings(el); };

    var refreshBtn = document.getElementById('map-refresh');
    if (refreshBtn) refreshBtn.onclick = function() { renderMappings(el); };

    var exportBtn = document.getElementById('map-export-csv');
    if (exportBtn) exportBtn.onclick = function() { exportMappingsJSON(performers, medications); };

    var importInput = document.getElementById('map-import-json');
    if (importInput) importInput.onchange = function() {
      var file = this.files[0];
      if (!file) return;
      this.value = '';
      importMappingsJSON(file, function() { renderMappings(el); });
    };

    // '↺ Sync from FHIR' handler removed (button commented out per request):
    // document.getElementById('map-sync-fhir').onclick = function() {
    //   var btn = this;
    //   btn.disabled = true; btn.textContent = 'Syncing…';
    //   mappingsPost('/sync-fhir', {}).then(function(d) {
    //     alert('Sync complete. ' + d.added + ' new practitioner(s) added (of ' + d.total + ' in FHIR).');
    //     renderMappings(el);
    //   }).catch(function(e) {
    //     alert('Sync failed: ' + e.message);
    //     btn.disabled = false; btn.textContent = '↺ Sync from FHIR';
    //   });
    // };

    document.getElementById('map-new-worker').onclick = function() {
      openNewWorkerForm(function() { renderMappings(el); });
    };

    el.querySelectorAll('.map-edit-perf').forEach(function(btn) {
      btn.onclick = function() {
        var id = btn.getAttribute('data-id');
        openPerformerForm(id, performers[id], performers, function() { renderMappings(el); });
      };
    });

    el.querySelectorAll('.map-alloc-perf').forEach(function(btn) {
      btn.onclick = function() {
        var id = btn.getAttribute('data-id');
        openAllocateForm(id, performers[id], medications, function() {
          renderAllocationsInto('map-allocations-body', performers);
        });
      };
    });

    el.querySelectorAll('.map-del-perf').forEach(function(btn) {
      btn.onclick = function() {
        var id = btn.getAttribute('data-id');
        var practitionerUuid = id.indexOf('/') >= 0 ? id.split('/')[1] : id;
        showConfirm(
          'Remove Staff Member',
          'Permanently delete ' + id + '? This removes the FHIR Practitioner from HAPI ' +
          '(cascade-deletes its MedicationDispenses, Tasks, and QuestionnaireResponses) ' +
          'and the local mapping. Sync from FHIR will not bring it back.',
          function() {
            // Delete from HAPI first (cascade) so Sync from FHIR can't re-add it,
            // then remove the local mapping.
            var hapiUrl = CONFIG.fhir + '/Practitioner/' + practitionerUuid + '?_cascade=delete';
            kc.updateToken(30)
              .catch(function() { kc.login(); })
              .then(function() {
                return fetch(hapiUrl, {
                  method: 'DELETE',
                  headers: { Authorization: 'Bearer ' + kc.token, Accept: 'application/fhir+json' },
                });
              })
              .then(function(r) {
                // 200 OK or 404 (already gone) are both fine to proceed.
                if (!r.ok && r.status !== 404) {
                  return r.text().then(function(t) { throw new Error('HAPI delete failed: HTTP ' + r.status + ' ' + t.slice(0, 200)); });
                }
              })
              .then(function() { return mappingsDelete('/performers', { id: id }); })
              .then(function() { closeModal(); renderMappings(el); })
              .catch(function(e) { alert('Error: ' + e.message); });
          }
        );
      };
    });

    // Async: fetch KC statuses and populate Status column
    if (perfKeys.length) {
      mediatorFetch('aggregate/users/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practitionerIds: perfKeys }),
      }).then(function(r) { return r.json(); }).then(function(d) {
        var statuses = d.statuses || {};
        Object.keys(statuses).forEach(function(pid) {
          updatePerfStatusCell(el, pid, statuses[pid]);
        });
      }).catch(function() { /* status column stays as … on error */ });
    }

  }).catch(function(e) { errMsg(el, e.message); });
}

function updatePerfStatusCell(el, pid, s) {
  var cell = el.querySelector('.perf-status-cell[data-perf-id="' + pid + '"]');
  if (!cell) return;
  if (!s.linked) {
    cell.innerHTML = '<span style="color:#bbb;font-size:11px" title="This Practitioner has no Keycloak account linked — they cannot sign in. Use ＋ New Field Worker to create one.">— no login —</span>';
    return;
  }
  renderPerfStatusCell(el, cell, pid, s.enabled, s.username);
}

function renderPerfStatusCell(el, cell, pid, enabled, username) {
  var userLine = username
    ? '<div style="font-weight:600;color:#212934;font-size:12px;font-family:Consolas,monospace">' + esc(username) + '</div>'
    : '';
  cell.innerHTML = userLine + (enabled
    ? '<div style="display:flex;gap:6px;align-items:center;margin-top:2px">' +
        '<span class="badge badge-green" title="Keycloak account is enabled — user can sign in." style="font-size:11px">Active</span>' +
        '<button class="btn btn-sm btn-danger" data-pid="' + esc(pid) + '" data-enabled="true" style="padding:2px 6px;font-size:11px" title="Disable the Keycloak account so this user can no longer sign in (Practitioner data is left intact)">Block</button>' +
      '</div>'
    : '<div style="display:flex;gap:6px;align-items:center;margin-top:2px">' +
        '<span class="badge badge-red" title="Keycloak account is disabled — sign-in attempts are rejected." style="font-size:11px">Blocked</span>' +
        '<button class="btn btn-sm btn-outline" data-pid="' + esc(pid) + '" data-enabled="false" style="padding:2px 6px;font-size:11px" title="Re-enable the Keycloak account so the user can sign in again">Unblock</button>' +
      '</div>');
  cell.querySelector('button').onclick = function(e) {
    var btn = e.currentTarget;
    var newEnabled = btn.getAttribute('data-enabled') === 'false';
    btn.disabled = true; btn.textContent = newEnabled ? 'Unblocking…' : 'Blocking…';
    mediatorFetch('aggregate/users/set-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practitionerId: pid, enabled: newEnabled }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.status !== 'ok') throw new Error(d.message);
      renderPerfStatusCell(el, cell, pid, newEnabled);
    }).catch(function(err) {
      alert('Error: ' + err.message);
      renderPerfStatusCell(el, cell, pid, !newEnabled);
    });
  };
}

// Username rule: lowercase, letters/digits only, at most ONE dot (first.last or firstlast).
function sanitizeUsername(v) {
  v = (v || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  var firstDot = v.indexOf('.');
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  }
  return v;
}

function openNewWorkerForm(onSave) {
  // Default email: random 5-char local part (e.g. somer@lesotho-bkm.xyz). The admin can edit it.
  var _rand5 = '';
  for (var _i = 0; _i < 5; _i++) _rand5 += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  var _defaultEmail = _rand5 + '@lesotho-bkm.xyz';
  showModal('New Field Worker',
    '<div class="modal-body">' +
      '<p style="font-size:12px;color:#4a5768;margin:0 0 12px">Creates a Keycloak login, FHIR Practitioner, and performer mapping in one step.</p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">' +
        '<div class="form-row"><label>First Name</label>' +
          '<input id="nw-first" placeholder="Thabo"></div>' +
        '<div class="form-row"><label>Last Name</label>' +
          '<input id="nw-last" placeholder="Mokoena"></div>' +
      '</div>' +
      '<div class="form-row"><label>Username</label>' +
        '<input id="nw-user" placeholder="thabo.mokoena" autocomplete="off">' +
        '<span style="font-size:11px;color:#6b7a8d">Lowercase only, at most one dot (e.g. <code>thabo.mokoena</code> or <code>thabomokoena</code>).</span></div>' +
      '<div class="form-row"><label>Password</label>' +
        '<input id="nw-pass" type="text" value="ChangeMe123" autocomplete="off">' +
        '<span style="font-size:11px;color:#6b7a8d">Default password (min 8 characters). Share it with the worker — they can change it after first login, or you can later via <strong>Edit ▸ Reset password</strong>.</span></div>' +
      '<div class="form-row"><label>Role</label>' +
        '<select id="nw-role">' +
          // You can only create roles below your own: admin → coordinator/vhw,
          // coordinator → vhw only.
          (window.BKM_ROLE === 'admin' ? '<option value="coordinator">coordinator</option>' : '') +
          '<option value="vhw">vhw</option>' +
        '</select></div>' +
      '<div class="form-row"><label>Phone</label>' +
        '<input id="nw-phone" placeholder="+26657111111"></div>' +
      '<div class="form-row"><label>Email</label>' +
        '<input id="nw-email" value="' + _defaultEmail + '" placeholder="name@lesotho-bkm.xyz">' +
        '<span style="font-size:11px;color:#6b7a8d">Random default — edit if the worker has a real address.</span></div>' +
      '<div class="form-row"><label>Facility</label>' +
        '<select id="nw-facility"><option value="">Loading…</option></select>' +
        '<span style="font-size:11px;color:#6b7a8d">Health centre (OpenLMIS facility) the worker belongs to — this is their stock scope</span></div>' +
      '<div class="form-row"><label>DHIS2 Org Unit</label>' +
        '<input id="nw-ou" placeholder="auto-filled from facility"></div>' +
      '<div id="nw-result" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:12px;font-family:monospace"></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="nw-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="nw-save">Create</button>' +
      '</div>' +
    '</div>'
  );

  document.getElementById('nw-cancel').onclick = closeModal;

  // Auto-derive username + email from First/Last name (Neels Lotter -> neels.lotter /
  // neels.lotter@lesotho-bkm.xyz) until the admin manually edits those fields.
  var _userEdited = false, _emailEdited = false;
  function _syncFromName() {
    var f = sanitizeUsername(document.getElementById('nw-first').value);
    var l = sanitizeUsername(document.getElementById('nw-last').value);
    var base = sanitizeUsername((f && l) ? (f + '.' + l) : (f || l));
    if (!_userEdited)  document.getElementById('nw-user').value  = base;
    if (!_emailEdited) document.getElementById('nw-email').value = base ? (base + '@lesotho-bkm.xyz') : _defaultEmail;
  }
  document.getElementById('nw-first').addEventListener('input', _syncFromName);
  document.getElementById('nw-last').addEventListener('input', _syncFromName);

  // Live-enforce the username rule as the user types (preserve cursor position).
  var _userInput = document.getElementById('nw-user');
  if (_userInput) _userInput.addEventListener('input', function() {
    _userEdited = true;
    var start = this.selectionStart;
    var clean = sanitizeUsername(this.value);
    if (clean !== this.value) {
      var removed = this.value.length - clean.length;
      this.value = clean;
      var pos = Math.max(0, start - removed);
      this.setSelectionRange(pos, pos);
    }
  });
  var _emailInput = document.getElementById('nw-email');
  if (_emailInput) _emailInput.addEventListener('input', function() { _emailEdited = true; });

  // Facility dropdown — OpenLMIS is the master facility registry. One health centre
  // = one BKM service point, so the OpenLMIS facility IS the worker's location. We
  // derive each facility's DHIS2 org unit + FHIR location from its existing staff in
  // the performer map (data-driven). DHIS2 OU stays editable.
  var _ouEdited = false;
  var _facInfo  = {};   // facilityId -> { name, locationId, locationName, dhis2Ou }
  var _ouInput  = document.getElementById('nw-ou');
  if (_ouInput) _ouInput.addEventListener('input', function() { _ouEdited = true; });

  function _applyFacility(facId) {
    var info = _facInfo[facId] || {};
    if (!_ouEdited && info.dhis2Ou) document.getElementById('nw-ou').value = info.dhis2Ou;
  }
  var _facSel = document.getElementById('nw-facility');
  if (_facSel) _facSel.addEventListener('change', function() { _applyFacility(this.value); });

  Promise.all([
    lmisGet('/api/facilities?size=100').catch(function() { return { content: [] }; }),
    mediatorFetch('aggregate/mappings').then(function(r) { return r.json(); }).catch(function() { return {}; }),
  ]).then(function(res) {
    var facList    = (res[0] && res[0].content) || [];
    var performers = (res[1] && res[1].performers) || {};
    // Derive FHIR location + DHIS2 OU per facility from existing staff there.
    Object.keys(performers).forEach(function(pid) {
      var p = performers[pid] || {};
      if (!p.facilityId || _facInfo[p.facilityId]) return;
      _facInfo[p.facilityId] = {
        name: p.facilityName || '', locationId: p.locationId || '',
        locationName: p.locationName || '', dhis2Ou: p.dhis2OrgUnit || '',
      };
    });
    // Enrich from OU_LABELS (keyed by DHIS2 OU, carries each facility's lmisFacility +
    // FHIR location) so a facility's DHIS2 OU resolves even with no existing staff there
    // — e.g. a coordinator creating their FIRST VHW at their (locked) facility.
    Object.keys(OU_LABELS).forEach(function(ou) {
      var lf = OU_LABELS[ou].lmisFacility;
      if (!lf) return;
      var fi = _facInfo[lf] || (_facInfo[lf] = { name: '', locationId: '', locationName: '', dhis2Ou: '' });
      fi.dhis2Ou      = fi.dhis2Ou      || ou;
      fi.name         = fi.name         || OU_LABELS[ou].facility || '';
      fi.locationId   = fi.locationId   || OU_LABELS[ou].fhirLocation || '';
      fi.locationName = fi.locationName || OU_LABELS[ou].facility || '';
    });
    // OpenLMIS facility names are the master — overlay them.
    facList.forEach(function(f) {
      _facInfo[f.id] = _facInfo[f.id] || { name: '', locationId: '', locationName: '', dhis2Ou: '' };
      _facInfo[f.id].name = f.name || _facInfo[f.id].name || f.id;
    });

    var sel = document.getElementById('nw-facility');
    if (!sel) return;
    var locked = window.BKM_FACILITY_LOCKED && window.BKM_FACILITY;
    if (locked && !_facInfo[window.BKM_FACILITY.id]) {
      _facInfo[window.BKM_FACILITY.id] = { name: window.BKM_FACILITY.name || window.BKM_FACILITY.id, locationId: '', locationName: '', dhis2Ou: '' };
    }
    // Facility-scoped roles can only create at their own facility.
    var ids = locked ? [window.BKM_FACILITY.id] : Object.keys(_facInfo);
    ids.sort(function(a, b) { return ((_facInfo[a] || {}).name || '').localeCompare((_facInfo[b] || {}).name || ''); });
    sel.innerHTML = '<option value="">— select facility —</option>';
    ids.forEach(function(fid) {
      var o = document.createElement('option');
      o.value = fid; o.textContent = (_facInfo[fid] && _facInfo[fid].name) || fid;
      sel.appendChild(o);
    });
    if (locked) { sel.value = window.BKM_FACILITY.id; sel.disabled = true; _applyFacility(sel.value); }
    else if (ids.length === 1) { sel.value = ids[0]; _applyFacility(ids[0]); }
  }).catch(function() {
    var sel = document.getElementById('nw-facility');
    if (sel) sel.innerHTML = '<option value="">— OpenLMIS unavailable —</option>';
  });

  document.getElementById('nw-save').onclick = function() {
    var firstName    = document.getElementById('nw-first').value.trim();
    var lastName     = document.getElementById('nw-last').value.trim();
    var username     = sanitizeUsername(document.getElementById('nw-user').value.trim());
    var password     = document.getElementById('nw-pass').value;
    var role         = document.getElementById('nw-role').value;
    var phone        = document.getElementById('nw-phone').value.trim();
    var email        = document.getElementById('nw-email').value.trim();
    var dhis2OrgUnit = document.getElementById('nw-ou').value.trim();
    var facSel       = document.getElementById('nw-facility');
    var facilityId   = facSel ? facSel.value : '';
    var facInfo      = _facInfo[facilityId] || {};
    var facilityName = facInfo.name || '';
    var locationId   = facInfo.locationId || '';
    var locationName = facInfo.locationName || '';

    if (!firstName || !lastName) { alert('First and last name are required'); return; }
    if (!username)               { alert('Username is required'); return; }
    if (!password)               { alert('Password is required'); return; }
    if (password.length < 8)     { alert('Password must be at least 8 characters'); return; }
    if (!facilityId)             { alert('Facility is required'); return; }

    var btn = document.getElementById('nw-save');
    btn.disabled = true; btn.textContent = 'Creating…';

    mediatorFetch('aggregate/users/field-worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: firstName, lastName: lastName, username: username, password: password, role: role, phone: phone || null, email: email || null, facilityId: facilityId || null, facilityName: facilityName || null, dhis2OrgUnit: dhis2OrgUnit || null, locationId: locationId || null, locationName: locationName || null }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.status !== 'ok') throw new Error(d.message || 'Unknown error');
      var resultEl = document.getElementById('nw-result');
      resultEl.style.display = 'block';
      resultEl.style.background = '#edf7ed';
      resultEl.style.border = '1px solid #a3d9a5';
      resultEl.innerHTML =
        '<strong style="color:#2d6a2d">Field worker created</strong><br>' +
        'Username: <b>' + esc(d.username) + '</b><br>' +
        'Role: <b>' + esc(d.role) + '</b><br>' +
        'Practitioner ID: <b>' + esc(d.practitionerId) + '</b><br>' +
        'KC User ID: <b>' + esc(d.kcUserId) + '</b>';
      btn.textContent = 'Done';
      document.getElementById('nw-cancel').textContent = 'Close';
      document.getElementById('nw-cancel').onclick = function() { closeModal(); onSave(); };
    }).catch(function(e) {
      var resultEl = document.getElementById('nw-result');
      resultEl.style.display = 'block';
      resultEl.style.background = '#fdecea';
      resultEl.style.border = '1px solid #f5c6cb';
      resultEl.textContent = 'Error: ' + e.message;
      btn.disabled = false; btn.textContent = 'Create';
    });
  };
}

function openPerformerForm(editId, existing, performers, onSave) {
  var title = editId ? 'Edit Staff Member' : 'Add Staff Member';
  showModal(title,
    '<div class="modal-body">' +
      '<div class="form-row"><label>Practitioner ID</label>' +
        '<input id="pf-id" value="' + esc(editId || '') + '"' + (editId ? ' readonly style="background:#f5f5f5"' : '') +
        ' placeholder="Practitioner/93b47b21-7311-416a-a6a4-7be8426b1fc3"></div>' +
      '<div class="form-row"><label>Name</label>' +
        '<input id="pf-name" value="' + esc(existing && existing.name || '') + '" placeholder="Full name"></div>' +
      '<div class="form-row"><label>Role</label>' +
        '<select id="pf-role">' +
          ['vhw', 'coordinator'].map(function(r) {
            return '<option value="' + r + '"' + ((existing && existing.role) === r ? ' selected' : '') + '>' + r + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="form-row"><label>Location / Facility</label>' +
        '<select id="pf-location">' +
          (existing && existing.locationId
            ? '<option value="' + esc(existing.locationId) + '" data-name="' + esc(existing.locationName || '') + '" selected>' +
              esc(existing.locationName || existing.locationId) + '</option>'
            : '<option value="">Loading…</option>') +
        '</select>' +
        '<span style="font-size:11px;color:#6b7a8d">District hospital, health centre, or village</span></div>' +
      '<div class="form-row"><label>Facility</label>' +
        '<select id="pf-facility-select">' +
          '<option value="">— None / VHW —</option>' +
          (existing && existing.facilityId
            ? '<option value="' + esc(existing.facilityId) + '" data-name="' + esc(existing.facilityName || '') + '" selected>' +
              esc(existing.facilityName || existing.facilityId) + '</option>'
            : '') +
          '<option value="__loading__" disabled>Loading facilities from OpenLMIS…</option>' +
        '</select></div>' +
      '<div class="form-row"><label>DHIS2 Org Unit</label>' +
        '<input id="pf-ou" value="' + esc(existing && existing.dhis2OrgUnit || '') + '" placeholder="e.g. VilHaMokoe1"></div>' +
      '<div class="form-row"><label>Phone</label>' +
        '<input id="pf-phone" value="' + esc(existing && existing.phone || '') + '" placeholder="+26657111111"></div>' +
      '<div class="form-row"><label>Email</label>' +
        '<input id="pf-email" value="' + esc(existing && existing.email || '') + '" placeholder="name@lesotho.health"></div>' +
      (editId
        ? '<details id="pf-reset-section" style="margin-top:16px;border-top:1px solid #e1e2e4;padding-top:12px">' +
            '<summary style="cursor:pointer;font-size:13px;color:#4a5768;user-select:none">🔑 Reset password</summary>' +
            '<div style="margin-top:10px;display:flex;gap:8px;align-items:flex-end">' +
              '<div class="form-row" style="flex:1;margin:0"><label>New password</label>' +
                '<input id="pf-new-pass" type="password" placeholder="Min 8 characters" autocomplete="new-password"></div>' +
              '<button class="btn btn-outline" id="pf-reset-btn" style="flex-shrink:0;margin-bottom:0">Set Password</button>' +
            '</div>' +
            '<div id="pf-reset-result" style="display:none;font-size:12px;margin-top:8px"></div>' +
          '</details>' +
          '<div style="margin-top:12px;border-top:1px solid #e1e2e4;padding-top:12px;display:flex;align-items:center;gap:10px">' +
            '<span style="font-size:13px;color:#4a5768;flex:1" id="pf-block-label">Loading account status…</span>' +
            '<button class="btn btn-sm" id="pf-block-btn" disabled>…</button>' +
          '</div>' +
          '<div id="pf-block-result" style="display:none;font-size:12px;margin-top:6px"></div>'
        : '') +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="form-save">Save</button>' +
      '</div>' +
    '</div>'
  );

  // Populate facility dropdown from OpenLMIS so users pick a real facility
  // instead of pasting a UUID. Preserves the existing selection when editing.
  (function populateFacilities() {
    var sel = document.getElementById('pf-facility-select');
    if (!sel) return;
    var currentId = existing && existing.facilityId || '';
    lmisGet('/api/facilities?size=500')
      .then(function(d) {
        var facs = (d && (d.content || d)) || [];
        facs.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
        var options = ['<option value="">— None / VHW —</option>'];
        var seen = false;
        facs.forEach(function(f) {
          if (!f.id) return;
          var selected = (f.id === currentId);
          if (selected) seen = true;
          options.push(
            '<option value="' + esc(f.id) + '" data-name="' + esc(f.name || '') + '"' +
            (selected ? ' selected' : '') + '>' +
            esc(f.name || f.id) + '</option>'
          );
        });
        if (currentId && !seen) {
          options.push(
            '<option value="' + esc(currentId) + '" data-name="' +
            esc((existing && existing.facilityName) || '') + '" selected>' +
            esc((existing && existing.facilityName) || currentId) + ' (unknown to OpenLMIS)</option>'
          );
        }
        sel.innerHTML = options.join('');
      })
      .catch(function(e) {
        // Keep the placeholder option visible so the user can still save the
        // current value; offer a manual UUID-paste fallback via prompt.
        sel.innerHTML = (currentId
          ? '<option value="' + esc(currentId) + '" data-name="' + esc((existing && existing.facilityName) || '') + '" selected>' +
            esc((existing && existing.facilityName) || currentId) + '</option>'
          : '<option value="">— None / VHW —</option>');
        var note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:#c62828;margin-top:4px';
        note.textContent = 'Could not load facilities from OpenLMIS: ' + e.message;
        sel.parentElement.appendChild(note);
      });
  })();

  // Populate location dropdown from FHIR, grouped by district, pre-select existing
  (function populateLocations() {
    var currentLocId   = existing && existing.locationId   || '';
    var currentLocName = existing && existing.locationName || '';
    fhir('Location?_count=200&_elements=id,name,type,partOf').then(function(bundle) {
      var locs = entries(bundle);
      var districts = {};
      var byId = {};
      locs.forEach(function(l) { byId[l.id] = l; });
      locs.forEach(function(l) {
        var code = get(l, 'type', '0', 'coding', '0', 'code') || '';
        if (code === 'AREA' || code === 'COUNTRY' || code === 'DIST') return;
        var parentId = l.partOf ? l.partOf.reference.split('/')[1] : null;
        var parentLoc = parentId && byId[parentId];
        var parentParentId = parentLoc && parentLoc.partOf ? parentLoc.partOf.reference.split('/')[1] : null;
        var distLoc = (code === 'COMM' && parentParentId && byId[parentParentId])
                    ? byId[parentParentId]
                    : (parentLoc || {});
        var distName = distLoc.name || 'Other';
        if (!districts[distName]) districts[distName] = [];
        districts[distName].push(l);
      });
      var sel = document.getElementById('pf-location');
      if (!sel) return;
      sel.innerHTML = '<option value="">— No location assigned —</option>';
      Object.keys(districts).sort().forEach(function(distName) {
        var grp = document.createElement('optgroup');
        grp.label = distName;
        districts[distName].sort(function(a, b) { return a.name.localeCompare(b.name); }).forEach(function(l) {
          var opt = document.createElement('option');
          opt.value = l.id;
          opt.setAttribute('data-name', l.name);
          opt.textContent = l.name;
          if (l.id === currentLocId) opt.selected = true;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      });
      // If the existing location isn't in FHIR, keep it visible as a fallback option
      if (currentLocId && !byId[currentLocId]) {
        var opt = document.createElement('option');
        opt.value = currentLocId;
        opt.setAttribute('data-name', currentLocName);
        opt.textContent = (currentLocName || currentLocId) + ' (not in FHIR)';
        opt.selected = true;
        sel.appendChild(opt);
      }
    }).catch(function() {
      var sel = document.getElementById('pf-location');
      if (!sel) return;
      sel.innerHTML = currentLocId
        ? '<option value="' + esc(currentLocId) + '" data-name="' + esc(currentLocName) + '" selected>' + esc(currentLocName || currentLocId) + '</option>'
        : '<option value="">— FHIR unavailable —</option>';
    });
  })();

  if (editId) {
    var _kcEnabled = null;

    function applyBlockState(enabled) {
      _kcEnabled = enabled;
      var lbl = document.getElementById('pf-block-label');
      var btn = document.getElementById('pf-block-btn');
      if (enabled) {
        lbl.textContent = 'Account is active';
        btn.textContent = '🚫 Block User';
        btn.className = 'btn btn-sm btn-danger';
      } else {
        lbl.innerHTML = '<span style="color:#c62828;font-weight:600">⚠ Account is blocked</span>';
        btn.textContent = '✓ Unblock User';
        btn.className = 'btn btn-sm btn-outline';
      }
      btn.disabled = false;
    }

    mediatorFetch('aggregate/users/status?practitionerId=' + encodeURIComponent(editId))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.status !== 'ok') throw new Error(d.message);
        applyBlockState(d.enabled);
      })
      .catch(function() {
        var lbl = document.getElementById('pf-block-label');
        var btn = document.getElementById('pf-block-btn');
        if (lbl) lbl.textContent = 'Account status unavailable (no Keycloak link)';
        if (btn) { btn.textContent = 'N/A'; btn.disabled = true; }
      });

    document.getElementById('pf-block-btn').onclick = function() {
      var newEnabled = !_kcEnabled;
      var btn = document.getElementById('pf-block-btn');
      var resultEl = document.getElementById('pf-block-result');
      var action = newEnabled ? 'Unblocking…' : 'Blocking…';
      btn.disabled = true; btn.textContent = action;
      mediatorFetch('aggregate/users/set-enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practitionerId: editId, enabled: newEnabled }),
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.status !== 'ok') throw new Error(d.message || 'Unknown error');
        applyBlockState(newEnabled);
        resultEl.style.display = 'block';
        resultEl.style.color = newEnabled ? '#2d6a2d' : '#c62828';
        resultEl.textContent = newEnabled ? 'User unblocked — they can now log in.' : 'User blocked — login disabled.';
      }).catch(function(e) {
        resultEl.style.display = 'block';
        resultEl.style.color = '#c62828';
        resultEl.textContent = 'Error: ' + e.message;
        applyBlockState(_kcEnabled);
      });
    };

    document.getElementById('pf-reset-btn').onclick = function() {
      var newPass = document.getElementById('pf-new-pass').value;
      var resultEl = document.getElementById('pf-reset-result');
      var btn = document.getElementById('pf-reset-btn');
      if (!newPass || newPass.length < 8) { alert('Password must be at least 8 characters'); return; }
      btn.disabled = true; btn.textContent = 'Setting…';
      mediatorFetch('aggregate/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practitionerId: editId, newPassword: newPass }),
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.status !== 'ok') throw new Error(d.message || 'Unknown error');
        resultEl.style.display = 'block';
        resultEl.style.color = '#2d6a2d';
        resultEl.textContent = 'Password updated successfully.';
        document.getElementById('pf-new-pass').value = '';
        btn.disabled = false; btn.textContent = 'Set Password';
      }).catch(function(e) {
        resultEl.style.display = 'block';
        resultEl.style.color = '#c62828';
        resultEl.textContent = 'Error: ' + e.message;
        btn.disabled = false; btn.textContent = 'Set Password';
      });
    };
  }

  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var id           = document.getElementById('pf-id').value.trim();
    var name         = document.getElementById('pf-name').value.trim();
    var role         = document.getElementById('pf-role').value;
    var locSel       = document.getElementById('pf-location');
    var locOpt       = locSel && locSel.options[locSel.selectedIndex];
    var locationId   = locSel ? locSel.value : '';
    var locationName = (locOpt && locOpt.getAttribute('data-name')) || '';
    var facSel       = document.getElementById('pf-facility-select');
    var facOpt       = facSel.options[facSel.selectedIndex];
    var facility     = facSel.value || '';
    var facilityName = (facOpt && facOpt.getAttribute('data-name')) || (facility ? facOpt.textContent.trim() : '');
    var ou           = document.getElementById('pf-ou').value.trim();
    var phone        = document.getElementById('pf-phone').value.trim();
    var email        = document.getElementById('pf-email').value.trim();

    if (!id) { alert('Practitioner ID is required'); return; }

    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';

    mappingsPost('/performers', {
      id: id, name: name || null, role: role,
      locationId: locationId || null, locationName: locationName || null,
      facilityName: facilityName || null, facilityId: facility,
      dhis2OrgUnit: ou || null,
      phone: phone || null, email: email || null,
    }).then(function() {
      closeModal(); onSave();
    }).catch(function(e) {
      alert('Save failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Save';
    });
  };
}
