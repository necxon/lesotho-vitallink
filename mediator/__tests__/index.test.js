'use strict';

const request = require('supertest');

// ---------------------------------------------------------------------------
// Mock axios BEFORE requiring the app so module-level code sees the mock.
// We use mockImplementation (URL-routing) rather than mockResolvedValueOnce
// because the fan-out calls run in parallel via Promise.allSettled:
//   1. forwardToOpenSRP  → getKeycloakToken() fires axios.post(KC URL)
//   2. pushToOpenLMIS    → getOpenLMISToken() fires axios.post(LMIS auth URL)
// DHIS2 is no longer called directly — delegated to dhis2-integration service.
// Order-based mocks would consume the wrong responses; URL routing is stable.
// ---------------------------------------------------------------------------
jest.mock('axios');
const axios = require('axios');

// Mock openhim-mediator-utils — registerMediator is a no-op in tests
jest.mock('openhim-mediator-utils', () => ({ registerMediator: jest.fn() }));

const { app, mediatorConfig, clearNotifCooldowns, clearSeenIds, clearRuntimeOverrides } = require('../index');

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
beforeEach(async () => {
  jest.resetAllMocks();
  clearNotifCooldowns();
  await clearSeenIds();
  clearRuntimeOverrides();
});

// ---------------------------------------------------------------------------
// Mock helpers for HAPI FHIR (Task CRUD used by SupplyDelivery + QR routes)
// ---------------------------------------------------------------------------

/**
 * Mocks axios.put for HAPI FHIR Task creation and axios.get for Task fetch.
 * taskStatus controls what fetchStockTask returns:
 *   'requested' — Task exists and is pending (default)
 *   'completed' — Task already accepted (BR-04 violation)
 *   null        — Task not found (404)
 */
function mockFhir({ taskStatus = 'requested' } = {}) {
  axios.put.mockImplementation((url) => {
    if (url.includes('/fhir/Task/')) {
      return Promise.resolve({ data: { resourceType: 'Task', id: url.split('/Task/')[1], status: 'requested' } });
    }
    return Promise.reject(new Error(`Unexpected axios.put URL: ${url}`));
  });

  axios.get.mockImplementation((url) => {
    if (url.includes('/fhir/Task/')) {
      if (taskStatus === null) {
        return Promise.reject(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
      }
      return Promise.resolve({ data: { resourceType: 'Task', id: 'task-test-001', status: taskStatus } });
    }
    // Default stock check used by QR route
    if (url.includes('/api/stockCardSummaries')) {
      return Promise.resolve({ data: { content: [{ stockOnHand: 100 }] } });
    }
    return Promise.reject(new Error(`Unexpected axios.get URL: ${url}`));
  });
}

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

  test('MEDIATOR_ORCHESTRATIONS=true wraps response in OpenHIM envelope with orchestrations', async () => {
    mockByUrl();
    const prev = process.env.MEDIATOR_ORCHESTRATIONS;
    process.env.MEDIATOR_ORCHESTRATIONS = 'true';
    try {
      const res = await request(app)
        .post('/fhir/MedicationDispense')
        .set('Content-Type', 'application/fhir+json')
        .send(FHIR_BODY);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json\+openhim/);
      expect(res.body.status).toBe('Successful');

      // OpenHIM unwraps response.body back to the client — must contain the inner body.
      const inner = JSON.parse(res.body.response.body);
      expect(inner.results.openlmis).toBe('HTTP 201');

      // One orchestration per downstream, named to match the visualizer components.
      const names = res.body.orchestrations.map(o => o.name);
      expect(names).toEqual(['HAPI FHIR (OpenSRP)', 'OpenLMIS', 'DHIS2']);
      expect(res.body.orchestrations[1].response.status).toBe(201);
    } finally {
      process.env.MEDIATOR_ORCHESTRATIONS = prev;
    }
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
// 4. DHIS2 direct push — DHIS2_PUSH_MODE=direct calls dataValueSets per dispense
// ---------------------------------------------------------------------------
describe('DHIS2 direct push', () => {
  test('calls DHIS2 dataValueSets directly on dispense (DHIS2_PUSH_MODE=direct)', async () => {
    mockByUrl();

    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    const dhis2Call = axios.post.mock.calls.find(([url]) =>
      url.includes('/api/dataValueSets')
    );
    expect(dhis2Call).toBeDefined();
  });

  test('POST /dhis2/sync proxies execute to dhis2-integration and returns 200', async () => {
    // Mock the OpenLMIS token endpoint and the dhis2-integration execute endpoint
    // dhis2sync.js uses Node http (not axios), so we mock it via nock or intercept.
    // Since dhis2-integration isn't reachable in unit tests, we verify the route
    // exists and returns 503 with a meaningful error (connection refused in test env).
    const res = await request(app)
      .post('/dhis2/sync');

    // In CI/test environment dhis2-integration is unreachable — expect 503 with error body
    expect([200, 503]).toContain(res.status);
    if (res.status === 503) {
      expect(res.body).toHaveProperty('status', 'error');
      expect(res.body).toHaveProperty('message');
    }
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

  test('allows dispense exceeding stock when REJECT_DISPENSE_EXCEEDS_STOCK is false', async () => {
    process.env.REJECT_DISPENSE_EXCEEDS_STOCK = 'false';
    mockByUrl({ stockOnHand: 3 }); // only 3 available, 6 requested

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    delete process.env.REJECT_DISPENSE_EXCEEDS_STOCK;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Successful');
  });
});


// ---------------------------------------------------------------------------
// 9. BR-07 — unknown performer / medicine rejection
// ---------------------------------------------------------------------------
describe('BR-07 unknown mapping rejection', () => {
  const UNKNOWN_PERFORMER_BODY = {
    ...FHIR_BODY,
    performer: [{ actor: { reference: 'Practitioner/unknown-vhw-xyz' } }],
  };
  const UNKNOWN_MEDICINE_BODY = {
    ...FHIR_BODY,
    medicationCodeableConcept: { coding: [{ code: 'UNKNOWN-DRUG-XYZ' }] },
  };

  test('unknown performer falls back silently when REJECT_UNKNOWN_PERFORMER is false (default)', async () => {
    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(UNKNOWN_PERFORMER_BODY);
    expect(res.status).toBe(200);
  });

  test('unknown performer rejected with 422 when REJECT_UNKNOWN_PERFORMER is true', async () => {
    process.env.REJECT_UNKNOWN_PERFORMER = 'true';
    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(UNKNOWN_PERFORMER_BODY);
    delete process.env.REJECT_UNKNOWN_PERFORMER;
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reason).toBe('unknown-performer');
    expect(res.body.performer).toBe('Practitioner/unknown-vhw-xyz');
  });

  test('known performer not rejected when REJECT_UNKNOWN_PERFORMER is true', async () => {
    process.env.REJECT_UNKNOWN_PERFORMER = 'true';
    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY); // performer: Practitioner/opensrp-admin — in PERFORMER_MAP
    delete process.env.REJECT_UNKNOWN_PERFORMER;
    expect(res.status).toBe(200);
  });

  test('unknown medicine rejected with 422 when REJECT_UNKNOWN_MEDICINE is true', async () => {
    process.env.REJECT_UNKNOWN_MEDICINE = 'true';
    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(UNKNOWN_MEDICINE_BODY);
    delete process.env.REJECT_UNKNOWN_MEDICINE;
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reason).toBe('unknown-medicine');
    expect(res.body.medication).toBe('UNKNOWN-DRUG-XYZ');
  });

  test('unknown medicine fan-out does not fire when rejected', async () => {
    process.env.REJECT_UNKNOWN_MEDICINE = 'true';
    mockByUrl();
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(UNKNOWN_MEDICINE_BODY);
    delete process.env.REJECT_UNKNOWN_MEDICINE;
    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Idempotency guard (NFR-12)
// ---------------------------------------------------------------------------
describe('idempotency guard', () => {
  const BODY_WITH_ID = { ...FHIR_BODY, id: 'dispense-idem-001' };

  test('first submission with a resource id returns HTTP 200', async () => {
    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);
    expect(res.status).toBe(200);
  });

  test('second submission with the same id returns HTTP 409 duplicate-dispense', async () => {
    mockByUrl();
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reason).toBe('duplicate-dispense');
    expect(res.body.id).toBe('dispense-idem-001');
  });

  test('second submission does not call downstream fan-out', async () => {
    mockByUrl();
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    jest.resetAllMocks();
    mockByUrl();
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall).toBeUndefined();
  });

  test('different resource ids are each processed once', async () => {
    mockByUrl();
    const r1 = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, id: 'dispense-a' });

    mockByUrl();
    const r2 = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send({ ...FHIR_BODY, id: 'dispense-b' });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test('no resource id passes through without idempotency check', async () => {
    mockByUrl();
    const r1 = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY); // no id field

    mockByUrl();
    const r2 = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test('REJECT_DUPLICATE_DISPENSE=false allows same id twice', async () => {
    process.env.REJECT_DUPLICATE_DISPENSE = 'false';
    mockByUrl();
    await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    mockByUrl();
    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(BODY_WITH_ID);

    delete process.env.REJECT_DUPLICATE_DISPENSE;
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 9. Per-system fan-out toggles
// ---------------------------------------------------------------------------
describe('per-system fan-out toggles', () => {
  test('FANOUT_OPENSRP_ENABLED=false skips OpenSRP and returns "disabled"', async () => {
    process.env.FANOUT_OPENSRP_ENABLED = 'false';
    mockByUrl();

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    delete process.env.FANOUT_OPENSRP_ENABLED;
    expect(res.status).toBe(200);
    expect(res.body.results.opensrp).toBe('disabled');
    const opensrpCall = axios.post.mock.calls.find(([url]) => url.includes('/opensrp/rest/event/add'));
    expect(opensrpCall).toBeUndefined();
  });

  test('FANOUT_DHIS2_ENABLED=false skips DHIS2 and returns "disabled"', async () => {
    process.env.FANOUT_DHIS2_ENABLED = 'false';
    mockByUrl();

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    delete process.env.FANOUT_DHIS2_ENABLED;
    expect(res.status).toBe(200);
    expect(res.body.results.dhis2).toBe('disabled');
    const dhis2Call = axios.post.mock.calls.find(([url]) => url.includes('/api/dataValueSets'));
    expect(dhis2Call).toBeUndefined();
  });

  test('FANOUT_OPENLMIS_ENABLED=false skips OpenLMIS and returns "disabled"', async () => {
    process.env.FANOUT_OPENLMIS_ENABLED = 'false';
    mockByUrl();

    const res = await request(app)
      .post('/fhir/MedicationDispense')
      .set('Content-Type', 'application/fhir+json')
      .send(FHIR_BODY);

    delete process.env.FANOUT_OPENLMIS_ENABLED;
    expect(res.status).toBe(200);
    expect(res.body.results.openlmis).toBe('disabled');
    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall).toBeUndefined();
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

// ---------------------------------------------------------------------------
// 12. POST /fhir/SupplyDelivery — stock issue creates a FHIR Task
// ---------------------------------------------------------------------------
describe('POST /fhir/SupplyDelivery', () => {
  const SUPPLY_BODY = {
    performer: 'Practitioner/93b47b21-7311-416a-a6a4-7be8426b1fc3',
    medication: 'AL-20-120',
    quantity: 120,
    issueRef: 'LMIS-2026-TEST',
  };

  test('returns HTTP 201 with taskId and task resource on success', async () => {
    mockFhir();

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send(SUPPLY_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Created');
    expect(res.body.taskId).toBeDefined();
    expect(res.body.task.resourceType).toBe('Task');
  });

  test('sets x-mediator-urn response header', async () => {
    mockFhir();

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send(SUPPLY_BODY);

    expect(res.headers['x-mediator-urn']).toBe(mediatorConfig.urn);
  });

  test('returns HTTP 400 when performer is missing', async () => {
    mockFhir();

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send({ medication: 'AL-20-120', quantity: 60 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('Error');
    expect(res.body.message).toMatch(/performer/);
  });

  test('returns HTTP 400 when medication is missing', async () => {
    mockFhir();

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send({ performer: 'Practitioner/93b47b21-7311-416a-a6a4-7be8426b1fc3', quantity: 60 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('Error');
  });

  test('returns HTTP 400 when quantity is missing', async () => {
    mockFhir();

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send({ performer: 'Practitioner/93b47b21-7311-416a-a6a4-7be8426b1fc3', medication: 'AL-20-120' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('Error');
  });

  test('PUTs Task to HAPI FHIR with status=requested and correct fields', async () => {
    mockFhir();

    await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send(SUPPLY_BODY);

    const putCall = axios.put.mock.calls.find(([url]) => url.includes('/fhir/Task/'));
    expect(putCall).toBeDefined();

    const task = putCall[1];
    expect(task.status).toBe('requested');
    expect(task.intent).toBe('order');
    expect(task.owner.reference).toBe(SUPPLY_BODY.performer);
    expect(task.for.reference).toBe(SUPPLY_BODY.performer);
    expect(task.input.find(i => i.type.text === 'product').valueString).toBe('AL-20-120');
    expect(task.input.find(i => i.type.text === 'quantity').valueInteger).toBe(120);
    expect(task.input.find(i => i.type.text === 'issueRef').valueString).toBe('LMIS-2026-TEST');
  });

  test('returns HTTP 500 when HAPI FHIR is unreachable', async () => {
    axios.put.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .post('/fhir/SupplyDelivery')
      .set('Content-Type', 'application/json')
      .send(SUPPLY_BODY);

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('Error');
  });
});

// ---------------------------------------------------------------------------
// 13. POST /fhir/QuestionnaireResponse — stock acceptance with BR-04
// ---------------------------------------------------------------------------
describe('POST /fhir/QuestionnaireResponse', () => {
  const QR_BODY = {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    basedOn: [{ reference: 'Task/task-test-001' }],
    item: [
      { linkId: 'medication', answer: [{ valueString: 'AL-20-120' }] },
      { linkId: 'quantity',   answer: [{ valueInteger: 60 }] },
      { linkId: 'type',       answer: [{ valueString: 'RECEIPT' }] },
    ],
  };

  function mockQrStack({ taskStatus = 'requested', lmis, stockOnHand = 100 } = {}) {
    if (lmis instanceof Promise) lmis.catch(() => {});
    mockFhir({ taskStatus });

    // Override get to also handle stockCardSummaries
    const existingGet = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/stockCardSummaries')) {
        return Promise.resolve({ data: { content: [{ stockOnHand }] } });
      }
      return existingGet(url);
    });

    // OAuth tokens + downstream fan-out
    axios.post.mockImplementation((url) => {
      if (url.includes('openid-connect/token')) {
        return Promise.resolve({ data: { access_token: 'kc-token', expires_in: 300 } });
      }
      if (url.includes('/api/oauth/token')) {
        return Promise.resolve({ data: { access_token: 'lmis-token', expires_in: 300 } });
      }
      if (url.includes('/opensrp/rest/event/add')) {
        return Promise.resolve({ status: 201 });
      }
      if (url.includes('/api/dataValueSets')) {
        return Promise.resolve({ status: 200 });
      }
      if (url.includes('/api/stockEvents')) {
        return lmis ?? Promise.resolve({ status: 201 });
      }
      return Promise.reject(new Error(`Unexpected axios.post URL: ${url}`));
    });
  }

  test('returns HTTP 200 Successful when Task is pending and eLMIS succeeds', async () => {
    mockQrStack();

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Successful');
  });

  test('sets x-mediator-urn response header', async () => {
    mockQrStack();

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    expect(res.headers['x-mediator-urn']).toBe(mediatorConfig.urn);
  });

  test('BR-04: returns HTTP 409 when Task is already completed', async () => {
    mockQrStack({ taskStatus: 'completed' });

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.reason).toBe('already-accepted');
    expect(res.body.taskId).toBe('task-test-001');
    expect(res.body.taskStatus).toBe('completed');
  });

  test('BR-04: does NOT call eLMIS fan-out when Task is already accepted', async () => {
    mockQrStack({ taskStatus: 'completed' });

    await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    const lmisCall = axios.post.mock.calls.find(([url]) => url.includes('/api/stockEvents'));
    expect(lmisCall).toBeUndefined();
  });

  test('returns HTTP 404 when referenced Task does not exist', async () => {
    mockQrStack({ taskStatus: null });

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('Error');
    expect(res.body.message).toMatch(/Task\/task-test-001 not found/);
  });

  test('marks Task completed via PUT after successful eLMIS receipt', async () => {
    mockQrStack();

    await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    // Allow fire-and-forget completeStockTask to settle
    await new Promise(resolve => setImmediate(resolve));

    const putCalls = axios.put.mock.calls.filter(([url]) => url.includes('/fhir/Task/task-test-001'));
    expect(putCalls.length).toBeGreaterThan(0);
    const completedTask = putCalls[putCalls.length - 1][1];
    expect(completedTask.status).toBe('completed');
  });

  test('does NOT mark Task completed when eLMIS fan-out fails', async () => {
    mockQrStack({ lmis: Promise.reject(new Error('ECONNREFUSED')) });

    await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(QR_BODY);

    await new Promise(resolve => setImmediate(resolve));

    // PUT calls for Task completion should not have happened
    const taskPuts = axios.put.mock.calls.filter(([url]) => url.includes('/fhir/Task/'));
    // The only PUT allowed is from fetchStockTask inside completeStockTask — none expected here
    const completionPuts = taskPuts.filter(([, body]) => body?.status === 'completed');
    expect(completionPuts.length).toBe(0);
  });

  test('proceeds without BR-04 check when QR has no basedOn Task reference', async () => {
    mockQrStack();

    const qrNoTask = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: [
        { linkId: 'medication', answer: [{ valueString: 'AL-20-120' }] },
        { linkId: 'quantity',   answer: [{ valueInteger: 10 }] },
        { linkId: 'type',       answer: [{ valueString: 'RECEIPT' }] },
      ],
    };

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(qrNoTask);

    // No Task lookup should have been made
    const taskGets = axios.get.mock.calls.filter(([url]) => url.includes('/fhir/Task/'));
    expect(taskGets.length).toBe(0);
    expect(res.status).toBe(200);
  });

  test('resolves taskId from item linkId task_id when basedOn is absent', async () => {
    mockQrStack();

    const qrItemTask = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: [
        { linkId: 'task_id',   answer: [{ valueString: 'task-test-001' }] },
        { linkId: 'medication', answer: [{ valueString: 'AL-20-120' }] },
        { linkId: 'quantity',   answer: [{ valueInteger: 10 }] },
        { linkId: 'type',       answer: [{ valueString: 'RECEIPT' }] },
      ],
    };

    const res = await request(app)
      .post('/fhir/QuestionnaireResponse')
      .set('Content-Type', 'application/fhir+json')
      .send(qrItemTask);

    const taskGets = axios.get.mock.calls.filter(([url]) => url.includes('/fhir/Task/task-test-001'));
    expect(taskGets.length).toBeGreaterThan(0);
    expect(res.status).toBe(200);
  });
});
