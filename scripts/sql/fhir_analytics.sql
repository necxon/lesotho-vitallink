-- =============================================================================
-- fhir_analytics.sql - BI views over the HAPI FHIR JPA schema (database hapi_fhir)
--
-- HAPI v7 stores each resource body inline as plain JSON in hfj_res_ver.res_text_vc,
-- so the whole analytics layer is plain SQL over jsonb - no ETL and no extract job.
-- Every view reads the CURRENT version of non-deleted resources only, except
-- fhir_resource_history which keeps all versions for audit/activity reporting.
--
-- Apply with:  make superset-views
--   or: docker exec -i health-db-postgres psql -U admin -d hapi_fhir < scripts/sql/fhir_analytics.sql
--
-- Safe to re-run: the schema is dropped and rebuilt. Superset datasets bind by
-- name, so a rebuild does not invalidate existing charts.
-- =============================================================================

DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA analytics;

-- --- Base layer --------------------------------------------------------------

-- Current version of every live resource, body parsed as jsonb.
CREATE VIEW analytics.fhir_resource AS
SELECT r.res_id,
       r.fhir_id,
       r.res_type                       AS resource_type,
       r.res_type || '/' || r.fhir_id   AS reference,
       r.res_ver                        AS version,
       r.res_published                  AS created_at,
       r.res_updated                    AS updated_at,
       v.res_text_vc::jsonb             AS body
FROM hfj_resource r
JOIN hfj_res_ver  v ON v.res_id = r.res_id AND v.res_ver = r.res_ver
WHERE r.res_deleted_at IS NULL
  AND v.res_encoding = 'JSON'
  AND v.res_text_vc IS NOT NULL;

-- Every version ever written, including deletes - the write-activity audit trail.
CREATE VIEW analytics.fhir_resource_history AS
SELECT v.res_id,
       r.fhir_id,
       v.res_type    AS resource_type,
       v.res_ver     AS version,
       v.res_updated AS updated_at,
       v.res_encoding AS encoding,
       CASE WHEN v.res_encoding = 'DEL' THEN 'delete'
            WHEN v.res_ver = 1          THEN 'create'
            ELSE 'update' END AS change_type
FROM hfj_res_ver v
JOIN hfj_resource r ON r.res_id = v.res_id;

-- Resource meta.tag values (the mediator tags resources by facility and source).
CREATE VIEW analytics.fhir_tag AS
SELECT r.fhir_id,
       rt.res_type    AS resource_type,
       td.tag_system  AS tag_system,
       td.tag_code    AS tag_code,
       td.tag_display AS tag_display
FROM hfj_res_tag rt
JOIN hfj_tag_def td ON td.tag_id = rt.tag_id
JOIN hfj_resource r ON r.res_id = rt.res_id
WHERE r.res_deleted_at IS NULL;

-- --- Dimensions --------------------------------------------------------------

CREATE VIEW analytics.dim_patient AS
SELECT fhir_id                     AS patient_id,
       reference                   AS patient_ref,
       body #>> '{name,0,family}'  AS family_name,
       body #>> '{name,0,given,0}' AS given_name,
       trim(coalesce(body #>> '{name,0,given,0}', '') || ' ' ||
            coalesce(body #>> '{name,0,family}', '')) AS full_name,
       body ->> 'gender'            AS gender,
       (body ->> 'birthDate')::date AS birth_date,
       date_part('year', age(now(), (body ->> 'birthDate')::date))::int AS age_years,
       CASE
         WHEN (body ->> 'birthDate') IS NULL THEN 'Unknown'
         WHEN date_part('year', age(now(), (body ->> 'birthDate')::date)) < 5  THEN '0-4'
         WHEN date_part('year', age(now(), (body ->> 'birthDate')::date)) < 15 THEN '5-14'
         WHEN date_part('year', age(now(), (body ->> 'birthDate')::date)) < 25 THEN '15-24'
         WHEN date_part('year', age(now(), (body ->> 'birthDate')::date)) < 50 THEN '25-49'
         WHEN date_part('year', age(now(), (body ->> 'birthDate')::date)) < 65 THEN '50-64'
         ELSE '65+' END AS age_band,
       body #>> '{address,0,text}'                 AS village,
       body #>> '{address,0,district}'             AS district,
       body #>> '{managingOrganization,reference}' AS organization_ref,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Patient';

CREATE VIEW analytics.dim_practitioner AS
SELECT fhir_id   AS practitioner_id,
       reference AS practitioner_ref,
       trim(coalesce(body #>> '{name,0,given,0}', '') || ' ' ||
            coalesce(body #>> '{name,0,family}', '')) AS full_name,
       body #>> '{name,0,family}'   AS family_name,
       body #>> '{telecom,0,value}' AS phone,
       body #>> '{address,0,district}' AS district,
       body #>> '{identifier,0,value}' AS keycloak_user_id,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Practitioner';

CREATE VIEW analytics.dim_organization AS
SELECT fhir_id   AS organization_id,
       reference AS organization_ref,
       body ->> 'name'                   AS name,
       body #>> '{type,0,coding,0,code}' AS org_type,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Organization';

CREATE VIEW analytics.dim_location AS
SELECT fhir_id   AS location_id,
       reference AS location_ref,
       body ->> 'name'                        AS name,
       body ->> 'status'                      AS status,
       body #>> '{type,0,coding,0,code}'      AS type_code,
       body #>> '{type,0,coding,0,display}'   AS type_display,
       body #>> '{physicalType,coding,0,code}' AS physical_type,
       (body #>> '{position,latitude}')::numeric  AS latitude,
       (body #>> '{position,longitude}')::numeric AS longitude,
       body #>> '{partOf,reference}'          AS part_of_ref,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Location';

-- Commodity Groups (type=device) are the medicine dimension for stock reporting.
CREATE VIEW analytics.dim_medicine AS
SELECT fhir_id   AS medicine_id,
       reference AS medicine_ref,
       body ->> 'name'                    AS medicine_name,
       body #>> '{code,coding,0,code}'    AS medicine_code,
       body #>> '{code,coding,0,display}' AS medicine_display,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Group'
  AND body ->> 'type' = 'device';

-- Person Groups are VHW catchments / households.
CREATE VIEW analytics.dim_household AS
SELECT fhir_id   AS household_id,
       reference AS household_ref,
       body ->> 'name'                 AS name,
       body #>> '{identifier,0,value}' AS household_code,
       body #>> '{managingEntity,reference}' AS managing_practitioner_ref,
       jsonb_array_length(coalesce(body -> 'member', '[]'::jsonb)) AS member_count,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'Group'
  AND body ->> 'type' = 'person';

-- Household membership, one row per patient in a catchment group.
CREATE VIEW analytics.bridge_household_member AS
SELECT r.fhir_id        AS household_id,
       r.body ->> 'name' AS household_name,
       r.body #>> '{managingEntity,reference}' AS managing_practitioner_ref,
       m #>> '{entity,reference}' AS member_ref
FROM analytics.fhir_resource r
CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.body -> 'member', '[]'::jsonb)) m
WHERE r.resource_type = 'Group'
  AND r.body ->> 'type' = 'person';

-- Posting of a practitioner to an organization/location with a workflow role.
CREATE VIEW analytics.dim_practitioner_role AS
SELECT fhir_id AS role_id,
       body #>> '{practitioner,reference}' AS practitioner_ref,
       body #>> '{organization,reference}' AS organization_ref,
       body #>> '{location,0,reference}'   AS location_ref,
       body #>> '{code,0,coding,0,code}'    AS role_code,
       body #>> '{code,0,coding,0,display}' AS role_display,
       (body #>> '{period,start}')::date    AS period_start,
       coalesce((body ->> 'active')::boolean, true) AS active,
       created_at,
       updated_at
FROM analytics.fhir_resource
WHERE resource_type = 'PractitionerRole';

-- Care team staffing, one row per participant.
CREATE VIEW analytics.dim_care_team_member AS
SELECT r.fhir_id         AS care_team_id,
       r.body ->> 'name'   AS care_team_name,
       r.body ->> 'status' AS care_team_status,
       p #>> '{member,reference}'        AS member_ref,
       p #>> '{role,0,coding,0,code}'    AS role_code,
       p #>> '{role,0,coding,0,display}' AS role_display
FROM analytics.fhir_resource r
CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.body -> 'participant', '[]'::jsonb)) p
WHERE r.resource_type = 'CareTeam';

-- --- Facts -------------------------------------------------------------------

-- Stock-on-hand ledger: one Observation per (medicine Group x facility Organization).
CREATE VIEW analytics.fact_stock_on_hand AS
SELECT o.fhir_id AS observation_id,
       o.body #>> '{subject,reference}'     AS medicine_ref,
       m.medicine_name,
       o.body #>> '{performer,0,reference}' AS organization_ref,
       org.name AS facility_name,
       (o.body #>> '{component,0,valueQuantity,value}')::numeric AS balance,
       o.body #>> '{component,0,valueQuantity,unit}' AS unit,
       (o.body ->> 'effectiveDateTime')::timestamptz AS effective_at,
       o.body ->> 'status' AS status,
       o.updated_at
FROM analytics.fhir_resource o
LEFT JOIN analytics.dim_medicine m ON m.medicine_ref = o.body #>> '{subject,reference}'
LEFT JOIN analytics.dim_organization org ON org.organization_ref = o.body #>> '{performer,0,reference}'
WHERE o.resource_type = 'Observation'
  AND o.body #>> '{code,text}' = 'Stock on hand';

-- Dispensing events (a VHW hands medicine to a patient).
CREATE VIEW analytics.fact_dispense AS
SELECT d.fhir_id AS dispense_id,
       d.body ->> 'status' AS status,
       coalesce(d.body #>> '{medicationCodeableConcept,text}',
                d.body #>> '{medicationCodeableConcept,coding,0,display}',
                d.body #>> '{medicationReference,display}') AS medicine_name,
       d.body #>> '{subject,reference}' AS patient_ref,
       pat.full_name AS patient_name,
       pat.village,
       pat.gender,
       pat.age_band,
       d.body #>> '{performer,0,actor,reference}' AS performer_ref,
       prac.full_name AS performer_name,
       d.body #>> '{location,reference}' AS location_ref,
       (d.body #>> '{quantity,value}')::numeric AS quantity,
       d.body #>> '{quantity,unit}' AS unit,
       (d.body ->> 'whenHandedOver')::timestamptz AS handed_over_at,
       date_trunc('day', (d.body ->> 'whenHandedOver')::timestamptz) AS handed_over_day,
       d.created_at,
       d.updated_at
FROM analytics.fhir_resource d
LEFT JOIN analytics.dim_patient pat ON pat.patient_ref = d.body #>> '{subject,reference}'
LEFT JOIN analytics.dim_practitioner prac ON prac.practitioner_ref = d.body #>> '{performer,0,actor,reference}'
WHERE d.resource_type = 'MedicationDispense';

-- Resupply deliveries into a facility or out to a VHW.
CREATE VIEW analytics.fact_supply_delivery AS
SELECT s.fhir_id AS delivery_id,
       s.body ->> 'status' AS status,
       coalesce(s.body #>> '{suppliedItem,itemCodeableConcept,text}',
                s.body #>> '{suppliedItem,itemCodeableConcept,coding,0,display}') AS item_name,
       (s.body #>> '{suppliedItem,quantity,value}')::numeric AS quantity,
       s.body #>> '{suppliedItem,quantity,unit}' AS unit,
       s.body #>> '{supplier,reference}'    AS supplier_ref,
       s.body #>> '{destination,reference}' AS destination_ref,
       coalesce((s.body ->> 'occurrenceDateTime')::timestamptz, s.created_at) AS occurred_at,
       date_trunc('day', coalesce((s.body ->> 'occurrenceDateTime')::timestamptz, s.created_at)) AS occurred_day,
       s.created_at,
       s.updated_at
FROM analytics.fhir_resource s
WHERE s.resource_type = 'SupplyDelivery';

-- Delivery / stock-issue tasks, with the product and quantity inputs pulled out.
CREATE VIEW analytics.fact_task AS
SELECT t.fhir_id AS task_id,
       t.body ->> 'status'      AS status,
       t.body ->> 'intent'      AS intent,
       t.body ->> 'description' AS description,
       t.body #>> '{code,coding,0,display}' AS task_type,
       t.body #>> '{for,reference}'       AS for_ref,
       t.body #>> '{owner,reference}'     AS owner_ref,
       t.body #>> '{requester,reference}' AS requester_ref,
       (SELECT i ->> 'valueString'
          FROM jsonb_array_elements(coalesce(t.body -> 'input', '[]'::jsonb)) i
         WHERE i #>> '{type,text}' = 'product' LIMIT 1) AS product,
       (SELECT coalesce(i ->> 'valueString', i #>> '{valueQuantity,value}')
          FROM jsonb_array_elements(coalesce(t.body -> 'input', '[]'::jsonb)) i
         WHERE i #>> '{type,text}' = 'quantity' LIMIT 1) AS quantity_text,
       (t.body ->> 'authoredOn')::timestamptz   AS authored_at,
       (t.body ->> 'lastModified')::timestamptz AS last_modified_at,
       date_part('day', now() - (t.body ->> 'authoredOn')::timestamptz)::int AS age_days,
       t.created_at,
       t.updated_at
FROM analytics.fhir_resource t
WHERE t.resource_type = 'Task';

-- Form submissions from the Android app.
CREATE VIEW analytics.fact_questionnaire_response AS
SELECT q.fhir_id AS response_id,
       q.body ->> 'questionnaire' AS questionnaire,
       regexp_replace(coalesce(q.body ->> 'questionnaire', ''), '^.*/', '') AS questionnaire_id,
       q.body ->> 'status' AS status,
       q.body #>> '{subject,reference}' AS subject_ref,
       q.body #>> '{author,reference}'  AS author_ref,
       coalesce((q.body ->> 'authored')::timestamptz, q.created_at) AS authored_at,
       date_trunc('day', coalesce((q.body ->> 'authored')::timestamptz, q.created_at)) AS authored_day,
       jsonb_array_length(coalesce(q.body -> 'item', '[]'::jsonb)) AS item_count,
       q.created_at,
       q.updated_at
FROM analytics.fhir_resource q
WHERE q.resource_type = 'QuestionnaireResponse';

-- One row per answered item, so form answers can be charted directly.
CREATE VIEW analytics.fact_questionnaire_answer AS
SELECT q.fhir_id AS response_id,
       regexp_replace(coalesce(q.body ->> 'questionnaire', ''), '^.*/', '') AS questionnaire_id,
       coalesce((q.body ->> 'authored')::timestamptz, q.created_at) AS authored_at,
       i ->> 'linkId' AS link_id,
       i ->> 'text'   AS question_text,
       coalesce(a #>> '{valueCoding,display}',
                a ->> 'valueString',
                a ->> 'valueInteger',
                a ->> 'valueDecimal',
                a ->> 'valueBoolean',
                a ->> 'valueDate',
                a #>> '{valueQuantity,value}') AS answer_value
FROM analytics.fhir_resource q
CROSS JOIN LATERAL jsonb_array_elements(coalesce(q.body -> 'item', '[]'::jsonb)) i
CROSS JOIN LATERAL jsonb_array_elements(coalesce(i -> 'answer', '[]'::jsonb)) a
WHERE q.resource_type = 'QuestionnaireResponse';

-- Stock indicator reports pushed by the Android app (AMC, days of stock, etc).
CREATE VIEW analytics.fact_measure_report AS
SELECT m.fhir_id AS report_id,
       m.body ->> 'measure' AS measure,
       regexp_replace(coalesce(m.body ->> 'measure', ''), '^.*/', '') AS measure_id,
       m.body ->> 'status' AS status,
       m.body ->> 'type'   AS report_type,
       m.body #>> '{subject,reference}' AS subject_ref,
       med.medicine_name,
       (m.body ->> 'date')::date          AS report_date,
       (m.body #>> '{period,start}')::date AS period_start,
       (m.body #>> '{period,end}')::date   AS period_end,
       coalesce((m.body #>> '{group,0,measureScore,value}')::numeric,
                (m.body #>> '{contained,0,code,coding,0,code}')::numeric) AS score,
       m.created_at,
       m.updated_at
FROM analytics.fhir_resource m
LEFT JOIN analytics.dim_medicine med ON med.medicine_ref = m.body #>> '{subject,reference}'
WHERE m.resource_type = 'MeasureReport';
