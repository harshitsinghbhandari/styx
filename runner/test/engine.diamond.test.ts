import { describe, it, expect, afterAll } from 'vitest';
import { makePool } from '../../kernel/src/db/pool.js';
import { getHistory } from '../../kernel/src/index.js';
import { Engine } from '../src/engine.js';
import { runnerStatus } from '../src/styx.js';
import type { PipelineDef } from '../src/definition.js';
import { freshRun } from './fixtures.js';

const pool = makePool();

afterAll(async () => {
  await pool.end();
});

// a -> b, c -> d (join). b fails, c succeeds slower than b so the join
// dies before c even finishes.
const diamond: PipelineDef = {
  name: 'diamond-demo',
  stages: [
    { id: 'a', run: 'true', on_success: ['b', 'c'] },
    { id: 'b', run: 'false', needs: ['a'], on_success: ['d'] },
    { id: 'c', run: 'sleep 0.3 && true', needs: ['a'], on_success: ['d'] },
    { id: 'd', run: 'true', needs: ['b', 'c'] },
  ],
};

describe('engine integration: diamond against the local kernel', () => {
  it('runs a->b,c->d, settles B failed and cascades D skipped, and the kernel commitments agree', async () => {
    const { runId, runsDir } = freshRun();
    const engine = new Engine(runId, diamond, { pool, runsDir });

    const finalState = await engine.start();

    // local reducer view
    expect(finalState.stages.a.status).toBe('succeeded');
    expect(finalState.stages.b.status).toBe('failed');
    expect(finalState.stages.c.status).toBe('succeeded');
    expect(finalState.stages.d.status).toBe('skipped');
    expect(finalState.status).toBe('failed');

    // kernel view: the store of record, queried fresh, not from memory
    const kernelStatus = await runnerStatus(runId, pool);
    const byStage = Object.fromEntries(kernelStatus.map((s) => [s.stage, s]));
    expect(byStage.a.status).toBe('fulfilled');
    expect(byStage.b.status).toBe('broken');
    expect(byStage.c.status).toBe('fulfilled');
    // The kernel has no at_risk -> revoked edge (only draft/active can
    // revoke, kernel/src/transition.ts TRANSITIONS table). D depends_on the
    // broken B, so B's break cascades D to at_risk first (same transaction
    // as B's break); the runner then settles D from at_risk via 'break',
    // the legal edge, landing on 'broken' rather than 'revoked'.
    expect(byStage.d.status).toBe('broken');

    // at_risk propagation genuinely happened in between, not just a jump
    // straight to the final state.
    const dHistory = await getHistory(byStage.d.commitmentId, pool);
    const dTypes = dHistory.map((e) => e.event_type);
    expect(dTypes).toContain('flagged_at_risk');
    expect(dTypes[dTypes.length - 1]).toBe('broken');
    const atRiskEvent = dHistory.find((e) => e.event_type === 'flagged_at_risk')!;
    expect(atRiskEvent.actor_agent_id).toBeNull(); // the kernel's own cascade, not the runner
  });
});
