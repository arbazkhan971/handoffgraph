// Hosted quality-loop read APIs (parity rows 27, 33-34, hosted halves):
// datasets x experiments and the versioned prompt store, served from the
// hosted spine so the debugger UI and dashboards can read what the local Go
// CLI records as append-only events.
//
// No migration. Every route here is a pure DERIVED VIEW recomputed at read
// time from existing event kinds (dataset.created, experiment.recorded,
// prompt.created, prompt.labeled, score.recorded) — the read-side mirror of
// internal/datasets, internal/prompts, and internal/scores in Go. Field
// names, required-field rules, and 'latest' resolution are copied from those
// packages; see the doc comment on each parse*Payload function for the exact
// Go semantics it mirrors and platform/test/quality.test.ts for payload
// fixtures copied byte-for-byte from the Go wire format.
//
// Determinism contract: single-pass materializers scan `events` ordered by
// seq (SELECT ... WHERE workspace_id=? AND kind [=|IN] (...) ORDER BY seq),
// parse each payload with Go's json.Unmarshal-into-struct type-coercion
// rules (absent/null field -> zero value; wrong JSON type -> the whole event
// is malformed), then re-sort the survivors by an explicit key so output
// order never depends on D1 storage order. A malformed payload never fails
// the request: it is skipped and counted in the response's `meta
// .skipped_malformed`, so one bad row can never 500 a listing (fail-closed
// per row, not per request).
//
// Scale: MAX_MATERIALIZE_ROWS bounds the scan. Beyond it the response still
// answers (never 500) but flags `meta.truncated` — a dedicated projection
// table (the span_observations pattern from observations.ts) is the correct
// scale fix once any workspace's dataset/prompt/score history outgrows a
// single-pass scan; that is out of scope for this wave.
//
// Deliberate divergences from the local Go reference implementation (see
// internal/webui/server.go, the local HTTP mirror of these same reads) are
// called out inline and summarized in the handoff report:
//   - prompt label resolution here is ordered by server-assigned `seq`
//     (ingestion order), not the payload's client-supplied `occurred_at`
//     (Go's SetAt) — seq is monotonic and authoritative on the hosted spine,
//     while occurred_at is client-supplied and can arrive out of order
//     (backfills, clock skew). This is an explicit product decision, not an
//     oversight.
//   - /v1/datasets and /v1/prompts expose a narrower field set than Go's
//     local webui (no event_id on datasets; no version ladder/latest_hash on
//     the prompts list — that detail lives behind /v1/prompts/show).
//   - experiments/scores list in the raw materializer's own ascending
//     (occurred_at, id) order, not the local webui's newest-first
//     presentation re-sort.
//   - /v1/scores adds a `provenance` field beyond the requested field list,
//     because the platform-wide invariant that an INFERRED score must never
//     render as an OBSERVED one cannot be honored by a hosted consumer that
//     cannot see provenance at all.
// All three are load-bearing enough to flag to a reviewer; see the handoff
// caveats for the full reasoning.

import {
  authenticate,
  hasCapability,
  type DeviceBinding,
  type DeviceLookup,
} from "./auth";
import type { D1DatabaseLike } from "./db";
import { scopeDenial } from "./ingest";

export interface QualityEnv {
  DB: D1DatabaseLike;
}

// -- bounds -------------------------------------------------------------------

/**
 * Row-scan ceiling per request, matching the order of magnitude already
 * established by artifacts.ts's EXPORT_MAX_EVENTS. The scan LIMIT itself is
 * set 400 rows beyond the cap purely so a single extra round trip can tell
 * "exactly at the cap" apart from "more rows exist beyond it": rows are
 * still only ever materialized up to MAX_MATERIALIZE_ROWS, and the surplus
 * is discarded after truncation is detected.
 */
export const MAX_MATERIALIZE_ROWS = 50_000;
const MATERIALIZE_OVERFLOW_BUFFER = 400;
const MATERIALIZE_SCAN_LIMIT = MAX_MATERIALIZE_ROWS + MATERIALIZE_OVERFLOW_BUFFER;
const TRUNCATION_NOTE =
  `row scan capped at ${MAX_MATERIALIZE_ROWS} events; results may be incomplete for ` +
  `this workspace. A dedicated projection table (the span_observations pattern) is ` +
  `the scale fix beyond this size.`;

const MAX_FILTER_BYTES = 256;
const UTF8_ENCODER = new TextEncoder();
function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return value.length > maxBytes || UTF8_ENCODER.encode(value).byteLength > maxBytes;
}

const SCORE_SOURCES = new Set(["human", "api", "evaluation", "detection"]);

// -- scan SQL -------------------------------------------------------------------

const SCAN_BY_ONE_KIND_SQL = `
  SELECT /* quality:scan-one-kind */ seq, raw_json
  FROM events
  WHERE workspace_id = ?1 AND kind = ?2
  ORDER BY seq
  LIMIT ?3`;

const SCAN_BY_TWO_KINDS_SQL = `
  SELECT /* quality:scan-two-kinds */ seq, raw_json
  FROM events
  WHERE workspace_id = ?1 AND kind IN (?2, ?3)
  ORDER BY seq
  LIMIT ?4`;

interface RawScanRow {
  seq: number;
  raw_json: string;
}

interface ScanResult {
  rows: RawScanRow[];
  truncated: boolean;
}

function boundRows(rows: RawScanRow[]): ScanResult {
  const truncated = rows.length > MAX_MATERIALIZE_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_MATERIALIZE_ROWS) : rows, truncated };
}

async function scanOneKind(
  db: D1DatabaseLike,
  workspaceId: string,
  kind: string,
): Promise<ScanResult> {
  const result = await db.prepare(SCAN_BY_ONE_KIND_SQL)
    .bind(workspaceId, kind, MATERIALIZE_SCAN_LIMIT)
    .all<RawScanRow>();
  return boundRows(result.results);
}

async function scanTwoKinds(
  db: D1DatabaseLike,
  workspaceId: string,
  kindA: string,
  kindB: string,
): Promise<ScanResult> {
  const result = await db.prepare(SCAN_BY_TWO_KINDS_SQL)
    .bind(workspaceId, kindA, kindB, MATERIALIZE_SCAN_LIMIT)
    .all<RawScanRow>();
  return boundRows(result.results);
}

// -- envelope parsing -----------------------------------------------------------

interface ScannedEvent {
  seq: number;
  event_id: string;
  kind: string;
  occurred_at: string;
  provenance: string | null;
  payload: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse one scanned row's raw_json back into the envelope fields the
 * materializers need. raw_json is server-canonicalized JSON we wrote
 * ourselves at ingest, so this should never fail in practice; it is still
 * treated as a fail-closed per-row skip (never a 500) rather than assumed
 * infallible, matching every other malformed-row path in this module.
 */
function parseScannedRow(row: RawScanRow): ScannedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.raw_json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const eventId = parsed.event_id;
  const kind = parsed.kind;
  const occurredAt = parsed.occurred_at;
  if (typeof eventId !== "string" || eventId === "") return null;
  if (typeof kind !== "string" || kind === "") return null;
  if (typeof occurredAt !== "string" || occurredAt === "") return null;
  const provenance = typeof parsed.provenance === "string" ? parsed.provenance : null;
  return { seq: row.seq, event_id: eventId, kind, occurred_at: occurredAt, provenance, payload: parsed.payload };
}

/** Chronological comparison key. occurred_at is already RFC3339-validated at
 *  ingest, so Date.parse is trusted rather than re-validated here; a plain
 *  string compare would not sort correctly across mixed timezone offsets the
 *  way Go's time.Time.Before does, which is why this exists at all. */
function occurredAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// -- typed-field helpers (mirror Go's json.Unmarshal-into-struct coercion) ------
//
// Go's encoding/json leaves a struct field at its zero value when the JSON
// key is absent OR explicitly null, but ERRORS the whole Unmarshal call (and
// therefore drops the whole event in Materialize) when the key is present
// with the WRONG JSON type. These helpers reproduce exactly that: `""`/`0`/
// `false`/`[]` for absent-or-null, the value itself for a type match, and
// `undefined` as the "malformed, skip this event" sentinel for a type
// mismatch. This is what makes e.g. `"value": 0.9` (a JSON number) malformed
// for a score payload whose wire contract says `value` is always a string.

function jsonStringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return undefined;
}

function jsonIntField(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined;
}

function jsonBoolField(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  return undefined;
}

function jsonArrayField(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return undefined;
}

function buildMeta(skippedMalformed: number, truncated: boolean): Record<string, unknown> {
  const meta: Record<string, unknown> = { skipped_malformed: skippedMalformed };
  if (truncated) {
    meta.truncated = true;
    meta.note = TRUNCATION_NOTE;
  }
  return meta;
}

// =============================================================================
// datasets — mirrors internal/datasets.Materialize (dataset.created)
// =============================================================================

export interface DatasetFile {
  name: string;
  hash: string;
  event_count: number;
}

export interface DatasetItem {
  seq: number;
  name: string;
  version: string;
  files: DatasetFile[];
  created_at: string;
}

/**
 * Mirrors datasets.Materialize's per-event unmarshal target
 * (`{name, version, files: [{name, hash, event_count}]}`) plus its guard
 * `p.Name == "" || p.Version == ""`. No per-file validation beyond type
 * safety: ValidateFile's size/UTF-8 checks are write-time only.
 */
function parseDatasetPayload(
  payload: unknown,
): { name: string; version: string; files: DatasetFile[] } | undefined {
  if (!isPlainObject(payload)) return undefined;
  const name = jsonStringField(payload.name);
  const version = jsonStringField(payload.version);
  const filesRaw = jsonArrayField(payload.files);
  if (name === undefined || version === undefined || filesRaw === undefined) return undefined;
  const files: DatasetFile[] = [];
  for (const entry of filesRaw) {
    if (!isPlainObject(entry)) return undefined;
    const fileName = jsonStringField(entry.name);
    const fileHash = jsonStringField(entry.hash);
    const eventCount = jsonIntField(entry.event_count);
    if (fileName === undefined || fileHash === undefined || eventCount === undefined) return undefined;
    files.push({ name: fileName, hash: fileHash, event_count: eventCount });
  }
  if (name === "" || version === "") return undefined;
  return { name, version, files };
}

export async function materializeDatasets(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<{ items: DatasetItem[]; skippedMalformed: number; truncated: boolean }> {
  const { rows, truncated } = await scanOneKind(db, workspaceId, "dataset.created");
  const items: DatasetItem[] = [];
  let skippedMalformed = 0;
  for (const row of rows) {
    const scanned = parseScannedRow(row);
    if (scanned === null) {
      skippedMalformed++;
      continue;
    }
    const parsed = parseDatasetPayload(scanned.payload);
    if (parsed === undefined) {
      skippedMalformed++;
      continue;
    }
    items.push({
      seq: scanned.seq,
      name: parsed.name,
      version: parsed.version,
      files: parsed.files,
      created_at: scanned.occurred_at,
    });
  }
  // "name-then-version sorted" per the route contract. version is a content
  // hash string (opaque), so a plain string compare is the whole rule; Array
  // .sort is stable, so any residual tie (an exact name+version replay)
  // keeps scan (seq) order.
  items.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return 0;
  });
  return { items, skippedMalformed, truncated };
}

// =============================================================================
// experiments — mirrors internal/datasets.MaterializeExperiments + Compare
// (experiment.recorded)
// =============================================================================

export interface ExampleResult {
  name: string;
  hash: string;
  events: number;
  traces: number;
  spans: number;
  p0_detections: number;
  status: string;
}

export interface ExperimentRecord {
  seq: number;
  event_id: string;
  dataset: string;
  version: string;
  passed: boolean;
  results: ExampleResult[];
  created_at: string;
}

/**
 * Mirrors MaterializeExperiments, which unmarshals the payload directly into
 * an ExperimentRecord (so the wire payload the CLI writes actually carries
 * dead `event_id`/`created_at` keys from marshaling the zero-valued struct
 * fields — see dataset_cmd.go's experimentRunCmd). Both are IGNORED here and
 * always taken from the event envelope instead, exactly as Go's
 * `r.EventID = ev.EventID; r.CreatedAt = ev.OccurredAt` overwrite does.
 * Guard: `r.Dataset == "" || r.Version == ""`.
 */
function parseExperimentPayload(
  payload: unknown,
): { dataset: string; version: string; passed: boolean; results: ExampleResult[] } | undefined {
  if (!isPlainObject(payload)) return undefined;
  const dataset = jsonStringField(payload.dataset);
  const version = jsonStringField(payload.version);
  const passed = jsonBoolField(payload.passed);
  const resultsRaw = jsonArrayField(payload.results);
  if (dataset === undefined || version === undefined || passed === undefined || resultsRaw === undefined) {
    return undefined;
  }
  const results: ExampleResult[] = [];
  for (const entry of resultsRaw) {
    if (!isPlainObject(entry)) return undefined;
    const name = jsonStringField(entry.name);
    const hash = jsonStringField(entry.hash);
    const events = jsonIntField(entry.events);
    const traces = jsonIntField(entry.traces);
    const spans = jsonIntField(entry.spans);
    const p0Detections = jsonIntField(entry.p0_detections);
    const status = jsonStringField(entry.status);
    if (
      name === undefined || hash === undefined || events === undefined || traces === undefined ||
      spans === undefined || p0Detections === undefined || status === undefined
    ) {
      return undefined;
    }
    results.push({ name, hash, events, traces, spans, p0_detections: p0Detections, status });
  }
  if (dataset === "" || version === "") return undefined;
  return { dataset, version, passed, results };
}

export async function materializeExperiments(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<{ items: ExperimentRecord[]; skippedMalformed: number; truncated: boolean }> {
  const { rows, truncated } = await scanOneKind(db, workspaceId, "experiment.recorded");
  const items: ExperimentRecord[] = [];
  let skippedMalformed = 0;
  for (const row of rows) {
    const scanned = parseScannedRow(row);
    if (scanned === null) {
      skippedMalformed++;
      continue;
    }
    const parsed = parseExperimentPayload(scanned.payload);
    if (parsed === undefined) {
      skippedMalformed++;
      continue;
    }
    items.push({
      seq: scanned.seq,
      event_id: scanned.event_id,
      dataset: parsed.dataset,
      version: parsed.version,
      passed: parsed.passed,
      results: parsed.results,
      created_at: scanned.occurred_at,
    });
  }
  // Mirrors MaterializeExperiments' own sort (ascending occurred_at, then
  // event_id) — the raw materializer's order, not the local webui's
  // newest-first presentation re-sort (a UI-layer choice in a different
  // file). occurred_at is compared chronologically, not as a string: RFC3339
  // strings with different timezone offsets are not lexicographically
  // monotonic with real time.
  items.sort((a, b) => {
    const at = occurredAtMs(a.created_at);
    const bt = occurredAtMs(b.created_at);
    if (at !== bt) return at - bt;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return { items, skippedMalformed, truncated };
}

function experimentSummary(row: ExperimentRecord): Record<string, unknown> {
  let passedCount = 0;
  let failedCount = 0;
  for (const result of row.results) {
    if (result.status === "ok") passedCount++;
    else failedCount++;
  }
  return {
    id: row.event_id,
    dataset: row.dataset,
    version: row.version,
    passed_count: passedCount,
    failed_count: failedCount,
    created_at: row.created_at,
  };
}

export interface Comparison {
  file: string;
  from_status: string;
  to_status: string;
  from_p0: number;
  to_p0: number;
  regression: boolean;
}

function rankStatus(status: string): number {
  if (status === "ok") return 0;
  if (status === "detections") return 1;
  return 2;
}

/**
 * Mirrors datasets.Compare(a, b) exactly, including its quirk: b's example
 * names are iterated WITH duplicates (one pass per occurrence of a name in
 * b.Results, not per unique name), and each occurrence looks up b's own data
 * via a first-match scan (Go's `indexOf`) rather than by its own index — so
 * a run with a duplicate example name emits one comparison row per
 * occurrence, all reading the FIRST such entry's status/p0. This can only
 * arise from a hand-crafted or corrupted experiment.recorded payload (the
 * CLI's own runner always produces unique names from a dataset's file
 * manifest), so it is mirrored for fidelity rather than "fixed" — a fix here
 * would silently disagree with what `handoffgraph experiment compare`
 * prints locally for the same data.
 *
 * Only examples present in BOTH runs are emitted: an example missing from
 * the baseline (a) is skipped, matching the `if !existed { continue }` guard
 * in Go — a new example is a new dataset version, not a regression.
 */
export function compareExperimentRuns(a: ExperimentRecord, b: ExperimentRecord): Comparison[] {
  const baseline = new Map<string, ExampleResult>();
  for (const result of a.results) baseline.set(result.name, result);
  const names = b.results.map((result) => result.name).sort();
  const items: Comparison[] = [];
  for (const name of names) {
    const candidate = b.results.find((result) => result.name === name);
    const base = baseline.get(name);
    if (candidate === undefined || base === undefined) continue;
    items.push({
      file: name,
      from_status: base.status,
      to_status: candidate.status,
      from_p0: base.p0_detections,
      to_p0: candidate.p0_detections,
      regression:
        rankStatus(candidate.status) > rankStatus(base.status) ||
        candidate.p0_detections > base.p0_detections,
    });
  }
  return items;
}

// =============================================================================
// prompts — mirrors internal/prompts.Materialize + Resolve (prompt.created,
// prompt.labeled)
// =============================================================================

export interface PromptVersionRecord {
  seq: number;
  version: number;
  body: string;
  hash: string;
  created_by: string;
  created_at: string;
}

export interface PromptLabelRecord {
  seq: number;
  label: string;
  version: number;
  set_at: string;
}

export interface PromptAggregate {
  name: string;
  versions: PromptVersionRecord[];
  labelEvents: PromptLabelRecord[];
}

/** Mirrors prompt.created's guard: `p.Name == "" || p.Version <= 0`. */
function parsePromptCreatedPayload(
  payload: unknown,
): { name: string; version: number; body: string; hash: string; created_by: string } | undefined {
  if (!isPlainObject(payload)) return undefined;
  const name = jsonStringField(payload.name);
  const version = jsonIntField(payload.version);
  const body = jsonStringField(payload.body);
  const hash = jsonStringField(payload.hash);
  const createdBy = jsonStringField(payload.created_by);
  if (
    name === undefined || version === undefined || body === undefined ||
    hash === undefined || createdBy === undefined
  ) {
    return undefined;
  }
  if (name === "" || version <= 0) return undefined;
  return { name, version, body, hash, created_by: createdBy };
}

/**
 * Mirrors prompt.labeled's guard: `l.Name == "" || l.Label == ""`. Go does
 * NOT additionally require a positive version here (unlike the write-time
 * validator in NewLabeledEvent) — a labeled event with version 0 is still
 * materialized as a LabelRef with Version 0, so this intentionally has no
 * version check either.
 */
function parsePromptLabeledPayload(
  payload: unknown,
): { name: string; label: string; version: number } | undefined {
  if (!isPlainObject(payload)) return undefined;
  const name = jsonStringField(payload.name);
  const label = jsonStringField(payload.label);
  const version = jsonIntField(payload.version);
  if (name === undefined || label === undefined || version === undefined) return undefined;
  if (name === "" || label === "") return undefined;
  return { name, label, version };
}

export async function materializePromptEvents(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<{ byName: Map<string, PromptAggregate>; skippedMalformed: number; truncated: boolean }> {
  const { rows, truncated } = await scanTwoKinds(db, workspaceId, "prompt.created", "prompt.labeled");
  const byName = new Map<string, PromptAggregate>();
  let skippedMalformed = 0;

  function aggregateFor(name: string): PromptAggregate {
    let aggregate = byName.get(name);
    if (aggregate === undefined) {
      aggregate = { name, versions: [], labelEvents: [] };
      byName.set(name, aggregate);
    }
    return aggregate;
  }

  for (const row of rows) {
    const scanned = parseScannedRow(row);
    if (scanned === null) {
      skippedMalformed++;
      continue;
    }
    if (scanned.kind === "prompt.created") {
      const parsed = parsePromptCreatedPayload(scanned.payload);
      if (parsed === undefined) {
        skippedMalformed++;
        continue;
      }
      aggregateFor(parsed.name).versions.push({
        seq: scanned.seq,
        version: parsed.version,
        body: parsed.body,
        hash: parsed.hash,
        created_by: parsed.created_by,
        created_at: scanned.occurred_at,
      });
    } else if (scanned.kind === "prompt.labeled") {
      const parsed = parsePromptLabeledPayload(scanned.payload);
      if (parsed === undefined) {
        skippedMalformed++;
        continue;
      }
      // Pushed in scan (seq) order; resolveLabels below relies on that order
      // for "last wins".
      aggregateFor(parsed.name).labelEvents.push({
        seq: scanned.seq,
        label: parsed.label,
        version: parsed.version,
        set_at: scanned.occurred_at,
      });
    } else {
      // The scan is filtered to these two kinds at the SQL level; a third
      // kind should never appear. Fail closed rather than silently drop it
      // uncounted if it somehow does.
      skippedMalformed++;
    }
  }

  for (const aggregate of byName.values()) {
    // Ascending by version number; seq breaks a tie deterministically. A tie
    // (two prompt.created events claiming the same version number for one
    // name) is an out-of-band write race the CLI's own `next := latest+1`
    // numbering avoids in normal use — Go's sort.Slice has no documented
    // tie-break there (it is not sort.SliceStable), so this is a considered
    // improvement on an edge case Go itself leaves undefined, not a bug-for-
    // bug mirror.
    aggregate.versions.sort((a, b) => (a.version !== b.version ? a.version - b.version : a.seq - b.seq));
  }

  return { byName, skippedMalformed, truncated };
}

export function latestVersion(aggregate: PromptAggregate): number {
  let max = 0;
  for (const version of aggregate.versions) {
    if (version.version > max) max = version.version;
  }
  return max;
}

/**
 * `latest` resolves to the newest version once any version exists, exactly
 * like Go's Resolve(). Every other label resolves to whichever
 * prompt.labeled event for that (name, label) pair has the HIGHEST seq —
 * labelEvents accumulate in scan (seq-ascending) order, so a plain forward
 * overwrite is "last wins" by seq. This is the one deliberate divergence
 * from Go's Resolve(), which orders by the payload's own occurred_at
 * (SetAt) instead; see the module doc comment for why seq is authoritative
 * on the hosted spine.
 */
export function resolveLabels(aggregate: PromptAggregate): Map<string, number> {
  const resolved = new Map<string, number>();
  const latest = latestVersion(aggregate);
  if (latest > 0) resolved.set("latest", latest);
  for (const labelEvent of aggregate.labelEvents) resolved.set(labelEvent.label, labelEvent.version);
  return resolved;
}

// =============================================================================
// scores — mirrors internal/scores.Materialize (score.recorded)
// =============================================================================

export interface ScoreRecord {
  seq: number;
  event_id: string;
  occurred_at: string;
  provenance: string | null;
  name: string;
  data_type: string;
  value: string;
  target_type: string;
  target_id: string;
  source: string;
  comment: string;
}

/**
 * Mirrors scores.fromEvent: a payload struct unmarshal with NO additional
 * required-field checks (unlike datasets/experiments/prompts, `Materialize`
 * here only rejects a JSON shape it cannot unmarshal at all — an empty
 * `name`, an unrecognized `data_type`/`source`, or a `target_id` with the
 * wrong prefix are all accepted at read time; those are write-time-only
 * checks in scores.Validate). `value` is exposed exactly as the wire string
 * (Go's canonical on-the-wire encoding keeps NUMERIC/CATEGORY/BOOLEAN all as
 * strings so the payload round-trips without float-formatting drift) —
 * never re-parsed into a JS number, so no precision is ever at risk.
 */
function parseScorePayload(
  payload: unknown,
): Omit<ScoreRecord, "seq" | "event_id" | "occurred_at" | "provenance"> | undefined {
  if (!isPlainObject(payload)) return undefined;
  const name = jsonStringField(payload.name);
  const dataType = jsonStringField(payload.data_type);
  const value = jsonStringField(payload.value);
  const targetType = jsonStringField(payload.target_type);
  const targetId = jsonStringField(payload.target_id);
  const source = jsonStringField(payload.source);
  const comment = jsonStringField(payload.comment);
  if (
    name === undefined || dataType === undefined || value === undefined || targetType === undefined ||
    targetId === undefined || source === undefined || comment === undefined
  ) {
    return undefined;
  }
  return { name, data_type: dataType, value, target_type: targetType, target_id: targetId, source, comment };
}

export async function materializeScores(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<{ items: ScoreRecord[]; skippedMalformed: number; truncated: boolean }> {
  const { rows, truncated } = await scanOneKind(db, workspaceId, "score.recorded");
  const items: ScoreRecord[] = [];
  let skippedMalformed = 0;
  for (const row of rows) {
    const scanned = parseScannedRow(row);
    if (scanned === null) {
      skippedMalformed++;
      continue;
    }
    const parsed = parseScorePayload(scanned.payload);
    if (parsed === undefined) {
      skippedMalformed++;
      continue;
    }
    items.push({
      seq: scanned.seq,
      event_id: scanned.event_id,
      occurred_at: scanned.occurred_at,
      provenance: scanned.provenance,
      ...parsed,
    });
  }
  // Mirrors scores.Materialize's own sort: ascending (occurred_at, score_id)
  // where score_id is the recording event's id.
  items.sort((a, b) => {
    const at = occurredAtMs(a.occurred_at);
    const bt = occurredAtMs(b.occurred_at);
    if (at !== bt) return at - bt;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return { items, skippedMalformed, truncated };
}

// -- device plane + response plumbing (each route module owns its own copy) ---

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
      return {
        deviceId: record.id,
        workspaceId: record.workspace_id,
        tokenHash: record.token_hash,
        capabilities:
          record.capabilities === null
            ? []
            : record.capabilities.split(",").map((c) => c.trim()).filter((c) => c.length > 0),
        revokedAt: record.revoked_at,
      };
    },
  };
}

async function authorize(
  request: Request,
  env: QualityEnv,
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

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- GET /v1/datasets -----------------------------------------------------------

async function listDatasets(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const { items, skippedMalformed, truncated } = await materializeDatasets(env.DB, auth.device.workspaceId);
  return json(200, {
    items: items.map((item) => ({
      name: item.name,
      version: item.version,
      example_count: item.files.length,
      content_hash: item.version,
      created_at: item.created_at,
    })),
    next_cursor: null,
    meta: buildMeta(skippedMalformed, truncated),
  });
}

// -- GET /v1/experiments ----------------------------------------------------------

async function listExperiments(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const datasetFilter = url.searchParams.get("dataset") ?? "";
  if (datasetFilter !== "" && exceedsUtf8Bytes(datasetFilter, MAX_FILTER_BYTES)) {
    return json(400, { error: `dataset must be at most ${MAX_FILTER_BYTES} UTF-8 bytes` });
  }
  const { items, skippedMalformed, truncated } = await materializeExperiments(env.DB, auth.device.workspaceId);
  const filtered = datasetFilter === "" ? items : items.filter((item) => item.dataset === datasetFilter);
  return json(200, {
    items: filtered.map(experimentSummary),
    next_cursor: null,
    meta: buildMeta(skippedMalformed, truncated),
  });
}

// -- GET /v1/experiments/compare?a=&b= -------------------------------------------

async function compareExperiments(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const aId = url.searchParams.get("a") ?? "";
  const bId = url.searchParams.get("b") ?? "";
  if (aId === "" || bId === "") {
    return json(400, { error: "missing required query parameters: a and b" });
  }
  const { items: runs, skippedMalformed, truncated } = await materializeExperiments(
    env.DB,
    auth.device.workspaceId,
  );
  const a = runs.find((run) => run.event_id === aId);
  const b = runs.find((run) => run.event_id === bId);
  if (a === undefined || b === undefined) {
    // Scoped to this workspace's own materialized runs, so an id from a
    // foreign workspace is indistinguishable from an unknown id — both 404
    // without ever confirming which case it was.
    return json(404, { error: "experiment run(s) not found" });
  }
  const items = compareExperimentRuns(a, b);
  const regressions = items.filter((item) => item.regression).length;
  return json(200, {
    a: experimentSummary(a),
    b: experimentSummary(b),
    regressions,
    items,
    meta: buildMeta(skippedMalformed, truncated),
  });
}

// -- GET /v1/prompts --------------------------------------------------------------

async function listPrompts(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const { byName, skippedMalformed, truncated } = await materializePromptEvents(
    env.DB,
    auth.device.workspaceId,
  );
  const names = [...byName.keys()].sort();
  const items = names.map((name) => {
    const aggregate = byName.get(name);
    if (aggregate === undefined) throw new Error("quality: prompt aggregate vanished mid-request");
    const resolved = resolveLabels(aggregate);
    const labels = [...resolved.keys()].sort().map((label) => ({
      label,
      version: resolved.get(label) as number,
    }));
    return {
      name,
      version_count: aggregate.versions.length,
      latest_version: latestVersion(aggregate),
      labels,
    };
  });
  return json(200, { items, next_cursor: null, meta: buildMeta(skippedMalformed, truncated) });
}

// -- GET /v1/prompts/show?name=&version= -----------------------------------------

async function showPrompt(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "";
  if (name === "") return json(400, { error: "missing required query parameter: name" });
  if (exceedsUtf8Bytes(name, MAX_FILTER_BYTES)) {
    return json(400, { error: `name must be at most ${MAX_FILTER_BYTES} UTF-8 bytes` });
  }
  let want = 0; // 0 means "whatever `latest` resolves to", matching the local webui default
  const rawVersion = url.searchParams.get("version");
  if (rawVersion !== null && rawVersion !== "") {
    const parsed = Number(rawVersion);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return json(400, { error: `invalid version "${rawVersion}"` });
    }
    want = parsed;
  }

  const { byName, skippedMalformed, truncated } = await materializePromptEvents(
    env.DB,
    auth.device.workspaceId,
  );
  const aggregate = byName.get(name);
  if (aggregate === undefined) return json(404, { error: "prompt not found" });

  const resolved = resolveLabels(aggregate);
  if (want === 0) want = resolved.get("latest") ?? 0;

  let match: PromptVersionRecord | undefined;
  for (const version of aggregate.versions) {
    if (version.version === want) match = version; // last match wins; see materializePromptEvents' seq tiebreak
  }
  if (match === undefined) return json(404, { error: "prompt version not found" });

  const labels = [...resolved.entries()]
    .filter(([, version]) => version === match.version)
    .map(([label]) => label)
    .sort();

  const body: Record<string, unknown> = {
    name,
    version: match.version,
    body: match.body,
    hash: match.hash,
    created_at: match.created_at,
    labels,
    latest_version: latestVersion(aggregate),
    version_count: aggregate.versions.length,
    meta: buildMeta(skippedMalformed, truncated),
  };
  if (match.created_by !== "") body.created_by = match.created_by;
  return json(200, body);
}

// -- GET /v1/scores?target=&source= ------------------------------------------------

async function listScores(request: Request, env: QualityEnv): Promise<Response> {
  const auth = await authorize(request, env, "read");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const targetFilter = url.searchParams.get("target") ?? "";
  if (targetFilter !== "" && exceedsUtf8Bytes(targetFilter, MAX_FILTER_BYTES)) {
    return json(400, { error: `target must be at most ${MAX_FILTER_BYTES} UTF-8 bytes` });
  }
  const sourceFilter = url.searchParams.get("source") ?? "";
  if (sourceFilter !== "" && !SCORE_SOURCES.has(sourceFilter)) {
    return json(400, { error: `source must be one of ${[...SCORE_SOURCES].join(", ")}` });
  }
  const { items, skippedMalformed, truncated } = await materializeScores(env.DB, auth.device.workspaceId);
  const filtered = items.filter(
    (item) =>
      (targetFilter === "" || item.target_id === targetFilter) &&
      (sourceFilter === "" || item.source === sourceFilter),
  );
  return json(200, {
    items: filtered.map((item) => ({
      name: item.name,
      data_type: item.data_type,
      value: item.value,
      target_type: item.target_type,
      target_id: item.target_id,
      source: item.source,
      occurred_at: item.occurred_at,
      // Additive beyond the requested field list: see the module doc
      // comment for why provenance is load-bearing here.
      ...(item.provenance !== null ? { provenance: item.provenance } : {}),
    })),
    next_cursor: null,
    meta: buildMeta(skippedMalformed, truncated),
  });
}

// -- routing ----------------------------------------------------------------------

/**
 * Route the hosted quality-loop read surface. Returns null for paths this
 * module does not own so index.ts continues its delegation chain; a known
 * path with the wrong method also returns null and lands on the platform
 * 404 (house rule — see observations.ts).
 */
export async function handleQualityRoute(request: Request, env: QualityEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/v1/datasets") return await listDatasets(request, env);
  if (request.method === "GET" && pathname === "/v1/experiments") return await listExperiments(request, env);
  if (request.method === "GET" && pathname === "/v1/experiments/compare") {
    return await compareExperiments(request, env);
  }
  if (request.method === "GET" && pathname === "/v1/prompts") return await listPrompts(request, env);
  if (request.method === "GET" && pathname === "/v1/prompts/show") return await showPrompt(request, env);
  if (request.method === "GET" && pathname === "/v1/scores") return await listScores(request, env);
  return null;
}
