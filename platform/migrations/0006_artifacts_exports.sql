-- Object-store artifact tiering, batch export, and derived-model retention
-- (migration 0006).
--
-- Three separable concerns share one migration because they share one rule:
--
--   1. artifact_file_list — the D1 index over compacted JSONL objects written
--      to R2 under artifacts/<workspace_id>/. The objects are a DERIVED cold
--      copy of the spine; writing one never removes or rewrites an event.
--   2. exports          — user-requested NDJSON extracts under
--      exports/<workspace_id>/. Terminal rows are immutable manifests.
--   3. retention_policies — a per-workspace TTL that applies ONLY to derived,
--      rebuildable read models. The event spine is never TTL'd, and neither is
--      the artifact index.
--
-- The rule is enforced in-schema, not merely in application code: the triggers
-- at the bottom of this migration make an UPDATE or DELETE against `events`
-- abort, so no future sweep — retention, compaction, or otherwise — can slim
-- the spine by accident.

-- ---------------------------------------------------------------------------
-- 1. Artifact file list (object-store tiering index)
-- ---------------------------------------------------------------------------

-- One row per compacted object. (workspace_id, min_seq, max_seq) is unique, so
-- re-running compaction over an already-compacted seq range is a no-op rather
-- than a duplicate object. min/max_occurred_at are LEXICOGRAPHIC bounds over
-- the raw occurred_at strings contained in the object: occurred_at is stored
-- exactly as observed and may carry any UTC offset, so these are index hints
-- for locating an object, never a normalized temporal range.
CREATE TABLE artifact_file_list (
    workspace_id    TEXT NOT NULL
                    CHECK(length(workspace_id) = 30 AND
                          substr(workspace_id, 1, 4) = 'wsp_' AND
                          substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                          substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    -- Tenancy is part of the object key, and the key is checked against the
    -- owning workspace: a row can never point at another tenant's prefix.
    object_key      TEXT NOT NULL
                    CHECK(object_key GLOB 'artifacts/' || workspace_id || '/*.jsonl'),
    event_count     INTEGER NOT NULL CHECK(event_count > 0),
    byte_size       INTEGER NOT NULL CHECK(byte_size > 0),
    min_seq         INTEGER NOT NULL CHECK(min_seq > 0),
    max_seq         INTEGER NOT NULL CHECK(max_seq >= min_seq),
    min_occurred_at TEXT NOT NULL CHECK(length(min_occurred_at) > 0),
    max_occurred_at TEXT NOT NULL CHECK(max_occurred_at >= min_occurred_at),
    content_sha256  TEXT NOT NULL
                    CHECK(length(content_sha256) = 64 AND
                          content_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at      INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (workspace_id, object_key)
);
CREATE INDEX idx_artifact_file_list_workspace ON artifact_file_list(workspace_id);
-- Compaction idempotency: one object per (workspace, seq range).
CREATE UNIQUE INDEX idx_artifact_file_list_range
    ON artifact_file_list(workspace_id, min_seq, max_seq);

-- Artifacts are immutable. The compactor writes content-addressed bytes and an
-- index row once; nothing rewrites either.
CREATE TRIGGER artifact_file_list_reject_update
BEFORE UPDATE ON artifact_file_list
BEGIN
    SELECT RAISE(ABORT, 'artifact objects are immutable');
END;

-- Retention never reclaims cold storage. Purging a workspace's artifacts is an
-- explicit operator action that must drop this guard first (see
-- docs/hosted-retention.md).
CREATE TRIGGER artifact_file_list_reject_delete
BEFORE DELETE ON artifact_file_list
BEGIN
    SELECT RAISE(ABORT, 'artifact objects are never deleted by retention');
END;

-- ---------------------------------------------------------------------------
-- 2. Batch exports
-- ---------------------------------------------------------------------------

-- 'queued' is reserved for the durable (Workflows-backed) execution path; the
-- synchronous in-request executor inserts 'running' and settles it in one
-- update. A row that reads 'done' always carries a complete manifest.
CREATE TABLE exports (
    id            TEXT NOT NULL PRIMARY KEY
                  CHECK(length(id) = 30 AND substr(id, 1, 4) = 'exp_' AND
                        substr(id, 5, 1) GLOB '[0-7]' AND
                        substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id  TEXT NOT NULL
                  CHECK(length(workspace_id) = 30 AND
                        substr(workspace_id, 1, 4) = 'wsp_' AND
                        substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                        substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    status        TEXT NOT NULL
                  CHECK(status IN ('queued', 'running', 'done', 'error')),
    params_json   TEXT NOT NULL CHECK(json_valid(params_json)),
    object_key    TEXT
                  CHECK(object_key IS NULL OR
                        object_key GLOB 'exports/' || workspace_id || '/*.ndjson'),
    byte_size     INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
    event_count   INTEGER CHECK(event_count IS NULL OR event_count >= 0),
    sha256        TEXT CHECK(sha256 IS NULL OR
                             (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
    created_at    INTEGER NOT NULL CHECK(created_at >= 0),
    completed_at  INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
    CHECK(status <> 'done' OR (object_key IS NOT NULL AND byte_size IS NOT NULL AND
                               event_count IS NOT NULL AND sha256 IS NOT NULL AND
                               completed_at IS NOT NULL)),
    CHECK(status NOT IN ('queued', 'running') OR completed_at IS NULL)
);
CREATE INDEX idx_exports_workspace ON exports(workspace_id);
CREATE INDEX idx_exports_workspace_created ON exports(workspace_id, created_at, id);

CREATE TRIGGER exports_terminal_status_is_final
BEFORE UPDATE ON exports
WHEN OLD.status IN ('done', 'error')
BEGIN
    SELECT RAISE(ABORT, 'export status is terminal');
END;

CREATE TRIGGER exports_identity_is_immutable
BEFORE UPDATE ON exports
WHEN NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'export identity is immutable');
END;

-- ---------------------------------------------------------------------------
-- 3. Retention policy (derived models only)
-- ---------------------------------------------------------------------------

-- workspace_id is the primary key, so SQLite's implicit unique index is the
-- required per-workspace index; a second index would only duplicate it.
-- NULL derived_ttl_days means "keep derived models indefinitely". The floor of
-- 7 days is enforced here as well as at the API edge so a bad write cannot
-- shorten a tenant's window below the support/debug horizon.
CREATE TABLE retention_policies (
    workspace_id     TEXT NOT NULL PRIMARY KEY
                     CHECK(length(workspace_id) = 30 AND
                           substr(workspace_id, 1, 4) = 'wsp_' AND
                           substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                           substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    derived_ttl_days INTEGER
                     CHECK(derived_ttl_days IS NULL OR
                           (derived_ttl_days >= 7 AND derived_ttl_days <= 3650)),
    created_at       INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK(updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- 4. Spine guards
-- ---------------------------------------------------------------------------

-- The event spine is append-only and is never TTL'd. Compaction copies rows
-- into object storage and retention slims derived read models; neither may
-- touch `events`. Ingestion only ever INSERT OR IGNOREs, so these guards cost
-- nothing on the write path and turn any future regression into a hard abort
-- instead of silent evidence loss.
CREATE TRIGGER events_reject_update
BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_reject_delete
BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;
