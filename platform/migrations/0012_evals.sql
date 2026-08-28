-- Hosted evals (migration 0012, parity row 29).
--
-- Two halves, and the split between them IS the feature:
--
--   DETERMINISTIC EVALUATORS  code checks over the span_observations read
--     model — the hosted port of the local `handoffgraph verify` detection
--     pack (internal/commands/verify_cmd.go). A verdict is a pure function of
--     evidence this platform already observed, so its score.recorded event
--     carries provenance OBSERVED and source 'evaluation'.
--
--   LLM JUDGE                 a model's opinion about a trace, reached over
--     the workspace's OWN upstream credential. A model's opinion is never an
--     observation: its score.recorded event carries provenance INFERRED and
--     source 'llm_judge', always, with no code path that can produce anything
--     else. That invariant is the one the product's name stakes itself on.
--
-- Design provenance (ideas only; no code or configuration from any AGPL/ELv2
-- project): "LLM-as-judge, plus scheduled/online evaluators" is the shape the
-- category has converged on. What is ours is where the results land — every
-- verdict is appended to the SAME append-only event spine as captured
-- coding-agent evidence, as a `score.recorded` event in the exact wire shape
-- the local Go core writes (internal/scores), rather than living in a private
-- results table that only this product can read.
--
-- Two tables, and only two, because everything else is derivable:
--   eval_configs  the definition of what to evaluate, how often, and with
--                 which judge. Operator-authored configuration, never evidence.
--   eval_runs     one execution of a config. Wall-clock timing lives HERE and
--                 never in an event payload, because event payloads must be
--                 byte-stable under replay (the 0003
--                 events_reject_payload_conflict trigger) and a wall clock is
--                 not.
--
-- There is no eval_results table. A verdict's evidence IS its score.recorded
-- event on the spine; a results table would be a second, divergeable copy of
-- something the spine already holds append-only.
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform convention.

-- ---------------------------------------------------------------------------
-- eval_configs
-- ---------------------------------------------------------------------------
-- The definition is the identity: every score event this config produces has a
-- deterministic id derived from (config id, trace id, check name), and names
-- that config id in its payload. If the check set or the judge prompt could be
-- edited in place, history would silently start describing an evaluation that
-- never ran, and a re-run would collide with an existing id carrying different
-- bytes. Editing is therefore not an operation (the same rule alert_rules
-- follows in 0009 and simulation_scenarios in 0015): disable and create a new
-- config. Only `active` and `last_run_at` ever move, and both only forward.
CREATE TABLE eval_configs (
    id            TEXT NOT NULL PRIMARY KEY
                  CHECK(length(id) = 30 AND substr(id, 1, 4) = 'evc_' AND
                        substr(id, 5, 1) GLOB '[0-7]' AND
                        substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id  TEXT NOT NULL
                  CHECK(length(workspace_id) = 30 AND
                        substr(workspace_id, 1, 4) = 'wsp_' AND
                        substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                        substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),

    -- Disabling is terminal (see the trigger below); there is no re-enable
    -- route, so a resumed evaluation gets its own identity in history.
    active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),

    -- How the config is executed. 'cron' configs are picked up by the sweep in
    -- src/index.ts's scheduled dispatcher; 'manual' ones only ever run when a
    -- caller POSTs .../run. `trigger` is a SQLite keyword, so it is quoted
    -- here and in every query that names it (src/evals.ts).
    "trigger"     TEXT NOT NULL CHECK("trigger" IN ('cron', 'manual')),

    -- {workstream?: string, kind?: string, since_minutes: int}. The window is
    -- part of the definition rather than a per-run argument so a cron config
    -- and a manual re-run of the same config evaluate the same population.
    -- since_minutes is bounded IN-SCHEMA, not only in the Worker: it also
    -- decides how often a cron config is due, so an out-of-range value would
    -- be a scheduling defect as well as a scan-size one.
    --
    -- The comparisons use `IS`, not `=`. json_type() returns NULL for an
    -- ABSENT path, and `NULL = 'integer'` is NULL, which a CHECK treats as
    -- satisfied — so `=` here would silently admit a filter with no window at
    -- all. `IS` compares NULL as a value and rejects it.
    target_filter TEXT NOT NULL
                  CHECK(json_valid(target_filter)
                        AND json_type(target_filter) IS 'object'
                        AND json_type(target_filter, '$.since_minutes') IS 'integer'
                        AND json_extract(target_filter, '$.since_minutes') BETWEEN 1 AND 10080),

    -- JSON array of deterministic check names. Validated against the known set
    -- in src/evals.ts at create time; the schema enforces only that it is a
    -- non-empty array, because the known set is a code fact that will grow and
    -- a CHECK naming today's members would freeze it here.
    checks        TEXT NOT NULL
                  CHECK(json_valid(checks)
                        AND json_type(checks) = 'array'
                        AND json_array_length(checks) BETWEEN 1 AND 32),

    -- NULL for a deterministic-only config. Otherwise
    -- {model, base_url, prompt_template, api_key_ciphertext, include_bodies}.
    --
    -- api_key_ciphertext is AES-GCM sealed under the EVAL_SEALING_KEY worker
    -- secret (`wrangler secret put EVAL_SEALING_KEY`), the same construction
    -- gateway.ts uses for upstream credentials. A raw provider key is never
    -- written to this column, and with no sealing key set the create route
    -- fails closed with 503 rather than storing one in the clear. The CHECK
    -- below is the schema-level half of that rule: a judge is not storable
    -- without ciphertext to reach it with. (Same `IS`-not-`=` reasoning as
    -- target_filter above: an absent key must fail the CHECK, not skip it.)
    judge         TEXT
                  CHECK(judge IS NULL OR
                        (json_valid(judge)
                         AND json_type(judge) IS 'object'
                         AND json_type(judge, '$.model') IS 'text'
                         AND json_type(judge, '$.base_url') IS 'text'
                         AND json_type(judge, '$.prompt_template') IS 'text'
                         AND json_type(judge, '$.api_key_ciphertext') IS 'text'
                         AND json_extract(judge, '$.base_url') LIKE 'https://%'
                         AND json_extract(judge, '$.prompt_template') LIKE '%{{input}}%')),

    created_at    INTEGER NOT NULL CHECK(created_at >= 0),

    -- NULL until the first run starts. Set at run START, not completion, so a
    -- long or crashed run cannot cause the cron sweep to re-enqueue the same
    -- config on every tick.
    last_run_at   INTEGER CHECK(last_run_at IS NULL OR last_run_at >= 0)
);

CREATE INDEX idx_eval_configs_workspace ON eval_configs(workspace_id);
-- The listing order (newest first) and the workspace-scoped id lookup.
CREATE INDEX idx_eval_configs_workspace_created
    ON eval_configs(workspace_id, created_at, id);
-- The cron sweep's due-selection: active cron configs ordered for a
-- deterministic, resumable scan across every workspace.
CREATE INDEX idx_eval_configs_due
    ON eval_configs(last_run_at, workspace_id, id)
    WHERE active = 1 AND "trigger" = 'cron';

-- ---------------------------------------------------------------------------
-- eval_runs
-- ---------------------------------------------------------------------------
-- One execution. `status` is a three-state terminal machine: a run starts
-- 'running' and settles exactly once into 'done' or 'error'.
--
-- The two counters are OBSERVED facts about the run itself, and are the only
-- numbers this table holds — the verdicts live on the spine. traces_evaluated
-- is capped at the same 200-trace ceiling the run path enforces, so a bug that
-- ignored the bound would abort here instead of quietly scanning a workspace.
CREATE TABLE eval_runs (
    id               TEXT NOT NULL PRIMARY KEY
                     CHECK(length(id) = 30 AND substr(id, 1, 4) = 'evr_' AND
                           substr(id, 5, 1) GLOB '[0-7]' AND
                           substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id     TEXT NOT NULL
                     CHECK(length(workspace_id) = 30 AND
                           substr(workspace_id, 1, 4) = 'wsp_' AND
                           substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                           substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    config_id        TEXT NOT NULL
                     CHECK(length(config_id) = 30 AND substr(config_id, 1, 4) = 'evc_'),

    status           TEXT NOT NULL DEFAULT 'running'
                     CHECK(status IN ('running', 'done', 'error')),

    traces_evaluated INTEGER NOT NULL DEFAULT 0
                     CHECK(traces_evaluated BETWEEN 0 AND 200),
    scores_recorded  INTEGER NOT NULL DEFAULT 0 CHECK(scores_recorded >= 0),

    started_at       INTEGER NOT NULL CHECK(started_at >= 0),
    completed_at     INTEGER CHECK(completed_at IS NULL OR completed_at >= started_at),

    -- A short, content-free stage token ('judge_unavailable', 'judge_unparseable',
    -- 'sealing_key_unavailable', ...) — never a provider message, a prompt, a
    -- model reply, or anything else that could carry captured content into a
    -- durable column.
    error_detail     TEXT CHECK(error_detail IS NULL OR
                                (length(error_detail) BETWEEN 1 AND 64
                                 AND error_detail NOT GLOB '*[^a-z_]*')),

    -- Table-level invariants (SQLite requires these after the column list).
    -- 1. 'running' and "not yet settled" are the same statement, so the status
    --    column and the completion timestamp can never disagree.
    -- 2. Only an errored run carries a reason; a run that finished cleanly
    --    cannot be annotated with one after the fact.
    CHECK((status = 'running') = (completed_at IS NULL)),
    CHECK(status = 'error' OR error_detail IS NULL)
);

CREATE INDEX idx_eval_runs_workspace ON eval_runs(workspace_id);
-- The per-config run listing (newest first) and its cursor tie-break.
CREATE INDEX idx_eval_runs_config
    ON eval_runs(workspace_id, config_id, started_at, id);

-- ---------------------------------------------------------------------------
-- Run invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

-- A run's identity is fixed at creation. Only the outcome columns settle.
CREATE TRIGGER eval_runs_identity_is_immutable
BEFORE UPDATE ON eval_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.config_id IS NOT OLD.config_id
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
    SELECT RAISE(ABORT, 'eval run identity is immutable');
END;

-- Settling is terminal and happens once. A resumed Workflow instance replays
-- the completion write with deterministic values, so the guard is `=`-safe:
-- writing the same terminal status again is permitted (and the UPDATE's own
-- `completed_at IS NULL` predicate makes it a no-op), while flipping a settled
-- run to a different outcome aborts.
CREATE TRIGGER eval_runs_status_is_terminal
BEFORE UPDATE OF status ON eval_runs
WHEN OLD.status IN ('done', 'error') AND NEW.status IS NOT OLD.status
BEGIN
    SELECT RAISE(ABORT, 'eval run status is terminal');
END;

-- completed_at is write-once for the same reason: it is the observed instant
-- the run settled, and a replay must not be able to move it.
CREATE TRIGGER eval_runs_completed_at_is_write_once
BEFORE UPDATE OF completed_at ON eval_runs
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at
BEGIN
    SELECT RAISE(ABORT, 'eval run completion time is write-once');
END;

-- Progress only ever moves forward. A regression would let a resumed run
-- under-report verdicts that already have events on the spine, which would
-- make the run row disagree with the evidence it points at.
CREATE TRIGGER eval_runs_counters_are_monotone
BEFORE UPDATE ON eval_runs
WHEN NEW.traces_evaluated < OLD.traces_evaluated
  OR NEW.scores_recorded < OLD.scores_recorded
BEGIN
    SELECT RAISE(ABORT, 'eval run progress regressed');
END;

-- ---------------------------------------------------------------------------
-- Config invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

CREATE TRIGGER eval_configs_definition_is_immutable
BEFORE UPDATE ON eval_configs
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.name IS NOT OLD.name
  OR NEW."trigger" IS NOT OLD."trigger"
  OR NEW.target_filter IS NOT OLD.target_filter
  OR NEW.checks IS NOT OLD.checks
  OR NEW.judge IS NOT OLD.judge
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'eval config definition is immutable');
END;

-- Disabling is terminal, matching the API surface (there is no re-enable
-- route). Resuming means creating a config, which gives the resumed evaluation
-- its own identity in history.
CREATE TRIGGER eval_configs_disable_is_terminal
BEFORE UPDATE OF active ON eval_configs
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
    SELECT RAISE(ABORT, 'eval config disable is terminal');
END;

-- The cron sweep's due-selection reads last_run_at. Letting it move backwards
-- would let a config be re-enqueued on every tick forever.
CREATE TRIGGER eval_configs_last_run_is_monotone
BEFORE UPDATE OF last_run_at ON eval_configs
WHEN OLD.last_run_at IS NOT NULL
 AND (NEW.last_run_at IS NULL OR NEW.last_run_at < OLD.last_run_at)
BEGIN
    SELECT RAISE(ABORT, 'eval config last_run_at regressed');
END;

-- ---------------------------------------------------------------------------
-- events: read-path indexes for the evaluators.
-- ---------------------------------------------------------------------------
-- No column of the append-only events table changes here (it cannot — see the
-- spine guards in 0003/0004/0006); these are read paths only, and both are
-- PARTIAL so an evaluator never scans captured coding-agent evidence it is not
-- asking about.

-- The handoffs_acknowledged check counts handoff.created against
-- handoff.accepted per workstream inside the config's window. The index key
-- order matches that GROUP BY exactly.
CREATE INDEX idx_events_handoff_ack
    ON events(workspace_id, workstream_id, occurred_at)
    WHERE kind IN ('handoff.created', 'handoff.accepted');

-- Reading back what an eval produced (and the existing GET /v1/scores
-- materializer in src/quality.ts) is "every score.recorded event of a
-- workspace, in spine order".
CREATE INDEX idx_events_score_recorded
    ON events(workspace_id, seq)
    WHERE kind = 'score.recorded';
