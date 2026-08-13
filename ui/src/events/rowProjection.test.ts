import { describe, expect, it } from 'vitest';
import { projectRow, projectRows, shortId } from './rowProjection';
import type { CommitmentEvent } from '../api/types';

function makeEvent(overrides: Partial<CommitmentEvent> = {}): CommitmentEvent {
  return {
    id: 'evt-1',
    commitment_id: '12345678-aaaa-bbbb-cccc-000000000000',
    sequence: 1,
    event_type: 'activated',
    from_status: 'draft',
    to_status: 'active',
    actor_agent_id: 'agent-1',
    reason: null,
    payload: {},
    created_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('shortId', () => {
  it('takes the first 8 characters', () => {
    expect(shortId('12345678-aaaa-bbbb-cccc-000000000000')).toBe('12345678');
  });
});

describe('projectRow', () => {
  it('classifies a transition event and carries through display fields', () => {
    const row = projectRow(makeEvent());
    expect(row).toEqual({
      key: 'evt-1',
      time: '2026-08-13T10:00:00.000Z',
      commitmentId: '12345678-aaaa-bbbb-cccc-000000000000',
      shortId: '12345678',
      kind: 'transition',
      from: 'draft',
      to: 'active',
      actorId: 'agent-1',
      reason: null,
      eventType: 'activated',
    });
  });

  it('classifies a created event', () => {
    const row = projectRow(makeEvent({ event_type: 'created', from_status: null, to_status: 'draft' }));
    expect(row.kind).toBe('created');
  });

  it('classifies a dependency_linked event', () => {
    const row = projectRow(makeEvent({ event_type: 'dependency_linked' }));
    expect(row.kind).toBe('linked');
  });

  it('falls back to other for unrecognized event types', () => {
    const row = projectRow(makeEvent({ event_type: 'something_new' }));
    expect(row.kind).toBe('other');
  });

  it('carries a break reason through', () => {
    const row = projectRow(
      makeEvent({ event_type: 'broken', from_status: 'active', to_status: 'broken', reason: 'schema migration failed' }),
    );
    expect(row.reason).toBe('schema migration failed');
    expect(row.kind).toBe('transition');
  });
});

describe('projectRows', () => {
  it('maps every event and preserves order', () => {
    const events = [makeEvent({ id: 'a', sequence: 1 }), makeEvent({ id: 'b', sequence: 2, event_type: 'fulfilled' })];
    const rows = projectRows(events);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(rows[1].eventType).toBe('fulfilled');
  });

  it('is pure: same input produces equal output, no shared references mutated', () => {
    const events = [makeEvent()];
    const first = projectRows(events);
    const second = projectRows(events);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
