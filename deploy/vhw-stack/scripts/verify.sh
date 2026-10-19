#!/usr/bin/env bash
# verify.sh - check the stack end to end. Read-only.
#   cd deploy/vhw-stack && bash scripts/verify.sh
# Checks each service on this host, then the same through the public hostnames,
# and that the hostnames agree with each other (the usual cause of login failures).
set -uo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "no .env here" >&2; exit 1; }
set -a; . ./.env; set +a

# *_BIND is a port (test: 8082) or address:port (preprod: 127.0.0.1:18180)
hostport() { local b=$1; [[ "$b" == *:* ]] && echo "$b" || echo "127.0.0.1:$b"; }
HAPI=http://$(hostport "${HAPI_BIND:-127.0.0.1:8080}")
KC=http://$(hostport "${KEYCLOAK_BIND:-8082}")
GW=http://$(hostport "${GATEWAY_BIND:-8081}")
WEB=http://$(hostport "${WEB_BIND:-3000}")

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
check() {  # label, expected-codes-regex, curl args...
  local label=$1 want=$2; shift 2
  local c; c=$(code "$@")
  [[ $c =~ ^($want)$ ]] && ok "$label ($c)" || bad "$label (got $c, want $want)"
}

echo "containers"
docker compose ps --format '  {{.Service}}\t{{.State}}\t{{.Health}}'

echo "on this host"
check "hapi metadata"                  200     $HAPI/fhir/metadata
check "keycloak realm $KEYCLOAK_REALM" 200     "$KC/auth/realms/$KEYCLOAK_REALM"
check "gateway refuses anonymous"      "401|403" $GW/fhir/Patient
check "fhir-web"                       "200|302" $WEB/

echo "consistency"
addr=$(curl -s --max-time 15 $HAPI/fhir/metadata | python3 -c 'import sys,json;print(json.load(sys.stdin).get("implementation",{}).get("url",""))' 2>/dev/null)
[[ "$addr" == "https://$API_HOST/fhir" ]] && ok "hapi address $addr" || bad "hapi address is '$addr', want https://$API_HOST/fhir"
iss=$(curl -s --max-time 15 "$KC/auth/realms/$KEYCLOAK_REALM/.well-known/openid-configuration" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["issuer"])' 2>/dev/null)
want="https://$AUTH_HOST/auth/realms/$KEYCLOAK_REALM"
[[ "$iss" == "$want" ]] && ok "token issuer $iss" || bad "token issuer is '$iss', gateway expects $want"

echo "through the public hostnames"
check "https://$API_HOST/fhir (needs a token)"  "401|403" "https://$API_HOST/fhir/Patient"
check "https://$AUTH_HOST/auth realm"           200       "https://$AUTH_HOST/auth/realms/$KEYCLOAK_REALM"
check "https://$WEB_HOST portal"                "200|302" "https://$WEB_HOST/"

if [[ -n "${BUILDER_BIND:-}" ]]; then
  check "VitalLink web (builder)"      200       "http://$(hostport "$BUILDER_BIND")/"
fi

echo "data"
for r in Patient Group Location Practitioner Composition Binary Questionnaire; do
  n=$(curl -s --max-time 30 "$HAPI/fhir/$r?_summary=count" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("total","?"))' 2>/dev/null)
  printf '  %-14s %s\n' "$r" "${n:-?}"
done

[[ $fail -eq 0 ]] && echo "all checks passed" || { echo "some checks failed"; exit 1; }
