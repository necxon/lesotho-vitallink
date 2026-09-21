#!/usr/bin/env bash
# =============================================================================
# restore.sh - restore from an archive, from the host.
#
#   bash scripts/restore.sh                                  # list archives
#   bash scripts/restore.sh vitallink-20260921_020000.tar.gz
#   make restore BACKUP_DIR=vitallink-20260921_020000.tar.gz
#
# A thin wrapper around backup/restore.sh inside the bkm-backup container, which
# is where the database credentials and the network routes are.
#
# STOP THE APPLICATIONS FIRST. Services connected while their database is
# dropped will reconnect to a half-restored database, and Keycloak and HAPI both
# run schema migrations on startup that will then write into it:
#
#   docker compose stop hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \
#                       keycloak dhis2-web bkm-mediator superset openhim-core
#   bash scripts/restore.sh <archive>
#   docker compose start hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \
#                        keycloak dhis2-web bkm-mediator superset openhim-core
# =============================================================================
set -euo pipefail

CONTAINER="${BACKUP_CONTAINER:-bkm-backup}"

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "[restore] ERROR: the '$CONTAINER' container is not running." >&2
  echo "[restore] Start it with:  docker compose up -d $CONTAINER" >&2
  exit 1
fi

# -t only when there is a terminal to attach, so this still works from cron or
# CI, where restore.sh reads CONFIRM=RESTORE from the environment instead.
DOCKER_FLAGS="-i"
[ -t 0 ] && DOCKER_FLAGS="-it"

# shellcheck disable=SC2086
exec docker exec $DOCKER_FLAGS \
  -e "CONFIRM=${CONFIRM:-}" \
  "$CONTAINER" /usr/local/bin/restore.sh "$@"
