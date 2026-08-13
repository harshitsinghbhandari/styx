import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPipeline, coalesceByCommitment } from './pipeline';
import type { CommitmentEvent } from '../api/types';

function makeEvent(overrides: Partial<CommitmentEvent> = {}): CommitmentEvent {
  return {
    id: 'evt',
    commitment_id: 'c-1',
    sequence: 1,
    event_type: 'activated',
    from_status: 'draft',
    to_status: 'active',
    actor_agent_id: null,
    reason: null,
    payload: {},
    created_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('coalesceByCommitment', () => {
  it('keeps the last event per commitment id', () => {
    const events = [
      makeEvent({ id: 'a', commitment_id: 'c-1', to_status: 'active' }),
      makeEvent({ id: 'b', commitment_id: 'c-2', to_status: 'active' }),
      makeEvent({ id: 'c', commitment_id: 'c-1', to_status: 'broken' }),
    ];
    const latest = coalesceByCommitment(events);
    expect(latest.size).toBe(2);
    expect(latest.get('c-1')?.id).toBe('c');
    expect(latest.get('c-1')?.to_status).toBe('broken');
    expect(latest.get('c-2')?.id).toBe('b');
  });
});

describe('EventPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flush before the interval elapses', () => {
    const onFlush = vi.fn();
    const pipeline = new EventPipeline(onFlush, 16);
    pipeline.start();
    pipeline.push(makeEvent());
    vi.advanceTimersByTime(10);
    expect(onFlush).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it('flushes once per interval with a coalesced batch, one row per event', () => {
    const onFlush = vi.fn();
    const pipeline = new EventPipeline(onFlush, 16);
    pipeline.start();

    pipeline.push(makeEvent({ id: 'a', commitment_id: 'c-1', to_status: 'active' }));
    pipeline.push(makeEvent({ id: 'b', commitment_id: 'c-1', event_type: 'broken', from_status: 'active', to_status: 'broken' }));
    pipeline.push(makeEvent({ id: 'c', commitment_id: 'c-2', to_status: 'active' }));

    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const batch = onFlush.mock.calls[0][0];
    expect(batch.rows).toHaveLength(3);
    expect(batch.rows.map((r: { key: string }) => r.key)).toEqual(['a', 'b', 'c']);
    expect(batch.latestByCommitment.size).toBe(2);
    expect(batch.latestByCommitment.get('c-1').id).toBe('b');

    pipeline.stop();
  });

  it('skips a flush with an empty queue instead of calling onFlush with nothing', () => {
    const onFlush = vi.fn();
    const pipeline = new EventPipeline(onFlush, 16);
    pipeline.start();
    vi.advanceTimersByTime(48);
    expect(onFlush).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it('batches a burst across many pushes into a single flush call', () => {
    const onFlush = vi.fn();
    const pipeline = new EventPipeline(onFlush, 16);
    pipeline.start();
    for (let i = 0; i < 50; i++) {
      pipeline.push(makeEvent({ id: `evt-${i}`, commitment_id: `c-${i % 5}` }));
    }
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].rows).toHaveLength(50);
    pipeline.stop();
  });

  it('stop() prevents further flushes', () => {
    const onFlush = vi.fn();
    const pipeline = new EventPipeline(onFlush, 16);
    pipeline.start();
    pipeline.stop();
    pipeline.push(makeEvent());
    vi.advanceTimersByTime(100);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
