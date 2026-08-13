import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { Unauthorized } from './errors.js';

export interface AuthedAgent {
  id: string;
  name: string;
  kind: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AuthedAgent;
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Bearer API key per agent, checked against agents.api_key_hash (sha256). */
export async function authenticate(pool: Pool, request: FastifyRequest): Promise<AuthedAgent> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new Unauthorized();
  }
  const key = header.slice('Bearer '.length).trim();
  if (!key) throw new Unauthorized();

  const { rows } = await pool.query<AuthedAgent>('SELECT id, name, kind FROM agents WHERE api_key_hash = $1', [
    sha256(key),
  ]);
  if (rows.length === 0) throw new Unauthorized();
  return rows[0];
}
