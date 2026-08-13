import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makePool } from '../../kernel/src/db/pool.js';
import { getCommitment } from '../../kernel/src/index.js';
import { Engine } from '../src/engine.js';
import { runnerStatus } from '../src/styx.js';
import type { PipelineDef } from '../src/definition.js';
import { freshRun } from './fixtures.js';

const pool = makePool();

afterAll(async () => {
  await pool.end();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inserts a fresh fleet agent row the engine can resolve by name, isolated per test so parallel test files never collide on the UNIQUE(name) constraint. */
async function seedFleetAgent(): Promise<string> {
  const name = `worker-${randomUUID()}`;
  await pool.query(`INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, 'worker', 'test-hash')`, [name]);
  return name;
}

/**
 * What a real agent actually waits on before it could ever call back: its
 * mission's commitment being ACTIVE in the kernel, i.e. exactly what
 * getObligations() would return (kernel/src/kernel.ts filters status IN
 * ('active','at_risk')). Draft is not enough -- the stage commitment
 * exists in the DB the moment createPromise's insert commits, one DB round
 * trip before its activate transition lands, and runnerStatus (unlike
 * getObligations) returns rows in any status; polling on mere existence
 * raced the engine's own in-memory commitmentIds bookkeeping in practice.
 */
async function waitForMission(engine: Engine, runId: string, stage: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = engine.callbackAddress();
    if (addr) {
      const status = await runnerStatus(runId, pool);
      if (status.some((s) => s.stage === stage && s.status === 'active')) return addr;
    }
    await sleep(10);
  }
  throw new Error('mission commitment never became active');
}

describe('engine integration: agent executor against the local kernel', () => {
  it('creates the stage promise with the mission agent as debtor, and fulfill/no_output/no_signal round-trip through the HTTP callback', async () => {
    const agentName = await seedFleetAgent();
    const { runId, runsDir } = freshRun();
    const def: PipelineDef = {
      name: 'agent-demo',
      stages: [{ id: 'a', agent: { agentName, mission: 'produce a result' }, produces: 'result.json', timeout_s: 30 }],
    };
    const engine = new Engine(runId, def, { pool, runsDir });
    const runPromise = engine.start();
    const addr = await waitForMission(engine, runId, 'a');

    // the mission's owning agent writes its declared artifact, then signals done
    mkdirSync(path.join(runsDir, runId, 'agent-outputs'), { recursive: true });
    writeFileSync(path.join(runsDir, runId, 'agent-outputs', 'result.json'), '{"ok":true}');

    const res = await fetch(`${addr}/v1/runs/${runId}/stages/a/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);

    const finalState = await runPromise;
    expect(finalState.stages.a.status).toBe('succeeded');
    expect(finalState.status).toBe('succeeded');

    const kernelStatus = await runnerStatus(runId, pool);
    expect(kernelStatus[0].status).toBe('fulfilled');

    const commitment = await getCommitment(kernelStatus[0].commitmentId, pool);
    // per-stage debtor is the owning agent, not the runner
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM agents WHERE name = $1', [agentName]);
    expect(commitment?.debtor_agent_id).toBe(rows[0].id);
  });

  it('done:true with the declared artifact missing settles no_output and breaks the kernel commitment', async () => {
    const agentName = await seedFleetAgent();
    const { runId, runsDir } = freshRun();
    const def: PipelineDef = {
      name: 'agent-no-output',
      stages: [{ id: 'a', agent: { agentName, mission: 'produce a result' }, produces: 'result.json', timeout_s: 30 }],
    };
    const engine = new Engine(runId, def, { pool, runsDir });
    const runPromise = engine.start();
    const addr = await waitForMission(engine, runId, 'a');

    const res = await fetch(`${addr}/v1/runs/${runId}/stages/a/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);

    const finalState = await runPromise;
    expect(finalState.stages.a.status).toBe('no_output');
    expect(finalState.status).toBe('failed');

    const kernelStatus = await runnerStatus(runId, pool);
    expect(kernelStatus[0].status).toBe('broken');
  });

  it('silence past timeout_s settles no_signal with no HTTP callback ever received', async () => {
    const agentName = await seedFleetAgent();
    const { runId, runsDir } = freshRun();
    const def: PipelineDef = {
      name: 'agent-silent',
      stages: [{ id: 'a', agent: { agentName, mission: 'never responds' }, timeout_s: 1 }],
    };
    const engine = new Engine(runId, def, { pool, runsDir });

    const finalState = await engine.start();
    expect(finalState.stages.a.status).toBe('no_signal');

    const kernelStatus = await runnerStatus(runId, pool);
    expect(kernelStatus[0].status).toBe('broken');
  });

  it('done:true with no produces declared settles succeeded_unverified', async () => {
    const agentName = await seedFleetAgent();
    const { runId, runsDir } = freshRun();
    const def: PipelineDef = {
      name: 'agent-unverified',
      stages: [{ id: 'a', agent: { agentName, mission: 'just say done' }, timeout_s: 30 }],
    };
    const engine = new Engine(runId, def, { pool, runsDir });
    const runPromise = engine.start();
    const addr = await waitForMission(engine, runId, 'a');

    await fetch(`${addr}/v1/runs/${runId}/stages/a/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });

    const finalState = await runPromise;
    expect(finalState.stages.a.status).toBe('succeeded_unverified');
    expect(finalState.status).toBe('succeeded');
  });
});
