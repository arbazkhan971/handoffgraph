// Teams, org-level RBAC, and the tamper-evident audit trail (parity rows 45, 49).
//
// This module owns the /v1/workspace* surface on the human account plane: the
// browser cookie session from account.ts authenticates, never a device token.
// Device tokens can ingest evidence but can never change who may read it.
//
// Three rules shape everything below:
//
//   1. Authorization is a role lookup against workspace_members, not against
//      the session's personal workspace. A caller may address any workspace it
//      is an active member of; anything else is 404 by scopeDenial, so a
//      foreign workspace's existence is never disclosed.
//   2. Invite tokens are opaque bearer credentials. Only their SHA-256 is
//      persisted, the raw token is returned exactly once, and it never reaches
//      a log, an audit payload, or the events spine.
//   3. Every mutation commits together with its audit evidence: the event row,
//      and the hash-chain link binding it to its predecessor, are in the same
//      D1 batch as the membership write. A broken or forked chain aborts the
//      mutation rather than recording an unlinked one.

import { sha256Hex } from "./auth";
import {
  authorizedUnsafeRequest,
  authenticateAccountSession,
  normalizedOrigin,
  randomSecret,
  readAccountJsonBody,
  type AccountEnv,
  type SessionAccount,
} from "./account";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  EVENT_SCHEMA_VERSION,
  canonicalJsonStringify,
  encodeCursor,
  parsePagination,
  scopeDenial,
} from "./ingest";

export type TeamsEnv = AccountEnv;

const WORKSPACE_ID_PATTERN = /^wsp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const USER_ID_PATTERN = /^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const INVITE_ID_PATTERN = /^inv_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const INVITE_TOKEN_PATTERN = /^hfg_invite_[\w-]{43}$/;

// Deliberately conservative: a normalized address with one @, no whitespace,
// and a dotted domain. The column CHECK in migration 0004 repeats the shape so
// a future caller cannot store something this router would have rejected.
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

// -- roles --------------------------------------------------------------------

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Invites can never confer ownership; migration 0004 enforces the same set. */
export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  viewer: 0,
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && Object.hasOwn(ROLE_RANK, value);
}

export function isInvitableRole(value: unknown): value is InvitableRole {
  return isWorkspaceRole(value) && value !== "owner";
}

/** owner > admin > member > viewer. */
export function meetsRole(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  role: WorkspaceRole;
}

export type RoleCheck =
  | { ok: true; membership: Membership }
  | { ok: false; status: 404 | 403; error: string };

interface MembershipRow {
  workspace_id: string;
  role: string;
  workspace_name: string;
}

const READ_MEMBERSHIP_SQL = `
  /* teams:read-membership */
  SELECT m.workspace_id, m.role, w.name AS workspace_name
  FROM workspace_members AS m
  JOIN workspaces AS w ON w.id = m.workspace_id
  WHERE m.workspace_id = ?1
    AND m.user_id = ?2
    AND m.status = 'active'
    AND w.status = 'active'
  LIMIT 1`;

/**
 * RBAC seam for this and any future workspace-scoped route.
 *
 * A caller with no active membership gets 404 "not found" — identical to the
 * answer for a workspace that does not exist — so membership cannot be probed.
 * A member whose role is below the minimum gets 403 "forbidden".
 */
export async function requireRole(
  db: D1DatabaseLike,
  workspaceId: string,
  userId: string,
  minimum: WorkspaceRole,
): Promise<RoleCheck> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !USER_ID_PATTERN.test(userId)) {
    return { ok: false, status: 404, error: "not found" };
  }
  const row = await db.prepare(READ_MEMBERSHIP_SQL).bind(workspaceId, userId).first<MembershipRow>();
  if (row === null || !isWorkspaceRole(row.role)) {
    // Foreign or unknown workspace: never confirm it exists.
    return { ok: false, status: 404, error: "not found" };
  }
  const denial = scopeDenial({
    resourceWorkspaceId: row.workspace_id,
    tokenWorkspaceId: workspaceId,
    allowed: meetsRole(row.role, minimum),
  });
  if (denial !== null) return { ok: false, status: denial.status, error: denial.error };
  return {
    ok: true,
    membership: {
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      userId,
      role: row.role,
    },
  };
}

// -- audit spine --------------------------------------------------------------

export const TEAM_EVENT_KINDS = [
  "team.invite.accepted",
  "team.invite.created",
  "team.invite.revoked",
  "team.member.added",
  "team.member.removed",
  "team.member.role_changed",
] as const;
export type TeamEventKind = (typeof TEAM_EVENT_KINDS)[number];

/** Audit payload values are ids, roles, and hashes — never a secret. */
export type AuditPayload = Record<string, string | number | boolean | null>;

export interface AuditInput {
  kind: TeamEventKind;
  actorUserId: string;
  payload: AuditPayload;
}

export interface AuditHead {
  seq: number;
  contentHash: string;
}

export interface AuditRecord {
  seq: number;
  eventId: string;
  /** 64 lowercase hex, without the `sha256:` prefix used in the event body. */
  contentHash: string;
  prevHash: string | null;
  occurredAt: string;
  document: Record<string, unknown>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 281_474_976_710_655; // 2^48 - 1

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

/**
 * Derive the event id from the evidence instead of from randomness.
 *
 * The layout is a ULID — 48-bit millisecond timestamp then 80 bits of
 * "entropy" — so audit ids sort with every other platform id and satisfy the
 * hfg.event.v1 event_id pattern. Taking the entropy from the content digest
 * makes the id a deterministic function of what happened: the same mutation
 * rebuilt from the same inputs yields the same id, so an append-only replay is
 * an exact no-op instead of a duplicate row.
 */
export function deterministicEventId(nowMillis: number, contentHash: string): string {
  const millis = Number.isFinite(nowMillis) ? Math.floor(nowMillis) : 0;
  const timestamp = BigInt(Math.min(Math.max(millis, 0), MAX_ULID_TIME));
  const entropy = BigInt(`0x${contentHash.slice(0, 20)}`);
  return `evt_${encodeCrockford(timestamp, 10)}${encodeCrockford(entropy, 16)}`;
}

/**
 * Build the audit events for one mutation as hfg.event.v1 documents linked
 * into the workspace's hash chain.
 *
 * content_hash covers the canonical core of the event (kind, actor, target,
 * chain position, and the predecessor hash). event_id and content_hash are
 * themselves pure functions of that core, so excluding them from the hashed
 * bytes loses no evidence and avoids a circular definition.
 */
export async function buildAuditRecords(
  workspaceId: string,
  head: AuditHead | null,
  inputs: AuditInput[],
  nowMillis: number,
): Promise<AuditRecord[]> {
  const occurredAt = new Date(nowMillis).toISOString();
  let seq = head === null ? 0 : head.seq + 1;
  let prevHash = head === null ? null : head.contentHash;
  const records: AuditRecord[] = [];
  for (const input of inputs) {
    const core = {
      audit: {
        actor_user_id: input.actorUserId,
        prev_content_hash: prevHash,
        seq,
      },
      kind: input.kind,
      observed_at: occurredAt,
      occurred_at: occurredAt,
      payload: input.payload,
      provenance: "OBSERVED",
      schema_version: EVENT_SCHEMA_VERSION,
      workspace_id: workspaceId,
    };
    const contentHash = await sha256Hex(canonicalJsonStringify(core));
    const eventId = deterministicEventId(nowMillis, contentHash);
    records.push({
      seq,
      eventId,
      contentHash,
      prevHash,
      occurredAt,
      document: { ...core, content_hash: `sha256:${contentHash}`, event_id: eventId },
    });
    prevHash = contentHash;
    seq += 1;
  }
  return records;
}

const READ_AUDIT_HEAD_SQL = `
  /* teams:read-audit-head */
  SELECT seq, content_hash
  FROM audit_chain
  WHERE workspace_id = ?1
  ORDER BY seq DESC
  LIMIT 1`;

// Same shape as the ingest pipeline: one bounded json_each expansion, INSERT
// OR IGNORE keyed on (workspace_id, event_id), and never an UPDATE.
const APPEND_AUDIT_EVENTS_SQL = `
  /* teams:append-audit-events */
  INSERT OR IGNORE INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  SELECT
    ?1,
    json_extract(input.value, '$.event_id'),
    NULL,
    json_extract(input.value, '$.occurred_at'),
    NULL,
    NULL,
    NULL,
    NULL,
    json_extract(input.value, '$.kind'),
    json_extract(input.value, '$.provenance'),
    json_extract(input.value, '$.content_hash'),
    ?2,
    input.value
  FROM json_each(?3) AS input`;

// Not INSERT OR IGNORE: a duplicate sequence or a reused predecessor is a fork
// attempt, and migration 0004's triggers must abort the whole transaction.
const APPEND_AUDIT_CHAIN_SQL = `
  /* teams:append-audit-chain */
  INSERT INTO audit_chain
    (workspace_id, seq, event_id, content_hash, prev_hash, created_at)
  SELECT
    ?1,
    json_extract(link.value, '$.seq'),
    json_extract(link.value, '$.event_id'),
    json_extract(link.value, '$.content_hash'),
    json_extract(link.value, '$.prev_hash'),
    ?2
  FROM json_each(?3) AS link`;

interface AuditHeadRow {
  seq: number;
  content_hash: string;
}

async function readAuditHead(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<AuditHead | null> {
  const row = await db.prepare(READ_AUDIT_HEAD_SQL).bind(workspaceId).first<AuditHeadRow>();
  if (row === null || !Number.isSafeInteger(row.seq) || typeof row.content_hash !== "string") {
    return null;
  }
  return { seq: row.seq, contentHash: row.content_hash };
}

function auditStatements(
  db: D1DatabaseLike,
  workspaceId: string,
  records: AuditRecord[],
  nowSeconds: number,
): D1BoundStatement[] {
  const documents = canonicalJsonStringify(records.map((record) => record.document));
  const links = canonicalJsonStringify(records.map((record) => ({
    content_hash: record.contentHash,
    event_id: record.eventId,
    prev_hash: record.prevHash,
    seq: record.seq,
  })));
  return [
    db.prepare(APPEND_AUDIT_EVENTS_SQL).bind(workspaceId, nowSeconds, documents),
    db.prepare(APPEND_AUDIT_CHAIN_SQL).bind(workspaceId, nowSeconds, links),
  ];
}

// -- responses ----------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function seatQuotaResponse(): Response {
  return json(429, {
    error: "quota_exceeded",
    resource: "seats",
    local_capture_unaffected: true,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

type CommitOutcome =
  | { ok: true; records: AuditRecord[] }
  | { ok: false; response: Response };

/**
 * Commit a membership mutation together with its audit evidence.
 *
 * The mutation statements, the event insert, and the chain link are one D1
 * batch, so an aborted chain link rolls the mutation back rather than leaving
 * an unaudited change. A concurrent writer that advanced the chain between the
 * head read and the commit collides on (workspace_id, seq); that is a genuine
 * conflict, not a failure, so it is retried once against the new head before
 * the request fails closed.
 */
async function commitAudited(
  db: D1DatabaseLike,
  workspaceId: string,
  mutations: () => D1BoundStatement[],
  audits: AuditInput[],
  nowMillis: number,
): Promise<CommitOutcome> {
  const nowSeconds = Math.floor(nowMillis / 1_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const head = await readAuditHead(db, workspaceId);
    const records = await buildAuditRecords(workspaceId, head, audits, nowMillis);
    try {
      await db.batch([
        ...mutations(),
        ...auditStatements(db, workspaceId, records, nowSeconds),
      ]);
      return { ok: true, records };
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("seat capacity exceeded")) {
        return { ok: false, response: seatQuotaResponse() };
      }
      if (message.includes("must retain an owner")) {
        return { ok: false, response: json(409, { error: "last_owner_protected" }) };
      }
      if (message.includes("invite already resolved") || message.includes("invite expired")) {
        return { ok: false, response: json(409, { error: "invite_not_pending" }) };
      }
      if (message.includes("UNIQUE constraint failed: workspace_invites")) {
        return { ok: false, response: json(409, { error: "invite_pending" }) };
      }
      const chainConflict =
        message.includes("audit chain") ||
        message.includes("UNIQUE constraint failed: audit_chain") ||
        message.includes("audit_chain.seq");
      if (chainConflict && attempt === 0) continue;
      if (chainConflict) {
        return {
          ok: false,
          response: json(503, {
            error: "audit_unavailable",
            local_capture_unaffected: true,
          }),
        };
      }
      throw error;
    }
  }
  return {
    ok: false,
    response: json(503, { error: "audit_unavailable", local_capture_unaffected: true }),
  };
}

// -- workspace selection ------------------------------------------------------

/**
 * Resolve which workspace a request addresses. The session's personal
 * workspace is the default; `workspace_id` selects any other workspace the
 * caller is an active member of. Everything else is 404.
 */
function requestedWorkspaceId(
  session: SessionAccount,
  candidate: unknown,
): string | null {
  if (candidate === undefined || candidate === null || candidate === "") {
    return session.workspaceId;
  }
  if (typeof candidate !== "string" || !WORKSPACE_ID_PATTERN.test(candidate)) return null;
  return candidate;
}

async function authorizeRead(
  request: Request,
  env: TeamsEnv,
  minimum: WorkspaceRole,
): Promise<{ session: SessionAccount; membership: Membership } | { response: Response }> {
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return { response: json(401, { error: "unauthorized" }) };
  const workspaceId = requestedWorkspaceId(
    session,
    new URL(request.url).searchParams.get("workspace_id") ?? undefined,
  );
  if (workspaceId === null) return { response: json(404, { error: "not found" }) };
  const check = await requireRole(env.DB, workspaceId, session.userId, minimum);
  if (!check.ok) return { response: json(check.status, { error: check.error }) };
  return { session, membership: check.membership };
}

async function authorizeWrite(
  request: Request,
  env: TeamsEnv,
  minimum: WorkspaceRole,
): Promise<
  | { session: SessionAccount; membership: Membership; body: Record<string, unknown> }
  | { response: Response }
> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return { response: auth.response };
  const body = await readAccountJsonBody(request);
  if (body === null) return { response: json(400, { error: "invalid request body" }) };
  const workspaceId = requestedWorkspaceId(auth.session, body.workspace_id);
  if (workspaceId === null) return { response: json(404, { error: "not found" }) };
  const check = await requireRole(env.DB, workspaceId, auth.session.userId, minimum);
  if (!check.ok) return { response: json(check.status, { error: check.error }) };
  return { session: auth.session, membership: check.membership, body };
}

// -- GET /v1/workspaces -------------------------------------------------------

const LIST_WORKSPACES_SQL = `
  /* teams:list-workspaces */
  SELECT m.workspace_id, m.role, m.created_at, w.name AS workspace_name,
         (SELECT COUNT(*) FROM workspace_members AS peer
          WHERE peer.workspace_id = m.workspace_id AND peer.status = 'active') AS member_count
  FROM workspace_members AS m
  JOIN workspaces AS w ON w.id = m.workspace_id
  WHERE m.user_id = ?1 AND m.status = 'active' AND w.status = 'active'
  ORDER BY m.created_at DESC, m.workspace_id DESC
  LIMIT ?2`;

interface WorkspaceMembershipRow {
  workspace_id: string;
  role: string;
  created_at: number;
  workspace_name: string;
  member_count: number;
}

/** Membership index for the signed-in user; every row is a workspace they belong to. */
async function listWorkspaces(request: Request, env: TeamsEnv): Promise<Response> {
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return json(401, { error: "unauthorized" });
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const result = await env.DB.prepare(LIST_WORKSPACES_SQL)
    .bind(session.userId, page.value.limit + 1)
    .all<WorkspaceMembershipRow>();
  const rows = [...result.results].sort(byCreatedAtDescending(
    (row) => row.created_at,
    (row) => row.workspace_id,
  ));
  const items = rows.slice(0, page.value.limit).map((row) => ({
    workspace_id: row.workspace_id,
    name: row.workspace_name,
    role: row.role,
    member_count: row.member_count,
    joined_at: row.created_at,
    is_personal: row.workspace_id === session.workspaceId,
  }));
  const last = rows[items.length - 1];
  return json(200, {
    items,
    next_cursor:
      rows.length > page.value.limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.workspace_id })
        : null,
  });
}

/** Deterministic ordering: newest first, id as the total-order tie-break. */
function byCreatedAtDescending<T>(
  createdAt: (row: T) => number,
  id: (row: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    if (createdAt(a) !== createdAt(b)) return createdAt(b) - createdAt(a);
    if (id(a) !== id(b)) return id(a) > id(b) ? -1 : 1;
    return 0;
  };
}

// -- GET /v1/workspace/members ------------------------------------------------

const LIST_MEMBERS_SQL = `
  /* teams:list-members */
  SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
  FROM workspace_members AS m
  JOIN users AS u ON u.id = m.user_id
  WHERE m.workspace_id = ?1 AND m.status = 'active'
  ORDER BY m.created_at DESC, m.user_id DESC
  LIMIT ?2`;

const LIST_MEMBERS_AFTER_SQL = `
  /* teams:list-members-after */
  SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
  FROM workspace_members AS m
  JOIN users AS u ON u.id = m.user_id
  WHERE m.workspace_id = ?1 AND m.status = 'active'
    AND (m.created_at < ?2 OR (m.created_at = ?2 AND m.user_id < ?3))
  ORDER BY m.created_at DESC, m.user_id DESC
  LIMIT ?4`;

interface MemberRow {
  user_id: string;
  role: string;
  created_at: number;
  email: string;
  display_name: string | null;
}

async function listMembers(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeRead(request, env, "viewer");
  if ("response" in auth) return auth.response;
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const result =
    cursor === null
      ? await env.DB.prepare(LIST_MEMBERS_SQL)
          .bind(auth.membership.workspaceId, limit + 1)
          .all<MemberRow>()
      : await env.DB.prepare(LIST_MEMBERS_AFTER_SQL)
          .bind(auth.membership.workspaceId, cursor.createdAt, cursor.id, limit + 1)
          .all<MemberRow>();
  const rows = [...result.results].sort(byCreatedAtDescending(
    (row) => row.created_at,
    (row) => row.user_id,
  ));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map((row) => ({
      user_id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      joined_at: row.created_at,
      is_self: row.user_id === auth.session.userId,
    })),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.user_id })
        : null,
  });
}

// -- invites ------------------------------------------------------------------

const LIST_INVITES_SQL = `
  /* teams:list-invites */
  SELECT id, email, role, created_at, expires_at, created_by
  FROM workspace_invites
  WHERE workspace_id = ?1
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
  ORDER BY created_at DESC, id DESC
  LIMIT ?3`;

const LIST_INVITES_AFTER_SQL = `
  /* teams:list-invites-after */
  SELECT id, email, role, created_at, expires_at, created_by
  FROM workspace_invites
  WHERE workspace_id = ?1
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
    AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))
  ORDER BY created_at DESC, id DESC
  LIMIT ?5`;

const READ_LIVE_INVITE_SQL = `
  /* teams:read-live-invite */
  SELECT id, expires_at
  FROM workspace_invites
  WHERE workspace_id = ?1 AND email = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL
  LIMIT 1`;

const SWEEP_EXPIRED_INVITE_SQL = `
  /* teams:sweep-expired-invite */
  UPDATE workspace_invites
  SET revoked_at = ?3
  WHERE workspace_id = ?1 AND email = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?3`;

const INSERT_INVITE_SQL = `
  /* teams:insert-invite */
  INSERT INTO workspace_invites
    (id, workspace_id, email, role, token_hash, created_by, created_at,
     expires_at, accepted_at, accepted_by, revoked_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL)`;

const READ_INVITE_BY_ID_SQL = `
  /* teams:read-invite-by-id */
  SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at
  FROM workspace_invites
  WHERE id = ?1 AND workspace_id = ?2
  LIMIT 1`;

const REVOKE_INVITE_SQL = `
  /* teams:revoke-invite */
  UPDATE workspace_invites
  SET revoked_at = ?3
  WHERE id = ?1 AND workspace_id = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL`;

const READ_INVITE_BY_TOKEN_SQL = `
  /* teams:read-invite-by-token */
  SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at,
         i.accepted_by, i.revoked_at, w.name AS workspace_name
  FROM workspace_invites AS i
  JOIN workspaces AS w ON w.id = i.workspace_id
  WHERE i.token_hash = ?1 AND w.status = 'active'
  LIMIT 1`;

const ACCEPT_INVITE_SQL = `
  /* teams:accept-invite */
  UPDATE workspace_invites
  SET accepted_at = ?3, accepted_by = ?4
  WHERE id = ?1 AND workspace_id = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?3`;

// An existing owner is never demoted by redeeming an invite.
const UPSERT_MEMBER_SQL = `
  /* teams:upsert-member */
  INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
  VALUES (?1, ?2, ?3, 'active', ?4)
  ON CONFLICT(workspace_id, user_id) DO UPDATE SET
    role = CASE WHEN workspace_members.role = 'owner' THEN 'owner' ELSE excluded.role END,
    status = 'active'`;

interface InviteRow {
  id: string;
  email: string;
  role: string;
  created_at: number;
  expires_at: number;
  created_by: string;
}

interface InviteTokenRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  revoked_at: number | null;
  workspace_name: string;
}

async function listInvites(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeRead(request, env, "admin");
  if ("response" in auth) return auth.response;
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const now = Math.floor(Date.now() / 1_000);
  const result =
    cursor === null
      ? await env.DB.prepare(LIST_INVITES_SQL)
          .bind(auth.membership.workspaceId, now, limit + 1)
          .all<InviteRow>()
      : await env.DB.prepare(LIST_INVITES_AFTER_SQL)
          .bind(auth.membership.workspaceId, now, cursor.createdAt, cursor.id, limit + 1)
          .all<InviteRow>();
  const rows = [...result.results].sort(byCreatedAtDescending(
    (row) => row.created_at,
    (row) => row.id,
  ));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
      expires_at: row.expires_at,
      created_by: row.created_by,
      status: "pending",
    })),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

/**
 * Mint an `inv_<ulid>` id. Invite ids are owned by this module rather than by
 * the shared id factory because nothing outside the team surface issues them.
 */
function newInviteId(nowMillis: number): string {
  const timestamp = BigInt(Math.min(Math.max(Math.floor(nowMillis), 0), MAX_ULID_TIME));
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let entropy = 0n;
  for (const byte of random) entropy = (entropy << 8n) | BigInt(byte);
  return `inv_${encodeCrockford(timestamp, 10)}${encodeCrockford(entropy, 16)}`;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

/**
 * The audit spine records who was invited without becoming a durable copy of
 * their address: the events table is append-only, the invites table is not.
 */
async function emailHash(email: string): Promise<string> {
  return sha256Hex(`hfg.invite.email.v1:${email}`);
}

function inviteUrl(env: TeamsEnv, token: string): string | null {
  const origin = normalizedOrigin(env.APP_ORIGIN);
  if (origin === null) return null;
  return `${origin}/account?invite=${encodeURIComponent(token)}`;
}

async function createInvite(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeWrite(request, env, "admin");
  if ("response" in auth) return auth.response;
  const email = normalizedEmail(auth.body.email);
  if (email === null) return json(400, { error: "email must be a valid address" });
  const role = auth.body.role ?? "member";
  if (!isInvitableRole(role)) {
    return json(400, { error: `role must be one of ${INVITABLE_ROLES.join(", ")}` });
  }

  const workspaceId = auth.membership.workspaceId;
  const nowMillis = Date.now();
  const now = Math.floor(nowMillis / 1_000);
  const live = await env.DB.prepare(READ_LIVE_INVITE_SQL)
    .bind(workspaceId, email)
    .first<{ id: string; expires_at: number }>();
  if (live !== null && live.expires_at > now) {
    return json(409, { error: "invite_pending", invite_id: live.id });
  }

  const token = `hfg_invite_${randomSecret()}`;
  const inviteId = newInviteId(nowMillis);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + INVITE_TTL_SECONDS;
  const audit: AuditInput = {
    kind: "team.invite.created",
    actorUserId: auth.session.userId,
    payload: {
      invite_id: inviteId,
      role,
      email_hash: await emailHash(email),
      expires_at: expiresAt,
    },
  };

  const commit = await commitAudited(
    env.DB,
    workspaceId,
    () => [
      // Sweeping the caller's own expired link keeps the one-live-invite
      // uniqueness index from stranding an address forever.
      env.DB.prepare(SWEEP_EXPIRED_INVITE_SQL).bind(workspaceId, email, now),
      env.DB.prepare(INSERT_INVITE_SQL).bind(
        inviteId,
        workspaceId,
        email,
        role,
        tokenHash,
        auth.session.userId,
        now,
        expiresAt,
      ),
    ],
    [audit],
    nowMillis,
  );
  if (!commit.ok) return commit.response;

  // The raw token exists only in this response, exactly like a device token.
  return json(201, {
    invite: {
      id: inviteId,
      email,
      role,
      expires_at: expiresAt,
      token,
      invite_url: inviteUrl(env, token),
    },
    warning: "Copy this invite link now. It cannot be shown again.",
  });
}

async function revokeInvite(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeWrite(request, env, "admin");
  if ("response" in auth) return auth.response;
  const inviteId = auth.body.invite_id;
  if (typeof inviteId !== "string" || !INVITE_ID_PATTERN.test(inviteId)) {
    return json(404, { error: "not found" });
  }
  const workspaceId = auth.membership.workspaceId;
  const invite = await env.DB.prepare(READ_INVITE_BY_ID_SQL)
    .bind(inviteId, workspaceId)
    .first<{
      id: string;
      workspace_id: string;
      email: string;
      role: string;
      expires_at: number;
      accepted_at: number | null;
      revoked_at: number | null;
    }>();
  if (invite === null) return json(404, { error: "not found" });
  const denial = scopeDenial({
    resourceWorkspaceId: invite.workspace_id,
    tokenWorkspaceId: workspaceId,
  });
  if (denial !== null) return json(denial.status, { error: denial.error });
  if (invite.accepted_at !== null || invite.revoked_at !== null) {
    return json(409, { error: "invite_not_pending" });
  }

  const nowMillis = Date.now();
  const now = Math.floor(nowMillis / 1_000);
  const commit = await commitAudited(
    env.DB,
    workspaceId,
    () => [env.DB.prepare(REVOKE_INVITE_SQL).bind(inviteId, workspaceId, now)],
    [{
      kind: "team.invite.revoked",
      actorUserId: auth.session.userId,
      payload: {
        invite_id: inviteId,
        role: invite.role,
        email_hash: await emailHash(invite.email),
      },
    }],
    nowMillis,
  );
  if (!commit.ok) return commit.response;
  return json(200, { ok: true, invite_id: inviteId });
}

async function acceptInvite(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  const body = await readAccountJsonBody(request);
  if (body === null) return json(400, { error: "invalid request body" });
  const token = body.token;
  if (typeof token !== "string" || !INVITE_TOKEN_PATTERN.test(token)) {
    return json(404, { error: "not found" });
  }
  const invite = await env.DB.prepare(READ_INVITE_BY_TOKEN_SQL)
    .bind(await sha256Hex(token))
    .first<InviteTokenRow>();
  // An unknown token and a revoked one are indistinguishable by design.
  if (invite === null || invite.revoked_at !== null) return json(404, { error: "not found" });

  const nowMillis = Date.now();
  const now = Math.floor(nowMillis / 1_000);
  if (invite.accepted_at !== null) {
    // Idempotent replay for the accepting user only.
    if (invite.accepted_by !== auth.session.userId) return json(404, { error: "not found" });
    const existing = await requireRole(env.DB, invite.workspace_id, auth.session.userId, "viewer");
    if (!existing.ok) return json(existing.status, { error: existing.error });
    return json(200, {
      workspace: { id: invite.workspace_id, name: invite.workspace_name },
      role: existing.membership.role,
      already_member: true,
    });
  }
  if (invite.expires_at <= now) return json(403, { error: "invite_expired" });
  // An invite is bound to the verified address it was issued for, so a
  // forwarded link cannot be redeemed by a different account.
  if (invite.email.toLowerCase() !== auth.session.email.toLowerCase()) {
    return json(403, { error: "invite_email_mismatch" });
  }
  if (!isInvitableRole(invite.role)) return json(409, { error: "invite_not_pending" });

  const workspaceId = invite.workspace_id;
  const emailDigest = await emailHash(invite.email.toLowerCase());
  const commit = await commitAudited(
    env.DB,
    workspaceId,
    () => [
      env.DB.prepare(ACCEPT_INVITE_SQL).bind(invite.id, workspaceId, now, auth.session.userId),
      env.DB.prepare(UPSERT_MEMBER_SQL).bind(workspaceId, auth.session.userId, invite.role, now),
    ],
    [
      {
        kind: "team.invite.accepted",
        actorUserId: auth.session.userId,
        payload: { invite_id: invite.id, role: invite.role, email_hash: emailDigest },
      },
      {
        kind: "team.member.added",
        actorUserId: auth.session.userId,
        payload: {
          invite_id: invite.id,
          role: invite.role,
          target_user_id: auth.session.userId,
        },
      },
    ],
    nowMillis,
  );
  if (!commit.ok) return commit.response;
  return json(200, {
    workspace: { id: workspaceId, name: invite.workspace_name },
    role: invite.role,
    already_member: false,
  });
}

// -- members ------------------------------------------------------------------

const READ_MEMBER_SQL = `
  /* teams:read-member */
  SELECT workspace_id, user_id, role, status
  FROM workspace_members
  WHERE workspace_id = ?1 AND user_id = ?2
  LIMIT 1`;

const COUNT_OWNERS_SQL = `
  /* teams:count-owners */
  SELECT COUNT(*) AS owners
  FROM workspace_members
  WHERE workspace_id = ?1 AND role = 'owner' AND status = 'active'`;

const UPDATE_MEMBER_ROLE_SQL = `
  /* teams:update-member-role */
  UPDATE workspace_members
  SET role = ?4
  WHERE workspace_id = ?1 AND user_id = ?2 AND status = 'active' AND role = ?3`;

const REMOVE_MEMBER_SQL = `
  /* teams:remove-member */
  UPDATE workspace_members
  SET status = 'removed'
  WHERE workspace_id = ?1 AND user_id = ?2 AND status = 'active' AND role = ?3`;

interface TargetMemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  status: string;
}

async function readTarget(
  db: D1DatabaseLike,
  workspaceId: string,
  userId: unknown,
): Promise<{ userId: string; role: WorkspaceRole } | Response> {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    return json(404, { error: "not found" });
  }
  const row = await db.prepare(READ_MEMBER_SQL).bind(workspaceId, userId).first<TargetMemberRow>();
  if (row === null || row.status !== "active" || !isWorkspaceRole(row.role)) {
    return json(404, { error: "not found" });
  }
  const denial = scopeDenial({
    resourceWorkspaceId: row.workspace_id,
    tokenWorkspaceId: workspaceId,
  });
  if (denial !== null) return json(denial.status, { error: denial.error });
  return { userId, role: row.role };
}

async function activeOwnerCount(db: D1DatabaseLike, workspaceId: string): Promise<number> {
  const row = await db.prepare(COUNT_OWNERS_SQL).bind(workspaceId).first<{ owners: number }>();
  return row === null || !Number.isSafeInteger(row.owners) ? 0 : row.owners;
}

async function changeMemberRole(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeWrite(request, env, "admin");
  if ("response" in auth) return auth.response;
  const nextRole = auth.body.role;
  if (!isWorkspaceRole(nextRole)) {
    return json(400, { error: `role must be one of ${WORKSPACE_ROLES.join(", ")}` });
  }
  const workspaceId = auth.membership.workspaceId;
  const target = await readTarget(env.DB, workspaceId, auth.body.user_id);
  if (target instanceof Response) return target;
  const targetUserId = target.userId;

  // Only an owner may create or unseat another owner; an admin manages the
  // roles beneath its own authority.
  if (
    auth.membership.role !== "owner" &&
    (nextRole === "owner" || target.role === "owner")
  ) {
    return json(403, { error: "forbidden" });
  }
  if (target.role === nextRole) {
    return json(200, { ok: true, user_id: targetUserId, role: nextRole, changed: false });
  }
  if (target.role === "owner" && (await activeOwnerCount(env.DB, workspaceId)) <= 1) {
    return json(409, { error: "last_owner_protected" });
  }

  const nowMillis = Date.now();
  const commit = await commitAudited(
    env.DB,
    workspaceId,
    () => [
      env.DB.prepare(UPDATE_MEMBER_ROLE_SQL)
        .bind(workspaceId, targetUserId, target.role, nextRole),
    ],
    [{
      kind: "team.member.role_changed",
      actorUserId: auth.session.userId,
      payload: {
        target_user_id: targetUserId,
        from_role: target.role,
        role: nextRole,
      },
    }],
    nowMillis,
  );
  if (!commit.ok) return commit.response;
  return json(200, { ok: true, user_id: targetUserId, role: nextRole, changed: true });
}

async function removeMember(request: Request, env: TeamsEnv): Promise<Response> {
  // Leaving a workspace is a member-level action; removing somebody else is
  // not, so authorization starts at the lowest role and tightens below.
  const auth = await authorizeWrite(request, env, "viewer");
  if ("response" in auth) return auth.response;
  const workspaceId = auth.membership.workspaceId;
  const target = await readTarget(env.DB, workspaceId, auth.body.user_id);
  if (target instanceof Response) return target;
  const targetUserId = target.userId;
  const isSelf = targetUserId === auth.session.userId;

  if (!isSelf && !meetsRole(auth.membership.role, "admin")) {
    return json(403, { error: "forbidden" });
  }
  if (!isSelf && target.role === "owner" && auth.membership.role !== "owner") {
    return json(403, { error: "forbidden" });
  }
  if (target.role === "owner" && (await activeOwnerCount(env.DB, workspaceId)) <= 1) {
    return json(409, { error: "last_owner_protected" });
  }

  const nowMillis = Date.now();
  const commit = await commitAudited(
    env.DB,
    workspaceId,
    () => [
      env.DB.prepare(REMOVE_MEMBER_SQL).bind(workspaceId, targetUserId, target.role),
    ],
    [{
      kind: "team.member.removed",
      actorUserId: auth.session.userId,
      payload: {
        target_user_id: targetUserId,
        role: target.role,
        self_leave: isSelf,
      },
    }],
    nowMillis,
  );
  if (!commit.ok) return commit.response;
  return json(200, { ok: true, user_id: targetUserId, self_leave: isSelf });
}

// -- GET /v1/workspace/audit --------------------------------------------------

const LIST_AUDIT_SQL = `
  /* teams:list-audit */
  SELECT c.seq, c.event_id, c.content_hash, c.prev_hash, c.created_at,
         e.kind, e.occurred_at, e.raw_json
  FROM audit_chain AS c
  JOIN events AS e ON e.workspace_id = c.workspace_id AND e.event_id = c.event_id
  WHERE c.workspace_id = ?1
  ORDER BY c.seq DESC
  LIMIT ?2`;

const LIST_AUDIT_AFTER_SQL = `
  /* teams:list-audit-after */
  SELECT c.seq, c.event_id, c.content_hash, c.prev_hash, c.created_at,
         e.kind, e.occurred_at, e.raw_json
  FROM audit_chain AS c
  JOIN events AS e ON e.workspace_id = c.workspace_id AND e.event_id = c.event_id
  WHERE c.workspace_id = ?1 AND c.seq < ?2
  ORDER BY c.seq DESC
  LIMIT ?3`;

interface AuditRow {
  seq: number;
  event_id: string;
  content_hash: string;
  prev_hash: string | null;
  created_at: number;
  kind: string;
  occurred_at: string;
  raw_json: string;
}

export interface AuditEntry {
  seq: number;
  event_id: string;
  kind: string;
  occurred_at: string;
  content_hash: string;
  prev_content_hash: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
}

function auditEntry(row: AuditRow): AuditEntry {
  let document: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.raw_json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  } catch {
    // A row that cannot be parsed still reports its chain position and hashes.
  }
  const audit = document.audit;
  const actor =
    audit !== null && typeof audit === "object" && !Array.isArray(audit)
      ? (audit as Record<string, unknown>).actor_user_id
      : null;
  const payload = document.payload;
  return {
    seq: row.seq,
    event_id: row.event_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    content_hash: `sha256:${row.content_hash}`,
    prev_content_hash: row.prev_hash === null ? null : `sha256:${row.prev_hash}`,
    actor_user_id: typeof actor === "string" ? actor : null,
    payload:
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {},
  };
}

/**
 * Verify the returned page links to itself: entry N's prev_hash must be entry
 * N-1's content_hash, and seq must be dense. This is a read-side proof over
 * what was actually stored, not a restatement of what the writer intended.
 */
export function verifyAuditPage(entries: AuditEntry[]): boolean {
  for (let index = 0; index + 1 < entries.length; index += 1) {
    const newer = entries[index];
    const older = entries[index + 1];
    if (newer.seq !== older.seq + 1) return false;
    if (newer.prev_content_hash !== older.content_hash) return false;
  }
  const oldest = entries[entries.length - 1];
  if (oldest !== undefined && oldest.seq === 0 && oldest.prev_content_hash !== null) return false;
  return true;
}

async function listAudit(request: Request, env: TeamsEnv): Promise<Response> {
  const auth = await authorizeRead(request, env, "admin");
  if ("response" in auth) return auth.response;
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const result =
    cursor === null
      ? await env.DB.prepare(LIST_AUDIT_SQL)
          .bind(auth.membership.workspaceId, limit + 1)
          .all<AuditRow>()
      : await env.DB.prepare(LIST_AUDIT_AFTER_SQL)
          .bind(auth.membership.workspaceId, cursor.createdAt, limit + 1)
          .all<AuditRow>();
  // seq is the workspace's total order, so it — not wall-clock time — is both
  // the sort key and the cursor.
  const rows = [...result.results].sort((a, b) => b.seq - a.seq);
  const entries = rows.slice(0, limit).map(auditEntry);
  const last = entries[entries.length - 1];
  return json(200, {
    items: entries,
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.seq, id: last.event_id })
        : null,
    chain_verified: verifyAuditPage(entries),
  });
}

// -- routing ------------------------------------------------------------------

/**
 * Route the team surface. Returns null when this module does not own the
 * path, so index.ts continues to the device API; a wrong method on a path
 * owned here also returns null and lands on the shared 404.
 */
export async function handleTeamsRoute(
  request: Request,
  env: TeamsEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (method === "GET" && pathname === "/v1/workspaces") return listWorkspaces(request, env);
  if (method === "GET" && pathname === "/v1/workspace/members") {
    return listMembers(request, env);
  }
  if (method === "POST" && pathname === "/v1/workspace/members/role") {
    return changeMemberRole(request, env);
  }
  if (method === "POST" && pathname === "/v1/workspace/members/remove") {
    return removeMember(request, env);
  }
  if (method === "GET" && pathname === "/v1/workspace/invites") return listInvites(request, env);
  if (method === "POST" && pathname === "/v1/workspace/invites") {
    return createInvite(request, env);
  }
  if (method === "POST" && pathname === "/v1/workspace/invites/revoke") {
    return revokeInvite(request, env);
  }
  if (method === "POST" && pathname === "/v1/workspace/invites/accept") {
    return acceptInvite(request, env);
  }
  if (method === "GET" && pathname === "/v1/workspace/audit") return listAudit(request, env);
  return null;
}
