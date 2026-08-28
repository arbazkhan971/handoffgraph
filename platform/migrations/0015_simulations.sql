-- Agent simulations (migration 0015, parity row 31).
--
-- A simulation here is NOT a running agent process. It is a structured
-- multi-turn conversation between three models reached over a BYO upstream
-- credential: a simulated USER (driven by a persona + goal prompt), the
-- ASSISTANT under test, and a JUDGE that scores the finished transcript
-- against the scenario's success criteria. That non-goal is deliberate and is
-- what keeps this feature inside the platform's Cloudflare-only, no-process
-- envelope (see docs/simulations.md).
--
-- Design provenance (ideas only; no code or configuration from any AGPL/ELv2
-- project): "simulate a user, then judge the transcript" is the shape the
-- category has converged on. What is ours is where the results land — the
-- turns and the verdict are appended to the SAME append-only event spine as
-- captured coding-agent evidence, with per-role provenance, rather than
-- living in a private results table.
--
-- Provenance split, enforced by how the two event kinds are written
-- (src/simulations.ts):
--   simulation.turn.completed  OBSERVED. The claim is "at exchange N, role R
--                              produced content whose digest is H". Every part
--                              of that was directly observed by this Worker.
--                              The content itself is never stored hosted; the
--                              event is content-ADDRESSED, not content-bearing.
--   simulation.completed       INFERRED. Its headline assertion is a model's
--                              verdict and score, so the event as a whole is
--                              model-derived. The observed facts it also
--                              carries (turns_taken) are labelled field-wise
--                              in the payload, the same discipline
--                              gateway.ts uses for cost_provenance.
--
-- Two tables, and only two, because everything else is derivable:
--   simulation_scenarios  the immutable definition of what to simulate.
--   simulation_runs       one execution of a scenario. Wall-clock timing lives
--                         HERE and never in an event payload, because event
--                         payloads must be byte-stable under replay (the
--                         0003 events_reject_payload_conflict trigger) and a
--                         wall clock is not.
--
-- There is no simulation_turns table. A turn's evidence is its event; its
-- per-turn recording time is the spine's own server-assigned `ingested_at`,
-- which is observed, monotone, and — crucially — not part of raw_json, so it
-- can differ between the first write and an ignored replay without ever
-- tripping the payload-conflict guard.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform convention.

-- ---------------------------------------------------------------------------
-- simulation_scenarios
-- ---------------------------------------------------------------------------
-- The definition is the identity: every run and every simulation.completed
-- event in the spine names a scenario_id and was judged against THAT
-- scenario's success_criteria. If the criteria could be edited in place,
-- history would silently start describing a scenario that never ran. Editing
-- is therefore not an operation (same rule as alert_rules in migration 0009):
-- deactivate and create a new scenario.
--
-- max_turns is capped at 12 in-schema. A simulation is a bounded evidence
-- generator, not an open-ended chat: the ceiling bounds upstream spend, bounds
-- the inline (no-Workflow) execution path, and bounds the transcript read.
CREATE TABLE simulation_scenarios (
    id               TEXT NOT NULL PRIMARY KEY
                     CHECK(length(id) = 30 AND substr(id, 1, 4) = 'sim_' AND
                           substr(id, 5, 1) GLOB '[0-7]' AND
                           substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id     TEXT NOT NULL
                     CHECK(length(workspace_id) = 30 AND
                           substr(workspace_id, 1, 4) = 'wsp_' AND
                           substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                           substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    name             TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),

    -- The three prompt fragments that define the simulation. persona and goal
    -- drive the user-simulator model; success_criteria is handed to the judge
    -- alongside the finished transcript. All three are operator-authored
    -- configuration, not captured evidence.
    persona          TEXT NOT NULL CHECK(length(persona) BETWEEN 1 AND 4000),
    goal             TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 4000),
    success_criteria TEXT NOT NULL CHECK(length(success_criteria) BETWEEN 1 AND 4000),

    max_turns        INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 12),
    created_at       INTEGER NOT NULL CHECK(created_at >= 0),
    active           INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
);

CREATE INDEX idx_simulation_scenarios_workspace ON simulation_scenarios(workspace_id);
-- The listing order (newest first) and the workspace-scoped id lookup.
CREATE INDEX idx_simulation_scenarios_workspace_created
    ON simulation_scenarios(workspace_id, created_at, id);

-- ---------------------------------------------------------------------------
-- simulation_runs
-- ---------------------------------------------------------------------------
-- One execution. `status` is a three-state terminal machine: a run starts
-- 'running' and settles exactly once into 'done' or 'error'.
--
-- judge_score is a decimal STRING, never a float — the same rule the gateway
-- ledger and alert thresholds follow. A 0..1 score compared through an IEEE
-- double is exactly the defect the decimal-string convention exists to
-- prevent, and a score is the number a reviewer will argue about.
CREATE TABLE simulation_runs (
    id           TEXT NOT NULL PRIMARY KEY
                 CHECK(length(id) = 30 AND substr(id, 1, 4) = 'smr_' AND
                       substr(id, 5, 1) GLOB '[0-7]' AND
                       substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id TEXT NOT NULL
                 CHECK(length(workspace_id) = 30 AND
                       substr(workspace_id, 1, 4) = 'wsp_' AND
                       substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                       substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    scenario_id  TEXT NOT NULL
                 CHECK(length(scenario_id) = 30 AND substr(scenario_id, 1, 4) = 'sim_'),

    status       TEXT NOT NULL DEFAULT 'running'
                 CHECK(status IN ('running', 'done', 'error')),

    -- Completed user/assistant exchanges. Bounded by the scenario ceiling.
    turns_taken  INTEGER NOT NULL DEFAULT 0 CHECK(turns_taken BETWEEN 0 AND 12),

    -- Model-derived, therefore INFERRED, therefore only ever present on a run
    -- that actually reached a parseable judgement. The CHECK below is the
    -- schema-level statement of the fail-closed rule in src/simulations.ts: a
    -- run that errored — including one whose judge returned unparseable
    -- output — can never carry a verdict or a score.
    verdict      TEXT CHECK(verdict IS NULL OR verdict IN ('pass', 'fail')),
    judge_score  TEXT CHECK(judge_score IS NULL OR
                            (length(judge_score) BETWEEN 1 AND 40 AND
                             judge_score NOT GLOB '*[^0-9.]*' AND
                             judge_score GLOB '*[0-9]*')),

    started_at   INTEGER NOT NULL CHECK(started_at >= 0),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= started_at),

    -- Table-level invariants (SQLite requires these after the column list).
    -- 1. A verdict only ever accompanies a run that actually reached a
    --    parseable judgement — an errored run carries neither.
    -- 2. 'running' and "not yet settled" are the same statement, so the status
    --    column and the completion timestamp can never disagree.
    CHECK(status = 'done' OR (verdict IS NULL AND judge_score IS NULL)),
    CHECK((status = 'running') = (completed_at IS NULL))
);

CREATE INDEX idx_simulation_runs_workspace ON simulation_runs(workspace_id);
-- The per-scenario run listing (newest first) and its cursor tie-break.
CREATE INDEX idx_simulation_runs_scenario
    ON simulation_runs(workspace_id, scenario_id, started_at, id);

-- ---------------------------------------------------------------------------
-- Run invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

-- A run's identity is fixed at creation. Only the outcome columns settle.
CREATE TRIGGER simulation_runs_identity_is_immutable
BEFORE UPDATE ON simulation_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.scenario_id IS NOT OLD.scenario_id
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
    SELECT RAISE(ABORT, 'simulation run identity is immutable');
END;

-- Settling is terminal and happens once. A resumed Workflow instance replays
-- the completion write with deterministic values, so the guard is `=`-safe:
-- writing the same terminal status again is permitted (and the UPDATE's own
-- `completed_at IS NULL` predicate makes it a no-op), while flipping a settled
-- run to a different outcome aborts.
CREATE TRIGGER simulation_runs_status_is_terminal
BEFORE UPDATE OF status ON simulation_runs
WHEN OLD.status IN ('done', 'error') AND NEW.status IS NOT OLD.status
BEGIN
    SELECT RAISE(ABORT, 'simulation run status is terminal');
END;

-- completed_at is write-once for the same reason: it is the observed instant
-- the run settled, and a replay must not be able to move it.
CREATE TRIGGER simulation_runs_completed_at_is_write_once
BEFORE UPDATE OF completed_at ON simulation_runs
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at
BEGIN
    SELECT RAISE(ABORT, 'simulation run completion time is write-once');
END;

-- Turn progress only ever moves forward. A regression would let a resumed run
-- under-report turns that already have events on the spine, which would make
-- the run row disagree with the evidence it points at.
CREATE TRIGGER simulation_runs_turns_are_monotone
BEFORE UPDATE OF turns_taken ON simulation_runs
WHEN NEW.turns_taken < OLD.turns_taken
BEGIN
    SELECT RAISE(ABORT, 'simulation run turn count regressed');
END;

-- ---------------------------------------------------------------------------
-- Scenario invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

CREATE TRIGGER simulation_scenarios_definition_is_immutable
BEFORE UPDATE ON simulation_scenarios
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.name IS NOT OLD.name
  OR NEW.persona IS NOT OLD.persona
  OR NEW.goal IS NOT OLD.goal
  OR NEW.success_criteria IS NOT OLD.success_criteria
  OR NEW.max_turns IS NOT OLD.max_turns
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'simulation scenario definition is immutable');
END;

-- Deactivation is terminal, matching the API surface (there is no re-activate
-- route). Resuming means creating a scenario, which gives the resumed
-- simulation its own identity in history.
CREATE TRIGGER simulation_scenarios_deactivate_is_terminal
BEFORE UPDATE OF active ON simulation_scenarios
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
    SELECT RAISE(ABORT, 'simulation scenario deactivation is terminal');
END;

-- ---------------------------------------------------------------------------
-- events: read-path indexes for transcript reconstruction.
-- ---------------------------------------------------------------------------
-- No column of the append-only events table changes here (it cannot — see the
-- spine guards in 0004/0006); these are read paths only.
--
-- Simulation events are a small partial slice of a workspace's spine, so both
-- indexes are partial: reading one run's transcript never scans captured
-- coding-agent evidence.
CREATE INDEX idx_events_simulation ON events(workspace_id, seq)
    WHERE kind IN ('simulation.turn.completed', 'simulation.completed');

-- The transcript read is "every event belonging to run X, in spine order".
-- events has no run_id column and cannot grow one, so the run id is projected
-- out of the canonical payload with a deterministic expression and indexed.
-- The read query in src/simulations.ts uses this expression verbatim, and its
-- kind predicate matches this index's WHERE exactly, so the lookup is an
-- index prune rather than a scan-and-filter.
CREATE INDEX idx_events_simulation_run
    ON events(workspace_id, json_extract(raw_json, '$.payload.run_id'), seq)
    WHERE kind IN ('simulation.turn.completed', 'simulation.completed');
