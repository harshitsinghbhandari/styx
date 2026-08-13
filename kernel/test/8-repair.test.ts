import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool } from '../src/db/pool.js';
import { createPromise, linkDependency, getCommitment, getHistory } from '../src/kernel.js';
import { transitionCommitment } from '../src/transition.js';
import { repairCommitment } from '../src/repair.js';
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

describe('test 8: repairCommitment', () => {
  it('rejects repair when no ACTIVE replaces-linked commitment exists', async () => {
    const p101 = await activePromise('schema migration', 'p101');
    const p102 = await activePromise('API endpoints', 'p102');
    await linkDependency({ commitmentId: p102, dependsOnId: p101 }, pool);
    await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p101-break' },
      pool,
    );

    await expect(
      repairCommitment({ commitmentId: p102, idempotencyKey: 'p102-repair-1' }, pool),
    ).rejects.toThrow(InvariantViolation);
  });

  it('rejects repair when the linked replacement is not ACTIVE', async () => {
    const p101 = await activePromise('schema migration', 'p101');
    const p102 = await activePromise('API endpoints', 'p102');
    await linkDependency({ commitmentId: p102, dependsOnId: p101 }, pool);
    await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p101-break' },
      pool,
    );

    // p104 replacement created but left in draft (never activated)
    const { commitment: p104 } = await createPromise(
      {
        debtorAgentId: agents.alice,
        creditorAgentId: agents.bob,
        terms: { deliver: 'schema migration v2', deadline: '2099-01-01T00:00:00Z' },
        idempotencyKey: 'p104-create',
      },
      pool,
    );
    await linkDependency({ commitmentId: p102, dependsOnId: p104.id, dependencyType: 'replaces' }, pool);

    await expect(
      repairCommitment({ commitmentId: p102, idempotencyKey: 'p102-repair-2' }, pool),
    ).rejects.toThrow(InvariantViolation);
  });

  it('repairs at_risk -> active as kernel actor once an ACTIVE replacement is replaces-linked, and records the replacement in evidence', async () => {
    const p101 = await activePromise('schema migration', 'p101');
    const p102 = await activePromise('API endpoints', 'p102');
    await linkDependency({ commitmentId: p102, dependsOnId: p101 }, pool);

    const breakResult = await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p101-break' },
      pool,
    );
    expect(breakResult.cascaded.map((e) => e.commitment_id)).toEqual([p102]);

    const p104 = await activePromise('schema migration v2', 'p104');
    await linkDependency({ commitmentId: p102, dependsOnId: p104, dependencyType: 'replaces' }, pool);

    const repairResult = await repairCommitment({ commitmentId: p102, idempotencyKey: 'p102-repair-3' }, pool);

    expect(repairResult.commitment.status).toBe('active');
    expect(repairResult.event.event_type).toBe('repaired');
    expect(repairResult.event.actor_agent_id).toBeNull();
    expect(repairResult.event.payload).toMatchObject({ replacement_id: p104 });

    const fresh = await getCommitment(p102, pool);
    expect(fresh?.status).toBe('active');

    const history = await getHistory(p102, pool);
    expect(history.some((e) => e.event_type === 'repaired')).toBe(true);
  });

  it('repairs via a healed original dependency, with no new edge linked: the kernel checks any dependency edge points at ACTIVE, not specifically dependency_type replaces', async () => {
    // P-101 -> P-102 -> P-103, all default 'requires' edges (linkDependency's default).
    const p101 = await activePromise('schema migration', 'h101');
    const p102 = await activePromise('API endpoints', 'h102');
    const p103 = await activePromise('frontend wiring', 'h103');
    await linkDependency({ commitmentId: p102, dependsOnId: p101 }, pool);
    await linkDependency({ commitmentId: p103, dependsOnId: p102 }, pool);

    await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'h101-break' },
      pool,
    );
    // p102 (depends_on p101) and p103 (depends_on p102, transitively) are both at_risk now.
    const p102AtRisk = await getCommitment(p102, pool);
    expect(p102AtRisk?.status).toBe('at_risk');
    const p103AtRisk = await getCommitment(p103, pool);
    expect(p103AtRisk?.status).toBe('at_risk');

    // Repair p102 via a brand-new replacement (its 'requires' dependency, p101, is terminally broken).
    const p104 = await activePromise('schema migration v2', 'h104');
    await linkDependency({ commitmentId: p102, dependsOnId: p104, dependencyType: 'replaces' }, pool);
    await repairCommitment({ commitmentId: p102, idempotencyKey: 'h102-repair' }, pool);
    const p102Repaired = await getCommitment(p102, pool);
    expect(p102Repaired?.status).toBe('active');

    // p103's own 'requires' edge already points at p102 -- (p103, p102) already exists as a row, so a
    // 'replaces' edge to the same target is not linkable (PK collision) and none is needed: p102 is
    // active again, which is exactly what the kernel's check asks for. No linkDependency call at all.
    const p103Repaired = await repairCommitment({ commitmentId: p103, idempotencyKey: 'h103-repair' }, pool);
    expect(p103Repaired.commitment.status).toBe('active');
    expect(p103Repaired.event.payload).toMatchObject({ replacement_id: p102 });
  });

  it('is idempotent: replaying the same idempotency key returns the same stored result without re-transitioning', async () => {
    const p101 = await activePromise('schema migration', 'p101');
    const p102 = await activePromise('API endpoints', 'p102');
    await linkDependency({ commitmentId: p102, dependsOnId: p101 }, pool);
    await transitionCommitment(
      { commitmentId: p101, action: 'break', actorId: agents.alice, expectedVersion: 2, idempotencyKey: 'p101-break' },
      pool,
    );
    const p104 = await activePromise('schema migration v2', 'p104');
    await linkDependency({ commitmentId: p102, dependsOnId: p104, dependencyType: 'replaces' }, pool);

    const first = await repairCommitment({ commitmentId: p102, idempotencyKey: 'p102-repair-same-key' }, pool);
    const second = await repairCommitment({ commitmentId: p102, idempotencyKey: 'p102-repair-same-key' }, pool);
    expect(second.event.id).toBe(first.event.id);
  });
});
