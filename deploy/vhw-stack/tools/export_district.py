#!/usr/bin/env python3
"""Export all VHW app data for one district (default Mafeteng) from HAPI. READ-ONLY on the server.

Records made by the app carry a location tag (https://smartregister.org/location-tag-id) that points to a village
or area. Villages sit under the district in the Location tree, so the script:
  1. reads every Location and finds the district (name contains the district name and 'district'),
  2. collects every Location below it (any depth),
  3. downloads every resource of the listed types whose location tag is one of those Locations,
  4. writes raw FHIR NDJSON per type plus readable CSV files (open in Excel) and a summary.

Output: ./<district>-export-<date>/ (chmod 700) and a .tar.gz of it. It holds REAL PERSONAL DATA: keep it on an
encrypted disk, share only with people allowed to see it, delete the server copy after downloading.

  python3 export_district.py                                  # Mafeteng, HAPI on localhost:8080
  python3 export_district.py --district Berea
  python3 export_district.py --location-id <uuid>             # use this Location as the top instead of searching
  python3 export_district.py --fhir http://127.0.0.1:18180/fhir   # e.g. preprod on the jump host
  python3 export_district.py --list-only                      # show the district and its areas, export nothing
"""
import argparse, csv, datetime, json, os, re, sys, tarfile, urllib.error, urllib.parse, urllib.request

LOC_SYS = "https://smartregister.org/location-tag-id"
PRAC_SYS = "https://smartregister.org/practitioner-tag-id"
TYPES = ["Patient", "Group", "RelatedPerson", "Encounter", "Observation", "Condition", "Task", "CarePlan",
         "QuestionnaireResponse", "Immunization", "Procedure", "Flag", "List", "Consent", "MedicationRequest",
         "MedicationDispense", "AllergyIntolerance", "EpisodeOfCare", "ServiceRequest", "DetectedIssue"]
TAGS_PER_QUERY = 40

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--fhir", default="http://localhost:8080/fhir")
ap.add_argument("--district", default="Mafeteng")
ap.add_argument("--location-id", help="top Location id (skips the name search)")
ap.add_argument("--out", help="output folder (default ./<district>-export-<date>)")
ap.add_argument("--list-only", action="store_true")
a = ap.parse_args()
BASE = a.fhir.rstrip("/")


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/fhir+json", "Cache-Control": "no-cache"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            if attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise


def local_next(url):
    """HAPI writes its public address into 'next' links; keep only the query and send it to BASE."""
    q = urllib.parse.urlsplit(url).query
    return f"{BASE}?{q}"


def search(rtype, params):
    params = dict(params, _count=500)
    url = f"{BASE}/{rtype}?{urllib.parse.urlencode(params, safe='|,:')}"
    while url:
        b = get(url)
        if b is None:
            return
        for e in b.get("entry", []):
            if e.get("search", {}).get("mode", "match") == "match" and "resource" in e:
                yield e["resource"]
        nxt = [l["url"] for l in b.get("link", []) if l.get("relation") == "next"]
        url = local_next(nxt[0]) if nxt else None


def tag(res, system):
    for t in res.get("meta", {}).get("tag", []):
        if t.get("system") == system:
            return t.get("code")
    return None


def ref_id(ref):
    return (ref or {}).get("reference", "").split("/")[-1] or ""


def letters(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


# ---- 1. Location tree --------------------------------------------------------------------------------------------
print("Reading Locations ...", flush=True)
locs = {l["id"]: l for l in search("Location", {})}
children = {}
for l in locs.values():
    children.setdefault(ref_id(l.get("partOf")), []).append(l["id"])
print(f"  {len(locs)} Locations")

if a.location_id:
    if a.location_id not in locs:
        sys.exit(f"Location {a.location_id} not found")
    top = locs[a.location_id]
else:
    want = letters(a.district)
    cands = [l for l in locs.values() if letters(l.get("name")).startswith(want) and "district" in l.get("name", "").lower()]
    if not cands:  # fall back: a name starting with the district whose parent does not
        cands = [l for l in locs.values() if letters(l.get("name")).startswith(want)
                 and not letters(locs.get(ref_id(l.get("partOf")), {}).get("name")).startswith(want)]
    if len(cands) != 1:
        print(f"Found {len(cands)} candidate top Locations for '{a.district}':")
        for l in cands:
            print(f"  {l['id']}  {l.get('name')}  (parent: {locs.get(ref_id(l.get('partOf')), {}).get('name')})")
        sys.exit("Re-run with --location-id <id>")
    top = cands[0]

area = []
stack = [top["id"]]
while stack:
    i = stack.pop()
    area.append(i)
    stack.extend(children.get(i, []))
area_set = set(area)


def path(i):
    names, seen = [], set()
    while i in locs and i not in seen and i != top["id"]:
        seen.add(i)
        names.append(locs[i].get("name", ""))
        i = ref_id(locs[i].get("partOf"))
    return " > ".join(reversed(names))


print(f"Top: {top.get('name')} [{top['id']}]  ->  {len(area)} Locations in the area (incl. itself)")
if a.list_only:
    for i in sorted(area, key=path):
        print(f"  {path(i) or top.get('name')}  [{i}]")
    sys.exit(0)

# ---- 2. Download -------------------------------------------------------------------------------------------------
stamp = datetime.date.today().isoformat()
out = a.out or f"{letters(a.district) or 'district'}-export-{stamp}"
os.makedirs(os.path.join(out, "fhir"), exist_ok=True)
os.chmod(out, 0o700)

data = {}
for rtype in TYPES:
    got = {}
    for k in range(0, len(area), TAGS_PER_QUERY):
        chunk = area[k:k + TAGS_PER_QUERY]
        for r in search(rtype, {"_tag": ",".join(f"{LOC_SYS}|{i}" for i in chunk)}):
            got[r["id"]] = r
    data[rtype] = list(got.values())
    print(f"  {rtype:24} {len(got)}", flush=True)

# Locations of the area, and the practitioners named in the records' tags
data["Location"] = [locs[i] for i in area]
prac_ids = sorted({tag(r, PRAC_SYS) for rs in data.values() for r in rs if tag(r, PRAC_SYS)})
pracs = {}
for k in range(0, len(prac_ids), 50):
    for r in search("Practitioner", {"_id": ",".join(prac_ids[k:k + 50])}):
        pracs[r["id"]] = r
data["Practitioner"] = list(pracs.values())
print(f"  {'Location':24} {len(data['Location'])}\n  {'Practitioner':24} {len(pracs)}")

for rtype, rs in data.items():
    if rs:
        with open(os.path.join(out, "fhir", f"{rtype}.ndjson"), "w", encoding="utf-8") as f:
            for r in rs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

# ---- 3. Readable CSV ---------------------------------------------------------------------------------------------
pat_name, pat_hh = {}, {}


def hname(n):
    n = (n or [{}])[0]
    return " ".join(n.get("given", []) + [n.get("family", "")]).strip() or n.get("text", "")


def ident(r):
    return "; ".join(i.get("value", "") for i in r.get("identifier", []) if i.get("value"))


def code_text(cc):
    cc = cc or {}
    return cc.get("text") or "; ".join(c.get("display") or c.get("code", "") for c in cc.get("coding", []))


def village(r):
    i = tag(r, LOC_SYS)
    return locs.get(i, {}).get("name", i or "")


def vhw(r):
    i = tag(r, PRAC_SYS)
    return hname(pracs[i].get("name")) if i in pracs else (i or "")


for g in data["Group"]:
    for m in g.get("member", []):
        pat_hh[ref_id(m.get("entity"))] = g.get("name", "")
for p in data["Patient"]:
    pat_name[p["id"]] = hname(p.get("name"))

sheets = {
    "households": (["id", "name", "identifier", "active", "members", "village", "area_path", "vhw", "last_updated"],
                   [[g["id"], g.get("name", ""), ident(g), g.get("active"), len(g.get("member", [])), village(g),
                     path(tag(g, LOC_SYS)), vhw(g), g.get("meta", {}).get("lastUpdated", "")] for g in data["Group"]]),
    "patients": (["id", "name", "identifier", "gender", "birth_date", "active", "deceased", "phone", "household",
                  "village", "area_path", "vhw", "last_updated"],
                 [[p["id"], pat_name[p["id"]], ident(p), p.get("gender", ""), p.get("birthDate", ""), p.get("active"),
                   p.get("deceasedBoolean", p.get("deceasedDateTime", "")),
                   "; ".join(t.get("value", "") for t in p.get("telecom", [])), pat_hh.get(p["id"], ""),
                   village(p), path(tag(p, LOC_SYS)), vhw(p), p.get("meta", {}).get("lastUpdated", "")]
                  for p in data["Patient"]]),
    "encounters": (["id", "date", "type", "reason", "status", "patient_id", "patient", "village", "vhw"],
                   [[e["id"], e.get("period", {}).get("start", ""), "; ".join(code_text(t) for t in e.get("type", [])),
                     "; ".join(code_text(t) for t in e.get("reasonCode", [])), e.get("status", ""),
                     ref_id(e.get("subject")), pat_name.get(ref_id(e.get("subject")), ""), village(e), vhw(e)]
                    for e in data["Encounter"]]),
    "tasks": (["id", "description", "status", "code", "patient_id", "patient", "due_from", "due_to",
               "last_modified", "village", "vhw"],
              [[t["id"], (t.get("description") or "").strip(), t.get("status", ""), code_text(t.get("code")),
                ref_id(t.get("for")), pat_name.get(ref_id(t.get("for")), ""),
                t.get("executionPeriod", {}).get("start", ""), t.get("executionPeriod", {}).get("end", ""),
                t.get("lastModified", ""), village(t), vhw(t)] for t in data["Task"]]),
    "conditions": (["id", "condition", "clinical_status", "recorded", "patient_id", "patient", "village", "vhw"],
                   [[c["id"], code_text(c.get("code")), code_text(c.get("clinicalStatus")),
                     c.get("recordedDate", c.get("onsetDateTime", "")), ref_id(c.get("subject")),
                     pat_name.get(ref_id(c.get("subject")), ""), village(c), vhw(c)] for c in data["Condition"]]),
    "observations": (["id", "date", "code", "value", "patient_id", "patient", "encounter_id", "village", "vhw"],
                     [[o["id"], o.get("effectiveDateTime", o.get("issued", "")), code_text(o.get("code")),
                       next((json.dumps(o[k], ensure_ascii=False) if isinstance(o[k], (dict, list)) else str(o[k])
                             for k in o if k.startswith("value")), ""),
                       ref_id(o.get("subject")), pat_name.get(ref_id(o.get("subject")), ""),
                       ref_id(o.get("encounter")), village(o), vhw(o)] for o in data["Observation"]]),
    "immunizations": (["id", "date", "vaccine", "status", "patient_id", "patient", "village", "vhw"],
                      [[i["id"], i.get("occurrenceDateTime", ""), code_text(i.get("vaccineCode")), i.get("status", ""),
                        ref_id(i.get("patient")), pat_name.get(ref_id(i.get("patient")), ""), village(i), vhw(i)]
                       for i in data["Immunization"]]),
    "forms_submitted": (["id", "authored", "form", "status", "subject", "village", "vhw"],
                        [[q["id"], q.get("authored", ""), q.get("questionnaire", ""), q.get("status", ""),
                          (q.get("subject") or {}).get("reference", ""), village(q), vhw(q)]
                         for q in data["QuestionnaireResponse"]]),
    "areas": (["id", "name", "path", "type"],
              [[i, locs[i].get("name", ""), path(i), "; ".join(code_text(t) for t in locs[i].get("type", []))]
               for i in area]),
}
os.makedirs(os.path.join(out, "csv"), exist_ok=True)
for name, (head, rows) in sheets.items():
    with open(os.path.join(out, "csv", f"{name}.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(sorted(rows, key=lambda r: [str(x) for x in r[1:3]]))

with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
    f.write(f"{top.get('name')} export from {BASE} on {datetime.datetime.now():%Y-%m-%d %H:%M}\n"
            f"Top Location {top['id']}, {len(area)} Locations in the area.\n"
            "Records selected by their location tag (" + LOC_SYS + ").\n"
            "Records without a location tag are not included.\n\n"
            "fhir/<Type>.ndjson = raw FHIR resources, one per line.\n"
            "csv/*.csv          = readable tables (UTF-8, opens in Excel).\n\n"
            "Counts:\n" + "".join(f"  {t:24} {len(rs)}\n" for t, rs in data.items()) +
            "\nCONTAINS PERSONAL HEALTH DATA - handle under MoH data rules.\n")

tgz = f"{out.rstrip('/')}.tar.gz"
with tarfile.open(tgz, "w:gz") as t:
    t.add(out, arcname=os.path.basename(out.rstrip("/")))
os.chmod(tgz, 0o600)
print(f"\nDone: {out}/ and {tgz} ({os.path.getsize(tgz) // 1024} KB)")
