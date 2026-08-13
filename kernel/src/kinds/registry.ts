import type { PoolClient } from 'pg';

export interface CommitmentRow {
  id: string;
  kind: string;
  protocol_version: string;
  debtor_agent_id: string;
  creditor_agent_id: string;
  resource_key: string | null;
  terms: Record<string, unknown>;
  status: string;
  valid_until: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export type Action = 'activate' | 'fulfill' | 'break' | 'revoke' | 'flag_at_risk' | 'repair';

export interface Result {
  ok: boolean;
  error?: string;
}

export interface KernelContext {
  client: PoolClient;
  commitment: CommitmentRow;
}

export interface TransitionContext {
  client: PoolClient;
  commitment: CommitmentRow;
  action: Action;
}

/** Extension point (v1-spec 9.1). Exactly two implementations ship day one. */
export interface CommitmentKind {
  name: string;
  validateTerms(terms: unknown): Result;
  validateActivation(ctx: KernelContext): Promise<Result>;
  validateTransition(ctx: TransitionContext): Promise<Result>;
}

const registry = new Map<string, CommitmentKind>();

export function registerKind(kind: CommitmentKind): void {
  registry.set(kind.name, kind);
}

export function getKind(name: string): CommitmentKind {
  const kind = registry.get(name);
  if (!kind) {
    throw new Error(`unknown commitment kind: ${name}`);
  }
  return kind;
}
