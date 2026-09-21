#!/usr/bin/env bash
# =============================================================================
# backup.sh - take a backup now, from the host.
#
#   bash scripts/backup.sh        (or: make backup)
#
# This is a thin wrapper. The engine lives in the bkm-backup container
# (backup/backup.sh) and is the same code the nightly schedule and the
# Administrator Portal's "Back up now" button run, so there is one backup
# implementation and not three that drift apart.
#
# It has to run in the container: the databases are on internal Docker networks
# with no ports published to the host, and the OpenLMIS database is on a
# different network again. The previous host-side version worked around that
# with `docker exec` into each database container, and its hardcoded list of
# databases is how hapi_fhir and keycloak came to be left out of every backup
# it took.
#
# Archives land in ./backups on this host.
# =============================================================================
set -euo pipefail

CONTAINER="${BACKUP_CONTAINER:-bkm-backup}"

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "[backup] ERROR: the '$CONTAINER' container is not running." >&2
  echo "[backup] Start it with:  docker compose up -d $CONTAINER" >&2
  exit 1
fi

if [ -n "${LESOTHO_BACKUP_DIR:-}" ]; then
  echo "[backup] NOTE: LESOTHO_BACKUP_DIR is no longer used. Archives are written"
  echo "[backup]       to ./backups, which is bind-mounted into the container."
fi

exec docker exec "$CONTAINER" /usr/local/bin/backup.sh
