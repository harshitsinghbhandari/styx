import type { Edge, Node } from '@xyflow/react';
import type { Commitment, CommitmentStatus } from '../api/types';
import { shortId } from '../events/rowProjection';

export interface GraphEdgeInput {
  from: string;
  to: string;
  // The kernel's GET /v1/commitments/:id/graph (kernel/src/api/graph.ts)
  // selects only commitment_id/depends_on_id, not dependency_type, even
  // though commitment_dependencies has that column and the spec calls for
  // dashed 'replaces' edges. Not fixable from ui/ (kernel/ is out of
  // bounds for this task); this field is typed optionally so the dashed
  // rendering activates the moment the API starts sending it, and falls
  // back to a plain solid edge (the only thing observable today) until then.
  dependencyType?: string;
}

export interface CommitmentNodeData extends Record<string, unknown> {
  commitment: Commitment;
  label: string;
  status: CommitmentStatus;
}

export type CommitmentNode = Node<CommitmentNodeData>;

const KIND_SEPARATOR = ' · '; // middle dot, avoids an em/en dash per house style

export function summarizeTerms(commitment: Commitment): string {
  const terms = commitment.terms ?? {};
  if (commitment.kind === 'promise') {
    const deliver = typeof terms.deliver === 'string' ? terms.deliver : '?';
    const deadline = typeof terms.deadline === 'string' ? formatDate(terms.deadline) : '?';
    return `deliver ${deliver} by ${deadline}`;
  }
  if (commitment.kind === 'reservation') {
    const resource = typeof terms.resource === 'string' ? terms.resource : (commitment.resource_key ?? '?');
    const quantity = typeof terms.quantity === 'number' ? terms.quantity : '?';
    return `${resource} x${quantity}`;
  }
  return JSON.stringify(terms).slice(0, 40);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function nodeLabel(commitment: Commitment): string {
  return `${shortId(commitment.id)}${KIND_SEPARATOR}${commitment.kind}${KIND_SEPARATOR}${summarizeTerms(commitment)}`;
}

/**
 * Pure: commitments + dependency edges (as returned by the kernel API, or
 * merged client-side across several graph calls, see hooks/useStyxConsole)
 * -> React Flow nodes/edges carrying status in `data`. No positions here,
 * that is graph/layout.ts's job (dagre needs node sizes, which is a DOM
 * concern this function has no business knowing about).
 */
export function assembleGraph(
  commitments: Commitment[],
  edges: GraphEdgeInput[],
): { nodes: CommitmentNode[]; edges: Edge[] } {
  const nodes: CommitmentNode[] = commitments.map((commitment) => ({
    id: commitment.id,
    type: 'commitment',
    position: { x: 0, y: 0 },
    data: { commitment, label: nodeLabel(commitment), status: commitment.status },
  }));

  const knownIds = new Set(commitments.map((c) => c.id));
  const rfEdges: Edge[] = edges
    .filter((e) => knownIds.has(e.from) && knownIds.has(e.to))
    .map((e) => ({
      // commitment_id (from) depends_on depends_on_id (to): the prerequisite
      // must settle first, so the arrow is drawn to -> from.
      id: `${e.from}->${e.to}`,
      source: e.to,
      target: e.from,
      type: 'smoothstep',
      style: e.dependencyType === 'replaces' ? { strokeDasharray: '4 4' } : undefined,
    }));

  return { nodes, edges: rfEdges };
}
