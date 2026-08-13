// Scene 1 (v3-plan): two agents claim the same backlog task simultaneously;
// exactly one serializable transaction wins, the loser gets a typed
// ResourceConflict and takes the next task.
import path from 'node:path';
import { StyxAgent } from '../../agent/src/agent.js';
import { StyxClient } from '../../agent/src/client.js';
import { MemoryStore } from '../../agent/src/memory.js';
import { SessionStore } from '../../agent/src/store.js';
import { workerPolicy } from '../../agent/src/policies/worker.js';
import { resetDb, seedAgent, seedResource, startSceneKernel, ok, section, finish } from './lib.js';

const SCENE = 'scene1-conflict';

function makeWorker(baseUrl: string, name: string, agentId: string, apiKey: string, backlogTasks: string[]): StyxAgent {
  return new StyxAgent({
    name,
    agentId,
    client: new StyxClient({ baseUrl, apiKey, agentName: name }),
    memory: new MemoryStore(path.join('.styx-agents-scenes', SCENE, name)),
    sessions: new SessionStore(path.join('.styx-agents-scenes', SCENE, name, 'session.db'), name),
    policy: workerPolicy({ backlogTasks }),
  });
}

async function main(): Promise<void> {
  const kernel = await startSceneKernel();
  await resetDb(kernel.pool);

  const dispatcher = await seedAgent(kernel.pool, 'dispatcher', 'seller');
  await seedResource(kernel.pool, 'task:hotfix-42', 1, dispatcher.id);
  await seedResource(kernel.pool, 'task:hotfix-43', 1, dispatcher.id);

  const alice = await seedAgent(kernel.pool, 'alice-worker', 'worker');
  const bob = await seedAgent(kernel.pool, 'bob-worker', 'worker');
  const backlog = ['task:hotfix-42', 'task:hotfix-43'];
  const workerAlice = makeWorker(kernel.baseUrl, alice.name, alice.id, alice.apiKey, backlog);
  const workerBob = makeWorker(kernel.baseUrl, bob.name, bob.id, bob.apiKey, backlog);

  section('both workers claim simultaneously');
  await Promise.all([workerAlice.wake({ kind: 'poke' }), workerBob.wake({ kind: 'poke' })]);

  const { rows: hotfix42 } = await kernel.pool.query<{ status: string; debtor_agent_id: string }>(
    `SELECT status, debtor_agent_id FROM commitments WHERE resource_key = 'task:hotfix-42'`,
  );
  ok(hotfix42.length === 1, `exactly one reservation exists on task:hotfix-42 (found ${hotfix42.length})`);
  ok(hotfix42[0]?.status === 'active', `task:hotfix-42's reservation is active (got ${hotfix42[0]?.status})`);

  const winnerId = hotfix42[0]?.debtor_agent_id;
  const winner = winnerId === alice.id ? workerAlice : workerBob;
  const loser = winnerId === alice.id ? workerBob : workerAlice;
  const loserName = winnerId === alice.id ? bob.name : alice.name;
  console.log(`  winner: ${winnerId === alice.id ? alice.name : bob.name}, loser: ${loserName}`);

  const conflictNotes = loser.sessions.search('lost the claim race');
  ok(conflictNotes.length > 0, `the loser's session log records a lost claim race on task:hotfix-42`);
  const typedConflict = conflictNotes.some((n) => n.content.includes('RESOURCE_CONFLICT') || n.content.includes('requested'));
  ok(typedConflict, `the loser's note names the typed ResourceConflict (${conflictNotes[0]?.content ?? 'none'})`);

  const { rows: hotfix43 } = await kernel.pool.query<{ status: string; debtor_agent_id: string }>(
    `SELECT status, debtor_agent_id FROM commitments WHERE resource_key = 'task:hotfix-43'`,
  );
  ok(hotfix43.length === 1, `exactly one reservation exists on task:hotfix-43 (found ${hotfix43.length})`);
  ok(hotfix43[0]?.status === 'active', `task:hotfix-43's reservation is active`);
  const loserId = winnerId === alice.id ? bob.id : alice.id;
  ok(hotfix43[0]?.debtor_agent_id === loserId, `the loser claimed task:hotfix-43 instead`);

  ok(winner.sessions.search('claimed task:hotfix-42').length > 0, `the winner's session log records claiming task:hotfix-42`);

  for (const worker of [workerAlice, workerBob]) worker.sessions.close();
  await kernel.close();
  finish(SCENE);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nFAIL: ${SCENE} (uncaught error)`);
  process.exit(1); // force exit: an open SSE connection or in-flight child process can otherwise keep the event loop alive
});
