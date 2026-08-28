// Agent simulations (parity row 31): a scripted user-simulator + judge loop
// over a target assistant, recorded on the append-only event spine.
//
// WHAT THIS IS NOT. We never run an agent PROCESS. A simulation here is a
// structured multi-turn conversation between three models reached over the
// caller's own upstream credential:
//
//   user      a model prompted with the scenario's persona + goal, producing
//             the next USER message and nothing else;
//   assistant the model under test, answering that message;
//   judge     a model handed the finished transcript plus the scenario's
//             success_criteria, returning {verdict, score, reason}.
//
// That non-goal is what keeps the feature inside the platform's Cloudflare-only
// envelope: no sandbox, no process supervision, no agent runtime — just bounded
// subrequests and D1. LangWatch's Scenario is the ideas-only reference for the
// shape (simulate a user, judge the transcript); no code or configuration from
// it, or from any other AGPL/ELv2 project, is used here.
//
// PROVENANCE IS THE PRODUCT. The two event kinds this module appends carry
// deliberately different provenance, and the split is the whole reason a
// simulation result is worth storing next to captured evidence:
//
//   simulation.turn.completed   OBSERVED. The assertion is "at exchange N,
//     role R produced content whose digest is H, using model M". This Worker
//     watched every part of that happen. The content itself is model output,
//     but we are not asserting anything about its truth — only that it
//     occurred, and what it hashes to.
//
//   simulation.completed        INFERRED. Its headline assertion is a model's
//     verdict and score. A model's opinion is never an observation, so the
//     event as a whole is INFERRED and the payload additionally labels each
//     field: verdict/judge_score INFERRED, turns_taken OBSERVED. (Same
//     discipline as gateway.ts, which only ever writes a cost next to the
//     label saying where the number came from.)
//
// CONTENT DISCIPLINE. No prompt, reply, or judge rationale is ever persisted
// hosted. Turn events are content-ADDRESSED: the payload carries
// `sha256:<hex>` of the turn text so a holder of the transcript can prove what
// was said, and the platform stores nothing it would later have to redact. The
// event's own `content_hash` is the digest of its canonical payload (the
// alerts.ts convention), never a pointer to a body we did not keep.
//
// REPLAY DETERMINISM. Event ids are pure functions of
// (run id, exchange index, role) and the run's stored start instant, and event
// payloads contain NO wall clock. That is load-bearing: `events` is
// append-only and migration 0003's events_reject_payload_conflict trigger
// ABORTS any insert that reuses an id for different bytes, so a resumed or
// replayed run must produce byte-identical documents. Wall-clock timing
// therefore lives on the simulation_runs row (started_at/completed_at) and, per
// turn, in the spine's own server-assigned `ingested_at` column — observed,
// monotone, and not part of raw_json.
//
// DURABILITY. With the optional SIM_WORKFLOW binding, each exchange runs
// inside step.do('turn-<n>'), so a killed run resumes at the next exchange and
// never re-bills the completed ones. Without it, the run executes inline under
// a wall-clock deadline. Correctness never depends on which path ran: the
// deterministic ids make both idempotent. See docs/simulations.md.

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

// -- ids ------------------------------------------------------------------------

const nextULID = monotonicFactory();

const SCENARIO_PREFIX = "sim_";
const RUN_PREFIX = "smr_";
const EVENT_PREFIX = "evt_";

const SCENARIOS_PATH = "/v1/simulations";
const RUN_PATH_PATTERN = /^\/v1\/simulations\/(sim_[0-7][0-9A-HJKMNP-TV-Z]{25})\/run$/;
const RUNS_PATH_PATTERN = /^\/v1\/simulations\/(sim_[0-7][0-9A-HJKMNP-TV-Z]{25})\/runs$/;
const TRANSCRIPT_PATH_PATTERN =
  /^\/v1\/simulations\/runs\/(smr_[0-7][0-9A-HJKMNP-TV-Z]{25})\/transcript$/;

function newScenarioID(): string {
  return `${SCENARIO_PREFIX}${nextULID()}`;
}

function newRunID(): string {
  return `${RUN_PREFIX}${nextULID()}`;
}

/**
 * The id of the turn event for (run, exchange, role). A pure function of its
 * inputs and the run's stored start instant, which is what makes a resumed or
 * replayed exchange land on the same row under INSERT OR IGNORE instead of
 * duplicating history.
 */
export function turnEventID(
  runId: string,
  turnIndex: number,
  role: TurnRole,
  startedAtMs: number,
): Promise<string> {
  return deterministicID(EVENT_PREFIX, `sim|turn|${runId}|${turnIndex}|${role}`, startedAtMs);
}

/** The id of the single simulation.completed event for a run. */
export function completedEventID(runId: string, startedAtMs: number): Promise<string> {
  return deterministicID(EVENT_PREFIX, `sim|completed|${runId}`, startedAtMs);
}

// -- structural Cloudflare bindings ------------------------------------------------
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
export interface SimulationWorkflowLike {
  create(options?: { id?: string; params?: SimulationRunParams }): Promise<WorkflowInstanceLike>;
}

export interface SimulationWorkflowEvent {
  payload: SimulationRunParams;
}

export interface SimulationsEnv {
  DB: D1DatabaseLike;
  /**
   * Optional durable-execution binding (wrangler.toml keeps the [[workflows]]
   * block commented until the Workflow is provisioned). Absent, runs execute
   * inline under a wall-clock deadline; results are identical either way.
   */
  SIM_WORKFLOW?: SimulationWorkflowLike;
  /**
   * AES-GCM sealing key shared with the gateway (`wrangler secret put
   * GATEWAY_SEALING_KEY`). A Workflow instance's params are persisted by the
   * Workflows runtime, so the caller's upstream credential is SEALED before it
   * is handed over. With no sealing key we refuse to persist a credential at
   * all and fall back to inline execution — never the other way round.
   */
  GATEWAY_SEALING_KEY?: string;
}

// -- tunables -----------------------------------------------------------------------

/** Schema ceiling (migration 0015). A simulation is a bounded evidence generator. */
export const MAX_TURNS_CEILING = 12;
export const DEFAULT_MAX_TURNS = 6;

/** Upstream subrequest deadline; a timeout is treated exactly like a 5xx. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Wall-clock ceiling for the inline (no-Workflow) path, checked BEFORE each
 * exchange so a long scenario stops cleanly at an exchange boundary with a
 * complete transcript rather than being cut off mid-call. Under SIM_WORKFLOW
 * there is no deadline: each exchange is its own durable step.
 */
export const INLINE_DEADLINE_MS = 25_000;

/**
 * Per-message ceiling. Model output is sliced to this BEFORE it is hashed and
 * before it re-enters the conversation, so the recorded digest always covers
 * exactly the bytes the next model actually saw.
 */
export const MAX_TURN_CHARS = 4_000;

/** Operator-authored scenario fields (schema allows 4000; the API is stricter). */
export const MAX_SCENARIO_TEXT_CHARS = 2_000;
export const MAX_SCENARIO_NAME_CHARS = 200;
export const MAX_MODEL_NAME_CHARS = 200;
const MAX_MANAGEMENT_BODY_BYTES = 16_384;
const MAX_JUDGE_REASON_CHARS = 500;

/** Bounded transcript read: 12 exchanges x 2 roles + one completion event. */
const MAX_TRANSCRIPT_EVENTS = MAX_TURNS_CEILING * 2 + 1;

/** Default upstream. Any public https:// OpenAI-compatible base URL is allowed. */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * The literal token the user-simulator is instructed to emit when the
 * conversation is over. A sentinel beats "did the model say goodbye": it is
 * exact, it cannot be produced by accident, and termination stays a decision
 * the scenario author can reason about.
 */
export const DONE_TOKEN = "[[SIM_DONE]]";

export const EVENT_KIND_TURN = "simulation.turn.completed";
export const EVENT_KIND_COMPLETED = "simulation.completed";
const EVENT_SCHEMA_VERSION = "hfg.event.v1";
const EVENT_PROVIDER = "simulation";

export type TurnRole = "user" | "assistant";
export type RunStatus = "running" | "done" | "error";
export type Verdict = "pass" | "fail";

// -- responses ---------------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Content-free structured logging: never a prompt, reply, model output or bind. */
function logSimulationFailure(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    message: "simulation failure",
    stage,
    error_type: error instanceof Error ? error.name : "unknown",
  }));
}

// -- device lookup (mirrors index.ts's adapter) --------------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* simulations:device-by-token */
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
  env: SimulationsEnv,
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

// -- rows ----------------------------------------------------------------------------

export interface ScenarioRow {
  id: string;
  workspace_id: string;
  name: string;
  persona: string;
  goal: string;
  success_criteria: string;
  max_turns: number;
  created_at: number;
  active: number;
}

export interface RunRow {
  id: string;
  workspace_id: string;
  scenario_id: string;
  status: string;
  turns_taken: number;
  verdict: string | null;
  judge_score: string | null;
  started_at: number;
  completed_at: number | null;
}

const SCENARIO_COLUMNS = `
    id, workspace_id, name, persona, goal, success_criteria, max_turns,
    created_at, active`;

const RUN_COLUMNS = `
    id, workspace_id, scenario_id, status, turns_taken, verdict, judge_score,
    started_at, completed_at`;

const INSERT_SCENARIO_SQL = `
  /* simulations:insert-scenario */
  INSERT INTO simulation_scenarios
    (id, workspace_id, name, persona, goal, success_criteria, max_turns, created_at, active)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)`;

const SCENARIO_BY_ID_SQL = `
  /* simulations:scenario-by-id */
  SELECT${SCENARIO_COLUMNS}
  FROM simulation_scenarios
  WHERE id = ?1 AND workspace_id = ?2`;

const LIST_SCENARIOS_SQL = `
  /* simulations:list-scenarios */
  SELECT${SCENARIO_COLUMNS}
  FROM simulation_scenarios
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_SCENARIOS_AFTER_SQL = `
  /* simulations:list-scenarios-after */
  SELECT${SCENARIO_COLUMNS}
  FROM simulation_scenarios
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

const INSERT_RUN_SQL = `
  /* simulations:insert-run */
  INSERT INTO simulation_runs
    (id, workspace_id, scenario_id, status, turns_taken, started_at)
  VALUES (?1, ?2, ?3, 'running', 0, ?4)`;

const RUN_BY_ID_SQL = `
  /* simulations:run-by-id */
  SELECT${RUN_COLUMNS}
  FROM simulation_runs
  WHERE id = ?1 AND workspace_id = ?2`;

const LIST_RUNS_SQL = `
  /* simulations:list-runs */
  SELECT${RUN_COLUMNS}
  FROM simulation_runs
  WHERE workspace_id = ?1 AND scenario_id = ?2
  ORDER BY started_at DESC, id DESC
  LIMIT ?3`;

const LIST_RUNS_AFTER_SQL = `
  /* simulations:list-runs-after */
  SELECT${RUN_COLUMNS}
  FROM simulation_runs
  WHERE workspace_id = ?1 AND scenario_id = ?2
    AND (started_at < ?3 OR (started_at = ?3 AND id < ?4))
  ORDER BY started_at DESC, id DESC
  LIMIT ?5`;

/**
 * Turn progress is written as the run advances so a killed run's row never
 * under-reports evidence that is already on the spine. Monotone by predicate
 * AND by trigger (migration 0015).
 */
const ADVANCE_TURNS_SQL = `
  /* simulations:advance-turns */
  UPDATE simulation_runs
  SET turns_taken = ?3
  WHERE id = ?1 AND workspace_id = ?2 AND turns_taken < ?3`;

/**
 * Settling is guarded on `completed_at IS NULL`, so a replayed or resumed
 * completion is a no-op rather than a second, differently-timed outcome.
 */
const SETTLE_DONE_SQL = `
  /* simulations:settle-done */
  UPDATE simulation_runs
  SET status = 'done', turns_taken = MAX(turns_taken, ?3), verdict = ?4,
      judge_score = ?5, completed_at = ?6
  WHERE id = ?1 AND workspace_id = ?2 AND completed_at IS NULL`;

const SETTLE_ERROR_SQL = `
  /* simulations:settle-error */
  UPDATE simulation_runs
  SET status = 'error', turns_taken = MAX(turns_taken, ?3), completed_at = ?4
  WHERE id = ?1 AND workspace_id = ?2 AND completed_at IS NULL`;

const INSERT_SIMULATION_EVENT_SQL = `
  /* simulations:append-event */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, NULL, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9)`;

/**
 * The transcript read. The kind predicate matches migration 0015's partial
 * indexes exactly and the json_extract expression is written verbatim as
 * indexed, so this is an index prune and never a spine scan.
 */
const TRANSCRIPT_EVENTS_SQL = `
  /* simulations:transcript-events */
  SELECT event_id, kind, occurred_at, ingested_at, raw_json
  FROM events
  WHERE workspace_id = ?1
    AND kind IN ('simulation.turn.completed', 'simulation.completed')
    AND json_extract(raw_json, '$.payload.run_id') = ?2
  ORDER BY seq
  LIMIT ?3`;

// -- validation -----------------------------------------------------------------------

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : null;
}

export interface CreateScenarioInput {
  name: string;
  persona: string;
  goal: string;
  successCriteria: string;
  maxTurns: number;
}

export function validateCreateScenarioBody(
  body: Record<string, unknown>,
): { ok: true; value: CreateScenarioInput } | { ok: false; error: string } {
  const name = boundedText(body.name, MAX_SCENARIO_NAME_CHARS);
  if (name === null) {
    return { ok: false, error: `name must be a string of 1..${MAX_SCENARIO_NAME_CHARS} characters` };
  }
  const persona = boundedText(body.persona, MAX_SCENARIO_TEXT_CHARS);
  if (persona === null) {
    return { ok: false, error: `persona must be a string of 1..${MAX_SCENARIO_TEXT_CHARS} characters` };
  }
  const goal = boundedText(body.goal, MAX_SCENARIO_TEXT_CHARS);
  if (goal === null) {
    return { ok: false, error: `goal must be a string of 1..${MAX_SCENARIO_TEXT_CHARS} characters` };
  }
  const successCriteria = boundedText(body.success_criteria, MAX_SCENARIO_TEXT_CHARS);
  if (successCriteria === null) {
    return {
      ok: false,
      error: `success_criteria must be a string of 1..${MAX_SCENARIO_TEXT_CHARS} characters`,
    };
  }

  let maxTurns = DEFAULT_MAX_TURNS;
  if (body.max_turns !== undefined) {
    const raw = body.max_turns;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_TURNS_CEILING) {
      return { ok: false, error: `max_turns must be an integer between 1 and ${MAX_TURNS_CEILING}` };
    }
    maxTurns = raw as number;
  }

  return { ok: true, value: { name, persona, goal, successCriteria, maxTurns } };
}

export interface StartRunInput {
  apiKey: string;
  baseUrl: string;
  userModel: string;
  assistantModel: string;
  judgeModel: string;
  assistantSystem: string | null;
}

export function validateStartRunBody(
  body: Record<string, unknown>,
): { ok: true; value: StartRunInput } | { ok: false; error: string } {
  const apiKey = body.gateway_key;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 512) {
    return { ok: false, error: "gateway_key must be a non-empty string of at most 512 characters" };
  }

  let baseUrl = DEFAULT_BASE_URL;
  if (body.base_url !== undefined) {
    const validated = validateUpstreamBaseUrl(body.base_url);
    if (validated === null) return { ok: false, error: "base_url must be a public https:// URL" };
    baseUrl = validated;
  }

  const models: Record<string, string> = {};
  for (const field of ["user_model", "assistant_model", "judge_model"]) {
    const model = boundedText(body[field], MAX_MODEL_NAME_CHARS);
    if (model === null) {
      return { ok: false, error: `${field} must be a string of 1..${MAX_MODEL_NAME_CHARS} characters` };
    }
    models[field] = model;
  }

  let assistantSystem: string | null = null;
  if (body.assistant_system !== undefined && body.assistant_system !== null) {
    assistantSystem = boundedText(body.assistant_system, MAX_SCENARIO_TEXT_CHARS);
    if (assistantSystem === null) {
      return {
        ok: false,
        error: `assistant_system must be a string of 1..${MAX_SCENARIO_TEXT_CHARS} characters`,
      };
    }
  }

  return {
    ok: true,
    value: {
      apiKey,
      baseUrl,
      userModel: models.user_model,
      assistantModel: models.assistant_model,
      judgeModel: models.judge_model,
      assistantSystem,
    },
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

// -- prompts --------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The user-simulator's system prompt. Two rules do the work: emit ONLY the
 * user's next message (a simulator that writes both sides produces a transcript
 * that proves nothing about the assistant), and emit DONE_TOKEN to stop.
 */
export function userSimulatorPrompt(scenario: ScenarioRow): string {
  return [
    "You are simulating a human user talking to an AI assistant.",
    `Persona: ${scenario.persona}`,
    `Goal: ${scenario.goal}`,
    "Rules:",
    "- Reply with ONLY the user's next message. Never write the assistant's reply.",
    "- Stay in character and pursue the goal.",
    `- When the goal is met, or clearly cannot be met, end your message with ${DONE_TOKEN}.`,
    `- Keep every message under ${MAX_TURN_CHARS} characters.`,
  ].join("\n");
}

/**
 * The judge's prompt. The transcript is rendered with explicit turn numbers so
 * a verdict can cite one, and the reply contract is a single JSON object —
 * anything else is a parse failure and therefore an errored run, never a
 * guessed verdict.
 */
export function judgePrompt(scenario: ScenarioRow, transcript: ChatMessage[]): string {
  const rendered = transcript
    .map((message, index) => `${index + 1}. ${message.role}: ${message.content}`)
    .join("\n");
  return [
    "You are grading a conversation between a simulated user and an AI assistant.",
    "Success criteria:",
    scenario.success_criteria,
    "Transcript:",
    rendered,
    'Reply with ONLY a JSON object of the form {"verdict":"pass"|"fail","score":"<decimal 0..1>","reason":"<one sentence>"}.',
    "Do not wrap it in prose.",
  ].join("\n");
}

// -- judge parsing (fail-closed) --------------------------------------------------------

export interface JudgeVerdict {
  verdict: Verdict;
  /** Canonical decimal STRING in [0, 1]. Never a float. */
  score: string;
  reason: string;
}

const FENCE_PATTERN = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Parse the judge's reply. Fail-closed by construction: every path that is not
 * an unambiguous, in-range verdict returns null, and a null verdict settles the
 * run as `error` with no verdict and no score rather than inventing one.
 *
 * The only tolerance is a single surrounding markdown code fence, because that
 * is a formatting habit rather than an ambiguity. No brace-scanning, no
 * "find the JSON somewhere in the prose": a judge that could not follow the
 * reply contract has not produced a gradeable answer.
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

  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "fail") return null;

  const score = canonicalScore(record.score);
  if (score === null) return null;

  const reason = typeof record.reason === "string" ? record.reason.slice(0, MAX_JUDGE_REASON_CHARS) : "";
  return { verdict, score, reason };
}

/**
 * A score is money-shaped: an exact decimal STRING, bounded to [0, 1]. A JSON
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

// -- upstream calls (the same BYO pattern as the gateway) ---------------------------------

function upstreamSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
}

export type ModelCallResult =
  | { ok: true; content: string }
  | { ok: false; reason: "upstream_unavailable" | "upstream_error" | "unparseable_response" };

/**
 * One OpenAI-compatible chat completion against the caller's own upstream.
 * Identical discipline to gateway.ts's callUpstream: an explicit header
 * allow-list, `redirect: "manual"` so a redirecting upstream cannot become a
 * second unvalidated destination, and a hard subrequest deadline where a
 * timeout is indistinguishable from a 5xx.
 *
 * Never throws: every failure is a typed result, because a thrown fetch inside
 * a durable step would retry the whole exchange and re-bill the turns before
 * it.
 */
export async function callChatModel(
  fetcher: FetchLike,
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<ModelCallResult> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    redirect: "manual",
    body: JSON.stringify({ model, messages, stream: false }),
  };
  const signal = upstreamSignal();
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  let text: string;
  try {
    response = await fetcher(`${baseUrl}/chat/completions`, init);
    text = await response.text();
  } catch {
    return { ok: false, reason: "upstream_unavailable" };
  }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "upstream_error" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable_response" };
  }
  const content = extractCompletionContent(parsed);
  if (content === null) return { ok: false, reason: "unparseable_response" };
  return { ok: true, content: content.slice(0, MAX_TURN_CHARS) };
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

async function contentDigest(text: string): Promise<string> {
  return `sha256:${await sha256Hex(text)}`;
}

// -- event documents --------------------------------------------------------------------

export interface TurnEventInput {
  runId: string;
  scenarioId: string;
  role: TurnRole;
  turnIndex: number;
  contentHash: string;
  model: string;
  /** The RUN's start instant. Every event of a run shares it; see the header. */
  startedAtMs: number;
}

export interface BuiltEvent {
  eventId: string;
  kind: string;
  provenance: "OBSERVED" | "INFERRED";
  occurredAt: string;
  contentHash: string;
  rawJson: string;
}

/**
 * A turn event: OBSERVED, content-addressed, wall-clock-free.
 *
 * OBSERVED is correct even though the content came from a model. The claim is
 * "this exchange happened, in this position, with this digest" — the platform
 * watched all of it. Nothing here asserts that what the model said is true.
 */
export async function buildTurnEvent(input: TurnEventInput): Promise<BuiltEvent> {
  const payload = {
    content_hash: input.contentHash,
    model: input.model,
    role: input.role,
    run_id: input.runId,
    scenario_id: input.scenarioId,
    turn_index: input.turnIndex,
  };
  const occurredAt = new Date(input.startedAtMs).toISOString();
  const eventId = await turnEventID(input.runId, input.turnIndex, input.role, input.startedAtMs);
  const contentHash = await contentDigest(canonicalJsonStringify(payload));
  const document = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId,
    kind: EVENT_KIND_TURN,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    provider: EVENT_PROVIDER,
    provenance: "OBSERVED",
    content_hash: contentHash,
    payload,
  };
  return {
    eventId,
    kind: EVENT_KIND_TURN,
    provenance: "OBSERVED",
    occurredAt,
    contentHash,
    rawJson: canonicalJsonStringify(document),
  };
}

export interface CompletedEventInput {
  runId: string;
  scenarioId: string;
  verdict: Verdict;
  judgeScore: string;
  judgeModel: string;
  reasonHash: string;
  turnsTaken: number;
  startedAtMs: number;
}

/**
 * The completion event: INFERRED, because its headline claim is a model's
 * opinion. The payload additionally labels provenance FIELD BY FIELD, so a
 * consumer reading turns_taken never has to wonder whether the platform
 * measured it or a model asserted it.
 */
export async function buildCompletedEvent(input: CompletedEventInput): Promise<BuiltEvent> {
  const payload = {
    judge_model: input.judgeModel,
    judge_score: input.judgeScore,
    reason_hash: input.reasonHash,
    run_id: input.runId,
    scenario_id: input.scenarioId,
    // Per-field provenance. verdict and judge_score are model output; the turn
    // count is a fact this Worker measured while running the loop.
    score_provenance: "INFERRED",
    turns_provenance: "OBSERVED",
    turns_taken: input.turnsTaken,
    verdict: input.verdict,
    verdict_provenance: "INFERRED",
  };
  const occurredAt = new Date(input.startedAtMs).toISOString();
  const eventId = await completedEventID(input.runId, input.startedAtMs);
  const contentHash = await contentDigest(canonicalJsonStringify(payload));
  const document = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId,
    kind: EVENT_KIND_COMPLETED,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    provider: EVENT_PROVIDER,
    provenance: "INFERRED",
    content_hash: contentHash,
    payload,
  };
  return {
    eventId,
    kind: EVENT_KIND_COMPLETED,
    provenance: "INFERRED",
    occurredAt,
    contentHash,
    rawJson: canonicalJsonStringify(document),
  };
}

function eventStatement(
  db: D1DatabaseLike,
  workspaceId: string,
  event: BuiltEvent,
  ingestedAt: number,
): D1BoundStatement {
  return db.prepare(INSERT_SIMULATION_EVENT_SQL).bind(
    workspaceId,
    event.eventId,
    event.occurredAt,
    EVENT_PROVIDER,
    event.kind,
    event.provenance,
    event.contentHash,
    ingestedAt,
    event.rawJson,
  );
}

/**
 * Append one turn event. INSERT OR IGNORE absorbs an exact replay; a payload
 * conflict (the same id carrying different bytes, which can only happen if a
 * model answered differently on a genuine re-execution) is logged content-free
 * and swallowed. The spine's refusal to let one id mean two things is correct
 * behaviour, and it must not take the rest of the run down with it.
 */
async function appendEvent(
  env: SimulationsEnv,
  workspaceId: string,
  event: BuiltEvent,
  ingestedAt: number,
): Promise<void> {
  try {
    await eventStatement(env.DB, workspaceId, event, ingestedAt).run();
  } catch (error) {
    logSimulationFailure("append-event", error);
  }
}

// -- the loop ----------------------------------------------------------------------------

/** What one durable step returns, and therefore what a resume replays from. */
export interface ExchangeOutcome {
  ok: boolean;
  /** True once the simulator emitted DONE_TOKEN or the exchange could not run. */
  done: boolean;
  /** False when the simulator ended with no message, so nothing was recorded. */
  counted: boolean;
  user: string | null;
  assistant: string | null;
}

export interface SimulationExecution {
  workspaceId: string;
  runId: string;
  apiKey: string;
  baseUrl: string;
  userModel: string;
  assistantModel: string;
  judgeModel: string;
  assistantSystem: string | null;
  /** Absolute wall-clock stop time for the inline path; Infinity under a Workflow. */
  deadlineAtMs: number;
}

/** Flip roles so the simulator sees the assistant's replies as ITS input. */
function simulatorView(conversation: ChatMessage[]): ChatMessage[] {
  return conversation.map((message) => ({
    role: message.role === "user" ? "assistant" : "user",
    content: message.content,
  }));
}

/**
 * Execute a run to settlement. Loads the run and scenario from D1 first, so a
 * resumed Workflow rebuilds its own context instead of trusting anything
 * carried in the instance params.
 *
 * Returns the settled run row, or null when the run does not exist in the
 * workspace.
 *
 * Nothing in here throws on its own — every upstream and D1 failure is a typed
 * result or a swallowed, content-free log. A throw from the STEP RUNNER is
 * deliberately allowed to propagate: under real Workflows that is how the
 * runtime learns an instance died, and swallowing it would turn a resumable
 * crash into a silently truncated transcript.
 */
export async function executeSimulationRun(
  env: SimulationsEnv,
  execution: SimulationExecution,
  step: WorkflowStepLike,
  fetcher: FetchLike,
  now: () => number = Date.now,
): Promise<RunRow | null> {
  const run = await env.DB.prepare(RUN_BY_ID_SQL)
    .bind(execution.runId, execution.workspaceId)
    .first<RunRow>();
  if (run === null) return null;

  const scenario = await env.DB.prepare(SCENARIO_BY_ID_SQL)
    .bind(run.scenario_id, execution.workspaceId)
    .first<ScenarioRow>();
  if (scenario === null) {
    await settleError(env, execution, run.turns_taken, now, run.started_at);
    return await reloadRun(env, execution);
  }

  const startedAtMs = run.started_at * 1000;
  const userSystem = userSimulatorPrompt(scenario);
  const conversation: ChatMessage[] = [];
  let turnsTaken = 0;
  let failed = false;

  for (let index = 0; index < scenario.max_turns; index++) {
    // Checked at the exchange boundary so the transcript is always complete up
    // to the last recorded turn, never truncated mid-call.
    if (now() >= execution.deadlineAtMs) break;

    const snapshot = conversation.slice();
    const outcome = await step.do(`turn-${index}`, () =>
      runExchange(env, execution, scenario, run, userSystem, snapshot, index, fetcher, now),
    );

    if (!outcome.ok) {
      failed = true;
      break;
    }
    if (outcome.counted) {
      turnsTaken = index + 1;
      if (outcome.user !== null) conversation.push({ role: "user", content: outcome.user });
      if (outcome.assistant !== null) {
        conversation.push({ role: "assistant", content: outcome.assistant });
      }
    }
    if (outcome.done) break;
  }

  if (failed || conversation.length === 0) {
    await settleError(env, execution, turnsTaken, now, run.started_at);
    return await reloadRun(env, execution);
  }

  const judged = await step.do("judge", async () =>
    callChatModel(fetcher, execution.baseUrl, execution.apiKey, execution.judgeModel, [
      { role: "system", content: judgePrompt(scenario, conversation) },
      { role: "user", content: "Return the JSON object now." },
    ]),
  );
  if (!judged.ok) {
    await settleError(env, execution, turnsTaken, now, run.started_at);
    return await reloadRun(env, execution);
  }

  // Fail-closed: an unparseable judgement is an errored run with NO verdict.
  // Guessing here would put a fabricated INFERRED verdict on the spine, which
  // is strictly worse than recording that the judge could not be read.
  const verdict = parseJudgeVerdict(judged.content);
  if (verdict === null) {
    await settleError(env, execution, turnsTaken, now, run.started_at);
    return await reloadRun(env, execution);
  }

  const event = await buildCompletedEvent({
    runId: execution.runId,
    scenarioId: scenario.id,
    verdict: verdict.verdict,
    judgeScore: verdict.score,
    judgeModel: execution.judgeModel,
    reasonHash: await contentDigest(verdict.reason),
    turnsTaken,
    startedAtMs,
  });

  const settledAt = Math.floor(now() / 1000);
  const statements: D1BoundStatement[] = [
    eventStatement(env.DB, execution.workspaceId, event, settledAt),
    env.DB.prepare(SETTLE_DONE_SQL).bind(
      execution.runId,
      execution.workspaceId,
      turnsTaken,
      verdict.verdict,
      verdict.score,
      Math.max(settledAt, run.started_at),
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A payload conflict aborts the whole batch, so retry the settlement alone:
    // the outcome must still be recorded, and the spine already holds an event
    // for this run's identity.
    logSimulationFailure("settle-done", error);
    try {
      await statements[1].run();
    } catch (retryError) {
      logSimulationFailure("settle-done-retry", retryError);
    }
  }

  return await reloadRun(env, execution);
}

/**
 * One user/assistant exchange, appending its evidence as it goes. This is the
 * body of `step.do('turn-<n>')`, so everything inside runs at most once per
 * run even across a crash — and the value it returns is what a resume replays
 * the conversation from.
 */
async function runExchange(
  env: SimulationsEnv,
  execution: SimulationExecution,
  scenario: ScenarioRow,
  run: RunRow,
  userSystem: string,
  conversation: ChatMessage[],
  index: number,
  fetcher: FetchLike,
  now: () => number,
): Promise<ExchangeOutcome> {
  const startedAtMs = run.started_at * 1000;

  const simulated = await callChatModel(
    fetcher,
    execution.baseUrl,
    execution.apiKey,
    execution.userModel,
    [{ role: "system", content: userSystem }, ...simulatorView(conversation)],
  );
  if (!simulated.ok) return { ok: false, done: true, counted: false, user: null, assistant: null };

  const done = simulated.content.includes(DONE_TOKEN);
  const userText = simulated.content.split(DONE_TOKEN).join("").trim();
  if (done && userText.length === 0) {
    // The simulator stopped without saying anything. Recording an empty turn
    // would put a digest of "" on the spine and claim a message that never
    // existed, so the exchange simply does not count.
    return { ok: true, done: true, counted: false, user: null, assistant: null };
  }

  const ingestedAt = Math.floor(now() / 1000);
  await appendEvent(
    env,
    execution.workspaceId,
    await buildTurnEvent({
      runId: execution.runId,
      scenarioId: scenario.id,
      role: "user",
      turnIndex: index,
      contentHash: await contentDigest(userText),
      model: execution.userModel,
      startedAtMs,
    }),
    ingestedAt,
  );

  if (done) {
    await advanceTurns(env, execution, index + 1);
    return { ok: true, done: true, counted: true, user: userText, assistant: null };
  }

  const assistantMessages: ChatMessage[] = [
    ...(execution.assistantSystem === null
      ? []
      : [{ role: "system" as const, content: execution.assistantSystem }]),
    ...conversation,
    { role: "user" as const, content: userText },
  ];
  const answered = await callChatModel(
    fetcher,
    execution.baseUrl,
    execution.apiKey,
    execution.assistantModel,
    assistantMessages,
  );
  if (!answered.ok) return { ok: false, done: true, counted: false, user: null, assistant: null };

  await appendEvent(
    env,
    execution.workspaceId,
    await buildTurnEvent({
      runId: execution.runId,
      scenarioId: scenario.id,
      role: "assistant",
      turnIndex: index,
      contentHash: await contentDigest(answered.content),
      model: execution.assistantModel,
      startedAtMs,
    }),
    Math.floor(now() / 1000),
  );
  await advanceTurns(env, execution, index + 1);

  return { ok: true, done: false, counted: true, user: userText, assistant: answered.content };
}

async function advanceTurns(
  env: SimulationsEnv,
  execution: SimulationExecution,
  turns: number,
): Promise<void> {
  try {
    await env.DB.prepare(ADVANCE_TURNS_SQL)
      .bind(execution.runId, execution.workspaceId, turns)
      .run();
  } catch (error) {
    logSimulationFailure("advance-turns", error);
  }
}

/**
 * Settle a run as errored. `startedAt` clamps the completion instant forward,
 * because migration 0015 requires completed_at >= started_at and a settlement
 * must never be rejected by that guard merely because a clock read backwards.
 */
async function settleError(
  env: SimulationsEnv,
  execution: SimulationExecution,
  turns: number,
  now: () => number,
  startedAt: number,
): Promise<void> {
  try {
    await env.DB.prepare(SETTLE_ERROR_SQL)
      .bind(
        execution.runId,
        execution.workspaceId,
        turns,
        Math.max(Math.floor(now() / 1000), startedAt),
      )
      .run();
  } catch (error) {
    logSimulationFailure("settle-error", error);
  }
}

async function reloadRun(env: SimulationsEnv, execution: SimulationExecution): Promise<RunRow | null> {
  return await env.DB.prepare(RUN_BY_ID_SQL)
    .bind(execution.runId, execution.workspaceId)
    .first<RunRow>();
}

/** A step runner with no durability: the callback simply runs, once, here. */
export function inlineStepRunner(): WorkflowStepLike {
  return {
    async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      return await callback();
    },
  };
}

// -- durable execution --------------------------------------------------------------------

/**
 * What a Workflow instance is created with. The upstream credential is SEALED
 * (AES-GCM under GATEWAY_SEALING_KEY) because the Workflows runtime persists
 * instance params, and a raw provider key must never be written to any store.
 */
export interface SimulationRunParams {
  workspace_id: string;
  run_id: string;
  sealed_key: string;
  base_url: string;
  user_model: string;
  assistant_model: string;
  judge_model: string;
  assistant_system: string | null;
}

/**
 * Drive one run under a durable step runner. Exported separately from the
 * class so the crash/resume behaviour can be exercised by a structural fake
 * step runner with no Workflows runtime present.
 */
export async function runSimulationWorkflow(
  env: SimulationsEnv,
  params: SimulationRunParams,
  step: WorkflowStepLike,
  fetcher: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<void> {
  const sealingKey = env.GATEWAY_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    // Cannot unseal, so cannot run. Settle the run rather than leaving it
    // 'running' forever with nothing coming.
    await settleUnrunnable(env, params, now);
    return;
  }

  let apiKey: string;
  try {
    apiKey = await unsealUpstreamKey(params.sealed_key, sealingKey);
  } catch (error) {
    logSimulationFailure("unseal", error);
    await settleUnrunnable(env, params, now);
    return;
  }

  await executeSimulationRun(
    env,
    {
      workspaceId: params.workspace_id,
      runId: params.run_id,
      apiKey,
      baseUrl: params.base_url,
      userModel: params.user_model,
      assistantModel: params.assistant_model,
      judgeModel: params.judge_model,
      assistantSystem: params.assistant_system,
      // No deadline under durable execution: each exchange is its own step.
      deadlineAtMs: Number.POSITIVE_INFINITY,
    },
    step,
    fetcher,
    now,
  );
}

/**
 * A run that can never start (no sealing key, or a credential that will not
 * unseal) is settled as errored instead of being abandoned in 'running'. The
 * run row is re-read first so the completion instant can be clamped against
 * its own started_at.
 */
async function settleUnrunnable(
  env: SimulationsEnv,
  params: SimulationRunParams,
  now: () => number,
): Promise<void> {
  const execution: SimulationExecution = {
    workspaceId: params.workspace_id,
    runId: params.run_id,
    apiKey: "",
    baseUrl: params.base_url,
    userModel: params.user_model,
    assistantModel: params.assistant_model,
    judgeModel: params.judge_model,
    assistantSystem: params.assistant_system,
    deadlineAtMs: Number.POSITIVE_INFINITY,
  };
  const run = await reloadRun(env, execution);
  if (run === null) return;
  await settleError(env, execution, run.turns_taken, now, run.started_at);
}

/**
 * The Workflows entrypoint. Deliberately does NOT import `cloudflare:workers`:
 * the platform test suite runs in plain node with no miniflare, and a static
 * `cloudflare:workers` import would make this module unloadable there.
 *
 * Enabling the real binding is a two-line change gated behind the commented
 * [[workflows]] block in wrangler.toml — add the import and
 * `extends WorkflowEntrypoint<SimulationsEnv, SimulationRunParams>`. The
 * constructor/`run` shape below is already the one that contract requires, and
 * all of the behaviour lives in runSimulationWorkflow above, so nothing about
 * the loop changes when it flips on.
 */
export class SimulationWorkflow {
  protected readonly ctx: unknown;
  protected readonly env: SimulationsEnv;

  constructor(ctx: unknown, env: SimulationsEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async run(event: SimulationWorkflowEvent, step: WorkflowStepLike): Promise<void> {
    await runSimulationWorkflow(this.env, event.payload, step);
  }
}

// -- public views ----------------------------------------------------------------------

function scenarioView(row: ScenarioRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    goal: row.goal,
    success_criteria: row.success_criteria,
    max_turns: row.max_turns,
    active: row.active === 1,
    created_at: row.created_at,
  };
}

function runView(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    status: row.status,
    turns_taken: row.turns_taken,
    verdict: row.verdict,
    judge_score: row.judge_score,
    // A verdict is a model's opinion. It never renders without the label that
    // says so, in any surface this platform serves.
    verdict_provenance: row.verdict === null ? null : "INFERRED",
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

// -- POST /v1/simulations ----------------------------------------------------------------

async function createScenario(request: Request, env: SimulationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateCreateScenarioBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  const id = newScenarioID();
  const createdAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(INSERT_SCENARIO_SQL)
    .bind(
      id,
      auth.device.workspaceId,
      input.name,
      input.persona,
      input.goal,
      input.successCriteria,
      input.maxTurns,
      createdAt,
    )
    .run();

  return json(201, {
    scenario: scenarioView({
      id,
      workspace_id: auth.device.workspaceId,
      name: input.name,
      persona: input.persona,
      goal: input.goal,
      success_criteria: input.successCriteria,
      max_turns: input.maxTurns,
      created_at: createdAt,
      active: 1,
    }),
  });
}

// -- GET /v1/simulations -----------------------------------------------------------------

function compareByCreatedDesc<T extends { created_at: number; id: string }>(a: T, b: T): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listScenarios(request: Request, env: SimulationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_SCENARIOS_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<ScenarioRow>()
      : await env.DB.prepare(LIST_SCENARIOS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<ScenarioRow>();

  // Re-sort in the Worker so the page never depends on storage order.
  const sorted = [...result.results].sort(compareByCreatedDesc);
  const rows = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = rows[rows.length - 1];

  return json(200, {
    items: rows.map(scenarioView),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- POST /v1/simulations/{id}/run ---------------------------------------------------------

async function startRun(
  request: Request,
  env: SimulationsEnv,
  scenarioId: string,
  fetcher: FetchLike,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateStartRunBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  // One workspace-scoped read collapses "unknown scenario" and "another
  // workspace's scenario" into the same 404 (platform convention: scopeDenial).
  const scenario = await env.DB.prepare(SCENARIO_BY_ID_SQL)
    .bind(scenarioId, auth.device.workspaceId)
    .first<ScenarioRow>();
  if (scenario === null) return json(404, { error: "not found" });
  if (scenario.active !== 1) return json(409, { error: "scenario is not active" });

  const runId = newRunID();
  const startedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(INSERT_RUN_SQL)
    .bind(runId, auth.device.workspaceId, scenario.id, startedAt)
    .run();

  const execution: SimulationExecution = {
    workspaceId: auth.device.workspaceId,
    runId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    userModel: input.userModel,
    assistantModel: input.assistantModel,
    judgeModel: input.judgeModel,
    assistantSystem: input.assistantSystem,
    deadlineAtMs: Date.now() + INLINE_DEADLINE_MS,
  };

  const dispatched = await dispatchToWorkflow(env, execution);
  if (dispatched !== null) {
    const row = await reloadRun(env, execution);
    return json(202, {
      run: row === null ? null : runView(row),
      durability: "workflow",
      workflow_instance_id: dispatched,
    });
  }

  const settled = await executeSimulationRun(env, execution, inlineStepRunner(), fetcher);
  return json(200, {
    run: settled === null ? null : runView(settled),
    durability: "inline",
  });
}

/**
 * Hand the run to the durable path when it is available, returning the
 * instance id. Returns null — meaning "run it inline" — when the binding is
 * absent, when no sealing key exists to protect the credential the Workflows
 * runtime would persist, or when instance creation failed. Falling back is
 * safe precisely because the event ids are deterministic: whichever path runs,
 * the evidence is the same.
 */
async function dispatchToWorkflow(
  env: SimulationsEnv,
  execution: SimulationExecution,
): Promise<string | null> {
  const binding = env.SIM_WORKFLOW;
  if (binding === undefined) return null;
  const sealingKey = env.GATEWAY_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    logSimulationFailure("workflow-dispatch", new Error("sealing key unavailable"));
    return null;
  }
  try {
    const params: SimulationRunParams = {
      workspace_id: execution.workspaceId,
      run_id: execution.runId,
      sealed_key: await sealUpstreamKey(execution.apiKey, sealingKey),
      base_url: execution.baseUrl,
      user_model: execution.userModel,
      assistant_model: execution.assistantModel,
      judge_model: execution.judgeModel,
      assistant_system: execution.assistantSystem,
    };
    const instance = await binding.create({ id: execution.runId, params });
    return instance.id;
  } catch (error) {
    logSimulationFailure("workflow-dispatch", error);
    return null;
  }
}

// -- GET /v1/simulations/{id}/runs -----------------------------------------------------

function compareRunsDesc(a: RunRow, b: RunRow): number {
  if (b.started_at !== a.started_at) return b.started_at - a.started_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listRuns(
  request: Request,
  env: SimulationsEnv,
  scenarioId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const scenario = await env.DB.prepare(SCENARIO_BY_ID_SQL)
    .bind(scenarioId, auth.device.workspaceId)
    .first<ScenarioRow>();
  if (scenario === null) return json(404, { error: "not found" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_RUNS_SQL)
          .bind(auth.device.workspaceId, scenarioId, fetchLimit)
          .all<RunRow>()
      : await env.DB.prepare(LIST_RUNS_AFTER_SQL)
          .bind(auth.device.workspaceId, scenarioId, cursor.createdAt, cursor.id, fetchLimit)
          .all<RunRow>();

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

// -- GET /v1/simulations/runs/{run_id}/transcript ----------------------------------------

interface TranscriptEventRow {
  event_id: string;
  kind: string;
  occurred_at: string;
  ingested_at: number;
  raw_json: string;
}

export interface TranscriptTurn {
  event_id: string;
  turn_index: number;
  role: TurnRole;
  content_hash: string;
  model: string;
  occurred_at: string;
  /** Server-assigned instant this turn was recorded (unix seconds). */
  recorded_at: number;
  provenance: "OBSERVED";
}

export interface TranscriptVerdict {
  event_id: string;
  verdict: string;
  judge_score: string;
  judge_model: string;
  reason_hash: string;
  turns_taken: number;
  recorded_at: number;
  provenance: "INFERRED";
}

/**
 * Rebuild the turn list from the spine. Bodies are never returned because they
 * were never stored: a turn is (index, role, digest, model, timing), and the
 * digest is what lets a holder of the text prove it is the text that ran.
 *
 * Output is re-sorted on (turn_index, role) with `user` before `assistant`, so
 * the transcript order is a property of the evidence rather than of D1's row
 * order. Malformed rows are skipped, never fatal: one unreadable payload must
 * not 500 a transcript.
 */
export function buildTranscript(rows: TranscriptEventRow[]): {
  turns: TranscriptTurn[];
  verdict: TranscriptVerdict | null;
} {
  const turns: TranscriptTurn[] = [];
  let verdict: TranscriptVerdict | null = null;

  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.raw_json);
      if (parsed === null || typeof parsed !== "object") continue;
      const candidate = (parsed as Record<string, unknown>).payload;
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      payload = candidate as Record<string, unknown>;
    } catch {
      continue;
    }

    if (row.kind === EVENT_KIND_TURN) {
      const role = payload.role;
      const turnIndex = payload.turn_index;
      const contentHash = payload.content_hash;
      if (role !== "user" && role !== "assistant") continue;
      if (!Number.isSafeInteger(turnIndex) || (turnIndex as number) < 0) continue;
      if (typeof contentHash !== "string") continue;
      turns.push({
        event_id: row.event_id,
        turn_index: turnIndex as number,
        role,
        content_hash: contentHash,
        model: typeof payload.model === "string" ? payload.model : "",
        occurred_at: row.occurred_at,
        recorded_at: row.ingested_at,
        provenance: "OBSERVED",
      });
      continue;
    }

    if (row.kind === EVENT_KIND_COMPLETED && verdict === null) {
      if (typeof payload.verdict !== "string" || typeof payload.judge_score !== "string") continue;
      verdict = {
        event_id: row.event_id,
        verdict: payload.verdict,
        judge_score: payload.judge_score,
        judge_model: typeof payload.judge_model === "string" ? payload.judge_model : "",
        reason_hash: typeof payload.reason_hash === "string" ? payload.reason_hash : "",
        turns_taken: Number.isSafeInteger(payload.turns_taken) ? (payload.turns_taken as number) : 0,
        recorded_at: row.ingested_at,
        provenance: "INFERRED",
      };
    }
  }

  turns.sort((a, b) => {
    if (a.turn_index !== b.turn_index) return a.turn_index - b.turn_index;
    if (a.role !== b.role) return a.role === "user" ? -1 : 1;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return { turns, verdict };
}

async function showTranscript(
  request: Request,
  env: SimulationsEnv,
  runId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const run = await env.DB.prepare(RUN_BY_ID_SQL)
    .bind(runId, auth.device.workspaceId)
    .first<RunRow>();
  if (run === null) return json(404, { error: "not found" });

  const result = await env.DB.prepare(TRANSCRIPT_EVENTS_SQL)
    .bind(auth.device.workspaceId, runId, MAX_TRANSCRIPT_EVENTS)
    .all<TranscriptEventRow>();
  const { turns, verdict } = buildTranscript(result.results);

  return json(200, {
    run: runView(run),
    turns,
    verdict,
    // Stated in the response, not just the docs: a consumer must never mistake
    // an absent body for a body we are withholding.
    content_policy: "content_addressed_only",
  });
}

// -- routing -------------------------------------------------------------------------------

/**
 * Route the simulation surface. Returns null when this module does not own the
 * path — and also when it owns the path but not the method, so the
 * platform-wide catch-all in index.ts answers the 404 (house rule).
 */
export async function handleSimulationsRoute(
  request: Request,
  env: SimulationsEnv,
  fetcher: FetchLike = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === SCENARIOS_PATH) {
    if (request.method === "POST") return await createScenario(request, env);
    if (request.method === "GET") return await listScenarios(request, env);
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

  const transcriptMatch = TRANSCRIPT_PATH_PATTERN.exec(pathname);
  if (transcriptMatch !== null) {
    if (request.method === "GET") return await showTranscript(request, env, transcriptMatch[1]);
    return null;
  }

  return null;
}
