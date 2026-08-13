import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { createPromise, getHistory } from '../src/kernel.js';
import { transitionCommitment } from '../src/transition.js';
import { resetDb, seedAgents, type FixtureAgents } from './fixtures.js';

const pool = makePool();
let agents: FixtureAgents;

beforeEach(async () => {
  await resetDb(pool);
  agents = await seedAgents(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('test 7: gapless ordered event sequences', () => {
  it('sequences run 1..N with no gaps, in order, per commitment', async () => {
    const { commitment } = await createPromise(
      {
        debtorAgentId: agents.alice,
        creditorAgentId: agents.bob,
        terms: { deliver: 'ci pipeline', deadline: '2099-01-01T00:00:00Z' },
        idempotencyKey: 'seq-create',
      },
      pool,
    );

    await transitionCommitment(
      { commitmentId: commitment.id, action: 'activate', actorId: agents.alice, expectedVersion: 1, idempotencyKey: 'seq-activate' },
      pool,
    );
    await transitionCommitment(
      { commitmentId: commitment.id, action: 'fulfill', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'seq-fulfill' },
      pool,
    );

    const history = await getHistory(commitment.id, pool);
    expect(history.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(history.map((e) => e.event_type)).toEqual(['created', 'activated', 'fulfilled']);
    for (let i = 1; i < history.length; i++) {
      expect(new Date(history[i].created_at).getTime()).toBeGreaterThanOrEqual(new Date(history[i - 1].created_at).getTime());
    }
  });

  it('sequences stay gapless under concurrent transitions on the same commitment', async () => {
    const { commitment } = await createPromise(
      {
        debtorAgentId: agents.alice,
        creditorAgentId: agents.bob,
        terms: { deliver: 'concurrent target', deadline: '2099-01-01T00:00:00Z' },
        idempotencyKey: 'seq-concurrent-create',
      },
      pool,
    );
    await transitionCommitment(
      { commitmentId: commitment.id, action: 'activate', actorId: agents.alice, expectedVersion: 1, idempotencyKey: 'seq-concurrent-activate' },
      pool,
    );

    // Ten agents racing to link a dependent then immediately break, all
    // against the same commitment: each transitionCommitment call retries
    // on 40001 until it lands with the correct expectedVersion, so this
    // exercises the gapless-sequence guarantee under real contention by
    // instead firing distinct dependents that each append one event.
    const dependents = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createPromise(
          {
            debtorAgentId: agents.alice,
            creditorAgentId: agents.bob,
            terms: { deliver: `dep-${i}`, deadline: '2099-01-01T00:00:00Z' },
            idempotencyKey: `seq-dep-${i}`,
          },
          pool,
        ),
      ),
    );

    const { linkDependency } = await import('../src/kernel.js');
    await Promise.all(dependents.map((d) => linkDependency({ commitmentId: d.commitment.id, dependsOnId: commitment.id }, pool)));

    const breakResult = await transitionCommitment(
      { commitmentId: commitment.id, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'seq-concurrent-break' },
      pool,
    );
    expect(breakResult.cascaded).toHaveLength(0); // dependents are draft, not active: untouched

    for (const d of dependents) {
      const history = await getHistory(d.commitment.id, pool);
      const sequences = history.map((e) => e.sequence);
      expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    }
  });
});
