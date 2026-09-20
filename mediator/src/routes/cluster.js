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

const OPENSRP_NODES = (process.env.CLUSTER_OPENSRP_NODES ||
  'opensrp-server:http://opensrp-server:8080/opensrp/,opensrp-server-2:http://opensrp-server-2:8080/opensrp/')
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

async function probeHttp(node) {
  const started = Date.now();
  try {
    const r = await axios.get(node.url, { timeout: 6000 });
    return { name: node.name, up: r.status === 200, status: r.status, responseMs: Date.now() - started };
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
  const [fhir, opensrp, primary, standby] = await Promise.all([
    Promise.all(FHIR_NODES.map(probeFhir)),
    Promise.all(OPENSRP_NODES.map(probeHttp)),
    primaryState(),
    standbyState(),
  ]);

  const fhirUp = fhir.filter((n) => n.up).length;
  const opensrpUp = opensrp.filter((n) => n.up).length;

  // "down" is reserved for losing a whole tier or the primary database.
  // Losing one node of a pair is "degraded": still serving, but the next
  // failure is an outage.
  let health = 'healthy';
  if (fhirUp === 0 || !primary.up) health = 'down';
  else if (fhirUp < fhir.length || opensrpUp < opensrp.length ||
           !standby.up || standby.role !== 'standby') health = 'degraded';

  res.json({
    health,
    checkedAt: new Date().toISOString(),
    fhir: { total: fhir.length, up: fhirUp, nodes: fhir },
    opensrp: { total: opensrp.length, up: opensrpUp, nodes: opensrp },
    database: { primary, standby },
  });
});

/*
 * POST /cluster/promote-standby — turn the replica into a primary.
 *
 * Guarded deliberately hard. Promotion is not undoable: the moment the standby
 * leaves recovery it stops following the primary, and if the primary is still
 * alive both sides accept writes and diverge. That is split brain, and it is
 * worse than the outage it was meant to solve.
 *
 * So the dangerous case is not offered at all. If the mediator can still reach
 * the primary, this endpoint refuses, whatever the caller says. A confirmation
 * dialog only asks a human to be careful, and during an incident people click
 * through; a server-side check does not. Promoting while the primary is up
 * stays a deliberate manual act with the documented pg_ctl command, which is
 * exactly the friction it deserves.
 */
router.post('/promote-standby', async (req, res) => {
  const body = req.body || {};

  if (body.confirm !== 'PROMOTE') {
    return res.status(400).json({
      ok: false,
      error: 'confirmation required',
      detail: 'Send {"confirm":"PROMOTE"} to proceed.',
    });
  }

  // 1. The primary must be genuinely unreachable, not merely slow.
  const primary = await primaryState();
  if (primary.up) {
    logger.warn('cluster: promote refused - the primary is still reachable');
    return res.status(409).json({
      ok: false,
      error: 'primary is still serving',
      detail: 'Promoting now would leave two writable databases diverging. ' +
              'If the primary really must be abandoned, do it deliberately: ' +
              'docker exec health-db-standby pg_ctl promote -D /var/lib/postgresql/data',
    });
  }

  // 2. And the standby must still be a standby.
  const standby = await standbyState();
  if (!standby.up) {
    return res.status(503).json({ ok: false, error: 'standby is unreachable', detail: standby.error });
  }
  if (standby.role !== 'standby') {
    return res.status(409).json({
      ok: false,
      error: 'already promoted',
      detail: 'This server has already left recovery. Rebuild a replica instead.',
    });
  }

  try {
    logger.warn('cluster: PROMOTING the standby - the primary is unreachable');
    // wait=true so the call returns once the server has actually left recovery,
    // rather than reporting success on a promotion still in progress.
    await poolFor(STANDBY_HOST).query('SELECT pg_promote(true, 60)');
    const after = await standbyState();
    logger.warn(`cluster: promotion finished, role is now ${after.role}`);
    return res.json({
      ok: true,
      role: after.role,
      note: 'Promoted. Services still point at the old primary - repoint them ' +
            '(db-postgres -> db-postgres-standby) and restart. You are now running ' +
            'without a replica: rebuild one. See docs/high-availability.md.',
    });
  } catch (e) {
    logger.error(`cluster: promotion failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: 'promotion failed', detail: e.message });
  }
});

module.exports = router;
