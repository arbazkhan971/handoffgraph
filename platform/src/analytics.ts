// Analytics rollups + trace funnels (parity row 39 substrate: Analytics
// Engine rollups powering dashboards; row 42: trace funnels, pulled forward
// from P4; rows 37/38 hosted halves: usage/outcome analytics dashboard data).
//
// Two read paths, deliberately asymmetric:
//   * D1 aggregate reads (GET /v1/analytics/series, GET /v1/analytics/summary,
//     POST /v1/analytics/funnel) are the CORRECTNESS source. Every number in
//     these responses is derived directly from span_observations/events with
//     the SAME ts_bucket two-level prune migration 0005 established (row 10):
//     a coarse bucket predicate narrows the index, then an exact predicate on
//     started_at_ns keeps the result precise.
//   * recordIngestDataPoints mirrors an accepted ingest batch to Analytics
//     Engine, sampled and fire-and-forget, for external AE-native dashboards.
//     AE's `doubles` are IEEE floats: any cost value that passes through one
//     is a LOSSY, best-effort mirror, never the fact of record. D1's decimal
//     strings and provenance labels remain the facts; AE never sees
//     provenance at all. Absence of the ANALYTICS binding, or a throwing
//     one, must never affect the ingest response (hosted failure never
//     blocks capture).
//
// Design provenance (ideas only; no code, config, or schema copied from any
// AGPL/ELv2 project):
//   row 39 sampled rollups mirrored to a wide-column analytics store is the
//          general lesson behind SigNoz/ClickHouse-style deployments and
//          Cloudflare's own Analytics Engine pitch; the parity-plan's stack
//          translation table already names AE as our substrate for it.
//   row 42 trace funnels are SigNoz's "approximate workflow shape from spans
//          you already emit" idea (docs/research/05-signoz-openobserve.md).
//          The sequential step-matching algorithm here (a trace "passes"
//          step N at the earliest span matching step N's predicate at/after
//          step N-1's match, ties broken by span_id) is an original
//          construction over our own span_observations rows — SigNoz is
//          AGPL, so only the conversion-funnel CONCEPT travels, never its
//          implementation.
//
// Determinism contract: every response here is a pure function of D1 row
// content. Nothing reads clocks or relies on SQL row-return order — every
// query carries an explicit ORDER BY, and multi-row aggregations (cost sums,
// funnel step matching) are re-sorted in TypeScript before folding, matching
// observations.ts's "never trust storage order" discipline. Cost is folded
// with an exact decimal-string adder (see addDecimalStrings); no cost value
// is ever routed through a float except inside the AE mirror, which is
// explicitly documented as lossy at every call site that does it.

import {
  authenticate,
  hasCapability,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  readRequestBody,
  scopeDenial,
  type IngestEvent,
  type Validation,
} from "./ingest";
import {
  MAX_SPAN_ID_BYTES,
  MAX_SPAN_KIND_BYTES,
  MAX_SPAN_NAME_BYTES,
  MAX_TOOL_NAME_BYTES,
  observationBucket,
  parseEventTime,
  type EventTime,
} from "./observations";

// -- Analytics Engine structural binding --------------------------------------
// Structural, not the ambient Cloudflare type: a plain-object fake drives the
// tests, and the real AnalyticsEngineDataset binding satisfies this shape
// structurally at the index.ts boundary. writeDataPoint is SYNCHRONOUS and
// returns void on the real binding (fire-and-forget; Cloudflare buffers and
// flushes it) — this module never awaits it.

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface AnalyticsEnv {
  DB: D1DatabaseLike;
  /** Absent (or fake-omitted) => recordIngestDataPoints silently no-ops. */
  ANALYTICS?: AnalyticsEngineDatasetLike;
}

// -- exact decimal-string arithmetic ------------------------------------------
// Money is a decimal STRING end to end (platform invariant): cost_amount is
// validated at write time (observations.ts) as an optional '-', an integer
// part with no leading zero, and up to 9 fractional digits. Summing decimal
// strings by parsing them into floats would silently corrupt the fact of
// record, so every cost aggregate in this module goes through this adder
// instead — a fixed-point sum over BigInt, scaled to the same 9 fractional
// digits the column allows, so "zero-padding" a "0.5" against a "0.0125" and
// carrying a sum past a whole number are both exact by construction.

/** Mirrors observations.ts's DECIMAL_AMOUNT (duplicated: modules here stay independently usable). */
const DECIMAL_AMOUNT = /^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,9})?$/;

/** cost_amount's fractional-digit cap is 9, so a fixed-point scale of 1e9 is exact for every legal value. */
const COST_SCALE = 1_000_000_000n;

export function isValidDecimalAmount(value: string): boolean {
  return DECIMAL_AMOUNT.test(value);
}

function decimalStringToScaled(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const paddedFrac = fracPart.padEnd(9, "0"); // exact: the CHECK caps fracPart at 9 digits
  const magnitude = BigInt(intPart.length > 0 ? intPart : "0") * COST_SCALE + BigInt(paddedFrac);
  return negative ? -magnitude : magnitude;
}

function scaledToDecimalString(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const intPart = magnitude / COST_SCALE;
  const fracPart = (magnitude % COST_SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  const sign = negative && magnitude !== 0n ? "-" : ""; // never emit "-0"
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/**
 * Exact decimal-string sum. Invalid entries are skipped defensively (D1's
 * CHECK constraint already enforces the format at write time; fail-closed
 * here just means one malformed row can never corrupt a whole bucket's sum).
 * An empty input sums to "0", the additive identity.
 */
export function addDecimalStrings(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) {
    if (!isValidDecimalAmount(value)) continue;
    total += decimalStringToScaled(value);
  }
  return scaledToDecimalString(total);
}

/** The ONLY place a cost value may touch a float: the lossy AE mirror. */
function decimalStringToLossyDouble(value: string): number {
  return Number(value);
}

// -- ingest-time Analytics Engine mirror (scope 1) ----------------------------

/**
 * Sampling cap: one AE point per DISTINCT event kind in the batch, kinds
 * taken in sorted order. A batch can carry up to 500 events with arbitrary
 * kind strings (ingest.ts does not enumerate kinds), so this bounds how many
 * writeDataPoint calls one ingest ever makes — AE is a SAMPLED mirror by
 * design, and a batch with more distinct kinds than this simply mirrors a
 * deterministic subset of them. D1 (span_observations, events) is unaffected
 * and remains the complete, correct record regardless of this cap.
 */
export const MAX_ANALYTICS_DATAPOINTS_PER_BATCH = 20;

export interface IngestDataPoint {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

interface KindAggregate {
  count: number;
  tokensIn: number;
  tokensOut: number;
  costs: string[];
}

/** Cost provenance labels D1 actually records (observations.ts's COST_PROVENANCE, duplicated). */
const KNOWN_COST_PROVENANCE = new Set(["provider_reported", "catalog_estimate", "user_supplied"]);

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/** Lightweight usage extraction for the AE mirror only — the authoritative extraction lives in observations.ts. */
function extractUsage(payload: unknown): { tokensIn: number; tokensOut: number; cost: string | null } {
  const record = payloadRecord(payload);
  if (record === null) return { tokensIn: 0, tokensOut: 0, cost: null };
  const tokenIn = record.token_input;
  const tokenOut = record.token_output;
  const amount = record.cost_amount;
  const provenance = record.cost_provenance;
  const cost =
    typeof amount === "string" &&
    typeof provenance === "string" &&
    KNOWN_COST_PROVENANCE.has(provenance) &&
    isValidDecimalAmount(amount)
      ? amount
      : null;
  return {
    tokensIn: typeof tokenIn === "number" && Number.isFinite(tokenIn) && tokenIn >= 0 ? tokenIn : 0,
    tokensOut: typeof tokenOut === "number" && Number.isFinite(tokenOut) && tokenOut >= 0 ? tokenOut : 0,
    cost,
  };
}

/**
 * Pure aggregation: one data point per distinct event kind (count, token
 * sums, exact-summed cost), sorted by kind for determinism and capped at
 * MAX_ANALYTICS_DATAPOINTS_PER_BATCH. `indexes: [workspaceId]` groups a
 * workspace's points for AE's high-cardinality filter dimension; `blobs`
 * carry the low-cardinality (workspace, kind) dimensions AE groups by.
 */
export function buildIngestDataPoints(
  workspaceId: string,
  events: readonly IngestEvent[],
): IngestDataPoint[] {
  const byKind = new Map<string, KindAggregate>();
  for (const event of events) {
    const kind = typeof event.kind === "string" && event.kind.length > 0 ? event.kind : "unknown";
    const usage = extractUsage(event.payload);
    const agg = byKind.get(kind) ?? { count: 0, tokensIn: 0, tokensOut: 0, costs: [] };
    agg.count += 1;
    agg.tokensIn += usage.tokensIn;
    agg.tokensOut += usage.tokensOut;
    if (usage.cost !== null) agg.costs.push(usage.cost);
    byKind.set(kind, agg);
  }
  const kinds = [...byKind.keys()].sort().slice(0, MAX_ANALYTICS_DATAPOINTS_PER_BATCH);
  return kinds.map((kind) => {
    // Map.get after Map.set with the same key literal is always defined; the
    // non-null assertion documents that invariant rather than widening the
    // return type of a loop that only ever reads keys it just wrote.
    const agg = byKind.get(kind) as KindAggregate;
    const cost = agg.costs.length > 0 ? addDecimalStrings(agg.costs) : "0";
    return {
      blobs: [workspaceId, kind],
      doubles: [agg.count, agg.tokensIn, agg.tokensOut, decimalStringToLossyDouble(cost)],
      indexes: [workspaceId],
    };
  });
}

/**
 * Mirror one accepted ingest batch to Analytics Engine. Fire-and-forget and
 * fail-silent by construction: absence of the binding is a no-op, and any
 * throw (from a fake in tests, or a real binding failure) is swallowed here
 * so the caller in index.ts never has to guard this call — the D1 write this
 * follows has already committed and is the fact of record regardless of
 * what happens to the AE mirror.
 */
export function recordIngestDataPoints(
  env: { ANALYTICS?: AnalyticsEngineDatasetLike },
  workspaceId: string,
  events: readonly IngestEvent[],
): void {
  const analytics = env.ANALYTICS;
  if (analytics === undefined) return;
  try {
    for (const point of buildIngestDataPoints(workspaceId, events)) {
      analytics.writeDataPoint(point);
    }
  } catch {
    // AE is a sampled, best-effort mirror; never let it affect ingest.
  }
}

// -- shared read-side plumbing -------------------------------------------------

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

/** Parse an RFC 3339 `since`/`until` query bound; absent is allowed, malformed is not. */
function timeBound(url: URL, name: string): Validation<EventTime | null> {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: null };
  const parsed = parseEventTime(raw);
  if (parsed === null) {
    return { ok: false, status: 400, error: `${name} must be an RFC 3339 timestamp at or after 1970-01-01` };
  }
  return { ok: true, value: parsed };
}

function boundedFilter(url: URL, name: string, maxBytes: number): Validation<string | null> {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: null };
  if (exceedsUtf8Bytes(raw, maxBytes)) {
    return { ok: false, status: 400, error: `${name} must be at most ${maxBytes} UTF-8 bytes` };
  }
  return { ok: true, value: raw };
}

/**
 * Append the shared span_observations scope filter: workspace, an optional
 * workstream, and the two-level ts_bucket + exact started_at_ns time prune
 * (row 10) when since/until are present. Shared by series (non-`events`
 * metrics), summary, and the funnel scan so all three prune identically.
 */
function appendObservationScope(
  parts: QueryParts,
  workspaceId: string,
  workstream: string | null,
  since: EventTime | null,
  until: EventTime | null,
): string {
  let sql = `\n  WHERE workspace_id = ${bindParam(parts, workspaceId)}`;
  if (workstream !== null) sql += `\n    AND workstream_id = ${bindParam(parts, workstream)}`;
  if (since !== null) {
    sql += `\n    AND ts_bucket >= ${bindParam(parts, observationBucket(since.ns))}`;
    sql += `\n    AND started_at_ns >= CAST(${bindParam(parts, since.ns)} AS INTEGER)`;
  }
  if (until !== null) {
    sql += `\n    AND ts_bucket <= ${bindParam(parts, observationBucket(until.ns))}`;
    sql += `\n    AND started_at_ns <= CAST(${bindParam(parts, until.ns)} AS INTEGER)`;
  }
  return sql;
}

/** Round a ratio to 4 decimal places; 0/0 is defined as 0 (not NaN or 1). */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- device plane (module-local copy — see observations.ts for the rationale) -

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

async function authorize(
  request: Request,
  env: AnalyticsEnv,
  capability: string,
): Promise<{ device: DeviceBinding } | { response: Response }> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, capability),
  });
  if (denial !== null) return { response: json(denial.status, { error: denial.error }) };
  return { device: auth.device };
}

// -- GET /v1/analytics/series --------------------------------------------------

export const SERIES_METRICS = ["events", "spans", "errors", "tokens_in", "tokens_out", "cost"] as const;
export type SeriesMetric = (typeof SERIES_METRICS)[number];
const SERIES_METRIC_SET = new Set<string>(SERIES_METRICS);

export const SERIES_INTERVALS = { hour: 3_600, day: 86_400 } as const;
export type SeriesInterval = keyof typeof SERIES_INTERVALS;

/** How foldSeriesRows interprets raw rows: SQL already summed ("count"), or TS must exact-sum cost strings ("cost"). */
export type SeriesMode = "count" | "cost";

export interface SeriesQueryPlan {
  metric: SeriesMetric;
  interval: SeriesInterval;
  sql: string;
  binds: unknown[];
  mode: SeriesMode;
}

/**
 * Build the time-bucketed series query for one metric.
 *
 * `events` buckets by `ingested_at` (server receipt time, unix seconds)
 * rather than `occurred_at`: occurred_at is a raw RFC3339 string that may
 * carry a non-UTC numeric offset (validateEvent accepts "+05:30" alongside
 * "Z"), so it cannot be bucketed by SQL integer division the way the other
 * metrics' already-normalized started_at_ns can. Every other metric reads
 * span_observations and gets the full two-level ts_bucket prune (row 10).
 */
export function buildSeriesQuery(workspaceId: string, url: URL): Validation<SeriesQueryPlan> {
  const metricRaw = url.searchParams.get("metric");
  if (metricRaw === null || !SERIES_METRIC_SET.has(metricRaw)) {
    return { ok: false, status: 400, error: `metric must be one of ${SERIES_METRICS.join(", ")}` };
  }
  const metric = metricRaw as SeriesMetric;

  const intervalRaw = url.searchParams.get("interval");
  if (intervalRaw !== "hour" && intervalRaw !== "day") {
    return { ok: false, status: 400, error: "interval must be hour or day" };
  }
  const interval: SeriesInterval = intervalRaw;
  const intervalSeconds = SERIES_INTERVALS[interval];

  const workstream = boundedFilter(url, "workstream", MAX_SPAN_ID_BYTES);
  if (!workstream.ok) return workstream;
  const since = timeBound(url, "since");
  if (!since.ok) return since;
  const until = timeBound(url, "until");
  if (!until.ok) return until;

  const parts: QueryParts = { binds: [] };

  // The bucket-width divisor is ALWAYS inlined as an integer literal, never
  // bound as a parameter: SQLite's `/` performs float division the moment
  // either operand carries REAL storage class, and a bound JS number is not
  // guaranteed to arrive as INTEGER-typed. Migration 0005's ts_bucket
  // generated column makes the same choice for the same reason. `interval`
  // is constrained to the fixed "hour"|"day" enum above (never raw user
  // text), so inlining its derived divisor is safe.

  if (metric === "events") {
    let sql = `SELECT /* analytics:series-events */ (ingested_at / ${intervalSeconds}) AS bucket, COUNT(*) AS value
  FROM events
  WHERE workspace_id = ${bindParam(parts, workspaceId)}`;
    if (workstream.value !== null) sql += `\n    AND workstream_id = ${bindParam(parts, workstream.value)}`;
    if (since.value !== null) sql += `\n    AND ingested_at >= ${bindParam(parts, Math.floor(since.value.ms / 1000))}`;
    if (until.value !== null) sql += `\n    AND ingested_at <= ${bindParam(parts, Math.floor(until.value.ms / 1000))}`;
    sql += `\n  GROUP BY bucket\n  ORDER BY bucket ASC`;
    return { ok: true, value: { metric, interval, sql, binds: parts.binds, mode: "count" } };
  }

  // span_observations metrics: nanosecond buckets, so the bucket width is
  // expressed in the same native unit started_at_ns already uses.
  const bucketNs = intervalSeconds * 1_000_000_000;
  const bucketExpr = `(started_at_ns / ${bucketNs})`;
  let select: string;
  let mode: SeriesMode;
  switch (metric) {
    case "spans":
      select = "COUNT(*) AS value";
      mode = "count";
      break;
    case "errors":
      select = "COUNT(*) AS value";
      mode = "count";
      break;
    case "tokens_in":
      select = "SUM(token_in) AS value";
      mode = "count";
      break;
    case "tokens_out":
      select = "SUM(token_out) AS value";
      mode = "count";
      break;
    case "cost":
      select = "cost_amount, span_id";
      mode = "cost";
      break;
  }
  let sql = `SELECT /* analytics:series-observations */ ${bucketExpr} AS bucket, ${select}
  FROM span_observations`;
  sql += appendObservationScope(parts, workspaceId, workstream.value, since.value, until.value);
  if (metric === "errors") sql += `\n    AND status = 'error'`;
  if (metric === "tokens_in") sql += `\n    AND token_in IS NOT NULL`;
  if (metric === "tokens_out") sql += `\n    AND token_out IS NOT NULL`;
  if (metric === "cost") sql += `\n    AND cost_amount IS NOT NULL`;
  sql += mode === "cost" ? `\n  ORDER BY bucket ASC, span_id ASC` : `\n  GROUP BY bucket\n  ORDER BY bucket ASC`;
  return { ok: true, value: { metric, interval, sql, binds: parts.binds, mode } };
}

interface SeriesRawRow {
  bucket: number;
  value?: number | null;
  cost_amount?: string | null;
}

export interface SeriesPoint {
  bucket: number;
  value: number | string;
}

/**
 * Fold raw rows into one point per bucket. "count" rows are already
 * SQL-aggregated (COUNT/SUM); "cost" rows are one row per span and are
 * exact-summed here with addDecimalStrings — cost is never passed through
 * SQL SUM, which would coerce the TEXT column through REAL and lose
 * precision. Output is re-sorted by bucket regardless of DB row order.
 */
export function foldSeriesRows(mode: SeriesMode, rows: readonly SeriesRawRow[]): SeriesPoint[] {
  if (mode === "count") {
    return rows
      .map((row) => ({ bucket: row.bucket, value: typeof row.value === "number" ? row.value : 0 }))
      .sort((a, b) => a.bucket - b.bucket);
  }
  const byBucket = new Map<number, string[]>();
  for (const row of rows) {
    if (typeof row.cost_amount !== "string") continue;
    const list = byBucket.get(row.bucket);
    if (list) list.push(row.cost_amount);
    else byBucket.set(row.bucket, [row.cost_amount]);
  }
  return [...byBucket.entries()]
    .map(([bucket, amounts]) => ({ bucket, value: addDecimalStrings(amounts) }))
    .sort((a, b) => a.bucket - b.bucket);
}

function bucketStartISO(bucket: number, intervalSeconds: number): string {
  return new Date(bucket * intervalSeconds * 1_000).toISOString();
}

async function getSeries(request: Request, env: AnalyticsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const built = buildSeriesQuery(auth.device.workspaceId, new URL(request.url));
  if (!built.ok) return json(built.status, { error: built.error });
  const { metric, interval, sql, binds, mode } = built.value;

  const result = await env.DB.prepare(sql).bind(...binds).all<SeriesRawRow>();
  const intervalSeconds = SERIES_INTERVALS[interval];
  const points = foldSeriesRows(mode, result.results).map((point) => ({
    bucket_start: bucketStartISO(point.bucket, intervalSeconds),
    value: point.value,
  }));
  return json(200, { metric, interval, points });
}

// -- GET /v1/analytics/summary -------------------------------------------------

export interface SummaryQueryPlan {
  countsSQL: string;
  countsBinds: unknown[];
  costSQL: string;
  costBinds: unknown[];
}

/** Totals per (provider, model): traces/spans/errors/tokens via one SQL aggregate, cost via a second exact-summed pass. */
export function buildSummaryQueries(workspaceId: string, url: URL): Validation<SummaryQueryPlan> {
  const workstream = boundedFilter(url, "workstream", MAX_SPAN_ID_BYTES);
  if (!workstream.ok) return workstream;
  const since = timeBound(url, "since");
  if (!since.ok) return since;
  const until = timeBound(url, "until");
  if (!until.ok) return until;

  const countsParts: QueryParts = { binds: [] };
  let countsSQL = `SELECT /* analytics:summary-counts */
    provider, model,
    COUNT(DISTINCT trace_id) AS traces,
    COUNT(*) AS spans,
    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
    SUM(COALESCE(token_in, 0)) AS tokens_in,
    SUM(COALESCE(token_out, 0)) AS tokens_out
  FROM span_observations`;
  countsSQL += appendObservationScope(countsParts, workspaceId, workstream.value, since.value, until.value);
  countsSQL += `\n  GROUP BY provider, model\n  ORDER BY provider ASC, model ASC`;

  const costParts: QueryParts = { binds: [] };
  let costSQL = `SELECT /* analytics:summary-cost */ provider, model, cost_amount
  FROM span_observations`;
  costSQL += appendObservationScope(costParts, workspaceId, workstream.value, since.value, until.value);
  costSQL += `\n    AND cost_amount IS NOT NULL`;

  return {
    ok: true,
    value: { countsSQL, countsBinds: countsParts.binds, costSQL, costBinds: costParts.binds },
  };
}

interface SummaryCountsRow {
  provider: string | null;
  model: string | null;
  traces: number;
  spans: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
}

interface SummaryCostRow {
  provider: string | null;
  model: string | null;
  cost_amount: string;
}

export interface SummaryGroup {
  provider: string | null;
  model: string | null;
  traces: number;
  spans: number;
  errors: number;
  error_rate: number;
  tokens_in: number;
  tokens_out: number;
  cost: string | null;
}

function groupKey(provider: string | null, model: string | null): string {
  return `${provider ?? ""} ${model ?? ""}`;
}

function compareNullableStrings(a: string | null, b: string | null): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Merge the counts pass with the cost pass by (provider, model), and re-sort
 * so the response never depends on either query's row order. A group with no
 * cost-bearing spans gets cost: null (no recorded cost), never "0" (a
 * recorded zero) — the same NULL-means-unrecorded distinction D1 enforces.
 */
export function buildSummaryGroups(
  countsRows: readonly SummaryCountsRow[],
  costRows: readonly SummaryCostRow[],
): SummaryGroup[] {
  const costsByKey = new Map<string, string[]>();
  for (const row of costRows) {
    const key = groupKey(row.provider, row.model);
    const list = costsByKey.get(key);
    if (list) list.push(row.cost_amount);
    else costsByKey.set(key, [row.cost_amount]);
  }
  const groups = countsRows.map((row) => {
    const costs = costsByKey.get(groupKey(row.provider, row.model));
    return {
      provider: row.provider,
      model: row.model,
      traces: row.traces,
      spans: row.spans,
      errors: row.errors,
      error_rate: ratio(row.errors, row.spans),
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      cost: costs !== undefined ? addDecimalStrings(costs) : null,
    };
  });
  return [...groups].sort((a, b) => {
    const byProvider = compareNullableStrings(a.provider, b.provider);
    return byProvider !== 0 ? byProvider : compareNullableStrings(a.model, b.model);
  });
}

async function getSummary(request: Request, env: AnalyticsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const built = buildSummaryQueries(auth.device.workspaceId, new URL(request.url));
  if (!built.ok) return json(built.status, { error: built.error });
  const { countsSQL, countsBinds, costSQL, costBinds } = built.value;

  const [counts, costs] = await Promise.all([
    env.DB.prepare(countsSQL).bind(...countsBinds).all<SummaryCountsRow>(),
    env.DB.prepare(costSQL).bind(...costBinds).all<SummaryCostRow>(),
  ]);
  return json(200, { groups: buildSummaryGroups(counts.results, costs.results) });
}

// -- POST /v1/analytics/funnel -------------------------------------------------

export const MAX_FUNNEL_STEPS = 5;
/** Scan ceiling: a request whose scope matches more DISTINCT traces than this 400s with guidance instead of scanning. */
export const MAX_FUNNEL_TRACES = 10_000;
const FUNNEL_BODY_BYTES = 8_192; // generous for <=5 tiny predicate objects; local override, like webhooks.ts's MAX_BODY_BYTES

const FUNNEL_STATUSES = ["unknown", "running", "ok", "error"] as const;
const FUNNEL_STATUS_SET = new Set<string>(FUNNEL_STATUSES);

export interface FunnelStepPredicate {
  kind?: string;
  tool_name?: string;
  status?: string;
  name_contains?: string;
}

export interface FunnelRequestBody {
  steps: FunnelStepPredicate[];
  workstream: string | null;
  since: EventTime | null;
  until: EventTime | null;
}

function requiredBoundedString(
  record: Record<string, unknown>,
  field: string,
  maxBytes: number,
  at: string,
): string | null {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) return `${at}.${field} must be a non-empty string`;
  if (exceedsUtf8Bytes(value, maxBytes)) return `${at}.${field} must be at most ${maxBytes} UTF-8 bytes`;
  return null;
}

/**
 * Validate a funnel request body. Each step must specify at least one
 * predicate field — an empty step would trivially match every later span in
 * every trace, which is never a meaningful funnel step.
 */
export function validateFunnelRequest(value: unknown): Validation<FunnelRequestBody> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "request body must be a JSON object" };
  }
  const body = value as Record<string, unknown>;
  const rawSteps = body.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_FUNNEL_STEPS) {
    return { ok: false, status: 400, error: `steps must be an array of 1 to ${MAX_FUNNEL_STEPS} predicates` };
  }

  const steps: FunnelStepPredicate[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: `steps[${i}] must be an object` };
    }
    const record = raw as Record<string, unknown>;
    const at = `steps[${i}]`;
    const step: FunnelStepPredicate = {};

    if (record.kind !== undefined) {
      const error = requiredBoundedString(record, "kind", MAX_SPAN_KIND_BYTES, at);
      if (error !== null) return { ok: false, status: 400, error };
      step.kind = record.kind as string;
    }
    if (record.tool_name !== undefined) {
      const error = requiredBoundedString(record, "tool_name", MAX_TOOL_NAME_BYTES, at);
      if (error !== null) return { ok: false, status: 400, error };
      step.tool_name = record.tool_name as string;
    }
    if (record.status !== undefined) {
      if (typeof record.status !== "string" || !FUNNEL_STATUS_SET.has(record.status)) {
        return { ok: false, status: 400, error: `${at}.status must be one of ${FUNNEL_STATUSES.join(", ")}` };
      }
      step.status = record.status;
    }
    if (record.name_contains !== undefined) {
      const error = requiredBoundedString(record, "name_contains", MAX_SPAN_NAME_BYTES, at);
      if (error !== null) return { ok: false, status: 400, error };
      step.name_contains = record.name_contains as string;
    }
    if (Object.keys(step).length === 0) {
      return {
        ok: false,
        status: 400,
        error: `${at} must specify at least one of kind, tool_name, status, name_contains`,
      };
    }
    steps.push(step);
  }

  let workstream: string | null = null;
  if (body.workstream !== undefined) {
    const error = requiredBoundedString(body, "workstream", MAX_SPAN_ID_BYTES, "body");
    if (error !== null) return { ok: false, status: 400, error };
    workstream = body.workstream as string;
  }

  let since: EventTime | null = null;
  if (body.since !== undefined) {
    if (typeof body.since !== "string") return { ok: false, status: 400, error: "since must be an RFC 3339 timestamp" };
    since = parseEventTime(body.since);
    if (since === null) {
      return { ok: false, status: 400, error: "since must be an RFC 3339 timestamp at or after 1970-01-01" };
    }
  }
  let until: EventTime | null = null;
  if (body.until !== undefined) {
    if (typeof body.until !== "string") return { ok: false, status: 400, error: "until must be an RFC 3339 timestamp" };
    until = parseEventTime(body.until);
    if (until === null) {
      return { ok: false, status: 400, error: "until must be an RFC 3339 timestamp at or after 1970-01-01" };
    }
  }

  return { ok: true, value: { steps, workstream, since, until } };
}

export interface FunnelScopeQuery {
  countSQL: string;
  countBinds: unknown[];
  rowsSQL: string;
  rowsBinds: unknown[];
}

/** Same scope (workspace/workstream/time) queried two ways: a cheap distinct-trace count, then the actual span rows. */
export function buildFunnelScopeQuery(
  workspaceId: string,
  workstream: string | null,
  since: EventTime | null,
  until: EventTime | null,
): FunnelScopeQuery {
  const countParts: QueryParts = { binds: [] };
  let countSQL = `SELECT /* analytics:funnel-trace-count */ COUNT(DISTINCT trace_id) AS trace_count
  FROM span_observations`;
  countSQL += appendObservationScope(countParts, workspaceId, workstream, since, until);

  const rowsParts: QueryParts = { binds: [] };
  let rowsSQL = `SELECT /* analytics:funnel-spans */
    trace_id, span_id, CAST(started_at_ns AS TEXT) AS started_at_ns, kind, tool_name, status, name
  FROM span_observations`;
  rowsSQL += appendObservationScope(rowsParts, workspaceId, workstream, since, until);
  rowsSQL += `\n  ORDER BY trace_id ASC, started_at_ns ASC, span_id ASC`;

  return { countSQL, countBinds: countParts.binds, rowsSQL, rowsBinds: rowsParts.binds };
}

export interface FunnelSpanRow {
  trace_id: string;
  span_id: string;
  started_at_ns: string;
  kind: string;
  tool_name: string | null;
  status: string;
  name: string;
}

function matchesStep(row: FunnelSpanRow, step: FunnelStepPredicate): boolean {
  if (step.kind !== undefined && row.kind !== step.kind) return false;
  if (step.tool_name !== undefined && row.tool_name !== step.tool_name) return false;
  if (step.status !== undefined && row.status !== step.status) return false;
  if (step.name_contains !== undefined && !row.name.includes(step.name_contains)) return false;
  return true;
}

/** Ascending by (started_at_ns, span_id) — re-sorted regardless of DB row order, same discipline as sortObservations. */
function sortSpansAscending(rows: readonly FunnelSpanRow[]): FunnelSpanRow[] {
  return [...rows].sort((a, b) => {
    const left = BigInt(a.started_at_ns);
    const right = BigInt(b.started_at_ns);
    if (left !== right) return left < right ? -1 : 1;
    if (a.span_id === b.span_id) return 0;
    return a.span_id < b.span_id ? -1 : 1;
  });
}

/**
 * How many leading steps (0..steps.length) one trace's spans satisfy in
 * order. A trace passes step N at the EARLIEST span matching step N's
 * predicate at/after the span that satisfied step N-1 — "at" (>=, not
 * strictly after) so one instantaneous span can satisfy two consecutive
 * steps at once. Ties at the same started_at_ns break on span_id ascending,
 * so the walk is a total order and never depends on input order.
 * `spans` must already be sorted ascending by (started_at_ns, span_id).
 */
function evaluateTrace(spans: readonly FunnelSpanRow[], steps: readonly FunnelStepPredicate[]): number {
  let anchorNs: bigint | null = null;
  let anchorId = "";
  let reached = 0;
  for (const step of steps) {
    let matched = false;
    for (const row of spans) {
      const ns = BigInt(row.started_at_ns);
      if (anchorNs !== null) {
        if (ns < anchorNs) continue;
        if (ns === anchorNs && row.span_id < anchorId) continue;
      }
      if (!matchesStep(row, step)) continue;
      anchorNs = ns;
      anchorId = row.span_id;
      matched = true;
      break; // spans is sorted ascending, so the first match is the earliest.
    }
    if (!matched) break;
    reached += 1;
  }
  return reached;
}

export interface FunnelComputation {
  matchedTraces: number[];
  tracesScanned: number;
}

/** Group rows by trace_id, evaluate each trace independently, and tally per-step matches. */
export function computeFunnel(
  rows: readonly FunnelSpanRow[],
  steps: readonly FunnelStepPredicate[],
): FunnelComputation {
  const byTrace = new Map<string, FunnelSpanRow[]>();
  for (const row of rows) {
    const list = byTrace.get(row.trace_id);
    if (list) list.push(row);
    else byTrace.set(row.trace_id, [row]);
  }
  const matchedTraces = new Array<number>(steps.length).fill(0);
  for (const spans of byTrace.values()) {
    const reached = evaluateTrace(sortSpansAscending(spans), steps);
    for (let i = 0; i < reached; i++) matchedTraces[i] += 1;
  }
  return { matchedTraces, tracesScanned: byTrace.size };
}

export interface FunnelStepResult {
  step: number;
  predicate: FunnelStepPredicate;
  matched_traces: number;
  conversion_from_first: number;
  conversion_from_previous: number;
}

export function buildFunnelResponse(
  steps: readonly FunnelStepPredicate[],
  matchedTraces: readonly number[],
  tracesScanned: number,
): { traces_scanned: number; steps: FunnelStepResult[] } {
  const first = matchedTraces[0] ?? 0;
  return {
    traces_scanned: tracesScanned,
    steps: steps.map((predicate, i) => ({
      step: i + 1,
      predicate,
      matched_traces: matchedTraces[i] ?? 0,
      conversion_from_first: ratio(matchedTraces[i] ?? 0, first),
      conversion_from_previous: ratio(matchedTraces[i] ?? 0, i === 0 ? first : matchedTraces[i - 1] ?? 0),
    })),
  };
}

async function postFunnel(request: Request, env: AnalyticsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;

  const bodyRead = await readRequestBody(request, FUNNEL_BODY_BYTES);
  if (!bodyRead.ok) {
    const error = bodyRead.status === 413 ? "request body exceeds 8 KiB" : "request body is not readable UTF-8";
    return json(bodyRead.status, { error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRead.text);
  } catch {
    return json(400, { error: "request body is not valid JSON" });
  }
  const validated = validateFunnelRequest(parsed);
  if (!validated.ok) return json(validated.status, { error: validated.error });
  const { steps, workstream, since, until } = validated.value;

  const scope = buildFunnelScopeQuery(auth.device.workspaceId, workstream, since, until);
  const countRow = await env.DB.prepare(scope.countSQL).bind(...scope.countBinds).first<{ trace_count: number }>();
  const traceCount = countRow?.trace_count ?? 0;
  if (traceCount > MAX_FUNNEL_TRACES) {
    return json(400, {
      error: `funnel scope matches more than ${MAX_FUNNEL_TRACES} traces`,
      code: "funnel_scope_too_large",
      guidance: "narrow the request with since/until or a workstream filter",
      traces_matched: traceCount,
      max_traces: MAX_FUNNEL_TRACES,
    });
  }

  const rows = await env.DB.prepare(scope.rowsSQL).bind(...scope.rowsBinds).all<FunnelSpanRow>();
  const { matchedTraces, tracesScanned } = computeFunnel(rows.results, steps);
  return json(200, buildFunnelResponse(steps, matchedTraces, tracesScanned));
}

// -- routing ------------------------------------------------------------------

/**
 * Route the analytics surface. Returns null for paths this module does not
 * own so index.ts continues its sequential dispatch; a known path with the
 * wrong method also returns null and lands on the platform 404 (house rule).
 */
export async function handleAnalyticsRoute(request: Request, env: AnalyticsEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/v1/analytics/series") {
    return await getSeries(request, env);
  }
  if (request.method === "GET" && pathname === "/v1/analytics/summary") {
    return await getSummary(request, env);
  }
  if (request.method === "POST" && pathname === "/v1/analytics/funnel") {
    return await postFunnel(request, env);
  }
  return null;
}
