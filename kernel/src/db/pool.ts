import { Pool, types } from 'pg';

// CockroachDB's INT is 64-bit (OID 20 / int8); node-postgres returns those
// as strings by default to avoid silent precision loss. version, sequence
// and capacity never approach that range, so parse them as JS numbers to
// keep strict equality and arithmetic on those columns working.
types.setTypeParser(20, (value: string) => parseInt(value, 10));

const DEFAULT_URL = 'postgresql://root@localhost:26257/styx?sslmode=disable';

export function makePool(connectionString = process.env.DATABASE_URL ?? DEFAULT_URL): Pool {
  return new Pool({ connectionString, max: 30 });
}

export const pool = makePool();
