import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { reserveResource } from '../src/kernel.js';
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

describe('test 3: idempotency under concurrency', () => {
  it('the same idempotency key fired twice concurrently produces one commitment and identical results', async () => {
    const args = {
      debtorAgentId: agents.alice,
      creditorAgentId: agents.carol,
      terms: { resource: 'deploy-slot', quantity: 1 },
      idempotencyKey: 'deploy-slot:mission-1',
    };

    const [a, b] = await Promise.all([reserveResource(args, pool), reserveResource(args, pool)]);

    // Logical identity, not byte-identical driver serialization: the
    // winner's own return carries pg-parsed Date objects, a replay read
    // back through JSONB carries ISO strings for the same timestamps.
    expect(a.commitment.id).toBe(b.commitment.id);
    expect(a.commitment.status).toBe(b.commitment.status);
    expect(a.commitment.version).toBe(b.commitment.version);
    expect(a.event.id).toBe(b.event.id);
    expect(a.event.sequence).toBe(b.event.sequence);

    const { rows: commitmentRows } = await pool.query(
      `SELECT count(*)::int AS n FROM commitments WHERE resource_key = 'deploy-slot'`,
    );
    expect(commitmentRows[0].n).toBe(1);

    const { rows: opRows } = await pool.query(
      `SELECT count(*)::int AS n FROM operation_results WHERE idempotency_key = $1`,
      [args.idempotencyKey],
    );
    expect(opRows[0].n).toBe(1);
  });
});
