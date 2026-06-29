# Aggregation — BKM to DHIS2 and OpenLMIS

Explains what "aggregation" means in the BKM–eLMIS integration, how it works today, and the two complementary aggregation mechanisms now in place.

---

## What "aggregation" means here

Individual community-level stock events (dispenses and receipts) are captured in BKM (Android) and forwarded to OpenLMIS as DEBIT/CREDIT `stockEvents`. These are fine-grained, per-transaction records.

**Aggregation** is the step that rolls these up into summary values per facility / product / month and writes them to DHIS2 for national-level reporting and requisition planning.

Two aggregation mechanisms are in place:

| Mechanism | Trigger | Writes to | Purpose |
|---|---|---|---|
| **dhis2-integration sync** | On demand (Sync Now) or scheduled | DHIS2 `ALStockDE01` × category option combos | Standard OpenLMIS→DHIS2 indicator sync |
| **Facility aggregation** (`POST /aggregate`, cron) | Daily at 1am (or on demand) | OpenLMIS stock events | Consolidated DEBIT per facility per medicine |

---

## Mechanism 1 — dhis2-integration service sync

The mediator no longer pushes to DHIS2 directly. Instead, the official `openlmis/dhis2-integration:1.2.0-SNAPSHOT` service reads OpenLMIS and pushes to DHIS2 using the standard 3-indicator pattern.

### Trigger

| Method | How |
|--------|-----|
| Manual | Click **Sync Now** on bkm-web Services page |
| API | `POST /mediator-api/dhis2/sync` (proxied via bkm-mediator → dhis2-integration `POST /api/execute`) |
| Automatic | dhis2-integration can be configured with a schedule in the OpenLMIS admin UI |

### Data flow

```
POST /mediator-api/dhis2/sync
  └─▶ bkm-mediator /dhis2/sync route
        └─▶ POST dhis2-integration:8080/api/execute
              └─▶ GET OpenLMIS /api/stockCardSummaries  (per facility / program / orderable)
                    └─▶ POST DHIS2 /api/dataValueSets
                          ?orgUnitIdScheme=code
                          &dataElementIdScheme=name
                          &categoryOptionComboIdScheme=name
                          {
                            dataSet:  "BKMDs2Sync1",
                            period:   "202603",
                            orgUnit:  "MDA",           ← org unit code
                            dataValues: [
                              { dataElement: "AL 20/120mg", categoryOptionCombo: "Negative Adjustments", value: "141" },
                              { dataElement: "AL 20/120mg", categoryOptionCombo: "Positive Adjustments", value: "10060" },
                              { dataElement: "AL 20/120mg", categoryOptionCombo: "Closing Balance",      value: "9919" }
                            ]
                          }
```

### dhis2-integration DB configuration

The service reads its configuration from the `dhis2` schema in the `open_lmis` database (openlmis-ref-distro-db-1):

| Table | Key fields | Purpose |
|-------|-----------|---------|
| `dhis2.servers` | `url`, `username`, `password` | DHIS2 connection |
| `dhis2.data_elements` | `source`, `indicator`, `orderable`, `categorycombo` | Maps OpenLMIS product → DHIS2 indicator |
| `dhis2.shared_facilities` | `code`, `facilityid`, `orgunitid` | Maps OpenLMIS facility UUID → DHIS2 org unit |

`seed.sh` Step 12 configures all of these idempotently on every run.

---

## Mechanism 2 — Scheduled facility aggregation

### Purpose

Provides a daily consolidated DEBIT push to OpenLMIS for each facility that has dispensing data in DHIS2. Designed for facilities that report periodically rather than in real-time, and as a reconciliation mechanism for multi-facility deployments.

### Trigger

Runs automatically via `node-cron` on the schedule set by `AGGREGATE_SCHEDULE` (default: `0 1 * * *` — every day at 1am). Can also be triggered manually:

```bash
# Trigger for current month
curl -X POST http://localhost:5001/aggregate \
  -H 'Content-Type: application/json'

# Trigger for a specific period
curl -X POST http://localhost:5001/aggregate \
  -H 'Content-Type: application/json' \
  -d '{"period":"202603"}'
```

### Data flow

```
node-cron (1am daily) or POST /aggregate
  └─▶ runFacilityAggregation(period)
        ├─ 1. GET DHIS2 /api/analytics
        │       ?dimension=dx:<de1>;<de2>;...;<de8>
        │       &dimension=ou:<ouId1>;<ouId2>;...
        │       &filter=pe:<YYYYMM>
        │       → rows: [ [deId, ouId, value], ... ]
        │
        ├─ 2. Group rows by org unit
        │
        └─ 3. For each facility with data:
               POST OpenLMIS /api/stockEvents
               {
                 facilityId: "<lmis-uuid>",
                 programId:  "<program-uuid>",
                 lineItems: [
                   { orderableId, lotId, quantity, occurredDate, reasonId,
                     documentationNo: "AGG-202603-dwx1Yz4BwNX-ujPSJuS9pph" },
                   { orderableId, lotId, quantity, occurredDate, reasonId,
                     documentationNo: "AGG-202603-dwx1Yz4BwNX-DEAmox25001" },
                   ...  ← one line item per medicine with non-zero dispensed quantity
                 ]
               }
```

### Idempotency

`documentationNo` is `AGG-{period}-{dhis2OuId}-{deId}` — unique per facility per medicine per month. Running the aggregation twice for the same period will create duplicate stock events in OpenLMIS (OpenLMIS does not enforce uniqueness on `documentationNo`). In production, guard this with a processed-period log or add a duplicate-check before posting.

### Org unit → facility mapping

The `DHIS2_FACILITY_MAP` env var maps DHIS2 org unit UIDs to OpenLMIS facility UUIDs:

```json
{"dwx1Yz4BwNX": "28de536f-b826-4eeb-a3c4-d65221a1120d"}
```

If not set, falls back to `DHIS2_ORG_UNIT` → `OPENLMIS_FACILITY_ID` (single-facility mode).

---

## Per-medicine data element routing

Each medicine has its own DHIS2 data element for dispensed quantities and for stock on hand. The mediator resolves the correct DE from env var maps (orderable ID → DHIS2 DE UID).

### Seeded data elements — dispensed quantities (`DHIS2_ORDERABLE_DE_MAP`)

| Medicine | Code | OpenLMIS orderable (last 4) | DHIS2 DE UID |
|---|---|---|---|
| AL 20/120mg | `AL-20-120` | `...02056` | `ujPSJuS9pph` |
| Amoxicillin 250mg | `AMOX250` / `amoxicillin-250mg` | `...02002` | `DEAmox25001` |
| RDT Kit | `RDTKIT` / `rdt-kit` | `...02003` | `DERdtKit001` |
| Paracetamol Syrup | `PARASYR` / `paracetamol-syr` | `...02004` | `DEParSyr001` |
| Cotrimoxazole 480mg | `CTX480` / `ctx-480` | `...02005` | `DECtx480001` |
| ORS Sachet | `ORSACH` / `ors-sachet` | `...02006` | `DEOrsAch001` |
| Zinc 20mg | `ZINC20` / `zinc-20mg` | `...02007` | `DEZinc20001` |
| Iron + Folic Acid | `IRNFOL` / `iron-folic-acid` | `...02008` | `DEIrnFol001` |

### Seeded data elements — stock on hand (`DHIS2_ORDERABLE_SOH_DE_MAP`, aggregationType=LAST)

| Medicine | OpenLMIS orderable (last 4) | DHIS2 SOH DE UID |
|---|---|---|
| AL 20/120mg | `...02056` | `StockOnHnd1` |
| Amoxicillin 250mg | `...02002` | `DEAmoxSOH01` |
| RDT Kit | `...02003` | `DERdtSOH001` |
| Paracetamol Syrup | `...02004` | `DEParSOH001` |
| Cotrimoxazole 480mg | `...02005` | `DECtxSOH001` |
| ORS Sachet | `...02006` | `DEOrsSOH001` |
| Zinc 20mg | `...02007` | `DEZncSOH001` |
| Iron + Folic Acid | `...02008` | `DEIfaSOH001` |

Each dispense or receipt from the Android app writes to the medicine-specific dispensed DE and updates the medicine-specific SOH DE via `pushSohToDHIS2()`.

---

## DHIS2 analytics architecture

Understanding this is essential for debugging missing data in reports.

### Two separate table layers in PostgreSQL

DHIS2 uses two distinct layers in its `dhis2` PostgreSQL database:

```
POST /api/dataValueSets
        │
        ▼
┌─────────────────────────────────┐
│  datavalue  (transactional)     │  ← written immediately on every API call
│  one row per DE + orgUnit +     │    always up to date
│  period + categoryOptionCombo   │
└─────────────────────────────────┘
        │
        │  POST /api/resourceTables/analytics
        │  (triggered manually or by nightly scheduler)
        ▼
┌─────────────────────────────────┐
│  analytics_* (pre-aggregated)   │  ← flat denormalized tables, rebuilt on demand
│  analytics                      │    GET /api/analytics reads ONLY these tables
│  analytics_2026                 │
│  analytics_completeness         │
└─────────────────────────────────┘
        │
        ▼
GET /api/analytics → dashboard visualizations
```

### Key implications

| Behaviour | Reason |
|---|---|
| Data posted via API is immediately visible in `datavalue` | Writes go directly to the transactional table |
| New data does **not** appear in visualizations or `/api/analytics` until rebuild | Analytics tables are a snapshot, not a live view |
| New data elements added after the last rebuild show no data in reports | The analytics table schema only includes DEs that existed at rebuild time |
| `POST /api/resourceTables/analytics` triggers a rebuild | Takes 5–30s depending on data volume; runs async |
| DHIS2 has a configurable nightly rebuild scheduler | Default: disabled in this sandbox; triggered once in seed.sh |

### Checking the tables directly

```bash
# Rows in the transactional table (always current)
docker exec health-db-postgres psql -U admin -d dhis2 \
  -c "SELECT dataelementid, value, period, sourceid FROM datavalue ORDER BY lastupdated DESC LIMIT 10;"

# Confirm analytics table exists and has rows
docker exec health-db-postgres psql -U admin -d dhis2 \
  -c "SELECT COUNT(*) FROM analytics;"

# Check what data elements are in the analytics table
docker exec health-db-postgres psql -U admin -d dhis2 \
  -c "SELECT DISTINCT dx FROM analytics LIMIT 20;"
```

### Manually triggering a rebuild

```bash
curl -s -u admin:district -X POST \
  "http://localhost:8081/api/resourceTables/analytics"
# Returns immediately; rebuild runs in background (check logs for completion)
```

The seed.sh triggers this automatically after seeding all data elements and visualizations.

---

## Mechanism 3 — VHW category disaggregation

### Purpose

When a dispense is pushed to DHIS2 via `pushToDHIS2()`, the data value can optionally be tagged with a **Category Option Combo (COC)** that identifies which VHW (Village Health Worker) performed the dispense. This lets DHIS2 break down dispensing totals per field worker, in addition to the per-facility and per-medicine dimensions.

### DHIS2 entities (seeded)

| Entity | UID | Description |
|---|---|---|
| Category | `VHWCat00001` | "Field Worker" category (two options: opensrp-admin, vhw-leribe-01) |
| CategoryCombo | `VHWCatCmb01` | "Field Worker" category combo — applied to all 8 dispensed DEs |
| CategoryOptionCombo | `VHWCocAdm01` | COC for `Practitioner/opensrp-admin` |
| CategoryOptionCombo | `VHWCocVhw01` | COC for `Practitioner/vhw-leribe-01` |

All 8 dispensed data elements use `VHWCatCmb01` as their category combo, so every `POST /api/dataValueSets` call can carry a `categoryOptionCombo` field.

### Env var — `DHIS2_PERFORMER_CATEGORY_OPTION_MAP`

Maps performer FHIR references (as they appear in `MedicationDispense.performer[0].actor.reference`) to DHIS2 COC UIDs:

```json
{
  "Practitioner/opensrp-admin": "VHWCocAdm01",
  "Practitioner/vhw-leribe-01": "VHWCocVhw01"
}
```

If a performer reference is not in the map, `categoryOptionCombo` is omitted from the payload and DHIS2 assigns the default COC.

### Data flow

```
POST /fhir/MedicationDispense
  └─▶ performer[0].actor.reference  →  "Practitioner/opensrp-admin"
        └─▶ getPerformerCocMap()["Practitioner/opensrp-admin"]  →  "VHWCocAdm01"
              └─▶ pushToDHIS2():
                    POST /api/dataValueSets
                    {
                      dataElement:         "ujPSJuS9pph",  ← medicine-specific DE
                      orgUnit:             "dwx1Yz4BwNX",
                      period:              "202603",
                      value:               "6",
                      categoryOptionCombo: "VHWCocAdm01"   ← VHW tag
                    }
```

### Visualization — `BKMVhwPivt1`

| UID | Name | Type | Rows | Columns | Filter |
|---|---|---|---|---|---|
| `BKMVhwPivt1` | Dispensed Qty per VHW × Medicine (Pivot) | Pivot table | Field Worker COCs | All 8 dispensed DEs | This month |

This pivot is pinned to the BKM dashboard alongside the aggregation and SOH pivots.

### Mapping new VHWs

To add a new performer:

1. In DHIS2: create a new Category Option under `VHWCat00001`, then generate a new COC under `VHWCatCmb01` — note the generated COC UID.
2. In `docker-compose.yml`: extend `DHIS2_PERFORMER_CATEGORY_OPTION_MAP` with `"Practitioner/<new-id>": "<new-coc-uid>"`.
3. Restart the mediator container: `docker compose restart bkm-mediator`.

---

## DHIS2 visualizations

The dashboard at `http://localhost:8081/dhis-web-dashboard/index.html#/BKMDashbrd1` contains 10 visualizations. The four aggregation/SOH/VHW-specific reports are pinned at the top:

### Aggregation, SOH, and VHW reports

| UID | Name | Type | Rows | Columns | Filter |
|---|---|---|---|---|---|
| `BKMAggBar01` | Aggregation - Dispensed per Facility per Medicine (Bar) | Stacked column | Facilities (LEVEL-3) | Period (last 12 months) | All 8 medicines |
| `BKMAggPivt1` | Aggregation - Dispensed per Facility x Medicine (Pivot) | Pivot table | Facilities (LEVEL-3) | All 8 medicines | Last 12 months |
| `BKMSohPivt1` | Stock on Hand - All Medicines per Facility (Pivot) | Pivot table | Facilities (LEVEL-3) | All 8 SOH DEs | This month |
| `BKMVhwPivt1` | Dispensed Qty per VHW × Medicine (Pivot) | Pivot table | Field Worker COCs | All 8 dispensed DEs | This month |

The dispensed pivot (`BKMAggPivt1`) shows exactly what the daily aggregation cron reads from DHIS2 before pushing to OpenLMIS. The SOH pivot (`BKMSohPivt1`) shows the current stock-on-hand per facility × medicine, updated after every dispense or receipt event. The VHW pivot (`BKMVhwPivt1`) breaks down dispensing by individual field worker.

### Existing AL 20/120mg reports

| UID | Name | Type |
|---|---|---|
| `BKMBarChrt1` | AL 20/120mg Dispensing — Bar Chart | Column |
| `BKMSohLine1` | AL 20/120mg Stock on Hand — Line Chart | Line |
| `BKMPivotTb1` | AL 20/120mg Dispensing — Monthly Pivot | Pivot table |
| `BKMRecvBar1` | AL 20/120mg Stock Received — Bar Chart | Column |
| `BKMDispSOH1` | AL 20/120mg Dispensed vs SOH — Line | Line |
| `BKMAllPivt1` | AL 20/120mg — Dispensed / Received / SOH Pivot | Pivot table |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DHIS2_DE_STOCK_ON_HAND` | `StockOnHnd1` | Fallback SOH DE UID (AL 20/120mg) |
| `DHIS2_DE_STOCK_RECEIVED` | `StckRcvdAL1` | DE UID for receipts (AL only) |
| `DHIS2_DE_STOCK_DISPENSED` | `ujPSJuS9pph` | Fallback DE UID for dispenses |
| `DHIS2_ORDERABLE_DE_MAP` | `{}` | JSON: orderable ID → DHIS2 dispensed DE UID (all 8 medicines) |
| `DHIS2_ORDERABLE_SOH_DE_MAP` | `{}` | JSON: orderable ID → DHIS2 SOH DE UID (all 8 medicines) |
| `DHIS2_PERFORMER_CATEGORY_OPTION_MAP` | `{}` | JSON: performer FHIR ref → DHIS2 COC UID (VHW disaggregation) |
| `DHIS2_ORG_UNIT` | `dwx1Yz4BwNX` | Default DHIS2 org unit UID |
| `DHIS2_FACILITY_MAP` | `{}` | JSON: DHIS2 OU UID → OpenLMIS facility UUID |
| `OPENLMIS_LOT_MAP` | `{}` | JSON: orderable ID → lot UUID (used by aggregation events) |
| `AGGREGATE_SCHEDULE` | `0 1 * * *` | node-cron expression for scheduled aggregation |
| `DHIS2_URL` | — | Base URL of the DHIS2 instance |

---

## Remaining gaps

| Gap | Detail |
|---|---|
| **Period lock check (BR-11)** | No check that the target period is open in DHIS2. Locked-period rejections are logged as `outcome: "period-locked"` but not retried. |
| **Aggregation idempotency** | OpenLMIS does not deduplicate on `documentationNo`. Running aggregation twice for the same period doubles the stock debit. Add a processed-period store (Redis or DB) before production use. |
| **Receipt DE per medicine** | `DHIS2_DE_STOCK_RECEIVED` (`StckRcvdAL1`) is AL-only. Receipt dispenses for other medicines fall back to this same DE. Separate receipt DEs per medicine would require extending `DHIS2_ORDERABLE_DE_MAP` with a receipt-DE variant. |
| **Scheduled analytics rebuild** | Configured — job `Nightly Analytics Table Rebuild` runs at 02:30 daily (Quartz: `0 30 2 ? * *`). New data posted during the day is visible in the transactional `datavalue` table immediately but only appears in visualizations after the 02:30 rebuild. For same-day visibility trigger manually: `curl -u admin:district -X POST http://localhost:8081/api/resourceTables/analytics`. |
