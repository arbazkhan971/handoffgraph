// Human annotation queues (parity row 28): a saved filter over
// span_observations plus a score definition, worked by human annotators
// through claim -> submit/skip, producing score.recorded events exactly like
// src/mcp.ts's record_score tool does (source = "human", provenance =
// OBSERVED). See migrations/0013_annotations.sql for the schema and its
// lifecycle triggers.
//
// Surfaces (device bearer; capability 'ingest' to manage, 'read' to work a
// queue — see src/auth.ts):
//   POST /v1/annotation-queues                        create + populate
//   GET  /v1/annotation-queues                         list (pending/done counts)
//   POST /v1/annotation-queues/{id}/claim               claim the next pending item
//   POST /v1/annotation-queues/{id}/items/{item}/submit  score it, mark done
//   POST /v1/annotation-queues/{id}/items/{item}/skip    mark skipped, no score
//   POST /v1/annotation-queues/{id}/refill               re-scan the filter
//   GET  /v1/annotation-queues/{id}/live                 live {pending,claimed,done}
//
// Population source. target_filter's optional keys (workstream/kind/status)
// are all span_observations columns, and span_observations is the only
// live, continuously-populated read model with that shape — the
// migration-0001 `traces`/`spans` tables are vestigial (nothing has written
// to them since migration 0005; only artifacts.ts's retention sweep still
// touches them, to delete). Every item this module populates is therefore
// target_type = 'span', target_id = span_observations.span_id. The schema's
// target_type CHECK stays wider (trace/span/session, matching
// src/apikeys.ts's SCORE_TARGET_TYPES vocabulary used elsewhere on this
// spine) so a future population source is a code change, not a migration.
//
// Claim vs submit. Claiming is a concurrency courtesy for interactive
// annotators (two people working the same queue never get handed the same
// item), not a hard precondition for scoring: submit/skip accept an item in
// either 'pending' or 'claimed' status, so a script driving this API through
// record_score-style bulk scoring does not have to claim first. Once an item
// reaches 'done' or 'skipped' it is terminal (migration 0013's triggers
// enforce this in-schema too); resubmitting a finished item is a 409, not a
// silent replay — unlike ingest's Idempotency-Key replay, there is no client
// idempotency token here to prove a resubmit is the SAME request rather than
// a second annotator's differing judgement call arriving late.
//
// Live state (Durable Object half of parity row 28). AnnotationQueueRoom
// holds an in-memory {pending, claimed, done} snapshot for one queue (one
// room per queue, idFromName(queue_id)); every mutation below best-effort
// notifies it with the freshly-recomputed D1 counts, fire-and-forget. GET
// .../live proxies to the room when env.ANNOTATION_ROOMS is bound and falls
// back to a D1 COUNT query — same response shape either way — when it is
// not, or when the room fetch fails. WebSockets / push-to-viewer are out of
// scope for this slice; a viewer polls the live endpoint. The DO class
// deliberately does NOT import `cloudflare:workers` (see the class doc
// below), matching src/simulations.ts's SimulationWorkflow.

import { monotonicFactory } from "ulid";

import { authenticate, hasCapability, type DeviceBinding, type DeviceLookup } from "./auth";
import type { D1DatabaseLike } from "./db";
import { MAX_KIND_BYTES, WORKSTREAM_ID_PATTERN, canonicalJsonStringify, encodeCursor, parsePagination, readRequestBody } from "./ingest";
import { deterministicID } from "./otlp";

// -- ids -----------------------------------------------------------------------

const nextULID = monotonicFactory();

function newAnnotationQueueID(): string {
  return `anq_${nextULID()}`;
}

function newAnnotationItemID(): string {
  return `ani_${nextULID()}`;
}

const ANQ_ID_BODY = "anq_[0-7][0-9A-HJKMNP-TV-Z]{25}";
const ANI_ID_BODY = "ani_[0-7][0-9A-HJKMNP-TV-Z]{25}";
export const ANQ_ID_PATTERN = new RegExp(`^${ANQ_ID_BODY}$`);
export const ANI_ID_PATTERN = new RegExp(`^${ANI_ID_BODY}$`);

// -- routes ----------------------------------------------------------------------

const QUEUES_PATH = "/v1/annotation-queues";
const CLAIM_PATH = new RegExp(`^/v1/annotation-queues/(${ANQ_ID_BODY})/claim$`);
const SUBMIT_PATH = new RegExp(`^/v1/annotation-queues/(${ANQ_ID_BODY})/items/(${ANI_ID_BODY})/submit$`);
const SKIP_PATH = new RegExp(`^/v1/annotation-queues/(${ANQ_ID_BODY})/items/(${ANI_ID_BODY})/skip$`);
const REFILL_PATH = new RegExp(`^/v1/annotation-queues/(${ANQ_ID_BODY})/refill$`);
const LIVE_PATH = new RegExp(`^/v1/annotation-queues/(${ANQ_ID_BODY})/live$`);

// -- tunables ----------------------------------------------------------------------

const MAX_BODY_BYTES = 8_192;
const MAX_NAME_BYTES = 200;
const MAX_SCORE_NAME_BYTES = 128;
const MAX_CATEGORY_BYTES = 64;
const MIN_CATEGORIES = 2;
const MAX_CATEGORIES = 50;
const MAX_COMMENT_BYTES = 2_000;
/** Bound on how many new targets one create/refill call may pull in, matching parity row 28's spec. */
export const MAX_ITEMS_PER_SCAN = 1_000;

const DATA_TYPES = new Set(["NUMERIC", "CATEGORY", "BOOLEAN"]);
const SPAN_STATUS_VALUES = new Set(["unknown", "running", "ok", "error"]);
const TARGET_FILTER_KEYS = new Set(["workstream", "kind", "status"]);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// -- structural Cloudflare bindings ------------------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests and the real DurableObjectNamespace satisfies these shapes
// structurally at the index.ts boundary.

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface AnnotationsEnv {
  DB: D1DatabaseLike;
  /** One room per queue (idFromName(queue_id)). Optional live-state accelerator — see AnnotationQueueRoom below. */
  ANNOTATION_ROOMS?: DurableObjectNamespaceLike;
}

// -- responses ----------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_BODY_BYTES);
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

// -- device plane (duplicated per module; see src/index.ts's deviceLookup) ---------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

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
            : record.capabilities.split(",").map((c) => c.trim()).filter((c) => c.length > 0),
        revokedAt: record.revoked_at,
      };
      return binding;
    },
  };
}

// -- target_filter -------------------------------------------------------------

export interface TargetFilter {
  workstream?: string;
  kind?: string;
  status?: string;
}

/** Strict parse for a caller-supplied filter: unknown keys and bad values both reject. */
function parseTargetFilter(value: unknown): TargetFilter | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TARGET_FILTER_KEYS.has(key)) return null;
  }
  const filter: TargetFilter = {};
  if (obj.workstream !== undefined) {
    if (typeof obj.workstream !== "string" || !WORKSTREAM_ID_PATTERN.test(obj.workstream)) return null;
    filter.workstream = obj.workstream;
  }
  if (obj.kind !== undefined) {
    if (typeof obj.kind !== "string" || obj.kind.length === 0 || utf8Bytes(obj.kind) > MAX_KIND_BYTES) return null;
    filter.kind = obj.kind;
  }
  if (obj.status !== undefined) {
    if (typeof obj.status !== "string" || !SPAN_STATUS_VALUES.has(obj.status)) return null;
    filter.status = obj.status;
  }
  return filter;
}

/**
 * Lenient read of a queue's own stored filter (refill): historical rows stay
 * usable even if `parseTargetFilter`'s strictness ever changes, so this never
 * rejects — an unrecognized or malformed stored key is just dropped.
 */
function readStoredFilter(rawJson: string): TargetFilter {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const filter: TargetFilter = {};
    if (typeof obj.workstream === "string") filter.workstream = obj.workstream;
    if (typeof obj.kind === "string") filter.kind = obj.kind;
    if (typeof obj.status === "string") filter.status = obj.status;
    return filter;
  } catch {
    return {};
  }
}

// -- categories -----------------------------------------------------------------

type CategoriesInput = { ok: true; value: string[] | null } | { ok: false; error: string };

function parseCategoriesInput(dataType: string, raw: unknown): CategoriesInput {
  if (dataType !== "CATEGORY") {
    if (raw !== undefined) return { ok: false, error: "categories must be omitted unless data_type is CATEGORY" };
    return { ok: true, value: null };
  }
  if (!Array.isArray(raw) || raw.length < MIN_CATEGORIES || raw.length > MAX_CATEGORIES) {
    return {
      ok: false,
      error: `categories must be an array of ${MIN_CATEGORIES}-${MAX_CATEGORIES} strings when data_type is CATEGORY`,
    };
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || utf8Bytes(item) > MAX_CATEGORY_BYTES) {
      return { ok: false, error: `each category must be a non-empty string of at most ${MAX_CATEGORY_BYTES} UTF-8 bytes` };
    }
    if (seen.has(item)) return { ok: false, error: "categories must be unique" };
    seen.add(item);
  }
  return { ok: true, value: raw as string[] };
}

function parseStoredCategories(rawJson: string | null): string[] | null {
  if (rawJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

// -- score value validation ------------------------------------------------------
// Mirrors src/mcp.ts's record_score contract: the value slot is always a
// STRING on the wire and in the stored event payload (round-trips through
// canonical JSON without float-formatting drift), regardless of data_type.

export type ScoreValueResult = { ok: true; value: string } | { ok: false; error: string };

export function validateScoreValue(dataType: string, categories: string[] | null, raw: unknown): ScoreValueResult {
  if (dataType === "NUMERIC") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, error: "value must be a finite number for a NUMERIC queue" };
    }
    return { ok: true, value: String(raw) };
  }
  if (dataType === "BOOLEAN") {
    if (typeof raw !== "boolean") {
      return { ok: false, error: "value must be a boolean for a BOOLEAN queue" };
    }
    return { ok: true, value: String(raw) };
  }
  // CATEGORY
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "value must be a non-empty string for a CATEGORY queue" };
  }
  if (categories === null || !categories.includes(raw)) {
    return {
      ok: false,
      error: `value must be one of the queue's categories: ${(categories ?? []).join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

// -- score.recorded event -------------------------------------------------------
// Direct append to the events table, same discipline as src/mcp.ts's
// record_score: never through the full event-batch pipeline (no quota/
// idempotency-key bookkeeping applies to a human annotation), INSERT OR
// IGNORE with a deterministic id so a byte-identical retry within the same
// millisecond collapses to one row instead of a duplicate.

const INSERT_SCORE_EVENT_SQL = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, NULL, 'score.recorded', 'OBSERVED', NULL, ?5, ?6)`;

/**
 * Deterministic evt_ id for one annotation submission: prefix + ULID(realCaptureTimeMs,
 * sha256("evt_|annotation.score|" + item id + "|" + canonical(payload))[0..10])
 * via src/otlp.ts's deterministicID — the same construction src/mcp.ts's
 * mcpEventID and src/alerts.ts's alertEventID use. Exported so its
 * determinism is directly testable without re-deriving the key format.
 */
export async function annotationScoreEventID(
  itemId: string,
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<string> {
  const key = `annotation.score|${itemId}|${canonicalJsonStringify(payload)}`;
  return deterministicID("evt_", key, nowMs);
}

async function insertAnnotationScoreEvent(
  db: D1DatabaseLike,
  workspaceId: string,
  eventId: string,
  occurredAt: string,
  workstreamId: string | null,
  ingestedAt: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const rawJson = canonicalJsonStringify({
    schema_version: "hfg.event.v1",
    event_id: eventId,
    kind: "score.recorded",
    occurred_at: occurredAt,
    observed_at: occurredAt,
    workstream_id: workstreamId,
    provenance: "OBSERVED",
    payload,
  });
  await db
    .prepare(INSERT_SCORE_EVENT_SQL)
    .bind(workspaceId, eventId, occurredAt, workstreamId, ingestedAt, rawJson)
    .run();
}

// -- span_observations reads (population + target summary + workstream lookup) ----

const CANDIDATE_SPANS_SQL = `
  /* annotations:candidate-spans */
  SELECT s.span_id
  FROM span_observations s
  WHERE s.workspace_id = ?1
    AND (?2 IS NULL OR s.workstream_id = ?2)
    AND (?3 IS NULL OR s.kind = ?3)
    AND (?4 IS NULL OR s.status = ?4)
    AND NOT EXISTS (
      SELECT 1 FROM annotation_items i
      WHERE i.queue_id = ?5 AND i.target_type = 'span' AND i.target_id = s.span_id
    )
  ORDER BY s.started_at_ns ASC, s.span_id ASC
  LIMIT ?6`;

/**
 * Candidates NOT already represented as an item in this queue, oldest first,
 * bounded to MAX_ITEMS_PER_SCAN. Shared by queue creation (nothing exists yet,
 * so every match is a candidate) and refill (only genuinely new targets come
 * back) — one query, one deterministic order, for both.
 */
async function selectCandidateSpanIds(
  db: D1DatabaseLike,
  workspaceId: string,
  queueId: string,
  filter: TargetFilter,
): Promise<string[]> {
  const result = await db
    .prepare(CANDIDATE_SPANS_SQL)
    .bind(workspaceId, filter.workstream ?? null, filter.kind ?? null, filter.status ?? null, queueId, MAX_ITEMS_PER_SCAN)
    .all<{ span_id: string }>();
  return result.results.map((row) => row.span_id);
}

const INSERT_ITEMS_SQL = `
  /* annotations:insert-items */
  INSERT OR IGNORE INTO annotation_items
    (id, queue_id, workspace_id, target_type, target_id, status, created_at)
  SELECT
    json_extract(input.value, '$.id'),
    ?1,
    ?2,
    'span',
    json_extract(input.value, '$.target_id'),
    'pending',
    ?3
  FROM json_each(?4) AS input`;

interface SpanSummaryRow {
  span_id: string;
  trace_id: string;
  session_id: string | null;
  workstream_id: string | null;
  provider: string | null;
  agent: string | null;
  model: string | null;
  kind: string;
  name: string;
  status: string;
  started_at_ns: string;
  ended_at_ns: string | null;
  tool_name: string | null;
}

const SPAN_SUMMARY_SQL = `
  /* annotations:span-summary */
  SELECT span_id, trace_id, session_id, workstream_id, provider, agent, model,
         kind, name, status,
         CAST(started_at_ns AS TEXT) AS started_at_ns,
         CAST(ended_at_ns AS TEXT) AS ended_at_ns,
         tool_name
  FROM span_observations
  WHERE workspace_id = ?1 AND span_id = ?2`;

/** Target context for a claimed item. Null when target_type isn't 'span' (see the module doc) or the span row is gone (span_observations is rebuildable). */
async function targetSummary(
  db: D1DatabaseLike,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<SpanSummaryRow | null> {
  if (targetType !== "span") return null;
  return db.prepare(SPAN_SUMMARY_SQL).bind(workspaceId, targetId).first<SpanSummaryRow>();
}

const SPAN_WORKSTREAM_SQL = `
  /* annotations:span-workstream */
  SELECT workstream_id FROM span_observations WHERE workspace_id = ?1 AND span_id = ?2`;

/** workstream_id to stamp on the score.recorded event; null when unknown (events.workstream_id is nullable). */
async function lookupTargetWorkstreamId(
  db: D1DatabaseLike,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<string | null> {
  if (targetType !== "span") return null;
  const row = await db.prepare(SPAN_WORKSTREAM_SQL).bind(workspaceId, targetId).first<{ workstream_id: string | null }>();
  return row?.workstream_id ?? null;
}

// -- queues ----------------------------------------------------------------------

interface QueueRow {
  id: string;
  workspace_id: string;
  name: string;
  target_filter: string;
  score_name: string;
  data_type: string;
  categories: string | null;
  active: number;
  created_at: number;
}

const QUEUE_BY_ID_SQL = `
  /* annotations:queue-by-id */
  SELECT id, workspace_id, name, target_filter, score_name, data_type, categories, active, created_at
  FROM annotation_queues
  WHERE workspace_id = ?1 AND id = ?2`;

async function loadQueue(db: D1DatabaseLike, workspaceId: string, id: string): Promise<QueueRow | null> {
  if (!ANQ_ID_PATTERN.test(id)) return null;
  return db.prepare(QUEUE_BY_ID_SQL).bind(workspaceId, id).first<QueueRow>();
}

const INSERT_QUEUE_SQL = `
  /* annotations:insert-queue */
  INSERT INTO annotation_queues
    (id, workspace_id, name, target_filter, score_name, data_type, categories, active, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)`;

interface CountSnapshot {
  pending: number;
  claimed: number;
  done: number;
}

const COUNT_ITEMS_BY_STATUS_SQL = `
  /* annotations:count-items-by-status */
  SELECT status, COUNT(*) AS count
  FROM annotation_items
  WHERE workspace_id = ?1 AND queue_id = ?2
  GROUP BY status`;

async function countsForQueue(db: D1DatabaseLike, workspaceId: string, queueId: string): Promise<CountSnapshot> {
  const result = await db
    .prepare(COUNT_ITEMS_BY_STATUS_SQL)
    .bind(workspaceId, queueId)
    .all<{ status: string; count: number }>();
  const snapshot: CountSnapshot = { pending: 0, claimed: 0, done: 0 };
  for (const row of result.results) {
    if (row.status === "pending") snapshot.pending = row.count;
    else if (row.status === "claimed") snapshot.claimed = row.count;
    else if (row.status === "done") snapshot.done = row.count;
    // 'skipped' is intentionally not part of this snapshot's shape.
  }
  return snapshot;
}

function queueView(
  row: { id: string; name: string; target_filter: string; score_name: string; data_type: string; categories: string | null; active: number; created_at: number },
  counts: { pending: number; done: number },
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    target_filter: JSON.parse(row.target_filter),
    score_name: row.score_name,
    data_type: row.data_type,
    categories: row.categories === null ? null : JSON.parse(row.categories),
    active: row.active === 1,
    created_at: row.created_at,
    pending_count: counts.pending,
    done_count: counts.done,
  };
}

// -- items -------------------------------------------------------------------

interface ItemRow {
  id: string;
  queue_id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  status: string;
  claimed_by_device: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  created_at: number;
}

const ITEM_COLUMNS =
  "id, queue_id, workspace_id, target_type, target_id, status, claimed_by_device, claimed_at, completed_at, created_at";

function itemView(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id,
    queue_id: row.queue_id,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    claimed_by_device: row.claimed_by_device,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

const CLAIM_NEXT_SQL = `
  /* annotations:claim-next */
  UPDATE annotation_items
  SET status = 'claimed', claimed_by_device = ?1, claimed_at = ?2
  WHERE id = (
    SELECT id FROM annotation_items
    WHERE workspace_id = ?3 AND queue_id = ?4 AND status = 'pending'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  )
  RETURNING ${ITEM_COLUMNS}`;

const FINALIZE_DONE_SQL = `
  /* annotations:finalize-done */
  UPDATE annotation_items
  SET status = 'done', completed_at = ?1
  WHERE workspace_id = ?2 AND queue_id = ?3 AND id = ?4 AND status IN ('pending', 'claimed')
  RETURNING ${ITEM_COLUMNS}`;

const FINALIZE_SKIPPED_SQL = `
  /* annotations:finalize-skipped */
  UPDATE annotation_items
  SET status = 'skipped', completed_at = ?1
  WHERE workspace_id = ?2 AND queue_id = ?3 AND id = ?4 AND status IN ('pending', 'claimed')
  RETURNING ${ITEM_COLUMNS}`;

const ITEM_STATUS_SQL = `
  /* annotations:item-status */
  SELECT status FROM annotation_items
  WHERE workspace_id = ?1 AND queue_id = ?2 AND id = ?3`;

type FinalizeOutcome = { ok: true; item: ItemRow } | { ok: false; status: 404 | 409 };

/**
 * Run a finalizing UPDATE (done or skipped). Its WHERE already restricts to
 * status IN ('pending','claimed'), so a null RETURNING means either the item
 * does not exist in this queue/workspace (404) or it is already terminal
 * (409) — the follow-up SELECT (read-only, outside the hot path) tells them
 * apart without weakening the UPDATE's own atomicity.
 */
async function finalizeItem(
  db: D1DatabaseLike,
  sql: string,
  workspaceId: string,
  queueId: string,
  itemId: string,
  now: number,
): Promise<FinalizeOutcome> {
  const row = await db.prepare(sql).bind(now, workspaceId, queueId, itemId).first<ItemRow>();
  if (row !== null) return { ok: true, item: row };
  const existing = await db.prepare(ITEM_STATUS_SQL).bind(workspaceId, queueId, itemId).first<{ status: string }>();
  return { ok: false, status: existing === null ? 404 : 409 };
}

// -- Durable Object notify/read (best-effort live accelerator) --------------------

function roomRequest(path: string, init?: RequestInit): Request {
  // The host is unused (namespaced entirely by idFromName); any well-formed
  // absolute URL satisfies the Request constructor.
  return new Request(`https://annotation-room.internal${path}`, init);
}

/** Fire-and-forget: never awaited by callers, never throws, never blocks the HTTP response. */
function notifyRoom(env: AnnotationsEnv, queueId: string, snapshot: CountSnapshot): void {
  const rooms = env.ANNOTATION_ROOMS;
  if (rooms === undefined) return;
  try {
    const stub = rooms.get(rooms.idFromName(queueId));
    void stub
      .fetch(roomRequest("/state", { method: "POST", body: JSON.stringify(snapshot) }))
      .catch(() => {
        // Best-effort: the room is a live-view cache, D1 stays authoritative.
      });
  } catch {
    // A synchronous throw from a misbehaving stub is equally non-blocking.
  }
}

/** Null on any absence/failure — callers fall back to the D1 count query. */
async function readRoomState(env: AnnotationsEnv, queueId: string): Promise<CountSnapshot | null> {
  const rooms = env.ANNOTATION_ROOMS;
  if (rooms === undefined) return null;
  try {
    const stub = rooms.get(rooms.idFromName(queueId));
    const response = await stub.fetch(roomRequest("/state"));
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return null;
    const record = body as Record<string, unknown>;
    if (typeof record.pending !== "number" || typeof record.claimed !== "number" || typeof record.done !== "number") {
      return null;
    }
    return { pending: record.pending, claimed: record.claimed, done: record.done };
  } catch {
    return null;
  }
}

// -- POST /v1/annotation-queues -----------------------------------------------

async function createQueue(request: Request, env: AnnotationsEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });

  const nameRaw = body.name;
  if (typeof nameRaw !== "string" || utf8Bytes(nameRaw) < 1 || utf8Bytes(nameRaw) > MAX_NAME_BYTES) {
    return json(400, { error: `name must be 1-${MAX_NAME_BYTES} UTF-8 bytes` });
  }

  const scoreNameRaw = body.score_name;
  if (typeof scoreNameRaw !== "string" || utf8Bytes(scoreNameRaw) < 1 || utf8Bytes(scoreNameRaw) > MAX_SCORE_NAME_BYTES) {
    return json(400, { error: `score_name must be 1-${MAX_SCORE_NAME_BYTES} UTF-8 bytes` });
  }

  if (typeof body.data_type !== "string" || !DATA_TYPES.has(body.data_type)) {
    return json(400, { error: "data_type must be one of NUMERIC, CATEGORY, BOOLEAN" });
  }
  const dataType = body.data_type;

  const categoriesResult = parseCategoriesInput(dataType, body.categories);
  if (!categoriesResult.ok) return json(400, { error: categoriesResult.error });

  const filter = parseTargetFilter(body.target_filter);
  if (filter === null) {
    return json(400, { error: "target_filter must be an object with only workstream/kind/status keys" });
  }

  const id = newAnnotationQueueID();
  const now = Math.floor(Date.now() / 1000);
  const filterJson = canonicalJsonStringify(filter);
  const categoriesJson = categoriesResult.value === null ? null : canonicalJsonStringify(categoriesResult.value);

  const candidates = await selectCandidateSpanIds(env.DB, auth.device.workspaceId, id, filter);
  const statements = [
    env.DB
      .prepare(INSERT_QUEUE_SQL)
      .bind(id, auth.device.workspaceId, nameRaw, filterJson, scoreNameRaw, dataType, categoriesJson, now),
  ];
  if (candidates.length > 0) {
    const itemsJson = canonicalJsonStringify(candidates.map((spanId) => ({ id: newAnnotationItemID(), target_id: spanId })));
    statements.push(env.DB.prepare(INSERT_ITEMS_SQL).bind(id, auth.device.workspaceId, now, itemsJson));
  }
  await env.DB.batch(statements);

  const snapshot = await countsForQueue(env.DB, auth.device.workspaceId, id);
  notifyRoom(env, id, snapshot);

  return json(201, {
    queue: queueView(
      { id, name: nameRaw, target_filter: filterJson, score_name: scoreNameRaw, data_type: dataType, categories: categoriesJson, active: 1, created_at: now },
      snapshot,
    ),
  });
}

// -- GET /v1/annotation-queues --------------------------------------------------

interface QueueListRow extends QueueRow {
  pending_count: number;
  done_count: number;
}

const LIST_QUEUES_COLUMNS = `
    q.id, q.workspace_id, q.name, q.target_filter, q.score_name, q.data_type, q.categories, q.active, q.created_at,
    (SELECT COUNT(*) FROM annotation_items i WHERE i.queue_id = q.id AND i.status = 'pending') AS pending_count,
    (SELECT COUNT(*) FROM annotation_items i WHERE i.queue_id = q.id AND i.status = 'done') AS done_count`;

const LIST_QUEUES_SQL = `
  /* annotations:list-queues */
  SELECT${LIST_QUEUES_COLUMNS}
  FROM annotation_queues q
  WHERE q.workspace_id = ?1
  ORDER BY q.created_at DESC, q.id DESC
  LIMIT ?2`;

const LIST_QUEUES_AFTER_SQL = `
  /* annotations:list-queues-after */
  SELECT${LIST_QUEUES_COLUMNS}
  FROM annotation_queues q
  WHERE q.workspace_id = ?1
    AND (q.created_at < ?2 OR (q.created_at = ?2 AND q.id < ?3))
  ORDER BY q.created_at DESC, q.id DESC
  LIMIT ?4`;

function compareQueueRows(a: QueueListRow, b: QueueListRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listQueues(request: Request, env: AnnotationsEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_QUEUES_SQL).bind(auth.device.workspaceId, fetchLimit).all<QueueListRow>()
      : await env.DB
          .prepare(LIST_QUEUES_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<QueueListRow>();

  const sorted = [...result.results].sort(compareQueueRows);
  const page_ = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = page_[page_.length - 1];

  return json(200, {
    items: page_.map((row) => queueView(row, { pending: row.pending_count, done: row.done_count })),
    next_cursor: hasMore && last !== undefined ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  });
}

// -- POST /v1/annotation-queues/{id}/claim --------------------------------------

async function claimNextItem(request: Request, env: AnnotationsEnv, queueId: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const queue = await loadQueue(env.DB, auth.device.workspaceId, queueId);
  if (queue === null) return json(404, { error: "not found" });

  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB
    .prepare(CLAIM_NEXT_SQL)
    .bind(auth.device.deviceId, now, auth.device.workspaceId, queueId)
    .first<ItemRow>();

  if (claimed === null) return json(200, { item: null });

  const [target, snapshot] = await Promise.all([
    targetSummary(env.DB, auth.device.workspaceId, claimed.target_type, claimed.target_id),
    countsForQueue(env.DB, auth.device.workspaceId, queueId),
  ]);
  notifyRoom(env, queueId, snapshot);

  return json(200, { item: { ...itemView(claimed), target } });
}

// -- POST /v1/annotation-queues/{id}/items/{item}/submit ------------------------

async function submitItem(request: Request, env: AnnotationsEnv, queueId: string, itemId: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const queue = await loadQueue(env.DB, auth.device.workspaceId, queueId);
  if (queue === null) return json(404, { error: "not found" });

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });

  const categories = parseStoredCategories(queue.categories);
  const validated = validateScoreValue(queue.data_type, categories, body.value);
  if (!validated.ok) return json(400, { error: validated.error });

  let comment: string | undefined;
  if (body.comment !== undefined) {
    if (typeof body.comment !== "string" || body.comment.length === 0 || utf8Bytes(body.comment) > MAX_COMMENT_BYTES) {
      return json(400, { error: `comment must be a non-empty string of at most ${MAX_COMMENT_BYTES} UTF-8 bytes` });
    }
    comment = body.comment;
  }

  const now = Math.floor(Date.now() / 1000);
  const outcome = await finalizeItem(env.DB, FINALIZE_DONE_SQL, auth.device.workspaceId, queueId, itemId, now);
  if (!outcome.ok) {
    return json(outcome.status, {
      error: outcome.status === 404 ? "not found" : "annotation item is already finalized",
    });
  }
  const item = outcome.item;

  const workstreamId = await lookupTargetWorkstreamId(env.DB, auth.device.workspaceId, item.target_type, item.target_id);
  const payload: Record<string, unknown> = {
    name: queue.score_name,
    data_type: queue.data_type,
    value: validated.value,
    target_type: item.target_type,
    target_id: item.target_id,
    source: "human",
  };
  if (comment !== undefined) payload.comment = comment;

  const nowMs = Date.now();
  const eventId = await annotationScoreEventID(itemId, payload, nowMs);
  const occurredAt = new Date(nowMs).toISOString();
  await insertAnnotationScoreEvent(env.DB, auth.device.workspaceId, eventId, occurredAt, workstreamId, now, payload);

  const snapshot = await countsForQueue(env.DB, auth.device.workspaceId, queueId);
  notifyRoom(env, queueId, snapshot);

  return json(200, {
    item: itemView(item),
    score: {
      event_id: eventId,
      name: queue.score_name,
      data_type: queue.data_type,
      value: validated.value,
      target_type: item.target_type,
      target_id: item.target_id,
      source: "human",
      comment: comment ?? null,
    },
  });
}

// -- POST /v1/annotation-queues/{id}/items/{item}/skip ---------------------------

async function skipItem(request: Request, env: AnnotationsEnv, queueId: string, itemId: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const queue = await loadQueue(env.DB, auth.device.workspaceId, queueId);
  if (queue === null) return json(404, { error: "not found" });

  const now = Math.floor(Date.now() / 1000);
  const outcome = await finalizeItem(env.DB, FINALIZE_SKIPPED_SQL, auth.device.workspaceId, queueId, itemId, now);
  if (!outcome.ok) {
    return json(outcome.status, {
      error: outcome.status === 404 ? "not found" : "annotation item is already finalized",
    });
  }

  const snapshot = await countsForQueue(env.DB, auth.device.workspaceId, queueId);
  notifyRoom(env, queueId, snapshot);

  return json(200, { item: itemView(outcome.item) });
}

// -- POST /v1/annotation-queues/{id}/refill --------------------------------------

async function refillQueue(request: Request, env: AnnotationsEnv, queueId: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const queue = await loadQueue(env.DB, auth.device.workspaceId, queueId);
  if (queue === null) return json(404, { error: "not found" });

  const filter = readStoredFilter(queue.target_filter);
  const candidates = await selectCandidateSpanIds(env.DB, auth.device.workspaceId, queueId, filter);
  if (candidates.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const itemsJson = canonicalJsonStringify(candidates.map((spanId) => ({ id: newAnnotationItemID(), target_id: spanId })));
    await env.DB.prepare(INSERT_ITEMS_SQL).bind(queueId, auth.device.workspaceId, now, itemsJson).run();
  }

  const snapshot = await countsForQueue(env.DB, auth.device.workspaceId, queueId);
  notifyRoom(env, queueId, snapshot);

  return json(200, { queue: queueView(queue, { pending: snapshot.pending, done: snapshot.done }) });
}

// -- GET /v1/annotation-queues/{id}/live -----------------------------------------

async function getLiveState(request: Request, env: AnnotationsEnv, queueId: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const queue = await loadQueue(env.DB, auth.device.workspaceId, queueId);
  if (queue === null) return json(404, { error: "not found" });

  const fromRoom = await readRoomState(env, queueId);
  const snapshot = fromRoom ?? (await countsForQueue(env.DB, auth.device.workspaceId, queueId));

  return json(200, { queue_id: queueId, pending: snapshot.pending, claimed: snapshot.claimed, done: snapshot.done });
}

// -- routing ---------------------------------------------------------------------

/**
 * Route the annotation-queues HTTP surface. Returns null when this module
 * does not own the path (or owns the path but not this method — the
 * platform-wide catch-all in index.ts answers 404 for those).
 */
export async function handleAnnotationsRoute(request: Request, env: AnnotationsEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === QUEUES_PATH) {
    if (request.method === "POST") return createQueue(request, env);
    if (request.method === "GET") return listQueues(request, env);
    return null;
  }

  const claimMatch = CLAIM_PATH.exec(pathname);
  if (claimMatch !== null) {
    if (request.method === "POST") return claimNextItem(request, env, claimMatch[1]);
    return null;
  }

  const submitMatch = SUBMIT_PATH.exec(pathname);
  if (submitMatch !== null) {
    if (request.method === "POST") return submitItem(request, env, submitMatch[1], submitMatch[2]);
    return null;
  }

  const skipMatch = SKIP_PATH.exec(pathname);
  if (skipMatch !== null) {
    if (request.method === "POST") return skipItem(request, env, skipMatch[1], skipMatch[2]);
    return null;
  }

  const refillMatch = REFILL_PATH.exec(pathname);
  if (refillMatch !== null) {
    if (request.method === "POST") return refillQueue(request, env, refillMatch[1]);
    return null;
  }

  const liveMatch = LIVE_PATH.exec(pathname);
  if (liveMatch !== null) {
    if (request.method === "GET") return getLiveState(request, env, liveMatch[1]);
    return null;
  }

  return null;
}

// -- Durable Object: AnnotationQueueRoom (parity row 28's live-state half) --------
//
// Holds the last-known {pending, claimed, done} snapshot for one queue in
// memory (one room per queue, idFromName(queue_id) — see notifyRoom/
// readRoomState above). A GET returns the current snapshot as JSON; a POST
// overwrites it wholesale (route handlers always send the fresh,
// D1-recomputed snapshot, never a delta, so the room can never drift out of
// sync by accumulating partial updates). WebSockets / push-to-viewer are
// explicitly out of scope for v1 — a viewer polls GET .../live, which proxies
// here when env.ANNOTATION_ROOMS is bound.
//
// State is memory-only: nothing is written to Durable Object storage. A room
// that evicts and restarts comes back at {0,0,0} until the next mutation
// notifies it, which is exactly why every route handler above falls back to
// a D1 COUNT query whenever the room is absent OR its response cannot be
// parsed as a snapshot, rather than ever trusting an unconditional read.
//
// Deliberately does NOT import `cloudflare:workers` (no `extends
// DurableObject<Env>`): the platform test suite runs in plain node with no
// miniflare, and a static `cloudflare:workers` import would make this module
// unloadable there — same convention as src/simulations.ts's
// SimulationWorkflow. The classic constructor(state, env) + fetch(request)
// shape below is a fully valid, independently-deployable Durable Object
// without extending anything; wiring in the real binding is the commented
// [[durable_objects.bindings]] block in wrangler.toml, nothing here needs to
// change.
export class AnnotationQueueRoom {
  private pending = 0;
  private claimed = 0;
  private done = 0;

  constructor(_state: unknown, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "invalid snapshot" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      if (body === null || typeof body !== "object") {
        return new Response(JSON.stringify({ error: "invalid snapshot" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const snapshot = body as Record<string, unknown>;
      this.pending = safeCount(snapshot.pending);
      this.claimed = safeCount(snapshot.claimed);
      this.done = safeCount(snapshot.done);
      return this.stateResponse();
    }
    if (request.method === "GET") return this.stateResponse();
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  }

  private stateResponse(): Response {
    return new Response(JSON.stringify({ pending: this.pending, claimed: this.claimed, done: this.done }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
