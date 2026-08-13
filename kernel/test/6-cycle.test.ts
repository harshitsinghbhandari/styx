import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { createPromise, linkDependency } from '../src/kernel.js';
import { InvariantViolation } from '../src/errors.js';
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

async function draftPromise(deliver: string, idKey: string): Promise<string> {
  const { commitment } = await createPromise(
    {
      debtorAgentId: agents.alice,
      creditorAgentId: agents.bob,
      terms: { deliver, deadline: '2099-01-01T00:00:00Z' },
      idempotencyKey: idKey,
    },
    pool,
  );
  return commitment.id;
}

describe('test 6: cycle rejection', () => {
  it('rejects a link that would close a cycle, direct or transitive', async () => {
    const a = await draftPromise('a', 'cyc-a');
    const b = await draftPromise('b', 'cyc-b');
    const c = await draftPromise('c', 'cyc-c');

    // a -> b -> c
    await linkDependency({ commitmentId: a, dependsOnId: b }, pool);
    await linkDependency({ commitmentId: b, dependsOnId: c }, pool);

    // c -> a would close the loop a -> b -> c -> a
    await expect(linkDependency({ commitmentId: c, dependsOnId: a }, pool)).rejects.toBeInstanceOf(InvariantViolation);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM commitment_dependencies WHERE commitment_id = $1', [c]);
    expect(rows[0].n).toBe(0);
  });
});
