// HandoffGraph platform API Worker foundation.
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

import {
  authenticate,
  hasCapability,
  sha256Hex,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import {
  authenticateAccountSession,
  handleAccountRoute,
  type AccountEnv,
  type SessionAccount,
} from "./account";
import {
  accountPageCSP,
  renderAccountPage,
  renderSignedOutPage,
  type AccountPageData,
} from "./account_page";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1Statement,
} from "./db";
export type { D1BoundStatement, D1DatabaseLike, D1Statement } from "./db";
import {
  MAX_BODY_BYTES,
  buildReceipt,
  buildWorkstreamListResponse,
  buildWorkstreamProjectionRows,
  canonicalJsonStringify,
  parsePagination,
  readRequestBody,
  scopeDenial,
  validateEventBatch,
  type WorkstreamRow,
} from "./ingest";
import { PLAN_CATALOG } from "./plans";
import { prepareQuotaReservation } from "./quota";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function canonicalResponse(status: number, canonicalJson: string): Response {
  return new Response(canonicalJson, { status, headers: JSON_HEADERS });
}

// -- routing ----------------------------------------------------------------

export default {
  async fetch<E extends AccountEnv>(
    request: Request,
    env: E,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse(200, { status: "ok" });
      }
      if (request.method === "GET" && pathname === "/") {
        const destination = env.LANDING_ORIGIN ?? "/account";
        return new Response(null, {
          status: 303,
          headers: { location: destination, "cache-control": "no-store" },
        });
      }
      if (request.method === "GET" && pathname === "/account") {
        return await handleAccountPage(request, env);
      }
      if (request.method === "GET" && pathname === "/v1/plans") {
        return jsonResponse(200, { plans: Object.values(PLAN_CATALOG) });
      }
      const accountResponse = await handleAccountRoute(request, env);
      if (accountResponse !== null) return accountResponse;
      if (request.method === "POST" && pathname === "/v1/event-batches") {
        return await handleEventBatches(request, env);
      }
      if (request.method === "GET" && pathname === "/v1/workstreams") {
        return await handleListWorkstreams(request, env);
      }
      return jsonResponse(404, { error: "not found" });
    } catch (error) {
      // Content-free structured logging: never log headers, tokens, bodies,
      // query strings, SQL binds, or captured event fields.
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: pathname,
        error_type: error instanceof Error ? error.name : "unknown",
      }));
      // Never leak internals.
      return jsonResponse(500, { error: "internal error" });
    }
  },
} satisfies ExportedHandler<Env>;

function accountPageData(session: SessionAccount): AccountPageData {
  return {
    displayName: session.displayName ?? "Your account",
    email: session.email,
    workspaceName: session.workspaceName,
    workspaceId: session.workspaceId,
    planName: session.planId === "basic" ? "Hosted Basic" : session.planId,
    planStatus: session.planStatus,
    planPeriod: `Resets ${new Date(session.periodEnd * 1_000).toISOString().slice(0, 10)}`,
    usage: [
      {
        label: "Monthly events",
        used: session.usedMonthlyEvents,
        limit: session.maxMonthlyEvents,
        unit: "events",
      },
      {
        label: "Lifetime events",
        used: session.usedLifetimeEvents,
        limit: session.maxLifetimeEvents,
        unit: "events",
      },
      {
        label: "Lifetime upload",
        used: Math.ceil(session.usedLifetimeBytes / 1_048_576),
        limit: Math.ceil(session.maxLifetimeBytes / 1_048_576),
        unit: "MiB",
      },
      {
        label: "Active devices",
        used: session.activeDevices,
        limit: session.maxDevices,
        unit: "devices",
      },
      {
        label: "Device-token issuances",
        used: session.usedDeviceIssuances,
        limit: session.maxDeviceIssuances,
        unit: "issued",
      },
    ],
  };
}

async function handleAccountPage(request: Request, env: AccountEnv): Promise<Response> {
  const session = await authenticateAccountSession(request, env.DB);
  const signedIn = session !== null;
  const html = signedIn
    ? renderAccountPage(accountPageData(session))
    : renderSignedOutPage();
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `${accountPageCSP(signedIn)}; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

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
  SELECT workspace_id, request_hash, receipt_json
  FROM idempotency_keys
  WHERE workspace_id = ?1 AND key = ?2`;

const INSERT_IDEMPOTENCY_SQL = `
  INSERT INTO idempotency_keys
    (key, workspace_id, device_id, request_hash, receipt_json, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)`;

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  SELECT
    ?1,
    json_extract(input.value, '$.event_id'),
    ?2,
    json_extract(input.value, '$.occurred_at'),
    json_extract(input.value, '$.workstream_id'),
    json_extract(input.value, '$.session_id'),
    json_extract(input.value, '$.native_session_id'),
    json_extract(input.value, '$.provider'),
    json_extract(input.value, '$.kind'),
    json_extract(input.value, '$.provenance'),
    json_extract(input.value, '$.content_hash'),
    ?3,
    input.value
  FROM json_each(?4) AS input`;

const UPSERT_WORKSTREAM_SQL = `
  INSERT INTO workstreams
    (id, workspace_id, repository_id, title, status, created_at, updated_at,
     title_event_at_ms, title_event_id, status_event_at_ms, status_event_id)
  SELECT
    json_extract(input.value, '$.id'),
    json_extract(input.value, '$.workspace_id'),
    json_extract(input.value, '$.repository_id'),
    json_extract(input.value, '$.title'),
    json_extract(input.value, '$.status'),
    json_extract(input.value, '$.created_at'),
    json_extract(input.value, '$.updated_at'),
    json_extract(input.value, '$.title_event_at_ms'),
    json_extract(input.value, '$.title_event_id'),
    json_extract(input.value, '$.status_event_at_ms'),
    json_extract(input.value, '$.status_event_id')
  FROM json_each(?1) AS input
  WHERE EXISTS (
    SELECT 1
    FROM events
    JOIN json_each(?2) AS source
      ON json_extract(source.value, '$.event_id') =
         json_extract(input.value, '$.source_event_id')
    WHERE events.workspace_id = json_extract(input.value, '$.workspace_id')
      AND events.event_id = json_extract(input.value, '$.source_event_id')
      AND events.raw_json = source.value
  )
  ON CONFLICT(workspace_id, id) DO UPDATE SET
    repository_id = CASE
      WHEN workstreams.repository_id IS NULL THEN excluded.repository_id
      WHEN excluded.repository_id IS NULL THEN workstreams.repository_id
      WHEN excluded.repository_id < workstreams.repository_id THEN excluded.repository_id
      ELSE workstreams.repository_id
    END,
    title = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title
      ELSE workstreams.title
    END,
    title_event_at_ms = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title_event_at_ms
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title_event_at_ms
      ELSE workstreams.title_event_at_ms
    END,
    title_event_id = CASE
      WHEN excluded.title_event_at_ms IS NULL THEN workstreams.title_event_id
      WHEN workstreams.title_event_at_ms IS NULL
        OR excluded.title_event_at_ms < workstreams.title_event_at_ms
        OR (excluded.title_event_at_ms = workstreams.title_event_at_ms
            AND excluded.title_event_id < workstreams.title_event_id)
        THEN excluded.title_event_id
      ELSE workstreams.title_event_id
    END,
    status = CASE
      WHEN workstreams.status = 'completed' THEN workstreams.status
      WHEN excluded.status = 'completed' THEN excluded.status
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status
      ELSE workstreams.status
    END,
    status_event_at_ms = CASE
      WHEN workstreams.status = 'completed' AND excluded.status <> 'completed'
        THEN workstreams.status_event_at_ms
      WHEN excluded.status = 'completed' AND workstreams.status <> 'completed'
        THEN excluded.status_event_at_ms
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status_event_at_ms
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status_event_at_ms
      ELSE workstreams.status_event_at_ms
    END,
    status_event_id = CASE
      WHEN workstreams.status = 'completed' AND excluded.status <> 'completed'
        THEN workstreams.status_event_id
      WHEN excluded.status = 'completed' AND workstreams.status <> 'completed'
        THEN excluded.status_event_id
      WHEN excluded.status_event_at_ms IS NULL THEN workstreams.status_event_id
      WHEN workstreams.status_event_at_ms IS NULL
        OR excluded.status_event_at_ms > workstreams.status_event_at_ms
        OR (excluded.status_event_at_ms = workstreams.status_event_at_ms
            AND excluded.status_event_id > workstreams.status_event_id)
        THEN excluded.status_event_id
      ELSE workstreams.status_event_id
    END,
    created_at = MIN(workstreams.created_at, excluded.created_at),
    updated_at = MAX(workstreams.updated_at, excluded.updated_at)
  WHERE workstreams.workspace_id = excluded.workspace_id`;

async function handleEventBatches(
  request: Request,
  env: { DB: D1DatabaseLike },
): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.error });
  const { device } = auth;

  const capabilityDenial = scopeDenial({
    tokenWorkspaceId: device.workspaceId,
    allowed: hasCapability(device, "ingest"),
  });
  if (capabilityDenial !== null) {
    return jsonResponse(capabilityDenial.status, { error: capabilityDenial.error });
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 256) {
    return jsonResponse(400, { error: "Idempotency-Key header is required" });
  }

  const bodyRead = await readRequestBody(request, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    const error = bodyRead.status === 413
      ? "request body exceeds 1 MiB"
      : "request body is not readable UTF-8";
    return jsonResponse(bodyRead.status, { error });
  }
  const body = bodyRead.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse(400, { error: "request body is not valid JSON" });
  }

  const validation = validateEventBatch(parsed, device.workspaceId);
  if (!validation.ok) return jsonResponse(validation.status, { error: validation.error });
  const envelope = validation.value;
  const requestHash = await sha256Hex(canonicalJsonStringify(envelope));
  const bodyBytes = new TextEncoder().encode(body).byteLength;

  // Idempotent replay: the same key returns the original receipt bytes.
  const existing = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
    .bind(device.workspaceId, idempotencyKey)
    .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
  if (existing !== null) {
    const denial = scopeDenial({
      resourceWorkspaceId: existing.workspace_id,
      tokenWorkspaceId: device.workspaceId,
    });
    if (denial !== null) return jsonResponse(denial.status, { error: denial.error });
    if (typeof existing.request_hash !== "string") {
      return jsonResponse(409, {
        error: "legacy Idempotency-Key cannot be verified; use a new key",
      });
    }
    if (existing.request_hash !== requestHash) {
      return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
    }
    return canonicalResponse(200, existing.receipt_json);
  }

  const ingestedAt = Math.floor(Date.now() / 1000);
  const quota = await prepareQuotaReservation(env.DB, {
    workspaceId: device.workspaceId,
    idempotencyKey,
    requestHash,
    eventCount: envelope.events.length,
    bodyBytes,
    nowSeconds: ingestedAt,
  });
  if (!quota.ok) return jsonResponse(quota.status, quota.body);
  if (quota.duplicate) {
    // The reservation and receipt commit in the same D1 transaction. Seeing
    // an allowed reservation after the first receipt read means a concurrent
    // identical request won; re-read its receipt instead of writing without a
    // reservation statement or charging twice.
    const winner = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
      .bind(device.workspaceId, idempotencyKey)
      .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
    if (winner === null) {
      return jsonResponse(503, {
        error: "hosted quota is temporarily unavailable",
        code: "quota_unavailable",
        local_capture_unaffected: true,
      });
    }
    if (typeof winner.request_hash !== "string") {
      return jsonResponse(409, {
        error: "legacy Idempotency-Key cannot be verified; use a new key",
      });
    }
    if (winner.request_hash !== requestHash) {
      return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
    }
    return canonicalResponse(200, winner.receipt_json);
  }

  const receipt = await buildReceipt(idempotencyKey, device.workspaceId, envelope);
  const receiptJson = canonicalJsonStringify(receipt);
  const workstreamRows = buildWorkstreamProjectionRows(envelope, device.workspaceId);
  const eventsJson = canonicalJsonStringify(envelope.events);
  const workstreamRowsJson = canonicalJsonStringify(workstreamRows);

  // Keep the D1 statement count constant (three legacy writes, four for a
  // metered workspace) even at the event ceiling. The quota reservation is
  // in this same transaction: its trigger either charges and permits all
  // writes, or aborts and rolls back the receipt/events/projection together.
  // json_each expands bounded canonical arrays inside D1; emitting one
  // prepared statement per event would exceed per-invocation query limits.
  const statements = [
    ...("statement" in quota ? [quota.statement] : []),
    env.DB.prepare(INSERT_IDEMPOTENCY_SQL).bind(
      idempotencyKey,
      device.workspaceId,
      device.deviceId,
      requestHash,
      receiptJson,
      ingestedAt,
    ),
    env.DB.prepare(INSERT_EVENT_SQL).bind(
      device.workspaceId,
      idempotencyKey,
      ingestedAt,
      eventsJson,
    ),
    env.DB.prepare(UPSERT_WORKSTREAM_SQL).bind(workstreamRowsJson, eventsJson),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // Lost a race against a concurrent batch with the same key: the winner's
    // receipt is authoritative.
    const winner = await env.DB.prepare(IDEMPOTENCY_RECEIPT_SQL)
      .bind(device.workspaceId, idempotencyKey)
      .first<{ workspace_id: string; request_hash: string | null; receipt_json: string }>();
    if (winner !== null && winner.workspace_id === device.workspaceId) {
      if (typeof winner.request_hash !== "string") {
        return jsonResponse(409, {
          error: "legacy Idempotency-Key cannot be verified; use a new key",
        });
      }
      if (winner.request_hash !== requestHash) {
        return jsonResponse(409, { error: "Idempotency-Key was already used for a different request" });
      }
      return canonicalResponse(200, winner.receipt_json);
    }
    if (error instanceof Error && error.message.includes("event payload conflict")) {
      return jsonResponse(409, {
        error: "event_id was already used for different evidence",
      });
    }
    // If the trigger rejected a race that crossed a hard quota after the
    // preflight read, turn it into the same structured denial. Never retry the
    // write here: the local spool remains the source of truth.
    const afterFailure = await prepareQuotaReservation(env.DB, {
      workspaceId: device.workspaceId,
      idempotencyKey,
      requestHash,
      eventCount: envelope.events.length,
      bodyBytes,
      nowSeconds: ingestedAt,
    });
    if (!afterFailure.ok) return jsonResponse(afterFailure.status, afterFailure.body);
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

async function handleListWorkstreams(
  request: Request,
  env: { DB: D1DatabaseLike },
): Promise<Response> {
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
