#!/usr/bin/env bash
#
# NEC XON (c) Copyright 2025.
#
# Phase-1 role migration (post site-visit): create the store_manager + coordinator
# Keycloak realm roles, then RENAME + reassign the existing users:
#   supervisor   -> username "store_manager"   role store_manager
#   fw.clinic.a  -> username "coordinator"      role coordinator
#   fw.clinic.b  -> username "coordinator.b"    role coordinator
#   opensrp-admin (kept)                        role store_manager (was facility_worker)
#   facility-worker (legacy, kept)              role coordinator   (was facility_worker)
#   vhw users (thabo.mokoena / vhw.clinic.b)    unchanged
#
# Renaming preserves each user's Keycloak id (sub), so the FHIR Practitioner link
# and the mediator performer mappings stay intact — only the LOGIN name changes.
#
# Idempotent + re-runnable. Run on the server after pulling feat/roles-spec, then
# rebuild bkm-mediator + bkm-web and re-test. (Keycloak won't re-import an existing
# realm, so this Admin-API migration is how a live realm picks up the changes.)
#
# Usage:  bash scripts/migrate_roles_phase1.sh
# Env:    KC_URL (default http://localhost:8083/auth)  KC_ADMIN_PASSWORD (else read from container)
set -euo pipefail

KC="${KC_URL:-http://localhost:8083/auth}"
REALM=opensrp
KCPW="${KC_ADMIN_PASSWORD:-$(docker exec keycloak printenv KEYCLOAK_ADMIN_PASSWORD 2>/dev/null || true)}"

TOK=$(curl -s -d "grant_type=password&client_id=admin-cli&username=admin&password=${KCPW}" \
  "$KC/realms/master/protocol/openid-connect/token" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
[ -z "$TOK" ] && { echo "ERROR: could not get Keycloak admin token (check KC_ADMIN_PASSWORD / KC_URL)"; exit 1; }

H=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")

# 0. Allow username edits — Keycloak realms default to editUsernameAllowed=false,
#    which makes the username immutable and silently rejects the rename PUT below.
curl -s -o /dev/null "${H[@]}" -X PUT "$KC/admin/realms/$REALM" -d '{"realm":"'"$REALM"'","editUsernameAllowed":true}'
echo "enabled editUsernameAllowed on realm $REALM"

# 1. Create the new realm roles (ignore 409 if they already exist)
for r in store_manager coordinator admin; do
  curl -s -o /dev/null "${H[@]}" -X POST "$KC/admin/realms/$REALM/roles" -d "{\"name\":\"$r\"}" || true
  echo "ensured role: $r"
done

uid()    { curl -s "${H[@]}" "$KC/admin/realms/$REALM/users?username=$1&exact=true" \
             | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')"; }
roleobj(){ curl -s "${H[@]}" "$KC/admin/realms/$REALM/roles/$1"; }
grant()  { curl -s -o /dev/null "${H[@]}" -X POST   "$KC/admin/realms/$REALM/users/$1/role-mappings/realm" -d "[$(roleobj "$2")]"; }
revoke() { curl -s -o /dev/null "${H[@]}" -X DELETE "$KC/admin/realms/$REALM/users/$1/role-mappings/realm" -d "[$(roleobj "$2")]" 2>/dev/null || true; }

# rename: GET full user rep, swap username, PUT back (preserves all other fields + the id/sub).
# Echoes the PUT HTTP code so the caller can detect a silent rejection.
rename_user() { # id new_username
  local body
  body=$(curl -s "${H[@]}" "$KC/admin/realms/$REALM/users/$1" \
    | python3 -c "import sys,json;u=json.load(sys.stdin);u['username']='$2';print(json.dumps(u))")
  curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X PUT "$KC/admin/realms/$REALM/users/$1" -d "$body"
}

migrate() { # old_username new_username role
  local id rc; id=$(uid "$1"); [ -z "$id" ] && id=$(uid "$2")
  if [ -z "$id" ]; then echo "  (skip $1/$2 — not found)"; return; fi
  rc=204
  [ "$1" != "$2" ] && rc=$(rename_user "$id" "$2")
  grant  "$id" "$3"
  revoke "$id" facility_worker   # clean cutover — drop the legacy workflow role
  case "$rc" in
    2*) echo "  $1 -> user '$2' (role $3)";;
    *)  echo "  WARN: rename $1 -> '$2' returned HTTP $rc (role $3 still applied); check editUsernameAllowed";;
  esac
}

echo "Renaming + reassigning users:"
migrate supervisor      store_manager  store_manager
migrate fw.clinic.a     coordinator    coordinator
migrate fw.clinic.b     coordinator.b  coordinator
migrate opensrp-admin   bkm-admin      admin           # system admin (renamed from opensrp-admin)
# the admin must hold 'admin' only among the workflow roles
_aid=$(uid bkm-admin); [ -n "$_aid" ] && { revoke "$_aid" store_manager; revoke "$_aid" coordinator; }
migrate facility-worker facility-worker coordinator    # legacy generic user, off facility_worker

echo "Done. (vhw users keep their names + 'vhw'.) Re-login on web/devices to pick up the changes."
echo "NOTE: a Coordinator also needs the app's MANAGE_*/FIELD_WORKER roles + a PractitionerDetail to use the BKM mobile app — that's a follow-up; this sets the workflow/web role + login name."
