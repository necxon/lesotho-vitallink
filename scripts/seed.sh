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

# When launched non-interactively from PowerShell on Windows, Git Bash does not
# source its profile, so /usr/bin is missing from PATH (sleep, curl, wc, etc.).
export PATH="/usr/bin:/bin:$PATH"

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

# Timestamps (python3 avoids `date` not being on PATH in non-interactive Git Bash on Windows)
TODAY=$(python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).strftime('%Y-%m-%d'))")
NOW=$(python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")

# DHIS2 UIDs (seeded once; persist in postgres-data volume across restarts)
DHIS2_ORG_UNIT="dwx1Yz4BwNX"
DHIS2_DATA_ELEMENT="ujPSJuS9pph"
DHIS2_DE_STOCK_RECEIVED="StckRcvdAL1"
DHIS2_DE_STOCK_ON_HAND="StockOnHnd1"

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
# Ensure mediator container is running before we exec into it (it may have crashed on
# startup if OpenHIM wasn't ready yet when it first tried to register).
docker compose up -d bkm-mediator >/dev/null 2>&1 || true
sleep 3
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

# ─── 1b. Seed OpenHIM visualizer ──────────────────────────────────────────────
log "Seeding OpenHIM visualizer ..."
docker exec bkm-mediator node -e "
const https = require('https');
const crypto = require('crypto');
const agent = new https.Agent({rejectUnauthorized:false});

function openhimReq(salt, method, path, body, cb) {
  const now = new Date().toISOString();
  const passhash = crypto.createHash('sha512').update(salt+'openhim-password').digest('hex');
  const token    = crypto.createHash('sha512').update(passhash+salt+now).digest('hex');
  const payload  = body ? JSON.stringify(body) : null;
  const headers  = {'auth-username':'root@openhim.org','auth-ts':now,'auth-salt':salt,'auth-token':token,'Content-Type':'application/json'};
  if(payload) headers['Content-Length'] = Buffer.byteLength(payload);
  const r = https.request({hostname:'openhim-core',port:8080,path,method,agent,headers}, (res) => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>cb(res.statusCode,d));
  });
  if(payload) r.write(payload);
  r.end();
}

const req = https.request({hostname:'openhim-core',port:8080,path:'/authenticate/root@openhim.org',method:'GET',agent}, (res) => {
  let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
    const {salt} = JSON.parse(d);
    // Delete existing visualizer with same name (idempotent)
    openhimReq(salt, 'GET', '/visualizers', null, (s, b) => {
      const list = JSON.parse(b);
      const existing = list.find(v => v.name === 'BKM Fan-Out \u2014 Lesotho');
      const createViz = () => {
        const viz = {
          name: 'BKM Fan-Out \u2014 Lesotho',
          components: [
            {eventType:'channel',  eventName:'BKM MedicationDispense',     display:'BKM Channel'},
            {eventType:'primary',  eventName:'Vital-Link Lesotho Mediator', display:'Vital-Link Mediator'},
            {eventType:'route',    eventName:'eLMIS',                       display:'OpenLMIS / eLMIS'},
            {eventType:'route',    eventName:'DHIS2',                       display:'DHIS2'}
          ],
          channels:  [{eventType:'channel', eventName:'BKM MedicationDispense', display:'BKM MedicationDispense'}],
          mediators: [{mediator:'urn:mediator:lesotho-vital-link', name:'Vital-Link Lesotho Mediator', display:'Vital-Link'}],
          color: {inactive:'#c8c8c8', active:'#4cae4c', error:'#d43f3a', text:'#3a3a3a'},
          size:  {responsive:true, width:1200, height:500, padding:40},
          time:  {updatePeriod:200, minDisplayPeriod:600, maxSpeed:5, maxTimeout:5000}
        };
        openhimReq(salt, 'POST', '/visualizers', viz, (s2, b2) => {
          console.log('Visualizer', s2 === 201 ? 'created' : 'error: '+b2.substring(0,100));
        });
      };
      if(existing) {
        openhimReq(salt, 'DELETE', '/visualizers/'+existing._id, null, () => createViz());
      } else {
        createViz();
      }
    });
  });
});
req.end();
" 2>/dev/null || log "Warning: visualizer seed failed (non-fatal)"

# ─── 1c. Ensure OpenHIM channels exist for all mediator routes ────────────────
log "Ensuring OpenHIM channels for SupplyDelivery and QuestionnaireResponse ..."
docker exec bkm-mediator node -e "
const https = require('https');
const crypto = require('crypto');
const agent = new https.Agent({rejectUnauthorized:false});

function openhimReq(salt, method, path, body, cb) {
  const now = new Date().toISOString();
  const passhash = crypto.createHash('sha512').update(salt+'openhim-password').digest('hex');
  const token    = crypto.createHash('sha512').update(passhash+salt+now).digest('hex');
  const payload  = body ? JSON.stringify(body) : null;
  const headers  = {'auth-username':'root@openhim.org','auth-ts':now,'auth-salt':salt,'auth-token':token,'Content-Type':'application/json'};
  if(payload) headers['Content-Length'] = Buffer.byteLength(payload);
  const r = https.request({hostname:'openhim-core',port:8080,path,method,agent,headers}, (res) => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>cb(res.statusCode,d));
  });
  if(payload) r.write(payload);
  r.end();
}

// Channels to ensure exist (idempotent — skip if name already present)
const CHANNELS = [
  {
    name: 'BKM SupplyDelivery',
    urlPattern: '^/fhir/SupplyDelivery\$',
    methods: ['POST'],
    type: 'http',
    status: 'enabled',
    routes: [{name:'BKM SupplyDelivery', host:'bkm-mediator', port:3000, primary:true, type:'http'}],
    allow: [],
    authType: 'public'
  },
  {
    name: 'BKM QuestionnaireResponse',
    urlPattern: '^/fhir/QuestionnaireResponse\$',
    methods: ['POST'],
    type: 'http',
    status: 'enabled',
    routes: [{name:'BKM QuestionnaireResponse', host:'bkm-mediator', port:3000, primary:true, type:'http'}],
    allow: [],
    authType: 'public'
  }
];

const req = https.request({hostname:'openhim-core',port:8080,path:'/authenticate/root@openhim.org',method:'GET',agent}, (res) => {
  let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
    const {salt} = JSON.parse(d);
    openhimReq(salt, 'GET', '/channels', null, (s, b) => {
      const existing = JSON.parse(b).map(c => c.name);
      let pending = CHANNELS.filter(c => !existing.includes(c.name));
      if(pending.length === 0) { console.log('All channels already exist'); return; }
      let done = 0;
      pending.forEach(ch => {
        openhimReq(salt, 'POST', '/channels', ch, (s2, b2) => {
          console.log('Channel', ch.name, s2 === 201 ? 'created' : 'error: '+b2.substring(0,120));
          if(++done === pending.length) console.log('Channel seeding complete');
        });
      });
    });
  });
});
req.end();
" 2>/dev/null || log "Warning: channel seed failed (non-fatal)"

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
ADMIN_UUID  = '35316636-6264-6331-2d34-3933322d3462'
FACILITY_ID = '28de536f-b826-4eeb-a3c4-d65221a1120d'
PROGRAM_ID  = '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c'
# permissionStrings must be a plain array — the SPA calls .forEach() directly on the response.
# PROGS_PAGED must be a Spring Page object — the SPA does .content on that one.
_PERMS_CONTENT = (
    '["STOCK_INVENTORIES_EDIT|{f}|{p}","STOCK_INVENTORIES_EDIT",'
    '"STOCK_CARD_LINE_ITEM_REASONS_MANAGE","USER_ROLES_MANAGE",'
    '"PROCESSING_SCHEDULES_MANAGE","PROGRAMS_MANAGE","STOCK_ORGANIZATIONS_MANAGE",'
    '"STOCK_DESTINATIONS_MANAGE","USERS_MANAGE","STOCK_ADJUSTMENT_REASONS_MANAGE",'
    '"REQUISITION_GROUPS_MANAGE","SUPERVISORY_NODES_MANAGE","SUPPLY_LINES_MANAGE",'
    '"SYSTEM_IDEAL_STOCK_AMOUNTS_MANAGE","FACILITIES_MANAGE","RIGHTS_VIEW",'
    '"GEOGRAPHIC_ZONES_MANAGE","REQUISITION_TEMPLATES_MANAGE",'
    '"FACILITY_APPROVED_ORDERABLES_MANAGE","STOCK_CARD_TEMPLATES_MANAGE",'
    '"SERVICE_ACCOUNTS_MANAGE","STOCK_SOURCES_MANAGE","ORDERABLES_MANAGE",'
    '"SYSTEM_SETTINGS_MANAGE","CCE_MANAGE",'
    '"STOCK_ADJUST|{f}|{p}","STOCK_CARDS_VIEW|{f}|{p}","STOCK_CARDS_VIEW"]'
).format(f=FACILITY_ID, p=PROGRAM_ID)
PROGS_PAGED = (
    '{{"content":[{{"code":"EM","name":"Essential Medicines","active":true,'
    '"periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,'
    '"enableDatePhysicalStockCountCompleted":false,'
    '"id":"{p}"}}],'
    '"totalPages":1,"totalElements":1,"numberOfElements":1,'
    '"number":0,"size":2147483647,"first":true,"last":true}}'
).format(p=PROGRAM_ID)

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
        f'# bkm-stubs-v2\n'
        # SPA calls permissionStrings.forEach() — expects a plain array, NOT a Spring Page.
        # location = (exact match) takes priority over the existing location ~ proxies.
        f'{L}location = /api/users/{ADMIN_UUID}/permissionStrings {{\n'
        + f'{D}default_type application/json;\n'
        + f'{D}return 200 \'' + _PERMS_CONTENT + '\';\n'
        + f'{L}}}\n'
        + f'{L}location = /api/users/{ADMIN_UUID}/programs {{\n'
        + f'{D}default_type application/json;\n'
        + f'{D}return 200 \'' + PROGS_PAGED + '\';\n'
        + f'{L}}}\n'
        + f'{L}location ~ /api/userContactDetails {{\n'
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
        # Superset OAuth -- ${SUPERSET_URL} is unresolved in reference-ui 5.2.13;
        # unhandled 404 on /oauth-init/openlmis causes $stateChangeError ->
        # "Internal application error". Return {"state":"NONE"} to suppress gracefully.
        f'{L}location ~ /oauth-init/openlmis {{\n'
        + f'{D}default_type application/json;\n'
        + f'{D}return 200 \'{{"state":"NONE"}}\';\n'
        + f'{L}}}\n'
        + f'{L}location ~ /oauth-authorized/openlmis {{\n'
        + f'{D}default_type application/json;\n'
        + f'{D}return 200 \'{{"state":"NONE"}}\';\n'
        + f'{L}}}\n'
        + f'{L}location ~ /api/pages/home {{\n'
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
        f'{L}location = /api/orderables/search {{\n'
        f'{D}proxy_method GET;\n'
        f'{D}rewrite ^ /api/orderables break;\n'
        f'{D}proxy_pass http://referencedata;\n'
        f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        f'{L}}}\n'
        f'{L}location ~ /api/validSources {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/validDestinations {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/requisitionGroups {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/stockAdjustmentReasons {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/facilities/[^/]+/supportedPrograms {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'[{{"programId":"{PROGRAM_ID}","programName":"Essential Medicines","programCode":"EM","periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,"supportStartDate":null,"locallyFulfilled":false}}]\';\n'
        f'{L}}}\n'
        f'{L}location ~ /localeSettings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        # SPA fetches /api/currencySettings at bootstrap (before login) to format numbers.
        # The real endpoint requires auth → 401 → error interceptor → "Internal application error".
        # Return Lesotho Loti (LSL / M) settings as a public stub.
        f'{L}location = /api/currencySettings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"currencyCode":"LSL","currencySymbol":"M","currencySymbolSide":"left","currencyDecimalPlaces":2,"groupingSeparator":",","groupingSize":3,"decimalSeparator":"."}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ "^/\\{{\\{{" {{\n'
        f'{D}return 200 \'\';\n'
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
    if 'bkm-stubs-v2' not in tmpl:
        if '# bkm-stubs-v1\n' in tmpl:
            tmpl = tmpl.replace('# bkm-stubs-v1\n', make_stubs('  ', '    '), 1)
            changed = True; print('template: stubs upgraded v1→v2')
        elif TMPL_ANCHOR in tmpl:
            tmpl = tmpl.replace(TMPL_ANCHOR, make_stubs('  ', '    ') + TMPL_ANCHOR, 1)
            changed = True; print('template: stubs inserted')

    # C) Catch unrendered AngularJS template URLs (nginx decodes %7B%7B → {{ before matching)
    if '\\{\\{' not in tmpl and TMPL_ANCHOR in tmpl:
        tmpl = tmpl.replace(TMPL_ANCHOR,
            '  location ~ "^/\\{\\{" {\n    return 200 \'\';\n  }\n' + TMPL_ANCHOR, 1)
        changed = True; print('template: angular template URL stub inserted')

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
if 'bkm-stubs-v2' not in c:
    if '# bkm-stubs-v1\n' in c:
        c = c.replace('# bkm-stubs-v1\n', make_stubs('      ', '        '), 1)
        changed = True; print('rendered: stubs upgraded v1→v2')
    elif CONF_ANCHOR in c:
        c = c.replace(CONF_ANCHOR, make_stubs('      ', '        ') + CONF_ANCHOR, 1)
        changed = True; print('rendered: stubs inserted')

# C) Catch unrendered AngularJS template URLs (nginx decodes %7B%7B → {{ before matching)
if '\\{\\{' not in c and CONF_ANCHOR in c:
    c = c.replace(CONF_ANCHOR,
        '  location ~ "^/\\{\\{" {\n    return 200 \'\';\n  }\n' + CONF_ANCHOR, 1)
    changed = True; print('rendered: angular template URL stub inserted')

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
      },
      {
        \"id\": \"${DHIS2_DE_STOCK_ON_HAND}\",
        \"name\": \"Stock on Hand - AL 20/120mg\",
        \"shortName\": \"AL 20/120mg SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      }
    ]
  }")
log "DHIS2 seed result: $(echo "$DHIS2_RESULT" | grep -o '"status":"[^"]*"' | head -2 | tr '\n' ' ')"

# ─── 4b. Seed DHIS2 visualizations + dashboard ───────────────────────────────
log "Seeding DHIS2 dashboard ..."
# DHIS2 UIDs are exactly 11 chars [A-Za-z][A-Za-z0-9]{10}
# CRITICAL: /api/metadata strips columns/rows/filters from visualizations — must use
# POST /api/visualizations directly. Delete first makes this idempotent.
DHIS2_VIZ_CHART="BKMBarChrt1"
DHIS2_VIZ_PIVOT="BKMPivotTb1"
DHIS2_VIZ_SOH="BKMSohLine1"
DHIS2_VIZ_RECV="BKMRecvBar1"
DHIS2_VIZ_COMBO="BKMDispSOH1"
DHIS2_VIZ_ALL="BKMAllPivt1"
DHIS2_DASHBOARD="BKMDashbrd1"

_seed_viz() {
  local uid="$1" payload="$2"
  curl -s -u admin:district -X DELETE "http://localhost:8081/api/visualizations/${uid}" > /dev/null 2>&1 || true
  curl -sf -u admin:district -X POST "http://localhost:8081/api/visualizations" \
    -H "Content-Type: application/json" -d "$payload" > /dev/null
}

_seed_viz "${DHIS2_VIZ_CHART}" "{
  \"id\": \"${DHIS2_VIZ_CHART}\",
  \"name\": \"AL 20/120mg Dispensing - Bar Chart\",
  \"type\": \"COLUMN\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": [{\"id\": \"${DHIS2_DATA_ELEMENT}\"}]}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"domainAxisLabel\": \"Month\",
  \"rangeAxisLabel\": \"Tablets Dispensed\"
}"

_seed_viz "${DHIS2_VIZ_SOH}" "{
  \"id\": \"${DHIS2_VIZ_SOH}\",
  \"name\": \"AL 20/120mg Stock on Hand - Line Chart\",
  \"type\": \"LINE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": [{\"id\": \"${DHIS2_DE_STOCK_ON_HAND}\"}]}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"LAST\",
  \"domainAxisLabel\": \"Month\",
  \"rangeAxisLabel\": \"Tablets on Hand\"
}"

_seed_viz "${DHIS2_VIZ_PIVOT}" "{
  \"id\": \"${DHIS2_VIZ_PIVOT}\",
  \"name\": \"AL 20/120mg Dispensing - Monthly Pivot\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"rows\":    [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"filters\": [{\"dimension\": \"dx\", \"items\": [{\"id\": \"${DHIS2_DATA_ELEMENT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"showData\": true
}"

_seed_viz "${DHIS2_VIZ_RECV}" "{
  \"id\": \"${DHIS2_VIZ_RECV}\",
  \"name\": \"AL 20/120mg Stock Received - Bar Chart\",
  \"type\": \"COLUMN\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": [{\"id\": \"${DHIS2_DE_STOCK_RECEIVED}\"}]}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"domainAxisLabel\": \"Month\",
  \"rangeAxisLabel\": \"Tablets Received\"
}"

_seed_viz "${DHIS2_VIZ_COMBO}" "{
  \"id\": \"${DHIS2_VIZ_COMBO}\",
  \"name\": \"AL 20/120mg Dispensed vs Stock on Hand - Line\",
  \"type\": \"LINE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": [
    {\"id\": \"${DHIS2_DATA_ELEMENT}\"},
    {\"id\": \"${DHIS2_DE_STOCK_ON_HAND}\"}
  ]}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"domainAxisLabel\": \"Month\",
  \"rangeAxisLabel\": \"Tablets\"
}"

_seed_viz "${DHIS2_VIZ_ALL}" "{
  \"id\": \"${DHIS2_VIZ_ALL}\",
  \"name\": \"AL 20/120mg - Dispensed / Received / SOH Pivot\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"rows\":    [{\"dimension\": \"dx\", \"items\": [
    {\"id\": \"${DHIS2_DATA_ELEMENT}\"},
    {\"id\": \"${DHIS2_DE_STOCK_RECEIVED}\"},
    {\"id\": \"${DHIS2_DE_STOCK_ON_HAND}\"}
  ]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"showData\": true
}"

# Dashboard: DELETE+POST for create, then PUT to set items
# (metadata endpoint silently drops dashboardItems just like it drops viz dimensions)
curl -s -u admin:district -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD}" > /dev/null 2>&1 || true
curl -sf -u admin:district -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${DHIS2_DASHBOARD}\", \"name\": \"BKM Stock Dispensing - Lesotho\"}" > /dev/null
curl -sf -u admin:district -X PUT "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_DASHBOARD}\",
    \"name\": \"BKM Stock Dispensing - Lesotho\",
    \"dashboardItems\": [
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_CHART}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_SOH}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_RECV}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_COMBO}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ALL}\"}}
    ]
  }" > /dev/null
log "DHIS2 dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD}"

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

# Trade item + lot: required for OpenLMIS v2 stockCardSummaries API (used by the SPA).
# The SPA calls /api/v2/stockCardSummaries which queries approvedProducts first and
# then returns only lot-tracked cards. Without a lot the stock card is invisible in the UI.
TRADE_ITEM_ID="eeeeeeee-0000-0000-0000-000000000001"
LOT_ID="ffffffff-0000-0000-0000-000000000001"
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.trade_items (id, manufactureroftradeitem)
    VALUES ('${TRADE_ITEM_ID}', 'Novartis')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.orderable_identifiers (key, value, orderableid)
    VALUES ('tradeItem', '${TRADE_ITEM_ID}', '${ORDERABLE_ID}')
    ON CONFLICT DO NOTHING;" 2>/dev/null
# lot must go in after trade item exists
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active)
    VALUES ('${LOT_ID}', 'AL-LOT-2026', '2028-12-31', '2026-01-01', '${TRADE_ITEM_ID}', true)
    ON CONFLICT (id) DO NOTHING;" 2>/dev/null
# facility_type_approved_products: v2 API queries approvedProducts for the facility type;
# without this entry the v2 endpoint returns an empty page even if stock cards exist.
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.facility_type_approved_products
    (id, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, facilitytypeid, orderableid, programid)
    SELECT gen_random_uuid(), 0, 3, 0, f.typeid, '${ORDERABLE_ID}', '${PROGRAM_ID}'
    FROM referencedata.facilities f
    WHERE f.id='${FACILITY_ID}'
    AND NOT EXISTS (
      SELECT 1 FROM referencedata.facility_type_approved_products
      WHERE facilitytypeid=f.typeid AND orderableid='${ORDERABLE_ID}' AND programid='${PROGRAM_ID}'
    );" 2>/dev/null
log "Trade item, lot (AL-LOT-2026), and approved product entry seeded."

# ─── 6a-ii. Seed 7 additional medicines ───────────────────────────────────────
log "Seeding 7 additional OpenLMIS orderables ..."
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  -- Orderables
  INSERT INTO referencedata.orderables (id, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid) VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002', 'Amoxicillin 250mg',     0, 1, 'AMOX250',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003', 'RDT Kit',               0, 1, 'RDTKIT',   false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004', 'Paracetamol Syrup',     0, 1, 'PARASYR',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005', 'Cotrimoxazole 480mg',   0, 1, 'CTX480',   false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006', 'ORS Sachet',            0, 1, 'ORSACH',   false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007', 'Zinc 20mg',             0, 1, 'ZINC20',   false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008', 'Iron + Folic Acid',     0, 1, 'IRNFOL',   false, '${DISPENSABLE_ID}')
  ON CONFLICT (id) DO NOTHING;
  -- program_orderables
  INSERT INTO referencedata.program_orderables
    (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, programid)
  SELECT gen_random_uuid(), true, row_number() OVER () + 1, true, '${ODC_ID}', v.id::uuid, '${PROGRAM_ID}'
  FROM (VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008')
  ) AS v(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM referencedata.program_orderables
    WHERE orderableid = v.id::uuid AND programid = '${PROGRAM_ID}'
  );
  -- trade_items
  INSERT INTO referencedata.trade_items (id, manufactureroftradeitem) VALUES
    ('eeeeeeee-0000-0000-0000-000000000002', 'GSK'),
    ('eeeeeeee-0000-0000-0000-000000000003', 'SD Biosensor'),
    ('eeeeeeee-0000-0000-0000-000000000004', 'Aspen'),
    ('eeeeeeee-0000-0000-0000-000000000005', 'Roche'),
    ('eeeeeeee-0000-0000-0000-000000000006', 'Unicef'),
    ('eeeeeeee-0000-0000-0000-000000000007', 'Cipla'),
    ('eeeeeeee-0000-0000-0000-000000000008', 'Cipla')
  ON CONFLICT (id) DO NOTHING;
  -- orderable_identifiers
  INSERT INTO referencedata.orderable_identifiers (key, value, orderableid) VALUES
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000002', '3be1d20f-6aa9-4e52-864f-4fa04aa02002'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000003', '3be1d20f-6aa9-4e52-864f-4fa04aa02003'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000004', '3be1d20f-6aa9-4e52-864f-4fa04aa02004'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000005', '3be1d20f-6aa9-4e52-864f-4fa04aa02005'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000006', '3be1d20f-6aa9-4e52-864f-4fa04aa02006'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000007', '3be1d20f-6aa9-4e52-864f-4fa04aa02007'),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000008', '3be1d20f-6aa9-4e52-864f-4fa04aa02008')
  ON CONFLICT DO NOTHING;
  -- facility_type_approved_products
  INSERT INTO referencedata.facility_type_approved_products
    (id, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, facilitytypeid, orderableid, programid)
  SELECT gen_random_uuid(), 0, 3, 0, f.typeid, v.oid::uuid, '${PROGRAM_ID}'
  FROM referencedata.facilities f,
  (VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008')
  ) AS v(oid)
  WHERE f.id = '${FACILITY_ID}'
  AND NOT EXISTS (
    SELECT 1 FROM referencedata.facility_type_approved_products
    WHERE facilitytypeid = f.typeid AND orderableid = v.oid::uuid AND programid = '${PROGRAM_ID}'
  );" 2>/dev/null
# lots (separate call — trade_items must exist first)
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active) VALUES
    ('ffffffff-0000-0000-0000-000000000002', 'AMOX-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000002', true),
    ('ffffffff-0000-0000-0000-000000000003', 'RDT-LOT-2026',   '2027-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000003', true),
    ('ffffffff-0000-0000-0000-000000000004', 'PARA-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000004', true),
    ('ffffffff-0000-0000-0000-000000000005', 'CTX-LOT-2026',   '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000005', true),
    ('ffffffff-0000-0000-0000-000000000006', 'ORS-LOT-2026',   '2027-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000006', true),
    ('ffffffff-0000-0000-0000-000000000007', 'ZINC-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000007', true),
    ('ffffffff-0000-0000-0000-000000000008', 'IFA-LOT-2026',   '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000008', true)
  ON CONFLICT (id) DO NOTHING;" 2>/dev/null
log "7 additional medicines seeded (orderables, lots, approved products)."

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
# STOCK_INVENTORIES_EDIT — required for physical inventory (scoped + unscoped)
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_INVENTORIES_EDIT', '${FACILITY_ID}', '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;" 2>/dev/null
docker exec health-db-postgres psql -U admin -d openlmis_referencedata -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_INVENTORIES_EDIT')
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "right_assignments patched for admin user (UUID: ${ADMIN_UUID})."

# ─── 7c. Seed valid_reason_assignments in stockmanagement ─────────────────────
# Links Flyway-seeded reasons (Consumed, Receipts, etc.) to the health_center
# facility type + Essential Medicines program so the SPA dropdowns are populated.
# Idempotent via the unique constraint on (facilityTypeId, programId, reasonId).
FLYWAY_HC_TYPE_SM="e3f5a2c1-d9b8-4f5c-aa3b-8c2e7d1f3a04"
docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement -q -c "
  INSERT INTO stockmanagement.valid_reason_assignments (id, facilitytypeid, programid, reasonid, hidden)
  SELECT gen_random_uuid(), '${FLYWAY_HC_TYPE_SM}', '${PROGRAM_ID}', id, false
  FROM stockmanagement.stock_card_line_item_reasons
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "valid_reason_assignments seeded for health_center + Essential Medicines."

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
  # Post lot-tracked receipt so the stock card appears in the v2 API used by the SPA.
  curl -sf -o /dev/null -X POST \
    -H "Authorization: Bearer ${LMIS_TOKEN_STOCK}" -H "Content-Type: application/json" \
    "http://localhost:8082/api/stockEvents" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${ORDERABLE_ID}\",\"lotId\":\"${LOT_ID}\",\"quantity\":10000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT\"}]}"
  log "Initial stock receipt created (10,000 tablets, lot AL-LOT-2026)."
else
  log "Initial stock receipt already exists — skipping."
fi

# ─── 7c. Seed initial stock for 7 additional medicines ────────────────────────
EXISTING_RECEIPT_V2=$(docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement -t -c \
  "SELECT count(*) FROM stockmanagement.stock_card_line_items WHERE documentnumber='SEED-INITIAL-RECEIPT-V2';" 2>/dev/null | tr -d '[:space:]')
if [[ "$EXISTING_RECEIPT_V2" == "0" ]]; then
  log "Seeding initial stock for 7 additional medicines ..."
  LMIS_TOKEN_STOCK2=$(curl -sf -u user-client:changeme \
    -d "grant_type=password&username=admin&password=password" \
    http://localhost:8082/api/oauth/token \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
  RECEIPT_REASON_ID2=$(docker exec health-db-postgres psql -U admin -d openlmis_stockmanagement -t -c \
    "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
  curl -sf -o /dev/null -X POST \
    -H "Authorization: Bearer ${LMIS_TOKEN_STOCK2}" -H "Content-Type: application/json" \
    "http://localhost:8082/api/stockEvents" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02002\",\"lotId\":\"ffffffff-0000-0000-0000-000000000002\",\"quantity\":5000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02003\",\"lotId\":\"ffffffff-0000-0000-0000-000000000003\",\"quantity\":500,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02004\",\"lotId\":\"ffffffff-0000-0000-0000-000000000004\",\"quantity\":3000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02005\",\"lotId\":\"ffffffff-0000-0000-0000-000000000005\",\"quantity\":5000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02006\",\"lotId\":\"ffffffff-0000-0000-0000-000000000006\",\"quantity\":2000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02007\",\"lotId\":\"ffffffff-0000-0000-0000-000000000007\",\"quantity\":8000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02008\",\"lotId\":\"ffffffff-0000-0000-0000-000000000008\",\"quantity\":10000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"}
    ]}"
  log "Initial stock seeded for 7 additional medicines."
else
  log "Additional medicines initial stock already exists — skipping."
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
  '{"resourceType":"Group","id":"group-ha-mokoena","type":"person","actual":true,"active":true,
    "identifier":[{"use":"official","value":"HH-001"}],
    "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
    "name":"Ha Mokoena - Thabo Mokoena catchment",
    "managingEntity":{"reference":"Practitioner/prac-thabo-mokoena"},
    "member":[
      {"entity":{"reference":"Patient/patient-001"}},
      {"entity":{"reference":"Patient/patient-002"}},
      {"entity":{"reference":"Patient/patient-003"}}]}'

fhir_put Group group-ha-sehlabane \
  '{"resourceType":"Group","id":"group-ha-sehlabane","type":"person","actual":true,"active":true,
    "identifier":[{"use":"official","value":"HH-002"}],
    "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
    "name":"Ha Sehlabane - Lineo Nthabi catchment",
    "managingEntity":{"reference":"Practitioner/prac-lineo-nthabi"},
    "member":[
      {"entity":{"reference":"Patient/patient-004"}},
      {"entity":{"reference":"Patient/patient-005"}},
      {"entity":{"reference":"Patient/patient-006"}}]}'

fhir_put Group group-matsieng \
  '{"resourceType":"Group","id":"group-matsieng","type":"person","actual":true,"active":true,
    "identifier":[{"use":"official","value":"HH-003"}],
    "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
    "name":"Matsieng - Mpho Lerotholi catchment",
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

# ─── 9g. Seed RelatedPerson (head of household) ──────────────────────────────
# The householdProfile Binary config has a familyHeadId JEXL rule that calls
# .get(0) on RelatedPerson resources filtered by code 99990006 (Head of Household).
# One RelatedPerson per group is required; linked to the head patient via .patient.
fhir_put RelatedPerson rp-head-ha-mokoena \
  '{"resourceType":"RelatedPerson","id":"rp-head-ha-mokoena","active":true,
    "patient":{"reference":"Patient/patient-001"},
    "relationship":[{"coding":[{"system":"https://www.snomed.org","code":"99990006","display":"Head of Household"}]}],
    "name":[{"use":"official","text":"Thabo Mokoena"}]}'

fhir_put RelatedPerson rp-head-ha-sehlabane \
  '{"resourceType":"RelatedPerson","id":"rp-head-ha-sehlabane","active":true,
    "patient":{"reference":"Patient/patient-004"},
    "relationship":[{"coding":[{"system":"https://www.snomed.org","code":"99990006","display":"Head of Household"}]}],
    "name":[{"use":"official","text":"Lineo Nthabi"}]}'

fhir_put RelatedPerson rp-head-matsieng \
  '{"resourceType":"RelatedPerson","id":"rp-head-matsieng","active":true,
    "patient":{"reference":"Patient/patient-007"},
    "relationship":[{"coding":[{"system":"https://www.snomed.org","code":"99990006","display":"Head of Household"}]}],
    "name":[{"use":"official","text":"Mpho Lerotholi"}]}'

log "RelatedPerson (head of household) seeded for 3 groups."

# ─── 9h. OpenSRP app config: IG + Composition + Binaries ─────────────────────
# The OpenSRP FHIR Core Android app downloads its navigation/form configuration
# from a chain: ImplementationGuide → Composition → Binary (base64-encoded JSON).
#
# Config files are in config/fhir/ (extracted from the reference APK build).
# The Composition mirrors the APK's composition_config.json structure, using
# focus.identifier.value in each section so ConfigurationRegistry can key the
# downloaded Binary content correctly.  inventoryRegister and inventoryProfile
# sections are added to expose the Stock Inventory menu that is already wired
# into the APK's navigation_config.json staticMenu.
log "Seeding OpenSRP app configuration (23 Binaries + Composition + IG) ..."
FHIR_CONFIGS_DIR="$(pwd)/config/fhir"
export FHIR_CONFIGS_DIR PYTHONIOENCODING=utf-8
python3 << 'PYEOF'
import base64, json, os, urllib.request, urllib.error

HAPI    = "http://localhost:8079/fhir"
CONFIGS = os.environ["FHIR_CONFIGS_DIR"]

def fhir_put(resource_type, resource_id, body):
    url  = f"{HAPI}/{resource_type}/{resource_id}"
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data, method="PUT",
           headers={"Content-Type": "application/fhir+json"})
    try:
        with urllib.request.urlopen(req) as r:
            print(f"  {resource_type}/{resource_id} → {r.getcode()}")
    except urllib.error.HTTPError as e:
        print(f"  WARNING: {resource_type}/{resource_id} → {e.code} {e.read().decode()[:200]}")

def read_b64(rel_path):
    with open(os.path.join(CONFIGS, rel_path), "rb") as f:
        return base64.b64encode(f.read()).decode()

def ctype(rel_path):
    return "text/x-java-properties" if rel_path.endswith(".properties") else "application/json"

def upload_binary(binary_id, rel_path):
    fhir_put("Binary", binary_id, {
        "resourceType": "Binary",
        "id":           binary_id,
        "contentType":  ctype(rel_path),
        "data":         read_b64(rel_path),
    })

# ── Binaries: IDs match the APK's composition_config.json references ──────────
# These are the exact IDs the Composition sections point to. ConfigurationRegistry
# keys each Binary by focus.identifier.value from the Composition section.
binaries = [
    # id                                         rel_path
    ("4755546c-e61f-43bb-b599-5cad230a3d529e",  "application_config.json"),
    ("a982504f-8d8b-4151-abc6-0063793500d4e",   "sync_config.json"),
    ("d7ce0167-ee6a-4f8f-b644-50b0242513239e",  "navigation_config.json"),
    # registers
    ("7ebbbf4e-c783-42f2-998d-3c6bdde5c0c6e",   "registers/household_register_config.json"),
    ("e64815e6-56c1-4200-b2a6-6ec13eedfec3e",   "registers/anc_register_config.json"),
    ("7a68f458-9402-4c07-be62-feb85d341c17e",   "registers/child_register_config.json"),
    ("bbf28ade-5bc5-11ed-9b6a-0242ac120090e",   "registers/task_register_config.json"),
    ("d90ae75b-b180-45c0-ab57-24dc6c885cc1e",   "registers/cmntd_register_config.json"),
    ("7d0ce69f-22c2-4829-90b4-c0aadebdffbae",   "registers/fp_register_config.json"),
    ("faa1688d-98fa-4954-9889-6c2bdf4d4e57e",   "registers/hiv_register_config.json"),
    ("ba22490f-d24b-43d0-b6f4-f5af474bbf05e",   "registers/mental_health_register_config.json"),
    ("9aa6bbb6-df76-42a4-bdbe-72dc197378cae",   "registers/pnc_register_config.json"),
    ("079a2120-e802-4445-95ac-59511751a4c0e",   "registers/sick_child_register_config.json"),
    ("2ac6ec4f-1a29-4d85-a015-06db9c1b82d9e",   "registers/tb_register_config.json"),
    ("inv-register-config-001",                  "registers/inventory_register_config.json"),
    ("stock-accept-reg-001",                     "registers/stock_acceptance_register_config.json"),
    # profiles
    ("bbb3c2b0-51c9-44e9-9674-7d311ad5f859e",   "profiles/household_profile_config.json"),
    ("34b709f3-e8a1-44e9-867a-714b68bb1367e",   "profiles/default_profile_config.json"),
    ("a6d69650-4806-4bb1-bd2b-a60fa18418a0e",   "profiles/other_registers_profile_config.json"),
    ("inv-profile-config-001",                   "profiles/inventory_profile_config.json"),
    # translations
    ("c6757818-25c8-4e51-ba51-0c9dd882cbbbe",   "translations/strings_config.properties"),
    ("eee5f9c1-49f6-4b18-b088-8a52689a79d8e",   "translations/strings_sw_config.properties"),
    ("43e6c036-bb83-481e-8ffd-f8fdb7ee54a0e",   "translations/strings_fr_config.properties"),
]
for bid, rel in binaries:
    upload_binary(bid, rel)

# ── Group: AL 20/120mg commodity ──────────────────────────────────────────────
# inventoryRegister syncs via Group?type=medication; local filter uses code=386452003
# active:true required — FHIR SDK local search requires Group.active=true
fhir_put("Group", "commodity-al-20-120", {
    "resourceType": "Group",
    "id":           "commodity-al-20-120",
    "active":       True,
    "type":         "medication",
    "actual":       True,
    "name":         "AL 20/120mg",
    "code": {"coding": [{"system": "http://snomed.info/sct",
                         "code": "386452003",
                         "display": "Supply inventory item"}]},
})

# ── Observation: initial stock balance for inventory register ─────────────────
# inventoryRegister reads runningBalance from Observation.component[0].value.value
# where status=preliminary, subject=Group/commodity-al-20-120
import datetime as _dt
_today = _dt.date.today().isoformat()
fhir_put("Observation", "obs-stock-al-20-120", {
    "resourceType":     "Observation",
    "id":               "obs-stock-al-20-120",
    "status":           "preliminary",
    "code": {"coding": [{"system": "http://snomed.info/sct",
                         "code": "386452003",
                         "display": "Stock on hand"}]},
    "subject":          {"reference": "Group/commodity-al-20-120"},
    "effectiveDateTime": _today,
    "component": [
        {"code": {"coding": [{"system": "http://snomed.info/sct",
                              "code": "386452003",
                              "display": "Running balance"}]},
         "valueQuantity": {"value": 10000, "unit": "tablet",
                           "system": "http://unitsofmeasure.org", "code": "{tablet}"}}
    ]
})

# ── Groups + Observations: 7 additional medicines ─────────────────────────────
_extra_medicines = [
    ("amoxicillin-250mg", "Amoxicillin 250mg",   5000),
    ("rdt-kit",           "RDT Kit",              500),
    ("paracetamol-syr",   "Paracetamol Syrup",    3000),
    ("cotrimoxazole-480mg","Cotrimoxazole 480mg", 5000),
    ("ors-sachet",        "ORS Sachet",           2000),
    ("zinc-20mg",         "Zinc 20mg",            8000),
    ("iron-folic-acid",   "Iron + Folic Acid",    10000),
]
for _code, _name, _qty in _extra_medicines:
    fhir_put("Group", f"commodity-{_code}", {
        "resourceType": "Group",
        "id":           f"commodity-{_code}",
        "active":       True,
        "type":         "medication",
        "actual":       True,
        "name":         _name,
        "code": {"coding": [{"system": "http://snomed.info/sct",
                             "code": "386452003",
                             "display": "Supply inventory item"}]},
    })
    fhir_put("Observation", f"obs-stock-{_code}", {
        "resourceType":     "Observation",
        "id":               f"obs-stock-{_code}",
        "status":           "preliminary",
        "code": {"coding": [{"system": "http://snomed.info/sct",
                             "code": "386452003",
                             "display": "Stock on hand"}]},
        "subject":          {"reference": f"Group/commodity-{_code}"},
        "effectiveDateTime": _today,
        "component": [
            {"code": {"coding": [{"system": "http://snomed.info/sct",
                                  "code": "386452003",
                                  "display": "Running balance"}]},
             "valueQuantity": {"value": _qty, "unit": "unit",
                               "system": "http://unitsofmeasure.org", "code": "{unit}"}}
        ]
    })

# ── Questionnaire: household registration ─────────────────────────────────────
fhir_put("Questionnaire", "f210a832-857f-49e6-93f5-399eec4f4edb", {
    "resourceType": "Questionnaire",
    "id":           "f210a832-857f-49e6-93f5-399eec4f4edb",
    "status":       "active",
    "title":        "Add Household",
    "subjectType":  ["Group"],
    "extension": [{
        "url": "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-targetStructureMap",
        "valueCanonical": "http://fhir.lesotho.org/fhir/StructureMap/household-registration"
    }],
    "item": [
        {"linkId": "household-name", "text": "Household Name / Village", "type": "string", "required": True},
        {"linkId": "head-group", "text": "Head of Household", "type": "group", "item": [
            {"linkId": "head-first-name", "text": "First Name",   "type": "string", "required": True},
            {"linkId": "head-last-name",  "text": "Last Name",    "type": "string", "required": True},
            {"linkId": "head-gender",     "text": "Sex",          "type": "choice", "required": True,
             "answerOption": [
                 {"valueCoding": {"code": "male",   "display": "Male"}},
                 {"valueCoding": {"code": "female", "display": "Female"}}
             ]},
            {"linkId": "head-dob",   "text": "Date of Birth", "type": "date"},
            {"linkId": "head-phone", "text": "Phone Number",  "type": "string"}
        ]}
    ]
})

# ── Questionnaire: add household member ───────────────────────────────────────
fhir_put("Questionnaire", "e5155788-8831-4916-a3f5-486915ce34b2", {
    "resourceType": "Questionnaire",
    "id":           "e5155788-8831-4916-a3f5-486915ce34b2",
    "status":       "active",
    "title":        "Add Household Member",
    "subjectType":  ["Patient"],
    "item": [
        {
            "linkId": "ed77104e-c279-4030-ab20-8cd99ca99ca9",
            "text": "OpenSRP ID",
            "type": "integer",
            "readOnly": True
        },
        {
            "linkId": "toggle-is-family-head",
            "text": "Is Family Head",
            "type": "integer",
            "readOnly": True
        },
        {
            "linkId": "first-name",
            "text": "First Name",
            "type": "string",
            "required": True
        },
        {
            "linkId": "last-name",
            "text": "Last Name",
            "type": "string",
            "required": True
        },
        {
            "linkId": "gender",
            "text": "Sex",
            "type": "choice",
            "required": True,
            "answerOption": [
                {"valueCoding": {"code": "male",   "display": "Male"}},
                {"valueCoding": {"code": "female", "display": "Female"}}
            ]
        },
        {
            "linkId": "dob",
            "text": "Date of Birth",
            "type": "date"
        },
        {
            "linkId": "phone",
            "text": "Phone Number",
            "type": "string"
        }
    ]
})

# ── Questionnaire: stock dispense ─────────────────────────────────────────────
fhir_put("Questionnaire", "qn-stock-dispense", {
    "resourceType": "Questionnaire",
    "id":     "qn-stock-dispense",
    "title":  "Dispense AL 20/120mg",
    "status": "active",
    "subjectType": ["Patient"],
    "item": [
        {"linkId": "patient",   "text": "Patient",
         "type": "reference",   "required": True},
        {"linkId": "commodity", "text": "Commodity",
         "type": "choice",      "required": True,
         "answerOption": [
             {"valueCoding": {"code": "AL-20-120",          "display": "AL 20/120mg (6 tablets)"}},
             {"valueCoding": {"code": "amoxicillin-250mg",  "display": "Amoxicillin 250mg"}},
             {"valueCoding": {"code": "rdt-kit",            "display": "RDT Kit"}},
             {"valueCoding": {"code": "paracetamol-syr",    "display": "Paracetamol Syrup"}},
             {"valueCoding": {"code": "cotrimoxazole-480mg","display": "Cotrimoxazole 480mg"}},
             {"valueCoding": {"code": "ors-sachet",         "display": "ORS Sachet"}},
             {"valueCoding": {"code": "zinc-20mg",          "display": "Zinc 20mg"}},
             {"valueCoding": {"code": "iron-folic-acid",    "display": "Iron + Folic Acid"}},
         ]},
        {"linkId": "quantity",  "text": "Quantity dispensed (tablets)",
         "type": "integer",     "required": True,
         "initial": [{"valueInteger": 6}]},
        {"linkId": "date",      "text": "Date dispensed",
         "type": "date",        "required": True},
    ]
})

# ── Questionnaire: stock management dispense form ─────────────────────────────
fhir_put("Questionnaire", "qn-stock-mgmt-dispense", {
    "resourceType": "Questionnaire",
    "id":     "qn-stock-mgmt-dispense",
    "title":  "Dispense Medication",
    "status": "active",
    "subjectType": ["Patient"],
    "item": [
        {"linkId": "medication_name",
         "text": "Select Item",
         "type": "choice",
         "required": True,
         "answerOption": [
             {"valueCoding": {"code": "AL-20-120",          "display": "AL 20/120mg"}},
             {"valueCoding": {"code": "amoxicillin-250mg",  "display": "Amoxicillin 250mg"}},
             {"valueCoding": {"code": "rdt-kit",            "display": "RDT Kit"}},
             {"valueCoding": {"code": "paracetamol-syr",    "display": "Paracetamol Syrup"}},
             {"valueCoding": {"code": "cotrimoxazole-480mg","display": "Cotrimoxazole 480mg"}},
             {"valueCoding": {"code": "ors-sachet",         "display": "ORS Sachet"}},
             {"valueCoding": {"code": "zinc-20mg",          "display": "Zinc 20mg"}},
             {"valueCoding": {"code": "iron-folic-acid",    "display": "Iron + Folic Acid"}},
         ]},
        {"linkId": "batch_number",
         "text": "Batch Number",
         "type": "string",
         "required": True},
        {"linkId": "quantity_dispensed",
         "text": "Quantity",
         "type": "integer"},
        {"linkId": "expiry_date",
         "text": "Expiry Date",
         "type": "date"},
    ]
})

# ── Questionnaire: stock order ────────────────────────────────────────────────
fhir_put("Questionnaire", "qn-stock-order", {
    "resourceType": "Questionnaire",
    "id":     "qn-stock-order",
    "url":    "http://10.0.2.2:8079/fhir/Questionnaire/qn-stock-order",
    "title":  "Stock Order",
    "status": "active",
    "subjectType": ["Patient"],
    "item": [
        {"linkId": "order_item",
         "text": "Select Item",
         "type": "choice",
         "required": True,
         "answerOption": [
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "AL-20-120",          "display": "AL 20/120mg"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "amoxicillin-250mg",  "display": "Amoxicillin 250mg"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "rdt-kit",            "display": "RDT Kit"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "paracetamol-syr",    "display": "Paracetamol Syrup"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "cotrimoxazole-480mg","display": "Cotrimoxazole 480mg"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "ors-sachet",         "display": "ORS Sachet"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "zinc-20mg",          "display": "Zinc 20mg"}},
             {"valueCoding": {"system": "http://snomed.info/sct", "code": "iron-folic-acid",    "display": "Iron + Folic Acid"}},
         ]},
        {"linkId": "order_quantity",
         "text": "Quantity Requested",
         "type": "integer",
         "required": True},
        {"linkId": "order_date",
         "text": "Order Date",
         "type": "date"},
        {"linkId": "order_notes",
         "text": "Notes",
         "type": "string"},
    ]
})

# ── Questionnaire: stock count ────────────────────────────────────────────────
fhir_put("Questionnaire", "qn-stock-count", {
    "resourceType": "Questionnaire",
    "id":     "qn-stock-count",
    "title":  "Stock Count",
    "status": "active",
    "subjectType": ["Organization"],
    "item": [
        {"linkId": "commodity", "text": "Commodity",
         "type": "choice",      "required": True,
         "answerOption": [
             {"valueCoding": {"code": "AL-20-120",          "display": "AL 20/120mg"}},
             {"valueCoding": {"code": "amoxicillin-250mg",  "display": "Amoxicillin 250mg"}},
             {"valueCoding": {"code": "rdt-kit",            "display": "RDT Kit"}},
             {"valueCoding": {"code": "paracetamol-syr",    "display": "Paracetamol Syrup"}},
             {"valueCoding": {"code": "cotrimoxazole-480mg","display": "Cotrimoxazole 480mg"}},
             {"valueCoding": {"code": "ors-sachet",         "display": "ORS Sachet"}},
             {"valueCoding": {"code": "zinc-20mg",          "display": "Zinc 20mg"}},
             {"valueCoding": {"code": "iron-folic-acid",    "display": "Iron + Folic Acid"}},
         ]},
        {"linkId": "balance",   "text": "Physical stock count (units)",
         "type": "integer",     "required": True},
        {"linkId": "date",      "text": "Count date",
         "type": "date",        "required": True},
        {"linkId": "notes",     "text": "Notes (optional)",
         "type": "string",      "required": False},
    ]
})

# ── Questionnaire: stock acceptance ──────────────────────────────────────────
# VHW accepts stock issued by eLMIS. linkIds mirror what the mediator's
# POST /fhir/QuestionnaireResponse route reads (medication, quantity, type, task_id).
fhir_put("Questionnaire", "qn-stock-accept", {
    "resourceType": "Questionnaire",
    "id":     "qn-stock-accept",
    "title":  "Accept Stock",
    "status": "active",
    "subjectType": ["Practitioner"],
    "item": [
        {"linkId": "task_id",
         "text": "Task Reference",
         "type": "string",
         "readOnly": True},
        {"linkId": "medication",
         "text": "Product",
         "type": "choice",
         "required": True,
         "answerOption": [
             {"valueCoding": {"code": "AL-20-120",          "display": "AL 20/120mg"}},
             {"valueCoding": {"code": "amoxicillin-250mg",  "display": "Amoxicillin 250mg"}},
             {"valueCoding": {"code": "rdt-kit",            "display": "RDT Kit"}},
             {"valueCoding": {"code": "paracetamol-syr",    "display": "Paracetamol Syrup"}},
             {"valueCoding": {"code": "cotrimoxazole-480mg","display": "Cotrimoxazole 480mg"}},
             {"valueCoding": {"code": "ors-sachet",         "display": "ORS Sachet"}},
             {"valueCoding": {"code": "zinc-20mg",          "display": "Zinc 20mg"}},
             {"valueCoding": {"code": "iron-folic-acid",    "display": "Iron + Folic Acid"}},
         ]},
        {"linkId": "quantity_issued",
         "text": "Quantity Issued",
         "type": "integer",
         "readOnly": True},
        {"linkId": "quantity",
         "text": "Quantity Accepted",
         "type": "integer",
         "required": True},
        {"linkId": "condition",
         "text": "Condition",
         "type": "choice",
         "answerOption": [
             {"valueCoding": {"code": "good",    "display": "Good"}},
             {"valueCoding": {"code": "damaged", "display": "Some Damaged"}},
             {"valueCoding": {"code": "expired", "display": "Some Expired"}},
         ]},
        {"linkId": "type",
         "text": "Transaction Type",
         "type": "string",
         "readOnly": True,
         "initial": [{"valueString": "RECEIPT"}]},
        {"linkId": "notes",
         "text": "Notes",
         "type": "string"},
    ]
})

# ── Demo Tasks: pending stock acceptance ──────────────────────────────────────
# Two Tasks representing stock issued by the health facility to opensrp-admin.
# status=requested + code=373748001 = picked up by the stockAcceptanceRegister.
import datetime as _dt2
_today = _dt2.date.today().isoformat()

# Look up opensrp-admin Practitioner ID dynamically (changes on container recreate).
# HAPI FHIR validates reference existence, so we must use the real resource ID.
_admin_prac_id = None
try:
    _req = urllib.request.Request(f"{HAPI}/Practitioner?name=opensrp-admin&_count=1")
    with urllib.request.urlopen(_req, timeout=10) as _resp:
        _entries = json.loads(_resp.read()).get("entry", [])
    if _entries:
        _admin_prac_id = _entries[0]["resource"]["id"]
except Exception as _e:
    print(f"  WARNING: could not look up opensrp-admin Practitioner: {_e}", flush=True)

if not _admin_prac_id:
    # Fallback: use a stable VHW practitioner so Tasks are still visible in some account
    _admin_prac_id = "prac-thabo-mokoena"
    print(f"  WARNING: using fallback owner Practitioner/{_admin_prac_id} for demo Tasks", flush=True)
else:
    print(f"  opensrp-admin Practitioner ID = {_admin_prac_id}", flush=True)

fhir_put("Task", "task-pending-001", {
    "resourceType": "Task",
    "id":           "task-pending-001",
    "status":       "requested",
    "intent":       "order",
    "code": {"coding": [{"system": "http://snomed.info/sct",
                         "code": "373748001", "display": "Stock Issue"}]},
    "description":  "AL 20/120mg — 120 units (ref: LMIS-2026-001)",
    "for":          {"reference": f"Practitioner/{_admin_prac_id}"},
    "owner":        {"reference": f"Practitioner/{_admin_prac_id}"},
    "authoredOn":   f"{_today}T08:00:00Z",
    "input": [
        {"type": {"text": "product"},   "valueString":  "AL-20-120"},
        {"type": {"text": "quantity"},  "valueInteger": 120},
        {"type": {"text": "issueRef"},  "valueString":  "LMIS-2026-001"},
    ]
})
fhir_put("Task", "task-pending-002", {
    "resourceType": "Task",
    "id":           "task-pending-002",
    "status":       "requested",
    "intent":       "order",
    "code": {"coding": [{"system": "http://snomed.info/sct",
                         "code": "373748001", "display": "Stock Issue"}]},
    "description":  "AL 20/120mg — 60 units (ref: LMIS-2026-002)",
    "for":          {"reference": f"Practitioner/{_admin_prac_id}"},
    "owner":        {"reference": f"Practitioner/{_admin_prac_id}"},
    "authoredOn":   f"{_today}T08:30:00Z",
    "input": [
        {"type": {"text": "product"},   "valueString":  "AL-20-120"},
        {"type": {"text": "quantity"},  "valueInteger": 60},
        {"type": {"text": "issueRef"},  "valueString":  "LMIS-2026-002"},
    ]
})

# ── Composition: mirrors the APK's composition_config.json ────────────────────
# Load the bundled composition and modify it for HAPI FHIR:
#   - id "214558" → "app-composition" (HAPI rejects purely numeric IDs)
#   - strip meta (version conflicts on re-seed)
comp_path = os.path.join(CONFIGS, "composition_config.json")
with open(comp_path) as f:
    comp = json.load(f)

comp["id"] = "app-composition"
comp.pop("meta", None)

fhir_put("Composition", "app-composition", comp)

# ── ImplementationGuide ────────────────────────────────────────────────────────
fhir_put("ImplementationGuide", "ig-lesotho-vhw", {
    "resourceType":  "ImplementationGuide",
    "id":            "ig-lesotho-vhw",
    "url":           "http://lesotho.gov.ls/fhir/ImplementationGuide/ig-lesotho-vhw",
    "version":       "1.0.0",
    "name":          "app",
    "title":         "Lesotho VHW Implementation Guide",
    "status":        "active",
    "packageId":     "app",
    "fhirVersion":   ["4.0.1"],
    "useContext":    [{"code": {"code": "program"}, "valueQuantity": {"value": 1}}],
    "definition": {
        "resource": [{
            "reference":     {"reference": "Composition/app-composition"},
            "name":          "App Composition",
            "exampleBoolean": False,
        }]
    },
})

print(f"OpenSRP app config seeded: IG, Composition, {len(binaries)} Binaries, 3 Questionnaires, 8 commodity Groups.")
PYEOF

# ─── 10. Generate DHIS2 analytics tables ──────────────────────────────────────
log "Step 10: Generating DHIS2 analytics tables..."
JOB_ID=$(curl -s -u admin:district -X POST "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('response',{}).get('id',''))" 2>/dev/null)
if [ -n "$JOB_ID" ]; then
  log "  Analytics job started: $JOB_ID — waiting up to 60s..."
  for i in $(seq 1 12); do
    sleep 5
    DONE=$(curl -s -u admin:district "http://localhost:8081/api/system/tasks/ANALYTICS_TABLE/${JOB_ID}" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[-1].get('completed',False) if d else False)" 2>/dev/null)
    if [ "$DONE" = "True" ]; then
      log "  Analytics tables ready."
      break
    fi
  done
else
  log "  Warning: could not start analytics job — run manually after seeding."
fi

# ─── 11. Patch OpenHIM Console index.html with OpenLMIS theme link ────────────
log "Step 11: Applying OpenLMIS theme to OpenHIM Console..."
docker exec openhim-console sh -c "
  if ! grep -q 'openlmis-theme.css' /usr/share/nginx/html/index.html; then
    sed -i 's|<link href=\"styles.css\" rel=\"stylesheet\">|<link href=\"styles.css\" rel=\"stylesheet\"><link href=\"openlmis-theme.css\" rel=\"stylesheet\">|' /usr/share/nginx/html/index.html
    echo 'Theme link injected.'
  else
    echo 'Theme link already present — skipping.'
  fi
" && log "  OpenHIM Console theme applied."

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
log "         \"whenHandedOver\":\"${NOW}\","
log "         \"quantity\":{\"value\":6,\"unit\":\"tablet\"}}'"
log ""
log "Expected: HTTP 200, status: Successful"
log "  opensrp=HTTP 201  dhis2=HTTP 200  openlmis=HTTP 201"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
