// Unit tests for src/artifacts.ts — artifact tiering (row 14), batch export
// (row 46), and derived-model retention (row 15).
//
// No miniflare: D1 is the structural seam from src/db.ts and R2 is the
// structural R2BucketLike from src/artifacts.ts, so plain objects suffice.
// Schema truth is checked directly against node:sqlite.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "./advanced_worker";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";
import {
  COMPACTION_AGE_SECONDS,
  COMPACTION_SIZE_BYTES,
  EXPORT_PAGE_SIZE,
  NEVER_RETAINED_TABLES,
  RETENTION_MAX_TTL_DAYS,
  RETENTION_MIN_TTL_DAYS,
  RETENTION_TARGET_TABLES,
  artifactObjectKey,
  artifactsScheduled,
  buildEventJsonl,
  exportObjectKey,
  exportParamsJson,
  parseExportParams,
  parseRetentionUpdate,
  retentionSweep,
  runCompaction,
  type ArtifactsEnv,
  type EventSpineRow,
  type R2BucketLike,
  type R2ListOptionsLike,
  type R2ObjectBodyLike,
  type R2PutOptionsLike,
} from "../src/artifacts";

// -- fixtures ------------------------------------------------------------------

const TOKEN_WORKSPACE = `wsp_01HTSTW0RKSPACE0000000000Z`;
const OTHER_WORKSPACE = `wsp_01HTSTW0RKSPEER0000000000Z`;
const DEVICE_TOKEN = "dev_artifacts-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const WORKSTREAM_ID = `ws_01HTSTW${"0".repeat(19)}`;
const OTHER_WORKSTREAM_ID = `ws_01HTSTX${"0".repeat(19)}`;
const EXPORT_ID = `exp_01J${"A".repeat(23)}`;
const UTF8 = new TextEncoder();
const CTX = {} as never; // ExecutionContext stub (unused by handlers)
const CONTROLLER = {
  scheduledTime: 0,
  cron: "*/10 * * * *",
  noRetry() {},
} as ScheduledController;

let TOKEN_HASH = "";
beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

function eventId(i: number): string {
  const head = `01HTEST${String(i).padStart(4, "0")}`;
  return `evt_${head}${"0".repeat(26 - head.length - 1)}Z`;
}

function spineRow(seq: number, overrides: Partial<EventSpineRow> = {}): EventSpineRow {
  return {
    seq,
    workspace_id: TOKEN_WORKSPACE,
    event_id: eventId(seq),
    idempotency_key: `key-${seq}`,
    occurred_at: `2026-08-2${(seq % 9) + 1}T00:00:0${seq % 10}Z`,
    workstream_id: WORKSTREAM_ID,
    session_id: null,
    native_session_id: null,
    provider: "claude",
    kind: "workstream.started",
    provenance: "OBSERVED",
    content_hash: null,
    ingested_at: 1_700_000_000 + seq,
    raw_json: canonicalJsonStringify({ event_id: eventId(seq), kind: "workstream.started" }),
    ...overrides,
  };
}

// -- fakes ----------------------------------------------------------------------

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

interface MockHandlers {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown[] | Promise<unknown[]>;
  run?: (sql: string, binds: unknown[]) => { changes?: number } | void;
}

function mockDb(handlers: MockHandlers = {}) {
  const statements: RecordedStatement[] = [];
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
          return ((await handlers.first?.(sql, record.binds)) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: ((await handlers.all?.(sql, record.binds)) ?? []) as T[] };
        },
        async run() {
          const meta = handlers.run?.(sql, record.binds);
          return { success: true, meta: { changes: meta?.changes ?? 0 } };
        },
      };
      statements.push(record);
      return record;
    },
    async batch() {
      return [];
    },
  };
  return { db, statements };
}

function fakeBucket(options: { stream?: boolean } = {}) {
  const objects = new Map<string, { value: string; options?: R2PutOptionsLike }>();
  const puts: string[] = [];
  const deletes: string[] = [];
  const bucket: R2BucketLike & {
    head(key: string): Promise<{ key: string } | null>;
  } = {
    async head(key: string) {
      return objects.has(key) ? { key } : null;
    },
    async put(key: string, value: string, putOptions?: R2PutOptionsLike) {
      objects.set(key, { value, options: putOptions });
      puts.push(key);
      return {};
    },
    async get(key: string): Promise<R2ObjectBodyLike | null> {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      return {
        body: options.stream === true ? new Response(stored.value).body : undefined,
        size: UTF8.encode(stored.value).byteLength,
        async text() {
          return stored.value;
        },
      };
    },
    async delete(key: string) {
      objects.delete(key);
      deletes.push(key);
    },
    async list(listOptions: R2ListOptionsLike) {
      const prefix = listOptions.prefix ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const limited = listOptions.limit === undefined ? keys : keys.slice(0, listOptions.limit);
      return { objects: limited.map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, objects, puts, deletes };
}

/** Device registry mock: the test token resolves, everything else misses. */
function deviceRegistry(overrides: Record<string, unknown> = {}) {
  return (sql: string): unknown => {
    if (sql.includes("FROM devices")) {
      return {
        id: DEVICE_ID,
        workspace_id: TOKEN_WORKSPACE,
        token_hash: TOKEN_HASH,
        capabilities: "ingest,read",
        revoked_at: null,
        ...overrides,
      };
    }
    return null;
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
}

function firstKeyword(sql: string): string {
  return stripComments(sql).split(/\s+/)[0].toUpperCase();
}

/**
 * The spine is append-only: every recorded statement that names `events` must
 * be a SELECT, and nothing may DELETE from or UPDATE it.
 */
function assertSpineUntouched(statements: RecordedStatement[]): void {
  for (const statement of statements) {
    const sql = stripComments(statement.sql);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+events/i);
    expect(sql).not.toMatch(/UPDATE\s+events/i);
    if (/\bevents\b/i.test(sql)) expect(firstKeyword(sql)).toBe("SELECT");
  }
}

function withMarker(statements: RecordedStatement[], marker: string): RecordedStatement[] {
  return statements.filter((statement) => statement.sql.includes(marker));
}

// -- an in-memory spine that answers the compaction queries ---------------------

interface FileListRow {
  workspace_id: string;
  object_key: string;
  event_count: number;
  byte_size: number;
  min_seq: number;
  max_seq: number;
  min_occurred_at: string;
  max_occurred_at: string;
  content_sha256: string;
  created_at: number;
}

function spineDb(events: EventSpineRow[], options: { reversePages?: boolean } = {}) {
  const fileList: FileListRow[] = [];
  const watermark = (workspaceId: string): number =>
    fileList
      .filter((row) => row.workspace_id === workspaceId)
      .reduce((max, row) => Math.max(max, row.max_seq), 0);

  const mock = mockDb({
    all(sql, binds) {
      if (sql.includes("artifacts:compaction-candidates")) {
        const [sizeBytes, ageCutoff, limit] = binds as [number, number, number];
        const groups = new Map<string, EventSpineRow[]>();
        for (const event of events) {
          if (event.seq <= watermark(event.workspace_id)) continue;
          const bucket = groups.get(event.workspace_id) ?? [];
          bucket.push(event);
          groups.set(event.workspace_id, bucket);
        }
        return [...groups.entries()]
          .map(([workspaceId, rows]) => ({
            workspace_id: workspaceId,
            min_seq: Math.min(...rows.map((row) => row.seq)),
            pending_events: rows.length,
            pending_bytes: rows.reduce(
              (total, row) => total + UTF8.encode(row.raw_json).byteLength,
              0,
            ),
            oldest_ingested_at: Math.min(...rows.map((row) => row.ingested_at)),
          }))
          .filter(
            (row) => row.pending_bytes >= sizeBytes || row.oldest_ingested_at <= ageCutoff,
          )
          .sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : 1))
          .slice(0, limit);
      }
      if (sql.includes("artifacts:compaction-page")) {
        const [workspaceId, cursor, limit] = binds as [string, number, number];
        const page = events
          .filter((event) => event.workspace_id === workspaceId && event.seq > cursor)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit);
        // Storage order is not response order: hand pages back reversed so the
        // compactor's own sort is what makes the object deterministic.
        return options.reversePages === true ? [...page].reverse() : page;
      }
      return [];
    },
    run(sql, binds) {
      if (sql.includes("artifacts:insert-file-list")) {
        const [
          workspaceId,
          objectKey,
          eventCount,
          byteSize,
          minSeq,
          maxSeq,
          minOccurredAt,
          maxOccurredAt,
          contentSha256,
          createdAt,
        ] = binds as [string, string, number, number, number, number, string, string, string, number];
        const duplicate = fileList.some(
          (row) =>
            row.workspace_id === workspaceId && row.min_seq === minSeq && row.max_seq === maxSeq,
        );
        if (!duplicate) {
          fileList.push({
            workspace_id: workspaceId,
            object_key: objectKey,
            event_count: eventCount,
            byte_size: byteSize,
            min_seq: minSeq,
            max_seq: maxSeq,
            min_occurred_at: minOccurredAt,
            max_occurred_at: maxOccurredAt,
            content_sha256: contentSha256,
            created_at: createdAt,
          });
        }
        return { changes: duplicate ? 0 : 1 };
      }
      return { changes: 0 };
    },
  });
  return { ...mock, fileList };
}

// -- migration truth ------------------------------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(testDirectory, "../migrations");

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(resolve(migrationsDirectory, file), "utf8"));
  }
  return db;
}

function insertArtifact(db: DatabaseSync, overrides: Partial<FileListRow> = {}): void {
  const row: FileListRow = {
    workspace_id: TOKEN_WORKSPACE,
    object_key: `artifacts/${TOKEN_WORKSPACE}/art_${"a".repeat(32)}.jsonl`,
    event_count: 2,
    byte_size: 128,
    min_seq: 1,
    max_seq: 2,
    min_occurred_at: "2026-08-21T00:00:00Z",
    max_occurred_at: "2026-08-22T00:00:00Z",
    content_sha256: "b".repeat(64),
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO artifact_file_list
      (workspace_id, object_key, event_count, byte_size, min_seq, max_seq,
       min_occurred_at, max_occurred_at, content_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspace_id,
    row.object_key,
    row.event_count,
    row.byte_size,
    row.min_seq,
    row.max_seq,
    row.min_occurred_at,
    row.max_occurred_at,
    row.content_sha256,
    row.created_at,
  );
}

function insertEvent(db: DatabaseSync, seq: number): void {
  db.prepare(`
    INSERT INTO events (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json)
    VALUES (?, ?, '2026-08-21T00:00:00Z', 'workstream.started', 1700000000, ?)
  `).run(TOKEN_WORKSPACE, eventId(seq), `{"event_id":"${eventId(seq)}"}`);
}

describe("0006 artifacts/exports migration", () => {
  it("creates the tiering, export, and retention tables with their guards", () => {
    const db = migratedDatabase();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const table of ["artifact_file_list", "exports", "retention_policies"]) {
      expect(tables).toContain(table);
    }
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const trigger of [
      "artifact_file_list_reject_update",
      "artifact_file_list_reject_delete",
      "exports_terminal_status_is_final",
      "exports_identity_is_immutable",
      "events_reject_update",
      "events_reject_delete",
    ]) {
      expect(triggers).toContain(trigger);
    }
    db.close();
  });

  it("makes the event spine structurally append-only", () => {
    const db = migratedDatabase();
    insertEvent(db, 1);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow(/append-only/);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it("keeps artifact index rows immutable and undeletable", () => {
    const db = migratedDatabase();
    insertArtifact(db);
    expect(() => db.prepare("UPDATE artifact_file_list SET byte_size = 1").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare("DELETE FROM artifact_file_list").run()).toThrow(/never deleted/);
    db.close();
  });

  it("rejects a duplicate seq range and a foreign object prefix", () => {
    const db = migratedDatabase();
    insertArtifact(db);
    // Same (workspace, min_seq, max_seq) under a different key: compaction is
    // idempotent by construction.
    expect(() =>
      insertArtifact(db, { object_key: `artifacts/${TOKEN_WORKSPACE}/art_${"c".repeat(32)}.jsonl` }),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      insertArtifact(db, {
        min_seq: 3,
        max_seq: 4,
        object_key: `artifacts/${OTHER_WORKSPACE}/art_${"d".repeat(32)}.jsonl`,
      }),
    ).toThrow(/CHECK/i);
    // A disjoint range in the right prefix is accepted.
    insertArtifact(db, {
      min_seq: 3,
      max_seq: 4,
      object_key: `artifacts/${TOKEN_WORKSPACE}/art_${"e".repeat(32)}.jsonl`,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM artifact_file_list").get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it("enforces the export manifest and terminal-status invariants", () => {
    const db = migratedDatabase();
    const insert = db.prepare(`
      INSERT INTO exports (id, workspace_id, status, params_json, created_at)
      VALUES (?, ?, 'running', ?, 100)
    `);
    expect(() => insert.run(EXPORT_ID, TOKEN_WORKSPACE, "not json")).toThrow(/CHECK/i);
    insert.run(EXPORT_ID, TOKEN_WORKSPACE, '{"full":true}');

    // 'done' without a manifest is impossible.
    expect(() =>
      db.prepare("UPDATE exports SET status = 'done' WHERE id = ?").run(EXPORT_ID),
    ).toThrow(/CHECK/i);
    // Identity never moves.
    expect(() =>
      db.prepare("UPDATE exports SET workspace_id = ? WHERE id = ?").run(OTHER_WORKSPACE, EXPORT_ID),
    ).toThrow(/identity is immutable/);

    db.prepare(`
      UPDATE exports
      SET status = 'done', object_key = ?, byte_size = 10, event_count = 1,
          sha256 = ?, completed_at = 200
      WHERE id = ?
    `).run(`exports/${TOKEN_WORKSPACE}/${EXPORT_ID}.ndjson`, "f".repeat(64), EXPORT_ID);

    // Terminal rows never change again.
    expect(() =>
      db.prepare("UPDATE exports SET status = 'error' WHERE id = ?").run(EXPORT_ID),
    ).toThrow(/terminal/);
    db.close();
  });

  it("enforces the retention floor and ceiling in-schema", () => {
    const db = migratedDatabase();
    const insert = db.prepare(`
      INSERT INTO retention_policies (workspace_id, derived_ttl_days, created_at, updated_at)
      VALUES (?, ?, 100, 100)
    `);
    expect(() => insert.run(TOKEN_WORKSPACE, RETENTION_MIN_TTL_DAYS - 1)).toThrow(/CHECK/i);
    expect(() => insert.run(TOKEN_WORKSPACE, RETENTION_MAX_TTL_DAYS + 1)).toThrow(/CHECK/i);
    insert.run(TOKEN_WORKSPACE, RETENTION_MIN_TTL_DAYS);
    insert.run(OTHER_WORKSPACE, null);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM retention_policies").get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });
});

// -- deterministic encoding -----------------------------------------------------

describe("artifact encoding", () => {
  it("emits one canonical line per row ordered by seq regardless of input order", () => {
    const rows = [spineRow(3), spineRow(1), spineRow(2)];
    const jsonl = buildEventJsonl(rows);
    const shuffled = buildEventJsonl([rows[2], rows[0], rows[1]]);
    expect(jsonl).toBe(shuffled);
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([1, 2, 3]);
    // Canonical JSON: keys sorted, no whitespace.
    expect(lines[0].startsWith('{"content_hash":')).toBe(true);
  });

  it("returns empty content for no rows", () => {
    expect(buildEventJsonl([])).toBe("");
  });

  it("derives object keys from the seq range, not from a fresh id", async () => {
    const first = await artifactObjectKey(TOKEN_WORKSPACE, 1, 10);
    const again = await artifactObjectKey(TOKEN_WORKSPACE, 1, 10);
    const other = await artifactObjectKey(TOKEN_WORKSPACE, 1, 11);
    const foreign = await artifactObjectKey(OTHER_WORKSPACE, 1, 10);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).not.toBe(foreign);
    expect(first).toMatch(
      new RegExp(`^artifacts/${TOKEN_WORKSPACE}/art_[0-9a-f]{32}\\.jsonl$`),
    );
    expect(exportObjectKey(TOKEN_WORKSPACE, EXPORT_ID)).toBe(
      `exports/${TOKEN_WORKSPACE}/${EXPORT_ID}.ndjson`,
    );
  });
});

// -- compaction ------------------------------------------------------------------

const NOW = 1_800_000_000;

function compactionEnv(events: EventSpineRow[], options: { reversePages?: boolean } = {}) {
  const store = spineDb(events, options);
  const r2 = fakeBucket();
  const env: ArtifactsEnv = { DB: store.db, BODIES: r2.bucket };
  return { ...store, ...r2, env };
}

describe("runCompaction", () => {
  it("writes a deterministic object and indexes it without touching the spine", async () => {
    const events = [spineRow(1), spineRow(2), spineRow(3)];
    const { env, statements, fileList, objects, puts } = compactionEnv(events);

    const summary = await runCompaction(env, { nowSeconds: NOW });

    expect(summary).toMatchObject({ workspaces: 1, objects: 1, events: 3 });
    const key = await artifactObjectKey(TOKEN_WORKSPACE, 1, 3);
    expect(puts).toEqual([key]);
    expect(summary.object_keys).toEqual([key]);

    const expected = buildEventJsonl(events);
    expect(objects.get(key)?.value).toBe(expected);
    expect(summary.bytes).toBe(UTF8.encode(expected).byteLength);

    const occurred = events.map((event) => event.occurred_at).sort();
    expect(fileList).toHaveLength(1);
    expect(fileList[0]).toEqual({
      workspace_id: TOKEN_WORKSPACE,
      object_key: key,
      event_count: 3,
      byte_size: UTF8.encode(expected).byteLength,
      min_seq: 1,
      max_seq: 3,
      min_occurred_at: occurred[0],
      max_occurred_at: occurred[occurred.length - 1],
      content_sha256: await sha256Hex(expected),
      created_at: NOW,
    });

    assertSpineUntouched(statements);
    expect(withMarker(statements, "artifacts:compaction-page")).not.toHaveLength(0);
  });

  it("produces byte-identical objects when D1 hands pages back in storage order", async () => {
    const events = [spineRow(1), spineRow(2), spineRow(3)];
    const forward = compactionEnv(events);
    const reversed = compactionEnv(events, { reversePages: true });
    await runCompaction(forward.env, { nowSeconds: NOW });
    await runCompaction(reversed.env, { nowSeconds: NOW });
    const key = await artifactObjectKey(TOKEN_WORKSPACE, 1, 3);
    expect(reversed.objects.get(key)?.value).toBe(forward.objects.get(key)?.value);
    expect(reversed.fileList[0].content_sha256).toBe(forward.fileList[0].content_sha256);
  });

  it("is idempotent: re-running writes no new object and no duplicate index row", async () => {
    const events = [spineRow(1), spineRow(2)];
    const { env, fileList, puts, statements } = compactionEnv(events);
    await runCompaction(env, { nowSeconds: NOW });
    const afterFirst = [...puts];

    const second = await runCompaction(env, { nowSeconds: NOW });
    expect(second.objects).toBe(0);
    expect(puts).toEqual(afterFirst);
    expect(fileList).toHaveLength(1);
    assertSpineUntouched(statements);
  });

  it("re-running over an already-written range rewrites nothing", async () => {
    // Force the candidate query to keep offering a compacted range (a broken
    // watermark) and prove the R2 existence probe plus INSERT OR IGNORE still
    // converge on exactly one object.
    const events = [spineRow(1), spineRow(2)];
    const r2 = fakeBucket();
    const fileList: FileListRow[] = [];
    const { db } = mockDb({
      all(sql, binds) {
        if (sql.includes("artifacts:compaction-candidates")) {
          return [
            {
              workspace_id: TOKEN_WORKSPACE,
              min_seq: 1,
              pending_events: 2,
              pending_bytes: 100,
              oldest_ingested_at: 0,
            },
          ];
        }
        if (sql.includes("artifacts:compaction-page")) {
          const [, cursor, limit] = binds as [string, number, number];
          return events.filter((event) => event.seq > cursor).slice(0, limit);
        }
        return [];
      },
      run(sql, binds) {
        if (sql.includes("artifacts:insert-file-list")) {
          const [workspaceId, objectKey, , , minSeq, maxSeq] = binds as [
            string,
            string,
            number,
            number,
            number,
            number,
          ];
          const duplicate = fileList.some(
            (row) => row.min_seq === minSeq && row.max_seq === maxSeq,
          );
          if (!duplicate) {
            fileList.push({ ...({} as FileListRow), workspace_id: workspaceId, object_key: objectKey, min_seq: minSeq, max_seq: maxSeq });
          }
          return { changes: duplicate ? 0 : 1 };
        }
        return { changes: 0 };
      },
    });
    const env: ArtifactsEnv = { DB: db, BODIES: r2.bucket };
    await runCompaction(env, { nowSeconds: NOW });
    await runCompaction(env, { nowSeconds: NOW });
    const key = await artifactObjectKey(TOKEN_WORKSPACE, 1, 2);
    expect(r2.puts).toEqual([key]); // second run found the object already present
    expect(fileList).toHaveLength(1);
    expect(r2.objects.size).toBe(1);
  });

  it("splits a long run into bounded objects with contiguous seq ranges", async () => {
    const events = [1, 2, 3, 4, 5].map((seq) => spineRow(seq));
    const { env, fileList, puts } = compactionEnv(events);
    const summary = await runCompaction(env, { nowSeconds: NOW, maxEventsPerObject: 2 });
    expect(summary.objects).toBe(3);
    expect(summary.events).toBe(5);
    expect(fileList.map((row) => [row.min_seq, row.max_seq])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    expect(new Set(puts).size).toBe(3);
    expect(summary.object_keys).toEqual([...summary.object_keys].sort());
  });

  it("stops at the per-run object budget", async () => {
    const events = [1, 2, 3, 4, 5, 6].map((seq) => spineRow(seq));
    const { env } = compactionEnv(events);
    const summary = await runCompaction(env, {
      nowSeconds: NOW,
      maxEventsPerObject: 2,
      maxObjects: 2,
    });
    expect(summary.objects).toBe(2);
    expect(summary.events).toBe(4);
  });

  it("applies the age and size triggers at their exact boundaries", async () => {
    const fresh = [spineRow(1, { ingested_at: NOW - COMPACTION_AGE_SECONDS + 1 })];
    const belowBoth = compactionEnv(fresh);
    const quiet = await runCompaction(belowBoth.env, { nowSeconds: NOW });
    expect(quiet.objects).toBe(0);
    expect(belowBoth.puts).toEqual([]);
    // The candidate query really was asked with the documented thresholds.
    const candidates = withMarker(belowBoth.statements, "artifacts:compaction-candidates");
    expect(candidates[0].binds[0]).toBe(COMPACTION_SIZE_BYTES);
    expect(candidates[0].binds[1]).toBe(NOW - COMPACTION_AGE_SECONDS);

    // Exactly at the age boundary: eligible.
    const aged = compactionEnv([spineRow(1, { ingested_at: NOW - COMPACTION_AGE_SECONDS })]);
    expect((await runCompaction(aged.env, { nowSeconds: NOW })).objects).toBe(1);

    // Under the age trigger but exactly at the size trigger: eligible.
    const bulky = compactionEnv([
      spineRow(1, { ingested_at: NOW, raw_json: `"${"x".repeat(COMPACTION_SIZE_BYTES - 2)}"` }),
    ]);
    expect((await runCompaction(bulky.env, { nowSeconds: NOW })).objects).toBe(1);
  });

  it("compacts each workspace independently and in a stable order", async () => {
    const events = [
      spineRow(1),
      spineRow(2, { workspace_id: OTHER_WORKSPACE }),
      spineRow(3),
    ];
    const { env, fileList } = compactionEnv(events);
    const summary = await runCompaction(env, { nowSeconds: NOW });
    expect(summary.workspaces).toBe(2);
    expect(summary.objects).toBe(2);
    expect(fileList.map((row) => row.workspace_id).sort()).toEqual(
      [OTHER_WORKSPACE, TOKEN_WORKSPACE].sort(),
    );
    for (const row of fileList) {
      expect(row.object_key.startsWith(`artifacts/${row.workspace_id}/`)).toBe(true);
    }
  });

  it("fails closed when object storage is not configured", async () => {
    const { db } = mockDb();
    await expect(runCompaction({ DB: db })).rejects.toThrow(/BODIES/);
  });
});

// -- retention --------------------------------------------------------------------

function retentionDb(
  policies: Array<{ workspace_id: string; derived_ttl_days: number }>,
  schema: Array<{ name: string; sql: string | null }>,
  changes = 2,
) {
  return mockDb({
    all(sql) {
      if (sql.includes("artifacts:retention-policies")) return policies;
      if (sql.includes("artifacts:probe-derived-tables")) return schema;
      return [];
    },
    run() {
      return { changes };
    },
  });
}

const TRACES_DDL = "CREATE TABLE traces (trace_id TEXT, workspace_id TEXT, started_at_ns INTEGER)";
const SPANS_DDL = "CREATE TABLE spans (span_id TEXT, workspace_id TEXT, started_at_ns INTEGER)";

/** A D1 seam that actually executes SQL, so schema drift cannot hide. */
function sqliteBackedDb(sqlite: DatabaseSync) {
  const statements: RecordedStatement[] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const binds = () => record.binds as Array<string | number | bigint | null>;
      const record: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          record.binds = values;
          return record;
        },
        async first<T = unknown>() {
          return (sqlite.prepare(sql).get(...binds()) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: sqlite.prepare(sql).all(...binds()) as T[] };
        },
        async run() {
          const info = sqlite.prepare(sql).run(...binds());
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      statements.push(record);
      return record;
    },
    async batch() {
      return [];
    },
  };
  return { db, statements };
}

/** migration 0005: started_at_ns is unix NANOSECONDS, past the safe-integer range. */
function insertObservation(
  db: DatabaseSync,
  suffix: string,
  seconds: number,
  workspaceId: string = TOKEN_WORKSPACE,
): void {
  db.prepare(`
    INSERT INTO span_observations
      (workspace_id, span_id, trace_id, kind, name, status, status_rank,
       started_at_ns, start_event_id, fingerprint)
    VALUES (?, ?, ?, 'tool', 'bash', 'ok', 2, ?, ?, ?)
  `).run(
    workspaceId,
    `spn_${suffix}`,
    `trc_${suffix}`,
    BigInt(seconds) * 1_000_000_000n,
    eventId(1),
    "a".repeat(24),
  );
}

/** migration 0005: first_seen/last_seen are unix MILLISECONDS. */
function insertFingerprint(db: DatabaseSync, fingerprint: string, seconds: number): void {
  db.prepare(`
    INSERT INTO span_fingerprints (workspace_id, fingerprint, first_seen, last_seen)
    VALUES (?, ?, ?, ?)
  `).run(TOKEN_WORKSPACE, fingerprint, 0, seconds * 1000);
}

function spanIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT span_id FROM span_observations ORDER BY span_id").all() as Array<{
      span_id: string;
    }>
  ).map((row) => row.span_id);
}

function fingerprintIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT fingerprint FROM span_fingerprints ORDER BY fingerprint").all() as Array<{
      fingerprint: string;
    }>
  ).map((row) => row.fingerprint);
}

/** Canonical bytes of a whole table, for an exact before/after comparison. */
function snapshot(db: DatabaseSync, sql: string): string {
  return (db.prepare(sql).all() as Array<Record<string, unknown>>)
    .map((row) => canonicalJsonStringify({ ...row }))
    .join("\n");
}

describe("retentionSweep", () => {
  it("deletes only derived read models, never the spine or the artifact index", async () => {
    const { db, statements } = retentionDb(
      [{ workspace_id: TOKEN_WORKSPACE, derived_ttl_days: 30 }],
      [
        { name: "spans", sql: SPANS_DDL },
        { name: "traces", sql: TRACES_DDL },
      ],
    );
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });

    expect(summary.workspaces).toBe(1);
    expect(summary.swept_tables).toEqual(["spans", "traces"]);
    expect(summary.skipped_tables).toEqual(["span_fingerprints", "span_observations"]);
    expect(summary.deleted).toBe(4);

    const deletes = statements.filter((statement) => firstKeyword(statement.sql) === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(deletes.map((statement) => /DELETE FROM (\w+)/.exec(stripComments(statement.sql))?.[1])).toEqual([
      "traces",
      "spans",
    ]);
    const cutoff = NOW - 30 * 86_400;
    for (const statement of deletes) {
      expect(statement.binds).toEqual([TOKEN_WORKSPACE, cutoff]);
    }
    assertSpineUntouched(statements);
    for (const statement of statements) {
      for (const table of NEVER_RETAINED_TABLES) {
        expect(stripComments(statement.sql)).not.toMatch(
          new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"),
        );
      }
    }
  });

  it("skips derived tables a sibling slice has not created yet", async () => {
    const { db, statements } = retentionDb(
      [{ workspace_id: TOKEN_WORKSPACE, derived_ttl_days: 14 }],
      [{ name: "traces", sql: TRACES_DDL }],
    );
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });
    expect(summary.swept_tables).toEqual(["traces"]);
    expect(summary.skipped_tables).toEqual(["span_fingerprints", "span_observations", "spans"]);
    expect(statements.filter((statement) => firstKeyword(statement.sql) === "DELETE")).toHaveLength(1);
  });

  it("skips a table whose cutoff column is absent from the live DDL", async () => {
    const { db } = retentionDb(
      [{ workspace_id: TOKEN_WORKSPACE, derived_ttl_days: 14 }],
      [
        { name: "traces", sql: TRACES_DDL },
        { name: "span_observations", sql: "CREATE TABLE span_observations (workspace_id TEXT)" },
      ],
    );
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });
    expect(summary.skipped_tables).toContain("span_observations");
    expect(summary.swept_tables).toEqual(["traces"]);
  });

  it("does nothing, and does not even probe the schema, without a policy", async () => {
    const { db, statements } = retentionDb([], [{ name: "traces", sql: TRACES_DDL }]);
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });
    expect(summary).toEqual({ workspaces: 0, deleted: 0, swept_tables: [], skipped_tables: [] });
    expect(withMarker(statements, "artifacts:probe-derived-tables")).toHaveLength(0);
  });

  it("ignores a stored TTL below the policy floor", async () => {
    const { db, statements } = retentionDb(
      [{ workspace_id: TOKEN_WORKSPACE, derived_ttl_days: RETENTION_MIN_TTL_DAYS - 1 }],
      [{ name: "traces", sql: TRACES_DDL }],
    );
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });
    expect(summary.workspaces).toBe(0);
    expect(statements.filter((statement) => firstKeyword(statement.sql) === "DELETE")).toHaveLength(0);
  });

  it("names a real column of the live schema for every declared target", () => {
    // The existence probe cannot tell a typo from "a sibling slice has not
    // shipped this yet": both are skipped silently. So the target list is
    // checked against the migrated schema directly — a wrong table or column
    // name here is a no-op sweep, not a failure anyone would notice.
    const db = migratedDatabase();
    const declared = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table'
           AND name IN ('traces', 'spans', 'span_observations', 'span_fingerprints')`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(declared.map((row) => row.name).sort()).toEqual([...RETENTION_TARGET_TABLES].sort());

    for (const { name, sql } of declared) {
      const columns = (
        db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{ name: string }>
      ).map((row) => row.name);
      // Every target is workspace-scoped, and its cutoff column exists.
      expect(columns).toContain("workspace_id");
      const cutoff = /span_fingerprints/.test(name) ? "last_seen" : "started_at_ns";
      expect(columns).toContain(cutoff);
      expect(sql).toContain(cutoff);
    }
    db.close();
  });

  it("prunes derived rows past the TTL against the real migrations, sparing the spine", async () => {
    // The mocked D1 never executes SQL, so this drives the real sweep over a
    // really-migrated database: it is the only thing that catches a target
    // naming a table or column the schema does not have.
    const sqlite = migratedDatabase();
    const ttlDays = 30;
    const cutoffSeconds = NOW - ttlDays * 86_400;
    const oldSeconds = cutoffSeconds - 86_400;
    const newSeconds = cutoffSeconds + 86_400;

    sqlite
      .prepare(
        `INSERT INTO retention_policies (workspace_id, derived_ttl_days, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(TOKEN_WORKSPACE, ttlDays, NOW, NOW);
    insertEvent(sqlite, 1);
    insertEvent(sqlite, 2);
    insertArtifact(sqlite);
    insertObservation(sqlite, "old", oldSeconds);
    insertObservation(sqlite, "new", newSeconds);
    insertFingerprint(sqlite, "a".repeat(24), oldSeconds);
    insertFingerprint(sqlite, "b".repeat(24), newSeconds);
    // A row from another workspace, older than any cutoff: never in scope.
    insertObservation(sqlite, "other", oldSeconds, OTHER_WORKSPACE);

    const spineBefore = snapshot(sqlite, "SELECT * FROM events ORDER BY seq");
    const indexBefore = snapshot(sqlite, "SELECT * FROM artifact_file_list ORDER BY object_key");

    const { db, statements } = sqliteBackedDb(sqlite);
    const summary = await retentionSweep({ DB: db }, { nowSeconds: NOW });

    expect(summary.workspaces).toBe(1);
    expect(summary.swept_tables).toEqual([...RETENTION_TARGET_TABLES].sort());
    expect(summary.skipped_tables).toEqual([]);
    expect(summary.deleted).toBe(2); // one observation, one fingerprint

    expect(spanIds(sqlite)).toEqual([`spn_new`, `spn_other`]);
    expect(fingerprintIds(sqlite)).toEqual(["b".repeat(24)]);

    // The spine and the artifact index are byte-identical across the sweep.
    expect(snapshot(sqlite, "SELECT * FROM events ORDER BY seq")).toBe(spineBefore);
    expect(snapshot(sqlite, "SELECT * FROM artifact_file_list ORDER BY object_key")).toBe(
      indexBefore,
    );
    assertSpineUntouched(statements);
    sqlite.close();
  });

  it("sweeps workspaces in a stable order", async () => {
    const { db, statements } = retentionDb(
      [
        { workspace_id: OTHER_WORKSPACE, derived_ttl_days: 7 },
        { workspace_id: TOKEN_WORKSPACE, derived_ttl_days: 7 },
      ],
      [{ name: "traces", sql: TRACES_DDL }],
    );
    await retentionSweep({ DB: db }, { nowSeconds: NOW });
    const swept = statements
      .filter((statement) => firstKeyword(statement.sql) === "DELETE")
      .map((statement) => statement.binds[0]);
    expect(swept).toEqual([...swept].sort());
  });
});

// -- scheduled dispatcher ----------------------------------------------------------

describe("artifactsScheduled", () => {
  it("isolates a failing sweep from the other", async () => {
    const seen: string[] = [];
    const { db } = mockDb({
      all(sql) {
        if (sql.includes("artifacts:compaction-candidates")) {
          seen.push("compaction");
          throw new Error("d1 unavailable");
        }
        if (sql.includes("artifacts:retention-policies")) {
          seen.push("retention");
          return [];
        }
        return [];
      },
    });
    const { bucket } = fakeBucket();
    await expect(artifactsScheduled({ DB: db, BODIES: bucket })).resolves.toBeUndefined();
    expect(seen).toEqual(["compaction", "retention"]);
  });

  it("is reachable through the worker's scheduled export", async () => {
    const { db, statements } = mockDb();
    const { bucket } = fakeBucket();
    await worker.scheduled(CONTROLLER, { DB: db, BODIES: bucket }, CTX);
    expect(withMarker(statements, "artifacts:compaction-candidates")).toHaveLength(1);
    expect(withMarker(statements, "artifacts:retention-policies")).toHaveLength(1);
    assertSpineUntouched(statements);
  });

  it("never throws out of the scheduled handler", async () => {
    const { db } = mockDb({
      all() {
        throw new Error("everything is down");
      },
    });
    await expect(worker.scheduled(CONTROLLER, { DB: db }, CTX)).resolves.toBeUndefined();
  });
});

// -- export params ------------------------------------------------------------------

describe("parseExportParams", () => {
  it("accepts each selector exactly once", () => {
    expect(parseExportParams({ full: true })).toEqual({
      ok: true,
      value: { mode: "full", workstream_id: null, since: null, until: null },
    });
    expect(parseExportParams({ workstream_id: WORKSTREAM_ID })).toEqual({
      ok: true,
      value: { mode: "workstream", workstream_id: WORKSTREAM_ID, since: null, until: null },
    });
    expect(parseExportParams({ since: 100, until: 200 })).toEqual({
      ok: true,
      value: { mode: "range", workstream_id: null, since: 100, until: 200 },
    });
    expect(parseExportParams({ since: "2026-08-21T00:00:00Z" })).toEqual({
      ok: true,
      value: { mode: "range", workstream_id: null, since: 1_787_270_400, until: null },
    });
  });

  it("fails closed on empty, unknown, combined, or malformed selectors", () => {
    for (const body of [
      {},
      null,
      [],
      "full",
      { full: false },
      { full: true, workstream_id: WORKSTREAM_ID },
      { full: true, since: 1 },
      { workstream_id: WORKSTREAM_ID, until: 1 },
      { workstream_id: "not-a-workstream" },
      { since: 200, until: 100 },
      { since: -1 },
      { since: "yesterday" },
      { since: 1.5 },
      { unknown: true },
    ]) {
      const result = parseExportParams(body);
      expect(result.ok, JSON.stringify(body)).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("stores a canonical echo of the selector", () => {
    expect(exportParamsJson({ mode: "full", workstream_id: null, since: null, until: null })).toBe(
      '{"full":true}',
    );
    expect(
      exportParamsJson({ mode: "range", workstream_id: null, since: 1, until: null }),
    ).toBe('{"since":1,"until":null}');
  });
});

describe("parseRetentionUpdate", () => {
  it("accepts null and any TTL inside the policy window", () => {
    expect(parseRetentionUpdate({ derived_ttl_days: null })).toEqual({ ok: true, value: null });
    expect(parseRetentionUpdate({ derived_ttl_days: RETENTION_MIN_TTL_DAYS })).toEqual({
      ok: true,
      value: RETENTION_MIN_TTL_DAYS,
    });
    expect(parseRetentionUpdate({ derived_ttl_days: RETENTION_MAX_TTL_DAYS })).toEqual({
      ok: true,
      value: RETENTION_MAX_TTL_DAYS,
    });
  });

  it("rejects TTLs below the floor, above the ceiling, and malformed bodies", () => {
    for (const body of [
      { derived_ttl_days: RETENTION_MIN_TTL_DAYS - 1 },
      { derived_ttl_days: 0 },
      { derived_ttl_days: RETENTION_MAX_TTL_DAYS + 1 },
      { derived_ttl_days: 7.5 },
      { derived_ttl_days: "30" },
      { ttl: 30 },
      {},
      null,
      [],
    ]) {
      const result = parseRetentionUpdate(body);
      expect(result.ok, JSON.stringify(body)).toBe(false);
    }
  });
});

// -- routes --------------------------------------------------------------------------

interface ExportStoreRow {
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

function routeEnv(options: {
  events?: EventSpineRow[];
  exportRow?: ExportStoreRow | null;
  exportPage?: ExportStoreRow[];
  retention?: { workspace_id: string; derived_ttl_days: number | null; created_at: number; updated_at: number } | null;
  device?: Record<string, unknown>;
  stream?: boolean;
  failComplete?: boolean;
  completeChanges?: number;
  bucket?: boolean;
}) {
  const events = options.events ?? [];
  const lookup = deviceRegistry(options.device);
  const r2 = fakeBucket({ stream: options.stream });
  const mock = mockDb({
    first(sql) {
      const device = lookup(sql);
      if (device !== null) return device;
      if (sql.includes("artifacts:export-by-id")) return options.exportRow ?? null;
      if (sql.includes("artifacts:retention-policy")) return options.retention ?? null;
      return null;
    },
    all(sql, binds) {
      if (sql.includes("artifacts:export-page-full")) {
        const [, cursor, limit] = binds as [string, number, number];
        return events.filter((event) => event.seq > cursor).slice(0, limit);
      }
      if (sql.includes("artifacts:export-page-workstream")) {
        const [, cursor, workstreamId, limit] = binds as [string, number, string, number];
        return events
          .filter((event) => event.seq > cursor && event.workstream_id === workstreamId)
          .slice(0, limit);
      }
      if (sql.includes("artifacts:export-page-range")) {
        const [, cursor, since, until, limit] = binds as [
          string,
          number,
          number | null,
          number | null,
          number,
        ];
        return events
          .filter(
            (event) =>
              event.seq > cursor &&
              (since === null || event.ingested_at >= since) &&
              (until === null || event.ingested_at <= until),
          )
          .slice(0, limit);
      }
      if (sql.includes("artifacts:exports-page")) return options.exportPage ?? [];
      return [];
    },
    run(sql) {
      if (sql.includes("artifacts:complete-export")) {
        if (options.failComplete === true) throw new Error("d1 write failed");
        return { changes: options.completeChanges ?? 1 };
      }
      return { changes: 1 };
    },
  });
  const env = options.bucket === false
    ? { DB: mock.db, BODIES: undefined }
    : { DB: mock.db, BODIES: r2.bucket };
  return { ...mock, ...r2, env };
}

function exportStoreRow(overrides: Partial<ExportStoreRow> = {}): ExportStoreRow {
  return {
    id: EXPORT_ID,
    workspace_id: TOKEN_WORKSPACE,
    status: "done",
    params_json: '{"full":true}',
    object_key: exportObjectKey(TOKEN_WORKSPACE, EXPORT_ID),
    byte_size: 12,
    event_count: 1,
    sha256: "a".repeat(64),
    created_at: 1_700_000_000,
    completed_at: 1_700_000_100,
    ...overrides,
  };
}

describe("POST /v1/exports", () => {
  it("writes NDJSON to R2, records a done manifest, and never touches the spine", async () => {
    const events = [spineRow(1), spineRow(2)];
    const { env, statements, objects } = routeEnv({ events });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");
    expect(body.event_count).toBe(2);
    expect(body.params).toEqual({ full: true });
    expect(String(body.id)).toMatch(/^exp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.object_key).toBe(exportObjectKey(TOKEN_WORKSPACE, String(body.id)));

    const stored = objects.get(String(body.object_key))?.value ?? "";
    expect(stored).toBe(buildEventJsonl(events));
    expect(body.byte_size).toBe(UTF8.encode(stored).byteLength);
    expect(body.sha256).toBe(await sha256Hex(stored));

    const insert = withMarker(statements, "artifacts:insert-export");
    expect(insert).toHaveLength(1);
    expect(insert[0].binds[1]).toBe(TOKEN_WORKSPACE);
    expect(withMarker(statements, "artifacts:complete-export")).toHaveLength(1);
    assertSpineUntouched(statements);
  });

  it("binds the workstream selector to the workstream page query", async () => {
    const events = [spineRow(1), spineRow(2, { workstream_id: OTHER_WORKSTREAM_ID })];
    const { env, statements } = routeEnv({ events });
    const response = await worker.fetch(
      request("/v1/exports", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ workstream_id: WORKSTREAM_ID }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBe(201);
    expect((await response.json() as { event_count: number }).event_count).toBe(1);
    const pages = withMarker(statements, "artifacts:export-page-workstream");
    expect(pages[0].binds).toEqual([TOKEN_WORKSPACE, 0, WORKSTREAM_ID, EXPORT_PAGE_SIZE]);
  });

  it("binds since/until against the server ingestion clock", async () => {
    const events = [
      spineRow(1, { ingested_at: 100 }),
      spineRow(2, { ingested_at: 500 }),
      spineRow(3, { ingested_at: 900 }),
    ];
    const { env, statements } = routeEnv({ events });
    const response = await worker.fetch(
      request("/v1/exports", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ since: 200, until: 800 }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBe(201);
    expect((await response.json() as { event_count: number }).event_count).toBe(1);
    expect(withMarker(statements, "artifacts:export-page-range")[0].binds).toEqual([
      TOKEN_WORKSPACE,
      0,
      200,
      800,
      EXPORT_PAGE_SIZE,
    ]);
  });

  it("accepts an empty result set as a valid, complete export", async () => {
    const { env, objects } = routeEnv({ events: [] });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "done", event_count: 0, byte_size: 0 });
    expect(objects.get(String(body.object_key))?.value).toBe("");
  });

  it("rejects an unauthenticated or read-less caller", async () => {
    const anonymous = routeEnv({});
    expect(
      (await worker.fetch(request("/v1/exports", { method: "POST", body: "{}" }), anonymous.env, CTX))
        .status,
    ).toBe(401);

    const ingestOnly = routeEnv({ device: { capabilities: "ingest" } });
    const forbidden = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      ingestOnly.env,
      CTX,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("rejects a malformed selector before writing anything", async () => {
    const { env, statements, puts } = routeEnv({ events: [spineRow(1)] });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"nope":1}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(400);
    expect(withMarker(statements, "artifacts:insert-export")).toHaveLength(0);
    expect(puts).toEqual([]);
  });

  it("denies at shared authentication when BODIES is not configured", async () => {
    const { env } = routeEnv({ bucket: false });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("fails an oversized export closed and settles the row as error", async () => {
    const big = "y".repeat(20_000);
    const events = Array.from({ length: EXPORT_PAGE_SIZE }, (_, index) =>
      spineRow(index + 1, { raw_json: `"${big}"` }),
    );
    const { env, statements, puts } = routeEnv({ events });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(413);
    expect(String((await response.json() as { error: string }).error)).toContain("narrow the selector");
    expect(puts).toEqual([]);
    expect(withMarker(statements, "artifacts:fail-export")).toHaveLength(1);
    expect(withMarker(statements, "artifacts:complete-export")).toHaveLength(0);
  });

  it("drops the object when the manifest write fails", async () => {
    const { env, statements, objects, deletes } = routeEnv({
      events: [spineRow(1)],
      failComplete: true,
    });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(500);
    expect(objects.size).toBe(0);
    expect(deletes).toHaveLength(1);
    expect(withMarker(statements, "artifacts:fail-export")).toHaveLength(1);
  });

  it("never reports a manifest the database did not accept", async () => {
    // The completing UPDATE matches no row (a lost race on status): the export
    // must not answer 201 with a manifest that is not in D1.
    const { env, objects, deletes } = routeEnv({ events: [spineRow(1)], completeChanges: 0 });
    const response = await worker.fetch(
      request("/v1/exports", { method: "POST", headers: authed(), body: '{"full":true}' }),
      env,
      CTX,
    );
    expect(response.status).toBe(500);
    expect(objects.size).toBe(0);
    expect(deletes).toHaveLength(1);
  });
});

describe("GET /v1/exports", () => {
  it("returns the list envelope with a cursor when another page exists", async () => {
    const rows = [
      exportStoreRow({ id: `exp_01J${"B".repeat(23)}`, created_at: 200 }),
      exportStoreRow({ id: `exp_01J${"A".repeat(23)}`, created_at: 100 }),
    ];
    const { env } = routeEnv({ exportPage: rows });
    const response = await worker.fetch(
      request("/v1/exports?limit=1", { headers: authed() }),
      env,
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(rows[0].id);
    expect(body.next_cursor).not.toBeNull();
  });

  it("omits the cursor on the last page and rejects a bad one", async () => {
    const { env } = routeEnv({ exportPage: [exportStoreRow()] });
    const last = await worker.fetch(request("/v1/exports", { headers: authed() }), env, CTX);
    expect(((await last.json()) as { next_cursor: string | null }).next_cursor).toBeNull();

    const bad = await worker.fetch(
      request("/v1/exports?cursor=%%%", { headers: authed() }),
      routeEnv({}).env,
      CTX,
    );
    expect(bad.status).toBe(400);
  });
});

describe("GET /v1/exports/{id}", () => {
  it("returns the manifest for an owned export", async () => {
    const { env, statements } = routeEnv({ exportRow: exportStoreRow() });
    const response = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}`, { headers: authed() }),
      env,
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: EXPORT_ID,
      status: "done",
      params: { full: true },
      event_count: 1,
    });
    expect(withMarker(statements, "artifacts:export-by-id")[0].binds).toEqual([
      TOKEN_WORKSPACE,
      EXPORT_ID,
    ]);
  });

  it("answers 404 for an unknown id and for a foreign-workspace row", async () => {
    const missing = routeEnv({ exportRow: null });
    expect(
      (await worker.fetch(request(`/v1/exports/${EXPORT_ID}`, { headers: authed() }), missing.env, CTX))
        .status,
    ).toBe(404);

    // Defence in depth: even if the row leaked past the workspace bind.
    const foreign = routeEnv({ exportRow: exportStoreRow({ workspace_id: OTHER_WORKSPACE }) });
    const response = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}`, { headers: authed() }),
      foreign.env,
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("answers 404 for an id that is not a well-formed export id", async () => {
    const { env } = routeEnv({});
    expect(
      (await worker.fetch(request("/v1/exports/not-an-id", { headers: authed() }), env, CTX)).status,
    ).toBe(404);
  });
});

describe("GET /v1/exports/{id}/download", () => {
  it("streams the stored object back as an attachment", async () => {
    const ndjson = buildEventJsonl([spineRow(1), spineRow(2)]);
    const { env, objects } = routeEnv({ exportRow: exportStoreRow(), stream: true });
    objects.set(exportObjectKey(TOKEN_WORKSPACE, EXPORT_ID), { value: ndjson });

    const response = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}/download`, { headers: authed() }),
      env,
      CTX,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${EXPORT_ID}.ndjson"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(ndjson);
  });

  it("falls back to the buffered body when the object exposes no stream", async () => {
    const { env, objects } = routeEnv({ exportRow: exportStoreRow() });
    objects.set(exportObjectKey(TOKEN_WORKSPACE, EXPORT_ID), { value: "line\n" });
    const response = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}/download`, { headers: authed() }),
      env,
      CTX,
    );
    expect(await response.text()).toBe("line\n");
  });

  it("answers 409 before completion and 404 when the object is gone", async () => {
    const running = routeEnv({
      exportRow: exportStoreRow({ status: "running", object_key: null, completed_at: null }),
    });
    const pending = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}/download`, { headers: authed() }),
      running.env,
      CTX,
    );
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: "export is not complete" });

    const vanished = routeEnv({ exportRow: exportStoreRow() });
    expect(
      (
        await worker.fetch(
          request(`/v1/exports/${EXPORT_ID}/download`, { headers: authed() }),
          vanished.env,
          CTX,
        )
      ).status,
    ).toBe(404);
  });

  it("answers 404 for a foreign export before reading any object", async () => {
    const { env, objects } = routeEnv({
      exportRow: exportStoreRow({ workspace_id: OTHER_WORKSPACE }),
    });
    objects.set(exportObjectKey(OTHER_WORKSPACE, EXPORT_ID), { value: "secret\n" });
    const response = await worker.fetch(
      request(`/v1/exports/${EXPORT_ID}/download`, { headers: authed() }),
      env,
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });
});

describe("/v1/retention", () => {
  it("reports the default policy and the spine guarantee", async () => {
    const { env } = routeEnv({ retention: null });
    const response = await worker.fetch(request("/v1/retention", { headers: authed() }), env, CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      derived_ttl_days: null,
      min_ttl_days: RETENTION_MIN_TTL_DAYS,
      max_ttl_days: RETENTION_MAX_TTL_DAYS,
      spine_retention: "forever",
      applies_to: [...RETENTION_TARGET_TABLES],
      never_retained: [...NEVER_RETAINED_TABLES],
      updated_at: null,
    });
  });

  it("upserts a valid TTL scoped to the token workspace", async () => {
    const { env, statements } = routeEnv({
      retention: {
        workspace_id: TOKEN_WORKSPACE,
        derived_ttl_days: 30,
        created_at: 1,
        updated_at: 2,
      },
    });
    const response = await worker.fetch(
      request("/v1/retention", {
        method: "PUT",
        headers: authed(),
        body: JSON.stringify({ derived_ttl_days: 30 }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { derived_ttl_days: number }).derived_ttl_days).toBe(30);
    const upsert = withMarker(statements, "artifacts:upsert-retention");
    expect(upsert).toHaveLength(1);
    expect(upsert[0].binds[0]).toBe(TOKEN_WORKSPACE);
    expect(upsert[0].binds[1]).toBe(30);
  });

  it("rejects a TTL under the floor without writing", async () => {
    const { env, statements } = routeEnv({});
    const response = await worker.fetch(
      request("/v1/retention", {
        method: "PUT",
        headers: authed(),
        body: JSON.stringify({ derived_ttl_days: RETENTION_MIN_TTL_DAYS - 1 }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBe(400);
    expect(String((await response.json() as { error: string }).error)).toContain("at least 7 days");
    expect(withMarker(statements, "artifacts:upsert-retention")).toHaveLength(0);
  });

  it("requires the read capability", async () => {
    const { env } = routeEnv({ device: { capabilities: "ingest" } });
    expect(
      (await worker.fetch(request("/v1/retention", { headers: authed() }), env, CTX)).status,
    ).toBe(403);
  });
});

describe("artifact routing", () => {
  it("answers 404 for a wrong method on a known path", async () => {
    const { env } = routeEnv({});
    for (const [path, method] of [
      ["/v1/exports", "DELETE"],
      ["/v1/retention", "POST"],
      [`/v1/exports/${EXPORT_ID}`, "DELETE"],
      [`/v1/exports/${EXPORT_ID}/download`, "POST"],
    ] as const) {
      const response = await worker.fetch(request(path, { method, headers: authed() }), env, CTX);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  });

  it("leaves unrelated paths to the rest of the router", async () => {
    const { env } = routeEnv({});
    expect((await worker.fetch(request("/healthz"), env, CTX)).status).toBe(200);
  });
});
