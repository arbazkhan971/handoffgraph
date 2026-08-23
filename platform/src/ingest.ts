// Event-batch ingestion and workstream listing: pure, deterministic logic
// used by the Worker handlers in index.ts. Handlers own I/O; everything here
// is side-effect free so unit tests run against plain objects.

import { sha256Hex } from "./auth";

export const BATCH_SCHEMA_VERSION = "hfg.event-batch.v1";
export const EVENT_SCHEMA_VERSION = "hfg.event.v1";
export const RECEIPT_SCHEMA_VERSION = "hfg.event-batch.receipt.v1";

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// These fields are copied out of raw_json into indexed/read-model columns.
// Bound their encoded size so one otherwise-valid event cannot multiply its
// storage footprint across D1 indexes and projections.
export const MAX_KIND_BYTES = 64;
export const MAX_PROVIDER_BYTES = 64;
export const MAX_NATIVE_SESSION_ID_BYTES = 256;
export const MAX_PROVENANCE_BYTES = 8;
export const MAX_CONTENT_HASH_BYTES = 71; // "sha256:" + 64 lowercase hex digits
export const MAX_WORKSTREAM_TITLE_BYTES = 200;
export const MAX_TIMESTAMP_BYTES = 35; // RFC3339Nano with a numeric offset

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const EVENT_ID_PATTERN = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
export const WORKSTREAM_ID_PATTERN = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const SESSION_ID_PATTERN = /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const REPOSITORY_ID_PATTERN = /^repo_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const PROVENANCE_VALUES = new Set(["OBSERVED", "DECLARED", "INFERRED"]);
const UTF8_ENCODER = new TextEncoder();
const DEFAULT_WORKSTREAM_TITLE = "Untitled workstream";

export interface IngestEvent {
  schema_version: string;
  event_id: string;
  kind: string;
  occurred_at: string;
  observed_at: string;
  sequence?: number;
  workstream_id?: string;
  session_id?: string;
  native_session_id?: string;
  provider?: string;
  provenance?: string;
  content_hash?: string;
  repository_id?: string;
  payload?: unknown;
  redaction?: unknown;
  [field: string]: unknown;
}

export interface EventBatchEnvelope {
  schema_version: string;
  workspace_id?: string;
  events: IngestEvent[];
  [field: string]: unknown;
}

export interface Receipt {
  accepted: number;
  batch_id: string;
  schema_version: string;
  workspace_id: string;
}

export interface EventRow {
  workspace_id: string;
  event_id: string;
  idempotency_key: string;
  occurred_at: string;
  workstream_id: string | null;
  session_id: string | null;
  native_session_id: string | null;
  provider: string | null;
  kind: string;
  provenance: string | null;
  content_hash: string | null;
  ingested_at: number;
  raw_json: string;
}

/** Deterministic workstream read-model update derived from one raw event. */
export interface WorkstreamProjectionRow {
  id: string;
  workspace_id: string;
  repository_id: string | null;
  title: string;
  status: "active" | "completed";
  created_at: number;
  updated_at: number;
  title_event_at_ms: number | null;
  title_event_id: string | null;
  status_event_at_ms: number | null;
  status_event_id: string | null;
  source_event_id: string;
}

export interface Cursor {
  createdAt: number;
  id: string;
}

export interface Pagination {
  limit: number;
  cursor: Cursor | null;
}

export interface WorkstreamRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  repository_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkstreamSummary {
  id: string;
  title: string;
  status: string;
  repository_id: string | null;
  created_at: number;
  updated_at: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

function invalid(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  // UTF-8 always needs at least one byte per UTF-16 code unit. This cheap
  // check avoids allocating an attacker-sized Uint8Array when an ASCII-ish
  // value is already obviously over its cap; encoding handles multibyte
  // values that are short in JavaScript characters.
  return value.length > maxBytes || UTF8_ENCODER.encode(value).byteLength > maxBytes;
}

/**
 * Ensure canonicalization cannot silently rewrite evidence. JSON.parse turns
 * exponent overflow into Infinity and JSON.stringify turns Infinity into
 * null; unsafe integers have already lost precision. Both must fail before
 * hashing or storage. A depth/node bound also prevents recursive canonical
 * encoding from becoming an attacker-controlled stack/CPU sink.
 */
function validateJsonValue(root: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return `JSON exceeds ${MAX_JSON_NODES} values`;
    const value = item.value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "JSON numbers must be finite";
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        return "JSON integers must be within the safe integer range";
      }
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value !== "object") return "envelope contains a non-JSON value";
    if (seen.has(value)) return "envelope must not contain cyclic values";
    seen.add(value);
    if (item.depth >= MAX_JSON_DEPTH) return `JSON nesting exceeds ${MAX_JSON_DEPTH} levels`;
    const children = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return null;
}

/**
 * Validate a parsed event-batch envelope against the token's workspace.
 *
 * The workspace binding ALWAYS comes from the device token; a workspace_id in
 * the body is only checked for consistency: a mismatched one targets a
 * foreign workspace, which is a 404 so foreign resources' existence is never
 * leaked.
 */
export function validateEventBatch(
  value: unknown,
  tokenWorkspaceId: string,
): Validation<EventBatchEnvelope> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(400, "envelope must be a JSON object");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.schema_version !== BATCH_SCHEMA_VERSION) {
    return invalid(400, `schema_version must be ${BATCH_SCHEMA_VERSION}`);
  }
  if (typeof envelope.workspace_id !== "undefined") {
    if (typeof envelope.workspace_id !== "string") {
      return invalid(400, "workspace_id must be a string");
    }
    if (envelope.workspace_id !== tokenWorkspaceId) {
      // Foreign workspace: never confirm it exists.
      return invalid(404, "not found");
    }
  }
  const events = envelope.events;
  if (!Array.isArray(events) || events.length === 0) {
    return invalid(400, "events must be a non-empty array");
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return invalid(413, `batch exceeds ${MAX_EVENTS_PER_BATCH} events`);
  }
  const eventIDs = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const error = validateEvent(events[i], i);
    if (error !== null) return invalid(400, error);
    const eventID = (events[i] as Record<string, unknown>).event_id as string;
    if (eventIDs.has(eventID)) {
      return invalid(400, `events[${i}].event_id duplicates an earlier event`);
    }
    eventIDs.add(eventID);
  }
  // Run whole-document numeric/depth validation after field-specific checks
  // so malformed required fields retain precise protocol errors. Requests
  // have already passed JSON.parse, so any other non-JSON value is rejected.
  const jsonError = validateJsonValue(value);
  if (jsonError !== null) return invalid(400, jsonError);
  return { ok: true, value: envelope as unknown as EventBatchEnvelope };
}

/** Per-event minimum validation; everything else is preserved verbatim. */
function validateEvent(value: unknown, index: number): string | null {
  const at = `events[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${at} must be an object`;
  }
  const event = value as Record<string, unknown>;
  if (event.schema_version !== EVENT_SCHEMA_VERSION) {
    return `${at}.schema_version must be ${EVENT_SCHEMA_VERSION}`;
  }
  if (typeof event.event_id !== "string" || !EVENT_ID_PATTERN.test(event.event_id)) {
    return `${at}.event_id must match ${EVENT_ID_PATTERN.source}`;
  }
  if (typeof event.kind !== "string" || event.kind.length === 0) {
    return `${at}.kind must be a non-empty string`;
  }
  if (exceedsUtf8Bytes(event.kind, MAX_KIND_BYTES)) {
    return `${at}.kind must be at most ${MAX_KIND_BYTES} UTF-8 bytes`;
  }
  if (
    typeof event.occurred_at !== "string" ||
    exceedsUtf8Bytes(event.occurred_at, MAX_TIMESTAMP_BYTES) ||
    !RFC3339_PATTERN.test(event.occurred_at) ||
    !Number.isFinite(Date.parse(event.occurred_at))
  ) {
    return `${at}.occurred_at must be an RFC 3339 timestamp`;
  }
  if (
    typeof event.observed_at !== "string" ||
    exceedsUtf8Bytes(event.observed_at, MAX_TIMESTAMP_BYTES) ||
    !RFC3339_PATTERN.test(event.observed_at) ||
    !Number.isFinite(Date.parse(event.observed_at))
  ) {
    return `${at}.observed_at must be an RFC 3339 timestamp`;
  }

  const workstreamIDError = optionalPatternError(
    event,
    "workstream_id",
    WORKSTREAM_ID_PATTERN,
    at,
  );
  if (workstreamIDError !== null) return workstreamIDError;
  const sessionIDError = optionalPatternError(event, "session_id", SESSION_ID_PATTERN, at);
  if (sessionIDError !== null) return sessionIDError;
  const repositoryIDError = optionalPatternError(
    event,
    "repository_id",
    REPOSITORY_ID_PATTERN,
    at,
  );
  if (repositoryIDError !== null) return repositoryIDError;

  const nativeSessionIDError = optionalBoundedStringError(
    event,
    "native_session_id",
    MAX_NATIVE_SESSION_ID_BYTES,
    at,
  );
  if (nativeSessionIDError !== null) return nativeSessionIDError;
  const providerError = optionalBoundedStringError(
    event,
    "provider",
    MAX_PROVIDER_BYTES,
    at,
  );
  if (providerError !== null) return providerError;

  if (event.provenance !== undefined) {
    if (
      typeof event.provenance !== "string" ||
      exceedsUtf8Bytes(event.provenance, MAX_PROVENANCE_BYTES) ||
      !PROVENANCE_VALUES.has(event.provenance)
    ) {
      return `${at}.provenance must be one of OBSERVED, DECLARED, INFERRED`;
    }
  }
  if (event.content_hash !== undefined) {
    if (
      typeof event.content_hash !== "string" ||
      exceedsUtf8Bytes(event.content_hash, MAX_CONTENT_HASH_BYTES) ||
      !CONTENT_HASH_PATTERN.test(event.content_hash)
    ) {
      return `${at}.content_hash must match ${CONTENT_HASH_PATTERN.source}`;
    }
  }

  const titleError = workstreamTitleError(event, at);
  if (titleError !== null) return titleError;

  if (typeof event.sequence !== "undefined") {
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 0) {
      return `${at}.sequence must be a non-negative safe integer`;
    }
  }
  if (event.redaction !== undefined) {
    if (event.redaction === null || typeof event.redaction !== "object" || Array.isArray(event.redaction)) {
      return `${at}.redaction must be an object`;
    }
    const status = (event.redaction as Record<string, unknown>).status;
    if (status === "failed" || status === "REDACTION_FAILED") {
      return `${at}.redaction status forbids sync`;
    }
  }
  return null;
}

function optionalPatternError(
  event: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  at: string,
): string | null {
  const value = event[field];
  if (value === undefined) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    return `${at}.${field} must match ${pattern.source}`;
  }
  return null;
}

function optionalBoundedStringError(
  event: Record<string, unknown>,
  field: string,
  maxBytes: number,
  at: string,
): string | null {
  const value = event[field];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    return `${at}.${field} must be a non-empty string`;
  }
  if (exceedsUtf8Bytes(value, maxBytes)) {
    return `${at}.${field} must be at most ${maxBytes} UTF-8 bytes`;
  }
  return null;
}

function workstreamTitleError(event: Record<string, unknown>, at: string): string | null {
  if (event.kind !== "workstream.started") return null;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const title = (payload as Record<string, unknown>).title;
  if (title === undefined) return null;
  if (typeof title !== "string") return `${at}.payload.title must be a string`;
  if (exceedsUtf8Bytes(title, MAX_WORKSTREAM_TITLE_BYTES)) {
    return `${at}.payload.title must be at most ${MAX_WORKSTREAM_TITLE_BYTES} UTF-8 bytes`;
  }
  return null;
}

/** Request bodies larger than 1 MiB are rejected before parsing. */
export function exceedsMaxBodyBytes(byteLength: number): boolean {
  return byteLength > MAX_BODY_BYTES;
}

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413; error: "unreadable request body" | "request body too large" };

/** Read a UTF-8 request body without ever buffering beyond the stated cap. */
export async function readRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, status: 413, error: "request body too large" };
    }
  }

  if (request.body === null) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("request body too large");
        return { ok: false, status: 413, error: "request body too large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false, status: 400, error: "unreadable request body" };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Deterministic JSON encoding: object keys sorted, no insignificant
 * whitespace, undefined values dropped. Mirrors the Go canonical encoding
 * used for content hashing, so identical values produce identical bytes.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Build the deterministic receipt for an accepted batch. The same key + the
 * same events always produce the same receipt, so replays return the original
 * bytes even if they are recomputed rather than read back.
 */
export async function buildReceipt(
  idempotencyKey: string,
  workspaceId: string,
  envelope: EventBatchEnvelope,
): Promise<Receipt> {
  const canonical = canonicalJsonStringify({
    event_ids: envelope.events.map((event) => event.event_id),
    idempotency_key: idempotencyKey,
    schema_version: envelope.schema_version,
    workspace_id: workspaceId,
  });
  const digest = await sha256Hex(canonical);
  return {
    accepted: envelope.events.length,
    batch_id: `batch_${digest.slice(0, 32)}`,
    schema_version: RECEIPT_SCHEMA_VERSION,
    workspace_id: workspaceId,
  };
}

/**
 * Flatten a validated envelope into append-only event rows. The workspace
 * always comes from the token binding, never from the envelope body.
 * raw_json is canonical, so unknown fields survive losslessly.
 */
export function buildEventRows(
  envelope: EventBatchEnvelope,
  workspaceId: string,
  idempotencyKey: string,
  ingestedAtSeconds: number,
): EventRow[] {
  return envelope.events.map((event) => ({
    workspace_id: workspaceId,
    event_id: event.event_id,
    idempotency_key: idempotencyKey,
    occurred_at: event.occurred_at,
    workstream_id: optionalString(event.workstream_id),
    session_id: optionalString(event.session_id),
    native_session_id: optionalString(event.native_session_id),
    provider: optionalString(event.provider),
    kind: event.kind,
    provenance: optionalString(event.provenance),
    content_hash: optionalString(event.content_hash),
    ingested_at: ingestedAtSeconds,
    raw_json: canonicalJsonStringify(event),
  }));
}

/**
 * Derive bounded workstream projection updates from accepted events.
 *
 * One row is emitted for every event carrying a workstream id. The D1 upsert
 * compares source timestamps and event ids, so replay and out-of-order batch
 * arrival converge on the same title/status/created-at values.
 */
export function buildWorkstreamProjectionRows(
  envelope: EventBatchEnvelope,
  workspaceId: string,
): WorkstreamProjectionRow[] {
  return envelope.events.flatMap((event) => {
    const id = optionalString(event.workstream_id);
    if (id === null) return [];

    const occurredAtMS = Date.parse(event.occurred_at);
    const occurredAtSeconds = Math.floor(occurredAtMS / 1000);
    const title = event.kind === "workstream.started"
      ? boundedPayloadString(event.payload, "title", MAX_WORKSTREAM_TITLE_BYTES)
      : null;
    // Valid workstream IDs are 29 ASCII bytes. The constant fallback also
    // keeps this pure builder bounded if a caller violates its validated-input
    // precondition, so a malformed ID is never duplicated into the title.
    const fallbackTitle = !exceedsUtf8Bytes(id, MAX_WORKSTREAM_TITLE_BYTES)
      ? id
      : DEFAULT_WORKSTREAM_TITLE;
    const status = event.kind === "workstream.completed" ? "completed" : "active";
    const isStatusEvent =
      event.kind === "workstream.started" || event.kind === "workstream.completed";

    return [{
      id,
      workspace_id: workspaceId,
      repository_id: optionalString(event.repository_id),
      title: title ?? fallbackTitle,
      status,
      created_at: occurredAtSeconds,
      updated_at: occurredAtSeconds,
      title_event_at_ms: title === null ? null : occurredAtMS,
      title_event_id: title === null ? null : event.event_id,
      status_event_at_ms: isStatusEvent ? occurredAtMS : null,
      status_event_id: isStatusEvent ? event.event_id : null,
      source_event_id: event.event_id,
    }];
  });
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadString(payload: unknown, field: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return optionalString((payload as Record<string, unknown>)[field]);
}

function boundedPayloadString(payload: unknown, field: string, maxBytes: number): string | null {
  const value = payloadString(payload, field);
  return value !== null && !exceedsUtf8Bytes(value, maxBytes) ? value : null;
}

/** Encode a pagination cursor as an opaque, stable base64url token. */
export function encodeCursor(cursor: Cursor): string {
  const json = canonicalJsonStringify({ created_at: cursor.createdAt, id: cursor.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a cursor token; null when malformed (callers answer 400). */
export function decodeCursor(encoded: string): Cursor | null {
  try {
    const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.created_at !== "number" || !Number.isFinite(record.created_at)) {
      return null;
    }
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    return { createdAt: record.created_at, id: record.id };
  } catch {
    return null;
  }
}

/** Parse `?cursor=&limit=` into a validated pagination. */
export function parsePagination(url: URL): Validation<Pagination> {
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      return invalid(400, `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
    limit = parsed;
  }
  const rawCursor = url.searchParams.get("cursor");
  let cursor: Cursor | null = null;
  if (rawCursor !== null && rawCursor !== "") {
    cursor = decodeCursor(rawCursor);
    if (cursor === null) return invalid(400, "cursor is invalid");
  }
  return { ok: true, value: { limit, cursor } };
}

/**
 * Shape a workstream page. Rows are re-sorted (created_at DESC, id DESC)
 * before emitting so the response never depends on storage order. Callers
 * fetch limit+1 rows; a next_cursor is emitted only when that extra row
 * proved another page exists.
 */
export function buildWorkstreamListResponse(
  rows: WorkstreamRow[],
  limit: number,
): { workstreams: WorkstreamSummary[]; next_cursor: string | null } {
  const sorted = [...rows].sort(compareWorkstreamRows);
  const page = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = page[page.length - 1];
  return {
    workstreams: page.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      repository_id: row.repository_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

function compareWorkstreamRows(a: WorkstreamRow, b: WorkstreamRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

export interface ScopeCheck {
  /** Workspace the addressed resource lives in, when known. */
  resourceWorkspaceId?: string | null;
  /** Workspace the authenticated device is bound to. */
  tokenWorkspaceId: string;
  /** Whether the device may perform the operation on its own workspace. */
  allowed?: boolean;
}

/**
 * Platform-wide denial rule:
 *   - a resource in a foreign workspace is 404 (existence is never leaked);
 *   - a resource in the device's own workspace that the device may not touch
 *     is 403.
 */
export function scopeDenial(check: ScopeCheck): { status: 404 | 403; error: string } | null {
  const { resourceWorkspaceId, tokenWorkspaceId, allowed } = check;
  if (resourceWorkspaceId != null && resourceWorkspaceId !== tokenWorkspaceId) {
    return { status: 404, error: "not found" };
  }
  if (allowed === false) return { status: 403, error: "forbidden" };
  return null;
}
