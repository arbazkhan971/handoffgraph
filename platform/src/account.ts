// Human account authentication for the hosted beta.
//
// This is intentionally separate from device-token authentication in auth.ts:
// browser cookies can never authorize ingestion, and device bearer tokens can
// never authorize account actions. WorkOS AuthKit owns passwords, passkeys,
// email verification, and social identity. HandoffGraph consumes only the
// verified immutable user subject, then discards all provider tokens.

import { sha256Hex, timingSafeEqual } from "./auth";
import type { D1DatabaseLike } from "./db";
import { readRequestBody } from "./ingest";
import {
  newAccountSessionID,
  newDeviceID,
  newUserID,
  newWorkspaceID,
} from "./ids";

export const SESSION_COOKIE = "__Host-hfg_session";
export const CSRF_COOKIE = "__Host-hfg_csrf";
const STATE_COOKIE = "__Host-hfg_auth_state";
const PKCE_COOKIE = "__Host-hfg_pkce";
const RETURN_COOKIE = "__Host-hfg_return";
const INTENT_COOKIE = "__Host-hfg_intent";

const AUTH_COOKIE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_DEVICE_LABEL_BYTES = 80;
const MAX_ACCOUNT_BODY_BYTES = 4_096;

export interface AccountEnv {
  DB: D1DatabaseLike;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  WORKOS_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
  LANDING_ORIGIN?: string;
  HOSTED_SIGNUP_ENABLED?: string;
}

export interface SessionAccount {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  workspaceId: string;
  workspaceName: string;
  role: string;
  csrfHash: string;
  planId: string;
  planStatus: string;
  maxDevices: number;
  activeDevices: number;
  maxDeviceIssuances: number;
  usedDeviceIssuances: number;
  maxMonthlyEvents: number;
  usedMonthlyEvents: number;
  maxMonthlyBytes: number;
  usedMonthlyBytes: number;
  maxLifetimeEvents: number;
  usedLifetimeEvents: number;
  maxLifetimeBytes: number;
  usedLifetimeBytes: number;
  periodEnd: number;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  csrf_hash: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  workspace_id: string;
  workspace_name: string;
  role: string;
  plan_id: string;
  plan_status: string;
  max_devices: number;
  active_devices: number;
  max_device_issuances: number;
  used_device_issuances: number;
  max_monthly_events: number;
  used_monthly_events: number;
  max_monthly_bytes: number;
  used_monthly_bytes: number;
  max_lifetime_events: number;
  used_lifetime_events: number;
  max_lifetime_bytes: number;
  used_lifetime_bytes: number;
  period_start: number;
  period_end: number;
}

interface WorkOSUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
}

interface WorkOSAuthenticateResponse {
  user?: WorkOSUser;
  // Deliberately not modeled: access_token and refresh_token are discarded.
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const NO_STORE_JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
};

function json(status: number, body: unknown, cookies: string[] = []): Response {
  const responseHeaders = new Headers(NO_STORE_JSON_HEADERS);
  for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      // Malformed cookies are ignored rather than reflected or logged.
    }
  }
  return cookies;
}

function secureCookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "Secure",
    "SameSite=Lax",
  ];
  if (httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function clearCookie(name: string, httpOnly: boolean): string {
  return secureCookie(name, "", 0, httpOnly);
}

function clearAuthCookies(): string[] {
  return [
    clearCookie(STATE_COOKIE, true),
    clearCookie(PKCE_COOKIE, true),
    clearCookie(RETURN_COOKIE, true),
    clearCookie(INTENT_COOKIE, true),
  ];
}

function normalizedOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

interface AuthConfig {
  clientId: string;
  apiKey: string;
  redirectUri: string;
  appOrigin: string;
  landingOrigin: string | null;
}

function authConfig(env: AccountEnv): AuthConfig | null {
  const appOrigin = normalizedOrigin(env.APP_ORIGIN);
  const landingOrigin = normalizedOrigin(env.LANDING_ORIGIN);
  if (
    !env.WORKOS_CLIENT_ID ||
    !env.WORKOS_API_KEY ||
    !env.WORKOS_REDIRECT_URI ||
    appOrigin === null
  ) {
    return null;
  }
  try {
    const redirectUrl = new URL(env.WORKOS_REDIRECT_URI);
    if (
      redirectUrl.origin !== appOrigin ||
      redirectUrl.pathname !== "/v1/auth/callback" ||
      redirectUrl.username !== "" ||
      redirectUrl.password !== "" ||
      redirectUrl.search !== "" ||
      redirectUrl.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    clientId: env.WORKOS_CLIENT_ID,
    apiKey: env.WORKOS_API_KEY,
    redirectUri: env.WORKOS_REDIRECT_URI,
    appOrigin,
    landingOrigin,
  };
}

function allowedReturnTarget(raw: string | null, config: AuthConfig): string {
  if (raw === null || raw === "") return `${config.appOrigin}/account`;
  try {
    const candidate = new URL(raw, config.appOrigin);
    const allowed = candidate.origin === config.appOrigin || candidate.origin === config.landingOrigin;
    if (!allowed || candidate.username !== "" || candidate.password !== "") {
      return `${config.appOrigin}/account`;
    }
    return candidate.toString();
  } catch {
    return `${config.appOrigin}/account`;
  }
}

export async function startAuth(request: Request, env: AccountEnv): Promise<Response> {
  const config = authConfig(env);
  if (config === null) {
    return json(503, {
      error: "hosted_auth_unavailable",
      message: "Hosted account sign-in is not configured yet.",
    });
  }

  const requestUrl = new URL(request.url);
  const intent = requestUrl.searchParams.get("intent") === "signup" ? "signup" : "signin";
  if (intent === "signup" && env.HOSTED_SIGNUP_ENABLED !== "true") {
    return json(503, {
      error: "hosted_signup_unavailable",
      message: "Hosted signup is not open yet. Join the beta list for access.",
    });
  }
  const returnTo = allowedReturnTarget(requestUrl.searchParams.get("return_to"), config);
  const state = randomSecret();
  const verifier = randomSecret();
  const authorizationUrl = new URL("https://api.workos.com/user_management/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("provider", "authkit");
  authorizationUrl.searchParams.set("screen_hint", intent === "signup" ? "sign-up" : "sign-in");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));

  return redirect(authorizationUrl.toString(), [
    secureCookie(STATE_COOKIE, state, AUTH_COOKIE_TTL_SECONDS, true),
    secureCookie(PKCE_COOKIE, verifier, AUTH_COOKIE_TTL_SECONDS, true),
    secureCookie(RETURN_COOKIE, returnTo, AUTH_COOKIE_TTL_SECONDS, true),
    secureCookie(INTENT_COOKIE, intent, AUTH_COOKIE_TTL_SECONDS, true),
  ]);
}

async function exchangeWorkOSCode(
  config: AuthConfig,
  code: string,
  verifier: string,
  fetcher: Fetcher,
): Promise<WorkOSUser | null> {
  let response: Response;
  try {
    response = await fetcher("https://api.workos.com/user_management/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.apiKey,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: WorkOSAuthenticateResponse;
  try {
    payload = (await response.json()) as WorkOSAuthenticateResponse;
  } catch {
    return null;
  }
  const user = payload.user;
  if (
    user === undefined ||
    typeof user.id !== "string" ||
    user.id === "" ||
    typeof user.email !== "string" ||
    user.email === "" ||
    user.email_verified !== true
  ) {
    return null;
  }
  return user;
}

function displayName(user: WorkOSUser): string | null {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ")
    .trim();
  return name === "" ? null : name.slice(0, 200);
}

interface IdentityRow { user_id: string }
interface UserWorkspaceRow { personal_workspace_id: string }

async function provisionAccount(
  db: D1DatabaseLike,
  providerUser: WorkOSUser,
  now: number,
  allowCreate: boolean,
): Promise<{
  userId: string;
  workspaceId: string;
}> {
  const candidateUserId = newUserID();
  const candidateWorkspaceId = newWorkspaceID();
  const name = displayName(providerUser);
  const avatar = typeof providerUser.profile_picture_url === "string"
    ? providerUser.profile_picture_url.slice(0, 2_048)
    : null;
  const workspaceName = name === null ? "Personal workspace" : `${name}'s workspace`;

  let identity = await db.prepare(`
    SELECT user_id FROM provider_identities
    WHERE provider = 'workos' AND provider_subject = ?1`)
    .bind(providerUser.id)
    .first<IdentityRow>();

  if (identity === null) {
    if (!allowCreate) throw new Error("account does not exist");
    // The complete new-account graph and its capacity-consuming Basic
    // entitlement share one transaction. A full beta or identity race rolls
    // back every candidate row; a rejected signup can never grow D1.
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO workspaces
            (id, workspace_id, name, status, created_at)
          VALUES (?1, ?1, ?2, 'active', ?3)`)
          .bind(candidateWorkspaceId, workspaceName.slice(0, 200), now),
        db.prepare(`
          INSERT INTO users
            (id, email, display_name, avatar_url, email_verified, status,
             personal_workspace_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, 1, 'active', ?5, ?6, ?6)`)
          .bind(candidateUserId, providerUser.email, name, avatar, candidateWorkspaceId, now),
        db.prepare(`
          INSERT INTO provider_identities
            (provider, provider_subject, user_id, email, created_at, updated_at)
          VALUES ('workos', ?1, ?2, ?3, ?4, ?4)`)
          .bind(providerUser.id, candidateUserId, providerUser.email, now),
        db.prepare(`
          INSERT INTO workspace_members
            (workspace_id, user_id, role, status, created_at)
          VALUES (?1, ?2, 'owner', 'active', ?3)`)
          .bind(candidateWorkspaceId, candidateUserId, now),
        db.prepare(`
          INSERT INTO workspace_entitlements
            (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
          VALUES (?1, 'basic', 'active', ?2, ?3, ?2, ?2)`)
          .bind(candidateWorkspaceId, now, now + 30 * 24 * 60 * 60),
      ]);
      identity = { user_id: candidateUserId };
    } catch {
      // A concurrent callback for the same immutable provider subject may
      // have won. D1 serialized its commit before reporting our uniqueness
      // conflict, so re-read the winner; otherwise propagate capacity/storage
      // failure without leaving partial rows.
      identity = await db.prepare(`
        SELECT user_id FROM provider_identities
        WHERE provider = 'workos' AND provider_subject = ?1`)
        .bind(providerUser.id)
        .first<IdentityRow>();
      if (identity === null) throw new Error("account provisioning failed");
    }
  }
  if (identity === null) throw new Error("identity provisioning failed");

  await db.prepare(`
    UPDATE users
    SET email = ?2, display_name = ?3, avatar_url = ?4,
        email_verified = 1, updated_at = ?5
    WHERE id = ?1 AND status = 'active'`)
    .bind(identity.user_id, providerUser.email, name, avatar, now)
    .run();

  const account = await db.prepare(`
    SELECT personal_workspace_id FROM users WHERE id = ?1 AND status = 'active'`)
    .bind(identity.user_id)
    .first<UserWorkspaceRow>();
  if (account === null) throw new Error("account unavailable");

  // Repair-only idempotent writes for identities created by an older partial
  // beta build. New accounts already committed these rows atomically above.
  if (identity.user_id !== candidateUserId) {
    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO workspace_members
          (workspace_id, user_id, role, status, created_at)
        VALUES (?1, ?2, 'owner', 'active', ?3)`)
        .bind(account.personal_workspace_id, identity.user_id, now),
      db.prepare(`
        INSERT OR IGNORE INTO workspace_entitlements
          (workspace_id, plan_id, status, period_start, period_end, created_at, updated_at)
        VALUES (?1, 'basic', 'active', ?2, ?3, ?2, ?2)`)
        .bind(account.personal_workspace_id, now, now + 30 * 24 * 60 * 60),
    ]);
  }

  return { userId: identity.user_id, workspaceId: account.personal_workspace_id };
}

async function createBrowserSession(
  db: D1DatabaseLike,
  userId: string,
  now: number,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = `hfg_session_${randomSecret()}`;
  const csrfToken = randomSecret();
  // Hosted beta accounts intentionally have one browser session. Replacing
  // it on login bounds D1 session growth and rotates credentials without a
  // background cleanup job. The delete and insert commit atomically.
  await db.batch([
    db.prepare("DELETE FROM account_sessions WHERE user_id = ?1").bind(userId),
    db.prepare(`
      INSERT INTO account_sessions
        (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, NULL)`)
      .bind(
        newAccountSessionID(),
        userId,
        await sha256Hex(sessionToken),
        await sha256Hex(csrfToken),
        now,
        now + SESSION_TTL_SECONDS,
      ),
  ]);
  return { sessionToken, csrfToken };
}

export async function finishAuth(
  request: Request,
  env: AccountEnv,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const config = authConfig(env);
  if (config === null) return json(503, { error: "hosted_auth_unavailable" });
  const requestUrl = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie"));
  const expectedState = cookies.get(STATE_COOKIE);
  const returnedState = requestUrl.searchParams.get("state");
  const verifier = cookies.get(PKCE_COOKIE);
  const code = requestUrl.searchParams.get("code");
  if (
    expectedState === undefined ||
    returnedState === null ||
    verifier === undefined ||
    code === null ||
    !timingSafeEqual(expectedState, returnedState)
  ) {
    return json(400, { error: "invalid_auth_callback" }, clearAuthCookies());
  }

  const providerUser = await exchangeWorkOSCode(config, code, verifier, fetcher);
  if (providerUser === null) {
    return json(502, { error: "authentication_unavailable" }, clearAuthCookies());
  }

  const now = Math.floor(Date.now() / 1_000);
  let account: { userId: string; workspaceId: string };
  let session: { sessionToken: string; csrfToken: string };
  try {
    const allowCreate =
      env.HOSTED_SIGNUP_ENABLED === "true" &&
      cookies.get(INTENT_COOKIE) === "signup";
    account = await provisionAccount(env.DB, providerUser, now, allowCreate);
    session = await createBrowserSession(env.DB, account.userId, now);
  } catch {
    // Includes an exhausted global beta capacity. Never disclose whether a
    // particular provider identity, email, workspace, or plan row exists.
    return json(503, { error: "hosted_beta_unavailable" }, clearAuthCookies());
  }
  const target = allowedReturnTarget(cookies.get(RETURN_COOKIE) ?? null, config);
  return redirect(target, [
    ...clearAuthCookies(),
    secureCookie(SESSION_COOKIE, session.sessionToken, SESSION_TTL_SECONDS, true),
    secureCookie(CSRF_COOKIE, session.csrfToken, SESSION_TTL_SECONDS, false),
  ]);
}

const SESSION_SQL = `
  SELECT
    s.id AS session_id,
    s.user_id,
    s.csrf_hash,
    u.email,
    u.display_name,
    u.avatar_url,
    u.personal_workspace_id AS workspace_id,
    w.name AS workspace_name,
    m.role,
    e.plan_id,
    e.status AS plan_status,
    e.max_devices,
    e.active_devices,
    e.max_device_issuances,
    e.used_device_issuances,
    e.max_monthly_events,
    e.used_monthly_events,
    e.max_monthly_bytes,
    e.used_monthly_bytes,
    e.max_lifetime_events,
    e.used_lifetime_events,
    e.max_lifetime_bytes,
    e.used_lifetime_bytes,
    e.period_start,
    e.period_end
  FROM account_sessions AS s
  JOIN users AS u ON u.id = s.user_id
  JOIN workspace_members AS m
    ON m.user_id = u.id AND m.workspace_id = u.personal_workspace_id
  JOIN workspaces AS w ON w.id = m.workspace_id
  JOIN workspace_entitlements AS e ON e.workspace_id = m.workspace_id
  WHERE s.token_hash = ?1
    AND s.revoked_at IS NULL
    AND s.expires_at > ?2
    AND u.status = 'active'
    AND m.status = 'active'
    AND w.status = 'active'`;

export async function authenticateAccountSession(
  request: Request,
  db: D1DatabaseLike,
): Promise<SessionAccount | null> {
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (token === undefined || token.length < 32 || token.length > 256) return null;
  const now = Math.floor(Date.now() / 1_000);
  const row = await db.prepare(SESSION_SQL)
    .bind(await sha256Hex(token), now)
    .first<SessionRow>();
  if (row === null) return null;
  let usedMonthlyEvents = row.used_monthly_events;
  let usedMonthlyBytes = row.used_monthly_bytes;
  let periodEnd = row.period_end;
  if (now >= row.period_end) {
    const duration = row.period_end - row.period_start;
    if (!Number.isSafeInteger(duration) || duration <= 0) return null;
    const elapsed = Math.floor((now - row.period_start) / duration);
    periodEnd = row.period_start + (elapsed + 1) * duration;
    if (!Number.isSafeInteger(periodEnd) || periodEnd <= now) return null;
    // This is a read-side projection only. The reservation trigger performs
    // the authoritative reset before the next hosted write.
    usedMonthlyEvents = 0;
    usedMonthlyBytes = 0;
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    role: row.role,
    csrfHash: row.csrf_hash,
    planId: row.plan_id,
    planStatus: row.plan_status,
    maxDevices: row.max_devices,
    activeDevices: row.active_devices,
    maxDeviceIssuances: row.max_device_issuances,
    usedDeviceIssuances: row.used_device_issuances,
    maxMonthlyEvents: row.max_monthly_events,
    usedMonthlyEvents,
    maxMonthlyBytes: row.max_monthly_bytes,
    usedMonthlyBytes,
    maxLifetimeEvents: row.max_lifetime_events,
    usedLifetimeEvents: row.used_lifetime_events,
    maxLifetimeBytes: row.max_lifetime_bytes,
    usedLifetimeBytes: row.used_lifetime_bytes,
    periodEnd,
  };
}

function sessionView(session: SessionAccount): Record<string, unknown> {
  return {
    user: {
      id: session.userId,
      email: session.email,
      display_name: session.displayName,
      avatar_url: session.avatarUrl,
    },
    workspace: {
      id: session.workspaceId,
      name: session.workspaceName,
      role: session.role,
    },
    entitlement: {
      plan_id: session.planId,
      status: session.planStatus,
      devices: { used: session.activeDevices, limit: session.maxDevices },
      device_issuances: {
        used: session.usedDeviceIssuances,
        limit: session.maxDeviceIssuances,
      },
      monthly_events: { used: session.usedMonthlyEvents, limit: session.maxMonthlyEvents },
      monthly_bytes: { used: session.usedMonthlyBytes, limit: session.maxMonthlyBytes },
      lifetime_events: { used: session.usedLifetimeEvents, limit: session.maxLifetimeEvents },
      lifetime_bytes: { used: session.usedLifetimeBytes, limit: session.maxLifetimeBytes },
      period_end: session.periodEnd,
      overages: false,
      local_capture_unaffected: true,
    },
  };
}

export async function getMe(request: Request, env: AccountEnv): Promise<Response> {
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return json(401, { error: "unauthorized" });
  return json(200, sessionView(session));
}

function allowedUnsafeOrigin(request: Request, env: AccountEnv): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const app = normalizedOrigin(env.APP_ORIGIN);
  return app !== null && origin === app;
}

async function validCsrf(request: Request, session: SessionAccount): Promise<boolean> {
  const token = request.headers.get("x-csrf-token");
  if (token === null || token.length < 32 || token.length > 256) return false;
  return timingSafeEqual(await sha256Hex(token), session.csrfHash);
}

async function authorizedUnsafeRequest(
  request: Request,
  env: AccountEnv,
): Promise<{ response: Response } | { session: SessionAccount }> {
  if (!allowedUnsafeOrigin(request, env)) {
    return { response: json(403, { error: "forbidden" }) };
  }
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return { response: json(401, { error: "unauthorized" }) };
  if (!(await validCsrf(request, session))) {
    return { response: json(403, { error: "invalid_csrf" }) };
  }
  return { session };
}

export async function signOut(request: Request, env: AccountEnv): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  await env.DB.prepare(`
    UPDATE account_sessions SET revoked_at = ?2
    WHERE id = ?1 AND revoked_at IS NULL`)
    .bind(auth.session.sessionId, Math.floor(Date.now() / 1_000))
    .run();
  return json(200, { ok: true }, [
    clearCookie(SESSION_COOKIE, true),
    clearCookie(CSRF_COOKIE, false),
  ]);
}

interface DeviceRow {
  id: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export async function listDevices(request: Request, env: AccountEnv): Promise<Response> {
  const session = await authenticateAccountSession(request, env.DB);
  if (session === null) return json(401, { error: "unauthorized" });
  const result = await env.DB.prepare(`
    SELECT id, label, created_at, last_seen_at
    FROM devices
    WHERE workspace_id = ?1 AND revoked_at IS NULL
    ORDER BY created_at DESC, id DESC`)
    .bind(session.workspaceId)
    .all<DeviceRow>();
  return json(200, { devices: result.results });
}

async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readRequestBody(request, MAX_ACCOUNT_BODY_BYTES);
  if (!body.ok) return null;
  try {
    const value = JSON.parse(body.text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function createDevice(request: Request, env: AccountEnv): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  if (auth.session.role !== "owner") return json(403, { error: "forbidden" });
  if (auth.session.planStatus !== "active") {
    return json(403, { error: "entitlement_inactive" });
  }

  const quotaResponse = (session: SessionAccount): Response => {
    const issuanceLimitReached = session.usedDeviceIssuances >= session.maxDeviceIssuances;
    return json(429, {
      error: "quota_exceeded",
      resource: issuanceLimitReached ? "device_issuances" : "devices",
      limit: issuanceLimitReached ? session.maxDeviceIssuances : session.maxDevices,
      local_capture_unaffected: true,
    });
  };
  if (
    auth.session.activeDevices >= auth.session.maxDevices ||
    auth.session.usedDeviceIssuances >= auth.session.maxDeviceIssuances
  ) {
    return quotaResponse(auth.session);
  }

  const body = await readSmallJson(request);
  const label = body?.label;
  if (typeof label !== "string" || label.trim() === "" || new TextEncoder().encode(label).byteLength > MAX_DEVICE_LABEL_BYTES) {
    return json(400, { error: `label must be 1-${MAX_DEVICE_LABEL_BYTES} UTF-8 bytes` });
  }

  const token = `hfg_dev_${randomSecret()}`;
  const deviceId = newDeviceID();
  const now = Math.floor(Date.now() / 1_000);
  try {
    // Migration 0003's AFTER INSERT trigger atomically charges both active and
    // lifetime counters or aborts this row. There is no split reservation that
    // can burn a slot when the device insert fails.
    await env.DB.prepare(`
      INSERT INTO devices
        (id, workspace_id, token_hash, label, capabilities, created_at, last_seen_at, revoked_at)
      VALUES (?1, ?2, ?3, ?4, 'ingest,read', ?5, NULL, NULL)`)
      .bind(deviceId, auth.session.workspaceId, await sha256Hex(token), label.trim(), now)
      .run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("device quota exceeded")) {
      const current = await authenticateAccountSession(request, env.DB);
      return quotaResponse(current ?? auth.session);
    }
    throw error;
  }

  // Raw device credentials are shown once and never persisted or logged.
  return json(201, {
    device: { id: deviceId, label: label.trim(), token },
    warning: "Copy this token now. It cannot be shown again.",
  });
}

export async function revokeDevice(
  request: Request,
  env: AccountEnv,
  deviceId: string,
): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  if (auth.session.role !== "owner") return json(403, { error: "forbidden" });
  const now = Math.floor(Date.now() / 1_000);
  const revoked = await env.DB.prepare(`
    UPDATE devices
    SET revoked_at = ?3
    WHERE id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL
    RETURNING id`)
    .bind(deviceId, auth.session.workspaceId, now)
    .first<{ id: string }>();
  if (revoked === null) return json(404, { error: "not found" });
  return json(200, { ok: true });
}

/**
 * Route the human account surface. Returns null when this module does not own
 * the route so the device API router can continue.
 */
export async function handleAccountRoute(
  request: Request,
  env: AccountEnv,
  fetcher: Fetcher = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/v1/auth/start") return startAuth(request, env);
  if (request.method === "GET" && pathname === "/v1/auth/callback") {
    return finishAuth(request, env, fetcher);
  }
  if (request.method === "GET" && pathname === "/v1/me") return getMe(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/signout") return signOut(request, env);
  if (request.method === "GET" && pathname === "/v1/devices") return listDevices(request, env);
  if (request.method === "POST" && pathname === "/v1/devices") return createDevice(request, env);
  const revoke = /^\/v1\/devices\/(dev_[0-9A-HJKMNP-TV-Z]{26})\/revoke$/.exec(pathname);
  if (request.method === "POST" && revoke !== null) return revokeDevice(request, env, revoke[1]);
  return null;
}
