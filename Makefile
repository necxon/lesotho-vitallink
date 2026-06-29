.PHONY: up up-lmis seed seed-workers start restart restart-lmis reseed fix-nginx test e2e down down-lmis reset logs backup restore profile-atp profile-bkm phone-clear phone-restart phone-ports phone-clear-on phone-clear-off phone-install phone-setup check-openlmis smoke local-config seed-local reseed-if-empty
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

## Back up all databases to ~/lesotho-backups/<timestamp>/ (override with LESOTHO_BACKUP_DIR)
backup:
	bash scripts/backup.sh

## Restore databases from a backup (prompts to choose, or pass BACKUP_DIR=<path>)
restore:
	bash scripts/restore.sh $(BACKUP_DIR)

## Switch to ATP profile: 2 facilities (Clinic A + B), 3 medicines (Oxytocin,
## Amoxicillin, Paracetamol) @ 100 SOH each, 6 people (admin + supervisor +
## per-facility {facility_worker, VHW}). Mediator reads mappings.json (NOT the
## .csv — those are vestigial), so swap the JSON profile variant.
profile-atp:
	bash -c "cp mediator/mappings.atp.json mediator/mappings.json && cp docker-compose.atp.override.yml docker-compose.override.yml"
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
