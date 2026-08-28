// Gateway capture mode — an OpenAI-compatible proxy whose real product is
// capture, not routing (parity row 6: virtual keys/budgets/rate limits;
// parity row 7: response caching + provider fallback).
//
// The market already has good routers. Cloudflare's own AI Gateway ships
// spend limits and unified billing; LiteLLM and OpenRouter iterate faster
// than we will. What none of them do is land the proxied call in the same
// verified, append-only evidence spine as the coding-agent work that
// triggered it. So this module treats routing as table stakes and capture as
// the feature: every proxied call appends an hfg.event.v1 event next to the
// agent's own events, tagged with the workstream it belongs to, and the
// routing behaviour is deliberately the simple, adequate version.
//
// Surfaces:
//   POST /v1/gateway/keys                    mint a virtual key (shown once)
//   GET  /v1/gateway/keys                    list keys (never the secret)
//   POST /v1/gateway/keys/{id}/disable       revoke a key
//   POST /gateway/openai/v1/chat/completions the proxy
//   GET  /gateway/openai/v1/models           passthrough
//
// Storage split. D1 (migration 0010) is authoritative: gateway_keys is the
// registry, gateway_requests is the append-only spend ledger. KV
// (GATEWAY_KV) is only an edge cache of that truth, under `vk:<sha256(token)>`
// with a short TTL. Every mutation is D1 write-through THEN KV put; a KV miss
// falls back to D1 and backfills. D1 wins on any disagreement, and the whole
// proxy still works (slower) with no KV binding at all.
//
// Provenance. Token counts, status and latency are things this Worker
// directly observed, so capture events are OBSERVED. Cost is written ONLY
// when the upstream itself reported it (cost_provenance = provider_reported)
// — a figure we derived from a price table would be INFERRED, and this
// platform does not write INFERRED money as fact. No cost is more honest
// than a plausible one.
//
// Content discipline. The default capture tier is 'metadata': the ledger has
// no column that could hold a prompt, and the event payload carries only
// digests. Bodies are stored solely for keys explicitly created with
// capture: "full", in a separate content-addressed table so downstream
// redaction has exactly one place to purge.
//
// Non-goals in this version, stated so nobody mistakes them for oversights:
// streaming is rejected rather than silently buffered (see MSG_STREAM), and
// custom upstream base URLs get a literal-address guard only, not a real
// SSRF defence. See docs/gateway.md.

import { monotonicFactory } from "ulid";

import {
  authenticate,
  hasCapability,
  sha256Hex,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  MAX_BODY_BYTES,
  WORKSTREAM_ID_PATTERN,
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
} from "./ingest";
import { deterministicID } from "./otlp";
import { validateOutboundURL } from "./urlguard";

// -- ids -----------------------------------------------------------------------

const nextULID = monotonicFactory();

const KEY_PREFIX = "gwk_";
const REQUEST_PREFIX = "gwr_";
const EVENT_PREFIX = "evt_";

const DISABLE_PATH_PATTERN = /^\/v1\/gateway\/keys\/(gwk_[0-9A-HJKMNP-TV-Z]{26})\/disable$/;

const KEYS_PATH = "/v1/gateway/keys";
const CHAT_COMPLETIONS_PATH = "/gateway/openai/v1/chat/completions";
const MODELS_PATH = "/gateway/openai/v1/models";

function newGatewayKeyID(): string {
  return `${KEY_PREFIX}${nextULID()}`;
}

/**
 * Ledger row id and capture event id are BOTH derived from
 * (key id, request digest, start millisecond), so a retried write commits the
 * same row rather than double-charging. See docs/gateway.md for the
 * same-millisecond collision this trades against.
 */
function requestIdentityKey(keyId: string, requestHash: string): string {
  return `gateway|${keyId}|${requestHash}`;
}

// -- structural Cloudflare bindings ---------------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests and the real KVNamespace / R2Bucket satisfy these shapes structurally
// at the index.ts boundary.

export interface KVPutOptionsLike {
  /** Seconds until the entry self-expires. Cloudflare's floor is 60. */
  expirationTtl?: number;
}

export interface KVNamespaceLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, options?: KVPutOptionsLike): Promise<void>;
}

/** Only the R2 members the response cache touches, incl. customMetadata. */
export interface GatewayCacheObjectLike {
  readonly customMetadata?: Record<string, string>;
  text(): Promise<string>;
}

export interface GatewayCacheBucketLike {
  get(key: string): Promise<GatewayCacheObjectLike | null>;
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayEnv {
  DB: D1DatabaseLike;
  /** Edge cache of the D1 key registry + rate-limit counters. */
  GATEWAY_KV?: KVNamespaceLike;
  /** Response cache lives under the gwcache/ prefix of the shared bucket. */
  BODIES?: GatewayCacheBucketLike;
  /**
   * AES-GCM sealing key for upstream provider credentials, set via
   * `wrangler secret put GATEWAY_SEALING_KEY` (never in wrangler.toml — same
   * convention as WORKOS_API_KEY and WEBHOOK_SEALING_KEY). Key creation and
   * proxying both fail closed with 503 while it is unset: a gateway that
   * cannot seal credentials must not accept them.
   */
  GATEWAY_SEALING_KEY?: string;
}

// -- tunables --------------------------------------------------------------------

/** Cached virtual keys self-heal within this window even if a KV put is lost. */
export const GATEWAY_KEY_KV_TTL_SECONDS = 300;
/** Cloudflare's KV minimum expiration; also the rate-limit window. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;
/** Response-cache lifetime, checked against the object's customMetadata stamp. */
export const GATEWAY_CACHE_TTL_SECONDS = 300;
/** Upstream subrequest deadline; a timeout is treated exactly like a 5xx. */
export const UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const MAX_RATE_LIMIT_PER_MIN = 100_000;
export const MAX_FALLBACKS = 3;
export const MAX_KEY_NAME_LENGTH = 120;
const MAX_MANAGEMENT_BODY_BYTES = 8_192;

export const CAPTURE_TIERS = Object.freeze(["metadata", "full"] as const);
export type GatewayCaptureTier = (typeof CAPTURE_TIERS)[number];

export const UPSTREAM_PROVIDERS = Object.freeze(["openai", "anthropic", "custom"] as const);
export type UpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];

export const EVENT_KIND_COMPLETED = "gateway.request.completed";
export const EVENT_KIND_FAILED = "gateway.request.failed";

const MSG_STREAM =
  'streaming is not supported by the HandoffGraph gateway yet; resend with "stream": false';

// -- decimal money ------------------------------------------------------------------
// Costs are non-negative decimal STRINGS end to end. Never floats: 0.1 + 0.2
// is not 0.3 in binary floating point, and a ledger that rounds is not a
// ledger. Addition and comparison scale both operands to a common power of
// ten and work in BigInt.

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const MAX_DECIMAL_LENGTH = 32;

/** Canonical non-negative decimal: no sign, no exponent, no leading zeros. */
export function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DECIMAL_LENGTH &&
    DECIMAL_PATTERN.test(value)
  );
}

function decimalScale(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function decimalUnits(value: string, scale: number): bigint {
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  const fraction = dot === -1 ? "" : value.slice(dot + 1);
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

/** Exact addition. Result scale is max(scale(a), scale(b)) — no rounding, ever. */
export function addDecimalStrings(a: string, b: string): string {
  const scale = Math.max(decimalScale(a), decimalScale(b));
  return formatDecimal(decimalUnits(a, scale) + decimalUnits(b, scale), scale);
}

/** Exact ordering: -1 | 0 | 1. "10.00" and "10" compare equal. */
export function compareDecimalStrings(a: string, b: string): number {
  const scale = Math.max(decimalScale(a), decimalScale(b));
  const left = decimalUnits(a, scale);
  const right = decimalUnits(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Extract a PROVIDER-REPORTED cost from an upstream usage object. Returns
 * null unless the upstream stated a cost in a form we can represent exactly.
 * A JSON number is accepted only when it stringifies to canonical decimal
 * form — `1e-7` is rejected rather than reinterpreted, because a money value
 * we had to guess at is not a fact.
 */
export function providerReportedCost(usage: unknown): string | null {
  if (usage === null || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  for (const field of ["cost", "total_cost", "cost_usd"]) {
    const raw = record[field];
    if (isDecimalString(raw)) return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const asString = String(raw);
      if (isDecimalString(asString)) return asString;
    }
  }
  return null;
}

function usageTokenCount(usage: unknown, field: string): number | null {
  if (usage === null || typeof usage !== "object") return null;
  const raw = (usage as Record<string, unknown>)[field];
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

// -- credential sealing (AES-256-GCM under GATEWAY_SEALING_KEY) ----------------------
// Same scheme as webhook secret sealing (src/webhooks.ts): the operator's
// arbitrary-length secret is stretched through SHA-256 into a 256-bit AES key
// and the sealed value is base64(iv[12] || ciphertext-with-tag).

async function sealingCryptoKey(sealingKeySecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sealingKeySecret),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM", length: 256 }, false, [
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

export async function sealUpstreamKey(secret: string, sealingKeySecret: string): Promise<string> {
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

export async function unsealUpstreamKey(
  sealedValue: string | null,
  sealingKeySecret: string,
): Promise<string> {
  if (sealedValue === null) throw new Error("no sealed upstream key stored for this gateway key");
  const combined = base64ToBytes(sealedValue);
  if (combined.length <= 12) throw new Error("malformed sealed upstream key");
  const key = await sealingCryptoKey(sealingKeySecret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function newVirtualKeyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `vk_${bytesToBase64Url(bytes)}`;
}

// -- responses ------------------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * OpenAI-shaped error. The whole promise of this route is that an existing
 * OpenAI client works unchanged, so our failures have to be parseable by
 * that client's error handling too — not our own `{error: "..."}` envelope.
 */
export function openaiError(
  status: number,
  message: string,
  type: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: JSON_HEADERS,
  });
}

const invalidKeyError = () =>
  openaiError(401, "Incorrect API key provided.", "invalid_request_error", "invalid_api_key");

// -- device lookup (mirrors index.ts's adapter) ------------------------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* gateway:device-by-token */
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

// -- virtual key record ---------------------------------------------------------------

export interface GatewayUpstream {
  base_url: string;
  provider: UpstreamProvider;
  api_key_ciphertext: string | null;
}

export interface GatewayFallback {
  base_url: string;
  api_key_ciphertext: string | null;
}

/** The JSON cached in KV under `vk:<sha256(token)>`; mirrors the D1 row. */
export interface GatewayKeyRecord {
  id: string;
  workspace_id: string;
  name: string;
  budget_amount: string | null;
  budget_spent: string;
  rate_limit_per_min: number;
  upstream: GatewayUpstream;
  fallbacks: GatewayFallback[];
  capture: GatewayCaptureTier;
  disabled: boolean;
}

interface GatewayKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  budget_amount: string | null;
  budget_spent: string;
  rate_limit_per_min: number;
  upstream_base_url: string;
  upstream_provider: string;
  upstream_key_ciphertext: string | null;
  fallbacks: string;
  capture_tier: string;
  disabled: number;
}

function parseFallbacks(raw: string): GatewayFallback[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: GatewayFallback[] = [];
    for (const item of value) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.base_url !== "string") continue;
      out.push({
        base_url: record.base_url,
        api_key_ciphertext:
          typeof record.api_key_ciphertext === "string" ? record.api_key_ciphertext : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function recordFromRow(row: GatewayKeyRow): GatewayKeyRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    budget_amount: row.budget_amount,
    budget_spent: row.budget_spent,
    rate_limit_per_min: row.rate_limit_per_min,
    upstream: {
      base_url: row.upstream_base_url,
      provider: (UPSTREAM_PROVIDERS as readonly string[]).includes(row.upstream_provider)
        ? (row.upstream_provider as UpstreamProvider)
        : "custom",
      api_key_ciphertext: row.upstream_key_ciphertext,
    },
    fallbacks: parseFallbacks(row.fallbacks),
    capture: row.capture_tier === "full" ? "full" : "metadata",
    disabled: row.disabled === 1,
  };
}

function isGatewayKeyRecord(value: unknown): value is GatewayKeyRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.workspace_id === "string" &&
    typeof v.budget_spent === "string" &&
    typeof v.rate_limit_per_min === "number" &&
    typeof v.disabled === "boolean" &&
    v.upstream !== null &&
    typeof v.upstream === "object"
  );
}

// -- KV cache of the D1 registry ---------------------------------------------------

function kvKeyForTokenHash(tokenHash: string): string {
  return `vk:${tokenHash}`;
}

/** Best-effort: a KV outage degrades latency, never correctness. */
async function kvGet(kv: KVNamespaceLike | undefined, key: string): Promise<string | null> {
  if (kv === undefined) return null;
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function kvPut(
  kv: KVNamespaceLike | undefined,
  key: string,
  value: string,
  options?: KVPutOptionsLike,
): Promise<void> {
  if (kv === undefined) return;
  try {
    await kv.put(key, value, options);
  } catch {
    // Intentionally ignored: KV is the cache, D1 is the truth.
  }
}

const KEY_BY_TOKEN_HASH_SQL = `
  /* gateway:key-by-token-hash */
  SELECT id, workspace_id, name, budget_amount, budget_spent, rate_limit_per_min,
         upstream_base_url, upstream_provider, upstream_key_ciphertext,
         fallbacks, capture_tier, disabled
  FROM gateway_keys
  WHERE token_hash = ?1`;

/**
 * Resolve a virtual key: KV first, D1 on a miss, then backfill KV. The
 * backfill is what makes the steady state a single KV read at the edge while
 * keeping D1 authoritative for revocations and budget truth.
 */
export async function resolveGatewayKey(
  env: GatewayEnv,
  tokenHash: string,
): Promise<GatewayKeyRecord | null> {
  const cacheKey = kvKeyForTokenHash(tokenHash);
  const cached = await kvGet(env.GATEWAY_KV, cacheKey);
  if (cached !== null) {
    try {
      const parsed: unknown = JSON.parse(cached);
      if (isGatewayKeyRecord(parsed)) return parsed;
    } catch {
      // Fall through to D1 and overwrite the corrupt entry.
    }
  }

  const row = await env.DB.prepare(KEY_BY_TOKEN_HASH_SQL).bind(tokenHash).first<GatewayKeyRow>();
  if (row === null) return null;
  const record = recordFromRow(row);
  await kvPut(env.GATEWAY_KV, cacheKey, JSON.stringify(record), {
    expirationTtl: GATEWAY_KEY_KV_TTL_SECONDS,
  });
  return record;
}

// -- rate limiting -----------------------------------------------------------------
// A per-key fixed window counted in KV. Read-modify-write is not atomic, so
// bursts across colocations can overshoot: this is a cost guard rail, not a
// security control (the budget below is the hard stop). Documented as
// best-effort rather than quietly pretending to be exact.

function rateLimitKey(keyId: string, nowSeconds: number): string {
  return `rl:${keyId}:${Math.floor(nowSeconds / RATE_LIMIT_WINDOW_SECONDS)}`;
}

export async function checkRateLimit(
  env: GatewayEnv,
  record: GatewayKeyRecord,
  nowSeconds: number,
): Promise<boolean> {
  const kv = env.GATEWAY_KV;
  if (kv === undefined) return true;
  const key = rateLimitKey(record.id, nowSeconds);
  const raw = await kvGet(kv, key);
  const used = raw === null ? 0 : Number.parseInt(raw, 10);
  const count = Number.isSafeInteger(used) && used > 0 ? used : 0;
  if (count >= record.rate_limit_per_min) return false;
  await kvPut(kv, key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

// -- validation ---------------------------------------------------------------------

/**
 * Registration-time guard for custom upstreams, delegating every judgement to
 * the shared screen in src/urlguard.ts (https only, no userinfo, no private/
 * loopback/link-local/metadata literals, no localhost/.internal/.local names,
 * ports 443/8443 only). Returns the base URL with trailing slashes trimmed, or
 * null when it must not be registered.
 *
 * Still NOT a complete SSRF defence: it cannot see through DNS (a hostname
 * that resolves to 169.254.169.254 only at delivery time passes) and does not
 * pin redirects. urlguard.ts documents that boundary; the egress-side control
 * remains outstanding in docs/gateway.md.
 */
export function validateUpstreamBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (!validateOutboundURL(value).ok) return null;
  return value.replace(/\/+$/, "");
}

function validateApiKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_MANAGEMENT_BODY_BYTES);
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

interface CreateKeyInput {
  name: string;
  budgetAmount: string | null;
  rateLimitPerMin: number;
  capture: GatewayCaptureTier;
  upstream: { base_url: string; provider: UpstreamProvider; api_key: string };
  fallbacks: { base_url: string; api_key: string }[];
}

/**
 * Failure shape for validateCreateKeyBody. `reason` is present only for the
 * SSRF screen, where the caller answers 400 {error: 'unsafe_url', reason} so
 * the operator learns which rule their base URL tripped.
 */
type CreateKeyRejection = { ok: false; error: string; reason?: string };

export function validateCreateKeyBody(
  body: Record<string, unknown>,
): { ok: true; value: CreateKeyInput } | CreateKeyRejection {
  const name = body.name;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_KEY_NAME_LENGTH) {
    return { ok: false, error: `name must be a string of 1..${MAX_KEY_NAME_LENGTH} characters` };
  }

  let budgetAmount: string | null = null;
  if (body.budget_amount !== undefined && body.budget_amount !== null) {
    if (!isDecimalString(body.budget_amount)) {
      return { ok: false, error: "budget_amount must be a non-negative decimal string" };
    }
    budgetAmount = body.budget_amount;
  }

  let rateLimitPerMin = DEFAULT_RATE_LIMIT_PER_MIN;
  if (body.rate_limit_per_min !== undefined) {
    const raw = body.rate_limit_per_min;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_RATE_LIMIT_PER_MIN) {
      return { ok: false, error: `rate_limit_per_min must be an integer between 1 and ${MAX_RATE_LIMIT_PER_MIN}` };
    }
    rateLimitPerMin = raw as number;
  }

  let capture: GatewayCaptureTier = "metadata";
  if (body.capture !== undefined) {
    if (!(CAPTURE_TIERS as readonly string[]).includes(body.capture as string)) {
      return { ok: false, error: `capture must be one of: ${CAPTURE_TIERS.join(", ")}` };
    }
    capture = body.capture as GatewayCaptureTier;
  }

  const upstreamRaw = body.upstream;
  if (upstreamRaw === null || typeof upstreamRaw !== "object" || Array.isArray(upstreamRaw)) {
    return { ok: false, error: "upstream must be an object" };
  }
  const upstreamRecord = upstreamRaw as Record<string, unknown>;
  const upstreamGuard = validateOutboundURL(upstreamRecord.base_url);
  if (!upstreamGuard.ok) return { ok: false, error: "unsafe_url", reason: upstreamGuard.reason };
  const baseUrl = validateUpstreamBaseUrl(upstreamRecord.base_url);
  if (baseUrl === null) {
    return { ok: false, error: "upstream.base_url must be a public https:// URL" };
  }
  if (!(UPSTREAM_PROVIDERS as readonly string[]).includes(upstreamRecord.provider as string)) {
    return { ok: false, error: `upstream.provider must be one of: ${UPSTREAM_PROVIDERS.join(", ")}` };
  }
  const apiKey = validateApiKey(upstreamRecord.api_key);
  if (apiKey === null) return { ok: false, error: "upstream.api_key must be a non-empty string" };

  const fallbacks: { base_url: string; api_key: string }[] = [];
  if (body.fallbacks !== undefined) {
    if (!Array.isArray(body.fallbacks) || body.fallbacks.length > MAX_FALLBACKS) {
      return { ok: false, error: `fallbacks must be an array of at most ${MAX_FALLBACKS} entries` };
    }
    for (const item of body.fallbacks) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: "each fallback must be an object" };
      }
      const record = item as Record<string, unknown>;
      const fallbackGuard = validateOutboundURL(record.base_url);
      if (!fallbackGuard.ok) return { ok: false, error: "unsafe_url", reason: fallbackGuard.reason };
      const fallbackUrl = validateUpstreamBaseUrl(record.base_url);
      if (fallbackUrl === null) {
        return { ok: false, error: "fallbacks[].base_url must be a public https:// URL" };
      }
      const fallbackKey = validateApiKey(record.api_key);
      if (fallbackKey === null) {
        return { ok: false, error: "fallbacks[].api_key must be a non-empty string" };
      }
      fallbacks.push({ base_url: fallbackUrl, api_key: fallbackKey });
    }
  }

  return {
    ok: true,
    value: {
      name,
      budgetAmount,
      rateLimitPerMin,
      capture,
      upstream: { base_url: baseUrl, provider: upstreamRecord.provider as UpstreamProvider, api_key: apiKey },
      fallbacks,
    },
  };
}

// -- POST /v1/gateway/keys --------------------------------------------------------

const INSERT_KEY_SQL = `
  /* gateway:insert-key */
  INSERT INTO gateway_keys
    (id, workspace_id, name, token_hash, budget_amount, budget_spent,
     rate_limit_per_min, upstream_base_url, upstream_provider,
     upstream_key_ciphertext, fallbacks, capture_tier, disabled, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, '0', ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)`;

function publicKeyView(record: GatewayKeyRecord, createdAt: number): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    budget_amount: record.budget_amount,
    budget_spent: record.budget_spent,
    rate_limit_per_min: record.rate_limit_per_min,
    capture: record.capture,
    upstream: { base_url: record.upstream.base_url, provider: record.upstream.provider },
    fallbacks: record.fallbacks.map((fallback) => ({ base_url: fallback.base_url })),
    disabled: record.disabled,
    created_at: createdAt,
  };
}

async function createGatewayKey(request: Request, env: GatewayEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  const sealingKey = env.GATEWAY_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    return json(503, { error: "gateway_sealing_key_unavailable" });
  }

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  const validated = validateCreateKeyBody(body);
  if (!validated.ok) {
    return json(
      400,
      validated.reason === undefined
        ? { error: validated.error }
        : { error: validated.error, reason: validated.reason },
    );
  }
  const input = validated.value;

  const token = newVirtualKeyToken();
  const [tokenHash, upstreamCiphertext, ...fallbackCiphertexts] = await Promise.all([
    sha256Hex(token),
    sealUpstreamKey(input.upstream.api_key, sealingKey),
    ...input.fallbacks.map((fallback) => sealUpstreamKey(fallback.api_key, sealingKey)),
  ]);

  const id = newGatewayKeyID();
  const createdAt = Math.floor(Date.now() / 1000);
  const fallbacks: GatewayFallback[] = input.fallbacks.map((fallback, index) => ({
    base_url: fallback.base_url,
    api_key_ciphertext: fallbackCiphertexts[index] ?? null,
  }));

  // D1 write-through first: the registry must be durable before any edge
  // cache can serve the key, or a KV hit could outlive a failed insert.
  await env.DB.prepare(INSERT_KEY_SQL)
    .bind(
      id,
      auth.device.workspaceId,
      input.name,
      tokenHash,
      input.budgetAmount,
      input.rateLimitPerMin,
      input.upstream.base_url,
      input.upstream.provider,
      upstreamCiphertext,
      canonicalJsonStringify(fallbacks),
      input.capture,
      createdAt,
    )
    .run();

  const record: GatewayKeyRecord = {
    id,
    workspace_id: auth.device.workspaceId,
    name: input.name,
    budget_amount: input.budgetAmount,
    budget_spent: "0",
    rate_limit_per_min: input.rateLimitPerMin,
    upstream: {
      base_url: input.upstream.base_url,
      provider: input.upstream.provider,
      api_key_ciphertext: upstreamCiphertext,
    },
    fallbacks,
    capture: input.capture,
    disabled: false,
  };
  await kvPut(env.GATEWAY_KV, kvKeyForTokenHash(tokenHash), JSON.stringify(record), {
    expirationTtl: GATEWAY_KEY_KV_TTL_SECONDS,
  });

  return json(201, {
    gateway_key: publicKeyView(record, createdAt),
    virtual_key: token,
    warning: "Copy this virtual key now. It cannot be shown again.",
  });
}

// -- GET /v1/gateway/keys ----------------------------------------------------------

interface KeyListRow {
  id: string;
  name: string;
  budget_amount: string | null;
  budget_spent: string;
  rate_limit_per_min: number;
  upstream_base_url: string;
  upstream_provider: string;
  capture_tier: string;
  disabled: number;
  created_at: number;
}

const LIST_KEYS_SQL = `
  /* gateway:list-keys */
  SELECT id, name, budget_amount, budget_spent, rate_limit_per_min,
         upstream_base_url, upstream_provider, capture_tier, disabled, created_at
  FROM gateway_keys
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_KEYS_AFTER_SQL = `
  /* gateway:list-keys-after */
  SELECT id, name, budget_amount, budget_spent, rate_limit_per_min,
         upstream_base_url, upstream_provider, capture_tier, disabled, created_at
  FROM gateway_keys
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

function compareKeyRows(a: KeyListRow, b: KeyListRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

async function listGatewayKeys(request: Request, env: GatewayEnv): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "read")) return json(403, { error: "forbidden" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_KEYS_SQL).bind(auth.device.workspaceId, fetchLimit).all<KeyListRow>()
      : await env.DB.prepare(LIST_KEYS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<KeyListRow>();

  // Re-sort in the Worker so the page never depends on storage order.
  const sorted = [...result.results].sort(compareKeyRows);
  const rows = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = rows[rows.length - 1];

  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      budget_amount: row.budget_amount,
      budget_spent: row.budget_spent,
      rate_limit_per_min: row.rate_limit_per_min,
      capture: row.capture_tier === "full" ? "full" : "metadata",
      upstream: { base_url: row.upstream_base_url, provider: row.upstream_provider },
      disabled: row.disabled === 1,
      created_at: row.created_at,
    })),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- POST /v1/gateway/keys/{id}/disable ---------------------------------------------

const DISABLE_KEY_SQL = `
  /* gateway:disable-key */
  UPDATE gateway_keys
  SET disabled = 1
  WHERE id = ?1 AND workspace_id = ?2 AND disabled = 0
  RETURNING id, workspace_id, name, budget_amount, budget_spent, rate_limit_per_min,
            upstream_base_url, upstream_provider, upstream_key_ciphertext,
            fallbacks, capture_tier, disabled, token_hash`;

async function disableGatewayKey(
  request: Request,
  env: GatewayEnv,
  keyId: string,
): Promise<Response> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!hasCapability(auth.device, "ingest")) return json(403, { error: "forbidden" });

  // One workspace-scoped conditional UPDATE collapses "belongs to another
  // workspace", "unknown id" and "already disabled" into the same 404, so
  // existence in a foreign workspace is never leaked (platform convention:
  // scopeDenial in src/ingest.ts).
  const row = await env.DB.prepare(DISABLE_KEY_SQL)
    .bind(keyId, auth.device.workspaceId)
    .first<GatewayKeyRow & { token_hash: string }>();
  if (row === null) return json(404, { error: "not found" });

  // Write-through the revocation so the edge stops honouring the key without
  // waiting for the cache entry to expire.
  await kvPut(
    env.GATEWAY_KV,
    kvKeyForTokenHash(row.token_hash),
    JSON.stringify({ ...recordFromRow(row), disabled: true }),
    { expirationTtl: GATEWAY_KEY_KV_TTL_SECONDS },
  );

  return json(200, { ok: true });
}

// -- response cache (parity row 7) ----------------------------------------------------

/**
 * Cache identity: the semantic request, not its byte encoding. `stream` is
 * excluded because it never reaches an upstream here, and key order cannot
 * matter, so the canonical encoding is what gets hashed.
 */
export function cacheKeyMaterial(body: Record<string, unknown>): string {
  const params: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(body)) {
    if (field === "model" || field === "messages" || field === "stream") continue;
    params[field] = value;
  }
  return canonicalJsonStringify({
    model: body.model ?? null,
    messages: body.messages ?? null,
    params,
  });
}

function cacheObjectKey(workspaceId: string, digest: string): string {
  return `gwcache/${workspaceId}/${digest}.json`;
}

function cacheRequested(request: Request): boolean {
  const raw = (request.headers.get("x-handoffgraph-cache") ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

interface CachedResponse {
  body: string;
  status: number;
}

async function readCachedResponse(
  env: GatewayEnv,
  workspaceId: string,
  digest: string,
  nowSeconds: number,
): Promise<CachedResponse | null> {
  const bucket = env.BODIES;
  if (bucket === undefined) return null;
  try {
    const object = await bucket.get(cacheObjectKey(workspaceId, digest));
    if (object === null) return null;
    const stampRaw = object.customMetadata?.cached_at;
    const stamp = stampRaw === undefined ? Number.NaN : Number.parseInt(stampRaw, 10);
    // No usable stamp means we cannot prove freshness, so treat it as a miss
    // rather than serving something of unknown age.
    if (!Number.isSafeInteger(stamp)) return null;
    if (nowSeconds - stamp > GATEWAY_CACHE_TTL_SECONDS) return null;
    const statusRaw = object.customMetadata?.status;
    const status = statusRaw === undefined ? 200 : Number.parseInt(statusRaw, 10);
    return {
      body: await object.text(),
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 200,
    };
  } catch {
    return null;
  }
}

async function writeCachedResponse(
  env: GatewayEnv,
  workspaceId: string,
  digest: string,
  body: string,
  status: number,
  nowSeconds: number,
): Promise<void> {
  const bucket = env.BODIES;
  if (bucket === undefined) return;
  try {
    await bucket.put(cacheObjectKey(workspaceId, digest), body, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { cached_at: String(nowSeconds), status: String(status) },
    });
  } catch {
    // A cache write failure must never fail the caller's LLM request.
  }
}

// -- capture (the point of the slice) --------------------------------------------------

const INSERT_REQUEST_SQL = `
  /* gateway:insert-request */
  INSERT OR IGNORE INTO gateway_requests
    (id, workspace_id, key_id, model, upstream_status, latency_ms, tokens_in,
     tokens_out, cost_amount, cached, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`;

// Compare-and-set on the value we actually read, PLUS a guard that the
// ledger row for this exact request does not exist yet.
//
// The CAS makes a concurrent proxied call that already moved the counter a
// no-op here rather than a clobber. The NOT EXISTS guard is what keeps
// `budget_spent` derivable from the ledger: request ids are deterministic, so
// a replay finds its row already present and must not charge a second time.
// This statement is ordered BEFORE the ledger insert in the batch — D1 runs a
// batch sequentially in one transaction, so checking after the insert would
// always see the row we just wrote and never charge at all.
const UPDATE_BUDGET_SQL = `
  /* gateway:advance-budget-spent */
  UPDATE gateway_keys
  SET budget_spent = ?3
  WHERE id = ?1 AND workspace_id = ?2 AND budget_spent = ?4
    AND NOT EXISTS (
      SELECT 1 FROM gateway_requests
      WHERE workspace_id = ?2 AND id = ?5
    )`;

const INSERT_EVENT_SQL = `
  /* gateway:insert-capture-event */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, 'OBSERVED', ?8, ?9, ?10)`;

const INSERT_CAPTURE_BODY_SQL = `
  /* gateway:insert-capture-body */
  INSERT OR IGNORE INTO gateway_capture_bodies
    (workspace_id, content_hash, key_id, request_id, role, body, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

/** Everything one proxied call contributes to the spine and the ledger. */
export interface CaptureInput {
  record: GatewayKeyRecord;
  /**
   * SHA-256 of the presented virtual key — the KV cache key. Threaded in
   * rather than re-derived, because the raw token is never held past
   * authentication.
   */
  tokenHash: string;
  requestId: string;
  eventId: string;
  requestHash: string;
  responseHash: string | null;
  workstreamId: string | null;
  model: string | null;
  status: number | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costAmount: string | null;
  cached: boolean;
  fallbackIndex: number | null;
  startedAtMs: number;
  finishedAtMs: number;
  /** Present only when the key opted into capture: "full". */
  bodies?: { role: "request" | "response"; contentHash: string; body: string }[];
}

/**
 * The canonical hfg.event.v1 capture event. Content-free at the default
 * tier: model, provider, status, latency, token counts, cost and digests —
 * never a prompt or a completion. `content_hash` is populated only when a
 * body actually exists behind it (capture: "full"), because a hash that
 * points at nothing captured is a lie about what was retained.
 */
export function buildCaptureEvent(input: CaptureInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cached: input.cached,
    capture_tier: input.record.capture,
    cost_amount: input.costAmount,
    fallback_index: input.fallbackIndex,
    latency_ms: input.latencyMs,
    model: input.model,
    request_hash: input.requestHash,
    status: input.status,
    token_input: input.tokensIn,
    token_output: input.tokensOut,
    upstream_provider: input.record.upstream.provider,
    virtual_key_id: input.record.id,
  };
  // Cost is only ever written alongside the label that says where it came
  // from. An unlabelled amount would read as a platform assertion.
  if (input.costAmount !== null) payload.cost_provenance = "provider_reported";
  if (input.responseHash !== null) payload.response_hash = input.responseHash;

  const event: Record<string, unknown> = {
    schema_version: "hfg.event.v1",
    event_id: input.eventId,
    kind:
      input.status !== null && input.status < 400 ? EVENT_KIND_COMPLETED : EVENT_KIND_FAILED,
    occurred_at: new Date(input.startedAtMs).toISOString(),
    observed_at: new Date(input.finishedAtMs).toISOString(),
    provider: "gateway",
    provenance: "OBSERVED",
    payload,
  };
  if (input.workstreamId !== null) event.workstream_id = input.workstreamId;
  if (input.record.capture === "full") event.content_hash = input.requestHash;
  return event;
}

function captureStatements(
  db: D1DatabaseLike,
  input: CaptureInput,
  nowSeconds: number,
  includeEvent: boolean,
): D1BoundStatement[] {
  const workspaceId = input.record.workspace_id;
  const statements: D1BoundStatement[] = [];

  // Charge first, then append the ledger row: the charge is guarded on that
  // row's absence, so the order is load-bearing (see UPDATE_BUDGET_SQL).
  if (input.costAmount !== null) {
    statements.push(
      db.prepare(UPDATE_BUDGET_SQL).bind(
        input.record.id,
        workspaceId,
        addDecimalStrings(input.record.budget_spent, input.costAmount),
        input.record.budget_spent,
        input.requestId,
      ),
    );
  }

  statements.push(
    db.prepare(INSERT_REQUEST_SQL).bind(
      input.requestId,
      workspaceId,
      input.record.id,
      input.model,
      input.status,
      input.latencyMs,
      input.tokensIn,
      input.tokensOut,
      input.costAmount,
      input.cached ? 1 : 0,
      nowSeconds,
    ),
  );

  if (includeEvent) {
    const event = buildCaptureEvent(input);
    statements.push(
      db.prepare(INSERT_EVENT_SQL).bind(
        workspaceId,
        input.eventId,
        `gw_${input.requestId}`,
        event.occurred_at,
        input.workstreamId,
        "gateway",
        event.kind,
        (event.content_hash as string | undefined) ?? null,
        nowSeconds,
        canonicalJsonStringify(event),
      ),
    );
  }

  for (const body of input.bodies ?? []) {
    statements.push(
      db.prepare(INSERT_CAPTURE_BODY_SQL).bind(
        workspaceId,
        body.contentHash,
        input.record.id,
        input.requestId,
        body.role,
        body.body,
        nowSeconds,
      ),
    );
  }
  return statements;
}

/**
 * Commit the ledger row, the budget advance and the capture event as one D1
 * batch, then mirror the new spend into KV.
 *
 * Two deliberate behaviours:
 *   - Every failure is swallowed after content-free logging. A proxied call
 *     that reached the upstream must return the model's answer; hosted
 *     bookkeeping failing is our problem, not the caller's (same rule as
 *     "hosted failure never blocks local capture").
 *   - The event id is a pure function of (key, request digest, start ms), so
 *     two byte-identical requests in the same millisecond derive the same id
 *     with different latency payloads. The spine's payload-conflict trigger
 *     rejects that batch, so we retry once WITHOUT the event insert: the
 *     spend must still be recorded, and the spine already holds an event for
 *     that identity.
 */
export async function recordCapture(
  env: GatewayEnv,
  input: CaptureInput,
  nowSeconds: number,
): Promise<void> {
  try {
    try {
      await env.DB.batch(captureStatements(env.DB, input, nowSeconds, true));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("event payload conflict")) {
        throw error;
      }
      await env.DB.batch(captureStatements(env.DB, input, nowSeconds, false));
    }

    if (input.costAmount !== null) {
      // Mirror the new counter into the edge cache so the very next request
      // enforces the budget against the value D1 just accepted.
      const updated: GatewayKeyRecord = {
        ...input.record,
        budget_spent: addDecimalStrings(input.record.budget_spent, input.costAmount),
      };
      await kvPut(
        env.GATEWAY_KV,
        kvKeyForTokenHash(input.tokenHash),
        JSON.stringify(updated),
        { expirationTtl: GATEWAY_KEY_KV_TTL_SECONDS },
      );
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "gateway capture failed",
      error_type: error instanceof Error ? error.name : "unknown",
    }));
  }
}

// -- proxying -------------------------------------------------------------------------

interface UpstreamAttempt {
  response: Response | null;
  bodyText: string;
  fallbackIndex: number;
}

function upstreamSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
}

/**
 * Call one upstream. Only an explicit allow-list of headers is sent: the
 * caller's Authorization is replaced with the unsealed provider credential,
 * and X-HandoffGraph-* control headers are stripped so they never leak to a
 * third party. `redirect: "manual"` keeps a redirecting upstream from
 * becoming a second, unvalidated destination.
 */
async function callUpstream(
  fetcher: FetchLike,
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  apiKey: string,
  body: string | null,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    redirect: "manual",
  };
  if (body !== null) init.body = body;
  const signal = upstreamSignal();
  if (signal !== undefined) init.signal = signal;
  return fetcher(`${baseUrl}${path}`, init);
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * Primary upstream, then each configured fallback at most once, in array
 * order. A 5xx and a thrown fetch (timeout, DNS, connection reset) are the
 * same signal here. A 4xx is NOT retried: the request itself is wrong, and
 * replaying it against another provider just burns a second credential.
 */
async function callWithFallbacks(
  fetcher: FetchLike,
  record: GatewayKeyRecord,
  sealingKey: string,
  path: string,
  method: "GET" | "POST",
  body: string | null,
): Promise<UpstreamAttempt> {
  const targets = [
    { base_url: record.upstream.base_url, api_key_ciphertext: record.upstream.api_key_ciphertext },
    ...record.fallbacks,
  ];

  let last: UpstreamAttempt = { response: null, bodyText: "", fallbackIndex: 0 };
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    let apiKey: string;
    try {
      apiKey = await unsealUpstreamKey(target.api_key_ciphertext, sealingKey);
    } catch {
      last = { response: null, bodyText: "", fallbackIndex: index };
      continue;
    }
    try {
      const response = await callUpstream(fetcher, target.base_url, path, method, apiKey, body);
      const text = await response.text();
      const attempt: UpstreamAttempt = { response, bodyText: text, fallbackIndex: index };
      if (!isRetryableStatus(response.status)) return attempt;
      last = attempt;
    } catch {
      last = { response: null, bodyText: "", fallbackIndex: index };
    }
  }
  return last;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function workstreamHeader(request: Request): string | null {
  const raw = (request.headers.get("x-handoffgraph-workstream") ?? "").trim();
  // A malformed hint is ignored rather than rejected: the caller's LLM call
  // is not the place to fail on a linkage annotation.
  return raw.length > 0 && WORKSTREAM_ID_PATTERN.test(raw) ? raw : null;
}

/** Resolve + gate a virtual key. Every rejection is OpenAI-shaped. */
async function authorizeVirtualKey(
  request: Request,
  env: GatewayEnv,
  nowSeconds: number,
): Promise<
  | { ok: true; record: GatewayKeyRecord; sealingKey: string; tokenHash: string }
  | { ok: false; response: Response }
> {
  const sealingKey = env.GATEWAY_SEALING_KEY;
  if (typeof sealingKey !== "string" || sealingKey.length === 0) {
    // Fail closed: without the sealing key we cannot unseal an upstream
    // credential, and we will not fall back to forwarding the caller's own.
    return {
      ok: false,
      response: openaiError(
        503,
        "The gateway is not configured to use provider credentials.",
        "server_error",
        "gateway_sealing_key_unavailable",
      ),
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (match === null || !match[1].startsWith("vk_")) {
    return { ok: false, response: invalidKeyError() };
  }

  const tokenHash = await sha256Hex(match[1]);
  const record = await resolveGatewayKey(env, tokenHash);
  if (record === null) return { ok: false, response: invalidKeyError() };

  if (record.disabled) {
    return {
      ok: false,
      response: openaiError(
        401,
        "This virtual key has been disabled.",
        "invalid_request_error",
        "key_disabled",
      ),
    };
  }

  if (
    record.budget_amount !== null &&
    compareDecimalStrings(record.budget_spent, record.budget_amount) >= 0
  ) {
    return {
      ok: false,
      response: openaiError(
        429,
        "Budget exhausted for this virtual key.",
        "insufficient_quota",
        "budget_exhausted",
      ),
    };
  }

  if (!(await checkRateLimit(env, record, nowSeconds))) {
    return {
      ok: false,
      response: openaiError(
        429,
        "Rate limit exceeded for this virtual key.",
        "rate_limit_error",
        "rate_limit_exceeded",
      ),
    };
  }

  return { ok: true, record, sealingKey, tokenHash };
}

// -- POST /gateway/openai/v1/chat/completions ------------------------------------------

async function proxyChatCompletions(
  request: Request,
  env: GatewayEnv,
  fetcher: FetchLike,
): Promise<Response> {
  const startedAtMs = Date.now();
  const nowSeconds = Math.floor(startedAtMs / 1000);

  const authorized = await authorizeVirtualKey(request, env, nowSeconds);
  if (!authorized.ok) return authorized.response;
  const { record, sealingKey, tokenHash } = authorized;

  const bodyRead = await readRequestBody(request, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    return openaiError(
      bodyRead.status,
      bodyRead.status === 413 ? "Request body exceeds 1 MiB." : "Request body is not readable UTF-8.",
      "invalid_request_error",
      bodyRead.status === 413 ? "request_too_large" : "invalid_request_body",
    );
  }
  const parsed = parseJsonObject(bodyRead.text);
  if (parsed === null) {
    return openaiError(
      400,
      "Request body must be a JSON object.",
      "invalid_request_error",
      "invalid_request_body",
    );
  }
  if (parsed.stream === true) {
    // Buffering a stream and replaying it would silently destroy the latency
    // the caller asked for, so say no instead of pretending.
    return openaiError(400, MSG_STREAM, "invalid_request_error", "stream_unsupported");
  }

  const model = typeof parsed.model === "string" ? parsed.model.slice(0, 200) : null;
  const workstreamId = workstreamHeader(request);
  const canonicalRequest = cacheKeyMaterial(parsed);
  const digest = await sha256Hex(canonicalRequest);
  const requestHash = `sha256:${digest}`;
  const identity = requestIdentityKey(record.id, digest);
  const [requestId, eventId] = await Promise.all([
    deterministicID(REQUEST_PREFIX, identity, startedAtMs),
    deterministicID(EVENT_PREFIX, identity, startedAtMs),
  ]);

  const wantsCache = cacheRequested(request);
  if (wantsCache) {
    const hit = await readCachedResponse(env, record.workspace_id, digest, nowSeconds);
    if (hit !== null) {
      const finishedAtMs = Date.now();
      const parsedHit = parseJsonObject(hit.body);
      // A cache hit still produces a capture event: "this call happened, and
      // it cost nothing" is evidence too, and omitting it would make the
      // spine disagree with the caller's own request count.
      await recordCapture(
        env,
        {
          record,
          tokenHash,
          requestId,
          eventId,
          requestHash,
          responseHash: null,
          workstreamId,
          model,
          status: hit.status,
          latencyMs: finishedAtMs - startedAtMs,
          tokensIn: usageTokenCount(parsedHit?.usage, "prompt_tokens"),
          tokensOut: usageTokenCount(parsedHit?.usage, "completion_tokens"),
          costAmount: null,
          cached: true,
          fallbackIndex: null,
          startedAtMs,
          finishedAtMs,
        },
        nowSeconds,
      );
      return new Response(hit.body, {
        status: hit.status,
        headers: { ...JSON_HEADERS, "x-handoffgraph-cache": "hit" },
      });
    }
  }

  const attempt = await callWithFallbacks(
    fetcher,
    record,
    sealingKey,
    "/chat/completions",
    "POST",
    bodyRead.text,
  );
  const finishedAtMs = Date.now();
  const latencyMs = finishedAtMs - startedAtMs;

  if (attempt.response === null) {
    await recordCapture(
      env,
      {
        record,
        tokenHash,
        requestId,
        eventId,
        requestHash,
        responseHash: null,
        workstreamId,
        model,
        status: null,
        latencyMs,
        tokensIn: null,
        tokensOut: null,
        costAmount: null,
        cached: false,
        fallbackIndex: attempt.fallbackIndex,
        startedAtMs,
        finishedAtMs,
      },
      nowSeconds,
    );
    return openaiError(
      502,
      "The upstream provider could not be reached.",
      "server_error",
      "upstream_unavailable",
    );
  }

  const status = attempt.response.status;
  const responseJson = parseJsonObject(attempt.bodyText);
  const usage = responseJson?.usage;
  const costAmount = providerReportedCost(usage);
  const responseHash =
    record.capture === "full" ? `sha256:${await sha256Hex(attempt.bodyText)}` : null;

  const bodies =
    record.capture === "full"
      ? ([
          { role: "request" as const, contentHash: requestHash, body: bodyRead.text },
          ...(responseHash !== null
            ? [{ role: "response" as const, contentHash: responseHash, body: attempt.bodyText }]
            : []),
        ])
      : undefined;

  await recordCapture(
    env,
    {
      record,
      tokenHash,
      requestId,
      eventId,
      requestHash,
      responseHash,
      workstreamId,
      model,
      status,
      latencyMs,
      tokensIn: usageTokenCount(usage, "prompt_tokens"),
      tokensOut: usageTokenCount(usage, "completion_tokens"),
      costAmount,
      cached: false,
      fallbackIndex: attempt.fallbackIndex,
      startedAtMs,
      finishedAtMs,
      bodies,
    },
    nowSeconds,
  );

  if (wantsCache && status === 200 && responseJson !== null) {
    await writeCachedResponse(env, record.workspace_id, digest, attempt.bodyText, status, nowSeconds);
  }

  return new Response(attempt.bodyText, {
    status,
    headers: {
      ...JSON_HEADERS,
      "content-type":
        attempt.response.headers.get("content-type") ?? "application/json; charset=utf-8",
      ...(wantsCache ? { "x-handoffgraph-cache": "miss" } : {}),
    },
  });
}

// -- GET /gateway/openai/v1/models -----------------------------------------------------

/**
 * Pure passthrough. Deliberately NOT written to the spend ledger: a model
 * listing has no usage and no cost, and logging it would dilute the ledger
 * with rows that can never carry evidence.
 */
async function proxyModels(
  request: Request,
  env: GatewayEnv,
  fetcher: FetchLike,
): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authorized = await authorizeVirtualKey(request, env, nowSeconds);
  if (!authorized.ok) return authorized.response;

  const attempt = await callWithFallbacks(
    fetcher,
    authorized.record,
    authorized.sealingKey,
    "/models",
    "GET",
    null,
  );
  if (attempt.response === null) {
    return openaiError(
      502,
      "The upstream provider could not be reached.",
      "server_error",
      "upstream_unavailable",
    );
  }
  return new Response(attempt.bodyText, {
    status: attempt.response.status,
    headers: {
      ...JSON_HEADERS,
      "content-type":
        attempt.response.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
}

// -- routing -----------------------------------------------------------------------------

/**
 * Route the gateway surface. Returns null when this module does not own the
 * path (or owns the path but not this method — the platform-wide catch-all
 * in index.ts answers 404 for those).
 */
export async function handleGatewayRoute(
  request: Request,
  env: GatewayEnv,
  fetcher: FetchLike = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === KEYS_PATH) {
    if (request.method === "POST") return createGatewayKey(request, env);
    if (request.method === "GET") return listGatewayKeys(request, env);
    return null;
  }

  const disableMatch = DISABLE_PATH_PATTERN.exec(pathname);
  if (disableMatch !== null) {
    if (request.method === "POST") return disableGatewayKey(request, env, disableMatch[1]);
    return null;
  }

  if (pathname === CHAT_COMPLETIONS_PATH) {
    if (request.method === "POST") return proxyChatCompletions(request, env, fetcher);
    return null;
  }

  if (pathname === MODELS_PATH) {
    if (request.method === "GET") return proxyModels(request, env, fetcher);
    return null;
  }

  return null;
}
