/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

function fhirHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>A live browser for all <strong>FHIR R4 resources</strong> stored in <strong>HAPI FHIR</strong> ' +
      '(port 8079). It has two tabs:</p>' +
      '<ul>' +
        '<li><strong>Explorer</strong> — click any resource-type chip to inspect raw records. ' +
        'The count badge on each chip is fetched on page load using <code>?_summary=count</code>.</li>' +
        '<li><strong>Stock by Facility</strong> — a pre-built view that cross-references commodity ' +
        '<code>Group</code> resources, stock <code>Observation</code>s, and <code>MeasureReport</code>s ' +
        'to show Balance / AMC / MOS / Status per commodity for every facility. ' +
        'Each facility row is collapsed by default; click to expand.</li>' +
      '</ul>' +
      '<p>HAPI FHIR is the clinical and administrative backbone of this sandbox — the Android BKM app ' +
      'reads and writes FHIR resources here, and the mediator resolves practitioner → facility/village ' +
      'mappings from PractitionerRole records.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Stock by Facility — how it works</h4>' +
      '<p>The tab fetches four resource types and joins them in the browser:</p>' +
      '<table>' +
        '<thead><tr><th>Resource</th><th>Query</th><th>Used for</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><code>Organization</code></td><td><code>?_count=100</code></td><td>Facility names</td></tr>' +
          '<tr><td><code>Group</code></td><td><code>?type=device&amp;_count=200</code></td><td>Commodity names (one Group per medicine)</td></tr>' +
          '<tr><td><code>Observation</code></td><td><code>?status=preliminary&amp;_count=500</code></td>' +
            '<td>Stock balance — <code>subject</code> = Group, <code>performer</code> = Organization, ' +
            '<code>component.valueQuantity.value</code> = units on hand</td></tr>' +
          '<tr><td><code>MeasureReport</code></td><td><code>?_count=200</code></td>' +
            '<td>Average Monthly Consumption (AMC) — stored as a contained <code>Medication.code.coding[0].code</code></td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p style="margin-top:8px">MOS (Months of Stock) = Balance ÷ AMC. Status thresholds:</p>' +
      '<ul>' +
        '<li><strong style="color:#DD0000">Stockout</strong> — MOS &le; 0.5</li>' +
        '<li><strong style="color:#FFA500">Understock</strong> — MOS &lt; 1</li>' +
        '<li><strong style="color:#38B500">Satisfactory</strong> — MOS 1–3</li>' +
        '<li><strong style="color:#006EB8">Overstock</strong> — MOS &gt; 3</li>' +
      '</ul>' +
      '<p>Commodities are seeded by <code>scripts/seed_inventory.py</code> and the Group JSON files ' +
      'in <code>config/fhir-bkm/fhir_content/group/commodities/</code>. ' +
      'Re-run <code>python scripts/seed_inventory.py</code> after a <code>make reset</code> to restore balances.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Explorer — resource types</h4>' +
      '<table>' +
        '<thead><tr><th>Type</th><th>What it stores</th></tr></thead>' +
        '<tbody>' +
          '<tr><td><strong>Patient</strong></td><td>Community members registered in the BKM system — selected by VHWs when dispensing</td></tr>' +
          '<tr><td><strong>Practitioner</strong></td><td>Health workers: VHWs, facility workers, supervisors</td></tr>' +
          '<tr><td><strong>PractitionerRole</strong></td><td>Links a Practitioner to an Organization and Location; defines their role code</td></tr>' +
          '<tr><td><strong>Organization</strong></td><td>Health facilities (e.g. Maseru District Clinic A)</td></tr>' +
          '<tr><td><strong>Location</strong></td><td>Geographic hierarchy: country → district → facility → village</td></tr>' +
          '<tr><td><strong>Group</strong></td><td>Two uses: (1) patient panels assigned to a VHW catchment area; (2) commodity groups (<code>type=device</code>) used by the inventory system</td></tr>' +
          '<tr><td><strong>CareTeam</strong></td><td>Groups of practitioners working together under a supervisor</td></tr>' +
          '<tr><td><strong>Observation</strong></td><td>Stock balance records — one per commodity per facility, updated by <code>seed_inventory.py</code> or when a dispense is recorded through the app</td></tr>' +
          '<tr><td><strong>MeasureReport</strong></td><td>Average Monthly Consumption (AMC) — one per commodity, shared across facilities</td></tr>' +
          '<tr><td><strong>Questionnaire</strong></td><td>Form definitions used by the Android app (dispense, receipt, order, adjustment)</td></tr>' +
          '<tr><td><strong>QuestionnaireResponse</strong></td><td>Completed form submissions from the Android app — trigger the mediator fan-out pipeline</td></tr>' +
          '<tr><td><strong>MedicationDispense</strong></td><td>Direct dispense events (alternative entry point to the mediator alongside QR)</td></tr>' +
          '<tr><td><strong>Task</strong></td><td>Stock-issue instructions sent to a practitioner\'s device (created by the mediator after dispatch)</td></tr>' +
          '<tr><td><strong>Binary / ImplementationGuide</strong></td><td>App configuration bundles and FHIR IG metadata loaded by the Android app on first sync</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Delete buttons</h4>' +
      '<p>The red buttons in the page header bulk-delete all resources of that type from HAPI FHIR. ' +
      'Use with care — deletions are immediate and cannot be undone without running <code>make seed</code>.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>All reads use <code>GET http://localhost:8079/fhir/{ResourceType}</code> ' +
      'authenticated via the Keycloak token (opensrp realm, opensrp-admin user). ' +
      'The dedicated pages (Patients, Practitioners, Locations, etc.) in the sidebar provide ' +
      'richer views with create/edit/delete for each type.</p>' +
    '</div>'
  );
}

function fhirDeleteAll(resourceType, el) {
  if (window.BKM_ROLE !== 'admin') { alert('Only an administrator (bkm-admin) can edit FHIR resources.'); return; }
  if (!confirm('Delete ALL ' + resourceType + ' resources from HAPI FHIR?\n\nThis cannot be undone.')) return;
  fhir(resourceType + '?_count=1000&_elements=id').then(function(data) {
    var ids = (data.entry || []).map(function(e) { return e.resource && e.resource.id; }).filter(Boolean);
    if (ids.length === 0) { alert('No ' + resourceType + ' resources found.'); return; }
    return Promise.all(ids.map(function(id) {
      return fetch('/mediator-api/fhir/' + resourceType + '/' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + kc.token },
      });
    }))
      .then(function() {
        alert('Deleted ' + ids.length + ' ' + resourceType + ' resource' + (ids.length !== 1 ? 's' : '') + '.');
        renderFHIR(el);
      });
  }).catch(function(e) { alert('Error deleting ' + resourceType + ': ' + e.message); });
}

function renderFHIR(el) {
  el.innerHTML =
    '<div class="page-header"><h2>FHIR Resources (BKM DB)</h2>' +
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      // FHIR resources are edit-locked: only an administrator (bkm-admin) may
      // delete/modify; everyone else (coordinator) gets a read-only explorer.
      (window.BKM_ROLE === 'admin'
        ? '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" ' +
            'onclick="fhirDeleteAll(\'QuestionnaireResponse\', document.getElementById(\'content\'))">&#128465; Q Responses</button>' +
          // 'Delete all Questionnaires' button removed per request — deleting Questionnaires
          // would wipe the app's forms (dispense, receipt, order, adjustment):
          // '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" ' +
          //   'onclick="fhirDeleteAll(\'Questionnaire\', document.getElementById(\'content\'))">&#128465; Questionnaires</button>' +
          '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" ' +
            'onclick="fhirDeleteAll(\'MedicationDispense\', document.getElementById(\'content\'))">&#128465; Dispenses</button>' +
          '<button class="btn btn-sm" style="background:#fce4ec;color:#c62828;border-color:#f48fb1" ' +
            'onclick="fhirDeleteAll(\'Task\', document.getElementById(\'content\'))">&#128465; Tasks</button>'
        : '<span style="color:var(--dhis2-text-muted);font-size:12px">Read-only — only an administrator can edit FHIR resources.</span>') +
    '</div>' +
    '</div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab active" data-tab="fhir-data">Explorer</button>' +
      '<button class="page-tab" data-tab="fhir-stock">&#128230; Stock by Facility</button>' +
      '<button class="page-tab" data-tab="fhir-help">? Help</button>' +
    '</div>' +
    '<div id="fhir-data">' +
      '<div id="fhir-summary" class="fhir-summary-row"></div>' +
      '<div id="fhir-detail" style="margin-top:8px"></div>' +
    '</div>' +
    '<div id="fhir-stock" hidden></div>' +
    '<div id="fhir-help" class="help-panel" hidden>' + fhirHelpHTML() + '</div>';

  wirePageTabs(el);

  // Lazy-load stock view on first click
  var stockTab = el.querySelector('[data-tab="fhir-stock"]');
  if (stockTab) {
    stockTab.addEventListener('click', function() {
      var stockEl = document.getElementById('fhir-stock');
      if (stockEl && !stockEl.dataset.loaded) {
        stockEl.dataset.loaded = '1';
        renderFhirStockByFacility(stockEl);
      }
    });
  }

  var TYPES = [
    { type: 'Patient',               label: 'Patients',           icon: '&#128100;' },
    { type: 'Practitioner',          label: 'Practitioners',      icon: '&#129658;' },
    { type: 'PractitionerRole',      label: 'Practitioner Roles', icon: '&#128203;' },
    { type: 'Organization',          label: 'Organizations',      icon: '&#127970;' },
    { type: 'Location',              label: 'Locations',          icon: '&#128205;' },
    { type: 'Group',                 label: 'Groups',             icon: '&#128101;' },
    { type: 'CareTeam',              label: 'Care Teams',         icon: '&#129657;' },
    { type: 'Questionnaire',         label: 'Questionnaires',     icon: '&#128196;' },
    { type: 'QuestionnaireResponse', label: 'Q Responses',        icon: '&#9989;' },
    { type: 'MedicationDispense',    label: 'Dispenses',          icon: '&#128138;' },
    { type: 'Task',                  label: 'Tasks',              icon: '&#9989;' },
    { type: 'Binary',                label: 'Binaries',           icon: '&#128190;' },
    { type: 'ImplementationGuide',   label: 'Impl. Guides',       icon: '&#128218;' },
  ];

  var sumEl    = document.getElementById('fhir-summary');
  var detailEl = document.getElementById('fhir-detail');

  sumEl.innerHTML = TYPES.map(function(t) {
    return '<div class="fhir-chip" id="chip-' + t.type + '">' +
      '<span class="fhir-chip-icon">' + t.icon + '</span>' +
      '<span class="fhir-chip-label">' + t.label + '</span>' +
      '<span class="fhir-chip-count" id="chip-count-' + t.type + '">…</span>' +
    '</div>';
  }).join('');

  // Wire click handlers
  TYPES.forEach(function(t) {
    var chip = document.getElementById('chip-' + t.type);
    if (!chip) return;
    chip.addEventListener('click', function() {
      sumEl.querySelectorAll('.fhir-chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      fhirLoadDetail(t.type, t.label, detailEl);
    });
  });

  // Fetch counts (stream in as each resolves)
  TYPES.forEach(function(t) {
    fhir(t.type + '?_summary=count')
      .then(function(b) {
        var n = b.total !== undefined ? b.total : (b.entry ? b.entry.length : '?');
        var c = document.getElementById('chip-count-' + t.type);
        if (c) c.textContent = n;
      })
      .catch(function() {
        var c = document.getElementById('chip-count-' + t.type);
        if (c) { c.textContent = '!'; c.style.background = '#f8cecc'; c.style.color = '#c62828'; }
      });
  });
}

function fhirLoadDetail(type, label, detailEl) {
  detailEl.innerHTML = '<article><p aria-busy="true">Loading ' + esc(label) + '…</p></article>';
  kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/' + type + '?_count=200', {
        headers: { Authorization: 'Bearer ' + kc.token, Accept: 'application/fhir+json' },
      });
    })
    .then(function(res) {
      if (!res.ok) throw new Error('FHIR ' + res.status);
      return res.json();
    })
    .then(function(b) {
      detailEl.innerHTML = fhirSection(label, fhirRenderType(type, entries(b)));
      detailEl.querySelectorAll('[data-binary-id]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          fhirShowBinary(btn.getAttribute('data-binary-id'), btn.getAttribute('data-binary-ct'));
        });
      });
    })
    .catch(function(e) {
      detailEl.innerHTML = '<article><p class="err">Error loading ' + esc(label) + ': ' + esc(e.message) + '</p></article>';
    });
}

function fhirRenderType(type, resources) {
  if (type === 'Patient') {
    return table(
      ['ID', 'Name', 'DOB', 'Gender', 'Phone', 'Village'],
      resources.map(function(p) {
        var n = p.name && p.name[0];
        var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
        var family = n ? (n.family || '') : '';
        var phone  = '';
        if (p.telecom) { for (var i = 0; i < p.telecom.length; i++) { if (p.telecom[i].system === 'phone') { phone = p.telecom[i].value; break; } } }
        var addr = p.address && p.address[0];
        return '<tr>' +
          '<td><code>' + esc(p.id) + '</code></td>' +
          '<td>' + esc([given, family].filter(Boolean).join(' ') || '—') + '</td>' +
          '<td>' + esc(p.birthDate || '') + '</td>' +
          '<td>' + esc(p.gender || '') + '</td>' +
          '<td>' + esc(phone) + '</td>' +
          '<td>' + esc((addr && addr.district) || '') + '</td>' +
          '</tr>';
      }),
      'No patients.'
    );
  }
  if (type === 'Practitioner') {
    return table(
      ['ID', 'Name', 'Qualification', 'Active'],
      resources.map(function(p) {
        var n = p.name && p.name[0];
        var given  = n ? (Array.isArray(n.given) ? n.given.join(' ') : (n.given || '')) : '';
        var family = n ? (n.family || '') : '';
        var qual   = p.qualification && p.qualification[0] && p.qualification[0].code && p.qualification[0].code.text || '';
        return '<tr>' +
          '<td><code>' + esc(p.id) + '</code></td>' +
          '<td>' + esc([given, family].filter(Boolean).join(' ') || '—') + '</td>' +
          '<td>' + esc(qual) + '</td>' +
          '<td>' + badge(p.active !== false ? 'Active' : 'Inactive', p.active !== false ? 'active' : 'inactive') + '</td>' +
          '</tr>';
      }),
      'No practitioners.'
    );
  }
  if (type === 'PractitionerRole') {
    return table(
      ['ID', 'Practitioner', 'Organization', 'Code', 'Active'],
      resources.map(function(r) {
        var code = r.code && r.code[0] && r.code[0].coding && r.code[0].coding[0];
        return '<tr>' +
          '<td><code>' + esc(r.id) + '</code></td>' +
          '<td>' + esc((r.practitioner && r.practitioner.reference) || '') + '</td>' +
          '<td>' + esc((r.organization && r.organization.reference) || '') + '</td>' +
          '<td>' + esc((code && (code.display || code.code)) || '') + '</td>' +
          '<td>' + badge(r.active !== false ? 'Active' : 'Inactive', r.active !== false ? 'active' : 'inactive') + '</td>' +
          '</tr>';
      }),
      'No practitioner roles.'
    );
  }
  if (type === 'Organization') {
    return table(
      ['ID', 'Name', 'Type', 'Active'],
      resources.map(function(o) {
        var t2 = o.type && o.type[0] && o.type[0].coding && o.type[0].coding[0];
        return '<tr>' +
          '<td><code>' + esc(o.id) + '</code></td>' +
          '<td>' + esc(o.name || '') + '</td>' +
          '<td>' + esc((t2 && (t2.display || t2.code)) || '') + '</td>' +
          '<td>' + badge(o.active !== false ? 'Active' : 'Inactive', o.active !== false ? 'active' : 'inactive') + '</td>' +
          '</tr>';
      }),
      'No organizations.'
    );
  }
  if (type === 'Location') {
    return table(
      ['ID', 'Name', 'Status', 'Part Of'],
      resources.map(function(l) {
        return '<tr>' +
          '<td><code>' + esc(l.id) + '</code></td>' +
          '<td>' + esc(l.name || '') + '</td>' +
          '<td>' + badge(l.status || '', l.status === 'active' ? 'active' : 'inactive') + '</td>' +
          '<td>' + esc((l.partOf && l.partOf.reference) || '') + '</td>' +
          '</tr>';
      }),
      'No locations.'
    );
  }
  if (type === 'Group') {
    return table(
      ['ID', 'Name', 'Type', 'Members', 'Active'],
      resources.map(function(g) {
        return '<tr>' +
          '<td><code>' + esc(g.id) + '</code></td>' +
          '<td>' + esc(g.name || '') + '</td>' +
          '<td>' + esc(g.type || '') + '</td>' +
          '<td><strong>' + (g.member || []).length + '</strong></td>' +
          '<td>' + badge(g.active !== false ? 'Active' : 'Inactive', g.active !== false ? 'active' : 'inactive') + '</td>' +
          '</tr>';
      }),
      'No groups.'
    );
  }
  if (type === 'CareTeam') {
    return table(
      ['ID', 'Name', 'Status', 'Participants', 'Managing Org'],
      resources.map(function(ct) {
        return '<tr>' +
          '<td><code>' + esc(ct.id) + '</code></td>' +
          '<td>' + esc(ct.name || '') + '</td>' +
          '<td>' + badge(ct.status || '', ct.status === 'active' ? 'active' : 'inactive') + '</td>' +
          '<td><strong>' + (ct.participant || []).length + '</strong></td>' +
          '<td>' + esc((ct.managingOrganization && ct.managingOrganization[0] && ct.managingOrganization[0].reference) || '') + '</td>' +
          '</tr>';
      }),
      'No care teams.'
    );
  }
  if (type === 'Questionnaire') {
    return table(
      ['ID', 'Title', 'Status', 'Items'],
      resources.map(function(q) {
        return '<tr>' +
          '<td><code>' + esc(q.id) + '</code></td>' +
          '<td>' + esc(q.title || q.name || '—') + '</td>' +
          '<td>' + badge(q.status || '', q.status === 'active' ? 'active' : 'inactive') + '</td>' +
          '<td>' + (q.item || []).length + '</td>' +
          '</tr>';
      }),
      'No questionnaires.'
    );
  }
  if (type === 'QuestionnaireResponse') {
    return table(
      ['ID', 'Questionnaire', 'Subject', 'Status', 'Authored'],
      resources.map(function(qr) {
        return '<tr>' +
          '<td><code>' + esc(qr.id) + '</code></td>' +
          '<td>' + esc(qr.questionnaire || '—') + '</td>' +
          '<td>' + esc((qr.subject && qr.subject.reference) || '—') + '</td>' +
          '<td>' + badge(qr.status || '', qr.status === 'completed' ? 'active' : 'inactive') + '</td>' +
          '<td>' + esc(fmtDate(qr.authored || '')) + '</td>' +
          '</tr>';
      }),
      'No questionnaire responses.'
    );
  }
  if (type === 'MedicationDispense') {
    var sorted = resources.slice().sort(function(a, b) {
      return (b.whenHandedOver || '').localeCompare(a.whenHandedOver || '');
    });
    return table(
      ['When', 'Patient', 'Performer', 'Medication', 'Qty', 'Status'],
      sorted.slice(0, 50).map(function(md) {
        var medCC   = md.medicationCodeableConcept;
        var coding  = medCC && medCC.coding && medCC.coding[0];
        var medName = (coding && (coding.display || coding.code)) || (medCC && medCC.text) || '';
        var qty     = md.quantity;
        // Performer: standard FHIR path first, then smartregister meta tag fallback
        var perfRef = md.performer && md.performer[0] && md.performer[0].actor && md.performer[0].actor.reference;
        if (!perfRef) {
          var pracTag = (md.meta && md.meta.tag || []).find(function(t) {
            return t.system === 'https://smartregister.org/practitioner-tag-id';
          });
          perfRef = pracTag && pracTag.code !== 'Not defined' ? pracTag.code : '';
        }
        return '<tr>' +
          '<td>' + esc(fmtDate(md.whenHandedOver || '')) + '</td>' +
          '<td>' + esc((md.subject && md.subject.reference) || '') + '</td>' +
          '<td>' + esc(perfRef || '') + '</td>' +
          '<td>' + esc(medName) + '</td>' +
          '<td>' + esc((qty && qty.value + ' ' + (qty.unit || '')) || '') + '</td>' +
          '<td>' + badge(md.status || '', md.status === 'completed' ? 'active' : '') + '</td>' +
          '</tr>';
      }),
      'No dispense records.'
    );
  }
  if (type === 'Task') {
    return table(
      ['ID', 'Status', 'For / Owner', 'Description', 'Authored'],
      resources.map(function(t) {
        var forRef   = (t.for   && t.for.reference)   || '';
        var ownerRef = (t.owner && t.owner.reference) || '';
        var ref      = forRef || ownerRef || '—';
        return '<tr>' +
          '<td><code>' + esc(t.id) + '</code></td>' +
          '<td>' + badge(t.status || '', t.status === 'completed' ? 'active' : 'inactive') + '</td>' +
          '<td>' + esc(ref) + '</td>' +
          '<td style="font-size:12px">' + esc((t.description || '').substring(0, 80)) + '</td>' +
          '<td>' + esc(fmtDate(t.authoredOn || '')) + '</td>' +
          '</tr>';
      }),
      'No tasks.'
    );
  }
  if (type === 'Binary') {
    return table(
      ['ID', 'Content Type', 'Last Updated', ''],
      resources.map(function(b) {
        var lu = b.meta && b.meta.lastUpdated ? fmtDate(b.meta.lastUpdated) : '—';
        return '<tr>' +
          '<td><code>' + esc(b.id) + '</code></td>' +
          '<td>' + esc(b.contentType || '—') + '</td>' +
          '<td>' + lu + '</td>' +
          '<td><button class="btn btn-outline btn-sm" data-binary-id="' + esc(b.id) + '" data-binary-ct="' + esc(b.contentType || '') + '">Decode</button></td>' +
          '</tr>';
      }),
      'No binaries.'
    );
  }
  if (type === 'ImplementationGuide') {
    return table(
      ['ID', 'Name', 'Title', 'Status', 'Version'],
      resources.map(function(ig) {
        return '<tr>' +
          '<td><code>' + esc(ig.id) + '</code></td>' +
          '<td>' + esc(ig.name || '—') + '</td>' +
          '<td>' + esc(ig.title || '—') + '</td>' +
          '<td>' + badge(ig.status || '', ig.status === 'active' ? 'active' : 'inactive') + '</td>' +
          '<td>' + esc(ig.version || '—') + '</td>' +
          '</tr>';
      }),
      'No implementation guides.'
    );
  }
  // Fallback
  return table(
    ['ID', 'Resource Type'],
    resources.map(function(r) {
      return '<tr>' +
        '<td><code>' + esc(r.id) + '</code></td>' +
        '<td>' + esc(r.resourceType || type) + '</td>' +
        '</tr>';
    }),
    'No resources.'
  );
}

function fhirSection(title, bodyHtml) {
  return '<article>' +
    '<h3 style="margin:0 0 12px">' + esc(title) + '</h3>' +
    bodyHtml +
    '</article>';
}

function renderFhirStockByFacility(el) {
  el.innerHTML = '<p aria-busy="true">Loading stock data…</p>';

  Promise.all([
    fhir('Organization?_count=100').catch(function() { return { entry: [] }; }),
    fhir('Group?type=device&_count=200').catch(function() { return { entry: [] }; }),
    fhir('Observation?status=preliminary&_count=500').catch(function() { return { entry: [] }; }),
    fhir('MeasureReport?_count=200').catch(function() { return { entry: [] }; }),
  ]).then(function(results) {
    var orgs  = entries(results[0]);
    var groups = entries(results[1]);
    var obs    = entries(results[2]);
    var mrs    = entries(results[3]);

    if (groups.length === 0) {
      el.innerHTML =
        '<p style="color:var(--dhis2-text-muted);margin:24px 0">' +
          'No commodity groups found. ' +
          '<a href="#" id="fhir-stock-retry" style="color:var(--dhis2-blue)">Retry</a>' +
        '</p>';
      document.getElementById('fhir-stock-retry').addEventListener('click', function(e) {
        e.preventDefault(); el.dataset.loaded = ''; renderFhirStockByFacility(el);
      });
      return;
    }

    // Build maps
    var orgMap = {};  // "Organization/id" → name
    orgs.forEach(function(o) { orgMap['Organization/' + o.id] = o.name || o.id; });

    var mrMap = {};   // "Group/id" → amc
    mrs.forEach(function(mr) {
      var ref = mr.subject && mr.subject.reference;
      if (!ref) return;
      var cod = mr.contained && mr.contained[0] && mr.contained[0].code && mr.contained[0].code.coding;
      if (cod && cod[0]) mrMap[ref] = parseFloat(cod[0].code);
    });

    // obsMap["Group/id"]["Organization/id"] → balance
    var obsMap = {};
    var facilitySet = {};
    obs.forEach(function(o) {
      var gRef = o.subject && o.subject.reference;
      var fRef = o.performer && o.performer[0] && o.performer[0].reference;
      if (!gRef) return;
      if (!obsMap[gRef]) obsMap[gRef] = {};
      var balance = null;
      (o.component || []).forEach(function(c) {
        if (c.valueQuantity && c.valueQuantity.value !== undefined) balance = c.valueQuantity.value;
      });
      var key = fRef || '__unknown__';
      obsMap[gRef][key] = balance;
      if (fRef) facilitySet[fRef] = orgMap[fRef] || fRef.split('/')[1] || fRef;
    });

    var facilityRefs = Object.keys(facilitySet).sort(function(a, b) {
      return facilitySet[a].localeCompare(facilitySet[b]);
    });
    if (facilityRefs.length === 0) facilityRefs = ['__unknown__'];

    var statusColors = { Stockout: '#DD0000', Understock: '#FFA500', Satisfactory: '#38B500', Overstock: '#006EB8' };
    var statusOrder  = { Stockout: 0, Understock: 1, Satisfactory: 2, Overstock: 3 };

    function mosStatus(balance, amc) {
      if (balance === null) return { label: '—', color: '#9e9e9e' };
      var mos = amc > 0 ? balance / amc : 0;
      var label = mos <= 0.5 ? 'Stockout' : mos < 1 ? 'Understock' : mos < 3 ? 'Satisfactory' : 'Overstock';
      return { label: label, color: statusColors[label], mos: mos };
    }

    // One section per facility
    var fetchedAt = new Date().toLocaleString();
    var html =
      '<p style="font-size:12px;color:var(--dhis2-text-muted);text-align:right;margin:0 0 16px">' +
        'HAPI FHIR &mdash; as of ' + esc(fetchedAt) +
        ' &mdash; <a href="#" id="fhir-stock-refresh" style="color:var(--dhis2-blue)">Refresh</a>' +
      '</p>';

    facilityRefs.forEach(function(fRef) {
      var facName = facilitySet[fRef] || fRef;

      // Summary counts
      var counts = { Stockout: 0, Understock: 0, Satisfactory: 0, Overstock: 0 };
      groups.forEach(function(g) {
        var byFac = obsMap['Group/' + g.id];
        if (!byFac) return;
        var balance = byFac[fRef] !== undefined ? byFac[fRef] : byFac['__unknown__'];
        if (balance === undefined) return;
        var amc = mrMap['Group/' + g.id] || 0;
        var st = mosStatus(balance, amc);
        if (counts[st.label] !== undefined) counts[st.label]++;
      });

      var summaryBar =
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        [
          { key: 'Stockout',     color: '#DD0000', bg: '#FDECEA' },
          { key: 'Understock',   color: '#FFA500', bg: '#FFF3E0' },
          { key: 'Satisfactory', color: '#38B500', bg: '#EDF7E8' },
          { key: 'Overstock',    color: '#006EB8', bg: '#E3F0FB' },
        ].map(function(s) {
          return '<div style="background:' + s.bg + ';border-radius:4px;padding:6px 12px">' +
            '<div style="font-size:10px;color:' + s.color + ';font-weight:600">' + s.key.toUpperCase() + '</div>' +
            '<div style="font-size:22px;font-weight:700;color:' + s.color + '">' + counts[s.key] + '</div>' +
          '</div>';
        }).join('') +
        '</div>';

      // Commodity rows, sorted by worst status then name
      var rows = groups.map(function(g) {
        var gRef    = 'Group/' + g.id;
        var byFac   = obsMap[gRef] || {};
        var balance = byFac[fRef] !== undefined ? byFac[fRef] : (byFac['__unknown__'] !== undefined ? byFac['__unknown__'] : null);
        var amc     = mrMap[gRef] || null;
        var st      = mosStatus(balance, amc);
        return { name: g.name || g.id, balance: balance, amc: amc, st: st };
      }).sort(function(a, b) {
        var od = (statusOrder[a.st.label] !== undefined ? statusOrder[a.st.label] : 9) -
                 (statusOrder[b.st.label] !== undefined ? statusOrder[b.st.label] : 9);
        return od !== 0 ? od : a.name.localeCompare(b.name);
      });

      var tableRows = rows.map(function(r) {
        var mosText = r.st.mos !== undefined && r.st.mos !== null ? r.st.mos.toFixed(1) : '—';
        var badge = r.st.label !== '—'
          ? '<span style="background:' + r.st.color + ';color:#fff;padding:1px 7px;border-radius:10px;font-size:11px">' + r.st.label + '</span>'
          : '<span style="color:#bbb;font-size:11px">No data</span>';
        return '<tr>' +
          '<td>' + esc(r.name) + '</td>' +
          '<td style="text-align:right;font-weight:600;color:' + r.st.color + '">' + (r.balance !== null ? r.balance : '—') + '</td>' +
          '<td style="text-align:right;color:#555">' + (r.amc !== null ? r.amc + '/mo' : '—') + '</td>' +
          '<td style="text-align:right;color:#555">' + mosText + '</td>' +
          '<td>' + badge + '</td>' +
          '</tr>';
      }).join('');

      // Mini status pills shown in the collapsed header
      var headerPills = [
        { key: 'Stockout',     color: '#DD0000', bg: '#FDECEA' },
        { key: 'Understock',   color: '#FFA500', bg: '#FFF3E0' },
        { key: 'Satisfactory', color: '#38B500', bg: '#EDF7E8' },
        { key: 'Overstock',    color: '#006EB8', bg: '#E3F0FB' },
      ].filter(function(s) { return counts[s.key] > 0; })
       .map(function(s) {
         return '<span style="background:' + s.bg + ';color:' + s.color + ';' +
           'font-weight:700;font-size:11px;padding:1px 7px;border-radius:10px;margin-left:6px">' +
           counts[s.key] + ' ' + s.key +
           '</span>';
       }).join('');

      html +=
        '<details style="margin-bottom:12px;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden">' +
          '<summary style="cursor:pointer;padding:12px 16px;background:#fafafa;' +
            'font-size:13px;font-weight:600;color:#424242;list-style:none;' +
            'display:flex;align-items:center;gap:8px;user-select:none">' +
            '<span style="font-size:16px">&#127970;</span>' +
            '<span>' + esc(facName) + '</span>' +
            '<span style="margin-left:4px">' + headerPills + '</span>' +
            '<span style="margin-left:auto;font-size:16px;color:#9e9e9e">&#9654;</span>' +
          '</summary>' +
          '<div style="padding:14px 16px">' +
            summaryBar +
            '<table>' +
              '<thead><tr>' +
                '<th>Commodity</th>' +
                '<th style="text-align:right">Balance</th>' +
                '<th style="text-align:right">AMC</th>' +
                '<th style="text-align:right">MOS</th>' +
                '<th>Status</th>' +
              '</tr></thead>' +
              '<tbody>' + (tableRows || '<tr><td colspan="5" style="color:#9e9e9e">No stock observations.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>' +
        '</details>';
    });

    el.innerHTML = html;
    document.getElementById('fhir-stock-refresh').addEventListener('click', function(e) {
      e.preventDefault(); el.dataset.loaded = ''; renderFhirStockByFacility(el);
    });
  }).catch(function(e) { errMsg(el, e.message); });
}

function fhirShowBinary(id, contentType) {
  showModal('Binary: ' + id, '<p aria-busy="true">Loading…</p>');
  kc.updateToken(30)
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch(CONFIG.fhir + '/Binary/' + id, {
        headers: { Authorization: 'Bearer ' + kc.token },
      });
    })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function(text) {
      var display = text;
      try { display = JSON.stringify(JSON.parse(text), null, 2); } catch(_) {}
      showModal('Binary: ' + id,
        '<div style="font-size:12px;color:var(--dhis2-text-muted);margin-bottom:8px">' +
          esc(contentType || 'unknown') + ' &nbsp;&bull;&nbsp; ' + text.length + ' chars' +
        '</div>' +
        '<pre style="max-height:60vh;overflow:auto;background:#f8f9fa;padding:12px;' +
             'border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word">' +
          esc(display) +
        '</pre>'
      );
    })
    .catch(function(e) {
      showModal('Binary: ' + id, '<p class="err">Failed to load: ' + esc(e.message) + '</p>');
    });
}
