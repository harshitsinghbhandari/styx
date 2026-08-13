// The fleet host: boots N agents plus the wake relay in one process from a
// YAML roster. Agent identities (kernel agent id + API key) are provisioned
// by whoever seeds the database (scripts/scenes/*) and simply named in the
// roster; fleet.ts does no provisioning of its own, it only instantiates
// StyxAgent objects and wires the relay across them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { StyxAgent } from './agent.js';
import { StyxClient } from './client.js';
import { MemoryStore } from './memory.js';
import { SessionStore } from './store.js';
import { workerPolicy } from './policies/worker.js';
import { repairPolicy } from './policies/repair.js';
import { startRelay, type Relay } from './relay.js';

export interface RosterAgentEntry {
  name: string;
  kernelAgentId: string;
  apiKey: string;
  role: 'worker' | 'repair';
  /** worker role only: ordered backlog task resource keys to attempt on every wake. */
  backlogTasks?: string[];
}

export interface Roster {
  kernelApiUrl?: string;
  /** Root dir each agent's `.styx-agents/<name>/` lives under. Defaults to '.styx-agents'. */
  memoryRoot?: string;
  agents: RosterAgentEntry[];
}

export function loadRoster(rosterPath: string): Roster {
  const doc = load(readFileSync(rosterPath, 'utf8')) as Roster;
  if (!doc || !Array.isArray(doc.agents)) {
    throw new Error(`roster ${rosterPath} must be a YAML mapping with an 'agents' list`);
  }
  return doc;
}

function policyFor(entry: RosterAgentEntry) {
  if (entry.role === 'worker') return workerPolicy({ backlogTasks: entry.backlogTasks ?? [] });
  if (entry.role === 'repair') return repairPolicy();
  throw new Error(`unknown role '${entry.role}' for roster entry ${entry.name}`);
}

export function bootAgent(entry: RosterAgentEntry, roster: Roster): StyxAgent {
  const memoryRoot = roster.memoryRoot ?? '.styx-agents';
  const client = new StyxClient({ baseUrl: roster.kernelApiUrl, apiKey: entry.apiKey, agentName: entry.name });
  const memory = new MemoryStore(path.join(memoryRoot, entry.name));
  const sessions = new SessionStore(path.join(memoryRoot, entry.name, 'session.db'), entry.name);
  return new StyxAgent({ name: entry.name, agentId: entry.kernelAgentId, client, memory, sessions, policy: policyFor(entry) });
}

export interface Fleet {
  agents: StyxAgent[];
  agentsByName: Map<string, StyxAgent>;
  relay: Relay;
  stop(): Promise<void>;
}

export async function bootFleet(roster: Roster): Promise<Fleet> {
  if (roster.agents.length === 0) {
    throw new Error('roster has no agents');
  }
  const agents: StyxAgent[] = [];
  const agentsById = new Map<string, StyxAgent>();
  const agentsByName = new Map<string, StyxAgent>();
  const repairAgents: StyxAgent[] = [];

  for (const entry of roster.agents) {
    const agent = bootAgent(entry, roster);
    agents.push(agent);
    agentsById.set(entry.kernelAgentId, agent);
    agentsByName.set(entry.name, agent);
    if (entry.role === 'repair') repairAgents.push(agent);
  }

  // Any one fleet member's client can open the SSE stream: GET /v1/events
  // delivers every commitment event regardless of who is asking, auth just
  // gates "some agent", not "this agent's own events" (kernel/src/api/sse.ts).
  const relay = startRelay({ client: agents[0].client, agentsById, repairAgents });

  return {
    agents,
    agentsByName,
    relay,
    async stop() {
      relay.stop();
      await relay.stopped;
      for (const agent of agents) agent.sessions.close();
    },
  };
}

async function main(): Promise<void> {
  const rosterPath = process.argv[2];
  if (!rosterPath) {
    console.error('usage: fleet.ts <roster.yaml>');
    process.exit(1);
  }
  const roster = loadRoster(rosterPath);
  const fleet = await bootFleet(roster);
  console.log(`fleet up: ${fleet.agents.map((a) => a.name).join(', ')}`);
  process.on('SIGINT', () => {
    void fleet.stop().then(() => process.exit(0));
  });
}

// Only run as a CLI when invoked directly (`tsx src/fleet.ts roster.yaml`), not on import.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
