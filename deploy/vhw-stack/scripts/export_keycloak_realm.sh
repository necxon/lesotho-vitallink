#!/usr/bin/env bash
# export_keycloak_realm.sh - export the opensrp realm from a running Keycloak container.
#
# For the host running the production Keycloak (192.0.2.117). Run as root:
#   sudo bash export_keycloak_realm.sh            # check only: shows what it would do
#   sudo bash export_keycloak_realm.sh --run      # performs the export
#
# Writes to /root/keycloak-export/ (readable by root only):
#   opensrp-realm-full-<time>.json   realm + users with ids and password hashes, client
#                                    secrets, signing keys. For moving production logins
#                                    to another Keycloak. Handle like a password file:
#                                    copy host to host, never email, delete after import.
#   opensrp-realm-settings-<time>.json  the same without users, credentials, client
#                                    secrets or keys. For setting up the test environment.
#
# Read-only for Keycloak: runs Keycloak's own export tool next to the running server.
# Does not stop, restart or change the server, its settings or its data.
set -euo pipefail

REALM=${REALM:-opensrp}
RUN=0; [[ "${1:-}" == "--run" ]] && RUN=1
OUT_DIR=/root/keycloak-export
STAMP=$(date +%Y%m%d-%H%M)

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

KC=${KC_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -i keycloak | grep -viE 'postgres|db' | head -1)}
[[ -n "$KC" ]] || { echo "no running Keycloak container found (set KC_CONTAINER=name)" >&2; exit 1; }

image=$(docker inspect -f '{{.Config.Image}}' "$KC")
cmd=$(docker inspect -f '{{json .Config.Cmd}}' "$KC")
version=$(docker exec "$KC" /opt/keycloak/bin/kc.sh --version 2>/dev/null | grep -m1 -oE 'Keycloak [0-9.]+' || echo "unknown")
optimized=""; [[ "$cmd" == *--optimized* ]] && optimized="--optimized"

echo "host       $(hostname) ($(hostname -I | awk '{print $1}'))"
echo "container  $KC"
echo "image      $image"
echo "version    $version"
echo "realm      $REALM"
echo "output     $OUT_DIR"

if [[ $RUN -eq 0 ]]; then
  echo
  echo "check only. With --run this will:"
  echo "  1. run inside $KC: kc.sh export $optimized --realm $REALM --users realm_file"
  echo "  2. copy the result to $OUT_DIR (mode 600) and remove it from the container"
  echo "  3. write a settings-only copy without users, credentials, secrets and keys"
  echo "  4. print counts and checksums (no user details, no secrets)"
  exit 0
fi

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
tmp="/tmp/opensrp-export-$STAMP.json"
full="$OUT_DIR/opensrp-realm-full-$STAMP.json"
settings="$OUT_DIR/opensrp-realm-settings-$STAMP.json"

echo
echo "exporting (a second Keycloak process reads the database; the server keeps running)..."
# --optimized only when the server itself runs optimized: then the export reuses the
# server's build. Without it, kc.sh would rebuild the server's configuration first.
if ! docker exec "$KC" /opt/keycloak/bin/kc.sh export $optimized \
      --realm "$REALM" --users realm_file --file "$tmp" > "$OUT_DIR/export-$STAMP.log" 2>&1; then
  echo "export FAILED - log: $OUT_DIR/export-$STAMP.log (last lines below). Nothing was changed." >&2
  tail -15 "$OUT_DIR/export-$STAMP.log" >&2
  exit 1
fi

umask 077
docker cp "$KC:$tmp" "$full"
docker exec "$KC" rm -f "$tmp" 2>/dev/null || docker exec -u 0 "$KC" rm -f "$tmp" 2>/dev/null || true
chmod 600 "$full"

python3 - "$full" "$settings" <<'EOF'
import json, sys
full, settings = sys.argv[1], sys.argv[2]
r = json.load(open(full))
users = r.get("users", [])
clients = r.get("clients", [])
print(f"realm      {r.get('realm')}  (enabled={r.get('enabled')})")
print(f"users      {len(users)}  with passwords: {sum(1 for u in users if any(c.get('type') == 'password' for c in u.get('credentials', [])))}")
print(f"clients    {len(clients)}: {', '.join(sorted(c['clientId'] for c in clients))}")
print(f"roles      {len(r.get('roles', {}).get('realm', []))} realm roles")
print(f"groups     {len(r.get('groups', []))}")
fe = (r.get("attributes") or {}).get("frontendUrl")
print(f"frontendUrl {fe or 'not set'}")

s = dict(r)
s.pop("users", None)
s.pop("federatedUsers", None)
comps = dict(s.get("components") or {})
comps.pop("org.keycloak.keys.KeyProvider", None)       # signing keys stay with production
s["components"] = comps
for c in s.get("clients", []):
    if "secret" in c:
        c["secret"] = "**********"                     # regenerate in the test Keycloak
json.dump(s, open(settings, "w"), indent=1)
EOF
chmod 600 "$settings"

echo
( cd "$OUT_DIR" && sha256sum "$(basename "$full")" "$(basename "$settings")" )
ls -la "$OUT_DIR"
echo
echo "done. full export (sensitive): $full"
echo "      settings only (for test): $settings"
