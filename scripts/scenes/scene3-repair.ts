// Scene 3 (v3-plan): after scene2-shaped state (P-101 broken, P-102/P-103
// at_risk), the repair agent retrieves precedents, proposes and links a
// replacement, and the graph rewires; P-101 stays broken. Run this script
// twice in a row: the second run must retrieve the precedent the first
// run recorded (accretion proof) -- resetDb here deliberately keeps the
// precedents table across invocations (everything else is fresh).
import path from 'node:path';
import { StyxAgent } from '../../agent/src/agent.js';
import { StyxClient } from '../../agent/src/client.js';
import { MemoryStore } from '../../agent/src/memory.js';
import { SessionStore } from '../../agent/src/store.js';
import { repairPolicy } from '../../agent/src/policies/repair.js';
import { cannedReason } from '../../agent/src/reason.js';
import { breakCommitment } from '../../agent/src/policies/breaker.js';
import { resetDb, seedAgent, startSceneKernel, ok, section, finish } from './lib.js';

const SCENE = 'scene3-repair';
// Fixed, not randomized: the situation text derived from this must be
// byte-identical across separate script invocations for the kernel's
// deterministic stub embedder (kernel/src/precedents.ts) to land the
// second run's search on the first run's precedent.
const SITUATION = `commitment for 'API endpoints' is at_risk: an upstream dependency broke`;

async function main(): Promise<void> {
  const kernel = await startSceneKernel();
  await resetDb(kernel.pool, { keepPrecedents: true });

  const coordinator = await seedAgent(kernel.pool, 'coordinator', 'buyer');
  const repairSeed = await seedAgent(kernel.pool, 'repair', 'repair');
  const client = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: coordinator.apiKey, agentName: 'setup-client' });

  section('seed P-101 -> P-102 -> P-103 and break P-101');
  const p101 = await client.createPromise({
    debtorAgentId: coordinator.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'schema migration', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p101',
  });
  await client.transition({ commitmentId: p101.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p101' });

  const p102 = await client.createPromise({
    debtorAgentId: coordinator.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'API endpoints', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p102',
  });
  await client.transition({ commitmentId: p102.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p102' });

  const p103 = await client.createPromise({
    debtorAgentId: coordinator.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'frontend wiring', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p103',
  });
  await client.transition({ commitmentId: p103.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p103' });

  await client.linkDependency({ commitmentId: p102.commitment.id, dependsOnId: p101.commitment.id });
  await client.linkDependency({ commitmentId: p103.commitment.id, dependsOnId: p102.commitment.id });

  await breakCommitment(client, p101.commitment.id, 'scene3 break');

  section('precedent search before repair (accretion check)');
  const before = await client.searchPrecedents(SITUATION, 10);
  console.log(`  found ${before.length} precedent(s) before repairing`);
  const isSecondRun = before.length > 0;
  console.log(`  ${isSecondRun ? 'ACCRETION: this looks like a second run, a prior precedent is already retrievable' : 'first run: no prior precedent yet'}`);

  section('repair agent wakes on P-102\'s at_risk, searches precedents, proposes+links+repairs');
  const repairAgent = new StyxAgent({
    name: repairSeed.name,
    agentId: repairSeed.id,
    client: new StyxClient({ baseUrl: kernel.baseUrl, apiKey: repairSeed.apiKey, agentName: repairSeed.name }),
    memory: new MemoryStore(path.join('.styx-agents-scenes', SCENE, repairSeed.name)),
    sessions: new SessionStore(path.join('.styx-agents-scenes', SCENE, repairSeed.name, 'session.db'), repairSeed.name),
    policy: repairPolicy({ reason: cannedReason }), // deterministic, no AWS required
  });
  await repairAgent.wake({ kind: 'at_risk', commitmentId: p102.commitment.id });

  section('assert final graph shape');
  const p101After = await client.getCommitment(p101.commitment.id);
  const p102After = await client.getCommitment(p102.commitment.id);
  const p103After = await client.getCommitment(p103.commitment.id);
  ok(p101After.status === 'broken', `P-101 stays broken, terminal (got ${p101After.status})`);
  ok(p102After.status === 'active', `P-102 is active again (got ${p102After.status})`);
  ok(p103After.status === 'active', `P-103 is active again (got ${p103After.status})`);

  const { rows: replacesEdges } = await kernel.pool.query<{ depends_on_id: string; status: string }>(
    `SELECT cd.depends_on_id, c.status FROM commitment_dependencies cd
     JOIN commitments c ON c.id = cd.depends_on_id
     WHERE cd.commitment_id = $1 AND cd.dependency_type = 'replaces'`,
    [p102.commitment.id],
  );
  ok(replacesEdges.length === 1, `P-102 has exactly one 'replaces' edge (P-104-equivalent) (found ${replacesEdges.length})`);
  ok(replacesEdges[0]?.status === 'active', `the replacement (P-104-equivalent) is active`);

  section('precedent recorded on settlement');
  const after = await client.searchPrecedents(SITUATION, 10);
  ok(after.length >= before.length + 1, `precedent count grew by at least one (before ${before.length}, after ${after.length})`);
  if (isSecondRun) {
    ok(before.length > 0, `ACCRETION PROVEN: this run retrieved a precedent recorded by an earlier run`);
  } else {
    console.log('  (run this script again to prove accretion: the second run should report ACCRETION PROVEN above)');
  }

  repairAgent.sessions.close();
  await kernel.close();
  finish(SCENE);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nFAIL: ${SCENE} (uncaught error)`);
  process.exit(1); // force exit: an open SSE connection or in-flight child process can otherwise keep the event loop alive
});
