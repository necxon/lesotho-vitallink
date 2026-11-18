#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed_test_env.sh — populate a TEST FHIR server from a LIVE one, without
# copying patient data.
#
# Copies the resources the OpenSRP app needs in order to start: the app
# Composition and its Binary configs, Questionnaires, StructureMaps,
# PlanDefinitions, the Location hierarchy, Organizations, CareTeams,
# Practitioners and PractitionerRoles.
#
# Deliberately does NOT copy: Patient, Group, RelatedPerson, Encounter,
# Observation, Condition, QuestionnaireResponse, Task, CarePlan, Flag.
# Those are generated synthetically instead (--patients N).
#
#   SRC=http://<live-server>:8080/fhir DST=http://<test-server>:8080/fhir \
#     bash seed_test_env.sh --dry-run
#   ... bash seed_test_env.sh --patients 50
#
# Reads from SRC, writes only to DST. Run it from a host that can reach both.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SRC="${SRC:?set SRC to the live FHIR base URL, e.g. http://<live-server>:8080/fhir}"
DST="${DST:?set DST to the TEST FHIR base URL, e.g. http://<test-server>:8080/fhir}"
SRC_TOKEN="${SRC_TOKEN:-}"          # set if SRC sits behind the gateway
DST_TOKEN="${DST_TOKEN:-}"
PAGE="${PAGE:-200}"
PATIENTS=0
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY=1; shift ;;
    --patients) PATIENTS="${2:-0}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Config resources, in dependency order. Organization before Location because
# Location.managingOrganization points at it; Practitioner before
# PractitionerRole for the same reason.
CONFIG_TYPES="Binary Composition Questionnaire StructureMap PlanDefinition Library Organization Location HealthcareService CareTeam Practitioner PractitionerRole OrganizationAffiliation"

log()  { printf '[seed] %s\n' "$*"; }
die()  { printf '[seed] ERROR: %s\n' "$*" >&2; exit 1; }

src_curl() { curl -s --max-time 60 ${SRC_TOKEN:+-H "Authorization: Bearer $SRC_TOKEN"} "$@"; }
dst_curl() { curl -s --max-time 60 ${DST_TOKEN:+-H "Authorization: Bearer $DST_TOKEN"} "$@"; }

command -v python3 >/dev/null || die "python3 required"

log "source      $SRC"
log "destination $DST"
[[ $DRY -eq 1 ]] && log "DRY RUN - nothing will be written"

# ── sanity: both ends alive, destination empty of patients ───────────────────
for u in "$SRC" "$DST"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u/metadata")
  [[ "$code" == "200" ]] || die "$u/metadata returned HTTP $code"
done

dst_patients=$(dst_curl "$DST/Patient?_summary=count" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("total","?"))' 2>/dev/null)
log "destination currently holds $dst_patients Patient resources"
if [[ "$dst_patients" != "0" && $DRY -eq 0 ]]; then
  read -r -p "[seed] destination is not empty. Continue anyway? (yes/no) " ok
  [[ "$ok" == "yes" ]] || exit 1
fi

# ── 1. copy configuration resources ──────────────────────────────────────────
copied_total=0
for t in $CONFIG_TYPES; do
  url="$SRC/$t?_count=$PAGE"
  n=0
  while [[ -n "$url" ]]; do
    bundle=$(src_curl "$url")
    # emit one line per resource: <id><TAB><json>, plus the next page url
    mapfile -t lines < <(printf '%s' "$bundle" | python3 -c '
import sys, json
try:
    b = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in b.get("entry") or []:
    r = e.get("resource") or {}
    if r.get("id"):
        print(r["id"] + "\t" + json.dumps(r, separators=(",", ":")))
nxt = ""
for l in b.get("link") or []:
    if l.get("relation") == "next":
        nxt = l.get("url", "")
print("__NEXT__\t" + nxt)
')
    url=""
    for line in "${lines[@]}"; do
      id="${line%%$'\t'*}"; body="${line#*$'\t'}"
      if [[ "$id" == "__NEXT__" ]]; then url="$body"; continue; fi
      if [[ $DRY -eq 1 ]]; then n=$((n+1)); continue; fi
      code=$(printf '%s' "$body" | dst_curl -o /dev/null -w '%{http_code}' \
               -X PUT -H 'Content-Type: application/fhir+json' \
               --data-binary @- "$DST/$t/$id")
      case "$code" in
        200|201) n=$((n+1)) ;;
        *) printf '[seed]   WARN %s/%s -> HTTP %s\n' "$t" "$id" "$code" ;;
      esac
    done
  done
  [[ $n -gt 0 ]] && log "$(printf '%-24s %s' "$t" "$n")"
  copied_total=$((copied_total+n))
done
log "configuration resources copied: $copied_total"

# ── 2. synthetic patients and households ─────────────────────────────────────
if [[ "$PATIENTS" -gt 0 ]]; then
  log "generating $PATIENTS synthetic patients"

  # anchor them to a real Location and Organization so the register scopes work
  loc=$(src_curl "$SRC/Location?_count=1" \
        | python3 -c 'import sys,json;b=json.load(sys.stdin);e=(b.get("entry") or [{}])[0].get("resource",{});print(e.get("id",""))')
  org=$(src_curl "$SRC/Organization?_count=1" \
        | python3 -c 'import sys,json;b=json.load(sys.stdin);e=(b.get("entry") or [{}])[0].get("resource",{});print(e.get("id",""))')
  log "anchoring to Location/$loc and Organization/$org"

  bundle=$(PATIENTS="$PATIENTS" LOC="$loc" ORG="$org" python3 <<'PY'
import json, os, random, uuid, datetime
n   = int(os.environ["PATIENTS"]); loc = os.environ["LOC"]; org = os.environ["ORG"]
first = ["Thabo","Lineo","Mpho","Palesa","Teboho","Nthabiseng","Karabo","Refiloe","Tumelo","Mamello"]
last  = ["Mokoena","Nthabi","Lerotholi","Molefe","Sekhonyana","Ramotsoari","Letsie","Mahase","Phakoe","Sello"]
entries, today = [], datetime.date.today()
# households of 3-6 members, so the Group:Patient ratio looks realistic
i = 0
while i < n:
    size = min(random.randint(3, 6), n - i)
    gid, members, fam = str(uuid.uuid4()), [], random.choice(last)
    for _ in range(size):
        pid = str(uuid.uuid4())
        dob = today - datetime.timedelta(days=random.randint(365, 365*80))
        entries.append({"request": {"method": "PUT", "url": f"Patient/{pid}"}, "resource": {
            "resourceType": "Patient", "id": pid, "active": True,
            "name": [{"use": "official", "family": fam, "given": [random.choice(first)]}],
            "gender": random.choice(["male", "female"]), "birthDate": dob.isoformat(),
            "managingOrganization": {"reference": f"Organization/{org}"} if org else None,
            "address": [{"use": "home", "type": "physical", "country": "LS"}],
            "meta": {"tag": [{"system": "http://vhw.gov.ls/data-origin", "code": "synthetic"}]},
        }})
        members.append({"entity": {"reference": f"Patient/{pid}"}})
        i += 1
    entries.append({"request": {"method": "PUT", "url": f"Group/{gid}"}, "resource": {
        "resourceType": "Group", "id": gid, "type": "person", "actual": True,
        "name": f"{fam} household", "member": members,
        "characteristic": [{"code": {"coding": [{"code": "hh_village"}], "text": "Synthetic village"},
                            "valueCodeableConcept": {"text": "Synthetic village"}}] if False else [],
        "meta": {"tag": [{"system": "http://vhw.gov.ls/data-origin", "code": "synthetic"}]},
    }})
def strip(o):
    if isinstance(o, dict):  return {k: strip(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):  return [strip(v) for v in o]
    return o
print(json.dumps(strip({"resourceType": "Bundle", "type": "transaction", "entry": entries})))
PY
)
  if [[ $DRY -eq 1 ]]; then
    log "would POST a transaction bundle of $(printf '%s' "$bundle" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["entry"]))') entries"
  else
    code=$(printf '%s' "$bundle" | dst_curl -o /tmp/seed-bundle-response.json -w '%{http_code}' \
             -X POST -H 'Content-Type: application/fhir+json' --data-binary @- "$DST")
    log "transaction bundle -> HTTP $code (response in /tmp/seed-bundle-response.json)"
  fi
fi

# ── 3. report ────────────────────────────────────────────────────────────────
log "destination now holds:"
for t in Patient Group Location Organization Practitioner Questionnaire StructureMap Binary; do
  total=$(dst_curl "$DST/$t?_summary=count" \
          | python3 -c 'import sys,json;print(json.load(sys.stdin).get("total","?"))' 2>/dev/null)
  printf '   %-22s %s\n' "$t" "${total:-?}"
done

log "every generated resource carries meta.tag data-origin=synthetic, so it can"
log "be found and removed with: $DST/Patient?_tag=synthetic"
