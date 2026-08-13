import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CommitmentNode as CommitmentNodeType } from '../graph/assemble';

const DIM_STATUSES = new Set(['fulfilled', 'revoked', 'draft']);

export function CommitmentNode({ data, selected }: NodeProps<CommitmentNodeType>) {
  const { commitment, status } = data;
  const dimmed = DIM_STATUSES.has(status);

  return (
    <div
      className={`commitment-node status-${status}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
      data-status={status}
    >
      <Handle type="target" position={Position.Top} />
      <div className="commitment-node-kind mono">{commitment.kind}</div>
      <div className="commitment-node-label mono">{data.label.replace(`${commitment.kind} · `, '')}</div>
      <div className="commitment-node-status">{status}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = { commitment: CommitmentNode };
