/*
 * NEC XON (c) Copyright 2025.
 *
 * Dispense reconciliation.
 *
 * The BKM app is offline-first: it records a dispense and optimistically reduces its
 * local stock count BEFORE the mediator has validated it. When the mediator rejects
 * a dispense (insufficient allocation / facility stock), the app's local count drifts
 * (e.g. shows -4) even though the authoritative stock never moved.
 *
 * To self-heal: delete the rejected resource from HAPI so the app drops it on the next
 * sync and recomputes its count without it. Best-effort — never throws.
 */
'use strict';

const axios = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');

const HAPI = CONFIG.fhir.url;

async function voidRejectedDispense(resource, reason) {
  const type = resource && resource.resourceType;
  const id   = resource && resource.id;
  if (!type || !id) return false;   // nothing to delete (e.g. direct POST without an id)
  try {
    await axios.delete(`${HAPI}/${type}/${id}`, { timeout: TIMEOUT_MS });
    logger.info(`reconcile: voided rejected ${type}/${id} (${reason}) so the app drops it on next sync`);
    return true;
  } catch (e) {
    logger.warn(`reconcile: failed to void ${type}/${id} (${reason}): ${e.message}`);
    return false;
  }
}

module.exports = { voidRejectedDispense };
