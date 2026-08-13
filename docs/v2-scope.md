# Styx V2 scope delta

Decisions taken 2026-08-13. This document amends `v1-spec.md`; where they
conflict, this wins. The kernel sections of v1-spec (6, 7, 8, 9, 19) remain
authoritative with the three amendments below.

## What changed and why

Build only what nothing else provides. Three existing systems replace most
of the v1 build surface:

| v1-spec component | Replaced by |
|---|---|
| `agents/` (hand-rolled Bedrock loops) | Hermes agents (NousResearch/hermes-agent, MIT). Native MCP support covers the CockroachDB Managed MCP read path with zero adapter code. Mutations via a Styx skill (agentskills.io standard) exposing the Styx API as tools. |
| Demo drivers / orchestration scripts | Agent Orchestrator (Untrivial-ai/agent-orchestrator, Apache-2.0). Each agent is an AO session with its own terminal. |
| Force-directed visualizer (v1-spec section 15) | React Flow (`@xyflow/react`) + dagre DAG canvas, same stack and design language as AO PR #2863 (PipelineRunGraph, StageInspector, SessionsBoard). Read-only, SSE-driven, one BREAK button. |

What no existing system provides, and therefore what we build: the
commitment kernel on CockroachDB (serializable transitions, double-booking
prevention, idempotency, promise chains, cascade, changefeed wakeups,
precedent vector store). Hermes memory is per-agent and retrospective;
Styx is the shared memory of the future between agents. That contrast is
the pitch.

## Kernel amendments (already agreed, restated)

1. Idempotency via a dedicated `operation_results` table
   (key PK, stored result JSONB, replay returns it verbatim). The events
   table carries no idempotency key; `commitments.idempotency_key` is
   dropped.
2. Reservation capacity invariant is quantity- and window-aware:
   `available = capacity - SUM(quantity of overlapping active/at_risk
   reservations)` inside the same serializable transaction. Windowless
   reservations block all windows.
3. `at_risk` stays a lifecycle status (v1-spec wins over the product
   spec's derived-condition design; revisit post-hackathon).

## Demo fixture: the coding-agent fleet

A fleet of Hermes agents run under AO, working a shared backlog, and
coordinating through Styx. Dogfoods AO; the impact story is the one we
live daily: parallel coding agents double-claim work and silently break
each other's assumptions.

Resources (capacity-limited):

- `task:<id>`, capacity 1 each: task ownership. Claiming a task is a
  reservation; double-claim is the race demo.
- `deploy-slot`, capacity 1: only one agent ships at a time.
- `ci-runner`, capacity 2: shared CI capacity.

Promise chain for the cascade scene:

- P-101 agent A promises the schema migration by 14:00
- P-102 agent B promises the API endpoints by 16:00, depends_on P-101
- P-103 agent C promises the frontend wiring by 18:00, depends_on P-102

Scenes (mapped from v1-spec section 16, same beats):

1. Conflict: two agents claim the same task simultaneously; exactly one
   wins, the loser receives a typed ResourceConflict and picks the next
   task instead. No two agents ship the same ticket.
2. Cascade: BREAK P-101 (scope change kills the migration). One
   transaction flags P-102 and P-103 at_risk; changefeed wakes agents B
   and C.
3. Repair: repair agent retrieves a precedent (accreted live in earlier
   rounds), proposes a replacement commitment (reassign or re-scope),
   graph rewires. P-101 stays broken; P-104 takes its place.
4. Crash: kill an agent's AO session mid-work; a fresh Hermes session
   reads its obligations via MCP and resumes. Agents may die,
   commitments survive.

## Integration surfaces

- **Styx skill for Hermes**: tools `styx_promise`, `styx_reserve`,
  `styx_fulfill`, `styx_break`, `styx_link`, `styx_obligations`,
  `styx_precedents`, thin wrappers over the REST API with idempotency
  keys derived from mission context.
- **CockroachDB Managed MCP** in each Hermes agent's MCP config,
  read-only credentials: the introspection path.
- **Wake-ups**: changefeed on `commitment_events` to Lambda Function URL
  (canonical, hosted) stays. Because the AO daemon and Hermes sessions
  run locally, a tiny local relay subscribes to the Styx API SSE stream
  and nudges the affected agent's session. Lambda remains the hosted
  fan-out and feeds the deployed visualizer.

## UI

One React page: React Flow + dagre commitment DAG (nodes colored by
status), commitment inspector on click (terms, parties, event history),
status board, event ticker, BREAK button. SSE from the Styx API. Hosted
with the API for the public demo URL. No Electron, no state library.

## Revised 5 days

- **Day 1 (Thu 13)**: kernel, unchanged. Schema, transitionCommitment,
  kinds, cascade, tests 1-7 green against local single-node CRDB.
- **Day 2 (Fri 14)**: CockroachDB Cloud + changefeed to Lambda router;
  Fastify API + SSE; Styx Hermes skill; MCP read path proven from a
  scratch Hermes agent.
- **Day 3 (Sat 15)**: the fleet under AO; local wake relay; scenes 1-3
  end-to-end headless; precedents accreted live; Titan embeddings.
- **Day 4 (Sun 16)**: React Flow UI; deploy API + UI (Fargate); crash
  scene polish.
- **Day 5 (Mon 17)**: video, README, architecture image, submit Monday
  night. Tuesday is buffer only.

## Compliance unchanged

CRDB tools: Distributed Vector Indexing + Managed MCP Server
(+ changefeed depth). AWS: Bedrock (Titan embeddings, optionally Hermes
models via Bedrock), Lambda, ECS Fargate, S3. Public repo Apache-2.0,
demo URL is the hosted visualizer, video under 3 minutes.
