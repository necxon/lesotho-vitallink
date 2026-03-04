# OpenLMIS Stock Management

How to view, create, and verify stock cards in the sandbox.

---

## Prerequisites

The stack must be running and seeded:

```bash
make start   # docker compose up -d
make seed    # re-run after every stack restart (flyway wipes referencedata on restart)
```

> **Important:** OpenLMIS `referencedata` sets `flyway.clean=true`, meaning its entire
> database (facilities, programs, orderables) is wiped on every container restart.
> Always run `bash scripts/seed.sh` (or `make seed`) before working with stock.

---

## Fixed IDs (stable across re-seeds)

| Resource | Name | UUID |
|----------|------|------|
| Facility | Maseru District Clinic A | `28de536f-b826-4eeb-a3c4-d65221a1120d` |
| Program | Essential Medicines | `31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c` |
| Orderable | AL 20/120mg | `3be1d20f-6aa9-4e52-864f-4fa04aa02056` |
| Reason (CREDIT) | Receipts | `313f2f5f-0c22-4626-8c49-3554ef763de3` |
| Reason (DEBIT) | Consumed | `b5c27da7-bdda-4790-925a-9484c5dfb594` |
| Trade Item | Novartis / AL 20/120mg | `eeeeeeee-0000-0000-0000-000000000001` |
| Lot | AL-LOT-2026 (exp 2028-12-31) | `ffffffff-0000-0000-0000-000000000001` |

> **UI note:** The OpenLMIS SPA uses `/api/v2/stockCardSummaries` which requires:
> 1. The orderable has a trade item + lot
> 2. Stock events are posted **with a `lotId`**
> 3. `facility_type_approved_products` entry exists for the facility type + program + orderable
>
> All three are seeded by `seed.sh`. The mediator fan-out (lot-less) still works via v1.

---

## Get an OAuth token

All OpenLMIS API calls require a user bearer token (not a service-account token —
`stock_events.userid` is NOT NULL):

```bash
TOKEN=$(curl -sf -u user-client:changeme \
  -d "grant_type=password&username=admin&password=password" \
  http://localhost:8082/api/oauth/token \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['access_token'])")
```

---

## Create a stock event (receipt / dispense)

A stock card is auto-created by OpenLMIS on the **first** stock event posted for an
orderable at a given facility + program. Subsequent events append line items to the
same card.

### Receipt (CREDIT — adds stock)

```bash
curl -s -X POST http://localhost:8082/api/stockEvents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "facilityId": "28de536f-b826-4eeb-a3c4-d65221a1120d",
    "programId":  "31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c",
    "lineItems": [{
      "orderableId":     "3be1d20f-6aa9-4e52-864f-4fa04aa02056",
      "quantity":        500,
      "occurredDate":    "2026-03-04",
      "reasonId":        "313f2f5f-0c22-4626-8c49-3554ef763de3",
      "documentationNo": "MANUAL-RECEIPT-001"
    }]
  }'
```

Returns the UUID of the new stock event on success (e.g. `"21c95c82-..."`).

### Dispense (DEBIT — consumes stock)

Same body, different `reasonId`:

```bash
"reasonId": "b5c27da7-bdda-4790-925a-9484c5dfb594"
```

---

## Check stock on hand

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8082/api/stockCardSummaries?facility=28de536f-b826-4eeb-a3c4-d65221a1120d&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c&orderable=3be1d20f-6aa9-4e52-864f-4fa04aa02056" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['content'][0]['stockOnHand'])"
```

---

## Via the fan-out (OpenHIM → mediator → OpenLMIS)

The normal sandbox flow posts a `MedicationDispense` FHIR resource through OpenHIM,
which the mediator fans out to both OpenLMIS (stock DEBIT) and DHIS2 (data value):

```bash
curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType": "MedicationDispense",
    "status":       "completed",
    "subject":      {"reference": "Patient/patient-001"},
    "performer":    [{"actor": {"reference": "Practitioner/opensrp-admin"}}],
    "medicationCodeableConcept": {"coding": [{"code": "AL-20-120"}]},
    "whenHandedOver": "2026-03-04T09:00:00Z",
    "quantity":     {"value": 6, "unit": "tablet"}
  }'
```

Expected response:

```json
{"status": "Successful", "results": {"eLMIS": "OK", "DHIS2": "OK"}}
```

---

## View in the OpenLMIS UI

1. Open [http://localhost:8082](http://localhost:8082)
2. Log in as `admin` / `password`
3. Navigate directly to:
   - **Stock on Hand**: `http://localhost:8082/#!/stockmanagement/stockCardSummaries`
   - **Physical Inventory**: `http://localhost:8082/#!/stockmanagement/physicalInventory`
   - **Adjustments**: `http://localhost:8082/#!/stockmanagement/adjustment`

---

## Add a new orderable (new stock card)

To track a commodity not yet in the system:

**Step 1 — seed the orderable** (direct DB insert; API PUT ignores supplied UUID):

```bash
NEW_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # choose a stable UUID
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -c "
  INSERT INTO referencedata.orderables
    (id, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
  VALUES
    ('${NEW_ID}', 'My New Drug', 0, 1, 'MY-DRUG', false,
     'aaaaaaaa-0000-0000-0000-000000000001')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO referencedata.program_orderables
    (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, programid)
  VALUES
    (gen_random_uuid(), true, 2, true,
     'a1b2c3d4-e5f6-4a7b-8c9d-000000000001',
     '${NEW_ID}',
     '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c')
  ON CONFLICT DO NOTHING;"
```

**Step 2 — add the medication code mapping** in `mediator/index.js` (the `COMMODITY_MAP`), then post the first stock event using the curl above with your new `orderableId`.

---

## Run the full e2e test suite

```bash
bash scripts/e2e-test.sh           # 41 tests covering all legs
bash scripts/e2e-test.sh --verbose # show raw API responses
```
