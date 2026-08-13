import { useMemo } from 'react';
import type { Commitment, CommitmentStatus } from '../api/types';
import './StatusChips.css';

interface StatusChipsProps {
  commitments: Map<string, Commitment>;
}

const CHIP_STATUSES: CommitmentStatus[] = ['active', 'at_risk', 'fulfilled', 'broken', 'revoked'];

export function StatusChips({ commitments }: StatusChipsProps) {
  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const c of commitments.values()) {
      tally[c.status] = (tally[c.status] ?? 0) + 1;
    }
    return tally;
  }, [commitments]);

  return (
    <div className="status-chips">
      {CHIP_STATUSES.map((status) => (
        <span key={status} className={`status-chip status-${status}`}>
          <span className="status-chip-count">{counts[status] ?? 0}</span>
          <span className="status-chip-label">{status}</span>
        </span>
      ))}
    </div>
  );
}
