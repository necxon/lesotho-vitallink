#!/usr/bin/env bash
# set_web_secret.sh - give the fhir-web client a new secret in this stack's Keycloak,
# store it in .env, and restart the services that use it. The secret is never printed.
#   cd /opt/vhw-stack && sudo bash scripts/set_web_secret.sh      (test, production)
#   cd ~/vhw-preprod && bash scripts/set_web_secret.sh            (preprod, no sudo)
# Run after the first start, once Keycloak has imported the realm. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# KEYCLOAK_BIND is a port (8082) or address:port (preprod: 192.0.2.132:18182)
KC=${KEYCLOAK_BIND:-8082}
[[ "$KC" == *:* ]] || KC=127.0.0.1:$KC
B=http://$KC/auth

code=$(curl -s -o /dev/null -w '%{http_code}' "$B/realms/$KEYCLOAK_REALM")
[[ "$code" == 200 ]] || { echo "realm $KEYCLOAK_REALM not available (HTTP $code) - is Keycloak up and imported?" >&2; exit 1; }

TOKEN=$(curl -s -d client_id=admin-cli -d grant_type=password -d "username=$KC_ADMIN" \
          --data-urlencode "password=$KC_ADMIN_PASSWORD" "$B/realms/master/protocol/openid-connect/token" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
[[ -n "$TOKEN" ]] || { echo "admin login failed" >&2; exit 1; }
auth=(-H "Authorization: Bearer $TOKEN")

cid=$(curl -s "${auth[@]}" "$B/admin/realms/$KEYCLOAK_REALM/clients?clientId=fhir-web" \
      | python3 -c 'import sys,json;l=json.load(sys.stdin);print(l[0]["id"] if l else "")')
[[ -n "$cid" ]] || { echo "client fhir-web not found in realm $KEYCLOAK_REALM" >&2; exit 1; }

secret=$(curl -s -X POST "${auth[@]}" "$B/admin/realms/$KEYCLOAK_REALM/clients/$cid/client-secret" \
         | python3 -c 'import sys,json;print(json.load(sys.stdin).get("value",""))')
[[ -n "$secret" ]] || { echo "could not generate a new secret" >&2; exit 1; }

SECRET="$secret" python3 - <<'EOF'
import os, re
p = ".env"
s = open(p).read()
s, n = re.subn(r"(?m)^WEB_KC_CLIENT_SECRET=.*$", "WEB_KC_CLIENT_SECRET=" + os.environ["SECRET"], s)
if n != 1:
    raise SystemExit("WEB_KC_CLIENT_SECRET line not found in .env")
open(p, "w").write(s)
EOF
chmod 600 .env
unset secret TOKEN
echo "fhir-web has a new secret, stored in .env"

# --force-recreate: a changed .env value alone does not always trigger a recreate
docker compose up -d --force-recreate fhir-web
docker compose restart gateway
echo "fhir-web recreated with the new secret; gateway restarted (reloads the realm's signing keys)"
