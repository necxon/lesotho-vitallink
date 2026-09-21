#!/usr/bin/env bash
# =============================================================================
# backup.sh - full backup of a single-server VitalLink deployment.
#
# Runs INSIDE the bkm-backup container, on a schedule (see entrypoint.sh) or on
# demand from the Administrator Portal. Do not run it from the host - the host
# has no route to the databases; use `make backup`, which execs into here.
#
# What it captures, and why each part matters:
#
#   health-db-postgres   hapi_fhir  - every patient, stock Observation and the
#                                     app configuration Binaries
#                        keycloak   - every user account and credential
#                        opensrp    - practitioners, teams
#                        dhis2      - aggregate reporting
#                        mediator   - order buffer, dispatch history, SOH
#                        superset   - dashboards
#   openlmis db          open_lmis  - facilities, products, stock cards, requisitions
#   db-mongo             openhim    - channels, clients, transaction log
#   config files         compose files, config/, mappings, mediator data
#
# Databases are ENUMERATED, not listed. A hardcoded list is how the previous
# version of this script came to omit hapi_fhir and keycloak - the two databases
# whose loss would end the deployment - while reporting success. Anything that
# exists on either server is dumped, so adding a database cannot silently fall
# out of the backup.
#
# Exit codes: 0 = complete, 1 = failed. A run that could not dump everything is
# reported as failed even though an archive was written, because a backup you
# cannot fully trust must not look like one you can.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-14}"

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

# Config capture. /project is the repo root, mounted read-only.
INCLUDE_CONFIG="${BACKUP_INCLUDE_CONFIG:-true}"
INCLUDE_ENV="${BACKUP_INCLUDE_ENV:-true}"
PROJECT_DIR="${PROJECT_DIR:-/project}"

# Databases never worth dumping, space separated.
EXCLUDE_DBS="${BACKUP_EXCLUDE_DBS:-}"

TS=$(date +%Y%m%d_%H%M%S)
NAME="vitallink-${TS}"
ARCHIVE="${BACKUP_DIR}/${NAME}.tar.gz"
STATUS="${BACKUP_DIR}/status.json"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_EPOCH=$(date +%s)

WORK=$(mktemp -d)

WARNINGS=""
DUMPED=""

log()  { echo "[backup $(date +%H:%M:%S)] $*"; }
warn() { WARNINGS="${WARNINGS}${WARNINGS:+; }$*"; log "WARNING: $*"; }

# JSON string escaping, enough for the messages this script produces: quotes,
# backslashes and newlines are the only characters that turn up in psql errors.
jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' '; }

# A single status document the portal reads. Written at the start too, so a run
# in progress is visible rather than looking like nothing is happening.
write_status() {
  local state="$1"
  local err="${2:-}"
  local bytes=0
  local finished=""
  [ -f "$ARCHIVE" ] && bytes=$(stat -c %s "$ARCHIVE" 2>/dev/null || echo 0)
  [ "$state" != "running" ] && finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf '{\n'
    printf '  "state": "%s",\n'            "$state"
    printf '  "archive": "%s.tar.gz",\n'   "$NAME"
    printf '  "startedAt": "%s",\n'        "$STARTED"
    printf '  "finishedAt": "%s",\n'       "$finished"
    printf '  "durationSeconds": %s,\n'    "$(( $(date +%s) - START_EPOCH ))"
    printf '  "bytes": %s,\n'              "$bytes"
    printf '  "databases": "%s",\n'        "$(jesc "$DUMPED")"
    printf '  "warnings": "%s",\n'         "$(jesc "$WARNINGS")"
    printf '  "error": "%s",\n'            "$(jesc "$err")"
    printf '  "schedule": "%s",\n'         "$(jesc "${BACKUP_CRON:-}")"
    printf '  "keep": %s\n'                "$KEEP"
    printf '}\n'
  } > "${STATUS}.tmp"
  mv "${STATUS}.tmp" "$STATUS"
}

cleanup() { rm -rf "$WORK"; }

fail() {
  log "FAILED: $1"
  write_status failed "$1"
  cleanup
  exit 1
}

trap cleanup EXIT
trap 'fail "interrupted"' INT TERM

mkdir -p "$BACKUP_DIR"

# Keep the log from growing without limit. It shares a disk with the archives,
# and on a single server filling that disk takes the databases down with it.
LOGFILE="${BACKUP_DIR}/backup.log"
if [ -f "$LOGFILE" ] && [ "$(stat -c %s "$LOGFILE")" -gt 5242880 ]; then
  tail -n 2000 "$LOGFILE" > "${LOGFILE}.tmp" && mv "${LOGFILE}.tmp" "$LOGFILE"
fi

write_status running

log "Starting backup ${NAME}"

# -- PostgreSQL --------------------------------------------------------------
# Dumped one database at a time in custom format. Each dump is internally
# consistent; the set of them is not a single point-in-time snapshot across
# databases, which no amount of scripting can fix without stopping the stack.
# In practice the seconds of skew do not matter here, because these databases
# hold no foreign keys into each other - the mediator is what joins them.
dump_cluster() {
  local label="$1" host="$2" port="$3" user="$4" pass="$5" outdir="$6"
  export PGPASSWORD="$pass"

  if ! pg_isready -h "$host" -p "$port" -U "$user" -t 15 >/dev/null 2>&1; then
    warn "${label} (${host}:${port}) is unreachable - NOT backed up"
    return 1
  fi

  mkdir -p "$outdir"
  local dbs
  if ! dbs=$(psql -h "$host" -p "$port" -U "$user" -d postgres -tAc \
       "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"); then
    warn "${label}: could not list databases"
    return 1
  fi

  local db x skip
  for db in $dbs; do
    skip=false
    for x in $EXCLUDE_DBS; do
      [ "$db" = "$x" ] && skip=true
    done
    if [ "$skip" = "true" ]; then
      log "  skip ${db} (excluded)"
      continue
    fi

    log "  pg_dump ${label}/${db}"
    # -Z 0: the outer tar is gzipped, so compressing twice only burns CPU.
    if pg_dump -h "$host" -p "$port" -U "$user" -Fc -Z 0 \
         -f "${outdir}/${db}.dump" "$db" 2>"${WORK}/err.txt"; then
      DUMPED="${DUMPED}${DUMPED:+ }${label}/${db}"
    else
      warn "${label}/${db} dump failed: $(head -c 200 "${WORK}/err.txt")"
      rm -f "${outdir}/${db}.dump"
    fi
  done
  unset PGPASSWORD
}

log "PostgreSQL: health cluster (${HEALTH_DB_HOST})"
dump_cluster health "$HEALTH_DB_HOST" "$HEALTH_DB_PORT" "$HEALTH_DB_USER" "$HEALTH_DB_PASS" \
  "${WORK}/postgres-health" || true

log "PostgreSQL: OpenLMIS cluster (${LMIS_DB_HOST})"
dump_cluster openlmis "$LMIS_DB_HOST" "$LMIS_DB_PORT" "$LMIS_DB_USER" "$LMIS_DB_PASS" \
  "${WORK}/postgres-openlmis" || true

# The deployment is not recoverable without these two, so their absence is a
# failed backup, not a warning buried in a log nobody reads.
for critical in postgres-health/hapi_fhir.dump postgres-health/keycloak.dump; do
  [ -s "${WORK}/${critical}" ] || fail "${critical} is missing - refusing to call this a backup"
done

# -- MongoDB (OpenHIM) -------------------------------------------------------
log "MongoDB: ${MONGO_DB}"
mkdir -p "${WORK}/mongo"
if mongodump --host "$MONGO_HOST" --port "$MONGO_PORT" --db "$MONGO_DB" \
     --archive="${WORK}/mongo/openhim.archive" --gzip --quiet 2>"${WORK}/err.txt"; then
  DUMPED="${DUMPED}${DUMPED:+ }mongo/${MONGO_DB}"
else
  warn "mongodump failed: $(head -c 200 "${WORK}/err.txt")"
fi

# -- Configuration -----------------------------------------------------------
# Dumps alone do not rebuild a server. The compose files, the config/ tree and
# the mediator's mappings are what turn a pile of databases back into a
# deployment.
if [ "$INCLUDE_CONFIG" = "true" ] && [ -d "$PROJECT_DIR" ]; then
  log "Configuration files"
  mkdir -p "${WORK}/config"
  for item in docker-compose.yml docker-compose.override.yml channels.json params.xml \
              config mediator/mappings.json mediator/data; do
    if [ -e "${PROJECT_DIR}/${item}" ]; then
      mkdir -p "${WORK}/config/$(dirname "$item")"
      cp -a "${PROJECT_DIR}/${item}" "${WORK}/config/${item}"
    fi
  done
  if [ "$INCLUDE_ENV" = "true" ] && [ -f "${PROJECT_DIR}/.env" ]; then
    cp -a "${PROJECT_DIR}/.env" "${WORK}/config/.env"
  fi
  DUMPED="${DUMPED}${DUMPED:+ }config"
elif [ "$INCLUDE_CONFIG" = "true" ]; then
  warn "${PROJECT_DIR} is not mounted - configuration files NOT backed up"
fi

# -- Manifest ----------------------------------------------------------------
{
  echo "name: ${NAME}"
  echo "created: ${STARTED}"
  echo "source_health: ${HEALTH_DB_HOST}:${HEALTH_DB_PORT}"
  echo "source_openlmis: ${LMIS_DB_HOST}:${LMIS_DB_PORT}"
  echo "source_mongo: ${MONGO_HOST}:${MONGO_PORT}"
  echo "pg_dump_version: $(pg_dump --version | awk '{print $3}')"
  echo "contains_credentials: $([ -f "${WORK}/config/.env" ] && echo yes || echo no)"
  echo "contents:"
  # Busybox find has no -printf, so size each file with stat instead.
  ( cd "$WORK" && find . -type f ! -name err.txt | sort | while read -r f; do
      printf '  - %s (%s bytes)\n' "$f" "$(stat -c %s "$f")"
    done )
  [ -n "$WARNINGS" ] && echo "warnings: ${WARNINGS}"
} > "${WORK}/manifest.txt"

rm -f "${WORK}/err.txt"

# -- Archive -----------------------------------------------------------------
log "Writing ${ARCHIVE}"
tar -czf "$ARCHIVE" -C "$WORK" . || fail "could not write the archive"
chmod 600 "$ARCHIVE"

# Verify by reading it back. An archive that cannot be listed is not a backup,
# and finding that out now is far better than finding it out during a restore.
tar -tzf "$ARCHIVE" >/dev/null 2>&1 || fail "the archive it just wrote is unreadable"
sha256sum "$ARCHIVE" | awk '{print $1}' > "${ARCHIVE}.sha256"
cp "${WORK}/manifest.txt" "${BACKUP_DIR}/${NAME}.manifest.txt"

SIZE=$(du -h "$ARCHIVE" | cut -f1)

# -- Retention ---------------------------------------------------------------
# Pruned only after the new archive is verified, so a failing backup can never
# delete the last good one.
if [ "$KEEP" -gt 0 ]; then
  ls -1t "${BACKUP_DIR}"/vitallink-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    log "Pruning $(basename "$old")"
    rm -f "$old" "${old}.sha256" "${old%.tar.gz}.manifest.txt"
  done
fi

if [ -n "$WARNINGS" ]; then
  write_status failed "completed with warnings: ${WARNINGS}"
  log "Done with WARNINGS: ${ARCHIVE} (${SIZE})"
  exit 1
fi

write_status ok
log "Done: ${ARCHIVE} (${SIZE})"
