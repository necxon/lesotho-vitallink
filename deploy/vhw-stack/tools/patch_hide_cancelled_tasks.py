#!/usr/bin/env python3
"""Stop cancelled Tasks from showing on the person profile and on the household member list.

When a person's age changes from child to adult, the child plans are closed and all their Tasks become
"cancelled" (this works, the server has them cancelled). But three screens list Tasks without looking at the
status, so the old "Child Visit due ..." row and the vaccine button stay on screen:
  - defaultProfile        (person profile: "Routine visits")
  - otherRegistersProfile (person profile of the other registers)
  - householdProfile      (the member rows on the household screen)
This adds a status filter to the Task query of those three: every status EXCEPT cancelled and
entered-in-error (completed visits and failed ones still show as before).

  python3 patch_hide_cancelled_tasks.py              # dry run: backup + show what would change
  python3 patch_hide_cancelled_tasks.py --apply      # write the Binaries back (new versions)

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login (then close and reopen the app).
Undo: PUT the backup files back (paths printed).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.request

PROFILES = ("defaultProfile", "otherRegistersProfile", "householdProfile")
SHOW = ["draft", "requested", "received", "accepted", "rejected", "ready", "in-progress", "on-hold", "failed",
        "completed"]


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


def status_query():
    return {"paramName": "status", "operation": "OR",
            "filterCriteria": [{"dataType": "CODEABLECONCEPT", "value": {"code": c}} for c in SHOW]}


def patch(cfg):
    changes = []

    def walk(rs, path):
        for r in rs or []:
            here = f"{path}/{r.get('id') or r.get('resource')}"
            if r.get("resource") == "Task":
                dq = r.setdefault("dataQueries", [])
                if any(q.get("paramName") == "status" for q in dq):
                    changes.append(f"ok {here}: already filters on status - skipped")
                else:
                    dq.append(status_query())
                    changes.append(f"add status filter (not cancelled) to {here}")
            walk(r.get("relatedResources"), here)

    walk((cfg.get("fhirResource") or {}).get("relatedResources"), "")
    return changes


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
    found = {}
    for s in sections(b["entry"][0]["resource"].get("section")):
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        bn = http("GET", f"{a.fhir}/{ref}")
        try:
            cfg = json.loads(base64.b64decode(bn["data"]).decode("utf-8"))
        except Exception:  # noqa: BLE001 - not a JSON config (translations etc.)
            continue
        if cfg.get("configType") == "profile" and cfg.get("id") in PROFILES and cfg["id"] not in found:
            found[cfg["id"]] = (ref.split("/", 1)[1], bn, cfg)
    missing = [p for p in PROFILES if p not in found]
    if missing:
        print(f"could not find these profiles in the Composition: {missing} - nothing done")
        return 1
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    wrote = False
    for pid in PROFILES:
        bid, bn, cfg = found[pid]
        print(f"== {pid}  Binary/{bid}  version={bn.get('meta', {}).get('versionId')}")
        changes = patch(cfg)
        for c in changes or ["no Task query found in this profile"]:
            print("   " + c)
        if not any(c.startswith("add") for c in changes):
            continue
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(bn, open(bak, "w"))
        if a.apply:
            bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode()
            r = http("PUT", f"{a.fhir}/Binary/{bid}", bn)
            print(f"   WRITTEN version {r.get('meta', {}).get('versionId')}   backup={bak}")
            print(f"   Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Binary/{bid}")
            wrote = True
    if not a.apply:
        print("\nDry run - add --apply to write.")
    elif not wrote:
        print("\nnothing to do - already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
