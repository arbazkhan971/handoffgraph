import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  authorizedUnsafeRequest,
  createDevice,
  deleteAccount,
  finishAuth,
  getMe,
  normalizedOrigin,
  randomSecret,
  readAccountJsonBody,
  revokeDevice,
  signOut,
  startAuth,
  type AccountEnv,
  type AccountDeletionEnv,
  type WorkOSAccessTokenVerifier,
} from "../src/account";
import { sha256Hex } from "../src/auth";
import { deletionLedgerKey } from "../src/deletion_ledger";
import {
  HOSTED_CAPACITY_KEY,
  reserveHostedBetaIssuance,
} from "../src/hosted_capacity_ledger";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1RunResultLike,
  D1Statement,
} from "../src/db";

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

class FakeControlR2 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  puts = 0;
  private version = 0;

  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    return {
      key,
      etag: object.etag,
      size: new TextEncoder().encode(object.body).byteLength,
      text: async () => object.body,
    };
  }

  async put(
    key: string,
    body: string,
    options?: { onlyIf?: Headers | { etagMatches?: string } },
  ) {
    const current = this.objects.get(key);
    if (options?.onlyIf instanceof Headers) {
      if (options.onlyIf.get("if-none-match") === "*" && current !== undefined) return null;
    } else if (
      options?.onlyIf?.etagMatches !== undefined &&
      current?.etag !== options.onlyIf.etagMatches
    ) return null;
    this.version += 1;
    this.puts += 1;
    const etag = `etag-${this.version}`;
    this.objects.set(key, { body, etag });
    return { key, etag };
  }

  async list(_options: { prefix: string; cursor?: string; limit?: number }) {
    return { objects: [], truncated: false };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
  batch?: (
    statements: RecordedStatement[],
  ) => D1RunResultLike[] | void | Promise<D1RunResultLike[] | void>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
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
          return { success: true, meta: { changes: 1 } };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded);
      const handled = await handlers.batch?.(recorded);
      return handled ?? recorded.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db, statements, batches };
}

function configuredEnv(
  db: D1DatabaseLike,
  options: { deletionLedger?: "available" | "missing" } = {},
): AccountEnv {
  const env = {
    DB: db,
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test_secret",
    WORKOS_REDIRECT_URI: "https://api.handoffgraph.dev/v1/auth/callback",
    APP_ORIGIN: "https://api.handoffgraph.dev",
    LANDING_ORIGIN: "https://handoffgraph.dev",
    HOSTED_SIGNUP_ENABLED: "true",
  };
  if (options.deletionLedger === "missing") return env;
  return {
    ...env,
    BODIES: {
      async head() { return null; },
    },
  } as AccountEnv;
}

const TEST_WORKOS_SID = "session_01HQSXZGF8FHF7A9ZZFCW4387R";
const TEST_ACCOUNT_WORKSPACE_ID = `wsp_01J${"R".repeat(23)}`;

const acceptWorkOSAccessToken: WorkOSAccessTokenVerifier = async (_token, binding) => ({
  sessionId: TEST_WORKOS_SID,
  subject: binding.userId,
  clientId: binding.clientId,
  expiresAt: (binding.now ?? 0) + 300,
});

function splitSetCookies(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function authCookieHeader(start: Response): string {
  const values = splitSetCookies(start);
  const state = /__Host-hfg_auth_state=([^;,]+)/.exec(values)?.[1];
  const verifier = /__Host-hfg_pkce=([^;,]+)/.exec(values)?.[1];
  const returnTo = /__Host-hfg_return=([^;,]+)/.exec(values)?.[1];
  const intent = /__Host-hfg_intent=([^;,]+)/.exec(values)?.[1];
  if (!state || !verifier || !returnTo || !intent) throw new Error("missing auth cookies");
  return [
    `__Host-hfg_auth_state=${state}`,
    `__Host-hfg_pkce=${verifier}`,
    `__Host-hfg_return=${returnTo}`,
    `__Host-hfg_intent=${intent}`,
  ].join("; ");
}

function sessionRow(csrfHash: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: "acs_01K4ACCOUNTSESSION00000000Z",
    user_id: "usr_01K4USER0000000000000000Z",
    token_hash: "f".repeat(64),
    workos_session_id: TEST_WORKOS_SID,
    workos_provider_subject: "user_workos_immutable_123",
    csrf_hash: csrfHash,
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    avatar_url: null,
    workspace_id: TEST_ACCOUNT_WORKSPACE_ID,
    workspace_name: "Ada's workspace",
    role: "owner",
    plan_id: "basic",
    plan_status: "active",
    max_devices: 2,
    active_devices: 0,
    max_device_issuances: 10,
    used_device_issuances: 0,
    max_monthly_events: 5_000,
    used_monthly_events: 10,
    max_monthly_bytes: 10_485_760,
    used_monthly_bytes: 1_024,
    max_lifetime_events: 25_000,
    used_lifetime_events: 100,
    max_lifetime_bytes: 67_108_864,
    used_lifetime_bytes: 4_096,
    period_start: 1_700_000_000,
    period_end: 1_800_000_000,
    ...overrides,
  };
}

describe("hosted auth start", () => {
  it("fails closed before redirecting when WorkOS is not configured", async () => {
    const { db } = mockDb();
    const response = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signup"),
      { DB: db },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "hosted_auth_unavailable",
      message: "Hosted account sign-in is not configured yet.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the WorkOS callback to be the exact app-origin route", async () => {
    const { db } = mockDb();
    for (const redirect of [
      "https://attacker.example/v1/auth/callback",
      "https://api.handoffgraph.dev/not-the-callback",
      "https://api.handoffgraph.dev/v1/auth/callback?next=evil",
      "https://api.handoffgraph.dev/v1/auth/callback#fragment",
    ]) {
      const response = await startAuth(
        new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signup"),
        { ...configuredEnv(db), WORKOS_REDIRECT_URI: redirect },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "hosted_auth_unavailable" });
    }
  });

  it("keeps new signup closed until the operator explicitly enables it", async () => {
    const { db } = mockDb();
    const response = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signup"),
      { ...configuredEnv(db), HOSTED_SIGNUP_ENABLED: "false" },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_signup_unavailable" });
    expect(response.headers.get("location")).toBeNull();
  });

  it("uses AuthKit signup, PKCE S256, random state, and hardened host cookies", async () => {
    const { db } = mockDb();
    const response = await startAuth(
      new Request(
        "https://api.handoffgraph.dev/v1/auth/start?intent=signup&return_to=" +
          encodeURIComponent("https://handoffgraph.dev/?welcome=1"),
      ),
      configuredEnv(db),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://api.workos.com/user_management/authorize",
    );
    expect(location.searchParams.get("provider")).toBe("authkit");
    expect(location.searchParams.get("screen_hint")).toBe("sign-up");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    const cookies = splitSetCookies(response);
    expect(cookies).toContain("__Host-hfg_auth_state=");
    expect(cookies).toContain("__Host-hfg_pkce=");
    expect(cookies).toContain("Max-Age=600");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).not.toContain("Domain=");
  });

  it("does not permit an arbitrary return origin", async () => {
    const { db } = mockDb();
    const response = await startAuth(
      new Request(
        "https://api.handoffgraph.dev/v1/auth/start?return_to=" +
          encodeURIComponent("https://attacker.example/steal"),
      ),
      configuredEnv(db),
    );
    expect(decodeURIComponent(splitSetCookies(response))).toContain(
      "__Host-hfg_return=https://api.handoffgraph.dev/account",
    );
  });
});

describe("hosted auth callback", () => {
  it("rejects a state mismatch before calling the provider", async () => {
    const { db } = mockDb();
    const fetcher = vi.fn();
    const response = await finishAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/callback?code=x&state=wrong", {
        headers: {
          cookie: "__Host-hfg_auth_state=expected; __Host-hfg_pkce=verifier",
        },
      }),
      configuredEnv(db),
      fetcher,
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(splitSetCookies(response)).toContain("Max-Age=0");
  });

  it("provisions one Basic account and stores only hashed HandoffGraph secrets", async () => {
    let identityUserId = "";
    let workspaceId = "";
    const recorded: RecordedStatement[] = [];
    const { db, batches } = mockDb({
      batch(statements) {
        recorded.push(...statements);
        for (const statement of statements) {
          if (statement.sql.includes("INSERT INTO users")) {
            identityUserId = String(statement.binds[0]);
            workspaceId = String(statement.binds[4]);
          }
        }
      },
      first(statement) {
        if (statement.sql.includes("SELECT user_id FROM provider_identities")) {
          return identityUserId === "" ? null : { user_id: identityUserId };
        }
        if (statement.sql.includes("FROM hosted_beta_capacity")) {
          return { active_accounts: 0 };
        }
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceId };
        }
        return null;
      },
      run(statement) {
        recorded.push(statement);
      },
    });
    const capacity = new FakeControlR2();
    const env = { ...configuredEnv(db), BODIES: capacity };
    const start = await startAuth(
      new Request(
        "https://api.handoffgraph.dev/v1/auth/start?intent=signup&return_to=" +
          encodeURIComponent("https://api.handoffgraph.dev/account"),
      ),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.client_secret).toBe("sk_test_secret");
      expect(body.code_verifier).toEqual(expect.any(String));
      return new Response(JSON.stringify({
        user: {
          id: "user_workos_immutable_123",
          email: "ada@example.com",
          email_verified: true,
          first_name: "Ada",
          last_name: "Lovelace",
        },
        access_token: "provider-access-must-not-persist",
        refresh_token: "provider-refresh-must-not-persist",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const response = await finishAuth(
      new Request(
        `https://api.handoffgraph.dev/v1/auth/callback?code=one-time&state=${state}`,
        { headers: { cookie: authCookieHeader(start) } },
      ),
      env,
      fetcher,
      acceptWorkOSAccessToken,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://api.handoffgraph.dev/account");
    const cookies = splitSetCookies(response);
    expect(cookies).toContain(`${SESSION_COOKIE}=hfg_session_`);
    expect(cookies).toContain(`${CSRF_COOKIE}=`);
    expect(cookies).toContain("HttpOnly");
    const persisted = JSON.stringify(recorded);
    expect(persisted).toContain("'basic'");
    expect(persisted).not.toContain("provider-access-must-not-persist");
    expect(persisted).not.toContain("provider-refresh-must-not-persist");
    expect(persisted).not.toContain("hfg_session_");
    const provisioning = batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT INTO provider_identities")),
    );
    expect(provisioning).toHaveLength(5);
    expect(provisioning?.map((statement) => statement.sql).join("\n")).toContain(
      "INSERT INTO workspace_entitlements",
    );
    const sessionRotation = batches.find((batch) =>
      batch.some((statement) => statement.sql.includes("DELETE FROM account_sessions")),
    );
    expect(sessionRotation).toHaveLength(2);
    expect(sessionRotation?.[1]?.binds.at(-1)).toBe(TEST_WORKOS_SID);
    const capacityObject = capacity.objects.get(HOSTED_CAPACITY_KEY);
    expect(capacityObject).toBeDefined();
    expect(capacityObject?.body).not.toContain("user_workos_immutable_123");
    expect(JSON.parse(capacityObject?.body ?? "{}")).toMatchObject({
      schema_version: "hfg.hosted-beta-capacity.v1",
      max_accounts: 50,
      subject_hashes: [expect.stringMatching(/^[0-9a-f]{64}$/)],
    });
  });

  it("rejects an unverified provider identity", async () => {
    const { db, statements } = mockDb();
    const env = configuredEnv(db);
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "user_1", email: "a@example.com", email_verified: false },
      }), { status: 200 }),
    );
    expect(response.status).toBe(502);
    expect(statements).toHaveLength(0);
  });

  it("does not let the sign-in route create a new account while signup is closed", async () => {
    const { db, batches } = mockDb();
    const env = { ...configuredEnv(db), HOSTED_SIGNUP_ENABLED: "false" };
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signin"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "new-provider-user", email: "new@example.com", email_verified: true },
        access_token: "verified-access-token",
      }), { status: 200 }),
      acceptWorkOSAccessToken,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_beta_unavailable" });
    expect(batches).toHaveLength(0);
  });

  it("fails a new signup closed before D1 when the R2 capacity ledger is unavailable", async () => {
    const { db, batches } = mockDb();
    const env = configuredEnv(db);
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signup"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "new-provider-user", email: "new@example.com", email_verified: true },
        access_token: "verified-access-token",
      }), { status: 200 }),
      acceptWorkOSAccessToken,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_beta_unavailable" });
    expect(batches).toHaveLength(0);
  });

  it("keeps the external lifetime issuance burned when D1 account creation fails", async () => {
    const { db, batches } = mockDb({
      first(statement) {
        return statement.sql.includes("FROM hosted_beta_capacity")
          ? { active_accounts: 0 }
          : null;
      },
      batch() {
        throw new Error("D1 unavailable");
      },
    });
    const capacity = new FakeControlR2();
    const env = { ...configuredEnv(db), BODIES: capacity };
    const attempt = async (): Promise<Response> => {
      const start = await startAuth(
        new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signup"),
        env,
      );
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
      return finishAuth(
        new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
          headers: { cookie: authCookieHeader(start) },
        }),
        env,
        async () => new Response(JSON.stringify({
          user: {
            id: "workos-permanently-burned",
            email: "burned@example.com",
            email_verified: true,
          },
          access_token: "verified-access-token",
        }), { status: 200 }),
        acceptWorkOSAccessToken,
      );
    };

    expect((await attempt()).status).toBe(503);
    expect(capacity.puts).toBe(1);
    expect((await attempt()).status).toBe(503);
    expect(capacity.puts).toBe(1);
    expect(batches).toHaveLength(2);
  });

  it("allows an existing account to sign in while new signup is closed", async () => {
    const userID = `usr_01J${"Q".repeat(23)}`;
    const workspaceID = `wsp_01J${"R".repeat(23)}`;
    const { db, batches } = mockDb({
      first(statement) {
        if (statement.sql.includes("SELECT user_id FROM provider_identities")) {
          return { user_id: userID };
        }
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceID };
        }
        return null;
      },
    });
    const capacity = new FakeControlR2();
    await reserveHostedBetaIssuance(capacity, "existing-provider-user");
    const capacityBefore = capacity.objects.get(HOSTED_CAPACITY_KEY)?.body;
    capacity.puts = 0;
    const env = {
      ...configuredEnv(db),
      HOSTED_SIGNUP_ENABLED: "false",
      BODIES: capacity,
    };
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signin"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "existing-provider-user", email: "existing@example.com", email_verified: true },
        access_token: "verified-access-token",
      }), { status: 200 }),
      acceptWorkOSAccessToken,
    );
    expect(response.status).toBe(303);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT INTO provider_identities")),
    )).toBe(false);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("DELETE FROM account_sessions")),
    )).toBe(true);
    expect(capacity.puts).toBe(0);
    expect(capacity.objects.get(HOSTED_CAPACITY_KEY)?.body).toBe(capacityBefore);
  });

  it("fails a duplicate provider SID closed without exposing a D1 constraint error", async () => {
    const userID = `usr_01J${"Q".repeat(23)}`;
    const workspaceID = `wsp_01J${"R".repeat(23)}`;
    const { db, batches } = mockDb({
      first(statement) {
        if (statement.sql.includes("SELECT user_id FROM provider_identities")) {
          return { user_id: userID };
        }
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceID };
        }
        return null;
      },
      batch(statements) {
        if (statements.some((statement) =>
          statement.sql.includes("INSERT INTO account_sessions")
        )) {
          throw new Error("UNIQUE constraint failed: account_sessions.workos_session_id");
        }
      },
    });
    const capacity = new FakeControlR2();
    await reserveHostedBetaIssuance(capacity, "existing-provider-user");
    capacity.puts = 0;
    const env = { ...configuredEnv(db), BODIES: capacity };
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signin"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "existing-provider-user", email: "existing@example.com", email_verified: true },
        access_token: "verified-access-token",
      }), { status: 200 }),
      acceptWorkOSAccessToken,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hosted_beta_unavailable" });
    expect(splitSetCookies(response)).not.toContain(`${SESSION_COOKIE}=hfg_session_`);
    expect(capacity.puts).toBe(0);
    expect(batches.some((batch) => batch.some((statement) =>
      statement.sql.includes("INSERT INTO account_sessions"),
    ))).toBe(true);
  });

  it("does not mint an existing-account session when Hosted Basic is missing BODIES", async () => {
    const userID = `usr_01J${"Q".repeat(23)}`;
    const workspaceID = `wsp_01J${"R".repeat(23)}`;
    const { db, batches } = mockDb({
      first(statement) {
        if (statement.sql.includes("SELECT user_id FROM provider_identities")) {
          return { user_id: userID };
        }
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceID };
        }
        return null;
      },
    });
    const env = {
      ...configuredEnv(db),
      HOSTED_SURFACE: "basic",
      HOSTED_SIGNUP_ENABLED: "false",
    };
    const start = await startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signin"),
      env,
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const response = await finishAuth(
      new Request(`https://api.handoffgraph.dev/v1/auth/callback?code=x&state=${state}`, {
        headers: { cookie: authCookieHeader(start) },
      }),
      env,
      async () => new Response(JSON.stringify({
        user: { id: "existing-provider-user", email: "existing@example.com", email_verified: true },
        access_token: "verified-access-token",
      }), { status: 200 }),
      acceptWorkOSAccessToken,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_beta_unavailable" });
    expect(batches.some((batch) => batch.some((statement) =>
      statement.sql.includes("INSERT INTO account_sessions"),
    ))).toBe(false);
  });
});

describe("WorkOS callback and logout commit barriers", () => {
  const userId = `usr_01J${"Q".repeat(23)}`;
  const workspaceId = `wsp_01J${"R".repeat(23)}`;
  const sessionId = `acs_01J${"S".repeat(23)}`;
  const providerSubject = "user_workos_owner";
  const oldSessionToken = `hfg_session_${"o".repeat(40)}`;
  const oldCsrf = "old-csrf-token-with-at-least-thirty-two-bytes";
  const oldWorkOSSID = "session_01HQSXZGF8FHF7A9ZZFCW4387R";

  interface ReauthState {
    active: boolean;
    workspaceActive: boolean;
    tokenHash: string;
    csrfHash: string;
    workosSessionId: string;
    providerSubject: string;
    rotations: number;
    profileWrites: number;
    providerWrites: number;
    deviceWrites: number;
    deviceRevocations: number;
    deletionPrelocks: number;
    deletionJobs: number;
  }

  async function reauthWorld(options: {
    rotationReached?: ReturnType<typeof deferred>;
    releaseRotation?: ReturnType<typeof deferred>;
    signoutReached?: ReturnType<typeof deferred>;
    releaseSignout?: ReturnType<typeof deferred>;
    mutationReached?: ReturnType<typeof deferred>;
    releaseMutation?: ReturnType<typeof deferred>;
    quotaOnDeviceCreate?: boolean;
    sessionRecheckReached?: ReturnType<typeof deferred>;
    releaseSessionRecheck?: ReturnType<typeof deferred>;
  } = {}) {
    const state: ReauthState = {
      active: true,
      workspaceActive: true,
      tokenHash: await sha256Hex(oldSessionToken),
      csrfHash: await sha256Hex(oldCsrf),
      workosSessionId: oldWorkOSSID,
      providerSubject,
      rotations: 0,
      profileWrites: 0,
      providerWrites: 0,
      deviceWrites: 0,
      deviceRevocations: 0,
      deletionPrelocks: 0,
      deletionJobs: 0,
    };
    const capacity = new FakeControlR2();
    await reserveHostedBetaIssuance(capacity, providerSubject);
    capacity.puts = 0;
    let sessionLookups = 0;
    const { db, batches, statements } = mockDb({
      async first(statement) {
        if (statement.sql.includes("FROM account_sessions AS s")) {
          sessionLookups += 1;
          if (sessionLookups === 2 && options.sessionRecheckReached !== undefined) {
            options.sessionRecheckReached.resolve();
            if (options.releaseSessionRecheck !== undefined) {
              await options.releaseSessionRecheck.promise;
            }
          }
          if (
            !state.active ||
            !state.workspaceActive ||
            statement.binds[0] !== state.tokenHash
          ) return null;
          return sessionRow(state.csrfHash, {
            session_id: sessionId,
            user_id: userId,
            token_hash: state.tokenHash,
            workos_session_id: state.workosSessionId,
            workos_provider_subject: state.providerSubject,
            workspace_id: workspaceId,
          });
        }
        if (
          statement.sql.includes("account-device:create") ||
          statement.sql.includes("account-device:revoke") ||
          statement.sql.includes("account-deletion:prelock-workspace")
        ) {
          options.mutationReached?.resolve();
          if (options.releaseMutation !== undefined) {
            await options.releaseMutation.promise;
          }
          const isCreate = statement.sql.includes("account-device:create");
          const isRevoke = statement.sql.includes("account-device:revoke");
          if (isCreate && options.quotaOnDeviceCreate === true) {
            throw new Error("device quota exceeded");
          }
          const tokenHash = isCreate
            ? statement.binds[7]
            : isRevoke
            ? statement.binds[5]
            : statement.binds[3];
          const guardMatches =
            state.active &&
            state.workspaceActive &&
            tokenHash === state.tokenHash;
          if (!guardMatches) return null;
          if (isCreate) {
            state.deviceWrites += 1;
            return { id: String(statement.binds[0]) };
          }
          if (isRevoke) {
            state.deviceRevocations += 1;
            return { id: String(statement.binds[0]) };
          }
          state.workspaceActive = false;
          state.deletionPrelocks += 1;
          return { id: workspaceId };
        }
        if (statement.sql.includes("account-deletion:foreign-workspace-links")) {
          return { blocked: 0 };
        }
        if (statement.sql.includes("account-deletion:job")) return null;
        return null;
      },
      async all(statement) {
        if (!statement.sql.includes("account-signout:revoke-user")) return [];
        options.signoutReached?.resolve();
        if (options.releaseSignout !== undefined) {
          await options.releaseSignout.promise;
        }
        if (!state.active || !state.workspaceActive) return [];
        state.active = false;
        return [{ id: sessionId, workos_session_id: state.workosSessionId }];
      },
      async batch(statements) {
        const rotation = statements[0];
        if (!rotation?.sql.includes("account-reauth:rotate")) {
          if (rotation?.sql.includes("account-deletion:create-job")) {
            state.deletionJobs += 1;
          }
          return undefined;
        }
        options.rotationReached?.resolve();
        if (options.releaseRotation !== undefined) {
          await options.releaseRotation.promise;
        }
        const guardMatches =
          state.active &&
          state.workspaceActive &&
          rotation.binds[0] === sessionId &&
          rotation.binds[1] === userId &&
          rotation.binds[2] === state.tokenHash &&
          rotation.binds[8] === state.providerSubject &&
          rotation.binds[9] === workspaceId;
        if (!guardMatches) {
          return statements.map(() => ({ success: true, meta: { changes: 0 } }));
        }
        state.tokenHash = String(rotation.binds[3]);
        state.csrfHash = String(rotation.binds[4]);
        state.workosSessionId = String(rotation.binds[7]);
        state.rotations += 1;
        state.profileWrites += 1;
        state.providerWrites += 1;
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    });
    return {
      state,
      db,
      batches,
      statements,
      capacity,
      env: { ...configuredEnv(db), BODIES: capacity },
    };
  }

  async function reauthStart(env: AccountEnv): Promise<Response> {
    return startAuth(
      new Request("https://api.handoffgraph.dev/v1/auth/start?intent=signin"),
      env,
    );
  }

  function reauthRequest(start: Response, code: string): Request {
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    return new Request(
      `https://api.handoffgraph.dev/v1/auth/callback?code=${code}&state=${state}`,
      {
        headers: {
          cookie: `${authCookieHeader(start)}; ${SESSION_COOKIE}=${oldSessionToken}`,
        },
      },
    );
  }

  function signoutRequest(): Request {
    return new Request("https://api.handoffgraph.dev/v1/auth/signout", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${oldSessionToken}`,
        origin: "https://api.handoffgraph.dev",
        "x-csrf-token": oldCsrf,
      },
    });
  }

  function unsafeOldCredentialRequest(
    path: string,
    method: "POST" | "DELETE",
    body?: string,
  ): Request {
    return new Request(`https://api.handoffgraph.dev${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${oldSessionToken}`,
        origin: "https://api.handoffgraph.dev",
        "x-csrf-token": oldCsrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body }),
    });
  }

  async function commitCallbackRotation(world: Awaited<ReturnType<typeof reauthWorld>>) {
    const start = await reauthStart(world.env);
    const response = await finishAuth(
      reauthRequest(start, "unsafe-race"),
      world.env,
      async () => workosResponse(),
      verifierFor("session_unsafe_race_rotated"),
    );
    expect(response.status).toBe(303);
  }

  function workosResponse(
    subject = providerSubject,
    accessToken = "verified-access-token",
  ): Response {
    return new Response(JSON.stringify({
      user: {
        id: subject,
        email: "owner@example.test",
        email_verified: true,
        first_name: "Verified",
        last_name: "Owner",
      },
      access_token: accessToken,
      refresh_token: "refresh-token-must-be-discarded",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  function verifierFor(sessionID: string): WorkOSAccessTokenVerifier {
    return async (_token, binding) => ({
      sessionId: sessionID,
      subject: binding.userId,
      clientId: binding.clientId,
      expiresAt: (binding.now ?? 0) + 300,
    });
  }

  it("requires a verified access token before any D1 or R2 mutation", async () => {
    const { db, statements, batches } = mockDb();
    const env = configuredEnv(db);
    const start = await reauthStart(env);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const verifier = vi.fn<WorkOSAccessTokenVerifier>();
    const response = await finishAuth(
      new Request(
        `https://api.handoffgraph.dev/v1/auth/callback?code=missing-token&state=${state}`,
        { headers: { cookie: authCookieHeader(start) } },
      ),
      env,
      async () => new Response(JSON.stringify({
        user: { id: providerSubject, email: "owner@example.test", email_verified: true },
        refresh_token: "must-not-be-reflected",
      }), { status: 200 }),
      verifier,
    );

    expect(response.status).toBe(502);
    expect(verifier).not.toHaveBeenCalled();
    expect(statements).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(await response.text()).not.toContain("must-not-be-reflected");
  });

  it("does not downgrade a stale predecessor cookie to anonymous provisioning", async () => {
    const world = await reauthWorld();
    world.state.active = false;
    const start = await reauthStart(world.env);
    const fetcher = vi.fn();
    const response = await finishAuth(
      reauthRequest(start, "stale"),
      world.env,
      fetcher,
      verifierFor("session_stale_callback"),
    );

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(world.batches).toHaveLength(0);
    const cookies = splitSetCookies(response);
    expect(cookies).toContain(`${SESSION_COOKIE}=`);
    expect(cookies).toContain("Max-Age=0");
  });

  it("rejects a different verified WorkOS subject with zero writes", async () => {
    const world = await reauthWorld();
    const start = await reauthStart(world.env);
    const response = await finishAuth(
      reauthRequest(start, "mismatch"),
      world.env,
      async () => workosResponse("user_workos_attacker"),
      verifierFor("session_provider_mismatch"),
    );

    expect(response.status).toBe(503);
    expect(world.batches).toHaveLength(0);
    expect(world.state.rotations).toBe(0);
    expect(world.state.profileWrites).toBe(0);
    expect(world.state.providerWrites).toBe(0);
  });

  it("fails predecessor reauthentication when its R2 issuance membership is missing", async () => {
    const world = await reauthWorld();
    world.capacity.objects.clear();
    const start = await reauthStart(world.env);
    const response = await finishAuth(
      reauthRequest(start, "missing-membership"),
      world.env,
      async () => workosResponse(),
      verifierFor("session_missing_membership"),
    );

    expect(response.status).toBe(503);
    expect(world.batches).toHaveLength(0);
    expect(world.state.rotations).toBe(0);
    expect(world.state.profileWrites).toBe(0);
    expect(world.state.providerWrites).toBe(0);
    expect(world.capacity.puts).toBe(0);
  });

  it("allows exactly one of two callbacks holding the same predecessor", async () => {
    const world = await reauthWorld();
    const firstStart = await reauthStart(world.env);
    const secondStart = await reauthStart(world.env);
    let exchanges = 0;
    const releaseExchange = deferred();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { code: string };
      exchanges += 1;
      if (exchanges === 2) releaseExchange.resolve();
      await releaseExchange.promise;
      return workosResponse(providerSubject, `verified-${body.code}`);
    };
    const verifier: WorkOSAccessTokenVerifier = async (token, binding) => ({
      sessionId: token.endsWith("first")
        ? "session_concurrent_first"
        : "session_concurrent_second",
      subject: binding.userId,
      clientId: binding.clientId,
      expiresAt: (binding.now ?? 0) + 300,
    });

    const [first, second] = await Promise.all([
      finishAuth(reauthRequest(firstStart, "first"), world.env, fetcher, verifier),
      finishAuth(reauthRequest(secondStart, "second"), world.env, fetcher, verifier),
    ]);
    expect([first.status, second.status].sort()).toEqual([303, 503]);
    expect(world.state.rotations).toBe(1);
    expect(world.state.profileWrites).toBe(1);
    expect(world.state.providerWrites).toBe(1);
    expect(world.batches.filter((batch) =>
      batch[0]?.sql.includes("account-reauth:rotate"),
    )).toHaveLength(2);
    const winner = first.status === 303 ? first : second;
    const loser = first.status === 503 ? first : second;
    expect(splitSetCookies(winner)).toContain(`${SESSION_COOKIE}=hfg_session_`);
    expect(splitSetCookies(loser)).not.toContain(`${SESSION_COOKIE}=hfg_session_`);
  });

  it("blocks a paused device insert after callback credential rotation", async () => {
    const mutationReached = deferred();
    const releaseMutation = deferred();
    const world = await reauthWorld({ mutationReached, releaseMutation });
    const creation = createDevice(
      unsafeOldCredentialRequest(
        "/v1/devices",
        "POST",
        JSON.stringify({ label: "stale callback race" }),
      ),
      world.env,
    );
    await mutationReached.promise;

    await commitCallbackRotation(world);
    releaseMutation.resolve();
    const response = await creation;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(world.state.deviceWrites).toBe(0);
    expect(world.state.rotations).toBe(1);
  });

  it("returns unauthorized when callback rotation wins the quota-error recheck", async () => {
    const sessionRecheckReached = deferred();
    const releaseSessionRecheck = deferred();
    const world = await reauthWorld({
      quotaOnDeviceCreate: true,
      sessionRecheckReached,
      releaseSessionRecheck,
    });
    const creation = createDevice(
      unsafeOldCredentialRequest(
        "/v1/devices",
        "POST",
        JSON.stringify({ label: "quota callback race" }),
      ),
      world.env,
    );
    await sessionRecheckReached.promise;

    await commitCallbackRotation(world);
    releaseSessionRecheck.resolve();
    const response = await creation;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(world.state.deviceWrites).toBe(0);
    expect(world.state.rotations).toBe(1);
  });

  it("blocks a paused device revocation after callback credential rotation", async () => {
    const mutationReached = deferred();
    const releaseMutation = deferred();
    const world = await reauthWorld({ mutationReached, releaseMutation });
    const revocation = revokeDevice(
      unsafeOldCredentialRequest(
        `/v1/devices/dev_${"A".repeat(26)}/revoke`,
        "POST",
      ),
      world.env,
      `dev_${"A".repeat(26)}`,
    );
    await mutationReached.promise;

    await commitCallbackRotation(world);
    releaseMutation.resolve();
    const response = await revocation;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(world.state.deviceRevocations).toBe(0);
    expect(world.state.rotations).toBe(1);
  });

  it("blocks a paused deletion prelock after callback credential rotation", async () => {
    const mutationReached = deferred();
    const releaseMutation = deferred();
    const world = await reauthWorld({ mutationReached, releaseMutation });
    const deletion = deleteAccount(
      unsafeOldCredentialRequest(
        "/v1/account",
        "DELETE",
        JSON.stringify({ confirmation: `DELETE ${workspaceId}` }),
      ),
      world.env,
    );
    await mutationReached.promise;

    await commitCallbackRotation(world);
    releaseMutation.resolve();
    const response = await deletion;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(world.state.deletionPrelocks).toBe(0);
    expect(world.state.deletionJobs).toBe(0);
    expect(world.capacity.objects.has(deletionLedgerKey(workspaceId))).toBe(false);
    expect(world.state.rotations).toBe(1);
  });

  it("lets sign-out win after provider exchange with no callback writes or credentials", async () => {
    const rotationReached = deferred();
    const releaseRotation = deferred();
    const world = await reauthWorld({ rotationReached, releaseRotation });
    const start = await reauthStart(world.env);
    const callback = finishAuth(
      reauthRequest(start, "logout-wins"),
      world.env,
      async () => workosResponse(),
      verifierFor("session_callback_lost"),
    );
    await rotationReached.promise;

    const logout = await signOut(signoutRequest(), world.env);
    releaseRotation.resolve();
    const callbackResponse = await callback;

    expect(logout.status).toBe(200);
    expect(new URL((await logout.clone().json() as { logout_url: string }).logout_url)
      .searchParams.get("session_id")).toBe(oldWorkOSSID);
    expect(callbackResponse.status).toBe(503);
    expect(world.state.rotations).toBe(0);
    expect(world.state.profileWrites).toBe(0);
    expect(world.state.providerWrites).toBe(0);
    expect(splitSetCookies(callbackResponse)).not.toContain(`${SESSION_COOKIE}=hfg_session_`);
    for (const name of [
      SESSION_COOKIE,
      CSRF_COOKIE,
      "__Host-hfg_auth_state",
      "__Host-hfg_pkce",
      "__Host-hfg_return",
      "__Host-hfg_intent",
    ]) {
      expect(splitSetCookies(logout)).toContain(`${name}=`);
    }
  });

  it("lets callback commit first, then paused sign-out revokes its token and current SID", async () => {
    const signoutReached = deferred();
    const releaseSignout = deferred();
    const world = await reauthWorld({ signoutReached, releaseSignout });
    const logout = signOut(signoutRequest(), world.env);
    await signoutReached.promise;

    const start = await reauthStart(world.env);
    const callback = await finishAuth(
      reauthRequest(start, "callback-wins"),
      world.env,
      async () => workosResponse(),
      verifierFor("session_callback_committed"),
    );
    expect(callback.status).toBe(303);
    expect(world.state.active).toBe(true);
    expect(world.state.workosSessionId).toBe("session_callback_committed");
    releaseSignout.resolve();
    const logoutResponse = await logout;

    expect(logoutResponse.status).toBe(200);
    expect(world.state.active).toBe(false);
    const logoutBody = await logoutResponse.json() as { logout_url: string };
    const logoutURL = new URL(logoutBody.logout_url);
    expect(logoutURL.origin + logoutURL.pathname).toBe(
      "https://api.workos.com/user_management/sessions/logout",
    );
    expect(logoutURL.searchParams.get("session_id")).toBe("session_callback_committed");
    expect(logoutURL.searchParams.get("return_to")).toBe(
      "https://api.handoffgraph.dev/account",
    );
    expect(logoutResponse.headers.get("cache-control")).toBe("no-store");
    expect(world.state.rotations).toBe(1);
    const rotation = world.batches.find((batch) =>
      batch[0]?.sql.includes("account-reauth:rotate"),
    )?.[0];
    expect(rotation?.binds.slice(0, 3)).toEqual([
      sessionId,
      userId,
      await sha256Hex(oldSessionToken),
    ]);
  });

  it("does not return a logout URL or clear cookies when the revoke loses", async () => {
    const signoutReached = deferred();
    const releaseSignout = deferred();
    const world = await reauthWorld({ signoutReached, releaseSignout });
    const logout = signOut(signoutRequest(), world.env);
    await signoutReached.promise;
    world.state.active = false;
    releaseSignout.resolve();
    const response = await logout;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears a pending auth flow so its callback never reaches WorkOS", async () => {
    const world = await reauthWorld();
    const pending = await reauthStart(world.env);
    const pendingState = new URL(pending.headers.get("location") ?? "").searchParams.get("state");
    const logout = await signOut(signoutRequest(), world.env);
    expect(logout.status).toBe(200);
    const cleared = splitSetCookies(logout);
    for (const name of [
      SESSION_COOKIE,
      CSRF_COOKIE,
      "__Host-hfg_auth_state",
      "__Host-hfg_pkce",
      "__Host-hfg_return",
      "__Host-hfg_intent",
    ]) {
      expect(cleared).toContain(`${name}=`);
    }
    expect(cleared.match(/Max-Age=0/g)).toHaveLength(6);

    const fetcher = vi.fn();
    const callback = await finishAuth(
      new Request(
        `https://api.handoffgraph.dev/v1/auth/callback?code=pending&state=${pendingState}`,
      ),
      world.env,
      fetcher,
      verifierFor("session_must_not_be_reached"),
    );
    expect(callback.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows an independent anonymous browser to sign in after another browser logs out", async () => {
    const logoutWorld = await reauthWorld();
    const logout = await signOut(signoutRequest(), logoutWorld.env);
    expect(logout.status).toBe(200);

    let active = false;
    const capacity = new FakeControlR2();
    await reserveHostedBetaIssuance(capacity, providerSubject);
    capacity.puts = 0;
    const { db, batches } = mockDb({
      first(statement) {
        if (statement.sql.includes("SELECT user_id FROM provider_identities")) {
          return { user_id: userId };
        }
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceId };
        }
        return null;
      },
      batch(statements) {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO account_sessions"))) {
          active = true;
        }
      },
    });
    const env = { ...configuredEnv(db), BODIES: capacity };
    const start = await reauthStart(env);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await finishAuth(
      new Request(
        `https://api.handoffgraph.dev/v1/auth/callback?code=independent&state=${state}`,
        { headers: { cookie: authCookieHeader(start) } },
      ),
      env,
      async () => workosResponse(),
      verifierFor("session_independent_browser"),
    );
    expect(callback.status).toBe(303);
    expect(active).toBe(true);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT INTO account_sessions")),
    )).toBe(true);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("account-reauth:rotate")),
    )).toBe(false);
    expect(capacity.puts).toBe(0);
  });
});

describe("browser sessions and device quota", () => {
  let csrf = "";
  let csrfHash = "";
  beforeAll(async () => {
    csrf = "csrf-token-with-at-least-thirty-two-bytes";
    csrfHash = await sha256Hex(csrf);
  });

  it("returns bounded entitlement usage without exposing session or CSRF hashes", async () => {
    const { db } = mockDb({
      first: (statement) => statement.sql.includes("FROM account_sessions")
        ? sessionRow(csrfHash)
        : null,
    });
    const response = await getMe(
      new Request("https://api.handoffgraph.dev/v1/me", {
        headers: { cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}` },
      }),
      configuredEnv(db),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      user: { email: "ada@example.com" },
      entitlement: {
        plan_id: "basic",
        devices: { used: 0, limit: 2 },
        device_issuances: { used: 0, limit: 10 },
        monthly_events: { used: 10, limit: 5_000 },
        overages: false,
        local_capture_unaffected: true,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("csrf");
    expect(serialized).not.toContain("session_id");
    expect(serialized).not.toContain("token_hash");
    expect(serialized).not.toContain(TEST_WORKOS_SID);
    expect(serialized).not.toContain("user_workos_immutable_123");
  });

  it("denies Hosted Basic browser auth and deletion when BODIES is missing", async () => {
    const { db, statements, batches } = mockDb({
      first: (statement) => statement.sql.includes("FROM account_sessions")
        ? sessionRow(csrfHash)
        : null,
    });
    const env = {
      ...configuredEnv(db, { deletionLedger: "missing" }),
      HOSTED_SURFACE: "basic",
    };
    const cookie = `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`;
    const me = await getMe(
      new Request("https://api.handoffgraph.dev/v1/me", { headers: { cookie } }),
      env,
    );
    const deletion = await deleteAccount(
      new Request("https://api.handoffgraph.dev/v1/account", {
        method: "DELETE",
        headers: {
          cookie,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirmation: `DELETE ${TEST_ACCOUNT_WORKSPACE_ID}` }),
      }),
      env,
    );

    expect(me.status).toBe(401);
    expect(deletion.status).toBe(401);
    expect(statements.some((statement) =>
      statement.sql.includes("account-deletion:prelock-workspace"),
    )).toBe(false);
    expect(batches).toHaveLength(0);
  });

  it("projects an expired monthly period as reset before the next write", async () => {
    const { db } = mockDb({
      first: (statement) => statement.sql.includes("FROM account_sessions")
        ? sessionRow(csrfHash, {
            period_start: 1_000,
            period_end: 2_000,
            used_monthly_events: 5_000,
            used_monthly_bytes: 10_485_760,
          })
        : null,
    });
    const response = await getMe(
      new Request("https://api.handoffgraph.dev/v1/me", {
        headers: { cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}` },
      }),
      configuredEnv(db),
    );
    const body = await response.json() as {
      entitlement: {
        monthly_events: { used: number };
        monthly_bytes: { used: number };
        period_end: number;
      };
    };
    expect(body.entitlement.monthly_events.used).toBe(0);
    expect(body.entitlement.monthly_bytes.used).toBe(0);
    expect(body.entitlement.period_end).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });

  it("requires both exact same-origin and CSRF for state-changing routes", async () => {
    const { db } = mockDb({
      first: (statement) => statement.sql.includes("FROM account_sessions")
        ? sessionRow(csrfHash)
        : null,
    });
    const base = {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}` },
    };
    const noOrigin = await signOut(
      new Request("https://api.handoffgraph.dev/v1/auth/signout", base),
      configuredEnv(db),
    );
    expect(noOrigin.status).toBe(403);
    const badCsrf = await signOut(
      new Request("https://api.handoffgraph.dev/v1/auth/signout", {
        ...base,
        headers: { ...base.headers, origin: "https://api.handoffgraph.dev", "x-csrf-token": "wrong" },
      }),
      configuredEnv(db),
    );
    expect(badCsrf.status).toBe(403);
  });

  it("atomically reserves a device slot and returns the raw token exactly once", async () => {
    const writes: RecordedStatement[] = [];
    const { db } = mockDb({
      first(statement) {
        if (statement.sql.includes("INSERT INTO devices")) {
          writes.push(statement);
          return { id: String(statement.binds[0]) };
        }
        if (statement.sql.includes("FROM account_sessions")) return sessionRow(csrfHash);
        if (statement.sql.includes("UPDATE workspace_entitlements")) {
          return {
            active_devices: 1,
            max_devices: 2,
            used_device_issuances: 1,
            max_device_issuances: 10,
          };
        }
        return null;
      },
      run(statement) { writes.push(statement); },
    });
    const response = await createDevice(
      new Request("https://api.handoffgraph.dev/v1/devices", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Ada's MacBook" }),
      }),
      configuredEnv(db),
    );
    expect(response.status).toBe(201);
    const payload = await response.json() as { device: { id: string; token: string } };
    expect(payload.device.id).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.device.token).toMatch(/^hfg_dev_[\w-]{43}$/);
    expect(JSON.stringify(writes)).not.toContain(payload.device.token);
    expect(JSON.stringify(writes)).toContain(await sha256Hex(payload.device.token));
  });

  it("does not create a device when sign-out wins after session preflight", async () => {
    let sessionActive = true;
    const insertReached = deferred();
    const releaseInsert = deferred();
    const { db } = mockDb({
      async first(statement) {
        if (statement.sql.includes("FROM account_sessions AS s")) {
          return sessionActive ? sessionRow(csrfHash) : null;
        }
        if (statement.sql.includes("INSERT INTO devices")) {
          insertReached.resolve();
          await releaseInsert.promise;
          return sessionActive ? { id: String(statement.binds[0]) } : null;
        }
        return null;
      },
      all(statement) {
        if (statement.sql.includes("account-signout:revoke-user")) {
          sessionActive = false;
          releaseInsert.resolve();
          return [{
            id: "acs_01K4ACCOUNTSESSION00000000Z",
            workos_session_id: TEST_WORKOS_SID,
          }];
        }
        return [];
      },
    });
    const env = configuredEnv(db);
    const create = createDevice(new Request(
      "https://api.handoffgraph.dev/v1/devices",
      {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "racing device" }),
      },
    ), env);
    await insertReached.promise;
    const logout = await signOut(new Request(
      "https://api.handoffgraph.dev/v1/auth/signout",
      {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
        },
      },
    ), env);

    expect(logout.status).toBe(200);
    expect((await create).status).toBe(401);
    expect(sessionActive).toBe(false);
  });

  it("does not create or disclose a device when deletion prelock wins and its R2 fence fails", async () => {
    let workspaceStatus = "active";
    let deviceWritten = false;
    const validWorkspaceId = `wsp_01J${"R".repeat(23)}`;
    const validUserId = `usr_01J${"Q".repeat(23)}`;
    const validSessionId = `acs_01J${"S".repeat(23)}`;
    const insertReached = deferred();
    const releaseInsert = deferred();
    const bucket = new FakeControlR2();
    vi.spyOn(bucket, "put").mockRejectedValue(new Error("R2 unavailable"));
    const { db, batches } = mockDb({
      async first(statement) {
        if (statement.sql.includes("FROM account_sessions AS s")) {
          return workspaceStatus === "active" ? sessionRow(csrfHash, {
            workspace_id: validWorkspaceId,
            user_id: validUserId,
            session_id: validSessionId,
          }) : null;
        }
        if (statement.sql.includes("INSERT INTO devices")) {
          insertReached.resolve();
          await releaseInsert.promise;
          if (workspaceStatus !== "active") return null;
          deviceWritten = true;
          return { id: String(statement.binds[0]) };
        }
        if (statement.sql.includes("account-deletion:foreign-workspace-links")) {
          return { blocked: 0 };
        }
        if (statement.sql.includes("account-deletion:prelock-workspace")) {
          if (workspaceStatus !== "active") return null;
          workspaceStatus = "deleting";
          return { id: String(statement.binds[0]) };
        }
        return null;
      },
    });
    const env: AccountDeletionEnv = { ...configuredEnv(db), BODIES: bucket };
    const cookie = `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`;
    const headers = {
      cookie,
      origin: "https://api.handoffgraph.dev",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const creation = createDevice(new Request(
      "https://api.handoffgraph.dev/v1/devices",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "prelock race" }),
      },
    ), env);
    await insertReached.promise;
    const deletion = await deleteAccount(new Request(
      "https://api.handoffgraph.dev/v1/account",
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: `DELETE ${validWorkspaceId}`,
        }),
      },
    ), env);
    expect(deletion.status).toBe(503);
    expect(workspaceStatus).toBe("deleting");
    releaseInsert.resolve();

    const response = await creation;
    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload).toEqual({ error: "unauthorized" });
    expect(deviceWritten).toBe(false);
    expect(batches).toHaveLength(0);
    expect(JSON.stringify(payload)).not.toContain("hfg_dev_");
  });

  it("returns 429 without minting a device when the hard slot limit is reached", async () => {
    const writes: RecordedStatement[] = [];
    const { db } = mockDb({
      first(statement) {
        return statement.sql.includes("FROM account_sessions")
          ? sessionRow(csrfHash, { active_devices: 2 })
          : null;
      },
      run(statement) { writes.push(statement); },
    });
    const response = await createDevice(
      new Request("https://api.handoffgraph.dev/v1/devices", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "third device" }),
      }),
      configuredEnv(db),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "quota_exceeded",
      resource: "devices",
      limit: 2,
      local_capture_unaffected: true,
    });
    expect(writes).toHaveLength(0);
  });

  it("stops lifetime device-row growth even after revoked slots are reused", async () => {
    const writes: RecordedStatement[] = [];
    const { db } = mockDb({
      first(statement) {
        return statement.sql.includes("FROM account_sessions")
          ? sessionRow(csrfHash, {
              active_devices: 0,
              used_device_issuances: 10,
            })
          : null;
      },
      run(statement) { writes.push(statement); },
    });
    const response = await createDevice(
      new Request("https://api.handoffgraph.dev/v1/devices", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "replacement device" }),
      }),
      configuredEnv(db),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "quota_exceeded",
      resource: "device_issuances",
      limit: 10,
      local_capture_unaffected: true,
    });
    expect(writes).toHaveLength(0);
  });

  it("shares one unsafe-request gate with the other account-plane modules", async () => {
    const { db } = mockDb({
      first: (statement) => statement.sql.includes("FROM account_sessions")
        ? sessionRow(csrfHash)
        : null,
    });
    const headers = {
      cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
      origin: "https://api.handoffgraph.dev",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const authorized = await authorizedUnsafeRequest(
      new Request("https://api.handoffgraph.dev/v1/workspace/invites", {
        method: "POST",
        headers,
        body: "{}",
      }),
      configuredEnv(db),
    );
    expect("session" in authorized && authorized.session.userId).toBe(
      "usr_01K4USER0000000000000000Z",
    );

    const foreignOrigin = await authorizedUnsafeRequest(
      new Request("https://api.handoffgraph.dev/v1/workspace/invites", {
        method: "POST",
        headers: { ...headers, origin: "https://attacker.example" },
        body: "{}",
      }),
      configuredEnv(db),
    );
    expect("response" in foreignOrigin && foreignOrigin.response.status).toBe(403);
  });

  it("exposes bounded body reading, origin parsing, and opaque secrets to sibling modules", async () => {
    const body = (payload: string): Request =>
      new Request("https://api.handoffgraph.dev/v1/workspace/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    expect(await readAccountJsonBody(body(JSON.stringify({ email: "a@b.co" })))).toEqual({
      email: "a@b.co",
    });
    expect(await readAccountJsonBody(body("[1,2]"))).toBeNull();
    expect(await readAccountJsonBody(body("not json"))).toBeNull();
    expect(await readAccountJsonBody(body(JSON.stringify({ x: "y".repeat(5_000) })))).toBeNull();

    expect(normalizedOrigin("https://api.handoffgraph.dev")).toBe("https://api.handoffgraph.dev");
    expect(normalizedOrigin("https://api.handoffgraph.dev/path")).toBeNull();
    expect(normalizedOrigin("http://attacker.example")).toBeNull();
    expect(normalizedOrigin(undefined)).toBeNull();

    const secret = randomSecret();
    expect(secret).toMatch(/^[\w-]{43}$/);
    expect(secret).not.toBe(randomSecret());
  });

  it("rejects an account JSON body beyond 4 KiB before reserving a slot", async () => {
    const statements: RecordedStatement[] = [];
    const { db } = mockDb({
      first(statement) {
        statements.push(statement);
        return statement.sql.includes("FROM account_sessions")
          ? sessionRow(csrfHash)
          : null;
      },
    });
    const response = await createDevice(
      new Request("https://api.handoffgraph.dev/v1/devices", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
          origin: "https://api.handoffgraph.dev",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "x".repeat(5_000) }),
      }),
      configuredEnv(db),
    );
    expect(response.status).toBe(400);
    expect(statements.some((statement) =>
      statement.sql.includes("UPDATE workspace_entitlements"),
    )).toBe(false);
  });
});

describe("account-plane sign-out commit races", () => {
  const userId = `usr_01J${"Q".repeat(23)}`;
  const workspaceId = `wsp_01J${"R".repeat(23)}`;
  const sessionId = `acs_01J${"S".repeat(23)}`;
  const csrf = "race-csrf-token-with-at-least-thirty-two-bytes";
  let csrfHash = "";

  beforeAll(async () => {
    csrfHash = await sha256Hex(csrf);
  });

  function raceSession() {
    return sessionRow(csrfHash, {
      session_id: sessionId,
      user_id: userId,
      workspace_id: workspaceId,
    });
  }

  function unsafeRequest(path: string, method: "POST" | "DELETE", body?: string): Request {
    return new Request(`https://api.handoffgraph.dev${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=hfg_session_${"x".repeat(40)}`,
        origin: "https://api.handoffgraph.dev",
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body }),
    });
  }

  it("lets sign-out win before the deletion prelock without writing D1 or R2 deletion state", async () => {
    let sessionActive = true;
    let workspaceStatus = "active";
    let jobExists = false;
    const prelockReached = deferred();
    const releasePrelock = deferred();
    const bucket = new FakeControlR2();
    const { db, batches } = mockDb({
      async first(statement) {
        if (statement.sql.includes("FROM account_sessions AS s")) {
          return sessionActive && workspaceStatus === "active" ? raceSession() : null;
        }
        if (statement.sql.includes("account-deletion:foreign-workspace-links")) {
          return { blocked: 0 };
        }
        if (statement.sql.includes("account-deletion:prelock-workspace")) {
          prelockReached.resolve();
          await releasePrelock.promise;
          if (!sessionActive || workspaceStatus !== "active") return null;
          workspaceStatus = "deleting";
          return { id: workspaceId };
        }
        if (statement.sql.includes("account-deletion:job")) {
          return jobExists ? {
            workspace_id: workspaceId,
            requested_by_user_id: userId,
            status: "pending",
            next_attempt_at: 1,
            workos_deleted_at: null,
          } : null;
        }
        return null;
      },
      all(statement) {
        if (statement.sql.includes("account-signout:revoke-user")) {
          sessionActive = false;
          releasePrelock.resolve();
          return [{ id: sessionId, workos_session_id: TEST_WORKOS_SID }];
        }
        return [];
      },
      batch() {
        jobExists = true;
      },
    });
    const env: AccountDeletionEnv = {
      ...configuredEnv(db),
      BODIES: bucket,
    };
    const deletion = deleteAccount(
      unsafeRequest(
        "/v1/account",
        "DELETE",
        JSON.stringify({ confirmation: `DELETE ${workspaceId}` }),
      ),
      env,
    );
    await prelockReached.promise;
    const logout = await signOut(unsafeRequest("/v1/auth/signout", "POST"), env);

    expect(logout.status).toBe(200);
    expect((await deletion).status).toBe(401);
    expect(workspaceStatus).toBe("active");
    expect(jobExists).toBe(false);
    expect(batches).toHaveLength(0);
    expect(bucket.objects.has(deletionLedgerKey(workspaceId))).toBe(false);
  });

  it("lets the deletion prelock win after sign-out preflight and owns completion", async () => {
    let sessionActive = true;
    let workspaceStatus = "active";
    let jobExists = false;
    const logoutWriteReached = deferred();
    const releaseLogoutWrite = deferred();
    const bucket = new FakeControlR2();
    const { db, batches } = mockDb({
      first(statement) {
        if (statement.sql.includes("FROM account_sessions AS s")) {
          return sessionActive && workspaceStatus === "active" ? raceSession() : null;
        }
        if (statement.sql.includes("account-deletion:foreign-workspace-links")) {
          return { blocked: 0 };
        }
        if (statement.sql.includes("account-deletion:prelock-workspace")) {
          if (!sessionActive || workspaceStatus !== "active") return null;
          workspaceStatus = "deleting";
          return { id: workspaceId };
        }
        return null;
      },
      async all(statement) {
        if (statement.sql.includes("account-signout:revoke-user")) {
          logoutWriteReached.resolve();
          await releaseLogoutWrite.promise;
          if (sessionActive && workspaceStatus === "active") {
            sessionActive = false;
            return [{ id: sessionId, workos_session_id: TEST_WORKOS_SID }];
          }
        }
        return [];
      },
      batch(statements) {
        expect(statements[0]?.sql).toContain("account-deletion:create-job");
        jobExists = true;
        sessionActive = false;
      },
    });
    const env: AccountDeletionEnv = {
      ...configuredEnv(db),
      BODIES: bucket,
    };
    const logout = signOut(unsafeRequest("/v1/auth/signout", "POST"), env);
    await logoutWriteReached.promise;
    const deletion = await deleteAccount(
      unsafeRequest(
        "/v1/account",
        "DELETE",
        JSON.stringify({ confirmation: `DELETE ${workspaceId}` }),
      ),
      env,
    );
    releaseLogoutWrite.resolve();

    expect(deletion.status).toBe(202);
    expect((await logout).status).toBe(401);
    expect(workspaceStatus).toBe("deleting");
    expect(jobExists).toBe(true);
    expect(batches).toHaveLength(1);
    expect(bucket.objects.has(deletionLedgerKey(workspaceId))).toBe(true);
  });
});
