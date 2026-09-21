/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

var NAV_BINARY_ID = 'd7ce0167-ee6a-4f8f-b644-50b0242513239e';

var NAV_ICONS = [
  { value: 'ic_tasks_priority', label: 'Tasks' },
  { value: 'ic_inventory',      label: 'Inventory' },
  { value: 'ic_reports',        label: 'Reports' },
  { value: 'ic_households',     label: 'Households' },
  { value: 'ic_baby_mother',    label: 'Mother/Child' },
  { value: 'ic_needle',         label: 'Medical' },
  { value: 'ic_user',           label: 'User' },
  { value: 'ic_settings',       label: 'Settings' },
  { value: 'ic_sync',           label: 'Sync' },
];

var NAV_WORKFLOWS = [
  { value: 'LAUNCH_QUESTIONNAIRE',  label: 'Launch form',         needsQuestionnaire: true  },
  { value: 'LAUNCH_REGISTER',       label: 'Launch register',     needsRegisterId:    true  },
  { value: 'DEVICE_TO_DEVICE_SYNC', label: 'Sync / Refresh data', simple:             true  },
  { value: 'LAUNCH_REPORT',         label: 'Reports screen',      simple:             true  },
  { value: 'LAUNCH_SETTINGS',       label: 'Settings screen',     simple:             true  },
  { value: 'LAUNCH_MAP',            label: 'Map screen',          simple:             true  },
];

var NAV_ICON_EMOJI = {
  'ic_tasks_priority': '✅',
  'ic_inventory':      '📦',
  'ic_reports':        '📊',
  'ic_households':     '🏠',
  'ic_baby_mother':    '👶',
  'ic_needle':         '💉',
  'ic_user':           '👤',
  'ic_settings':       '⚙️',
  'ic_sync':           '🔄',
};

function navIcon(ref) {
  return NAV_ICON_EMOJI[ref] || '📋';
}

function navItemMeta(item) {
  if (!item.actions || !item.actions[0]) return '';
  var a = item.actions[0];
  if (a.workflow === 'LAUNCH_QUESTIONNAIRE') {
    var qid = a.questionnaire && a.questionnaire.id || '';
    return 'Form: ' + qid;
  }
  if (a.workflow === 'LAUNCH_REGISTER')       return 'Register: ' + (a.id || '');
  if (a.workflow === 'LAUNCH_REPORT')         return 'Reports screen';
  if (a.workflow === 'LAUNCH_SETTINGS')       return 'Settings screen';
  if (a.workflow === 'LAUNCH_MAP')            return 'Map screen';
  if (a.workflow === 'DEVICE_TO_DEVICE_SYNC') return 'Sync / Refresh data';
  return a.workflow || '';
}

function saveNavBinary(navData, onDone) {
  if (window.BKM_ROLE !== 'admin') {
    alert('Only an administrator (bkm-admin) can edit the app navigation. Your role has read-only access here.');
    return;
  }
  fetch(CONFIG.fhir + '/Binary/' + NAV_BINARY_ID, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + kc.token,
    },
    body: JSON.stringify(navData),
  }).then(function(res) {
    if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
    onDone();
  }).catch(function(e) { alert('Save failed: ' + e.message); });
}

function fetchNavBinary() {
  return fetch(CONFIG.fhir + '/Binary/' + NAV_BINARY_ID, {
    headers: { Authorization: 'Bearer ' + kc.token },
  }).then(function(res) { return res.json(); });
}

/* ── Side-menu simulation ─────────────────────────────────────────────────────
 *
 * Draws what the drawer actually looks like on the phone, from the live config.
 *
 * The order is not invented. AppDrawer.kt composes the drawer in exactly this
 * sequence, and the simulation follows it line for line:
 *
 *   1. a "REGISTERS" heading, but only when clientRegisters has MORE THAN ONE
 *      entry (AppDrawer checks `.size > 1`)
 *   2. clientRegisters.filter { it.visible }
 *   3. the bottom-sheet entry, only when it has registers, drawn with a right
 *      chevron because it opens a sheet rather than a screen
 *   4. a divider
 *   5. staticMenu.filter { it.visible }
 *
 * The two things most easily got wrong are worth stating: `visible` is the ONLY
 * filter the app applies, and the bottom sheet is drawn BEFORE the static menu,
 * not after it. A preview that got either wrong would be worse than none.
 */

// The app resolves {{key}} against its translation bundle and @{var} against
// runtime values. Printing the raw braces would misrepresent what a health
// worker sees, so both are resolved here - and an unresolved key is reported
// rather than quietly printed, because on the phone it really does render as
// literal braces in the menu.
function _navResolveLabel(text, strings) {
  var missing = [];
  var out = String(text == null ? '' : text);

  out = out.replace(/\{\{([^}]+)\}\}/g, function(_m, key) {
    var k = key.trim();
    if (strings && Object.prototype.hasOwnProperty.call(strings, k)) return strings[k];
    missing.push(k);
    return '{{' + k + '}}';
  });

  // @{...} is filled in on the device from practitioner or register data.
  // There is no honest value for it here, so it shows as a placeholder.
  out = out.replace(/@\{([^}]+)\}/g, function(_m, key) {
    return '‹' + key.trim() + '›';
  });

  return { text: out, missing: missing };
}

function _navSimRow(item, strings, opts) {
  opts = opts || {};
  var label = _navResolveLabel(item.display || item.id, strings);
  var cls = 'nav-sim-row' + (label.missing.length ? ' nav-sim-row-warn' : '');
  var count = (item.showCount && !opts.chevron) ? '<span class="nav-sim-count">0</span>' : '';
  var chevron = opts.chevron ? '<span class="nav-sim-chevron">›</span>' : '';
  return '<div class="' + cls + '">' +
      '<span class="nav-sim-icon">' + navIcon(item.menuIconConfig && item.menuIconConfig.reference) + '</span>' +
      '<span class="nav-sim-label">' + esc(label.text) + '</span>' +
      count + chevron +
    '</div>';
}

function _navSimulation(nav, strings, appCfg) {
  var clientAll = nav.clientRegisters || [];
  var client = clientAll.filter(function(i) { return i.visible !== false; });
  var staticAll = nav.staticMenu || [];
  var staticVisible = staticAll.filter(function(i) { return i.visible !== false; });
  var bs = nav.bottomSheetRegisters || {};
  var sheet = bs.registers || [];

  var rows = '';
  if (clientAll.length > 1) rows += '<div class="nav-sim-heading">REGISTERS</div>';
  client.forEach(function(i) { rows += _navSimRow(i, strings); });

  if (sheet.length) {
    rows += _navSimRow(
      { display: bs.display || 'Other Patients', menuIconConfig: bs.menuIconConfig },
      strings, { chevron: true });
    if (staticAll.length) rows += '<div class="nav-sim-divider"></div>';
  }
  rows += '<div class="nav-sim-divider"></div>';
  staticVisible.forEach(function(i) { rows += _navSimRow(i, strings); });

  // One warning line for the whole menu rather than one per row.
  var missing = {};
  staticVisible.concat(client).forEach(function(i) {
    _navResolveLabel(i.display || i.id, strings).missing.forEach(function(k) { missing[k] = true; });
  });
  var missingKeys = Object.keys(missing);
  var hidden = staticAll.length - staticVisible.length;
  var appTitle = _navResolveLabel((appCfg && appCfg.appTitle) || '', strings).text.trim();

  return '<div class="nav-sim-wrap">' +
      '<div class="nav-sim-phone">' +
        // NavTopSection draws appUiState.appTitle, which comes from the
        // application config - not the appId, and not anything invented here.
        // It is blank in this deployment, and showing that is the point: the
        // header really is empty on the device.
        '<div class="nav-sim-appbar">' +
          (appTitle
            ? '<span class="nav-sim-appbar-title">' + esc(appTitle) + '</span>'
            : '<span class="nav-sim-appbar-title nav-sim-appbar-empty">appTitle is not set</span>') +
        '</div>' +
        '<div class="nav-sim-list">' + rows + '</div>' +
        '<div class="nav-sim-foot">Sync now</div>' +
      '</div>' +
      '<div class="nav-sim-notes">' +
        '<h4>What the phone shows</h4>' +
        '<p><small>Drawn from the live config, in the order <code>AppDrawer.kt</code> composes ' +
        'it: client registers, then the bottom-sheet entry, then the static menu.</small></p>' +
        '<ul>' +
          '<li><strong>' + staticVisible.length + '</strong> of ' + staticAll.length +
            ' static menu item(s) visible' +
            (hidden ? ' &mdash; ' + hidden + ' hidden by <code>visible: false</code>' : '') + '</li>' +
          '<li><strong>' + sheet.length + '</strong> register(s) behind the &ldquo;' +
            esc(_navResolveLabel(bs.display || 'Other Patients', strings).text) + '&rdquo; sheet</li>' +
          '<li><strong>' + client.length + '</strong> client register(s)</li>' +
        '</ul>' +
        (missingKeys.length
          ? '<p class="nav-sim-warn"><strong>' + missingKeys.length + ' label(s) will not translate.</strong> ' +
            'These keys are missing from the translation bundle, so the phone shows the raw braces: <code>' +
            missingKeys.map(esc).join('</code>, <code>') + '</code></p>'
          : '<p><small>Every label resolves against the translation bundle.</small></p>') +
        '<p><small>This is the menu only - it does not render the registers themselves, and ' +
        'counts show as 0 because those come from the device database.</small></p>' +
      '</div>' +
    '</div>';
}

// Translation bundle, found through the Composition rather than a hardcoded
// Binary id so it still works if the bundle is re-uploaded under a new id.
// Best-effort: without it the simulation still draws, showing the raw keys.
var _navStringsCache = null;
var _navAppCfgCache = null;

// Resolve a config Binary through the Composition rather than a hardcoded id,
// so it still works if a bundle is re-uploaded under a new one.
function _navConfigSection(identifier) {
  return fhir('Composition?identifier=app&_count=1').then(function(bundle) {
    var comp = entries(bundle)[0];
    var ref = null;
    (comp.section || []).forEach(function(sec) {
      (sec.section || [sec]).forEach(function(sub) {
        var f = sub.focus || {};
        if ((f.identifier || {}).value === identifier) ref = f.reference;
      });
    });
    if (!ref) throw new Error('no "' + identifier + '" section in the Composition');
    return fetch(CONFIG.fhir + '/' + ref, { headers: { Authorization: 'Bearer ' + kc.token } });
  });
}

// Best-effort: without it the simulation still draws, showing the raw keys.
function fetchNavStrings() {
  if (_navStringsCache) return Promise.resolve(_navStringsCache);
  return _navConfigSection('strings')
    .then(function(res) { return res.text(); })
    .then(function(text) {
      // Java .properties: key=value per line, # or ! starts a comment.
      var out = {};
      text.split(/\r?\n/).forEach(function(line) {
        if (!line || line.charAt(0) === '#' || line.charAt(0) === '!') return;
        var i = line.indexOf('=');
        if (i < 1) return;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      _navStringsCache = out;
      return out;
    })
    .catch(function() { return {}; });
}

// The drawer header shows appTitle from the application config - NOT the appId,
// and not anything invented here. It is genuinely blank when appTitle is unset,
// which is worth surfacing rather than papering over.
function fetchNavAppConfig() {
  if (_navAppCfgCache) return Promise.resolve(_navAppCfgCache);
  return _navConfigSection('application')
    .then(function(res) { return res.json(); })
    .then(function(cfg) { _navAppCfgCache = cfg; return cfg; })
    .catch(function() { return {}; });
}

// Static help panel lives in js/help/navigation.js (navigationHelpHTML, global).

/*
 * The App Nav panel, mountable into any container.
 *
 * Hosted as the App Nav tab on the Phone Menus page (#/questionnaires). It used
 * to be a page of its own at #/navigation; that route now redirects here,
 * because a menu item launches one of the questionnaires listed on that page,
 * and splitting them meant editing two pages to make one change.
 *
 * It renders ONLY the panel - no page header, no tabs, no help panel - because
 * the host page owns those. `onChanged` lets the host react to a save; the
 * panel re-mounts itself either way.
 */
function mountNavPanel(container, onChanged) {
  container.innerHTML = '<p><small>Loading the app menu…</small></p>';

  return Promise.all([
    fetchNavBinary(),
    fhir('Questionnaire?_count=100'),
    fetchNavStrings(),
    fetchNavAppConfig(),
  ]).then(function(results) {
    var nav = results[0];
    var questionnaires = entries(results[1]);
    var strings = results[2] || {};
    var appCfg = results[3] || {};
    var staticMenu = nav.staticMenu || [];
    var clientRegisters = nav.clientRegisters || [];
    var sheetRegisters = (nav.bottomSheetRegisters && nav.bottomSheetRegisters.registers) || [];
    var isAdmin = window.BKM_ROLE === 'admin';

    var visibleCount = staticMenu.filter(function(i) { return i.visible !== false; }).length;

    container.innerHTML =
      '<p style="font-size:12px;color:#4a5768;margin-bottom:16px">' +
        'The Android app&rsquo;s side menu. Changes apply after the device syncs and restarts the app.' +
      '</p>' +
      _navSimulation(nav, strings, appCfg) +
      '<div class="nav-section">' +
        '<div class="nav-section-title" style="display:flex;align-items:center;gap:10px">' +
          '<span style="flex:1">Static menu items (' + staticMenu.length + ', ' + visibleCount + ' shown on the phone)</span>' +
          (isAdmin ? '<button class="btn btn-sm btn-primary" id="nav-add">+ Add Flow</button>' : '') +
        '</div>' +
        '<div id="nav-items">' +
          staticMenu.map(function(item, idx) {
            // Two different badges, because they mean opposite things: one
            // reports real state, the other warns that a setting is inert.
            var hidden = item.visible === false;
            var roleBadges = hidden
              ? ' <span style="font-size:11px;color:#8a6d00;background:#fff8e1;padding:1px 6px;border-radius:9px">hidden from the app</span>'
              : '';
            var stale = staleRoleKeys(item);
            if (stale.length) {
              roleBadges += ' <span style="font-size:11px;color:#c62828" ' +
                'title="The installed app ignores role restrictions on menu items. ' +
                'This item is shown to everyone.">[' + stale.map(esc).join(', ') + ' - not enforced]</span>';
            }
            return '<div class="nav-item" data-idx="' + idx + '">' +
              '<span class="nav-item-icon">' + navIcon(item.menuIconConfig && item.menuIconConfig.reference) + '</span>' +
              '<div style="flex:1">' +
                '<div class="nav-item-label">' + esc(item.display || item.id) + roleBadges + '</div>' +
                '<div class="nav-item-meta">' + esc(navItemMeta(item)) + '</div>' +
              '</div>' +
              (isAdmin
                ? '<button class="btn btn-sm btn-outline nav-edit-btn" data-idx="' + idx + '">Edit</button> ' +
                  '<button class="btn btn-sm btn-danger nav-del-btn" data-idx="' + idx + '">Remove</button>'
                : '') +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +
      // The drawer shows three groups, but this page used to list only one of
      // them - so "All households" and "Other patients" appeared in the
      // simulation with nothing on the page accounting for them. They are read
      // only here: both are edited in the register configs rather than in the
      // staticMenu array this form writes.
      '<div class="nav-section">' +
        '<div class="nav-section-title">Client registers (' + clientRegisters.length + ')</div>' +
        '<p style="font-size:12px;color:#4a5768;margin:0 0 8px">' +
          'Drawn above the static menu. Edited in the register configs, not here.</p>' +
        (clientRegisters.length
          ? '<div>' + clientRegisters.map(function(item) {
              return '<div class="nav-item">' +
                '<span class="nav-item-icon">' + navIcon(item.menuIconConfig && item.menuIconConfig.reference) + '</span>' +
                '<div style="flex:1">' +
                  '<div class="nav-item-label">' + esc(_navResolveLabel(item.display || item.id, strings).text) +
                    (item.visible === false
                      ? ' <span style="font-size:11px;color:#8a6d00;background:#fff8e1;padding:1px 6px;border-radius:9px">hidden from the app</span>'
                      : '') + '</div>' +
                  '<div class="nav-item-meta">' + esc(navItemMeta(item)) + '</div>' +
                '</div></div>';
            }).join('') + '</div>'
          : '<p style="font-size:12px;color:#4a5768">None configured.</p>') +
      '</div>' +
      '<div class="nav-section">' +
        '<div class="nav-section-title">' +
          esc(_navResolveLabel((nav.bottomSheetRegisters && nav.bottomSheetRegisters.display) || 'Other Patients', strings).text) +
          ' sheet (' + sheetRegisters.length + ')</div>' +
        '<p style="font-size:12px;color:#4a5768;margin:0 0 8px">' +
          'One row in the drawer that opens a sheet listing these registers. This is where the ' +
          'fourteen disease registers live, which is why they no longer need to be in the static ' +
          'menu as well.</p>' +
        '<div style="font-size:12px;color:#4a5768;line-height:1.9">' +
          sheetRegisters.map(function(r) {
            return '<code style="background:#f1f3f5;padding:1px 6px;border-radius:3px;margin-right:6px;display:inline-block">' +
              esc(r.id || '?') + '</code>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="nav-section">' +
        '<div class="nav-section-title">Note</div>' +
        '<p style="font-size:12px;color:#4a5768">Check the whole menu with ' +
        '<code>make test-menus</code>. After saving, clear app data on device and re-enter ' +
        '<code>app-composition</code> to reload the new menu.</p>' +
      '</div>';

    function remount() {
      mountNavPanel(container, onChanged);
      if (onChanged) onChanged();
    }

    var addBtn = container.querySelector('#nav-add');
    if (addBtn) {
      addBtn.onclick = function() {
        openNavFlowForm(null, nav, questionnaires, remount);
      };
    }

    container.querySelectorAll('.nav-edit-btn').forEach(function(btn) {
      btn.onclick = function() {
        openNavFlowForm(parseInt(btn.getAttribute('data-idx'), 10), nav, questionnaires, remount);
      };
    });

    container.querySelectorAll('.nav-del-btn').forEach(function(btn) {
      btn.onclick = function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var name = staticMenu[idx] && (staticMenu[idx].display || staticMenu[idx].id) || 'this item';
        showConfirm('Remove Menu Item', 'Remove "' + name + '" from the app menu?', function() {
          var updated = Object.assign({}, nav);
          updated.staticMenu = staticMenu.filter(function(_, i) { return i !== idx; });
          saveNavBinary(updated, function() { closeModal(); remount(); });
        });
      };
    });
  }).catch(function(e) {
    container.innerHTML = '<p style="color:#c62828">Could not load the app menu: ' + esc(e.message) + '</p>';
  });
}

function staleRoleKeys(item) {
  if (!item) return [];
  if (Array.isArray(item.roles)) return item.roles;
  try { return item.showWidget.rules[0].value || []; } catch (e) { return []; }
}

function openNavFlowForm(editIdx, nav, questionnaires, onSave) {
  var existing = editIdx !== null ? (nav.staticMenu || [])[editIdx] : null;
  var existingAction = existing && existing.actions && existing.actions[0] || {};
  var existingWorkflow = existingAction.workflow || 'LAUNCH_QUESTIONNAIRE';
  var existingQ = existingAction.questionnaire || {};
  // `visible` defaults to true in NavigationMenuConfig, so an absent field
  // means the item IS shown.
  var existingVisible = existing ? existing.visible !== false : true;

  var workflowOptions = NAV_WORKFLOWS.map(function(wf) {
    return '<option value="' + wf.value + '"' + (existingWorkflow === wf.value ? ' selected' : '') + '>' + esc(wf.label) + '</option>';
  }).join('');

  var qOptions = questionnaires.map(function(q) {
    var sel = (existingQ.id === q.id) ? ' selected' : '';
    return '<option value="' + esc(q.id) + '"' + sel + '>' + esc(q.title || q.id) + '</option>';
  }).join('');

  var iconRef = existing && existing.menuIconConfig && existing.menuIconConfig.reference || '';
  var iconOptions = NAV_ICONS.map(function(ic) {
    return '<option value="' + ic.value + '"' + (iconRef === ic.value ? ' selected' : '') + '>' +
      navIcon(ic.value) + ' ' + ic.label + '</option>';
  }).join('');

  function wfMeta(wf) {
    return NAV_WORKFLOWS.find(function(w) { return w.value === wf; }) || {};
  }

  showModal(editIdx !== null ? 'Edit Menu Item' : 'Add Menu Item',
    '<div class="modal-body">' +
      '<div class="form-row"><label>Workflow type</label>' +
        '<select id="nf-workflow">' + workflowOptions + '</select></div>' +
      '<div class="form-row"><label>Display name</label>' +
        '<input id="nf-display" value="' + esc(existing && existing.display || '') + '" placeholder="e.g. Sync Data"></div>' +
      '<div class="form-row"><label>Icon</label>' +
        '<select id="nf-icon">' + iconOptions + '</select></div>' +
      '<div id="nf-q-section">' +
        '<div class="form-row"><label>Form (Questionnaire)</label>' +
          '<select id="nf-qid"><option value="">-- select a form --</option>' + qOptions + '</select>' +
          '<div class="hint">The form that opens when the user taps this menu item</div></div>' +
        '<div class="form-row"><label>Save button text</label>' +
          '<input id="nf-savebtn" value="' + esc(existingQ.saveButtonText || 'Submit') + '"></div>' +
        '<div class="form-row"><label>Set practitioner details</label>' +
          '<select id="nf-setprac">' +
            '<option value="true"' + (existingQ.setPractitionerDetails ? ' selected' : '') + '>Yes</option>' +
            '<option value="false"' + (!existingQ.setPractitionerDetails ? ' selected' : '') + '>No</option>' +
          '</select></div>' +
      '</div>' +
      '<div id="nf-reg-section" style="display:none">' +
        '<div class="form-row"><label>Register ID</label>' +
          '<input id="nf-regid" value="' + esc(existingAction.id || '') + '" placeholder="e.g. householdRegister">' +
          '<div class="hint">The register config ID this item opens</div></div>' +
      '</div>' +
      // The app filters the side menu on ONE thing: AppDrawer.kt does
      // `staticMenu.filter { it.visible }`. NavigationMenuConfig has no roles
      // field and the app parses config with ignoreUnknownKeys = true, so a
      // per-role control here would be silently discarded - which is exactly
      // what the old "Visible to roles" multi-select did. This offers the lever
      // that actually works instead.
      '<div class="form-row"><label>Show in the app menu</label>' +
        '<select id="nf-visible">' +
          '<option value="true"' + (existingVisible ? ' selected' : '') + '>Yes - everyone sees it</option>' +
          '<option value="false"' + (existingVisible ? '' : ' selected') + '>No - hidden from everyone</option>' +
        '</select>' +
        '<div class="hint">The app shows this item to every signed-in user or to nobody. ' +
        'Per-role menus are not supported by the installed app - see the Help tab.</div></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="form-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="form-save">Save</button>' +
      '</div>' +
    '</div>'
  );

  function applyWorkflowVisibility() {
    var wf = document.getElementById('nf-workflow').value;
    var meta = wfMeta(wf);
    document.getElementById('nf-q-section').style.display   = meta.needsQuestionnaire ? '' : 'none';
    document.getElementById('nf-reg-section').style.display = meta.needsRegisterId    ? '' : 'none';
  }

  applyWorkflowVisibility();
  document.getElementById('nf-workflow').onchange = applyWorkflowVisibility;
  document.getElementById('form-cancel').onclick = closeModal;

  document.getElementById('form-save').onclick = function() {
    var workflow = document.getElementById('nf-workflow').value;
    var display  = document.getElementById('nf-display').value.trim();
    var icon     = document.getElementById('nf-icon').value;
    var visible  = document.getElementById('nf-visible').value === 'true';
    var meta     = wfMeta(workflow);

    if (!display) { alert('Display name is required'); return; }

    var action = { trigger: 'ON_CLICK', workflow: workflow };

    if (meta.needsQuestionnaire) {
      var qid     = document.getElementById('nf-qid').value;
      var savebtn = document.getElementById('nf-savebtn').value.trim() || 'Submit';
      var setprac = document.getElementById('nf-setprac').value === 'true';
      if (!qid) { alert('Please select a form'); return; }
      var qTitle = '';
      document.getElementById('nf-qid').querySelectorAll('option').forEach(function(o) {
        if (o.value === qid) qTitle = o.textContent.trim();
      });
      action.questionnaire = {
        id: qid,
        title: qTitle || display,
        saveButtonText: savebtn,
        setPractitionerDetails: setprac,
        setOrganizationDetails: false,
      };
    } else if (meta.needsRegisterId) {
      var regid = document.getElementById('nf-regid').value.trim();
      if (!regid) { alert('Register ID is required'); return; }
      action.id = regid;
    } else {
      action.id = workflow.toLowerCase().replace(/_/g, '') + 'Screen';
    }

    var newItem = {
      id: display.toLowerCase().replace(/[^a-z0-9]+/g, '_') + 'Menu',
      visible: visible,
      display: display,
      menuIconConfig: { type: 'local', reference: icon },
      actions: [action],
    };

    // Deliberately no showWidget/roles written here: the app discards both.

    var btn = document.getElementById('form-save');
    btn.disabled = true; btn.textContent = 'Saving...';

    var updated = Object.assign({}, nav);
    var menu = (nav.staticMenu || []).slice();
    if (editIdx !== null) {
      menu[editIdx] = newItem;
    } else {
      menu.unshift(newItem);
    }
    updated.staticMenu = menu;

    saveNavBinary(updated, function() {
      closeModal();
      onSave(updated);
    });
  };
}
