import dagre from 'dagre';
import type { Edge } from '@xyflow/react';
import type { CommitmentNode } from './assemble';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 64;

/**
 * Assigns dagre-computed positions to already-assembled nodes/edges.
 * Deliberately separate from assemble.ts: dagre needs concrete node
 * dimensions, which is a rendering concern, not a data-projection one.
 */
export function layoutGraph(nodes: CommitmentNode[], edges: Edge[]): CommitmentNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: pos
        ? { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }
        : node.position,
    };
  });
}
