// Tests for src/observations.ts.
//
// Three layers, no workerd and no new dependencies:
//   * pure logic  — time parsing, buckets, fingerprints, projection deltas;
//   * schema truth — migration 0005 applied with node:sqlite, exercising the
//     REAL upsert statements so merge semantics, CHECKs, generated columns and
//     triggers are asserted against SQLite rather than against a mock;
//   * handlers — worker.fetch against the plain-object D1 seam.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import worker, {
  type D1BoundStatement,
  type D1DatabaseLike,
  type D1Statement,
} from "../src/index";
import { sha256Hex } from "../src/auth";
import { canonicalJsonStringify, type IngestEvent } from "../src/ingest";
import {
  CLEAR_SESSIONS_SQL,
  CLEAR_SPAN_FINGERPRINTS_SQL,
  CLEAR_SPAN_OBSERVATIONS_SQL,
  MAX_REINDEX_EVENTS,
  OBSERVATION_BUCKET_NS,
  SESSION_BUCKET_MS,
  UPSERT_SESSIONS_SQL,
  UPSERT_SPAN_FINGERPRINTS_SQL,
  UPSERT_SPAN_OBSERVATIONS_SQL,
  buildObservationProjection,
  buildObservationQuery,
  buildSessionQuery,
  decodeKeyCursor,
  encodeKeyCursor,
  observationBucket,
  parseEventTime,
  parseKeyPagination,
  resourceFingerprint,
  sessionBucket,
} from "../src/observations";

// -- fixtures -----------------------------------------------------------------

const TOKEN_WORKSPACE = `wsp_01HTSTW0RKSPACE0000000000Z`;
const OTHER_WORKSPACE = `wsp_01HTSTW0RKSPEER0000000000Z`;
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const WORKSTREAM = `ws_01HTESTWS0000000000000000Z`;
const SESSION = `ses_01HTESTWS0000000000000000Z`;
const SESSION_TWO = `ses_01HTESTWS0000000000000001Z`;

let TOKEN_HASH = "";
beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

function eventId(i: number): string {
  const head = `01HTEST${String(i).padStart(4, "0")}`;
  return `evt_${head}${"0".repeat(26 - head.length - 1)}Z`;
}

function event(overrides: Record<string, unknown> = {}, i = 0): IngestEvent {
  return {
    schema_version: "hfg.event.v1",
    event_id: eventId(i),
    kind: "span.started",
    occurred_at: "2026-08-21T10:00:00Z",
    observed_at: "2026-08-21T10:00:00Z",
    workstream_id: WORKSTREAM,
    session_id: SESSION,
    native_session_id: "claude-abc",
    provider: "claude",
    agent: "claude-code",
    model: "opus-5",
    provenance: "OBSERVED",
    ...overrides,
  } as IngestEvent;
}

// -- pure logic ---------------------------------------------------------------

describe("time buckets", () => {
  it("uses 30-minute buckets in both tables' native units", () => {
    // The parity plan's stack-translation table pins 5-minute buckets locally
    // and 30-minute buckets in D1. Same width, different unit per table.
    expect(OBSERVATION_BUCKET_NS).toBe(30n * 60n * 1_000_000_000n);
    expect(SESSION_BUCKET_MS).toBe(30 * 60 * 1000);
  });

  it("floors nanosecond and millisecond values into the same wall-clock bucket", () => {
    const at = parseEventTime("2026-08-21T10:29:59.999999999Z");
    const next = parseEventTime("2026-08-21T10:30:00Z");
    expect(at).not.toBeNull();
    expect(next).not.toBeNull();
    expect(observationBucket(at!.ns)).toBe(sessionBucket(at!.ms));
    expect(observationBucket(next!.ns)).toBe(observationBucket(at!.ns) + 1);
    expect(sessionBucket(next!.ms)).toBe(sessionBucket(at!.ms) + 1);
  });
});

describe("parseEventTime", () => {
  it("keeps full nanosecond precision that a JS number would lose", () => {
    const at = parseEventTime("2026-08-21T10:00:00.123456789Z");
    expect(at?.ns).toBe("1787306400123456789");
    // Proof the string form is required: the float round-trip is lossy.
    expect(String(Number(at!.ns))).not.toBe(at!.ns);
    expect(at?.ms).toBe(1_787_306_400_123);
  });

  it("pads short fractions and accepts numeric offsets", () => {
    expect(parseEventTime("2026-08-21T10:00:00.5Z")?.ns).toBe("1787306400500000000");
    expect(parseEventTime("2026-08-21T15:30:00+05:30")?.ns).toBe(
      parseEventTime("2026-08-21T10:00:00Z")?.ns,
    );
  });

  it("rejects malformed and pre-epoch timestamps (fail closed)", () => {
    expect(parseEventTime("2026-08-21 10:00:00Z")).toBeNull();
    expect(parseEventTime("not-a-time")).toBeNull();
    expect(parseEventTime(42)).toBeNull();
    // Integer division truncates toward zero, so a negative nanosecond value
    // would land in the wrong bucket: the derived row is skipped instead.
    expect(parseEventTime("1969-12-31T23:59:59Z")).toBeNull();
  });
});

describe("resourceFingerprint", () => {
  it("is 24 lowercase hex chars and a pure function of the sorted labels", async () => {
    const labels = {
      agent: "claude-code",
      host: "laptop",
      model: "opus-5",
      provider: "claude",
      repo: "git@example.com:a/b.git",
    };
    const first = await resourceFingerprint(labels);
    const second = await resourceFingerprint({ ...labels });
    expect(first).toMatch(/^[0-9a-f]{24}$/);
    expect(second).toBe(first);
  });

  it("separates label tuples that differ in any single label", async () => {
    const base = { agent: "a", host: "h", model: "m", provider: "p", repo: "r" };
    const prints = await Promise.all([
      resourceFingerprint(base),
      resourceFingerprint({ ...base, agent: "a2" }),
      resourceFingerprint({ ...base, host: "h2" }),
      resourceFingerprint({ ...base, model: "m2" }),
      resourceFingerprint({ ...base, provider: "p2" }),
      resourceFingerprint({ ...base, repo: "r2" }),
    ]);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("does not confuse an absent label with an adjacent value", async () => {
    const withModel = await resourceFingerprint({
      agent: null, host: null, model: "p", provider: null, repo: null,
    });
    const withProvider = await resourceFingerprint({
      agent: null, host: null, model: null, provider: "p", repo: null,
    });
    expect(withModel).not.toBe(withProvider);
  });
});

describe("buildObservationProjection", () => {
  it("derives a wide row per span-bearing event with denormalized identity", async () => {
    const projection = await buildObservationProjection([
      event({ payload: { span_id: "spn_1", trace_id: "trc_1", kind: "TOOL", name: "Bash", tool_name: "Bash" } }),
    ]);
    expect(projection.spans).toHaveLength(1);
    const [row] = projection.spans;
    expect(row.span_id).toBe("spn_1");
    expect(row.trace_id).toBe("trc_1");
    expect(row.kind).toBe("TOOL");
    expect(row.name).toBe("Bash");
    expect(row.tool_name).toBe("Bash");
    expect(row.status).toBe("running");
    expect(row.status_rank).toBe(1);
    expect(row.ended_at_ns).toBeNull();
    // Trace-level identity is copied onto the row (the wide-table point).
    expect(row.workstream_id).toBe(WORKSTREAM);
    expect(row.session_id).toBe(SESSION);
    expect(row.native_session_id).toBe("claude-abc");
    expect(row.provider).toBe("claude");
    expect(row.agent).toBe("claude-code");
    expect(row.model).toBe("opus-5");
  });

  it("is byte-identical when the same batch is replayed or re-ordered", async () => {
    const events = [
      event({ kind: "span.started", payload: { span_id: "spn_1" } }, 0),
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:00:02Z", payload: { span_id: "spn_1" } }, 1),
      event({ kind: "command.completed", payload: { span_id: "spn_2", exit_code: 1 } }, 2),
    ];
    const first = await buildObservationProjection(events);
    const replay = await buildObservationProjection(events);
    const shuffled = await buildObservationProjection([events[2], events[0], events[1]]);
    expect(canonicalJsonStringify(replay)).toBe(canonicalJsonStringify(first));
    expect(canonicalJsonStringify(shuffled)).toBe(canonicalJsonStringify(first));
  });

  it("promotes command/test/file evidence to spans the way the Go materializer does", async () => {
    const projection = await buildObservationProjection([
      event({ kind: "command.completed", payload: { span_id: "c", command: "go test", exit_code: 2 } }, 0),
      event({ kind: "test.completed", payload: { span_id: "t", name: "TestX", result: "failed" } }, 1),
      event({ kind: "file.read", payload: { span_id: "fr", path: "a.go" } }, 2),
      event({ kind: "file.edited", payload: { span_id: "fw", path: "b.go" } }, 3),
      event({ kind: "span.failed", payload: { span_id: "sf" } }, 4),
    ]);
    const byID = new Map(projection.spans.map((row) => [row.span_id, row]));
    expect(byID.get("c")?.kind).toBe("COMMAND");
    expect(byID.get("c")?.name).toBe("go test");
    expect(byID.get("c")?.status).toBe("error");
    expect(byID.get("t")?.kind).toBe("TEST");
    expect(byID.get("t")?.status).toBe("error");
    expect(byID.get("fr")?.kind).toBe("FILE_READ");
    expect(byID.get("fw")?.kind).toBe("FILE_WRITE");
    expect(byID.get("fw")?.name).toBe("b.go");
    expect(byID.get("sf")?.status).toBe("error");
    expect(byID.get("sf")?.status_rank).toBe(3);
  });

  it("ignores events that are not span contributions but still tracks their session", async () => {
    const projection = await buildObservationProjection([
      event({ kind: "trace.started", payload: { trace_id: "trc_1" } }, 0),
      event({ kind: "prompt.submitted" }, 1),
    ]);
    expect(projection.spans).toHaveLength(0);
    expect(projection.sessions).toHaveLength(2);
    expect(projection.sessions.every((row) => row.id === SESSION)).toBe(true);
  });

  it("records a cost only when a decimal amount and a known provenance travel together", async () => {
    const projection = await buildObservationProjection([
      event({ kind: "span.completed", payload: { span_id: "a", cost_amount: "0.0125", cost_provenance: "provider_reported" } }, 0),
      event({ kind: "span.completed", payload: { span_id: "b", cost_amount: "0.5" } }, 1),
      event({ kind: "span.completed", payload: { span_id: "c", cost_amount: "0.5", cost_provenance: "unknown" } }, 2),
      event({ kind: "span.completed", payload: { span_id: "d", cost_amount: 0.5, cost_provenance: "provider_reported" } }, 3),
    ]);
    const byID = new Map(projection.spans.map((row) => [row.span_id, row]));
    expect(byID.get("a")?.cost_amount).toBe("0.0125");
    expect(byID.get("a")?.cost_provenance).toBe("provider_reported");
    for (const id of ["b", "c", "d"]) {
      expect(byID.get(id)?.cost_amount).toBeNull();
      expect(byID.get(id)?.cost_provenance).toBeNull();
    }
  });

  it("skips events whose timestamp cannot be represented in the bucketed model", async () => {
    const projection = await buildObservationProjection([
      event({ occurred_at: "1969-01-01T00:00:00Z", payload: { span_id: "old" } }, 0),
      event({ occurred_at: "garbage", payload: { span_id: "bad" } }, 1),
    ]);
    expect(projection.spans).toHaveLength(0);
    expect(projection.sessions).toHaveLength(0);
  });

  it("emits one fingerprint delta per span carrying the resource labels", async () => {
    const projection = await buildObservationProjection([
      event({ repository_id: "repo_1", payload: { span_id: "a", host: "box" } }, 0),
    ]);
    expect(projection.fingerprints).toHaveLength(1);
    const [print] = projection.fingerprints;
    expect(print.fingerprint).toBe(projection.spans[0].fingerprint);
    expect(print.provider).toBe("claude");
    expect(print.agent).toBe("claude-code");
    expect(print.model).toBe("opus-5");
    expect(print.repo).toBe("repo_1");
    expect(print.host).toBe("box");
    expect(print.first_seen).toBe(print.last_seen);
  });

  it("prefers the git remote over the repository id for the repo label", async () => {
    const projection = await buildObservationProjection([
      event({ repository_id: "repo_1", git: { remote: "git@example.com:a/b.git" }, payload: { span_id: "a" } }, 0),
    ]);
    expect(projection.fingerprints[0].repo).toBe("git@example.com:a/b.git");
  });
});

describe("key cursors", () => {
  it("round-trips a nanosecond sort key without a float", () => {
    const cursor = { sort: "1787306400123456789", id: "spn_1" };
    expect(decodeKeyCursor(encodeKeyCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors and out-of-range limits", () => {
    expect(decodeKeyCursor("!!!")).toBeNull();
    const url = new URL("https://api.handoffgraph.dev/v1/sessions?limit=0");
    expect(parseKeyPagination(url)).toMatchObject({ ok: false, status: 400 });
  });
});

// -- schema truth (real SQLite, real upserts) ---------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "0001_init.sql",
  "0002_workstream_event_projection.sql",
  "0003_account_foundation.sql",
  "0005_observations_sessions.sql",
];

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(readFileSync(resolve(testDirectory, `../migrations/${migration}`), "utf8"));
  }
  return db;
}

const INSERT_EVENT_ROW = `
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?, ?, 'k', ?, ?, ?, ?, ?, ?, 'OBSERVED', NULL, 0, ?)`;

/** Apply one ingest batch exactly as index.ts does: events, then projections. */
async function ingestBatch(
  db: DatabaseSync,
  workspaceId: string,
  events: IngestEvent[],
): Promise<void> {
  for (const raw of events) {
    db.prepare(INSERT_EVENT_ROW).run(
      workspaceId,
      String(raw.event_id),
      String(raw.occurred_at),
      (raw.workstream_id as string | undefined) ?? null,
      (raw.session_id as string | undefined) ?? null,
      (raw.native_session_id as string | undefined) ?? null,
      (raw.provider as string | undefined) ?? null,
      String(raw.kind),
      canonicalJsonStringify(raw),
    );
  }
  const projection = await buildObservationProjection(events);
  db.prepare(UPSERT_SPAN_OBSERVATIONS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.spans));
  db.prepare(UPSERT_SPAN_FINGERPRINTS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.fingerprints));
  db.prepare(UPSERT_SESSIONS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.sessions));
}

/** Re-derive every owned table from the event log, as POST /v1/admin/reindex does. */
async function rebuild(db: DatabaseSync, workspaceId: string): Promise<void> {
  db.prepare(CLEAR_SPAN_OBSERVATIONS_SQL).run(workspaceId);
  db.prepare(CLEAR_SPAN_FINGERPRINTS_SQL).run(workspaceId);
  db.prepare(CLEAR_SESSIONS_SQL).run(workspaceId);
  const rows = db
    .prepare("SELECT raw_json FROM events WHERE workspace_id = ? ORDER BY seq")
    .all(workspaceId) as Array<{ raw_json: string }>;
  const events = rows.map((row) => JSON.parse(row.raw_json) as IngestEvent);
  const projection = await buildObservationProjection(events);
  db.prepare(UPSERT_SPAN_OBSERVATIONS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.spans));
  db.prepare(UPSERT_SPAN_FINGERPRINTS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.fingerprints));
  db.prepare(UPSERT_SESSIONS_SQL)
    .run(workspaceId, canonicalJsonStringify(projection.sessions));
}

function plainRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }));
}

function snapshot(db: DatabaseSync, workspaceId: string): string {
  const spans = plainRows(
    db.prepare(`
      SELECT span_id, trace_id, parent_span_id, session_id, native_session_id,
             workstream_id, provider, agent, model, kind, name, status, status_rank,
             CAST(started_at_ns AS TEXT) AS started_at_ns, start_event_id,
             CAST(ended_at_ns AS TEXT) AS ended_at_ns, end_event_id,
             duration_ms, ts_bucket, tool_name, exit_code, token_in, token_out,
             cost_amount, cost_provenance, fingerprint, model_exists, cost_exists
      FROM span_observations WHERE workspace_id = ? ORDER BY span_id`).all(workspaceId),
  );
  const prints = plainRows(
    db.prepare(`
      SELECT fingerprint, provider, agent, repo, host, model, first_seen, last_seen
      FROM span_fingerprints WHERE workspace_id = ? ORDER BY fingerprint`).all(workspaceId),
  );
  const sessions = plainRows(
    db.prepare(`
      SELECT id, workstream_id, provider, native_session_id, first_event_at_ms,
             first_event_id, last_event_at_ms, last_event_id, event_count,
             trace_count, span_count, failed_span_count, created_at, updated_at, ts_bucket
      FROM sessions WHERE workspace_id = ? ORDER BY id`).all(workspaceId),
  );
  return canonicalJsonStringify({ prints, sessions, spans });
}

function spanBatch(): IngestEvent[] {
  return [
    event({ kind: "trace.started", payload: { trace_id: "trc_1" } }, 0),
    event({
      kind: "span.started",
      occurred_at: "2026-08-21T10:00:01Z",
      payload: { span_id: "spn_1", trace_id: "trc_1", kind: "MODEL", name: "turn" },
    }, 1),
    event({
      kind: "span.completed",
      occurred_at: "2026-08-21T10:00:04.5Z",
      payload: {
        span_id: "spn_1", trace_id: "trc_1", token_input: 120, token_output: 40,
        cost_amount: "0.0125", cost_provenance: "provider_reported",
      },
    }, 2),
    event({
      kind: "command.completed",
      occurred_at: "2026-08-21T10:40:00Z",
      payload: { span_id: "spn_2", trace_id: "trc_1", command: "go build", exit_code: 1 },
    }, 3),
  ];
}

describe("0005 observations + sessions migration", () => {
  it("applies after the prior migrations and creates the owned objects", () => {
    const db = migratedDatabase();
    const names = (
      db.prepare("SELECT name, type FROM sqlite_master ORDER BY name").all() as Array<{
        name: string;
        type: string;
      }>
    ).map((row) => row.name);
    for (const object of [
      "span_observations",
      "span_fingerprints",
      "sessions",
      "idx_span_observations_bucket",
      "idx_span_observations_trace",
      "idx_sessions_recent",
      "idx_sessions_bucket",
      "idx_events_workspace_session_kind",
      "span_observations_monotone_start",
      "span_fingerprints_immutable_labels",
    ]) {
      expect(names).toContain(object);
    }
    expect(names).not.toContain("sessions_legacy_0005");
  });

  it("stores a 30-minute ts_bucket, duration_ms, and attribute-existence flags", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    const row = db.prepare(`
      SELECT ts_bucket, duration_ms, model_exists, tool_name_exists, cost_exists, token_exists,
             CAST(started_at_ns AS TEXT) AS started_at_ns
      FROM span_observations WHERE workspace_id = ? AND span_id = 'spn_1'`)
      .get(TOKEN_WORKSPACE) as Record<string, unknown>;
    expect(row.started_at_ns).toBe("1787306401000000000");
    expect(row.ts_bucket).toBe(observationBucket("1787306401000000000"));
    // 10:00:01 -> 10:00:04.5 is 3500 ms.
    expect(row.duration_ms).toBe(3500);
    expect(row.model_exists).toBe(1);
    expect(row.tool_name_exists).toBe(0);
    expect(row.cost_exists).toBe(1);
    expect(row.token_exists).toBe(1);
  });

  it("merges a start and a completion into one row (no duplicate span identities)", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    const rows = plainRows(
      db.prepare(`
        SELECT span_id, status, status_rank, CAST(started_at_ns AS TEXT) AS s,
               CAST(ended_at_ns AS TEXT) AS e, kind, name, token_in, cost_amount, exit_code
        FROM span_observations WHERE workspace_id = ? ORDER BY span_id`).all(TOKEN_WORKSPACE),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      span_id: "spn_1",
      status: "ok",
      status_rank: 2,
      s: "1787306401000000000",
      e: "1787306404500000000",
      kind: "MODEL",
      name: "turn",
      token_in: 120,
      cost_amount: "0.0125",
    });
    expect(rows[1]).toMatchObject({ span_id: "spn_2", status: "error", exit_code: 1 });
  });

  it("is idempotent: replaying the same batch changes nothing", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    const before = snapshot(db, TOKEN_WORKSPACE);
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    expect(snapshot(db, TOKEN_WORKSPACE)).toBe(before);
  });

  it("converges on identical rows regardless of batch arrival order", async () => {
    const events = spanBatch();
    const forward = migratedDatabase();
    await ingestBatch(forward, TOKEN_WORKSPACE, [events[0], events[1]]);
    await ingestBatch(forward, TOKEN_WORKSPACE, [events[2], events[3]]);

    const reversed = migratedDatabase();
    // The completion arrives before its start; the wide row is still correct.
    await ingestBatch(reversed, TOKEN_WORKSPACE, [events[2], events[3]]);
    await ingestBatch(reversed, TOKEN_WORKSPACE, [events[0], events[1]]);

    expect(snapshot(reversed, TOKEN_WORKSPACE)).toBe(snapshot(forward, TOKEN_WORKSPACE));
  });

  it("rebuilds to exactly what incremental ingestion produced", async () => {
    const db = migratedDatabase();
    const events = spanBatch();
    await ingestBatch(db, TOKEN_WORKSPACE, events.slice(0, 2));
    await ingestBatch(db, TOKEN_WORKSPACE, events.slice(2));
    const incremental = snapshot(db, TOKEN_WORKSPACE);
    await rebuild(db, TOKEN_WORKSPACE);
    expect(snapshot(db, TOKEN_WORKSPACE)).toBe(incremental);
  });

  it("tracks sessions across multi-batch imports with absolute, never incremented, counters", async () => {
    const db = migratedDatabase();
    const events = spanBatch();
    await ingestBatch(db, TOKEN_WORKSPACE, events.slice(0, 2));
    let row = db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND id = ?")
      .get(TOKEN_WORKSPACE, SESSION) as Record<string, unknown>;
    expect(row.event_count).toBe(2);
    expect(row.trace_count).toBe(1);
    expect(row.span_count).toBe(1);

    await ingestBatch(db, TOKEN_WORKSPACE, events.slice(2));
    // Replay the first batch under a fresh key: an INCREMENT would double-count.
    await ingestBatch(db, TOKEN_WORKSPACE, events.slice(0, 2));
    row = db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND id = ?")
      .get(TOKEN_WORKSPACE, SESSION) as Record<string, unknown>;
    expect(row.event_count).toBe(4);
    expect(row.trace_count).toBe(1);
    expect(row.span_count).toBe(2);
    expect(row.failed_span_count).toBe(1);
    expect(row.first_event_at_ms).toBe(1_787_306_400_000);
    expect(row.last_event_at_ms).toBe(1_787_308_800_000);
    expect(row.created_at).toBe(1_787_306_400);
    expect(row.workstream_id).toBe(WORKSTREAM);
    expect(row.provider).toBe("claude");
    expect(row.native_session_id).toBe("claude-abc");
    expect(row.ts_bucket).toBe(sessionBucket(1_787_308_800_000));
  });

  it("refines a fallback trace id when the real start event arrives later", async () => {
    const db = migratedDatabase();
    // The completion lands first with no trace_id: the row falls back to the
    // session as its correlation handle.
    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({ kind: "span.completed", occurred_at: "2026-08-21T10:00:09Z", payload: { span_id: "spn_x" } }, 20),
    ]);
    let row = db.prepare("SELECT trace_id FROM span_observations WHERE span_id = 'spn_x'")
      .get() as { trace_id: string };
    expect(row.trace_id).toBe(SESSION);

    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({ kind: "span.started", occurred_at: "2026-08-21T10:00:03Z", payload: { span_id: "spn_x", trace_id: "trc_real" } }, 21),
    ]);
    row = db.prepare("SELECT trace_id FROM span_observations WHERE span_id = 'spn_x'")
      .get() as { trace_id: string };
    expect(row.trace_id).toBe("trc_real");
    // And the rebuild agrees, so the refinement is not arrival-order luck.
    const incremental = snapshot(db, TOKEN_WORKSPACE);
    await rebuild(db, TOKEN_WORKSPACE);
    expect(snapshot(db, TOKEN_WORKSPACE)).toBe(incremental);
  });

  it("keeps identical span ids in different workspaces apart", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    await ingestBatch(db, OTHER_WORKSPACE, spanBatch());
    const counts = db.prepare(
      "SELECT workspace_id, COUNT(*) AS n FROM span_observations GROUP BY workspace_id ORDER BY workspace_id",
    ).all() as Array<{ workspace_id: string; n: number }>;
    expect(counts).toHaveLength(2);
    expect(counts.every((row) => row.n === 2)).toBe(true);
    // Clearing one tenant leaves the other untouched.
    db.prepare(CLEAR_SPAN_OBSERVATIONS_SQL).run(TOKEN_WORKSPACE);
    const left = db.prepare("SELECT COUNT(*) AS n FROM span_observations").get() as { n: number };
    expect(left.n).toBe(2);
  });

  it("widens fingerprint bounds without ever rewriting the hashed labels", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    await ingestBatch(db, TOKEN_WORKSPACE, [
      event({ kind: "span.started", occurred_at: "2026-08-21T09:00:00Z", payload: { span_id: "spn_9" } }, 9),
    ]);
    const print = db.prepare(
      "SELECT * FROM span_fingerprints WHERE workspace_id = ?",
    ).get(TOKEN_WORKSPACE) as Record<string, unknown>;
    expect(print.first_seen).toBe(1_787_302_800_000);
    expect(print.last_seen).toBe(1_787_308_800_000);
    expect(() =>
      db.prepare("UPDATE span_fingerprints SET model = 'other' WHERE workspace_id = ?")
        .run(TOKEN_WORKSPACE),
    ).toThrow(/fingerprint label drift/);
  });

  it("aborts any update that regresses a monotone merge bound", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    expect(() =>
      db.prepare("UPDATE span_observations SET started_at_ns = started_at_ns + 1 WHERE span_id = 'spn_1'").run(),
    ).toThrow(/observation start regressed/);
    expect(() =>
      db.prepare("UPDATE span_observations SET ended_at_ns = NULL, end_event_id = NULL WHERE span_id = 'spn_1'").run(),
    ).toThrow(/observation completion regressed/);
    expect(() =>
      db.prepare("UPDATE span_observations SET status = 'running', status_rank = 1 WHERE span_id = 'spn_1'").run(),
    ).toThrow(/observation status regressed/);
    expect(() =>
      db.prepare("UPDATE sessions SET last_event_at_ms = first_event_at_ms WHERE id = ?").run(SESSION),
    ).toThrow(/session event bounds regressed/);
  });

  it("refuses an unlabelled cost, a float-shaped amount, and a bad fingerprint", () => {
    const db = migratedDatabase();
    const insert = (columns: string, values: string) =>
      db.prepare(`INSERT INTO span_observations (workspace_id, span_id, trace_id, kind, name,
        status, status_rank, started_at_ns, start_event_id, fingerprint${columns})
        VALUES ('w', 's', 't', 'TOOL', 'n', 'ok', 2, 1, 'e', '${"a".repeat(24)}'${values})`);
    expect(() => insert(", cost_amount", ", '0.5'").run()).toThrow();
    expect(() => insert(", cost_provenance", ", 'unknown'").run()).toThrow();
    expect(() =>
      insert(", cost_amount, cost_provenance", ", '0.5e3', 'provider_reported'").run(),
    ).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO span_observations (workspace_id, span_id, trace_id, kind, name,
        status, status_rank, started_at_ns, start_event_id, fingerprint)
        VALUES ('w', 's2', 't', 'TOOL', 'n', 'ok', 2, 1, 'e', 'NOTHEX')`).run(),
    ).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO span_observations (workspace_id, span_id, trace_id, kind, name,
        status, status_rank, started_at_ns, start_event_id, fingerprint)
        VALUES ('w', 's3', 't', 'TOOL', 'n', 'ok', 3, 1, 'e', '${"a".repeat(24)}')`).run(),
    ).toThrow();
  });

  it("runs the generated read queries against the real schema and prunes by ts_bucket", async () => {
    const db = migratedDatabase();
    await ingestBatch(db, TOKEN_WORKSPACE, spanBatch());
    const pagination = { limit: 50, cursor: null };
    const query = buildObservationQuery(
      TOKEN_WORKSPACE,
      new URL("https://api.handoffgraph.dev/v1/observations?since=2026-08-21T10:30:00Z"),
      pagination,
    );
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.sql).toContain("ts_bucket >=");
    const rows = plainRows(db.prepare(query.value.sql).all(...(query.value.binds as never[])));
    expect(rows.map((row) => row.span_id)).toEqual(["spn_2"]);

    const sessions = buildSessionQuery(
      TOKEN_WORKSPACE,
      new URL("https://api.handoffgraph.dev/v1/sessions?provider=claude&since=2026-08-21T10:00:00Z"),
      pagination,
    );
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) return;
    expect(sessions.value.sql).toContain("ts_bucket >=");
    const sessionRows = plainRows(
      db.prepare(sessions.value.sql).all(...(sessions.value.binds as never[])),
    );
    expect(sessionRows.map((row) => row.id)).toEqual([SESSION]);
  });
});

// -- handlers (mocked D1) -----------------------------------------------------

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown[] | Promise<unknown[]>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const record: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          record.binds = values;
          return record;
        },
        async first<T = unknown>() {
          const result = await handlers.first?.(sql, record.binds);
          return (result ?? null) as T | null;
        },
        async all<T = unknown>() {
          const results = await handlers.all?.(sql, record.binds);
          return { results: (results ?? []) as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      statements.push(record);
      return record;
    },
    async batch(batchStatements: D1BoundStatement[]) {
      batches.push(batchStatements.map((s) => s as unknown as RecordedStatement));
      return [];
    },
  };
  return { db, statements, batches };
}

const CTX = {} as never;

function makeEnv(db: D1DatabaseLike): { DB: D1DatabaseLike } {
  return { DB: db };
}

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    workspace_id: TOKEN_WORKSPACE,
    token_hash: TOKEN_HASH,
    capabilities: "ingest,read",
    revoked_at: null,
    ...overrides,
  };
}

function registry(overrides: Record<string, unknown> = {}) {
  return (sql: string): unknown => (sql.includes("FROM devices") ? deviceRow(overrides) : null);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, {
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    ...init,
  });
}

function observationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    span_id: "spn_1",
    trace_id: "trc_1",
    parent_span_id: null,
    session_id: SESSION,
    native_session_id: "claude-abc",
    workstream_id: WORKSTREAM,
    provider: "claude",
    agent: "claude-code",
    model: "opus-5",
    kind: "MODEL",
    name: "turn",
    status: "ok",
    started_at_ns: "1787306401000000000",
    ended_at_ns: "1787306404500000000",
    duration_ms: 3500,
    ts_bucket: 993_187,
    tool_name: null,
    exit_code: null,
    token_in: 120,
    token_out: 40,
    cost_amount: "0.0125",
    cost_provenance: "provider_reported",
    fingerprint: "a".repeat(24),
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION,
    workspace_id: TOKEN_WORKSPACE,
    workstream_id: WORKSTREAM,
    provider: "claude",
    native_session_id: "claude-abc",
    first_event_at_ms: 1_787_306_400_000,
    last_event_at_ms: 1_787_308_800_000,
    event_count: 4,
    trace_count: 1,
    span_count: 2,
    failed_span_count: 1,
    ts_bucket: 993_189,
    ...overrides,
  };
}

describe("worker: GET /v1/sessions", () => {
  it("returns the hosted session tracking envelope", async () => {
    const { db, statements } = mockDb({
      first: registry(),
      all: (sql) => (sql.includes("observations:query-sessions") ? [sessionRow()] : []),
    });
    const response = await worker.fetch(request("/v1/sessions"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        session_id: SESSION,
        native_session_id: "claude-abc",
        provider: "claude",
        workstream_id: WORKSTREAM,
        first_event_at_ms: 1_787_306_400_000,
        last_event_at_ms: 1_787_308_800_000,
        event_count: 4,
        trace_count: 1,
        span_count: 2,
        failed_span_count: 1,
      }],
      next_cursor: null,
    });
    const query = statements.find((s) => s.sql.includes("observations:query-sessions"));
    expect(query?.binds[0]).toBe(TOKEN_WORKSPACE);
  });

  it("binds a ts_bucket prune plus the exact predicate for since/until", async () => {
    const { db, statements } = mockDb({ first: registry(), all: () => [] });
    await worker.fetch(
      request("/v1/sessions?provider=claude&workstream=" + WORKSTREAM +
        "&since=2026-08-21T10:00:00Z&until=2026-08-21T11:00:00Z"),
      makeEnv(db),
      CTX,
    );
    const query = statements.find((s) => s.sql.includes("observations:query-sessions"));
    expect(query).toBeDefined();
    expect(query?.sql).toContain("ts_bucket >=");
    expect(query?.sql).toContain("ts_bucket <=");
    expect(query?.sql).toContain("last_event_at_ms >=");
    expect(query?.sql).toContain("last_event_at_ms <=");
    expect(query?.binds).toEqual([
      TOKEN_WORKSPACE,
      "claude",
      WORKSTREAM,
      sessionBucket(1_787_306_400_000),
      1_787_306_400_000,
      sessionBucket(1_787_310_000_000),
      1_787_310_000_000,
      51,
    ]);
  });

  it("emits a next_cursor only when the prefetch row proves another page", async () => {
    const rows = [
      sessionRow({ id: SESSION, last_event_at_ms: 3000 }),
      sessionRow({ id: SESSION_TWO, last_event_at_ms: 2000 }),
    ];
    const { db } = mockDb({ first: registry(), all: () => rows });
    const response = await worker.fetch(request("/v1/sessions?limit=1"), makeEnv(db), CTX);
    const body = await response.json() as { items: unknown[]; next_cursor: string };
    expect(body.items).toHaveLength(1);
    expect(decodeKeyCursor(body.next_cursor)).toEqual({ sort: "3000", id: SESSION });
  });

  it("rejects a malformed since (fail closed)", async () => {
    const { db } = mockDb({ first: registry(), all: () => [] });
    const response = await worker.fetch(request("/v1/sessions?since=yesterday"), makeEnv(db), CTX);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "since must be an RFC 3339 timestamp at or after 1970-01-01",
    });
  });

  it("answers 403 without the read capability and 401 without a token", async () => {
    const { db } = mockDb({ first: registry({ capabilities: "ingest" }) });
    expect((await worker.fetch(request("/v1/sessions"), makeEnv(db), CTX)).status).toBe(403);
    const anonymous = mockDb({ first: registry() });
    const response = await worker.fetch(
      new Request("https://api.handoffgraph.dev/v1/sessions"),
      makeEnv(anonymous.db),
      CTX,
    );
    expect(response.status).toBe(401);
  });
});

describe("worker: GET /v1/sessions/{id}", () => {
  it("returns the session detail with deterministic per-kind counts", async () => {
    const { db } = mockDb({
      first: (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("observations:session-detail")) return sessionRow();
        return null;
      },
      all: (sql) =>
        sql.includes("observations:session-kinds")
          ? [
              { kind: "span.started", count: 1 },
              { kind: "command.completed", count: 2 },
            ]
          : [],
    });
    const response = await worker.fetch(request(`/v1/sessions/${SESSION}`), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect((body.session as Record<string, unknown>).session_id).toBe(SESSION);
    expect(body.kind_counts).toEqual([
      { kind: "command.completed", count: 2 },
      { kind: "span.started", count: 1 },
    ]);
  });

  it("answers 404 for an unknown session and for a foreign-workspace row", async () => {
    const missing = mockDb({ first: registry() });
    expect(
      (await worker.fetch(request(`/v1/sessions/${SESSION}`), makeEnv(missing.db), CTX)).status,
    ).toBe(404);

    const foreign = mockDb({
      first: (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("observations:session-detail")) {
          return sessionRow({ workspace_id: OTHER_WORKSPACE });
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request(`/v1/sessions/${SESSION}`),
      makeEnv(foreign.db),
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});

describe("worker: GET /v1/observations", () => {
  it("emits nanosecond timestamps as strings and never as JSON numbers", async () => {
    const { db } = mockDb({
      first: registry(),
      all: (sql) => (sql.includes("observations:query-spans") ? [observationRow()] : []),
    });
    const response = await worker.fetch(request("/v1/observations"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"started_at_ns":"1787306401000000000"');
    const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
    expect(body.items[0].cost_amount).toBe("0.0125");
    expect(body.items[0].cost_provenance).toBe("provider_reported");
  });

  it("prunes by ts_bucket and keeps the exact nanosecond predicate", async () => {
    const { db, statements } = mockDb({ first: registry(), all: () => [] });
    await worker.fetch(
      request(
        "/v1/observations?workstream=" + WORKSTREAM +
        "&trace=trc_1&kind=MODEL&status=ok&has=cost" +
        "&since=2026-08-21T10:00:00Z&until=2026-08-21T11:00:00Z",
      ),
      makeEnv(db),
      CTX,
    );
    const query = statements.find((s) => s.sql.includes("observations:query-spans"));
    expect(query).toBeDefined();
    expect(query?.sql).toContain("ts_bucket >=");
    expect(query?.sql).toContain("ts_bucket <=");
    expect(query?.sql).toContain("started_at_ns >= CAST(");
    expect(query?.sql).toContain("started_at_ns <= CAST(");
    expect(query?.sql).toContain("cost_exists = 1");
    expect(query?.binds).toEqual([
      TOKEN_WORKSPACE,
      WORKSTREAM,
      "trc_1",
      "MODEL",
      "ok",
      observationBucket("1787306400000000000"),
      "1787306400000000000",
      observationBucket("1787310000000000000"),
      "1787310000000000000",
      51,
    ]);
  });

  it("paginates on the nanosecond key without passing it through a float", async () => {
    const rows = [
      observationRow({ span_id: "spn_2", started_at_ns: "1787306404000000001" }),
      observationRow({ span_id: "spn_1", started_at_ns: "1787306404000000000" }),
    ];
    const { db, statements } = mockDb({ first: registry(), all: () => rows });
    const first = await worker.fetch(request("/v1/observations?limit=1"), makeEnv(db), CTX);
    const body = await first.json() as { items: Array<Record<string, unknown>>; next_cursor: string };
    expect(body.items[0].span_id).toBe("spn_2");
    expect(decodeKeyCursor(body.next_cursor)).toEqual({
      sort: "1787306404000000001",
      id: "spn_2",
    });

    const next = mockDb({ first: registry(), all: () => [] });
    await worker.fetch(
      request(`/v1/observations?limit=1&cursor=${body.next_cursor}`),
      makeEnv(next.db),
      CTX,
    );
    const query = next.statements.find((s) => s.sql.includes("observations:query-spans"));
    expect(query?.sql).toContain("started_at_ns < CAST(");
    expect(query?.binds).toContain("1787306404000000001");
    expect(statements.length).toBeGreaterThan(0);
  });

  it("rejects an unknown status or has filter", async () => {
    const { db } = mockDb({ first: registry(), all: () => [] });
    const status = await worker.fetch(request("/v1/observations?status=weird"), makeEnv(db), CTX);
    expect(status.status).toBe(400);
    const has = await worker.fetch(request("/v1/observations?has=secrets"), makeEnv(db), CTX);
    expect(has.status).toBe(400);
  });

  it("does not let an inherited property name reach the SQL through has=", async () => {
    const { db, statements } = mockDb({ first: registry(), all: () => [] });
    const response = await worker.fetch(
      request("/v1/observations?has=constructor"),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(statements.some((s) => s.sql.includes("observations:query-spans"))).toBe(false);
  });
});

describe("worker: GET /v1/fingerprints", () => {
  it("lists the identity lookup table in fingerprint order", async () => {
    const rows = [
      { fingerprint: "b".repeat(24), workspace_id: TOKEN_WORKSPACE, provider: "codex", agent: "codex-cli", repo: "r", host: "h", model: "gpt", first_seen: 2, last_seen: 3 },
      { fingerprint: "a".repeat(24), workspace_id: TOKEN_WORKSPACE, provider: "claude", agent: "claude-code", repo: null, host: null, model: "opus-5", first_seen: 1, last_seen: 4 },
    ];
    const { db, statements } = mockDb({
      first: registry(),
      all: (sql) => (sql.includes("observations:query-fingerprints") ? rows : []),
    });
    const response = await worker.fetch(request("/v1/fingerprints"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.map((item) => item.fingerprint)).toEqual(["a".repeat(24), "b".repeat(24)]);
    expect(body.items[0]).toEqual({
      fingerprint: "a".repeat(24),
      provider: "claude",
      agent: "claude-code",
      repo: null,
      host: null,
      model: "opus-5",
      first_seen: 1,
      last_seen: 4,
    });
    const query = statements.find((s) => s.sql.includes("observations:query-fingerprints"));
    expect(query?.binds[0]).toBe(TOKEN_WORKSPACE);
  });
});

describe("worker: POST /v1/admin/reindex", () => {
  it("clears and re-derives this workspace's rows from its own events", async () => {
    const raw = spanBatch().map((source) => ({ raw_json: canonicalJsonStringify(source) }));
    const { db, batches, statements } = mockDb({
      first: registry(),
      all: (sql, binds) => {
        if (!sql.includes("observations:scan-events")) return [];
        // Page once: the second call starts after the last seq.
        return Number(binds[1]) === 0
          ? raw.map((row, index) => ({ seq: index + 1, ...row }))
          : [];
      },
    });
    const response = await worker.fetch(
      request("/v1/admin/reindex", { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    // Distinct derived rows, not delta rows: spn_1 is written by two events.
    expect(await response.json()).toEqual({
      reindexed: { events: 4, observations: 2, fingerprints: 1, sessions: 1 },
    });

    const clears = batches[0];
    expect(clears.map((s) => s.sql.includes("observations:clear-spans"))).toContain(true);
    expect(clears.every((s) => s.binds[0] === TOKEN_WORKSPACE)).toBe(true);
    // Spans must be written before sessions: the session counters read them.
    const order = batches.flat().map((s) => s.sql);
    const spanAt = order.findIndex((sql) => sql.includes("observations:upsert-spans"));
    const sessionAt = order.findIndex((sql) => sql.includes("observations:upsert-sessions"));
    expect(spanAt).toBeGreaterThanOrEqual(0);
    expect(sessionAt).toBeGreaterThan(spanAt);
    expect(statements.every((s) => !s.sql.includes("UPDATE events"))).toBe(true);
  });

  it("requires the ingest capability and rejects other methods with a 404", async () => {
    const readOnly = mockDb({ first: registry({ capabilities: "read" }) });
    const denied = await worker.fetch(
      request("/v1/admin/reindex", { method: "POST" }),
      makeEnv(readOnly.db),
      CTX,
    );
    expect(denied.status).toBe(403);

    const { db } = mockDb({ first: registry() });
    const wrongMethod = await worker.fetch(request("/v1/admin/reindex"), makeEnv(db), CTX);
    expect(wrongMethod.status).toBe(404);
  });

  it("fails closed when the workspace exceeds the rebuild ceiling", async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({
      seq: index + 1,
      raw_json: canonicalJsonStringify(event({}, index)),
    }));
    const { db } = mockDb({
      first: registry(),
      all: (sql) => (sql.includes("observations:scan-events") ? page : []),
    });
    const response = await worker.fetch(
      request("/v1/admin/reindex", { method: "POST" }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: `workspace exceeds the ${MAX_REINDEX_EVENTS}-event rebuild ceiling`,
      code: "reindex_too_large",
    });
  });
});
