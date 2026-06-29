/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const axios         = require('axios');
const logger        = require('../logger');
const { TIMEOUT_MS } = require('../config/config');
const runtimeConfig = require('../config/runtimeConfig');

// Per-channel, per-recipient, per-event cooldown map.
// Env vars: NOTIFY_{SMS|PUSH|EMAIL}_THROTTLE_MS (0 = no throttle)
const _notifCooldowns = new Map();

function _throttleKey(channel, eventType, recipient) {
  return `${channel}:${eventType}:${recipient || '_'}`;
}

function _throttleMs(channel) {
  return parseInt(runtimeConfig.get(`NOTIFY_${channel.toUpperCase()}_THROTTLE_MS`) || '0', 10);
}

function _canSend(channel, eventType, recipient) {
  const ms = _throttleMs(channel);
  if (ms <= 0) return true;
  const last = _notifCooldowns.get(_throttleKey(channel, eventType, recipient)) || 0;
  return (Date.now() - last) >= ms;
}

function _markSent(channel, eventType, recipient) {
  const ms = _throttleMs(channel);
  if (ms <= 0) return;
  _notifCooldowns.set(_throttleKey(channel, eventType, recipient), Date.now());
}

function clearNotifCooldowns() {
  _notifCooldowns.clear();
}

function _notifMessage(ev) {
  switch (ev.type) {
    case 'dispense':   return `Dispense confirmed: ${ev.qty} units of ${ev.medication} dispensed to ${ev.patient}`;
    case 'receipt':    return `Receipt recorded: ${ev.qty} units of ${ev.medication} received at facility`;
    case 'low-stock':  return `ALERT: Stock low — ${ev.medication} has ${ev.newSoh} units remaining (threshold: ${ev.threshold})`;
    default:           return `Notification: ${ev.type}`;
  }
}

function _logFailed(channel, url, payload, err) {
  logger.error('Notification delivery failed', {
    failedNotification: true,
    channel,
    url,
    payload,
    error: err.message,
    code:  err.code || null
  });
}

/**
 * Sends SMS, push, and/or email notifications for one or more events.
 * All failures are swallowed — notifications must never block the main flow.
 */
async function sendNotifications(events, phone, email) {
  const smsEnabled   = runtimeConfig.get('NOTIFY_SMS_ENABLED')   === 'true';
  const pushEnabled  = runtimeConfig.get('NOTIFY_PUSH_ENABLED')  === 'true';
  const emailEnabled = runtimeConfig.get('NOTIFY_EMAIL_ENABLED') === 'true';
  if (!smsEnabled && !pushEnabled && !emailEnabled) return;

  const smsUrl    = process.env.NOTIFY_SMS_URL;
  const pushUrl   = process.env.NOTIFY_PUSH_URL;
  const emailUrl  = process.env.NOTIFY_EMAIL_URL;
  const apiKey    = process.env.NOTIFY_PUSH_API_KEY || '';
  const emailFrom = process.env.NOTIFY_EMAIL_FROM || 'mediator@lesotho.health';

  const promises = [];

  for (const ev of events) {
    const message = _notifMessage(ev);
    const title   = ev.type === 'low-stock' ? 'Low Stock Alert' : 'Stock Update';

    if (smsEnabled && smsUrl && phone) {
      if (_canSend('sms', ev.type, phone)) {
        const payload = { to: phone, message, event: ev.type };
        promises.push(
          axios.post(smsUrl, payload, { timeout: TIMEOUT_MS })
            .then(() => { _markSent('sms', ev.type, phone); logger.info(`SMS sent: event=${ev.type} to=${phone}`); })
            .catch(e => _logFailed('sms', smsUrl, payload, e))
        );
      } else {
        logger.info(`SMS throttled: event=${ev.type} to=${phone} (cooldown active)`);
      }
    }

    if (pushEnabled && pushUrl) {
      const pushRecipient = phone || 'vhw';
      if (_canSend('push', ev.type, pushRecipient)) {
        const headers = apiKey ? { Authorization: `key=${apiKey}` } : {};
        const payload = { to: pushRecipient, title, body: message, event: ev.type };
        promises.push(
          axios.post(pushUrl, payload, { headers, timeout: TIMEOUT_MS })
            .then(() => { _markSent('push', ev.type, pushRecipient); logger.info(`Push sent: event=${ev.type}`); })
            .catch(e => _logFailed('push', pushUrl, payload, e))
        );
      } else {
        logger.info(`Push throttled: event=${ev.type} (cooldown active)`);
      }
    }

    if (emailEnabled && emailUrl && email) {
      if (_canSend('email', ev.type, email)) {
        const payload = { to: email, from: emailFrom, subject: title, body: message, event: ev.type };
        promises.push(
          axios.post(emailUrl, payload, { timeout: TIMEOUT_MS })
            .then(() => { _markSent('email', ev.type, email); logger.info(`Email sent: event=${ev.type} to=${email}`); })
            .catch(e => _logFailed('email', emailUrl, payload, e))
        );
      } else {
        logger.info(`Email throttled: event=${ev.type} to=${email} (cooldown active)`);
      }
    }
  }

  await Promise.all(promises);
}

module.exports = { sendNotifications, clearNotifCooldowns };
