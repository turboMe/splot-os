---
name: integration-testing
category: coding
description: >-
  Patterns for writing integration tests — API endpoint testing,
  database fixtures, service mocking, and test isolation.
  Covers Vitest/Jest patterns with MongoDB, Express/Fastify,
  and external API mocking strategies.
keywords: [testing, integration, api, database, mock, fixture, isolation, vitest, jest]
allowedTools: [shell_execute, fs_read_file, coding_write_file_tracked, coding_run_test]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1400
outputFormat: text
tags: [testing, integration, quality, coding]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Integration Testing Patterns

## Trigger
- "Write integration tests for this API"
- "Test the database layer"
- "Add tests for this service"
- After creating new API endpoints or service functions

## Test Framework Setup

### Vitest (preferred for Mastra)
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
```

### Test Setup (`tests/setup.ts`)
```typescript
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  // Clean all collections between tests
  const db = client.db();
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.collection(col.name).deleteMany({});
  }
});
```

## Patterns

### 1. API Endpoint Testing

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('POST /api/orders', () => {
  beforeEach(async () => {
    // Seed test data
    await db.collection('products').insertOne({
      _id: 'prod-1',
      name: 'Test Product',
      price: 10.00,
    });
  });

  it('creates order with valid data', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ productId: 'prod-1', quantity: 2 })
      .expect(201);

    expect(res.body).toMatchObject({
      productId: 'prod-1',
      quantity: 2,
      total: 20.00,
    });
  });

  it('rejects order with invalid product', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ productId: 'nonexistent', quantity: 1 })
      .expect(404);

    expect(res.body.error).toContain('Product not found');
  });

  it('rejects order with zero quantity', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ productId: 'prod-1', quantity: 0 })
      .expect(400);
  });
});
```

### 2. Database Layer Testing

```typescript
describe('OrderRepository', () => {
  it('saves and retrieves order', async () => {
    const repo = new OrderRepository(db);
    
    const order = await repo.create({
      productId: 'prod-1',
      quantity: 2,
      total: 20.00,
    });

    const found = await repo.findById(order._id);
    expect(found).toMatchObject({
      productId: 'prod-1',
      quantity: 2,
    });
  });

  it('handles duplicate key gracefully', async () => {
    const repo = new OrderRepository(db);
    await repo.create({ _id: 'dup-1', productId: 'p1', quantity: 1 });
    
    await expect(
      repo.create({ _id: 'dup-1', productId: 'p2', quantity: 1 })
    ).rejects.toThrow(/duplicate key/i);
  });
});
```

### 3. External API Mocking

```typescript
import { vi } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PaymentService', () => {
  it('processes payment via Stripe', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_123', status: 'succeeded' }),
    });

    const result = await paymentService.charge(10.00, 'tok_visa');
    
    expect(result.status).toBe('succeeded');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('stripe.com'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('handles payment failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: () => Promise.resolve('Card declined'),
    });

    await expect(
      paymentService.charge(10.00, 'tok_declined')
    ).rejects.toThrow('Card declined');
  });
});
```

### 4. Test Fixtures

```typescript
// tests/fixtures/orders.ts
export const validOrder = {
  productId: 'prod-1',
  quantity: 2,
  total: 20.00,
  status: 'pending',
};

export const completedOrder = {
  ...validOrder,
  status: 'completed',
  completedAt: new Date('2025-01-15'),
};

// Usage in tests
import { validOrder, completedOrder } from '../fixtures/orders';
```

## Test Isolation Rules

1. **Each test is independent** — no test depends on another test's side effects
2. **Clean state between tests** — `afterEach` clears DB
3. **Use in-memory DB** — `mongodb-memory-server` for speed
4. **Mock external services** — never call real APIs in tests
5. **Use unique IDs** — prevent cross-test collisions
6. **No shared mutable state** — reset mocks in `beforeEach`

## Running Tests

```bash
# Run all integration tests
npm test -- --run tests/integration/

# Run with coverage
npm test -- --coverage --run tests/integration/

# Run specific test
npm test -- --run tests/integration/orders.test.ts

# Watch mode
npm test -- tests/integration/
```

## Anti-Patterns

❌ Testing against production database
❌ Tests that pass only in specific order
❌ Mocking everything (test nothing real)
❌ No cleanup → flaky tests
❌ Asserting on exact timestamps
❌ Hardcoded ports that conflict

## Success Criteria
- Tests run in < 30s total
- Each test isolated (can run independently)
- External APIs mocked (no network in tests)
- Coverage > 80% for tested modules
- No flaky tests
