// Pipeline definition: parsing and validation. Copies AO pipelines v2's
// "plan at start" idea (research/ao-pipelines.md section 6, point 2): walk
// the whole graph once, before anything runs, and fail loudly. No engine
// state here, no I/O beyond the one readFile/parse call in loadDefinition.

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

// Agent executor (Day 3): a stage names a fleet member (agentName, resolved
// to a kernel agent id at run time) and a free-text mission. No command,
// no prompt template, no model choice here -- those are the agent's own
// business (agent/src/policies/*); the runner only needs to know who owns
// the stage's delivery.
export interface AgentStageDef {
  agentName: string;
  mission: string;
}

export interface StageDef {
  id: string;
  // Command executor: argv array is the direct-exec form, a string is run
  // through a shell. Exactly one of run/agent is required.
  run?: string | string[];
  agent?: AgentStageDef;
  needs?: string[];
  on_success?: string[];
  on_failure?: string;
  timeout_s?: number;
  produces?: string;
}

export interface PipelineDef {
  name: string;
  stages: StageDef[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function parseDefinition(yamlText: string): PipelineDef {
  const doc = load(yamlText) as PipelineDef;
  if (!doc || typeof doc !== 'object') {
    throw new Error('pipeline definition must be a YAML mapping');
  }
  if (typeof doc.name !== 'string' || doc.name.length === 0) {
    throw new Error('pipeline definition requires a name');
  }
  if (!Array.isArray(doc.stages)) {
    throw new Error('pipeline definition requires a stages list');
  }
  return doc;
}

export function loadDefinitionFile(path: string): PipelineDef {
  return parseDefinition(readFileSync(path, 'utf8'));
}

/** Stages that route to `target` via on_success. */
export function inboundSuccessSources(def: PipelineDef, target: string): string[] {
  return def.stages.filter((s) => (s.on_success ?? []).includes(target)).map((s) => s.id);
}

/** Stages that route to `target` via on_failure. */
export function inboundFailureSources(def: PipelineDef, target: string): string[] {
  return def.stages.filter((s) => s.on_failure === target).map((s) => s.id);
}

/** Roots: stages nothing routes into, started concurrently at run_started. */
export function computeRoots(def: PipelineDef): string[] {
  const hasInbound = new Set<string>();
  for (const s of def.stages) {
    for (const t of s.on_success ?? []) hasInbound.add(t);
    if (s.on_failure) hasInbound.add(s.on_failure);
  }
  return def.stages.filter((s) => !hasInbound.has(s.id)).map((s) => s.id);
}

/** 3-color cycle detection over on_success UNION on_failure, ported from AO's dag.go idea. */
function findFirstCycle(def: PipelineDef): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(def.stages.map((s) => [s.id, WHITE]));
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const stack: string[] = [];

  function edges(id: string): string[] {
    const s = byId.get(id);
    if (!s) return [];
    const out = [...(s.on_success ?? [])];
    if (s.on_failure) out.push(s.on_failure);
    return out;
  }

  function visit(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of edges(id)) {
      if (!byId.has(next)) continue; // reported separately as a dangling edge
      const c = color.get(next);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        return [...stack.slice(cycleStart), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const s of def.stages) {
    if (color.get(s.id) === WHITE) {
      const found = visit(s.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Validate: DAG (no cycles), edges reference real stages, on_failure never
 * joins, agent stages rejected (Day 3). Does not mutate def; call before
 * freezing a copy for a run.
 */
export function validateDefinition(def: PipelineDef): ValidationResult {
  const errors: string[] = [];
  const ids = new Set(def.stages.map((s) => s.id));

  if (ids.size !== def.stages.length) {
    errors.push('duplicate stage ids');
  }

  for (const s of def.stages) {
    if (s.run !== undefined && s.agent !== undefined) {
      errors.push(`stage '${s.id}': declares both 'run' and 'agent', a stage is exactly one executor`);
    } else if (s.agent !== undefined) {
      const a = s.agent as Partial<AgentStageDef>;
      if (typeof a.agentName !== 'string' || a.agentName.length === 0) {
        errors.push(`stage '${s.id}': agent stage requires 'agent.agentName'`);
      }
      if (typeof a.mission !== 'string' || a.mission.length === 0) {
        errors.push(`stage '${s.id}': agent stage requires 'agent.mission'`);
      }
    } else if (s.run === undefined) {
      errors.push(`stage '${s.id}': stage requires 'run' or 'agent'`);
    }
    for (const t of s.needs ?? []) {
      if (!ids.has(t)) errors.push(`stage '${s.id}': needs references unknown stage '${t}'`);
    }
    for (const t of s.on_success ?? []) {
      if (!ids.has(t)) errors.push(`stage '${s.id}': on_success references unknown stage '${t}'`);
    }
    if (s.on_failure !== undefined && !ids.has(s.on_failure)) {
      errors.push(`stage '${s.id}': on_failure references unknown stage '${s.on_failure}'`);
    }
  }

  // needs required and exact-matched when a stage has more than one inbound
  // success edge (mirrors AO's join-ambiguity rule, research doc section 2).
  for (const s of def.stages) {
    const inbound = inboundSuccessSources(def, s.id).sort();
    if (inbound.length > 1) {
      const declared = [...(s.needs ?? [])].sort();
      if (declared.length !== inbound.length || declared.some((v, i) => v !== inbound[i])) {
        errors.push(`stage '${s.id}': has ${inbound.length} inbound on_success edges, needs must exactly list [${inbound.join(', ')}]`);
      }
    }
  }

  // needs only means something if the predecessor actually routes to this
  // stage: on_success is the sole fan-out mechanism (research doc section
  // 2), needs is the target-side join assertion. A needs entry with no
  // matching on_success edge back from that predecessor is a dead
  // declaration: the stage would never actually be waited for, it would
  // just be silently unreachable (no inbound edges at all makes a stage a
  // root, started immediately, needs or not).
  for (const s of def.stages) {
    for (const n of s.needs ?? []) {
      if (ids.has(n) && !(def.stages.find((x) => x.id === n)?.on_success ?? []).includes(s.id)) {
        errors.push(`stage '${s.id}': needs '${n}' but '${n}' does not route to it via on_success`);
      }
    }
  }

  // on_failure never joins: a stage reached by on_failure cannot also
  // declare a needs-join, since first-arrival-wins semantics on the
  // failure edge are incompatible with waiting for every predecessor.
  for (const s of def.stages) {
    if (inboundFailureSources(def, s.id).length > 0 && (s.needs ?? []).length > 0) {
      errors.push(`stage '${s.id}': is an on_failure target and cannot also declare needs (on_failure never joins)`);
    }
  }

  const cycle = findFirstCycle(def);
  if (cycle) {
    errors.push(`cycle detected: ${cycle.join(' -> ')}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Deep, frozen copy the run carries; edits to the source definition after this cannot affect an in-flight run. */
export function freezeDefinition(def: PipelineDef): PipelineDef {
  return structuredClone(def);
}
