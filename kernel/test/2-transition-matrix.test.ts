import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { transitionCommitment } from '../src/transition.js';
import { InvalidTransition, Forbidden } from '../src/errors.js';
import { resetDb, seedAgents, type FixtureAgents } from './fixtures.js';
import type { Action } from '../src/kinds/registry.js';

const pool = makePool();
let agents: FixtureAgents;

const STATUSES = ['draft', 'active', 'at_risk', 'fulfilled', 'broken', 'revoked'];
const ACTIONS: Action[] = ['activate', 'fulfill', 'break', 'revoke', 'flag_at_risk', 'repair'];

// v1-spec section 7, restated independently of the kernel's own table so
// this test can catch a drift between the two.
type Role = 'debtor' | 'creditor' | 'kernel';
const LEGAL: Record<string, Partial<Record<Action, { to: string; roles: Role[] }>>> = {
  draft: {
    activate: { to: 'active', roles: ['debtor'] },
    revoke: { to: 'revoked', roles: ['debtor', 'creditor'] },
  },
  active: {
    fulfill: { to: 'fulfilled', roles: ['debtor'] },
    break: { to: 'broken', roles: ['debtor', 'kernel'] },
    revoke: { to: 'revoked', roles: ['creditor'] },
    flag_at_risk: { to: 'at_risk', roles: ['kernel'] },
  },
  at_risk: {
    repair: { to: 'active', roles: ['kernel'] },
    break: { to: 'broken', roles: ['debtor', 'kernel'] },
    fulfill: { to: 'fulfilled', roles: ['debtor'] },
  },
};

beforeEach(async () => {
  await resetDb(pool);
  agents = await seedAgents(pool);
});

afterAll(async () => {
  await pool.end();
});

async function makeCommitmentInStatus(status: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO commitments (kind, debtor_agent_id, creditor_agent_id, terms, status)
     VALUES ('promise', $1, $2, $3, $4) RETURNING id`,
    [agents.alice, agents.bob, JSON.stringify({ deliver: 'x', deadline: '2099-01-01T00:00:00Z' }), status],
  );
  return rows[0].id;
}

function actorFor(role: Role, a: FixtureAgents): string | null {
  if (role === 'debtor') return a.alice;
  if (role === 'creditor') return a.bob;
  return null;
}

function wrongActorFor(roles: Role[], a: FixtureAgents): string | null {
  const all: Role[] = ['debtor', 'creditor', 'kernel'];
  const excluded = all.find((r) => !roles.includes(r))!;
  return actorFor(excluded, a);
}

let seq = 0;

describe('test 2: exhaustive transition matrix', () => {
  for (const status of STATUSES) {
    for (const action of ACTIONS) {
      const edge = LEGAL[status]?.[action];

      if (edge) {
        it(`${status} --${action}--> ${edge.to} succeeds for a permitted actor`, async () => {
          const id = await makeCommitmentInStatus(status);
          const actorId = actorFor(edge.roles[0], agents);
          const result = await transitionCommitment(
            {
              commitmentId: id,
              action,
              actorId,
              expectedVersion: 1,
              idempotencyKey: `matrix-ok-${seq++}`,
            },
            pool,
          );
          expect(result.commitment.status).toBe(edge.to);
        });

        it(`${status} --${action}--> ${edge.to} is Forbidden for an unpermitted actor`, async () => {
          const id = await makeCommitmentInStatus(status);
          const actorId = wrongActorFor(edge.roles, agents);
          await expect(
            transitionCommitment(
              { commitmentId: id, action, actorId, expectedVersion: 1, idempotencyKey: `matrix-forbidden-${seq++}` },
              pool,
            ),
          ).rejects.toBeInstanceOf(Forbidden);
        });
      } else {
        it(`${status} --${action}--> is InvalidTransition`, async () => {
          const id = await makeCommitmentInStatus(status);
          await expect(
            transitionCommitment(
              {
                commitmentId: id,
                action,
                actorId: agents.alice,
                expectedVersion: 1,
                idempotencyKey: `matrix-invalid-${seq++}`,
              },
              pool,
            ),
          ).rejects.toBeInstanceOf(InvalidTransition);
        });
      }
    }
  }
});
