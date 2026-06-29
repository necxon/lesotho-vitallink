/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

/**
 * VITAL-LINK MEDIATOR  v1.1.0
 *  Plugin for Lesotho Health Department
 *
 * Sits behind OpenHIM and fans out stock movement events from the Android BKM
 * app (OpenSRP 2) to three national systems simultaneously:
 *
 *   OpenSRP 2 (Android app)
 *     └─▶ OpenHIM (intercept + audit)
 *           └─▶ Vital-Link Mediator (this service, port 3000)
 *                 ├─▶ OpenSRP   — records clinical event
 *                 ├─▶ OpenLMIS  — records stock events (DEBIT or CREDIT)
 *                 └─▶ DHIS2     — writes aggregate data values for dashboards
 *
 * Module layout:
 *   src/config/config.js        — CONFIG, mediatorConfig, TIMEOUT_MS
 *   src/config/runtimeConfig.js — runtime feature-flag overrides
 *   src/logger.js              — winston logger
 *   src/mappings.js            — CSV identity/medication maps
 *   src/tokens.js              — OpenLMIS + Keycloak token caches
 *   src/orders/orderBuffer.js  — PostgreSQL order buffer + dispatch logic
 *   src/orders/aggregation.js  — facility aggregation + period-end SOH snapshot
 *   src/orders/scheduleState.js — cron schedule for order dispatch
 *   src/tasks/tasks.js         — FHIR Task CRUD (stock acceptance)
 *   src/sync/fanout.js         — shared fan-out pipeline
 *   src/sync/poller.js         — background SOH poll + receipt detection
 *   src/sync/notifications.js  — VHW SMS/push/email + throttle
 *   src/integrations/opensrp.js
 *   src/integrations/openlmis.js
 *   src/integrations/dhis2.js
 *   src/routes/dispense.js     — POST /fhir/MedicationDispense
 *   src/routes/supply.js       — POST /fhir/SupplyDelivery
 *   src/routes/questionnaire.js — POST /fhir/QuestionnaireResponse
 *   src/routes/aggregate.js    — POST /aggregate
 *   src/app.js                 — express wiring
 */

const cron  = require('node-cron');
const utils = require('openhim-mediator-utils');

const { CONFIG, mediatorConfig }                         = require('./src/config/config');
const logger                                              = require('./src/logger');
const { loadMappings, applyOpenHIMConfig, refreshOrderablesFromLMIS } = require('./src/mappings/mappings');
const { clearNotifCooldowns }                             = require('./src/sync/notifications');
const dispenseRouter                                      = require('./src/routes/dispense');
const { clearOverrides: clearRuntimeOverrides }           = require('./src/config/runtimeConfig');
const runtimeConfig                                       = require('./src/config/runtimeConfig');
const { pollStockLevels, pollHapiFhirOrders, pollLmisForVhwTasks, pollHapiFhirDispenses } = require('./src/sync/poller');
const { schedulePeriodEndSnapshot, runFacilityAggregation } = require('./src/orders/aggregation');
const { dispatchOrders, refreshDashboardText, loadDispatchLog } = require('./src/orders/orderBuffer');
const { init: initOrderSchedule }                                = require('./src/orders/scheduleState');
const { initDb }                                                 = require('./src/db');
const app                                                 = require('./src/app');

// =============================================================================
// STARTUP
// =============================================================================

loadMappings();

initDb().catch(err => {
  logger.error(`DB init failed: ${err.message}`);
  process.exit(1);
});

// Heartbeat options: merges OpenHIM auth config with the mediator URN
// (required by openhim-mediator-utils for the heartbeat URL + auth headers)
const heartbeatOptions = { ...CONFIG.openhim, urn: mediatorConfig.urn };

// HTTP server starts immediately so the mediator handles requests regardless of
// OpenHIM availability. Registration is retried in the background.
app.listen(3000, () => {
  logger.info('Vital-Link Lesotho v1.1.0 Active on port 3000');

  // Self-rescheduling poll loop — reads POLL_INTERVAL_MS from runtimeConfig each
  // cycle, so changes on the Settings page take effect from the next cycle (no
  // restart needed). Floor of 5s matches the Settings minimum.
  function pollIntervalMs() {
    const ms = parseInt(runtimeConfig.get('POLL_INTERVAL_MS') || '60000', 10);
    return ms >= 5000 ? ms : 5000;
  }
  function loopPoll(fn, initialDelay) {
    setTimeout(async function run() {
      try { await fn(); } catch (e) { logger.warn(`poll loop error: ${e.message}`); }
      setTimeout(run, pollIntervalMs());
    }, initialDelay);
  }
  loopPoll(pollStockLevels, 10000);
  setTimeout(pollHapiFhirOrders, 15000);
  setInterval(pollHapiFhirOrders, 30000);
  loopPoll(pollLmisForVhwTasks, 20000);
  loopPoll(pollHapiFhirDispenses, 25000);
  schedulePeriodEndSnapshot();
  loadDispatchLog().then(refreshDashboardText).catch(() => {});

  refreshOrderablesFromLMIS();
  setInterval(refreshOrderablesFromLMIS, 60 * 60 * 1000);

  const { initFromOpenLmis } = require('./src/sync/fhirLedger');
  setTimeout(() => initFromOpenLmis().catch(err =>
    logger.warn(`FHIR ledger init failed (non-fatal): ${err.message}`)), 30000);
  setInterval(() => initFromOpenLmis().catch(() => {}), 5 * 60 * 1000);

  const aggregateSchedule = process.env.AGGREGATE_SCHEDULE || '0 1 * * *';
  if (cron.validate(aggregateSchedule)) {
    cron.schedule(aggregateSchedule, () => {
      const period = new Date().toISOString().slice(0, 7).replace('-', '');
      logger.info(`Scheduled facility aggregation: period=${period} schedule="${aggregateSchedule}"`);
      runFacilityAggregation(period).catch(err =>
        logger.error(`Scheduled aggregation error: ${err.message}`)
      );
    });
    logger.info(`Facility aggregation cron registered: "${aggregateSchedule}" (daily 1am default)`);
  } else {
    logger.warn(`Invalid AGGREGATE_SCHEDULE="${aggregateSchedule}" — aggregation cron not registered`);
  }

  initOrderSchedule(() => {
    logger.info('Scheduled order batch dispatch triggered');
    dispatchOrders().catch(err =>
      logger.error(`Scheduled order dispatch error: ${err.message}`)
    );
  });

  // Register with OpenHIM in the background with exponential backoff retry.
  registerWithOpenHIM(1);
});

function registerWithOpenHIM(attempt) {
  utils.registerMediator(CONFIG.openhim, mediatorConfig, (err) => {
    if (err) {
      const delay = Math.min(60000, 5000 * attempt);
      logger.warn(`OpenHIM registration failed (attempt ${attempt}) — retrying in ${delay / 1000}s`);
      setTimeout(() => registerWithOpenHIM(attempt + 1), delay);
      return;
    }
    logger.info('Registered with OpenHIM successfully');
    utils.fetchConfig(heartbeatOptions, (fetchErr, config) => {
      if (fetchErr) {
        logger.warn(`Could not fetch OpenHIM config on startup (using CSV): ${fetchErr.message}`);
      } else {
        applyOpenHIMConfig(config);
      }
    });
    const hb = utils.activateHeartbeat(heartbeatOptions);
    hb.on('config', (newConfig) => {
      logger.info('OpenHIM config update received — reloading mappings');
      applyOpenHIMConfig(newConfig);
    });
    hb.on('error', (hbErr) => {
      logger.warn(`Heartbeat error (non-fatal): ${hbErr.message}`);
    });
  });
}

// =============================================================================
// EXPORTS  (used by Jest unit tests)
// =============================================================================

module.exports = { app, mediatorConfig, clearNotifCooldowns, clearSeenIds: dispenseRouter.clearSeenIds, clearRuntimeOverrides };
