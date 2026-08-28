-- Outbound webhooks (migration 0007, parity row 47).
--
-- Platform events (handoffs, detections, prompt label changes, alerts later)
-- are delivered to workspace-owned HTTPS endpoints via a Cloudflare Queues
-- consumer. Detection of new events happens on a cursor sweep of the
-- append-only `events` table (seq > webhook_cursors.last_seq), not an ingest
-- hook, so ingestion latency is never coupled to delivery latency.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform
-- convention. Only a content-free event summary is ever queued or sent to a
-- customer endpoint (event_id, kind, workstream_id, occurred_at,
-- workspace_id) — raw event bodies never leave the platform.
--
-- Endpoint secrets are shown once at creation. `secret_hash` (sha256) lets
-- the platform recognize/rotate a secret without ever reading it back;
-- `secret_ciphertext` is the same secret AES-GCM sealed under the worker's
-- WEBHOOK_SEALING_KEY so the queue consumer can unseal it later to sign
-- outgoing deliveries. It is nullable: creation fails closed (503) whenever
-- the sealing key is unset, and a future key-rotation/GC pass may clear a
-- stale ciphertext without losing the row's audit history.

CREATE TABLE webhook_endpoints (
    id                TEXT PRIMARY KEY
                      CHECK(length(id) = 30 AND substr(id, 1, 4) = 'whe_' AND
                            substr(id, 5, 1) GLOB '[0-7]' AND
                            substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id      TEXT NOT NULL,
    url               TEXT NOT NULL CHECK(url LIKE 'https://%'),
    secret_hash       TEXT NOT NULL
                      CHECK(length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
    secret_ciphertext TEXT,
    active            INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    event_kinds       TEXT NOT NULL
                      CHECK(json_valid(event_kinds) AND json_type(event_kinds) = 'array'),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX idx_webhook_endpoints_workspace ON webhook_endpoints(workspace_id);
CREATE INDEX idx_webhook_endpoints_workspace_active
    ON webhook_endpoints(workspace_id, active);

CREATE TABLE webhook_deliveries (
    id              TEXT PRIMARY KEY
                    CHECK(length(id) = 30 AND substr(id, 1, 4) = 'whd_' AND
                          substr(id, 5, 1) GLOB '[0-7]' AND
                          substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id    TEXT NOT NULL,
    endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued', 'delivered', 'failed', 'dead')),
    response_status INTEGER
                    CHECK(response_status IS NULL OR response_status BETWEEN 100 AND 599),
    created_at      INTEGER NOT NULL CHECK(created_at >= 0),
    delivered_at    INTEGER,
    CHECK(delivered_at IS NULL OR delivered_at >= created_at),
    CHECK(
      (status = 'delivered' AND delivered_at IS NOT NULL) OR
      (status <> 'delivered' AND delivered_at IS NULL)
    )
);
CREATE INDEX idx_webhook_deliveries_workspace ON webhook_deliveries(workspace_id);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);
-- Sweep idempotency: INSERT OR IGNORE on this key means re-running a sweep
-- window (e.g. after a partial failure between the D1 batch and the Queues
-- sends) can never fan out two delivery rows for the same event+endpoint.
CREATE UNIQUE INDEX idx_webhook_deliveries_endpoint_event
    ON webhook_deliveries(endpoint_id, event_id);

-- One row per workspace: the sweep advances a single watermark over `events`
-- shared by every endpoint in that workspace, regardless of which endpoints
-- ultimately match which event kinds.
CREATE TABLE webhook_cursors (
    workspace_id TEXT PRIMARY KEY,
    last_seq     INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0)
);

-- Deliveries must start queued; only the consumer (via application code) may
-- move a row to a terminal or retryable state.
CREATE TRIGGER webhook_deliveries_require_queued
BEFORE INSERT ON webhook_deliveries
WHEN NEW.status <> 'queued'
BEGIN
    SELECT RAISE(ABORT, 'webhook delivery must start queued');
END;

-- 'delivered' and 'dead' are terminal. This is a schema-level backstop
-- against a future bug that tries to resurrect or re-queue a finished row —
-- the queue consumer never needs to violate it in normal operation.
CREATE TRIGGER webhook_deliveries_terminal_status
BEFORE UPDATE OF status ON webhook_deliveries
WHEN OLD.status IN ('delivered', 'dead') AND NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'webhook delivery status is terminal');
END;

-- The sweep only ever advances past events it has already turned into
-- delivery rows (or explicitly skipped). Rejecting a regression in-schema
-- means any future write path that forgets this invariant fails loudly
-- instead of silently re-delivering old events.
CREATE TRIGGER webhook_cursors_monotonic
BEFORE UPDATE OF last_seq ON webhook_cursors
WHEN NEW.last_seq < OLD.last_seq
BEGIN
    SELECT RAISE(ABORT, 'webhook cursor must not move backward');
END;
