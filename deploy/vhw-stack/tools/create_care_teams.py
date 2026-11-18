#!/usr/bin/env python3
"""Create village care teams (Organization + OrganizationAffiliation + CareTeam) from a CSV. CHECK ONLY unless --apply.

Built exactly like the teams the portal makes (e.g. "Ha Seisa Kolojane HC Care Team"):
  Organization  name "<village> <facility> Org Team", type team, active, identifier official = random uuid
  OrganizationAffiliation  organization -> that Organization, location -> the village Location
  CareTeam      name "... Care Team", active, identifier official = its id,
                participant = the Organization (role SNOMED 394730007), managingOrganization = the Organization
VHWs are added to the teams afterwards by import_users_csv.py.

CSV columns: facility, village, organization, careTeam  (as written by build_import.py: care-teams.csv)
  village empty = the team belongs to the health centre Location itself.

How the village is found: all Locations are read once; the facility Location is found by the pattern for its facility
(FACILITY_PATTERNS below), then the village must be a Location with that name (ignoring case, apostrophes, spaces,
hyphens) BELOW that facility (up to 4 levels down). Villages with the same name elsewhere in the country are ignored.
Existing Organizations, affiliations and CareTeams with the same name are reused, never duplicated.

  python3 create_care_teams.py --csv care-teams.csv                 # check: what exists, what would be created
  python3 create_care_teams.py --csv care-teams.csv --apply         # create the missing ones
  python3 create_care_teams.py --csv care-teams.csv --fhir http://127.0.0.1:18180/fhir   # e.g. preprod
Events go to ~/log/create_care_teams.log; the check writes care-teams-plan.csv next to the input.
"""
import argparse, collections, csv, datetime, difflib, json, os, re, sys, unicodedata, urllib.error, urllib.request, uuid

FACILITY_PATTERNS = {  # sheet facility name -> regex on the health centre Location name (lower case)
    "KOLO SDA HC": r"^kolo (sda )?hc\b",
    "Mt Tabor HC": r"^(mt\.?|mount) tabor",
    "Thaba-Tsoeu HC": r"^thaba[ -]?ts'?oeu",
    "Matelile HC": r"^matelile",
    "Thabana Morena HC": r"^thabana[ -]morena",
    "Motsekuoa HC": r"^motsekuoa hc\b",
    "Masemouse HC": r"^masemouse",
    "Sekameng HC": r"^sekameng",
    "Malealea HC": r"^malea ?lea",
    "Ribaneng HC": r"^ribaneng",
    "St Andrews HC": r"^(st\.?|saint) andrew",
}
VILLAGE_ALIASES = {  # (sheet facility, sheet village) -> village name on the server, checked on preprod 13 Nov 2026
    ("KOLO SDA HC", "Ha Khaphetsi"): "Ha Khapetsi",
    ("KOLO SDA HC", "Ha Mohlalefi"): "Ha Mohlalefi Kolo",
    ("KOLO SDA HC", "Ha Ntsie"): "Ha Ntsie Kolo",
    ("Motsekuoa HC", "Ha Ramosie"): "Ha Ramosiee",
}
VILLAGE_OTHER_HC = {  # (sheet facility, sheet village) -> another health centre to look under. EMPTY on purpose:
    # MoH 13 Nov 2026: similar names under other facilities/districts are different villages; use the spreadsheet as
    # given (village under the sheet's health centre). The 6 earlier entries were moved with --create-missing-villages.
}
NEW_VILLAGES = {  # (sheet facility, sheet village): not in the location list; created as a new village under that
    # health centre (Level 3, like the DHIS2 villages). Agreed 13 Nov 2026. Tell MoH so DHIS2 can add them too.
    ("Malealea HC", "Ha Tohlang"), ("Malealea HC", "Ha Tsoinyane"), ("Malealea HC", "Ts'eanku"),
    ("Sekameng HC", "Ha Thoahlane"),
    ("Thabana Morena HC", "Ha Tjoobe"), ("Thabana Morena HC", "Ha Turupu"), ("Thabana Morena HC", "Helehehle"),
    ("Matelile HC", "Sekiring"), ("Matelile HC", "Ha Ts'oeute"),
    ("Ribaneng HC", "Ha Thaka-Banna"), ("Ribaneng HC", "Kelepeng"), ("Ribaneng HC", "Taboleng"),
    ("Ribaneng HC", "Thaba-Sekoka"),
}
ROLE = {"coding": [{"system": "http://snomed.info/sct", "code": "394730007", "display": "Healthcare related organization"}]}

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--csv", required=True)
ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
ap.add_argument("--apply", action="store_true")
ap.add_argument("--create-missing-villages", action="store_true",
                help="any village not found under its sheet health centre is created there (MoH rule 13 Nov 2026); "
                     "an existing team linked to another village is moved to it")
ap.add_argument("--log-dir", default=os.path.expanduser("~/log"))
a = ap.parse_args()
BASE = a.fhir.rstrip("/")
os.makedirs(a.log_dir, exist_ok=True)


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(os.path.join(a.log_dir, "create_care_teams.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


def http(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def all_of(rtype, elements):
    url, out = f"{BASE}/{rtype}?_count=1000&_elements={elements}", []
    while url:
        st, b = http("GET", url)
        if st != 200:
            sys.exit(f"GET {rtype} failed: HTTP {st}")
        out += [e["resource"] for e in b.get("entry", []) if "resource" in e]
        nxt = [l["url"] for l in b.get("link", []) if l.get("relation") == "next"]
        url = f"{BASE}?{nxt[0].split('?', 1)[1]}" if nxt else None
    return out


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower()).encode("ascii", "ignore").decode()
    return " ".join(re.sub(r"['’`]", "", s).replace("-", " ").split())


rid = lambda ref: ((ref or {}).get("reference") or "").split("/")[-1]

rows = list(csv.DictReader(open(a.csv, encoding="utf-8")))
log(f"START {'APPLY' if a.apply else 'check'}: {len(rows)} care teams from {a.csv} -> {BASE}")

locs = {l["id"]: l for l in all_of("Location", "name,partOf,status")}
kids = collections.defaultdict(list)
for l in locs.values():
    kids[rid(l.get("partOf"))].append(l["id"])
orgs = all_of("Organization", "name,active")
teams = all_of("CareTeam", "name,status,managingOrganization")
affs = all_of("OrganizationAffiliation", "organization,location,active")
org_by_name = collections.defaultdict(list)
for o in orgs:
    org_by_name[o.get("name", "").strip()].append(o["id"])
team_by_name = collections.defaultdict(list)
for t in teams:
    team_by_name[t.get("name", "").strip()].append(t["id"])
aff_pairs = {(rid(x.get("organization")), rid(l)) for x in affs for l in x.get("location", [])}
log(f"server: {len(locs)} Locations, {len(orgs)} Organizations, {len(teams)} CareTeams, {len(affs)} affiliations")


def below(root, depth=4):
    out, frontier = [], [root]
    for _ in range(depth):
        frontier = [k for f in frontier for k in kids.get(f, [])]
        out += frontier
    return out


facility_loc = {}
for fac, pat in FACILITY_PATTERNS.items():
    hits = [l for l in locs.values() if re.search(pat, norm(l.get("name")))]
    facility_loc[fac] = hits
    log(f"facility {fac!r}: " + (", ".join(f"{h['name']} [{h['id']}]" for h in hits) or "NOT FOUND"))

def path(i):
    names = []
    while i in locs and len(names) < 4:
        names.append(locs[i].get("name", "?"))
        i = rid(locs[i].get("partOf"))
    return " < ".join(names)


def hint(village, fl):
    """Why a village was not found: similar names under the facility, and the same name elsewhere."""
    under = {}
    for h in fl:
        for i in below(h["id"], 6):
            under.setdefault(norm(locs[i].get("name")), locs[i].get("name"))
    close = difflib.get_close_matches(norm(village), list(under), n=3, cutoff=0.75)
    out = ""
    if close:
        out += "; similar under the facility: " + ", ".join(repr(under[c]) for c in close)
    elsewhere = [i for i in locs if norm(locs[i].get("name")) == norm(village)][:3]
    if elsewhere:
        out += "; same name elsewhere: " + " | ".join(path(i) for i in elsewhere)
    return out or "; not found anywhere"


plan, problems, new_villages = [], [], []
for r in rows:
    fac, village, org_name, team_name = r["facility"], r["village"].strip(), r["organization"].strip(), r["careTeam"].strip()
    other_hc = VILLAGE_OTHER_HC.get((fac, village))
    village = VILLAGE_ALIASES.get((fac, village), village)
    fl = facility_loc.get(fac) or []
    if other_hc:  # look for the village under that other health centre instead
        fl = [l for l in locs.values() if norm(l.get("name")) == norm(other_hc)]
    if not fl:
        problems.append((team_name, f"facility {fac!r}: no matching health centre Location"))
        continue
    same = [h["id"] for h in fl if norm(h.get("name")) == norm(village)]
    if not village:  # team of the health centre itself: if two Locations match, take the one named "... HC"
        pick = [h["id"] for h in fl] if len(fl) == 1 else [h["id"] for h in fl if re.search(r"\bhc\b", norm(h.get("name")))]
    elif same:
        pick = same
    else:  # village below any of the matching facility Locations
        pick = sorted({i for h in fl for i in below(h["id"]) if norm(locs[i].get("name")) == norm(village)})
    if not pick and village and (a.create_missing_villages or (fac, r["village"].strip()) in NEW_VILLAGES):
        hc = [h for h in fl if len(fl) == 1 or re.search(r"\bhc\b", norm(h.get("name")))]
        if len(hc) == 1:  # new village; later rows for the same village find it through locs/kids like any other
            vid = str(uuid.uuid4())
            vname = " ".join(w[:1].upper() + w[1:] if w.islower() else w for w in village.split())  # "Ha molise"
            locs[vid] = {"id": vid, "name": vname, "partOf": {"reference": f"Location/{hc[0]['id']}"}, "_new": True}
            kids[hc[0]["id"]].append(vid)
            new_villages.append((vname, vid, hc[0]))
            pick = [vid]
    if len(pick) != 1:
        problems.append((team_name, f"village {village!r} under {' / '.join(h['name'] for h in fl)}: {len(pick)} matches"
                                    + (hint(village, fl) if not pick else "")))
        continue
    loc_id = pick[0]
    org_ids, team_ids = org_by_name.get(org_name, []), team_by_name.get(team_name, [])
    if len(org_ids) > 1 or len(team_ids) > 1:
        problems.append((team_name, f"name used more than once on the server (org {len(org_ids)}, team {len(team_ids)})"))
        continue
    plan.append({"facility": fac, "village": village or locs[loc_id].get("name"), "location": loc_id,
                 "location_name": locs[loc_id].get("name"), "org": org_name,
                 "org_id": org_ids[0] if org_ids else None, "team": team_name,
                 "team_id": team_ids[0] if team_ids else None})

aff_by_org = collections.defaultdict(list)  # existing org id -> [(affiliation id, {location ids})]
for x in affs:
    aff_by_org[rid(x.get("organization"))].append((x["id"], {rid(l) for l in x.get("location", [])}))
want_by_org = collections.defaultdict(set)
for p in plan:
    if p["org_id"]:
        want_by_org[p["org_id"]].add(p["location"])


def move_of(org_id):
    """An existing org whose only affiliation points elsewhere: (affiliation id, new location) to move it, else None."""
    want, have = want_by_org.get(org_id, set()), aff_by_org.get(org_id, [])
    if len(want) == 1 and len(have) == 1 and not (have[0][1] & want):
        return have[0][0], next(iter(want))
    return None


moves = {o: move_of(o) for o in want_by_org if move_of(o)}
new_orgs = {p["org"] for p in plan if not p["org_id"]}
new_affs = {(p["org"], p["location"]) for p in plan
            if not p["org_id"] or ((p["org_id"], p["location"]) not in aff_pairs and p["org_id"] not in moves)}
for o, (aid, loc) in moves.items():
    old = next(iter(dict(aff_by_org[o])[aid]), "")
    under = lambda i: locs.get(rid(locs.get(i, {}).get("partOf")), {}).get("name", "?")
    log(f"  move team village: {next(p['org'] for p in plan if p['org_id'] == o)}: "
        f"{locs.get(old, {}).get('name', old)} ({under(old)}) -> {locs[loc].get('name')} ({under(loc)})")
new_teams = [p for p in plan if not p["team_id"]]
for vname, vid, hc in new_villages:
    log(f"  new village {vname!r} under {hc.get('name')}")
log(f"plan: {len(plan)} teams resolved, {len(new_villages)} new villages, {len(problems)} problems; would create {len(new_orgs)} Organizations, "
    f"{len(new_affs)} affiliations, {len(new_teams)} CareTeams ({len(plan) - len(new_teams)} teams exist already); "
    f"would move {len(moves)} affiliations")
for t, why in problems:
    log(f"  PROBLEM {t}: {why}")

out_plan = os.path.join(os.path.dirname(os.path.abspath(a.csv)), "care-teams-plan.csv")
with open(out_plan, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["facility", "careTeam", "status", "village", "location_id", "organization", "org_id", "team_id"])
    for p in plan:
        w.writerow([p["facility"], p["team"], ("exists" if p["team_id"] else "create")
                    + (" (new village)" if locs[p["location"]].get("_new") else ""), p["location_name"],
                    p["location"], p["org"], p["org_id"] or "(new)", p["team_id"] or "(new)"])
    for t, why in problems:
        w.writerow(["", t, "PROBLEM: " + why, "", "", "", "", ""])
log(f"plan written to {out_plan}")

if not a.apply:
    log("Check only, nothing written. Fix the PROBLEM rows (or leave them out), then run with --apply.")
    sys.exit(0)

# ---- apply: new villages first (one transaction; stop if it fails) ----------------------------------------------
if new_villages:
    def cc(system, code, display):
        return {"coding": [{"system": system, "code": code, "display": display}], "text": display}
    JDN = cc("http://terminology.hl7.org/CodeSystem/location-physical-type", "jdn", "jurisdiction")
    entries = [{"resource": {"resourceType": "Location", "id": vid, "identifier": [{"use": "official", "value": vid}],
                             "status": "active", "name": vname,
                             "type": [cc("http://terminology.hl7.org/CodeSystem/location-type", "jurisdiction", "jurisdiction"),
                                      cc("https://smartregister.org/codes/administrative-level", "3", "Level 3"), JDN],
                             "physicalType": JDN,
                             "partOf": {"reference": f"Location/{hc['id']}", "display": hc.get("name")}},
                "request": {"method": "PUT", "url": f"Location/{vid}"}} for vname, vid, hc in new_villages]
    st, b = http("POST", BASE, {"resourceType": "Bundle", "type": "transaction", "entry": entries})
    if st != 200:
        diag = (b.get("issue") or [{}])[0].get("diagnostics", "")[:300] if isinstance(b, dict) else ""
        log(f"FAILED creating {len(entries)} new villages: HTTP {st} {diag} - nothing else written")
        sys.exit(1)
    for vname, vid, hc in new_villages:
        log(f"  OK  new village {vname!r} [{vid}] under {hc.get('name')}")

# ---- apply: one transaction per organization (org + its affiliation(s) + its missing care teams) ----------------
by_org = collections.defaultdict(list)
for p in plan:
    by_org[p["org"]].append(p)
created = failed = 0
for org_name, ps in by_org.items():
    org_id = ps[0]["org_id"] or str(uuid.uuid4())
    entries = []
    if not ps[0]["org_id"]:
        entries.append({"resource": {"resourceType": "Organization", "id": org_id, "active": True, "name": org_name,
                                     "identifier": [{"use": "official", "value": str(uuid.uuid4())}],
                                     "type": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/organization-type",
                                                           "code": "team"}]}]},
                        "request": {"method": "PUT", "url": f"Organization/{org_id}"}})
    if ps[0]["org_id"] in moves:  # repoint the org's one affiliation to the right village (full resource, PUT)
        aid, loc = moves[org_id]
        st, cur = http("GET", f"{BASE}/OrganizationAffiliation/{aid}")
        if st != 200:
            failed += 1
            log(f"  FAILED {org_name}: cannot read OrganizationAffiliation/{aid}: HTTP {st}")
            continue
        cur.pop("meta", None)
        cur["location"] = [{"reference": f"Location/{loc}", "display": locs[loc].get("name")}]
        entries.append({"resource": cur, "request": {"method": "PUT", "url": f"OrganizationAffiliation/{aid}"}})
    for loc in sorted({p["location"] for p in ps}):
        if ps[0]["org_id"] and ((org_id, loc) in aff_pairs or org_id in moves):
            continue
        aid = str(uuid.uuid4())
        entries.append({"resource": {"resourceType": "OrganizationAffiliation", "id": aid, "active": True,
                                     "identifier": [{"use": "official", "value": str(uuid.uuid4())}],
                                     "organization": {"reference": f"Organization/{org_id}", "display": org_name},
                                     "location": [{"reference": f"Location/{loc}", "display": locs[loc].get("name")}]},
                        "request": {"method": "PUT", "url": f"OrganizationAffiliation/{aid}"}})
    for p in ps:
        if p["team_id"]:
            continue
        tid = str(uuid.uuid4())
        org_ref = {"reference": f"Organization/{org_id}", "display": org_name}
        entries.append({"resource": {"resourceType": "CareTeam", "id": tid, "status": "active", "name": p["team"],
                                     "identifier": [{"use": "official", "value": tid}],
                                     "participant": [{"role": [ROLE], "member": org_ref}],
                                     "managingOrganization": [org_ref]},
                        "request": {"method": "PUT", "url": f"CareTeam/{tid}"}})
    if not entries:
        continue
    st, b = http("POST", BASE, {"resourceType": "Bundle", "type": "transaction", "entry": entries})
    if st == 200:
        created += len(entries)
        log(f"  OK  {org_name}: {len(entries)} resources")
    else:
        failed += 1
        diag = (b.get("issue") or [{}])[0].get("diagnostics", "")[:300] if isinstance(b, dict) else ""
        log(f"  FAILED {org_name}: HTTP {st} {diag}")
log(f"DONE: {created} resources created, {failed} organizations failed")
sys.exit(1 if failed else 0)
