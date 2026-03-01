.PHONY: up seed start test e2e down reset logs

## Start all containers in the background
up:
	docker compose up -d

## Run the seed script against a running stack (idempotent — safe to re-run)
seed:
	bash scripts/seed.sh

## Full startup: bring containers up THEN seed all services (first-time setup)
start: up seed

## Run mediator unit tests (no Docker required)
test:
	cd mediator && npm test

## Run end-to-end integration tests against the live stack
e2e:
	bash scripts/e2e-test.sh

## Stop all containers (data volumes preserved)
down:
	docker compose down

## Nuclear reset: stop, delete ALL volumes, then start fresh + re-seed
## WARNING: destroys all persisted data (DHIS2 org units, OpenSRP events, etc.)
reset:
	docker compose down -v
	$(MAKE) start

## Tail logs from the key services
logs:
	docker compose logs -f openhim-core bkm-mediator

## Quick smoke-test against the live stack (requires jq or python3)
smoke:
	@echo "Sending a test MedicationDispense through OpenHIM channel..."
	curl -s -X POST http://localhost:5001/fhir/MedicationDispense \
	  -H 'Content-Type: application/fhir+json' \
	  -d '{"resourceType":"MedicationDispense","status":"completed","subject":{"reference":"Patient/patient-001"},"performer":[{"actor":{"reference":"Practitioner/opensrp-admin"}}],"whenHandedOver":"$(shell date -u +%Y-%m-%dT%H:%M:%SZ)","quantity":{"value":6,"unit":"tablet"}}' \
	  | python3 -m json.tool
