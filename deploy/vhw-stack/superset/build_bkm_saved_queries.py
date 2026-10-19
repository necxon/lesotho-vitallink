#!/usr/bin/env python3
"""Build a Superset import bundle (zip) of saved queries for SQL Lab: "BKM Lesotho query library".

Superset: SQL Lab -> Saved Queries -> Import -> pick the zip (tick overwrite to update). The queries appear in
the saved-queries list under the BKM_Server database, named "BKM <topic> - <what it answers>" so they sort by topic.
Every query is read-only SQL on the fhir-data-pipes tables (patient, group, task, encounter, condition, ...).

  python3 build_bkm_saved_queries.py [out.zip]     # also writes bkm_query_library.sql next to the zip

Notes for the analysts:
 - Run one query at a time (select it, then Run). Most listings are limited to 500 rows: raise LIMIT as needed.
 - Area = the location the record is tagged with in the app (the village / health facility area).
 - VHW = the practitioner the record is tagged with.
 - Follow-up, EBS and disease-registration forms are new (October 2026): their queries return few rows at first.
"""
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_bkm_dashboard as base  # noqa: E402  (same folder: BKM_Server database and helpers)
from bkm_district_sql import district_metrics_sql  # noqa: E402

BUNDLE = "bkm_query_library"
LOC = base.LOC_JOIN
TASK_STATE = base.STATE  # state logic shared with the child-health dashboard
PRAC_TAG = "element_at(filter({a}.meta.tag, x -> x.system = 'https://smartregister.org/practitioner-tag-id'), 1).code"
VHW = PRAC_TAG.format(a="e")
SNOMED = "http://snomed.info/sct"
DISEASE_COND = (f"element_at(c.code.coding, 1).system = '{SNOMED}'\n"
                "  AND exists(c.category, cat -> exists(cat.coding, x -> x.code = 'encounter-diagnosis'))\n"
                "  AND exists(c.clinicalStatus.coding, x -> x.code = 'active')")
AGE_GROUP = """CASE WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 5 THEN 'Under 5'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 15 THEN '5-14'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 45 THEN '15-44'
       WHEN months_between(current_date(), to_date(p.birthDate)) < 12 * 65 THEN '45-64'
       ELSE '65 and over' END"""
EBS_ENC = "exists(e.type, t -> exists(t.coding, c -> c.code = 'ebs_signal'))"
FU_ENC = "exists(e.type, t -> exists(t.coding, c -> c.code = 'disease_followup'))"

Q = []  # (topic, title, description, sql)


def add(topic, title, desc, sql):
    Q.append((topic, title, desc, sql.strip() + ("" if sql.strip().endswith(";") else ";")))


# ---------------------------------------------------------------- Data
add("Data", "How fresh is the data (days since the newest record)",
    "Should be 0 or 1. More means the analytics pipeline has stopped loading new records.",
    """SELECT max(to_date(meta.lastUpdated)) AS newest_record,
       datediff(current_date(), max(to_date(meta.lastUpdated))) AS days_old
FROM encounter""")
add("Data", "Newest record and row count per resource",
    "Per resource type: how many rows the pipeline holds and when the newest one changed.",
    """SELECT 'patient' AS resource, COUNT(*) AS n, max(to_date(meta.lastUpdated)) AS newest FROM patient
UNION ALL SELECT 'household (group)', COUNT(*), max(to_date(meta.lastUpdated)) FROM `group`
UNION ALL SELECT 'task', COUNT(*), max(to_date(meta.lastUpdated)) FROM task
UNION ALL SELECT 'encounter', COUNT(*), max(to_date(meta.lastUpdated)) FROM encounter
UNION ALL SELECT 'condition', COUNT(*), max(to_date(meta.lastUpdated)) FROM condition
UNION ALL SELECT 'observation', COUNT(*), max(to_date(meta.lastUpdated)) FROM observation
UNION ALL SELECT 'immunization', COUNT(*), max(to_date(meta.lastUpdated)) FROM immunization
UNION ALL SELECT 'practitioner', COUNT(*), max(to_date(meta.lastUpdated)) FROM practitioner
UNION ALL SELECT 'location', COUNT(*), max(to_date(meta.lastUpdated)) FROM location""")
add("Data", "Kinds of encounter recorded (count per type)",
    "Which visit and form types exist and how often they were used.",
    """SELECT element_at(t.coding, 1).code AS encounter_type, COUNT(*) AS n
FROM encounter e LATERAL VIEW explode(e.type) x AS t
GROUP BY 1 ORDER BY 2 DESC LIMIT 100""")

# ---------------------------------------------------------------- People and households
add("People", "Active people by sex and age group",
    "How many registered, active people there are in each age band and sex.",
    f"""SELECT p.gender, {AGE_GROUP} AS age_group, COUNT(*) AS people
FROM patient p
WHERE p.active = true
GROUP BY 1, 2
ORDER BY 1, 2""")
add("People", "Active people per area",
    "Number of active people tagged to each area.",
    f"""SELECT loc.name AS area, COUNT(*) AS people
FROM patient p
{LOC.format(a='p')}
WHERE p.active = true
GROUP BY 1
ORDER BY 2 DESC""")
add("People", "Households per area",
    "Active households (families) per area, with the average number of members.",
    f"""SELECT loc.name AS area, COUNT(*) AS households, round(avg(size(g.member)), 1) AS avg_members
FROM `group` g
{LOC.format(a='g')}
WHERE g.active = true
GROUP BY 1
ORDER BY 2 DESC""")
add("People", "Household size (how many households have 1, 2, 3 ... members)",
    "Distribution of household sizes; households with no member are a sign of incomplete registration.",
    """SELECT size(g.member) AS members, COUNT(*) AS households
FROM `group` g
WHERE g.active = true
GROUP BY 1
ORDER BY 1""")
add("People", "Households with no members",
    "Active households that have no member at all (to be checked or removed). Latest first.",
    f"""SELECT g.name AS household, loc.name AS area, to_date(g.meta.lastUpdated) AS last_updated, g.id AS household_id
FROM `group` g
{LOC.format(a='g')}
WHERE g.active = true AND size(g.member) = 0
ORDER BY last_updated DESC
LIMIT 500""")

# ---------------------------------------------------------------- VHW activity
add("VHW", "Visits and forms per VHW in the last 30 days",
    "For each VHW: forms/visits recorded and different people reached in the last 30 days.",
    f"""SELECT concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw, loc.name AS area,
       COUNT(*) AS encounters_30d, COUNT(DISTINCT e.subject.reference) AS people_or_households
FROM encounter e
LEFT JOIN practitioner pr ON pr.id = {VHW}
{LOC.format(a='e')}
WHERE to_date(e.period.start) >= date_sub(current_date(), 30)
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 500""")
add("VHW", "Activity per month and type of encounter",
    "How many encounters of each type were recorded per month (a trend of VHW work).",
    """SELECT trunc(to_date(e.period.start), 'MM') AS month, element_at(t.coding, 1).code AS encounter_type, COUNT(*) AS n
FROM encounter e LATERAL VIEW explode(e.type) x AS t
WHERE e.period.start IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC
LIMIT 500""")
add("VHW", "VHWs with no activity in the last 30 days",
    "VHWs that appear on records before, but recorded nothing in the last 30 days.",
    f"""WITH last_seen AS (
  SELECT {VHW} AS vhw_id, max(to_date(e.period.start)) AS last_activity, COUNT(*) AS total_encounters
  FROM encounter e GROUP BY 1)
SELECT concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw, l.last_activity, l.total_encounters
FROM last_seen l LEFT JOIN practitioner pr ON pr.id = l.vhw_id
WHERE l.vhw_id IS NOT NULL AND l.last_activity < date_sub(current_date(), 30)
ORDER BY l.last_activity
LIMIT 500""")

# ---------------------------------------------------------------- Child health
add("Child health", "Children under 5 by age group and area",
    "Active children under 5 split by age group, per area.",
    f"""SELECT loc.name AS area,
       CASE WHEN months_between(current_date(), to_date(p.birthDate)) < 12 THEN '0-11 months'
            WHEN months_between(current_date(), to_date(p.birthDate)) < 24 THEN '12-23 months'
            ELSE '2-4 years' END AS age_group,
       COUNT(*) AS children
FROM patient p
{LOC.format(a='p')}
WHERE p.active = true AND to_date(p.birthDate) > add_months(current_date(), -60)
GROUP BY 1, 2
ORDER BY 1, 2""")
add("Child health", "Vaccine doses by vaccine and state",
    "Given / Due / Overdue / Upcoming / Expired doses for every vaccine.",
    f"""SELECT trim(t.description) AS vaccine, {TASK_STATE.format(done='Given')} AS state, COUNT(*) AS doses
FROM task t
WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002')
GROUP BY 1, 2
ORDER BY 1, 2""")
add("Child health", "Overdue vaccine doses - follow-up list",
    "Children whose vaccine window has passed without the dose being given, by area and VHW.",
    f"""SELECT loc.name AS area, concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw,
       concat_ws(' ', p.name[0].given[0], p.name[0].family) AS child,
       CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months,
       trim(t.description) AS vaccine, to_date(t.executionPeriod.end) AS window_ended
FROM task t
LEFT JOIN patient p ON p.id = substring_index(t.`for`.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = t.owner.practitionerId
{LOC.format(a='t')}
WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002')
  AND t.status IN ('ready', 'in-progress') AND to_date(t.executionPeriod.end) < current_date()
ORDER BY area, vhw, window_ended
LIMIT 1000""")
add("Child health", "Vaccine coverage per vaccine (percentage given)",
    "For each vaccine: doses given, doses expected so far (given + due + overdue) and the percentage given.",
    f"""SELECT trim(t.description) AS vaccine,
       SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS given,
       SUM(CASE WHEN t.status IN ('ready', 'in-progress') AND to_date(t.executionPeriod.end) < current_date() THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN t.status = 'ready' AND to_date(t.executionPeriod.end) >= current_date() THEN 1 ELSE 0 END) AS due_now,
       round(100.0 * SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END)
         / nullif(SUM(CASE WHEN t.status = 'completed'
                           OR (t.status IN ('ready', 'in-progress') AND to_date(t.executionPeriod.start) <= current_date())
                      THEN 1 ELSE 0 END), 0), 1) AS percent_given
FROM task t
WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002')
GROUP BY 1
ORDER BY 1""")
add("Child health", "Routine child visits per VHW by state",
    "Monthly child visits: done, due, overdue per VHW.",
    f"""SELECT concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw, {TASK_STATE.format(done='Done')} AS state, COUNT(*) AS visits
FROM task t
LEFT JOIN practitioner pr ON pr.id = t.owner.practitionerId
WHERE trim(t.description) = 'Child Visit'
GROUP BY 1, 2
ORDER BY 1, 2
LIMIT 1000""")
add("Child health", "Children under 5 with no vaccine given yet",
    "Active children under 5 who have no vaccine task completed (possible missed registration or catch-up).",
    f"""WITH given AS (
  SELECT substring_index(t.`for`.reference, '/', -1) AS patient_id, COUNT(*) AS doses
  FROM task t
  WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002') AND t.status = 'completed'
  GROUP BY 1)
SELECT concat_ws(' ', p.name[0].given[0], p.name[0].family) AS child, loc.name AS area,
       CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months
FROM patient p
LEFT JOIN given g ON g.patient_id = p.id
{LOC.format(a='p')}
WHERE p.active = true AND to_date(p.birthDate) > add_months(current_date(), -60) AND g.doses IS NULL
ORDER BY age_months DESC
LIMIT 1000""")

# ---------------------------------------------------------------- Diseases
add("Disease", "People registered with a disease (count per disease)",
    "Different people with an active registered disease, per disease.",
    f"""SELECT c.code.text AS disease, COUNT(DISTINCT substring_index(c.subject.reference, '/', -1)) AS people
FROM condition c
WHERE {DISEASE_COND}
GROUP BY 1
ORDER BY 2 DESC""")
add("Disease", "Disease by area",
    "Registered diseases per area (rows = area, columns = disease in the result table).",
    f"""SELECT loc.name AS area, c.code.text AS disease, COUNT(DISTINCT substring_index(c.subject.reference, '/', -1)) AS people
FROM condition c
{LOC.format(a='c')}
WHERE {DISEASE_COND}
GROUP BY 1, 2
ORDER BY 1, 3 DESC""")
add("Disease", "Disease by sex and age group",
    "Who has each registered disease: sex and age band.",
    f"""SELECT c.code.text AS disease, p.gender, {AGE_GROUP} AS age_group, COUNT(DISTINCT p.id) AS people
FROM condition c
JOIN patient p ON p.id = substring_index(c.subject.reference, '/', -1)
WHERE {DISEASE_COND}
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3""")
add("Disease", "Disease registrations per month",
    "New disease registrations per month (by the date the form was saved).",
    f"""SELECT trunc(to_date(c.recordedDate), 'MM') AS month, c.code.text AS disease, COUNT(*) AS registrations
FROM condition c
WHERE {DISEASE_COND}
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC
LIMIT 500""")
add("Disease", "Disease follow-ups per month and area",
    "Follow-up forms recorded per month and area.",
    f"""SELECT trunc(to_date(e.period.start), 'MM') AS month, loc.name AS area, COUNT(*) AS follow_ups
FROM encounter e
{LOC.format(a='e')}
WHERE {FU_ENC}
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC
LIMIT 500""")
add("Disease", "People with a disease and no follow-up in 90 days",
    "Work list: registered with a disease, but no follow-up form in the last 90 days (follow-up forms started in October 2026, so at first this lists nearly everyone).",
    f"""WITH last_fu AS (
  SELECT substring_index(e.subject.reference, '/', -1) AS patient_id, max(to_date(e.period.start)) AS last_followup
  FROM encounter e WHERE {FU_ENC} GROUP BY 1)
SELECT c.code.text AS disease, concat_ws(' ', p.name[0].given[0], p.name[0].family) AS person,
       p.gender, CAST(months_between(current_date(), to_date(p.birthDate)) / 12 AS INT) AS age_years,
       loc.name AS area, f.last_followup
FROM condition c
JOIN patient p ON p.id = substring_index(c.subject.reference, '/', -1)
LEFT JOIN last_fu f ON f.patient_id = p.id
{LOC.format(a='c')}
WHERE {DISEASE_COND}
  AND (f.last_followup IS NULL OR f.last_followup < date_sub(current_date(), 90))
ORDER BY area, disease
LIMIT 1000""")

# ---------------------------------------------------------------- EBS
add("EBS", "EBS signals - latest first",
    "Event-based surveillance signals registered by VHWs: date, household, area and VHW.",
    f"""SELECT to_date(e.period.start) AS signal_date, g.name AS household, loc.name AS area,
       concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw
FROM encounter e
LEFT JOIN `group` g ON g.id = substring_index(e.subject.reference, '/', -1)
LEFT JOIN practitioner pr ON pr.id = {VHW}
{LOC.format(a='e')}
WHERE {EBS_ENC}
ORDER BY signal_date DESC
LIMIT 500""")
add("EBS", "EBS signals per month and area",
    "How many EBS signals per month and area (a quick outbreak watch).",
    f"""SELECT trunc(to_date(e.period.start), 'MM') AS month, loc.name AS area, COUNT(*) AS signals
FROM encounter e
{LOC.format(a='e')}
WHERE {EBS_ENC}
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC
LIMIT 500""")
add("EBS", "EBS signals in the last 14 days",
    "Recent signals that need attention.",
    f"""SELECT to_date(e.period.start) AS signal_date, g.name AS household, loc.name AS area
FROM encounter e
LEFT JOIN `group` g ON g.id = substring_index(e.subject.reference, '/', -1)
{LOC.format(a='e')}
WHERE {EBS_ENC} AND to_date(e.period.start) >= date_sub(current_date(), 14)
ORDER BY signal_date DESC
LIMIT 200""")

# ---------------------------------------------------------------- Tasks
add("Tasks", "All tasks by type and status",
    "Every scheduled task (vaccines, visits, ...) by description and status.",
    """SELECT trim(t.description) AS task, t.status, COUNT(*) AS n
FROM task t
GROUP BY 1, 2
ORDER BY 1, 2
LIMIT 500""")
add("Tasks", "Overdue tasks per VHW (all types)",
    "Open tasks whose time window has passed, per VHW and task type.",
    f"""SELECT concat_ws(' ', pr.name[0].given[0], pr.name[0].family) AS vhw, trim(t.description) AS task, COUNT(*) AS overdue
FROM task t
LEFT JOIN practitioner pr ON pr.id = t.owner.practitionerId
WHERE t.status IN ('ready', 'in-progress') AND to_date(t.executionPeriod.end) < current_date()
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 500""")
add("Tasks", "Tasks due in the next 14 days",
    "Planned work for the coming two weeks, per area and task type.",
    f"""SELECT loc.name AS area, trim(t.description) AS task, COUNT(*) AS due
FROM task t
{LOC.format(a='t')}
WHERE t.status IN ('requested', 'ready') AND to_date(t.executionPeriod.start) BETWEEN current_date() AND date_add(current_date(), 14)
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 500""")


# ---------------------------------------------------------------- Map
add("Map", "District figures (the data behind the Lesotho map)",
    "One row per district with its ISO code (LS-A ... LS-K): people, children under 5, households, overdue doses, EBS signals, follow-ups, disease registrations. Use as a dataset for the Country Map chart (select Lesotho, entity = iso).",
    district_metrics_sql())
add("Map", "Do the locations have coordinates (check before a point map)",
    "How many locations have latitude and longitude, and their range. A point map needs them; Lesotho lies roughly between latitude -30.7 and -28.5 and longitude 27.0 and 29.5.",
    """SELECT COUNT(*) AS locations,
       SUM(CASE WHEN position.latitude IS NOT NULL AND position.longitude IS NOT NULL THEN 1 ELSE 0 END) AS with_coordinates,
       min(position.latitude) AS lat_min, max(position.latitude) AS lat_max,
       min(position.longitude) AS lon_min, max(position.longitude) AS lon_max
FROM location""")
add("Map", "Areas with coordinates and number of people (for a point map)",
    "One row per area that has coordinates, with the number of active people tagged to it. Use as a dataset for a deck.gl Scatterplot chart (latitude and longitude columns).",
    """SELECT loc.name AS area, loc.position.latitude AS latitude, loc.position.longitude AS longitude, COUNT(p.id) AS people
FROM location loc
LEFT JOIN patient p ON p.active = true
  AND element_at(filter(p.meta.tag, x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code = loc.id
WHERE loc.position.latitude IS NOT NULL AND loc.position.longitude IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY people DESC
LIMIT 2000""")


def label(topic, title):
    return f"BKM {topic} - {title}"


def query_file(topic, title, desc, sql):
    return {"schema": "default", "label": label(topic, title), "description": desc, "sql": sql,
            "uuid": base.uid("savedquery:" + label(topic, title)), "version": "1.0.0",
            "database_uuid": base.DB_UUID}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = args[0] if args else "bkm_query_library.zip"
    files = {f"{BUNDLE}/metadata.yaml": {"version": "1.0.0", "type": "SavedQuery",
                                          "timestamp": datetime.now(timezone.utc).isoformat()},
             f"{BUNDLE}/databases/BKM_Server.yaml": base.DB_FILE}
    for topic, title, desc, sql in Q:
        safe = label(topic, title).replace("/", "-")
        files[f"{BUNDLE}/queries/BKM_Server/{safe}.yaml"] = query_file(topic, title, desc, sql)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, content in files.items():
            z.writestr(path, json.dumps(content, indent=2))  # JSON is valid YAML
    open(out, "wb").write(buf.getvalue())
    sql_path = os.path.splitext(out)[0] + ".sql"
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("-- BKM query library for Superset SQL Lab (database BKM_Server). Run one query at a time.\n"
                "-- Pipeline tables: patient, `group` (households), task, encounter, condition, location, practitioner.\n\n")
        for topic, title, desc, sql in Q:
            f.write(f"-- {label(topic, title)}\n-- {desc}\n{sql}\n\n")
    print(f"wrote {out}: {len(Q)} saved queries; plain SQL copy: {sql_path}")


if __name__ == "__main__":
    main()
