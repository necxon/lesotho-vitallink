'use strict';

// Per-VHW stock allocation route tests. Mocks the DB pool, OpenLMIS stock check,
// mappings and FHIR Task creation so the route logic is exercised deterministically
// with no real Postgres / OpenLMIS.

const express = require('express');
const request = require('supertest');

// In-memory allocations table backing the mocked pg pool.
let mockStore = [];

jest.mock('../src/db', () => ({
  facilityHasDelivery: jest.fn(async () => true), // facility has received a delivery by default
  recordFacilityDelivery: jest.fn(async () => {}),
  pool: {
    query: jest.fn(async (sql, params) => {
      if (/SUM\(allocated_qty - dispensed_qty\)/.test(sql)) {
        const [period, facilityId, medication] = params;
        const committed = mockStore
          .filter(r => r.period === period && r.facility_id === facilityId && r.medication === medication)
          .reduce((n, r) => n + (r.allocated_qty - r.dispensed_qty), 0);
        return { rows: [{ committed: String(committed) }] };
      }
      if (/^\s*INSERT INTO vhw_allocations/i.test(sql)) {
        const [period, facility_id, practitioner, medication, allocated_qty] = params;
        const existing = mockStore.find(r => r.period === period && r.practitioner === practitioner && r.medication === medication);
        if (existing) existing.allocated_qty += allocated_qty;
        else mockStore.push({ period, facility_id, practitioner, medication, allocated_qty, dispensed_qty: 0 });
        return { rows: [] };
      }
      if (/FROM vhw_allocations WHERE/i.test(sql) && /SELECT period/i.test(sql)) {
        const [period] = params;
        const facilityId = params[1];
        return {
          rows: mockStore
            .filter(r => r.period === period && (!facilityId || r.facility_id === facilityId))
            .map(r => ({ ...r, remaining_qty: r.allocated_qty - r.dispensed_qty })),
        };
      }
      return { rows: [] };
    }),
  },
}));

jest.mock('../src/integrations/openlmis', () => ({
  checkStock: jest.fn(async (_identity, qty) => ({ ok: qty <= 1000, stockOnHand: 1000 })),
}));


jest.mock('../src/tasks/tasks', () => ({
  createStockTask: jest.fn(async () => ({ status: 201 })),
}));

jest.mock('../src/mappings/mappings', () => ({
  PERFORMER_MAP: {
    'Practitioner/prac-thabo-mokoena': { role: 'vhw', facilityId: 'fac-1', programId: 'prog-1', name: 'Thabo' },
    'Practitioner/fw-1':               { role: 'facility_worker', facilityId: 'fac-1', programId: 'prog-1', name: 'FW' },
    'Practitioner/vhw-otherfac':       { role: 'vhw', facilityId: 'fac-2', programId: 'prog-1', name: 'Other' },
  },
  resolveOrderableId: (code) => (code === 'AL-20-120' ? 'orderable-1' : null),
  isKnownMedicineCode: (code) => code === 'AL-20-120',
  canonicalMed: (code) => code,
}));

const { checkStock } = require('../src/integrations/openlmis');
const { facilityHasDelivery } = require('../src/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/aggregate/stock', require('../src/routes/allocations'));
  return app;
}

beforeEach(() => { mockStore = []; checkStock.mockClear(); facilityHasDelivery.mockClear(); });

describe('POST /aggregate/stock/allocate', () => {
  const app = makeApp();

  test('allocates to a known VHW when stock is sufficient', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 50 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.allocatedQty).toBe(50);
    expect(res.body.remainingQty).toBe(50);
  });

  test('accepts the bare practitioner id (adds Practitioner/ prefix)', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'prac-thabo-mokoena', medication: 'AL-20-120', quantity: 10 });
    expect(res.status).toBe(200);
    expect(res.body.vhwId).toBe('Practitioner/prac-thabo-mokoena');
  });

  test('adds to an existing allocation for the same period', async () => {
    await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 30 });
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 20 });
    expect(res.body.allocatedQty).toBe(50);
  });

  test('rejects an unknown VHW', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/nope', medication: 'AL-20-120', quantity: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects allocating to a facility worker', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/fw-1', medication: 'AL-20-120', quantity: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown medication', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'NOPE', quantity: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects when facility stock cannot cover committed + requested', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 1001 });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('insufficient-facility-stock');
  });

  test('rejects non-positive quantity', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects facility worker / VHW at different facilities', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ facilityWorkerId: 'Practitioner/fw-1', vhwId: 'Practitioner/vhw-otherfac', medication: 'AL-20-120', quantity: 10 });
    expect(res.status).toBe(400);
  });

  // Token-derived facility scoping (caller identified by JWT sub, not request body).
  const jwtFor = (sub) => 'x.' + Buffer.from(JSON.stringify({ sub })).toString('base64') + '.y';

  test('caller token: facility worker blocked from allocating to another facility VHW (403)', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .set('Authorization', 'Bearer ' + jwtFor('fw-1'))     // fw-1 is facility_worker @ fac-1
      .send({ vhwId: 'Practitioner/vhw-otherfac', medication: 'AL-20-120', quantity: 10 }); // VHW @ fac-2
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('cross-facility');
  });

  test('caller token: facility worker can allocate to a VHW at their own facility', async () => {
    const res = await request(app).post('/aggregate/stock/allocate')
      .set('Authorization', 'Bearer ' + jwtFor('fw-1'))     // fac-1
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 10 }); // VHW @ fac-1
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('blocks allocation until a delivery is accepted at the facility', async () => {
    facilityHasDelivery.mockResolvedValueOnce(false); // no real delivery received yet
    const res = await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 10 });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('no-delivery-accepted');
  });
});

describe('GET /aggregate/stock/allocations', () => {
  const app = makeApp();

  test('lists allocations for the current period', async () => {
    await request(app).post('/aggregate/stock/allocate')
      .send({ vhwId: 'Practitioner/prac-thabo-mokoena', medication: 'AL-20-120', quantity: 40 });
    const res = await request(app).get('/aggregate/stock/allocations');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.allocations[0].remaining_qty).toBe(40);
  });
});
