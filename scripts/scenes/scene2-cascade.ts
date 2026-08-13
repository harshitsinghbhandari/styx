// Scene 2 (v3-plan): BREAK P-101; one transaction flags P-102 and P-103
// at_risk; the changefeed-equivalent (here, the kernel's own SSE stream)
// wakes their owners.
import path from 'node:path';
import { StyxAgent } from '../../agent/src/agent.js';
import { StyxClient } from '../../agent/src/client.js';
import { MemoryStore } from '../../agent/src/memory.js';
import { SessionStore } from '../../agent/src/store.js';
import { workerPolicy } from '../../agent/src/policies/worker.js';
import { breakCommitment } from '../../agent/src/policies/breaker.js';
import { startRelay } from '../../agent/src/relay.js';
import { resetDb, seedAgent, startSceneKernel, ok, section, finish, waitFor } from './lib.js';

const SCENE = 'scene2-cascade';
// Deliberately no repair-role agent in this scene's fleet: scene2 is the
// cascade beat only (v1-spec section 16 / v3-plan scene 2), repairing is
// scene3's beat. Registering a repair agent here would race this script's
// own at_risk assertions against the relay's own auto-repair, which reads
// misleadingly as flakiness rather than what it actually is (two scenes'
// concerns overlapping in one fleet).

function makeAgent(baseUrl: string, name: string, agentId: string, apiKey: string, policy: ReturnType<typeof workerPolicy>): StyxAgent {
  return new StyxAgent({
    name,
    agentId,
    client: new StyxClient({ baseUrl, apiKey, agentName: name }),
    memory: new MemoryStore(path.join('.styx-agents-scenes', SCENE, name)),
    sessions: new SessionStore(path.join('.styx-agents-scenes', SCENE, name, 'session.db'), name),
    policy,
  });
}

async function main(): Promise<void> {
  const kernel = await startSceneKernel();
  await resetDb(kernel.pool);

  const coordinator = await seedAgent(kernel.pool, 'coordinator', 'buyer');
  const ownerP102 = await seedAgent(kernel.pool, 'owner-p102', 'worker');
  const ownerP103 = await seedAgent(kernel.pool, 'owner-p103', 'worker');

  const agentP102 = makeAgent(kernel.baseUrl, ownerP102.name, ownerP102.id, ownerP102.apiKey, workerPolicy({ backlogTasks: [] }));
  const agentP103 = makeAgent(kernel.baseUrl, ownerP103.name, ownerP103.id, ownerP103.apiKey, workerPolicy({ backlogTasks: [] }));

  const agentsById = new Map([
    [ownerP102.id, agentP102],
    [ownerP103.id, agentP103],
  ]);
  const relayClient = new StyxClient({ baseUrl: kernel.baseUrl, apiKey: coordinator.apiKey, agentName: 'relay-client' });
  const relay = startRelay({ client: relayClient, agentsById, repairAgents: [] });

  section('seed chain P-101 -> P-102 -> P-103');
  const p101 = await relayClient.createPromise({
    debtorAgentId: coordinator.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'schema migration', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p101',
  });
  await relayClient.transition({ commitmentId: p101.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p101' });

  // Activate requires the debtor role (kernel/src/transition.ts): P-102 and
  // P-103's own owners must activate their own commitments, the
  // coordinator's relayClient can only activate the ones it is debtor of.
  const p102 = await relayClient.createPromise({
    debtorAgentId: ownerP102.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'API endpoints', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p102',
  });
  await agentP102.client.transition({ commitmentId: p102.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p102' });

  const p103 = await relayClient.createPromise({
    debtorAgentId: ownerP103.id,
    creditorAgentId: coordinator.id,
    terms: { deliver: 'frontend wiring', deadline: '2099-01-01T00:00:00Z' },
    mission: 'p103',
  });
  await agentP103.client.transition({ commitmentId: p103.commitment.id, action: 'activate', expectedVersion: 1, mission: 'p103' });

  await relayClient.linkDependency({ commitmentId: p102.commitment.id, dependsOnId: p101.commitment.id });
  await relayClient.linkDependency({ commitmentId: p103.commitment.id, dependsOnId: p102.commitment.id });

  section('break P-101');
  await breakCommitment(relayClient, p101.commitment.id, 'scene2 break');

  const p101After = await relayClient.getCommitment(p101.commitment.id);
  ok(p101After.status === 'broken', `P-101 is broken (got ${p101After.status})`);

  const p102After = await relayClient.getCommitment(p102.commitment.id);
  const p103After = await relayClient.getCommitment(p103.commitment.id);
  ok(p102After.status === 'at_risk', `P-102 is at_risk (got ${p102After.status})`);
  ok(p103After.status === 'at_risk', `P-103 is at_risk (got ${p103After.status})`);

  const p102History = await relayClient.getHistory(p102.commitment.id);
  const p102Flags = p102History.filter((e) => e.event_type === 'flagged_at_risk');
  ok(p102Flags.length === 1, `P-102 has exactly one flagged_at_risk event (found ${p102Flags.length})`);
  ok(p102Flags[0]?.actor_agent_id === null, `P-102's flagged_at_risk event has actor null (the kernel's own cascade)`);

  const p103History = await relayClient.getHistory(p103.commitment.id);
  const p103Flags = p103History.filter((e) => e.event_type === 'flagged_at_risk');
  ok(p103Flags.length === 1, `P-103 has exactly one flagged_at_risk event (found ${p103Flags.length})`);

  section('the relay woke both owners');
  await waitFor(() => agentP102.sessions.search('at_risk').length > 0);
  await waitFor(() => agentP103.sessions.search('at_risk').length > 0);
  ok(agentP102.sessions.search('at_risk').length > 0, `owner-p102's session log shows an at_risk wake`);
  ok(agentP103.sessions.search('at_risk').length > 0, `owner-p103's session log shows an at_risk wake`);

  relay.stop();
  await relay.stopped;
  for (const a of [agentP102, agentP103]) a.sessions.close();
  await kernel.close();
  finish(SCENE);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nFAIL: ${SCENE} (uncaught error)`);
  process.exit(1); // force exit: an open SSE connection or in-flight child process can otherwise keep the event loop alive
});
