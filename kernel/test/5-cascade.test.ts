import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { createPromise, linkDependency, getHistory } from '../src/kernel.js';
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

async function activePromise(deliver: string, idKey: string): Promise<string> {
  const { commitment } = await createPromise(
    {
      debtorAgentId: agents.alice,
      creditorAgentId: agents.bob,
      terms: { deliver, deadline: '2099-01-01T00:00:00Z' },
      idempotencyKey: `${idKey}-create`,
    },
    pool,
  );
  await transitionCommitment(
    { commitmentId: commitment.id, action: 'activate', actorId: agents.alice, expectedVersion: 1, idempotencyKey: `${idKey}-activate` },
    pool,
  );
  return commitment.id;
}

describe('test 5: diamond cascade on break', () => {
  it('flags every active transitive dependent at_risk, one event each, leaves terminal dependents alone', async () => {
    // P-101 (root) -> P-102a, P-102b -> P-103 (diamond, 3 deep)
    const p101 = await activePromise('schema migration', 'p101');
    const p102a = await activePromise('API endpoints', 'p102a');
    const p102b = await activePromise('API docs', 'p102b');
    const p103 = await activePromise('frontend wiring', 'p103');
    const alreadyFulfilled = await activePromise('unrelated cleanup', 'p102c');

    await linkDependency({ commitmentId: p102a, dependsOnId: p101 }, pool);
    await linkDependency({ commitmentId: p102b, dependsOnId: p101 }, pool);
    await linkDependency({ commitmentId: p103, dependsOnId: p102a }, pool);
    await linkDependency({ commitmentId: p103, dependsOnId: p102b }, pool);
    await linkDependency({ commitmentId: alreadyFulfilled, dependsOnId: p101 }, pool);

    await transitionCommitment(
      { commitmentId: alreadyFulfilled, action: 'fulfill', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p102c-fulfill' },
      pool,
    );

    const breakResult = await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p101-break' },
      pool,
    );

    expect(breakResult.commitment.status).toBe('broken');
    const cascadedIds = breakResult.cascaded.map((e) => e.commitment_id).sort();
    expect(cascadedIds).toEqual([p102a, p102b, p103].sort());

    for (const id of [p102a, p102b, p103]) {
      const { rows } = await pool.query('SELECT status FROM commitments WHERE id = $1', [id]);
      expect(rows[0].status).toBe('at_risk');
      const history = await getHistory(id, pool);
      const flagEvents = history.filter((e) => e.event_type === 'flagged_at_risk');
      expect(flagEvents).toHaveLength(1);
      expect(flagEvents[0].actor_agent_id).toBeNull();
    }

    const { rows: untouched } = await pool.query('SELECT status FROM commitments WHERE id = $1', [alreadyFulfilled]);
    expect(untouched[0].status).toBe('fulfilled');
    const untouchedHistory = await getHistory(alreadyFulfilled, pool);
    expect(untouchedHistory.some((e) => e.event_type === 'flagged_at_risk')).toBe(false);
  });
});
