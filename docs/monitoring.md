# Monitoring Stack

Prometheus + Grafana + Loki — observability for all services in the sandbox.

---

## Architecture

```
Docker containers
      │
      ├─ Promtail  ──── container stdout/stderr ──► Loki (log storage)
      │                 (via Docker socket discovery)
      │
      ├─ cAdvisor  ──── container CPU/mem/net/disk ──► Prometheus
      │
      └─ postgres-exporter ── PostgreSQL metrics ──► Prometheus

                                    │
                              Grafana (port 3005)
                              queries both datasources
```

| Service | Port | Purpose |
|---|---|---|
| Grafana | http://localhost:3005 | Dashboards UI (admin / admin123) |
| Prometheus | http://localhost:9090 | Metrics store + query UI |
| Loki | http://localhost:3100 | Log aggregation API |
| Promtail | — | Log shipper (no UI) |
| cAdvisor | — | Container metrics exporter (no public port) |
| postgres-exporter | — | PostgreSQL metrics exporter (no public port) |

---

## Datasources

Both datasources are auto-provisioned from `config/grafana/provisioning/datasources/datasources.yaml` — no manual setup needed after `docker compose up`.

| Name | Type | URL (internal) | Default |
|---|---|---|---|
| Prometheus | prometheus | http://prometheus:9090 | Yes |
| Loki | loki | http://loki:3100 | No |

---

## Dashboards

All dashboards are provisioned from `config/grafana/dashboards/` and auto-loaded every 30 seconds. Changes to JSON files appear in Grafana without a restart.

### BKM Mediator Logs
**URL:** http://localhost:3005/d/bkm-mediator-logs
**Datasource:** Loki
**Container:** `bkm-mediator`

Tracks the fan-out mediator — the central integration hub.

| Section | Content |
|---|---|
| Overview | Error count, fan-out events, orders saved, order dispatches, BR-04 violations, stock rejections |
| Throughput & Latency | Log volume by level, event type breakdown (dispense/receipt/adjustment/order), fan-out latency avg/max (parsed from `QR fan-out in Xms`), downstream system failure rate (opensrp/dhis2/lmis) |
| Rejections & Alerts | BR-04 violation log (Task already accepted), insufficient stock rejection log |
| Stock Orders & Dispatch | Recent orders table (medicine, qty, total, org unit — parsed from structured JSON), order/dispatch log stream |
| All Logs | Full log stream, errors & warnings, fan-out events |

Key Loki queries:
```logql
# Fan-out latency (ms) extracted from log line
avg_over_time(
  {container="bkm-mediator"} |~ "QR fan-out in"
  | regexp `QR fan-out in (?P<duration_ms>[0-9]+)ms`
  | unwrap duration_ms [$__interval]
)

# Structured order events
{container="bkm-mediator"} | json | event="order-saved"
```

---

### OpenLMIS
**URL:** http://localhost:3005/d/openlmis-overview
**Datasource:** Loki
**Containers:** `openlmis-nginx`, `openlmis-stockmanagement`, `openlmis-auth`, `openlmis-referencedata`

| Section | Content |
|---|---|
| Overview | Nginx 5xx/4xx errors, stock events processed, token requests, auth errors, service errors |
| Nginx — HTTP Traffic | Request rate by status class (2xx/4xx/5xx), upstream response time (ms), error access log |
| Stock Management | Log volume by level, stock event success/failure rate, errors & warnings log |
| Auth Service | Log volume, token grant/check/invalid rate, auth error log |
| Service Health Comparison | ERROR rate for all 4 Spring Boot services on one chart |
| Raw Logs | Full unfiltered streams (collapsed) |

Nginx log format (parsed):
`IP - user [timestamp] "METHOD /path HTTP/1.1" status bytes "-" "UA" upstream_time ...`

---

### FHIR (HAPI + OpenSRP)
**URL:** http://localhost:3005/d/fhir-overview
**Datasource:** Loki
**Containers:** `hapi-fhir`, `opensrp-server`

HAPI FHIR logs every request via `fhirtest.access` interceptor in the format:
`Operation[search-type  Observation] UA[okhttp/4.12.0] Params[...]`

| Section | Content |
|---|---|
| Overview | Total requests, write operations, QuestionnaireResponse count, Task operations, HAPI errors, OpenSRP errors (Redis excluded) |
| Request Throughput | Read vs write rate, per-operation-type breakdown (search/read/create/update/transaction) |
| Resource Activity | Stock resources (QR, Task, MedicationDispense) rate, demographic resources (Patient, Practitioner, Group, CarePlan) rate |
| Android Sync Activity | Android (okhttp UA) vs other client rate, per-resource-type during sync, Android write-only log stream |
| Errors & OpenSRP Health | HAPI error rate, OpenSRP real error rate (Redis noise filtered), error log streams |
| Raw Logs | Full streams (collapsed) |

> **OpenSRP Redis noise:** `opensrp-server` continuously logs `RedisMessageListenerContainer Connection failure` because there is no Redis service in the stack. These are filtered out of all error panels. The OpenSRP API still works for read operations.

---

### OpenHIM
**URL:** http://localhost:3005/d/openhim-errors
**Datasource:** Loki
**Container:** `openhim-core`

OpenHIM has several categories of log noise that are separated from real errors.

| Error type | Volume | Action needed |
|---|---|---|
| `audits.insertOne() buffering timed out` | High (~2800) | None — ATNA audit noise, transactions record fine |
| `error: undefined` | High | None — paired with above, same root cause |
| `Token authentication strategy is deprecated` | Medium (~265) | None — one per mediator heartbeat |
| `mxr.mozilla.org ENOTFOUND` | Low | None — startup Mozilla CRL check |
| `Wrong password entered by root@openhim.org` | Low (4) | Investigate — bad credential attempt |
| `getaddrinfo EAI_AGAIN vital-link` | Low (3) | Investigate — mediator DNS resolution failed |
| `Internal server error occured: [txId]` | Low (3) | Investigate — channel routing failure |
| `MongoServerError: Skip value must be non-negative` | Low (3) | Investigate — pagination bug in tasks API |

| Section | Content |
|---|---|
| Overview | Real errors, auth failures, transaction failures, audit timeouts, mediator heartbeats, DNS errors |
| Error Classification | Real errors vs ATNA noise rate, per-category breakdown, mediator heartbeat rate (gap = mediator down), audit timeout rate (MongoDB pressure) |
| Real Error Log Streams | Transaction failures (with tx ID), auth failures + DNS errors, all real errors (noise stripped) |
| Raw Logs | Full stream (collapsed) |

---

### Keycloak
**URL:** http://localhost:3005/d/keycloak-auth
**Datasource:** Loki
**Container:** `keycloak`

Event logging is enabled via the Admin API in `seed.sh` (step 8). Keycloak uses H2 (in-memory) in dev mode — event config is re-applied on every `seed.sh` run.

**What is logged to stdout (visible in Loki):** `LOGIN_ERROR`, `CLIENT_LOGIN_ERROR`, `LOGOUT_ERROR` events at WARN level via `jboss-logging`.

**What is NOT logged to stdout:** Successful `LOGIN`, `CODE_TO_TOKEN` events (stored in Keycloak H2 DB only). View them at: http://localhost:8083/admin/master/console/#/opensrp/events

Event log line format:
```
2026-03-15 11:51:09,273 WARN  [org.keycloak.events] (executor-thread-16)
  type="LOGIN_ERROR", realmId="opensrp", clientId="admin-cli",
  userId="ded10297-...", ipAddress="172.20.0.1",
  error="invalid_user_credentials", username="opensrp-admin"
```

| Error value | Meaning |
|---|---|
| `invalid_user_credentials` | Wrong password for known user — brute force risk |
| `user_not_found` | Username does not exist in realm |
| `account_disabled` | Account explicitly disabled |
| `account_temporarily_disabled` | Brute-force lockout triggered |

| Section | Content |
|---|---|
| Overview | Login errors, invalid credentials, unknown user attempts, client login errors, container restarts, WARN/ERROR lines |
| Auth Event Trends | LOGIN_ERROR rate, error reason breakdown over time |
| Auth Event Log Streams | Structured key=value event lines |
| Startup & Config Events | Restart/realm-import log, WARN lines (dev mode, XA recovery, Infinispan) |
| Raw Logs | Full stream (collapsed) |

---

### DHIS2
**URL:** http://localhost:3005/d/dhis2-overview
**Datasource:** Loki
**Container:** `dhis2-web`

Log format: `* LEVEL  TIMESTAMP (username) Message (ClassName.java [thread]) RequestUID`

| Section | Content |
|---|---|
| Overview | Auth success, auth failures, data value writes, metadata imports, analytics query errors, ERROR lines |
| Auth & Request Activity | Auth success/failure rate, WARN/ERROR rate, auth event log (username + IP) |
| Data Value Writes | Write rate (each = mediator stock push), metadata import rate, import log with total/import/update/delete counts |
| Analytics Errors | Error + fallback rate, deduped error log — most common: `column ax.uidlevel4 does not exist` |
| Scheduler & Startup | Scheduled job events (ANALYTICS_TABLE, resource tables), startup config warnings |
| Raw Logs | Full stream (collapsed) |

**Known analytics error — `uidlevel4 does not exist`:**
Village-level org units (Ha Mokoena, Ha Sehlabane, Matsieng) were added after the analytics tables were last built. The `uidlevel4` column is only added to `analytics_*` tables during a rebuild.

Fix:
```bash
curl -X POST -u admin:district http://localhost:8081/api/resourceTables/analytics
```

---

### Infrastructure — Docker & PostgreSQL
**URL:** http://localhost:3005/d/docker-infra
**Datasource:** Prometheus (cAdvisor + postgres-exporter)

| Section | Content |
|---|---|
| Overview | Running containers, total memory, total CPU cores, total network RX, network errors, PostgreSQL total size |
| CPU | Top-10 consumers time-series, all-containers bar gauge (current) |
| Memory | Top-10 working set time-series, all-containers bar gauge, RSS vs Cache vs Swap total, OOM failures |
| Network | RX/TX rate per container (top 8), dropped packets, total throughput |
| Disk I/O | Read/write ops rate per container, container filesystem usage bar gauge, I/O time utilisation |
| PostgreSQL | Database sizes bar gauge, DB size growth over time, lock contention by mode, `pg_up` health |

**Memory metric used:** `container_memory_working_set_bytes` (not `container_memory_usage_bytes`).
Working set = RSS + active file cache. It excludes reclaimable pages so it reflects actual memory pressure.

**Current approximate memory usage (at rest):**

| Container | ~Memory |
|---|---|
| dhis2-web | 1.9 GB |
| hapi-fhir | 1.9 GB |
| opensrp-server | 1.8 GB |
| cadvisor | 1.3 GB |
| openlmis-referencedata | 637 MB |
| keycloak | 627 MB |
| openlmis-stockmanagement | 567 MB |
| openlmis-auth | 477 MB |
| Others | < 300 MB each |

---

## Adding a New Dashboard

1. Create `config/grafana/dashboards/<name>.json` with a unique `"uid"` field.
2. Grafana reloads every 30 seconds — no restart needed.
3. Verify: `curl -s -u admin:admin123 http://localhost:3005/api/dashboards/uid/<uid> | python3 -c "import sys,json; print(json.load(sys.stdin)['dashboard']['title'])"`

Dashboard template skeleton:
```json
{
  "uid": "my-dashboard",
  "title": "My Dashboard",
  "tags": ["lesotho"],
  "timezone": "browser",
  "refresh": "30s",
  "time": { "from": "now-3h", "to": "now" },
  "schemaVersion": 38,
  "panels": [],
  "templating": {
    "list": [
      { "hide": 2, "name": "loki_ds",       "query": "loki",       "refresh": 1, "type": "datasource" },
      { "hide": 2, "name": "prometheus_ds", "query": "prometheus", "refresh": 1, "type": "datasource" }
    ]
  }
}
```

---

## Common Loki Queries

```logql
# All logs from a container
{container="bkm-mediator"}

# Filter to errors only
{container="bkm-mediator"} |= "error"

# Exclude known noise
{container="openhim-core"} |= "error" != "audits.insertOne()" != ": undefined"

# Parse structured JSON fields
{container="bkm-mediator"} | json | event="order-saved"

# Extract a numeric value for a metric panel
avg_over_time(
  {container="bkm-mediator"} |~ "QR fan-out in"
  | regexp `QR fan-out in (?P<ms>[0-9]+)ms`
  | unwrap ms [$__interval]
)

# Count events per interval (for time-series panel)
sum(rate({container="dhis2-web"} |= "Data value import done" [$__interval]))
```

## Common Prometheus Queries

```promql
# CPU cores used per container
rate(container_cpu_usage_seconds_total{name!=""}[2m])

# Memory working set
container_memory_working_set_bytes{name!=""}

# Network RX rate
rate(container_network_receive_bytes_total{name!=""}[2m])

# Top-N consumers
topk(5, container_memory_working_set_bytes{name!=""})

# PostgreSQL DB size
pg_database_size_bytes{datname!~"template.*"}
```

---

## Troubleshooting

**Grafana shows "No data" on Loki panel**
- Check the time range — widen to `Last 24h` if the container recently started.
- Verify Promtail is running: `docker compose ps promtail`
- Check Promtail can reach Docker socket: `docker logs promtail 2>&1 | tail -5`

**Prometheus shows no cAdvisor metrics**
- `curl http://localhost:9090/api/v1/targets` — check `cadvisor` target is UP.
- cAdvisor on Windows Docker Desktop may have limited filesystem metrics (rootfs mounts not available).

**Keycloak event logging stopped working after restart**
- Keycloak uses H2 in-memory — event config is lost on container restart.
- Re-run `bash scripts/seed.sh` — step 8 re-enables event logging automatically.
- Or manually: `curl -X PUT -H "Authorization: Bearer $KC_TOKEN" -H "Content-Type: application/json" http://localhost:8083/admin/realms/opensrp/events/config -d '{"eventsEnabled":true,...}'`

**Grafana dashboard not updating after JSON edit**
- Grafana polls every 30 seconds — wait up to 30s.
- If `allowUiUpdates: true` is set in the provider, you can also edit the dashboard in the UI and save it.

**Loki "context deadline exceeded" on large log volumes**
- Narrow the time range or add more specific filters to reduce scanned log lines.
- Loki is configured with local filesystem storage (`loki-data` volume) — no external dependency.
