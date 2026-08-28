// Hosted evals (parity row 29): deterministic evaluators + an LLM judge over
// the hosted span read model, recorded on the append-only event spine.
//
// TWO HALVES, AND THE SPLIT IS THE FEATURE.
//
//   DETERMINISTIC EVALUATORS — the trustworthy half. Code checks over
//     span_observations, the hosted port of the local `handoffgraph verify`
//     detection pack (internal/commands/verify_cmd.go): traces_closed,
//     commands_ok, tests_pass, tool_error_rate, handoffs_acknowledged. A
//     verdict is a pure function of evidence this platform already observed,
//     so its score.recorded event carries provenance OBSERVED and
//     source 'evaluation'. Nothing about it is a model's opinion.
//
//   LLM JUDGE — the INFERRED half. A model's grade of a trace, reached over
//     the workspace's OWN upstream credential (BYO key, sealed at rest). A
//     model's opinion is NEVER an observation: its score.recorded event
//     carries provenance INFERRED and source 'llm_judge', on every path, with
//     no branch anywhere in this module that can produce anything else. That
//     invariant is the one the whole product stakes its name on, and it is
//     asserted directly on the stored rows in platform/test/evals.test.ts.
//
// WIRE PARITY. Both halves append `score.recorded` events whose payload is the
// canonical Go score payload (internal/scores.payload:
// {name, data_type, value, target_type, target_id, source, comment}) plus a
// few deterministic eval-identity keys. Go's json.Unmarshal ignores unknown
// fields and so does src/quality.ts's materializer, so the same event reads
// correctly through GET /v1/scores hosted AND through the local Go reducer.
//
// CONTENT DISCIPLINE. The judge is handed a SUMMARY of a trace — span kinds,
// statuses, counts and timings — never captured payloads. That is not a
// policy bolted on top: span_observations stores no prompts, completions,
// diffs or command output in the first place, so there is nothing here to
// leak. `include_bodies` on a judge config widens the summary to the only
// content-ish columns the read model does hold (span names and tool names),
// and is off unless the workspace turned it on. The judge's rationale is
// hashed, never stored. See docs/hosted-evals.md.
//
// REPLAY DETERMINISM. `events` is append-only and migration 0003's
// events_reject_payload_conflict trigger ABORTS any insert reusing an id for
// different bytes, so every event id here is a pure function of its inputs and
// every payload is wall-clock-free:
//
//   check verdict   id = f(config id, trace id, check name), timed at the
//                   TRACE's end. Re-running the same config over the same
//                   trace produces byte-identical bytes, so INSERT OR IGNORE
//                   absorbs it and a re-run appends ZERO new events.
//   judge verdict   id = f(config id, trace id, RUN id). A model's grade is
//                   per-judgement evidence, not a function of the trace, so it
//                   is keyed on the run that produced it. A resumed run
//                   replays the same id with the same bytes; a NEW run
//                   appends a NEW, separately-identified INFERRED verdict.
//
// DURABILITY. With the optional EVAL_WORKFLOW binding, each trace is evaluated
// inside step.do('trace-<id>'), so an instance killed mid-run resumes at the
// next trace and never re-bills the judged ones. Without it, the run executes
// inline under a wall-clock deadline. Correctness never depends on which path
// ran: the deterministic ids make both idempotent.
//
// Design provenance: ideas only. "LLM-as-judge plus scheduled/online
// evaluators" is the shape the category has converged on; no code or
// configuration from any AGPL/ELv2 project is used here. What is ours is that
// a verdict lands on the same spine as captured evidence, labelled.

import { monotonicFactory } from "ulid";

import {
  authenticate,
  hasCapability,
  sha256Hex,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  compareDecimalStrings,
  isDecimalString,
  sealUpstreamKey,
  unsealUpstreamKey,
  validateUpstreamBaseUrl,
  type FetchLike,
} from "./gateway";
import {
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
  scopeDenial,
} from "./ingest";
import { deterministicID } from "./otlp";

export type { FetchLike } from "./gateway";

// -- ids ---------------------------------------------------------------------

const nextULID = monotonicFactory();

const CONFIG_PREFIX = "evc_";
const RUN_PREFIX = "evr_";
const EVENT_PREFIX = "evt_";

const CONFIGS_PATH = "/v1/evals";
const RUN_PATH_PATTERN = /^\/v1\/evals\/(evc_[0-7][0-9A-HJKMNP-TV-Z]{25})\/run$/;
const RUNS_PATH_PATTERN = /^\/v1\/evals\/(evc_[0-7][0-9A-HJKMNP-TV-Z]{25})\/runs$/;
const DISABLE_PATH_PATTERN = /^\/v1\/evals\/(evc_[0-7][0-9A-HJKMNP-TV-Z]{25})\/disable$/;

function newConfigID(): string {
  return `${CONFIG_PREFIX}${nextULID()}`;
}

function newRunID(): string {
  return `${RUN_PREFIX}${nextULID()}`;
}

/**
 * The id of a deterministic check's verdict for (config, trace, check).
 *
 * Deliberately NOT keyed on the run: the verdict is a pure function of
 * observed spans, so two runs of the same config over the same trace assert
 * the same thing and must land on the same row rather than duplicating
 * history. The ULID time component is the TRACE's end instant — also observed,
 * also wall-clock-free.
 */
export function checkScoreEventID(
  configId: string,
  traceId: string,
  check: string,
  traceEndMs: number,
): Promise<string> {
  return deterministicID(EVENT_PREFIX, `eval|check|${configId}|${traceId}|${check}`, traceEndMs);
}

/**
 * The id of an LLM-judge verdict for (config, trace, run).
 *
 * Keyed on the RUN because a model's grade is not a function of the trace: two
 * runs may legitimately disagree, and each disagreement is its own piece of
 * INFERRED evidence. A resumed run replays the same id with the same bytes.
 */
export function judgeScoreEventID(
  configId: string,
  traceId: string,
  runId: string,
  traceEndMs: number,
): Promise<string> {
  return deterministicID(
    EVENT_PREFIX,
    `eval|judge|${configId}|${traceId}|${runId}`,
    traceEndMs,
  );
}

// -- structural Cloudflare bindings ------------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests and the real Workflow binding satisfies these shapes structurally at
// the index.ts boundary. Nothing here imports `cloudflare:workers`, so the
// module loads in a plain node test runner with no miniflare.

/** The one member of a Workflows `step` this module uses. */
export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** The one member of a `WorkflowInstance` this module reads. */
export interface WorkflowInstanceLike {
  id: string;
}

/** The one member of a Workflows binding this module calls. */
export interface EvalWorkflowLike {
  create(options?: { id?: string; params?: EvalRunParams }): Promise<WorkflowInstanceLike>;
}

export interface EvalWorkflowEvent {
  payload: EvalRunParams;
}

export interface EvalsEnv {
  DB: D1DatabaseLike;
  /**
   * Optional durable-execution binding (wrangler.toml keeps the [[workflows]]
   * block commented until the Workflow is provisioned). Absent, runs execute
   * inline under a wall-clock deadline; the evidence is identical either way.
   */
  EVAL_WORKFLOW?: EvalWorkflowLike;
  /**
   * AES-GCM sealing key for judge credentials (`wrangler secret put
   * EVAL_SEALING_KEY`). A judge config cannot be created and a judging run
   * cannot start while it is unset: both fail closed with 503 rather than
   * storing or using a provider key in the clear. Deterministic-only configs
   * never touch it.
   */
  EVAL_SEALING_KEY?: string;
}

// -- tunables ----------------------------------------------------------------

/**
 * Per-run trace ceiling, mirrored in-schema by migration 0012's
 * `traces_evaluated BETWEEN 0 AND 200`. A run is a bounded evaluation of a
 * window, not a workspace sweep: the bound caps D1 scan size, caps upstream
 * spend when a judge is attached, and makes the inline path finishable.
 */
export const MAX_TRACES_PER_RUN = 200;

/** Upstream subrequest deadline; a timeout is treated exactly like a 5xx. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Wall-clock ceiling for the inline (no-Workflow) path, checked BEFORE each
 * trace so a long run stops cleanly at a trace boundary rather than mid-call.
 * Under EVAL_WORKFLOW there is no deadline: each trace is its own durable step.
 */
export const INLINE_DEADLINE_MS = 25_000;

/** Window bounds, mirrored in-schema by migration 0012's target_filter CHECK. */
export const MIN_SINCE_MINUTES = 1;
export const MAX_SINCE_MINUTES = 10_080; // 7 days
export const DEFAULT_SINCE_MINUTES = 60;

export const MAX_CONFIG_NAME_CHARS = 200;
export const MAX_MODEL_NAME_CHARS = 200;
export const MAX_PROMPT_TEMPLATE_CHARS = 8_000;
export const MAX_FILTER_VALUE_CHARS = 128;
const MAX_MANAGEMENT_BODY_BYTES = 32_768;
const MAX_JUDGE_REASON_CHARS = 500;
/** Span rows read per trace when a judge config opts into span names. */
const MAX_JUDGE_SPAN_ROWS = 60;
/** Handoff events read per run for the handoffs_acknowledged check. */
const MAX_HANDOFF_EVENT_ROWS = 5_000;
/** Configs a single cron tick will start. */
export const EVAL_SWEEP_CONFIG_LIMIT = 10;

/**
 * The tool-error-rate threshold, as an exact decimal STRING. A check whose
 * verdict flipped on a float comparison would be exactly the defect the
 * decimal-string convention exists to prevent, so the comparison below is
 * integer cross-multiplication and never division.
 *
 * It is a module constant rather than config because migration 0012's `checks`
 * column is an array of NAMES; making it per-config is a one-field schema
 * change, and until there is a second opinion about the right number a single
 * documented default beats an unset knob.
 */
export const TOOL_ERROR_RATE_THRESHOLD = "0.10";

export const EVENT_KIND_SCORE = "score.recorded";
const EVENT_SCHEMA_VERSION = "hfg.event.v1";
const EVENT_PROVIDER = "evaluation";

/** Score sources (internal/protocol.ScoreSource). */
export const SOURCE_DETERMINISTIC = "evaluation";
export const SOURCE_JUDGE = "llm_judge";

/**
 * Boolean verdict encoding for deterministic checks. See the caveat in
 * docs/hosted-evals.md: Go's scores.fromEvent maps "true"/"false" onto
 * Score.BoolValue, so these two constants are the single place to change if
 * the wire encoding is ever aligned with that reducer.
 */
export const CHECK_PASS_VALUE = "1";
export const CHECK_FAIL_VALUE = "0";

export type CheckName =
  | "commands_ok"
  | "handoffs_acknowledged"
  | "tests_pass"
  | "tool_error_rate"
  | "traces_closed";

/** The known deterministic check set, sorted (storage order is deterministic). */
export const KNOWN_CHECKS: readonly CheckName[] = Object.freeze([
  "commands_ok",
  "handoffs_acknowledged",
  "tests_pass",
  "tool_error_rate",
  "traces_closed",
] as const);

/** Span kinds that count as tool invocations for tool_error_rate. */
const TOOL_KINDS = "'TOOL', 'MCP_CLIENT', 'MCP_SERVER'";

export type RunStatus = "running" | "done" | "error";
export type TriggerKind = "cron" | "manual";

/**
 * Content-free stage tokens recorded in eval_runs.error_detail. Constrained by
 * the schema to lowercase letters and underscores precisely so no provider
 * message, prompt or model reply can ever be written into that column.
 */
export type ErrorDetail =
  | "config_missing"
  | "config_unreadable"
  | "deadline_exceeded"
  | "judge_key_unusable"
  | "judge_unavailable"
  | "judge_unparseable"
  | "sealing_key_unavailable"
  | "too_many_targets";

// -- responses ---------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Content-free structured logging: never a prompt, verdict, name or bind. */
function logEvalFailure(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    message: "evals failure",
    stage,
    error_type: error instanceof Error ? error.name : "unknown",
  }));
}

// -- device lookup (mirrors index.ts's adapter) ------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* evals:device-by-token */
  SELECT id, workspace_id, token_hash, capabilities, revoked_at
  FROM devices
  WHERE token_hash = ?1`;

function deviceLookup(db: D1DatabaseLike): DeviceLookup {
  return {
    async byTokenHash(hash) {
      const record = await db.prepare(DEVICE_BY_TOKEN_SQL).bind(hash).first<DeviceRecord>();
      if (record === null) return null;
      const binding: DeviceBinding = {
        deviceId: record.id,
        workspaceId: record.workspace_id,
        tokenHash: record.token_hash,
        capabilities:
          record.capabilities === null
            ? []
            : record.capabilities.split(",").map((c) => c.trim()).filter((c) => c.length > 0),
        revokedAt: record.revoked_at,
      };
      return binding;
    },
  };
}

async function authorize(
  request: Request,
  env: EvalsEnv,
  capability: string,
): Promise<{ device: DeviceBinding } | { response: Response }> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, capability),
  });
  if (denial !== null) return { response: json(denial.status, { error: denial.error }) };
  return { device: auth.device };
}

// -- rows --------------------------------------------------------------------

export interface EvalConfigRow {
  id: string;
  workspace_id: string;
  name: string;
  active: number;
  trigger: string;
  target_filter: string;
  checks: string;
  judge: string | null;
  created_at: number;
  last_run_at: number | null;
}

export interface EvalRunRow {
  id: string;
  workspace_id: string;
  config_id: string;
  status: string;
  traces_evaluated: number;
  scores_recorded: number;
  started_at: number;
  completed_at: number | null;
  error_detail: string | null;
}

// `trigger` is a SQLite keyword; it is quoted everywhere it is named.
const CONFIG_COLUMNS = `
    id, workspace_id, name, active, "trigger", target_filter, checks, judge,
    created_at, last_run_at`;

const RUN_COLUMNS = `
    id, workspace_id, config_id, status, traces_evaluated, scores_recorded,
    started_at, completed_at, error_detail`;

const INSERT_CONFIG_SQL = `
  /* evals:insert-config */
  INSERT INTO eval_configs
    (id, workspace_id, name, active, "trigger", target_filter, checks, judge, created_at)
  VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)`;

const CONFIG_BY_ID_SQL = `
  /* evals:config-by-id */
  SELECT${CONFIG_COLUMNS}
  FROM eval_configs
  WHERE id = ?1 AND workspace_id = ?2`;

const LIST_CONFIGS_SQL = `
  /* evals:list-configs */
  SELECT${CONFIG_COLUMNS}
  FROM eval_configs
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_CONFIGS_AFTER_SQL = `
  /* evals:list-configs-after */
  SELECT${CONFIG_COLUMNS}
  FROM eval_configs
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

const DISABLE_CONFIG_SQL = `
  /* evals:disable-config */
  UPDATE eval_configs
  SET active = 0
  WHERE id = ?1 AND workspace_id = ?2`;

/**
 * last_run_at moves at run START, not completion, so a long or crashed run can
 * never cause the cron sweep to re-enqueue the same config on every tick.
 * Monotone by predicate AND by trigger (migration 0012).
 */
const MARK_CONFIG_RUN_SQL = `
  /* evals:mark-config-run */
  UPDATE eval_configs
  SET last_run_at = ?3
  WHERE id = ?1 AND workspace_id = ?2
    AND (last_run_at IS NULL OR last_run_at < ?3)`;

/**
 * A cron config is due once a full window has elapsed since its last start, so
 * consecutive runs evaluate adjacent windows instead of re-grading the same
 * traces every tick.
 */
const DUE_CONFIGS_SQL = `
  /* evals:due-configs */
  SELECT${CONFIG_COLUMNS}
  FROM eval_configs
  WHERE active = 1
    AND "trigger" = 'cron'
    AND (last_run_at IS NULL
         OR ?1 - last_run_at >= json_extract(target_filter, '$.since_minutes') * 60)
  ORDER BY workspace_id ASC, id ASC
  LIMIT ?2`;

const INSERT_RUN_SQL = `
  /* evals:insert-run */
  INSERT INTO eval_runs
    (id, workspace_id, config_id, status, traces_evaluated, scores_recorded, started_at)
  VALUES (?1, ?2, ?3, 'running', 0, 0, ?4)`;

const RUN_BY_ID_SQL = `
  /* evals:run-by-id */
  SELECT${RUN_COLUMNS}
  FROM eval_runs
  WHERE id = ?1 AND workspace_id = ?2`;

const LIST_RUNS_SQL = `
  /* evals:list-runs */
  SELECT${RUN_COLUMNS}
  FROM eval_runs
  WHERE workspace_id = ?1 AND config_id = ?2
  ORDER BY started_at DESC, id DESC
  LIMIT ?3`;

const LIST_RUNS_AFTER_SQL = `
  /* evals:list-runs-after */
  SELECT${RUN_COLUMNS}
  FROM eval_runs
  WHERE workspace_id = ?1 AND config_id = ?2
    AND (started_at < ?3 OR (started_at = ?3 AND id < ?4))
  ORDER BY started_at DESC, id DESC
  LIMIT ?5`;

/** MAX() by construction, so this can never trip the monotone-progress trigger. */
const ADVANCE_PROGRESS_SQL = `
  /* evals:advance-progress */
  UPDATE eval_runs
  SET traces_evaluated = MAX(traces_evaluated, ?3),
      scores_recorded = MAX(scores_recorded, ?4)
  WHERE id = ?1 AND workspace_id = ?2`;

/**
 * Settling is guarded on `completed_at IS NULL`, so a replayed or resumed
 * completion is a no-op rather than a second, differently-timed outcome.
 */
const SETTLE_DONE_SQL = `
  /* evals:settle-done */
  UPDATE eval_runs
  SET status = 'done', traces_evaluated = MAX(traces_evaluated, ?3),
      scores_recorded = MAX(scores_recorded, ?4), completed_at = ?5
  WHERE id = ?1 AND workspace_id = ?2 AND completed_at IS NULL`;

const SETTLE_ERROR_SQL = `
  /* evals:settle-error */
  UPDATE eval_runs
  SET status = 'error', traces_evaluated = MAX(traces_evaluated, ?3),
      scores_recorded = MAX(scores_recorded, ?4), completed_at = ?5,
      error_detail = ?6
  WHERE id = ?1 AND workspace_id = ?2 AND completed_at IS NULL`;

const INSERT_SCORE_EVENT_SQL = `
  /* evals:append-score */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10)`;

/**
 * Candidate traces in the window.
 *
 * The optional filters are expressed as `(?N IS NULL OR col = ?N)` so the
 * statement stays ONE module const with fixed binds rather than four
 * hand-assembled variants. The primary prune — ts_bucket, the 30-minute
 * bucket column migration 0005 stores exactly for this — is always exact and
 * always applies, so the cost of the unused equality is a filter over an
 * already-pruned range rather than a scan.
 *
 * `kind` selects which traces are IN SCOPE (a trace qualifies when it has at
 * least one span of that kind); the checks below then evaluate over ALL of
 * that trace's spans in the window, because "did every command succeed" is a
 * question about the trace, not about the filtered subset.
 */
const TARGET_TRACES_SQL = `
  /* evals:target-traces */
  SELECT DISTINCT trace_id
  FROM span_observations
  WHERE workspace_id = ?1
    AND ts_bucket >= ?2
    AND started_at_ns >= CAST(?3 AS INTEGER)
    AND (?4 IS NULL OR workstream_id = ?4)
    AND (?5 IS NULL OR kind = ?5)
  ORDER BY trace_id
  LIMIT ?6`;

/**
 * Every aggregate the five checks need, for the whole candidate set, in one
 * statement. json_each expands the bounded candidate array inside D1 (the
 * platform's bulk-bind convention); a statement per trace would blow the
 * per-invocation query budget at the 200-trace ceiling.
 *
 * started_at_ns/ended_at_ns are int64 UNIX NANOSECONDS beyond the JavaScript
 * safe-integer range, so the bounds are CAST to TEXT here and parsed as BigInt
 * in the Worker. They are never round-tripped through a float.
 */
const TRACE_AGGREGATES_SQL = `
  /* evals:trace-aggregates */
  SELECT
    o.trace_id AS trace_id,
    MIN(o.workstream_id) AS workstream_id,
    COUNT(*) AS span_count,
    SUM(CASE WHEN o.ended_at_ns IS NULL OR o.status = 'running' THEN 1 ELSE 0 END) AS open_spans,
    SUM(CASE WHEN o.status = 'error' THEN 1 ELSE 0 END) AS error_spans,
    SUM(CASE WHEN o.kind = 'COMMAND' THEN 1 ELSE 0 END) AS command_total,
    SUM(CASE WHEN o.kind = 'COMMAND' AND o.status = 'error' THEN 1 ELSE 0 END) AS command_failed,
    SUM(CASE WHEN o.kind = 'TEST' THEN 1 ELSE 0 END) AS test_total,
    SUM(CASE WHEN o.kind = 'TEST' AND o.status = 'error' THEN 1 ELSE 0 END) AS test_failed,
    SUM(CASE WHEN o.kind IN (${TOOL_KINDS}) THEN 1 ELSE 0 END) AS tool_total,
    SUM(CASE WHEN o.kind IN (${TOOL_KINDS}) AND o.status = 'error' THEN 1 ELSE 0 END)
      AS tool_failed,
    CAST(MIN(o.started_at_ns) AS TEXT) AS first_ns,
    CAST(MAX(COALESCE(o.ended_at_ns, o.started_at_ns)) AS TEXT) AS last_ns
  FROM span_observations AS o
  JOIN json_each(?2) AS target ON target.value = o.trace_id
  WHERE o.workspace_id = ?1
  GROUP BY o.trace_id
  ORDER BY o.trace_id`;

/** Span shapes for a judge config that opted into names (see include_bodies). */
const TRACE_SPAN_ROWS_SQL = `
  /* evals:trace-span-rows */
  SELECT kind, name, status, tool_name, duration_ms
  FROM span_observations
  WHERE workspace_id = ?1 AND trace_id = ?2
  ORDER BY started_at_ns ASC, span_id ASC
  LIMIT ?3`;

/**
 * Handoff evidence for handoffs_acknowledged, matching migration 0012's
 * partial index exactly (kind predicate + key order), so this is an index
 * prune over a small slice and never a spine scan.
 *
 * The `occurred_at >= ?2` bound is a COARSE prune only: occurred_at is
 * client-supplied RFC3339 that may carry a numeric offset, and a lexical
 * compare across mixed offsets is not a time compare. The bound is therefore
 * slackened by a full offset range in the caller and the exact window test is
 * re-applied in the Worker with Date.parse.
 */
const HANDOFF_EVENTS_SQL = `
  /* evals:handoff-events */
  SELECT workstream_id, kind, occurred_at
  FROM events
  WHERE workspace_id = ?1
    AND kind IN ('handoff.created', 'handoff.accepted')
    AND workstream_id IS NOT NULL
    AND occurred_at >= ?2
  ORDER BY workspace_id ASC, workstream_id ASC, occurred_at ASC
  LIMIT ?3`;

/** RFC3339 offsets span ±14h; slacken the lexical prune by more than that. */
const HANDOFF_PRUNE_SLACK_SECONDS = 15 * 3600;

// -- validation --------------------------------------------------------------

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : null;
}

export interface TargetFilter {
  workstream: string | null;
  kind: string | null;
  since_minutes: number;
}

export interface JudgeConfig {
  model: string;
  base_url: string;
  prompt_template: string;
  api_key_ciphertext: string;
  include_bodies: boolean;
}

export interface CreateConfigInput {
  name: string;
  trigger: TriggerKind;
  checks: CheckName[];
  target: TargetFilter;
  /** Present only when the caller asked for a judge; the key is still raw here. */
  judge: { model: string; base_url: string; prompt_template: string; api_key: string;
           include_bodies: boolean } | null;
}

/**
 * Validate a create-config body.
 *
 * Checks are validated against the KNOWN set, deduplicated, and SORTED before
 * storage — the config document is part of every verdict's identity, so its
 * bytes must be a function of what was asked for and not of key order in the
 * request. The judge's base URL goes through the gateway's own
 * https-and-not-obviously-internal guard, and its template must actually have
 * somewhere to put the trace summary.
 */
export function validateCreateConfigBody(
  body: Record<string, unknown>,
): { ok: true; value: CreateConfigInput } | { ok: false; error: string } {
  const name = boundedText(body.name, MAX_CONFIG_NAME_CHARS);
  if (name === null) {
    return { ok: false, error: `name must be a string of 1..${MAX_CONFIG_NAME_CHARS} characters` };
  }

  const trigger = body.trigger;
  if (trigger !== "cron" && trigger !== "manual") {
    return { ok: false, error: "trigger must be 'cron' or 'manual'" };
  }

  const rawChecks = body.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return { ok: false, error: "checks must be a non-empty array of check names" };
  }
  const selected = new Set<CheckName>();
  for (const entry of rawChecks) {
    if (typeof entry !== "string" || !isKnownCheck(entry)) {
      return {
        ok: false,
        error: `checks must name only known checks (${KNOWN_CHECKS.join(", ")})`,
      };
    }
    selected.add(entry);
  }
  const checks = KNOWN_CHECKS.filter((check) => selected.has(check));

  const targetRaw = body.target;
  if (targetRaw !== undefined && (targetRaw === null || typeof targetRaw !== "object" ||
      Array.isArray(targetRaw))) {
    return { ok: false, error: "target must be an object" };
  }
  const target = (targetRaw ?? {}) as Record<string, unknown>;

  let sinceMinutes = DEFAULT_SINCE_MINUTES;
  if (target.since_minutes !== undefined) {
    const raw = target.since_minutes;
    if (
      !Number.isSafeInteger(raw) ||
      (raw as number) < MIN_SINCE_MINUTES ||
      (raw as number) > MAX_SINCE_MINUTES
    ) {
      return {
        ok: false,
        error: `target.since_minutes must be an integer between ${MIN_SINCE_MINUTES} and ${MAX_SINCE_MINUTES}`,
      };
    }
    sinceMinutes = raw as number;
  }

  let workstream: string | null = null;
  if (target.workstream !== undefined && target.workstream !== null) {
    workstream = boundedText(target.workstream, MAX_FILTER_VALUE_CHARS);
    if (workstream === null) {
      return {
        ok: false,
        error: `target.workstream must be a string of 1..${MAX_FILTER_VALUE_CHARS} characters`,
      };
    }
  }

  let kind: string | null = null;
  if (target.kind !== undefined && target.kind !== null) {
    kind = boundedText(target.kind, MAX_FILTER_VALUE_CHARS);
    if (kind === null) {
      return {
        ok: false,
        error: `target.kind must be a string of 1..${MAX_FILTER_VALUE_CHARS} characters`,
      };
    }
  }

  const judgeRaw = body.judge;
  if (judgeRaw === undefined || judgeRaw === null) {
    return {
      ok: true,
      value: { name, trigger, checks, target: { workstream, kind, since_minutes: sinceMinutes },
               judge: null },
    };
  }
  if (typeof judgeRaw !== "object" || Array.isArray(judgeRaw)) {
    return { ok: false, error: "judge must be an object" };
  }
  const judgeBody = judgeRaw as Record<string, unknown>;

  const model = boundedText(judgeBody.model, MAX_MODEL_NAME_CHARS);
  if (model === null) {
    return {
      ok: false,
      error: `judge.model must be a string of 1..${MAX_MODEL_NAME_CHARS} characters`,
    };
  }
  const baseUrl = validateUpstreamBaseUrl(judgeBody.base_url);
  if (baseUrl === null) return { ok: false, error: "judge.base_url must be a public https:// URL" };

  const template = boundedText(judgeBody.prompt_template, MAX_PROMPT_TEMPLATE_CHARS);
  if (template === null) {
    return {
      ok: false,
      error: `judge.prompt_template must be a string of 1..${MAX_PROMPT_TEMPLATE_CHARS} characters`,
    };
  }
  if (!template.includes(JUDGE_INPUT_PLACEHOLDER)) {
    return {
      ok: false,
      error: `judge.prompt_template must contain ${JUDGE_INPUT_PLACEHOLDER}`,
    };
  }

  const apiKey = judgeBody.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 512) {
    return {
      ok: false,
      error: "judge.api_key must be a non-empty string of at most 512 characters",
    };
  }

  const includeBodiesRaw = judgeBody.include_bodies;
  if (includeBodiesRaw !== undefined && typeof includeBodiesRaw !== "boolean") {
    return { ok: false, error: "judge.include_bodies must be a boolean" };
  }

  return {
    ok: true,
    value: {
      name,
      trigger,
      checks,
      target: { workstream, kind, since_minutes: sinceMinutes },
      judge: {
        model,
        base_url: baseUrl,
        prompt_template: template,
        api_key: apiKey,
        include_bodies: includeBodiesRaw === true,
      },
    },
  };
}

function isKnownCheck(value: string): value is CheckName {
  return (KNOWN_CHECKS as readonly string[]).includes(value);
}

/** Parse a stored target_filter column; null when the stored JSON is unusable. */
export function parseTargetFilter(stored: string): TargetFilter | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const since = record.since_minutes;
  if (
    !Number.isSafeInteger(since) ||
    (since as number) < MIN_SINCE_MINUTES ||
    (since as number) > MAX_SINCE_MINUTES
  ) {
    return null;
  }
  return {
    workstream: typeof record.workstream === "string" ? record.workstream : null,
    kind: typeof record.kind === "string" ? record.kind : null,
    since_minutes: since as number,
  };
}

/** Parse a stored checks column, dropping anything no longer known. */
export function parseChecks(stored: string): CheckName[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const selected = new Set<CheckName>();
  for (const entry of parsed) {
    if (typeof entry === "string" && isKnownCheck(entry)) selected.add(entry);
  }
  const checks = KNOWN_CHECKS.filter((check) => selected.has(check));
  return checks.length === 0 ? null : checks;
}

/** Parse a stored judge column; null for a deterministic-only config. */
export function parseJudge(stored: string | null): JudgeConfig | null {
  if (stored === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model : null;
  const baseUrl = typeof record.base_url === "string" ? record.base_url : null;
  const template = typeof record.prompt_template === "string" ? record.prompt_template : null;
  const ciphertext =
    typeof record.api_key_ciphertext === "string" ? record.api_key_ciphertext : null;
  if (model === null || baseUrl === null || template === null || ciphertext === null) return null;
  if (!template.includes(JUDGE_INPUT_PLACEHOLDER)) return null;
  return {
    model,
    base_url: baseUrl,
    prompt_template: template,
    api_key_ciphertext: ciphertext,
    include_bodies: record.include_bodies === true,
  };
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_MANAGEMENT_BODY_BYTES);
  if (!body.ok) return null;
  try {
    const value: unknown = JSON.parse(body.text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// -- deterministic evaluators ------------------------------------------------

export interface TraceAggregate {
  trace_id: string;
  workstream_id: string | null;
  span_count: number;
  open_spans: number;
  error_spans: number;
  command_total: number;
  command_failed: number;
  test_total: number;
  test_failed: number;
  tool_total: number;
  tool_failed: number;
  /** int64 unix nanoseconds as a decimal string (never a float). */
  first_ns: string;
  last_ns: string;
}

export interface HandoffCounts {
  created: number;
  accepted: number;
}

export interface CheckVerdict {
  check: CheckName;
  passed: boolean;
  /** Deterministic, content-free detail (mirrors Go's verify Check.Detail). */
  detail: string;
}

/**
 * Exact decimal ratio, computed with BigInt and a fixed scale. Never a float:
 * a rate that a reviewer will argue about must not depend on IEEE rounding.
 */
export function ratioDecimal(numerator: number, denominator: number, scale: number): string {
  if (denominator <= 0) return "0";
  const factor = 10n ** BigInt(scale);
  const scaled = (BigInt(numerator) * factor) / BigInt(denominator);
  const whole = scaled / factor;
  const fraction = (scaled % factor).toString().padStart(scale, "0");
  return scale === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Is `failed/total` strictly below the threshold?
 *
 * Cross-multiplied with BigInt against the threshold's exact decimal parts, so
 * the comparison is integer arithmetic end to end — no division, no float, no
 * "0.1 + 0.2" class of surprise on a verdict that gates a workstream.
 */
export function belowRateThreshold(failed: number, total: number, threshold: string): boolean {
  if (total <= 0) return true;
  const dot = threshold.indexOf(".");
  const digits = dot < 0 ? threshold : threshold.slice(0, dot) + threshold.slice(dot + 1);
  const scale = dot < 0 ? 0 : threshold.length - dot - 1;
  const thresholdNumerator = BigInt(digits);
  const thresholdDenominator = 10n ** BigInt(scale);
  return BigInt(failed) * thresholdDenominator < thresholdNumerator * BigInt(total);
}

/**
 * One deterministic check's verdict for one trace.
 *
 * Semantics are ported from the local pack (internal/commands/verify_cmd.go
 * runVerifyChecks) onto the hosted read model:
 *
 *   traces_closed          no span of the trace is still open (span.started
 *                          with no completion, or status 'running'). The local
 *                          check counts running TRACES; hosted, an unclosed
 *                          span is the same evidence at finer grain.
 *   commands_ok            no COMMAND span ended in error (a non-zero exit is
 *                          promoted to status 'error' by the projection).
 *   tests_pass             no TEST span ended in error.
 *   tool_error_rate        the tool-span error rate is strictly below the
 *                          threshold. Has no local counterpart; it is the
 *                          rate-shaped check the hosted read model makes cheap.
 *   handoffs_acknowledged  a handoff created in the window was accepted. The
 *                          local check counts events per workstream; hosted,
 *                          the trace inherits ITS workstream's counts, and a
 *                          trace with no workstream has no handoff obligation.
 */
export function evaluateCheck(
  check: CheckName,
  aggregate: TraceAggregate,
  handoffs: HandoffCounts,
): CheckVerdict {
  switch (check) {
    case "traces_closed":
      return {
        check,
        passed: aggregate.open_spans === 0,
        detail: `${aggregate.open_spans} unclosed span(s) of ${aggregate.span_count}`,
      };
    case "commands_ok":
      return {
        check,
        passed: aggregate.command_failed === 0,
        detail: `${aggregate.command_failed}/${aggregate.command_total} failed`,
      };
    case "tests_pass":
      return {
        check,
        passed: aggregate.test_failed === 0,
        detail: `${aggregate.test_total - aggregate.test_failed} passed, ${aggregate.test_failed} failed`,
      };
    case "tool_error_rate": {
      const rate = ratioDecimal(aggregate.tool_failed, aggregate.tool_total, 4);
      return {
        check,
        passed: belowRateThreshold(
          aggregate.tool_failed,
          aggregate.tool_total,
          TOOL_ERROR_RATE_THRESHOLD,
        ),
        detail: `${aggregate.tool_failed}/${aggregate.tool_total} tool span(s) failed (rate ${rate}, threshold ${TOOL_ERROR_RATE_THRESHOLD})`,
      };
    }
    case "handoffs_acknowledged":
      return {
        check,
        passed: handoffs.created === 0 || handoffs.accepted > 0,
        detail: `${handoffs.created} created, ${handoffs.accepted} accepted`,
      };
  }
}

/** Milliseconds of a decimal-string nanosecond bound; 0 when unreadable. */
export function nanosToMs(ns: string | null): number {
  if (ns === null || !/^\d+$/.test(ns)) return 0;
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return 0;
  }
}

// -- event documents ---------------------------------------------------------

export interface BuiltEvent {
  eventId: string;
  provenance: "OBSERVED" | "INFERRED";
  occurredAt: string;
  workstreamId: string | null;
  contentHash: string;
  rawJson: string;
}

async function contentDigest(text: string): Promise<string> {
  return `sha256:${await sha256Hex(text)}`;
}

async function buildScoreEvent(
  eventId: string,
  occurredAtMs: number,
  workstreamId: string | null,
  provenance: "OBSERVED" | "INFERRED",
  payload: Record<string, unknown>,
): Promise<BuiltEvent> {
  const occurredAt = new Date(occurredAtMs).toISOString();
  const contentHash = await contentDigest(canonicalJsonStringify(payload));
  const document: Record<string, unknown> = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId,
    kind: EVENT_KIND_SCORE,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    provider: EVENT_PROVIDER,
    provenance,
    content_hash: contentHash,
    payload,
  };
  if (workstreamId !== null) document.workstream_id = workstreamId;
  return {
    eventId,
    provenance,
    occurredAt,
    workstreamId,
    contentHash,
    rawJson: canonicalJsonStringify(document),
  };
}

/**
 * A deterministic check's verdict: OBSERVED, because it is a code check over
 * spans this platform recorded. Nothing about it is model-derived, and the
 * `source` field says so in the wire payload too.
 *
 * The payload carries NO run id and NO wall clock, which is what makes a
 * re-run byte-identical and therefore a no-op under INSERT OR IGNORE.
 */
export async function buildCheckScoreEvent(input: {
  configId: string;
  traceId: string;
  workstreamId: string | null;
  verdict: CheckVerdict;
  traceEndMs: number;
}): Promise<BuiltEvent> {
  const payload = {
    check: input.verdict.check,
    comment: input.verdict.detail,
    data_type: "BOOLEAN",
    eval_config_id: input.configId,
    name: `eval.${input.verdict.check}`,
    source: SOURCE_DETERMINISTIC,
    target_id: input.traceId,
    target_type: "trace",
    value: input.verdict.passed ? CHECK_PASS_VALUE : CHECK_FAIL_VALUE,
  };
  const eventId = await checkScoreEventID(
    input.configId,
    input.traceId,
    input.verdict.check,
    input.traceEndMs,
  );
  return await buildScoreEvent(
    eventId,
    input.traceEndMs,
    input.workstreamId,
    "OBSERVED",
    payload,
  );
}

/**
 * An LLM judge's verdict: INFERRED, always, with no branch that can say
 * otherwise. Its headline claim is a model's opinion of a trace; the platform
 * observed that the model said it, not that it is true.
 *
 * The rationale is HASHED rather than stored: hosted storage is content-free,
 * and a holder of the reply can still prove what the judge said.
 */
export async function buildJudgeScoreEvent(input: {
  configId: string;
  configName: string;
  runId: string;
  traceId: string;
  workstreamId: string | null;
  judgeModel: string;
  score: string;
  reason: string;
  traceEndMs: number;
}): Promise<BuiltEvent> {
  const payload = {
    data_type: "NUMERIC",
    eval_config_id: input.configId,
    eval_run_id: input.runId,
    judge_model: input.judgeModel,
    name: `judge.${input.configName}`,
    reason_hash: await contentDigest(input.reason),
    // Field-level echo of the envelope label, so a consumer reading only the
    // payload can never mistake a model's grade for a measurement.
    score_provenance: "INFERRED",
    source: SOURCE_JUDGE,
    target_id: input.traceId,
    target_type: "trace",
    value: input.score,
  };
  const eventId = await judgeScoreEventID(
    input.configId,
    input.traceId,
    input.runId,
    input.traceEndMs,
  );
  return await buildScoreEvent(
    eventId,
    input.traceEndMs,
    input.workstreamId,
    "INFERRED",
    payload,
  );
}

function eventStatement(
  db: D1DatabaseLike,
  workspaceId: string,
  event: BuiltEvent,
  ingestedAt: number,
): D1BoundStatement {
  return db.prepare(INSERT_SCORE_EVENT_SQL).bind(
    workspaceId,
    event.eventId,
    event.occurredAt,
    event.workstreamId,
    EVENT_PROVIDER,
    EVENT_KIND_SCORE,
    event.provenance,
    event.contentHash,
    ingestedAt,
    event.rawJson,
  );
}

/**
 * Append one trace's verdicts in a single batch, then advance the run's
 * progress counters in the same transaction so the row can never claim
 * evidence the spine does not hold.
 *
 * A payload conflict (the same id carrying different bytes — only reachable if
 * the derived span model grew after the first verdict, or a judge answered
 * differently on a genuine re-execution) aborts the whole batch. That must not
 * lose the other verdicts, so the fallback replays the statements one at a
 * time with per-statement isolation. The spine's refusal to let one id mean
 * two things is correct behaviour; the FIRST recorded verdict stands.
 */
async function appendVerdicts(
  env: EvalsEnv,
  workspaceId: string,
  events: BuiltEvent[],
  progress: D1BoundStatement,
  ingestedAt: number,
): Promise<void> {
  const statements = [
    ...events.map((event) => eventStatement(env.DB, workspaceId, event, ingestedAt)),
    progress,
  ];
  try {
    await env.DB.batch(statements);
    return;
  } catch (error) {
    logEvalFailure("append-verdicts", error);
  }
  for (const statement of statements) {
    try {
      await statement.run();
    } catch (retryError) {
      logEvalFailure("append-verdicts-retry", retryError);
    }
  }
}

// -- the LLM judge (the INFERRED half) ---------------------------------------

export const JUDGE_INPUT_PLACEHOLDER = "{{input}}";

export interface JudgeSpanRow {
  kind: string;
  name: string;
  status: string;
  tool_name: string | null;
  duration_ms: number | null;
}

/**
 * The judge's input: a content-free summary of what the trace DID.
 *
 * Content-free is not a filter applied here — span_observations holds no
 * prompts, completions, diffs or command output to begin with, so there is
 * nothing to strip. `spans` is non-null only for a judge config whose
 * workspace set include_bodies, and even then it adds only the span NAMES and
 * tool names the read model does hold. That is the widest this input can ever
 * get; see docs/hosted-evals.md.
 *
 * Deterministic by construction: the same aggregate always renders the same
 * bytes, so a resumed run sends the judge the identical prompt.
 */
export function buildJudgeInput(
  aggregate: TraceAggregate,
  spans: JudgeSpanRow[] | null,
): string {
  const durationMs = nanosToMs(aggregate.last_ns) - nanosToMs(aggregate.first_ns);
  const lines = [
    `trace: ${aggregate.trace_id}`,
    `workstream: ${aggregate.workstream_id ?? "(none)"}`,
    `duration_ms: ${durationMs}`,
    `spans: ${aggregate.span_count} (${aggregate.error_spans} error, ${aggregate.open_spans} unclosed)`,
    `commands: ${aggregate.command_total} (${aggregate.command_failed} failed)`,
    `tests: ${aggregate.test_total} (${aggregate.test_failed} failed)`,
    `tools: ${aggregate.tool_total} (${aggregate.tool_failed} failed)`,
  ];
  if (spans !== null && spans.length > 0) {
    lines.push("span timeline:");
    for (const span of spans) {
      const tool = span.tool_name === null ? "" : ` tool=${span.tool_name}`;
      const duration = span.duration_ms === null ? "" : ` ${span.duration_ms}ms`;
      lines.push(`- ${span.kind} ${span.status}${duration} ${span.name}${tool}`);
    }
  }
  return lines.join("\n");
}

/** Substitute the trace summary into the operator's template. */
export function renderJudgePrompt(template: string, input: string): string {
  return template.split(JUDGE_INPUT_PLACEHOLDER).join(input);
}

export interface JudgeVerdict {
  /** Canonical decimal STRING in [0, 1]. Never a float. */
  score: string;
  reason: string;
}

const FENCE_PATTERN = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Parse the judge's reply. Fail-closed by construction: every path that is not
 * an unambiguous, in-range score returns null, and a null verdict errors the
 * run rather than inventing one. Guessing here would put a fabricated INFERRED
 * score on the spine, which is strictly worse than recording that the judge
 * could not be read.
 *
 * The only tolerance is a single surrounding markdown code fence, because that
 * is a formatting habit rather than an ambiguity. No brace-scanning, no
 * "find the JSON somewhere in the prose".
 */
export function parseJudgeVerdict(content: string): JudgeVerdict | null {
  const trimmed = content.trim();
  const fenced = FENCE_PATTERN.exec(trimmed);
  const source = fenced === null ? trimmed : fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const score = canonicalScore(record.score);
  if (score === null) return null;
  const reason =
    typeof record.reason === "string" ? record.reason.slice(0, MAX_JUDGE_REASON_CHARS) : "";
  return { score, reason };
}

/**
 * A score is money-shaped: an exact decimal STRING bounded to [0, 1]. A JSON
 * number is accepted only when it stringifies to canonical decimal form, so
 * `1e-3` is rejected rather than silently reinterpreted — the same rule
 * gateway.ts applies to provider-reported cost.
 */
export function canonicalScore(raw: unknown): string | null {
  let candidate: string | null = null;
  if (isDecimalString(raw)) {
    candidate = raw;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    const asString = String(raw);
    if (isDecimalString(asString)) candidate = asString;
  }
  if (candidate === null) return null;
  if (compareDecimalStrings(candidate, "0") < 0) return null;
  if (compareDecimalStrings(candidate, "1") > 0) return null;
  return candidate;
}

function upstreamSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
}

export type JudgeCallResult =
  | { ok: true; verdict: JudgeVerdict }
  | { ok: false; reason: "judge_unavailable" | "judge_unparseable" };

/**
 * One OpenAI-compatible chat completion against the workspace's own upstream,
 * parsed fail-closed into a verdict.
 *
 * Identical discipline to gateway.ts's callUpstream: an explicit header
 * allow-list, `redirect: "manual"` so a redirecting upstream cannot become a
 * second unvalidated destination, and a hard subrequest deadline where a
 * timeout is indistinguishable from a 5xx.
 *
 * Never throws: every failure is a typed result, because a thrown fetch inside
 * a durable step would retry the whole trace and re-bill the judged ones.
 */
export async function callJudge(
  fetcher: FetchLike,
  judge: JudgeConfig,
  apiKey: string,
  prompt: string,
): Promise<JudgeCallResult> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    redirect: "manual",
    body: JSON.stringify({
      model: judge.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  };
  const signal = upstreamSignal();
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  let text: string;
  try {
    response = await fetcher(`${judge.base_url}/chat/completions`, init);
    text = await response.text();
  } catch {
    return { ok: false, reason: "judge_unavailable" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "judge_unavailable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "judge_unparseable" };
  }
  const content = extractCompletionContent(parsed);
  if (content === null) return { ok: false, reason: "judge_unparseable" };
  const verdict = parseJudgeVerdict(content);
  if (verdict === null) return { ok: false, reason: "judge_unparseable" };
  return { ok: true, verdict };
}

/** `choices[0].message.content`, or null when the upstream did not send one. */
export function extractCompletionContent(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

// -- target selection --------------------------------------------------------

const NS_PER_SECOND = 1_000_000_000n;
const OBSERVATION_BUCKET_NS = 1_800_000_000_000n;

export interface EvalWindow {
  /** Inclusive lower bound, int64 unix nanoseconds as a decimal string. */
  sinceNs: string;
  /** Bucket prune for the same bound (migration 0005's 30-minute grid). */
  sinceBucket: number;
  /** Coarse RFC3339 lower bound for the handoff prune (offset-slackened). */
  sinceCoarseISO: string;
  /** Exact lower bound in unix milliseconds, for the Worker-side re-filter. */
  sinceMs: number;
}

/**
 * The window a run evaluates, derived from the RUN's stored start instant
 * rather than a wall clock, so a resumed Workflow instance re-derives exactly
 * the same window and therefore exactly the same population.
 */
export function evalWindow(startedAtSeconds: number, sinceMinutes: number): EvalWindow {
  const sinceSeconds = Math.max(0, startedAtSeconds - sinceMinutes * 60);
  const sinceNs = BigInt(sinceSeconds) * NS_PER_SECOND;
  return {
    sinceNs: sinceNs.toString(),
    sinceBucket: Number(sinceNs / OBSERVATION_BUCKET_NS),
    sinceCoarseISO: new Date(
      Math.max(0, sinceSeconds - HANDOFF_PRUNE_SLACK_SECONDS) * 1000,
    ).toISOString(),
    sinceMs: sinceSeconds * 1000,
  };
}

async function selectTargetTraces(
  env: EvalsEnv,
  workspaceId: string,
  filter: TargetFilter,
  window: EvalWindow,
  limit: number,
): Promise<string[]> {
  const result = await env.DB.prepare(TARGET_TRACES_SQL)
    .bind(
      workspaceId,
      window.sinceBucket,
      window.sinceNs,
      filter.workstream,
      filter.kind,
      limit,
    )
    .all<{ trace_id: string }>();
  // Re-sort in the Worker so the population never depends on storage order.
  return [...result.results]
    .map((row) => row.trace_id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

async function loadAggregates(
  env: EvalsEnv,
  workspaceId: string,
  traceIds: string[],
): Promise<TraceAggregate[]> {
  if (traceIds.length === 0) return [];
  const result = await env.DB.prepare(TRACE_AGGREGATES_SQL)
    .bind(workspaceId, canonicalJsonStringify(traceIds))
    .all<TraceAggregate>();
  return [...result.results].sort((a, b) =>
    a.trace_id === b.trace_id ? 0 : a.trace_id < b.trace_id ? -1 : 1,
  );
}

interface HandoffEventRow {
  workstream_id: string;
  kind: string;
  occurred_at: string;
}

/**
 * Per-workstream handoff counts inside the window.
 *
 * The SQL bound is a coarse lexical prune (see HANDOFF_EVENTS_SQL); the exact
 * window test happens here with Date.parse, so an event recorded with a
 * numeric UTC offset is compared as an instant rather than as a string.
 */
export function tallyHandoffs(
  rows: readonly HandoffEventRow[],
  sinceMs: number,
): Map<string, HandoffCounts> {
  const counts = new Map<string, HandoffCounts>();
  for (const row of rows) {
    if (typeof row.workstream_id !== "string" || row.workstream_id.length === 0) continue;
    const at = Date.parse(row.occurred_at);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const entry = counts.get(row.workstream_id) ?? { created: 0, accepted: 0 };
    if (row.kind === "handoff.created") entry.created += 1;
    else if (row.kind === "handoff.accepted") entry.accepted += 1;
    counts.set(row.workstream_id, entry);
  }
  return counts;
}

async function loadHandoffCounts(
  env: EvalsEnv,
  workspaceId: string,
  window: EvalWindow,
): Promise<Map<string, HandoffCounts>> {
  const result = await env.DB.prepare(HANDOFF_EVENTS_SQL)
    .bind(workspaceId, window.sinceCoarseISO, MAX_HANDOFF_EVENT_ROWS)
    .all<HandoffEventRow>();
  return tallyHandoffs(result.results, window.sinceMs);
}

const NO_HANDOFFS: HandoffCounts = Object.freeze({ created: 0, accepted: 0 });

// -- execution ---------------------------------------------------------------

export interface EvalExecution {
  workspaceId: string;
  runId: string;
  /** Absolute wall-clock stop time for the inline path; Infinity under a Workflow. */
  deadlineAtMs: number;
}

/** What one durable step returns, and therefore what a resume replays from. */
export interface TraceOutcome {
  ok: boolean;
  scores: number;
  /** Content-free stage token when the trace could not be judged. */
  failure: ErrorDetail | null;
}

/**
 * Execute a run to settlement. Loads the run and config from D1 first, so a
 * resumed Workflow instance rebuilds its own context instead of trusting
 * anything carried in the instance params.
 *
 * Returns the settled run row, or null when the run does not exist in the
 * workspace.
 *
 * Nothing in here throws on its own — every upstream and D1 failure is a typed
 * result or a swallowed, content-free log. A throw from the STEP RUNNER is
 * deliberately allowed to propagate: under real Workflows that is how the
 * runtime learns an instance died, and swallowing it would turn a resumable
 * crash into a silently truncated evaluation.
 */
export async function executeEvalRun(
  env: EvalsEnv,
  execution: EvalExecution,
  step: WorkflowStepLike,
  fetcher: FetchLike,
  now: () => number = Date.now,
): Promise<EvalRunRow | null> {
  const run = await env.DB.prepare(RUN_BY_ID_SQL)
    .bind(execution.runId, execution.workspaceId)
    .first<EvalRunRow>();
  if (run === null) return null;
  if (run.completed_at !== null) return run;

  const config = await env.DB.prepare(CONFIG_BY_ID_SQL)
    .bind(run.config_id, execution.workspaceId)
    .first<EvalConfigRow>();
  if (config === null) return await settle(env, execution, run, 0, 0, now, "config_missing");

  const filter = parseTargetFilter(config.target_filter);
  const checks = parseChecks(config.checks);
  if (filter === null || checks === null) {
    return await settle(env, execution, run, 0, 0, now, "config_unreadable");
  }
  const judge = config.judge === null ? null : parseJudge(config.judge);
  if (config.judge !== null && judge === null) {
    return await settle(env, execution, run, 0, 0, now, "config_unreadable");
  }

  // Fail closed BEFORE any upstream work: a judging run with no sealing key
  // cannot reach its credential, and must settle rather than sit 'running'.
  let apiKey: string | null = null;
  if (judge !== null) {
    const sealingKey = env.EVAL_SEALING_KEY;
    if (typeof sealingKey !== "string" || sealingKey.length === 0) {
      return await settle(env, execution, run, 0, 0, now, "sealing_key_unavailable");
    }
    try {
      apiKey = await unsealUpstreamKey(judge.api_key_ciphertext, sealingKey);
    } catch (error) {
      logEvalFailure("unseal", error);
      return await settle(env, execution, run, 0, 0, now, "judge_key_unusable");
    }
  }

  const window = evalWindow(run.started_at, filter.since_minutes);
  const traceIds = await selectTargetTraces(
    env,
    execution.workspaceId,
    filter,
    window,
    MAX_TRACES_PER_RUN + 1,
  );
  // Defence in depth: the route refuses an over-wide window with 413 before a
  // run row exists, so reaching this means the population grew under a cron
  // config. Settle rather than silently grading an arbitrary prefix.
  if (traceIds.length > MAX_TRACES_PER_RUN) {
    return await settle(env, execution, run, 0, 0, now, "too_many_targets");
  }

  const aggregates = await loadAggregates(env, execution.workspaceId, traceIds);
  const handoffs = checks.includes("handoffs_acknowledged")
    ? await loadHandoffCounts(env, execution.workspaceId, window)
    : new Map<string, HandoffCounts>();

  let traces = 0;
  let scores = 0;
  let failure: ErrorDetail | null = null;

  for (const aggregate of aggregates) {
    // Checked at the trace boundary so the evidence is always complete up to
    // the last evaluated trace, never truncated mid-append.
    if (now() >= execution.deadlineAtMs) {
      failure = "deadline_exceeded";
      break;
    }
    const outcome = await step.do(`trace-${aggregate.trace_id}`, () =>
      evaluateTrace(env, execution, config, checks, judge, apiKey, aggregate, handoffs, fetcher,
        traces + 1, scores, now),
    );
    traces += 1;
    scores += outcome.scores;
    if (!outcome.ok) {
      // Fail closed: stop calling an upstream that is not answering usefully
      // rather than burning the caller's credential across 200 traces.
      failure = outcome.failure ?? "judge_unavailable";
      break;
    }
  }

  return await settle(env, execution, run, traces, scores, now, failure);
}

/**
 * Evaluate one trace: append every deterministic verdict, then (when the
 * config carries a judge) the INFERRED one. This is the body of
 * `step.do('trace-<id>')`, so everything inside runs at most once per run even
 * across a crash.
 *
 * The deterministic verdicts are appended even when the judge subsequently
 * fails. They are OBSERVED facts about recorded spans and do not become less
 * true because a model was unreachable — and the run still settles as `error`,
 * so nothing reports a judged result that never happened.
 */
async function evaluateTrace(
  env: EvalsEnv,
  execution: EvalExecution,
  config: EvalConfigRow,
  checks: readonly CheckName[],
  judge: JudgeConfig | null,
  apiKey: string | null,
  aggregate: TraceAggregate,
  handoffs: Map<string, HandoffCounts>,
  fetcher: FetchLike,
  tracesSoFar: number,
  scoresSoFar: number,
  now: () => number,
): Promise<TraceOutcome> {
  const traceEndMs = nanosToMs(aggregate.last_ns);
  const workstreamId =
    typeof aggregate.workstream_id === "string" && aggregate.workstream_id.length > 0
      ? aggregate.workstream_id
      : null;
  const counts =
    workstreamId === null ? NO_HANDOFFS : (handoffs.get(workstreamId) ?? NO_HANDOFFS);

  const events: BuiltEvent[] = [];
  for (const check of checks) {
    events.push(
      await buildCheckScoreEvent({
        configId: config.id,
        traceId: aggregate.trace_id,
        workstreamId,
        verdict: evaluateCheck(check, aggregate, counts),
        traceEndMs,
      }),
    );
  }

  let failure: ErrorDetail | null = null;
  if (judge !== null && apiKey !== null) {
    const spans = judge.include_bodies
      ? await loadJudgeSpans(env, execution.workspaceId, aggregate.trace_id)
      : null;
    const prompt = renderJudgePrompt(judge.prompt_template, buildJudgeInput(aggregate, spans));
    const judged = await callJudge(fetcher, judge, apiKey, prompt);
    if (judged.ok) {
      events.push(
        await buildJudgeScoreEvent({
          configId: config.id,
          configName: config.name,
          runId: execution.runId,
          traceId: aggregate.trace_id,
          workstreamId,
          judgeModel: judge.model,
          score: judged.verdict.score,
          reason: judged.verdict.reason,
          traceEndMs,
        }),
      );
    } else {
      failure = judged.reason;
    }
  }

  const ingestedAt = Math.floor(now() / 1000);
  const progress = env.DB.prepare(ADVANCE_PROGRESS_SQL).bind(
    execution.runId,
    execution.workspaceId,
    tracesSoFar,
    scoresSoFar + events.length,
  );
  await appendVerdicts(env, execution.workspaceId, events, progress, ingestedAt);

  return { ok: failure === null, scores: events.length, failure };
}

async function loadJudgeSpans(
  env: EvalsEnv,
  workspaceId: string,
  traceId: string,
): Promise<JudgeSpanRow[]> {
  const result = await env.DB.prepare(TRACE_SPAN_ROWS_SQL)
    .bind(workspaceId, traceId, MAX_JUDGE_SPAN_ROWS)
    .all<JudgeSpanRow>();
  return result.results;
}

/**
 * Settle a run exactly once. `started_at` clamps the completion instant
 * forward, because migration 0012 requires completed_at >= started_at and a
 * settlement must never be rejected by that guard merely because a clock read
 * backwards.
 */
async function settle(
  env: EvalsEnv,
  execution: EvalExecution,
  run: EvalRunRow,
  traces: number,
  scores: number,
  now: () => number,
  failure: ErrorDetail | null,
): Promise<EvalRunRow | null> {
  const settledAt = Math.max(Math.floor(now() / 1000), run.started_at);
  try {
    if (failure === null) {
      await env.DB.prepare(SETTLE_DONE_SQL)
        .bind(execution.runId, execution.workspaceId, traces, scores, settledAt)
        .run();
    } else {
      await env.DB.prepare(SETTLE_ERROR_SQL)
        .bind(execution.runId, execution.workspaceId, traces, scores, settledAt, failure)
        .run();
    }
  } catch (error) {
    logEvalFailure("settle", error);
  }
  return await env.DB.prepare(RUN_BY_ID_SQL)
    .bind(execution.runId, execution.workspaceId)
    .first<EvalRunRow>();
}

/** A step runner with no durability: the callback simply runs, once, here. */
export function inlineStepRunner(): WorkflowStepLike {
  return {
    async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      return await callback();
    },
  };
}

// -- durable execution -------------------------------------------------------

/**
 * What a Workflow instance is created with.
 *
 * Deliberately carries NO credential: the judge's key already lives sealed in
 * the config row, so the Workflows runtime — which persists instance params —
 * is handed nothing but three ids. The unsealing happens inside the run, from
 * D1, under the worker secret.
 */
export interface EvalRunParams {
  workspace_id: string;
  run_id: string;
  config_id: string;
}

/**
 * Drive one run under a durable step runner. Exported separately from the
 * class so the crash/resume behaviour can be exercised by a structural fake
 * step runner with no Workflows runtime present.
 */
export async function runEvalWorkflow(
  env: EvalsEnv,
  params: EvalRunParams,
  step: WorkflowStepLike,
  fetcher: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<void> {
  await executeEvalRun(
    env,
    {
      workspaceId: params.workspace_id,
      runId: params.run_id,
      // No deadline under durable execution: each trace is its own step.
      deadlineAtMs: Number.POSITIVE_INFINITY,
    },
    step,
    fetcher,
    now,
  );
}

/**
 * The Workflows entrypoint. Deliberately does NOT import `cloudflare:workers`:
 * the platform test suite runs in plain node with no miniflare, and a static
 * `cloudflare:workers` import would make this module unloadable there.
 *
 * Enabling the real binding is a two-line change gated behind the commented
 * [[workflows]] block in wrangler.toml — add the import and
 * `extends WorkflowEntrypoint<EvalsEnv, EvalRunParams>`. The constructor/`run`
 * shape below is already the one that contract requires, and all of the
 * behaviour lives in runEvalWorkflow above, so nothing about the evaluation
 * changes when it flips on.
 */
export class EvalWorkflow {
  protected readonly ctx: unknown;
  protected readonly env: EvalsEnv;

  constructor(ctx: unknown, env: EvalsEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async run(event: EvalWorkflowEvent, step: WorkflowStepLike): Promise<void> {
    await runEvalWorkflow(this.env, event.payload, step);
  }
}

// -- public views ------------------------------------------------------------

function configView(row: EvalConfigRow): Record<string, unknown> {
  const judge = parseJudge(row.judge);
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    trigger: row.trigger,
    target: parseTargetFilter(row.target_filter),
    checks: parseChecks(row.checks) ?? [],
    // The sealed credential is never echoed, on any surface.
    judge:
      judge === null
        ? null
        : {
            model: judge.model,
            base_url: judge.base_url,
            prompt_template: judge.prompt_template,
            include_bodies: judge.include_bodies,
            // A judge's output is a model's opinion, and it never renders
            // without the label that says so.
            provenance: "INFERRED",
          },
    created_at: row.created_at,
    last_run_at: row.last_run_at,
  };
}

function runView(row: EvalRunRow): Record<string, unknown> {
  return {
    id: row.id,
    config_id: row.config_id,
    status: row.status,
    traces_evaluated: row.traces_evaluated,
    scores_recorded: row.scores_recorded,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_detail: row.error_detail,
  };
}

// -- POST /v1/evals ----------------------------------------------------------

function sealingUnavailable(): Response {
  return json(503, {
    error: "judge credentials cannot be sealed while EVAL_SEALING_KEY is unset",
    code: "sealing_key_unavailable",
    // Hosted evaluation is a downstream reader of the spine; a missing secret
    // must never read as "your capture is broken".
    local_capture_unaffected: true,
  });
}

async function createConfig(request: Request, env: EvalsEnv): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateCreateConfigBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  let judgeJson: string | null = null;
  if (input.judge !== null) {
    const sealingKey = env.EVAL_SEALING_KEY;
    if (typeof sealingKey !== "string" || sealingKey.length === 0) return sealingUnavailable();
    const stored: JudgeConfig = {
      model: input.judge.model,
      base_url: input.judge.base_url,
      prompt_template: input.judge.prompt_template,
      api_key_ciphertext: await sealUpstreamKey(input.judge.api_key, sealingKey),
      include_bodies: input.judge.include_bodies,
    };
    judgeJson = canonicalJsonStringify(stored);
  }

  const id = newConfigID();
  const createdAt = Math.floor(Date.now() / 1000);
  const targetJson = canonicalJsonStringify(input.target);
  const checksJson = canonicalJsonStringify(input.checks);
  await env.DB.prepare(INSERT_CONFIG_SQL)
    .bind(id, auth.device.workspaceId, input.name, input.trigger, targetJson, checksJson,
      judgeJson, createdAt)
    .run();

  return json(201, {
    config: configView({
      id,
      workspace_id: auth.device.workspaceId,
      name: input.name,
      active: 1,
      trigger: input.trigger,
      target_filter: targetJson,
      checks: checksJson,
      judge: judgeJson,
      created_at: createdAt,
      last_run_at: null,
    }),
  });
}

// -- GET /v1/evals -----------------------------------------------------------

function compareConfigsDesc(a: EvalConfigRow, b: EvalConfigRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listConfigs(request: Request, env: EvalsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_CONFIGS_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<EvalConfigRow>()
      : await env.DB.prepare(LIST_CONFIGS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<EvalConfigRow>();

  // Re-sort in the Worker so the page never depends on storage order.
  const sorted = [...result.results].sort(compareConfigsDesc);
  const rows = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = rows[rows.length - 1];

  return json(200, {
    items: rows.map(configView),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- POST /v1/evals/{id}/run -------------------------------------------------

async function startRun(
  request: Request,
  env: EvalsEnv,
  configId: string,
  fetcher: FetchLike,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;

  // One workspace-scoped read collapses "unknown config" and "another
  // workspace's config" into the same 404 (platform convention: scopeDenial).
  const config = await env.DB.prepare(CONFIG_BY_ID_SQL)
    .bind(configId, auth.device.workspaceId)
    .first<EvalConfigRow>();
  if (config === null) return json(404, { error: "not found" });
  if (config.active !== 1) return json(409, { error: "eval config is not active" });

  const filter = parseTargetFilter(config.target_filter);
  const checks = parseChecks(config.checks);
  if (filter === null || checks === null) {
    return json(409, { error: "eval config is not runnable" });
  }
  const judge = config.judge === null ? null : parseJudge(config.judge);
  if (config.judge !== null && judge === null) {
    return json(409, { error: "eval config is not runnable" });
  }
  if (judge !== null) {
    const sealingKey = env.EVAL_SEALING_KEY;
    if (typeof sealingKey !== "string" || sealingKey.length === 0) return sealingUnavailable();
  }

  const startedAt = Math.floor(Date.now() / 1000);
  const window = evalWindow(startedAt, filter.since_minutes);
  const traceIds = await selectTargetTraces(
    env,
    auth.device.workspaceId,
    filter,
    window,
    MAX_TRACES_PER_RUN + 1,
  );
  // Refuse BEFORE a run row exists, so an over-wide window never leaves a
  // half-graded run in history.
  if (traceIds.length > MAX_TRACES_PER_RUN) {
    return json(413, {
      error: `window selects more than ${MAX_TRACES_PER_RUN} traces`,
      code: "too_many_targets",
      max_traces_per_run: MAX_TRACES_PER_RUN,
      guidance:
        "narrow target.since_minutes, or create a config with a target.workstream or target.kind filter",
    });
  }

  const runId = newRunID();
  await env.DB.prepare(INSERT_RUN_SQL)
    .bind(runId, auth.device.workspaceId, config.id, startedAt)
    .run();
  await markConfigRun(env, auth.device.workspaceId, config.id, startedAt);

  const dispatched = await dispatchToWorkflow(env, auth.device.workspaceId, runId, config.id);
  if (dispatched !== null) {
    const row = await env.DB.prepare(RUN_BY_ID_SQL)
      .bind(runId, auth.device.workspaceId)
      .first<EvalRunRow>();
    return json(202, {
      run: row === null ? null : runView(row),
      durability: "workflow",
      workflow_instance_id: dispatched,
    });
  }

  const settled = await executeEvalRun(
    env,
    {
      workspaceId: auth.device.workspaceId,
      runId,
      deadlineAtMs: Date.now() + INLINE_DEADLINE_MS,
    },
    inlineStepRunner(),
    fetcher,
  );
  return json(200, {
    run: settled === null ? null : runView(settled),
    durability: "inline",
  });
}

async function markConfigRun(
  env: EvalsEnv,
  workspaceId: string,
  configId: string,
  atSeconds: number,
): Promise<void> {
  try {
    await env.DB.prepare(MARK_CONFIG_RUN_SQL).bind(configId, workspaceId, atSeconds).run();
  } catch (error) {
    logEvalFailure("mark-config-run", error);
  }
}

/**
 * Hand the run to the durable path when it is available, returning the
 * instance id. Returns null — meaning "run it inline" — when the binding is
 * absent or instance creation failed. Falling back is safe precisely because
 * the event ids are deterministic: whichever path runs, the evidence is the
 * same.
 */
async function dispatchToWorkflow(
  env: EvalsEnv,
  workspaceId: string,
  runId: string,
  configId: string,
): Promise<string | null> {
  const binding = env.EVAL_WORKFLOW;
  if (binding === undefined) return null;
  try {
    const params: EvalRunParams = {
      workspace_id: workspaceId,
      run_id: runId,
      config_id: configId,
    };
    const instance = await binding.create({ id: runId, params });
    return instance.id;
  } catch (error) {
    logEvalFailure("workflow-dispatch", error);
    return null;
  }
}

// -- GET /v1/evals/{id}/runs -------------------------------------------------

function compareRunsDesc(a: EvalRunRow, b: EvalRunRow): number {
  if (b.started_at !== a.started_at) return b.started_at - a.started_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listRuns(request: Request, env: EvalsEnv, configId: string): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const config = await env.DB.prepare(CONFIG_BY_ID_SQL)
    .bind(configId, auth.device.workspaceId)
    .first<EvalConfigRow>();
  if (config === null) return json(404, { error: "not found" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_RUNS_SQL)
          .bind(auth.device.workspaceId, configId, fetchLimit)
          .all<EvalRunRow>()
      : await env.DB.prepare(LIST_RUNS_AFTER_SQL)
          .bind(auth.device.workspaceId, configId, cursor.createdAt, cursor.id, fetchLimit)
          .all<EvalRunRow>();

  const sorted = [...result.results].sort(compareRunsDesc);
  const rows = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = rows[rows.length - 1];

  return json(200, {
    items: rows.map(runView),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.started_at, id: last.id })
        : null,
  });
}

// -- POST /v1/evals/{id}/disable ---------------------------------------------

async function disableConfig(
  request: Request,
  env: EvalsEnv,
  configId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;

  const config = await env.DB.prepare(CONFIG_BY_ID_SQL)
    .bind(configId, auth.device.workspaceId)
    .first<EvalConfigRow>();
  if (config === null) return json(404, { error: "not found" });

  // Idempotent: disabling an already-disabled config is a no-op, not a
  // conflict. Re-enabling is not an operation at all (migration 0012's
  // terminal-disable trigger); create a new config instead.
  if (config.active === 1) {
    await env.DB.prepare(DISABLE_CONFIG_SQL).bind(configId, auth.device.workspaceId).run();
  }
  return json(200, { config: configView({ ...config, active: 0 }) });
}

// -- routing -----------------------------------------------------------------

/**
 * Route the evals surface. Returns null when this module does not own the path
 * — and also when it owns the path but not the method, so the platform-wide
 * catch-all in index.ts answers the 404 (house rule).
 */
export async function handleEvalsRoute(
  request: Request,
  env: EvalsEnv,
  fetcher: FetchLike = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === CONFIGS_PATH) {
    if (request.method === "POST") return await createConfig(request, env);
    if (request.method === "GET") return await listConfigs(request, env);
    return null;
  }

  const runMatch = RUN_PATH_PATTERN.exec(pathname);
  if (runMatch !== null) {
    if (request.method === "POST") return await startRun(request, env, runMatch[1], fetcher);
    return null;
  }

  const runsMatch = RUNS_PATH_PATTERN.exec(pathname);
  if (runsMatch !== null) {
    if (request.method === "GET") return await listRuns(request, env, runsMatch[1]);
    return null;
  }

  const disableMatch = DISABLE_PATH_PATTERN.exec(pathname);
  if (disableMatch !== null) {
    if (request.method === "POST") return await disableConfig(request, env, disableMatch[1]);
    return null;
  }

  return null;
}

// -- the sweep (evalsScheduled) ----------------------------------------------

/**
 * Cron-triggered eval sweep (see wrangler.toml [triggers] and the scheduled
 * dispatcher in src/index.ts).
 *
 * Due cron configs are started one at a time in a deterministic order, each
 * isolated in its own try/catch so a single bad config never starves the rest
 * of the tick — and so hosted evaluation can never affect ingest or local
 * capture. `last_run_at` moves at START, so a config that crashes mid-run is
 * not immediately re-enqueued on the next tick.
 */
export async function evalsScheduled(
  env: EvalsEnv,
  fetcher: FetchLike = fetch,
  nowSeconds?: number,
): Promise<void> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(DUE_CONFIGS_SQL)
    .bind(now, EVAL_SWEEP_CONFIG_LIMIT)
    .all<EvalConfigRow>();
  const configs = [...due.results].sort(compareConfigsForSweep);
  for (const config of configs) {
    try {
      await startScheduledRun(env, config, now, fetcher);
    } catch (error) {
      logEvalFailure("scheduled-run", error);
    }
  }
}

function compareConfigsForSweep(a: EvalConfigRow, b: EvalConfigRow): number {
  if (a.workspace_id !== b.workspace_id) return a.workspace_id < b.workspace_id ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

async function startScheduledRun(
  env: EvalsEnv,
  config: EvalConfigRow,
  nowSeconds: number,
  fetcher: FetchLike,
): Promise<void> {
  const runId = newRunID();
  await env.DB.prepare(INSERT_RUN_SQL)
    .bind(runId, config.workspace_id, config.id, nowSeconds)
    .run();
  await markConfigRun(env, config.workspace_id, config.id, nowSeconds);

  const dispatched = await dispatchToWorkflow(env, config.workspace_id, runId, config.id);
  if (dispatched !== null) return;

  // The deadline is a real wall-clock budget for THIS invocation, so it is
  // taken from Date.now() and not from the sweep's logical `nowSeconds` (which
  // a test — or a backfilled tick — may set in the past).
  await executeEvalRun(
    env,
    {
      workspaceId: config.workspace_id,
      runId,
      deadlineAtMs: Date.now() + INLINE_DEADLINE_MS,
    },
    inlineStepRunner(),
    fetcher,
  );
}
