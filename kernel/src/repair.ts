import type { Pool } from 'pg';
import { pool as defaultPool } from './db/pool.js';
import { getCommitment } from './kernel.js';
import { transitionCommitment, type TransitionResult } from './transition.js';
import { InvariantViolation } from './errors.js';

export interface RepairArgs {
  commitmentId: string;
  actorContext?: { reason?: string };
  idempotencyKey: string;
}

/**
 * v3-plan repair flow, kernel side: an at_risk commitment may return to
 * active once it has at least one commitment_dependencies edge whose
 * target is currently ACTIVE. Two ways that happens, both satisfied by the
 * same check:
 *   - a brand-new replacement: the original 'requires' dependency is
 *     terminally broken, so the repair agent creates a fresh commitment,
 *     activates it, and links it in with dependency_type 'replaces' (a new
 *     edge -- commitment_dependencies' primary key is (commitment_id,
 *     depends_on_id), so this only works when that pair does not already
 *     exist).
 *   - a healed original dependency: the commitment's existing 'requires'
 *     edge already points at something that has since come back to
 *     ACTIVE (its own at_risk -> active repair already landed). No new
 *     edge is linked or linkable here -- (commitment_id, depends_on_id)
 *     already exists with type 'requires' -- so the same already-linked
 *     edge is what satisfies this check once its target heals.
 * Either way the kernel does not care about dependency_type, only that a
 * link to an ACTIVE commitment exists; 'replaces' is a descriptive label
 * the repair agent chooses for a brand-new edge, not a kernel invariant.
 * Callers (the repair agent, via the API route) are responsible for
 * creating and linking a replacement before calling this when needed; the
 * kernel only verifies a qualifying link exists, it never picks one itself.
 */
export async function repairCommitment(args: RepairArgs, pool: Pool = defaultPool): Promise<TransitionResult> {
  const commitment = await getCommitment(args.commitmentId, pool);
  if (!commitment) {
    throw new Error(`commitment not found: ${args.commitmentId}`);
  }

  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT c.id, c.status FROM commitment_dependencies cd
     JOIN commitments c ON c.id = cd.depends_on_id
     WHERE cd.commitment_id = $1`,
    [args.commitmentId],
  );
  const activeReplacement = rows.find((r) => r.status === 'active');
  if (!activeReplacement) {
    throw new InvariantViolation(
      `commitment ${args.commitmentId} has no dependency link pointing at an ACTIVE commitment`,
    );
  }

  return transitionCommitment(
    {
      commitmentId: args.commitmentId,
      action: 'repair',
      actorId: null, // kernel-initiated transition, per v1-spec: the kernel performs the at_risk -> active edge
      expectedVersion: commitment.version,
      idempotencyKey: args.idempotencyKey,
      reason: args.actorContext?.reason ?? `repaired via replacement ${activeReplacement.id}`,
      evidence: { replacement_id: activeReplacement.id },
    },
    pool,
  );
}
