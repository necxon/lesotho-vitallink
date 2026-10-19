#!/usr/bin/env python3
"""Load the missing StructureMap "BKM Disease Registration" (ef19b62e-6cbf-43d6-beb5-4c0d9d2c20b8).

The "Register with Disease" form needs this map: it turns the ticked diseases into Conditions
(so the person appears in that disease's list under "Other patients") and records an Encounter.
The map is packed inside this script (compressed) and checked by SHA-256 after unpacking, so a
damaged copy/paste is refused rather than loaded.

  python3 load_disease_map.py              # dry run: unpack, verify, check the server
  python3 load_disease_map.py --apply      # create StructureMap/ef19b62e-... on HAPI

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Never overwrites an existing map unless --force (the old one is backed up first).
Undo: the map was new; deleting StructureMap/<id> removes it (ask before doing that).
"""
import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

SHA256 = "be197a06061aadb0b0236bef1d199f037a1cd8797957a20dc1b560cb86de92b0"
PACKED = """
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
"""


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def status(url):
    try:
        return urllib.request.urlopen(url, timeout=20).status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    try:
        raw = gzip.decompress(base64.b64decode("".join(PACKED.split())))
    except Exception as e:  # noqa: BLE001
        print("the packed data is damaged (copy/paste cut off?):", e)
        return 1
    if hashlib.sha256(raw).hexdigest() != SHA256:
        print("checksum mismatch - the script was damaged when copied. NOT loading.")
        return 1
    res = json.loads(raw.decode("utf-8"))
    rid = res["id"]
    print(f"unpacked OK: {res['resourceType']}/{rid} \"{res.get('name')}\"  ({len(res.get('group', []))} groups, checksum verified)")
    code = status(f"{a.fhir}/StructureMap/{rid}")
    print(f"on this server: StructureMap/{rid} -> HTTP {code}")
    if code == 200 and not a.force:
        print("already exists - nothing to do (use --force to replace; it is backed up first).")
        return 0
    if code == 200:
        os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
        bak = os.path.join(a.backup_dir, f"StructureMap-{rid}.json")
        json.dump(http("GET", f"{a.fhir}/StructureMap/{rid}"), open(bak, "w"))
        print("existing map backed up to", bak)
    if not a.apply:
        print("Dry run - add --apply to create it.")
        return 0
    r = http("PUT", f"{a.fhir}/StructureMap/{rid}", res)
    print(f"WRITTEN - StructureMap/{r.get('id')} version {r.get('meta', {}).get('versionId')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
