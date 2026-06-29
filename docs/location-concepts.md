# Location Concepts — BKM / Lesotho Health Stack

There is **no single "location" entity** in this stack. Three systems each model location
for their own domain, and the **mediator's mapping table** reconciles them. This is a
*federated / mediated* model (the OpenHIM pattern), **not** a single golden source that
everything is pulled from.

## The three concepts

| Concept | System (master) | Models | Used for |
|---|---|---|---|
| **Facility** (supply point) | **OpenLMIS** | A stock-holding point (clinic/warehouse) | Stock cards, lots, stock-on-hand, programs, orderables. A dispense/receipt **must** reference an OpenLMIS facility UUID. |
| **FHIR Location** (hierarchy) | **HAPI FHIR / OpenSRP** | District → clinic → **village/catchment** tree | Clinical/community: CHW catchments, care teams, patient panels, app navigation. |
| **Org unit** (reporting tree) | **DHIS2** | Reporting hierarchy | Aggregate analytics, dashboards, data values. |

Key point: **OpenLMIS masters *facilities*, but not the sub-facility clinical hierarchy
(villages/catchments) — those are FHIR — and not the reporting units — those are DHIS2.**
So even if OpenLMIS were treated as the facility master, villages still have to be
mastered in FHIR.

## Seeded identities (ATP profile)

| Place | OpenLMIS facility UUID | FHIR Organization / Location | DHIS2 org unit |
|---|---|---|---|
| Maseru District Clinic A | `28de536f-b826-4eeb-a3c4-d65221a1120d` | `maseru-clinic-a` / `loc-maseru-clinic-a` | `dwx1Yz4BwNX` |
| Maseru District Clinic B | `28de536f-b826-4eeb-a3c4-d65221a1120e` | `maseru-clinic-b` / `loc-maseru-clinic-b` | `MasClinicB1` |

FHIR Location tree: `loc-lesotho` → `loc-maseru-district` → `loc-maseru-clinic-{a,b}` →
villages (`loc-ha-mokoena`, `loc-ha-sehlabane`, `loc-matsieng`). Villages/catchments exist
**only** in FHIR — OpenLMIS and DHIS2 have no equivalent below the facility.

## How they are linked — the mediator mapping

Each staff/performer row in the mediator (`mappings.json` → live store) carries all three
location keys, so one dispense can be routed to the right place in every system:

```
performer:
  facilityId:    28de536f-…1120d   # OpenLMIS facility (stock)
  facilityName:  "Maseru District Clinic A"
  locationId:    loc-maseru-clinic-a   # FHIR Location (clinical)
  dhis2OrgUnit:  dwx1Yz4BwNX           # DHIS2 org unit (reporting)
```

On a dispense the mediator resolves the performer → reads these three keys → posts the
stock event to the **OpenLMIS facility**, the clinical event/observation to the **FHIR
location**, and the data value to the **DHIS2 org unit**. No system is queried as the
"master of locations"; the mapping is the source of alignment.

## Provisioning today vs. an OpenLMIS-master design

- **Today (federated, parallel-seeded):** `scripts/seed.sh` creates the facility in
  OpenLMIS, the Organization/Location in FHIR, and the org unit in DHIS2 **independently**
  with fixed IDs, then writes the mediator mapping that ties them together. Adding a new
  clinic means provisioning it in all three + adding the mapping.

- **OpenLMIS-master option (not implemented):** treat OpenLMIS as the facility master and
  *sync outward* — read OpenLMIS facilities and auto-provision the matching FHIR Location,
  DHIS2 org unit, and mediator mapping (similar to how `fhirLedger` already auto-creates
  commodity `Group`s in FHIR by name). Pros: one place to add a facility, no ID drift.
  Cons: more plumbing, and villages/catchments still must be mastered in FHIR (OpenLMIS
  has no sub-facility model). A pragmatic split is: **OpenLMIS = facility master, FHIR =
  sub-facility clinical hierarchy, DHIS2 = reporting units, mediator = reconciler.**

## Practical rules of thumb

- A dispense/receipt cannot reach OpenLMIS unless the **facility UUID exists in OpenLMIS**.
- Stock is tracked **per facility and per lot** in OpenLMIS — orderable-level SOH can be
  positive while a specific facility/lot is empty (see the lot-aware `checkStock`).
- Patient/CHW/village data is **FHIR's**, not OpenLMIS's — don't expect catchment villages
  in OpenLMIS.
- Reporting/analytics location is **DHIS2's org unit**, mapped from `dhis2OrgUnit`.
