/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Medicine Aliases page (#/medications): map app codes/names to OpenLMIS orderables.
// Split out of mappings.js. All helpers used here are globals (fetchMappings, mappingsPost, etc.).

function openMedicationForm(editCode, existingId, onSave) {
  // Add a medicine: a friendly name and/or an app code, both mapping to one orderable.
  // Each entered value is stored as an alias (so dispenses match either form).
  showModal('Add Medicine',
    '<div class="modal-body">' +
      '<div class="form-row"><label>Medicine name</label>' +
        '<input id="mf-name" placeholder="e.g. Amoxicillin 250mg"></div>' +
      '<div class="form-row"><label>App Code</label>' +
        '<input id="mf-code" placeholder="e.g. AMOX250"></div>' +
      '<div class="form-row"><label>OpenLMIS Orderable UUID</label>' +
        '<input id="mf-oid" placeholder="3be1d20f-6aa9-4e52-864f-4fa04aa02056"></div>' +
      '<div class="hint" style="font-size:12px;color:#4a5768;margin-top:4px">Enter a name and/or a code — both are saved as aliases pointing at this orderable. Find UUIDs in OpenLMIS under Manage Supply Chain → Products.</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="form-save">Save</button>' +
      '</div>' +
    '</div>'
  );

  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var name = document.getElementById('mf-name').value.trim();
    var code = document.getElementById('mf-code').value.trim();
    var oid  = document.getElementById('mf-oid').value.trim();

    var aliases = [name, code].filter(function(a) { return a; });
    if (aliases.length === 0) { alert('Enter a medicine name or an app code'); return; }
    if (!oid)                 { alert('Orderable UUID is required'); return; }

    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';

    Promise.all(aliases.map(function(a) { return mappingsPost('/medications', { code: a, orderableId: oid }); }))
      .then(function() { closeModal(); onSave(); })
      .catch(function(e) { alert('Save failed: ' + e.message); btn.disabled = false; btn.textContent = 'Save'; });
  };
}


// Lists all OpenLMIS orderables (products) with their UUIDs, so you can copy a UUID
// when adding a Medicine Alias. Read-only; pulls live from OpenLMIS.
function showOpenlmisOrderables() {
  showModal('OpenLMIS Orderables', '<div class="modal-body"><p aria-busy="true">Loading orderables from OpenLMIS…</p></div>');
  lmisGet('/api/orderables?page=0&size=1000').then(function(d) {
    var items = (d && d.content) || [];
    items.sort(function(a, b) { return (a.fullProductName || '').localeCompare(b.fullProductName || ''); });
    var rows = items.map(function(o) {
      var oid = o.id || '';
      return '<tr>' +
        '<td>' + esc(o.fullProductName || '') + '</td>' +
        '<td><code style="font-size:11px">' + esc(o.productCode || '') + '</code></td>' +
        '<td><code style="font-size:11px">' + esc(oid) + '</code></td>' +
        '<td><button class="btn btn-sm btn-outline ord-copy" data-oid="' + esc(oid) + '">Copy</button></td>' +
      '</tr>';
    }).join('');
    showModal('OpenLMIS Orderables (' + items.length + ')',
      '<div class="modal-body">' +
        '<p style="font-size:12px;color:#4a5768;margin:0 0 10px">Live products from OpenLMIS. Copy a UUID to map it as a Medicine Alias.</p>' +
        '<div class="table-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr>' +
          '<th>Product</th><th>Code</th><th>Orderable UUID</th><th></th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="4">No orderables found.</td></tr>') + '</tbody></table></div>' +
        '<div class="form-actions"><button class="btn btn-outline" id="ord-close">Close</button></div>' +
      '</div>');
    document.getElementById('ord-close').onclick = closeModal;
    document.querySelectorAll('.ord-copy').forEach(function(b) {
      b.onclick = function() {
        var oid = b.getAttribute('data-oid');
        if (navigator.clipboard) {
          navigator.clipboard.writeText(oid).then(function() {
            b.textContent = 'Copied'; setTimeout(function() { b.textContent = 'Copy'; }, 1200);
          });
        }
      };
    });
  }).catch(function(e) {
    showModal('OpenLMIS Orderables',
      '<div class="modal-body"><p class="error">Failed to load orderables: ' + esc(e.message) + '</p>' +
      '<div class="form-actions"><button class="btn btn-outline" id="ord-close">Close</button></div></div>');
    document.getElementById('ord-close').onclick = closeModal;
  });
}

function renderMedications(el) {
  loading(el);
  fetchMappings().then(function(data) {
    var medications = data.medications || {};
    var medKeys = Object.keys(medications).filter(function(code) {
      return !/^[a-z0-9]+$/.test(code); // skip normalised duplicates
    });
    var _canDelete = (window.BKM_ROLE === 'coordinator' || window.BKM_ROLE === 'admin');

    // Group aliases by orderable UUID so each medicine shows ONCE. The readable alias
    // (one with a space or lowercase) is the row label; the rest are shown inline.
    var groups = {};
    medKeys.forEach(function(code) {
      var oid = medications[code];
      if (!oid) return;
      if (!groups[oid]) groups[oid] = { oid: oid, codes: [] };
      groups[oid].codes.push(code);
    });
    var groupList = Object.keys(groups).map(function(oid) {
      var codes    = groups[oid].codes;
      var readable = codes.filter(function(c) { return /[ a-z]/.test(c); });
      return { oid: oid, codes: codes, label: readable[0] || codes[0] };
    }).sort(function(a, b) { return a.label.localeCompare(b.label); });

    el.innerHTML =
      '<div class="page-header">' +
        '<h2>Medicine Aliases</h2>' +
        '<button class="btn btn-outline" id="med-orderables" title="List all products (orderables) from OpenLMIS with their UUIDs">OpenLMIS Orderables</button>' +
        (_canDelete ? '<button class="btn btn-primary" id="med-add">+ Add</button>' : '') +
      '</div>' +
      '<p style="font-size:12px;color:#4a5768;margin:0 0 16px">One row per OpenLMIS orderable. ' +
        'Every listed app code maps to that orderable (explicit aliases take priority over the live product-code lookup).</p>' +
      (groupList.length === 0
        ? '<p style="color:#888;font-size:13px">No medication aliases stored. Mediator falls back to OpenLMIS product codes.</p>'
        : '<div class="table-wrap"><table><thead><tr>' +
            '<th>Medicine</th><th>App Codes</th><th>OpenLMIS Orderable UUID</th><th></th>' +
          '</tr></thead><tbody>' +
          groupList.map(function(g) {
            var codesJoined = g.codes.join(',');
            return '<tr>' +
              '<td>' + esc(g.label) + '</td>' +
              '<td>' + g.codes.map(function(c) { return '<code style="font-size:11px">' + esc(c) + '</code>'; }).join(' ') + '</td>' +
              '<td><small>' + esc(g.oid) + '</small></td>' +
              '<td style="white-space:nowrap">' +
                '<button class="btn btn-sm btn-outline med-edit" data-oid="' + esc(g.oid) + '" data-codes="' + esc(codesJoined) + '" data-label="' + esc(g.label) + '">Edit</button>' +
                (_canDelete ? ' <button class="btn btn-sm btn-danger med-del" data-codes="' + esc(codesJoined) + '" data-label="' + esc(g.label) + '">Remove</button>' : '') +
              '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div>'
      );

    var addBtn = document.getElementById('med-add');
    if (addBtn) addBtn.onclick = function() {
      openMedicationForm(null, null, function() { renderMedications(el); });
    };

    var ordBtn = document.getElementById('med-orderables');
    if (ordBtn) ordBtn.onclick = showOpenlmisOrderables;

    // Edit re-points the WHOLE group to a new orderable UUID (updates every alias).
    el.querySelectorAll('.med-edit').forEach(function(btn) {
      btn.onclick = function() {
        var codes = btn.getAttribute('data-codes').split(',');
        openMedicationGroupForm(btn.getAttribute('data-label'), codes, btn.getAttribute('data-oid'),
          function() { renderMedications(el); });
      };
    });

    // Remove deletes every alias in the group.
    el.querySelectorAll('.med-del').forEach(function(btn) {
      btn.onclick = function() {
        var codes = btn.getAttribute('data-codes').split(',');
        var label = btn.getAttribute('data-label');
        showConfirm('Remove Medicine',
          'Remove "' + label + '" and its ' + codes.length + ' app-code alias(es)?', function() {
            Promise.all(codes.map(function(c) { return mappingsDelete('/medications', { code: c }); }))
              .then(function() { closeModal(); renderMedications(el); })
              .catch(function(e) { alert('Error: ' + e.message); });
          });
      };
    });

  }).catch(function(e) { errMsg(el, e.message); });
}

// Edits a medicine's shared OpenLMIS UUID across all of its app-code aliases at once.
function openMedicationGroupForm(label, codes, currentOid, onSave) {
  showModal('Edit Medicine — ' + esc(label),
    '<div class="modal-body">' +
      '<div class="form-row"><label>App Codes</label>' +
        '<div>' + codes.map(function(c) { return '<code style="font-size:11px">' + esc(c) + '</code>'; }).join(' ') + '</div></div>' +
      '<div class="form-row"><label>OpenLMIS Orderable UUID</label>' +
        '<input id="mgf-oid" value="' + esc(currentOid || '') + '" placeholder="3be1d20f-6aa9-4e52-864f-4fa04aa02056"></div>' +
      '<div class="hint" style="font-size:12px;color:#4a5768;margin-top:4px">Re-points all of the above app codes to this orderable. Find UUIDs in OpenLMIS under Manage Supply Chain → Products.</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="form-save">Save</button>' +
      '</div>' +
    '</div>'
  );
  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var oid = document.getElementById('mgf-oid').value.trim();
    if (!oid) { alert('Orderable UUID is required'); return; }
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    Promise.all(codes.map(function(c) { return mappingsPost('/medications', { code: c, orderableId: oid }); }))
      .then(function() { closeModal(); onSave(); })
      .catch(function(e) { alert('Save failed: ' + e.message); btn.disabled = false; btn.textContent = 'Save'; });
  };
}
