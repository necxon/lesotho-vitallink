#!/usr/bin/env python3
"""
fingerprint_server_config.py - read-only fingerprint of the BKM app config on a FHIR server.

Run on any host that can reach the HAPI server directly:
    python3 fingerprint_server_config.py                       # default .146
    python3 fingerprint_server_config.py http://host:8080/fhir

Prints one JSON document: every Binary referenced by the "bkm" Composition, whether
it exists on the server, and a content hash, so it can be compared file-for-file
with the config bundled inside the APK. Makes GET requests only.
"""
import base64, hashlib, json, sys, urllib.request, urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://192.0.2.146:8080/fhir").rstrip("/")


def get(path):
    # Without this HAPI returns a Binary as its raw file content, not the FHIR wrapper.
    req = urllib.request.Request(f"{BASE}/{path}", headers={"Accept": "application/fhir+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fingerprint(raw):
    # JSON configs are hashed in canonical form so whitespace and key order don't
    # matter; anything else (translation .properties) is hashed as normalised text.
    try:
        return "json", hashlib.sha256(
            json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:12]
    except ValueError:
        text = "\n".join(l.rstrip() for l in raw.decode("utf-8", "ignore").strip().splitlines())
        return "text", hashlib.sha256(text.encode()).hexdigest()[:12]


comps = get("Composition?identifier=bkm&_count=5").get("entry") or []
if not comps:
    sys.exit("no Composition with identifier=bkm on this server")
comp = comps[0]["resource"]

refs = []
def walk(secs):
    for s in secs or []:
        f = s.get("focus") or {}
        ref = f.get("reference") or ""
        if ref.startswith("Binary/"):
            refs.append(((f.get("identifier") or {}).get("value"), ref.split("/", 1)[1]))
        walk(s.get("section"))
walk(comp.get("section"))

out = {"server": BASE, "composition": comp.get("id"),
       "compositionLastUpdated": (comp.get("meta") or {}).get("lastUpdated"),
       "referenced": len(refs), "configs": []}
for cid, bid in refs:
    row = {"configId": cid, "binaryId": bid}
    try:
        b = get(f"Binary/{bid}")
        kind, h = fingerprint(base64.b64decode(b.get("data", "")))
        row.update(present=True, kind=kind, hash=h,
                   lastUpdated=(b.get("meta") or {}).get("lastUpdated"))
    except urllib.error.HTTPError as e:
        row.update(present=False, error=e.code)
    out["configs"].append(row)

out["present"] = sum(1 for c in out["configs"] if c.get("present"))
print(json.dumps(out, indent=1))
