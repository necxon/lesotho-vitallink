/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

/**
 * POST /dhis2/sync — trigger the dhis2-integration service to push the latest
 * OpenLMIS stock data to DHIS2.  The dhis2-integration service runs inside the
 * openlmis-ref-distro_default network, reachable as dhis2-integration:8080.
 * We obtain an OpenLMIS user token (same as the mediator uses for stock events)
 * and forward it as a Bearer token to /api/execute.
 */

const { Router } = require('express');
const http        = require('http');
const logger      = require('../logger');
const { getOpenLMISToken } = require('../tokens');

const router = Router();

const DHIS2_INTEG_HOST = process.env.DHIS2_INTEG_HOST || 'dhis2-integration';
const DHIS2_INTEG_PORT = parseInt(process.env.DHIS2_INTEG_PORT || '8080', 10);

router.post('/sync', async (req, res) => {
  try {
    const token = await getOpenLMISToken();

    await new Promise((resolve, reject) => {
      const payload = '{}';
      const options = {
        hostname: DHIS2_INTEG_HOST,
        port:     DHIS2_INTEG_PORT,
        path:     '/api/execute',
        method:   'POST',
        headers: {
          'Authorization':  'Bearer ' + token,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const r = http.request(options, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            logger.info({ event: 'dhis2-sync-triggered', status: resp.statusCode });
            resolve();
          } else {
            reject(new Error(`dhis2-integration returned HTTP ${resp.statusCode}: ${body}`));
          }
        });
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    res.json({ status: 'ok', message: 'DHIS2 sync triggered' });
  } catch (err) {
    logger.error({ event: 'dhis2-sync-error', error: err.message });
    res.status(503).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
