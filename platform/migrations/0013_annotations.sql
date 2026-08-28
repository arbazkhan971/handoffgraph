-- Human annotation queues (migration 0013, parity row 28).
--
-- A queue is a saved filter over the observability read model plus a score
-- definition: `target_filter` names which span_observations rows belong in
-- it (by workstream / kind / status), `score_name` + `data_type` (+
-- `categories` for CATEGORY) name what a human annotator records about each
-- one. Creating a queue snapshots the matching targets into
-- `annotation_items` (bounded, deterministic order — see src/annotations.ts);
-- `refill` re-runs the same filter later to pick up newly-captured targets.
--
-- Design provenance (ideas only; no code or config from any AGPL/ELv2
-- project): claim-then-work-then-submit is the shape every human-review queue
-- converges on (it is what makes concurrent annotators never collide on the
-- same item). What is ours is that a claim is ONE conditional D1 UPDATE
-- (`WHERE id = (SELECT ... WHERE status = 'pending' ORDER BY created_at, id
-- LIMIT 1)`), so "atomically hand out the oldest pending item" needs no
-- transaction, no SELECT-then-UPDATE race, and no external lock — SQLite (and
-- D1, built on it) executes the whole statement, subquery included, as one
-- indivisible step.
--
-- Items are span-shaped today: target_filter's `kind`/`status` keys are
-- span_observations columns, and span_observations is the only live,
-- continuously-populated read model with kind/status/workstream columns to
-- scan (the migration-0001 `traces`/`spans` tables are vestigial — nothing
-- ingests into them since migration 0005 introduced span_observations; only
-- artifacts.ts's retention sweep still touches them, to delete). Every
-- populated item is therefore target_type = 'span'. target_type's CHECK stays
-- wider (trace/span/session, matching src/apikeys.ts's SCORE_TARGET_TYPES
-- subset used elsewhere on this spine) so a future target source does not need
-- a schema change to land.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform
-- convention.

-- ---------------------------------------------------------------------------
-- annotation_queues
-- ---------------------------------------------------------------------------
CREATE TABLE annotation_queues (
    id            TEXT PRIMARY KEY
                  CHECK(length(id) = 30 AND substr(id, 1, 4) = 'anq_' AND
                        substr(id, 5, 1) GLOB '[0-7]' AND
                        substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id  TEXT NOT NULL
                  CHECK(length(workspace_id) = 30 AND
                        substr(workspace_id, 1, 4) = 'wsp_' AND
                        substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                        substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),

    -- {"workstream": "ws_...", "kind": "llm.call", "status": "error"} — every
    -- key optional; shape checked here, key vocabulary and value validity
    -- checked in application code (same division of labor migration 0007
    -- uses for webhook_endpoints.event_kinds and migration 0011 for
    -- api_keys.scopes).
    target_filter TEXT NOT NULL
                  CHECK(json_valid(target_filter) AND json_type(target_filter) = 'object'),

    score_name    TEXT NOT NULL CHECK(length(score_name) BETWEEN 1 AND 128),
    data_type     TEXT NOT NULL CHECK(data_type IN ('NUMERIC', 'CATEGORY', 'BOOLEAN')),

    -- Required exactly when data_type = 'CATEGORY' (see the table CHECK
    -- below). A JSON array of the allowed category strings; uniqueness and
    -- per-element shape are application-checked at creation time.
    categories    TEXT
                  CHECK(categories IS NULL OR
                        (json_valid(categories) AND json_type(categories) = 'array')),

    active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at    INTEGER NOT NULL CHECK(created_at >= 0),

    CHECK((data_type = 'CATEGORY') = (categories IS NOT NULL))
);
CREATE INDEX idx_annotation_queues_workspace ON annotation_queues(workspace_id);
-- The listing order (newest first) and the workspace-scoped id lookup.
CREATE INDEX idx_annotation_queues_workspace_created
    ON annotation_queues(workspace_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- annotation_items
-- ---------------------------------------------------------------------------
-- One row per (queue, target). The UNIQUE index is what makes both initial
-- population and `refill` idempotent: re-scanning the same filter and
-- INSERT OR IGNORE-ing the candidates can never duplicate an item that is
-- already mid-review (or already done) for this queue.
CREATE TABLE annotation_items (
    id                TEXT PRIMARY KEY
                      CHECK(length(id) = 30 AND substr(id, 1, 4) = 'ani_' AND
                            substr(id, 5, 1) GLOB '[0-7]' AND
                            substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    queue_id          TEXT NOT NULL REFERENCES annotation_queues(id) ON DELETE CASCADE,
    workspace_id      TEXT NOT NULL
                      CHECK(length(workspace_id) = 30 AND
                            substr(workspace_id, 1, 4) = 'wsp_' AND
                            substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                            substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),

    target_type       TEXT NOT NULL CHECK(target_type IN ('trace', 'span', 'session')),
    target_id         TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),

    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'claimed', 'done', 'skipped')),
    claimed_by_device TEXT,
    claimed_at        INTEGER CHECK(claimed_at IS NULL OR claimed_at >= created_at),
    completed_at      INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0),

    -- A claim names its device and its time, or names neither.
    CHECK((claimed_by_device IS NULL) = (claimed_at IS NULL)),
    -- 'claimed' always names the device that holds it.
    CHECK(status <> 'claimed' OR claimed_by_device IS NOT NULL),
    -- completed_at is set exactly on the two terminal statuses.
    CHECK(
      (status IN ('done', 'skipped') AND completed_at IS NOT NULL) OR
      (status NOT IN ('done', 'skipped') AND completed_at IS NULL)
    ),

    UNIQUE (queue_id, target_type, target_id)
);
CREATE INDEX idx_annotation_items_workspace ON annotation_items(workspace_id);
-- The claim scan ("oldest pending item in this queue") and the per-queue
-- status counts (list envelope, live endpoint's D1 fallback) both use this.
CREATE INDEX idx_annotation_items_queue_status
    ON annotation_items(queue_id, status, created_at, id);

-- ---------------------------------------------------------------------------
-- Item lifecycle invariants, enforced in-schema.
-- ---------------------------------------------------------------------------
-- The state machine is pending -> claimed -> {done, skipped}, with a direct
-- pending -> {done, skipped} shortcut for callers (API/MCP scripts) that
-- score without an interactive claim step. 'done' and 'skipped' are the only
-- terminal states.

-- Items must start pending; only application code may advance status.
CREATE TRIGGER annotation_items_require_pending
BEFORE INSERT ON annotation_items
WHEN NEW.status <> 'pending'
BEGIN
    SELECT RAISE(ABORT, 'annotation item must start pending');
END;

-- 'done' and 'skipped' are terminal: nothing may move a finished item back
-- into circulation. This is what makes the resubmit-after-done case a clean
-- 409 in application code (the finalizing UPDATE's WHERE status IN
-- ('pending','claimed') already excludes it; this trigger is the schema-level
-- backstop for any future write path that forgets that clause).
CREATE TRIGGER annotation_items_terminal_status
BEFORE UPDATE OF status ON annotation_items
WHEN OLD.status IN ('done', 'skipped') AND NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'annotation item status is terminal');
END;

-- Only a pending item may be claimed — this is the schema-level half of the
-- atomic claim UPDATE (src/annotations.ts): the statement's own subquery
-- already restricts candidates to status = 'pending', so this trigger never
-- fires in normal operation, but it means the invariant holds even if a
-- future write path tries to claim an already-claimed (or finished) item
-- directly.
CREATE TRIGGER annotation_items_claim_requires_pending
BEFORE UPDATE OF status ON annotation_items
WHEN NEW.status = 'claimed' AND OLD.status <> 'pending'
BEGIN
    SELECT RAISE(ABORT, 'annotation item claim requires pending status');
END;
