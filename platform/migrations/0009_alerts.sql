-- Scheduled alerts + notification channels (migration 0009, parity rows 41, 43).
--
-- Row 41 — scheduled-query/threshold alerts over the derived read models, with
-- webhook / Slack / email delivery. Row 43 — alert history as append-only
-- events, dogfooded onto our own spine rather than kept in a side table.
--
-- Design provenance (ideas only; no code or config from any AGPL/ELv2 project):
--   * threshold alerts evaluated on a cron against a trailing window is the
--     shape every observability stack converges on; what is ours is that the
--     window is pinned to the SAME 30-minute ts_bucket grid migration 0005
--     stores on span_observations, so a window predicate is always an exact
--     index prune with no slack bucket.
--   * alert history is NOT a table here. A fired alert is appended to `events`
--     as an `alert.fired` hfg.event.v1 row, which makes alert history obey the
--     same append-only, replayable, exportable rules as captured evidence —
--     and makes the row-47 webhook sweep deliver alerts with no new plumbing.
--
-- Consequences of storing history on the spine:
--   * events is append-only in-schema (0004/0006 triggers ABORT UPDATE and
--     DELETE), so the evaluator only ever INSERT OR IGNOREs. The event id is a
--     pure function of (rule id, window end), so re-evaluating the same window
--     is idempotent instead of duplicating history.
--   * `alert_rules` is the ONLY mutable state this migration adds, and only the
--     evaluation bookkeeping columns may change (see the triggers below).
--
-- Every table carries workspace_id (NOT NULL, indexed) per platform convention.

-- ---------------------------------------------------------------------------
-- alert_rules
-- ---------------------------------------------------------------------------
-- One row per rule. Channel configuration is folded into a JSON array rather
-- than a child table: a channel has no identity of its own, is never queried
-- across rules, and is always read whole when a rule fires.
--
-- `threshold` is a decimal STRING, never a float — a money threshold compared
-- through an IEEE double is exactly the defect the platform's decimal-string
-- money convention exists to prevent. The evaluator compares value against
-- threshold with one exact string-decimal comparator that serves both the
-- fractional metrics (cost, error_rate) and the integer counters.
CREATE TABLE alert_rules (
    id                TEXT NOT NULL PRIMARY KEY
                      CHECK(length(id) = 30 AND substr(id, 1, 4) = 'alr_' AND
                            substr(id, 5, 1) GLOB '[0-7]' AND
                            substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    workspace_id      TEXT NOT NULL
                      CHECK(length(workspace_id) = 30 AND
                            substr(workspace_id, 1, 4) = 'wsp_' AND
                            substr(workspace_id, 5, 1) GLOB '[0-7]' AND
                            substr(workspace_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
    name              TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),

    -- The measurable quantities. error_rate and failed_spans / tokens_* / cost
    -- read span_observations; events reads the spine's own ingestion counter.
    metric            TEXT NOT NULL
                      CHECK(metric IN ('error_rate', 'failed_spans', 'events',
                                       'cost', 'tokens_in', 'tokens_out')),

    -- Windows are whole multiples of the 30-minute observation bucket, so a
    -- window boundary is always a bucket boundary and the bucket predicate is
    -- exact. Anything finer would need a slack bucket and stop being exact.
    window_minutes    INTEGER NOT NULL CHECK(window_minutes IN (30, 60, 1440)),

    comparator        TEXT NOT NULL CHECK(comparator IN ('gt', 'gte', 'lt', 'lte')),

    -- Decimal string: digits with at most one point, no sign, no exponent.
    -- (The single-point rule is enforced at the API edge; the GLOB pair here is
    -- the schema-level backstop that keeps floats and junk out of the column.)
    threshold         TEXT NOT NULL
                      CHECK(length(threshold) BETWEEN 1 AND 40 AND
                            threshold NOT GLOB '*[^0-9.]*' AND
                            threshold GLOB '*[0-9]*'),

    -- NULL = the whole workspace.
    workstream_id     TEXT,

    -- [{"type":"webhook","url":...},{"type":"slack","webhook_url":...},
    --  {"type":"email","to":...}] — stored canonically (sorted) by the API.
    channels          TEXT NOT NULL
                      CHECK(json_valid(channels) AND json_type(channels) = 'array'),

    active            INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0),

    -- Evaluation bookkeeping. last_evaluated_at is wall-clock (it drives the
    -- "is this rule due" gate); last_fired_at is in WINDOW-END space (it drives
    -- the sustained-breach refire timer), so the two are never compared.
    last_evaluated_at INTEGER CHECK(last_evaluated_at IS NULL OR last_evaluated_at >= 0),
    last_fired_at     INTEGER CHECK(last_fired_at IS NULL OR last_fired_at >= 0),

    -- The breach state machine. A rule fires on the ok -> breaching TRANSITION,
    -- not on every breaching evaluation, so a sustained outage produces one
    -- alert (plus a reminder every few windows) instead of one per cron tick.
    breach_state      TEXT NOT NULL DEFAULT 'ok'
                      CHECK(breach_state IN ('ok', 'breaching'))
);

CREATE INDEX idx_alert_rules_workspace ON alert_rules(workspace_id);
-- The listing order (newest first) and the workspace-scoped id lookup.
CREATE INDEX idx_alert_rules_workspace_created
    ON alert_rules(workspace_id, created_at, id);
-- The sweep's "which rules are due" scan, across all workspaces.
CREATE INDEX idx_alert_rules_due ON alert_rules(active, last_evaluated_at);

-- ---------------------------------------------------------------------------
-- events: read-path indexes for the alert evaluator and alert history.
-- ---------------------------------------------------------------------------
-- No column of the append-only events table changes here (it cannot — see the
-- spine guards in 0004/0006); these are read paths only.
--
-- The `events` metric counts rows by ingested_at, the server-assigned
-- ingestion clock: occurred_at is preserved exactly as observed and may carry
-- any UTC offset, so it is never compared as a temporal range in SQL.
CREATE INDEX idx_events_workspace_ingested ON events(workspace_id, ingested_at);

-- Alert history is a partial index: it covers only the handful of alert.fired
-- rows in a workspace, so reading one rule's history never scans the spine.
CREATE INDEX idx_events_alert_fired ON events(workspace_id, seq)
    WHERE kind = 'alert.fired';

-- ---------------------------------------------------------------------------
-- Rule invariants, enforced in-schema.
-- ---------------------------------------------------------------------------

-- A rule's DEFINITION is its identity: every alert.fired event in the spine
-- names a rule_id and reports the threshold it breached. If the definition
-- could be edited in place, history would silently start describing a rule
-- that no longer exists. Editing is therefore not an operation — an operator
-- disables a rule and creates a new one. Only the bookkeeping columns
-- (active, last_evaluated_at, last_fired_at, breach_state) may change.
CREATE TRIGGER alert_rules_definition_is_immutable
BEFORE UPDATE ON alert_rules
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.name IS NOT OLD.name
  OR NEW.metric IS NOT OLD.metric
  OR NEW.window_minutes IS NOT OLD.window_minutes
  OR NEW.comparator IS NOT OLD.comparator
  OR NEW.threshold IS NOT OLD.threshold
  OR NEW.workstream_id IS NOT OLD.workstream_id
  OR NEW.channels IS NOT OLD.channels
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'alert rule definition is immutable');
END;

-- Disabling is terminal, matching the API surface (there is a /disable route
-- and no /enable route). Resuming alerting means creating a rule, which gives
-- the resumed alerting its own identity in history.
CREATE TRIGGER alert_rules_disable_is_terminal
BEFORE UPDATE OF active ON alert_rules
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
    SELECT RAISE(ABORT, 'alert rule disable is terminal');
END;

-- Evaluation bookkeeping only ever moves forward. A regression would let the
-- sweep re-fire an already-delivered window, so it fails closed here rather
-- than depending on the evaluator being correct.
CREATE TRIGGER alert_rules_monotone_evaluation
BEFORE UPDATE ON alert_rules
WHEN (OLD.last_evaluated_at IS NOT NULL AND
      (NEW.last_evaluated_at IS NULL OR NEW.last_evaluated_at < OLD.last_evaluated_at))
  OR (OLD.last_fired_at IS NOT NULL AND
      (NEW.last_fired_at IS NULL OR NEW.last_fired_at < OLD.last_fired_at))
BEGIN
    SELECT RAISE(ABORT, 'alert rule evaluation bookkeeping regressed');
END;
