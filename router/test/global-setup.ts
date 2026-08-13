import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Mirrors kernel/test/global-setup.ts: the router reads the same commitments
// schema plus its own additive router.sql (processed_events).
const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://root@localhost:26257/styx_router_test?sslmode=disable';

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS styx_router_test');
  await admin.query('CREATE DATABASE styx_router_test');
  await admin.end();

  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const schema = readFileSync(path.join(here, '../../kernel/src/db/schema.sql'), 'utf8');
  await db.query(schema);
  const router = readFileSync(path.join(here, '../../kernel/src/db/router.sql'), 'utf8');
  await db.query(router);
  await db.end();
}
