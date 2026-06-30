/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// App Inventory view (FHIR Observations/Flags/MeasureReports) for #/stock.
// Split out of stock.js. Uses globals (fhir, esc, showModal, renderStock, etc.).

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
