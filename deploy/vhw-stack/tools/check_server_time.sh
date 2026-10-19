#!/usr/bin/env bash
# Show the time, time zone and clock synchronisation of every VHW server.
#
# Run on the jump host (203.0.113.67) as deploy-user:
#   bash check_server_time.sh              # check only (no sudo needed)
#   bash check_server_time.sh --set-tz     # also set time zone Africa/Maseru (asks for sudo)
#
# "drift" is the difference with the jump host's clock in seconds; anything more
# than a few seconds means that clock is wrong (check "synced").
# Changing the time zone only changes how times are shown; the clock itself and
# all data (stored in UTC) stay the same. Containers keep their own zone (UTC).

set -u
TZ_WANTED=Africa/Maseru
SET_TZ=0
[ "${1:-}" = "--set-tz" ] && SET_TZ=1
USER_NAME=${VHW_USER:-deploy-user}

# host  ssh-port  role
SERVERS="
192.0.2.146 22   production
192.0.2.114 22   test
192.0.2.236 22 superset
192.0.2.61  22   proxy+DHIS2
"

remote='printf "%s|%s|%s|%s\n" "$(date +%s)" "$(date "+%Y-%m-%d %H:%M:%S %Z")" \
  "$(timedatectl show -p Timezone --value 2>/dev/null)" \
  "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)/$(timedatectl show -p NTP --value 2>/dev/null)"'

row() {  # role host epoch local tz sync
  local drift="?"
  [[ "$3" =~ ^[0-9]+$ ]] && drift=$(( $3 - $(date +%s) ))
  printf '%-12s %-15s %-25s %-16s %-10s %s\n' "$1" "$2" "$4" "$5" "$6" "$drift"
}

printf '%-12s %-15s %-25s %-16s %-10s %s\n' role host "local time" "time zone" "synced/ntp" "drift(s)"
IFS='|' read -r e l z s <<<"$(bash -c "$remote")"
row "jump host" "$(hostname -I | awk '{print $1}')" "$e" "$l" "$z" "$s"

echo "$SERVERS" | while read -r host port role; do
  [ -z "$host" ] && continue
  out=$(ssh -n -p "$port" -o ConnectTimeout=8 -o BatchMode=no "$USER_NAME@$host" "$remote" 2>/dev/null </dev/null) \
    || { printf '%-12s %-15s %s\n' "$role" "$host" "could not log in (try: ssh -p $port $USER_NAME@$host)"; continue; }
  IFS='|' read -r e l z s <<<"$out"
  row "$role" "$host" "$e" "$l" "$z" "$s"
done

if [ "$SET_TZ" = 1 ]; then
  echo
  echo "Setting time zone $TZ_WANTED (sudo password per server):"
  echo "$SERVERS" | while read -r host port role; do
    [ -z "$host" ] && continue
    echo "== $role $host"
    ssh -t -p "$port" "$USER_NAME@$host" "sudo timedatectl set-timezone $TZ_WANTED && date" </dev/tty \
      || echo "!! $host: not changed"
  done
fi

echo
echo "synced must be 'yes' and drift 0-2 s everywhere. 'ntp' = systemd-timesyncd: 'no' is fine when"
echo "synced is 'yes' (192.0.2.61 keeps time with ntpd instead; do NOT enable timesyncd there)."
echo "If synced is 'no' or drift is more than a few seconds, on that server check:"
echo "  systemctl is-active ntp chrony systemd-timesyncd   (exactly one should be active)"
