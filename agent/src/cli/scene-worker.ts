// scene4-crash's child-process worker. Two subcommands, invoked as a
// real OS process (`tsx src/cli/scene-worker.ts <mode> ...`) so the scene
// can kill -9 it mid-claim and prove a fresh process for the SAME agent
// identity resumes cleanly:
//
//   claim  <baseUrl> <agentId> <apiKey> <agentName> <resourceKey>
//     Reserves resourceKey (the "mission"), prints CLAIMED <commitmentId>
//     to stdout, then blocks forever so the parent has a window to kill -9
//     it after the claim lands but before it would do anything else --
//     "mid-mission".
//
//   resume <baseUrl> <agentId> <apiKey> <agentName> <resourceKey>
//     Boots the SAME agent identity fresh, reads its obligations via the
//     API (what a real crash-recovered agent does first), finds the
//     still-active reservation, and re-attempts the identical claim. The
//     idempotency key ('<agent>:<mission>:<action>', client.ts) is
//     identical to the first process's, so this replays the stored result
//     rather than creating a second commitment -- the exit bar's "no
//     duplicate commitments exist" is this replay, not a separate check.
import path from 'node:path';
import { StyxAgent } from '../agent.js';
import { StyxClient } from '../client.js';
import { MemoryStore } from '../memory.js';
import { SessionStore } from '../store.js';
import { workerPolicy } from '../policies/worker.js';

function bootWorker(baseUrl: string, agentId: string, apiKey: string, agentName: string, resourceKey: string, memoryRoot: string): StyxAgent {
  return new StyxAgent({
    name: agentName,
    agentId,
    client: new StyxClient({ baseUrl, apiKey, agentName }),
    memory: new MemoryStore(path.join(memoryRoot, agentName)),
    sessions: new SessionStore(path.join(memoryRoot, agentName, 'session.db'), agentName),
    policy: workerPolicy({ backlogTasks: [resourceKey] }),
  });
}

async function main(): Promise<void> {
  const [mode, baseUrl, agentId, apiKey, agentName, resourceKey] = process.argv.slice(2);
  if (!mode || !baseUrl || !agentId || !apiKey || !agentName || !resourceKey) {
    console.error('usage: scene-worker.ts <claim|resume> <baseUrl> <agentId> <apiKey> <agentName> <resourceKey>');
    process.exit(1);
  }
  const memoryRoot = process.env.STYX_AGENT_MEMORY_ROOT ?? '.styx-agents';

  if (mode === 'claim') {
    const worker = bootWorker(baseUrl, agentId, apiKey, agentName, resourceKey, memoryRoot);
    await worker.wake({ kind: 'poke' });
    const client = new StyxClient({ baseUrl, apiKey, agentName });
    const obligations = await client.getObligations(agentId);
    const claimed = obligations.find((c) => c.resource_key === resourceKey);
    console.log(`CLAIMED ${claimed ? claimed.id : 'none'}`);
    // Block forever -- the parent kills -9 this process once it has read
    // the CLAIMED line, simulating a crash mid-mission (after the claim
    // lands, before the process would ever do anything else).
    await new Promise(() => {});
    return;
  }

  if (mode === 'resume') {
    const client = new StyxClient({ baseUrl, apiKey, agentName });
    const obligationsBefore = await client.getObligations(agentId);
    const found = obligationsBefore.find((c) => c.resource_key === resourceKey);
    console.log(`FOUND ${found ? found.id : 'none'}`);

    const worker = bootWorker(baseUrl, agentId, apiKey, agentName, resourceKey, memoryRoot);
    await worker.wake({ kind: 'poke' }); // idempotent replay of the original claim, not a new one

    const obligationsAfter = await client.getObligations(agentId);
    const afterClaim = obligationsAfter.filter((c) => c.resource_key === resourceKey);
    console.log(`RESUMED ${afterClaim.length} ${afterClaim.map((c) => c.id).join(',')}`);
    return;
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
