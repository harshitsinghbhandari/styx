# CONTEXT.md

Everything that is true about Styx and why, as of 2026-08-14. AGENTS.md
covers how to work in the repo; this file covers what the project is,
what was decided, what exists, and what remains.

## The idea

Styx is a consistency layer for promises between autonomous agents.
Agent infrastructure gives agents thinking (LLMs), acting (tools), and
memory of the past (RAG, session logs). There is no primitive for
commitment: a statement about the future that constrains multiple
parties, can conflict (double-booking), can depend on other commitments
(cascading failure), and must survive crashes, retries, and concurrent
autonomous writers. Styx is that primitive: an event-sourced commitment
kernel where promises are serializable transactional state that cannot
be double-spent, silently dropped, or changed without an auditable
reason.

Pitch lines that survived every revision:
- Most agent memory records what happened; Styx records what is
  supposed to happen.
- Agents get private memory of their past and shared memory of their
  future.
- AO isolates agents' files with worktrees; Styx isolates their
  intentions.
- Agents may die. Commitments survive.
- The kernel guarantees legality, not honesty: an agent cannot
  accidentally break a promise, but no database can make it tell the
  truth (evidence field + audit log are the honest answer).

## Why CockroachDB (as product semantics, not storage)

1. Serializable isolation is the double-booking guarantee: the
   capacity invariant (capacity - SUM(quantity of overlapping
   active/at_risk reservations) >= requested) is checked inside the
   same transaction that activates a reservation. 50 concurrent
   claimants, exactly one winner, proven in CI.
2. Changefeeds are the nervous system: the event log table streams to
   a Lambda router which wakes affected agents. The loop closes
   through the database, never around it.
3. The vector index holds precedents (past conflict settlements) in
   the same consistent system as the operational truth: no separate
   vector store to drift.
4. The Managed MCP Server gives agents a read-only natural-language
   introspection path; writes stay locked behind the kernel API.
   Reads broad, writes narrow.

## Design lineage (copied designs, not code)

- Runner: AO pipelines v2 (Untrivial-ai/agent-orchestrator PR #2863).
  Pure reducer + effects + single-writer actor, outcome taxonomy
  (succeeded, succeeded_unverified, failed, no_output, no_signal,
  timed_out, cancelled, skipped), frozen definitions, run folders as
  projections. Styx's twist: the kernel's CockroachDB rows are the
  store of record (AO already treats run.json as a projection of
  SQLite; Styx makes the same move one level up). Hooks: stage claim =
  reservation, DAG edge = dependency, outcome = lifecycle transition.
- Agent: Hermes (NousResearch/hermes-agent) memory design. Bounded
  MEMORY.md with a hard char cap and reject-not-truncate overflow,
  injected once per session as a frozen snapshot; SQLite WAL session
  log with FTS5 search (no LLM in the search path); compaction
  summaries as searchable rows. Deferred to roadmap: reinforcement
  nudge, skill self-improvement, user modeling.
- Console: opencode (anomalyco/opencode) streaming patterns. Queue ->
  coalesce-by-identity -> ~16ms batched flush -> single state
  transaction; pure row-projection before render; seed-palette
  theming approach. opencode is SolidJS with no DAG anywhere; our DAG
  (React Flow + dagre) is a clean build in the visual grammar of AO's
  pipeline canvas (nodes colored by status, inspector panel).
  No code was forked from any of the three.

Full research briefs: docs/research/{ao-pipelines,hermes,opencode-webui}.md.

## Decision log (all 2026-08-13)

1. v1-spec written (docs/v1-spec.md): GPU-marketplace demo, hand-rolled
   Bedrock agents. Kernel sections 6-9 and 19 remain authoritative.
2. Three kernel amendments (from the parallel product spec,
   docs/product-spec.md): (a) idempotency via a dedicated
   operation_results table with verbatim result replay; (b) capacity
   invariant is quantity- and window-aware (SUM not COUNT; windowless
   blocks everything); (c) at_risk stays a lifecycle status (the
   product spec argued for a derived risk flag; revisit post-hackathon).
3. v2 (docs/v2-scope.md, superseded): use Hermes/AO/opencode directly.
4. v3 (docs/v3-plan.md, current): copy designs, rebuild small, no
   forks. One TS monorepo. Styx attaches at BOTH layers: engine level
   (runner enforces; the orchestrator is the enforcement point) and
   agent level (styx tools for negotiation/repair). Demo fixture:
   coding-agent fleet (task claims, deploy-slot, promise chain
   P-101 -> P-102 -> P-103), not the marketplace.
5. Scene actors are deterministic policies; LLM only in the repair
   reason() hook (canned fallback). Chosen for on-camera reliability;
   identified on day one as making the AI invisible in the demo, and
   scheduled for reversal (see Open items 1-5).
6. PUBLIC_READ=true mode for the judge-facing deploy: GETs and SSE
   open, mutations bearer-gated. ponytail ceiling: scoped viewer
   tokens.
7. Repair convention: repairCommitment() accepts any dependency edge
   to an ACTIVE commitment (not only dependency_type='replaces')
   because the dependencies PK is (commitment_id, depends_on_id) and
   cannot hold a second typed row over the same pair.

## What exists (verified, all green)

- 164/164 tests: kernel 73, router 3, runner 36, agent 29, ui 23.
- Four headless scenes (scripts/scenes/): conflict (one winner, typed
  ResourceConflict, loser re-plans), cascade (single-transaction
  at_risk propagation + relay wake-ups), repair (precedent retrieval,
  replacement commitment, graph rewire; accretion proven: run 2
  retrieves run 1's settlement), crash (SIGKILL mid-mission,
  replacement resumes idempotently, zero duplicates).
- Public demo: http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/
  (console + API, same origin, cloud-backed). Live SSE verified from
  outside AWS.
- Repo: https://github.com/harshitsinghbhandari/styx (public,
  Apache-2.0). README quickstart verified against a literal fresh
  clone. docs/submission.md is Devpost-paste-ready. docs/video/ has
  the sub-3-minute script and shot list; scripts/demo/ has paced
  per-scene recording drivers.

## Cloud inventory (AWS profile "styx", us-east-1; CockroachDB Cloud)

- CockroachDB: cluster styx-main-cluster (Basic tier, AWS us-east-1),
  database styx, full schema + vector index applied, seeded. SQL user
  styx-api. Changefeed job 1201076195067265025 on commitment_events.
- Lambdas: styx-router (changefeed consumer, fronted by API Gateway
  HTTP API 43nwyfu712 because the account blocks anonymous Function
  URL invokes), styx-migrate (schema), styx-admin-sql (ad hoc
  statements, redacts secrets), styx-seed, styx-e2e (kernel-driven
  end-to-end proof), styx-scene (kernel-driven demo state).
- ECS: cluster styx, Fargate service styx-console (0.5 vCPU / 1 GB)
  behind ALB styx-alb, image in ECR styx-console (~86 MB), DATABASE_URL
  injected from SSM. IAM: styx-lambda-exec, styx-ecs-exec.
- SSM SecureStrings: /styx/database-url, /styx/webhook-secret.
- Bedrock: Titan Text Embeddings V2 access granted and verified
  (kernel/src/embedders/titan.ts, EMBEDDER=titan); Claude reasoning
  hook optional in agent/src/reason.ts.
- Local-only credential files (never in repo): ~/.styx-cloud.env,
  ~/.styx-cloud-agents.env, both mode 600.
- Cost when fully up: about $35-40/month (Fargate + ALB); everything
  else is effectively free at this scale.

## Current operational state (as of the 2026-08-13 night wind-down)

- Changefeed job 1201076195067265025: PAUSED
  (resume: RESUME JOB via styx-admin-sql).
- ECS styx-console: desired count 0
  (resume: aws ecs update-service --cluster styx --service
  styx-console --desired-count 1).
- ALB left up so the public URL stays stable.
- Resume cost path returns to ~$1.15/day combined.

## Environment constraints (read before touching cloud)

- The development machine sits behind a campus network that
  transparently intercepts port 26257 with a Squid proxy: direct SQL
  to CockroachDB Cloud is impossible from it. All cloud-db work goes
  through the Lambdas. HTTPS on 443 works (Bedrock, ALB, API Gateway,
  MCP). Local CockroachDB (Homebrew v26.2.5 or Docker) is used for
  all tests and local scenes.
- The machine sleeping kills background work; caffeinate during long
  runs.

## Open items

For the AI-visibility upgrade (agreed, next work session):
1. Run the fleet as a cloud service (Fargate reaches the cluster;
   point styx-router's WAKE_URL at it; the full loop goes live behind
   the public URL).
2. Bedrock reasoning on by default (cheap model for workers, capped;
   repair proposals via Claude), reasoning traces written to session
   logs.
3. Agent lane panel in the console: live per-agent cards (awake or
   sleeping, last wake reason, obligations, last action) plus a
   streaming reasoning feed. Needs a small read-only HTTP surface on
   the fleet host (session/memory stores are in-process only today).
4. Operator chat panel: a steward agent that answers questions by
   introspecting the kernel and executes instructions only through
   the locked write path.
5. A low-rate scenario driver so the graph is alive whenever a judge
   visits.

Harshit personally:
- Record the video (docs/video/script.md, shotlist.md; drivers in
  scripts/demo/), upload, fill the URL in docs/submission.md.
- CockroachDB Cloud console: enable the Managed MCP Server for
  styx-main-cluster, create a read-only credential, set
  STYX_MCP_ENDPOINT and STYX_MCP_CREDENTIAL (code already wired,
  agent/src/mcp.ts falls back to the API until then).
- Submit the Devpost form (deadline 2026-08-18 5 PM EDT; target
  Monday 2026-08-17 night).
- After judging: scale down or delete ECS service + ALB, pause or
  drop the changefeed, optionally delete the cluster.

Known debt (deliberate, ponytail-marked in source):
- PUBLIC_READ is all-or-nothing across GET routes.
- SSE is a poll-tail (changefeed-driven push if latency matters).
- No ECR lifecycle policy (image tags accumulate per provision run).
- Runner: no nudge mechanism, no concurrency groups, no credential
  injection (dropped from the AO model for the slice).
- Agent: no reinforcement nudge, no skill self-improvement, no user
  modeling (Hermes features deferred).
- UI: no agent-memory inspector (blocked on open item 3), 'replaces'
  edges render solid until the graph route exposes dependency_type
  everywhere.
- repair's "replacement linked first" ordering is caller-enforced.

## Judging criteria mapping (for the submission)

- Agentic memory design: the memory layer IS the product; state,
  audit log, dependency graph, and embeddings in one consistent
  system; commitments as prospective memory.
- Technical implementation: single serializable write path, optimistic
  versioning, verbatim idempotent replay, gapless event sequences,
  cycle-checked graph, deduped at-least-once delivery, 164 tests
  including a 50-way race in CI.
- Real-world impact: parallel coding-agent fleets double-claiming work
  is a lived problem (design lineage is from the maintainer's own
  orchestrator); generalizes to procurement, scheduling, logistics.
- Production readiness: invariants below the intelligence, typed
  failures as negotiation signals, crash-resume proven, secrets in
  SSM, least-privilege roles, honest failure-mode documentation.
- Creativity: memory of the future; the oath-on-the-Styx guarantee;
  three flagship open-source designs recomposed around the missing
  primitive.
