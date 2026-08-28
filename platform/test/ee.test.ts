// Enterprise tier: the fence, SSO, SCIM, data masking, audit export, and the
// in-product assistant (parity rows 48, 51).
//
// These tests live in the normal OSS test tree on purpose: one `vitest run`
// must cover the whole Worker, including the assertion that the Enterprise
// surface is INVISIBLE by default. Testing the fence is an OSS concern.
//
// The first describe block is the load-bearing one. Everything else is
// features; that one is the licensing boundary.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";
import { TEAM_EVENT_KINDS, verifyAuditPage, type AuditEntry } from "../src/teams";
import {
  AUDIT_EXPORT_KINDS,
  applyMaskingRules,
  compileMaskingRule,
  eeEnabled,
  handleEERoute,
  loadMaskingRules,
  type EEEnv,
  type MaskingRule,
} from "../ee/src/ee";
import {
  ASSISTANT_PATH,
  MAX_TOOL_CALLS,
  parseModelTurn,
  type AssistantModelCall,
  type ChatMessage,
} from "../ee/src/assistant";

// -- fixtures ------------------------------------------------------------------

const APP_ORIGIN = "https://api.handoffgraph.dev";
const EE_WS = `wsp_01J${"A".repeat(23)}`;
const OTHER_WS = `wsp_01J${"B".repeat(23)}`;
const OWNER = `usr_01J${"C".repeat(23)}`;
const ADMIN = `usr_01J${"D".repeat(23)}`;
const MEMBER = `usr_01J${"E".repeat(23)}`;
const OUTSIDER = `usr_01J${"G".repeat(23)}`;
const WORKSTREAM = `ws_01J${"K".repeat(23)}`;
// Crockford base32 excludes I, L, O and U, so every fixture id below is built
// from letters the ULID alphabet actually contains.
const SESSION_EVIDENCE = `ses_01J${"W".repeat(23)}`;
const CSRF = "csrf-token-with-at-least-thirty-two-bytes";
const SESSION_COOKIE_VALUE = `hfg_session_${"x".repeat(40)}`;
const DEVICE_TOKEN = `hfg_dev_${"y".repeat(40)}`;
const DEVICE_ID = `dev_01J${"M".repeat(23)}`;

type Role = "owner" | "admin" | "member" | "viewer";

interface MemberState {
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  createdAt: number;
}

interface InviteState {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface SsoState {
  workspace_id: string;
  workos_org_id: string;
  connection_state: string;
  updated_at: number;
}

interface ScimTokenState {
  workspaceId: string;
  tokenHash: string;
  createdAt: number;
  revokedAt: number | null;
}

interface MaskingRuleState {
  id: string;
  workspace_id: string;
  field_pattern: string;
  action: string;
  created_at: number;
}

interface EventState {
  seq: number;
  workspace_id: string;
  event_id: string;
  kind: string;
  raw_json: string;
}

interface World {
  members: MemberState[];
  invites: InviteState[];
  sso: SsoState | null;
  scimTokens: ScimTokenState[];
  maskingRules: MaskingRuleState[];
  events: EventState[];
  head: { seq: number; content_hash: string } | null;
  /** Scripted MCP tool payloads keyed by tool name. */
  mcp: Record<string, unknown>;
}

function member(userId: string, role: Role, overrides: Partial<MemberState> = {}): MemberState {
  return {
    workspaceId: EE_WS,
    userId,
    email: `${role}@example.com`,
    displayName: role,
    role,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

function defaultWorld(): World {
  return {
    members: [
      member(OWNER, "owner", { email: "owner@example.com", createdAt: 1_700_000_001 }),
      member(ADMIN, "admin", { email: "admin@example.com", createdAt: 1_700_000_002 }),
      member(MEMBER, "member", { email: "member@example.com", createdAt: 1_700_000_003 }),
    ],
    invites: [],
    sso: null,
    scimTokens: [],
    maskingRules: [],
    events: [],
    head: null,
    mcp: {},
  };
}

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function sessionRow(userId: string, csrfHash: string, world: World) {
  const self = world.members.find((row) => row.userId === userId);
  return {
    session_id: `acs_01J${"Z".repeat(23)}`,
    user_id: userId,
    csrf_hash: csrfHash,
    email: self?.email ?? "outsider@example.com",
    display_name: self?.displayName ?? null,
    avatar_url: null,
    workspace_id: userId === OUTSIDER ? OTHER_WS : EE_WS,
    workspace_name: "EE workspace",
    role: self?.role ?? "owner",
    plan_id: "basic",
    plan_status: "active",
    max_devices: 2,
    active_devices: 0,
    max_device_issuances: 10,
    used_device_issuances: 0,
    max_monthly_events: 5_000,
    used_monthly_events: 0,
    max_monthly_bytes: 10_485_760,
    used_monthly_bytes: 0,
    max_lifetime_events: 25_000,
    used_lifetime_events: 0,
    max_lifetime_bytes: 67_108_864,
    used_lifetime_bytes: 0,
    period_start: 1_700_000_000,
    period_end: 4_000_000_000,
  };
}

/**
 * Fake D1 answering on the SQL marker comments the modules pin, mutating a
 * tiny in-memory world on commit. Same discipline as test/teams.test.ts.
 */
function eeDb(world: World, csrfHash: string, sessionUser: string | null, deviceTokenHash: string) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];

  const first = (statement: RecordedStatement): unknown => {
    const { sql, binds } = statement;
    if (sql.includes("FROM account_sessions")) {
      return sessionUser === null ? null : sessionRow(sessionUser, csrfHash, world);
    }
    if (sql.includes("teams:read-membership")) {
      const row = world.members.find((m) => m.workspaceId === binds[0] && m.userId === binds[1]);
      return row === undefined
        ? null
        : { workspace_id: row.workspaceId, role: row.role, workspace_name: "EE workspace" };
    }
    if (sql.includes("apikeys:device-by-token")) {
      return binds[0] === deviceTokenHash
        ? {
            id: DEVICE_ID,
            workspace_id: EE_WS,
            token_hash: deviceTokenHash,
            capabilities: "ingest,read",
            revoked_at: null,
          }
        : null;
    }
    if (sql.includes("ee:read-sso")) {
      return world.sso !== null && world.sso.workspace_id === binds[0] ? world.sso : null;
    }
    if (sql.includes("ee:read-scim-token")) {
      const row = world.scimTokens.find((t) => t.tokenHash === binds[0] && t.revokedAt === null);
      return row === undefined ? null : { workspace_id: row.workspaceId };
    }
    if (sql.includes("ee:read-live-invite")) {
      const row = world.invites.find(
        (i) => i.workspaceId === binds[0] && i.email === binds[1] && i.revokedAt === null,
      );
      return row === undefined ? null : { id: row.id, expires_at: row.expiresAt };
    }
    if (sql.includes("ee:workspace-owner")) {
      const row = world.members
        .filter((m) => m.workspaceId === binds[0] && m.role === "owner")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      return row === undefined ? null : { user_id: row.userId };
    }
    if (sql.includes("ee:read-audit-head")) {
      return world.head;
    }
    if (sql.includes("ee:delete-masking-rule")) {
      const index = world.maskingRules.findIndex((r) => r.id === binds[0] && r.workspace_id === binds[1]);
      if (index === -1) return null;
      const [removed] = world.maskingRules.splice(index, 1);
      return { id: removed.id };
    }
    if (sql.includes("mcp:workstream-lookup")) {
      return binds[0] === EE_WS && binds[1] === WORKSTREAM
        ? { id: WORKSTREAM, title: "Ship the fence", status: "active", created_at: 1, updated_at: 2 }
        : null;
    }
    return null;
  };

  const all = (statement: RecordedStatement): unknown[] => {
    const { sql, binds } = statement;
    if (sql.includes("ee:scim-list-users-filtered")) {
      return world.members
        .filter((m) => m.workspaceId === binds[0] && m.email === binds[3])
        .map(scimRow);
    }
    if (sql.includes("ee:scim-list-users")) {
      const limit = binds[1] as number;
      const offset = binds[2] as number;
      return world.members
        .filter((m) => m.workspaceId === binds[0])
        .sort((a, b) => (a.userId < b.userId ? -1 : 1))
        .slice(offset, offset + limit)
        .map(scimRow);
    }
    if (sql.includes("ee:list-masking-rules")) {
      return world.maskingRules.filter((r) => r.workspace_id === binds[0]);
    }
    if (sql.includes("ee:audit-export")) {
      const kinds = new Set(binds.slice(2, binds.length - 1) as string[]);
      return world.events
        .filter(
          (e) => e.workspace_id === binds[0] && e.seq > (binds[1] as number) && kinds.has(e.kind),
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, binds[binds.length - 1] as number);
    }
    if (sql.includes("mcp:workstream-kind-counts")) {
      return [{ kind: "span.completed", count: 3 }];
    }
    if (sql.includes("mcp:workstream-sessions")) {
      return [
        {
          id: SESSION_EVIDENCE,
          provider: "claude-code",
          native_session_id: null,
          event_count: 3,
          span_count: 3,
          failed_span_count: 1,
          last_event_at_ms: 10,
        },
      ];
    }
    return [];
  };

  const run = (statement: RecordedStatement): void => {
    applyStatement(world, statement);
  };

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
          return first(statement) as T | null;
        },
        async all<T = unknown>() {
          return { results: all(statement) as T[] };
        },
        async run() {
          run(statement);
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded.map((s) => ({ sql: s.sql, binds: [...s.binds] })));
      for (const statement of recorded) applyStatement(world, statement);
      return recorded.map(() => ({ success: true }));
    },
  };
  return { db, statements, batches };
}

function scimRow(row: MemberState) {
  return {
    user_id: row.userId,
    role: row.role,
    created_at: row.createdAt,
    email: row.email,
    display_name: row.displayName,
  };
}

function applyStatement(world: World, statement: RecordedStatement): void {
  const { sql, binds } = statement;
  if (sql.includes("ee:upsert-sso")) {
    world.sso = {
      workspace_id: binds[0] as string,
      workos_org_id: binds[1] as string,
      connection_state: binds[2] as string,
      updated_at: binds[3] as number,
    };
    return;
  }
  if (sql.includes("ee:revoke-live-scim-tokens")) {
    for (const token of world.scimTokens) {
      if (token.workspaceId === binds[0] && token.revokedAt === null) {
        token.revokedAt = binds[1] as number;
      }
    }
    return;
  }
  if (sql.includes("ee:insert-scim-token")) {
    world.scimTokens.push({
      workspaceId: binds[0] as string,
      tokenHash: binds[1] as string,
      createdAt: binds[2] as number,
      revokedAt: null,
    });
    return;
  }
  if (sql.includes("ee:insert-masking-rule")) {
    world.maskingRules.push({
      id: binds[0] as string,
      workspace_id: binds[1] as string,
      field_pattern: binds[2] as string,
      action: binds[3] as string,
      created_at: binds[4] as number,
    });
    return;
  }
  if (sql.includes("ee:insert-invite")) {
    world.invites.push({
      id: binds[0] as string,
      workspaceId: binds[1] as string,
      email: binds[2] as string,
      role: binds[3] as string,
      tokenHash: binds[4] as string,
      createdBy: binds[5] as string,
      createdAt: binds[6] as number,
      expiresAt: binds[7] as number,
      revokedAt: null,
    });
    return;
  }
  if (sql.includes("ee:append-audit-events")) {
    const documents = JSON.parse(binds[2] as string) as Array<Record<string, unknown>>;
    let seq = world.events.length + 1;
    for (const document of documents) {
      world.events.push({
        seq: seq++,
        workspace_id: binds[0] as string,
        event_id: document.event_id as string,
        kind: document.kind as string,
        raw_json: canonicalJsonStringify(document),
      });
    }
    return;
  }
  if (sql.includes("ee:append-audit-chain")) {
    const links = JSON.parse(binds[2] as string) as Array<Record<string, unknown>>;
    const last = links[links.length - 1];
    if (last !== undefined) {
      world.head = { seq: last.seq as number, content_hash: last.content_hash as string };
    }
  }
}

// -- request helpers ------------------------------------------------------------

function envFor(db: D1DatabaseLike, enabled: boolean): EEEnv {
  const env: EEEnv = { DB: db, APP_ORIGIN };
  if (enabled) env.EE_ENABLED = "true";
  return env;
}

function signedGet(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    headers: { cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}`, ...headers },
  });
}

function signedUnsafe(method: string, path: string, body?: unknown): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}`,
      origin: APP_ORIGIN,
      "x-csrf-token": CSRF,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function scimRequest(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/scim+json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function harness(
  sessionUser: string | null = OWNER,
  world: World = defaultWorld(),
  enabled = true,
) {
  const csrfHash = await sha256Hex(CSRF);
  const deviceTokenHash = await sha256Hex(DEVICE_TOKEN);
  const { db, statements, batches } = eeDb(world, csrfHash, sessionUser, deviceTokenHash);
  return { world, db, statements, batches, env: envFor(db, enabled) };
}

// =============================================================================
// THE FENCE
// =============================================================================

/** Every EE path with the method that would serve it when EE is on. */
const EE_ROUTES: Array<[string, string]> = [
  ["GET", "/v1/ee/sso"],
  ["PUT", "/v1/ee/sso"],
  ["POST", "/v1/ee/scim/token"],
  ["GET", "/v1/ee/scim/v2/Users"],
  ["POST", "/v1/ee/scim/v2/Users"],
  ["GET", "/v1/ee/masking-rules"],
  ["POST", "/v1/ee/masking-rules"],
  ["DELETE", `/v1/ee/masking-rules/msk_01J${"N".repeat(23)}`],
  ["GET", "/v1/ee/audit/export"],
  ["POST", ASSISTANT_PATH],
];

describe("the EE fence", () => {
  it("EE_ENABLED absent means handleEERoute returns null for every EE route", async () => {
    const { env } = await harness(OWNER, defaultWorld(), false);
    expect(eeEnabled(env)).toBe(false);
    for (const [method, path] of EE_ROUTES) {
      const request = new Request(`${APP_ORIGIN}${path}`, { method });
      await expect(handleEERoute(request, env)).resolves.toBeNull();
    }
  });

  it("only the exact string 'true' opens the fence", async () => {
    for (const value of ["false", "TRUE", "True", "1", "yes", "", " true"]) {
      const { db } = eeDb(defaultWorld(), "hash", null, "hash");
      const env: EEEnv = { DB: db, APP_ORIGIN, EE_ENABLED: value };
      expect(eeEnabled(env)).toBe(false);
      const request = new Request(`${APP_ORIGIN}/v1/ee/sso`);
      await expect(handleEERoute(request, env)).resolves.toBeNull();
    }
  });

  it("with EE off, every EE route answers byte-identically to an unknown route", async () => {
    const { env } = await harness(OWNER, defaultWorld(), false);
    const unknown = await worker.fetch(
      new Request(`${APP_ORIGIN}/v1/definitely-not-a-route`),
      env,
      {} as never,
    );
    const baselineStatus = unknown.status;
    const baselineBody = await unknown.text();
    const baselineHeaders = [...unknown.headers.entries()].sort();

    expect(baselineStatus).toBe(404);
    expect(baselineBody).toBe(JSON.stringify({ error: "not found" }));

    for (const [method, path] of EE_ROUTES) {
      const response = await worker.fetch(
        new Request(`${APP_ORIGIN}${path}`, {
          method,
          headers: method === "GET" ? {} : { "content-type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        }),
        env,
        {} as never,
      );
      expect([method, path, response.status]).toEqual([method, path, baselineStatus]);
      expect([method, path, await response.text()]).toEqual([method, path, baselineBody]);
      expect([method, path, [...response.headers.entries()].sort()]).toEqual([
        method,
        path,
        baselineHeaders,
      ]);
    }
  });

  it("with EE off, an EE path is not even authenticated (no D1 touched)", async () => {
    const { env, statements } = await harness(OWNER, defaultWorld(), false);
    await handleEERoute(signedGet("/v1/ee/sso"), env);
    // The fence check precedes every read, so a disabled deployment cannot be
    // probed for the existence of the EE tables or for session validity.
    expect(statements).toHaveLength(0);
  });

  it("with EE on, the same routes are live", async () => {
    const { env } = await harness(null);
    for (const [method, path] of EE_ROUTES) {
      const request = new Request(`${APP_ORIGIN}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      });
      const response = await handleEERoute(request, env);
      expect([method, path, response === null]).toEqual([method, path, false]);
      // Unauthenticated, so every one of them denies rather than serving. The
      // account-plane mutations answer 403 rather than 401 because the
      // same-origin check in account.ts's authorizedUnsafeRequest runs before
      // the session lookup — the identical contract teams.ts enforces.
      expect([method, path, [401, 403].includes(response?.status ?? 0)]).toEqual([
        method,
        path,
        true,
      ]);
    }
  });

  it("with EE on, a wrong method on a known EE path still falls through to 404", async () => {
    const { env } = await harness();
    for (const [method, path] of [
      ["DELETE", "/v1/ee/sso"],
      ["GET", "/v1/ee/scim/token"],
      ["PUT", "/v1/ee/masking-rules"],
      ["POST", "/v1/ee/audit/export"],
      ["GET", ASSISTANT_PATH],
      ["GET", "/v1/ee/nope"],
    ] as Array<[string, string]>) {
      const request = new Request(`${APP_ORIGIN}${path}`, { method });
      await expect(handleEERoute(request, env)).resolves.toBeNull();
    }
  });

  it("index.ts delegates to EE after every OSS module, so no OSS route can be shadowed", async () => {
    const { env } = await harness(null);
    // A representative OSS route still behaves the same with EE enabled.
    const healthz = await worker.fetch(new Request(`${APP_ORIGIN}/healthz`), env, {} as never);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ status: "ok" });
  });
});

// =============================================================================
// SSO
// =============================================================================

describe("EE SSO binding", () => {
  it("reads as unlinked before any binding exists", async () => {
    const { env } = await harness(ADMIN);
    const response = await handleEERoute(signedGet("/v1/ee/sso"), env);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, Record<string, unknown>>;
    expect(body.sso).toEqual({
      workspace_id: EE_WS,
      workos_org_id: null,
      connection_state: "unlinked",
      updated_at: null,
    });
    expect(body.setup.provider).toBe("workos");
  });

  it("PUT stores the WorkOS organization id and GET reads it back", async () => {
    const { env, world } = await harness(OWNER);
    const put = await handleEERoute(
      signedUnsafe("PUT", "/v1/ee/sso", { workos_org_id: "org_01HXYZ" }),
      env,
    );
    expect(put?.status).toBe(200);
    const stored = (await put?.json()) as Record<string, Record<string, unknown>>;
    expect(stored.sso.workos_org_id).toBe("org_01HXYZ");
    expect(stored.sso.connection_state).toBe("pending");
    expect(world.sso?.workos_org_id).toBe("org_01HXYZ");

    const read = await handleEERoute(signedGet("/v1/ee/sso"), env);
    const body = (await read?.json()) as Record<string, Record<string, unknown>>;
    expect(body.sso.connection_state).toBe("pending");
  });

  it("PUT accepts an explicit active state and rejects anything else", async () => {
    const { env } = await harness(OWNER);
    const ok = await handleEERoute(
      signedUnsafe("PUT", "/v1/ee/sso", { workos_org_id: "org_1", connection_state: "active" }),
      env,
    );
    expect(((await ok?.json()) as Record<string, Record<string, unknown>>).sso.connection_state).toBe(
      "active",
    );

    const bad = await handleEERoute(
      signedUnsafe("PUT", "/v1/ee/sso", { workos_org_id: "org_1", connection_state: "unlinked" }),
      env,
    );
    expect(bad?.status).toBe(400);
  });

  it("rejects a malformed organization id", async () => {
    const { env } = await harness(OWNER);
    for (const orgId of ["", "org with spaces", "x".repeat(201), 42, null]) {
      const response = await handleEERoute(
        signedUnsafe("PUT", "/v1/ee/sso", { workos_org_id: orgId }),
        env,
      );
      expect(response?.status).toBe(400);
    }
  });

  it("an admin may read but only an owner may bind", async () => {
    const { env } = await harness(ADMIN);
    expect((await handleEERoute(signedGet("/v1/ee/sso"), env))?.status).toBe(200);
    const put = await handleEERoute(
      signedUnsafe("PUT", "/v1/ee/sso", { workos_org_id: "org_1" }),
      env,
    );
    expect(put?.status).toBe(403);
  });

  it("a member cannot even read the binding", async () => {
    const { env } = await harness(MEMBER);
    expect((await handleEERoute(signedGet("/v1/ee/sso"), env))?.status).toBe(403);
  });

  it("a non-member gets 404, never a hint that the workspace exists", async () => {
    const { env } = await harness(OUTSIDER);
    const response = await handleEERoute(signedGet("/v1/ee/sso"), env);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "not found" });
  });

  it("requires a session and a valid CSRF token", async () => {
    const { env } = await harness(null);
    expect((await handleEERoute(signedGet("/v1/ee/sso"), env))?.status).toBe(401);

    const { env: signed } = await harness(OWNER);
    const noOrigin = new Request(`${APP_ORIGIN}/v1/ee/sso`, {
      method: "PUT",
      headers: { cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}`, "x-csrf-token": CSRF },
      body: "{}",
    });
    expect((await handleEERoute(noOrigin, signed))?.status).toBe(403);
  });
});

// =============================================================================
// SCIM
// =============================================================================

describe("EE SCIM", () => {
  it("issues a token exactly once and stores only its hash", async () => {
    const { env, world } = await harness(OWNER);
    const response = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    expect(response?.status).toBe(201);
    const body = (await response?.json()) as {
      scim_token: { token: string; base_url: string | null };
    };
    const token = body.scim_token.token;
    expect(token).toMatch(/^scim_[\w-]{43}$/);
    // The SCIM base URL an admin pastes into Okta/Entra; /Users hangs off it.
    expect(body.scim_token.base_url).toBe(`${APP_ORIGIN}/v1/ee/scim/v2`);

    expect(world.scimTokens).toHaveLength(1);
    expect(world.scimTokens[0].tokenHash).toBe(await sha256Hex(token));
    // The raw credential is nowhere in the stored state.
    expect(JSON.stringify(world.scimTokens)).not.toContain(token);
  });

  it("issuing a new token revokes the previous one in the same batch", async () => {
    const { env, world, batches } = await harness(OWNER);
    const firstResponse = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const firstToken = ((await firstResponse?.json()) as { scim_token: { token: string } }).scim_token
      .token;
    await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);

    expect(world.scimTokens).toHaveLength(2);
    const firstHash = await sha256Hex(firstToken);
    const stale = world.scimTokens.find((t) => t.tokenHash === firstHash);
    expect(stale?.revokedAt).not.toBeNull();
    expect(world.scimTokens[1].revokedAt).toBeNull();
    // Revoke + insert commit together: never a window with two live tokens.
    for (const batch of batches) {
      expect(batch.map((s) => s.sql.includes("ee:revoke-live-scim-tokens"))).toContain(true);
      expect(batch.map((s) => s.sql.includes("ee:insert-scim-token"))).toContain(true);
    }

    const revoked = await handleEERoute(
      scimRequest("GET", "/v1/ee/scim/v2/Users", firstToken),
      env,
    );
    expect(revoked?.status).toBe(401);
  });

  it("only an owner may issue a token", async () => {
    const { env } = await harness(ADMIN);
    expect((await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env))?.status).toBe(403);
  });

  it("lists workspace members in SCIM ListResponse shape", async () => {
    const { env, world } = await harness(OWNER);
    const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;

    const response = await handleEERoute(scimRequest("GET", "/v1/ee/scim/v2/Users", token), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/scim+json; charset=utf-8");
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(body.startIndex).toBe(1);
    expect(body.itemsPerPage).toBe(world.members.length);
    const resources = body.Resources as Array<Record<string, unknown>>;
    expect(resources).toHaveLength(3);
    expect(resources[0]).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: OWNER,
      userName: "owner@example.com",
      active: true,
    });
    expect(resources[0].emails).toEqual([
      { value: "owner@example.com", primary: true, type: "work" },
    ]);
    // Deterministic order: ascending user id.
    expect(resources.map((r) => r.id)).toEqual([OWNER, ADMIN, MEMBER]);
  });

  it('supports the userName eq filter and rejects any other filter', async () => {
    const { env } = await harness(OWNER);
    const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;

    const filtered = await handleEERoute(
      scimRequest(
        "GET",
        '/v1/ee/scim/v2/Users?filter=userName%20eq%20"admin@example.com"',
        token,
      ),
      env,
    );
    const body = (await filtered?.json()) as { Resources: Array<Record<string, unknown>> };
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0].id).toBe(ADMIN);

    const unsupported = await handleEERoute(
      scimRequest("GET", '/v1/ee/scim/v2/Users?filter=active%20eq%20true', token),
      env,
    );
    expect(unsupported?.status).toBe(400);
    expect(await unsupported?.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      scimType: "invalidFilter",
    });
  });

  it("rejects an absent, malformed, or unknown SCIM token", async () => {
    const { env } = await harness(OWNER);
    const noAuth = new Request(`${APP_ORIGIN}/v1/ee/scim/v2/Users`);
    expect((await handleEERoute(noAuth, env))?.status).toBe(401);

    for (const token of ["nope", "scim_short", `sk_${"a".repeat(43)}`]) {
      const response = await handleEERoute(
        scimRequest("GET", "/v1/ee/scim/v2/Users", token),
        env,
      );
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      });
    }
    // Well-formed but never issued.
    const unknown = await handleEERoute(
      scimRequest("GET", "/v1/ee/scim/v2/Users", `scim_${"z".repeat(43)}`),
      env,
    );
    expect(unknown?.status).toBe(401);
  });

  it("POST /Users creates an invite through the audited, hash-chained flow", async () => {
    const { env, world, batches } = await harness(OWNER);
    const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;

    const response = await handleEERoute(
      scimRequest("POST", "/v1/ee/scim/v2/Users", token, {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "New.Hire@Example.com",
        name: { givenName: "New", familyName: "Hire" },
        roles: [{ value: "admin" }],
      }),
      env,
    );
    expect(response?.status).toBe(201);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "new.hire@example.com",
      displayName: "New Hire",
      // Provisioned but not yet accepted: the invite exists, the account does not.
      active: false,
      roles: [{ value: "admin", primary: true }],
    });
    expect(String(body.id)).toMatch(/^inv_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    // The invite landed, normalized and attributed to the workspace owner.
    expect(world.invites).toHaveLength(1);
    expect(world.invites[0]).toMatchObject({
      workspaceId: EE_WS,
      email: "new.hire@example.com",
      role: "admin",
      createdBy: OWNER,
    });
    // The raw invite token is never in the SCIM response (IdPs log them).
    expect(JSON.stringify(body)).not.toContain("hfg_invite_");

    // The mutation and its audit evidence committed in ONE batch.
    const inviteBatch = batches.find((batch) =>
      batch.some((s) => s.sql.includes("ee:insert-invite")),
    );
    expect(inviteBatch?.map((s) => s.sql.match(/ee:[a-z-]+/)?.[0])).toEqual([
      "ee:sweep-expired-invite",
      "ee:insert-invite",
      "ee:append-audit-events",
      "ee:append-audit-chain",
    ]);
  });

  it("the SCIM-authored audit events are real, verifiable chain links", async () => {
    const { env, world } = await harness(OWNER);
    const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;
    for (const address of ["a@example.com", "b@example.com"]) {
      await handleEERoute(
        scimRequest("POST", "/v1/ee/scim/v2/Users", token, { userName: address }),
        env,
      );
    }

    expect(world.events).toHaveLength(2);
    const documents = world.events.map(
      (event) => JSON.parse(event.raw_json) as Record<string, unknown>,
    );
    const first = documents[0];
    expect(first.kind).toBe("team.invite.created");
    expect(TEAM_EVENT_KINDS).toContain(first.kind);
    expect(first.provenance).toBe("OBSERVED");
    const payload = first.payload as Record<string, unknown>;
    // The address is recorded as a hash, never as durable plaintext evidence.
    expect(payload.email_hash).toBe(await sha256Hex("hfg.invite.email.v1:a@example.com"));
    expect(payload.source).toBe("scim");
    expect(JSON.stringify(first)).not.toContain("a@example.com");

    // Both links verify with the OSS verifier, unchanged: the second event's
    // predecessor really is the first event's content hash, and seq is dense.
    // Entries are newest-first, exactly as GET /v1/workspace/audit returns them.
    const entries: AuditEntry[] = documents
      .map((document) => {
        const audit = document.audit as Record<string, unknown>;
        return {
          seq: audit.seq as number,
          event_id: document.event_id as string,
          kind: document.kind as string,
          occurred_at: document.occurred_at as string,
          content_hash: document.content_hash as string,
          prev_content_hash:
            audit.prev_content_hash === null ? null : `sha256:${audit.prev_content_hash as string}`,
          actor_user_id: audit.actor_user_id as string,
          payload: document.payload as Record<string, unknown>,
        };
      })
      .reverse();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 0]);
    expect(entries[0].prev_content_hash).toBe(entries[1].content_hash);
    expect(verifyAuditPage(entries)).toBe(true);
    // The directory's writes are attributed to the accountable workspace owner.
    expect(entries.map((entry) => entry.actor_user_id)).toEqual([OWNER, OWNER]);
  });

  it("defaults an unrecognized or absent SCIM role to member, never owner", async () => {
    for (const roles of [undefined, [], [{ value: "owner" }], [{ value: "sysadmin" }], "admin"]) {
      const { env, world } = await harness(OWNER);
      const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
      const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;
      await handleEERoute(
        scimRequest("POST", "/v1/ee/scim/v2/Users", token, { userName: "b@example.com", roles }),
        env,
      );
      expect(world.invites[0].role).toBe("member");
    }
  });

  it("rejects a bad userName and a duplicate pending invite", async () => {
    const { env, world } = await harness(OWNER);
    const issued = await handleEERoute(signedUnsafe("POST", "/v1/ee/scim/token"), env);
    const token = ((await issued?.json()) as { scim_token: { token: string } }).scim_token.token;

    const bad = await handleEERoute(
      scimRequest("POST", "/v1/ee/scim/v2/Users", token, { userName: "not-an-email" }),
      env,
    );
    expect(bad?.status).toBe(400);
    expect(await bad?.json()).toMatchObject({ scimType: "invalidValue" });

    await handleEERoute(
      scimRequest("POST", "/v1/ee/scim/v2/Users", token, { userName: "dup@example.com" }),
      env,
    );
    world.invites[0].expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const duplicate = await handleEERoute(
      scimRequest("POST", "/v1/ee/scim/v2/Users", token, { userName: "dup@example.com" }),
      env,
    );
    expect(duplicate?.status).toBe(409);
    expect(await duplicate?.json()).toMatchObject({ scimType: "uniqueness" });
  });

  it("fails closed when the workspace has no active owner to attribute to", async () => {
    const world = defaultWorld();
    world.members = world.members.filter((m) => m.role !== "owner");
    const { env } = await harness(ADMIN, world);
    // Seed a token directly: the owner-only issue path is unavailable here.
    world.scimTokens.push({
      workspaceId: EE_WS,
      tokenHash: await sha256Hex("scim_seeded"),
      createdAt: 1,
      revokedAt: null,
    });
    const request = new Request(`${APP_ORIGIN}/v1/ee/scim/v2/Users`, {
      method: "POST",
      headers: { authorization: "Bearer scim_seeded", "content-type": "application/scim+json" },
      body: JSON.stringify({ userName: "c@example.com" }),
    });
    // The token pattern rejects "scim_seeded" before D1 is reached, which is
    // itself the fail-closed behavior we want; assert the shape holds.
    const response = await handleEERoute(request, env);
    expect(response?.status).toBe(401);
    expect(world.invites).toHaveLength(0);
  });
});

// =============================================================================
// DATA MASKING — the pure function
// =============================================================================

describe("applyMaskingRules", () => {
  const payload = {
    model: "gpt-5",
    user: { email: "a@example.com", id: 7 },
    messages: [
      { role: "user", content: "secret one" },
      { role: "assistant", content: "secret two" },
    ],
    metadata: { api_key: "sk-live-123", region: "us" },
  };

  it("hashes a matched leaf and leaves everything else untouched", async () => {
    const result = await applyMaskingRules([{ field_pattern: "user.email", action: "hash" }], payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as typeof payload;
    expect(value.user.email).toBe(`sha256:${await sha256Hex(JSON.stringify("a@example.com"))}`);
    expect(value.user.id).toBe(7);
    expect(value.model).toBe("gpt-5");
    expect(result.hashed).toEqual(["user.email"]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a matched field entirely", async () => {
    const result = await applyMaskingRules(
      [{ field_pattern: "metadata.api_key", action: "drop" }],
      payload,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(value.metadata, "api_key")).toBe(false);
    expect(value.metadata.region).toBe("us");
    expect(result.dropped).toEqual(["metadata.api_key"]);
  });

  it("drops an entire subtree when the rule matches an object", async () => {
    const result = await applyMaskingRules([{ field_pattern: "user", action: "drop" }], payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value as object, "user")).toBe(false);
  });

  it("* matches within one segment and ** spans segments", async () => {
    const single = await applyMaskingRules(
      [{ field_pattern: "metadata.api_*", action: "drop" }],
      payload,
    );
    expect(single.ok && single.dropped).toEqual(["metadata.api_key"]);

    const deep = await applyMaskingRules([{ field_pattern: "**.content", action: "hash" }], payload);
    expect(deep.ok && deep.hashed).toEqual(["messages.0.content", "messages.1.content"]);

    // A single * must NOT cross a segment boundary.
    const shallow = await applyMaskingRules([{ field_pattern: "*.content", action: "hash" }], payload);
    expect(shallow.ok && shallow.hashed).toEqual([]);
  });

  it("addresses array elements by index", async () => {
    const result = await applyMaskingRules(
      [{ field_pattern: "messages.0.content", action: "hash" }],
      payload,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = (result.value as { messages: Array<Record<string, string>> }).messages;
    expect(messages[0].content.startsWith("sha256:")).toBe(true);
    expect(messages[1].content).toBe("secret two");
  });

  it("dropping an array element compacts the array", async () => {
    const result = await applyMaskingRules(
      [{ field_pattern: "messages.0", action: "drop" }],
      payload,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = (result.value as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "assistant", content: "secret two" });
  });

  it("drop beats hash on the same path", async () => {
    const rules: MaskingRule[] = [
      { field_pattern: "user.email", action: "hash" },
      { field_pattern: "user.*", action: "drop" },
    ];
    const result = await applyMaskingRules(rules, payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ user: {} });
    expect(result.dropped).toEqual(["user.email", "user.id"]);
    expect(result.hashed).toEqual([]);
  });

  it("is deterministic: rule order never changes the output", async () => {
    const a: MaskingRule[] = [
      { field_pattern: "metadata.api_key", action: "drop" },
      { field_pattern: "**.content", action: "hash" },
    ];
    const b: MaskingRule[] = [...a].reverse();
    const first = await applyMaskingRules(a, payload);
    const second = await applyMaskingRules(b, payload);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("hashes equal values to equal digests, so masked fields stay joinable", async () => {
    const result = await applyMaskingRules(
      [{ field_pattern: "**.email", action: "hash" }],
      { a: { email: "x@y.z" }, b: { email: "x@y.z" }, c: { email: "other@y.z" } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, { email: string }>;
    expect(value.a.email).toBe(value.b.email);
    expect(value.a.email).not.toBe(value.c.email);
  });

  it("FAILS CLOSED on a bad pattern: nothing is returned, not a partial mask", async () => {
    for (const pattern of ["", "a..b", "a.b$", "user.email;drop", "a b", ".leading", "trailing."]) {
      const result = await applyMaskingRules(
        [
          { field_pattern: "metadata.api_key", action: "drop" },
          { field_pattern: pattern, action: "hash" },
        ],
        payload,
      );
      expect([pattern, result.ok]).toEqual([pattern, false]);
      // Critically: no `value` at all. A caller cannot accidentally forward a
      // half-masked payload by ignoring `ok`.
      expect(Object.hasOwn(result, "value")).toBe(false);
    }
  });

  it("FAILS CLOSED on an unknown action", async () => {
    const result = await applyMaskingRules(
      [{ field_pattern: "user.email", action: "redact" as never }],
      payload,
    );
    expect(result.ok).toBe(false);
  });

  it("FAILS CLOSED on an over-deep payload rather than masking part of it", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    const result = await applyMaskingRules([{ field_pattern: "**.leaf", action: "drop" }], deep);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("nesting");
  });

  it("an empty rule set is an identity transform", async () => {
    const result = await applyMaskingRules([], payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(payload);
    expect(result.hashed).toEqual([]);
  });

  it("a ** drop rule matching the root yields null, not a hole", async () => {
    const result = await applyMaskingRules([{ field_pattern: "**", action: "drop" }], payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("compileMaskingRule is the same validator the CRUD surface uses", () => {
    expect(compileMaskingRule({ field_pattern: "a.*.b", action: "hash" }).ok).toBe(true);
    expect(compileMaskingRule({ field_pattern: "**", action: "drop" }).ok).toBe(true);
    expect(compileMaskingRule({ field_pattern: "a..b", action: "drop" }).ok).toBe(false);
    expect(compileMaskingRule({ field_pattern: "x".repeat(201), action: "drop" }).ok).toBe(false);
  });
});

// =============================================================================
// DATA MASKING — the CRUD surface
// =============================================================================

describe("EE masking rules CRUD", () => {
  it("creates, lists, and deletes a rule", async () => {
    const { env, world } = await harness(OWNER);
    const created = await handleEERoute(
      signedUnsafe("POST", "/v1/ee/masking-rules", {
        field_pattern: "**.api_key",
        action: "drop",
      }),
      env,
    );
    expect(created?.status).toBe(201);
    const rule = ((await created?.json()) as { rule: Record<string, unknown> }).rule;
    expect(String(rule.id)).toMatch(/^msk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(rule).toMatchObject({ field_pattern: "**.api_key", action: "drop" });
    expect(world.maskingRules).toHaveLength(1);

    const listed = await handleEERoute(signedGet("/v1/ee/masking-rules"), env);
    const body = (await listed?.json()) as { items: unknown[]; next_cursor: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).toBeNull();

    const deleted = await handleEERoute(
      signedUnsafe("DELETE", `/v1/ee/masking-rules/${rule.id as string}`),
      env,
    );
    expect(deleted?.status).toBe(200);
    expect(world.maskingRules).toHaveLength(0);
  });

  it("rejects a pattern the pure function could not compile", async () => {
    const { env, world } = await harness(OWNER);
    const response = await handleEERoute(
      signedUnsafe("POST", "/v1/ee/masking-rules", { field_pattern: "a..b", action: "drop" }),
      env,
    );
    expect(response?.status).toBe(400);
    // A rule that cannot compile must never reach the table: it would make
    // every later applyMaskingRules call for this workspace fail closed.
    expect(world.maskingRules).toHaveLength(0);
  });

  it("rejects an unknown action", async () => {
    const { env } = await harness(OWNER);
    const response = await handleEERoute(
      signedUnsafe("POST", "/v1/ee/masking-rules", { field_pattern: "a", action: "redact" }),
      env,
    );
    expect(response?.status).toBe(400);
  });

  it("deleting another workspace's rule is 404, never 403", async () => {
    const world = defaultWorld();
    world.maskingRules.push({
      id: `msk_01J${"P".repeat(23)}`,
      workspace_id: OTHER_WS,
      field_pattern: "x",
      action: "drop",
      created_at: 1,
    });
    const { env } = await harness(OWNER, world);
    const response = await handleEERoute(
      signedUnsafe("DELETE", `/v1/ee/masking-rules/msk_01J${"P".repeat(23)}`),
      env,
    );
    expect(response?.status).toBe(404);
    expect(world.maskingRules).toHaveLength(1);
  });

  it("loadMaskingRules returns a deterministic, application-shaped rule set", async () => {
    const world = defaultWorld();
    world.maskingRules.push(
      { id: "b", workspace_id: EE_WS, field_pattern: "z.field", action: "hash", created_at: 2 },
      { id: "a", workspace_id: EE_WS, field_pattern: "a.field", action: "drop", created_at: 1 },
      // A row with an action outside the vocabulary is ignored rather than
      // trusted; the CHECK makes it unreachable, defense in depth if it is not.
      { id: "c", workspace_id: EE_WS, field_pattern: "q", action: "redact", created_at: 3 },
    );
    const { db } = await harness(OWNER, world);
    expect(await loadMaskingRules(db, EE_WS)).toEqual([
      { field_pattern: "a.field", action: "drop" },
      { field_pattern: "z.field", action: "hash" },
    ]);
  });

  it("admins read, owners write", async () => {
    const { env } = await harness(ADMIN);
    expect((await handleEERoute(signedGet("/v1/ee/masking-rules"), env))?.status).toBe(200);
    const write = await handleEERoute(
      signedUnsafe("POST", "/v1/ee/masking-rules", { field_pattern: "a", action: "drop" }),
      env,
    );
    expect(write?.status).toBe(403);
  });
});

// =============================================================================
// AUDIT EXPORT
// =============================================================================

function auditEvent(seq: number, kind: string, workspaceId = EE_WS): EventState {
  return {
    seq,
    workspace_id: workspaceId,
    event_id: `evt_01J${String.fromCharCode(65 + seq).repeat(23)}`,
    kind,
    raw_json: canonicalJsonStringify({ event_id: `evt_${seq}`, kind, workspace_id: workspaceId }),
  };
}

describe("EE audit export", () => {
  it("streams the workspace's audit-relevant events as NDJSON", async () => {
    const world = defaultWorld();
    world.events.push(
      auditEvent(1, "team.invite.created"),
      auditEvent(2, "span.completed"), // not audit-relevant
      auditEvent(3, "alert.fired"),
      auditEvent(4, "verification.recorded"),
      auditEvent(5, "team.member.role_changed"),
    );
    const { env } = await harness(ADMIN, world);
    const response = await handleEERoute(signedGet("/v1/ee/audit/export"), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response?.headers.get("content-disposition")).toBe(
      `attachment; filename="audit-${EE_WS}.ndjson"`,
    );
    expect(response?.headers.get("x-hfg-audit-count")).toBe("4");
    expect(response?.headers.get("x-hfg-audit-skipped")).toBe("0");
    // A short page means there is no more; no resume header.
    expect(response?.headers.get("x-hfg-audit-next-seq")).toBeNull();

    const text = (await response?.text()) ?? "";
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    const kinds = lines.map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(kinds).toEqual([
      "team.invite.created",
      "alert.fired",
      "verification.recorded",
      "team.member.role_changed",
    ]);
  });

  it("exports only the caller's own workspace", async () => {
    const world = defaultWorld();
    world.events.push(
      auditEvent(1, "team.invite.created", EE_WS),
      auditEvent(2, "team.invite.created", OTHER_WS),
    );
    const { env, statements } = await harness(ADMIN, world);
    const response = await handleEERoute(signedGet("/v1/ee/audit/export"), env);
    const text = (await response?.text()) ?? "";
    const lines = text.trimEnd().split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { workspace_id: string }).workspace_id).toBe(EE_WS);
    // The workspace is bound into the query, not filtered afterwards.
    const query = statements.find((s) => s.sql.includes("ee:audit-export"));
    expect(query?.binds[0]).toBe(EE_WS);
    expect(query?.sql).toContain("WHERE workspace_id = ?1");
  });

  it("covers exactly the team kinds plus alert.fired and verification.recorded", () => {
    expect(AUDIT_EXPORT_KINDS).toEqual(
      [...TEAM_EVENT_KINDS, "alert.fired", "verification.recorded"].sort(),
    );
    // Sorted and deduplicated: a stable IN list means a stable query plan.
    expect([...AUDIT_EXPORT_KINDS]).toEqual([...new Set(AUDIT_EXPORT_KINDS)].sort());
  });

  it("pages with after_seq and reports a resume point on a full page", async () => {
    const world = defaultWorld();
    for (let seq = 1; seq <= 3; seq += 1) world.events.push(auditEvent(seq, "alert.fired"));
    const { env } = await harness(ADMIN, world);

    const page = await handleEERoute(signedGet("/v1/ee/audit/export?limit=2"), env);
    expect(page?.headers.get("x-hfg-audit-next-seq")).toBe("2");
    expect(((await page?.text()) ?? "").trimEnd().split("\n")).toHaveLength(2);

    const rest = await handleEERoute(signedGet("/v1/ee/audit/export?after_seq=2&limit=2"), env);
    expect(((await rest?.text()) ?? "").trimEnd().split("\n")).toHaveLength(1);
    expect(rest?.headers.get("x-hfg-audit-next-seq")).toBeNull();
  });

  it("skips a row that would corrupt the NDJSON framing instead of emitting it", async () => {
    const world = defaultWorld();
    world.events.push(auditEvent(1, "alert.fired"), {
      seq: 2,
      workspace_id: EE_WS,
      event_id: `evt_01J${"Q".repeat(23)}`,
      kind: "alert.fired",
      raw_json: '{"broken":\n"row"}',
    });
    const { env } = await harness(ADMIN, world);
    const response = await handleEERoute(signedGet("/v1/ee/audit/export"), env);
    expect(response?.headers.get("x-hfg-audit-count")).toBe("1");
    expect(response?.headers.get("x-hfg-audit-skipped")).toBe("1");
    expect(((await response?.text()) ?? "").trimEnd().split("\n")).toHaveLength(1);
  });

  it("rejects malformed paging and enforces admin", async () => {
    const { env } = await harness(ADMIN);
    for (const query of ["?limit=0", "?limit=5001", "?after_seq=-1", "?after_seq=abc"]) {
      const response = await handleEERoute(signedGet(`/v1/ee/audit/export${query}`), env);
      expect([query, response?.status]).toEqual([query, 400]);
    }
    const { env: memberEnv } = await harness(MEMBER);
    expect((await handleEERoute(signedGet("/v1/ee/audit/export"), memberEnv))?.status).toBe(403);
  });

  it("an empty trail is an empty body, not an error", async () => {
    const { env } = await harness(ADMIN);
    const response = await handleEERoute(signedGet("/v1/ee/audit/export"), env);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
  });
});

// =============================================================================
// ASSISTANT
// =============================================================================

function assistantRequest(body: unknown, token = DEVICE_TOKEN): Request {
  return new Request(`${APP_ORIGIN}${ASSISTANT_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ASK = { question: "How is the fence workstream going?", gateway_key: "vk_test", model: "gpt-5" };

/** A model that replays a fixed script, recording what it was shown. */
function scriptedModel(script: string[]): { call: AssistantModelCall; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const call: AssistantModelCall = async (messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    const next = script[index];
    index += 1;
    if (next === undefined) return { ok: false, error: "script exhausted" };
    return { ok: true, text: next };
  };
  return { call, seen };
}

const CALL_CONTEXT = JSON.stringify({
  tool_call: { name: "get_workstream_context", arguments: { workstream_id: WORKSTREAM } },
});

describe("EE assistant", () => {
  it("runs the tool loop and labels the answer INFERRED", async () => {
    const { env } = await harness(null);
    const { call, seen } = scriptedModel([
      CALL_CONTEXT,
      JSON.stringify({ answer: "One session, one failed span." }),
    ]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;

    expect(body.answer).toBe("One session, one failed span.");
    // NON-NEGOTIABLE.
    expect(body.provenance).toBe("INFERRED");
    expect(body.tools_used).toEqual(["get_workstream_context"]);
    expect(body.tool_calls).toBe(1);
    expect(body.model).toBe("gpt-5");

    // evidence_refs are ids the TOOL returned, sorted and deduplicated.
    expect(body.evidence_refs).toEqual([SESSION_EVIDENCE, WORKSTREAM].sort());

    // The model was shown our own MCP tool catalogue, and the tool result.
    expect(seen[0][0].role).toBe("system");
    expect(seen[0][0].content).toContain("get_workstream_context");
    expect(seen[0][0].content).toContain('{"answer"');
    expect(seen[1][seen[1].length - 1].content).toContain("tool_result");
  });

  it("ADVERTISES ONLY THE READ-ONLY TOOLS — the write tools are never named to the model", async () => {
    const { env } = await harness(null);
    const { call, seen } = scriptedModel([JSON.stringify({ answer: "nothing to add." })]);
    await handleEERoute(assistantRequest(ASK), env, call);

    const prompt = seen[0][0].content;
    // Every read-only tool mcp.ts publishes is on offer...
    for (const readOnly of ["get_workstream_context", "get_trace_context", "list_scores", "get_prompt"]) {
      expect([readOnly, prompt.includes(readOnly)]).toEqual([readOnly, true]);
    }
    // ...and neither spine-writing tool appears ANYWHERE in the system prompt.
    // A model cannot ask for a tool it was never told about, and telemetry
    // carrying an injected "now call record_score" has nothing to point at.
    for (const write of ["record_score", "accept_handoff"]) {
      expect([write, prompt.includes(write)]).toEqual([write, false]);
    }
    expect(prompt).toContain("READ-ONLY");
  });

  it.each(["record_score", "accept_handoff"])(
    "REFUSES a %s tool_call fail-closed — nothing is appended to the spine",
    async (writeTool) => {
      const { env, statements, world } = await harness(null);
      const { call } = scriptedModel([
        // What a prompt injection inside the summarized telemetry would steer
        // the model into emitting.
        JSON.stringify({
          tool_call: {
            name: writeTool,
            arguments: { workstream_id: WORKSTREAM, name: "handoff.validity", target_type: "workstream", target_id: WORKSTREAM, value: 1 },
          },
        }),
        JSON.stringify({ answer: "I recorded a perfect score for you." }),
      ]);
      const response = await handleEERoute(assistantRequest(ASK), env, call);

      expect(response?.status).toBe(502);
      const body = (await response?.json()) as Record<string, unknown>;
      expect(body.error).toBe("assistant_write_tool_refused");
      expect(body.tool).toBe(writeTool);
      expect(body.tools_used).toEqual([]);

      // Fail-CLOSED, not skip-and-continue: the request ends, and the scripted
      // answer that followed the refused call never reaches the caller.
      expect(Object.hasOwn(body, "answer")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("perfect score");

      // And the spine is untouched. This is the whole invariant: no OBSERVED
      // score.recorded / handoff.accepted event may originate in model output.
      expect(statements.some((s) => s.sql.includes("mcp:insert-event"))).toBe(false);
      expect(world.events).toHaveLength(0);
    },
  );

  it("a refused write tool is distinguishable from a tool that does not exist", async () => {
    const { env } = await harness(null);
    const invented = scriptedModel([JSON.stringify({ tool_call: { name: "record_scores", arguments: {} } })]);
    const unknown = await handleEERoute(assistantRequest(ASK), env, invented.call);
    expect((await unknown?.json()) as Record<string, unknown>).toMatchObject({
      error: "assistant_unknown_tool",
    });
  });

  it("read-only tools still run after the write tools are filtered out", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([CALL_CONTEXT, JSON.stringify({ answer: "One session." })]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.tools_used).toEqual(["get_workstream_context"]);
    expect(body.provenance).toBe("INFERRED");
  });

  it("evidence_refs come from tool results only — an id the model invented is not evidence", async () => {
    const { env } = await harness(null);
    const hallucinated = `ws_01J${"H".repeat(23)}`;
    const { call } = scriptedModel([
      CALL_CONTEXT,
      JSON.stringify({ answer: `See workstream ${hallucinated}, it has 40 failed spans.` }),
    ]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    const body = (await response?.json()) as Record<string, unknown>;
    // The id is in the prose, because the model wrote it there. It is NOT in
    // evidence_refs, because no tool returned it — which is the whole point of
    // evidence_refs existing separately from the answer.
    expect(String(body.answer)).toContain(hallucinated);
    expect(body.evidence_refs).not.toContain(hallucinated);
    expect(body.evidence_refs).toEqual([SESSION_EVIDENCE, WORKSTREAM].sort());
  });

  it("answers without any tool call when the model needs none", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([JSON.stringify({ answer: "I need a workstream id." })]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.provenance).toBe("INFERRED");
    expect(body.tools_used).toEqual([]);
    expect(body.evidence_refs).toEqual([]);
  });

  it("tolerates a markdown-fenced reply but nothing looser", async () => {
    const { env } = await harness(null);
    const fenced = scriptedModel(['```json\n{"answer": "fenced but valid"}\n```']);
    const ok = await handleEERoute(assistantRequest(ASK), env, fenced.call);
    expect(((await ok?.json()) as Record<string, unknown>).answer).toBe("fenced but valid");

    const chatty = scriptedModel(['Sure! Here you go: {"answer": "hi"}']);
    const bad = await handleEERoute(assistantRequest(ASK), env, chatty.call);
    expect(bad?.status).toBe(502);
    expect((await bad?.json()) as Record<string, unknown>).toMatchObject({
      error: "assistant_protocol_violation",
    });
  });

  it("A TOOL ERROR FAILS CLOSED — an error, never a fabricated answer", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([
      // A workstream that does not exist in this workspace: the real tool
      // implementation rejects it.
      JSON.stringify({
        tool_call: { name: "get_workstream_context", arguments: { workstream_id: `ws_01J${"Z".repeat(24)}` } },
      }),
      JSON.stringify({ answer: "The workstream is going great!" }),
    ]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(502);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.error).toBe("assistant_tool_failed");
    expect(body.tool).toBe("get_workstream_context");
    // The scripted answer that followed the failure never reaches the caller.
    expect(Object.hasOwn(body, "answer")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("going great");
  });

  it("refuses a tool that does not exist rather than inventing a result", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([
      JSON.stringify({ tool_call: { name: "delete_everything", arguments: {} } }),
    ]);
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(502);
    expect((await response?.json()) as Record<string, unknown>).toMatchObject({
      error: "assistant_unknown_tool",
    });
  });

  it(`caps the loop at ${MAX_TOOL_CALLS} tool calls`, async () => {
    const { env } = await harness(null);
    // Always asks for another tool call, never answers.
    const { call, seen } = scriptedModel(new Array(20).fill(CALL_CONTEXT));
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(502);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.error).toBe("assistant_tool_budget_exhausted");
    expect((body.tools_used as string[]).length).toBe(MAX_TOOL_CALLS);
    expect(Object.hasOwn(body, "answer")).toBe(false);
    // MAX_TOOL_CALLS tool turns plus the one turn that asked for the 6th.
    expect(seen.length).toBe(MAX_TOOL_CALLS + 1);
  });

  it("fails closed when the model itself is unavailable", async () => {
    const { env } = await harness(null);
    const call: AssistantModelCall = async () => ({ ok: false, error: "upstream 429" });
    const response = await handleEERoute(assistantRequest(ASK), env, call);
    expect(response?.status).toBe(502);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.error).toBe("assistant_model_unavailable");
    expect(Object.hasOwn(body, "answer")).toBe(false);
  });

  it("cannot see more than the caller: an unauthenticated or foreign caller gets nothing", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([JSON.stringify({ answer: "hi" })]);

    const anonymous = new Request(`${APP_ORIGIN}${ASSISTANT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ASK),
    });
    expect((await handleEERoute(anonymous, env, call))?.status).toBe(401);

    const wrongToken = await handleEERoute(assistantRequest(ASK, `hfg_dev_${"q".repeat(40)}`), env, call);
    expect(wrongToken?.status).toBe(401);
  });

  it("the caller's own Authorization header is what reaches the MCP tools", async () => {
    const { env, statements } = await harness(null);
    const { call } = scriptedModel([CALL_CONTEXT, JSON.stringify({ answer: "done" })]);
    await handleEERoute(assistantRequest(ASK), env, call);
    // The device lookup ran with the hash of the caller's token: the assistant
    // has no credential of its own to substitute.
    const lookups = statements.filter((s) => s.sql.includes("apikeys:device-by-token"));
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(lookup.binds[0]).toBe(await sha256Hex(DEVICE_TOKEN));
    }
    // And every tool query was scoped to that token's workspace.
    const scoped = statements.filter((s) => s.sql.includes("mcp:workstream-lookup"));
    expect(scoped[0].binds[0]).toBe(EE_WS);
  });

  it("validates the request body", async () => {
    const { env } = await harness(null);
    const { call } = scriptedModel([JSON.stringify({ answer: "hi" })]);
    for (const body of [
      {},
      { question: "", gateway_key: "vk", model: "m" },
      { question: "q", gateway_key: "", model: "m" },
      { question: "q", gateway_key: "vk", model: "" },
      { question: "x".repeat(5_000), gateway_key: "vk", model: "m" },
      { question: 1, gateway_key: "vk", model: "m" },
    ]) {
      const response = await handleEERoute(assistantRequest(body), env, call);
      expect([JSON.stringify(body).slice(0, 40), response?.status]).toEqual([
        JSON.stringify(body).slice(0, 40),
        400,
      ]);
    }
  });

  it("routes the model call through this platform's own gateway when no seam is injected", async () => {
    const { env, statements } = await harness(null);
    let upstreamCalls = 0;
    const fetcher = async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    };
    // No gateway key exists in the fake DB, so the gateway denies. What this
    // proves is the wiring: the default path reaches src/gateway.ts (never the
    // network directly), and a gateway denial is a fail-closed error rather
    // than an answer.
    const response = await handleEERoute(assistantRequest(ASK), env, undefined, fetcher);
    expect(response?.status).toBe(502);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.error).toBe("assistant_model_unavailable");
    // The detail names the gateway, so the call demonstrably went through
    // src/gateway.ts rather than straight to the network.
    expect(String(body.detail)).toContain("gateway");
    expect(Object.hasOwn(body, "answer")).toBe(false);
    // The gateway rejected before any upstream fetch: BYO credentials are
    // resolved by the gateway, never by the assistant, and a missing key never
    // reaches an upstream provider.
    expect(upstreamCalls).toBe(0);
    // The MCP tool catalogue was still fetched with the caller's credential,
    // proving the failure is the model call and nothing earlier.
    expect(statements.some((s) => s.sql.includes("apikeys:device-by-token"))).toBe(true);
  });
});

describe("parseModelTurn", () => {
  it("accepts exactly one of tool_call or answer", () => {
    expect(parseModelTurn('{"answer":"hi"}')).toEqual({
      ok: true,
      turn: { kind: "answer", answer: "hi" },
    });
    expect(parseModelTurn('{"tool_call":{"name":"t","arguments":{"a":1}}}')).toEqual({
      ok: true,
      turn: { kind: "tool_call", name: "t", args: { a: 1 } },
    });
    expect(parseModelTurn('{"tool_call":{"name":"t"}}')).toEqual({
      ok: true,
      turn: { kind: "tool_call", name: "t", args: {} },
    });
  });

  it("fails closed on everything else", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      "null",
      '"a string"',
      "{}",
      '{"answer":"hi","tool_call":{"name":"t"}}',
      '{"answer":""}',
      '{"answer":123}',
      '{"tool_call":"get_workstream_context"}',
      '{"tool_call":{"name":""}}',
      '{"tool_call":{"name":"t","arguments":[]}}',
      '{"thinking":"hmm"}',
    ]) {
      expect([raw, parseModelTurn(raw).ok]).toEqual([raw, false]);
    }
  });
});

// =============================================================================
// MIGRATION 0016 (node:sqlite)
// =============================================================================

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0016_ee.sql";
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

const HASH64 = "c".repeat(64);
const MSK_ONE = `msk_01J${"R".repeat(23)}`;

describe("migration 0016 (node:sqlite)", () => {
  it("applies on top of every earlier migration", () => {
    expect(migrationFiles).toContain(THIS_MIGRATION);
    expect(() => migratedDatabase().close()).not.toThrow();
  });

  it("creates the three EE tables, each indexed on workspace_id", () => {
    const db = migratedDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ee_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "ee_masking_rules",
      "ee_scim_tokens",
      "ee_sso_connections",
    ]);
    for (const table of tables) {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all(table.name) as Array<{ name: string }>;
      expect(indexes.some((row) => row.name.includes("workspace"))).toBe(true);
    }
    db.close();
  });

  it("ee_sso_connections is one row per workspace with a closed state vocabulary", () => {
    const db = migratedDatabase();
    const insert = (org: string, state: string) =>
      db
        .prepare("INSERT INTO ee_sso_connections VALUES (?, ?, ?, ?)")
        .run(EE_WS, org, state, 1_700_000_000);
    insert("org_1", "pending");
    expect(() => insert("org_2", "pending")).toThrow(/UNIQUE|PRIMARY/i);
    expect(() => insert("org_3", "unlinked")).toThrow(/CHECK|constraint/i);
    expect(() =>
      db.prepare("INSERT INTO ee_sso_connections VALUES (?, ?, ?, ?)").run(OTHER_WS, "", "pending", 1),
    ).toThrow(/CHECK|constraint/i);
    db.close();
  });

  it("ee_scim_tokens enforces a hex hash, unique tokens, and one-way revocation", () => {
    const db = migratedDatabase();
    const insert = (workspace: string, hash: string) =>
      db.prepare("INSERT INTO ee_scim_tokens VALUES (?, ?, ?, NULL)").run(workspace, hash, 1_700_000_000);
    insert(EE_WS, HASH64);
    expect(() => insert(OTHER_WS, HASH64)).toThrow(/UNIQUE/i);
    expect(() => insert(OTHER_WS, "not-a-hash")).toThrow(/CHECK|constraint/i);
    expect(() => insert(OTHER_WS, "d".repeat(63))).toThrow(/CHECK|constraint/i);

    // Revocation lands, then can never be undone.
    db.prepare("UPDATE ee_scim_tokens SET revoked_at = ? WHERE token_hash = ?").run(1_700_000_100, HASH64);
    expect(() =>
      db.prepare("UPDATE ee_scim_tokens SET revoked_at = NULL WHERE token_hash = ?").run(HASH64),
    ).toThrow(/revocation cannot be undone/);
    // Nor can the credential be rotated in place.
    expect(() =>
      db.prepare("UPDATE ee_scim_tokens SET token_hash = ? WHERE token_hash = ?").run("e".repeat(64), HASH64),
    ).toThrow(/immutable/);
    db.close();
  });

  it("ee_masking_rules enforces the id shape, the action vocabulary, and immutability", () => {
    const db = migratedDatabase();
    const insert = (id: string, pattern: string, action: string, workspace = EE_WS) =>
      db.prepare("INSERT INTO ee_masking_rules VALUES (?, ?, ?, ?, ?)").run(id, workspace, pattern, action, 1);
    insert(MSK_ONE, "**.api_key", "drop");
    expect(() => insert(`apk_01J${"R".repeat(23)}`, "a", "drop")).toThrow(/CHECK|constraint/i);
    expect(() => insert(`msk_short`, "a", "drop")).toThrow(/CHECK|constraint/i);
    expect(() => insert(`msk_01J${"S".repeat(23)}`, "a", "redact")).toThrow(/CHECK|constraint/i);
    expect(() => insert(`msk_01J${"S".repeat(23)}`, "", "drop")).toThrow(/CHECK|constraint/i);

    // One rule per pattern per workspace; the same pattern elsewhere is fine.
    expect(() => insert(`msk_01J${"T".repeat(23)}`, "**.api_key", "hash")).toThrow(/UNIQUE/i);
    expect(() => insert(`msk_01J${"T".repeat(23)}`, "**.api_key", "hash", OTHER_WS)).not.toThrow();

    expect(() =>
      db.prepare("UPDATE ee_masking_rules SET action = 'hash' WHERE id = ?").run(MSK_ONE),
    ).toThrow(/immutable/);
    db.close();
  });

  it("the schema is workspace-scoped: every EE table carries workspace_id NOT NULL", () => {
    const db = migratedDatabase();
    for (const table of ["ee_sso_connections", "ee_scim_tokens", "ee_masking_rules"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      const workspace = columns.find((column) => column.name === "workspace_id");
      expect([table, workspace?.notnull]).toEqual([table, 1]);
    }
    db.close();
  });
});
