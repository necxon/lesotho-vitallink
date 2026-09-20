# High availability: redundant backends and database standby

The sandbox runs two FHIR backends behind `fhir-proxy`, two OpenSRP backends
behind `opensrp-proxy`, and a streaming standby of the database. Phones keep
syncing when a backend dies, and the data survives losing the primary database.

Everything here protects against a process or container dying. It does NOT
protect against losing the host: all of it runs on one machine. Host redundancy
needs 3 VMs (quorum for automatic database failover), on separate hypervisors -
three VMs on one physical host is still one failure from total loss.

Watch it live in the Administrator Portal under `Backends & Failover`
(`#/cluster`), which reads the mediator's `/cluster/status`.

## Topology

```
        Android app  (field phones - external)
             |
 - - - - - - | - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 :           v                                            VM 1                :
 :  +--------------------+     +--------------------+     single host        :
 :  |  fhir-proxy :8079  |     | opensrp-proxy :9904|     all containers     :
 :  |  connect timeout 3s|     | connect timeout 3s |                        :
 :  |  retry other node  |     | retry other node   |  +-----------------+   :
 :  |  reload every 30s  |     | reload every 30s   |  |  bkm-mediator   |   :
 :  +---------+----------+     +---------+----------+  | /cluster/status |   :
 :            |                          |             +--------+--------+   :
 :     +------+------+            +------+------+               | probes     :
 :     v             v            v             v               | each node  :
 :+----------+ +-----------+ +----------+ +-------------+ <-----+ BY NAME    :
 :| hapi-fhir| |hapi-fhir-2| | opensrp- | | opensrp-    |                    :
 :| :18079   | | :18080    | | server   | | server-2    |                    :
 :| resthook | | resthook  | | :9900    | | :9903       |                    :
 :| ON       | | OFF       | | 1.4G cap | | 1.4G cap    |                    :
 :+-----+----+ +-----+-----+ +-----+----+ +------+------+                    :
 :      |            |             |             |                          :
 :      |            |             +------+------+                          :
 :      |            |                    v                                 :
 :      |            |            +---------------+                         :
 :      |            |            | opensrp-redis |  <- SPOF: standalone,   :
 :      |            |            | (auth cache)  |     Sentinel not on     :
 :      |            |            +-------+-------+                         :
 :      +------+-----+                    |                                 :
 :             v                          v                                 :
 :     +-----------------------------------------+                          :
 :     |        health-db-postgres  PRIMARY       |                          :
 :     |  hapi_fhir dhis2 keycloak opensrp        |                          :
 :     |  mediator superset                       |                          :
 :     +-------------------+---------------------+                          :
 :                         | streaming replication (WAL), cluster-wide       :
 :                         v                                                 :
 :     +-----------------------------------------+                          :
 :     |        health-db-standby  HOT STANDBY    |                          :
 :     |        :15433  read-only, promote on loss|                          :
 :     +-----------------------------------------+                          :
 : - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - :
        lose this host and every box inside it is lost
```

The dashed boundary is the whole point of the picture: every pair above
survives a container dying, and none of it survives the VM dying. The
Administrator Portal draws the same boundary live on its Backends page.

| Dies | Effect |
|---|---|
| `hapi-fhir` or `hapi-fhir-2` | Automatic. 12/12 requests still served, ~3s worst-case retry |
| `opensrp-server` or `-2` | Automatic, same mechanism via `opensrp-proxy`. 12/12 served |
| `opensrp-redis` | OpenSRP auth cache lost - both nodes affected. Not yet redundant |
| `health-db-postgres` | Manual promote of the standby, then repoint services |
| `fhir-proxy` | Outage - single load balancer, not redundant |
| `bkm-mediator` | Fan-out and the Backends page stop; phone sync keeps working |

The two single points of failure left are `fhir-proxy` and the host itself. A
third HAPI node addresses neither, which is why a second proxy is the better
next step than a third backend.

## What is redundant, and what is not

| Component | Redundant | Notes |
|---|---|---|
| hapi-fhir | Yes - 2 nodes | `hapi-fhir` and `hapi-fhir-2`, same database, automatic failover |
| opensrp-server | Yes - 2 nodes | `opensrp-server` and `-2` behind `opensrp-proxy`. Active-active is safe because the auth cache is in Redis, not the JVM |
| db-postgres | Yes - hot standby | `db-postgres-standby`, streaming, read-only until promoted |
| fhir-proxy | No | It is the load balancer. One instance on one host. |
| bkm-mediator | No | Leader-locked. Two instances would double the fan-out to DHIS2 and OpenLMIS. |
| opensrp-redis | No | `redis.architecture=standalone` with no sentinels. The config supports Sentinel; enabling it is the fix. |

## FHIR backend failover

`fhir-proxy` load balances across both nodes and retries the other one on
`error`, `timeout` or a 5xx, including for POSTs. Failover is automatic: there is
no switch to flip and no portal button, because there is nothing for an operator
to decide.

### Testing it

```
make ha-drill          # full drill, ~4 min, exits non-zero on any failure
make ha-drill-quick    # ~40s, skips waiting for nodes to rejoin
make ha-status         # live JSON, same data the portal renders
```

The drill kills each backend in turn while traffic is flowing, checks the health
endpoints report the right node as down, restarts it and waits for it to rejoin,
then writes a row on the primary and reads it back off the standby - proving
replication is really applying changes rather than merely being connected. It
also checks the standby still refuses writes, since one that accepts them has
been promoted and is no longer a replica.

Current result: 16 checks, 0 failures, 12/12 requests served on both the FHIR
and OpenSRP tiers with a node down.

The drill is worth running rather than trusting the design. The first run found
that killing a backend lost two requests, because a killed container does not
refuse connections - it becomes unroutable, and nginx sat on its default 60s
`proxy_connect_timeout` before trying the other node, which is far longer than a
phone will wait. `proxy_connect_timeout 3s` fixed it: the same drill now loses
nothing. Failover was "working" the whole time; it was just too slow to matter.

Two behaviours worth knowing:

- A node is dropped from rotation after `max_fails=2` within `fail_timeout=10s`
  and retried after that window. Until it is dropped, some requests pay a failed
  connection plus a retry, so latency rises briefly before it settles.
- nginx open source resolves `upstream` names ONCE at config load and caches the
  IP for the life of the process. A recreated container comes back on a new IP,
  and the load balancer keeps posting to the old one - a healthy backend looks
  dead. `fhir-proxy` therefore runs `nginx -s reload` every 30s, so a recreated
  backend heals itself within 30s. The per-backend health checks avoid the
  problem entirely by resolving through a variable on each request.

## Database standby

`db-postgres-standby` takes a `pg_basebackup` from the primary on first start,
then streams. Replication is cluster-wide, so `hapi_fhir`, `dhis2`, `keycloak`,
`opensrp`, `mediator` and `superset` are all covered.

The primary needs `wal_level=replica` (already set), a `replicator` role and a
`host replication replicator all md5` line in `pg_hba.conf`. Both are applied by
`scripts/sql/` setup and survive in the data volume.

### Promoting the standby

Only when the primary is genuinely gone. A promoted standby stops following the
primary, and if the primary comes back the two diverge - you then have two
databases that disagree, which is worse than the outage.

```bash
# 1. confirm the primary really is down, not just slow
docker exec health-db-postgres pg_isready -U admin

# 2. promote
docker exec health-db-standby pg_ctl promote -D /var/lib/postgresql/data

# 3. verify it left recovery
docker exec health-db-standby psql -U admin -d postgres -c "SELECT pg_is_in_recovery();"
#    expect: f

# 4. repoint services at the standby, then restart them
#    db-postgres -> db-postgres-standby in docker-compose.yml
```

The portal flags a promoted standby in orange, because from that moment you are
running without a replica.

### Rebuilding a standby

After a promotion, or if replication breaks, throw the standby data away and let
it re-seed:

```bash
docker compose stop db-postgres-standby
docker volume rm lesotho-vitallink_postgres-standby-data
docker compose up -d db-postgres-standby     # takes a fresh base backup
```

## Running the failover drill

Worth doing before anyone relies on this.

```bash
# kill a backend and watch traffic continue
docker kill hapi-fhir
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8079/fhir/Patient?_count=1; done
# expect: 200s

# per-node truth (these bypass the load balancer)
curl -s -o /dev/null -w "b1=%{http_code}\n" http://localhost:8079/backend/1/health
curl -s -o /dev/null -w "b2=%{http_code}\n" http://localhost:8079/backend/2/health

docker compose up -d hapi-fhir               # ~90s to boot
```

## Active-active vs active-standby

Not one choice - it depends on whether a node holds authoritative state.

| Tier | Model | Why |
|---|---|---|
| hapi-fhir, opensrp-server, bkm-web, the proxies | Active-active | No local state. Any node serves any request. |
| Postgres | Active-standby | Postgres has one writable primary. "Active-active" would mean multi-master, which it does not do natively. |
| bkm-mediator | Active-standby | Leader-locked; two active instances double the fan-out. |
| opensrp-redis | Active-standby (once Sentinel is on) | `opensrp.properties` already has `redis.master` and `redis.sentinels` fields. |

### Memory

An uncapped JVM expands to fill the host: `opensrp-server` alone sat at 2.3GB.
Both OpenSRP nodes are capped with `CATALINA_OPTS=-Xmx1024m` plus
`mem_limit: 1400m`, and the pair now uses ~1.4GB in total - less than the single
uncapped node did. `mem_limit` without a matching `-Xmx` does not help: the JVM
still grows and the container gets OOM-killed instead.

## Adding a third backend

Copy the `hapi-fhir-2` service to `hapi-fhir-3`, give it a free host port, add it
to the `hapi_backends` upstream in `config/fhir-proxy/nginx.conf` and to
`CLUSTER_FHIR_NODES` on the mediator.

Keep `hapi.fhir.subscription.resthook_enabled=false` on every node except the
first. HAPI delivers subscriptions per instance, so each node with it enabled
sends its own copy of every subscription.
