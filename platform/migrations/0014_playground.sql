-- Prompt playground + prompt CI/CD + the optimization loop
-- (migration 0014; parity rows 35, 36, 30).
--
-- WHAT THIS MIGRATION ADDS, AND WHY IT IS SO SMALL.
--
-- A playground run's OUTPUT is evidence, and evidence lives on the append-only
-- event spine — never in a feature-owned results table. So this migration adds
-- exactly one row-per-run METADATA table plus the read-path indexes the new
-- routes need. Everything a reviewer would actually argue about (which prompt
-- version produced which output, at what token cost, with what provenance) is a
-- `playground.completed` event in `events`, and every one of those is
-- reconstructible without reading playground_runs at all.
--
-- That split is the P4 acceptance gate for row 35, stated in
-- docs/parity-plan.md as "playground runs are recorded as experiment events
-- (dogfood)". A results table would have quietly failed that gate while
-- appearing to ship the feature.
--
-- THE THREE EVENT KINDS THIS SLICE WRITES (src/playground.ts), and their
-- provenance, which is the whole reason they are worth storing next to
-- captured coding-agent evidence:
--
--   playground.completed        OBSERVED. The assertion is "variant V of prompt
--                               P, rendered with these variables, was sent to
--                               model M and produced output whose digest is H,
--                               consuming these tokens". This Worker watched
--                               every part of that. The output TEXT is model
--                               output and is never asserted to be true — and
--                               it is never stored here either, only its
--                               digest (see CONTENT DISCIPLINE below).
--
--   prompt.labeled              OBSERVED, and byte-compatible with the local Go
--                               CLI's own prompt.labeled payload
--                               ({name, label, version} — internal/prompts
--                               NewLabeledEvent). A hosted eval-gated repoint
--                               adds an optional `gate` audit object; Go's
--                               json.Unmarshal-into-struct ignores it, so the
--                               local reader and the hosted read model
--                               (src/quality.ts) both keep working unchanged.
--                               THIS IS HOW LABELS MOVE: there is no labels
--                               table anywhere in this platform, hosted or
--                               local. A repoint is an append, and a ROLLBACK
--                               is just a repoint to an earlier version through
--                               the same gated route.
--
--   prompt.suggestion.recorded  INFERRED. Its headline assertion is a model's
--                               opinion about how a prompt should be rewritten.
--                               A model's opinion is never an observation, and
--                               a suggestion is NEVER auto-applied: moving a
--                               label is a separate, human-initiated, gated
--                               call. The payload additionally labels itself
--                               `suggestion_provenance: "INFERRED"` so a
--                               consumer that only reads payloads cannot
--                               mistake it for fact (same field-level
--                               discipline as gateway.ts's cost_provenance and
--                               simulations.ts's verdict_provenance).
--
-- CONTENT DISCIPLINE. No prompt body, rendered prompt, or model completion is
-- written into `events` by this slice. Playground events are content-ADDRESSED:
-- they carry `sha256:<hex>` of the rendered prompt and of the output, so a
-- holder of the text can prove it is the text that ran, and the platform stores
-- nothing it would later have to redact. When (and only when) the virtual key
-- used for the run was created with capture_tier = 'full', the bodies land in
-- the EXISTING gateway_capture_bodies table (migration 0010) — deliberately
-- reusing the gateway's single redaction choke-point rather than creating a
-- second place content can hide.
--
-- REPLAY DETERMINISM. Event payloads contain NO wall clock. Migration 0003's
-- events_reject_payload_conflict trigger ABORTS any insert that reuses an event
-- id for different bytes, so a replayed run must produce byte-identical
-- documents. Run timing therefore lives on the playground_runs row
-- (created_at / completed_at) and, per event, in the spine's own
-- server-assigned `ingested_at` column — observed, monotone, and not part of
-- raw_json. Latency is reported in the HTTP response and nowhere else.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform convention.

-- ---------------------------------------------------------------------------
-- playground_runs
-- ---------------------------------------------------------------------------
-- One POST /v1/playground/run. The row exists so a run can be listed, and so a
-- run that FAILED can say so: an upstream error settles the row as 'error' and
-- the caller gets a 502 with no partial variant results, rather than a
-- half-answer that reads like success.
--
-- The id is deterministic — plr_ULID(run start ms, sha256 of the run's
-- semantic identity) — so re-POSTing an identical run inside the same
-- millisecond lands on THIS row under INSERT OR IGNORE instead of forking a
-- second run against the same evidence. See src/playground.ts:playgroundRunID.
CREATE TABLE playground_runs (
    id           TEXT NOT NULL PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'plr_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id TEXT NOT NULL
                 CHECK(length(workspace_id) = 30 AND
                       substr(workspace_id, 1, 4) = 'wsp_' AND
                       substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                       substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),

    -- The prompt whose versions were compared. Not a foreign key: prompts have
    -- no table anywhere in this platform — they are a derived view over
    -- prompt.created / prompt.labeled events (src/quality.ts). A run therefore
    -- names the prompt the same way the events do, by name.
    prompt_name  TEXT NOT NULL CHECK(length(prompt_name) BETWEEN 1 AND 200),

    -- The compared version numbers, as a JSON array of 1 or 2 positive
    -- integers, in the order the caller asked for them. Two is the ceiling
    -- because the product is a DIFF: three-way diffing is a different feature
    -- with a different UI, and admitting it here would let the schema promise
    -- something the response shape cannot deliver.
    versions     TEXT NOT NULL
                 CHECK(json_valid(versions) AND
                       json_type(versions) = 'array' AND
                       json_array_length(versions) BETWEEN 1 AND 2),

    model        TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 200),

    -- Three-state terminal machine, same shape as simulation_runs (0015): a run
    -- starts 'running' and settles exactly once into 'done' or 'error'.
    status       TEXT NOT NULL DEFAULT 'running'
                 CHECK(status IN ('running', 'done', 'error')),

    created_at   INTEGER NOT NULL CHECK(created_at >= 0),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),

    -- 'running' and "not yet settled" are the same statement, so the status
    -- column and the completion timestamp can never disagree.
    CHECK((status = 'running') = (completed_at IS NULL))
);

CREATE INDEX idx_playground_runs_workspace ON playground_runs(workspace_id);
-- The listing order (newest first) and its cursor tie-break.
CREATE INDEX idx_playground_runs_workspace_created
    ON playground_runs(workspace_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Run invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

-- A run's identity — which prompt, which versions, which model, when it
-- started — is fixed at creation. Only the outcome columns settle. If the
-- identity could be edited, a listed run would silently start describing
-- something other than the events it points at.
CREATE TRIGGER playground_runs_identity_is_immutable
BEFORE UPDATE ON playground_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.prompt_name IS NOT OLD.prompt_name
  OR NEW.versions IS NOT OLD.versions
  OR NEW.model IS NOT OLD.model
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'playground run identity is immutable');
END;

-- Settling is terminal and happens once. Writing the SAME terminal status
-- again is permitted (a replayed settlement is deterministic, and the UPDATE's
-- own `completed_at IS NULL` predicate makes it a no-op); flipping a settled
-- run to a different outcome aborts.
CREATE TRIGGER playground_runs_status_is_terminal
BEFORE UPDATE OF status ON playground_runs
WHEN OLD.status IN ('done', 'error') AND NEW.status IS NOT OLD.status
BEGIN
    SELECT RAISE(ABORT, 'playground run status is terminal');
END;

-- completed_at is write-once for the same reason: it is the observed instant
-- the run settled, and a replay must not be able to move it.
CREATE TRIGGER playground_runs_completed_at_is_write_once
BEFORE UPDATE OF completed_at ON playground_runs
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at
BEGIN
    SELECT RAISE(ABORT, 'playground run completion time is write-once');
END;

-- ---------------------------------------------------------------------------
-- events: read-path indexes.
-- ---------------------------------------------------------------------------
-- No column of the append-only events table changes here (it cannot — see the
-- spine guards in 0003/0004/0006); these are read paths only.
--
-- All three are PARTIAL indexes: these kinds are a small slice of a workspace's
-- spine, so reading playground history never scans captured coding-agent
-- evidence.

-- The playground/suggestion history listing, in spine order.
CREATE INDEX idx_events_playground ON events(workspace_id, seq)
    WHERE kind IN ('playground.completed', 'prompt.suggestion.recorded');

-- "every variant event belonging to run X, in spine order". events has no
-- run_id column and cannot grow one, so the run id is projected out of the
-- canonical payload with a deterministic expression and indexed. The read
-- query in src/playground.ts uses this expression verbatim and its kind
-- predicate matches this index's WHERE exactly, so the lookup is an index
-- prune rather than a scan-and-filter.
CREATE INDEX idx_events_playground_run
    ON events(workspace_id, json_extract(raw_json, '$.payload.run_id'), seq)
    WHERE kind = 'playground.completed';

-- The eval gate on POST /v1/prompts/{name}/labels reads score.recorded events
-- to decide whether a label may move. That read is on the critical path of a
-- CI job (a GitHub Action blocks on it), so it gets its own partial index
-- rather than riding the general-purpose idx_events_kind. src/quality.ts's
-- GET /v1/scores scan uses the same predicate and benefits identically.
-- IF NOT EXISTS: migration 0012 (evals) creates this exact index under the
-- same name for the same predicate; whichever lands first wins and the other
-- is a no-op.
CREATE INDEX IF NOT EXISTS idx_events_score_recorded ON events(workspace_id, seq)
    WHERE kind = 'score.recorded';
