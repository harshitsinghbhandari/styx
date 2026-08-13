import type { TickerRow } from '../events/rowProjection';
import './Ticker.css';

interface TickerProps {
  rows: TickerRow[];
  onSelect: (id: string) => void;
}

// ponytail: plain overflow scroll, no virtualization. Demo event volume is a
// few hundred rows at most (MAX_ROWS caps the backing array in
// hooks/useStyxConsole.ts); if this becomes a real multi-day console,
// swap in @tanstack/virtual the way opencode's pierre/virtualizer.ts does.
export function Ticker({ rows, onSelect }: TickerProps) {
  return (
    <div className="ticker">
      {rows.length === 0 && <div className="ticker-empty">Waiting for events…</div>}
      <ul className="ticker-list">
        {rows.map((row) => (
          <li key={row.key} className={`ticker-row kind-${row.kind}`} onClick={() => onSelect(row.commitmentId)}>
            <span className="mono ticker-time">{formatTime(row.time)}</span>
            <code className="mono ticker-id">{row.shortId}</code>
            <span className="ticker-transition mono">
              {row.from ?? '·'} <span className="ticker-arrow">{'->'}</span> {row.to ?? '·'}
            </span>
            <span className="ticker-event">{row.eventType}</span>
            {row.actorId && <span className="mono ticker-actor">{row.actorId.slice(0, 8)}</span>}
            {row.reason && <span className="ticker-reason">"{row.reason}"</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}
