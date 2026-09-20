# Production Installation

How to stand up the Lesotho VitalLink stack on a fresh Ubuntu server. This
covers the IP-only HTTP bring-up (no domain yet). The domain + TLS layer is a
later step, documented at the end and in deploy/README.md.

Reference box for this guide: user necuser, repo at
/home/necuser/docker/lesotho-vitallink. This runbook was validated end-to-end
on that box on 2026-07-02 - the values below are the ones that actually worked.

Throughout this guide 0.0.0.0 stands in for the server's own public IP. It is a
placeholder only - substitute your real address wherever it appears, including in
the compose overrides, the seed command and the browse URLs.

## Overview

The stack includes two FHIR backends with automatic failover, a streaming
database standby and optional Superset dashboards. Sections 8 and 9 cover those;
sections 1-7 bring up the core system.

The deployment is two Docker Compose stacks plus optional host config:

- Main stack: this repo (docker-compose.yml) - OpenHIM, Keycloak, DHIS2,
  HAPI FHIR, OpenSRP, the mediator, bkm-web, monitoring.
- OpenLMIS stack: the openlmis-ref-distro repo, cloned as a SIBLING directory.
  The main stack attaches to its Docker network (openlmis-ref-distro_default),
  so OpenLMIS must be up first.
- Host config (domain deployments only): nginx reverse proxy, Let's Encrypt
  TLS, fail2ban. Skipped for IP-only.

Directory layout the tooling expects:

```
/home/necuser/docker/lesotho-vitallink/     <- this repo
/home/necuser/docker/openlmis-ref-distro/   <- OpenLMIS ref-distro (sibling)
```

## Prerequisites

Install on the host:

- Docker Engine + Docker Compose plugin (`docker compose version`)
- make (`sudo apt-get install -y make`)
- python3 (`sudo apt-get install -y python3`)
- git, curl

If apt reports "Unable to fetch some archives", refresh the index first:

```bash
sudo apt-get update
sudo apt-get install -y make python3
```

Give your non-root user Docker access, then run everything as that user (never
as root/sudo - mixing owners breaks later steps mid-seed):

```bash
sudo usermod -aG docker $USER
newgrp docker          # or log out and back in
docker ps              # must work WITHOUT sudo before continuing
```

## 1. Networks and secrets

The health-net network is declared external in docker-compose.yml; nothing
creates it automatically, so create it once:

```bash
docker network create health-net
```

Create .env. IMPORTANT: do NOT just copy the placeholders from .env.example -
two values are load-bearing and will break the stack if wrong:

- PG_PASSWORD MUST be `password123`. The Postgres admin password is hardcoded to
  password123 by config/initdb/01-md5-auth.sql (ALTER USER admin), config/dhis.conf,
  and config/opensrp/context.xml. If .env sends anything else, the mediator,
  Keycloak, and HAPI all fail with "password authentication failed for user admin".
- KC_ADMIN_PASSWORD MUST be `admin`. The Keycloak container uses it for the
  master admin, and seed.sh defaults its own KC admin password to `admin`
  (scripts/seed.sh line ~88). They have to match or the seed's Keycloak steps fail.

Working sandbox .env (harden these before a real public production box):

```bash
cat > .env <<'EOF'
PG_PASSWORD=password123
KC_ADMIN_PASSWORD=admin
GRAFANA_PASSWORD=admin
OPENHIM_PASS=password
DHIS2_PASS=district
OPENLMIS_PASS=password
SEED_USER_PASSWORD=<choose-a-strong-password>   # facility logins; never commit the real value
EOF
```

Note: running seed.sh directly does NOT load .env (only `make` does, via
`-include .env`). Pass any needed vars on the command line when calling seed.sh.

## 2. OpenLMIS ref-distro (sibling repo)

The OpenLMIS ref-distro is a separate upstream repo with local customizations
(its docker-compose.override.yml disables the Flyway demo-data clean). A vanilla
upstream clone will NOT behave. Copy the working directory from an existing
seeded server:

```bash
cd ~/docker
rsync -avz necjp@0.0.0.0:~/docker/openlmis-ref-distro/ ./openlmis-ref-distro/
# (or scp -r). Data lives in Docker volumes, not the dir - the seed repopulates it.
```

The sibling dir MUST be named exactly `openlmis-ref-distro` (Docker Compose
derives the container/network names from the directory, and seed.sh expects
`openlmis-ref-distro-*` / `openlmis-ref-distro_default`).

A vendored copy also exists at android/vital-link/openlmis, but its override
differs (Flyway clean not fully disabled) - use it only as a fallback.

## 3. IP-only configuration (no domain yet)

The committed docker-compose.yml is domain-shaped: it hardcodes lesotho-bkm.xyz
and the old server IP (0.0.0.0), mounts config.prod.js, and runs
Keycloak in edge-proxy mode. On a bare-IP HTTP box these are wrong, so override
them.

bkm-web IP config is committed at config/bkm-web/config.ip.js (URLs point at the
server IP and service ports). Update the IP in that file if the server differs.

Create docker-compose.override.yml on the SERVER only (gitignored). Do not create
it on a local dev machine, where it would clobber local setup:

```yaml
# IP-only override (no domain/TLS yet).
services:
  keycloak:
    environment:
      - KC_PROXY=none        # NOT empty - empty crash-loops Keycloak
                             # ("Invalid value for option kc.proxy").
                             # 'none' = no TLS proxy in front (plain HTTP).
      - KC_HOSTNAME_URL=http://0.0.0.0:8083/auth
      - KC_HOSTNAME_ADMIN_URL=http://0.0.0.0:8083/auth
  hapi-fhir:
    environment:
      - hapi.fhir.server_address=http://0.0.0.0:8079/fhir/
  bkm-web:
    volumes:
      - ./bkm-web/js:/usr/share/nginx/html/js:ro
      - ./config/bkm-web/config.ip.js:/usr/share/nginx/html/config.js:ro
```

Note: `make profile-atp`, `make profile-bkm`, and `make local-config` delete or
overwrite docker-compose.override.yml. Recreate this file after running any of
them.

## 4. Firewall (OS level)

ufw on the box only controls the OS. A cloud/corporate firewall in front of the
server may still block ports - see "External access" below. At the OS level,
open the service ports for IP-direct access:

```bash
sudo ufw allow OpenSSH
for p in 9902 8083 8079 5001 8081 8082 9901 3005 9285 8025 9290; do sudo ufw allow $p/tcp; done
sudo ufw --force enable
```

Ports: 9902 bkm-web, 8083 Keycloak, 8079 HAPI FHIR (via fhir-proxy),
5001 OpenHIM, 8081 DHIS2, 8082 OpenLMIS, 9901 OpenSRP web, 3005 Grafana,
9285 OpenHIM console, 8025 MailHog, 9290 Prometheus.

## 5. Bring up and seed

Do NOT use `make start` / `make seed` for the IP box - those seed with the old
`lesotho-bkm.xyz` origin. Bring the stacks up and seed with the IP origin:

```bash
make up-lmis        # OpenLMIS first; wait for referencedata to finish Flyway (~minutes)
make up             # main stack
BKM_WEB_ORIGIN=http://0.0.0.0:9902 bash scripts/seed.sh 2>&1 | tee /tmp/seed.log
make check-openlmis # sanity: orderables > 0
```

First `docker compose` pull is several GB and can hit transient DNS timeouts on
docker.io - just re-run `make up`. If DNS keeps failing, point Docker at reliable
resolvers: `echo '{ "dns": ["8.8.8.8","1.1.1.1"] }' | sudo tee /etc/docker/daemon.json && sudo systemctl restart docker`.

Seed should end with "Seed complete." A line like
"FML map failures: 25 (expected - HAPI rejects FML syntax)" is NORMAL - the same
StructureMaps re-upload OK in the FHIR-content pass right after.

Then browse http://0.0.0.0:9902.

## 6. Mafeteng dataset (real deployment)

The base seed (or ATP profile) provisions demo facilities, but the mediator's
HAPI_FACILITY_MAP is configured for the 18 real Mafeteng facilities. If they do
not match, the mediator logs "fhirLedger: SOH fetch failed ... 403" at startup
(harmless, but the live stock ledger is wrong). Reseed to the real Mafeteng set:

```bash
# generate the derived config (reads SEED_USER_PASSWORD for the facility logins)
SEED_USER_PASSWORD="$SEED_USER_PASSWORD" python3 scripts/gen_mafeteng_configs.py

# dry run first - review, especially the "Detected endpoints" line
DRY_RUN=1 bash scripts/reseed_mafeteng.sh 2>&1 | tee /tmp/mafeteng-dry.log

# apply (additive/idempotent; REMOVE_MASERU=1 deactivates the demo)
bash scripts/reseed_mafeteng.sh 2>&1 | tee /tmp/mafeteng.log

# reload mediator + web so they pick up the rewritten mappings.json / core.js
docker compose restart bkm-mediator bkm-web
```

reseed_mafeteng.sh auto-detects endpoints (Keycloak localhost:8083, OpenLMIS
localhost:8082, HAPI direct localhost:18079) and does NOT touch
docker-compose.override.yml, so the IP config is preserved. The 18 facilities
get the same UUIDs as HAPI_FACILITY_MAP, which is what clears the 403s. Verify:

```bash
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t \
  -c "SELECT code,name FROM referencedata.facilities WHERE code LIKE 'MFT%' ORDER BY code;"
docker logs --tail 25 bkm-mediator | grep -E "ledger init complete|SOH fetch"
```

Expect 18 MFT facilities and "ledger init complete ... across 18 facilities"
with no 403 lines.

## 7. Verify (local)

Run on the box (services answer over localhost even when external access is
still blocked):

```bash
docker compose ps                                          # all Up; DBs healthy
curl -s -o /dev/null -w "bkm-web:  %{http_code}\n" http://localhost:9902
curl -s -o /dev/null -w "keycloak: %{http_code}\n" http://localhost:8083/auth/realms/opensrp
curl -s -o /dev/null -w "hapi:     %{http_code}\n" http://localhost:8079/fhir/metadata
# auth check - must return an access_token
curl -s -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
  http://localhost:8083/auth/realms/master/protocol/openid-connect/token | head -c 80
make check-openlmis
```

## 8. Redundancy (optional but recommended)

The stack ships a second FHIR backend and a hot standby of the database. Both
are ordinary compose services, so they come up with everything else - there is
nothing extra to install. See `docs/high-availability.md` for the full runbook.

What you get: `fhir-proxy` load balances across `hapi-fhir` and `hapi-fhir-2`
and fails over automatically, and `db-postgres-standby` streams the whole
cluster (hapi_fhir, dhis2, keycloak, opensrp, mediator, superset) so the data
survives losing the primary.

The standby needs a replication role on the primary. This is idempotent:

```bash
# 1. replication role on the primary (idempotent - ignore "already exists")
docker exec health-db-postgres psql -U admin -d postgres \
  -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';" || true

# 2. allow replication connections from the docker network
docker exec health-db-postgres sh -c "grep -q 'replication replicator' /var/lib/postgresql/data/pg_hba.conf || echo 'host replication replicator all md5' >> /var/lib/postgresql/data/pg_hba.conf"

# 3. apply without a restart, then start the standby
docker exec health-db-postgres psql -U admin -d postgres -c "SELECT pg_reload_conf();"
docker compose up -d db-postgres-standby     # first start takes a base backup
```

Change that password from `replicator` on any real deployment: set
`REPL_PASSWORD` in `.env` and use the same value in the `CREATE ROLE` above.

Then prove it works before relying on it:

```bash
make ha-drill        # kills each backend in turn, verifies replication; ~4 min
make ha-status       # live cluster JSON
```

The drill exits non-zero if anything fails. Expect `passed: 14  failed: 0`.
Watch the same state in the portal under `Backends & Failover`.

## 9. Superset analytics (optional)

Dashboards over FHIR, OpenLMIS and DHIS2. Needs the `superset` database, which
`config/initdb/02-create-databases.sql` creates on a fresh volume; on an
existing one create it by hand first:

```bash
docker exec health-db-postgres psql -U admin -d postgres -c "CREATE DATABASE superset;"
make superset        # build, apply the views, provision the dashboards
```

Superset then answers on port 8089 (admin / admin - change it). Full details in
`docs/superset-analytics.md`.

## Troubleshooting (hit during the 2026-07-02 bring-up)

- Docker "permission denied ... /var/run/docker.sock": user not in docker group,
  or the shell predates the group add. `newgrp docker` or re-login. See Prerequisites.
- Keycloak crash-loops with "Invalid value for option kc.proxy": KC_PROXY is
  empty. Set `KC_PROXY=none`.
- Mediator/HAPI "password authentication failed for user admin": PG_PASSWORD in
  .env is not `password123`. Fix .env, then `docker compose up -d` to recreate.
- Seed exits immediately with "line 20: log: command not found": stale lock from
  an interrupted run. `rm -f /tmp/lesotho-seed.lock` and re-run.
- A healthy FHIR backend shows as down after a container is recreated: nginx
  resolved the upstream name once at config load and cached the old IP.
  `fhir-proxy` reloads itself every 30s to re-resolve, so wait that out or run
  `docker exec fhir-proxy nginx -s reload`.
- `ports are not available ... 127.0.0.1:5433`: on Windows that port sits in the
  reserved WinNAT range. The standby is mapped to 15433 for this reason; pick
  another free port if 15433 is taken too.
- Superset fails to start with `ModuleNotFoundError: psycopg2`: it is being run
  from the upstream image instead of the local build. Use
  `docker compose up -d --build superset`.
- Seed shows every HAPI resource as "-> 404" and dies in the purge step: the
  fhir-proxy is routing to a stale HAPI IP (it uses a static upstream resolved
  once at start). This happens after recreating hapi-fhir. Fix:
  `docker compose restart fhir-proxy`, then re-run the seed. Rule of thumb: after
  recreating hapi-fhir or bkm-mediator, also restart fhir-proxy.
- Mediator "SOH fetch failed ... 403" at startup: dataset/mediator mismatch - run
  the Mafeteng reseed (section 6).

## Later: switching to a real domain

When a domain is available, add the TLS + reverse-proxy layer and revert the
IP-only overrides:

- Add DNS A records for the apex plus 9 subdomains (opensrp, openhim, fhir,
  dhis2, lmis, grafana, prometheus, mailhog, sync) pointing at the server IP.
- Run the host setup: `DOMAIN=<domain> EMAIL=<email> bash deploy/setup-server.sh`
  (installs nginx, Let's Encrypt certs, fail2ban, OpenLMIS nginx stubs).
- Replace the config.ip.js mount with config.prod.js (templated to the domain).
- Restore KC_PROXY=edge and the domain KC_HOSTNAME_URL values.
- Update config/keycloak/opensrp-realm.json redirect URIs and reseed with
  BKM_WEB_ORIGIN=https://<domain>.
- Rebuild the Android APK against the HTTPS URLs (do not build against a bare IP
  you plan to change).

### External access when only ports 80/443 are allowed

If a cloud/corporate firewall blocks the high service ports (symptom: the app
works via curl localhost on the box, but external clients time out on 9902/8083),
the app is fine - the block is upstream. Ask the network owner to open inbound
TCP 80 and 443 only, then run nginx on port 80 as a reverse proxy (/ -> bkm-web,
/auth -> Keycloak, API paths) and switch config.ip.js + KC_HOSTNAME_URL to
http://<ip> with no port, and reseed with BKM_WEB_ORIGIN=http://<ip>. This is the
same shape as the domain setup, just over port 80 on the IP.

See deploy/README.md for the domain deployment details and the gotchas learned
in production.
