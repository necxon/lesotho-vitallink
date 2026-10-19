#!/usr/bin/env bash
# backup.sh - dump both databases to backups/<timestamp>/, keep the last KEEP_DAYS days.
#   cd deploy/vhw-stack && bash scripts/backup.sh
# Nightly, from root's crontab (adjust the path):
#   15 1 * * * cd /opt/vhw-stack && bash scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
KEEP_DAYS=${KEEP_DAYS:-14}

dir="backups/$(date +%Y%m%d-%H%M)"
mkdir -p "$dir"
docker compose exec -T hapi-postgres     pg_dump -U "$HAPI_DB_USER" -Fc "$HAPI_DB_NAME" > "$dir/hapi.dump"
docker compose exec -T keycloak-postgres pg_dump -U "$KC_DB_USER"   -Fc keycloak        > "$dir/keycloak.dump"

for f in "$dir"/*.dump; do
  [[ -s "$f" ]] || { echo "empty dump: $f" >&2; exit 1; }
done
(cd "$dir" && sha256sum *.dump > SHA256SUMS)
echo "$(date -u +%FT%TZ) backup ok $dir $(du -sh "$dir" | cut -f1)"

find backups -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
