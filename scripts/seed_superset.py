#!/usr/bin/env python3
"""
seed_superset.py - provision the Superset database connection, datasets, charts
and dashboards for the FHIR analytics layer.

Idempotent: every object is looked up by name first, then created or updated, so
re-running after a view change is safe and keeps existing chart URLs working.

Normally invoked from the repo root as:

    make superset

which runs it inside the container (requests is installed there):

    docker exec -i bkm-superset python3 - < scripts/seed_superset.py

Environment:
  SUPERSET_URL       default http://localhost:8088 (inside the container)
  SUPERSET_USER      default admin
  SUPERSET_PASSWORD  default admin
  FHIR_DB_URI        default postgresql+psycopg2://superset_ro:superset_ro@db-postgres:5432/hapi_fhir
"""

import json
import os
import re
import sys

import requests

SUPERSET_URL = os.environ.get("SUPERSET_URL", "http://localhost:8088").rstrip("/")
SUPERSET_USER = os.environ.get("SUPERSET_USER", "admin")
SUPERSET_PASSWORD = os.environ.get("SUPERSET_PASSWORD", "admin")
DB_NAME = "FHIR (hapi_fhir)"
DB_URI = os.environ.get(
    "FHIR_DB_URI",
    "postgresql+psycopg2://superset_ro:superset_ro@db-postgres:5432/hapi_fhir",
)
SCHEMA = "analytics"

session = requests.Session()
_headers = {}


# --- API plumbing -------------------------------------------------------------


def login():
    """Log in with the web form, not /api/v1/security/login.

    The JWT that the API login hands back authorises writes, but Superset's
    row-level filters (DatabaseFilter, DatasetFilter, ...) resolve the bearer
    identity as anonymous, so every list endpoint comes back empty and this
    script would re-create objects that already exist. A session cookie from the
    form login is seen as the Admin user everywhere.
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
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:400]}")
    return r.json() if r.text else {}


def list_all(resource, columns):
    """Page through a list endpoint and return every row."""
    out, page = [], 0
    while True:
        q = json.dumps({"columns": columns, "page": page, "page_size": 100})
        data = api("GET", f"/{resource}/?q={q}")
        out.extend(data.get("result", []))
        if len(out) >= data.get("count", 0) or not data.get("result"):
            return out
        page += 1


# --- Provisioning steps -------------------------------------------------------


def ensure_database(db_name, db_uri):
    for db in list_all("database", ["id", "database_name"]):
        if db["database_name"] == db_name:
            api(
                "PUT",
                f"/database/{db['id']}",
                json={"sqlalchemy_uri": db_uri, "expose_in_sqllab": True},
            )
            return db["id"]
    created = api(
        "POST",
        "/database",
        json={
            "database_name": db_name,
            "sqlalchemy_uri": db_uri,
            "expose_in_sqllab": True,
            "allow_ctas": False,
            "allow_cvas": False,
            "allow_dml": False,
        },
    )
    return created["id"]


def ensure_datasets(db_id, table_names):
    # Keyed by (database, table): every source has its own analytics schema and
    # they share view names such as rpt_kpi_overview, so the table name alone
    # would bind the second source's charts to the first source's dataset.
    existing = {
        (d["database"]["id"], d["table_name"]): d["id"]
        for d in list_all("dataset", ["id", "table_name", "database.id"])
    }
    ids = {}
    for name in table_names:
        if (db_id, name) in existing:
            ids[name] = existing[(db_id, name)]
            continue
        created = api(
            "POST",
            "/dataset",
            json={"database": db_id, "schema": SCHEMA, "table_name": name},
        )
        ids[name] = created["id"]
    return ids


def ensure_dashboard(title, description):
    for d in list_all("dashboard", ["id", "dashboard_title"]):
        if d["dashboard_title"] == title:
            return d["id"]
    created = api(
        "POST",
        "/dashboard",
        json={
            "dashboard_title": title,
            "published": True,
            "css": "",
            # json_metadata is schema-validated: only known keys are accepted,
            # so the human description lives in the dashboard header markdown.
            "json_metadata": json.dumps(
                {
                    "color_scheme": "supersetColors",
                    "refresh_frequency": 0,
                    "expanded_slices": {},
                    "label_colors": {},
                    "cross_filters_enabled": True,
                }
            ),
        },
    )
    return created["id"]


def build_query_context(spec, dataset_id, params):
    """The query Superset runs for this chart.

    Charts saved without a query_context render in the UI but fail on the data
    API (and therefore on CSV export and thumbnails) with "Chart has no query
    context saved", so it is built here rather than left to a manual re-save.
    """
    viz = spec["viz"]
    if "metric" in params:
        metrics = [params["metric"]]
    else:
        metrics = list(params.get("metrics", []))

    if viz == "table":
        columns = list(params.get("all_columns", []))
        metrics = []  # raw mode: the columns are selected as-is
    elif viz == "pie":
        columns = list(params.get("groupby", []))
    else:  # the echarts timeseries family shares the generic x-axis
        columns = ([params["x_axis"]] if params.get("x_axis") else []) + list(
            params.get("groupby", [])
        )

    query = {
        "filters": [],
        "extras": {"having": "", "where": ""},
        "applied_time_extras": {},
        "columns": columns,
        "metrics": metrics,
        "annotation_layers": [],
        "series_limit": 0,
        "order_desc": True,
        "orderby": [[metrics[0], False]] if metrics and columns else [],
        "row_limit": params.get("row_limit", 5000),
        "url_params": {},
        "custom_params": {},
        "custom_form_data": {},
    }
    return {
        "datasource": {"id": dataset_id, "type": "table"},
        "force": False,
        "queries": [query],
        "form_data": params,
        "result_format": "json",
        "result_type": "full",
    }


def ensure_chart(spec, dataset_id, dashboard_id, existing_charts):
    params = dict(spec["params"])
    params["datasource"] = f"{dataset_id}__table"
    params["viz_type"] = spec["viz"]
    payload = {
        "slice_name": spec["name"],
        "viz_type": spec["viz"],
        "datasource_id": dataset_id,
        "datasource_type": "table",
        "params": json.dumps(params),
        "query_context": json.dumps(build_query_context(spec, dataset_id, params)),
        "dashboards": [dashboard_id],
    }
    if spec["name"] in existing_charts:
        chart_id = existing_charts[spec["name"]]
        api("PUT", f"/chart/{chart_id}", json=payload)
        return chart_id
    return api("POST", "/chart", json=payload)["id"]


def build_position(title, description, placed):
    """Lay charts out left to right, wrapping to a new row past 12 grid columns."""
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
    for chart_id, spec in placed:
        width = spec.get("w", 4)
        height = spec.get("h", 50)
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
                "sliceName": spec["name"],
            },
            "parents": ["ROOT_ID", "GRID_ID", row_id],
        }
        position[row_id]["children"].append(node_id)
        used += width
    return position


# --- Chart param helpers ------------------------------------------------------


def sql_metric(expression, label):
    return {
        "expressionType": "SQL",
        "sqlExpression": expression,
        "label": label,
        "hasCustomLabel": True,
        "optionName": "metric_" + label.lower().replace(" ", "_")[:40],
    }


BASE = {"adhoc_filters": [], "time_range": "No filter", "row_limit": 5000}


def big_number(expression, label, subheader=""):
    return dict(
        BASE,
        metric=sql_metric(expression, label),
        subheader=subheader,
        y_axis_format="SMART_NUMBER",
        header_font_size=0.4,
        subheader_font_size=0.15,
    )


def pie(group_col, expression, label):
    return dict(
        BASE,
        groupby=[group_col],
        metric=sql_metric(expression, label),
        row_limit=100,
        donut=True,
        show_legend=True,
        label_type="key_value",
        number_format="SMART_NUMBER",
    )


def bars(x_col, expression, label, series=None, horizontal=False, sort_desc=True):
    return dict(
        BASE,
        x_axis=x_col,
        metrics=[sql_metric(expression, label)],
        groupby=[series] if series else [],
        orientation="horizontal" if horizontal else "vertical",
        x_axis_sort_asc=not sort_desc,
        x_axis_sort_series="name",
        show_legend=bool(series),
        y_axis_format="SMART_NUMBER",
        truncate_metric=True,
        rich_tooltip=True,
        stack="Stack" if series else None,
    )


def lines(x_col, expression, label, series=None):
    return dict(
        BASE,
        x_axis=x_col,
        metrics=[sql_metric(expression, label)],
        groupby=[series] if series else [],
        show_legend=True,
        markerEnabled=True,
        y_axis_format="SMART_NUMBER",
        rich_tooltip=True,
        seriesType="line",
    )


def table(columns, sort_col=None, desc=True):
    return dict(
        BASE,
        query_mode="raw",
        all_columns=columns,
        order_by_cols=[json.dumps([sort_col, not desc])] if sort_col else [],
        row_limit=1000,
        table_timestamp_format="smart_date",
        color_pn=True,
    )


# --- The report catalogue -----------------------------------------------------

BAR = "echarts_timeseries_bar"
LINE = "echarts_timeseries_line"
AREA = "echarts_area"

FHIR_DASHBOARDS = [
    (
        "Vital-Link Overview",
        "Headline counts for the whole FHIR record set, plus write activity.",
        [
            dict(name="Patients registered", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(patients)", "Patients", "People on the register"), w=3, h=50),
            dict(name="Health workers", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(practitioners)", "Practitioners", "VHWs and facility staff"), w=3, h=50),
            dict(name="Households", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(households)", "Households", "VHW catchment groups"), w=3, h=50),
            dict(name="Facilities", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(facilities)", "Facilities", "Organizations in FHIR"), w=3, h=50),
            dict(name="Medicines tracked", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(medicines)", "Medicines", "Commodity groups"), w=3, h=50),
            dict(name="Dispensing events", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(dispenses)", "Dispenses", "MedicationDispense records"), w=3, h=50),
            dict(name="Open tasks", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(tasks_open)", "Open tasks", "Awaiting action"), w=3, h=50),
            dict(name="Total FHIR resources", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(fhir_resources)", "Resources", "Live, non-deleted"), w=3, h=50),
            dict(name="Resources by type", ds="rpt_resource_inventory", viz=BAR,
                 params=bars("resource_type", "SUM(resource_count)", "Resources"), w=8, h=60),
            dict(name="Resource mix", ds="rpt_resource_inventory", viz="pie",
                 params=pie("resource_type", "SUM(resource_count)", "Resources"), w=4, h=60),
            dict(name="Write activity per day", ds="rpt_write_activity_daily", viz=BAR,
                 params=bars("activity_day", "SUM(events)", "Writes", series="change_type"), w=8, h=60),
            dict(name="Most recently updated types", ds="rpt_resource_inventory", viz="table",
                 params=table(["resource_type", "resource_count", "last_updated", "total_versions"],
                              sort_col="last_updated"), w=4, h=60),
        ],
    ),
    (
        "Stock and Supply",
        "Stock on hand per medicine and facility, alerts, balance history and deliveries.",
        [
            dict(name="Stock lines tracked", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stock_ledger_rows)", "Stock lines", "Medicine x facility"), w=3, h=50),
            dict(name="Stock-outs", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stockouts)", "Stock-outs", "Lines at zero"), w=3, h=50),
            dict(name="Units on hand", ds="rpt_stock_by_medicine", viz="big_number_total",
                 params=big_number("SUM(total_units)", "Units", "Across all facilities"), w=3, h=50),
            dict(name="Deliveries recorded", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(deliveries)", "Deliveries", "SupplyDelivery records"), w=3, h=50),
            dict(name="Stock status breakdown", ds="rpt_stock_current", viz="pie",
                 params=pie("stock_status", "COUNT(*)", "Lines"), w=4, h=60),
            dict(name="Units by medicine", ds="rpt_stock_by_medicine", viz=BAR,
                 params=bars("medicine", "SUM(total_units)", "Units"), w=4, h=60),
            dict(name="Units by facility", ds="rpt_stock_by_facility", viz=BAR,
                 params=bars("facility", "SUM(total_units)", "Units"), w=4, h=60),
            dict(name="Stock balance history", ds="rpt_stock_trend", viz=LINE,
                 params=lines("observed_at", "AVG(balance)", "Balance", series="medicine"), w=8, h=60),
            dict(name="Stock-outs by facility", ds="rpt_stock_by_facility", viz=BAR,
                 params=bars("facility", "SUM(stockouts)", "Stock-out lines"), w=4, h=60),
            dict(name="Stock alerts", ds="rpt_stock_alerts", viz="table",
                 params=table(["severity", "facility", "medicine", "balance", "unit", "effective_at"],
                              sort_col="balance", desc=False), w=6, h=60),
            dict(name="Current stock ledger", ds="rpt_stock_current", viz="table",
                 params=table(["facility", "medicine", "balance", "unit", "stock_status",
                               "days_since_update", "effective_at"], sort_col="facility", desc=False), w=6, h=60),
            dict(name="Deliveries per day", ds="rpt_supply_delivery_daily", viz=BAR,
                 params=bars("occurred_day", "SUM(units_delivered)", "Units", series="item"), w=6, h=60),
            dict(name="Delivery events by status", ds="rpt_supply_delivery_daily", viz="pie",
                 params=pie("status", "SUM(deliveries)", "Deliveries"), w=6, h=60),
        ],
    ),
    (
        "Service Delivery",
        "Dispensing to patients, the delivery task pipeline and form submissions.",
        [
            dict(name="Units dispensed", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(units_dispensed)", "Units", "All time"), w=3, h=50),
            dict(name="Dispense events", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(dispenses)", "Events", "MedicationDispense"), w=3, h=50),
            dict(name="Tasks in pipeline", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(tasks)", "Tasks", "All statuses"), w=3, h=50),
            dict(name="Form submissions", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(form_submissions)", "Submissions", "QuestionnaireResponse"), w=3, h=50),
            dict(name="Units dispensed per day", ds="rpt_dispense_daily", viz=LINE,
                 params=lines("handed_over_day", "SUM(units_dispensed)", "Units", series="medicine"), w=8, h=60),
            dict(name="Dispensing by medicine", ds="rpt_dispense_daily", viz="pie",
                 params=pie("medicine", "SUM(units_dispensed)", "Units"), w=4, h=60),
            dict(name="Dispensing by health worker", ds="rpt_dispense_by_vhw", viz=BAR,
                 params=bars("vhw", "SUM(units_dispensed)", "Units", series="medicine"), w=6, h=60),
            dict(name="Dispensing by village", ds="rpt_dispense_by_village", viz=BAR,
                 params=bars("village", "SUM(units_dispensed)", "Units"), w=6, h=60),
            dict(name="Dispense register", ds="rpt_dispense_detail", viz="table",
                 params=table(["handed_over_at", "medicine", "quantity", "unit", "patient",
                               "age_band", "gender", "village", "dispensed_by", "status"],
                              sort_col="handed_over_at"), w=12, h=60),
            dict(name="Task pipeline by status", ds="rpt_task_pipeline", viz=BAR,
                 params=bars("status", "SUM(tasks)", "Tasks", series="task_type"), w=4, h=60),
            dict(name="Task ageing", ds="rpt_task_ageing", viz=BAR,
                 params=bars("age_bucket", "SUM(tasks)", "Tasks", series="status"), w=4, h=60),
            dict(name="Task backlog", ds="rpt_task_detail", viz="table",
                 params=table(["status", "task_type", "for_facility", "product", "quantity_text",
                               "age_days", "authored_at"], sort_col="age_days"), w=4, h=60),
            dict(name="Form submissions per day", ds="rpt_form_submissions_daily", viz=BAR,
                 params=bars("authored_day", "SUM(submissions)", "Submissions", series="questionnaire_id"),
                 w=6, h=60),
            dict(name="Most common form answers", ds="rpt_form_answers", viz="table",
                 params=table(["questionnaire_id", "question", "answer", "responses"],
                              sort_col="responses"), w=6, h=60),
        ],
    ),
    (
        "People and Workforce",
        "Patient demographics, catchment coverage and the health worker roster.",
        [
            dict(name="Patients by age band", ds="rpt_patient_demographics", viz=BAR,
                 params=bars("age_band", "SUM(patients)", "Patients", series="gender", sort_desc=False),
                 w=6, h=60),
            dict(name="Gender split", ds="rpt_patient_demographics", viz="pie",
                 params=pie("gender", "SUM(patients)", "Patients"), w=3, h=60),
            dict(name="Patients by district", ds="rpt_patient_demographics", viz="pie",
                 params=pie("district", "SUM(patients)", "Patients"), w=3, h=60),
            dict(name="Patients by village", ds="rpt_patients_by_village", viz=BAR,
                 params=bars("village", "SUM(patients)", "Patients"), w=6, h=60),
            dict(name="Registrations over time", ds="rpt_patient_registrations_daily", viz=LINE,
                 params=lines("registration_day", "SUM(patients)", "Patients", series="district"), w=6, h=60),
            dict(name="Households per health worker", ds="rpt_vhw_caseload", viz=BAR,
                 params=bars("practitioner_name", "SUM(households)", "Households"), w=6, h=60),
            dict(name="Patients per health worker", ds="rpt_vhw_caseload", viz=BAR,
                 params=bars("practitioner_name", "SUM(patients)", "Patients"), w=6, h=60),
            dict(name="Health worker caseload", ds="rpt_vhw_caseload", viz="table",
                 params=table(["practitioner_name", "district", "phone", "households", "patients",
                               "dispenses", "units_dispensed"], sort_col="patients"), w=6, h=60),
            dict(name="Workforce roster", ds="rpt_workforce_roster", viz="table",
                 params=table(["practitioner_name", "role_display", "facility_name", "location_name",
                               "phone", "period_start", "active"], sort_col="practitioner_name", desc=False),
                 w=6, h=60),
            dict(name="Care team composition", ds="rpt_care_team_composition", viz="pie",
                 params=pie("role", "SUM(members)", "Members"), w=4, h=60),
            dict(name="Service points and villages", ds="rpt_location_hierarchy", viz="table",
                 params=table(["location_name", "location_type", "parent_name", "latitude",
                               "longitude", "status"], sort_col="location_name", desc=False), w=8, h=60),
        ],
    ),
    (
        "Data Quality and Platform",
        "Completeness checks, broken references and FHIR server write activity.",
        [
            dict(name="Failing data quality rows", ds="rpt_data_quality", viz="big_number_total",
                 params=big_number("SUM(failing_rows)", "Rows", "Across all checks"), w=4, h=50),
            dict(name="Checks with failures", ds="rpt_data_quality", viz="big_number_total",
                 params=big_number("COUNT(CASE WHEN failing_rows > 0 THEN 1 END)", "Checks",
                                   "Out of all checks run"), w=4, h=50),
            dict(name="Broken references", ds="rpt_broken_references", viz="big_number_total",
                 params=big_number("COUNT(*)", "References", "Pointing at missing resources"), w=4, h=50),
            dict(name="Failures by check", ds="rpt_data_quality", viz=BAR,
                 params=bars("check_name", "SUM(failing_rows)", "Rows", series="severity",
                             horizontal=True), w=8, h=80),
            dict(name="Failures by severity", ds="rpt_data_quality", viz="pie",
                 params=pie("severity", "SUM(failing_rows)", "Rows"), w=4, h=80),
            dict(name="Data quality checks", ds="rpt_data_quality", viz="table",
                 params=table(["severity", "resource_type", "check_name", "failing_rows"],
                              sort_col="failing_rows"), w=6, h=60),
            dict(name="Unresolved references", ds="rpt_broken_references", viz="table",
                 params=table(["source_type", "source_id", "reference_path", "missing_reference"],
                              sort_col="source_type", desc=False), w=6, h=60),
            dict(name="Writes per hour", ds="rpt_write_activity_hourly", viz=AREA,
                 params=lines("activity_hour", "SUM(events)", "Writes", series="resource_type"),
                 w=8, h=60),
            dict(name="Creates vs updates vs deletes", ds="rpt_write_activity_daily", viz="pie",
                 params=pie("change_type", "SUM(events)", "Events"), w=4, h=60),
        ],
    ),
]


OPENLMIS_DASHBOARDS = [
    (
        "OpenLMIS Stock Control",
        "Stock on hand per facility, product and lot, with alerts and expiry risk.",
        [
            dict(name="Facilities", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(facilities)", "Facilities", "In the facility register"), w=2, h=50),
            dict(name="Products", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(products)", "Products", "Orderables"), w=2, h=50),
            dict(name="Stock cards", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stock_cards)", "Stock cards", "Facility x product x lot"), w=2, h=50),
            dict(name="Units on hand", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(total_units_on_hand)", "Units", "Latest counted balance"), w=2, h=50),
            dict(name="Stock-outs", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stockouts)", "Stock-outs", "Lines at or below zero"), w=2, h=50),
            dict(name="Expired lots", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(lots_expired)", "Lots", "Past expiry date"), w=2, h=50),
            dict(name="Stock status breakdown", ds="rpt_stock_current", viz="pie",
                 params=pie("stock_status", "COUNT(*)", "Lines"), w=4, h=60),
            dict(name="Units by product", ds="rpt_stock_by_product", viz=BAR,
                 params=bars("product_name", "SUM(total_units)", "Units"), w=4, h=60),
            dict(name="Units by facility", ds="rpt_stock_by_facility", viz=BAR,
                 params=bars("facility_name", "SUM(total_units)", "Units"), w=4, h=60),
            dict(name="Stock on hand over time", ds="rpt_soh_trend", viz=LINE,
                 params=lines("occurred_date", "SUM(stock_on_hand)", "Units", series="product_name"), w=8, h=60),
            dict(name="Stock-outs by facility", ds="rpt_stock_by_facility", viz=BAR,
                 params=bars("facility_name", "SUM(stockouts)", "Stock-out lines"), w=4, h=60),
            dict(name="Stock alerts", ds="rpt_stock_alerts", viz="table",
                 params=table(["severity", "facility_name", "product_name", "lot_code",
                               "stock_on_hand", "soh_as_of", "expiry_band"],
                              sort_col="stock_on_hand", desc=False), w=6, h=60),
            dict(name="Stock ledger", ds="rpt_stock_current", viz="table",
                 params=table(["facility_name", "product_name", "lot_code", "stock_on_hand",
                               "stock_status", "expiry_band", "days_since_count", "soh_as_of"],
                              sort_col="facility_name", desc=False), w=6, h=60),
            dict(name="Lot expiry risk", ds="rpt_lot_expiry", viz=BAR,
                 params=bars("expiry_band", "SUM(units_at_risk)", "Units at risk"), w=4, h=60),
            dict(name="Lots on hand", ds="rpt_lot_detail", viz="table",
                 params=table(["lot_code", "product_name", "facility_name", "expiry_date",
                               "days_to_expiry", "stock_on_hand"], sort_col="days_to_expiry", desc=False),
                 w=8, h=60),
        ],
    ),
    (
        "OpenLMIS Supply Chain",
        "Stock movements by reason, plus the requisition, order and shipment pipelines.",
        [
            dict(name="Stock movements", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stock_movements)", "Movements", "Stock card line items"), w=3, h=50),
            dict(name="Stock events", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(stock_events)", "Events", "Submitted to stockmanagement"), w=3, h=50),
            dict(name="Open requisitions", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(requisitions_open)", "Requisitions", "Not released or skipped"), w=3, h=50),
            dict(name="Orders", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(orders)", "Orders", "In fulfillment"), w=3, h=50),
            dict(name="Movements per day", ds="rpt_movements_daily", viz=BAR,
                 params=bars("occurred_date", "SUM(quantity)", "Quantity", series="reason_type"), w=8, h=60),
            dict(name="Movements by reason", ds="rpt_movements_by_reason", viz="pie",
                 params=pie("reason_name", "SUM(movements)", "Movements"), w=4, h=60),
            dict(name="Net movement by product", ds="rpt_movements_daily", viz=BAR,
                 params=bars("product_name", "SUM(net_quantity)", "Net units"), w=4, h=60),
            dict(name="Movements by facility", ds="rpt_movements_by_facility", viz=BAR,
                 params=bars("facility_name", "SUM(movements)", "Movements", series="product_name"), w=4, h=60),
            dict(name="Stock events per day", ds="rpt_stock_events_daily", viz=BAR,
                 params=bars("event_day", "SUM(events)", "Events", series="event_origin"), w=4, h=60),
            dict(name="Movement register", ds="rpt_movement_detail", viz="table",
                 params=table(["occurred_date", "facility_name", "product_name", "lot_code",
                               "reason_name", "reason_type", "quantity", "signed_quantity",
                               "recorded_by"], sort_col="occurred_date"), w=12, h=60),
            dict(name="Requisition pipeline", ds="rpt_requisition_pipeline", viz=BAR,
                 params=bars("status", "SUM(requisitions)", "Requisitions", series="program_name"), w=4, h=60),
            dict(name="Order pipeline", ds="rpt_order_pipeline", viz=BAR,
                 params=bars("status", "SUM(orders)", "Orders", series="program_name"), w=4, h=60),
            dict(name="Physical inventories", ds="rpt_physical_inventories", viz="table",
                 params=table(["occurred_date", "facility_name", "program_name", "line_items",
                               "is_draft"], sort_col="occurred_date"), w=4, h=60),
            dict(name="Requisition register", ds="rpt_requisition_detail", viz="table",
                 params=table(["created_at", "facility_name", "program_name", "status",
                               "line_items", "requested_quantity", "approved_quantity",
                               "age_days"], sort_col="created_at"), w=6, h=60),
            dict(name="Order register", ds="rpt_order_detail", viz="table",
                 params=table(["created_at", "order_code", "status", "requesting_facility",
                               "supplying_facility", "ordered_quantity", "age_days"],
                              sort_col="created_at"), w=6, h=60),
            dict(name="Shipments and proof of delivery", ds="rpt_shipment_detail", viz="table",
                 params=table(["shipped_at", "order_code", "supplying_facility",
                               "receiving_facility", "line_items", "pod_status",
                               "pod_received_date"], sort_col="shipped_at"), w=12, h=60),
        ],
    ),
    (
        "OpenLMIS Network and Catalogue",
        "Facility register, programme coverage, product catalogue and reference data quality.",
        [
            dict(name="Active facilities", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(facilities_active)", "Facilities", "Active and enabled"), w=3, h=50),
            dict(name="Programmes", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(programs)", "Programmes", "Configured"), w=3, h=50),
            dict(name="Lots", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(lots)", "Lots", "In the catalogue"), w=3, h=50),
            dict(name="Users", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(users)", "Users", "OpenLMIS accounts"), w=3, h=50),
            dict(name="Facilities by type", ds="rpt_facilities_by_type", viz=BAR,
                 params=bars("facility_type", "SUM(facilities)", "Facilities", series="geographic_zone"),
                 w=6, h=60),
            dict(name="Facilities by zone", ds="rpt_facilities_by_type", viz="pie",
                 params=pie("geographic_zone", "SUM(facilities)", "Facilities"), w=3, h=60),
            dict(name="Programme coverage", ds="rpt_program_coverage", viz=BAR,
                 params=bars("program_name", "SUM(supported_facilities)", "Facilities"), w=3, h=60),
            dict(name="Facility register", ds="rpt_facility_network", viz="table",
                 params=table(["facility_code", "facility_name", "facility_type",
                               "geographic_zone", "active", "enabled", "go_live_date"],
                              sort_col="facility_name", desc=False), w=6, h=60),
            dict(name="Product catalogue", ds="rpt_product_catalogue", viz="table",
                 params=table(["product_code", "product_name", "program_name", "net_content",
                               "full_supply", "price_per_pack"], sort_col="product_name", desc=False),
                 w=6, h=60),
            dict(name="Approved products by facility type", ds="rpt_approved_products", viz="table",
                 params=table(["facility_type", "program_name", "product_name",
                               "min_periods_of_stock", "max_periods_of_stock",
                               "emergency_order_point"], sort_col="facility_type", desc=False),
                 w=6, h=60),
            dict(name="OpenLMIS users", ds="rpt_users", viz="table",
                 params=table(["username", "full_name", "job_title", "email", "home_facility",
                               "active"], sort_col="username", desc=False), w=6, h=60),
            dict(name="Reference data checks", ds="rpt_data_quality", viz=BAR,
                 params=bars("check_name", "SUM(failing_rows)", "Rows", series="severity",
                             horizontal=True), w=8, h=80),
            dict(name="Checks by severity", ds="rpt_data_quality", viz="pie",
                 params=pie("severity", "SUM(failing_rows)", "Rows"), w=4, h=80),
        ],
    ),
]

DHIS2_DASHBOARDS = [
    (
        "DHIS2 Reported Data",
        "Aggregate data values reported into DHIS2, by element, org unit and period.",
        [
            dict(name="Data values", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(data_values)", "Values", "Non-deleted"), w=3, h=50),
            dict(name="Total reported", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(total_reported)", "Sum", "Across numeric elements"), w=3, h=50),
            dict(name="Reporting org units", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(reporting_org_units)", "Org units", "Have reported at least once"),
                 w=3, h=50),
            dict(name="Flagged for follow-up", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(flagged_for_followup)", "Values", "Marked for review"), w=3, h=50),
            dict(name="Reported value over time", ds="rpt_data_value_trend", viz=LINE,
                 params=lines("period_start", "SUM(value)", "Value", series="data_element"), w=8, h=60),
            dict(name="Values by data element", ds="rpt_data_values_by_element", viz="pie",
                 params=pie("data_element", "SUM(data_values)", "Values"), w=4, h=60),
            dict(name="Stock indicators over time", ds="rpt_stock_indicators", viz=LINE,
                 params=lines("period_start", "SUM(value)", "Value", series="indicator_group"), w=8, h=60),
            dict(name="Values by org unit", ds="rpt_data_values_by_org_unit", viz=BAR,
                 params=bars("org_unit", "SUM(data_values)", "Values"), w=4, h=60),
            dict(name="Data capture activity", ds="rpt_capture_activity", viz=BAR,
                 params=bars("capture_day", "SUM(data_values)", "Values", series="stored_by"), w=6, h=60),
            dict(name="Data element totals", ds="rpt_data_values_by_element", viz="table",
                 params=table(["data_element", "value_type", "data_values", "total_value",
                               "avg_value", "last_period", "last_updated"],
                              sort_col="data_values"), w=6, h=60),
            dict(name="Data value register", ds="rpt_data_value_detail", viz="table",
                 params=table(["period_start", "data_element", "org_unit",
                               "category_option_combo", "value_text", "stored_by",
                               "last_updated"], sort_col="last_updated"), w=12, h=60),
        ],
    ),
    (
        "DHIS2 Metadata and Coverage",
        "What is configured in DHIS2, which org units report, and where the gaps are.",
        [
            dict(name="Data elements", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(data_elements)", "Elements", "Configured"), w=3, h=50),
            dict(name="Org units", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(org_units)", "Org units", "In the hierarchy"), w=3, h=50),
            dict(name="Data sets", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(data_sets)", "Data sets", "Configured"), w=3, h=50),
            dict(name="DHIS2 users", ds="rpt_kpi_overview", viz="big_number_total",
                 params=big_number("MAX(users)", "Users", "Accounts"), w=3, h=50),
            dict(name="Metadata inventory", ds="rpt_metadata_inventory", viz=BAR,
                 params=bars("metadata_type", "SUM(objects)", "Objects"), w=6, h=60),
            dict(name="Data elements by value type", ds="rpt_data_elements_by_type", viz="pie",
                 params=pie("value_type", "SUM(data_elements)", "Elements"), w=6, h=60),
            dict(name="Org units by level", ds="rpt_org_units_by_level", viz=BAR,
                 params=bars("level", "SUM(org_units)", "Org units", sort_desc=False), w=4, h=60),
            dict(name="Reporting coverage", ds="rpt_reporting_coverage", viz=BAR,
                 params=bars("parent_name", "SUM(silent_org_units)", "Never reported"), w=4, h=60),
            dict(name="Dataset completeness", ds="rpt_completeness", viz=BAR,
                 params=bars("period_start", "SUM(completed)", "Completed", series="data_set"), w=4, h=60),
            dict(name="Data element catalogue", ds="rpt_data_element_catalogue", viz="table",
                 params=table(["data_element", "uid", "code", "value_type", "domain_type",
                               "aggregation_type", "last_updated"], sort_col="data_element", desc=False),
                 w=6, h=60),
            dict(name="Org unit hierarchy", ds="rpt_org_unit_hierarchy", viz="table",
                 params=table(["org_unit", "parent_name", "level", "uid", "has_geometry",
                               "opening_date"], sort_col="level", desc=False), w=6, h=60),
            dict(name="DHIS2 metadata checks", ds="rpt_data_quality", viz=BAR,
                 params=bars("check_name", "SUM(failing_rows)", "Rows", series="severity",
                             horizontal=True), w=8, h=80),
            dict(name="Checks by severity", ds="rpt_data_quality", viz="pie",
                 params=pie("severity", "SUM(failing_rows)", "Rows"), w=4, h=80),
        ],
    ),
]

# Each source is one Superset database connection plus the dashboards built on it.
# The prefix keeps chart names unique across sources: rpt_kpi_overview and
# "Stock alerts" exist in more than one database, and Superset matches charts by
# name, so an unprefixed name would be overwritten by the next source.
SOURCES = [
    {
        "db_name": DB_NAME,
        "uri": DB_URI,
        "prefix": "",
        "dashboards": FHIR_DASHBOARDS,
    },
    {
        "db_name": "OpenLMIS (open_lmis)",
        "uri": os.environ.get(
            "OPENLMIS_DB_URI",
            "postgresql+psycopg2://superset_ro:superset_ro@db:5432/open_lmis",
        ),
        "prefix": "OpenLMIS",
        "dashboards": OPENLMIS_DASHBOARDS,
    },
    {
        "db_name": "DHIS2 (dhis2)",
        "uri": os.environ.get(
            "DHIS2_DB_URI",
            "postgresql+psycopg2://superset_ro:superset_ro@db-postgres:5432/dhis2",
        ),
        "prefix": "DHIS2",
        "dashboards": DHIS2_DASHBOARDS,
    },
]


def main():
    login()
    print("Logged in to Superset")

    existing_charts = {
        c["slice_name"]: c["id"] for c in list_all("chart", ["id", "slice_name"])
    }
    dashboards = charts_made = 0

    for source in SOURCES:
        db_id = ensure_database(source["db_name"], source["uri"])
        needed = sorted({c["ds"] for _, _, charts in source["dashboards"] for c in charts})
        ds_ids = ensure_datasets(db_id, needed)
        print(f"\n{source['db_name']}: connection id={db_id}, {len(ds_ids)} datasets")

        for title, description, charts in source["dashboards"]:
            dash_id = ensure_dashboard(title, description)
            placed = []
            for spec in charts:
                spec = dict(spec)
                if source["prefix"]:
                    spec["name"] = f"{source['prefix']}: {spec['name']}"
                chart_id = ensure_chart(
                    spec, ds_ids[spec["ds"]], dash_id, existing_charts
                )
                existing_charts[spec["name"]] = chart_id
                placed.append((chart_id, spec))
                charts_made += 1
            api(
                "PUT",
                f"/dashboard/{dash_id}",
                json={
                    "position_json": json.dumps(
                        build_position(title, description, placed)
                    )
                },
            )
            dashboards += 1
            print(f"  {title}: {len(charts)} charts")

    print(f"\nDone - {dashboards} dashboards, {charts_made} charts.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - surface the API error text
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
