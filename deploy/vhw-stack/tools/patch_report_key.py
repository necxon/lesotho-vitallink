#!/usr/bin/env python3
"""Fix "Supply Chain Reports" closing the app (crash: "Key supplyChainMeasureReport is missing in
the map").

The app finds a report configuration by the label (focus.identifier.value) of the Composition
section that points at its Binary. On the servers the "Measure reports configuration" section is
labelled "measureReport", but the menu asks for the id written inside the file
("supplyChainMeasureReport"), so the lookup fails and the app crashes. In the APK's bundled mode the
label comes from the file name, which is why only server-config builds crash.

This script relabels each measure-report section with the id found inside its Binary.

  python3 patch_report_key.py                # dry run: backup + show what would change
  python3 patch_report_key.py --apply        # write the Composition back (new version)

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


def patch(comp, fetch_binary):
    """Relabel measure-report sections. fetch_binary(id) -> parsed config JSON or None."""
    changes = []
    for s in sections(comp.get("section")):
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        cfg = fetch_binary(ref.split("/", 1)[1])
        if not cfg or str(cfg.get("configType", "")).lower() != "measurereport":
            continue
        want = cfg.get("id")
        have = (s["focus"].get("identifier") or {}).get("value")
        if not want:
            changes.append(f"ERROR {ref}: config has no id - not changed")
        elif have == want:
            changes.append(f"ok {ref}: already labelled {want} - skipped")
        else:
            s["focus"]["identifier"] = {"value": want}
            changes.append(f"relabel {ref}: \"{have}\" -> \"{want}\"")
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
    comp = b["entry"][0]["resource"]

    def fetch_binary(bid):
        try:
            r = http("GET", f"{a.fhir}/Binary/{bid}")
            return json.loads(base64.b64decode(r["data"]).decode("utf-8"))
        except Exception:
            return None

    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    bak = os.path.join(a.backup_dir, f"Composition-{comp['id']}.json")
    if not os.path.exists(bak):
        json.dump(comp, open(bak, "w"))
    changes = patch(comp, fetch_binary)
    print(f"== Composition/{comp['id']} version={comp['meta'].get('versionId')} backup={bak}")
    for c in changes or ["no measure-report section found - nothing to do"]:
        print("   " + c)
    if any(c.startswith("ERROR") for c in changes) or not any(c.startswith("relabel") for c in changes):
        return 1 if any(c.startswith("ERROR") for c in changes) else 0
    if a.apply:
        r = http("PUT", f"{a.fhir}/Composition/{comp['id']}", comp)
        print(f"   WRITTEN - now version {r.get('meta', {}).get('versionId')}")
    else:
        print("   (dry run - add --apply to write)")
    print(f"\nUndo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Composition/{comp['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
