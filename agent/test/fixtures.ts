// Test-only helper: boots the real kernel API in-process (no separate
// server, same pattern kernel/src/api/api.test.ts uses) and seeds fleet
// agents with known raw API keys, so agent-package tests exercise the real
// HTTP contract rather than a mock.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { makePool } from '../../kernel/src/db/pool.js';
import { buildApp } from '../../kernel/src/api/app.js';

export interface TestKernel {
  pool: Pool;
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestKernel(): Promise<TestKernel> {
  const pool = makePool();
  const app = buildApp(pool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    pool,
    app,
    baseUrl,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export interface SeededAgent {
  id: string;
  name: string;
  apiKey: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Fresh, randomly named agent + resource owner so parallel test files never collide. */
export async function seedAgent(pool: Pool, kind: string): Promise<SeededAgent> {
  const name = `${kind}-${randomUUID()}`;
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

/** A scratch dir for a MemoryStore/SessionStore pair, unique per call. */
export function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'styx-agent-test-'));
}

export function memoryDirFor(root: string, name: string): string {
  return path.join(root, name);
}
