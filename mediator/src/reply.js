/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const { mediatorConfig } = require('./config/config');

// Plain mediator reply: JSON body + the x-mediator-urn header OpenHIM uses to
// associate the transaction with this mediator.
function reply(res, data, status = 200) {
  return res.status(status).set('x-mediator-urn', mediatorConfig.urn).json(data);
}

// OpenHIM mediator-response reply. Wraps `data` in the canonical mediator envelope
// (Content-Type: application/json+openhim) so OpenHIM records per-downstream
// `orchestrations` — which drive the Console visualizer + transaction orchestration
// log. OpenHIM unwraps `response.body` back to the original client, so callers still
// receive exactly `data` with a normal application/json content-type.
//   https://openhim.org/docs/dev-guide/mediators/#the-mediator-response
function replyMediator(res, data, status = 200, { orchestrations = [], transactionStatus } = {}) {
  const ts = new Date().toISOString();
  const envelope = {
    'x-mediator-urn': mediatorConfig.urn,
    status: transactionStatus || (status < 400 ? 'Successful' : 'Failed'),
    response: {
      status,
      headers:   { 'content-type': 'application/json' },
      body:      JSON.stringify(data),
      timestamp: ts,
    },
    orchestrations,
    properties: {},
  };
  return res.status(status)
    .set('x-mediator-urn', mediatorConfig.urn)
    .set('Content-Type', 'application/json+openhim')
    .send(JSON.stringify(envelope));
}

module.exports = reply;
module.exports.replyMediator = replyMediator;
