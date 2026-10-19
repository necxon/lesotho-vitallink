#!/usr/bin/env python3
"""Load the missing "Diseases Registration Form" (the "Register with Disease" button).

The app opens Questionnaire f7004382-ba3d-4f62-a687-6e9d18c09d3a but it was never loaded on the
servers ("Questionnaire not found"). The StructureMap that turns the answers into Conditions
already exists (BKM Disease Registration, ef19b62e-...), so the form is one multiple-choice
question whose answer codes must match that map. A ticked disease creates a Condition, which
puts the person on that disease's list under "Other patients".

  python3 load_disease_registration_form.py              # dry run: checks + shows what would happen
  python3 load_disease_registration_form.py --apply      # create the Questionnaire on HAPI
  python3 load_disease_registration_form.py --dump f.json   # just write the Questionnaire JSON

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Never overwrites an existing form unless --force (then the old one is backed up first).
Sesotho texts are DRAFTS for the MoH to review. Devices pick the form up on their next sync.
Undo: the form was new, so deleting Questionnaire/<id> removes it (ask before doing that).
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

QID = "f7004382-ba3d-4f62-a687-6e9d18c09d3a"
LINKID = "dd55485e-322a-434e-d37d-235e37dd235c"  # the question the StructureMap reads
MAP_ID = "ef19b62e-6cbf-43d6-beb5-4c0d9d2c20b8"
SYSTEM = "https://smartregister.org/CodeSystem/disease-registration"
CHECKS = [f"StructureMap/{MAP_ID}",
          "PlanDefinition/55d89227-3a06-4a9a-b526-2819dcb1d301",
          "PlanDefinition/d6263f2d-2ebe-456c-bbb7-786dabd3ea22"]

# code (must match the StructureMap), English, Sesotho DRAFT
DISEASES = [
    ("hiv", "HIV", "HIV"),
    ("tb", "Tuberculosis (TB)", "Lefuba (TB)"),
    ("mental-health", "Mental health", "Bophelo ba kelello"),
    ("diabetes-mellitus", "Diabetes mellitus", "Lefu la tsoekere"),
    ("cancer", "Cancer", "Kankere"),
    ("asthma", "Asthma", "Asma"),
    ("stroke", "Stroke", "Stroke"),
    ("hypertension", "Hypertension", "Khatello e phahameng ea madi"),
    ("epilepsy", "Epilepsy", "Lefu la ho wa (epilepsy)"),
    ("paralysis", "Paralysis", "Ho holofala"),
    ("liver-disease", "Liver disease", "Lefu la sebete"),
    ("goitre", "Goitre", "Goitre"),
    ("kidney-disease", "Kidney disease", "Lefu la liphio"),
    ("leprosy", "Leprosy", "Lepera"),
]


def st(text):
    return {"extension": [{"url": "http://hl7.org/fhir/StructureDefinition/translation", "extension": [
        {"url": "lang", "valueCode": "st"}, {"url": "content", "valueString": text}]}]}


def build_form():
    return {
        "resourceType": "Questionnaire",
        "id": QID,
        "language": "en",
        "extension": [{"url": "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-targetStructureMap",
                       "valueCanonical": f"https://fhir.labs.smartregister.org/fhir/StructureMap/{MAP_ID}"}],
        "version": "0.0.1",
        "name": "DiseasesRegistrationForm",
        "title": "Diseases Registration Form",
        "status": "active",
        "subjectType": ["Patient"],
        "date": "2026-10-18T00:00:00Z",
        "publisher": "BKM",
        "description": "Register a person with one or more long-term diseases",
        "item": [{
            "linkId": LINKID,
            "type": "choice",
            "repeats": True,
            "required": True,
            "text": "Which diseases does this person have?",
            "_text": st("Ke mafu afe ao motho enoa a nang le ona?"),
            "extension": [{"url": "http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl",
                           "valueCodeableConcept": {"coding": [{
                               "system": "http://hl7.org/fhir/ValueSet/questionnaire-item-control",
                               "code": "check-box", "display": "Check-box"}]}}],
            "answerOption": [{"valueCoding": {"system": SYSTEM, "code": c, "display": e, "_display": st(s)}}
                             for c, e, s in DISEASES],
        }],
    }


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def status(fhir, ref):
    try:
        return urllib.request.urlopen(f"{fhir}/{ref}", timeout=20).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa: BLE001
        return str(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true", help="replace an existing form (backs it up first)")
    ap.add_argument("--dump", metavar="FILE", help="write the Questionnaire JSON to FILE and stop")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    form = build_form()
    if a.dump:
        json.dump(form, open(a.dump, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        print("written", a.dump)
        return 0
    print(f"Questionnaire/{QID}  \"{form['title']}\"  {len(form['item'][0]['answerOption'])} diseases")
    print("checks on this server:")
    for ref in CHECKS:
        code = status(a.fhir, ref)
        note = "" if code == 200 else "   <-- MISSING" if code == 404 else ""
        print(f"   {ref}: HTTP {code}{note}")
    if status(a.fhir, f"StructureMap/{MAP_ID}") == 404:
        print("The StructureMap is missing on this server: the form would save but create no Conditions. NOT loading.")
        return 1
    existing = status(a.fhir, f"Questionnaire/{QID}")
    if existing == 200 and not a.force:
        print(f"Questionnaire/{QID} already exists - nothing to do (use --force to replace; it is backed up first).")
        return 0
    if existing == 200:
        os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
        bak = os.path.join(a.backup_dir, f"Questionnaire-{QID}.json")
        json.dump(http("GET", f"{a.fhir}/Questionnaire/{QID}"), open(bak, "w"))
        print("existing form backed up to", bak)
    if not a.apply:
        print("Dry run - add --apply to create the form.")
        return 0
    r = http("PUT", f"{a.fhir}/Questionnaire/{QID}", form)
    print(f"WRITTEN - Questionnaire/{r.get('id')} version {r.get('meta', {}).get('versionId')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
