# Devpost submission package

Paste-ready content for the CockroachDB x AWS hackathon submission form.

---

## Project name

Styx

## Tagline

A consistency layer for promises between autonomous agents.

---

## Description

### What it does

Styx gives autonomous agents a shared, transactional notion of a promise.
When one agent commits to something (reserving a resource, delivering
something to another agent) that commitment becomes a row in CockroachDB
with a typed lifecycle, an optimistic version, and a full event history,
not a line in a chat transcript both sides hope the other read correctly.

Two agents racing for the same scarce resource resolve through one
serializable transaction: exactly one wins, the other gets a typed
`ResourceConflict` back immediately instead of silently double-booking.
Breaking a promise cascades `at_risk` to every dependent promise in the
same transaction, and CockroachDB's changefeed carries that change out to
the agents who need to react, no poller, no queue. A repair agent can
search past resolutions by vector similarity and propose a replacement,
and the graph rewires around the break. Kill an agent process mid-task
and a fresh process for the same identity finds its obligations still
sitting in the database and resumes them; the kernel never depended on
that process staying alive.

Agents also keep their own private memory (a per-agent SQLite store with
full-text search over past sessions, Hermes-style). Styx is not that.
Styx is the memory they share about the future: what's been promised,
what's still owed, what broke.

### How it was built

TypeScript end to end, five workspaces in one npm-workspaces monorepo:

- `kernel/`: the commitment kernel. Schema, `transitionCommitment()`,
  a small kind registry (promise, reservation), cascade as one recursive
  CTE inside the triggering transaction, a Fastify API with SSE, a vector
  precedent store.
- `router/`: the changefeed webhook sink, deployed as an AWS Lambda
  behind API Gateway, deduplicating at-least-once delivery into
  exactly-once wake-ups.
- `runner/`: a stripped fleet runner on the pipelines model (stages,
  on_success/on_failure edges, an outcome taxonomy), attaching to the
  kernel at the engine level so agents cannot bypass enforcement.
- `agent/`: a stripped agent per fleet member: a wake/read/reason/act
  loop, bounded per-agent memory, an FTS session log, Styx tools, and an
  optional read-only path through the CockroachDB Managed MCP Server.
- `ui/`: a React console (React Flow DAG, ticker, inspector, a BREAK
  button), reading the kernel's SSE stream, deployed same-origin on ECS
  Fargate behind an ALB.

No agent framework, no ORM, no state library. The kernel's SQL is the
spec. Design lineage (not code) was copied from three reference systems
and credited: AO's pipelines v2 for the orchestration model, Hermes for
the per-agent memory design, opencode for the console's event pipeline
and seed-palette theming approach. Nothing is vendored; see the README's
"Architecture" section for the one place code-porting was actually
considered (opencode's theme resolver) and why native CSS covered it
instead.

### Challenges we ran into

Two are worth being specific about, because they were real and not
resolved by just trying harder:

**The campus-proxy story.** The CockroachDB Managed MCP Server is wired
end to end in the agent code (`agent/src/mcp.ts`): read the endpoint and
credential from the environment, try MCP first, fall back to the plain
API client on any failure. What isn't wired is the actual MCP transport
call, because the development network this was built on blocks the port
CockroachDB Cloud's SQL proxy uses, so there was no reachable endpoint to
test a real client against during the build. The fallback path is real
and is exercised by every scene right now; it is the same code path MCP
would use once the transport is filled in. We'd rather ship an honestly
partial integration with a documented reason than fake a working one.

**The changefeed header option.** Getting a shared secret onto every
changefeed webhook call took some digging: CockroachDB's webhook sink
supports `extra_headers` as a general-purpose option, which is what we
used to attach `x-styx-webhook-secret`. It works well once you find it,
but it took longer than it should have to land on the right option name
and confirm it was the intended mechanism versus something narrower and
auth-specific. See the feedback section below.

### What's next

The roadmap is written to require no schema migrations for most of it,
which is itself the extensibility proof: a wider kind registry (lease,
delegation, authorization, escrow, SLA), conditional commitments via a
`condition` field plus a transition guard, multi-party settlement as a
commitment that resolves several others in one transaction, and
reputation derived from folding `commitment_events` rather than stored
as truth anywhere. The longer arc is a protocol/product split: Styx
Protocol as an open spec, hosted Styx as one implementation of it. Full
detail in `docs/v3-plan.md`.

---

## Built with

TypeScript, Node.js, Fastify, node-postgres, React, Vite, React Flow,
CockroachDB, CockroachDB Cloud, AWS Lambda, Amazon API Gateway, Amazon
ECS Fargate, Amazon Bedrock (Titan Text Embeddings V2, Claude on
Bedrock), AWS SSM Parameter Store, Docker, vitest.

---

## CockroachDB tools checklist

| Tool | Used | Evidence |
|---|---|---|
| Serializable transactions | Yes, the core guarantee | `kernel/src/kernel.ts`, `kernel/src/transition.ts`, `kernel/src/txn.ts` (retry on `40001` with jitter); proof: `kernel/test/1-race.test.ts`, 50 concurrent reservations on a capacity-1 resource, exactly 1 wins |
| Changefeeds | Yes, event delivery to the router | `CREATE CHANGEFEED FOR TABLE commitment_events INTO 'webhook-...' WITH updated, resolved='10s', extra_headers=...` in `scripts/provision.sh`; consumed by `router/src/handler.ts` |
| Distributed Vector Indexing (VECTOR) | Yes, precedent search | `kernel/src/db/precedents.sql`, `kernel/src/precedents.ts` (`ORDER BY embedding <-> $1::vector`); accretion proof in `scripts/scenes/scene3-repair.ts` |
| Managed MCP Server | Partial: read path wired, transport not live | `agent/src/mcp.ts`; honest status and reason in the challenges section above and in the README |
| ccloud | Yes, cluster provisioning | `styx-main-cluster`, Basic tier, `us-east-1`; schema pushed via `scripts/cloud-migrate.sh` |

---

## AWS services checklist

| Service | Used | Evidence |
|---|---|---|
| AWS Lambda | Yes | `styx-router` (changefeed sink), plus `styx-admin-sql`, `styx-seed`, `styx-e2e`, `styx-scene`, `styx-migrate` support Lambdas, all in `scripts/provision.sh` |
| Amazon API Gateway | Yes | HTTP API (`styx-router-api`) fronting `styx-router`, `AWS_PROXY` integration |
| Amazon ECS Fargate | Yes | `styx-console` service behind `styx-alb`, live demo URL below |
| Amazon Bedrock | Yes | Titan Text Embeddings V2 for precedent embeddings (`kernel/src/embedders/titan.ts`), Claude on Bedrock as an optional agent reasoning hook (`agent/src/reason.ts`) |
| AWS SSM Parameter Store | Yes | `/styx/database-url`, `/styx/webhook-secret`, both `SecureString`, decrypted only inside Lambdas via a scoped KMS key |
| Amazon S3 | No | Considered for run artifacts in the original spec, never wired up; not claimed |

---

## Demo URL

http://styx-alb-2003374125.us-east-1.elb.amazonaws.com/

## Repo URL

placeholder, filled in after the public GitHub repo is created (see step
7 of the packaging pass)

## Video URL

placeholder, filled in after Harshit records and uploads the video from
`docs/video/script.md`

---

## Feedback on CockroachDB AI tools (optional)

Written honestly, not as a compliance checkbox:

- **Managed MCP Server console discoverability.** The path from "I want
  read-only agent introspection" to "here is the endpoint and credential
  to configure" wasn't obvious from the console alone; it took more
  clicking around than the other CockroachDB Cloud features to find the
  activation flow. A more prominent entry point (or a callout on the
  cluster overview page) would help.
- **`extra_headers` vs. a documented `webhook_auth_header` option.** We
  needed to attach a shared secret to every changefeed webhook delivery
  for basic auth against our Lambda. `extra_headers` works and is what we
  shipped with, but the changefeed webhook sink documentation doesn't
  make it obvious up front whether that's the intended mechanism for
  auth specifically versus a general escape hatch, or whether a more
  purpose-built auth header option exists or is planned. A short,
  explicit "this is how you authenticate a webhook sink" doc section
  would have saved real time.
- **What worked well, unreservedly:** VECTOR, changefeeds, and
  serializable transactions all worked together, on the free tier and
  locally, without fighting the tooling once. Running a single-node
  insecure CockroachDB in Docker for local development and tests, with
  the same schema and the same SQL running against the cloud cluster
  with no divergence, was genuinely pleasant. `VECTOR` support being
  version-gated meant local dev had to tolerate its absence gracefully,
  which added a little code but was a reasonable ask, not a fight.
