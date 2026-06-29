/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const { Router } = require('express');
const axios      = require('axios');
const logger     = require('../logger');
const reply      = require('../reply');
const { getPool } = require('../integrations/openlmisDb');

const router    = Router();
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FHIR_ID_RE = /^[A-Za-z0-9.\-]{1,64}$/;

// DELETE /aggregate/stock-admin/line-item/:id
//
// Hard-deletes a single OpenLMIS stock-card line item and recomputes the running
// stock-on-hand for its stock card. There is no OpenLMIS API for this, so it is done
// directly against the open_lmis database in one transaction. IRREVERSIBLE.
//
// Recalc rule (sandbox events only): CREDIT adds, DEBIT subtracts, ordered by
// (occurredDate, processedDate, id). Physical-inventory line items (no reason) are
// not produced by the mediator and are treated as additions if ever present.
router.delete('/line-item/:id', async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    return reply(res, { status: 'error', message: 'invalid line item id' }, 400);
  }

  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    logger.error({ event: 'stock-delete-db-unavailable', error: err.message });
    return reply(res, { status: 'error', message: `OpenLMIS DB unavailable: ${err.message}` }, 502);
  }

  try {
    await client.query('BEGIN');

    const found = await client.query(
      'SELECT stockcardid FROM stockmanagement.stock_card_line_items WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply(res, { status: 'error', message: 'line item not found' }, 404);
    }
    const cardId = found.rows[0].stockcardid;

    // Remove child physical-inventory adjustments (FK), then the line item itself.
    await client.query(
      'DELETE FROM stockmanagement.physical_inventory_line_item_adjustments WHERE stockcardlineitemid = $1',
      [id]
    );
    await client.query(
      'DELETE FROM stockmanagement.stock_card_line_items WHERE id = $1',
      [id]
    );

    // Rebuild calculated_stocks_on_hand for the whole card from the remaining events.
    await client.query(
      'DELETE FROM stockmanagement.calculated_stocks_on_hand WHERE stockcardid = $1',
      [cardId]
    );
    await client.query(
      `INSERT INTO stockmanagement.calculated_stocks_on_hand
         (id, stockcardid, occurreddate, processeddate, stockonhand)
       SELECT gen_random_uuid(), stockcardid, occurreddate, processeddate,
              SUM(CASE WHEN reasontype = 'DEBIT' THEN -quantity ELSE quantity END)
                OVER (ORDER BY occurreddate, processeddate, id ROWS UNBOUNDED PRECEDING)
       FROM (
         SELECT li.id, li.stockcardid, li.occurreddate, li.processeddate, li.quantity,
                r.reasontype
         FROM stockmanagement.stock_card_line_items li
         LEFT JOIN stockmanagement.stock_card_line_item_reasons r ON r.id = li.reasonid
         WHERE li.stockcardid = $1
       ) t`,
      [cardId]
    );

    const sohRes = await client.query(
      `SELECT stockonhand FROM stockmanagement.calculated_stocks_on_hand
        WHERE stockcardid = $1 ORDER BY occurreddate DESC, processeddate DESC LIMIT 1`,
      [cardId]
    );
    const newSoh = sohRes.rowCount ? sohRes.rows[0].stockonhand : 0;

    await client.query('COMMIT');
    logger.info({ event: 'stock-line-item-deleted', id, cardId, newSoh });

    // Optionally also remove the mirrored HAPI MedicationDispense so the patient/VHW
    // audit row is fully gone. The frontend passes the exact FHIR id it matched, so
    // this is precise. Best-effort — the OpenLMIS delete has already committed, so a
    // FHIR failure does not undo it. (OpenSRP events + DHIS2 aggregates are not touched.)
    let fhirDeleted = null;
    const fhirId = (req.query && req.query.fhirId) || (req.body && req.body.fhirId) || null;
    if (fhirId && FHIR_ID_RE.test(fhirId)) {
      const hapiUrl = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
      try {
        await axios.delete(`${hapiUrl}/MedicationDispense/${fhirId}?_cascade=delete`, { timeout: 8000 });
        fhirDeleted = fhirId;
        logger.info({ event: 'stock-delete-fhir-removed', fhirId, lineItemId: id });
      } catch (e) {
        logger.warn({ event: 'stock-delete-fhir-failed', fhirId, error: e.message });
      }
    }

    reply(res, { status: 'ok', deleted: id, stockCardId: cardId, stockOnHand: newSoh, fhirDeleted });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    logger.error({ event: 'stock-line-item-delete-failed', id, error: err.message });
    reply(res, { status: 'error', message: err.message }, 502);
  } finally {
    client.release();
  }
});

module.exports = router;
