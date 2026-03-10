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
5. [Core workflows](#5-core-workflows)
   - 5.1 [Stock dispensing fan-out](#51-stock-dispensing-fan-out)
   - 5.2 [Stock acceptance](#52-stock-acceptance)
   - 5.3 [VHW registration](#53-vhw-registration)
6. [Testing](#6-testing)
7. [Troubleshooting](#7-troubleshooting)
8. [Reference](#8-reference)

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
cd lesotho-sandbox
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

#### Regenerating analytics (required after adding data)

DHIS2 analytics tables must be regenerated before new data appears in charts:

```bash
curl -s -u admin:district -X POST \
  "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json"
```

Wait ~30 seconds, then refresh the dashboard.

#### Checking a data value directly

```bash
curl -s -u admin:district \
  "http://localhost:8081/api/dataValueSets?dataSet=none&orgUnit=dwx1Yz4BwNX&period=202603&dataElement=ujPSJuS9pph"
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

### 5.3 VHW registration

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

Runs 41 tests covering the complete fan-out workflow, stock acceptance lifecycle, and business rule enforcement (BR-03, BR-04, BR-05).

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
