import type { Pool } from 'pg';
import { pool as defaultPool } from './db/pool.js';
import { withKernelOp, withTxn, nextSequence } from './txn.js';
import { getKind } from './kinds/index.js';
import type { CommitmentRow } from './kinds/registry.js';
import { checkReservationCapacity, type Window } from './kinds/reservation.js';
import { InvariantViolation } from './errors.js';
import type { CommitmentEventRow } from './transition.js';

export interface CreatePromiseArgs {
  debtorAgentId: string;
  creditorAgentId: string;
  terms: { deliver: string; deadline: string; [key: string]: unknown };
  idempotencyKey: string;
}

export interface ReserveResourceArgs {
  debtorAgentId: string;
  creditorAgentId: string;
  terms: { resource: string; quantity: number; window?: Window; [key: string]: unknown };
  idempotencyKey: string;
}

export interface CreationResult {
  commitment: CommitmentRow;
  event: CommitmentEventRow;
}

/** Promises are created in draft; the debtor activates them separately. */
export async function createPromise(args: CreatePromiseArgs, pool: Pool = defaultPool): Promise<CreationResult> {
  const kind = getKind('promise');
  const validation = kind.validateTerms(args.terms);
  if (!validation.ok) {
    throw new InvariantViolation(validation.error ?? 'invalid promise terms');
  }

  return withKernelOp<CreationResult>(
    pool,
    { idempotencyKey: args.idempotencyKey, operation: 'create:promise', actorAgentId: args.debtorAgentId },
    async (client) => {
      const { rows } = await client.query<CommitmentRow>(
        `INSERT INTO commitments (kind, debtor_agent_id, creditor_agent_id, resource_key, terms, status)
         VALUES ('promise', $1, $2, NULL, $3, 'draft')
         RETURNING *`,
        [args.debtorAgentId, args.creditorAgentId, JSON.stringify(args.terms)],
      );
      const commitment = rows[0];

      const sequence = await nextSequence(client, commitment.id);
      const { rows: eventRows } = await client.query<CommitmentEventRow>(
        `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, actor_agent_id, payload)
         VALUES ($1, $2, 'created', NULL, 'draft', $3, '{}')
         RETURNING *`,
        [commitment.id, sequence, args.debtorAgentId],
      );

      return { commitmentId: commitment.id, result: { commitment, event: eventRows[0] } };
    },
  );
}

/**
 * Reservations are created directly active: the capacity+window invariant
 * (amendment 2) is checked in the same transaction as the insert, so there
 * is no separate draft/activate step to race against.
 */
export async function reserveResource(args: ReserveResourceArgs, pool: Pool = defaultPool): Promise<CreationResult> {
  const kind = getKind('reservation');
  const validation = kind.validateTerms(args.terms);
  if (!validation.ok) {
    throw new InvariantViolation(validation.error ?? 'invalid reservation terms');
  }

  return withKernelOp<CreationResult>(
    pool,
    { idempotencyKey: args.idempotencyKey, operation: 'create:reservation', actorAgentId: args.debtorAgentId },
    async (client) => {
      await checkReservationCapacity(client, args.terms.resource, args.terms.quantity, args.terms.window);

      const { rows } = await client.query<CommitmentRow>(
        `INSERT INTO commitments (kind, debtor_agent_id, creditor_agent_id, resource_key, terms, status)
         VALUES ('reservation', $1, $2, $3, $4, 'active')
         RETURNING *`,
        [args.debtorAgentId, args.creditorAgentId, args.terms.resource, JSON.stringify(args.terms)],
      );
      const commitment = rows[0];

      const sequence = await nextSequence(client, commitment.id);
      const { rows: eventRows } = await client.query<CommitmentEventRow>(
        `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, actor_agent_id, payload)
         VALUES ($1, $2, 'created', NULL, 'active', $3, '{}')
         RETURNING *`,
        [commitment.id, sequence, args.debtorAgentId],
      );

      return { commitmentId: commitment.id, result: { commitment, event: eventRows[0] } };
    },
  );
}

export interface LinkDependencyArgs {
  commitmentId: string;
  dependsOnId: string;
  dependencyType?: string;
  actorAgentId?: string | null;
}

export async function linkDependency(args: LinkDependencyArgs, pool: Pool = defaultPool): Promise<void> {
  await withTxn(pool, async (client) => {
    const { rows: cycleRows } = await client.query(
      `WITH RECURSIVE reach AS (
         SELECT depends_on_id AS node FROM commitment_dependencies WHERE commitment_id = $1
         UNION
         SELECT cd.depends_on_id FROM commitment_dependencies cd
         JOIN reach ON cd.commitment_id = reach.node
       )
       SELECT 1 FROM reach WHERE node = $2 LIMIT 1`,
      [args.dependsOnId, args.commitmentId],
    );
    if (cycleRows.length > 0) {
      throw new InvariantViolation(`linking ${args.commitmentId} -> ${args.dependsOnId} would create a cycle`);
    }

    await client.query(
      `INSERT INTO commitment_dependencies (commitment_id, depends_on_id, dependency_type)
       VALUES ($1, $2, $3)`,
      [args.commitmentId, args.dependsOnId, args.dependencyType ?? 'requires'],
    );

    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM commitments WHERE id = $1',
      [args.commitmentId],
    );
    const sequence = await nextSequence(client, args.commitmentId);
    await client.query(
      `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, actor_agent_id, payload)
       VALUES ($1, $2, 'dependency_linked', $3, $3, $4, $5)`,
      [
        args.commitmentId,
        sequence,
        statusRows[0].status,
        args.actorAgentId ?? null,
        JSON.stringify({ depends_on_id: args.dependsOnId }),
      ],
    );
  });
}

export async function getCommitment(id: string, pool: Pool = defaultPool): Promise<CommitmentRow | null> {
  const { rows } = await pool.query<CommitmentRow>('SELECT * FROM commitments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getObligations(agentId: string, pool: Pool = defaultPool): Promise<CommitmentRow[]> {
  const { rows } = await pool.query<CommitmentRow>(
    `SELECT * FROM commitments WHERE debtor_agent_id = $1 AND status IN ('active', 'at_risk')
     ORDER BY created_at`,
    [agentId],
  );
  return rows;
}

export async function getDependents(commitmentId: string, pool: Pool = defaultPool): Promise<CommitmentRow[]> {
  const { rows } = await pool.query<CommitmentRow>(
    `SELECT c.* FROM commitments c
     JOIN commitment_dependencies cd ON cd.commitment_id = c.id
     WHERE cd.depends_on_id = $1
     ORDER BY c.created_at`,
    [commitmentId],
  );
  return rows;
}

export async function getHistory(commitmentId: string, pool: Pool = defaultPool): Promise<CommitmentEventRow[]> {
  const { rows } = await pool.query<CommitmentEventRow>(
    'SELECT * FROM commitment_events WHERE commitment_id = $1 ORDER BY sequence',
    [commitmentId],
  );
  return rows;
}
