/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

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
        '<tr><td><strong>Show in the app menu</strong></td><td>The only visibility control the app honours. Yes shows the item to every user, No hides it from every user</td></tr>' +
        '<tr><td><strong>Set practitioner details</strong></td><td>Auto-fills the logged-in VHW\'s details into the form before display</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>The side-menu simulation</h4>' +
      '<p>The panel at the top of <strong>App Nav</strong> draws what the drawer actually looks ' +
      'like on the phone, from the live config &mdash; so a menu change can be checked without ' +
      'flashing a device.</p>' +
      '<p>It follows the order <code>AppDrawer.kt</code> composes the drawer in, which is not the ' +
      'order this page lists things: client registers first, then the bottom-sheet entry, then a ' +
      'divider, then the static menu. Only items with <code>visible</code> set are drawn, because ' +
      'that is the only filter the app applies.</p>' +
      '<p>Labels are resolved the way the app resolves them. <code>{{some.key}}</code> is looked up ' +
      'in the translation bundle, so <code>{{stock.inventory}}</code> shows as ' +
      '<strong>Stock Inventory</strong>. A key with no translation is highlighted and listed, ' +
      'because on the phone it renders as literal braces in the menu.</p>' +
      '<p>It is the menu only. Counts show as <strong>0</strong> because those come from the ' +
      'device database, and tapping nothing opens a register &mdash; use ' +
      '<code>make test-menus</code> to confirm each item leads somewhere real.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Why the menu is short, and why it must stay short</h4>' +
      '<p>The app draws <strong>two</strong> lists in the drawer: the bottom-sheet register ' +
      'switcher, and then this static menu. Fourteen registers used to appear in both, so every ' +
      'health worker saw ANC, HIV, TB, Diabetes and eleven others twice, in two places. That ' +
      'duplication was most of why the menu felt complicated.</p>' +
      '<p>They were removed from the static menu only &mdash; the bottom sheet still offers all ' +
      'fourteen, so nothing became unreachable. Run <code>make test-menus</code> after any change: ' +
      'it warns if a register drifts back into both lists, and it checks that every menu item still ' +
      'leads to a form or register that exists on the server.</p>' +
    '</div>' +
    '<div class="help-section">' +
      '<h4>Per-role menus are not supported</h4>' +
      '<p>The installed app filters this menu on exactly one thing: whether an item is visible. ' +
      'In <code>AppDrawer.kt</code> it is <code>staticMenu.filter { it.visible }</code>, and ' +
      '<code>NavigationMenuConfig</code> has no field for roles at all.</p>' +
      '<p>Older configs carry a <code>roles</code> list, and this page used to offer a ' +
      '&ldquo;Visible to roles&rdquo; selector. Both are <strong>silently discarded</strong> by the ' +
      'app, which parses its config with <code>ignoreUnknownKeys = true</code>. An item marked for ' +
      'one role was still shown to everyone. The list flags any such leftover setting in red so it ' +
      'is not mistaken for a working restriction.</p>' +
      '<p>Showing an item to some roles and not others needs either a change to the app and a new ' +
      'APK, or the server delivering a different navigation config per role. Until one of those is ' +
      'done, treat this menu as the same for every user.</p>' +
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
