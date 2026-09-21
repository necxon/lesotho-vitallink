#!/usr/bin/env python3
"""
superset_categories.py - build the five agreed dashboard category views.

    make superset-categories

The five categories are the ones signed off in
docs/superset-reporting-requirements.md. They are organised by who is looking
and what decision they are about to make, not by which system the data came
from - a logistics officer should not need to know whether a number came from
OpenLMIS or FHIR.

This does NOT rebuild charts. seed_superset.py already provisions 127 of them
across 10 source-oriented dashboards; this reassigns those same charts into the
five audience-oriented views. A chart can belong to several dashboards, so the
originals keep working and no chart URL changes.

Run it after `make superset-dashboards`, which is what creates the charts.

Idempotent: dashboards are matched by title, so re-running updates in place.

Invoked inside the container, where requests is installed:

    docker exec -i bkm-superset python3 - < scripts/superset_categories.py

Environment:
  SUPERSET_URL       default http://localhost:8088 (inside the container)
  SUPERSET_USER      default admin
  SUPERSET_PASSWORD  default admin
"""

import json
import os
import re
import sys

import requests

SUPERSET_URL = os.environ.get("SUPERSET_URL", "http://localhost:8088").rstrip("/")
SUPERSET_USER = os.environ.get("SUPERSET_USER", "admin")
SUPERSET_PASSWORD = os.environ.get("SUPERSET_PASSWORD", "admin")

session = requests.Session()
_headers = {}

# Width and height per visualisation type, in Superset's 12-column grid.
# Counters are narrow so a row of them reads as a KPI strip; tables get the
# full width because a table squeezed into four columns is unreadable.
SIZES = {
    "big_number_total": (3, 50),
    "pie": (4, 60),
    "echarts_timeseries_bar": (6, 60),
    "echarts_timeseries_line": (6, 60),
    "echarts_area": (6, 60),
    "table": (12, 60),
}
DEFAULT_SIZE = (6, 60)

# The five categories. Chart names are listed in display order: counters first,
# then breakdowns, then the detail table, because that is the order somebody
# reads a dashboard in.
CATEGORIES = [
    {
        "title": "1. Programme Overview",
        "description": (
            "Headline state of the programme for the Ministry programme director "
            "and delivery lead. Answers: is the programme operating, and where "
            "does attention need to go."
        ),
        "charts": [
            "Patients registered",
            "Health workers",
            "Households",
            "Facilities",
            "Medicines tracked",
            "Open tasks",
            "Dispensing events",
            "Total FHIR resources",
            "OpenLMIS: Stock alerts",
            "OpenLMIS: Stock-outs",
            "DHIS2: Total reported",
            "Resource mix",
            "Write activity per day",
        ],
    },
    {
        "title": "2. Stock and Supply Chain",
        "description": (
            "For the national logistics officer, district pharmacist and facility "
            "in-charge. Answers: what to order, what to move, and what is about "
            "to expire."
        ),
        "charts": [
            "OpenLMIS: Units on hand",
            "OpenLMIS: Stock-outs",
            "OpenLMIS: Stock alerts",
            "OpenLMIS: Expired lots",
            "OpenLMIS: Stock status breakdown",
            "OpenLMIS: Units by facility",
            "OpenLMIS: Units by product",
            "OpenLMIS: Stock on hand over time",
            "OpenLMIS: Stock-outs by facility",
            "OpenLMIS: Movements per day",
            "OpenLMIS: Movements by reason",
            "OpenLMIS: Net movement by product",
            "OpenLMIS: Open requisitions",
            "OpenLMIS: Order pipeline",
            "OpenLMIS: Lot expiry risk",
            "OpenLMIS: Stock ledger",
        ],
    },
    {
        "title": "3. Service Delivery",
        "description": (
            "For the district health manager and programme officer. Answers: "
            "where services are being delivered, and where they are not."
        ),
        "charts": [
            "Dispense events",
            "Units dispensed",
            "Form submissions",
            "Tasks in pipeline",
            "Units dispensed per day",
            "Dispensing by medicine",
            "Dispensing by village",
            "Dispensing by health worker",
            "Form submissions per day",
            "Task pipeline by status",
            "Task ageing",
            "Dispense register",
        ],
    },
    {
        "title": "4. Workforce and Coverage",
        "description": (
            "For the district supervisor and programme manager. Answers: which "
            "health workers need support, and which areas are uncovered."
        ),
        "charts": [
            "Health workers",
            "Households per health worker",
            "Patients per health worker",
            "Gender split",
            "Patients by age band",
            "Patients by village",
            "Patients by district",
            "Registrations over time",
            "Service points and villages",
            "OpenLMIS: Facilities by zone",
            "OpenLMIS: Facilities by type",
            "Health worker caseload",
            "Workforce roster",
        ],
    },
    {
        "title": "5. Data Quality and Platform Health",
        "description": (
            "For the M&E officer and system administrator. Answers: can the "
            "numbers on the other four dashboards be trusted, and is the "
            "platform healthy."
        ),
        "charts": [
            "Data quality checks",
            "Checks with failures",
            "Failing data quality rows",
            "Broken references",
            "Failures by severity",
            "Failures by check",
            "DHIS2: Reporting coverage",
            "DHIS2: Dataset completeness",
            "OpenLMIS: Checks by severity",
            "Creates vs updates vs deletes",
            "Writes per hour",
            "Unresolved references",
        ],
    },
]


def login():
    """Log in with the web form, not /api/v1/security/login.

    Same reason as seed_superset.py: the API JWT authorises writes, but
    Superset's row-level filters resolve the bearer identity as anonymous, so
    every list endpoint comes back empty and this script would think no charts
    exist. A session cookie from the form login is seen as Admin everywhere.
    """
    page = session.get(f"{SUPERSET_URL}/login/", timeout=30)
    page.raise_for_status()
    match = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', page.text)
    if not match:
        raise RuntimeError("could not find csrf_token on the Superset login page")
    r = session.post(
        f"{SUPERSET_URL}/login/",
        data={
            "username": SUPERSET_USER,
            "password": SUPERSET_PASSWORD,
            "csrf_token": match.group(1),
        },
        timeout=30,
    )
    r.raise_for_status()
    csrf = session.get(f"{SUPERSET_URL}/api/v1/security/csrf_token/", timeout=30)
    csrf.raise_for_status()
    _headers["X-CSRFToken"] = csrf.json()["result"]
    _headers["Referer"] = SUPERSET_URL
    if session.get(f"{SUPERSET_URL}/api/v1/me/", timeout=30).status_code != 200:
        raise RuntimeError("login failed - check SUPERSET_USER / SUPERSET_PASSWORD")


def api(method, path, **kw):
    r = session.request(
        method, f"{SUPERSET_URL}/api/v1{path}", headers=_headers, timeout=120, **kw
    )
    if r.status_code >= 400:
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else {}


def list_all(resource, columns):
    out, page = [], 0
    while True:
        q = json.dumps({"columns": columns, "page": page, "page_size": 100})
        data = api("GET", f"/{resource}/?q={q}")
        out.extend(data.get("result", []))
        if len(out) >= data.get("count", 0) or not data.get("result"):
            return out
        page += 1


def ensure_dashboard(title, description):
    for d in list_all("dashboard", ["id", "dashboard_title"]):
        if d["dashboard_title"] == title:
            return d["id"]
    return api(
        "POST",
        "/dashboard/",
        json={"dashboard_title": title, "published": True},
    )["id"]


def build_position(title, description, placed):
    """Lay charts out left to right, wrapping past 12 grid columns.

    Mirrors seed_superset.py so the category dashboards look like the ones
    already in use rather than introducing a second visual convention.
    """
    position = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": title}},
        "GRID_ID": {
            "type": "GRID",
            "id": "GRID_ID",
            "children": ["ROW-0"],
            "parents": ["ROOT_ID"],
        },
        "ROW-0": {
            "type": "ROW",
            "id": "ROW-0",
            "children": ["MARKDOWN-intro"],
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
            "parents": ["ROOT_ID", "GRID_ID"],
        },
        "MARKDOWN-intro": {
            "type": "MARKDOWN",
            "id": "MARKDOWN-intro",
            "children": [],
            "meta": {"width": 12, "height": 12, "code": f"### {title}\n{description}"},
            "parents": ["ROOT_ID", "GRID_ID", "ROW-0"],
        },
    }
    row_idx, used, row_id = 0, 0, None
    for chart_id, name, width, height in placed:
        if row_id is None or used + width > 12:
            row_idx += 1
            used = 0
            row_id = f"ROW-{row_idx}"
            position[row_id] = {
                "type": "ROW",
                "id": row_id,
                "children": [],
                "meta": {"background": "BACKGROUND_TRANSPARENT"},
                "parents": ["ROOT_ID", "GRID_ID"],
            }
            position["GRID_ID"]["children"].append(row_id)
        node_id = f"CHART-{chart_id}"
        position[node_id] = {
            "type": "CHART",
            "id": node_id,
            "children": [],
            "meta": {
                "chartId": chart_id,
                "width": width,
                "height": height,
                "sliceName": name,
            },
            "parents": ["ROOT_ID", "GRID_ID", row_id],
        }
        position[row_id]["children"].append(node_id)
        used += width
    return position


def main():
    login()
    print(f"Logged in to Superset at {SUPERSET_URL}\n")

    charts = list_all("chart", ["id", "slice_name", "viz_type", "dashboards.id"])
    by_name = {c["slice_name"]: c for c in charts}
    print(f"{len(charts)} charts available\n")

    missing_total = 0
    for cat in CATEGORIES:
        title = cat["title"]
        dash_id = ensure_dashboard(title, cat["description"])

        placed, missing = [], []
        for name in cat["charts"]:
            chart = by_name.get(name)
            if not chart:
                missing.append(name)
                continue
            width, height = SIZES.get(chart.get("viz_type"), DEFAULT_SIZE)
            placed.append((chart["id"], name, width, height))

            # Link the chart to this dashboard, keeping the ones it already
            # belongs to. Charts are shared, not moved, so the original
            # source-oriented dashboards keep working.
            current = [d["id"] for d in (chart.get("dashboards") or [])]
            if dash_id not in current:
                api(
                    "PUT",
                    f"/chart/{chart['id']}",
                    json={"dashboards": current + [dash_id]},
                )
                chart.setdefault("dashboards", []).append({"id": dash_id})

        api(
            "PUT",
            f"/dashboard/{dash_id}",
            json={
                "dashboard_title": title,
                "published": True,
                "position_json": json.dumps(
                    build_position(title, cat["description"], placed)
                ),
            },
        )

        note = f"  {len(placed)} charts"
        if missing:
            missing_total += len(missing)
            note += f", {len(missing)} not found"
        print(f"{title}\n{note}")
        for name in missing:
            print(f"    missing: {name}")

    print(f"\nDone. {len(CATEGORIES)} category dashboards provisioned.")
    if missing_total:
        # A named chart that does not exist usually means seed_superset.py has
        # not run for that source, or a chart was renamed there without being
        # renamed here.
        print(
            f"{missing_total} chart(s) were not found. Run `make superset-dashboards` "
            "first, and check the names still match."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
