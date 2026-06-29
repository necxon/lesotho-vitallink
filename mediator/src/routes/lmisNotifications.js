/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

/**
 * OpenLMIS in-app system notifications store.
 *
 * The OpenLMIS reference-UI bell icon reads GET /api/systemNotifications and
 * dismisses via PATCH /api/systemNotifications/:id.  The OpenLMIS nginx stub
 * in seed.sh is patched to proxy those calls here so the bell shows real events.
 *
 * The mediator posts notifications here (fire-and-forget) on:
 *   - Stock dispense / receipt (fanout.js)
 *   - Low-stock threshold breach (fanout.js)
 *   - Order batch dispatched to OpenLMIS (orderBuffer.js)
 */

const { Router } = require('express');
const crypto     = require('crypto');
const logger     = require('../logger');

const router = Router();
const store  = [];   // in-memory, newest first, capped at 100

function makeNotif(title, message) {
  return {
    id:          crypto.randomUUID(),
    title,
    message,
    // OpenLMIS SPA queries ?isDisplayed=true and renders author.firstName/lastName
    isDisplayed: true,
    active:      true,
    author: { id: null, firstName: 'BKM', lastName: 'Mediator' },
    createdDate: new Date().toISOString(),
  };
}

/**
 * Create and push a new system notification.
 * Called internally — fire-and-forget, never throws.
 */
function postLmisNotification(title, message) {
  try {
    const n = makeNotif(String(title), String(message));
    store.unshift(n);
    if (store.length > 100) store.length = 100;
    logger.info({ event: 'lmis-notification-posted', title });
    return n;
  } catch (e) {
    return null;
  }
}

// GET /lmis-notifications
// OpenLMIS SPA sends ?isDisplayed=true&expand=author&page=0&size=10
router.get('/', (req, res) => {
  const onlyActive = req.query.isDisplayed === 'true' || req.query.active === 'true';
  const page       = Math.max(0, parseInt(req.query.page || '0', 10));
  const size       = Math.max(1, parseInt(req.query.size || '10', 10));
  const filtered   = onlyActive ? store.filter(n => n.isDisplayed) : store;
  const start      = page * size;
  const slice      = filtered.slice(start, start + size);
  res.json({
    content:          slice,
    totalElements:    filtered.length,
    totalPages:       Math.max(1, Math.ceil(filtered.length / size)),
    last:             start + size >= filtered.length,
    first:            page === 0,
    number:           page,
    numberOfElements: slice.length,
    size,
  });
});

// POST /lmis-notifications — create (also callable from bkm-web or curl)
router.post('/', (req, res) => {
  const { title = 'Notification', message = '' } = req.body || {};
  res.status(201).json(postLmisNotification(title, message));
});

// PATCH /lmis-notifications/:id — dismiss (OpenLMIS SPA sends {isDisplayed:false})
router.patch('/:id', (req, res) => {
  const n = store.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ message: 'Not found' });
  if (req.body) {
    if (req.body.isDisplayed !== undefined) n.isDisplayed = req.body.isDisplayed;
    if (req.body.active !== undefined)      n.active      = req.body.active;
    // Keep the two flags in sync — either one dismisses
    if (n.isDisplayed === false || n.active === false) {
      n.isDisplayed = false;
      n.active      = false;
    }
  }
  res.json(n);
});

// DELETE /lmis-notifications — clear all (used by test runner)
router.delete('/', (req, res) => {
  store.length = 0;
  res.status(204).end();
});

module.exports = { router, postLmisNotification };
