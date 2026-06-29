#!/usr/bin/env bash
# scripts/demo-setup.sh — sets up a clean two-medicine demo environment
# Medicines: Albendazole (1000 stock) + Amoxicillin 250mg (1000 stock)
# Removes other medicines from the FHIR supply list and zeroes them in OpenLMIS.
# Run: bash scripts/demo-setup.sh
set -euo pipefail

FACILITY_ID="28de536f-b826-4eeb-a3c4-d65221a1120d"
PROGRAM_ID="31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c"
DISPENSABLE_ID="aaaaaaaa-0000-0000-0000-000000000001"
ODC_ID="a1b2c3d4-e5f6-4a7b-8c9d-000000000001"

ALBEND_ID="3be1d20f-6aa9-4e52-864f-4fa04aa02009"
AMOX_ID="3be1d20f-6aa9-4e52-864f-4fa04aa02002"
ALBEND_LOT="ffffffff-0000-0000-0000-000000000009"
ALBEND_TRADE_ITEM="eeeeeeee-0000-0000-0000-000000000009"
AMOX_LOT="ffffffff-0000-0000-0000-000000000002"

SUPPLY_LIST_ID="69141df8-4984-447d-94cb-c7ac4e790323"
ALBEND_GROUP_ID="57348fee-99c2-4ade-a8f5-571145cc9b0a"

TODAY=$(date +%Y-%m-%d)

log() { echo "[demo-setup] $*"; }
warn() { echo "[demo-setup] WARN: $*" >&2; }

# ─── Step 1: Create Albendazole DHIS2 data element ─────────────────────────
log "Step 1: Creating DHIS2 data element DEAlbend001 ..."
curl -s -X POST "http://localhost:8081/api/dataElements" \
  -u admin:district \
  -H "Content-Type: application/json" \
  -d '{
    "id": "DEAlbend001",
    "name": "Stock Dispensed - Albendazole",
    "shortName": "Albendazole Dispensed",
    "aggregationType": "SUM",
    "domainType": "AGGREGATE",
    "valueType": "INTEGER",
    "zeroIsSignificant": true
  }' > /tmp/dhis2_de_resp.json 2>&1
python3 -c "import json,sys; d=json.load(open('/tmp/dhis2_de_resp.json')); print('  result:', d.get('status','?'), d.get('response',{}).get('uid',''), d.get('httpStatusCode',''))" || true

# Add DEAlbend001 to the same dataset as ujPSJuS9pph
DATASET_ID=$(curl -s "http://localhost:8081/api/dataSets?fields=id,name&filter=dataSetElements.dataElement.id:eq:ujPSJuS9pph" \
  -u admin:district | python3 -c "import sys,json;d=json.load(sys.stdin);ds=d.get('dataSets',[]); print(ds[0]['id'] if ds else '')")
if [ -n "$DATASET_ID" ]; then
  log "  Adding DEAlbend001 to dataset $DATASET_ID ..."
  curl -s -X POST "http://localhost:8081/api/dataSets/${DATASET_ID}/dataSetElements" \
    -u admin:district \
    -H "Content-Type: application/json" \
    -d "{\"dataElement\":{\"id\":\"DEAlbend001\"}}" > /dev/null || true
fi

# ─── Step 2: Insert Albendazole orderable into OpenLMIS ─────────────────────
log "Step 2: Inserting Albendazole orderable into OpenLMIS DB ..."
docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -q << SQL_EOF
INSERT INTO referencedata.trade_items (id, manufactureroftradeitem)
VALUES ('${ALBEND_TRADE_ITEM}', 'Generic Pharma')
ON CONFLICT DO NOTHING;

INSERT INTO referencedata.lots (id, lotcode, expirationdate, manufacturedate, tradeitemid, active)
VALUES ('${ALBEND_LOT}', 'ALBEND-LOT-2026', '2028-12-31', '2026-01-01', '${ALBEND_TRADE_ITEM}', true)
ON CONFLICT DO NOTHING;

INSERT INTO referencedata.orderables
  (id, versionnumber, lastupdated, fullproductname, packroundingthreshold, netcontent, code, roundtozero, dispensableid)
VALUES ('${ALBEND_ID}', 1, NOW(), 'Albendazole', 0, 1, 'ALBENDAZOLE', false, '${DISPENSABLE_ID}')
ON CONFLICT (id, versionnumber) DO UPDATE SET fullproductname='Albendazole';

INSERT INTO referencedata.orderable_identifiers (key, value, orderableid, orderableversionnumber)
VALUES ('tradeItem', '${ALBEND_TRADE_ITEM}', '${ALBEND_ID}', 1)
ON CONFLICT DO NOTHING;

INSERT INTO referencedata.program_orderables
  (id, active, displayorder, fullsupply, orderabledisplaycategoryid, orderableid, orderableversionnumber, programid)
SELECT gen_random_uuid(), true, 9, true, '${ODC_ID}', '${ALBEND_ID}', 1, '${PROGRAM_ID}'
WHERE NOT EXISTS (
  SELECT 1 FROM referencedata.program_orderables
  WHERE orderableid='${ALBEND_ID}' AND programid='${PROGRAM_ID}'
);

INSERT INTO referencedata.facility_type_approved_products
  (id, versionnumber, lastupdated, emergencyorderpoint, maxperiodsofstock, minperiodsofstock, active, facilitytypeid, orderableid, programid)
SELECT gen_random_uuid(), 1, NOW(), 0, 3, 0, true, f.id, '${ALBEND_ID}', '${PROGRAM_ID}'
FROM referencedata.facility_types f
WHERE f.code IN ('health_center','hospital')
AND NOT EXISTS (
  SELECT 1 FROM referencedata.facility_type_approved_products
  WHERE facilitytypeid=f.id AND orderableid='${ALBEND_ID}' AND programid='${PROGRAM_ID}'
);

INSERT INTO referencedata.right_assignments (id, userid, rightname, facilityid, programid)
SELECT gen_random_uuid(), u.id, 'STOCK_ADJUST', '${FACILITY_ID}', '${PROGRAM_ID}'
FROM referencedata.users u WHERE u.username='admin'
AND NOT EXISTS (
  SELECT 1 FROM referencedata.right_assignments
  WHERE userid=u.id AND rightname='STOCK_ADJUST'
    AND facilityid='${FACILITY_ID}' AND programid='${PROGRAM_ID}'
);
SQL_EOF
log "  Albendazole orderable inserted."

# ─── Step 3: Get OpenLMIS token and reason IDs ──────────────────────────────
log "Step 3: Getting OpenLMIS token and reason IDs ..."
LMIS_TOKEN=$(curl -s -X POST \
  'http://localhost:8082/api/oauth/token?grant_type=password&client_id=user-client&username=admin&password=password' \
  -u 'user-client:changeme' | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('access_token',''))")
[ -z "$LMIS_TOKEN" ] && { warn "Could not get OpenLMIS token"; exit 1; }

RECEIPT_REASON=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Receipts' LIMIT 1;" | tr -d '[:space:]')
CONSUME_REASON=$(docker exec openlmis-ref-distro-db-1 psql -U postgres -d open_lmis -t -c \
  "SELECT id FROM stockmanagement.stock_card_line_item_reasons WHERE name='Consumed' LIMIT 1;" | tr -d '[:space:]')
log "  receipt_reason=$RECEIPT_REASON  consume_reason=$CONSUME_REASON"

# ─── Step 4: Seed Albendazole initial stock 1000 ────────────────────────────
log "Step 4: Seeding Albendazole 1000 stock ..."
RESP=$(curl -s -X POST "http://localhost:8082/api/stockEvents" \
  -H "Authorization: Bearer $LMIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${ALBEND_ID}\",\"lotId\":\"${ALBEND_LOT}\",\"quantity\":1000,\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON}\",\"documentationNo\":\"DEMO-ALBEND-INIT\"}]}")
echo "  Response: $RESP"

# ─── Step 5: Adjust stock levels ────────────────────────────────────────────
log "Step 5: Querying current SOH ..."
SOH_JSON=$(curl -s "http://localhost:8082/api/stockCardSummaries?facility=${FACILITY_ID}&program=${PROGRAM_ID}&page=0&size=50" \
  -H "Authorization: Bearer $LMIS_TOKEN")

get_soh() {
  local oid="$1"
  echo "$SOH_JSON" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for i in d.get('content',[]):
    if i.get('orderable',{}).get('id')=='$oid':
        print(i.get('stockOnHand',0))
        sys.exit(0)
print(0)
"
}

# Reduce Amoxicillin to 1000
AMOX_SOH=$(get_soh "$AMOX_ID")
log "  Amoxicillin SOH=$AMOX_SOH, target=1000"
if [ "$AMOX_SOH" -gt 1000 ]; then
  CONSUME=$((AMOX_SOH - 1000))
  RESP=$(curl -s -X POST "http://localhost:8082/api/stockEvents" \
    -H "Authorization: Bearer $LMIS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${AMOX_ID}\",\"lotId\":\"${AMOX_LOT}\",\"quantity\":${CONSUME},\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${CONSUME_REASON}\",\"documentationNo\":\"DEMO-AMOX-ADJUST\"}]}")
  echo "  Amoxicillin adjust: $RESP"
elif [ "$AMOX_SOH" -lt 1000 ]; then
  ADD=$((1000 - AMOX_SOH))
  RESP=$(curl -s -X POST "http://localhost:8082/api/stockEvents" \
    -H "Authorization: Bearer $LMIS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${AMOX_ID}\",\"lotId\":\"${AMOX_LOT}\",\"quantity\":${ADD},\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${RECEIPT_REASON}\",\"documentationNo\":\"DEMO-AMOX-TOPUP\"}]}")
  echo "  Amoxicillin top-up: $RESP"
fi

# Zero out other 6 medicines (consume all remaining stock from primary lots)
declare -A OTHER_MEDS
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02056"]="ffffffff-0000-0000-0000-000000000001"  # AL20120
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02003"]="ffffffff-0000-0000-0000-000000000003"  # RDTKIT
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02004"]="ffffffff-0000-0000-0000-000000000004"  # PARASYR
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02005"]="ffffffff-0000-0000-0000-000000000005"  # CTX480
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02006"]="ffffffff-0000-0000-0000-000000000006"  # ORSACH
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02007"]="ffffffff-0000-0000-0000-000000000007"  # ZINC20
OTHER_MEDS["3be1d20f-6aa9-4e52-864f-4fa04aa02008"]="ffffffff-0000-0000-0000-000000000008"  # IRNFOL

for OID in "${!OTHER_MEDS[@]}"; do
  LOT="${OTHER_MEDS[$OID]}"
  SOH=$(get_soh "$OID")
  if [ "$SOH" -gt 0 ]; then
    log "  Zeroing out $OID (SOH=$SOH) ..."
    RESP=$(curl -s -X POST "http://localhost:8082/api/stockEvents" \
      -H "Authorization: Bearer $LMIS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"facilityId\":\"${FACILITY_ID}\",\"programId\":\"${PROGRAM_ID}\",\"lineItems\":[{\"orderableId\":\"${OID}\",\"lotId\":\"${LOT}\",\"quantity\":${SOH},\"occurredDate\":\"${TODAY}\",\"reasonId\":\"${CONSUME_REASON}\",\"documentationNo\":\"DEMO-ZERO-${OID:(-4)}\"}]}")
    echo "  Response: $RESP"
  fi
done

# ─── Step 6: Create Amoxicillin 250mg Group in HAPI FHIR ───────────────────
log "Step 6: Creating Amoxicillin 250mg Group in HAPI FHIR ..."
AMOX_GROUP_RESP=$(curl -s -X POST "http://localhost:8079/fhir/Group" \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType": "Group",
    "active": true,
    "type": "device",
    "actual": false,
    "code": {
      "coding": [{"system": "http://snomed.info/sct", "code": "386452003", "display": "Supply management"}]
    },
    "name": "Amoxicillin 250mg",
    "identifier": [{"use": "official", "value": "AMOX250"}],
    "characteristic": [{
      "code": {
        "coding": [{"system": "http://snomed.info/sct", "code": "767524001", "display": "Unit of measure"}]
      },
      "valueCodeableConcept": {
        "coding": [{"system": "http://snomed.info/sct", "code": "767525000", "display": "Unit"}],
        "text": "Tablets"
      },
      "exclude": false
    }]
  }')
AMOX_GROUP_ID=$(echo "$AMOX_GROUP_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
log "  Amoxicillin Group ID: $AMOX_GROUP_ID"

# ─── Step 7: Update FHIR supply list to only Albendazole + Amoxicillin ─────
log "Step 7: Updating FHIR supply list ..."
if [ -z "$AMOX_GROUP_ID" ]; then
  warn "Could not get Amoxicillin Group ID — supply list not updated"
else
  # Get current list version
  LIST_RESP=$(curl -s "http://localhost:8079/fhir/List/${SUPPLY_LIST_ID}" -H "Accept: application/fhir+json")
  LIST_VERSION=$(echo "$LIST_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('meta',{}).get('versionId','1'))")

  curl -s -X PUT "http://localhost:8079/fhir/List/${SUPPLY_LIST_ID}" \
    -H "Content-Type: application/fhir+json" \
    -H "If-Match: W/\"${LIST_VERSION}\"" \
    -d "{
      \"resourceType\": \"List\",
      \"id\": \"${SUPPLY_LIST_ID}\",
      \"status\": \"current\",
      \"mode\": \"working\",
      \"title\": \"BKM Supply Chain Commodities (Demo)\",
      \"code\": {\"coding\": [{\"system\": \"http://snomed.info/sct\", \"code\": \"386452003\"}]},
      \"entry\": [
        {\"item\": {\"reference\": \"Group/${ALBEND_GROUP_ID}\"}},
        {\"item\": {\"reference\": \"Group/${AMOX_GROUP_ID}\"}}
      ]
    }" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  List updated:', d.get('id','?'), 'v'+d.get('meta',{}).get('versionId','?'))"
fi

# ─── Step 8: Rebuild mediator with new mappings ─────────────────────────────
log "Step 8: Restarting mediator to reload mappings ..."
docker restart bkm-mediator
sleep 5
docker logs bkm-mediator --tail 10
log "  Mediator restarted."

# ─── Done ───────────────────────────────────────────────────────────────────
log ""
log "Demo setup complete."
log "  Albendazole:     UUID=${ALBEND_ID}  SOH=1000"
log "  Amoxicillin:     UUID=${AMOX_ID}  SOH=1000"
log "  FHIR supply list: trimmed to 2 medicines"
log "  Mediator mappings: demo version active"
log ""
log "To restore original mappings: cp mediator/mappings.json.bak mediator/mappings.json && docker restart bkm-mediator"
