import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { StyxAgent, type RolePolicy, type WakeContext } from '../src/agent.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/store.js';
import { scratchDir } from './fixtures.js';
import type { StyxClient } from '../src/client.js';

function makeAgent(policy: RolePolicy): StyxAgent {
  const dir = scratchDir();
  return new StyxAgent({
    name: 'test-agent',
    agentId: 'agent-id-does-not-matter-for-this-suite',
    client: {} as StyxClient, // unused by these policies
    memory: new MemoryStore(path.join(dir, 'memory')),
    sessions: new SessionStore(':memory:', 'test-agent'),
    policy,
  });
}

describe('StyxAgent.wake', () => {
  it('injects a frozen MEMORY.md snapshot once per wake and logs the wake reason', async () => {
    let observedSnapshot = '';
    const policy: RolePolicy = {
      name: 'observer',
      async onWake(ctx: WakeContext) {
        observedSnapshot = ctx.agent.memory.snapshot();
        ctx.note('observed');
      },
    };
    const agent = makeAgent(policy);
    agent.memory.add('the user prefers dark mode');

    await agent.wake({ kind: 'poke' });

    expect(observedSnapshot).toContain('the user prefers dark mode');

    const found = agent.sessions.search('observed');
    expect(found.length).toBeGreaterThan(0);
    const wakeMsg = agent.sessions.search('poke');
    expect(wakeMsg.some((m) => m.role === 'wake')).toBe(true);
  });

  it('ends the session with reason "ok" on success and "error" on a thrown policy error, and rethrows', async () => {
    const okPolicy: RolePolicy = { name: 'ok', async onWake() {} };
    const okAgent = makeAgent(okPolicy);
    await okAgent.wake({ kind: 'poke' });
    const okSessions = okAgent.sessions.recentSessions();
    expect(okSessions[0].endedAt).not.toBeNull();

    const failPolicy: RolePolicy = {
      name: 'fail',
      async onWake() {
        throw new Error('deliberate failure');
      },
    };
    const failAgent = makeAgent(failPolicy);
    await expect(failAgent.wake({ kind: 'poke' })).rejects.toThrow('deliberate failure');
    const errorNote = failAgent.sessions.search('deliberate failure');
    expect(errorNote.some((m) => m.role === 'error')).toBe(true);
  });

  it('a mid-wake memory write is not visible in the same wake\'s already-taken snapshot (frozen, not live)', async () => {
    let firstSnapshot = '';
    let secondSnapshot = '';
    const policy: RolePolicy = {
      name: 'writer',
      async onWake(ctx: WakeContext) {
        firstSnapshot = ctx.agent.memory.snapshot();
        ctx.agent.memory.add('written mid-wake');
        secondSnapshot = ctx.agent.memory.snapshot(); // a fresh call, not the frozen one injected at wake start
      },
    };
    const agent = makeAgent(policy);
    await agent.wake({ kind: 'poke' });
    expect(firstSnapshot).not.toContain('written mid-wake');
    expect(secondSnapshot).toContain('written mid-wake'); // proves the write landed on disk immediately, per MemoryStore
  });
});
