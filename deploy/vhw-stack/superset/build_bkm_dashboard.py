#!/usr/bin/env python3
"""Build a Superset import bundle (zip) for the "BKM Child Health" dashboard.

Superset: Dashboards -> Import dashboard -> pick the zip. It references the
existing BKM_Server database (Spark/Hive on the fhir-data-pipes output) by its
UUID and adds 3 datasets, 9 charts and 1 dashboard with Area / VHW filters.
UUIDs are fixed, so re-importing (with "overwrite") updates instead of duplicating.

  python3 build_bkm_dashboard.py            # writes bkm_child_health_dashboard.zip
"""
import io
import json
import sys
import uuid
import zipfile
from datetime import datetime, timezone

BUNDLE = "bkm_child_health"
NS = uuid.UUID("6f1d3b1e-6c3a-4f1e-9a51-6b6b6d6b6b01")  # fixed namespace for stable UUIDs
DB_UUID = "fdf333a0-292c-4cfe-a92a-59162d097fcd"        # BKM_Server in the Lesotho Superset
DB_FILE = {
    "database_name": "BKM_Server",
    "sqlalchemy_uri": "hive://hive@192.0.2.236:10001",
    "cache_timeout": None, "expose_in_sqllab": True, "allow_run_async": False,
    "allow_ctas": False, "allow_cvas": False, "allow_dml": True, "allow_csv_upload": False,
    "extra": {"allows_virtual_table_explore": True}, "impersonate_user": False,
    "uuid": DB_UUID, "version": "1.0.0",
}


def uid(name):
    return str(uuid.uuid5(NS, name))


LOC_JOIN = ("LEFT JOIN location loc ON loc.id = element_at(filter({a}.meta.tag, "
            "x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code")

STATE = """CASE WHEN t.status = 'completed' THEN '{done}'
       WHEN t.status IN ('cancelled','failed','entered-in-error') THEN 'Expired'
       WHEN t.status IN ('ready','in-progress') AND to_date(t.executionPeriod.end) < current_date() THEN 'Overdue'
       WHEN t.status = 'ready' THEN 'Due' ELSE 'Upcoming' END"""

DATASETS = {
    "bkm_vaccine_tasks": {
        "sql": f"""SELECT t.id AS task_id, trim(t.description) AS vaccine, t.status AS status,
  {STATE.format(done='Given')} AS state,
  to_date(t.executionPeriod.start) AS window_start, to_date(t.executionPeriod.end) AS window_end,
  to_date(t.meta.lastUpdated) AS last_updated,
  substring_index(t.`for`.reference, '/', -1) AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family) AS child_name, p.gender AS gender,
  to_date(p.birthDate) AS birth_date,
  CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months,
  t.owner.practitionerId AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name, loc.name AS area
FROM task t
LEFT JOIN patient p ON p.id = substring_index(t.`for`.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = t.owner.practitionerId
{LOC_JOIN.format(a='t')}
WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002')""",
        "columns": [("task_id", "STRING"), ("vaccine", "STRING"), ("status", "STRING"),
                    ("state", "STRING"), ("window_start", "DATE"), ("window_end", "DATE"),
                    ("last_updated", "DATE"), ("patient_id", "STRING"), ("child_name", "STRING"),
                    ("gender", "STRING"), ("birth_date", "DATE"), ("age_months", "INT"),
                    ("vhw_id", "STRING"), ("vhw_name", "STRING"), ("area", "STRING")],
    },
    "bkm_routine_visits": {
        "sql": f"""SELECT t.id AS task_id, t.status AS status,
  {STATE.format(done='Done')} AS state,
  to_date(t.executionPeriod.start) AS visit_month, to_date(t.executionPeriod.end) AS window_end,
  to_date(t.meta.lastUpdated) AS last_updated,
  substring_index(t.`for`.reference, '/', -1) AS patient_id,
  t.owner.practitionerId AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name, loc.name AS area
FROM task t
LEFT JOIN practitioner pr ON pr.id = t.owner.practitionerId
{LOC_JOIN.format(a='t')}
WHERE trim(t.description) = 'Child Visit'""",
        "columns": [("task_id", "STRING"), ("status", "STRING"), ("state", "STRING"),
                    ("visit_month", "DATE"), ("window_end", "DATE"), ("last_updated", "DATE"),
                    ("patient_id", "STRING"), ("vhw_id", "STRING"), ("vhw_name", "STRING"),
                    ("area", "STRING")],
    },
    "bkm_children": {
        "sql": f"""SELECT p.id AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family) AS child_name, p.gender AS gender,
  to_date(p.birthDate) AS birth_date,
  CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months,
  CASE WHEN months_between(current_date(), to_date(p.birthDate)) < 12 THEN '0-11 months'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 24 THEN '12-23 months'
       ELSE '2-4 years' END AS age_group,
  to_date(p.meta.lastUpdated) AS last_updated, loc.name AS area
FROM patient p
{LOC_JOIN.format(a='p')}
WHERE p.active = true AND to_date(p.birthDate) > add_months(current_date(), -60)""",
        "columns": [("patient_id", "STRING"), ("child_name", "STRING"), ("gender", "STRING"),
                    ("birth_date", "DATE"), ("age_months", "INT"), ("age_group", "STRING"),
                    ("last_updated", "DATE"), ("area", "STRING")],
    },
}


def dataset_file(name, spec):
    return {
        "table_name": name, "main_dttm_col": None, "description": None,
        "default_endpoint": None, "offset": 0, "cache_timeout": None, "catalog": None,
        "schema": "default", "sql": spec["sql"], "params": None, "template_params": None,
        "filter_select_enabled": True, "fetch_values_predicate": None, "extra": None,
        "normalize_columns": False, "always_filter_main_dttm": False,
        "uuid": uid("dataset:" + name),
        "metrics": [{"metric_name": "count", "verbose_name": "COUNT(*)", "metric_type": "count",
                     "expression": "COUNT(*)", "description": None, "d3format": None,
                     "extra": None, "warning_text": None}],
        "columns": [{"column_name": c, "verbose_name": None, "is_dttm": t == "DATE",
                     "is_active": True, "type": t, "advanced_data_type": None,
                     "groupby": True, "filterable": True, "expression": None,
                     "description": None, "python_date_format": None, "extra": None}
                    for c, t in spec["columns"]],
        "version": "1.0.0", "database_uuid": DB_UUID,
    }


def adhoc_metric(sql, label):
    return {"expressionType": "SQL", "sqlExpression": sql, "label": label,
            "optionName": "metric_" + label.lower().replace(" ", "_")}


def eq_filter(col, value):
    if isinstance(value, list):
        return {"clause": "WHERE", "expressionType": "SIMPLE", "subject": col, "operator": "IN",
                "comparator": value, "filterOptionName": f"f_{col}_in"}
    return {"clause": "WHERE", "expressionType": "SIMPLE", "subject": col, "operator": "==",
            "comparator": value, "filterOptionName": f"f_{col}_{value}"}


COUNT = adhoc_metric("COUNT(*)", "Doses")
STATE_COLORS = {"Given": "#2e7d32", "Done": "#2e7d32", "Due": "#1565c0", "Overdue": "#c62828",
                "Upcoming": "#9e9e9e", "Expired": "#424242"}

CHARTS = [
    # key, title, dataset, viz, params, width, height
    ("children", "Children under 5", "bkm_children", "big_number_total",
     {"metric": adhoc_metric("COUNT(DISTINCT patient_id)", "Children"), "adhoc_filters": [],
      "subheader": "active children under 5", "y_axis_format": "SMART_NUMBER"}, 3, 30),
    ("given", "Doses given", "bkm_vaccine_tasks", "big_number_total",
     {"metric": COUNT, "adhoc_filters": [eq_filter("state", "Given")],
      "subheader": "vaccine doses recorded as given", "y_axis_format": "SMART_NUMBER"}, 3, 30),
    ("overdue", "Doses overdue", "bkm_vaccine_tasks", "big_number_total",
     {"metric": COUNT, "adhoc_filters": [eq_filter("state", "Overdue")],
      "subheader": "due window passed, not given", "y_axis_format": "SMART_NUMBER"}, 3, 30),
    ("visits_due", "Routine visits due now", "bkm_routine_visits", "big_number_total",
     {"metric": adhoc_metric("COUNT(*)", "Visits"),
      "adhoc_filters": [eq_filter("state", ["Due", "Overdue"])],
      "subheader": "monthly child visits due or overdue", "y_axis_format": "SMART_NUMBER"}, 3, 30),
    ("by_vaccine", "Doses by vaccine and state", "bkm_vaccine_tasks", "echarts_timeseries_bar",
     {"x_axis": "vaccine", "metrics": [COUNT], "groupby": ["state"], "adhoc_filters": [],
      "stack": "Stack", "orientation": "vertical", "row_limit": 10000,
      "x_axis_sort_asc": True, "show_legend": True, "label_colors": STATE_COLORS,
      "truncateXAxis": True, "xAxisLabelRotation": 45}, 8, 60),
    ("age_groups", "Children by age group", "bkm_children", "pie",
     {"groupby": ["age_group"], "metric": adhoc_metric("COUNT(DISTINCT patient_id)", "Children"),
      "adhoc_filters": [], "show_labels": True, "label_type": "key_value", "donut": True,
      "show_legend": True, "row_limit": 100}, 4, 60),
    ("per_vhw", "Vaccines per VHW", "bkm_vaccine_tasks", "pivot_table_v2",
     {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["state"], "metrics": [COUNT],
      "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
      "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 6, 60),
    ("visits_per_vhw", "Routine visits per VHW", "bkm_routine_visits", "pivot_table_v2",
     {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["state"],
      "metrics": [adhoc_metric("COUNT(*)", "Visits")], "adhoc_filters": [],
      "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
      "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 6, 60),
    ("overdue_list", "Overdue doses - follow-up list", "bkm_vaccine_tasks", "table",
     {"query_mode": "raw",
      "all_columns": ["area", "vhw_name", "child_name", "age_months", "vaccine", "window_end"],
      "order_by_cols": [json.dumps(["area", True]), json.dumps(["vhw_name", True])],
      "adhoc_filters": [eq_filter("state", "Overdue")], "row_limit": 1000,
      "include_search": True, "page_length": 50, "server_pagination": False}, 12, 80),
]
ROWS = [["children", "given", "overdue", "visits_due"], ["by_vaccine", "age_groups"],
        ["per_vhw", "visits_per_vhw"], ["overdue_list"]]


def chart_file(key, title, ds, viz, params):
    p = dict(params)
    p.update({"viz_type": viz, "datasource": "__table"})
    return {"slice_name": title, "description": None, "certified_by": None,
            "certification_details": None, "viz_type": viz, "params": p, "query_context": None,
            "cache_timeout": None, "uuid": uid("chart:" + key), "version": "1.0.0",
            "dataset_uuid": uid("dataset:" + ds)}


def dashboard_file():
    spec = {c[0]: c for c in CHARTS}
    pos = {"DASHBOARD_VERSION_KEY": "v2",
           "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
           "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
           "HEADER_ID": {"id": "HEADER_ID", "type": "HEADER", "meta": {"text": "BKM Child Health"}}}
    for r, keys in enumerate(ROWS, 1):
        row_id = f"ROW-{r}"
        pos["GRID_ID"]["children"].append(row_id)
        pos[row_id] = {"type": "ROW", "id": row_id, "children": [],
                       "parents": ["ROOT_ID", "GRID_ID"],
                       "meta": {"background": "BACKGROUND_TRANSPARENT"}}
        for k in keys:
            _, title, _, _, _, w, h = spec[k]
            cid = f"CHART-{k}"
            pos[row_id]["children"].append(cid)
            pos[cid] = {"type": "CHART", "id": cid, "children": [],
                        "parents": ["ROOT_ID", "GRID_ID", row_id],
                        # chartId is required by the importer, which then maps it via uuid
                        "meta": {"width": w, "height": h, "chartId": len(pos),
                                 "uuid": uid("chart:" + k), "sliceName": title}}
    filters = []
    for fid, name, col in [("NATIVE_FILTER-area", "Area", "area"),
                           ("NATIVE_FILTER-vhw", "VHW", "vhw_name")]:
        filters.append({"id": fid, "name": name, "filterType": "filter_select",
                        "type": "NATIVE_FILTER", "description": "",
                        "targets": [{"datasetUuid": uid("dataset:bkm_vaccine_tasks"),
                                     "column": {"name": col}}],
                        "controlValues": {"multiSelect": True, "enableEmptyFilter": False,
                                          "defaultToFirstItem": False, "searchAllOptions": False,
                                          "inverseSelection": False},
                        "defaultDataMask": {"extraFormData": {}, "filterState": {},
                                            "ownState": {}},
                        "cascadeParentIds": ["NATIVE_FILTER-area"] if col == "vhw_name" else [],
                        "scope": {"rootPath": ["ROOT_ID"], "excluded": []}})
    return {"dashboard_title": "BKM Child Health", "description": None, "css": "",
            "slug": "bkm-child-health", "certified_by": None, "certification_details": None,
            "published": True, "uuid": uid("dashboard:bkm-child-health"), "position": pos,
            "metadata": {"native_filter_configuration": filters, "color_scheme": "",
                         "label_colors": STATE_COLORS, "refresh_frequency": 0,
                         "cross_filters_enabled": True, "expanded_slices": {},
                         "timed_refresh_immune_slices": [], "default_filters": "{}",
                         "chart_configuration": {}, "shared_label_colors": []},
            "version": "1.0.0"}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "bkm_child_health_dashboard.zip"
    files = {f"{BUNDLE}/metadata.yaml": {"version": "1.0.0", "type": "Dashboard",
                                          "timestamp": datetime.now(timezone.utc).isoformat()},
             f"{BUNDLE}/databases/BKM_Server.yaml": DB_FILE,
             f"{BUNDLE}/dashboards/BKM_Child_Health.yaml": dashboard_file()}
    for name, spec in DATASETS.items():
        files[f"{BUNDLE}/datasets/BKM_Server/{name}.yaml"] = dataset_file(name, spec)
    for key, title, ds, viz, params, _, _ in CHARTS:
        files[f"{BUNDLE}/charts/{key}.yaml"] = chart_file(key, title, ds, viz, params)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, content in files.items():
            # JSON is valid YAML, so no PyYAML is needed to build the bundle
            z.writestr(path, json.dumps(content, indent=2))
    open(out, "wb").write(buf.getvalue())
    print(f"wrote {out}: {len(DATASETS)} datasets, {len(CHARTS)} charts, 1 dashboard")


if __name__ == "__main__":
    main()
