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
// Which tab is open, so the 15s refresh does not snap the reader back to Status.
var _clusterTab = 'cluster-data';

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

/* ── Live topology diagram ────────────────────────────────────────────────────
 * Inline SVG rather than a library: it is a fixed layout of a dozen boxes, and
 * an animation frame budget spent on a dependency here would buy nothing.
 *
 * Traffic flows along a link only when BOTH ends are up, so a dead node shows as
 * a stalled red link rather than a box that has quietly changed colour. Status
 * is never carried by colour alone - every node also states Up or DOWN in text.
 */

var _CL = {
  up:   '#2e7d32',
  down: '#c62828',
  warn: '#ef6c00',
  idle: '#9e9e9e',
  ink:  '#263238',
};

function _clNode(x, y, w, h, title, sub, state) {
  // state: 'up' | 'down' | 'idle'
  var stroke = _CL[state] || _CL.idle;
  var fill   = state === 'up' ? '#f1f8f2' : (state === 'down' ? '#fdf1f1' : '#f5f5f5');
  var label  = state === 'up' ? 'Up' : (state === 'down' ? 'DOWN' : 'not monitored');
  return '' +
    '<g>' +
    '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="7" ' +
      'fill="' + fill + '" stroke="' + stroke + '" stroke-width="2"/>' +
    '<text x="' + (x + w / 2) + '" y="' + (y + 19) + '" text-anchor="middle" ' +
      'font-size="12.5" font-weight="600" fill="' + _CL.ink + '">' + title + '</text>' +
    (sub ? '<text x="' + (x + w / 2) + '" y="' + (y + 34) + '" text-anchor="middle" ' +
      'font-size="10.5" fill="#607d8b">' + sub + '</text>' : '') +
    '<text x="' + (x + w / 2) + '" y="' + (y + h - 8) + '" text-anchor="middle" ' +
      'font-size="10" font-weight="600" fill="' + stroke + '">' + label + '</text>' +
    '</g>';
}

function _clLink(path, state) {
  // A link is only "flowing" when traffic can actually traverse it.
  if (state === 'up') {
    return '<path d="' + path + '" class="cl-flow" fill="none" stroke="' + _CL.up +
           '" stroke-width="2.5" stroke-linecap="round"/>';
  }
  if (state === 'idle') {
    return '<path d="' + path + '" fill="none" stroke="' + _CL.idle +
           '" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.7"/>';
  }
  return '<path d="' + path + '" fill="none" stroke="' + _CL.down +
         '" stroke-width="2.5" stroke-dasharray="7 5" opacity="0.85"/>';
}

function _clusterDiagram(d) {
  var f  = d.fhir.nodes || [];
  var os = (d.opensrp && d.opensrp.nodes) ? d.opensrp.nodes : [];
  var pri = d.database.primary;
  var sby = d.database.standby;

  var f1 = f[0] || { up: false, name: 'hapi-fhir' };
  var f2 = f[1] || { up: false, name: 'hapi-fhir-2' };
  var o1 = os[0];
  var o2 = os[1];

  var st = function(n) { return n && n.up ? 'up' : 'down'; };
  // A proxy is only useful if at least one node behind it is alive.
  var fhirProxy = (f1.up || f2.up) ? 'up' : 'down';
  var osProxy   = os.length ? ((o1 && o1.up) || (o2 && o2.up) ? 'up' : 'down') : 'idle';
  var priState  = pri.up ? 'up' : 'down';
  var sbyState  = sby.up ? (sby.role === 'standby' ? 'up' : 'warn') : 'down';

  var svg = [];
  svg.push('<svg viewBox="0 0 920 690" width="100%" role="img" ' +
           'aria-label="Live topology of the redundant backends, all running on one host" ' +
           'style="max-width:920px;font-family:inherit">');
  svg.push('<style>' +
    '.cl-flow{stroke-dasharray:7 7;animation:cl-dash 1.1s linear infinite}' +
    '@keyframes cl-dash{to{stroke-dashoffset:-28}}' +
    '@media (prefers-reduced-motion: reduce){.cl-flow{animation:none;stroke-dasharray:none}}' +
    '</style>');

  // The host boundary. Every container in this diagram runs inside it, which is
  // the point: all the redundancy below protects against a process dying, not
  // against losing this machine. Drawn first so everything paints on top.
  svg.push('<rect x="10" y="62" width="900" height="606" rx="12" fill="#fbfbfd" ' +
           'stroke="#546e7a" stroke-width="2" stroke-dasharray="9 6"/>');
  svg.push('<rect x="26" y="50" width="232" height="24" rx="5" fill="#546e7a"/>');
  svg.push('<text x="142" y="67" text-anchor="middle" font-size="11.5" ' +
           'font-weight="700" fill="#fff">VM 1 - single host, all containers</text>');
  svg.push('<text x="24" y="682" font-size="10.5" fill="#78909c">' +
           'lose this host and every box inside it is lost</text>');

  // What is NOT deployed, drawn faintly. A diagram that only shows what exists
  // makes a single host look like a complete design; showing the gap is the
  // point of putting a boundary on it at all.
  svg.push('<g opacity="0.42">');
  svg.push('<rect x="640" y="600" width="128" height="62" rx="10" fill="none" ' +
           'stroke="#90a4ae" stroke-width="1.6" stroke-dasharray="5 5"/>');
  svg.push('<text x="704" y="624" text-anchor="middle" font-size="11" font-weight="600" ' +
           'fill="#78909c">VM 2</text>');
  svg.push('<text x="704" y="640" text-anchor="middle" font-size="9.5" fill="#90a4ae">not deployed</text>');
  svg.push('<text x="704" y="653" text-anchor="middle" font-size="9.5" fill="#90a4ae">survives host loss</text>');
  svg.push('<rect x="780" y="600" width="128" height="62" rx="10" fill="none" ' +
           'stroke="#90a4ae" stroke-width="1.6" stroke-dasharray="5 5"/>');
  svg.push('<text x="844" y="624" text-anchor="middle" font-size="11" font-weight="600" ' +
           'fill="#78909c">Site B + witness</text>');
  svg.push('<text x="844" y="640" text-anchor="middle" font-size="9.5" fill="#90a4ae">not deployed</text>');
  svg.push('<text x="844" y="653" text-anchor="middle" font-size="9.5" fill="#90a4ae">survives site loss</text>');
  svg.push('</g>');

  // Phones are the only actor outside the VM, so they sit above the boundary
  // and everything else is translated down into it.
  svg.push(_clNode(60, 6, 180, 40, 'Android app', 'field phones - external', 'up'));
  svg.push(_clLink('M150 46 L150 164', fhirProxy));

  svg.push('<g transform="translate(0,46)">');

  // --- links first so boxes paint over the ends -----------------------------
  svg.push(_clLink('M455 74 L455 118', osProxy));                         // callers -> opensrp-proxy
  svg.push(_clLink('M775 74 L775 118', 'up'));                            // portal -> mediator

  svg.push(_clLink('M110 172 L70 216', st(f1)));
  svg.push(_clLink('M190 172 L230 216', st(f2)));
  svg.push(_clLink('M415 172 L375 216', o1 ? st(o1) : 'idle'));
  svg.push(_clLink('M495 172 L535 216', o2 ? st(o2) : 'idle'));

  // mediator probes every node directly, which is why it is drawn as a
  // separate dashed path rather than following the traffic links.
  svg.push(_clLink('M775 172 C775 250 700 250 600 250', 'idle'));

  svg.push(_clLink('M375 270 L455 316', o1 ? st(o1) : 'idle'));           // opensrp -> redis
  svg.push(_clLink('M535 270 L505 316', o2 ? st(o2) : 'idle'));

  svg.push(_clLink('M70 270 C70 360 200 360 260 414', f1.up && pri.up ? 'up' : 'down'));
  svg.push(_clLink('M230 270 C230 360 280 360 330 414', f2.up && pri.up ? 'up' : 'down'));
  svg.push(_clLink('M375 270 C375 380 420 380 430 414', o1 && o1.up && pri.up ? 'up' : 'down'));
  svg.push(_clLink('M535 270 C535 380 520 380 500 414', o2 && o2.up && pri.up ? 'up' : 'down'));
  svg.push(_clLink('M480 490 L480 534', pri.up && sby.up && sby.role === 'standby' ? 'up' : 'down'));

  // --- boxes ----------------------------------------------------------------
  svg.push(_clNode(365, 30, 180, 44, 'opensrp-web / mediator', 'OpenSRP REST', 'up'));
  svg.push(_clNode(685, 30, 180, 44, 'Administrator Portal', 'bkm-web :9902', 'up'));

  svg.push(_clNode(60, 118, 180, 54, 'fhir-proxy :8079', 'load balancer', fhirProxy));
  svg.push(_clNode(365, 118, 180, 54, 'opensrp-proxy :9904', 'load balancer', osProxy));
  svg.push(_clNode(685, 118, 180, 54, 'bkm-mediator', 'not redundant', 'up'));

  svg.push(_clNode(20, 216, 150, 54, f1.name || 'hapi-fhir', ':18079  resthook ON', st(f1)));
  svg.push(_clNode(180, 216, 150, 54, f2.name || 'hapi-fhir-2', ':18080  resthook OFF', st(f2)));
  svg.push(_clNode(340, 216, 150, 54, o1 ? o1.name : 'opensrp-server', ':9900  1.4G cap',
                   o1 ? st(o1) : 'idle'));
  svg.push(_clNode(500, 216, 150, 54, o2 ? o2.name : 'opensrp-server-2', ':9903  1.4G cap',
                   o2 ? st(o2) : 'idle'));

  // Redis is a genuine single point of failure for the OpenSRP pair and is not
  // probed, so it is drawn grey rather than guessed green.
  svg.push(_clNode(410, 316, 170, 50, 'opensrp-redis', 'auth cache - SPOF', 'idle'));

  svg.push(_clNode(200, 414, 400, 76, 'health-db-postgres   PRIMARY',
    'hapi_fhir  dhis2  keycloak  opensrp  mediator  superset', priState));
  svg.push(_clNode(200, 534, 400, 62, 'health-db-standby   HOT STANDBY',
    ':15433  read-only  ' + (sby.up ? 'lag ' + sby.lagSeconds + 's' : 'unreachable'), sbyState));

  svg.push('<text x="612" y="466" font-size="10.5" fill="#607d8b">streaming</text>');
  svg.push('<text x="612" y="480" font-size="10.5" fill="#607d8b">replication</text>');
  svg.push('<text x="612" y="252" font-size="10.5" fill="#607d8b">probes</text>');
  svg.push('</g>');
  svg.push('</svg>');

  var legend =
    '<p style="margin:6px 0 0"><small>' +
    '<span style="color:' + _CL.up + '">&#9632;</span> flowing &nbsp; ' +
    '<span style="color:' + _CL.down + '">&#9632;</span> broken &nbsp; ' +
    '<span style="color:' + _CL.idle + '">&#9632;</span> not monitored &nbsp;&middot;&nbsp; ' +
    'A link animates only when both ends are up. Prove it for real with ' +
    '<code>make ha-drill</code>.' +
    '</small></p>' +
    '<p style="margin:4px 0 0"><small>The dashed boundary is the host. Everything ' +
    'inside it shares one machine, so the pairs above survive a container dying but ' +
    'not the VM dying. Host redundancy needs 3 VMs on separate hypervisors - two ' +
    'cannot safely auto-promote the database, and three on one physical box is still ' +
    'one failure from total loss.</small></p>';

  return '<div style="overflow-x:auto;margin-bottom:18px">' + svg.join('') + '</div>' + legend;
}

/*
 * The promote control.
 *
 * Shown only when it could legitimately be used - the primary unreachable and
 * the standby still following. The rest of the time it is a disabled
 * explanation, because an always-live red button next to a database is an
 * invitation, and this action cannot be undone.
 *
 * Confirmation is a TYPED word, not an OK/Cancel dialog. During an incident
 * people click through dialogs; typing PROMOTE takes a deliberate moment. The
 * real protection is still server side: /cluster/promote-standby refuses while
 * the primary answers, whatever this page sends.
 */
function _clusterPromoteBox(d) {
  var pri = d.database.primary;
  var sby = d.database.standby;
  var armed = !pri.up && sby.up && sby.role === 'standby';

  if (!armed) {
    var why = pri.up
      ? 'The primary is still serving, so there is nothing to promote. Promoting now would ' +
        'leave two writable databases diverging.'
      : (!sby.up ? 'The standby is unreachable.' : 'This server has already been promoted - rebuild a replica instead.');
    return '<details style="margin-top:10px"><summary><small>Promote the standby</small></summary>' +
           '<p><small>' + why + '</small></p>' +
           '<p><small>Available only while the primary is unreachable. To promote against a live ' +
           'primary you must do it deliberately on the box:<br>' +
           '<code>docker exec health-db-standby pg_ctl promote -D /var/lib/postgresql/data</code>' +
           '</small></p></details>';
  }

  return '<div style="border:2px solid #c62828;background:#fdf1f1;padding:12px 16px;margin-top:12px">' +
    '<strong style="color:#c62828">The primary is unreachable</strong>' +
    '<p><small>Promoting makes this replica writable and it stops following the old primary. ' +
    'It cannot be undone: if the old primary comes back, the two diverge. Do this only when the ' +
    'primary is genuinely gone, not merely slow. Afterwards you are running with no replica, and ' +
    'services still point at the old primary until repointed.</small></p>' +
    '<label><small>Type <code>PROMOTE</code> to enable the button</small>' +
    '<input id="cl-confirm" type="text" autocomplete="off" placeholder="PROMOTE" ' +
    'style="max-width:220px"></label>' +
    '<button id="cl-promote" disabled onclick="promoteStandby()" ' +
    'style="background:#c62828;border-color:#c62828">Promote standby</button>' +
    '<p id="cl-promote-out"><small></small></p>' +
    '</div>';
}

function promoteStandby() {
  var out = document.getElementById('cl-promote-out');
  var btn = document.getElementById('cl-promote');
  if (document.getElementById('cl-confirm').value !== 'PROMOTE') return;
  btn.disabled = true;
  btn.textContent = 'Promoting…';
  out.innerHTML = '<small>Waiting for the server to leave recovery…</small>';

  mediatorFetch('cluster/promote-standby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'PROMOTE' }),
  })
    .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(res) {
      if (res.ok && res.j.ok) {
        out.innerHTML = '<small style="color:#2e7d32"><strong>Promoted.</strong> ' + res.j.note + '</small>';
      } else {
        // A refusal is the guard working, so it is reported as guidance rather
        // than as a failure of the page.
        btn.disabled = false;
        btn.textContent = 'Promote standby';
        out.innerHTML = '<small style="color:#ef6c00"><strong>Refused: ' +
          (res.j.error || 'unknown') + '.</strong> ' + (res.j.detail || '') + '</small>';
      }
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = 'Promote standby';
      out.innerHTML = '<small style="color:#c62828">Could not reach the mediator: ' + e.message + '</small>';
    });
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
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="cluster-data">Status</button>' +
        '<button class="page-tab" data-tab="cluster-help">? Help</button>' +
      '</div>' +
      '<div id="cluster-data">' +
      _clusterBanner(d.health) +
      _clusterDiagram(d) +
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
      _clusterPromoteBox(d) +
      (standbyWarn
        ? '<p><small style="color:#ef6c00"><strong>The standby has been promoted.</strong> It is no longer ' +
          'following the primary, so the two are diverging. Rebuild it from a fresh base backup once the ' +
          'failover is resolved.</small></p>'
        : '') +
      '<p><small>Checked ' + new Date(d.checkedAt).toLocaleTimeString() + '. Refreshes every 15s. ' +
      'Failover drill and promotion steps: <code>docs/high-availability.md</code>.</small></p>' +
      '</div>' +
      '<div id="cluster-help" class="help-panel" hidden>' + clusterHelpHTML() + '</div>';

    // Re-bound on every repaint because the 15s refresh replaces this markup.
    // activeTab is read back from the DOM first so a refresh does not yank the
    // user out of the help panel mid-read.
    el.querySelectorAll('.page-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var target = tab.getAttribute('data-tab');
        _clusterTab = target;
        document.getElementById('cluster-data').hidden = (target !== 'cluster-data');
        document.getElementById('cluster-help').hidden = (target !== 'cluster-help');
      });
    });
    // Typed confirmation gate. Re-bound each repaint because the 15s refresh
    // replaces this markup.
    var confirmBox = document.getElementById('cl-confirm');
    if (confirmBox) {
      confirmBox.addEventListener('input', function() {
        document.getElementById('cl-promote').disabled = (confirmBox.value !== 'PROMOTE');
      });
    }

    if (_clusterTab === 'cluster-help') {
      el.querySelector('[data-tab="cluster-help"]').click();
    }
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
