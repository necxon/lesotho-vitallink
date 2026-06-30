/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// "Statuses & Reasons" tab — explains what "stock status" means in OpenLMIS:
// the movement reasons actually used here vs. the broader supply-chain workflow
// statuses (in transit / delivered / issued) that this demo does not exercise.
function stockStatusesHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What "stock status" means in OpenLMIS</h4>' +
      '<p>OpenLMIS has three separate ideas of stock state. Only the first is used in ' +
      'this demo — the mediator posts <strong>stock events</strong> directly, so the ' +
      'requisition/order supply-chain flow is not exercised here.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>1. Stock-movement reasons <span style="font-weight:400;color:#6b7a8d">(used here — every Stock Log row has one)</span></h4>' +
      '<p>Each transaction on the stock card is a <strong>CREDIT</strong> (stock in, +) or ' +
      '<strong>DEBIT</strong> (stock out, −), tagged with a reason:</p>' +
      '<table>' +
        '<thead><tr><th>Reason</th><th>Direction</th><th>Category</th><th>When it happens</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Receipts</strong></td><td><span class="badge green">CREDIT +</span></td><td>Adjustment</td><td>Stock arrives at the facility (initial stock, or a facility-worker receipt). <em>Used in this demo.</em></td></tr>' +
          '<tr><td><strong>Consumed</strong></td><td><span class="badge red">DEBIT −</span></td><td>Adjustment</td><td>A VHW dispenses to a patient — every dispense fan-out posts this. <em>Used in this demo.</em></td></tr>' +
          '<tr><td>Transfer In</td><td><span class="badge green">CREDIT +</span></td><td>Transfer</td><td>Stock transferred in from another facility.</td></tr>' +
          '<tr><td>Beginning Balance Excess</td><td><span class="badge green">CREDIT +</span></td><td>Adjustment</td><td>Physical inventory found more than recorded.</td></tr>' +
          '<tr><td>Unpacked From Kit</td><td><span class="badge green">CREDIT +</span></td><td>Aggregation</td><td>Individual items released from a kit.</td></tr>' +
          '<tr><td>Stock Requested</td><td><span class="badge red">DEBIT −</span></td><td>Adjustment</td><td>Stock issued out / requested elsewhere.</td></tr>' +
          '<tr><td>Beginning Balance Insufficiency</td><td><span class="badge red">DEBIT −</span></td><td>Adjustment</td><td>Physical inventory found less than recorded (loss/shrinkage).</td></tr>' +
          '<tr><td>Unpack Kit</td><td><span class="badge red">DEBIT −</span></td><td>Aggregation</td><td>A kit is unpacked (the kit itself leaves stock).</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>2. Supply-chain workflow statuses <span style="font-weight:400;color:#6b7a8d">(in transit / delivered / issued — NOT used in this demo)</span></h4>' +
      '<p>These belong to the <strong>requisition → order → shipment → proof-of-delivery</strong> ' +
      'flow. They would track stock moving <em>between</em> facilities. In this sandbox the ' +
      'fulfillment and requisition tables are empty because stock moves via direct stock events.</p>' +
      '<table>' +
        '<thead><tr><th>Stage</th><th>Status values</th><th>Meaning</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Requisition</strong><br><small>the request</small></td><td>INITIATED → SUBMITTED → AUTHORIZED → IN_APPROVAL → APPROVED → RELEASED<br><small>(also REJECTED, SKIPPED)</small></td><td>A facility requests resupply; the request is reviewed and approved.</td></tr>' +
          '<tr><td><strong>Order</strong><br><small>fulfillment</small></td><td>ORDERED → FULFILLING → SHIPPED → RECEIVED<br><small>(also IN_ROUTE, READY_TO_PACK, TRANSFER_FAILED)</small></td><td>The approved order is packed and shipped. <strong>SHIPPED / IN_ROUTE = "in transit"</strong>; <strong>RECEIVED = "delivered"</strong>.</td></tr>' +
          '<tr><td><strong>Proof of Delivery</strong></td><td>INITIATED → CONFIRMED</td><td>The receiving facility confirms what actually arrived (the formal "delivered" sign-off).</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="font-size:12px;color:#6b7a8d">"Issued" ≈ a <strong>Transfer Out</strong> / shipment leaving the supplying facility. This demo dispenses to patients (Consumed) rather than issuing between facilities.</p>' +
    '</div>' +

    '<div class="help-section" style="background:#fff8e1;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px">' +
      '<h4 style="margin-top:0">📋 TODO / Roadmap — implementing the real workflow (Option 1)</h4>' +
      '<p>Driving OpenLMIS\'s ' +
      'supply chain through its own APIs so the statuses above are <em>genuine</em>. To make even one ' +
      'order go <code>ORDERED → SHIPPED → RECEIVED</code> you\'d need to seed and wire all of:</p>' +
      '<ul style="margin:6px 0 10px 18px;line-height:1.6">' +
        '<li><strong>Processing schedule + periods</strong> (requisitions are per monthly period) — none exist yet</li>' +
        '<li><strong>Supervisory node + requisition group + program schedule</strong> — partially built (added one for the stock view)</li>' +
        '<li><strong>Supply lines</strong> — which warehouse/facility supplies the supervisory node</li>' +
        '<li><strong>A supplying warehouse</strong> with its own stock to ship from</li>' +
        '<li><strong>The full role/right set</strong> for each step (REQUISITION_CREATE / AUTHORIZE / APPROVE, ORDERS_EDIT, SHIPMENTS_EDIT, PODS_MANAGE)</li>' +
        '<li><strong>The multi-step API dance:</strong> <code>initiate → submit → authorize → approve → convertToOrder → POST /shipments (→ SHIPPED) → proof-of-delivery confirm (→ RECEIVED)</code>, each with its own validations</li>' +
      '</ul>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>3. The stock card itself has no status</h4>' +
      '<p>A stock card is not "open/closed" — its state is simply the <strong>running Stock on Hand</strong> ' +
      'balance plus its line items (each with a reason from section 1). The ' +
      '<span class="badge red">Stock-out</span> / <span class="badge inactive">Low</span> / ' +
      '<span class="badge active">OK</span> badges in the portal are <em>computed live</em> from the ' +
      'SOH value, not stored statuses.</p>' +
    '</div>'
  );
}

// Static help panel lives in js/help/stock.js (stockHelpHTML, global).

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

// ── App Inventory (sourced from HAPI FHIR Observations/Flags/MeasureReports) ──

function renderAppInventory(el) {
  el.innerHTML = '<p aria-busy="true">Loading inventory…</p>';

  Promise.all([
    fhir('Group?_count=200').catch(function() { return { entry: [] }; }),
    fhir('Observation?status=preliminary&_count=200').catch(function() { return { entry: [] }; }),
    fhir('Flag?status=active&_count=100').catch(function() { return { entry: [] }; }),
    fhir('MeasureReport?_count=200').catch(function() { return { entry: [] }; }),
    fhir('Organization?_count=50').catch(function() { return { entry: [] }; }),
  ]).then(function(results) {
    var groups     = entries(results[0]);
    // obsMap[groupRef][facilityRef] = obs  (multiple facilities per commodity)
    var obsMap     = {};
    var flagMap    = {};
    var mrMap      = {};
    var orgMap     = {};  // "Organization/id" -> display name

    entries(results[1]).forEach(function(obs) {
      var groupRef = obs.subject && obs.subject.reference;
      var perfRef  = obs.performer && obs.performer[0] && obs.performer[0].reference;
      if (groupRef) {
        if (!obsMap[groupRef]) obsMap[groupRef] = {};
        obsMap[groupRef][perfRef || '__unknown__'] = obs;
      }
    });
    entries(results[2]).forEach(function(flag) {
      var ref = flag.subject && flag.subject.reference;
      if (ref) flagMap[ref] = flag;
    });
    entries(results[3]).forEach(function(mr) {
      var ref = mr.subject && mr.subject.reference;
      if (ref) mrMap[ref] = mr;
    });
    entries(results[4]).forEach(function(org) {
      orgMap['Organization/' + org.id] = org.name || org.id;
    });

    // Keep only groups that have at least one seeded Observation (commodity groups)
    groups = groups.filter(function(g) { return obsMap['Group/' + g.id]; });

    if (groups.length === 0) {
      el.innerHTML =
        '<p style="color:var(--dhis2-text-muted);margin:24px 0">' +
          'No inventory commodity groups found in HAPI FHIR. ' +
          '<a href="#" id="inv-retry" style="color:var(--dhis2-blue)">Retry</a>' +
        '</p>';
      document.getElementById('inv-retry').addEventListener('click', function(e) {
        e.preventDefault();
        renderAppInventory(el);
      });
      return;
    }

    var statusMeta = [
      { key: 'Stockout',     color: '#DD0000', bg: '#FDECEA' },
      { key: 'Understock',   color: '#FFA500', bg: '#FFF3E0' },
      { key: 'Satisfactory', color: '#38B500', bg: '#EDF7E8' },
      { key: 'Overstock',    color: '#006EB8', bg: '#E3F0FB' },
    ];
    var statusOrder  = { Stockout: 0, Understock: 1, Satisfactory: 2, Overstock: 3, Unknown: 4 };
    var statusColors = { Stockout: '#DD0000', Understock: '#FFA500', Satisfactory: '#38B500', Overstock: '#006EB8', Unknown: '#9e9e9e' };

    // Collect all facility refs that appear across all observations
    var facilities = {};
    groups.forEach(function(g) {
      var byFac = obsMap['Group/' + g.id] || {};
      Object.keys(byFac).forEach(function(fRef) {
        if (fRef !== '__unknown__' && !facilities[fRef]) {
          facilities[fRef] = orgMap[fRef] || fRef.split('/')[1] || fRef;
        }
      });
    });
    var facilityRefs = Object.keys(facilities).sort(function(a, b) {
      return facilities[a].localeCompare(facilities[b]);
    });

    function cardStatus(balance, amc) {
      if (balance === null) return { label: 'Unknown', color: '#9e9e9e', mos: null };
      var mos = (amc > 0) ? balance / amc : 0;
      var label = mos <= 0.5 ? 'Stockout' : mos < 1 ? 'Understock' : mos < 3 ? 'Satisfactory' : 'Overstock';
      return { label: label, color: statusColors[label], mos: mos };
    }

    // Build one card object per (group, facility) pair
    function makeCards(facilityRef) {
      var cards = [];
      groups.forEach(function(group) {
        var gid      = group.id;
        var name     = group.name || gid;
        var groupRef = 'Group/' + gid;
        var byFac    = obsMap[groupRef] || {};
        var obs      = byFac[facilityRef] || byFac['__unknown__'];
        var mr       = mrMap[groupRef];

        var balance = null;
        if (obs && obs.component) {
          obs.component.forEach(function(c) {
            if (c.valueQuantity && c.valueQuantity.value !== undefined) balance = c.valueQuantity.value;
          });
        }
        var amc = null;
        if (mr && mr.contained && mr.contained[0] && mr.contained[0].code) {
          var cod = mr.contained[0].code.coding;
          if (cod && cod[0]) amc = parseFloat(cod[0].code);
        }

        var st = cardStatus(balance, amc);
        cards.push({
          name: name, balance: balance, amc: amc, mos: st.mos,
          statusLabel: st.label, statusColor: st.color,
          lastCounted: obs && obs.effectiveDateTime ? obs.effectiveDateTime.slice(0, 10) : null,
          obsId: obs ? obs.id : null,
          obsResource: obs || null,
        });
      });
      cards.sort(function(a, b) {
        var d = (statusOrder[a.statusLabel] || 0) - (statusOrder[b.statusLabel] || 0);
        return d !== 0 ? d : a.name.localeCompare(b.name);
      });
      return cards;
    }

    // "All facilities" overview: one row per commodity, one mini-badge per facility
    function buildAllFacilitiesGrid() {
      var rows = groups.map(function(group) {
        var gid      = group.id;
        var name     = group.name || gid;
        var groupRef = 'Group/' + gid;
        var byFac    = obsMap[groupRef] || {};
        var mr       = mrMap[groupRef];
        var amc      = null;
        if (mr && mr.contained && mr.contained[0] && mr.contained[0].code) {
          var cod = mr.contained[0].code.coding;
          if (cod && cod[0]) amc = parseFloat(cod[0].code);
        }
        // worst status across facilities
        var worstOrder = 4;
        var worstColor = '#9e9e9e';
        var badges = facilityRefs.map(function(fRef) {
          var obs     = byFac[fRef];
          var balance = null;
          if (obs && obs.component) {
            obs.component.forEach(function(c) {
              if (c.valueQuantity && c.valueQuantity.value !== undefined) balance = c.valueQuantity.value;
            });
          }
          var st = cardStatus(balance, amc);
          if ((statusOrder[st.label] || 0) < worstOrder) {
            worstOrder = statusOrder[st.label] || 0;
            worstColor = st.color;
          }
          var mosText = st.mos !== null ? st.mos.toFixed(1) + ' mo' : '—';
          return '<span title="' + esc(facilities[fRef]) + ': ' + (balance !== null ? balance + ' units, MOS ' + mosText : 'no data') + '"' +
            ' style="display:inline-block;background:' + st.color + ';color:#fff;' +
            'padding:1px 6px;border-radius:10px;font-size:10px;margin-right:4px">' +
            esc(facilities[fRef].split(' ')[0]) + ' ' + (balance !== null ? balance : '—') +
            '</span>';
        }).join('');
        return { worstOrder: worstOrder, worstColor: worstColor, name: name, badges: badges, amc: amc };
      });
      rows.sort(function(a, b) {
        return a.worstOrder !== b.worstOrder ? a.worstOrder - b.worstOrder : a.name.localeCompare(b.name);
      });
      return '<div style="display:flex;flex-direction:column;gap:8px">' +
        rows.map(function(r) {
          return '<div style="background:#fff;border:1px solid #e0e0e0;border-left:4px solid ' + r.worstColor + ';' +
            'border-radius:4px;padding:10px 14px;display:flex;align-items:center;gap:12px">' +
            '<div style="font-size:13px;font-weight:500;min-width:200px">' + esc(r.name) + '</div>' +
            '<div style="font-size:11px;color:#9e9e9e;min-width:70px">AMC ' + (r.amc || '—') + '/mo</div>' +
            '<div>' + r.badges + '</div>' +
            '</div>';
        }).join('') +
        '</div>';
    }

    function buildSummaryBar(cards) {
      // Status summary cards (STOCKOUT / UNDERSTOCK / SATISFACTORY / OVERSTOCK) hidden per request.
      return '';
      /*
      var counts = { Stockout: 0, Understock: 0, Satisfactory: 0, Overstock: 0 };
      cards.forEach(function(c) { if (counts[c.statusLabel] !== undefined) counts[c.statusLabel]++; });
      return '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">' +
        statusMeta.map(function(s) {
          return '<div style="background:' + s.bg + ';border-radius:6px;padding:10px 16px;min-width:100px">' +
            '<div style="font-size:11px;color:' + s.color + ';font-weight:600">' + s.key.toUpperCase() + '</div>' +
            '<div style="font-size:28px;font-weight:700;color:' + s.color + '">' + counts[s.key] + '</div>' +
            '</div>';
        }).join('') + '</div>';
      */
    }

    function buildCardGrid(cards) {
      return '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        cards.map(function(c, i) {
          var mosText = c.mos !== null ? c.mos.toFixed(1) + ' mo' : '—';
          var amcText = c.amc !== null ? c.amc + '/mo' : '—';
          var canDispense = c.balance !== null && c.balance > 0;
          return '<div style="background:#fff;border:1px solid #e0e0e0;border-top:4px solid ' + c.statusColor + ';' +
            'border-radius:4px;padding:16px;min-width:180px;flex:1 1 200px;max-width:260px;display:flex;flex-direction:column">' +
            '<div style="font-size:12px;color:#757575;margin-bottom:6px;line-height:1.3">' + esc(c.name) + '</div>' +
            '<div style="font-size:40px;font-weight:700;color:' + c.statusColor + ';line-height:1;margin-bottom:6px">' +
              (c.balance !== null ? c.balance : '—') +
            '</div>' +
            '<div style="margin-bottom:6px">' +
              '<span style="background:' + c.statusColor + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:11px">' +
                c.statusLabel + '</span>' +
            '</div>' +
            '<div style="font-size:11px;color:#9e9e9e">MOS: ' + mosText + ' &bull; AMC: ' + amcText + '</div>' +
            (c.lastCounted ? '<div style="font-size:10px;color:#bdbdbd;margin-top:4px">Counted ' + esc(c.lastCounted) + '</div>' : '') +
            // Dispense button hidden per request.
            /*
            '<div style="margin-top:auto;padding-top:10px">' +
              '<button data-dispense="' + i + '" ' +
                (canDispense ? '' : 'disabled ') +
                'style="width:100%;padding:6px 0;background:' + (canDispense ? '#1565C0' : '#e0e0e0') + ';' +
                'color:' + (canDispense ? '#fff' : '#9e9e9e') + ';border:none;border-radius:4px;font-size:12px;' +
                'cursor:' + (canDispense ? 'pointer' : 'default') + '">' +
                (canDispense ? 'Dispense' : 'Out of stock') +
              '</button>' +
            '</div>' +
            */
            '</div>';
        }).join('') + '</div>';
    }

    // Track currently-displayed cards and facility for dispense button handler
    var currentCards       = [];
    var currentFacilityRef = '';

    function applyFacilityFilter() {
      var sel = document.getElementById('inv-facility').value;
      currentFacilityRef = sel;
      if (!sel) {
        currentCards = [];
        document.getElementById('inv-summary').style.display = 'none';
        document.getElementById('inv-count').textContent = groups.length + ' commodities, ' + facilityRefs.length + ' facilities';
        document.getElementById('inv-cards').innerHTML = buildAllFacilitiesGrid();
      } else {
        currentCards = makeCards(sel);
        document.getElementById('inv-summary').style.display = '';
        document.getElementById('inv-summary').innerHTML = buildSummaryBar(currentCards);
        document.getElementById('inv-count').textContent = currentCards.length + ' commodities';
        document.getElementById('inv-cards').innerHTML = buildCardGrid(currentCards);
      }
    }

    var firstFacility = facilityRefs[0] || '';
    currentFacilityRef = firstFacility;
    currentCards       = firstFacility ? makeCards(firstFacility) : [];

    var facilityOptions = '<option value="">All facilities</option>' +
      facilityRefs.map(function(ref) {
        return '<option value="' + esc(ref) + '"' + (ref === firstFacility ? ' selected' : '') + '>' +
          esc(facilities[ref]) + '</option>';
      }).join('');

    var fetchedAt = new Date().toLocaleString();
    el.innerHTML =
      '<p style="margin:0 0 16px;font-size:12px;color:var(--dhis2-text-muted);text-align:right">' +
        'HAPI FHIR &mdash; as of ' + esc(fetchedAt) +
        ' &mdash; <a href="#" id="inv-refresh" style="color:var(--dhis2-blue)">Refresh</a>' +
      '</p>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<h3 style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#757575">' +
          '<span id="inv-count">' + currentCards.length + ' commodities</span>' +
        '</h3>' +
        '<select id="inv-facility" style="margin-left:auto;font-size:13px;width:auto">' + facilityOptions + '</select>' +
      '</div>' +
      '<div id="inv-summary">' + (firstFacility ? buildSummaryBar(currentCards) : '') + '</div>' +
      '<h3 style="margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#757575">Commodities</h3>' +
      '<div id="inv-cards">' + (firstFacility ? buildCardGrid(currentCards) : buildAllFacilitiesGrid()) + '</div>';

    document.getElementById('inv-facility').addEventListener('change', applyFacilityFilter);
    document.getElementById('inv-refresh').addEventListener('click', function(e) {
      e.preventDefault();
      renderAppInventory(el);
    });

    // Single delegated handler for all Dispense buttons (survives innerHTML rebuilds on filter change)
    el.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-dispense]');
      if (!btn || !currentFacilityRef) return;
      var idx  = parseInt(btn.getAttribute('data-dispense'), 10);
      var card = currentCards[idx];
      if (!card) return;
      openInventoryDispenseForm(card, currentFacilityRef, function() {
        renderAppInventory(el);
      });
    });
  }).catch(function(e) { errMsg(el, e.message); });
}

// ── Stock / Dispense log (sourced from OpenLMIS stock card line items) ────────

function renderStock(el) {
  el.innerHTML =
    '<div class="page-header">' +
      '<h2>Stock (LMIS)</h2>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="stock-data">Stock Log</button>' +
      '<button class="page-tab" data-tab="stock-inventory">App Inventory (BKM Platform)</button>' +
      '<button class="page-tab" data-tab="stock-statuses">Statuses &amp; Reasons</button>' +
      '<button class="page-tab" data-tab="stock-help">? Help</button>' +
    '</div>' +
    '<div style="background:#fff8e1;border-left:4px solid #f59e0b;padding:8px 14px;font-size:12px;color:#555;margin-bottom:4px">' +
      '<strong>Stock Log</strong> — authoritative transaction history from <strong>OpenLMIS</strong> (DEBIT/CREDIT events). ' +
      '&nbsp;|&nbsp; ' +
      '<strong>App Inventory</strong> — commodity balances stored in <strong>HAPI FHIR</strong> (Observations). ' +
      'This is what the Android app reads to check stock before dispensing. It is a separate, app-side view and may differ from OpenLMIS.' +
    '</div>' +
    '<div id="stock-data"><p aria-busy="true">Loading…</p></div>' +
    '<div id="stock-inventory" hidden></div>' +
    '<div id="stock-statuses" class="help-panel" hidden>' + stockStatusesHTML() + '</div>' +
    '<div id="stock-help" class="help-panel" hidden>' + stockHelpHTML() + '</div>';

  el.querySelectorAll('.page-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('stock-data').hidden      = (target !== 'stock-data');
      document.getElementById('stock-inventory').hidden = (target !== 'stock-inventory');
      document.getElementById('stock-statuses').hidden  = (target !== 'stock-statuses');
      document.getElementById('stock-help').hidden      = (target !== 'stock-help');
      if (target === 'stock-inventory') {
        var invEl = document.getElementById('stock-inventory');
        if (!invEl.dataset.loaded) {
          invEl.dataset.loaded = '1';
          renderAppInventory(invEl);
        }
      }
    });
  });

  Promise.all([
    lmisGet('/api/stockCardSummaries?facility=' + CONFIG.lmisFacility + '&program=' + CONFIG.lmisProgram),
    fhir('MedicationDispense?_count=500&_sort=-_lastUpdated').catch(function() { return { entry: [] }; }),
    fetchMappings().catch(function() { return { performers: {} }; }),
  ]).then(function(results) {
      var summary      = results[0];
      var fhirBundle   = results[1];
      var mappingsData = results[2];

      // Build performer lookup: practitioner ref → { name, village, role }
      var performerMap = {};
      Object.keys(mappingsData.performers || {}).forEach(function(ref) {
        var p = mappingsData.performers[ref];
        var ou = OU_LABELS[p.dhis2OrgUnit] || {};
        performerMap[ref] = { name: p.name || ref, village: ou.village || null, facility: ou.facility || null, role: p.role || 'vhw' };
      });

      // Build FHIR lookup: "YYYY-MM-DD|qty" → [{ patientId, performerRef }]
      var fhirMap = {};
      entries(fhirBundle).forEach(function(d) {
        var date  = d.whenHandedOver ? d.whenHandedOver.slice(0, 10) : null;
        var qty   = d.quantity && d.quantity.value;
        var subj  = d.subject && d.subject.reference;
        var perf  = d.performer && d.performer[0] && d.performer[0].actor && d.performer[0].actor.reference;
        if (date && qty !== undefined && subj) {
          var key = date + '|' + qty;
          if (!fhirMap[key]) fhirMap[key] = [];
          fhirMap[key].push({
            fhirId:       d.id || null,
            patientId:    subj.split('/')[1] || '',
            performerRef: perf || null,
            // Full transaction timestamp: the dispense handover time, else when HAPI recorded it.
            ts:           d.whenHandedOver || (d.meta && d.meta.lastUpdated) || null,
          });
        }
      });

      var dataDiv = document.getElementById('stock-data');
      if (!dataDiv) return;
      var cards = (summary && summary.content) || [];
      if (cards.length === 0) {
        dataDiv.innerHTML =
          '<p style="color:var(--dhis2-text-muted);margin:24px 0">No stock cards found for this facility/program.</p>';
        return;
      }
      return Promise.all(cards.map(function(card) {
        return lmisGet('/api/stockCards/' + card.id).then(function(sc) {
          var product = card.orderable
            ? (card.orderable.fullProductName || card.orderable.productCode || '—')
            : '—';
          var soh = card.stockOnHand !== undefined ? card.stockOnHand : '—';
          return {
            product: product,
            soh:     soh,
            cardId:  card.id || (card.stockCard && card.stockCard.id),
            lineItems: (sc.lineItems || []).map(function(item) {
              var date      = item.occurredDate || '—';
              var qty       = item.quantity !== undefined ? item.quantity : '—';
              var fhirMatch = null;
              if (item.reason && item.reason.reasonType === 'DEBIT' && date !== '—' && qty !== '—') {
                var matches = fhirMap[date + '|' + qty];
                if (matches && matches.length) fhirMatch = matches.shift();
              }
              var perfRef = fhirMatch && fhirMatch.performerRef;
              var perf    = perfRef && performerMap[perfRef];
              return {
                lineItemId: item.id || null,
                date:       date,
                // Full transaction timestamp (when OpenLMIS recorded the event).
                // occurredDate is date-only; OpenLMIS (this version) does not return
                // processedDate via the API, so use the matched FHIR dispense's
                // timestamp (handover time / when HAPI recorded it) for DEBIT rows.
                processedDate: (fhirMatch && fhirMatch.ts) || item.processedDate || null,
                product:    product,
                reasonName: item.reason ? item.reason.name : '—',
                reasonType: item.reason ? item.reason.reasonType : '',
                qty:        qty,
                soh:        item.stockOnHand !== undefined ? item.stockOnHand : soh,
                patientId:  fhirMatch ? fhirMatch.patientId : null,
                vhwName:    perf ? perf.name     : null,
                village:    perf ? perf.village  : null,
                facility:   perf ? perf.facility : null,
                perfRef:    perfRef || null,
                fhirId:     fhirMatch ? fhirMatch.fhirId : null,
              };
            }),
          };
        });
      })).then(function(cardData) {
        // Build flat row list
        var rows = [];
        cardData.forEach(function(cd) { rows = rows.concat(cd.lineItems); });
        // Sort newest-first by full timestamp (processedDate) so same-day events order by time.
        function rowTs(r) { return r.processedDate || ((r.date || '') + 'T00:00:00'); }
        rows.sort(function(a, b) { return rowTs(a) < rowTs(b) ? 1 : -1; });

        // ── Monthly totals (current month) ───────────────────────────────────
        var now       = new Date();
        var monthPfx  = now.toISOString().slice(0, 7); // "YYYY-MM"
        var thisMonth = rows.filter(function(r) { return String(r.date).slice(0, 7) === monthPfx; });
        var dispensed = 0, received = 0;
        thisMonth.forEach(function(r) {
          var q = typeof r.qty === 'number' ? r.qty : parseInt(r.qty, 10) || 0;
          if (r.reasonType === 'DEBIT')  dispensed += q;
          if (r.reasonType === 'CREDIT') received  += q;
        });
        var net = received - dispensed;

        // ── SOH summary cards ────────────────────────────────────────────────
        var sohCards = cardData.map(function(cd) {
          var soh = typeof cd.soh === 'number' ? cd.soh : null;
          var statusColor, statusLabel;
          if (soh === null || soh === undefined) {
            statusColor = '#9e9e9e'; statusLabel = 'Unknown';
          } else if (soh <= 0) {
            statusColor = '#c62828'; statusLabel = 'Stock-out';
          } else if (soh < 100) {
            statusColor = '#e65100'; statusLabel = 'Low stock';
          } else {
            statusColor = '#2e7d32'; statusLabel = 'Adequate';
          }
          return '<div style="background:#fff;border:1px solid #e0e0e0;border-top:4px solid ' + statusColor + ';' +
            'border-radius:4px;padding:16px 20px;min-width:200px;flex:1">' +
            '<div style="font-size:12px;color:#757575;margin-bottom:4px">' + esc(cd.product) + '</div>' +
            '<div style="font-size:36px;font-weight:700;color:' + statusColor + ';line-height:1">' +
              (soh !== null ? soh : '—') +
            '</div>' +
            '<div style="font-size:11px;margin-top:4px">' +
              '<span style="background:' + statusColor + ';color:#fff;padding:1px 6px;border-radius:10px">' +
                statusLabel +
              '</span>' +
            '</div>' +
          '</div>';
        }).join('');

        // ── Monthly stat pills ───────────────────────────────────────────────
        var monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });
        var statBar =
          '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">' +
            '<div style="background:#e8f5e9;border-radius:6px;padding:10px 16px;min-width:120px">' +
              '<div style="font-size:11px;color:#388e3c;font-weight:600">RECEIVED ' + monthLabel + '</div>' +
              '<div style="font-size:24px;font-weight:700;color:#2e7d32">+' + received + '</div>' +
            '</div>' +
            '<div style="background:#fce4ec;border-radius:6px;padding:10px 16px;min-width:120px">' +
              '<div style="font-size:11px;color:#c62828;font-weight:600">DISPENSED ' + monthLabel + '</div>' +
              '<div style="font-size:24px;font-weight:700;color:#b71c1c">-' + dispensed + '</div>' +
            '</div>' +
            '<div style="background:#f3f4f6;border-radius:6px;padding:10px 16px;min-width:120px">' +
              '<div style="font-size:11px;color:#555;font-weight:600">NET CHANGE</div>' +
              '<div style="font-size:24px;font-weight:700;color:' + (net >= 0 ? '#2e7d32' : '#b71c1c') + '">' +
                (net >= 0 ? '+' : '') + net +
              '</div>' +
            '</div>' +
            '<div style="background:#f3f4f6;border-radius:6px;padding:10px 16px;min-width:120px">' +
              '<div style="font-size:11px;color:#555;font-weight:600">TRANSACTIONS ' + monthLabel + '</div>' +
              '<div style="font-size:24px;font-weight:700;color:#333">' + thisMonth.length + '</div>' +
            '</div>' +
          '</div>';

        var fetchedAt  = new Date().toLocaleString();
        var stockPageSize = 25;
        var stockOffset   = 0;
        // Hard-delete is coordinator/admin-only (removes the OpenLMIS line item + recomputes SOH).
        var canDelete = (window.BKM_ROLE === 'coordinator' || window.BKM_ROLE === 'admin');

        function stockRowHtml(r) {
          var typeBadge = r.reasonType === 'CREDIT'
            ? '<span class="badge green">' + esc(r.reasonName) + '</span>'
            : '<span class="badge red">'   + esc(r.reasonName) + '</span>';
          var patientCell = r.patientId
            ? '<a href="#/patients/' + esc(r.patientId) + '" style="font-size:12px">' + esc(r.patientId) + '</a>'
            : '<span style="color:#bbb;font-size:12px">—</span>';
          var vhwCell = r.vhwName
            ? '<span style="font-size:12px">' + esc(r.vhwName) + '</span>'
            : '<span style="color:#bbb;font-size:12px">—</span>';
          var villageCell = r.village
            ? '<span style="font-size:12px">' + esc(r.village) + '</span>'
            : '<span style="color:#bbb;font-size:12px">—</span>';
          var facilityCell = r.facility
            ? '<span style="font-size:12px">' + esc(r.facility) + '</span>'
            : '<span style="color:#bbb;font-size:12px">—</span>';
          // Show the full transaction timestamp (processedDate) when available; the
          // date alone otherwise. occurredDate is date-only, so it falls back to that.
          var whenCell = r.processedDate
            ? '<span title="' + esc(r.processedDate) + '">' + esc(new Date(r.processedDate).toLocaleString()) + '</span>'
            : esc(r.date);
          var delCell = '';
          if (canDelete) {
            delCell = r.lineItemId
              ? '<td><button class="btn btn-sm stock-del" data-id="' + esc(r.lineItemId) + '" data-fhir="' + esc(r.fhirId || '') + '" data-prod="' + esc(r.product) + '" title="Permanently delete this transaction and recalculate stock on hand" style="color:#c62828;border:1px solid #e0a0a0;background:#fff;padding:2px 10px;border-radius:4px;cursor:pointer">Delete</button></td>'
              : '<td><span style="color:#ccc;font-size:12px">—</span></td>';
          }
          return '<tr>' +
            '<td>' + whenCell + '</td>' +
            '<td>' + esc(r.product) + '</td>' +
            '<td>' + typeBadge + '</td>' +
            '<td>' + esc(String(r.qty)) + '</td>' +
            '<td>' + esc(String(r.soh)) + '</td>' +
            '<td>' + patientCell + '</td>' +
            '<td>' + vhwCell + '</td>' +
            '<td>' + villageCell + '</td>' +
            '<td>' + facilityCell + '</td>' +
            delCell +
            '</tr>';
        }

        function renderStockTable(filtered, offset, pageSize) {
          var page  = filtered.slice(offset, offset + pageSize);
          var total = filtered.length;
          var cols  = [
            'Date / Time <span class="help-tip" title="Full transaction timestamp recorded in OpenLMIS (processedDate). Falls back to the date when no time is available.">?</span>',
            'Product <span class="help-tip" title="Medicine name from OpenLMIS.">?</span>',
            'Type <span class="help-tip" title="CREDIT = received, DEBIT = dispensed.">?</span>',
            'Qty <span class="help-tip" title="Units in this transaction.">?</span>',
            'Stock on Hand <span class="help-tip" title="Running balance after this transaction.">?</span>',
            'Patient <span class="help-tip" title="Matched from FHIR MedicationDispense by date and quantity.">?</span>',
            'VHW <span class="help-tip" title="Village Health Worker who recorded the dispense.">?</span>',
            'Village <span class="help-tip" title="Catchment village of the VHW.">?</span>',
            'Facility <span class="help-tip" title="Health facility the stock is held at.">?</span>',
          ];
          if (canDelete) cols.push('Actions <span class="help-tip" title="Permanently delete a transaction from OpenLMIS and recompute stock on hand. Irreversible.">?</span>');
          var pager =
            '<div class="pager">' +
              '<span class="pager-info">Showing ' + (total ? offset + 1 : 0) + '–' + Math.min(offset + pageSize, total) + ' of ' + total + '</span>' +
              '<div class="pager-btns">' +
                '<button class="btn btn-sm btn-outline" id="stock-prev"' + (offset > 0 ? '' : ' disabled') + '>← Prev</button>' +
                '<button class="btn btn-sm btn-outline" id="stock-next"' + (offset + pageSize < total ? '' : ' disabled') + '>Next →</button>' +
              '</div>' +
            '</div>';
          document.getElementById('stock-table').innerHTML =
            table(cols, page.map(stockRowHtml), 'No stock transactions found.') + pager;

          var prevBtn = document.getElementById('stock-prev');
          var nextBtn = document.getElementById('stock-next');
          if (prevBtn) prevBtn.onclick = function() { renderStockTable(filtered, offset - pageSize, pageSize); };
          if (nextBtn) nextBtn.onclick = function() { renderStockTable(filtered, offset + pageSize, pageSize); };

          // Delete buttons (supervisor only) — hard-delete the OpenLMIS line item + recalc SOH.
          var tableEl = document.getElementById('stock-table');
          if (canDelete && tableEl) {
            tableEl.onclick = function(ev) {
              var btn = ev.target.closest && ev.target.closest('button.stock-del');
              if (!btn) return;
              var id   = btn.getAttribute('data-id');
              var fhir = btn.getAttribute('data-fhir') || '';
              var prod = btn.getAttribute('data-prod') || 'stock';
              if (!confirm('Permanently delete this ' + prod + ' transaction from OpenLMIS and recompute Stock on Hand?\n\nThis cannot be undone.')) return;
              btn.disabled = true;
              btn.textContent = 'Deleting…';
              var url = 'aggregate/stock-admin/line-item/' + encodeURIComponent(id) +
                        (fhir ? '?fhirId=' + encodeURIComponent(fhir) : '');
              mediatorFetch(url, { method: 'DELETE' })
                .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
                .then(function(res) {
                  if (!res.ok || (res.d && res.d.status && res.d.status !== 'ok')) {
                    throw new Error((res.d && res.d.message) || 'delete failed');
                  }
                  renderStock(el); // reload from OpenLMIS with the recalculated SOH
                })
                .catch(function(err) {
                  alert('Delete failed: ' + err.message);
                  btn.disabled = false;
                  btn.textContent = 'Delete';
                });
            };
          }
        }

        function getFiltered() {
          var q      = (document.getElementById('stock-search').value || '').toLowerCase();
          var from   = document.getElementById('stock-from').value;
          var to     = document.getElementById('stock-to').value;
          var vhwSel = document.getElementById('stock-vhw').value;
          return rows.filter(function(r) {
            var dateOk = (!from || r.date >= from) && (!to || r.date <= to);
            var textOk = !q || (r.product.toLowerCase() + ' ' + r.reasonName.toLowerCase()).indexOf(q) !== -1;
            var vhwOk  = !vhwSel || r.perfRef === vhwSel || r.village === vhwSel;
            return dateOk && textOk && vhwOk;
          });
        }

        function applyFilters() {
          renderStockTable(getFiltered(), 0, stockPageSize);
        }

        dataDiv.innerHTML =
          '<p style="margin:0 0 16px;font-size:12px;color:var(--dhis2-text-muted);text-align:right">' +
            'Data as of ' + esc(fetchedAt) +
            ' &mdash; <a href="#" id="stock-refresh" style="color:var(--dhis2-blue)">Refresh</a>' +
          '</p>' +
          '<h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#757575">Stock on Hand</h3>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' + sohCards + '</div>' +
          '<h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#757575">Monthly Summary</h3>' +
          statBar +
          (function() {
            var vhwOptions = '<option value="">All VHWs / Villages</option>';
            var seenVillages = {};
            Object.keys(performerMap).forEach(function(ref) {
              var p = performerMap[ref];
              vhwOptions += '<option value="' + esc(ref) + '">' + esc(p.name || ref) + '</option>';
              if (p.village && !seenVillages[p.village]) {
                seenVillages[p.village] = true;
                vhwOptions += '<option value="' + esc(p.village) + '">📍 ' + esc(p.village) + '</option>';
              }
            });
            return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:0">' +
              '<h3 id="stock-log-toggle" style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#757575;cursor:pointer;user-select:none">' +
                '<span id="stock-log-arrow">▶</span> Transaction Log ' + badge(rows.length) +
              '</h3>' +
            '</div>' +
            '<div id="stock-log-body" style="display:none">' +
              '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0">' +
                '<input type="search" id="stock-search" placeholder="Filter by product or type…" style="min-width:180px">' +
                '<select id="stock-vhw" style="width:auto;font-size:13px">' + vhwOptions + '</select>' +
                '<input type="date" id="stock-from" title="From date" style="font-size:13px;padding:4px 8px;border:1px solid #ccc;border-radius:4px">' +
                '<span style="font-size:12px;color:#757575">to</span>' +
                '<input type="date" id="stock-to" title="To date" style="font-size:13px;padding:4px 8px;border:1px solid #ccc;border-radius:4px">' +
                '<select id="stock-pagesize" style="width:auto;font-size:13px">' +
                  [25,50,100].map(function(n) { return '<option value="' + n + '"' + (n === stockPageSize ? ' selected' : '') + '>' + n + ' per page</option>'; }).join('') +
                '</select>' +
              '</div>' +
              '<div id="stock-table"></div>' +
            '</div>';
          })();

        renderStockTable(rows, 0, stockPageSize);

        var logToggle = document.getElementById('stock-log-toggle');
        var logBody   = document.getElementById('stock-log-body');
        var logArrow  = document.getElementById('stock-log-arrow');
        if (logToggle && logBody) {
          logToggle.addEventListener('click', function() {
            var open = logBody.style.display !== 'none';
            logBody.style.display = open ? 'none' : '';
            if (logArrow) logArrow.textContent = open ? '▶' : '▼';
          });
        }

        document.getElementById('stock-search').addEventListener('input', applyFilters);
        document.getElementById('stock-vhw').addEventListener('change', applyFilters);
        document.getElementById('stock-from').addEventListener('change', applyFilters);
        document.getElementById('stock-to').addEventListener('change', applyFilters);
        document.getElementById('stock-pagesize').addEventListener('change', function() {
          stockPageSize = parseInt(this.value, 10);
          applyFilters();
        });

        document.getElementById('stock-refresh').addEventListener('click', function(e) {
          e.preventDefault();
          renderStock(el);
        });
      });
  }).catch(function(e) { var d = document.getElementById('stock-data'); if (d) errMsg(d, e.message); });
}
