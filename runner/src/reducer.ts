// The pure reducer core, copied as a pattern from AO pipelines v2
// (research/ao-pipelines.md section 6, point 1): reduce(state, event) ->
// (state, effects), pure, no clock reads, no I/O, never mutates its input.
// Everything about "what happens next" in the DAG lives here; the engine
// (engine.ts) is the only thing allowed to turn an effect into I/O and feed
// the result back in as a new event.

import { computeRoots, inboundFailureSources, inboundSuccessSources, type PipelineDef, type StageDef } from './definition.js';

export type Outcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'skipped'
  // Reserved for the Day 3 agent executor (research doc: outcome taxonomy).
  // The command executor never produces these; kept in the union now so the
  // reducer and effect plumbing do not need a breaking change on Day 3.
  | 'no_signal'
  | 'no_output'
  | 'succeeded_unverified';

const TERMINAL: ReadonlySet<Outcome | 'pending' | 'running'> = new Set([
  'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped', 'no_signal', 'no_output', 'succeeded_unverified',
]);

export type StageStatus = 'pending' | 'running' | Outcome;

export interface StageState {
  id: string;
  status: StageStatus;
  attempt: number;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunState {
  runId: string;
  def: PipelineDef;
  status: RunStatus;
  stages: Record<string, StageState>;
}

export type Event =
  | { type: 'run_started'; at: string }
  | { type: 'stage_started'; stage: string; at: string }
  | { type: 'stage_exited'; stage: string; code: number; at: string }
  // Day 3 placeholder: agent stages are rejected at validate() today, so
  // this never fires in the command-executor-only Day 2 runner. Wired in
  // now so the event union does not need to change when it does.
  // ponytail: no_signal/no_output nudge logic is agent-executor territory,
  // deferred to Day 3; today done:false just settles failed.
  | { type: 'stage_signalled'; stage: string; done: boolean; at: string }
  | { type: 'stage_timed_out'; stage: string; at: string }
  | { type: 'stage_cancelled'; stage: string; at: string }
  // Added beyond the six events named in the brief: the only way a reservation
  // conflict (I/O, discovered by the engine performing a styx_reserve effect)
  // can update RunState is by round-tripping through reduce(), the same as
  // every other outcome. Without this, the engine would have to mutate state
  // itself outside the reducer to record a skip, breaking the single-writer/
  // single-mutator invariant that is the entire point of this design.
  | { type: 'stage_reservation_denied'; stage: string; reason: string; at: string };

export type Effect =
  | { type: 'start_stage'; stage: string }
  | { type: 'settle_stage'; stage: string; outcome: Outcome; reason?: string }
  | { type: 'styx_reserve'; stage: string }
  | { type: 'styx_transition'; stage: string; outcome: Outcome }
  | { type: 'styx_link'; stage: string; dependsOn: string[] }
  | { type: 'finish_run'; status: RunStatus };

export interface ReduceResult {
  state: RunState;
  effects: Effect[];
}

function cloneState(state: RunState): RunState {
  const stages: Record<string, StageState> = {};
  for (const [id, s] of Object.entries(state.stages)) stages[id] = { ...s };
  return { ...state, stages };
}

function stageDef(state: RunState, id: string): StageDef {
  const s = state.def.stages.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stage: ${id}`);
  return s;
}

/** Effects that ask the engine to reserve-then-run a stage. Always emitted as this pair, in this order. */
function startEffects(stage: string): Effect[] {
  return [
    { type: 'styx_reserve', stage },
    { type: 'start_stage', stage },
  ];
}

/**
 * Fixed-point cascade: any pending stage that can no longer possibly start
 * settles skipped, without ever running. Two ways a stage goes dead:
 *   - it needs a join over on_success predecessors and one of them already
 *     settled to something other than succeeded (the join can never fill);
 *   - it is only reachable via on_failure edges (a recovery/notify stage)
 *     and every one of those potential triggers has already settled without
 *     failing into it, so the first-arrival-wins edge will never fire.
 * Without the second case a recovery stage whose trigger succeeded normally
 * would sit pending forever and the run would never settle. Repeats because
 * skipping a stage can strand its own successors. Mirrors AO's
 * skipUnreachable (research doc section 3).
 */
function cascadeSkip(state: RunState, effects: Effect[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of state.def.stages) {
      const st = state.stages[stage.id];
      if (st.status !== 'pending') continue;

      const successPreds = inboundSuccessSources(state.def, stage.id);
      const failurePreds = inboundFailureSources(state.def, stage.id);
      if (successPreds.length === 0 && failurePreds.length === 0) continue; // a root, already started

      const joinDead = successPreds.some((p) => {
        const pStatus = state.stages[p].status;
        return TERMINAL.has(pStatus) && pStatus !== 'succeeded';
      });
      const canStartViaSuccess = successPreds.length > 0 && !joinDead;
      const canStartViaFailure = failurePreds.some((p) => !TERMINAL.has(state.stages[p].status));

      if (!canStartViaSuccess && !canStartViaFailure) {
        st.status = 'skipped';
        st.reason = joinDead ? 'a required predecessor did not succeed' : 'no predecessor routed into this stage';
        effects.push({ type: 'settle_stage', stage: stage.id, outcome: 'skipped', reason: st.reason });
        effects.push({ type: 'styx_transition', stage: stage.id, outcome: 'skipped' });
        changed = true;
      }
    }
  }
}

function allSettled(state: RunState): boolean {
  return Object.values(state.stages).every((s) => TERMINAL.has(s.status));
}

function computeRunStatus(state: RunState): RunStatus {
  const outcomes = Object.values(state.stages).map((s) => s.status as Outcome);
  if (outcomes.some((o) => o === 'failed' || o === 'timed_out' || o === 'no_signal' || o === 'no_output')) {
    return 'failed';
  }
  if (outcomes.every((o) => o === 'cancelled' || o === 'skipped')) {
    // A run where nothing ever actually ran is not a success.
    return outcomes.some((o) => o === 'cancelled') ? 'cancelled' : 'failed';
  }
  return 'succeeded';
}

/** Route a settled stage's outcome onward: on_success fan-out (join-aware) or first-arrival on_failure. */
function routeOutcome(state: RunState, stage: string, outcome: Outcome, effects: Effect[]): void {
  const def = stageDef(state, stage);

  if (outcome === 'succeeded') {
    for (const target of def.on_success ?? []) {
      const targetState = state.stages[target];
      if (targetState.status !== 'pending') continue;
      const predecessors = inboundSuccessSources(state.def, target);
      const ready = predecessors.every((p) => state.stages[p].status === 'succeeded');
      if (ready) {
        targetState.status = 'running';
        effects.push(...startEffects(target));
      }
    }
    return;
  }

  // Only a stage that actually ran and did not succeed routes via
  // on_failure (failed, timed_out). cancelled/skipped never route: cancelled
  // mirrors AO's "not routed to on_failure" rule (spec 13.2), skipped never
  // ran at all so there is nothing to hand off from.
  if (outcome === 'failed' || outcome === 'timed_out') {
    const target = def.on_failure;
    if (target) {
      const targetState = state.stages[target];
      // First arrival wins: only fires while the target is still pending.
      if (targetState.status === 'pending') {
        targetState.status = 'running';
        effects.push(...startEffects(target));
      }
    }
  }
}

function settleStage(state: RunState, stage: string, outcome: Outcome, at: string, effects: Effect[], reason?: string): void {
  const st = state.stages[stage];
  st.status = outcome;
  st.endedAt = at;
  if (reason) st.reason = reason;
  effects.push({ type: 'settle_stage', stage, outcome, reason });
  effects.push({ type: 'styx_transition', stage, outcome });
  routeOutcome(state, stage, outcome, effects);
  cascadeSkip(state, effects);
}

function maybeFinish(state: RunState, effects: Effect[]): void {
  if (allSettled(state)) {
    state.status = computeRunStatus(state);
    effects.push({ type: 'finish_run', status: state.status });
  }
}

export function reduce(state: RunState, event: Event): ReduceResult {
  const next = cloneState(state);
  const effects: Effect[] = [];

  switch (event.type) {
    case 'run_started': {
      for (const s of next.def.stages) {
        effects.push({ type: 'styx_link', stage: s.id, dependsOn: s.needs ?? [] });
      }
      const roots = computeRoots(next.def);
      for (const id of roots) {
        next.stages[id].status = 'running';
        effects.push(...startEffects(id));
      }
      break;
    }

    case 'stage_started': {
      const st = next.stages[event.stage];
      st.status = 'running';
      st.startedAt = event.at;
      break;
    }

    case 'stage_exited': {
      const outcome: Outcome = event.code === 0 ? 'succeeded' : 'failed';
      settleStage(next, event.stage, outcome, event.at, effects, event.code === 0 ? undefined : `exit code ${event.code}`);
      maybeFinish(next, effects);
      break;
    }

    case 'stage_signalled': {
      const outcome: Outcome = event.done ? 'succeeded_unverified' : 'failed';
      settleStage(next, event.stage, outcome, event.at, effects, event.done ? undefined : 'agent signalled failure');
      maybeFinish(next, effects);
      break;
    }

    case 'stage_timed_out': {
      settleStage(next, event.stage, 'timed_out', event.at, effects, 'exceeded timeout_s');
      maybeFinish(next, effects);
      break;
    }

    case 'stage_cancelled': {
      settleStage(next, event.stage, 'cancelled', event.at, effects, 'cancelled');
      maybeFinish(next, effects);
      break;
    }

    case 'stage_reservation_denied': {
      settleStage(next, event.stage, 'skipped', event.at, effects, event.reason);
      maybeFinish(next, effects);
      break;
    }
  }

  return { state: next, effects };
}

export function initRunState(runId: string, def: PipelineDef): RunState {
  const stages: Record<string, StageState> = {};
  for (const s of def.stages) {
    stages[s.id] = { id: s.id, status: 'pending', attempt: 0 };
  }
  return { runId, def, status: 'running', stages };
}

export function inboundFailure(def: PipelineDef, target: string): string[] {
  return inboundFailureSources(def, target);
}
