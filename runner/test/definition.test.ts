import { describe, it, expect } from 'vitest';
import { parseDefinition, validateDefinition, computeRoots, type PipelineDef } from '../src/definition.js';

describe('definition: parsing', () => {
  it('parses a minimal YAML pipeline', () => {
    const def = parseDefinition(`
name: demo
stages:
  - id: a
    run: "true"
`);
    expect(def.name).toBe('demo');
    expect(def.stages).toHaveLength(1);
  });
});

describe('definition: validation', () => {
  it('accepts a valid linear pipeline', () => {
    const def: PipelineDef = { name: 'ok', stages: [{ id: 'a', run: 'true', on_success: ['b'] }, { id: 'b', run: 'true' }] };
    expect(validateDefinition(def)).toEqual({ ok: true, errors: [] });
  });

  it('accepts a valid agent stage', () => {
    const def: PipelineDef = { name: 'x', stages: [{ id: 'a', agent: { agentName: 'worker-1', mission: 'do the thing' } }] };
    expect(validateDefinition(def)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an agent stage missing agentName or mission', () => {
    const def: PipelineDef = { name: 'x', stages: [{ id: 'a', agent: { model: 'x' } } as any] };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("requires 'agent.agentName'"))).toBe(true);
    expect(result.errors.some((e) => e.includes("requires 'agent.mission'"))).toBe(true);
  });

  it('rejects a stage declaring both run and agent', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [{ id: 'a', run: 'true', agent: { agentName: 'worker-1', mission: 'x' } }],
    };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly one executor'))).toBe(true);
  });

  it('rejects a stage with neither run nor agent', () => {
    const def: PipelineDef = { name: 'x', stages: [{ id: 'a' }] };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("requires 'run' or 'agent'"))).toBe(true);
  });

  it('rejects an edge referencing an unknown stage', () => {
    const def: PipelineDef = { name: 'x', stages: [{ id: 'a', run: 'true', on_success: ['ghost'] }] };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown stage'))).toBe(true);
  });

  it('rejects a cycle', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [
        { id: 'a', run: 'true', on_success: ['b'] },
        { id: 'b', run: 'true', on_success: ['a'] },
      ],
    };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('requires needs to exactly match multiple inbound on_success edges', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [
        { id: 'a', run: 'true', on_success: ['d'] },
        { id: 'b', run: 'true', on_success: ['d'] },
        { id: 'd', run: 'true' }, // missing needs: [a, b]
      ],
    };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('needs must exactly list'))).toBe(true);
  });

  it('rejects a needs entry with no matching on_success edge back from that predecessor', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [
        { id: 'a', run: 'true' }, // forgot on_success: ['b']
        { id: 'b', run: 'true', needs: ['a'] },
      ],
    };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('does not route to it via on_success'))).toBe(true);
  });

  it('rejects a stage that is an on_failure target and also declares needs', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [
        { id: 'a', run: 'true', on_failure: 'rescue' },
        { id: 'gate', run: 'true', on_success: ['rescue'] },
        { id: 'rescue', run: 'true', needs: ['gate'] },
      ],
    };
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('on_failure never joins'))).toBe(true);
  });
});

describe('definition: roots', () => {
  it('finds stages nothing routes into', () => {
    const def: PipelineDef = {
      name: 'x',
      stages: [
        { id: 'a', run: 'true', on_success: ['b', 'c'] },
        { id: 'b', run: 'true' },
        { id: 'c', run: 'true' },
      ],
    };
    expect(computeRoots(def)).toEqual(['a']);
  });
});
