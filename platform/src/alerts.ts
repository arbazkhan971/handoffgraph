// Scheduled alerts + notification channels (parity rows 41, 43).
//
// Three moving pieces:
//   - HTTP management routes (device bearer auth): create / list / disable a
//     rule, dry-run it (/test), and read its history.
//   - alertsScheduled(env): the cron sweep. For each active rule that is due it
//     measures one trailing window over the derived read models, compares the
//     measurement against the rule's threshold with an EXACT decimal
//     comparison (never a float), and on an ok -> breach transition appends an
//     `alert.fired` hfg.event.v1 row to the append-only events table.
//   - channel dispatch: Slack and email are POSTed/sent directly by the sweep;
//     `webhook` channels are delivered by the row-47 webhook pipeline, which
//     already watches the `alert.fired` kind (see DEFAULT_INTERESTING_KINDS in
//     src/webhooks.ts). Every dispatch is fail-closed and content-free logged,
//     and none of them can throw out of the sweep.
//
// Why history lives on the spine (row 43): a fired alert is evidence, so it is
// appended as an event rather than written to a side table. It then inherits
// append-only-ness, replay, export, retention exemption and webhook delivery
// for free. The event id is a pure function of (rule id, window end), so
// re-evaluating a window is idempotent under INSERT OR IGNORE instead of
// duplicating history — the schema forbids UPDATE/DELETE on events outright.
//
// Windows are pinned to the 30-minute ts_bucket grid migration 0005 stores on
// span_observations, so every window predicate is an exact index prune.

import { authenticate, hasCapability, type DeviceBinding, type DeviceLookup } from "./auth";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  WORKSTREAM_ID_PATTERN,
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
  scopeDenial,
  type Validation,
} from "./ingest";
import { monotonicFactory } from "ulid";

// -- ids -----------------------------------------------------------------------
// src/ids.ts is owned by the account module; alert rows mint their own prefixed
// ULIDs the same way (monotonic factory, so ids allocated in the same
// millisecond stay lexically ordered), exactly as src/webhooks.ts does.

const nextULID = monotonicFactory();

const RULE_ID_BODY = "[0-7][0-9A-HJKMNP-TV-Z]{25}";
const DISABLE_PATH_PATTERN = new RegExp(`^/v1/alerts/(alr_${RULE_ID_BODY})/disable$`);
const TEST_PATH_PATTERN = new RegExp(`^/v1/alerts/(alr_${RULE_ID_BODY})/test$`);
const HISTORY_PATH_PATTERN = new RegExp(`^/v1/alerts/(alr_${RULE_ID_BODY})/history$`);

function newAlertRuleID(): string {
  return `alr_${nextULID()}`;
}

// -- deterministic event ids ----------------------------------------------------
// Byte-compatible with the Go core's internal/ids.Deterministic (and with
// src/otlp.ts's hosted mirror of it): prefix + ULID(ms, sha256(prefix + "|" +
// key)[0..10]) in the canonical Crockford layout. Reimplemented here rather
// than imported so this module owns every byte of its own id derivation.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_MAX_TIME = 2 ** 48 - 1;
const EVENT_PREFIX = "evt_";

function encodeULIDTime(ms: number): string {
  let remaining = ms;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeULIDEntropy(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 10; i += 5) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const b3 = bytes[i + 3];
    const b4 = bytes[i + 4];
    out +=
      CROCKFORD[b0 >> 3] +
      CROCKFORD[((b0 & 7) << 2) | (b1 >> 6)] +
      CROCKFORD[(b1 & 63) >> 1] +
      CROCKFORD[((b1 & 1) << 4) | (b2 >> 4)] +
      CROCKFORD[((b2 & 15) << 1) | (b3 >> 7)] +
      CROCKFORD[(b3 & 127) >> 2] +
      CROCKFORD[((b3 & 3) << 3) | (b4 >> 5)] +
      CROCKFORD[b4 & 31];
  }
  return out;
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256Bytes(input);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The id of the alert.fired event for (rule, window end). A pure function of
 * its inputs: the same rule breaching the same window always yields the same
 * id, which is what makes the append idempotent under INSERT OR IGNORE.
 */
export async function alertEventID(ruleId: string, windowEndSeconds: number): Promise<string> {
  let ms = windowEndSeconds * 1000;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > ULID_MAX_TIME) ms = 0;
  const entropy = (await sha256Bytes(`${EVENT_PREFIX}|alert|${ruleId}|${windowEndSeconds}`)).slice(0, 10);
  return EVENT_PREFIX + encodeULIDTime(ms) + encodeULIDEntropy(entropy);
}

// -- env + structural Cloudflare bindings ----------------------------------------
// Structural, not the ambient Cloudflare types: plain-object fakes drive the
// tests, and the real bindings satisfy these shapes structurally at the
// index.ts boundary.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The slice of a Cloudflare `send_email` binding this module needs. */
export interface SendEmailLike {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export interface AlertsEnv {
  DB: D1DatabaseLike;
  /**
   * Optional `send_email` binding (wrangler.toml keeps it commented until a
   * sender address is verified). Email channels are skipped — never retried,
   * never fatal — while it or ALERT_SENDER is absent.
   */
  ALERT_EMAIL?: SendEmailLike;
  /** Verified sender address for ALERT_EMAIL. */
  ALERT_SENDER?: string;
}

// -- tunables ---------------------------------------------------------------------

/**
 * Alert windows are aligned to this grid, which is exactly the 30-minute
 * ts_bucket width migration 0005 stores on span_observations. Aligning means a
 * window boundary is always a bucket boundary, so the bucket prune is exact
 * and needs no slack bucket on either end.
 */
export const ALERT_GRID_SECONDS = 1_800;

/** Nanoseconds per 30-minute observation bucket (mirrors OBSERVATION_BUCKET_NS). */
const OBSERVATION_BUCKET_NS = 1_800_000_000_000n;

/** Decimal places every measured value is reported to. */
export const METRIC_SCALE = 6;

/**
 * A sustained breach re-fires only after this many windows have elapsed since
 * the last fire, so an ongoing outage produces a reminder rather than one
 * alert per cron tick.
 */
export const ALERT_REFIRE_WINDOWS = 3;

/** Rules evaluated per sweep tick. Bounds the worst-case D1 work per cron run. */
export const ALERT_SWEEP_RULE_LIMIT = 200;

export const MAX_CHANNELS = 8;
export const MAX_RULE_NAME_BYTES = 200;
export const MAX_THRESHOLD_CHARS = 40;
export const MAX_URL_BYTES = 2_048;
export const MAX_EMAIL_BYTES = 254;
const MAX_BODY_BYTES = 8_192;
const MAX_HISTORY_PAYLOAD_CHARS = 65_536;

export const ALERT_METRICS = Object.freeze([
  "cost",
  "error_rate",
  "events",
  "failed_spans",
  "tokens_in",
  "tokens_out",
] as const);
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** Metrics whose value and threshold are fractional; the rest are counters. */
const FRACTIONAL_METRICS = new Set<string>(["cost", "error_rate"]);

export const ALERT_COMPARATORS = Object.freeze(["gt", "gte", "lt", "lte"] as const);
export type AlertComparator = (typeof ALERT_COMPARATORS)[number];

export const ALERT_WINDOW_MINUTES = Object.freeze([30, 60, 1_440] as const);

export const ALERT_EVENT_KIND = "alert.fired";
export const ALERT_EVENT_SCHEMA_VERSION = "hfg.event.v1";

// -- exact decimal arithmetic ------------------------------------------------------
// Money is a decimal string and is never round-tripped through a float, so both
// sides of every comparison stay strings and the comparison is exact. One
// helper serves the fractional metrics and the integer counters alike: an
// integer string is just a decimal string with an empty fraction.

interface DecimalParts {
  negative: boolean;
  integer: string;
  fraction: string;
}

/** Parse a signed decimal string. Null when the value is not a plain decimal. */
export function parseDecimalString(value: string): DecimalParts | null {
  if (value.length === 0 || value.length > MAX_THRESHOLD_CHARS) return null;
  let body = value;
  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  if (body.length === 0) return null;
  const point = body.indexOf(".");
  const integer = point === -1 ? body : body.slice(0, point);
  const fraction = point === -1 ? "" : body.slice(point + 1);
  if (integer.length === 0 && fraction.length === 0) return null;
  const digitsOnly = (s: string) => s.length === 0 || /^[0-9]+$/.test(s);
  if (!digitsOnly(integer) || !digitsOnly(fraction)) return null;
  return { negative, integer, fraction };
}

function stripLeadingZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

function compareMagnitude(a: DecimalParts, b: DecimalParts): number {
  const aInt = stripLeadingZeros(a.integer);
  const bInt = stripLeadingZeros(b.integer);
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFrac = a.fraction.padEnd(width, "0");
  const bFrac = b.fraction.padEnd(width, "0");
  if (aFrac === bFrac) return 0;
  return aFrac < bFrac ? -1 : 1;
}

function isZero(parts: DecimalParts): boolean {
  return stripLeadingZeros(parts.integer) === "0" && /^0*$/.test(parts.fraction);
}

/**
 * Exact three-way comparison of two decimal strings. No floats, no precision
 * ceiling: digits are compared positionally after aligning the fractions.
 * Throws on a malformed operand rather than guessing — every operand reaching
 * here has already passed schema and API validation.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const left = parseDecimalString(a);
  const right = parseDecimalString(b);
  if (left === null || right === null) throw new Error("decimal comparison operand is malformed");
  const leftNegative = left.negative && !isZero(left);
  const rightNegative = right.negative && !isZero(right);
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const magnitude = compareMagnitude(left, right);
  if (magnitude === 0) return 0;
  const signed = leftNegative ? -magnitude : magnitude;
  return signed < 0 ? -1 : 1;
}

/** Apply a rule's comparator to an exact decimal comparison. */
export function comparatorHolds(
  value: string,
  comparator: AlertComparator,
  threshold: string,
): boolean {
  const ordering = compareDecimalStrings(value, threshold);
  switch (comparator) {
    case "gt":
      return ordering > 0;
    case "gte":
      return ordering >= 0;
    case "lt":
      return ordering < 0;
    case "lte":
      return ordering <= 0;
  }
}

/** Render a scaled integer as a fixed-scale decimal string (scale 0 => integer). */
export function scaledToDecimalString(scaled: bigint, scale: number): string {
  if (scale === 0) return scaled.toString();
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

/**
 * numerator / denominator, truncated toward zero at `scale` decimal places.
 * A ratio is not generally a finite decimal, so the scale and the truncation
 * are part of the metric's definition: error_rate is always reported to six
 * places and never rounds up, which keeps `gt` comparisons conservative.
 */
export function ratioToDecimalString(numerator: bigint, denominator: bigint, scale: number): string {
  if (denominator === 0n) return scaledToDecimalString(0n, scale);
  let factor = 1n;
  for (let i = 0; i < scale; i++) factor *= 10n;
  return scaledToDecimalString((numerator * factor) / denominator, scale);
}

/** Read a SQL aggregate (bound as TEXT) as an exact bigint. */
function aggregateToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("aggregate exceeds the safe integer range");
    return BigInt(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^-?[0-9]+$/.test(text)) throw new Error("aggregate is not an integer");
    return BigInt(text);
  }
  if (value === null || value === undefined) return 0n;
  throw new Error("aggregate has an unexpected type");
}

// -- windows -----------------------------------------------------------------------

export interface AlertWindow {
  /** Inclusive unix-seconds start of the trailing window. */
  startSeconds: number;
  /** Exclusive unix-seconds end; always on the 30-minute grid. */
  endSeconds: number;
  /** Inclusive ts_bucket bounds for span_observations (30-minute buckets). */
  startBucket: number;
  endBucket: number;
  /** Half-open nanosecond bounds, as decimal strings (int64 exceeds Number). */
  startNs: string;
  endNs: string;
}

/**
 * The window a rule is evaluated over at `nowSeconds`: the trailing
 * window_minutes ending at the most recent 30-minute grid boundary at or
 * before now.
 *
 * Aligning the END (rather than ending at "now") is what makes the derived
 * event id stable: every evaluation inside the same grid slot measures the
 * same window and therefore mints the same alert.fired id, so a re-fire inside
 * one slot is absorbed by INSERT OR IGNORE instead of duplicating history.
 * The cost is that data newer than the last boundary is measured by the next
 * evaluation, not this one.
 */
export function alertWindow(windowMinutes: number, nowSeconds: number): AlertWindow {
  const endSeconds = Math.floor(nowSeconds / ALERT_GRID_SECONDS) * ALERT_GRID_SECONDS;
  const startSeconds = endSeconds - windowMinutes * 60;
  return {
    startSeconds,
    endSeconds,
    startBucket: Math.floor(startSeconds / ALERT_GRID_SECONDS),
    endBucket: Math.floor(endSeconds / ALERT_GRID_SECONDS) - 1,
    startNs: (BigInt(startSeconds) * 1_000_000_000n).toString(),
    endNs: (BigInt(endSeconds) * 1_000_000_000n).toString(),
  };
}

/** The ts_bucket a nanosecond instant falls in (mirrors observations.ts). */
export function observationBucket(ns: string): number {
  return Number(BigInt(ns) / OBSERVATION_BUCKET_NS);
}

// -- metric SQL ----------------------------------------------------------------------

/**
 * Scale a decimal-string cost to integer micro-units inside SQLite, using only
 * string slicing and an integer CAST — the value never touches a float. Costs
 * are truncated (not rounded) beyond six decimal places, matching METRIC_SCALE.
 */
const COST_MICRO_EXPR = `CASE
             WHEN cost_amount IS NULL THEN 0
             WHEN instr(cost_amount, '.') = 0
               THEN CAST(cost_amount || '000000' AS INTEGER)
             ELSE CAST(
                    substr(cost_amount, 1, instr(cost_amount, '.') - 1) ||
                    substr(substr(cost_amount, instr(cost_amount, '.') + 1) || '000000', 1, 6)
                  AS INTEGER)
           END`;

// One statement serves every span-backed metric: the sweep and the /test route
// share exactly one measurement code path, so a dry run can never disagree
// with the evaluation it is predicting. Aggregates cross the boundary as TEXT
// so no int64 sum is ever narrowed through a JavaScript number.
const SPAN_METRICS_SQL = `
  /* alerts:span-metrics */
  SELECT
    CAST(COUNT(*) AS TEXT) AS span_total,
    CAST(COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS TEXT) AS span_errors,
    CAST(COALESCE(SUM(token_in), 0) AS TEXT) AS token_in_total,
    CAST(COALESCE(SUM(token_out), 0) AS TEXT) AS token_out_total,
    CAST(COALESCE(SUM(${COST_MICRO_EXPR}), 0) AS TEXT) AS cost_micro_total
  FROM span_observations
  WHERE workspace_id = ?1
    AND ts_bucket >= ?2
    AND ts_bucket <= ?3
    AND started_at_ns >= CAST(?4 AS INTEGER)
    AND started_at_ns < CAST(?5 AS INTEGER)`;

const SPAN_METRICS_WORKSTREAM_SQL = `${SPAN_METRICS_SQL}
    AND workstream_id = ?6`;

// The spine's own counter. ingested_at is the server-assigned ingestion clock;
// occurred_at is preserved exactly as observed (any UTC offset) and is never
// compared as a temporal range in SQL.
const EVENT_METRICS_SQL = `
  /* alerts:event-metrics */
  SELECT CAST(COUNT(*) AS TEXT) AS event_total
  FROM events
  WHERE workspace_id = ?1
    AND ingested_at >= ?2
    AND ingested_at < ?3`;

const EVENT_METRICS_WORKSTREAM_SQL = `${EVENT_METRICS_SQL}
    AND workstream_id = ?4`;

interface SpanMetricsRow {
  span_total: unknown;
  span_errors: unknown;
  token_in_total: unknown;
  token_out_total: unknown;
  cost_micro_total: unknown;
}

interface EventMetricsRow {
  event_total: unknown;
}

export interface Measurement {
  /** The metric value as an exact decimal string. */
  value: string;
  /** Decimal places in `value` (0 for the integer counters). */
  scale: number;
}

/**
 * Measure one rule's metric over one window. Every branch binds ?N parameters
 * against a fixed statement, so the SQL is a deterministic function of the
 * metric and of whether the rule is workstream-scoped.
 */
export async function measureMetric(
  db: D1DatabaseLike,
  rule: { workspace_id: string; metric: string; workstream_id: string | null },
  window: AlertWindow,
): Promise<Measurement> {
  if (rule.metric === "events") {
    const row =
      rule.workstream_id === null
        ? await db
            .prepare(EVENT_METRICS_SQL)
            .bind(rule.workspace_id, window.startSeconds, window.endSeconds)
            .first<EventMetricsRow>()
        : await db
            .prepare(EVENT_METRICS_WORKSTREAM_SQL)
            .bind(rule.workspace_id, window.startSeconds, window.endSeconds, rule.workstream_id)
            .first<EventMetricsRow>();
    return { value: aggregateToBigInt(row?.event_total ?? 0).toString(), scale: 0 };
  }

  const row =
    rule.workstream_id === null
      ? await db
          .prepare(SPAN_METRICS_SQL)
          .bind(
            rule.workspace_id,
            window.startBucket,
            window.endBucket,
            window.startNs,
            window.endNs,
          )
          .first<SpanMetricsRow>()
      : await db
          .prepare(SPAN_METRICS_WORKSTREAM_SQL)
          .bind(
            rule.workspace_id,
            window.startBucket,
            window.endBucket,
            window.startNs,
            window.endNs,
            rule.workstream_id,
          )
          .first<SpanMetricsRow>();

  const total = aggregateToBigInt(row?.span_total ?? 0);
  const errors = aggregateToBigInt(row?.span_errors ?? 0);
  switch (rule.metric) {
    case "error_rate":
      // Both halves of the ratio come from the SAME scan, so numerator and
      // denominator can never describe different windows.
      return { value: ratioToDecimalString(errors, total, METRIC_SCALE), scale: METRIC_SCALE };
    case "failed_spans":
      return { value: errors.toString(), scale: 0 };
    case "tokens_in":
      return { value: aggregateToBigInt(row?.token_in_total ?? 0).toString(), scale: 0 };
    case "tokens_out":
      return { value: aggregateToBigInt(row?.token_out_total ?? 0).toString(), scale: 0 };
    case "cost":
      return {
        value: scaledToDecimalString(aggregateToBigInt(row?.cost_micro_total ?? 0), METRIC_SCALE),
        scale: METRIC_SCALE,
      };
    default:
      throw new Error("unknown alert metric");
  }
}

// -- channels -------------------------------------------------------------------------

export type AlertChannel =
  | { type: "webhook"; url: string }
  | { type: "slack"; webhook_url: string }
  | { type: "email"; to: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (utf8Bytes(value) > MAX_URL_BYTES) return null;
  if (!value.startsWith("https://")) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
  } catch {
    return null;
  }
  return value;
}

function validEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (utf8Bytes(value) > MAX_EMAIL_BYTES) return null;
  if (!EMAIL_PATTERN.test(value)) return null;
  return value;
}

/** The channel's destination, used only for canonical ordering. */
function channelTarget(channel: AlertChannel): string {
  switch (channel.type) {
    case "webhook":
      return channel.url;
    case "slack":
      return channel.webhook_url;
    case "email":
      return channel.to;
  }
}

function compareChannels(a: AlertChannel, b: AlertChannel): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const left = channelTarget(a);
  const right = channelTarget(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Validate a channel array, fail-closed: unknown types, non-https URLs,
 * malformed addresses and unknown fields are all rejected rather than dropped.
 * The result is canonically sorted so the same channel set always stores the
 * same bytes.
 */
export function validateChannels(value: unknown): Validation<AlertChannel[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANNELS) {
    return {
      ok: false,
      status: 400,
      error: `channels must be an array of 1 to ${MAX_CHANNELS} channel objects`,
    };
  }
  const channels: AlertChannel[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, status: 400, error: "each channel must be a JSON object" };
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "webhook") {
      const url = validHttpsUrl(record.url);
      if (url === null) {
        return { ok: false, status: 400, error: "webhook channel url must be an https:// URL" };
      }
      channels.push({ type: "webhook", url });
      continue;
    }
    if (record.type === "slack") {
      const url = validHttpsUrl(record.webhook_url);
      if (url === null) {
        return {
          ok: false,
          status: 400,
          error: "slack channel webhook_url must be an https:// URL",
        };
      }
      channels.push({ type: "slack", webhook_url: url });
      continue;
    }
    if (record.type === "email") {
      const to = validEmail(record.to);
      if (to === null) {
        return { ok: false, status: 400, error: "email channel to must be an email address" };
      }
      channels.push({ type: "email", to });
      continue;
    }
    return { ok: false, status: 400, error: "channel type must be webhook, slack, or email" };
  }
  return { ok: true, value: [...channels].sort(compareChannels) };
}

/**
 * Read a stored channel array back through the SAME validator that wrote it,
 * so a row can never dispatch to a destination the API would have rejected.
 * A row that fails to re-validate (only reachable by writing D1 directly)
 * yields no channels rather than a partially-trusted subset: dispatching some
 * entries of an array we do not fully understand is the riskier failure.
 */
function parseChannels(raw: string): AlertChannel[] {
  const parsed = validateChannels(safeJsonParse(raw));
  return parsed.ok ? parsed.value : [];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// -- JSON responses ----------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- device lookup (mirrors index.ts's deviceLookup adapter) -------------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* alerts:device-by-token */
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

type Authorized = { ok: true; device: DeviceBinding } | { ok: false; response: Response };

async function authorize(
  request: Request,
  env: AlertsEnv,
  capability: "ingest" | "read",
): Promise<Authorized> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { ok: false, response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, capability),
  });
  if (denial !== null) return { ok: false, response: json(denial.status, { error: denial.error }) };
  return { ok: true, device: auth.device };
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_BODY_BYTES);
  if (!body.ok) return null;
  const value = safeJsonParse(body.text);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// -- rule rows -------------------------------------------------------------------------

export interface AlertRuleRow {
  id: string;
  workspace_id: string;
  name: string;
  metric: string;
  window_minutes: number;
  comparator: string;
  threshold: string;
  workstream_id: string | null;
  channels: string;
  active: number;
  created_at: number;
  last_evaluated_at: number | null;
  last_fired_at: number | null;
  breach_state: string;
}

const RULE_COLUMNS = `
    id, workspace_id, name, metric, window_minutes, comparator, threshold,
    workstream_id, channels, active, created_at, last_evaluated_at,
    last_fired_at, breach_state`;

function ruleItem(row: AlertRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    window_minutes: row.window_minutes,
    comparator: row.comparator,
    threshold: row.threshold,
    workstream_id: row.workstream_id,
    channels: parseChannels(row.channels),
    active: row.active === 1,
    created_at: row.created_at,
    last_evaluated_at: row.last_evaluated_at,
    last_fired_at: row.last_fired_at,
    breach_state: row.breach_state,
  };
}

// -- POST /v1/alerts ----------------------------------------------------------------------

const INSERT_RULE_SQL = `
  /* alerts:insert-rule */
  INSERT INTO alert_rules
    (id, workspace_id, name, metric, window_minutes, comparator, threshold,
     workstream_id, channels, active, created_at, breach_state)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, 'ok')`;

function validateThreshold(value: unknown, metric: AlertMetric): Validation<string> {
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: "threshold must be a decimal string" };
  }
  if (value.length === 0 || value.length > MAX_THRESHOLD_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `threshold must be 1 to ${MAX_THRESHOLD_CHARS} characters`,
    };
  }
  // Unsigned: every metric here is a non-negative quantity, and rejecting the
  // sign at the edge keeps the schema's GLOB backstop and this validator in
  // agreement.
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    return {
      ok: false,
      status: 400,
      error: "threshold must be an unsigned decimal string (digits with at most one point)",
    };
  }
  if (!FRACTIONAL_METRICS.has(metric) && value.includes(".")) {
    return {
      ok: false,
      status: 400,
      error: `threshold for ${metric} must be an integer string`,
    };
  }
  return { ok: true, value };
}

async function createAlertRule(request: Request, env: AlertsEnv): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  const body = await readSmallJsonBody(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });

  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0 || utf8Bytes(name) > MAX_RULE_NAME_BYTES) {
    return json(400, { error: `name must be a non-empty string of at most ${MAX_RULE_NAME_BYTES} bytes` });
  }

  const metric = body.metric;
  if (typeof metric !== "string" || !(ALERT_METRICS as readonly string[]).includes(metric)) {
    return json(400, { error: `metric must be one of ${ALERT_METRICS.join(", ")}` });
  }

  const windowMinutes = body.window_minutes;
  if (
    typeof windowMinutes !== "number" ||
    !(ALERT_WINDOW_MINUTES as readonly number[]).includes(windowMinutes)
  ) {
    return json(400, { error: `window_minutes must be one of ${ALERT_WINDOW_MINUTES.join(", ")}` });
  }

  const comparator = body.comparator;
  if (typeof comparator !== "string" || !(ALERT_COMPARATORS as readonly string[]).includes(comparator)) {
    return json(400, { error: `comparator must be one of ${ALERT_COMPARATORS.join(", ")}` });
  }

  const threshold = validateThreshold(body.threshold, metric as AlertMetric);
  if (!threshold.ok) return json(threshold.status, { error: threshold.error });

  let workstreamId: string | null = null;
  if (body.workstream_id !== undefined && body.workstream_id !== null) {
    if (typeof body.workstream_id !== "string" || !WORKSTREAM_ID_PATTERN.test(body.workstream_id)) {
      return json(400, { error: "workstream_id must be a ws_<ulid> identifier" });
    }
    workstreamId = body.workstream_id;
  }

  const channels = validateChannels(body.channels);
  if (!channels.ok) return json(channels.status, { error: channels.error });

  const id = newAlertRuleID();
  const createdAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(INSERT_RULE_SQL)
    .bind(
      id,
      auth.device.workspaceId,
      name,
      metric,
      windowMinutes,
      comparator,
      threshold.value,
      workstreamId,
      canonicalJsonStringify(channels.value),
      createdAt,
    )
    .run();

  return json(201, {
    alert: {
      id,
      name,
      metric,
      window_minutes: windowMinutes,
      comparator,
      threshold: threshold.value,
      workstream_id: workstreamId,
      channels: channels.value,
      active: true,
      created_at: createdAt,
      last_evaluated_at: null,
      last_fired_at: null,
      breach_state: "ok",
    },
  });
}

// -- GET /v1/alerts -------------------------------------------------------------------

const LIST_RULES_SQL = `
  /* alerts:list-rules */
  SELECT${RULE_COLUMNS}
  FROM alert_rules
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_RULES_AFTER_SQL = `
  /* alerts:list-rules-after */
  SELECT${RULE_COLUMNS}
  FROM alert_rules
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

function compareRuleRowsDescending(a: AlertRuleRow, b: AlertRuleRow): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

async function listAlertRules(request: Request, env: AlertsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_RULES_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<AlertRuleRow>()
      : await env.DB.prepare(LIST_RULES_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<AlertRuleRow>();

  // Re-sort in the Worker so the response never depends on storage order.
  const sorted = [...result.results].sort(compareRuleRowsDescending);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(ruleItem),
    next_cursor:
      sorted.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- POST /v1/alerts/{id}/disable ---------------------------------------------------------

const DISABLE_RULE_SQL = `
  /* alerts:disable-rule */
  UPDATE alert_rules
  SET active = 0
  WHERE id = ?1 AND workspace_id = ?2 AND active = 1
  RETURNING id`;

async function disableAlertRule(
  request: Request,
  env: AlertsEnv,
  ruleId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  // One workspace-scoped conditional UPDATE collapses "belongs to another
  // workspace", "unknown id" and "already disabled" into the same 404 —
  // existence in a foreign workspace is never leaked (see scopeDenial).
  const disabled = await env.DB.prepare(DISABLE_RULE_SQL)
    .bind(ruleId, auth.device.workspaceId)
    .first<{ id: string }>();
  if (disabled === null) return json(404, { error: "not found" });
  return json(200, { ok: true });
}

// -- POST /v1/alerts/{id}/test -------------------------------------------------------------

const READ_RULE_SQL = `
  /* alerts:read-rule */
  SELECT${RULE_COLUMNS}
  FROM alert_rules
  WHERE workspace_id = ?1 AND id = ?2`;

async function readRule(
  db: D1DatabaseLike,
  workspaceId: string,
  ruleId: string,
): Promise<AlertRuleRow | null> {
  return db.prepare(READ_RULE_SQL).bind(workspaceId, ruleId).first<AlertRuleRow>();
}

/**
 * Dry-run a rule. It measures the EXACT window the sweep would measure right
 * now and reports what the comparison says — so a dry run can never disagree
 * with the evaluation it is predicting. It writes nothing: no event is
 * appended, no bookkeeping column moves, no channel is dispatched.
 */
async function testAlertRule(request: Request, env: AlertsEnv, ruleId: string): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  const rule = await readRule(env.DB, auth.device.workspaceId, ruleId);
  if (rule === null) return json(404, { error: "not found" });

  const window = alertWindow(rule.window_minutes, Math.floor(Date.now() / 1000));
  const measurement = await measureMetric(env.DB, rule, window);
  return json(200, {
    value: measurement.value,
    threshold: rule.threshold,
    would_fire: comparatorHolds(measurement.value, rule.comparator as AlertComparator, rule.threshold),
  });
}

// -- GET /v1/alerts/{id}/history --------------------------------------------------------------

const HISTORY_SQL = `
  /* alerts:rule-history */
  SELECT seq, event_id, occurred_at, raw_json
  FROM events
  WHERE workspace_id = ?1
    AND kind = 'alert.fired'
    AND json_extract(raw_json, '$.payload.rule_id') = ?2
  ORDER BY seq DESC
  LIMIT ?3`;

const HISTORY_AFTER_SQL = `
  /* alerts:rule-history-after */
  SELECT seq, event_id, occurred_at, raw_json
  FROM events
  WHERE workspace_id = ?1
    AND kind = 'alert.fired'
    AND json_extract(raw_json, '$.payload.rule_id') = ?2
    AND seq < ?3
  ORDER BY seq DESC
  LIMIT ?4`;

interface HistoryRow {
  seq: number;
  event_id: string;
  occurred_at: string;
  raw_json: string;
}

function historyItem(row: HistoryRow): Record<string, unknown> {
  const payload =
    row.raw_json.length > MAX_HISTORY_PAYLOAD_CHARS ? null : safeJsonParse(row.raw_json);
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).payload as Record<string, unknown> | undefined)
      : undefined;
  const field = (key: string): unknown => (record === undefined ? null : record[key] ?? null);
  return {
    event_id: row.event_id,
    occurred_at: row.occurred_at,
    rule_id: field("rule_id"),
    rule_name: field("rule_name"),
    metric: field("metric"),
    value: field("value"),
    threshold: field("threshold"),
    comparator: field("comparator"),
    window_minutes: field("window_minutes"),
  };
}

async function alertRuleHistory(
  request: Request,
  env: AlertsEnv,
  ruleId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  // A rule that is not this workspace's is 404 before any history is read, so
  // history can never confirm the existence of a foreign rule.
  const rule = await readRule(env.DB, auth.device.workspaceId, ruleId);
  if (rule === null) return json(404, { error: "not found" });

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  // The spine's `seq` is the total order; the shared cursor codec carries it in
  // its numeric slot alongside the event id.
  const result =
    cursor === null
      ? await env.DB.prepare(HISTORY_SQL)
          .bind(auth.device.workspaceId, ruleId, fetchLimit)
          .all<HistoryRow>()
      : await env.DB.prepare(HISTORY_AFTER_SQL)
          .bind(auth.device.workspaceId, ruleId, cursor.createdAt, fetchLimit)
          .all<HistoryRow>();

  const sorted = [...result.results].sort((a, b) => b.seq - a.seq);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(historyItem),
    next_cursor:
      sorted.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.seq, id: last.event_id })
        : null,
  });
}

// -- routing ------------------------------------------------------------------------------

/**
 * Route the alerts HTTP surface. Returns null when this module does not own
 * the path (or owns the path but not this method — the platform-wide catch-all
 * in index.ts answers 404 for those).
 */
export async function handleAlertsRoute(
  request: Request,
  env: AlertsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === "/v1/alerts") {
    if (request.method === "POST") return createAlertRule(request, env);
    if (request.method === "GET") return listAlertRules(request, env);
    return null;
  }

  const disableMatch = DISABLE_PATH_PATTERN.exec(pathname);
  if (disableMatch !== null) {
    if (request.method === "POST") return disableAlertRule(request, env, disableMatch[1]);
    return null;
  }

  const testMatch = TEST_PATH_PATTERN.exec(pathname);
  if (testMatch !== null) {
    if (request.method === "POST") return testAlertRule(request, env, testMatch[1]);
    return null;
  }

  const historyMatch = HISTORY_PATH_PATTERN.exec(pathname);
  if (historyMatch !== null) {
    if (request.method === "GET") return alertRuleHistory(request, env, historyMatch[1]);
    return null;
  }

  return null;
}

// -- the sweep (alertsScheduled) --------------------------------------------------------------

/**
 * A rule is due once half its window has elapsed since the last evaluation —
 * often enough that a breach is noticed inside the window it happened in,
 * rarely enough that a 24-hour rule is not re-measured every five minutes.
 */
const DUE_RULES_SQL = `
  /* alerts:due-rules */
  SELECT${RULE_COLUMNS}
  FROM alert_rules
  WHERE active = 1
    AND (last_evaluated_at IS NULL OR ?1 - last_evaluated_at >= window_minutes * 30)
  ORDER BY workspace_id ASC, id ASC
  LIMIT ?2`;

const INSERT_ALERT_EVENT_SQL = `
  /* alerts:append-alert-fired */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, NULL, ?5, 'OBSERVED', ?6, ?7, ?8)`;

const RECORD_EVALUATION_SQL = `
  /* alerts:record-evaluation */
  UPDATE alert_rules
  SET last_evaluated_at = ?3, breach_state = ?4
  WHERE id = ?1 AND workspace_id = ?2`;

const RECORD_FIRE_SQL = `
  /* alerts:record-fire */
  UPDATE alert_rules
  SET last_evaluated_at = ?3, last_fired_at = ?4, breach_state = 'breaching'
  WHERE id = ?1 AND workspace_id = ?2`;

function logAlertFailure(stage: string, error: unknown): void {
  // Content-free structured logging: never log rule names, channel targets,
  // URLs, addresses, measured values, SQL binds or captured event fields.
  console.error(JSON.stringify({
    message: "alerts sweep failure",
    stage,
    error_type: error instanceof Error ? error.name : "unknown",
  }));
}

export interface FireDecision {
  /** True when the measurement breaches the rule's threshold. */
  breaching: boolean;
  /** True when this evaluation should append an alert.fired event. */
  fire: boolean;
  nextState: "ok" | "breaching";
}

/**
 * The breach-transition state machine.
 *
 * A rule fires on the ok -> breaching transition. While it stays breaching it
 * stays silent until ALERT_REFIRE_WINDOWS windows have elapsed since the last
 * fire, so an ongoing outage yields a periodic reminder rather than one alert
 * per cron tick. Recovering resets the machine, so the next breach fires
 * immediately again.
 */
export function decideFire(
  previousState: string,
  lastFiredAt: number | null,
  breaching: boolean,
  window: AlertWindow,
  windowMinutes: number,
): FireDecision {
  if (!breaching) return { breaching: false, fire: false, nextState: "ok" };
  if (previousState !== "breaching") return { breaching: true, fire: true, nextState: "breaching" };
  const refireAfter = ALERT_REFIRE_WINDOWS * windowMinutes * 60;
  const fire = lastFiredAt === null || window.endSeconds - lastFiredAt >= refireAfter;
  return { breaching: true, fire, nextState: "breaching" };
}

export interface AlertFiredPayload {
  rule_id: string;
  rule_name: string;
  metric: string;
  value: string;
  threshold: string;
  comparator: string;
  window_minutes: number;
}

/**
 * Build the canonical alert.fired hfg.event.v1 document and its deterministic
 * id. Provenance is OBSERVED: the platform measured this itself from recorded
 * evidence — nothing here is model-derived.
 */
export async function buildAlertEvent(
  rule: AlertRuleRow,
  measurement: Measurement,
  window: AlertWindow,
): Promise<{ eventId: string; occurredAt: string; contentHash: string; rawJson: string }> {
  const payload: AlertFiredPayload = {
    rule_id: rule.id,
    rule_name: rule.name,
    metric: rule.metric,
    value: measurement.value,
    threshold: rule.threshold,
    comparator: rule.comparator,
    window_minutes: rule.window_minutes,
  };
  const eventId = await alertEventID(rule.id, window.endSeconds);
  const occurredAt = new Date(window.endSeconds * 1000).toISOString();
  const contentHash = `sha256:${await sha256Hex(canonicalJsonStringify(payload))}`;
  const document: Record<string, unknown> = {
    schema_version: ALERT_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    kind: ALERT_EVENT_KIND,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    provenance: "OBSERVED",
    content_hash: contentHash,
    payload,
  };
  if (rule.workstream_id !== null) document.workstream_id = rule.workstream_id;
  return { eventId, occurredAt, contentHash, rawJson: canonicalJsonStringify(document) };
}

function alertText(rule: AlertRuleRow, payload: AlertFiredPayload): string {
  return (
    `HandoffGraph alert: ${rule.name}\n` +
    `${payload.metric} ${payload.comparator} ${payload.threshold} ` +
    `over the last ${payload.window_minutes} minutes (measured ${payload.value}).`
  );
}

async function dispatchSlack(url: string, text: string, fetcher: FetchLike): Promise<void> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`slack channel responded with status ${response.status}`);
}

async function dispatchEmail(
  env: AlertsEnv,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const binding = env.ALERT_EMAIL;
  const sender = env.ALERT_SENDER;
  if (binding === undefined || typeof sender !== "string" || sender.length === 0) {
    // Fail closed and stay quiet: the binding is commented out in wrangler.toml
    // until a sender address is verified, and a missing channel must never
    // fail the sweep or the alert append that already succeeded.
    throw new Error("alert email binding unavailable");
  }
  await binding.send({ from: sender, to, subject, text });
}

/**
 * Dispatch the non-webhook channels of a rule that just fired.
 *
 * `webhook` channels are intentionally NOT posted here: the row-47 webhook
 * pipeline already sweeps the events table for the `alert.fired` kind and
 * delivers it, signed, to the workspace's registered endpoints. Posting again
 * from this sweep would double-deliver.
 *
 * Every channel is isolated: one throwing channel is logged content-free and
 * never prevents the remaining channels, the remaining rules, or the rest of
 * the sweep from running.
 */
async function dispatchChannels(
  env: AlertsEnv,
  rule: AlertRuleRow,
  payload: AlertFiredPayload,
  fetcher: FetchLike,
): Promise<void> {
  const text = alertText(rule, payload);
  for (const channel of parseChannels(rule.channels)) {
    try {
      if (channel.type === "slack") {
        await dispatchSlack(channel.webhook_url, text, fetcher);
      } else if (channel.type === "email") {
        await dispatchEmail(env, channel.to, `HandoffGraph alert: ${rule.name}`, text);
      }
      // channel.type === "webhook": delivered by the row-47 webhook sweep.
    } catch (error) {
      logAlertFailure(`channel:${channel.type}`, error);
    }
  }
}

async function evaluateRule(
  env: AlertsEnv,
  rule: AlertRuleRow,
  nowSeconds: number,
  fetcher: FetchLike,
): Promise<void> {
  const window = alertWindow(rule.window_minutes, nowSeconds);
  const measurement = await measureMetric(env.DB, rule, window);
  const breaching = comparatorHolds(
    measurement.value,
    rule.comparator as AlertComparator,
    rule.threshold,
  );
  const decision = decideFire(
    rule.breach_state,
    rule.last_fired_at,
    breaching,
    window,
    rule.window_minutes,
  );

  if (!decision.fire) {
    await env.DB.prepare(RECORD_EVALUATION_SQL)
      .bind(rule.id, rule.workspace_id, nowSeconds, decision.nextState)
      .run();
    return;
  }

  const event = await buildAlertEvent(rule, measurement, window);
  // The append and the bookkeeping commit together: a rule can never record a
  // fire whose evidence is missing from the spine, and the spine can never
  // carry an alert the rule does not know it sent. The INSERT is OR IGNORE
  // because events are append-only in-schema — re-evaluating the same window
  // mints the same id and is absorbed rather than duplicated.
  const statements: D1BoundStatement[] = [
    env.DB.prepare(INSERT_ALERT_EVENT_SQL).bind(
      rule.workspace_id,
      event.eventId,
      event.occurredAt,
      rule.workstream_id,
      ALERT_EVENT_KIND,
      event.contentHash,
      nowSeconds,
      event.rawJson,
    ),
    env.DB.prepare(RECORD_FIRE_SQL).bind(
      rule.id,
      rule.workspace_id,
      nowSeconds,
      window.endSeconds,
    ),
  ];
  await env.DB.batch(statements);

  await dispatchChannels(
    env,
    rule,
    {
      rule_id: rule.id,
      rule_name: rule.name,
      metric: rule.metric,
      value: measurement.value,
      threshold: rule.threshold,
      comparator: rule.comparator,
      window_minutes: rule.window_minutes,
    },
    fetcher,
  );
}

function compareRulesForSweep(a: AlertRuleRow, b: AlertRuleRow): number {
  if (a.workspace_id !== b.workspace_id) return a.workspace_id < b.workspace_id ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Cron-triggered alert sweep (see wrangler.toml [triggers] and the scheduled
 * dispatcher in src/index.ts). Rules are evaluated one at a time in a
 * deterministic order, each isolated in its own try/catch so a single bad rule
 * never starves the rest of the tick — and so hosted alerting can never affect
 * ingest or local capture.
 */
export async function alertsScheduled(
  env: AlertsEnv,
  fetcher: FetchLike = fetch,
  nowSeconds?: number,
): Promise<void> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(DUE_RULES_SQL)
    .bind(now, ALERT_SWEEP_RULE_LIMIT)
    .all<AlertRuleRow>();
  const rules = [...due.results].sort(compareRulesForSweep);
  for (const rule of rules) {
    try {
      await evaluateRule(env, rule, now, fetcher);
    } catch (error) {
      logAlertFailure("rule-evaluation", error);
    }
  }
}
