/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

/**
 * scheduleState.js — manages the order-batch cron job lifecycle.
 *
 * Persists the chosen frequency (daily / weekly / monthly) to a JSON file
 * so it survives container restarts. Exposes init() / setFrequency() so the
 * aggregate route can change the schedule at runtime without a restart.
 */

const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const logger = require('../logger');

const SCHEDULE_FILE = process.env.ORDER_SCHEDULE_FILE || '/data/order-schedule.json';

const FREQ_MAP = {
  daily:    '0 6 * * *',
  weekly:   '0 6 * * 1',
  monthly:  '0 6 1 * *',
  disabled: null,
};

let _task       = null;
let _onDispatch = null;

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFrequency() {
  try {
    const d = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    return d.frequency in FREQ_MAP ? d.frequency : 'weekly';
  } catch (_) {
    return process.env.ORDER_BATCH_FREQUENCY || 'weekly';
  }
}

function saveFrequency(freq) {
  const dir = path.dirname(SCHEDULE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ frequency: freq }));
}

// ── Cron management ───────────────────────────────────────────────────────────

function _reschedule(freq) {
  if (_task) { _task.destroy(); _task = null; }
  const expr = FREQ_MAP[freq];
  if (!expr) {
    logger.info(`Order batch cron disabled`);
    return;
  }
  if (_onDispatch) {
    _task = cron.schedule(expr, _onDispatch);
    logger.info(`Order batch cron rescheduled: frequency="${freq}" expr="${expr}"`);
  }
}

// ── Next-dispatch calculator ──────────────────────────────────────────────────

function nextDispatchTime(freq) {
  if (freq === 'disabled') return null;
  const now  = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);

  if (freq === 'daily') {
    if (now >= next) next.setDate(next.getDate() + 1);
    return next;
  }
  if (freq === 'monthly') {
    next.setDate(1);
    if (now >= next) next.setMonth(next.getMonth() + 1);
    return next;
  }
  // weekly (default) — next Monday
  const days = (7 - now.getDay()) % 7 || 7;
  next.setDate(now.getDate() + days);
  return next;
}

// ── Public API ────────────────────────────────────────────────────────────────

function init(onDispatch) {
  _onDispatch = onDispatch;
  _reschedule(loadFrequency());
}

function setFrequency(freq) {
  if (!(freq in FREQ_MAP)) throw new Error('Invalid frequency. Must be daily, weekly, monthly, or disabled.');
  saveFrequency(freq);
  _reschedule(freq);
  return FREQ_MAP[freq];
}

function getFrequency() {
  return loadFrequency();
}

module.exports = { init, setFrequency, getFrequency, nextDispatchTime, FREQ_MAP };
