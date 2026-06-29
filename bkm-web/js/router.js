/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

// ── Sidebar collapse ─────────────────────────────────────────────────────────

function toggleSidebar() {
  var app = document.getElementById('app');
  var collapsed = app.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
}

(function() {
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    var app = document.getElementById('app');
    if (app) app.classList.add('sidebar-collapsed');
  }
})();

// ── Nav block toggle ─────────────────────────────────────────────────────────

function toggleNavBlock(id) {
  var block = document.getElementById(id);
  if (!block) return;
  var collapsed = block.classList.toggle('collapsed');
  var arrow = block.querySelector('.nav-arrow');
  if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
}

function _ensureNavBlockOpen(id) {
  var block = document.getElementById(id);
  if (!block || !block.classList.contains('collapsed')) return;
  block.classList.remove('collapsed');
  var arrow = block.querySelector('.nav-arrow');
  if (arrow) arrow.textContent = '▼';
}

// ── Router ───────────────────────────────────────────────────────────────────

var _FW_BLOCKED_ROUTES = ['#/settings', '#/tests', '#/services'];

function route() {
  var hash = location.hash || '#/home';

  if (window.BKM_ROLE === 'vhw') return;

  var el = document.getElementById('content');

  if (window.BKM_ROLE === 'coordinator') {
    for (var i = 0; i < _FW_BLOCKED_ROUTES.length; i++) {
      if (hash.indexOf(_FW_BLOCKED_ROUTES[i]) === 0) {
        el.innerHTML =
          '<div style="padding:64px 32px;text-align:center">' +
            '<h3 style="color:#c62828;margin-bottom:12px">Access Denied</h3>' +
            '<p style="color:#4a5768;margin-bottom:20px">You do not have permission to view this page.</p>' +
            '<a href="#/home" style="color:#1565c0">Return to home</a>' +
          '</div>';
        return;
      }
    }
  }

  document.querySelectorAll('#nav-links a').forEach(function(a) {
    a.classList.toggle('active', hash.indexOf(a.getAttribute('href')) === 0);
  });
  if      (hash.indexOf('#/home') === 0)            renderHome(el);
  else if (hash.indexOf('#/patients/') === 0)     renderPatientDetail(el, hash.replace('#/patients/', ''));
  else if (hash.indexOf('#/patients') === 0)       renderPatients(el);
  else if (hash.indexOf('#/practitioners') === 0)  renderPractitioners(el);
  else if (hash.indexOf('#/care-teams') === 0)     renderCareTeams(el);
  else if (hash.indexOf('#/locations/') === 0)     renderLocationDetail(el, hash.replace('#/locations/', ''));
  else if (hash.indexOf('#/locations') === 0)      renderLocations(el);
  else if (hash.indexOf('#/groups/') === 0)        renderGroupDetail(el, hash.replace('#/groups/', ''));
  else if (hash.indexOf('#/groups') === 0)         renderGroups(el);
  else if (hash.indexOf('#/questionnaires/fill/') === 0)   renderQFill(el, hash.replace('#/questionnaires/fill/', ''));
  else if (hash.indexOf('#/questionnaires/responses/') === 0) renderQResponses(el, hash.replace('#/questionnaires/responses/', ''));
  else if (hash.indexOf('#/questionnaires') === 0) renderQuestionnaires(el);
  else if (hash.indexOf('#/navigation') === 0)     renderNavigation(el);
  else if (hash.indexOf('#/stock') === 0)          renderStock(el);
  //else if (hash.indexOf('#/orders') === 0)         renderOrders(el);
  //else if (hash.indexOf('#/tasks') === 0)          renderTasks(el);
  else if (hash.indexOf('#/fhir') === 0)           renderFHIR(el);
  else if (hash.indexOf('#/openlmis') === 0)       renderOpenLMIS(el);
  else if (hash.indexOf('#/services') === 0)       renderServices(el);
  else if (hash.indexOf('#/tests') === 0)          renderTests(el);
  else if (hash.indexOf('#/settings') === 0)       renderSettings(el);
  else if (hash.indexOf('#/mappings') === 0)       renderMappings(el);
  else if (hash.indexOf('#/medications') === 0)    renderMedications(el);
  else if (hash.indexOf('#/flow') === 0)           renderFlow(el);
  else    location.hash = '#/home';
}

window.addEventListener('hashchange', route);
