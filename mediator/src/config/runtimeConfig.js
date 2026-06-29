/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.RUNTIME_CONFIG_FILE || '/data/runtime-config.json';

// Hardcoded defaults — used when neither a file override nor an env var is set
const DEFAULTS = {
  NOTIFY_SMS_ENABLED:            'false',
  NOTIFY_PUSH_ENABLED:           'false',
  NOTIFY_EMAIL_ENABLED:          'false',
  NOTIFY_ON_DISPENSE:            'false',
  NOTIFY_ON_RECEIPT:             'false',
  NOTIFY_ON_LOW_STOCK:           'false',
  NOTIFY_LMIS_ON_DISPENSE:       'true',
  NOTIFY_LMIS_ON_RECEIPT:        'true',
  NOTIFY_LMIS_ON_LOW_STOCK:      'true',
  NOTIFY_LMIS_ON_ORDER_DISPATCH: 'true',
  NOTIFY_LOW_STOCK_THRESHOLD:    '20',
  NOTIFY_SMS_THROTTLE_MS:        '0',
  NOTIFY_PUSH_THROTTLE_MS:       '0',
  NOTIFY_EMAIL_THROTTLE_MS:      '0',
  DOWNSTREAM_TIMEOUT_MS:         '10000',
  POLL_INTERVAL_MS:              '60000',
  POLL_BATCH_SIZE:               '50',
  VHW_TASK_POLL_ENABLED:         'false',
  REJECT_DISPENSE_EXCEEDS_STOCK: 'true',
  FANOUT_OPENSRP_ENABLED:        'true',
  FANOUT_DHIS2_ENABLED:          'true',
  FANOUT_OPENLMIS_ENABLED:       'true',
  // Wrap dispense responses in the OpenHIM mediator envelope (orchestrations) so the
  // Console visualizer animates each downstream system. Set 'false' for plain JSON.
  MEDIATOR_ORCHESTRATIONS:       'true',
  REJECT_DUPLICATE_DISPENSE:     'true',
  IDEMPOTENCY_WINDOW_MS:         '300000',
  REJECT_UNKNOWN_PERFORMER:      'false',
  REJECT_UNKNOWN_MEDICINE:       'false',
  FHIR_LEDGER_ENABLED:           'true',
  // Per-VHW stock allocation
  REQUIRE_VHW_ALLOCATION:        'true',
  ALLOCATION_CARRIES_OVER:       'false',
  // Block allocation until the facility has accepted a real delivery (non-seed CREDIT).
  REQUIRE_DELIVERY_BEFORE_ALLOCATION: 'true',
};

// In-memory overrides loaded from file at startup, written on every patch()
let _overrides = {};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    _overrides = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (e) {
  console.warn(`[runtimeConfig] Could not load ${CONFIG_FILE}: ${e.message}`);
}

// Priority: file override > env var > hardcoded default
function get(key) {
  if (Object.prototype.hasOwnProperty.call(_overrides, key)) return _overrides[key];
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  return DEFAULTS[key];
}

function getAll() {
  const result = {};
  for (const key of Object.keys(DEFAULTS)) result[key] = get(key);
  return result;
}

function clearOverrides() { _overrides = {}; }

function patch(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      _overrides[key] = String(value);
    }
  }
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_overrides, null, 2));
  } catch (e) {
    console.warn(`[runtimeConfig] Could not write ${CONFIG_FILE}: ${e.message}`);
  }
  return getAll();
}

module.exports = { get, getAll, patch, clearOverrides };
