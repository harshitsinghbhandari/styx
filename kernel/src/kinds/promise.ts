import type { CommitmentKind, Result } from './registry.js';

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export const PromiseKind: CommitmentKind = {
  name: 'promise',

  validateTerms(terms: unknown): Result {
    if (typeof terms !== 'object' || terms === null) {
      return { ok: false, error: 'terms must be an object' };
    }
    const t = terms as Record<string, unknown>;
    if (typeof t.deliver !== 'string' || t.deliver.length === 0) {
      return { ok: false, error: 'terms.deliver is required' };
    }
    if (!isIsoDate(t.deadline)) {
      return { ok: false, error: 'terms.deadline must be an ISO timestamp' };
    }
    return { ok: true };
  },

  async validateActivation(): Promise<Result> {
    return { ok: true };
  },

  async validateTransition(): Promise<Result> {
    return { ok: true };
  },
};
