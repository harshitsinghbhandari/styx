import { pool as defaultPool } from './db/pool.js';
import type { Pool } from 'pg';
import { withKernelOp, nextSequence } from './txn.js';
import { getKind } from './kinds/index.js';
import type { Action, CommitmentRow } from './kinds/registry.js';
import { cascadeAtRisk, type CascadeEvent } from './cascade.js';
import { VersionConflict, Forbidden, InvalidTransition, InvariantViolation } from './errors.js';

type Role = 'debtor' | 'creditor' | 'kernel';

interface Edge {
  to: string;
  roles: Role[];
  eventType: string;
}

// The complete legal transition table from v1-spec section 7. Every other
// (status, action) pair is InvalidTransition.
const TRANSITIONS: Record<string, Partial<Record<Action, Edge>>> = {
  draft: {
    activate: { to: 'active', roles: ['debtor'], eventType: 'activated' },
    revoke: { to: 'revoked', roles: ['debtor', 'creditor'], eventType: 'revoked' },
  },
  active: {
    fulfill: { to: 'fulfilled', roles: ['debtor'], eventType: 'fulfilled' },
    break: { to: 'broken', roles: ['debtor', 'kernel'], eventType: 'broken' },
    revoke: { to: 'revoked', roles: ['creditor'], eventType: 'revoked' },
    flag_at_risk: { to: 'at_risk', roles: ['kernel'], eventType: 'flagged_at_risk' },
  },
  at_risk: {
    // "after replacement linked" (v1-spec 7) is enforced by the repair
    // agent's call sequence, not the kernel: it links the replacement via
    // linkDependency before invoking repair. Day 1 ships no repair agent.
    repair: { to: 'active', roles: ['kernel'], eventType: 'repaired' },
    break: { to: 'broken', roles: ['debtor', 'kernel'], eventType: 'broken' },
    fulfill: { to: 'fulfilled', roles: ['debtor'], eventType: 'fulfilled' },
  },
};

function actorHasRole(commitment: CommitmentRow, actorId: string | null, role: Role): boolean {
  if (role === 'kernel') return actorId === null;
  if (role === 'debtor') return actorId === commitment.debtor_agent_id;
  if (role === 'creditor') return actorId === commitment.creditor_agent_id;
  return false;
}

export interface CommitmentEventRow {
  id: string;
  commitment_id: string;
  sequence: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_agent_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TransitionArgs {
  commitmentId: string;
  action: Action;
  actorId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface TransitionResult {
  commitment: CommitmentRow;
  event: CommitmentEventRow;
  cascaded: CascadeEvent[];
}

export async function transitionCommitment(
  args: TransitionArgs,
  pool: Pool = defaultPool,
): Promise<TransitionResult> {
  return withKernelOp<TransitionResult>(
    pool,
    { idempotencyKey: args.idempotencyKey, operation: `transition:${args.action}`, actorAgentId: args.actorId },
    async (client) => {
      const { rows } = await client.query<CommitmentRow>(
        'SELECT * FROM commitments WHERE id = $1 FOR UPDATE',
        [args.commitmentId],
      );
      if (rows.length === 0) {
        throw new Error(`commitment not found: ${args.commitmentId}`);
      }
      const commitment = rows[0];

      if (commitment.version !== args.expectedVersion) {
        throw new VersionConflict(args.expectedVersion, commitment.version);
      }

      const edge = TRANSITIONS[commitment.status]?.[args.action];
      if (!edge) {
        throw new InvalidTransition(commitment.status, args.action);
      }

      if (!edge.roles.some((role) => actorHasRole(commitment, args.actorId, role))) {
        throw new Forbidden(args.action, args.actorId);
      }

      const kind = getKind(commitment.kind);
      const invariant = await kind.validateTransition({ client, commitment, action: args.action });
      if (!invariant.ok) {
        throw new InvariantViolation(invariant.error ?? 'kind invariant failed');
      }

      const { rows: updatedRows } = await client.query<CommitmentRow>(
        `UPDATE commitments SET status = $1, version = version + 1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [edge.to, commitment.id],
      );
      const updated = updatedRows[0];

      const sequence = await nextSequence(client, commitment.id);
      const { rows: eventRows } = await client.query<CommitmentEventRow>(
        `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, actor_agent_id, reason, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          commitment.id,
          sequence,
          edge.eventType,
          commitment.status,
          edge.to,
          args.actorId,
          args.reason ?? null,
          JSON.stringify(args.evidence ?? {}),
        ],
      );
      const event = eventRows[0];

      let cascaded: CascadeEvent[] = [];
      if (args.action === 'break' || args.action === 'revoke') {
        cascaded = await cascadeAtRisk(client, commitment.id);
      }

      return { commitmentId: commitment.id, result: { commitment: updated, event, cascaded } };
    },
  );
}
