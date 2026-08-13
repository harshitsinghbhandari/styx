import type { CommitmentEvent } from '../api/types';

/**
 * Typed row record for the ticker, opencode's `timeline-row.ts` pattern:
 * never render a raw commitment event directly, project it into a small
 * closed shape first. IDs and display strings only, no payload blob, so the
 * renderer stays dumb and this function stays trivially unit-testable.
 */
export interface TickerRow {
  key: string;
  time: string;
  commitmentId: string;
  shortId: string;
  kind: 'transition' | 'created' | 'linked' | 'other';
  from: string | null;
  to: string | null;
  actorId: string | null;
  reason: string | null;
  eventType: string;
}

const TRANSITION_TYPES = new Set(['activated', 'fulfilled', 'broken', 'revoked', 'flagged_at_risk', 'repaired']);

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Pure: one raw commitment event in, one typed row out. No I/O, no clock reads. */
export function projectRow(event: CommitmentEvent): TickerRow {
  let kind: TickerRow['kind'] = 'other';
  if (event.event_type === 'created') kind = 'created';
  else if (event.event_type === 'dependency_linked') kind = 'linked';
  else if (TRANSITION_TYPES.has(event.event_type)) kind = 'transition';

  return {
    key: event.id,
    time: event.created_at,
    commitmentId: event.commitment_id,
    shortId: shortId(event.commitment_id),
    kind,
    from: event.from_status,
    to: event.to_status,
    actorId: event.actor_agent_id,
    reason: event.reason,
    eventType: event.event_type,
  };
}

/** Pure: (events) -> Row[], deterministic, preserves input order. */
export function projectRows(events: CommitmentEvent[]): TickerRow[] {
  return events.map(projectRow);
}
