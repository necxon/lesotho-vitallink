'use strict';

const request = require('supertest');

// ---------------------------------------------------------------------------
// Mock axios BEFORE requiring the app so module-level code sees the mock.
// We use mockImplementation (URL-routing) rather than mockResolvedValueOnce
// because the three fan-out calls run in parallel via Promise.allSettled:
//   1. forwardToOpenSRP  → getKeycloakToken() fires axios.post(KC URL)
//   2. pushToDHIS2       → axios.post(DHIS2 URL)    ← fires BEFORE LMIS token
//   3. pushToOpenLMIS    → getOpenLMISToken() fires axios.post(LMIS auth URL)
// Order-based mocks would consume the wrong responses; URL routing is stable.
// ---------------------------------------------------------------------------
jest.mock('axios');
const axios = require('axios');

// Mock openhim-mediator-utils — registerMediator is a no-op in tests
jest.mock('openhim-mediator-utils', () => ({ registerMediator: jest.fn() }));

const { app, mediatorConfig, clearRetryQueue, clearNotifCooldowns } = require('../index');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const FHIR_BODY = {
  resourceType:   'MedicationDispense',
  status:         'completed',
  subject:        { reference: 'Patient/patient-001' },
  performer:      [{ actor: { reference: 'Practitioner/opensrp-admin' } }],
  whenHandedOver: '2026-02-28T10:00:00.000Z',
  quantity:       { value: 6, unit: 'tablet' },
};

/**
 * Route axios calls by URL.
 *
 * POST overrides: opensrp / dhis2 / openlmis — pass a Promise to override a downstream response.
 * GET  override:  stockCards — pass a Promise to override the stock-card summary response.
 *                 stockOnHand — shorthand number; defaults to 100 (plenty of stock).
 *                 Pass stockOnHand: null for "no stock card yet" (first dispense).
 */
function mockByUrl({ opensrp, dhis2, openlmis, stockCards, stockOnHand = 100 } = {}) {
  // Attach no-op catch handlers to pre-created rejected promises so Node's
  // unhandledRejection event doesn't fire before Promise.allSettled handles them.
  if (opensrp   instanceof Promise) opensrp.catch(() => {});
  if (dhis2     instanceof Promise) dhis2.catch(() => {});
  if (openlmis  instanceof Promise) openlmis.catch(() => {});
  if (stockCards instanceof Promise) stockCards.catch(() => {});

  axios.post.mockImplementation((url) => {
    if (url.includes('openid-connect/token')) {
      return Promise.resolve({ data: { access_token: 'kc-token', expires_in: 300 } });
    }
    if (url.includes('/api/oauth/token')) {
      return Promise.resolve({ data: { access_token: 'lmis-token', expires_in: 300 } });
    }
    if (url.includes('/opensrp/rest/event/add')) {
      return opensrp ?? Promise.resolve({ status: 201 });
    }
    if (url.includes('/api/dataValueSets')) {
      return dhis2 ?? Promise.resolve({ status: 200 });
    }
    if (url.includes('/api/stockEvents')) {
      return openlmis ?? Promise.resolve({ status: 201 });
    }
    return Promise.reject(new Error(`Unexpected axios.post URL: ${url}`));
  });

  // Stock validation check (Job 3)
  axios.get.mockImplementation((url) => {
    if (url.includes('/api/stockCardSummaries')) {
      if (stockCards !== undefined) return stockCards;
      const content = stockOnHand === null ? [] : [{ stockOnHand }];
      return Promise.resolve({ data: { content } });
    }
    return Promise.reject(new Error(`Unexpected axios.get URL: ${url}`));
  });
}

// resetAllMocks clears both call history AND implementations between tests
beforeEach(() => {
  jest.resetAllMocks();
  clearRetryQueue();        // cancel any pending retry timers from previous test
  clearNotifCooldowns();    // reset throttle state between tests
});

// ---------------------------------------------------------------------------
// 1. Happy path — all three succeed
// ---------------------------------------------------------------------------
describe('POST /fhir/MedicationDispense — happy path', () => {
  test('returns HTTP 200 with status "Successful"', async () => {
    mockByUrl();

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Successful');
    expect(res.body.results.opensrp).toBe('HTTP 201');
    expect(res.body.results.dhis2).toBe('HTTP 200');
    expect(res.body.results.openlmis).toBe('HTTP 201');
  });

  test('sets x-mediator-urn response header', async () => {
    mockByUrl();

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.headers['x-mediator-urn']).toBe(mediatorConfig.urn);
  });
});

// ---------------------------------------------------------------------------
// 2. Partial failure — one downstream fails
// ---------------------------------------------------------------------------
describe('POST /fhir/MedicationDispense — partial failure', () => {
  test('returns HTTP 207 when OpenSRP fails', async () => {
    mockByUrl({
      opensrp: Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    });

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('Completed with errors');
    expect(res.body.results.opensrp).toMatch(/ECONNREFUSED/);
    expect(res.body.results.dhis2).toBe('HTTP 200');
    expect(res.body.results.openlmis).toBe('HTTP 201');
  });

  test('returns HTTP 207 when all three fail', async () => {
    mockByUrl({
      opensrp:  Promise.reject(new Error('timeout')),
      dhis2:    Promise.reject(new Error('timeout')),
      openlmis: Promise.reject(new Error('timeout')),
    });

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('Completed with errors');
  });
});

// ---------------------------------------------------------------------------
// 3. OpenSRP payload structure
// ---------------------------------------------------------------------------
describe('OpenSRP payload', () => {
  test('sends {clients:[], events:[...]} wrapper with correct fields', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    const opensrpCall = axios.post.mock.calls.find(([url]) =>
      url.includes('/opensrp/rest/event/add')
    );
    expect(opensrpCall).toBeDefined();

    const body = opensrpCall[1];
    expect(body).toHaveProperty('clients', []);
    expect(Array.isArray(body.events)).toBe(true);

    const event = body.events[0];
    expect(event.eventType).toBe('MedicationDispense');
    expect(event.baseEntityId).toBe('Patient/patient-001');
    expect(event.providerId).toBe('Practitioner/opensrp-admin');
    expect(event.eventDate).toBe('2026-02-28');
    expect(event.obs[0].fieldCode).toBe('quantity');
    expect(event.obs[0].values).toEqual(['6']);
  });
});

// ---------------------------------------------------------------------------
// 4. DHIS2 payload structure
// ---------------------------------------------------------------------------
describe('DHIS2 payload', () => {
  test('sends correct dataElement, orgUnit, period, and value', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    const dhis2Call = axios.post.mock.calls.find(([url]) =>
      url.includes('/api/dataValueSets')
    );
    expect(dhis2Call).toBeDefined();

    const dv = dhis2Call[1].dataValues[0];
    expect(dv.dataElement).toBe('ujPSJuS9pph');
    expect(dv.orgUnit).toBe('dwx1Yz4BwNX');
    expect(dv.value).toBe('6');
    expect(dv.period).toMatch(/^\d{6}$/); // YYYYMM, no dash
  });
});

// ---------------------------------------------------------------------------
// 5. OpenLMIS payload structure
// ---------------------------------------------------------------------------
describe('OpenLMIS payload', () => {
  test('sends correct facilityId, programId, orderableId, reasonId, quantity', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    const lmisCall = axios.post.mock.calls.find(([url]) =>
      url.includes('/api/stockEvents')
    );
    expect(lmisCall).toBeDefined();

    const body = lmisCall[1];
    expect(body.facilityId).toBe('28de536f-b826-4eeb-a3c4-d65221a1120d');
    expect(body.programId).toBe('31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c');

    const li = body.lineItems[0];
    expect(li.orderableId).toBe('3be1d20f-6aa9-4e52-864f-4fa04aa02056');
    expect(li.reasonId).toBe('b5c27da7-bdda-4790-925a-9484c5dfb594');
    expect(li.quantity).toBe(6);
    expect(li.occurredDate).toBe('2026-02-28');
    expect(li.documentationNo).toMatch(/^BKM-\d+$/);
  });

  test('uses Bearer token from OpenLMIS OAuth in the Authorization header', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    const lmisCall = axios.post.mock.calls.find(([url]) =>
      url.includes('/api/stockEvents')
    );
    expect(lmisCall[2].headers['Authorization']).toBe('Bearer lmis-token');
  });
});

// ---------------------------------------------------------------------------
// 6. Missing / edge-case body fields
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  test('quantity defaults to 0 when not provided', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ resourceType: 'MedicationDispense', status: 'completed' });

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall[1].lineItems[0].quantity).toBe(0);

    const dhis2Call = axios.post.mock.calls.find(([url]) => url.includes('/api/dataValueSets'));
    expect(dhis2Call[1].dataValues[0].value).toBe('0');
  });

  test('subject and performer default to "unknown" when absent', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ resourceType: 'MedicationDispense', status: 'completed' });

    const opensrpCall = axios.post.mock.calls.find(([url]) =>
      url.includes('/opensrp/rest/event/add')
    );
    const event = opensrpCall[1].events[0];
    expect(event.baseEntityId).toBe('unknown');
    expect(event.providerId).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 7. Identity Mapping (Job 1 — Passport Control)
// ---------------------------------------------------------------------------
describe('identity mapping', () => {
  test('known performer resolves to the mapped facilityId and programId', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY); // performer: Practitioner/opensrp-admin

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall[1].facilityId).toBe('28de536f-b826-4eeb-a3c4-d65221a1120d');
    expect(lmisCall[1].programId).toBe('31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c');
  });

  test('unknown performer falls back to default facilityId', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, performer: [{ actor: { reference: 'Practitioner/unknown-vhw' } }] });

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall[1].facilityId).toBe('28de536f-b826-4eeb-a3c4-d65221a1120d');
  });

  test('known FHIR medication code resolves to the mapped orderableId', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, medicationCodeableConcept: { coding: [{ code: 'AL20120' }] } });

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall[1].lineItems[0].orderableId).toBe('3be1d20f-6aa9-4e52-864f-4fa04aa02056');
  });

  test('unknown medication code falls back to default orderableId', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, medicationCodeableConcept: { coding: [{ code: 'UNKNOWN-DRUG' }] } });

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall[1].lineItems[0].orderableId).toBe('3be1d20f-6aa9-4e52-864f-4fa04aa02056');
  });
});

// ---------------------------------------------------------------------------
// 8. Stock Validation (Job 3 — Safety Gate)
// ---------------------------------------------------------------------------
describe('stock validation', () => {
  test('allows dispense when stock is sufficient (stockOnHand >= quantity)', async () => {
    mockByUrl({ stockOnHand: 10 }); // 10 available, 6 requested

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(200);
  });

  test('rejects with HTTP 422 when quantity exceeds stockOnHand', async () => {
    mockByUrl({ stockOnHand: 3 }); // only 3 available, 6 requested

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reason).toBe('insufficient-stock');
    expect(res.body.stockOnHand).toBe(3);
    expect(res.body.requested).toBe(6);
  });

  test('allows first dispense when no stock card exists yet', async () => {
    mockByUrl({ stockOnHand: null }); // no card → first dispense

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(200);
  });

  test('allows dispense when stock check is unreachable (fail-open for patient care)', async () => {
    mockByUrl({ stockCards: Promise.reject(new Error('ECONNREFUSED')) });

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(200);
  });

  test('does not call downstream fan-out when 422 is returned', async () => {
    mockByUrl({ stockOnHand: 0 }); // zero stock

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, quantity: { value: 1 } }); // 1 requested, 0 available

    const stockEventCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(stockEventCall).toBeUndefined(); // fan-out must NOT have fired
  });
});

// ---------------------------------------------------------------------------
// 9. Resilience — Retry Queue (Job 4 — Backup Plan)
// ---------------------------------------------------------------------------
describe('resilience — retry queue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers(); // wipe carryover fake timers from previous tests in this block
  });
  afterEach(() => jest.useRealTimers());

  test('caller still receives HTTP 207 immediately when OpenLMIS fails', async () => {
    mockByUrl({
      openlmis: Promise.reject(new Error('ECONNREFUSED')),
    });

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('Completed with errors');
  });

  test('a retry timer is scheduled after OpenLMIS failure', async () => {
    mockByUrl({
      openlmis: Promise.reject(new Error('ECONNREFUSED')),
    });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    // At least one setTimeout should be pending (first retry at 10 s)
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });

  test('HTTP 200 confirms all targets succeeded and no retry is needed', async () => {
    mockByUrl(); // all succeed

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    // 200 = all three targets fulfilled → scheduleRetry was never called
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Successful');
  });
});

// ---------------------------------------------------------------------------
// 10. VHW Notifications
// ---------------------------------------------------------------------------
describe('VHW notifications', () => {
  // Helper: add notification sink URLs to the URL-routing mock
  function mockByUrlWithNotify(opts = {}) {
    mockByUrl(opts);
    // Extend the existing post mock to also handle notification endpoints
    const original = axios.post.getMockImplementation();
    axios.post.mockImplementation((url, ...rest) => {
      if (url.includes('/sms') || url.includes('/push') || url.includes('/email')) {
        return Promise.resolve({ status: 200, data: { ok: true } });
      }
      return original(url, ...rest);
    });
  }

  beforeEach(() => {
    process.env.NOTIFY_SMS_ENABLED   = 'true';
    process.env.NOTIFY_PUSH_ENABLED  = 'true';
    process.env.NOTIFY_EMAIL_ENABLED = 'true';
  });

  afterEach(() => {
    process.env.NOTIFY_SMS_ENABLED   = 'false';
    process.env.NOTIFY_PUSH_ENABLED  = 'false';
    process.env.NOTIFY_EMAIL_ENABLED = 'false';
  });

  test('sends SMS, push, and email notifications after successful dispense', async () => {
    mockByUrlWithNotify({ stockOnHand: 100 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    // Allow the fire-and-forget notification promises to settle
    await new Promise(resolve => setImmediate(resolve));

    const smsCalls   = axios.post.mock.calls.filter(([url]) => url.includes('/sms'));
    const pushCalls  = axios.post.mock.calls.filter(([url]) => url.includes('/push'));
    const emailCalls = axios.post.mock.calls.filter(([url]) => url.includes('/email'));

    expect(smsCalls.length).toBeGreaterThan(0);
    expect(smsCalls[0][1].event).toBe('dispense');
    expect(smsCalls[0][1].to).toBe('+26658765432'); // opensrp-admin phone from mappings.csv

    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls[0][1].event).toBe('dispense');

    expect(emailCalls.length).toBeGreaterThan(0);
    expect(emailCalls[0][1].event).toBe('dispense');
    expect(emailCalls[0][1].to).toBe('admin@lesotho.health'); // opensrp-admin email from mappings.csv
    expect(emailCalls[0][1].subject).toBeTruthy();
    expect(emailCalls[0][1].body).toMatch(/Dispense confirmed/);
  });

  test('includes low-stock notification when post-dispense SOH < threshold', async () => {
    // stockOnHand=10, qty=6 → newSoh=4 < threshold(20)
    mockByUrlWithNotify({ stockOnHand: 10 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    const smsEvents = axios.post.mock.calls
      .filter(([url]) => url.includes('/sms'))
      .map(([, body]) => body.event);

    expect(smsEvents).toContain('dispense');
    expect(smsEvents).toContain('low-stock');
  });

  test('does not send low-stock notification when post-dispense SOH >= threshold', async () => {
    // stockOnHand=100, qty=6 → newSoh=94 — above threshold(20)
    mockByUrlWithNotify({ stockOnHand: 100 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    const smsEvents = axios.post.mock.calls
      .filter(([url]) => url.includes('/sms'))
      .map(([, body]) => body.event);

    expect(smsEvents).not.toContain('low-stock');
  });

  test('sends receipt notification for RECEIPT type events', async () => {
    const receiptBody = {
      ...FHIR_BODY,
      type: { coding: [{ code: 'RECEIPT' }] },
      quantity: { value: 100, unit: 'tablet' },
    };
    mockByUrlWithNotify({ stockOnHand: 50 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(receiptBody);

    await new Promise(resolve => setImmediate(resolve));

    const smsEvents = axios.post.mock.calls
      .filter(([url]) => url.includes('/sms'))
      .map(([, body]) => body.event);

    expect(smsEvents).toContain('receipt');
    expect(smsEvents).not.toContain('dispense');
  });

  test('skips notifications when all channels are disabled', async () => {
    process.env.NOTIFY_SMS_ENABLED   = 'false';
    process.env.NOTIFY_PUSH_ENABLED  = 'false';
    process.env.NOTIFY_EMAIL_ENABLED = 'false';
    mockByUrl({ stockOnHand: 100 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    const notifCalls = axios.post.mock.calls
      .filter(([url]) => url.includes('/sms') || url.includes('/push') || url.includes('/email'));

    expect(notifCalls.length).toBe(0);
  });

  test('does not send notifications when OpenLMIS fan-out fails', async () => {
    mockByUrlWithNotify({
      openlmis: Promise.reject(new Error('ECONNREFUSED')),
    });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    const notifCalls = axios.post.mock.calls
      .filter(([url]) => url.includes('/sms') || url.includes('/push') || url.includes('/email'));

    expect(notifCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Notification Throttling
// ---------------------------------------------------------------------------
describe('notification throttling', () => {
  function mockWithAll(opts = {}) {
    mockByUrl(opts);
    const original = axios.post.getMockImplementation();
    axios.post.mockImplementation((url, ...rest) => {
      if (url.includes('/sms') || url.includes('/push') || url.includes('/email')) {
        return Promise.resolve({ status: 200, data: { ok: true } });
      }
      return original(url, ...rest);
    });
  }

  beforeEach(() => {
    process.env.NOTIFY_SMS_ENABLED   = 'true';
    process.env.NOTIFY_PUSH_ENABLED  = 'true';
    process.env.NOTIFY_EMAIL_ENABLED = 'true';
  });

  afterEach(() => {
    process.env.NOTIFY_SMS_ENABLED   = 'false';
    process.env.NOTIFY_PUSH_ENABLED  = 'false';
    process.env.NOTIFY_EMAIL_ENABLED = 'false';
    // Reset throttle env vars to zero (test default)
    process.env.NOTIFY_SMS_THROTTLE_MS   = '0';
    process.env.NOTIFY_PUSH_THROTTLE_MS  = '0';
    process.env.NOTIFY_EMAIL_THROTTLE_MS = '0';
  });

  test('first dispense always sends all channels', async () => {
    mockWithAll({ stockOnHand: 100 });

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    const smsCalls   = axios.post.mock.calls.filter(([url]) => url.includes('/sms'));
    const emailCalls = axios.post.mock.calls.filter(([url]) => url.includes('/email'));
    expect(smsCalls.length).toBe(1);
    expect(emailCalls.length).toBe(1);
  });

  test('second identical dispense is suppressed when throttle is active', async () => {
    process.env.NOTIFY_SMS_THROTTLE_MS   = '60000'; // 1-min cooldown
    process.env.NOTIFY_EMAIL_THROTTLE_MS = '60000';
    process.env.NOTIFY_PUSH_THROTTLE_MS  = '60000';

    // First dispense — should send
    mockWithAll({ stockOnHand: 100 });
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);
    await new Promise(resolve => setImmediate(resolve));

    const firstSms = axios.post.mock.calls.filter(([url]) => url.includes('/sms')).length;
    expect(firstSms).toBe(1);

    // Reset call history but keep cooldown state
    jest.resetAllMocks();
    mockWithAll({ stockOnHand: 100 });

    // Second identical dispense within cooldown — should be suppressed
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);
    await new Promise(resolve => setImmediate(resolve));

    const secondSms   = axios.post.mock.calls.filter(([url]) => url.includes('/sms')).length;
    const secondEmail = axios.post.mock.calls.filter(([url]) => url.includes('/email')).length;
    expect(secondSms).toBe(0);   // throttled
    expect(secondEmail).toBe(0); // throttled
  });

  test('different event types each get their own cooldown slot', async () => {
    process.env.NOTIFY_SMS_THROTTLE_MS = '60000';

    // Dispense first
    mockWithAll({ stockOnHand: 100 });
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);
    await new Promise(resolve => setImmediate(resolve));

    jest.resetAllMocks();
    mockWithAll({ stockOnHand: 100 });

    // Receipt (different event type) — should NOT be throttled
    const receiptBody = { ...FHIR_BODY, type: { coding: [{ code: 'RECEIPT' }] } };
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(receiptBody);
    await new Promise(resolve => setImmediate(resolve));

    const receiptSms = axios.post.mock.calls.filter(([url]) => url.includes('/sms')).length;
    expect(receiptSms).toBe(1); // different event type — not throttled
  });

  test('second dispense sends after cooldown expires', async () => {
    process.env.NOTIFY_SMS_THROTTLE_MS = '1'; // 1 ms — expires immediately

    mockWithAll({ stockOnHand: 100 });
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);
    await new Promise(resolve => setImmediate(resolve));

    jest.resetAllMocks();
    mockWithAll({ stockOnHand: 100 });

    // Wait for the 1 ms cooldown to expire
    await new Promise(resolve => setTimeout(resolve, 5));

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);
    await new Promise(resolve => setImmediate(resolve));

    const smsCalls = axios.post.mock.calls.filter(([url]) => url.includes('/sms')).length;
    expect(smsCalls).toBe(1); // cooldown expired — sent again
  });
});
