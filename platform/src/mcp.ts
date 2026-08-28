// Hosted MCP endpoint (parity row 21): the same twelve-tool local server
// (internal/mcp) re-exposed as remote JSON-RPC 2.0 over POST /v1/mcp,
// backed by hosted D1 data instead of a local SQLite file.
//
// Six of the local server's twelve tools have a hosted counterpart where
// hosted data actually exists: get_workstream_context, get_trace_context,
// list_scores, get_prompt (stubbed — see below), record_score, and
// accept_handoff. The other six (create_checkpoint, record_decision,
// record_verification, claim_files, handoff_workstream,
// complete_workstream) depend on local-only derived models (checkpoints,
// file claims, the graph reducer) that have no hosted equivalent yet and are
// intentionally out of scope for this slice.
//
// Auth accepts either credential plane this platform has: an sk_ API key
// (src/apikeys.ts, any scope may READ; only 'write' may call record_score /
// accept_handoff) or a device bearer token with the 'read' capability
// (src/auth.ts; 'ingest' is this plane's write-equivalent of 'write' scope).
// Resolution is shared with the public REST API via
// apikeys.authenticateReadPrincipal, so both surfaces treat the same
// credential the same way.
//
// get_prompt: the hosted prompt store (parity rows 33-34) has not landed on
// this plane yet. Rather than crash or silently return nothing, the tool
// always returns a clean, documented MCP error (mapped to a JSON-RPC
// -32602) so a caller sees an explicit "not available" rather than a
// protocol failure.
//
// Every tool carries an explicit `write` flag, published in tools/list. Four
// tools read; record_score and accept_handoff append to the spine. The flag
// authorizes nothing — the write tools still check principalCanWrite()
// themselves, and tools/call serves them to a properly-scoped sk_/device
// caller exactly as before — but it lets a consumer that must never offer
// write capability (platform/ee/src/assistant.ts, whose tool selection comes
// from MODEL OUTPUT) filter the catalogue mechanically.
//
// record_score / accept_handoff write directly to the append-only `events`
// table (INSERT OR IGNORE — never through the full event-batch pipeline in
// index.ts, which also runs quota/idempotency-key bookkeeping and the
// observations.ts span/session projections that do not apply to these
// non-span kinds). Event ids are deterministic (src/otlp.ts's
// deterministicID, seeded with the real capture time so ids stay
// chronologically sortable), which means a client retry with byte-identical
// arguments within the same millisecond naturally collapses to one row
// instead of creating a duplicate. A known gap for the orchestrator: these
// writes do not bump workstreams.updated_at or run through
// buildObservationStatements, since score.recorded/handoff.accepted are not
// span-shaped kinds observations.ts's spanShapeFor models — unifying that
// would mean this module's writes ride the same batch pipeline as ingest.

import type { D1DatabaseLike } from "./db";
import { WORKSTREAM_ID_PATTERN, canonicalJsonStringify, readRequestBody } from "./ingest";
import {
  SCORE_SOURCES,
  SCORE_TARGET_PREFIXES,
  SCORE_TARGET_TYPES,
  authenticateReadPrincipal,
  listWorkstreamScores,
  principalCanWrite,
  publicObservationItem,
  sortPublicObservations,
  type ApiKeysEnv,
  type ApiPrincipal,
  type PublicObservationRow,
  type ScoreSource,
  type ScoreTargetType,
} from "./apikeys";
import { buildObservationQuery } from "./observations";
import { deterministicID } from "./otlp";

export type McpEnv = ApiKeysEnv;

const MAX_MCP_BODY_BYTES = 262_144; // 256 KiB: MCP messages are small JSON-RPC envelopes
const MAX_CONTEXT_SESSIONS = 100;
const MAX_TRACE_SPANS = 500;
const MAX_LIST_SCORES = 500;

// -- responses ------------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- generic per-tool argument helpers -----------------------------------------

type Args = Record<string, unknown>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requireString(args: Args, field: string, maxBytes = 512): string | null {
  const v = args[field];
  if (typeof v !== "string" || v.length === 0) return null;
  return utf8Bytes(v) <= maxBytes ? v : null;
}

/** undefined = not supplied (ok); null = supplied but invalid (caller must reject). */
function optionalString(args: Args, field: string, maxBytes = 512): string | null | undefined {
  const v = args[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0 || utf8Bytes(v) > maxBytes) return null;
  return v;
}

/** null = supplied but invalid; absent supplies []. */
function optionalStringArray(args: Args, field: string, maxItems = 64, maxItemBytes = 256): string[] | null {
  const v = args[field];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0 || utf8Bytes(item) > maxItemBytes) return null;
    out.push(item);
  }
  return out;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function includesString(values: readonly string[], candidate: string): boolean {
  return values.includes(candidate);
}

// -- shared workstream scoping --------------------------------------------------
// Mirrors the local server's loadWorkstream: any workstream_id not present
// in this workspace is rejected before a tool touches anything else, so no
// tool can read or write across workspaces.

interface WorkstreamLookupRow {
  id: string;
  title: string;
  status: string;
  created_at: number;
  updated_at: number;
}

const WORKSTREAM_LOOKUP_SQL = `
  /* mcp:workstream-lookup */
  SELECT id, title, status, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1 AND id = ?2`;

type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

async function requireWorkstream(
  db: D1DatabaseLike,
  workspaceId: string,
  workstreamId: string,
): Promise<{ ok: true; value: WorkstreamLookupRow } | { ok: false; message: string }> {
  if (!WORKSTREAM_ID_PATTERN.test(workstreamId)) {
    return { ok: false, message: `workstream_id must match ${WORKSTREAM_ID_PATTERN.source}` };
  }
  const row = await db.prepare(WORKSTREAM_LOOKUP_SQL).bind(workspaceId, workstreamId).first<WorkstreamLookupRow>();
  if (row === null) return { ok: false, message: `workstream ${workstreamId} not found in this workspace` };
  return { ok: true, value: row };
}

// -- writing MCP-authored events -------------------------------------------------

const INSERT_MCP_EVENT_SQL = `
  /* mcp:insert-event */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, NULL, ?5, ?6, NULL, ?7, ?8)`;

interface McpEventRow {
  schema_version: string;
  event_id: string;
  kind: string;
  occurred_at: string;
  observed_at: string;
  workstream_id: string;
  provenance: string;
  payload: Record<string, unknown>;
}

async function insertMcpEvent(db: D1DatabaseLike, workspaceId: string, event: McpEventRow): Promise<void> {
  const rawJson = canonicalJsonStringify(event);
  const ingestedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(INSERT_MCP_EVENT_SQL)
    .bind(workspaceId, event.event_id, event.occurred_at, event.workstream_id, event.kind, event.provenance, ingestedAt, rawJson)
    .run();
}

/**
 * Deterministic evt_ id for an MCP-authored event: prefix + ULID(realCaptureTimeMs,
 * sha256("evt_|" + tag + "|" + canonical(content))[0..10]) via src/otlp.ts's
 * deterministicID. Seeding the ULID's time component with the real capture
 * time (rather than 0) keeps ids chronologically sortable like every other
 * event id in this system, while the content-derived entropy still makes a
 * byte-identical retry within the same millisecond collapse to one row
 * (INSERT OR IGNORE) instead of a duplicate.
 */
async function mcpEventID(tag: string, content: unknown, nowMs: number): Promise<string> {
  const key = `${tag}|${canonicalJsonStringify(content)}`;
  return deterministicID("evt_", key, nowMs);
}

// -- tool 1: get_workstream_context ----------------------------------------------

interface WorkstreamKindCountRow {
  kind: string;
  count: number;
}

interface ContextSessionRow {
  id: string;
  provider: string | null;
  native_session_id: string | null;
  event_count: number;
  span_count: number;
  failed_span_count: number;
  last_event_at_ms: number;
}

const WORKSTREAM_KIND_COUNTS_SQL = `
  /* mcp:workstream-kind-counts */
  SELECT kind, COUNT(*) AS count
  FROM events
  WHERE workspace_id = ?1 AND workstream_id = ?2
  GROUP BY kind
  ORDER BY kind`;

const WORKSTREAM_SESSIONS_SQL = `
  /* mcp:workstream-sessions */
  SELECT id, provider, native_session_id, event_count, span_count, failed_span_count, last_event_at_ms
  FROM sessions
  WHERE workspace_id = ?1 AND workstream_id = ?2
  ORDER BY last_event_at_ms DESC, id DESC
  LIMIT ?3`;

async function toolGetWorkstreamContext(env: McpEnv, principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  const workstreamId = requireString(args, "workstream_id");
  if (workstreamId === null) return { ok: false, message: "workstream_id is required" };
  const ws = await requireWorkstream(env.DB, principal.workspaceId, workstreamId);
  if (!ws.ok) return ws;

  const [counts, sessions] = await Promise.all([
    env.DB.prepare(WORKSTREAM_KIND_COUNTS_SQL).bind(principal.workspaceId, workstreamId).all<WorkstreamKindCountRow>(),
    env.DB
      .prepare(WORKSTREAM_SESSIONS_SQL)
      .bind(principal.workspaceId, workstreamId, MAX_CONTEXT_SESSIONS)
      .all<ContextSessionRow>(),
  ]);

  const kindCounts = [...counts.results].sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1));
  let eventCount = 0;
  let decisions = 0;
  let verifications = 0;
  for (const row of kindCounts) {
    eventCount += row.count;
    if (row.kind === "decision.recorded") decisions = row.count;
    if (row.kind === "verification.recorded") verifications = row.count;
  }

  const sortedSessions = [...sessions.results].sort((a, b) => {
    if (a.last_event_at_ms !== b.last_event_at_ms) return b.last_event_at_ms - a.last_event_at_ms;
    if (a.id === b.id) return 0;
    return a.id > b.id ? -1 : 1;
  });

  return {
    ok: true,
    value: {
      workstream_id: ws.value.id,
      title: ws.value.title,
      // Derived from the events projection, never asserted directly:
      // labelled INFERRED so it can never be mistaken for observed evidence
      // (mirrors the local server's deriveWorkstreamStatus contract).
      status: { value: ws.value.status, provenance: "INFERRED" },
      created_at: ws.value.created_at,
      updated_at: ws.value.updated_at,
      event_count: eventCount,
      decisions,
      verifications,
      sessions: sortedSessions.map((row) => ({
        session_id: row.id,
        provider: row.provider,
        native_session_id: row.native_session_id,
        event_count: row.event_count,
        span_count: row.span_count,
        failed_span_count: row.failed_span_count,
      })),
    },
  };
}

// -- tool 2: get_trace_context ----------------------------------------------------

async function toolGetTraceContext(env: McpEnv, principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  const workstreamId = requireString(args, "workstream_id");
  if (workstreamId === null) return { ok: false, message: "workstream_id is required" };
  const traceId = requireString(args, "trace_id", 256);
  if (traceId === null) return { ok: false, message: "trace_id is required" };
  const ws = await requireWorkstream(env.DB, principal.workspaceId, workstreamId);
  if (!ws.ok) return ws;

  // Reuses observations.ts's exported query builder exactly as the public
  // /api/v1/observations endpoint does (see src/apikeys.ts) — a synthetic
  // URL carries the workstream/trace filters so both callers share one
  // validated query path.
  const url = new URL("https://mcp.internal.invalid/get_trace_context");
  url.searchParams.set("workstream", workstreamId);
  url.searchParams.set("trace", traceId);
  const query = buildObservationQuery(principal.workspaceId, url, { limit: MAX_TRACE_SPANS, cursor: null });
  if (!query.ok) return { ok: false, message: query.error };
  const result = await env.DB.prepare(query.value.sql).bind(...query.value.binds).all<PublicObservationRow>();
  const rows = sortPublicObservations(result.results);
  if (rows.length === 0) {
    return { ok: false, message: `trace ${traceId} not found in workstream ${workstreamId}` };
  }

  let minStart: bigint | null = null;
  let maxEnd: bigint | null = null;
  let allEnded = true;
  let failedCount = 0;
  let anyRunning = false;
  let sessionId: string | null = null;
  let provider: string | null = null;
  for (const row of rows) {
    const start = BigInt(row.started_at_ns);
    if (minStart === null || start < minStart) minStart = start;
    if (row.ended_at_ns !== null) {
      const end = BigInt(row.ended_at_ns);
      if (maxEnd === null || end > maxEnd) maxEnd = end;
    } else {
      allEnded = false;
    }
    if (row.status === "error") failedCount += 1;
    if (row.status === "running") anyRunning = true;
    if (sessionId === null && row.session_id !== null) sessionId = row.session_id;
    if (provider === null && row.provider !== null) provider = row.provider;
  }
  const status = failedCount > 0 ? "ERROR" : anyRunning ? "RUNNING" : "OK";
  const durationMs =
    allEnded && minStart !== null && maxEnd !== null ? Number((maxEnd - minStart) / 1_000_000n) : null;

  return {
    ok: true,
    value: {
      trace_id: traceId,
      workstream_id: workstreamId,
      session_id: sessionId,
      provider,
      status,
      // Nanosecond timestamps stay decimal strings end to end.
      started_at_ns: minStart !== null ? minStart.toString() : null,
      ended_at_ns: allEnded && maxEnd !== null ? maxEnd.toString() : null,
      duration_ms: durationMs,
      span_count: rows.length,
      failed_span_count: failedCount,
      spans: rows.map(publicObservationItem),
    },
  };
}

// -- tool 3: list_scores -----------------------------------------------------------

async function toolListScores(env: McpEnv, principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  const workstreamId = requireString(args, "workstream_id");
  if (workstreamId === null) return { ok: false, message: "workstream_id is required" };
  const ws = await requireWorkstream(env.DB, principal.workspaceId, workstreamId);
  if (!ws.ok) return ws;

  const targetTypeArg = optionalString(args, "target_type", 32);
  if (targetTypeArg === null) return { ok: false, message: "target_type must be a non-empty string" };
  if (targetTypeArg !== undefined && !includesString(SCORE_TARGET_TYPES, targetTypeArg)) {
    return { ok: false, message: `target_type must be one of ${SCORE_TARGET_TYPES.join(", ")}` };
  }
  const targetIdArg = optionalString(args, "target_id", 128);
  if (targetIdArg === null) return { ok: false, message: "target_id must be a non-empty string" };
  const nameArg = optionalString(args, "name", 128);
  if (nameArg === null) return { ok: false, message: "name must be a non-empty string" };

  const scores = await listWorkstreamScores(
    env.DB,
    principal.workspaceId,
    workstreamId,
    { targetType: targetTypeArg ?? null, targetId: targetIdArg ?? null, name: nameArg ?? null },
    MAX_LIST_SCORES,
  );

  return { ok: true, value: { scores, count: scores.length } };
}

// -- tool 4: get_prompt (stub) -----------------------------------------------------

async function toolGetPrompt(_env: McpEnv, _principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  const name = requireString(args, "name", 256);
  if (name === null) return { ok: false, message: "name is required" };
  // Clean, documented MCP error rather than a crash or a silently-empty
  // result: the hosted prompt store (parity rows 33-34) has not landed.
  return {
    ok: false,
    message: `hosted prompt store is not available yet (requested prompt ${JSON.stringify(name)}); use the local MCP server for prompts until it lands`,
  };
}

// -- tool 5: record_score -----------------------------------------------------------

async function toolRecordScore(env: McpEnv, principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  if (!principalCanWrite(principal)) {
    return { ok: false, message: "insufficient scope: 'write' is required to call record_score" };
  }
  const workstreamId = requireString(args, "workstream_id");
  if (workstreamId === null) return { ok: false, message: "workstream_id is required" };
  const name = requireString(args, "name", 128);
  if (name === null) return { ok: false, message: "name is required" };
  const targetTypeRaw = requireString(args, "target_type", 32);
  if (targetTypeRaw === null || !includesString(SCORE_TARGET_TYPES, targetTypeRaw)) {
    return { ok: false, message: `target_type must be one of ${SCORE_TARGET_TYPES.join(", ")}` };
  }
  const targetType = targetTypeRaw as ScoreTargetType;
  const targetId = requireString(args, "target_id", 128);
  if (targetId === null) return { ok: false, message: "target_id is required" };
  const prefix = SCORE_TARGET_PREFIXES[targetType];
  if (!targetId.startsWith(prefix)) {
    return {
      ok: false,
      message: `target_id ${JSON.stringify(targetId)} does not look like a ${targetType} id (${prefix}...)`,
    };
  }

  const valueArg = args.value;
  const categoryArg = args.category;
  const boolArg = args.bool_value;
  const hasValue = typeof valueArg === "number" && Number.isFinite(valueArg);
  const hasCategory = typeof categoryArg === "string" && categoryArg.length > 0;
  const hasBool = typeof boolArg === "boolean";
  const supplied = [hasValue, hasCategory, hasBool].filter(Boolean).length;
  if (supplied !== 1) {
    return { ok: false, message: "supply exactly one of value (number), category (string), bool_value (boolean)" };
  }

  const sourceArg = optionalString(args, "source", 32);
  if (sourceArg === null) return { ok: false, message: "source must be a non-empty string" };
  if (sourceArg !== undefined && !includesString(SCORE_SOURCES, sourceArg)) {
    return { ok: false, message: `source must be one of ${SCORE_SOURCES.join(", ")}` };
  }
  const source: ScoreSource = sourceArg === undefined ? "api" : (sourceArg as ScoreSource);
  const commentArg = optionalString(args, "comment", 2_000);
  if (commentArg === null) return { ok: false, message: "comment must be a non-empty string" };

  const ws = await requireWorkstream(env.DB, principal.workspaceId, workstreamId);
  if (!ws.ok) return ws;

  const dataType = hasValue ? "NUMERIC" : hasCategory ? "CATEGORY" : "BOOLEAN";
  // The value slot is always a STRING on the wire, mirroring the local
  // scores.recorded payload contract (internal/scores.Validate): it round
  // trips through canonical JSON without float-formatting drift.
  const value = hasValue ? String(valueArg) : hasCategory ? (categoryArg as string) : String(boolArg as boolean);

  const payload: Record<string, unknown> = {
    name,
    data_type: dataType,
    value,
    target_type: targetType,
    target_id: targetId,
    source,
  };
  if (commentArg !== undefined) payload.comment = commentArg;

  const nowMs = Date.now();
  const eventId = await mcpEventID(
    "mcp.score",
    { workspace_id: principal.workspaceId, workstream_id: workstreamId, payload },
    nowMs,
  );
  const occurredAt = new Date(nowMs).toISOString();
  await insertMcpEvent(env.DB, principal.workspaceId, {
    schema_version: "hfg.event.v1",
    event_id: eventId,
    kind: "score.recorded",
    occurred_at: occurredAt,
    observed_at: occurredAt,
    workstream_id: workstreamId,
    provenance: "OBSERVED",
    payload,
  });

  return {
    ok: true,
    value: {
      event_id: eventId,
      workstream_id: workstreamId,
      kind: "score.recorded",
      provenance: "OBSERVED",
      name,
      data_type: dataType,
      value,
      target_type: targetType,
      target_id: targetId,
      source,
    },
  };
}

// -- tool 6: accept_handoff -----------------------------------------------------

const LATEST_HANDOFF_CREATED_SQL = `
  /* mcp:latest-handoff-created */
  SELECT event_id FROM events
  WHERE workspace_id = ?1 AND workstream_id = ?2 AND kind = 'handoff.created'
  ORDER BY seq DESC
  LIMIT 1`;

async function toolAcceptHandoff(env: McpEnv, principal: ApiPrincipal, args: Args): Promise<ToolOutcome> {
  if (!principalCanWrite(principal)) {
    return { ok: false, message: "insufficient scope: 'write' is required to call accept_handoff" };
  }
  const workstreamId = requireString(args, "workstream_id");
  if (workstreamId === null) return { ok: false, message: "workstream_id is required" };

  const handoffId = optionalString(args, "handoff_id", 128);
  if (handoffId === null) return { ok: false, message: "handoff_id must be a non-empty string" };
  const checkpointId = optionalString(args, "checkpoint_id", 128);
  if (checkpointId === null) return { ok: false, message: "checkpoint_id must be a non-empty string" };
  const agent = optionalString(args, "agent", 128);
  if (agent === null) return { ok: false, message: "agent must be a non-empty string" };
  const accepted = optionalStringArray(args, "accepted");
  if (accepted === null) return { ok: false, message: "accepted must be an array of non-empty strings" };
  const missing = optionalStringArray(args, "missing");
  if (missing === null) return { ok: false, message: "missing must be an array of non-empty strings" };
  const unverifiable = optionalStringArray(args, "unverifiable");
  if (unverifiable === null) return { ok: false, message: "unverifiable must be an array of non-empty strings" };

  const ws = await requireWorkstream(env.DB, principal.workspaceId, workstreamId);
  if (!ws.ok) return ws;

  // Handoff status reading: informational only. A hosted accept_handoff
  // never requires a matching handoff.created event to already exist (the
  // local server's backward-compatible v0.4 acknowledgement path), it just
  // reports what it found.
  const priorCreated = await env.DB
    .prepare(LATEST_HANDOFF_CREATED_SQL)
    .bind(principal.workspaceId, workstreamId)
    .first<{ event_id: string }>();
  const handoffStatus = priorCreated === null ? "none" : "pending";

  const acceptedSorted = sortedUnique(accepted);
  const missingSorted = sortedUnique(missing);
  const unverifiableSorted = sortedUnique(unverifiable);

  const payload: Record<string, unknown> = {};
  if (handoffId !== undefined) payload.handoff_id = handoffId;
  if (checkpointId !== undefined) payload.checkpoint_id = checkpointId;
  if (agent !== undefined) payload.agent = agent;
  if (acceptedSorted.length > 0) payload.accepted = acceptedSorted;
  if (missingSorted.length > 0) payload.missing = missingSorted;
  if (unverifiableSorted.length > 0) payload.unverifiable = unverifiableSorted;

  const nowMs = Date.now();
  const eventId = await mcpEventID(
    "mcp.handoff",
    { workspace_id: principal.workspaceId, workstream_id: workstreamId, payload },
    nowMs,
  );
  const occurredAt = new Date(nowMs).toISOString();
  await insertMcpEvent(env.DB, principal.workspaceId, {
    schema_version: "hfg.event.v1",
    event_id: eventId,
    kind: "handoff.accepted",
    occurred_at: occurredAt,
    observed_at: occurredAt,
    workstream_id: workstreamId,
    provenance: "DECLARED",
    payload,
  });

  return {
    ok: true,
    value: {
      event_id: eventId,
      workstream_id: workstreamId,
      kind: "handoff.accepted",
      provenance: "DECLARED",
      handoff_status: handoffStatus,
      handoff_id: handoffId ?? null,
      checkpoint_id: checkpointId ?? null,
      agent: agent ?? null,
      accepted: acceptedSorted,
      missing: missingSorted,
      unverifiable: unverifiableSorted,
    },
  };
}

// -- tool schema helpers (mirrors internal/mcp/handlers.go's schema()/strProp()/...) --

function strProp(description: string): Record<string, unknown> {
  return { type: "string", description };
}
function numProp(description: string): Record<string, unknown> {
  return { type: "number", description };
}
function boolProp(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}
function arrProp(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}
function enumProp(description: string, values: readonly string[]): Record<string, unknown> {
  return { type: "string", enum: [...values], description };
}
function toolSchema(properties: Record<string, unknown>, ...required: string[]): Record<string, unknown> {
  const s: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) s.required = required;
  return s;
}

/**
 * `write` is a REQUIRED field, not an optional hint.
 *
 * A tool that appends to the append-only `events` table is a fundamentally
 * different capability from one that reads, and some callers of tools/list —
 * platform/ee/src/assistant.ts most importantly — must be able to tell them
 * apart mechanically rather than by recognising a name. Making the field
 * required means the compiler, not a reviewer, is what stops a new tool from
 * landing without an answer to "can this write?".
 *
 * The flag is descriptive metadata only. It does NOT authorize anything: each
 * write tool still checks principalCanWrite() itself, and tools/call still
 * serves write tools to a properly-scoped sk_/device caller exactly as before.
 */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** true when the tool APPENDS to the spine; false for read-only tools. */
  write: boolean;
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "get_workstream_context",
    write: false,
    description:
      "Get the current hosted context of a workstream: title, derived status, event/decision/verification counts, and recent sessions. Read-only; scoped to workstreams in the authenticated workspace.",
    inputSchema: toolSchema({ workstream_id: strProp("workstream id (ws_...) as listed by GET /api/v1/workstreams") }, "workstream_id"),
  },
  {
    name: "get_trace_context",
    write: false,
    description:
      "Get one trace's spans and summary from the hosted span_observations read model. Read-only; traces from other workstreams or workspaces are rejected.",
    inputSchema: toolSchema(
      { workstream_id: strProp("workstream id that owns the trace"), trace_id: strProp("trace id to inspect") },
      "workstream_id",
      "trace_id",
    ),
  },
  {
    name: "list_scores",
    write: false,
    description: "List quality scores recorded for a workstream, optionally filtered by target type/id or score name. Read-only.",
    inputSchema: toolSchema(
      {
        workstream_id: strProp("workstream id whose scores to list"),
        target_type: enumProp("filter by scored object type", SCORE_TARGET_TYPES),
        target_id: strProp("filter by scored object id"),
        name: strProp("filter by score name"),
      },
      "workstream_id",
    ),
  },
  {
    name: "get_prompt",
    write: false,
    description:
      "Get a managed prompt. NOT YET AVAILABLE on the hosted platform: the hosted prompt store has not landed, so this always returns a clean error. Use the local MCP server for prompts.",
    inputSchema: toolSchema({ name: strProp("prompt name to resolve") }, "name"),
  },
  {
    name: "record_score",
    write: true,
    description:
      "Record a quality score (numeric, category, or boolean) attached to a trace, span, session, checkpoint, or the workstream itself. Exactly one of value/category/bool_value. Scores are source-tagged (default api) and appended as OBSERVED score.recorded events. Requires an API key with the 'write' scope, or a device token with 'ingest'.",
    inputSchema: toolSchema(
      {
        workstream_id: strProp("workstream id the score belongs to"),
        name: strProp("score name (e.g. handoff.validity, human.review)"),
        target_type: enumProp("scored object type", SCORE_TARGET_TYPES),
        target_id: strProp("id of the scored object (trc_.../spn_.../ses_.../cp_.../ws_...)"),
        value: numProp("numeric score value (NUMERIC; exactly one of value/category/bool_value)"),
        category: strProp("category label (CATEGORY; exactly one of value/category/bool_value)"),
        bool_value: boolProp("boolean verdict (BOOLEAN; exactly one of value/category/bool_value)"),
        source: enumProp("who produced the score (default api)", SCORE_SOURCES),
        comment: strProp("optional explanation"),
      },
      "workstream_id",
      "name",
      "target_type",
      "target_id",
    ),
  },
  {
    name: "accept_handoff",
    write: true,
    description:
      "Acknowledge a handoff for a workstream, recording an accepted/missing/unverifiable breakdown as a handoff.accepted event. Reads the latest handoff.created event for status context if one exists, but never requires one. Requires an API key with the 'write' scope, or a device token with 'ingest'.",
    inputSchema: toolSchema(
      {
        workstream_id: strProp("workstream id whose handoff is accepted"),
        handoff_id: strProp("optional exact handoff id"),
        checkpoint_id: strProp("optional checkpoint id"),
        agent: strProp("optional name of the accepting agent"),
        accepted: arrProp("checkpoint sections received and understood"),
        missing: arrProp("checkpoint sections that were absent or empty"),
        unverifiable: arrProp("checkpoint sections whose evidence could not be verified"),
      },
      "workstream_id",
    ),
  },
];

const TOOL_HANDLERS: Record<string, (env: McpEnv, principal: ApiPrincipal, args: Args) => Promise<ToolOutcome>> = {
  get_workstream_context: toolGetWorkstreamContext,
  get_trace_context: toolGetTraceContext,
  list_scores: toolListScores,
  get_prompt: toolGetPrompt,
  record_score: toolRecordScore,
  accept_handoff: toolAcceptHandoff,
};

// -- JSON-RPC 2.0 envelope --------------------------------------------------------

type JsonId = string | number | null;

function isValidId(v: unknown): v is JsonId {
  return typeof v === "string" || typeof v === "number" || v === null;
}

function rpcResultResponse(id: JsonId, result: unknown): Response {
  return json(200, { jsonrpc: "2.0", id, result });
}
function rpcErrorResponse(id: JsonId, code: number, message: string): Response {
  return json(200, { jsonrpc: "2.0", id, error: { code, message } });
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "handoffgraph-hosted";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS =
  "HandoffGraph hosted continuity tools — a hosted subset of the local MCP server's twelve tools, backed by " +
  "this workspace's D1 data. Every tool is scoped to workstreams in the authenticated workspace. get_prompt " +
  "always errors: the hosted prompt store has not landed yet.";

function handleInitialize(params: unknown): Record<string, unknown> {
  let protocolVersion = PROTOCOL_VERSION;
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const requested = (params as Record<string, unknown>).protocolVersion;
    if (typeof requested === "string" && requested.length > 0) protocolVersion = requested;
  }
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
  };
}

/**
 * tools/list is PRINCIPAL-INDEPENDENT: every caller sees the same catalogue,
 * and tools/call is where scope is enforced. `write` is published alongside
 * each tool so a consumer that must not offer write capability at all — the
 * EE assistant, which drives tool selection from MODEL OUTPUT — can filter on
 * a field instead of on a hard-coded name list that would silently go stale
 * the day a seventh tool lands. Additive: the field sits beside the three keys
 * MCP clients already read, and no existing consumer has to change.
 */
function handleToolsList(): Record<string, unknown> {
  return {
    tools: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      write: t.write,
    })),
  };
}

function toolCallResult(structured: Record<string, unknown>): Record<string, unknown> {
  const withFlag = { ...structured, isValidTool: true };
  return {
    content: [{ type: "text", text: canonicalJsonStringify(withFlag) }],
    structuredContent: withFlag,
    isError: false,
  };
}

type ToolsCallOutcome = { code: -32601 | -32602; message: string } | { result: Record<string, unknown> };

async function handleToolsCall(env: McpEnv, principal: ApiPrincipal, params: unknown): Promise<ToolsCallOutcome> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { code: -32602, message: "params must be an object" };
  }
  const p = params as Record<string, unknown>;
  const name = p.name;
  if (typeof name !== "string" || name.length === 0) {
    return { code: -32602, message: `"name" is required` };
  }
  const handler = TOOL_HANDLERS[name];
  if (handler === undefined) {
    // Unknown tool: JSON-RPC method-not-found — the requested capability
    // simply does not exist on this server (not a domain-level tool error).
    return { code: -32601, message: `method not found: tool ${JSON.stringify(name)}` };
  }
  let args: Args = {};
  const rawArgs = p.arguments;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return { code: -32602, message: `"arguments" must be a JSON object` };
    }
    args = rawArgs as Args;
  }
  const outcome = await handler(env, principal, args);
  if (!outcome.ok) return { code: -32602, message: outcome.message };
  return { result: toolCallResult(outcome.value) };
}

// -- routing ------------------------------------------------------------------

/**
 * Route POST /v1/mcp. Returns null for every other path/method so index.ts
 * continues its sequential dispatch (a GET to /v1/mcp is a known path with
 * the wrong method, so it also returns null and lands on the platform 404).
 */
export async function handleMcpRoute(request: Request, env: McpEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/v1/mcp") return null;
  if (request.method !== "POST") return null;

  const auth = await authenticateReadPrincipal(request, env);
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const bodyRead = await readRequestBody(request, MAX_MCP_BODY_BYTES);
  if (!bodyRead.ok) {
    return json(bodyRead.status, {
      error:
        bodyRead.status === 413
          ? "request body exceeds the MCP message size limit"
          : "request body is not readable UTF-8",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRead.text);
  } catch {
    return rpcErrorResponse(null, -32700, "parse error: invalid JSON");
  }

  // Batch requests are not required by this version: reject arrays outright
  // rather than silently processing only the first message in the array.
  if (Array.isArray(parsed)) {
    return json(400, { error: "batch requests are not supported; send a single JSON-RPC message per POST" });
  }
  if (parsed === null || typeof parsed !== "object") {
    return rpcErrorResponse(null, -32600, "request must be a JSON object");
  }
  const envelope = parsed as Record<string, unknown>;
  const rawId = "id" in envelope ? envelope.id : null;
  if (!isValidId(rawId)) {
    return rpcErrorResponse(null, -32600, `"id" must be a string, number, or null`);
  }
  const id = rawId;
  if (envelope.jsonrpc !== "2.0") {
    return rpcErrorResponse(id, -32600, `"jsonrpc" must be "2.0"`);
  }
  if (typeof envelope.method !== "string" || envelope.method.length === 0) {
    return rpcErrorResponse(id, -32600, `"method" is required`);
  }

  try {
    switch (envelope.method) {
      case "initialize":
        return rpcResultResponse(id, handleInitialize(envelope.params));
      case "tools/list":
        return rpcResultResponse(id, handleToolsList());
      case "tools/call": {
        const outcome = await handleToolsCall(env, principal, envelope.params);
        if ("result" in outcome) return rpcResultResponse(id, outcome.result);
        return rpcErrorResponse(id, outcome.code, outcome.message);
      }
      default:
        return rpcErrorResponse(id, -32601, `method not found: ${JSON.stringify(envelope.method)}`);
    }
  } catch (error) {
    // Content-free structured logging: never log headers, tokens, bodies,
    // or captured event fields.
    console.error(
      JSON.stringify({
        message: "mcp dispatch failed",
        method: envelope.method,
        error_type: error instanceof Error ? error.name : "unknown",
      }),
    );
    return rpcErrorResponse(id, -32603, "internal error");
  }
}
