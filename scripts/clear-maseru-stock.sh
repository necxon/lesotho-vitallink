#!/usr/bin/env bash
# clear-maseru-stock.sh
# Wipes all stock cards and events for Maseru District Clinic A in OpenLMIS.
# Also clears the order dispatch log so the current period can be re-dispatched.
# Run: bash scripts/clear-maseru-stock.sh

set -euo pipefail

FACILITY_ID="28de536f-b826-4eeb-a3c4-d65221a1120d"
DB_CONTAINER="openlmis-ref-distro-db-1"

echo "Clearing OpenLMIS stock data for Maseru District Clinic A..."

docker exec "$DB_CONTAINER" bash -c "psql -U postgres -d open_lmis -v ON_ERROR_STOP=1 <<'ENDSQL'
CREATE TEMP TABLE del_cards  AS SELECT id FROM stockmanagement.stock_cards  WHERE facilityid = '${FACILITY_ID}';
CREATE TEMP TABLE del_events AS SELECT id FROM stockmanagement.stock_events WHERE facilityid = '${FACILITY_ID}';
CREATE TEMP TABLE del_lines  AS SELECT id FROM stockmanagement.stock_card_line_items WHERE stockcardid IN (SELECT id FROM del_cards);

DELETE FROM stockmanagement.physical_inventory_line_item_adjustments WHERE stockcardlineitemid IN (SELECT id FROM del_lines);
DELETE FROM stockmanagement.calculated_stocks_on_hand   WHERE stockcardid  IN (SELECT id FROM del_cards);
DELETE FROM stockmanagement.stock_card_line_items        WHERE stockcardid  IN (SELECT id FROM del_cards);
DELETE FROM stockmanagement.stock_cards                  WHERE id           IN (SELECT id FROM del_cards);
DELETE FROM stockmanagement.physical_inventories         WHERE stockeventid IN (SELECT id FROM del_events);
DELETE FROM stockmanagement.stock_event_line_items       WHERE stockeventid IN (SELECT id FROM del_events);
DELETE FROM stockmanagement.stock_events                 WHERE id           IN (SELECT id FROM del_events);
ENDSQL"

echo "  Stock cards and events cleared."

# Clear the order dispatch log so the current period can be re-dispatched
docker exec bkm-mediator rm -f /data/dispatched-orders.json 2>/dev/null && \
  echo "  Order dispatch log cleared." || \
  echo "  (No dispatch log to clear.)"

# Zero out DHIS2 order data values for all org units so bkm-web shows 0 pending orders
docker exec bkm-mediator node -e "
const http   = require('http');
const auth   = 'Basic ' + Buffer.from('admin:district').toString('base64');
const ous    = ['dwx1Yz4BwNX','VilHaMokoe1','VilHaSehl01','VilMatsien1'];
const des    = ['DEOrdAL0001','DEOrdAmx001','DEOrdRdt001','DEOrdPar001',
                'DEOrdCtx001','DEOrdOrs001','DEOrdZnc001','DEOrdIfa001'];
const period = new Date().toISOString().slice(0,7).replace('-','');
const vals   = [];
ous.forEach(ou => des.forEach(de => vals.push({dataElement:de,orgUnit:ou,period,value:'0'})));
const body   = JSON.stringify({dataValues:vals});
const req    = http.request(
  {host:'dhis2-web',port:8080,path:'/api/dataValueSets',method:'POST',
   headers:{'Content-Type':'application/json','Authorization':auth,'Content-Length':Buffer.byteLength(body)}},
  res => process.exit(res.statusCode === 200 ? 0 : 1)
);
req.write(body); req.end();
" 2>/dev/null && \
  echo "  DHIS2 order quantities reset to zero." || \
  echo "  (Could not reset DHIS2 order quantities.)"

# Clear all OpenLMIS bell notifications
docker exec bkm-mediator node -e "
require('http').request({host:'localhost',port:3000,path:'/lmis-notifications',method:'DELETE'}, r => {
  process.exit(r.statusCode === 204 ? 0 : 1);
}).on('error', () => process.exit(1)).end();
" 2>/dev/null && \
  echo "  Bell notifications cleared." || \
  echo "  (Could not clear notifications.)"

echo "Done. Maseru District Clinic A stock and notifications are now empty."
