# Spec: BKM Roles & Permissions (post site-visit)

**Status:** Spec (approved 2026-06-16; replaces `vhw / facility_worker / supervisor`).
**Related:** [service-point-facilities.md](service-point-facilities.md) · [roles & grouping](../docs/) · `mediator/src/routes/allocations.js`, `users.js`, `questionnaire.js`.

## 1. Overview

Three roles, one per tier of a four-link supply chain:

```
Supplier ──external──▶ Store Manager (Health Centre store room)
                         │  dispatch / internal
                         ▼
                       Coordinator (Service Point = OpenLMIS facility, links to BKM)
                         │  allocate / internal
                         ▼
                       VHW (under a Service Point) ──▶ Patient (dispense)
```

- **Store Manager** — the Health Centre store. External supply chain + clinic stock + order approval. **Web only.**
- **Coordinator** — owns a **Service Point** (now its own OpenLMIS facility). Internal supply chain + the bridge to BKM. **Web + mobile.**
- **VHW** — works under a Service Point. Last-mile: accept internal stock + dispense. **Mobile only.**

Decisions: Service Points **are OpenLMIS facilities** (per service-point-facilities.md); the clinic store is their **supplying** facility. These roles **replace** the old three across **Keycloak, OpenLMIS rights, mediator workflow, and app/portal**.

## 2. Canonical capability matrix

| # | Capability | Store Manager | Coordinator | VHW |
|---|---|:---:|:---:|:---:|
| 1 | Place new order | ✅ | ✅ | ❌ |
| 2 | Edit pending order | ✅ | ✅ | ❌ |
| 3 | Mediator WEB (bkm-web portal) | ✅ | ✅ | ❌ |
| 4 | Reject order | ✅ | ❌ | ❌ |
| 5 | Accept / approve order | ✅ | ❌ | ❌ |
| 6 | Change order | ✅ | ✅ | ❌ |
| 7 | Update allocated stock | ✅ | ✅ | ✅ |
| 8 | Dispatch to Coordinator | ✅ | ❌ | ❌ |
| 9 | Dispense patient | ❌ | ❌ | ✅ |
| 10 | External requisition (→ supplier) | ✅ | ❌ | ❌ |
| 11 | Internal requisition (→ store) | ❌ | ✅ | ❌ |
| 12 | Accept internal stock | ❌ | ✅ | ✅ |
| 13 | Accept stock from supplier | ✅ | ❌ | ❌ |
| 14 | LMIS access (OpenLMIS UI) | ✅ | ✅ | ❌ |
| 15 | Can use BKM mobile app | ❌ | ✅ | ✅ |
| 16 | Receives task events on BKM | ❌ | ❌ | ✅ |

## 3. Capability → mechanism mapping

Each capability resolves to a concrete control in one or more layers. **Status:** ✓ exists · ~ partial · ✦ new.

| Capability | How it's enforced | Layer(s) | Status |
|---|---|---|---|
| Place new order | mediator order route (`POST /aggregate` order / QR `type=ORDER`); portal Order Gate | mediator + web | ~ (VHW-order exists; re-scope to Store/Coord) |
| Edit pending order | portal edits buffered order before dispatch; mediator `order_buffer` update | web + mediator | ✦ |
| Mediator WEB | KC realm role gates **portal login** + page RBAC (bkm-web reads roles) | KC + web | ✓ |
| Reject order | order-approval state → `rejected`; mediator route + portal button | mediator + web | ✦ |
| Accept / approve order | order-approval state → `approved` → dispatchable | mediator + web | ✦ |
| Change order | edit quantities during approval | web + mediator | ✦ |
| Update allocated stock | `vhw_allocations` upsert + OpenLMIS `STOCK_ADJUST` | mediator + OpenLMIS | ✓ (allocate exists) |
| Dispatch to Coordinator | **internal transfer**: DEBIT clinic-store facility + CREDIT service-point facility (two stock events) | mediator | ✦ |
| Dispense patient | QR dispense → DEBIT the VHW's service-point facility; allocation deduct | mediator + app | ✓ |
| External requisition | OpenLMIS requisition, clinic facility → supplier (`REQUISITION_*`) | OpenLMIS | ✓ (Tier-1 requisition) |
| Internal requisition | service-point facility requisitions from clinic store (clinic = supplying facility) | OpenLMIS + mediator | ✦ |
| Accept internal stock | accept transfer Task → CREDIT receiving facility/allocation | mediator + app | ~ (FW-accept exists; re-scope) |
| Accept stock from supplier | accept external receipt → CREDIT clinic store | mediator / OpenLMIS POD | ~ |
| LMIS access | **direct login to the central OpenLMIS UI**, scoped to the user's own facility (Store Mgr + Coordinator only; VHW none) | OpenLMIS | ✓ |
| Can use BKM mobile app | KC `MANAGE_*` resource roles + `FIELD_WORKER` (FHIR Core needs these) | KC | ✓ |
| Receives task events | FHIR `Task` owned by the practitioner; app task register | mediator + app | ✓ |

## 4. Role definitions across the four layers

### 4a. Keycloak realm roles (login + RBAC)
Replace `facility_worker` / `supervisor` (keep `vhw`):

| KC role | Portal login | Mobile login | Extra KC roles needed |
|---|---|---|---|
| `store_manager` | ✅ | ❌ | (web RBAC only) |
| `coordinator` | ✅ | ✅ | `MANAGE_*` set + `FIELD_WORKER` (for mobile/FHIR Core) |
| `vhw` | ❌ | ✅ | `MANAGE_*` set + `FIELD_WORKER` |

- The `MANAGE_<Resource>` set + `ALL_EVENTS` + `OPENMRS` are what FHIR Core needs to sync — **mobile users (`coordinator`, `vhw`) must have them**; `store_manager` (web-only) does not.
- Update `config/keycloak/opensrp-realm.json` (fresh import) **and** patch live via Admin API (prod KC persists) — the existing dual pattern.

### 4b. OpenLMIS rights (scoped per facility)
All three are scoped to **their own health-centre facility** (the single HC facility) — never another HC's.

| Role | Facility scope | Rights |
|---|---|---|
| `store_manager` | the HC facility | `STOCK_CARDS_VIEW`, `STOCK_ADJUST`, `STOCK_INVENTORIES_EDIT`, `REQUISITION_CREATE/AUTHORIZE/APPROVE/DELETE/VIEW`, `ORDERS_*` |
| `coordinator` | the HC facility | `STOCK_CARDS_VIEW`, `STOCK_ADJUST`, `REQUISITION_CREATE/VIEW` (internal requests) |
| `vhw` | the HC facility (allocation level) | `STOCK_CARDS_VIEW`, `STOCK_ADJUST` (to write off / expire its own allocation; mediator scopes the adjust to the VHW's allocation) |

Seeded via `right_assignments` (the denormalized cache) + `role_assignments`, exactly like today's Stock Supervisor seeding.

### 4c. Mediator workflow role (`role:` on each performer mapping)
`mappings.json` performer `role` ∈ `{ store_manager, coordinator, vhw }`. Drives the gates in `questionnaire.js` / `allocations.js`:
- order placement: `store_manager`, `coordinator`
- order approve/reject: `store_manager`
- dispatch-to-coordinator (internal transfer): `store_manager`
- internal requisition: `coordinator`
- accept internal stock: `coordinator`, `vhw`
- dispense: `vhw`

Each performer also carries its **facilityId** (the store, a service point, or — for a VHW — the service-point facility it sits under).

### 4d. App / portal access
- **bkm-web portal**: visible to `store_manager` + `coordinator`; pages filtered by capability (e.g. only `store_manager` sees Approve/Reject).
- **BKM mobile (FHIR Core)**: `coordinator` + `vhw`; PractitionerDetail + `MANAGE_*` roles required (the per-VHW PractitionerDetail mechanism already built).
- **Task events**: `vhw` (and optionally `coordinator`) receive FHIR Tasks (accept-internal-stock, delivery) in the app task register.

## 5. Service-point / requisition integration

This role set requires the **village-as-facility** model:
- **Clinic store** = supplying OpenLMIS facility (Store Manager).
- **Service point** = requesting OpenLMIS facility (Coordinator); supply line → clinic store.
- **External requisition** = clinic store → supplier (OpenLMIS requisition).
- **Internal requisition** = service point → clinic store (OpenLMIS requisition with clinic as supplying facility) — fulfilled by **dispatch-to-coordinator** = the **direct stock transfer** (DEBIT store + CREDIT service point), per service-point-facilities.md Option B.
- **VHW** stock = an **allocation** under the service-point facility (Coordinator allocates; VHW "accepts internal stock" + dispenses, deducting the allocation). So `vhw_allocations` is **retained** at the VHW level (it is *not* retired here — only the clinic-level split moves into real per-service-point facility stock).

## 6. Migration from the old roles

| Old | New | Action |
|---|---|---|
| `supervisor` | `store_manager` | rename/remap; move clinic-store rights + add approve/reject |
| `facility_worker` | `store_manager` **or** `coordinator` | decide per user (store vs service point) |
| `vhw` | `vhw` | keep; ensure `MANAGE_*` + `FIELD_WORKER` + service-point facility |

Per user: update KC roles, OpenLMIS `right_assignments`, the mediator performer `role` + `facilityId`, and (mobile users) PractitionerDetail. Existing users `fw.clinic.a/b`, `supervisor`, `thabo.mokoena`, `vhw.clinic.b` get remapped accordingly. **Remove** the old realm roles after migration.

## 7. Gaps to build (the ✦ items)

1. **Order approval workflow** — reject / accept-approve / change states on the mediator order (today's order path has no approval gate). Portal buttons + mediator routes + state on `order_buffer`.
2. **Internal vs external requisition** — distinguish and route: external → supplier; internal → clinic store (drives the transfer).
3. **Dispatch-to-coordinator transfer** — DEBIT store + CREDIT service-point facility (Option B), with an "Accept internal stock" Task for the Coordinator.
4. **Coordinator tier** — new role end-to-end (KC, OpenLMIS facility ownership, web + mobile, mediator gates).
5. **Service-point facilities** — the whole village-as-facility build (separate doc).
6. **Edit pending order** — pre-dispatch order editing in the portal.

## 8. Phased rollout

1. **Roles & access (no supply-chain change):** define `store_manager / coordinator / vhw` in KC + portal RBAC + mediator role gates; remap users. (Lets the UI/permissions land first.)
2. **Service points as facilities:** seed service-point OpenLMIS facilities + supply lines (service-point-facilities.md).
3. **Internal transfer + accept:** dispatch-to-coordinator (store→SP) + accept-internal Task.
4. **Order approval workflow:** reject / approve / change / edit-pending.
5. **External + internal requisition** wired to OpenLMIS.
6. Verify against the matrix per role.

## 9. Resolved decisions (site visit)

1. **VHW "update allocated stock" = view + dispense + adjust.** A VHW can adjust their own
   allocation (e.g. write off expired stock), not just view. → VHW gets `STOCK_ADJUST` scoped
   to its allocation (mediator-enforced) on top of dispense.
2. **Store Manager approves both** internal (Coordinator) **and** external (supplier) orders.
   Coordinator never approves.
3. **One BKM service point per facility.** A health centre may physically have several service
   points, but **only the BKM/OpenSRP one is modelled** — it becomes the single service-point
   OpenLMIS facility, owned by one Coordinator. Other service points are out of scope.
4. **Same role set across facility types** (Hospital / Clinic / Centre) — they differ only as
   OpenLMIS facility *types*, not in the role/permission model.

### Resulting topology (per health centre)
**One central OpenLMIS instance** (production) — *not* one per health centre. Each health
centre is **one facility within that central instance**, and isolation is by **facility-scoped
rights**: a user's home facility + `right_assignments` scoped per `facilityid` mean a HC's
users can only see/act on **their own** facility's stock — never another HC's. ("Each facility
accesses its health centre" = right-scoping on the shared OpenLMIS, not separate databases.)

Within a health centre's one facility, it orders and holds its own stock, and Store Manager
and Coordinator are **two roles on that same facility**, not two facilities:
```
Health Centre = ONE OpenLMIS facility  (orders + own stock; users scoped to THIS facility only)
   ├─ Store Manager  [web]        external supply (supplier↔store), order approve/reject, dispatch
   ├─ Coordinator    [web+mobile] BKM service-point function: internal requisition, accept, allocate to VHWs
   └─ VHWs           [mobile]      allocations under THIS facility; dispense + adjust (debit facility stock)
```
- Store Manager + Coordinator are two OpenLMIS **roles (right-sets) on the SAME facility** — **not** two facilities.
- **Facility-scoped rights:** a health centre's users can only see/act on **their own** facility's stock — never another HC's.
- **No facility-to-facility transfers.** The store→coordinator→VHW internal chain is **logical**
  (mediator allocations + tasks) within the one facility's OpenLMIS stock.
- The **FHIR Location hierarchy is kept** (country → district → HC → catchments) for app
  navigation/geo. Service points and VHW villages stay **FHIR Locations, NOT OpenLMIS facilities**.

> This **supersedes** `service-point-facilities.md` — service points are **not** promoted to
> OpenLMIS facilities; they remain FHIR Locations, and the supply chain stays within one
> facility per HC.
