#!/usr/bin/env python3
"""ONE script for production (.146): everything for the Record Disease FollowUp and Register EBS Signal buttons.

  1. loads the 2 StructureMaps and the 2 forms (follow-up + EBS signal) if they are not there yet
  2. makes the "Register EBS Signal" menu button tell the form which household it is for

  python3 rollout_followup_ebs.py              # dry run: shows what would change, writes nothing
  python3 rollout_followup_ebs.py --apply      # do it

Safe to run twice (skips what is already done). Backups go to ~/config-backup-<date>.
Refuses to run on the test or preprod machines unless you add --anywhere.
Devices pick up the forms on their next sync; the menu change needs a full username/password sign-in.
Undo: the form resources are new (ask before deleting); the menu change prints its own undo curl.
--- (the two original scripts are included below unchanged, renamed) ---
"""
import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

F_ID = "e14b5743-0a06-4ab5-aaee-ac158d4cb64f"
E_ID = "23a71526-de52-4252-8268-e99185b14e3b"
MAP_ID = "3f6c1a52-8b7d-4e0a-9d4b-7c2e5a91b6d8"
EMAP_ID = "8d2e6b47-1c3f-4a95-b7e0-5f9a3c21d604"  # EBS signal map: same Encounter map, relabelled (gives the signal a record that syncs)
MAP_SHA = "900d1a3d5546247495cfc57b5ea222525028621f7e01b65771681085d734cfa4"
MAP_PACKED = """
H4sIAAAAAAAC/81Y227bMAz9lcLYwwbkst7bvK1phw5bgV62vRRFoNhMrMGWPElOFxT990mybMuxkziZGw95KWiJPIfkkai+OAw4
jZkL3+cROAPnQbDYFTGDGxQ5HQd70nY4OXH30fFB92x86nWP4CPqnntH4+6pewDH6Hx/fOKdybUxC+RiX4iID/r9iY9ZL0Bj3uMh
YoLBFHMBrEfZVH/r25H6NUMQFCqQF19v9i4xB8Rh7zMNAvr8Q4HlqUdn8PhiwZFo/OC0IvIlTDDBAlPSv4uBqz8IwgzuIaKEg3QZ
Uk8FTFLkvHY2dXsREy+wHAnEpiCc16eOM2U0jjRSw8owsggJWZObZCOhRLnBJIqFvel3ETdPgYuknHdLPpd5GX/jFLBxsIIAiwOw
obBRsnmkt3ZS52qFS4mAP2IpXuXOeC4uz+AYk+nSGWIYjfUHCCAEotaasIIhwieUhdLk0mguTRFiEqLsPu19hoIYZLEwmeolQQCu
giRRyF+nzEe6Zxj4P1HKEA8kGoGly3uYAAPiLmIGhQ8JqMb9xVsesbPI7Z3wsdRfPP4lGWp6HceDCIinM5aXThJhyBVXxKUxUfE6
FuDHpU2WVadE6WkhlxUB/uPmzndU1SrZa5sWAlZpI9Z9ZNjnSdi1RlQrzwvVNSbFOXeZLqvhMb0/Fp1ahbYFyWBpa2dtm3dJ0rKr
kzmSd1QzibRB12Cu49rk4liaikdIESkXSMS8HbRZ7A3PR3WVcR+80ulYpOYGiLfELA1dILaGlbm/5ccQExrQ6byX3uVDKeaHuZxV
wv7ssPvJFcpQcbheX1cYfRrCng8oEP6ahDV4SW6YLxPZUqvc5EIkttGqSo7yMjQuainWpZ7a3Qz7HHydXkkjF9gb26YNpMbc8nBb
0RVeMtmNJnq0k1PfiizJtVGA5o0lx3CrkZs88oZHRGkUf32q6n0NqYWam7hvQypimDIs5u1I2YpuD5i5dUd6dpWkG0qBhX5LQace
htsKe8nN8FMvBGHuhdsUaFnwV99qH4Ra8A2nbrgL1V/pZ9MMlggjJ6lQNSn+zRpkO/WvIZc+qdqZ5LLg9UjpJ2PpIVN5mIFMbUvT
dBbbFnJq2/gYu012rhBh4luN5Kyxxkzh1hvHmXi7lz+hz+8/rKixlKfXAusk6ttzXnEaye7h8n89rfR4Elu/Jwp9nmHazXXd4Fmc
Id/xHLamvCPXa4FgSw+J7PcX1DEsb80XAAA=
"""
SYS_YN = "https://smartregister.org/CodeSystem/yes-no"
SYS_DIS = "https://smartregister.org/CodeSystem/disease-registration"
DISEASES = [("hiv", "HIV", "HIV"), ("tb", "Tuberculosis (TB)", "Lefuba (TB)"),
            ("mental-health", "Mental health", "Bophelo ba kelello"),
            ("diabetes-mellitus", "Diabetes mellitus", "Lefu la tsoekere"), ("cancer", "Cancer", "Kankere"),
            ("asthma", "Asthma", "Asma"), ("stroke", "Stroke", "Stroke"),
            ("hypertension", "Hypertension", "Khatello e phahameng ea madi"),
            ("epilepsy", "Epilepsy", "Lefu la ho wa (epilepsy)"), ("paralysis", "Paralysis", "Ho holofala"),
            ("liver-disease", "Liver disease", "Lefu la sebete"), ("goitre", "Goitre", "Goitre"),
            ("kidney-disease", "Kidney disease", "Lefu la liphio"), ("leprosy", "Leprosy", "Lepera")]
YESNO = [("yes", "Yes", "Ee"), ("no", "No", "Che")]


def st(text):
    return {"extension": [{"url": "http://hl7.org/fhir/StructureDefinition/translation", "extension": [
        {"url": "lang", "valueCode": "st"}, {"url": "content", "valueString": text}]}]}


def lid(form, name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"bkm/{form}/{name}"))


def control(code):
    return {"url": "http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl", "valueCodeableConcept": {
        "coding": [{"system": "http://hl7.org/fhir/ValueSet/questionnaire-item-control", "code": code}]}}


def choice(form, name, text, text_st, system, options, required=False, radio=False, repeats=False):
    it = {"linkId": lid(form, name), "type": "choice", "required": required, "text": text, "_text": st(text_st),
          "answerOption": [{"valueCoding": {"system": system, "code": c, "display": e, "_display": st(s)}}
                           for c, e, s in options]}
    if repeats:
        it["repeats"] = True
    if radio:
        it["extension"] = [control("radio-button")]
    return it


def simple(form, name, typ, text, text_st, required=False, today=False):
    it = {"linkId": lid(form, name), "type": typ, "required": required, "text": text, "_text": st(text_st)}
    if today:
        it["extension"] = [{"url": "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-initialExpression",
                            "valueExpression": {"language": "text/fhirpath", "expression": "today()"}}]
    return it


def base(qid, name, title, desc, items, map_id=None, subject=None):
    q = {"resourceType": "Questionnaire", "id": qid, "language": "en", "version": "0.0.1", "name": name,
         "title": title, "status": "active", "date": "2026-10-18T00:00:00Z", "publisher": "BKM",
         "description": desc + " (DRAFT - to be confirmed by the MoH)", "item": items}
    if subject:
        q["subjectType"] = [subject]
    if map_id:
        q["extension"] = [{"url": "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-targetStructureMap",
                           "valueCanonical": f"https://fhir.labs.smartregister.org/fhir/StructureMap/{map_id}"}]
    return q


def followup_form():
    f = "followup"
    symptoms = choice(f, "new-symptoms", "Any new symptoms or danger signs?",
                      "Na ho na le matsoao a macha kapa a kotsi?", SYS_YN, YESNO, radio=True)
    desc = simple(f, "symptoms-description", "string", "Describe the symptoms", "Hlalosa matsoao")
    desc["enableWhen"] = [{"question": lid(f, "new-symptoms"), "operator": "=",
                           "answerCoding": {"system": SYS_YN, "code": "yes"}}]
    meds = [("regularly", "Yes, regularly", "Ee, kamehla"),
            ("sometimes-misses", "Sometimes misses doses", "Ka linako tse ling oa lebala"),
            ("not-taking", "Not taking medication", "Ha a noe meriana"),
            ("none-prescribed", "No medication prescribed", "Ha ho meriana e laetsoeng")]
    items = [
        simple(f, "date", "date", "Date of follow-up visit", "Letsatsi la ketelo ea ho latela", True, today=True),
        choice(f, "disease", "Which disease was followed up?", "Ke lefu lefe leo ho ileng ha latelloa?", SYS_DIS,
               DISEASES, required=True),
        choice(f, "medication", "Is the person taking their medication as prescribed?",
               "Na motho enoa o noa meriana ea hae kamoo a e laetsoeng?",
               "https://smartregister.org/CodeSystem/adherence", meds, required=True),
        simple(f, "systolic", "integer", "Blood pressure - top number (systolic, mmHg)",
               "Khatello ea madi - nomoro ea holimo (systolic, mmHg)"),
        simple(f, "diastolic", "integer", "Blood pressure - bottom number (diastolic, mmHg)",
               "Khatello ea madi - nomoro ea tlase (diastolic, mmHg)"),
        simple(f, "glucose", "decimal", "Blood glucose (mmol/L)", "Tsoekere ea mali (mmol/L)"),
        symptoms, desc,
        choice(f, "referred", "Referred to a health facility?", "Na o rometsoe setsing sa bophelo?", SYS_YN, YESNO,
               radio=True),
        simple(f, "next-visit", "date", "Date of next follow-up visit", "Letsatsi la ketelo e tlang ea ho latela"),
        simple(f, "notes", "text", "Notes", "Lintlha tse ling"),
    ]
    return base(F_ID, "DiseaseFollowUpForm", "Disease FollowUp Form",
                "Follow-up visit for a person with a long-term disease", items, MAP_ID, "Patient")


def ebs_form():
    e = "ebs"
    types = [
        ("illness-cluster", "Several people sick with the same illness", "Batho ba bangata ba kulang ke lefu le le leng"),
        ("unexplained-deaths", "Unexplained deaths in the community", "Lefu le sa hlalosoang sechabeng"),
        ("suspected-outbreak", "Suspected outbreak of a reportable disease (e.g. measles, cholera, anthrax)",
         "Ho belaelloa hore ho qhoma lefu le tlalehuoang (mohlala measles, cholera, anthrax)"),
        ("animal-illness", "Sick or dead animals", "Liphoofolo tse kulang kapa tse shoeleng"),
        ("water-food", "Contaminated water or food", "Metsi kapa lijo tse silafetseng"),
        ("environmental", "Environmental hazard (flood, drought, chemical spill)",
         "Kotsi ea tikoloho (likhohola, komello, ho tsolleha ha lik'hemik'hale)"),
        ("other", "Other", "Tse ling")]
    items = [
        simple(e, "date", "date", "Date the signal was noticed", "Letsatsi leo letsoao le ileng la lemohuoa ka lona",
               True, today=True),
        choice(e, "type", "What kind of signal is it?", "Ke letsoao la mofuta ofe?",
               "https://smartregister.org/CodeSystem/ebs-signal-type", types, required=True),
        simple(e, "place", "string", "Where did it happen? (village / place)", "Ho etsahetse kae? (motse / sebaka)",
               True),
        simple(e, "affected", "integer", "Number of people sick", "Palo ea batho ba kulang"),
        simple(e, "deaths", "integer", "Number of deaths", "Palo ea batho ba shoeleng"),
        simple(e, "description", "text", "Describe what was seen", "Hlalosa seo se bonoeng", True),
        simple(e, "action", "text", "Immediate action taken", "Seo se entsoeng hang-hang"),
        choice(e, "reported", "Already reported to the nearest health facility?",
               "Na e se e tlalehiloe setsing sa bophelo se haufi?", SYS_YN, YESNO, radio=True),
    ]
    return base(E_ID, "EbsSignalRegistration", "EBS Signal Registration",
                "Register an event-based surveillance (EBS) signal noticed in the community", items, EMAP_ID, "Group")


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
        sys.exit(f"cannot reach {fhir} ({e.__class__.__name__}) - wrong server or wrong port? NOTHING done.")


def load_main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true", help="replace existing (backed up first)")
    ap.add_argument("--dump", metavar="DIR", help="write the three JSON files to DIR and stop")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    try:
        raw = gzip.decompress(base64.b64decode("".join(MAP_PACKED.split())))
    except Exception as e:  # noqa: BLE001
        print("the packed map is damaged (copy/paste cut off?):", e)
        return 1
    if hashlib.sha256(raw).hexdigest() != MAP_SHA:
        print("checksum mismatch - the script was damaged when copied. NOTHING loaded.")
        return 1
    smap = json.loads(raw.decode("utf-8"))
    etxt = raw.decode("utf-8")
    for old, new in (("BKM Disease FollowUp", "BKM EBS Signal"), ("Disease FollowUp", "EBS Signal"),
                     ("disease_followup", "ebs_signal"), ("DiseaseFollowUp", "EbsSignal"), (MAP_ID, EMAP_ID)):
        etxt = etxt.replace(old, new)
    emap = json.loads(etxt)
    items = [("StructureMap", MAP_ID, smap), ("StructureMap", EMAP_ID, emap), ("Questionnaire", F_ID, followup_form()),
             ("Questionnaire", E_ID, ebs_form())]
    if a.dump:
        os.makedirs(a.dump, exist_ok=True)
        for t, i, r in items:
            json.dump(r, open(os.path.join(a.dump, f"{t}-{i}.json"), "w", encoding="utf-8"), indent=2,
                      ensure_ascii=False)
        print("written to", a.dump)
        return 0
    print("checksum verified; on this server:")
    for t, i, r in items:
        print(f"   {t}/{i}  \"{r.get('title') or r.get('name')}\"  -> HTTP {status(a.fhir, f'{t}/{i}')}")
    todo = [(t, i, r) for t, i, r in items if status(a.fhir, f"{t}/{i}") != 200 or a.force]
    if not todo:
        print("everything already exists - nothing to do (use --force to replace; old versions are backed up first).")
        return 0
    if not a.apply:
        print(f"Dry run - {len(todo)} to create. Add --apply to create them.")
        return 0
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    for t, i, r in todo:
        if status(a.fhir, f"{t}/{i}") == 200:
            json.dump(http("GET", f"{a.fhir}/{t}/{i}"), open(os.path.join(a.backup_dir, f"{t}-{i}.json"), "w"))
        out = http("PUT", f"{a.fhir}/{t}/{i}", r)
        print(f"WRITTEN {t}/{out.get('id')} version {out.get('meta', {}).get('versionId')}")
    return 0



PS_QID = "23a71526-de52-4252-8268-e99185b14e3b"
PS_SUBJECT = "@{familyLogicalId}"


def ps_http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def ps_sections(secs):
    for s in secs or []:
        yield s
        yield from ps_sections(s.get("section"))


def ps_walk(node, hits):
    if isinstance(node, dict):
        q = node.get("questionnaire")
        if isinstance(q, dict) and q.get("id") == PS_QID:
            hits.append(q)
        for v in node.values():
            ps_walk(v, hits)
    elif isinstance(node, list):
        for v in node:
            ps_walk(v, hits)


def ps_main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    b = ps_http("GET", f"{a.fhir}/Composition?identifier=bkm")
    if b.get("total") != 1:
        print(f"expected exactly one Composition with identifier bkm, found {b.get('total')} - nothing done")
        return 1
    found = 0
    for s in ps_sections(b["entry"][0]["resource"].get("section")):
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        bid = ref.split("/", 1)[1]
        bn = ps_http("GET", f"{a.fhir}/Binary/{bid}")
        try:
            cfg = json.loads(base64.b64decode(bn["data"]).decode("utf-8"))
        except Exception:  # noqa: BLE001 - not a JSON config (translations etc.)
            continue
        hits = []
        ps_walk(cfg, hits)
        if not hits:
            continue
        found += 1
        FLAGS = ("setPractitionerDetails", "setOrganizationDetails")
        todo = [q for q in hits if q.get("resourceIdentifier") != PS_SUBJECT or any(f in q for f in FLAGS)]
        print(f"== Binary/{bid} ({s.get('title')}): {len(hits)} entry, {len(todo)} to change")
        if not todo:
            print("   already set - skipped")
            continue
        for q in todo:
            q["resourceIdentifier"] = PS_SUBJECT
            print(f"   resourceIdentifier -> {PS_SUBJECT}")
            for f in FLAGS:
                if q.pop(f, None) is not None:
                    print(f"   removed {f}")
        os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(bn, open(bak, "w"))
        if a.apply:
            bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode()
            r = ps_http("PUT", f"{a.fhir}/Binary/{bid}", bn)
            print(f"   WRITTEN version {r.get('meta', {}).get('versionId')}   backup={bak}")
            print(f"   Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{bak} {a.fhir}/Binary/{bid}")
    if not found:
        print("EBS menu entry not found in any config - nothing done")
        return 1
    if not a.apply:
        print("Dry run - add --apply to write.")
    return 0



def rollout_main():
    import socket
    host = socket.gethostname()
    if "--anywhere" in sys.argv:
        sys.argv.remove("--anywhere")
    elif "fhir001" not in host:
        print(f"This is {host}. This script is for production (amoh255fhir001). Add --anywhere to run it here anyway.")
        return 1
    print(f"host: {host}")
    print("=== step 1: forms and maps ===")
    rc = load_main()
    if rc:
        print("step 1 failed - step 2 NOT run")
        return rc
    print()
    print("=== step 2: EBS menu button gets the household ===")
    return ps_main()


if __name__ == "__main__":
    sys.exit(rollout_main())
