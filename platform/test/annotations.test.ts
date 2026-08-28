// Unit tests for src/annotations.ts: queue creation + bounded/deterministic
// population from span_observations, atomic claim semantics, submit
// validation per data_type (incl. category rejection), the score.recorded
// event shape and its deterministic id, skip, refill idempotency, the live
// endpoint's DO-bound vs D1-fallback shape equality, foreign-workspace 404s,
// and migration 0013's CHECK constraints + triggers against real SQLite
// (node:sqlite) — same harness convention as test/alerts.test.ts and
// test/gateway.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ANI_ID_PATTERN,
  ANQ_ID_PATTERN,
  AnnotationQueueRoom,
  MAX_ITEMS_PER_SCAN,
  annotationScoreEventID,
  handleAnnotationsRoute,
  validateScoreValue,
  type AnnotationsEnv,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
} from "../src/annotations";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";

// -- real-SQL adapter: D1DatabaseLike over node:sqlite ---------------------------
// This module's logic (atomic claim, RETURNING, triggers, CHECK constraints)
// is inseparable from real SQLite semantics, so every functional test below
// runs against the real schema (migrations 0001..0013 applied in order)
// rather than a hand-rolled fake that would have to reimplement them.

function sqliteDb(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string): D1Statement {
      let binds: unknown[] = [];
      const bound: D1BoundStatement = {
        async first<T = unknown>() {
          const row = db.prepare(sql).get(...(binds as never[]));
          return (row ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: db.prepare(sql).all(...(binds as never[])) as T[] };
        },
        async run<T = unknown>() {
          db.prepare(sql).run(...(binds as never[]));
          return { success: true } as { success: boolean; results?: T[] };
        },
      };
      return {
        bind(...values: unknown[]) {
          binds = values;
          return bound;
        },
      };
    },
    async batch(statements: D1BoundStatement[]) {
      db.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
}

// -- migrations ------------------------------------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0013_annotations.sql";
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql") && name <= THIS_MIGRATION)
  .sort();

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return db;
}

// -- fixtures ----------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const WORKSTREAM_ONE = "ws_01HTSTW0RKSTREAM000000000Z";

const FULL_TOKEN = "dev_test-token-annotations-full";
const FULL_DEVICE_ID = `dev_01HTSTDEVFULL${"0".repeat(12)}Z`;
const READONLY_TOKEN = "dev_test-token-annotations-readonly";
const READONLY_DEVICE_ID = `dev_01HTSTDEVREADONLY${"0".repeat(7)}Z`;
const OTHER_TOKEN = "dev_test-token-annotations-other";
const OTHER_DEVICE_ID = `dev_01HTSTDEVOTHER${"0".repeat(10)}Z`;

let FULL_HASH = "";
let READONLY_HASH = "";
let OTHER_HASH = "";

beforeAll(async () => {
  FULL_HASH = await sha256Hex(FULL_TOKEN);
  READONLY_HASH = await sha256Hex(READONLY_TOKEN);
  OTHER_HASH = await sha256Hex(OTHER_TOKEN);
});

/**
 * devices.workspace_id has no FK, but migration 0003's devices_charge_entitlement
 * trigger requires a matching active workspace_entitlements row (AFTER INSERT ON
 * devices, RAISE 'device quota exceeded' when it cannot charge active_devices/
 * used_device_issuances against one) — every device insert needs its workspace
 * seeded first, default max_devices (2) is enough for this file's two devices
 * per workspace.
 */
function seedWorkspace(db: DatabaseSync, workspaceId: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, 'test', 'active', 1700000000)
  `).run(workspaceId, workspaceId);
  db.prepare(`
    INSERT INTO workspace_entitlements
      (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
    VALUES (?, 'basic', 'active', 1700000000, 1700086400, 1700000000, 1700000000)
  `).run(workspaceId);
}

function seedDevices(db: DatabaseSync): void {
  seedWorkspace(db, TOKEN_WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  const insert = (id: string, workspaceId: string, hash: string, capabilities: string) => {
    db.prepare(`
      INSERT INTO devices (id, workspace_id, token_hash, capabilities, created_at)
      VALUES (?, ?, ?, ?, 1700000000)
    `).run(id, workspaceId, hash, capabilities);
  };
  insert(FULL_DEVICE_ID, TOKEN_WORKSPACE, FULL_HASH, "ingest,read");
  insert(READONLY_DEVICE_ID, TOKEN_WORKSPACE, READONLY_HASH, "read");
  insert(OTHER_DEVICE_ID, OTHER_WORKSPACE, OTHER_HASH, "ingest,read");
}

interface SeedSpan {
  span_id: string;
  workspace_id?: string;
  workstream_id?: string | null;
  kind?: string;
  status?: "unknown" | "running" | "ok" | "error";
  started_at_seconds: number;
}

const STATUS_RANK: Record<string, number> = { unknown: 0, running: 1, ok: 2, error: 3 };

function seedSpan(db: DatabaseSync, span: SeedSpan): void {
  const status = span.status ?? "ok";
  db.prepare(`
    INSERT INTO span_observations
      (workspace_id, span_id, trace_id, workstream_id, kind, name, status, status_rank,
       started_at_ns, start_event_id, fingerprint)
    VALUES (?1, ?2, 'trc_seed', ?3, ?4, 'seed', ?5, ?6, CAST(?7 AS INTEGER), 'evt_seed', ?8)
  `).run(
    span.workspace_id ?? TOKEN_WORKSPACE,
    span.span_id,
    span.workstream_id ?? null,
    span.kind ?? "llm.call",
    status,
    STATUS_RANK[status],
    (BigInt(span.started_at_seconds) * 1_000_000_000n).toString(),
    "a".repeat(24),
  );
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

function makeEnv(db: DatabaseSync, rooms?: DurableObjectNamespaceLike): AnnotationsEnv {
  return { DB: sqliteDb(db), ANNOTATION_ROOMS: rooms };
}

interface QueueBody {
  id: string;
  name: string;
  target_filter: Record<string, unknown>;
  score_name: string;
  data_type: string;
  categories: string[] | null;
  active: boolean;
  created_at: number;
  pending_count: number;
  done_count: number;
}

async function createQueue(
  db: DatabaseSync,
  body: Record<string, unknown>,
  token = FULL_TOKEN,
): Promise<{ status: number; queue?: QueueBody; error?: string }> {
  const response = await handleAnnotationsRoute(
    request("/v1/annotation-queues", { method: "POST", headers: authed(token), body: JSON.stringify(body) }),
    makeEnv(db),
  );
  const parsed = (await response!.json()) as { queue?: QueueBody; error?: string };
  return { status: response!.status, queue: parsed.queue, error: parsed.error };
}

// -- routing ownership -------------------------------------------------------------

describe("handleAnnotationsRoute ownership", () => {
  it("returns null for paths it does not own", async () => {
    const db = migratedDatabase();
    for (const path of ["/healthz", "/v1/workstreams", "/v1/annotation-queues-typo"]) {
      expect(await handleAnnotationsRoute(request(path), makeEnv(db))).toBeNull();
    }
  });

  it("returns null for a wrong method on a known path", async () => {
    const db = migratedDatabase();
    expect(await handleAnnotationsRoute(request("/v1/annotation-queues", { method: "DELETE" }), makeEnv(db))).toBeNull();
    expect(
      await handleAnnotationsRoute(request(`/v1/annotation-queues/anq_${"0".repeat(26)}/claim`, { method: "GET" }), makeEnv(db)),
    ).toBeNull();
    expect(
      await handleAnnotationsRoute(request(`/v1/annotation-queues/anq_${"0".repeat(26)}/live`, { method: "POST" }), makeEnv(db)),
    ).toBeNull();
  });
});

// -- id patterns --------------------------------------------------------------------

describe("id patterns", () => {
  it("accept only well-formed anq_/ani_ ULID ids", () => {
    expect(ANQ_ID_PATTERN.test("anq_not-a-ulid")).toBe(false);
    expect(ANI_ID_PATTERN.test("ani_not-a-ulid")).toBe(false);
    expect(ANQ_ID_PATTERN.test(`anq_${"0".repeat(26)}`)).toBe(true);
    expect(ANQ_ID_PATTERN.test(`anq_${"0".repeat(25)}`)).toBe(false); // wrong length
    expect(ANQ_ID_PATTERN.test(`anq_8${"0".repeat(25)}`)).toBe(false); // first char must be [0-7]
    expect(ANI_ID_PATTERN.test(`ani_${"0".repeat(26)}`)).toBe(true);
  });
});

// -- create + populate (determinism + bound) ----------------------------------------

describe("POST /v1/annotation-queues (create + populate)", () => {
  it("requires the ingest capability", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { status, error } = await createQueue(
      db,
      { name: "q", target_filter: {}, score_name: "quality", data_type: "NUMERIC" },
      READONLY_TOKEN,
    );
    expect(status).toBe(403);
    expect(error).toBe("forbidden");
  });

  it("rejects a malformed target_filter and a data_type/categories mismatch", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const badFilter = await createQueue(db, {
      name: "q", target_filter: { nope: 1 }, score_name: "quality", data_type: "NUMERIC",
    });
    expect(badFilter.status).toBe(400);

    const missingCategories = await createQueue(db, {
      name: "q", target_filter: {}, score_name: "quality", data_type: "CATEGORY",
    });
    expect(missingCategories.status).toBe(400);

    const strayCategories = await createQueue(db, {
      name: "q", target_filter: {}, score_name: "quality", data_type: "NUMERIC", categories: ["a", "b"],
    });
    expect(strayCategories.status).toBe(400);

    const dupeCategories = await createQueue(db, {
      name: "q", target_filter: {}, score_name: "quality", data_type: "CATEGORY", categories: ["good", "good"],
    });
    expect(dupeCategories.status).toBe(400);
  });

  it("populates matching spans only, deterministically ordered, bounded to 1000", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    // 1010 matching spans, strictly increasing started_at, plus noise that
    // must never be picked up (wrong workstream, wrong workspace).
    for (let i = 0; i < 1_010; i++) {
      seedSpan(db, { span_id: `spn_match_${String(i).padStart(4, "0")}`, workstream_id: WORKSTREAM_ONE, started_at_seconds: 1_700_000_000 + i });
    }
    seedSpan(db, { span_id: "spn_other_workstream", workstream_id: "ws_elsewhere00000000000000000", started_at_seconds: 1_700_000_500 });
    seedSpan(db, { span_id: "spn_other_workspace", workspace_id: OTHER_WORKSPACE, workstream_id: WORKSTREAM_ONE, started_at_seconds: 1_700_000_500 });

    const { status, queue } = await createQueue(db, {
      name: "review queue",
      target_filter: { workstream: WORKSTREAM_ONE },
      score_name: "quality",
      data_type: "NUMERIC",
    });
    expect(status).toBe(201);
    expect(queue!.pending_count).toBe(MAX_ITEMS_PER_SCAN);
    expect(queue!.done_count).toBe(0);
    expect(ANQ_ID_PATTERN.test(queue!.id)).toBe(true);

    const items = db
      .prepare("SELECT target_id FROM annotation_items WHERE queue_id = ?")
      .all(queue!.id) as { target_id: string }[];
    expect(items.length).toBe(MAX_ITEMS_PER_SCAN);
    const targetIds = new Set(items.map((r) => r.target_id));
    // Deterministic order: the oldest 1000 by started_at_ns are in, the rest are not.
    expect(targetIds.has("spn_match_0000")).toBe(true);
    expect(targetIds.has("spn_match_0999")).toBe(true);
    expect(targetIds.has("spn_match_1000")).toBe(false);
    expect(targetIds.has("spn_match_1009")).toBe(false);
    // Cross-workstream and cross-workspace spans never leak in.
    expect(targetIds.has("spn_other_workstream")).toBe(false);
    expect(targetIds.has("spn_other_workspace")).toBe(false);
  });

  it("filters by kind and status together", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    seedSpan(db, { span_id: "spn_a", kind: "llm.call", status: "error", started_at_seconds: 1_700_000_001 });
    seedSpan(db, { span_id: "spn_b", kind: "llm.call", status: "ok", started_at_seconds: 1_700_000_002 });
    seedSpan(db, { span_id: "spn_c", kind: "tool.call", status: "error", started_at_seconds: 1_700_000_003 });

    const { queue } = await createQueue(db, {
      name: "errors", target_filter: { kind: "llm.call", status: "error" }, score_name: "quality", data_type: "BOOLEAN",
    });
    expect(queue!.pending_count).toBe(1);
    const items = db.prepare("SELECT target_id FROM annotation_items WHERE queue_id = ?").all(queue!.id) as { target_id: string }[];
    expect(items.map((r) => r.target_id)).toEqual(["spn_a"]);
  });
});

// -- GET /v1/annotation-queues (list) ------------------------------------------------

describe("GET /v1/annotation-queues", () => {
  it("lists only the caller's own workspace, newest first, with pending/done counts", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queue: q1 } = await createQueue(db, { name: "first", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    const { queue: q2 } = await createQueue(db, { name: "second", target_filter: {}, score_name: "s", data_type: "NUMERIC" });

    const response = await handleAnnotationsRoute(
      request("/v1/annotation-queues", { headers: authed(FULL_TOKEN) }),
      makeEnv(db),
    );
    const body = (await response!.json()) as { items: QueueBody[]; next_cursor: string | null };
    expect(response!.status).toBe(200);
    expect(body.items.map((q) => q.id)).toEqual([q2!.id, q1!.id]);
    expect(body.next_cursor).toBeNull();

    const otherView = await handleAnnotationsRoute(
      request("/v1/annotation-queues", { headers: authed(OTHER_TOKEN) }),
      makeEnv(db),
    );
    const otherBody = (await otherView!.json()) as { items: QueueBody[] };
    expect(otherBody.items).toEqual([]);
  });
});

// -- claim atomicity -----------------------------------------------------------------

describe("POST /v1/annotation-queues/{id}/claim", () => {
  async function seededQueue(db: DatabaseSync): Promise<string> {
    seedSpan(db, { span_id: "spn_1", started_at_seconds: 1_700_000_001 });
    seedSpan(db, { span_id: "spn_2", started_at_seconds: 1_700_000_002 });
    seedSpan(db, { span_id: "spn_3", started_at_seconds: 1_700_000_003 });
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "quality", data_type: "NUMERIC" });
    return queue!.id;
  }

  async function claim(db: DatabaseSync, queueId: string, token = FULL_TOKEN) {
    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queueId}/claim`, { method: "POST", headers: authed(token) }),
      makeEnv(db),
    );
    const body = (await response!.json()) as { item: null | { id: string; target_id: string; status: string; claimed_by_device: string; target: unknown } };
    return { status: response!.status, ...body };
  }

  it("hands out the oldest pending item first, never the same item twice, then the next", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const queueId = await seededQueue(db);

    const first = await claim(db, queueId);
    expect(first.status).toBe(200);
    expect(first.item!.target_id).toBe("spn_1");
    expect(first.item!.status).toBe("claimed");
    expect(first.item!.claimed_by_device).toBe(FULL_DEVICE_ID);
    expect(first.item!.target).toMatchObject({ span_id: "spn_1" });

    const second = await claim(db, queueId);
    expect(second.item!.target_id).toBe("spn_2");
    expect(second.item!.id).not.toBe(first.item!.id);

    const third = await claim(db, queueId);
    expect(third.item!.target_id).toBe("spn_3");

    // Queue exhausted: nothing left to claim, not an error.
    const fourth = await claim(db, queueId);
    expect(fourth.status).toBe(200);
    expect(fourth.item).toBeNull();
  });

  it("404s a claim on a foreign-workspace queue", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const queueId = await seededQueue(db);
    const result = await claim(db, queueId, OTHER_TOKEN);
    expect(result.status).toBe(404);
  });
});

// -- submit validation + score event shape -------------------------------------------

describe("POST /v1/annotation-queues/{id}/items/{item}/submit", () => {
  let queueWithOneItemCounter = 0;

  async function queueWithOneItem(
    db: DatabaseSync,
    dataType: "NUMERIC" | "CATEGORY" | "BOOLEAN",
    categories?: string[],
  ): Promise<{ queueId: string; itemId: string; spanId: string }> {
    const spanId = `spn_target_${queueWithOneItemCounter++}`;
    seedSpan(db, { span_id: spanId, workstream_id: WORKSTREAM_ONE, started_at_seconds: 1_700_000_001 });
    const { queue } = await createQueue(db, {
      name: "q", target_filter: {}, score_name: "quality", data_type: dataType, ...(categories ? { categories } : {}),
    });
    const item = db.prepare("SELECT id FROM annotation_items WHERE queue_id = ?").get(queue!.id) as { id: string };
    return { queueId: queue!.id, itemId: item.id, spanId };
  }

  async function submit(db: DatabaseSync, queueId: string, itemId: string, body: unknown, token = FULL_TOKEN) {
    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queueId}/items/${itemId}/submit`, {
        method: "POST",
        headers: authed(token),
        body: JSON.stringify(body),
      }),
      makeEnv(db),
    );
    const parsed = (await response!.json()) as Record<string, unknown>;
    return { status: response!.status, body: parsed };
  }

  it("rejects a NUMERIC value that is not a finite number", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId, itemId } = await queueWithOneItem(db, "NUMERIC");
    const { status } = await submit(db, queueId, itemId, { value: "not-a-number" });
    expect(status).toBe(400);
  });

  it("rejects a BOOLEAN value that is not a boolean", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId, itemId } = await queueWithOneItem(db, "BOOLEAN");
    const { status } = await submit(db, queueId, itemId, { value: "true" });
    expect(status).toBe(400);
  });

  it("rejects a CATEGORY value outside the queue's category list", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId, itemId } = await queueWithOneItem(db, "CATEGORY", ["good", "bad"]);
    const { status, body } = await submit(db, queueId, itemId, { value: "ugly" });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/one of the queue's categories/);
  });

  it("accepts a valid submission, writes a source=human score.recorded event with a deterministic id, and marks the item done", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId, itemId, spanId } = await queueWithOneItem(db, "CATEGORY", ["good", "bad"]);

    const { status, body } = await submit(db, queueId, itemId, { value: "good", comment: "looks solid" });
    expect(status).toBe(200);
    const score = body.score as Record<string, unknown>;
    expect(score.source).toBe("human");
    expect(score.value).toBe("good");
    expect(score.target_type).toBe("span");
    expect(score.target_id).toBe(spanId);
    expect(score.comment).toBe("looks solid");
    const item = body.item as Record<string, unknown>;
    expect(item.status).toBe("done");

    const row = db
      .prepare("SELECT event_id, workstream_id, provenance, raw_json FROM events WHERE kind = 'score.recorded'")
      .get() as { event_id: string; workstream_id: string; provenance: string; raw_json: string };
    expect(row.workstream_id).toBe(WORKSTREAM_ONE);
    expect(row.provenance).toBe("OBSERVED");
    const parsed = JSON.parse(row.raw_json) as { payload: Record<string, unknown>; occurred_at: string };
    expect(parsed.payload).toMatchObject({
      name: "quality", data_type: "CATEGORY", value: "good", target_type: "span", target_id: spanId,
      source: "human", comment: "looks solid",
    });

    // Determinism: recomputing the id from the same recipe (item id, payload,
    // and the SAME capture millisecond the row was actually written under)
    // reproduces the exact same event_id — the property that makes a
    // byte-identical retry within the same millisecond collapse via
    // INSERT OR IGNORE instead of duplicating.
    const nowMs = Date.parse(parsed.occurred_at);
    const recomputed = await annotationScoreEventID(itemId, parsed.payload, nowMs);
    expect(recomputed).toBe(row.event_id);
  });

  it("re-submitting a finished item is a 409, and never writes a second score event", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId, itemId } = await queueWithOneItem(db, "NUMERIC");
    const okOnce = await submit(db, queueId, itemId, { value: 5 });
    expect(okOnce.status).toBe(200);

    const again = await submit(db, queueId, itemId, { value: 5 });
    expect(again.status).toBe(409);

    const count = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'score.recorded'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("404s submit for an unknown item and for a foreign-workspace queue", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queueId } = await queueWithOneItem(db, "NUMERIC");
    const unknownItem = await submit(db, queueId, `ani_${"0".repeat(26)}`, { value: 1 });
    expect(unknownItem.status).toBe(404);

    const { queueId: queueId2, itemId: itemId2 } = await queueWithOneItem(db, "NUMERIC");
    const foreign = await submit(db, queueId2, itemId2, { value: 1 }, OTHER_TOKEN);
    expect(foreign.status).toBe(404);
  });
});

// -- skip -----------------------------------------------------------------------------

describe("POST /v1/annotation-queues/{id}/items/{item}/skip", () => {
  it("marks the item skipped without writing a score event, and is terminal", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    seedSpan(db, { span_id: "spn_skip", started_at_seconds: 1_700_000_001 });
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    const item = db.prepare("SELECT id FROM annotation_items WHERE queue_id = ?").get(queue!.id) as { id: string };

    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/items/${item.id}/skip`, { method: "POST", headers: authed(FULL_TOKEN) }),
      makeEnv(db),
    );
    const body = (await response!.json()) as { item: Record<string, unknown> };
    expect(response!.status).toBe(200);
    expect(body.item.status).toBe("skipped");

    const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'score.recorded'").get() as { n: number };
    expect(events.n).toBe(0);

    const again = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/items/${item.id}/skip`, { method: "POST", headers: authed(FULL_TOKEN) }),
      makeEnv(db),
    );
    expect(again!.status).toBe(409);
  });
});

// -- refill idempotency ---------------------------------------------------------------

describe("POST /v1/annotation-queues/{id}/refill", () => {
  it("requires the ingest capability", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/refill`, { method: "POST", headers: authed(READONLY_TOKEN) }),
      makeEnv(db),
    );
    expect(response!.status).toBe(403);
  });

  it("only adds genuinely new targets, and a repeat refill with nothing new is a no-op", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    seedSpan(db, { span_id: "spn_a", started_at_seconds: 1_700_000_001 });
    seedSpan(db, { span_id: "spn_b", started_at_seconds: 1_700_000_002 });
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    expect(queue!.pending_count).toBe(2);

    seedSpan(db, { span_id: "spn_c", started_at_seconds: 1_700_000_003 });
    const refillOnce = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/refill`, { method: "POST", headers: authed(FULL_TOKEN) }),
      makeEnv(db),
    );
    const bodyOnce = (await refillOnce!.json()) as { queue: QueueBody };
    expect(bodyOnce.queue.pending_count).toBe(3);

    const refillTwice = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/refill`, { method: "POST", headers: authed(FULL_TOKEN) }),
      makeEnv(db),
    );
    const bodyTwice = (await refillTwice!.json()) as { queue: QueueBody };
    expect(bodyTwice.queue.pending_count).toBe(3);

    const items = db.prepare("SELECT COUNT(*) AS n FROM annotation_items WHERE queue_id = ?").get(queue!.id) as { n: number };
    expect(items.n).toBe(3);
  });

  it("404s refill for a foreign-workspace queue", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/refill`, { method: "POST", headers: authed(OTHER_TOKEN) }),
      makeEnv(db),
    );
    expect(response!.status).toBe(404);
  });
});

// -- live: DO-bound vs D1 fallback shape equality -------------------------------------

interface FakeRoom {
  ns: DurableObjectNamespaceLike;
  calls: Request[];
}

function fakeRoomNamespace(initial: { pending: number; claimed: number; done: number }): FakeRoom {
  let state = { ...initial };
  const calls: Request[] = [];
  const stub: DurableObjectStubLike = {
    async fetch(input: Request | string, init?: RequestInit) {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push(req);
      if (req.method === "POST") {
        const parsedBody = (await req.clone().json()) as { pending: number; claimed: number; done: number };
        state = { pending: parsedBody.pending, claimed: parsedBody.claimed, done: parsedBody.done };
      }
      return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const ns: DurableObjectNamespaceLike = {
    idFromName(name: string): DurableObjectIdLike {
      return { toString: () => name };
    },
    get(_id: DurableObjectIdLike): DurableObjectStubLike {
      return stub;
    },
  };
  return { ns, calls };
}

describe("GET /v1/annotation-queues/{id}/live", () => {
  it("returns the same response shape whether backed by the room or the D1 fallback", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    seedSpan(db, { span_id: "spn_live", started_at_seconds: 1_700_000_001 });
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });

    const fallback = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/live`, { headers: authed(FULL_TOKEN) }),
      makeEnv(db), // no ANNOTATION_ROOMS bound
    );
    const fallbackBody = (await fallback!.json()) as Record<string, unknown>;
    expect(fallback!.status).toBe(200);
    expect(fallbackBody).toEqual({ queue_id: queue!.id, pending: 1, claimed: 0, done: 0 });

    const { ns } = fakeRoomNamespace({ pending: 7, claimed: 2, done: 3 });
    const roomBacked = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/live`, { headers: authed(FULL_TOKEN) }),
      makeEnv(db, ns),
    );
    const roomBody = (await roomBacked!.json()) as Record<string, unknown>;
    expect(roomBacked!.status).toBe(200);

    // Same shape (key set + value types) from both paths; values may differ
    // because the room's snapshot is intentionally independent of D1 here.
    expect(Object.keys(roomBody).sort()).toEqual(Object.keys(fallbackBody).sort());
    for (const key of Object.keys(fallbackBody)) {
      expect(typeof roomBody[key]).toBe(typeof fallbackBody[key]);
    }
    expect(roomBody).toEqual({ queue_id: queue!.id, pending: 7, claimed: 2, done: 3 });
  });

  it("404s live for a foreign-workspace queue", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const { queue } = await createQueue(db, { name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" });
    const response = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${queue!.id}/live`, { headers: authed(OTHER_TOKEN) }),
      makeEnv(db),
    );
    expect(response!.status).toBe(404);
  });

  it("mutations best-effort notify the bound room with the fresh D1 snapshot", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    seedSpan(db, { span_id: "spn_notify", started_at_seconds: 1_700_000_001 });
    const { ns, calls } = fakeRoomNamespace({ pending: 0, claimed: 0, done: 0 });
    const env = makeEnv(db, ns);

    const createResponse = await handleAnnotationsRoute(
      request("/v1/annotation-queues", {
        method: "POST",
        headers: authed(FULL_TOKEN),
        body: JSON.stringify({ name: "q", target_filter: {}, score_name: "s", data_type: "NUMERIC" }),
      }),
      env,
    );
    const created = (await createResponse!.json()) as { queue: QueueBody };
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]!.method).toBe("POST");

    await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${created.queue.id}/claim`, { method: "POST", headers: authed(FULL_TOKEN) }),
      env,
    );
    const callsAfterClaim = calls.length;
    expect(callsAfterClaim).toBeGreaterThan(1);

    const state = await handleAnnotationsRoute(
      request(`/v1/annotation-queues/${created.queue.id}/live`, { headers: authed(FULL_TOKEN) }),
      env,
    );
    const stateBody = (await state!.json()) as Record<string, unknown>;
    expect(stateBody).toEqual({ queue_id: created.queue.id, pending: 0, claimed: 1, done: 0 });
  });
});

// -- AnnotationQueueRoom (Durable Object class, direct unit test) --------------------

describe("AnnotationQueueRoom", () => {
  it("starts at zero, reflects a POSTed snapshot, and rejects bad input/methods", async () => {
    const room = new AnnotationQueueRoom({}, {});

    const initial = await room.fetch(new Request("https://room.internal/state"));
    expect(await initial.json()).toEqual({ pending: 0, claimed: 0, done: 0 });

    const posted = await room.fetch(
      new Request("https://room.internal/state", { method: "POST", body: JSON.stringify({ pending: 4, claimed: 1, done: 2 }) }),
    );
    expect(await posted.json()).toEqual({ pending: 4, claimed: 1, done: 2 });

    const readBack = await room.fetch(new Request("https://room.internal/state"));
    expect(await readBack.json()).toEqual({ pending: 4, claimed: 1, done: 2 });

    const badBody = await room.fetch(new Request("https://room.internal/state", { method: "POST", body: "not json" }));
    expect(badBody.status).toBe(400);

    const wrongMethod = await room.fetch(new Request("https://room.internal/state", { method: "DELETE" }));
    expect(wrongMethod.status).toBe(405);
  });
});

// -- validateScoreValue (pure function) -----------------------------------------------

describe("validateScoreValue", () => {
  it("stringifies NUMERIC and BOOLEAN, and passes through a valid CATEGORY", () => {
    expect(validateScoreValue("NUMERIC", null, 3.5)).toEqual({ ok: true, value: "3.5" });
    expect(validateScoreValue("BOOLEAN", null, true)).toEqual({ ok: true, value: "true" });
    expect(validateScoreValue("CATEGORY", ["a", "b"], "a")).toEqual({ ok: true, value: "a" });
  });

  it("rejects NaN/Infinity for NUMERIC and an out-of-vocabulary CATEGORY", () => {
    expect(validateScoreValue("NUMERIC", null, Number.NaN).ok).toBe(false);
    expect(validateScoreValue("NUMERIC", null, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateScoreValue("CATEGORY", ["a", "b"], "c").ok).toBe(false);
    expect(validateScoreValue("CATEGORY", null, "a").ok).toBe(false);
  });
});

// -- migration 0013: CHECK constraints + triggers (node:sqlite) -----------------------

describe("migration 0013 schema (node:sqlite)", () => {
  const QUEUE_ID = `anq_${"0".repeat(26)}`;
  const ITEM_ID = `ani_${"0".repeat(26)}`;

  function insertQueue(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
    const row = {
      id: QUEUE_ID, workspace_id: TOKEN_WORKSPACE, name: "q", target_filter: "{}",
      score_name: "quality", data_type: "NUMERIC", categories: null, created_at: 1_700_000_000,
      ...overrides,
    };
    db.prepare(`
      INSERT INTO annotation_queues (id, workspace_id, name, target_filter, score_name, data_type, categories, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id as string, row.workspace_id as string, row.name as string, row.target_filter as string,
      row.score_name as string, row.data_type as string, row.categories as string | null, row.created_at as number,
    );
  }

  function insertPendingItem(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
    const row = {
      id: ITEM_ID, queue_id: QUEUE_ID, workspace_id: TOKEN_WORKSPACE,
      target_type: "span", target_id: "spn_x", created_at: 1_700_000_000,
      ...overrides,
    };
    db.prepare(`
      INSERT INTO annotation_items (id, queue_id, workspace_id, target_type, target_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id as string, row.queue_id as string, row.workspace_id as string, row.target_type as string, row.target_id as string, row.created_at as number);
  }

  it("rejects a queue whose data_type/categories pairing is wrong", () => {
    const db = migratedDatabase();
    expect(() => insertQueue(db, { data_type: "CATEGORY", categories: null })).toThrow();
    expect(() => insertQueue(db, { data_type: "NUMERIC", categories: '["a"]' })).toThrow();
    expect(() => insertQueue(db, { data_type: "CATEGORY", categories: '["a","b"]' })).not.toThrow();
  });

  it("rejects an item that does not start pending", () => {
    const db = migratedDatabase();
    insertQueue(db);
    expect(() =>
      db.prepare(`
        INSERT INTO annotation_items (id, queue_id, workspace_id, target_type, target_id, status, created_at)
        VALUES (?, ?, ?, 'span', 'spn_x', 'claimed', 1700000000)
      `).run(ITEM_ID, QUEUE_ID, TOKEN_WORKSPACE),
    ).toThrow();
  });

  it("enforces the UNIQUE(queue_id, target_type, target_id) constraint", () => {
    const db = migratedDatabase();
    insertQueue(db);
    insertPendingItem(db);
    expect(() => insertPendingItem(db, { id: `ani_${"1".repeat(26)}` })).toThrow();
  });

  it("blocks claiming a non-pending item, and terminal states can never move again", () => {
    const db = migratedDatabase();
    insertQueue(db);
    insertPendingItem(db);

    // pending -> claimed is allowed.
    db.prepare("UPDATE annotation_items SET status = 'claimed', claimed_by_device = 'dev_x', claimed_at = 1700000001 WHERE id = ?").run(ITEM_ID);

    // claimed -> claimed again is blocked (claim requires pending).
    expect(() =>
      db.prepare("UPDATE annotation_items SET status = 'claimed', claimed_by_device = 'dev_y', claimed_at = 1700000002 WHERE id = ?").run(ITEM_ID),
    ).toThrow();

    // claimed -> done is allowed.
    db.prepare("UPDATE annotation_items SET status = 'done', completed_at = 1700000003 WHERE id = ?").run(ITEM_ID);

    // done -> anything (including back to claimed) is blocked: terminal.
    expect(() =>
      db.prepare("UPDATE annotation_items SET status = 'claimed', claimed_by_device = 'dev_z', claimed_at = 1700000004 WHERE id = ?").run(ITEM_ID),
    ).toThrow();
    expect(() => db.prepare("UPDATE annotation_items SET status = 'pending' WHERE id = ?").run(ITEM_ID)).toThrow();
  });

  it("rejects a 'claimed' row with no claimed_by_device", () => {
    const db = migratedDatabase();
    insertQueue(db);
    insertPendingItem(db);
    expect(() => db.prepare("UPDATE annotation_items SET status = 'claimed' WHERE id = ?").run(ITEM_ID)).toThrow();
  });
});
