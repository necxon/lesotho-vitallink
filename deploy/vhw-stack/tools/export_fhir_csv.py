#!/usr/bin/env python3
"""
export_fhir_csv.py - export patients, households, practitioners and locations to CSV.

    python export_fhir_csv.py prod     # http://localhost:18080/fhir  (Termius tunnel "HAPI PROD")
    python export_fhir_csv.py test     # http://localhost:28080/fhir  (Termius tunnel "HAPI TEST")
    python export_fhir_csv.py http://192.0.2.146:8080/fhir   # any HAPI base, e.g. from nec001

Read-only (GET only). Writes <type>-<env>-<date>.csv next to this script.
These files contain personal health data: keep them off shared drives, out of email
and out of git, and delete them when done.
"""
import csv, datetime, json, os, sys, urllib.request

ENVS = {"prod": "http://localhost:18080/fhir", "test": "http://localhost:28080/fhir"}
if len(sys.argv) != 2:
    sys.exit(__doc__)
BASE = ENVS.get(sys.argv[1], sys.argv[1]).rstrip("/")
ENV = sys.argv[1] if sys.argv[1] in ENVS else {
    "192.0.2.146": "prod", "192.0.2.114": "test"}.get(
    sys.argv[1].split("//")[-1].split(":")[0].split("/")[0],
    {"amoh255fhir001": "prod", "amoh255bkmtrn001": "test"}.get(__import__("socket").gethostname(), "server"))
TODAY = datetime.date.today().isoformat()
HERE = os.path.dirname(os.path.abspath(__file__))


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/fhir+json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fetch(query):
    url, out = f"{BASE}/{query}{'&' if '?' in query else '?'}_count=500", []
    while url:
        b = get(url)
        out += [e["resource"] for e in b.get("entry") or [] if "resource" in e]
        nxt = next((l["url"] for l in b.get("link") or [] if l.get("relation") == "next"), None)
        # HAPI builds paging links from its public address; keep using BASE.
        url = BASE + nxt[nxt.index("/fhir") + 5:] if nxt and "/fhir" in nxt else None
        print(f"  {query.split('?')[0]}: {len(out)}", end="\r")
    print()
    return out


def name(r):
    n = (r.get("name") or [{}])[0]
    if isinstance(n, str):
        return n
    return " ".join(n.get("given", []) + [n.get("family", "")]).strip() or n.get("text", "")


def tags(r, system_part):
    return ";".join(t.get("code", "") for t in (r.get("meta") or {}).get("tag", [])
                    if system_part in (t.get("system") or ""))


def write(kind, rows):
    path = os.path.join(HERE, f"{kind}-{ENV}-{TODAY}.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["id"])
        w.writeheader(); w.writerows(rows)
    print(f"wrote {len(rows):6} {kind:14} -> {path}")


get(f"{BASE}/metadata")  # fails fast if the tunnel/base is wrong
print(f"reading {BASE}")

households = fetch("Group?type=person")
member_hh = {}
for g in households:
    for m in g.get("member") or []:
        ref = (m.get("entity") or {}).get("reference", "")
        if ref.startswith("Patient/"):
            member_hh[ref.split("/", 1)[1]] = g.get("name", g["id"])

write("patients", [{
    "id": p["id"], "name": name(p), "sex": p.get("gender", ""), "birth_date": p.get("birthDate", ""),
    "active": p.get("active", ""), "household": member_hh.get(p["id"], ""),
    "location_tag": tags(p, "location-tag"), "team_tag": tags(p, "care-team-tag"),
    "last_updated": (p.get("meta") or {}).get("lastUpdated", "")[:19],
} for p in fetch("Patient")])

write("households", [{
    "id": g["id"], "name": g.get("name", ""), "members": len(g.get("member") or []),
    "active": g.get("active", ""), "location_tag": tags(g, "location-tag"),
    "last_updated": (g.get("meta") or {}).get("lastUpdated", "")[:19],
} for g in households])

write("practitioners", [{
    "id": p["id"], "name": name(p), "active": p.get("active", ""),
    "keycloak_id": next((i.get("value", "") for i in p.get("identifier") or []
                         if i.get("use") == "secondary"), ""),
} for p in fetch("Practitioner")])

locs = fetch("Location")
write("locations", [{
    "id": l["id"], "name": l.get("name", ""),
    "type": ";".join(c.get("code", "") for t in l.get("type") or [] for c in t.get("coding") or []),
    "physical_type": ";".join(c.get("code", "") for c in (l.get("physicalType") or {}).get("coding") or []),
    "parent": (l.get("partOf") or {}).get("reference", "").split("/")[-1],
    "status": l.get("status", ""),
} for l in locs])
print("done - personal health data: keep these files private and delete when finished")
