# Per-VHW Stock Allocation

> **STATUS: IMPLEMENTED (web-driven), 2026-06-09.** Backend + bkm-web UI are live on
> `lesotho-test`. A facility worker/supervisor allocates from **Staff Management →
> Performers → Allocate** (per VHW row); the **Stock Allocations** tab shows the budget
> table. Enforcement is **off by default** (`REQUIRE_VHW_ALLOCATION=false` → pool behaviour
> unchanged); flip the toggle to enforce. Endpoints: `POST /aggregate/stock/allocate`,
> `GET /aggregate/stock/allocations`. App-driven allocation (a VHW questionnaire) is NOT
> built — see the "Android app" option discussion.

## Current behaviour

One OpenLMIS stock card exists per facility. All VHWs draw from it freely at dispense time. When a facility worker accepts a delivery, the mediator creates a FHIR Task for every VHW at that facility — but all Tasks carry the same total delivery quantity. It is a notification, not an allocation split.

There is no concept of "Facility Worker assigns 50 tablets to VHW-A and 30 to VHW-B". The SOH check at dispense time only validates against the facility pool total.

---

## Proposed design

### Goal

A facility worker explicitly assigns a quantity per medicine per VHW. That assigned quantity becomes the VHW's personal budget for the period. Dispenses deduct from the VHW's allocated amount, not from the raw facility SOH.

---

### New database table

```sql
CREATE TABLE vhw_allocations (
  id            SERIAL PRIMARY KEY,
  period        VARCHAR(6)   NOT NULL,          -- e.g. 202605
  facility_id   TEXT         NOT NULL,
  practitioner  TEXT         NOT NULL,          -- Practitioner/prac-thabo-mokoena
  medication    TEXT         NOT NULL,          -- AL-20-120
  allocated_qty INTEGER      NOT NULL,
  dispensed_qty INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (period, practitioner, medication)
);
```

---

### New mediator endpoint

`POST /aggregate/stock/allocate`

Called by the facility worker (or bkm-web) after accepting a delivery.

**Request**
```json
{
  "vhwId":      "prac-thabo-mokoena",
  "medication": "AL-20-120",
  "quantity":   50
}
```

**Logic**
1. Validate `vhwId` is in PERFORMER_MAP with `role !== 'facility_worker'` and same `facilityId` as caller.
2. Validate `medication` resolves to a known orderable.
3. Check facility SOH in OpenLMIS ≥ sum of all allocations already made this period for this medicine + requested quantity.
4. Upsert row in `vhw_allocations` (add to `allocated_qty` if row exists for the period).
5. Create/update a FHIR Task (`requested`) for the VHW with the allocated quantity — this is what appears on the Android app.

**Response**
```json
{
  "status": "ok",
  "vhwId": "prac-thabo-mokoena",
  "medication": "AL-20-120",
  "allocatedQty": 50,
  "dispensedQty": 0,
  "remainingQty": 50,
  "period": "202605"
}
```

---

### Dispense change

`fanout.js` / `dispense.js` — SOH check currently calls `checkStock()` against the facility pool.

**New check:** before calling OpenLMIS, look up `vhw_allocations` for `(period, practitioner, medication)`:

```
remaining = allocated_qty - dispensed_qty
if quantity > remaining → reject with insufficient-allocation (not insufficient-stock)
```

If no allocation row exists for the VHW, behaviour depends on a new runtime config flag:

| Flag | Value | Behaviour |
|---|---|---|
| `REQUIRE_VHW_ALLOCATION` | `true` | Reject — VHW must have an allocation before dispensing |
| `REQUIRE_VHW_ALLOCATION` | `false` (default) | Fall through to facility SOH check (current behaviour) |

On successful dispense, increment `dispensed_qty` in `vhw_allocations`.

---

### bkm-web UI changes

**Mappings page** — add an "Allocate Stock" button per VHW row. Opens a modal:
- Select medicine (dropdown from MEDICATION_MAP)
- Enter quantity
- Calls `POST /aggregate/stock/allocate`

**Orders / Stock page** — add an "Allocations" tab or sub-section showing:

| VHW | Medicine | Allocated | Dispensed | Remaining | Period |
|---|---|---|---|---|---|
| Thabo Mokoena | AL-20-120 | 50 | 12 | 38 | 2026-05 |
| Lineo Nthabi | Zinc 20mg | 30 | 0 | 30 | 2026-05 |

---

### Settings page additions

| Key | Default | Description |
|---|---|---|
| `REQUIRE_VHW_ALLOCATION` | `false` | Reject dispenses from VHWs with no allocation for the period |
| `ALLOCATION_CARRIES_OVER` | `false` | If true, unused allocation rolls into the next period instead of resetting |

---

### Files to create / modify

| File | Change |
|---|---|
| `mediator/src/db.js` | Add `vhw_allocations` table creation on startup |
| `mediator/src/routes/allocations.js` | New file — `POST /aggregate/stock/allocate`, `GET /aggregate/stock/allocations` |
| `mediator/src/app.js` | Register `/aggregate/stock` route |
| `mediator/src/sync/fanout.js` | Add allocation check before SOH check |
| `mediator/src/config/runtimeConfig.js` | Add `REQUIRE_VHW_ALLOCATION`, `ALLOCATION_CARRIES_OVER` defaults |
| `bkm-web/js/pages/mappings.js` | Add Allocate Stock button per VHW |
| `bkm-web/js/pages/settings.js` | Add two new toggles |
| `mediator/__tests__/allocations.test.js` | New test file |

---

### What does NOT change

- OpenLMIS stock cards remain at facility level — allocation is tracked in the mediator's Postgres, not in OpenLMIS.
- FHIR Tasks remain the mechanism by which VHWs see pending stock on the Android app.
- The facility SOH is still the ultimate ceiling — you cannot allocate more than is on hand at the facility.

---

## Implementation — exact code changes

Work through the files in this order. Each step compiles and runs on its own before the next builds on it.

---

### Step 1 — `mediator/src/db.js`

Add the `vhw_allocations` table inside the existing `initDb()` function, after the `soh_tracker` block and before the `ALTER TABLE` migration lines. The log message on line 51 must also be updated.

```js
// after the soh_tracker CREATE TABLE block:
await pool.query(`
  CREATE TABLE IF NOT EXISTS vhw_allocations (
    id            SERIAL       PRIMARY KEY,
    period        CHAR(6)      NOT NULL,
    facility_id   TEXT         NOT NULL,
    practitioner  TEXT         NOT NULL,
    medication    TEXT         NOT NULL,
    allocated_qty INTEGER      NOT NULL,
    dispensed_qty INTEGER      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (period, practitioner, medication)
  )
`);
```

Update the info log message to mention the new table:
```js
// change:
logger.info({ event: 'db-init', message: 'order_buffer + dispatch_history + soh_tracker tables ready' });
// to:
logger.info({ event: 'db-init', message: 'order_buffer + dispatch_history + soh_tracker + vhw_allocations tables ready' });
```

---

### Step 2 — `mediator/src/routes/allocations.js` (new file)

Create this file. It exports an Express router mounted at `/aggregate/stock`.

The router needs:
- `POST /allocate` — create/update an allocation
- `GET /allocations` — list allocations for current period (optional filter: `?period=202605&facilityId=...`)

Key logic inside `POST /allocate`:

```js
const { PERFORMER_MAP, MEDICATION_MAP } = require('../mappings/mappings');
const { checkStock }                    = require('../integrations/openlmis');
const { pool }                          = require('../db');
const { createStockTask }               = require('../tasks/tasks');

// 1. Resolve caller's facilityId from the request body facilityWorkerId field
//    (or from JWT sub → PERFORMER_MAP lookup if auth is added later)
const fw = PERFORMER_MAP[req.body.facilityWorkerId] || PERFORMER_MAP[`Practitioner/${req.body.facilityWorkerId}`];
if (!fw || fw.role !== 'facility_worker') → 400

// 2. Resolve VHW
const vhw = PERFORMER_MAP[vhwId] || PERFORMER_MAP[`Practitioner/${vhwId}`];
if (!vhw || vhw.role === 'facility_worker' || vhw.facilityId !== fw.facilityId) → 400

// 3. Resolve orderable
const orderableId = MEDICATION_MAP[medication];
if (!orderableId) → 400

// 4. Check facility SOH covers existing allocations + new request
//    Sum current period allocations for this medication at this facility:
const { rows } = await pool.query(
  `SELECT COALESCE(SUM(allocated_qty - dispensed_qty), 0) AS committed
   FROM vhw_allocations WHERE period=$1 AND facility_id=$2 AND medication=$3`,
  [period, fw.facilityId, medication]
);
const committed = parseInt(rows[0].committed);
const soh = await checkStock({ facilityId: fw.facilityId, programId: fw.programId, orderableId }, committed + quantity);
if (!soh.ok) → 422 insufficient-facility-stock

// 5. Upsert allocation row
await pool.query(`
  INSERT INTO vhw_allocations (period, facility_id, practitioner, medication, allocated_qty)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (period, practitioner, medication)
  DO UPDATE SET allocated_qty = vhw_allocations.allocated_qty + EXCLUDED.allocated_qty,
                updated_at    = NOW()
`, [period, fw.facilityId, vhwRef, medication, quantity]);

// 6. Create FHIR Task so the VHW sees it on Android
await createStockTask({ performer: vhwRef, medication, quantity, taskId: `task-alloc-${period}-...` });
```

---

### Step 3 — `mediator/src/app.js`

Register the new route **before** the catch-all `/aggregate` route (line 14), otherwise requests to `/aggregate/stock/...` will be swallowed by the existing aggregate router first.

```js
// add this line BEFORE the existing '/aggregate' line:
app.use('/aggregate/stock', require('./routes/allocations'));
```

The current line order is:
```
app.use('/aggregate/mappings', ...)   // line 12
app.use('/aggregate/users',   ...)   // line 13
app.use('/aggregate',         ...)   // line 14  ← catch-all, must stay last
```

Insert the new line at line 13 (between users and the catch-all):
```
app.use('/aggregate/mappings', ...)
app.use('/aggregate/users',   ...)
app.use('/aggregate/stock',   require('./routes/allocations'))  // ← insert here
app.use('/aggregate',         ...)   // catch-all stays last
```

---

### Step 4 — `mediator/src/sync/fanout.js`

The allocation check must run **after** BR-07 validation and **before** the facility SOH check. The exact insertion point is between line 80 (end of BR-07 block) and line 84 (the `checkStock` call).

```js
// existing BR-07 block ends here (line 80)

// ── NEW: per-VHW allocation check ────────────────────────────────────────────
if (!isReceipt && identity.performerKnown) {
  const alloc = await checkAllocation(identity.performerId, medCode, qty);
  if (alloc.hasAllocation && !alloc.ok) {
    return { validation: { ok: false, reason: 'insufficient-allocation',
                           allocated: alloc.allocated, dispensed: alloc.dispensed,
                           remaining: alloc.remaining, requested: qty },
             stock: null, opensrp: null, dhis: null, lmis: null };
  }
  if (!alloc.hasAllocation && runtimeConfig.get('REQUIRE_VHW_ALLOCATION') === 'true') {
    return { validation: { ok: false, reason: 'no-allocation',
                           performer: identity.performerId, medication: medCode },
             stock: null, opensrp: null, dhis: null, lmis: null };
  }
}
// ── end allocation check ──────────────────────────────────────────────────────

// existing SOH check (line 83):
const enforceStock = runtimeConfig.get('REJECT_DISPENSE_EXCEEDS_STOCK') !== 'false';
const stock = (isReceipt || !enforceStock) ? { ok: true } : await checkStock(identity, qty);
```

`checkAllocation` is a small helper function in a new file `mediator/src/allocations/allocationStore.js`:

```js
// allocationStore.js
async function checkAllocation(performer, medication, qty) {
  const period = new Date().toISOString().slice(0, 7).replace('-', '');
  const { rows } = await pool.query(
    `SELECT allocated_qty, dispensed_qty FROM vhw_allocations
     WHERE period=$1 AND practitioner=$2 AND medication=$3`,
    [period, performer, medication]
  );
  if (rows.length === 0) return { hasAllocation: false };
  const { allocated_qty, dispensed_qty } = rows[0];
  const remaining = allocated_qty - dispensed_qty;
  return { hasAllocation: true, ok: remaining >= qty,
           allocated: allocated_qty, dispensed: dispensed_qty, remaining };
}

async function recordDispense(performer, medication, qty) {
  const period = new Date().toISOString().slice(0, 7).replace('-', '');
  await pool.query(
    `UPDATE vhw_allocations SET dispensed_qty = dispensed_qty + $1, updated_at = NOW()
     WHERE period=$2 AND practitioner=$3 AND medication=$4`,
    [qty, period, performer, medication]
  );
}

module.exports = { checkAllocation, recordDispense };
```

After the eLMIS fan-out succeeds (currently around line 111 in `fanout.js` where `lmisOk` is checked), call `recordDispense` to increment `dispensed_qty`:

```js
// after: if (DHIS2_PUSH_MODE === 'direct' && dhis2Enabled && lmisOk) { ... }
if (lmisOk && !isReceipt && identity.performerKnown) {
  const { recordDispense } = require('../allocations/allocationStore');
  recordDispense(identity.performerId, medCode, qty).catch(() => {});
}
```

---

### Step 5 — `mediator/src/config/runtimeConfig.js`

Add two new defaults inside the `DEFAULTS` object, alongside the existing business rule flags:

```js
// add after REJECT_UNKNOWN_MEDICINE:
REQUIRE_VHW_ALLOCATION:        'false',
ALLOCATION_CARRIES_OVER:       'false',
```

---

### Step 6 — `bkm-web/js/pages/mappings.js`

The VHW rows are rendered in the performers table. Find where each performer row is built (the `<tr>` that shows name, role, facility etc.) and add an **Allocate** button in the actions column, alongside the existing Edit button.

The button opens a small modal with:
- Medicine dropdown — built from `Object.keys(medications)` fetched from `GET /aggregate/mappings`
- Quantity number input
- Facility worker selector — dropdown of performers with `role === 'facility_worker'` at the same facility

On submit it calls:
```js
mediatorFetch('stock/allocate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ facilityWorkerId, vhwId, medication, quantity })
})
```

---

### Step 7 — `bkm-web/js/pages/settings.js`

Add two toggles to the `Business Rules` group in `SETTINGS_SCHEMA`, after the existing `REJECT_UNKNOWN_MEDICINE` entry:

```js
{ key: 'REQUIRE_VHW_ALLOCATION', label: 'Require VHW allocation before dispensing', type: 'bool',
  hint: 'When enabled, a VHW cannot dispense a medicine unless a facility worker has explicitly allocated ' +
        'that medicine to them for the current period. When disabled (default), VHWs fall back to the ' +
        'facility SOH check if no allocation exists.' },
{ key: 'ALLOCATION_CARRIES_OVER', label: 'Roll unused allocations into next period', type: 'bool',
  hint: 'When enabled, any remaining (allocated minus dispensed) quantity at period end is carried ' +
        'forward into the new period allocation rather than resetting to zero.' },
```

---

### Step 8 — `mediator/__tests__/allocations.test.js` (new file)

Test cases to cover:

| Case | Expected |
|---|---|
| Allocate to known VHW, SOH sufficient | 200, row created in `vhw_allocations` |
| Allocate to unknown VHW | 400 |
| Allocate to facility_worker | 400 |
| Allocate exceeds facility SOH | 422 insufficient-facility-stock |
| Dispense within allocation | passes, `dispensed_qty` incremented |
| Dispense exceeds allocation | rejected with `insufficient-allocation` |
| No allocation + `REQUIRE_VHW_ALLOCATION=false` | falls through to SOH check |
| No allocation + `REQUIRE_VHW_ALLOCATION=true` | rejected with `no-allocation` |

---

### Implementation order summary

```
Step 1  db.js              — table exists before anything else runs
Step 2  allocations.js     — new route file (depends on table)
Step 2b allocationStore.js — helper (depends on table)
Step 3  app.js             — wire route (depends on allocations.js)
Step 4  fanout.js          — enforcement (depends on allocationStore.js)
Step 5  runtimeConfig.js   — new flags (needed by fanout.js check)
Step 6  mappings.js        — UI (depends on endpoint)
Step 7  settings.js        — UI (depends on runtimeConfig keys)
Step 8  test file          — last, covers everything above
```

---

## Multi-facility behaviour and the per-VHW "Available" display

Two parts behave differently across facilities: the back-end (routing + deduction), which is
facility-aware everywhere, and the in-form Available number, which is not yet per-VHW.

### Back-end is facility-aware (works at every HC)

Each VHW carries its own facilityId in the mediator performer map (18 facilities). So for an
existing medicine allocated to a VHW at any health centre:

- A coordinator allocates to their own facility's VHWs; the allocation row stores that facility_id.
- On dispense, resolveIdentity reads the VHW's facilityId and debits that facility's OpenLMIS
  stock - not a shared or default facility. A Kolo VHW debits Kolo stock, not Emmause.
- checkAllocation and recordDispense are keyed by the practitioner, so the deduction hits the
  right VHW's budget.
- The allocated lot (FEFO) is debited at the VHW's facility, provided that lot is stocked there.

Requirement per HC: the medicine and the allocated lot must be stocked at that facility, or the
OpenLMIS debit fails. The seeded lots were posted across the facilities, but check stock per HC
before a demo.

### The in-form "Available" number is NOT yet per-VHW

The dispense form computes Available from an x-fhir-query variable, currently hardcoded:

```
Observation?_tag=loc-emmause
```

This cannot be made per-VHW just by editing the query, because:

- The app's resolver runs the x-fhir-query string raw (QuestXFhirQueryResolver) - it does not
  substitute "my location" or "my practitioner".
- The device sync brings down all VHWs' balance Observations, not just the owner's, so a constant
  query cannot isolate the owner.
- A location tag alone is ambiguous - each HC has two VHWs sharing one location.

So at any non-Emmause facility the number reads Emmause's (or blank). The dispense still works and
the server still enforces the real allocation; only the previewed number is wrong off-Emmause.

### Making Available correct at every facility (the plan)

Filter the globally-synced balances by the logged-in VHW's own practitioner id, using a value the
form can inject - a pre-populated hidden item - rather than a dynamic tag in the query.

1. Device knows its own practitioner id. PRACTITIONER_ID was "Not defined" because the mediator
   PractitionerDetail left fhirPractitionerDetails.id empty (the app writes that field to
   PRACTITIONER_ID, LoginViewModel.writePractitionerDetailsToShredPref). Now set in
   mediator/src/routes/practitionerDetail.js. After redeploy + re-login the device's
   practitioner-tag-id resolves to the real Practitioner id. Status: done, server-side, verifiable.

2. Pre-populate a hidden item with that id. Add a configRule to the dispense form's
   QuestionnaireConfig that computes practitionerId from the rules engine (it reads
   SharedPreferenceKey.PRACTITIONER_ID), and a hidden item whose initial value is that computed
   value.

3. Make the balance query global and the filter practitioner-aware. Set the %balances variable to a
   constant query (e.g. Observation?status=preliminary) and change the available
   calculatedExpression to match BOTH the medicine AND the practitioner tag:

   ```
   %balances.entry.resource.where(
     code.text = <selected medicine>
     and meta.tag.where(system='https://smartregister.org/practitioner-tag-id').code = <hidden practitioner item>
   ).component.where(code.text='Remaining').value.value.toInteger()
   ```

   The balance Observations already carry practitioner-tag-id, so this isolates the owner's row even
   with two VHWs per location.

Status: step 1 is done and verifiable (re-dispense, and the QR's practitioner-tag-id is the real id,
not "Not defined"). Steps 2-3 are app config + Questionnaire changes that need an app re-sync and
on-device testing; they share the fragile datacapture expression behaviour (a failed expression
crashes the form via the Timber %r bug, see project notes), so verify on-device before rollout.

Until steps 2-3 are in, keep the hardcoded loc tag pointed at whichever facility you demo the number
on; the allocation, FEFO and deduction are correct at every facility regardless.
