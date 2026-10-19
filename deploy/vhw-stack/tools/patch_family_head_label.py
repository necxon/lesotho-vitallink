#!/usr/bin/env python3
"""Fix the "Family Head" label on the household member list after "Change family head".

Three problems (seen on the test server, 19 Oct 2026):
 1. The change-head action writes the new head record with the code system
    http://hl7.org/fhir/ValueSet/relatedperson-relationshiptype, but the member list only looks for
    http://snomed.info/sct, so the new head never gets the label.
 2. Every "Registration info" edit of the head adds another head record (Gkh had 5), and a head change only
    touches one of them, so the old head keeps the label.
 3. (info) the change-head action also replaces Group.managingEntity (an Organization) with the head record.

Why the old head keeps the label: the member rows see EVERY head record of the household (a copy-paste
mistake in the list mapping makes the per-member match match everything), and the label goes to the owner of the
FIRST record, which is always the old head. So the label must follow the household's MOST RECENTLY UPDATED head
record, which is the one a head change updates.

This patch, on the household profile (id householdProfile):
 - makes the head lookup match the code in ANY system (so old and new records are found);
 - makes the change-head dialog write the SNOMED system from now on;
 - makes the "family head record" rules pick the most recently updated head record instead of the first one;
 - removes the helper rule groupHeadRef / restores the original label rule if an earlier version of this patch
   had added them (that version could not work: member rows cannot see household-level values).

  python3 patch_family_head_label.py              # dry run: backup + show what would change
  python3 patch_family_head_label.py --apply      # write the Binary back (new version)

Default HAPI http://127.0.0.1:8080/fhir. Safe to run twice. Devices pick it up after a full
username/password login (then close and reopen the app).
Undo: PUT the backup file back (path printed).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.request

SNOMED = "http://snomed.info/sct"
ORIG_ROW_ACTION = ("data.put('getFamilyHeadStatus', 'Patient/' + data.get('patientId') == "
                   "data.get('familyHeadIdRelatedPersonId') ? 'Family Head' : '')")
OLD_PICK = ("data.put('familyHeadIdRelatedPerson', size(householdHeadRelatedPersons) > 0 ? "
            "householdHeadRelatedPersons.get(0) : null)")
SORTED = ("service.sortResources(householdHeadRelatedPersons, 'RelatedPerson.meta.lastUpdated.toString()', "
          "'STRING', 'DESCENDING')")
NEW_PICK = ("data.put('familyHeadIdRelatedPerson', size(householdHeadRelatedPersons) > 0 ? "
            "(" + SORTED + " != null ? " + SORTED + ".get(0) : householdHeadRelatedPersons.get(0)) : null)")


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


def patch(cfg):
    changes = []

    # 1) head lookup: any system
    def walk_rel(rs):
        for r in rs or []:
            if r.get("id") == "householdHeadRelatedPersons":
                for dq in r.get("dataQueries", []):
                    for fc in dq.get("filterCriteria", []):
                        v = fc.get("value", {})
                        if v.get("system"):
                            v.pop("system")
                            changes.append("head lookup now matches code 99990006 in any system")
            walk_rel(r.get("relatedResources"))
    walk_rel((cfg.get("fhirResource") or {}).get("relatedResources"))

    # 2) change-head writes SNOMED
    def walk_me(n):
        if isinstance(n, dict):
            me = n.get("managingEntity")
            if isinstance(me, dict) and isinstance(me.get("relationshipCode"), dict):
                rc = me["relationshipCode"]
                if rc.get("system") != SNOMED:
                    rc["system"] = SNOMED
                    changes.append("change-head dialog now writes the SNOMED system")
            for v in n.values():
                walk_me(v)
        elif isinstance(n, list):
            for v in n:
                walk_me(v)
    walk_me(cfg)

    # 3) pick the most recently updated head record (top-level rule and the member-row rule)
    # 4) undo the earlier version of this patch (groupHeadRef rule, rewritten label rule)
    top = cfg.get("rules", [])
    if any(r.get("name") == "groupHeadRef" for r in top):
        cfg["rules"] = [r for r in top if r.get("name") != "groupHeadRef"]
        changes.append("removed the unused helper rule groupHeadRef")

    def walk_rules(n):
        if isinstance(n, dict):
            acts = n.get("actions")
            if isinstance(acts, list):
                if n.get("name") == "familyHeadIdRelatedPerson" and acts == [OLD_PICK]:
                    n["actions"] = [NEW_PICK]
                    changes.append("rule familyHeadIdRelatedPerson now picks the most recently updated head record")
                if n.get("name") == "getFamilyHeadStatus" and acts != [ORIG_ROW_ACTION]:
                    n["actions"] = [ORIG_ROW_ACTION]
                    changes.append("restored the original label rule getFamilyHeadStatus")
            for v in n.values():
                walk_rules(v)
        elif isinstance(n, list):
            for v in n:
                walk_rules(v)
    walk_rules(cfg)
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
        except Exception:  # noqa: BLE001 - not a JSON config
            continue
        if c.get("id") == "householdProfile" and c.get("configType") == "profile":
            target, bn, cfg = ref.split("/", 1)[1], cand, c
            break
    if not target:
        print("could not find the household profile (id householdProfile) - nothing done")
        return 1
    print(f"== householdProfile  Binary/{target}  version={bn.get('meta', {}).get('versionId')}")
    changes = patch(cfg)
    for c in changes or ["nothing to change - already up to date"]:
        print("   " + c)
    if not changes:
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
