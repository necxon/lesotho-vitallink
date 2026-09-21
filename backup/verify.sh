#!/usr/bin/env bash
# =============================================================================
# verify.sh - prove an archive can actually be restored.
#
#   docker exec bkm-backup verify.sh                     # newest archive, hapi_fhir
#   docker exec bkm-backup verify.sh <archive> <db>
#   make backup-verify
#
# A backup that has never been restored is a hypothesis. This is the drill that
# turns it into a fact, and it is safe to run on a live server: the dump is
# restored into a scratch database with a generated name, counted, and dropped.
# No existing database is touched at any point.
#
# It is the backup equivalent of `make ha-drill` - worth running on a schedule
# of its own, because the failure this catches (dumps that restore into nothing)
# is invisible from the outside until the day it matters.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
HEALTH_DB_HOST="${HEALTH_DB_HOST:-db-postgres}"
HEALTH_DB_PORT="${HEALTH_DB_PORT:-5432}"
HEALTH_DB_USER="${HEALTH_DB_USER:-admin}"
HEALTH_DB_PASS="${HEALTH_DB_PASS:-password123}"

ARCHIVE_ARG="${1:-}"
DB="${2:-hapi_fhir}"

if [ -z "$ARCHIVE_ARG" ]; then
  ARCHIVE=$(ls -1t "${BACKUP_DIR}"/vitallink-*.tar.gz 2>/dev/null | head -1 || true)
  [ -n "$ARCHIVE" ] || { echo "No archives in ${BACKUP_DIR}." >&2; exit 1; }
else
  case "$ARCHIVE_ARG" in
    /*) ARCHIVE="$ARCHIVE_ARG" ;;
    *)  ARCHIVE="${BACKUP_DIR}/${ARCHIVE_ARG}" ;;
  esac
fi

[ -f "$ARCHIVE" ] || { echo "No such archive: ${ARCHIVE}" >&2; exit 1; }

export PGPASSWORD="$HEALTH_DB_PASS"
PSQL="psql -h ${HEALTH_DB_HOST} -p ${HEALTH_DB_PORT} -U ${HEALTH_DB_USER}"

SCRATCH="backup_verify_$(date +%Y%m%d_%H%M%S)"
WORK=$(mktemp -d)

cleanup() {
  # The scratch database is dropped even if the restore failed half way, so a
  # failed drill does not leave debris behind on the server.
  $PSQL -d postgres -q -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[verify] archive:  $(basename "$ARCHIVE")"
echo "[verify] database: ${DB}"
echo ""

# -- Checksum ----------------------------------------------------------------
if [ -f "${ARCHIVE}.sha256" ]; then
  if [ "$(cat "${ARCHIVE}.sha256")" != "$(sha256sum "$ARCHIVE" | awk '{print $1}')" ]; then
    echo "[verify] FAIL: checksum mismatch - the archive is corrupt"
    exit 1
  fi
  echo "[verify] checksum ok"
fi

# -- Extract -----------------------------------------------------------------
if ! tar -xzf "$ARCHIVE" -C "$WORK" "./postgres-health/${DB}.dump" 2>/dev/null; then
  echo "[verify] FAIL: ${DB}.dump is not in this archive"
  echo "[verify] it contains:"
  tar -tzf "$ARCHIVE" | grep '\.dump$' | sed 's/^/  /'
  exit 1
fi

DUMP="${WORK}/postgres-health/${DB}.dump"
TABLES=$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)
echo "[verify] archive holds ${TABLES} table(s) of data"

if [ "$TABLES" -eq 0 ]; then
  echo "[verify] FAIL: the dump contains no table data at all"
  exit 1
fi

# -- Restore into a scratch database -----------------------------------------
echo "[verify] restoring into scratch database ${SCRATCH}"
$PSQL -d postgres -q -c "CREATE DATABASE ${SCRATCH};"
$PSQL -d "$SCRATCH" -q -c "CREATE EXTENSION IF NOT EXISTS postgis;" \
                     -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" >/dev/null 2>&1 || true

if ! pg_restore -h "$HEALTH_DB_HOST" -p "$HEALTH_DB_PORT" -U "$HEALTH_DB_USER" \
     -d "$SCRATCH" --no-owner --no-privileges "$DUMP" 2>"${WORK}/err.txt"; then
  ERRS=$(grep -c 'error' "${WORK}/err.txt" || true)
  echo "[verify] pg_restore reported ${ERRS} error line(s):"
  head -5 "${WORK}/err.txt" | sed 's/^/  /'
fi

# -- Count what actually landed ----------------------------------------------
# The restore "succeeding" is not the same as the data arriving: a dump of an
# empty database restores perfectly and tells you nothing.
$PSQL -d "$SCRATCH" -q -c "ANALYZE;" >/dev/null 2>&1 || true

ROWS=$($PSQL -d "$SCRATCH" -tAc \
  "SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables;")
RESTORED_TABLES=$($PSQL -d "$SCRATCH" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")

echo ""
echo "[verify] restored ${RESTORED_TABLES} table(s), about ${ROWS} row(s)"
echo "[verify] largest tables:"
$PSQL -d "$SCRATCH" -c \
  "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables
   WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 8;"

echo ""
if [ "$RESTORED_TABLES" -eq 0 ] || [ "$ROWS" -eq 0 ]; then
  echo "[verify] FAIL: the restore produced an empty database"
  exit 1
fi

echo "[verify] PASS - this archive restores. Scratch database dropped."
