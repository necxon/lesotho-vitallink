-- BKM Child Health - Superset datasets (database: BKM_Server, Spark SQL on the
-- fhir-data-pipes Parquet tables). In SQL Lab: paste one query, Run, then
-- "Save" -> "Save dataset" with the name given above it.
--
-- States follow the app (fhircore TaskExtension):
--   Given    = completed
--   Overdue  = ready or in-progress, and executionPeriod.end is before today
--   Due      = ready (window still open)
--   Upcoming = requested (or another open status)
--   Expired  = cancelled (or failed / entered-in-error)
-- Vaccine tasks are code 33879002; routine visits have description "Child Visit".


-- 1. bkm_vaccine_tasks: one row per vaccine dose task
SELECT
  t.id                                                        AS task_id,
  trim(t.description)                                         AS vaccine,
  t.status                                                    AS status,
  CASE
    WHEN t.status = 'completed' THEN 'Given'
    WHEN t.status IN ('cancelled', 'failed', 'entered-in-error') THEN 'Expired'
    WHEN t.status IN ('ready', 'in-progress')
         AND to_date(t.executionPeriod.end) < current_date() THEN 'Overdue'
    WHEN t.status = 'ready' THEN 'Due'
    ELSE 'Upcoming'
  END                                                         AS state,
  to_date(t.executionPeriod.start)                            AS window_start,
  to_date(t.executionPeriod.end)                              AS window_end,
  to_date(t.meta.lastUpdated)                                 AS last_updated,
  substring_index(t.`for`.reference, '/', -1)                 AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family)        AS child_name,
  p.gender                                                    AS gender,
  to_date(p.birthDate)                                        AS birth_date,
  CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months,
  t.owner.practitionerId                                      AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family)      AS vhw_name,
  loc.name                                                    AS area
FROM task t
LEFT JOIN patient p
  ON p.id = substring_index(t.`for`.reference, '/', -1)
LEFT JOIN practitioner pr
  ON pr.id = t.owner.practitionerId
LEFT JOIN location loc
  ON loc.id = element_at(filter(t.meta.tag,
       x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code
WHERE array_contains(transform(t.code.coding, c -> c.code), '33879002');


-- 2. bkm_routine_visits: one row per monthly child visit task
SELECT
  t.id                                                        AS task_id,
  t.status                                                    AS status,
  CASE
    WHEN t.status = 'completed' THEN 'Done'
    WHEN t.status IN ('cancelled', 'failed', 'entered-in-error') THEN 'Expired'
    WHEN t.status IN ('ready', 'in-progress')
         AND to_date(t.executionPeriod.end) < current_date() THEN 'Overdue'
    WHEN t.status = 'ready' THEN 'Due'
    ELSE 'Upcoming'
  END                                                         AS state,
  to_date(t.executionPeriod.start)                            AS visit_month,
  to_date(t.executionPeriod.end)                              AS window_end,
  to_date(t.meta.lastUpdated)                                 AS last_updated,
  substring_index(t.`for`.reference, '/', -1)                 AS patient_id,
  t.owner.practitionerId                                      AS vhw_id,
  concat_ws(' ', pr.name[0].given[0], pr.name[0].family)      AS vhw_name,
  loc.name                                                    AS area
FROM task t
LEFT JOIN practitioner pr
  ON pr.id = t.owner.practitionerId
LEFT JOIN location loc
  ON loc.id = element_at(filter(t.meta.tag,
       x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code
WHERE trim(t.description) = 'Child Visit';


-- 3. bkm_children: one row per child under 5 (active patients)
SELECT
  p.id                                                        AS patient_id,
  concat_ws(' ', p.name[0].given[0], p.name[0].family)        AS child_name,
  p.gender                                                    AS gender,
  to_date(p.birthDate)                                        AS birth_date,
  CAST(months_between(current_date(), to_date(p.birthDate)) AS INT) AS age_months,
  CASE
    WHEN months_between(current_date(), to_date(p.birthDate)) < 12 THEN '0-11 months'
    WHEN months_between(current_date(), to_date(p.birthDate)) < 24 THEN '12-23 months'
    ELSE '2-4 years'
  END                                                         AS age_group,
  to_date(p.meta.lastUpdated)                                 AS last_updated,
  loc.name                                                    AS area
FROM patient p
LEFT JOIN location loc
  ON loc.id = element_at(filter(p.meta.tag,
       x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code
WHERE p.active = true
  AND to_date(p.birthDate) > add_months(current_date(), -60);
