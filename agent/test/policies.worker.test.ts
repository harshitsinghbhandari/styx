import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { StyxAgent } from '../src/agent.js';
import { StyxClient } from '../src/client.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/store.js';
import { workerPolicy } from '../src/policies/worker.js';
import { startTestKernel, seedAgent, seedResource, scratchDir, type TestKernel } from './fixtures.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startTestKernel();
});

afterAll(async () => {
  await kernel.close();
});

function makeWorker(name: string, agentId: string, apiKey: string, backlogTasks: string[]): StyxAgent {
  const dir = scratchDir();
  return new StyxAgent({
    name,
    agentId,
    client: new StyxClient({ baseUrl: kernel.baseUrl, apiKey, agentName: name }),
    memory: new MemoryStore(path.join(dir, name)),
    sessions: new SessionStore(':memory:', name),
    policy: workerPolicy({ backlogTasks }),
  });
}

describe('worker policy: scene1 shape', () => {
  it('two workers racing one capacity-1 task: exactly one wins, the loser claims its fallback task instead', async () => {
    const owner = await seedAgent(kernel.pool, 'dispatcher');
    const shared = `task:hotfix-${owner.id}`;
    const fallbackForA = `task:fallback-a-${owner.id}`;
    const fallbackForB = `task:fallback-b-${owner.id}`;
    await seedResource(kernel.pool, shared, 1, owner.id);
    await seedResource(kernel.pool, fallbackForA, 1, owner.id);
    await seedResource(kernel.pool, fallbackForB, 1, owner.id);

    const a = await seedAgent(kernel.pool, 'worker');
    const b = await seedAgent(kernel.pool, 'worker');
    const workerA = makeWorker(a.name, a.id, a.apiKey, [shared, fallbackForA]);
    const workerB = makeWorker(b.name, b.id, b.apiKey, [shared, fallbackForB]);

    await Promise.all([workerA.wake({ kind: 'poke' }), workerB.wake({ kind: 'poke' })]);

    const { rows: sharedReservations } = await kernel.pool.query<{ status: string; debtor_agent_id: string }>(
      `SELECT status, debtor_agent_id FROM commitments WHERE resource_key = $1`,
      [shared],
    );
    expect(sharedReservations).toHaveLength(1);
    expect(sharedReservations[0].status).toBe('active'); // the winner's claim, durable

    const winnerId = sharedReservations[0].debtor_agent_id;
    const loserId = winnerId === a.id ? b.id : a.id;
    const loserFallback = loserId === a.id ? fallbackForA : fallbackForB;

    const { rows: fallbackReservations } = await kernel.pool.query<{ status: string }>(
      `SELECT status FROM commitments WHERE resource_key = $1 AND debtor_agent_id = $2`,
      [loserFallback, loserId],
    );
    expect(fallbackReservations).toHaveLength(1);
    expect(fallbackReservations[0].status).toBe('active');

    // the loser's session log names the typed conflict it hit
    const loserAgent = winnerId === a.id ? workerB : workerA;
    const conflictNotes = loserAgent.sessions.search('lost the claim race');
    expect(conflictNotes.length).toBeGreaterThan(0);
  });

  it('with no backlog tasks left to claim, notes it and does not throw', async () => {
    const a = await seedAgent(kernel.pool, 'worker');
    const worker = makeWorker(a.name, a.id, a.apiKey, []);
    await worker.wake({ kind: 'poke' });
    const notes = worker.sessions.search('no backlog task available');
    expect(notes.length).toBeGreaterThan(0);
  });
});
