/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Dispense (stock) modal forms for the Stock Log page (#/stock).
// Split out of stock.js. Uses globals (fhir, esc, showModal, renderStock, etc.).

// ── Dispense (Stock) forms ────────────────────────────────────────────────────

function dispenseFormHtml(d) {
  var coding   = get(d, 'medicationCodeableConcept', 'coding', '0');
  var medCode  = (coding && coding.code) || '';
  var medDisp  = (coding && coding.display) || get(d, 'medicationCodeableConcept', 'text') || '';
  var qty      = get(d, 'quantity', 'value') || '';
  var unit     = get(d, 'quantity', 'unit') || 'tablet';
  var when     = d && d.whenHandedOver ? d.whenHandedOver.substring(0, 10) : '';
  var subjRef  = d && d.subject && d.subject.reference || '';
  var patId    = subjRef.split('/')[1] || '';
  var perfRef  = get(d, 'performer', '0', 'actor', 'reference') || '';
  var pracId   = perfRef.split('/')[1] || '';

  return (
    '<div class="form-row"><label>Patient ID</label>' +
      '<input id="f-patient" value="' + esc(patId) + '" placeholder="e.g. patient-001"></div>' +
    '<div class="form-row"><label>Practitioner ID</label>' +
      '<input id="f-practitioner" value="' + esc(pracId) + '" placeholder="e.g. 93b47b21-7311-416a-a6a4-7be8426b1fc3"></div>' +
    '<div class="form-row"><label>Medication code</label>' +
      '<input id="f-med-code" value="' + esc(medCode) + '" placeholder="e.g. AL-20-120"></div>' +
    '<div class="form-row"><label>Medication display name</label>' +
      '<input id="f-med-disp" value="' + esc(medDisp) + '" placeholder="e.g. Artemether/Lumefantrine 20/120mg"></div>' +
    '<div class="form-row"><label>Quantity</label>' +
      '<input id="f-qty" type="number" min="0" value="' + esc(qty) + '"></div>' +
    '<div class="form-row"><label>Unit</label>' +
      '<input id="f-unit" value="' + esc(unit) + '" placeholder="tablet"></div>' +
    '<div class="form-row"><label>Date handed over</label>' +
      '<input id="f-when" type="date" value="' + esc(when) + '"></div>' +
    '<div class="form-row"><label>Status</label>' +
      '<select id="f-status">' +
        ['completed','in-progress','on-hold','stopped','cancelled','unknown'].map(function(s) {
          return '<option value="' + s + '"' + (d && d.status === s ? ' selected' : (!d && s === 'completed' ? ' selected' : '')) + '>' + s + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-save">Save</button>' +
    '</div>'
  );
}

function dispenseFromForm(existing) {
  var r = Object.assign({}, existing || {}, { resourceType: 'MedicationDispense' });
  var patId   = document.getElementById('f-patient').value.trim();
  var pracId  = document.getElementById('f-practitioner').value.trim();
  var medCode = document.getElementById('f-med-code').value.trim();
  var medDisp = document.getElementById('f-med-disp').value.trim();
  var qty     = parseFloat(document.getElementById('f-qty').value);
  var unit    = document.getElementById('f-unit').value.trim() || 'tablet';
  var when    = document.getElementById('f-when').value;
  r.status    = document.getElementById('f-status').value;
  r.subject   = patId ? { reference: 'Patient/' + patId } : undefined;
  r.performer = pracId ? [{ actor: { reference: 'Practitioner/' + pracId } }] : [];
  r.medicationCodeableConcept = {
    coding: medCode ? [{ code: medCode, display: medDisp || medCode }] : [],
    text: medDisp || medCode,
  };
  r.quantity = { value: isNaN(qty) ? undefined : qty, unit: unit };
  if (when) r.whenHandedOver = when + 'T00:00:00Z';
  return r;
}

function openDispenseForm(onSave) {
  showModal('New Dispense Record', dispenseFormHtml(null));
  document.getElementById('form-cancel').onclick = closeModal;
  document.getElementById('form-save').onclick = function() {
    var resource = dispenseFromForm(null);
    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    openhimPost(resource)
      .then(function(result) {
        closeModal();
        onSave(result);
      })
      .catch(function(err) { btn.disabled = false; btn.textContent = 'Save'; alert('Error: ' + err.message); });
  };
}

// ── Inventory dispense form ───────────────────────────────────────────────────

function openInventoryDispenseForm(card, facilityRef, onDone) {
  var today = new Date().toISOString().slice(0, 10);
  var maxQty = card.balance !== null ? card.balance : '';
  showModal('Dispense: ' + card.name,
    '<div class="form-row"><label>Medicine</label>' +
      '<input value="' + esc(card.name) + '" readonly style="background:#f5f5f5;color:#555"></div>' +
    '<div class="form-row"><label>Current stock</label>' +
      '<input value="' + (card.balance !== null ? card.balance + ' units' : '—') + '" readonly style="background:#f5f5f5;color:#555"></div>' +
    '<div class="form-row"><label>Quantity to dispense</label>' +
      '<input id="fd-qty" type="number" min="1"' + (maxQty !== '' ? ' max="' + maxQty + '"' : '') + ' placeholder="units"></div>' +
    '<div class="form-row"><label>Patient ID</label>' +
      '<input id="fd-patient" placeholder="e.g. patient-001"></div>' +
    '<div class="form-row"><label>Practitioner ID</label>' +
      '<input id="fd-prac" placeholder="e.g. 93b47b21-7311-416a-a6a4-7be8426b1fc3"></div>' +
    '<div class="form-row"><label>Date</label>' +
      '<input id="fd-date" type="date" value="' + today + '"></div>' +
    '<div style="font-size:11px;color:#9e9e9e;margin-bottom:12px">' +
      'Posts MedicationDispense to OpenHIM &rarr; OpenLMIS &amp; DHIS2, then updates stock balance.' +
    '</div>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="fd-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="fd-save">Dispense</button>' +
    '</div>'
  );

  document.getElementById('fd-cancel').onclick = closeModal;
  document.getElementById('fd-save').onclick = function() {
    var qty   = parseInt(document.getElementById('fd-qty').value, 10);
    var patId = document.getElementById('fd-patient').value.trim();
    var pracId= document.getElementById('fd-prac').value.trim();
    var date  = document.getElementById('fd-date').value;

    if (!qty || qty <= 0) { alert('Enter a valid quantity.'); return; }
    if (card.balance !== null && qty > card.balance) { alert('Quantity exceeds current stock balance.'); return; }
    if (!patId)  { alert('Enter a patient ID.'); return; }
    if (!date)   { alert('Enter a date.'); return; }

    var btn = document.getElementById('fd-save');
    btn.disabled = true; btn.textContent = 'Saving…';

    var dispenseResource = {
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject:   { reference: 'Patient/' + patId },
      performer: pracId ? [{ actor: { reference: 'Practitioner/' + pracId } }] : [],
      medicationCodeableConcept: {
        text: card.name,
        coding: [{ code: card.name, display: card.name }],
      },
      quantity: { value: qty, unit: 'units', system: 'http://unitsofmeasure.org', code: '{units}' },
      whenHandedOver: date + 'T00:00:00Z',
    };

    openhimPost(dispenseResource)
      .then(function() {
        if (!card.obsId || !card.obsResource) return;
        var obs = JSON.parse(JSON.stringify(card.obsResource));
        obs.component = (obs.component || []).map(function(c) {
          if (c.valueQuantity && c.valueQuantity.value !== undefined) {
            c.valueQuantity.value = Math.max(0, c.valueQuantity.value - qty);
          }
          return c;
        });
        obs.effectiveDateTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        return fhirPut('Observation', card.obsId, obs);
      })
      .then(function() { closeModal(); onDone(); })
      .catch(function(err) {
        btn.disabled = false; btn.textContent = 'Dispense';
        alert('Error: ' + err.message);
      });
  };
}
