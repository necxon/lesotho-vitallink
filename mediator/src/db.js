/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const { Pool } = require('pg');
const logger   = require('./logger');

const pool = new Pool({
  host:     process.env.DB_HOST || 'db-postgres',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'mediator',
  user:     process.env.DB_USER || 'admin',
  password: process.env.DB_PASS || 'password123',
});

pool.on('error', (err) => logger.error({ event: 'pg-pool-error', error: err.message }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_buffer (
      period    CHAR(6)  NOT NULL,
      orderable TEXT     NOT NULL,
      org_unit  TEXT     NOT NULL,
      qty       INTEGER  NOT NULL DEFAULT 0,
      PRIMARY KEY (period, orderable, org_unit)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_history (
      id            SERIAL      PRIMARY KEY,
      dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period        CHAR(6)     NOT NULL,
      orderable_id  TEXT        NOT NULL,
      org_unit      TEXT        NOT NULL,
      qty           INTEGER     NOT NULL,
      lmis_status   TEXT,
      forced        BOOLEAN     NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soh_tracker (
      orderable_id TEXT    NOT NULL PRIMARY KEY,
      soh          INTEGER NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrate lmis_status from INTEGER → TEXT (idempotent; fails silently if already TEXT)
  await pool.query(`ALTER TABLE dispatch_history ALTER COLUMN lmis_status TYPE TEXT USING lmis_status::TEXT`)
    .catch(() => {});
  // Add performer_ids column (idempotent — IF NOT EXISTS supported in PG 9.6+)
  await pool.query(`ALTER TABLE dispatch_history ADD COLUMN IF NOT EXISTS performer_ids TEXT`)
    .catch(() => {});
  // Add origin column — tracks which performer last contributed to each buffer row
  await pool.query(`ALTER TABLE order_buffer ADD COLUMN IF NOT EXISTS origin TEXT`)
    .catch(() => {});
  // Dispatch log — one row per dispatched period; prevents double-dispatch after a
  // mediator restart (replaces the flat JSON file on the mounted volume). TODO #5.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_log (
      period        TEXT        PRIMARY KEY,
      dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Idempotency cache — resourceId → first-accept time; prevents duplicate dispense
  // fan-out across a mediator restart (replaces the in-memory Map). TODO #6.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_cache (
      resource_id TEXT        PRIMARY KEY,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_idempotency_accepted_at ON idempotency_cache (accepted_at)`)
    .catch(() => {});
  // Per-VHW stock allocation — a facility worker assigns a per-period budget of a
  // medicine to a specific VHW. Dispenses deduct from dispensed_qty (see allocationStore).
  // OpenLMIS stock stays facility-level; this is the per-VHW split on top of it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vhw_allocations (
      id            SERIAL       PRIMARY KEY,
      period        CHAR(6)      NOT NULL,
      facility_id   TEXT         NOT NULL,
      practitioner  TEXT         NOT NULL,
      medication    TEXT         NOT NULL,
      allocated_qty INTEGER      NOT NULL,
      dispensed_qty INTEGER      NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (period, practitioner, medication)
    )
  `);
  // Optional batch/lot code recorded on an allocation (traceability — which batch a
  // VHW was allocated from). Informational only; dispensing still debits per OpenLMIS.
  await pool.query(`ALTER TABLE vhw_allocations ADD COLUMN IF NOT EXISTS lot_code TEXT`);
  // Facility deliveries — one row each time the mediator records a RECEIPT (a real
  // accepted delivery) for a facility. Seeded opening stock is posted straight to
  // OpenLMIS and never passes through the mediator, so it is correctly NOT recorded
  // here. Used to gate allocation (require an accepted delivery first).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facility_deliveries (
      id          SERIAL      PRIMARY KEY,
      facility_id TEXT        NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_facility_deliveries_fac ON facility_deliveries (facility_id)`)
    .catch(() => {});
  logger.info({ event: 'db-init', message: 'order_buffer + dispatch_history + soh_tracker + dispatch_log + idempotency_cache + vhw_allocations + facility_deliveries tables ready' });
}

// Records that a facility accepted a delivery (called on every successful receipt).
async function recordFacilityDelivery(facilityId) {
  if (!facilityId) return;
  await pool.query('INSERT INTO facility_deliveries (facility_id) VALUES ($1)', [facilityId]);
}

// True if the facility has at least one recorded (mediator-processed) delivery.
async function facilityHasDelivery(facilityId) {
  if (!facilityId) return false;
  const r = await pool.query('SELECT 1 FROM facility_deliveries WHERE facility_id = $1 LIMIT 1', [facilityId]);
  return r.rowCount > 0;
}

module.exports = { pool, initDb, recordFacilityDelivery, facilityHasDelivery };
