-- HandoffGraph hosted platform — initial D1 schema (migration 0001).
--
-- Multi-tenant by construction: EVERY table carries workspace_id (NOT NULL)
-- and is indexed on it, so every query stays workspace-scoped and later
-- row-level enforcement has a uniform column to hang off. Workspaces use the
-- wsp_<ulid> prefix; workstream ids keep the ws_<ulid> prefix used by the
-- hfg.event.v1 protocol.
--
-- The events table mirrors the local append-only event store: raw canonical
-- JSON is preserved losslessly (unknown fields included) and rows are only
-- ever INSERT OR IGNORE'd (idempotent on event_id per workspace).

CREATE TABLE workspaces (
    id           TEXT PRIMARY KEY,          -- wsp_<ulid>
    workspace_id TEXT NOT NULL,             -- mirrors id; keeps the uniform scoping column
    name         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   INTEGER NOT NULL           -- unix seconds
);
CREATE INDEX idx_workspaces_workspace ON workspaces(workspace_id);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY,          -- dev_<ulid>
    workspace_id TEXT NOT NULL,
    token_hash   TEXT NOT NULL,             -- hex SHA-256 of the device token; raw tokens are never stored
    label        TEXT,
    capabilities TEXT NOT NULL DEFAULT 'ingest,read',  -- comma-separated: ingest, read
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at   INTEGER                    -- unix seconds; NULL = active
);
CREATE INDEX idx_devices_workspace ON devices(workspace_id);
CREATE UNIQUE INDEX idx_devices_token_hash ON devices(token_hash);

CREATE TABLE repositories (
    id           TEXT PRIMARY KEY,          -- repo_<ulid>
    workspace_id TEXT NOT NULL,
    remote       TEXT,
    branch       TEXT,
    head         TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_repositories_workspace ON repositories(workspace_id);

CREATE TABLE workstreams (
    id            TEXT PRIMARY KEY,         -- ws_<ulid> (matches hfg.event.v1 workstream ids)
    workspace_id  TEXT NOT NULL,
    repository_id TEXT,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_workstreams_workspace ON workstreams(workspace_id);

CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,     -- ses_<ulid>
    workspace_id      TEXT NOT NULL,
    workstream_id     TEXT NOT NULL,
    provider          TEXT NOT NULL,        -- claude | codex | pi | ...
    native_session_id TEXT,
    created_at        INTEGER NOT NULL
);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_workstream ON sessions(workstream_id);

CREATE TABLE traces (
    trace_id           TEXT PRIMARY KEY,    -- trc_<ulid>
    workspace_id       TEXT NOT NULL,
    workstream_id      TEXT NOT NULL,
    session_id         TEXT,
    provider           TEXT,
    status             TEXT NOT NULL,
    started_at_ns      INTEGER NOT NULL,
    ended_at_ns        INTEGER,
    duration_ns        INTEGER,
    span_count         INTEGER NOT NULL DEFAULT 0,
    failed_span_count  INTEGER NOT NULL DEFAULT 0,
    changed_file_count INTEGER NOT NULL DEFAULT 0,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    root_span_id       TEXT,
    graph_hash         TEXT
);
CREATE INDEX idx_traces_workspace ON traces(workspace_id);
CREATE INDEX idx_traces_workstream ON traces(workstream_id);
CREATE INDEX idx_traces_status ON traces(status);

CREATE TABLE spans (
    span_id        TEXT PRIMARY KEY,        -- spn_<ulid>
    workspace_id   TEXT NOT NULL,
    trace_id       TEXT NOT NULL,
    parent_span_id TEXT,
    kind           TEXT NOT NULL,           -- normalized span kind (hfg.trace.v1)
    name           TEXT NOT NULL,
    status         TEXT NOT NULL,
    started_at_ns  INTEGER NOT NULL,
    ended_at_ns    INTEGER,
    sequence       INTEGER NOT NULL,
    provider       TEXT,
    model          TEXT,
    tool_name      TEXT,
    exit_code      INTEGER,
    evidence_level TEXT,
    body_ref       TEXT                     -- content hash into the R2 BODIES bucket (later version)
);
CREATE INDEX idx_spans_workspace ON spans(workspace_id);
CREATE INDEX idx_spans_trace ON spans(trace_id);
CREATE INDEX idx_spans_parent ON spans(parent_span_id);

CREATE TABLE checkpoints (
    id            TEXT PRIMARY KEY,         -- cp_<ulid>
    workspace_id  TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    objective     TEXT,
    status        TEXT,
    graph_hash    TEXT,
    score         INTEGER,                  -- 0-100 handoff score
    created_at    INTEGER NOT NULL,
    raw_json      TEXT NOT NULL             -- canonical hfg.checkpoint.v1 document
);
CREATE INDEX idx_checkpoints_workspace ON checkpoints(workspace_id);
CREATE INDEX idx_checkpoints_workstream ON checkpoints(workstream_id);

CREATE TABLE handoffs (
    id              TEXT PRIMARY KEY,       -- ho_<ulid>
    workspace_id    TEXT NOT NULL,
    workstream_id   TEXT NOT NULL,
    from_session_id TEXT,
    to_session_id   TEXT,
    checkpoint_id   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER
);
CREATE INDEX idx_handoffs_workspace ON handoffs(workspace_id);
CREATE INDEX idx_handoffs_workstream ON handoffs(workstream_id);

CREATE TABLE events (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id      TEXT NOT NULL,
    event_id          TEXT NOT NULL,        -- evt_<ulid>
    idempotency_key   TEXT,                 -- batch key that wrote this event (lineage)
    occurred_at       TEXT NOT NULL,        -- RFC 3339 exactly as observed; raw, never rewritten
    workstream_id     TEXT,
    session_id        TEXT,
    native_session_id TEXT,
    provider          TEXT,
    kind              TEXT NOT NULL,
    provenance        TEXT,                 -- OBSERVED | DECLARED | INFERRED
    content_hash      TEXT,
    ingested_at       INTEGER NOT NULL,     -- unix seconds, server-assigned
    raw_json          TEXT NOT NULL         -- canonical JSON; unknown fields preserved
);
CREATE UNIQUE INDEX idx_events_workspace_event ON events(workspace_id, event_id);
CREATE INDEX idx_events_workspace ON events(workspace_id);
CREATE INDEX idx_events_workstream ON events(workstream_id);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_kind ON events(kind);

CREATE TABLE idempotency_keys (
    key          TEXT NOT NULL UNIQUE,      -- globally unique: one receipt per key
    workspace_id TEXT NOT NULL,
    device_id    TEXT,
    receipt_json TEXT NOT NULL,             -- original receipt; replays return these exact bytes
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_idempotency_keys_workspace ON idempotency_keys(workspace_id);
