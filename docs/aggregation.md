# Aggregation — BKM to DHIS2

Explains what "aggregation" means in the BKM–eLMIS integration, how it works today, and where the remaining gaps are (BR-11).

---

## What "aggregation" means here

Individual community-level stock events (dispenses and receipts) are captured in BKM (Android) and forwarded to OpenLMIS as DEBIT/CREDIT `stockEvents`. These are fine-grained, per-transaction records.

**Aggregation** is the step that rolls these up into a single summary value per facility / product / month and writes it to DHIS2 for national-level reporting and requisition planning.

In this sandbox, the aggregated value is **Stock on Hand (SOH)** — the current quantity of a product at a facility — not a sum computed in the mediator. The mediator asks OpenLMIS for its authoritative SOH total and forwards that number to DHIS2.

---

## How it works today

### Trigger

`pushSohToDHIS2()` is called automatically after every successful eLMIS fan-out, from two routes:

| Route | Triggered by | `triggeredBy` value |
|-------|-------------|---------------------|
| `POST /fhir/MedicationDispense` | VHW records a dispense | `BKM-{resource.id}` |
| `POST /fhir/QuestionnaireResponse` | VHW accepts a stock delivery | `Task/{taskId}` or `BKM-{resource.id}` |

The call is **fire-and-forget** (`.catch(() => {})`): a DHIS2 failure never blocks the BKM response.

### Data flow

```
BKM app
  └─▶ POST /fhir/MedicationDispense (or QuestionnaireResponse)
        └─▶ MW fans out to OpenLMIS → stockEvent recorded (DEBIT or CREDIT)
              └─▶ pushSohToDHIS2(identity, { triggeredBy }) [async, non-blocking]
                    ├─ GET  OpenLMIS /api/stockCardSummaries
                    │        ?facility=<id>&program=<id>&orderable=<id>
                    │        → returns { stockOnHand: N }
                    └─ POST DHIS2 /api/dataValueSets
                             {
                               dataElement: "StockOnHnd1",
                               orgUnit:     "dwx1Yz4BwNX",
                               period:      "202603",
                               value:       "9950",
                               comment:     "Task/task-abc123"   ← BR-12 traceability
                             }
```

### Identity resolution (mapped items)

The mediator resolves which facility / program / orderable to query from `mappings.csv`, keyed on the FHIR `performer` reference (Practitioner ID). Only performers present in the CSV can reach eLMIS or DHIS2. Unknown performers are rejected before any fan-out.

```
performer → facilityId  (OpenLMIS UUID)
          → programId   (OpenLMIS UUID)
          → orderableId (OpenLMIS UUID)
          → orgUnit     (DHIS2 UID)
```

### Reporting period

The period is derived at call time:

```js
const period = new Date().toISOString().slice(0, 7).replace('-', ''); // e.g. "202603"
```

DHIS2 uses `YYYYMM` monthly periods. The value written is the SOH at the moment of the triggering event, not a period-end snapshot.

### DHIS2 data elements written

| Data element | UID | Written by | Aggregation type |
|---|---|---|---|
| Stock on Hand (AL 20/120mg) | `StockOnHnd1` | `pushSohToDHIS2()` after every event | LAST (period-end value) |
| Stock Received (AL 20/120mg) | `StckRcvdAL1` | Background receipt poller | SUM |
| Stock Dispensed (AL 20/120mg) | `ujPSJuS9pph` | MedicationDispense route | SUM |

### Audit log (NFR-20)

Every `pushSohToDHIS2()` call emits a structured Winston log entry regardless of outcome:

```json
{
  "event": "aggregation-run",
  "reportingPeriod": "202603",
  "datasetId": "StockOnHnd1",
  "facilityId": "28de536f-...",
  "programId":  "31ef5fd8-...",
  "orderableId": "3be1d20f-...",
  "orgUnit": "dwx1Yz4BwNX",
  "triggeredBy": "Task/task-abc123",
  "outcome": "success",
  "soh": 9950,
  "dhis2Status": 200
}
```

`outcome` is one of `success`, `failed`, or `skipped` (skipped = no stock card found in eLMIS for that product).

### Traceability chain (BR-12)

Each DHIS2 SOH data value carries a `comment` field set to the `triggeredBy` value. This creates a full audit chain:

```
DHIS2 data value
  └─ comment: "Task/task-abc123"
        └─▶ HAPI FHIR Task resource (GET /fhir/Task/task-abc123)
                  └─▶ eLMIS stockEvent (documentationNo = "BKM-{timestamp}")
```

**To retrieve the comment from DHIS2:**

```bash
curl -u admin:district \
  "http://localhost:8081/api/dataValues?dataElement=StockOnHnd1&orgUnit=dwx1Yz4BwNX&period=202603"
```

**Limitation:** the `comment` field is overwritten on each SOH push within the same `(dataElement, orgUnit, period)` combination. Only the most recent trigger is stored in DHIS2. For a complete per-event audit trail use the Winston `aggregation-run` log entries, which are never overwritten.

---

## Remaining gaps

### BR-11 — Approved periods and mapped items

| Gap | Detail |
|-----|--------|
| Period approval | The period is always the current calendar month. There is no check that the period is open/approved in DHIS2 or eLMIS. In production, periods can be locked after close; posting to a locked period should be rejected. |
| Approved product list | Mapping is controlled by `mappings.csv` — any orderable in that file can reach DHIS2. There is no validation against a program's formally approved product list for the reporting period. |

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DHIS2_DE_STOCK_ON_HAND` | `StockOnHnd1` | Data element UID for SOH |
| `DHIS2_DE_STOCK_RECEIVED` | `StckRcvdAL1` | Data element UID for receipts |
| `DHIS2_DE_STOCK_DISPENSED` | `ujPSJuS9pph` | Data element UID for dispenses |
| `DHIS2_ORG_UNIT` | `dwx1Yz4BwNX` | DHIS2 org unit UID for the facility |
| `DHIS2_URL` | — | Base URL of the DHIS2 instance |
