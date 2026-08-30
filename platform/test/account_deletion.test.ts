import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  accountDeletionScheduled,
  deleteAccount,
  handleAccountRoute,
  workspaceObjectPrefixes,
  type AccountDeletionEnv,
  type AccountKVNamespaceLike,
  type AccountR2BucketLike,
} from "../src/account";
import { sha256Hex } from "../src/auth";
import { deletionLedgerKey } from "../src/deletion_ledger";
import { HOSTED_CAPACITY_KEY } from "../src/hosted_capacity_ledger";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1RunResultLike,
  D1Statement,
} from "../src/db";
import worker from "../src/index";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(testDirectory, "../migrations");

const WS_ONE = `wsp_01J${"A".repeat(23)}`;
const WS_TWO = `wsp_01J${"B".repeat(23)}`;
const USER_ONE = `usr_01J${"C".repeat(23)}`;
const USER_TWO = `usr_01J${"D".repeat(23)}`;
const SESSION_ONE = `acs_01J${"E".repeat(23)}`;
const SESSION_TWO = `acs_01J${"F".repeat(23)}`;
const EVENT_ONE = `evt_01J${"G".repeat(23)}`;
const EVENT_TWO = `evt_01J${"H".repeat(23)}`;
const API_KEY_ONE = `apk_01J${"J".repeat(23)}`;
const API_KEY_TWO = `apk_01J${"K".repeat(23)}`;
const GATEWAY_KEY_ONE = `gwk_01J${"M".repeat(23)}`;
const GATEWAY_KEY_TWO = `gwk_01J${"N".repeat(23)}`;
const API_HASH_ONE = "a".repeat(64);
const API_HASH_TWO = "b".repeat(64);
const GATEWAY_HASH_ONE = "c".repeat(64);
const GATEWAY_HASH_TWO = "d".repeat(64);
const SESSION_TOKEN_ONE = `hfg_session_${"s".repeat(40)}`;
const SESSION_TOKEN_TWO = `hfg_session_${"t".repeat(40)}`;
const CSRF_ONE = "csrf-one-with-at-least-thirty-two-bytes";
const CSRF_TWO = "csrf-two-with-at-least-thirty-two-bytes";
const DEVICE_TOKEN_ONE = `hfg_dev_${"a".repeat(40)}`;

class SqliteBoundStatement implements D1BoundStatement {
  readonly sql: string;
  private values: SQLInputValue[] = [];

  constructor(
    private readonly native: DatabaseSync,
    sql: string,
    private readonly beforeStatement?: (
      operation: "first" | "all" | "run",
      sql: string,
    ) => Promise<void>,
  ) {
    this.sql = sql;
  }

  bind(...values: unknown[]): D1BoundStatement {
    this.values = values as SQLInputValue[];
    return this;
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    await this.beforeStatement?.("first", this.sql);
    const row = this.native.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (columnName !== undefined) return (row[columnName] ?? null) as T | null;
    return row as T;
  }

  async all<T = unknown>() {
    await this.beforeStatement?.("all", this.sql);
    return {
      success: true,
      results: this.native.prepare(this.sql).all(...this.values) as T[],
    };
  }

  async run<T = unknown>() {
    await this.beforeStatement?.("run", this.sql);
    const result = this.native.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

class SqliteD1 implements D1DatabaseLike {
  failNextPurge = false;
  beforeStatement?: (
    operation: "first" | "all" | "run",
    sql: string,
  ) => Promise<void>;
  beforeBatch?: (statements: readonly D1BoundStatement[]) => Promise<void>;

  constructor(readonly native: DatabaseSync) {}

  prepare(sql: string): D1Statement {
    return {
      bind: (...values: unknown[]) => new SqliteBoundStatement(
        this.native,
        sql,
        (operation, statementSql) => this.beforeStatement?.(operation, statementSql) ??
          Promise.resolve(),
      ).bind(...values),
    };
  }

  async batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]> {
    await this.beforeBatch?.(statements);
    const bound = statements as SqliteBoundStatement[];
    this.native.exec("BEGIN IMMEDIATE");
    try {
      const results: D1RunResultLike[] = [];
      for (let index = 0; index < bound.length; index += 1) {
        results.push(await bound[index].run());
        if (
          this.failNextPurge &&
          bound.some((statement) => statement.sql.includes("account-deletion:purge:")) &&
          index === 2
        ) {
          this.failNextPurge = false;
          throw new Error("injected purge failure");
        }
      }
      this.native.exec("COMMIT");
      return results;
    } catch (error) {
      this.native.exec("ROLLBACK");
      throw error;
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeR2 implements AccountR2BucketLike {
  readonly objects = new Set<string>();
  readonly bodies = new Map<string, string>();
  readonly listedPrefixes: string[] = [];
  failLists = false;
  failHeads = false;
  failGets = false;
  failPuts = false;

  async head(key: string) {
    if (this.failHeads) throw new Error("R2 unavailable");
    return this.objects.has(key) ? { key } : null;
  }

  async get(key: string) {
    if (this.failGets) throw new Error("R2 unavailable");
    const value = this.bodies.get(key);
    if (value === undefined) return null;
    return {
      key,
      size: new TextEncoder().encode(value).byteLength,
      text: async () => value,
    };
  }

  async put(
    key: string,
    value: string,
    options?: { onlyIf?: Headers },
  ) {
    if (this.failPuts) throw new Error("R2 unavailable");
    if (
      options?.onlyIf instanceof Headers &&
      options.onlyIf.get("if-none-match") === "*" &&
      this.objects.has(key)
    ) return null;
    this.objects.add(key);
    this.bodies.set(key, value);
    return { key };
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    this.listedPrefixes.push(options.prefix);
    if (this.failLists) throw new Error("R2 unavailable");
    const limit = options.limit ?? 1_000;
    const matching = [...this.objects]
      .filter((key) => key.startsWith(options.prefix))
      .filter((key) => options.cursor === undefined || key > options.cursor)
      .sort();
    const page = matching.slice(0, limit);
    return {
      objects: page.map((key) => ({ key })),
      truncated: matching.length > page.length,
      cursor: matching.length > page.length ? page.at(-1) : undefined,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      this.bodies.delete(key);
    }
  }
}

class FakeKV implements AccountKVNamespaceLike {
  readonly values = new Map<string, string>();
  readonly deletedKeys: string[] = [];
  failDeletes = false;

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("KV unavailable");
    this.deletedKeys.push(key);
    this.values.delete(key);
  }
}

class FakeWorkOS {
  readonly calls: Array<{ url: string; authorization: string | null }> = [];
  readonly statuses: number[] = [];
  throwNext = false;

  constructor(...statuses: number[]) {
    this.statuses.push(...statuses);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("WorkOS unavailable");
    }
    const headers = new Headers(init?.headers);
    this.calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
    });
    const status = this.statuses.shift() ?? 204;
    return new Response(status === 204 ? null : "{}", { status });
  };
}

function migratedDatabase(): DatabaseSync {
  const native = new DatabaseSync(":memory:");
  native.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    native.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
  }
  return native;
}

async function seedAccount(
  native: DatabaseSync,
  input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    sessionToken: string;
    csrf: string;
    eventId: string;
    apiKeyId: string;
    apiHash: string;
    gatewayKeyId: string;
    gatewayHash: string;
    suffix: string;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  native.prepare(`
    INSERT INTO workspaces (id, workspace_id, name, status, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(input.workspaceId, input.workspaceId, `workspace ${input.suffix}`, now - 100);
  native.prepare(`
    INSERT INTO users
      (id, email, display_name, email_verified, status, personal_workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
  `).run(
    input.userId,
    `${input.suffix}@example.test`,
    `User ${input.suffix}`,
    input.workspaceId,
    now - 100,
    now - 100,
  );
  native.prepare(`
    INSERT INTO provider_identities
      (provider, provider_subject, user_id, email, created_at, updated_at)
    VALUES ('workos', ?, ?, ?, ?, ?)
  `).run(
    `workos-${input.suffix}`,
    input.userId,
    `${input.suffix}@example.test`,
    now - 100,
    now - 100,
  );
  native.prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
    VALUES (?, ?, 'owner', 'active', ?)
  `).run(input.workspaceId, input.userId, now - 100);
  native.prepare(`
    INSERT INTO workspace_entitlements
      (workspace_id, period_start, period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.workspaceId, now - 100, now + 30 * 86_400, now - 100, now - 100);
  native.prepare(`
    INSERT INTO account_sessions
      (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at,
       workos_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.userId,
    await sha256Hex(input.sessionToken),
    await sha256Hex(input.csrf),
    now - 100,
    now + 3_600,
    now - 10,
    `session_${input.suffix.repeat(16)}`,
  );
  native.prepare(`
    INSERT INTO devices
      (id, workspace_id, token_hash, label, capabilities, created_at)
    VALUES (?, ?, ?, 'test device', 'ingest,read', ?)
  `).run(
    `device-${input.suffix}`,
    input.workspaceId,
    await sha256Hex(`hfg_dev_${input.suffix.repeat(40)}`),
    now - 50,
  );
  native.prepare(`
    INSERT INTO api_keys
      (id, workspace_id, name, public_key, secret_hash, scopes, created_at)
    VALUES (?, ?, ?, ?, ?, '["read"]', ?)
  `).run(
    input.apiKeyId,
    input.workspaceId,
    `api ${input.suffix}`,
    `pk_${input.suffix.repeat(12)}`,
    input.apiHash,
    now - 45,
  );
  native.prepare(`
    INSERT INTO gateway_keys
      (id, workspace_id, name, token_hash, budget_spent, rate_limit_per_min,
       upstream_base_url, upstream_provider, fallbacks, capture_tier, disabled, created_at)
    VALUES (?, ?, ?, ?, '0', 60, 'https://provider.example', 'custom',
            '[]', 'metadata', 0, ?)
  `).run(
    input.gatewayKeyId,
    input.workspaceId,
    `gateway ${input.suffix}`,
    input.gatewayHash,
    now - 40,
  );
  const eventBody = JSON.stringify({
    schema_version: "hfg.event.v1",
    event_id: input.eventId,
    kind: "command.completed",
    occurred_at: "2026-08-30T00:00:00Z",
  });
  native.prepare(`
    INSERT INTO events
      (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json)
    VALUES (?, ?, '2026-08-30T00:00:00Z', 'command.completed', ?, ?)
  `).run(input.workspaceId, input.eventId, now - 25, eventBody);
  const seq = (native.prepare(`
    SELECT seq FROM events WHERE workspace_id = ? AND event_id = ?
  `).get(input.workspaceId, input.eventId) as { seq: number }).seq;
  native.prepare(`
    INSERT INTO artifact_file_list
      (workspace_id, object_key, event_count, byte_size, min_seq, max_seq,
       min_occurred_at, max_occurred_at, content_sha256, created_at)
    VALUES (?, ?, 1, 10, ?, ?, '2026-08-30T00:00:00Z',
            '2026-08-30T00:00:00Z', ?, ?)
  `).run(
    input.workspaceId,
    `artifacts/${input.workspaceId}/art_${input.suffix.repeat(32)}.jsonl`,
    seq,
    seq,
    input.suffix.repeat(64),
    now - 20,
  );
  native.prepare(`
    INSERT INTO attachments
      (workspace_id, content_sha256, byte_size, content_type, filename, created_at)
    VALUES (?, ?, 4, 'text/plain', 'note.txt', ?)
  `).run(input.workspaceId, input.suffix.repeat(64), now - 15);
}

function deletionRequest(workspaceId: string, sessionToken: string, csrf: string): Request {
  return new Request("https://api.handoffgraph.dev/v1/account", {
    method: "DELETE",
    headers: {
      cookie: `${SESSION_COOKIE}=${sessionToken}; ${CSRF_COOKIE}=${csrf}`,
      origin: "https://api.handoffgraph.dev",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: `DELETE ${workspaceId}` }),
  });
}

function eventBatchRequest(idempotencyKey: string, eventId: string): Request {
  return new Request("https://api.handoffgraph.dev/v1/event-batches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEVICE_TOKEN_ONE}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      schema_version: "hfg.event-batch.v1",
      workspace_id: WS_ONE,
      events: [{
        schema_version: "hfg.event.v1",
        event_id: eventId,
        kind: "command.completed",
        occurred_at: "2026-08-31T00:00:00Z",
        observed_at: "2026-08-31T00:00:01Z",
        provider: "codex",
        provenance: "OBSERVED",
        payload: { exit_code: 0 },
        redaction: { version: 1, status: "clean" },
      }],
    }),
  });
}

async function seededFixture() {
  const native = migratedDatabase();
  await seedAccount(native, {
    workspaceId: WS_ONE,
    userId: USER_ONE,
    sessionId: SESSION_ONE,
    sessionToken: SESSION_TOKEN_ONE,
    csrf: CSRF_ONE,
    eventId: EVENT_ONE,
    apiKeyId: API_KEY_ONE,
    apiHash: API_HASH_ONE,
    gatewayKeyId: GATEWAY_KEY_ONE,
    gatewayHash: GATEWAY_HASH_ONE,
    suffix: "a",
  });
  await seedAccount(native, {
    workspaceId: WS_TWO,
    userId: USER_TWO,
    sessionId: SESSION_TWO,
    sessionToken: SESSION_TOKEN_TWO,
    csrf: CSRF_TWO,
    eventId: EVENT_TWO,
    apiKeyId: API_KEY_TWO,
    apiHash: API_HASH_TWO,
    gatewayKeyId: GATEWAY_KEY_TWO,
    gatewayHash: GATEWAY_HASH_TWO,
    suffix: "b",
  });
  const db = new SqliteD1(native);
  const bucket = new FakeR2();
  const apiKeyKV = new FakeKV();
  const gatewayKV = new FakeKV();
  const workos = new FakeWorkOS();
  for (const prefix of ["artifacts", "exports", "attachments", "gwcache"]) {
    bucket.objects.add(`${prefix}/${WS_ONE}/one`);
    bucket.objects.add(`${prefix}/${WS_TWO}/two`);
  }
  apiKeyKV.values.set(`apikey-verdict:${API_HASH_ONE}`, JSON.stringify({
    v: "ok",
    workspace_id: WS_ONE,
    key_id: API_KEY_ONE,
    scopes: ["read"],
  }));
  apiKeyKV.values.set(`apikey-verdict:${API_HASH_TWO}`, JSON.stringify({
    v: "ok",
    workspace_id: WS_TWO,
    key_id: API_KEY_TWO,
    scopes: ["read"],
  }));
  gatewayKV.values.set(`vk:${GATEWAY_HASH_ONE}`, JSON.stringify({
    id: GATEWAY_KEY_ONE,
    workspace_id: WS_ONE,
  }));
  gatewayKV.values.set(`vk:${GATEWAY_HASH_TWO}`, JSON.stringify({
    id: GATEWAY_KEY_TWO,
    workspace_id: WS_TWO,
  }));
  const env: AccountDeletionEnv = {
    DB: db,
    BODIES: bucket,
    APIKEY_KV: apiKeyKV,
    GATEWAY_KV: gatewayKV,
    WORKOS_API_KEY: "sk_test_workos",
    APP_ORIGIN: "https://api.handoffgraph.dev",
  };
  return { native, db, bucket, apiKeyKV, gatewayKV, workos, env };
}

async function runNextDeletionPass(fixture: Awaited<ReturnType<typeof seededFixture>>): Promise<void> {
  const row = fixture.native.prepare(`
    SELECT next_attempt_at FROM workspace_deletions WHERE workspace_id = ?
  `).get(WS_ONE) as { next_attempt_at: number | null } | undefined;
  if (row?.next_attempt_at === null || row === undefined) {
    throw new Error("deletion job is not due");
  }
  await accountDeletionScheduled(fixture.env, row.next_attempt_at, fixture.workos.fetch);
}

async function runUntilDeletionStatus(
  fixture: Awaited<ReturnType<typeof seededFixture>>,
  expected: "pending" | "r2_grace" | "complete",
): Promise<void> {
  for (let pass = 0; pass < 12; pass += 1) {
    const row = fixture.native.prepare(`
      SELECT status FROM workspace_deletions WHERE workspace_id = ?
    `).get(WS_ONE) as { status: string } | undefined;
    if (row?.status === expected) return;
    await runNextDeletionPass(fixture);
  }
  throw new Error(`deletion did not reach ${expected}`);
}

describe("owner-confirmed hosted account deletion", () => {
  it("keeps permanent R2 control keys disjoint from every tenant purge prefix", () => {
    const controls = [deletionLedgerKey(WS_ONE), HOSTED_CAPACITY_KEY];
    for (const prefix of workspaceObjectPrefixes(WS_ONE)) {
      for (const control of controls) {
        expect(control.startsWith(prefix)).toBe(false);
        expect(prefix.startsWith(control)).toBe(false);
      }
    }
    expect(controls.every((key) => key.startsWith("_hfg/"))).toBe(true);
  });

  it("preserves APP_ORIGIN through the real account router", async () => {
    const fixture = await seededFixture();
    const response = await handleAccountRoute(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      fixture.env,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({ ok: true, status: "deleting" });
  });

  it("purges exactly one tenant, revokes credentials, and preserves the beta issuance ceiling", async () => {
    const fixture = await seededFixture();
    const { native, bucket, apiKeyKV, gatewayKV, workos, env } = fixture;
    for (let index = 0; index < 1_001; index += 1) {
      bucket.objects.add(`artifacts/${WS_ONE}/bulk-${index.toString().padStart(4, "0")}`);
    }
    const response = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, status: "deleting" });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "deleting" });
    expect(native.prepare("SELECT revoked_at FROM account_sessions WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ revoked_at: expect.any(Number) });
    expect(native.prepare("SELECT revoked_at FROM devices WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ revoked_at: expect.any(Number) });
    expect(native.prepare("SELECT revoked_at FROM api_keys WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ revoked_at: expect.any(Number) });
    expect(native.prepare("SELECT disabled FROM gateway_keys WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ disabled: 1 });
    expect(apiKeyKV.values.has(`apikey-verdict:${API_HASH_ONE}`)).toBe(false);
    expect(apiKeyKV.values.has(`apikey-verdict:${API_HASH_TWO}`)).toBe(true);
    expect(gatewayKV.values.has(`vk:${GATEWAY_HASH_ONE}`)).toBe(false);
    expect(gatewayKV.values.has(`vk:${GATEWAY_HASH_TWO}`)).toBe(true);
    expect(workos.calls).toEqual([]);

    await runUntilDeletionStatus(fixture, "r2_grace");
    for (const table of [
      "workspaces",
      "users",
      "provider_identities",
      "account_sessions",
      "devices",
      "events",
      "artifact_file_list",
      "attachments",
    ]) {
      const where = table === "users" || table === "provider_identities" || table === "account_sessions"
        ? "1 = 1"
        : "workspace_id = ?";
      const target = native.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
        .get(...(where === "1 = 1" ? [] : [WS_ONE])) as { count: number };
      if (where === "1 = 1") {
        expect(target.count, table).toBe(1);
      } else {
        expect(target.count, table).toBe(0);
      }
    }
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT active_accounts FROM hosted_beta_capacity WHERE id = 'global'").get())
      .toMatchObject({ active_accounts: 2 });
    expect(native.prepare("SELECT status, requested_by_user_id FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "r2_grace", requested_by_user_id: null });
    expect(workos.calls).toEqual([{
      url: "https://api.workos.com/user_management/users/workos-a",
      authorization: "Bearer sk_test_workos",
    }]);

    const ledgerKey = deletionLedgerKey(WS_ONE);
    expect(bucket.objects.has(ledgerKey)).toBe(true);
    expect([...bucket.objects].filter((key) =>
      ["artifacts", "exports", "attachments", "gwcache"]
        .some((prefix) => key.startsWith(`${prefix}/${WS_ONE}/`))))
      .toEqual([]);
    expect([...bucket.objects].filter((key) => key.includes(WS_TWO))).toHaveLength(4);
    expect(bucket.listedPrefixes.every((prefix) => prefix.includes(`${WS_ONE}/`))).toBe(true);

    await runUntilDeletionStatus(fixture, "complete");
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "complete" });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspace_deletion_kv_keys WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 0 });
    expect(bucket.objects.has(ledgerKey)).toBe(true);
    expect(() => native.prepare("DELETE FROM workspace_deletions WHERE workspace_id = ?").run(WS_ONE))
      .toThrow(/tombstones are permanent/);
    native.close();
  });

  it("keeps D1 tenant data locked and retryable when the first R2 sweep fails", async () => {
    const fixture = await seededFixture();
    const { native, bucket, env } = fixture;
    bucket.failLists = true;

    const response = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    );
    expect(response.status).toBe(202);
    await runNextDeletionPass(fixture); // WorkOS deletion.
    await runNextDeletionPass(fixture); // KV is clean; R2 fails.
    expect(native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "deleting" });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT revoked_at FROM account_sessions WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ revoked_at: expect.any(Number) });
    expect(native.prepare("SELECT revoked_at FROM devices WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ revoked_at: expect.any(Number) });
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "pending" });

    bucket.failLists = false;
    await runUntilDeletionStatus(fixture, "r2_grace");
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "r2_grace" });
    await runUntilDeletionStatus(fixture, "complete");
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "complete" });
    native.close();
  });

  it("blocks restored pre-deletion browser and device credentials from the R2 ledger", async () => {
    const accepted = await seededFixture();
    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      accepted.env,
    )).status).toBe(202);
    const key = deletionLedgerKey(WS_ONE);
    const ledgerBody = accepted.bucket.bodies.get(key);
    expect(ledgerBody).toBeDefined();

    // A fresh fixture with the same rows/tokens is the exact logical shape of
    // D1 restored to the pre-deletion bookmark. R2 is not rolled back.
    const restored = await seededFixture();
    restored.bucket.objects.add(key);
    restored.bucket.bodies.set(key, ledgerBody ?? "");

    const browser = await handleAccountRoute(new Request(
      "https://api.handoffgraph.dev/v1/me",
      { headers: { cookie: `${SESSION_COOKIE}=${SESSION_TOKEN_ONE}` } },
    ), restored.env);
    expect(browser?.status).toBe(401);
    expect(await browser?.json()).toEqual({ error: "unauthorized" });

    const device = await worker.fetch(new Request(
      "https://api.handoffgraph.dev/v1/workstreams",
      { headers: { authorization: `Bearer ${DEVICE_TOKEN_ONE}` } },
    ), restored.env as never, {} as never);
    expect(device.status).toBe(401);
    expect(await device.json()).toEqual({ error: "unauthorized" });
  });

  it("fails both Hosted Basic auth planes closed when the configured R2 read fails", async () => {
    const fixture = await seededFixture();
    fixture.bucket.failHeads = true;

    const browser = await handleAccountRoute(new Request(
      "https://api.handoffgraph.dev/v1/me",
      { headers: { cookie: `${SESSION_COOKIE}=${SESSION_TOKEN_ONE}` } },
    ), fixture.env);
    expect(browser?.status).toBe(401);

    const device = await worker.fetch(new Request(
      "https://api.handoffgraph.dev/v1/workstreams",
      { headers: { authorization: `Bearer ${DEVICE_TOKEN_ONE}` } },
    ), fixture.env as never, {} as never);
    expect(device.status).toBe(401);
  });

  it("does not run WorkOS or purge D1 when the required ledger is missing", async () => {
    const fixture = await seededFixture();
    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      fixture.env,
    )).status).toBe(202);
    const key = deletionLedgerKey(WS_ONE);
    fixture.bucket.objects.delete(key);
    fixture.bucket.bodies.delete(key);

    await runNextDeletionPass(fixture);
    expect(fixture.workos.calls).toEqual([]);
    expect(fixture.native.prepare(
      "SELECT status FROM workspace_deletions WHERE workspace_id = ?",
    ).get(WS_ONE)).toMatchObject({ status: "pending" });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?",
    ).get(WS_ONE)).toMatchObject({ count: 1 });
  });

  it("leaves only the fail-closed D1 prelock when the R2 ledger write fails", async () => {
    const fixture = await seededFixture();
    fixture.bucket.failPuts = true;
    const response = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      fixture.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "account_deletion_reconciliation_required",
    });
    expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM workspace_deletions").get())
      .toMatchObject({ count: 0 });
    expect(fixture.native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "deleting" });
    expect(fixture.bucket.objects.has(deletionLedgerKey(WS_ONE))).toBe(false);
    expect(fixture.native.prepare(
      "SELECT revoked_at FROM account_sessions WHERE user_id = ?",
    ).get(USER_ONE)).toMatchObject({ revoked_at: null });
    expect(fixture.native.prepare(
      "SELECT revoked_at FROM devices WHERE workspace_id = ?",
    ).get(WS_ONE)).toMatchObject({ revoked_at: null });

    const read = await worker.fetch(new Request(
      "https://api.handoffgraph.dev/v1/workstreams",
      { headers: { authorization: `Bearer ${DEVICE_TOKEN_ONE}` } },
    ), fixture.env as never, {} as never);
    const eventId = `evt_01J${"Z".repeat(23)}`;
    const ingest = await worker.fetch(
      eventBatchRequest("prelock-r2-failure", eventId),
      fixture.env as never,
      {} as never,
    );

    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "unauthorized" });
    expect(ingest.status).toBe(401);
    expect(await ingest.json()).toEqual({ error: "unauthorized" });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE workspace_id = ? AND event_id = ?",
    ).get(WS_ONE, eventId)).toMatchObject({ count: 0 });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ? AND key = ?",
    ).get(WS_ONE, "prelock-r2-failure")).toMatchObject({ count: 0 });
  });

  it("makes a winning prelock terminal for already-authenticated reads and writes", async () => {
    const fixture = await seededFixture();
    fixture.bucket.failPuts = true;
    const readReached = deferred();
    const releaseRead = deferred();
    const ingestBatchReached = deferred();
    const releaseIngestBatch = deferred();
    let pausedRead = false;
    let pausedIngest = false;
    fixture.db.beforeStatement = async (operation, sql) => {
      if (!pausedRead && operation === "all" && sql.includes("FROM workstreams")) {
        pausedRead = true;
        readReached.resolve();
        await releaseRead.promise;
      }
    };
    fixture.db.beforeBatch = async (statements) => {
      if (
        !pausedIngest &&
        statements.some((statement) =>
          (statement as SqliteBoundStatement).sql.includes("INSERT INTO idempotency_keys"))
      ) {
        pausedIngest = true;
        ingestBatchReached.resolve();
        await releaseIngestBatch.promise;
      }
    };

    const readPromise = worker.fetch(new Request(
      "https://api.handoffgraph.dev/v1/workstreams",
      { headers: { authorization: `Bearer ${DEVICE_TOKEN_ONE}` } },
    ), fixture.env as never, {} as never);
    const eventId = `evt_01J${"Y".repeat(23)}`;
    const ingestPromise = worker.fetch(
      eventBatchRequest("prelock-controlled-race", eventId),
      fixture.env as never,
      {} as never,
    );
    await Promise.all([readReached.promise, ingestBatchReached.promise]);

    const deletion = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      fixture.env,
    );
    expect(deletion.status).toBe(503);
    expect(fixture.native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "deleting" });

    releaseRead.resolve();
    releaseIngestBatch.resolve();
    const [read, ingest] = await Promise.all([readPromise, ingestPromise]);
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "unauthorized" });
    expect(ingest.status).toBe(401);
    expect(await ingest.json()).toEqual({ error: "unauthorized" });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE workspace_id = ? AND event_id = ?",
    ).get(WS_ONE, eventId)).toMatchObject({ count: 0 });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ? AND key = ?",
    ).get(WS_ONE, "prelock-controlled-race")).toMatchObject({ count: 0 });
    expect(fixture.native.prepare(
      "SELECT COUNT(*) AS count FROM quota_reservations WHERE workspace_id = ? AND idempotency_key = ?",
    ).get(WS_ONE, "prelock-controlled-race")).toMatchObject({ count: 0 });
  });

  it("rolls back every D1 delete when one purge statement fails", async () => {
    const fixture = await seededFixture();
    const { native, db, env } = fixture;
    db.failNextPurge = true;

    const response = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    );
    expect(response.status).toBe(202);
    await runNextDeletionPass(fixture); // WorkOS deletion.
    await runNextDeletionPass(fixture); // Injected D1 purge rollback.
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM attachments WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(USER_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "pending" });

    await runUntilDeletionStatus(fixture, "r2_grace");
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ count: 0 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    native.close();
  });

  it("keeps local identity and tenant data pending until WorkOS deletion succeeds", async () => {
    const fixture = await seededFixture();
    const { native, workos, env } = fixture;
    workos.statuses.push(503, 204);

    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    )).status).toBe(202);
    await runNextDeletionPass(fixture);

    expect(workos.calls).toHaveLength(1);
    expect(native.prepare("SELECT COUNT(*) AS count FROM provider_identities WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT workos_deleted_at, status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ workos_deleted_at: null, status: "pending" });

    await runNextDeletionPass(fixture);
    expect(workos.calls).toHaveLength(2);
    expect(native.prepare("SELECT workos_deleted_at FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ workos_deleted_at: expect.any(Number) });
    expect(native.prepare("SELECT COUNT(*) AS count FROM provider_identities WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ count: 1 });

    await runUntilDeletionStatus(fixture, "complete");
    expect(native.prepare("SELECT COUNT(*) AS count FROM provider_identities WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ count: 0 });
    native.close();
  });

  it("treats a WorkOS 404 as an idempotent completed external deletion", async () => {
    const fixture = await seededFixture();
    const { native, workos, env } = fixture;
    workos.statuses.push(404);

    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    )).status).toBe(202);
    await runNextDeletionPass(fixture);

    expect(workos.calls).toHaveLength(1);
    expect(native.prepare("SELECT workos_deleted_at, status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ workos_deleted_at: expect.any(Number), status: "pending" });
    await runUntilDeletionStatus(fixture, "complete");
    native.close();
  });

  it("retries exact KV invalidation without purging D1 or a foreign cache key", async () => {
    const fixture = await seededFixture();
    const { native, apiKeyKV, gatewayKV, env } = fixture;
    apiKeyKV.failDeletes = true;

    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    )).status).toBe(202);
    await runNextDeletionPass(fixture); // WorkOS succeeds.
    await runNextDeletionPass(fixture); // KV retry fails.

    expect(native.prepare("SELECT COUNT(*) AS count FROM provider_identities WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "pending" });
    expect(apiKeyKV.values.has(`apikey-verdict:${API_HASH_TWO}`)).toBe(true);
    expect(gatewayKV.values.has(`vk:${GATEWAY_HASH_TWO}`)).toBe(true);
    expect(apiKeyKV.deletedKeys).not.toContain(`apikey-verdict:${API_HASH_TWO}`);
    expect(gatewayKV.deletedKeys).not.toContain(`vk:${GATEWAY_HASH_TWO}`);

    apiKeyKV.failDeletes = false;
    await runUntilDeletionStatus(fixture, "complete");
    expect(apiKeyKV.values.has(`apikey-verdict:${API_HASH_ONE}`)).toBe(false);
    expect(gatewayKV.values.has(`vk:${GATEWAY_HASH_ONE}`)).toBe(false);
    native.close();
  });

  it("stays pending when a KV namespace needed by a captured key is unavailable", async () => {
    const fixture = await seededFixture();
    const { native, gatewayKV, env } = fixture;
    env.GATEWAY_KV = undefined;

    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    )).status).toBe(202);
    await runNextDeletionPass(fixture); // WorkOS succeeds.
    await runNextDeletionPass(fixture); // Captured gateway key needs its KV binding.

    expect(native.prepare("SELECT status FROM workspace_deletions WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ status: "pending" });
    expect(native.prepare("SELECT COUNT(*) AS count FROM provider_identities WHERE user_id = ?").get(USER_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });

    env.GATEWAY_KV = gatewayKV;
    await runUntilDeletionStatus(fixture, "complete");
    native.close();
  });

  it("allows the fenced Hosted Basic surface to delete when no advanced KV keys exist", async () => {
    const fixture = await seededFixture();
    const { native, env } = fixture;
    native.prepare("DELETE FROM api_keys WHERE workspace_id = ?").run(WS_ONE);
    native.prepare("DELETE FROM gateway_keys WHERE workspace_id = ?").run(WS_ONE);
    env.APIKEY_KV = undefined;
    env.GATEWAY_KV = undefined;

    expect((await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    )).status).toBe(202);
    await runUntilDeletionStatus(fixture, "complete");

    expect(native.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ count: 0 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    native.close();
  });

  it("requires exact confirmation and leaves storage untouched on a rejected request", async () => {
    const { native, env } = await seededFixture();
    const request = deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE);
    const response = await deleteAccount(new Request(request.url, {
      method: "DELETE",
      headers: request.headers,
      body: JSON.stringify({ confirmation: "DELETE the wrong workspace" }),
    }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "confirmation_required" });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspace_deletions").get())
      .toMatchObject({ count: 0 });
    expect(native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "active" });
    native.close();
  });

  it("rejects a cross-site request before creating a deletion job", async () => {
    const { native, env } = await seededFixture();
    const response = await deleteAccount(new Request(
      "https://api.handoffgraph.dev/v1/account",
      {
        method: "DELETE",
        headers: {
          cookie: `${SESSION_COOKIE}=${SESSION_TOKEN_ONE}; ${CSRF_COOKIE}=${CSRF_ONE}`,
          origin: "https://attacker.example",
          "x-csrf-token": CSRF_ONE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirmation: `DELETE ${WS_ONE}` }),
      },
    ), env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspace_deletions").get())
      .toMatchObject({ count: 0 });
    expect(native.prepare("SELECT status FROM workspaces WHERE id = ?").get(WS_ONE))
      .toMatchObject({ status: "active" });
    native.close();
  });

  it("refuses to follow the account through a membership in another tenant", async () => {
    const { native, env } = await seededFixture();
    native.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
      VALUES (?, ?, 'member', 'active', 1)
    `).run(WS_TWO, USER_ONE);

    const response = await deleteAccount(
      deletionRequest(WS_ONE, SESSION_TOKEN_ONE, CSRF_ONE),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "account_has_other_workspace_links",
    });
    expect(native.prepare("SELECT COUNT(*) AS count FROM workspace_deletions").get())
      .toMatchObject({ count: 0 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_ONE))
      .toMatchObject({ count: 1 });
    expect(native.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(WS_TWO))
      .toMatchObject({ count: 1 });
    native.close();
  });
});
