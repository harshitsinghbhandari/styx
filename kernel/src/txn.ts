import type { Pool, PoolClient } from 'pg';

const SERIALIZATION_FAILURE = '40001';
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 20;
const MAX_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Capped exponential backoff with full jitter, retried only on 40001. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== SERIALIZATION_FAILURE || attempt >= MAX_RETRIES) {
        throw err;
      }
      const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      await sleep(Math.random() * cap);
      attempt += 1;
    }
  }
}

export interface KernelOpMeta {
  idempotencyKey: string;
  operation: string;
  actorAgentId: string | null;
}

/**
 * Wraps one kernel operation (creation or transition) in a serializable
 * transaction with the amendment-1 idempotency check as step 1: replay a
 * stored result verbatim, or run fn and store its result in the same
 * transaction that produced it.
 */
export async function withKernelOp<T>(
  pool: Pool,
  meta: KernelOpMeta,
  fn: (client: PoolClient) => Promise<{ commitmentId: string | null; result: T }>,
): Promise<T> {
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ result: T }>(
        'SELECT result FROM operation_results WHERE idempotency_key = $1',
        [meta.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0].result;
      }

      const { commitmentId, result } = await fn(client);

      await client.query(
        `INSERT INTO operation_results (idempotency_key, operation, actor_agent_id, commitment_id, result)
         VALUES ($1, $2, $3, $4, $5)`,
        [meta.idempotencyKey, meta.operation, meta.actorAgentId, commitmentId, JSON.stringify(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Two concurrent callers with the same idempotency key both pass the
      // pre-commit SELECT (neither has committed yet) and race to insert
      // the same primary key; the loser sees a unique violation here
      // rather than a serialization failure. Re-read the winner's stored
      // result and hand back the same replay instead of erroring.
      if ((err as { code?: string }).code === '23505') {
        const replay = await pool.query<{ result: T }>(
          'SELECT result FROM operation_results WHERE idempotency_key = $1',
          [meta.idempotencyKey],
        );
        if (replay.rows.length > 0) {
          return replay.rows[0].result;
        }
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Plain serializable transaction, no idempotency table involved. */
export async function withTxn<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function nextSequence(client: PoolClient, commitmentId: string): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM commitment_events WHERE commitment_id = $1',
    [commitmentId],
  );
  return rows[0].next;
}
