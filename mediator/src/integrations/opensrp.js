/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';


//TODO: add a periodic refresh for better eventual consistency, and to cover changes made outside the BKM app.
//TODO: consider switching to a more robust format like JSON or YAML if mappings become more complex; CSV is simple but can be error-prone and doesn't support nested structures well. For now it's easy to edit in a spreadsheet and review in git diffs, which is nice for the current scale of mappings.

const crypto = require('crypto');
const axios  = require('axios');
const { CONFIG, TIMEOUT_MS } = require('../config/config');
const logger = require('../logger');
const { getKeycloakToken } = require('../tokens');

async function forwardToOpenSRP(resource, identity) {
  const token = await getKeycloakToken();
  const eventDate = resource.whenHandedOver?.split('T')[0]
    || new Date().toISOString().split('T')[0];

  const body = {
    clients: [],
    events: [{
      formSubmissionId: crypto.randomUUID(),
      eventType:    'MedicationDispense',
      baseEntityId: resource.subject?.reference              || 'unknown',
      providerId:   resource.performer?.[0]?.actor?.reference || 'unknown',
      eventDate,
      obs: [{
        fieldCode: 'quantity',
        values:    [String(resource.quantity?.value || 0)]
      }]
    }]
  };

  logger.debug(`OpenSRP event/add POST: eventDate=${eventDate}`);
  const res = await axios.post(`${CONFIG.opensrp.url}/opensrp/rest/event/add`, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_MS
  });
  logger.debug(`OpenSRP event/add response: HTTP ${res.status}`);
  return res;
}

module.exports = { forwardToOpenSRP };
