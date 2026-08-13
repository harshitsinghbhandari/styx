// Mirrors runner/test/global-setup.ts: does not drop/recreate the database
// (kernel/router work runs against the same local CockroachDB instance),
// just guarantees the schema exists. Agent tests isolate themselves with
// randomly suffixed agent names rather than a clean-slate truncate.
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://root@localhost:26257/styx?sslmode=disable';

export default async function globalSetup(): Promise<void> {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const schema = readFileSync(path.join(here, '../../kernel/src/db/schema.sql'), 'utf8');
  await db.query(schema);

  // Best-effort, matches kernel/test/global-setup.ts: the repair policy's
  // precedent recording needs this table; local CockroachDB builds without
  // VECTOR support simply run without it, same as the kernel's own suite.
  try {
    const precedents = readFileSync(path.join(here, '../../kernel/src/db/precedents.sql'), 'utf8');
    await db.query(precedents);
  } catch (err) {
    console.warn('precedents.sql skipped (VECTOR unsupported on this CockroachDB build):', (err as Error).message);
  }

  await db.end();
}
