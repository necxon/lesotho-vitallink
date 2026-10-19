# VHW OpenSRP stack

One docker compose project for the Lesotho VHW backend: HAPI FHIR, Keycloak, the
OpenSRP FHIR gateway and fhir-web, each with its database where needed.

It reproduces the working stack on amoh255fhir001 (prod-host), captured on
2026-09-29 with `capture_stack.sh`: same image versions, same HAPI settings, same
gateway and web configuration. The header of `docker-compose.yml` lists the few
deliberate differences (single project, no public HAPI port, working health checks).

## Hosts and hostnames

A zoomable map of every host, hostname and route, with a Today / Planned view and
all public addresses, is in `docs/environment-map.html`: download it and open it in
a browser (GitHub shows the source, not the page).

nginx on proxy-host already routes two pairs of hostnames:

| Role | App and API | Web portal | Backend host |
|---|---|---|---|
| Live today | vhw.gov.ls | training.vhw.gov.ls | amoh255fhir001 (.146), Keycloak on .117 |
| This stack | app.vhw.gov.ls | web.vhw.gov.ls | amoh255bkmtrn001 (.114) |

Nothing in nginx has to change to bring this stack up. At cutover, the live
hostnames are pointed at .114 and the three `*_HOST` values in `.env` switch over
(see `.env.example`).

## Files

- `docker-compose.yml` - the stack
- `.env.example` - every setting; copy to `.env` (gitignored)
- `hapi/application.yaml` - HAPI overrides, identical to the live server
- `keycloak/Dockerfile` - optimized Keycloak 22 build, identical to the live server
- `keycloak/import/` - put the exported `opensrp` realm JSON here (gitignored)
- `capture_stack.sh` - read-only snapshot of a host's containers and config
- `scripts/init_env.sh` - creates `.env` with generated secrets, never overwrites one
- `scripts/preflight.sh` - read-only: is the host ready to start the stack
- `scripts/verify.sh` - end-to-end checks once running, read-only
- `scripts/backup.sh` - dumps both databases, keeps 14 days
- `scripts/copy_config.py` - copies config and reference data (no patients) between HAPI servers
- `scripts/set_web_secret.sh` - new portal client secret into `.env`, restarts portal and gateway
- `scripts/export_keycloak_realm.sh` - full and settings-only export of the opensrp realm (run on the Keycloak host)
- `scripts/restore_hapi.sh` - loads a HAPI dump, backs up first, refuses to overwrite data without `--force`

## First deployment on .114

1. Capture the current state of the host, for the record:
   `sudo bash capture_stack.sh`

2. Prepare, without stopping or starting anything. None of these create a
   container, and the Keycloak image gets its own tag (`vhw-keycloak`), so the
   earlier containers and their images are untouched:
   ```
   sudo mkdir -p /opt/vhw-stack && sudo tar -xzf vhw-stack.tar.gz -C /opt/vhw-stack
   cd /opt/vhw-stack
   sudo bash scripts/init_env.sh                    # .env with generated secrets, mode 600
   sudo docker compose pull --ignore-buildable      # images from Docker Hub
   sudo docker compose build keycloak               # builds vhw-keycloak:22.0.5
   # if quay.io times out (it does from amoh255bkmtrn001): the host's existing
   # image is built from the identical Dockerfile, so tag it instead
   #   sudo docker tag keycloak-optimized:22.0.5 vhw-keycloak:22.0.5
   sudo bash scripts/preflight.sh                   # read-only readiness report
   ```
   Until steps 3 and 4 are done, preflight reports the missing realm and ports
   8080 and 8082 (the earlier HAPI and Keycloak) as blocked; everything else
   should be ok.

3. Export the `opensrp` realm from the live Keycloak (the one behind
   https://vhw.gov.ls/auth, on .117): admin console, realm `opensrp`,
   Realm settings, Action, Partial export, with groups and roles and with clients,
   users off. Save it as `keycloak/import/opensrp-realm.json`, owned by uid 1000
   (Keycloak's user inside the container): `sudo chown 1000` and `sudo chmod 600` it.
   A root-only file makes Keycloak fail with "Failed to import realms". Before importing:
   - remove `attributes.frontendUrl` if present, otherwise it overrides `AUTH_HOST`
   - in the `fhir-web` client, add `https://web.vhw.gov.ls/*` to `redirectUris`
     and `https://web.vhw.gov.ls` to `webOrigins`

4. Stop the earlier containers on .114, which hold no app data (empty HAPI
   database, Keycloak with only the master realm). Their volumes are kept:
   ```
   sudo docker stop hapi-fhir hapi-postgres keycloak-prod-keycloak-1 keycloak-prod-postgres-1
   ```
   Agree this with the owner of /home/bophelo/projects/bkm-workspace first.

5. Start the stack, using the images already prepared in step 2 (`--build`
   would try to rebuild Keycloak from quay.io):
   `sudo docker compose up -d`

6. Give the portal its own secret: `sudo bash scripts/set_web_secret.sh`. It
   generates a new `fhir-web` secret in this Keycloak, writes it to `.env` without
   printing it, recreates fhir-web and restarts the gateway. The gateway loads the
   realm's signing keys from https://AUTH_HOST/auth/realms/opensrp when it starts;
   started before the realm existed, it answers every request with 500.

7. Load data, one of:
   - configuration and reference data, no patients (test environment):
     `python3 scripts/copy_config.py http://prod-host:8080/fhir http://127.0.0.1:8080/fhir`
     shows the counts; add `--apply` to copy. Practitioners keep their ids, so the
     users imported with the realm find their Practitioner and assignments.
   - a full copy of the live data (rehearsal): make a dump on .146 as described
     in `scripts/restore_hapi.sh`, copy it here, then
     `sudo bash scripts/restore_hapi.sh hapidata.dump`

8. Create test users in Keycloak and check: `sudo bash scripts/verify.sh`

9. Nightly backups, in root's crontab:
   `15 1 * * * cd /opt/vhw-stack && bash scripts/backup.sh >> backups/backup.log 2>&1`

## Cutover to production (later, planned)

Only when .114 is to replace .146 as the live server.

1. Announce a window; VHWs sync and then stop entering data.
2. Export the `opensrp` realm from the live Keycloak including users, with
   `kc.sh export --realm opensrp --users realm_file` on that host, so user ids and
   password hashes carry over. Practitioner records are linked to Keycloak user
   ids, so users must keep their ids.
3. Dump the live HAPI database and restore it here with
   `restore_hapi.sh <dump> --force`.
4. Set `API_HOST=vhw.gov.ls`, `AUTH_HOST=vhw.gov.ls`, `WEB_HOST=training.vhw.gov.ls`,
   import the realm, `docker compose up -d`.
5. On .61, point vhw.gov.ls (`/`, `/fhir`, `/auth`) and training.vhw.gov.ls at .114.
6. Run `verify.sh`, log in on one tablet, sync, open a household.
7. Rollback: point nginx back at .146 and .117. They are left untouched until
   the new server has run cleanly for an agreed period.

## Preprod environment on amoh255bkmnec001 (jump-host)

A third copy of the stack, next to the VitalLink stack that already runs on the
jump host, plus the VitalLink web portal (form and phone-menu builder). New forms
and menus are made and tried here, then copied to test and production.

| Name | Routes to | What |
|---|---|---|
| preprod-app.vhw.gov.ls | jump-host:18181 (/auth: 18182) | app API through the gateway, logins |
| preprod-web.vhw.gov.ls | jump-host:18300 | OpenSRP web portal |
| preprod-builder.vhw.gov.ls | jump-host:18902 | VitalLink web (builder) |

- Settings: `.env.preprod.example` (project `vhw-preprod`, `COMPOSE_PROFILES=builder`,
  other host ports). The same `docker-compose.yml` is used; without these
  settings it keeps the test and production ports.
- The builder is built from a lesotho-vitallink checkout (`BKM_WEB_SRC`) with
  its runtime config in `bkm-web/config.preprod.js`. It logs in through the realm
  `opensrp` with the client `bkm-web`, which the preprod realm needs in addition to
  the usual clients.
- nginx on proxy-host: `nginx/vhw-preprod.conf`, then certbot for the three names.
- DNS: three A records to 203.0.113.61, like the other vhw.gov.ls names.

## Notes

- HAPI answers on 127.0.0.1:8080 only. Scripts that talk to HAPI directly
  (the config upload and fingerprint scripts) must run on this host or through an
  SSH tunnel: `ssh -L 8080:127.0.0.1:8080 deploy-user@test-host`.
- Keycloak (8082), the gateway (8081) and fhir-web (3000) must be reachable from
  the nginx host proxy-host. A host firewall can restrict them to that address.
- The tokens' issuer is fixed by `AUTH_HOST`, whichever hostname a client used to
  log in. `verify.sh` checks that it matches what the gateway expects.
