# Agent Orchestrator: parallel agent runs and Pipelines v2

Source: github.com/Untrivial-ai/agent-orchestrator, branch pr-2863 (PR #2863), cloned to
/tmp/research-ao. All paths below are repo-relative to that checkout.

## 1. The session model AO builds on

AO's base unit of parallel work is a session: one agent process (a harness like
claude-code) attached to a tmux-style terminal, running inside an isolated git
worktree, tracked by a durable row in SQLite. Several sessions run concurrently because
each owns its own worktree; they never share a working directory.

Persisted facts live in `domain.SessionRecord` (backend/internal/domain/session.go):
`ID`, `ProjectID`, `Kind` (worker or orchestrator), `Harness`, `Activity`,
`FirstSignalAt`, `IsTerminated`, and a typed `SessionMetadata` blob (`Branch`,
`WorkspacePath`, `WorkspaceRepoPath`, `RuntimeHandleID`/`RuntimeLaunchID`,
`WorkspaceAdopted`, `AgentSessionID`, `Prompt`, `PreviewURL`). The package doc for
`backend/internal/lifecycle/manager.go` states the design intent directly: "activity_state
plus an is_terminated bit are the only persisted status-like facts on the session row."
Everything else (PR status, merge state, UI status like `working`/`pr_open`/`idle`/
`no_signal`) is derived at read time, not stored.

Isolation is git worktrees, not clones: `backend/internal/adapters/workspace/gitworktree/
workspace.go` (1400 lines; `commands.go`, `parse.go`, `remove.go` alongside it) wraps
`git worktree add/remove` against a project's canonical repo, sharing the object store so
provisioning costs a checkout, not a clone. `ports.WorkspaceConfig{ProjectID, SessionID,
Kind, Branch, BaseBranch, Path}` is the adapter's request shape; `Restore` creates or
reattaches a tree, `ForceDestroy` removes one. The adapter refuses any path outside its
managed root (`ErrUnsafePath`), and every teardown path checks
`SessionMetadata.WorkspaceAdopted` before touching a worktree, so a tree the session
does not own (see section on pipelines' fork of this below) is never deleted underneath
whoever does own it.

Lifecycle transitions run through a synchronous reducer:
`backend/internal/lifecycle/manager.go` (755 lines) and `reactions.go` (918 lines). The
manager exposes `sessionStore` (Get/Update/List session, list PRs by session, PR-nudge
dedup) and reacts to PR state, activity transitions, and termination requests; a
`pipelineMergeGate` interface is the one deliberate coupling to the pipeline package
(lifecycle asks "does a settled run block this PR's merge", pipelines never imports
lifecycle back). Feedback (nudges, injected text) routes to a session by ID through a
`SessionMessenger`-shaped seam; the CLI and any other agent-facing surface send into a
session, never into a run or a stage directly, except for the pipeline signal endpoint
described below.

Sessions are spawned via `ports.SpawnConfig` (session_manager package, not read in full
for this report) which the pipelines PR extends with an `Env map[string]string` field
(decision D9 in the implementation plan) so a spawned session's process environment can
carry arbitrary extra vars, merged after the base session env and project env (spawn
config wins on collision). This is the mechanism pipelines uses to inject `AO_RUN_ID`,
`AO_STAGE`, etc.

## 2. Pipeline definition model

Design doc: docs/plans/2026-07-26-pipelines-v2.md ("spec" below). Schema types:
backend/internal/pipeline/definition.go, schema.json, validate.go.

A `Pipeline` (YAML) has `name`, `on` (trigger spec: `pr: [created, updated, merge-ready,
merged]` and/or `session: [idle, exited, blocked]`), `concurrency` (`scope`, `group`,
`cancel-in-progress`), `defaults` (`deadline`, `on_failure`), and `stages: []Stage`.
A `Stage` has `id`, `executor` (`agent` | `command`), for agent stages `agent`+`prompt`+
optional `produces` (bare filename, no path separators) + `session.kill-on: []Outcome`,
for command stages `run` (shell script) + optional `credentials: []string`, plus shared
`workspace` (one of `auto`/`inherit`/`session`/`run`/`stage`/`checkout`, empty meaning
"defaulted by entry edge"), `deadline`, `on_success` (scalar or list, `StageList` custom
YAML unmarshal), `on_failure` (single id), `needs` (list, required and exact-matched when
a stage has more than one inbound success edge).

Edge semantics: `on_success` is the only fan-out mechanism (a list starts every target
concurrently). `on_failure` is single-target and never joins: first arrival wins, later
arrivals into a settled/non-pending target are dropped (spec 9.3,
`reducer.go:startFailureTarget`). A stage with no explicit `on_failure` inherits
`defaults.on_failure`, except the `defaults.on_failure` target itself, which does not
recurse into itself (the one deliberate carve-out so it cannot be flagged as a self-cycle).
Graph cycles over `on_success UNION on_failure` are rejected at validation time via a
ported 3-color cycle detector (`dag.go`, `FindFirstCycle(order, edges)`).

Triggers name a subject (`pipeline.Subject{Kind: session|pr|project, ProjectID,
SessionID, PR *PRRef}`, subject.go). A PR subject may or may not carry a `SessionID`
(sessionless PR runs are first-class, though the followups doc notes the CDC bridge
currently always resolves a session because `pr.session_id` is a NOT NULL FK, so the
sessionless path is implemented and unit-tested but has no live producer yet).

Workspace resolution (spec section 5, plan.go `resolveWorkspace`): the declared kind is
taken as-is; an unset kind resolves to `auto` if the stage was entered via a success edge,
or to `inherit` if entered only via failure edges. `auto` then resolves to `session` if
the subject has one, else `run`. The one illegal combination, `workspace: session` with
no session on the subject, is caught by `ComputePlan` before any stage runs
(`plan.go:63-65`), returning an error of the exact shape `stage 'review' requires
workspace 'session'; PR #412 has no local session`. `inherit` is rejected at validation
when a stage has more than one inbound success edge (ambiguous), same rule that leaves
`AO_PREV_*` unset at joins.

Concurrency groups (spec section 10, engine/concurrency.go): the effective key is
`(group or pipeline name, resolved scope identity)`. `scope` (`pr`/`session`/`project`)
picks which runs collide; an unset scope defaults to the subject's natural scope via
`Subject.DefaultScope()`. Runs sharing a key serialize; `cancel-in-progress: true` lets a
newcomer take the key by cancelling the incumbent; queue depth is 1 (a third arrival
evicts the second).

Frozen definitions: `CreateRunFolder` (runfolder.go) writes the definition's raw YAML
bytes, unmodified, into `<run>/definition.yaml` before anything else happens, so editing
the stored definition mid-run cannot affect an in-flight run. The reducer's `RunState.Def`
is that frozen snapshot, read-only and shared (not deep-copied) across every
copy-on-write clone of the run.

## 3. Execution model: engine, reducer, supervisor

The split is strict: `Reduce(RunState, Event) (RunState, []Effect)`
(backend/internal/pipeline/reducer.go, 594 lines) is a pure function: no clock reads, no
I/O, never mutates its input (copy-on-write via `RunState.clone()`, which shallow-shares
`Def`/`Subject` and deep-copies the `Stages` map). Everything about "what should happen
next" for the DAG lives there. The engine (backend/internal/pipeline/engine/engine.go,
1060 lines) is a single-goroutine actor per project, `New(cfg)` / `Start(ctx)`; every
exported method (`TriggerRun`, `Cancel`, `Tick`, `Run`, `Runs`) posts a closure onto a
`mailbox chan func()` and blocks until the actor runs it (`e.do`). Only the actor
goroutine ever reads or writes `e.runs` (`map[RunID]RunState`) or `e.inflight`
(`map[stageKey]executors.Handle`). Effect execution can synchronously feed further events
back through `Reduce` on the same goroutine (`dispatch` -> `execute` -> possibly
`dispatch` again), so there is no re-entrancy or interleaving to reason about. A
`Supervisor` (engine/supervisor.go) owns one `Engine` per project (lazy: `For(ctx,
projectID)` starts one on first use), the shared `ConcurrencyTable`, and the orphan
reaper's sweep ticker.

Run advancement, step by step: `TriggerRun` admits against the concurrency table
(`ConcurrencyTable.Admit`), allocates a `RunID` up front (so a queued trigger already
names the run it will become), then on the actor goroutine `startTrigger` creates the run
folder, freezes the definition, and dispatches `TriggerFired`. The reducer's
`reduceTriggerFired` calls `ComputePlan` (walks `on_success UNION on_failure` from the
entry stage, enumerates every reachable stage, resolves each stage's deadline and
workspace kind); every reachable stage is seeded `pending` in one shot (so the Kanban
board renders the whole shape immediately), and the entry stage's `StartStage` effect is
emitted. Each subsequent settlement (`AgentSignaled`, `CommandExited`, `SessionIdle`,
`SessionGone`, `Tick`, `CancelRequested`) is handled by `settleSuccess` or `settleFailure`,
which stamp the outcome, run `startSuccessTargets` / `startFailureTarget` to find what
starts next, then call `advance`, which runs `skipUnreachable` (cascades `skipped` onto
every stage nothing can route into anymore, fixed-point loop over `dead` set) and settles
the run (`RunSettled`) once `allSettled` is true. `settledRunStatus` rolls stage outcomes
into one of `pending|running|succeeded|failed|cancelled`: cancelled if the run was
cancelled, else failed if any stage settled in `{failed, no_output, no_signal,
timed_out}`, else succeeded (a `succeeded_unverified` or `skipped` stage does not flip a
run to failed).

### Outcome taxonomy, exactly when each is assigned (outcome.go, reducer.go)

- `succeeded`: `AgentSignaled{Done:true, ArtifactOK:true}` with `produces` declared, or
  `CommandExited{ExitCode:0}`.
- `succeeded_unverified`: `AgentSignaled{Done:true, ArtifactOK:true}` with no `produces`
  declared (there is nothing to verify, so the signal is the whole contract).
- `failed`: `AgentSignaled{Done:false}` (explicit `ao pipeline fail`, never nudged) or
  `CommandExited{ExitCode != 0}`, or a `StageLaunchFailed` event (the stage never got off
  the ground: workspace provision error, credential resolve error, executor Start error).
- `no_output`: signalled done (or went idle) with the declared artifact missing/empty,
  and the one nudge has already been spent (`Nudged[stage]` already true).
- `no_signal`: `SessionGone` (session exited without signalling, never nudged), or
  idle-without-signal on a stage with no `produces` after its one nudge is spent, or a
  restart-reconciliation event for a lost agent stage (see below).
- `timed_out`: `Tick` finds `now.After(DeadlineAt)` on a running stage; emits
  `InterruptStage` (kills the process, keeps the session) then routes failure.
- `cancelled`: `CancelRequested` settles every currently-running stage `cancelled` (not
  routed to `on_failure`, spec 13.2); every merely-pending stage instead becomes
  `skipped`.
- `skipped`: `skipUnreachable`'s cascade, whenever a predecessor did not succeed (or a
  join's `needs` set can never be satisfied).

**Nudge** (reducer.go `nudgeOrSettle`, spec 7.1): triggered by `AgentSignaled{Done:true,
ArtifactOK:false}` or `SessionIdle`. First arrival: the reducer records `Nudged[stage] =
true`, keeps the stage `running`, and emits a `NudgeStage` effect carrying one of two
verbatim messages (missing-artifact vs never-signalled). The stage is never relaunched;
the driver sends the message into the still-alive session via `SessionMessenger`, then
feeds `NudgeDelivered` back, which bumps `Attempt` from 1 to 2. Second arrival at the same
dead end settles `no_output` or `no_signal`. Exactly two attempts, not configurable.
Known divergence (per the followups doc): `AO_ATTEMPT` in the session's actual process
env stays 1 even after a nudge, because a running process's environment cannot be
rewritten; the agent only learns it is on attempt 2 from the nudge text itself.

**Settle signals**: `ao pipeline done` / `ao pipeline fail --reason "..."`
(backend/internal/cli/pipeline.go, endpoint in httpd/controllers/pipelines.go, `POST
/api/v1/pipelines/runs/{runId}/stages/{stageId}/signal`). The CLI resolves which run and
stage it is settling purely from its own process environment, `AO_RUN_ID` and
`AO_STAGE`, and **errors rather than guessing** if either is absent (spec 6.3). The
engine's poll loop (`pollInflight` -> `pollEvent`) checks the signal registry before
session activity (signal beats idle-detection).

**Restart reconciliation** (decision D16, `engine.go:reconcileLostStages`): on `Start`,
after hydrating unsettled runs from SQLite, any stage recorded `running` (or `pending`
with an `Attempt > 0`, meaning a launch was committed but never confirmed) that has no
live handle in `e.inflight` gets an honest settlement: an agent stage becomes
`SessionGone` -> `no_signal` (the session itself is not touched; it may well still be
alive, session teardown owns it separately); a command stage becomes `StageLaunchFailed`
-> `failed`, and its recorded `PGID` (persisted specifically so a restart can find it,
`state.go` comment) is handed to `executors.ProcessGroupReaper.Reap(pgid, startedAt)` to
attempt an OS-level kill before the stage settles, so the settlement and the actual
process state stay in sync where possible. The followups doc flags that this remains
imperfect: the reap can still race, and the "session exited" reason text on the
reconciled `no_signal` path is not literally true (the session is usually still alive in
tmux, just unwatched).

**Orphan handling** (spec 7.2-7.3, engine/orphans.go): after a stage settles, if its
outcome is not in the stage's `kill-on` list (default `[succeeded, failed]`; empty list
means never kill), the session is left alive and handed to `OrphanRegistry.Keep`, which
persists a `PipelineOrphanInfo{RunID, Stage, Outcome, KeptAt, Pipeline}` marker onto the
session row and enforces two fixed bounds per `(projectID, pipelineName)` key: a cap of
3 kept sessions (LRU eviction, oldest `keptAt` killed first) and a 24h TTL (swept hourly
from the supervisor's ticker, `OrphanRegistry.Sweep`). The ledger is read back from the
persisted session rows on every check, not from in-process state, so bounds survive a
daemon restart.

## 4. Run folder layout and state authority

```
<AO_DATA_DIR>/pipelines/<project-id>/<run-id>/
  definition.yaml       frozen copy, byte-identical to what triggered the run
  run.json              projection of RunState, rewritten whole on every persist
  Context.md            engine-written pointer index (absent until the first
                         verified artifact; agent preamble handles that case)
  agent-outputs/<name>  declared artifacts, named by produces:, not by stage id
  stage-logs/<stage>.log   command stages always; agent stages never (by design,
                         the session's own scrollback is the record)
  workspace/             one worktree shared by every `workspace: run` stage
  workspaces/<stage>/    fresh worktree per `workspace: stage` entry
```

(backend/internal/pipeline/runfolder.go). **SQLite is the authoritative store of
record** (decision D2): `Store.SavePipelineRun` persists the full `RunState` on every
`PersistRun` effect, including the definitions table's raw YAML, `pipeline_runs`,
`pipeline_stage_runs`, `pipeline_stage_signals`, `pipeline_credentials`. `run.json` is a
best-effort projection written alongside every SQLite save purely for humans/debugging;
losing it is logged and swallowed, never fatal. This was a deliberate rejection of a
files-are-truth design: the whole live-update chain (SQLite triggers, CDC change_log,
SSE, query invalidation) already rides SQLite, and file-authoritative state would have
meant rebuilding all of that for no user-visible gain.

## 5. Frontend structure (brief)

`PipelineCanvas.tsx` (513 lines) is the DAG editor: one card (`StageDraft`) per stage,
laid out via dagre (`layoutPositions`), two source handles per node (right = on_success,
bottom = on_failure per the "v2 routing is a state machine with two edge kinds" comment),
cycle detection flashes a red dashed edge. `PipelineRunGraph.tsx` is the read-only
run-detail sibling: same layout/edge helpers, compact nodes (icon + id + duration) driven
by `PipelineStageView` (the generated OpenAPI DTO) instead of a `StageDraft`.
`StageInspector.tsx` (757 lines) is a form bound to one `StageDraft` via
`StageInspectorProps{stage, stageIds, onChange, onClose?, onDelete?, prTriggered?,
defaultDeadline?, envVars?}`; it renders executor-specific fields (`AgentFields`,
`CommandFields`) and live-validates `produces` (no path separators) client-side, mirroring
the backend rule. `PipelineRunDetail.tsx` (626 lines) is the single top-level page
component, `PipelineRunDetail({ runId, project })`, that composes the run graph, per-stage
outcome badges/attempt/reason, log viewer, artifact links, and orphaned-session
affordances; it is a plain fetch-and-render shell over the same generated DTOs, no
business logic of its own.

## 6. Minimal TS reimplementation: which 20 percent to take

The one-line summary of the whole design: **a pure, synchronous, copy-on-write reducer
over one Go struct (`RunState`), driven by a single-writer actor that turns effects into
I/O and feeds the results back in as new events.** That loop is the entire load-bearing
idea. Everything else in the AO codebase (git worktrees, tmux sessions, YAML schemas,
credentials, the whole frontend) is domain-specific plumbing around that loop, and none
of it is what makes parallel-agents-through-a-DAG work.

**Take (the 20 percent):**

1. **The event/effect/reducer split**, verbatim as a pattern: `reduce(state, event) ->
   (state, effect[])`, pure, no clock reads, never mutates input. This is
   backend/internal/pipeline/reducer.go and events.go. In TS this is maybe 300-400
   lines: seed reachable stages pending, start the entry stage, settle-success fans out
   `on_success` (respecting `needs` joins), settle-failure walks a single `on_failure`
   edge, `skipUnreachable` cascades skip, `advance` closes the run when nothing is
   pending/running.
2. **Plan-at-start** (`ComputePlan`, plan.go): before running anything, walk the whole
   graph, enumerate reachable stages, and fail loudly if some precondition cannot be met.
   For a 5-day fleet runner this is the cheapest correctness win in the whole design:
   cycle detection and "this stage's dependency cannot be satisfied" become a single
   graph walk done once, not a runtime surprise.
3. **The eight-way (or however many the kernel needs) outcome taxonomy**, specifically
   the split between "the process exited" and "the process claimed success but produced
   nothing" (`no_output`) and "nothing happened at all" (`no_signal`). This is the one
   idea GitHub Actions genuinely has no analogue for, and it is exactly what a
   commitment-kernel-driven fleet needs: a claim is not evidence.
4. **needs-joins with cascading skip**, because "three parallel builds feed one signer"
   is the shape almost every real fleet DAG has, and skip-not-fail is what keeps a
   partially-dead run legible.
5. **A single-writer actor per unit of concurrency** (one goroutine/one queue owns the
   mutable run map; nothing else touches it). This is the concurrency-safety idea, not
   the goroutine mechanism itself; in TS this is a single async queue draining
   sequentially per run, or a single-threaded event loop tick per run.
6. **`RunState` as a value, not an object with methods** (state.go): plain data,
   `clone()` is a shallow-copy-plus-map-rebuild, nothing else. This is what makes the
   reducer testable without mocks and is directly portable to a TS interface plus a pure
   function.

**Drop (does not earn its complexity in 5 days, or is AO-specific plumbing):**

- Credential tiers and engine-held secrets (spec section 8, D13/D17 in the implementation
  plan). A fleet runner backed by a commitment kernel almost certainly wants
  capability-scoped tokens issued by the kernel itself, not a parallel credential store.
- The whole workspace-kind vocabulary (`auto`/`inherit`/`session`/`run`/`stage`/
  `checkout`) and its git-worktree implementation (backend/internal/pipeline/executors/
  workspace.go, 301 lines, plus the 1400-line gitworktree adapter). Keep the *idea*
  (workspace is derived from the subject/resource, never from "which machine"), drop the
  six-way enum and the git-specific machinery; a fleet runner's "workspace" is whatever
  resource the kernel reserves.
- The nudge mechanism's prescriptive dual-message design and the whole
  produces-file-verification dance. Worth keeping the *concept* (engine verifies, agent
  claims are not trusted) but the specific "one nudge, two messages, in-session resend"
  machinery is a lot of code for a corner case; a fleet runner can start by just settling
  `no_output` on the first bad signal and add the nudge later if it earns its keep.
- Cancel-in-progress and concurrency groups (engine/concurrency.go). Genuinely useful at
  AO's scale (many pipelines sharing a repo/PR), but it is an admission-control feature
  layered on top of the DAG engine, not part of it. A kernel-backed fleet runner likely
  wants this expressed as a resource-reservation conflict in the kernel instead of a
  parallel table.
- The orphan reaper's LRU-cap-plus-TTL session bookkeeping (engine/orphans.go). This
  exists because AO keeps failed *interactive terminals* alive for human inspection; a
  fleet runner without a human-facing terminal has no orphans to bound.
- Templates, the whole frontend, the credentials CLI, restart process-group reaping
  (`ProcessGroupReaper`), and the run.json-as-projection dual-write (keep SQLite/DB only;
  a file projection is a nice-to-have debugging aid, not core).
- Session-kill-on-outcome disposition rules entirely: this is specific to AO's terminal
  UX, not to running a DAG.

**Where a commitment kernel would attach**, mapped onto the concrete places in this
codebase:

- **Stage start = resource reservation.** The conceptual hook is `engine.go:startStage`
  (line ~545), specifically the point right after `e.provision(...)` succeeds and right
  before `e.execs.Start(...)` is called. In AO this provisions a git worktree; in a
  kernel-backed runner this is exactly where you would ask the kernel to reserve
  whatever the stage needs and get back a commit/rollback handle. The reducer's
  `StartStage` effect (events.go) is the abstract "I intend to run this stage" signal
  that a kernel's reservation call would sit behind; today the driver executes it
  unconditionally, in a kernel design it would gate on the reservation succeeding and
  synthesize a `StageLaunchFailed` event on denial, exactly the same path AO already uses
  for a workspace-provision failure.
- **DAG edges = dependency registration.** `plan.go:ComputePlan` and its `walk` function
  are the place that already knows the full dependency graph before anything runs; a
  kernel wanting to register dependencies up front (rather than discover them stage by
  stage) would hook in right there, once, at plan time. `needsMet` in reducer.go (the
  join-readiness check) is the runtime mirror of the same dependency information and is
  where a kernel's "are my dependencies committed" query would replace or augment the
  in-memory outcome check.
- **Outcome = lifecycle transition.** Every `settleSuccess` / `settleFailure` call in
  reducer.go is a state transition on one unit of work; a commitment kernel's
  commit/abort call belongs exactly at the effect-execution boundary in engine.go's
  `execute()` (the switch over effect types), specifically wherever `PersistRun` and the
  session-disposition effects are handled today (persist -> line ~508, session
  disposition -> line ~756). That is the one place in the whole system where "the pure
  decision was just made" and "the world is about to be told" meet, which is precisely
  where a two-phase commit needs to sit.
- **Run state = rows in a database instead of run.json.** AO already made this call
  (decision D2): SQLite is authoritative, the run-folder JSON is a disposable
  projection. A kernel-backed fleet runner should copy this decision outright rather
  than reinvent it: `Store.SavePipelineRun` (engine.go's `Store` interface, line ~43) is
  the single choke point where every state change lands, and it is the natural place to
  either write directly into the kernel's own transaction log or to treat the kernel as
  the store.

## 7. File pointers, quick index

- Design spec: docs/plans/2026-07-26-pipelines-v2.md
- Implementation plan (decisions D1-D17, task breakdown): docs/plans/2026-07-26-pipelines-v2-implementation.md
- Post-ship divergences and known gaps: docs/plans/2026-07-26-pipelines-v2-followups.md
- User-facing doc (stale, still describes v1): docs/pipelines.md
- Outcome/RunStatus enums: backend/internal/pipeline/outcome.go
- Run/stage state shape: backend/internal/pipeline/state.go
- Plan-at-start walker: backend/internal/pipeline/plan.go
- Subject and scope resolution: backend/internal/pipeline/subject.go
- Event/effect vocabulary: backend/internal/pipeline/events.go
- The reducer (core transition logic): backend/internal/pipeline/reducer.go
- Run folder layout, Context.md, run.json: backend/internal/pipeline/runfolder.go
- Definition schema and parsing: backend/internal/pipeline/definition.go, schema.json
- Edit-time validation rules: backend/internal/pipeline/validate.go
- Cycle detection: backend/internal/pipeline/dag.go
- Engine actor: backend/internal/pipeline/engine/engine.go
- Supervisor (per-project engines, shared concurrency table, reaper ticker): backend/internal/pipeline/engine/supervisor.go
- Concurrency groups / admission: backend/internal/pipeline/engine/concurrency.go
- Kept-session bounding (cap + TTL): backend/internal/pipeline/engine/orphans.go
- Agent executor (spawn, poll signal-or-activity, nudge delivery): backend/internal/pipeline/executors/agent.go
- Command executor (exec, capture, exit-code outcome): backend/internal/pipeline/executors/command.go
- Workspace resolver over git worktrees: backend/internal/pipeline/executors/workspace.go
- PR / session trigger bridges: backend/internal/pipeline/triggers/prbridge.go, sessionbridge.go
- Worked example (release pipeline, fan-out + joins + credentials + diagnostic agent): spec section 11, mirrored at backend/internal/pipeline/testdata/release.yaml
- Base session model: backend/internal/domain/session.go, backend/internal/lifecycle/manager.go, reactions.go
- Git worktree adapter: backend/internal/adapters/workspace/gitworktree/workspace.go
- Frontend: frontend/src/renderer/components/PipelineCanvas.tsx, PipelineRunGraph.tsx, StageInspector.tsx, PipelineRunDetail.tsx; graph/draft libs at frontend/src/renderer/lib/pipeline-graph.ts, pipeline-draft.ts
