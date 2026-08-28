// Hosted sessions + wide span observations (parity-plan rows 9, 10, 11).
//
// This module owns three derived read models on D1 and the routes that read
// and rebuild them:
//
//   span_observations  one wide, denormalized row per span identity;
//   span_fingerprints  the tiny identity-label lookup table;
//   sessions           first-class hosted session tracking.
//
// Design provenance (ideas only — no code, config, or schema copied from any
// AGPL/ELv2 project):
//   row 9  the observations-first wide row is the Langfuse V4 lesson: a hot
//          read must not join traces against spans. On our spine the event
//          envelope already carries workstream/session/provider/agent/model,
//          so the denormalization is a straight copy rather than a lookup.
//   row 10 ts_bucket pruning is the SigNoz/OpenObserve lesson: a stored
//          bucket column lets the index skip whole time ranges before the
//          exact predicate runs. Every time-bounded query here emits BOTH.
//   row 11 resource fingerprints are a hash of SORTED label pairs, which is
//          what makes the fingerprint a pure function of the labels. Field
//          derivation mirrors internal/observations + internal/trace in Go.
//
// Determinism contract: the projection is a pure function of event CONTENT.
// Nothing here reads clocks, map iteration order, or row ids. Each event that
// touches a span/session emits its own delta row; the D1 upserts merge those
// deltas with monotone rules (earliest start wins, latest completion wins,
// highest status rank wins, MIN/MAX on bounds, absolute recomputes for
// counters). Because the merge is order-independent and idempotent, replaying
// a batch, re-ordering batches, and rebuilding from scratch all converge on
// byte-identical rows. Migration 0005 encodes the same invariants as triggers
// so a future upsert bug aborts instead of writing an order-dependent model.
//
// Integer discipline: started_at_ns/ended_at_ns are int64 UNIX NANOSECONDS and
// exceed the JavaScript safe-integer range. They are carried as decimal
// STRINGS end to end (bind -> CAST(... AS INTEGER); read back via
// CAST(... AS TEXT)) and are never round-tripped through a float. Money is a
// decimal string for the same reason plus the provenance rule: a cost without
// a provenance label is not recorded at all.

import {
  authenticate,
  hasCapability,
  sha256Hex,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  canonicalJsonStringify,
  scopeDenial,
  type IngestEvent,
  type Validation,
} from "./ingest";

// -- limits -------------------------------------------------------------------

/** 30-minute time buckets, in each table's native unit (see migration 0005). */
export const OBSERVATION_BUCKET_NS = 1_800_000_000_000n;
export const SESSION_BUCKET_MS = 1_800_000;

export const MAX_SPAN_ID_BYTES = 128;
export const MAX_TRACE_ID_BYTES = 128;
export const MAX_SPAN_KIND_BYTES = 32;
export const MAX_SPAN_NAME_BYTES = 200;
export const MAX_TOOL_NAME_BYTES = 128;
export const MAX_AGENT_BYTES = 64;
export const MAX_MODEL_BYTES = 128;
export const MAX_REPO_BYTES = 256;
export const MAX_HOST_BYTES = 128;
export const MAX_COST_AMOUNT_BYTES = 40;
export const MAX_TOKEN_COUNT = 1_000_000_000_000;

/** Rebuild ceiling: one reindex must fit a Worker invocation, so it is bounded. */
export const MAX_REINDEX_EVENTS = 20_000;
export const REINDEX_SCAN_PAGE = 1_000;
export const REINDEX_CHUNK_ROWS = 250;

const UTF8_ENCODER = new TextEncoder();
const RFC3339_PARTS =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;
const MAX_TIMESTAMP_CHARS = 35;

const SESSION_ID_PATH = /^\/v1\/sessions\/(ses_[0-7][0-9A-HJKMNP-TV-Z]{25})$/;

const DECIMAL_AMOUNT = /^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,9})?$/;
const COST_PROVENANCE = new Set(["provider_reported", "catalog_estimate", "user_supplied"]);

const SPAN_STATUSES = ["unknown", "running", "ok", "error"] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];
const STATUS_RANK: Record<SpanStatus, number> = { unknown: 0, running: 1, ok: 2, error: 3 };
const SPAN_STATUS_SET = new Set<string>(SPAN_STATUSES);

// Attribute-existence flags (migration 0005) exposed as `?has=` filters. A Map,
// not an object: `"constructor" in {}` is true, so an object lookup would let a
// query string reach an inherited property and interpolate it into SQL.
const EXISTS_COLUMNS = new Map<string, string>([
  ["cost", "cost_exists"],
  ["exit_code", "exit_code_exists"],
  ["model", "model_exists"],
  ["token", "token_exists"],
  ["tool_name", "tool_name_exists"],
]);

// -- time ---------------------------------------------------------------------

export interface EventTime {
  /** Unix nanoseconds as a decimal string (int64 exceeds Number.MAX_SAFE_INTEGER). */
  ns: string;
  /** Unix milliseconds; always a safe integer. */
  ms: number;
}

/**
 * Parse an RFC 3339 timestamp to exact nanoseconds.
 *
 * Date.parse only resolves milliseconds, so the whole-second prefix is parsed
 * with Date.parse and the fractional digits are added as exact integers. Times
 * before the epoch are rejected: SQLite integer division truncates toward zero,
 * so a negative nanosecond value would land in the wrong 30-minute bucket. The
 * raw event is unaffected — only the derived row is skipped.
 */
export function parseEventTime(value: unknown): EventTime | null {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_CHARS) return null;
  const parts = RFC3339_PARTS.exec(value);
  if (parts === null) return null;
  const zone = parts[4] === "z" ? "Z" : parts[4];
  const wholeMs = Date.parse(`${parts[1]}T${parts[2]}${zone}`);
  if (!Number.isFinite(wholeMs)) return null;
  const seconds = wholeMs / 1000;
  if (!Number.isSafeInteger(seconds)) return null;
  const fraction = (parts[3] ?? "").padEnd(9, "0");
  const ns = BigInt(seconds) * 1_000_000_000n + BigInt(fraction);
  if (ns < 0n) return null;
  return { ns: ns.toString(), ms: Number(ns / 1_000_000n) };
}

/** Floor a decimal-string nanosecond value into its 30-minute bucket. */
export function observationBucket(ns: string): number {
  return Number(BigInt(ns) / OBSERVATION_BUCKET_NS);
}

/** Floor a millisecond value into its 30-minute bucket. */
export function sessionBucket(ms: number): number {
  return Math.floor(ms / SESSION_BUCKET_MS);
}

// -- fingerprints -------------------------------------------------------------

export interface ResourceLabels {
  agent: string | null;
  host: string | null;
  model: string | null;
  provider: string | null;
  repo: string | null;
}

/**
 * Hash the identity label tuple: sha256 over SORTED `key=value` pairs, joined
 * with NUL, truncated to 12 bytes (24 lowercase hex chars). Sorting is what
 * makes the same tuple always produce the same fingerprint. This mirrors the
 * local Go construction (provider/agent/model) and extends it with the
 * repo/host labels the hosted plane can observe.
 */
export async function resourceFingerprint(labels: ResourceLabels): Promise<string> {
  const pairs = [
    `agent=${labels.agent ?? ""}`,
    `host=${labels.host ?? ""}`,
    `model=${labels.model ?? ""}`,
    `provider=${labels.provider ?? ""}`,
    `repo=${labels.repo ?? ""}`,
  ].sort();
  const digest = await sha256Hex(pairs.join("\u0000"));
  return digest.slice(0, 24);
}

// -- projection ---------------------------------------------------------------

/** One event's contribution to a span_observations row. */
export interface SpanObservationDelta {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  session_id: string | null;
  native_session_id: string | null;
  workstream_id: string | null;
  provider: string | null;
  agent: string | null;
  model: string | null;
  kind: string;
  name: string;
  status: SpanStatus;
  status_rank: number;
  started_at_ns: string;
  start_event_id: string;
  ended_at_ns: string | null;
  end_event_id: string | null;
  tool_name: string | null;
  exit_code: number | null;
  token_in: number | null;
  token_out: number | null;
  cost_amount: string | null;
  cost_provenance: string | null;
  fingerprint: string;
}

/** One event's contribution to a span_fingerprints row. */
export interface FingerprintDelta {
  fingerprint: string;
  provider: string | null;
  agent: string | null;
  repo: string | null;
  host: string | null;
  model: string | null;
  first_seen: number;
  last_seen: number;
}

/** One event's contribution to a sessions row. */
export interface SessionDelta {
  id: string;
  workstream_id: string | null;
  provider: string | null;
  native_session_id: string | null;
  first_event_at_ms: number;
  first_event_id: string;
  last_event_at_ms: number;
  last_event_id: string;
}

export interface ObservationProjection {
  spans: SpanObservationDelta[];
  fingerprints: FingerprintDelta[];
  sessions: SessionDelta[];
}

interface SpanShape {
  /** span.started opens a span; every other shape closes one. */
  start: boolean;
  status: SpanStatus;
  /** Non-null when the event kind dictates the span kind (Go promotes these). */
  forcedKind: string | null;
}

/**
 * Classify an event as a span contribution, mirroring internal/trace's
 * Materialize: span.* events are spans directly, while command/test/file
 * evidence events are PROMOTED to spans so a failing test or a non-zero exit
 * is visible in the observation model.
 */
function spanShapeFor(kind: string, payload: Record<string, unknown> | null): SpanShape | null {
  switch (kind) {
    case "span.started":
      return { start: true, status: "running", forcedKind: null };
    case "span.completed":
      return { start: false, status: "ok", forcedKind: null };
    case "span.failed":
      return { start: false, status: "error", forcedKind: null };
    case "command.completed": {
      const exit = boundedInt(payload, "exit_code");
      return {
        start: false,
        status: exit !== null && exit !== 0 ? "error" : "ok",
        forcedKind: "COMMAND",
      };
    }
    case "test.completed": {
      const exit = boundedInt(payload, "exit_code");
      const result = payloadString(payload, "result");
      return {
        start: false,
        status: result === "failed" || (exit !== null && exit !== 0) ? "error" : "ok",
        forcedKind: "TEST",
      };
    }
    case "file.read":
      return { start: false, status: "ok", forcedKind: "FILE_READ" };
    case "file.created":
    case "file.edited":
    case "file.deleted":
      return { start: false, status: "ok", forcedKind: "FILE_WRITE" };
    default:
      return null;
  }
}

/**
 * Derive the deterministic projection deltas for a set of events.
 *
 * One delta per contributing event — the merge lives exclusively in the D1
 * upserts, so incremental ingestion and a full rebuild run the SAME merge and
 * cannot drift. Arrays are sorted by their canonical encoding so identical
 * inputs produce byte-identical binds.
 */
export async function buildObservationProjection(
  events: readonly IngestEvent[],
): Promise<ObservationProjection> {
  const spans: SpanObservationDelta[] = [];
  const fingerprints: FingerprintDelta[] = [];
  const sessions: SessionDelta[] = [];
  // A batch usually shares one or two label tuples; hashing each tuple once
  // keeps the digest count proportional to distinct resources, not to events.
  // The cache lives for one call, so it cannot leak across workspaces.
  const printCache = new Map<string, string>();

  for (const event of events) {
    const at = parseEventTime(event.occurred_at);
    if (at === null) continue;
    const eventID = optionalString(event.event_id);
    if (eventID === null) continue;
    const payload = payloadRecord(event.payload);

    const sessionID = bounded(optionalString(event.session_id), MAX_SPAN_ID_BYTES);
    const nativeSessionID = bounded(optionalString(event.native_session_id), 256);
    const workstreamID = bounded(optionalString(event.workstream_id), MAX_SPAN_ID_BYTES);
    const provider = bounded(optionalString(event.provider), MAX_AGENT_BYTES);
    const agent = bounded(optionalString(event.agent), MAX_AGENT_BYTES);
    const model = bounded(optionalString(event.model), MAX_MODEL_BYTES);

    if (sessionID !== null) {
      sessions.push({
        id: sessionID,
        workstream_id: workstreamID,
        provider,
        native_session_id: nativeSessionID,
        first_event_at_ms: at.ms,
        first_event_id: eventID,
        last_event_at_ms: at.ms,
        last_event_id: eventID,
      });
    }

    const shape = spanShapeFor(event.kind, payload);
    if (shape === null) continue;

    const spanID =
      bounded(payloadString(payload, "span_id"), MAX_SPAN_ID_BYTES) ??
      (shape.start ? null : bounded(firstParent(event), MAX_SPAN_ID_BYTES)) ??
      eventID;
    // Go resolves an absent trace_id to the session; keep the event id as the
    // last resort so the wide row always has a correlation handle.
    const traceID =
      bounded(payloadString(payload, "trace_id"), MAX_TRACE_ID_BYTES) ?? sessionID ?? eventID;
    const parent = bounded(
      payloadString(payload, "parent_span_id") ?? firstParent(event),
      MAX_SPAN_ID_BYTES,
    );
    const kind =
      shape.forcedKind ??
      bounded(
        payloadString(payload, "kind") ?? payloadString(payload, "span_kind"),
        MAX_SPAN_KIND_BYTES,
      ) ??
      "OTHER";
    const name = bounded(spanName(event.kind, payload), MAX_SPAN_NAME_BYTES) ?? event.kind;
    const repo = bounded(gitRemote(event) ?? optionalString(event.repository_id), MAX_REPO_BYTES);
    const host = bounded(
      optionalString(event.host) ?? payloadString(payload, "host"),
      MAX_HOST_BYTES,
    );
    const labels: ResourceLabels = { agent, host, model, provider, repo };
    const labelKey = canonicalJsonStringify(labels);
    let fingerprint = printCache.get(labelKey);
    if (fingerprint === undefined) {
      fingerprint = await resourceFingerprint(labels);
      printCache.set(labelKey, fingerprint);
    }
    const cost = costOf(payload);

    spans.push({
      span_id: spanID,
      trace_id: traceID,
      parent_span_id: parent === spanID ? null : parent,
      session_id: sessionID,
      native_session_id: nativeSessionID,
      workstream_id: workstreamID,
      provider,
      agent,
      model,
      kind,
      name,
      status: shape.status,
      status_rank: STATUS_RANK[shape.status],
      // Every contributing event supplies its own timestamp as the start
      // candidate; the upsert keeps the MIN. A lone completion therefore
      // still yields a usable row (Go synthesizes the same orphan span).
      started_at_ns: at.ns,
      start_event_id: eventID,
      ended_at_ns: shape.start ? null : at.ns,
      end_event_id: shape.start ? null : eventID,
      tool_name: bounded(payloadString(payload, "tool_name"), MAX_TOOL_NAME_BYTES),
      exit_code: boundedInt(payload, "exit_code"),
      token_in: tokenCount(payload, "token_input"),
      token_out: tokenCount(payload, "token_output"),
      cost_amount: cost === null ? null : cost.amount,
      cost_provenance: cost === null ? null : cost.provenance,
      fingerprint,
    });

    fingerprints.push({
      fingerprint,
      provider,
      agent,
      repo,
      host,
      model,
      first_seen: at.ms,
      last_seen: at.ms,
    });
  }

  return {
    spans: sortCanonically(spans),
    fingerprints: sortCanonically(fingerprints),
    sessions: sortCanonically(sessions),
  };
}

/** Total order over rows: sort by canonical encoding, never by insertion. */
function sortCanonically<T>(rows: T[]): T[] {
  return rows
    .map((row) => ({ row, key: canonicalJsonStringify(row) }))
    .sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1))
    .map((entry) => entry.row);
}

function spanName(kind: string, payload: Record<string, unknown> | null): string | null {
  if (kind === "command.completed") {
    return payloadString(payload, "command") ?? payloadString(payload, "name");
  }
  if (kind.startsWith("file.")) {
    return payloadString(payload, "path") ?? payloadString(payload, "file_path");
  }
  return payloadString(payload, "name");
}

function gitRemote(event: IngestEvent): string | null {
  const git = event.git;
  if (git === null || typeof git !== "object" || Array.isArray(git)) return null;
  return optionalString((git as Record<string, unknown>).remote);
}

function firstParent(event: IngestEvent): string | null {
  const parents = event.parent_event_ids;
  if (!Array.isArray(parents) || parents.length === 0) return null;
  return optionalString(parents[0]);
}

/**
 * A cost is recorded only when BOTH a decimal-string amount and a known
 * provenance label are present (the Go applyUsage discipline). An unlabelled
 * or 'unknown'-labelled cost is dropped: cost is a recorded fact with a
 * source, never an estimate that renders as observed.
 */
function costOf(
  payload: Record<string, unknown> | null,
): { amount: string; provenance: string } | null {
  const amount = payloadString(payload, "cost_amount");
  const provenance = payloadString(payload, "cost_provenance");
  if (amount === null || provenance === null) return null;
  if (exceedsUtf8Bytes(amount, MAX_COST_AMOUNT_BYTES)) return null;
  if (!DECIMAL_AMOUNT.test(amount)) return null;
  if (!COST_PROVENANCE.has(provenance)) return null;
  return { amount, provenance };
}

function tokenCount(payload: Record<string, unknown> | null, field: string): number | null {
  if (payload === null) return null;
  const value = payload[field];
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKEN_COUNT) return null;
  return value;
}

function boundedInt(payload: Record<string, unknown> | null, field: string): number | null {
  if (payload === null) return null;
  const value = payload[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < -2_147_483_648 || value > 2_147_483_647) return null;
  return value;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function payloadString(payload: Record<string, unknown> | null, field: string): string | null {
  return payload === null ? null : optionalString(payload[field]);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bounded(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  return exceedsUtf8Bytes(value, maxBytes) ? null : value;
}

function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return value.length > maxBytes || UTF8_ENCODER.encode(value).byteLength > maxBytes;
}

// -- projection SQL -----------------------------------------------------------

/**
 * `excluded` carries the incoming delta; the bare table name carries the row
 * already stored. Earliest start wins, with the event id as a total-order
 * tiebreaker so the winner never depends on arrival order.
 */
const START_WINS = `(excluded.started_at_ns < span_observations.started_at_ns
        OR (excluded.started_at_ns = span_observations.started_at_ns
            AND excluded.start_event_id < span_observations.start_event_id))`;

/** Latest completion wins; a delta with no completion never displaces one. */
const END_WINS = `(excluded.ended_at_ns IS NOT NULL
        AND (span_observations.ended_at_ns IS NULL
             OR excluded.ended_at_ns > span_observations.ended_at_ns
             OR (excluded.ended_at_ns = span_observations.ended_at_ns
                 AND excluded.end_event_id > span_observations.end_event_id)))`;

/** Non-null values are preferred; ties broken by the given precedence rule. */
function preferring(table: string, column: string, wins: string): string {
  return `${column} = CASE
      WHEN excluded.${column} IS NULL THEN ${table}.${column}
      WHEN ${table}.${column} IS NULL THEN excluded.${column}
      WHEN ${wins} THEN excluded.${column}
      ELSE ${table}.${column}
    END`;
}

function governedBy(table: string, column: string, wins: string): string {
  return `${column} = CASE WHEN ${wins} THEN excluded.${column} ELSE ${table}.${column} END`;
}

const SPAN_DELTA_COLUMNS = [
  "span_id",
  "trace_id",
  "parent_span_id",
  "session_id",
  "native_session_id",
  "workstream_id",
  "provider",
  "agent",
  "model",
  "kind",
  "name",
  "status",
  "status_rank",
  "started_at_ns",
  "start_event_id",
  "ended_at_ns",
  "end_event_id",
  "tool_name",
  "exit_code",
  "token_in",
  "token_out",
  "cost_amount",
  "cost_provenance",
  "fingerprint",
] as const;

/** Nanosecond columns arrive as decimal strings and are CAST at the boundary. */
const NANOSECOND_DELTA_COLUMNS = new Set<string>(["started_at_ns", "ended_at_ns"]);

const SPAN_DELTA_SELECT = SPAN_DELTA_COLUMNS.map((column) =>
  NANOSECOND_DELTA_COLUMNS.has(column)
    ? `    CAST(json_extract(o.value, '$.${column}') AS INTEGER)`
    : `    json_extract(o.value, '$.${column}')`,
).join(",\n");

export const UPSERT_SPAN_OBSERVATIONS_SQL = `
  INSERT INTO span_observations
    (workspace_id, ${SPAN_DELTA_COLUMNS.join(", ")})
  SELECT /* observations:upsert-spans */
    ?1,
${SPAN_DELTA_SELECT}
  FROM json_each(?2) AS o
  WHERE json_extract(o.value, '$.span_id') IS NOT NULL
  ON CONFLICT(workspace_id, span_id) DO UPDATE SET
    ${governedBy("span_observations", "trace_id", START_WINS)},
    ${preferring("span_observations", "parent_span_id", START_WINS)},
    ${preferring("span_observations", "session_id", START_WINS)},
    ${preferring("span_observations", "native_session_id", START_WINS)},
    ${preferring("span_observations", "workstream_id", START_WINS)},
    ${preferring("span_observations", "provider", START_WINS)},
    ${preferring("span_observations", "agent", START_WINS)},
    ${preferring("span_observations", "model", START_WINS)},
    ${preferring("span_observations", "tool_name", START_WINS)},
    ${governedBy("span_observations", "kind", START_WINS)},
    ${governedBy("span_observations", "name", START_WINS)},
    ${governedBy("span_observations", "fingerprint", START_WINS)},
    status = CASE
      WHEN excluded.status_rank > span_observations.status_rank THEN excluded.status
      ELSE span_observations.status
    END,
    status_rank = MAX(span_observations.status_rank, excluded.status_rank),
    started_at_ns = MIN(span_observations.started_at_ns, excluded.started_at_ns),
    ${governedBy("span_observations", "start_event_id", START_WINS)},
    ${governedBy("span_observations", "ended_at_ns", END_WINS)},
    ${governedBy("span_observations", "end_event_id", END_WINS)},
    ${preferring("span_observations", "exit_code", END_WINS)},
    ${preferring("span_observations", "token_in", END_WINS)},
    ${preferring("span_observations", "token_out", END_WINS)},
    ${preferring("span_observations", "cost_amount", END_WINS)},
    ${preferring("span_observations", "cost_provenance", END_WINS)}
  WHERE span_observations.workspace_id = excluded.workspace_id`;

// Labels are the fingerprint's preimage, so they are inserted once and never
// updated (migration 0005 has a trigger that aborts label drift). Only the
// observed-at bounds widen, and MIN/MAX are order-independent and idempotent.
export const UPSERT_SPAN_FINGERPRINTS_SQL = `
  INSERT INTO span_fingerprints
    (workspace_id, fingerprint, provider, agent, repo, host, model, first_seen, last_seen)
  SELECT /* observations:upsert-fingerprints */
    ?1,
    json_extract(f.value, '$.fingerprint'),
    json_extract(f.value, '$.provider'),
    json_extract(f.value, '$.agent'),
    json_extract(f.value, '$.repo'),
    json_extract(f.value, '$.host'),
    json_extract(f.value, '$.model'),
    json_extract(f.value, '$.first_seen'),
    json_extract(f.value, '$.last_seen')
  FROM json_each(?2) AS f
  WHERE json_extract(f.value, '$.fingerprint') IS NOT NULL
  ON CONFLICT(workspace_id, fingerprint) DO UPDATE SET
    first_seen = MIN(span_fingerprints.first_seen, excluded.first_seen),
    last_seen = MAX(span_fingerprints.last_seen, excluded.last_seen)
  WHERE span_fingerprints.workspace_id = excluded.workspace_id`;

const SESSION_FIRST_WINS = `(excluded.first_event_at_ms < sessions.first_event_at_ms
        OR (excluded.first_event_at_ms = sessions.first_event_at_ms
            AND excluded.first_event_id < sessions.first_event_id))`;

const SESSION_LAST_WINS = `(excluded.last_event_at_ms > sessions.last_event_at_ms
        OR (excluded.last_event_at_ms = sessions.last_event_at_ms
            AND excluded.last_event_id > sessions.last_event_id))`;

// Counters are ABSOLUTE recomputes, never increments: an increment would
// double-count the same events replayed under a fresh Idempotency-Key. Event
// counts come from the append-only log; span counts come from the wide table,
// which is written earlier in the same D1 batch. Both only ever grow for a
// given event set, so MAX keeps the merge monotone (and matches the triggers).
//
// Cost of that choice, stated explicitly: each batch re-counts the touched
// sessions' full history through the (workspace_id, session_id, kind) and
// (workspace_id, session_id, ts_bucket) indexes — index-only scans, but O(events
// in the session) rather than O(events in the batch). Idempotency is worth more
// than the constant here; if a session's history ever outgrows that, the fix is
// a watermark column, not an increment.
export const UPSERT_SESSIONS_SQL = `
  INSERT INTO sessions
    (id, workspace_id, workstream_id, provider, native_session_id,
     first_event_at_ms, first_event_id, last_event_at_ms, last_event_id,
     event_count, trace_count, span_count, failed_span_count)
  SELECT /* observations:upsert-sessions */
    json_extract(s.value, '$.id'),
    ?1,
    json_extract(s.value, '$.workstream_id'),
    json_extract(s.value, '$.provider'),
    json_extract(s.value, '$.native_session_id'),
    json_extract(s.value, '$.first_event_at_ms'),
    json_extract(s.value, '$.first_event_id'),
    json_extract(s.value, '$.last_event_at_ms'),
    json_extract(s.value, '$.last_event_id'),
    COALESCE(logged.event_count, 0),
    COALESCE(logged.trace_count, 0),
    COALESCE(observed.span_count, 0),
    COALESCE(observed.failed_span_count, 0)
  FROM json_each(?2) AS s
  LEFT JOIN (
    SELECT e.session_id AS session_id,
           COUNT(*) AS event_count,
           SUM(CASE WHEN e.kind = 'trace.started' THEN 1 ELSE 0 END) AS trace_count
    FROM events AS e
    WHERE e.workspace_id = ?1
      AND e.session_id IN (SELECT json_extract(k.value, '$.id') FROM json_each(?2) AS k)
    GROUP BY e.session_id
  ) AS logged ON logged.session_id = json_extract(s.value, '$.id')
  LEFT JOIN (
    SELECT o.session_id AS session_id,
           COUNT(*) AS span_count,
           SUM(CASE WHEN o.status = 'error' THEN 1 ELSE 0 END) AS failed_span_count
    FROM span_observations AS o
    WHERE o.workspace_id = ?1
      AND o.session_id IN (SELECT json_extract(k.value, '$.id') FROM json_each(?2) AS k)
    GROUP BY o.session_id
  ) AS observed ON observed.session_id = json_extract(s.value, '$.id')
  WHERE json_extract(s.value, '$.id') IS NOT NULL
  ON CONFLICT(workspace_id, id) DO UPDATE SET
    ${preferring("sessions", "workstream_id", SESSION_FIRST_WINS)},
    ${preferring("sessions", "provider", SESSION_FIRST_WINS)},
    ${preferring("sessions", "native_session_id", SESSION_FIRST_WINS)},
    first_event_at_ms = MIN(sessions.first_event_at_ms, excluded.first_event_at_ms),
    ${governedBy("sessions", "first_event_id", SESSION_FIRST_WINS)},
    last_event_at_ms = MAX(sessions.last_event_at_ms, excluded.last_event_at_ms),
    ${governedBy("sessions", "last_event_id", SESSION_LAST_WINS)},
    event_count = MAX(sessions.event_count, excluded.event_count),
    trace_count = MAX(sessions.trace_count, excluded.trace_count),
    span_count = MAX(sessions.span_count, excluded.span_count),
    failed_span_count = MAX(sessions.failed_span_count, excluded.failed_span_count)
  WHERE sessions.workspace_id = excluded.workspace_id`;

export const CLEAR_SPAN_OBSERVATIONS_SQL =
  `DELETE /* observations:clear-spans */ FROM span_observations WHERE workspace_id = ?1`;
export const CLEAR_SPAN_FINGERPRINTS_SQL =
  `DELETE /* observations:clear-fingerprints */ FROM span_fingerprints WHERE workspace_id = ?1`;
export const CLEAR_SESSIONS_SQL =
  `DELETE /* observations:clear-sessions */ FROM sessions WHERE workspace_id = ?1`;

export const SCAN_EVENTS_SQL = `
  SELECT /* observations:scan-events */ seq, raw_json
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2
  ORDER BY seq
  LIMIT ?3`;

/**
 * Build the projection statements for one ingest batch.
 *
 * The caller places these in the SAME env.DB.batch() as the raw event insert,
 * so the quota reservation trigger either permits every write or rolls all of
 * them back together. The statement count is CONSTANT (three) at any batch
 * size: json_each expands the bounded canonical arrays inside D1 rather than
 * emitting one prepared statement per event. Order matters — the span upsert
 * runs before the session upsert because the session span counters read the
 * wide table.
 */
export async function buildObservationStatements(
  db: D1DatabaseLike,
  workspaceId: string,
  events: readonly IngestEvent[],
): Promise<D1BoundStatement[]> {
  const projection = await buildObservationProjection(events);
  return [
    db.prepare(UPSERT_SPAN_OBSERVATIONS_SQL)
      .bind(workspaceId, canonicalJsonStringify(projection.spans)),
    db.prepare(UPSERT_SPAN_FINGERPRINTS_SQL)
      .bind(workspaceId, canonicalJsonStringify(projection.fingerprints)),
    db.prepare(UPSERT_SESSIONS_SQL)
      .bind(workspaceId, canonicalJsonStringify(projection.sessions)),
  ];
}

// -- read SQL -----------------------------------------------------------------

const OBSERVATION_COLUMNS = `
    span_id, trace_id, parent_span_id, session_id, native_session_id,
    workstream_id, provider, agent, model, kind, name, status,
    CAST(started_at_ns AS TEXT) AS started_at_ns,
    CAST(ended_at_ns AS TEXT) AS ended_at_ns,
    duration_ms, ts_bucket, tool_name, exit_code, token_in, token_out,
    cost_amount, cost_provenance, fingerprint`;

const SESSION_COLUMNS = `
    id, workspace_id, workstream_id, provider, native_session_id,
    first_event_at_ms, last_event_at_ms, event_count, trace_count,
    span_count, failed_span_count, ts_bucket`;

export const SESSION_DETAIL_SQL = `
  SELECT /* observations:session-detail */${SESSION_COLUMNS}
  FROM sessions
  WHERE workspace_id = ?1 AND id = ?2`;

export const SESSION_KIND_COUNTS_SQL = `
  SELECT /* observations:session-kinds */ kind, COUNT(*) AS count
  FROM events
  WHERE workspace_id = ?1 AND session_id = ?2
  GROUP BY kind
  ORDER BY kind`;

interface QueryParts {
  binds: unknown[];
}

function bindParam(parts: QueryParts, value: unknown): string {
  parts.binds.push(value);
  return `?${parts.binds.length}`;
}

// -- responses ----------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- device plane -------------------------------------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

// Deliberately a local copy of index.ts's adapter: importing it back would
// make index.ts <-> observations.ts a cycle, and this module must stay usable
// with a plain-object env in tests. The SQL and semantics are identical.
const DEVICE_BY_TOKEN_SQL = `
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
            : record.capabilities
                .split(",")
                .map((capability) => capability.trim())
                .filter((capability) => capability.length > 0),
        revokedAt: record.revoked_at,
      };
      return binding;
    },
  };
}

export interface ObservationsEnv {
  DB: D1DatabaseLike;
}

async function authorize(
  request: Request,
  env: ObservationsEnv,
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

// -- pagination ---------------------------------------------------------------

export interface KeyCursor {
  /** Opaque sort key of the last row on the previous page. */
  sort: string;
  /** Row identity, breaking sort-key ties. */
  id: string;
}

export interface KeyPagination {
  limit: number;
  cursor: KeyCursor | null;
}

/**
 * Cursors carry the sort key as an opaque STRING so nanosecond keys survive
 * without passing through a float.
 */
export function encodeKeyCursor(cursor: KeyCursor): string {
  const encoded = canonicalJsonStringify({ id: cursor.id, sort: cursor.sort });
  return btoa(encoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeKeyCursor(encoded: string): KeyCursor | null {
  try {
    const decoded = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const value: unknown = JSON.parse(decoded);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    if (typeof record.sort !== "string" || record.sort.length === 0) return null;
    return { sort: record.sort, id: record.id };
  } catch {
    return null;
  }
}

export function parseKeyPagination(url: URL): Validation<KeyPagination> {
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      return { ok: false, status: 400, error: `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}` };
    }
    limit = parsed;
  }
  const rawCursor = url.searchParams.get("cursor");
  let cursor: KeyCursor | null = null;
  if (rawCursor !== null && rawCursor !== "") {
    cursor = decodeKeyCursor(rawCursor);
    if (cursor === null) return { ok: false, status: 400, error: "cursor is invalid" };
  }
  return { ok: true, value: { limit, cursor } };
}

/** Parse an RFC 3339 `since`/`until` bound; absent is allowed, malformed is not. */
function timeBound(url: URL, name: string): Validation<EventTime | null> {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: null };
  const parsed = parseEventTime(raw);
  if (parsed === null) {
    return { ok: false, status: 400, error: `${name} must be an RFC 3339 timestamp at or after 1970-01-01` };
  }
  return { ok: true, value: parsed };
}

function boundedFilter(url: URL, name: string, maxBytes: number): Validation<string | null> {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: null };
  if (exceedsUtf8Bytes(raw, maxBytes)) {
    return { ok: false, status: 400, error: `${name} must be at most ${maxBytes} UTF-8 bytes` };
  }
  return { ok: true, value: raw };
}

// -- GET /v1/observations -----------------------------------------------------

interface ObservationRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  session_id: string | null;
  native_session_id: string | null;
  workstream_id: string | null;
  provider: string | null;
  agent: string | null;
  model: string | null;
  kind: string;
  name: string;
  status: string;
  started_at_ns: string;
  ended_at_ns: string | null;
  duration_ms: number | null;
  ts_bucket: number;
  tool_name: string | null;
  exit_code: number | null;
  token_in: number | null;
  token_out: number | null;
  cost_amount: string | null;
  cost_provenance: string | null;
  fingerprint: string;
}

/**
 * Build the span query.
 *
 * Fragments are fixed strings appended in a fixed order and every value is
 * bound, so the statement is a deterministic function of which filters were
 * supplied. Time bounds always emit BOTH a ts_bucket predicate (so the index
 * skips whole 30-minute ranges) and the exact nanosecond predicate (so the
 * result stays precise) — the two-level pattern from row 10. The bucket is a
 * stored generated column derived from started_at_ns in the same row, so the
 * prune is exact and needs no slack bucket.
 */
export function buildObservationQuery(
  workspaceId: string,
  url: URL,
  pagination: KeyPagination,
): Validation<{ sql: string; binds: unknown[] }> {
  const workstream = boundedFilter(url, "workstream", MAX_SPAN_ID_BYTES);
  if (!workstream.ok) return workstream;
  const trace = boundedFilter(url, "trace", MAX_TRACE_ID_BYTES);
  if (!trace.ok) return trace;
  const session = boundedFilter(url, "session", MAX_SPAN_ID_BYTES);
  if (!session.ok) return session;
  const kind = boundedFilter(url, "kind", MAX_SPAN_KIND_BYTES);
  if (!kind.ok) return kind;
  const fingerprint = boundedFilter(url, "fingerprint", 24);
  if (!fingerprint.ok) return fingerprint;
  const since = timeBound(url, "since");
  if (!since.ok) return since;
  const until = timeBound(url, "until");
  if (!until.ok) return until;

  const rawStatus = url.searchParams.get("status");
  if (rawStatus !== null && rawStatus !== "" && !SPAN_STATUS_SET.has(rawStatus)) {
    return { ok: false, status: 400, error: `status must be one of ${SPAN_STATUSES.join(", ")}` };
  }
  const rawHas = url.searchParams.get("has");
  const existsColumn = rawHas === null || rawHas === "" ? null : EXISTS_COLUMNS.get(rawHas);
  if (rawHas !== null && rawHas !== "" && existsColumn === undefined) {
    return {
      ok: false,
      status: 400,
      error: `has must be one of ${[...EXISTS_COLUMNS.keys()].sort().join(", ")}`,
    };
  }

  const parts: QueryParts = { binds: [] };
  let sql = `SELECT /* observations:query-spans */${OBSERVATION_COLUMNS}
  FROM span_observations
  WHERE workspace_id = ${bindParam(parts, workspaceId)}`;
  if (workstream.value !== null) {
    sql += `\n    AND workstream_id = ${bindParam(parts, workstream.value)}`;
  }
  if (trace.value !== null) sql += `\n    AND trace_id = ${bindParam(parts, trace.value)}`;
  if (session.value !== null) sql += `\n    AND session_id = ${bindParam(parts, session.value)}`;
  if (kind.value !== null) sql += `\n    AND kind = ${bindParam(parts, kind.value)}`;
  if (rawStatus !== null && rawStatus !== "") {
    sql += `\n    AND status = ${bindParam(parts, rawStatus)}`;
  }
  if (fingerprint.value !== null) {
    sql += `\n    AND fingerprint = ${bindParam(parts, fingerprint.value)}`;
  }
  if (existsColumn != null) sql += `\n    AND ${existsColumn} = 1`;
  if (since.value !== null) {
    sql += `\n    AND ts_bucket >= ${bindParam(parts, observationBucket(since.value.ns))}`;
    sql += `\n    AND started_at_ns >= CAST(${bindParam(parts, since.value.ns)} AS INTEGER)`;
  }
  if (until.value !== null) {
    sql += `\n    AND ts_bucket <= ${bindParam(parts, observationBucket(until.value.ns))}`;
    sql += `\n    AND started_at_ns <= CAST(${bindParam(parts, until.value.ns)} AS INTEGER)`;
  }
  if (pagination.cursor !== null) {
    const sortParam = bindParam(parts, pagination.cursor.sort);
    const idParam = bindParam(parts, pagination.cursor.id);
    sql += `\n    AND (started_at_ns < CAST(${sortParam} AS INTEGER)
         OR (started_at_ns = CAST(${sortParam} AS INTEGER) AND span_id < ${idParam}))`;
  }
  sql += `\n  ORDER BY started_at_ns DESC, span_id DESC`;
  sql += `\n  LIMIT ${bindParam(parts, pagination.limit + 1)}`;
  return { ok: true, value: { sql, binds: parts.binds } };
}

function observationItem(row: ObservationRow): Record<string, unknown> {
  return {
    span_id: row.span_id,
    trace_id: row.trace_id,
    parent_span_id: row.parent_span_id,
    session_id: row.session_id,
    native_session_id: row.native_session_id,
    workstream_id: row.workstream_id,
    provider: row.provider,
    agent: row.agent,
    model: row.model,
    kind: row.kind,
    name: row.name,
    status: row.status,
    // Nanosecond timestamps are decimal strings: int64 exceeds the JavaScript
    // safe-integer range and must never be emitted as a JSON number.
    started_at_ns: row.started_at_ns,
    ended_at_ns: row.ended_at_ns,
    duration_ms: row.duration_ms,
    ts_bucket: row.ts_bucket,
    tool_name: row.tool_name,
    exit_code: row.exit_code,
    token_in: row.token_in,
    token_out: row.token_out,
    cost_amount: row.cost_amount,
    cost_provenance: row.cost_provenance,
    fingerprint: row.fingerprint,
  };
}

/** Re-sort before emitting so the page never depends on storage order. */
function sortObservations(rows: ObservationRow[]): ObservationRow[] {
  return [...rows].sort((a, b) => {
    const left = BigInt(a.started_at_ns);
    const right = BigInt(b.started_at_ns);
    if (left !== right) return right > left ? 1 : -1;
    if (a.span_id === b.span_id) return 0;
    return a.span_id > b.span_id ? -1 : 1;
  });
}

async function listObservations(request: Request, env: ObservationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const page = parseKeyPagination(url);
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildObservationQuery(auth.device.workspaceId, url, page.value);
  if (!query.ok) return json(query.status, { error: query.error });

  const result = await env.DB.prepare(query.value.sql)
    .bind(...query.value.binds)
    .all<ObservationRow>();
  const sorted = sortObservations(result.results);
  const items = sorted.slice(0, page.value.limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(observationItem),
    next_cursor:
      sorted.length > page.value.limit && last !== undefined
        ? encodeKeyCursor({ sort: last.started_at_ns, id: last.span_id })
        : null,
  });
}

// -- GET /v1/sessions ---------------------------------------------------------

interface SessionRow {
  id: string;
  workspace_id: string;
  workstream_id: string | null;
  provider: string | null;
  native_session_id: string | null;
  first_event_at_ms: number;
  last_event_at_ms: number;
  event_count: number;
  trace_count: number;
  span_count: number;
  failed_span_count: number;
  ts_bucket: number;
}

/**
 * Build the session listing query. Same two-level time filter as the span
 * query: a ts_bucket prune plus the exact millisecond predicate. Sessions
 * bucket on last_event_at_ms, so "active since T" prunes correctly.
 */
export function buildSessionQuery(
  workspaceId: string,
  url: URL,
  pagination: KeyPagination,
): Validation<{ sql: string; binds: unknown[] }> {
  const provider = boundedFilter(url, "provider", MAX_AGENT_BYTES);
  if (!provider.ok) return provider;
  const workstream = boundedFilter(url, "workstream", MAX_SPAN_ID_BYTES);
  if (!workstream.ok) return workstream;
  const since = timeBound(url, "since");
  if (!since.ok) return since;
  const until = timeBound(url, "until");
  if (!until.ok) return until;

  let cursorMs: number | null = null;
  if (pagination.cursor !== null) {
    const parsed = Number(pagination.cursor.sort);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { ok: false, status: 400, error: "cursor is invalid" };
    }
    cursorMs = parsed;
  }

  const parts: QueryParts = { binds: [] };
  let sql = `SELECT /* observations:query-sessions */${SESSION_COLUMNS}
  FROM sessions
  WHERE workspace_id = ${bindParam(parts, workspaceId)}`;
  if (provider.value !== null) sql += `\n    AND provider = ${bindParam(parts, provider.value)}`;
  if (workstream.value !== null) {
    sql += `\n    AND workstream_id = ${bindParam(parts, workstream.value)}`;
  }
  if (since.value !== null) {
    sql += `\n    AND ts_bucket >= ${bindParam(parts, sessionBucket(since.value.ms))}`;
    sql += `\n    AND last_event_at_ms >= ${bindParam(parts, since.value.ms)}`;
  }
  if (until.value !== null) {
    sql += `\n    AND ts_bucket <= ${bindParam(parts, sessionBucket(until.value.ms))}`;
    sql += `\n    AND last_event_at_ms <= ${bindParam(parts, until.value.ms)}`;
  }
  if (cursorMs !== null && pagination.cursor !== null) {
    const sortParam = bindParam(parts, cursorMs);
    const idParam = bindParam(parts, pagination.cursor.id);
    sql += `\n    AND (last_event_at_ms < ${sortParam}
         OR (last_event_at_ms = ${sortParam} AND id < ${idParam}))`;
  }
  sql += `\n  ORDER BY last_event_at_ms DESC, id DESC`;
  sql += `\n  LIMIT ${bindParam(parts, pagination.limit + 1)}`;
  return { ok: true, value: { sql, binds: parts.binds } };
}

function sessionItem(row: SessionRow): Record<string, unknown> {
  return {
    session_id: row.id,
    native_session_id: row.native_session_id,
    provider: row.provider,
    workstream_id: row.workstream_id,
    first_event_at_ms: row.first_event_at_ms,
    last_event_at_ms: row.last_event_at_ms,
    event_count: row.event_count,
    trace_count: row.trace_count,
    span_count: row.span_count,
    failed_span_count: row.failed_span_count,
  };
}

function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.last_event_at_ms !== b.last_event_at_ms) {
      return b.last_event_at_ms - a.last_event_at_ms;
    }
    if (a.id === b.id) return 0;
    return a.id > b.id ? -1 : 1;
  });
}

async function listSessions(request: Request, env: ObservationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const page = parseKeyPagination(url);
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildSessionQuery(auth.device.workspaceId, url, page.value);
  if (!query.ok) return json(query.status, { error: query.error });

  const result = await env.DB.prepare(query.value.sql)
    .bind(...query.value.binds)
    .all<SessionRow>();
  const sorted = sortSessions(result.results);
  const items = sorted.slice(0, page.value.limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(sessionItem),
    next_cursor:
      sorted.length > page.value.limit && last !== undefined
        ? encodeKeyCursor({ sort: String(last.last_event_at_ms), id: last.id })
        : null,
  });
}

async function getSession(
  request: Request,
  env: ObservationsEnv,
  sessionID: string,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const row = await env.DB.prepare(SESSION_DETAIL_SQL)
    .bind(auth.device.workspaceId, sessionID)
    .first<SessionRow>();
  if (row === null) return json(404, { error: "not found" });
  // The query already binds the workspace; re-check the returned row so a
  // foreign session can never surface even if the predicate were relaxed.
  const denial = scopeDenial({
    resourceWorkspaceId: row.workspace_id,
    tokenWorkspaceId: auth.device.workspaceId,
  });
  if (denial !== null) return json(denial.status, { error: denial.error });

  const counts = await env.DB.prepare(SESSION_KIND_COUNTS_SQL)
    .bind(auth.device.workspaceId, sessionID)
    .all<{ kind: string; count: number }>();
  const kindCounts = [...counts.results]
    .map((entry) => ({ kind: entry.kind, count: entry.count }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1));

  return json(200, { session: sessionItem(row), kind_counts: kindCounts });
}

// -- GET /v1/fingerprints -----------------------------------------------------

interface FingerprintRow {
  fingerprint: string;
  workspace_id: string;
  provider: string | null;
  agent: string | null;
  repo: string | null;
  host: string | null;
  model: string | null;
  first_seen: number;
  last_seen: number;
}

export function buildFingerprintQuery(
  workspaceId: string,
  pagination: KeyPagination,
): { sql: string; binds: unknown[] } {
  const parts: QueryParts = { binds: [] };
  let sql = `SELECT /* observations:query-fingerprints */
    fingerprint, workspace_id, provider, agent, repo, host, model, first_seen, last_seen
  FROM span_fingerprints
  WHERE workspace_id = ${bindParam(parts, workspaceId)}`;
  if (pagination.cursor !== null) {
    sql += `\n    AND fingerprint > ${bindParam(parts, pagination.cursor.sort)}`;
  }
  sql += `\n  ORDER BY fingerprint ASC`;
  sql += `\n  LIMIT ${bindParam(parts, pagination.limit + 1)}`;
  return { sql, binds: parts.binds };
}

async function listFingerprints(request: Request, env: ObservationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const page = parseKeyPagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildFingerprintQuery(auth.device.workspaceId, page.value);
  const result = await env.DB.prepare(query.sql).bind(...query.binds).all<FingerprintRow>();
  const sorted = [...result.results].sort((a, b) =>
    a.fingerprint === b.fingerprint ? 0 : a.fingerprint < b.fingerprint ? -1 : 1,
  );
  const items = sorted.slice(0, page.value.limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map((row) => ({
      fingerprint: row.fingerprint,
      provider: row.provider,
      agent: row.agent,
      repo: row.repo,
      host: row.host,
      model: row.model,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    })),
    next_cursor:
      sorted.length > page.value.limit && last !== undefined
        ? encodeKeyCursor({ sort: last.fingerprint, id: last.fingerprint })
        : null,
  });
}

// -- POST /v1/admin/reindex ---------------------------------------------------

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

/**
 * Read this workspace's append-only event log in seq order.
 *
 * Returns null when the log exceeds the rebuild ceiling: a rebuild must fit
 * one Worker invocation, and failing closed is better than a half-rebuilt
 * derived model. Nothing here mutates events.
 */
async function scanWorkspaceEvents(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<IngestEvent[] | null> {
  const events: IngestEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await db.prepare(SCAN_EVENTS_SQL)
      .bind(workspaceId, afterSeq, REINDEX_SCAN_PAGE)
      .all<{ seq: number; raw_json: string }>();
    const rows = page.results;
    if (rows.length === 0) return events;
    for (const row of rows) {
      if (events.length >= MAX_REINDEX_EVENTS) return null;
      afterSeq = Math.max(afterSeq, row.seq);
      try {
        const parsed: unknown = JSON.parse(row.raw_json);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          events.push(parsed as IngestEvent);
        }
      } catch {
        // A row that cannot be parsed cannot contribute to a derived model.
        // The raw evidence stays untouched in the append-only table.
      }
    }
    if (rows.length < REINDEX_SCAN_PAGE) return events;
  }
}

/**
 * Rebuild every derived row this module owns from the append-only event log.
 *
 * Capability gate: the device 'ingest' capability. A reindex creates no new
 * evidence — it drops and re-derives THIS workspace's derived rows from its
 * own events — so it needs exactly the write authority an ingesting device
 * already holds, and no separate admin plane. (The human/browser plane is
 * WorkOS cookie sessions owned by account.ts and is not available to a
 * device.) Foreign workspaces are unreachable: every statement binds the
 * token's workspace id.
 */
async function reindex(request: Request, env: ObservationsEnv): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if ("response" in auth) return auth.response;
  const workspaceId = auth.device.workspaceId;

  const events = await scanWorkspaceEvents(env.DB, workspaceId);
  if (events === null) {
    return json(413, {
      error: `workspace exceeds the ${MAX_REINDEX_EVENTS}-event rebuild ceiling`,
      code: "reindex_too_large",
    });
  }
  const projection = await buildObservationProjection(events);

  await env.DB.batch([
    env.DB.prepare(CLEAR_SPAN_OBSERVATIONS_SQL).bind(workspaceId),
    env.DB.prepare(CLEAR_SPAN_FINGERPRINTS_SQL).bind(workspaceId),
    env.DB.prepare(CLEAR_SESSIONS_SQL).bind(workspaceId),
  ]);

  // Spans first: the session counters read the wide table, so every span row
  // must exist before the session upserts run. Same ordering as ingest.
  for (const rows of chunk(projection.spans, REINDEX_CHUNK_ROWS)) {
    await env.DB.batch([
      env.DB.prepare(UPSERT_SPAN_OBSERVATIONS_SQL)
        .bind(workspaceId, canonicalJsonStringify(rows)),
    ]);
  }
  for (const rows of chunk(projection.fingerprints, REINDEX_CHUNK_ROWS)) {
    await env.DB.batch([
      env.DB.prepare(UPSERT_SPAN_FINGERPRINTS_SQL)
        .bind(workspaceId, canonicalJsonStringify(rows)),
    ]);
  }
  for (const rows of chunk(projection.sessions, REINDEX_CHUNK_ROWS)) {
    await env.DB.batch([
      env.DB.prepare(UPSERT_SESSIONS_SQL).bind(workspaceId, canonicalJsonStringify(rows)),
    ]);
  }

  // Report the row counts the derived tables now hold — the delta arrays carry
  // one entry per contributing event, which is not the same number.
  return json(200, {
    reindexed: {
      events: events.length,
      observations: new Set(projection.spans.map((row) => row.span_id)).size,
      fingerprints: new Set(projection.fingerprints.map((row) => row.fingerprint)).size,
      sessions: new Set(projection.sessions.map((row) => row.id)).size,
    },
  });
}

// -- routing ------------------------------------------------------------------

/**
 * Route the hosted sessions + observations surface. Returns null for paths
 * this module does not own so index.ts continues its sequential dispatch; a
 * known path with the wrong method also returns null and lands on the
 * platform 404 (house rule).
 */
export async function handleObservationsRoute(
  request: Request,
  env: ObservationsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/v1/admin/reindex") {
    return await reindex(request, env);
  }
  if (request.method === "GET" && pathname === "/v1/sessions") {
    return await listSessions(request, env);
  }
  const detail = SESSION_ID_PATH.exec(pathname);
  if (request.method === "GET" && detail !== null) {
    return await getSession(request, env, detail[1]);
  }
  if (request.method === "GET" && pathname === "/v1/observations") {
    return await listObservations(request, env);
  }
  if (request.method === "GET" && pathname === "/v1/fingerprints") {
    return await listFingerprints(request, env);
  }
  return null;
}
