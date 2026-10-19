#!/usr/bin/env python3
"""Stop "Registration info" edits of a family head from blocking sync.

The member registration StructureMap (febf0030, used both for "Add member" and for the
Registration info edit) gives the extracted Patient a new uuid() and points the Family Head
RelatedPerson at it. On an edit the app then puts the Patient's real id back, but the
RelatedPerson keeps the throwaway id, so HAPI rejects the upload with
"HAPI-1094: Resource Patient/<id> not found, specified in path: RelatedPerson.patient"
and every later sync from that phone fails.

Fix: after each "rule_related_person_reference" (the two places that build the Family Head
RelatedPerson) add a rule that copies the QuestionnaireResponse subject into
RelatedPerson.patient when the subject is already a Patient (an edit). For "Add member" the
subject is empty while the map runs, so new members keep the generated id. (A first attempt
set Patient.id from a string - StructureMapUtilities rejects that, "Unable to convert a
StringType to a Id", and extraction fails; this script removes that rule if present.)

  python3 patch_member_map.py              # dry run: backup + show the change
  python3 patch_member_map.py --apply      # write StructureMap back to HAPI

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request

MAP_ID = "febf0030-262f-443d-95b4-e002d437cfd0"
OLD_RULE = "rule_patient_id_existing"  # first attempt, broke extraction - removed if present
RULE = {
    "name": "rule_related_person_patient_existing",
    "source": [{"context": "src", "element": "subject", "variable": "subj",
                "condition": "reference.startsWith('Patient/')"}],
    "target": [{"context": "relatedPerson", "contextType": "variable", "element": "patient", "transform": "copy",
                "parameter": [{"valueId": "subj"}]}],
}


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def patch(sm):
    changes = []
    for g in sm.get("group", []):
        if g.get("name") == "ExtractPatient":
            n = len(g.get("rule", []))
            g["rule"] = [r for r in g.get("rule", []) if r.get("name") != OLD_RULE]
            if len(g["rule"]) != n:
                changes.append(f"remove {OLD_RULE} (first attempt)")

    def walk(rules):
        for r in rules:
            if r.get("name") == "rule_related_person_creation":
                kids = r.setdefault("rule", [])
                names = [k.get("name") for k in kids]
                if RULE["name"] in names:
                    continue
                if "rule_related_person_reference" not in names:
                    changes.append("ERROR: rule_related_person_reference not found")
                    continue
                kids.insert(names.index("rule_related_person_reference") + 1, json.loads(json.dumps(RULE)))
                changes.append(f"add {RULE['name']} in a rule_related_person_creation")
            walk(r.get("rule", []))
    for g in sm.get("group", []):
        walk(g.get("rule", []))
    return changes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    sm = http("GET", f"{a.fhir}/StructureMap/{MAP_ID}")
    bak = os.path.join(a.backup_dir, f"StructureMap-{MAP_ID}.json")
    if not os.path.exists(bak):
        json.dump(sm, open(bak, "w"))
    changes = patch(sm)
    print(f"== StructureMap/{MAP_ID} \"{sm.get('name')}\" version={sm.get('meta', {}).get('versionId')} backup={bak}")
    for c in changes or ["already patched - nothing to do"]:
        print("   " + c)
    if any(c.startswith("ERROR") for c in changes):
        print("   not written")
        return 1
    if not changes:
        return 0
    if a.apply:
        r = http("PUT", f"{a.fhir}/StructureMap/{MAP_ID}", sm)
        print(f"   WRITTEN - now version {r.get('meta', {}).get('versionId')}")
    else:
        print("   (dry run - add --apply to write)")
    print(f"\nUndo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/StructureMap/{MAP_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
