#!/usr/bin/env python3
"""Make the "Register EBS Signal" button tell the form which household it is for.

The household profile menu launches EBS Signal Registration (Questionnaire 23a71526-...) without a
subject, so the saved answers have no household and never reached the server. This adds
"resourceIdentifier": "@{familyLogicalId}" to that menu entry in the Binary that holds it, and removes the
setPractitionerDetails / setOrganizationDetails flags that made saving fail on tablets.

  python3 patch_ebs_subject.py              # dry run: backup + show what would change
  python3 patch_ebs_subject.py --apply      # write the Binary back (new version)

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login.
Undo: PUT the backup file back (path printed).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.request

QID = "23a71526-de52-4252-8268-e99185b14e3b"
SUBJECT = "@{familyLogicalId}"


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def sections(secs):
    for s in secs or []:
        yield s
        yield from sections(s.get("section"))


def walk(node, hits):
    if isinstance(node, dict):
        q = node.get("questionnaire")
        if isinstance(q, dict) and q.get("id") == QID:
            hits.append(q)
        for v in node.values():
            walk(v, hits)
    elif isinstance(node, list):
        for v in node:
            walk(v, hits)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    b = http("GET", f"{a.fhir}/Composition?identifier=bkm")
    if b.get("total") != 1:
        print(f"expected exactly one Composition with identifier bkm, found {b.get('total')} - nothing done")
        return 1
    found = 0
    for s in sections(b["entry"][0]["resource"].get("section")):
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        bid = ref.split("/", 1)[1]
        bn = http("GET", f"{a.fhir}/Binary/{bid}")
        try:
            cfg = json.loads(base64.b64decode(bn["data"]).decode("utf-8"))
        except Exception:  # noqa: BLE001 - not a JSON config (translations etc.)
            continue
        hits = []
        walk(cfg, hits)
        if not hits:
            continue
        found += 1
        FLAGS = ("setPractitionerDetails", "setOrganizationDetails")
        todo = [q for q in hits if q.get("resourceIdentifier") != SUBJECT or any(f in q for f in FLAGS)]
        print(f"== Binary/{bid} ({s.get('title')}): {len(hits)} entry, {len(todo)} to change")
        if not todo:
            print("   already set - skipped")
            continue
        for q in todo:
            q["resourceIdentifier"] = SUBJECT
            print(f"   resourceIdentifier -> {SUBJECT}")
            for f in FLAGS:
                if q.pop(f, None) is not None:
                    print(f"   removed {f}")
        os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(bn, open(bak, "w"))
        if a.apply:
            bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode()
            r = http("PUT", f"{a.fhir}/Binary/{bid}", bn)
            print(f"   WRITTEN version {r.get('meta', {}).get('versionId')}   backup={bak}")
            print(f"   Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Binary/{bid}")
    if not found:
        print("EBS menu entry not found in any config - nothing done")
        return 1
    if not a.apply:
        print("Dry run - add --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
