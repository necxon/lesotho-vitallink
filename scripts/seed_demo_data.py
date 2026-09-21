#!/usr/bin/env python3
"""
seed_demo_data.py - generate synthetic activity so the dashboards and reports
have something to show.

    python scripts/seed_demo_data.py            # show what would be created
    python scripts/seed_demo_data.py --apply
    python scripts/seed_demo_data.py --purge    # remove everything it created

THIS DATA IS FABRICATED
Every resource it writes is synthetic. None of it describes a real person. Two
things make that impossible to miss, and both matter more than the data looking
realistic:

  - every id is prefixed `demo-`, so it is obvious in any list, search or export
  - every resource carries meta.tag `demo-data`, so `--purge` can find and
    remove all of it without touching anything real

Names and villages are plausibly Basotho rather than "Test Patient 1", because a
dashboard full of obvious filler cannot be reviewed for whether the charts group
and sort sensibly. The tag and id prefix are what keep it honest.

WHAT IT CREATES
  Patients               with village, district, gender and birth date, since
                         dim_patient derives age bands and village from those
  MedicationDispense     over the last 90 days, attributed to the real village
                         health workers already on the server
  Group (person)         household catchments assigning patients to a health
                         worker, because rpt_vhw_caseload derives both
                         households and patients from these, not from dispenses
  SupplyDelivery         resupply events into the two clinics
  Observation            stock-on-hand readings per medicine per facility

It links to resources that already exist - practitioners, organizations and the
medicine Groups - rather than inventing its own, so the joins in the analytics
views resolve exactly as they would in production.

Nothing here touches OpenLMIS or DHIS2.
"""
import argparse
import datetime as dt
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FHIR = "http://127.0.0.1:8079/fhir"
TAG_SYSTEM = "http://vitallink.local/tags"
TAG_CODE = "demo-data"

# Fixed so repeated runs produce the same people rather than a new cohort each
# time, which would make the charts jump for no reason.
random.seed(4242)

GIVEN = ["Thabo", "Palesa", "Lerato", "Mpho", "Tsepo", "Nthabiseng", "Katleho",
         "Refiloe", "Teboho", "Lineo", "Bokang", "Realeboha", "Mamello",
         "Relebohile", "Kefuoe", "Tumelo", "Malehloa", "Retselisitsoe"]
FAMILY = ["Mokoena", "Sello", "Letsie", "Mofokeng", "Ramaema", "Thabane",
          "Molapo", "Khoabane", "Maseko", "Lebona", "Nkoe", "Phamotse"]
VILLAGES = [
    ("Ha Mokoena", "Maseru"), ("Ha Sello", "Maseru"), ("Thabana Morena", "Mafeteng"),
    ("Sekameng", "Mafeteng"), ("Tsakholo", "Mafeteng"), ("Matelile", "Mafeteng"),
    ("Malealea", "Mafeteng"), ("Ribaneng", "Mafeteng"), ("Kolo", "Mafeteng"),
    ("Motsekuoa", "Mafeteng"),
]
ORGS = ["Organization/maseru-clinic-a", "Organization/maseru-clinic-b"]
# SupplyDelivery.destination is Reference(Location) in R4 - HAPI rejects an
# Organization there with HAPI-0931. The clinics exist as both, so the delivery
# destination uses the Location and stock readings use the Organization.
DESTINATIONS = ["Location/loc-maseru-clinic-a", "Location/loc-maseru-clinic-b"]

# The practitioners who actually hand medicine to patients. The admin and
# supervisor accounts are deliberately excluded - attributing dispenses to them
# would make the caseload report wrong.
DISPENSERS = [
    ("Practitioner/prac-thabo-mokoena", "Thabo Mokoena"),
    ("Practitioner/prac-vhw-clinic-b", "Palesa Sello"),
    ("Practitioner/prac-fw-clinic-a", "Facility Worker A"),
    ("Practitioner/prac-fw-clinic-b", "Facility Worker B"),
]

DAYS = 90


def get(path):
    with urllib.request.urlopen(f"{FHIR}/{path}", timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def put(rtype, rid, body):
    req = urllib.request.Request(
        f"{FHIR}/{rtype}/{rid}",
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/fhir+json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def delete(rtype, rid):
    req = urllib.request.Request(f"{FHIR}/{rtype}/{rid}", method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def tagged(body):
    body.setdefault("meta", {}).setdefault("tag", []).append(
        {"system": TAG_SYSTEM, "code": TAG_CODE, "display": "Synthetic demo data"}
    )
    return body


def medicines():
    """The medicine Groups already on the server. fact_stock_on_hand joins
    Observation.subject to these, so they must be the real ones."""
    bundle = get("Group?_count=50&_elements=id,name,type")
    out = [
        (e["resource"]["id"], e["resource"].get("name"))
        for e in bundle.get("entry", [])
        if e["resource"].get("type") == "device" and e["resource"].get("name")
    ]
    return out


def build(n_patients, meds):
    today = dt.date.today()
    resources = []

    patients = []
    for i in range(n_patients):
        village, district = VILLAGES[i % len(VILLAGES)]
        given, family = random.choice(GIVEN), random.choice(FAMILY)
        age = random.choice([1, 3, 4, 7, 12, 19, 24, 27, 33, 41, 46, 52, 58, 67, 72])
        rid = f"demo-pat-{i + 1:03d}"
        patients.append(rid)
        resources.append(("Patient", rid, tagged({
            "resourceType": "Patient",
            "id": rid,
            "active": True,
            "name": [{"use": "official", "family": family, "given": [given]}],
            "gender": random.choice(["male", "female"]),
            "birthDate": (today - dt.timedelta(days=age * 365 + random.randint(0, 364))).isoformat(),
            "address": [{"text": village, "district": district, "country": "Lesotho"}],
            "managingOrganization": {"reference": ORGS[i % len(ORGS)]},
        })))

    # Dispensing, weighted so recent days are busier than old ones - a flat
    # random spread produces a trend chart that looks broken.
    seq = 0
    for day_offset in range(DAYS):
        day = today - dt.timedelta(days=day_offset)
        if day.weekday() >= 5:
            continue  # health workers are not in the field at weekends
        recency = 1.0 - (day_offset / (DAYS * 1.6))
        for _ in range(max(0, int(random.gauss(5 * recency, 1.8)))):
            seq += 1
            med_id, med_name = random.choice(meds)
            who, _who_name = random.choice(DISPENSERS)
            rid = f"demo-disp-{seq:05d}"
            when = dt.datetime.combine(day, dt.time(random.randint(8, 16), random.randint(0, 59)))
            resources.append(("MedicationDispense", rid, tagged({
                "resourceType": "MedicationDispense",
                "id": rid,
                "status": "completed",
                "medicationCodeableConcept": {"text": med_name},
                "subject": {"reference": f"Patient/{random.choice(patients)}"},
                "performer": [{"actor": {"reference": who}}],
                "location": {"reference": "Location/loc-maseru-clinic-a"},
                "quantity": {"value": random.choice([1, 1, 2, 3, 5, 10]), "unit": "unit"},
                "whenHandedOver": when.isoformat() + "Z",
            })))

    # Household catchments. Without these, rpt_vhw_caseload shows a worker
    # with 59 dispenses and 0 patients, because it counts patients through
    # Group membership and households through managingEntity - not through
    # dispensing. Assigning patients here is what makes the caseload report
    # internally consistent.
    for idx, (who, who_name) in enumerate(DISPENSERS):
        mine = [p for j, p in enumerate(patients) if j % len(DISPENSERS) == idx]
        if not mine:
            continue
        # Roughly four patients per household, so the household count is not
        # simply the patient count again.
        for hh_no, start in enumerate(range(0, len(mine), 4), start=1):
            members = mine[start:start + 4]
            village = VILLAGES[(idx + hh_no) % len(VILLAGES)][0]
            rid = f"demo-hh-{idx + 1}-{hh_no:02d}"
            resources.append(("Group", rid, tagged({
                "resourceType": "Group",
                "id": rid,
                "type": "person",
                "actual": True,
                "active": True,
                "name": f"{village} household {hh_no} - {who_name} catchment",
                "identifier": [{"value": rid}],
                "managingEntity": {"reference": who},
                "member": [{"entity": {"reference": f"Patient/{m}"}} for m in members],
            })))

    # Resupply into the clinics, roughly weekly.
    seq = 0
    for day_offset in range(0, DAYS, 7):
        day = today - dt.timedelta(days=day_offset)
        for dest in DESTINATIONS:
            for med_id, med_name in random.sample(meds, min(3, len(meds))):
                seq += 1
                rid = f"demo-del-{seq:04d}"
                resources.append(("SupplyDelivery", rid, tagged({
                    "resourceType": "SupplyDelivery",
                    "id": rid,
                    "status": "completed",
                    "suppliedItem": {
                        "itemCodeableConcept": {"text": med_name},
                        "quantity": {"value": random.choice([50, 100, 150, 200]), "unit": "unit"},
                    },
                    "supplier": {"reference": "Organization/maseru-clinic-a"},
                    "destination": {"reference": dest},
                    "occurrenceDateTime": dt.datetime.combine(day, dt.time(9, 0)).isoformat() + "Z",
                })))

    # Current stock on hand, one reading per medicine per facility. A few are
    # deliberately at or near zero so the stock-out and alert charts have
    # something to show - an all-healthy dataset cannot exercise them.
    seq = 0
    for org in ORGS:
        for med_id, med_name in meds:
            seq += 1
            balance = random.choice([0, 0, 4, 8, 15, 40, 75, 120, 180, 260])
            resources.append(("Observation", f"demo-soh-{seq:04d}", tagged({
                "resourceType": "Observation",
                "id": f"demo-soh-{seq:04d}",
                "status": "final",
                "code": {"text": "Stock on hand"},
                "subject": {"reference": f"Group/{med_id}"},
                "performer": [{"reference": org}],
                "effectiveDateTime": dt.datetime.now().isoformat() + "Z",
                "component": [{
                    "code": {"text": "balance"},
                    "valueQuantity": {"value": balance, "unit": "unit"},
                }],
            })))

    return resources


def tag_query(rtype, extra=""):
    # The token separator must be percent-encoded. Sent raw, HAPI matches
    # nothing and returns an empty bundle, so a purge would report success
    # having deleted nothing at all - the worst possible failure for the one
    # mechanism that removes fabricated records.
    tag = urllib.parse.quote(f"{TAG_SYSTEM}|{TAG_CODE}", safe="")
    return f"{rtype}?_tag={tag}{extra}"


def tagged_count(rtype, settle=False):
    """Count what is still tagged.

    HAPI's search index trails the writes by a moment, so a count taken
    straight after a few hundred deletes can still report the old number even
    though the rows are gone (verified: resources returning 410, zero live rows,
    count still saying 14). When the answer decides whether to warn, give the
    index a chance to catch up before believing a non-zero.
    """
    n = get(tag_query(rtype, "&_summary=count")).get("total", 0)
    if n and settle:
        for _ in range(5):
            time.sleep(1.5)
            n = get(tag_query(rtype, "&_summary=count")).get("total", 0)
            if n == 0:
                break
    return n


def purge():
    """Delete everything this script created, and verify it is actually gone.

    Deliberately re-checks the count instead of stopping at the first empty
    page. Immediately after a few hundred deletes HAPI's search index can
    return an empty page while rows remain, so a loop that trusts that reports
    success and leaves fabricated patient records on the server. That happened:
    214 dispenses, 200 deleted, "done".
    """
    total = 0
    for rtype in ["MedicationDispense", "SupplyDelivery", "Observation", "Group", "Patient"]:
        removed = 0
        for _round in range(20):
            bundle = get(tag_query(rtype, "&_count=200&_elements=id"))
            entries = bundle.get("entry", [])
            if not entries:
                # Might be genuinely empty, or the index lagging. Ask for the
                # count before believing it.
                if tagged_count(rtype) == 0:
                    break
                continue
            for e in entries:
                delete(rtype, e["resource"]["id"])
                removed += 1
        left = tagged_count(rtype, settle=True)
        total += removed
        flag = "" if left == 0 else f"  WARNING: {left} still tagged"
        print(f"  {rtype:<22} {removed} removed{flag}")

    remaining = sum(tagged_count(r, settle=True) for r in
                    ["MedicationDispense", "SupplyDelivery", "Observation", "Group", "Patient"])
    print()
    print(f"{total} demo resource(s) removed.")
    if remaining:
        print(f"{remaining} still tagged {TAG_CODE} - re-run to clear them.", file=sys.stderr)
        return 1
    print("Nothing tagged demo-data remains on the server.")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the data")
    ap.add_argument("--purge", action="store_true", help="delete everything tagged demo-data")
    ap.add_argument("--patients", type=int, default=40)
    args = ap.parse_args()

    if args.purge:
        print(f"Removing resources tagged {TAG_CODE} from {FHIR}\n")
        return purge()

    meds = medicines()
    if not meds:
        print("No medicine Groups on the server - seed those first.", file=sys.stderr)
        return 1
    print(f"{len(meds)} medicines, {len(DISPENSERS)} dispensers, {len(VILLAGES)} villages\n")

    resources = build(args.patients, meds)
    counts = {}
    for rtype, _rid, _body in resources:
        counts[rtype] = counts.get(rtype, 0) + 1
    for rtype, n in sorted(counts.items()):
        print(f"  {rtype:<22} {n}")
    print(f"\n  {'total':<22} {len(resources)}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to write it.")
        print("Everything is tagged demo-data and id-prefixed demo-, so --purge removes it all.")
        return 0

    print("\nWriting...")
    ok = fail = 0
    for rtype, rid, body in resources:
        try:
            put(rtype, rid, body)
            ok += 1
        except Exception as e:
            fail += 1
            if fail <= 3:
                print(f"  FAILED {rtype}/{rid}: {str(e)[:90]}", file=sys.stderr)
    print(f"\n{ok} written, {fail} failed.")
    print("All of it is tagged demo-data. Remove with: python scripts/seed_demo_data.py --purge")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
