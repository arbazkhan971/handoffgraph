// Public API keys (parity row 44): project-scoped pk_/sk_ credential pairs,
// an edge-cached verification path, and the public read API (/api/v1/*)
// those credentials unlock.
//
// Three surfaces:
//   management   POST/GET/POST-revoke under /v1/api-keys, authenticated the
//                same way every other management route on this platform is
//                (device bearer token with the 'ingest' capability).
//   verification authenticateApiKey(header, env) hashes a presented
//                `Authorization: Bearer sk_...` token and looks it up in D1,
//                fronted by an edge KV cache of the VERDICT (not the secret)
//                so a repeated bad key never reaches D1 twice in a row and a
//                repeated good key skips D1 entirely for the cache window.
//                Revocation writes an immediate KV tombstone so a cached
//                "ok" verdict cannot outlive the revocation.
//   public API   GET /api/v1/{workstreams,sessions,observations,scores} and
//                GET /api/v1/openapi.json. Thin, workspace-scoped read
//                delegations: workstreams/sessions/observations re-run the
//                exact exported query builders src/ingest.ts and
//                src/observations.ts already ship; scores is new (no other
//                module owns a score read model yet). Row-shaping for
//                sessions/observations duplicates a few lines that are
//                private to observations.ts (documented at each site) — a
//                natural target for the orchestrator to unify by exporting
//                those shapers instead of duplicating them.
//
// Every table this module owns carries workspace_id (NOT NULL, indexed) per
// platform convention; every public-API query is bound to the authenticated
// principal's workspace_id, so a foreign resource is simply never in the
// result set (list endpoints) or collapses to 404 (POST .../revoke) — never
// leaked, never distinguishable from "does not exist" (see scopeDenial).

import {
  authenticate,
  extractBearerToken,
  hasCapability,
  sha256Hex,
  timingSafeEqual,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  WORKSTREAM_ID_PATTERN,
  buildWorkstreamListResponse,
  encodeCursor,
  parsePagination,
  readRequestBody,
  type Validation,
  type WorkstreamRow,
} from "./ingest";
import {
  buildObservationQuery,
  buildSessionQuery,
  encodeKeyCursor,
  parseKeyPagination,
  type KeyPagination,
} from "./observations";
import { monotonicFactory } from "ulid";

// -- Cloudflare bindings (structural: plain-object fakes satisfy these) ------
// Same discipline as artifacts.ts's R2BucketLike / webhooks.ts's QueueLike:
// only the members this module reads, so tests never need a real binding.

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** APIKEY_KV is optional so the Worker still type-checks before it exists. */
export interface ApiKeysEnv {
  DB: D1DatabaseLike;
  APIKEY_KV?: KVNamespaceLike;
}

// -- ids + secrets -------------------------------------------------------------

const nextULID = monotonicFactory();

function newApiKeyID(): string {
  return `apk_${nextULID()}`;
}

/** byteLength random bytes, base64url-encoded (no padding). */
function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 'pk_' + 12 chars: identifies a key in listings/logs. Not a secret. */
function newPublicKey(): string {
  return `pk_${randomBase64Url(9)}`; // 9 bytes -> exactly 12 base64url chars
}

/** 'sk_' + 43 chars: the bearer credential. Shown once, never stored raw. */
function newSecretKey(): string {
  return `sk_${randomBase64Url(32)}`;
}

// -- scopes ----------------------------------------------------------------

export const ALLOWED_SCOPE_VALUES = ["read", "write"] as const;
export type ApiKeyScope = (typeof ALLOWED_SCOPE_VALUES)[number];

function isAllowedScope(value: string): value is ApiKeyScope {
  return (ALLOWED_SCOPE_VALUES as readonly string[]).includes(value);
}

/** Validate a creation request's `scopes` field; absent means the v1 default. */
function validateScopesInput(value: unknown): string[] | null {
  if (value === undefined) return ["read"];
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !isAllowedScope(item)) return null;
    scopes.add(item);
  }
  return [...scopes].sort();
}

/** Parse the stored scopes column defensively; malformed data reads as read-only. */
function parseStoredScopes(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return ["read"];
    const scopes = value.filter((s): s is string => typeof s === "string" && isAllowedScope(s));
    return scopes.length > 0 ? [...new Set(scopes)].sort() : ["read"];
  } catch {
    return ["read"];
  }
}

// -- verification (KV-cached) --------------------------------------------------

const API_KEY_CACHE_PREFIX = "apikey-verdict:";
const API_KEY_CACHE_TTL_SECONDS = 60;

type CachedVerdict =
  | { v: "rejected" }
  | { v: "ok"; workspace_id: string; scopes: string[]; key_id: string };

function apiKeyCacheKey(secretHash: string): string {
  return `${API_KEY_CACHE_PREFIX}${secretHash}`;
}

function parseCachedVerdict(raw: string): CachedVerdict | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v === "rejected") return { v: "rejected" };
    if (
      record.v === "ok" &&
      typeof record.workspace_id === "string" &&
      typeof record.key_id === "string" &&
      Array.isArray(record.scopes) &&
      record.scopes.every((s): s is string => typeof s === "string")
    ) {
      return { v: "ok", workspace_id: record.workspace_id, scopes: record.scopes, key_id: record.key_id };
    }
    return null;
  } catch {
    return null;
  }
}

export type ApiKeyAuthResult =
  | { ok: true; workspaceId: string; scopes: string[]; keyId: string }
  | { ok: false; status: 401; error: string };

const UNAUTHORIZED_APIKEY: { ok: false; status: 401; error: string } = {
  ok: false,
  status: 401,
  error: "unauthorized",
};

interface ApiKeyRow {
  id: string;
  workspace_id: string;
  secret_hash: string;
  scopes: string;
  revoked_at: number | null;
}

const API_KEY_LOOKUP_SQL = `
  /* apikeys:lookup-by-secret-hash */
  SELECT id, workspace_id, secret_hash, scopes, revoked_at
  FROM api_keys
  WHERE secret_hash = ?1`;

/**
 * Authenticate a `Bearer sk_...` credential.
 *
 * Edge-cached rejection (the acceptance property this module exists to
 * provide): every verdict — good or bad — is cached in env.APIKEY_KV for 60s,
 * keyed by the SHA-256 of the presented token (never the raw secret). A
 * cache hit resolves the request WITHOUT touching D1 at all, so a client
 * hammering an invalid key, or a legitimate high-QPS caller, costs at most
 * one D1 query per distinct key per 60-second window. APIKEY_KV is optional:
 * while unset (not yet provisioned — see wrangler.toml), this simply always
 * falls through to D1, same behavior as today, just uncached.
 */
export async function authenticateApiKey(
  header: string | null,
  env: ApiKeysEnv,
): Promise<ApiKeyAuthResult> {
  const token = extractBearerToken(header);
  if (token === null) return UNAUTHORIZED_APIKEY;
  const hash = await sha256Hex(token);
  const kv = env.APIKEY_KV;
  const cacheKey = apiKeyCacheKey(hash);

  if (kv !== undefined) {
    const cached = await kv.get(cacheKey);
    if (cached !== null) {
      const verdict = parseCachedVerdict(cached);
      if (verdict !== null) {
        if (verdict.v === "rejected") return UNAUTHORIZED_APIKEY;
        return { ok: true, workspaceId: verdict.workspace_id, scopes: verdict.scopes, keyId: verdict.key_id };
      }
      // Malformed cache entry: fall through to D1 rather than trusting it.
    }
  }

  const row = await env.DB.prepare(API_KEY_LOOKUP_SQL).bind(hash).first<ApiKeyRow>();
  // Defense in depth, mirroring auth.ts's device-token check: re-verify the
  // returned row's OWN hash against the computed hash rather than trusting
  // that the lookup predicate did the only comparison that matters.
  const rejected = row === null || row.revoked_at !== null || !timingSafeEqual(hash, row.secret_hash);
  if (rejected) {
    if (kv !== undefined) {
      await kv.put(cacheKey, JSON.stringify({ v: "rejected" } satisfies CachedVerdict), {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      });
    }
    return UNAUTHORIZED_APIKEY;
  }

  const scopes = parseStoredScopes(row.scopes);
  if (kv !== undefined) {
    await kv.put(
      cacheKey,
      JSON.stringify({
        v: "ok",
        workspace_id: row.workspace_id,
        scopes,
        key_id: row.id,
      } satisfies CachedVerdict),
      { expirationTtl: API_KEY_CACHE_TTL_SECONDS },
    );
  }
  return { ok: true, workspaceId: row.workspace_id, scopes, keyId: row.id };
}

// -- unified read principal (shared with src/mcp.ts) ---------------------------

/**
 * Either credential kind the public API and the hosted MCP endpoint accept.
 * A device principal's write authority is its 'ingest' capability (the
 * platform-wide write capability everywhere else); an API-key principal's
 * write authority is the 'write' scope (v1 keys default to ['read'] only).
 */
export type ApiPrincipal =
  | { kind: "device"; workspaceId: string; capabilities: string[] }
  | { kind: "apikey"; workspaceId: string; scopes: string[]; keyId: string };

export function principalCanWrite(principal: ApiPrincipal): boolean {
  return principal.kind === "device"
    ? principal.capabilities.includes("ingest")
    : principal.scopes.includes("write");
}

// -- device lookup (mirrors index.ts's adapter; see observations.ts/webhooks.ts) --

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* apikeys:device-by-token */
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

/**
 * Resolve either credential kind for a read-scoped request: an sk_ API key
 * (any scope — every key can read) or a device bearer token with 'read'.
 * Shared by the public REST API below and by src/mcp.ts's POST /v1/mcp.
 */
export async function authenticateReadPrincipal(
  request: Request,
  env: ApiKeysEnv,
): Promise<{ principal: ApiPrincipal } | { response: Response }> {
  const header = request.headers.get("authorization");
  const token = extractBearerToken(header);
  if (token === null) return { response: json(401, { error: "unauthorized" }) };

  if (token.startsWith("sk_")) {
    const verdict = await authenticateApiKey(header, env);
    if (!verdict.ok) return { response: json(verdict.status, { error: verdict.error }) };
    return {
      principal: { kind: "apikey", workspaceId: verdict.workspaceId, scopes: verdict.scopes, keyId: verdict.keyId },
    };
  }

  const auth = await authenticate(header, deviceLookup(env.DB));
  if (!auth.ok) return { response: json(auth.status, { error: auth.error }) };
  if (!hasCapability(auth.device, "read")) return { response: json(403, { error: "forbidden" }) };
  return {
    principal: { kind: "device", workspaceId: auth.device.workspaceId, capabilities: auth.device.capabilities },
  };
}

// -- responses ------------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_API_KEY_BODY_BYTES);
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

const MAX_API_KEY_BODY_BYTES = 8_192; // creation payloads are a name + a short scopes array
const MAX_API_KEY_NAME_BYTES = 200;

function validateName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (new TextEncoder().encode(trimmed).byteLength > MAX_API_KEY_NAME_BYTES) return null;
  return trimmed;
}

// -- POST /v1/api-keys ----------------------------------------------------------
//
// Management routes (create/list/revoke) all require the device 'ingest'
// capability — API keys are a credential-issuing surface, gated behind the
// same capability that gates every other write/manage surface on this
// platform (webhooks, admin reindex), not the weaker 'read'.

const INSERT_API_KEY_SQL = `
  /* apikeys:insert */
  INSERT INTO api_keys (id, workspace_id, name, public_key, secret_hash, scopes, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

async function createApiKey(request: Request, env: ApiKeysEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });

  const name = validateName(body.name);
  if (name === null) {
    return json(400, { error: `name is required and must be at most ${MAX_API_KEY_NAME_BYTES} UTF-8 bytes` });
  }
  const scopes = validateScopesInput(body.scopes);
  if (scopes === null) {
    return json(400, {
      error: `scopes must be a non-empty array drawn from: ${ALLOWED_SCOPE_VALUES.join(", ")}`,
    });
  }

  const publicKey = newPublicKey();
  const secretKey = newSecretKey();
  const secretHash = await sha256Hex(secretKey);
  const id = newApiKeyID();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(INSERT_API_KEY_SQL)
    .bind(id, auth.device.workspaceId, name, publicKey, secretHash, JSON.stringify(scopes), now)
    .run();

  return json(201, {
    id,
    name,
    public_key: publicKey,
    secret_key: secretKey,
    scopes,
    created_at: now,
    warning: "Copy secret_key now. It cannot be shown again.",
  });
}

// -- GET /v1/api-keys -------------------------------------------------------------

interface ApiKeyListRow {
  id: string;
  name: string;
  public_key: string;
  scopes: string;
  created_at: number;
  revoked_at: number | null;
}

function compareApiKeyRows(a: ApiKeyListRow, b: ApiKeyListRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

const LIST_API_KEYS_SQL = `
  /* apikeys:list */
  SELECT id, name, public_key, scopes, created_at, revoked_at
  FROM api_keys
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_API_KEYS_AFTER_SQL = `
  /* apikeys:list-after */
  SELECT id, name, public_key, scopes, created_at, revoked_at
  FROM api_keys
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

async function listApiKeys(request: Request, env: ApiKeysEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_API_KEYS_SQL).bind(auth.device.workspaceId, fetchLimit).all<ApiKeyListRow>()
      : await env.DB.prepare(LIST_API_KEYS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<ApiKeyListRow>();

  const sorted = [...result.results].sort(compareApiKeyRows);
  const page_ = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = page_[page_.length - 1];

  return json(200, {
    // Never secrets: public_key only. secret_hash/secret_key never leave creation.
    items: page_.map((row) => ({
      id: row.id,
      name: row.name,
      public_key: row.public_key,
      scopes: parseStoredScopes(row.scopes),
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    })),
    next_cursor: hasMore && last !== undefined ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  });
}

// -- POST /v1/api-keys/{id}/revoke -----------------------------------------------

const API_KEY_REVOKE_PATH = /^\/v1\/api-keys\/(apk_[0-9A-HJKMNP-TV-Z]{26})\/revoke$/;

const REVOKE_API_KEY_SQL = `
  /* apikeys:revoke */
  UPDATE api_keys
  SET revoked_at = ?1
  WHERE id = ?2 AND workspace_id = ?3 AND revoked_at IS NULL
  RETURNING id, secret_hash`;

async function revokeApiKey(request: Request, env: ApiKeysEnv, id: string): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const now = Math.floor(Date.now() / 1000);
  // A single workspace-scoped conditional UPDATE collapses "foreign
  // workspace", "unknown id", and "already revoked" into the same 404 —
  // existence in a foreign workspace is never leaked (see ingest.ts's
  // scopeDenial doc comment for the platform-wide statement of this rule).
  const revoked = await env.DB.prepare(REVOKE_API_KEY_SQL)
    .bind(now, id, auth.device.workspaceId)
    .first<{ id: string; secret_hash: string }>();
  if (revoked === null) return json(404, { error: "not found" });

  // Immediate KV tombstone: without this, a verdict cached "ok" up to
  // API_KEY_CACHE_TTL_SECONDS ago would keep authenticating for up to that
  // long after revocation.
  if (env.APIKEY_KV !== undefined) {
    await env.APIKEY_KV.put(
      apiKeyCacheKey(revoked.secret_hash),
      JSON.stringify({ v: "rejected" } satisfies CachedVerdict),
      { expirationTtl: API_KEY_CACHE_TTL_SECONDS },
    );
  }
  return json(200, { id: revoked.id, revoked_at: now });
}

// -- shared query-building helpers (small, local duplicates of the private ------
// -- helpers observations.ts keeps un-exported; see module doc comment) --------

interface QueryParts {
  binds: unknown[];
}

function bindParam(parts: QueryParts, value: unknown): string {
  parts.binds.push(value);
  return `?${parts.binds.length}`;
}

const UTF8_ENCODER = new TextEncoder();

function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return value.length > maxBytes || UTF8_ENCODER.encode(value).byteLength > maxBytes;
}

function stringQueryParam(url: URL, name: string, maxBytes: number): Validation<string | null> {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: null };
  if (exceedsUtf8Bytes(raw, maxBytes)) {
    return { ok: false, status: 400, error: `${name} must be at most ${maxBytes} UTF-8 bytes` };
  }
  return { ok: true, value: raw };
}

// -- public read API (GET /api/v1/*) ---------------------------------------------
//
// Path prefix /api/v1/ (as opposed to the device-token /v1/ surface) keeps
// the two credential planes visibly distinct. All four endpoints share one
// envelope shape: { items, next_cursor }.

async function authenticatePublicApi(
  request: Request,
  env: ApiKeysEnv,
): Promise<{ workspaceId: string } | { response: Response }> {
  const result = await authenticateReadPrincipal(request, env);
  if ("response" in result) return result;
  return { workspaceId: result.principal.workspaceId };
}

// -- GET /api/v1/workstreams ------------------------------------------------------
// Mirrors index.ts's (un-exported) WORKSTREAMS_PAGE_SQL / _AFTER_SQL and
// buildWorkstreamListResponse exactly; buildWorkstreamListResponse itself IS
// exported from ingest.ts and reused as-is, only its `workstreams` key is
// renamed to this module's `items` envelope convention.

const PUBLIC_WORKSTREAMS_PAGE_SQL = `
  SELECT /* apikeys:public-workstreams */ id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const PUBLIC_WORKSTREAMS_PAGE_AFTER_SQL = `
  SELECT /* apikeys:public-workstreams-after */ id, workspace_id, title, status, repository_id, created_at, updated_at
  FROM workstreams
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

async function publicListWorkstreams(request: Request, env: ApiKeysEnv, workspaceId: string): Promise<Response> {
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(PUBLIC_WORKSTREAMS_PAGE_SQL).bind(workspaceId, fetchLimit).all<WorkstreamRow>()
      : await env.DB.prepare(PUBLIC_WORKSTREAMS_PAGE_AFTER_SQL)
          .bind(workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<WorkstreamRow>();

  const shaped = buildWorkstreamListResponse(result.results, limit);
  return json(200, { items: shaped.workstreams, next_cursor: shaped.next_cursor });
}

// -- GET /api/v1/sessions ----------------------------------------------------------
// buildSessionQuery is exported from observations.ts and reused directly;
// only the row -> JSON shaping is duplicated here (observations.ts's
// sessionItem/sortSessions are module-private).

interface PublicSessionRow {
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

function sortPublicSessions(rows: PublicSessionRow[]): PublicSessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.last_event_at_ms !== b.last_event_at_ms) return b.last_event_at_ms - a.last_event_at_ms;
    if (a.id === b.id) return 0;
    return a.id > b.id ? -1 : 1;
  });
}

function publicSessionItem(row: PublicSessionRow): Record<string, unknown> {
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

async function publicListSessions(request: Request, env: ApiKeysEnv, workspaceId: string): Promise<Response> {
  const url = new URL(request.url);
  const page = parseKeyPagination(url);
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildSessionQuery(workspaceId, url, page.value);
  if (!query.ok) return json(query.status, { error: query.error });

  const result = await env.DB.prepare(query.value.sql).bind(...query.value.binds).all<PublicSessionRow>();
  const sorted = sortPublicSessions(result.results);
  const items = sorted.slice(0, page.value.limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(publicSessionItem),
    next_cursor:
      sorted.length > page.value.limit && last !== undefined
        ? encodeKeyCursor({ sort: String(last.last_event_at_ms), id: last.id })
        : null,
  });
}

// -- GET /api/v1/observations --------------------------------------------------
// buildObservationQuery is exported from observations.ts and reused
// directly; row shaping duplicates observations.ts's private
// observationItem/sortObservations (documented, same reasoning as sessions
// above). Exported so src/mcp.ts's get_trace_context tool can reuse the same
// shaper instead of a third copy.

export interface PublicObservationRow {
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

export function sortPublicObservations(rows: PublicObservationRow[]): PublicObservationRow[] {
  return [...rows].sort((a, b) => {
    const left = BigInt(a.started_at_ns);
    const right = BigInt(b.started_at_ns);
    if (left !== right) return right > left ? 1 : -1;
    if (a.span_id === b.span_id) return 0;
    return a.span_id > b.span_id ? -1 : 1;
  });
}

export function publicObservationItem(row: PublicObservationRow): Record<string, unknown> {
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
    // Nanosecond timestamps are decimal strings: int64 exceeds the
    // JavaScript safe-integer range and must never be emitted as a number.
    started_at_ns: row.started_at_ns,
    ended_at_ns: row.ended_at_ns,
    duration_ms: row.duration_ms,
    tool_name: row.tool_name,
    exit_code: row.exit_code,
    token_in: row.token_in,
    token_out: row.token_out,
    cost_amount: row.cost_amount,
    cost_provenance: row.cost_provenance,
    fingerprint: row.fingerprint,
  };
}

async function publicListObservations(request: Request, env: ApiKeysEnv, workspaceId: string): Promise<Response> {
  const url = new URL(request.url);
  const page = parseKeyPagination(url);
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildObservationQuery(workspaceId, url, page.value);
  if (!query.ok) return json(query.status, { error: query.error });

  const result = await env.DB.prepare(query.value.sql).bind(...query.value.binds).all<PublicObservationRow>();
  const sorted = sortPublicObservations(result.results);
  const items = sorted.slice(0, page.value.limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(publicObservationItem),
    next_cursor:
      sorted.length > page.value.limit && last !== undefined
        ? encodeKeyCursor({ sort: last.started_at_ns, id: last.span_id })
        : null,
  });
}

// -- scores (GET /api/v1/scores; also reused by src/mcp.ts's list_scores) ------
//
// No other module owns a score read model yet, so this is new rather than a
// delegation. Scores live in the append-only `events` table (kind =
// 'score.recorded'); there is no derived table. Ordering/pagination use
// events.seq (the table's monotonic ingestion-order AUTOINCREMENT primary
// key) rather than occurred_at: occurred_at is caller-supplied RFC 3339 text
// on events ingested through POST /v1/event-batches and is not guaranteed to
// compare correctly as a lexicographic string across formats (varying
// fractional-second width, 'Z' vs numeric offset) — seq is always safe.
// score.recorded events written by src/mcp.ts's record_score use
// deterministicID (src/otlp.ts) seeded with the real capture time, so their
// event_id embeds a correctly-ordered ULID timestamp too, but seq is used
// here uniformly so externally-ingested score events sort correctly as well.
//
// events(workspace_id, workstream_id, kind) has no composite index today —
// only the three single-column indexes from migration 0001. This query is
// correct but not maximally efficient at large per-workstream event counts;
// a follow-up migration adding
// `CREATE INDEX ... ON events(workspace_id, workstream_id, kind, seq)`
// would let both this endpoint and the MCP list_scores tool below use an
// index-only scan. Left for the orchestrator since events' indexing is
// migration 0001's table, outside this slice's assigned migration.

export const SCORE_TARGET_TYPES = ["trace", "span", "session", "checkpoint", "workstream"] as const;
export type ScoreTargetType = (typeof SCORE_TARGET_TYPES)[number];

/** Mirrors internal/protocol.ScoreTargetPrefix (Go) for target_id validation. */
export const SCORE_TARGET_PREFIXES: Record<ScoreTargetType, string> = {
  trace: "trc_",
  span: "spn_",
  session: "ses_",
  checkpoint: "cp_",
  workstream: "ws_",
};

// Hosted record_score accepts a narrower source vocabulary than the local
// CLI/MCP server's four values (human, api, evaluation, detection):
// "detection" names a hosted detection pipeline that does not exist on this
// plane yet, so it is deliberately omitted rather than accepted and silently
// misrepresented. (Explicit scope decision — see docs/hosted-mcp.md.)
export const SCORE_SOURCES = ["human", "api", "evaluation"] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];

export interface ScoreItem {
  score_id: string;
  workstream_id: string | null;
  occurred_at: string;
  name: string;
  data_type: string;
  value: string;
  target_type: string;
  target_id: string;
  source: string;
  provenance: string | null;
  comment: string | null;
}

interface ScoreEventRow {
  seq: number;
  event_id: string;
  workstream_id: string | null;
  occurred_at: string;
  provenance: string | null;
  raw_json: string;
}

export function shapeScoreRow(row: ScoreEventRow): ScoreItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.raw_json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const payload = (parsed as Record<string, unknown>).payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : null;
  const dataType = typeof p.data_type === "string" ? p.data_type : null;
  const value = typeof p.value === "string" ? p.value : null;
  const targetType = typeof p.target_type === "string" ? p.target_type : null;
  const targetId = typeof p.target_id === "string" ? p.target_id : null;
  const source = typeof p.source === "string" ? p.source : null;
  if (name === null || dataType === null || value === null || targetType === null || targetId === null || source === null) {
    return null; // malformed payload never corrupts the read model
  }
  return {
    score_id: row.event_id,
    workstream_id: row.workstream_id,
    occurred_at: row.occurred_at,
    name,
    data_type: dataType,
    value,
    target_type: targetType,
    target_id: targetId,
    source,
    provenance: row.provenance,
    comment: typeof p.comment === "string" ? p.comment : null,
  };
}

/**
 * Build the score.recorded query for one workstream. `url` carries the
 * shared filter vocabulary (target_type/target_id/name) plus cursor/limit —
 * src/mcp.ts's list_scores tool builds a synthetic URL from its JSON-RPC
 * arguments so both callers share this exact function and its validation.
 */
export function buildScoreQuery(
  workspaceId: string,
  workstreamId: string,
  url: URL,
  pagination: KeyPagination,
): Validation<{ sql: string; binds: unknown[] }> {
  const targetType = stringQueryParam(url, "target_type", 32);
  if (!targetType.ok) return targetType;
  if (targetType.value !== null && !(SCORE_TARGET_TYPES as readonly string[]).includes(targetType.value)) {
    return { ok: false, status: 400, error: `target_type must be one of ${SCORE_TARGET_TYPES.join(", ")}` };
  }
  const targetId = stringQueryParam(url, "target_id", 128);
  if (!targetId.ok) return targetId;
  const name = stringQueryParam(url, "name", 128);
  if (!name.ok) return name;

  const parts: QueryParts = { binds: [] };
  let sql = `SELECT /* apikeys:query-scores */ seq, event_id, workstream_id, occurred_at, provenance, raw_json
  FROM events
  WHERE workspace_id = ${bindParam(parts, workspaceId)}
    AND workstream_id = ${bindParam(parts, workstreamId)}
    AND kind = 'score.recorded'`;
  if (targetType.value !== null) {
    sql += `\n    AND json_extract(raw_json, '$.payload.target_type') = ${bindParam(parts, targetType.value)}`;
  }
  if (targetId.value !== null) {
    sql += `\n    AND json_extract(raw_json, '$.payload.target_id') = ${bindParam(parts, targetId.value)}`;
  }
  if (name.value !== null) {
    sql += `\n    AND json_extract(raw_json, '$.payload.name') = ${bindParam(parts, name.value)}`;
  }
  if (pagination.cursor !== null) {
    sql += `\n    AND seq < CAST(${bindParam(parts, pagination.cursor.sort)} AS INTEGER)`;
  }
  sql += `\n  ORDER BY seq DESC`;
  sql += `\n  LIMIT ${bindParam(parts, pagination.limit + 1)}`;
  return { ok: true, value: { sql, binds: parts.binds } };
}

async function publicListScores(request: Request, env: ApiKeysEnv, workspaceId: string): Promise<Response> {
  const url = new URL(request.url);
  const workstreamId = url.searchParams.get("workstream");
  if (workstreamId === null || workstreamId === "" || !WORKSTREAM_ID_PATTERN.test(workstreamId)) {
    return json(400, { error: `workstream query parameter is required and must match ${WORKSTREAM_ID_PATTERN.source}` });
  }
  const page = parseKeyPagination(url);
  if (!page.ok) return json(page.status, { error: page.error });

  const query = buildScoreQuery(workspaceId, workstreamId, url, page.value);
  if (!query.ok) return json(query.status, { error: query.error });

  const result = await env.DB.prepare(query.value.sql).bind(...query.value.binds).all<ScoreEventRow>();
  const rows = [...result.results].sort((a, b) => b.seq - a.seq);
  const page_ = rows.slice(0, page.value.limit);
  const hasMore = rows.length > page.value.limit;
  const last = page_[page_.length - 1];
  const items = page_.map(shapeScoreRow).filter((item): item is ScoreItem => item !== null);

  return json(200, {
    items,
    next_cursor:
      hasMore && last !== undefined ? encodeKeyCursor({ sort: String(last.seq), id: last.event_id }) : null,
  });
}

/**
 * Run buildScoreQuery + shapeScoreRow for one workstream with plain filter
 * values (no URL involved) — the shape src/mcp.ts's list_scores tool needs.
 * Builds a synthetic URL internally so both callers share one query builder.
 */
export async function listWorkstreamScores(
  db: D1DatabaseLike,
  workspaceId: string,
  workstreamId: string,
  filters: { targetType?: string | null; targetId?: string | null; name?: string | null },
  limit: number,
): Promise<ScoreItem[]> {
  const url = new URL("https://internal.invalid/list-scores");
  if (filters.targetType) url.searchParams.set("target_type", filters.targetType);
  if (filters.targetId) url.searchParams.set("target_id", filters.targetId);
  if (filters.name) url.searchParams.set("name", filters.name);
  const query = buildScoreQuery(workspaceId, workstreamId, url, { limit, cursor: null });
  if (!query.ok) return [];
  const result = await db.prepare(query.value.sql).bind(...query.value.binds).all<ScoreEventRow>();
  return [...result.results]
    .sort((a, b) => b.seq - a.seq)
    .map(shapeScoreRow)
    .filter((item): item is ScoreItem => item !== null);
}

// -- OpenAPI (GET /api/v1/openapi.json) ------------------------------------------
//
// PUBLIC_API_ROUTES is the single source of truth for the public read
// surface: handlePublicApiRoute (below) dispatches from it and
// buildOpenApiDocument documents from it, so "every implemented path is
// documented" and "every documented path is implemented" hold by
// construction, not by two hand-maintained lists staying in sync.

interface PublicApiRouteMeta {
  method: "GET";
  path: string;
  summary: string;
  description: string;
  queryParams: ReadonlyArray<{ name: string; required: boolean; description: string }>;
}

type PublicApiHandler = (request: Request, env: ApiKeysEnv, workspaceId: string) => Promise<Response>;

export const PUBLIC_API_ROUTES: readonly PublicApiRouteMeta[] = [
  {
    method: "GET",
    path: "/api/v1/workstreams",
    summary: "List workstreams",
    description: "Cursor-paginated, workspace-scoped list of workstreams.",
    queryParams: [
      { name: "limit", required: false, description: "Page size, 1-100 (default 50)." },
      { name: "cursor", required: false, description: "Opaque pagination cursor from a previous page." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/sessions",
    summary: "List sessions",
    description: "Cursor-paginated, workspace-scoped list of hosted sessions.",
    queryParams: [
      { name: "limit", required: false, description: "Page size, 1-100 (default 50)." },
      { name: "cursor", required: false, description: "Opaque pagination cursor from a previous page." },
      { name: "provider", required: false, description: "Filter by provider (claude, codex, pi, otlp, ...)." },
      { name: "workstream", required: false, description: "Filter by workstream id." },
      { name: "since", required: false, description: "RFC 3339 lower bound on last activity." },
      { name: "until", required: false, description: "RFC 3339 upper bound on last activity." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/observations",
    summary: "List span observations",
    description: "Cursor-paginated, workspace-scoped list of the wide span_observations read model.",
    queryParams: [
      { name: "limit", required: false, description: "Page size, 1-100 (default 50)." },
      { name: "cursor", required: false, description: "Opaque pagination cursor from a previous page." },
      { name: "workstream", required: false, description: "Filter by workstream id." },
      { name: "trace", required: false, description: "Filter by trace id." },
      { name: "session", required: false, description: "Filter by session id." },
      { name: "kind", required: false, description: "Filter by normalized span kind." },
      { name: "status", required: false, description: "Filter by span status (unknown, running, ok, error)." },
      { name: "since", required: false, description: "RFC 3339 lower bound on span start." },
      { name: "until", required: false, description: "RFC 3339 upper bound on span start." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/scores",
    summary: "List scores recorded for a workstream",
    description: "Cursor-paginated scores (score.recorded events) for one workstream.",
    queryParams: [
      { name: "workstream", required: true, description: "Workstream id to list scores for (ws_...)." },
      { name: "limit", required: false, description: "Page size, 1-100 (default 50)." },
      { name: "cursor", required: false, description: "Opaque pagination cursor from a previous page." },
      { name: "target_type", required: false, description: "Filter by scored object type." },
      { name: "target_id", required: false, description: "Filter by scored object id." },
      { name: "name", required: false, description: "Filter by score name." },
    ],
  },
];

const PUBLIC_API_HANDLERS: Record<string, PublicApiHandler> = {
  "GET /api/v1/workstreams": publicListWorkstreams,
  "GET /api/v1/sessions": publicListSessions,
  "GET /api/v1/observations": publicListObservations,
  "GET /api/v1/scores": publicListScores,
};

const OPENAPI_PATH = "/api/v1/openapi.json";

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const route of PUBLIC_API_ROUTES) {
    paths[route.path] = {
      get: {
        summary: route.summary,
        description: route.description,
        operationId: route.path.replace(/^\/api\/v1\//, "").replace(/[^a-zA-Z0-9]+/g, "_"),
        security: [{ apiKey: [] }],
        parameters: route.queryParams.map((p) => ({
          name: p.name,
          in: "query",
          required: p.required,
          description: p.description,
          schema: { type: "string" },
        })),
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { type: "object" } },
                    next_cursor: { type: ["string", "null"] },
                  },
                  required: ["items", "next_cursor"],
                },
              },
            },
          },
          "400": { description: "Invalid query parameters", content: ERROR_CONTENT },
          "401": { description: "Missing or invalid credential", content: ERROR_CONTENT },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "HandoffGraph public API",
      version: "0.1.0",
      description:
        "Read-only public REST API over hosted HandoffGraph data. Authenticate with a project-scoped API " +
        "key (see POST /v1/api-keys, issued over the device-token management plane).",
    },
    servers: [{ url: "https://api.handoffgraph.dev" }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "sk_...",
          description:
            "Project-scoped API key secret, issued once by POST /v1/api-keys and never shown again. " +
            "Send as `Authorization: Bearer sk_...`.",
        },
      },
    },
    paths,
  };
}

const ERROR_CONTENT = {
  "application/json": {
    schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
  },
} as const;

// -- routing ------------------------------------------------------------------

async function handlePublicApiRoute(request: Request, env: ApiKeysEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === OPENAPI_PATH) {
    if (request.method !== "GET") return null;
    return json(200, buildOpenApiDocument());
  }
  const meta = PUBLIC_API_ROUTES.find((r) => r.path === pathname);
  if (meta === undefined) return null;
  if (request.method !== meta.method) return null;

  const auth = await authenticatePublicApi(request, env);
  if ("response" in auth) return auth.response;
  const handler = PUBLIC_API_HANDLERS[`${meta.method} ${meta.path}`];
  return handler(request, env, auth.workspaceId);
}

async function handleApiKeyManagement(request: Request, env: ApiKeysEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/api-keys") {
    if (request.method === "POST") return await createApiKey(request, env);
    if (request.method === "GET") return await listApiKeys(request, env);
    return null;
  }
  const revoke = API_KEY_REVOKE_PATH.exec(pathname);
  if (revoke !== null) {
    if (request.method !== "POST") return null;
    return await revokeApiKey(request, env, revoke[1]);
  }
  return null;
}

/**
 * Route both the api-keys management plane (/v1/api-keys*, device bearer)
 * and the public read API (/api/v1/*, pk_/sk_ or device bearer). Returns
 * null for paths this module does not own so index.ts continues its
 * sequential dispatch; a known path with the wrong method also returns null
 * and lands on the platform 404 (house rule).
 */
export async function handleApiKeysRoute(request: Request, env: ApiKeysEnv): Promise<Response | null> {
  const management = await handleApiKeyManagement(request, env);
  if (management !== null) return management;
  return await handlePublicApiRoute(request, env);
}
