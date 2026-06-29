#!/usr/bin/env bash
# =============================================================================
# restore.sh — Lesotho sandbox database restore
#
# Restores PostgreSQL databases and the OpenHIM MongoDB from a backup created
# by scripts/backup.sh.
#
# Usage:
#   bash scripts/restore.sh                  # lists available backups, prompts
#   bash scripts/restore.sh <backup-dir>     # restore from specific directory
#
# Examples:
#   bash scripts/restore.sh
#   bash scripts/restore.sh ~/lesotho-backups/20260314_143022
#
# WARNING: This OVERWRITES all current database content.
#          The stack must be running (containers need to be up).
#
# LESOTHO_BACKUP_DIR  override default search root (default: $HOME/lesotho-backups)
# =============================================================================
set -euo pipefail

BACKUP_ROOT="${LESOTHO_BACKUP_DIR:-$HOME/lesotho-backups}"

PG_CONTAINER="health-db-postgres"
PG_USER="admin"
PG_DBS=(
  dhis2
  opensrp
  openlmis_auth
  openlmis_referencedata
  openlmis_requisition
  openlmis_stockmanagement
  openlmis_notification
)

MONGO_CONTAINER="openhim-mongo"
MONGO_DB="openhim"

# ── Select backup directory ──────────────────────────────────────────────────
BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" ]]; then
  if [[ ! -d "$BACKUP_ROOT" ]] || [[ -z "$(ls -A "$BACKUP_ROOT" 2>/dev/null)" ]]; then
    echo "[restore] No backups found in $BACKUP_ROOT" >&2
    exit 1
  fi

  echo "[restore] Available backups (newest first):"
  mapfile -t BACKUPS < <(ls -1t "$BACKUP_ROOT")
  for i in "${!BACKUPS[@]}"; do
    dir="$BACKUP_ROOT/${BACKUPS[$i]}"
    size=$(du -sh "$dir" 2>/dev/null | cut -f1)
    echo "  [$i] ${BACKUPS[$i]}  ($size)"
  done

  echo ""
  read -rp "Select backup number: " CHOICE
  if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [[ "$CHOICE" -ge "${#BACKUPS[@]}" ]]; then
    echo "[restore] Invalid selection." >&2
    exit 1
  fi
  BACKUP_DIR="$BACKUP_ROOT/${BACKUPS[$CHOICE]}"
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "[restore] ERROR: backup directory not found: $BACKUP_DIR" >&2
  exit 1
fi

# ── Preflight ────────────────────────────────────────────────────────────────
echo ""
echo "[restore] Restoring from: $BACKUP_DIR"
echo ""

if [[ -f "$BACKUP_DIR/manifest.txt" ]]; then
  echo "[restore] Manifest:"
  sed 's/^/  /' "$BACKUP_DIR/manifest.txt"
  echo ""
fi

read -rp "[restore] WARNING: this will OVERWRITE all current data. Continue? [y/N] " CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo "[restore] Aborted."
  exit 0
fi

for ctr in "$PG_CONTAINER" "$MONGO_CONTAINER"; do
  if ! docker inspect --format '{{.State.Running}}' "$ctr" 2>/dev/null | grep -q true; then
    echo "[restore] ERROR: container '$ctr' is not running. Start the stack first." >&2
    exit 1
  fi
done

# ── PostgreSQL ───────────────────────────────────────────────────────────────
echo "[restore] Restoring PostgreSQL databases ..."
for db in "${PG_DBS[@]}"; do
  dump="$BACKUP_DIR/${db}.dump"
  if [[ ! -f "$dump" ]]; then
    echo "[restore]   SKIP $db — dump file not found"
    continue
  fi
  echo "[restore]   restoring $db ..."
  # Drop all connections then drop+recreate the database
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();" \
    > /dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q \
    -c "DROP DATABASE IF EXISTS ${db};" \
    -c "CREATE DATABASE ${db};"
  # Re-enable extensions for referencedata
  if [[ "$db" == "openlmis_referencedata" ]]; then
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$db" -q \
      -c "CREATE EXTENSION IF NOT EXISTS postgis;" \
      -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
  fi
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$db" --no-owner -Fc < "$dump"
  echo "[restore]   $db OK"
done

# ── MongoDB ──────────────────────────────────────────────────────────────────
archive="$BACKUP_DIR/openhim_mongo.archive"
if [[ -f "$archive" ]]; then
  echo "[restore] Restoring MongoDB ($MONGO_DB) ..."
  docker exec -i "$MONGO_CONTAINER" mongorestore \
    --db "$MONGO_DB" \
    --archive \
    --drop \
    --quiet \
    < "$archive"
  echo "[restore]   openhim OK"
else
  echo "[restore]   SKIP MongoDB — archive not found"
fi

echo ""
echo "[restore] Restore complete. Restart the stack if services cached stale data:"
echo "          docker compose restart openhim-core dhis2-web"
