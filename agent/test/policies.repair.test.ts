import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { StyxAgent } from '../src/agent.js';
import { StyxClient } from '../src/client.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/store.js';
import { repairPolicy } from '../src/policies/repair.js';
import { breakCommitment } from '../src/policies/breaker.js';
import { cannedReason } from '../src/reason.js';
import { startTestKernel, seedAgent, scratchDir, type TestKernel } from './fixtures.js';

let kernel: TestKernel;

beforeAll(async () => {
  kernel = await startTestKernel();
});

afterAll(async () => {
  await kernel.close();
});

function makeRepairAgent(name: string, agentId: string, apiKey: string): StyxAgent {
  const dir = scratchDir();
  return new StyxAgent({
    name,
    agentId,
    client: new StyxClient({ baseUrl: kernel.baseUrl, apiKey, agentName: name }),
    memory: new MemoryStore(path.join(dir, name)),
    sessions: new SessionStore(':memory:', name),
    policy: repairPolicy({ reason: cannedReason }),
  });
}

// `deliverSuffix` names the fixture in terms.deliver / precedent situation
// text and may repeat across calls (the accretion test needs identical
// situation text on both passes for the kernel's stub embedder to match).
// `missionSuffix` feeds the idempotency key and must be unique per call:
// this local database is never dropped between runs (test/global-setup.ts),
// so a repeated mission would replay the earlier call's stored commitments
// verbatim (same ids) instead of creating a fresh chain.
async function buildChain(
  client: StyxClient,
  alice: { id: string },
  bob: { id: string },
  deliverSuffix: string,
  missionSuffix: string = deliverSuffix,
) {
  const p101 = await client.createPromise({
    debtorAgentId: alice.id,
    creditorAgentId: bob.id,
    terms: { deliver: `schema migration ${deliverSuffix}`, deadline: '2099-01-01T00:00:00Z' },
    mission: `p101-${missionSuffix}`,
  });
  await client.transition({ commitmentId: p101.commitment.id, action: 'activate', expectedVersion: 1, mission: `p101-${missionSuffix}` });

  const p102 = await client.createPromise({
    debtorAgentId: alice.id,
    creditorAgentId: bob.id,
    terms: { deliver: `API endpoints ${deliverSuffix}`, deadline: '2099-01-01T00:00:00Z' },
    mission: `p102-${missionSuffix}`,
  });
  await client.transition({ commitmentId: p102.commitment.id, action: 'activate', expectedVersion: 1, mission: `p102-${missionSuffix}` });

  const p103 = await client.createPromise({
    debtorAgentId: alice.id,
    creditorAgentId: bob.id,
    terms: { deliver: `frontend wiring ${deliverSuffix}`, deadline: '2099-01-01T00:00:00Z' },
    mission: `p103-${missionSuffix}`,
  });
  await client.transition({ commitmentId: p103.commitment.id, action: 'activate', expectedVersion: 1, mission: `p103-${missionSuffix}` });

  await client.linkDependency({ commitmentId: p102.commitment.id, dependsOnId: p101.commitment.id });
  await client.linkDependency({ commitmentId: p103.commitment.id, dependsOnId: p102.commitment.id });

  return { p101: p101.commitment.id, p102: p102.commitment.id, p103: p103.commitment.id };
}

describe('repair policy: scene2/3 shape', () => {
  it('one at_risk wake on P-102 cascades to repair both P-102 and P-103, creates one replacement, and records a precedent', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const repairAgent = await seedAgent(kernel.pool, 'repair');
    const setupClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });

    const chain = await buildChain(setupClient, alice, bob, `cascade-${alice.id}`);
    await breakCommitment(setupClient, chain.p101, 'test-triggered break');

    const p102Before = await setupClient.getCommitment(chain.p102);
    const p103Before = await setupClient.getCommitment(chain.p103);
    expect(p102Before.status).toBe('at_risk');
    expect(p103Before.status).toBe('at_risk');

    const repair = makeRepairAgent(repairAgent.name, repairAgent.id, repairAgent.apiKey);
    await repair.wake({ kind: 'at_risk', commitmentId: chain.p102 });

    const p101After = await setupClient.getCommitment(chain.p101);
    const p102After = await setupClient.getCommitment(chain.p102);
    const p103After = await setupClient.getCommitment(chain.p103);
    expect(p101After.status).toBe('broken'); // stays broken, terminal
    expect(p102After.status).toBe('active');
    expect(p103After.status).toBe('active');

    // exactly one new replacement commitment was created (P-104-equivalent), linked as 'replaces'
    const { rows: replacesEdges } = await kernel.pool.query<{ depends_on_id: string }>(
      `SELECT depends_on_id FROM commitment_dependencies WHERE commitment_id = $1 AND dependency_type = 'replaces'`,
      [chain.p102],
    );
    expect(replacesEdges).toHaveLength(1);

    // P-103 was healed with no new edge: its only dependency link is still its original 'requires' -> P-102
    const { rows: p103Edges } = await kernel.pool.query<{ dependency_type: string; depends_on_id: string }>(
      `SELECT dependency_type, depends_on_id FROM commitment_dependencies WHERE commitment_id = $1`,
      [chain.p103],
    );
    expect(p103Edges).toEqual([{ dependency_type: 'requires', depends_on_id: chain.p102 }]);

    const searched = await setupClient.searchPrecedents(`commitment for 'API endpoints cascade-${alice.id}' is at_risk: an upstream dependency broke`, 5);
    expect(searched.length).toBeGreaterThan(0);
  });

  it('accretion: a second repair run on a fresh chain finds the precedent the first run recorded (same situation text)', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const repairAgent = await seedAgent(kernel.pool, 'repair');
    const setupClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });

    // Fixed deliver-suffix (not per-agent) so both passes describe the
    // exact same kind of break; the kernel's precedent search uses a
    // deterministic stub embedder (kernel/src/precedents.ts), so identical
    // situation text is what proves retrieval here, not semantic
    // similarity. missionSuffix is still unique per pass, see buildChain's
    // own comment for why.
    const suffix = 'accretion-fixture';
    const first = await buildChain(setupClient, alice, bob, suffix, `${suffix}-pass1-${alice.id}`);
    await breakCommitment(setupClient, first.p101, 'first pass');
    const repairOne = makeRepairAgent(repairAgent.name, repairAgent.id, repairAgent.apiKey);
    await repairOne.wake({ kind: 'at_risk', commitmentId: first.p102 });

    const firstSituation = `commitment for 'API endpoints ${suffix}' is at_risk: an upstream dependency broke`;
    const afterFirst = await setupClient.searchPrecedents(firstSituation, 5);
    expect(afterFirst.length).toBeGreaterThan(0);

    // Second pass: a fresh chain, same situation text, a fresh repair agent instance (simulating a new run).
    const second = await buildChain(setupClient, alice, bob, suffix, `${suffix}-pass2-${alice.id}`);
    await breakCommitment(setupClient, second.p101, 'second pass');
    const repairAgent2 = await seedAgent(kernel.pool, 'repair');
    const repairTwo = makeRepairAgent(repairAgent2.name, repairAgent2.id, repairAgent2.apiKey);

    await repairTwo.wake({ kind: 'at_risk', commitmentId: second.p102 });

    const foundPrecedentNote = repairTwo.sessions.search('searched precedents');
    expect(foundPrecedentNote.length).toBeGreaterThan(0);
    expect(foundPrecedentNote[0].content).toMatch(/found [1-9]\d*/); // at least the first pass's precedent came back

    const afterSecond = await setupClient.searchPrecedents(firstSituation, 5);
    expect(afterSecond.length).toBeGreaterThanOrEqual(afterFirst.length); // the corpus only grows
  });

  it('defers when the dependency is itself still at_risk (not yet resolved)', async () => {
    const alice = await seedAgent(kernel.pool, 'buyer');
    const bob = await seedAgent(kernel.pool, 'seller');
    const repairAgent = await seedAgent(kernel.pool, 'repair');
    const setupClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: alice.apiKey, agentName: alice.name });

    const chain = await buildChain(setupClient, alice, bob, `defer-${alice.id}`);
    await breakCommitment(setupClient, chain.p101, 'defer test');

    const repair = makeRepairAgent(repairAgent.name, repairAgent.id, repairAgent.apiKey);
    // Wake directly on P-103 before P-102 has been repaired: P-103's only
    // dependency (P-102) is itself still at_risk, so repair must defer.
    await repair.wake({ kind: 'at_risk', commitmentId: chain.p103 });

    const p103 = await setupClient.getCommitment(chain.p103);
    expect(p103.status).toBe('at_risk');
    const deferred = repair.sessions.search('deferring');
    expect(deferred.length).toBeGreaterThan(0);
  });
});
