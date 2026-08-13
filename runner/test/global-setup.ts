// Unlike the kernel's own global-setup, this does not drop/recreate the
// database: another agent's kernel/router work runs against the same local
// CockroachDB instance, and dropping the database out from under it would
// be its own kind of resource conflict. Schema application is idempotent
// (CREATE TABLE IF NOT EXISTS in kernel/src/db/schema.sql), so running it
// here just guarantees the tables exist if this suite happens to run first.
// Runner tests isolate themselves with fresh random run ids rather than a
// clean-slate truncate.
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
  await db.end();
}
