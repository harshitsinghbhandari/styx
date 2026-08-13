import { useMemo } from 'react';
import { ReactFlow, Background, Controls, BackgroundVariant } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { assembleGraph, type GraphEdgeInput } from '../graph/assemble';
import { layoutGraph } from '../graph/layout';
import { nodeTypes } from './CommitmentNode';
import type { Commitment } from '../api/types';
import './DagPanel.css';

interface DagPanelProps {
  commitments: Map<string, Commitment>;
  edges: GraphEdgeInput[];
  selectedId: string | null;
  pulsing: Set<string>;
  onSelect: (id: string) => void;
}

export function DagPanel({ commitments, edges, selectedId, pulsing, onSelect }: DagPanelProps) {
  const { nodes, rfEdges } = useMemo(() => {
    const list = Array.from(commitments.values());
    const assembled = assembleGraph(list, edges);
    const laidOut = layoutGraph(assembled.nodes, assembled.edges);
    const withSelection = laidOut.map((node) => ({
      ...node,
      selected: node.id === selectedId,
      className: pulsing.has(node.id) ? 'pulse' : undefined,
    }));
    return { nodes: withSelection, rfEdges: assembled.edges };
  }, [commitments, edges, selectedId, pulsing]);

  if (nodes.length === 0) {
    return (
      <div className="dag-panel dag-panel-empty">
        <p>No commitments observed yet. Waiting for the event stream.</p>
      </div>
    );
  }

  return (
    <div className="dag-panel">
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
