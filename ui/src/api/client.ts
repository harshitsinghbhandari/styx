import type { Commitment, CommitmentEvent, Graph, TransitionAction } from './types';

// Empty string means same-origin relative paths, which is what both the dev
// proxy (vite.config.ts) and the Fargate deploy (UI served behind the API)
// want. An absolute VITE_API_URL is only for pointing the built app at a
// different host, which then needs the kernel's own CORS story (out of
// scope here, kernel/ is off limits for this task).
const API_BASE = import.meta.env.VITE_API_URL ?? '';

const KEY_STORAGE = 'styx.apiKey';

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? import.meta.env.VITE_STYX_API_KEY ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const key = getApiKey();
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (init.body) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function getCommitment(id: string): Promise<Commitment> {
  return request(`/v1/commitments/${id}`);
}

export function getGraph(rootId: string): Promise<Graph> {
  return request(`/v1/commitments/${rootId}/graph`);
}

export function getHistory(id: string): Promise<CommitmentEvent[]> {
  return request(`/v1/commitments/${id}/history`);
}

/** ponytail: crypto.randomUUID covers idempotency-key generation, no uuid dependency needed. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function transition(
  id: string,
  action: TransitionAction,
  expectedVersion: number,
  reason?: string,
): Promise<{ commitment: Commitment; event: CommitmentEvent }> {
  return request(`/v1/commitments/${id}/transitions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': newIdempotencyKey() },
    body: JSON.stringify({ action, expectedVersion, reason }),
  });
}
