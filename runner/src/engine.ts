// The actor: a single-writer loop per run. Pulls/derives an event, calls
// the pure reducer, performs the effects it returns (spawning processes,
// calling the kernel), and feeds results back in as new events. Mirrors AO
// pipelines v2's engine (research/ao-pipelines.md section 3): state
// mutation happens only inside dispatch(), and only synchronously before
// the first await, so concurrent dispatch() calls (multiple roots starting
// together, multiple stages exiting close together) interleave safely on
// Node's single-threaded event loop without an explicit lock, the same
// guarantee AO gets from one goroutine owning the run map.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dump } from 'js-yaml';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../kernel/src/db/pool.js';
import { ResourceConflict } from '../../kernel/src/index.js';
import { validateDefinition, freezeDefinition, type PipelineDef } from './definition.js';
import { reduce, initRunState, type RunState, type Event, type Effect } from './reducer.js';
import {
  ensureStageResources,
  createStageCommitment,
  linkStageDependencies,
  reserveStage,
  transitionStageCommitment,
} from './styx.js';
import { bootstrap } from './bootstrap.js';

export interface EngineOptions {
  pool?: Pool;
  runsDir?: string;
  /** Identifies this engine process for reservation idempotency keys; must differ across racing instances. Defaults to a fresh uuid. */
  instanceId?: string;
  clock?: () => string;
}

interface StageHandle {
  timer?: NodeJS.Timeout;
  killed: boolean;
}

export class Engine {
  private readonly pool: Pool;
  private readonly runsDir: string;
  private readonly instanceId: string;
  private readonly clock: () => string;

  private state!: RunState;
  private runnerAgentId!: string;
  private runStartedAt!: string;
  private readonly commitmentIds: Record<string, string> = {};
  // Stages this instance has no authority over: either it lost the
  // reservation race directly, or it is a descendant that this instance's
  // own (possibly stale) local view cascaded to skipped as a consequence.
  // The kernel commitment for any of these is left untouched here; whatever
  // instance actually won the race is the one that settles it for real.
  private readonly disowned = new Set<string>();
  private readonly handles: Record<string, StageHandle> = {};
  private settledResolve!: (state: RunState) => void;
  private readonly settled: Promise<RunState>;

  constructor(private readonly runId: string, private readonly rawDef: PipelineDef, opts: EngineOptions = {}) {
    this.pool = opts.pool ?? defaultPool;
    this.runsDir = opts.runsDir ?? path.join(process.cwd(), '.styx-runs');
    this.instanceId = opts.instanceId ?? randomUUID();
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.settled = new Promise((resolve) => { this.settledResolve = resolve; });
  }

  async start(): Promise<RunState> {
    const validation = validateDefinition(this.rawDef);
    if (!validation.ok) {
      throw new Error(`invalid pipeline definition: ${validation.errors.join('; ')}`);
    }
    const def = freezeDefinition(this.rawDef);

    const identity = await bootstrap(this.pool);
    this.runnerAgentId = identity.runnerAgentId;

    await ensureStageResources(this.pool, this.runId, def, this.runnerAgentId);

    this.state = initRunState(this.runId, def);
    this.writeRunFolder(def);

    await this.dispatch({ type: 'run_started', at: this.clock() });

    return this.settled;
  }

  status(): RunState {
    return this.state;
  }

  private runDir(): string {
    return path.join(this.runsDir, this.runId);
  }

  private writeRunFolder(def: PipelineDef): void {
    const dir = this.runDir();
    mkdirSync(path.join(dir, 'stage-logs'), { recursive: true });
    writeFileSync(path.join(dir, 'definition.yaml'), dump(def));
    this.writeProjection();
  }

  // run.json is a projection, rewritten whole, never read back as truth.
  private writeProjection(): void {
    writeFileSync(path.join(this.runDir(), 'run.json'), JSON.stringify(this.state, null, 2));
  }

  private log(stage: string, line: string): void {
    appendFileSync(path.join(this.runDir(), 'stage-logs', `${stage}.log`), line.endsWith('\n') ? line : `${line}\n`);
  }

  private async dispatch(event: Event): Promise<void> {
    if (event.type === 'run_started') this.runStartedAt = event.at;

    const { state, effects } = reduce(this.state, event);
    this.state = state;
    this.writeProjection();

    if (event.type === 'stage_reservation_denied') {
      for (const e of effects) {
        if (e.type === 'settle_stage' && e.outcome === 'skipped') this.disowned.add(e.stage);
      }
    }

    if (event.type === 'run_started') {
      const linkEffects = effects.filter((e): e is Extract<Effect, { type: 'styx_link' }> => e.type === 'styx_link');
      const rest = effects.filter((e) => e.type !== 'styx_link');
      await this.performStyxLinks(linkEffects);
      await this.performEffects(rest);
      return;
    }

    await this.performEffects(effects);
  }

  // Two phases so a join stage's dependency link never races its
  // dependency's own commitment creation, regardless of stage order in the
  // YAML: create+activate every stage's commitment first, then link.
  private async performStyxLinks(effects: Array<Extract<Effect, { type: 'styx_link' }>>): Promise<void> {
    for (const effect of effects) {
      const def = this.state.def.stages.find((s) => s.id === effect.stage)!;
      const commitment = await createStageCommitment(this.pool, this.runId, def, this.runnerAgentId, this.runStartedAt);
      this.commitmentIds[effect.stage] = commitment.id;
    }
    for (const effect of effects) {
      if (effect.dependsOn.length === 0) continue;
      const commitmentId = this.commitmentIds[effect.stage];
      const dependsOnIds = effect.dependsOn.map((id) => this.commitmentIds[id]);
      await linkStageDependencies(this.pool, commitmentId, dependsOnIds);
    }
  }

  private async performEffects(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      await this.performEffect(effect);
    }
  }

  private async performEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'styx_reserve': {
        try {
          await reserveStage(this.pool, this.runId, effect.stage, this.runnerAgentId, this.instanceId);
        } catch (err) {
          if (err instanceof ResourceConflict) {
            this.log(effect.stage, `reservation denied: ${err.message}`);
            await this.dispatch({ type: 'stage_reservation_denied', stage: effect.stage, reason: err.message, at: this.clock() });
            return;
          }
          throw err;
        }
        break;
      }

      case 'start_stage': {
        if (this.disowned.has(effect.stage)) return; // the paired styx_reserve above already routed this to skipped
        this.spawnStage(effect.stage);
        break;
      }

      case 'settle_stage': {
        this.log(effect.stage, `settled ${effect.outcome}${effect.reason ? `: ${effect.reason}` : ''}`);
        const timer = this.handles[effect.stage]?.timer;
        if (timer) clearTimeout(timer);
        break;
      }

      case 'styx_transition': {
        if (this.disowned.has(effect.stage)) return;
        const commitmentId = this.commitmentIds[effect.stage];
        await transitionStageCommitment(
          this.pool,
          this.runId,
          effect.stage,
          commitmentId,
          effect.outcome,
          this.runnerAgentId,
          this.state.stages[effect.stage].reason,
        );
        break;
      }

      case 'finish_run': {
        this.writeProjection();
        this.settledResolve(this.state);
        break;
      }

      case 'styx_link':
        break; // handled specially in dispatch(), never reaches here
    }
  }

  private spawnStage(stage: string): void {
    const def = this.state.def.stages.find((s) => s.id === stage)!;
    const run = def.run!;
    const child = Array.isArray(run)
      ? spawn(run[0], run.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(run, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const handle: StageHandle = { killed: false };
    this.handles[stage] = handle;

    child.stdout?.on('data', (chunk: Buffer) => this.log(stage, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.log(stage, chunk.toString()));

    if (def.timeout_s) {
      handle.timer = setTimeout(() => {
        handle.killed = true;
        child.kill('SIGKILL');
      }, def.timeout_s * 1000);
    }

    this.dispatch({ type: 'stage_started', stage, at: this.clock() }).catch((err) => this.onDispatchError(stage, err));

    child.on('close', (code) => {
      if (handle.timer) clearTimeout(handle.timer);
      const event: Event = handle.killed
        ? { type: 'stage_timed_out', stage, at: this.clock() }
        : { type: 'stage_exited', stage, code: code ?? 1, at: this.clock() };
      this.dispatch(event).catch((err) => this.onDispatchError(stage, err));
    });
  }

  private onDispatchError(stage: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(stage, `dispatch error: ${message}`);
    // eslint-disable-next-line no-console
    console.error(`[styx-runner] run ${this.runId} stage ${stage} dispatch error:`, message);
  }
}
