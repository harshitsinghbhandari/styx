import { describe, it, expect } from 'vitest';
import type { PipelineDef } from '../src/definition.js';
import { reduce, initRunState, type RunState, type Event } from '../src/reducer.js';

function run(def: PipelineDef, events: Event[]): RunState {
  let state = initRunState('test-run', def);
  for (const event of events) {
    state = reduce(state, event).state;
  }
  return state;
}

function reduceAll(def: PipelineDef, events: Event[]): { state: RunState; effectsByEvent: ReturnType<typeof reduce>['effects'][] } {
  let state = initRunState('test-run', def);
  const effectsByEvent: ReturnType<typeof reduce>['effects'][] = [];
  for (const event of events) {
    const r = reduce(state, event);
    state = r.state;
    effectsByEvent.push(r.effects);
  }
  return { state, effectsByEvent };
}

const at = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();

describe('reducer: happy path', () => {
  const def: PipelineDef = {
    name: 'linear',
    stages: [
      { id: 'a', run: 'true', on_success: ['b'] },
      { id: 'b', run: 'true' },
    ],
  };

  it('run_started starts the root, success routes to the next stage, run settles succeeded', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_started', stage: 'a', at: at(1) },
      { type: 'stage_exited', stage: 'a', code: 0, at: at(2) },
      { type: 'stage_started', stage: 'b', at: at(3) },
      { type: 'stage_exited', stage: 'b', code: 0, at: at(4) },
    ]);

    expect(state.stages.a.status).toBe('succeeded');
    expect(state.stages.b.status).toBe('succeeded');
    expect(state.status).toBe('succeeded');
  });

  it('run_started emits styx_link for every stage and start effects only for the root', () => {
    const { effects } = reduce(initRunState('r', def), { type: 'run_started', at: at(0) });
    const linkStages = effects.filter((e) => e.type === 'styx_link').map((e: any) => e.stage);
    expect(linkStages.sort()).toEqual(['a', 'b']);
    expect(effects.filter((e) => e.type === 'styx_reserve').map((e: any) => e.stage)).toEqual(['a']);
    expect(effects.filter((e) => e.type === 'start_stage').map((e: any) => e.stage)).toEqual(['a']);
  });

  it('a non-zero exit code settles failed', () => {
    const state = run(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_exited', stage: 'a', code: 1, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('failed');
    expect(state.stages.a.reason).toContain('1');
  });
});

describe('reducer: failure routing, first arrival wins', () => {
  const def: PipelineDef = {
    name: 'fan-in-failure',
    stages: [
      { id: 'a', run: 'false', on_failure: 'rescue' },
      { id: 'b', run: 'false', on_failure: 'rescue' },
      { id: 'rescue', run: 'true' },
    ],
  };

  it('the first failure claims the on_failure target; a later failure into the same target is dropped', () => {
    const { state, effectsByEvent } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_exited', stage: 'a', code: 1, at: at(1) },
      { type: 'stage_exited', stage: 'b', code: 1, at: at(2) },
    ]);

    expect(state.stages.a.status).toBe('failed');
    expect(state.stages.b.status).toBe('failed');
    expect(state.stages.rescue.status).toBe('running');

    const aEffects = effectsByEvent[1];
    expect(aEffects.some((e) => e.type === 'start_stage' && e.stage === 'rescue')).toBe(true);

    const bEffects = effectsByEvent[2];
    expect(bEffects.some((e) => e.type === 'start_stage' && e.stage === 'rescue')).toBe(false);
  });
});

describe('reducer: cascading skip on a dead join', () => {
  // diamond: a -> b, c -> d (needs b, c)
  const def: PipelineDef = {
    name: 'diamond',
    stages: [
      { id: 'a', run: 'true', on_success: ['b', 'c'] },
      { id: 'b', run: 'true', needs: ['a'], on_success: ['d'] },
      { id: 'c', run: 'true', needs: ['a'], on_success: ['d'] },
      { id: 'd', run: 'true', needs: ['b', 'c'] },
    ],
  };

  it('a failing predecessor skips the join, cascading, and the run settles failed', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_exited', stage: 'a', code: 0, at: at(1) },
      { type: 'stage_exited', stage: 'b', code: 1, at: at(2) },
      { type: 'stage_exited', stage: 'c', code: 0, at: at(3) },
    ]);

    expect(state.stages.a.status).toBe('succeeded');
    expect(state.stages.b.status).toBe('failed');
    expect(state.stages.c.status).toBe('succeeded');
    expect(state.stages.d.status).toBe('skipped');
    expect(state.stages.d.reason).toContain('predecessor');
    expect(state.status).toBe('failed');
  });

  it('when every predecessor succeeds the join stage starts', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_exited', stage: 'a', code: 0, at: at(1) },
      { type: 'stage_exited', stage: 'b', code: 0, at: at(2) },
      { type: 'stage_exited', stage: 'c', code: 0, at: at(3) },
      { type: 'stage_exited', stage: 'd', code: 0, at: at(4) },
    ]);
    expect(state.stages.d.status).toBe('succeeded');
    expect(state.status).toBe('succeeded');
  });
});

describe('reducer: an on_failure-only recovery stage never dangles', () => {
  const def: PipelineDef = {
    name: 'unused-rescue',
    stages: [
      { id: 'a', run: 'true', on_failure: 'rescue' },
      { id: 'rescue', run: 'true' },
    ],
  };

  it('settles the run instead of leaving the unused rescue stage pending forever', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_exited', stage: 'a', code: 0, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('succeeded');
    expect(state.stages.rescue.status).toBe('skipped');
    expect(state.status).toBe('succeeded');
  });
});

describe('reducer: timeout', () => {
  const def: PipelineDef = {
    name: 'slow',
    stages: [{ id: 'a', run: 'sleep 100', timeout_s: 1, on_failure: 'cleanup' }, { id: 'cleanup', run: 'true' }],
  };

  it('stage_timed_out settles timed_out and routes on_failure like a failure', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_timed_out', stage: 'a', at: at(1) },
      { type: 'stage_exited', stage: 'cleanup', code: 0, at: at(2) },
    ]);
    expect(state.stages.a.status).toBe('timed_out');
    expect(state.stages.cleanup.status).toBe('succeeded');
    expect(state.status).toBe('failed');
  });
});

describe('reducer: cancellation does not route to on_failure', () => {
  const def: PipelineDef = {
    name: 'cancel-me',
    stages: [{ id: 'a', run: 'sleep 100', on_failure: 'cleanup' }, { id: 'cleanup', run: 'true' }],
  };

  it('a cancelled stage settles cancelled without triggering its on_failure edge', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_cancelled', stage: 'a', at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('cancelled');
    expect(state.stages.cleanup.status).toBe('skipped');
  });
});

describe('reducer: stage_reservation_denied settles skipped without crashing', () => {
  const def: PipelineDef = {
    name: 'raced',
    stages: [
      { id: 'a', run: 'true', on_success: ['b'] },
      { id: 'b', run: 'true' },
    ],
  };

  it('cascades a dependent to skipped and the run settles', () => {
    const { state } = reduceAll(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_reservation_denied', stage: 'a', reason: 'claimed by another runner instance', at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('skipped');
    expect(state.stages.a.reason).toContain('another runner instance');
    expect(state.stages.b.status).toBe('skipped');
  });
});

describe('reducer: stage_signalled (Day 3 placeholder)', () => {
  const def: PipelineDef = { name: 'agent-stub', stages: [{ id: 'a', run: 'true' }] };

  it('done:true settles succeeded_unverified, done:false settles failed', () => {
    const ok = run(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, at: at(1) },
    ]);
    expect(ok.stages.a.status).toBe('succeeded_unverified');

    const bad = run(def, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: false, at: at(1) },
    ]);
    expect(bad.stages.a.status).toBe('failed');
  });
});
