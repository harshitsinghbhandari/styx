import { describe, expect, it } from 'vitest';
import { assembleGraph, nodeLabel, summarizeTerms } from './assemble';
import type { Commitment } from '../api/types';

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    kind: 'reservation',
    protocol_version: '1',
    debtor_agent_id: 'agent-debtor',
    creditor_agent_id: 'agent-creditor',
    resource_key: 'task:build-auth',
    terms: { resource: 'task:build-auth', quantity: 1 },
    status: 'active',
    valid_until: null,
    version: 1,
    created_at: '2026-08-13T09:00:00.000Z',
    updated_at: '2026-08-13T09:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeTerms', () => {
  it('summarizes a reservation as resource x quantity', () => {
    expect(summarizeTerms(makeCommitment())).toBe('task:build-auth x1');
  });

  it('summarizes a promise as deliver X by deadline', () => {
    const promise = makeCommitment({ kind: 'promise', terms: { deliver: 'schema migration', deadline: '2026-08-14T00:00:00.000Z' } });
    expect(summarizeTerms(promise)).toBe('deliver schema migration by Aug 14');
  });

  it('falls back to raw terms JSON for an unknown kind', () => {
    const other = makeCommitment({ kind: 'lease', terms: { foo: 'bar' } });
    expect(summarizeTerms(other)).toBe('{"foo":"bar"}');
  });
});

describe('nodeLabel', () => {
  it('joins short id, kind, and terms summary', () => {
    expect(nodeLabel(makeCommitment())).toBe('aaaaaaaa · reservation · task:build-auth x1');
  });
});

describe('assembleGraph', () => {
  it('projects commitments into React Flow nodes carrying status', () => {
    const commitment = makeCommitment();
    const { nodes } = assembleGraph([commitment], []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(commitment.id);
    expect(nodes[0].type).toBe('commitment');
    expect(nodes[0].data.status).toBe('active');
    expect(nodes[0].data.commitment).toBe(commitment);
  });

  it('draws an edge from the prerequisite (depends_on_id) to the dependent (commitment_id)', () => {
    const a = makeCommitment({ id: 'a' });
    const b = makeCommitment({ id: 'b' });
    const { edges } = assembleGraph([a, b], [{ from: 'b', to: 'a' }]);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('a');
    expect(edges[0].target).toBe('b');
  });

  it('drops edges referencing a commitment not in the node set', () => {
    const a = makeCommitment({ id: 'a' });
    const { edges } = assembleGraph([a], [{ from: 'a', to: 'missing' }]);
    expect(edges).toHaveLength(0);
  });

  it('renders a replaces-typed edge dashed when dependencyType is present', () => {
    const a = makeCommitment({ id: 'a' });
    const b = makeCommitment({ id: 'b' });
    const { edges } = assembleGraph([a, b], [{ from: 'b', to: 'a', dependencyType: 'replaces' }]);
    expect(edges[0].style).toEqual({ strokeDasharray: '4 4' });
  });

  it('renders a requires edge (or one with no dependencyType) solid', () => {
    const a = makeCommitment({ id: 'a' });
    const b = makeCommitment({ id: 'b' });
    const { edges } = assembleGraph([a, b], [{ from: 'b', to: 'a' }]);
    expect(edges[0].style).toBeUndefined();
  });
});
