// Outbound webhooks — platform events delivered to workspace-owned HTTPS
// endpoints via a Cloudflare Queues consumer (parity row 47).
//
// Three moving pieces:
//   - HTTP management routes (device bearer auth): register/list/disable/test
//     an endpoint. The signing secret is generated once at registration and
//     never stored or shown again in plaintext.
//   - webhooksScheduled(env): a cron sweep that reads new rows from the
//     append-only `events` table past each workspace's cursor, matches them
//     against active endpoints' subscribed kinds, writes queued delivery
//     rows, and enqueues one message per (endpoint, event) match. The same
//     tick then reconciles delivery rows left 'queued' by an earlier tick
//     that committed rows but died before enqueueing their messages.
//   - webhooksQueue(batch, env): the Queues consumer. It signs a
//     content-free event summary with the endpoint's unsealed secret and
//     POSTs it; non-2xx/throw rethrows so Cloudflare Queues retries, and the
//     delivery row is marked 'dead' once the retry budget is believed spent.
//
// Detection is a sweep, not an ingest hook: platform/src/ingest.ts is never
// touched by this module.

import { authenticate, hasCapability, sha256Hex, type DeviceLookup, type DeviceBinding } from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
} from "./ingest";
import { validateOutboundURL } from "./urlguard";
import { monotonicFactory } from "ulid";

// -- ids ----------------------------------------------------------------------
// ids.ts is owned by another module; webhook rows mint their own prefixed
// ULIDs the same way (monotonic factory so same-millisecond ids stay
// lexically ordered).

const nextULID = monotonicFactory();
const DISABLE_PATH_PATTERN = /^\/v1\/webhooks\/(whe_[0-9A-HJKMNP-TV-Z]{26})\/disable$/;
const TEST_PATH_PATTERN = /^\/v1\/webhooks\/(whe_[0-9A-HJKMNP-TV-Z]{26})\/test$/;

function newWebhookEndpointID(): string {
  return `whe_${nextULID()}`;
}

function newWebhookDeliveryID(): string {
  return `whd_${nextULID()}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// -- env + structural Cloudflare bindings --------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests, and the real Queue<T>/MessageBatch<T> bindings satisfy these
// shapes structurally at the index.ts boundary.

/** Producer binding surface this module needs from a Cloudflare Queue. */
export interface QueueLike<Body = unknown> {
  send(message: Body): Promise<unknown>;
}

/** Consumer message surface this module needs from a Cloudflare Queue message. */
export interface QueueMessageLike<Body = unknown> {
  readonly body: Body;
  readonly attempts: number;
}

/** Consumer batch surface this module needs from a Cloudflare MessageBatch. */
export interface MessageBatchLike<Body = unknown> {
  readonly queue: string;
  readonly messages: ReadonlyArray<QueueMessageLike<Body>>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebhooksEnv {
  DB: D1DatabaseLike;
  /** Producer binding. Absent (or fake-omitted) => the sweep no-ops. */
  WEBHOOK_QUEUE?: QueueLike<WebhookQueueMessage>;
  /**
   * AES-GCM sealing key for endpoint secrets, set via `wrangler secret put`
   * (never in wrangler.toml — same convention as WORKOS_API_KEY). Management
   * writes and delivery signing both fail closed (503) while it is unset.
   */
  WEBHOOK_SEALING_KEY?: string;
}

/** Platform event kinds the webhook sweep recognizes in this version. */
export const DEFAULT_INTERESTING_KINDS = Object.freeze([
  "handoff.created",
  "handoff.accepted",
  "detection.recorded",
  "prompt.labeled",
  "verification.recorded",
  "alert.fired",
] as const);

/** Content-free notification body. Raw event payloads never leave the platform. */
export interface WebhookEventPayload {
  event_id: string;
  kind: string;
  workstream_id: string | null;
  occurred_at: string;
  workspace_id: string;
}

/** Queue message: everything the consumer needs to look up and sign a delivery. */
export interface WebhookQueueMessage {
  delivery_id: string;
  workspace_id: string;
  endpoint_id: string;
  event_id: string;
  kind: string;
  workstream_id: string | null;
  occurred_at: string;
}

function isWebhookQueueMessage(value: unknown): value is WebhookQueueMessage {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.delivery_id === "string" &&
    typeof v.workspace_id === "string" &&
    typeof v.endpoint_id === "string" &&
    typeof v.event_id === "string" &&
    typeof v.kind === "string" &&
    (v.workstream_id === null || typeof v.workstream_id === "string") &&
    typeof v.occurred_at === "string"
  );
}

// -- device lookup (mirrors index.ts's deviceLookup adapter) ------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* webhooks:device-by-token */
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

// -- signing --------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** hex(HMAC-SHA256(secret, `${timestamp}.${body}`)) — the v1 signature scheme. */
export async function computeWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return hex(new Uint8Array(signature));
}

function webhookSignatureHeader(timestamp: string, signatureHex: string): string {
  return `t=${timestamp},v1=${signatureHex}`;
}

/**
 * Sign and POST a content-free event payload. The single code path used by
 * both the queue consumer (real deliveries) and the /test route (manual
 * ping) — the two must never sign or shape a request differently.
 */
async function postSignedPayload(
  url: string,
  secret: string,
  payload: WebhookEventPayload,
  fetcher: FetchLike,
): Promise<Response> {
  const body = canonicalJsonStringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await computeWebhookSignature(secret, timestamp, body);
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-handoffgraph-signature": webhookSignatureHeader(timestamp, signature),
      "x-handoffgraph-event": payload.kind,
    },
    body,
  });
}

// -- secret sealing (AES-256-GCM, keyed by env.WEBHOOK_SEALING_KEY) -----------
// The raw sealing-key secret is stretched through SHA-256 into a 256-bit AES
// key so operators can set any-length secret via `wrangler secret put`. The
// sealed value is base64(iv[12] || ciphertext-with-tag).

async function sealingCryptoKey(sealingKeySecret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sealingKeySecret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sealWebhookSecret(secret: string, sealingKeySecret: string): Promise<string> {
  const key = await sealingCryptoKey(sealingKeySecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

export async function unsealWebhookSecret(
  sealedValue: string | null,
  sealingKeySecret: string,
): Promise<string> {
  if (sealedValue === null) throw new Error("no sealed webhook secret stored for this endpoint");
  const combined = base64ToBytes(sealedValue);
  if (combined.length <= 12) throw new Error("malformed sealed webhook secret");
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await sealingCryptoKey(sealingKeySecret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// -- JSON responses -------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- validation -----------------------------------------------------------------

const MAX_URL_BYTES = 2048;
const MAX_BODY_BYTES = 4_096;

function validateWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (new TextEncoder().encode(value).byteLength > MAX_URL_BYTES) return null;
  if (!value.startsWith("https://")) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
  } catch {
    return null;
  }
  return value;
}

function validateEventKinds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEFAULT_INTERESTING_KINDS.length) {
    return null;
  }
  const kinds = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !(DEFAULT_INTERESTING_KINDS as readonly string[]).includes(item)) {
      return null;
    }
    kinds.add(item);
  }
  return [...kinds].sort();
}

function parseEventKinds(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
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

// -- POST /v1/webhooks ----------------------------------------------------------

const INSERT_ENDPOINT_SQL = `
  /* webhooks:insert-endpoint */
  INSERT INTO webhook_endpoints
    (id, workspace_id, url, secret_hash, secret_ciphertext, active, event_kinds, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)`;

async function createWebhookEndpoint(request: Request, env: WebhooksEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const sealingKey = env.WEBHOOK_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    return json(503, { error: "webhook_sealing_key_unavailable" });
  }

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });

  const url = validateWebhookUrl(body.url);
  if (url === null) return json(400, { error: "url must be an https:// URL" });

  // Registration-time SSRF guard (src/urlguard.ts): private/loopback/
  // link-local/metadata literals, credentialed URLs and odd ports never reach
  // the delivery path. DNS rebinding is explicitly out of scope there.
  const guard = validateOutboundURL(url);
  if (!guard.ok) return json(400, { error: "unsafe_url", reason: guard.reason });

  const eventKinds = validateEventKinds(body.event_kinds);
  if (eventKinds === null) {
    return json(400, {
      error: `event_kinds must be a non-empty array drawn from: ${DEFAULT_INTERESTING_KINDS.join(", ")}`,
    });
  }

  const secret = `whsec_${randomSecret()}`;
  const [secretHash, secretCiphertext] = await Promise.all([
    sha256Hex(secret),
    sealWebhookSecret(secret, sealingKey),
  ]);

  const id = newWebhookEndpointID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(INSERT_ENDPOINT_SQL)
    .bind(id, auth.device.workspaceId, url, secretHash, secretCiphertext, JSON.stringify(eventKinds), now)
    .run();

  return json(201, {
    webhook: { id, url, event_kinds: eventKinds, active: true, created_at: now },
    signing_secret: secret,
    warning: "Copy this signing secret now. It cannot be shown again.",
  });
}

// -- GET /v1/webhooks -------------------------------------------------------------

interface EndpointListRow {
  id: string;
  url: string;
  active: number;
  event_kinds: string;
  created_at: number;
}

function compareEndpointRows(a: EndpointListRow, b: EndpointListRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

const LIST_ENDPOINTS_SQL = `
  /* webhooks:list-endpoints */
  SELECT id, url, active, event_kinds, created_at
  FROM webhook_endpoints
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_ENDPOINTS_AFTER_SQL = `
  /* webhooks:list-endpoints-after */
  SELECT id, url, active, event_kinds, created_at
  FROM webhook_endpoints
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

async function listWebhookEndpoints(request: Request, env: WebhooksEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result: { results: EndpointListRow[] } =
    cursor === null
      ? await env.DB.prepare(LIST_ENDPOINTS_SQL).bind(auth.device.workspaceId, fetchLimit).all<EndpointListRow>()
      : await env.DB.prepare(LIST_ENDPOINTS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<EndpointListRow>();

  const sorted = [...result.results].sort(compareEndpointRows);
  const page_ = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = page_[page_.length - 1];

  return json(200, {
    webhooks: page_.map((row) => ({
      id: row.id,
      url: row.url,
      active: row.active === 1,
      event_kinds: parseEventKinds(row.event_kinds),
      created_at: row.created_at,
    })),
    next_cursor: hasMore && last !== undefined ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  });
}

// -- POST /v1/webhooks/{id}/disable ------------------------------------------------

const DISABLE_ENDPOINT_SQL = `
  /* webhooks:disable-endpoint */
  UPDATE webhook_endpoints
  SET active = 0
  WHERE id = ?1 AND workspace_id = ?2 AND active = 1
  RETURNING id`;

async function disableWebhookEndpoint(
  request: Request,
  env: WebhooksEnv,
  endpointId: string,
): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  // A single workspace-scoped conditional UPDATE collapses "belongs to
  // another workspace", "unknown id", and "already disabled" into the same
  // 404 — existence in a foreign workspace is never leaked (platform
  // convention: see scopeDenial in src/ingest.ts).
  const disabled = await env.DB.prepare(DISABLE_ENDPOINT_SQL)
    .bind(endpointId, auth.device.workspaceId)
    .first<{ id: string }>();
  if (disabled === null) return json(404, { error: "not found" });
  return json(200, { ok: true });
}

// -- POST /v1/webhooks/{id}/test ---------------------------------------------------

interface EndpointRow {
  id: string;
  url: string;
  active: number;
  secret_ciphertext: string | null;
}

const READ_ENDPOINT_SQL = `
  /* webhooks:read-endpoint */
  SELECT id, url, active, secret_ciphertext
  FROM webhook_endpoints
  WHERE workspace_id = ?1 AND id = ?2`;

async function readEndpoint(
  db: D1DatabaseLike,
  workspaceId: string,
  endpointId: string,
): Promise<EndpointRow | null> {
  return db.prepare(READ_ENDPOINT_SQL).bind(workspaceId, endpointId).first<EndpointRow>();
}

function testEventId(): string {
  return `evt_test_${nextULID()}`;
}

async function testWebhookEndpoint(
  request: Request,
  env: WebhooksEnv,
  endpointId: string,
  fetcher: FetchLike,
): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const sealingKey = env.WEBHOOK_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    return json(503, { error: "webhook_sealing_key_unavailable" });
  }

  const endpoint = await readEndpoint(env.DB, auth.device.workspaceId, endpointId);
  if (endpoint === null) return json(404, { error: "not found" });

  let secret: string;
  try {
    secret = await unsealWebhookSecret(endpoint.secret_ciphertext, sealingKey);
  } catch {
    return json(503, { error: "webhook_secret_unavailable" });
  }

  const payload: WebhookEventPayload = {
    event_id: testEventId(),
    kind: "webhook.test",
    workstream_id: null,
    occurred_at: new Date().toISOString(),
    workspace_id: auth.device.workspaceId,
  };

  try {
    const response = await postSignedPayload(endpoint.url, secret, payload, fetcher);
    return json(200, { ok: response.ok, response_status: response.status });
  } catch {
    return json(200, { ok: false, response_status: null });
  }
}

// -- routing ----------------------------------------------------------------------

/**
 * Route the outbound-webhooks HTTP surface. Returns null when this module
 * does not own the path (or owns the path but not this method — the
 * platform-wide catch-all in index.ts answers 404 for those).
 */
export async function handleWebhooksRoute(
  request: Request,
  env: WebhooksEnv,
  fetcher: FetchLike = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === "/v1/webhooks") {
    if (request.method === "POST") return createWebhookEndpoint(request, env);
    if (request.method === "GET") return listWebhookEndpoints(request, env);
    return null;
  }

  const disableMatch = DISABLE_PATH_PATTERN.exec(pathname);
  if (disableMatch !== null) {
    if (request.method === "POST") return disableWebhookEndpoint(request, env, disableMatch[1]);
    return null;
  }

  const testMatch = TEST_PATH_PATTERN.exec(pathname);
  if (testMatch !== null) {
    if (request.method === "POST") return testWebhookEndpoint(request, env, testMatch[1], fetcher);
    return null;
  }

  return null;
}

// -- sweep (webhooksScheduled) -----------------------------------------------------

const SWEEP_EVENT_LIMIT = 500;

interface SweepEventRow {
  seq: number;
  event_id: string;
  kind: string;
  workstream_id: string | null;
  occurred_at: string;
}

const SWEEP_ACTIVE_WORKSPACES_SQL = `
  /* webhooks:sweep-active-workspaces */
  SELECT DISTINCT workspace_id FROM webhook_endpoints WHERE active = 1 ORDER BY workspace_id`;

const SWEEP_ENDPOINTS_SQL = `
  /* webhooks:sweep-endpoints */
  SELECT id, event_kinds FROM webhook_endpoints
  WHERE workspace_id = ?1 AND active = 1
  ORDER BY id`;

const SWEEP_CURSOR_SQL = `
  /* webhooks:sweep-cursor */
  SELECT last_seq FROM webhook_cursors WHERE workspace_id = ?1`;

const SWEEP_EVENTS_SQL = `
  /* webhooks:sweep-events */
  SELECT seq, event_id, kind, workstream_id, occurred_at
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2
  ORDER BY seq ASC
  LIMIT ?3`;

const INSERT_DELIVERIES_SQL = `
  /* webhooks:insert-deliveries */
  INSERT OR IGNORE INTO webhook_deliveries
    (id, workspace_id, endpoint_id, event_id, attempt, status, created_at)
  SELECT
    json_extract(input.value, '$.id'),
    json_extract(input.value, '$.workspace_id'),
    json_extract(input.value, '$.endpoint_id'),
    json_extract(input.value, '$.event_id'),
    1,
    'queued',
    ?2
  FROM json_each(?1) AS input`;

const UPSERT_CURSOR_SQL = `
  /* webhooks:advance-cursor */
  INSERT INTO webhook_cursors (workspace_id, last_seq)
  VALUES (?1, ?2)
  ON CONFLICT(workspace_id) DO UPDATE SET last_seq = excluded.last_seq
  WHERE excluded.last_seq > webhook_cursors.last_seq`;

interface PendingDelivery {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  event_id: string;
}

async function sweepWorkspace(
  db: D1DatabaseLike,
  queue: QueueLike<WebhookQueueMessage>,
  workspaceId: string,
): Promise<void> {
  const [endpointsResult, cursorRow] = await Promise.all([
    db.prepare(SWEEP_ENDPOINTS_SQL).bind(workspaceId).all<{ id: string; event_kinds: string }>(),
    db.prepare(SWEEP_CURSOR_SQL).bind(workspaceId).first<{ last_seq: number }>(),
  ]);
  const endpoints = endpointsResult.results
    .map((row) => ({ id: row.id, kinds: parseEventKinds(row.event_kinds) }))
    .filter((endpoint) => endpoint.kinds.length > 0);
  if (endpoints.length === 0) return;

  const cursor = cursorRow?.last_seq ?? 0;
  const eventsResult = await db
    .prepare(SWEEP_EVENTS_SQL)
    .bind(workspaceId, cursor, SWEEP_EVENT_LIMIT)
    .all<SweepEventRow>();
  // Deterministic regardless of storage/iteration order: always sweep in
  // seq order so the cursor watermark and delivery fan-out are reproducible.
  const events = [...eventsResult.results].sort((a, b) => a.seq - b.seq);
  if (events.length === 0) return;

  const deliveries: PendingDelivery[] = [];
  const messages: WebhookQueueMessage[] = [];
  for (const event of events) {
    for (const endpoint of endpoints) {
      if (!endpoint.kinds.includes(event.kind)) continue;
      const deliveryId = newWebhookDeliveryID();
      deliveries.push({
        id: deliveryId,
        workspace_id: workspaceId,
        endpoint_id: endpoint.id,
        event_id: event.event_id,
      });
      messages.push({
        delivery_id: deliveryId,
        workspace_id: workspaceId,
        endpoint_id: endpoint.id,
        event_id: event.event_id,
        kind: event.kind,
        workstream_id: event.workstream_id,
        occurred_at: event.occurred_at,
      });
    }
  }

  // The watermark advances past every event scanned this tick — matched or
  // not — so events with no subscriber are never rescanned forever.
  const maxSeq = events[events.length - 1].seq;
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    ...(deliveries.length > 0
      ? [db.prepare(INSERT_DELIVERIES_SQL).bind(canonicalJsonStringify(deliveries), now)]
      : []),
    db.prepare(UPSERT_CURSOR_SQL).bind(workspaceId, maxSeq),
  ];
  // Delivery rows and the cursor advance atomically: a message can only be
  // enqueued for a delivery row that durably exists. The converse gap — if
  // queue.send() throws partway through the loop below, the rows already
  // committed above for not-yet-sent messages stay 'queued' with no message
  // ever created for them, and the cursor has already moved past their source
  // events — is closed by reconcileStuckDeliveries() on a later tick, not by
  // re-sweeping the events table.
  await db.batch(statements);

  for (const message of messages) {
    await queue.send(message);
  }
}

// -- reconciliation (stuck 'queued' delivery rows) ---------------------------------

/**
 * How long a row may sit 'queued' before reconciliation treats it as stranded.
 * Comfortably longer than one delivery's full Queues retry ladder, so a row
 * that is merely mid-flight is never re-enqueued underneath the consumer.
 */
export const STUCK_DELIVERY_AGE_SECONDS = 600;

/** Rows reconciled per sweep. Bounded so one tick can never fan out unboundedly. */
export const RECONCILE_LIMIT = 100;

interface StuckDeliveryRow {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  kind: string | null;
  workstream_id: string | null;
  occurred_at: string | null;
}

// The join to `events` re-reads the content-free summary the message carries.
// A delivery whose source event is gone (retention) has nothing to deliver, so
// it is selected here and retired as 'dead' rather than re-enqueued blind.
const STUCK_DELIVERIES_SQL = `
  /* webhooks:stuck-deliveries */
  SELECT d.id AS id,
         d.workspace_id AS workspace_id,
         d.endpoint_id AS endpoint_id,
         d.event_id AS event_id,
         d.attempt AS attempt,
         e.kind AS kind,
         e.workstream_id AS workstream_id,
         e.occurred_at AS occurred_at
  FROM webhook_deliveries AS d
  LEFT JOIN events AS e
    ON e.workspace_id = d.workspace_id AND e.event_id = d.event_id
  WHERE d.status = 'queued' AND d.created_at <= ?1
  ORDER BY d.created_at ASC, d.id ASC
  LIMIT ?2`;

const RETRY_DELIVERY_SQL = `
  /* webhooks:reconcile-retry */
  UPDATE webhook_deliveries
  SET attempt = ?3
  WHERE id = ?1 AND workspace_id = ?2 AND status = 'queued'`;

const RETIRE_DELIVERY_SQL = `
  /* webhooks:reconcile-dead */
  UPDATE webhook_deliveries
  SET status = 'dead', attempt = ?3
  WHERE id = ?1 AND workspace_id = ?2 AND status = 'queued'`;

/**
 * Re-enqueue delivery rows that a previous tick committed but never managed to
 * put on the queue (queue.send() threw after the D1 batch, and the cursor had
 * already advanced past their source events, so no sweep will ever re-see
 * them).
 *
 * The attempt column is the bound: each reconciliation round durably bumps it
 * BEFORE sending, so a row that keeps failing to enqueue climbs to
 * MAX_DELIVERY_ATTEMPTS and is retired 'dead' instead of being retried
 * forever. Bumping first also means a send that throws is still counted — the
 * failure mode this whole pass exists for cannot hide from its own bound.
 *
 * Re-enqueueing is safe against double delivery: the consumer keys on the
 * delivery row id and its status update is scoped to non-terminal rows, so a
 * row that did get delivered is never resurrected (migration 0007's
 * webhook_deliveries_terminal_status trigger enforces that in-schema too).
 */
async function reconcileStuckDeliveries(
  db: D1DatabaseLike,
  queue: QueueLike<WebhookQueueMessage>,
  nowSeconds: number,
): Promise<void> {
  const cutoff = nowSeconds - STUCK_DELIVERY_AGE_SECONDS;
  const stuck = await db
    .prepare(STUCK_DELIVERIES_SQL)
    .bind(cutoff, RECONCILE_LIMIT)
    .all<StuckDeliveryRow>();

  for (const row of stuck.results) {
    const attempt = Number.isSafeInteger(row.attempt) && row.attempt > 0 ? row.attempt : 1;
    const orphaned = row.kind === null || row.occurred_at === null;
    if (orphaned || attempt >= MAX_DELIVERY_ATTEMPTS) {
      await db.prepare(RETIRE_DELIVERY_SQL).bind(row.id, row.workspace_id, attempt).run();
      continue;
    }

    const nextAttempt = attempt + 1;
    await db.prepare(RETRY_DELIVERY_SQL).bind(row.id, row.workspace_id, nextAttempt).run();
    await queue.send({
      delivery_id: row.id,
      workspace_id: row.workspace_id,
      endpoint_id: row.endpoint_id,
      event_id: row.event_id,
      kind: row.kind as string,
      workstream_id: row.workstream_id,
      occurred_at: row.occurred_at as string,
    });
  }
}

/**
 * Cron-triggered sweep: fan out new events (past each workspace's cursor)
 * to queued delivery rows + Queues messages, one workspace at a time so a
 * single workspace's failure never blocks the rest of the tick, then
 * reconcile any rows an earlier tick stranded in 'queued'.
 */
export async function webhooksScheduled(env: WebhooksEnv): Promise<void> {
  const queue = env.WEBHOOK_QUEUE;
  if (queue === undefined) {
    console.error(JSON.stringify({ message: "webhooks sweep skipped: queue binding unavailable" }));
    return;
  }

  const workspaces = await env.DB.prepare(SWEEP_ACTIVE_WORKSPACES_SQL)
    .bind()
    .all<{ workspace_id: string }>();
  for (const { workspace_id: workspaceId } of workspaces.results) {
    try {
      await sweepWorkspace(env.DB, queue, workspaceId);
    } catch (error) {
      console.error(JSON.stringify({
        message: "webhooks sweep failed for workspace",
        error_type: error instanceof Error ? error.name : "unknown",
      }));
    }
  }

  // Its own try/catch: reconciliation is repair work, and a failure here must
  // never look like a failed sweep to the scheduled dispatcher.
  try {
    await reconcileStuckDeliveries(env.DB, queue, Math.floor(Date.now() / 1000));
  } catch (error) {
    console.error(JSON.stringify({
      message: "webhooks reconciliation failed",
      error_type: error instanceof Error ? error.name : "unknown",
    }));
  }
}

// -- queue consumer (webhooksQueue) ------------------------------------------------

/**
 * Best-effort mirror of the Queues binding's own max_retries (wrangler.toml:
 * consumer max_retries = 3). Attempts at/after this are marked 'dead' before
 * rethrowing. This is advisory bookkeeping only — Cloudflare Queues' own
 * retry/DLQ transition is authoritative and independent of it, so the
 * status update is scoped to non-terminal rows and simply no-ops if this
 * guess and the platform's real cutoff ever disagree.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

const UPDATE_DELIVERY_STATUS_SQL = `
  /* webhooks:update-delivery-status */
  UPDATE webhook_deliveries
  SET status = ?3,
      response_status = ?4,
      attempt = ?5,
      delivered_at = CASE WHEN ?3 = 'delivered' THEN ?6 ELSE delivered_at END
  WHERE id = ?1 AND workspace_id = ?2 AND status NOT IN ('delivered', 'dead')`;

interface DeliveryOutcome {
  status: "delivered" | "failed" | "dead";
  responseStatus: number | null;
  attempt: number;
}

async function recordDeliveryOutcome(
  db: D1DatabaseLike,
  msg: WebhookQueueMessage,
  outcome: DeliveryOutcome,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(UPDATE_DELIVERY_STATUS_SQL)
    .bind(msg.delivery_id, msg.workspace_id, outcome.status, outcome.responseStatus, outcome.attempt, now)
    .run();
}

function attemptsExhausted(attempts: number): boolean {
  return attempts >= MAX_DELIVERY_ATTEMPTS;
}

async function processDeliveryMessage(
  message: QueueMessageLike<unknown>,
  env: WebhooksEnv,
  fetcher: FetchLike,
): Promise<void> {
  if (!isWebhookQueueMessage(message.body)) {
    // Nothing safe to retry toward — drop rather than retry forever.
    console.error(JSON.stringify({ message: "webhook queue message malformed" }));
    return;
  }
  const msg = message.body;
  const attempts =
    Number.isSafeInteger(message.attempts) && message.attempts > 0 ? message.attempts : 1;

  const endpoint = await readEndpoint(env.DB, msg.workspace_id, msg.endpoint_id);
  if (endpoint === null || endpoint.active !== 1) {
    // Gone or disabled since the sweep enqueued this — nothing to retry
    // toward; ack (no throw) so Queues does not keep redelivering it.
    await recordDeliveryOutcome(env.DB, msg, { status: "dead", responseStatus: null, attempt: attempts });
    return;
  }

  if (typeof env.WEBHOOK_SEALING_KEY !== "string" || env.WEBHOOK_SEALING_KEY.length === 0) {
    await recordDeliveryOutcome(env.DB, msg, {
      status: attemptsExhausted(attempts) ? "dead" : "failed",
      responseStatus: null,
      attempt: attempts,
    });
    throw new Error("webhook sealing key unavailable");
  }

  let secret: string;
  try {
    secret = await unsealWebhookSecret(endpoint.secret_ciphertext, env.WEBHOOK_SEALING_KEY);
  } catch (error) {
    await recordDeliveryOutcome(env.DB, msg, {
      status: attemptsExhausted(attempts) ? "dead" : "failed",
      responseStatus: null,
      attempt: attempts,
    });
    throw error;
  }

  const payload: WebhookEventPayload = {
    event_id: msg.event_id,
    kind: msg.kind,
    workstream_id: msg.workstream_id,
    occurred_at: msg.occurred_at,
    workspace_id: msg.workspace_id,
  };

  let response: Response;
  try {
    response = await postSignedPayload(endpoint.url, secret, payload, fetcher);
  } catch (error) {
    await recordDeliveryOutcome(env.DB, msg, {
      status: attemptsExhausted(attempts) ? "dead" : "failed",
      responseStatus: null,
      attempt: attempts,
    });
    throw error;
  }

  if (response.ok) {
    await recordDeliveryOutcome(env.DB, msg, {
      status: "delivered",
      responseStatus: response.status,
      attempt: attempts,
    });
    return;
  }

  await recordDeliveryOutcome(env.DB, msg, {
    status: attemptsExhausted(attempts) ? "dead" : "failed",
    responseStatus: response.status,
    attempt: attempts,
  });
  throw new Error(`webhook endpoint responded with status ${response.status}`);
}

/**
 * Queues consumer for the `handoffgraph-webhooks` queue. Failures rethrow
 * (after recording failed/dead) so Cloudflare Queues applies its own
 * retry/dead-letter policy — this function never swallows a delivery
 * failure. It never calls message.ack()/retry() individually, so it relies
 * on wrangler.toml's consumer max_batch_size = 1: a batch of more than one
 * message would let one failing delivery force a retry of already-delivered
 * batch-mates too (Cloudflare retries every unacked message in a batch that
 * a throw came out of).
 */
export async function webhooksQueue(
  batch: MessageBatchLike<unknown>,
  env: WebhooksEnv,
  fetcher: FetchLike = fetch,
): Promise<void> {
  for (const message of batch.messages) {
    await processDeliveryMessage(message, env, fetcher);
  }
}
