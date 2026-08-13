-- Optional: vector memory of settlements (v1-spec section 6.6). Split out
-- of schema.sql because local single-node CockroachDB builds used for Day 1
-- testing may not carry VECTOR support; the kernel and its tests do not
-- depend on this table.

CREATE TABLE IF NOT EXISTS precedents (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    situation      STRING NOT NULL,
    resolution     STRING NOT NULL,
    outcome        JSONB NOT NULL,
    source_event   UUID REFERENCES commitment_events(id),
    embedding      VECTOR(1024) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    VECTOR INDEX idx_precedents_embedding (embedding)
);
