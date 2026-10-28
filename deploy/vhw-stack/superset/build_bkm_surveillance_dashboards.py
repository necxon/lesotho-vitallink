#!/usr/bin/env python3
"""Build a Superset import bundle (zip) with three dashboards for the forms added in October 2026:

  BKM EBS Signals        one row per "Register EBS Signal" form (event-based surveillance)
  BKM Disease Follow-up  one row per "Record Disease FollowUp" form (adherence, blood pressure, glucose)
  BKM Disease Register   one row per person and disease from "Register with Disease" (Conditions)
  BKM Lesotho Map        10 districts coloured by people, children, households, overdue doses, EBS, follow-ups, disease

Superset: Dashboards -> Import dashboard -> pick the zip (tick "overwrite" to update). It reuses the existing
BKM_Server database (Spark/Hive on the fhir-data-pipes Parquet output) by its UUID, so nothing is created
twice. UUIDs are fixed: re-importing updates instead of duplicating.

  python3 build_bkm_surveillance_dashboards.py [out.zip]          # ACTIVITY version: counts from Encounters
  python3 build_bkm_surveillance_dashboards.py out.zip --full     # DETAILED version: needs QuestionnaireResponse

The activity version works with the pipeline as it is (it has no QuestionnaireResponse table yet): signals and
follow-ups per month, area, VHW, household or person. The detailed version adds the answers (signal type,
deaths, adherence, blood pressure, glucose ...). Both use the same dataset and dashboard names, so importing
the detailed one later upgrades the dashboards in place (tick overwrite).

The queries read these pipeline tables: questionnaireresponse, `group`, patient, practitioner, location,
condition. The form answers are found by their linkId, which is derived the same way as in
tools/load_followup_and_ebs_forms.py (uuid5 of "bkm/<form>/<question>"). If a chart is empty, run
bkm_surveillance_checks.sql in SQL Lab first: it counts the rows each dataset should see.
"""
import io
import json
import os
import sys
import uuid
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_bkm_dashboard as base  # noqa: E402  (same folder: helpers and the BKM_Server database)
from bkm_district_sql import (DERIVED as DISTRICT_DERIVED, METRICS as DISTRICT_METRICS,  # noqa: E402
                              district_disease_sql, district_metrics_sql)

BUNDLE = "bkm_surveillance"
EBS_Q = "23a71526-de52-4252-8268-e99185b14e3b"        # Questionnaire ids (see the loader script)
FOLLOWUP_Q = "e14b5743-0a06-4ab5-aaee-ac158d4cb64f"
SNOMED = "http://snomed.info/sct"


def lid(form, name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"bkm/{form}/{name}"))


def ans(form, name, kind):
    """One answer value of a questionnaire response row `qr`, found by the question's linkId."""
    return f"element_at(filter(qr.item, x -> x.linkId = '{lid(form, name)}'), 1).answer[0].{kind}"


def case(expr, mapping, other="Other"):
    """Readable label for a code: a known code gets its label, an unknown one 'Other', an empty answer stays empty."""
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in mapping.items())
    return f"CASE {expr} {whens} ELSE if({expr} IS NULL, NULL, '{other}') END"


EBS_TYPES = {
    "illness-cluster": "Several people sick",
    "unexplained-deaths": "Unexplained deaths",
    "suspected-outbreak": "Suspected outbreak",
    "animal-illness": "Sick or dead animals",
    "water-food": "Contaminated water or food",
    "environmental": "Environmental hazard",
    "other": "Other",
}
ADHERENCE = {
    "regularly": "Takes medication regularly",
    "sometimes-misses": "Sometimes misses doses",
    "not-taking": "Not taking medication",
    "none-prescribed": "No medication prescribed",
}
DISEASES = {
    "hiv": "HIV", "tb": "Tuberculosis (TB)", "mental-health": "Mental health",
    "diabetes-mellitus": "Diabetes mellitus", "cancer": "Cancer", "asthma": "Asthma", "stroke": "Stroke",
    "hypertension": "Hypertension", "epilepsy": "Epilepsy", "paralysis": "Paralysis",
    "liver-disease": "Liver disease", "goitre": "Goitre", "kidney-disease": "Kidney disease", "leprosy": "Leprosy",
}
YESNO = {"yes": "Yes", "no": "No"}

VHW_ID = ("COALESCE(substring_index(qr.author.reference, '/', -1), element_at(filter(qr.meta.tag, "
          "x -> x.system = 'https://smartregister.org/practitioner-tag-id'), 1).code)")

DATASETS = {
    "bkm_ebs_signals": {
        "sql": f"""SELECT qr.id AS qr_id,
  to_date({ans('ebs', 'date', 'valueDate')}) AS signal_date,
  trunc(to_date({ans('ebs', 'date', 'valueDate')}), 'MM') AS signal_month,
  to_date(qr.authored) AS recorded_on,
  {ans('ebs', 'type', 'valueCoding.code')} AS signal_type_code,
  {case(ans('ebs', 'type', 'valueCoding.code'), EBS_TYPES)} AS signal_type,
  {ans('ebs', 'place', 'valueString')} AS place,
  {ans('ebs', 'affected', 'valueInteger')} AS people_sick,
  {ans('ebs', 'deaths', 'valueInteger')} AS deaths,
  {case(ans('ebs', 'reported', 'valueCoding.code'), YESNO)} AS reported_to_facility,
  {ans('ebs', 'description', 'valueString')} AS description,
  {ans('ebs', 'action', 'valueString')} AS action_taken,
  substring_index(qr.subject.reference, '/', -1) AS household_id,
  g.name AS household,
  {VHW_ID} AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name,
  loc.name AS area
FROM questionnaireresponse qr
LEFT JOIN `group` g ON g.id = substring_index(qr.subject.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = {VHW_ID}
{base.LOC_JOIN.format(a='qr')}
WHERE qr.questionnaire LIKE '%{EBS_Q}%'""",
        "columns": [("qr_id", "STRING"), ("signal_date", "DATE"), ("signal_month", "DATE"), ("recorded_on", "DATE"),
                    ("signal_type_code", "STRING"), ("signal_type", "STRING"), ("place", "STRING"),
                    ("people_sick", "INT"), ("deaths", "INT"), ("reported_to_facility", "STRING"),
                    ("description", "STRING"), ("action_taken", "STRING"), ("household_id", "STRING"),
                    ("household", "STRING"), ("vhw_id", "STRING"), ("vhw_name", "STRING"), ("area", "STRING")],
    },
    "bkm_disease_followups": {
        "sql": f"""SELECT qr.id AS qr_id,
  to_date({ans('followup', 'date', 'valueDate')}) AS followup_date,
  trunc(to_date({ans('followup', 'date', 'valueDate')}), 'MM') AS followup_month,
  to_date(qr.authored) AS recorded_on,
  {ans('followup', 'disease', 'valueCoding.code')} AS disease_code,
  {case(ans('followup', 'disease', 'valueCoding.code'), DISEASES)} AS disease,
  {case(ans('followup', 'medication', 'valueCoding.code'), ADHERENCE)} AS medication,
  {ans('followup', 'systolic', 'valueInteger')} AS systolic,
  {ans('followup', 'diastolic', 'valueInteger')} AS diastolic,
  CASE WHEN {ans('followup', 'systolic', 'valueInteger')} IS NULL
         OR {ans('followup', 'diastolic', 'valueInteger')} IS NULL THEN 'Not measured'
       WHEN {ans('followup', 'systolic', 'valueInteger')} < 140
         AND {ans('followup', 'diastolic', 'valueInteger')} < 90 THEN 'Controlled'
       ELSE 'Not controlled' END AS blood_pressure,
  {ans('followup', 'glucose', 'valueDecimal')} AS glucose_mmol,
  {case(ans('followup', 'new-symptoms', 'valueCoding.code'), YESNO)} AS new_symptoms,
  {case(ans('followup', 'referred', 'valueCoding.code'), YESNO)} AS referred,
  to_date({ans('followup', 'next-visit', 'valueDate')}) AS next_visit,
  substring_index(qr.subject.reference, '/', -1) AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family) AS patient_name,
  p.gender AS gender,
  CAST(months_between(current_date(), to_date(p.birthDate)) / 12 AS INT) AS age_years,
  {VHW_ID} AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name,
  loc.name AS area
FROM questionnaireresponse qr
LEFT JOIN patient p ON p.id = substring_index(qr.subject.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = {VHW_ID}
{base.LOC_JOIN.format(a='qr')}
WHERE qr.questionnaire LIKE '%{FOLLOWUP_Q}%'""",
        "columns": [("qr_id", "STRING"), ("followup_date", "DATE"), ("followup_month", "DATE"), ("recorded_on", "DATE"),
                    ("disease_code", "STRING"), ("disease", "STRING"), ("medication", "STRING"),
                    ("systolic", "INT"), ("diastolic", "INT"), ("blood_pressure", "STRING"),
                    ("glucose_mmol", "DOUBLE"), ("new_symptoms", "STRING"), ("referred", "STRING"),
                    ("next_visit", "DATE"), ("patient_id", "STRING"), ("patient_name", "STRING"),
                    ("gender", "STRING"), ("age_years", "INT"), ("vhw_id", "STRING"), ("vhw_name", "STRING"),
                    ("area", "STRING")],
    },
    "bkm_disease_register": {
        "sql": f"""SELECT c.id AS condition_id,
  c.code.text AS disease,
  element_at(c.code.coding, 1).code AS disease_code,
  to_date(c.recordedDate) AS registered_on,
  trunc(to_date(c.recordedDate), 'MM') AS registered_month,
  substring_index(c.subject.reference, '/', -1) AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family) AS patient_name,
  p.gender AS gender,
  CAST(months_between(current_date(), to_date(p.birthDate)) / 12 AS INT) AS age_years,
  CASE WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 15 THEN 'Under 15'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 45 THEN '15-44'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 65 THEN '45-64'
       ELSE '65 and over' END AS age_group,
  loc.name AS area
FROM condition c
LEFT JOIN patient p ON p.id = substring_index(c.subject.reference, '/', -1)
{base.LOC_JOIN.format(a='c')}
WHERE element_at(c.code.coding, 1).system = '{SNOMED}'
  AND exists(c.category, cat -> exists(cat.coding, x -> x.code = 'encounter-diagnosis'))
  AND exists(c.clinicalStatus.coding, x -> x.code = 'active')""",
        "columns": [("condition_id", "STRING"), ("disease", "STRING"), ("disease_code", "STRING"),
                    ("registered_on", "DATE"), ("registered_month", "DATE"), ("patient_id", "STRING"),
                    ("patient_name", "STRING"), ("gender", "STRING"), ("age_years", "INT"),
                    ("age_group", "STRING"), ("area", "STRING")],
    },
}

am = base.adhoc_metric
ef = base.eq_filter


def count(label):
    return am("COUNT(*)", label)


# chart: key, title, dataset, viz, params, width, height
CHARTS = {
    "ebs": [
        ("ebs_total", "EBS signals", "bkm_ebs_signals", "big_number_total",
         {"metric": count("Signals"), "adhoc_filters": [], "subheader": "signals registered",
          "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("ebs_30d", "Last 30 days", "bkm_ebs_signals", "big_number_total",
         {"metric": am("SUM(CASE WHEN recorded_on >= date_sub(current_date(), 30) THEN 1 ELSE 0 END)", "Signals 30d"),
          "adhoc_filters": [], "subheader": "signals recorded in the last 30 days", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("ebs_sick", "People sick", "bkm_ebs_signals", "big_number_total",
         {"metric": am("SUM(people_sick)", "People sick"), "adhoc_filters": [],
          "subheader": "reported across all signals", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("ebs_deaths", "Deaths reported", "bkm_ebs_signals", "big_number_total",
         {"metric": am("SUM(deaths)", "Deaths"), "adhoc_filters": [],
          "subheader": "reported across all signals", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("ebs_by_type", "Signals by type", "bkm_ebs_signals", "echarts_timeseries_bar",
         {"x_axis": "signal_type", "metrics": [count("Signals")], "groupby": [], "adhoc_filters": [],
          "orientation": "horizontal", "row_limit": 1000, "x_axis_sort_asc": True, "show_legend": False}, 6, 60),
        ("ebs_by_month", "Signals per month", "bkm_ebs_signals", "echarts_timeseries_bar",
         {"x_axis": "signal_month", "time_grain_sqla": "P1M", "metrics": [count("Signals")],
          "groupby": ["signal_type"], "adhoc_filters": [], "stack": "Stack", "row_limit": 10000,
          "show_legend": True}, 6, 60),
        ("ebs_by_area", "Signals by area", "bkm_ebs_signals", "pie",
         {"groupby": ["area"], "metric": count("Signals"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 100}, 4, 60),
        ("ebs_reported", "Reported to a facility?", "bkm_ebs_signals", "pie",
         {"groupby": ["reported_to_facility"], "metric": count("Signals"), "adhoc_filters": [],
          "show_labels": True, "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 10}, 4, 60),
        ("ebs_per_vhw", "Signals per VHW", "bkm_ebs_signals", "pivot_table_v2",
         {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["signal_type"], "metrics": [count("Signals")],
          "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
          "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 12, 60),
        ("ebs_list", "Latest signals", "bkm_ebs_signals", "table",
         {"query_mode": "raw", "all_columns": ["signal_date", "area", "place", "signal_type", "people_sick",
                                                "deaths", "reported_to_facility", "vhw_name", "description"],
          "order_by_cols": [json.dumps(["signal_date", False])], "adhoc_filters": [], "row_limit": 500,
          "include_search": True, "page_length": 25, "server_pagination": False}, 12, 80),
    ],
    "fu": [
        ("fu_total", "Follow-up visits", "bkm_disease_followups", "big_number_total",
         {"metric": count("Visits"), "adhoc_filters": [], "subheader": "follow-up forms recorded",
          "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("fu_people", "People followed up", "bkm_disease_followups", "big_number_total",
         {"metric": am("COUNT(DISTINCT patient_id)", "People"), "adhoc_filters": [],
          "subheader": "different people", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("fu_missing", "Missing doses or no medication", "bkm_disease_followups", "big_number_total",
         {"metric": count("Visits"), "adhoc_filters": [ef("medication", ["Sometimes misses doses",
                                                                            "Not taking medication"])],
          "subheader": "visits where adherence is a concern", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("fu_referred", "Referred to a facility", "bkm_disease_followups", "big_number_total",
         {"metric": count("Visits"), "adhoc_filters": [ef("referred", "Yes")],
          "subheader": "visits ending in a referral", "y_axis_format": "SMART_NUMBER"}, 3, 30),
        ("fu_by_disease", "Follow-ups by disease", "bkm_disease_followups", "echarts_timeseries_bar",
         {"x_axis": "disease", "metrics": [count("Visits")], "groupby": [], "adhoc_filters": [],
          "orientation": "horizontal", "row_limit": 1000, "x_axis_sort_asc": True, "show_legend": False}, 6, 60),
        ("fu_by_month", "Follow-ups per month", "bkm_disease_followups", "echarts_timeseries_bar",
         {"x_axis": "followup_month", "time_grain_sqla": "P1M", "metrics": [count("Visits")],
          "groupby": ["disease"], "adhoc_filters": [], "stack": "Stack", "row_limit": 10000,
          "show_legend": True}, 6, 60),
        ("fu_adherence", "Medication adherence", "bkm_disease_followups", "pie",
         {"groupby": ["medication"], "metric": count("Visits"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 10}, 4, 60),
        ("fu_bp", "Blood pressure control", "bkm_disease_followups", "pie",
         {"groupby": ["blood_pressure"], "metric": count("Visits"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 10}, 4, 60),
        ("fu_symptoms", "New symptoms reported", "bkm_disease_followups", "pie",
         {"groupby": ["new_symptoms"], "metric": count("Visits"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 10}, 4, 60),
        ("fu_per_vhw", "Follow-ups per VHW", "bkm_disease_followups", "pivot_table_v2",
         {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["disease"], "metrics": [count("Visits")],
          "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
          "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 12, 60),
        ("fu_attention", "Needs attention - list", "bkm_disease_followups", "table",
         {"query_mode": "raw", "all_columns": ["followup_date", "area", "vhw_name", "patient_name", "disease",
                                                "medication", "systolic", "diastolic", "glucose_mmol",
                                                "new_symptoms", "referred", "next_visit"],
          "order_by_cols": [json.dumps(["followup_date", False])],
          "adhoc_filters": [{"clause": "WHERE", "expressionType": "SQL",
                              "sqlExpression": "medication IN ('Sometimes misses doses','Not taking medication') "
                                               "OR blood_pressure = 'Not controlled' OR new_symptoms = 'Yes'"}],
          "row_limit": 1000, "include_search": True, "page_length": 25, "server_pagination": False}, 12, 80),
    ],
    "reg": [
        ("reg_people", "People registered with a disease", "bkm_disease_register", "big_number_total",
         {"metric": am("COUNT(DISTINCT patient_id)", "People"), "adhoc_filters": [],
          "subheader": "different people with an active disease", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("reg_total", "Disease registrations", "bkm_disease_register", "big_number_total",
         {"metric": count("Registrations"), "adhoc_filters": [], "subheader": "person-and-disease entries",
          "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("reg_new", "New in the last 30 days", "bkm_disease_register", "big_number_total",
         {"metric": am("SUM(CASE WHEN registered_on >= date_sub(current_date(), 30) THEN 1 ELSE 0 END)", "New 30d"),
          "adhoc_filters": [], "subheader": "registered in the last 30 days", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("reg_by_disease", "People by disease", "bkm_disease_register", "echarts_timeseries_bar",
         {"x_axis": "disease", "metrics": [am("COUNT(DISTINCT patient_id)", "People")], "groupby": [],
          "adhoc_filters": [], "orientation": "horizontal", "row_limit": 1000, "x_axis_sort_asc": True,
          "show_legend": False}, 8, 60),
        ("reg_age", "By age group", "bkm_disease_register", "pie",
         {"groupby": ["age_group"], "metric": am("COUNT(DISTINCT patient_id)", "People"), "adhoc_filters": [],
          "show_labels": True, "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 10}, 4, 60),
        ("reg_by_month", "Registrations per month", "bkm_disease_register", "echarts_timeseries_bar",
         {"x_axis": "registered_month", "time_grain_sqla": "P1M", "metrics": [count("Registrations")],
          "groupby": ["disease"], "adhoc_filters": [], "stack": "Stack", "row_limit": 10000,
          "show_legend": True}, 12, 60),
        ("reg_by_area", "Disease by area", "bkm_disease_register", "pivot_table_v2",
         {"groupbyRows": ["area"], "groupbyColumns": ["disease"], "metrics": [count("Registrations")],
          "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
          "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 12, 60),
    ],
}

DASHBOARDS = {
    "ebs": {"title": "BKM EBS Signals", "slug": "bkm-ebs-signals", "dataset": "bkm_ebs_signals",
            "rows": [["ebs_total", "ebs_30d", "ebs_sick", "ebs_deaths"], ["ebs_by_type", "ebs_by_month"],
                     ["ebs_by_area", "ebs_reported"], ["ebs_per_vhw"], ["ebs_list"]],
            "filters": [("area", "Area"), ("signal_type", "Signal type")]},
    "fu": {"title": "BKM Disease Follow-up", "slug": "bkm-disease-followup", "dataset": "bkm_disease_followups",
           "rows": [["fu_total", "fu_people", "fu_missing", "fu_referred"], ["fu_by_disease", "fu_by_month"],
                    ["fu_adherence", "fu_bp", "fu_symptoms"], ["fu_per_vhw"], ["fu_attention"]],
           "filters": [("area", "Area"), ("vhw_name", "VHW"), ("disease", "Disease")]},
    "reg": {"title": "BKM Disease Register", "slug": "bkm-disease-register", "dataset": "bkm_disease_register",
            "rows": [["reg_people", "reg_total", "reg_new"], ["reg_by_disease", "reg_age"], ["reg_by_month"],
                     ["reg_by_area"]],
            "filters": [("area", "Area"), ("disease", "Disease")]},
}


# ---- activity version (default): works with the pipeline as it is today (no QuestionnaireResponse table) ----
# Each form also saves an Encounter (type code ebs_signal / disease_followup, date, who it is about, area and VHW
# tags), but not the answers. This gives counts per month, area, VHW and household or person. Use --full for the
# detailed version once QuestionnaireResponse is exported by the pipeline.
ENC_VHW = ("element_at(filter(e.meta.tag, x -> x.system = 'https://smartregister.org/practitioner-tag-id'), 1).code")
ENC_DATASETS = {
    "bkm_ebs_signals": {
        "sql": f"""SELECT e.id AS encounter_id,
  to_date(e.period.start) AS signal_date,
  trunc(to_date(e.period.start), 'MM') AS signal_month,
  to_date(e.meta.lastUpdated) AS last_updated,
  substring_index(e.subject.reference, '/', -1) AS household_id,
  g.name AS household,
  {ENC_VHW} AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name,
  loc.name AS area
FROM encounter e
LEFT JOIN `group` g ON g.id = substring_index(e.subject.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = {ENC_VHW}
{base.LOC_JOIN.format(a='e')}
WHERE exists(e.type, t -> exists(t.coding, c -> c.code = 'ebs_signal'))""",
        "columns": [("encounter_id", "STRING"), ("signal_date", "DATE"), ("signal_month", "DATE"),
                    ("last_updated", "DATE"), ("household_id", "STRING"), ("household", "STRING"),
                    ("vhw_id", "STRING"), ("vhw_name", "STRING"), ("area", "STRING")],
    },
    "bkm_disease_followups": {
        "sql": f"""SELECT e.id AS encounter_id,
  to_date(e.period.start) AS followup_date,
  trunc(to_date(e.period.start), 'MM') AS followup_month,
  to_date(e.meta.lastUpdated) AS last_updated,
  substring_index(e.subject.reference, '/', -1) AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family) AS patient_name,
  p.gender AS gender,
  CAST(months_between(current_date(), to_date(p.birthDate)) / 12 AS INT) AS age_years,
  {ENC_VHW} AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw_name,
  loc.name AS area
FROM encounter e
LEFT JOIN patient p ON p.id = substring_index(e.subject.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = {ENC_VHW}
{base.LOC_JOIN.format(a='e')}
WHERE exists(e.type, t -> exists(t.coding, c -> c.code = 'disease_followup'))""",
        "columns": [("encounter_id", "STRING"), ("followup_date", "DATE"), ("followup_month", "DATE"),
                    ("last_updated", "DATE"), ("patient_id", "STRING"), ("patient_name", "STRING"),
                    ("gender", "STRING"), ("age_years", "INT"), ("vhw_id", "STRING"), ("vhw_name", "STRING"),
                    ("area", "STRING")],
    },
}
ENC_CHARTS = {
    "ebs": [
        ("ebs_total", "EBS signals", "bkm_ebs_signals", "big_number_total",
         {"metric": count("Signals"), "adhoc_filters": [], "subheader": "signals registered",
          "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("ebs_30d", "Last 30 days", "bkm_ebs_signals", "big_number_total",
         {"metric": am("SUM(CASE WHEN signal_date >= date_sub(current_date(), 30) THEN 1 ELSE 0 END)", "Signals 30d"),
          "adhoc_filters": [], "subheader": "signals in the last 30 days", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("ebs_households", "Households with a signal", "bkm_ebs_signals", "big_number_total",
         {"metric": am("COUNT(DISTINCT household_id)", "Households"), "adhoc_filters": [],
          "subheader": "different households", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("ebs_by_month", "Signals per month", "bkm_ebs_signals", "echarts_timeseries_bar",
         {"x_axis": "signal_month", "time_grain_sqla": "P1M", "metrics": [count("Signals")], "groupby": [],
          "adhoc_filters": [], "row_limit": 10000, "show_legend": False}, 8, 60),
        ("ebs_by_area", "Signals by area", "bkm_ebs_signals", "pie",
         {"groupby": ["area"], "metric": count("Signals"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 100}, 4, 60),
        ("ebs_per_vhw", "Signals per VHW", "bkm_ebs_signals", "pivot_table_v2",
         {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["signal_month"], "metrics": [count("Signals")],
          "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
          "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 12, 60),
        ("ebs_list", "Latest signals", "bkm_ebs_signals", "table",
         {"query_mode": "raw", "all_columns": ["signal_date", "area", "household", "vhw_name"],
          "order_by_cols": [json.dumps(["signal_date", False])], "adhoc_filters": [], "row_limit": 500,
          "include_search": True, "page_length": 25, "server_pagination": False}, 12, 70),
    ],
    "fu": [
        ("fu_total", "Follow-up visits", "bkm_disease_followups", "big_number_total",
         {"metric": count("Visits"), "adhoc_filters": [], "subheader": "follow-up forms recorded",
          "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("fu_people", "People followed up", "bkm_disease_followups", "big_number_total",
         {"metric": am("COUNT(DISTINCT patient_id)", "People"), "adhoc_filters": [],
          "subheader": "different people", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("fu_30d", "Last 30 days", "bkm_disease_followups", "big_number_total",
         {"metric": am("SUM(CASE WHEN followup_date >= date_sub(current_date(), 30) THEN 1 ELSE 0 END)", "Visits 30d"),
          "adhoc_filters": [], "subheader": "visits in the last 30 days", "y_axis_format": "SMART_NUMBER"}, 4, 30),
        ("fu_by_month", "Follow-ups per month", "bkm_disease_followups", "echarts_timeseries_bar",
         {"x_axis": "followup_month", "time_grain_sqla": "P1M", "metrics": [count("Visits")], "groupby": [],
          "adhoc_filters": [], "row_limit": 10000, "show_legend": False}, 8, 60),
        ("fu_by_area", "Follow-ups by area", "bkm_disease_followups", "pie",
         {"groupby": ["area"], "metric": count("Visits"), "adhoc_filters": [], "show_labels": True,
          "label_type": "key_value", "donut": True, "show_legend": True, "row_limit": 100}, 4, 60),
        ("fu_per_vhw", "Follow-ups per VHW", "bkm_disease_followups", "pivot_table_v2",
         {"groupbyRows": ["area", "vhw_name"], "groupbyColumns": ["followup_month"], "metrics": [count("Visits")],
          "adhoc_filters": [], "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True,
          "valueFormat": "SMART_NUMBER", "row_limit": 10000}, 12, 60),
        ("fu_list", "Latest follow-ups", "bkm_disease_followups", "table",
         {"query_mode": "raw", "all_columns": ["followup_date", "area", "vhw_name", "patient_name", "gender",
                                                "age_years"],
          "order_by_cols": [json.dumps(["followup_date", False])], "adhoc_filters": [], "row_limit": 1000,
          "include_search": True, "page_length": 25, "server_pagination": False}, 12, 70),
    ],
    "reg": CHARTS["reg"],
}
ENC_DASHBOARDS = {
    "ebs": {**DASHBOARDS["ebs"], "rows": [["ebs_total", "ebs_30d", "ebs_households"], ["ebs_by_month", "ebs_by_area"],
                                          ["ebs_per_vhw"], ["ebs_list"]],
            "filters": [("area", "Area"), ("vhw_name", "VHW")]},
    "fu": {**DASHBOARDS["fu"], "rows": [["fu_total", "fu_people", "fu_30d"], ["fu_by_month", "fu_by_area"],
                                        ["fu_per_vhw"], ["fu_list"]],
           "filters": [("area", "Area"), ("vhw_name", "VHW")]},
    "reg": DASHBOARDS["reg"],
}
if "--full" not in sys.argv:
    DATASETS = {**ENC_DATASETS, "bkm_disease_register": DATASETS["bkm_disease_register"]}
    CHARTS, DASHBOARDS = ENC_CHARTS, ENC_DASHBOARDS

# ---- Lesotho map: colour the 10 districts (Superset's bundled lesotho map, ISO codes LS-A ... LS-K) ----
_MAP_FIGURES = [(col, label) for col, label, *_ in DISTRICT_METRICS] + [(col, label) for col, label, _ in DISTRICT_DERIVED]
DATASETS["bkm_district_metrics"] = {
    "sql": district_metrics_sql(),
    "columns": [("iso", "STRING"), ("district", "STRING")] + [(col, "BIGINT") for col, *_ in DISTRICT_METRICS]
               + [(col, "DOUBLE") for col, _, _ in DISTRICT_DERIVED],
}
DATASETS["bkm_district_disease"] = {
    "sql": district_disease_sql(),
    "columns": [("iso", "STRING"), ("disease", "STRING"), ("people", "BIGINT")],
}


def _map_chart(col, label, scheme, ds="bkm_district_metrics", metric=None, key=None):
    return (key or "map_" + col, label + " by district", ds, "country_map",
            {"select_country": "lesotho", "entity": "iso", "metric": metric or am(f"MAX({col})", label),
             "adhoc_filters": [], "linear_color_scheme": scheme, "number_format": "SMART_NUMBER",
             "show_bubbles": False}, 6, 70)


# red = something to act on (higher is worse); blue-white-yellow = plain amounts or "higher is better"
_BAD = "red_yellow_blue"
_PLAIN = "blue_white_yellow"
_MAP_SCHEMES = {"overdue_doses": _BAD, "overdue_visits": _BAD, "children_no_vaccine": _BAD,
                "overdue_per_100_children": _BAD, "ebs_signals": _BAD, "people_per_active_vhw": _BAD}
CHARTS["map"] = [_map_chart(col, label, _MAP_SCHEMES.get(col, _PLAIN)) for col, label in _MAP_FIGURES] + [
    _map_chart("disease_pick", "People with the chosen disease", _PLAIN, ds="bkm_district_disease",
               metric=am("SUM(people)", "People"), key="map_disease_pick"),
    ("map_table", "All figures by district", "bkm_district_metrics", "table",
     {"query_mode": "raw", "all_columns": ["district"] + [c for c, _ in _MAP_FIGURES],
      "order_by_cols": [json.dumps(["district", True])], "adhoc_filters": [], "row_limit": 20,
      "include_search": False, "page_length": 11, "server_pagination": False}, 12, 60)]
DASHBOARDS["map"] = {
    "title": "BKM Lesotho Map", "slug": "bkm-lesotho-map", "dataset": "bkm_district_metrics",
    "rows": [["map_people", "map_children_u5"], ["map_people_65plus", "map_households"],
             ["map_vaccine_coverage_pct", "map_overdue_per_100_children"], ["map_doses_given", "map_overdue_doses"],
             ["map_overdue_visits", "map_children_no_vaccine"], ["map_encounters_30d", "map_active_vhws_30d"],
             ["map_people_per_active_vhw", "map_ebs_signals"], ["map_followups", "map_disease_people"],
             ["map_disease_pick"], ["map_table"]],
    "filters": [("disease", "Disease (for the last disease map)", "bkm_district_disease")]}

# ---- data freshness: a number at the top of every dashboard, so a stalled pipeline is visible ----
# (19 Oct 2026: the pipeline loaded nothing for six days and the dashboards looked merely empty.)
DATASETS["bkm_data_freshness"] = {
    "sql": """SELECT max(to_date(meta.lastUpdated)) AS newest_record,
  datediff(current_date(), max(to_date(meta.lastUpdated))) AS days_old
FROM encounter""",
    "columns": [("newest_record", "DATE"), ("days_old", "INT")],
}
for _k in DASHBOARDS:
    CHARTS[_k] = [("fresh_" + _k, "Days since the newest data", "bkm_data_freshness", "big_number_total",
                   {"metric": am("MAX(days_old)", "Days"), "adhoc_filters": [],
                    "subheader": "0-1 is normal; more means the analytics pipeline has stopped loading",
                    "y_axis_format": "SMART_NUMBER"}, 12, 30)] + list(CHARTS[_k])
    DASHBOARDS[_k] = {**DASHBOARDS[_k], "rows": [["fresh_" + _k]] + [list(r) for r in DASHBOARDS[_k]["rows"]]}


def dashboard_file(key, d):
    spec = {c[0]: c for c in CHARTS[key]}
    pos = {"DASHBOARD_VERSION_KEY": "v2",
           "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
           "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
           "HEADER_ID": {"id": "HEADER_ID", "type": "HEADER", "meta": {"text": d["title"]}}}
    for r, keys in enumerate(d["rows"], 1):
        row_id = f"ROW-{r}"
        pos["GRID_ID"]["children"].append(row_id)
        pos[row_id] = {"type": "ROW", "id": row_id, "children": [], "parents": ["ROOT_ID", "GRID_ID"],
                       "meta": {"background": "BACKGROUND_TRANSPARENT"}}
        for k in keys:
            _, title, _, _, _, w, h = spec[k]
            cid = f"CHART-{k}"
            pos[row_id]["children"].append(cid)
            pos[cid] = {"type": "CHART", "id": cid, "children": [], "parents": ["ROOT_ID", "GRID_ID", row_id],
                        "meta": {"width": w, "height": h, "chartId": len(pos), "uuid": base.uid("chart:" + k),
                                 "sliceName": title}}
    filters = []
    for item in d["filters"]:
        col, name = item[0], item[1]
        ds_name = item[2] if len(item) > 2 else d["dataset"]  # a filter can target another dataset of the dashboard
        fid = f"NATIVE_FILTER-{key}-{col}"
        filters.append({"id": fid, "name": name, "filterType": "filter_select", "type": "NATIVE_FILTER",
                        "description": "",
                        "targets": [{"datasetUuid": base.uid("dataset:" + ds_name), "column": {"name": col}}],
                        "controlValues": {"multiSelect": True, "enableEmptyFilter": False,
                                          "defaultToFirstItem": False, "searchAllOptions": False,
                                          "inverseSelection": False},
                        "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
                        "cascadeParentIds": [], "scope": {"rootPath": ["ROOT_ID"], "excluded": []}})
    return {"dashboard_title": d["title"], "description": None, "css": "", "slug": d["slug"],
            "certified_by": None, "certification_details": None, "published": True,
            "uuid": base.uid("dashboard:" + d["slug"]), "position": pos,
            "metadata": {"native_filter_configuration": filters, "color_scheme": "", "label_colors": {},
                         "refresh_frequency": 0, "cross_filters_enabled": True, "expanded_slices": {},
                         "timed_refresh_immune_slices": [], "default_filters": "{}", "chart_configuration": {},
                         "shared_label_colors": []},
            "version": "1.0.0"}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = args[0] if args else "bkm_surveillance_dashboards.zip"
    files = {f"{BUNDLE}/metadata.yaml": {"version": "1.0.0", "type": "Dashboard",
                                          "timestamp": datetime.now(timezone.utc).isoformat()},
             f"{BUNDLE}/databases/BKM_Server.yaml": base.DB_FILE}
    for name, spec in DATASETS.items():
        files[f"{BUNDLE}/datasets/BKM_Server/{name}.yaml"] = base.dataset_file(name, spec)
    n_charts = 0
    for key, d in DASHBOARDS.items():
        files[f"{BUNDLE}/dashboards/{d['title'].replace(' ', '_').replace('-', '_')}.yaml"] = dashboard_file(key, d)
        for ckey, title, ds, viz, params, _, _ in CHARTS[key]:
            files[f"{BUNDLE}/charts/{ckey}.yaml"] = base.chart_file(ckey, title, ds, viz, params)
            n_charts += 1
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, content in files.items():
            z.writestr(path, json.dumps(content, indent=2))  # JSON is valid YAML
    open(out, "wb").write(buf.getvalue())
    print(f"wrote {out}: {len(DATASETS)} datasets, {n_charts} charts, {len(DASHBOARDS)} dashboards")


if __name__ == "__main__":
    main()
