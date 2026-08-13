import type { PoolClient } from 'pg';
import { nextSequence } from './txn.js';

export interface CascadeEvent {
  id: string;
  commitment_id: string;
  sequence: number;
  event_type: string;
  from_status: string;
  to_status: string;
}

/**
 * Walks commitment_dependencies upward from rootId (recursive CTE) and
 * flags every transitively dependent commitment currently active as
 * at_risk, one flagged_at_risk event each, actor NULL. Terminal and
 * already-at_risk dependents are untouched. Must run inside the caller's
 * open transaction (same commit as the break/revoke that triggered it).
 */
export async function cascadeAtRisk(client: PoolClient, rootId: string): Promise<CascadeEvent[]> {
  const { rows: dependents } = await client.query<{ commitment_id: string }>(
    `WITH RECURSIVE deps AS (
       SELECT commitment_id FROM commitment_dependencies WHERE depends_on_id = $1
       UNION
       SELECT cd.commitment_id FROM commitment_dependencies cd
       JOIN deps ON cd.depends_on_id = deps.commitment_id
     )
     SELECT DISTINCT commitment_id FROM deps`,
    [rootId],
  );

  const flagged: CascadeEvent[] = [];

  for (const { commitment_id } of dependents) {
    const { rows: active } = await client.query<{ id: string }>(
      `SELECT id FROM commitments WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [commitment_id],
    );
    if (active.length === 0) continue;

    await client.query(
      `UPDATE commitments SET status = 'at_risk', version = version + 1, updated_at = now() WHERE id = $1`,
      [commitment_id],
    );

    const sequence = await nextSequence(client, commitment_id);
    const { rows: eventRows } = await client.query<CascadeEvent>(
      `INSERT INTO commitment_events (commitment_id, sequence, event_type, from_status, to_status, actor_agent_id, reason, payload)
       VALUES ($1, $2, 'flagged_at_risk', 'active', 'at_risk', NULL, 'cascade', $3)
       RETURNING id, commitment_id, sequence, event_type, from_status, to_status`,
      [commitment_id, sequence, JSON.stringify({ cascaded_from: rootId })],
    );
    flagged.push(eventRows[0]);
  }

  return flagged;
}
