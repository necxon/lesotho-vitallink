-- =============================================================================
-- fhir_reports.sql - reporting views consumed by Superset
--
-- Depends on scripts/sql/fhir_analytics.sql (schema analytics). Apply that first.
-- These views are the Superset datasets: one view per chart family, already
-- aggregated or shaped so a chart needs no custom SQL.
--
-- Apply with:  make superset-views
-- =============================================================================

-- --- Platform / data volume ---------------------------------------------------

-- What is in the FHIR server right now, by resource type.
CREATE OR REPLACE VIEW analytics.rpt_resource_inventory AS
SELECT resource_type,
       count(*)          AS resource_count,
       min(created_at)   AS first_created,
       max(updated_at)   AS last_updated,
       sum(version)      AS total_versions
FROM analytics.fhir_resource
GROUP BY resource_type;

-- Write activity over time: creates, updates and deletes per day per type.
CREATE OR REPLACE VIEW analytics.rpt_write_activity_daily AS
SELECT date_trunc('day', updated_at) AS activity_day,
       resource_type,
       change_type,
       count(*) AS events
FROM analytics.fhir_resource_history
GROUP BY 1, 2, 3;

-- Hourly write volume - useful for spotting sync bursts from the Android app.
CREATE OR REPLACE VIEW analytics.rpt_write_activity_hourly AS
SELECT date_trunc('hour', updated_at) AS activity_hour,
       resource_type,
       count(*) AS events
FROM analytics.fhir_resource_history
GROUP BY 1, 2;

-- Single-row KPI tile source for the overview dashboard.
CREATE OR REPLACE VIEW analytics.rpt_kpi_overview AS
SELECT (SELECT count(*) FROM analytics.dim_patient)            AS patients,
       (SELECT count(*) FROM analytics.dim_practitioner)       AS practitioners,
       (SELECT count(*) FROM analytics.dim_household)          AS households,
       (SELECT count(*) FROM analytics.dim_organization)       AS facilities,
       (SELECT count(*) FROM analytics.dim_location)           AS locations,
       (SELECT count(*) FROM analytics.dim_medicine)           AS medicines,
       (SELECT count(*) FROM analytics.fact_dispense)          AS dispenses,
       (SELECT coalesce(sum(quantity), 0) FROM analytics.fact_dispense) AS units_dispensed,
       (SELECT count(*) FROM analytics.fact_supply_delivery)   AS deliveries,
       (SELECT count(*) FROM analytics.fact_task)              AS tasks,
       (SELECT count(*) FROM analytics.fact_task WHERE status IN ('requested', 'received', 'in-progress')) AS tasks_open,
       (SELECT count(*) FROM analytics.fact_questionnaire_response) AS form_submissions,
       (SELECT count(*) FROM analytics.fact_stock_on_hand)     AS stock_ledger_rows,
       (SELECT count(*) FROM analytics.fact_stock_on_hand WHERE balance <= 0) AS stockouts,
       (SELECT count(*) FROM analytics.fhir_resource)          AS fhir_resources;

-- --- People -------------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_patient_demographics AS
SELECT coalesce(gender, 'unknown') AS gender,
       age_band,
       coalesce(district, 'Unknown') AS district,
       count(*) AS patients
FROM analytics.dim_patient
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_patients_by_village AS
SELECT coalesce(p.village, 'Unknown')  AS village,
       coalesce(p.district, 'Unknown') AS district,
       count(*)                                        AS patients,
       count(*) FILTER (WHERE p.gender = 'female')     AS female,
       count(*) FILTER (WHERE p.gender = 'male')       AS male,
       count(*) FILTER (WHERE p.age_years < 5)         AS under_five,
       count(*) FILTER (WHERE p.age_years >= 65)       AS elderly
FROM analytics.dim_patient p
GROUP BY 1, 2;

-- Patient registrations over time.
CREATE OR REPLACE VIEW analytics.rpt_patient_registrations_daily AS
SELECT date_trunc('day', created_at) AS registration_day,
       coalesce(district, 'Unknown') AS district,
       count(*) AS patients
FROM analytics.dim_patient
GROUP BY 1, 2;

-- --- Workforce ----------------------------------------------------------------

-- One row per VHW/health worker with their workload.
-- Caseload per practitioner.
--
-- Dispensing is aggregated in a subquery rather than joined row-by-row. Joining
-- households, household members and dispenses together multiplies the dispense
-- rows by (households x members), and while count(DISTINCT) survives that,
-- sum(quantity) does not: a worker with 4 households, 11 patients and 176 units
-- dispensed reported 7744. The counts looked right, which is what made it hard
-- to spot - it only appears once a practitioner has both patients AND dispenses.
CREATE OR REPLACE VIEW analytics.rpt_vhw_caseload AS
SELECT pr.practitioner_id,
       pr.full_name        AS practitioner_name,
       pr.phone,
       coalesce(pr.district, 'Unknown') AS district,
       count(DISTINCT h.household_id) AS households,
       count(DISTINCT hm.member_ref)  AS patients,
       coalesce(max(d.dispenses), 0)       AS dispenses,
       coalesce(max(d.units_dispensed), 0) AS units_dispensed
FROM analytics.dim_practitioner pr
LEFT JOIN analytics.dim_household h
       ON h.managing_practitioner_ref = pr.practitioner_ref
LEFT JOIN analytics.bridge_household_member hm
       ON hm.managing_practitioner_ref = pr.practitioner_ref
LEFT JOIN (
       SELECT performer_ref,
              count(*)                   AS dispenses,
              coalesce(sum(quantity), 0) AS units_dispensed
       FROM analytics.fact_dispense
       GROUP BY performer_ref
     ) d ON d.performer_ref = pr.practitioner_ref
GROUP BY 1, 2, 3, 4;

-- Who is posted where, in which role.
CREATE OR REPLACE VIEW analytics.rpt_workforce_roster AS
SELECT pr.practitioner_id,
       pr.full_name AS practitioner_name,
       pr.phone,
       role.role_code,
       role.role_display,
       org.name     AS facility_name,
       loc.name     AS location_name,
       role.period_start,
       pr.active
FROM analytics.dim_practitioner pr
LEFT JOIN analytics.dim_practitioner_role role ON role.practitioner_ref = pr.practitioner_ref
LEFT JOIN analytics.dim_organization org ON org.organization_ref = role.organization_ref
LEFT JOIN analytics.dim_location loc ON loc.location_ref = role.location_ref;

-- Care team composition by role.
CREATE OR REPLACE VIEW analytics.rpt_care_team_composition AS
SELECT ctm.care_team_name,
       coalesce(ctm.role_display, ctm.role_code, 'Unspecified') AS role,
       count(*) AS members
FROM analytics.dim_care_team_member ctm
GROUP BY 1, 2;

-- --- Stock --------------------------------------------------------------------

-- Current stock on hand per medicine per facility, with a traffic-light band.
CREATE OR REPLACE VIEW analytics.rpt_stock_current AS
SELECT coalesce(s.medicine_name, s.medicine_ref)     AS medicine,
       coalesce(s.facility_name, s.organization_ref) AS facility,
       s.balance,
       s.unit,
       s.effective_at,
       CASE
         WHEN s.balance IS NULL  THEN 'Unknown'
         WHEN s.balance <= 0     THEN 'Stock-out'
         WHEN s.balance < 50     THEN 'Critical'
         WHEN s.balance < 200    THEN 'Low'
         ELSE 'Adequate'
       END AS stock_status,
       date_part('day', now() - s.effective_at)::int AS days_since_update
FROM analytics.fact_stock_on_hand s;

-- Facility-level rollup: how much is held and how many lines are out.
CREATE OR REPLACE VIEW analytics.rpt_stock_by_facility AS
SELECT coalesce(facility_name, organization_ref) AS facility,
       count(*)                                  AS medicine_lines,
       coalesce(sum(balance), 0)                 AS total_units,
       count(*) FILTER (WHERE balance <= 0)      AS stockouts,
       count(*) FILTER (WHERE balance > 0 AND balance < 50) AS critical_lines,
       min(effective_at)                         AS oldest_update,
       max(effective_at)                         AS latest_update
FROM analytics.fact_stock_on_hand
GROUP BY 1;

-- Medicine-level rollup across all facilities.
CREATE OR REPLACE VIEW analytics.rpt_stock_by_medicine AS
SELECT coalesce(medicine_name, medicine_ref) AS medicine,
       count(DISTINCT organization_ref)      AS facilities_stocking,
       coalesce(sum(balance), 0)             AS total_units,
       round(avg(balance), 1)                AS avg_units_per_facility,
       min(balance)                          AS min_units,
       max(balance)                          AS max_units,
       count(*) FILTER (WHERE balance <= 0)  AS stockout_facilities
FROM analytics.fact_stock_on_hand
GROUP BY 1;

-- Every line currently at or below the critical threshold - the alert table.
CREATE OR REPLACE VIEW analytics.rpt_stock_alerts AS
SELECT coalesce(facility_name, organization_ref) AS facility,
       coalesce(medicine_name, medicine_ref)     AS medicine,
       balance,
       unit,
       effective_at,
       CASE WHEN balance <= 0 THEN 'Stock-out' ELSE 'Critical' END AS severity
FROM analytics.fact_stock_on_hand
WHERE balance IS NULL OR balance < 50;

-- Stock balance history, reconstructed from every Observation version.
-- The ledger Observation is upserted in place, so the version table is the only
-- place the balance time series survives.
CREATE OR REPLACE VIEW analytics.rpt_stock_trend AS
SELECT coalesce(m.medicine_name, b.medicine_ref)     AS medicine,
       coalesce(org.name, b.organization_ref)        AS facility,
       b.balance,
       b.observed_at,
       date_trunc('day', b.observed_at)              AS observed_day,
       b.version
FROM (
  SELECT v.res_text_vc::jsonb #>> '{subject,reference}'     AS medicine_ref,
         v.res_text_vc::jsonb #>> '{performer,0,reference}' AS organization_ref,
         (v.res_text_vc::jsonb #>> '{component,0,valueQuantity,value}')::numeric AS balance,
         coalesce((v.res_text_vc::jsonb ->> 'effectiveDateTime')::timestamptz,
                  v.res_updated::timestamptz) AS observed_at,
         v.res_ver AS version
  FROM hfj_res_ver v
  WHERE v.res_type = 'Observation'
    AND v.res_encoding = 'JSON'
    AND v.res_text_vc IS NOT NULL
    AND v.res_text_vc::jsonb #>> '{code,text}' = 'Stock on hand'
) b
LEFT JOIN analytics.dim_medicine m ON m.medicine_ref = b.medicine_ref
LEFT JOIN analytics.dim_organization org ON org.organization_ref = b.organization_ref;

-- --- Service delivery ---------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_dispense_daily AS
SELECT handed_over_day,
       coalesce(medicine_name, 'Unspecified') AS medicine,
       count(*)                     AS dispense_events,
       coalesce(sum(quantity), 0)   AS units_dispensed,
       count(DISTINCT patient_ref)  AS patients_served,
       count(DISTINCT performer_ref) AS active_vhws
FROM analytics.fact_dispense
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_dispense_by_vhw AS
SELECT coalesce(performer_name, performer_ref, 'Unattributed') AS vhw,
       coalesce(medicine_name, 'Unspecified')                  AS medicine,
       count(*)                    AS dispense_events,
       coalesce(sum(quantity), 0)  AS units_dispensed,
       count(DISTINCT patient_ref) AS patients_served,
       max(handed_over_at)         AS last_dispense_at
FROM analytics.fact_dispense
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_dispense_by_village AS
SELECT coalesce(village, 'Unknown') AS village,
       coalesce(medicine_name, 'Unspecified') AS medicine,
       count(*)                   AS dispense_events,
       coalesce(sum(quantity), 0) AS units_dispensed,
       count(DISTINCT patient_ref) AS patients_served
FROM analytics.fact_dispense
GROUP BY 1, 2;

-- Who received what, the drill-down table behind the dispensing charts.
CREATE OR REPLACE VIEW analytics.rpt_dispense_detail AS
SELECT handed_over_at,
       coalesce(medicine_name, 'Unspecified') AS medicine,
       quantity,
       unit,
       coalesce(patient_name, patient_ref)     AS patient,
       age_band,
       gender,
       coalesce(village, 'Unknown')            AS village,
       coalesce(performer_name, performer_ref) AS dispensed_by,
       status
FROM analytics.fact_dispense;

CREATE OR REPLACE VIEW analytics.rpt_supply_delivery_daily AS
SELECT occurred_day,
       coalesce(item_name, 'Unspecified') AS item,
       status,
       count(*)                   AS deliveries,
       coalesce(sum(quantity), 0) AS units_delivered
FROM analytics.fact_supply_delivery
GROUP BY 1, 2, 3;

-- --- Task pipeline ------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_task_pipeline AS
SELECT status,
       coalesce(task_type, 'Unspecified') AS task_type,
       count(*)           AS tasks,
       round(avg(age_days), 1) AS avg_age_days,
       max(age_days)      AS oldest_age_days
FROM analytics.fact_task
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_task_ageing AS
SELECT CASE
         WHEN age_days IS NULL THEN 'Unknown'
         WHEN age_days <= 1  THEN '0-1 days'
         WHEN age_days <= 7  THEN '2-7 days'
         WHEN age_days <= 30 THEN '8-30 days'
         ELSE '30+ days'
       END AS age_bucket,
       status,
       count(*) AS tasks
FROM analytics.fact_task
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_task_detail AS
SELECT task_id,
       status,
       coalesce(task_type, 'Unspecified') AS task_type,
       description,
       product,
       quantity_text,
       coalesce(org.name, t.for_ref) AS for_facility,
       authored_at,
       last_modified_at,
       age_days
FROM analytics.fact_task t
LEFT JOIN analytics.dim_organization org ON org.organization_ref = t.for_ref;

-- --- Forms --------------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_form_submissions_daily AS
SELECT authored_day,
       questionnaire_id,
       status,
       count(*) AS submissions,
       count(DISTINCT author_ref) AS submitting_users
FROM analytics.fact_questionnaire_response
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_form_answers AS
SELECT questionnaire_id,
       link_id,
       coalesce(question_text, link_id) AS question,
       coalesce(answer_value, '(blank)') AS answer,
       count(*) AS responses
FROM analytics.fact_questionnaire_answer
GROUP BY 1, 2, 3, 4;

-- --- Geography ----------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_location_hierarchy AS
SELECT l.location_id,
       l.name         AS location_name,
       l.type_display AS location_type,
       l.physical_type,
       parent.name    AS parent_name,
       l.latitude,
       l.longitude,
       l.status
FROM analytics.dim_location l
LEFT JOIN analytics.dim_location parent ON parent.location_ref = l.part_of_ref;

-- Locations that can be plotted - filters out anything without coordinates.
CREATE OR REPLACE VIEW analytics.rpt_location_map AS
SELECT location_id,
       name AS location_name,
       type_display AS location_type,
       latitude,
       longitude
FROM analytics.dim_location
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- --- Data quality -------------------------------------------------------------

-- One row per failed check, so the dashboard can show both a total and a breakdown.
CREATE OR REPLACE VIEW analytics.rpt_data_quality AS
SELECT 'Patient missing birth date' AS check_name, 'Patient' AS resource_type, 'warning' AS severity, count(*) AS failing_rows
FROM analytics.dim_patient WHERE birth_date IS NULL
UNION ALL
SELECT 'Patient missing village', 'Patient', 'warning', count(*)
FROM analytics.dim_patient WHERE village IS NULL OR village = ''
UNION ALL
SELECT 'Patient missing gender', 'Patient', 'warning', count(*)
FROM analytics.dim_patient WHERE gender IS NULL
UNION ALL
SELECT 'Patient not in any household group', 'Patient', 'error', count(*)
FROM analytics.dim_patient p
WHERE NOT EXISTS (SELECT 1 FROM analytics.bridge_household_member m WHERE m.member_ref = p.patient_ref)
UNION ALL
SELECT 'Practitioner missing phone', 'Practitioner', 'warning', count(*)
FROM analytics.dim_practitioner WHERE phone IS NULL OR phone = ''
UNION ALL
SELECT 'Practitioner missing Keycloak identifier', 'Practitioner', 'error', count(*)
FROM analytics.dim_practitioner WHERE keycloak_user_id IS NULL
UNION ALL
SELECT 'Practitioner has no role posting', 'Practitioner', 'error', count(*)
FROM analytics.dim_practitioner pr
WHERE NOT EXISTS (SELECT 1 FROM analytics.dim_practitioner_role r WHERE r.practitioner_ref = pr.practitioner_ref)
UNION ALL
SELECT 'Household with no members', 'Group', 'warning', count(*)
FROM analytics.dim_household WHERE member_count = 0
UNION ALL
SELECT 'Household without managing practitioner', 'Group', 'error', count(*)
FROM analytics.dim_household WHERE managing_practitioner_ref IS NULL
UNION ALL
SELECT 'Location missing coordinates', 'Location', 'info', count(*)
FROM analytics.dim_location WHERE latitude IS NULL OR longitude IS NULL
UNION ALL
SELECT 'Stock ledger row with negative balance', 'Observation', 'error', count(*)
FROM analytics.fact_stock_on_hand WHERE balance < 0
UNION ALL
SELECT 'Stock ledger row not updated in 7 days', 'Observation', 'warning', count(*)
FROM analytics.fact_stock_on_hand WHERE effective_at < now() - interval '7 days'
UNION ALL
SELECT 'Dispense without performer', 'MedicationDispense', 'error', count(*)
FROM analytics.fact_dispense WHERE performer_ref IS NULL
UNION ALL
SELECT 'Dispense without quantity', 'MedicationDispense', 'warning', count(*)
FROM analytics.fact_dispense WHERE quantity IS NULL
UNION ALL
SELECT 'Dispense referencing an unknown patient', 'MedicationDispense', 'error', count(*)
FROM analytics.fact_dispense d
WHERE d.patient_ref IS NOT NULL AND d.patient_name IS NULL
UNION ALL
SELECT 'Task open longer than 30 days', 'Task', 'warning', count(*)
FROM analytics.fact_task WHERE age_days > 30 AND status IN ('requested', 'received', 'in-progress');

-- Referential integrity: references that do not resolve to a live resource.
CREATE OR REPLACE VIEW analytics.rpt_broken_references AS
SELECT src.resource_type AS source_type,
       src.fhir_id       AS source_id,
       ref.path          AS reference_path,
       ref.target        AS missing_reference
FROM analytics.fhir_resource src
CROSS JOIN LATERAL (
  VALUES
    ('subject',   src.body #>> '{subject,reference}'),
    ('performer', src.body #>> '{performer,0,reference}'),
    ('patient',   src.body #>> '{patient,reference}'),
    ('for',       src.body #>> '{for,reference}'),
    ('managingOrganization', src.body #>> '{managingOrganization,reference}'),
    ('managingEntity',       src.body #>> '{managingEntity,reference}'),
    ('practitioner',         src.body #>> '{practitioner,reference}'),
    ('organization',         src.body #>> '{organization,reference}'),
    ('partOf',               src.body #>> '{partOf,reference}')
) AS ref(path, target)
WHERE ref.target IS NOT NULL
  AND ref.target NOT LIKE 'http%'
  AND NOT EXISTS (
        SELECT 1 FROM analytics.fhir_resource t WHERE t.reference = ref.target
      );
