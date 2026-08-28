// Dashboards-as-config — versioned JSON documents, PR-reviewable, with a
// CI dry-run endpoint and read-only share links (parity rows 39 and 40).
//
// The whole module rests on one idea: a dashboard IS a JSON document. There
// are no widget rows, no layout table, no partial updates. A config is
// validated, canonicalized, hashed, and appended as an immutable version;
// reading a version back returns those exact bytes. That makes the three
// things rows 39/40 ask for the same thing:
//
//   * export      = GET /v1/dashboards/{id}/versions/{n}   (the bytes)
//   * import      = POST /v1/dashboards[/{id}/versions]    (the same bytes)
//   * CI dry-run  = POST /v1/dashboards/validate           (no writes at all)
//
// so a config committed under deploy/dashboards/*.json and a config served
// by the API are the same artifact, digest included.
//
// Trust boundary for share links (also documented in docs/dashboards.md):
// GET /v1/shared/dashboards/{token} is UNAUTHENTICATED and returns the
// dashboard's latest config document and nothing else. It serves no
// observations, events, costs, workspace names or member data. A shared
// dashboard renders in a viewer's browser by running its widget queries
// against the authenticated read APIs with the viewer's own credentials — a
// share link hands out the layout, never the data.

import { authenticate, hasCapability, sha256Hex, type DeviceBinding, type DeviceLookup } from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
  scopeDenial,
} from "./ingest";
import { monotonicFactory } from "ulid";

// -- ids ---------------------------------------------------------------------
// ids.ts is owned by another module; dashboards mint their own prefixed ULIDs
// the same way (monotonic factory, so ids allocated in one millisecond stay
// lexically ordered).

const nextULID = monotonicFactory();

function newDashboardID(): string {
  return `dsh_${nextULID()}`;
}

// One source for the id shape, so a path pattern can never drift from the
// id validator (or from the CHECK constraint in migration 0008).
const DASHBOARD_ID_BODY = "dsh_[0-7][0-9A-HJKMNP-TV-Z]{25}";
export const DASHBOARD_ID_PATTERN = new RegExp(`^${DASHBOARD_ID_BODY}$`);
/** `dshtok_` + 43 base64url chars (32 random bytes, unpadded). */
export const SHARE_TOKEN_PATTERN = /^dshtok_[A-Za-z0-9_-]{43}$/;

const DASHBOARD_PATH = new RegExp(`^/v1/dashboards/(${DASHBOARD_ID_BODY})$`);
const VERSIONS_PATH = new RegExp(`^/v1/dashboards/(${DASHBOARD_ID_BODY})/versions$`);
const VERSION_PATH = new RegExp(`^/v1/dashboards/(${DASHBOARD_ID_BODY})/versions/(\\d{1,9})$`);
const SHARES_PATH = new RegExp(`^/v1/dashboards/(${DASHBOARD_ID_BODY})/shares$`);
const SHARES_REVOKE_PATH = new RegExp(`^/v1/dashboards/(${DASHBOARD_ID_BODY})/shares/revoke$`);
// Deliberately permissive on shape: SHARE_TOKEN_PATTERN does the real check,
// so a near-miss token takes the same 404 path as an unknown one.
const SHARED_PATH = /^\/v1\/shared\/dashboards\/([A-Za-z0-9_-]{1,128})$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `dshtok_` + 256 bits of CSPRNG entropy, base64url (43 chars, unpadded). */
export function newShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `dshtok_${bytesToBase64Url(bytes)}`;
}

// -- env ---------------------------------------------------------------------

export interface DashboardsEnv {
  DB: D1DatabaseLike;
  /**
   * Absolute origin used to build the one-time share URL. Set in
   * wrangler.toml [vars]; falls back to the request's own origin so local
   * development and preview deploys still emit a usable link.
   */
  APP_ORIGIN?: string;
}

// -- config schema (hfg.dashboard.v1) ----------------------------------------

export const DASHBOARD_SCHEMA_VERSION = "hfg.dashboard.v1";

/** Hard ceilings. Every one of these is a fail-closed rejection, not a clamp. */
export const MAX_WIDGETS = 24;
export const MAX_VARIABLES = 8;
export const MAX_CONFIG_BYTES = 32 * 1024;
export const MAX_FUNNEL_STEPS = 8;
export const MIN_FUNNEL_STEPS = 2;
/** Layout grid: 12 columns wide, unbounded rows (capped so y stays sane). */
export const GRID_COLUMNS = 12;
export const MAX_ROW = 999;
export const MAX_WIDGET_HEIGHT = 24;
/** Request body cap for config routes: the config ceiling plus JSON framing. */
const MAX_BODY_BYTES = 64 * 1024;

export type WidgetType = "series" | "summary" | "funnel" | "table";

export const WIDGET_TYPES: readonly WidgetType[] = Object.freeze([
  "funnel",
  "series",
  "summary",
  "table",
] as const);

/**
 * Query sources. These mirror the authenticated read surfaces a widget runs
 * against client-side (`/v1/observations`, `/v1/sessions`, `/v1/events` once
 * the analytics rollups land), so a config validated here names a query the
 * viewer's browser can actually issue.
 */
export const QUERY_SOURCES: readonly string[] = Object.freeze([
  "events",
  "observations",
  "sessions",
] as const);

/**
 * Metrics. `cost_amount` is a decimal STRING at the API edge (money is never
 * a float on this platform); it is named here only as the quantity a widget
 * plots.
 */
export const QUERY_METRICS: readonly string[] = Object.freeze([
  "cost_amount",
  "count",
  "error_rate",
  "p50_duration_ms",
  "p95_duration_ms",
  "token_in",
  "token_out",
] as const);

/** Series bucket widths. Fixed set so a widget can never ask for an unbounded scan. */
export const QUERY_INTERVALS: readonly string[] = Object.freeze([
  "1d",
  "1h",
  "30m",
  "5m",
  "6h",
] as const);

/** Grouping dimensions, mirroring the columns of the span_observations wide table. */
export const QUERY_GROUP_BY: readonly string[] = Object.freeze([
  "agent",
  "kind",
  "model",
  "provider",
  "session_id",
  "status",
  "tool_name",
  "workstream_id",
] as const);

/** Filter keys, mirroring the `/v1/observations` query-string filters. */
export const QUERY_FILTER_KEYS: readonly string[] = Object.freeze([
  "agent",
  "fingerprint",
  "has",
  "kind",
  "model",
  "provider",
  "session",
  "status",
  "tool",
  "workstream",
] as const);

export interface DashboardVariable {
  name: string;
  default: string;
}

export interface DashboardFunnelStep {
  name: string;
  filters?: Record<string, string>;
}

export interface DashboardQuery {
  source: string;
  metric: string;
  interval?: string;
  group_by?: string;
  filters?: Record<string, string>;
  since?: string;
  until?: string;
  limit?: number;
  steps?: DashboardFunnelStep[];
}

export interface DashboardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  id: string;
  title: string;
  type: WidgetType;
  query: DashboardQuery;
  layout: DashboardLayout;
}

export interface DashboardConfig {
  schema: typeof DASHBOARD_SCHEMA_VERSION;
  name: string;
  variables: DashboardVariable[];
  widgets: DashboardWidget[];
}

/** One precise, machine-readable validation failure. */
export interface DashboardConfigError {
  /** JSON-pointer-ish location, e.g. `widgets[2].query.interval`. */
  path: string;
  message: string;
}

export type DashboardValidation =
  | { ok: true; config: DashboardConfig; canonical: string; byteLength: number }
  | { ok: false; errors: DashboardConfigError[] };

const WIDGET_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const VARIABLE_REFERENCE_PATTERN = /^\$([a-z][a-z0-9_]{0,31})$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Relative window, e.g. `-24h`, `-7d`, `-30m`. */
const RELATIVE_TIME_PATTERN = /^-\d{1,4}(m|h|d)$/;

const MAX_NAME_CHARS = 120;
const MAX_TITLE_CHARS = 120;
const MAX_FILTER_VALUE_CHARS = 256;
const MAX_STEP_NAME_CHARS = 80;
/** Bound the error list so a hostile document cannot make a 400 body huge. */
const MAX_REPORTED_ERRORS = 50;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Collects errors instead of throwing on the first: CI wants the whole list. */
class ErrorSink {
  readonly errors: DashboardConfigError[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  get empty(): boolean {
    return this.errors.length === 0;
  }
}

/**
 * Reject any key not in `allowed`. Unknown keys are an error, never ignored:
 * silently dropping a misspelled `widths` would ship a dashboard that renders
 * differently from what the author reviewed.
 */
function rejectUnknownKeys(
  sink: ErrorSink,
  path: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record).sort()) {
    if (!permitted.has(key)) {
      sink.add(path === "" ? key : `${path}.${key}`, `unknown key (allowed: ${[...allowed].sort().join(", ")})`);
    }
  }
}

function requireString(
  sink: ErrorSink,
  path: string,
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") {
    sink.add(path, "must be a string");
    return null;
  }
  if (value.length === 0) {
    sink.add(path, "must not be empty");
    return null;
  }
  if (value.length > maxChars) {
    sink.add(path, `must be at most ${maxChars} characters`);
    return null;
  }
  return value;
}

function requireEnum(
  sink: ErrorSink,
  path: string,
  value: unknown,
  allowed: readonly string[],
): string | null {
  if (typeof value !== "string" || !allowed.includes(value)) {
    sink.add(path, `must be one of ${[...allowed].sort().join(", ")}`);
    return null;
  }
  return value;
}

function requireInteger(
  sink: ErrorSink,
  path: string,
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    sink.add(path, "must be an integer");
    return null;
  }
  if (value < min || value > max) {
    sink.add(path, `must be between ${min} and ${max}`);
    return null;
  }
  return value;
}

/** Variable references (`$name`) must name a declared variable. */
function checkVariableReference(
  sink: ErrorSink,
  path: string,
  value: string,
  declared: ReadonlySet<string>,
): void {
  const match = VARIABLE_REFERENCE_PATTERN.exec(value);
  if (match === null) {
    if (value.startsWith("$")) {
      sink.add(path, "malformed variable reference; use $name with a lowercase snake_case name");
    }
    return;
  }
  if (!declared.has(match[1])) {
    sink.add(path, `references undeclared variable $${match[1]}`);
  }
}

function validateFilters(
  sink: ErrorSink,
  path: string,
  value: unknown,
  declared: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    sink.add(path, "must be an object");
    return undefined;
  }
  rejectUnknownKeys(sink, path, value, QUERY_FILTER_KEYS);
  const filters: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    if (!QUERY_FILTER_KEYS.includes(key)) continue;
    const raw = value[key];
    const asString = requireString(sink, `${path}.${key}`, raw, MAX_FILTER_VALUE_CHARS);
    if (asString === null) continue;
    checkVariableReference(sink, `${path}.${key}`, asString, declared);
    filters[key] = asString;
  }
  return filters;
}

const TIME_BOUND_HELP =
  "must be an RFC 3339 timestamp, a relative window like -24h, or a $variable reference";

function validateTimeBound(
  sink: ErrorSink,
  path: string,
  value: unknown,
  declared: ReadonlySet<string>,
): string | undefined {
  const asString = requireString(sink, path, value, 64);
  if (asString === null) return undefined;
  if (asString.startsWith("$")) {
    checkVariableReference(sink, path, asString, declared);
    return asString;
  }
  if (!RFC3339_PATTERN.test(asString) && !RELATIVE_TIME_PATTERN.test(asString)) {
    sink.add(path, TIME_BOUND_HELP);
    return undefined;
  }
  return asString;
}

const QUERY_KEYS = [
  "filters",
  "group_by",
  "interval",
  "limit",
  "metric",
  "since",
  "source",
  "steps",
  "until",
] as const;

/**
 * Per-type query rules. A widget type does not merely *suggest* a shape — a
 * `summary` carrying an `interval` is rejected rather than silently ignored,
 * because the author clearly meant a `series` and would otherwise ship a
 * dashboard that quietly drops their bucketing.
 */
const QUERY_RULES: Record<WidgetType, { required: readonly string[]; forbidden: readonly string[] }> = {
  series: { required: ["interval"], forbidden: ["steps"] },
  summary: { required: [], forbidden: ["group_by", "interval", "steps"] },
  funnel: { required: ["steps"], forbidden: ["group_by", "interval"] },
  table: { required: ["group_by"], forbidden: ["interval", "steps"] },
};

function validateFunnelSteps(
  sink: ErrorSink,
  path: string,
  value: unknown,
  declared: ReadonlySet<string>,
): DashboardFunnelStep[] | undefined {
  if (!Array.isArray(value)) {
    sink.add(path, "must be an array");
    return undefined;
  }
  if (value.length < MIN_FUNNEL_STEPS || value.length > MAX_FUNNEL_STEPS) {
    sink.add(path, `must contain between ${MIN_FUNNEL_STEPS} and ${MAX_FUNNEL_STEPS} steps`);
    return undefined;
  }
  const steps: DashboardFunnelStep[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const stepPath = `${path}[${index}]`;
    const entry: unknown = value[index];
    if (!isPlainObject(entry)) {
      sink.add(stepPath, "must be an object");
      continue;
    }
    rejectUnknownKeys(sink, stepPath, entry, ["filters", "name"]);
    const name = requireString(sink, `${stepPath}.name`, entry.name, MAX_STEP_NAME_CHARS);
    if (name !== null) {
      if (seen.has(name)) sink.add(`${stepPath}.name`, "duplicate step name");
      seen.add(name);
    }
    const step: DashboardFunnelStep = { name: name ?? "" };
    if (entry.filters !== undefined) {
      const filters = validateFilters(sink, `${stepPath}.filters`, entry.filters, declared);
      if (filters !== undefined) step.filters = filters;
    }
    steps.push(step);
  }
  return steps;
}

function validateQuery(
  sink: ErrorSink,
  path: string,
  value: unknown,
  type: WidgetType | null,
  declared: ReadonlySet<string>,
): DashboardQuery | undefined {
  if (!isPlainObject(value)) {
    sink.add(path, "must be an object");
    return undefined;
  }
  rejectUnknownKeys(sink, path, value, QUERY_KEYS);

  const source = requireEnum(sink, `${path}.source`, value.source, QUERY_SOURCES);
  const metric = requireEnum(sink, `${path}.metric`, value.metric, QUERY_METRICS);

  const query: DashboardQuery = { source: source ?? "", metric: metric ?? "" };

  if (value.interval !== undefined) {
    const interval = requireEnum(sink, `${path}.interval`, value.interval, QUERY_INTERVALS);
    if (interval !== null) query.interval = interval;
  }
  if (value.group_by !== undefined) {
    const groupBy = requireEnum(sink, `${path}.group_by`, value.group_by, QUERY_GROUP_BY);
    if (groupBy !== null) query.group_by = groupBy;
  }
  if (value.filters !== undefined) {
    const filters = validateFilters(sink, `${path}.filters`, value.filters, declared);
    if (filters !== undefined) query.filters = filters;
  }
  if (value.since !== undefined) {
    const since = validateTimeBound(sink, `${path}.since`, value.since, declared);
    if (since !== undefined) query.since = since;
  }
  if (value.until !== undefined) {
    const until = validateTimeBound(sink, `${path}.until`, value.until, declared);
    if (until !== undefined) query.until = until;
  }
  if (value.limit !== undefined) {
    const limit = requireInteger(sink, `${path}.limit`, value.limit, 1, 1000);
    if (limit !== null) query.limit = limit;
  }
  if (value.steps !== undefined) {
    const steps = validateFunnelSteps(sink, `${path}.steps`, value.steps, declared);
    if (steps !== undefined) query.steps = steps;
  }

  if (type !== null) {
    const rules = QUERY_RULES[type];
    for (const key of rules.required) {
      if (value[key] === undefined) sink.add(`${path}.${key}`, `is required for a ${type} widget`);
    }
    for (const key of rules.forbidden) {
      if (value[key] !== undefined) sink.add(`${path}.${key}`, `is not allowed on a ${type} widget`);
    }
    // A funnel counts entities through steps; any other metric would be a
    // category error rather than a differently-shaped answer.
    if (type === "funnel" && metric !== null && metric !== "count") {
      sink.add(`${path}.metric`, "must be count for a funnel widget");
    }
  }

  return query;
}

function validateLayout(sink: ErrorSink, path: string, value: unknown): DashboardLayout | undefined {
  if (!isPlainObject(value)) {
    sink.add(path, "must be an object");
    return undefined;
  }
  rejectUnknownKeys(sink, path, value, ["h", "w", "x", "y"]);
  const x = requireInteger(sink, `${path}.x`, value.x, 0, GRID_COLUMNS - 1);
  const y = requireInteger(sink, `${path}.y`, value.y, 0, MAX_ROW);
  const w = requireInteger(sink, `${path}.w`, value.w, 1, GRID_COLUMNS);
  const h = requireInteger(sink, `${path}.h`, value.h, 1, MAX_WIDGET_HEIGHT);
  if (x === null || y === null || w === null || h === null) return undefined;
  if (x + w > GRID_COLUMNS) {
    sink.add(path, `x + w must not exceed the ${GRID_COLUMNS}-column grid`);
    return undefined;
  }
  return { x, y, w, h };
}

function validateVariables(sink: ErrorSink, value: unknown): DashboardVariable[] {
  if (!Array.isArray(value)) {
    sink.add("variables", "must be an array");
    return [];
  }
  if (value.length > MAX_VARIABLES) {
    // Return rather than fall through: a document with a million entries must
    // not cost a million validations and a million error objects.
    sink.add("variables", `must contain at most ${MAX_VARIABLES} variables`);
    return [];
  }
  const variables: DashboardVariable[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const path = `variables[${index}]`;
    const entry: unknown = value[index];
    if (!isPlainObject(entry)) {
      sink.add(path, "must be an object");
      continue;
    }
    rejectUnknownKeys(sink, path, entry, ["default", "name"]);
    const name = requireString(sink, `${path}.name`, entry.name, 32);
    if (name !== null && !VARIABLE_NAME_PATTERN.test(name)) {
      sink.add(`${path}.name`, "must be lowercase snake_case starting with a letter");
      continue;
    }
    if (name !== null && seen.has(name)) {
      sink.add(`${path}.name`, "duplicate variable name");
      continue;
    }
    // `default` is a string even when it stands for a number: keeping one type
    // means substitution into a query string is total, and canonical bytes
    // never depend on JSON number formatting.
    if (typeof entry.default !== "string") {
      sink.add(`${path}.default`, "must be a string");
      continue;
    }
    if (entry.default.length > MAX_FILTER_VALUE_CHARS) {
      sink.add(`${path}.default`, `must be at most ${MAX_FILTER_VALUE_CHARS} characters`);
      continue;
    }
    if (name === null) continue;
    seen.add(name);
    variables.push({ name, default: entry.default });
  }
  return variables;
}

function validateWidgets(
  sink: ErrorSink,
  value: unknown,
  declared: ReadonlySet<string>,
): DashboardWidget[] {
  if (!Array.isArray(value)) {
    sink.add("widgets", "must be an array");
    return [];
  }
  if (value.length === 0) {
    sink.add("widgets", "must contain at least one widget");
    return [];
  }
  if (value.length > MAX_WIDGETS) {
    // Same bound as variables: stop before doing unbounded work for a
    // document that is already rejected.
    sink.add("widgets", `must contain at most ${MAX_WIDGETS} widgets`);
    return [];
  }

  const widgets: DashboardWidget[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const path = `widgets[${index}]`;
    const entry: unknown = value[index];
    if (!isPlainObject(entry)) {
      sink.add(path, "must be an object");
      continue;
    }
    rejectUnknownKeys(sink, path, entry, ["id", "layout", "query", "title", "type"]);

    const id = requireString(sink, `${path}.id`, entry.id, 40);
    if (id !== null && !WIDGET_ID_PATTERN.test(id)) {
      sink.add(`${path}.id`, "must be lowercase kebab-case starting with a letter");
    } else if (id !== null) {
      if (seenIds.has(id)) sink.add(`${path}.id`, `duplicate widget id "${id}"`);
      seenIds.add(id);
    }

    const title = requireString(sink, `${path}.title`, entry.title, MAX_TITLE_CHARS);
    const type = requireEnum(sink, `${path}.type`, entry.type, WIDGET_TYPES) as WidgetType | null;
    const query = validateQuery(sink, `${path}.query`, entry.query, type, declared);
    const layout = validateLayout(sink, `${path}.layout`, entry.layout);

    if (id === null || title === null || type === null || query === undefined || layout === undefined) {
      continue;
    }
    widgets.push({ id, title, type, query, layout });
  }
  return widgets;
}

/**
 * Strict, fail-closed validation of an `hfg.dashboard.v1` document.
 *
 * Every rejection is reported with a precise path so the CI dry-run
 * (`POST /v1/dashboards/validate`) can point a reviewer at the offending
 * line. Validation is pure: it touches no database, no clock, and no
 * randomness, so the same document always produces the same verdict and the
 * same canonical bytes.
 */
export function validateDashboardConfig(doc: unknown): DashboardValidation {
  const sink = new ErrorSink();

  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ path: "", message: "config must be a JSON object" }] };
  }
  rejectUnknownKeys(sink, "", doc, ["name", "schema", "variables", "widgets"]);

  if (doc.schema !== DASHBOARD_SCHEMA_VERSION) {
    sink.add("schema", `must be "${DASHBOARD_SCHEMA_VERSION}"`);
  }
  const name = requireString(sink, "name", doc.name, MAX_NAME_CHARS);

  // Variables are validated first: widget queries may reference them, and an
  // undeclared reference is an error rather than an empty substitution.
  const variables = doc.variables === undefined ? [] : validateVariables(sink, doc.variables);
  if (doc.variables === undefined) sink.add("variables", "is required (use [] when unused)");
  const declared = new Set(variables.map((variable) => variable.name));

  const widgets = doc.widgets === undefined ? [] : validateWidgets(sink, doc.widgets, declared);
  if (doc.widgets === undefined) sink.add("widgets", "is required");

  if (!sink.empty) {
    const sorted = [...sink.errors].sort((a, b) =>
      a.path === b.path ? compareStrings(a.message, b.message) : compareStrings(a.path, b.path),
    );
    const errors = sorted.slice(0, MAX_REPORTED_ERRORS);
    if (sorted.length > errors.length) {
      // Say so rather than truncating silently: a CI run must never read a
      // capped list as the complete list.
      errors.push({
        path: "",
        message: `${sorted.length - errors.length} further errors were not reported`,
      });
    }
    return { ok: false, errors };
  }

  // Rebuilt from validated parts rather than echoed: an accepted config is
  // exactly the fields this validator understands, in canonical encoding.
  const config: DashboardConfig = {
    schema: DASHBOARD_SCHEMA_VERSION,
    name: name ?? "",
    variables,
    widgets,
  };
  const canonical = canonicalJsonStringify(config);
  const byteLength = utf8Bytes(canonical);
  if (byteLength > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `canonical config is ${byteLength} bytes; the limit is ${MAX_CONFIG_BYTES}`,
        },
      ],
    };
  }
  return { ok: true, config, canonical, byteLength };
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// -- JSON responses ------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Serve stored canonical bytes verbatim. This is the export path: the body is
 * the config document itself (not an envelope around it), so
 * `curl ... > deploy/dashboards/x.json` produces a file that re-validates and
 * re-imports byte-for-byte, and the ETag is the digest recorded at write time.
 */
function configResponse(canonicalConfig: string, version: number, sha256: string): Response {
  return new Response(canonicalConfig, {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      etag: `"sha256-${sha256}"`,
      "x-hfg-dashboard-version": String(version),
      // Share URLs are unlisted secrets, not public pages; a crawler that
      // finds one must not put it in an index.
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// -- device lookup (mirrors index.ts's deviceLookup adapter) -------------------

interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

const DEVICE_BY_TOKEN_SQL = `
  /* dashboards:device-by-token */
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

type AuthOutcome =
  | { ok: true; device: DeviceBinding }
  | { ok: false; response: Response };

async function authorize(
  request: Request,
  env: DashboardsEnv,
  capability: "ingest" | "read",
): Promise<AuthOutcome> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { ok: false, response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, capability),
  });
  if (denial !== null) return { ok: false, response: json(denial.status, { error: denial.error }) };
  return { ok: true, device: auth.device };
}

// -- request bodies --------------------------------------------------------------

/**
 * Three-way body read. "Absent" and "malformed" must stay distinguishable:
 * the revoke route treats an absent body as "revoke every live link", and
 * collapsing a syntax error into that would turn a typo into a mass
 * revocation.
 */
type BodyRead =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "invalid" };

async function readJsonObject(request: Request): Promise<BodyRead> {
  const body = await readRequestBody(request, MAX_BODY_BYTES);
  if (!body.ok) return { kind: "invalid" };
  if (body.text.trim().length === 0) return { kind: "absent" };
  try {
    const value: unknown = JSON.parse(body.text);
    return isPlainObject(value) ? { kind: "object", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/** Read a body that MUST be a JSON object; absent counts as invalid. */
async function requireJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readJsonObject(request);
  return body.kind === "object" ? body.value : null;
}

function invalidConfigResponse(errors: DashboardConfigError[]): Response {
  return json(400, { error: "dashboard config is invalid", valid: false, errors });
}

// -- POST /v1/dashboards/validate (CI dry-run) ------------------------------------

/**
 * The CI dry-run entry point (row 40). It reads nothing, writes nothing, and
 * never touches a workspace row — a pull request can validate every config
 * under deploy/dashboards/ with one device token and no side effects.
 */
async function validateConfigRoute(request: Request, env: DashboardsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  const body = await requireJsonObject(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  if (body.config === undefined) return json(400, { error: "config is required" });

  const result = validateDashboardConfig(body.config);
  if (!result.ok) return invalidConfigResponse(result.errors);

  const contentSha256 = await sha256Hex(result.canonical);
  return json(200, {
    valid: true,
    content_sha256: contentSha256,
    canonical_bytes: result.byteLength,
    widget_count: result.config.widgets.length,
  });
}

// -- POST /v1/dashboards ------------------------------------------------------------

const INSERT_DASHBOARD_SQL = `
  /* dashboards:insert-dashboard */
  INSERT INTO dashboards (id, workspace_id, name, created_at)
  VALUES (?1, ?2, ?3, ?4)`;

const INSERT_VERSION_SQL = `
  /* dashboards:insert-version */
  INSERT INTO dashboard_versions
    (dashboard_id, workspace_id, version, config, content_sha256, created_by_device, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

async function createDashboard(request: Request, env: DashboardsEnv): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  const body = await requireJsonObject(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  if (body.config === undefined) return json(400, { error: "config is required" });

  const result = validateDashboardConfig(body.config);
  if (!result.ok) return invalidConfigResponse(result.errors);

  // `name` is optional and defaults to the config's own name. When supplied it
  // must agree with it: the row label and the exported document are the same
  // label, and the schema enforces that for every later version too.
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name !== result.config.name) {
      return json(400, { error: "name must equal config.name" });
    }
  }

  const id = newDashboardID();
  const now = Math.floor(Date.now() / 1000);
  const contentSha256 = await sha256Hex(result.canonical);

  // One D1 batch: a dashboard row without a version 1 would be an empty
  // resource that GET could not answer, so the two commit together.
  await env.DB.batch([
    env.DB.prepare(INSERT_DASHBOARD_SQL).bind(id, auth.device.workspaceId, result.config.name, now),
    env.DB.prepare(INSERT_VERSION_SQL).bind(
      id,
      auth.device.workspaceId,
      1,
      result.canonical,
      contentSha256,
      auth.device.deviceId,
      now,
    ),
  ]);

  return json(201, {
    dashboard: {
      id,
      name: result.config.name,
      version: 1,
      content_sha256: contentSha256,
      created_at: now,
    },
  });
}

// -- POST /v1/dashboards/{id}/versions ------------------------------------------------

const LATEST_VERSION_SQL = `
  /* dashboards:latest-version */
  SELECT MAX(version) AS version
  FROM dashboard_versions
  WHERE workspace_id = ?1 AND dashboard_id = ?2`;

const DASHBOARD_ROW_SQL = `
  /* dashboards:read-dashboard */
  SELECT id, name, created_at
  FROM dashboards
  WHERE workspace_id = ?1 AND id = ?2`;

interface DashboardRow {
  id: string;
  name: string;
  created_at: number;
}

/**
 * Workspace-scoped read. A dashboard in another workspace and a dashboard
 * that never existed are indistinguishable here (both null → 404), which is
 * the platform's scopeDenial rule applied at the query.
 */
async function readDashboard(
  env: DashboardsEnv,
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardRow | null> {
  return env.DB.prepare(DASHBOARD_ROW_SQL).bind(workspaceId, dashboardId).first<DashboardRow>();
}

async function appendVersion(
  request: Request,
  env: DashboardsEnv,
  dashboardId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  const body = await requireJsonObject(request);
  if (body === null) return json(400, { error: "request body must be a JSON object" });
  if (body.config === undefined) return json(400, { error: "config is required" });

  const result = validateDashboardConfig(body.config);
  if (!result.ok) return invalidConfigResponse(result.errors);

  const dashboard = await readDashboard(env, auth.device.workspaceId, dashboardId);
  if (dashboard === null) return json(404, { error: "not found" });
  if (result.config.name !== dashboard.name) {
    return json(400, { error: "config.name must match the dashboard name" });
  }

  const latest = await env.DB.prepare(LATEST_VERSION_SQL)
    .bind(auth.device.workspaceId, dashboardId)
    .first<{ version: number | null }>();
  const nextVersion = (latest?.version ?? 0) + 1;

  const now = Math.floor(Date.now() / 1000);
  const contentSha256 = await sha256Hex(result.canonical);

  try {
    await env.DB.prepare(INSERT_VERSION_SQL)
      .bind(
        dashboardId,
        auth.device.workspaceId,
        nextVersion,
        result.canonical,
        contentSha256,
        auth.device.deviceId,
        now,
      )
      .run();
  } catch (error) {
    // Lost a race: another writer already claimed this version number. The
    // primary key and the dense-sequence trigger both reject the loser, and
    // the caller must re-read the latest version before retrying — silently
    // bumping to N+2 here would let a concurrent edit vanish.
    //
    // The 409 is only issued once the version is confirmed to exist. Any
    // other write failure rethrows into index.ts's catch-all (500) rather
    // than being mislabelled as a conflict.
    const winner = await env.DB.prepare(LATEST_VERSION_SQL)
      .bind(auth.device.workspaceId, dashboardId)
      .first<{ version: number | null }>();
    if ((winner?.version ?? 0) >= nextVersion) {
      return json(409, {
        error: "dashboard version already exists; re-read the latest version and retry",
      });
    }
    throw error;
  }

  return json(201, {
    dashboard: {
      id: dashboardId,
      name: dashboard.name,
      version: nextVersion,
      content_sha256: contentSha256,
      created_at: now,
    },
  });
}

// -- GET /v1/dashboards ---------------------------------------------------------------

interface DashboardListRow {
  id: string;
  name: string;
  created_at: number;
  latest_version: number | null;
  updated_at: number | null;
}

// `updated_at` is derived (the latest version's created_at) rather than a
// stored column: dashboards rows are immutable, so a mutable timestamp on
// them would be a second source of truth for the same fact.
const LIST_DASHBOARDS_SQL = `
  /* dashboards:list */
  SELECT d.id AS id, d.name AS name, d.created_at AS created_at,
         MAX(v.version) AS latest_version,
         MAX(v.created_at) AS updated_at
  FROM dashboards AS d
  LEFT JOIN dashboard_versions AS v
    ON v.workspace_id = d.workspace_id AND v.dashboard_id = d.id
  WHERE d.workspace_id = ?1
  GROUP BY d.id, d.name, d.created_at
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT ?2`;

const LIST_DASHBOARDS_AFTER_SQL = `
  /* dashboards:list-after */
  SELECT d.id AS id, d.name AS name, d.created_at AS created_at,
         MAX(v.version) AS latest_version,
         MAX(v.created_at) AS updated_at
  FROM dashboards AS d
  LEFT JOIN dashboard_versions AS v
    ON v.workspace_id = d.workspace_id AND v.dashboard_id = d.id
  WHERE d.workspace_id = ?1
    AND (d.created_at < ?2 OR (d.created_at = ?2 AND d.id < ?3))
  GROUP BY d.id, d.name, d.created_at
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT ?4`;

function compareDashboardRows(a: DashboardListRow, b: DashboardListRow): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  return compareStrings(b.id, a.id);
}

async function listDashboards(request: Request, env: DashboardsEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1;

  const result =
    cursor === null
      ? await env.DB.prepare(LIST_DASHBOARDS_SQL)
          .bind(auth.device.workspaceId, fetchLimit)
          .all<DashboardListRow>()
      : await env.DB.prepare(LIST_DASHBOARDS_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<DashboardListRow>();

  // Re-sorted in the Worker so the page never depends on storage order.
  const sorted = [...result.results].sort(compareDashboardRows);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];

  return json(200, {
    items: items.map((row) => ({
      id: row.id,
      name: row.name,
      latest_version: row.latest_version ?? 0,
      updated_at: row.updated_at ?? row.created_at,
    })),
    next_cursor:
      sorted.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- GET /v1/dashboards/{id} -----------------------------------------------------------

interface VersionRow {
  version: number;
  config: string;
  content_sha256: string;
  created_by_device: string;
  created_at: number;
}

const LATEST_CONFIG_SQL = `
  /* dashboards:latest-config */
  SELECT version, config, content_sha256, created_by_device, created_at
  FROM dashboard_versions
  WHERE workspace_id = ?1 AND dashboard_id = ?2
  ORDER BY version DESC
  LIMIT 1`;

const VERSION_LIST_SQL = `
  /* dashboards:version-list */
  SELECT version, content_sha256, created_by_device, created_at
  FROM dashboard_versions
  WHERE workspace_id = ?1 AND dashboard_id = ?2
  ORDER BY version DESC
  LIMIT ?3`;

const SHARE_LIST_SQL = `
  /* dashboards:share-list */
  SELECT created_at, revoked_at
  FROM dashboard_shares
  WHERE workspace_id = ?1 AND dashboard_id = ?2
  ORDER BY created_at DESC`;

const MAX_LISTED_VERSIONS = 200;

async function getDashboard(
  request: Request,
  env: DashboardsEnv,
  dashboardId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  const dashboard = await readDashboard(env, auth.device.workspaceId, dashboardId);
  if (dashboard === null) return json(404, { error: "not found" });

  const [latest, versions, shares] = await Promise.all([
    env.DB.prepare(LATEST_CONFIG_SQL)
      .bind(auth.device.workspaceId, dashboardId)
      .first<VersionRow>(),
    env.DB.prepare(VERSION_LIST_SQL)
      .bind(auth.device.workspaceId, dashboardId, MAX_LISTED_VERSIONS)
      .all<Omit<VersionRow, "config">>(),
    env.DB.prepare(SHARE_LIST_SQL)
      .bind(auth.device.workspaceId, dashboardId)
      .all<{ created_at: number; revoked_at: number | null }>(),
  ]);
  if (latest === null) return json(404, { error: "not found" });

  return json(200, {
    dashboard: {
      id: dashboard.id,
      name: dashboard.name,
      latest_version: latest.version,
      created_at: dashboard.created_at,
      updated_at: latest.created_at,
    },
    // Parsed here (this response is a view, not the export). The byte-stable
    // artifact lives at /v1/dashboards/{id}/versions/{n}.
    config: JSON.parse(latest.config) as unknown,
    versions: [...versions.results]
      .sort((a, b) => b.version - a.version)
      .map((row) => ({
        version: row.version,
        content_sha256: row.content_sha256,
        created_by_device: row.created_by_device,
        created_at: row.created_at,
      })),
    // Content-free share metadata: the owner can see how many links exist and
    // whether they are live, but no token material is ever readable back.
    shares: [...shares.results]
      .sort((a, b) => b.created_at - a.created_at)
      .map((row) => ({ created_at: row.created_at, revoked_at: row.revoked_at })),
  });
}

// -- GET /v1/dashboards/{id}/versions/{n} ------------------------------------------------

const EXACT_VERSION_SQL = `
  /* dashboards:exact-version */
  SELECT version, config, content_sha256, created_by_device, created_at
  FROM dashboard_versions
  WHERE workspace_id = ?1 AND dashboard_id = ?2 AND version = ?3`;

async function getVersion(
  request: Request,
  env: DashboardsEnv,
  dashboardId: string,
  version: number,
): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if (!auth.ok) return auth.response;

  const row = await env.DB.prepare(EXACT_VERSION_SQL)
    .bind(auth.device.workspaceId, dashboardId, version)
    .first<VersionRow>();
  if (row === null) return json(404, { error: "not found" });

  return configResponse(row.config, row.version, row.content_sha256);
}

// -- POST /v1/dashboards/{id}/shares -------------------------------------------------------

const INSERT_SHARE_SQL = `
  /* dashboards:insert-share */
  INSERT INTO dashboard_shares (token_hash, dashboard_id, workspace_id, created_at)
  VALUES (?1, ?2, ?3, ?4)`;

function shareUrl(request: Request, env: DashboardsEnv, token: string): string {
  const origin = env.APP_ORIGIN ?? new URL(request.url).origin;
  return `${origin.replace(/\/+$/, "")}/v1/shared/dashboards/${token}`;
}

async function createShare(
  request: Request,
  env: DashboardsEnv,
  dashboardId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  const dashboard = await readDashboard(env, auth.device.workspaceId, dashboardId);
  if (dashboard === null) return json(404, { error: "not found" });

  const token = newShareToken();
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(INSERT_SHARE_SQL)
    .bind(tokenHash, dashboardId, auth.device.workspaceId, now)
    .run();

  return json(201, {
    share: { dashboard_id: dashboardId, created_at: now, revoked_at: null },
    share_url: shareUrl(request, env, token),
    token,
    warning: "Copy this share link now. Only its hash is stored; it cannot be shown again.",
  });
}

// -- POST /v1/dashboards/{id}/shares/revoke ---------------------------------------------------

const REVOKE_ALL_SHARES_SQL = `
  /* dashboards:revoke-all-shares */
  UPDATE dashboard_shares
  SET revoked_at = ?3
  WHERE dashboard_id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL
  RETURNING token_hash`;

const REVOKE_ONE_SHARE_SQL = `
  /* dashboards:revoke-one-share */
  UPDATE dashboard_shares
  SET revoked_at = ?4
  WHERE dashboard_id = ?1 AND workspace_id = ?2 AND token_hash = ?3 AND revoked_at IS NULL
  RETURNING token_hash`;

async function revokeShares(
  request: Request,
  env: DashboardsEnv,
  dashboardId: string,
): Promise<Response> {
  const auth = await authorize(request, env, "ingest");
  if (!auth.ok) return auth.response;

  // An absent body means "revoke every live link for this dashboard" — the
  // panic button, usable by someone who never held the token. A malformed
  // body is rejected rather than treated as absent: a typo must not become a
  // mass revocation.
  const body = await readJsonObject(request);
  if (body.kind === "invalid") {
    return json(400, { error: "request body must be a JSON object or empty" });
  }
  const token = body.kind === "object" ? body.value.token : undefined;
  if (token !== undefined && typeof token !== "string") {
    return json(400, { error: "token must be a string" });
  }

  const dashboard = await readDashboard(env, auth.device.workspaceId, dashboardId);
  if (dashboard === null) return json(404, { error: "not found" });

  const now = Math.floor(Date.now() / 1000);
  if (typeof token === "string") {
    if (!SHARE_TOKEN_PATTERN.test(token)) return json(404, { error: "not found" });
    const tokenHash = await sha256Hex(token);
    const revoked = await env.DB.prepare(REVOKE_ONE_SHARE_SQL)
      .bind(dashboardId, auth.device.workspaceId, tokenHash, now)
      .first<{ token_hash: string }>();
    if (revoked === null) return json(404, { error: "not found" });
    return json(200, { ok: true, revoked: 1 });
  }

  const revoked = await env.DB.prepare(REVOKE_ALL_SHARES_SQL)
    .bind(dashboardId, auth.device.workspaceId, now)
    .all<{ token_hash: string }>();
  return json(200, { ok: true, revoked: revoked.results.length });
}

// -- GET /v1/shared/dashboards/{token} (UNAUTHENTICATED) ---------------------------------------

const RESOLVE_SHARE_SQL = `
  /* dashboards:resolve-share */
  SELECT v.version AS version, v.config AS config, v.content_sha256 AS content_sha256
  FROM dashboard_shares AS s
  JOIN dashboard_versions AS v
    ON v.workspace_id = s.workspace_id AND v.dashboard_id = s.dashboard_id
  WHERE s.token_hash = ?1 AND s.revoked_at IS NULL
  ORDER BY v.version DESC
  LIMIT 1`;

/**
 * Resolve a share token to the dashboard's latest config — the only
 * unauthenticated route in this module.
 *
 * What crosses the boundary is one config document: widget titles, layout,
 * variable names, and the query shapes. What does NOT cross it is every piece
 * of workspace data — no observations, sessions, costs, event bodies,
 * workspace id, or member identity appear in the response, and the workspace
 * is never named. Whoever opens the link still needs their own credentials
 * for the read APIs before a single number renders.
 *
 * Unknown, malformed and revoked tokens are the same 404 with the same body,
 * so the endpoint never confirms that a token once existed.
 */
async function resolveShare(env: DashboardsEnv, token: string): Promise<Response> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return json(404, { error: "not found" });

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(RESOLVE_SHARE_SQL)
    .bind(tokenHash)
    .first<{ version: number; config: string; content_sha256: string }>();
  if (row === null) return json(404, { error: "not found" });

  return configResponse(row.config, row.version, row.content_sha256);
}

// -- routing ---------------------------------------------------------------------------------

/**
 * Route the dashboards-as-config HTTP surface. Returns null when this module
 * does not own the path (or owns the path but not this method — the
 * platform-wide catch-all in index.ts answers 404 for those).
 */
export async function handleDashboardsRoute(
  request: Request,
  env: DashboardsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === "/v1/dashboards") {
    if (request.method === "POST") return createDashboard(request, env);
    if (request.method === "GET") return listDashboards(request, env);
    return null;
  }

  // Checked before the {id} patterns; "validate" is not a dsh_ ULID, so the
  // two can never collide, but the explicit order documents the intent.
  if (pathname === "/v1/dashboards/validate") {
    if (request.method === "POST") return validateConfigRoute(request, env);
    return null;
  }

  const versionMatch = VERSION_PATH.exec(pathname);
  if (versionMatch !== null) {
    if (request.method !== "GET") return null;
    const version = Number(versionMatch[2]);
    // One URL per version: `/versions/0` and `/versions/007` are 404s, not
    // aliases, so a digest can never be quoted against two different paths.
    if (version < 1 || String(version) !== versionMatch[2]) {
      return json(404, { error: "not found" });
    }
    return getVersion(request, env, versionMatch[1], version);
  }

  const versionsMatch = VERSIONS_PATH.exec(pathname);
  if (versionsMatch !== null) {
    if (request.method === "POST") return appendVersion(request, env, versionsMatch[1]);
    return null;
  }

  const revokeMatch = SHARES_REVOKE_PATH.exec(pathname);
  if (revokeMatch !== null) {
    if (request.method === "POST") return revokeShares(request, env, revokeMatch[1]);
    return null;
  }

  const sharesMatch = SHARES_PATH.exec(pathname);
  if (sharesMatch !== null) {
    if (request.method === "POST") return createShare(request, env, sharesMatch[1]);
    return null;
  }

  const dashboardMatch = DASHBOARD_PATH.exec(pathname);
  if (dashboardMatch !== null) {
    if (request.method === "GET") return getDashboard(request, env, dashboardMatch[1]);
    return null;
  }

  const sharedMatch = SHARED_PATH.exec(pathname);
  if (sharedMatch !== null) {
    if (request.method === "GET") return resolveShare(env, sharedMatch[1]);
    return null;
  }

  return null;
}

/** Exported for tests and for the CLI/CI helper that lints in-repo configs. */
export const DASHBOARD_ID_REGEX = DASHBOARD_ID_PATTERN;
