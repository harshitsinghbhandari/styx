import { describe, it, expect, afterAll } from 'vitest';
import { makePool } from '../../kernel/src/db/pool.js';
import { Engine } from '../src/engine.js';
import { runnerStatus } from '../src/styx.js';
import type { PipelineDef } from '../src/definition.js';
import { freshRun } from './fixtures.js';

const pool = makePool();

afterAll(async () => {
  await pool.end();
});

const linear: PipelineDef = {
  name: 'race-me',
  stages: [
    { id: 'a', run: 'sleep 0.1 && true', on_success: ['b'] },
    { id: 'b', run: 'true' },
  ],
};

describe('engine integration: two engine instances racing the same run', () => {
  it('the kernel reservation is the lock: exactly one instance claims each stage', async () => {
    const { runId, runsDir } = freshRun();

    // Same run id, same definition, two independent engine processes (distinct
    // instanceId so their reservation attempts genuinely contend instead of
    // one replaying the other's cached idempotent result).
    const engineA = new Engine(runId, linear, { pool, runsDir, instanceId: 'instance-a' });
    const engineB = new Engine(runId, linear, { pool, runsDir, instanceId: 'instance-b' });

    const [stateA, stateB] = await Promise.all([engineA.start(), engineB.start()]);

    // Neither instance crashed; both converged to a settled local run.
    expect(['succeeded', 'failed']).toContain(stateA.status);
    expect(['succeeded', 'failed']).toContain(stateB.status);

    // Exactly one reservation is active per stage at the kernel level: the
    // reservation is the lock, proven the same way kernel test 1 proves it.
    for (const stage of ['a', 'b']) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM commitments
         WHERE kind = 'reservation' AND resource_key = $1 AND status = 'active'`,
        [`task:${runId}:${stage}`],
      );
      expect(rows[0].n).toBe(1);
    }

    // The real winner drove both stages to a real outcome in the kernel;
    // nothing is left dangling in draft/active.
    const kernelStatus = await runnerStatus(runId, pool);
    const byStage = Object.fromEntries(kernelStatus.map((s) => [s.stage, s]));
    expect(byStage.a.status).toBe('fulfilled');
    expect(byStage.b.status).toBe('fulfilled');

    // Exactly one instance actually ran each stage to completion: total
    // 'succeeded' settlements across both local views is 2 (a and b), once
    // each, never both instances claiming the same stage succeeded.
    const succeededCount = [stateA, stateB]
      .flatMap((s) => Object.values(s.stages))
      .filter((s) => s.status === 'succeeded').length;
    expect(succeededCount).toBe(2);
  });
});
