# OpenLMIS API Compatibility — 2018 Backend vs 2025 Reference-UI

The backend services are from 2018; the reference-ui SPA is from 2025. Seven years of API evolution happened between them.

---

## Problem Categories

### 1. Missing endpoints

The 2025 SPA calls routes that simply don't exist in the 2018 backends. Without stubs these return 404, which Angular doesn't handle gracefully → "Internal application error".

| Endpoint | Expected by SPA | Fix |
|---|---|---|
| `GET /api/digestConfiguration` | Notification digest config | Stub `{}` |
| `GET /api/userContactDetails` | User email/phone | Stub with `emailDetails.email` field (NOT `email.address` — SPA does `contactDetails.emailDetails.email`) |
| `GET /api/supportedPrograms` | Programs for home facility | Stub with Essential Medicines array |
| `GET /api/systemNotifications` | In-app notifications | Stub empty paged object |
| `GET /api/users/{id}/subscriptions` | Notification subscriptions | Stub `[]` |
| `GET /api/pages/home` | Homepage content blocks | Stub empty paged object |
| `GET /api/orders/statusesStatsData` | Order status counts | Stub `{}` |
| `GET /api/requisitions/statusesStatsData` | Requisition status counts | Stub `{}` |
| `GET /api/reports/dashboardReports` | Report list | Stub `[]` |

### 2. Wrong response format

The 2025 SPA expects paged `{"content":[...],"totalElements":N}` objects from endpoints where the 2018 backend returns plain arrays. AngularJS `$resource` has strict type checking — array where object expected throws `[$resource:badcfg]` which crashes the app.

| Endpoint | 2018 returns | 2025 SPA expects | Fix |
|---|---|---|---|
| `GET /api/facilities` | Plain array | Paged object | Serve static `facilities_paged.json` via nginx `alias` (28 KB — too large for `return 200`) |
| `GET /api/users/{id}/programs` | Paged object | Plain array | Return `[...]` directly |
| `GET /api/validSources` | — | Paged object | Stub with seeded source node |
| `GET /api/validDestinations` | — | Paged object | Stub with seeded destination node |

### 3. Wrong parameter names

The 2025 SPA sends query params that the 2018 service doesn't recognise. The service returns a 400 or ignores the filter and returns unscoped data.

| Endpoint | SPA sends | 2018 backend expects | Fix |
|---|---|---|---|
| `GET /api/physicalInventories` | `programId`, `facilityId` | `program`, `facility` | Rewrite via nginx `proxy_pass` with `$arg_programId` |
| `GET /api/validSources` | `programId`, `facilityTypeId` | `program`, `facilityType` | Cannot proxy — stub with static data |
| `GET /api/validDestinations` | same | same | Cannot proxy — stub with static data |
| `GET /api/validReasons` | `programId`, `facilityTypeId` | `program`, `facilityType` | Cannot proxy — stub with static data |
| `GET /api/orderables/search` | POST-style search | `GET /api/orderables` | nginx `proxy_method GET` + rewrite |

---

## Why nginx is the only fix point

There is no API gateway config file to edit. The nginx config inside `openlmis-nginx` is generated at startup by consul-template from a template at `/etc/consul-template/openlmis.conf`. consul-template re-renders the config on any Consul change, so patches to the rendered `/etc/nginx/conf.d/default.conf` are overwritten.

The only durable fix is to patch **both**:
- The template (`/etc/consul-template/openlmis.conf`) — survives consul-template re-renders
- The rendered config (`/etc/nginx/conf.d/default.conf`) — takes effect immediately

The host working copy is `default.conf.tmp` at the repo root. All stubs and rewrites live there and are deployed with:
```bash
docker cp default.conf.tmp openlmis-nginx:/etc/nginx/conf.d/default.conf
docker exec openlmis-nginx nginx -s reload
```

---

## nginx technique reference

### Static stub (small response)
```nginx
location ~ /api/systemNotifications {
  default_type application/json;
  return 200 '{"content":[],"totalElements":0,"totalPages":0}';
}
```

> **Critical:** use `default_type application/json`, NOT `add_header Content-Type application/json`.
> `add_header` creates a duplicate `Content-Type` header → AngularJS ignores it → parses response as text → TypeError.

### Large static stub (> 8 KB)
`return 200` body is limited to ~8 KB. Serve larger payloads from a file:
```nginx
location ~ /api/facilities/?$ {
  default_type application/json;
  alias /etc/nginx/facilities_paged.json;
}
```

### Query param rewrite
Remap 2025 SPA param names to 2018 backend param names:
```nginx
location ~ ^/api/physicalInventories/?$ {
  proxy_pass http://stockmanagement/api/physicalInventories?program=$arg_programId&facility=$arg_facilityId&isDraft=$arg_isDraft;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```
When `proxy_pass` includes a URI (even `?`), nginx does not append the original query string — the rewrite is complete.

### Response body patching (sub_filter)
Patch text in a proxied response (e.g. fix a JS bug without modifying source):
```nginx
location = /openlmis.js {
  proxy_pass http://reference-ui;
  proxy_set_header Accept-Encoding "";   # must disable compression
  sub_filter_types *;
  sub_filter 'oldString' 'newString';
  sub_filter_once off;                   # replace all occurrences
}
```

### Service worker kill-switch
The SPA registers a service worker that caches `openlmis.js`. If you patch openlmis.js via sub_filter but the browser loads it from the SW cache, the patch has no effect. Fix: intercept `sw.js` and return a replacement that clears all caches immediately.
```nginx
location = /sw.js {
  default_type application/javascript;
  add_header Cache-Control "no-store, no-cache, must-revalidate";
  add_header Service-Worker-Allowed "/";
  return 200 'self.addEventListener("install",function(e){e.waitUntil(self.skipWaiting());});self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(names){return Promise.all(names.map(function(name){return caches.delete(name);}));}).then(function(){return self.clients.claim();}));});self.addEventListener("fetch",function(e){e.respondWith(fetch(e.request));});';
}
```
Then navigate to `http://localhost:8082/clear-cache` — this page is never in the SW cache, so nginx serves it directly. It unregisters all SWs and redirects to `/`.
