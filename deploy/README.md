# deploy/ — host-level config for the Lesotho prod server (lesotho-bkm.xyz)

The Docker stacks live in the repo, but the **host OS** config (reverse proxy, TLS,
fail2ban, boot policies) is not tracked by Docker. This folder reproduces it.

## Contents
| File | Purpose |
|------|---------|
| `nginx/bkm.conf` | Main domain: bkm-web `/`, Keycloak `/auth`, OpenHIM `/openhim` |
| `nginx/subdomains.conf` | 9 service subdomains; mailhog+prometheus behind basic auth |
| `fail2ban/jail.local` | SSH + nginx jails |
| `setup-server.sh` | One-shot runbook that installs/wires everything |

## Full bring-up on a fresh box
```bash
# 1. Clone + bring up the Docker stacks first
git clone <repo> && cd lesotho-vitallink
make start          # OpenLMIS + main stack + seed   (see top-level README)

# 2. DNS: point these A records at the server IP
#    @  opensrp  openhim  fhir  dhis2  lmis  grafana  prometheus  mailhog  sync

# 3. Host config (nginx, TLS, fail2ban, boot, OpenLMIS nginx, OpenHIM pwd)
DOMAIN=lesotho-bkm.xyz EMAIL=you@example.com bash deploy/setup-server.sh
```

## Secrets — the `.env` pattern (for real prod)
docker-compose reads `.env` from the repo root. Passwords are referenced as
`${VAR:-default}`: the default (test value) keeps the sandbox working without a
`.env`, and prod overrides them with fresh secrets.

```bash
cp .env.example .env          # then edit with REAL values from your password manager
#   PG_PASSWORD, KC_ADMIN_PASSWORD, GRAFANA_PASSWORD, OPENHIM_PASS, DHIS2_PASS, OPENLMIS_PASS
docker compose up -d          # picks up .env
```
`.env` is gitignored — keep the real values in 1Password/Bitwarden/Vault, NOT in git.
If you change `PG_PASSWORD`, also update `config/dhis.conf`, `config/opensrp/context.xml`,
`config/initdb/01-md5-auth.sql`, and run `ALTER USER admin WITH PASSWORD ...` on the live DB.

## Passwords (NOT in git — applied at runtime)
`make seed` applies the Keycloak realm (user logins, login theme, BKM Health name)
from `config/keycloak/opensrp-realm.json`. The admin-UI passwords below were set
live and are recorded in the agent memory file `project_prod_deployment.md`:

- Keycloak **admin** (master) — reset via `kcadm set-password` (Makefile `seed` passes `KC_ADMIN_PASSWORD`)
- **Grafana** admin — `curl -X PUT /api/admin/users/1/password` (env only applies on fresh volume)
- **MailHog/Prometheus** basic auth — `htpasswd /etc/nginx/.htpasswd admin`
- KC user logins (opensrp-admin, facility-worker, 3 VHWs) — in realm JSON + seed reset loop

Stage-2 service creds (OpenHIM/DHIS2/OpenLMIS/Postgres) are still defaults — see memory.

## Android prod APK
Do NOT byte-patch the DEX for prod URLs (length change corrupts it). Rebuild:
```bash
# android/fhircore/android/local.properties → set prod https URLs (dev backup: local.properties.dev.bak)
cd android/fhircore/android && ./gradlew :quest:assembleOpensrpDebug
adb install -r quest/build/outputs/apk/opensrp/debug/quest-opensrp-debug.apk
adb reverse --remove-all
```

## Gotchas (learned the hard way)
- Keycloak `/auth` proxy: **no trailing slash** on `proxy_pass`, and **large proxy buffers** (big KC headers).
- DHIS2 heap cap: keep `-Dcontext.path=''` in `CATALINA_OPTS` or every path 404s.
- OpenLMIS nginx: consul-template re-renders `/etc/nginx/conf.d/default.conf` — patch the
  consul-template **source** too (`/etc/consul-template/openlmis.conf`) so stubs survive.
- OpenHIM root password re-seeds to default on a fresh container — re-run step 10 of setup-server.sh.
