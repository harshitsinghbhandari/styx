import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool, types } from 'pg';

// CockroachDB's INT is 64-bit (OID 20 / int8); node-postgres returns those
// as strings by default. Nothing the router reads approaches that range.
types.setTypeParser(20, (value: string) => parseInt(value, 10));

const DEFAULT_URL = 'postgresql://root@localhost:26257/styx?sslmode=disable';

export function makePool(connectionString = process.env.DATABASE_URL ?? DEFAULT_URL): Pool {
  return new Pool({ connectionString, max: 10 });
}

export const pool = makePool();

/**
 * Applies kernel/src/db/router.sql (additive, idempotent) so the router's
 * dedupe table exists. `here` is resolved lazily inside this function, not
 * at module top level: esbuild's cjs output (used for the Lambda bundle,
 * router/src/lambda.ts) empties import.meta.url, and this function is never
 * called in that path (the cloud schema is applied once via styx-migrate),
 * so the crash only needs avoiding, not the value fixing.
 */
export async function ensureSchema(p: Pool = pool): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.join(here, '../../kernel/src/db/router.sql'), 'utf8');
  await p.query(sql);
}
