// Seed helper: idempotently creates the runner's own agent row. Standalone
// from the other agent's kernel/scripts/seed.ts by design (hard boundary:
// runner/ only). Per-run task resources are created at run start
// (styx.ts#ensureStageResources), not here; there is nothing else standing
// that the runner needs ahead of a run.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../kernel/src/db/pool.js';

export const RUNNER_AGENT_NAME = 'styx-runner';

export interface RunnerIdentity {
  runnerAgentId: string;
}

export async function bootstrap(pool: Pool = defaultPool): Promise<RunnerIdentity> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, kind, api_key_hash) VALUES ($1, 'runner', 'runner-local')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [RUNNER_AGENT_NAME],
  );
  return { runnerAgentId: rows[0].id };
}
