/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

// Direct connection to the OpenLMIS reference-data Postgres (database `open_lmis`).
// OpenLMIS exposes no API to delete a stock-card line item, so the portal's
// "delete transaction" action (hard-delete + SOH recalc) goes straight to the DB.
// The mediator is attached to the OpenLMIS network (lmis-net), so the `db` service
// alias resolves. Lazily created so the pool is only opened when first used.

const { Pool } = require('pg');
const logger   = require('../logger');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    host:     process.env.OPENLMIS_DB_HOST || 'db',
    port:     parseInt(process.env.OPENLMIS_DB_PORT || '5432', 10),
    database: process.env.OPENLMIS_DB_NAME || 'open_lmis',
    user:     process.env.OPENLMIS_DB_USER || 'postgres',
    password: process.env.OPENLMIS_DB_PASS || 'p@ssw0rd',
    max:      3,
  });
  _pool.on('error', (e) => logger.error({ event: 'openlmis-db-pool-error', error: e.message }));
  return _pool;
}

// NOTE: "has the facility accepted a real delivery?" is NOT answered here. OpenLMIS
// does not persist documentationNo to stock_card_line_items, so seeded stock and real
// receipts are indistinguishable in this DB (both have NULL documentnumber). Delivery
// tracking lives in the mediator's own DB instead — see db.js facilityHasDelivery /
// recordFacilityDelivery, written from pushToOpenLMIS on each receipt.

module.exports = { getPool };
