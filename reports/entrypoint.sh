#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh - run the due reports once a day, and on demand.
#
# One cron entry, not five. run_reports.py decides which reports are due from
# the date, so the schedule lives beside each report definition instead of in a
# crontab that has to be kept in step with it.
#
# The portal or an operator can ask for an immediate run by dropping a file in
# REPORT_DIR, the same trigger mechanism the backup engine uses, so this
# container needs no listening port.
# =============================================================================
set -euo pipefail

REPORT_DIR="${REPORT_DIR:-/reports}"
REPORT_CRON="${REPORT_CRON:-0 6 * * *}"
mkdir -p "$REPORT_DIR"

mkdir -p /var/spool/cron/crontabs /etc/reports
export -p > /etc/reports/env.sh
chmod 600 /etc/reports/env.sh

cat > /var/spool/cron/crontabs/root <<CRON
${REPORT_CRON} . /etc/reports/env.sh; /usr/local/bin/run_reports.py >> ${REPORT_DIR}/reports.log 2>&1
CRON
chmod 600 /var/spool/cron/crontabs/root

echo "[reports] schedule: ${REPORT_CRON} (TZ=${TZ:-UTC})"
echo "[reports] output:   ${REPORT_DIR}"
/usr/local/bin/run_reports.py --list
crond -b -l 8

echo "[reports] watching for on-demand runs"
while true; do
  if [ -f "${REPORT_DIR}/.run-now" ]; then
    rm -f "${REPORT_DIR}/.run-now"
    echo "[reports] on-demand run requested"
    /usr/local/bin/run_reports.py --all >> "${REPORT_DIR}/reports.log" 2>&1 || true
  fi
  sleep 5
done
