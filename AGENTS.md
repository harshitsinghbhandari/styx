# AGENTS.md

Instructions for any coding agent (or human) working in this repository.
Read CONTEXT.md first for what this project is and where it stands; this
file is about how to work here without breaking things or repeating
mistakes that were already paid for.

## What this repo is, in one paragraph

Styx is a transactional commitment kernel for AI agent fleets: promises,
reservations, dependencies, and an immutable event log stored in
CockroachDB, mutated only through one serializable write path, streamed
out through changefeeds, searched through a vector index of precedents.
The kernel is the product. Everything else (runner, agent, relay, ui,
router) exists to exercise and expose it.

## Monorepo map

```
kernel/   THE PRODUCT. schema.sql, transitionCommitment(), kinds
          registry (promise, reservation), cascade CTE, precedents
          (PrecedentStore + pluggable Embedder), Fastify API + SSE,
          repair. Store of record for everything.
runner/   Fleet runner copying the AO pipelines v2 model: pure
          reducer (reduce(state, event) -> {state, effects}),
          single-writer engine, command + agent executors, outcome
          taxonomy. Attaches to the kernel at engine level: stage
          claim = reservation, DAG edge = dependency, outcome =
          lifecycle transition. Kernel rows are the run's truth;
          run.json is a disposable projection.
agent/    Stripped agent (Hermes memory design): wake/read/decide/
          act/sleep loop, bounded MEMORY.md (hard cap, reject not
          truncate), SQLite + FTS5 session log, policies (worker,
          repair, breaker), SSE wake relay, fleet host, optional
          Bedrock reason() hook, optional MCP client.
router/   Changefeed webhook consumer: Lambda-shaped handler with
          event dedupe (processed_events table), wake-up fan-out to
          WAKE_URL. Local HTTPS server wrapper for dev.
ui/       React + Vite console: React Flow + dagre commitment DAG,
          inspector, SSE ticker (coalesce-by-identity, ~16ms batched
          flush, pure row projection), BREAK button. Same-origin
          only (see gotcha 9).
scripts/  seed, day2-smoke, scenes/ (the four demo scenes),
          provision.sh (idempotent cloud infra), cloud-migrate.sh,
          demo/ (paced recording wrappers), lambda/ sources.
docs/     Specs (v1-spec, v3-plan are authoritative), research
          briefs, architecture diagram, video kit, submission.md.
```

## Golden rules

1. Every mutation of commitment state goes through the kernel's
   transition path. No raw UPDATE/INSERT on kernel tables from any
   other package, ever. Reads are free.
2. TypeScript everywhere, node-postgres, vitest. No ORM. No state
   library in ui. No new frameworks without a reason written down.
3. Never use em dashes or en dashes in anything: code, comments,
   docs, commit messages, UI copy. Use commas, colons, periods,
   parentheses.
4. Commit messages: short lowercase summary line ("day 3: stripped
   agent, relay, agent executor, scenes 1-4" style). NEVER append
   Co-Authored-By or any AI attribution. Author is
   Harshit Singh Bhandari <dev@theharshitsingh.com> (repo-local git
   config already set).
5. Comments only where the code cannot speak. Deliberate shortcuts
   carry a `ponytail:` comment naming the ceiling and the upgrade
   path.
6. Never claim tests pass without running them and reading the
   output. Never commit a failing suite. Run the full affected
   workspaces, not just your new tests.
7. Secrets never enter the repo, terminal output, or commits. Cloud
   DATABASE_URL and agent API keys live in ~/.styx-cloud.env and
   ~/.styx-cloud-agents.env (mode 600) locally, and in AWS SSM
   Parameter Store (/styx/*) for cloud runtime.
8. When multiple agents work in parallel: agree on disjoint path
   boundaries up front, git add only your own paths, and on a git
   index.lock error wait 2 seconds and retry.

## Commands

Local CockroachDB must be running for kernel/runner/agent/router
tests (single node, insecure, localhost:26257):

```
docker run -d --name styx-crdb -p 26257:26257 \
  cockroachdb/cockroach:latest start-single-node --insecure
# wait for readiness before applying schema (see gotcha 15), then:
psql postgresql://root@localhost:26257/defaultdb?sslmode=disable \
  -c "CREATE DATABASE IF NOT EXISTS styx"
psql postgresql://root@localhost:26257/styx?sslmode=disable \
  -f kernel/src/db/schema.sql -f kernel/src/db/precedents.sql \
  -f kernel/src/db/router.sql
```

(Homebrew `cockroach start-single-node` works identically; that is
what local dev actually used.)

```
npm install                      # root, installs all workspaces
npm test --workspace=kernel      # 73 tests
npm test --workspace=router      # 3 tests
npm test --workspace=runner      # 36 tests
npm test --workspace=agent       # 29 tests
npm test --workspace=ui          # 23 tests
npx tsx scripts/seed.ts          # demo agents + resources, prints keys once
npm run api --workspace=kernel   # Fastify API (+ static ui/dist if built)
bash scripts/day2-smoke.sh       # end-to-end local smoke
npx tsx scripts/scenes/scene1-conflict.ts   # and scene2/3/4
npm run demo --workspace=runner  # small pipeline through the kernel
npm run dev --workspace=ui       # console (Vite, proxies API)
bash scripts/provision.sh        # idempotent cloud infra (AWS_PROFILE=styx)
bash scripts/cloud-migrate.sh    # schema changes against cloud via Lambda
```

Environment: DATABASE_URL defaults to
postgresql://root@localhost:26257/styx?sslmode=disable. API port per
kernel/src/api start script. PUBLIC_READ=true opens GET routes + SSE
without auth (mutations always need bearer keys). EMBEDDER=titan
switches the precedent embedder from the deterministic stub to
Bedrock Titan (needs AWS creds).

## Hard-won gotchas (every one of these cost real debugging time)

1. CockroachDB INT is int8; node-postgres returns int8 as STRING.
   A process-wide type parser in kernel/src/db/pool.ts fixes it.
   If you create a new pool elsewhere, you inherit the problem.
2. TIMESTAMPTZ: CockroachDB stores microseconds, JS Date holds
   milliseconds. Any cursor or comparison that round-trips through
   Date silently loses precision and re-delivers rows. Select
   created_at::text when you need an exact cursor (see
   kernel/src/api/sse.ts).
3. Idempotency under real concurrency: two callers with the same key
   can both pass the pre-commit SELECT on operation_results. The
   loser hits the primary-key unique violation (23505), catches it,
   and re-reads the winner's stored result as its replay. Do not
   "fix" that catch away.
4. The transition table has no at_risk -> revoke edge (per spec).
   Skip/cancel on an at_risk commitment routes through break.
5. In runner definitions, `needs` alone creates no routing edge;
   on_success is the only fan-out. Validation enforces that every
   `needs` target routes back via on_success. Do not remove that rule.
6. A late cosmetic stage_started event must never regress a stage
   that already settled; the reducer guards this. Regression test
   exists; keep it.
7. SQLite FTS5: a bare colon in a query (task:hotfix-42) is column
   syntax and throws. Every token gets quoted as a literal phrase in
   agent/src/store.ts.
8. React 18 StrictMode double-invokes setState updaters in dev.
   Updater functions must be pure functions of prev; side effects
   inside them (refs, pulses) silently double-fire or vanish. See
   ui/src/hooks/useStyxConsole.ts.
9. The kernel API has bearer auth on everything (except /v1/health
   and PUBLIC_READ GETs) and no CORS. Native EventSource cannot set
   headers, so ui/src/api/sse.ts hand-rolls SSE over fetch. The UI
   must be served same-origin behind the API (Vite proxy in dev,
   @fastify/static in prod). Adding CORS is a decision, not a drive-by.
10. esbuild with cjs output empties import.meta.url; any module-level
    fileURLToPath(import.meta.url) crashes the Lambda bundle at
    import time. Compute lazily inside functions (router/src/db.ts).
11. CockroachDB changefeed auth header option is `extra_headers`
    (JSON map). `webhook_auth_header` does not exist; a wrong option
    yields silent fast 401s at the sink and an empty-looking pipeline.
12. On CockroachDB Cloud Basic, SET CLUSTER SETTING
    kv.rangefeed.enabled is operator-only and fails; rangefeeds are
    already enabled. Tolerate the error, do not fight it.
13. This AWS account 403s anonymous Lambda Function URL invocations
    (account-level guardrail, not an SCP). Public Lambda endpoints go
    through API Gateway HTTP APIs instead.
14. THE CAMPUS NETWORK BLOCKS PORT 26257 with a transparent Squid
    proxy (HTTP 403 to a raw SQL handshake). This Mac can NEVER reach
    CockroachDB Cloud SQL directly. All cloud-db operations run
    through the styx-admin-sql / styx-migrate / styx-e2e / styx-scene
    Lambdas. HTTPS 443 egress (Bedrock, API Gateway, ALB, MCP) works
    fine. Do not waste time retrying direct cloud SQL locally.
15. `docker run` returning does not mean CockroachDB is ready; wait
    on readiness before applying schema (pattern in
    .github/workflows/ci.yml and README quickstart). Also:
    `docker exec ... < file.sql` without -i silently applies nothing;
    use psql.
16. kernel/package.json has no main/exports field; import the kernel
    from sibling workspaces via relative path
    (../../kernel/src/index.js), the same convention its own tests use.
17. Reserving and immediately fulfilling a capacity reservation frees
    the capacity again (only active/at_risk count). A durable claim
    stays active until the work is truly done.
18. Windowless reservations block all windows by design (conservative
    default); window overlap is checked inside the serializable
    transaction. See kernel/src/kinds/reservation.ts.

## Extension points (the sanctioned ones)

- New commitment kind: implement CommitmentKind (validateTerms /
  validateActivation / validateTransition), register in
  kernel/src/kinds/registry.ts. No schema migration should be needed;
  if one seems needed, stop and reconsider.
- New embedder: implement the Embedder function type, register like
  kernel/src/embedders/titan.ts, select via EMBEDDER env.
- New runner outcome semantics: extend the reducer's event/effect
  unions and the outcome-to-action map in runner/src/styx.ts; add
  table-driven reducer tests.
- New API routes: kernel/src/api/, follow the existing auth hook and
  error-mapping conventions (VersionConflict 409, ResourceConflict
  409 with conflict object, InvalidTransition 422, Forbidden 403,
  replayed results marked replayed: true).

## Testing philosophy

The kernel earns its claims through tests: the 50-way reservation
race (exactly 1 winner), the exhaustive transition matrix generated
from the spec table, concurrent idempotency, cascade on a diamond,
cycle rejection, gapless event sequences, router dedupe. If you touch
kernel semantics, extend the matrix, do not special-case around it.
Scenes (scripts/scenes/) are executable acceptance tests for the
whole stack and must stay green and headless.
