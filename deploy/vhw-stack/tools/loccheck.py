#!/usr/bin/env python3
"""Read-only check of the Location tree in HAPI: roots, missing parents, cycles, depth, inactive ones.

  python3 loccheck.py [http://127.0.0.1:8080/fhir]
"""
import json
import sys
import urllib.request as u

F = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/fhir"
locs, url = {}, F + "/Location?_count=500&_elements=name,status,partOf"
while url:
    b = json.load(u.urlopen(u.Request(url, headers={"Accept": "application/fhir+json"}), timeout=120))
    for e in b.get("entry", []):
        r = e["resource"]
        locs[r["id"]] = (r.get("name", "?"), r.get("status"),
                         (r.get("partOf") or {}).get("reference", "").replace("Location/", ""))
    url = next((link["url"] for link in b.get("link", []) if link["relation"] == "next"), None)
print("locations:", len(locs))
roots = [i for i, v in locs.items() if not v[2]]
print("roots (no partOf):", [(i[:8], locs[i][0], locs[i][1]) for i in roots])
missing = [(i[:8], v[0]) for i, v in locs.items() if v[2] and v[2] not in locs]
print("parent missing:", len(missing), missing[:5])
cyc = []
for i in locs:
    seen, c = set(), i
    while c and c in locs and c not in seen:
        seen.add(c)
        c = locs[c][2]
    if c in seen:
        cyc.append((i[:8], locs[i][0]))
print("in a cycle:", len(cyc), cyc[:5])
kids = {}
for i, v in locs.items():
    kids[v[2]] = kids.get(v[2], 0) + 1
print("most children:", sorted(((n, (locs[p][0] if p in locs else p[:8])) for p, n in kids.items()), reverse=True)[:5])


def depth(i):
    d, seen = 0, set()
    while locs.get(i, ("", "", ""))[2] and i not in seen:
        seen.add(i)
        i = locs[i][2]
        d += 1
    return d


print("max depth:", max(depth(i) for i in locs))
inactive = [(i[:8], v[0]) for i, v in locs.items() if v[1] != "active"]
print("not active:", len(inactive), inactive[:8])
