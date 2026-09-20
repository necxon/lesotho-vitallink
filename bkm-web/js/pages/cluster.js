/*
 * NEC XON (c) Copyright 2025.
 *
 * Backends page — live state of the redundant FHIR nodes and the database
 * replica, so an administrator can see at a glance whether the system is still
 * covered after something has died.
 *
 * Data comes from the mediator's /cluster/status, which probes each FHIR node
 * by name rather than through fhir-proxy. Probing through the load balancer
 * would just report whichever node it picked, which is exactly the information
 * you do not want when you are trying to find out which node is down.
 */
'use strict';

var _clusterTimer = null;

function _clusterDot(ok, warn) {
  var color = ok ? '#2e7d32' : (warn ? '#ef6c00' : '#c62828');
  return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;' +
         'background:' + color + ';margin-right:6px;vertical-align:middle"></span>';
}

function _clusterBanner(health) {
  var map = {
    healthy:  ['#2e7d32', 'Fully redundant', 'Every backend is up and the database replica is streaming.'],
    degraded: ['#ef6c00', 'Degraded — still serving', 'Something is down. The system is running, but a further failure could take it offline.'],
    down:     ['#c62828', 'Down', 'No FHIR backend is reachable, or the primary database is unreachable.'],
  };
  var m = map[health] || map.down;
  return '<div style="border-left:4px solid ' + m[0] + ';background:#fafafa;padding:12px 16px;margin-bottom:18px">' +
         '<strong style="color:' + m[0] + '">' + m[1] + '</strong><br><small>' + m[2] + '</small></div>';
}

function renderCluster(el) {
  el.innerHTML = '<h2>Backends</h2><p aria-busy="true">Checking cluster…</p>';

  function paint(d) {
    var rows = d.fhir.nodes.map(function(n) {
      return '<tr>' +
        '<td>' + _clusterDot(n.up) + '<code>' + n.name + '</code></td>' +
        '<td>' + (n.up ? 'Serving' : 'DOWN') + '</td>' +
        '<td>' + (n.status || '—') + '</td>' +
        '<td>' + n.responseMs + ' ms</td>' +
        '<td>' + (n.software ? 'HAPI ' + n.software : (n.error || '—')) + '</td>' +
        '</tr>';
    }).join('');

    // The OpenSRP tier is optional in the payload so an older mediator that
    // predates it still renders the page instead of throwing.
    var osRows = (d.opensrp && d.opensrp.nodes ? d.opensrp.nodes : []).map(function(n) {
      return '<tr>' +
        '<td>' + _clusterDot(n.up) + '<code>' + n.name + '</code></td>' +
        '<td>' + (n.up ? 'Serving' : 'DOWN') + '</td>' +
        '<td>' + (n.status || '—') + '</td>' +
        '<td>' + n.responseMs + ' ms</td>' +
        '<td>' + (n.up ? '' : (n.error || '')) + '</td>' +
        '</tr>';
    }).join('');

    var p = d.database.primary;
    var s = d.database.standby;

    // A standby that reports anything other than "standby" has been promoted:
    // it has stopped following the primary, and the two are now diverging.
    var standbyWarn = s.up && s.role !== 'standby';

    var dbRows =
      '<tr><td>' + _clusterDot(p.up) + '<code>db-postgres</code></td>' +
      '<td>' + (p.up ? p.role : 'DOWN') + '</td>' +
      '<td>' + (p.up ? p.replicas + ' replica(s) streaming' : (p.error || '')) + '</td></tr>' +
      '<tr><td>' + _clusterDot(s.up && !standbyWarn, standbyWarn) + '<code>db-postgres-standby</code></td>' +
      '<td>' + (s.up ? s.role : 'DOWN') + '</td>' +
      '<td>' + (s.up
          ? (s.caughtUp ? 'Caught up' : 'Replaying') + ', lag ' + s.lagSeconds + 's'
          : (s.error || '')) + '</td></tr>';

    var failoverNote = d.fhir.up < d.fhir.total
      ? '<p><small><strong>A FHIR node is down.</strong> fhir-proxy has already routed around it — ' +
        'phones keep syncing. Bring it back with <code>docker compose up -d ' +
        d.fhir.nodes.filter(function(n) { return !n.up; })[0].name + '</code>.</small></p>'
      : '';

    el.innerHTML =
      '<h2>Backends</h2>' +
      _clusterBanner(d.health) +
      '<h3>FHIR backends</h3>' +
      '<p><small>Phones sync through <code>fhir-proxy</code>, which load balances across these nodes and ' +
      'retries on the other one when a node refuses, times out or 5xxs. Failover is automatic — ' +
      'there is no switch to flip.</small></p>' +
      '<table role="grid"><thead><tr><th>Node</th><th>State</th><th>HTTP</th><th>Response</th><th>Version</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      failoverNote +
      (osRows
        ? '<h3>OpenSRP backends</h3>' +
          '<p><small>Fronted by <code>opensrp-proxy</code>, same failover behaviour as the FHIR tier. ' +
          'Active-active is safe here because the auth cache lives in Redis, not in the JVM.</small></p>' +
          '<table role="grid"><thead><tr><th>Node</th><th>State</th><th>HTTP</th><th>Response</th><th></th></tr></thead>' +
          '<tbody>' + osRows + '</tbody></table>'
        : '') +
      '<h3>Database</h3>' +
      '<p><small>Streaming replication covers the whole cluster, so DHIS2, Keycloak, OpenSRP, the mediator ' +
      'and Superset are protected too, not just FHIR. The standby is read-only until promoted.</small></p>' +
      '<table role="grid"><thead><tr><th>Server</th><th>Role</th><th>Replication</th></tr></thead>' +
      '<tbody>' + dbRows + '</tbody></table>' +
      (standbyWarn
        ? '<p><small style="color:#ef6c00"><strong>The standby has been promoted.</strong> It is no longer ' +
          'following the primary, so the two are diverging. Rebuild it from a fresh base backup once the ' +
          'failover is resolved.</small></p>'
        : '') +
      '<p><small>Checked ' + new Date(d.checkedAt).toLocaleTimeString() + '. Refreshes every 15s. ' +
      'Failover drill and promotion steps: <code>docs/high-availability.md</code>.</small></p>';
  }

  function tick() {
    mediatorFetch('cluster/status')
      .then(function(r) { return r.json(); })
      .then(paint)
      .catch(function(e) {
        el.innerHTML = '<h2>Backends</h2><p style="color:#c62828">Could not read cluster status: ' +
          e.message + '</p><p><small>The mediator itself may be down — it is the thing doing the ' +
          'probing, and it is deliberately not redundant (see the scaling plan).</small></p>';
      });
  }

  tick();
  if (_clusterTimer) clearInterval(_clusterTimer);
  _clusterTimer = setInterval(function() {
    // Stop polling once the user has navigated away.
    if (location.hash.indexOf('#/cluster') !== 0) { clearInterval(_clusterTimer); _clusterTimer = null; return; }
    tick();
  }, 15000);
}
