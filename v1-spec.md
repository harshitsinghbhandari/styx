# STYX

### Durable commitments for autonomous agents

**Final Project Specification — v1.0**
CockroachDB × AWS Hackathon: Build with Agentic Memory
Submission deadline: **August 18, 2026, 5:00 PM EDT**

> In Greek myth, an oath sworn on the river Styx bound even the gods.
> Styx gives AI agents the same guarantee: promises stored as serializable,
> transactional state that cannot be double-spent, silently dropped, or
> accidentally broken.

---

## Table of Contents

1. [Positioning & Story](#1-positioning--story)
2. [Problem Statement](#2-problem-statement)
3. [What Styx Is (and Is Not)](#3-what-styx-is-and-is-not)
4. [Scope: V1 Hackathon Build](#4-scope-v1-hackathon-build)
5. [System Architecture](#5-system-architecture)
6. [Data Model](#6-data-model)
7. [Commitment Lifecycle](#7-commitment-lifecycle)
8. [The Transition Kernel](#8-the-transition-kernel)
9. [Extension Interfaces](#9-extension-interfaces)
10. [Event Pipeline: Changefeed → Lambda → Agents](#10-event-pipeline-changefeed--lambda--agents)
11. [MCP Integration (Read Path)](#11-mcp-integration-read-path)
12. [AWS Services](#12-aws-services)
13. [Agent Design](#13-agent-design)
14. [Demo Fixture: The GPU Marketplace](#14-demo-fixture-the-gpu-marketplace)
15. [Visualizer Spec](#15-visualizer-spec)
16. [Demo Video Script (3 Scenes, < 3 min)](#16-demo-video-script-3-scenes--3-min)
17. [Hackathon Requirements Compliance](#17-hackathon-requirements-compliance)
18. [Judging Criteria Mapping](#18-judging-criteria-mapping)
19. [Testing Strategy](#19-testing-strategy)
20. [Security & Production Readiness](#20-security--production-readiness)
21. [Repository Structure](#21-repository-structure)
22. [README Outline](#22-readme-outline)
23. [5-Day Build Plan](#23-5-day-build-plan)
24. [Risks & Mitigations](#24-risks--mitigations)
25. [Protocol Roadmap (Post-Hackathon)](#25-protocol-roadmap-post-hackathon)
26. [Submission Checklist](#26-submission-checklist)

---

## 1. Positioning & Story

**One-liner:**

> **Styx — a consistency layer for promises between autonomous agents.**

**The hook:**

> Most agent memory records what happened.
> Styx records what is *supposed* to happen — and keeps agents consistent
> when reality changes.

**The name:** An oath sworn on the Styx was the one promise even gods could
not break. That is the guarantee level Styx gives machine commitments. The
name is oblique by design — it names the *guarantee*, not the feature — so
the protocol is free to grow beyond commitments without outgrowing its name.

**The framing for judges:**

Nearly every submission at this hackathon will be shaped like:

```
user → agent → embeddings → CockroachDB
```

Styx is shaped like:

```
            ALICE AGENT
                 │
           makes promise
                 │
                 ▼
       ┌───────────────────┐
       │       STYX        │
       │                   │
       │  TRANSACTIONAL    │
       │  COMMITMENT       │
       │  KERNEL           │
       └────────┬──────────┘
                │
           CockroachDB
                │
          shared reality
            /        \
           /          \
     BOB AGENT     SELLER AGENT
```

CockroachDB is not glued onto the app as a memory store. The product
*fundamentally requires* CockroachDB-class correctness: serializable
isolation, distributed durability, changefeeds, and vector search in the
same database as the transactional truth.

**Opening line of the video:**

> "Everyone is building agents that remember the past.
> We built agents that remember the future."

---

## 2. Problem Statement

AI agents are moving into production workflows: writing code, running
pipelines, procuring resources, negotiating with other agents. Agent
frameworks today provide primitives for **thinking** (LLMs), **acting**
(tools), and **remembering the past** (RAG / conversation memory).

There is no primitive for **commitment**.

An agent saying *"I will do X"* is fundamentally different from a memory
that *"someone said X"*:

- A commitment constrains the future behavior of multiple parties.
- A commitment can conflict with another commitment (double-booking,
  double-spending, double-delegation).
- A commitment can *depend* on other commitments, so one failure cascades.
- A commitment must survive process crashes, retries, region failures, and
  concurrent access by autonomous writers.

A naive multi-agent system, where each agent keeps its own view of state,
produces this:

```
GPU available: 1

Alice → RESERVED ✅
Bob   → RESERVED ✅

available GPUs: -1  💀
```

Traditional application databases were tuned for human-scale reads and
writes. Agentic systems spawn autonomously, write constantly, act
concurrently, and need memory that never goes down — because an agent whose
memory goes offline does not degrade gracefully. It stops.

**Styx is the missing primitive: a shared, transactional, event-sourced
memory of obligations.**

---

## 3. What Styx Is (and Is Not)

### Styx IS

- An **event-sourced commitment kernel** on CockroachDB: a small set of
  tables and one transactional transition function that together guarantee
  commitments cannot be double-spent, conflict silently, or change without
  an auditable reason.
- A **dependency graph of promises** ("Promise Chains") with cascade
  detection: break one commitment, and every dependent commitment is
  flagged at-risk in the same transactionally-consistent world.
- A **wake-up mechanism**: CockroachDB changefeeds on the event log push
  transitions to AWS Lambda, which wakes affected agents.
- A **precedent memory**: past negotiations and settlements stored with
  embeddings in CockroachDB's distributed vector index, retrieved when an
  agent must repair a broken commitment.
- An **extendable spine**: commitment kinds are data + pluggable
  validators, not schema migrations. V1 ships two kinds; the protocol
  visibly accommodates many more.

### Styx is NOT (in V1)

- ❌ A DSL or arbitrary condition evaluator (no IF/THEN commitment logic)
- ❌ A plugin system or generic orchestration engine
- ❌ A reputation system
- ❌ A policy language
- ❌ A blockchain (say this out loud in the video if needed)
- ❌ A "multi-agent framework" — agents are deliberately simple actors
  around a smart kernel

Everything on the NOT list maps cleanly onto the V1 schema and is listed in
the roadmap (§25). The roadmap's credibility *is* the extensibility pitch.

---

## 4. Scope: V1 Hackathon Build

### The kernel (the product)

| Component | Ships in V1 |
|---|---|
| `commitments` table (generic, kind-as-data) | ✅ |
| `commitment_dependencies` (N:M promise chains) | ✅ |
| `commitment_events` (immutable, sequenced history) | ✅ |
| `transitionCommitment()` — single transactional write path | ✅ |
| Optimistic versioning (`expectedVersion`) | ✅ |
| Idempotency keys | ✅ |
| Commitment kinds: `promise`, `reservation` | ✅ |
| Cascade detection (at-risk propagation) | ✅ |
| Changefeed → Lambda → agent wake-up | ✅ |
| Precedent store on CockroachDB vector index | ✅ |
| MCP read path for agent introspection | ✅ |

### The kernel API surface (complete list — nothing else)

```
createPromise()
reserveResource()

activateCommitment()
fulfillCommitment()
revokeCommitment()
breakCommitment()

linkDependency()

getCommitment()
getObligations(agentId)
getDependents(commitmentId)
getHistory(commitmentId)

findPrecedents(conflictContext)
```

### The fixture (the demo, not the product)

A minimal GPU marketplace: one seller agent with finite GPU inventory, two
buyer agents (Alice, Bob) that act concurrently, one repair flow. Agents run
on Amazon Bedrock. The marketplace exists to exercise the kernel on camera.

### Explicit non-goals for the 5 days

- No user accounts / auth UI (service-to-service auth only)
- No mobile support for the visualizer
- No more than 2 commitment kinds implemented
- No live "kill a managed CockroachDB Cloud node" in the primary demo
  (see §24 — resilience is demonstrated by killing an **agent process**,
  plus an optional secondary local-cluster clip)

---

## 5. System Architecture

```
                        ┌──────────────────────────────────────┐
                        │            AWS (us-east-1)           │
                        │                                      │
   ┌──────────┐  HTTPS  │  ┌────────────────────────────────┐  │
   │ Visualizer│◄───────┼──┤  Styx API (Fastify, ECS Fargate)│ │
   │  (React)  │  SSE   │  │                                │  │
   └──────────┘         │  │  • transitionCommitment()      │  │
                        │  │  • kernel invariants           │  │
                        │  │  • REST + SSE                  │  │
                        │  └───────┬───────────────┬────────┘  │
                        │          │ WRITE PATH    │           │
                        │          │ (pg wire,     │           │
                        │          │  SERIALIZABLE)│           │
                        │          ▼               │           │
                        │   ┌────────────────┐     │           │
   ┌────────────────────┼──►│  CockroachDB   │     │           │
   │  READ PATH         │   │  Cloud         │     │           │
   │  (MCP, read-only)  │   │                │     │           │
   │                    │   │  commitments   │     │           │
┌──┴────────┐           │   │  dependencies  │     │           │
│  Agents   │           │   │  events        │     │           │
│ (Bedrock) │           │   │  precedents    │     │           │
│           │           │   │  VECTOR index  │     │           │
│ • Alice   │◄──────────┼───┤  CHANGEFEED    │     │           │
│ • Bob     │  wake-up  │   └───────┬────────┘     │           │
│ • Seller  │           │           │ webhook sink │           │
│ • Repair  │           │           ▼              │           │
└───────────┘           │   ┌────────────────┐     │           │
      ▲                 │   │  AWS Lambda    │     │           │
      │                 │   │  (Function URL)│     │           │
      └─────────────────┼───┤  event router  │─────┘           │
        invoke Bedrock  │   └────────────────┘                 │
                        │                                      │
                        │   Amazon S3: demo artifacts,         │
                        │   negotiation transcripts            │
                        └──────────────────────────────────────┘
```

**The architectural statement (put this sentence in the README, the video,
and the architecture slide):**

> Agents may reason freely about shared state through MCP, but they cannot
> mutate contractual state except through Styx's invariant-enforcing
> transactional API.

Write path: Styx API → CockroachDB over the PostgreSQL wire protocol, every
mutation inside a `SERIALIZABLE` transaction (CockroachDB's default).

Read path: agents introspect via the CockroachDB Cloud Managed MCP Server,
configured for **read-only** access (the Cloud MCP connection can be
authorized read, write, or both — we deliberately choose read).

Event path: changefeed on `commitment_events` → webhook sink → Lambda
Function URL → router wakes affected agents → agents act through the write
path. The loop closes through the database, never around it.

---

## 6. Data Model

All tables live in one CockroachDB Cloud database (`styx`). DDL below is
the authoritative V1 schema.

### 6.1 `agents`

```sql
CREATE TABLE agents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         STRING NOT NULL UNIQUE,          -- 'alice', 'bob', 'seller', 'repair'
    kind         STRING NOT NULL,                 -- 'buyer' | 'seller' | 'repair'
    api_key_hash STRING NOT NULL,                 -- service-to-service auth
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.2 `resources`

```sql
CREATE TABLE resources (
    key          STRING PRIMARY KEY,              -- 'gpu-17'
    owner_agent  UUID NOT NULL REFERENCES agents(id),
    capacity     INT NOT NULL CHECK (capacity >= 0),
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Capacity accounting is **not** done by decrementing this column from app
code. Available capacity is derived transactionally inside the kernel as
`capacity - COUNT(active reservations on resource)` within the same
serializable transaction that creates a new reservation. This is the
double-booking guarantee (§8.3).

### 6.3 `commitments` — current truth

Kind is **data, not a database enum**. Adding a new commitment kind is a
registry entry and a terms validator — never a schema migration.

```sql
CREATE TABLE commitments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              STRING NOT NULL,            -- 'promise' | 'reservation' | future kinds
    protocol_version  STRING NOT NULL DEFAULT '1',
    debtor_agent_id   UUID NOT NULL REFERENCES agents(id),
    creditor_agent_id UUID NOT NULL REFERENCES agents(id),
    resource_key      STRING REFERENCES resources(key),  -- nullable: promises may be abstract
    terms             JSONB NOT NULL,
    status            STRING NOT NULL DEFAULT 'draft',
                      -- 'draft' | 'active' | 'at_risk' | 'fulfilled' | 'broken' | 'revoked'
    valid_until       TIMESTAMPTZ,
    version           INT NOT NULL DEFAULT 1,     -- optimistic concurrency
    idempotency_key   STRING UNIQUE,              -- dedupe agent retries
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    INDEX idx_commitments_debtor  (debtor_agent_id, status),
    INDEX idx_commitments_resource (resource_key, status),
    INDEX idx_commitments_expiry  (valid_until) WHERE status = 'active'
);
```

Example rows:

```jsonc
// kind = "promise"
terms = {
  "deliver": "training-run-882",
  "deadline": "2026-08-21T17:00:00Z"
}

// kind = "reservation"
terms = {
  "resource": "gpu-17",
  "quantity": 1,
  "window": { "from": "2026-08-15T02:00Z", "to": "2026-08-15T06:00Z" },
  "max_price_usd": 40
}
```

### 6.4 `commitment_dependencies` — Promise Chains (N:M)

A dedicated join table, not a `depends_on` column: promises quickly develop
N:M dependencies, and the cascade visualizer becomes generic for free.

```sql
CREATE TABLE commitment_dependencies (
    commitment_id    UUID NOT NULL REFERENCES commitments(id),
    depends_on_id    UUID NOT NULL REFERENCES commitments(id),
    dependency_type  STRING NOT NULL DEFAULT 'requires',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (commitment_id, depends_on_id),
    CONSTRAINT no_self_dependency CHECK (commitment_id != depends_on_id)
);
```

Cycle prevention is enforced in the kernel at `linkDependency()` time via a
recursive CTE reachability check inside the same transaction.

### 6.5 `commitment_events` — immutable history

Every transition is one transaction: validate → update `commitments` →
append `commitment_events` → commit. The changefeed watches **this table**,
so the event stream is exactly the audit log.

```sql
CREATE TABLE commitment_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commitment_id  UUID NOT NULL REFERENCES commitments(id),
    sequence       INT NOT NULL,                  -- per-commitment, gapless
    event_type     STRING NOT NULL,               -- 'created' | 'activated' | 'fulfilled'
                                                  -- | 'broken' | 'revoked' | 'flagged_at_risk'
                                                  -- | 'dependency_linked' | 'repaired'
    from_status    STRING,
    to_status      STRING,
    actor_agent_id UUID REFERENCES agents(id),    -- NULL for kernel-initiated (cascades, expiry)
    reason         STRING,
    payload        JSONB NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (commitment_id, sequence)
);
```

This is what lets an agent (or a judge) ask three different questions:

```
"What do I owe?"        → commitments
"Why do I owe it?"      → commitment_events
"What broke it?"        → dependency graph + events
```

### 6.6 `precedents` — vector memory of settlements

```sql
CREATE TABLE precedents (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    situation      STRING NOT NULL,       -- natural-language summary of the conflict
    resolution     STRING NOT NULL,       -- natural-language summary of the settlement
    outcome        JSONB NOT NULL,        -- structured: replacement terms, cost delta, etc.
    source_event   UUID REFERENCES commitment_events(id),
    embedding      VECTOR(1024) NOT NULL, -- Bedrock Titan Text Embeddings V2
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    VECTOR INDEX idx_precedents_embedding (embedding)
);
```

Precedents are written automatically by the kernel when a repair completes:
the situation/resolution summaries are generated by the repair agent, the
embedding by Amazon Bedrock (Titan Embeddings), and the row committed in
the same database as the commitments it describes — no separate vector
store, no consistency gap between operational truth and semantic memory.

**Demo-honesty rule:** precedents used in the video are generated **live**
by running earlier marketplace rounds during the recording session, not
hand-seeded fixtures. The retrieval shown in Scene 3 retrieves a settlement
the audience watched happen.

---

## 7. Commitment Lifecycle

One generic lifecycle, fixed for all kinds — future commitment kinds reuse
it without new infrastructure.

```
                activate
   DRAFT ──────────────────► ACTIVE
                               │
                               │ (kernel cascade)
                               ├──────────────► AT_RISK ──┐
                               │                   │      │ repair
                               │                   │      ▼
                ┌──────────────┼──────────────┐    │   ACTIVE
                │              │              │    │
                ▼              ▼              ▼    ▼
           FULFILLED        BROKEN         REVOKED
           (terminal)      (terminal)     (terminal)
```

Legal transitions (the complete table — enforced by the kernel, tested
exhaustively):

| From | Action | To | Actor |
|---|---|---|---|
| draft | activate | active | debtor |
| draft | revoke | revoked | debtor or creditor |
| active | fulfill | fulfilled | debtor |
| active | break | broken | debtor, or kernel (expiry) |
| active | revoke | revoked | creditor |
| active | flag_at_risk | at_risk | **kernel only** (cascade) |
| at_risk | repair | active | kernel (after replacement linked) |
| at_risk | break | broken | debtor or kernel |
| at_risk | fulfill | fulfilled | debtor |

Everything else is an `InvalidTransition` error. Terminal states are
terminal — repair never resurrects a broken commitment; it links a **new**
replacement commitment into the dependency graph (visually: the graph
rewires, P-001 stays ❌).

**Cascade rule:** when a commitment enters `broken` or `revoked`, the
kernel — inside the same transaction — walks `commitment_dependencies`
upward (recursive CTE) and flags every transitively dependent `active`
commitment as `at_risk`, appending one `flagged_at_risk` event per
commitment. One atomic commit produces the entire cascade; the changefeed
then emits one wake-up per affected commitment. Agents never observe a
half-propagated world.

---

## 8. The Transition Kernel

### 8.1 The single write path

Every mutation in the entire system funnels through one function:

```ts
transitionCommitment({
  commitmentId:     string,
  action:           'activate' | 'fulfill' | 'break' | 'revoke'
                  | 'flag_at_risk' | 'repair',
  actorId:          string,
  expectedVersion:  number,
  idempotencyKey:   string,
  reason?:          string,
  evidence?:        Record<string, unknown>
}): Promise<TransitionResult>
```

Internal sequence (all inside `BEGIN; ... COMMIT;` at SERIALIZABLE):

```
BEGIN (SERIALIZABLE — CockroachDB default)

  1. idempotency check:
       if a committed event exists with this idempotency key
       → return that prior result (no-op replay)

  2. load commitment FOR UPDATE

  3. verify:
       • expectedVersion matches current version   → else VersionConflict
       • actor is permitted for this action        → else Forbidden
       • (from_status, action) is a legal edge     → else InvalidTransition
       • kind-specific invariants (CommitmentKind) → else InvariantViolation
       • resource invariants (see 8.3)             → else ResourceConflict

  4. UPDATE commitments SET status, version = version + 1, updated_at

  5. INSERT commitment_events (next sequence, full context)

  6. if action ∈ {break, revoke}:
       cascade: flag dependents at_risk (recursive CTE)
       + one event per flagged commitment

COMMIT
```

CockroachDB retries serialization conflicts; the kernel wraps the
transaction in a standard retry loop with capped exponential backoff. The
caller sees exactly one of: success, a typed rejection, or the replayed
prior result.

### 8.2 Idempotency — why from day one

An agent times out after sending `RESERVE gpu-17`. It cannot know whether
the operation committed. It retries.

```
Without idempotency:            With idempotency:

reserve                         idempotency_key =
  ↓                               "mission-82:reserve:gpu-17"
network timeout
  ↓                             second request returns the
retry                           result of the first —
  ↓                             byte-for-byte, no duplicate
possible duplicate action       reservation possible
```

Autonomous writers retry far more aggressively than humans. Idempotency is
not polish here; it is table stakes for agentic writers — and exactly the
kind of production detail judges are told to look for.

### 8.3 The double-booking guarantee (the demo's beating heart)

`reserveResource()` creates a `reservation`-kind commitment. Its kind
invariant, checked inside the serializable transaction:

```sql
SELECT r.capacity - COUNT(c.id) AS available
FROM resources r
LEFT JOIN commitments c
  ON c.resource_key = r.key
 AND c.kind = 'reservation'
 AND c.status IN ('active', 'at_risk')
WHERE r.key = $1
GROUP BY r.capacity;
-- invariant: available >= requested quantity
```

Two agents race for the last GPU: CockroachDB's serializable isolation
guarantees the interleaving is equivalent to *some* serial order. One
transaction commits; the other observes zero availability (or hits a
serialization retry and then observes zero availability) and receives a
typed `ResourceConflict` — which is not an error to an agent. It is a
**negotiation signal** (§13).

**Anticipated judge question — "why CockroachDB and not RDS Postgres?"**
Answer, in order: (1) single-node Postgres can also serialize one row, but
Styx's writers are autonomous agents in multiple regions — Alice's worker
runs in ap-south-1, Bob's in us-east-1, and both commit against the same
serializable truth with no single point of failure and no failover window
in which promises can fork; (2) the cascade + event log + changefeed +
vector precedents live in *one* consistent system — no outbox pattern, no
CDC sidecar, no vector store drifting from the operational truth; (3) an
agent's memory going down doesn't degrade the agent, it stops it —
"always-on" is a functional requirement of the product, not an ops
preference.

---

## 9. Extension Interfaces

The spine is extendable through **data and two interfaces** — not class
hierarchies, plugin loaders, or a DSL. Exactly two abstractions earn their
keep in V1:

### 9.1 `CommitmentKind`

```ts
interface CommitmentKind {
  name: string;                                       // 'promise' | 'reservation' | ...

  /** Static shape/semantic validation of the terms JSON. */
  validateTerms(terms: unknown): Result;

  /** May this draft become active? (e.g. reservation capacity check) */
  validateActivation(ctx: KernelContext): Promise<Result>;

  /** Kind-specific rules on other transitions, if any. */
  validateTransition(ctx: TransitionContext): Promise<Result>;
}
```

V1 registry ships exactly two implementations:

```
PromiseKind        — terms require {deliver, deadline}; no resource invariant
ReservationKind    — terms require {resource, quantity}; capacity invariant §8.3
```

README lists the door this leaves open (implemented = 2, one registry entry
each away):

```
LeaseKind          time-boxed exclusive use with auto-expiry
OfferKind          revocable pre-commitment
DelegationKind     transferable authority with scope + expiry
EscrowKind         commitment held pending a counterparty event
AuthorizationKind  spend/action limits (AuthorityOS as a kind, not a product)
SLAKind            recurring obligation with breach accounting
```

### 9.2 `PrecedentStore`

```ts
interface PrecedentStore {
  findSimilar(
    situation: ConflictContext,
    limit: number
  ): Promise<Precedent[]>;

  record(p: NewPrecedent): Promise<void>;
}
```

V1 implementation: embed the conflict summary with Bedrock Titan
Embeddings, query CockroachDB's distributed vector index
(`ORDER BY embedding <-> $1 LIMIT $2`). The interface honestly admits
smarter retrieval (hybrid, graph-aware, outcome-weighted) can slot in
later without touching the kernel.

**Deliberately not abstracted:** the agents. They are demo actors —
hardcoded, simple, replaceable. All extensibility budget goes into the
commitment layer, because that is the product.

---

## 10. Event Pipeline: Changefeed → Lambda → Agents

The changefeed watches `commitment_events` — the append-only log — not
every mutation of every business table. The event stream *is* the audit
log; consumers get exactly the semantic transitions, in order, with
checkpointed progress that survives coordinator failure.

```
CockroachDB Cloud
      │
      │  CREATE CHANGEFEED FOR TABLE commitment_events
      │    INTO 'webhook-https://<lambda-function-url>?insecure_tls_skip_verify=false'
      │    WITH updated, resolved='10s';
      ▼
AWS Lambda (Function URL, HTTPS)
      │
      │  styx-event-router:
      │    1. verify shared-secret header
      │    2. parse event rows (INSERT-only table → no tombstone handling)
      │    3. resolve affected agents:
      │         debtor + creditor of the commitment
      │         + debtors of at_risk-flagged dependents
      │    4. per affected agent → invoke agent runtime
      ▼
Agent runtime (Bedrock invocation, §13)
      │
      │  reasons over: the event + MCP reads + precedents
      ▼
Styx API (write path) — new transitions, closing the loop
```

Design points:

- **At-least-once delivery** is the changefeed contract; the router is
  idempotent (event `id` dedupe with a 24 h DynamoDB-free approach: a tiny
  `processed_events` table in CockroachDB itself — one system, again).
- Wake-ups carry the event, never instructions. Agents decide what to do;
  the kernel decides what is true.
- The visualizer subscribes to the same stream (API relays via SSE), so
  what the audience sees and what the agents see is one feed.

---

## 11. MCP Integration (Read Path)

The CockroachDB Cloud Managed MCP Server (`https://cockroachlabs.cloud/mcp`)
is connected to the agents' toolchain with **read-only** authorization —
the Cloud MCP connection supports read, write, or both; Styx deliberately
grants read.

Agents use MCP to introspect shared reality in natural language:

```
"What commitments am I currently obligated to fulfill?"
"Show Bob's active obligations."
"Why was the reservation on gpu-17 revoked?"          → commitment_events
"Which promises depend on P-002?"                     → dependency graph
"What active commitments expire in the next hour?"
```

Development workflow also runs through MCP: Claude Code connects to the
cluster via the Cloud Console config snippet for schema inspection and
query design during the build (mention this in the feedback section of the
submission — it's the tool working as intended).

**The security statement this buys us (repeat everywhere):** the read path
is open for reasoning; the write path is closed except through the kernel.
Agents cannot `UPDATE commitments` into an illegal state even if their LLM
reasoning goes sideways — the invariants live below the intelligence.

---

## 12. AWS Services

| Service | Role | Requirement box |
|---|---|---|
| **Amazon Bedrock** | Agent reasoning (Claude on Bedrock) + Titan Text Embeddings V2 for precedent vectors | ✅ AWS service #1 |
| **AWS Lambda** | Changefeed webhook sink (Function URL) + event router | ✅ AWS service #2 |
| **Amazon ECS (Fargate)** | Styx API + visualizer hosting | ✅ AWS service #3 |
| **Amazon S3** | Demo artifacts, negotiation transcripts, video assets | ✅ AWS service #4 |

(One AWS service is required; Styx uses four, each doing a real job.)

CockroachDB tools used (two required):

| Tool | Role | Requirement box |
|---|---|---|
| **Distributed Vector Indexing** | Precedent memory, same DB as transactional truth | ✅ CRDB tool #1 |
| **Cloud Managed MCP Server** | Agent read/introspection path + dev workflow | ✅ CRDB tool #2 |
| **Changefeeds** | Event pipeline (not on the named tools list, but deep CRDB usage — call it out in "how we used CockroachDB") | ➕ bonus depth |
| **ccloud CLI** | Cluster provisioning in setup scripts (`scripts/provision.sh`), giving reproducible infra | ➕ stretch: if time allows, makes tool #3 |

---

## 13. Agent Design

Four agents, all deliberately simple. Each is a thin loop: **wake → read
(MCP) → reason (Bedrock) → act (Styx API) → sleep**. No agent framework.

| Agent | Role | Behavior |
|---|---|---|
| **Seller** | Owns `gpu-17` (capacity 1) + inventory | Accepts/declines reservation proposals; publishes offers |
| **Alice** | Buyer | Needs the last GPU for training job A; reserves immediately |
| **Bob** | Buyer | Needs the last GPU for training job B; races Alice; on `ResourceConflict`, enters the renegotiation loop |
| **Repair** | Watchdog | Woken by `at_risk` events; queries precedents; proposes replacement commitments; links them into the chain |

### Bob's renegotiation loop (the "properly agentic" part)

```
ResourceConflict received
  ↓
Bob (Bedrock):
  "My commitment failed. Goal: complete training before Friday.
   Options: another GPU / delayed window / spot / reduce requirement."
  ↓
findPrecedents("GPU contention, deadline-constrained buyer")
  ↓
Precedent (similarity 0.94, generated live in an earlier round):
  "Resolution: move training to 02:00–06:00 UTC, 38% lower cost"
  ↓
Bob → Seller: "Reserve gpu-17, 02:00–06:00 UTC, $31"
  ↓
Seller accepts → new reservation commits → Bob's goal preserved
```

Vector memory has a purpose — but it is not the product. The transactional
conflict *created* the moment where memory mattered.

### Crash-resilience demo (agent process, not managed DB node)

Mid-negotiation, `kill -9` Bob's worker on camera. A replacement worker
starts cold, reads authoritative commitment state via MCP
("what are my active drafts and obligations?"), finds the in-flight
negotiation, and resumes. Nothing forked, nothing duplicated
(idempotency keys), nothing lost (the truth was never in the process).

> Production claim, stated accurately in the video: "Styx's commitment
> state resides in a distributed, multi-region database designed to survive
> infrastructure failures." Optional secondary clip (stretch, §23 Day 4):
> a local 3-node self-hosted cluster surviving a node kill during the
> Alice/Bob race — never the centerpiece, never against the managed
> service.

---

## 14. Demo Fixture: The GPU Marketplace

Minimal world state:

```
resources:   gpu-17 (capacity 1, owner: seller)
agents:      alice, bob, seller, repair
supply chain fixture (Scene 2):
  P-001  Materials by Wednesday      (supplier → manufacturer)
  P-002  Manufacture by Thursday     (manufacturer → seller)   depends_on P-001
  P-003  Deliver by Friday           (seller → customer)       depends_on P-002
```

The supply-chain promises are created through the same public API the
buyers use (`scripts/seed-chain.ts`) — the fixture exercises zero private
kernel surface.

---

## 15. Visualizer Spec

One-page React app, dark theme, projector-friendly. Three panels:

1. **Graph panel** — force-directed commitment graph. Nodes = commitments
   (color by status: green active, amber at_risk, red broken, gray
   terminal). Edges = dependencies. Status changes animate from the SSE
   stream in real time.
2. **Event ticker** — the `commitment_events` stream, human-readable:
   `14:02:11  P-001 active → broken  (supplier)  "materials unavailable"`.
3. **Agent lane** — one row per agent showing last wake-up reason and last
   action taken.

One demo control, styled as a big red button: **BREAK P-001**. Everything
else on screen is caused, not scripted.

Build honestly and small: `react-force-graph` or plain SVG + d3-force,
SSE from the Styx API, no state library, no design system. Budget: one day
(§23 Day 4), because the animation *is* the pitch.

---

## 16. Demo Video Script (3 Scenes, < 3 min)

**Cold open (0:00–0:15)** — black screen, one line typed out:

> "Everyone is building agents that remember the past.
> We built agents that remember the future."

Cut to the Styx name card: *"An oath sworn on the Styx bound even the
gods."*

**Scene 1 — Conflict (0:15–1:00)**
Split terminal: Alice (ap-south-1 worker) and Bob (us-east-1 worker) fire
simultaneous reservations for the last GPU. Visualizer shows:

```
ALICE   ✓ COMMITTED
BOB     ✕ CONFLICT — resource already committed
```

Voiceover: one serializable transaction won; the other received not an
error but a negotiation signal. "This is CockroachDB's default isolation
doing product work."

**Scene 2 — Consequence (1:00–1:45)**
The P-001→P-002→P-003 chain on the graph panel. Press **BREAK P-001**.
Cascade animates in one beat: P-001 ❌, P-002 ⚠, P-003 ⚠. Ticker shows the
changefeed → Lambda wake-ups. Voiceover: "One transaction broke a promise.
The same transaction told every dependent promise. No poller, no queue —
the database is the nervous system."

**Scene 3 — Repair (1:45–2:40)**
Repair agent wakes, searches precedents (vector index), retrieves the
settlement the viewer watched happen in an earlier round, proposes an
alternate supplier (+$12, deadline preserved). Graph rewires:

```
P-001 ❌        P-004 ✓ (new supplier)
                   │
                   ▼
                P-002 ✓ → P-003 ✓
```

Mid-scene: `kill -9` Bob's worker, replacement resumes from shared state.

**Close (2:40–3:00)** — architecture slide + the statement:

> "Agents reason freely through MCP. They mutate contractual state only
> through Styx's invariant-enforcing kernel. Promises they cannot
> accidentally break."

---

## 17. Hackathon Requirements Compliance

| Requirement | Styx |
|---|---|
| Agentic app with CockroachDB as persistent memory layer | ✅ Commitment kernel = the memory layer (state + transactional data + embeddings) |
| Deployed on AWS | ✅ ECS Fargate + Lambda + Bedrock + S3 |
| ≥ 2 CockroachDB tools | ✅ Distributed Vector Indexing + Managed MCP Server (+ changefeeds depth, + ccloud stretch) |
| ≥ 1 AWS service | ✅ Four (Bedrock, Lambda, ECS, S3) |
| Public open-source repo, license visible | ✅ Apache-2.0, About section |
| README, deps, configs, setup/run instructions | ✅ §22 |
| Functional demo app URL | ✅ Visualizer on ECS (public ALB URL) |
| Public video < 3 min (YouTube/Vimeo) | ✅ §16 |
| Identify CRDB tools used + what the agent did with them | ✅ Dedicated README section |
| Identify AWS services used + how | ✅ Dedicated README section |
| Optional: architecture diagram | ✅ §5 rendered as an image |
| Optional: feedback on CRDB AI tools | ✅ MCP dev-workflow notes |

---

## 18. Judging Criteria Mapping

**Agentic Memory Design** — CockroachDB holds state, transactional data,
an event-sourced audit log, a dependency graph, and embeddings — in one
consistent system. Far beyond toy queries; the memory *is* the product.

**Technical Implementation** — single serializable write path, optimistic
versioning, idempotency, gapless event sequences, cycle-checked dependency
graph, idempotent at-least-once event routing, read-only MCP. Concurrency
test suite (§19) proves it.

**Real-World Impact** — the GPU marketplace is the smallest visual case of
a general class: procurement, travel booking, logistics windows, cloud
budget negotiation, inter-department delegation, agent marketplaces. Every
one of them dies on double-booking and orphaned obligations.

**Production Readiness** — invariants below the intelligence; agents
cannot write illegal state even when LLM reasoning fails. Auditability by
construction (event log = changefeed source). Typed failures as
negotiation signals. Crash-resume demonstrated live.

**Creativity & Originality** — the inversion: memory of the *future*.
Committed future state, not predictions. Plus the roadmap (§25) showing
the team understands the design space beyond what it shipped.

---

## 19. Testing Strategy

The kernel earns its claims through tests, written **Day 1** before any
agent exists:

1. **Race test (the flagship):** N=50 concurrent `reserveResource()` calls
   against capacity 1. Assert exactly 1 success, 49 typed conflicts, and
   derived availability never < 0. Run in CI on every commit.
2. **Transition matrix test:** every (status, action) pair — legal edges
   succeed, all others raise `InvalidTransition`. Exhaustive, generated
   from the table in §7.
3. **Idempotency test:** same idempotency key twice concurrently → one
   event, identical results returned to both callers.
4. **Version conflict test:** stale `expectedVersion` → `VersionConflict`,
   no write, no event.
5. **Cascade test:** break the root of a 3-deep, diamond-shaped chain →
   all dependents at_risk, one event each, single commit timestamp
   cluster; terminal dependents untouched.
6. **Cycle test:** `linkDependency()` creating a cycle → rejected.
7. **Event-gap test:** sequences per commitment are gapless and ordered.
8. **Router idempotency test:** duplicate changefeed delivery → one agent
   wake-up.

CI: GitHub Actions against a single-node `cockroach start-single-node`
container (serializable semantics identical to Cloud).

---

## 20. Security & Production Readiness

- **AuthN:** service-to-service API keys (hashed at rest) per agent; every
  kernel call carries `actorId` verified against the key.
- **AuthZ:** transition table is actor-aware (§7) — a creditor cannot
  fulfill, a stranger cannot revoke. Kernel-only actions
  (`flag_at_risk`) rejected from any external actor.
- **MCP:** read-only authorization; audit logging on (Cloud default
  behavior); connection string scoped to the `styx` database.
- **Secrets:** AWS SSM Parameter Store; nothing in the repo; example env
  in `.env.example`.
- **Least privilege:** Lambda role = invoke-Bedrock + logs only; ECS task
  role = SSM read + S3 prefix; CockroachDB SQL user for the API ≠ MCP
  user.
- **Observability:** every response carries the transition's event id;
  structured JSON logs; the event table is the trace.
- **Failure honesty:** at-least-once delivery documented; router dedupe
  documented; retry/backoff bounds documented. "What happens when things
  go wrong" gets its own README section, because the judging criteria ask
  for exactly that sentence.

---

## 21. Repository Structure

```
styx/
├── LICENSE                      # Apache-2.0 (visible in About)
├── README.md                    # §22
├── docs/
│   ├── architecture.png
│   ├── SPEC.md                  # this document
│   └── protocol-roadmap.md      # §25 expanded
├── kernel/                      # THE PRODUCT
│   ├── src/
│   │   ├── db/schema.sql
│   │   ├── transition.ts        # transitionCommitment()
│   │   ├── kinds/
│   │   │   ├── registry.ts
│   │   │   ├── promise.ts
│   │   │   └── reservation.ts
│   │   ├── cascade.ts
│   │   ├── precedents.ts        # PrecedentStore (vector impl)
│   │   └── api.ts               # Fastify: REST + SSE
│   └── test/                    # §19, in this order
├── router/                      # Lambda: changefeed → wake-ups
│   └── src/handler.ts
├── agents/                      # demo actors — deliberately simple
│   ├── shared/loop.ts           # wake → MCP read → Bedrock → act
│   ├── alice.ts
│   ├── bob.ts
│   ├── seller.ts
│   └── repair.ts
├── visualizer/                  # React + SSE + force graph
├── scripts/
│   ├── provision.sh             # ccloud CLI cluster setup (stretch → tool #3)
│   ├── migrate.sh
│   ├── seed-chain.ts            # P-001..P-003 via public API
│   └── demo-scene-*.sh          # reproducible demo drivers
└── .github/workflows/ci.yml     # race test on every commit
```

Stack: TypeScript end-to-end, `node-postgres` on the CockroachDB wire
protocol, Fastify, AWS SDK v3, React + Vite. No ORM (the kernel's SQL is
the spec), no agent framework, no state library.

---

## 22. README Outline

1. Name card + one-liner + the two-sentence myth.
2. The 30-second pitch: past-memory vs. future-memory; the Alice/Bob
   double-booking figure.
3. Architecture diagram + the read-path/write-path statement.
4. **How we used CockroachDB** (required): vector indexing → precedents;
   MCP → agent introspection + dev workflow; changefeeds → nervous system;
   serializable transactions → the guarantee. What the agent *did* with
   each.
5. **How we used AWS** (required): Bedrock (reasoning + embeddings),
   Lambda (event router), ECS (hosting), S3 (artifacts).
6. Quickstart: `provision.sh` → `migrate.sh` → env → `docker compose up`
   → open visualizer → `demo-scene-1.sh`.
7. The kernel: lifecycle diagram, transition table, invariants, test
   suite badge.
8. When things go wrong: delivery semantics, retries, idempotency, crash
   resume.
9. Protocol roadmap (§25) — one paragraph per future kind, each mapped to
   the existing schema.
10. Feedback on CockroachDB AI tools (optional box, filled honestly).
11. License.

---

## 23. 5-Day Build Plan (Aug 13 → Aug 18, 5 PM EDT)

**Day 1 (Thu Aug 13) — The kernel is the deadline.**
Schema + migrations; `transitionCommitment()` with versioning +
idempotency; kinds registry with `PromiseKind`/`ReservationKind`; cascade
CTE; tests 1–7 green locally. *Exit bar: 50-way race test passes.*

**Day 2 (Fri Aug 14) — The world reacts.**
CockroachDB Cloud cluster (provision via ccloud, script it); changefeed →
Lambda Function URL → router with dedupe (test 8); Fastify API + SSE;
MCP read-only connection configured and queried from a scratch agent.
*Exit bar: breaking a seeded promise wakes a logging stub through the full
pipeline.*

**Day 3 (Sat Aug 15) — The society.**
Agent loop (`wake → MCP → Bedrock → act`); Alice/Bob/Seller; Bob's
renegotiation with `findPrecedents()`; precedent recording on settlement;
Titan embeddings wired; run marketplace rounds to accrete **live**
precedents. *Exit bar: Scene 1 and Scene 3 happen end-to-end headlessly.*

**Day 4 (Sun Aug 16) — The show.**
Visualizer (graph, ticker, agent lane, the red button); ECS deployment +
public URL; crash-resume flow polished; stretch (only if all green by
evening): local 3-node node-kill clip; ccloud provisioning promoted to
featured tool #3. *Exit bar: all three scenes run off `demo-scene-*.sh` on
the deployed URL.*

**Day 5 (Mon Aug 17) — The story.**
Record and cut the video (script §16); README (§22); architecture image;
roadmap doc; feedback section; fresh-clone quickstart verified on a clean
machine; **submit Monday night** — never on deadline day.

**Buffer (Tue Aug 18, until 5 PM EDT):** fixes only. No features. Touch
nothing that is green.

**Standing scope rule:** if any day's exit bar is missed, cut from the
top of the stretch list (node-kill clip → ccloud feature → visualizer
polish → repair-agent eloquence), never from the kernel or the tests.

---

## 24. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Changefeed webhook quirks (batching, resolved messages, TLS) | Medium | Day 2 spike with a logging Lambda before building the router; keep router parsing defensive; resolved timestamps ignored by design |
| Bedrock latency makes the demo drag | Medium | Agents' reasoning prompts are short and structured; scenes driven by scripts so pauses can be cut in edit; never live-type in the video |
| Serialization retries under the race test flake CI | Low | Kernel retry loop with jitter; test asserts outcomes, not timings |
| MCP setup friction with agent runtime | Medium | Fallback: agents introspect via read-only SQL user through the API's query endpoints; MCP remains the featured dev-workflow + introspection story with recorded evidence — decide by Day 3 noon |
| Visualizer eats Day 4 | Medium | Panel priority: graph > ticker > agent lane; ticker alone can carry Scene 2 if needed |
| Demo looks staged | — | Precedents accreted live (§6.6); one red button, everything else caused; scripts in repo so judges can reproduce every scene |
| Scope creep toward the NOT list (§3) | Certain | The NOT list is printed and taped to the monitor |

---

## 25. Protocol Roadmap (Post-Hackathon)

Each item maps onto the **existing** schema — that mapping is the
extensibility proof:

- **LeaseKind / OfferKind / EscrowKind / SLAKind** — registry entries +
  terms validators. Zero migrations.
- **Conditional commitments** — a `condition` field in terms + a guard in
  `validateTransition`; the lifecycle and event log are untouched.
- **Delegation & authority (AuthorityOS)** — `DelegationKind` whose
  fulfillment grants scoped authority; "who gave this agent the right to
  do this?" is answered by walking commitments, exactly like promise
  chains. A commitment kind, not a second product.
- **Epistemic layer** — beliefs with evidence and confidence as a sibling
  table sharing the event-sourcing pattern; disputes as commitments to
  verify.
- **Multi-party settlement** — settlement as a commitment that terminally
  resolves a set of others in one transaction; the cascade machinery
  already spans the graph.
- **Reputation** — derived, never stored as truth: fold
  `commitment_events` (fulfilled vs. broken, repaired vs. abandoned) into
  scores. The audit log was the dataset all along.

---

## 26. Submission Checklist

- [ ] Repo public, Apache-2.0 visible in About
- [ ] README complete per §22, quickstart verified from a fresh clone
- [ ] Demo URL live (visualizer on ECS) and stable
- [ ] Video < 3:00, public on YouTube, captioned
- [ ] CockroachDB tools section: vector indexing + MCP (+ changefeeds,
      + ccloud if promoted) — with *what the agent did with them*
- [ ] AWS services section: Bedrock, Lambda, ECS, S3 — with how
- [ ] Architecture diagram uploaded
- [ ] Feedback on CockroachDB AI tools written
- [ ] CI green; race test badge in README
- [ ] Submitted **Monday Aug 17, night** — Tuesday is buffer only

---

*Styx v1.0 — final spec. The next commit is `kernel/src/db/schema.sql`.*