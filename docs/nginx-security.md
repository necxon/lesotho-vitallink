# nginx Security Architecture — bkm-web

## Overview

All browser traffic enters through a single nginx reverse proxy (`bkm-web`, port 9902).
nginx handles authentication gating, rate limiting, and server-side credential injection so that no service credentials are ever exposed to the browser.

---

## Route Map

| Path prefix | Upstream | Auth gate | Notes |
|---|---|---|---|
| `/auth/*` | `keycloak:8080` | None | Keycloak itself — rate-limited |
| `/auth/admin/*` | — | Blocked (403) | Admin API not needed by bkm-web |
| `/auth/realms/master/*` | — | Blocked (403) | Master realm not needed by bkm-web |
| `/fhir/*` | `hapi-fhir:8080` | None (HAPI validates Bearer internally) | FHIR R4 API |
| `/lmis-api/*` | `openlmis-nginx` | None (OpenLMIS validates its own OAuth token) | OpenLMIS REST API |
| `/lmis-token` | `openlmis-nginx` | None — credentials injected server-side | OAuth token exchange (see below) |
| `/channel/*` | `openhim-core:5001` | Keycloak `auth_request` | OpenHIM HTTP channel |
| `/mediator-api/*` | `bkm-mediator:3000` | Keycloak `auth_request` | Mediator REST + SSE |
| `/ping/*` | Various | None | Health-check proxies for status dots |

---

## Keycloak Auth Gate

Routes `/channel/` and `/mediator-api/` are protected by nginx's `auth_request` module.
Before forwarding any request, nginx fires an internal subrequest to `/channel-auth`.

### How `/channel-auth` works

1. nginx sends a `GET` to `keycloak:8080/auth/realms/opensrp/protocol/openid-connect/userinfo`
2. It forwards the browser's `Authorization: Bearer <token>` header unchanged
3. It mirrors the same `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers that the `/auth/` proxy sends — this ensures Keycloak derives the same realm base URL (`http://localhost:9902/auth/realms/opensrp`) it used when it originally minted the token, so the `iss` claim matches
4. Keycloak returns:
   - **200** — token valid → nginx proxies the request to the upstream
   - **401** — token missing or expired → nginx returns **403** to the browser

### Rate limiting

```
/auth/*        20 req/s  burst=40  (login, token refresh)
/channel/*     10 req/s  burst=20  (OpenHIM fan-out calls)
```

---

## Server-Side Credential Injection (`/lmis-token`)

OpenLMIS requires an OAuth password-grant token (`username=admin&password=password`) to call its stock APIs. Storing these credentials in browser JavaScript would expose them to anyone who can open DevTools.

Instead, the browser calls `/lmis-token` (no credentials), and nginx injects the credentials server-side before forwarding to OpenLMIS:

```
Browser                   nginx                      OpenLMIS
   │                        │                            │
   │  POST /lmis-token      │                            │
   │  (no credentials)      │                            │
   │───────────────────────►│                            │
   │                        │  POST /api/oauth/token     │
   │                        │  Authorization: Basic ...  │
   │                        │  grant_type=password       │
   │                        │  username=admin            │
   │                        │  password=password         │
   │                        │───────────────────────────►│
   │                        │  { access_token: "..." }   │
   │                        │◄───────────────────────────│
   │  { access_token: "..." }│                            │
   │◄───────────────────────│                            │
```

The `Basic dXNlci1jbGllbnQ6Y2hhbmdlbWU=` header (Base64 of `user-client:changeme`) and the admin credentials never appear in any JS file or browser network tab originating from the frontend code.

---

## JavaScript Layer

All mediator API calls go through a single `mediatorFetch()` helper in `core.js`:

```javascript
function mediatorFetch(path, opts) {
  return kc.updateToken(30)        // refresh token if expiring within 30s
    .catch(function() { kc.login(); })
    .then(function() {
      return fetch('/mediator-api/' + path, {
        headers: Object.assign({ Authorization: 'Bearer ' + kc.token }, opts.headers),
        ...
      });
    });
}
```

Every page (`settings.js`, `orders.js`, `tasks.js`, `mappings.js`, `dhis2.js`, `tests.js`) calls `mediatorFetch()` — no page sends unauthenticated requests to `/mediator-api/`.

FHIR calls use `kc.updateToken(30)` + `Authorization: Bearer` directly (see `fhir()`, `fhirPost()`, etc. in `core.js`).

OpenLMIS calls use the `/lmis-token` server-side proxy via `lmisToken()` + `lmisGet()`.

---

## What Each Layer Validates

| Layer | Validated by |
|---|---|
| Browser → nginx `/channel/` or `/mediator-api/` | nginx `auth_request` → Keycloak userinfo |
| Browser → nginx `/fhir/` | HAPI FHIR Keycloak adapter (per request) |
| Browser → nginx `/lmis-api/` | OpenLMIS OAuth token (per request) |
| Mediator → OpenLMIS | OpenLMIS OAuth token (fetched internally by mediator) |
| Mediator → DHIS2 | Basic auth (injected by mediator, not exposed to browser) |
| Mediator → HAPI FHIR | Keycloak Bearer token (fetched internally by mediator) |

---

## Production Checklist

- [ ] Replace all default passwords (`openhim-password`, `admin/admin`, `admin/district`) with strong secrets
- [ ] Run nginx behind TLS termination (Let's Encrypt or internal CA) — all cookies and tokens transit in plaintext without it
- [ ] Set `HSTS` headers once TLS is in place
- [ ] Restrict `/fhir/` to authenticated requests (HAPI FHIR `hapi.fhir.properties`: `security.enabled=true`)
- [ ] Restrict `/lmis-api/` to authenticated requests (add `auth_request /channel-auth` to the lmis-api location if OpenLMIS API should not be publicly readable)
- [ ] Consider IP allowlisting for `/lmis-token` if only the bkm-web origin should call it
- [ ] Set `proxy_hide_header Authorization` on upstream responses to prevent token leakage in response headers
- [ ] Review OpenHIM port 5001 — in production the Android app should route through nginx (443), not hit 5001 directly; firewall 5001 at the host/cloud level
