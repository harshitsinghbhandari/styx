import type { Pool } from 'pg';
import { pool as defaultPool } from './db.js';

export interface ChangefeedRow {
  after?: Record<string, unknown> | null;
  key?: unknown;
  updated?: string;
}

export interface ChangefeedBatch {
  payload?: ChangefeedRow[];
  length?: number;
  resolved?: string;
}

export interface WakeUp {
  agent: string;
  event: Record<string, unknown>;
}

export interface HandlerRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface HandlerResult {
  statusCode: number;
  body: string;
}

const SHARED_SECRET_HEADER = 'x-styx-webhook-secret';

function verifySecret(headers: HandlerRequest['headers']): boolean {
  const expected = process.env.WEBHOOK_SHARED_SECRET;
  if (!expected) return true; // ponytail: no secret configured, allow through for local dev
  const got = headers[SHARED_SECRET_HEADER];
  return got === expected;
}

async function resolveAffectedAgents(pool: Pool, commitmentId: string): Promise<string[]> {
  const { rows } = await pool.query<{ debtor_agent_id: string; creditor_agent_id: string }>(
    'SELECT debtor_agent_id, creditor_agent_id FROM commitments WHERE id = $1',
    [commitmentId],
  );
  if (rows.length === 0) return [];
  const { debtor_agent_id, creditor_agent_id } = rows[0];
  return [...new Set([debtor_agent_id, creditor_agent_id])];
}

async function postWakeUp(wakeUrl: string, wake: WakeUp): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('wake-up', JSON.stringify(wake));
  try {
    await fetch(wakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wake),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('wake-up post failed', wakeUrl, (err as Error).message);
  }
}

/**
 * Lambda-shaped handler for the CockroachDB webhook-sink changefeed on
 * commitment_events (v1-spec section 10). A batch looks like
 * { payload: [{ after: {...row}, updated: "..." }, ...] }; a resolved
 * checkpoint looks like { resolved: "<ts>" } with no payload, and is a
 * no-op here.
 *
 * Affected-agent resolution does not special-case cascade events: a
 * flagged_at_risk row IS a commitment_events row on the dependent
 * commitment, so "debtor + creditor of this row's commitment" already
 * covers "debtors of at_risk-flagged dependents" once cascade rows show
 * up in the same or a later batch. One rule, not two.
 */
export async function handler(
  event: HandlerRequest,
  pool: Pool = defaultPool,
  wakeUrl: string = process.env.WAKE_URL ?? 'http://localhost:7171/wake',
): Promise<HandlerResult> {
  if (!verifySecret(event.headers)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid shared secret' }) };
  }

  const batch = (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) as ChangefeedBatch;
  if (!batch.payload) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, resolved: batch.resolved ?? null }) };
  }

  let woken = 0;
  for (const row of batch.payload) {
    const after = row.after;
    if (!after || typeof after.id !== 'string') continue;

    const inserted = await pool.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      after.id,
    ]);
    if (inserted.rowCount === 0) continue; // at-least-once redelivery of an event we already routed

    const commitmentId = after.commitment_id as string;
    const affected = await resolveAffectedAgents(pool, commitmentId);
    for (const agent of affected) {
      await postWakeUp(wakeUrl, { agent, event: after });
      woken += 1;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, woken }) };
}
