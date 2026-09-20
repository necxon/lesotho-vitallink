# High availability: redundant backends and database standby

The sandbox runs two FHIR backends behind `fhir-proxy` and a streaming standby of
the database. Phones keep syncing when a backend dies, and the data survives
losing the primary database.

Watch it live in the Administrator Portal under `Backends & Failover`
(`#/cluster`), which reads the mediator's `/cluster/status`.

## Topology

```
                    Android app                Administrator Portal
                    (phones sync)              bkm-web :9902
                         |                            |
                         |                            | #/cluster
                         v                            v
              +----------------------+        /mediator-api/cluster/status
              |  fhir-proxy  :8079   |                |
              |  - load balancer -   |                v
              |  connect timeout 3s  |        +-------------------+
              |  retry -> other node |        |  bkm-mediator     |
              |  reload every 30s    |        |  /cluster/status  |
              +----------+-----------+        +---------+---------+
                         |                              | probes each
            +------------+------------+                 | node BY NAME
            v                         v                 | (not via LB)
    +---------------+         +---------------+ <-------+
    |  hapi-fhir    |         |  hapi-fhir-2  |
    |  :18079       |         |  :18080       |
    |  resthook ON  |         |  resthook OFF |  <- or subscriptions fire twice
    +-------+-------+         +-------+-------+
            +------------+------------+
                         v
            +-------------------------+
            |  health-db-postgres     |  PRIMARY
            |  hapi_fhir, dhis2,      |
            |  keycloak, opensrp,     |
            |  mediator, superset     |
            +-----------+-------------+
                        | streaming replication (WAL), cluster-wide
                        v
            +-------------------------+
            |  health-db-standby      |  HOT STANDBY
            |  :15433  read-only      |  promote on primary loss
            +-------------------------+
```

| Dies | Effect |
|---|---|
| `hapi-fhir` or `hapi-fhir-2` | Automatic. 15/15 requests still served, ~3s worst-case retry |
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
| db-postgres | Yes - hot standby | `db-postgres-standby`, streaming, read-only until promoted |
| fhir-proxy | No | It is the load balancer. One instance on one host. |
| bkm-mediator | No | Leader-locked. Two instances would double the fan-out to DHIS2 and OpenLMIS. |
| opensrp-server | No | Not on the app's sync path - phones talk to fhir-proxy, not to it. |

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

Current result: 14 checks, 0 failures, 15/15 requests served with a backend
down.

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

## Adding a third backend

Copy the `hapi-fhir-2` service to `hapi-fhir-3`, give it a free host port, add it
to the `hapi_backends` upstream in `config/fhir-proxy/nginx.conf` and to
`CLUSTER_FHIR_NODES` on the mediator.

Keep `hapi.fhir.subscription.resthook_enabled=false` on every node except the
first. HAPI delivers subscriptions per instance, so each node with it enabled
sends its own copy of every subscription.
