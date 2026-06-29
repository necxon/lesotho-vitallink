/*
 * NEC XON (c) Copyright 2025. All rights reserved.
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

function navigationHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>The <strong>App Navigation</strong> page controls the side-drawer menu on the Android BKM app. ' +
      'Each menu item links to a FHIR Questionnaire (form) that opens when the VHW taps it. ' +
      'Changes here are stored in a FHIR Binary resource and picked up by the app on next sync.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>How is it stored?</h4>' +
      '<p>The menu config lives in a single <strong>FHIR Binary</strong> resource ' +
      '(ID&nbsp;<code>d7ce0167-ee6a-4f8f-b644-50b0242513239e</code>) on HAPI FHIR (port 8079). ' +
      'It is a JSON document with a <code>staticMenu</code> array — one object per menu item. ' +
      'This portal reads and writes that document directly via PUT.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Menu item fields</h4>' +
      '<table class="help-table"><thead><tr><th>Field</th><th>What it controls</th></tr></thead><tbody>' +
        '<tr><td><strong>Display name</strong></td><td>Label shown in the app side menu</td></tr>' +
        '<tr><td><strong>Icon</strong></td><td>Icon rendered next to the label (mapped from <code>ic_*</code> refs)</td></tr>' +
        '<tr><td><strong>Form (Questionnaire)</strong></td><td>The FHIR Questionnaire that launches when the item is tapped</td></tr>' +
        '<tr><td><strong>Save button text</strong></td><td>Label on the submit button inside the form (default: Submit)</td></tr>' +
        '<tr><td><strong>Set practitioner details</strong></td><td>Auto-fills the logged-in VHW\'s details into the form before display</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Applying changes to a device</h4>' +
      '<ol style="margin:0;padding-left:20px;font-size:13px">' +
        '<li>Save the change here (the Binary is updated immediately).</li>' +
        '<li>On the Android device, open the app and trigger a FHIR sync.</li>' +
        '<li>If the menu does not update, clear app data and re-enter the <code>app-composition</code> config to force a full reload.</li>' +
      '</ol>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Data source</h4>' +
      '<p>HAPI FHIR &mdash; <code>GET /fhir/Binary/' + NAV_BINARY_ID + '</code> (port 8079). ' +
      'Forms list from <code>GET /fhir/Questionnaire</code>.</p>' +
    '</div>'
  );
}

function renderNavigation(el) {
  loading(el);
  Promise.all([
    fetchNavBinary(),
    fhir('Questionnaire?_count=100'),
  ]).then(function(results) {
    var nav = results[0];
    var questionnaires = entries(results[1]);
    var staticMenu = nav.staticMenu || [];

    el.innerHTML =
      '<div class="page-header">' +
        '<h2>App Navigation (BKM)</h2>' +
        '<button class="btn btn-primary" id="nav-add">+ Add Flow</button>' +
      '</div>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="nav-data">Menu</button>' +
        '<button class="page-tab" data-tab="nav-help">? Help</button>' +
      '</div>' +
      '<div id="nav-data">' +
        '<p style="font-size:12px;color:#4a5768;margin-bottom:16px">' +
          'Manage the Android app\'s side menu. Changes apply after the device syncs and restarts the app.' +
        '</p>' +
        '<div class="nav-section">' +
          '<div class="nav-section-title">Static menu items (' + staticMenu.length + ')</div>' +
          '<div id="nav-items">' +
            staticMenu.map(function(item, idx) {
              var roles = existingRoles(item);
              var roleBadges = roles.length
                ? ' <span style="font-size:11px;color:#4a5768">[' + roles.map(esc).join(', ') + ']</span>'
                : '';
              return '<div class="nav-item" data-idx="' + idx + '">' +
                '<span class="nav-item-icon">' + navIcon(item.menuIconConfig && item.menuIconConfig.reference) + '</span>' +
                '<div style="flex:1">' +
                  '<div class="nav-item-label">' + esc(item.display || item.id) + roleBadges + '</div>' +
                  '<div class="nav-item-meta">' + esc(navItemMeta(item)) + '</div>' +
                '</div>' +
                (window.BKM_ROLE === 'admin'
                  ? '<button class="btn btn-sm btn-outline nav-edit-btn" data-idx="' + idx + '">Edit</button> ' +
                    '<button class="btn btn-sm btn-danger nav-del-btn" data-idx="' + idx + '">Remove</button>'
                  : '') +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="nav-section">' +
          '<div class="nav-section-title">Note</div>' +
          '<p style="font-size:12px;color:#4a5768">After saving, clear app data on device and re-enter <code>app-composition</code> to reload the new menu.</p>' +
        '</div>' +
      '</div>' +
      '<div id="nav-help" class="help-panel" hidden>' + navigationHelpHTML() + '</div>';

    wirePageTabs(el);

    if (window.BKM_ROLE !== 'admin') document.getElementById('nav-add').style.display = 'none';
    document.getElementById('nav-add').onclick = function() {
      openNavFlowForm(null, nav, questionnaires, function() {
        renderNavigation(el);
      });
    };

    el.querySelectorAll('.nav-edit-btn').forEach(function(btn) {
      btn.onclick = function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        openNavFlowForm(idx, nav, questionnaires, function() { renderNavigation(el); });
      };
    });

    el.querySelectorAll('.nav-del-btn').forEach(function(btn) {
      btn.onclick = function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var name = staticMenu[idx] && (staticMenu[idx].display || staticMenu[idx].id) || 'this item';
        showConfirm('Remove Menu Item', 'Remove "' + name + '" from the app menu?', function() {
          var updated = Object.assign({}, nav);
          updated.staticMenu = staticMenu.filter(function(_, i) { return i !== idx; });
          saveNavBinary(updated, function() { closeModal(); renderNavigation(el); });
        });
      };
    });
  }).catch(function(e) { errMsg(el, e.message); });
}

var NAV_ROLES = ['vhw', 'coordinator'];

function existingRoles(item) {
  try { return item.showWidget.rules[0].value || []; } catch (e) { return []; }
}

function openNavFlowForm(editIdx, nav, questionnaires, onSave) {
  var existing = editIdx !== null ? (nav.staticMenu || [])[editIdx] : null;
  var existingAction = existing && existing.actions && existing.actions[0] || {};
  var existingWorkflow = existingAction.workflow || 'LAUNCH_QUESTIONNAIRE';
  var existingQ = existingAction.questionnaire || {};
  var selRoles = existingRoles(existing);

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
      '<div class="form-row"><label>Visible to roles</label>' +
        '<select id="nf-roles" multiple size="3" style="height:auto">' +
          NAV_ROLES.map(function(r) {
            return '<option value="' + r + '"' + (selRoles.indexOf(r) !== -1 ? ' selected' : '') + '>' + r + '</option>';
          }).join('') +
        '</select>' +
        '<div class="hint">Hold Ctrl/Cmd to select multiple. Leave all unselected = visible to everyone.</div></div>' +
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
    var roles    = Array.from(document.getElementById('nf-roles').selectedOptions).map(function(o) { return o.value; });
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
      visible: true,
      display: display,
      menuIconConfig: { type: 'local', reference: icon },
      actions: [action],
    };

    if (roles.length) {
      newItem.showWidget = { rules: [{ name: 'userRole', condition: 'IN', value: roles }] };
    }

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
