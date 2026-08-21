// Unit tests for src/ingest.ts (pure logic) and src/index.ts (handlers with
// a mocked D1 seam — plain objects, no workerd required).

import { beforeAll, describe, expect, it } from "vitest";
import worker, {
  type D1BoundStatement,
  type D1DatabaseLike,
  type D1Statement,
  type Env,
} from "../src/index";
import {
  BATCH_SCHEMA_VERSION,
  DEFAULT_PAGE_LIMIT,
  EVENT_SCHEMA_VERSION,
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_PAGE_LIMIT,
  buildEventRows,
  buildReceipt,
  buildWorkstreamListResponse,
  canonicalJsonStringify,
  decodeCursor,
  encodeCursor,
  exceedsMaxBodyBytes,
  parsePagination,
  scopeDenial,
  validateEventBatch,
  type EventBatchEnvelope,
  type WorkstreamRow,
} from "../src/ingest";
import { sha256Hex } from "../src/auth";

// -- fixtures -----------------------------------------------------------------

const WSP_ULID = "01HTSTW0RKSPACE0000000000Z"; // 26 chars, Crockford base32
const TOKEN_WORKSPACE = `wsp_${WSP_ULID}`;
const OTHER_WORKSPACE = `wsp_01HTSTW0RKSPEER0000000000Z`;
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;

/** Real SHA-256 of the test token; the mock registry returns it as token_hash. */
let TOKEN_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

/** Unique, schema-valid evt_<ulid> per index. */
function eventId(i: number): string {
  const head = `01HTEST${String(i).padStart(4, "0")}`; // 11 chars
  const tail = `${"0".repeat(26 - head.length - 1)}Z`;
  return `evt_${head}${tail}`;
}

function workstreamId(i: number): string {
  const head = `01HTESTWS${String(i).padStart(6, "0")}`; // 15 chars
  const tail = `${"0".repeat(26 - head.length - 1)}Z`;
  return `ws_${head}${tail}`;
}

function event(overrides: Record<string, unknown> = {}, i = 0): Record<string, unknown> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: eventId(i),
    kind: "command.completed",
    occurred_at: "2026-08-21T10:00:00Z",
    workstream_id: workstreamId(0),
    session_id: `ses_01HTSTSESS${"0".repeat(15)}Z`,
    provider: "codex",
    provenance: "OBSERVED",
    payload: { exit_code: 1 },
    ...overrides,
  };
}

function envelope(
  overrides: Record<string, unknown> = {},
  events: Record<string, unknown>[] = [event()],
): Record<string, unknown> {
  return { schema_version: BATCH_SCHEMA_VERSION, events, ...overrides };
}

function workstreamRow(i: number, overrides: Partial<WorkstreamRow> = {}): WorkstreamRow {
  return {
    id: workstreamId(i),
    workspace_id: TOKEN_WORKSPACE,
    title: `workstream ${i}`,
    status: "active",
    repository_id: null,
    created_at: 1_700_000_000 + i,
    updated_at: 1_700_000_000 + i,
    ...overrides,
  };
}

// -- pure logic: constants and limits ------------------------------------------

describe("limits", () => {
  it("pins the documented limits", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(500);
    expect(MAX_BODY_BYTES).toBe(1_048_576);
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });

  it("classifies body sizes at the boundary", () => {
    expect(exceedsMaxBodyBytes(MAX_BODY_BYTES)).toBe(false);
    expect(exceedsMaxBodyBytes(MAX_BODY_BYTES + 1)).toBe(true);
  });
});

// -- pure logic: envelope validation -------------------------------------------

describe("validateEventBatch", () => {
  it("accepts a valid envelope and derives the workspace from the token", () => {
    const result = validateEventBatch(envelope(), TOKEN_WORKSPACE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events).toHaveLength(1);
  });

  it("rejects non-object envelopes", () => {
    for (const bad of [null, 42, "x", [], true]) {
      expect(validateEventBatch(bad, TOKEN_WORKSPACE)).toEqual({
        ok: false,
        status: 400,
        error: "envelope must be a JSON object",
      });
    }
  });

  it("rejects a wrong batch schema_version", () => {
    const result = validateEventBatch(
      envelope({ schema_version: "hfg.event.v2" }),
      TOKEN_WORKSPACE,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "schema_version must be hfg.event-batch.v1",
    });
  });

  it("accepts a body workspace_id that matches the token binding", () => {
    expect(validateEventBatch(envelope({ workspace_id: TOKEN_WORKSPACE }), TOKEN_WORKSPACE).ok).toBe(true);
  });

  it("treats a foreign body workspace_id as a 404, never 403", () => {
    const result = validateEventBatch(envelope({ workspace_id: OTHER_WORKSPACE }), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("rejects a non-string workspace_id", () => {
    const result = validateEventBatch(envelope({ workspace_id: 17 }), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 400, error: "workspace_id must be a string" });
  });

  it("rejects missing, empty, or non-array events", () => {
    for (const events of [undefined, null, "x", [], {}]) {
      const result = validateEventBatch(envelope({ events }), TOKEN_WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("accepts exactly 500 events and rejects 501", () => {
    const full = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => event({}, i));
    expect(validateEventBatch(envelope({}, full), TOKEN_WORKSPACE).ok).toBe(true);
    const over = [...full, event({}, 500)];
    expect(validateEventBatch(envelope({}, over), TOKEN_WORKSPACE)).toEqual({
      ok: false,
      status: 413,
      error: "batch exceeds 500 events",
    });
  });

  it("validates every event and reports the offending index", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...event(), schema_version: "hfg.event.v2" }, "events[1].schema_version must be hfg.event.v1"],
      [{ ...event({}, 1), event_id: "not-an-id" }, "events[1].event_id must match ^evt_[0-9A-HJKMNP-TV-Z]{26}$"],
      [{ ...event({}, 1), event_id: "evt_01HTEST" }, "events[1].event_id must match ^evt_[0-9A-HJKMNP-TV-Z]{26}$"],
      [{ ...event({}, 1), kind: "" }, "events[1].kind must be a non-empty string"],
      [{ ...event({}, 1), occurred_at: "yesterday" }, "events[1].occurred_at must be an RFC 3339 timestamp"],
      [{ ...event({}, 1), occurred_at: "2026-08-21" }, "events[1].occurred_at must be an RFC 3339 timestamp"],
    ];
    for (const [badEvent, error] of cases) {
      expect(validateEventBatch(envelope({}, [event(), badEvent]), TOKEN_WORKSPACE)).toEqual({
        ok: false,
        status: 400,
        error,
      });
    }
  });

  it("rejects non-object events", () => {
    const result = validateEventBatch(envelope({}, ["nope" as unknown as Record<string, unknown>]), TOKEN_WORKSPACE);
    expect(result).toEqual({ ok: false, status: 400, error: "events[0] must be an object" });
  });
});

// -- pure logic: canonical JSON --------------------------------------------------

describe("canonicalJsonStringify", () => {
  it("sorts object keys at every level", () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order (order is data)", () => {
    expect(canonicalJsonStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("drops undefined values", () => {
    expect(canonicalJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("is stable across key insertion orders", () => {
    const a = canonicalJsonStringify({ x: 1, y: { z: 2, w: 3 } });
    const b = canonicalJsonStringify({ y: { w: 3, z: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it("round-trips unknown envelope fields", () => {
    const value = envelope({ "x-future-field": { b: 1, a: 2 } });
    expect(JSON.parse(canonicalJsonStringify(value))["x-future-field"]).toEqual({ a: 2, b: 1 });
  });
});

// -- pure logic: receipts ---------------------------------------------------------

describe("buildReceipt", () => {
  it("derives a stable, schema-shaped receipt", async () => {
    const first = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const second = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    expect(first).toEqual(second);
    expect(first.batch_id).toMatch(/^batch_[0-9a-f]{32}$/);
    expect(first).toEqual({
      accepted: 1,
      batch_id: first.batch_id,
      schema_version: "hfg.event-batch.receipt.v1",
      workspace_id: TOKEN_WORKSPACE,
    });
  });

  it("differs when the key, workspace, or event ids differ", async () => {
    const base = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherKey = await buildReceipt("key-2", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherWorkspace = await buildReceipt("key-1", OTHER_WORKSPACE, envelope() as EventBatchEnvelope);
    const otherEvents = await buildReceipt(
      "key-1",
      TOKEN_WORKSPACE,
      envelope({}, [event({}, 9)]) as EventBatchEnvelope,
    );
    const ids = new Set([base.batch_id, otherKey.batch_id, otherWorkspace.batch_id, otherEvents.batch_id]);
    expect(ids.size).toBe(4);
  });
});

// -- pure logic: event rows ---------------------------------------------------------

describe("buildEventRows", () => {
  it("stamps the token workspace and idempotency key on every row", () => {
    const value = envelope(
      { workspace_id: OTHER_WORKSPACE }, // body value is ignored by the row builder
      [event({}, 0), event({}, 1)],
    ) as EventBatchEnvelope;
    const rows = buildEventRows(value, TOKEN_WORKSPACE, "key-1", 1_700_000_100);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.workspace_id).toBe(TOKEN_WORKSPACE);
      expect(row.idempotency_key).toBe("key-1");
      expect(row.ingested_at).toBe(1_700_000_100);
      expect(row.kind).toBe("command.completed");
      expect(row.provenance).toBe("OBSERVED");
    }
  });

  it("nulls absent optional fields and preserves raw payloads canonically", () => {
    const minimal = envelope({}, [
      {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: eventId(0),
        kind: "log.observed",
        occurred_at: "2026-08-21T11:00:00Z",
        "x-extra": true,
      },
    ]) as EventBatchEnvelope;
    const [row] = buildEventRows(minimal, TOKEN_WORKSPACE, "k", 1);
    expect(row.workstream_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.native_session_id).toBeNull();
    expect(row.provider).toBeNull();
    expect(row.content_hash).toBeNull();
    expect(row.occurred_at).toBe("2026-08-21T11:00:00Z");
    // raw_json is canonical: sorted keys, unknown fields kept.
    const raw = JSON.parse(row.raw_json);
    expect(raw["x-extra"]).toBe(true);
    expect(row.raw_json.indexOf('"kind"')).toBeLessThan(row.raw_json.indexOf('"occurred_at"'));
  });
});

// -- pure logic: cursors and pagination ----------------------------------------------

describe("cursors", () => {
  it("round-trips", () => {
    const cursor = { createdAt: 1_700_000_042, id: workstreamId(0) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["", "!!!", "aGVsbG8=", "aGVsbG8=@#"]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("rejects cursors with wrong field types", () => {
    expect(decodeCursor(btoa(JSON.stringify({ created_at: "1", id: workstreamId(0) })))).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ created_at: 1 })))).toBeNull();
  });
});

describe("parsePagination", () => {
  const url = (query: string) => new URL(`https://api.test/v1/workstreams${query}`);

  it("defaults to 50 with no cursor", () => {
    expect(parsePagination(url(""))).toEqual({ ok: true, value: { limit: 50, cursor: null } });
  });

  it("accepts limits from 1 to 100", () => {
    expect(parsePagination(url("?limit=1")).ok).toBe(true);
    const max = parsePagination(url("?limit=100"));
    expect(max.ok && max.value.limit).toBe(100);
  });

  it("rejects out-of-range, fractional, or non-numeric limits", () => {
    for (const bad of ["0", "-1", "101", "1.5", "abc", ""]) {
      expect(parsePagination(url(`?limit=${encodeURIComponent(bad)}`)).ok).toBe(false);
    }
  });

  it("treats an empty cursor as absent", () => {
    expect(parsePagination(url("?cursor="))).toEqual({
      ok: true,
      value: { limit: 50, cursor: null },
    });
  });

  it("accepts a valid cursor and rejects a malformed one", () => {
    const encoded = encodeCursor({ createdAt: 5, id: workstreamId(0) });
    expect(parsePagination(url(`?cursor=${encoded}&limit=10`))).toEqual({
      ok: true,
      value: { limit: 10, cursor: { createdAt: 5, id: workstreamId(0) } },
    });
    expect(parsePagination(url("?cursor=bogus"))).toEqual({
      ok: false,
      status: 400,
      error: "cursor is invalid",
    });
  });
});

// -- pure logic: workstream page shaping ----------------------------------------------

describe("buildWorkstreamListResponse", () => {
  it("sorts rows deterministically (created_at DESC, then id DESC)", () => {
    const rows = [workstreamRow(1), workstreamRow(3), workstreamRow(2)];
    const page = buildWorkstreamListResponse(rows, 50);
    expect(page.workstreams.map((w) => w.id)).toEqual([
      workstreamRow(3).id,
      workstreamRow(2).id,
      workstreamRow(1).id,
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it("breaks ties on id when created_at matches", () => {
    const tie = (id: string): WorkstreamRow => ({
      ...workstreamRow(7),
      id,
      created_at: 1_700_000_999,
    });
    const tieA = `${workstreamId(0).slice(0, -1)}A`;
    const tieZ = `${workstreamId(0).slice(0, -1)}Z`;
    const page = buildWorkstreamListResponse([tieA, tieZ].map((id) => tie(id)), 50);
    expect(page.workstreams.map((w) => w.id)).toEqual([
      `${workstreamId(0).slice(0, -1)}Z`,
      `${workstreamId(0).slice(0, -1)}A`,
    ]);
  });

  it("emits a next_cursor only when the limit+1 prefetch row exists", () => {
    const rows = [workstreamRow(0), workstreamRow(1), workstreamRow(2)];
    const page = buildWorkstreamListResponse(rows, 2);
    expect(page.workstreams.map((w) => w.id)).toEqual([workstreamRow(2).id, workstreamRow(1).id]);
    expect(decodeCursor(page.next_cursor ?? "")).toEqual({
      createdAt: workstreamRow(1).created_at,
      id: workstreamRow(1).id,
    });
  });

  it("returns no next_cursor when the page is exactly full", () => {
    const page = buildWorkstreamListResponse([workstreamRow(0), workstreamRow(1)], 2);
    expect(page.workstreams).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it("omits internal columns from the summary", () => {
    const [summary] = buildWorkstreamListResponse([workstreamRow(0)], 50).workstreams;
    expect(Object.keys(summary).sort()).toEqual([
      "created_at",
      "id",
      "repository_id",
      "status",
      "title",
      "updated_at",
    ]);
  });
});

// -- pure logic: scope denial rule ------------------------------------------------------

describe("scopeDenial", () => {
  it("answers 404 for foreign resources (never leak existence)", () => {
    expect(
      scopeDenial({ resourceWorkspaceId: OTHER_WORKSPACE, tokenWorkspaceId: TOKEN_WORKSPACE }),
    ).toEqual({ status: 404, error: "not found" });
  });

  it("answers 403 for own-but-forbidden resources", () => {
    expect(
      scopeDenial({
        resourceWorkspaceId: TOKEN_WORKSPACE,
        tokenWorkspaceId: TOKEN_WORKSPACE,
        allowed: false,
      }),
    ).toEqual({ status: 403, error: "forbidden" });
  });

  it("allows own resources and absent resource ids", () => {
    expect(
      scopeDenial({ resourceWorkspaceId: TOKEN_WORKSPACE, tokenWorkspaceId: TOKEN_WORKSPACE, allowed: true }),
    ).toBeNull();
    expect(scopeDenial({ tokenWorkspaceId: TOKEN_WORKSPACE, allowed: true })).toBeNull();
    expect(scopeDenial({ tokenWorkspaceId: TOKEN_WORKSPACE })).toBeNull();
  });
});

// -- handler tests (mocked D1) -----------------------------------------------------------

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  all?: (sql: string, binds: unknown[]) => unknown[] | Promise<unknown[]>;
  batch?: (statements: RecordedStatement[]) => void;
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
    async batch<T = unknown>(batchStatements: D1BoundStatement[]) {
      const recorded = batchStatements.map((statement) => statement as unknown as RecordedStatement);
      batches.push(recorded);
      handlers.batch?.(recorded);
      return [] as T[];
    },
  };
  return { db, statements, batches };
}

const CTX = {} as never; // ExecutionContext stub (unused by handlers)

function makeEnv(db: D1DatabaseLike): Env {
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

/** Registry mock: devices resolve for the test token; everything else misses. */
function deviceRegistry(overrides: Record<string, unknown> = {}) {
  return async (sql: string): Promise<unknown> =>
    sql.includes("FROM devices") ? deviceRow(overrides) : null;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

describe("worker: routing", () => {
  it("answers /healthz without auth", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(request("/healthz"), makeEnv(db), CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("answers 404 for unknown paths and methods", async () => {
    const { db } = mockDb();
    expect((await worker.fetch(request("/nope"), makeEnv(db), CTX)).status).toBe(404);
    // GET on the POST-only ingest route
    expect((await worker.fetch(request("/v1/event-batches"), makeEnv(db), CTX)).status).toBe(404);
    // POST on the GET-only listing route
    expect(
      (await worker.fetch(request("/v1/workstreams", { method: "POST" }), makeEnv(db), CTX)).status,
    ).toBe(404);
  });
});

describe("worker: POST /v1/event-batches", () => {
  it("stores the batch and returns a deterministic receipt", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      batch_id: expect.stringMatching(/^batch_[0-9a-f]{32}$/),
      schema_version: "hfg.event-batch.receipt.v1",
      workspace_id: TOKEN_WORKSPACE,
    });

    // One atomic batch: the idempotency insert plus one event insert.
    expect(batches).toHaveLength(1);
    const [idempotencyInsert, eventInsert] = batches[0];
    expect(idempotencyInsert.sql).toContain("INSERT INTO idempotency_keys");
    expect(idempotencyInsert.binds[0]).toBe("key-1");
    expect(idempotencyInsert.binds[1]).toBe(TOKEN_WORKSPACE);
    expect(idempotencyInsert.binds[2]).toBe(DEVICE_ID);
    expect(eventInsert.sql).toContain("INSERT OR IGNORE INTO events");
    expect(eventInsert.binds[0]).toBe(TOKEN_WORKSPACE); // workspace from the token, never the body
    expect(eventInsert.binds[1]).toBe(eventId(0));
    expect(eventInsert.binds[2]).toBe("key-1");
    expect(String(eventInsert.binds[12])).toContain('"schema_version":"hfg.event.v1"');
  });

  it("returns the original receipt bytes for a duplicate key without re-storing", async () => {
    const receipt = await buildReceipt("key-1", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const receiptJson = canonicalJsonStringify(receipt);
    const { db, batches } = mockDb({
      first: async (sql, binds) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          expect(binds[0]).toBe("key-1");
          return { workspace_id: TOKEN_WORKSPACE, receipt_json: receiptJson };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(receiptJson);
    expect(batches).toHaveLength(0);
  });

  it("answers 404 for a duplicate key owned by a foreign workspace", async () => {
    const { db } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          return { workspace_id: OTHER_WORKSPACE, receipt_json: "{}" };
        }
        return null;
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "collided-key" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("requires the Idempotency-Key header", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    for (const extra of [undefined, { "idempotency-key": "   " }]) {
      const response = await worker.fetch(
        request("/v1/event-batches", {
          method: "POST",
          headers: authed(extra),
          body: JSON.stringify(envelope()),
        }),
        makeEnv(db),
        CTX,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Idempotency-Key header is required" });
    }
  });

  it("rejects requests without a valid device token", async () => {
    const { db } = mockDb({ first: async () => null });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: { "idempotency-key": "key-1" },
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a revoked device", async () => {
    const { db } = mockDb({
      first: deviceRegistry({ revoked_at: 1_700_000_000 }),
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a body over 1 MiB with 413", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: "x".repeat(MAX_BODY_BYTES + 16),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body exceeds 1 MiB" });
  });

  it("rejects invalid JSON with 400", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: "{not json",
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body is not valid JSON" });
  });

  it("rejects an invalid envelope (fail-closed) without storing anything", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope({ schema_version: "wrong" })),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it("answers 404 when the body claims a foreign workspace", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "key-1" }),
        body: JSON.stringify(envelope({ workspace_id: OTHER_WORKSPACE })),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("recovers the winner's receipt when a concurrent duplicate loses the insert race", async () => {
    const receipt = await buildReceipt("race-key", TOKEN_WORKSPACE, envelope() as EventBatchEnvelope);
    const receiptJson = canonicalJsonStringify(receipt);
    let firstRead = true;
    const { db } = mockDb({
      first: async (sql) => {
        if (sql.includes("FROM devices")) return deviceRow();
        if (sql.includes("FROM idempotency_keys")) {
          if (firstRead) {
            firstRead = false;
            return null;
          }
          return { workspace_id: TOKEN_WORKSPACE, receipt_json: receiptJson };
        }
        return null;
      },
      batch: () => {
        throw new Error("UNIQUE constraint failed: idempotency_keys.key");
      },
    });
    const response = await worker.fetch(
      request("/v1/event-batches", {
        method: "POST",
        headers: authed({ "idempotency-key": "race-key" }),
        body: JSON.stringify(envelope()),
      }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(receiptJson);
  });
});

describe("worker: GET /v1/workstreams", () => {
  /** Registry answers for the test token; workstreams queries page `rows`. */
  function listDb(rows: WorkstreamRow[]) {
    // Emulate the SQL contract: ORDER BY created_at DESC, id DESC.
    const ordered = [...rows].sort(
      (a, b) => b.created_at - a.created_at || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0),
    );
    return mockDb({
      first: deviceRegistry(),
      all: async (sql, binds) => {
        expect(sql).toContain("FROM workstreams");
        const fetchLimit = binds[binds.length - 1] as number;
        let page = ordered;
        if (binds.length === 4) {
          const createdAt = binds[1] as number;
          const id = binds[2] as string;
          page = ordered.filter(
            (row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id),
          );
        }
        return page.slice(0, fetchLimit);
      },
    });
  }

  it("pages newest-first with a next_cursor when more rows exist", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => workstreamRow(i));
    const { db } = listDb(rows);
    const response = await worker.fetch(
      request("/v1/workstreams", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workstreams: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.workstreams).toHaveLength(50);
    expect(body.workstreams[0].id).toBe(workstreamRow(54).id);
    expect(body.workstreams[49].id).toBe(workstreamRow(5).id);
    expect(decodeCursor(body.next_cursor ?? "")).toEqual({
      createdAt: workstreamRow(5).created_at,
      id: workstreamRow(5).id,
    });
  });

  it("follows the cursor to the final page (next_cursor null)", async () => {
    const rows = [workstreamRow(4), workstreamRow(3), workstreamRow(2), workstreamRow(1), workstreamRow(0)];
    const { db } = listDb(rows);
    const first = (await (
      await worker.fetch(request("/v1/workstreams?limit=3", { headers: authed() }), makeEnv(db), CTX)
    ).json()) as { workstreams: unknown[]; next_cursor: string | null };
    expect(first.workstreams).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();
    const second = await worker.fetch(
      request(`/v1/workstreams?limit=3&cursor=${first.next_cursor}`, { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as { workstreams: unknown[]; next_cursor: string | null };
    expect(body.workstreams).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it("scopes the SQL query to the token workspace", async () => {
    const seenBinds: unknown[][] = [];
    const { db } = mockDb({
      first: deviceRegistry(),
      all: async (_sql, binds) => {
        seenBinds.push(binds);
        return [];
      },
    });
    await worker.fetch(request("/v1/workstreams", { headers: authed() }), makeEnv(db), CTX);
    expect(seenBinds[0][0]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects invalid pagination parameters with 400", async () => {
    const { db } = listDb([]);
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?cursor=bogus"]) {
      const response = await worker.fetch(
        request(`/v1/workstreams${query}`, { headers: authed() }),
        makeEnv(db),
        CTX,
      );
      expect(response.status).toBe(400);
    }
  });

  it("requires authentication", async () => {
    const { db } = listDb([]);
    const response = await worker.fetch(request("/v1/workstreams"), makeEnv(db), CTX);
    expect(response.status).toBe(401);
  });

  it("answers 403 for a device without the read capability", async () => {
    const { db } = mockDb({
      first: deviceRegistry({ capabilities: "ingest" }),
      all: async () => [],
    });
    const response = await worker.fetch(
      request("/v1/workstreams", { headers: authed() }),
      makeEnv(db),
      CTX,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
