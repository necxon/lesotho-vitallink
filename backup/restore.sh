#!/usr/bin/env bash
# =============================================================================
# restore.sh - restore a VitalLink deployment from an archive written by
# backup.sh. Runs inside the bkm-backup container.
#
#   docker exec -it bkm-backup restore.sh                    # list archives
#   docker exec -it bkm-backup restore.sh vitallink-20260921_020000.tar.gz
#
# There is deliberately NO portal button for this. Restoring overwrites every
# database in place, and unlike a failed backup a mistaken restore cannot be
# retried - the data it replaced is gone. The same reasoning as the standby
# promotion in docs/high-availability.md: a confirmation dialog only asks a
# human to be careful, and during an incident people click through.
#
# Stop the application containers first. Services that are connected while their
# database is dropped will reconnect to a half-restored database, and Keycloak
# and HAPI both run schema migrations on startup that can then write into it:
#
#   docker compose stop hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \
#                       keycloak dhis2-web bkm-mediator superset openhim-core
#   docker exec -it bkm-backup restore.sh <archive>
#   docker compose start ...
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"

HEALTH_DB_HOST="${HEALTH_DB_HOST:-db-postgres}"
HEALTH_DB_PORT="${HEALTH_DB_PORT:-5432}"
HEALTH_DB_USER="${HEALTH_DB_USER:-admin}"
HEALTH_DB_PASS="${HEALTH_DB_PASS:-password123}"

LMIS_DB_HOST="${LMIS_DB_HOST:-db}"
LMIS_DB_PORT="${LMIS_DB_PORT:-5432}"
LMIS_DB_USER="${LMIS_DB_USER:-postgres}"
LMIS_DB_PASS="${LMIS_DB_PASS:-p@ssw0rd}"

MONGO_HOST="${MONGO_HOST:-db-mongo}"
MONGO_PORT="${MONGO_PORT:-27017}"
MONGO_DB="${MONGO_DB:-openhim}"

log() { echo "[restore $(date +%H:%M:%S)] $*"; }

ARCHIVE_ARG="${1:-}"

if [ -z "$ARCHIVE_ARG" ]; then
  echo "Archives in ${BACKUP_DIR} (newest first):"
  echo ""
  ls -1t "${BACKUP_DIR}"/vitallink-*.tar.gz 2>/dev/null | while read -r a; do
    printf '  %-34s %8s  %s\n' "$(basename "$a")" "$(du -h "$a" | cut -f1)" \
      "$(date -r "$a" '+%Y-%m-%d %H:%M')"
  done
  echo ""
  echo "Usage: restore.sh <archive-name>"
  exit 0
fi

# Accept a bare name or a full path.
case "$ARCHIVE_ARG" in
  /*) ARCHIVE="$ARCHIVE_ARG" ;;
  *)  ARCHIVE="${BACKUP_DIR}/${ARCHIVE_ARG}" ;;
esac

[ -f "$ARCHIVE" ] || { echo "No such archive: ${ARCHIVE}" >&2; exit 1; }

# -- Integrity ---------------------------------------------------------------
# Checked before anything is dropped. Discovering a truncated archive after the
# databases are gone is the worst possible ordering.
if [ -f "${ARCHIVE}.sha256" ]; then
  log "Verifying checksum"
  EXPECTED=$(cat "${ARCHIVE}.sha256")
  ACTUAL=$(sha256sum "$ARCHIVE" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "CHECKSUM MISMATCH - this archive is corrupt. Refusing to restore." >&2
    exit 1
  fi
else
  log "No .sha256 sidecar - verifying the archive is at least readable"
  tar -tzf "$ARCHIVE" >/dev/null || { echo "Archive is unreadable." >&2; exit 1; }
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Extracting"
tar -xzf "$ARCHIVE" -C "$WORK"

echo ""
if [ -f "${WORK}/manifest.txt" ]; then
  sed 's/^/  /' "${WORK}/manifest.txt"
  echo ""
fi

# -- Confirmation ------------------------------------------------------------
# CONFIRM=RESTORE in the environment covers the scripted case without making the
# interactive case silent.
if [ "${CONFIRM:-}" != "RESTORE" ]; then
  echo "This OVERWRITES every database listed above. It cannot be undone."
  printf 'Type RESTORE to continue: '
  read -r ANSWER
  [ "$ANSWER" = "RESTORE" ] || { echo "Aborted."; exit 0; }
fi

# -- PostgreSQL --------------------------------------------------------------
restore_cluster() {
  local label="$1" host="$2" port="$3" user="$4" pass="$5" dumpdir="$6"
  [ -d "$dumpdir" ] || { log "${label}: nothing in this archive"; return 0; }
  export PGPASSWORD="$pass"

  if ! pg_isready -h "$host" -p "$port" -U "$user" -t 15 >/dev/null 2>&1; then
    log "${label} (${host}:${port}) is unreachable - SKIPPED"
    return 1
  fi

  local dump db
  for dump in "$dumpdir"/*.dump; do
    [ -e "$dump" ] || continue
    db=$(basename "$dump" .dump)
    log "  ${label}/${db}"

    # Existing connections hold the database open and DROP DATABASE will refuse
    # while any remain, so evict them first.
    psql -h "$host" -p "$port" -U "$user" -d postgres -q -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();" \
      >/dev/null 2>&1 || true

    psql -h "$host" -p "$port" -U "$user" -d postgres -q \
      -c "DROP DATABASE IF EXISTS \"${db}\";" \
      -c "CREATE DATABASE \"${db}\";"

    # PostGIS and uuid-ossp live outside the dump when they were installed by
    # the image rather than by the application, so recreate them up front.
    psql -h "$host" -p "$port" -U "$user" -d "$db" -q \
      -c "CREATE EXTENSION IF NOT EXISTS postgis;" \
      -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" >/dev/null 2>&1 || true

    if pg_restore -h "$host" -p "$port" -U "$user" -d "$db" --no-owner --no-privileges \
         "$dump" 2>"${WORK}/err.txt"; then
      log "    ok"
    else
      # pg_restore reports errors for objects that already exist (the extensions
      # above, mainly). Surface them without treating every one as fatal.
      log "    completed with $(grep -c 'error' "${WORK}/err.txt" || echo 0) error line(s):"
      head -5 "${WORK}/err.txt" | sed 's/^/      /'
    fi
  done
  unset PGPASSWORD
}

log "PostgreSQL: health cluster"
restore_cluster health "$HEALTH_DB_HOST" "$HEALTH_DB_PORT" "$HEALTH_DB_USER" "$HEALTH_DB_PASS" \
  "${WORK}/postgres-health" || true

log "PostgreSQL: OpenLMIS cluster"
restore_cluster openlmis "$LMIS_DB_HOST" "$LMIS_DB_PORT" "$LMIS_DB_USER" "$LMIS_DB_PASS" \
  "${WORK}/postgres-openlmis" || true

# -- MongoDB -----------------------------------------------------------------
if [ -f "${WORK}/mongo/openhim.archive" ]; then
  log "MongoDB: ${MONGO_DB}"
  mongorestore --host "$MONGO_HOST" --port "$MONGO_PORT" \
    --archive="${WORK}/mongo/openhim.archive" --gzip --drop --quiet \
    && log "  ok" || log "  FAILED"
fi

# -- Configuration -----------------------------------------------------------
# Staged, never written back over the live tree. /project is mounted read-only
# on purpose: a restore that silently rewrote docker-compose.yml underneath a
# running stack would be a nasty surprise, and the config in an archive may be
# older than the code now deployed.
if [ -d "${WORK}/config" ]; then
  STAGE="${BACKUP_DIR}/restored-config-$(date +%Y%m%d_%H%M%S)"
  cp -a "${WORK}/config" "$STAGE"
  chmod -R go-rwx "$STAGE"
  log "Configuration staged at ${STAGE} (inside the container; ./backups on the host)"
  log "  Review it and copy back by hand what you actually want."
fi

echo ""
log "Restore complete. Start the application containers again:"
log "  docker compose start hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \\"
log "                       keycloak dhis2-web bkm-mediator superset openhim-core"
log "Then confirm the data is really there before trusting it - the Administrator"
log "Portal home page and a patient search are the quickest check."
