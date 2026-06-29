#!/usr/bin/env bash
#
# Add a TEST medicine (orderable) to OpenLMIS, with stock so it can be dispensed.
# Mirrors how scripts/seed.sh seeds orderables (direct DB insert — the OpenLMIS API
# ignores the supplied UUID) + a CREDIT stock event for initial stock.
#
# Usage:
#   bash scripts/add-test-medicine.sh CODE "Full Product Name" [QTY]
# Example:
#   bash scripts/add-test-medicine.sh PANADOL500 "Panadol 500mg" 500
#
set -euo pipefail

CODE="${1:?usage: add-test-medicine.sh CODE \"Full Product Name\" [QTY]}"
NAME="${2:?usage: add-test-medicine.sh CODE \"Full Product Name\" [QTY]}"
QTY="${3:-1000}"

DB=openlmis-ref-distro-db-1
LMIS="${LMIS_URL:-http://localhost:8082}"     # OpenLMIS nginx (use :80 on some prod hosts)

# Resolve the required IDs from the live DB (fall back to the seed.sh defaults).
# This keeps the script working even if the seeded UUIDs differ on a given host.
q() { docker exec "$DB" psql -U postgres -d open_lmis -t -A -c "$1" 2>/dev/null | head -1; }
PROGRAM_ID=$(q "SELECT id FROM referencedata.programs WHERE code='EM' OR name ILIKE 'Essential%' LIMIT 1");        PROGRAM_ID=${PROGRAM_ID:-31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c}
FACILITY_ID=$(q "SELECT id FROM referencedata.facilities WHERE code='MC-A' OR name ILIKE 'Maseru%Clinic A%' LIMIT 1"); FACILITY_ID=${FACILITY_ID:-28de536f-b826-4eeb-a3c4-d65221a1120d}
DISPENSABLE_ID=$(q "SELECT id FROM referencedata.dispensables LIMIT 1");                                           DISPENSABLE_ID=${DISPENSABLE_ID:-aaaaaaaa-0000-0000-0000-000000000001}
ODC_ID=$(q "SELECT id FROM referencedata.orderable_display_categories LIMIT 1");                                  ODC_ID=${ODC_ID:-a1b2c3d4-e5f6-4a7b-8c9d-000000000001}
RECEIPT_REASON=$(q "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name ILIKE 'Receipt%' LIMIT 1"); RECEIPT_REASON=${RECEIPT_REASON:-313f2f5f-0c22-4626-8c49-3554ef763de3}

if [ -z "$(q "SELECT 1 FROM referencedata.programs WHERE id='${PROGRAM_ID}'")" ]; then
  echo "ERROR: OpenLMIS reference data not found (program missing) — is OpenLMIS seeded? Run: make seed / bash scripts/seed.sh" >&2
  exit 1
fi

gen() { python3 -c "import uuid;print(uuid.uuid4())"; }
ORDERABLE_ID=$(gen); TRADE_ID=$(gen); LOT_ID=$(gen)
LOT_CODE="${CODE}-LOT-$(date +%Y)"

echo "Adding orderable  code=${CODE}  name=\"${NAME}\"  qty=${QTY}"
echo "  orderable UUID = ${ORDERABLE_ID}"
echo "  lot UUID       = ${LOT_ID}"

# ── 1. Reference data (orderable + program link + trade item + lot + approved product)
docker exec -i "$DB" psql -U postgres -d open_lmis -q <<SQL
INSERT INTO referencedata.orderables
  (id, versionnumber, lastupdated, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
VALUES ('${ORDERABLE_ID}', 1, NOW(), '${NAME}', 0, 1, '${CODE}', false, '${DISPENSABLE_ID}')
ON CONFLICT (id, versionnumber) DO UPDATE SET fullproductname = EXCLUDED.fullproductname;

INSERT INTO referencedata.program_orderables
  (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, orderableversionnumber, programid)
VALUES (gen_random_uuid(), true, 99, true, '${ODC_ID}', '${ORDERABLE_ID}', 1, '${PROGRAM_ID}')
ON CONFLICT DO NOTHING;

INSERT INTO referencedata.trade_items (id, manufactureroftradeitem)
VALUES ('${TRADE_ID}', 'Generic') ON CONFLICT (id) DO NOTHING;

INSERT INTO referencedata.orderable_identifiers (key, value, orderableid, orderableversionnumber)
VALUES ('tradeItem', '${TRADE_ID}', '${ORDERABLE_ID}', 1) ON CONFLICT DO NOTHING;

INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active)
VALUES ('${LOT_ID}', '${LOT_CODE}', '2028-12-31', '2026-01-01', '${TRADE_ID}', true) ON CONFLICT (id) DO NOTHING;

INSERT INTO referencedata.facility_type_approved_products
  (id, versionnumber, lastupdated, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, active, facilitytypeid, orderableid, programid)
SELECT gen_random_uuid(), 1, NOW(), 0, 3, 0, true, f.typeid, '${ORDERABLE_ID}', '${PROGRAM_ID}'
FROM referencedata.facilities f
WHERE f.id = '${FACILITY_ID}'
  AND NOT EXISTS (
    SELECT 1 FROM referencedata.facility_type_approved_products
    WHERE facilitytypeid = f.typeid AND orderableid = '${ORDERABLE_ID}' AND programid = '${PROGRAM_ID}'
  );
SQL
echo "  reference data inserted."

# ── 2. Initial stock via OpenLMIS stockEvents API (CREDIT / Receipts) so SOH > 0
TOKEN=$(curl -s -X POST "${LMIS}/api/oauth/token?grant_type=password&username=admin&password=password" \
  -H "Authorization: Basic dXNlci1jbGllbnQ6Y2hhbmdlbWU=" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))")
if [ -z "$TOKEN" ]; then echo "WARN: could not get OpenLMIS token — orderable created but no stock added." >&2; exit 0; fi

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${LMIS}/api/stockEvents" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${ORDERABLE_ID}\",\"lotId\":\"${LOT_ID}\",\"quantity\":${QTY},\"occurredDate\":\"$(date -u +%Y-%m-%d)\",\"reasonId\":\"${RECEIPT_REASON}\",\"documentationNo\":\"ADD-TEST-${CODE}\"}]}")
echo "  stock CREDIT (${QTY}) -> HTTP ${HTTP}"

echo ""
echo "Done."
echo "  Orderable UUID: ${ORDERABLE_ID}"
echo "  Next: pick it up in the mediator now ->  docker compose restart bkm-mediator"
echo "        (or wait up to 1h for the hourly orderable refresh)"
echo "  To dispense: send a MedicationDispense/QR with medication code '${CODE}'."
echo "  For DHIS2 reporting, add this UUID to DHIS2_ORDERABLE_DE_MAP with a data element."
