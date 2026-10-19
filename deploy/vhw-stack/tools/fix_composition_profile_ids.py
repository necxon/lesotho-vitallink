#!/usr/bin/env python3
"""
fix_composition_profile_ids.py - correct two section ids in the "bkm" Composition.

The Composition keys two profile configs by a singular id, but the profile files
themselves (their "id") and every button that opens them use the plural:

    individualPastEncounterProfile      -> individualPastEncountersProfile
    individualUpcomingEncounterProfile  -> individualUpcomingEncountersProfile

With app id "bkm" the app looks configs up by the Composition id, so a release
build could not open a patient's past or upcoming encounters until this is fixed.

Changes ONLY those two focus.identifier.value strings. Nothing else:
  - refuses to write if any other part of the Composition would differ
  - checks each target Binary really is the profile with the plural id
  - saves the current Composition to composition_before_fix.json first
  - writes with If-Match, so a concurrent edit makes it fail instead of clobbering
  - reads back and verifies; running it again finds nothing to do

  python3 fix_composition_profile_ids.py              # dry run
  python3 fix_composition_profile_ids.py --apply      # performs the update
  python3 fix_composition_profile_ids.py --apply http://host:8080/fhir

Revert: PUT composition_before_fix.json back to Composition/<id>.
"""
import base64, copy, json, sys, urllib.request, urllib.error

args = [a for a in sys.argv[1:] if not a.startswith("--")]
APPLY = "--apply" in sys.argv
BASE = (args[0] if args else "http://192.0.2.146:8080/fhir").rstrip("/")
BACKUP = "composition_before_fix.json"
RENAMES = {
    "individualPastEncounterProfile": "individualPastEncountersProfile",
    "individualUpcomingEncounterProfile": "individualUpcomingEncountersProfile",
}


def call(method, path, body=None, headers=None):
    h = {"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"}
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/{path}", data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def sections(secs):
    for s in secs or []:
        yield s
        yield from sections(s.get("section"))


def strip_meta(c):
    c = copy.deepcopy(c)
    c.pop("meta", None)
    return c


print(f"server {BASE}   mode {'APPLY' if APPLY else 'DRY RUN'}")

entries = call("GET", "Composition?identifier=bkm&_count=5").get("entry") or []
if len(entries) != 1:
    sys.exit(f"expected exactly one Composition identifier=bkm, found {len(entries)} - stopping")
before = entries[0]["resource"]
cid, ver = before["id"], (before.get("meta") or {}).get("versionId")
print(f"Composition/{cid}  version {ver}  lastUpdated {(before.get('meta') or {}).get('lastUpdated')}")

after = copy.deepcopy(before)
changes = []
for s in sections(after.get("section")):
    ident = (s.get("focus") or {}).get("identifier") or {}
    old = ident.get("value")
    if old in RENAMES:
        new = RENAMES[old]
        ref = s["focus"].get("reference", "")
        if not ref.startswith("Binary/"):
            sys.exit(f"{old}: focus is {ref!r}, not a Binary - stopping")
        b = call("GET", ref)
        content_id = json.loads(base64.b64decode(b.get("data", ""))).get("id")
        if content_id != new:
            sys.exit(f"{ref} has id {content_id!r}, expected {new!r} - stopping")
        ident["value"] = new
        changes.append((old, new, ref))

already = {(s.get("focus") or {}).get("identifier", {}).get("value") for s in sections(before.get("section"))}
if not changes:
    if set(RENAMES.values()) <= already:
        print("nothing to do - both ids are already correct")
        sys.exit(0)
    sys.exit("neither the old nor the new ids were found - stopping")

for old, new, ref in changes:
    print(f"  {old:38} -> {new}   ({ref}, content id matches)")

# Guard: undoing the renames must give back exactly what is on the server now.
check = copy.deepcopy(after)
undo = {v: k for k, v in RENAMES.items()}
for s in sections(check.get("section")):
    ident = (s.get("focus") or {}).get("identifier") or {}
    if ident.get("value") in undo and ident.get("value") not in already:
        ident["value"] = undo[ident["value"]]
if strip_meta(check) != strip_meta(before):
    sys.exit("unexpected difference beyond the two ids - stopping")

if not APPLY:
    print(f"\ndry run: {len(changes)} change(s) would be made. Re-run with --apply.")
    sys.exit(0)

with open(BACKUP, "w") as f:
    json.dump(before, f, indent=1)
print(f"saved current Composition to {BACKUP}")

try:
    call("PUT", f"Composition/{cid}", after, {"If-Match": f'W/"{ver}"'})
except urllib.error.HTTPError as e:
    sys.exit(f"PUT failed: HTTP {e.code} {e.read()[:300]!r} - nothing changed")

got = call("GET", f"Composition/{cid}")
if strip_meta(got) != strip_meta(after):
    sys.exit(f"read-back does not match what was written - inspect, revert with {BACKUP}")
print(f"updated Composition/{cid} to version {got['meta'].get('versionId')} - verified")
