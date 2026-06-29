# Lesotho Health System Sandbox — Training Manual

A practical guide for developers and technical staff working with the Lesotho national health system integration stack.

---

## Table of Contents

1. [What this sandbox is](#1-what-this-sandbox-is)
2. [Prerequisites](#2-prerequisites)
3. [Starting the stack](#3-starting-the-stack)
4. [Service-by-service guide](#4-service-by-service-guide)
   - 4.1 [OpenHIM — Interoperability Layer](#41-openhim--interoperability-layer)
   - 4.2 [DHIS2 — National Reporting](#42-dhis2--national-reporting)
   - 4.3 [OpenLMIS — Electronic Logistics](#43-openlmis--electronic-logistics)
   - 4.4 [HAPI FHIR — App Backend](#44-hapi-fhir--app-backend)
   - 4.5 [Keycloak — Identity Provider](#45-keycloak--identity-provider)
   - 4.6 [OpenSRP Web — Supervisor Dashboard](#46-opensrp-web--supervisor-dashboard)
   - 4.7 [Monitoring — Grafana + Prometheus + Loki](#47-monitoring--grafana--prometheus--loki)
5. [Core workflows](#5-core-workflows)
   - 5.1 [Stock dispensing fan-out](#51-stock-dispensing-fan-out)
   - 5.2 [Stock acceptance](#52-stock-acceptance)
   - 5.3 [VHW registration](#53-vhw-registration)
6. [Testing](#6-testing)
7. [Troubleshooting](#7-troubleshooting)
8. [Reference](#8-reference)
9. [Upstream projects & Docker images](#9-upstream-projects--docker-images)

---

## 1. What this sandbox is

A Docker Compose environment that simulates the full Lesotho national health system integration stack running locally on one machine.

```
Android BKM App (OpenSRP 2)
        │
        │  FHIR R4 (MedicationDispense / QuestionnaireResponse)
        ▼
   OpenHIM  ──── audit log, channel routing, transaction replay
        │
        │  HTTP port 3000
        ▼
 Vital-Link Mediator  (bkm-mediator / mediator/index.js)
        │
        ├──────────────────────────┐
        │                          │
        ▼                          ▼
   OpenLMIS (eLMIS)            DHIS2
   stock events API            dataValueSets API
   DEBIT / CREDIT              aggregate stock values
```

**What it is for:**
- Developing and testing the Vital-Link mediator
- Demonstrating the end-to-end data flow without needing production access
- Verifying that a `MedicationDispense` from the Android app correctly fans out to eLMIS and DHIS2

**What it is not:**
- A production environment (no TLS, no backups, volume data is ephemeral)
- A full OpenSRP Android app simulator (the app is a separate APK; the sandbox provides its backend)

---

## 2. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Docker Desktop | ≥ 4.x | With WSL 2 backend on Windows |
| Docker Compose | v2 (bundled) | `docker compose` not `docker-compose` |
| Git | any | |
| ~8 GB free RAM | — | All 15 services running simultaneously |
| ~15 GB free disk | — | Docker images + volumes |

No local Node, Java, or Python install required to run the stack (only Python is used in `seed.sh`, which runs inside Docker).

---

## 3. Starting the stack

### First time

```bash
git clone <repo-url>
cd lesotho-vitallink
make start
```

`make start` does two things:
1. `docker compose up -d` — pulls images and starts all 15 containers
2. `bash scripts/seed.sh` — seeds all services with test data (takes 3–5 min on first run)

### Subsequent starts (after `docker compose down` or machine restart)

```bash
make start
```

Seed is idempotent — safe to re-run at any time.

### Verify everything is healthy

```bash
make smoke
```

Expected output: HTTP 200 for all service endpoints.

### Reset (wipe all data)

```bash
make reset    # destroys all volumes + restarts fresh
```

### Port layout

| URL | Service |
|---|---|
| http://localhost:9000 | OpenHIM Console |
| https://localhost:8080 | OpenHIM Admin API |
| http://localhost:5001 | OpenHIM Client HTTP (mediator entry point) |
| http://localhost:8081 | DHIS2 |
| http://localhost:8082 | OpenLMIS |
| http://localhost:8083 | Keycloak |
| http://localhost:8079 | HAPI FHIR |
| http://localhost:9900 | OpenSRP backend |
| http://localhost:8025 | MailHog (email sink) |
| http://localhost:3005 | Grafana dashboards |
| http://localhost:9090 | Prometheus metrics UI |
| http://localhost:3100 | Loki log API |

---

## 4. Service-by-service guide

### 4.1 OpenHIM — Interoperability Layer

**URL:** http://localhost:9000
**Login:** `root@openhim.org` / `openhim-password`

OpenHIM sits between the Android app and all downstream services. Every FHIR message the app sends is intercepted here, logged, and forwarded to the Vital-Link mediator.

#### What to look at

- **Transactions** tab — every message the app sends appears here with full request/response bodies and fan-out results
- **Channels** tab — routes configured: `BKM MedicationDispense`, `BKM SupplyDelivery`, `BKM QuestionnaireResponse`
- **Mediators** tab — the `Vital-Link BKM` mediator heartbeat; green = mediator is registered and healthy

#### Sending a test message

```bash
curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "MedicationDispense",
    "status": "completed",
    "subject":    {"reference": "Patient/patient-001"},
    "performer":  [{"actor": {"reference": "Practitioner/opensrp-admin"}}],
    "medicationCodeableConcept": {"coding": [{"code": "AL-20-120"}]},
    "whenHandedOver": "2026-03-10T09:00:00Z",
    "quantity": {"value": 6, "unit": "tablet"}
  }'
```

Expected response:

```json
{
  "status": "Successful",
  "opensrp": "HTTP 201",
  "dhis2":   "HTTP 200",
  "openlmis":"HTTP 201"
}
```

Check the **Transactions** tab in OpenHIM console to see the full audit trail.

#### Key gotcha

OpenHIM uses port **5001** (HTTP) for the client channel — not 5000 (HTTPS). The Android app is configured to use 5001 to avoid certificate trust issues.

---

### 4.2 DHIS2 — National Reporting

**URL:** http://localhost:8081
**Login:** `admin` / `district`

DHIS2 is the national aggregate reporting system. The mediator pushes stock data here after every successful dispense or stock receipt event.

#### What is seeded

| Item | UID |
|---|---|
| Org unit — Maseru District Clinic A | `dwx1Yz4BwNX` |
| Data element — Stock Dispensed AL 20/120mg | `ujPSJuS9pph` |
| Data element — Stock Received AL 20/120mg | `StckRcvdAL1` |
| Data element — Stock on Hand AL 20/120mg | `StockOnHnd1` |
| Dashboard | `BKMDashbrd1` |

#### Viewing the dashboard

Navigate to:
http://localhost:8081/dhis-web-dashboard/index.html#/BKMDashbrd1

The dashboard contains 6 visualizations:

| Visualization | Type | Data |
|---|---|---|
| AL 20/120mg Dispensing | Column | Stock Dispensed, last 12 months |
| AL 20/120mg Stock on Hand | Line | SOH, last 12 months |
| AL 20/120mg Dispensing Pivot | Pivot table | Dispensed × months |
| AL 20/120mg Stock Received | Column | Stock Received, last 12 months |
| Dispensed vs SOH | Line | Dispensed + SOH combined |
| Full Metrics Pivot | Pivot table | Dispensed / Received / SOH × months |

#### Viewing stock data in the DHIS2 UI

After sending a dispense or receipt event, you can see the raw data values immediately (no analytics rebuild needed) and the charts after a rebuild.

**Raw data values — instant, no rebuild required:**

1. Go to **http://localhost:8081** → log in as `admin` / `district`
2. Navigate to **Data Entry** (main menu → Data Entry app)
3. Select:
   - **Organisation unit**: `Maseru District Clinic A`
   - **Data set**: *(any — data values are stored independently of data sets)*
   - **Period**: current month (e.g. `April 2026`)
4. Alternatively use **Data Quality → Data Export** to query values directly

The quickest way to confirm a value arrived:

```bash
# Check Stock Dispensed for current month
PERIOD=$(date -u +%Y%m)
curl -s -u admin:district \
  "http://localhost:8081/api/dataValueSets?orgUnit=dwx1Yz4BwNX&period=${PERIOD}&dataElement=ujPSJuS9pph"
```

Expected response after a dispense event:

```json
{
  "dataValues": [
    {
      "dataElement": "ujPSJuS9pph",
      "period": "202604",
      "orgUnit": "dwx1Yz4BwNX",
      "value": "6",
      "storedBy": "admin"
    }
  ]
}
```

**Dashboard charts — requires analytics rebuild:**

Charts (bar, line, pivot) read from pre-aggregated analytics tables, not raw data values. After any new data arrives, trigger a rebuild:

```bash
curl -s -u admin:district -X POST \
  "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json"
```

Wait ~30 seconds, then refresh the dashboard. The seed schedules a nightly rebuild at 02:30 — during a demo, trigger it manually after each test run.

**What each data element represents in the UI:**

| Data element | UID | Updated by | When |
|---|---|---|---|
| Stock Dispensed AL 20/120mg | `ujPSJuS9pph` | mediator (direct) | Synchronously after each dispense |
| Stock Received AL 20/120mg | `StckRcvdAL1` | mediator (direct) | Synchronously after each receipt / order dispatch |
| Stock on Hand AL 20/120mg | `StockOnHnd1` | mediator (direct, from OpenLMIS SOH) | Synchronously after each stock event |

#### Configuring the DHIS2 push mode

The mediator supports two modes, controlled by the `DHIS2_PUSH_MODE` environment variable in `docker-compose.yml`:

| Mode | `DHIS2_PUSH_MODE` value | Behaviour |
|---|---|---|
| **Direct** (default) | `direct` | Mediator posts `dataValueSets` to DHIS2 immediately after each dispense or receipt. Stock on Hand is also pushed by querying the authoritative SOH from OpenLMIS. Data appears in DHIS2 within the same HTTP request. |
| **Delegation** | `delegation` | Mediator delegates to the `dhis2-integration` service (openlmis-ref-distro). That service reads from OpenLMIS on its own schedule and pushes to DHIS2. **Not recommended for this sandbox** — `dhis2-integration` uses `flyway.clean=true`, which wipes its configuration tables (`dhis2.data_elements`, `dhis2.datasets`) on every container restart, requiring a re-seed. |

To switch modes, edit `docker-compose.yml` under the `bkm-mediator` service:

```yaml
environment:
  - DHIS2_PUSH_MODE=direct      # or: delegation
```

Then rebuild and restart the mediator:

```bash
docker compose build bkm-mediator
docker compose up -d bkm-mediator
```

> **Why `flyway.clean=true` causes the delegation problem:** The `dhis2-integration` Spring Boot service (part of openlmis-ref-distro) is configured for a dev/test workflow where the database schema can change freely between versions. On every container restart Flyway drops and recreates the entire `dhis2` schema, erasing any data element mappings that were inserted. The `scripts/seed.sh` step 12 re-inserts these mappings after each seed run, so delegation mode will work until the next `dhis2-integration` container restart.

#### Checking a data value directly

```bash
PERIOD=$(date -u +%Y%m)
curl -s -u admin:district \
  "http://localhost:8081/api/dataValueSets?orgUnit=dwx1Yz4BwNX&period=${PERIOD}&dataElement=ujPSJuS9pph"
```

---

### 4.3 OpenLMIS — Electronic Logistics

**URL:** http://localhost:8082
**Login:** `admin` / `password`

OpenLMIS is the eLMIS (electronic Logistics Management Information System). It tracks stock movements at facility level — receipts (CREDIT) and dispenses (DEBIT).

#### What is seeded

| Item | ID |
|---|---|
| Facility — Maseru District Clinic A | `28de536f-b826-4eeb-a3c4-d65221a1120d` |
| Program — Essential Medicines | `31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c` |
| Orderable — AL 20/120mg | `3be1d20f-6aa9-4e52-864f-4fa04aa02056` |
| Reason — Consumed (dispense) | `b5c27da7-bdda-4790-925a-9484c5dfb594` |
| Reason — Receipts | `313f2f5f-0c22-4626-8c49-3554ef763de3` |
| Initial stock (10,000 tablets) | seeded at first run |

#### Logging in to the SPA

1. Go to http://localhost:8082
2. Enter `admin` / `password` and click **Login** — type credentials manually (browser autofill bypasses AngularJS form bindings and shows "This field is required")
3. Navigate to **Stock Management → Stock on Hand**
4. Filter by program **Essential Medicines** and facility **Maseru District Clinic A**

#### Checking stock via API

```bash
TOKEN=$(curl -s -X POST \
  "http://localhost:8082/api/oauth/token?grant_type=password&username=admin&password=password" \
  -H "Authorization: Basic dXNlci1jbGllbnQ6Y2hhbmdlbWU=" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8082/api/stockCardSummaries?\
facility=28de536f-b826-4eeb-a3c4-d65221a1120d\
&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c\
&orderable=3be1d20f-6aa9-4e52-864f-4fa04aa02056" \
  | python3 -m json.tool
```

#### Viewing the stock card in the UI

The stock card shows every movement for a specific product at a facility in chronological order — the primary view for demo and verification.

1. Go to **http://localhost:80** → log in as `administrator` / `password`
2. Navigate to **Stock Management → Stock on Hand**
3. Select **Facility**: `Maseru District Clinic A`, **Program**: `Essential Medicines` → click **View**
4. Click the **AL 20/120mg** row to open its stock card

The card looks like this (most recent events at the top):

| Date | Reason | Adjustment | Stock on Hand | Performed by |
|---|---|---|---|---|
| 21/04/2026 | Receipts | +180 | 10,307 | administrator |
| 21/04/2026 | Consumed | −2 | 10,127 | administrator |
| 21/04/2026 | Receipts | +20 | 10,129 | administrator |
| … | … | … | … | … |
| 21/04/2026 | Stock Requested | −50 | 9,968 | administrator |
| … | … | … | … | … |
| (seed) | Receipts | +10,000 | 10,000 | administrator |

**What each reason means:**

| Reason | Direction | Triggered by |
|---|---|---|
| **Receipts** | CREDIT (+) | Stock acceptance by VHW, or order dispatch from warehouse |
| **Consumed** | DEBIT (−) | MedicationDispense / dispense QuestionnaireResponse |
| **Stock Requested** | DEBIT (−) | *(legacy — now fixed to use Receipts for order dispatch)* |

> **Note:** If you see a `Stock Requested` DEBIT entry, that is from an earlier test run before the dispatch reason was corrected to CREDIT. Run `make reset` for a clean card before a demo.

**Verify a specific event via API:**

```bash
export PATH="/usr/bin:/bin:/c/Users/Neels.Lotter/AppData/Local/Programs/Python/Python313:$PATH"
TOKEN=$(curl -sf -u user-client:changeme \
  -d "grant_type=password&username=administrator&password=password" \
  http://localhost:80/api/oauth/token \
  | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -sf -H "Authorization: Bearer $TOKEN" \
  "http://localhost:80/api/stockCardSummaries?\
facility=28de536f-b826-4eeb-a3c4-d65221a1120d\
&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c\
&orderable=3be1d20f-6aa9-4e52-864f-4fa04aa02056" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('SOH:', sum(c['stockOnHand'] for c in d.get('content',[])))"
```

#### Key gotchas

- **Type credentials manually** in the SPA — browser autofill does not trigger AngularJS `ng-model` bindings
- **OpenLMIS referencedata wipes on restart** — `flyway.clean=true` is set; seed.sh re-seeds after every restart automatically
- **Stock events require a user token** — service account (`trusted-client`) has no `userId`, causing a DB constraint violation; seed.sh obtains a user token with `grant_type=password`

---

### 4.4 HAPI FHIR — App Backend

**URL:** http://localhost:8079/fhir
**No authentication required** (internal sandbox)

HAPI FHIR is the backend for the OpenSRP Android app. It stores:

- App configuration (Binary resources, Composition, ImplementationGuide)
- Patient records and household Groups
- Practitioner and PractitionerRole resources
- Questionnaires (forms used in the app)
- Task resources (stock acceptance workflow)

#### Browsing resources

```bash
# List all patients
curl -s http://localhost:8079/fhir/Patient | python3 -m json.tool | head -40

# Fetch a specific task
curl -s http://localhost:8079/fhir/Task/task-pending-001 | python3 -m json.tool

# List pending stock acceptance tasks
curl -s "http://localhost:8079/fhir/Task?status=requested&code=373748001" | python3 -m json.tool
```

#### Seeded resources

| Resource | Count | Notes |
|---|---|---|
| Organization | 1 | Maseru District Clinic A |
| Location | 6 | Country → District → Clinic → 3 catchment villages |
| Practitioner | 4 | opensrp-admin + 3 VHWs |
| PractitionerRole | 4 | Role per practitioner |
| Patient | 10 | patient-001 through patient-010 |
| Group | 3 | By catchment village |
| CareTeam | 1 | Maseru North VHW Team |
| Task | 2 | Pending stock acceptance tasks |
| Questionnaire | 7 | Dispense, stock count, stock accept, etc. |
| Binary | 23 | App config resources |

---

### 4.5 Keycloak — Identity Provider

**URL:** http://localhost:8083
**Admin login:** `admin` / `admin` (master realm)
**OpenSRP realm user:** `opensrp-admin` / `admin`

Keycloak handles authentication for the OpenSRP Android app and the OpenSRP web dashboard.

#### Realm structure

- **Master realm** — Keycloak admin only
- **opensrp realm** — All OpenSRP users and app clients

#### Key clients

| Client | Used by |
|---|---|
| `opensrp-web-client` | OpenSRP web dashboard (SPA) |
| `opensrp-android` | Android app token requests |

#### Checking the admin user's Keycloak UUID

The Keycloak UUID links the Keycloak account to the FHIR Practitioner resource. After every container recreate this UUID changes:

```bash
# Get opensrp-admin Keycloak UUID
curl -s "http://localhost:8083/auth/admin/realms/opensrp/users?username=opensrp-admin" \
  -H "Authorization: Bearer $(curl -s -X POST \
    'http://localhost:8083/auth/realms/master/protocol/openid-connect/token' \
    -d 'grant_type=password&client_id=admin-cli&username=admin&password=admin' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])"
```

#### Gotcha — H2 in-memory DB

Keycloak `start-dev` uses H2 in-memory storage by default. Roles and users added via the Admin UI are lost on container restart. The `opensrp-realm.json` config file is imported at startup to persist the realm configuration. Do not modify users via the Admin UI without also updating the JSON file.

---

### 4.6 OpenSRP Web — Supervisor Dashboard

**URL:** http://localhost:9901
**Login:** Keycloak — `opensrp-admin` / `admin`

The OpenSRP web dashboard shows patient lists, household registers, and team management for supervisors.

#### Gotchas

- The **backend is HAPI FHIR** (port 8079) — not opensrp-server (port 9900). All data shown is from HAPI FHIR
- **opensrp-server (port 9900) write operations require Redis** — no Redis is in the stack, so writes return 500; reads work fine
- **Role format matters** — Keycloak roles must be `MANAGE_{Resource}` or `GET_{Resource}` format; the realm JSON includes all 21 FHIR resource roles

---

### 4.7 Monitoring — Grafana + Prometheus + Loki

**Grafana URL:** http://localhost:3005
**Login:** `admin` / `admin123`

The monitoring stack provides full observability across all services — log aggregation (Loki + Promtail), container metrics (Prometheus + cAdvisor), and dashboards (Grafana).

#### Available dashboards

| Dashboard | URL | What it shows |
|---|---|---|
| BKM Mediator Logs | http://localhost:3005/d/bkm-mediator-logs | Fan-out latency, event types, BR-04 violations, stock rejections, order/dispatch log |
| OpenLMIS | http://localhost:3005/d/openlmis-overview | Nginx HTTP traffic, stock events, auth token operations, service error rates |
| FHIR (HAPI + OpenSRP) | http://localhost:3005/d/fhir-overview | FHIR request rates by resource/operation, Android sync activity, OpenSRP errors |
| OpenHIM Errors | http://localhost:3005/d/openhim-errors | Real errors vs ATNA audit noise, transaction failures, auth failures, DNS errors |
| Keycloak Auth | http://localhost:3005/d/keycloak-auth | Login errors, brute-force attempts, error type breakdown |
| DHIS2 | http://localhost:3005/d/dhis2-overview | Auth events, data value writes, analytics errors, scheduled jobs |
| Infrastructure | http://localhost:3005/d/docker-infra | Container CPU/memory/network/disk, PostgreSQL sizes and locks |

#### Watching logs live

The mediator dashboard is the best place to start when tracing a dispense event — it shows the fan-out latency and whether each downstream system succeeded or failed.

For a quick sanity check, the **Infrastructure** dashboard shows memory consumption per container. At rest the stack uses ~11 GB total RAM; if a container is OOM-killed it appears as a spike in the OOM failure panel.

#### Querying logs directly (Prometheus/Loki UIs)

```bash
# Open Loki log explorer (via Grafana Explore)
# Grafana → Explore → datasource: Loki
# LogQL example — last 100 mediator errors:
{container="bkm-mediator"} |= "error"

# Prometheus query UI
http://localhost:9090
# PromQL example — top memory consumers:
topk(5, container_memory_working_set_bytes{name!=""})
```

#### Keycloak event logging

Keycloak's event logging is enabled via `seed.sh` (step 8). Because Keycloak uses an in-memory H2 database, the event config is lost on container restart. Re-run `bash scripts/seed.sh` after any Keycloak container recreate to restore it.

Only `LOGIN_ERROR` and `CLIENT_LOGIN_ERROR` events appear in Loki (logged at WARN level). Successful `LOGIN` events are stored in Keycloak's internal H2 DB and visible at:
http://localhost:8083/admin/master/console/#/opensrp/events

#### Gotchas

- **"No data" on a Loki panel** — widen the time range to `Last 24h`; the container may have only recently started
- **cAdvisor filesystem metrics missing** — expected on Windows Docker Desktop; rootfs mounts are not available to cAdvisor; CPU/memory/network still work
- **DHIS2 analytics error `uidlevel4 does not exist`** — known issue; village org units were added after the last analytics table build. Fix: `curl -X POST -u admin:district http://localhost:8081/api/resourceTables/analytics`

See [monitoring.md](monitoring.md) for a full reference: dashboard sections, Loki/PromQL queries, and troubleshooting.

---

## 5. Core workflows

### 5.1 Stock dispensing fan-out

**Trigger:** CHW dispenses malaria treatment to a patient → app creates `MedicationDispense` → syncs to OpenHIM

**What the mediator does:**

```
POST /fhir/MedicationDispense
        │
        ├── POST OpenLMIS stockEvent (DEBIT / Consumed)
        │         program: Essential Medicines
        │         facility: Maseru District Clinic A
        │         orderable: AL 20/120mg
        │         quantity: <from dispense>
        │
        └── POST DHIS2 dataValueSet
                  dataElement: ujPSJuS9pph (Stock Dispensed)
                  value: <quantity>
                  period: <YYYYMM>
                  orgUnit: dwx1Yz4BwNX
```

After a successful eLMIS event, the mediator also pushes updated Stock-on-Hand to DHIS2:

```
GET  OpenLMIS /api/stockCardSummaries → current SOH
POST DHIS2 /api/dataValueSets → dataElement StockOnHnd1
```

**Test it:**

```bash
curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "MedicationDispense",
    "status": "completed",
    "subject":   {"reference": "Patient/patient-001"},
    "performer": [{"actor": {"reference": "Practitioner/opensrp-admin"}}],
    "medicationCodeableConcept": {"coding": [{"code": "AL-20-120"}]},
    "whenHandedOver": "2026-03-10T09:00:00Z",
    "quantity": {"value": 6, "unit": "tablet"}
  }'
```

**Verify in OpenLMIS:**

```bash
# Check stock events (most recent first)
docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement \
  -c "SELECT createdat, quantity, sourcefreetext FROM stockmanagement.stock_events ORDER BY createdat DESC LIMIT 5;"
```

**Verify in DHIS2:**

```bash
curl -s -u admin:district \
  "http://localhost:8081/api/dataValueSets?orgUnit=dwx1Yz4BwNX&period=202603&dataElement=ujPSJuS9pph"
```

---

### 5.2 Stock acceptance

This workflow models a facility issuing stock to a CHW. The CHW receives a `Task` in the app and accepts it by filling a form.

**Full lifecycle:**

```
1. Facility staff triggers SupplyDelivery
   POST http://localhost:5001/fhir/SupplyDelivery
   → mediator creates Task (status=requested) on HAPI FHIR

2. CHW opens app → syncs → sees Task in stock acceptance register

3. CHW taps Accept → fills qn-stock-accept questionnaire
   → app POSTs QuestionnaireResponse to OpenHIM

4. Mediator receives QuestionnaireResponse:
   BR-04: check Task.status == requested (reject if already accepted)
   → POST OpenLMIS stockEvent (CREDIT / Receipts)
   → pushSohToDHIS2 (Stock on Hand updated)
   → PUT HAPI FHIR Task/{id} status=completed
```

**Step 1 — create a pending task:**

```bash
curl -s -X POST http://localhost:5001/fhir/SupplyDelivery \
  -H 'Content-Type: application/json' \
  -d '{
    "performer":  "opensrp-admin",
    "medication": "AL-20-120",
    "quantity":   120,
    "issueRef":   "LMIS-2026-TEST"
  }'
```

**Step 2 — verify task exists on HAPI FHIR:**

```bash
curl -s "http://localhost:8079/fhir/Task?status=requested&code=373748001" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);[print(e['resource']['id'],e['resource']['status'],e['resource']['description']) for e in d.get('entry',[])]"
```

**Step 3 — simulate acceptance (QuestionnaireResponse):**

```bash
# Replace TASK_ID with the ID returned from Step 1
TASK_ID="task-pending-001"
curl -s -X POST http://localhost:5001/fhir/QuestionnaireResponse \
  -H 'Content-Type: application/fhir+json' \
  -d "{
    \"resourceType\": \"QuestionnaireResponse\",
    \"status\": \"completed\",
    \"questionnaire\": \"Questionnaire/qn-stock-accept\",
    \"subject\": {\"reference\": \"Practitioner/opensrp-admin\"},
    \"basedOn\": [{\"reference\": \"Task/${TASK_ID}\"}],
    \"item\": [
      {\"linkId\": \"task_id\",      \"answer\": [{\"valueString\": \"${TASK_ID}\"}]},
      {\"linkId\": \"product_code\", \"answer\": [{\"valueString\": \"AL-20-120\"}]},
      {\"linkId\": \"quantity\",     \"answer\": [{\"valueInteger\": 120}]},
      {\"linkId\": \"lot_number\",   \"answer\": [{\"valueString\": \"AL-LOT-2026\"}]},
      {\"linkId\": \"accepted_date\",\"answer\": [{\"valueDate\": \"2026-03-10\"}]}
    ]
  }"
```

**Step 4 — confirm Task is now completed:**

```bash
curl -s "http://localhost:8079/fhir/Task/${TASK_ID}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'])"
# Expected: completed
```

---

### 5.3 VHW stock orders (batch dispatch)

VHWs submit stock order requests from the app. The mediator accumulates orders in DHIS2 (per-village running totals) and dispatches a single consolidated order to OpenLMIS every Monday at 06:00.

**Submit a stock order (as VHW Thabo Mokoena):**

```bash
curl -s -X POST http://localhost:5001/fhir/QuestionnaireResponse \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "QuestionnaireResponse",
    "author": {"reference": "Practitioner/prac-thabo-mokoena"},
    "item": [
      {"linkId": "type",            "answer": [{"valueCoding": {"code": "ORDER"}}]},
      {"linkId": "medication",      "answer": [{"valueCoding": {"code": "AL-20-120"}}]},
      {"linkId": "quantity_ordered","answer": [{"valueInteger": 60}]}
    ]
  }'
```

Response includes current SOH and the running monthly total:

```json
{
  "status": "Queued",
  "type": "order",
  "medicineCode": "AL-20-120",
  "quantityOrdered": 60,
  "totalOrderedThisPeriod": 60,
  "stockOnHand": 29943,
  "message": "Order saved to DHIS2 — dispatched in next batch"
}
```

**Check pending orders (DHIS2 buffer):**

```bash
docker exec bkm-mediator wget -qO- http://localhost:3000/aggregate/orders
```

**Trigger immediate dispatch (instead of waiting for Monday):**

```bash
docker exec bkm-mediator wget -qO- --post-data='{}' \
  --header='Content-Type: application/json' http://localhost:3000/aggregate/orders
```

**View order status dashboard:**
- **BKMOrdDsh01** — live DISPATCHED/PENDING status, updated automatically: http://localhost:8081/dhis-web-dashboard/index.html#/BKMOrdDsh01
- **BKMVhwMap01** — bubble map showing ordered quantities per VHW village: http://localhost:8081/dhis-web-dashboard/index.html#/BKMVhwMap01
- **BKMOrdInfo1** — static explanation of the full workflow: http://localhost:8081/dhis-web-dashboard/index.html#/BKMOrdInfo1

**How village routing works:**

Orders are stored at the VHW's village org unit in DHIS2 (not the facility), enabling the village map visualization:

| VHW | Village Org Unit |
|-----|-----------------|
| `Practitioner/prac-thabo-mokoena` | `VilHaMokoe1` (Ha Mokoena) |
| `Practitioner/prac-lineo-nthabi` | `VilHaSehl01` (Ha Sehlabane) |
| `Practitioner/prac-mpho-lerotholi` | `VilMatsien1` (Matsieng) |

The `dhis2_org_unit` column in `mappings.csv` controls this routing. See [OpenHIM Mappings](./openhim-mappings.md) for details.

---

### 5.5 VHW registration

VHW (Village Health Worker) registration creates a set of linked FHIR resources:

| Resource | Purpose |
|---|---|
| `Practitioner` | VHW identity (name, phone, staff ID) |
| `PractitionerRole` | Links VHW to facility + location + role |
| `Organization` | Health facility (pre-seeded) |
| `Location` | Geographic catchment area |
| `Group` | Set of households assigned to this VHW |

**View seeded VHWs:**

```bash
curl -s http://localhost:8079/fhir/Practitioner | python3 -m json.tool | grep '"id"' | head -10
```

**Create a new VHW:**

```bash
curl -s -X PUT http://localhost:8079/fhir/Practitioner/vhw-new-001 \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "Practitioner",
    "id": "vhw-new-001",
    "active": true,
    "name": [{"family": "Nthabi", "given": ["Lineo"]}],
    "telecom": [{"system": "phone", "value": "+26650999888", "use": "mobile"}],
    "identifier": [
      {"system": "http://lesotho.gov.ls/staff-id", "value": "VHW-00124"}
    ]
  }'
```

Then link to a location and facility with a `PractitionerRole`.

---

## 6. Testing

### Unit tests (mediator logic only)

```bash
make test
# or without make:
docker exec bkm-mediator node_modules/.bin/jest --verbose
```

Runs 10 Jest tests covering all mediator routes. No running services needed.

### Smoke tests (all services)

```bash
make smoke
```

Checks that every service returns HTTP 200 on its health/root endpoint.

### Full end-to-end test

```bash
bash scripts/e2e-test.sh
```

Runs 61 tests covering the complete fan-out workflow, stock acceptance lifecycle, business rule enforcement (BR-03, BR-04, BR-05), and the full VHW stock order cycle (order → DHIS2 buffer → dispatch → OpenLMIS receipt → FHIR Task).

### Manual fan-out test

```bash
curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "MedicationDispense",
    "status": "completed",
    "subject":   {"reference": "Patient/patient-001"},
    "performer": [{"actor": {"reference": "Practitioner/opensrp-admin"}}],
    "medicationCodeableConcept": {"coding": [{"code": "AL-20-120"}]},
    "whenHandedOver": "2026-03-10T09:00:00Z",
    "quantity": {"value": 6, "unit": "tablet"}
  }'
```

Expected: `{"status":"Successful","opensrp":"HTTP 201","dhis2":"HTTP 200","openlmis":"HTTP 201"}`

---

## 7. Troubleshooting

### Stack won't start / seed fails

```bash
make reset    # nuke volumes and start fresh
make start
```

### OpenLMIS shows "Internal application error" on page load

The nginx stubs may have been overwritten by consul-template. Re-run:

```bash
bash scripts/seed.sh
```

Seed is idempotent — safe to run at any time.

### OpenLMIS login shows "This field is required"

Browser autofill fills fields visually but does not trigger AngularJS `ng-model`. **Type credentials manually** — click the username field, clear it, type `admin`, then do the same for the password field.

### MedicationDispense returns HTTP 500

Check the mediator logs:

```bash
docker logs bkm-mediator --tail=50
```

Common causes:
- OpenLMIS not ready yet (wait 30s after `make start` and retry)
- Stock underflow (SOH would go negative) — the initial 10,000 tablet seed should prevent this; check OpenLMIS stock level

### DHIS2 data not showing in charts

Analytics tables need regeneration after new data:

```bash
curl -s -u admin:district -X POST \
  "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json"
```

Wait ~30 seconds, then refresh the dashboard.

### Keycloak UUID mismatch (OpenSRP 403 after container recreate)

After recreating the Keycloak container, `opensrp-admin` gets a new UUID. Update the FHIR Practitioner and OpenSRP DB:

```bash
# Get new UUID
NEW_UUID=$(curl -s "http://localhost:8083/auth/admin/realms/opensrp/users?username=opensrp-admin" \
  -H "Authorization: Bearer ..." | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")

# Update OpenSRP practitioner table
docker exec health-db-postgres psql -U admin -d opensrp \
  -c "UPDATE team.practitioner SET user_id='${NEW_UUID}' WHERE identifier='opensrp-admin';"
```

### View mediator logs

```bash
docker logs bkm-mediator -f
```

### View all container logs together

```bash
docker compose logs -f --tail=20
```

### Grafana shows "No data" on a panel

1. Widen the time range to **Last 24h** — the container may have started recently and logs haven't accumulated
2. Verify Promtail is running: `docker compose ps promtail`
3. Check Promtail can reach the Docker socket: `docker logs promtail 2>&1 | tail -5`

### Prometheus shows no cAdvisor metrics

```bash
curl http://localhost:9090/api/v1/targets | python3 -m json.tool | grep -A5 cadvisor
```

On Windows Docker Desktop, filesystem (rootfs) metrics are limited — CPU/memory/network still work correctly.

---

## 8. Reference

### Credentials quick reference

| Service | URL | Username | Password |
|---|---|---|---|
| OpenHIM Console | http://localhost:9000 | root@openhim.org | openhim-password |
| DHIS2 | http://localhost:8081 | admin | district |
| OpenLMIS | http://localhost:8082 | admin | password |
| Keycloak admin | http://localhost:8083 | admin | admin |
| Keycloak opensrp | http://localhost:8083/auth/realms/opensrp | opensrp-admin | admin |
| PostgreSQL | localhost:5432 | admin | password123 |
| Grafana | http://localhost:3005 | admin | admin123 |

### Stable seeded IDs

| Item | System | ID |
|---|---|---|
| Maseru District Clinic A | OpenLMIS facility | `28de536f-b826-4eeb-a3c4-d65221a1120d` |
| Essential Medicines | OpenLMIS program | `31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c` |
| AL 20/120mg | OpenLMIS orderable | `3be1d20f-6aa9-4e52-864f-4fa04aa02056` |
| Maseru District Clinic A | DHIS2 org unit | `dwx1Yz4BwNX` |
| Stock Dispensed | DHIS2 data element | `ujPSJuS9pph` |
| Stock Received | DHIS2 data element | `StckRcvdAL1` |
| Stock on Hand | DHIS2 data element | `StockOnHnd1` |
| BKM Dashboard | DHIS2 | `BKMDashbrd1` |
| opensrp-admin | HAPI FHIR Practitioner | `opensrp-admin` |

### `make` commands

| Command | What it does |
|---|---|
| `make start` | `docker compose up -d` + `bash scripts/seed.sh` |
| `make test` | Jest unit tests (no Docker needed) |
| `make smoke` | HTTP 200 checks on all service endpoints |
| `make reset` | Destroy all volumes and restart fresh |

### Further reading

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System overview, services, data flow |
| [vhw-fhir-data-model.md](vhw-fhir-data-model.md) | FHIR resources for VHW registration |
| [openlmis-stock-management.md](openlmis-stock-management.md) | OpenLMIS stock cards via UI and API |
| [fhir-binary-upload.md](fhir-binary-upload.md) | Uploading Binary config to HAPI FHIR |
| [dhis2-visualizations.md](dhis2-visualizations.md) | DHIS2 visualizations — UIDs, gotchas |
| [aggregation.md](aggregation.md) | SOH aggregation and DHIS2 data push |
| [fhir-tasks.md](fhir-tasks.md) | FHIR Task lifecycle (stock acceptance) |
| [srs-coverage.md](srs-coverage.md) | All 52 requirements mapped to sandbox status |
| [monitoring.md](monitoring.md) | Grafana + Prometheus + Loki — all 7 dashboards, Loki/PromQL cheat sheet, troubleshooting |

---

## 9. Upstream projects & Docker images

The sandbox is assembled from open-source projects. The table below lists each service, its Docker image as used in [docker-compose.yml](../docker-compose.yml), and links to the upstream project and documentation.

### Interoperability

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **OpenHIM Core** | `jembi/openhim-core:latest` | [openhim-core on GitHub](https://github.com/jembi/openhim-core-js) | [OpenHIM Docs](http://openhim.org/docs/) |
| **OpenHIM Console** | `jembi/openhim-console:latest` | [openhim-console on GitHub](https://github.com/jembi/openhim-console) | [OpenHIM Docs](http://openhim.org/docs/) |

### Logistics (eLMIS)

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **OpenLMIS nginx** | `openlmis/nginx:latest` | [openlmis-nginx on GitHub](https://github.com/OpenLMIS/openlmis-nginx) | [OpenLMIS Dev Docs](https://docs.openlmis.org/) |
| **OpenLMIS Reference UI** | `openlmis/reference-ui:5.2.13` | [openlmis-reference-ui on GitHub](https://github.com/OpenLMIS/openlmis-reference-ui) | [UI Extension Guide](https://docs.openlmis.org/en/latest/components/uiExtensionGuide.html) |
| **OpenLMIS Auth** | `openlmis/auth:latest` | [openlmis-auth on GitHub](https://github.com/OpenLMIS/openlmis-auth) | [Auth Service API](https://raw.githubusercontent.com/OpenLMIS/openlmis-auth/master/src/main/resources/api-definition.yaml) |
| **OpenLMIS Referencedata** | `openlmis/referencedata:latest` | [openlmis-referencedata on GitHub](https://github.com/OpenLMIS/openlmis-referencedata) | [Referencedata API](https://raw.githubusercontent.com/OpenLMIS/openlmis-referencedata/master/src/main/resources/api-definition.yaml) |
| **OpenLMIS Stockmanagement** | `openlmis/stockmanagement:latest` | [openlmis-stockmanagement on GitHub](https://github.com/OpenLMIS/openlmis-stockmanagement) | [Stock API](https://raw.githubusercontent.com/OpenLMIS/openlmis-stockmanagement/master/src/main/resources/api-definition.yaml) |
| **OpenLMIS Requisition** | `openlmis/requisition:latest` | [openlmis-requisition on GitHub](https://github.com/OpenLMIS/openlmis-requisition) | — |
| **OpenLMIS Notification** | `openlmis/notification:latest` | [openlmis-notification on GitHub](https://github.com/OpenLMIS/openlmis-notification) | — |

> **nginx note:** OpenLMIS nginx uses [consul-template](https://github.com/hashicorp/consul-template) to render its config at runtime from Consul KV. The template lives at `/etc/consul-template/openlmis.conf` inside the container. Direct edits to `/etc/nginx/conf.d/default.conf` are overwritten on the next Consul data change — always patch both files (see `seed.sh` step 3).

### Identity & Access

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **Keycloak** | `quay.io/keycloak/keycloak:23.0` | [Keycloak on GitHub](https://github.com/keycloak/keycloak) | [Keycloak Docs](https://www.keycloak.org/documentation) · [Admin REST API](https://www.keycloak.org/docs-api/23.0/rest-api/) |

> **Keycloak note:** This sandbox runs `start-dev` which uses an in-memory H2 database. All realm configuration (roles, clients, users) is persisted in [config/keycloak/opensrp-realm.json](../config/keycloak/opensrp-realm.json) and imported at container startup. Keycloak will not re-import if the realm already exists — delete the container to force a re-import.

### FHIR & OpenSRP

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **HAPI FHIR** | `hapiproject/hapi:v7.2.0` | [hapi-fhir-jpaserver-starter on GitHub](https://github.com/hapifhir/hapi-fhir-jpaserver-starter) | [HAPI FHIR Docs](https://hapifhir.io/hapi-fhir/docs/) · [Docker Hub](https://hub.docker.com/r/hapiproject/hapi) |
| **OpenSRP Server** | `opensrp/opensrp-server-web:latest` | [opensrp-server-web on GitHub](https://github.com/OpenSRP/opensrp-server-web) | [OpenSRP Docs](https://smartregister.atlassian.net/wiki/spaces/Documentation/) |
| **OpenSRP Web** | `opensrp/web:latest` | [web on GitHub](https://github.com/OpenSRP/web) | [OpenSRP Web Docs](https://github.com/OpenSRP/web/wiki) |

### Reporting

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **DHIS2** | `dhis2/core:2.40` | [dhis2-core on GitHub](https://github.com/dhis2/dhis2-core) | [DHIS2 Developer Docs](https://docs.dhis2.org/en/develop/using-the-api/dhis-core-version-240/) · [Docker Hub](https://hub.docker.com/r/dhis2/core) |

### Infrastructure

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **PostgreSQL + PostGIS** | `postgis/postgis:14-3.2` | [postgis/docker-postgis on GitHub](https://github.com/postgis/docker-postgis) | [PostGIS Docs](https://postgis.net/documentation/) |
| **MongoDB** | `mongo:4.4` | [Official MongoDB image](https://hub.docker.com/_/mongo) | [MongoDB Docs](https://www.mongodb.com/docs/) |
| **RabbitMQ** | `rabbitmq:3.8-management` | [Official RabbitMQ image](https://hub.docker.com/_/rabbitmq) | [RabbitMQ Docs](https://www.rabbitmq.com/documentation.html) |
| **Consul** | `hashicorp/consul:1.9` | [consul on GitHub](https://github.com/hashicorp/consul) | [Consul Docs](https://developer.hashicorp.com/consul/docs) |
| **MailHog** | `mailhog/mailhog:latest` | [MailHog on GitHub](https://github.com/mailhog/MailHog) | SMTP sink — web UI at http://localhost:8025 |

### Monitoring & Observability

| Service | Docker image | Project | Docs / Source |
|---|---|---|---|
| **Grafana** | `grafana/grafana:latest` | [grafana on GitHub](https://github.com/grafana/grafana) | [Grafana Docs](https://grafana.com/docs/grafana/latest/) — dashboard UI at http://localhost:3005 |
| **Prometheus** | `prom/prometheus:latest` | [prometheus on GitHub](https://github.com/prometheus/prometheus) | [Prometheus Docs](https://prometheus.io/docs/) — metrics at http://localhost:9090 |
| **Loki** | `grafana/loki:latest` | [loki on GitHub](https://github.com/grafana/loki) | [Loki Docs](https://grafana.com/docs/loki/latest/) — log API at http://localhost:3100 |
| **Promtail** | `grafana/promtail:latest` | [promtail on GitHub](https://github.com/grafana/loki/tree/main/clients/pkg/promtail) | Log shipper — scrapes container stdout/stderr via Docker socket |
| **cAdvisor** | `gcr.io/cadvisor/cadvisor:latest` | [cadvisor on GitHub](https://github.com/google/cadvisor) | Container CPU/memory/network/disk metrics exporter |
| **postgres-exporter** | `prometheuscommunity/postgres-exporter:latest` | [postgres_exporter on GitHub](https://github.com/prometheus-community/postgres_exporter) | PostgreSQL metrics exporter (DB sizes, locks, `pg_up`) |
