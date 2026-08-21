// Event-batch ingestion and workstream listing: pure, deterministic logic
// used by the Worker handlers in index.ts. Handlers own I/O; everything here
// is side-effect free so unit tests run against plain objects.

import { sha256Hex } from "./auth";

export const BATCH_SCHEMA_VERSION = "hfg.event-batch.v1";
export const EVENT_SCHEMA_VERSION = "hfg.event.v1";
export const RECEIPT_SCHEMA_VERSION = "hfg.event-batch.receipt.v1";

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const EVENT_ID_PATTERN = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]/;

export interface IngestEvent {
  schema_version: string;
  event_id: string;
  kind: string;
  occurred_at: string;
  sequence?: number;
  workstream_id?: string;
  session_id?: string;
  native_session_id?: string;
  provider?: string;
  provenance?: string;
  content_hash?: string;
  payload?: unknown;
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

function invalid(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
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
  for (let i = 0; i < events.length; i++) {
    const error = validateEvent(events[i], i);
    if (error !== null) return invalid(400, error);
  }
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
  if (
    typeof event.occurred_at !== "string" ||
    !OCCURRED_AT_PATTERN.test(event.occurred_at) ||
    !Number.isFinite(Date.parse(event.occurred_at))
  ) {
    return `${at}.occurred_at must be an RFC 3339 timestamp`;
  }
  return null;
}

/** Request bodies larger than 1 MiB are rejected before parsing. */
export function exceedsMaxBodyBytes(byteLength: number): boolean {
  return byteLength > MAX_BODY_BYTES;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
