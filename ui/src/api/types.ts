// Mirrors kernel/src/kinds/registry.ts CommitmentRow and
// kernel/src/transition.ts CommitmentEventRow. Kept as plain types, no
// codegen: the API surface is small enough that hand-copying beats
// standing up an OpenAPI/schema pipeline for a five-endpoint console.

export type CommitmentStatus = 'draft' | 'active' | 'at_risk' | 'fulfilled' | 'broken' | 'revoked';

export type CommitmentKind = 'promise' | 'reservation';

export interface Commitment {
  id: string;
  kind: string;
  protocol_version: string;
  debtor_agent_id: string;
  creditor_agent_id: string;
  resource_key: string | null;
  terms: Record<string, unknown>;
  status: CommitmentStatus;
  valid_until: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CommitmentEvent {
  id: string;
  commitment_id: string;
  sequence: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_agent_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: Commitment[];
  edges: GraphEdge[];
}

export type TransitionAction = 'activate' | 'fulfill' | 'break' | 'revoke';
