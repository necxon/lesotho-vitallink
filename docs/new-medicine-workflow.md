# Adding a New Medicine - End-to-End Workflow

How a medicine flows through the BKM stack, from registering it in OpenLMIS to a VHW
dispensing it on the Android device, and where it lands in the OpenSRP2 / FHIR backend.

A medicine is defined in several places. Some pick it up automatically; some are manual
config. This document lists exactly which is which, then gives the step-by-step.

## Where a medicine lives

| Place | What it holds | Auto or manual |
|---|---|---|
| OpenLMIS orderable | The stock item (product code, name, dispensable unit), stock-on-hand, lots | Manual (you register it) |
| Mediator orderable map | code -> orderable UUID lookup, refreshed from OpenLMIS | Auto |
| FHIR stock ledger (OpenSRP2) | A Group (the commodity) + an SOH Observation per facility Organization | Auto (on dispense / mediator restart) |
| Medicine alias | App display code -> orderable UUID (when they differ) | Manual |
| Dispense form (Questionnaire) | The dropdown of medicines a VHW can pick | Manual |
| DHIS2 element map | orderable -> DHIS2 data element (dispensed + SOH) | Manual |
| Lot map | orderable -> default lot UUID for the debit | Manual (or via allocation) |

## What happens automatically

### Mediator picks up the orderable
The mediator calls `GET /api/orderables` from OpenLMIS on startup and on a periodic refresh,
and rebuilds its in-memory lookup keyed by normalised product code
(`refreshOrderablesFromLMIS`, mediator/src/mappings/mappings.js). Within one refresh cycle the
new orderable is resolvable. `resolveOrderableId` (same file) resolves a dispense's medicine
code in this order:

1. explicit alias (`MEDICATION_MAP`, from the Medicine Aliases / mappings)
2. live OpenLMIS product-code match (`LMIS_ORDERABLE_MAP[normalizeCode(code)]`)
3. the `OPENLMIS_ORDERABLE_ID` env fallback

So if the app's medicine code equals the OpenLMIS product code (after normalising - hyphens
stripped, lowercased), it resolves with no alias. If the app sends a display name like
`Amoxicillin 250mg` while the product code is `AMOX250`, you need an alias (step 2).

Verify the refresh:
```bash
docker compose logs bkm-mediator | grep "orderable map refreshed"
# OpenLMIS orderable map refreshed (N products)
```

### FHIR stock ledger updates for the facility
On the next successful dispense (and on the mediator's startup ledger init), `syncOrderableToFhir`
(mediator/src/sync/fhirLedger.js) mirrors the OpenLMIS SOH into HAPI FHIR:

- maps the OpenLMIS facility to its HAPI Organization (the mediator facility map)
- finds the commodity Group by the app code / OpenLMIS name, and if none exists it
  auto-creates a Group named after the OpenLMIS product ("so new medicines appear in the
  Stock-by-Facility view automatically")
- upserts an SOH Observation for that Group against the facility Organization

So the new medicine's stock shows up in the OpenSRP2 / FHIR backend for the correct facility
on its own - you do not hand-create a FHIR Medication or Group. The only prerequisite is that
the facility is in the mediator's facility -> Organization map (true for all seeded facilities).

Note: this syncs the stock LEDGER (what's on hand). It does not add the medicine to the VHW's
dispense dropdown - that is the Questionnaire, which is manual (step 3).

## What you must configure manually

### 1. Register and stock the orderable in OpenLMIS
- Administration -> Products -> Orderables -> Add
  - Product code: short uppercase, ideally matching the app code (e.g. `VITC500`)
  - Full product name: human-readable (e.g. `Vitamin C 500mg`)
  - Dispensable: the unit (e.g. `each`)
- Assign it to the Essential Medicines program
- Create a lot and post a receipt (CREDIT) so it has stock-on-hand at each facility that needs it.
  A dispense against a lot with no stock will fail (OpenLMIS rejects it).

Local: http://localhost:8082  Prod: https://lmis.lesotho-bkm.xyz

### 2. Add a medicine alias (only if app code != product code)
Maps the code the app sends to the orderable UUID.

- bkm-web -> Medicine Aliases (`#/medications`) - add the alias there (preferred), or
- OpenHIM console -> Mediators -> Vital-Link -> Config -> Medication Mappings:
  ```json
  { "sourceId": "Vitamin C 500mg", "orderableId": "<openlmis-orderable-uuid>" }
  ```

Without this, a dispense whose code does not match the product code resolves to the env-default
orderable (wrong) or errors.

### 3. Add the medicine to the dispense form
The medicines a VHW can pick are a fixed list of `answerOption`s in
`Questionnaire/patient-dispense-medicine` (not generated from OpenLMIS). Add the new option:

```bash
# pull, edit, push
curl https://fhir.lesotho-bkm.xyz/fhir/Questionnaire/patient-dispense-medicine > q.json
# add to item[linkId=medication].answerOption:
#   { "valueCoding": { "code": "Vitamin C 500mg", "display": "Vitamin C 500mg" } }
curl -X PUT https://fhir.lesotho-bkm.xyz/fhir/Questionnaire/patient-dispense-medicine \
  -H 'Content-Type: application/fhir+json' -d @q.json
```

The option `code` must be the value `resolveOrderableId` can resolve (the alias key from step 2,
or the product code). The app picks up the updated form on its next sync (no APK rebuild).

### 4. Add DHIS2 reporting and the lot default
These are env maps on the mediator (docker-compose.yml). Editing them needs a mediator restart.

- DHIS2 data element: create the data element(s) in DHIS2, then add the orderable to:
  - `DHIS2_ORDERABLE_DE_MAP`     (orderable UUID -> dispensed data element)
  - `DHIS2_ORDERABLE_SOH_DE_MAP` (orderable UUID -> stock-on-hand data element)
  Without these the dispense still works but does not report to DHIS2 for that medicine.
- Default lot: add the orderable to `OPENLMIS_LOT_MAP` (orderable UUID -> lot UUID). This is the
  lot the dispense debits when the VHW has no allocation carrying a lot. For FEFO, prefer
  allocating the medicine to the VHW with the soonest-expiring lot (see below) - the allocation
  lot overrides the env default.

```bash
docker compose up -d bkm-mediator   # restart to load the new env maps
```

### 5. (Optional) allocate it to a VHW
For the per-VHW allocation + FEFO story, allocate the medicine to the VHW in
bkm-web -> Staff Management. The chosen lot is recorded on the allocation and drives the dispense
debit (FEFO option B), and the dispense deducts from the VHW's remaining budget. If
`REQUIRE_VHW_ALLOCATION` is not set, a VHW can still dispense any stocked medicine without an
allocation - it just debits facility stock with no per-VHW deduction.

## Step summary

| Step | System | Auto? |
|---|---|---|
| Register orderable + stock + lot | OpenLMIS | No |
| Orderable resolvable in mediator | Mediator (refresh) | Yes (<= 1 refresh cycle) |
| SOH appears in FHIR per facility | Mediator -> HAPI | Yes (on dispense / restart) |
| Add alias (if code differs) | bkm-web Medicine Aliases | No |
| Add to dispense dropdown | HAPI Questionnaire | No |
| DHIS2 element + maps | DHIS2 + mediator env | No |
| Default lot map | mediator env | No (or via allocation) |
| Allocate to VHW (optional) | bkm-web Staff Management | No |
| App shows new medicine | Android sync | Yes (next sync) |

## Verification

```bash
# orderable resolves in the mediator
docker compose logs bkm-mediator | grep "orderable map refreshed"

# stock is present at the facility (per lot)
# GET /api/stockCardSummaries?facility=<id>&program=<id>  (Bearer token via /lmis-token)

# after a test dispense, the FHIR ledger updated for the facility
docker compose logs bkm-mediator | grep "FHIR ledger updated"
```

## Rollback

- Remove the option from the dispense Questionnaire and PUT it back - the app drops it on next sync.
- Removing the orderable from OpenLMIS does not remove it from the app form; the two are independent.

## Why this is multi-step

A medicine currently touches OpenLMIS, the alias, the dispense form, and the DHIS2 / lot env maps.
The orderable map and the FHIR stock ledger auto-follow OpenLMIS; the rest is manual config.
Collapsing the alias + form + env maps into one source is the "single-source medicine mapping"
item in the backlog.

## Code references

- mediator/src/mappings/mappings.js - `refreshOrderablesFromLMIS`, `resolveOrderableId`, `canonicalMed`
- mediator/src/sync/fhirLedger.js - `syncOrderableToFhir`, `initFromOpenLmis` (auto Group + SOH)
- mediator/src/sync/fanout.js - `resolveIdentity` (orderable/program/lot), allocation gate + deduction
- mediator/src/allocations/allocationStore.js - per-VHW allocation + FEFO lot
- Questionnaire/patient-dispense-medicine (HAPI) - the dispense dropdown
- docker-compose.yml - `OPENLMIS_LOT_MAP`, `DHIS2_ORDERABLE_DE_MAP`, `DHIS2_ORDERABLE_SOH_DE_MAP`
