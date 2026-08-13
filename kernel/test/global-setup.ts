import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://root@localhost:26257/styx?sslmode=disable';

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS styx');
  await admin.query('CREATE DATABASE styx');
  await admin.end();

  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const schema = readFileSync(path.join(here, '../src/db/schema.sql'), 'utf8');
  await db.query(schema);

  try {
    const precedents = readFileSync(path.join(here, '../src/db/precedents.sql'), 'utf8');
    await db.query(precedents);
  } catch (err) {
    console.warn('precedents.sql skipped (VECTOR unsupported on this CockroachDB build):', (err as Error).message);
  }
  await db.end();
}
