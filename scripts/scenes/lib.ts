// Shared scaffolding for the headless scene scripts (scripts/scenes/scene*.ts):
// db reset/seed helpers, an in-process kernel API server (no separate
// process to babysit), and a tiny PASS/FAIL assertion log. Each scene owns
// its own module-level pass/fail state since each runs as its own process.
import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { makePool } from '../../kernel/src/db/pool.js';
import { buildApp } from '../../kernel/src/api/app.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SeededAgent {
  id: string;
  name: string;
  apiKey: string;
}

/**
 * Clears everything a scene builds fresh: agents, resources, commitments,
 * their events/dependencies, and the idempotency table. `keepPrecedents`
 * leaves the precedents table alone -- scene3 needs its accretion proof to
 * survive a second invocation of the script as a separate process.
 *
 * Plain DELETE, not TRUNCATE ... CASCADE: precedents.source_event is a
 * nullable FK onto commitment_events, and a TRUNCATE CASCADE on
 * commitment_events wipes precedents structurally regardless of whether
 * any row actually references it (regardless of keepPrecedents) -- CASCADE
 * truncates every table with a live FK onto the truncated table, not just
 * tables with a dangling reference. DELETE has no such all-or-nothing
 * requirement: since these scenes never set source_event, no precedents
 * row ever actually references a commitment_events row, so deleting
 * commitment_events plainly never touches precedents at all. Order
 * matters: children (rows with FKs onto commitments/agents/resources)
 * before the parents they reference.
 */
export async function resetDb(pool: Pool, opts: { keepPrecedents?: boolean } = {}): Promise<void> {
  await pool.query('DELETE FROM commitment_events');
  await pool.query('DELETE FROM commitment_dependencies');
  await pool.query('DELETE FROM operation_results');
  await pool.query('DELETE FROM commitments');
  await pool.query('DELETE FROM resources');
  await pool.query('DELETE FROM agents');
  if (!opts.keepPrecedents) {
    // Best-effort: local CockroachDB builds without VECTOR support never
    // created this table in the first place (kernel/test/global-setup.ts
    // does the same skip), so a missing table here is not a scene failure.
    await pool.query('DELETE FROM precedents').catch(() => {});
  }
}

export async function seedAgent(pool: Pool, name: string, kind: string): Promise<SeededAgent> {
  const apiKey = randomBytes(16).toString('hex');
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, $2, $3) RETURNING id',
    [name, kind, sha256(apiKey)],
  );
  return { id: rows[0].id, name, apiKey };
}

export async function seedResource(pool: Pool, key: string, capacity: number, ownerAgentId: string): Promise<void> {
  await pool.query('INSERT INTO resources (key, owner_agent, capacity) VALUES ($1, $2, $3)', [key, ownerAgentId, capacity]);
}

export interface SceneKernel {
  pool: Pool;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startSceneKernel(): Promise<SceneKernel> {
  const pool = makePool();
  const app = buildApp(pool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('kernel API did not bind');
  return {
    pool,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

let failed = false;

export function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   - ${message}`);
  } else {
    console.log(`  FAIL - ${message}`);
    failed = true;
  }
}

export function section(title: string): void {
  console.log(`\n-- ${title} --`);
}

export function finish(sceneName: string): void {
  if (failed) {
    console.log(`\nFAIL: ${sceneName}`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: ${sceneName}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(intervalMs);
  }
}
