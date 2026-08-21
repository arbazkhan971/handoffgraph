// HandoffGraph platform API Worker (skeleton).
//
// Endpoints:
//   GET  /healthz           liveness (no auth)
//   POST /v1/event-batches  authenticated, idempotent event ingestion
//   GET  /v1/workstreams    cursor-paginated, workspace-scoped listing
//
// Invariants (see docs/architecture.md and platform/README.md):
//   - workspace identity comes only from the device token binding;
//   - events are append-only (INSERT OR IGNORE, keyed on event_id);
//   - receipts are deterministic, so replays return the original bytes;
//   - foreign resources 404, own-but-forbidden 403.

import { authenticate, hasCapability, type DeviceBinding, type DeviceLookup } from "./auth";
import {
  MAX_BODY_BYTES,
  buildEventRows,
  buildReceipt,
  buildWorkstreamListResponse,
  canonicalJsonStringify,
  exceedsMaxBodyBytes,
  parsePagination,
  scopeDenial,
  validateEventBatch,
  type WorkstreamRow,
} from "./ingest";

// ---------------------------------------------------------------------------
// Minimal ambient surface (Workers runtime; also provided by Node >= 18 for
// tests). Only what this Worker actually touches.
// ---------------------------------------------------------------------------

declare global {
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

// ---------------------------------------------------------------------------
// D1 seam: only the surface this Worker uses, so tests can mock plain objects.
// ---------------------------------------------------------------------------

export interface D1BoundStatement {
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1BoundStatement;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1BoundStatement[]): Promise<T[]>;
}

export interface Env {
  /** D1 binding (wrangler.toml [[d1_databases]], binding = "DB"). */
  DB: D1DatabaseLike;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function canonicalResponse(status: number, canonicalJson: string): Response {
  return new Response(canonicalJson, { status, headers: JSON_HEADERS });
}

// -- routing ----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse(200, { status: "ok" });
      }
      if (request.method === "POST" && pathname === "/v1/event-batches") {
        return await handleEventBatches(request, env);
      }
      if (request.method === "GET" && pathname === "/v1/workstreams") {
        return await handleListWorkstreams(request, env);
      }
      return jsonResponse(404, { error: "not found" });
    } catch {
      // Never leak internals.
      return jsonResponse(500, { error: "internal error" });
    }
  },
} satisfies { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

// -- device lookup -----------------------------------------------------------

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

// -- POST /v1/event-batches ---------------------------------------------------

const IDEMPOTENCY_RECEIPT_SQL = `
  SELECT workspace_id, receipt_json
  FROM idempotency_keys
  WHERE key = ?1`;

const INSERT_IDEMPOTENCY_SQL = `
  INSERT INTO idempotency_keys (key, workspace_id, device_id, receipt_json, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)`;

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`;

async function handleEventBatches(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });
  const { device } = auth;

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 256) {
    return jsonResponse(400, { error: "Idempotency-Key header is required" });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && exceedsMaxBodyBytes(declaredLength)) {
    return jsonResponse(413, { error: "request body exceeds 1 MiB" });
  }
  const body = await request.text();
  if (exceedsMaxBodyBytes(new TextEncoder().encode(body).length)) {
    return jsonResponse(413, { error: "request body exceeds 1 MiB" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse(400, { error: "request body is not valid JSON" });
  }

  const validation = validateEventBatch(parsed, device.workspaceId);
  if (!validation.ok) return jsonResponse(validation.status, { error: validation.error });
  const envelope = validation.value;

  // Idempotent replay: the same key returns the original receipt bytes.
  const existing = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
    .bind(idempotencyKey)
    .first<{ workspace_id: string; receipt_json: string }>();
  if (existing !== null) {
    const denial = scopeDenial({
      resourceWorkspaceId: existing.workspace_id,
      tokenWorkspaceId: device.workspaceId,
    });
    if (denial !== null) return jsonResponse(denial.status, { error: denial.error });
    return canonicalResponse(200, existing.receipt_json);
  }

  const ingestedAt = Math.floor(Date.now() / 1000);
  const receipt = await buildReceipt(idempotencyKey, device.workspaceId, envelope);
  const receiptJson = canonicalJsonStringify(receipt);
  const rows = buildEventRows(envelope, device.workspaceId, idempotencyKey, ingestedAt);

  const statements = [
    env.DB.prepare(INSERT_IDEMPOTENCY_SQL).bind(
      idempotencyKey,
      device.workspaceId,
      device.deviceId,
      receiptJson,
      ingestedAt,
    ),
    ...rows.map((row) =>
      env.DB.prepare(INSERT_EVENT_SQL).bind(
        row.workspace_id,
        row.event_id,
        row.idempotency_key,
        row.occurred_at,
        row.workstream_id,
        row.session_id,
        row.native_session_id,
        row.provider,
        row.kind,
        row.provenance,
        row.content_hash,
        row.ingested_at,
        row.raw_json,
      ),
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch {
    // Lost a race against a concurrent batch with the same key: the winner's
    // receipt is authoritative.
    const winner = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
      .bind(idempotencyKey)
      .first<{ workspace_id: string; receipt_json: string }>();
    if (winner !== null && winner.workspace_id === device.workspaceId) {
      return canonicalResponse(200, winner.receipt_json);
    }
    return jsonResponse(500, { error: "internal error" });
  }

  return canonicalResponse(200, receiptJson);
}

// -- GET /v1/workstreams ------------------------------------------------------

const WORKSTREAMS_PAGE_SQL = `
  SELECT id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const WORKSTREAMS_PAGE_AFTER_SQL = `
  SELECT id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

async function handleListWorkstreams(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });

  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, "read"),
  });
  if (denial !== null) return jsonResponse(denial.status, { error: denial.error });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return jsonResponse(page.status, { error: page.error });
  const { limit, cursor } = page.value;

  const fetchLimit = limit + 1; // prefetch one row to detect the next page
  const result =
    cursor === null
      ? await env.DB.prepare(WORKSTREAMS_PAGE_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<WorkstreamRow>()
      : await env.DB.prepare(WORKSTREAMS_PAGE_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<WorkstreamRow>();

  return jsonResponse(200, buildWorkstreamListResponse(result.results, limit));
}
