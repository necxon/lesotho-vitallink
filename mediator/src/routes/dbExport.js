/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const express = require('express');
const { Pool } = require('pg');
const { pool }  = require('../db');
const logger    = require('../logger');

const router = express.Router();

const opensrpPool = new Pool({
  host:     process.env.DB_HOST || 'db-postgres',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: 'opensrp',
  user:     process.env.DB_USER || 'admin',
  password: process.env.DB_PASS || 'password123',
});
opensrpPool.on('error', (err) => logger.error({ event: 'opensrp-pool-error', error: err.message }));

function sqlLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function rowsToInserts(table, rows) {
  if (!rows.length) return `-- (no rows)\n`;
  const cols = Object.keys(rows[0]);
  return rows.map(row =>
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => sqlLiteral(row[c])).join(', ')}) ON CONFLICT DO NOTHING;`
  ).join('\n') + '\n';
}

router.get('/', async (_req, res) => {
  try {
    const [orderBuffer, dispatchHistory, sohTracker, practitioners] = await Promise.all([
      pool.query('SELECT * FROM order_buffer ORDER BY period, orderable, org_unit').then(r => r.rows),
      pool.query('SELECT * FROM dispatch_history ORDER BY dispatched_at').then(r => r.rows),
      pool.query('SELECT * FROM soh_tracker ORDER BY orderable_id').then(r => r.rows),
      opensrpPool.query(
        'SELECT identifier, active, name, user_id, username FROM team.practitioner ORDER BY username'
      ).then(r => r.rows).catch(() => []),
    ]);

    const ts = new Date().toISOString();
    const totalRows = orderBuffer.length + dispatchHistory.length + sohTracker.length + practitioners.length;

    const sql = [
      `-- ============================================================`,
      `-- BKM Lesotho Sandbox — PostgreSQL dump`,
      `-- Generated: ${ts}`,
      `-- Rows: ${totalRows}`,
      `-- Restore: psql -U admin -d <database> -f this_file.sql`,
      `-- ============================================================`,
      ``,
      `-- ============================================================`,
      `-- DATABASE: mediator  (order buffer, dispatch history, SOH)`,
      `-- ============================================================`,
      ``,
      `CREATE DATABASE IF NOT EXISTS mediator;`,
      `\\connect mediator`,
      ``,
      `CREATE TABLE IF NOT EXISTS order_buffer (`,
      `  period    CHAR(6)  NOT NULL,`,
      `  orderable TEXT     NOT NULL,`,
      `  org_unit  TEXT     NOT NULL,`,
      `  qty       INTEGER  NOT NULL DEFAULT 0,`,
      `  origin    TEXT,`,
      `  PRIMARY KEY (period, orderable, org_unit)`,
      `);`,
      ``,
      `CREATE TABLE IF NOT EXISTS dispatch_history (`,
      `  id            SERIAL      PRIMARY KEY,`,
      `  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),`,
      `  period        CHAR(6)     NOT NULL,`,
      `  orderable_id  TEXT        NOT NULL,`,
      `  org_unit      TEXT        NOT NULL,`,
      `  qty           INTEGER     NOT NULL,`,
      `  lmis_status   TEXT,`,
      `  forced        BOOLEAN     NOT NULL DEFAULT FALSE,`,
      `  performer_ids TEXT`,
      `);`,
      ``,
      `CREATE TABLE IF NOT EXISTS soh_tracker (`,
      `  orderable_id TEXT        NOT NULL PRIMARY KEY,`,
      `  soh          INTEGER     NOT NULL,`,
      `  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `);`,
      ``,
      `-- order_buffer (${orderBuffer.length} rows)`,
      rowsToInserts('order_buffer', orderBuffer),
      `-- dispatch_history (${dispatchHistory.length} rows)`,
      rowsToInserts('dispatch_history', dispatchHistory),
      `-- soh_tracker (${sohTracker.length} rows)`,
      rowsToInserts('soh_tracker', sohTracker),
      ``,
      `-- ============================================================`,
      `-- DATABASE: opensrp  (practitioners)`,
      `-- ============================================================`,
      ``,
      `\\connect opensrp`,
      ``,
      `CREATE SCHEMA IF NOT EXISTS team;`,
      ``,
      `CREATE TABLE IF NOT EXISTS team.practitioner (`,
      `  identifier TEXT    NOT NULL,`,
      `  active     BOOLEAN NOT NULL DEFAULT TRUE,`,
      `  name       TEXT,`,
      `  user_id    TEXT,`,
      `  username   TEXT`,
      `);`,
      ``,
      `-- team.practitioner (${practitioners.length} rows)`,
      rowsToInserts('team.practitioner', practitioners),
      ``,
      `-- ============================================================`,
      `-- End of dump`,
      `-- ============================================================`,
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(sql);
  } catch (err) {
    logger.error({ event: 'db-export-error', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
