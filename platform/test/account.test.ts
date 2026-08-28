import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  authorizedUnsafeRequest,
  createDevice,
  finishAuth,
  getMe,
  normalizedOrigin,
  randomSecret,
  readAccountJsonBody,
  signOut,
  startAuth,
  type AccountEnv,
} from "../src/account";
import { sha256Hex } from "../src/auth";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1Statement,
} from "../src/db";

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
  batch?: (statements: RecordedStatement[]) => void | Promise<void>;
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
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded);
      await handlers.batch?.(recorded);
      return [];
    },
  };
  return { db, statements, batches };
}

function configuredEnv(db: D1DatabaseLike): AccountEnv {
  return {
    DB: db,
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test_secret",
    WORKOS_REDIRECT_URI: "https://api.handoffgraph.dev/v1/auth/callback",
    APP_ORIGIN: "https://api.handoffgraph.dev",
    LANDING_ORIGIN: "https://handoffgraph.dev",
    HOSTED_SIGNUP_ENABLED: "true",
  };
}

function splitSetCookies(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
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
    csrf_hash: csrfHash,
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    avatar_url: null,
    workspace_id: "wsp_01K4WORKSPACE00000000000Z",
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
        if (statement.sql.includes("SELECT personal_workspace_id FROM users")) {
          return { personal_workspace_id: workspaceId };
        }
        return null;
      },
      run(statement) {
        recorded.push(statement);
      },
    });
    const env = configuredEnv(db);
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
      }), { status: 200 }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_beta_unavailable" });
    expect(batches).toHaveLength(0);
  });

  it("allows an existing account to sign in while new signup is closed", async () => {
    const userID = "usr_existing";
    const workspaceID = "wsp_existing";
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
        user: { id: "existing-provider-user", email: "existing@example.com", email_verified: true },
      }), { status: 200 }),
    );
    expect(response.status).toBe(303);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("INSERT INTO provider_identities")),
    )).toBe(false);
    expect(batches.some((batch) =>
      batch.some((statement) => statement.sql.includes("DELETE FROM account_sessions")),
    )).toBe(true);
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
    expect(JSON.stringify(body)).not.toContain("csrf");
    expect(JSON.stringify(body)).not.toContain("session_id");
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
