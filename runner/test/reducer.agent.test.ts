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

const at = (n: number) => new Date(2026, 0, 1, 0, 0, n).toISOString();

describe('reducer: agent stage outcome taxonomy', () => {
  const noProduces: PipelineDef = {
    name: 'agent-no-produces',
    stages: [{ id: 'a', agent: { agentName: 'worker-1', mission: 'do the thing' } }],
  };
  const withProduces: PipelineDef = {
    name: 'agent-with-produces',
    stages: [{ id: 'a', agent: { agentName: 'worker-1', mission: 'do the thing' }, produces: 'result.json' }],
  };

  it('done:true with no produces declared settles succeeded_unverified: the signal is the whole contract', () => {
    const state = run(noProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('succeeded_unverified');
  });

  it('done:false settles failed regardless of produces', () => {
    const state = run(withProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: false, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('failed');
    expect(state.stages.a.reason).toBe('agent signalled failure');
  });

  it('done:true with produces declared and verified present settles succeeded', () => {
    const state = run(withProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, producesOk: true, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('succeeded');
  });

  it('done:true with produces declared but missing/empty settles no_output: a claim is not evidence', () => {
    const state = run(withProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, producesOk: false, at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('no_output');
    expect(state.stages.a.reason).toContain('result.json');
  });

  it('silence past the timeout settles no_signal, distinct from a command stage timing out', () => {
    const state = run(noProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_agent_silent', stage: 'a', at: at(1) },
    ]);
    expect(state.stages.a.status).toBe('no_signal');
  });

  it('a late stage_started bookkeeping event (fired after the styx_reserve DB round trip) never regresses a stage a fast agent callback already settled', () => {
    // Real ordering under a fast-signalling agent: run_started's own reduce
    // already marks the root 'running' synchronously; the engine's
    // spawnAgentStage (and its 'stage_started' dispatch) only fires after
    // the styx_reserve effect's DB round trip completes, which can lose the
    // race to an agent that signals done immediately.
    const state = run(withProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, producesOk: true, at: at(1) },
      { type: 'stage_started', stage: 'a', at: at(2) }, // arrives late
    ]);
    expect(state.stages.a.status).toBe('succeeded');
    expect(state.status).toBe('succeeded');
  });

  it('no_output and no_signal both fail the run, matching failed/timed_out/no_output/no_signal in computeRunStatus', () => {
    const noOutputRun = run(withProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_signalled', stage: 'a', done: true, producesOk: false, at: at(1) },
    ]);
    expect(noOutputRun.status).toBe('failed');

    const noSignalRun = run(noProduces, [
      { type: 'run_started', at: at(0) },
      { type: 'stage_agent_silent', stage: 'a', at: at(1) },
    ]);
    expect(noSignalRun.status).toBe('failed');
  });
});
