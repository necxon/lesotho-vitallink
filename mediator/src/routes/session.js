/*
 * NEC XON (c) Copyright 2025.
 *
 * Single-seat session lock for the bkm-web portal.
 * Only ONE user may hold the portal at a time. The SPA acquires the seat on
 * login, heartbeats to hold it, and releases on logout. If the holder stops
 * heartbeating (closed tab / crash) the seat frees after STALE_MS.
 *
 * This is an advisory lock (not a security control) — the browser already
 * authenticated via Keycloak before reaching here.
 */
'use strict';

const express = require('express');
const router  = express.Router();
const logger  = require('../logger');

const STALE_MS = parseInt(process.env.SESSION_STALE_MS || '90000', 10); // 90s

// Config option: when disabled, the one-user-at-a-time lock is bypassed and
// every login is allowed concurrently. Defaults to enabled (single-seat on).
// Set SESSION_SINGLE_SEAT to 0/false/off/no to allow multiple users at once.
const SINGLE_SEAT = !/^(0|false|off|no)$/i.test(process.env.SESSION_SINGLE_SEAT || 'true');
logger.info(`session: single-seat lock ${SINGLE_SEAT ? 'ENABLED (one user at a time)' : 'DISABLED (concurrent users allowed)'}`);

// Secret passphrase for the "force disconnect" link. Override in docker-compose.
// The link is: <portal-url>/?unlock=<SESSION_FORCE_KEY>
const FORCE_KEY = process.env.SESSION_FORCE_KEY || 'bkm-kick-2025';

// The single active seat: { username, sessionId, lastSeen } or null
let seat = null;

function usernameFromAuth(req) {
  // Decode the JWT payload (no verification — behind authenticated proxy already)
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64').toString('utf8'));
    return payload.preferred_username || payload.sub || null;
  } catch (_) {
    return null;
  }
}

function seatIsStale() {
  return seat && (Date.now() - seat.lastSeen > STALE_MS);
}

// POST /session/acquire { sessionId }  → 200 {held:true} or 409 {activeUser}
router.post('/acquire', (req, res) => {
  const username  = usernameFromAuth(req) || 'unknown';
  const sessionId = (req.body && req.body.sessionId) || '';
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  // Lock disabled → everyone gets a seat, no contention.
  if (!SINGLE_SEAT) return res.json({ held: true, username, singleSeat: false });

  if (!seat || seatIsStale() || seat.sessionId === sessionId) {
    const takenOver = seat && seat.sessionId !== sessionId;
    seat = { username, sessionId, lastSeen: Date.now() };
    if (takenOver) logger.info(`session: seat taken over by ${username} (previous holder stale/replaced)`);
    return res.json({ held: true, username });
  }
  // Someone else holds a live seat
  return res.status(409).json({ held: false, activeUser: seat.username });
});

// POST /session/heartbeat { sessionId } → 200 or 409 (lost the seat)
router.post('/heartbeat', (req, res) => {
  const sessionId = (req.body && req.body.sessionId) || '';
  if (!SINGLE_SEAT) return res.json({ held: true, singleSeat: false });
  if (seat && seat.sessionId === sessionId) {
    seat.lastSeen = Date.now();
    return res.json({ held: true });
  }
  return res.status(409).json({ held: false, activeUser: seat ? seat.username : null });
});

// POST /session/release { sessionId } → 200
router.post('/release', (req, res) => {
  const sessionId = (req.body && req.body.sessionId) || '';
  if (seat && seat.sessionId === sessionId) {
    logger.info(`session: seat released by ${seat.username}`);
    seat = null;
  }
  return res.json({ released: true });
});

// POST /session/force-release { key } → 200 — admin "kick" / force disconnect.
// Clears whoever holds the seat so a locked-out user can take over. Guarded by a
// secret passphrase (SESSION_FORCE_KEY) so it can't be triggered casually.
router.post('/force-release', (req, res) => {
  const key = (req.body && req.body.key) || req.query.key || '';
  if (key !== FORCE_KEY) {
    logger.warn('session: force-release rejected (bad key)');
    return res.status(403).json({ error: 'forbidden' });
  }
  const prev = seat ? seat.username : null;
  seat = null;
  logger.warn(`session: seat FORCE-RELEASED by unlock link${prev ? ` (was held by ${prev})` : ' (was empty)'}`);
  return res.json({ released: true, previousUser: prev });
});

// GET /session/status → who holds it (for debugging)
router.get('/status', (_req, res) => {
  if (!SINGLE_SEAT) return res.json({ held: false, singleSeat: false });
  if (!seat || seatIsStale()) return res.json({ held: false, singleSeat: true });
  res.json({ held: true, singleSeat: true, username: seat.username, ageMs: Date.now() - seat.lastSeen });
});

module.exports = router;
