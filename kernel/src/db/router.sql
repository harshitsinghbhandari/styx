-- Router dedupe table (v1-spec section 10). Changefeed delivery is
-- at-least-once; INSERT ... ON CONFLICT DO NOTHING here is what makes the
-- router's handling of it idempotent. Lives in the same database as the
-- commitments it watches, same reasoning as the precedents table.

CREATE TABLE IF NOT EXISTS processed_events (
    event_id     UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
