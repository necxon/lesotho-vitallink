# Design: Per-Service-Point Stock — Promoting Villages to OpenLMIS Facilities

**Status:** ⛔ **SUPERSEDED (2026-06-16)** — *not* the chosen approach.
**Related / supersedes-this:** [roles-and-permissions-spec.md](roles-and-permissions-spec.md) · [location-concepts.md](location-concepts.md).

> **Superseded by the site-visit decision.** Service points are **NOT** promoted to OpenLMIS
> facilities. The chosen model is **one central OpenLMIS, one facility per health centre**,
> with **Store Manager + Coordinator as two roles on that single facility** (facility-scoped —
> a HC's users only access their own HC). The store→coordinator→VHW internal supply chain is
> **logical (mediator allocations/tasks)** within the one facility — **no facility-to-facility
> transfers**. Service points and VHW villages stay **FHIR Locations** (the hierarchy is kept
> for app navigation/geo). See `roles-and-permissions-spec.md` for the real model. This doc is
> retained only as a record of the rejected per-service-point-facility option.

## 1. Problem

Today, stock is held at the **facility (clinic)** level only. OpenLMIS has **no concept
below the facility** — the "service points" (villages / CHW catchments) exist **only as
FHIR `Location` resources**; OpenLMIS and DHIS2 have nothing under the clinic.

Consequence: you **cannot order or hold stock per service point**. An OpenLMIS
requisition/order is always `(facility + program + period)`. The closest current
mechanism is the mediator's **per-VHW allocation** (`vhw_allocations`) — a *logical*
split of the clinic's stock to each VHW (≈ each service point), but the real balance
stays at the clinic.

This doc describes promoting each service point to a **first-class OpenLMIS facility**
so stock balances and ordering can be genuinely per service point.

## 2. Current model (for reference)

```
loc-lesotho
└─ loc-maseru-district
   ├─ loc-maseru-clinic-a   ← OpenLMIS facility 28de…1120d  (holds ALL stock)
   │   ├─ loc-ha-mokoena     (FHIR only — service point)
   │   ├─ loc-ha-sehlabane   (FHIR only — service point)
   │   └─ loc-matsieng       (FHIR only — service point)
   └─ loc-maseru-clinic-b   ← OpenLMIS facility 28de…1120e
```

- **OpenLMIS** masters stock at the clinic. A dispense DEBITs the clinic.
- **FHIR** masters the village hierarchy. VHWs serve at villages (`PractitionerRole.location`).
- **Mediator** routes every VHW's dispense to the clinic's OpenLMIS facility.

## 3. Target model

Each village becomes its **own OpenLMIS facility** (a *requesting* supply point), and the
clinic becomes its **supplying facility** (warehouse).

```
loc-maseru-clinic-a   ← OpenLMIS facility (SUPPLYING / warehouse)
   ├─ Ha Mokoena       ← OpenLMIS facility (requesting)  ← thabo dispenses here
   ├─ Ha Sehlabane     ← OpenLMIS facility (requesting)  ← lineo
   └─ Matsieng         ← OpenLMIS facility (requesting)  ← mpho
```

## 4. The mapping (one service point across all systems)

The mediator ties one identity together per service point:

| Service point | OpenLMIS facility (NEW) | FHIR Location (exists) | DHIS2 org unit (NEW) | VHW |
|---|---|---|---|---|
| Ha Mokoena   | `fac-ha-mokoena`   `28de536f-…1130a` | `loc-ha-mokoena`   | `ouHaMokoena1` | thabo.mokoena |
| Ha Sehlabane | `fac-ha-sehlabane` `28de536f-…1130b` | `loc-ha-sehlabane` | `ouHaSehlab01` | lineo.nthabi |
| Matsieng     | `fac-matsieng`     `28de536f-…1130c` | `loc-matsieng`     | `ouMatsieng01` | mpho.lerotholi |
| **Clinic A** (supplying) | `28de536f-…1120d` (exists) | `loc-maseru-clinic-a` | `dwx1Yz4BwNX` | — |

(IDs above are illustrative, following the existing `28de536f-…112xx` scheme.)

## 5. OpenLMIS changes (per village)

All via DB inserts, mirroring how Clinic A is seeded (`scripts/seed.sh`):

1. **Facility** — `referencedata.facilities` row: id, code, name, geographic zone, facility
   type, `active=true`.
2. **Facility type** — either a new type `community_post`, or reuse `health_center`.
   Whatever the type, its **`facility_type_approved_products` (FTAP)** must list the
   program's orderables, or the village can't carry those medicines.
3. **Supported program** — `supported_programs` → Essential Medicines for each village.
4. **Requisition config** — village is a **member of a requisition group** under a
   **supervisory node**, so it can requisition.
5. **Supply line** — `supply_lines` row: `(program, supervisory node) → supplying facility =
   Clinic A`. This is what makes Clinic A fulfil the village's orders.
6. **Opening stock** — seed initial stock per village via stock events at the village facility.
7. **Rights** — the acting users (VHW / facility worker) need `STOCK_ADJUST`,
   `STOCK_CARDS_VIEW`, and (for ordering) `REQUISITION_*` scoped to the village facility
   (`right_assignments`).

## 6. Replenishment: how stock moves Clinic A → village

Two options. **Direct transfer is recommended** for this stack.

### Option A — OpenLMIS fulfilment (Tier 2) — *the "correct" OpenLMIS path*
Village requisition → SUBMITTED → AUTHORIZED → APPROVED → RELEASED → **Order** →
**Shipment** (clinic issues) → **Proof of Delivery** (village receives → stock credited).
- ✅ Native OpenLMIS, full audit trail.
- ⚠️ This is the **Tier-2 fulfilment flow that is not built** in BKM today; significant work.

### Option B — Direct stock transfer (recommended) — *reuses today's path*
On dispatch/acceptance, the mediator posts **two stock events**:
- **DEBIT** at Clinic A (issue), reason "Transfer out / Issued".
- **CREDIT** at the village facility (receipt), reason "Transfer in / Receipt".
- ✅ Reuses the existing `stockEvents` path; no Tier-2 machinery.
- ✅ Keeps the existing VHW-order → facility-worker-accept UX; just changes *which* facility
  is credited (village instead of clinic).
- ⚠️ Not a native OpenLMIS "transfer" object — it's two balanced events. Acceptable for BKM.

## 7. Mediator changes

- **Routing:** each VHW's performer mapping `facilityId` flips from the **clinic** to their
  **village facility** (e.g. thabo → `fac-ha-mokoena`). A dispense then DEBITs the village.
- **Ordering:** a VHW order becomes "village requests from clinic" → triggers the Option-B
  transfer (clinic DEBIT + village CREDIT) on facility-worker acceptance.
- **Allocation:** the per-VHW `vhw_allocations` layer becomes **largely redundant** —
  OpenLMIS now holds real per-village balances. Keep it only if a single village has
  multiple VHWs who each need a sub-budget.
- **Stock checks:** `checkStock` / `fhirLedger` already key on `facilityId`, so they work
  unchanged once the facility id is the village's.

## 8. DHIS2 changes

- Add a **DHIS2 org unit per village** under the clinic OU, so dashboards can break down
  dispensing/SOH by service point.
- Mediator `dhis2OrgUnit` per VHW → the village OU.
- Existing data elements/visualizations are reused; only the org-unit dimension gets finer.

## 9. FHIR changes (light)

- Village `Location` resources already exist. Add an **identifier linking each to its
  OpenLMIS facility id**, so the mapping is explicit and discoverable:
  ```json
  "identifier": [{ "system": "https://openlmis.org/facility-id",
                   "value": "28de536f-…1130a" }]
  ```
- `PractitionerRole.location` for each VHW already points at the village. ✓

## 10. Rollout

1. Seed the village **facilities + types + FTAP + supported programs + supply lines** (DB),
   gated behind a profile flag so the BKM/ATP single-facility demo is unaffected.
2. Seed village **DHIS2 org units** + opening stock.
3. Flip the mediator **performer→facility** mappings to the village facilities.
4. Implement **Option B** transfer on order acceptance (clinic DEBIT + village CREDIT).
5. (Optional) retire `vhw_allocations` or keep for multi-VHW villages.
6. Verify: dispense at a village DEBITs that village; an order replenishes it from the clinic;
   DHIS2 shows per-village figures.

## 11. Trade-offs

| | Allocation model (today) | Village-as-facility (this doc) |
|---|---|---|
| Per-service-point stock balance | ✗ (logical only) | ✅ real |
| Order per service point | ✗ | ✅ |
| OpenLMIS objects | few | N× facilities/types/FTAP/supply-lines/OUs |
| Replenishment | facility receipt + allocate | clinic→village transfer (Option B) or Tier 2 |
| Mediator allocation feature | core | mostly retired |
| Effort / risk | — | high |

## 12. Recommendation

If per-service-point stock is genuinely required, go **village-as-facility with Option B
(direct transfer)** — it delivers real per-village balances and ordering while reusing the
existing stock-event path and avoiding the unbuilt Tier-2 fulfilment. Treat the per-VHW
allocation as a lighter-weight alternative when physical per-village stock isn't needed.
