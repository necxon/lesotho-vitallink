#!/usr/bin/env python3
"""
seed_demo_dhis2.py - post synthetic aggregate data to DHIS2 so the reported-data
dashboards have something to show.

    python scripts/seed_demo_dhis2.py            # show what would be posted
    python scripts/seed_demo_dhis2.py --apply
    python scripts/seed_demo_dhis2.py --purge    # delete what it posted

THIS DATA IS FABRICATED
It is aggregate counts against real data elements and real org units, for the
last twelve months. Nothing here describes a person; DHIS2 holds no patient
records in this deployment.

Unlike the FHIR generator next door, DHIS2 data values carry no tag to mark
them, so removal works by reconstructing the exact (data element, period, org
unit) keys this script writes and deleting those. Keep the element list, the
period window and the org unit filter in step with each other, or --purge will
miss values that --apply created.

WHICH DASHBOARDS THIS FILLS
fact_data_value feeds rpt_data_values_by_element, rpt_data_values_by_org_unit,
rpt_data_value_trend, rpt_stock_indicators, rpt_capture_activity and
rpt_reporting_coverage - six of the seven DHIS2 report views.

rpt_completeness is NOT filled. It reads completeDataSetRegistrations, and this
deployment has no data sets at all, so there is nothing to register against.
Creating one would be a metadata change rather than a data one, which is a
different decision - see docs/superset-reporting-requirements.md.
"""
import argparse
import datetime as dt
import json
import random
import sys
import urllib.error
import urllib.request
import base64

DHIS2 = "http://127.0.0.1:8081"
USER = "admin"
PASSWORD = "district"
DEFAULT_COC = "HllvX50cXC0"
MONTHS = 12
# Enough facilities for the by-org-unit charts to be worth looking at, while
# leaving some deliberately silent so rpt_reporting_coverage has a real gap to
# report rather than showing a flat 100%.
FACILITY_LIMIT = 20

random.seed(2026)


def call(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{DHIS2}{path}", data=data, method=method)
    token = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            text = r.read().decode("utf-8")
            return r.status, (json.loads(text) if text.strip() else {})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, {"raw": text[:300]}


def elements():
    _s, d = call("GET", "/api/dataElements?fields=id,name&pageSize=100")
    des = d.get("dataElements", [])
    # Stock dispensed and stock on hand: the two families the mediator already
    # pushes in production, so the demo exercises the same elements.
    return [e for e in des if "Dispensed" in e["name"] or "on Hand" in e["name"]]


def facilities():
    _s, d = call(
        "GET",
        f"/api/organisationUnits?filter=level:eq:3&fields=id,name&pageSize={FACILITY_LIMIT}",
    )
    return d.get("organisationUnits", [])


def periods():
    today = dt.date.today().replace(day=1)
    out = []
    for i in range(MONTHS):
        m = today.month - i
        y = today.year
        while m <= 0:
            m += 12
            y -= 1
        out.append(f"{y}{m:02d}")
    return sorted(out)


def build(des, ous, pes):
    """One value per element, facility and month.

    Dispensing grows gently over the year and stock on hand wanders, because a
    flat series makes the trend charts useless for judging whether the
    dashboard is reading the data correctly.
    """
    values = []
    for oi, ou in enumerate(ous):
        scale = 0.6 + (oi % 5) * 0.25          # facilities differ in size
        for de in des:
            soh = "on Hand" in de["name"]
            base = 120 if soh else 40
            for pi, pe in enumerate(pes):
                growth = 1.0 + (pi / len(pes)) * 0.5
                v = int(max(0, random.gauss(base * scale * growth, base * 0.22)))
                values.append({
                    "dataElement": de["id"],
                    "period": pe,
                    "orgUnit": ou["id"],
                    "categoryOptionCombo": DEFAULT_COC,
                    "value": str(v),
                })
    return values


def post(values):
    ok = fail = 0
    # Batched: one request per 5000 values keeps the payload well inside what
    # DHIS2 will accept while avoiding a request per value.
    for i in range(0, len(values), 5000):
        chunk = values[i:i + 5000]
        status, body = call("POST", "/api/dataValueSets", {"dataValues": chunk})
        resp = body.get("response", body)
        imported = (resp.get("importCount") or {}).get("imported", 0)
        updated = (resp.get("importCount") or {}).get("updated", 0)
        ignored = (resp.get("importCount") or {}).get("ignored", 0)
        if status < 400:
            ok += imported + updated
            fail += ignored
            print(f"  batch {i // 5000 + 1}: {imported} imported, {updated} updated, {ignored} ignored")
        else:
            fail += len(chunk)
            print(f"  batch {i // 5000 + 1}: HTTP {status} {str(body)[:160]}", file=sys.stderr)
    return ok, fail


def purge(values):
    removed = missing = 0
    for v in values:
        status, _b = call(
            "DELETE",
            f"/api/dataValues?de={v['dataElement']}&pe={v['period']}"
            f"&ou={v['orgUnit']}&co={v['categoryOptionCombo']}",
        )
        if status < 400:
            removed += 1
        else:
            # Already gone is the normal case on a second run, not an error.
            missing += 1
    return removed, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--purge", action="store_true")
    args = ap.parse_args()

    des, ous, pes = elements(), facilities(), periods()
    if not des or not ous:
        print("DHIS2 has no data elements or no level-3 org units.", file=sys.stderr)
        return 1

    print(f"{len(des)} data elements, {len(ous)} facilities, {len(pes)} months "
          f"({pes[0]} to {pes[-1]})")
    values = build(des, ous, pes)
    print(f"{len(values)} data values\n")

    if args.purge:
        print("Deleting...")
        removed, missing = purge(values)
        print(f"\n{removed} deleted, {missing} already absent.")
        return 0

    if not args.apply:
        print("Dry run. Re-run with --apply to post them.")
        return 0

    print("Posting...")
    ok, fail = post(values)
    print(f"\n{ok} accepted, {fail} rejected.")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
