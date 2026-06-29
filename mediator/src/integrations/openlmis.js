/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const axios  = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { withOpenLMISToken } = require('../tokens');

/**
 * Checks OpenLMIS stock-on-hand BEFORE fan-out.
 * Fail-open: network/auth errors always return ok=true so patient care
 * is never blocked by a monitoring outage.
 */
async function checkStock(identity, quantity) {
  try {
    return await withOpenLMISToken(async token => {
      const res = await axios.get(`${CONFIG.lmis.mgmtUrl}/api/stockCardSummaries`, {
        params:  { facility: identity.facilityId, program: identity.programId, orderable: identity.orderableId },
        headers: { Authorization: `Bearer ${token}` },
        timeout: TIMEOUT_MS
      });
      const content = res.data.content || [];
      if (content.length === 0) {
        logger.info('No stock card yet — first dispense will create it');
        return { ok: true };
      }
      const card = content.find(c => c.orderable?.id === identity.orderableId) || content[0];

      // Lot-aware: OpenLMIS tracks stock PER LOT and rejects a debit that has no stock
      // for the dispensed lot — even when the orderable-level total is positive. So
      // check the specific lot the dispense will use, giving a clean 422 here instead of
      // an opaque OpenLMIS 400 later. Falls back to orderable-level SOH if the API
      // doesn't return lot detail (canFulfillForMe) or no lot is resolved.
      let soh   = card.stockOnHand;
      const lotId = await resolveDispenseLotId(identity, token).catch(() => null);
      if (lotId) {
        // Per-lot SOH for the batch this dispense will debit. This OpenLMIS version
        // returns one summary per (orderable, lot) with a top-level `lot`; newer
        // versions nest lots under canFulfillForMe. Handle both; if neither exposes
        // lot detail, keep the orderable-level SOH (fail-open).
        const lotCard = content.find(c => c.orderable?.id === identity.orderableId && c.lot?.id === lotId);
        if (lotCard) {
          soh = lotCard.stockOnHand;
        } else if (Array.isArray(card.canFulfillForMe)) {
          const lotEntry = card.canFulfillForMe.find(e => e.lot && e.lot.id === lotId);
          soh = lotEntry ? lotEntry.stockOnHand : 0;
        }
      }

      logger.debug(`Stock check: orderable=${identity.orderableId} lot=${lotId || 'n/a'} SOH=${soh} requested=${quantity}`);
      if (soh >= quantity) return { ok: true, stockOnHand: soh };
      return { ok: false, stockOnHand: soh, requested: quantity, lotId: lotId || null };
    });
  } catch (err) {
    logger.warn(`Stock check failed (fail-open): ${err.message}`);
    return { ok: true };
  }
}

// Cache of auto-resolved lots, keyed by orderableId (value may be null when the
// product genuinely has no lot). Cleared on restart.
const _lotCache = {};

/**
 * Resolves the OpenLMIS lotId to use for a stockEvent line item.
 * Priority: explicit OPENLMIS_LOT_MAP entry → auto-resolved lot for the
 * orderable's trade item (so a newly-added product dispenses with zero env
 * edits) → global OPENLMIS_LOT_ID fallback.
 */
async function resolveLotId(orderableId, token) {
  let lotMap = {};
  try { lotMap = JSON.parse(process.env.OPENLMIS_LOT_MAP || '{}'); } catch (e) {/* ignore */}
  if (lotMap[orderableId]) return lotMap[orderableId];

  if (orderableId in _lotCache) return _lotCache[orderableId];

  try {
    const ord = await axios.get(`${CONFIG.lmis.refUrl}/api/orderables/${orderableId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    const tradeItemId = ord.data?.identifiers?.tradeItem;
    if (tradeItemId) {
      const lots = await axios.get(`${CONFIG.lmis.refUrl}/api/lots`,
        { params: { tradeItemId }, headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
      const list = lots.data?.content || lots.data || [];
      const lot = list.find(l => l.active) || list[0];
      if (lot) {
        logger.info(`OpenLMIS lot auto-resolved for orderable ${orderableId}: ${lot.id} (${lot.lotCode})`);
        _lotCache[orderableId] = lot.id;
        return lot.id;
      }
    }
    logger.debug(`OpenLMIS: no lot found for orderable ${orderableId} — using default lot`);
  } catch (err) {
    logger.warn(`OpenLMIS lot auto-resolve failed for ${orderableId} (using default): ${err.message}`);
    // Don't cache transient failures — let the next dispense retry.
    return process.env.OPENLMIS_LOT_ID || null;
  }

  _lotCache[orderableId] = process.env.OPENLMIS_LOT_ID || null;
  return _lotCache[orderableId];
}

// Resolve an OpenLMIS lotId from its human lot code for an orderable's trade item.
const _lotByCodeCache = {};
async function resolveLotIdByCode(orderableId, lotCode, token) {
  const key = `${orderableId}|${lotCode}`;
  if (key in _lotByCodeCache) return _lotByCodeCache[key];
  try {
    const ord = await axios.get(`${CONFIG.lmis.refUrl}/api/orderables/${orderableId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    const tradeItemId = ord.data?.identifiers?.tradeItem;
    if (tradeItemId) {
      const lots = await axios.get(`${CONFIG.lmis.refUrl}/api/lots`,
        { params: { tradeItemId }, headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
      const list = lots.data?.content || lots.data || [];
      const lot = list.find(l => l.lotCode === lotCode);
      if (lot) { _lotByCodeCache[key] = lot.id; return lot.id; }
    }
  } catch (err) {
    logger.warn(`resolveLotIdByCode failed (${orderableId}/${lotCode}): ${err.message}`);
    return null; // don't cache transient failures
  }
  _lotByCodeCache[key] = null;
  return null;
}

/**
 * The lot a dispense should use: the VHW's allocated batch (identity.allocationLotCode —
 * FEFO, option B) when set and resolvable, else the env-default/auto-resolved lot.
 */
async function resolveDispenseLotId(identity, token) {
  if (identity.allocationLotCode) {
    const id = await resolveLotIdByCode(identity.orderableId, identity.allocationLotCode, token);
    if (id) return id;
    logger.warn(`allocation lot "${identity.allocationLotCode}" not found for orderable ${identity.orderableId} — using default lot`);
  }
  return resolveLotId(identity.orderableId, token);
}

async function pushToOpenLMIS(resource, identity, isReceipt = false, overrideReasonId = null) {
  const quantity = resource.quantity?.value || 0;

  const reasonId = overrideReasonId
    || (isReceipt
      ? (process.env.OPENLMIS_RECEIPT_REASON_ID || '313f2f5f-0c22-4626-8c49-3554ef763de3')
      : (process.env.OPENLMIS_REASON_ID         || 'b5c27da7-bdda-4790-925a-9484c5dfb594'));

  const occurredDate = resource.whenHandedOver?.split('T')[0]
    || new Date().toISOString().split('T')[0];

  const lineItem = {
    orderableId:     identity.orderableId,
    quantity,
    occurredDate,
    reasonId,
    documentationNo: `BKM-${resource.id || Date.now()}`
  };

  const res = await withOpenLMISToken(async token => {
    const lotId = await resolveDispenseLotId(identity, token);
    if (lotId) lineItem.lotId = lotId;

    const body = {
      facilityId: identity.facilityId,
      programId:  identity.programId,
      lineItems:  [lineItem]
    };

    logger.debug(`OpenLMIS stockEvents POST: ${JSON.stringify(body)}`);
    const r = await axios.post(`${CONFIG.lmis.mgmtUrl}/api/stockEvents`, body,
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    logger.debug(`OpenLMIS stockEvents response: HTTP ${r.status}`);
    return r;
  });

  // Record a real accepted delivery so allocation can be gated on it. Seeded stock is
  // posted straight to OpenLMIS (not via this funnel), so it's correctly excluded.
  if (isReceipt && res && res.status >= 200 && res.status < 300) {
    const { recordFacilityDelivery } = require('../db');
    recordFacilityDelivery(identity.facilityId)
      .catch(e => logger.warn(`recordFacilityDelivery failed (non-fatal): ${e.message}`));
  }
  return res;
}

/**
 * Lists the OpenLMIS lots (batches) for an orderable's trade item, for the allocate
 * form's lot dropdown. Returns [{ id, lotCode, expirationDate, active }] in FEFO order
 * (earliest expiry first, so the soonest-to-expire batch is used first; lots with no
 * expiry sort last), or [] when the product has no trade item / no lots.
 */
async function listLots(orderableId) {
  return withOpenLMISToken(async token => {
    const ord = await axios.get(`${CONFIG.lmis.refUrl}/api/orderables/${orderableId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    const tradeItemId = ord.data?.identifiers?.tradeItem;
    if (!tradeItemId) return [];
    const lots = await axios.get(`${CONFIG.lmis.refUrl}/api/lots`,
      { params: { tradeItemId }, headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    const list = lots.data?.content || lots.data || [];
    return list
      .filter(l => l.active !== false)
      .map(l => ({ id: l.id, lotCode: l.lotCode, expirationDate: l.expirationDate, active: true }))
      // FEFO: earliest expiry first; lots with no expiry date sort last.
      .sort((a, b) => (a.expirationDate || '9999-12-31').localeCompare(b.expirationDate || '9999-12-31'));
  }).catch(err => {
    logger.warn(`OpenLMIS listLots failed for ${orderableId}: ${err.message}`);
    return [];
  });
}

module.exports = { checkStock, pushToOpenLMIS, listLots };
