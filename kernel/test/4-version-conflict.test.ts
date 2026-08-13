import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { createPromise } from '../src/kernel.js';
import { transitionCommitment } from '../src/transition.js';
import { VersionConflict } from '../src/errors.js';
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

describe('test 4: stale expectedVersion', () => {
  it('rejects with VersionConflict, writes nothing, appends no event', async () => {
    const { commitment } = await createPromise(
      {
        debtorAgentId: agents.alice,
        creditorAgentId: agents.bob,
        terms: { deliver: 'schema migration', deadline: '2099-01-01T00:00:00Z' },
        idempotencyKey: 'p-101-create',
      },
      pool,
    );

    await expect(
      transitionCommitment(
        {
          commitmentId: commitment.id,
          action: 'activate',
          actorId: agents.alice,
          expectedVersion: commitment.version + 1,
          idempotencyKey: 'p-101-activate-stale',
        },
        pool,
      ),
    ).rejects.toBeInstanceOf(VersionConflict);

    const { rows } = await pool.query('SELECT status, version FROM commitments WHERE id = $1', [commitment.id]);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].version).toBe(commitment.version);

    const { rows: events } = await pool.query('SELECT count(*)::int AS n FROM commitment_events WHERE commitment_id = $1', [
      commitment.id,
    ]);
    expect(events[0].n).toBe(1); // only the original 'created' event
  });
});
