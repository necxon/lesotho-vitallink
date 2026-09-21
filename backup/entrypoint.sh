#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh - keeps the backup engine running on a schedule, and picks up
# on-demand runs requested from the Administrator Portal.
#
# Two ways in, one engine:
#   cron      BACKUP_CRON (default 02:00 daily) runs backup.sh unattended
#   trigger   the mediator drops a .run-now file in BACKUP_DIR when an
#             administrator presses "Back up now"
#
# The portal triggers a backup through a file rather than by calling this
# container over HTTP, so this container needs no listening port, no auth of its
# own, and no route from anywhere except the shared volume. The thing holding
# every credential in the deployment should be as hard to reach as possible.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_CRON="${BACKUP_CRON:-0 2 * * *}"
export BACKUP_CRON

mkdir -p "$BACKUP_DIR"

# A status file from the moment the container starts, so the portal can say
# "no backup yet" instead of failing to read anything at all.
if [ ! -f "${BACKUP_DIR}/status.json" ]; then
  cat > "${BACKUP_DIR}/status.json" <<EOF
{
  "state": "never",
  "archive": "",
  "startedAt": "",
  "finishedAt": "",
  "durationSeconds": 0,
  "bytes": 0,
  "databases": "",
  "warnings": "",
  "error": "",
  "schedule": "${BACKUP_CRON}",
  "keep": ${BACKUP_KEEP:-14}
}
EOF
fi

# -- Scheduled runs ----------------------------------------------------------
# The cron job runs a login shell so the container's environment (database
# hosts, passwords) reaches backup.sh. crond gives a job almost no environment
# of its own, which is a classic way for a scheduled backup to fail nightly
# while the same command works by hand.
mkdir -p /var/spool/cron/crontabs /etc/backup
export -p > /etc/backup/env.sh
chmod 600 /etc/backup/env.sh

cat > /var/spool/cron/crontabs/root <<EOF
${BACKUP_CRON} . /etc/backup/env.sh; /usr/local/bin/backup.sh >> ${BACKUP_DIR}/backup.log 2>&1
EOF
chmod 600 /var/spool/cron/crontabs/root

echo "[backup] schedule: ${BACKUP_CRON} (TZ=${TZ:-UTC})"
echo "[backup] archives: ${BACKUP_DIR}, keeping ${BACKUP_KEEP:-14}"
crond -b -l 8

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  echo "[backup] BACKUP_ON_START is set - running one now"
  /usr/local/bin/backup.sh >> "${BACKUP_DIR}/backup.log" 2>&1 || true
fi

# -- On-demand runs ----------------------------------------------------------
echo "[backup] watching for on-demand requests"
while true; do
  if [ -f "${BACKUP_DIR}/.run-now" ]; then
    # Removed before the run, not after: if backup.sh dies the request must not
    # be retried forever in a loop.
    rm -f "${BACKUP_DIR}/.run-now"
    echo "[backup] on-demand backup requested"
    /usr/local/bin/backup.sh >> "${BACKUP_DIR}/backup.log" 2>&1 || true
  fi
  sleep 5
done
