-- =============================================================================
-- openlmis_analytics.sql - BI views over the OpenLMIS schemas (database open_lmis)
--
-- Runs against the OpenLMIS reference-distro database, which lives in the
-- openlmis-ref-distro-db-1 container, NOT health-db-postgres.
--
-- Two OpenLMIS modelling quirks drive most of the joins here:
--   - orderables and facility_type_approved_products are versioned: the primary
--     key is (id, versionnumber), so every join must pick the latest version.
--   - stock on hand is not a column on the stock card. It is a separate row per
--     (stock card, occurred date) in stockmanagement.calculated_stocks_on_hand,
--     so "current" means the newest row for that card.
--
-- Apply with:  make superset-views-lmis
--   or: docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis \
--         < scripts/sql/openlmis_analytics.sql
--
-- Safe to re-run: the schema is dropped and rebuilt.
-- =============================================================================

DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA analytics;

-- --- Dimensions ---------------------------------------------------------------

CREATE VIEW analytics.dim_facility AS
SELECT f.id            AS facility_id,
       f.code          AS facility_code,
       f.name          AS facility_name,
       f.active,
       f.enabled,
       ft.name         AS facility_type,
       ft.code         AS facility_type_code,
       gz.name         AS geographic_zone,
       gz.code         AS geographic_zone_code,
       parent.name     AS parent_zone,
       gz.latitude,
       gz.longitude,
       f.golivedate    AS go_live_date,
       f.description
FROM referencedata.facilities f
LEFT JOIN referencedata.facility_types  ft     ON ft.id = f.typeid
LEFT JOIN referencedata.geographic_zones gz    ON gz.id = f.geographiczoneid
LEFT JOIN referencedata.geographic_zones parent ON parent.id = gz.parentid;

-- Latest version of each product only.
CREATE VIEW analytics.dim_orderable AS
SELECT DISTINCT ON (o.id)
       o.id              AS orderable_id,
       o.versionnumber   AS version_number,
       o.code            AS product_code,
       o.fullproductname AS product_name,
       o.netcontent      AS net_content,
       o.packroundingthreshold AS pack_rounding_threshold,
       o.roundtozero     AS round_to_zero,
       o.lastupdated     AS last_updated
FROM referencedata.orderables o
ORDER BY o.id, o.versionnumber DESC;

CREATE VIEW analytics.dim_program AS
SELECT id AS program_id, code AS program_code, name AS program_name, active
FROM referencedata.programs;

CREATE VIEW analytics.dim_lot AS
SELECT l.id              AS lot_id,
       l.lotcode         AS lot_code,
       l.expirationdate  AS expiry_date,
       l.manufacturedate AS manufacture_date,
       l.active,
       (l.expirationdate < current_date) AS is_expired,
       (l.expirationdate - current_date) AS days_to_expiry,
       CASE
         WHEN l.expirationdate IS NULL                          THEN 'No expiry set'
         WHEN l.expirationdate <  current_date                  THEN 'Expired'
         WHEN l.expirationdate <= current_date + 30             THEN 'Expires in 30 days'
         WHEN l.expirationdate <= current_date + 90             THEN 'Expires in 90 days'
         WHEN l.expirationdate <= current_date + 180            THEN 'Expires in 180 days'
         ELSE 'More than 180 days'
       END AS expiry_band
FROM referencedata.lots l;

CREATE VIEW analytics.dim_user AS
SELECT u.id       AS user_id,
       u.username,
       trim(coalesce(u.firstname, '') || ' ' || coalesce(u.lastname, '')) AS full_name,
       u.email,
       u.phonenumber AS phone,
       u.jobtitle    AS job_title,
       u.active,
       u.verified,
       f.name        AS home_facility
FROM referencedata.users u
LEFT JOIN referencedata.facilities f ON f.id = u.homefacilityid;

CREATE VIEW analytics.dim_reason AS
SELECT id AS reason_id,
       name AS reason_name,
       reasoncategory AS reason_category,
       reasontype     AS reason_type,
       description
FROM stockmanagement.stock_card_line_item_reasons;

-- Which programs each facility is allowed to handle.
CREATE VIEW analytics.bridge_supported_program AS
SELECT sp.facilityid AS facility_id,
       f.name        AS facility_name,
       sp.programid  AS program_id,
       p.name        AS program_name,
       sp.active,
       sp.locallyfulfilled AS locally_fulfilled,
       sp.startdate  AS start_date
FROM referencedata.supported_programs sp
JOIN referencedata.facilities f ON f.id = sp.facilityid
JOIN referencedata.programs   p ON p.id = sp.programid;

-- Products approved for a facility type, with the min/max stock rules.
CREATE VIEW analytics.dim_approved_product AS
SELECT DISTINCT ON (ftap.id)
       ftap.id             AS ftap_id,
       ft.name             AS facility_type,
       o.product_name,
       o.product_code,
       p.name              AS program_name,
       ftap.maxperiodsofstock AS max_periods_of_stock,
       ftap.minperiodsofstock AS min_periods_of_stock,
       ftap.emergencyorderpoint AS emergency_order_point,
       ftap.active
FROM referencedata.facility_type_approved_products ftap
LEFT JOIN referencedata.facility_types ft ON ft.id = ftap.facilitytypeid
LEFT JOIN analytics.dim_orderable       o ON o.orderable_id = ftap.orderableid
LEFT JOIN referencedata.programs        p ON p.id = ftap.programid
ORDER BY ftap.id, ftap.versionnumber DESC;

-- --- Facts --------------------------------------------------------------------

-- One row per stock card (facility x product x lot x program) with current SOH.
CREATE VIEW analytics.fact_stock_card AS
SELECT sc.id           AS stock_card_id,
       f.facility_id,
       f.facility_name,
       f.facility_type,
       f.geographic_zone,
       o.orderable_id,
       o.product_code,
       o.product_name,
       pr.program_name,
       l.lot_id,
       l.lot_code,
       l.expiry_date,
       l.expiry_band,
       l.is_expired,
       soh.stockonhand   AS stock_on_hand,
       soh.occurreddate  AS soh_as_of,
       soh.processeddate AS soh_processed_at,
       sc.isactive       AS is_active
FROM stockmanagement.stock_cards sc
LEFT JOIN analytics.dim_facility  f  ON f.facility_id = sc.facilityid
LEFT JOIN analytics.dim_orderable o  ON o.orderable_id = sc.orderableid
LEFT JOIN analytics.dim_program   pr ON pr.program_id = sc.programid
LEFT JOIN analytics.dim_lot       l  ON l.lot_id = sc.lotid
LEFT JOIN LATERAL (
  SELECT c.stockonhand, c.occurreddate, c.processeddate
  FROM stockmanagement.calculated_stocks_on_hand c
  WHERE c.stockcardid = sc.id
  ORDER BY c.occurreddate DESC, c.processeddate DESC
  LIMIT 1
) soh ON true;

-- Every stock movement, with the reason and a signed quantity.
CREATE VIEW analytics.fact_stock_movement AS
SELECT li.id            AS line_item_id,
       sc.facility_id,
       sc.facility_name,
       sc.facility_type,
       sc.geographic_zone,
       sc.product_code,
       sc.product_name,
       sc.program_name,
       sc.lot_code,
       li.occurreddate  AS occurred_date,
       li.processeddate AS processed_at,
       li.quantity,
       r.reason_name,
       r.reason_category,
       r.reason_type,
       CASE r.reason_type
         WHEN 'CREDIT' THEN li.quantity
         WHEN 'DEBIT'  THEN -li.quantity
         ELSE 0
       END              AS signed_quantity,
       u.username       AS recorded_by,
       li.documentnumber AS document_number,
       li.reasonfreetext AS reason_free_text,
       li.sourcefreetext AS source_free_text,
       li.destinationfreetext AS destination_free_text
FROM stockmanagement.stock_card_line_items li
JOIN analytics.fact_stock_card sc ON sc.stock_card_id = li.stockcardid
LEFT JOIN analytics.dim_reason r  ON r.reason_id = li.reasonid
LEFT JOIN analytics.dim_user   u  ON u.user_id = li.userid;

-- Full stock-on-hand history, one row per recalculation.
CREATE VIEW analytics.fact_soh_history AS
SELECT c.id            AS soh_id,
       sc.facility_name,
       sc.product_name,
       sc.lot_code,
       sc.program_name,
       c.stockonhand   AS stock_on_hand,
       c.occurreddate  AS occurred_date,
       c.processeddate AS processed_at
FROM stockmanagement.calculated_stocks_on_hand c
JOIN analytics.fact_stock_card sc ON sc.stock_card_id = c.stockcardid;

CREATE VIEW analytics.fact_stock_event AS
SELECT e.id             AS event_id,
       f.facility_name,
       p.program_name,
       u.username       AS submitted_by,
       e.processeddate  AS processed_at,
       e.documentnumber AS document_number,
       e.eventorigin    AS event_origin,
       (SELECT count(*) FROM stockmanagement.stock_event_line_items li
         WHERE li.stockeventid = e.id) AS line_items
FROM stockmanagement.stock_events e
LEFT JOIN analytics.dim_facility f ON f.facility_id = e.facilityid
LEFT JOIN analytics.dim_program  p ON p.program_id = e.programid
LEFT JOIN analytics.dim_user     u ON u.user_id = e.userid;

CREATE VIEW analytics.fact_physical_inventory AS
SELECT pi.id            AS inventory_id,
       f.facility_name,
       p.program_name,
       pi.occurreddate  AS occurred_date,
       pi.isdraft       AS is_draft,
       pi.documentnumber AS document_number,
       (SELECT count(*) FROM stockmanagement.physical_inventory_line_items li
         WHERE li.physicalinventoryid = pi.id) AS line_items
FROM stockmanagement.physical_inventories pi
LEFT JOIN analytics.dim_facility f ON f.facility_id = pi.facilityid
LEFT JOIN analytics.dim_program  p ON p.program_id = pi.programid;

CREATE VIEW analytics.fact_requisition AS
SELECT r.id            AS requisition_id,
       f.facility_name,
       f.facility_type,
       f.geographic_zone,
       p.program_name,
       r.status,
       r.emergency,
       r.createddate   AS created_at,
       r.modifieddate  AS modified_at,
       supplying.name  AS supplying_facility,
       (SELECT count(*) FROM requisition.requisition_line_items li
         WHERE li.requisitionid = r.id) AS line_items,
       (SELECT coalesce(sum(li.requestedquantity), 0) FROM requisition.requisition_line_items li
         WHERE li.requisitionid = r.id) AS requested_quantity,
       (SELECT coalesce(sum(li.approvedquantity), 0) FROM requisition.requisition_line_items li
         WHERE li.requisitionid = r.id) AS approved_quantity,
       date_part('day', now() - r.createddate)::int AS age_days
FROM requisition.requisitions r
LEFT JOIN analytics.dim_facility f ON f.facility_id = r.facilityid
LEFT JOIN analytics.dim_program  p ON p.program_id = r.programid
LEFT JOIN referencedata.facilities supplying ON supplying.id = r.supplyingfacilityid;

CREATE VIEW analytics.fact_requisition_line AS
SELECT li.id           AS line_id,
       li.requisitionid AS requisition_id,
       f.facility_name,
       o.product_code,
       o.product_name,
       r.status,
       li.beginningbalance      AS beginning_balance,
       li.totalreceivedquantity AS received_quantity,
       li.totalconsumedquantity AS consumed_quantity,
       li.stockonhand           AS stock_on_hand,
       li.requestedquantity     AS requested_quantity,
       li.approvedquantity      AS approved_quantity,
       li.calculatedorderquantity AS calculated_order_quantity,
       li.totalstockoutdays     AS stockout_days,
       li.averageconsumption    AS average_consumption,
       li.totalcost             AS total_cost
FROM requisition.requisition_line_items li
JOIN requisition.requisitions r ON r.id = li.requisitionid
LEFT JOIN analytics.dim_facility  f ON f.facility_id = r.facilityid
LEFT JOIN analytics.dim_orderable o ON o.orderable_id = li.orderableid;

CREATE VIEW analytics.fact_order AS
SELECT o.id           AS order_id,
       o.ordercode    AS order_code,
       o.status,
       o.emergency,
       o.createddate  AS created_at,
       o.lastupdateddate AS last_updated_at,
       req.name       AS requesting_facility,
       sup.name       AS supplying_facility,
       rec.name       AS receiving_facility,
       p.program_name,
       o.quotedcost   AS quoted_cost,
       (SELECT count(*) FROM fulfillment.order_line_items li WHERE li.orderid = o.id) AS line_items,
       (SELECT coalesce(sum(li.orderedquantity), 0) FROM fulfillment.order_line_items li
         WHERE li.orderid = o.id) AS ordered_quantity,
       date_part('day', now() - o.createddate)::int AS age_days
FROM fulfillment.orders o
LEFT JOIN referencedata.facilities req ON req.id = o.requestingfacilityid
LEFT JOIN referencedata.facilities sup ON sup.id = o.supplyingfacilityid
LEFT JOIN referencedata.facilities rec ON rec.id = o.receivingfacilityid
LEFT JOIN analytics.dim_program p ON p.program_id = o.programid;

CREATE VIEW analytics.fact_shipment AS
SELECT s.id          AS shipment_id,
       o.order_code,
       o.status      AS order_status,
       o.supplying_facility,
       o.receiving_facility,
       s.shippeddate AS shipped_at,
       u.username    AS shipped_by,
       pod.status    AS pod_status,
       pod.receiveddate AS pod_received_date,
       pod.receivedby   AS pod_received_by,
       (SELECT count(*) FROM fulfillment.shipment_line_items li WHERE li.shipmentid = s.id) AS line_items
FROM fulfillment.shipments s
LEFT JOIN analytics.fact_order o ON o.order_id = s.orderid
LEFT JOIN analytics.dim_user   u ON u.user_id = s.shippedbyid
LEFT JOIN fulfillment.proofs_of_delivery pod ON pod.shipmentid = s.id;
