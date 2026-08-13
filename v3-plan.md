# Styx V3: platform plan, hackathon slice

Decided 2026-08-13, supersedes `v2-scope.md`. The kernel sections of
`v1-spec.md` (6, 7, 8, 9, 19) remain authoritative with the three
amendments restated below. Everything around the kernel changed.

## Framing

Styx is a platform Harshit keeps building after August 18. The hackathon
(CockroachDB x AWS, deadline Aug 18 5:00 PM EDT, submit Aug 17 night)
gets the thinnest vertical slice that demos end to end. Nothing built for
the slice gets thrown away.

## The composition

No forking, no vendoring. We copy designs, not code, from three
reference systems, rebuild them minimal in one TypeScript monorepo, and
connect them with the piece none of them has: shared transactional
commitments on CockroachDB.

| Reference | What we copy | What we build |
|---|---|---|
| AO pipelines v2 (PR #2863) | The orchestration model: stages, on_success/on_failure edges, agent and command executors, the outcome taxonomy (succeeded, succeeded_unverified, failed, no_output, no_signal, timed_out, cancelled, skipped), frozen definitions, run folders | `runner/`: a stripped fleet runner |
| Hermes agent | The memory and storage layer per agent: persistent store, FTS session search with summarization, skills; plus the wake, read, reason, act loop | `agent/`: a stripped agent each fleet member runs |
| opencode / AO canvas | Console patterns: React Flow + dagre DAG, inspector panel, board, ticker | `ui/`: one web console |

The pitch line: agents get private memory of their past (Hermes' design)
and shared memory of their future (Styx). AO isolates agents' files with
worktrees; Styx isolates their intentions.

## Styx attaches at both layers

- **Engine level (enforcement).** The runner itself talks to the kernel:
  starting a stage reserves the task resource, pipeline edges are
  registered as commitment dependencies, stage outcomes commit lifecycle
  transitions. Agents cannot bypass it; the runner is the enforcement
  point. Runner-local run folders stay as logs; the authoritative run
  state lives in CockroachDB.
- **Agent level (negotiation).** Agents also hold Styx tools
  (styx_promise, styx_reserve, styx_fulfill, styx_break, styx_link,
  styx_obligations, styx_precedents) for the parts enforcement cannot
  do: making promises to each other, renegotiating after a
  ResourceConflict, repairing after a cascade. Introspection via the
  CockroachDB Managed MCP Server, read-only.

## Kernel amendments (unchanged from v2)

1. Idempotency via a dedicated `operation_results` table (key PK, stored
   result JSONB replayed verbatim). No idempotency column on
   commitments.
2. Reservation capacity invariant is quantity- and window-aware:
   available = capacity - SUM(quantity of overlapping active or at_risk
   reservations), inside the same serializable transaction. Windowless
   reservations block all windows.
3. `at_risk` is a lifecycle status.

## Monorepo

```
styx/
├── kernel/     commitment kernel: schema, transitionCommitment, kinds,
│               cascade, precedents, Fastify API + SSE
├── runner/     fleet runner on the pipelines model, engine-level Styx
├── agent/      stripped Hermes-design agent: loop, per-agent memory
│               (SQLite + FTS + summaries), skills dir, MCP client,
│               Styx tools
├── router/     changefeed webhook sink on AWS Lambda, wakes agents
├── ui/         web console: React Flow DAG, inspector, board, ticker,
│               BREAK button, SSE
├── scripts/    provision (ccloud), migrate, demo drivers
└── docs/
```

TypeScript end to end. The runner is a reimplementation of the
pipelines model, trimmed to what the slice needs; the full taxonomy and
machinery (credentials, cancel-in-progress, templates, nudges) are
roadmap, not slice.

Research findings (see research/ for the full briefs) refine the copies:

- Runner copies pipelines' pure-reducer core: Reduce(RunState, Event)
  gives (RunState, Effects), one single-writer actor performs effects.
  AO already treats run.json as a disposable projection of a SQLite
  store of record; Styx makes the kernel's CockroachDB rows the store
  of record, which is the same move one level up. Hook sites map to
  their startStage (reserve), ComputePlan (register dependencies), and
  the persist path (commit outcome transitions).
- Agent copies Hermes' highest-value patterns only: bounded MEMORY.md
  with a hard char cap and reject-not-truncate overflow, injected once
  per session as a frozen snapshot; SQLite WAL session log with FTS5
  search (plain search, no LLM in the search path); compaction
  summaries stored as searchable rows. The reinforcement nudge
  (periodic restricted background self-review) and skill
  self-improvement go to roadmap. Honcho-style user modeling is
  dropped entirely.
- Console copies opencode's event pipeline (coalesce by identity,
  ~16ms batched flush, pure row-projection before render) and its
  seed-palette OKLCH theming approach. opencode is SolidJS and has no
  DAG rendering; our console is React (React Flow needs it) and the
  DAG view is a clean build. The one candidate for copying actual
  code rather than design is opencode's ~300-line MIT theme resolver;
  flagged for Harshit's veto, default is to port it with attribution.

## The hackathon slice

Fixture: coding-agent fleet on a shared backlog. Resources: `task:<id>`
(capacity 1 each), `deploy-slot` (capacity 1), `ci-runner` (capacity 2).
Promise chain P-101 (schema migration) -> P-102 (API endpoints) ->
P-103 (frontend wiring).

Scenes (same beats as v1-spec section 16):

1. **Conflict**: two agents claim the same task simultaneously; exactly
   one serializable transaction wins, the loser gets a typed
   ResourceConflict and takes the next task.
2. **Cascade**: BREAK P-101; one transaction flags P-102 and P-103
   at_risk; changefeed wakes their owners.
3. **Repair**: repair agent retrieves a live-accreted precedent,
   proposes a replacement commitment, the graph rewires. P-101 stays
   broken.
4. **Crash**: kill an agent mid-work; a fresh one reads its obligations
   via MCP and resumes. Agents may die, commitments survive.

Thin scripted actors drive the scenes fast; real LLM reasoning appears
where it matters, in the renegotiation and repair moments.

## Five days

- **Day 1 (Thu 13, tonight)**: kernel. Schema, transitionCommitment,
  kinds, cascade, tests 1-7 green against local single-node CRDB.
  The kernel survived every pivot; it is the invariant.
- **Day 2 (Fri 14)**: kernel API + SSE; CockroachDB Cloud; changefeed
  to Lambda router; runner skeleton with engine-level attachment
  (claim = reserve, edges = dependencies, outcome = transition),
  command executor first.
- **Day 3 (Sat 15)**: agent executor + the stripped agent (loop,
  bounded memory file, FTS session log, Styx tools, MCP read path);
  scenes 1-3 end to end headless; precedents accreted live; Titan
  embeddings. The scouts estimate 3-4 days for the full Hermes-subset
  agent; the slice version above is the one-day cut, the rest is
  roadmap.
- **Day 4 (Sun 16)**: UI; deploy API + UI (Fargate) for the public
  demo URL; crash scene. The scouts estimate 7-9 days for a full
  opencode-grade console; the slice is ticker + DAG + inspector only,
  ruthlessly plain.
- **Day 5 (Mon 17)**: video, README, architecture image, submit Monday
  night. Tuesday buffer, fixes only.

Scope rule unchanged: a missed exit bar cuts from the top of the polish
list, never from the kernel or its tests.

## Compliance

CRDB tools: Distributed Vector Indexing (precedents) + Managed MCP
Server (agent introspection, dev workflow), changefeeds as depth, ccloud
in provisioning scripts as stretch. AWS: Bedrock (Titan embeddings,
agent reasoning), Lambda (router), ECS Fargate (API + UI), S3
(artifacts). Public Apache-2.0 monorepo; design lineage from AO,
Hermes, and opencode credited in the README.

## Post-hackathon direction (one paragraph, so the slice cuts clean)

The runner grows back toward full pipelines parity and can become a
Styx-backed backend for AO pipelines upstream; the agent grows real
skill acquisition; the kernel grows the kind registry (lease,
delegation, authorization, escrow, SLA) per v1-spec section 25. The
protocol/product split from the product spec (Styx Protocol vs hosted
Styx) is the long arc.
