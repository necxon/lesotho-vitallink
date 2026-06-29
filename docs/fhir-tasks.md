# FHIR Tasks in the Lesotho Sandbox

### 1. Tasks are standard FHIR Task resources on HAPI FHIR

Tasks are stored on the HAPI FHIR server (port 8079) as standard R4 `Task` resources.
They can be created via the REST API. This sandbox uses `PUT /Task/{id}` (not `POST`)
so that seeded task IDs are stable and the operation is idempotent.

**Example — seeding two pending tasks (scripts/seed.sh ~line 1553):**

```python
fhir_put("Task", "task-pending-001", {
    "resourceType": "Task",
    "id":           "task-pending-001",
    "status":       "requested",
    "intent":       "order",
    "code": {"coding": [{"system": "http://snomed.info/sct",
                         "code": "373748001", "display": "Stock Issue"}]},
    "description":  "AL 20/120mg — 120 units (ref: LMIS-2026-001)",
    "for":   {"reference": "Practitioner/opensrp-admin"},
    "owner": {"reference": "Practitioner/opensrp-admin"},
    "authoredOn": "2026-03-10T08:00:00Z",
    "input": [
        {"type": {"text": "product"},   "valueString":  "AL-20-120"},
        {"type": {"text": "quantity"},  "valueInteger": 120},
        {"type": {"text": "issueRef"},  "valueString":  "LMIS-2026-001"},
    ]
})
```

**Via curl after the stack is running:**

```bash
curl -X PUT http://localhost:8079/fhir/Task/task-pending-001 \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "Task",
    "id": "task-pending-001",
    "status": "requested",
    "intent": "order",
    "code": {"coding": [{"system":"http://snomed.info/sct","code":"373748001","display":"Stock Issue"}]},
    "description": "AL 20/120mg — 120 units (ref: LMIS-2026-001)",
    "for":   {"reference": "Practitioner/opensrp-admin"},
    "owner": {"reference": "Practitioner/opensrp-admin"},
    "authoredOn": "2026-03-10T08:00:00Z",
    "input": [
      {"type":{"text":"product"},  "valueString":  "AL-20-120"},
      {"type":{"text":"quantity"}, "valueInteger": 120},
      {"type":{"text":"issueRef"}, "valueString":  "LMIS-2026-001"}
    ]
  }'
```

---

### 2. The mediator creates Tasks programmatically

When eLMIS issues stock, the mediator's `/fhir/SupplyDelivery` route calls
`createStockTask()` which PUTs a new Task on HAPI FHIR.

**mediator/index.js ~line 714:**

```javascript
async function createStockTask({ performer, medication, quantity, issueRef, taskId }) {
  const id = taskId || `task-stock-${Date.now()}`;
  const task = {
    resourceType: 'Task',
    id,
    status:   'requested',
    intent:   'order',
    code: {
      coding: [{ system: 'http://snomed.info/sct', code: '373748001', display: 'Stock Issue' }]
    },
    description: `${medication} — ${quantity} units (ref: ${issueRef || id})`,
    for:   { reference: `Practitioner/${performer}` },
    owner: { reference: `Practitioner/${performer}` },
    authoredOn: new Date().toISOString(),
    input: [
      { type: { text: 'product'  }, valueString:  medication },
      { type: { text: 'quantity' }, valueInteger: quantity   },
      { type: { text: 'issueRef' }, valueString:  issueRef || id }
    ]
  };
  const res = await axios.put(`${CONFIG.fhir.url}/Task/${id}`, task, {
    headers: { 'Content-Type': 'application/fhir+json' },
    timeout: TIMEOUT_MS
  });
  return res.data;
}
```

**Trigger the route directly:**

```bash
curl -X POST http://localhost:5001/fhir/SupplyDelivery \
  -H 'Content-Type: application/json' \
  -d '{"performer":"opensrp-admin","medication":"AL-20-120","quantity":60,"issueRef":"LMIS-2026-TEST"}'
```

---

### 3. The app syncs Tasks on startup/connectivity (not strictly "on login")

The sync configuration declares an `owner` SearchParameter scoped to `Task`, which tells the
OpenSRP Android app which Tasks to pull for the logged-in user.

**config/fhir/sync_config.json lines 53–63:**

```json
{
  "resource": {
    "resourceType": "SearchParameter",
    "name": "owner",
    "code": "owner",
    "base": ["Task"],
    "type": "reference",
    "expression": "#owner"
  }
}
```

`Task` also appears in the shared `_count` SearchParameter (sync_config.json lines ~143–154)
alongside `Patient`, `CarePlan`, `Questionnaire`, `Group`, etc. — confirming it is part of
the standard sync bundle fetched when the app comes online.

Device-to-device sync is also configured (**config/fhir/application_config.json**):

```json
"deviceToDeviceSync": {
  "resourcesToSync": ["Group", "Patient", "CarePlan", "Task", "Encounter", "Observation", ...]
}
```

---

### 4. Users complete tasks by filling a form (Questionnaire), which syncs back

The stock acceptance register (`stockAcceptanceRegister`) shows open Tasks and exposes
an **Accept** button that launches the `qn-stock-accept` Questionnaire.
Submitting that form creates a `QuestionnaireResponse` and marks the Task `completed`.

**config/fhir/registers/stock_acceptance_register_config.json — service button:**

```json
"serviceButton": {
  "visible": true,
  "text": "Accept",
  "status": "DUE",
  "questionnaire": {
    "id": "qn-stock-accept",
    "title": "Accept Stock",
    "saveButtonText": "CONFIRM ACCEPTANCE",
    "resourceIdentifier": "@{taskId}"
  },
  "params": [
    {
      "paramType": "PREPOPULATE",
      "linkId": "task_id",
      "dataType": "STRING",
      "key": "taskId",
      "value": "@{taskId}"
    }
  ]
}
```

When the `QuestionnaireResponse` is submitted to `POST /fhir/QuestionnaireResponse`,
the mediator:

1. Validates the referenced Task is still `status=requested` (BR-04 duplicate-acceptance guard)
2. Sends the acceptance to eLMIS (stockmanagement)
3. Pushes updated Stock-on-Hand to DHIS2
4. Marks the Task `completed` so it disappears from the register

**mediator/index.js ~line 759:**

```javascript
async function completeStockTask(taskId) {
  const task = await fetchStockTask(taskId);
  if (!task) { return; }
  task.status = 'completed';
  task.lastModified = new Date().toISOString();
  await axios.put(`${CONFIG.fhir.url}/Task/${taskId}`, task, {
    headers: { 'Content-Type': 'application/fhir+json' },
    timeout: TIMEOUT_MS
  });
}
```

---

## Two-stage dispense — planned extension

The current flow (above) is **single-stage**: eLMIS issues stock → Task appears on VHW device → VHW accepts → OpenLMIS DEBIT.  
There is no way to tell how much of that accepted stock was actually dispensed to patients vs still in the VHW's bag.

A planned extension introduces a second stage:

```
Stage 1 — Facility Worker pre-dispenses to a specific VHW
    POST /fhir/SupplyDelivery  (medicine committed, OpenLMIS DEBIT)
         │
         ▼
    SupplyDelivery  status=in-progress  (visible to VHW on Android)
         │
Stage 2a — VHW accepts on Android
    PUT  /fhir/SupplyDelivery/{id}  status=completed
         │  mediator records received_qty in vhw_stock table
         ▼
    VHW on-hand balance tracked in Postgres
         │
Stage 2b — VHW dispenses to patient (same as today)
    POST /fhir/MedicationDispense   status=completed
         │  mediator checks vhw_stock balance, increments dispensed_qty
         ▼
    Patient receives medicine
```

**Why it matters:**
- Facility worker can see exactly how much each VHW received, dispensed, and still holds
- Dispense validation checks VHW's personal on-hand balance, not the shared facility pool
- Creates an audit trail of physical custody transfer (VHW signed for it on device)

**Task status mapping with two-stage:**

| Stage | Task status | Meaning |
|---|---|---|
| SupplyDelivery created | `requested` | Medicine prepared, awaiting VHW acceptance |
| SupplyDelivery accepted | `accepted` | VHW confirmed receipt on device |
| MedicationDispense completed | `completed` | Medicine dispensed to patient |

**Key difference from current flow:** Today `requested → completed` skips `accepted`. Two-stage adds the `accepted` intermediate state so the facility worker can distinguish "prepared but not yet picked up" from "picked up but not yet dispensed".

See [two-stage-dispense.md](two-stage-dispense.md) for the full design including FHIR resource structure, Postgres schema, mediator code change locations, and runtime config flags.

---

## What the original statement got wrong

| Claim | Reality in this sandbox |
|---|---|
| "POST request to /Task endpoint" | This sandbox uses `PUT /Task/{id}` for idempotent creation with stable IDs |
| "integrated into care plans" | Tasks here are **stock workflow** objects, not linked to `CarePlan` resources |
| "statuses: active, due, overdue, expired" | Only `requested` → `completed` is used. `DUE` appears in the register card UI config as a display-only status label, not a FHIR status value |
| "sync triggered on login" | Sync is triggered by app connectivity and activity. Login often coincides but is not the mechanical trigger |

---

## Task lifecycle in this sandbox

```
eLMIS issues stock
       │
       ▼
POST /fhir/SupplyDelivery (mediator)
       │
       ▼
PUT /fhir/Task/{id}  status=requested  ← visible in stockAcceptanceRegister
       │
       ▼  (CHW opens app, syncs, sees Task, fills qn-stock-accept form)
       │
       ▼
POST /fhir/QuestionnaireResponse (mediator)
  ├── BR-04: check Task.status == requested (reject if already completed)
  ├── POST eLMIS stockEvent (DEBIT/Consumed)
  ├── pushSohToDHIS2 (triggeredBy: Task/{id})
  └── PUT /fhir/Task/{id}  status=completed  ← disappears from register
```

---

## Where to find the code

| What | File | Line(s) |
|---|---|---|
| Seed Tasks (PUT) | [scripts/seed.sh](../scripts/seed.sh) | ~1553–1611 |
| `createStockTask()` | [mediator/index.js](../mediator/index.js) | ~714–740 |
| `completeStockTask()` | [mediator/index.js](../mediator/index.js) | ~759–773 |
| BR-04 duplicate guard | [mediator/index.js](../mediator/index.js) | ~931–946 |
| Stock acceptance register | [config/fhir/registers/stock_acceptance_register_config.json](../config/fhir/registers/stock_acceptance_register_config.json) | full file |
| Task register | [config/fhir/registers/task_register_config.json](../config/fhir/registers/task_register_config.json) | full file |
| Sync SearchParameter (owner) | [config/fhir/sync_config.json](../config/fhir/sync_config.json) | 53–63 |
| Accept stock questionnaire | [scripts/seed.sh](../scripts/seed.sh) | ~1509–1529 |
