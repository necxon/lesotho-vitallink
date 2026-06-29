# Two-Stage Dispense — Design

## The concept

Medicine moves in two physical steps before it reaches a patient:

```
Facility stock  →  VHW receives (stage 1)  →  Patient receives (stage 2)
```

**Stage 1 — Facility Worker pre-dispenses to VHW**
The facility worker counts out medicine and hands it to a specific VHW. This is recorded as a `SupplyDelivery` with `status = in-progress`.

**Stage 2a — VHW accepts on Android**
The VHW sees the pending delivery on their phone and taps "Accept". The `SupplyDelivery` status moves to `completed`. The medicine is now in the VHW's possession.

**Stage 2b — VHW dispenses to patient**
The VHW gives the medicine to a patient and submits a `MedicationDispense`. This deducts from the VHW's on-hand balance.

The facility worker can now see, at any time:
- How much medicine was issued to each VHW
- How much each VHW has dispensed to patients
- The outstanding balance (received − dispensed) per VHW

---

## Why this is better than a plain allocation

| Concern | Allocation model | Two-stage model |
|---|---|---|
| Physical tracking | Budget only — no confirmation VHW received it | SupplyDelivery acceptance confirms physical handover |
| Accountability | No evidence of handover | Signed acceptance on device creates an audit trail |
| Facility worker view | Can see budgets, not actuals | Can see exact received qty per VHW |
| Patient dispense validation | Check against allocation budget | Check against VHW's actual on-hand balance |
| OpenLMIS timing | Debit on allocation (before handover) | Debit on SupplyDelivery creation (committed) or acceptance (physical) |

---

## FHIR resource mapping

### Stage 1 — `SupplyDelivery` (in-progress)

Created by the facility worker via bkm-web or the Android app.

```json
{
  "resourceType": "SupplyDelivery",
  "id": "sd-fw-thabo-al20-202605-001",
  "status": "in-progress",
  "type": {
    "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/supply-type",
                 "code": "medication", "display": "Medication" }]
  },
  "suppliedItem": {
    "quantity": { "value": 50, "unit": "tablet" },
    "itemCodeableConcept": {
      "coding": [{ "code": "AL-20-120", "display": "Artemether-Lumefantrine 20/120mg" }]
    }
  },
  "occurrenceDateTime": "2026-05-26T08:00:00Z",
  "supplier":     { "reference": "Practitioner/prac-facility-worker" },
  "destination":  { "reference": "Practitioner/prac-thabo-mokoena" },
  "receiver":     [{ "reference": "Practitioner/prac-thabo-mokoena" }]
}
```

### Stage 2a — VHW acceptance (status update)

The Android app PUTs the same resource with `status = completed`.

```json
{
  "resourceType": "SupplyDelivery",
  "id": "sd-fw-thabo-al20-202605-001",
  "status": "completed",
  ...same fields...
}
```

The mediator intercepts this PUT via OpenHIM and records the acceptance.

### Stage 2b — `MedicationDispense` (patient)

Same as today — VHW submits via the "Dispense Medicine" questionnaire or direct MedicationDispense POST.

```json
{
  "resourceType": "MedicationDispense",
  "status": "completed",
  "subject":   { "reference": "Patient/patient-001" },
  "performer": [{ "actor": { "reference": "Practitioner/prac-thabo-mokoena" } }],
  "medicationCodeableConcept": { "coding": [{ "code": "AL-20-120" }] },
  "quantity": { "value": 6, "unit": "tablet" }
}
```

---

## Stock tracking

### Facility stock (OpenLMIS)
- **Debit** happens when the facility worker creates the `SupplyDelivery` (medicine is committed and physically counted out).
- This is the same timing as a direct dispense — OpenLMIS reflects the quantity leaving the facility immediately.

### VHW on-hand balance (mediator Postgres)
Tracked in a new table:

```sql
CREATE TABLE vhw_stock (
  practitioner   TEXT     NOT NULL,
  medication     TEXT     NOT NULL,
  period         CHAR(6)  NOT NULL,
  received_qty   INTEGER  NOT NULL DEFAULT 0,   -- from accepted SupplyDeliveries
  dispensed_qty  INTEGER  NOT NULL DEFAULT 0,   -- from completed MedicationDispenses
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (practitioner, medication, period)
);
```

`on_hand = received_qty − dispensed_qty`

### Event → table update mapping

| Event | `received_qty` | `dispensed_qty` |
|---|---|---|
| SupplyDelivery `in-progress` created | no change yet | — |
| SupplyDelivery `completed` (VHW accepts) | +quantity | — |
| MedicationDispense `completed` by this VHW | — | +quantity |

Rejecting a patient dispense if `quantity > on_hand` is now meaningful because `received_qty` is grounded in an actual acceptance, not just a budget promise.

---

## Mediator changes

### 1. `POST /fhir/SupplyDelivery` (existing route — `supply.js`)

**Currently:** Creates a FHIR Task for the VHW and returns. No OpenLMIS write.

**New behaviour:**
1. Validate: `supplier` is a facility_worker in PERFORMER_MAP, `destination` is a VHW at the same facility.
2. Validate: medicine resolves to an orderable.
3. Check facility SOH ≥ quantity (same as dispense).
4. POST `SupplyDelivery` to HAPI FHIR with `status = in-progress`.
5. Write OpenLMIS DEBIT (same as a dispense — medicine is committed).
6. Create a FHIR Task (`requested`) for the VHW so Android shows the pending delivery.
7. Do NOT increment `vhw_stock.received_qty` yet — wait for acceptance.

### 2. `PUT /fhir/SupplyDelivery/:id` (new handler)

Intercepts the VHW's acceptance on Android.

1. Fetch the existing SupplyDelivery from HAPI FHIR.
2. Confirm the status transition is `in-progress → completed`.
3. Confirm the requester is the `destination` practitioner (the VHW).
4. PUT the updated resource to HAPI FHIR.
5. Increment `vhw_stock.received_qty` for (practitioner, medication, period).
6. Update the Task status → `accepted`.

### 3. `POST /fhir/MedicationDispense` (existing `dispense.js` / `fanout.js`)

**New check before the facility SOH check:**

```
if VHW_STOCK_ENABLED and vhw_stock row exists for (performer, medication, period):
    if dispensed_qty + quantity > received_qty → reject insufficient-vhw-stock
else:
    fall through to facility SOH check (current behaviour, for backwards compat)
```

On successful fan-out, increment `vhw_stock.dispensed_qty`.

### 4. `app.js`

```js
// existing:
app.use('/fhir/SupplyDelivery', require('./routes/supply'));

// supply.js needs to handle both POST and PUT:
router.post('/',    handlePreDispense);   // facility worker issues
router.put('/:id',  handleVhwAcceptance); // VHW accepts
```

---

## Android app changes needed

The Android FHIR Core app needs two additions:

### 1. Show pending SupplyDeliveries

A new "Pending Stock" screen that queries:
```
GET /fhir/SupplyDelivery?destination=Practitioner/{self}&status=in-progress
```
Shows each pending delivery: medicine name, quantity, supplier, date.

### 2. Accept button

Tapping "Accept" on a pending delivery sends:
```
PUT /fhir/SupplyDelivery/{id}
{ ...existing resource..., "status": "completed" }
```

---

## bkm-web UI changes

### Mappings page — issue stock to VHW

Add an **Issue Stock** button per VHW row. Opens a modal:
- Medicine (dropdown)
- Quantity (number)
- Posts `POST /fhir/SupplyDelivery`

### New "VHW Stock Ledger" view (new page or tab on Patients/Groups)

| VHW | Medicine | Issued | Accepted | Dispensed | On Hand | Period |
|---|---|---|---|---|---|---|
| Thabo Mokoena | AL-20-120 | 50 | 50 | 12 | **38** | 2026-05 |
| Thabo Mokoena | Zinc 20mg | 30 | 0 | 0 | **pending** | 2026-05 |
| Lineo Nthabi | AL-20-120 | 40 | 40 | 40 | **0** | 2026-05 |

**Issued** = SupplyDeliveries in-progress + completed  
**Accepted** = SupplyDeliveries completed  
**Dispensed** = MedicationDispenses for this VHW  
**On Hand** = Accepted − Dispensed  
**Pending** = Issued but not yet accepted

---

## Runtime config flags

| Key | Default | Description |
|---|---|---|
| `VHW_STOCK_ENABLED` | `false` | Enable two-stage stock tracking. When false, dispense falls back to facility SOH check |
| `REQUIRE_VHW_ACCEPTANCE` | `false` | When true, dispense is rejected if VHW has not yet accepted the SupplyDelivery for that medicine |
| `DEBIT_ON_SUPPLY_CREATE` | `true` | When true, OpenLMIS DEBIT happens at SupplyDelivery creation. When false, debit is deferred until VHW acceptance |

---

## Relationship to existing allocation design

`docs/per-vhw-allocation.md` describes a simpler budget model. Two-stage is a superset:

- The allocation doc tracks a **budget promise** (facility worker says "you may dispense up to 50")
- Two-stage tracks **physical custody** (VHW has 50 tablets in their bag, confirmed on device)

If two-stage is implemented, the allocation approach is no longer needed — the SupplyDelivery acceptance IS the allocation, but grounded in a real handover.

---

## Postgres tables summary

```
vhw_stock
  practitioner   TEXT
  medication     TEXT
  period         CHAR(6)
  received_qty   INTEGER    ← incremented on SupplyDelivery accepted
  dispensed_qty  INTEGER    ← incremented on MedicationDispense completed
  PRIMARY KEY (practitioner, medication, period)

supply_deliveries_log           ← optional, for audit trail
  supply_delivery_id  TEXT
  supplier            TEXT
  destination         TEXT
  medication          TEXT
  quantity            INTEGER
  status              TEXT       in-progress | completed | abandoned
  created_at          TIMESTAMPTZ
  accepted_at         TIMESTAMPTZ
```

---

## Stock return — VHW gives unused medicine back to facility

### Current state

Not implemented. The adjustment reason map in `mediator/src/routes/questionnaire.js` only covers negative write-offs:

```js
const ADJUSTMENT_REASON_MAP = {
  expired:     () => process.env.OPENLMIS_REASON_EXPIRED_ID,
  damaged:     () => process.env.OPENLMIS_REASON_DAMAGED_ID,
  lost_stolen: () => process.env.OPENLMIS_REASON_LOST_ID,
};
```

There is no `returned_to_facility` path. A VHW who has unused stock at end of period, or who received the wrong medicine, cannot currently record that return anywhere in the system.

### Why it matters with two-stage

Without stock return, the VHW on-hand balance can only go down (through patient dispenses). If a VHW hands medicine back to the facility the balance stays artificially high forever. This breaks the ledger view and blocks accurate reorder calculations.

### Proposed flow

```
VHW submits "Return Stock" form on Android
       │
       ▼
POST /fhir/QuestionnaireResponse
  type = ADJUSTMENT, adjustmentReason = returned_to_facility
       │
       ▼
Mediator fans out to OpenLMIS:
  CREDIT to facility stock card (medicine is back in the pool)
       │
       ▼
vhw_stock.returned_qty += quantity
on_hand = received_qty − dispensed_qty − returned_qty
```

### FHIR resource

The return uses the same `QuestionnaireResponse` path as other adjustments — no new resource type needed.

```json
{
  "resourceType": "QuestionnaireResponse",
  "questionnaire": "qn-stock-adjustment",
  "status": "completed",
  "item": [
    { "linkId": "medication",       "answer": [{ "valueCoding": { "code": "AL-20-120" } }] },
    { "linkId": "quantity",         "answer": [{ "valueInteger": 10 }] },
    { "linkId": "adjustmentReason", "answer": [{ "valueCoding": { "code": "returned_to_facility" } }] }
  ]
}
```

### Mediator changes

**`mediator/src/routes/questionnaire.js` — `ADJUSTMENT_REASON_MAP`**

Add the new reason. It maps to a CREDIT reason UUID in OpenLMIS (not a DEBIT):

```js
const ADJUSTMENT_REASON_MAP = {
  expired:              () => process.env.OPENLMIS_REASON_EXPIRED_ID,
  damaged:              () => process.env.OPENLMIS_REASON_DAMAGED_ID,
  lost_stolen:          () => process.env.OPENLMIS_REASON_LOST_ID,
  returned_to_facility: () => process.env.OPENLMIS_REASON_RETURNED_ID,  // ← new CREDIT reason
};
```

**`mediator/src/sync/fanout.js` — SOH safety gate**

The current gate blocks any event where `qty > facility SOH`. A return increases SOH so the gate must be skipped for CREDIT adjustments. The `isReceipt` flag already bypasses the gate — returns should be treated the same way:

```js
// current:
const stock = (isReceipt || !enforceStock) ? { ok: true } : await checkStock(identity, qty);

// with returns:
const stock = (isReceipt || isReturn || !enforceStock) ? { ok: true } : await checkStock(identity, qty);
```

`isReturn` is true when `reasonCode === 'returned_to_facility'`. It needs to be passed through `executeFanout()` the same way `isReceipt` is.

**`mediator/src/sync/vhwStock.js` (new file from two-stage plan)**

Add a `returned_qty` column to `vhw_stock` and a `incrementReturned()` helper. On successful fan-out with `isReturn`, call `incrementReturned()` instead of `incrementDispensed()`.

**`mediator/src/integrations/openlmis.js` — `pushToOpenLMIS()`**

The return must post to OpenLMIS with the CREDIT reason UUID (not the DEBIT Consumed UUID). The `reasonId` parameter is already threaded through from `questionnaire.js` → `executeFanout()` → `pushToOpenLMIS()` — so passing the CREDIT UUID is sufficient. No structural change needed.

### OpenLMIS reason setup

A new stock adjustment reason must be seeded in OpenLMIS — a CREDIT type (SOH increases):

```sql
-- scripts/seed.sh step 7 area — or via /api/stockAdjustmentReasons
INSERT INTO stockmanagement.stock_card_line_item_reasons
  (id, name, description, reasontype, reasoncategory, ...)
VALUES
  (gen_random_uuid(), 'Returned by VHW', 'Stock returned from VHW to facility', 'CREDIT', 'ADJUSTMENT', ...);
```

The UUID of this reason is stored in `OPENLMIS_REASON_RETURNED_ID` env var and referenced by `ADJUSTMENT_REASON_MAP`.

### Android questionnaire

Add `returned_to_facility` as an answer option to the existing stock adjustment questionnaire (`qn-stock-adjustment`) in HAPI FHIR, alongside `expired`, `damaged`, `lost_stolen`.

### `vhw_stock` table addition

```sql
ALTER TABLE vhw_stock ADD COLUMN IF NOT EXISTS returned_qty INTEGER NOT NULL DEFAULT 0;

-- on_hand computed as:
-- received_qty - dispensed_qty - returned_qty
```

### Updated VHW Stock Ledger view

| VHW | Medicine | Issued | Accepted | Dispensed | Returned | On Hand |
|---|---|---|---|---|---|---|
| Thabo Mokoena | AL-20-120 | 50 | 50 | 12 | 5 | **33** |
| Lineo Nthabi | Zinc 20mg | 30 | 30 | 30 | 0 | **0** |

---

## Files to create / modify (in order)

| # | File | Change |
|---|---|---|
| 1 | `mediator/src/db.js` | Add `vhw_stock` + `supply_deliveries_log` tables to `initDb()` |
| 2 | `mediator/src/routes/supply.js` | Add `PUT /:id` handler for VHW acceptance; extend POST to write OpenLMIS DEBIT + HAPI SupplyDelivery |
| 3 | `mediator/src/sync/vhwStock.js` | New file — `incrementReceived()`, `incrementDispensed()`, `getBalance()`, `checkVhwStock()` |
| 4 | `mediator/src/sync/fanout.js` | Add `checkVhwStock()` call before facility SOH check; call `incrementDispensed()` after lmisOk |
| 5 | `mediator/src/config/runtimeConfig.js` | Add `VHW_STOCK_ENABLED`, `REQUIRE_VHW_ACCEPTANCE`, `DEBIT_ON_SUPPLY_CREATE` |
| 6 | `mediator/src/app.js` | No change needed — `/fhir/SupplyDelivery` is already registered |
| 7 | `bkm-web/js/pages/mappings.js` | Add Issue Stock button per VHW row |
| 8 | `bkm-web/js/pages/` | New `vhw-stock.js` page — VHW Stock Ledger table |
| 9 | `bkm-web/js/nav.js` or router | Register new page in navigation |
| 10 | `bkm-web/js/pages/settings.js` | Add three new runtime config toggles |
| 11 | `mediator/__tests__/supply.test.js` | Tests for SupplyDelivery POST and PUT handlers |
| 12 | `mediator/__tests__/vhwStock.test.js` | Tests for balance tracking and dispense check |
| 13 | `mediator/src/routes/questionnaire.js` | Add `returned_to_facility` to `ADJUSTMENT_REASON_MAP` |
| 14 | `mediator/src/sync/fanout.js` | Skip SOH gate for `isReturn` (same as `isReceipt`) |
| 15 | `mediator/src/sync/vhwStock.js` | Add `returned_qty` column + `incrementReturned()` helper |
| 16 | `scripts/seed.sh` | Seed OpenLMIS CREDIT reason for VHW returns; set `OPENLMIS_REASON_RETURNED_ID` |
| 17 | `docker-compose.yml` | Add `OPENLMIS_REASON_RETURNED_ID` env var to mediator service |
