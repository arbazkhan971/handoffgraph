// Object-store artifact tiering, batch export, and derived-model retention.
//
// Three surfaces, one rule: the event spine is authoritative and untouchable.
//
//   compaction  post-hoc sweep that copies runs of `events` rows into compacted
//               JSONL objects on R2 (artifacts/<workspace_id>/<id>.jsonl) and
//               indexes them in D1 (artifact_file_list). It NEVER deletes or
//               mutates `events`: the object is a derived cold copy that lets
//               DERIVED tables be slimmed later, nothing more. There is no
//               ingest hook — the compactor reads D1 after the fact.
//   exports     POST /v1/exports writes a bounded NDJSON extract to
//               exports/<workspace_id>/<export_id>.ndjson and records a manifest
//               row. Execution is synchronous in-request today; see
//               executeExport for the Workflows note.
//   retention   a per-workspace TTL that applies ONLY to rebuildable read
//               models. The spine and the artifact index are never swept.
//
// Determinism: every page of rows is re-sorted by seq before it is encoded, and
// object bytes are canonical JSON, so the same rows always produce the same
// object with the same content hash. Object keys are derived from
// (workspace_id, min_seq, max_seq), so a re-run rewrites the same key with the
// same bytes instead of orphaning a second copy.

import { monotonicFactory } from "ulid";

import { authenticate, deviceLookup, hasCapability, sha256Hex, type DeviceBinding } from "./auth";
import type { D1DatabaseLike } from "./db";
import {
  WORKSTREAM_ID_PATTERN,
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  readRequestBody,
  scopeDenial,
  type Validation,
} from "./ingest";

// -- Cloudflare bindings (structural: plain-object fakes satisfy these) -------

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectLike {
  readonly key: string;
  readonly size?: number;
}

/**
 * Only the members this module reads. `body` is optional so a fake can return
 * just `text()`; the download handler streams `body` when present and falls
 * back to the buffered text otherwise.
 */
export interface R2ObjectBodyLike {
  readonly body?: ReadableStream | null;
  readonly size?: number;
  text(): Promise<string>;
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated?: boolean;
  cursor?: string;
}

export interface R2ListOptionsLike {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: R2PutOptionsLike): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
  list(options: R2ListOptionsLike): Promise<R2ListResultLike>;
}

/** BODIES is optional so the Worker still type-checks before the bucket exists. */
export interface ArtifactsEnv {
  DB: D1DatabaseLike;
  BODIES?: R2BucketLike;
}

// -- tunables ----------------------------------------------------------------

/**
 * Compaction triggers, count/age style: a pending run of spine rows is flushed
 * once it is old enough OR large enough. Both dimensions are needed — an age
 * trigger alone starves a busy workspace of object turnover, a size trigger
 * alone leaves a quiet workspace with an uncompacted tail forever. (The
 * age/size trigger pair is a long-standing idea in log-structured stores; the
 * values below are ours, picked for D1 row budgets and the Worker CPU limit.)
 */
export const COMPACTION_AGE_SECONDS = 600;
export const COMPACTION_SIZE_BYTES = 262_144; // 256 KiB of pending raw_json
export const COMPACTION_MAX_EVENTS_PER_OBJECT = 500;
export const COMPACTION_MAX_OBJECTS_PER_RUN = 20;
export const COMPACTION_MAX_WORKSPACES_PER_RUN = 25;

/** Bounds for the synchronous export executor (see executeExport). */
export const EXPORT_PAGE_SIZE = 500;
export const EXPORT_MAX_EVENTS = 50_000;
export const EXPORT_MAX_BYTES = 8_388_608; // 8 MiB of NDJSON
export const MAX_EXPORT_REQUEST_BYTES = 8_192;

/**
 * Retention floor. Anything shorter would delete read models inside the window
 * a human needs to debug a live incident, and derived rebuilds are not free.
 */
export const RETENTION_MIN_TTL_DAYS = 7;
export const RETENTION_MAX_TTL_DAYS = 3_650;
export const RETENTION_MAX_WORKSPACES_PER_RUN = 200;

const SECONDS_PER_DAY = 86_400;
const UTF8 = new TextEncoder();
const nextULID = monotonicFactory();

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- SQL ---------------------------------------------------------------------

const COMPACTION_CANDIDATES_SQL = `
  /* artifacts:compaction-candidates */
  SELECT events.workspace_id AS workspace_id,
         MIN(events.seq) AS min_seq,
         COUNT(*) AS pending_events,
         SUM(LENGTH(CAST(events.raw_json AS BLOB))) AS pending_bytes,
         MIN(events.ingested_at) AS oldest_ingested_at
  FROM events
  LEFT JOIN (
    SELECT workspace_id, MAX(max_seq) AS watermark
    FROM artifact_file_list
    GROUP BY workspace_id
  ) AS compacted ON compacted.workspace_id = events.workspace_id
  WHERE events.seq > COALESCE(compacted.watermark, 0)
  GROUP BY events.workspace_id
  HAVING pending_bytes >= ?1 OR oldest_ingested_at <= ?2
  ORDER BY events.workspace_id
  LIMIT ?3`;

const COMPACTION_PAGE_SQL = `
  /* artifacts:compaction-page */
  SELECT seq, workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
         session_id, native_session_id, provider, kind, provenance, content_hash,
         ingested_at, raw_json
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2
  ORDER BY seq
  LIMIT ?3`;

const INSERT_ARTIFACT_SQL = `
  /* artifacts:insert-file-list */
  INSERT OR IGNORE INTO artifact_file_list
    (workspace_id, object_key, event_count, byte_size, min_seq, max_seq,
     min_occurred_at, max_occurred_at, content_sha256, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`;

const EXPORT_PAGE_FULL_SQL = `
  /* artifacts:export-page-full */
  SELECT seq, workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
         session_id, native_session_id, provider, kind, provenance, content_hash,
         ingested_at, raw_json
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2
  ORDER BY seq
  LIMIT ?3`;

const EXPORT_PAGE_WORKSTREAM_SQL = `
  /* artifacts:export-page-workstream */
  SELECT seq, workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
         session_id, native_session_id, provider, kind, provenance, content_hash,
         ingested_at, raw_json
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2 AND workstream_id = ?3
  ORDER BY seq
  LIMIT ?4`;

const EXPORT_PAGE_RANGE_SQL = `
  /* artifacts:export-page-range */
  SELECT seq, workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
         session_id, native_session_id, provider, kind, provenance, content_hash,
         ingested_at, raw_json
  FROM events
  WHERE workspace_id = ?1 AND seq > ?2
    AND (?3 IS NULL OR ingested_at >= ?3)
    AND (?4 IS NULL OR ingested_at <= ?4)
  ORDER BY seq
  LIMIT ?5`;

const INSERT_EXPORT_SQL = `
  /* artifacts:insert-export */
  INSERT INTO exports (id, workspace_id, status, params_json, created_at)
  VALUES (?1, ?2, 'running', ?3, ?4)`;

const COMPLETE_EXPORT_SQL = `
  /* artifacts:complete-export */
  UPDATE exports
  SET status = 'done', object_key = ?3, byte_size = ?4, event_count = ?5,
      sha256 = ?6, completed_at = ?7
  WHERE id = ?1 AND workspace_id = ?2 AND status = 'running'`;

const FAIL_EXPORT_SQL = `
  /* artifacts:fail-export */
  UPDATE exports
  SET status = 'error', completed_at = ?3
  WHERE id = ?1 AND workspace_id = ?2 AND status = 'running'`;

const EXPORT_BY_ID_SQL = `
  /* artifacts:export-by-id */
  SELECT id, workspace_id, status, params_json, object_key, byte_size,
         event_count, sha256, created_at, completed_at
  FROM exports
  WHERE workspace_id = ?1 AND id = ?2
  LIMIT 1`;

const EXPORTS_PAGE_SQL = `
  /* artifacts:exports-page */
  SELECT id, workspace_id, status, params_json, object_key, byte_size,
         event_count, sha256, created_at, completed_at
  FROM exports
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const EXPORTS_PAGE_AFTER_SQL = `
  /* artifacts:exports-page-after */
  SELECT id, workspace_id, status, params_json, object_key, byte_size,
         event_count, sha256, created_at, completed_at
  FROM exports
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

const RETENTION_POLICY_SQL = `
  /* artifacts:retention-policy */
  SELECT workspace_id, derived_ttl_days, created_at, updated_at
  FROM retention_policies
  WHERE workspace_id = ?1
  LIMIT 1`;

const UPSERT_RETENTION_SQL = `
  /* artifacts:upsert-retention */
  INSERT INTO retention_policies (workspace_id, derived_ttl_days, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?3)
  ON CONFLICT(workspace_id) DO UPDATE SET
    derived_ttl_days = excluded.derived_ttl_days,
    updated_at = MAX(retention_policies.updated_at, excluded.updated_at)`;

const RETENTION_POLICIES_SQL = `
  /* artifacts:retention-policies */
  SELECT workspace_id, derived_ttl_days
  FROM retention_policies
  WHERE derived_ttl_days IS NOT NULL
  ORDER BY workspace_id
  LIMIT ?1`;

const DERIVED_TABLE_PROBE_SQL = `
  /* artifacts:probe-derived-tables */
  SELECT name, sql
  FROM sqlite_master
  WHERE type = 'table'
    AND name IN ('traces', 'spans', 'span_observations', 'span_fingerprints')
  ORDER BY name`;

// Cutoffs are bound as unix SECONDS and scaled inside SQL, in each table's OWN
// native unit. SQLite does exact 64-bit integer arithmetic; multiplying to
// nanoseconds in JavaScript would leave the safe-integer range.
const DELETE_TRACES_SQL = `
  /* artifacts:retention-delete-traces */
  DELETE FROM traces
  WHERE workspace_id = ?1 AND started_at_ns < ?2 * 1000000000`;

const DELETE_SPANS_SQL = `
  /* artifacts:retention-delete-spans */
  DELETE FROM spans
  WHERE workspace_id = ?1 AND started_at_ns < ?2 * 1000000000`;

// migration 0005: span_observations keeps int64 unix NANOSECONDS in
// started_at_ns, and ts_bucket is a STORED generated column derived from it —
// so pruning on started_at_ns prunes the bucket index with it.
const DELETE_SPAN_OBSERVATIONS_SQL = `
  /* artifacts:retention-delete-span-observations */
  DELETE FROM span_observations
  WHERE workspace_id = ?1 AND started_at_ns < ?2 * 1000000000`;

// migration 0005: span_fingerprints bounds an identity with first_seen/
// last_seen in unix MILLISECONDS. last_seen is the correct cutoff — an
// identity is retained for as long as it was still being observed.
const DELETE_SPAN_FINGERPRINTS_SQL = `
  /* artifacts:retention-delete-span-fingerprints */
  DELETE FROM span_fingerprints
  WHERE workspace_id = ?1 AND last_seen < ?2 * 1000`;

// -- retention target registry ------------------------------------------------

interface DerivedTarget {
  /** Read-model table; must be rebuildable from the spine. */
  readonly table: string;
  /** Cutoff column, verified against the live DDL before any delete runs. */
  readonly column: string;
  readonly sql: string;
}

/**
 * Retention only ever touches these. Everything here is a projection that can
 * be rebuilt by replaying `events`. Tables that a sibling slice may not have
 * created yet are probed and skipped rather than assumed.
 *
 * Every (table, column) pair here MUST name a real column of the live schema:
 * the existence probe treats an unknown name as "a sibling slice has not
 * shipped this yet" and skips it silently, so a typo does not fail loudly —
 * it turns retention into a no-op for that table. The pairs below are the ones
 * migrations 0001 (traces, spans) and 0005 (span_observations,
 * span_fingerprints) actually declare.
 */
const DERIVED_RETENTION_TARGETS: readonly DerivedTarget[] = Object.freeze([
  { table: "traces", column: "started_at_ns", sql: DELETE_TRACES_SQL },
  { table: "spans", column: "started_at_ns", sql: DELETE_SPANS_SQL },
  { table: "span_observations", column: "started_at_ns", sql: DELETE_SPAN_OBSERVATIONS_SQL },
  { table: "span_fingerprints", column: "last_seen", sql: DELETE_SPAN_FINGERPRINTS_SQL },
]);

/**
 * Belt and braces for the hard invariant. Even if a future edit adds one of
 * these to the target list, the sweep refuses to touch it.
 */
export const NEVER_RETAINED_TABLES: readonly string[] = Object.freeze([
  "events",
  "artifact_file_list",
  "exports",
  "idempotency_keys",
  "workspaces",
  "devices",
  "workspace_entitlements",
]);

/** The read models retention is allowed to slim, in sweep order. */
export const RETENTION_TARGET_TABLES: readonly string[] = Object.freeze(
  DERIVED_RETENTION_TARGETS.map((target) => target.table),
);

// -- row shapes ---------------------------------------------------------------

/** One `events` row, exactly as the spine stores it. */
export interface EventSpineRow {
  seq: number;
  workspace_id: string;
  event_id: string;
  idempotency_key: string | null;
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

interface CompactionCandidateRow {
  workspace_id: string;
  min_seq: number;
  pending_events: number;
  pending_bytes: number;
  oldest_ingested_at: number;
}

interface ExportRow {
  id: string;
  workspace_id: string;
  status: string;
  params_json: string;
  object_key: string | null;
  byte_size: number | null;
  event_count: number | null;
  sha256: string | null;
  created_at: number;
  completed_at: number | null;
}

// -- deterministic encoding ---------------------------------------------------

/**
 * Project a spine row onto the exact column set that lands in an object.
 * raw_json stays the canonical TEXT the spine holds, so a line is a faithful
 * copy of the row and encoding never re-parses attacker-supplied JSON.
 */
function normalizeSpineRow(row: EventSpineRow): Record<string, unknown> {
  return {
    seq: row.seq,
    workspace_id: row.workspace_id,
    event_id: row.event_id,
    idempotency_key: row.idempotency_key ?? null,
    occurred_at: row.occurred_at,
    workstream_id: row.workstream_id ?? null,
    session_id: row.session_id ?? null,
    native_session_id: row.native_session_id ?? null,
    provider: row.provider ?? null,
    kind: row.kind,
    provenance: row.provenance ?? null,
    content_hash: row.content_hash ?? null,
    ingested_at: row.ingested_at,
    raw_json: row.raw_json,
  };
}

/** One canonical JSON object per line, ordered by seq, trailing newline. */
export function buildEventJsonl(rows: EventSpineRow[]): string {
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  return `${sorted.map((row) => canonicalJsonStringify(normalizeSpineRow(row))).join("\n")}\n`;
}

/**
 * Lexicographic bounds over the raw occurred_at strings in an object.
 * occurred_at is stored exactly as observed and may carry any UTC offset, so
 * these are index hints for locating an object, never a normalized range.
 */
function occurredAtBounds(rows: EventSpineRow[]): { min: string; max: string } {
  let min = rows[0].occurred_at;
  let max = rows[0].occurred_at;
  for (const row of rows) {
    if (row.occurred_at < min) min = row.occurred_at;
    if (row.occurred_at > max) max = row.occurred_at;
  }
  return { min, max };
}

/**
 * Object keys are derived from the seq range, not from a fresh random id, so a
 * repeated compaction of the same range rewrites identical bytes to the same
 * key instead of orphaning a second copy in the bucket.
 */
export async function artifactObjectKey(
  workspaceId: string,
  minSeq: number,
  maxSeq: number,
): Promise<string> {
  const digest = await sha256Hex(`${workspaceId}\n${minSeq}\n${maxSeq}`);
  return `artifacts/${workspaceId}/art_${digest.slice(0, 32)}.jsonl`;
}

export function exportObjectKey(workspaceId: string, exportId: string): string {
  return `exports/${workspaceId}/${exportId}.ndjson`;
}

// -- compaction ---------------------------------------------------------------

export interface CompactionOptions {
  nowSeconds?: number;
  ageSeconds?: number;
  sizeBytes?: number;
  maxEventsPerObject?: number;
  maxObjects?: number;
  maxWorkspaces?: number;
}

export interface CompactionSummary {
  workspaces: number;
  objects: number;
  events: number;
  bytes: number;
  /** Keys written or confirmed present this run, sorted. */
  object_keys: string[];
}

async function objectExists(bucket: R2BucketLike, key: string): Promise<boolean> {
  const listed = await bucket.list({ prefix: key, limit: 1 });
  return listed.objects.some((object) => object.key === key);
}

/**
 * Copy compaction-eligible spine runs into R2 and index them in D1.
 *
 * Reads only. No statement in this path updates or deletes `events`; the
 * migration's spine guards make that structurally impossible as well.
 */
export async function runCompaction(
  env: ArtifactsEnv,
  options: CompactionOptions = {},
): Promise<CompactionSummary> {
  const bucket = env.BODIES;
  if (bucket === undefined) {
    // Fail closed and loudly rather than silently skipping cold storage.
    throw new Error("BODIES object storage binding is not configured");
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ageSeconds = options.ageSeconds ?? COMPACTION_AGE_SECONDS;
  const sizeBytes = options.sizeBytes ?? COMPACTION_SIZE_BYTES;
  const maxEventsPerObject = options.maxEventsPerObject ?? COMPACTION_MAX_EVENTS_PER_OBJECT;
  const maxObjects = options.maxObjects ?? COMPACTION_MAX_OBJECTS_PER_RUN;
  const maxWorkspaces = options.maxWorkspaces ?? COMPACTION_MAX_WORKSPACES_PER_RUN;

  const candidates = await env.DB.prepare(COMPACTION_CANDIDATES_SQL)
    .bind(sizeBytes, nowSeconds - ageSeconds, maxWorkspaces)
    .all<CompactionCandidateRow>();

  // Never depend on storage/iteration order for the emitted set.
  const ordered = [...candidates.results].sort((a, b) =>
    a.workspace_id < b.workspace_id ? -1 : a.workspace_id > b.workspace_id ? 1 : 0,
  );

  const summary: CompactionSummary = {
    workspaces: 0,
    objects: 0,
    events: 0,
    bytes: 0,
    object_keys: [],
  };

  for (const candidate of ordered) {
    if (summary.objects >= maxObjects) break;
    summary.workspaces += 1;
    // Pending rows start immediately after the compaction watermark, and the
    // candidate query already computed the first uncompacted seq.
    let cursor = candidate.min_seq - 1;
    for (;;) {
      if (summary.objects >= maxObjects) break;
      const page = await env.DB.prepare(COMPACTION_PAGE_SQL)
        .bind(candidate.workspace_id, cursor, maxEventsPerObject)
        .all<EventSpineRow>();
      const rows = [...page.results].sort((a, b) => a.seq - b.seq);
      if (rows.length === 0) break;

      const minSeq = rows[0].seq;
      const maxSeq = rows[rows.length - 1].seq;
      const content = buildEventJsonl(rows);
      const byteSize = UTF8.encode(content).byteLength;
      const contentSha256 = await sha256Hex(content);
      const objectKey = await artifactObjectKey(candidate.workspace_id, minSeq, maxSeq);
      const bounds = occurredAtBounds(rows);

      // Content-addressed by range: an existing key already holds these bytes.
      if (!(await objectExists(bucket, objectKey))) {
        await bucket.put(objectKey, content, {
          httpMetadata: { contentType: "application/x-ndjson" },
          customMetadata: {
            workspace_id: candidate.workspace_id,
            min_seq: String(minSeq),
            max_seq: String(maxSeq),
            event_count: String(rows.length),
            content_sha256: contentSha256,
          },
        });
      }
      // INSERT OR IGNORE + the unique (workspace_id, min_seq, max_seq) index
      // make a repeated sweep over the same range a no-op.
      await env.DB.prepare(INSERT_ARTIFACT_SQL)
        .bind(
          candidate.workspace_id,
          objectKey,
          rows.length,
          byteSize,
          minSeq,
          maxSeq,
          bounds.min,
          bounds.max,
          contentSha256,
          nowSeconds,
        )
        .run();

      summary.objects += 1;
      summary.events += rows.length;
      summary.bytes += byteSize;
      summary.object_keys.push(objectKey);
      cursor = maxSeq;
      if (rows.length < maxEventsPerObject) break;
    }
  }

  summary.object_keys.sort();
  return summary;
}

// -- retention ----------------------------------------------------------------

export interface RetentionSweepOptions {
  nowSeconds?: number;
  maxWorkspaces?: number;
}

export interface RetentionSweepSummary {
  workspaces: number;
  deleted: number;
  /** Derived tables actually swept, sorted. */
  swept_tables: string[];
  /** Declared targets skipped because the table or its cutoff column is absent. */
  skipped_tables: string[];
}

function ddlDeclaresColumn(ddl: unknown, column: string): boolean {
  if (typeof ddl !== "string") return false;
  return new RegExp(`(^|[^0-9A-Za-z_])${column}([^0-9A-Za-z_]|$)`).test(ddl);
}

/**
 * Delete derived rows past each workspace's TTL.
 *
 * NEVER touches `events` (the spine is retained forever), `artifact_file_list`,
 * or the R2 artifacts themselves — cold storage is immutable and is not a TTL
 * target. See docs/hosted-retention.md.
 */
export async function retentionSweep(
  env: ArtifactsEnv,
  options: RetentionSweepOptions = {},
): Promise<RetentionSweepSummary> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxWorkspaces = options.maxWorkspaces ?? RETENTION_MAX_WORKSPACES_PER_RUN;

  const policies = await env.DB.prepare(RETENTION_POLICIES_SQL)
    .bind(maxWorkspaces)
    .all<{ workspace_id: string; derived_ttl_days: number }>();

  const summary: RetentionSweepSummary = {
    workspaces: 0,
    deleted: 0,
    swept_tables: [],
    skipped_tables: [],
  };
  if (policies.results.length === 0) return summary;

  const schema = await env.DB.prepare(DERIVED_TABLE_PROBE_SQL)
    .bind()
    .all<{ name: string; sql: string | null }>();
  const ddlByTable = new Map<string, string | null>(
    schema.results.map((row) => [row.name, row.sql]),
  );

  const active: DerivedTarget[] = [];
  for (const target of DERIVED_RETENTION_TARGETS) {
    if (NEVER_RETAINED_TABLES.includes(target.table)) {
      summary.skipped_tables.push(target.table);
      continue;
    }
    if (!ddlByTable.has(target.table) || !ddlDeclaresColumn(ddlByTable.get(target.table), target.column)) {
      // A sibling slice has not created this read model yet: skip gracefully.
      summary.skipped_tables.push(target.table);
      continue;
    }
    active.push(target);
  }

  const ordered = [...policies.results].sort((a, b) =>
    a.workspace_id < b.workspace_id ? -1 : a.workspace_id > b.workspace_id ? 1 : 0,
  );
  const swept = new Set<string>();
  for (const policy of ordered) {
    const ttlDays = policy.derived_ttl_days;
    if (!Number.isSafeInteger(ttlDays) || ttlDays < RETENTION_MIN_TTL_DAYS) continue;
    summary.workspaces += 1;
    const cutoffSeconds = nowSeconds - ttlDays * SECONDS_PER_DAY;
    for (const target of active) {
      const result = await env.DB.prepare(target.sql)
        .bind(policy.workspace_id, cutoffSeconds)
        .run();
      summary.deleted += result.meta?.changes ?? 0;
      swept.add(target.table);
    }
  }

  summary.swept_tables = [...swept].sort();
  summary.skipped_tables.sort();
  return summary;
}

// -- scheduled sweep ----------------------------------------------------------

function logSweepFailure(sweep: string, error: unknown): void {
  // Content-free: never log workspace ids, keys, binds, or payloads.
  console.error(JSON.stringify({
    message: "scheduled sweep failed",
    sweep,
    error_type: error instanceof Error ? error.name : "unknown",
  }));
}

/**
 * Cron entry point. The two sweeps are isolated from each other: a compaction
 * failure must not suppress retention, and neither may fail the invocation in
 * a way that could affect ingest.
 */
export async function artifactsScheduled(env: ArtifactsEnv): Promise<void> {
  try {
    await runCompaction(env);
  } catch (error) {
    logSweepFailure("compaction", error);
  }
  try {
    await retentionSweep(env);
  } catch (error) {
    logSweepFailure("retention", error);
  }
}

// -- export params ------------------------------------------------------------

export interface ExportParams {
  mode: "full" | "workstream" | "range";
  workstream_id: string | null;
  /** Inclusive bounds on events.ingested_at (unix seconds), or null. */
  since: number | null;
  until: number | null;
}

const EXPORT_PARAM_KEYS = new Set(["full", "workstream_id", "since", "until"]);

function invalid(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

function parseBound(value: unknown, field: string): Validation<number> {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return invalid(400, `${field} must be a non-negative unix-seconds integer`);
    }
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return invalid(400, `${field} must be an RFC 3339 timestamp or unix seconds`);
    }
    return { ok: true, value: Math.floor(parsed / 1000) };
  }
  return invalid(400, `${field} must be an RFC 3339 timestamp or unix seconds`);
}

/**
 * Validate an export selector. Exactly one mode may be requested and unknown
 * fields are rejected, so a typo silently exporting the whole workspace is
 * impossible.
 *
 * `since`/`until` bound events.ingested_at — the server-assigned ingestion
 * clock — not occurred_at, which is preserved exactly as observed and may carry
 * any UTC offset, making it unsafe to compare in SQL.
 */
export function parseExportParams(value: unknown): Validation<ExportParams> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(400, "export request must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!EXPORT_PARAM_KEYS.has(key)) return invalid(400, `unknown field ${key}`);
  }

  const wantsFull = body.full !== undefined;
  const wantsWorkstream = body.workstream_id !== undefined;
  const wantsRange = body.since !== undefined || body.until !== undefined;

  if (wantsFull) {
    if (body.full !== true) return invalid(400, "full must be true");
    if (wantsWorkstream || wantsRange) {
      return invalid(400, "full cannot be combined with workstream_id, since, or until");
    }
    return { ok: true, value: { mode: "full", workstream_id: null, since: null, until: null } };
  }

  if (wantsWorkstream) {
    if (wantsRange) {
      return invalid(400, "workstream_id cannot be combined with since or until");
    }
    const workstreamId = body.workstream_id;
    if (typeof workstreamId !== "string" || !WORKSTREAM_ID_PATTERN.test(workstreamId)) {
      return invalid(400, `workstream_id must match ${WORKSTREAM_ID_PATTERN.source}`);
    }
    return { ok: true, value: { mode: "workstream", workstream_id: workstreamId, since: null, until: null } };
  }

  if (!wantsRange) {
    return invalid(400, "one of full, workstream_id, or since/until is required");
  }
  let since: number | null = null;
  let until: number | null = null;
  if (body.since !== undefined) {
    const parsed = parseBound(body.since, "since");
    if (!parsed.ok) return parsed;
    since = parsed.value;
  }
  if (body.until !== undefined) {
    const parsed = parseBound(body.until, "until");
    if (!parsed.ok) return parsed;
    until = parsed.value;
  }
  if (since !== null && until !== null && until < since) {
    return invalid(400, "until must be greater than or equal to since");
  }
  return { ok: true, value: { mode: "range", workstream_id: null, since, until } };
}

/** Canonical echo of the selector, stored in params_json and returned to clients. */
export function exportParamsJson(params: ExportParams): string {
  if (params.mode === "full") return canonicalJsonStringify({ full: true });
  if (params.mode === "workstream") {
    return canonicalJsonStringify({ workstream_id: params.workstream_id });
  }
  return canonicalJsonStringify({ since: params.since, until: params.until });
}

// -- export execution ---------------------------------------------------------

class ExportTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTooLargeError";
  }
}

async function fetchExportPage(
  db: D1DatabaseLike,
  workspaceId: string,
  params: ExportParams,
  cursor: number,
): Promise<EventSpineRow[]> {
  if (params.mode === "workstream") {
    const page = await db
      .prepare(EXPORT_PAGE_WORKSTREAM_SQL)
      .bind(workspaceId, cursor, params.workstream_id, EXPORT_PAGE_SIZE)
      .all<EventSpineRow>();
    return page.results;
  }
  if (params.mode === "range") {
    const page = await db
      .prepare(EXPORT_PAGE_RANGE_SQL)
      .bind(workspaceId, cursor, params.since, params.until, EXPORT_PAGE_SIZE)
      .all<EventSpineRow>();
    return page.results;
  }
  const page = await db
    .prepare(EXPORT_PAGE_FULL_SQL)
    .bind(workspaceId, cursor, EXPORT_PAGE_SIZE)
    .all<EventSpineRow>();
  return page.results;
}

export interface ExportContent {
  ndjson: string;
  eventCount: number;
  byteSize: number;
}

/**
 * Stream the selected spine rows into bounded NDJSON.
 *
 * Synchronous and in-request for now: the caller pages D1 by seq and buffers
 * the result, which is why EXPORT_MAX_EVENTS/EXPORT_MAX_BYTES exist. A durable
 * Workflows-backed executor will replace this with a resumable, unbounded job
 * (row 46 follow-up); the manifest columns and the 'queued' status already
 * describe that shape, so the API surface will not change.
 */
export async function buildExportContent(
  db: D1DatabaseLike,
  workspaceId: string,
  params: ExportParams,
): Promise<ExportContent> {
  const lines: string[] = [];
  let byteSize = 0;
  let cursor = 0;
  for (;;) {
    const page = await fetchExportPage(db, workspaceId, params, cursor);
    if (page.length === 0) break;
    const rows = [...page].sort((a, b) => a.seq - b.seq);
    for (const row of rows) {
      const line = canonicalJsonStringify(normalizeSpineRow(row));
      byteSize += UTF8.encode(line).byteLength + 1; // + newline
      if (lines.length + 1 > EXPORT_MAX_EVENTS) {
        throw new ExportTooLargeError(`export exceeds ${EXPORT_MAX_EVENTS} events`);
      }
      if (byteSize > EXPORT_MAX_BYTES) {
        throw new ExportTooLargeError(`export exceeds ${EXPORT_MAX_BYTES} bytes`);
      }
      lines.push(line);
    }
    cursor = rows[rows.length - 1].seq;
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  const ndjson = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { ndjson, eventCount: lines.length, byteSize: UTF8.encode(ndjson).byteLength };
}

function exportSummary(row: ExportRow): Record<string, unknown> {
  let params: unknown = null;
  try {
    params = JSON.parse(row.params_json);
  } catch {
    params = null;
  }
  return {
    id: row.id,
    status: row.status,
    params,
    object_key: row.object_key,
    byte_size: row.byte_size,
    event_count: row.event_count,
    sha256: row.sha256,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

// -- device auth --------------------------------------------------------------

/**
 * Every route here is device-plane and gated on 'read'.
 *
 * Retention is a workspace-level control, but the device capability vocabulary
 * is currently ingest|read; 'read' is the closest gate until the account plane
 * grows scoped roles, at which point this tightens to an owner-only control.
 */
async function authorizeDevice(
  request: Request,
  env: ArtifactsEnv,
): Promise<{ device: DeviceBinding } | { response: Response }> {
  const auth = await authenticate(request.headers.get("authorization"), deviceLookup(env.DB));
  if (!auth.ok) return { response: json(auth.status, { error: auth.error }) };
  const denial = scopeDenial({
    tokenWorkspaceId: auth.device.workspaceId,
    allowed: hasCapability(auth.device, "read"),
  });
  if (denial !== null) return { response: json(denial.status, { error: denial.error }) };
  return { device: auth.device };
}

async function readJsonBody(request: Request): Promise<Validation<unknown>> {
  const read = await readRequestBody(request, MAX_EXPORT_REQUEST_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? invalid(413, `request body exceeds ${MAX_EXPORT_REQUEST_BYTES} bytes`)
      : invalid(400, "request body is not readable UTF-8");
  }
  if (read.text.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return invalid(400, "request body is not valid JSON");
  }
}

// -- POST /v1/exports ---------------------------------------------------------

async function createExport(request: Request, env: ArtifactsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;
  const bucket = env.BODIES;
  if (bucket === undefined) {
    return json(503, { error: "object storage is not configured" });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = parseExportParams(body.value);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const params = parsed.value;

  const workspaceId = auth.device.workspaceId;
  const exportId = `exp_${nextULID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const paramsJson = exportParamsJson(params);

  await env.DB.prepare(INSERT_EXPORT_SQL)
    .bind(exportId, workspaceId, paramsJson, createdAt)
    .run();

  const objectKey = exportObjectKey(workspaceId, exportId);
  try {
    const content = await buildExportContent(env.DB, workspaceId, params);
    const sha256 = await sha256Hex(content.ndjson);
    await bucket.put(objectKey, content.ndjson, {
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: {
        workspace_id: workspaceId,
        export_id: exportId,
        event_count: String(content.eventCount),
        content_sha256: sha256,
      },
    });
    const completedAt = Math.max(createdAt, Math.floor(Date.now() / 1000));
    try {
      const settled = await env.DB.prepare(COMPLETE_EXPORT_SQL)
        .bind(
          exportId,
          workspaceId,
          objectKey,
          content.byteSize,
          content.eventCount,
          sha256,
          completedAt,
        )
        .run();
      // Never report a manifest the database did not accept. A driver that
      // omits meta.changes is tolerated; a reported miss is not.
      const changes = settled.meta?.changes;
      if (typeof changes === "number" && changes !== 1) {
        throw new Error("export manifest was not committed");
      }
    } catch (error) {
      // The manifest is the record of truth; an object with no manifest is
      // unreachable, so drop it rather than leak storage.
      await bucket.delete(objectKey);
      throw error;
    }
    return json(201, exportSummary({
      id: exportId,
      workspace_id: workspaceId,
      status: "done",
      params_json: paramsJson,
      object_key: objectKey,
      byte_size: content.byteSize,
      event_count: content.eventCount,
      sha256,
      created_at: createdAt,
      completed_at: completedAt,
    }));
  } catch (error) {
    await settleFailedExport(env.DB, exportId, workspaceId, createdAt);
    if (error instanceof ExportTooLargeError) {
      return json(413, {
        error: `${error.message}; narrow the selector with workstream_id or since/until`,
      });
    }
    throw error;
  }
}

async function settleFailedExport(
  db: D1DatabaseLike,
  exportId: string,
  workspaceId: string,
  createdAt: number,
): Promise<void> {
  try {
    await db
      .prepare(FAIL_EXPORT_SQL)
      .bind(exportId, workspaceId, Math.max(createdAt, Math.floor(Date.now() / 1000)))
      .run();
  } catch (error) {
    logSweepFailure("export-settle", error);
  }
}

// -- GET /v1/exports ----------------------------------------------------------

async function listExports(request: Request, env: ArtifactsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;

  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const fetchLimit = limit + 1; // prefetch one row to detect the next page

  const result =
    cursor === null
      ? await env.DB.prepare(EXPORTS_PAGE_SQL).bind(auth.device.workspaceId, fetchLimit).all<ExportRow>()
      : await env.DB.prepare(EXPORTS_PAGE_AFTER_SQL)
          .bind(auth.device.workspaceId, cursor.createdAt, cursor.id, fetchLimit)
          .all<ExportRow>();

  // Re-sort: the response must not depend on storage order.
  const sorted = [...result.results].sort((a, b) => {
    if (b.created_at !== a.created_at) return b.created_at - a.created_at;
    if (a.id !== b.id) return a.id > b.id ? -1 : 1;
    return 0;
  });
  const items = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(exportSummary),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

// -- GET /v1/exports/{id} -----------------------------------------------------

async function readExportRow(
  env: ArtifactsEnv,
  workspaceId: string,
  exportId: string,
): Promise<ExportRow | null> {
  const row = await env.DB.prepare(EXPORT_BY_ID_SQL).bind(workspaceId, exportId).first<ExportRow>();
  if (row === null) return null;
  // Defence in depth: the query already binds workspace_id, but a foreign row
  // must never be rendered even if a future join loosens the predicate.
  if (scopeDenial({ resourceWorkspaceId: row.workspace_id, tokenWorkspaceId: workspaceId }) !== null) {
    return null;
  }
  return row;
}

async function getExport(request: Request, env: ArtifactsEnv, exportId: string): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;
  const row = await readExportRow(env, auth.device.workspaceId, exportId);
  if (row === null) return json(404, { error: "not found" });
  return json(200, exportSummary(row));
}

// -- GET /v1/exports/{id}/download --------------------------------------------

async function downloadExport(
  request: Request,
  env: ArtifactsEnv,
  exportId: string,
): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;
  const bucket = env.BODIES;
  if (bucket === undefined) {
    return json(503, { error: "object storage is not configured" });
  }
  const row = await readExportRow(env, auth.device.workspaceId, exportId);
  if (row === null) return json(404, { error: "not found" });
  if (row.status !== "done" || row.object_key === null) {
    return json(409, { error: "export is not complete" });
  }
  const object = await bucket.get(row.object_key);
  if (object === null) return json(404, { error: "not found" });
  const body = object.body ?? (await object.text());
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${row.id}.ndjson"`,
      "content-type": "application/x-ndjson",
      "x-content-type-options": "nosniff",
    },
  });
}

// -- GET/PUT /v1/retention ----------------------------------------------------

interface RetentionRow {
  workspace_id: string;
  derived_ttl_days: number | null;
  created_at: number;
  updated_at: number;
}

function retentionBody(row: RetentionRow | null): Record<string, unknown> {
  return {
    derived_ttl_days: row?.derived_ttl_days ?? null,
    min_ttl_days: RETENTION_MIN_TTL_DAYS,
    max_ttl_days: RETENTION_MAX_TTL_DAYS,
    // The spine is evidence, not cache: it is never TTL'd, and neither is the
    // compacted artifact index. See docs/hosted-retention.md.
    spine_retention: "forever",
    applies_to: [...RETENTION_TARGET_TABLES],
    never_retained: [...NEVER_RETAINED_TABLES],
    updated_at: row?.updated_at ?? null,
  };
}

async function getRetention(request: Request, env: ArtifactsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;
  const row = await env.DB.prepare(RETENTION_POLICY_SQL)
    .bind(auth.device.workspaceId)
    .first<RetentionRow>();
  return json(200, retentionBody(row));
}

export function parseRetentionUpdate(value: unknown): Validation<number | null> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(400, "retention request must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "derived_ttl_days") return invalid(400, `unknown field ${key}`);
  }
  if (!("derived_ttl_days" in body)) return invalid(400, "derived_ttl_days is required");
  const ttl = body.derived_ttl_days;
  if (ttl === null) return { ok: true, value: null };
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl)) {
    return invalid(400, "derived_ttl_days must be an integer or null");
  }
  if (ttl < RETENTION_MIN_TTL_DAYS) {
    return invalid(400, `derived_ttl_days must be at least ${RETENTION_MIN_TTL_DAYS} days`);
  }
  if (ttl > RETENTION_MAX_TTL_DAYS) {
    return invalid(400, `derived_ttl_days must be at most ${RETENTION_MAX_TTL_DAYS} days`);
  }
  return { ok: true, value: ttl };
}

async function putRetention(request: Request, env: ArtifactsEnv): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if ("response" in auth) return auth.response;
  const body = await readJsonBody(request);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = parseRetentionUpdate(body.value);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(UPSERT_RETENTION_SQL)
    .bind(auth.device.workspaceId, parsed.value, now)
    .run();
  const row = await env.DB.prepare(RETENTION_POLICY_SQL)
    .bind(auth.device.workspaceId)
    .first<RetentionRow>();
  return json(200, retentionBody(row));
}

// -- routing seam -------------------------------------------------------------

const EXPORT_PATH_PATTERN = /^\/v1\/exports\/(exp_[0-7][0-9A-HJKMNP-TV-Z]{25})(\/download)?$/;

/**
 * Route the artifact/export/retention surface. Returns null when this module
 * does not own the path so index.ts can continue; a wrong method on a path this
 * module owns also returns null, which the router answers with 404 (house
 * rule: known paths never advertise their supported methods).
 */
export async function handleArtifactsRoute(
  request: Request,
  env: ArtifactsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/exports") {
    if (request.method === "POST") return createExport(request, env);
    if (request.method === "GET") return listExports(request, env);
    return null;
  }
  if (pathname === "/v1/retention") {
    if (request.method === "GET") return getRetention(request, env);
    if (request.method === "PUT") return putRetention(request, env);
    return null;
  }
  const match = EXPORT_PATH_PATTERN.exec(pathname);
  if (match !== null) {
    if (request.method !== "GET") return null;
    return match[2] === undefined
      ? getExport(request, env, match[1])
      : downloadExport(request, env, match[1]);
  }
  return null;
}
