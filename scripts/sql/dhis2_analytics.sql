-- =============================================================================
-- dhis2_analytics.sql - BI views over the DHIS2 schema (database dhis2)
--
-- DHIS2 lives on health-db-postgres alongside hapi_fhir, so this needs no extra
-- network wiring. The views read the raw aggregate tables (datavalue and its
-- metadata), NOT the generated `analytics_*` tables: those only exist after an
-- analytics run and are dropped and rebuilt by DHIS2 whenever it runs again.
-- Reading the raw tables means these dashboards are live rather than as-of the
-- last analytics export.
--
-- Apply with:  make superset-views-dhis2
--   or: docker exec -i health-db-postgres psql -U admin -d dhis2 \
--         < scripts/sql/dhis2_analytics.sql
--
-- Safe to re-run: the schema is dropped and rebuilt.
-- =============================================================================

DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA analytics;

-- --- Dimensions ---------------------------------------------------------------

CREATE VIEW analytics.dim_data_element AS
SELECT de.dataelementid  AS data_element_id,
       de.uid,
       de.code,
       de.name           AS data_element,
       de.shortname      AS short_name,
       de.valuetype      AS value_type,
       de.domaintype     AS domain_type,
       de.aggregationtype AS aggregation_type,
       de.zeroissignificant AS zero_is_significant,
       de.created,
       de.lastupdated    AS last_updated
FROM dataelement de;

CREATE VIEW analytics.dim_org_unit AS
SELECT ou.organisationunitid AS org_unit_id,
       ou.uid,
       ou.code,
       ou.name              AS org_unit,
       ou.shortname         AS short_name,
       ou.hierarchylevel    AS level,
       ou.path,
       parent.name          AS parent_name,
       ou.openingdate       AS opening_date,
       ou.closeddate        AS closed_date,
       ou.contactperson     AS contact_person,
       ou.phonenumber       AS phone,
       ou.address,
       (ou.geometry IS NOT NULL) AS has_geometry,
       ou.created,
       ou.lastupdated       AS last_updated
FROM organisationunit ou
LEFT JOIN organisationunit parent ON parent.organisationunitid = ou.parentid;

CREATE VIEW analytics.dim_period AS
SELECT p.periodid   AS period_id,
       pt.name      AS period_type,
       p.startdate  AS start_date,
       p.enddate    AS end_date,
       date_trunc('month', p.startdate) AS period_month
FROM period p
JOIN periodtype pt ON pt.periodtypeid = p.periodtypeid;

CREATE VIEW analytics.dim_category_option_combo AS
SELECT categoryoptioncomboid AS coc_id,
       uid,
       name AS category_option_combo
FROM categoryoptioncombo;

CREATE VIEW analytics.dim_data_set AS
SELECT ds.datasetid AS data_set_id,
       ds.uid,
       ds.name      AS data_set,
       ds.shortname AS short_name,
       pt.name      AS period_type,
       ds.created,
       ds.lastupdated AS last_updated,
       (SELECT count(*) FROM datasetelement dse WHERE dse.datasetid = ds.datasetid) AS data_elements,
       (SELECT count(*) FROM datasetsource dss WHERE dss.datasetid = ds.datasetid)  AS org_units_assigned
FROM dataset ds
LEFT JOIN periodtype pt ON pt.periodtypeid = ds.periodtypeid;

CREATE VIEW analytics.dim_user AS
SELECT u.userinfoid AS user_id,
       u.uid,
       u.username,
       trim(coalesce(u.firstname, '') || ' ' || coalesce(u.surname, '')) AS full_name,
       u.email,
       u.phonenumber AS phone,
       u.jobtitle    AS job_title,
       u.disabled,
       u.lastlogin   AS last_login,
       u.created
FROM userinfo u;

-- --- Facts --------------------------------------------------------------------

-- Every aggregate data value, fully resolved. This is the grain everything else
-- aggregates from.
CREATE VIEW analytics.fact_data_value AS
SELECT de.data_element,
       de.uid           AS data_element_uid,
       de.value_type,
       ou.org_unit,
       ou.uid           AS org_unit_uid,
       ou.level         AS org_unit_level,
       ou.parent_name,
       p.period_type,
       p.start_date     AS period_start,
       p.end_date       AS period_end,
       coc.category_option_combo,
       dv.value         AS value_text,
       CASE WHEN de.value_type IN ('NUMBER', 'INTEGER', 'INTEGER_POSITIVE',
                                   'INTEGER_ZERO_OR_POSITIVE', 'INTEGER_NEGATIVE',
                                   'UNIT_INTERVAL', 'PERCENTAGE')
             AND dv.value ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN dv.value::numeric END AS value_numeric,
       dv.storedby      AS stored_by,
       dv.created,
       dv.lastupdated   AS last_updated,
       dv.followup,
       dv.comment
FROM datavalue dv
JOIN analytics.dim_data_element de  ON de.data_element_id = dv.dataelementid
JOIN analytics.dim_org_unit    ou   ON ou.org_unit_id = dv.sourceid
JOIN analytics.dim_period      p    ON p.period_id = dv.periodid
LEFT JOIN analytics.dim_category_option_combo coc ON coc.coc_id = dv.categoryoptioncomboid
WHERE dv.deleted = false;

-- Which data sets were reported complete, by org unit and period.
CREATE VIEW analytics.fact_completeness AS
SELECT ds.data_set,
       ou.org_unit,
       ou.level AS org_unit_level,
       p.period_type,
       p.start_date AS period_start,
       p.end_date   AS period_end,
       cdr.date     AS completed_on,
       cdr.storedby AS completed_by,
       cdr.completed
FROM completedatasetregistration cdr
JOIN analytics.dim_data_set ds ON ds.data_set_id = cdr.datasetid
JOIN analytics.dim_org_unit ou ON ou.org_unit_id = cdr.sourceid
JOIN analytics.dim_period   p  ON p.period_id = cdr.periodid;
