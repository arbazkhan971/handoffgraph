// Prompt playground, prompt CI/CD, and the eval-driven optimization loop
// (parity row 35: playground — variant diffing, replay via the gateway;
//  parity row 36: prompt CI/CD — webhooks, GitHub Action, label-repoint
//  rollback gated on evals; parity row 30: eval-driven prompt optimization).
//
// Doc conflict, resolved upstream: docs/competitor-analysis.md's matrix files
// row 35 under P3 while docs/parity-plan.md lists it under P4. The feature
// ships here either way; the orchestrator reconciles the two documents. Nothing
// in this module depends on which priority band wins.
//
// Surfaces:
//   POST /v1/playground/run             run 1-2 prompt versions, diff them
//   GET  /v1/playground/runs            cursor-paginated run list
//   POST /v1/prompts/{name}/labels      eval-gated repoint / rollback / dry run
//   POST /v1/prompt-optimizer/suggest   one INFERRED rewrite, never applied
//
// ---------------------------------------------------------------------------
// THE ONE IDEA
// ---------------------------------------------------------------------------
// A playground is normally a scratchpad: you try two prompts, eyeball the
// difference, and the comparison evaporates. That is exactly the artifact this
// platform exists to stop losing. So every variant executed here APPENDS a
// `playground.completed` event to the same verified, append-only spine as the
// coding-agent evidence next to it — which is docs/parity-plan.md's own P4
// acceptance gate for this row, "playground runs are recorded as experiment
// events (dogfood)". The run table (migration 0014) holds metadata only; delete
// it and every comparison is still fully reconstructible from `events`.
//
// The same idea carries the CI/CD half. There is no labels table in this
// platform, hosted or local: a label is derived state over `prompt.labeled`
// events (src/quality.ts's resolveLabels, mirroring internal/prompts.Resolve).
// So repointing `production` from v3 to v4 is an APPEND, and a ROLLBACK — v4
// back to v3 — is the identical operation through the identical gate. There is
// no separate rollback code path to get wrong, and the audit trail is the same
// spine that answers every other question about the workspace.
//
// ---------------------------------------------------------------------------
// PROVENANCE, WHICH IS THE PRODUCT
// ---------------------------------------------------------------------------
//   playground.completed        OBSERVED. "Variant V of prompt P, rendered with
//     these variables, was sent to model M and produced output whose digest is
//     H, consuming these tokens." This Worker watched all of it. The output
//     text is model output, but nothing here asserts it is TRUE — only that it
//     occurred and what it hashes to.
//
//   prompt.labeled              OBSERVED, and byte-compatible with the Go CLI's
//     own payload ({name, label, version}). A repoint is an action the platform
//     performed and directly observed. An eval-gated repoint adds a `gate`
//     audit object; Go's json.Unmarshal-into-struct ignores unknown keys, so
//     `handoffgraph prompt show` and src/quality.ts both keep working.
//
//   prompt.suggestion.recorded  INFERRED. Its headline claim is a model's
//     opinion about how a prompt should be rewritten. A model's opinion is
//     never an observation. The suggestion is NEVER auto-applied: moving a
//     label stays a separate, human-initiated, gated call. The payload also
//     labels itself `suggestion_provenance: "INFERRED"`, so a consumer reading
//     payloads alone cannot mistake it for fact (the field-level discipline
//     gateway.ts uses for cost_provenance and simulations.ts for
//     verdict_provenance).
//
// ---------------------------------------------------------------------------
// CONTENT DISCIPLINE
// ---------------------------------------------------------------------------
// No rendered prompt and no completion is written into `events`. Playground
// events are content-ADDRESSED — they carry `sha256:<hex>` so a holder of the
// text can prove it is the text that ran. The caller gets the full outputs in
// the HTTP response (that is the entire point of a playground); the PLATFORM
// keeps only digests. Bodies are persisted only when the virtual key used for
// the run was created with capture_tier "full", and then into the EXISTING
// gateway_capture_bodies table (migration 0010) — reusing the gateway's single
// redaction choke-point rather than opening a second place content can hide.
//
// ---------------------------------------------------------------------------
// REPLAY DETERMINISM
// ---------------------------------------------------------------------------
// Event payloads contain NO wall clock. Migration 0003's
// events_reject_payload_conflict trigger ABORTS any insert reusing an event id
// for different bytes, so a replayed run must produce byte-identical documents.
// Run timing lives on the playground_runs row and, per event, in the spine's
// server-assigned `ingested_at`. Latency is reported in the HTTP response and
// nowhere else.
//
// Ids are pure functions of (semantic identity, run start millisecond): a
// re-POST of a byte-identical run inside the same millisecond lands on the same
// run row and the same events under INSERT OR IGNORE. A re-POST a second later
// is a genuinely different call at a different time and gets its own identity —
// which is honest, because the model may well answer differently.
//
// ---------------------------------------------------------------------------
// KNOWN GAP, STATED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------
// gateway.ts does not export `callUpstream`/`callWithFallbacks`, so the
// upstream caller below is a thin DUPLICATE of gateway.ts's discipline (header
// allow-list, redirect:"manual", hard subrequest deadline, timeout treated as a
// 5xx). Two consequences, both deliberate and both flagged for unification:
//
//   1. No provider fallbacks. A playground variant calls the virtual key's
//      PRIMARY upstream only. Falling through to a fallback provider mid-diff
//      would silently compare two prompts against two different models, which
//      is worse than failing.
//   2. Playground spend is recorded on the SPINE (cost in the event payload,
//      provider-reported only) but NOT in the gateway_requests ledger, so a
//      playground run does not advance gateway_keys.budget_spent. The key's
//      budget and rate limit are still CHECKED before every run, so an
//      exhausted key cannot be used here — but a long playground session can
//      spend past a budget that only the proxy path advances. Unifying this
//      means exporting the gateway's call+capture composition; see
//      docs/prompt-cicd.md.

import {
  authenticate,
  extractBearerToken,
  hasCapability,
  sha256Hex,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import {
  authenticateApiKey,
  type KVNamespaceLike as ApiKeyKVLike,
} from "./apikeys";
import type { D1DatabaseLike } from "./db";
import {
  checkRateLimit,
  compareDecimalStrings,
  isDecimalString,
  providerReportedCost,
  resolveGatewayKey,
  unsealUpstreamKey,
  type FetchLike,
  type GatewayKeyRecord,
  type KVNamespaceLike as GatewayKVLike,
} from "./gateway";
import {
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
  scopeDenial,
} from "./ingest";
import { deterministicID } from "./otlp";
import {
  latestVersion,
  materializePromptEvents,
  type PromptAggregate,
  type PromptVersionRecord,
} from "./quality";

export type { FetchLike } from "./gateway";

// -- ids + paths ----------------------------------------------------------------

const RUN_PREFIX = "plr_";
const EVENT_PREFIX = "evt_";

const RUN_PATH = "/v1/playground/run";
const RUNS_PATH = "/v1/playground/runs";
const SUGGEST_PATH = "/v1/prompt-optimizer/suggest";
/** `/v1/prompts/{name}/labels`. `{name}` is percent-decoded, then validated. */
const LABELS_PATH_PATTERN = /^\/v1\/prompts\/([^/]+)\/labels$/;

/**
 * The run's id. A pure function of the run's SEMANTIC identity (workspace,
 * prompt, versions, model, the rendered bodies actually sent, and the token
 * ceiling) and the run's start millisecond. Re-POSTing an identical run inside
 * the same millisecond therefore lands on the same row under INSERT OR IGNORE
 * rather than forking a second run against the same evidence.
 */
export function playgroundRunID(identity: string, startedAtMs: number): Promise<string> {
  return deterministicID(RUN_PREFIX, `playground|run|${identity}`, startedAtMs);
}

/** The id of one variant's playground.completed event. */
export function playgroundEventID(
  identity: string,
  version: number,
  startedAtMs: number,
): Promise<string> {
  return deterministicID(EVENT_PREFIX, `playground|variant|${identity}|${version}`, startedAtMs);
}

/**
 * The id of one prompt.labeled event.
 *
 * The wall clock is load-bearing here, unlike everywhere else in this module.
 * A rollback repoints `production` from v4 BACK to v3 — a (name, label,
 * version) triple that already appeared in history. If the id ignored time,
 * that rollback event would be an exact replay of the original, INSERT OR
 * IGNORE would drop it, and resolveLabels (which resolves last-write-wins by
 * seq) would never see the label move. The label would silently stay on v4.
 * Including the millisecond makes every repoint its own event while keeping a
 * retried write inside the same millisecond idempotent.
 */
export function labelEventID(
  promptName: string,
  label: string,
  version: number,
  atMs: number,
): Promise<string> {
  return deterministicID(EVENT_PREFIX, `playground|label|${promptName}|${label}|${version}`, atMs);
}

/** The id of one prompt.suggestion.recorded event. */
export function suggestionEventID(
  promptName: string,
  baseVersion: number,
  suggestedBodyHash: string,
  atMs: number,
): Promise<string> {
  return deterministicID(
    EVENT_PREFIX,
    `playground|suggestion|${promptName}|${baseVersion}|${suggestedBodyHash}`,
    atMs,
  );
}

// -- environment ------------------------------------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests and the real bindings satisfy these shapes at the index.ts boundary.
// Every binding beyond DB is optional, so the Worker type-checks and deploys
// before any of them are provisioned.

export interface PlaygroundEnv {
  DB: D1DatabaseLike;
  /** Shared with the gateway: the edge cache of the virtual-key registry. */
  GATEWAY_KV?: GatewayKVLike;
  /** Shared with src/apikeys.ts: cached sk_ verification verdicts. */
  APIKEY_KV?: ApiKeyKVLike;
  /**
   * AES-GCM sealing key for upstream provider credentials (`wrangler secret
   * put GATEWAY_SEALING_KEY`). Without it a virtual key's upstream credential
   * cannot be unsealed, so every route that calls a model fails closed with
   * 503. Label repoints and listings do not need it and keep working.
   */
  GATEWAY_SEALING_KEY?: string;
}

// -- tunables ----------------------------------------------------------------------

/** Schema ceiling (migration 0014). The product is a DIFF, so two is the cap. */
export const MAX_VARIANTS = 2;

/** Go's maxPromptBytes (internal/prompts). A rendered body may not exceed it. */
export const MAX_RENDERED_BODY_BYTES = 32_768;

export const MAX_PROMPT_NAME_CHARS = 200;
export const MAX_MODEL_NAME_CHARS = 200;
export const MAX_LABEL_CHARS = 64;
export const MAX_VARIABLE_NAME_CHARS = 64;
export const MAX_VARIABLE_VALUE_CHARS = 8_000;
export const MAX_VARIABLES = 64;
export const MAX_REQUEST_BODY_BYTES = 65_536;

/** Upstream subrequest deadline; a timeout is treated exactly like a 5xx. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** Model output is sliced to this BEFORE it is hashed, so the recorded digest
 *  always covers exactly the bytes the caller was shown. */
export const MAX_OUTPUT_CHARS = 32_000;

export const MAX_TOKENS_CEILING = 8_192;

/** Bounded score scan for the eval gate and the optimizer's evidence sample. */
export const MAX_SCORE_SCAN_ROWS = 20_000;

/** How many low-scoring evidence rows the optimizer may show the model. */
export const DEFAULT_SAMPLE_SIZE = 5;
export const MAX_SAMPLE_SIZE = 20;

/** A score at or below this counts as "low" for the optimizer's evidence. */
export const DEFAULT_LOW_SCORE_THRESHOLD = "0.5";

/** Per-line ceiling in the diff summary; full outputs are returned separately. */
export const MAX_DIFF_LINE_CHARS = 200;

/** Bounded, model-authored commentary stored alongside its digest. */
export const MAX_RATIONALE_CHARS = 280;

export const EVENT_KIND_PLAYGROUND_COMPLETED = "playground.completed";
export const EVENT_KIND_PROMPT_LABELED = "prompt.labeled";
export const EVENT_KIND_SUGGESTION_RECORDED = "prompt.suggestion.recorded";

const EVENT_SCHEMA_VERSION = "hfg.event.v1";
const EVENT_PROVIDER = "playground";

export type RunStatus = "running" | "done" | "error";

// -- responses + logging -------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Content-free structured logging: never a prompt, output, key, or bind. */
function logPlaygroundFailure(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    message: "playground failure",
    stage,
    error_type: error instanceof Error ? error.name : "unknown",
  }));
}

// -- device lookup (mirrors index.ts's adapter) ----------------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* playground:device-by-token */
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
  env: PlaygroundEnv,
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

/**
 * Resolve a WRITE principal for the label route: either a device bearer token
 * with 'ingest', or an `sk_` API key with the 'write' scope.
 *
 * The sk_ half is what makes prompt CI/CD usable: a GitHub Action holds a
 * repository secret, not a device token, and asking CI to mint device tokens
 * would defeat the point. Read-only sk_ keys (the v1 default) are rejected with
 * 403 — promoting a prompt is a write.
 */
export async function authorizeWritePrincipal(
  request: Request,
  env: PlaygroundEnv,
): Promise<{ workspaceId: string; principal: "device" | "apikey" } | { response: Response }> {
  const header = request.headers.get("authorization");
  const token = extractBearerToken(header);
  if (token === null) return { response: json(401, { error: "unauthorized" }) };

  if (token.startsWith("sk_")) {
    const verdict = await authenticateApiKey(header, env);
    if (!verdict.ok) return { response: json(verdict.status, { error: verdict.error }) };
    if (!verdict.scopes.includes("write")) return { response: json(403, { error: "forbidden" }) };
    return { workspaceId: verdict.workspaceId, principal: "apikey" };
  }

  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth;
  return { workspaceId: auth.device.workspaceId, principal: "device" };
}

// -- rows + SQL ---------------------------------------------------------------------

export interface PlaygroundRunRow {
  id: string;
  workspace_id: string;
  prompt_name: string;
  versions: string;
  model: string;
  status: string;
  created_at: number;
  completed_at: number | null;
}

const RUN_COLUMNS = `
    id, workspace_id, prompt_name, versions, model, status, created_at, completed_at`;

/**
 * INSERT OR IGNORE, not INSERT: the run id is deterministic, so a retried or
 * replayed POST inside the same millisecond must land on the existing row
 * rather than raising a primary-key error the caller cannot act on.
 */
const INSERT_RUN_SQL = `
  /* playground:insert-run */
  INSERT OR IGNORE INTO playground_runs
    (id, workspace_id, prompt_name, versions, model, status, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)`;

const RUN_BY_ID_SQL = `
  /* playground:run-by-id */
  SELECT${RUN_COLUMNS}
  FROM playground_runs
  WHERE id = ?1 AND workspace_id = ?2`;

/**
 * Settlement is guarded on `completed_at IS NULL`, so a replayed settlement is
 * a no-op rather than a second, differently-timed outcome — and so migration
 * 0014's write-once trigger is never even reached in normal operation.
 */
const SETTLE_RUN_SQL = `
  /* playground:settle-run */
  UPDATE playground_runs
  SET status = ?3, completed_at = ?4
  WHERE id = ?1 AND workspace_id = ?2 AND completed_at IS NULL`;

const LIST_RUNS_SQL = `
  /* playground:list-runs */
  SELECT${RUN_COLUMNS}
  FROM playground_runs
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_RUNS_AFTER_SQL = `
  /* playground:list-runs-after */
  SELECT${RUN_COLUMNS}
  FROM playground_runs
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

const INSERT_EVENT_SQL = `
  /* playground:append-event */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, NULL, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9)`;

/**
 * Body capture reuses the gateway's own content-addressed table so redaction
 * keeps exactly one choke-point. `request_id` carries the playground run id;
 * the column has no format CHECK precisely so non-proxy captures can share it.
 */
const INSERT_CAPTURE_BODY_SQL = `
  /* playground:insert-capture-body */
  INSERT OR IGNORE INTO gateway_capture_bodies
    (workspace_id, content_hash, key_id, request_id, role, body, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

/**
 * The eval gate's score read. Two things about this statement are
 * load-bearing:
 *
 *   - The kind predicate is a LITERAL, not a bind, so it matches migration
 *     0014's partial index (idx_events_score_recorded) exactly and the read is
 *     an index prune rather than a scan-and-filter.
 *
 *   - `ORDER BY seq DESC` with the LIMIT keeps the NEWEST rows when a
 *     workspace's score history outgrows the cap. Ascending would keep the
 *     OLDEST, and a gate that silently reads stale scores past some row count
 *     is worse than no gate: it would keep answering, confidently, with
 *     evidence that has since been superseded. Callers re-sort ascending, so
 *     "the latest score" means the same thing at every scale.
 *
 *   - `provenance` is selected because a gate that cannot see it cannot tell an
 *     OBSERVED evaluation from an LLM judge's INFERRED opinion, and would
 *     record the latter inside an OBSERVED prompt.labeled audit as though a
 *     measurement had happened. See evaluateEvalGate.
 */
const SCAN_SCORES_SQL = `
  /* playground:scan-scores */
  SELECT seq, event_id, occurred_at, provenance, raw_json
  FROM events
  WHERE workspace_id = ?1 AND kind = 'score.recorded'
  ORDER BY seq DESC
  LIMIT ?2`;

// -- small helpers -------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const UTF8_ENCODER = new TextEncoder();

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

async function contentDigest(text: string): Promise<string> {
  return `sha256:${await sha256Hex(text)}`;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : null;
}

/** occurred_at is RFC3339-validated at ingest; compare chronologically, never
 *  as a string (offsets are not lexicographically monotone with real time). */
function occurredAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
  if (!body.ok) return null;
  try {
    const value: unknown = JSON.parse(body.text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** `choices[0].message.content`, or null when the upstream did not send one. */
export function extractCompletionContent(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isPlainObject(first)) return null;
  const message = first.message;
  if (!isPlainObject(message)) return null;
  const content = message.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/** One non-negative usage counter, or null when the upstream omitted it. */
function usageTokenCount(usage: unknown, field: string): number | null {
  if (!isPlainObject(usage)) return null;
  const raw = usage[field];
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

// -- variable substitution (fail-closed) -----------------------------------------------

/**
 * `{{ name }}` placeholders, with optional inner whitespace. Deliberately NOT a
 * template language: no expressions, no filters, no conditionals. A prompt
 * store's job is to version text, and every construct added here is one more
 * thing that can differ between the version you tested and the version you
 * shipped.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; missing: string[] };

/**
 * Substitute variables into a prompt body, FAIL-CLOSED.
 *
 * Every placeholder must have a value. An unbound `{{customer_name}}` is a
 * 400, never a literal `{{customer_name}}` forwarded to the model: silently
 * sending an unrendered template is exactly the bug a playground exists to
 * catch, and answering it with a plausible completion would hide it.
 *
 * Substitution is SINGLE-PASS: a value containing `{{other}}` is inserted
 * verbatim and never re-expanded, so no variable can inject a placeholder that
 * pulls in a second variable.
 *
 * Extra variables are permitted and ignored — comparing v1 (which uses `{{a}}`)
 * against v2 (which also uses `{{b}}`) requires one variable map that covers
 * both, so rejecting unused keys would make the primary use case impossible.
 */
export function renderPromptBody(
  body: string,
  variables: Record<string, string>,
): RenderResult {
  const missing = new Set<string>();
  const text = body.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(variables, name)
      ? variables[name]
      : undefined;
    if (value === undefined) {
      missing.add(name);
      return match;
    }
    return value;
  });
  if (missing.size > 0) return { ok: false, missing: [...missing].sort() };
  return { ok: true, text };
}

// -- diff summary ------------------------------------------------------------------------

export interface DivergentLine {
  /** 1-based line number of the first line the two outputs disagree on. */
  line: number;
  /** The line from variant A, or null when A ended before this line. */
  a: string | null;
  /** The line from variant B, or null when B ended before this line. */
  b: string | null;
}

export interface DiffSummary {
  identical: boolean;
  /** `b.length - a.length` in characters. Negative when B is shorter. */
  length_delta: number;
  first_divergent_line: DivergentLine | null;
}

function sliceLine(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, MAX_DIFF_LINE_CHARS);
}

/**
 * The whole diff product: "where do these two outputs first disagree, and by
 * how much do they differ in size". Deliberately not a full LCS diff — a
 * two-line summary is what a human uses to decide whether a prompt change did
 * what they meant, and the full outputs are in the same response for anyone who
 * wants to diff them properly client-side.
 *
 * Line splitting normalizes CRLF so a Windows-authored prompt does not report
 * every line as divergent.
 */
export function diffSummary(a: string, b: string): DiffSummary {
  if (a === b) {
    return { identical: true, length_delta: 0, first_divergent_line: null };
  }
  const linesA = a.split(/\r?\n/);
  const linesB = b.split(/\r?\n/);
  const limit = Math.max(linesA.length, linesB.length);
  let divergent: DivergentLine | null = null;
  for (let index = 0; index < limit; index++) {
    if (linesA[index] !== linesB[index]) {
      divergent = {
        line: index + 1,
        a: sliceLine(linesA[index]),
        b: sliceLine(linesB[index]),
      };
      break;
    }
  }
  return { identical: false, length_delta: b.length - a.length, first_divergent_line: divergent };
}

// -- prompt version resolution (over src/quality.ts's materializer) ------------------------

/**
 * The prompt.created record for one version number, or undefined.
 *
 * Last match wins, matching src/quality.ts's showPrompt: materializePromptEvents
 * sorts each aggregate by (version, seq), so the last entry for a version number
 * is the highest-seq write of it. A duplicate version number is an out-of-band
 * write race the CLI's own `next := latest+1` numbering avoids.
 */
export function findPromptVersion(
  aggregate: PromptAggregate,
  version: number,
): PromptVersionRecord | undefined {
  let match: PromptVersionRecord | undefined;
  for (const candidate of aggregate.versions) {
    if (candidate.version === version) match = candidate;
  }
  return match;
}

// -- virtual key resolution (the gateway's registry, our error envelope) --------------------

export interface GatewayCredential {
  record: GatewayKeyRecord;
  /** The unsealed upstream provider credential. Never logged, never stored. */
  apiKey: string;
  baseUrl: string;
}

/**
 * Resolve and gate the `vk_` key a playground run will spend against.
 *
 * Every rejection uses the PLATFORM error envelope `{error: "..."}`, not the
 * OpenAI-shaped error gateway.ts's proxy returns. That is deliberate: the proxy
 * exists so an unmodified OpenAI client works, whereas /v1/playground/* is a
 * first-party HandoffGraph API whose callers already parse `{error}` everywhere
 * else. Documented in docs/prompt-cicd.md so nobody reads the difference as an
 * oversight.
 *
 * Ownership is checked BEFORE the disabled check, and a foreign-workspace key
 * is answered exactly like an unknown one, so a caller can never probe another
 * workspace's key ids by watching which rejection they get.
 */
export async function resolveGatewayCredential(
  env: PlaygroundEnv,
  workspaceId: string,
  presented: string,
  nowSeconds: number,
): Promise<{ ok: true; value: GatewayCredential } | { ok: false; response: Response }> {
  const sealingKey = env.GATEWAY_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    // Fail closed: without the sealing key we cannot unseal an upstream
    // credential, and we will not fall back to forwarding the caller's own.
    return { ok: false, response: json(503, { error: "gateway_sealing_key_unavailable" }) };
  }
  if (!presented.startsWith("vk_")) {
    return { ok: false, response: json(401, { error: "invalid_gateway_key" }) };
  }

  const tokenHash = await sha256Hex(presented);
  const record = await resolveGatewayKey(env, tokenHash);
  if (record === null || record.workspace_id !== workspaceId) {
    return { ok: false, response: json(401, { error: "invalid_gateway_key" }) };
  }
  if (record.disabled) {
    return { ok: false, response: json(401, { error: "gateway_key_disabled" }) };
  }
  if (
    record.budget_amount !== null &&
    compareDecimalStrings(record.budget_spent, record.budget_amount) >= 0
  ) {
    return { ok: false, response: json(429, { error: "budget_exhausted" }) };
  }
  if (!(await checkRateLimit(env, record, nowSeconds))) {
    return { ok: false, response: json(429, { error: "rate_limit_exceeded" }) };
  }

  let apiKey: string;
  try {
    apiKey = await unsealUpstreamKey(record.upstream.api_key_ciphertext, sealingKey);
  } catch (error) {
    logPlaygroundFailure("unseal", error);
    return { ok: false, response: json(503, { error: "gateway_key_unreadable" }) };
  }
  return { ok: true, value: { record, apiKey, baseUrl: record.upstream.base_url } };
}

// -- the upstream caller (thin duplicate of gateway.ts; see the header) ----------------------

function upstreamSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
}

export type ModelCallFailure = "upstream_unavailable" | "upstream_error" | "unparseable_response";

export type ModelCallResult =
  | {
      ok: true;
      content: string;
      responseText: string;
      status: number;
      tokensIn: number | null;
      tokensOut: number | null;
      /** Provider-REPORTED cost only. A figure we derived would be INFERRED. */
      cost: string | null;
      latencyMs: number;
    }
  | { ok: false; reason: ModelCallFailure; status: number | null; latencyMs: number };

/**
 * One OpenAI-compatible chat completion against the virtual key's PRIMARY
 * upstream.
 *
 * Identical discipline to gateway.ts's callUpstream: an explicit header
 * allow-list (the caller's own Authorization never reaches the provider),
 * `redirect: "manual"` so a redirecting upstream cannot become a second
 * unvalidated destination, and a hard subrequest deadline where a timeout is
 * indistinguishable from a 5xx.
 *
 * Never throws: every failure is a typed result, so a run settles cleanly as
 * 'error' instead of unwinding through the platform's 500 handler.
 */
export async function callPlaygroundModel(
  fetcher: FetchLike,
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number | null,
  now: () => number,
): Promise<ModelCallResult> {
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  if (maxTokens !== null) payload.max_tokens = maxTokens;

  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    redirect: "manual",
    body: JSON.stringify(payload),
  };
  const signal = upstreamSignal();
  if (signal !== undefined) init.signal = signal;

  const startedAtMs = now();
  let response: Response;
  let text: string;
  try {
    response = await fetcher(`${baseUrl}/chat/completions`, init);
    text = await response.text();
  } catch {
    return { ok: false, reason: "upstream_unavailable", status: null, latencyMs: now() - startedAtMs };
  }
  const latencyMs = now() - startedAtMs;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: "upstream_error", status: response.status, latencyMs };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable_response", status: response.status, latencyMs };
  }
  const content = extractCompletionContent(parsed);
  if (content === null) {
    return { ok: false, reason: "unparseable_response", status: response.status, latencyMs };
  }
  const usage = isPlainObject(parsed) ? parsed.usage : undefined;
  return {
    ok: true,
    // Sliced BEFORE hashing, so the recorded digest always covers exactly the
    // bytes the caller was shown.
    content: content.slice(0, MAX_OUTPUT_CHARS),
    responseText: text,
    status: response.status,
    tokensIn: usageTokenCount(usage, "prompt_tokens"),
    tokensOut: usageTokenCount(usage, "completion_tokens"),
    cost: providerReportedCost(usage),
    latencyMs,
  };
}

// -- event documents -----------------------------------------------------------------------

export interface BuiltEvent {
  eventId: string;
  kind: string;
  provenance: "OBSERVED" | "INFERRED";
  occurredAt: string;
  contentHash: string;
  rawJson: string;
}

async function buildEvent(
  eventId: string,
  kind: string,
  provenance: "OBSERVED" | "INFERRED",
  occurredAtMsValue: number,
  payload: Record<string, unknown>,
): Promise<BuiltEvent> {
  const occurredAt = new Date(occurredAtMsValue).toISOString();
  // The event's own content_hash is the digest of its CANONICAL PAYLOAD (the
  // alerts.ts / simulations.ts convention), never a pointer to a body we did
  // not keep. Body digests, when present, live inside the payload.
  const contentHash = await contentDigest(canonicalJsonStringify(payload));
  const document = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId,
    kind,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    provider: EVENT_PROVIDER,
    provenance,
    content_hash: contentHash,
    payload,
  };
  return {
    eventId,
    kind,
    provenance,
    occurredAt,
    contentHash,
    rawJson: canonicalJsonStringify(document),
  };
}

export interface VariantEventInput {
  runId: string;
  identity: string;
  promptName: string;
  version: number;
  variantIndex: number;
  model: string;
  promptHash: string;
  outputHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: string | null;
  /** The RUN's start instant. Every event of a run shares it; see the header. */
  startedAtMs: number;
}

/**
 * One variant's evidence: OBSERVED, content-addressed, wall-clock-free.
 *
 * OBSERVED is correct even though the output came from a model. The claim is
 * "this prompt version was sent to this model and produced output with this
 * digest, costing these tokens" — the platform watched all of it. Nothing here
 * asserts the output is good, or true, or better than the other variant.
 */
export async function buildVariantEvent(input: VariantEventInput): Promise<BuiltEvent> {
  const payload: Record<string, unknown> = {
    model: input.model,
    output_hash: input.outputHash,
    prompt_hash: input.promptHash,
    prompt_name: input.promptName,
    run_id: input.runId,
    tokens: { input: input.tokensIn, output: input.tokensOut },
    variant_index: input.variantIndex,
    version: input.version,
  };
  // Cost is written ONLY when the upstream itself reported it, and only ever
  // beside the label saying so. A figure derived from a price table would be
  // INFERRED, and this platform does not write INFERRED money as fact.
  payload.cost = input.cost;
  if (input.cost !== null) payload.cost_provenance = "provider_reported";

  const eventId = await playgroundEventID(input.identity, input.version, input.startedAtMs);
  return await buildEvent(
    eventId,
    EVENT_KIND_PLAYGROUND_COMPLETED,
    "OBSERVED",
    input.startedAtMs,
    payload,
  );
}

/**
 * What the gate decided, and on what. This object is embedded verbatim in an
 * OBSERVED prompt.labeled event, so it has to be self-describing: a reader six
 * months later must be able to tell whether production was promoted on a
 * measurement or on a model's opinion WITHOUT re-deriving anything.
 *
 * `latest_score_provenance` is therefore recorded unconditionally, not only
 * when `require_observed` was set. An OBSERVED event that quotes a passing
 * score while withholding where the score came from is precisely how an
 * INFERRED number gets read as an observed one.
 */
export interface GateAudit {
  score_name: string;
  min_score: string;
  latest_score: string | null;
  latest_score_event_id: string | null;
  /** OBSERVED / DECLARED / INFERRED / UNKNOWN, or null when no score existed. */
  latest_score_provenance: ScoreProvenance | null;
  /** Whether this gate demanded an OBSERVED score, so the rule is auditable too. */
  require_observed: boolean;
  passed: boolean;
  forced: boolean;
}

export interface LabelEventInput {
  promptName: string;
  label: string;
  version: number;
  atMs: number;
  gate: GateAudit | null;
}

/**
 * A label repoint: OBSERVED, and byte-compatible with the Go CLI's own
 * prompt.labeled payload ({name, label, version} — internal/prompts
 * NewLabeledEvent). The optional `gate` object is additive; Go's
 * json.Unmarshal-into-struct and src/quality.ts's parsePromptLabeledPayload
 * both ignore unknown keys, so the local CLI and the hosted read model keep
 * resolving this label unchanged.
 *
 * `gate` is present whenever a gate was REQUESTED — including when it failed
 * and was force-overridden. An override that left no trace would make `force`
 * a way to launder an unevaluated prompt into production, which is the one
 * thing a CI gate must never permit.
 */
export async function buildLabelEvent(input: LabelEventInput): Promise<BuiltEvent> {
  const payload: Record<string, unknown> = {
    label: input.label,
    name: input.promptName,
    version: input.version,
  };
  if (input.gate !== null) payload.gate = { ...input.gate };
  const eventId = await labelEventID(input.promptName, input.label, input.version, input.atMs);
  return await buildEvent(eventId, EVENT_KIND_PROMPT_LABELED, "OBSERVED", input.atMs, payload);
}

export interface SuggestionEventInput {
  promptName: string;
  baseVersion: number;
  model: string;
  suggestedBodyHash: string;
  rationaleHash: string;
  rationaleSummary: string;
  sampleSize: number;
  evidenceEventIds: string[];
  atMs: number;
}

/**
 * A model's proposed rewrite: INFERRED, because its headline claim is an
 * opinion. The suggested body itself is NOT stored — only its digest, so a
 * holder of the text returned in the HTTP response can prove it is the text
 * that was suggested.
 *
 * `rationale_summary` is the one place this module stores model-authored TEXT
 * hosted, bounded to MAX_RATIONALE_CHARS and always accompanied by
 * `rationale_hash`. That is a considered exception to the content-free rule,
 * not an oversight: it is commentary the platform generated about
 * OPERATOR-AUTHORED configuration (a prompt), never captured agent evidence,
 * and a suggestion nobody can read is a suggestion nobody can act on. See
 * docs/prompt-cicd.md.
 *
 * `applied: false` is written into the payload rather than merely implied. A
 * suggestion is never auto-applied; the only way a prompt version reaches
 * production is a human repointing a label through the gated route.
 */
export async function buildSuggestionEvent(input: SuggestionEventInput): Promise<BuiltEvent> {
  const payload: Record<string, unknown> = {
    applied: false,
    base_version: input.baseVersion,
    evidence_event_ids: [...input.evidenceEventIds].sort(),
    model: input.model,
    prompt_name: input.promptName,
    rationale_hash: input.rationaleHash,
    rationale_summary: input.rationaleSummary,
    sample_size: input.sampleSize,
    suggested_body_hash: input.suggestedBodyHash,
    // Field-level provenance, so a consumer reading only payloads cannot
    // mistake a model's proposal for a platform assertion.
    suggestion_provenance: "INFERRED",
  };
  const eventId = await suggestionEventID(
    input.promptName,
    input.baseVersion,
    input.suggestedBodyHash,
    input.atMs,
  );
  return await buildEvent(eventId, EVENT_KIND_SUGGESTION_RECORDED, "INFERRED", input.atMs, payload);
}

/**
 * Append one event. INSERT OR IGNORE absorbs an exact replay. A payload
 * conflict (the same id carrying different bytes — only reachable when a model
 * answered differently on a genuine re-execution inside the same millisecond)
 * is logged content-free and reported to the caller as `recorded: false`. The
 * spine's refusal to let one id mean two things is correct behaviour, and
 * silently swallowing it would let a response claim evidence that is not there.
 */
async function appendEvent(
  env: PlaygroundEnv,
  workspaceId: string,
  event: BuiltEvent,
  ingestedAt: number,
): Promise<boolean> {
  try {
    await env.DB.prepare(INSERT_EVENT_SQL)
      .bind(
        workspaceId,
        event.eventId,
        event.occurredAt,
        EVENT_PROVIDER,
        event.kind,
        event.provenance,
        event.contentHash,
        ingestedAt,
        event.rawJson,
      )
      .run();
    return true;
  } catch (error) {
    logPlaygroundFailure("append-event", error);
    return false;
  }
}

// -- the eval gate (parity row 36) -------------------------------------------------------

/**
 * Does this score.recorded payload target (promptName, version)?
 *
 * Two accepted linkages, both explicit:
 *
 *   1. An explicit prompt target: `target_type: "prompt"` with
 *      `target_id: "<name>@<version>"`. This is the hosted convention for a
 *      score recorded ABOUT a prompt version itself (an offline eval).
 *
 *   2. The Go linkage keys, mirrored verbatim from internal/prompts.Links:
 *      name in {prompt_name, prompt.name, langfuse.observation.prompt.name}
 *      and version in {prompt_version, prompt.version}. This is how a score
 *      recorded about a TRACE that used the prompt links back to it, and
 *      copying Go's exact key set is what keeps `handoffgraph prompt links`
 *      and this gate agreeing about the same events.
 *
 * A payload that names the prompt but not the version does NOT gate a specific
 * version: promoting v4 on the strength of a score that might have been about
 * v1 is precisely the mistake this route exists to prevent.
 */
export function scoreTargetsPromptVersion(
  payload: unknown,
  promptName: string,
  version: number,
): boolean {
  if (!isPlainObject(payload)) return false;

  if (payload.target_type === "prompt" && payload.target_id === `${promptName}@${version}`) {
    return true;
  }

  let namesPrompt = false;
  for (const key of ["prompt_name", "prompt.name", "langfuse.observation.prompt.name"]) {
    if (payload[key] === promptName) namesPrompt = true;
  }
  if (!namesPrompt) return false;
  for (const key of ["prompt_version", "prompt.version"]) {
    const raw = payload[key];
    if (typeof raw === "number" && Number.isInteger(raw) && raw === version) return true;
  }
  return false;
}

/** The three labels the spine recognises; anything else is UNKNOWN. */
export type ScoreProvenance = "OBSERVED" | "DECLARED" | "INFERRED" | "UNKNOWN";

/**
 * The provenance of one score row, normalized.
 *
 * The `events.provenance` COLUMN is authoritative (it is what every read model
 * on this platform filters on) with the envelope's own label as a fallback for
 * a row whose column was never populated. An unrecognised or absent label
 * becomes "UNKNOWN" rather than being optimistically read as OBSERVED: a gate
 * must never treat "we do not know where this number came from" as "a human or
 * a deterministic evaluator measured it".
 */
function normalizeProvenance(column: unknown, envelope: unknown): ScoreProvenance {
  for (const candidate of [column, envelope]) {
    if (typeof candidate !== "string") continue;
    const upper = candidate.trim().toUpperCase();
    if (upper === "OBSERVED" || upper === "DECLARED" || upper === "INFERRED") return upper;
  }
  return "UNKNOWN";
}

export interface LinkedScore {
  seq: number;
  event_id: string;
  occurred_at: string;
  name: string;
  /** The canonical decimal STRING exactly as recorded. Never re-parsed. */
  value: string;
  comment: string;
  /**
   * OBSERVED / DECLARED / INFERRED / UNKNOWN, from the spine. An LLM-as-judge
   * score is INFERRED (migration 0012); a deterministic evaluator's is
   * OBSERVED. Carried so no consumer has to assume.
   */
  provenance: ScoreProvenance;
}

interface ScoreScanRow {
  seq: number;
  event_id: string;
  occurred_at: string;
  provenance: string | null;
  raw_json: string;
}

/**
 * Every score.recorded event linked to (promptName, version), optionally
 * filtered to one score name, in ascending (occurred_at, event_id) order —
 * the same ordering src/quality.ts's materializeScores produces, so "the latest
 * score" means the same thing on both surfaces.
 *
 * Only scores whose value is a canonical decimal STRING are returned. A
 * CATEGORY or BOOLEAN score cannot be compared against a numeric threshold, and
 * coercing one would be inventing a number the evaluator never recorded.
 * Malformed rows are skipped, never fatal: one unreadable payload must not
 * block a deploy.
 *
 * `scanLimit` is a parameter purely so the newest-rows-win bound is testable
 * without seeding MAX_SCORE_SCAN_ROWS events; callers always take the default.
 */
export async function loadLinkedScores(
  db: D1DatabaseLike,
  workspaceId: string,
  promptName: string,
  version: number,
  scoreName: string | null,
  scanLimit: number = MAX_SCORE_SCAN_ROWS,
): Promise<LinkedScore[]> {
  const result = await db.prepare(SCAN_SCORES_SQL)
    .bind(workspaceId, scanLimit)
    .all<ScoreScanRow>();

  const items: LinkedScore[] = [];
  for (const row of result.results) {
    let payload: unknown;
    let envelopeProvenance: unknown;
    try {
      const parsed: unknown = JSON.parse(row.raw_json);
      if (!isPlainObject(parsed)) continue;
      payload = parsed.payload;
      envelopeProvenance = parsed.provenance;
    } catch {
      continue;
    }
    if (!isPlainObject(payload)) continue;
    if (!scoreTargetsPromptVersion(payload, promptName, version)) continue;
    const name = typeof payload.name === "string" ? payload.name : "";
    if (scoreName !== null && name !== scoreName) continue;
    const value = payload.value;
    if (!isDecimalString(value)) continue;
    items.push({
      seq: row.seq,
      event_id: row.event_id,
      occurred_at: row.occurred_at,
      name,
      value,
      comment: typeof payload.comment === "string" ? payload.comment : "",
      provenance: normalizeProvenance(row.provenance, envelopeProvenance),
    });
  }

  items.sort((a, b) => {
    const at = occurredAtMs(a.occurred_at);
    const bt = occurredAtMs(b.occurred_at);
    if (at !== bt) return at - bt;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return items;
}

/** Why the gate decided what it decided. Reported; never inferred by a reader. */
export type GateReason = "passed" | "no_score" | "below_threshold" | "provenance_not_observed";

export interface GateVerdict {
  passed: boolean;
  latestScore: string | null;
  latestScoreEventId: string | null;
  /**
   * The provenance of the score the verdict rests on, or null when no score
   * was found. ALWAYS reported, whatever `requireObserved` was set to — the
   * audit's job is to say what the decision was made on, not merely whether a
   * rule was satisfied.
   */
  latestScoreProvenance: ScoreProvenance | null;
  reason: GateReason;
}

/**
 * The gate: the LATEST linked score of the named kind must be >= min_score.
 *
 * ABSENT IS A FAILURE, not a pass. "No eval has ever run against this version"
 * and "this version scored 0.9" must never produce the same deploy decision;
 * a gate that defaults open is decoration. Comparison is exact decimal-string
 * arithmetic (gateway.ts's compareDecimalStrings), because a promotion
 * threshold is precisely the number a reviewer will argue about and 0.1 + 0.2
 * is not 0.3 in binary floating point.
 *
 * PROVENANCE. A score.recorded event may be OBSERVED (a deterministic
 * evaluator, a human review) or INFERRED (an LLM-as-judge — migration 0012 is
 * explicit about this). Both are legitimate evidence; they are not the same
 * evidence. The verdict therefore always carries the provenance of the score it
 * rested on, so the prompt.labeled audit — an OBSERVED event — can never
 * present a model's opinion as a measurement simply by omitting the label.
 *
 * `requireObserved` (default false, so existing pipelines keep their behavior)
 * additionally refuses to pass on anything but an OBSERVED latest score. Note
 * it gates the LATEST score, not "the latest OBSERVED score": scanning past a
 * newer INFERRED result to find an older OBSERVED one would resurrect exactly
 * the stale-evidence pass this function's ordering rules exist to prevent.
 */
export async function evaluateEvalGate(
  db: D1DatabaseLike,
  workspaceId: string,
  promptName: string,
  version: number,
  scoreName: string,
  minScore: string,
  requireObserved = false,
): Promise<GateVerdict> {
  const scores = await loadLinkedScores(db, workspaceId, promptName, version, scoreName);
  const latest = scores[scores.length - 1];
  if (latest === undefined) {
    return {
      passed: false,
      latestScore: null,
      latestScoreEventId: null,
      latestScoreProvenance: null,
      reason: "no_score",
    };
  }
  const base = {
    latestScore: latest.value,
    latestScoreEventId: latest.event_id,
    latestScoreProvenance: latest.provenance,
  };
  if (compareDecimalStrings(latest.value, minScore) < 0) {
    return { ...base, passed: false, reason: "below_threshold" };
  }
  if (requireObserved && latest.provenance !== "OBSERVED") {
    return { ...base, passed: false, reason: "provenance_not_observed" };
  }
  return { ...base, passed: true, reason: "passed" };
}

// -- validation ------------------------------------------------------------------------------

export interface RunInput {
  promptName: string;
  versions: number[];
  variables: Record<string, string>;
  gatewayKey: string;
  model: string;
  maxTokens: number | null;
}

export function validateRunBody(
  body: Record<string, unknown>,
): { ok: true; value: RunInput } | { ok: false; error: string } {
  const promptName = boundedText(body.prompt_name, MAX_PROMPT_NAME_CHARS);
  if (promptName === null) {
    return { ok: false, error: `prompt_name must be a string of 1..${MAX_PROMPT_NAME_CHARS} characters` };
  }

  const rawVersions = body.versions;
  if (!Array.isArray(rawVersions) || rawVersions.length < 1 || rawVersions.length > MAX_VARIANTS) {
    return { ok: false, error: `versions must be an array of 1..${MAX_VARIANTS} positive integers` };
  }
  const versions: number[] = [];
  for (const raw of rawVersions) {
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      return { ok: false, error: "versions entries must be positive integers" };
    }
    versions.push(raw as number);
  }
  if (versions.length === 2 && versions[0] === versions[1]) {
    // Diffing a version against itself always reports "identical" and spends
    // twice. Refusing is more useful than answering a question nobody meant.
    return { ok: false, error: "versions must name two different versions" };
  }

  const variablePairs: [string, string][] = [];
  if (body.variables !== undefined && body.variables !== null) {
    if (!isPlainObject(body.variables)) {
      return { ok: false, error: "variables must be an object of string values" };
    }
    const entries = Object.entries(body.variables);
    if (entries.length > MAX_VARIABLES) {
      return { ok: false, error: `variables may contain at most ${MAX_VARIABLES} keys` };
    }
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > MAX_VARIABLE_NAME_CHARS) {
        return { ok: false, error: `variable names must be 1..${MAX_VARIABLE_NAME_CHARS} characters` };
      }
      if (typeof value !== "string" || value.length > MAX_VARIABLE_VALUE_CHARS) {
        return {
          ok: false,
          error: `variable values must be strings of at most ${MAX_VARIABLE_VALUE_CHARS} characters`,
        };
      }
      variablePairs.push([key, value]);
    }
  }
  // Object.fromEntries, not incremental `map[key] = value`: the placeholder
  // pattern admits `__proto__`, and a plain assignment of that key on an object
  // literal hits the prototype SETTER instead of creating an own property. The
  // renderer's hasOwnProperty guard would then report it missing — fail-closed,
  // but for a confusing reason. CreateDataProperty semantics make it a real key.
  const variables: Record<string, string> = Object.fromEntries(variablePairs);

  const gatewayKey = body.gateway_key;
  if (typeof gatewayKey !== "string" || gatewayKey.length === 0 || gatewayKey.length > 512) {
    return { ok: false, error: "gateway_key must be a non-empty string of at most 512 characters" };
  }

  const model = boundedText(body.model, MAX_MODEL_NAME_CHARS);
  if (model === null) {
    return { ok: false, error: `model must be a string of 1..${MAX_MODEL_NAME_CHARS} characters` };
  }

  let maxTokens: number | null = null;
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const raw = body.max_tokens;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_TOKENS_CEILING) {
      return { ok: false, error: `max_tokens must be an integer between 1 and ${MAX_TOKENS_CEILING}` };
    }
    maxTokens = raw as number;
  }

  return { ok: true, value: { promptName, versions, variables, gatewayKey, model, maxTokens } };
}

export interface LabelInput {
  label: string;
  version: number;
  minScore: string | null;
  scoreName: string | null;
  requireObserved: boolean;
  force: boolean;
  dryRun: boolean;
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateLabelBody(
  body: Record<string, unknown>,
): { ok: true; value: LabelInput } | { ok: false; error: string } {
  const raw = body.label;
  if (typeof raw !== "string") return { ok: false, error: "label must be a string" };
  // Mirrors Go's NewLabeledEvent: trim, then lowercase. A label that differs
  // only in case must not be able to point at a different version.
  const label = raw.trim().toLowerCase();
  if (label.length === 0 || label.length > MAX_LABEL_CHARS) {
    return { ok: false, error: `label must be 1..${MAX_LABEL_CHARS} characters` };
  }
  if (!LABEL_PATTERN.test(label)) {
    return { ok: false, error: "label must match [a-z0-9][a-z0-9._-]*" };
  }
  if (label === "latest") {
    // `latest` is COMPUTED (src/quality.ts's resolveLabels seeds it from the
    // highest version number). An explicit `latest` label event would override
    // that and let "latest" point at an older version — a trap, not a feature.
    return { ok: false, error: "'latest' is a computed label and cannot be set explicitly" };
  }

  const version = body.version;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) {
    return { ok: false, error: "version must be a positive integer" };
  }

  let minScore: string | null = null;
  if (body.min_score !== undefined && body.min_score !== null) {
    if (!isDecimalString(body.min_score)) {
      return { ok: false, error: "min_score must be a non-negative decimal string" };
    }
    minScore = body.min_score;
  }

  let scoreName: string | null = null;
  if (body.score_name !== undefined && body.score_name !== null) {
    scoreName = boundedText(body.score_name, MAX_PROMPT_NAME_CHARS);
    if (scoreName === null) {
      return { ok: false, error: `score_name must be a string of 1..${MAX_PROMPT_NAME_CHARS} characters` };
    }
  }
  if (minScore !== null && scoreName === null) {
    // A threshold with no score name would silently gate on whichever eval
    // happened to run last. Fail closed rather than guess which one was meant.
    return { ok: false, error: "score_name is required when min_score is given" };
  }

  const requireObservedRaw = body.require_observed;
  if (requireObservedRaw !== undefined && typeof requireObservedRaw !== "boolean") {
    return { ok: false, error: "require_observed must be a boolean" };
  }
  const requireObserved = requireObservedRaw === true;
  if (requireObserved && minScore === null) {
    // require_observed strengthens a gate; with no gate to strengthen it would
    // read as protection that is not actually running. Say so rather than
    // accept a request whose promise is empty.
    return { ok: false, error: "require_observed requires min_score and score_name" };
  }

  const force = body.force;
  if (force !== undefined && typeof force !== "boolean") {
    return { ok: false, error: "force must be a boolean" };
  }

  const dryRun = body.dry_run;
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return { ok: false, error: "dry_run must be a boolean" };
  }

  return {
    ok: true,
    value: {
      label,
      version: version as number,
      minScore,
      scoreName,
      requireObserved,
      force: force === true,
      dryRun: dryRun === true,
    },
  };
}

export interface SuggestInput {
  promptName: string;
  gatewayKey: string;
  model: string;
  sampleSize: number;
  maxScore: string;
  baseVersion: number | null;
  scoreName: string | null;
}

export function validateSuggestBody(
  body: Record<string, unknown>,
): { ok: true; value: SuggestInput } | { ok: false; error: string } {
  const promptName = boundedText(body.prompt_name, MAX_PROMPT_NAME_CHARS);
  if (promptName === null) {
    return { ok: false, error: `prompt_name must be a string of 1..${MAX_PROMPT_NAME_CHARS} characters` };
  }

  const gatewayKey = body.gateway_key;
  if (typeof gatewayKey !== "string" || gatewayKey.length === 0 || gatewayKey.length > 512) {
    return { ok: false, error: "gateway_key must be a non-empty string of at most 512 characters" };
  }

  const model = boundedText(body.model, MAX_MODEL_NAME_CHARS);
  if (model === null) {
    return { ok: false, error: `model must be a string of 1..${MAX_MODEL_NAME_CHARS} characters` };
  }

  let sampleSize = DEFAULT_SAMPLE_SIZE;
  if (body.sample_size !== undefined && body.sample_size !== null) {
    const raw = body.sample_size;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_SAMPLE_SIZE) {
      return { ok: false, error: `sample_size must be an integer between 1 and ${MAX_SAMPLE_SIZE}` };
    }
    sampleSize = raw as number;
  }

  let maxScore = DEFAULT_LOW_SCORE_THRESHOLD;
  if (body.max_score !== undefined && body.max_score !== null) {
    if (!isDecimalString(body.max_score)) {
      return { ok: false, error: "max_score must be a non-negative decimal string" };
    }
    maxScore = body.max_score;
  }

  let baseVersion: number | null = null;
  if (body.base_version !== undefined && body.base_version !== null) {
    if (!Number.isSafeInteger(body.base_version) || (body.base_version as number) <= 0) {
      return { ok: false, error: "base_version must be a positive integer" };
    }
    baseVersion = body.base_version as number;
  }

  let scoreName: string | null = null;
  if (body.score_name !== undefined && body.score_name !== null) {
    scoreName = boundedText(body.score_name, MAX_PROMPT_NAME_CHARS);
    if (scoreName === null) {
      return { ok: false, error: `score_name must be a string of 1..${MAX_PROMPT_NAME_CHARS} characters` };
    }
  }

  return { ok: true, value: { promptName, gatewayKey, model, sampleSize, maxScore, baseVersion, scoreName } };
}

// -- public views -----------------------------------------------------------------------------

function parseVersionsColumn(raw: string): number[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is number => Number.isSafeInteger(entry));
  } catch {
    return [];
  }
}

function runView(row: PlaygroundRunRow): Record<string, unknown> {
  return {
    id: row.id,
    prompt_name: row.prompt_name,
    versions: parseVersionsColumn(row.versions),
    model: row.model,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

// -- POST /v1/playground/run --------------------------------------------------------------------

interface RenderedVariant {
  version: number;
  variantIndex: number;
  body: string;
  hash: string;
}

interface CompletedVariant extends RenderedVariant {
  output: string;
  outputHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: string | null;
  latencyMs: number;
  responseText: string;
}

async function settleRun(
  env: PlaygroundEnv,
  workspaceId: string,
  runId: string,
  status: "done" | "error",
  settledAt: number,
): Promise<void> {
  try {
    await env.DB.prepare(SETTLE_RUN_SQL).bind(runId, workspaceId, status, settledAt).run();
  } catch (error) {
    logPlaygroundFailure("settle-run", error);
  }
}

/**
 * Persist the rendered prompt and the raw upstream response, but ONLY when the
 * virtual key was created with capture_tier "full". Failures are swallowed
 * after content-free logging: a body-capture write must never fail a run whose
 * evidence event already committed.
 */
async function captureBodies(
  env: PlaygroundEnv,
  workspaceId: string,
  record: GatewayKeyRecord,
  runId: string,
  variant: CompletedVariant,
  nowSeconds: number,
): Promise<void> {
  if (record.capture !== "full") return;
  const responseHash = await contentDigest(variant.responseText);
  const rows: { hash: string; role: "request" | "response"; body: string }[] = [
    { hash: variant.hash, role: "request", body: variant.body },
    { hash: responseHash, role: "response", body: variant.responseText },
  ];
  for (const row of rows) {
    try {
      await env.DB.prepare(INSERT_CAPTURE_BODY_SQL)
        .bind(workspaceId, row.hash, record.id, runId, row.role, row.body, nowSeconds)
        .run();
    } catch (error) {
      logPlaygroundFailure("capture-body", error);
    }
  }
}

async function runPlayground(
  request: Request,
  env: PlaygroundEnv,
  fetcher: FetchLike,
  now: () => number,
): Promise<Response> {
  // A playground run spends real money against a provider credential, so it
  // requires the platform's write capability — never a read-only principal.
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;
  const workspaceId = auth.device.workspaceId;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateRunBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  // 1. Resolve every requested version from the event spine. One
  //    workspace-scoped materialization collapses "unknown prompt" and
  //    "another workspace's prompt" into the same 404 (platform convention:
  //    scopeDenial in src/ingest.ts).
  const { byName } = await materializePromptEvents(env.DB, workspaceId);
  const aggregate = byName.get(input.promptName);
  if (aggregate === undefined) return json(404, { error: "prompt not found" });

  const rendered: RenderedVariant[] = [];
  for (const [variantIndex, version] of input.versions.entries()) {
    const record = findPromptVersion(aggregate, version);
    if (record === undefined) {
      return json(404, { error: "prompt version not found", version });
    }
    // 2. Substitute variables, fail-closed.
    const result = renderPromptBody(record.body, input.variables);
    if (!result.ok) {
      return json(400, { error: "missing_variables", missing: result.missing, version });
    }
    if (utf8Bytes(result.text) > MAX_RENDERED_BODY_BYTES) {
      return json(400, {
        error: `rendered prompt exceeds ${MAX_RENDERED_BODY_BYTES} bytes`,
        version,
      });
    }
    rendered.push({
      version,
      variantIndex,
      body: result.text,
      hash: await contentDigest(result.text),
    });
  }

  // 3. Resolve and gate the virtual key BEFORE creating a run row: a run that
  //    could never call anything should leave no trace.
  const startedAtMs = now();
  const createdAt = Math.floor(startedAtMs / 1000);
  const credential = await resolveGatewayCredential(env, workspaceId, input.gatewayKey, createdAt);
  if (!credential.ok) return credential.response;
  const { record, apiKey, baseUrl } = credential.value;

  // 4. The run's identity: everything that makes this the SAME experiment,
  //    including the exact bytes sent. Two runs differing only in a variable
  //    value are different runs and must not collide.
  const identity = await sha256Hex(
    canonicalJsonStringify({
      max_tokens: input.maxTokens,
      model: input.model,
      prompt_bodies: rendered.map((variant) => variant.hash),
      prompt_name: input.promptName,
      versions: input.versions,
      workspace_id: workspaceId,
    }),
  );
  const runId = await playgroundRunID(identity, startedAtMs);
  await env.DB.prepare(INSERT_RUN_SQL)
    .bind(
      runId,
      workspaceId,
      input.promptName,
      canonicalJsonStringify(input.versions),
      input.model,
      createdAt,
    )
    .run();

  // 5. Execute the variants in the order the caller asked for them.
  const completed: CompletedVariant[] = [];
  let failure: { reason: ModelCallFailure; status: number | null; version: number } | null = null;
  for (const variant of rendered) {
    const outcome = await callPlaygroundModel(
      fetcher,
      baseUrl,
      apiKey,
      input.model,
      variant.body,
      input.maxTokens,
      now,
    );
    if (!outcome.ok) {
      failure = { reason: outcome.reason, status: outcome.status, version: variant.version };
      break;
    }
    completed.push({
      ...variant,
      output: outcome.content,
      outputHash: await contentDigest(outcome.content),
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      cost: outcome.cost,
      latencyMs: outcome.latencyMs,
      responseText: outcome.responseText,
    });
  }

  // 6. Record the evidence for every variant that ACTUALLY RAN, including on a
  //    failed run. Those calls happened and those tokens were spent; dropping
  //    the record would hide real spend. The RESPONSE is still all-or-nothing
  //    (step 7) because a diff of one variant is not a diff.
  const recordedAt = Math.floor(now() / 1000);
  const variantViews: Record<string, unknown>[] = [];
  for (const variant of completed) {
    const event = await buildVariantEvent({
      runId,
      identity,
      promptName: input.promptName,
      version: variant.version,
      variantIndex: variant.variantIndex,
      model: input.model,
      promptHash: variant.hash,
      outputHash: variant.outputHash,
      tokensIn: variant.tokensIn,
      tokensOut: variant.tokensOut,
      cost: variant.cost,
      startedAtMs,
    });
    const recorded = await appendEvent(env, workspaceId, event, recordedAt);
    await captureBodies(env, workspaceId, record, runId, variant, recordedAt);
    variantViews.push({
      version: variant.version,
      output: variant.output,
      output_hash: variant.outputHash,
      prompt_hash: variant.hash,
      tokens: { input: variant.tokensIn, output: variant.tokensOut },
      cost: variant.cost,
      ...(variant.cost !== null ? { cost_provenance: "provider_reported" } : {}),
      latency_ms: variant.latencyMs,
      event_id: event.eventId,
      recorded,
    });
  }

  const settledAt = Math.max(Math.floor(now() / 1000), createdAt);

  // 7. Fail closed. A partial run returns the failure, never a "result" the
  //    caller could mistake for a completed comparison.
  if (failure !== null) {
    await settleRun(env, workspaceId, runId, "error", settledAt);
    return json(502, {
      error: failure.reason,
      run_id: runId,
      status: "error",
      failed_version: failure.version,
      upstream_status: failure.status,
      variants_recorded: variantViews.length,
    });
  }

  await settleRun(env, workspaceId, runId, "done", settledAt);
  const settled = await env.DB.prepare(RUN_BY_ID_SQL).bind(runId, workspaceId).first<PlaygroundRunRow>();

  return json(200, {
    run: settled === null ? null : runView(settled),
    variants: variantViews,
    diff:
      completed.length === 2
        ? diffSummary(completed[0].output, completed[1].output)
        : null,
    // Stated in the response, not just the docs: a consumer must never mistake
    // an absent stored body for a body we are withholding.
    content_policy:
      record.capture === "full" ? "bodies_captured_full" : "content_addressed_only",
  });
}

// -- GET /v1/playground/runs ----------------------------------------------------------------

function compareRunsDesc(a: PlaygroundRunRow, b: PlaygroundRunRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listRuns(request: Request, env: PlaygroundEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_RUNS_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<PlaygroundRunRow>()
      : await env.DB.prepare(LIST_RUNS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<PlaygroundRunRow>();

  // Re-sort in the Worker so the page never depends on storage order.
  const sorted = [...result.results].sort(compareRunsDesc);
  const rows = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = rows[rows.length - 1];

  return json(200, {
    items: rows.map(runView),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- POST /v1/prompts/{name}/labels ------------------------------------------------------------

async function repointLabel(
  request: Request,
  env: PlaygroundEnv,
  rawName: string,
  now: () => number,
): Promise<Response> {
  const auth = await authorizeWritePrincipal(request, env);
  if ("response" in auth) return auth.response;
  const { workspaceId } = auth;

  let promptName: string;
  try {
    promptName = decodeURIComponent(rawName).trim();
  } catch {
    return json(400, { error: "prompt name is not valid percent-encoding" });
  }
  if (promptName.length === 0 || promptName.length > MAX_PROMPT_NAME_CHARS) {
    return json(400, { error: `prompt name must be 1..${MAX_PROMPT_NAME_CHARS} characters` });
  }

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateLabelBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  const { byName } = await materializePromptEvents(env.DB, workspaceId);
  const aggregate = byName.get(promptName);
  if (aggregate === undefined) return json(404, { error: "prompt not found" });
  if (findPromptVersion(aggregate, input.version) === undefined) {
    // A label pointing at a version that does not exist would resolve to
    // nothing at read time — a silently broken deploy. Refuse up front.
    return json(404, { error: "prompt version not found", version: input.version });
  }

  let gate: GateAudit | null = null;
  if (input.minScore !== null && input.scoreName !== null) {
    const verdict = await evaluateEvalGate(
      env.DB,
      workspaceId,
      promptName,
      input.version,
      input.scoreName,
      input.minScore,
      input.requireObserved,
    );
    gate = {
      score_name: input.scoreName,
      min_score: input.minScore,
      latest_score: verdict.latestScore,
      latest_score_event_id: verdict.latestScoreEventId,
      // Recorded on every gated repoint, pass or fail, forced or not. A
      // promotion audit that says "0.91 cleared 0.80" without saying an LLM
      // judge produced the 0.91 is an OBSERVED event making an INFERRED claim.
      latest_score_provenance: verdict.latestScoreProvenance,
      require_observed: input.requireObserved,
      passed: verdict.passed,
      forced: !verdict.passed && input.force,
    };
    if (!verdict.passed && !input.force) {
      return json(409, {
        error: "eval_gate_failed",
        // `reason` distinguishes "nothing ever scored this version" from "it
        // scored too low" from "it cleared the bar, but on a score this gate
        // does not accept as observed evidence" — three different things for
        // a CI log to say, and three different fixes.
        reason: verdict.reason,
        latest_score: verdict.latestScore,
        latest_score_provenance: verdict.latestScoreProvenance,
        require_observed: input.requireObserved,
        min_score: input.minScore,
        score_name: input.scoreName,
        prompt_name: promptName,
        version: input.version,
      });
    }
  }

  if (input.dryRun) {
    // Every check ran; nothing was appended. This is what a PR check wants:
    // "would this promotion pass?" answered without promoting — and it is the
    // ONLY validation primitive an sk_ key can reach, since the prompt read
    // routes in src/quality.ts are device-token-only. See docs/prompt-cicd.md.
    return json(200, {
      dry_run: true,
      would_apply: true,
      label: { name: promptName, label: input.label, version: input.version },
      gate,
    });
  }

  const atMs = now();
  const event = await buildLabelEvent({
    promptName,
    label: input.label,
    version: input.version,
    atMs,
    gate,
  });
  const recorded = await appendEvent(env, workspaceId, event, Math.floor(atMs / 1000));
  if (!recorded) {
    // The spine refused the write (an id already carries different bytes). The
    // label did NOT move, so say so rather than returning a 201 the caller
    // would read as a successful deploy.
    return json(409, { error: "label_event_conflict", event_id: event.eventId });
  }

  return json(201, {
    label: { name: promptName, label: input.label, version: input.version },
    event_id: event.eventId,
    provenance: "OBSERVED",
    gate,
    // Rollback is the same operation: POST this route again naming an earlier
    // version. There is no separate rollback endpoint to keep in sync.
    rollback_hint: `POST /v1/prompts/${encodeURIComponent(promptName)}/labels with an earlier version`,
  });
}

// -- POST /v1/prompt-optimizer/suggest (parity row 30) --------------------------------------------

/**
 * The optimizer's system prompt. Two rules do the work: return ONE improved
 * variant (a menu of options is a decision the model is not entitled to make
 * for the operator), and reply as a single JSON object so an unreadable answer
 * is a clean failure rather than a guessed suggestion.
 */
export function optimizerPrompt(
  promptName: string,
  baseVersion: number,
  body: string,
  evidence: LinkedScore[],
): string {
  const rendered = evidence.length === 0
    ? "(no low-scoring evaluations are linked to this prompt version)"
    : evidence
        .map((score, index) => `${index + 1}. score ${score.name}=${score.value}: ${score.comment}`)
        .join("\n");
  return [
    "You improve prompts for an AI system, using recorded evaluation results.",
    `Prompt name: ${promptName} (version ${baseVersion})`,
    "Current prompt body:",
    body,
    "Recent low-scoring evaluations of this version:",
    rendered,
    "Rules:",
    "- Propose exactly ONE improved prompt body.",
    "- Preserve every {{variable}} placeholder that appears in the current body.",
    "- Do not invent new placeholders.",
    'Reply with ONLY a JSON object of the form {"suggested_body":"<the full improved prompt>","rationale":"<one or two sentences>"}.',
    "Do not wrap it in prose.",
  ].join("\n");
}

const FENCE_PATTERN = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n?```$/;

export interface Suggestion {
  suggestedBody: string;
  rationale: string;
}

/**
 * Parse the optimizer's reply, FAIL-CLOSED. Every path that is not an
 * unambiguous suggestion returns null, and a null suggestion is a 502 with
 * nothing appended — inventing a rewrite would put a fabricated INFERRED
 * proposal on the spine, which is strictly worse than reporting that the model
 * could not be read.
 *
 * The only tolerance is one surrounding markdown code fence: that is a
 * formatting habit, not an ambiguity. No brace-scanning, no "find the JSON
 * somewhere in the prose" (same rule as simulations.ts's parseJudgeVerdict).
 */
export function parseSuggestion(content: string): Suggestion | null {
  const trimmed = content.trim();
  const fenced = FENCE_PATTERN.exec(trimmed);
  const source = fenced === null ? trimmed : fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const suggestedBody = parsed.suggested_body;
  if (typeof suggestedBody !== "string" || suggestedBody.trim().length === 0) return null;
  if (utf8Bytes(suggestedBody) > MAX_RENDERED_BODY_BYTES) return null;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  return { suggestedBody, rationale: rationale.slice(0, MAX_RATIONALE_CHARS) };
}

async function suggestPrompt(
  request: Request,
  env: PlaygroundEnv,
  fetcher: FetchLike,
  now: () => number,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;
  const workspaceId = auth.device.workspaceId;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateSuggestBody(body);
  if (!validated.ok) return json(400, { error: validated.error });
  const input = validated.value;

  const { byName } = await materializePromptEvents(env.DB, workspaceId);
  const aggregate = byName.get(input.promptName);
  if (aggregate === undefined) return json(404, { error: "prompt not found" });
  const baseVersion = input.baseVersion ?? latestVersion(aggregate);
  const record = findPromptVersion(aggregate, baseVersion);
  if (record === undefined) {
    return json(404, { error: "prompt version not found", version: baseVersion });
  }

  // Evidence: the most recent low-scoring evaluations linked to THIS version.
  // Ascending order from loadLinkedScores, so the tail is the newest.
  const linked = await loadLinkedScores(
    env.DB,
    workspaceId,
    input.promptName,
    baseVersion,
    input.scoreName,
  );
  const low = linked.filter((score) => compareDecimalStrings(score.value, input.maxScore) <= 0);
  const evidence = low.slice(Math.max(0, low.length - input.sampleSize));

  const nowSeconds = Math.floor(now() / 1000);
  const credential = await resolveGatewayCredential(env, workspaceId, input.gatewayKey, nowSeconds);
  if (!credential.ok) return credential.response;

  const outcome = await callPlaygroundModel(
    fetcher,
    credential.value.baseUrl,
    credential.value.apiKey,
    input.model,
    optimizerPrompt(input.promptName, baseVersion, record.body, evidence),
    null,
    now,
  );
  if (!outcome.ok) {
    return json(502, { error: outcome.reason, upstream_status: outcome.status });
  }
  const suggestion = parseSuggestion(outcome.content);
  if (suggestion === null) {
    return json(502, { error: "unparseable_suggestion" });
  }

  const atMs = now();
  const suggestedBodyHash = await contentDigest(suggestion.suggestedBody);
  const event = await buildSuggestionEvent({
    promptName: input.promptName,
    baseVersion,
    model: input.model,
    suggestedBodyHash,
    rationaleHash: await contentDigest(suggestion.rationale),
    rationaleSummary: suggestion.rationale,
    sampleSize: evidence.length,
    evidenceEventIds: evidence.map((score) => score.event_id),
    atMs,
  });
  const recorded = await appendEvent(env, workspaceId, event, Math.floor(atMs / 1000));

  return json(200, {
    suggestion: {
      prompt_name: input.promptName,
      base_version: baseVersion,
      base_hash: record.hash,
      suggested_body: suggestion.suggestedBody,
      suggested_body_hash: suggestedBodyHash,
      rationale: suggestion.rationale,
      model: input.model,
      evidence_event_ids: evidence.map((score) => score.event_id),
      sample_size: evidence.length,
    },
    // Stated explicitly in the response, every time. A model's proposal is
    // never an observation, and a caller must not have to consult the docs to
    // learn that.
    provenance: "INFERRED",
    // Nothing was applied and nothing will be: creating a new prompt version
    // and repointing a label are separate, human-initiated calls.
    auto_applied: false,
    next_step: `POST /v1/prompts/${encodeURIComponent(input.promptName)}/labels (eval-gated) after creating a new version`,
    event_id: event.eventId,
    recorded,
  });
}

// -- routing ---------------------------------------------------------------------------------------

/**
 * Route the playground / prompt-CI/CD / optimizer surface. Returns null when
 * this module does not own the path — and also when it owns the path but not
 * the method, so the platform-wide catch-all in index.ts answers the 404
 * (house rule; see observations.ts).
 *
 * `fetcher` and `now` are injected so tests never touch the network or a real
 * clock; index.ts calls this with two arguments and gets the defaults.
 */
export async function handlePlaygroundRoute(
  request: Request,
  env: PlaygroundEnv,
  fetcher: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === RUN_PATH) {
    if (request.method === "POST") return await runPlayground(request, env, fetcher, now);
    return null;
  }

  if (pathname === RUNS_PATH) {
    if (request.method === "GET") return await listRuns(request, env);
    return null;
  }

  if (pathname === SUGGEST_PATH) {
    if (request.method === "POST") return await suggestPrompt(request, env, fetcher, now);
    return null;
  }

  const labelsMatch = LABELS_PATH_PATTERN.exec(pathname);
  if (labelsMatch !== null) {
    if (request.method === "POST") return await repointLabel(request, env, labelsMatch[1], now);
    return null;
  }

  return null;
}
