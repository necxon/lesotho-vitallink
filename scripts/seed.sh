#!/usr/bin/env bash
# =============================================================================
# seed.sh — Idempotent post-startup seeder for the Lesotho sandbox
#
# Run once after `docker compose up -d` (services need ~2-4 min to start).
# Safe to re-run after any service restart — all operations are idempotent.
#
# Usage:
#   bash scripts/seed.sh
#   SKIP_WAIT=1 bash scripts/seed.sh   # skip readiness checks (for reruns)
# =============================================================================
set -euo pipefail

# Move to repo root so docker compose and relative paths work
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Fixed UUIDs ──────────────────────────────────────────────────────────────
# CRITICAL: these must stay in sync with mediator/index.js constants.
FACILITY_ID="28de536f-b826-4eeb-a3c4-d65221a1120d"
PROGRAM_ID="31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c"
ORDERABLE_ID="3be1d20f-6aa9-4e52-864f-4fa04aa02056"
# REASON_ID d159376d-... is seeded by stockmanagement Flyway — no action needed.

# Supplementary stable UUIDs (only need to be consistent within this script)
GEO_LEVEL_COUNTRY_ID="a7ef5f2b-0a40-4cbb-a050-da84ab3aef72"
GEO_LEVEL_DISTRICT_ID="2b01de8b-cc0f-4e2f-9fa3-2a7e0d1d9876"
GEO_ZONE_COUNTRY_ID="c1e921a6-f37f-4a4c-89e3-f3e25f2b3a01"
GEO_ZONE_DISTRICT_ID="d7b0f7a9-65c4-4e8f-bb8a-4b2a3b9c1d02"
FACILITY_TYPE_ID="e3f5a2c1-d9b8-4f5c-aa3b-8c2e7d1f3a04"        # health_center

# Additional geographic structure (Leribe + Berea districts; Leribe council zones)
GEO_LEVEL_COUNCIL_ID="3c02ef9c-dd10-4f3f-af94-3b8e1e2ea987"
GEO_ZONE_LERIBE_ID="d8c1f8ba-76d5-4f9f-ac9b-5c3b4c0d2e13"
GEO_ZONE_BEREA_ID="e9d2f9cb-87e6-5faf-ad0c-6d4c5d1e3f24"
GEO_ZONE_TSOITSOILI_ID="f0e3a0dc-98f7-6fbf-ae1d-7e5d6e2f4035"
GEO_ZONE_MANKA_ID="a1f4b1ed-09a8-7fcf-af2e-8f6e7f3f5146"
GEO_ZONE_MAPUTSOE_ID="b2a5c2fe-10b9-8fdf-a01f-9f7f8f4f6257"
GEO_ZONE_LITJOTJELA_ID="c3b6d3ff-21ca-9fef-a12f-0f8f9f5f7368"
GEO_ZONE_RAMAPEPE_ID="d4c7e400-32db-a0ff-a230-1f9faf6f8479"
FACILITY_TYPE_HOSPITAL_ID="f1d6b3e2-ead9-4f6d-ab4c-9d3f8e2f4b05"

# DHIS2 UIDs (seeded once; persist in postgres-data volume across restarts)
DHIS2_ORG_UNIT="dwx1Yz4BwNX"
DHIS2_DATA_ELEMENT="ujPSJuS9pph"
DHIS2_DE_STOCK_RECEIVED="StckRcvdAL1"

# ─── Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[seed] $*"; }

# Wait until curl succeeds against a URL (max ~5 min, 5 s intervals)
wait_http() {
  local label="$1"; shift
  local url="$1"; shift
  local opts=("$@")
  log "Waiting for $label ..."
  local i
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "${opts[@]}" "$url" 2>/dev/null; then
      log "$label ready (attempt $i)"
      return 0
    fi
    sleep 5
  done
  log "ERROR: $label did not respond after 5 minutes — is the stack running?"
  exit 1
}

# PUT a JSON body to an OpenLMIS API path; exits on HTTP error
lmis_put() {
  local path="$1" body="$2"
  curl -sf -o /dev/null -X PUT "http://localhost:8082${path}" \
    -H "Authorization: Bearer ${LMIS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}"
}

# ─── 0. Readiness checks ──────────────────────────────────────────────────────
if [[ "${SKIP_WAIT:-0}" != "1" ]]; then
  # OpenHIM admin API (HTTPS — trust self-signed cert)
  wait_http "OpenHIM core" "https://localhost:8080/heartbeat" -k

  # Keycloak opensrp realm
  wait_http "Keycloak" "http://localhost:8083/realms/opensrp"

  # OpenLMIS: wait until auth service issues a token
  log "Waiting for OpenLMIS auth service ..."
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null -u user-client:changeme \
        -d "grant_type=password&username=admin&password=password" \
        http://localhost:8082/api/oauth/token 2>/dev/null; then
      log "OpenLMIS auth ready (attempt $i)"
      break
    fi
    [[ $i -eq 60 ]] && { log "ERROR: OpenLMIS auth did not respond in 5 min"; exit 1; }
    sleep 5
  done

  # OpenLMIS referencedata (takes the longest — Flyway runs on start)
  log "Waiting for OpenLMIS referencedata ..."
  for i in $(seq 1 72); do   # up to 6 min
    if curl -sf -o /dev/null \
        -H "Authorization: Bearer $(curl -sf -u user-client:changeme \
          -d "grant_type=password&username=admin&password=password" \
          http://localhost:8082/api/oauth/token 2>/dev/null \
          | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")" \
        "http://localhost:8082/api/geographicLevels?size=1" 2>/dev/null; then
      log "OpenLMIS referencedata ready (attempt $i)"
      break
    fi
    [[ $i -eq 72 ]] && { log "ERROR: OpenLMIS referencedata did not respond in 6 min"; exit 1; }
    sleep 5
  done

  # DHIS2 (slow JVM startup)
  wait_http "DHIS2" "http://localhost:8081/api/system/info" \
    -u admin:district
fi

# ─── 1. Fix OpenHIM password hash ─────────────────────────────────────────────
# openhim-mediator-utils computes: sha512(passwordSalt + password).
# On a fresh install openhim-core sets this correctly, but re-running is harmless.
log "Resetting OpenHIM root password hash ..."
SALT=$(docker exec openhim-mongo mongo --quiet openhim \
  --eval "print(db.passports.findOne({protocol:'token',email:'root@openhim.org'}).passwordSalt)")
HASH=$(docker exec bkm-mediator node -e \
  "const c=require('crypto');process.stdout.write(c.createHash('sha512').update('${SALT}'+'openhim-password').digest('hex'))")
docker exec openhim-mongo mongo --quiet openhim --eval \
  "db.passports.updateOne({protocol:'token',email:'root@openhim.org'},{\$set:{passwordHash:'${HASH}'}})" \
  > /dev/null
log "OpenHIM password hash updated — restarting mediator to re-register ..."
docker compose restart bkm-mediator
sleep 5

# ─── 2. Get OpenLMIS admin token ──────────────────────────────────────────────
log "Obtaining OpenLMIS admin token ..."
LMIS_TOKEN=$(curl -sf -u user-client:changeme \
  -d "grant_type=password&username=admin&password=password" \
  http://localhost:8082/api/oauth/token \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
[[ -z "$LMIS_TOKEN" ]] && { log "ERROR: could not obtain OpenLMIS token"; exit 1; }

# ─── 3. Fix OpenLMIS nginx rate limit + missing-endpoint stubs ────────────────
# Two problems fixed here (both are lost on nginx container restart):
#
# A) Rate limit bypass — the map only matches "localhost" (no port), but browsers
#    send Host: localhost:8082. Regex ~^localhost fixes both.  openlmis-nginx also
#    needs bypass for inter-service stockmanagement→referencedata calls.
#
# B) Stub newer API endpoints absent from the 2018-era backend services.
#    The reference-ui SPA (5.2.13, 2025) calls these on every login/page-load.
#    Without stubs the SPA polls indefinitely, making the page appear stuck.

log "Patching OpenLMIS nginx (rate-limit + missing-endpoint stubs) ..."

python3 - <<'PYEOF'
import re, subprocess, sys

C = 'openlmis-nginx'
ADMIN_UUID = '35316636-6264-6331-2d34-3933322d3462'

def read_file(path):
    r = subprocess.run(['docker', 'exec', C, 'cat', path], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

def write_file(path, content):
    w = subprocess.run(['docker', 'exec', '-i', C, 'sh', '-c', f'cat > {path}'],
        input=content, capture_output=True, text=True)
    if w.returncode != 0:
        print(f'ERROR: could not write {path}', file=sys.stderr); sys.exit(1)

# Stubs as plain nginx config — no Go template syntax needed (static returns).
# T = template indent (2sp location, 4sp directives); R = rendered indent (6sp/8sp).
def make_stubs(loc_indent, dir_indent):
    L, D = loc_indent, dir_indent
    return (
        f'{L}location ~ /api/userContactDetails {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"referenceDataUserId":"{ADMIN_UUID}","emailDetails":{{"email":"admin@example.com","emailVerified":false}},"phoneNumber":"","allowNotify":true}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/users/auth/[^/]+ {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"enabled":true,"loginRestricted":false,"allowedPrograms":[]}}\';\n'
        f'{L}}}\n'
        f'{L}location = /api/users/me {{\n'
        f'{D}rewrite ^ /api/users/{ADMIN_UUID} break;\n'
        f'{D}proxy_pass http://referencedata;\n'
        f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        f'{L}}}\n'
        f'{L}location ~ /api/systemNotifications {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":1,"last":true,"first":true,"number":0,"numberOfElements":0,"size":10}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/pages/home {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":10}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/supportedPrograms {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'[]\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/orders/statusesStatsData {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/requisitions/statusesStatsData {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/reports/dashboardReports {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'[]\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/validSources {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/validDestinations {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /localeSettings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
    )

# ── 1. Patch consul-template template (durable — survives consul-template re-renders) ──
# The nginx config is generated by consul-template from /etc/consul-template/openlmis.conf.
# Patching the template ensures our stubs survive any future re-render triggered by
# Consul service changes (e.g., after a docker restart of an OpenLMIS service).
TMPL_PATH = '/etc/consul-template/openlmis.conf'
tmpl = read_file(TMPL_PATH)
if tmpl:
    changed = False

    # A) Rate limit map — template has: "{{ env "VIRTUAL_HOST" }}" 0;
    #    Add regex match for localhost:PORT and openlmis-nginx inter-service calls.
    old_vh = '"{{ env "VIRTUAL_HOST" }}" 0;'
    if '"~^localhost"' not in tmpl and old_vh in tmpl:
        idx = tmpl.index(old_vh)
        eol = tmpl.index('\n', idx)
        tmpl = (tmpl[:eol]
                + '\n    "~^localhost" 0;   # Browser: localhost or localhost:8082'
                + '\n    "openlmis-nginx" 0; # Internal service-to-service calls'
                + tmpl[eol:])
        changed = True; print('template: rate-limit map patched')

    # B) Stubs — insert before the consul-template range loop that generates
    #    location blocks from Consul KV.  This anchor is always present.
    TMPL_ANCHOR = '  # First retrieve paths without parameters'
    if 'userContactDetails' not in tmpl and TMPL_ANCHOR in tmpl:
        tmpl = tmpl.replace(TMPL_ANCHOR, make_stubs('  ', '    ') + TMPL_ANCHOR, 1)
        changed = True; print('template: stubs inserted')

    if changed:
        write_file(TMPL_PATH, tmpl)
        print('consul-template template written')
    else:
        print('consul-template template: already up to date')
else:
    print('WARN: could not read consul-template template', file=sys.stderr)

# ── 2. Patch rendered nginx config (immediate effect) ──────────────────────────
# Also patch the live rendered config so the fix takes effect immediately without
# waiting for consul-template to re-render on the next Consul data change.
CONF_PATH = '/etc/nginx/conf.d/default.conf'
c = read_file(CONF_PATH)
if not c:
    print('WARN: nginx container not ready — skipping rendered config patch', file=sys.stderr)
    sys.exit(0)

changed = False

# A) Rate limit map
old_map = re.search(r'map \$http_host \$allowlisted_ip \{[^}]+\}', c, re.DOTALL)
if old_map and '"~^localhost"' not in c:
    new_map = ('map $http_host $allowlisted_ip {\n'
               '    default 1;\n'
               '    "~^localhost" 0;   # Browser: localhost or localhost:8082\n'
               '    "openlmis-nginx" 0; # Internal service-to-service calls\n'
               '}')
    c = c[:old_map.start()] + new_map + c[old_map.end():]
    changed = True; print('rendered: rate-limit map patched')

# B) Stubs — insert before the first /api/notification location block.
#    This block is always present (generated from the "api/notification" Consul KV key).
CONF_ANCHOR = 'location ~ /api/notification/?'
if 'userContactDetails' not in c and CONF_ANCHOR in c:
    c = c.replace(CONF_ANCHOR, make_stubs('      ', '        ') + CONF_ANCHOR, 1)
    changed = True; print('rendered: stubs inserted')

if changed:
    write_file(CONF_PATH, c)
    print('rendered nginx config written')
else:
    print('rendered nginx config: already up to date')
PYEOF

MSYS_NO_PATHCONV=1 docker exec openlmis-nginx sh -c "nginx -t && nginx -s reload" 2>/dev/null || true
log "nginx patches applied."

# ─── 4. Seed DHIS2 (org unit + data element) ─────────────────────────────────
# Uses the /api/metadata bulk import endpoint — idempotent (CREATE_AND_UPDATE).
# These UIDs are hardcoded in mediator/index.js and must not change.
log "Seeding DHIS2 metadata ..."
DHIS2_RESULT=$(curl -sf -u admin:district -X POST \
  "http://localhost:8081/api/metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=NONE" \
  -H "Content-Type: application/json" \
  -d "{
    \"organisationUnits\": [{
      \"id\": \"${DHIS2_ORG_UNIT}\",
      \"name\": \"Maseru District Clinic A\",
      \"shortName\": \"Maseru Clinic A\",
      \"openingDate\": \"2000-01-01\"
    }],
    \"dataElements\": [
      {
        \"id\": \"${DHIS2_DATA_ELEMENT}\",
        \"name\": \"Stock Dispensed - AL 20/120mg\",
        \"shortName\": \"AL 20/120mg Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_STOCK_RECEIVED}\",
        \"name\": \"Stock Received - AL 20/120mg\",
        \"shortName\": \"AL 20/120mg Received\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      }
    ]
  }")
log "DHIS2 seed result: $(echo "$DHIS2_RESULT" | grep -o '"status":"[^"]*"' | head -2 | tr '\n' ' ')"

# ─── 5. Activate OpenLMIS admin user ─────────────────────────────────────────
# Flyway seeds admin with active=false; the SPA throws "Internal application error"
# when the logged-in user is inactive. Fix it every time referencedata restarts.
log "Activating OpenLMIS admin user ..."
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c \
  "UPDATE referencedata.users SET active = true, verified = true WHERE username = 'admin';" 2>/dev/null
log "Admin user activated."

# ─── 5b. Pre-seed unscoped right_assignments ──────────────────────────────────
# PROGRAMS_MANAGE (and others) are absent from right_assignments after every
# referencedata restart.  Step 6 calls the /api/programs, /api/facilities, etc.
# endpoints which require these rights — so they must be in place BEFORE step 6.
ADMIN_UUID=$(docker exec health-db-postgres psql -U admin -d openlmis_referencedata -t -c \
  "SELECT id FROM referencedata.users WHERE username = 'admin';" | tr -d '[:space:]')
[[ -z "$ADMIN_UUID" ]] && { log "ERROR: admin user not found in referencedata DB"; exit 1; }
log "Patching unscoped right_assignments for admin (${ADMIN_UUID}) ..."
for rightname in PROGRAMS_MANAGE SYSTEM_IDEAL_STOCK_AMOUNTS_MANAGE SERVICE_ACCOUNTS_MANAGE STOCK_CARDS_VIEW; do
  docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
    INSERT INTO referencedata.right_assignments (id, userid, rightname)
    VALUES (gen_random_uuid(), '${ADMIN_UUID}', '${rightname}')
    ON CONFLICT DO NOTHING;" 2>/dev/null
done
log "Unscoped rights pre-seeded."

# ─── 6. Seed OpenLMIS referencedata ───────────────────────────────────────────
log "Seeding OpenLMIS geographic levels ..."
lmis_put "/api/geographicLevels/${GEO_LEVEL_COUNTRY_ID}" \
  "{\"id\":\"${GEO_LEVEL_COUNTRY_ID}\",\"code\":\"country\",\"name\":\"Country\",\"levelNumber\":1}"
lmis_put "/api/geographicLevels/${GEO_LEVEL_DISTRICT_ID}" \
  "{\"id\":\"${GEO_LEVEL_DISTRICT_ID}\",\"code\":\"district\",\"name\":\"District\",\"levelNumber\":2}"

log "Seeding OpenLMIS geographic zones ..."
lmis_put "/api/geographicZones/${GEO_ZONE_COUNTRY_ID}" \
  "{\"id\":\"${GEO_ZONE_COUNTRY_ID}\",\"code\":\"LS\",\"name\":\"Lesotho\",\"level\":{\"id\":\"${GEO_LEVEL_COUNTRY_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_DISTRICT_ID}" \
  "{\"id\":\"${GEO_ZONE_DISTRICT_ID}\",\"code\":\"MSD\",\"name\":\"Maseru District\",\"level\":{\"id\":\"${GEO_LEVEL_DISTRICT_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_COUNTRY_ID}\"}}"

log "Seeding OpenLMIS program (direct DB — API PUT is update-only, POST ignores supplied UUID) ..."
# Delete any existing EM program with a wrong UUID, then upsert ours
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  DELETE FROM referencedata.programs WHERE code='EM' AND id != '${PROGRAM_ID}';
  INSERT INTO referencedata.programs
    (id, active, code, name, periodsskippable, shownonfullsupplytab, enabledatephysicalstockcountcompleted, skipauthorization)
  VALUES ('${PROGRAM_ID}', true, 'EM', 'Essential Medicines', false, true, false, false)
  ON CONFLICT (id) DO UPDATE SET active=true, name='Essential Medicines';" 2>/dev/null

# Flyway only seeds warehouse; seed health_center and hospital ourselves (stable UUIDs)
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.facility_types (id, active, code, name, displayorder)
  SELECT '${FACILITY_TYPE_ID}', true, 'health_center', 'Health Center', 1
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.facility_types WHERE lower(code) = 'health_center');
  INSERT INTO referencedata.facility_types (id, active, code, name, displayorder)
  SELECT '${FACILITY_TYPE_HOSPITAL_ID}', true, 'hospital', 'Hospital', 2
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.facility_types WHERE lower(code) = 'hospital');" 2>/dev/null

log "Seeding OpenLMIS facility (with supported program) ..."
lmis_put "/api/facilities/${FACILITY_ID}" \
  "{\"id\":\"${FACILITY_ID}\",\"code\":\"MDA\",\"name\":\"Maseru District Clinic A\",\
\"geographicZone\":{\"id\":\"${GEO_ZONE_DISTRICT_ID}\"},\
\"type\":{\"id\":\"${FACILITY_TYPE_ID}\"},\
\"active\":true,\"enabled\":true,\
\"supportedPrograms\":[{\"id\":\"${PROGRAM_ID}\",\"supportActive\":true,\"supportLocallyFulfilled\":false}]}"

docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c \
  "UPDATE referencedata.users SET homefacilityid = '${FACILITY_ID}' WHERE username = 'admin';" 2>/dev/null
log "Admin user home facility set (${FACILITY_ID})."

log "Seeding OpenLMIS orderable (AL 20/120mg, direct DB — API PUT ignores supplied UUID) ..."
# Fixed UUIDs for the dispensable and orderable display category (sandbox-only, stable)
DISPENSABLE_ID="aaaaaaaa-0000-0000-0000-000000000001"
ODC_ID="a1b2c3d4-e5f6-4a7b-8c9d-000000000001"
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.dispensables (id, type) VALUES ('${DISPENSABLE_ID}', 'default')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.orderable_display_categories (id, code, displayname, displayorder)
    VALUES ('${ODC_ID}', 'DEFAULT', 'Default', 1)
    ON CONFLICT (id) DO NOTHING;
  DELETE FROM referencedata.orderables WHERE code='AL20120' AND id != '${ORDERABLE_ID}';
  INSERT INTO referencedata.orderables (id, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
    VALUES ('${ORDERABLE_ID}', 'AL 20/120mg', 0, 1, 'AL20120', false, '${DISPENSABLE_ID}')
    ON CONFLICT (id) DO UPDATE SET fullproductname='AL 20/120mg', netcontent=1;
  INSERT INTO referencedata.program_orderables
    (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, programid)
    VALUES (gen_random_uuid(), true, 1, true, '${ODC_ID}', '${ORDERABLE_ID}', '${PROGRAM_ID}')
    ON CONFLICT DO NOTHING;" 2>/dev/null

# ─── 6b. Seed Lesotho district facilities ─────────────────────────────────────
# 30 facilities across 3 districts (Leribe, Berea, Maseru).
# Flyway-seeded geographic level, zone, and facility type IDs are queried dynamically
# because they change across openlmis-referencedata restarts (flyway.clean=true).
log "Seeding Lesotho districts, councils, and health facilities ..."

# Council geographic level (sub-district — level 3)
lmis_put "/api/geographicLevels/${GEO_LEVEL_COUNCIL_ID}" \
  "{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\",\"code\":\"council\",\"name\":\"Council\",\"levelNumber\":3}"

# Resolve Flyway-seeded IDs needed for zone and facility references
FLYWAY_DISTRICT_LEVEL_ID=$(curl -sf -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicLevels" \
  | python3 -c "import sys,json; lv=json.load(sys.stdin); print(next(l['id'] for l in lv if l['code']=='district'))")
FLYWAY_LESOTHO_ZONE_ID=$(curl -sf -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicZones?size=200" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); zz=d.get('content',d) if isinstance(d,dict) else d; print(next(z['id'] for z in zz if z.get('level',{}).get('levelNumber')==1))")
FLYWAY_MASERU_ZONE_ID=$(curl -sf -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicZones?size=200" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); zz=d.get('content',d) if isinstance(d,dict) else d; hits=[z for z in zz if z.get('code') in ('MAS','Maseru') or z.get('name')=='Maseru']; print(hits[0]['id'] if hits else next(z['id'] for z in zz if z.get('level',{}).get('levelNumber')==2))")
FLYWAY_HC_TYPE_ID="${FACILITY_TYPE_ID}"
FLYWAY_HOSP_TYPE_ID="${FACILITY_TYPE_HOSPITAL_ID}"
log "Using district level=${FLYWAY_DISTRICT_LEVEL_ID} Lesotho=${FLYWAY_LESOTHO_ZONE_ID} Maseru=${FLYWAY_MASERU_ZONE_ID}"

# District zones: Leribe and Berea
lmis_put "/api/geographicZones/${GEO_ZONE_LERIBE_ID}" \
  "{\"id\":\"${GEO_ZONE_LERIBE_ID}\",\"code\":\"LER\",\"name\":\"Leribe\",\"level\":{\"id\":\"${FLYWAY_DISTRICT_LEVEL_ID}\"},\"parent\":{\"id\":\"${FLYWAY_LESOTHO_ZONE_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_BEREA_ID}" \
  "{\"id\":\"${GEO_ZONE_BEREA_ID}\",\"code\":\"BEA\",\"name\":\"Berea\",\"level\":{\"id\":\"${FLYWAY_DISTRICT_LEVEL_ID}\"},\"parent\":{\"id\":\"${FLYWAY_LESOTHO_ZONE_ID}\"}}"

# Council zones under Leribe
lmis_put "/api/geographicZones/${GEO_ZONE_TSOITSOILI_ID}" \
  "{\"id\":\"${GEO_ZONE_TSOITSOILI_ID}\",\"code\":\"TSO\",\"name\":\"Tsoitsoili\",\"level\":{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_LERIBE_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_MANKA_ID}" \
  "{\"id\":\"${GEO_ZONE_MANKA_ID}\",\"code\":\"MNK\",\"name\":\"Manka\",\"level\":{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_LERIBE_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_MAPUTSOE_ID}" \
  "{\"id\":\"${GEO_ZONE_MAPUTSOE_ID}\",\"code\":\"MPU\",\"name\":\"Maputsoe Urban\",\"level\":{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_LERIBE_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_LITJOTJELA_ID}" \
  "{\"id\":\"${GEO_ZONE_LITJOTJELA_ID}\",\"code\":\"LJT\",\"name\":\"Litjotjela\",\"level\":{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_LERIBE_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_RAMAPEPE_ID}" \
  "{\"id\":\"${GEO_ZONE_RAMAPEPE_ID}\",\"code\":\"RMP\",\"name\":\"Ramapepe\",\"level\":{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_LERIBE_ID}\"}}"

# Helper: PUT one facility linked to the Essential Medicines program
lmis_facility() {
  local id="$1" code="$2" name="$3" zone_id="$4" type_id="$5"
  lmis_put "/api/facilities/${id}" \
    "{\"id\":\"${id}\",\"code\":\"${code}\",\"name\":\"${name}\",\
\"geographicZone\":{\"id\":\"${zone_id}\"},\"type\":{\"id\":\"${type_id}\"},\
\"active\":true,\"enabled\":true,\
\"supportedPrograms\":[{\"id\":\"${PROGRAM_ID}\",\"supportActive\":true,\"supportLocallyFulfilled\":false}]}"
}

# ── Leribe / Tsoitsoili ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c401" "MTB" "Motebang Hospital"       "${GEO_ZONE_TSOITSOILI_ID}" "${FLYWAY_HOSP_TYPE_ID}"
# ── Leribe / Manka ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c402" "MAM" "Mamohau Hospital"        "${GEO_ZONE_MANKA_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c403" "STR" "St Rose H/C"             "${GEO_ZONE_MANKA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c404" "STA" "St Anna H/C"             "${GEO_ZONE_MANKA_ID}" "${FLYWAY_HC_TYPE_ID}"
# ── Leribe / Maputsoe Urban ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c405" "MPF" "Maputsoe Filter Clinic"  "${GEO_ZONE_MAPUTSOE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c406" "MPS" "Maputsoe SDA"            "${GEO_ZONE_MAPUTSOE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c407" "STM" "St Monica H/C"           "${GEO_ZONE_MAPUTSOE_ID}" "${FLYWAY_HC_TYPE_ID}"
# ── Leribe / Litjotjela ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c408" "LIN" "Linotsing H/C"           "${GEO_ZONE_LITJOTJELA_ID}" "${FLYWAY_HC_TYPE_ID}"
# ── Leribe / Ramapepe ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c409" "MOS" "Mositi H/C"              "${GEO_ZONE_RAMAPEPE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c410" "THP" "Thabaphatsoa H/C"        "${GEO_ZONE_RAMAPEPE_ID}" "${FLYWAY_HC_TYPE_ID}"
# ── Berea ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c411" "BEH" "Berea Hospital"             "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c412" "MAL" "Maluti Adventist Hospital"  "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c413" "MAH" "Mahlatsa H/C"               "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c414" "KOL" "Kolojane H/C"               "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c415" "STT" "St Theresa H/C"             "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c416" "SEB" "Sebidea H/C"                "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c417" "LEN" "Lenkoane H/C"               "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c418" "MAP" "Mapheleng H/C"              "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c419" "BTH" "Bethany H/C"                "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c420" "PIL" "Pilot H/C"                  "${GEO_ZONE_BEREA_ID}" "${FLYWAY_HC_TYPE_ID}"
# ── Maseru (uses Flyway Maseru zone) ──
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c421" "QMH" "Queen Mamohato Hospital"       "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c422" "MKM" "Makoanyane Military Hospital"  "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c423" "QEH" "Queen Elizabeth II Hospital"   "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c424" "SJH" "St Joseph Hospital"             "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c425" "SCH" "Scott Hospital"                 "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HOSP_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c426" "QFC" "Qoaling Filter Clinic"         "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c427" "STL" "St Leo H/C"                    "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c428" "LOR" "Loretto H/C"                   "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c429" "SLC" "St Leonard H/C"                "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HC_TYPE_ID}"
lmis_facility "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c430" "SDA" "Seventh Day Adventist H/C"     "${FLYWAY_MASERU_ZONE_ID}" "${FLYWAY_HC_TYPE_ID}"
log "30 Lesotho facilities seeded (10 Leribe, 10 Berea, 10 Maseru)."

# ─── 7. Fix right_assignments cache ───────────────────────────────────────────
# OpenLMIS right_assignments is a denormalized cache (not derived from role_assignments).
# It must be patched directly after every referencedata restart.
log "Patching OpenLMIS right_assignments ..."
ADMIN_UUID=$(docker exec health-db-postgres psql -U admin -d openlmis_referencedata -t -c \
  "SELECT id FROM referencedata.users WHERE username = 'admin';" | tr -d '[:space:]')
[[ -z "$ADMIN_UUID" ]] && { log "ERROR: admin user not found in referencedata DB"; exit 1; }

# Scoped rights required for the mediator (must be per facility+program)
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_ADJUST',     '${FACILITY_ID}', '${PROGRAM_ID}'),
         (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_CARDS_VIEW', '${FACILITY_ID}', '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;" 2>/dev/null

# Unscoped rights that are sometimes absent from the cache after restart
# STOCK_CARDS_VIEW is also required by the mediator's stock validation (Job 3 — Safety Gate)
for rightname in PROGRAMS_MANAGE SYSTEM_IDEAL_STOCK_AMOUNTS_MANAGE SERVICE_ACCOUNTS_MANAGE STOCK_CARDS_VIEW; do
  docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
    INSERT INTO referencedata.right_assignments (id, userid, rightname)
    VALUES (gen_random_uuid(), '${ADMIN_UUID}', '${rightname}')
    ON CONFLICT DO NOTHING;" 2>/dev/null
done
log "right_assignments patched for admin user (UUID: ${ADMIN_UUID})."

# ─── 7b. Seed initial stock receipt (so dispense events don't underflow) ───────
# AL 20/120mg starts at 10,000 tablets at Maseru District Clinic A.
# Idempotent: uses ON CONFLICT-style check via documentationNo in the stockmanagement DB.
log "Seeding initial stock receipt for AL 20/120mg ..."
RECEIPT_REASON_ID=$(docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement -t -c \
  "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
EXISTING_RECEIPT=$(docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement -t -c \
  "SELECT count(*) FROM stockmanagement.stock_card_line_items WHERE documentnumber='SEED-INITIAL-RECEIPT';" 2>/dev/null | tr -d '[:space:]')
if [[ "$EXISTING_RECEIPT" == "0" && -n "$RECEIPT_REASON_ID" ]]; then
  LMIS_TOKEN_STOCK=$(curl -sf -u user-client:changeme \
    -d "grant_type=password&username=admin&password=password" \
    http://localhost:8082/api/oauth/token \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
  curl -sf -o /dev/null -X POST \
    -H "Authorization: Bearer ${LMIS_TOKEN_STOCK}" -H "Content-Type: application/json" \
    "http://localhost:8082/api/stockEvents" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${ORDERABLE_ID}\",\"quantity\":10000,\"occurredDate\":\"$(date +%Y-%m-%d)\",\"reasonId\":\"${RECEIPT_REASON_ID}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT\"}]}"
  log "Initial stock receipt created (10,000 tablets)."
else
  log "Initial stock receipt already exists — skipping."
fi

# ─── 8. Seed OpenSRP practitioner ─────────────────────────────────────────────
# OpenSRP requires a team.practitioner row whose user_id matches the Keycloak UUID.
# Keycloak uses H2 in dev mode (persists in the opensrp-realm.json import), so the
# UUID is stable across container restarts (as long as the realm JSON doesn't change).
log "Seeding OpenSRP practitioner ..."
KC_ADMIN_TOKEN=$(curl -sf -X POST \
  "http://localhost:8083/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")

KC_USER_ID=$(curl -sf \
  -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
  "http://localhost:8083/admin/realms/opensrp/users?username=opensrp-admin" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")

if [[ -n "$KC_USER_ID" ]]; then
  docker exec health-db-postgres psql -U admin -d opensrp -q -c "
    INSERT INTO team.practitioner (identifier, active, name, user_id, username)
    SELECT 'opensrp-admin-001', true, 'OpenSRP Admin', '${KC_USER_ID}', 'opensrp-admin'
    WHERE NOT EXISTS (SELECT 1 FROM team.practitioner WHERE username = 'opensrp-admin');
    UPDATE team.practitioner SET user_id = '${KC_USER_ID}' WHERE username = 'opensrp-admin';" 2>/dev/null
  log "OpenSRP practitioner upserted (Keycloak UUID: ${KC_USER_ID})."
else
  log "WARNING: opensrp-admin not found in Keycloak — OpenSRP practitioner not seeded."
fi

# ─── 9. Seed HAPI FHIR resources for opensrp-web ─────────────────────────────
# opensrp-web (port 9901) uses HAPI FHIR (port 8079) as its backend for all
# resource management pages (Locations, Teams, Users, Patients, Questionnaires).
# Seeds: Organization, Location hierarchy, VHW Practitioners, PractitionerRoles,
#        Patients, Groups (catchment), CareTeam.
log "Seeding HAPI FHIR resources for opensrp-web ..."
HAPI="http://localhost:8079/fhir"

# Helper: idempotent PUT; logs HTTP status code (does not fail on 4xx/5xx)
fhir_put() {
  local rt="$1" id="$2" body="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -H "Content-Type: application/fhir+json" \
    -d "$body" "${HAPI}/${rt}/${id}")
  [[ "$code" =~ ^2 ]] || log "  WARNING: ${rt}/${id} → ${code}"
}

# Remove stale placeholder data created by previous partial seeds
curl -s -X DELETE "${HAPI}/Organization?name=necxon&_cascade=delete" -o /dev/null 2>/dev/null || true
curl -s -X DELETE "${HAPI}/CareTeam?name=necxon"                     -o /dev/null 2>/dev/null || true
curl -s -X DELETE "${HAPI}/Group?name=opensrp-admin"                 -o /dev/null 2>/dev/null || true

# 9a. Organization
fhir_put Organization maseru-clinic-a \
  '{"resourceType":"Organization","id":"maseru-clinic-a","active":true,
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/organization-type","code":"prov","display":"Healthcare Provider"}]}],
    "name":"Maseru District Clinic A",
    "address":[{"district":"Maseru","country":"LS"}]}'

# 9b. Location hierarchy: Lesotho → Maseru District → Clinic A → 3 villages
fhir_put Location loc-lesotho \
  '{"resourceType":"Location","id":"loc-lesotho","status":"active","name":"Lesotho","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"COUNTRY","display":"Country"}]}]}'

fhir_put Location loc-maseru-district \
  '{"resourceType":"Location","id":"loc-maseru-district","status":"active","name":"Maseru District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"DIST","display":"District"}]}],
    "partOf":{"reference":"Location/loc-lesotho"}}'

fhir_put Location loc-maseru-clinic-a \
  '{"resourceType":"Location","id":"loc-maseru-clinic-a","status":"active","name":"Maseru District Clinic A","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Care"}]}],
    "physicalType":{"coding":[{"code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"},
    "position":{"longitude":27.483,"latitude":-29.317},
    "address":{"district":"Maseru","country":"LS"}}'

fhir_put Location loc-ha-mokoena \
  '{"resourceType":"Location","id":"loc-ha-mokoena","status":"active","name":"Ha Mokoena Village","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"COMM","display":"Community"}]}],
    "physicalType":{"coding":[{"code":"area","display":"Area"}]},
    "partOf":{"reference":"Location/loc-maseru-clinic-a"},
    "position":{"longitude":27.491,"latitude":-29.321}}'

fhir_put Location loc-ha-sehlabane \
  '{"resourceType":"Location","id":"loc-ha-sehlabane","status":"active","name":"Ha Sehlabane Village","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"COMM","display":"Community"}]}],
    "physicalType":{"coding":[{"code":"area","display":"Area"}]},
    "partOf":{"reference":"Location/loc-maseru-clinic-a"},
    "position":{"longitude":27.478,"latitude":-29.309}}'

fhir_put Location loc-matsieng \
  '{"resourceType":"Location","id":"loc-matsieng","status":"active","name":"Matsieng Village","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"COMM","display":"Community"}]}],
    "physicalType":{"coding":[{"code":"area","display":"Area"}]},
    "partOf":{"reference":"Location/loc-maseru-clinic-a"},
    "position":{"longitude":27.463,"latitude":-29.298}}'

# 9c. VHW Practitioners (3 community health workers)
fhir_put Practitioner prac-thabo-mokoena \
  '{"resourceType":"Practitioner","id":"prac-thabo-mokoena","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Thabo"]}],
    "telecom":[{"system":"phone","value":"+26650111001","use":"mobile"}],
    "address":[{"district":"Maseru","country":"LS"}]}'

fhir_put Practitioner prac-lineo-nthabi \
  '{"resourceType":"Practitioner","id":"prac-lineo-nthabi","active":true,
    "name":[{"use":"official","family":"Nthabi","given":["Lineo"]}],
    "telecom":[{"system":"phone","value":"+26650111002","use":"mobile"}],
    "address":[{"district":"Maseru","country":"LS"}]}'

fhir_put Practitioner prac-mpho-lerotholi \
  '{"resourceType":"Practitioner","id":"prac-mpho-lerotholi","active":true,
    "name":[{"use":"official","family":"Lerotholi","given":["Mpho"]}],
    "telecom":[{"system":"phone","value":"+26650111003","use":"mobile"}],
    "address":[{"district":"Maseru","country":"LS"}]}'

# 9d. PractitionerRoles
# Update opensrp-admin's existing role to proper org + location
fhir_put PractitionerRole 21904d68-4f2a-4a34-96af-0a2f3eac5c5b \
  '{"resourceType":"PractitionerRole","id":"21904d68-4f2a-4a34-96af-0a2f3eac5c5b","active":true,
    "practitioner":{"reference":"Practitioner/60ecaecf-5d25-4057-a502-f61aee561b47"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-maseru-clinic-a"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"SUPERVISOR","display":"Supervisor"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-thabo-mokoena \
  '{"resourceType":"PractitionerRole","id":"role-thabo-mokoena","active":true,
    "practitioner":{"reference":"Practitioner/prac-thabo-mokoena"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-ha-mokoena"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"CHW","display":"Community Health Worker"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-lineo-nthabi \
  '{"resourceType":"PractitionerRole","id":"role-lineo-nthabi","active":true,
    "practitioner":{"reference":"Practitioner/prac-lineo-nthabi"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-ha-sehlabane"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"CHW","display":"Community Health Worker"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-mpho-lerotholi \
  '{"resourceType":"PractitionerRole","id":"role-mpho-lerotholi","active":true,
    "practitioner":{"reference":"Practitioner/prac-mpho-lerotholi"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-matsieng"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"CHW","display":"Community Health Worker"}]}],
    "period":{"start":"2024-01-01"}}'

# 9e. Patients (10 test patients across 3 catchment villages)
fhir_put Patient patient-001 \
  '{"resourceType":"Patient","id":"patient-001","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Katleho"]}],
    "gender":"male","birthDate":"2005-03-14",
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-002 \
  '{"resourceType":"Patient","id":"patient-002","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Palesa"]}],
    "gender":"female","birthDate":"2010-07-22",
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-003 \
  '{"resourceType":"Patient","id":"patient-003","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Teboho"]}],
    "gender":"male","birthDate":"2018-11-05",
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-004 \
  '{"resourceType":"Patient","id":"patient-004","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Mahlomola"]}],
    "gender":"male","birthDate":"1985-01-30",
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-005 \
  '{"resourceType":"Patient","id":"patient-005","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Nthabiseng"]}],
    "gender":"female","birthDate":"1988-06-18",
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-006 \
  '{"resourceType":"Patient","id":"patient-006","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Lehlohonolo"]}],
    "gender":"male","birthDate":"2015-09-03",
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-007 \
  '{"resourceType":"Patient","id":"patient-007","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Mamello"]}],
    "gender":"female","birthDate":"1975-04-12",
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-008 \
  '{"resourceType":"Patient","id":"patient-008","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Lebohang"]}],
    "gender":"male","birthDate":"2002-12-27",
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-009 \
  '{"resourceType":"Patient","id":"patient-009","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Thato"]}],
    "gender":"female","birthDate":"2020-02-09",
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-010 \
  '{"resourceType":"Patient","id":"patient-010","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Motlatsi"]}],
    "gender":"male","birthDate":"1960-08-15",
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'

# 9f. Groups (catchment populations per VHW)
fhir_put Group group-ha-mokoena \
  '{"resourceType":"Group","id":"group-ha-mokoena","type":"person","actual":true,
    "name":"Ha Mokoena — Thabo Mokoena catchment",
    "managingEntity":{"reference":"Practitioner/prac-thabo-mokoena"},
    "member":[
      {"entity":{"reference":"Patient/patient-001"}},
      {"entity":{"reference":"Patient/patient-002"}},
      {"entity":{"reference":"Patient/patient-003"}}]}'

fhir_put Group group-ha-sehlabane \
  '{"resourceType":"Group","id":"group-ha-sehlabane","type":"person","actual":true,
    "name":"Ha Sehlabane — Lineo Nthabi catchment",
    "managingEntity":{"reference":"Practitioner/prac-lineo-nthabi"},
    "member":[
      {"entity":{"reference":"Patient/patient-004"}},
      {"entity":{"reference":"Patient/patient-005"}},
      {"entity":{"reference":"Patient/patient-006"}}]}'

fhir_put Group group-matsieng \
  '{"resourceType":"Group","id":"group-matsieng","type":"person","actual":true,
    "name":"Matsieng — Mpho Lerotholi catchment",
    "managingEntity":{"reference":"Practitioner/prac-mpho-lerotholi"},
    "member":[
      {"entity":{"reference":"Patient/patient-007"}},
      {"entity":{"reference":"Patient/patient-008"}},
      {"entity":{"reference":"Patient/patient-009"}},
      {"entity":{"reference":"Patient/patient-010"}}]}'

# 9g. CareTeam
fhir_put CareTeam team-maseru-north \
  '{"resourceType":"CareTeam","id":"team-maseru-north","status":"active",
    "name":"Maseru North VHW Team",
    "participant":[
      {"role":[{"coding":[{"code":"supervisor","display":"Supervisor"}]}],
       "member":{"reference":"Practitioner/60ecaecf-5d25-4057-a502-f61aee561b47"}},
      {"role":[{"coding":[{"code":"CHW","display":"Community Health Worker"}]}],
       "member":{"reference":"Practitioner/prac-thabo-mokoena"}},
      {"role":[{"coding":[{"code":"CHW","display":"Community Health Worker"}]}],
       "member":{"reference":"Practitioner/prac-lineo-nthabi"}},
      {"role":[{"coding":[{"code":"CHW","display":"Community Health Worker"}]}],
       "member":{"reference":"Practitioner/prac-mpho-lerotholi"}}]}'

log "HAPI FHIR seeded: 1 org, 6 locations, 3 VHWs, 4 roles, 10 patients, 3 groups, 1 care team."

# ─── Done ─────────────────────────────────────────────────────────────────────
log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Seed complete. Test the full fan-out with:"
log ""
log "  curl -s -X POST http://localhost:5001/fhir/MedicationDispense \\"
log "    -H 'Content-Type: application/fhir+json' \\"
log "    -d '{\"resourceType\":\"MedicationDispense\",\"status\":\"completed\","
log "         \"subject\":{\"reference\":\"Patient/patient-001\"},"
log "         \"performer\":[{\"actor\":{\"reference\":\"Practitioner/opensrp-admin\"}}],"
log "         \"whenHandedOver\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
log "         \"quantity\":{\"value\":6,\"unit\":\"tablet\"}}'"
log ""
log "Expected: HTTP 200, status: Successful"
log "  opensrp=HTTP 201  dhis2=HTTP 200  openlmis=HTTP 201"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
