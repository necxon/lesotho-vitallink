.PHONY: up up-lmis seed seed-workers start restart restart-lmis reseed fix-nginx test e2e down down-lmis reset logs backup restore profile-atp profile-bkm phone-clear phone-restart phone-ports phone-clear-on phone-clear-off phone-install phone-setup check-openlmis smoke local-config seed-local reseed-if-empty ha-drill ha-drill-quick ha-status superset superset-up superset-views superset-views-fhir superset-views-lmis superset-views-dhis2 superset-dashboards backup-logs backup-list backup-verify test-menus nav-simplify seed-questionnaires import-lhc-forms superset-categories reports-run reports-list reports-logs demo-data demo-data-purge demo-data-dhis2 demo-data-dhis2-purge
# Override $(MAKE) — on Windows, GnuWin32 expands it to a path with spaces which bash can't exec
MAKE := make

# Load secrets from .env (gitignored) and pass them to recipe shells, so targets
# like `seed` never hardcode credentials. Falls back to seed.sh defaults if unset.
-include .env
export

## Regenerate the local-only docker-compose.override.yml (gitignored) so the
## lesotho-test branch runs against localhost instead of lesotho-bkm.xyz, then
## recreate keycloak + bkm-web. Re-run after `make profile-*` (they delete it).
local-config:
	@printf '%s\n' \
'# LOCAL-ONLY override (gitignored). Regenerate with: make local-config' \
'services:' \
'  keycloak:' \
'    environment:' \
'      - KC_HOSTNAME_URL=http://localhost:8083/auth' \
'      - KC_HOSTNAME_ADMIN_URL=http://localhost:8083/auth' \
'  bkm-web:' \
'    volumes:' \
'      - ./bkm-web/js:/usr/share/nginx/html/js:ro' \
'      - ./config/bkm-web/config.local.js:/usr/share/nginx/html/config.js:ro' \
'  bkm-mediator:' \
'    environment:' \
'      # Local dev: allow concurrent logins (no single-seat "Portal in use" lock).' \
'      - SESSION_SINGLE_SEAT=false' \
'      # Local opensrp-admin password is admin (prod compose uses password).' \
'      - KEYCLOAK_ADMIN_PASSWORD=admin' \
	> docker-compose.override.yml
	@echo "Wrote docker-compose.override.yml (localhost). Recreating keycloak + bkm-web + bkm-mediator..."
	docker compose up -d keycloak bkm-web bkm-mediator

## Start sandbox containers (OpenHIM, DHIS2, OpenSRP, HAPI FHIR, mediator, etc.)
up:
	docker compose up -d

## Start the full OpenLMIS ref-distro (separate stack, sibling directory)
up-lmis:
	cd ../openlmis-ref-distro && docker compose up -d

## Run the seed script against both running stacks (idempotent — safe to re-run)
seed:
	BKM_WEB_ORIGIN=https://lesotho-bkm.xyz bash scripts/seed.sh

## Full startup: bring BOTH stacks up, then seed everything (first-time or after reset)
## OpenLMIS must start first — it creates the openlmis-ref-distro_default network that the main stack joins
start: up-lmis up seed

## Resume stopped containers. Note: the OpenLMIS referencedata image cleans its
## schema on every start, so a restart wipes OpenLMIS data — reseed-if-empty
## auto-restores it (no-op for the other stacks, which persist normally).
restart:
	docker compose start
	cd ../openlmis-ref-distro && docker compose start
	$(MAKE) fix-nginx
	$(MAKE) reseed-if-empty

## Resume only the OpenLMIS stack (no sandbox changes).
## Auto-reseeds: the referencedata image cleans its schema on every start, so a
## restart wipes OpenLMIS data — reseed-if-empty restores it.
restart-lmis:
	cd ../openlmis-ref-distro && docker compose start
	$(MAKE) fix-nginx
	$(MAKE) reseed-if-empty

## Reseed everything using LOCAL Keycloak admin creds (admin/admin). Idempotent.
## Recovery for the OpenLMIS restart-wipe. Use `make seed` instead on the prod server.
seed-local:
	KC_ADMIN_PASSWORD=admin bash scripts/seed.sh

## Auto-recovery: reseed ONLY if OpenLMIS reference data was wiped (orderables=0).
## Wired into restart/restart-lmis so a stack restart self-heals the data loss.
## After a cold machine/Docker reboot (containers auto-start, no make run), invoke
## this once: `make reseed-if-empty` (fast no-op when data is present).
reseed-if-empty:
	@bash -c 'for i in $$(seq 1 30); do docker exec openlmis-ref-distro-db-1 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done'
	@orderables=$$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -A -c "SELECT count(*) FROM referencedata.orderables;" 2>/dev/null); \
	if [ -z "$$orderables" ] || [ "$$orderables" -eq 0 ] 2>/dev/null; then \
	  echo "OpenLMIS reference data is empty (orderables=$${orderables:-0}) - auto-reseeding..."; \
	  KC_ADMIN_PASSWORD=admin bash scripts/seed.sh; \
	else echo "OpenLMIS reference data present (orderables=$$orderables) - no reseed needed."; fi

## Fix OpenLMIS nginx after any restart — consul-template renders a broken config
## (host not found in upstream "reference-ui") because Docker DNS isn't ready yet.
## Overwrites the bind-mount with a static resolver-based config and reloads nginx.
fix-nginx:
	@echo "Waiting for OpenLMIS nginx container to start..."
	@bash -c 'for i in $$(seq 1 30); do docker inspect openlmis-ref-distro-nginx-1 --format "{{.State.Running}}" 2>/dev/null | grep -q true && break; sleep 2; done'
	@sleep 4
	python3 scripts/gen_openlmis_nginx.py > ../openlmis-ref-distro/config/nginx/openlmis-default.conf
	docker exec openlmis-ref-distro-nginx-1 nginx -s reload
	@echo "nginx static config applied and reloaded."

## Re-run seed only (useful after a full "make restart" if nginx stubs need refreshing)
reseed:
	SKIP_WAIT=1 bash scripts/seed.sh

## Apply every analytics schema Superset reports on. Safe to re-run: each
## script drops and rebuilds its own `analytics` schema.
superset-views: superset-views-fhir superset-views-lmis superset-views-dhis2

## FHIR analytics views + the read-only superset_ro role (database hapi_fhir).
superset-views-fhir:
	docker exec -i health-db-postgres psql -U admin -d hapi_fhir -v ON_ERROR_STOP=1 < scripts/sql/fhir_analytics.sql > /dev/null
	docker exec -i health-db-postgres psql -U admin -d hapi_fhir -v ON_ERROR_STOP=1 < scripts/sql/fhir_reports.sql > /dev/null
	docker exec -i health-db-postgres psql -U admin -d hapi_fhir -v ON_ERROR_STOP=1 < scripts/sql/superset_role.sql > /dev/null
	@echo "analytics views + superset_ro role applied to hapi_fhir."

## OpenLMIS analytics views (database open_lmis, in the ref-distro container).
## Read-only: it only creates its own schema, it never touches a Flyway schema.
superset-views-lmis:
	docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -v ON_ERROR_STOP=1 < scripts/sql/openlmis_analytics.sql > /dev/null
	docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -v ON_ERROR_STOP=1 < scripts/sql/openlmis_reports.sql > /dev/null
	docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -v ON_ERROR_STOP=1 < scripts/sql/openlmis_superset_role.sql > /dev/null
	@echo "analytics views + superset_ro role applied to open_lmis."

## DHIS2 analytics views (database dhis2, on health-db-postgres).
superset-views-dhis2:
	docker exec -i health-db-postgres psql -U admin -d dhis2 -v ON_ERROR_STOP=1 < scripts/sql/dhis2_analytics.sql > /dev/null
	docker exec -i health-db-postgres psql -U admin -d dhis2 -v ON_ERROR_STOP=1 < scripts/sql/dhis2_reports.sql > /dev/null
	docker exec -i health-db-postgres psql -U admin -d dhis2 -v ON_ERROR_STOP=1 < scripts/sql/dhis2_superset_role.sql > /dev/null
	@echo "analytics views + superset_ro role applied to dhis2."

## Create/refresh the Superset datasets, charts and dashboards only.
## Run after editing scripts/seed_superset.py — existing chart URLs are kept.
superset-dashboards:
	docker exec -i bkm-superset python3 - < scripts/seed_superset.py

## Full Superset bring-up: build the image, wait for it, apply the views, then
## provision every dashboard. Idempotent — this is the one target to re-run.
superset: superset-up superset-views superset-dashboards
	@echo "Superset ready: http://localhost:8089 (admin / admin)"

superset-up:
	docker compose up -d --build superset
	@echo "Waiting for Superset to finish its first-run bootstrap (db upgrade + init)..."
	@bash -c 'for i in $$(seq 1 90); do curl -sf -o /dev/null http://localhost:8089/health && exit 0; sleep 5; done; echo "Superset did not become healthy"; exit 1'

## Failover drill: kill each FHIR backend in turn while traffic flows, then
## verify the database standby is really replaying writes. Exits non-zero on any
## failure, so it can gate a deploy. Takes ~4 min (backends need ~90s to boot).
ha-drill:
	bash scripts/ha-drill.sh

## Same drill without waiting for backends to rejoin (~40s). Faster, but it
## leaves nodes mid-boot, so the final status check may read "degraded".
ha-drill-quick:
	QUICK=1 bash scripts/ha-drill.sh

## Live cluster status as JSON (what the portal's Backends page renders).
ha-status:
	@curl -s http://localhost:3000/cluster/status

## Run mediator unit tests (no Docker required)
test:
	cd mediator && npm test

## Run end-to-end integration tests against the live stack
e2e:
	bash scripts/e2e-test.sh

## Same as e2e — PowerShell alias (Git Bash path for user-level Git install on Windows)
## ATP profile: MED_CODE="Oxytocin 10 IU" make e2e-win
e2e-win:
	"$(LOCALAPPDATA)/Programs/Git/usr/bin/bash.exe" scripts/e2e-test.sh

## Stop sandbox containers only (data volumes preserved)
down:
	docker compose down

## Stop full OpenLMIS ref-distro (data volumes preserved)
down-lmis:
	cd ../openlmis-ref-distro && docker compose down

## Nuclear reset: stop both stacks, delete ALL volumes, then start fresh + re-seed
## WARNING: destroys ALL persisted data (PostgreSQL, DHIS2, OpenLMIS, HAPI FHIR, etc.)
## Must confirm explicitly: make reset CONFIRM=yes
reset:
ifndef CONFIRM
	$(error Destructive operation. Run: make reset CONFIRM=yes)
endif
	cd ../openlmis-ref-distro && docker compose down -v
	docker compose down -v
	$(MAKE) start

## Tail logs from the key services
logs:
	docker compose logs -f openhim-core bkm-mediator

## Back up everything now to ./backups/ (both PostgreSQL servers, OpenHIM Mongo, config)
backup:
	bash scripts/backup.sh

## Restore from an archive (no argument lists them, or pass BACKUP_DIR=<archive-name>)
restore:
	bash scripts/restore.sh $(BACKUP_DIR)

## Tail the backup engine log
backup-logs:
	docker compose logs -f bkm-backup

## List the archives currently on this server
backup-list:
	docker exec bkm-backup /usr/local/bin/restore.sh

## Prove the newest archive actually restores (scratch database, drops it after)
backup-verify:
	docker exec bkm-backup /usr/local/bin/verify.sh

## Walk the phone's menus and forms end to end - every menu item must lead somewhere real
test-menus:
	python scripts/test_menus.py

## Show what the app menu would look like after removing duplicated registers
nav-simplify:
	python scripts/simplify_nav.py

## Placeholders for questionnaires the app config publishes but that are missing
seed-questionnaires:
	python scripts/seed_clinical_questionnaires.py

## Import real standard forms (PHQ, GAD-7, AUDIT-C, vitals) from the NLM LHC Forms library
import-lhc-forms:
	python scripts/import_lhc_forms.py --apply

## Build the five signed-off dashboard category views (run after superset-dashboards)
superset-categories:
	docker exec -i bkm-superset python3 - < scripts/superset_categories.py

## Generate synthetic demo activity so dashboards and reports have data
demo-data:
	python scripts/seed_demo_data.py --apply

## Remove every resource tagged demo-data
demo-data-purge:
	python scripts/seed_demo_data.py --purge

## Post synthetic aggregate data to DHIS2 (12 months x 20 facilities)
demo-data-dhis2:
	python scripts/seed_demo_dhis2.py --apply

## Delete the DHIS2 values the demo seeder posted
demo-data-dhis2-purge:
	python scripts/seed_demo_dhis2.py --purge

## Run every operational report now, ignoring schedule (output: ./reports-out)
reports-run:
	docker exec bkm-reports /usr/local/bin/run_reports.py --all

## List the operational reports and their schedules
reports-list:
	docker exec bkm-reports /usr/local/bin/run_reports.py --list

## Tail the report engine log
reports-logs:
	docker compose logs -f bkm-reports

## Switch to ATP profile: 2 facilities (Clinic A + B), 3 medicines (Oxytocin,
## Amoxicillin, Paracetamol) @ 100 SOH each, 6 people (admin + supervisor +
## per-facility {facility_worker, VHW}). Mediator reads mappings.json (NOT the
## .csv — those are vestigial), so swap the JSON profile variant.
profile-atp:
	bash -c "cp mediator/mappings.atp.json mediator/mappings.json && cp config/docker-compose.atp.override.yml docker-compose.override.yml"
	docker compose up -d --force-recreate bkm-mediator
	PROFILE=atp SKIP_WAIT=1 bash scripts/seed.sh
	@# seed.sh restarts the mediator mid-run for OpenHIM auth, which can leave a stale
	@# mapping load (new ATP performers missing). Final restart guarantees a clean reload.
	docker compose restart bkm-mediator

## Switch back to BKM profile: multi-medicine, 3 VHWs, single facility
## Removes docker-compose override (BKM env vars live in docker-compose.yml)
profile-bkm:
	bash -c "cp mediator/mappings.bkm.json mediator/mappings.json && rm -f docker-compose.override.yml"
	docker compose up -d --force-recreate bkm-mediator
	PROFILE=bkm SKIP_WAIT=1 bash scripts/seed.sh

## BKM profile with zero baseline: facilities start at 0; stock grows only via
## VHW order → FW dispatch → FW receipt acceptance, shrinks via dispense.
## Truncates existing OpenLMIS stock_card_line_items then reseeds with
## SEED_INITIAL_STOCK=false so the seed leaves OpenLMIS empty.
profile-bkm-zero:
	bash -c "cp mediator/mappings.bkm.json mediator/mappings.json && rm -f docker-compose.override.yml"
	docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -c "TRUNCATE stockmanagement.stock_card_line_items CASCADE;"
	docker compose up -d --force-recreate bkm-mediator
	SEED_INITIAL_STOCK=false PROFILE=bkm SKIP_WAIT=1 bash scripts/seed.sh

NAV_BINARY := d7ce0167-ee6a-4f8f-b644-50b0242513239e
HAPI       := http://localhost:8079/fhir

## Show "[DEV] Clear local data" in app nav menu (sync phone after running)
phone-clear-on:
	curl -s $(HAPI)/Binary/$(NAV_BINARY) | \
	  python3 -c "import sys,json;d=json.load(sys.stdin);next(m for m in d['staticMenu'] if m['id']=='clearLocalData')['visible']=True;print(json.dumps(d))" | \
	  curl -s -o /dev/null -w "phone-clear-on: %{http_code}\n" -X PUT $(HAPI)/Binary/$(NAV_BINARY) -H "Content-Type: application/json" --data-binary @-

## Install bkm-phone.apk on a connected Android device.
## Automatically uninstalls first if there is a signature mismatch (e.g. new phone with old build).
phone-install:
	@ADB=$$(which adb 2>/dev/null || echo "$$LOCALAPPDATA/Android/Sdk/platform-tools/adb"); \
	"$$ADB" install -r bkm-phone.apk 2>/dev/null || \
	  ( echo "Signature mismatch — uninstalling first..."; \
	    "$$ADB" uninstall org.smartregister.opensrp && \
	    "$$ADB" install bkm-phone.apk )

## Set up adb reverse tunnels so the phone can reach sandbox services on localhost.
## Re-run this whenever the phone is reconnected or USB cable is replugged.
phone-ports:
	@ADB=$$(which adb 2>/dev/null || echo "$$LOCALAPPDATA/Android/Sdk/platform-tools/adb"); \
	"$$ADB" reverse tcp:8079 tcp:8079 && \
	"$$ADB" reverse tcp:8083 tcp:8083 && \
	"$$ADB" reverse tcp:5001 tcp:5001
	@echo "Tunnelled: 8079 (HAPI FHIR)  8083 (Keycloak)  5001 (OpenHIM)"

## Full phone setup: install APK + reverse port tunnels. Use this for a new device.
phone-setup: phone-install phone-ports

## Hide "[DEV] Clear local data" from app nav menu
phone-clear-off:
	curl -s $(HAPI)/Binary/$(NAV_BINARY) | \
	  python3 -c "import sys,json;d=json.load(sys.stdin);next(m for m in d['staticMenu'] if m['id']=='clearLocalData')['visible']=False;print(json.dumps(d))" | \
	  curl -s -o /dev/null -w "phone-clear-off: %{http_code}\n" -X PUT $(HAPI)/Binary/$(NAV_BINARY) -H "Content-Type: application/json" --data-binary @-

## Verify OpenLMIS reference data is seeded (catches an empty/un-seeded olmis-db)
check-openlmis:
	@echo "Checking OpenLMIS reference data..."
	@orderables=$$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -A -c "SELECT count(*) FROM referencedata.orderables;" 2>/dev/null); \
	facilities=$$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -A -c "SELECT count(*) FROM referencedata.facilities;" 2>/dev/null); \
	echo "  orderables=$${orderables:-?}  facilities=$${facilities:-?}"; \
	if [ -z "$$orderables" ] || [ "$$orderables" -eq 0 ] 2>/dev/null; then \
	  echo "  [FAIL] OpenLMIS is NOT seeded (0 orderables). Run: make seed  (or: bash scripts/seed.sh)"; \
	  exit 1; \
	fi; \
	echo "  [OK] OpenLMIS reference data present"

## Quick smoke-test against the live stack (requires jq or python3)
smoke: check-openlmis
	@echo "Sending a test MedicationDispense through OpenHIM channel..."
	curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
	  -H 'Content-Type: application/fhir+json' \
	  -d '{"resourceType":"MedicationDispense","status":"completed","subject":{"reference":"Patient/patient-001"},"performer":[{"actor":{"reference":"Practitioner/opensrp-admin"}}],"whenHandedOver":"$(shell date -u +%Y-%m-%dT%H:%M:%SZ)","quantity":{"value":6,"unit":"tablet"}}' \
	  | python3 -m json.tool
