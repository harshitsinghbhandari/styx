import { useEffect, useState } from 'react';
import { getHistory } from '../api/client';
import { shortId } from '../events/rowProjection';
import type { Commitment, CommitmentEvent } from '../api/types';
import type { GraphEdgeInput } from '../graph/assemble';
import { BreakButton } from './BreakButton';
import './Inspector.css';

interface InspectorProps {
  commitment: Commitment | null;
  commitments: Map<string, Commitment>;
  edges: GraphEdgeInput[];
  onBreak: (id: string, reason: string) => Promise<void>;
}

export function Inspector({ commitment, commitments, edges, onBreak }: InspectorProps) {
  const [history, setHistory] = useState<CommitmentEvent[]>([]);

  useEffect(() => {
    if (!commitment) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    getHistory(commitment.id)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [commitment]);

  if (!commitment) {
    return (
      <aside className="inspector inspector-empty">
        <p>Select a commitment on the graph to inspect it.</p>
      </aside>
    );
  }

  // The kernel has no agent-lookup-by-id route (only /v1/agents/:id/obligations,
  // which returns commitments, not an agent record), so debtor/creditor render
  // as short ids rather than names. Noted as an API gap in the ship report.
  const dependsOn = edges.filter((e) => e.from === commitment.id).map((e) => commitments.get(e.to));
  const dependedOnBy = edges.filter((e) => e.to === commitment.id).map((e) => commitments.get(e.from));

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className={`status-pill status-${commitment.status}`}>{commitment.status}</span>
        <code className="mono inspector-id">{commitment.id}</code>
      </div>

      <BreakButton commitment={commitment} onBreak={onBreak} />

      <dl className="inspector-facts">
        <dt>kind</dt>
        <dd className="mono">{commitment.kind}</dd>
        <dt>version</dt>
        <dd className="mono">{commitment.version}</dd>
        <dt>valid until</dt>
        <dd className="mono">{commitment.valid_until ?? 'none'}</dd>
        <dt>debtor</dt>
        <dd className="mono">{shortId(commitment.debtor_agent_id)}</dd>
        <dt>creditor</dt>
        <dd className="mono">{shortId(commitment.creditor_agent_id)}</dd>
      </dl>

      <section className="inspector-section">
        <h3>terms</h3>
        <pre className="mono inspector-terms">{JSON.stringify(commitment.terms, null, 2)}</pre>
      </section>

      <section className="inspector-section">
        <h3>dependencies</h3>
        <div className="inspector-deps">
          <div>
            <h4>depends on</h4>
            {dependsOn.length === 0 && <p className="inspector-muted">none</p>}
            {dependsOn.map((c) => c && <div key={c.id} className={`dep-chip status-${c.status}`}>{shortId(c.id)}</div>)}
          </div>
          <div>
            <h4>depended on by</h4>
            {dependedOnBy.length === 0 && <p className="inspector-muted">none</p>}
            {dependedOnBy.map((c) => c && <div key={c.id} className={`dep-chip status-${c.status}`}>{shortId(c.id)}</div>)}
          </div>
        </div>
      </section>

      <section className="inspector-section">
        <h3>history</h3>
        <ol className="inspector-timeline">
          {history.map((event) => (
            <li key={event.id}>
              <span className="mono inspector-timeline-time">{formatTime(event.created_at)}</span>
              <span className="inspector-timeline-type">{event.event_type}</span>
              {event.from_status && event.to_status && (
                <span className="mono inspector-timeline-transition">
                  {event.from_status} to {event.to_status}
                </span>
              )}
              {event.reason && <span className="inspector-timeline-reason">"{event.reason}"</span>}
            </li>
          ))}
          {history.length === 0 && <li className="inspector-muted">no history yet</li>}
        </ol>
      </section>
    </aside>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}
