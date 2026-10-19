#!/usr/bin/env python3
"""Close a person's child CarePlans (Child Visit, Child Immunization) when Registration info
is saved with an adult age. Adds a RESOURCE_CLOSURE eventWorkflow to the edit form
(Questionnaire e5155788) in the app's profile-config Binaries on HAPI.

Why: the child plan definitions only have "under 5" conditions, so after an age change to an
adult nothing happened and the person kept the newborn schedule (BCG, OPV 0, Child Visit...).

  python3 patch_child_closure.py                 # dry run: backup + show what would change
  python3 patch_child_closure.py --apply         # write the Binaries back to HAPI

Default HAPI is http://127.0.0.1:8080/fhir (test and production); preprod: --fhir
http://127.0.0.1:18180/fhir. Safe to run twice (skips a Binary that already has it).
Undo: PUT the backup file back (path printed).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.request

EDIT_Q = "e5155788-8831-4916-a3f5-486915ce34b2"
PLANS = {  # plan definition -> (event resource id, close when older than N months)
    "9fac39bd-9750-4c1d-b355-1961de4e37f3": ("childVisitCarePlanToBeClosed", 60),
    "e994ab6f-30a5-4450-9a90-691c8199f379": ("childImmunizationCarePlanToBeClosed", 114),
}
BINARIES = {"default profile": "34b709f3-e8a1-44e9-867a-714b68bb1367e",
            "other registers profile": "a6d69650-4806-4bb1-bd2b-a60fa18418a0e"}


def workflow(plans):
    def resource(plan):
        rid = PLANS[plan][0]
        return {"id": rid, "resource": "CarePlan",
                "configRules": [{"name": "patientId", "condition": "true", "actions": [
                    "data.put('patientId', 'Patient/' + fhirPath.extractValue(Patient, 'Patient.id'))"]}],
                "dataQueries": [
                    {"paramName": "instantiates-canonical",
                     "filterCriteria": [{"dataType": "REFERENCE", "value": f"PlanDefinition/{plan}"}]},
                    {"paramName": "subject",
                     "filterCriteria": [{"dataType": "REFERENCE", "computedRule": "patientId"}]}],
                "relatedResources": [{"resource": "Task", "searchParameter": "based-on"}]}
    return {"eventType": "RESOURCE_CLOSURE",
            "updateValues": [
                {"jsonPathExpression": "CarePlan.status", "value": "completed", "resourceType": "CarePlan"},
                {"jsonPathExpression": "Task.status", "value": "cancelled", "resourceType": "Task"}],
            "resourceFilterExpressions": [
                {"resourceType": "Task", "matchAll": True, "conditionalFhirPathExpressions": [
                    "Task.status != 'completed' and Task.status != 'cancelled'"]}],
            "triggerConditions": [
                {"eventResourceId": PLANS[p][0], "matchAll": False, "conditionalFhirPathExpressions": [
                    f"Patient.birthDate.exists() and Patient.birthDate < (today() - {PLANS[p][1]} 'months')"]}
                for p in plans],
            "eventResources": [resource(p) for p in plans]}


def patch(cfg):
    """Add the closure to every EDIT launch of the registration form. Returns a change list."""
    changes = []

    def walk(o, path):
        if isinstance(o, dict):
            q = o.get("questionnaire")
            if isinstance(q, dict) and q.get("id") == EDIT_Q and q.get("type") == "EDIT":
                plans = [p for p in q.get("planDefinitions") or [] if p in PLANS]
                have = {r.get("id") for w in q.get("eventWorkflows") or [] for r in w.get("eventResources", [])}
                if plans and not have & {PLANS[p][0] for p in plans}:
                    q.setdefault("eventWorkflows", []).append(workflow(plans))
                    changes.append(f"{path}: close {', '.join(PLANS[p][0] for p in plans)}")
                elif plans:
                    changes.append(f"{path}: already has the closure - skipped")
            for k, v in o.items():
                walk(v, f"{path}/{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")
    walk(cfg, "")
    return changes


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    for name, bid in BINARIES.items():
        b = http("GET", f"{a.fhir}/Binary/{bid}")
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(b, open(bak, "w"))
        cfg = json.loads(base64.b64decode(b["data"]).decode("utf-8"))
        changes = patch(cfg)
        print(f"== {name}  Binary/{bid}  version={b.get('meta', {}).get('versionId')}  backup={bak}")
        for c in changes or ["no edit launch of the registration form found - nothing to do"]:
            print("   " + c)
        if not any("close " in c for c in changes):
            continue
        new = json.dumps(cfg, indent=2, ensure_ascii=False)
        json.loads(new)
        if a.apply:
            b["data"] = base64.b64encode(new.encode("utf-8")).decode()
            r = http("PUT", f"{a.fhir}/Binary/{bid}", b)
            print(f"   WRITTEN - now version {r.get('meta', {}).get('versionId')}")
        else:
            print("   (dry run - add --apply to write)")
    print(f"\nUndo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{a.backup_dir}/Binary-<id>.json "
          f"{a.fhir}/Binary/<id>")


if __name__ == "__main__":
    sys.exit(main())
