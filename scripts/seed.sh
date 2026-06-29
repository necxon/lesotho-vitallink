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

# Lockfile to prevent concurrent seed runs
SEED_LOCK="/tmp/lesotho-seed.lock"
trap "rm -f '$SEED_LOCK'" EXIT

# Fail if another seed is already running
if [[ -f "$SEED_LOCK" ]]; then
  log "ERROR: Another seed is already running (PID in $SEED_LOCK). Exiting."
  exit 1
fi

touch "$SEED_LOCK"

# Move to repo root so docker compose and relative paths work
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# When launched non-interactively from PowerShell on Windows, Git Bash does not
# source its profile, so /usr/bin is missing from PATH (sleep, curl, wc, etc.).
# Also add Windows Python 3 location so python3 resolves on Git Bash without venv.
export PATH="/usr/bin:/bin:/c/Users/Neels.Lotter/AppData/Local/Programs/Python/Python313:$PATH"
# Git Bash sees python.exe but scripts call python3 — export a function shim.
if ! command -v python3 &>/dev/null && command -v python &>/dev/null; then
  python3() { python "$@"; }
  export -f python3
fi

# ─── Fixed UUIDs ──────────────────────────────────────────────────────────────
# CRITICAL: these must stay in sync with mediator/index.js constants.
FACILITY_ID="28de536f-b826-4eeb-a3c4-d65221a1120d"
FACILITY_B_ID="28de536f-b826-4eeb-a3c4-d65221a1120e"   # ATP 2nd facility — Maseru District Clinic B
PROGRAM_ID="31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c"
ORDERABLE_ID="3be1d20f-6aa9-4e52-864f-4fa04aa02056"
# ATP profile uses 3 medicines (Oxytocin, Amoxicillin, Paracetamol); their orderable UUIDs:
ATP_ORDERABLES="3be1d20f-6aa9-4e52-864f-4fa04aa02056 3be1d20f-6aa9-4e52-864f-4fa04aa02002 3be1d20f-6aa9-4e52-864f-4fa04aa02004"
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
# Public origin for the bkm-web SPA — used to register the Keycloak client redirect
# URIs. Auto-detected from Keycloak's configured hostname so a PROD reseed does not
# clobber the bkm-web client with localhost (which breaks portal login with
# "Invalid parameter: redirect_uri"). Override explicitly with BKM_WEB_ORIGIN=...
if [ -z "${BKM_WEB_ORIGIN:-}" ]; then
  _KC_HOST=$(docker exec keycloak printenv KC_HOSTNAME_URL 2>/dev/null || true)
  case "$_KC_HOST" in
    *lesotho-bkm.xyz*) BKM_WEB_ORIGIN="https://lesotho-bkm.xyz" ;;  # prod domain
    *)                 BKM_WEB_ORIGIN="http://localhost:9902"   ;;  # local default
  esac
fi
# Must match the mediator's OPENHIM_PASS (docker-compose.yml, default 'password') so the
# mediator can register/heartbeat after a seed. Sourced from OPENHIM_PASS to guarantee it.
OPENHIM_PASSWORD="${OPENHIM_PASS:-password}"
DHIS2_PASSWORD="${DHIS2_PASSWORD:-district}"
LMIS_PASSWORD="${LMIS_PASSWORD:-password}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
PG_PASSWORD="${PG_PASSWORD:-password123}"

DHIS2_ORG_UNIT="dwx1Yz4BwNX"
DHIS2_DATA_ELEMENT="ujPSJuS9pph"
DHIS2_DE_STOCK_RECEIVED="StckRcvdAL1"
DHIS2_DE_STOCK_ON_HAND="StockOnHnd1"

# Profile: bkm (multi-medicine, 3 VHWs) or atp (Oxytocin 10 IU, 1 VHW)
# Set via: PROFILE=atp bash scripts/seed.sh  or  make profile-atp
# DHIS2 UIDs are kept the same across profiles — the mediator env vars (DHIS2_ORDERABLE_DE_MAP etc.)
# are overridden per-profile via config/docker-compose.atp.override.yml, not by changing the element UIDs.
PROFILE="${PROFILE:-atp}"

# Per-medicine dispensed data elements (7 new medicines)
DHIS2_DE_AMOX="DEAmox25001"
DHIS2_DE_RDT="DERdtKit001"
DHIS2_DE_PARA="DEParSyr001"
DHIS2_DE_CTX="DECtx480001"
DHIS2_DE_ORS="DEOrsAch001"
DHIS2_DE_ZINC="DEZinc20001"
DHIS2_DE_IFA="DEIrnFol001"
DHIS2_DE_ADJ_EXPIRED="DEAdjExp001"
DHIS2_DE_ADJ_DAMAGED="DEAdjDmg001"
DHIS2_DE_ADJ_LOST="DEAdjLst001"
# Per-medicine ordered data elements (stock order quantities sent to eLMIS)
DHIS2_DE_ORD_AL="DEOrdAL0001"
DHIS2_DE_ORD_AMOX="DEOrdAmx001"
DHIS2_DE_ORD_RDT="DEOrdRdt001"
DHIS2_DE_ORD_PARA="DEOrdPar001"
DHIS2_DE_ORD_CTX="DEOrdCtx001"
DHIS2_DE_ORD_ORS="DEOrdOrs001"
DHIS2_DE_ORD_ZINC="DEOrdZnc001"
DHIS2_DE_ORD_IFA="DEOrdIfa001"
# Per-medicine SOH data elements (7 new medicines; AL uses StockOnHnd1)
DHIS2_DE_AMOX_SOH="DEAmoxSOH01"
DHIS2_DE_RDT_SOH="DERdtSOH001"
DHIS2_DE_PARA_SOH="DEParSOH001"
DHIS2_DE_CTX_SOH="DECtxSOH001"
DHIS2_DE_ORS_SOH="DEOrsSOH001"
DHIS2_DE_ZINC_SOH="DEZncSOH001"
DHIS2_DE_IFA_SOH="DEIfaSOH001"
# VHW category disaggregation UIDs (per-field-worker breakdown on dispensed DEs)
VHW_CAT_OPT_ADM="VHWOptAdm01"   # CategoryOption: opensrp-admin
VHW_CAT_OPT_VHW="VHWOptVhw01"   # CategoryOption: vhw-leribe-01
VHW_CATEGORY="VHWCat00001"       # Category: Field Worker
VHW_CAT_COMBO="VHWCatCmb01"     # CategoryCombo: Field Worker
VHW_COC_ADM="VHWCocAdm01"       # CategoryOptionCombo: opensrp-admin
VHW_COC_VHW="VHWCocVhw01"       # CategoryOptionCombo: vhw-leribe-01

# DHIS2 org unit hierarchy — national + 3 districts + 31 facilities
DHIS2_OU_NATIONAL="LesNatOrg01"
DHIS2_OU_MASERU_DIST="MasDistOrg1"
DHIS2_OU_LERIBE_DIST="LerDistOrg1"
DHIS2_OU_BEREA_DIST="BeaDistOrg1"
# VHW village org units (children of dwx1Yz4BwNX) — used for per-VHW order Maps
DHIS2_OU_HA_MOKOENA="VilHaMokoe1"   # VHW: Thabo Mokoena
DHIS2_OU_HA_SEHLABANE="VilHaSehl01" # VHW: Lineo Nthabi
DHIS2_OU_MATSIENG="VilMatsien1"     # VHW: Mpho Lerotholi

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
  wait_http "Keycloak" "http://localhost:8083/auth/realms/opensrp"

  # OpenLMIS: wait until auth service issues a token
  log "Waiting for OpenLMIS auth service ..."
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null -u user-client:changeme \
        -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
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
          -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
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
    -u admin:${DHIS2_PASSWORD}
fi

# ─── 1. Fix OpenHIM password hash ─────────────────────────────────────────────
# Two passport protocols exist:
#   local  — bcrypt; used by the OpenHIM Console web login
#   token  — sha512(salt+password); used by openhim-mediator-utils API auth
# Both must be set to 'password' on every seed run.
log "Resetting OpenHIM root password hash ..."
# Ensure mediator container is running before we exec into it (it may have crashed on
# startup if OpenHIM wasn't ready yet when it first tried to register).
docker compose up -d bkm-mediator >/dev/null 2>&1 || true
sleep 3

# 1a. local (bcrypt) — console login
BCRYPT_HASH=$(docker exec openhim-core node -e \
  "const b=require('bcryptjs')||require('bcrypt');Promise.resolve(b.hash('${OPENHIM_PASSWORD}',10)).then(h=>process.stdout.write(h))" \
  2>/dev/null)
docker exec openhim-mongo mongo --quiet openhim --eval \
  "db.passports.updateOne({protocol:'local',email:'root@openhim.org'},{\$set:{password:'${BCRYPT_HASH}'}})" \
  > /dev/null

# 1b. token (sha512) — mediator API auth
SALT=$(docker exec openhim-mongo mongo --quiet openhim \
  --eval "print(db.passports.findOne({protocol:'token',email:'root@openhim.org'}).passwordSalt)")
if [ -n "$SALT" ] && [ "$SALT" != "null" ]; then
  HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha512(('${SALT}'+'${OPENHIM_PASSWORD}').encode()).hexdigest(), end='')")
  docker exec openhim-mongo mongo --quiet openhim --eval \
    "db.passports.updateOne({protocol:'token',email:'root@openhim.org'},{\$set:{passwordHash:'${HASH}'}})" \
    > /dev/null
fi
log "OpenHIM password hashes updated — restarting mediator to re-register ..."
docker compose restart bkm-mediator
sleep 5

# Clear order dispatch log so stock orders can flow through on a fresh start.
# The log persists on the mediator-data volume across container restarts; without
# this reset the current period would be permanently blocked after the first dispatch.
docker exec bkm-mediator sh -c 'echo "{}" > /data/dispatched-orders.json' 2>/dev/null || true
log "Order dispatch log cleared."

# ─── 1b. Seed OpenHIM visualizer ──────────────────────────────────────────────
log "Seeding OpenHIM visualizer ..."
docker exec bkm-mediator node -e "
const https = require('https');
const crypto = require('crypto');
const agent = new https.Agent({rejectUnauthorized:false});

function openhimReq(salt, method, path, body, cb) {
  const now = new Date().toISOString();
  const passhash = crypto.createHash('sha512').update(salt+'password').digest('hex');
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
  const passhash = crypto.createHash('sha512').update(salt+'password').digest('hex');
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
    name: 'BKM MedicationDispense',
    urlPattern: '^/fhir/MedicationDispense\$',
    methods: ['POST'],
    type: 'http',
    status: 'enabled',
    routes: [{name:'Vital-Link Endpoint', host:'bkm-mediator', port:3000, primary:true, type:'http'}],
    allow: [],
    authType: 'public'
  },
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
# Retry up to 5 times — the mediator restart in step 1 can trigger a brief
# consul-template nginx reload in OpenLMIS, causing the first attempt to get 502/504.
log "Obtaining OpenLMIS admin token ..."
LMIS_TOKEN=""
for _i in 1 2 3 4 5; do
  LMIS_TOKEN=$(curl -sf --max-time 10 -u user-client:changeme \
    -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
    http://localhost:8082/api/oauth/token 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))" 2>/dev/null \
    || true)
  [[ -n "$LMIS_TOKEN" ]] && break
  log "  OpenLMIS token attempt ${_i}/5 failed — retrying in 3s ..."
  sleep 3
done
[[ -z "$LMIS_TOKEN" ]] && { log "ERROR: could not obtain OpenLMIS token after 5 attempts"; exit 1; }

# ─── 3. Fix OpenLMIS nginx rate limit + missing-endpoint stubs ────────────────
# consul-template inside the nginx container fails on WSL2 (UDP socket:
# function not implemented), so we bypass it entirely: gen_openlmis_nginx.py
# generates a complete nginx config using Docker DNS hostnames (stable across
# IP reassignments) and writes it directly to the bind-mounted host file.

log "Regenerating OpenLMIS nginx config (hostname-based, bypasses consul-template) ..."
NGINX_CONF_HOST="$(cd "$(dirname "$0")/.." && pwd)/../openlmis-ref-distro/config/nginx/openlmis-default.conf"
python3 "$(dirname "$0")/gen_openlmis_nginx.py" > "$NGINX_CONF_HOST" \
  && docker exec openlmis-ref-distro-nginx-1 nginx -s reload \
  && log "nginx config regenerated and reloaded."

log "Patching OpenLMIS nginx (rate-limit + missing-endpoint stubs) ..."

python3 - <<'PYEOF'
import re, subprocess, sys

C = 'openlmis-ref-distro-nginx-1'
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
    '[{{"code":"EM","name":"Essential Medicines","active":true,'
    '"periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,'
    '"enableDatePhysicalStockCountCompleted":false,'
    '"id":"{p}"}}]'
).format(p=PROGRAM_ID)

def read_file(path):
    r = subprocess.run(['docker', 'exec', C, 'cat', path], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

def write_file(path, content):
    w = subprocess.run(['docker', 'exec', '-i', C, 'sh', '-c', f'cat > {path}'],
        input=content.encode('utf-8'), capture_output=True)
    if w.returncode != 0:
        print(f'ERROR: could not write {path}: {w.stderr.decode().strip()}', file=sys.stderr)
        raise SystemExit(1)

def write_login_fix_js():
    """Write login-fix.js to /etc/nginx/login-fix.js inside the nginx container.
    Using alias instead of return 200 because JS braces/dollars break nginx config parsing."""
    js = r"""(function(){
  if(window.__idbCleared)return;
  window.__idbCleared=true;
  if(window.indexedDB&&indexedDB.databases){
    indexedDB.databases().then(function(dbs){
      dbs.forEach(function(db){try{indexedDB.deleteDatabase(db.name);}catch(e){}});
    });
  }
  if("serviceWorker"in navigator){
    navigator.serviceWorker.getRegistrations().then(function(r){
      if(r.length>0){
        Promise.all(r.map(function(sw){return sw.unregister();})).then(function(){
          if(!sessionStorage.getItem("sw_cleared")){
            sessionStorage.setItem("sw_cleared","1");
            window.location.reload(true);
          }
        });
      }
    });
  }
})();
"""
    write_file('/etc/nginx/login-fix.js', js)
    print('login-fix.js written to /etc/nginx/login-fix.js')

# Stubs as plain nginx config — no Go template syntax needed (static returns).
# T = template indent (2sp location, 4sp directives); R = rendered indent (6sp/8sp).
def make_stubs(loc_indent, dir_indent):
    L, D = loc_indent, dir_indent
    return (
        f'# bkm-stubs-v7\n'
        # OPTIONS preflight to /api/oauth/token returns 401 from auth service → browser
        # blocks the login POST before it fires. Exact-match overrides the regex proxy block.
        f'{L}location = /api/oauth/token {{\n'
        + f'{D}if ($request_method = OPTIONS) {{\n'
        + f'{D}    add_header Access-Control-Allow-Origin $http_origin always;\n'
        + f'{D}    add_header Access-Control-Allow-Methods "POST, OPTIONS" always;\n'
        + f'{D}    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;\n'
        + f'{D}    add_header Access-Control-Allow-Credentials true always;\n'
        + f'{D}    return 204;\n'
        + f'{D}}}\n'
        + f'{D}proxy_pass http://auth;\n'
        + f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        + f'{L}}}\n'
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
        + f'{L}location = /api/userContactDetails {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"content":[{{"referenceDataUserId":"{ADMIN_UUID}","emailDetails":{{"email":"admin@example.com","emailVerified":false}},"phoneNumber":"","allowNotify":true}}],"totalElements":1,"totalPages":1,"last":true,"first":true,"number":0,"numberOfElements":1,"size":10}}\';\n'
        f'{L}}}\n'
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
        f'{D}resolver 127.0.0.11 valid=10s ipv6=off;\n'
        f'{D}set $sysnot http://bkm-mediator:3000;\n'
        f'{D}rewrite ^/api/systemNotifications(.*)$ /lmis-notifications$1 break;\n'
        f'{D}proxy_pass $sysnot;\n'
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
        f'{L}location ~ /api/users/[^/]+/fulfillmentFacilities {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'[{{"id":"{FACILITY_ID}","name":"Maseru District Clinic A","code":"MC-A","active":true,"geographicZone":{{"id":"d7b0f7a9-65c4-4e8f-bb8a-4b2a3b9c1d02","name":"Maseru"}},"type":{{"id":"facility-type-health-center","name":"Health Center"}}}}]\';\n'
        f'{L}}}\n'
        f'{L}location = /api/programs {{\n'
        f'{D}default_type application/json;\n'
        f'{D}if ($arg_access) {{\n'
        f'{D}  return 200 \'[{{"id":"{PROGRAM_ID}","name":"Essential Medicines","code":"EM","active":true,"periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,"enableDatePhysicalStockCountCompleted":false}}]\';\n'
        f'{D}}}\n'
        f'{D}proxy_pass http://referencedata;\n'
        f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        f'{L}}}\n'
        f'{L}location ~ /api/facilities/?$ {{\n'
        f'{D}if ($arg_minimal = "true") {{\n'
        f'{D}  set $args "page=0&size=2000";\n'
        f'{D}}}\n'
        f'{D}proxy_pass http://referencedata;\n'
        f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        f'{L}}}\n'
        f'{L}location ~ /localeSettings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        # SPA calls /api/featureFlags on startup — 404 triggers a JS exception that
        # corrupts the Angular form scope -> "This field is required" on the login page.
        f'{L}location ~ /api/featureFlags {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ /api/settings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{}}\';\n'
        f'{L}}}\n'
        # SPA fetches /api/currencySettings at bootstrap (before login) to format numbers.
        # The real endpoint requires auth -> 401 -> error interceptor -> "Internal application error".
        # Return Lesotho Loti (LSL / M) settings as a public stub.
        f'{L}location = /api/currencySettings {{\n'
        f'{D}default_type application/json;\n'
        f'{D}return 200 \'{{"currencyCode":"LSL","currencySymbol":"M","currencySymbolSide":"left","currencyDecimalPlaces":2,"groupingSeparator":",","groupingSize":3,"decimalSeparator":"."}}\';\n'
        f'{L}}}\n'
        f'{L}location ~ "^/\\{{\\{{" {{\n'
        f'{D}return 200 \'\';\n'
        f'{L}}}\n'
        # Login form fix — comprehensive version:
        # 1. sub_filter patches openlmis.js to add novalidate directly to the form HTML
        # 2. login-fix.js clears stale SW/IDB cache, strips required attrs, syncs Angular scope
        + f'{L}location = /openlmis.js {{\n'
        + f'{D}proxy_pass http://reference-ui;\n'
        + f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        + f'{D}proxy_set_header Accept-Encoding "";\n'
        + f'{D}sub_filter \'<form ng-submit="vm.doLogin()">\' \'<form ng-submit="vm.doLogin()" novalidate>\';\n'
        + f'{D}sub_filter \'function getObjectForReference(objectList,reference){{return reference?objectList.filter\' \'function getObjectForReference(objectList,reference){{return reference&&objectList?objectList.filter\';\n'
        + f'{D}sub_filter \'fulfill.lot&&(fulfill.lot=lots.filter(\' \'fulfill.lot&&lots&&(fulfill.lot=lots.filter(\';\n'
        + f'{D}sub_filter_once off;\n'
        + f'{L}}}\n'
        # login-fix.js served via alias — JS braces/dollars break nginx return 200 parsing.
        # The file is written to /etc/nginx/login-fix.js by write_login_fix_js() below.
        + f'{L}location = /login-fix.js {{\n'
        + f'{D}default_type application/javascript;\n'
        + f'{D}alias /etc/nginx/login-fix.js;\n'
        + f'{L}}}\n'
        + f'{L}location = / {{\n'
        + f'{D}proxy_pass http://reference-ui;\n'
        + f'{D}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        + f'{D}proxy_set_header Accept-Encoding "";\n'
        + f'{D}sub_filter \'<head>\' \'<head><script>window.applicationCache=window.applicationCache||{{addEventListener:function(){{}},removeEventListener:function(){{}},update:function(){{}},status:0,UNCACHED:0,IDLE:1,CHECKING:2,DOWNLOADING:3,UPDATEREADY:4,OBSOLETE:5}};</script>\';\n'
        + f'{D}sub_filter \'</body>\' \'<script src="/login-fix.js"></script></body>\';\n'
        + f'{D}sub_filter_once on;\n'
        + f'{L}}}\n'
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
                + '\n    "nginx" 0;          # Internal service-to-service calls'
                + tmpl[eol:])
        changed = True; print('template: rate-limit map patched')

    # B) Stubs — insert before the consul-template range loop that generates
    #    location blocks from Consul KV.  This anchor is always present.
    TMPL_ANCHOR = '  # First retrieve paths without parameters'
    if 'bkm-stubs-v7' not in tmpl:
        for old_v in ('# bkm-stubs-v6\n', '# bkm-stubs-v5\n', '# bkm-stubs-v4\n', '# bkm-stubs-v3\n', '# bkm-stubs-v2\n', '# bkm-stubs-v1\n'):
            if old_v in tmpl:
                tmpl = tmpl.replace(old_v, make_stubs('  ', '    '), 1)
                changed = True; print('template: stubs upgraded to v7')
                break
        else:
            if TMPL_ANCHOR in tmpl:
                tmpl = tmpl.replace(TMPL_ANCHOR, make_stubs('  ', '    ') + TMPL_ANCHOR, 1)
                changed = True; print('template: stubs inserted (v7)')

    # C) Catch unrendered AngularJS template URLs (nginx decodes %7B%7B -> {{ before matching)
    if '\\{\\{' not in tmpl and TMPL_ANCHOR in tmpl:
        tmpl = tmpl.replace(TMPL_ANCHOR,
            '  location ~ "^/\\{\\{" {\n    return 200 \'\';\n  }\n' + TMPL_ANCHOR, 1)
        changed = True; print('template: angular template URL stub inserted')

    if changed:
        try:
            write_file(TMPL_PATH, tmpl)
            print('consul-template template written')
        except SystemExit:
            # nginx v7.1+ mounts /etc/consul-template read-only; skip template patch.
            # Only the rendered config will be patched (re-seed after consul re-render).
            print('WARN: consul-template template is read-only — skipping template patch', file=sys.stderr)
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
               '    "nginx" 0;          # Internal service-to-service calls\n'
               '}')
    c = c[:old_map.start()] + new_map + c[old_map.end():]
    changed = True; print('rendered: rate-limit map patched')

# B) Stubs — insert before the first /api/notification location block.
#    This block is always present (generated from the "api/notification" Consul KV key).
CONF_ANCHOR = 'location ~ /api/notification/?'
if 'bkm-stubs-v7' not in c:
    for old_v in ('# bkm-stubs-v6\n', '# bkm-stubs-v5\n', '# bkm-stubs-v4\n', '# bkm-stubs-v3\n', '# bkm-stubs-v2\n', '# bkm-stubs-v1\n'):
        if old_v in c:
            c = c.replace(old_v, make_stubs('      ', '        '), 1)
            changed = True; print('rendered: stubs upgraded to v7')
            break
    else:
        if CONF_ANCHOR in c:
            c = c.replace(CONF_ANCHOR, make_stubs('      ', '        ') + CONF_ANCHOR, 1)
            changed = True; print('rendered: stubs inserted (v7)')

# C) Catch unrendered AngularJS template URLs (nginx decodes %7B%7B -> {{ before matching)
if '\\{\\{' not in c and CONF_ANCHOR in c:
    c = c.replace(CONF_ANCHOR,
        '  location ~ "^/\\{\\{" {\n    return 200 \'\';\n  }\n' + CONF_ANCHOR, 1)
    changed = True; print('rendered: angular template URL stub inserted')

if changed:
    try:
        write_file(CONF_PATH, c)
        print('rendered nginx config written')
    except SystemExit:
        print('WARN: rendered nginx config is read-only — patch already applied by gen_openlmis_nginx.py', file=sys.stderr)
else:
    print('rendered nginx config: already up to date')

write_login_fix_js()
PYEOF

# consul-template is bypassed: nginx runs directly with a bind-mounted config
# (openlmis-ref-distro/config/nginx/openlmis-default.conf).  Just reload nginx
# to pick up any stub updates written above, no container restart needed.
docker exec openlmis-ref-distro-nginx-1 nginx -s reload >/dev/null 2>&1 || true
log "nginx patches applied (nginx reloaded)."

set +e  # DHIS2 steps are best-effort — failures are non-fatal
# ─── 4. Seed DHIS2 (org unit + data element) ─────────────────────────────────
# Uses the /api/metadata bulk import endpoint — idempotent (CREATE_AND_UPDATE).
# These UIDs are hardcoded in mediator/index.js and must not change.
log "Seeding DHIS2 metadata ..."
DHIS2_RESULT=$(curl -sf -u admin:${DHIS2_PASSWORD} -X POST \
  "http://localhost:8081/api/metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=NONE" \
  -H "Content-Type: application/json" \
  -d "{
    \"organisationUnits\": [
      {\"id\":\"${DHIS2_OU_NATIONAL}\",\"name\":\"Lesotho\",\"shortName\":\"Lesotho\",\"openingDate\":\"1966-10-04\"},
      {\"id\":\"${DHIS2_OU_MASERU_DIST}\",\"name\":\"Maseru District\",\"shortName\":\"Maseru\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_NATIONAL}\"}},
      {\"id\":\"${DHIS2_OU_LERIBE_DIST}\",\"name\":\"Leribe District\",\"shortName\":\"Leribe\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_NATIONAL}\"}},
      {\"id\":\"${DHIS2_OU_BEREA_DIST}\",\"name\":\"Berea District\",\"shortName\":\"Berea\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_NATIONAL}\"}},
      {\"id\":\"${DHIS2_ORG_UNIT}\",\"name\":\"Maseru District Clinic A\",\"shortName\":\"Maseru Clinic A\",\"openingDate\":\"2000-01-01\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasClinicB1\",\"name\":\"Maseru District Clinic B\",\"shortName\":\"Maseru Clinic B\",\"openingDate\":\"2000-01-01\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"${DHIS2_OU_HA_MOKOENA}\",\"name\":\"Ha Mokoena Village\",\"shortName\":\"Ha Mokoena\",\"openingDate\":\"2000-01-01\",\"parent\":{\"id\":\"${DHIS2_ORG_UNIT}\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":[27.523,-29.354]}},
      {\"id\":\"${DHIS2_OU_HA_SEHLABANE}\",\"name\":\"Ha Sehlabane Village\",\"shortName\":\"Ha Sehlabane\",\"openingDate\":\"2000-01-01\",\"parent\":{\"id\":\"${DHIS2_ORG_UNIT}\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":[27.441,-29.283]}},
      {\"id\":\"${DHIS2_OU_MATSIENG}\",\"name\":\"Matsieng Village\",\"shortName\":\"Matsieng\",\"openingDate\":\"2000-01-01\",\"parent\":{\"id\":\"${DHIS2_ORG_UNIT}\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":[27.552,-29.421]}},
      {\"id\":\"LerFac00001\",\"name\":\"Motebang Hospital\",\"shortName\":\"Motebang Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00002\",\"name\":\"Mamohau Hospital\",\"shortName\":\"Mamohau Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00003\",\"name\":\"St Rose H/C\",\"shortName\":\"St Rose\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00004\",\"name\":\"St Anna H/C\",\"shortName\":\"St Anna\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00005\",\"name\":\"Maputsoe Filter Clinic\",\"shortName\":\"Maputsoe Filter\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00006\",\"name\":\"Maputsoe SDA\",\"shortName\":\"Maputsoe SDA\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00007\",\"name\":\"St Monica H/C\",\"shortName\":\"St Monica\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00008\",\"name\":\"Linotsing H/C\",\"shortName\":\"Linotsing\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00009\",\"name\":\"Mositi H/C\",\"shortName\":\"Mositi\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"LerFac00010\",\"name\":\"Thabaphatsoa H/C\",\"shortName\":\"Thabaphatsoa\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_LERIBE_DIST}\"}},
      {\"id\":\"BeaFac00001\",\"name\":\"Berea Hospital\",\"shortName\":\"Berea Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00002\",\"name\":\"Maluti Adventist Hospital\",\"shortName\":\"Maluti Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00003\",\"name\":\"Mahlatsa H/C\",\"shortName\":\"Mahlatsa\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00004\",\"name\":\"Kolojane H/C\",\"shortName\":\"Kolojane\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00005\",\"name\":\"St Theresa H/C\",\"shortName\":\"St Theresa\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00006\",\"name\":\"Sebidea H/C\",\"shortName\":\"Sebidea\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00007\",\"name\":\"Lenkoane H/C\",\"shortName\":\"Lenkoane\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00008\",\"name\":\"Mapheleng H/C\",\"shortName\":\"Mapheleng\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00009\",\"name\":\"Bethany H/C\",\"shortName\":\"Bethany\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"BeaFac00010\",\"name\":\"Pilot H/C\",\"shortName\":\"Pilot\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_BEREA_DIST}\"}},
      {\"id\":\"MasFac00001\",\"name\":\"Queen Mamohato Hospital\",\"shortName\":\"Queen Mamohato\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00002\",\"name\":\"Makoanyane Military Hospital\",\"shortName\":\"Makoanyane Mil\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00003\",\"name\":\"Queen Elizabeth II Hospital\",\"shortName\":\"QE II Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00004\",\"name\":\"St Joseph Hospital\",\"shortName\":\"St Joseph\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00005\",\"name\":\"Scott Hospital\",\"shortName\":\"Scott Hosp\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00006\",\"name\":\"Qoaling Filter Clinic\",\"shortName\":\"Qoaling Filter\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00007\",\"name\":\"St Leo H/C\",\"shortName\":\"St Leo\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00008\",\"name\":\"Loretto H/C\",\"shortName\":\"Loretto\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00009\",\"name\":\"St Leonard H/C\",\"shortName\":\"St Leonard\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}},
      {\"id\":\"MasFac00010\",\"name\":\"Seventh Day Adventist H/C\",\"shortName\":\"SDA H/C\",\"openingDate\":\"1966-10-04\",\"parent\":{\"id\":\"${DHIS2_OU_MASERU_DIST}\"}}
    ],
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
      },
      {
        \"id\": \"${DHIS2_DE_AMOX}\",
        \"name\": \"Stock Dispensed - Amoxicillin 250mg\",
        \"shortName\": \"Amox 250mg Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_RDT}\",
        \"name\": \"Stock Dispensed - RDT Kit\",
        \"shortName\": \"RDT Kit Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_PARA}\",
        \"name\": \"Stock Dispensed - Paracetamol Syrup\",
        \"shortName\": \"Paracetamol Syr Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_CTX}\",
        \"name\": \"Stock Dispensed - Cotrimoxazole 480mg\",
        \"shortName\": \"CTX 480mg Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORS}\",
        \"name\": \"Stock Dispensed - ORS Sachet\",
        \"shortName\": \"ORS Sachet Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ZINC}\",
        \"name\": \"Stock Dispensed - Zinc 20mg\",
        \"shortName\": \"Zinc 20mg Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_IFA}\",
        \"name\": \"Stock Dispensed - Iron + Folic Acid\",
        \"shortName\": \"IFA Dispensed\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ADJ_EXPIRED}\",
        \"name\": \"Stock Adjusted - AL 20/120mg Expired\",
        \"shortName\": \"AL Expired\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ADJ_DAMAGED}\",
        \"name\": \"Stock Adjusted - AL 20/120mg Damaged\",
        \"shortName\": \"AL Damaged\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ADJ_LOST}\",
        \"name\": \"Stock Adjusted - AL 20/120mg Lost/Stolen\",
        \"shortName\": \"AL Lost/Stolen\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_AMOX_SOH}\",
        \"name\": \"Stock on Hand - Amoxicillin 250mg\",
        \"shortName\": \"Amox 250mg SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_RDT_SOH}\",
        \"name\": \"Stock on Hand - RDT Kit\",
        \"shortName\": \"RDT Kit SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_PARA_SOH}\",
        \"name\": \"Stock on Hand - Paracetamol Syrup\",
        \"shortName\": \"Paracetamol Syr SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_CTX_SOH}\",
        \"name\": \"Stock on Hand - Cotrimoxazole 480mg\",
        \"shortName\": \"CTX 480mg SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORS_SOH}\",
        \"name\": \"Stock on Hand - ORS Sachet\",
        \"shortName\": \"ORS Sachet SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ZINC_SOH}\",
        \"name\": \"Stock on Hand - Zinc 20mg\",
        \"shortName\": \"Zinc 20mg SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_IFA_SOH}\",
        \"name\": \"Stock on Hand - Iron + Folic Acid\",
        \"shortName\": \"IFA SOH\",
        \"aggregationType\": \"LAST\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_AL}\",
        \"name\": \"Stock Ordered - AL 20/120mg\",
        \"shortName\": \"AL 20/120mg Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_AMOX}\",
        \"name\": \"Stock Ordered - Amoxicillin 250mg\",
        \"shortName\": \"Amox 250mg Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_RDT}\",
        \"name\": \"Stock Ordered - RDT Kit\",
        \"shortName\": \"RDT Kit Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_PARA}\",
        \"name\": \"Stock Ordered - Paracetamol Syrup\",
        \"shortName\": \"Paracetamol Syr Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_CTX}\",
        \"name\": \"Stock Ordered - Cotrimoxazole 480mg\",
        \"shortName\": \"CTX 480mg Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_ORS}\",
        \"name\": \"Stock Ordered - ORS Sachet\",
        \"shortName\": \"ORS Sachet Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_ZINC}\",
        \"name\": \"Stock Ordered - Zinc 20mg\",
        \"shortName\": \"Zinc 20mg Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      },
      {
        \"id\": \"${DHIS2_DE_ORD_IFA}\",
        \"name\": \"Stock Ordered - Iron + Folic Acid\",
        \"shortName\": \"IFA Ordered\",
        \"aggregationType\": \"SUM\",
        \"domainType\": \"AGGREGATE\",
        \"valueType\": \"INTEGER_ZERO_OR_POSITIVE\"
      }
    ]
  }")
log "DHIS2 seed result: $(echo "$DHIS2_RESULT" | grep -o '"status":"[^"]*"' | head -2 | tr '\n' ' ')"

# ─── 4b-vhw. Seed DHIS2 VHW category disaggregation ─────────────────────────
# Creates a "Field Worker" category so each dispense data value can be tagged
# with the VHW who performed it.  All 8 dispensed DEs are updated to use this
# CategoryCombo so the BKMVhwPivt1 visualization can break down by VHW.
log "Seeding DHIS2 VHW category disaggregation ..."
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/metadata" \
  -H "Content-Type: application/json" \
  -d "{
    \"categoryOptions\": [
      {\"id\": \"${VHW_CAT_OPT_ADM}\", \"name\": \"opensrp-admin\",  \"shortName\": \"Admin\"},
      {\"id\": \"${VHW_CAT_OPT_VHW}\", \"name\": \"vhw-leribe-01\",  \"shortName\": \"VHW Leribe\"}
    ],
    \"categories\": [
      {
        \"id\": \"${VHW_CATEGORY}\",
        \"name\": \"Field Worker\",
        \"shortName\": \"Field Worker\",
        \"dataDimensionType\": \"DISAGGREGATION\",
        \"categoryOptions\": [{\"id\": \"${VHW_CAT_OPT_ADM}\"}, {\"id\": \"${VHW_CAT_OPT_VHW}\"}]
      }
    ],
    \"categoryCombos\": [
      {
        \"id\": \"${VHW_CAT_COMBO}\",
        \"name\": \"Field Worker\",
        \"dataDimensionType\": \"DISAGGREGATION\",
        \"categories\": [{\"id\": \"${VHW_CATEGORY}\"}]
      }
    ],
    \"categoryOptionCombos\": [
      {
        \"id\": \"${VHW_COC_ADM}\",
        \"name\": \"opensrp-admin\",
        \"categoryCombo\": {\"id\": \"${VHW_CAT_COMBO}\"},
        \"categoryOptions\": [{\"id\": \"${VHW_CAT_OPT_ADM}\"}]
      },
      {
        \"id\": \"${VHW_COC_VHW}\",
        \"name\": \"vhw-leribe-01\",
        \"categoryCombo\": {\"id\": \"${VHW_CAT_COMBO}\"},
        \"categoryOptions\": [{\"id\": \"${VHW_CAT_OPT_VHW}\"}]
      }
    ]
  }" > /dev/null
# Update all 8 dispensed DEs to use the VHW CategoryCombo (idempotent PUT)
for DE_UID in "${DHIS2_DATA_ELEMENT}" "${DHIS2_DE_AMOX}" "${DHIS2_DE_RDT}" "${DHIS2_DE_PARA}" "${DHIS2_DE_CTX}" "${DHIS2_DE_ORS}" "${DHIS2_DE_ZINC}" "${DHIS2_DE_IFA}"; do
  DE_JSON=$(curl -s -u admin:${DHIS2_PASSWORD} "http://localhost:8081/api/dataElements/${DE_UID}?fields=:all")
  UPDATED=$(echo "$DE_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['categoryCombo'] = {'id': '${VHW_CAT_COMBO}'}
print(json.dumps(d))")
  curl -s -u admin:${DHIS2_PASSWORD} -X PUT "http://localhost:8081/api/dataElements/${DE_UID}" \
    -H "Content-Type: application/json" -d "$UPDATED" > /dev/null
done
log "DHIS2 VHW category disaggregation seeded"

# ─── 4b. Seed DHIS2 visualizations + dashboard ───────────────────────────────
log "Seeding DHIS2 dashboard ..."
# DHIS2 UIDs are exactly 11 chars [A-Za-z][A-Za-z0-9]{10}
# CRITICAL: /api/metadata strips columns/rows/filters from visualizations — must use
# POST /api/visualizations directly. Delete first makes this idempotent.

# All-medicine dx dimension — used in VHW, aggregation, and AL-all-medicine visualizations
ALL_MED_DX="[{\"id\":\"${DHIS2_DATA_ELEMENT}\"},{\"id\":\"${DHIS2_DE_AMOX}\"},{\"id\":\"${DHIS2_DE_RDT}\"},{\"id\":\"${DHIS2_DE_PARA}\"},{\"id\":\"${DHIS2_DE_CTX}\"},{\"id\":\"${DHIS2_DE_ORS}\"},{\"id\":\"${DHIS2_DE_ZINC}\"},{\"id\":\"${DHIS2_DE_IFA}\"}]"
DHIS2_VIZ_CHART="BKMBarChrt1"
DHIS2_VIZ_PIVOT="BKMPivotTb1"
DHIS2_VIZ_SOH="BKMSohLine1"
DHIS2_VIZ_RECV="BKMRecvBar1"
DHIS2_VIZ_COMBO="BKMDispSOH1"
DHIS2_VIZ_ALL="BKMAllPivt1"
DHIS2_VIZ_AGG_BAR="BKMAggBar01"
DHIS2_VIZ_AGG_PIVOT="BKMAggPivt1"
DHIS2_VIZ_SOH_PIVOT="BKMSohPivt1"
DHIS2_VIZ_VHW_PIVOT="BKMVhwPivt1"
DHIS2_DASHBOARD="BKMDashbrd1"
DHIS2_VIZ_ADJ_BAR="BKMAdjBar01"
DHIS2_VIZ_ADJ_PIVOT="BKMAdjPivt1"
DHIS2_VIZ_ADJ_TREND="BKMAdjTrnd1"
DHIS2_DASHBOARD_ADJ="BKMAdjDsh01"
# VHW stock orders map visualizations + dashboard
DHIS2_VIZ_ORD_BY_VHW="BKMOrdVhw01"   # Pivot: village rows × medicine columns
DHIS2_VIZ_ORD_BAR_VHW="BKMOrdVBar1"  # Bar chart: ordered per VHW village
DHIS2_DASHBOARD_VHW_MAP="BKMVhwMap01"

_seed_viz() {
  local uid="$1" payload="$2"
  curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/visualizations/${uid}" > /dev/null 2>&1 || true
  curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/visualizations" \
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

# ── SOH per-medicine pivot (facility × medicine, LAST aggregation) ──
ALL_MED_SOH_DX="[{\"id\":\"${DHIS2_DE_STOCK_ON_HAND}\"},{\"id\":\"${DHIS2_DE_AMOX_SOH}\"},{\"id\":\"${DHIS2_DE_RDT_SOH}\"},{\"id\":\"${DHIS2_DE_PARA_SOH}\"},{\"id\":\"${DHIS2_DE_CTX_SOH}\"},{\"id\":\"${DHIS2_DE_ORS_SOH}\"},{\"id\":\"${DHIS2_DE_ZINC_SOH}\"},{\"id\":\"${DHIS2_DE_IFA_SOH}\"}]"

_seed_viz "${DHIS2_VIZ_SOH_PIVOT}" "{
  \"id\": \"${DHIS2_VIZ_SOH_PIVOT}\",
  \"name\": \"Stock on Hand - All Medicines per Facility (Pivot)\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": ${ALL_MED_SOH_DX}}],
  \"rows\":    [{\"dimension\": \"ou\", \"items\": [{\"id\": \"LEVEL-3\"}, {\"id\": \"${DHIS2_OU_NATIONAL}\"}]}],
  \"filters\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"THIS_MONTH\"}]}],
  \"aggregationType\": \"LAST\",
  \"showData\": true,
  \"colTotals\": false,
  \"rowTotals\": true
}"

# ── Dispensed per Field Worker × Medicine (disaggregated by VHW CategoryCombo) ──
_seed_viz "${DHIS2_VIZ_VHW_PIVOT}" "{
  \"id\": \"${DHIS2_VIZ_VHW_PIVOT}\",
  \"name\": \"Dispensed per Field Worker x Medicine (Pivot)\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": ${ALL_MED_DX}}],
  \"rows\":    [{\"dimension\": \"${VHW_CATEGORY}\", \"items\": [{\"id\": \"${VHW_CAT_OPT_ADM}\"}, {\"id\": \"${VHW_CAT_OPT_VHW}\"}]}],
  \"filters\": [
    {\"dimension\": \"pe\", \"items\": [{\"id\": \"THIS_MONTH\"}]},
    {\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}
  ],
  \"aggregationType\": \"SUM\",
  \"showData\": true,
  \"colTotals\": true,
  \"rowTotals\": true
}"

# ── Aggregation event visualizations (facility-level breakdown — fed by POST /aggregate) ──
# Rows: LEVEL-3 org units under national root (all facilities)
# Columns: last 12 months
# Shows exactly what the daily aggregation cron reads from DHIS2 and pushes to OpenLMIS.

# Bar chart: rows=medicines (dx), columns=period, filter=single facility level
# Shows per-facility per-medication totals stacked as grouped bars
_seed_viz "${DHIS2_VIZ_AGG_BAR}" "{
  \"id\": \"${DHIS2_VIZ_AGG_BAR}\",
  \"name\": \"Aggregation - Dispensed per Facility per Medicine (Bar)\",
  \"type\": \"STACKED_COLUMN\",
  \"columns\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"rows\":    [{\"dimension\": \"ou\", \"items\": [{\"id\": \"LEVEL-3\"}, {\"id\": \"${DHIS2_OU_NATIONAL}\"}]}],
  \"filters\": [{\"dimension\": \"dx\", \"items\": ${ALL_MED_DX}}],
  \"aggregationType\": \"SUM\",
  \"domainAxisLabel\": \"Facility\",
  \"rangeAxisLabel\": \"Units Dispensed\",
  \"showData\": true
}"

# Pivot table: rows=facility, columns=medicine (dx), filter=current month
# This is the primary "per facility per medication" report
_seed_viz "${DHIS2_VIZ_AGG_PIVOT}" "{
  \"id\": \"${DHIS2_VIZ_AGG_PIVOT}\",
  \"name\": \"Aggregation - Dispensed per Facility x Medicine (Pivot)\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": ${ALL_MED_DX}}],
  \"rows\":    [{\"dimension\": \"ou\", \"items\": [{\"id\": \"LEVEL-3\"}, {\"id\": \"${DHIS2_OU_NATIONAL}\"}]}],
  \"filters\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"aggregationType\": \"SUM\",
  \"showData\": true,
  \"colTotals\": true,
  \"rowTotals\": true
}"

# Dashboard: DELETE+POST for create, then PUT to set items
# (metadata endpoint silently drops dashboardItems just like it drops viz dimensions)
curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD}" > /dev/null 2>&1 || true
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${DHIS2_DASHBOARD}\", \"name\": \"BKM Stock Dispensing - Lesotho\"}" > /dev/null
curl -sf -u admin:${DHIS2_PASSWORD} -X PUT "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_DASHBOARD}\",
    \"name\": \"BKM Stock Dispensing - Lesotho\",
    \"allowedFilters\": [\"pe\", \"ou\", \"VHWCat00001\"],
    \"dashboardItems\": [
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_AGG_BAR}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_AGG_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_SOH_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_VHW_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_CHART}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_SOH}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_RECV}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_COMBO}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ALL}\"}}
    ]
  }" > /dev/null
# Grant admin user access to the seeded national org unit so LEVEL-3 visualizations work
DHIS2_ADMIN_UID=$(curl -s -u admin:${DHIS2_PASSWORD} "http://localhost:8081/api/me?fields=id" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -s -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/users/${DHIS2_ADMIN_UID}/organisationUnits/${DHIS2_OU_NATIONAL}" > /dev/null
curl -s -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/users/${DHIS2_ADMIN_UID}/dataViewOrganisationUnits/${DHIS2_OU_NATIONAL}" > /dev/null
# Trigger analytics table rebuild so all 8 medicine DEs appear in visualizations immediately
curl -s -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/resourceTables/analytics" > /dev/null

# Schedule analytics rebuild every 5 minutes so dashboards stay near-real-time
# (Quartz cron: s m h day month dow). Idempotent: delete ALL existing ANALYTICS_TABLE
# jobs first (any name — covers the old "Nightly..." job too), then create fresh.
# NOTE: every-5-min full analytics is fine for this dataset; raise the interval
# (e.g. 0 30 2 ? * * for nightly) if DHIS2 data volume grows large.
for _aid in $(curl -s -u admin:${DHIS2_PASSWORD} \
    "http://localhost:8081/api/jobConfigurations?filter=jobType:eq:ANALYTICS_TABLE&fields=id&paging=false" \
    | python3 -c "import sys,json; [print(j['id']) for j in json.load(sys.stdin).get('jobConfigurations',[])]" 2>/dev/null); do
  curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/jobConfigurations/${_aid}" > /dev/null
done
curl -s -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/jobConfigurations" \
  -H "Content-Type: application/json" \
  -d '{"name":"BKM Analytics Rebuild (every 5 min)","jobType":"ANALYTICS_TABLE","cronExpression":"0 0/5 * ? * *","enabled":true,"jobParameters":{"lastYears":0,"skipTableTypes":[],"skipResourceTables":false}}' > /dev/null
log "DHIS2 analytics rebuild scheduled (every 5 minutes)"

log "DHIS2 dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD}"

# ── Stock Adjustments dashboard ───────────────────────────────────────────────
ADJ_DX="[{\"id\":\"${DHIS2_DE_ADJ_EXPIRED}\"},{\"id\":\"${DHIS2_DE_ADJ_DAMAGED}\"},{\"id\":\"${DHIS2_DE_ADJ_LOST}\"}]"

_seed_viz "${DHIS2_VIZ_ADJ_BAR}" "{
  \"id\": \"${DHIS2_VIZ_ADJ_BAR}\",
  \"name\": \"AL 20/120mg Stock Adjustments by Reason\",
  \"type\": \"COLUMN\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": ${ADJ_DX}}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\"
}"

_seed_viz "${DHIS2_VIZ_ADJ_PIVOT}" "{
  \"id\": \"${DHIS2_VIZ_ADJ_PIVOT}\",
  \"name\": \"AL 20/120mg Stock Adjustments - Pivot Table\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"rows\":    [{\"dimension\": \"dx\", \"items\": ${ADJ_DX}}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\",
  \"colTotals\": true,
  \"rowTotals\": true
}"

_seed_viz "${DHIS2_VIZ_ADJ_TREND}" "{
  \"id\": \"${DHIS2_VIZ_ADJ_TREND}\",
  \"name\": \"AL 20/120mg Dispensed vs Adjustments - Trend\",
  \"type\": \"LINE\",
  \"columns\": [{\"dimension\": \"dx\", \"items\": [{\"id\": \"${DHIS2_DATA_ELEMENT}\"},{\"id\": \"${DHIS2_DE_ADJ_EXPIRED}\"},{\"id\": \"${DHIS2_DE_ADJ_DAMAGED}\"},{\"id\": \"${DHIS2_DE_ADJ_LOST}\"}]}],
  \"rows\":    [{\"dimension\": \"pe\", \"items\": [{\"id\": \"LAST_12_MONTHS\"}]}],
  \"filters\": [{\"dimension\": \"ou\", \"items\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}]}],
  \"aggregationType\": \"SUM\"
}"

curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ADJ}" > /dev/null 2>&1 || true
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${DHIS2_DASHBOARD_ADJ}\", \"name\": \"BKM Stock Adjustments - Lesotho\"}" > /dev/null
curl -sf -u admin:${DHIS2_PASSWORD} -X PUT "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ADJ}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_DASHBOARD_ADJ}\",
    \"name\": \"BKM Stock Adjustments - Lesotho\",
    \"dashboardItems\": [
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ADJ_BAR}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ADJ_PIVOT}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ADJ_TREND}\"}}
    ]
  }" > /dev/null
log "DHIS2 adjustments dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD_ADJ}"

# ── VHW stock orders map — per-village breakdown ──────────────────────────────
# Dimension helpers
VHW_VILLAGES="[{\"id\":\"${DHIS2_OU_HA_MOKOENA}\"},{\"id\":\"${DHIS2_OU_HA_SEHLABANE}\"},{\"id\":\"${DHIS2_OU_MATSIENG}\"}]"
ALL_ORD_DX="[{\"id\":\"${DHIS2_DE_ORD_AL}\"},{\"id\":\"${DHIS2_DE_ORD_AMOX}\"},{\"id\":\"${DHIS2_DE_ORD_RDT}\"},{\"id\":\"${DHIS2_DE_ORD_PARA}\"},{\"id\":\"${DHIS2_DE_ORD_CTX}\"},{\"id\":\"${DHIS2_DE_ORD_ORS}\"},{\"id\":\"${DHIS2_DE_ORD_ZINC}\"},{\"id\":\"${DHIS2_DE_ORD_IFA}\"}]"

_seed_viz "${DHIS2_VIZ_ORD_BY_VHW}" "{
  \"id\": \"${DHIS2_VIZ_ORD_BY_VHW}\",
  \"name\": \"Stock Orders by VHW Village - Pivot Table\",
  \"type\": \"PIVOT_TABLE\",
  \"columns\": [{\"dimension\": \"dx\",  \"items\": ${ALL_ORD_DX}}],
  \"rows\":    [{\"dimension\": \"ou\",  \"items\": ${VHW_VILLAGES}}],
  \"filters\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"THIS_MONTH\"}]}],
  \"aggregationType\": \"SUM\",
  \"colTotals\": true,
  \"rowTotals\": true,
  \"showDimensionLabels\": true,
  \"hideEmptyRowItems\": \"BEFORE_FIRST_AFTER_LAST\"
}"

_seed_viz "${DHIS2_VIZ_ORD_BAR_VHW}" "{
  \"id\": \"${DHIS2_VIZ_ORD_BAR_VHW}\",
  \"name\": \"Stock Orders by VHW Village - Bar Chart\",
  \"type\": \"COLUMN\",
  \"columns\": [{\"dimension\": \"dx\",  \"items\": ${ALL_ORD_DX}}],
  \"rows\":    [{\"dimension\": \"ou\",  \"items\": ${VHW_VILLAGES}}],
  \"filters\": [{\"dimension\": \"pe\", \"items\": [{\"id\": \"THIS_MONTH\"}]}],
  \"aggregationType\": \"SUM\",
  \"showValues\": true
}"

# Create DHIS2 Maps object — bubble layer per village sized by total ordered AL
DHIS2_MAP_ORD="BKMOrdMap01"
curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/maps/${DHIS2_MAP_ORD}" > /dev/null 2>&1 || true
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/maps" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_MAP_ORD}\",
    \"name\": \"VHW Stock Orders - Village Map\",
    \"longitude\": 27.49,
    \"latitude\": -29.35,
    \"zoom\": 11,
    \"basemap\": \"osmLight\",
    \"mapViews\": [
      {
        \"layer\": \"thematic\",
        \"thematicMapType\": \"BUBBLE\",
        \"renderingStrategy\": \"SINGLE\",
        \"dataElement\": {\"id\": \"${DHIS2_DE_ORD_AL}\"},
        \"period\": \"THIS_MONTH\",
        \"organisationUnitSelectionMode\": \"SELECTED\",
        \"organisationUnits\": ${VHW_VILLAGES},
        \"opacity\": 0.9,
        \"colorLow\": \"#fee8c8\",
        \"colorHigh\": \"#e34a33\"
      },
      {
        \"layer\": \"boundary\",
        \"organisationUnitSelectionMode\": \"SELECTED\",
        \"organisationUnits\": [{\"id\": \"${DHIS2_ORG_UNIT}\"}],
        \"opacity\": 0.5
      }
    ]
  }" > /dev/null

curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_VHW_MAP}" > /dev/null 2>&1 || true
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${DHIS2_DASHBOARD_VHW_MAP}\", \"name\": \"BKM VHW Stock Orders - Village Map\"}" > /dev/null
curl -sf -u admin:${DHIS2_PASSWORD} -X PUT "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_VHW_MAP}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_DASHBOARD_VHW_MAP}\",
    \"name\": \"BKM VHW Stock Orders - Village Map\",
    \"dashboardItems\": [
      {\"type\": \"MAP\",           \"map\":           {\"id\": \"${DHIS2_MAP_ORD}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ORD_BY_VHW}\"}},
      {\"type\": \"VISUALIZATION\", \"visualization\": {\"id\": \"${DHIS2_VIZ_ORD_BAR_VHW}\"}}
    ]
  }" > /dev/null
log "DHIS2 VHW village map dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD_VHW_MAP}"

# ── Stock Order Explanation dashboard ─────────────────────────────────────────
# Static info dashboard — explains the full stock order flow for operators.
# A separate live-status dashboard (BKMOrdDsh01) is maintained by the mediator.
DHIS2_DASHBOARD_ORD_INFO="BKMOrdInfo1"
ORD_EXPLAIN_TEXT="STOCK ORDER SYSTEM — HOW IT WORKS

OVERVIEW
Village Health Workers (VHWs) submit stock order requests through the BKM mobile app.
The mediator collects all orders during the month and dispatches one consolidated order
to OpenLMIS every Monday at 06:00. This batching reduces noise in the supply chain
and gives the district pharmacy a single weekly order to action.

STEP-BY-STEP FLOW
1. VHW opens the BKM app > Stock Orders form
2. VHW selects the medicine and enters the quantity needed
3. App submits a QuestionnaireResponse (type=ORDER) via OpenHIM to the mediator
4. Mediator atomically increments the running monthly total in PostgreSQL (order_buffer table)
   - Orders accumulate across multiple submissions for the same medicine
   - PostgreSQL survives mediator restarts; concurrent writes are race-condition-free
5. Mediator replies immediately with:
   - Current stock-on-hand at the facility (from OpenLMIS)
   - Quantity ordered so far this month
6. Every Monday 06:00 — mediator reads the PostgreSQL totals and sends ONE consolidated
   stock event to OpenLMIS (one line item per medicine, sum of all VHW requests)
7. If dispatch succeeds, the period is marked done — no duplicate orders that month
8. If dispatch fails, PostgreSQL totals are preserved and the next Monday cron retries automatically

WHAT VHWs SEE IN THE APP
- Confirmation that the order was saved
- Current stock-on-hand at the facility
- Total quantity ordered for the medicine this month (including this submission)
- Message: 'Order queued — dispatched in next batch'

MEDICINES COVERED (8 items seeded)
  AL 20/120mg | Co-Amoxiclav 400/57mg | Zinc Sulfate 20mg | ORS Sachets
  Paracetamol 500mg | Vitamin A 200,000IU | Mebendazole 500mg | Ferrous+Folic

DATA FLOW SUMMARY
  App > OpenHIM > Mediator > PostgreSQL order_buffer (accumulate) > OpenLMIS (batch Monday)

MONITORING
- Live dispatch status:  BKMOrdDsh01 dashboard (updated after every dispatch attempt)
- Order buffer (PG):     GET http://mediator:3000/aggregate/orders
- Manual dispatch:       POST http://mediator:3000/aggregate/orders
- Mediator logs:         docker logs bkm-mediator | grep order-dispatch

RETRY / RECOVERY
- Failed dispatch: PostgreSQL totals preserved; next Monday cron retries automatically
- Manual retry:    POST /aggregate/orders on mediator port 3000
- Already dispatched this period? The endpoint returns 'already-dispatched' (safe to call)
- To re-dispatch a period: remove the period key from /data/dispatched-orders.json"

curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ORD_INFO}" > /dev/null 2>&1 || true
curl -sf -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${DHIS2_DASHBOARD_ORD_INFO}\", \"name\": \"BKM Stock Order System - How It Works\"}" > /dev/null
curl -sf -u admin:${DHIS2_PASSWORD} -X PUT "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ORD_INFO}" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"${DHIS2_DASHBOARD_ORD_INFO}\",
    \"name\": \"BKM Stock Order System - How It Works\",
    \"dashboardItems\": [
      {\"type\": \"TEXT\", \"text\": $(echo "$ORD_EXPLAIN_TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}
    ]
  }" > /dev/null
log "DHIS2 stock order explanation dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD_ORD_INFO}"

# ── Order Gate live-status dashboard (BKMOrdDsh01) ────────────────────────────
# The mediator updates the TEXT item in this dashboard after every dispatch.
# Seed creates it so the mediator's PUT doesn't 404 on startup.
DHIS2_DASHBOARD_ORD_STATUS="BKMOrdDsh01"
curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ORD_STATUS}" > /dev/null 2>&1 || true
python3 -c "
import urllib.request, json, base64, sys
creds = base64.b64encode(b'admin:district').decode()
hdrs = {'Content-Type': 'application/json', 'Authorization': 'Basic ' + creds}
name = 'BKM Order Gate - Live Status'
# POST (create — ignore conflict if already exists)
req = urllib.request.Request('http://localhost:8081/api/dashboards',
  data=json.dumps({'id': '${DHIS2_DASHBOARD_ORD_STATUS}', 'name': name}).encode(),
  headers=hdrs, method='POST')
try: urllib.request.urlopen(req)
except: pass
# PUT (add TEXT item — non-fatal if DHIS2 is slow)
body = {'id': '${DHIS2_DASHBOARD_ORD_STATUS}', 'name': name,
  'dashboardItems': [{'type': 'TEXT', 'text': 'Initialising - mediator will update this after the next dispatch.'}]}
req = urllib.request.Request('http://localhost:8081/api/dashboards/${DHIS2_DASHBOARD_ORD_STATUS}',
  data=json.dumps(body).encode(), headers=hdrs, method='PUT')
try: urllib.request.urlopen(req)
except Exception as e: print('BKMOrdDsh01 PUT warning (non-fatal):', e, file=sys.stderr)
"
log "DHIS2 Order Gate live-status dashboard ready: http://localhost:8081/dhis-web-dashboard/index.html#/${DHIS2_DASHBOARD_ORD_STATUS}"

set -euo pipefail  # restore strict mode after DHIS2 steps
# ─── 5. Activate OpenLMIS admin user ─────────────────────────────────────────
# Flyway seeds admin with active=false; the SPA throws "Internal application error"
# when the logged-in user is inactive. Fix it every time referencedata restarts.
log "Activating OpenLMIS admin user ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c \
  "UPDATE referencedata.users SET active = true, verified = true WHERE username IN ('admin','administrator');" 2>/dev/null
log "Admin user activated."

# ─── 5b. Pre-seed unscoped right_assignments ──────────────────────────────────
# right_assignments is a denormalised cache — Flyway populates only a subset of
# unscoped rights on fresh starts.  Rebuild the FULL set from role_rights for
# the admin user so all /api/* endpoints (geo levels, facilities, etc.) work
# without needing to re-run the full Flyway demo-data clean+migrate cycle.
ADMIN_UUID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM referencedata.users WHERE username IN ('administrator','admin') ORDER BY username='administrator' DESC LIMIT 1;" | tr -d '[:space:]')
[[ -z "$ADMIN_UUID" ]] && { log "ERROR: admin user not found in referencedata DB"; exit 1; }
log "Patching unscoped right_assignments for admin (${ADMIN_UUID}) ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname)
  SELECT gen_random_uuid(), ra.userid, r.name
  FROM referencedata.role_assignments ra
  JOIN referencedata.role_rights rr ON rr.roleid = ra.roleid
  JOIN referencedata.rights r ON r.id = rr.rightid
  WHERE ra.userid = '${ADMIN_UUID}'
    AND ra.type = 'direct'
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "Unscoped rights pre-seeded."

# ─── 6. Seed OpenLMIS referencedata ───────────────────────────────────────────
log "Seeding OpenLMIS geographic levels ..."
lmis_put "/api/geographicLevels/${GEO_LEVEL_COUNTRY_ID}" \
  "{\"id\":\"${GEO_LEVEL_COUNTRY_ID}\",\"code\":\"country\",\"name\":\"Country\",\"levelNumber\":1}"
lmis_put "/api/geographicLevels/${GEO_LEVEL_DISTRICT_ID}" \
  "{\"id\":\"${GEO_LEVEL_DISTRICT_ID}\",\"code\":\"district\",\"name\":\"District\",\"levelNumber\":2}" || true

log "Seeding OpenLMIS geographic zones ..."
lmis_put "/api/geographicZones/${GEO_ZONE_COUNTRY_ID}" \
  "{\"id\":\"${GEO_ZONE_COUNTRY_ID}\",\"code\":\"LS\",\"name\":\"Lesotho\",\"level\":{\"id\":\"${GEO_LEVEL_COUNTRY_ID}\"}}"
lmis_put "/api/geographicZones/${GEO_ZONE_DISTRICT_ID}" \
  "{\"id\":\"${GEO_ZONE_DISTRICT_ID}\",\"code\":\"MSD\",\"name\":\"Maseru District\",\"level\":{\"id\":\"${GEO_LEVEL_DISTRICT_ID}\"},\"parent\":{\"id\":\"${GEO_ZONE_COUNTRY_ID}\"}}"

log "Seeding OpenLMIS program (direct DB — API PUT is update-only, POST ignores supplied UUID) ..."
# Delete any existing EM program with a wrong UUID, then upsert ours
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  DELETE FROM referencedata.programs WHERE code='EM' AND id != '${PROGRAM_ID}';
  INSERT INTO referencedata.programs
    (id, active, code, name, periodsskippable, shownonfullsupplytab, enabledatephysicalstockcountcompleted, skipauthorization)
  VALUES ('${PROGRAM_ID}', true, 'EM', 'Essential Medicines', false, true, false, false)
  ON CONFLICT (id) DO UPDATE SET active=true, name='Essential Medicines';" 2>/dev/null

# Seed facility types if not already present (ref-distro demo data may already have them)
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.facility_types (id, active, code, name, displayorder)
  SELECT '${FACILITY_TYPE_ID}', true, 'health_center', 'Health Center', 1
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.facility_types WHERE lower(code) = 'health_center');
  INSERT INTO referencedata.facility_types (id, active, code, name, displayorder)
  SELECT '${FACILITY_TYPE_HOSPITAL_ID}', true, 'hospital', 'Hospital', 2
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.facility_types WHERE lower(code) = 'hospital');" 2>/dev/null

# Always read back the actual UUID (ref-distro demo data may use different UUIDs)
FACILITY_TYPE_ID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM referencedata.facility_types WHERE lower(code) = 'health_center' LIMIT 1;" \
  | tr -d '[:space:]')
FACILITY_TYPE_HOSPITAL_ID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM referencedata.facility_types WHERE lower(code) = 'hospital' LIMIT 1;" \
  | tr -d '[:space:]')

log "Seeding OpenLMIS facility (with supported program) ..."
lmis_put "/api/facilities/${FACILITY_ID}" \
  "{\"id\":\"${FACILITY_ID}\",\"code\":\"MDA\",\"name\":\"Maseru District Clinic A\",\
\"geographicZone\":{\"id\":\"${GEO_ZONE_DISTRICT_ID}\"},\
\"type\":{\"id\":\"${FACILITY_TYPE_ID}\"},\
\"active\":true,\"enabled\":true,\
\"supportedPrograms\":[{\"id\":\"${PROGRAM_ID}\",\"supportActive\":true,\"supportLocallyFulfilled\":false}]}"

# ATP 2nd facility — Maseru District Clinic B. Same facility TYPE as Clinic A so the
# facility_type_approved_products rows (seeded per type below) cover it too.
lmis_put "/api/facilities/${FACILITY_B_ID}" \
  "{\"id\":\"${FACILITY_B_ID}\",\"code\":\"MDB\",\"name\":\"Maseru District Clinic B\",\
\"geographicZone\":{\"id\":\"${GEO_ZONE_DISTRICT_ID}\"},\
\"type\":{\"id\":\"${FACILITY_TYPE_ID}\"},\
\"active\":true,\"enabled\":true,\
\"supportedPrograms\":[{\"id\":\"${PROGRAM_ID}\",\"supportActive\":true,\"supportLocallyFulfilled\":false}]}"

docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c \
  "UPDATE referencedata.users SET homefacilityid = '${FACILITY_ID}' WHERE username IN ('admin','administrator');" 2>/dev/null
log "Admin user home facility set (${FACILITY_ID})."

# Profile-specific orderable values
if [ "$PROFILE" = "atp" ]; then
  ORDERABLE_FULLNAME="Oxytocin 10 IU"; ORDERABLE_CODE_VAL="OXYTOCIN10IU"; LOT_CODE_VAL="OXYT-LOT-2026"
else
  ORDERABLE_FULLNAME="AL 20/120mg";    ORDERABLE_CODE_VAL="AL20120";       LOT_CODE_VAL="AL-LOT-2026"
fi

log "Seeding OpenLMIS orderable (${ORDERABLE_FULLNAME}, direct DB — API PUT ignores supplied UUID) ..."
# Fixed UUIDs for the dispensable and orderable display category (sandbox-only, stable)
DISPENSABLE_ID="aaaaaaaa-0000-0000-0000-000000000001"
ODC_ID="a1b2c3d4-e5f6-4a7b-8c9d-000000000001"
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.dispensables (id, type) VALUES ('${DISPENSABLE_ID}', 'default')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.orderable_display_categories (id, code, displayname, displayorder)
    VALUES ('${ODC_ID}', 'DEFAULT', 'Default', 1)
    ON CONFLICT (id) DO NOTHING;
  DELETE FROM referencedata.orderables WHERE code='${ORDERABLE_CODE_VAL}' AND id != '${ORDERABLE_ID}';
  INSERT INTO referencedata.orderables
    (id, versionnumber, lastupdated, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
    VALUES ('${ORDERABLE_ID}', 1, NOW(), '${ORDERABLE_FULLNAME}', 0, 1, '${ORDERABLE_CODE_VAL}', false, '${DISPENSABLE_ID}')
    ON CONFLICT (id, versionnumber) DO UPDATE SET fullproductname='${ORDERABLE_FULLNAME}', code='${ORDERABLE_CODE_VAL}', netcontent=1;
  INSERT INTO referencedata.program_orderables
    (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, orderableversionnumber, programid)
    VALUES (gen_random_uuid(), true, 1, true, '${ODC_ID}', '${ORDERABLE_ID}', 1, '${PROGRAM_ID}')
    ON CONFLICT DO NOTHING;" 2>/dev/null

# Trade item + lot: required for OpenLMIS v2 stockCardSummaries API (used by the SPA).
# The SPA calls /api/v2/stockCardSummaries which queries approvedProducts first and
# then returns only lot-tracked cards. Without a lot the stock card is invisible in the UI.
TRADE_ITEM_ID="eeeeeeee-0000-0000-0000-000000000001"
LOT_ID="ffffffff-0000-0000-0000-000000000001"
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.trade_items (id, manufactureroftradeitem)
    VALUES ('${TRADE_ITEM_ID}', 'Novartis')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.orderable_identifiers (key, value, orderableid, orderableversionnumber)
    VALUES ('tradeItem', '${TRADE_ITEM_ID}', '${ORDERABLE_ID}', 1)
    ON CONFLICT DO NOTHING;" 2>/dev/null
# lot must go in after trade item exists
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active)
    VALUES ('${LOT_ID}', '${LOT_CODE_VAL}', '2028-12-31', '2026-01-01', '${TRADE_ITEM_ID}', true)
    ON CONFLICT (id) DO UPDATE SET lotcode='${LOT_CODE_VAL}';" 2>/dev/null
# facility_type_approved_products: v2 API queries approvedProducts for the facility type;
# without this entry the v2 endpoint returns an empty page even if stock cards exist.
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.facility_type_approved_products
    (id, versionnumber, lastupdated, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, active, facilitytypeid, orderableid, programid)
    SELECT gen_random_uuid(), 1, NOW(), 0, 3, 0, true, f.typeid, '${ORDERABLE_ID}', '${PROGRAM_ID}'
    FROM referencedata.facilities f
    WHERE f.id='${FACILITY_ID}'
    AND NOT EXISTS (
      SELECT 1 FROM referencedata.facility_type_approved_products
      WHERE facilitytypeid=f.typeid AND orderableid='${ORDERABLE_ID}' AND programid='${PROGRAM_ID}'
    );" 2>/dev/null
log "Trade item, lot (AL-LOT-2026), and approved product entry seeded."

# ─── 6a-ext. Seed the 7 additional medicine orderables ───────────────────────
# The hospital approved products and per-facility stock seeding reference these
# orderable UUIDs via FK — they must exist in referencedata.orderables first.
# DISPENSABLE_ID and ODC_ID already defined above. Uses same dispensable/category.
log "Seeding additional medicine orderables (Amox, RDT, Para, CTX, ORS, Zinc, IFA, Roller Bandages, Male Condoms) ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.orderables (id, versionnumber, lastupdated, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
  VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002', 1, NOW(), 'Amoxicillin 250mg',      0, 1, 'AMOX250', false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003', 1, NOW(), 'RDT Kit',                0, 1, 'RDTKIT',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004', 1, NOW(), 'Paracetamol Syrup',      0, 1, 'PARASYR', false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005', 1, NOW(), 'Cotrimoxazole 480mg',    0, 1, 'CTX480',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006', 1, NOW(), 'ORS Sachet',             0, 1, 'ORSACH',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007', 1, NOW(), 'Zinc 20mg',              0, 1, 'ZINC20',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008', 1, NOW(), 'Iron + Folic Acid',      0, 1, 'IRNFOL',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02009', 1, NOW(), 'Roller Bandages',        0, 1, 'RLBAND',  false, '${DISPENSABLE_ID}'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02010', 1, NOW(), 'Male Condoms',           0, 1, 'MCONDOM', false, '${DISPENSABLE_ID}')
  ON CONFLICT (id, versionnumber) DO UPDATE SET fullproductname = EXCLUDED.fullproductname;
  INSERT INTO referencedata.program_orderables
    (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, orderableversionnumber, programid)
  VALUES
    (gen_random_uuid(), true, 2, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02002', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 3, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02003', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 4, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02004', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 5, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02005', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 6, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02006', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 7, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02007', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 8, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02008', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 9, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02009', 1, '${PROGRAM_ID}'),
    (gen_random_uuid(), true, 10, true, '${ODC_ID}', '3be1d20f-6aa9-4e52-864f-4fa04aa02010', 1, '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.trade_items (id, manufactureroftradeitem)
  VALUES
    ('eeeeeeee-0000-0000-0000-000000000002', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000003', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000004', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000005', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000006', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000007', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000008', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000009', 'Generic'),
    ('eeeeeeee-0000-0000-0000-000000000010', 'Generic')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.orderable_identifiers (key, value, orderableid, orderableversionnumber)
  VALUES
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000002', '3be1d20f-6aa9-4e52-864f-4fa04aa02002', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000003', '3be1d20f-6aa9-4e52-864f-4fa04aa02003', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000004', '3be1d20f-6aa9-4e52-864f-4fa04aa02004', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000005', '3be1d20f-6aa9-4e52-864f-4fa04aa02005', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000006', '3be1d20f-6aa9-4e52-864f-4fa04aa02006', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000007', '3be1d20f-6aa9-4e52-864f-4fa04aa02007', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000008', '3be1d20f-6aa9-4e52-864f-4fa04aa02008', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000009', '3be1d20f-6aa9-4e52-864f-4fa04aa02009', 1),
    ('tradeItem', 'eeeeeeee-0000-0000-0000-000000000010', '3be1d20f-6aa9-4e52-864f-4fa04aa02010', 1)
  ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active)
  VALUES
    ('ffffffff-0000-0000-0000-000000000002', 'AMOX-LOT-2026', '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000002', true),
    ('ffffffff-0000-0000-0000-000000000003', 'RDT-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000003', true),
    ('ffffffff-0000-0000-0000-000000000004', 'PARA-LOT-2026', '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000004', true),
    ('ffffffff-0000-0000-0000-000000000005', 'CTX-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000005', true),
    ('ffffffff-0000-0000-0000-000000000006', 'ORS-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000006', true),
    ('ffffffff-0000-0000-0000-000000000007', 'ZINC-LOT-2026', '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000007', true),
    ('ffffffff-0000-0000-0000-000000000008', 'IFA-LOT-2026',  '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000008', true),
    ('ffffffff-0000-0000-0000-000000000009', 'BAND-LOT-2026', '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000009', true),
    ('ffffffff-0000-0000-0000-000000000010', 'COND-LOT-2026', '2028-12-31', '2026-01-01', 'eeeeeeee-0000-0000-0000-000000000010', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.facility_type_approved_products
    (id, versionnumber, lastupdated, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, active, facilitytypeid, orderableid, programid)
  SELECT gen_random_uuid(), 1, NOW(), 0, 3, 0, true, f.typeid, o.id, '${PROGRAM_ID}'
  FROM referencedata.facilities f
  CROSS JOIN (VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02009'::uuid),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02010'::uuid)
  ) AS o(id)
  WHERE f.id = '${FACILITY_ID}'
  AND NOT EXISTS (
    SELECT 1 FROM referencedata.facility_type_approved_products
    WHERE facilitytypeid = f.typeid AND orderableid = o.id AND programid = '${PROGRAM_ID}'
  );" 2>/dev/null
log "9 additional medicine orderables, lots, and approved products seeded."

# Profile gate: ATP shows only the 3 ATP medicines (Oxytocin, Amoxicillin, Paracetamol)
# in OpenLMIS; BKM shows all 10. Toggles active on program_orderables + approved products.
if [ "$PROFILE" = "atp" ]; then
  log "ATP profile: keeping only 3 medicines active (Oxytocin, Amoxicillin, Paracetamol) ..."
  KEEP_IN="'3be1d20f-6aa9-4e52-864f-4fa04aa02056','3be1d20f-6aa9-4e52-864f-4fa04aa02002','3be1d20f-6aa9-4e52-864f-4fa04aa02004'"
  docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
    UPDATE referencedata.program_orderables             SET active=true  WHERE programid='${PROGRAM_ID}' AND orderableid IN (${KEEP_IN});
    UPDATE referencedata.program_orderables             SET active=false WHERE programid='${PROGRAM_ID}' AND orderableid NOT IN (${KEEP_IN});
    UPDATE referencedata.facility_type_approved_products SET active=true  WHERE programid='${PROGRAM_ID}' AND orderableid IN (${KEEP_IN});
    UPDATE referencedata.facility_type_approved_products SET active=false WHERE programid='${PROGRAM_ID}' AND orderableid NOT IN (${KEEP_IN});" 2>/dev/null \
    && log "  ATP: 3 medicines active, 7 deactivated."
else
  log "BKM profile: activating all medicine orderables in OpenLMIS ..."
  docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
    UPDATE referencedata.program_orderables             SET active=true WHERE programid='${PROGRAM_ID}';
    UPDATE referencedata.facility_type_approved_products SET active=true WHERE programid='${PROGRAM_ID}';" 2>/dev/null \
    && log "  All medicine orderables active."
fi

# ─── 6b. Seed Lesotho district facilities ─────────────────────────────────────
# 30 facilities across 3 districts (Leribe, Berea, Maseru).
# Flyway-seeded geographic level, zone, and facility type IDs are queried dynamically
# because they change across openlmis-referencedata restarts (flyway.clean=true).
log "Seeding Lesotho districts, councils, and health facilities ..."

# Council geographic level (sub-district — level 3)
lmis_put "/api/geographicLevels/${GEO_LEVEL_COUNCIL_ID}" \
  "{\"id\":\"${GEO_LEVEL_COUNCIL_ID}\",\"code\":\"council\",\"name\":\"Council\",\"levelNumber\":3}"

# Resolve Flyway-seeded IDs needed for zone and facility references.
# Uses next(..., '') so a missing match returns empty string instead of raising StopIteration.
# Falls back to our own seeded IDs if the API is momentarily unavailable.
FLYWAY_DISTRICT_LEVEL_ID=$(curl -sf --retry 3 --retry-delay 2 -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicLevels" 2>/dev/null \
  | python3 -c "import sys,json; lv=json.load(sys.stdin); print(next((l['id'] for l in lv if l['code']=='district'), ''))" 2>/dev/null || true)
FLYWAY_DISTRICT_LEVEL_ID="${FLYWAY_DISTRICT_LEVEL_ID:-${GEO_LEVEL_DISTRICT_ID}}"

FLYWAY_LESOTHO_ZONE_ID=$(curl -sf --retry 3 --retry-delay 2 -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicZones?size=200" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); zz=d.get('content',d) if isinstance(d,dict) else d; print(next((z['id'] for z in zz if z.get('level',{}).get('levelNumber')==1), ''))" 2>/dev/null || true)
FLYWAY_LESOTHO_ZONE_ID="${FLYWAY_LESOTHO_ZONE_ID:-${GEO_ZONE_COUNTRY_ID}}"

FLYWAY_MASERU_ZONE_ID=$(curl -sf --retry 3 --retry-delay 2 -H "Authorization: Bearer ${LMIS_TOKEN}" \
  "http://localhost:8082/api/geographicZones?size=200" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); zz=d.get('content',d) if isinstance(d,dict) else d; hits=[z for z in zz if z.get('code') in ('MAS','Maseru') or z.get('name')=='Maseru']; print(hits[0]['id'] if hits else next((z['id'] for z in zz if z.get('level',{}).get('levelNumber')==2), ''))" 2>/dev/null || true)
FLYWAY_MASERU_ZONE_ID="${FLYWAY_MASERU_ZONE_ID:-${GEO_ZONE_DISTRICT_ID}}"

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

# ─── 6c. Approved products + valid reasons for hospital type ──────────────────
# Hospitals (3 per district) need the same approved products as health centres.
log "Seeding approved products and valid reasons for hospital facility type ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.facility_type_approved_products
    (id, versionnumber, lastupdated, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, active, facilitytypeid, orderableid, programid)
  SELECT gen_random_uuid(), 1, NOW(), 0, 3, 0, true, '${FACILITY_TYPE_HOSPITAL_ID}', v.oid::uuid, '${PROGRAM_ID}'
  FROM (VALUES
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02056'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02002'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02003'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02004'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02005'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02006'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02007'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02008'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02009'),
    ('3be1d20f-6aa9-4e52-864f-4fa04aa02010')
  ) AS v(oid)
  WHERE NOT EXISTS (
    SELECT 1 FROM referencedata.facility_type_approved_products
    WHERE facilitytypeid = '${FACILITY_TYPE_HOSPITAL_ID}' AND orderableid = v.oid::uuid AND programid = '${PROGRAM_ID}'
  );" 2>/dev/null
# valid_reason_assignments for hospital type in stockmanagement
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO stockmanagement.valid_reason_assignments (id, facilitytypeid, programid, reasonid, hidden)
  SELECT gen_random_uuid(), '${FACILITY_TYPE_HOSPITAL_ID}', '${PROGRAM_ID}', id, false
  FROM stockmanagement.stock_card_line_item_reasons
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "Hospital approved products and valid reasons seeded."

# ─── 7. Fix right_assignments cache ───────────────────────────────────────────
# OpenLMIS right_assignments is a denormalized cache (not derived from role_assignments).
# It must be patched directly after every referencedata restart.
log "Patching OpenLMIS right_assignments ..."
ADMIN_UUID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM referencedata.users WHERE username IN ('administrator','admin') ORDER BY username='administrator' DESC LIMIT 1;" | tr -d '[:space:]')
[[ -z "$ADMIN_UUID" ]] && { log "ERROR: admin user not found in referencedata DB"; exit 1; }

# Scoped rights required for the mediator (must be per facility+program)
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_ADJUST',     '${FACILITY_ID}', '${PROGRAM_ID}'),
         (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_CARDS_VIEW', '${FACILITY_ID}', '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;" 2>/dev/null

# ATP 2nd facility (Clinic B): admin posts stock events there too (mediator uses the
# admin OpenLMIS user for every facility), so grant the same scoped rights at Clinic B.
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_ADJUST',           '${FACILITY_B_ID}', '${PROGRAM_ID}'),
         (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_CARDS_VIEW',       '${FACILITY_B_ID}', '${PROGRAM_ID}'),
         (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_INVENTORIES_EDIT', '${FACILITY_B_ID}', '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;" 2>/dev/null

# ATP: supervisory node + requisition group so the OpenLMIS admin SUPERVISES both
# Clinic A and Clinic B. The native OpenLMIS Stock-on-Hand facility dropdown lists a
# user's supervised facilities, so this lets one admin switch between both clinics.
# (Right checks already pass via the scoped right_assignments above; this adds the
# supervisory hierarchy the SPA's facility list is built from.)
if [ "$PROFILE" = "atp" ]; then
  log "ATP: OpenLMIS supervisory node (admin supervises Clinic A + Clinic B) ..."
  docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q <<SQL 2>/dev/null
  INSERT INTO referencedata.processing_schedules (id, code, name, modifieddate)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000001','SCH-MONTHLY','Monthly', NOW()) ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.supervisory_nodes (id, code, name, facilityid)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000002','SN-MASERU','Maseru District Supervisory Node','${FACILITY_ID}') ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.requisition_groups (id, code, name, supervisorynodeid)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000003','RG-MASERU','Maseru District Requisition Group','aaaaaaaa-5c1d-0000-0000-000000000002') ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.requisition_group_program_schedules (id, directdelivery, processingscheduleid, programid, requisitiongroupid)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000004', true, 'aaaaaaaa-5c1d-0000-0000-000000000001','${PROGRAM_ID}','aaaaaaaa-5c1d-0000-0000-000000000003') ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.requisition_group_members (requisitiongroupid, facilityid)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000003','${FACILITY_ID}'),('aaaaaaaa-5c1d-0000-0000-000000000003','${FACILITY_B_ID}') ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.roles (id, name, description)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000005','Stock Supervisor','Views & adjusts stock across supervised facilities') ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.role_rights (roleid, rightid)
    SELECT 'aaaaaaaa-5c1d-0000-0000-000000000005', id FROM referencedata.rights
    WHERE name IN ('STOCK_CARDS_VIEW','STOCK_ADJUST','STOCK_INVENTORIES_EDIT') ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.role_assignments (id, type, roleid, userid, supervisorynodeid, programid)
    VALUES ('aaaaaaaa-5c1d-0000-0000-000000000006','supervision','aaaaaaaa-5c1d-0000-0000-000000000005','${ADMIN_UUID}','aaaaaaaa-5c1d-0000-0000-000000000002','${PROGRAM_ID}') ON CONFLICT (id) DO NOTHING;
SQL
  log "  ATP supervisory node + requisition group (Clinic A + B) seeded."
fi

# ATP: a 2nd OpenLMIS login (clinicb / password) homed at Clinic B. The native
# OpenLMIS SPA scopes its Stock-on-Hand view to the logged-in user's HOME facility,
# so this is the way to see Clinic B's stock in the native GUI. Password is copied
# from the admin auth row (same "password"). Rights granted directly at Clinic B.
if [ "$PROFILE" = "atp" ]; then
  log "ATP: creating OpenLMIS 'clinicb' user (home facility Clinic B) ..."
  docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q <<SQL 2>/dev/null
  INSERT INTO referencedata.users (id, username, firstname, lastname, active, verified, homefacilityid)
    VALUES ('aaaaaaaa-c1b0-0000-0000-000000000001','clinicb','Clinic B','Worker', true, true, '${FACILITY_B_ID}') ON CONFLICT (id) DO NOTHING;
  INSERT INTO auth.auth_users (id, username, password, enabled, lockedout)
    SELECT 'aaaaaaaa-c1b0-0000-0000-000000000001','clinicb', password, true, false
    FROM auth.auth_users WHERE username='admin' LIMIT 1
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
    VALUES (gen_random_uuid(),'aaaaaaaa-c1b0-0000-0000-000000000001','STOCK_CARDS_VIEW','${FACILITY_B_ID}','${PROGRAM_ID}'),
           (gen_random_uuid(),'aaaaaaaa-c1b0-0000-0000-000000000001','STOCK_ADJUST','${FACILITY_B_ID}','${PROGRAM_ID}'),
           (gen_random_uuid(),'aaaaaaaa-c1b0-0000-0000-000000000001','STOCK_INVENTORIES_EDIT','${FACILITY_B_ID}','${PROGRAM_ID}')
    ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.right_assignments (id, userid, rightname)
    VALUES (gen_random_uuid(),'aaaaaaaa-c1b0-0000-0000-000000000001','STOCK_CARDS_VIEW') ON CONFLICT DO NOTHING;
  INSERT INTO referencedata.role_assignments (id, type, roleid, userid)
    VALUES ('aaaaaaaa-c1b0-0000-0000-000000000002','direct','aaaaaaaa-5c1d-0000-0000-000000000005','aaaaaaaa-c1b0-0000-0000-000000000001') ON CONFLICT (id) DO NOTHING;
SQL
  log "  OpenLMIS 'clinicb' user created (login clinicb / password, home = Clinic B)."
fi

# Unscoped rights that are sometimes absent from the cache after restart
# STOCK_CARDS_VIEW is also required by the mediator's stock validation (Job 3 — Safety Gate)
for rightname in PROGRAMS_MANAGE SYSTEM_IDEAL_STOCK_AMOUNTS_MANAGE SERVICE_ACCOUNTS_MANAGE STOCK_CARDS_VIEW; do
  docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
    INSERT INTO referencedata.right_assignments (id, userid, rightname)
    VALUES (gen_random_uuid(), '${ADMIN_UUID}', '${rightname}')
    ON CONFLICT DO NOTHING;" 2>/dev/null
done
# STOCK_INVENTORIES_EDIT — required for physical inventory (scoped + unscoped)
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_INVENTORIES_EDIT', '${FACILITY_ID}', '${PROGRAM_ID}')
  ON CONFLICT DO NOTHING;" 2>/dev/null
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname)
  VALUES (gen_random_uuid(), '${ADMIN_UUID}', 'STOCK_INVENTORIES_EDIT')
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "right_assignments patched for admin user (UUID: ${ADMIN_UUID})."

# Scoped rights for admin over all 30 additional facilities
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
  SELECT gen_random_uuid(), '${ADMIN_UUID}', r.rname, f.id, '${PROGRAM_ID}'
  FROM (VALUES ('STOCK_ADJUST'),('STOCK_CARDS_VIEW'),('STOCK_INVENTORIES_EDIT')) AS r(rname),
  (VALUES
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c401'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c402'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c403'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c404'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c405'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c406'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c407'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c408'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c409'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c410'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c411'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c412'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c413'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c414'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c415'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c416'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c417'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c418'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c419'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c420'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c421'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c422'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c423'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c424'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c425'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c426'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c427'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c428'::uuid),
    ('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c429'::uuid),('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c430'::uuid)
  ) AS f(id)
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "Scoped rights seeded for all 30 additional facilities."

# ─── 7c. Seed valid_reason_assignments in stockmanagement ─────────────────────
# Links Flyway-seeded reasons (Consumed, Receipts, etc.) to the health_center
# facility type + Essential Medicines program so the SPA dropdowns are populated.
# Idempotent via the unique constraint on (facilityTypeId, programId, reasonId).
FLYWAY_HC_TYPE_SM="e3f5a2c1-d9b8-4f5c-aa3b-8c2e7d1f3a04"
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO stockmanagement.valid_reason_assignments (id, facilitytypeid, programid, reasonid, hidden)
  SELECT gen_random_uuid(), '${FLYWAY_HC_TYPE_SM}', '${PROGRAM_ID}', id, false
  FROM stockmanagement.stock_card_line_item_reasons
  ON CONFLICT DO NOTHING;" 2>/dev/null
log "valid_reason_assignments seeded for health_center + Essential Medicines."

# ─── 7a2. Activate BKM orderables in program_orderables + FTAP ────────────────
# OpenLMIS demo-data ships with our 10 BKM orderables present but flagged
# active=false in both referencedata.program_orderables and
# referencedata.facility_type_approved_products. The stockCardSummaries API
# filters by both, so without this UPDATE only Oxytocin (the one orderable
# the upstream demo-data activates) appears in the OpenLMIS UI — every other
# medicine's stock card stays invisible even after receipts are posted.
# Activates one row per orderable (latest by id) in each table; idempotent.
log "Activating BKM orderables in program_orderables + facility_type_approved_products ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  WITH latest AS (
    SELECT DISTINCT ON (orderableid) id
    FROM referencedata.program_orderables
    WHERE programid='${PROGRAM_ID}'
      AND orderableid::text LIKE '3be1d20f%'
      AND active=false
    ORDER BY orderableid, orderableversionnumber DESC
  )
  UPDATE referencedata.program_orderables SET active=true
  WHERE id IN (SELECT id FROM latest);" 2>/dev/null
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  WITH latest AS (
    SELECT DISTINCT ON (orderableid) id
    FROM referencedata.facility_type_approved_products
    WHERE programid='${PROGRAM_ID}'
      AND facilitytypeid='${FLYWAY_HC_TYPE_SM}'
      AND orderableid::text LIKE '3be1d20f%'
      AND active=false
    ORDER BY orderableid, id
  )
  UPDATE referencedata.facility_type_approved_products SET active=true
  WHERE id IN (SELECT id FROM latest);" 2>/dev/null
log "  BKM orderables activated in program_orderables + FTAP."

# ─── 7-atp. ATP stock: exactly 100 of each of the 3 medicines at BOTH facilities ──
# ATP uses a clean, small baseline (100 each) at Clinic A + Clinic B instead of the
# large BKM receipts (7b/7c/7d below, which are skipped for ATP).
if [ "$PROFILE" = "atp" ]; then
  # Idempotency guard: skip if the 3 ATP orderables already have stock cards. (Do NOT
  # check documentnumber — OpenLMIS does not persist documentationNo to
  # stock_card_line_items, so it is always NULL and the seed would re-post additively
  # every run. To force a clean re-seed, TRUNCATE stockmanagement.stock_cards CASCADE first.)
  EXISTING_ATP_STOCK=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
    "SELECT count(*) FROM stockmanagement.stock_cards WHERE orderableid IN (
       '3be1d20f-6aa9-4e52-864f-4fa04aa02056',
       '3be1d20f-6aa9-4e52-864f-4fa04aa02002',
       '3be1d20f-6aa9-4e52-864f-4fa04aa02004');" 2>/dev/null | tr -d '[:space:]')
  if [[ "$EXISTING_ATP_STOCK" == "0" ]]; then
    log "ATP: seeding 100 units of each of the 3 medicines at Clinic A and Clinic B ..."
    LMIS_TOKEN_ATP=$(curl -sf -u user-client:changeme \
      -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
      http://localhost:8082/api/oauth/token \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
    ATP_RR=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
      "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
    for FAC in "${FACILITY_ID}" "${FACILITY_B_ID}"; do
      curl -sf -o /dev/null -X POST \
        -H "Authorization: Bearer ${LMIS_TOKEN_ATP}" -H "Content-Type: application/json" \
        "http://localhost:8082/api/stockEvents" \
        -d "{\"facilityId\":\"${FAC}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[
          {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02056\",\"lotId\":\"ffffffff-0000-0000-0000-000000000001\",\"quantity\":100,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${ATP_RR}\",\"documentationNo\":\"SEED-ATP-STOCK\"},
          {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02002\",\"lotId\":\"ffffffff-0000-0000-0000-000000000002\",\"quantity\":100,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${ATP_RR}\",\"documentationNo\":\"SEED-ATP-STOCK\"},
          {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02004\",\"lotId\":\"ffffffff-0000-0000-0000-000000000004\",\"quantity\":100,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${ATP_RR}\",\"documentationNo\":\"SEED-ATP-STOCK\"}
        ]}" && log "  ATP stock seeded at ${FAC} (100 x 3 medicines)." \
            || log "  WARN: ATP stock event failed at ${FAC} (check admin rights / home-facility)."
    done
  else
    log "ATP stock already seeded — skipping."
  fi
fi

# ─── 7b. Seed initial stock receipt (so dispense events don't underflow) ───────
# Starts at 10,000 units at Maseru District Clinic A. BKM only (ATP uses 7-atp above).
# Set SEED_INITIAL_STOCK=false to skip — facilities then start at 0 and grow only
# via VHW order → FW dispatch → FW receipt acceptance.
# Idempotent: uses ON CONFLICT-style check via documentationNo in the stockmanagement DB.
if [[ "${SEED_INITIAL_STOCK:-true}" == "false" || "$PROFILE" == "atp" ]]; then
  log "Skipping section 7b (BKM initial Maseru receipt) — SEED_INITIAL_STOCK=false or ATP profile."
else
log "Seeding initial stock receipt for ${ORDERABLE_FULLNAME} ..."
RECEIPT_REASON_ID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
EXISTING_RECEIPT=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT count(*) FROM stockmanagement.stock_card_line_items WHERE documentnumber='SEED-INITIAL-RECEIPT';" 2>/dev/null | tr -d '[:space:]')
if [[ "$EXISTING_RECEIPT" == "0" && -n "$RECEIPT_REASON_ID" ]]; then
  LMIS_TOKEN_STOCK=$(curl -sf -u user-client:changeme \
    -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
    http://localhost:8082/api/oauth/token \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
  # Post lot-tracked receipt so the stock card appears in the v2 API used by the SPA.
  curl -sf -o /dev/null -X POST \
    -H "Authorization: Bearer ${LMIS_TOKEN_STOCK}" -H "Content-Type: application/json" \
    "http://localhost:8082/api/stockEvents" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${ORDERABLE_ID}\",\"lotId\":\"${LOT_ID}\",\"quantity\":10000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT\"}]}"
  log "Initial stock receipt created (10,000 units, lot ${LOT_CODE_VAL})."
else
  log "Initial stock receipt already exists — skipping."
fi

fi   # end of section 7b (SEED_INITIAL_STOCK gate)

# ─── 7c. Seed initial stock for 7 additional medicines ────────────────────────
if [[ "${SEED_INITIAL_STOCK:-true}" == "false" || "$PROFILE" == "atp" ]]; then
  log "Skipping section 7c (BKM additional-medicine receipts) — SEED_INITIAL_STOCK=false or ATP profile."
else
EXISTING_RECEIPT_V2=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT count(*) FROM stockmanagement.stock_card_line_items WHERE documentnumber='SEED-INITIAL-RECEIPT-V2';" 2>/dev/null | tr -d '[:space:]')
if [[ "$EXISTING_RECEIPT_V2" == "0" ]]; then
  log "Seeding initial stock for 7 additional medicines ..."
  LMIS_TOKEN_STOCK2=$(curl -sf -u user-client:changeme \
    -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
    http://localhost:8082/api/oauth/token \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
  RECEIPT_REASON_ID2=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
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
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02008\",\"lotId\":\"ffffffff-0000-0000-0000-000000000008\",\"quantity\":10000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02009\",\"lotId\":\"ffffffff-0000-0000-0000-000000000009\",\"quantity\":500,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"},
      {\"orderableId\":\"3be1d20f-6aa9-4e52-864f-4fa04aa02010\",\"lotId\":\"ffffffff-0000-0000-0000-000000000010\",\"quantity\":1000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON_ID2}\",\"documentationNo\":\"SEED-INITIAL-RECEIPT-V2\"}
    ]}"
  log "Initial stock seeded for 7 additional medicines."
else
  log "Additional medicines initial stock already exists — skipping."
fi

fi   # end of section 7c (SEED_INITIAL_STOCK gate)

# ─── 7d. Seed initial stock for all 30 additional facilities ──────────────────
# Each of the 30 seeded facilities gets opening stock for all 8 medicines.
# One stock event per facility (8 line items each). Idempotent: checked per facility.
if [[ "${SEED_INITIAL_STOCK:-true}" == "false" || "$PROFILE" == "atp" ]]; then
  log "Skipping section 7d (BKM 30-facility stock) — SEED_INITIAL_STOCK=false or ATP profile."
else
log "Seeding initial stock for 30 additional facilities ..."
EXISTING_FAC_STOCK=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT count(*) FROM stockmanagement.stock_card_line_items WHERE documentnumber='SEED-FAC-STOCK-V1';" 2>/dev/null | tr -d '[:space:]')
if [[ "$EXISTING_FAC_STOCK" == "0" ]]; then
  LMIS_TOKEN_FAC=$(curl -sf -u user-client:changeme \
    -d "grant_type=password&username=admin&password=${LMIS_PASSWORD}" \
    http://localhost:8082/api/oauth/token \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
  RECEIPT_RID=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
    "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
  python3 << PYEOF2
import json, urllib.request, urllib.error

TOKEN = "${LMIS_TOKEN_FAC}"
PROGRAM = "${PROGRAM_ID}"
REASON = "${RECEIPT_RID}"
TODAY  = "${TODAY}"
BASE   = "http://localhost:8082"

# 30 facilities: OpenLMIS UUID -> initial stock qty per medicine
# Quantities: AL=10000, Amox=5000, RDT=500, Para=3000, CTX=5000, ORS=2000, Zinc=8000, IFA=10000
MEDICINES = [
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02056","ffffffff-0000-0000-0000-000000000001",10000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02002","ffffffff-0000-0000-0000-000000000002",5000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02003","ffffffff-0000-0000-0000-000000000003",500),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02004","ffffffff-0000-0000-0000-000000000004",3000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02005","ffffffff-0000-0000-0000-000000000005",5000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02006","ffffffff-0000-0000-0000-000000000006",2000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02007","ffffffff-0000-0000-0000-000000000007",8000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02008","ffffffff-0000-0000-0000-000000000008",10000),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02009","ffffffff-0000-0000-0000-000000000009",500),
  ("3be1d20f-6aa9-4e52-864f-4fa04aa02010","ffffffff-0000-0000-0000-000000000010",1000),
]

FACILITIES = [
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c401","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c402",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c403","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c404",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c405","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c406",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c407","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c408",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c409","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c410",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c411","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c412",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c413","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c414",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c415","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c416",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c417","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c418",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c419","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c420",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c421","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c422",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c423","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c424",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c425","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c426",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c427","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c428",
  "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c429","a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c430",
]

ok = 0
for fid in FACILITIES:
    payload = json.dumps({
        "facilityId": fid,
        "programId":  PROGRAM,
        "lineItems":  [
            {"orderableId": oid, "lotId": lid, "quantity": qty,
             "occurredDate": TODAY, "reasonId": REASON,
             "documentationNo": "SEED-FAC-STOCK-V1"}
            for oid, lid, qty in MEDICINES
        ]
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/api/stockEvents",
        data=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            ok += 1
    except urllib.error.HTTPError as e:
        print(f"  WARN facility {fid[-4:]}: HTTP {e.code}", flush=True)
print(f"  {ok}/30 facilities stocked (8 medicines each).", flush=True)
PYEOF2
  log "Initial stock seeded for 30 facilities."
else
  log "Facility stock already seeded — skipping."
fi
fi   # end of section 7d (SEED_INITIAL_STOCK gate)

# ─── 8. Seed OpenSRP practitioner ─────────────────────────────────────────────
# OpenSRP requires a team.practitioner row whose user_id matches the Keycloak UUID.
# Wrapped in a subshell with `|| true` so any failure here doesn't abort the whole seed.
log "Seeding OpenSRP practitioner ..."
(
  set +e
  KC_ADMIN_TOKEN=$(curl -s --max-time 10 -X POST \
    "http://localhost:8083/auth/realms/master/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=admin-cli&username=admin&password=${KC_ADMIN_PASSWORD:-admin}" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))" 2>/dev/null)

  if [[ -z "$KC_ADMIN_TOKEN" ]]; then
    log "WARNING: Could not get Keycloak admin token — OpenSRP practitioner seeding skipped."
    log "  (Check KC_ADMIN_PASSWORD env var matches Keycloak admin password)"
    exit 0
  fi

  KC_USER_ID=$(curl -s --max-time 10 -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    "http://localhost:8083/auth/admin/realms/opensrp/users?username=bkm-admin" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" 2>/dev/null)

  if [[ -z "$KC_USER_ID" ]]; then
    log "WARNING: bkm-admin not found in Keycloak — OpenSRP practitioner seeding skipped."
    exit 0
  fi

  docker exec health-db-postgres psql -U admin -d opensrp -q -c "
    INSERT INTO team.practitioner (identifier, active, name, user_id, username)
    SELECT 'opensrp-admin-001', true, 'BKM Admin', '${KC_USER_ID}', 'bkm-admin'
    WHERE NOT EXISTS (SELECT 1 FROM team.practitioner WHERE username = 'bkm-admin');
    UPDATE team.practitioner SET user_id = '${KC_USER_ID}', username = 'bkm-admin'
      WHERE username IN ('opensrp-admin','bkm-admin');" 2>/dev/null
  log "OpenSRP practitioner upserted (Keycloak UUID: ${KC_USER_ID})."

  # Supervisors group
  KC_GROUP_ID=$(curl -s --max-time 10 -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    "http://localhost:8083/auth/admin/realms/opensrp/groups" 2>/dev/null \
    | python3 -c "import sys,json;groups=json.load(sys.stdin);g=[x for x in groups if x.get('name')=='Supervisors'];print(g[0]['id'] if g else '')" 2>/dev/null)
  if [[ -z "$KC_GROUP_ID" ]]; then
    curl -s --max-time 10 -X POST "http://localhost:8083/auth/admin/realms/opensrp/groups" \
      -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"name":"Supervisors"}' >/dev/null 2>&1
    KC_GROUP_ID=$(curl -s --max-time 10 -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
      "http://localhost:8083/auth/admin/realms/opensrp/groups" 2>/dev/null \
      | python3 -c "import sys,json;groups=json.load(sys.stdin);g=[x for x in groups if x.get('name')=='Supervisors'];print(g[0]['id'] if g else '')" 2>/dev/null)
    log "  Keycloak 'Supervisors' group created (ID: ${KC_GROUP_ID})."
  fi
  if [[ -n "$KC_GROUP_ID" ]]; then
    curl -s --max-time 10 -X PUT \
      "http://localhost:8083/auth/admin/realms/opensrp/users/${KC_USER_ID}/groups/${KC_GROUP_ID}" \
      -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" >/dev/null 2>&1
    log "  bkm-admin assigned to Keycloak 'Supervisors' group."
  fi

  # Ensure 'vhw' realm role exists
  KC_VHW_EXISTS=$(curl -s --max-time 10 \
    "http://localhost:8083/auth/admin/realms/opensrp/roles/vhw" \
    -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name',''))" 2>/dev/null)
  if [[ "$KC_VHW_EXISTS" != "vhw" ]]; then
    curl -s --max-time 10 -X POST "http://localhost:8083/auth/admin/realms/opensrp/roles" \
      -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"name":"vhw","description":"Village Health Worker - Android app only, no web portal access"}' >/dev/null 2>&1
    log "Keycloak 'vhw' realm role created."
  else
    log "Keycloak 'vhw' realm role already exists."
  fi
) || log "WARNING: Step 8 (OpenSRP practitioner) had errors — continuing with remaining steps."

# Re-fetch KC_ADMIN_TOKEN and KC_USER_ID for later steps that need them
# (password resets, client registration, FHIR Practitioner seeding)
set +e
KC_ADMIN_TOKEN=$(curl -s --max-time 10 -X POST \
  "http://localhost:8083/auth/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=${KC_ADMIN_PASSWORD:-admin}" 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))" 2>/dev/null)

KC_USER_ID=""
if [[ -n "$KC_ADMIN_TOKEN" ]]; then
  KC_USER_ID=$(curl -s --max-time 10 -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    "http://localhost:8083/auth/admin/realms/opensrp/users?username=bkm-admin" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" 2>/dev/null)
fi
set -e
KC_ADMIN_TOKEN="${KC_ADMIN_TOKEN:-}"
KC_USER_ID="${KC_USER_ID:-}"

# ATP: ensure the 4 extra Keycloak users (supervisor, fw.clinic.a/b, vhw.clinic.b)
# exist. A fresh KC imports them from the realm JSON with their pinned UUIDs; an
# already-running KC won't re-import, so partial-import them here (SKIP if present;
# partialImport honors the pinned id + realmRoles so they match the FHIR Practitioners).
if [ "$PROFILE" = "atp" ] && [[ -n "$KC_ADMIN_TOKEN" ]]; then
  ATP_KC_USERS=$(python3 -c "
import json
d=json.load(open('config/keycloak/opensrp-realm.json'))
want={'supervisor','fw.clinic.a','fw.clinic.b','vhw.clinic.b','thabo.mokoena'}
us=[u for u in d.get('users',[]) if u.get('username') in want]
print(json.dumps({'ifResourceExists':'SKIP','users':us}))
" 2>/dev/null)
  if [[ -n "$ATP_KC_USERS" ]]; then
    curl -s -o /dev/null -w "  ATP Keycloak users partialImport -> HTTP %{http_code}\n" \
      -X POST "http://localhost:8083/auth/admin/realms/opensrp/partialImport" \
      -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" -H "Content-Type: application/json" \
      --data "${ATP_KC_USERS}" || log "  WARN: ATP KC users partialImport failed (non-fatal)."
  fi
fi

# Enable Keycloak event logging for Grafana dashboard visibility.
# Keycloak uses H2 (in-memory) in dev mode so this config is lost on container restart
# — re-applied here on every seed run.  Enables LOGIN_ERROR / CLIENT_LOGIN_ERROR etc.
# at WARN level via jboss-logging -> container stdout -> Promtail -> Loki.
# Reset passwords for all opensrp realm users — Keycloak H2 dev mode stores
# credentials hashed from the realm JSON import, but the hash sometimes doesn't
# survive a fresh container start.  Explicit reset via admin API guarantees login.
log "Resetting Keycloak user passwords ..."
for KC_UNAME_PWD in "thabo.mokoena:password" "lineo.nthabi:password" "mpho.lerotholi:password" "facility-worker:password"; do
  KC_UNAME="${KC_UNAME_PWD%%:*}"; KC_PWD="${KC_UNAME_PWD##*:}"
  KC_UID=$(curl -sf -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    "http://localhost:8083/auth/admin/realms/opensrp/users?username=${KC_UNAME}" \
    | python3 -c "import sys,json; u=json.load(sys.stdin); print(u[0]['id'] if u else '')" 2>/dev/null || true)
  [[ -z "$KC_UID" ]] && continue
  curl -sf -X PUT "http://localhost:8083/auth/admin/realms/opensrp/users/${KC_UID}/reset-password" \
    -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"password\",\"value\":\"${KC_PWD}\",\"temporary\":false}" >/dev/null
done
log "Keycloak passwords reset (passwords secured)."

log "Registering bkm-web Keycloak client ..."
curl -s -X DELETE \
  -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
  "http://localhost:8083/auth/admin/realms/opensrp/clients/$(curl -s \
    -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
    'http://localhost:8083/auth/admin/realms/opensrp/clients?clientId=bkm-web' \
    | python3 -c 'import sys,json; c=json.load(sys.stdin); print(c[0]["id"] if c else "")' \
  )" > /dev/null 2>&1 || true
curl -sf -X POST \
  -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  "http://localhost:8083/auth/admin/realms/opensrp/clients" \
  -d "{
    \"clientId\":\"bkm-web\",\"enabled\":true,\"publicClient\":true,
    \"directAccessGrantsEnabled\":true,\"standardFlowEnabled\":true,
    \"redirectUris\":[\"${BKM_WEB_ORIGIN}/*\",\"${BKM_WEB_ORIGIN}/\",\"${BKM_WEB_ORIGIN}\"],
    \"webOrigins\":[\"${BKM_WEB_ORIGIN}\"]
  }" > /dev/null
log "bkm-web Keycloak client registered (origin: ${BKM_WEB_ORIGIN})."

log "Enabling Keycloak event logging (opensrp realm) ..."
curl -sf -X PUT \
  -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  "http://localhost:8083/auth/admin/realms/opensrp/events/config" \
  -d '{
    "eventsEnabled": true,
    "eventsExpiration": 2592000,
    "eventsListeners": ["jboss-logging"],
    "enabledEventTypes": [
      "LOGIN","LOGIN_ERROR","LOGOUT","LOGOUT_ERROR",
      "CLIENT_LOGIN","CLIENT_LOGIN_ERROR",
      "CODE_TO_TOKEN","CODE_TO_TOKEN_ERROR",
      "TOKEN_EXCHANGE","TOKEN_EXCHANGE_ERROR"
    ],
    "adminEventsEnabled": true,
    "adminEventsDetailsEnabled": true
  }' && log "Keycloak event logging enabled." || log "WARNING: Could not enable Keycloak event logging."

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
  [[ "$code" =~ ^2 ]] || log "  WARNING: ${rt}/${id} -> ${code}"
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

# ATP 2nd facility — Organization + Location for Maseru District Clinic B.
if [ "$PROFILE" = "atp" ]; then
  fhir_put Organization maseru-clinic-b \
    '{"resourceType":"Organization","id":"maseru-clinic-b","active":true,
      "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/organization-type","code":"prov","display":"Healthcare Provider"}]}],
      "name":"Maseru District Clinic B",
      "address":[{"district":"Maseru","country":"LS"}]}'
  fhir_put Location loc-maseru-clinic-b \
    '{"resourceType":"Location","id":"loc-maseru-clinic-b","status":"active","name":"Maseru District Clinic B","mode":"instance",
      "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Care"}]}],
      "physicalType":{"coding":[{"code":"bu","display":"Building"}]},
      "partOf":{"reference":"Location/loc-maseru-district"},
      "position":{"longitude":27.510,"latitude":-29.330}}'
fi

# 9b. Location hierarchy: Lesotho -> Maseru District -> Clinic A -> 3 villages
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

# Districts (9 remaining districts + hospitals + health centres)
fhir_put Location loc-berea-district \
  '{"resourceType":"Location","id":"loc-berea-district","status":"active","name":"Berea District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-butha-buthe-district \
  '{"resourceType":"Location","id":"loc-butha-buthe-district","status":"active","name":"Butha-Buthe District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-leribe-district \
  '{"resourceType":"Location","id":"loc-leribe-district","status":"active","name":"Leribe District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-mafeteng-district \
  '{"resourceType":"Location","id":"loc-mafeteng-district","status":"active","name":"Mafeteng District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-mohales-hoek-district \
  '{"resourceType":"Location","id":"loc-mohales-hoek-district","status":"active","name":"Mohale'"'"'s Hoek District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-mokhotlong-district \
  '{"resourceType":"Location","id":"loc-mokhotlong-district","status":"active","name":"Mokhotlong District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-qachas-nek-district \
  '{"resourceType":"Location","id":"loc-qachas-nek-district","status":"active","name":"Qacha'"'"'s Nek District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-quthing-district \
  '{"resourceType":"Location","id":"loc-quthing-district","status":"active","name":"Quthing District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'
fhir_put Location loc-thaba-tseka-district \
  '{"resourceType":"Location","id":"loc-thaba-tseka-district","status":"active","name":"Thaba-Tseka District","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"AREA","display":"Area"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"jdn","display":"Jurisdiction"}]},
    "partOf":{"reference":"Location/loc-lesotho"}}'

# Maseru additional facilities
fhir_put Location loc-maseru-hosp \
  '{"resourceType":"Location","id":"loc-maseru-hosp","status":"active","name":"Maseru District Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'
fhir_put Location loc-queen-mamohato \
  '{"resourceType":"Location","id":"loc-queen-mamohato","status":"active","name":"Queen Mamohato Memorial Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'
fhir_put Location loc-scott-hospital \
  '{"resourceType":"Location","id":"loc-scott-hospital","status":"active","name":"Scott Hospital (Morija)","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'
fhir_put Location loc-roma-clinic \
  '{"resourceType":"Location","id":"loc-roma-clinic","status":"active","name":"Roma Clinic","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'
fhir_put Location loc-semonkong-hc \
  '{"resourceType":"Location","id":"loc-semonkong-hc","status":"active","name":"Semonkong Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'
fhir_put Location loc-thetsane-hc \
  '{"resourceType":"Location","id":"loc-thetsane-hc","status":"active","name":"Thetsane Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-maseru-district"}}'

# Berea
fhir_put Location loc-berea-hospital \
  '{"resourceType":"Location","id":"loc-berea-hospital","status":"active","name":"Berea Hospital (Teyateyaneng)","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-berea-district"}}'
fhir_put Location loc-maluti-hospital \
  '{"resourceType":"Location","id":"loc-maluti-hospital","status":"active","name":"Maluti Adventist Hospital (Mapoteng)","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-berea-district"}}'
fhir_put Location loc-maqhaka-hc \
  '{"resourceType":"Location","id":"loc-maqhaka-hc","status":"active","name":"Maqhaka Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-berea-district"}}'
fhir_put Location loc-khubetsoana-hc \
  '{"resourceType":"Location","id":"loc-khubetsoana-hc","status":"active","name":"Khubetsoana Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-berea-district"}}'
fhir_put Location loc-mapheleng-hc \
  '{"resourceType":"Location","id":"loc-mapheleng-hc","status":"active","name":"Mapheleng Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-berea-district"}}'

# Butha-Buthe
fhir_put Location loc-butha-buthe-hosp \
  '{"resourceType":"Location","id":"loc-butha-buthe-hosp","status":"active","name":"Butha-Buthe Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-butha-buthe-district"}}'
fhir_put Location loc-seboche-hospital \
  '{"resourceType":"Location","id":"loc-seboche-hospital","status":"active","name":"Seboche Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-butha-buthe-district"}}'
fhir_put Location loc-fobane-hc \
  '{"resourceType":"Location","id":"loc-fobane-hc","status":"active","name":"Fobane Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-butha-buthe-district"}}'
fhir_put Location loc-motete-hc \
  '{"resourceType":"Location","id":"loc-motete-hc","status":"active","name":"Motete Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-butha-buthe-district"}}'

# Leribe
fhir_put Location loc-motebang-hospital \
  '{"resourceType":"Location","id":"loc-motebang-hospital","status":"active","name":"Motebang Hospital (Hlotse)","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-leribe-district"}}'
fhir_put Location loc-mamohau-hospital \
  '{"resourceType":"Location","id":"loc-mamohau-hospital","status":"active","name":"Mamohau Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-leribe-district"}}'
fhir_put Location loc-hlotse-hc \
  '{"resourceType":"Location","id":"loc-hlotse-hc","status":"active","name":"Hlotse Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-leribe-district"}}'
fhir_put Location loc-maputsoe-hc \
  '{"resourceType":"Location","id":"loc-maputsoe-hc","status":"active","name":"Maputsoe Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-leribe-district"}}'
fhir_put Location loc-tsikoane-hc \
  '{"resourceType":"Location","id":"loc-tsikoane-hc","status":"active","name":"Tsikoane Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-leribe-district"}}'

# Mafeteng
fhir_put Location loc-mafeteng-hospital \
  '{"resourceType":"Location","id":"loc-mafeteng-hospital","status":"active","name":"Mafeteng Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mafeteng-district"}}'
fhir_put Location loc-mohalalitoe-hc \
  '{"resourceType":"Location","id":"loc-mohalalitoe-hc","status":"active","name":"Mohalalitoe Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mafeteng-district"}}'
fhir_put Location loc-ramabanta-hc \
  '{"resourceType":"Location","id":"loc-ramabanta-hc","status":"active","name":"Ramabanta Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mafeteng-district"}}'
fhir_put Location loc-mafeteng-clinic \
  '{"resourceType":"Location","id":"loc-mafeteng-clinic","status":"active","name":"Mafeteng Urban Clinic","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mafeteng-district"}}'

# Mohale's Hoek
fhir_put Location loc-mohales-hoek-hosp \
  '{"resourceType":"Location","id":"loc-mohales-hoek-hosp","status":"active","name":"Mohale'"'"'s Hoek Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mohales-hoek-district"}}'
fhir_put Location loc-moyeni-hc \
  '{"resourceType":"Location","id":"loc-moyeni-hc","status":"active","name":"Moyeni Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mohales-hoek-district"}}'
fhir_put Location loc-sekake-hc \
  '{"resourceType":"Location","id":"loc-sekake-hc","status":"active","name":"Sekake Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mohales-hoek-district"}}'

# Mokhotlong
fhir_put Location loc-mokhotlong-hospital \
  '{"resourceType":"Location","id":"loc-mokhotlong-hospital","status":"active","name":"Mokhotlong Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mokhotlong-district"}}'
fhir_put Location loc-mapholaneng-hc \
  '{"resourceType":"Location","id":"loc-mapholaneng-hc","status":"active","name":"Mapholaneng Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mokhotlong-district"}}'
fhir_put Location loc-sani-hp \
  '{"resourceType":"Location","id":"loc-sani-hp","status":"active","name":"Sani Health Post","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-mokhotlong-district"}}'

# Qacha'"'"'s Nek
fhir_put Location loc-qachas-nek-hosp \
  '{"resourceType":"Location","id":"loc-qachas-nek-hosp","status":"active","name":"Qacha'"'"'s Nek Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-qachas-nek-district"}}'
fhir_put Location loc-qachas-nek-hc \
  '{"resourceType":"Location","id":"loc-qachas-nek-hc","status":"active","name":"Qacha'"'"'s Nek Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-qachas-nek-district"}}'
fhir_put Location loc-marakabei-hc \
  '{"resourceType":"Location","id":"loc-marakabei-hc","status":"active","name":"Marakabei Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-qachas-nek-district"}}'

# Quthing
fhir_put Location loc-quthing-hospital \
  '{"resourceType":"Location","id":"loc-quthing-hospital","status":"active","name":"Quthing Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-quthing-district"}}'
fhir_put Location loc-mount-moorosi-hc \
  '{"resourceType":"Location","id":"loc-mount-moorosi-hc","status":"active","name":"Mount Moorosi Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-quthing-district"}}'
fhir_put Location loc-mphaki-hc \
  '{"resourceType":"Location","id":"loc-mphaki-hc","status":"active","name":"Mphaki Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-quthing-district"}}'

# Thaba-Tseka
fhir_put Location loc-thaba-tseka-hosp \
  '{"resourceType":"Location","id":"loc-thaba-tseka-hosp","status":"active","name":"Thaba-Tseka Hospital","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HOSP","display":"Hospital"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-thaba-tseka-district"}}'
fhir_put Location loc-katse-hc \
  '{"resourceType":"Location","id":"loc-katse-hc","status":"active","name":"Katse Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-thaba-tseka-district"}}'
fhir_put Location loc-thaba-tseka-hc \
  '{"resourceType":"Location","id":"loc-thaba-tseka-hc","status":"active","name":"Thaba-Tseka Rural Health Centre","mode":"instance",
    "type":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-RoleCode","code":"HC","display":"Health Centre"}]}],
    "physicalType":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/location-physical-type","code":"bu","display":"Building"}]},
    "partOf":{"reference":"Location/loc-thaba-tseka-district"}}'

# 9c. VHW Practitioners
# In ATP profile, extra VHWs (Lineo + Mpho) are deactivated; BKM keeps all 3 active
if [ "$PROFILE" = "atp" ]; then VHW_EXT_ACTIVE=false; else VHW_EXT_ACTIVE=true; fi

# Fetch Thabo's Keycloak UUID so the FHIR Practitioner identifier uses the
# correct system (http://keycloak/user-id) the mediator's user-status lookup
# expects. Without this, Sync from FHIR would also surface a "ghost" Thabo
# row that has no working login link.
THABO_KC_ID=$(curl -sf -H "Authorization: Bearer ${KC_ADMIN_TOKEN}" \
  "http://localhost:8083/auth/admin/realms/opensrp/users?username=thabo.mokoena&exact=true" \
  | python3 -c "import sys,json; u=json.load(sys.stdin); print(u[0]['id'] if u else '')" 2>/dev/null || true)
[[ -z "$THABO_KC_ID" ]] && THABO_KC_ID="8e819e71-e7bf-4c18-b40e-0a01e2c7c5a3"
fhir_put Practitioner prac-thabo-mokoena \
  "{\"resourceType\":\"Practitioner\",\"id\":\"prac-thabo-mokoena\",\"active\":true,
    \"identifier\":[{\"system\":\"http://keycloak/user-id\",\"value\":\"${THABO_KC_ID}\"}],
    \"name\":[{\"use\":\"official\",\"family\":\"Mokoena\",\"given\":[\"Thabo\"]}],
    \"telecom\":[{\"system\":\"phone\",\"value\":\"+26650111001\",\"use\":\"mobile\"}],
    \"address\":[{\"district\":\"Maseru\",\"country\":\"LS\"}]}"

fhir_put Practitioner prac-lineo-nthabi \
  '{"resourceType":"Practitioner","id":"prac-lineo-nthabi","active":'"${VHW_EXT_ACTIVE}"',
    "identifier":[{"system":"http://hl7.org/fhir/sid/ietf-rfc-3986","value":"881cdd8c-84e8-4fe0-b7b3-82c22b2aec9c"}],
    "name":[{"use":"official","family":"Nthabi","given":["Lineo"]}],
    "telecom":[{"system":"phone","value":"+26650111002","use":"mobile"}],
    "address":[{"district":"Maseru","country":"LS"}]}'

fhir_put Practitioner prac-mpho-lerotholi \
  '{"resourceType":"Practitioner","id":"prac-mpho-lerotholi","active":'"${VHW_EXT_ACTIVE}"',
    "identifier":[{"system":"http://hl7.org/fhir/sid/ietf-rfc-3986","value":"9c85ca56-a59e-4edd-bb84-86891a34d6e0"}],
    "name":[{"use":"official","family":"Lerotholi","given":["Mpho"]}],
    "telecom":[{"system":"phone","value":"+26650111003","use":"mobile"}],
    "address":[{"district":"Maseru","country":"LS"}]}'

# 9c-admin. Seed opensrp-admin Practitioner with Keycloak UUID identifier
# The FHIR Gateway PractitionerDetail endpoint looks up the practitioner by
# Practitioner?identifier=<keycloak-uuid>. This step seeds/updates the admin
# practitioner with their current Keycloak UUID so the lookup succeeds.
if [[ -n "$KC_USER_ID" ]]; then
  fhir_put Practitioner 60ecaecf-5d25-4057-a502-f61aee561b47 \
    "{\"resourceType\":\"Practitioner\",\"id\":\"60ecaecf-5d25-4057-a502-f61aee561b47\",\"active\":true,
      \"identifier\":[
        {\"system\":\"http://keycloak/user-id\",\"value\":\"${KC_USER_ID}\"},
        {\"system\":\"http://keycloak/username\",\"value\":\"opensrp-admin\"}
      ],
      \"name\":[{\"use\":\"official\",\"family\":\"Admin\",\"given\":[\"OpenSRP\"]}],
      \"telecom\":[{\"system\":\"email\",\"value\":\"opensrp-admin@example.org\"}]}"
  log "  opensrp-admin FHIR Practitioner seeded with KC UUID: ${KC_USER_ID}"
else
  log "  WARNING: KC_USER_ID not set — opensrp-admin Practitioner identifier not updated"
fi

# 9d. PractitionerRoles
# Always include meta.tag on the admin role so every seed run writes a new
# version — this forces HAPI FHIR to re-index the practitioner reference.
# Without this, if the PractitionerRole was first seeded before the Practitioner
# existed, HAPI never creates the hfj_res_link row and ?practitioner= searches
# return 0 (causing opensrp-web "There was a problem fetching Practitioner details").
fhir_put PractitionerRole 21904d68-4f2a-4a34-96af-0a2f3eac5c5b \
  '{"resourceType":"PractitionerRole","id":"21904d68-4f2a-4a34-96af-0a2f3eac5c5b","active":true,
    "meta":{"tag":[{"system":"http://sandbox.lesotho/tags","code":"seeded"}]},
    "practitioner":{"reference":"Practitioner/60ecaecf-5d25-4057-a502-f61aee561b47"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-maseru-clinic-a"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FACILITY_WORKER","display":"Facility Worker"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-thabo-mokoena \
  '{"resourceType":"PractitionerRole","id":"role-thabo-mokoena","active":true,
    "practitioner":{"reference":"Practitioner/prac-thabo-mokoena"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-ha-mokoena"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FIELD_WORKER","display":"Field Worker"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-lineo-nthabi \
  '{"resourceType":"PractitionerRole","id":"role-lineo-nthabi","active":'"${VHW_EXT_ACTIVE}"',
    "practitioner":{"reference":"Practitioner/prac-lineo-nthabi"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-ha-sehlabane"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FIELD_WORKER","display":"Field Worker"}]}],
    "period":{"start":"2024-01-01"}}'

fhir_put PractitionerRole role-mpho-lerotholi \
  '{"resourceType":"PractitionerRole","id":"role-mpho-lerotholi","active":'"${VHW_EXT_ACTIVE}"',
    "practitioner":{"reference":"Practitioner/prac-mpho-lerotholi"},
    "organization":{"reference":"Organization/maseru-clinic-a"},
    "location":[{"reference":"Location/loc-matsieng"}],
    "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FIELD_WORKER","display":"Field Worker"}]}],
    "period":{"start":"2024-01-01"}}'

# 9d-atp. ATP people: 1 supervisor + per-facility {facility_worker, VHW}.
# (Thabo = VHW Clinic A, opensrp-admin = admin, already seeded above.)
# Keycloak UUIDs are pinned in config/keycloak/opensrp-realm.json (same values).
if [ "$PROFILE" = "atp" ]; then
  fhir_put Practitioner prac-supervisor \
    '{"resourceType":"Practitioner","id":"prac-supervisor","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-000000000001"}],
      "name":[{"use":"official","family":"Supervisor","given":["District"]}],
      "telecom":[{"system":"phone","value":"+26650000010","use":"mobile"}],
      "address":[{"district":"Maseru","country":"LS"}]}'
  fhir_put Practitioner prac-fw-clinic-a \
    '{"resourceType":"Practitioner","id":"prac-fw-clinic-a","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-00000000000a"}],
      "name":[{"use":"official","family":"Worker A","given":["Facility"]}],
      "telecom":[{"system":"phone","value":"+26650000011","use":"mobile"}],
      "address":[{"district":"Maseru","country":"LS"}]}'
  fhir_put Practitioner prac-fw-clinic-b \
    '{"resourceType":"Practitioner","id":"prac-fw-clinic-b","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-00000000000b"}],
      "name":[{"use":"official","family":"Worker B","given":["Facility"]}],
      "telecom":[{"system":"phone","value":"+26650000012","use":"mobile"}],
      "address":[{"district":"Maseru","country":"LS"}]}'
  fhir_put Practitioner prac-vhw-clinic-b \
    '{"resourceType":"Practitioner","id":"prac-vhw-clinic-b","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-0000000000cb"}],
      "name":[{"use":"official","family":"Sello","given":["Palesa"]}],
      "telecom":[{"system":"phone","value":"+26650000013","use":"mobile"}],
      "address":[{"district":"Maseru","country":"LS"}]}'

  fhir_put PractitionerRole role-supervisor \
    '{"resourceType":"PractitionerRole","id":"role-supervisor","active":true,
      "practitioner":{"reference":"Practitioner/prac-supervisor"},
      "organization":{"reference":"Organization/maseru-clinic-a"},
      "location":[{"reference":"Location/loc-maseru-district"}],
      "code":[{"coding":[{"system":"http://snomed.info/sct","code":"SUPERVISOR","display":"Supervisor"}]}],
      "period":{"start":"2024-01-01"}}'
  fhir_put PractitionerRole role-fw-clinic-a \
    '{"resourceType":"PractitionerRole","id":"role-fw-clinic-a","active":true,
      "practitioner":{"reference":"Practitioner/prac-fw-clinic-a"},
      "organization":{"reference":"Organization/maseru-clinic-a"},
      "location":[{"reference":"Location/loc-maseru-clinic-a"}],
      "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FACILITY_WORKER","display":"Facility Worker"}]}],
      "period":{"start":"2024-01-01"}}'
  fhir_put PractitionerRole role-fw-clinic-b \
    '{"resourceType":"PractitionerRole","id":"role-fw-clinic-b","active":true,
      "practitioner":{"reference":"Practitioner/prac-fw-clinic-b"},
      "organization":{"reference":"Organization/maseru-clinic-b"},
      "location":[{"reference":"Location/loc-maseru-clinic-b"}],
      "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FACILITY_WORKER","display":"Facility Worker"}]}],
      "period":{"start":"2024-01-01"}}'
  fhir_put PractitionerRole role-vhw-clinic-b \
    '{"resourceType":"PractitionerRole","id":"role-vhw-clinic-b","active":true,
      "practitioner":{"reference":"Practitioner/prac-vhw-clinic-b"},
      "organization":{"reference":"Organization/maseru-clinic-b"},
      "location":[{"reference":"Location/loc-maseru-clinic-b"}],
      "code":[{"coding":[{"system":"http://snomed.info/sct","code":"FIELD_WORKER","display":"Field Worker"}]}],
      "period":{"start":"2024-01-01"}}'
  log "  ATP people seeded: supervisor + FW/VHW per facility (6 incl. admin + Thabo)."
fi

# 9e. Patients (ATP: 1 patient; BKM: 10 patients across 3 catchment villages)
fhir_put Patient patient-001 \
  '{"resourceType":"Patient","id":"patient-001","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Katleho"]}],
    "gender":"male","birthDate":"2005-03-14",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
if [ "$PROFILE" = "atp" ]; then
  fhir_put Patient patient-b01 \
    '{"resourceType":"Patient","id":"patient-b01","active":true,
      "name":[{"use":"official","family":"Sello","given":["Lefu"]}],
      "gender":"male","birthDate":"2016-04-09",
      "managingOrganization":{"reference":"Organization/maseru-clinic-b"},
      "address":[{"text":"Clinic B catchment","district":"Maseru","country":"LS"}]}'
  log "  ATP: seeded 1 patient per facility (patient-001 @ Clinic A, patient-b01 @ Clinic B)."
fi
if [ "$PROFILE" != "atp" ]; then
fhir_put Patient patient-002 \
  '{"resourceType":"Patient","id":"patient-002","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Palesa"]}],
    "gender":"female","birthDate":"2010-07-22",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-003 \
  '{"resourceType":"Patient","id":"patient-003","active":true,
    "name":[{"use":"official","family":"Mokoena","given":["Teboho"]}],
    "gender":"male","birthDate":"2018-11-05",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Mokoena Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-004 \
  '{"resourceType":"Patient","id":"patient-004","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Mahlomola"]}],
    "gender":"male","birthDate":"1985-01-30",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-005 \
  '{"resourceType":"Patient","id":"patient-005","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Nthabiseng"]}],
    "gender":"female","birthDate":"1988-06-18",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-006 \
  '{"resourceType":"Patient","id":"patient-006","active":true,
    "name":[{"use":"official","family":"Sehlabane","given":["Lehlohonolo"]}],
    "gender":"male","birthDate":"2015-09-03",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Ha Sehlabane Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-007 \
  '{"resourceType":"Patient","id":"patient-007","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Mamello"]}],
    "gender":"female","birthDate":"1975-04-12",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-008 \
  '{"resourceType":"Patient","id":"patient-008","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Lebohang"]}],
    "gender":"male","birthDate":"2002-12-27",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-009 \
  '{"resourceType":"Patient","id":"patient-009","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Thato"]}],
    "gender":"female","birthDate":"2020-02-09",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fhir_put Patient patient-010 \
  '{"resourceType":"Patient","id":"patient-010","active":true,
    "name":[{"use":"official","family":"Matsieng","given":["Motlatsi"]}],
    "gender":"male","birthDate":"1960-08-15",
    "managingOrganization":{"reference":"Organization/maseru-clinic-a"},
    "address":[{"text":"Matsieng Village","district":"Maseru","country":"LS"}]}'
fi # end BKM-only patients

# 9f. Groups (catchment populations per VHW)
if [ "$PROFILE" = "atp" ]; then
  # ATP: 1 patient only
  fhir_put Group group-ha-mokoena \
    '{"resourceType":"Group","id":"group-ha-mokoena","type":"person","actual":true,"active":true,
      "identifier":[{"use":"official","value":"HH-001"}],
      "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
      "name":"Ha Mokoena - Thabo Mokoena catchment",
      "managingEntity":{"reference":"Practitioner/prac-thabo-mokoena"},
      "member":[{"entity":{"reference":"Patient/patient-001"}}]}'
else
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
fi

fhir_put Group group-ha-sehlabane \
  '{"resourceType":"Group","id":"group-ha-sehlabane","type":"person","actual":true,"active":'"${VHW_EXT_ACTIVE}"',
    "identifier":[{"use":"official","value":"HH-002"}],
    "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
    "name":"Ha Sehlabane - Lineo Nthabi catchment",
    "managingEntity":{"reference":"Practitioner/prac-lineo-nthabi"},
    "member":[
      {"entity":{"reference":"Patient/patient-004"}},
      {"entity":{"reference":"Patient/patient-005"}},
      {"entity":{"reference":"Patient/patient-006"}}]}'

fhir_put Group group-matsieng \
  '{"resourceType":"Group","id":"group-matsieng","type":"person","actual":true,"active":'"${VHW_EXT_ACTIVE}"',
    "identifier":[{"use":"official","value":"HH-003"}],
    "code":{"coding":[{"system":"https://www.snomed.org","code":"35359004","display":"Family"}]},
    "name":"Matsieng - Mpho Lerotholi catchment",
    "managingEntity":{"reference":"Practitioner/prac-mpho-lerotholi"},
    "member":[
      {"entity":{"reference":"Patient/patient-007"}},
      {"entity":{"reference":"Patient/patient-008"}},
      {"entity":{"reference":"Patient/patient-009"}},
      {"entity":{"reference":"Patient/patient-010"}}]}'

# 9g. CareTeam (ATP: 6 members across 2 facilities; BKM: 4 members)
if [ "$PROFILE" = "atp" ]; then
  fhir_put CareTeam team-maseru-north \
    '{"resourceType":"CareTeam","id":"team-maseru-north","status":"active",
      "name":"Maseru District Stock Team",
      "participant":[
        {"role":[{"coding":[{"code":"supervisor","display":"Supervisor"}]}],
         "member":{"reference":"Practitioner/prac-supervisor"}},
        {"role":[{"coding":[{"code":"supervisor","display":"Supervisor"}]}],
         "member":{"reference":"Practitioner/60ecaecf-5d25-4057-a502-f61aee561b47"}},
        {"role":[{"coding":[{"code":"FACILITY_WORKER","display":"Facility Worker"}]}],
         "member":{"reference":"Practitioner/prac-fw-clinic-a"}},
        {"role":[{"coding":[{"code":"FIELD_WORKER","display":"Field Worker"}]}],
         "member":{"reference":"Practitioner/prac-thabo-mokoena"}},
        {"role":[{"coding":[{"code":"FACILITY_WORKER","display":"Facility Worker"}]}],
         "member":{"reference":"Practitioner/prac-fw-clinic-b"}},
        {"role":[{"coding":[{"code":"FIELD_WORKER","display":"Field Worker"}]}],
         "member":{"reference":"Practitioner/prac-vhw-clinic-b"}}]}'
  log "HAPI FHIR seeded (ATP): 2 facilities, 6 people, 6-member care team."
else
  fhir_put CareTeam team-maseru-north \
    '{"resourceType":"CareTeam","id":"team-maseru-north","status":"active",
      "name":"Maseru North VHW Team",
      "participant":[
        {"role":[{"coding":[{"code":"supervisor","display":"Supervisor"}]}],
         "member":{"reference":"Practitioner/60ecaecf-5d25-4057-a502-f61aee561b47"}},
        {"role":[{"coding":[{"code":"FIELD_WORKER","display":"Field Worker"}]}],
         "member":{"reference":"Practitioner/prac-thabo-mokoena"}},
        {"role":[{"coding":[{"code":"FIELD_WORKER","display":"Field Worker"}]}],
         "member":{"reference":"Practitioner/prac-lineo-nthabi"}},
        {"role":[{"coding":[{"code":"FIELD_WORKER","display":"Field Worker"}]}],
         "member":{"reference":"Practitioner/prac-mpho-lerotholi"}}]}'
  log "HAPI FHIR seeded: 1 org, 6 locations, 3 VHWs, 4 roles, 10 patients, 3 groups, 1 care team."
fi

# ─── 9g. Seed RelatedPerson (head of household) ──────────────────────────────
# The householdProfile Binary config has a familyHeadId JEXL rule that calls
# .get(0) on RelatedPerson resources filtered by code 99990006 (Head of Household).
# One RelatedPerson per group is required; linked to the head patient via .patient.
fhir_put RelatedPerson rp-head-ha-mokoena \
  '{"resourceType":"RelatedPerson","id":"rp-head-ha-mokoena","active":true,
    "patient":{"reference":"Patient/patient-001"},
    "relationship":[{"coding":[{"system":"https://www.snomed.org","code":"99990006","display":"Head of Household"}]}],
    "name":[{"use":"official","text":"Thabo Mokoena"}]}'

if [ "$PROFILE" != "atp" ]; then
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
fi

log "RelatedPerson (head of household) seeded."

# ─── 9g-cleanup. ATP profile: purge extra FHIR resources for minimal demo ────
# Deletes: extra patients (002-010), extra practitioners/roles, extra RelatedPersons,
# extra locations, all QR/MedicationDispense (demo history), Observation/Flag/MeasureReport.
if [ "$PROFILE" = "atp" ]; then
  log "ATP profile: purging extra FHIR resources for clean minimal demo ..."
  python3 << 'PYEOF'
import urllib.request, json
BASE = "http://localhost:8079/fhir"

def fhir_delete(rtype, rid):
    try:
        urllib.request.urlopen(urllib.request.Request(f"{BASE}/{rtype}/{rid}", method="DELETE"))
    except: pass

def delete_all(rtype):
    deleted = 0
    url = f"{BASE}/{rtype}?_count=200"
    while url:
        req = urllib.request.Request(url, headers={"Accept":"application/fhir+json"})
        with urllib.request.urlopen(req) as r:
            bundle = json.loads(r.read())
        for entry in bundle.get("entry", []):
            try:
                urllib.request.urlopen(urllib.request.Request(
                    f"{BASE}/{rtype}/{entry['resource']['id']}", method="DELETE"))
                deleted += 1
            except: pass
        url = next((l["url"] for l in bundle.get("link",[]) if l["relation"]=="next"), None)
    print(f"  Purged {deleted} {rtype}")

# Extra patients (keep only patient-001)
for i in range(2, 11):
    fhir_delete("Patient", f"patient-00{i}")
print("  Purged patients 002-010")

# Extra practitioners and roles
for x in ["prac-lineo-nthabi","prac-mpho-lerotholi"]:
    fhir_delete("Practitioner", x)
for x in ["role-lineo-nthabi","role-mpho-lerotholi"]:
    fhir_delete("PractitionerRole", x)
print("  Purged extra practitioners + roles")

# Extra RelatedPersons and Locations
for x in ["rp-head-ha-sehlabane","rp-head-matsieng"]:
    fhir_delete("RelatedPerson", x)
for x in ["loc-ha-sehlabane","loc-matsieng"]:
    fhir_delete("Location", x)
print("  Purged extra RelatedPersons + locations")

# All Groups except group-ha-mokoena (device/commodity groups + test groups from app)
url = f"{BASE}/Group?_count=200"
deleted = 0
while url:
    req = urllib.request.Request(url, headers={"Accept":"application/fhir+json"})
    with urllib.request.urlopen(req) as r:
        bundle = json.loads(r.read())
    for entry in bundle.get("entry", []):
        rid = entry["resource"]["id"]
        if rid == "group-ha-mokoena":
            continue
        try:
            urllib.request.urlopen(urllib.request.Request(f"{BASE}/Group/{rid}", method="DELETE"))
            deleted += 1
        except: pass
    url = next((l["url"] for l in bundle.get("link",[]) if l["relation"]=="next"), None)
print(f"  Purged {deleted} extra Groups (kept group-ha-mokoena)")

# Demo history and inventory noise
delete_all("QuestionnaireResponse")
delete_all("MedicationDispense")
delete_all("Observation")
delete_all("Flag")
delete_all("MeasureReport")
PYEOF
fi

# ─── 9h. BKM app configs: Binary configs + Composition + FHIR content ──────────────
# Uploads 31 Binary config resources, the Composition (identifier=app), patches
# the sync_config to use _lastUpdated for Observation/Flag/MeasureReport, and
# uploads 87 FHIR content resources (Questionnaires, StructureMaps, PlanDefinitions).
log "Uploading BKM app configs (Binaries + Composition + FHIR content) ..."
PYTHONIOENCODING=utf-8 python3 "$(pwd)/scripts/upload_bkm_configs.py"

# 9h-atp. Re-assert ATP people as the FINAL HAPI step. The earlier 9d-atp block can
# race with the purge / app-config upload (observed: prac-fw-clinic-a + prac-vhw-clinic-b
# occasionally deleted mid-run), so re-PUT all four here to guarantee final state.
if [ "$PROFILE" = "atp" ]; then
  log "ATP: re-asserting the 6-person team (final HAPI step) ..."
  fhir_put Practitioner prac-supervisor \
    '{"resourceType":"Practitioner","id":"prac-supervisor","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-000000000001"}],
      "name":[{"use":"official","family":"Supervisor","given":["District"]}]}'
  fhir_put Practitioner prac-fw-clinic-a \
    '{"resourceType":"Practitioner","id":"prac-fw-clinic-a","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-00000000000a"}],
      "name":[{"use":"official","family":"Worker A","given":["Facility"]}]}'
  fhir_put Practitioner prac-fw-clinic-b \
    '{"resourceType":"Practitioner","id":"prac-fw-clinic-b","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-00000000000b"}],
      "name":[{"use":"official","family":"Worker B","given":["Facility"]}]}'
  fhir_put Practitioner prac-vhw-clinic-b \
    '{"resourceType":"Practitioner","id":"prac-vhw-clinic-b","active":true,
      "identifier":[{"system":"http://keycloak/user-id","value":"a0000000-0000-4000-8000-0000000000cb"}],
      "name":[{"use":"official","family":"Sello","given":["Palesa"]}]}'
  log "  ATP people re-asserted."
fi

# ─── 9i. Seed inventory stock levels ────────────────────────────────────────────────
# Seeds Observation (stock balance), Flag (stockouts), and MeasureReport (AMC)
# for each of the 32 commodity Groups so the Inventory register shows real data.
log "Seeding inventory stock levels (Observations + Flags + MeasureReports) ..."
PYTHONIOENCODING=utf-8 python3 "$(pwd)/scripts/seed_inventory.py"

# ─── 9j. Seed facility-worker delivery-acceptance Questionnaire ──────────────
# The FW-receipt FHIR Task created at dispatch time contains an input reference
# to this Questionnaire so the Android app auto-launches it on task open.
# The mediator detects this QR via /qn-stock-accept/ pattern → CREDIT stockEvent.
log "Seeding Questionnaire/qn-stock-accept-delivery ..."
curl -sf -X PUT "http://localhost:8079/fhir/Questionnaire/qn-stock-accept-delivery" \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType":"Questionnaire",
    "id":"qn-stock-accept-delivery",
    "url":"http://bkm.lesotho/fhir/Questionnaire/qn-stock-accept-delivery",
    "name":"StockAcceptDelivery",
    "title":"Accept Stock Delivery",
    "status":"active",
    "subjectType":["Practitioner"],
    "item":[
      {"linkId":"task_id","text":"Task ID","type":"string","required":true,
       "extension":[{"url":"http://hl7.org/fhir/StructureDefinition/questionnaire-hidden","valueBoolean":true}]},
      {"linkId":"d-commodity-name","text":"Medicine","type":"string","readOnly":true},
      {"linkId":"quantity_ordered","text":"Quantity Ordered","type":"integer","readOnly":true},
      {"linkId":"quantity_received","text":"Quantity Received","type":"integer","required":true},
      {"linkId":"type","text":"Transaction Type","type":"string","required":true,
       "extension":[{"url":"http://hl7.org/fhir/StructureDefinition/questionnaire-hidden","valueBoolean":true}],
       "initial":[{"valueString":"RECEIPT"}]}
    ]
  }' >/dev/null && log "  Questionnaire/qn-stock-accept-delivery seeded."

# ─── 9j2. Seed patient-dispense-medicine Questionnaire ───────────────────────
# Used by the "Dispense Medicine" overflow menu item on the patient profile.
# Submitted as a bundle QR → bundleSync → fan-out to OpenLMIS + DHIS2.
log "Seeding Questionnaire/patient-dispense-medicine ..."
curl -sf -X PUT "http://localhost:8079/fhir/Questionnaire/patient-dispense-medicine" \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType":"Questionnaire",
    "id":"patient-dispense-medicine",
    "url":"http://bkm.lesotho/fhir/Questionnaire/patient-dispense-medicine",
    "name":"PatientDispenseMedicine",
    "title":"Dispense Medicine",
    "status":"active",
    "subjectType":["Patient"],
    "item":[
      {"linkId":"patient-id","text":"Patient ID","type":"string","required":false,
       "extension":[{"url":"http://hl7.org/fhir/StructureDefinition/questionnaire-hidden","valueBoolean":true}]},
      {"linkId":"medication","text":"Medicine","type":"choice","required":true,
       "answerOption":[
         {"valueCoding":{"code":"AL-20-120","display":"AL 20/120mg (Artemether-Lumefantrine)"}},
         {"valueCoding":{"code":"Amoxicillin 250mg","display":"Amoxicillin 250mg"}},
         {"valueCoding":{"code":"Paracetamol Syrup","display":"Paracetamol Syrup"}},
         {"valueCoding":{"code":"Zinc 20mg","display":"Zinc 20mg"}},
         {"valueCoding":{"code":"ORS Sachet","display":"ORS Sachet"}},
         {"valueCoding":{"code":"Cotrimoxazole 480mg","display":"Cotrimoxazole 480mg"}},
         {"valueCoding":{"code":"Iron + Folic Acid","display":"Iron + Folic Acid"}},
         {"valueCoding":{"code":"RDT Kit","display":"RDT Kit"}},
         {"valueCoding":{"code":"Roller Bandages","display":"Roller Bandages"}},
         {"valueCoding":{"code":"Male Condoms","display":"Male Condoms"}}
       ]},
      {"linkId":"quantity","text":"Quantity","type":"integer","required":true,
       "extension":[{"url":"http://hl7.org/fhir/StructureDefinition/minValue","valueInteger":1}]}
    ]
  }' >/dev/null && log "  Questionnaire/patient-dispense-medicine seeded."

# ─── 9k. Seed demo delivery Tasks (always PUT → reset to requested for demos) ──
# Delete all existing Tasks first so stale tasks from previous profiles are gone.
log "Deleting all existing FHIR Tasks before seeding..."
TASK_IDS=$(curl -sf "http://localhost:8079/fhir/Task?_count=200" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(' '.join(e['resource']['id'] for e in d.get('entry',[])))
" 2>/dev/null || true)
for tid in $TASK_IDS; do
  curl -sf -X DELETE "http://localhost:8079/fhir/Task/${tid}" >/dev/null || true
done
log "  Old Tasks cleared."

# PUT is idempotent; always resets status=requested so demos can be repeated.
# ATP: 1 Oxytocin task (+ marks old BKM tasks completed)
# BKM: 3 AL/Amox/Cotri tasks (+ marks ATP task completed if present)
if [ "$PROFILE" = "atp" ]; then
  log "Seeding demo delivery Task (ATP profile: Oxytocin 10 IU)..."
  curl -sf -X PUT "http://localhost:8079/fhir/Task/task-fw-oxyt-001" \
    -H "Content-Type: application/fhir+json" \
    -d '{"resourceType":"Task","id":"task-fw-oxyt-001","status":"requested","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001","display":"Stock Issue"}]},"description":"Oxytocin 10 IU delivery","authoredOn":"2026-05-19T08:00:00Z","lastModified":"'"${NOW}"'","for":{"reference":"Organization/maseru-clinic-a"},"input":[{"type":{"text":"product"},"valueString":"Oxytocin 10 IU"},{"type":{"text":"quantity"},"valueInteger":200},{"type":{"text":"issueRef"},"valueString":"DISPATCH-ATP-001"},{"type":{"coding":[{"system":"http://hl7.org/fhir/uv/sdc/CodeSystem/temp","code":"questionnaire"}]},"valueReference":{"reference":"Questionnaire/qn-stock-accept-delivery"}}]}' \
    >/dev/null && log "  Task/task-fw-oxyt-001: OK"
  # Complete old BKM tasks so they disappear from the task register
  for OLD_ID in task-fw-al-001 task-fw-amox-001 task-fw-cotri-001; do
    curl -sf -X PUT "http://localhost:8079/fhir/Task/${OLD_ID}" \
      -H "Content-Type: application/fhir+json" \
      -d '{"resourceType":"Task","id":"'"${OLD_ID}"'","status":"completed","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001"}]}}' \
      >/dev/null 2>&1 && log "  Task/${OLD_ID}: set completed" || true
  done
else
  log "Seeding demo delivery Tasks (BKM profile: AL/Amox/Cotri)..."
  for TASK_JSON in \
    '{"resourceType":"Task","id":"task-fw-al-001","status":"requested","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001","display":"Stock Issue"}]},"description":"AL 20/120mg delivery","authoredOn":"2026-05-18T08:00:00Z","lastModified":"'"${NOW}"'","for":{"reference":"Organization/maseru-clinic-a"},"input":[{"type":{"text":"product"},"valueString":"AL 20/120mg"},{"type":{"text":"quantity"},"valueInteger":200},{"type":{"text":"issueRef"},"valueString":"DISPATCH-DEMO-001"},{"type":{"coding":[{"system":"http://hl7.org/fhir/uv/sdc/CodeSystem/temp","code":"questionnaire"}]},"valueReference":{"reference":"Questionnaire/qn-stock-accept-delivery"}}]}' \
    '{"resourceType":"Task","id":"task-fw-amox-001","status":"requested","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001","display":"Stock Issue"}]},"description":"Amoxicillin 500mg delivery","authoredOn":"2026-05-18T08:00:00Z","lastModified":"'"${NOW}"'","for":{"reference":"Organization/maseru-clinic-a"},"input":[{"type":{"text":"product"},"valueString":"Amoxicillin 500mg"},{"type":{"text":"quantity"},"valueInteger":150},{"type":{"text":"issueRef"},"valueString":"DISPATCH-DEMO-002"},{"type":{"coding":[{"system":"http://hl7.org/fhir/uv/sdc/CodeSystem/temp","code":"questionnaire"}]},"valueReference":{"reference":"Questionnaire/qn-stock-accept-delivery"}}]}' \
    '{"resourceType":"Task","id":"task-fw-cotri-001","status":"requested","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001","display":"Stock Issue"}]},"description":"Cotrimoxazole 480mg delivery","authoredOn":"2026-05-18T08:00:00Z","lastModified":"'"${NOW}"'","for":{"reference":"Organization/maseru-clinic-a"},"input":[{"type":{"text":"product"},"valueString":"Cotrimoxazole 480mg"},{"type":{"text":"quantity"},"valueInteger":100},{"type":{"text":"issueRef"},"valueString":"DISPATCH-DEMO-003"},{"type":{"coding":[{"system":"http://hl7.org/fhir/uv/sdc/CodeSystem/temp","code":"questionnaire"}]},"valueReference":{"reference":"Questionnaire/qn-stock-accept-delivery"}}]}' \
  ; do
    TASK_ID=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
    curl -sf -X PUT "http://localhost:8079/fhir/Task/${TASK_ID}" \
      -H "Content-Type: application/fhir+json" \
      -d "$TASK_JSON" >/dev/null && log "  Task/${TASK_ID}: OK"
  done
  # Complete ATP task if it exists from a previous profile switch
  curl -sf -X PUT "http://localhost:8079/fhir/Task/task-fw-oxyt-001" \
    -H "Content-Type: application/fhir+json" \
    -d '{"resourceType":"Task","id":"task-fw-oxyt-001","status":"completed","intent":"order","code":{"coding":[{"system":"http://snomed.info/sct","code":"373748001"}]}}' \
    >/dev/null 2>&1 || true
fi

# ─── 8b. Seed OpenLMIS stock adjustment reasons ───────────────────────────────
# Three DEBIT reasons for VHW stock adjustments (Expired, Damaged, Lost/Stolen).
# Fixed UUIDs referenced by the mediator via OPENLMIS_REASON_EXPIRED/DAMAGED/LOST env vars.
log "Seeding OpenLMIS stock adjustment reasons (Expired, Damaged, Lost/Stolen)..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -c "
  INSERT INTO stockmanagement.stock_card_line_item_reasons
    (id, name, description, reasontype, reasoncategory, isfreetextallowed)
  VALUES
    ('ae6be2ea-4a95-4e7e-b8d3-000000000004','Stock Requested', 'VHW batch stock order request', 'DEBIT','ADJUSTMENT',false)
  ON CONFLICT (id) DO UPDATE
    SET description=EXCLUDED.description;
" && log "  Adjustment reasons seeded (incl. Stock Requested)."
# Re-run valid_reason_assignments so newly-inserted reasons are linked to both facility types
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q -c "
  INSERT INTO stockmanagement.valid_reason_assignments (id, facilitytypeid, programid, reasonid, hidden)
  SELECT gen_random_uuid(), '${FACILITY_TYPE_ID}', '${PROGRAM_ID}', id, false
  FROM stockmanagement.stock_card_line_item_reasons
  ON CONFLICT DO NOTHING;
  INSERT INTO stockmanagement.valid_reason_assignments (id, facilitytypeid, programid, reasonid, hidden)
  SELECT gen_random_uuid(), '${FACILITY_TYPE_HOSPITAL_ID}', '${PROGRAM_ID}', id, false
  FROM stockmanagement.stock_card_line_item_reasons
  ON CONFLICT DO NOTHING;
" 2>/dev/null && log "  valid_reason_assignments refreshed for both facility types."

set +e  # DHIS2 analytics — best-effort
# ─── 10. Generate DHIS2 analytics tables ──────────────────────────────────────
log "Step 10: Generating DHIS2 analytics tables..."
JOB_ID=$(curl -s -u admin:${DHIS2_PASSWORD} -X POST "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('response',{}).get('id',''))" 2>/dev/null)
if [ -n "$JOB_ID" ]; then
  log "  Analytics job started: $JOB_ID — waiting up to 60s..."
  for i in $(seq 1 12); do
    sleep 5
    DONE=$(curl -s -u admin:${DHIS2_PASSWORD} "http://localhost:8081/api/system/tasks/ANALYTICS_TABLE/${JOB_ID}" \
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

# Install the "BKM End-to-End Flow" Console visualizer (idempotent, best-effort).
SCRIPT_DIR_VIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR_VIS/setup-visualizer.sh" ]; then
  bash "$SCRIPT_DIR_VIS/setup-visualizer.sh" || log "  visualizer install skipped (non-fatal)"
fi

# ─── 12. Configure dhis2-integration service ──────────────────────────────────
log "Step 12: Configuring dhis2-integration..."

# Wait for dhis2-integration Flyway to create the dhis2 schema
for i in $(seq 1 12); do
  SCHEMA_OK=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis \
    -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='dhis2' AND table_name='servers';" 2>/dev/null | tr -d ' ')
  [ "$SCHEMA_OK" = "1" ] && break
  log "  Waiting for dhis2 schema... ($i/12)"
  sleep 5
done

# Ensure a server row exists, then update it with correct DHIS2 credentials
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -c "
  INSERT INTO dhis2.servers (id, name, url, username, password)
  SELECT gen_random_uuid(), 'DHIS2', 'http://dhis2-web:8080', 'admin', 'district'
  WHERE NOT EXISTS (SELECT 1 FROM dhis2.servers);
  UPDATE dhis2.servers
  SET    url      = 'http://dhis2-web:8080',
         username = 'admin',
         password = 'district'
  WHERE  url = 'CHANGE_ME' OR url NOT LIKE 'http://dhis2-web%';
" >/dev/null 2>&1

# Seed dataset + data element mappings so dhis2-integration knows what to push to DHIS2
# These rows are wiped on every dhis2-integration restart (flyway.clean=true), so we always re-insert.
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -c "
  INSERT INTO dhis2.datasets (id, name, dhisdatasetid, cronexpression, serverid, timeoffset)
  SELECT 'aaaabbbb-0000-0000-0000-000000000010',
         'BKM Stock Sync',
         'BKMDs2Sync1',
         '0 0 1 * * ?',
         (SELECT id FROM dhis2.servers LIMIT 1),
         0
  WHERE NOT EXISTS (SELECT 1 FROM dhis2.datasets WHERE id = 'aaaabbbb-0000-0000-0000-000000000010');

  INSERT INTO dhis2.data_elements (id, name, source, indicator, orderable, element, datasetid, categorycombo)
  VALUES
    ('aaaabbbb-0000-0000-0000-000000000011',
     'AL 20/120mg - Dispensed',
     'Stock Management',
     'NEGATIVE_ADJUSTMENTS',
     '3be1d20f-6aa9-4e52-864f-4fa04aa02056',
     'ujPSJuS9pph',
     'aaaabbbb-0000-0000-0000-000000000010',
     'default'),
    ('aaaabbbb-0000-0000-0000-000000000012',
     'AL 20/120mg - Received',
     'Stock Management',
     'POSITIVE_ADJUSTMENTS',
     '3be1d20f-6aa9-4e52-864f-4fa04aa02056',
     'StckRcvdAL1',
     'aaaabbbb-0000-0000-0000-000000000010',
     'default'),
    ('aaaabbbb-0000-0000-0000-000000000013',
     'AL 20/120mg - Stock on Hand',
     'Stock Management',
     'CLOSING_BALANCE',
     '3be1d20f-6aa9-4e52-864f-4fa04aa02056',
     'StockOnHnd1',
     'aaaabbbb-0000-0000-0000-000000000010',
     'default')
  ON CONFLICT DO NOTHING;
" >/dev/null 2>&1

# Ensure shared_facilities maps Maseru District Clinic A -> DHIS2 org unit dwx1Yz4BwNX
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -c "
  INSERT INTO dhis2.shared_facilities (id, code, facilityid, orgunitid, serverid)
  SELECT '00000003-0000-0000-0000-000000000001',
         'MDA',
         '28de536f-b826-4eeb-a3c4-d65221a1120d',
         'dwx1Yz4BwNX',
         (SELECT id FROM dhis2.servers LIMIT 1)
  WHERE NOT EXISTS (
    SELECT 1 FROM dhis2.shared_facilities
    WHERE id = '00000003-0000-0000-0000-000000000001'
  );
" >/dev/null 2>&1

# Ensure DHIS2 org unit has code 'MDA' (required by dhis2-integration orgUnitIdScheme=code)
curl -s -X PATCH "http://localhost:8081/api/organisationUnits/dwx1Yz4BwNX" \
  -H "Content-Type: application/json" -u "admin:district" \
  -d '{"code":"MDA"}' >/dev/null 2>&1

# Ensure DHIS2 dataset 'BKM Stock Sync' allows current and next 2 months
curl -s -X PATCH "http://localhost:8081/api/dataSets/BKMDs2Sync1" \
  -H "Content-Type: application/json" -u "admin:district" \
  -d '{"openFuturePeriods":2}' >/dev/null 2>&1

# Create category options, category, and categoryCombo if not already present
for COC_ID in BKMCatNeg01 BKMCatPos01 BKMCatSOH01; do
  EXISTS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8081/api/categoryOptions/${COC_ID}" -u "admin:district")
  if [ "$EXISTS" != "200" ]; then
    case "$COC_ID" in
      BKMCatNeg01) NAME="Negative Adjustments"; SHORT="Neg Adj" ;;
      BKMCatPos01) NAME="Positive Adjustments"; SHORT="Pos Adj" ;;
      BKMCatSOH01) NAME="Closing Balance";      SHORT="Closing Bal" ;;
    esac
    curl -s -X POST "http://localhost:8081/api/categoryOptions" \
      -H "Content-Type: application/json" -u "admin:district" \
      -d "{\"id\":\"${COC_ID}\",\"name\":\"${NAME}\",\"shortName\":\"${SHORT}\"}" >/dev/null 2>&1
  fi
done

EXISTS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8081/api/categories/BKMCatgry1x" -u "admin:district")
if [ "$EXISTS" != "200" ]; then
  curl -s -X POST "http://localhost:8081/api/categories" \
    -H "Content-Type: application/json" -u "admin:district" \
    -d '{"id":"BKMCatgry1x","name":"BKM Stock Type","shortName":"BKM Stock","dataDimensionType":"DISAGGREGATION","categoryOptions":[{"id":"BKMCatNeg01"},{"id":"BKMCatPos01"},{"id":"BKMCatSOH01"}]}' >/dev/null 2>&1
fi

EXISTS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8081/api/categoryCombos/BKMCatComb1" -u "admin:district")
if [ "$EXISTS" != "200" ]; then
  curl -s -X POST "http://localhost:8081/api/categoryCombos" \
    -H "Content-Type: application/json" -u "admin:district" \
    -d '{"id":"BKMCatComb1","name":"BKM Stock Indicators","shortName":"BKM Stock","dataDimensionType":"DISAGGREGATION","skipTotal":true,"categories":[{"id":"BKMCatgry1x"}]}' >/dev/null 2>&1
fi

# Create/update stock dashboard data element (name varies by profile)
if [ "$PROFILE" = "atp" ]; then
  DASH_DE_NAME="Oxytocin 10 IU"; DASH_DE_CODE="OXYTOCIN10IU"
else
  DASH_DE_NAME="AL 20/120mg"; DASH_DE_CODE="AL_20_120MG"
fi
curl -sf -X PUT "http://localhost:8081/api/dataElements/ALStockDE01" \
  -H "Content-Type: application/json" -u "admin:district" \
  -d "{\"id\":\"ALStockDE01\",\"name\":\"${DASH_DE_NAME}\",\"shortName\":\"${DASH_DE_NAME}\",\"code\":\"${DASH_DE_CODE}\",\"domainType\":\"AGGREGATE\",\"valueType\":\"NUMBER\",\"aggregationType\":\"SUM\",\"categoryCombo\":{\"id\":\"BKMCatComb1\"}}" >/dev/null 2>&1

# Ensure dataset uses the data element
curl -s -X PUT "http://localhost:8081/api/dataSets/BKMDs2Sync1" \
  -H "Content-Type: application/json" -u "admin:district" \
  -d '{"id":"BKMDs2Sync1","name":"BKM Stock Sync","shortName":"BKM Stock","periodType":"Monthly","openFuturePeriods":2,"organisationUnits":[{"id":"dwx1Yz4BwNX"},{"id":"MasClinicB1"}],"dataSetElements":[{"dataSet":{"id":"BKMDs2Sync1"},"dataElement":{"id":"ALStockDE01"}}]}' >/dev/null 2>&1

log "  dhis2-integration configured."

# Create DHIS2 visualizations + dashboard for the stock integration data
python3 << PYEOF
import urllib.request, json, base64

BASE = "http://localhost:8081/api"
auth_header = "Basic " + base64.b64encode(b"admin:district").decode()

def api(method, path, data=None):
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(BASE + path, data=body, method=method,
          headers={"Content-Type":"application/json","Authorization":auth_header})
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read()
            return json.loads(txt) if txt else {}, r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code

COC_NEG = "oop5xfCVJ01"   # Negative Adjustments
COC_POS = "R988AFoArQU"   # Positive Adjustments
COC_SOH = "E8qivaMehZx"   # Closing Balance
DE  = "ALStockDE01"
OU  = "dwx1Yz4BwNX"
MED = "${DASH_DE_NAME}"
# LAST_12_MONTHS excludes the current month; THIS_MONTH captures live data
PERIOD = [{"id":"LAST_12_MONTHS"}, {"id":"THIS_MONTH"}]

VIZ = [
    ("BKMStkLine1", f"{MED} - Stock on Hand (Monthly)", "LINE",
     [{"id": f"{DE}.{COC_SOH}"}]),
    ("BKMStkBar01", f"{MED} - Dispensed (Monthly)", "COLUMN",
     [{"id": f"{DE}.{COC_NEG}"}]),
    ("BKMStkBar02", f"{MED} - Received (Monthly)", "COLUMN",
     [{"id": f"{DE}.{COC_POS}"}]),
    ("BKMStkPvt01", f"{MED} - Stock Summary (All Indicators)", "PIVOT_TABLE",
     [{"id": f"{DE}.{COC_NEG}"}, {"id": f"{DE}.{COC_POS}"}, {"id": f"{DE}.{COC_SOH}"}]),
]

for uid, name, vtype, items in VIZ:
    api("DELETE", f"/visualizations/{uid}")
    _, s = api("POST", "/visualizations", {
        "id": uid, "name": name, "type": vtype,
        "columns": [{"dimension":"dx","items":items}],
        "rows":    [{"dimension":"pe","items":PERIOD}],
        "filters": [{"dimension":"ou","items":[{"id":OU}]}],
        "showData": True, "hideEmptyRows": True
    })
    print(f"  viz {uid}: HTTP {s}")

api("DELETE", "/dashboards/BKMStkDsh01")
api("POST", "/dashboards", {"id":"BKMStkDsh01","name":f"BKM Stock - {MED}","dashboardItems":[]})
_, s = api("PUT", "/dashboards/BKMStkDsh01", {
    "id": "BKMStkDsh01", "name": f"BKM Stock - {MED}",
    "dashboardItems": [
        {"type":"VISUALIZATION","visualization":{"id":"BKMStkLine1"}},
        {"type":"VISUALIZATION","visualization":{"id":"BKMStkBar01"}},
        {"type":"VISUALIZATION","visualization":{"id":"BKMStkBar02"}},
        {"type":"VISUALIZATION","visualization":{"id":"BKMStkPvt01"}},
    ]
})
print(f"  dashboard BKMStkDsh01: HTTP {s}")
PYEOF

log "  DHIS2 stock dashboard: http://localhost:8081/dhis-web-dashboard/index.html#/BKMStkDsh01"

# ─── Simplify dashboards: keep ONLY BKM Stock Dispensing (for ATP + training) ──
# Deletes every DHIS2 dashboard except ${DHIS2_DASHBOARD} (BKMDashbrd1). Runs after
# all dashboards above are created. The mediator's order-status updater no-ops when
# BKMOrdDsh01 is absent (best-effort GET+PUT), so it is not recreated.
for _did in $(curl -s -u admin:${DHIS2_PASSWORD} "http://localhost:8081/api/dashboards.json?fields=id&paging=false" \
    | python3 -c "import sys,json; [print(d['id']) for d in json.load(sys.stdin).get('dashboards',[]) if d.get('id')!='${DHIS2_DASHBOARD}']" 2>/dev/null); do
  curl -s -u admin:${DHIS2_PASSWORD} -X DELETE "http://localhost:8081/api/dashboards/${_did}" > /dev/null
done
log "DHIS2 dashboards simplified — only ${DHIS2_DASHBOARD} (BKM Stock Dispensing) kept"

# ─── Reload fhir-proxy nginx ──────────────────────────────────────────────────
# Re-resolves bkm-mediator DNS. Required when the mediator container was rebuilt
# (gets a new IP) while fhir-proxy was still running. Safe to always run.
docker exec fhir-proxy nginx -s reload 2>/dev/null && log "fhir-proxy nginx reloaded (DNS refresh)" || true

# ─── Patch bkm-web nginx (Keycloak admin API proxy) ───────────────────────────
# nginx.conf is baked into the image (only js/ is bind-mounted). Copy on every
# seed run so the /keycloak-api/ proxy block survives container restarts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if docker cp "$SCRIPT_DIR/../bkm-web/nginx.conf" bkm-web:/etc/nginx/conf.d/default.conf 2>/dev/null; then
  docker exec bkm-web nginx -s reload 2>/dev/null && log "bkm-web nginx patched (Keycloak proxy)" || true
else
  log "bkm-web nginx patch skipped (container not running?)"
fi

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
