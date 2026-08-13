-- Styx commitment kernel schema. Authoritative per v1-spec.md section 6,
-- amended by v3-plan.md: operation_results replaces the idempotency_key
-- column on commitments (amendment 1).

CREATE TABLE IF NOT EXISTS agents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         STRING NOT NULL UNIQUE,
    kind         STRING NOT NULL,
    api_key_hash STRING NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
    key          STRING PRIMARY KEY,
    owner_agent  UUID NOT NULL REFERENCES agents(id),
    capacity     INT NOT NULL CHECK (capacity >= 0),
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commitments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              STRING NOT NULL,
    protocol_version  STRING NOT NULL DEFAULT '1',
    debtor_agent_id   UUID NOT NULL REFERENCES agents(id),
    creditor_agent_id UUID NOT NULL REFERENCES agents(id),
    resource_key      STRING REFERENCES resources(key),
    terms             JSONB NOT NULL,
    status            STRING NOT NULL DEFAULT 'draft',
    valid_until       TIMESTAMPTZ,
    version           INT NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    INDEX idx_commitments_debtor  (debtor_agent_id, status),
    INDEX idx_commitments_resource (resource_key, status),
    INDEX idx_commitments_expiry  (valid_until) WHERE status = 'active'
);

CREATE TABLE IF NOT EXISTS commitment_dependencies (
    commitment_id    UUID NOT NULL REFERENCES commitments(id),
    depends_on_id    UUID NOT NULL REFERENCES commitments(id),
    dependency_type  STRING NOT NULL DEFAULT 'requires',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (commitment_id, depends_on_id),
    CONSTRAINT no_self_dependency CHECK (commitment_id != depends_on_id)
);

CREATE TABLE IF NOT EXISTS commitment_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commitment_id  UUID NOT NULL REFERENCES commitments(id),
    sequence       INT NOT NULL,
    event_type     STRING NOT NULL,
    from_status    STRING,
    to_status      STRING,
    actor_agent_id UUID REFERENCES agents(id),
    reason         STRING,
    payload        JSONB NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (commitment_id, sequence)
);

-- Amendment 1: dedicated idempotency table. Step 1 of every kernel
-- operation (creation and transition) checks this by key before doing
-- any other work; on success the result row is inserted in the same
-- transaction as the operation it fronts.
CREATE TABLE IF NOT EXISTS operation_results (
    idempotency_key STRING PRIMARY KEY,
    operation       STRING NOT NULL,
    actor_agent_id  UUID,
    commitment_id   UUID,
    result          JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
