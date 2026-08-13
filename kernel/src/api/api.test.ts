import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makePool } from '../db/pool.js';
import { buildApp } from './app.js';

// kernel/test/fixtures.ts is outside this file's write boundary (kernel/src/api/),
// so this seeds its own small fixture rather than importing it.
const pool = makePool();
let app: FastifyInstance;
let baseUrl: string;

interface Agents {
  alice: { id: string; key: string };
  bob: { id: string; key: string };
  carol: { id: string; key: string };
}
let agents: Agents;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

async function resetAndSeed(): Promise<Agents> {
  await pool.query(
    'TRUNCATE commitment_events, commitment_dependencies, operation_results, commitments, resources, agents CASCADE',
  );
  const insert = async (name: string, kind: string): Promise<{ id: string; key: string }> => {
    const key = randomUUID();
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, kind, sha256(key)],
    );
    return { id: rows[0].id, key };
  };
  const alice = await insert('alice', 'buyer');
  const bob = await insert('bob', 'buyer');
  const carol = await insert('carol', 'seller');
  await pool.query('INSERT INTO resources (key, owner_agent, capacity) VALUES ($1, $2, 1)', [
    'task:build-auth',
    carol.id,
  ]);
  return { alice, bob, carol };
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

beforeAll(async () => {
  app = buildApp(pool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  agents = await resetAndSeed();
});

describe('auth', () => {
  it('rejects requests without an API key', async () => {
    const res = await fetch(`${baseUrl}/v1/agents/${agents.alice.id}/obligations`);
    expect(res.status).toBe(401);
  });

  it('rejects requests with a bad API key', async () => {
    const res = await fetch(`${baseUrl}/v1/agents/${agents.alice.id}/obligations`, {
      headers: { Authorization: 'Bearer not-a-real-key' },
    });
    expect(res.status).toBe(401);
  });
});

describe('create -> reserve -> transition happy path', () => {
  it('creates a promise, activates it, reserves a resource, and breaks the reservation', async () => {
    const createRes = await fetch(`${baseUrl}/v1/commitments`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        debtorAgentId: agents.alice.id,
        creditorAgentId: agents.carol.id,
        terms: { deliver: 'widget', deadline: '2026-12-01T00:00:00Z' },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.commitment.status).toBe('draft');
    expect(created.replayed).toBe(false);

    const activateRes = await fetch(`${baseUrl}/v1/commitments/${created.commitment.id}/transitions`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'activate', expectedVersion: 1 }),
    });
    expect(activateRes.status).toBe(200);
    const activated = await activateRes.json();
    expect(activated.commitment.status).toBe('active');

    const reserveRes = await fetch(`${baseUrl}/v1/reservations`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        debtorAgentId: agents.alice.id,
        creditorAgentId: agents.carol.id,
        terms: { resource: 'task:build-auth', quantity: 1 },
      }),
    });
    expect(reserveRes.status).toBe(201);
    const reserved = await reserveRes.json();
    expect(reserved.commitment.status).toBe('active');

    const breakRes = await fetch(`${baseUrl}/v1/commitments/${reserved.commitment.id}/transitions`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'break', expectedVersion: 1 }),
    });
    expect(breakRes.status).toBe(200);
    const broken = await breakRes.json();
    expect(broken.commitment.status).toBe('broken');

    const historyRes = await fetch(`${baseUrl}/v1/commitments/${reserved.commitment.id}/history`, {
      headers: authHeaders(agents.alice.key),
    });
    const history = await historyRes.json();
    expect(history).toHaveLength(2);
  });
});

describe('ResourceConflict shape', () => {
  it('returns the product-spec section 43 conflict object on 409', async () => {
    const first = await fetch(`${baseUrl}/v1/reservations`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        debtorAgentId: agents.alice.id,
        creditorAgentId: agents.carol.id,
        terms: { resource: 'task:build-auth', quantity: 1 },
      }),
    });
    expect(first.status).toBe(201);
    const firstCommitment = await first.json();

    const second = await fetch(`${baseUrl}/v1/reservations`, {
      method: 'POST',
      headers: { ...authHeaders(agents.bob.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        debtorAgentId: agents.bob.id,
        creditorAgentId: agents.carol.id,
        terms: { resource: 'task:build-auth', quantity: 1 },
      }),
    });
    expect(second.status).toBe(409);
    const conflict = await second.json();
    expect(conflict).toMatchObject({
      type: 'RESOURCE_CONFLICT',
      resource: 'task:build-auth',
      requested: { quantity: 1 },
      available: 0,
      conflicting_commitments: [firstCommitment.commitment.id],
      retryable: false,
      alternatives: { search_precedents: true },
    });
  });
});

describe('SSE', () => {
  it('delivers a transition within 2s', async () => {
    const createRes = await fetch(`${baseUrl}/v1/commitments`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        debtorAgentId: agents.alice.id,
        creditorAgentId: agents.carol.id,
        terms: { deliver: 'widget', deadline: '2026-12-01T00:00:00Z' },
      }),
    });
    const created = await createRes.json();

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/v1/events`, {
      headers: authHeaders(agents.alice.key),
      signal: controller.signal,
    });
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    // drain the initial "connected" comment/event before triggering the write
    await reader.read();

    await fetch(`${baseUrl}/v1/commitments/${created.commitment.id}/transitions`, {
      method: 'POST',
      headers: { ...authHeaders(agents.alice.key), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action: 'activate', expectedVersion: 1 }),
    });

    const deadline = Date.now() + 2000;
    let buffer = '';
    let sawActivated = false;
    while (Date.now() < deadline && !sawActivated) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"event_type":"activated"')) sawActivated = true;
    }

    controller.abort();
    expect(sawActivated).toBe(true);
  });
});
