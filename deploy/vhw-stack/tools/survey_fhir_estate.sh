#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# survey_fhir_estate.sh — read-only survey of the vhw.gov.ls estate.
#
# Run it on any host inside 192.0.2.0/24. It makes no changes: every check
# is a TCP probe, an HTTP GET or a SELECT count(*).
#
#   bash survey_fhir_estate.sh            # network survey + local containers
#   bash survey_fhir_estate.sh --no-tls   # skip the public https:// vhost checks
#
# What it answers:
#   - which backends are listening, and on which ports
#   - which FHIR servers hold data, and how much
#   - whether the public vhosts resolve to something that works
#   - what is deployed on the host you run it from
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

NO_TLS=0
[[ "${1:-}" == "--no-tls" ]] && NO_TLS=1

CURL="curl -s --max-time 8"
# -n so the survey never blocks on a password prompt; sections that need root
# simply report that they were skipped.
SUDO=""; [[ $EUID -ne 0 ]] && command -v sudo >/dev/null && SUDO="sudo -n"

hr()  { printf '%s\n' "------------------------------------------------------------"; }
hdr() { printf '\n== %s\n' "$*"; }

# ── Backends, from the nginx routing diagram ─────────────────────────────────
#      host             port  what it should be
BACKENDS="
192.0.2.61   80    nginx-http
192.0.2.61   443   nginx-https
192.0.2.114  3000  web
192.0.2.114  8080  hapi-direct
192.0.2.114  8081  gateway
192.0.2.114  8082  keycloak
192.0.2.146  3000  web
192.0.2.146  8080  hapi-direct
192.0.2.146  8081  gateway
192.0.2.146  8082  keycloak
192.0.2.117  8082  keycloak
192.0.2.151  8082  chwtr
192.0.2.236  8088  superset
"

VHOSTS="vhw.gov.ls web.vhw.gov.ls app.vhw.gov.ls bkm.vhw.gov.ls training.vhw.gov.ls"
FHIR_HOSTS="192.0.2.114 192.0.2.146"
RESOURCES="Patient Group Location Task QuestionnaireResponse Encounter Practitioner Organization Observation"

port_open() {  # host port -> 0 if connectable
  if command -v nc >/dev/null; then
    nc -z -w3 "$1" "$2" >/dev/null 2>&1
  else
    timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
  fi
}

hdr "survey run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'from host : %s\n' "$(hostname)"
printf 'addresses : %s\n' "$(hostname -I 2>/dev/null)"

# ── 1. Which backends are listening ──────────────────────────────────────────
hdr "1. backend ports"
printf '%-16s %-6s %-14s %s\n' HOST PORT EXPECTED STATE
hr
while read -r host port what; do
  [[ -z "${host:-}" ]] && continue
  if port_open "$host" "$port"; then state=open; else state=CLOSED; fi
  printf '%-16s %-6s %-14s %s\n' "$host" "$port" "$what" "$state"
done <<< "$BACKENDS"

# ── 2. FHIR servers: are they serving, and do they hold anything ─────────────
hdr "2. FHIR servers (unauthenticated)"
echo "401 on :8081 is normal - that is the OpenSRP gateway refusing anonymous calls."
echo "A count on :8080 means HAPI is reachable without auth (check that is intended)."
for h in $FHIR_HOSTS; do
  for p in 8080 8081; do
    port_open "$h" "$p" || { printf '\n%s:%s  unreachable\n' "$h" "$p"; continue; }
    code=$($CURL -o /dev/null -w '%{http_code}' "http://$h:$p/fhir/metadata")
    printf '\n%s:%s  metadata HTTP %s\n' "$h" "$p" "$code"
    [[ "$code" != "200" ]] && continue
    for r in $RESOURCES; do
      body=$($CURL -w '\n%{http_code}' "http://$h:$p/fhir/$r?_summary=count")
      rcode=$(printf '%s' "$body" | tail -1)
      total=$(printf '%s' "$body" | sed -n 's/.*"total"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)
      # no total means the server answered but would not count - show why
      printf '   %-24s %s\n' "$r" "${total:-HTTP $rcode}"
    done
  done
done

# ── 3. Public vhosts through nginx ───────────────────────────────────────────
if [[ $NO_TLS -eq 0 ]]; then
  hdr "3. public vhosts"
  printf '%-26s %-6s %s\n' VHOST CODE NOTE
  hr
  for v in $VHOSTS; do
    code=$($CURL -o /dev/null -w '%{http_code}' -k "https://$v/")
    case "$code" in
      200|301|302) note="ok" ;;
      502|503)     note="BACKEND DOWN" ;;
      000)         note="no response / dns" ;;
      *)           note="" ;;
    esac
    printf '%-26s %-6s %s\n' "$v" "$code" "$note"
  done
fi

# ── 4. What is deployed on this host ─────────────────────────────────────────
hdr "4. local containers"
if command -v docker >/dev/null; then
  $SUDO docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null \
    || echo "(cannot talk to docker - try with sudo)"
else
  echo "(docker not installed here)"
fi

hdr "5. local listening ports"
if command -v ss >/dev/null; then
  $SUDO ss -ltnp 2>/dev/null | grep -E ':(3000|8080|8081|8082|8088|5432)\b' || echo "(none of the expected ports)"
else
  echo "(ss not available)"
fi

# ── 6. Database counts, if a hapi-postgres lives here ────────────────────────
hdr "6. local FHIR database"
if command -v docker >/dev/null && $SUDO docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hapi-postgres$'; then
  PGUSER=$($SUDO docker inspect hapi-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')
  PGDB=$($SUDO docker inspect hapi-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p')
  printf 'container hapi-postgres  user=%s  db=%s\n' "${PGUSER:-?}" "${PGDB:-?}"
  $SUDO docker exec hapi-postgres psql -U "${PGUSER:-hapi}" -d "${PGDB:-hapidata}" -t -A -c \
    "SELECT res_type || ' ' || count(*) FROM hfj_resource WHERE res_deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;" \
    2>/dev/null | sed 's/^/   /' || echo "   (query failed)"
  $SUDO docker exec hapi-postgres psql -U "${PGUSER:-hapi}" -d "${PGDB:-hapidata}" -t -A -c \
    "SELECT 'database size ' || pg_size_pretty(pg_database_size(current_database()));" 2>/dev/null | sed 's/^/   /'
else
  echo "(no hapi-postgres container on this host)"
fi

hdr "6b. host-level postgres"
if command -v psql >/dev/null; then
  $SUDO -u postgres psql -t -A -c '\l' 2>/dev/null | cut -d'|' -f1 | sed 's/^/   /' || echo "   (cannot query)"
else
  echo "(no host postgres client)"
fi

hdr "done"
echo "Empty FHIR counts plus a 502 on the matching vhost usually means the host"
echo "is missing its gateway and web containers, not that data was lost."
