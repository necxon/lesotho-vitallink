-- =============================================================================
-- dhis2_reports.sql - reporting views consumed by Superset (database dhis2)
--
-- Depends on scripts/sql/dhis2_analytics.sql. Apply that first.
-- =============================================================================

CREATE OR REPLACE VIEW analytics.rpt_kpi_overview AS
SELECT (SELECT count(*) FROM analytics.dim_data_element)                AS data_elements,
       (SELECT count(*) FROM analytics.dim_org_unit)                    AS org_units,
       (SELECT count(*) FROM analytics.dim_org_unit WHERE level = (SELECT max(level) FROM analytics.dim_org_unit)) AS facilities,
       (SELECT count(*) FROM analytics.dim_data_set)                    AS data_sets,
       (SELECT count(*) FROM analytics.dim_period)                      AS periods,
       (SELECT count(*) FROM analytics.dim_user)                        AS users,
       (SELECT count(*) FROM analytics.fact_data_value)                 AS data_values,
       (SELECT coalesce(sum(value_numeric), 0) FROM analytics.fact_data_value) AS total_reported,
       (SELECT count(DISTINCT org_unit) FROM analytics.fact_data_value) AS reporting_org_units,
       (SELECT count(*) FROM analytics.fact_data_value WHERE followup)  AS flagged_for_followup,
       (SELECT count(*) FROM analytics.fact_completeness)               AS completeness_records,
       (SELECT max(last_updated) FROM analytics.fact_data_value)        AS last_data_value_at;

-- --- Reported data ------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_data_values_by_element AS
SELECT data_element,
       value_type,
       count(*)                  AS data_values,
       sum(value_numeric)        AS total_value,
       round(avg(value_numeric), 1) AS avg_value,
       min(period_start)         AS first_period,
       max(period_end)           AS last_period,
       max(last_updated)         AS last_updated
FROM analytics.fact_data_value
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_data_values_by_org_unit AS
SELECT org_unit,
       parent_name,
       org_unit_level,
       count(*)           AS data_values,
       count(DISTINCT data_element) AS data_elements_reported,
       sum(value_numeric) AS total_value,
       max(last_updated)  AS last_reported_at
FROM analytics.fact_data_value
GROUP BY 1, 2, 3;

-- The main time series: reported value per period per data element.
CREATE OR REPLACE VIEW analytics.rpt_data_value_trend AS
SELECT period_start,
       period_type,
       data_element,
       org_unit,
       sum(value_numeric) AS value,
       count(*)           AS data_values
FROM analytics.fact_data_value
GROUP BY 1, 2, 3, 4;

-- Stock indicators specifically: the sandbox names them Stock on hand / received
-- / dispensed, so they are pulled out for their own charts.
CREATE OR REPLACE VIEW analytics.rpt_stock_indicators AS
SELECT period_start,
       data_element,
       org_unit,
       CASE
         WHEN data_element ILIKE '%on hand%'    THEN 'Stock on hand'
         WHEN data_element ILIKE '%received%'   THEN 'Received'
         WHEN data_element ILIKE '%dispensed%'  THEN 'Dispensed'
         WHEN data_element ILIKE '%adjust%'     THEN 'Adjustment'
         ELSE 'Other'
       END AS indicator_group,
       sum(value_numeric) AS value
FROM analytics.fact_data_value
GROUP BY 1, 2, 3, 4;

CREATE OR REPLACE VIEW analytics.rpt_data_value_detail AS
SELECT period_start,
       period_end,
       data_element,
       org_unit,
       category_option_combo,
       value_text,
       value_numeric,
       stored_by,
       last_updated,
       followup
FROM analytics.fact_data_value;

-- Who is entering data, and when.
CREATE OR REPLACE VIEW analytics.rpt_capture_activity AS
SELECT date_trunc('day', last_updated) AS capture_day,
       coalesce(stored_by, 'unknown')  AS stored_by,
       count(*)                        AS data_values,
       count(DISTINCT org_unit)        AS org_units,
       count(DISTINCT data_element)    AS data_elements
FROM analytics.fact_data_value
GROUP BY 1, 2;

-- --- Metadata -----------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_metadata_inventory AS
SELECT 'Data elements' AS metadata_type, count(*) AS objects FROM analytics.dim_data_element
UNION ALL SELECT 'Organisation units', count(*) FROM analytics.dim_org_unit
UNION ALL SELECT 'Data sets',          count(*) FROM analytics.dim_data_set
UNION ALL SELECT 'Periods',            count(*) FROM analytics.dim_period
UNION ALL SELECT 'Category option combos', count(*) FROM analytics.dim_category_option_combo
UNION ALL SELECT 'Users',              count(*) FROM analytics.dim_user;

CREATE OR REPLACE VIEW analytics.rpt_data_element_catalogue AS
SELECT data_element,
       uid,
       code,
       value_type,
       domain_type,
       aggregation_type,
       zero_is_significant,
       last_updated
FROM analytics.dim_data_element;

CREATE OR REPLACE VIEW analytics.rpt_data_elements_by_type AS
SELECT value_type,
       domain_type,
       aggregation_type,
       count(*) AS data_elements
FROM analytics.dim_data_element
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_org_unit_hierarchy AS
SELECT org_unit,
       parent_name,
       level,
       uid,
       code,
       opening_date,
       has_geometry,
       last_updated
FROM analytics.dim_org_unit;

CREATE OR REPLACE VIEW analytics.rpt_org_units_by_level AS
SELECT level,
       count(*) AS org_units,
       count(*) FILTER (WHERE has_geometry) AS with_coordinates,
       count(*) FILTER (WHERE closed_date IS NOT NULL) AS closed
FROM analytics.dim_org_unit
GROUP BY 1;

CREATE OR REPLACE VIEW analytics.rpt_data_sets AS
SELECT data_set,
       period_type,
       data_elements,
       org_units_assigned,
       last_updated
FROM analytics.dim_data_set;

CREATE OR REPLACE VIEW analytics.rpt_users AS
SELECT username,
       full_name,
       email,
       job_title,
       disabled,
       last_login,
       created
FROM analytics.dim_user;

-- --- Completeness and quality -------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_completeness AS
SELECT data_set,
       period_start,
       count(*) AS registrations,
       count(*) FILTER (WHERE completed) AS completed,
       count(DISTINCT org_unit) AS org_units
FROM analytics.fact_completeness
GROUP BY 1, 2;

-- Which org units have never reported anything: the reporting coverage gap.
CREATE OR REPLACE VIEW analytics.rpt_reporting_coverage AS
SELECT ou.level,
       coalesce(ou.parent_name, '(root)') AS parent_name,
       count(*) AS org_units,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM analytics.fact_data_value dv WHERE dv.org_unit_uid = ou.uid
       )) AS reporting_org_units,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM analytics.fact_data_value dv WHERE dv.org_unit_uid = ou.uid
       )) AS silent_org_units
FROM analytics.dim_org_unit ou
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_data_quality AS
SELECT 'Data element never reported against' AS check_name, 'Data element' AS entity, 'warning' AS severity, count(*) AS failing_rows
FROM analytics.dim_data_element de
WHERE NOT EXISTS (SELECT 1 FROM analytics.fact_data_value dv WHERE dv.data_element_uid = de.uid)
UNION ALL
SELECT 'Org unit has never reported', 'Org unit', 'warning', count(*)
FROM analytics.dim_org_unit ou
WHERE NOT EXISTS (SELECT 1 FROM analytics.fact_data_value dv WHERE dv.org_unit_uid = ou.uid)
UNION ALL
SELECT 'Org unit without coordinates', 'Org unit', 'info', count(*)
FROM analytics.dim_org_unit WHERE NOT has_geometry
UNION ALL
SELECT 'Org unit closed but still in hierarchy', 'Org unit', 'info', count(*)
FROM analytics.dim_org_unit WHERE closed_date IS NOT NULL
UNION ALL
SELECT 'Numeric data element holding a non-numeric value', 'Data value', 'error', count(*)
FROM analytics.fact_data_value
WHERE value_type IN ('NUMBER', 'INTEGER', 'INTEGER_POSITIVE', 'INTEGER_ZERO_OR_POSITIVE')
  AND value_numeric IS NULL
UNION ALL
SELECT 'Negative value on a positive-only data element', 'Data value', 'error', count(*)
FROM analytics.fact_data_value
WHERE value_type IN ('INTEGER_POSITIVE', 'INTEGER_ZERO_OR_POSITIVE') AND value_numeric < 0
UNION ALL
SELECT 'Data value flagged for follow-up', 'Data value', 'warning', count(*)
FROM analytics.fact_data_value WHERE followup
UNION ALL
SELECT 'Data value not updated in 90 days', 'Data value', 'info', count(*)
FROM analytics.fact_data_value WHERE last_updated < now() - interval '90 days'
UNION ALL
SELECT 'Data set with no org units assigned', 'Data set', 'error', count(*)
FROM analytics.dim_data_set WHERE org_units_assigned = 0
UNION ALL
SELECT 'Data set with no data elements', 'Data set', 'error', count(*)
FROM analytics.dim_data_set WHERE data_elements = 0
UNION ALL
SELECT 'User has never logged in', 'User', 'info', count(*)
FROM analytics.dim_user WHERE last_login IS NULL
UNION ALL
SELECT 'User account disabled', 'User', 'info', count(*)
FROM analytics.dim_user WHERE disabled;
