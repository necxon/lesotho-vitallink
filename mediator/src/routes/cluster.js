/*
 * NEC XON (c) Copyright 2025.
 *
 * GET /cluster/status — health of the redundant FHIR backends and the database
 * replica, for the Administrator Portal's Backends page.
 *
 * Each FHIR node is probed BY NAME rather than through fhir-proxy, so the answer
 * is that node's own state and not whichever node the load balancer happened to
 * pick. Replication is read from both ends: pg_stat_replication on the primary
 * says what it is shipping, and the standby says what it has actually replayed.
 * A standby can look connected on the primary while lagging badly, so the pair
 * matters.
 */
'use strict';

const { Router } = require('express');
const axios      = require('axios');
const { Pool }   = require('pg');
const logger     = require('../logger');

const router = Router();

const FHIR_NODES = (process.env.CLUSTER_FHIR_NODES ||
  'hapi-fhir:http://hapi-fhir:8080/fhir,hapi-fhir-2:http://hapi-fhir-2:8080/fhir')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const idx = entry.indexOf(':');
    return { name: entry.slice(0, idx), url: entry.slice(idx + 1) };
  });

const PG_USER = process.env.DB_USER || 'admin';
const PG_PASS = process.env.DB_PASS || 'password123';
const PRIMARY_HOST = process.env.DB_HOST || 'db-postgres';
const STANDBY_HOST = process.env.STANDBY_DB_HOST || 'db-postgres-standby';

const pools = {};
function poolFor(host) {
  if (!pools[host]) {
    pools[host] = new Pool({
      host,
      port: 5432,
      database: 'postgres',
      user: PG_USER,
      password: PG_PASS,
      connectionTimeoutMillis: 4000,
      max: 2,
    });
    pools[host].on('error', (err) =>
      logger.warn(`cluster: pg pool error on ${host}: ${err.message}`));
  }
  return pools[host];
}

async function probeFhir(node) {
  const started = Date.now();
  try {
    // _summary=true keeps the CapabilityStatement small; it still exercises the
    // full stack down to the database.
    const r = await axios.get(`${node.url}/metadata?_summary=true`, { timeout: 6000 });
    return {
      name: node.name,
      up: r.status === 200,
      status: r.status,
      responseMs: Date.now() - started,
      software: r.data && r.data.software ? r.data.software.version : null,
    };
  } catch (e) {
    return {
      name: node.name,
      up: false,
      status: e.response ? e.response.status : null,
      responseMs: Date.now() - started,
      error: e.code || e.message,
    };
  }
}

async function primaryState() {
  try {
    const q = await poolFor(PRIMARY_HOST).query(`
      SELECT pg_is_in_recovery() AS in_recovery,
             (SELECT count(*) FROM pg_stat_replication) AS replicas,
             (SELECT json_agg(json_build_object(
                'client', client_addr::text,
                'state', state,
                'sync_state', sync_state,
                'write_lag_bytes', pg_wal_lsn_diff(sent_lsn, write_lsn),
                'replay_lag_bytes', pg_wal_lsn_diff(sent_lsn, replay_lsn)))
              FROM pg_stat_replication) AS detail`);
    const row = q.rows[0];
    return {
      up: true,
      role: row.in_recovery ? 'standby' : 'primary',
      replicas: Number(row.replicas),
      detail: row.detail || [],
    };
  } catch (e) {
    return { up: false, error: e.message };
  }
}

async function standbyState() {
  try {
    const q = await poolFor(STANDBY_HOST).query(`
      SELECT pg_is_in_recovery() AS in_recovery,
             pg_last_wal_receive_lsn()::text AS receive_lsn,
             pg_last_wal_replay_lsn()::text  AS replay_lsn,
             EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds`);
    const row = q.rows[0];
    const caughtUp = row.receive_lsn === row.replay_lsn;
    // pg_last_xact_replay_timestamp() is the clock time of the last transaction
    // REPLAYED, so on an idle primary it just keeps ageing: a perfectly healthy
    // standby reports minutes of "lag" simply because nothing has been written.
    // Real lag means WAL received but not yet replayed, so only report a time
    // figure when the LSNs actually differ.
    return {
      up: true,
      role: row.in_recovery ? 'standby' : 'PROMOTED (no longer replicating)',
      receiveLsn: row.receive_lsn,
      replayLsn: row.replay_lsn,
      lagSeconds: caughtUp || row.lag_seconds === null
        ? 0
        : Math.max(0, Math.round(row.lag_seconds)),
      caughtUp,
    };
  } catch (e) {
    return { up: false, error: e.message };
  }
}

router.get('/status', async (req, res) => {
  const [fhir, primary, standby] = await Promise.all([
    Promise.all(FHIR_NODES.map(probeFhir)),
    primaryState(),
    standbyState(),
  ]);

  const fhirUp = fhir.filter((n) => n.up).length;
  let health = 'healthy';
  if (fhirUp === 0 || !primary.up) health = 'down';
  else if (fhirUp < fhir.length || !standby.up || standby.role !== 'standby') health = 'degraded';

  res.json({
    health,
    checkedAt: new Date().toISOString(),
    fhir: { total: fhir.length, up: fhirUp, nodes: fhir },
    database: { primary, standby },
  });
});

module.exports = router;
