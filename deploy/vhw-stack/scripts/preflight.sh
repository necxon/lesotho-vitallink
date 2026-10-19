#!/usr/bin/env bash
# preflight.sh - is this host ready to start the stack? Read-only: starts, stops
# and creates nothing.
#   cd /opt/vhw-stack && sudo bash scripts/preflight.sh
set -uo pipefail
cd "$(dirname "$0")/.."

ready=1
ok()    { printf '  ok     %s\n' "$*"; }
block() { printf '  BLOCK  %s\n' "$*"; ready=0; }
note()  { printf '  note   %s\n' "$*"; }

echo "settings"
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
  [[ $(stat -c %a .env) == 600 ]] && ok ".env present, mode 600" || note ".env is readable by others: chmod 600 .env"
  for v in API_HOST AUTH_HOST WEB_HOST HAPI_VERSION KEYCLOAK_VERSION GATEWAY_VERSION FHIR_WEB_VERSION \
           HAPI_DB_PASSWORD KC_DB_PASSWORD KC_ADMIN_PASSWORD WEB_SESSION_SECRET ROOT_LOCATION COMMODITY_LIST; do
    [[ -n "${!v:-}" ]] || block "$v is empty in .env"
  done
  [[ -n "${WEB_KC_CLIENT_SECRET:-}" ]] && ok "WEB_KC_CLIENT_SECRET set" \
    || note "WEB_KC_CLIENT_SECRET empty - expected until the realm is imported (portal login needs it)"
  docker compose config --quiet 2>/dev/null && ok "docker-compose.yml valid with this .env" || block "docker compose config fails"
else
  block "no .env - run scripts/init_env.sh"
fi

echo "realm"
realm=$(ls keycloak/import/*.json 2>/dev/null | head -1)
if [[ -n "$realm" ]]; then
  ok "realm file $realm"
  # Keycloak runs as uid 1000 inside its container; a root-only file cannot be imported
  owner=$(stat -c %u "$realm")
  [[ "$owner" == 1000 || $(( 8#$(stat -c %a "$realm") & 4 )) -ne 0 ]]     && ok "realm file readable by Keycloak (uid 1000)"     || block "realm file not readable by Keycloak - sudo chown 1000 $realm"
  grep -q '"frontendUrl"' "$realm" && block "$realm sets frontendUrl - remove it (README step 3)"
  grep -q "${WEB_HOST:-web.vhw.gov.ls}" "$realm" && ok "fhir-web client allows https://${WEB_HOST:-}" \
    || block "fhir-web client in $realm does not list https://${WEB_HOST:-web.vhw.gov.ls} (README step 3)"
else
  block "no realm export in keycloak/import/ (README step 3)"
fi

echo "images"
for img in "hapiproject/hapi:${HAPI_VERSION:-}" "onaio/fhir-gateway-plugin:${GATEWAY_VERSION:-}" \
           "opensrp/web:${FHIR_WEB_VERSION:-}" "vhw-keycloak:${KEYCLOAK_VERSION:-}" postgres:16-alpine postgres:15-alpine; do
  docker image inspect "$img" >/dev/null 2>&1 && ok "$img" || block "$img not present - docker compose pull / build keycloak"
done

echo "ports (the stack needs these free when it starts)"
for p in 8080 8081 8082 3000; do
  who=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E "(0\.0\.0\.0|127\.0\.0\.1|\[::\]):$p->" | cut -d' ' -f1 | sort -u | tr '\n' ' ')
  if [[ -n "$who" ]]; then block "port $p used by container: $who"
  elif ss -ltn 2>/dev/null | grep -qE "[:.]$p\s"; then block "port $p used by a host process"
  else ok "port $p free"; fi
done

echo "host"
avail=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc 0-9)
[[ -n "$avail" && $avail -ge 20 ]] && ok "${avail}G free for docker" || note "only ${avail:-?}G free under /var/lib/docker"
mem=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
[[ $mem -ge 12 ]] && ok "${mem}G RAM" || note "${mem}G RAM - HAPI alone is set to use up to 8G"
for h in $(printf '%s\n' "${API_HOST:-}" "${AUTH_HOST:-}" "${WEB_HOST:-}" | sort -u); do
  getent hosts "$h" >/dev/null && ok "$h resolves" || block "$h does not resolve from this host (the gateway must reach AUTH_HOST)"
done

echo
[[ $ready -eq 1 ]] && echo "READY - nothing blocks 'docker compose up -d'" || echo "NOT READY - resolve the BLOCK lines first"
