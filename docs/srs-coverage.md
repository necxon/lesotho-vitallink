# SRS Coverage — BKM–eLMIS Integration Sandbox

Maps every requirement and business rule from the BKM–eLMIS Integration SRS to its sandbox implementation status.

**Legend**

| Symbol | Meaning |
|--------|---------|
| ✅ | Covered — implemented and verified in the sandbox |
| ⚠️ | Partial — foundation exists; gaps noted |
| ❌ | Not covered — no implementation yet |

> **"Should" priority** items are not mandatory. Where a Should item has been implemented in this sandbox it is marked **"Implemented today"** in the notes. Where it has not, the notes say **"Not required — Should priority"** so it is clear this is a deliberate omission, not a gap.

---

## 2.1 User Requirements (UR)

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| UR-01 | Must | Simple stock workflow, minimal steps/clicks | ⚠️ | Navigation config: Pending Stock register → qn-stock-accept in 2 taps. Full usability validation requires device testing. |
| UR-02 | Must | Receive and confirm stock without creating requisitions | ✅ | `POST /fhir/SupplyDelivery` creates a Task; VHW accepts via `POST /fhir/QuestionnaireResponse`. No requisition path in app config. |
| UR-03 | Must | See stock issued and its status (pending / accepted) | ✅ | `stockAcceptanceRegister` shows `Task?status=requested`. Task moves to `completed` after acceptance, dropping off the list. |
| UR-04 | Must | Accept stock in offline / low-connectivity mode | ⚠️ | FHIR Core SDK stores QR locally (SQLite) and syncs later. BR-04 check runs server-side at sync time. Offline conflict resolution not tested. |
| UR-05 | Must | Clear feedback for success, offline save, and sync status | ⚠️ | Mediator returns structured `status`/`reason` JSON. App-side sync status messages rely on FHIR Core SDK defaults; not customised beyond saveButtonText. |
| UR-06 | **Should** | Supervisors can monitor assigned users' stock status | ❌ | Not required — Should priority. Would need a supervisor-scoped Task query + separate register config. |
| UR-07 | Must | eLMIS health facility remains source of stock issue | ✅ | Only `POST /fhir/SupplyDelivery` (simulating eLMIS push) creates a Task. The app cannot self-generate pending stock. |
| UR-08 | Must | Auditability and reconciliation across eLMIS and BKM | ⚠️ | FHIR Task carries `issueRef`, `authoredOn`, `owner`, `status`. OpenHIM logs every transaction. eLMIS stockEvents carry `documentationNo`. Full reconciliation dashboard not implemented. |
| UR-09 | Must | Aggregated community SOH and consumption back to eLMIS for requisition planning | ✅ | `pushSohToDHIS2()` syncs live SOH after each event. DHIS2 `StockOnHnd1` + `StckRcvdAL1` populated. eLMIS stockEvents record every transaction. |
| UR-10 | Must | Simple accept/consume workflow without requisition creation | ✅ | Android navigation has no requisition screen. Only stock acceptance and dispense exposed. |
| UR-11 | Must | Aggregated data traceable to source records and reporting periods | ⚠️ | eLMIS stockEvent carries `documentationNo` (BKM-{timestamp}) and `occurredDate`. DHIS2 data values use `YYYYMM` period. Full lineage from DHIS2 aggregate back to individual FHIR QR not implemented. |

---

## 2.2 Non-Functional Requirements (NFR)

### 2.2.1 Usability

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-01 | Must | Simple, intuitive workflow for low-to-moderate digital literacy | ⚠️ | Register and questionnaire structure is minimal. Requires usability testing on device. |
| NFR-02 | Must | Minimize clicks/steps for acceptance and consumption | ⚠️ | Acceptance = 2 taps (row → pre-filled form → Save). Not formally validated. |
| NFR-03 | Must | Clear non-technical messages for success, offline, sync pending, failure | ⚠️ | Mediator returns `{"status":"Successful"}` / `{"reason":"already-accepted"}`. App-level sync status relies on FHIR Core SDK defaults. |
| NFR-04 | Must | Consistent plain-language labels for stock tasks | ✅ | Navigation labels: "Pending Stock", "Stock Inventory", "Stock Order", "Stock Dispense". |

### 2.2.2 Performance

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-05 | **Should** | Pending stock list retrieval responsive under normal conditions | ⚠️ | Not required — Should priority. HAPI FHIR Task query unindexed in sandbox; no load testing performed. |
| NFR-06 | Must | Immediate user feedback after acceptance save, even if sync is async | ✅ | Mediator responds synchronously (200/409/404). Task completion is fire-and-forget. |
| NFR-07 | **Should** | Integration processing does not block BKM or eLMIS workflows | ✅ | **Implemented today.** Fan-out uses `Promise.allSettled`; SOH push is fire-and-forget. No downstream failure blocks the response. |
| NFR-08 | **Should** | Aggregation/transmission completes within operational reporting window | ❌ | Not required — Should priority. No scheduled aggregation job; SOH sync is event-driven, not period-batch. |

### 2.2.3 Reliability and Availability

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-09 | Must | BKM supports stock acceptance and consumption during network outages | ⚠️ | FHIR Core SDK offline-first design handles local capture. Not explicitly tested in sandbox. |
| NFR-10 | Must | Locally accepted/consumed records not lost before sync | ⚠️ | FHIR Core SQLite persistence is the SDK guarantee. Not explicitly tested in sandbox. |
| NFR-11 | Must | Retry and recovery for transient integration failures | ⚠️ | OpenHIM retries channel delivery. Application-level retry queue deliberately removed from mediator (structured failure logging added instead). |
| NFR-12 | Must | Idempotent transaction handling to prevent duplicate processing | ✅ | BR-04 enforced: second acceptance returns HTTP 409. eLMIS `documentationNo` is unique per call. |
| NFR-13 | **Should** | Aggregation processing does not block BKM sync | ✅ | **Implemented today.** `pushSohToDHIS2()` called with `.catch(() => {})` — never blocks the fan-out response. |

### 2.2.4 Security

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-14 | Must | Data encrypted in transit | ⚠️ | OpenHIM uses HTTPS (self-signed in sandbox). HAPI FHIR and OpenLMIS are HTTP-internal only. Production requires TLS on all internal links. |
| NFR-15 | Must | Secure authentication and authorization for users and system integrations | ✅ | Keycloak OAuth2 for Android app and mediator-to-OpenSRP. OpenLMIS uses OAuth2 client credentials. OpenHIM channel auth configured. |
| NFR-16 | Must | Audit and transaction logs protected against unauthorized modification | ⚠️ | OpenHIM stores logs in MongoDB; Winston writes rotating files. No tamper-proof append-only store implemented. |
| NFR-17 | Must | Least-privilege access | ⚠️ | Keycloak realm roles scoped to FHIR resources. OpenLMIS right_assignments scoped to facility + program. Full RBAC review not performed. |

### 2.2.5 Data Quality and Auditability

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-18 | Must | Aggregated SOH and consumption accurate, reproducible, and traceable | ⚠️ | SOH pushed from live eLMIS stockCardSummaries. Reproducibility depends on eLMIS state at query time; no snapshot stored. |
| NFR-19 | Must | Aggregation calculations deterministic for same source dataset and period | ⚠️ | SOH sync is point-in-time, not a deterministic aggregation over a fixed dataset. Period-locked batch aggregation not implemented. |
| NFR-20 | Must | Audit logs for aggregation runs (period, timestamp, dataset ID, outcome) | ❌ | Winston logs `"SOH synced to DHIS2"` but does not record reporting period, dataset ID, or structured outcome for reconciliation. |
| NFR-21 | **Should** | Identify and report data completeness/quality issues | ❌ | Not required — Should priority. Missing mappings log an error but no user-visible quality report generated. |

### 2.2.6 Maintainability and Supportability

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-22 | **Should** | Integration module modular to support API changes | ✅ | **Implemented today.** Single `mediator/index.js` with clearly separated functions per downstream. FHIR config split across JSON files in `config/fhir/`. |
| NFR-23 | **Should** | Mappings and business rules configurable without code changes | ✅ | **Implemented today.** `mappings.csv` for performer → facility/program/orderable. `RECEIPT_TYPE_CODE`, `NOTIFY_*`, thresholds all via env vars. |
| NFR-24 | Must | Logs provide sufficient detail for diagnosing issues | ✅ | Winston structured JSON: every fan-out call logs URL, response code, and timing. Failed deliveries logged with payload + error. |
| NFR-25 | **Should** | Monitoring of volumes, retries, failures, aggregation runs | ⚠️ | Not required — Should priority. OpenHIM Console shows per-channel transaction history. Application-level metrics (Prometheus/Grafana) not implemented. |

### 2.2.7 Interoperability and Scalability

| ID | Priority | Requirement | Status | Notes |
|----|----------|------------|--------|-------|
| NFR-26 | **Should** | Standards-based interfaces where supported | ✅ | **Implemented today.** FHIR R4 (MedicationDispense, Task, QuestionnaireResponse, SupplyDelivery). OpenHIM mediator pattern. DHIS2 dataValueSets API. eLMIS stockEvents API. |
| NFR-27 | Must | Consistent identifiers across systems | ✅ | Stable UUIDs for facility, program, orderable hardcoded in `mediator/index.js` and `seed.sh`. FHIR resource IDs stable across reseeds. |
| NFR-28 | **Should** | Accommodate version/configuration differences across deployments | ⚠️ | Not required — Should priority. `mappings.csv` and env vars decouple IDs from code. No formal version negotiation implemented. |
| NFR-29 | **Should** | Support phased rollout from pilot to scale without major redesign | ⚠️ | Not required — Should priority. Architecture is stateless + Docker Compose; horizontal scaling feasible. Not validated beyond single-node sandbox. |

---

## 3 Business Rules (BR)

*(Business rules have no explicit priority in the SRS — all treated as Must.)*

| ID | Business Rule | Status | Notes |
|----|--------------|--------|-------|
| BR-01 | BKM users shall not create requisitions | ✅ | No requisition screen in Android navigation. No FHIR Questionnaire for requisition creation seeded. |
| BR-02 | Requisitioning and stock issue initiation remain in eLMIS | ✅ | `POST /fhir/SupplyDelivery` is called by eLMIS (or curl). The app has no route to create stock issues. |
| BR-03 | Only stock from a valid eLMIS facility mapped to a BKM user appears as pending | ✅ | Task `owner` must be a valid HAPI FHIR Practitioner. Sync config `SearchParameter` pulls only Tasks where `owner` = current practitioner. |
| BR-04 | A stock issue can be accepted only once | ✅ | Mediator checks `Task.status` before processing QR. Returns HTTP 409 `{"reason":"already-accepted"}` if already `completed`. Covered by 2 dedicated unit tests. |
| BR-05 | Full acceptance default; partial acceptance optional/configurable | ⚠️ | Default questionnaire captures full quantity (`quantity_issued` pre-populated). `quantity_accepted` linkId exists but partial-quantity enforcement not implemented in mediator. |
| BR-06 | Offline acceptance and consumption allowed; sync later | ⚠️ | FHIR Core SDK stores QR locally and syncs. Race condition with concurrent offline acceptance of the same Task not handled. |
| BR-07 | Invalid/unmapped transactions not shown to users until corrected | ⚠️ | Mediator rejects unknown performer/medication mappings (500). App-side filtering of Tasks with unmapped performers not implemented. |
| BR-08 | All issue, acceptance, consumption, and aggregation events auditable | ⚠️ | FHIR Task tracks issue → acceptance lifecycle. eLMIS stockEvents carry `documentationNo`. OpenHIM logs every transaction. Structured aggregation audit log absent (NFR-20). |
| BR-09 | Community SOH and AMC aggregated back to eLMIS for requisition planning | ✅ | `pushSohToDHIS2()` writes SOH to DHIS2 after each event. eLMIS stockEvents record every DEBIT/CREDIT. DHIS2 Supply Chain dashboard visualises trends. |
| BR-10 | Aggregated data supports eLMIS planning but does not enable BKM requisition creation | ✅ | Data flows BKM → eLMIS/DHIS2 for planning only. No reverse flow creates orders or requisitions in BKM. |
| BR-11 | Aggregation uses approved reporting periods and mapped products/programs only | ⚠️ | DHIS2 data values use current `YYYYMM` period. Only mapped orderables (from `mappings.csv`) reach eLMIS. Period approval/lock-out logic not implemented. |
| BR-12 | Aggregated values traceable to source BKM records for audit and reconciliation | ⚠️ | eLMIS `documentationNo = BKM-{timestamp}` links stockEvent to mediator call. DHIS2 data value has no back-reference to FHIR QR ID. Full bi-directional reconciliation not implemented. |

---

## Summary

| Category | Total | Must | Should | ✅ Covered | ⚠️ Partial | ❌ Not Covered |
|----------|-------|------|--------|-----------|-----------|--------------|
| User Requirements (UR) | 11 | 10 | 1 | 5 | 5 | 1 (Should) |
| NFR — Usability | 4 | 4 | 0 | 1 | 3 | 0 |
| NFR — Performance | 4 | 2 | 2 | 2 | 1 | 1 (Should) |
| NFR — Reliability | 5 | 4 | 1 | 2 | 3 | 0 |
| NFR — Security | 4 | 4 | 0 | 1 | 3 | 0 |
| NFR — Data Quality | 4 | 3 | 1 | 0 | 2 | 2 (1×Must, 1×Should) |
| NFR — Maintainability | 4 | 1 | 3 | 3 | 1 | 0 |
| NFR — Interoperability | 4 | 1 | 3 | 2 | 2 | 0 |
| Business Rules (BR) | 12 | 12 | 0 | 5 | 7 | 0 |
| **Total** | **52** | **41** | **11** | **21 (40%)** | **27 (52%)** | **4 (8%)** |

### Must-priority gaps (require attention)

| ID | Gap |
|----|-----|
| NFR-20 | Structured audit log for aggregation runs — period, dataset ID, and outcome not recorded |
| NFR-18/19 | Aggregation accuracy/determinism — SOH sync is point-in-time, not period-locked batch |

### Should-priority items implemented in this sandbox

| ID | Item |
|----|------|
| NFR-07 | Non-blocking fan-out via `Promise.allSettled` |
| NFR-13 | SOH push fire-and-forget — does not block BKM sync |
| NFR-22 | Modular mediator structure; FHIR config split across JSON files |
| NFR-23 | `mappings.csv` + env var configuration for all business rule parameters |
| NFR-26 | Standards-based FHIR R4 + OpenHIM + DHIS2/eLMIS REST interfaces |

### Should-priority items not implemented (deliberate, not a gap)

| ID | Item |
|----|------|
| UR-06 | Supervisor stock monitoring |
| NFR-05 | Performance testing of pending stock list |
| NFR-08 | Scheduled period-based aggregation job |
| NFR-21 | Data completeness / quality reporting |
| NFR-25 | Application-level metrics monitoring |
| NFR-28 | Formal version negotiation across deployments |
| NFR-29 | Multi-node / scaled deployment validation |
