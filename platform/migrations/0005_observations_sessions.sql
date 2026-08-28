-- Wide span-observation read model, resource fingerprints, and first-class
-- hosted session tracking (parity-plan rows 9, 10, 11 — hosted halves).
--
-- Design provenance (ideas only; no code or config from any AGPL/ELv2 project):
--   * row 9  — observations-first wide table: the Langfuse V4 lesson. Every
--              span row carries the identity attributes a hot read needs, so
--              no query on the read path joins traces against spans. On our
--              spine the event envelope already carries workstream/session/
--              provider/agent/model, so the denormalization is a straight
--              copy rather than a trace lookup.
--   * row 10 — ts_bucket time pruning: the SigNoz/OpenObserve lesson. A
--              stored bucket column plus a bucket predicate lets D1 skip
--              whole ranges of the index before the exact predicate runs.
--              The parity plan's stack-translation table pins 5-minute
--              buckets locally and 30-MINUTE buckets in D1; both tables here
--              use 30 minutes expressed in that table's native time unit
--              (nanoseconds for observations, milliseconds for sessions).
--   * row 11 — resource fingerprints: a tiny lookup table of the identity
--              label tuple, so high-cardinality filters prune through a small
--              table first. The fingerprint is a hash of SORTED label pairs,
--              which is what makes it a pure function of the labels.
--
-- Everything here is a DERIVED model: rows are a pure function of the
-- append-only events table and can be dropped and rebuilt at any time
-- (POST /v1/admin/reindex). The events table itself is never mutated.
--
-- Determinism is enforced in-schema. The projection merges rows with
-- monotone rules (earliest start wins, latest completion wins, highest
-- status rank wins, MIN/MAX on seen-at bounds) so replay and out-of-order
-- batch arrival converge on identical rows. The triggers at the bottom of
-- this migration ABORT any UPDATE that violates that monotonicity, so a
-- future upsert bug fails closed instead of silently producing
-- arrival-order-dependent read models.

-- ---------------------------------------------------------------------------
-- sessions: rebuilt as a tenant-scoped, event-derived projection.
-- ---------------------------------------------------------------------------
-- The v1 sessions table had a global `id` primary key (the same tenant-scoping
-- defect 0003 fixed for workstreams: another tenant's known session id could
-- suppress this tenant's projection) and carried no tracking fields at all.
-- Rebuild it with the (workspace_id, id) identity every platform query binds,
-- and with the counters/time bounds hosted session tracking needs.
--
-- workstream_id and provider become nullable: a session is now projected from
-- whatever events reference it, and not every provider emits both on the first
-- event. created_at/updated_at/ts_bucket are STORED generated columns so they
-- can never drift from the event-time bounds they summarize.
ALTER TABLE sessions RENAME TO sessions_legacy_0005;

CREATE TABLE sessions (
    id                TEXT NOT NULL,
    workspace_id      TEXT NOT NULL,
    workstream_id     TEXT,
    provider          TEXT,
    native_session_id TEXT,

    -- Event-time bounds in unix milliseconds (safe JavaScript integers).
    -- The *_event_id columns are total-order tiebreakers, so which event wins
    -- an identity field never depends on batch arrival order.
    first_event_at_ms INTEGER NOT NULL CHECK(first_event_at_ms >= 0),
    first_event_id    TEXT,
    last_event_at_ms  INTEGER NOT NULL CHECK(last_event_at_ms >= first_event_at_ms),
    last_event_id     TEXT,

    -- Absolute counters: the projection recomputes them from the event log and
    -- from span_observations on every write, never increments them. Increments
    -- would double-count a replay under a fresh Idempotency-Key.
    event_count       INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0),
    trace_count       INTEGER NOT NULL DEFAULT 0 CHECK(trace_count >= 0),
    span_count        INTEGER NOT NULL DEFAULT 0 CHECK(span_count >= 0),
    failed_span_count INTEGER NOT NULL DEFAULT 0
                      CHECK(failed_span_count >= 0 AND failed_span_count <= span_count),

    created_at        INTEGER GENERATED ALWAYS AS (first_event_at_ms / 1000) STORED,
    updated_at        INTEGER GENERATED ALWAYS AS (last_event_at_ms / 1000) STORED,
    -- 30-minute buckets, in this table's native unit (milliseconds).
    ts_bucket         INTEGER GENERATED ALWAYS AS (last_event_at_ms / 1800000) STORED,

    PRIMARY KEY (workspace_id, id)
);

INSERT INTO sessions
    (id, workspace_id, workstream_id, provider, native_session_id,
     first_event_at_ms, last_event_at_ms)
SELECT id, workspace_id, workstream_id, provider, native_session_id,
       created_at * 1000, created_at * 1000
FROM sessions_legacy_0005;

DROP TABLE sessions_legacy_0005;

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_workstream ON sessions(workstream_id);
-- The listing order (most recent activity first) and the bucket prune.
CREATE INDEX idx_sessions_recent ON sessions(workspace_id, last_event_at_ms DESC, id DESC);
CREATE INDEX idx_sessions_bucket ON sessions(workspace_id, ts_bucket);
CREATE INDEX idx_sessions_provider ON sessions(workspace_id, provider);

-- ---------------------------------------------------------------------------
-- span_observations: the wide, denormalized read model.
-- ---------------------------------------------------------------------------
-- One row per span identity, merged from every event that contributed to it.
-- started_at_ns/ended_at_ns are int64 UNIX NANOSECONDS: they exceed the
-- JavaScript safe-integer range, so the Worker binds and reads them as decimal
-- strings and CASTs at the SQL boundary. They are never round-tripped through
-- a float.
CREATE TABLE span_observations (
    workspace_id      TEXT NOT NULL,
    span_id           TEXT NOT NULL,
    trace_id          TEXT NOT NULL,
    parent_span_id    TEXT,

    -- Denormalized identity (copied onto every row on purpose).
    session_id        TEXT,
    native_session_id TEXT,
    workstream_id     TEXT,
    provider          TEXT,
    agent             TEXT,
    model             TEXT,

    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    status            TEXT NOT NULL CHECK(status IN ('unknown', 'running', 'ok', 'error')),
    -- Merge precedence made explicit and checkable: error > ok > running >
    -- unknown. The upsert keeps MAX(rank), which is order-independent.
    status_rank       INTEGER NOT NULL
                      CHECK(status_rank = CASE status
                                            WHEN 'error' THEN 3
                                            WHEN 'ok' THEN 2
                                            WHEN 'running' THEN 1
                                            ELSE 0
                                          END),

    started_at_ns     INTEGER NOT NULL CHECK(started_at_ns >= 0),
    start_event_id    TEXT NOT NULL,
    ended_at_ns       INTEGER CHECK(ended_at_ns IS NULL OR ended_at_ns >= 0),
    end_event_id      TEXT,

    tool_name         TEXT,
    exit_code         INTEGER,
    token_in          INTEGER CHECK(token_in IS NULL OR token_in >= 0),
    token_out         INTEGER CHECK(token_out IS NULL OR token_out >= 0),

    -- Money is a decimal STRING, never a float, and is never recorded without
    -- a provenance label ('unknown' provenance is not a recordable cost).
    cost_amount       TEXT CHECK(cost_amount IS NULL OR (
                          length(cost_amount) BETWEEN 1 AND 40
                          AND cost_amount NOT GLOB '*[^0-9.-]*'
                          AND cost_amount GLOB '*[0-9]*')),
    cost_provenance   TEXT CHECK(cost_provenance IS NULL OR cost_provenance IN (
                          'provider_reported', 'catalog_estimate', 'user_supplied')),

    -- Resource fingerprint: sha256 of the sorted identity label pairs,
    -- truncated to 12 bytes (24 lowercase hex chars) — the same construction
    -- the local Go core uses, extended with repo/host.
    fingerprint       TEXT NOT NULL
                      CHECK(length(fingerprint) = 24 AND fingerprint NOT GLOB '*[^0-9a-f]*'),

    -- Derived, always consistent with the columns they summarize.
    duration_ms       INTEGER GENERATED ALWAYS AS (
                          CASE WHEN ended_at_ns IS NULL THEN NULL
                               ELSE (ended_at_ns - started_at_ns) / 1000000 END) STORED,
    -- 30-minute buckets, in this table's native unit (nanoseconds).
    ts_bucket         INTEGER GENERATED ALWAYS AS (started_at_ns / 1800000000000) STORED,

    -- Attribute-existence flags for the hot optional attributes. Filtering
    -- "has a model" / "has a cost" hits a narrow integer index instead of the
    -- value column, and the flags cannot drift because they are generated.
    model_exists      INTEGER GENERATED ALWAYS AS (model IS NOT NULL) STORED,
    tool_name_exists  INTEGER GENERATED ALWAYS AS (tool_name IS NOT NULL) STORED,
    exit_code_exists  INTEGER GENERATED ALWAYS AS (exit_code IS NOT NULL) STORED,
    cost_exists       INTEGER GENERATED ALWAYS AS (cost_amount IS NOT NULL) STORED,
    token_exists      INTEGER GENERATED ALWAYS AS (
                          token_in IS NOT NULL OR token_out IS NOT NULL) STORED,

    -- A completion timestamp and the event that produced it are one fact.
    CHECK((ended_at_ns IS NULL) = (end_event_id IS NULL)),
    -- Cost is a recorded fact with a source, never an unlabelled estimate.
    CHECK((cost_amount IS NULL) = (cost_provenance IS NULL)),

    PRIMARY KEY (workspace_id, span_id)
);

CREATE INDEX idx_span_observations_workspace ON span_observations(workspace_id);
-- The two indexes the parity plan names: the time prune and the trace lookup.
CREATE INDEX idx_span_observations_bucket ON span_observations(workspace_id, ts_bucket);
CREATE INDEX idx_span_observations_trace ON span_observations(workspace_id, trace_id);
CREATE INDEX idx_span_observations_workstream
    ON span_observations(workspace_id, workstream_id, ts_bucket);
CREATE INDEX idx_span_observations_session
    ON span_observations(workspace_id, session_id, ts_bucket);
CREATE INDEX idx_span_observations_fingerprint
    ON span_observations(workspace_id, fingerprint);
CREATE INDEX idx_span_observations_kind ON span_observations(workspace_id, kind, ts_bucket);
CREATE INDEX idx_span_observations_status ON span_observations(workspace_id, status, ts_bucket);

-- ---------------------------------------------------------------------------
-- span_fingerprints: the tiny identity-label lookup table.
-- ---------------------------------------------------------------------------
-- first_seen/last_seen are unix MILLISECONDS (safe JavaScript integers); they
-- bound when this identity was observed, they are not a time-prune column.
CREATE TABLE span_fingerprints (
    workspace_id TEXT NOT NULL,
    fingerprint  TEXT NOT NULL
                 CHECK(length(fingerprint) = 24 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    provider     TEXT,
    agent        TEXT,
    repo         TEXT,
    host         TEXT,
    model        TEXT,
    first_seen   INTEGER NOT NULL CHECK(first_seen >= 0),
    last_seen    INTEGER NOT NULL CHECK(last_seen >= first_seen),
    PRIMARY KEY (workspace_id, fingerprint)
);

CREATE INDEX idx_span_fingerprints_workspace ON span_fingerprints(workspace_id);

-- ---------------------------------------------------------------------------
-- events: indexes the projection and the rebuild path read through.
-- ---------------------------------------------------------------------------
-- No column of the append-only events table changes here; these are read
-- paths only. (workspace_id, session_id, kind) serves the per-session event
-- and per-kind counts; (workspace_id, seq) serves the ordered rebuild scan.
CREATE INDEX idx_events_workspace_session_kind ON events(workspace_id, session_id, kind);
CREATE INDEX idx_events_workspace_seq ON events(workspace_id, seq);

-- ---------------------------------------------------------------------------
-- Monotone-merge invariants, enforced in-schema.
-- ---------------------------------------------------------------------------
-- The projection's convergence rules are what make the derived model
-- independent of batch arrival order. Encoding them as triggers means any
-- future upsert that regresses a bound aborts its transaction instead of
-- writing a read model that depends on the order events happened to arrive.
-- A rebuild DELETEs and re-INSERTs, so it never trips these.

CREATE TRIGGER span_observations_monotone_start
BEFORE UPDATE ON span_observations
WHEN NEW.started_at_ns > OLD.started_at_ns
BEGIN
    SELECT RAISE(ABORT, 'observation start regressed');
END;

CREATE TRIGGER span_observations_monotone_end
BEFORE UPDATE ON span_observations
WHEN OLD.ended_at_ns IS NOT NULL
 AND (NEW.ended_at_ns IS NULL OR NEW.ended_at_ns < OLD.ended_at_ns)
BEGIN
    SELECT RAISE(ABORT, 'observation completion regressed');
END;

CREATE TRIGGER span_observations_monotone_status
BEFORE UPDATE ON span_observations
WHEN NEW.status_rank < OLD.status_rank
BEGIN
    SELECT RAISE(ABORT, 'observation status regressed');
END;

-- trace_id is deliberately NOT frozen: a span whose first observed event
-- carried no trace_id falls back to its session, and a later span.started with
-- the real trace id must be allowed to refine it (the same orphan re-resolution
-- the local materializer performs). The refinement follows the earliest-start
-- rule, so it is still order-independent.

CREATE TRIGGER sessions_monotone_bounds
BEFORE UPDATE ON sessions
WHEN NEW.first_event_at_ms > OLD.first_event_at_ms
  OR NEW.last_event_at_ms < OLD.last_event_at_ms
BEGIN
    SELECT RAISE(ABORT, 'session event bounds regressed');
END;

CREATE TRIGGER span_fingerprints_monotone_bounds
BEFORE UPDATE ON span_fingerprints
WHEN NEW.first_seen > OLD.first_seen OR NEW.last_seen < OLD.last_seen
BEGIN
    SELECT RAISE(ABORT, 'fingerprint seen bounds regressed');
END;

-- The labels ARE the fingerprint preimage: if a label could change under a
-- fingerprint, the hash would no longer identify the tuple it names.
CREATE TRIGGER span_fingerprints_immutable_labels
BEFORE UPDATE ON span_fingerprints
WHEN NEW.provider IS NOT OLD.provider
  OR NEW.agent IS NOT OLD.agent
  OR NEW.repo IS NOT OLD.repo
  OR NEW.host IS NOT OLD.host
  OR NEW.model IS NOT OLD.model
BEGIN
    SELECT RAISE(ABORT, 'fingerprint label drift');
END;
