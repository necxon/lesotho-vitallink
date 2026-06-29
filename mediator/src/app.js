/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const express = require('express');

const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

app.use('/fhir/MedicationDispense',    require('./routes/dispense'));
app.use('/fhir/SupplyDelivery',        require('./routes/supply'));
app.use('/fhir/QuestionnaireResponse', require('./routes/questionnaire'));
app.use('/fhir/bundle-sync',           require('./routes/bundleSync'));
app.use('/PractitionerDetail',         require('./routes/practitionerDetail'));
app.use('/aggregate/whoami',           require('./routes/whoami'));
app.use('/aggregate/mappings',         require('./routes/mappings'));
app.use('/aggregate/users',            require('./routes/users'));
app.use('/aggregate/stock-admin',      require('./routes/stockAdmin'));
app.use('/aggregate/stock',            require('./routes/allocations'));
app.use('/aggregate',                  require('./routes/aggregate'));
app.use('/dhis2',                      require('./routes/dhis2sync'));
app.use('/test',                       require('./routes/testRunner'));
app.use('/lmis-notifications',         require('./routes/lmisNotifications').router);
app.use('/config',                     require('./routes/config'));
app.use('/session',                    require('./routes/session'));
app.use('/db-export',                  require('./routes/dbExport'));

// Proxy all FHIR deletes through to HAPI FHIR (catch-all below swallows DELETE otherwise).
app.delete('/fhir/:resourceType/:id', async (req, res) => {
  const axios   = require('axios');
  const hapiUrl = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
  try {
    const r = await axios.delete(`${hapiUrl}/${req.params.resourceType}/${req.params.id}?_cascade=delete`);
    res.status(r.status).json(r.data || {});
  } catch (e) {
    const status = (e.response && e.response.status) || 502;
    res.status(status).json({ error: e.message });
  }
});

// HAPI FHIR subscription delivers via PUT /:id — accept and return success so HAPI stops retrying.
// The 30s poller handles actual fan-out processing.
app.all('/fhir/*', (req, res, next) => {
  if (req.path === '/fhir/QuestionnaireResponse' && req.method === 'POST') return next();
  require('./logger').debug(`Subscription delivery: ${req.method} ${req.path}`);
  res.status(200).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational' }] });
});

app.post('/lmis-token', async (_req, res) => {
  try {
    const { getOpenLMISToken } = require('./tokens');
    const token = await getOpenLMISToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = app;
