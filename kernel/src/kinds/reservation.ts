import type { PoolClient } from 'pg';
import type { CommitmentKind, Result } from './registry.js';
import { InvariantViolation, ResourceConflict } from '../errors.js';

export interface Window {
  from: string;
  to: string;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseWindow(terms: Record<string, unknown>): Window | undefined {
  if (terms.window === undefined) return undefined;
  const w = terms.window as Record<string, unknown>;
  return { from: w.from as string, to: w.to as string };
}

// A reservation whose terms lack a window blocks all windows (it is an
// exclusive claim on the resource with no time bound); a request without a
// window conflicts with every active reservation for the same reason.
function windowsOverlap(a?: Window, b?: Window): boolean {
  if (!a || !b) return true;
  return new Date(a.from).getTime() < new Date(b.to).getTime()
    && new Date(b.from).getTime() < new Date(a.to).getTime();
}

/**
 * Amendment 2: available = capacity - SUM(quantity of active/at_risk
 * reservations on this resource whose window overlaps the requested one).
 * Must run inside the same serializable transaction that activates the
 * reservation being checked.
 */
export async function checkReservationCapacity(
  client: PoolClient,
  resourceKey: string,
  quantity: number,
  window: Window | undefined,
  excludeCommitmentId?: string,
): Promise<void> {
  const resourceRes = await client.query<{ capacity: number }>(
    'SELECT capacity FROM resources WHERE key = $1',
    [resourceKey],
  );
  if (resourceRes.rows.length === 0) {
    throw new InvariantViolation(`unknown resource: ${resourceKey}`);
  }
  const capacity = resourceRes.rows[0].capacity;

  const params: unknown[] = [resourceKey];
  let sql = `SELECT id, terms FROM commitments
             WHERE resource_key = $1 AND kind = 'reservation' AND status IN ('active', 'at_risk')`;
  if (excludeCommitmentId) {
    params.push(excludeCommitmentId);
    sql += ` AND id != $${params.length}`;
  }

  const { rows } = await client.query<{ id: string; terms: Record<string, unknown> }>(sql, params);

  let reserved = 0;
  const conflicting: string[] = [];
  for (const row of rows) {
    const otherWindow = parseWindow(row.terms);
    if (windowsOverlap(window, otherWindow)) {
      reserved += row.terms.quantity as number;
      conflicting.push(row.id);
    }
  }

  const available = capacity - reserved;
  if (available < quantity) {
    throw new ResourceConflict({
      resource: resourceKey,
      requested: quantity,
      available,
      conflicting_commitment_ids: conflicting,
    });
  }
}

export const ReservationKind: CommitmentKind = {
  name: 'reservation',

  validateTerms(terms: unknown): Result {
    if (typeof terms !== 'object' || terms === null) {
      return { ok: false, error: 'terms must be an object' };
    }
    const t = terms as Record<string, unknown>;
    if (typeof t.resource !== 'string' || t.resource.length === 0) {
      return { ok: false, error: 'terms.resource is required' };
    }
    if (typeof t.quantity !== 'number' || !Number.isInteger(t.quantity) || t.quantity <= 0) {
      return { ok: false, error: 'terms.quantity must be a positive integer' };
    }
    if (t.window !== undefined) {
      const w = t.window as Record<string, unknown>;
      if (!isIsoDate(w.from) || !isIsoDate(w.to)) {
        return { ok: false, error: 'terms.window.from/to must be ISO timestamps' };
      }
      if (Date.parse(w.from as string) >= Date.parse(w.to as string)) {
        return { ok: false, error: 'terms.window.from must precede terms.window.to' };
      }
    }
    return { ok: true };
  },

  async validateActivation(ctx): Promise<Result> {
    const terms = ctx.commitment.terms;
    try {
      await checkReservationCapacity(
        ctx.client,
        ctx.commitment.resource_key as string,
        terms.quantity as number,
        parseWindow(terms),
        ctx.commitment.id,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async validateTransition(): Promise<Result> {
    return { ok: true };
  },
};
