#!/usr/bin/env python3
"""Make the Sesotho (and Swahili) translation files load when the app runs from server config.

The app looks a translation file up under the key <bundle>.camelCase, e.g. "strings_st" ->
"stringsSt". In server mode that key is the label (focus.identifier.value) of the Composition
section that points at the translation Binary. The servers label them "strings_st" /
"strings_sw", so the lookup finds nothing and the app silently shows English.

This script relabels each "Translation ..." section with the camelCase of its label
("strings_st" -> "stringsSt"). The English file ("strings") is unchanged.

  python3 patch_translation_keys.py              # dry run: backup + show what would change
  python3 patch_translation_keys.py --apply      # write the Composition back (new version)

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login.
Undo: PUT the backup file back (path printed).
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request


def camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:] if p)


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


def patch(comp):
    changes = []
    for s in sections(comp.get("section")):
        if not s.get("title", "").lower().startswith("translation"):
            continue
        focus = s.get("focus") or {}
        have = (focus.get("identifier") or {}).get("value")
        if not have or not focus.get("reference", "").startswith("Binary/"):
            continue
        want = camel(have)
        if want != have:
            focus["identifier"] = {"value": want}
            changes.append(f"relabel \"{s['title']}\" {focus['reference']}: \"{have}\" -> \"{want}\"")
        else:
            changes.append(f"ok \"{s['title']}\": label \"{have}\" already fine - skipped")
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
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    bak = os.path.join(a.backup_dir, f"Composition-{comp['id']}.json")
    if not os.path.exists(bak):
        json.dump(comp, open(bak, "w"))
    changes = patch(comp)
    print(f"== Composition/{comp['id']} version={comp['meta'].get('versionId')} backup={bak}")
    for c in changes or ["no translation section found - nothing to do"]:
        print("   " + c)
    if not any(c.startswith("relabel") for c in changes):
        return 0
    if a.apply:
        r = http("PUT", f"{a.fhir}/Composition/{comp['id']}", comp)
        print(f"   WRITTEN - now version {r.get('meta', {}).get('versionId')}")
    else:
        print("   (dry run - add --apply to write)")
    print(f"\nUndo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Composition/{comp['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
