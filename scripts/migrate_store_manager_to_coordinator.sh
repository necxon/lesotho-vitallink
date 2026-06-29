#!/usr/bin/env bash
#
# Clean cutover for the removed `store_manager` workflow role.
#
# Runs on the HOST against the live Keycloak. For every realm user that still
# holds the `store_manager` realm role it adds `coordinator` and removes
# `store_manager`, then deletes the `store_manager` role definition.
#
# Idempotent: re-running after the role is gone exits cleanly (nothing to do).
# The web portal already maps a stray store_manager token to coordinator, so this
# is a tidy-up — users keep working throughout.
#
# Usage:
#   # localhost
#   bash scripts/migrate_store_manager_to_coordinator.sh
#   # production
#   KC_URL=https://lesotho-bkm.xyz/auth KC_ADMIN_PASSWORD=*** \
#     bash scripts/migrate_store_manager_to_coordinator.sh
#   # preview only
#   DRY_RUN=1 bash scripts/migrate_store_manager_to_coordinator.sh
#
# Env (defaults):
#   KC_URL             Keycloak base incl. /auth   (http://localhost:8083/auth)
#   KC_ADMIN_PASSWORD  master-realm admin password (admin)
#   REALM              target realm                (opensrp)
#   DRY_RUN            1 = print actions, change nothing
set -uo pipefail

KC_URL="${KC_URL:-http://localhost:8083/auth}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
REALM="${REALM:-opensrp}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s\n' "$*"; }

# ── 1. admin token ───────────────────────────────────────────────────────────
TOKEN=$(curl -s --max-time 15 -X POST \
  "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=${KC_ADMIN_PASSWORD}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
if [[ -z "${TOKEN}" ]]; then
  log "ERROR: could not get a Keycloak admin token — check KC_URL and KC_ADMIN_PASSWORD."
  exit 1
fi
AUTH=(-H "Authorization: Bearer ${TOKEN}")
ADMIN="${KC_URL}/admin/realms/${REALM}"
log "Keycloak: ${ADMIN}"

# ── 2. role representations (id needed for the mapping calls) ────────────────
get_role_id() {
  curl -s "${AUTH[@]}" "${ADMIN}/roles/$1" \
    | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')"
}
SM_ID=$(get_role_id store_manager)
if [[ -z "${SM_ID}" ]]; then
  log "store_manager role not present in realm '${REALM}' — nothing to do."
  exit 0
fi
CO_ID=$(get_role_id coordinator)
if [[ -z "${CO_ID}" ]]; then
  log "ERROR: coordinator role not found — cannot reassign. Aborting."
  exit 1
fi
SM_REP="[{\"id\":\"${SM_ID}\",\"name\":\"store_manager\"}]"
CO_REP="[{\"id\":\"${CO_ID}\",\"name\":\"coordinator\"}]"

# ── 3. reassign every user holding store_manager ─────────────────────────────
USERS_JSON=$(curl -s "${AUTH[@]}" "${ADMIN}/roles/store_manager/users?max=1000")
mapfile -t ROWS < <(printf '%s' "${USERS_JSON}" | python3 -c "import sys,json
try:
    for u in json.load(sys.stdin): print(u['id'], u.get('username',''))
except Exception: pass")
log "Users holding store_manager: ${#ROWS[@]}"

for row in "${ROWS[@]}"; do
  uid="${row%% *}"; uname="${row#* }"
  [[ -z "${uid}" ]] && continue
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "  [dry-run] ${uname}: + coordinator, - store_manager"
    continue
  fi
  curl -s -o /dev/null "${AUTH[@]}" -H "Content-Type: application/json" \
    -X POST   "${ADMIN}/users/${uid}/role-mappings/realm" -d "${CO_REP}"
  curl -s -o /dev/null "${AUTH[@]}" -H "Content-Type: application/json" \
    -X DELETE "${ADMIN}/users/${uid}/role-mappings/realm" -d "${SM_REP}"
  log "  ${uname}: coordinator added, store_manager removed"
done

# ── 4. delete the role definition ────────────────────────────────────────────
if [[ "${DRY_RUN}" == "1" ]]; then
  log "[dry-run] would DELETE realm role store_manager"
  exit 0
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X DELETE "${ADMIN}/roles/store_manager")
log "DELETE role store_manager -> HTTP ${code}"
log "Done."
