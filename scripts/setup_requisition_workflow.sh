#!/usr/bin/env bash
#
# NEC XON (c) Copyright 2025. All rights reserved.
#
# setup_requisition_workflow.sh — Tier 1: enable the OpenLMIS requisition lifecycle
# (INITIATED -> SUBMITTED -> AUTHORIZED -> APPROVED -> RELEASED) for Clinic A +
# Essential Medicines, demoable in the OpenLMIS UI. Does NOT do fulfilment
# (order/shipment/Proof-of-Delivery -> stock credit) — that's Tier 2.
#
# referencedata config (schedule/period/node/group/rights) is inserted directly into
# the DB (the processingPeriods API NPEs in this 2018 ref-distro); only the requisition
# TEMPLATE goes through the API (its columnsMap is validated server-side).
# Idempotent. Requires a seeded OpenLMIS (facility, program, orderables, FTAP).
#
# Usage:  bash scripts/setup_requisition_workflow.sh
# Env:    OLMIS_URL (default http://localhost:8082)  OLMIS_USER/OLMIS_PASS (admin/password)
#         OLMIS_DB_CONTAINER (default openlmis-ref-distro-db-1)

set -euo pipefail

OLMIS_URL="${OLMIS_URL:-http://localhost:8082}"
OLMIS_USER="${OLMIS_USER:-admin}"
OLMIS_PASS="${OLMIS_PASS:-password}"
OLMIS_DB="${OLMIS_DB_CONTAINER:-openlmis-ref-distro-db-1}"

FAC_A="28de536f-b826-4eeb-a3c4-d65221a1120d"   # Maseru District Clinic A
PROGRAM="31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c" # Essential Medicines
ADMIN_USER="35316636-6264-6331-2d34-3933322d3462"

log() { echo "[req-wf] $*"; }
psql_() { docker exec "$OLMIS_DB" psql -U postgres -d open_lmis "$@"; }
q() { psql_ -tAc "$1" | tr -d '[:space:]'; }

FAC_TYPE=$(q "SELECT typeid FROM referencedata.facilities WHERE id='$FAC_A';")
[ -z "$FAC_TYPE" ] && { log "ERROR: Clinic A facility not found — seed OpenLMIS first."; exit 1; }
log "Clinic A facility type: $FAC_TYPE"

START=$(date +%Y-%m-01)
END=$(date -d "$START +1 month -1 day" +%Y-%m-%d)
PNAME=$(date +"%b %Y")

# ── 1. Processing schedule ────────────────────────────────────────────────────
psql_ -c "INSERT INTO referencedata.processing_schedules (id, code, name, description, modifieddate)
  SELECT gen_random_uuid(), 'BKM-MONTHLY', 'BKM Monthly', 'BKM monthly requisition schedule', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.processing_schedules WHERE code='BKM-MONTHLY');" >/dev/null
SCHED_ID=$(q "SELECT id FROM referencedata.processing_schedules WHERE code='BKM-MONTHLY';")
log "schedule: $SCHED_ID"

# ── 2. Processing period (current month) ──────────────────────────────────────
psql_ -c "INSERT INTO referencedata.processing_periods (id, name, description, startdate, enddate, processingscheduleid)
  SELECT gen_random_uuid(), '$PNAME', 'BKM $PNAME', DATE '$START', DATE '$END', '$SCHED_ID'
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.processing_periods WHERE processingscheduleid='$SCHED_ID' AND name='$PNAME');" >/dev/null
PERIOD_ID=$(q "SELECT id FROM referencedata.processing_periods WHERE processingscheduleid='$SCHED_ID' AND name='$PNAME';")
log "period $PNAME ($START..$END): $PERIOD_ID"

# ── 3. Supervisory node (over Clinic A) ───────────────────────────────────────
psql_ -c "INSERT INTO referencedata.supervisory_nodes (id, code, name, facilityid)
  SELECT gen_random_uuid(), 'BKM-SN-A', 'BKM Supervisory Node (Clinic A)', '$FAC_A'
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.supervisory_nodes WHERE code='BKM-SN-A');" >/dev/null
SN_ID=$(q "SELECT id FROM referencedata.supervisory_nodes WHERE code='BKM-SN-A';")
log "supervisory node: $SN_ID"

# ── 4. Requisition group + member + program-schedule ──────────────────────────
psql_ -c "INSERT INTO referencedata.requisition_groups (id, code, name, supervisorynodeid)
  SELECT gen_random_uuid(), 'BKM-RG-A', 'BKM Requisition Group (Clinic A)', '$SN_ID'
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.requisition_groups WHERE code='BKM-RG-A');" >/dev/null
RG_ID=$(q "SELECT id FROM referencedata.requisition_groups WHERE code='BKM-RG-A';")
psql_ -c "INSERT INTO referencedata.requisition_group_members (requisitiongroupid, facilityid)
  SELECT '$RG_ID', '$FAC_A'
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.requisition_group_members WHERE requisitiongroupid='$RG_ID' AND facilityid='$FAC_A');" >/dev/null
psql_ -c "INSERT INTO referencedata.requisition_group_program_schedules (id, directdelivery, processingscheduleid, programid, requisitiongroupid)
  SELECT gen_random_uuid(), false, '$SCHED_ID', '$PROGRAM', '$RG_ID'
  WHERE NOT EXISTS (SELECT 1 FROM referencedata.requisition_group_program_schedules WHERE requisitiongroupid='$RG_ID' AND programid='$PROGRAM');" >/dev/null
log "requisition group: $RG_ID (member Clinic A + Essential Medicines schedule)"

# ── 5. Requisition template + columns + assignment (DB inserts) ───────────────
# The 2018 requisition-template API NPEs on CALCULATED columns + templateAssignments
# (errors masked by the security filter); a DB-built template initiates fine.
# columns_maps.source ordinal: USER_INPUT=0, CALCULATED=1. The calc chain
# (adjustedConsumption -> averageConsumption -> maximumStockQuantity ->
# calculatedOrderQuantity) MUST be present (kept hidden) or the template is rejected.
TMPL_ID="bbbbbbbb-0000-0000-0000-000000000001"
if [ -z "$(q "SELECT 1 FROM requisition.requisition_templates WHERE name='BKM Essential Medicines';")" ]; then
  psql_ -c "
    INSERT INTO requisition.requisition_templates
      (id,name,numberofperiodstoaverage,populatestockonhandfromstockcards,archived,
       enableavgconsumptionforcurrentperiod,rejectionreasonwindowvisible,requisitionreportingonly,patientstabenabled)
    VALUES ('$TMPL_ID','BKM Essential Medicines',3,false,false,false,false,false,false);
    INSERT INTO requisition.columns_maps
      (requisitiontemplateid,requisitioncolumnid,definition,displayorder,indicator,isdisplayed,label,name,key,source)
    SELECT '$TMPL_ID', c.id, c.definition, row_number() OVER (ORDER BY c.name), c.indicator,
      CASE WHEN c.name IN ('calculatedOrderQuantity','maximumStockQuantity','averageConsumption','adjustedConsumption') THEN false ELSE true END,
      c.name, c.name, c.name,
      CASE WHEN c.name IN ('calculatedOrderQuantity','maximumStockQuantity','averageConsumption','adjustedConsumption') THEN 1 ELSE 0 END
    FROM requisition.available_requisition_columns c
    WHERE c.name IN ('requestedQuantity','requestedQuantityExplanation','beginningBalance',
                     'totalReceivedQuantity','totalConsumedQuantity','totalStockoutDays','stockOnHand',
                     'approvedQuantity','adjustedConsumption','averageConsumption','maximumStockQuantity','calculatedOrderQuantity');
    INSERT INTO requisition.requisition_template_assignments (id,programid,facilitytypeid,templateid,requisitionreportonly)
    VALUES (gen_random_uuid(),'$PROGRAM','$FAC_TYPE','$TMPL_ID',false);" >/dev/null
  log "requisition template created: $TMPL_ID (assigned to Essential Medicines / health_center)"
else
  log "requisition template exists."
fi

# ── 6. Rights (denormalized right_assignments cache — direct DB insert) ────────
for RIGHT in REQUISITION_CREATE REQUISITION_AUTHORIZE REQUISITION_APPROVE REQUISITION_VIEW REQUISITION_DELETE; do
  psql_ -c "INSERT INTO referencedata.right_assignments (id, rightname, facilityid, programid, userid)
    SELECT gen_random_uuid(), '$RIGHT', '$FAC_A', '$PROGRAM', '$ADMIN_USER'
    WHERE NOT EXISTS (SELECT 1 FROM referencedata.right_assignments
      WHERE rightname='$RIGHT' AND facilityid='$FAC_A' AND programid='$PROGRAM' AND userid='$ADMIN_USER');" >/dev/null
done
log "REQUISITION rights granted to admin (Clinic A + Essential Medicines)."

log "Done. Demo: OpenLMIS UI -> Requisitions -> Create/Authorize -> Clinic A / Essential Medicines / $PNAME -> Initiate."
