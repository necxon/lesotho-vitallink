/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function clusterHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>The <strong>Backends</strong> page shows whether the system is still covered after ' +
      'something has died. The diagram is live: it is drawn from the same ' +
      '<code>/cluster/status</code> reading as the tables, refreshed every 15 seconds, so the ' +
      'picture and the numbers can never disagree.</p>' +
      '<p>A link only animates when <strong>both</strong> ends are up. A link into a dead node ' +
      'goes red and stops moving, because showing traffic flowing into a node that is gone is ' +
      'the one thing you must not be told during an incident.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Reading the diagram</h4>' +
      '<div class="help-flow" style="flex-wrap:wrap">' +
        '<span class="flow-step" style="border-color:#2e7d32"><strong style="color:#2e7d32">Green, moving</strong><small>up and carrying traffic</small></span>' +
        '<span class="flow-step" style="border-color:#c62828"><strong style="color:#c62828">Red, dashed</strong><small>one end is down</small></span>' +
        '<span class="flow-step" style="border-color:#9e9e9e"><strong style="color:#616161">Grey</strong><small>nothing probes it</small></span>' +
        '<span class="flow-step" style="border-color:#546e7a"><strong style="color:#546e7a">Dashed box</strong><small>the host boundary</small></span>' +
      '</div>' +
      '<p>Every node also says <strong>Up</strong>, <strong>DOWN</strong> or ' +
      '<strong>not monitored</strong> in words, so nothing depends on telling colours apart.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>What is redundant</h4>' +
      '<table role="grid">' +
        '<thead><tr><th>Component</th><th>Redundant</th><th>What happens when it dies</th></tr></thead>' +
        '<tbody>' +
        '<tr><td><code>hapi-fhir</code> &times;2</td><td>Yes</td>' +
          '<td>Automatic. <code>fhir-proxy</code> retries the other node, phones keep syncing.</td></tr>' +
        '<tr><td><code>opensrp-server</code> &times;2</td><td>Yes</td>' +
          '<td>Automatic, same mechanism via <code>opensrp-proxy</code>.</td></tr>' +
        '<tr><td><code>health-db-postgres</code></td><td>Hot standby</td>' +
          '<td>Not automatic. Someone promotes the standby, then services are repointed.</td></tr>' +
        '<tr><td><code>opensrp-redis</code></td><td style="color:#c62828">No</td>' +
          '<td>Both OpenSRP nodes lose their auth cache. It is a single point of failure.</td></tr>' +
        '<tr><td><code>fhir-proxy</code> / <code>opensrp-proxy</code></td><td style="color:#c62828">No</td>' +
          '<td>They are the load balancers. One each, so losing one is an outage for that tier.</td></tr>' +
        '<tr><td><code>bkm-mediator</code></td><td style="color:#c62828">No</td>' +
          '<td>Fan-out to DHIS2/OpenLMIS stops and this page goes blank. Phone sync is unaffected. ' +
          'It is leader-locked, so a second copy would double every fan-out.</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>The dashed boundary matters more than the green</h4>' +
      '<p>Every container in the diagram runs on <strong>one machine</strong>. The pairs survive ' +
      'a container dying; none of it survives the host dying. That is the honest limit of what is ' +
      'deployed today.</p>' +
      '<p>Host redundancy needs at least <strong>2 VMs</strong>, and realistically a third small ' +
      'witness. Two nodes cannot safely promote a database on their own: neither can tell ' +
      '&ldquo;the other is dead&rdquo; from &ldquo;the link between us is cut&rdquo;, so both may ' +
      'promote and the two databases diverge. A witness running etcd on 1 vCPU breaks the tie.</p>' +
      '<p>Surviving the loss of a whole <strong>site</strong> means two sites with asynchronous ' +
      'replication plus a witness somewhere independent. See ' +
      '<code>docs/high-availability.md</code> for the full topology table.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>If a node is down</h4>' +
      '<p>Nothing to switch &mdash; failover already happened. Bring the node back with ' +
      '<code>docker compose up -d &lt;name&gt;</code>; a HAPI node takes about 90 seconds to boot ' +
      'and rejoins by itself.</p>' +
      '<p>If a node looks dead but you believe it is healthy, it may have been recreated on a new ' +
      'IP. nginx resolves upstream names once at startup, so the proxies reload themselves every ' +
      '30 seconds to pick up the change &mdash; wait that out, or run ' +
      '<code>docker exec fhir-proxy nginx -s reload</code>.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Proving it works</h4>' +
      '<p>Do not trust a design you have not tested. <code>make ha-drill</code> kills each backend ' +
      'in turn while traffic is flowing, then writes a row on the primary and reads it back off the ' +
      'standby to confirm replication is really applying changes rather than merely being connected. ' +
      'It exits non-zero on any failure, so it can gate a deploy.</p>' +
      '<p>The drill is not ceremony. Its first run found that killing a backend lost two requests: a ' +
      'killed container does not refuse connections, it becomes unroutable, and nginx sat on its ' +
      '60-second default connect timeout before trying the other node &mdash; far longer than a phone ' +
      'waits. A 3-second timeout took that to zero lost. Failover had been &ldquo;working&rdquo; the ' +
      'whole time, just too slowly to matter.</p>' +
      '<p>To watch it live: run <code>docker kill hapi-fhir</code> with this page open and the node ' +
      'turns red within 15 seconds.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Promoting the database standby</h4>' +
      '<p>Only when the primary is genuinely gone, not merely slow. A promoted standby stops ' +
      'following the primary, and if the primary returns the two diverge &mdash; which is worse than ' +
      'the outage.</p>' +
      '<pre>docker exec health-db-standby \\\n  pg_ctl promote -D /var/lib/postgresql/data</pre>' +
      '<p>This page turns the standby row orange once promoted, because from that moment you are ' +
      'running without a replica and need to rebuild one.</p>' +
    '</div>'
  );
}
