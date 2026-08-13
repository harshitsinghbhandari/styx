import { projectRows, type TickerRow } from './rowProjection';
import type { CommitmentEvent } from '../api/types';

export interface FlushBatch {
  rows: TickerRow[];
  latestByCommitment: Map<string, CommitmentEvent>;
}

const FLUSH_MS = 16;

/** Coalesce by commitment id: last event per commitment wins within a batch. */
export function coalesceByCommitment(events: CommitmentEvent[]): Map<string, CommitmentEvent> {
  const latest = new Map<string, CommitmentEvent>();
  for (const event of events) {
    latest.set(event.commitment_id, event);
  }
  return latest;
}

/**
 * Queue -> coalesce -> batch flush, opencode's event pipeline pattern
 * (research/opencode-webui.md section 4.1, "the single most valuable
 * pattern to port"). Incoming SSE events are queued, never applied to
 * state immediately. Every ~16ms the queue drains once and calls onFlush a
 * single time with both a full row list (ticker: one row per event, no
 * event is dropped) and a coalesced latest-status map (DAG: one update per
 * commitment even if it transitioned twice inside one frame). One flush is
 * one state transaction, so a burst of 50 events costs one re-render.
 */
export class EventPipeline {
  private queue: CommitmentEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onFlush: (batch: FlushBatch) => void,
    private flushMs = FLUSH_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(event: CommitmentEvent): void {
    this.queue.push(event);
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const drained = this.queue;
    this.queue = [];
    this.onFlush({ rows: projectRows(drained), latestByCommitment: coalesceByCommitment(drained) });
  }
}
