import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool, types } from 'pg';

// CockroachDB's INT is 64-bit (OID 20 / int8); node-postgres returns those
// as strings by default. Nothing the router reads approaches that range.
types.setTypeParser(20, (value: string) => parseInt(value, 10));

const DEFAULT_URL = 'postgresql://root@localhost:26257/styx?sslmode=disable';
const here = path.dirname(fileURLToPath(import.meta.url));

export function makePool(connectionString = process.env.DATABASE_URL ?? DEFAULT_URL): Pool {
  return new Pool({ connectionString, max: 10 });
}

export const pool = makePool();

/** Applies kernel/src/db/router.sql (additive, idempotent) so the router's dedupe table exists. */
export async function ensureSchema(p: Pool = pool): Promise<void> {
  const sql = readFileSync(path.join(here, '../../kernel/src/db/router.sql'), 'utf8');
  await p.query(sql);
}
