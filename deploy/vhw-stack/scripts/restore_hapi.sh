#!/usr/bin/env bash
# restore_hapi.sh - load a HAPI database dump into this stack.
#
# Used to rehearse, and later perform, the copy of the live data from
# amoh255fhir001. Make the dump there (read-only for that server):
#   sudo docker exec hapi-postgres pg_dump -U hapi -Fc hapidata > hapidata.dump
#
# Then here:
#   bash scripts/restore_hapi.sh /path/to/hapidata.dump            # refuses if Patients exist
#   bash scripts/restore_hapi.sh /path/to/hapidata.dump --force    # replaces existing data
#
# Always takes a backup of the current database first (scripts/backup.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

DUMP=${1:?usage: restore_hapi.sh <dump> [--force]}
FORCE=${2:-}
[[ -s "$DUMP" ]] || { echo "no such dump: $DUMP" >&2; exit 1; }

count() {
  curl -s --max-time 30 "http://127.0.0.1:8080/fhir/$1?_summary=count" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("total",0))' 2>/dev/null || echo "?"
}

existing=$(count Patient)
if [[ "$existing" != "0" && "$FORCE" != "--force" ]]; then
  echo "this server already holds $existing Patients - re-run with --force to replace them" >&2
  exit 1
fi

echo "backing up the current databases first"
bash scripts/backup.sh

echo "stopping hapi and gateway"
docker compose stop gateway hapi

echo "recreating $HAPI_DB_NAME and restoring $DUMP"
docker compose exec -T hapi-postgres psql -U "$HAPI_DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$HAPI_DB_NAME\";" -c "CREATE DATABASE \"$HAPI_DB_NAME\";"
docker compose exec -T hapi-postgres pg_restore -U "$HAPI_DB_USER" -d "$HAPI_DB_NAME" \
  --no-owner --no-acl --exit-on-error < "$DUMP"

echo "starting hapi and gateway"
docker compose start hapi gateway
for _ in $(seq 1 60); do
  [[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/fhir/metadata) == 200 ]] && break
  sleep 5
done

echo "restored:"
for r in Patient Group Location Task QuestionnaireResponse Practitioner Composition Binary; do
  printf '  %-22s %s\n' "$r" "$(count "$r")"
done
