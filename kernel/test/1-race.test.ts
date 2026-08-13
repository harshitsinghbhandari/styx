import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { reserveResource } from '../src/kernel.js';
import { ResourceConflict } from '../src/errors.js';
import { resetDb, seedAgents, seedResources, type FixtureAgents } from './fixtures.js';

const pool = makePool();
let agents: FixtureAgents;

beforeEach(async () => {
  await resetDb(pool);
  agents = await seedAgents(pool);
  await seedResources(pool, agents.carol);
});

afterAll(async () => {
  await pool.end();
});

describe('test 1: race for a capacity-1 resource', () => {
  it('exactly one of 50 concurrent reservations wins, the rest get typed ResourceConflict', async () => {
    const N = 50;
    const attempts = Array.from({ length: N }, (_, i) =>
      reserveResource(
        {
          debtorAgentId: agents.alice,
          creditorAgentId: agents.carol,
          terms: { resource: 'task:build-auth', quantity: 1 },
          idempotencyKey: `race-${i}`,
        },
        pool,
      ),
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ResourceConflict);
      expect(r.reason.resource).toBe('task:build-auth');
      expect(r.reason.available).toBeGreaterThanOrEqual(0);
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM commitments WHERE resource_key = 'task:build-auth' AND status = 'active'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
