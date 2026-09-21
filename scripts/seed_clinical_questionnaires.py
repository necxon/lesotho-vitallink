#!/usr/bin/env python3
"""
seed_clinical_questionnaires.py - create placeholder Questionnaires for every
form the app config publishes but that is not on the server.

    python scripts/seed_clinical_questionnaires.py           # show what is missing
    python scripts/seed_clinical_questionnaires.py --apply   # create the stubs

THESE ARE PLACEHOLDERS, NOT CLINICAL FORMS
Each stub is a single display item saying so. The real content for these forms
is not in this repository and is not publicly available - a GitHub code search
for their ids returns only this repo and one opensrp/fhircore documentation
page. They live on the BKM implementer's own FHIR server. Until that content
arrives, these stubs exist to stop the app requesting resources that 404.

Seeding a stub does NOT make a form usable. It makes the config internally
consistent. A health worker who reaches one sees the placeholder text.

WHY THIS EXISTS
scripts/seed.sh used to seed 24 of these (commit 5ee10ab, "seed clinical
questionnaire + StructureMap stubs"). That block was later removed, which is why
the Composition ended up publishing forms that were never uploaded. This script
restores the behaviour, but derives the list from the LIVE Composition instead
of a hardcoded array - so it cannot drift out of step the way the old one did.

WHY status IS draft
The app never reads Questionnaire.status (FHIRCore filters menus on the menu
item's `visible` flag, nothing else), so this changes no behaviour. It is set
to draft because that is what these are, and because it makes them obvious in
the Administrator Portal's Status column next to the real, active forms.

WHY NO targetStructureMap
The old seeder attached extraction StructureMaps to some of these. The maps
those forms reference are themselves missing from the server, so attaching them
would trade one dangling reference for another. A stub has nothing to extract.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_FHIR = "http://127.0.0.1:8079/fhir"
COMPOSITION_IDENTIFIER = "app"

STUB_TEXT = ("[Placeholder] This form has no content yet. The production BKM "
             "definition has not been supplied. Config key: {key}")


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def exists(fhir, resource_type, rid):
    req = urllib.request.Request(f"{fhir}/{resource_type}/{rid}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def put(fhir, resource_type, rid, body):
    req = urllib.request.Request(
        f"{fhir}/{resource_type}/{rid}",
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/fhir+json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def find_missing(fhir):
    """Questionnaires the Composition publishes that are not on the server."""
    bundle = get(f"{fhir}/Composition?identifier={COMPOSITION_IDENTIFIER}&_count=1")
    entries = bundle.get("entry") or []
    if not entries:
        print(f"No Composition with identifier '{COMPOSITION_IDENTIFIER}'.", file=sys.stderr)
        return None
    comp = entries[0]["resource"]

    missing = []
    for section in comp.get("section", []):
        for sub in (section.get("section") or [section]):
            focus = sub.get("focus") or {}
            ref = focus.get("reference") or ""
            if not ref.startswith("Questionnaire/"):
                continue
            rid = ref.split("/")[-1]
            # Config templates carry runtime placeholders like
            # @{taskQuestionnaireId}. They are resolved on the device and are
            # not resources, so they must never be seeded.
            if not rid or rid.startswith("@{"):
                continue
            if exists(fhir, "Questionnaire", rid):
                continue
            missing.append({
                "id": rid,
                "key": (focus.get("identifier") or {}).get("value") or rid,
                "title": sub.get("title") or rid,
            })
    return missing


def build_stub(item, subject_type):
    return {
        "resourceType": "Questionnaire",
        "id": item["id"],
        "status": "draft",
        "title": item["title"],
        "description": "Placeholder seeded by scripts/seed_clinical_questionnaires.py. "
                       "Replace with the production BKM definition.",
        "subjectType": [subject_type],
        "item": [{
            "linkId": "placeholder",
            "text": STUB_TEXT.format(key=item["key"]),
            "type": "display",
        }],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fhir", default=DEFAULT_FHIR)
    ap.add_argument("--apply", action="store_true", help="write the stubs (default: dry run)")
    ap.add_argument("--subject-type", default="Patient",
                    help="subjectType for the stubs (default: Patient)")
    args = ap.parse_args()
    fhir = args.fhir.rstrip("/")

    print(f"Reading the app Composition on {fhir}\n")
    missing = find_missing(fhir)
    if missing is None:
        return 2

    if not missing:
        print("Every questionnaire the app config publishes is already on the server.")
        return 0

    print(f"{len(missing)} published questionnaire(s) are missing:\n")
    for m in missing:
        print(f"  {m['id']}  {m['title']}")
        print(f"  {'':36}  key: {m['key']}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to create placeholders for these.")
        print("Placeholders make the config resolve. They are NOT usable forms.")
        return 0

    print("\nCreating placeholders...")
    created = failed = 0
    for m in missing:
        try:
            status = put(fhir, "Questionnaire", m["id"], build_stub(m, args.subject_type))
            print(f"  HTTP {status}  {m['title']}")
            created += 1
        except Exception as e:
            print(f"  FAILED    {m['title']}: {e}", file=sys.stderr)
            failed += 1

    print(f"\n{created} created, {failed} failed.")

    # Read back rather than trusting the write. A 201 that did not actually
    # land is the failure this is here to catch.
    remaining = find_missing(fhir)
    if remaining:
        print(f"Still missing after the run: {len(remaining)}", file=sys.stderr)
        return 1
    print("Read-back: every published questionnaire now resolves.")
    print("\nThese are placeholders. Replace them with real BKM content when it arrives.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
