# Notification System

The sandbox has two parallel notification channels:

| Channel | Audience | Delivery | Where to see it |
|---|---|---|---|
| **OpenLMIS system notifications** | Facility managers / supervisors | In-app bell (OpenLMIS UI) | OpenLMIS top-right bell icon |
| **VHW notifications** | Village health workers | SMS · Push · Email | `notification-sink` at http://localhost:8086/history, MailHog at http://localhost:8025 |

---

## Architecture

```
MedicationDispense / SupplyDelivery
       │ (via OpenHIM → mediator)
       ▼
  executeFanout()
       │
       ├──► OpenLMIS stockEvent  ──► success?
       │                               │
       │              ┌────────────────┘
       │              │
       │        ┌─────┴──────────────────────────────────────┐
       │        │                                            │
       │  postLmisNotification()                  sendNotifications()
       │  (mediator in-memory store)              (notification-sink)
       │        │                                            │
       │        ▼                                            ├──► POST /sms    → notification-sink
       │  GET /api/systemNotifications                       ├──► POST /push   → notification-sink
       │  (OpenLMIS nginx proxies here)                      └──► POST /email  → notification-sink → MailHog (SMTP)
       ▼
  OpenLMIS bell icon shows events

Order dispatch (dispatchOrders())
       │
       └──► postLmisNotification()  →  OpenLMIS bell
```

### OpenLMIS bell — how it's wired

The OpenLMIS reference-UI polls `GET /api/systemNotifications?active=true&page=0&size=10` on load and after dismissals.  
In this sandbox, the OpenLMIS nginx stub for that endpoint was changed (in `seed.sh` step 3) from a static empty-array response to a proxy that forwards to the mediator:

```nginx
location ~ /api/systemNotifications {
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $sysnot http://bkm-mediator:3000;
    rewrite ^/api/systemNotifications(.*)$ /lmis-notifications$1 break;
    proxy_pass $sysnot;
}
```

The mediator stores notifications in an in-memory list (capped at 100, newest first) at `src/routes/lmisNotifications.js`. Notifications are lost on mediator restart — this is intentional for the sandbox (no persistence needed).

---

## Events

### Fired by the mediator automatically

| Event | Trigger | OpenLMIS bell title | VHW notification |
|---|---|---|---|
| **Stock Dispensed** | Successful `MedicationDispense` fan-out | `Stock Dispensed` | SMS + push + email (if `NOTIFY_ON_DISPENSE=true`) |
| **Stock Received** | Successful `SupplyDelivery` fan-out | `Stock Received` | SMS + push + email (if `NOTIFY_ON_RECEIPT=true`) |
| **Low Stock Alert** | SOH after dispense < `NOTIFY_LOW_STOCK_THRESHOLD` | `⚠ Low Stock Alert` | SMS + push + email (if `NOTIFY_ON_LOW_STOCK=true`) |
| **Order Dispatched** | Successful monthly batch dispatch to OpenLMIS | `Order Dispatched` | — |

Example messages in the OpenLMIS bell:

```
Stock Dispensed      3 units of AL-20-120 dispensed to Patient/patient-001
⚠ Low Stock Alert   AL-20-120 stock on hand is 15 units — below threshold of 20. Consider requesting resupply.
Order Dispatched     1 medicine line dispatched to OpenLMIS for period 2026-05 (3 tablets total)
```

### Dismissing notifications

Clicking the ✕ on a bell notification in the OpenLMIS UI sends:
```
PATCH /api/systemNotifications/{id}   { "active": false }
```
This is proxied to the mediator (`PATCH /lmis-notifications/{id}`) and sets `active: false` in the store. The item disappears from the bell on next poll.

---

## VHW Notifications — notification-sink

The `notification-sink` service (port 8086) receives HTTP POSTs from the mediator and:
- Stores them in an in-memory `history` array
- For `email` channel: forwards the message to MailHog via SMTP

### Viewing notification history

```bash
curl http://localhost:8086/history
```

Or open http://localhost:8086/history in a browser for a JSON dump.

### MailHog (email preview)

All outbound email is captured by MailHog. No real email is ever sent.

**URL:** http://localhost:8025  
No login required.

### Throttling

Each channel has a per-recipient, per-event-type cooldown to prevent flooding the VHW device:

| Env var | Default | Effect |
|---|---|---|
| `NOTIFY_SMS_THROTTLE_MS` | 300 000 (5 min) | Minimum gap between SMS of the same type to the same recipient |
| `NOTIFY_PUSH_THROTTLE_MS` | 60 000 (1 min) | Minimum gap between push notifications |
| `NOTIFY_EMAIL_THROTTLE_MS` | 600 000 (10 min) | Minimum gap between emails |

Set to `0` to disable throttling (useful for testing).

---

## Configuration

All notification settings are in `docker-compose.yml` under `bkm-mediator` environment:

```yaml
# VHW channel (SMS / push / email)
NOTIFY_SMS_ENABLED: "true"
NOTIFY_PUSH_ENABLED: "true"
NOTIFY_EMAIL_ENABLED: "true"
NOTIFY_ON_DISPENSE: "true"
NOTIFY_ON_LOW_STOCK: "true"
NOTIFY_ON_RECEIPT: "true"
NOTIFY_LOW_STOCK_THRESHOLD: "20"          # units; alert fires when SOH drops below this
NOTIFY_SMS_URL: "http://notification-sink:3001/sms"
NOTIFY_PUSH_URL: "http://notification-sink:3001/push"
NOTIFY_EMAIL_URL: "http://notification-sink:3001/email"
NOTIFY_EMAIL_FROM: "mediator@lesotho.health"
NOTIFY_SMS_THROTTLE_MS: "300000"
NOTIFY_PUSH_THROTTLE_MS: "60000"
NOTIFY_EMAIL_THROTTLE_MS: "600000"

# OpenLMIS in-app bell
NOTIFY_LMIS_ON_DISPENSE: "true"          # Stock Dispensed bell entry
NOTIFY_LMIS_ON_RECEIPT: "true"           # Stock Received bell entry
NOTIFY_LMIS_ON_LOW_STOCK: "true"         # ⚠ Low Stock Alert bell entry
NOTIFY_LMIS_ON_ORDER_DISPATCH: "true"    # Order Dispatched bell entry
```

To disable VHW notifications entirely, set all three `NOTIFY_*_ENABLED` to `"false"`.  
To disable OpenLMIS bell notifications, set the relevant `NOTIFY_LMIS_ON_*` vars to `"false"`. All four default to `"true"` when unset.

---

## API Reference

All endpoints are on the mediator, proxied through bkm-web at `/mediator-api/`.

### OpenLMIS bell store

| Method | Path | Description |
|---|---|---|
| `GET` | `/lmis-notifications` | List notifications. Supports `?active=true&page=0&size=10`. |
| `POST` | `/lmis-notifications` | Create a notification. Body: `{ "title": "…", "message": "…" }` |
| `PATCH` | `/lmis-notifications/:id` | Update (dismiss). Body: `{ "active": false }` |
| `DELETE` | `/lmis-notifications` | Clear all notifications (used by test runner). |

Via bkm-web proxy (from host):
```bash
# List active notifications
curl "http://localhost:9902/mediator-api/lmis-notifications?active=true"

# Create a manual notification
curl -X POST http://localhost:9902/mediator-api/lmis-notifications \
  -H "Content-Type: application/json" \
  -d '{"title":"Manual Alert","message":"Test message"}'

# Clear all
curl -X DELETE http://localhost:9902/mediator-api/lmis-notifications
```

Or directly via the OpenLMIS nginx (same data):
```bash
curl "http://localhost:80/api/systemNotifications?active=true&page=0&size=10"
```

### notification-sink (VHW channel)

| Method | Path | Description |
|---|---|---|
| `POST` | `/sms` | Record an SMS event |
| `POST` | `/push` | Record a push notification |
| `POST` | `/email` | Record + deliver email via MailHog |
| `GET` | `/history` | All recorded notifications |
| `DELETE` | `/history` | Clear history |

```bash
# Manually send an SMS through the sink
curl -X POST http://localhost:8086/sms \
  -H "Content-Type: application/json" \
  -d '{"to":"+26650000001","message":"Test SMS","event":"manual"}'

# View all sent notifications
curl http://localhost:8086/history
```

---

## Testing Notifications

The **Tests** tab in bkm-web (`http://localhost:9902/#/tests`) includes a section that validates the notification pipeline. It clears throttle cooldowns before testing so all events fire regardless of the normal per-channel limits.

To manually trigger a full dispense notification cycle:

```bash
curl -X POST http://localhost:5001/fhir/MedicationDispense \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType": "MedicationDispense",
    "status": "completed",
    "subject": { "reference": "Patient/patient-001" },
    "performer": [{ "actor": { "reference": "Practitioner/opensrp-admin" } }],
    "medicationCodeableConcept": { "coding": [{ "code": "AL-20-120" }] },
    "whenHandedOver": "2026-05-04T10:00:00Z",
    "quantity": { "value": 6, "unit": "tablet" }
  }'
```

Then check:
- OpenLMIS bell: http://localhost:80 → log in → bell icon (top right)
- notification-sink history: http://localhost:8086/history
- MailHog: http://localhost:8025

---

## Troubleshooting

**Bell shows no notifications after a dispense**

1. Check the mediator store directly:
   ```bash
   curl http://localhost:9902/mediator-api/lmis-notifications
   ```
   If notifications are there, the nginx proxy is the problem.

2. Verify the OpenLMIS nginx is proxying (not returning the static stub):
   ```bash
   curl -v "http://localhost:80/api/systemNotifications?active=true&size=1"
   ```
   Look for `X-Powered-By` or a JSON body matching the mediator format. If you see `{"content":[],"totalElements":0,...}` with no real items despite step 1 showing items, the nginx patch didn't take.

3. Re-apply the nginx patch by running `bash scripts/seed.sh` (step 3 re-patches both the template and the rendered config).

**Bell shows notifications but dismissal doesn't work**

The PATCH request must reach the mediator. Check browser DevTools network tab for `PATCH /api/systemNotifications/{id}` — if it returns 404, the id was not found (possibly the mediator restarted and lost in-memory state).

**VHW notifications not appearing in notification-sink history**

1. Check `NOTIFY_SMS_ENABLED`, `NOTIFY_PUSH_ENABLED`, `NOTIFY_EMAIL_ENABLED` are `"true"` in docker-compose.yml.
2. Check throttle cooldowns — a second dispense within the throttle window won't fire. Use the test runner (clears cooldowns) or set `NOTIFY_SMS_THROTTLE_MS=0` temporarily.
3. Check mediator logs: `docker logs bkm-mediator 2>&1 | grep -i notif`

**Notifications keep appearing for old events after mediator restart**

The in-memory store is cleared on restart — this is expected behaviour. All notifications visible in the bell were created in the current mediator process lifetime.
