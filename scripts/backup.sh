#!/usr/bin/env bash
# =============================================================================
# backup.sh — Lesotho sandbox database backup
#
# Dumps all PostgreSQL databases and the OpenHIM MongoDB to a timestamped
# directory on the local machine.
#
# Usage:
#   bash scripts/backup.sh
#
# Backup location (override with env var):
#   LESOTHO_BACKUP_DIR  default: $HOME/lesotho-backups
#
# Each run creates:
#   $LESOTHO_BACKUP_DIR/<YYYYMMDD_HHMMSS>/
#     dhis2.dump
#     opensrp.dump
#     openlmis_auth.dump
#     openlmis_referencedata.dump
#     openlmis_requisition.dump
#     openlmis_stockmanagement.dump
#     openlmis_notification.dump
#     openhim_mongo.archive
#     manifest.txt
# =============================================================================
set -euo pipefail

BACKUP_ROOT="${LESOTHO_BACKUP_DIR:-$HOME/lesotho-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

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

# ── Preflight ────────────────────────────────────────────────────────────────
echo "[backup] Checking containers are running ..."
for ctr in "$PG_CONTAINER" "$MONGO_CONTAINER"; do
  if ! docker inspect --format '{{.State.Running}}' "$ctr" 2>/dev/null | grep -q true; then
    echo "[backup] ERROR: container '$ctr' is not running. Start the stack first." >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"
echo "[backup] Saving to: $BACKUP_DIR"

# ── PostgreSQL ───────────────────────────────────────────────────────────────
echo "[backup] Backing up PostgreSQL databases ..."
for db in "${PG_DBS[@]}"; do
  echo "[backup]   pg_dump $db ..."
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$db" > "$BACKUP_DIR/${db}.dump"
done

# ── MongoDB ──────────────────────────────────────────────────────────────────
echo "[backup] Backing up MongoDB ($MONGO_DB) ..."
docker exec "$MONGO_CONTAINER" mongodump \
  --db "$MONGO_DB" \
  --archive \
  --quiet \
  > "$BACKUP_DIR/openhim_mongo.archive"

# ── Manifest ─────────────────────────────────────────────────────────────────
{
  echo "backup_timestamp: $TIMESTAMP"
  echo "backup_dir: $BACKUP_DIR"
  echo "postgres_container: $PG_CONTAINER"
  echo "postgres_user: $PG_USER"
  echo "postgres_databases: ${PG_DBS[*]}"
  echo "mongo_container: $MONGO_CONTAINER"
  echo "mongo_database: $MONGO_DB"
  echo "files:"
  for f in "$BACKUP_DIR"/*.dump "$BACKUP_DIR"/*.archive; do
    size=$(du -sh "$f" 2>/dev/null | cut -f1)
    echo "  - $(basename "$f") ($size)"
  done
} > "$BACKUP_DIR/manifest.txt"

echo ""
echo "[backup] Done."
cat "$BACKUP_DIR/manifest.txt"
