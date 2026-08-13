import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { StyxAgent } from '../src/agent.js';
import { StyxClient } from '../src/client.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/store.js';
import { workerPolicy } from '../src/policies/worker.js';
import { repairPolicy } from '../src/policies/repair.js';
import { breakCommitment } from '../src/policies/breaker.js';
import { startRelay } from '../src/relay.js';
import { startTestKernel, seedAgent, scratchDir, type TestKernel } from './fixtures.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startTestKernel();
});

afterAll(async () => {
  await kernel.close();
});

function makeAgent(name: string, agentId: string, apiKey: string, policy: ReturnType<typeof workerPolicy> | ReturnType<typeof repairPolicy>): StyxAgent {
  const dir = scratchDir();
  return new StyxAgent({
    name,
    agentId,
    client: new StyxClient({ baseUrl: kernel.baseUrl, apiKey, agentName: name }),
    memory: new MemoryStore(path.join(dir, name)),
    sessions: new SessionStore(':memory:', name),
    policy,
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('relay: SSE events wake the right fleet members', () => {
  it('flagged_at_risk wakes both the commitment\'s own debtor and every repair-role agent', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const repairSeed = await seedAgent(kernel.pool, 'repair');
    const relayClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: 'relay-client' });

    // A no-op worker standing in as the "owner" of the at_risk commitment, so we can assert it got woken too.
    const owner = makeAgent(alice.name, alice.id, alice.apiKey, workerPolicy({ backlogTasks: [] }));
    const repairAgent = makeAgent(repairSeed.name, repairSeed.id, repairSeed.apiKey, repairPolicy());

    const agentsById = new Map([
      [alice.id, owner],
      [repairSeed.id, repairAgent],
    ]);
    const relay = startRelay({ client: relayClient, agentsById, repairAgents: [repairAgent] });

    // Mission strings feed the idempotency key ('<agent>:<mission>:<action>',
    // client.ts). They must be unique per test run: this local database is
    // never dropped between runs (test/global-setup.ts), so a fixed mission
    // string would replay a much earlier run's stored commitment verbatim
    // instead of creating a fresh one.
    const missionRoot = `relay-root-${alice.id}`;
    const missionDependent = `relay-dependent-${alice.id}`;

    const p101 = await relayClient.createPromise({
      debtorAgentId: alice.id,
      creditorAgentId: bob.id,
      terms: { deliver: 'relay-root', deadline: '2099-01-01T00:00:00Z' },
      mission: missionRoot,
    });
    await relayClient.transition({ commitmentId: p101.commitment.id, action: 'activate', expectedVersion: 1, mission: missionRoot });

    const p102 = await relayClient.createPromise({
      debtorAgentId: alice.id,
      creditorAgentId: bob.id,
      terms: { deliver: 'relay-dependent', deadline: '2099-01-01T00:00:00Z' },
      mission: missionDependent,
    });
    await relayClient.transition({ commitmentId: p102.commitment.id, action: 'activate', expectedVersion: 1, mission: missionDependent });
    await relayClient.linkDependency({ commitmentId: p102.commitment.id, dependsOnId: p101.commitment.id });

    await breakCommitment(relayClient, p101.commitment.id, 'relay test break');

    await waitFor(() => repairAgent.sessions.recentSessions().length > 0);
    await waitFor(() => owner.sessions.recentSessions().length > 0);

    const repairWakes = repairAgent.sessions.search('at_risk');
    expect(repairWakes.length).toBeGreaterThan(0);

    relay.stop();
    await relay.stopped;
  });
});
