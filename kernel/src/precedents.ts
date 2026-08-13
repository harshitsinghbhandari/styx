import type { Pool } from 'pg';
import { pool as defaultPool } from './db/pool.js';
import { titanEmbed } from './embedders/titan.js';

// v1-spec 9.2's ConflictContext is the natural-language conflict summary an
// agent hands the store; the embedder is the only thing that reads it.
export type ConflictContext = string;

export interface Precedent {
  id: string;
  situation: string;
  resolution: string;
  outcome: Record<string, unknown>;
  source_event: string | null;
  created_at: string;
}

export interface NewPrecedent {
  situation: string;
  resolution: string;
  outcome: Record<string, unknown>;
  sourceEvent?: string | null;
}

/** v1-spec 9.2. */
export interface PrecedentStore {
  findSimilar(situation: ConflictContext, limit: number): Promise<Precedent[]>;
  record(p: NewPrecedent): Promise<void>;
}

export type Embedder = (text: string) => Promise<number[]>;

const EMBEDDING_DIM = 1024;

/**
 * Deterministic local stub: a mulberry32 PRNG seeded from an FNV-1a hash of
 * the text fills 1024 floats, L2-normalized. It carries no semantic
 * meaning (similar text does not land close in this space) so it is only
 * proof that the vector plumbing works end to end before Bedrock is wired.
 * ponytail: swap for Bedrock Titan Text Embeddings V2 behind this same
 * Embedder signature once AWS credentials arrive; no call site changes.
 */
export async function stubEmbed(text: string): Promise<number[]> {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let seed = h >>> 0;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vec = Array.from({ length: EMBEDDING_DIM }, () => next() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** CockroachDB-backed PrecedentStore, same database as the commitments it describes. */
export class CockroachPrecedentStore implements PrecedentStore {
  constructor(
    private pool: Pool = defaultPool,
    private embed: Embedder = stubEmbed,
  ) {}

  async record(p: NewPrecedent): Promise<void> {
    const embedding = await this.embed(p.situation);
    await this.pool.query(
      `INSERT INTO precedents (situation, resolution, outcome, source_event, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [p.situation, p.resolution, JSON.stringify(p.outcome), p.sourceEvent ?? null, toVectorLiteral(embedding)],
    );
  }

  async findSimilar(situation: ConflictContext, limit: number): Promise<Precedent[]> {
    const embedding = await this.embed(situation);
    const { rows } = await this.pool.query<Precedent>(
      `SELECT id, situation, resolution, outcome, source_event, created_at
       FROM precedents
       ORDER BY embedding <-> $1::vector
       LIMIT $2`,
      [toVectorLiteral(embedding), limit],
    );
    return rows;
  }
}

// EMBEDDER=titan swaps in Bedrock Titan Text Embeddings V2; unset (the
// default, and every existing test/local run) keeps the deterministic stub.
const defaultEmbedder: Embedder = process.env.EMBEDDER === 'titan' ? titanEmbed : stubEmbed;
export const precedentStore = new CockroachPrecedentStore(defaultPool, defaultEmbedder);
