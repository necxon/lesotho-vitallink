#!/usr/bin/env python3
"""Make the "Past encounters" screen of a person also list their recorded Encounters.

The screen only lists completed Tasks (vaccines and other scheduled visits). The Disease Registration,
Disease FollowUp (and any other form that makes an Encounter) therefore never showed up there.
This adds a second card, "Recorded visits", that lists the person's Encounters (date + type) under the
existing "Past Visits" card. Nothing existing is changed or removed.

  python3 patch_past_encounters.py              # dry run: backup + show what would change
  python3 patch_past_encounters.py --apply      # write the Binary back (new version)

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

CARD_ID = "recordedEncountersList"
REL_ID = "pastEncounters"


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


def encounter_related():
    return {"id": REL_ID, "resource": "Encounter", "searchParameter": "subject",
            "sortConfigs": [{"paramName": "date", "order": "DESCENDING", "dataType": "DATE"}]}


def encounter_card():
    return {
        "viewType": "CARD", "padding": 16,
        "header": {"viewType": "COMPOUND_TEXT", "primaryText": "Recorded visits", "primaryTextColor": "#6F7274",
                   "fontSize": 18.0, "padding": 16},
        "content": [{
            "viewType": "LIST", "id": CARD_ID,
            "resources": [{"id": "pastEncounter", "relatedResourceId": REL_ID, "resourceType": "Encounter"}],
            "emptyList": {"message": "No recorded visits for this patient at the moment"},
            "registerCard": {
                "rules": [
                    {"name": "encounterDate", "condition": "true", "actions": [
                        "data.put('encounterDate', fhirPath.extractValue(pastEncounter, "
                        "'Encounter.period.start.toString().substring(0, 10)'))"]},
                    {"name": "encounterType", "condition": "true", "actions": [
                        "data.put('encounterType', fhirPath.extractValue(pastEncounter, 'Encounter.type.text'))"]},
                ],
                "views": [{
                    "viewType": "ROW", "fillMaxWidth": True, "padding": 16,
                    "children": [
                        {"viewType": "IMAGE", "tint": "#FFFFFF", "size": 28,
                         "imageConfig": {"type": "local", "reference": "ic_check_circled"},
                         "shape": "CIRCLE", "backgroundColor": "PersonalDataBackgroundColor"},
                        {"viewType": "SPACER", "width": 8},
                        {"viewType": "COLUMN", "fillMaxWidth": True, "children": [
                            {"viewType": "COMPOUND_TEXT", "primaryText": "@{encounterDate}",
                             "primaryTextColor": "#6F7274", "fontSize": 14.0},
                            {"viewType": "COMPOUND_TEXT", "primaryText": "@{encounterType}",
                             "primaryTextColor": "#000000", "fontSize": 16.0}]},
                    ]}],
            },
        }],
    }


def patch(cfg):
    changes = []
    related = cfg.setdefault("fhirResource", {}).setdefault("relatedResources", [])
    if any(r.get("id") == REL_ID for r in related):
        changes.append(f"relatedResources '{REL_ID}' already there - skipped")
    else:
        related.append(encounter_related())
        changes.append(f"add relatedResources '{REL_ID}' (Encounter by subject, newest first)")
    views = cfg.setdefault("views", [])
    if any(json.dumps(v).find(CARD_ID) >= 0 for v in views):
        changes.append(f"card '{CARD_ID}' already there - skipped")
    else:
        views.append(encounter_card())
        changes.append("add card 'Recorded visits' under 'Past Visits'")
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
    target = bn = cfg = None
    for s in sections(b["entry"][0]["resource"].get("section")):
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        cand = http("GET", f"{a.fhir}/{ref}")
        try:
            c = json.loads(base64.b64decode(cand["data"]).decode("utf-8"))
        except Exception:  # noqa: BLE001 - not a JSON config (translations etc.)
            continue
        if c.get("id") == "individualPastEncountersProfile" and c.get("configType") == "profile":
            target, bn, cfg = ref.split("/", 1)[1], cand, c
            print(f"found it in section '{s.get('title')}' (label '{(s['focus'].get('identifier') or {}).get('value')}')")
            break
    if not target:
        print("could not find the Past encounters profile (id individualPastEncountersProfile) - nothing done")
        return 1
    cfg = json.loads(base64.b64decode(bn["data"]).decode("utf-8"))
    print(f"== Binary/{target}  version={bn.get('meta', {}).get('versionId')}  id={cfg.get('id')}")
    changes = patch(cfg)
    for c in changes:
        print("   " + c)
    if not any(c.startswith("add") for c in changes):
        print("\nnothing to do - already up to date")
        return 0
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    bak = os.path.join(a.backup_dir, f"Binary-{target}.json")
    if not os.path.exists(bak):
        json.dump(bn, open(bak, "w"))
    if not a.apply:
        print("\nDry run - add --apply to write.")
        return 0
    bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode()
    r = http("PUT", f"{a.fhir}/Binary/{target}", bn)
    print(f"   WRITTEN version {r.get('meta', {}).get('versionId')}   backup={bak}")
    print(f"   Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Binary/{target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
