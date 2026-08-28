// HandoffGraph Enterprise — SSO, SCIM, data masking, audit export (parity row 48).
//
// PROPRIETARY. See platform/ee/LICENSE. Not covered by the repository's OSS
// license. Everything under platform/ee/ is Enterprise; everything outside it
// is not.
//
// -- THE FENCE ---------------------------------------------------------------
//
// Three mechanisms, and only three, keep the tiers apart. The plan calls this
// "separate directory, separate license, flags — never license soup", meaning
// no per-file license headers scattered through src/, no #ifdef-style
// conditionals inside OSS modules, and no build variants.
//
//   1. DIRECTORY. Every line of Enterprise code lives under platform/ee/.
//      Nothing in platform/src/ implements an EE feature.
//
//   2. LICENSE. platform/ee/LICENSE covers this directory and nothing else.
//      Because the boundary is a directory, "which license covers this file?"
//      is answered by its path alone.
//
//   3. FLAG. handleEERoute returns null — not 403, not 404, null — unless
//      env.EE_ENABLED === "true". Returning null hands the request back to
//      index.ts's dispatch chain, which falls through to the platform-wide
//      404. So with the flag absent (the default), /v1/ee/* and /v1/assistant
//      are indistinguishable from any URL this Worker has never heard of:
//      same status, same body bytes, same headers. That is the acceptance
//      gate "OSS baseline intact behind flags", and test/ee.test.ts asserts it
//      byte-for-byte rather than merely asserting 404.
//
// The dependency arrow points one way: ee/ imports from src/, src/ never
// imports from ee/ except for the single `handleEERoute` seam in index.ts
// (one import, one delegation pair). If that arrow ever reverses, the fence is
// gone.
//
// -- WHAT IS REAL AND WHAT IS A SEAM -----------------------------------------
//
// SSO stores the WorkOS Organization binding for a workspace. It deliberately
// does not reimplement the SSO dance: WorkOS AuthKit already performs it, and
// a SAML/OIDC login lands on the same /v1/auth/callback as a password login
// (src/account.ts). What was missing was the org binding an admin needs to
// point their IdP at, and a place for the admin surface to read setup state.
//
// SCIM is a real SCIM 2.0 subset: bearer-token auth, a ListResponse over
// workspace members, the `userName eq "..."` filter every directory sends
// before provisioning, and a POST that creates a workspace invite through the
// same audited, hash-chained flow src/teams.ts uses. It is NOT a full
// directory: PATCH, DELETE, deprovisioning, and Groups are not implemented.
//
// Masking is a complete, deterministic, fail-closed pure function plus its
// CRUD surface. WIRING IT INTO INGEST IS DELIBERATELY OUT OF SCOPE — nothing
// in src/ingest.ts is touched by this slice. The follow-up is a single call
// site in the ingest path; see docs/ee.md "Follow-up: wiring masking into
// ingest".
//
// Audit export is a convenience surface, not new evidence. The tamper-evident
// hash chain already lives on the spine (src/teams.ts buildAuditRecords +
// the audit_chain triggers in migration 0004). This streams those events out
// verbatim as NDJSON so a SIEM can consume them.

import { extractBearerToken, sha256Hex } from "../../src/auth";
import {
  authenticateAccountSession,
  authorizedUnsafeRequest,
  normalizedOrigin,
  randomSecret,
  readAccountJsonBody,
  type AccountEnv,
  type SessionAccount,
} from "../../src/account";
import type { ApiKeysEnv } from "../../src/apikeys";
import type { D1BoundStatement, D1DatabaseLike } from "../../src/db";
import type { FetchLike, GatewayEnv } from "../../src/gateway";
import { canonicalJsonStringify, encodeCursor, parsePagination } from "../../src/ingest";
import {
  TEAM_EVENT_KINDS,
  buildAuditRecords,
  isInvitableRole,
  requireRole,
  type AuditInput,
  type AuditRecord,
  type InvitableRole,
  type WorkspaceRole,
} from "../../src/teams";
import { ASSISTANT_PATH, handleAssistantRoute, type AssistantModelCall } from "./assistant";

export { ASSISTANT_PATH } from "./assistant";

// -- env ----------------------------------------------------------------------

/**
 * EE_ENABLED is a plain [vars] string, not a secret and not a binding: the
 * fence must be readable without any resource existing, so a deployment with
 * no EE licence needs no configuration at all. Absent (the default) means off.
 */
export interface EEEnv extends AccountEnv, ApiKeysEnv, GatewayEnv {
  EE_ENABLED?: string;
}

/** The single predicate every EE route is gated on. */
export function eeEnabled(env: EEEnv): boolean {
  return env.EE_ENABLED === "true";
}

// -- paths ---------------------------------------------------------------------

const EE_PREFIX = "/v1/ee/";
const SSO_PATH = "/v1/ee/sso";
const SCIM_TOKEN_PATH = "/v1/ee/scim/token";
const SCIM_BASE_PATH = "/v1/ee/scim/v2";
const SCIM_USERS_PATH = `${SCIM_BASE_PATH}/Users`;
const MASKING_RULES_PATH = "/v1/ee/masking-rules";
const MASKING_RULE_PATTERN = /^\/v1\/ee\/masking-rules\/(msk_[0-7][0-9A-HJKMNP-TV-Z]{25})$/;
const AUDIT_EXPORT_PATH = "/v1/ee/audit/export";

// -- responses -------------------------------------------------------------------

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// SCIM defines its own media type and its own error envelope; a directory
// client parses `detail`/`scimType`, not our `{error}` shape.
const SCIM_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/scim+json; charset=utf-8",
};

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

function scim(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: SCIM_HEADERS });
}

function scimError(status: number, detail: string, scimType?: string): Response {
  const body: Record<string, unknown> = {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
  };
  if (scimType !== undefined) body.scimType = scimType;
  return scim(status, body);
}

// -- ids ---------------------------------------------------------------------------

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

function prefixedUlid(prefix: string, nowMillis: number): string {
  const timestamp = BigInt(Math.min(Math.max(Math.floor(nowMillis), 0), MAX_ULID_TIME));
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let entropy = 0n;
  for (const byte of random) entropy = (entropy << 8n) | BigInt(byte);
  return `${prefix}${encodeCrockford(timestamp, 10)}${encodeCrockford(entropy, 16)}`;
}

/** `msk_<ulid>`; the CHECK in migration 0016 repeats the shape. */
function newMaskingRuleId(nowMillis: number): string {
  return prefixedUlid("msk_", nowMillis);
}

/** `inv_<ulid>`; teams.ts owns the same minting rule but does not export it. */
function newInviteId(nowMillis: number): string {
  return prefixedUlid("inv_", nowMillis);
}

// -- account-plane authorization ---------------------------------------------------
//
// src/teams.ts has private authorizeRead/authorizeWrite helpers with exactly
// this shape. They are not exported, so the two below are the minimal
// equivalents built from what IS exported (authenticateAccountSession,
// authorizedUnsafeRequest, requireRole). They must stay behaviorally identical
// to teams.ts's: no membership => 404 (never confirm a workspace exists),
// membership below the minimum role => 403.

async function authorizeEERead(
  request: Request,
  env: EEEnv,
  minimum: WorkspaceRole,
): Promise<{ session: SessionAccount; workspaceId: string } | { response: Response }> {
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return { response: json(401, { error: "unauthorized" }) };
  const check = await requireRole(env.DB, session.workspaceId, session.userId, minimum);
  if (!check.ok) return { response: json(check.status, { error: check.error }) };
  return { session, workspaceId: check.membership.workspaceId };
}

async function authorizeEEWrite(
  request: Request,
  env: EEEnv,
  minimum: WorkspaceRole,
  /** False for actions whose whole input is the URL (e.g. minting a token). */
  requireBody = true,
): Promise<
  | { session: SessionAccount; workspaceId: string; body: Record<string, unknown> }
  | { response: Response }
> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return { response: auth.response };
  const { session } = auth;
  const check = await requireRole(env.DB, session.workspaceId, session.userId, minimum);
  if (!check.ok) return { response: json(check.status, { error: check.error }) };
  const body = await readAccountJsonBody(request);
  if (body === null && requireBody) {
    return { response: json(400, { error: "request body must be a JSON object" }) };
  }
  return { session, workspaceId: check.membership.workspaceId, body: body ?? {} };
}

// =============================================================================
// SSO — GET/PUT /v1/ee/sso
// =============================================================================

const READ_SSO_SQL = `
  /* ee:read-sso */
  SELECT workspace_id, workos_org_id, connection_state, updated_at
  FROM ee_sso_connections
  WHERE workspace_id = ?1`;

const UPSERT_SSO_SQL = `
  /* ee:upsert-sso */
  INSERT INTO ee_sso_connections
    (workspace_id, workos_org_id, connection_state, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(workspace_id) DO UPDATE SET
    workos_org_id = excluded.workos_org_id,
    connection_state = excluded.connection_state,
    updated_at = excluded.updated_at`;

interface SsoRow {
  workspace_id: string;
  workos_org_id: string;
  connection_state: string;
  updated_at: number;
}

/**
 * Stored states are 'pending' and 'active' only (migration 0016's CHECK).
 * 'unlinked' is synthesized on read when no row exists, so the API always has
 * a state to report without the table carrying an "absent" row.
 */
export const SSO_CONNECTION_STATES = ["pending", "active"] as const;
export type SsoConnectionState = (typeof SSO_CONNECTION_STATES)[number];

const WORKOS_ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function ssoView(row: SsoRow | null, workspaceId: string, env: EEEnv): Record<string, unknown> {
  return {
    sso: {
      workspace_id: workspaceId,
      workos_org_id: row === null ? null : row.workos_org_id,
      connection_state: row === null ? "unlinked" : row.connection_state,
      updated_at: row === null ? null : row.updated_at,
    },
    setup: {
      // The SSO dance itself is AuthKit's. This surface only records the
      // binding, so what a setup UI needs is where to point the IdP.
      provider: "workos",
      redirect_uri: env.WORKOS_REDIRECT_URI ?? null,
      next_step:
        row === null
          ? "Create a WorkOS Organization, then PUT its id here."
          : row.connection_state === "pending"
            ? "Finish the connection in the WorkOS dashboard, then PUT connection_state 'active'."
            : "Connected. Members signing in through the IdP land on the existing account callback.",
    },
  };
}

async function getSso(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEERead(request, env, "admin");
  if ("response" in auth) return auth.response;
  const row = await env.DB.prepare(READ_SSO_SQL).bind(auth.workspaceId).first<SsoRow>();
  return json(200, ssoView(row, auth.workspaceId, env));
}

async function putSso(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEEWrite(request, env, "owner");
  if ("response" in auth) return auth.response;
  const orgId = auth.body.workos_org_id;
  if (typeof orgId !== "string" || !WORKOS_ORG_ID_PATTERN.test(orgId)) {
    return json(400, { error: "workos_org_id must be 1-200 characters of [A-Za-z0-9_-]" });
  }
  const stateRaw = auth.body.connection_state ?? "pending";
  if (!(SSO_CONNECTION_STATES as readonly unknown[]).includes(stateRaw)) {
    return json(400, { error: `connection_state must be one of ${SSO_CONNECTION_STATES.join(", ")}` });
  }
  const state = stateRaw as SsoConnectionState;
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(UPSERT_SSO_SQL).bind(auth.workspaceId, orgId, state, now).run();
  return json(200, ssoView(
    { workspace_id: auth.workspaceId, workos_org_id: orgId, connection_state: state, updated_at: now },
    auth.workspaceId,
    env,
  ));
}

// =============================================================================
// SCIM — POST /v1/ee/scim/token, GET/POST /v1/ee/scim/v2/Users
// =============================================================================

const SCIM_TOKEN_PREFIX = "scim_";
const SCIM_TOKEN_PATTERN = /^scim_[\w-]{43}$/;
const SCIM_MAX_COUNT = 200;
const SCIM_DEFAULT_COUNT = 100;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // mirrors teams.ts

const REVOKE_LIVE_SCIM_TOKENS_SQL = `
  /* ee:revoke-live-scim-tokens */
  UPDATE ee_scim_tokens
  SET revoked_at = ?2
  WHERE workspace_id = ?1 AND revoked_at IS NULL`;

const INSERT_SCIM_TOKEN_SQL = `
  /* ee:insert-scim-token */
  INSERT INTO ee_scim_tokens (workspace_id, token_hash, created_at, revoked_at)
  VALUES (?1, ?2, ?3, NULL)`;

const READ_SCIM_TOKEN_SQL = `
  /* ee:read-scim-token */
  SELECT workspace_id
  FROM ee_scim_tokens
  WHERE token_hash = ?1 AND revoked_at IS NULL
  LIMIT 1`;

/**
 * One live directory credential per workspace: issuing revokes the previous
 * ones in the same batch. Okta/Entra hold exactly one token, and bounding the
 * live set means a leaked-and-forgotten token cannot linger. Revoked rows stay
 * for history, and the schema permits several live rows so a future overlapping
 * rotation is a code change rather than a migration.
 */
async function createScimToken(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEEWrite(request, env, "owner", false);
  if ("response" in auth) return auth.response;
  const token = `${SCIM_TOKEN_PREFIX}${randomSecret()}`;
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.batch([
    env.DB.prepare(REVOKE_LIVE_SCIM_TOKENS_SQL).bind(auth.workspaceId, now),
    env.DB.prepare(INSERT_SCIM_TOKEN_SQL).bind(auth.workspaceId, await sha256Hex(token), now),
  ]);
  // Same discipline as a device token or an invite link: the raw credential
  // exists only in this response and is never persisted or logged.
  const origin = normalizedOrigin(env.APP_ORIGIN);
  return json(201, {
    scim_token: {
      token,
      created_at: now,
      // The SCIM base URL an IdP is configured with: the /Users collection
      // hangs off it. Null rather than a relative path when APP_ORIGIN is
      // unset, so an admin never pastes a half-formed URL into Okta.
      base_url: origin === null ? null : `${origin}${SCIM_BASE_PATH}`,
    },
    warning: "Copy this token now. It cannot be shown again. Issuing a new token revokes this one.",
  });
}

/** Resolve a `scim_` bearer to its workspace, or a SCIM 401. */
async function authenticateScim(
  request: Request,
  env: EEEnv,
): Promise<{ workspaceId: string } | { response: Response }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (token === null || !SCIM_TOKEN_PATTERN.test(token)) {
    return { response: scimError(401, "A valid SCIM bearer token is required.") };
  }
  const row = await env.DB
    .prepare(READ_SCIM_TOKEN_SQL)
    .bind(await sha256Hex(token))
    .first<{ workspace_id: string }>();
  if (row === null || typeof row.workspace_id !== "string") {
    return { response: scimError(401, "A valid SCIM bearer token is required.") };
  }
  return { workspaceId: row.workspace_id };
}

// teams.ts's LIST_MEMBERS_SQL is private; this is the SCIM-shaped equivalent.
// SCIM pages by 1-based startIndex/count rather than by opaque cursor, so the
// ordering must be a stable total order — user_id is unique per workspace.
const SCIM_LIST_USERS_SQL = `
  /* ee:scim-list-users */
  SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
  FROM workspace_members AS m
  JOIN users AS u ON u.id = m.user_id
  WHERE m.workspace_id = ?1 AND m.status = 'active' AND u.status = 'active'
  ORDER BY m.user_id ASC
  LIMIT ?2 OFFSET ?3`;

const SCIM_LIST_USERS_FILTERED_SQL = `
  /* ee:scim-list-users-filtered */
  SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
  FROM workspace_members AS m
  JOIN users AS u ON u.id = m.user_id
  WHERE m.workspace_id = ?1 AND m.status = 'active' AND u.status = 'active'
    AND u.email = ?4
  ORDER BY m.user_id ASC
  LIMIT ?2 OFFSET ?3`;

interface ScimMemberRow {
  user_id: string;
  role: string;
  created_at: number;
  email: string;
  display_name: string | null;
}

function scimUserResource(row: ScimMemberRow): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.user_id,
    userName: row.email,
    displayName: row.display_name,
    active: true,
    emails: [{ value: row.email, primary: true, type: "work" }],
    roles: [{ value: row.role, primary: true }],
    meta: { resourceType: "User", created: new Date(row.created_at * 1_000).toISOString() },
  };
}

/**
 * The one filter every directory actually sends before provisioning:
 * `userName eq "someone@example.com"`. Anything else is rejected with SCIM's
 * invalidFilter rather than silently ignored — silently ignoring a filter
 * makes a directory believe a user does not exist and provision a duplicate.
 */
function parseScimFilter(raw: string | null): { ok: true; userName: string | null } | { ok: false } {
  if (raw === null || raw.trim() === "") return { ok: true, userName: null };
  const match = /^\s*userName\s+eq\s+"([^"]{1,254})"\s*$/i.exec(raw);
  if (match === null) return { ok: false };
  return { ok: true, userName: match[1].trim().toLowerCase() };
}

function parseScimInteger(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d{1,9}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (value < min || value > max) return null;
  return value;
}

async function listScimUsers(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authenticateScim(request, env);
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);

  const filter = parseScimFilter(url.searchParams.get("filter"));
  if (!filter.ok) {
    return scimError(400, 'Only filters of the form: userName eq "value" are supported.', "invalidFilter");
  }
  const startIndex = parseScimInteger(url.searchParams.get("startIndex"), 1, 1, 1_000_000);
  const count = parseScimInteger(url.searchParams.get("count"), SCIM_DEFAULT_COUNT, 0, SCIM_MAX_COUNT);
  if (startIndex === null || count === null) {
    return scimError(400, `startIndex must be >= 1 and count must be 0..${SCIM_MAX_COUNT}.`, "invalidValue");
  }

  const offset = startIndex - 1;
  const result =
    filter.userName === null
      ? await env.DB.prepare(SCIM_LIST_USERS_SQL)
          .bind(auth.workspaceId, count, offset)
          .all<ScimMemberRow>()
      : await env.DB.prepare(SCIM_LIST_USERS_FILTERED_SQL)
          .bind(auth.workspaceId, count, offset, filter.userName)
          .all<ScimMemberRow>();

  // Sorted defensively as well as in SQL: deterministic output must not
  // depend on the driver preserving ORDER BY.
  const rows = [...result.results].sort((a, b) =>
    a.user_id === b.user_id ? 0 : a.user_id < b.user_id ? -1 : 1,
  );
  const resources = rows.map(scimUserResource);
  return scim(200, {
    schemas: [SCIM_LIST_SCHEMA],
    // Without a COUNT(*) round trip this page's size is all that is known.
    // SCIM permits a server to report what it returned; a client pages until
    // a short page, which this satisfies.
    totalResults: offset + resources.length,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

// -- SCIM provisioning: create an invite --------------------------------------------
//
// teams.ts's createInvite is private, as are commitAudited and the invite SQL.
// buildAuditRecords IS exported, so the hash-chain construction below is the
// real one rather than a lookalike; only the surrounding statements are
// duplicated. FLAGGED for the orchestrator: if teams.ts later exports
// commitAudited + its invite statements, delete everything between here and
// the end of createScimUser and call it directly.

const EE_READ_LIVE_INVITE_SQL = `
  /* ee:read-live-invite */
  SELECT id, expires_at
  FROM workspace_invites
  WHERE workspace_id = ?1 AND email = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL
  LIMIT 1`;

const EE_SWEEP_EXPIRED_INVITE_SQL = `
  /* ee:sweep-expired-invite */
  UPDATE workspace_invites
  SET revoked_at = ?3
  WHERE workspace_id = ?1 AND email = ?2
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?3`;

const EE_INSERT_INVITE_SQL = `
  /* ee:insert-invite */
  INSERT INTO workspace_invites
    (id, workspace_id, email, role, token_hash, created_by, created_at,
     expires_at, accepted_at, accepted_by, revoked_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL)`;

const EE_READ_AUDIT_HEAD_SQL = `
  /* ee:read-audit-head */
  SELECT seq, content_hash
  FROM audit_chain
  WHERE workspace_id = ?1
  ORDER BY seq DESC
  LIMIT 1`;

const EE_APPEND_AUDIT_EVENTS_SQL = `
  /* ee:append-audit-events */
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

const EE_APPEND_AUDIT_CHAIN_SQL = `
  /* ee:append-audit-chain */
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

// A directory has no human actor, but workspace_invites.created_by is a NOT
// NULL foreign key to users(id). The workspace's longest-standing active owner
// is the accountable party for anything the directory provisions, so the
// invite and its audit event are attributed to them. A future migration can
// pin the issuing admin onto ee_scim_tokens and use that instead.
const EE_WORKSPACE_OWNER_SQL = `
  /* ee:workspace-owner */
  SELECT m.user_id
  FROM workspace_members AS m
  JOIN users AS u ON u.id = m.user_id
  WHERE m.workspace_id = ?1 AND m.role = 'owner'
    AND m.status = 'active' AND u.status = 'active'
  ORDER BY m.created_at ASC, m.user_id ASC
  LIMIT 1`;

function auditStatements(
  db: D1DatabaseLike,
  workspaceId: string,
  records: AuditRecord[],
  nowSeconds: number,
): D1BoundStatement[] {
  const documents = canonicalJsonStringify(records.map((record) => record.document));
  const links = canonicalJsonStringify(
    records.map((record) => ({
      content_hash: record.contentHash,
      event_id: record.eventId,
      prev_hash: record.prevHash,
      seq: record.seq,
    })),
  );
  return [
    db.prepare(EE_APPEND_AUDIT_EVENTS_SQL).bind(workspaceId, nowSeconds, documents),
    db.prepare(EE_APPEND_AUDIT_CHAIN_SQL).bind(workspaceId, nowSeconds, links),
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CommitOutcome = { ok: true } | { ok: false; response: Response };

/**
 * Minimal equivalent of teams.ts's private commitAudited: the mutation and its
 * hash-chain link commit in ONE D1 batch, so an aborted chain rolls the
 * mutation back rather than leaving an unaudited change. A writer that
 * advanced the chain between the head read and the commit collides on
 * (workspace_id, seq); that is a conflict, not a failure, so it is retried
 * once against the new head before failing closed.
 */
async function commitAuditedEE(
  db: D1DatabaseLike,
  workspaceId: string,
  mutations: () => D1BoundStatement[],
  audits: AuditInput[],
  nowMillis: number,
): Promise<CommitOutcome> {
  const nowSeconds = Math.floor(nowMillis / 1_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headRow = await db.prepare(EE_READ_AUDIT_HEAD_SQL)
      .bind(workspaceId)
      .first<{ seq: number; content_hash: string }>();
    const head =
      headRow === null ||
      !Number.isSafeInteger(headRow.seq) ||
      typeof headRow.content_hash !== "string"
        ? null
        : { seq: headRow.seq, contentHash: headRow.content_hash };
    const records = await buildAuditRecords(workspaceId, head, audits, nowMillis);
    try {
      await db.batch([...mutations(), ...auditStatements(db, workspaceId, records, nowSeconds)]);
      return { ok: true };
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("seat capacity exceeded")) {
        return { ok: false, response: scimError(429, "Workspace seat capacity is exhausted.") };
      }
      if (message.includes("UNIQUE constraint failed: workspace_invites")) {
        return { ok: false, response: scimError(409, "An invite for this address is already pending.", "uniqueness") };
      }
      const chainConflict =
        message.includes("audit chain") ||
        message.includes("UNIQUE constraint failed: audit_chain") ||
        message.includes("audit_chain.seq");
      if (chainConflict && attempt === 0) continue;
      if (chainConflict) {
        return { ok: false, response: scimError(503, "The audit trail is temporarily unavailable.") };
      }
      throw error;
    }
  }
  return { ok: false, response: scimError(503, "The audit trail is temporarily unavailable.") };
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Same derivation teams.ts uses, so both surfaces produce the same hash. */
async function inviteEmailHash(email: string): Promise<string> {
  return sha256Hex(`hfg.invite.email.v1:${email}`);
}

/**
 * SCIM's `roles` is a multi-valued attribute of `{value}` objects. Absent or
 * unrecognized means 'member' — the least privilege an invite can confer.
 * 'owner' is never invitable (migration 0004 enforces the same set).
 */
function roleFromScimBody(body: Record<string, unknown>): InvitableRole {
  const roles = body.roles;
  if (!Array.isArray(roles) || roles.length === 0) return "member";
  const first: unknown = roles[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return "member";
  const value = (first as Record<string, unknown>).value;
  return isInvitableRole(value) ? value : "member";
}

function scimDisplayName(body: Record<string, unknown>): string | null {
  const display = body.displayName;
  if (typeof display === "string" && display.trim() !== "") return display.trim().slice(0, 200);
  const name = body.name;
  if (name !== null && typeof name === "object" && !Array.isArray(name)) {
    const record = name as Record<string, unknown>;
    const parts = [record.givenName, record.familyName]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .trim();
    if (parts !== "") return parts.slice(0, 200);
  }
  return null;
}

async function createScimUser(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authenticateScim(request, env);
  if ("response" in auth) return auth.response;
  const body = await readAccountJsonBody(request);
  if (body === null) return scimError(400, "Request body must be a SCIM User JSON object.", "invalidSyntax");

  const email = normalizedEmail(body.userName);
  if (email === null) return scimError(400, "userName must be a valid email address.", "invalidValue");
  const role = roleFromScimBody(body);
  const displayName = scimDisplayName(body);

  const workspaceId = auth.workspaceId;
  const nowMillis = Date.now();
  const now = Math.floor(nowMillis / 1_000);

  const live = await env.DB.prepare(EE_READ_LIVE_INVITE_SQL)
    .bind(workspaceId, email)
    .first<{ id: string; expires_at: number }>();
  if (live !== null && live.expires_at > now) {
    return scimError(409, "An invite for this address is already pending.", "uniqueness");
  }

  const owner = await env.DB.prepare(EE_WORKSPACE_OWNER_SQL)
    .bind(workspaceId)
    .first<{ user_id: string }>();
  if (owner === null || typeof owner.user_id !== "string") {
    // Fail closed: an invite with no accountable creator is not written.
    return scimError(409, "This workspace has no active owner to attribute the invite to.");
  }

  const token = `hfg_invite_${randomSecret()}`;
  const inviteId = newInviteId(nowMillis);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + INVITE_TTL_SECONDS;
  const audit: AuditInput = {
    kind: "team.invite.created",
    actorUserId: owner.user_id,
    payload: {
      invite_id: inviteId,
      role,
      email_hash: await inviteEmailHash(email),
      expires_at: expiresAt,
      // How this invite arrived is itself audit-relevant.
      source: "scim",
    },
  };

  const commit = await commitAuditedEE(
    env.DB,
    workspaceId,
    () => [
      env.DB.prepare(EE_SWEEP_EXPIRED_INVITE_SQL).bind(workspaceId, email, now),
      env.DB.prepare(EE_INSERT_INVITE_SQL).bind(
        inviteId,
        workspaceId,
        email,
        role,
        tokenHash,
        owner.user_id,
        now,
        expiresAt,
      ),
    ],
    [audit],
    nowMillis,
  );
  if (!commit.ok) return commit.response;

  // A provisioned-but-unaccepted member is `active: false` in SCIM terms: the
  // invite exists, the account does not yet. The raw invite token is NOT in
  // this response — a directory has no use for it and SCIM responses are
  // widely logged by IdPs.
  return scim(201, {
    schemas: [SCIM_USER_SCHEMA],
    id: inviteId,
    userName: email,
    displayName,
    active: false,
    emails: [{ value: email, primary: true, type: "work" }],
    roles: [{ value: role, primary: true }],
    meta: {
      resourceType: "User",
      created: new Date(now * 1_000).toISOString(),
      location: `${SCIM_USERS_PATH}/${inviteId}`,
    },
  });
}

// =============================================================================
// DATA MASKING — CRUD + the pure function
// =============================================================================

export const MASKING_ACTIONS = ["hash", "drop"] as const;
export type MaskingAction = (typeof MASKING_ACTIONS)[number];

export interface MaskingRule {
  field_pattern: string;
  action: MaskingAction;
}

export type MaskingResult =
  | { ok: true; value: unknown; hashed: string[]; dropped: string[] }
  | { ok: false; error: string };

const MAX_PATTERN_BYTES = 200;
const MAX_MASK_DEPTH = 32;
const MAX_MASK_NODES = 10_000;

/**
 * A pattern segment is either `**` (matching zero or more whole path
 * segments) or a token of [A-Za-z0-9_-] in which `*` matches any run of
 * characters within one segment. Nothing else is accepted: an unrecognized
 * character is a rejected rule, not a literal.
 */
const SEGMENT_TOKEN_PATTERN = /^[A-Za-z0-9_*-]+$/;

interface CompiledRule {
  segments: string[];
  action: MaskingAction;
  pattern: string;
}

/**
 * Validate one rule's pattern. Exported because POST /v1/ee/masking-rules
 * must reject a bad pattern at write time — a rule that cannot compile would
 * otherwise poison every later applyMaskingRules call for that workspace, and
 * failing closed there means dropping real telemetry.
 */
export function compileMaskingRule(rule: MaskingRule): { ok: true; value: CompiledRule } | { ok: false; error: string } {
  const pattern = rule.field_pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, error: "field_pattern must be a non-empty string" };
  }
  if (new TextEncoder().encode(pattern).byteLength > MAX_PATTERN_BYTES) {
    return { ok: false, error: `field_pattern must be at most ${MAX_PATTERN_BYTES} bytes` };
  }
  if (!(MASKING_ACTIONS as readonly unknown[]).includes(rule.action)) {
    return { ok: false, error: `action must be one of ${MASKING_ACTIONS.join(", ")}` };
  }
  const segments = pattern.split(".");
  for (const segment of segments) {
    if (segment === "**") continue;
    if (segment.length === 0) {
      return { ok: false, error: "field_pattern must not contain an empty path segment" };
    }
    if (!SEGMENT_TOKEN_PATTERN.test(segment)) {
      return {
        ok: false,
        error: "field_pattern segments accept only A-Z a-z 0-9 _ - and the * wildcard",
      };
    }
  }
  return { ok: true, value: { segments, action: rule.action, pattern } };
}

/** Classic within-segment glob: `*` matches any run of characters. */
function globMatches(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  const parts = pattern.split("*");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  if (!text.endsWith(last)) return false;
  let index = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const found = text.indexOf(parts[i], index);
    if (found === -1) return false;
    index = found + parts[i].length;
  }
  // The trailing literal must not overlap what the middle literals consumed.
  return index <= text.length - last.length;
}

/**
 * Segment-array match with `**` spanning zero or more segments. Memoized on
 * (patternIndex, pathIndex) so a pattern full of `**` cannot blow up: the
 * table is bounded by pattern length x path depth.
 */
function pathMatches(patternSegments: string[], pathSegments: string[]): boolean {
  const memo = new Map<number, boolean>();
  const width = pathSegments.length + 1;
  const walk = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === patternSegments.length) {
      result = j === pathSegments.length;
    } else if (patternSegments[i] === "**") {
      result = false;
      for (let k = j; k <= pathSegments.length; k += 1) {
        if (walk(i + 1, k)) {
          result = true;
          break;
        }
      }
    } else {
      result = j < pathSegments.length && globMatches(patternSegments[i], pathSegments[j]) && walk(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Apply masking rules to a JSON payload.
 *
 * Deterministic: rules are sorted before use, object keys are visited in
 * sorted order, and the reported path lists are sorted and de-duplicated, so
 * the same (rules, payload) pair always yields the same result and the same
 * diagnostics regardless of input ordering.
 *
 * Fail-closed, in the only sense that matters for a masking function: if any
 * rule cannot be compiled, or the payload is deeper or larger than the bounds
 * below, NOTHING is returned. The caller gets {ok:false} and must drop the
 * payload rather than forward data that may not have been masked. A masking
 * function that "did its best" on a rule it did not understand is worse than
 * no masking function at all, because it looks like it worked.
 *
 * Semantics when a rule matches a path:
 *   drop  the field is removed from its parent object, or the element from
 *         its parent array (which compacts the array — indexes shift).
 *   hash  the value is replaced by "sha256:<hex>" of its canonical JSON, so
 *         equal values stay equal (joinable) while the content is gone.
 * A matched node is not descended into: replacing or removing it settles
 * everything beneath it. 'drop' wins over 'hash' on the same path — removing
 * is strictly stronger than hashing.
 *
 * async only because SHA-256 is; there is no I/O, no clock, and no randomness
 * in here, so it is a pure function in every sense that matters for testing.
 */
export async function applyMaskingRules(
  rules: readonly MaskingRule[],
  payload: unknown,
): Promise<MaskingResult> {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const result = compileMaskingRule(rule);
    if (!result.ok) {
      return { ok: false, error: `invalid masking rule ${JSON.stringify(rule.field_pattern)}: ${result.error}` };
    }
    compiled.push(result.value);
  }
  // Deterministic rule order: pattern, then action. Only affects diagnostics
  // (drop already wins over hash) but keeps the function total-order stable.
  compiled.sort((a, b) => {
    if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
    return a.action === b.action ? 0 : a.action < b.action ? -1 : 1;
  });

  const hashed = new Set<string>();
  const dropped = new Set<string>();
  let nodes = 0;

  type Visited = { drop: true } | { drop: false; value: unknown };
  const tooLarge = { reason: "" };

  const visit = async (value: unknown, path: string[]): Promise<Visited | null> => {
    nodes += 1;
    if (nodes > MAX_MASK_NODES) {
      tooLarge.reason = `payload exceeds ${MAX_MASK_NODES} nodes`;
      return null;
    }
    if (path.length > MAX_MASK_DEPTH) {
      tooLarge.reason = `payload exceeds ${MAX_MASK_DEPTH} levels of nesting`;
      return null;
    }
    let action: MaskingAction | null = null;
    for (const rule of compiled) {
      if (!pathMatches(rule.segments, path)) continue;
      if (rule.action === "drop") {
        action = "drop";
        break; // strongest action; nothing can override it
      }
      action = "hash";
    }
    const dotted = path.join(".");
    if (action === "drop") {
      dropped.add(dotted);
      return { drop: true };
    }
    if (action === "hash") {
      hashed.add(dotted);
      return { drop: false, value: `sha256:${await sha256Hex(canonicalJsonStringify(value))}` };
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const child = await visit(value[index], [...path, String(index)]);
        if (child === null) return null;
        if (!child.drop) out.push(child.value);
      }
      return { drop: false, value: out };
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const child = await visit(value[key], [...path, key]);
        if (child === null) return null;
        if (!child.drop) out[key] = child.value;
      }
      return { drop: false, value: out };
    }
    return { drop: false, value };
  };

  const root = await visit(payload, []);
  if (root === null) return { ok: false, error: tooLarge.reason };
  return {
    ok: true,
    // A rule may match the root itself (only `**` can); dropping everything
    // yields null rather than a hole in the caller's type.
    value: root.drop ? null : root.value,
    hashed: [...hashed].sort(),
    dropped: [...dropped].sort(),
  };
}

// -- masking CRUD ---------------------------------------------------------------------

const LIST_MASKING_RULES_SQL = `
  /* ee:list-masking-rules */
  SELECT id, workspace_id, field_pattern, action, created_at
  FROM ee_masking_rules
  WHERE workspace_id = ?1
  ORDER BY created_at DESC, id DESC
  LIMIT ?2`;

const LIST_MASKING_RULES_AFTER_SQL = `
  /* ee:list-masking-rules-after */
  SELECT id, workspace_id, field_pattern, action, created_at
  FROM ee_masking_rules
  WHERE workspace_id = ?1
    AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
  ORDER BY created_at DESC, id DESC
  LIMIT ?4`;

const INSERT_MASKING_RULE_SQL = `
  /* ee:insert-masking-rule */
  INSERT INTO ee_masking_rules (id, workspace_id, field_pattern, action, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)`;

const DELETE_MASKING_RULE_SQL = `
  /* ee:delete-masking-rule */
  DELETE FROM ee_masking_rules
  WHERE id = ?1 AND workspace_id = ?2
  RETURNING id`;

interface MaskingRuleRow {
  id: string;
  workspace_id: string;
  field_pattern: string;
  action: string;
  created_at: number;
}

function maskingRuleItem(row: MaskingRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    field_pattern: row.field_pattern,
    action: row.action,
    created_at: row.created_at,
  };
}

/** Load a workspace's rules in a form applyMaskingRules accepts. */
export async function loadMaskingRules(
  db: D1DatabaseLike,
  workspaceId: string,
  limit = 500,
): Promise<MaskingRule[]> {
  const result = await db.prepare(LIST_MASKING_RULES_SQL).bind(workspaceId, limit).all<MaskingRuleRow>();
  return [...result.results]
    // The column CHECK makes an out-of-vocabulary action unreachable; ignoring
    // one rather than trusting it is defense in depth if it ever is not.
    .filter((row) => (MASKING_ACTIONS as readonly unknown[]).includes(row.action))
    .sort((a, b) => (a.field_pattern === b.field_pattern ? 0 : a.field_pattern < b.field_pattern ? -1 : 1))
    .map((row) => ({ field_pattern: row.field_pattern, action: row.action as MaskingAction }));
}

async function listMaskingRules(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEERead(request, env, "admin");
  if ("response" in auth) return auth.response;
  const page = parsePagination(new URL(request.url));
  if (!page.ok) return json(page.status, { error: page.error });
  const { limit, cursor } = page.value;
  const result =
    cursor === null
      ? await env.DB.prepare(LIST_MASKING_RULES_SQL)
          .bind(auth.workspaceId, limit + 1)
          .all<MaskingRuleRow>()
      : await env.DB.prepare(LIST_MASKING_RULES_AFTER_SQL)
          .bind(auth.workspaceId, cursor.createdAt, cursor.id, limit + 1)
          .all<MaskingRuleRow>();
  const rows = [...result.results].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    if (a.id === b.id) return 0;
    return a.id > b.id ? -1 : 1;
  });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return json(200, {
    items: items.map(maskingRuleItem),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

async function createMaskingRule(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEEWrite(request, env, "owner");
  if ("response" in auth) return auth.response;
  const fieldPattern = auth.body.field_pattern;
  const action = auth.body.action;
  if (typeof fieldPattern !== "string") {
    return json(400, { error: "field_pattern must be a string" });
  }
  const compiled = compileMaskingRule({ field_pattern: fieldPattern, action: action as MaskingAction });
  if (!compiled.ok) return json(400, { error: compiled.error });

  const nowMillis = Date.now();
  const now = Math.floor(nowMillis / 1_000);
  const id = newMaskingRuleId(nowMillis);
  try {
    await env.DB.prepare(INSERT_MASKING_RULE_SQL)
      .bind(id, auth.workspaceId, fieldPattern, compiled.value.action, now)
      .run();
  } catch (error) {
    if (messageOf(error).includes("UNIQUE constraint failed: ee_masking_rules")) {
      return json(409, { error: "a rule for this field_pattern already exists" });
    }
    throw error;
  }
  return json(201, {
    rule: maskingRuleItem({
      id,
      workspace_id: auth.workspaceId,
      field_pattern: fieldPattern,
      action: compiled.value.action,
      created_at: now,
    }),
  });
}

async function deleteMaskingRule(request: Request, env: EEEnv, ruleId: string): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  const check = await requireRole(env.DB, auth.session.workspaceId, auth.session.userId, "owner");
  if (!check.ok) return json(check.status, { error: check.error });
  const deleted = await env.DB.prepare(DELETE_MASKING_RULE_SQL)
    .bind(ruleId, check.membership.workspaceId)
    .first<{ id: string }>();
  // A rule in another workspace is indistinguishable from one that never
  // existed: 404, never 403.
  if (deleted === null) return json(404, { error: "not found" });
  return json(200, { ok: true, id: ruleId });
}

// =============================================================================
// AUDIT EXPORT — GET /v1/ee/audit/export
// =============================================================================

/**
 * The exportable trail: every team mutation (hash-chained by src/teams.ts),
 * every alert that fired (src/alerts.ts appends alert.fired to the spine —
 * that IS the alert history), and every recorded verification. All three are
 * already on the append-only spine; this endpoint is a convenience surface for
 * a SIEM, not a new source of evidence.
 */
export const AUDIT_EXPORT_KINDS: readonly string[] = [
  ...TEAM_EVENT_KINDS,
  "alert.fired",
  "verification.recorded",
].sort();

const AUDIT_EXPORT_MAX_LIMIT = 5_000;
const AUDIT_EXPORT_DEFAULT_LIMIT = 1_000;

const AUDIT_EXPORT_SQL = `
  /* ee:audit-export */
  SELECT seq, event_id, kind, raw_json
  FROM events
  WHERE workspace_id = ?1
    AND seq > ?2
    AND kind IN (${AUDIT_EXPORT_KINDS.map((_, index) => `?${index + 3}`).join(", ")})
  ORDER BY seq ASC
  LIMIT ?${AUDIT_EXPORT_KINDS.length + 3}`;

interface AuditExportRow {
  seq: number;
  event_id: string;
  kind: string;
  raw_json: string;
}

function parseNonNegativeInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d{1,12}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value > max ? null : value;
}

async function exportAudit(request: Request, env: EEEnv): Promise<Response> {
  const auth = await authorizeEERead(request, env, "admin");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const afterSeq = parseNonNegativeInt(url.searchParams.get("after_seq"), 0, Number.MAX_SAFE_INTEGER);
  const limitRaw = parseNonNegativeInt(url.searchParams.get("limit"), AUDIT_EXPORT_DEFAULT_LIMIT, AUDIT_EXPORT_MAX_LIMIT);
  if (afterSeq === null || limitRaw === null || limitRaw < 1) {
    return json(400, { error: `after_seq must be >= 0 and limit must be 1..${AUDIT_EXPORT_MAX_LIMIT}` });
  }

  const result = await env.DB.prepare(AUDIT_EXPORT_SQL)
    .bind(auth.workspaceId, afterSeq, ...AUDIT_EXPORT_KINDS, limitRaw)
    .all<AuditExportRow>();
  const rows = [...result.results].sort((a, b) => a.seq - b.seq);

  // raw_json is canonical JSON, which by construction contains no literal
  // newline (JSON.stringify escapes them inside strings). The guard is here
  // anyway: one malformed row must not corrupt the framing of the whole
  // stream for the consumer, so it is skipped and counted instead.
  const lines: string[] = [];
  let skipped = 0;
  let lastSeq = afterSeq;
  for (const row of rows) {
    lastSeq = row.seq;
    if (typeof row.raw_json !== "string" || row.raw_json.includes("\n") || row.raw_json.includes("\r")) {
      skipped += 1;
      continue;
    }
    lines.push(row.raw_json);
  }
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/x-ndjson",
    "content-disposition": `attachment; filename="audit-${auth.workspaceId}.ndjson"`,
    "x-hfg-audit-count": String(lines.length),
    "x-hfg-audit-skipped": String(skipped),
  };
  // A full page means there may be more; the caller resumes from this seq.
  if (rows.length >= limitRaw) headers["x-hfg-audit-next-seq"] = String(lastSeq);
  return new Response(body, { status: 200, headers });
}

// =============================================================================
// ROUTING — the one seam index.ts talks to
// =============================================================================

/**
 * Route the Enterprise surface.
 *
 * Returns null in three cases, all of which land on index.ts's platform-wide
 * 404 with identical bytes:
 *   1. EE is not enabled (env.EE_ENABLED !== "true") — THE FENCE.
 *   2. The path is not ours.
 *   3. The path is ours but the method is not (platform convention).
 *
 * `modelCall` is a test seam for the assistant loop only; production leaves it
 * undefined and the assistant calls the model through this platform's own
 * gateway (see assistant.ts).
 */
export async function handleEERoute(
  request: Request,
  env: EEEnv,
  modelCall?: AssistantModelCall,
  fetcher?: FetchLike,
): Promise<Response | null> {
  // THE FENCE. Before anything else — before parsing the URL, before touching
  // D1 — so that with EE off this function is indistinguishable from absent.
  if (!eeEnabled(env)) return null;

  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === ASSISTANT_PATH) {
    if (method !== "POST") return null;
    return handleAssistantRoute(request, env, modelCall, fetcher);
  }

  if (!pathname.startsWith(EE_PREFIX)) return null;

  if (pathname === SSO_PATH) {
    if (method === "GET") return getSso(request, env);
    if (method === "PUT") return putSso(request, env);
    return null;
  }

  if (pathname === SCIM_TOKEN_PATH) {
    if (method === "POST") return createScimToken(request, env);
    return null;
  }

  if (pathname === SCIM_USERS_PATH) {
    if (method === "GET") return listScimUsers(request, env);
    if (method === "POST") return createScimUser(request, env);
    return null;
  }

  if (pathname === MASKING_RULES_PATH) {
    if (method === "GET") return listMaskingRules(request, env);
    if (method === "POST") return createMaskingRule(request, env);
    return null;
  }

  const maskingRule = MASKING_RULE_PATTERN.exec(pathname);
  if (maskingRule !== null) {
    if (method === "DELETE") return deleteMaskingRule(request, env, maskingRule[1]);
    return null;
  }

  if (pathname === AUDIT_EXPORT_PATH) {
    if (method === "GET") return exportAudit(request, env);
    return null;
  }

  return null;
}
