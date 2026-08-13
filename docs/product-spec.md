# Styx

## Product Specification

**Version:** 1.0
**Product category:** Agent infrastructure / coordination protocol
**Primary concept:** Transactional commitment infrastructure for autonomous AI agents
**Tagline:** **A consistency layer for promises between autonomous agents.**

---

# 1. Executive Summary

AI agents are increasingly capable of planning, calling tools, negotiating with other agents, modifying infrastructure, purchasing resources, scheduling work, and operating semi-autonomously.

The infrastructure surrounding those agents, however, remains optimized for a world where agents mostly **think** and **remember**, rather than a world where they **commit**.

An agent can say:

> “I will reserve this GPU.”

Another agent can say:

> “I will deliver this resource by Friday.”

A third can proceed based on those statements.

Today, those statements usually exist as messages, tool outputs, application state, or retrieved memories. They are not durable commitments with transactional semantics.

This creates a new class of distributed-system failures:

* two agents reserve the same scarce resource;
* an agent retries an action and duplicates a commitment;
* a dependent agent continues operating after an upstream promise has failed;
* agents disagree about which commitment is authoritative;
* an agent crashes after making a promise but before recording its local state;
* concurrent agents make mutually incompatible decisions;
* downstream agents cannot determine why an obligation exists;
* a failed commitment does not automatically notify dependent actors;
* agents cannot reliably renegotiate when reality diverges from a plan.

**Styx solves this problem.**

Styx is a **transactional commitment protocol and runtime for autonomous agents**.

Rather than merely remembering what happened, Styx gives agents a durable representation of:

> **what is supposed to happen.**

Agents use Styx to create, activate, fulfill, revoke, inspect, depend upon, and react to commitments.

These commitments become shared, durable facts about the future.

At the center of Styx is a small generic commitment kernel built around:

* commitments;
* dependencies;
* immutable events;
* transactional state transitions;
* idempotent operations;
* resource invariants;
* event-driven agent wakeups;
* precedent retrieval;
* extensible commitment kinds.

The initial implementation includes only two commitment kinds:

* `PROMISE`
* `RESERVATION`

The protocol is intentionally designed so future capabilities—leases, delegation, authorization, escrow, SLAs, conditional commitments, offers, contracts, budgets, reputation—can be implemented without replacing the core.

---

# 2. Product Thesis

Most agent-memory products answer:

> “What happened before?”

Styx answers:

> **“What must happen next?”**

Traditional memory is retrospective.

Styx introduces **prospective memory** for autonomous systems: durable machine-readable representations of promises, obligations, reservations, dependencies, deadlines, and their consequences.

The deeper product thesis is:

> As agents become autonomous actors, coordination will become a database consistency problem.

The problem is no longer merely whether an agent can reason correctly.

The problem is whether **multiple reasoning systems can maintain one coherent reality**.

Styx provides that shared reality.

---

# 3. Product Vision

Styx aims to become a neutral coordination layer for autonomous agents.

Any agent framework should eventually be able to ask:

```text
What commitments do I currently have?

What commitments depend on me?

What resources have already been reserved?

Can I safely make this promise?

What will be affected if this promise fails?

Who created this obligation?

Has this operation already been executed?

What similar conflicts have occurred before?

How were they resolved?

What changed while I was offline?
```

And perform:

```text
promise(...)
reserve(...)
fulfill(...)
revoke(...)
link(...)
inspect(...)
```

without knowing how Styx internally enforces consistency.

The long-term vision is:

```text
                    ┌───────────────────────┐
                    │         STYX          │
                    │                       │
                    │ Commitment Protocol   │
                    │ Shared Agent Reality  │
                    └───────────┬───────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
    Coding Agents         Commerce Agents       Operations Agents
         │                      │                      │
         ▼                      ▼                      ▼
    Cloud Resources         Purchases             Deployments
    Task Ownership          Reservations           SLAs
    Dependencies            Inventory              Recovery
```

Styx should be usable regardless of whether agents run on:

* Amazon Bedrock;
* Hermes Agent;
* OpenAI-compatible runtimes;
* LangGraph;
* custom Python agents;
* custom TypeScript agents;
* multi-agent orchestration systems;
* serverless workers;
* long-running services.

The commitment system is the product.

Agents are clients.

---

# 4. The Meaning of “Styx”

In mythology, an oath sworn upon the river Styx was binding even for the gods.

That metaphor maps directly onto the product:

> **Agents may say many things. A commitment recorded in Styx means something.**

The name communicates:

* promises;
* consequences;
* irrevocability;
* shared rules;
* durable obligations.

The product should avoid overly mythological UI language, however. The metaphor belongs primarily in branding.

The actual developer experience should use precise distributed-systems terminology.

---

# 5. Problem Definition

## 5.1 Current agent systems conflate messages with commitments

Consider:

```text
Agent A:
"I've reserved GPU-17."

Agent B:
"I've also reserved GPU-17."
```

The underlying system may have simply persisted both statements.

Memory worked perfectly.

Coordination failed.

This demonstrates the central distinction:

```text
Memory:
"Agent A said GPU-17 was reserved."

Commitment:
"GPU-17 is authoritatively reserved by Agent A."
```

Styx provides the second primitive.

---

# 6. Design Principles

## 6.1 Commitments are state, not conversation

An agent's natural-language output cannot be the authoritative source of commitment state.

Messages may explain commitments.

They do not define them.

---

## 6.2 All mutations pass through invariants

Agents cannot directly manipulate contractual state.

Every state mutation must pass through Styx's transaction layer.

---

## 6.3 Reads may be broad; writes must be narrow

Agents should have extensive ability to inspect:

* commitments;
* dependencies;
* events;
* precedents;
* resources.

Mutation privileges should be much more constrained.

---

## 6.4 History is immutable

Current state answers:

> What is true now?

Events answer:

> Why is it true?

Both are necessary.

---

## 6.5 Retries must be safe

Agents, networks, serverless workers, and LLM tool calls retry frequently.

Every consequential operation must support idempotency.

---

## 6.6 Extensibility comes from the protocol model

Styx should not become an elaborate plugin framework prematurely.

Extensibility comes primarily from:

* generic commitment kinds;
* JSON terms;
* reusable transition machinery;
* dependency edges;
* event subscribers;
* policy hooks.

---

## 6.7 AI does not enforce correctness

LLMs may:

* decide;
* negotiate;
* explain;
* retrieve precedent;
* generate proposals.

LLMs must not enforce:

* uniqueness;
* resource capacity;
* valid transitions;
* authorization;
* idempotency;
* consistency.

Those belong to deterministic infrastructure.

---

# 7. Primary Users

## 7.1 Agent developers

Developers building autonomous systems requiring durable coordination.

Examples:

* infrastructure agents;
* procurement agents;
* scheduling agents;
* logistics agents;
* coding agents;
* financial agents;
* marketplace agents.

---

## 7.2 Multi-agent platform builders

Framework developers needing shared coordination primitives.

They should be able to use Styx as infrastructure rather than implementing concurrency control themselves.

---

## 7.3 Enterprises operating autonomous agents

Organizations need:

* auditability;
* commitment visibility;
* authority boundaries;
* failure handling;
* policy enforcement;
* cross-agent observability.

---

# 8. Product Vocabulary

## Commitment

A durable statement describing an intended future state or obligation.

---

## Debtor

The agent responsible for satisfying the commitment.

---

## Creditor

The agent, user, organization, or system benefiting from or depending upon the commitment.

---

## Commitment Kind

Defines semantic meaning and additional validation.

V1:

```text
PROMISE
RESERVATION
```

Future examples:

```text
LEASE
OFFER
DELEGATION
AUTHORIZATION
ESCROW
SLA
BUDGET
LOCK
OPTION
```

---

## Terms

Kind-specific structured payload.

Example:

```json
{
  "resource": "gpu-17",
  "quantity": 1,
  "region": "us-east-1"
}
```

---

## Dependency

A directed relationship between commitments.

Example:

```text
manufacturing depends_on materials
delivery depends_on manufacturing
```

---

## Precedent

A historical conflict, negotiation, or settlement potentially relevant to a current situation.

---

## Transition

A legal movement between commitment states.

---

# 9. Core State Machine

V1 uses the following lifecycle:

```text
                     activate
          ┌────────────────────────┐
          │                        ▼
        DRAFT                   ACTIVE
                                  │
                     ┌────────────┼────────────┐
                     │            │            │
                     ▼            ▼            ▼
                FULFILLED       BROKEN       REVOKED
```

Terminal states:

```text
FULFILLED
BROKEN
REVOKED
```

V1 does not allow terminal states to be reversed.

A replacement commitment must instead be created.

This preserves historical integrity.

---

# 10. V1 Commitment Kinds

## 10.1 PROMISE

Represents an obligation by one actor to another.

Example:

```json
{
  "deliverable": "training-dataset",
  "deadline": "2026-08-14T17:00:00Z"
}
```

Example statement:

```text
Supplier Agent promises Dataset Agent
that training-dataset will be available
before 17:00 UTC.
```

---

## 10.2 RESERVATION

Represents exclusive or capacity-limited allocation of a resource.

Example:

```json
{
  "resource_id": "gpu-17",
  "quantity": 1,
  "start_at": "2026-08-14T14:00:00Z",
  "end_at": "2026-08-14T18:00:00Z"
}
```

The reservation implementation validates resource capacity transactionally.

---

# 11. Data Model

## 11.1 `agents`

```sql
CREATE TABLE agents (
    id UUID PRIMARY KEY,
    name STRING NOT NULL,
    framework STRING,
    owner_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}',
    status STRING NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 11.2 `commitments`

```sql
CREATE TABLE commitments (
    id UUID PRIMARY KEY,
    kind STRING NOT NULL,
    protocol_version INT NOT NULL DEFAULT 1,

    debtor_agent_id UUID NOT NULL,
    creditor_agent_id UUID,

    resource_key STRING,

    terms JSONB NOT NULL,

    status STRING NOT NULL DEFAULT 'draft',

    valid_from TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,

    version INT NOT NULL DEFAULT 1,

    idempotency_key STRING,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_status CHECK (
        status IN (
            'draft',
            'active',
            'fulfilled',
            'broken',
            'revoked'
        )
    )
);
```

---

## 11.3 `commitment_dependencies`

```sql
CREATE TABLE commitment_dependencies (
    commitment_id UUID NOT NULL,
    depends_on_id UUID NOT NULL,

    dependency_type STRING NOT NULL DEFAULT 'hard',

    metadata JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (
        commitment_id,
        depends_on_id
    )
);
```

V1 dependency types:

```text
hard
soft
informational
```

Only `hard` dependencies participate in automatic risk propagation.

---

## 11.4 `commitment_events`

```sql
CREATE TABLE commitment_events (
    id UUID PRIMARY KEY,

    commitment_id UUID NOT NULL,

    sequence INT NOT NULL,

    event_type STRING NOT NULL,

    from_status STRING,
    to_status STRING,

    actor_agent_id UUID,

    reason STRING,

    payload JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(commitment_id, sequence)
);
```

Example event types:

```text
commitment.created
commitment.activated
commitment.fulfilled
commitment.broken
commitment.revoked
commitment.endangered
commitment.recovered
dependency.created
reservation.conflict
```

---

## 11.5 `resources`

```sql
CREATE TABLE resources (
    id UUID PRIMARY KEY,

    resource_key STRING UNIQUE NOT NULL,

    resource_type STRING NOT NULL,

    capacity DECIMAL NOT NULL DEFAULT 1,

    metadata JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Examples:

```text
gpu-17
warehouse-dock-4
delivery-window-2026-08-15-09
budget-team-alpha
```

---

## 11.6 `operation_results`

Provides strict idempotency.

```sql
CREATE TABLE operation_results (
    idempotency_key STRING PRIMARY KEY,

    operation STRING NOT NULL,

    actor_agent_id UUID,

    commitment_id UUID,

    result JSONB NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 11.7 `precedents`

```sql
CREATE TABLE precedents (
    id UUID PRIMARY KEY,

    title STRING NOT NULL,

    situation STRING NOT NULL,

    resolution STRING,

    outcome STRING,

    metadata JSONB NOT NULL DEFAULT '{}',

    embedding VECTOR,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This table powers Distributed Vector Index retrieval.

---

# 12. Transition Kernel

The heart of Styx is one deterministic mutation path.

Conceptual API:

```ts
transitionCommitment({
    commitmentId,
    action,
    actorId,
    expectedVersion,
    idempotencyKey,
    reason,
    evidence
})
```

Every transition performs:

```text
BEGIN SERIALIZABLE

1. Check idempotency key.

2. Load authoritative commitment.

3. Verify expected version.

4. Verify actor may perform action.

5. Verify current state allows transition.

6. Execute commitment-kind validation.

7. Check resource invariants.

8. Update commitment.

9. Increment version.

10. Append immutable commitment event.

11. Store operation result.

COMMIT
```

If transaction contention occurs, Styx transparently retries according to CockroachDB transaction-retry semantics.

---

# 13. Reservation Correctness

For resource-backed reservations, the invariant is:

```text
SUM(active reservation quantity)
<=
resource.capacity
```

This condition must be validated within the same serializable transaction used to activate the reservation.

Example:

```text
GPU-17
capacity = 1
```

Alice and Bob simultaneously attempt:

```text
reserve(GPU-17)
```

Valid resulting states:

```text
Alice ACTIVE
Bob CONFLICT
```

or:

```text
Bob ACTIVE
Alice CONFLICT
```

Invalid:

```text
Alice ACTIVE
Bob ACTIVE
```

Styx does not guarantee which contender wins.

Styx guarantees that shared reality remains valid.

---

# 14. Idempotency

Every consequential mutation accepts:

```text
Idempotency-Key
```

Example:

```text
mission-842:reserve:gpu-17
```

If an agent submits:

```text
reserve GPU-17
```

and experiences a timeout, a retry with the same key returns the original result rather than performing the operation again.

This protects against:

* network retries;
* Lambda retries;
* agent retries;
* tool-call uncertainty;
* model repetition;
* crashed workers.

---

# 15. Promise Chains

Dependencies make commitments composable.

Example:

```text
P-101
Materials delivered Wednesday

      ↓

P-102
Manufacturing complete Thursday

      ↓

P-103
Customer delivery Friday
```

Stored as:

```text
P-102 depends_on P-101
P-103 depends_on P-102
```

A commitment graph may have arbitrary fan-in and fan-out.

Example:

```text
              P-A
             /   \
            ▼     ▼
          P-B     P-C
            \     /
             ▼   ▼
              P-D
```

---

# 16. Cascading Risk

When an active commitment becomes:

```text
BROKEN
```

Styx finds dependent commitments.

Hard dependencies become:

```text
AT RISK
```

`AT RISK` should initially be a **derived condition**, not a new commitment state.

This prevents unnecessary lifecycle complexity.

For example:

```text
status = ACTIVE
risk = ENDANGERED
```

The current lifecycle remains clean while the risk subsystem can evolve independently.

---

# 17. Event-Driven Agent Wakeups

Every meaningful commitment change produces a row in:

```text
commitment_events
```

CockroachDB Changefeeds propagate those events to the Styx event gateway.

Architecture:

```text
             CockroachDB
                   │
                   │ Changefeed
                   ▼
          Styx Event Gateway
                   │
          ┌────────┼─────────┐
          │        │         │
          ▼        ▼         ▼
       Lambda   Queue     Webhook
          │
          ▼
       Agent
```

Agents subscribe according to:

```text
agent_id
resource_key
commitment_id
dependency relationship
event_type
```

---

# 18. Event Payload

Canonical event envelope:

```json
{
  "event_id": "uuid",
  "event_type": "commitment.broken",
  "occurred_at": "2026-08-14T12:10:31Z",

  "commitment": {
    "id": "P-101",
    "kind": "PROMISE",
    "status": "broken"
  },

  "actor": {
    "agent_id": "supplier-agent"
  },

  "affected_commitments": [
    "P-102",
    "P-103"
  ],

  "reason": "supplier inventory unavailable"
}
```

---

# 19. Agent Runtime Interaction

Styx does not orchestrate internal agent reasoning.

The interaction loop is:

```text
Agent observes event
        │
        ▼
Agent inspects Styx
        │
        ▼
Agent reasons
        │
        ▼
Agent proposes action
        │
        ▼
Styx validates transactionally
        │
     ┌──┴──┐
     │     │
 accepted rejected
     │     │
     ▼     ▼
 new     agent replans
 state
```

This establishes a clean separation between:

```text
probabilistic reasoning
```

and:

```text
deterministic shared state
```

---

# 20. Precedent Retrieval

Styx supports agent learning without making semantic memory the core product.

Interface:

```ts
interface PrecedentStore {
    findSimilar(
        situation: ConflictContext,
        limit?: number
    ): Promise<Precedent[]>;
}
```

V1 implementation:

```text
CockroachDB Distributed Vector Index
```

Example:

```text
Current conflict:

GPU contention for 4-hour
training workload.
Deadline in 12 hours.
```

Retrieved precedent:

```text
Similarity: 0.92

Previous situation:
GPU unavailable during peak capacity.

Settlement:
Move workload to 02:00 UTC.

Outcome:
Deadline preserved.
Cost reduced 31%.
```

The agent may use that history to generate a renegotiation proposal.

Styx does **not** automatically execute precedent-based actions.

---

# 21. Precedent Generation

To avoid artificial demo data as the product architecture, Styx should create precedents from real completed negotiations.

After a conflict is resolved:

```text
conflict
   ↓
proposal
   ↓
settlement
   ↓
outcome
   ↓
precedent generated
   ↓
embedded
   ↓
available for future recall
```

The first interaction creates history.

Later interactions benefit from it.

This creates genuine accumulated institutional experience.

---

# 22. MCP Integration

Styx intentionally separates inspection from mutation.

## MCP role

CockroachDB MCP access should expose agent-readable state such as:

```text
commitments
dependencies
events
resources
precedents
```

Agents can inspect:

```text
What obligations belong to me?

Why does P-103 exist?

Which commitments depend on P-101?

Show reservations for GPU-17.

What changed since I last ran?
```

---

## Write path

Agents do **not** directly modify Styx tables through MCP.

Writes go through:

```text
Styx Transaction API
```

This ensures every mutation passes:

```text
authorization
state-machine validation
idempotency
resource invariants
event generation
transactional consistency
```

Principle:

> **Agents may reason freely about shared state, but contractual state may only change through invariant-enforcing APIs.**

---

# 23. Public API

Base:

```text
/v1
```

---

## Create commitment

```text
POST /v1/commitments
```

Request:

```json
{
  "kind": "PROMISE",
  "debtor_agent_id": "agent-a",
  "creditor_agent_id": "agent-b",
  "terms": {
    "deliverable": "dataset-v4"
  },
  "valid_until": "2026-08-14T17:00:00Z"
}
```

---

## Transition commitment

```text
POST /v1/commitments/{id}/transitions
```

Request:

```json
{
  "action": "activate",
  "expected_version": 1,
  "reason": "supplier accepted"
}
```

Header:

```text
Idempotency-Key: settlement-194:activate
```

---

## Reserve resource

```text
POST /v1/reservations
```

---

## Link dependency

```text
POST /v1/commitments/{id}/dependencies
```

---

## Get commitment

```text
GET /v1/commitments/{id}
```

---

## Get obligations

```text
GET /v1/agents/{id}/obligations
```

---

## Get dependency graph

```text
GET /v1/commitments/{id}/graph
```

---

## Retrieve precedents

```text
POST /v1/precedents/search
```

---

# 24. SDK

Initial SDK targets:

```text
TypeScript
Python
```

Developer experience:

```python
from styx import Styx

styx = Styx(...)

reservation = styx.reserve(
    debtor="alice",
    creditor="scheduler",
    resource="gpu-17",
    quantity=1,
    idempotency_key="job-82:gpu-17"
)
```

Promise:

```python
promise = styx.promise(
    debtor="supplier",
    creditor="manufacturer",
    terms={
        "deliverable": "materials",
        "deadline": "2026-08-14T17:00:00Z"
    }
)
```

Dependency:

```python
styx.depends_on(
    commitment=manufacturing,
    dependency=materials
)
```

Fulfillment:

```python
styx.fulfill(
    promise.id,
    reason="materials received"
)
```

---

# 25. Architecture

```text
                    ┌──────────────────────┐
                    │       Styx UI        │
                    │                      │
                    │ Commitments          │
                    │ Promise Graph        │
                    │ Event Timeline       │
                    │ Agent Activity       │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      Styx API        │
                    │                      │
                    │ Auth                 │
                    │ Idempotency          │
                    │ Transition Kernel    │
                    │ Kind Validation      │
                    │ Dependency Logic     │
                    └──────────┬───────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │          CockroachDB           │
              │                                │
              │ commitments                    │
              │ resources                      │
              │ dependencies                   │
              │ commitment_events              │
              │ precedents + VECTOR            │
              └───────────────┬────────────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
            Changefeed                    MCP
                 │                         │
                 ▼                         ▼
           Event Gateway            Agent Inspection
                 │
                 ▼
          AWS Lambda / Queue
                 │
                 ▼
          Bedrock Agent Workers
```

---

# 26. AWS Architecture

Initial AWS footprint:

```text
Amazon Bedrock
```

Used for:

* agent reasoning;
* negotiation;
* renegotiation;
* proposal generation;
* precedent interpretation.

```text
AWS Lambda
```

Used for:

* agent workers;
* event-triggered reasoning;
* Styx event consumers.

Optional:

```text
Amazon API Gateway
```

for the Styx API.

Optional:

```text
Amazon SQS
```

for reliable event delivery and retries.

Optional:

```text
Amazon CloudWatch
```

for:

* logs;
* traces;
* transition failures;
* agent execution metrics.

The core product must not require every AWS service above.

---

# 27. Agent Demonstration Environment

The reference application is a fictional compute-resource marketplace.

Actors:

```text
Alice Agent
Bob Agent
Supplier Agent
Scheduler Agent
```

Resource:

```text
GPU-17
capacity = 1
```

The marketplace is not Styx.

It is a test fixture for Styx.

This distinction must be explicit throughout documentation.

---

# 28. Reference Demo: Scene One — Conflict

State:

```text
GPU-17
Available: 1
```

Alice and Bob submit concurrent reservations.

UI:

```text
        GPU-17
       Capacity 1

 Alice ────────┐
               ├── RESERVE
 Bob ──────────┘
```

Outcome:

```text
Alice     COMMITTED ✓

Bob       CONFLICT  ✕
```

Event timeline:

```text
12:04:01.112 Alice reservation requested
12:04:01.114 Bob reservation requested
12:04:01.131 Alice commitment activated
12:04:01.137 Bob conflict detected
```

The system never displays capacity `-1`.

---

# 29. Reference Demo: Scene Two — Promise Cascade

Graph:

```text
P-101
Supplier provides materials
Wednesday
       │
       ▼
P-102
Factory completes assembly
Thursday
       │
       ▼
P-103
Customer receives delivery
Friday
```

Operator triggers:

```text
BREAK P-101
```

UI transitions:

```text
P-101   BROKEN     ✕

P-102   ACTIVE     ⚠ ENDANGERED

P-103   ACTIVE     ⚠ ENDANGERED
```

Affected agents wake automatically.

---

# 30. Reference Demo: Scene Three — Recovery

Factory Agent receives:

```text
dependency.broken
```

Agent queries:

```text
find similar failed supplier commitments
```

Styx returns historical precedent.

Agent proposes:

```text
Alternative supplier S-02.

Additional cost: $12.

Delivery impact: none.

Confidence: 0.89.
```

Agent creates:

```text
P-104
Supplier S-02 delivers materials
Wednesday
```

Dependencies become:

```text
P-104
   │
   ▼
P-102
   │
   ▼
P-103
```

Final graph:

```text
P-101 ✕       P-104 ✓
                 │
                 ▼
              P-102 ✓
                 │
                 ▼
              P-103 ✓
```

The system repaired its commitment structure without violating existing shared state.

---

# 31. Reference Demo: Scene Four — Agent Failure

Optional fourth scenario.

Alice obtains a valid reservation.

The Alice worker is terminated.

A fresh worker starts without local memory.

It asks Styx:

```text
What active obligations belong to Alice?
```

Styx returns the authoritative reservation.

The new worker continues without duplicating it.

Message:

> **Agents may die. Commitments survive.**

---

# 32. Styx UI

The UI should feel like an operations console rather than a chatbot.

Primary screens:

```text
Overview
Commitments
Promise Graph
Resources
Events
Agents
Precedents
```

---

# 33. Overview Screen

Metrics:

```text
Active Commitments
Endangered Commitments
Broken Commitments
Resource Conflicts
Successful Recoveries
Average Resolution Time
```

Activity stream:

```text
12:31:42 P-101 activated
12:31:44 P-102 dependency linked
12:33:09 R-044 conflict detected
12:33:10 Bob agent awakened
12:33:18 P-104 proposed
12:33:21 P-104 activated
```

---

# 34. Promise Graph

This is Styx's strongest visual interface.

Nodes represent commitments.

Edges represent dependencies.

Node styles represent:

```text
DRAFT
ACTIVE
FULFILLED
BROKEN
REVOKED
ENDANGERED
```

Selecting a node displays:

```text
commitment terms
debtor
creditor
dependencies
dependents
events
risk
precedents
```

Graph animations should emphasize state propagation.

---

# 35. Resource Screen

Example:

```text
GPU-17

Capacity       1
Reserved       1
Available      0

Current owner
Alice

Commitment
R-281

Expires
16:00 UTC
```

History:

```text
12:02 Alice requested
12:02 Alice committed
12:02 Bob conflicted
```

---

# 36. Event Timeline

Event history is immutable and filterable.

Filters:

```text
commitment
agent
resource
event type
time
```

This view doubles as the primary audit interface.

---

# 37. Security Model

Styx assumes agents are untrusted clients.

Agents may hallucinate.

Agents may retry.

Agents may attempt invalid actions.

Agents may be compromised.

Therefore correctness cannot depend on agent cooperation.

---

## 37.1 Authentication

Every actor receives:

```text
agent_id
credential
```

Potential implementation:

```text
JWT
API key
AWS IAM identity
```

---

## 37.2 Authorization

Initial role model:

```text
observer
actor
administrator
```

Observer:

```text
read commitments
read events
read precedents
```

Actor:

```text
create commitments
perform authorized transitions
```

Administrator:

```text
register resources
manage actors
configure policies
```

---

## 37.3 Database isolation

External agents never receive unrestricted database write credentials.

Styx API owns the mutation identity.

MCP access receives read-oriented credentials.

---

# 38. Auditability

Every mutation records:

```text
who
what
when
previous state
new state
reason
related evidence
idempotency key
```

This supports:

* debugging;
* security review;
* compliance;
* dispute analysis;
* agent evaluation.

---

# 39. Observability

Core product metrics:

```text
styx.commitment.created
styx.commitment.activated
styx.commitment.fulfilled
styx.commitment.broken
styx.commitment.revoked

styx.reservation.conflict

styx.transaction.retry

styx.agent.wakeup

styx.precedent.search

styx.recovery.completed
```

Operational metrics:

```text
transition latency
transaction retry rate
changefeed lag
agent reaction latency
conflict rate
settlement success rate
```

---

# 40. Reliability Requirements

## R1

No valid concurrent operations may violate configured resource invariants.

## R2

Every successful state mutation must produce exactly one logical event.

## R3

Client retries with identical idempotency keys must not repeat logical operations.

## R4

An agent crash must not cause loss of committed state.

## R5

Dependent commitments must be discoverable after upstream failure.

## R6

Historical transitions must remain queryable.

## R7

Event consumers must tolerate duplicate event delivery.

## R8

The system must recover correctly from transaction retries.

---

# 41. Functional Requirements

## FR-1 Commitment creation

Agents can create generic commitments.

## FR-2 Commitment activation

Draft commitments can become active after validation.

## FR-3 Fulfillment

Authorized agents can mark an active commitment fulfilled.

## FR-4 Revocation

Authorized actors can revoke eligible commitments.

## FR-5 Breakage

Styx can record that an obligation became impossible or violated.

## FR-6 Dependencies

Commitments can depend upon other commitments.

## FR-7 Risk propagation

Upstream failure identifies endangered downstream commitments.

## FR-8 Resource reservations

Agents can transactionally reserve capacity-limited resources.

## FR-9 Conflict response

Failed reservations return structured conflict information.

## FR-10 Idempotency

Mutations support caller-provided idempotency keys.

## FR-11 History

Every transition is durably recorded.

## FR-12 Event delivery

Relevant transitions generate consumable events.

## FR-13 Inspection

Agents can inspect current and historical commitment state.

## FR-14 Precedent retrieval

Agents can semantically retrieve similar historical negotiations.

---

# 42. Non-Functional Requirements

## Performance

Target initial API latency:

```text
p95 < 500 ms
```

excluding LLM reasoning.

---

## Availability

The protocol layer should have no dependency on an individual agent process.

---

## Scalability

Logical model should support:

```text
millions of commitments
large numbers of actors
high event volume
multi-region clients
```

without changing API semantics.

---

## Portability

Agents should interact through HTTP/SDK contracts rather than framework-specific internals.

---

# 43. Conflict Object

Failures should return machine-actionable information.

Example:

```json
{
  "type": "RESOURCE_CONFLICT",
  "resource": "gpu-17",

  "requested": {
    "quantity": 1
  },

  "available": 0,

  "conflicting_commitments": [
    "R-281"
  ],

  "retryable": false,

  "alternatives": {
    "search_precedents": true
  }
}
```

This gives the agent context for replanning.

---

# 44. Extensible Commitment Kinds

V1 contains:

```text
PROMISE
RESERVATION
```

Future kinds can implement a generic contract:

```ts
interface CommitmentKind {
    name: string

    validateTerms(terms): ValidationResult

    validateCreation(context): ValidationResult

    validateActivation(context): ValidationResult

    validateTransition(context): ValidationResult
}
```

The transition kernel remains unchanged.

---

# 45. Future Kind: LEASE

A reservation with duration and renewal semantics.

Example:

```text
Agent leases GPU-17
from 14:00 to 18:00.
```

---

# 46. Future Kind: DELEGATION

Represents transfer of authority.

```text
Finance Agent
delegates
$500 purchasing authority
to Procurement Agent
until Friday.
```

This makes Styx capable of answering:

> “Who gave this agent permission to do this?”

---

# 47. Future Kind: AUTHORIZATION

Represents explicit capability grants.

Example:

```text
Ops Agent may restart service X
for the next 60 minutes.
```

---

# 48. Future Kind: OFFER

Represents a proposed commitment that has not yet been accepted.

This enables negotiation protocols.

---

# 49. Future Kind: ESCROW

Represents contingent transfer after dependent commitments are fulfilled.

---

# 50. Future Kind: SLA

Represents measurable service obligations and failure consequences.

---

# 51. Conditional Commitments

Not part of V1.

Future form:

```text
IF predicate
THEN activate commitment A
ELSE activate commitment B
```

This should eventually be implemented as deterministic transition guards rather than LLM-evaluated conditions.

---

# 52. Multi-Party Commitments

Not part of V1.

Future architecture may support commitments involving N parties via a membership table.

V1 intentionally preserves:

```text
debtor
creditor
```

for simplicity.

---

# 53. Reputation

Not V1.

Future Styx versions may derive reputation from actual historical behavior:

```text
promises fulfilled
promises broken
average lateness
renegotiation behavior
counterparty disputes
```

Reputation should be derived from immutable event history rather than user-entered scores.

---

# 54. Commitment Policies

Future organizations may configure rules such as:

```text
No agent may commit more than $500
without finance authorization.

No reservation may exceed six hours.

Production deployments require
two independent commitments.
```

Policies should execute deterministically before transitions commit.

---

# 55. Styx Protocol Layer

Long term, Styx should separate:

```text
Styx Protocol
```

from:

```text
Styx Cloud
```

The protocol defines:

* object model;
* transitions;
* API semantics;
* event semantics;
* dependency semantics;
* idempotency;
* conflict representation.

Styx Cloud provides hosted implementation.

---

# 56. Framework Adapter Strategy

Potential adapters:

```text
Hermes Agent
LangGraph
Amazon Bedrock Agents
OpenAI Agents SDK
CrewAI
AutoGen
custom MCP clients
```

Adapters should remain thin.

Example:

```python
tools = styx.as_tools()
```

becomes:

```text
styx_create_commitment
styx_reserve_resource
styx_fulfill
styx_revoke
styx_find_precedents
styx_get_obligations
```

---

# 57. What Styx Is Not

Styx is **not**:

* an LLM;
* a chatbot;
* an agent framework;
* a vector database;
* a generic workflow engine;
* a blockchain;
* a message broker;
* a task manager;
* a scheduler;
* a marketplace.

It is infrastructure those systems can use.

---

# 58. Competitive Differentiation

Traditional agent memory:

```text
Stores observations.
```

Styx:

```text
Stores obligations.
```

Traditional vector memory:

```text
Similarity decides relevance.
```

Styx:

```text
Transactions decide truth.
```

Traditional multi-agent messaging:

```text
Agents tell one another things.
```

Styx:

```text
Agents establish shared commitments.
```

Workflow engines:

```text
Developer predefines workflow.
```

Styx:

```text
Agents dynamically create commitments
and dependencies at runtime.
```

Databases:

```text
Provide primitives.
```

Styx:

```text
Provides commitment semantics.
```

---

# 59. Why CockroachDB

Styx should use CockroachDB because the product is fundamentally shared distributed state.

The relevant capabilities are:

```text
Serializable transactions
```

for commitment correctness.

```text
Distributed availability
```

for geographically distributed actors.

```text
Changefeeds
```

for event-driven agent reactions.

```text
Vector indexing
```

for historical precedent retrieval.

```text
Relational + JSON state
```

for commitment structure and extensibility.

```text
MCP
```

for agent-readable inspection.

The database isn't merely where Styx happens to save objects.

Its concurrency model is part of Styx's semantics.

---

# 60. Initial Hackathon Scope

The initial implementation intentionally contains only:

### Kernel

```text
commitments
dependencies
events
resources
idempotency
transactional transitions
```

### Kinds

```text
PROMISE
RESERVATION
```

### Intelligence

```text
precedent retrieval
one renegotiation loop
```

### Infrastructure

```text
CockroachDB
Distributed Vector Index
CockroachDB MCP
Changefeed
Amazon Bedrock
AWS Lambda
```

### Demo

```text
concurrent reservation conflict
promise-chain breakage
agent wakeup
renegotiation
graph repair
```

Everything else belongs to the product roadmap.

---

# 61. Explicitly Out of Scope for V1

Do not build:

* general policy DSL;
* arbitrary IF/THEN engine;
* multi-party negotiation framework;
* reputation scoring;
* escrow;
* monetary settlement;
* billing;
* complex delegation;
* agent plugin marketplace;
* generic orchestration;
* blockchain integration;
* production multi-tenancy;
* perfect graph visualization;
* generic workflow designer.

---

# 62. Success Metrics

## Product-level

```text
Conflict prevention rate
Commitment fulfillment rate
Recovery rate after dependency failure
Mean renegotiation time
Duplicate-operation prevention rate
```

---

## Developer-level

```text
Time to first commitment
API calls needed for common flows
SDK integration time
Number of custom commitment kinds created
```

---

## Agent-level

```text
Invalid transitions prevented
Conflicts autonomously resolved
Commitments recovered after worker crash
Precedents reused successfully
```

---

# 63. Core Acceptance Tests

## Concurrent reservation

100 concurrent agents attempt to reserve one capacity-1 resource.

Expected:

```text
exactly 1 ACTIVE
99 rejected/conflicted
capacity invariant preserved
```

---

## Duplicate retry

Send the same operation 20 times using one idempotency key.

Expected:

```text
one logical mutation
one result
```

---

## Invalid state transition

Attempt:

```text
FULFILLED → ACTIVE
```

Expected:

```text
rejected
```

---

## Dependency cascade

Break an upstream commitment.

Expected:

```text
all downstream hard dependents
become discoverably endangered
```

---

## Agent crash

Terminate agent after successful commitment creation but before local acknowledgement.

Restart.

Expected:

```text
agent discovers existing commitment
without creating a duplicate
```

---

## Concurrent state update

Two actors simultaneously attempt incompatible transitions.

Expected:

```text
one authoritative result
```

---

# 64. Threat Model

Potential threats:

```text
malicious agent
compromised credential
replayed request
duplicate tool call
forged actor ID
unauthorized transition
event replay
prompt injection through terms
malicious precedent content
```

Mitigations include:

```text
authentication
authorization
idempotency
structured terms
input validation
read/write privilege separation
event IDs
immutable audit history
```

LLM-generated content must always be treated as untrusted input.

---

# 65. Failure Model

Styx explicitly assumes:

```text
agents crash
networks fail
requests time out
events duplicate
events arrive late
agents disagree
LLMs hallucinate
workers restart
transactions contend
```

The system should remain correct despite these conditions.

That is part of the product philosophy:

> **Styx is built for unreliable actors operating on reliable shared state.**

---

# 66. Developer Experience

A new developer should be able to understand Styx through three concepts:

```text
Make a commitment.

Depend on a commitment.

React when a commitment changes.
```

Everything else is implementation detail.

Minimal example:

```python
materials = styx.promise(...)

manufacturing = styx.promise(...)

styx.depends_on(
    manufacturing,
    materials
)
```

The conceptual surface area should remain small even as the protocol expands.

---

# 67. Documentation Structure

Repository documentation should contain:

```text
README.md
docs/
  concepts.md
  architecture.md
  commitments.md
  transactions.md
  events.md
  dependencies.md
  precedents.md
  security.md
  examples/
      gpu-marketplace.md
```

README opening:

> **Styx is a transactional commitment layer for autonomous agents. Agents use it to make promises, reserve resources, coordinate dependencies, and recover when commitments fail.**

---

# 68. Product Story

The strongest narrative sequence is:

### Agents can think.

Models solved much of this.

### Agents can act.

Tools solved much of this.

### Agents can remember.

Memory systems are solving much of this.

### But autonomous agents increasingly depend on each other.

That introduces a new problem:

> **Can they make promises safely?**

Styx is infrastructure for that next phase.

---

# 69. Core Messaging

Primary:

> **Styx is a consistency layer for promises between autonomous agents.**

Secondary:

> **Agents that remember what they promised.**

Conceptual:

> **Memory of the future.**

Technical:

> **Transactional commitment infrastructure for multi-agent systems.**

Developer-focused:

> **Shared state agents can depend on.**

---

# 70. Demo Opening

Suggested opening:

> AI agents already have memory. But remembering that someone said “I reserved this GPU” is not the same thing as guaranteeing that only one agent actually reserved it.
>
> As autonomous agents begin coordinating with one another, messages stop being enough.
>
> They need commitments.
>
> **This is Styx.**

Then immediately run the concurrent reservation.

---

# 71. Demo Closing

Suggested closing:

> Most agent memory records what happened.
>
> Styx records what is supposed to happen—and keeps autonomous agents consistent when reality changes.
>
> Agents may fail. Plans may change. Commitments remain authoritative.
>
> **Styx: a consistency layer for promises between autonomous agents.**

---

# 72. Long-Term Roadmap

## Phase 1 — Commitment Kernel

```text
Promise
Reservation
Dependencies
Events
Idempotency
Precedent retrieval
```

---

## Phase 2 — Authority

```text
Delegation
Authorization
Budgets
Permission chains
Revocation
```

---

## Phase 3 — Negotiation

```text
Offers
Counteroffers
Negotiation sessions
Multi-party settlements
```

---

## Phase 4 — Contracts

```text
Conditional commitments
Escrow
SLAs
Penalties
Policy guards
```

---

## Phase 5 — Agent Economy

```text
Reputation
Discovery
Agent marketplaces
Machine-to-machine contracting
Cross-organization coordination
```

---

# 73. North-Star Vision

In a mature autonomous ecosystem, thousands or millions of agents may:

* book infrastructure;
* purchase resources;
* delegate work;
* negotiate schedules;
* coordinate supply chains;
* operate businesses;
* execute deployments;
* schedule logistics;
* control budgets;
* provide services to one another.

Those systems cannot rely entirely on conversational context to decide what is true.

They will require durable shared primitives for:

```text
ownership
obligation
authority
dependency
reservation
settlement
```

Styx begins with the smallest useful abstraction:

# **The Commitment**

Everything else can grow from there.

---

# 74. Final Product Definition

**Styx is an extensible transactional commitment protocol for autonomous agents.**

It provides a durable shared system where agents can:

* make promises;
* reserve scarce resources;
* establish dependencies;
* inspect obligations;
* maintain immutable commitment history;
* detect concurrent conflicts;
* survive retries and process failures;
* react to changing commitments;
* learn from previous settlements;
* renegotiate when plans fail.

Its central guarantee is not that agents will always make good decisions.

Its guarantee is:

> **Whatever decisions agents make, they operate against one coherent, auditable, transactionally consistent shared reality.**

That is the foundation Styx is designed to provide.
