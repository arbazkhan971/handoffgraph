// Unit tests for src/apikeys.ts: key lifecycle (create/list/revoke), the
// edge-cached authenticateApiKey verification path (including the
// zero-D1-queries-on-a-cached-verdict property), the public read API under
// /api/v1/*, the OpenAPI document's bidirectional completeness against the
// route table — plus a node:sqlite pass proving migration 0011's CHECK
// constraints and triggers hold.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import {
  ALLOWED_SCOPE_VALUES,
  PUBLIC_API_ROUTES,
  authenticateApiKey,
  authenticateReadPrincipal,
  buildOpenApiDocument,
  handleApiKeysRoute,
  principalCanWrite,
  type ApiKeysEnv,
  type KVNamespaceLike,
} from "../src/apikeys";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts, test/webhooks.test.ts) --

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const statement: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          statement.binds = values;
          return statement;
        },
        async first<T = unknown>() {
          return (await handlers.first?.(statement) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: (await handlers.all?.(statement) ?? []) as T[] };
        },
        async run() {
          await handlers.run?.(statement);
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      return bound.map(() => ({ success: true }));
    },
  };
  return { db, statements };
}

// -- fake KV --------------------------------------------------------------------

function fakeKV(): { kv: KVNamespaceLike; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KVNamespaceLike = {
    async get(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return { kv, store };
}

// -- fixtures -----------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const APK_ONE = `apk_01J${"A".repeat(23)}`;
const APK_TWO = `apk_01J${"B".repeat(23)}`;
const SK_TOKEN = "sk_test-secret-AAAAAAAAAAAAAAAAAAAA";
const WS = "ws_01HTESTWS0000000000000000Z";

let TOKEN_HASH = "";
let SK_HASH = "";
beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  SK_HASH = await sha256Hex(SK_TOKEN);
});

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

/** Resolves device auth from `FROM devices`, delegates everything else. */
function authedFirst(
  extra: (statement: RecordedStatement) => unknown | Promise<unknown> = () => null,
  deviceOverrides: Record<string, unknown> = {},
): (statement: RecordedStatement) => unknown | Promise<unknown> {
  return async (statement) => {
    if (statement.sql.includes("FROM devices")) return deviceRow(deviceOverrides);
    return extra(statement);
  };
}

function apiKeyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APK_ONE,
    workspace_id: TOKEN_WORKSPACE,
    secret_hash: SK_HASH,
    scopes: JSON.stringify(["read"]),
    revoked_at: null,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

// -- authenticateApiKey: edge-cached verification --------------------------------

describe("authenticateApiKey", () => {
  it("rejects a missing Authorization header without touching D1 or KV", async () => {
    const { db, statements } = mockDb();
    const { kv, store } = fakeKV();
    const result = await authenticateApiKey(null, { DB: db, APIKEY_KV: kv });
    expect(result.ok).toBe(false);
    expect(statements).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("performs zero D1 queries on a second call with the same bad key (edge-cached rejection)", async () => {
    const { kv } = fakeKV();
    const { db, statements } = mockDb({ first: async () => null });
    const env: ApiKeysEnv = { DB: db, APIKEY_KV: kv };
    const header = "Bearer sk_totally-bogus-key";

    const first = await authenticateApiKey(header, env);
    expect(first.ok).toBe(false);
    const afterFirst = statements.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await authenticateApiKey(header, env);
    expect(second.ok).toBe(false);
    expect(statements).toHaveLength(afterFirst); // no new D1 queries at all
  });

  it("caches a good verdict too: second call with the same key performs zero D1 queries", async () => {
    const { kv } = fakeKV();
    const { db, statements } = mockDb({ first: async () => apiKeyRow() });
    const env: ApiKeysEnv = { DB: db, APIKEY_KV: kv };
    const header = `Bearer ${SK_TOKEN}`;

    const first = await authenticateApiKey(header, env);
    expect(first.ok).toBe(true);
    const afterFirst = statements.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await authenticateApiKey(header, env);
    expect(second).toEqual(first);
    expect(statements).toHaveLength(afterFirst);
  });

  it("falls back to D1 on every call while APIKEY_KV is not provisioned", async () => {
    const { db, statements } = mockDb({ first: async () => null });
    const env: ApiKeysEnv = { DB: db }; // no APIKEY_KV
    await authenticateApiKey("Bearer sk_bogus", env);
    await authenticateApiKey("Bearer sk_bogus", env);
    expect(statements).toHaveLength(2);
  });

  it("resolves workspace and scopes for a known, active key", async () => {
    const { db } = mockDb({ first: async () => apiKeyRow({ scopes: JSON.stringify(["read", "write"]) }) });
    const result = await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: db });
    expect(result).toEqual({ ok: true, workspaceId: TOKEN_WORKSPACE, scopes: ["read", "write"], keyId: APK_ONE });
  });

  it("rejects a revoked key even though the row is found", async () => {
    const { db } = mockDb({ first: async () => apiKeyRow({ revoked_at: 1_700_000_000 }) });
    const result = await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: db });
    expect(result.ok).toBe(false);
  });

  it("ignores a malformed cached verdict and falls through to D1 instead of trusting it", async () => {
    const { kv, store } = fakeKV();
    const { db: seedDb } = mockDb({ first: async () => apiKeyRow() });
    await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: seedDb, APIKEY_KV: kv });
    expect(store.size).toBe(1);
    const [cacheKey] = store.keys();
    store.set(cacheKey, "not-json");

    const { db, statements } = mockDb({ first: async () => apiKeyRow() });
    const result = await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: db, APIKEY_KV: kv });
    expect(result.ok).toBe(true);
    expect(statements).toHaveLength(1); // fell through to D1, not the garbage cache entry
  });

  it("normalizes stored scopes defensively (unknown values dropped, empty defaults to read)", async () => {
    const { db } = mockDb({ first: async () => apiKeyRow({ scopes: JSON.stringify(["write", "bogus", "write"]) }) });
    const result = await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: db });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(["write"]);
  });
});

// -- authenticateReadPrincipal + principalCanWrite -------------------------------

describe("authenticateReadPrincipal", () => {
  it("resolves an sk_ key to an apikey principal", async () => {
    const { db } = mockDb({ first: async () => apiKeyRow() });
    const result = await authenticateReadPrincipal(request("/x", { headers: { authorization: `Bearer ${SK_TOKEN}` } }), { DB: db });
    expect("principal" in result).toBe(true);
    if ("principal" in result) expect(result.principal).toEqual({ kind: "apikey", workspaceId: TOKEN_WORKSPACE, scopes: ["read"], keyId: APK_ONE });
  });

  it("resolves a device bearer token with 'read' to a device principal", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const result = await authenticateReadPrincipal(request("/x", { headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }), { DB: db });
    expect("principal" in result).toBe(true);
    if ("principal" in result) expect(result.principal).toEqual({ kind: "device", workspaceId: TOKEN_WORKSPACE, capabilities: ["ingest", "read"] });
  });

  it("403s a device token without 'read'", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "ingest" }) });
    const result = await authenticateReadPrincipal(request("/x", { headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }), { DB: db });
    expect("response" in result).toBe(true);
    if ("response" in result) expect(result.response.status).toBe(403);
  });

  it("401s with no Authorization header", async () => {
    const { db } = mockDb();
    const result = await authenticateReadPrincipal(request("/x"), { DB: db });
    expect("response" in result).toBe(true);
    if ("response" in result) expect(result.response.status).toBe(401);
  });
});

describe("principalCanWrite", () => {
  it("a device principal needs the 'ingest' capability", () => {
    expect(principalCanWrite({ kind: "device", workspaceId: TOKEN_WORKSPACE, capabilities: ["read"] })).toBe(false);
    expect(principalCanWrite({ kind: "device", workspaceId: TOKEN_WORKSPACE, capabilities: ["read", "ingest"] })).toBe(true);
  });
  it("an apikey principal needs the 'write' scope", () => {
    expect(principalCanWrite({ kind: "apikey", workspaceId: TOKEN_WORKSPACE, scopes: ["read"], keyId: APK_ONE })).toBe(false);
    expect(principalCanWrite({ kind: "apikey", workspaceId: TOKEN_WORKSPACE, scopes: ["read", "write"], keyId: APK_ONE })).toBe(true);
  });
});

// -- POST /v1/api-keys ------------------------------------------------------------

describe("POST /v1/api-keys", () => {
  it("creates a key and shows the secret exactly once, defaulting scopes to ['read']", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const res = await handleApiKeysRoute(
      request("/v1/api-keys", {
        method: "POST",
        headers: { authorization: `Bearer ${DEVICE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "ci bot" }),
      }),
      { DB: db },
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(201);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.public_key).toMatch(/^pk_/);
    expect(body.secret_key).toMatch(/^sk_/);
    expect(body.scopes).toEqual(["read"]);
    expect(body.name).toBe("ci bot");
    expect(statements.some((s) => s.sql.includes("apikeys:insert"))).toBe(true);
  });

  it("accepts an explicit scopes array", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const res = await handleApiKeysRoute(
      request("/v1/api-keys", {
        method: "POST",
        headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
        body: JSON.stringify({ name: "writer", scopes: ["write", "read"] }),
      }),
      { DB: db },
    );
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.scopes).toEqual(["read", "write"]); // deduped + sorted
  });

  it("rejects an empty name", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const res = await handleApiKeysRoute(
      request("/v1/api-keys", { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` }, body: JSON.stringify({ name: "" }) }),
      { DB: db },
    );
    expect(res?.status).toBe(400);
  });

  it("rejects an unknown scope value", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const res = await handleApiKeysRoute(
      request("/v1/api-keys", {
        method: "POST",
        headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
        body: JSON.stringify({ name: "x", scopes: ["admin"] }),
      }),
      { DB: db },
    );
    expect(res?.status).toBe(400);
  });

  it("requires the device 'ingest' capability", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const res = await handleApiKeysRoute(
      request("/v1/api-keys", { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` }, body: JSON.stringify({ name: "x" }) }),
      { DB: db },
    );
    expect(res?.status).toBe(403);
  });

  it("401s without a valid device token", async () => {
    const { db } = mockDb({ first: async () => null });
    const res = await handleApiKeysRoute(request("/v1/api-keys", { method: "POST", body: "{}" }), { DB: db });
    expect(res?.status).toBe(401);
  });
});

// -- GET /v1/api-keys ---------------------------------------------------------------

describe("GET /v1/api-keys", () => {
  it("lists keys in an {items, next_cursor} envelope, never including secret material", async () => {
    const { db } = mockDb({
      first: authedFirst(),
      all: async () => [
        { id: APK_ONE, name: "ci", public_key: "pk_aaaaaaaaaaaa", scopes: JSON.stringify(["read"]), created_at: 1_700_000_001, revoked_at: null },
      ],
    });
    const res = await handleApiKeysRoute(request("/v1/api-keys", { headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }), { DB: db });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { items: Record<string, unknown>[]; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.public_key).toBe("pk_aaaaaaaaaaaa");
    expect(body.next_cursor).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/sk_|secret_hash|secret_key/);
  });
});

// -- POST /v1/api-keys/{id}/revoke -------------------------------------------------

describe("POST /v1/api-keys/{id}/revoke", () => {
  it("revokes the key and writes an immediate KV tombstone", async () => {
    const { kv, store } = fakeKV();
    const { db } = mockDb({
      first: authedFirst(async (s) => (s.sql.includes("apikeys:revoke") ? { id: APK_ONE, secret_hash: SK_HASH } : null)),
    });
    const res = await handleApiKeysRoute(
      request(`/v1/api-keys/${APK_ONE}/revoke`, { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }),
      { DB: db, APIKEY_KV: kv },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { id: string; revoked_at: number };
    expect(body.id).toBe(APK_ONE);
    expect(store.size).toBe(1);
    const [, cachedValue] = [...store.entries()][0] as [string, string];
    expect(JSON.parse(cachedValue)).toEqual({ v: "rejected" });
  });

  it("a subsequent authenticateApiKey call for the revoked secret is rejected from the tombstone alone", async () => {
    const { kv, store } = fakeKV();
    const { db: revokeDb } = mockDb({
      first: authedFirst(async (s) => (s.sql.includes("apikeys:revoke") ? { id: APK_ONE, secret_hash: SK_HASH } : null)),
    });
    await handleApiKeysRoute(
      request(`/v1/api-keys/${APK_ONE}/revoke`, { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }),
      { DB: revokeDb, APIKEY_KV: kv },
    );
    expect(store.size).toBe(1);

    const { db, statements } = mockDb({ first: async () => apiKeyRow() }); // D1 would (wrongly) say "still active"
    const result = await authenticateApiKey(`Bearer ${SK_TOKEN}`, { DB: db, APIKEY_KV: kv });
    expect(result.ok).toBe(false);
    expect(statements).toHaveLength(0); // the tombstone alone rejected it, D1 never consulted
  });

  it("404s for an unknown id, and for an id that belongs to a different workspace (never distinguishable)", async () => {
    const { db } = mockDb({ first: authedFirst(async (s) => (s.sql.includes("apikeys:revoke") ? null : undefined)) });
    const res = await handleApiKeysRoute(
      request(`/v1/api-keys/${APK_TWO}/revoke`, { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }),
      { DB: db },
    );
    expect(res?.status).toBe(404);
  });

  it("requires the device 'ingest' capability", async () => {
    const { db } = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const res = await handleApiKeysRoute(
      request(`/v1/api-keys/${APK_ONE}/revoke`, { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }),
      { DB: db },
    );
    expect(res?.status).toBe(403);
  });
});

// -- public read API (GET /api/v1/*) ------------------------------------------

describe("public read API", () => {
  it("GET /api/v1/workstreams via an sk_ key", async () => {
    const { db } = mockDb({
      first: async (s) => (s.sql.includes("lookup-by-secret-hash") ? apiKeyRow() : null),
      all: async () => [
        { id: WS, workspace_id: TOKEN_WORKSPACE, title: "t", status: "active", repository_id: null, created_at: 1, updated_at: 1 },
      ],
    });
    const res = await handleApiKeysRoute(request("/api/v1/workstreams", { headers: { authorization: `Bearer ${SK_TOKEN}` } }), { DB: db });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(WS);
  });

  it("GET /api/v1/sessions via a device 'read' bearer token", async () => {
    const { db } = mockDb({ first: authedFirst(), all: async () => [] });
    const res = await handleApiKeysRoute(request("/api/v1/sessions", { headers: { authorization: `Bearer ${DEVICE_TOKEN}` } }), { DB: db });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { items: unknown[]; next_cursor: null };
    expect(body).toEqual({ items: [], next_cursor: null });
  });

  it("GET /api/v1/observations requires a credential", async () => {
    const { db } = mockDb();
    const res = await handleApiKeysRoute(request("/api/v1/observations"), { DB: db });
    expect(res?.status).toBe(401);
  });

  it("GET /api/v1/scores requires a workstream query parameter", async () => {
    const { db } = mockDb({ first: async () => apiKeyRow() });
    const res = await handleApiKeysRoute(request("/api/v1/scores", { headers: { authorization: `Bearer ${SK_TOKEN}` } }), { DB: db });
    expect(res?.status).toBe(400);
  });

  it("GET /api/v1/scores lists score.recorded events for one workstream", async () => {
    const rawEvent = {
      schema_version: "hfg.event.v1",
      event_id: "evt_x",
      kind: "score.recorded",
      occurred_at: "2026-08-21T10:00:00.000Z",
      observed_at: "2026-08-21T10:00:00.000Z",
      workstream_id: WS,
      provenance: "OBSERVED",
      payload: { name: "handoff.validity", data_type: "NUMERIC", value: "0.9", target_type: "workstream", target_id: WS, source: "api" },
    };
    const { db } = mockDb({
      first: async (s) => (s.sql.includes("lookup-by-secret-hash") ? apiKeyRow() : null),
      all: async () => [{ seq: 1, event_id: "evt_x", workstream_id: WS, occurred_at: rawEvent.occurred_at, provenance: "OBSERVED", raw_json: JSON.stringify(rawEvent) }],
    });
    const res = await handleApiKeysRoute(request(`/api/v1/scores?workstream=${WS}`, { headers: { authorization: `Bearer ${SK_TOKEN}` } }), { DB: db });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ score_id: "evt_x", name: "handoff.validity", data_type: "NUMERIC", value: "0.9" });
  });

  it("a wrong method on a known public path 404s (house rule)", async () => {
    const { db } = mockDb();
    const res = await handleApiKeysRoute(request("/api/v1/workstreams", { method: "POST" }), { DB: db });
    expect(res).toBeNull(); // not owned at this method -> index.ts's platform 404
  });
});

// -- OpenAPI: valid JSON + bidirectional route-table completeness -------------

describe("GET /api/v1/openapi.json", () => {
  it("is valid JSON describing exactly the implemented public GET routes", async () => {
    const { db } = mockDb();
    const res = await handleApiKeysRoute(request("/api/v1/openapi.json"), { DB: db });
    expect(res?.status).toBe(200);
    const text = await res!.text();
    const doc = JSON.parse(text) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");

    const documentedPaths = Object.keys(doc.paths).sort();
    const implementedPaths = PUBLIC_API_ROUTES.map((r) => r.path).sort();
    // Bidirectional: every implemented path is documented, and vice versa.
    expect(documentedPaths).toEqual(implementedPaths);
  });

  it("every documented path is actually routed (probed live, not just structurally)", async () => {
    const { db } = mockDb();
    for (const route of PUBLIC_API_ROUTES) {
      const probe = await handleApiKeysRoute(request(route.path), { DB: db });
      // Unauthenticated but ROUTED: 401, never null (which would mean the
      // path isn't owned and falls through to index.ts's 404).
      expect(probe).not.toBeNull();
      expect(probe?.status).toBe(401);
    }
  });

  it("buildOpenApiDocument() matches PUBLIC_API_ROUTES 1:1", () => {
    const doc = buildOpenApiDocument();
    expect(Object.keys(doc.paths as Record<string, unknown>)).toHaveLength(PUBLIC_API_ROUTES.length);
    for (const route of PUBLIC_API_ROUTES) {
      expect(doc.paths as Record<string, unknown>).toHaveProperty(route.path);
    }
  });
});

// -- pure logic -----------------------------------------------------------------

describe("limits", () => {
  it("pins the allowed scope vocabulary", () => {
    expect(ALLOWED_SCOPE_VALUES).toEqual(["read", "write"]);
  });
});

// -- migration 0011: CHECK constraints + triggers (node:sqlite) -----------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0011_api_keys.sql";
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

const HASH64 = "b".repeat(64);

function insertApiKey(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: APK_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "ci bot",
    public_key: "pk_aaaaaaaaaaaa",
    secret_hash: HASH64,
    scopes: JSON.stringify(["read"]),
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO api_keys (id, workspace_id, name, public_key, secret_hash, scopes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.name as string,
    row.public_key as string,
    row.secret_hash as string,
    row.scopes as string,
    row.created_at as number,
  );
}

describe("0011 api_keys migration (node:sqlite)", () => {
  it("creates the api_keys table", () => {
    const db = migratedDatabase();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toContain("api_keys");
    db.close();
  });

  it("accepts a well-formed row and rejects a malformed id", () => {
    const db = migratedDatabase();
    expect(() => insertApiKey(db)).not.toThrow();
    expect(() => insertApiKey(db, { id: "not_an_id" })).toThrow();
    expect(() => insertApiKey(db, { id: `apk_${"9".repeat(26)}` })).toThrow(); // first char must be 0-7
    db.close();
  });

  it("rejects a malformed public_key", () => {
    const db = migratedDatabase();
    expect(() => insertApiKey(db, { public_key: "not-prefixed-and-too-long" })).toThrow();
    expect(() => insertApiKey(db, { public_key: "sk_wrongprefix" })).toThrow();
    db.close();
  });

  it("rejects a malformed secret_hash", () => {
    const db = migratedDatabase();
    expect(() => insertApiKey(db, { secret_hash: "too-short" })).toThrow();
    expect(() => insertApiKey(db, { secret_hash: "Z".repeat(64) })).toThrow(); // must be lowercase hex
    db.close();
  });

  it("rejects scopes that are not a non-empty JSON array", () => {
    const db = migratedDatabase();
    expect(() => insertApiKey(db, { scopes: "not-json" })).toThrow();
    expect(() => insertApiKey(db, { scopes: JSON.stringify({ a: 1 }) })).toThrow();
    expect(() => insertApiKey(db, { scopes: JSON.stringify([]) })).toThrow();
    db.close();
  });

  it("requires workspace_id (platform-wide convention)", () => {
    const db = migratedDatabase();
    expect(() =>
      db.prepare(`
        INSERT INTO api_keys (id, name, public_key, secret_hash, scopes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(APK_ONE, "ci", "pk_aaaaaaaaaaaa", HASH64, JSON.stringify(["read"]), 1),
    ).toThrow();
    db.close();
  });

  it("makes revocation terminal: revoked_at cannot be cleared once set", () => {
    const db = migratedDatabase();
    insertApiKey(db);
    db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(1_700_000_100, APK_ONE);
    expect(() => db.prepare(`UPDATE api_keys SET revoked_at = NULL WHERE id = ?`).run(APK_ONE)).toThrow();
    db.close();
  });

  it("makes identity fields immutable after creation", () => {
    const db = migratedDatabase();
    insertApiKey(db);
    expect(() => db.prepare(`UPDATE api_keys SET name = 'renamed' WHERE id = ?`).run(APK_ONE)).toThrow();
    expect(() =>
      db.prepare(`UPDATE api_keys SET scopes = ? WHERE id = ?`).run(JSON.stringify(["read", "write"]), APK_ONE),
    ).toThrow();
    db.close();
  });

  it("still allows revoking after the identity-immutable trigger is in place", () => {
    const db = migratedDatabase();
    insertApiKey(db);
    expect(() => db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(1_700_000_100, APK_ONE)).not.toThrow();
    db.close();
  });
});
