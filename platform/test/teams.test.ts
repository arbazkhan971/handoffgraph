import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./advanced_worker";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { EVENT_ID_PATTERN, validateEventBatch } from "../src/ingest";
import {
  TEAM_EVENT_KINDS,
  buildAuditRecords,
  deterministicEventId,
  handleTeamsRoute,
  isInvitableRole,
  meetsRole,
  requireRole,
  verifyAuditPage,
  type AuditEntry,
  type TeamsEnv,
  type WorkspaceRole,
} from "../src/teams";

// -- fixtures -----------------------------------------------------------------

const APP_ORIGIN = "https://api.handoffgraph.dev";
const TEAM_WS = `wsp_01J${"A".repeat(23)}`;
const OTHER_WS = `wsp_01J${"B".repeat(23)}`;
const OWNER = `usr_01J${"C".repeat(23)}`;
const ADMIN = `usr_01J${"D".repeat(23)}`;
const MEMBER = `usr_01J${"E".repeat(23)}`;
const VIEWER = `usr_01J${"F".repeat(23)}`;
const OUTSIDER = `usr_01J${"G".repeat(23)}`;
const TARGET = `usr_01J${"J".repeat(23)}`;
const INVITE_ID = `inv_01J${"H".repeat(23)}`;
const CSRF = "csrf-token-with-at-least-thirty-two-bytes";
const SESSION_COOKIE_VALUE = `hfg_session_${"x".repeat(40)}`;
const HEALTHY_DELETION_LEDGER = {
  async head() {
    return null;
  },
};
type TeamsTestEnv = TeamsEnv & { BODIES: typeof HEALTHY_DELETION_LEDGER };

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

interface MemberState {
  workspaceId: string;
  userId: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "removed";
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
  acceptedAt: number | null;
  acceptedBy: string | null;
  revokedAt: number | null;
}

interface World {
  members: MemberState[];
  invites: InviteState[];
  head: { seq: number; content_hash: string } | null;
  audit: Array<Record<string, unknown>>;
  /** Error thrown by the next db.batch call, consumed once. */
  failNextBatch?: string;
}

function member(
  userId: string,
  role: WorkspaceRole,
  overrides: Partial<MemberState> = {},
): MemberState {
  return {
    workspaceId: TEAM_WS,
    userId,
    email: `${role}@example.com`,
    role,
    status: "active",
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

function defaultWorld(): World {
  return {
    members: [
      member(OWNER, "owner", { email: "owner@example.com", createdAt: 1_700_000_004 }),
      member(ADMIN, "admin", { email: "admin@example.com", createdAt: 1_700_000_003 }),
      member(MEMBER, "member", { email: "member@example.com", createdAt: 1_700_000_002 }),
      member(VIEWER, "viewer", { email: "viewer@example.com", createdAt: 1_700_000_001 }),
    ],
    invites: [],
    head: null,
    audit: [],
  };
}

function sessionRowFor(userId: string, csrfHash: string, world: World) {
  const self = world.members.find((row) => row.userId === userId);
  return {
    session_id: `acs_01J${"Z".repeat(23)}`,
    user_id: userId,
    csrf_hash: csrfHash,
    email: self?.email ?? "outsider@example.com",
    display_name: null,
    avatar_url: null,
    // The session always resolves the caller's own personal workspace; team
    // routes address other workspaces through workspace_id.
    workspace_id: userId === OUTSIDER ? OTHER_WS : TEAM_WS,
    workspace_name: "Team workspace",
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
 * Fake D1 that answers on the SQL marker comments the module pins, mutates a
 * tiny in-memory world on commit, and records every statement and batch.
 */
function teamDb(world: World, csrfHash: string, sessionUser: string | null) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];

  const first = (statement: RecordedStatement): unknown => {
    const { sql, binds } = statement;
    if (sql.includes("FROM account_sessions")) {
      return sessionUser === null ? null : sessionRowFor(sessionUser, csrfHash, world);
    }
    if (sql.includes("teams:read-membership")) {
      const row = world.members.find(
        (entry) =>
          entry.workspaceId === binds[0] && entry.userId === binds[1] && entry.status === "active",
      );
      return row === undefined
        ? null
        : { workspace_id: row.workspaceId, role: row.role, workspace_name: "Team workspace" };
    }
    if (sql.includes("teams:read-member")) {
      const row = world.members.find(
        (entry) => entry.workspaceId === binds[0] && entry.userId === binds[1],
      );
      return row === undefined
        ? null
        : {
            workspace_id: row.workspaceId,
            user_id: row.userId,
            role: row.role,
            status: row.status,
          };
    }
    if (sql.includes("teams:count-owners")) {
      return {
        owners: world.members.filter(
          (entry) =>
            entry.workspaceId === binds[0] && entry.role === "owner" && entry.status === "active",
        ).length,
      };
    }
    if (sql.includes("teams:read-audit-head")) return world.head;
    if (sql.includes("teams:read-live-invite")) {
      const row = world.invites.find(
        (entry) =>
          entry.workspaceId === binds[0] &&
          entry.email === binds[1] &&
          entry.acceptedAt === null &&
          entry.revokedAt === null,
      );
      return row === undefined ? null : { id: row.id, expires_at: row.expiresAt };
    }
    if (sql.includes("teams:read-invite-by-id")) {
      const row = world.invites.find(
        (entry) => entry.id === binds[0] && entry.workspaceId === binds[1],
      );
      return row === undefined
        ? null
        : {
            id: row.id,
            workspace_id: row.workspaceId,
            email: row.email,
            role: row.role,
            expires_at: row.expiresAt,
            accepted_at: row.acceptedAt,
            revoked_at: row.revokedAt,
          };
    }
    if (sql.includes("teams:read-invite-by-token")) {
      const row = world.invites.find((entry) => entry.tokenHash === binds[0]);
      return row === undefined
        ? null
        : {
            id: row.id,
            workspace_id: row.workspaceId,
            email: row.email,
            role: row.role,
            expires_at: row.expiresAt,
            accepted_at: row.acceptedAt,
            accepted_by: row.acceptedBy,
            revoked_at: row.revokedAt,
            workspace_name: "Team workspace",
          };
    }
    return null;
  };

  const all = (statement: RecordedStatement): unknown[] => {
    const { sql, binds } = statement;
    if (sql.includes("teams:list-members")) {
      return world.members
        .filter((entry) => entry.workspaceId === binds[0] && entry.status === "active")
        .map((entry) => ({
          user_id: entry.userId,
          role: entry.role,
          created_at: entry.createdAt,
          email: entry.email,
          display_name: null,
        }));
    }
    if (sql.includes("teams:list-workspaces")) {
      return world.members
        .filter((entry) => entry.userId === binds[0] && entry.status === "active")
        .map((entry) => ({
          workspace_id: entry.workspaceId,
          role: entry.role,
          created_at: entry.createdAt,
          workspace_name: "Team workspace",
          member_count: world.members.filter(
            (peer) => peer.workspaceId === entry.workspaceId && peer.status === "active",
          ).length,
        }));
    }
    if (sql.includes("teams:list-invites")) {
      return world.invites
        .filter(
          (entry) =>
            entry.workspaceId === binds[0] &&
            entry.acceptedAt === null &&
            entry.revokedAt === null &&
            entry.expiresAt > Number(binds[1]),
        )
        .map((entry) => ({
          id: entry.id,
          email: entry.email,
          role: entry.role,
          created_at: entry.createdAt,
          expires_at: entry.expiresAt,
          created_by: entry.createdBy,
        }));
    }
    if (sql.includes("teams:list-audit")) {
      return world.audit.filter((row) => row.workspace_id === binds[0]).map((row) => ({ ...row }));
    }
    return [];
  };

  const applyBatch = (recorded: RecordedStatement[]): void => {
    for (const statement of recorded) {
      const { sql, binds } = statement;
      if (sql.includes("teams:insert-invite")) {
        world.invites.push({
          id: String(binds[0]),
          workspaceId: String(binds[1]),
          email: String(binds[2]),
          role: String(binds[3]),
          tokenHash: String(binds[4]),
          createdBy: String(binds[5]),
          createdAt: Number(binds[6]),
          expiresAt: Number(binds[7]),
          acceptedAt: null,
          acceptedBy: null,
          revokedAt: null,
        });
      }
      if (sql.includes("teams:revoke-invite")) {
        const invite = world.invites.find((entry) => entry.id === binds[0]);
        if (invite !== undefined) invite.revokedAt = Number(binds[2]);
      }
      if (sql.includes("teams:accept-invite")) {
        const invite = world.invites.find((entry) => entry.id === binds[0]);
        if (invite !== undefined) {
          invite.acceptedAt = Number(binds[2]);
          invite.acceptedBy = String(binds[3]);
        }
      }
      if (sql.includes("teams:upsert-member")) {
        const existing = world.members.find(
          (entry) => entry.workspaceId === binds[0] && entry.userId === binds[1],
        );
        if (existing === undefined) {
          world.members.push({
            workspaceId: String(binds[0]),
            userId: String(binds[1]),
            email: "joiner@example.com",
            role: String(binds[2]) as WorkspaceRole,
            status: "active",
            createdAt: Number(binds[3]),
          });
        } else {
          existing.status = "active";
          if (existing.role !== "owner") existing.role = String(binds[2]) as WorkspaceRole;
        }
      }
      if (sql.includes("teams:update-member-role")) {
        const existing = world.members.find(
          (entry) => entry.workspaceId === binds[0] && entry.userId === binds[1],
        );
        if (existing !== undefined && existing.role === binds[2]) {
          existing.role = String(binds[3]) as WorkspaceRole;
        }
      }
      if (sql.includes("teams:remove-member")) {
        const existing = world.members.find(
          (entry) => entry.workspaceId === binds[0] && entry.userId === binds[1],
        );
        if (existing !== undefined && existing.role === binds[2]) existing.status = "removed";
      }
      if (sql.includes("teams:append-audit-chain")) {
        const links = JSON.parse(String(binds[2])) as Array<{
          seq: number;
          event_id: string;
          content_hash: string;
          prev_hash: string | null;
        }>;
        for (const link of links) {
          world.head = { seq: link.seq, content_hash: link.content_hash };
        }
      }
      if (sql.includes("teams:append-audit-events")) {
        const documents = JSON.parse(String(binds[2])) as Array<Record<string, unknown>>;
        for (const document of documents) {
          const audit = document.audit as { seq: number; prev_content_hash: string | null };
          world.audit.unshift({
            workspace_id: String(binds[0]),
            seq: audit.seq,
            event_id: String(document.event_id),
            content_hash: String(document.content_hash).slice("sha256:".length),
            prev_hash: audit.prev_content_hash,
            created_at: Number(binds[1]),
            kind: String(document.kind),
            occurred_at: String(document.occurred_at),
            raw_json: JSON.stringify(document),
          });
        }
      }
    }
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
          return (first(statement) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: all(statement) as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded);
      if (world.failNextBatch !== undefined) {
        const message = world.failNextBatch;
        world.failNextBatch = undefined;
        throw new Error(message);
      }
      applyBatch(recorded);
      return [];
    },
  };
  return { db, statements, batches };
}

async function envFor(
  world: World,
  sessionUser: string | null,
): Promise<{ env: TeamsTestEnv; batches: RecordedStatement[][]; statements: RecordedStatement[] }> {
  const csrfHash = await sha256Hex(CSRF);
  const { db, batches, statements } = teamDb(world, csrfHash, sessionUser);
  return {
    env: {
      DB: db,
      BODIES: HEALTHY_DELETION_LEDGER,
      APP_ORIGIN,
      LANDING_ORIGIN: "https://handoffgraph.dev",
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test",
      WORKOS_REDIRECT_URI: `${APP_ORIGIN}/v1/auth/callback`,
    },
    batches,
    statements,
  };
}

function get(path: string, signedIn = true): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    headers: signedIn ? { cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}` } : {},
  });
}

function post(path: string, body: unknown, overrides: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}`,
      origin: APP_ORIGIN,
      "x-csrf-token": CSRF,
      "content-type": "application/json",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

async function callAs(
  user: string | null,
  request: Request,
  world: World = defaultWorld(),
): Promise<{ response: Response; body: Record<string, unknown>; batches: RecordedStatement[][]; world: World }> {
  const { env, batches } = await envFor(world, user);
  const response = await handleTeamsRoute(request, env);
  if (response === null) throw new Error(`route not owned: ${request.method} ${request.url}`);
  const body = (await response.clone().json()) as Record<string, unknown>;
  return { response, body, batches, world };
}

function auditKinds(batches: RecordedStatement[][]): string[] {
  const kinds: string[] = [];
  for (const batch of batches) {
    for (const statement of batch) {
      if (!statement.sql.includes("teams:append-audit-events")) continue;
      const documents = JSON.parse(String(statement.binds[2])) as Array<{ kind: string }>;
      for (const document of documents) kinds.push(document.kind);
    }
  }
  return kinds;
}

afterEach(() => {
  vi.useRealTimers();
});

// -- role model ---------------------------------------------------------------

describe("workspace role ordering", () => {
  it("ranks owner > admin > member > viewer", () => {
    const ranked: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
    for (let higher = 0; higher < ranked.length; higher += 1) {
      for (let lower = higher; lower < ranked.length; lower += 1) {
        expect(meetsRole(ranked[higher], ranked[lower])).toBe(true);
      }
      for (let above = 0; above < higher; above += 1) {
        expect(meetsRole(ranked[higher], ranked[above])).toBe(false);
      }
    }
  });

  it("never treats owner as an invitable role", () => {
    expect(isInvitableRole("owner")).toBe(false);
    expect(isInvitableRole("admin")).toBe(true);
    expect(isInvitableRole("root")).toBe(false);
    expect(isInvitableRole(undefined)).toBe(false);
  });
});

describe("requireRole", () => {
  it("answers 404 for a workspace the user is not a member of", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, OUTSIDER);
    const check = await requireRole(env.DB, TEAM_WS, OUTSIDER, "viewer");
    expect(check).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("answers 403 for a member whose role is below the minimum", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, VIEWER);
    const check = await requireRole(env.DB, TEAM_WS, VIEWER, "admin");
    expect(check).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("rejects a malformed workspace or user id without querying", async () => {
    const world = defaultWorld();
    const { env, statements } = await envFor(world, OWNER);
    expect(await requireRole(env.DB, "wsp_nope", OWNER, "viewer")).toMatchObject({ status: 404 });
    expect(await requireRole(env.DB, TEAM_WS, "usr_nope", "viewer")).toMatchObject({ status: 404 });
    expect(statements).toHaveLength(0);
  });
});

// -- audit spine --------------------------------------------------------------

describe("audit event construction", () => {
  const input = {
    kind: "team.member.added" as const,
    actorUserId: OWNER,
    payload: { target_user_id: MEMBER, role: "member" },
  };

  it("derives a deterministic ULID-shaped event id from the evidence", async () => {
    const first = await buildAuditRecords(TEAM_WS, null, [input], 1_800_000_000_000);
    const again = await buildAuditRecords(TEAM_WS, null, [input], 1_800_000_000_000);
    expect(first).toEqual(again);
    expect(first[0].eventId).toMatch(EVENT_ID_PATTERN);
    expect(first[0].eventId).toHaveLength(30);
    expect(first[0].contentHash).toMatch(/^[0-9a-f]{64}$/);

    const later = await buildAuditRecords(TEAM_WS, null, [input], 1_800_000_001_000);
    expect(later[0].eventId).not.toBe(first[0].eventId);
    // ULID time prefix keeps ids lexically ordered by when they happened.
    expect(later[0].eventId > first[0].eventId).toBe(true);

    const elsewhere = await buildAuditRecords(OTHER_WS, null, [input], 1_800_000_000_000);
    expect(elsewhere[0].eventId).not.toBe(first[0].eventId);
    expect(deterministicEventId(1_800_000_000_000, first[0].contentHash)).toBe(first[0].eventId);
  });

  it("links each record to its predecessor and continues from the stored head", async () => {
    const records = await buildAuditRecords(
      TEAM_WS,
      null,
      [input, { ...input, kind: "team.member.role_changed" }],
      1_800_000_000_000,
    );
    expect(records[0].seq).toBe(0);
    expect(records[0].prevHash).toBeNull();
    expect(records[1].seq).toBe(1);
    expect(records[1].prevHash).toBe(records[0].contentHash);

    const continued = await buildAuditRecords(
      TEAM_WS,
      { seq: 7, contentHash: "a".repeat(64) },
      [input],
      1_800_000_000_000,
    );
    expect(continued[0].seq).toBe(8);
    expect(continued[0].prevHash).toBe("a".repeat(64));
  });

  it("emits protocol-valid OBSERVED evidence", async () => {
    const records = await buildAuditRecords(TEAM_WS, null, [input], 1_800_000_000_000);
    const validation = validateEventBatch(
      { schema_version: "hfg.event-batch.v1", events: [records[0].document] },
      TEAM_WS,
      { requireRedactionAttestation: false },
    );
    expect(validation.ok).toBe(true);
    expect(records[0].document).toMatchObject({
      provenance: "OBSERVED",
      kind: "team.member.added",
      workspace_id: TEAM_WS,
      content_hash: `sha256:${records[0].contentHash}`,
    });
    for (const kind of TEAM_EVENT_KINDS) expect(kind.length).toBeLessThanOrEqual(64);
  });

  it("detects a rewritten link when verifying a page", () => {
    const page: AuditEntry[] = [
      {
        seq: 1,
        event_id: `evt_01J${"A".repeat(23)}`,
        kind: "team.member.added",
        occurred_at: "2026-01-01T00:00:00.000Z",
        content_hash: `sha256:${"b".repeat(64)}`,
        prev_content_hash: `sha256:${"a".repeat(64)}`,
        actor_user_id: OWNER,
        payload: {},
      },
      {
        seq: 0,
        event_id: `evt_01J${"B".repeat(23)}`,
        kind: "team.invite.created",
        occurred_at: "2026-01-01T00:00:00.000Z",
        content_hash: `sha256:${"a".repeat(64)}`,
        prev_content_hash: null,
        actor_user_id: OWNER,
        payload: {},
      },
    ];
    expect(verifyAuditPage(page)).toBe(true);
    expect(verifyAuditPage([{ ...page[0], prev_content_hash: `sha256:${"c".repeat(64)}` }, page[1]]))
      .toBe(false);
    expect(verifyAuditPage([page[0], { ...page[1], seq: 5 }])).toBe(false);
    expect(verifyAuditPage([{ ...page[1], prev_content_hash: `sha256:${"a".repeat(64)}` }]))
      .toBe(false);
  });
});

// -- authentication and CSRF --------------------------------------------------

describe("account-plane gating", () => {
  it("requires a session for every team route", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, null);
    for (const request of [
      get("/v1/workspace/members", false),
      get("/v1/workspace/invites", false),
      get("/v1/workspace/audit", false),
      get("/v1/workspaces", false),
    ]) {
      const response = await handleTeamsRoute(request, env);
      expect(response?.status).toBe(401);
    }
  });

  it("requires exact same-origin and a matching CSRF token to mutate", async () => {
    const world = defaultWorld();
    const { env, batches } = await envFor(world, OWNER);
    const noOrigin = await handleTeamsRoute(
      new Request(`${APP_ORIGIN}/v1/workspace/invites`, {
        method: "POST",
        headers: { cookie: `__Host-hfg_session=${SESSION_COOKIE_VALUE}` },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      env,
    );
    expect(noOrigin?.status).toBe(403);
    const badCsrf = await handleTeamsRoute(
      post("/v1/workspace/invites", { email: "new@example.com" }, { "x-csrf-token": "nope" }),
      env,
    );
    expect(badCsrf?.status).toBe(403);
    expect(await badCsrf?.json()).toEqual({ error: "invalid_csrf" });
    const foreignOrigin = await handleTeamsRoute(
      post("/v1/workspace/invites", { email: "new@example.com" }, { origin: "https://evil.test" }),
      env,
    );
    expect(foreignOrigin?.status).toBe(403);
    expect(batches).toHaveLength(0);
  });

  it("leaves unknown paths and wrong methods to the shared 404", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, OWNER);
    expect(await handleTeamsRoute(get("/v1/workstreams"), env)).toBeNull();
    expect(await handleTeamsRoute(get("/v1/workspace/invites/accept"), env)).toBeNull();
    expect(
      await handleTeamsRoute(post("/v1/workspace/members", {}), env),
    ).toBeNull();
  });
});

// -- role matrix --------------------------------------------------------------

describe("role matrix", () => {
  const cases: Array<{
    name: string;
    request: () => Request;
    allowed: WorkspaceRole[];
  }> = [
    {
      name: "GET /v1/workspace/members",
      request: () => get("/v1/workspace/members"),
      allowed: ["owner", "admin", "member", "viewer"],
    },
    {
      name: "GET /v1/workspace/invites",
      request: () => get("/v1/workspace/invites"),
      allowed: ["owner", "admin"],
    },
    {
      name: "GET /v1/workspace/audit",
      request: () => get("/v1/workspace/audit"),
      allowed: ["owner", "admin"],
    },
    {
      name: "POST /v1/workspace/invites",
      request: () => post("/v1/workspace/invites", { email: "new@example.com", role: "member" }),
      allowed: ["owner", "admin"],
    },
    {
      name: "POST /v1/workspace/invites/revoke",
      request: () => post("/v1/workspace/invites/revoke", { invite_id: INVITE_ID }),
      allowed: ["owner", "admin"],
    },
    {
      name: "POST /v1/workspace/members/role",
      request: () => post("/v1/workspace/members/role", { user_id: TARGET, role: "viewer" }),
      allowed: ["owner", "admin"],
    },
    {
      name: "POST /v1/workspace/members/remove",
      request: () => post("/v1/workspace/members/remove", { user_id: TARGET }),
      allowed: ["owner", "admin"],
    },
  ];

  const actors: Array<[WorkspaceRole, string]> = [
    ["owner", OWNER],
    ["admin", ADMIN],
    ["member", MEMBER],
    ["viewer", VIEWER],
  ];

  for (const testCase of cases) {
    it(`enforces ${testCase.name} for every role`, async () => {
      for (const [role, userId] of actors) {
        const world = defaultWorld();
        // A target nobody in the matrix is, so every answer is about authority
        // rather than about the self-leave allowance.
        world.members.push(member(TARGET, "member", { email: "target@example.com" }));
        world.invites.push({
          id: INVITE_ID,
          workspaceId: TEAM_WS,
          email: "pending@example.com",
          role: "member",
          tokenHash: "f".repeat(64),
          createdBy: OWNER,
          createdAt: 1_700_000_000,
          expiresAt: 4_000_000_000,
          acceptedAt: null,
          acceptedBy: null,
          revokedAt: null,
        });
        const { response } = await callAs(userId, testCase.request(), world);
        if (testCase.allowed.includes(role)) {
          expect([200, 201]).toContain(response.status);
        } else {
          expect(response.status).toBe(403);
        }
      }
    });
  }

  it("never discloses a workspace the caller does not belong to", async () => {
    const world = defaultWorld();
    for (const request of [
      get(`/v1/workspace/members?workspace_id=${TEAM_WS}`),
      get(`/v1/workspace/invites?workspace_id=${TEAM_WS}`),
      get(`/v1/workspace/audit?workspace_id=${TEAM_WS}`),
    ]) {
      const { response, body } = await callAs(OUTSIDER, request, world);
      expect(response.status).toBe(404);
      expect(body).toEqual({ error: "not found" });
    }
    const mutation = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites", { workspace_id: TEAM_WS, email: "x@example.com" }),
      world,
    );
    expect(mutation.response.status).toBe(404);
    expect(mutation.batches).toHaveLength(0);
  });

  it("addresses a joined workspace explicitly and defaults to the personal one", async () => {
    const world = defaultWorld();
    world.members.push(
      member(OUTSIDER, "member", { workspaceId: OTHER_WS, email: "outsider@example.com" }),
    );
    const joined = await callAs(
      OUTSIDER,
      get(`/v1/workspace/members?workspace_id=${OTHER_WS}`),
      world,
    );
    expect(joined.response.status).toBe(200);
    const defaulted = await callAs(OUTSIDER, get("/v1/workspace/members"), world);
    expect(defaulted.response.status).toBe(200);
    const malformed = await callAs(
      OUTSIDER,
      get("/v1/workspace/members?workspace_id=not-a-workspace"),
      world,
    );
    expect(malformed.response.status).toBe(404);
  });
});

// -- listing ------------------------------------------------------------------

describe("member and workspace listings", () => {
  it("returns a deterministic envelope with roles", async () => {
    const { response, body } = await callAs(VIEWER, get("/v1/workspace/members"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.role)).toEqual(["owner", "admin", "member", "viewer"]);
    expect(items[3]).toMatchObject({ user_id: VIEWER, is_self: true });
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("emits a cursor when more members exist than the page limit", async () => {
    const { body } = await callAs(OWNER, get("/v1/workspace/members?limit=2"));
    expect((body.items as unknown[]).length).toBe(2);
    expect(typeof body.next_cursor).toBe("string");
  });

  it("rejects an invalid page limit", async () => {
    const { response } = await callAs(OWNER, get("/v1/workspace/members?limit=9999"));
    expect(response.status).toBe(400);
  });

  it("lists the workspaces a user belongs to with their role", async () => {
    const world = defaultWorld();
    world.members.push(
      member(MEMBER, "owner", { workspaceId: OTHER_WS, createdAt: 1_700_000_500 }),
    );
    const { body } = await callAs(MEMBER, get("/v1/workspaces"), world);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ workspace_id: OTHER_WS, role: "owner" });
    expect(items[1]).toMatchObject({ workspace_id: TEAM_WS, role: "member", is_personal: true });
  });
});

// -- invite lifecycle ---------------------------------------------------------

describe("invite lifecycle", () => {
  it("returns the token once, persists only its hash, and audits the creation", async () => {
    const world = defaultWorld();
    const { response, body, batches } = await callAs(
      OWNER,
      post("/v1/workspace/invites", { email: " New.Person@Example.COM ", role: "admin" }),
      world,
    );
    expect(response.status).toBe(201);
    const invite = body.invite as Record<string, string>;
    expect(invite.token).toMatch(/^hfg_invite_[\w-]{43}$/);
    expect(invite.email).toBe("new.person@example.com");
    expect(invite.role).toBe("admin");
    expect(invite.invite_url).toBe(
      `${APP_ORIGIN}/account?invite=${encodeURIComponent(invite.token)}`,
    );
    expect(body.warning).toContain("cannot be shown again");

    const written = JSON.stringify(batches);
    expect(written).not.toContain(invite.token);
    expect(written).toContain(await sha256Hex(invite.token));
    expect(world.invites[0].tokenHash).toBe(await sha256Hex(invite.token));
    expect(auditKinds(batches)).toEqual(["team.invite.created"]);

    const documents = JSON.parse(
      String(
        batches[0].find((statement) => statement.sql.includes("teams:append-audit-events"))?.binds[2],
      ),
    ) as Array<{ payload: Record<string, unknown> }>;
    expect(documents[0].payload).toMatchObject({ role: "admin" });
    expect(documents[0].payload.email_hash).toMatch(/^[0-9a-f]{64}$/);
    // The immutable spine records who was invited without copying the address.
    expect(JSON.stringify(documents[0].payload)).not.toContain("new.person@example.com");
  });

  it("sweeps an expired invite in the same transaction as the replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const world = defaultWorld();
    const { response, batches } = await callAs(
      OWNER,
      post("/v1/workspace/invites", { email: "again@example.com" }),
      world,
    );
    expect(response.status).toBe(201);
    const sql = batches[0].map((statement) => statement.sql).join("\n");
    expect(sql).toContain("teams:sweep-expired-invite");
    expect(sql.indexOf("teams:sweep-expired-invite")).toBeLessThan(
      sql.indexOf("teams:insert-invite"),
    );
    expect(sql.indexOf("teams:append-audit-events")).toBeLessThan(
      sql.indexOf("teams:append-audit-chain"),
    );
  });

  it("refuses a second live invite for the same address", async () => {
    const world = defaultWorld();
    await callAs(OWNER, post("/v1/workspace/invites", { email: "dup@example.com" }), world);
    const { response, body } = await callAs(
      ADMIN,
      post("/v1/workspace/invites", { email: "DUP@example.com" }),
      world,
    );
    expect(response.status).toBe(409);
    expect(body.error).toBe("invite_pending");
    expect(world.invites).toHaveLength(1);
  });

  it("validates the address and refuses to invite an owner", async () => {
    const world = defaultWorld();
    for (const email of ["nope", "a b@example.com", "", "a@example", "x".repeat(300)]) {
      const { response } = await callAs(
        OWNER,
        post("/v1/workspace/invites", { email }),
        world,
      );
      expect(response.status).toBe(400);
    }
    const owner = await callAs(
      OWNER,
      post("/v1/workspace/invites", { email: "boss@example.com", role: "owner" }),
      world,
    );
    expect(owner.response.status).toBe(400);
    expect(world.invites).toHaveLength(0);
  });

  it("revokes a pending invite once and audits it", async () => {
    const world = defaultWorld();
    const created = await callAs(
      OWNER,
      post("/v1/workspace/invites", { email: "gone@example.com" }),
      world,
    );
    const inviteId = (created.body.invite as { id: string }).id;
    const revoked = await callAs(
      ADMIN,
      post("/v1/workspace/invites/revoke", { invite_id: inviteId }),
      world,
    );
    expect(revoked.response.status).toBe(200);
    expect(auditKinds(revoked.batches)).toEqual(["team.invite.revoked"]);
    expect(world.invites[0].revokedAt).not.toBeNull();

    const again = await callAs(
      ADMIN,
      post("/v1/workspace/invites/revoke", { invite_id: inviteId }),
      world,
    );
    expect(again.response.status).toBe(409);
    expect(again.body.error).toBe("invite_not_pending");

    const unknown = await callAs(
      OWNER,
      post("/v1/workspace/invites/revoke", { invite_id: `inv_01J${"Z".repeat(23)}` }),
      world,
    );
    expect(unknown.response.status).toBe(404);
  });

  it("lists only live invites without leaking the hash", async () => {
    const world = defaultWorld();
    await callAs(OWNER, post("/v1/workspace/invites", { email: "live@example.com" }), world);
    world.invites.push({
      id: `inv_01J${"Y".repeat(23)}`,
      workspaceId: TEAM_WS,
      email: "old@example.com",
      role: "member",
      tokenHash: "a".repeat(64),
      createdBy: OWNER,
      createdAt: 1,
      expiresAt: 2,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
    });
    const { body } = await callAs(ADMIN, get("/v1/workspace/invites"), world);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ email: "live@example.com", status: "pending" });
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });
});

describe("invite acceptance", () => {
  async function seedInvite(
    world: World,
    token: string,
    overrides: Partial<InviteState> = {},
  ): Promise<void> {
    world.invites.push({
      id: INVITE_ID,
      workspaceId: TEAM_WS,
      email: "outsider@example.com",
      role: "member",
      tokenHash: await sha256Hex(token),
      createdBy: OWNER,
      createdAt: 1_700_000_000,
      expiresAt: 4_000_000_000,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
      ...overrides,
    });
  }

  const TOKEN = `hfg_invite_${"a".repeat(43)}`;

  it("joins the invited workspace at the invited role and audits both facts", async () => {
    const world = defaultWorld();
    await seedInvite(world, TOKEN);
    const { response, body, batches } = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      world,
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspace: { id: TEAM_WS },
      role: "member",
      already_member: false,
    });
    expect(auditKinds(batches)).toEqual(["team.invite.accepted", "team.member.added"]);
    const joined = world.members.find((entry) => entry.userId === OUTSIDER);
    expect(joined).toMatchObject({ workspaceId: TEAM_WS, role: "member", status: "active" });
    expect(world.invites[0].acceptedBy).toBe(OUTSIDER);
    expect(JSON.stringify(batches)).not.toContain(TOKEN);
  });

  it("is idempotent for the accepting user and invisible to anyone else", async () => {
    const world = defaultWorld();
    await seedInvite(world, TOKEN);
    await callAs(OUTSIDER, post("/v1/workspace/invites/accept", { token: TOKEN }), world);
    const replay = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      world,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ already_member: true, role: "member" });
    expect(replay.batches).toHaveLength(0);

    const stranger = await callAs(
      MEMBER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      world,
    );
    expect(stranger.response.status).toBe(404);
  });

  it("rejects an expired, revoked, unknown, or forwarded invite", async () => {
    const expiredWorld = defaultWorld();
    await seedInvite(expiredWorld, TOKEN, { expiresAt: 1_700_000_100 });
    const expired = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      expiredWorld,
    );
    expect(expired.response.status).toBe(403);
    expect(expired.body.error).toBe("invite_expired");
    expect(expired.batches).toHaveLength(0);

    const revokedWorld = defaultWorld();
    await seedInvite(revokedWorld, TOKEN, { revokedAt: 1_700_000_100 });
    const revoked = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      revokedWorld,
    );
    expect(revoked.response.status).toBe(404);

    const mismatchWorld = defaultWorld();
    await seedInvite(mismatchWorld, TOKEN, { email: "someone.else@example.com" });
    const mismatch = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      mismatchWorld,
    );
    expect(mismatch.response.status).toBe(403);
    expect(mismatch.body.error).toBe("invite_email_mismatch");

    const unknown = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: `hfg_invite_${"z".repeat(43)}` }),
      defaultWorld(),
    );
    expect(unknown.response.status).toBe(404);

    const malformed = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: "not-a-token" }),
      defaultWorld(),
    );
    expect(malformed.response.status).toBe(404);
  });

  it("surfaces a seat-capacity abort as a bounded quota error", async () => {
    const world = defaultWorld();
    await seedInvite(world, TOKEN);
    world.failNextBatch = "workspace seat capacity exceeded";
    const { response, body } = await callAs(
      OUTSIDER,
      post("/v1/workspace/invites/accept", { token: TOKEN }),
      world,
    );
    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "quota_exceeded",
      resource: "seats",
      local_capture_unaffected: true,
    });
  });
});

// -- role changes and removal -------------------------------------------------

describe("role changes", () => {
  it("promotes and demotes with an audited transition", async () => {
    const world = defaultWorld();
    const { response, body, batches } = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: VIEWER, role: "admin" }),
      world,
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ user_id: VIEWER, role: "admin", changed: true });
    expect(auditKinds(batches)).toEqual(["team.member.role_changed"]);
    expect(world.members.find((entry) => entry.userId === VIEWER)?.role).toBe("admin");

    const noop = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: VIEWER, role: "admin" }),
      world,
    );
    expect(noop.body).toMatchObject({ changed: false });
    expect(noop.batches).toHaveLength(0);
  });

  it("keeps ownership changes to owners only", async () => {
    const world = defaultWorld();
    const grant = await callAs(
      ADMIN,
      post("/v1/workspace/members/role", { user_id: MEMBER, role: "owner" }),
      world,
    );
    expect(grant.response.status).toBe(403);
    const demote = await callAs(
      ADMIN,
      post("/v1/workspace/members/role", { user_id: OWNER, role: "member" }),
      world,
    );
    expect(demote.response.status).toBe(403);
    expect(grant.batches).toHaveLength(0);

    const promoted = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: MEMBER, role: "owner" }),
      world,
    );
    expect(promoted.response.status).toBe(200);
    expect(world.members.filter((entry) => entry.role === "owner")).toHaveLength(2);
  });

  it("protects the last owner at the route and again at the schema", async () => {
    const world = defaultWorld();
    const demote = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: OWNER, role: "admin" }),
      world,
    );
    expect(demote.response.status).toBe(409);
    expect(demote.body.error).toBe("last_owner_protected");
    expect(demote.batches).toHaveLength(0);

    // Even if a concurrent promotion made the route check pass, the migration
    // trigger aborts the batch and the request still fails closed.
    const raced = defaultWorld();
    raced.members.push(member(MEMBER, "owner", { userId: `usr_01J${"K".repeat(23)}` }));
    raced.failNextBatch = "workspace must retain an owner";
    const trigger = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: OWNER, role: "admin" }),
      raced,
    );
    expect(trigger.response.status).toBe(409);
    expect(trigger.body.error).toBe("last_owner_protected");
  });

  it("rejects an unknown role or a target outside the workspace", async () => {
    const world = defaultWorld();
    const badRole = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: VIEWER, role: "root" }),
      world,
    );
    expect(badRole.response.status).toBe(400);
    const badTarget = await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: OUTSIDER, role: "member" }),
      world,
    );
    expect(badTarget.response.status).toBe(404);
  });
});

describe("member removal", () => {
  it("removes a member as an admin and audits it", async () => {
    const world = defaultWorld();
    const { response, batches } = await callAs(
      ADMIN,
      post("/v1/workspace/members/remove", { user_id: MEMBER }),
      world,
    );
    expect(response.status).toBe(200);
    expect(auditKinds(batches)).toEqual(["team.member.removed"]);
    expect(world.members.find((entry) => entry.userId === MEMBER)?.status).toBe("removed");
  });

  it("lets a non-owner leave on their own", async () => {
    const world = defaultWorld();
    const { response, body } = await callAs(
      VIEWER,
      post("/v1/workspace/members/remove", { user_id: VIEWER }),
      world,
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ self_leave: true });
    expect(world.members.find((entry) => entry.userId === VIEWER)?.status).toBe("removed");
  });

  it("refuses to let the last owner leave", async () => {
    const world = defaultWorld();
    const { response, body, batches } = await callAs(
      OWNER,
      post("/v1/workspace/members/remove", { user_id: OWNER }),
      world,
    );
    expect(response.status).toBe(409);
    expect(body.error).toBe("last_owner_protected");
    expect(batches).toHaveLength(0);
  });

  it("stops a member from removing anybody else and an admin from removing an owner", async () => {
    const world = defaultWorld();
    const peer = await callAs(
      MEMBER,
      post("/v1/workspace/members/remove", { user_id: VIEWER }),
      world,
    );
    expect(peer.response.status).toBe(403);
    const upward = await callAs(
      ADMIN,
      post("/v1/workspace/members/remove", { user_id: OWNER }),
      world,
    );
    expect(upward.response.status).toBe(403);
    expect(world.members.every((entry) => entry.status === "active")).toBe(true);
  });
});

// -- audit surfacing ----------------------------------------------------------

describe("audit trail", () => {
  it("chains every mutation and reports the page as verified", async () => {
    const world = defaultWorld();
    await callAs(OWNER, post("/v1/workspace/invites", { email: "one@example.com" }), world);
    await callAs(
      OWNER,
      post("/v1/workspace/members/role", { user_id: VIEWER, role: "member" }),
      world,
    );
    await callAs(OWNER, post("/v1/workspace/members/remove", { user_id: MEMBER }), world);

    const { response, body } = await callAs(ADMIN, get("/v1/workspace/audit"), world);
    expect(response.status).toBe(200);
    const items = body.items as AuditEntry[];
    expect(items.map((item) => item.kind)).toEqual([
      "team.member.removed",
      "team.member.role_changed",
      "team.invite.created",
    ]);
    expect(items.map((item) => item.seq)).toEqual([2, 1, 0]);
    expect(items[2].prev_content_hash).toBeNull();
    expect(items[1].prev_content_hash).toBe(items[2].content_hash);
    expect(items[0].prev_content_hash).toBe(items[1].content_hash);
    expect(body.chain_verified).toBe(true);
    expect(items.every((item) => item.actor_user_id === OWNER)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("hfg_invite_");
  });

  it("retries once against a moved chain head before failing closed", async () => {
    const world = defaultWorld();
    world.failNextBatch = "audit chain link mismatch";
    const { response, batches } = await callAs(
      OWNER,
      post("/v1/workspace/invites", { email: "retry@example.com" }),
      world,
    );
    expect(response.status).toBe(201);
    expect(batches).toHaveLength(2);
    expect(world.invites).toHaveLength(1);
  });

  it("fails closed when the chain conflict does not clear", async () => {
    const world = defaultWorld();
    const csrfHash = await sha256Hex(CSRF);
    const { db } = teamDb(world, csrfHash, OWNER);
    const failing: D1DatabaseLike = {
      prepare: db.prepare.bind(db),
      async batch() {
        throw new Error("UNIQUE constraint failed: audit_chain.workspace_id, audit_chain.seq");
      },
    };
    const env: TeamsTestEnv = {
      DB: failing,
      BODIES: HEALTHY_DELETION_LEDGER,
      APP_ORIGIN,
    };
    const response = await handleTeamsRoute(
      post("/v1/workspace/invites", { email: "never@example.com" }),
      env,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      error: "audit_unavailable",
      local_capture_unaffected: true,
    });
    expect(world.invites).toHaveLength(0);
  });
});

// -- worker wiring ------------------------------------------------------------

describe("worker routing", () => {
  it("serves the team surface through the platform Worker", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, OWNER);
    const response = await worker.fetch(get("/v1/workspace/members"), env as never, {} as never);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(4);
  });

  it("answers a wrong method on a team path with the shared 404", async () => {
    const world = defaultWorld();
    const { env } = await envFor(world, OWNER);
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/v1/workspace/members`, { method: "DELETE" }),
      env as never,
      {} as never,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});

// -- migration truth ----------------------------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "0001_init.sql",
  "0002_workstream_event_projection.sql",
  "0003_account_foundation.sql",
  "0004_teams_rbac.sql",
];

function migrate(upTo = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.slice(0, upTo)) {
    db.exec(readFileSync(resolve(testDirectory, `../migrations/${migration}`), "utf8"));
  }
  return db;
}

function addWorkspace(db: DatabaseSync, id: string): void {
  db.prepare(
    "INSERT INTO workspaces (id, workspace_id, name, status, created_at) VALUES (?, ?, 'team', 'active', 10)",
  ).run(id, id);
}

function addUser(db: DatabaseSync, id: string, personalWorkspace: string, email: string): void {
  db.prepare(`
    INSERT INTO users (id, email, email_verified, personal_workspace_id, created_at, updated_at)
    VALUES (?, ?, 1, ?, 10, 10)
  `).run(id, email, personalWorkspace);
}

function addMember(
  db: DatabaseSync,
  workspace: string,
  user: string,
  role: string,
  createdAt = 10,
): void {
  db.prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(workspace, user, role, createdAt);
}

function addInvite(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    workspace: string;
    email: string;
    role: string;
    tokenHash: string;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
  }> = {},
): void {
  db.prepare(`
    INSERT INTO workspace_invites
      (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id ?? INVITE_ID,
    overrides.workspace ?? TEAM_WS,
    overrides.email ?? "invitee@example.com",
    overrides.role ?? "member",
    overrides.tokenHash ?? "a".repeat(64),
    overrides.createdBy ?? OWNER,
    overrides.createdAt ?? 100,
    overrides.expiresAt ?? 1_000,
  );
}

function teamDatabase(): DatabaseSync {
  const db = migrate();
  const personal = `wsp_01J${"P".repeat(23)}`;
  addWorkspace(db, personal);
  addWorkspace(db, TEAM_WS);
  addUser(db, OWNER, personal, "owner@example.com");
  addMember(db, TEAM_WS, OWNER, "owner");
  return db;
}

describe("0004 teams and RBAC migration", () => {
  it("creates every team table and seats each existing workspace", () => {
    const db = migrate();
    addWorkspace(db, TEAM_WS);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const table of ["workspace_invites", "workspace_seats", "audit_chain"]) {
      expect(tables).toContain(table);
    }
    expect(db.prepare("SELECT max_seats FROM workspace_seats WHERE workspace_id = ?").get(TEAM_WS))
      .toMatchObject({ max_seats: 5 });
    db.close();
  });

  it("backfills the earliest member of an ownerless workspace as owner", () => {
    const db = migrate(3);
    const personalOne = `wsp_01J${"P".repeat(23)}`;
    const personalTwo = `wsp_01J${"Q".repeat(23)}`;
    addWorkspace(db, personalOne);
    addWorkspace(db, personalTwo);
    addWorkspace(db, TEAM_WS);
    addUser(db, OWNER, personalOne, "first@example.com");
    addUser(db, ADMIN, personalTwo, "second@example.com");
    addMember(db, TEAM_WS, ADMIN, "member", 50);
    addMember(db, TEAM_WS, OWNER, "member", 20);
    db.exec(readFileSync(resolve(testDirectory, "../migrations/0004_teams_rbac.sql"), "utf8"));
    expect(
      db.prepare("SELECT user_id, role FROM workspace_members WHERE workspace_id = ? ORDER BY role")
        .all(TEAM_WS),
    ).toEqual([
      { user_id: ADMIN, role: "member" },
      { user_id: OWNER, role: "owner" },
    ]);
    db.close();
  });

  it("refuses to demote, suspend, or delete the last owner", () => {
    const db = teamDatabase();
    expect(() =>
      db.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?")
        .run(TEAM_WS, OWNER),
    ).toThrow(/workspace must retain an owner/);
    expect(() =>
      db.prepare("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?")
        .run(TEAM_WS, OWNER),
    ).toThrow(/workspace must retain an owner/);
    expect(() =>
      db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
        .run(TEAM_WS, OWNER),
    ).toThrow(/workspace must retain an owner/);
    db.close();
  });

  it("allows the transition once a second owner exists, and still cascades workspace deletion", () => {
    const db = teamDatabase();
    const personal = `wsp_01J${"R".repeat(23)}`;
    addWorkspace(db, personal);
    addUser(db, ADMIN, personal, "second@example.com");
    addMember(db, TEAM_WS, ADMIN, "owner", 20);
    db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?")
      .run(TEAM_WS, ADMIN);
    expect(
      db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
        .get(TEAM_WS, ADMIN),
    ).toMatchObject({ role: "member" });

    db.prepare("DELETE FROM workspaces WHERE id = ?").run(TEAM_WS);
    expect(
      db.prepare("SELECT COUNT(*) AS remaining FROM workspace_members WHERE workspace_id = ?")
        .get(TEAM_WS),
    ).toMatchObject({ remaining: 0 });
    db.close();
  });

  it("bounds active members plus live invites by the seat allowance", () => {
    const db = teamDatabase();
    db.prepare("UPDATE workspace_seats SET max_seats = 2 WHERE workspace_id = ?").run(TEAM_WS);
    addInvite(db, { email: "first@example.com", tokenHash: "b".repeat(64) });
    expect(() =>
      addInvite(db, {
        id: `inv_01J${"J".repeat(23)}`,
        email: "second@example.com",
        tokenHash: "c".repeat(64),
      }),
    ).toThrow(/seat capacity exceeded/);

    const personal = `wsp_01J${"S".repeat(23)}`;
    addWorkspace(db, personal);
    addUser(db, MEMBER, personal, "member@example.com");
    addMember(db, TEAM_WS, MEMBER, "member", 30);
    expect(() => addMember(db, TEAM_WS, ADMIN, "member", 40)).toThrow();
    db.close();
  });

  it("keeps invites hash-only, single-use, and never owner-granting", () => {
    const db = teamDatabase();
    expect(() => addInvite(db, { role: "owner" })).toThrow();
    expect(() => addInvite(db, { email: "not-an-address" })).toThrow();
    expect(() => addInvite(db, { tokenHash: "not-a-digest" })).toThrow();
    expect(() => addInvite(db, { expiresAt: 10 })).toThrow();

    addInvite(db);
    expect(() =>
      addInvite(db, { id: `inv_01J${"J".repeat(23)}`, tokenHash: "d".repeat(64) }),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE workspace_invites SET role = 'admin' WHERE id = ?").run(INVITE_ID))
      .toThrow(/invite identity is immutable/);
    expect(() =>
      db.prepare("UPDATE workspace_invites SET accepted_at = 2000, accepted_by = ? WHERE id = ?")
        .run(OWNER, INVITE_ID),
    ).toThrow(/invite expired/);

    db.prepare("UPDATE workspace_invites SET accepted_at = 200, accepted_by = ? WHERE id = ?")
      .run(OWNER, INVITE_ID);
    expect(() =>
      db.prepare("UPDATE workspace_invites SET revoked_at = 300 WHERE id = ?").run(INVITE_ID),
    ).toThrow(/invite already resolved/);
    db.close();
  });

  it("makes the audit chain linked, unforkable, and append-only", () => {
    const db = teamDatabase();
    const event = (id: string, hash: string): void => {
      db.prepare(`
        INSERT INTO events
          (workspace_id, event_id, occurred_at, kind, provenance, content_hash, ingested_at, raw_json)
        VALUES (?, ?, '2026-08-28T00:00:00.000Z', 'team.member.added', 'OBSERVED', ?, 10, '{}')
      `).run(TEAM_WS, id, `sha256:${hash}`);
    };
    const link = (seq: number, id: string, hash: string, prev: string | null): void => {
      db.prepare(`
        INSERT INTO audit_chain (workspace_id, seq, event_id, content_hash, prev_hash, created_at)
        VALUES (?, ?, ?, ?, ?, 10)
      `).run(TEAM_WS, seq, id, hash, prev);
    };
    const first = `evt_01J${"A".repeat(23)}`;
    const second = `evt_01J${"B".repeat(23)}`;
    const hashOne = "1".repeat(64);
    const hashTwo = "2".repeat(64);

    expect(() => link(0, first, hashOne, null)).toThrow(/audit chain event missing/);
    event(first, hashOne);
    link(0, first, hashOne, null);
    event(second, hashTwo);
    expect(() => link(1, second, hashTwo, null)).toThrow(/audit chain link mismatch/);
    expect(() => link(0, second, hashTwo, null)).toThrow(/UNIQUE|PRIMARY/);
    link(1, second, hashTwo, hashOne);

    expect(() =>
      db.prepare("UPDATE audit_chain SET content_hash = ? WHERE workspace_id = ? AND seq = 0")
        .run(hashTwo, TEAM_WS),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM audit_chain WHERE workspace_id = ? AND seq = 0").run(TEAM_WS),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("UPDATE events SET raw_json = '{\"tampered\":true}' WHERE event_id = ?").run(first),
    ).toThrow(/events are append-only/);
    expect(() => db.prepare("DELETE FROM events WHERE event_id = ?").run(first))
      .toThrow(/events are append-only/);
    db.close();
  });

  it("commits an audited invite exactly as the router batches it", async () => {
    const db = teamDatabase();
    const records = await buildAuditRecords(
      TEAM_WS,
      null,
      [{
        kind: "team.invite.created",
        actorUserId: OWNER,
        payload: { invite_id: INVITE_ID, role: "member" },
      }],
      1_800_000_000_000,
    );
    const record = records[0];
    db.exec("BEGIN IMMEDIATE");
    addInvite(db);
    db.prepare(`
      INSERT INTO events
        (workspace_id, event_id, occurred_at, kind, provenance, content_hash, ingested_at, raw_json)
      VALUES (?, ?, ?, ?, 'OBSERVED', ?, 10, ?)
    `).run(
      TEAM_WS,
      record.eventId,
      record.occurredAt,
      "team.invite.created",
      `sha256:${record.contentHash}`,
      JSON.stringify(record.document),
    );
    db.prepare(`
      INSERT INTO audit_chain (workspace_id, seq, event_id, content_hash, prev_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 10)
    `).run(TEAM_WS, record.seq, record.eventId, record.contentHash, record.prevHash);
    db.exec("COMMIT");

    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_chain WHERE workspace_id = ?").get(TEAM_WS))
      .toMatchObject({ n: 1 });
    expect(
      db.prepare("SELECT token_hash FROM workspace_invites WHERE id = ?").get(INVITE_ID),
    ).toMatchObject({ token_hash: "a".repeat(64) });
    db.close();
  });
});
