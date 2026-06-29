# Demo: End-to-End Stock Order Flow

Demonstrates a field worker ordering stock from an Android device, the order flowing through to OpenLMIS, and the resulting notification back to the field worker via FHIR Task and SMS/push/email.

---

## Architecture Overview

```
Android BKM App
     │  POST /fhir/QuestionnaireResponse  (qn-stock-order)
     ▼
OpenHIM Channel  :5001
     │
     ▼
BKM Mediator
     │  buffers order in PostgreSQL (order_buffer table)
     │
     │  [batch dispatch — manual or cron Monday 06:00]
     │  POST /api/stockEvents  (DEBIT reason)
     ▼
OpenLMIS  :8082
     │
     │  [facility receives physical stock]
     │  POST /fhir/QuestionnaireResponse  (qn-stock-accept / type=RECEIPT)
     ▼
BKM Mediator
     ├──▶ OpenLMIS  POST /api/stockEvents  (CREDIT reason — SOH increases)
     ├──▶ HAPI FHIR  PUT /Task/{id}  (status=requested — VHW acceptance task)
     └──▶ Notification Sink  SMS + Push + Email to field worker
```

---

## Prerequisites

- Full stack running (`make start` or `make restart`)
- Services verified healthy:
  - OpenHIM channel: http://localhost:5001
  - OpenLMIS: http://localhost:8082
  - HAPI FHIR: http://localhost:8079/fhir
  - MailHog: http://localhost:8025
  - BKM Web: http://localhost:9902

---

## Step 1 — Field Worker Places a Stock Order

The Android BKM app posts a `QuestionnaireResponse` (form `qn-stock-order`) to the OpenHIM channel. The mediator buffers it atomically in PostgreSQL.

**curl equivalent:**
```bash
curl -s -X POST http://localhost:5001/fhir/QuestionnaireResponse \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "QuestionnaireResponse",
    "questionnaire": "Questionnaire/qn-stock-order",
    "subject":  {"reference": "Patient/patient-001"},
    "author":   {"reference": "Practitioner/opensrp-admin"},
    "item": [
      {"linkId": "type",             "answer": [{"valueCoding": {"code": "ORDER"}}]},
      {"linkId": "medication",       "answer": [{"valueCoding": {"code": "AL-20-120"}}]},
      {"linkId": "quantity_ordered", "answer": [{"valueInteger": 100}]},
      {"linkId": "performer",        "answer": [{"valueString": "Practitioner/opensrp-admin"}]}
    ]
  }'
```

**Expected response:** HTTP 202 with current stock-on-hand (SOH).

**Verify in BKM Web:** http://localhost:9902 → **Orders** — pending order appears.

---

## Step 2 — Dispatch Order to OpenLMIS

Orders accumulate in the PostgreSQL buffer and are dispatched in a weekly batch (Monday 06:00 by default). For the demo, trigger dispatch manually.

**Via bkm-web:** http://localhost:9902 → **Orders** → click **Dispatch Orders**

**Via curl:**
```bash
curl -s -X POST http://localhost:9902/mediator-api/aggregate/orders \
  -H 'Content-Type: application/json' \
  -d '{"force": true}'
```

**What happens:**
- Mediator aggregates all buffered order lines for the current period
- `POST /api/stockEvents` sent to OpenLMIS with DEBIT reason (`b5c27da7...` — Consumed)
- FHIR Tasks (`status=requested`) created in HAPI FHIR for each medicine/VHW combination
- Order buffer cleared for the dispatched period

**Expected response:** JSON summary of dispatched lines and OpenLMIS HTTP status.

---

## Step 3 — Verify Order in OpenLMIS

1. Open http://localhost:8082
2. Login: `admin` / `password`
3. Navigate to **Stock Management → Stock Card Summaries**
4. Filter: **Facility** = Maseru District Clinic A, **Program** = Essential Medicines
5. Confirm AL 20/120mg stock event with reason **Consumed** (negative adjustment)

Alternatively, query the API directly:
```bash
curl -s "http://localhost:9902/lmis-api/api/stockCardSummaries?facility=28de536f-b826-4eeb-a3c4-d65221a1120d&program=31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c" \
  -H "Authorization: Bearer $(curl -s -X POST http://localhost:9902/lmis-api/api/oauth/token \
    -d 'grant_type=password&username=admin&password=password&client_id=user-client&client_secret=changeme' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
```

---

## Step 4 — Facility Receives Physical Stock

When the physical stock arrives at the facility, the facility worker records acceptance. This triggers a CREDIT stock event in OpenLMIS (SOH increases) and fires notifications.

**curl equivalent:**
```bash
curl -s -X POST http://localhost:5001/fhir/QuestionnaireResponse \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "QuestionnaireResponse",
    "questionnaire": "Questionnaire/qn-stock-accept",
    "author": {"reference": "Practitioner/opensrp-admin"},
    "item": [
      {"linkId": "type",              "answer": [{"valueCoding": {"code": "RECEIPT"}}]},
      {"linkId": "medication",        "answer": [{"valueCoding": {"code": "AL-20-120"}}]},
      {"linkId": "quantity_accepted", "answer": [{"valueInteger": 100}]},
      {"linkId": "performer",         "answer": [{"valueString": "Practitioner/opensrp-admin"}]}
    ]
  }'
```

**What happens:**
- `POST /api/stockEvents` to OpenLMIS with CREDIT reason (`313f2f5f...` — Receipts), SOH +100
- SMS + Push + Email notification fired to field worker via Notification Sink
- FHIR Task updated/created (`status=requested`) for VHW to confirm receipt on Android
- OpenLMIS in-app bell notification: _"Stock Received — 100 units of AL-20-120"_

---

## Step 5 — Verify Notifications

### Email (MailHog)
Open http://localhost:8025 — receipt notification email visible:
- **Subject:** `Stock receipt recorded`
- **Body:** `Receipt recorded: 100 units of AL-20-120mg received at facility`

### FHIR Task (Android pickup)
```bash
curl -s http://localhost:8079/fhir/Task?status=requested | python3 -m json.tool
```
The VHW's Android app picks up this Task on next sync — it appears as a pending stock acceptance task with:
- **code:** SNOMED `373748001` (Stock Issue)
- **description:** `AL-20-120 — 100 units`
- **owner:** `Practitioner/opensrp-admin`

### OpenHIM Transaction Log
Open http://localhost:9285 — all channel transactions visible with request/response bodies and mediator response.

### DHIS2 Stock Dashboard
Open http://localhost:8081/dhis-web-dashboard/index.html#/BKMStkDsh01 — SOH line chart updated.

---

## Port Reference (current)

| Service | URL | Credentials |
|---|---|---|
| BKM Web | http://localhost:9902 | — (Keycloak login) |
| OpenHIM Console | http://localhost:9285 | root@openhim.org / openhim-password |
| OpenHIM Channel | http://localhost:5001 | — |
| OpenLMIS | http://localhost:8082 | admin / password |
| HAPI FHIR | http://localhost:8079/fhir | — |
| DHIS2 | http://localhost:8081 | admin / district |
| Keycloak | http://localhost:8083/auth | admin / admin |
| MailHog | http://localhost:8025 | — |
| Grafana | http://localhost:3005 | admin / admin123 |
| Prometheus | http://localhost:9290 | — |

---

## Mediator Key Environment Variables

| Variable | Value | Purpose |
|---|---|---|
| `ORDER_BATCH_SCHEDULE` | `0 6 * * 1` | Cron for weekly batch dispatch |
| `OPENLMIS_REASON_ID` | `b5c27da7...` | Consumed (DEBIT) reason |
| `OPENLMIS_RECEIPT_REASON_ID` | `313f2f5f...` | Receipts (CREDIT) reason |
| `OPENLMIS_FACILITY_ID` | `28de536f...` | Maseru District Clinic A |
| `OPENLMIS_PROGRAM_ID` | `31ef5fd8...` | Essential Medicines |
| `NOTIFY_ON_RECEIPT` | `true` | Fire notifications on stock receipt |
| `NOTIFY_LOW_STOCK_THRESHOLD` | `20` | Units below which low-stock alert fires |

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Step 1 returns 500 | OpenHIM channel not reachable — verify `docker ps` shows openhim-core healthy |
| Dispatch returns empty | No orders buffered — re-run Step 1 first |
| OpenLMIS stockEvent fails | Check mediator logs: `docker logs bkm-mediator --tail 50` |
| No email in MailHog | Verify `NOTIFY_EMAIL_ENABLED=true` and notification-sink running |
| FHIR Task not created | Check HAPI FHIR logs: `docker logs hapi-fhir --tail 30` |
| Android app can't connect | Ensure patched APK installed; device on same network; use host machine IP not localhost |
