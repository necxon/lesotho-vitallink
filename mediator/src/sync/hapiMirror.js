/*
 * NEC XON (c) Copyright 2025.
 *
 * Mirrors a MedicationDispense into HAPI FHIR so it appears in the patient's
 * dispense history (and the Stock Log cross-reference). Tagged mediator-processed
 * so the HAPI poller does not re-fan-out the mirrored copy. Used by both the
 * direct dispense route and the dispense-QuestionnaireResponse path.
 */
'use strict';

const axios  = require('axios');
const logger = require('../logger');

const HAPI_URL     = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
const MEDIATOR_TAG = { system: 'http://mediator/tags', code: 'mediator-processed' };

async function mirrorDispenseToHapi(resource, resourceId) {
  const tag = (base) => ({
    resourceType: 'MedicationDispense',
    ...base,
    meta: { ...(base.meta || {}), tag: [...((base.meta && base.meta.tag) || []), MEDIATOR_TAG] },
  });
  const headers = { 'Content-Type': 'application/fhir+json' };
  const opts    = { headers, timeout: 5000 };

  const doCall = (body) => resourceId
    ? axios.put(`${HAPI_URL}/MedicationDispense/${resourceId}`, body, opts)
    : axios.post(`${HAPI_URL}/MedicationDispense`, body, opts);

  try {
    await doCall(tag(resource));
  } catch (err) {
    // 400 usually means a deleted/unknown reference — retry with minimal fields.
    // KEEP subject so the patient link survives (it's what powers the patient
    // page's dispense history); only drop the heavier optional fields.
    if (err.response && err.response.status === 400) {
      const bare = {
        resourceType:              'MedicationDispense',
        status:                    resource.status || 'completed',
        subject:                   resource.subject,
        medicationCodeableConcept: resource.medicationCodeableConcept,
        whenHandedOver:            resource.whenHandedOver,
        quantity:                  resource.quantity,
        performer:                 resource.performer,
      };
      if (resourceId) bare.id = resourceId;
      doCall(tag(bare)).catch(err2 =>
        logger.warn({ event: 'dispense-hapi-mirror-failed', resourceId, error: err2.message }));
    } else {
      logger.warn({ event: 'dispense-hapi-mirror-failed', resourceId, error: err.message });
    }
  }
}

module.exports = { mirrorDispenseToHapi };
