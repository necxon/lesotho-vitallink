-- =============================================================================
-- openlmis_reports.sql - reporting views consumed by Superset (database open_lmis)
--
-- Depends on scripts/sql/openlmis_analytics.sql. Apply that first.
-- These are the Superset datasets: already shaped so no chart needs custom SQL.
-- =============================================================================

-- --- Headline -----------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_kpi_overview AS
SELECT (SELECT count(*) FROM analytics.dim_facility)                       AS facilities,
       (SELECT count(*) FROM analytics.dim_facility WHERE active AND enabled) AS facilities_active,
       (SELECT count(*) FROM analytics.dim_orderable)                      AS products,
       (SELECT count(*) FROM analytics.dim_program)                        AS programs,
       (SELECT count(*) FROM analytics.dim_lot)                            AS lots,
       (SELECT count(*) FROM analytics.dim_lot WHERE is_expired)           AS lots_expired,
       (SELECT count(*) FROM analytics.dim_user)                           AS users,
       (SELECT count(*) FROM analytics.fact_stock_card)                    AS stock_cards,
       (SELECT coalesce(sum(stock_on_hand), 0) FROM analytics.fact_stock_card) AS total_units_on_hand,
       (SELECT count(*) FROM analytics.fact_stock_card WHERE coalesce(stock_on_hand, 0) <= 0) AS stockouts,
       (SELECT count(*) FROM analytics.fact_stock_movement)                AS stock_movements,
       (SELECT count(*) FROM analytics.fact_stock_event)                   AS stock_events,
       (SELECT count(*) FROM analytics.fact_physical_inventory)            AS physical_inventories,
       (SELECT count(*) FROM analytics.fact_requisition)                   AS requisitions,
       (SELECT count(*) FROM analytics.fact_requisition
         WHERE status NOT IN ('RELEASED', 'SKIPPED'))                      AS requisitions_open,
       (SELECT count(*) FROM analytics.fact_order)                         AS orders,
       (SELECT count(*) FROM analytics.fact_shipment)                      AS shipments;

-- --- Stock --------------------------------------------------------------------

-- The stock ledger as a table, with a traffic-light band per line.
CREATE OR REPLACE VIEW analytics.rpt_stock_current AS
SELECT facility_name,
       facility_type,
       geographic_zone,
       product_code,
       product_name,
       program_name,
       coalesce(lot_code, '(no lot)') AS lot_code,
       expiry_date,
       expiry_band,
       coalesce(stock_on_hand, 0) AS stock_on_hand,
       soh_as_of,
       CASE
         WHEN stock_on_hand IS NULL       THEN 'Never counted'
         WHEN stock_on_hand <= 0          THEN 'Stock-out'
         WHEN stock_on_hand < 50          THEN 'Critical'
         WHEN stock_on_hand < 200         THEN 'Low'
         ELSE 'Adequate'
       END AS stock_status,
       (current_date - soh_as_of) AS days_since_count
FROM analytics.fact_stock_card;

CREATE OR REPLACE VIEW analytics.rpt_stock_by_facility AS
SELECT facility_name,
       facility_type,
       geographic_zone,
       count(*)                                 AS stock_lines,
       count(DISTINCT product_code)             AS products_stocked,
       coalesce(sum(stock_on_hand), 0)          AS total_units,
       count(*) FILTER (WHERE coalesce(stock_on_hand, 0) <= 0) AS stockouts,
       count(*) FILTER (WHERE stock_on_hand > 0 AND stock_on_hand < 50) AS critical_lines,
       max(soh_as_of)                           AS last_counted
FROM analytics.fact_stock_card
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_stock_by_product AS
SELECT product_code,
       product_name,
       program_name,
       count(DISTINCT facility_id)     AS facilities_stocking,
       coalesce(sum(stock_on_hand), 0) AS total_units,
       round(avg(stock_on_hand), 1)    AS avg_units_per_facility,
       min(stock_on_hand)              AS min_units,
       max(stock_on_hand)              AS max_units,
       count(*) FILTER (WHERE coalesce(stock_on_hand, 0) <= 0) AS stockout_lines
FROM analytics.fact_stock_card
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_stock_alerts AS
SELECT CASE WHEN coalesce(stock_on_hand, 0) <= 0 THEN 'Stock-out' ELSE 'Critical' END AS severity,
       facility_name,
       product_name,
       coalesce(lot_code, '(no lot)') AS lot_code,
       coalesce(stock_on_hand, 0)     AS stock_on_hand,
       soh_as_of,
       expiry_band
FROM analytics.fact_stock_card
WHERE coalesce(stock_on_hand, 0) < 50;

-- Stock on hand over time, straight from the recalculation history.
CREATE OR REPLACE VIEW analytics.rpt_soh_trend AS
SELECT occurred_date,
       facility_name,
       product_name,
       coalesce(lot_code, '(no lot)') AS lot_code,
       stock_on_hand
FROM analytics.fact_soh_history;

-- --- Movements ----------------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_movements_daily AS
SELECT occurred_date,
       product_name,
       coalesce(reason_type, 'UNKNOWN') AS reason_type,
       count(*)                  AS movements,
       sum(quantity)             AS quantity,
       sum(signed_quantity)      AS net_quantity
FROM analytics.fact_stock_movement
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_movements_by_reason AS
SELECT coalesce(reason_name, 'Unspecified') AS reason_name,
       coalesce(reason_category, 'Unspecified') AS reason_category,
       coalesce(reason_type, 'UNKNOWN')      AS reason_type,
       count(*)             AS movements,
       sum(quantity)        AS quantity,
       sum(signed_quantity) AS net_quantity
FROM analytics.fact_stock_movement
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_movements_by_facility AS
SELECT facility_name,
       facility_type,
       product_name,
       count(*)             AS movements,
       sum(signed_quantity) AS net_quantity,
       max(occurred_date)   AS last_movement
FROM analytics.fact_stock_movement
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_movement_detail AS
SELECT occurred_date,
       facility_name,
       product_name,
       coalesce(lot_code, '(no lot)') AS lot_code,
       coalesce(reason_name, 'Unspecified') AS reason_name,
       reason_type,
       quantity,
       signed_quantity,
       recorded_by,
       document_number,
       processed_at
FROM analytics.fact_stock_movement;

-- --- Lots and expiry ----------------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_lot_expiry AS
SELECT expiry_band,
       count(*)                        AS lots,
       coalesce(sum(stock_on_hand), 0) AS units_at_risk
FROM analytics.fact_stock_card
WHERE lot_code IS NOT NULL
GROUP BY 1;

CREATE OR REPLACE VIEW analytics.rpt_lot_detail AS
SELECT sc.lot_code,
       sc.product_name,
       sc.facility_name,
       sc.expiry_date,
       sc.expiry_band,
       coalesce(sc.stock_on_hand, 0) AS stock_on_hand,
       l.days_to_expiry
FROM analytics.fact_stock_card sc
LEFT JOIN analytics.dim_lot l ON l.lot_id = sc.lot_id
WHERE sc.lot_code IS NOT NULL;

-- --- Network / reference data -------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_facility_network AS
SELECT facility_code,
       facility_name,
       facility_type,
       geographic_zone,
       parent_zone,
       active,
       enabled,
       go_live_date,
       latitude,
       longitude
FROM analytics.dim_facility;

CREATE OR REPLACE VIEW analytics.rpt_facilities_by_type AS
SELECT coalesce(facility_type, 'Unspecified') AS facility_type,
       coalesce(geographic_zone, 'Unspecified') AS geographic_zone,
       count(*) AS facilities,
       count(*) FILTER (WHERE active AND enabled) AS active_facilities
FROM analytics.dim_facility
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_product_catalogue AS
SELECT o.product_code,
       o.product_name,
       o.net_content,
       p.name AS program_name,
       po.fullsupply   AS full_supply,
       po.priceperpack AS price_per_pack,
       po.active
FROM analytics.dim_orderable o
LEFT JOIN referencedata.program_orderables po
       ON po.orderableid = o.orderable_id
      AND po.orderableversionnumber = o.version_number
LEFT JOIN referencedata.programs p ON p.id = po.programid;

CREATE OR REPLACE VIEW analytics.rpt_approved_products AS
SELECT facility_type,
       program_name,
       product_code,
       product_name,
       min_periods_of_stock,
       max_periods_of_stock,
       emergency_order_point,
       active
FROM analytics.dim_approved_product;

CREATE OR REPLACE VIEW analytics.rpt_program_coverage AS
SELECT program_name,
       count(*) AS supported_facilities,
       count(*) FILTER (WHERE active) AS active_support,
       count(*) FILTER (WHERE locally_fulfilled) AS locally_fulfilled
FROM analytics.bridge_supported_program
GROUP BY 1;

CREATE OR REPLACE VIEW analytics.rpt_users AS
SELECT username,
       full_name,
       job_title,
       email,
       phone,
       home_facility,
       active,
       verified
FROM analytics.dim_user;

-- --- Requisitions and orders --------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_requisition_pipeline AS
SELECT status,
       coalesce(program_name, 'Unspecified') AS program_name,
       count(*)                AS requisitions,
       count(*) FILTER (WHERE emergency) AS emergency,
       round(avg(age_days), 1) AS avg_age_days,
       sum(requested_quantity) AS requested_quantity,
       sum(approved_quantity)  AS approved_quantity
FROM analytics.fact_requisition
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_requisition_detail AS
SELECT created_at,
       facility_name,
       program_name,
       status,
       emergency,
       line_items,
       requested_quantity,
       approved_quantity,
       supplying_facility,
       age_days
FROM analytics.fact_requisition;

CREATE OR REPLACE VIEW analytics.rpt_requisition_lines AS
SELECT facility_name,
       product_name,
       status,
       beginning_balance,
       received_quantity,
       consumed_quantity,
       stock_on_hand,
       requested_quantity,
       approved_quantity,
       stockout_days,
       average_consumption
FROM analytics.fact_requisition_line;

CREATE OR REPLACE VIEW analytics.rpt_order_pipeline AS
SELECT status,
       coalesce(program_name, 'Unspecified') AS program_name,
       count(*)                AS orders,
       count(*) FILTER (WHERE emergency) AS emergency,
       sum(ordered_quantity)   AS ordered_quantity,
       round(avg(age_days), 1) AS avg_age_days
FROM analytics.fact_order
GROUP BY 1, 2;

CREATE OR REPLACE VIEW analytics.rpt_order_detail AS
SELECT created_at,
       order_code,
       status,
       requesting_facility,
       supplying_facility,
       program_name,
       line_items,
       ordered_quantity,
       age_days
FROM analytics.fact_order;

CREATE OR REPLACE VIEW analytics.rpt_shipment_detail AS
SELECT shipped_at,
       order_code,
       order_status,
       supplying_facility,
       receiving_facility,
       shipped_by,
       line_items,
       pod_status,
       pod_received_date,
       pod_received_by
FROM analytics.fact_shipment;

-- --- Activity and data quality ------------------------------------------------

CREATE OR REPLACE VIEW analytics.rpt_stock_events_daily AS
SELECT date_trunc('day', processed_at) AS event_day,
       coalesce(facility_name, 'Unknown') AS facility_name,
       coalesce(event_origin, 'unspecified') AS event_origin,
       count(*)         AS events,
       sum(line_items)  AS line_items
FROM analytics.fact_stock_event
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW analytics.rpt_physical_inventories AS
SELECT occurred_date,
       facility_name,
       program_name,
       is_draft,
       line_items,
       document_number
FROM analytics.fact_physical_inventory;

CREATE OR REPLACE VIEW analytics.rpt_data_quality AS
SELECT 'Facility with no geographic zone' AS check_name, 'Facility' AS entity, 'error' AS severity, count(*) AS failing_rows
FROM analytics.dim_facility WHERE geographic_zone IS NULL
UNION ALL
SELECT 'Facility disabled or inactive', 'Facility', 'info', count(*)
FROM analytics.dim_facility WHERE NOT (active AND enabled)
UNION ALL
SELECT 'Facility supports no programs', 'Facility', 'warning', count(*)
FROM analytics.dim_facility f
WHERE NOT EXISTS (SELECT 1 FROM analytics.bridge_supported_program s WHERE s.facility_id = f.facility_id)
UNION ALL
SELECT 'Facility has no stock cards', 'Facility', 'warning', count(*)
FROM analytics.dim_facility f
WHERE NOT EXISTS (SELECT 1 FROM analytics.fact_stock_card c WHERE c.facility_id = f.facility_id)
UNION ALL
SELECT 'Product not linked to any program', 'Product', 'error', count(*)
FROM analytics.dim_orderable o
WHERE NOT EXISTS (
  SELECT 1 FROM referencedata.program_orderables po
   WHERE po.orderableid = o.orderable_id AND po.orderableversionnumber = o.version_number
)
UNION ALL
SELECT 'Product not approved for any facility type', 'Product', 'warning', count(*)
FROM analytics.dim_orderable o
WHERE NOT EXISTS (SELECT 1 FROM analytics.dim_approved_product a WHERE a.product_code = o.product_code)
UNION ALL
SELECT 'Stock card never counted', 'Stock card', 'warning', count(*)
FROM analytics.fact_stock_card WHERE stock_on_hand IS NULL
UNION ALL
SELECT 'Stock card with negative stock on hand', 'Stock card', 'error', count(*)
FROM analytics.fact_stock_card WHERE stock_on_hand < 0
UNION ALL
SELECT 'Stock not counted in the last 30 days', 'Stock card', 'warning', count(*)
FROM analytics.fact_stock_card WHERE soh_as_of < current_date - 30
UNION ALL
SELECT 'Expired lot still holding stock', 'Lot', 'error', count(*)
FROM analytics.fact_stock_card WHERE is_expired AND coalesce(stock_on_hand, 0) > 0
UNION ALL
SELECT 'Lot with no expiry date', 'Lot', 'warning', count(*)
FROM analytics.dim_lot WHERE expiry_date IS NULL
UNION ALL
SELECT 'Stock movement with no reason', 'Movement', 'warning', count(*)
FROM analytics.fact_stock_movement WHERE reason_name IS NULL
UNION ALL
SELECT 'User with no home facility', 'User', 'info', count(*)
FROM analytics.dim_user WHERE home_facility IS NULL
UNION ALL
SELECT 'Requisition open longer than 30 days', 'Requisition', 'warning', count(*)
FROM analytics.fact_requisition WHERE age_days > 30 AND status NOT IN ('RELEASED', 'SKIPPED')
UNION ALL
SELECT 'Order with no shipment', 'Order', 'warning', count(*)
FROM analytics.fact_order o
WHERE NOT EXISTS (SELECT 1 FROM analytics.fact_shipment s WHERE s.order_code = o.order_code)
UNION ALL
SELECT 'Shipment with no proof of delivery', 'Shipment', 'warning', count(*)
FROM analytics.fact_shipment WHERE pod_status IS NULL;
