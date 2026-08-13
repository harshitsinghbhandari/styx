import type { Pool } from 'pg';
import type { CommitmentRow } from '../kinds/registry.js';

export interface GraphEdge {
  from: string;
  to: string;
  dependency_type: string;
}

export interface Graph {
  nodes: CommitmentRow[];
  edges: GraphEdge[];
}

interface DependencyEdgeRow {
  commitment_id: string;
  depends_on_id: string;
  dependency_type: string;
}

/** Nodes + edges for the UI: rootId plus everything it transitively depends on or is depended on by. */
export async function buildGraph(pool: Pool, rootId: string): Promise<Graph> {
  const { rows: upEdges } = await pool.query<DependencyEdgeRow>(
    `WITH RECURSIVE up AS (
       SELECT commitment_id, depends_on_id, dependency_type FROM commitment_dependencies WHERE commitment_id = $1
       UNION
       SELECT cd.commitment_id, cd.depends_on_id, cd.dependency_type FROM commitment_dependencies cd
       JOIN up ON cd.commitment_id = up.depends_on_id
     )
     SELECT commitment_id, depends_on_id, dependency_type FROM up`,
    [rootId],
  );
  const { rows: downEdges } = await pool.query<DependencyEdgeRow>(
    `WITH RECURSIVE down AS (
       SELECT commitment_id, depends_on_id, dependency_type FROM commitment_dependencies WHERE depends_on_id = $1
       UNION
       SELECT cd.commitment_id, cd.depends_on_id, cd.dependency_type FROM commitment_dependencies cd
       JOIN down ON cd.depends_on_id = down.commitment_id
     )
     SELECT commitment_id, depends_on_id, dependency_type FROM down`,
    [rootId],
  );

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of [...upEdges, ...downEdges]) {
    const key = `${e.commitment_id}->${e.depends_on_id}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ from: e.commitment_id, to: e.depends_on_id, dependency_type: e.dependency_type });
  }

  const nodeIds = new Set<string>([rootId]);
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }

  const { rows: nodes } = await pool.query<CommitmentRow>('SELECT * FROM commitments WHERE id = ANY($1)', [
    [...nodeIds],
  ]);

  return { nodes, edges };
}
