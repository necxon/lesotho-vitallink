#!/usr/bin/env python3
"""Read-only checks for tester feedback. Makes no changes: every call is an HTTP GET
to HAPI on this server (default http://127.0.0.1:8080/fhir, no login needed there).

  python3 tools/triage_feedback.py locations          # "Location Holder" and the districts
  python3 tools/triage_feedback.py orgs               # organizations and village assignments
  python3 tools/triage_feedback.py child <id|BKM ID|name>  # duplicate vaccines / sync after an age change

Run from the stack folder (/opt/vhw-stack on test and production, ~/vhw-preprod with
--fhir http://127.0.0.1:18180/fhir) so ROOT_LOCATION can be read from .env. Only that
one key is read from .env.
"""
import argparse
import collections
import json
import os
import sys
import urllib.parse
import urllib.request

DISTRICTS = ["Maseru", "Mafeteng", "Leribe", "Berea", "Mohale's Hoek", "Quthing",
             "Qacha's Nek", "Mokhotlong", "Thaba-Tseka", "Butha-Buthe"]
CLOSED = {"cancelled", "entered-in-error", "rejected", "completed", "failed"}


class Fhir:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def get(self, path):
        url = path if path.startswith("http") else f"{self.base}/{path}"
        req = urllib.request.Request(url, headers={"Accept": "application/fhir+json",
                                                   "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    def search(self, path, limit=5000):
        """All resources of a search, following next links on our own base URL
        (HAPI writes its public address into paging links)."""
        out, page = [], self.get(path)
        while True:
            out += [e["resource"] for e in page.get("entry", []) if e.get("search", {}).get("mode", "match") == "match"]
            link = next((l["url"] for l in page.get("link", []) if l["relation"] == "next"), None)
            if not link or len(out) >= limit:
                return out
            i = link.find("/fhir")
            page = self.get(self.base + link[i + 5:] if i >= 0 else link)

    def count(self, path):
        sep = "&" if "?" in path else "?"
        return self.get(f"{path}{sep}_summary=count").get("total", "?")


def env_value(key, path=".env"):
    if not os.path.exists(path):
        return None
    for line in open(path):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return None


def show_location(loc, indent="  "):
    pt = ",".join(c.get("code", "") for c in loc.get("physicalType", {}).get("coding", []))
    types = ",".join(c.get("code", "") for t in loc.get("type", []) for c in t.get("coding", []))
    part = loc.get("partOf", {}).get("reference", "-")
    print(f"{indent}{loc['id']}  \"{loc.get('name', '')}\"  status={loc.get('status', '-')}  "
          f"physicalType={pt or '-'}  type={types or '-'}  partOf={part}")


def cmd_locations(f, args):
    root_id = env_value("ROOT_LOCATION")
    print(f"ROOT_LOCATION in .env: {root_id or '(not found - run from the stack folder)'}")
    print(f"Locations in total: {f.count('Location')}")
    if root_id:
        print("\nroot location (what the portal shows at the top):")
        try:
            root = f.get(f"Location/{root_id}")
            show_location(root)
        except Exception as e:
            print(f"  could not read Location/{root_id}: {e}")
        kids = f.search(f"Location?partof=Location/{root_id}&_count=200")
        print(f"\ndirect children of the root: {len(kids)}")
        for k in sorted(kids, key=lambda x: x.get("name", ""))[:40]:
            show_location(k, "  - ")
    print("\nlocations whose name contains 'Holder':")
    for loc in f.search("Location?name:contains=Holder&_count=50"):
        show_location(loc)
    print("\ndistrict-named locations (and what they hang under):")
    for d in DISTRICTS:
        hits = f.search(f"Location?name:exact={urllib.parse.quote(d)}&_count=20")
        hits += [h for h in f.search(f"Location?name={urllib.parse.quote(d)}&_count=20")
                 if h["id"] not in {x["id"] for x in hits} and "district" in h.get("name", "").lower()]
        if not hits:
            print(f"  {d}: none")
        for h in hits:
            show_location(h, f"  {d}: ")
    print("\nlocations without a parent (tops of trees):")
    tops = [l for l in f.search("Location?_count=1000&_elements=id,name,status,partOf,physicalType,type", 20000)
            if not l.get("partOf")]
    for t in tops[:30]:
        show_location(t)
    print(f"  ({len(tops)} in total)")


def cmd_orgs(f, args):
    print(f"Organizations: {f.count('Organization')}   OrganizationAffiliations: "
          f"{f.count('OrganizationAffiliation')}   CareTeams: {f.count('CareTeam')}")
    print("\nnewest organizations:")
    orgs = f.get("Organization?_sort=-_lastUpdated&_count=10").get("entry", [])
    for e in orgs:
        o = e["resource"]
        aff = f.count(f"OrganizationAffiliation?primary-organization=Organization/{o['id']}")
        print(f"  {o['id']}  \"{o.get('name', '')}\"  active={o.get('active')}  "
              f"updated={o['meta'].get('lastUpdated', '')[:19]}  affiliations={aff}")
    print("\nnewest organization-to-location assignments (OrganizationAffiliation):")
    for e in f.get("OrganizationAffiliation?_sort=-_lastUpdated&_count=10").get("entry", []):
        a = e["resource"]
        locs = [l.get("reference") for l in a.get("location", [])]
        print(f"  {a['id']}  org={a.get('organization', {}).get('reference')}  "
              f"locations={locs}  updated={a['meta'].get('lastUpdated', '')[:19]}")


def task_key(t):
    code = ",".join(c.get("code", "") for c in t.get("code", {}).get("coding", []))
    return (t.get("description", "").strip(), code)


def cmd_child(f, args):
    q = args.query
    pats = []
    try:
        pats = [f.get(f"Patient/{q}")]
    except Exception:
        # a BKM ID (identifier, e.g. 917795) first, then part of the name
        pats = f.search(f"Patient?identifier={urllib.parse.quote(q)}&_count=10", 10)             or f.search(f"Patient?name={urllib.parse.quote(q)}&_count=10", 10)
    if not pats:
        sys.exit(f"no Patient with id or name '{q}'")
    for p in pats[:3]:
        name = " ".join(p.get("name", [{}])[0].get("given", []) + [p.get("name", [{}])[0].get("family", "")])
        print(f"\n== Patient/{p['id']}  \"{name.strip()}\"  birthDate={p.get('birthDate')}  "
              f"version={p['meta'].get('versionId')}  updated={p['meta'].get('lastUpdated', '')[:19]}")
        print("birthDate history (newest first) - shows whether the age change reached the server:")
        hist = f.get(f"Patient/{p['id']}/_history?_count=20").get("entry", [])
        for e in hist:
            r = e.get("resource", {})
            print(f"  v{r.get('meta', {}).get('versionId')}  {r.get('meta', {}).get('lastUpdated', '')[:19]}  "
                  f"birthDate={r.get('birthDate')}")
        tasks = f.search(f"Task?subject=Patient/{p['id']}&_count=500")
        print(f"Tasks: {len(tasks)}  by status: "
              f"{dict(collections.Counter(t.get('status') for t in tasks))}")
        groups = collections.defaultdict(list)
        for t in tasks:
            if t.get("status") not in CLOSED:
                groups[task_key(t)].append(t)
        dups = {k: v for k, v in groups.items() if len(v) > 1}
        print(f"open tasks with the same description+code (duplicates): {len(dups)} groups")
        for (desc, code), ts in sorted(dups.items()):
            print(f"  \"{desc}\" [{code}] x{len(ts)}")
            for t in ts:
                print(f"     {t['id']}  {t.get('status')}  start={t.get('executionPeriod', {}).get('start', '')[:10]}  "
                      f"basedOn={[b.get('reference') for b in t.get('basedOn', [])]}  "
                      f"updated={t['meta'].get('lastUpdated', '')[:19]}")
        cps = f.search(f"CarePlan?subject=Patient/{p['id']}&_count=100")
        print(f"CarePlans: {len(cps)}  " + "  ".join(
            f"{c['id']}:{c.get('status')}:{c['meta'].get('lastUpdated', '')[:16]}" for c in cps))
        qrs = f.get(f"QuestionnaireResponse?subject=Patient/{p['id']}&_sort=-_lastUpdated&_count=8").get("entry", [])
        print("newest QuestionnaireResponses:")
        for e in qrs:
            r = e["resource"]
            print(f"  {r['id']}  {r.get('questionnaire', '')}  authored={r.get('authored', '')[:19]}  "
                  f"updated={r['meta'].get('lastUpdated', '')[:19]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("locations")
    sub.add_parser("orgs")
    c = sub.add_parser("child")
    c.add_argument("query", help="Patient id, BKM ID (identifier), or part of the name")
    args = ap.parse_args()
    f = Fhir(args.fhir)
    {"locations": cmd_locations, "orgs": cmd_orgs, "child": cmd_child}[args.cmd](f, args)


if __name__ == "__main__":
    main()
