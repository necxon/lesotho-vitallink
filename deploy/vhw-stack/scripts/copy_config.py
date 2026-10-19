#!/usr/bin/env python3
"""
copy_config.py - copy the app's configuration and reference data from one HAPI FHIR
server to another, WITHOUT patient data.

    python3 copy_config.py SRC DST            # dry run: counts what would be copied
    python3 copy_config.py SRC DST --apply    # copies

    e.g. on 192.0.2.114:
    python3 copy_config.py http://192.0.2.146:8080/fhir http://127.0.0.1:8080/fhir --apply

Copies (same ids, PUT): the app config (Composition, Binary), forms and logic
(Questionnaire, StructureMap, PlanDefinition, Library, Measure, List), and the
reference data the app and gateway need to know who a user is and where they
work (Organization, Location, Practitioner, PractitionerRole, CareTeam,
OrganizationAffiliation, HealthcareService).

Group only for commodities (type device) and users (type practitioner).
Never copies patient data: Patient, households (Group type person), RelatedPerson, Encounter, Observation,
Condition, QuestionnaireResponse, Task, CarePlan, Flag, Consent, Immunization, ...

Reads SRC only. Writes DST only. Safe to re-run: PUT with the same id replaces.
"""
import json, sys, time, urllib.request, urllib.error
from urllib.parse import urlsplit

# Group holds households (type person = patient data, never copied) but also the
# commodities (type device) and one Group per user (type practitioner); only those two
# are copied, by explicit query.
TYPES = ["Binary", "Composition", "Library", "Measure", "Questionnaire", "StructureMap",
         "PlanDefinition", "Organization", "Location", "HealthcareService",
         "Practitioner", "PractitionerRole", "CareTeam", "OrganizationAffiliation",
         "Group?type=device", "Group?type=practitioner", "List"]
PATIENT_TYPES = {"Patient", "Group", "RelatedPerson", "Encounter", "Observation", "Condition",
                 "QuestionnaireResponse", "Task", "CarePlan", "Flag", "Consent", "Immunization"}

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if len(args) != 2:
    sys.exit(__doc__)
SRC, DST = (a.rstrip("/") for a in args)
APPLY = "--apply" in sys.argv
HDR = {"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"}
PAGE = 200


def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:300].decode("utf-8", "replace")}


def rebase(link):
    # HAPI builds paging links from its public address (e.g. https://vhw.gov.ls/fhir,
    # behind the login gateway). Keep everything after the base and use SRC instead.
    path = urlsplit(link)
    tail = link[link.index("/fhir") + len("/fhir"):] if "/fhir" in link else "?" + path.query
    return SRC + tail


def fetch_all(rtype):
    sep = "&" if "?" in rtype else "?"
    out, url = [], f"{SRC}/{rtype}{sep}_count={PAGE}"
    while url:
        code, b = req("GET", url)
        if code != 200:
            sys.exit(f"GET {url} -> HTTP {code}: {str(b)[:200]}")
        out += [e["resource"] for e in b.get("entry") or [] if "resource" in e]
        nxt = next((l["url"] for l in b.get("link") or [] if l.get("relation") == "next"), None)
        url = rebase(nxt) if nxt else None
    return out


def issue(b):
    for i in (b.get("issue") or []):
        return (i.get("diagnostics") or "")[:160]
    return str(b)[:160]


assert not PATIENT_TYPES & {t for t in TYPES if "?" not in t}
for base in (SRC, DST):
    code, _ = req("GET", f"{base}/metadata")
    if code != 200:
        sys.exit(f"{base}/metadata -> HTTP {code}")
code, b = req("GET", f"{DST}/Patient?_summary=count")
print(f"source      {SRC}\ndestination {DST}  (currently {b.get('total', '?')} Patients)")
print("mode        " + ("APPLY" if APPLY else "DRY RUN - nothing is written"))
print()

pending, counts = [], {}
for t in TYPES:
    res = fetch_all(t)
    counts[t] = len(res)
    pending += res
    print(f"  {t:24} {len(res):6}")
print(f"  {'total':24} {len(pending):6}")

if not APPLY:
    print("\ndry run: re-run with --apply to copy")
    sys.exit(0)

# Referenced resources must exist first (e.g. a Location's parent). Anything refused
# for that reason is retried in the next pass, until a pass makes no progress.
done, passno, t0 = 0, 0, time.time()
while pending:
    passno += 1
    failed = []
    for r in pending:
        # keep meta.tag / profile / security (OpenSRP scopes sync by tag); drop what
        # the source server generated
        for k in ("versionId", "lastUpdated", "source"):
            (r.get("meta") or {}).pop(k, None)
        code, b = req("PUT", f"{DST}/{r['resourceType']}/{r['id']}", r)
        if code in (200, 201):
            done += 1
        else:
            failed.append((r, code, issue(b)))
    print(f"pass {passno}: {len(pending) - len(failed)} written, {len(failed)} to retry "
          f"({time.time() - t0:.0f}s)")
    if len(failed) == len(pending):
        # Some records reference themselves (a commodity Group lists itself as a member).
        # The source created them first and updated them later; do the same: write a
        # copy without the self-reference, then the full record in the next pass.
        seeded = 0
        for r, _, msg in failed:
            own = f"{r['resourceType']}/{r['id']}"
            if own in msg and r.get("member"):
                stub = dict(r, member=[m for m in r["member"]
                                       if (m.get("entity") or {}).get("reference") != own])
                if not stub["member"]:
                    stub.pop("member")
                seeded += req("PUT", f"{DST}/{own}", stub)[0] in (200, 201)
        if not seeded:
            break
        print(f"         {seeded} self-referencing records created without the self-reference first")
    pending = [r for r, _, _ in failed]

if pending and failed:
    print(f"\n{len(failed)} could not be written:")
    for r, code, msg in failed[:15]:
        print(f"  {r['resourceType']}/{r['id']}  HTTP {code}  {msg}")
    sys.exit(1)
print(f"\ncopied {done} resources")
