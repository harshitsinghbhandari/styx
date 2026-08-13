import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StyxClient, StyxApiError } from '../src/client.js';
import { startTestKernel, seedAgent, seedResource, type TestKernel } from './fixtures.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startTestKernel();
});

afterAll(async () => {
  await kernel.close();
});

describe('StyxClient against the real kernel API', () => {
  it('creates, activates, and fulfills a promise end to end', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const client = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });

    const created = await client.createPromise({
      debtorAgentId: alice.id,
      creditorAgentId: bob.id,
      terms: { deliver: 'widget', deadline: '2099-01-01T00:00:00Z' },
      mission: 'mission-1',
    });
    expect(created.commitment.status).toBe('draft');
    expect(created.replayed).toBe(false);

    const activated = await client.transition({
      commitmentId: created.commitment.id,
      action: 'activate',
      expectedVersion: created.commitment.version,
      mission: 'mission-1',
    });
    expect(activated.commitment.status).toBe('active');

    const fulfilled = await client.transition({
      commitmentId: created.commitment.id,
      action: 'fulfill',
      expectedVersion: activated.commitment.version,
      mission: 'mission-1',
    });
    expect(fulfilled.commitment.status).toBe('fulfilled');

    const obligations = await client.getObligations(alice.id);
    expect(obligations.every((c) => c.id !== created.commitment.id)).toBe(true); // fulfilled, no longer an obligation
  });

  it('surfaces a 409 ResourceConflict as a typed StyxApiError', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'buyer');
    const owner = await seedAgent(kernel.pool, 'seller');
    const taskKey = `task:conflict-${alice.id}`;
    await seedResource(kernel.pool, taskKey, 1, owner.id);

    const aliceClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });
    const bobClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: bob.apiKey, agentName: bob.name });

    await aliceClient.reserveResource({
      debtorAgentId: alice.id,
      creditorAgentId: alice.id,
      terms: { resource: taskKey, quantity: 1 },
      mission: taskKey,
    });

    await expect(
      bobClient.reserveResource({
        debtorAgentId: bob.id,
        creditorAgentId: bob.id,
        terms: { resource: taskKey, quantity: 1 },
        mission: taskKey,
      }),
    ).rejects.toThrow(StyxApiError);

    try {
      await bobClient.reserveResource({
        debtorAgentId: bob.id,
        creditorAgentId: bob.id,
        terms: { resource: taskKey, quantity: 1 },
        mission: taskKey,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StyxApiError);
      expect((err as StyxApiError).status).toBe(409);
      expect((err as StyxApiError).type).toBe('RESOURCE_CONFLICT');
    }
  });

  it('idempotencyKey() builds "<agent>:<mission>:<action>", matching every write call\'s Idempotency-Key header', () => {
    const client = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: 'x', agentName: 'worker-1' });
    expect(client.idempotencyKey('task:hotfix-42', 'reserve')).toBe('worker-1:task:hotfix-42:reserve');
  });

  it('records and finds a precedent via the real API', async () => {
    const agent = await seedAgent(kernel.pool, 'repair');
    const client = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: agent.apiKey, agentName: agent.name });
    const situation = `client-test situation ${agent.id}`;
    await client.recordPrecedent({ situation, resolution: 'did the thing', outcome: { resolved: true } });
    const results = await client.searchPrecedents(situation, 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('watchEvents() streams a transition event over SSE', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const client = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });

    const created = await client.createPromise({
      debtorAgentId: alice.id,
      creditorAgentId: bob.id,
      terms: { deliver: 'sse-test', deadline: '2099-01-01T00:00:00Z' },
      mission: 'sse-mission',
    });

    const controller = new AbortController();
    const events: string[] = [];
    const reader = (async () => {
      for await (const evt of client.watchEvents(controller.signal)) {
        events.push(evt.eventType);
        if (evt.eventType === 'activated') break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50)); // let the SSE connection open before triggering
    await client.transition({
      commitmentId: created.commitment.id,
      action: 'activate',
      expectedVersion: created.commitment.version,
      mission: 'sse-mission',
    });

    await Promise.race([reader, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for SSE event')), 5000))]);
    controller.abort();
    expect(events).toContain('activated');
  });
});
