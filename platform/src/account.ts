// Human account authentication for the hosted beta.
//
// This is intentionally separate from device-token authentication in auth.ts:
// browser cookies can never authorize ingestion, and device bearer tokens can
// never authorize account actions. WorkOS AuthKit owns passwords, passkeys,
// email verification, and social identity. HandoffGraph consumes only the
// verified immutable user subject and bounded provider-session logout handle,
// then discards all provider tokens.

import { sha256Hex, timingSafeEqual } from "./auth";
import type { D1BoundStatement, D1DatabaseLike } from "./db";
import {
  deletionLedgerBinding,
  deletionLedgerMatchesOwner,
  deletionLedgerRequired,
  ensureDeletionLedger,
  readDeletionLedger,
  workspaceDeletionBlocksAuthentication,
  type DeletionLedgerBucketLike,
} from "./deletion_ledger";
import {
  auditHostedBetaCapacityCoverage,
  reserveHostedBetaIssuance,
  verifyHostedBetaIssuanceMembership,
} from "./hosted_capacity_ledger";
import { readRequestBody } from "./ingest";
import {
  newAccountSessionID,
  newDeviceID,
  newUserID,
  newWorkspaceID,
} from "./ids";
import {
  isValidWorkOSSessionID,
  verifyWorkOSAccessToken,
  type VerifiedWorkOSSession,
  type WorkOSSessionBinding,
} from "./workos_session";

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
const MAX_TURNSTILE_TOKEN_BYTES = 2_048;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DELETION_RETRY_SECONDS = 5 * 60;
// One tenant per invocation keeps the 47-statement purge plus dispatcher and
// verification queries below Workers' tightest D1 per-invocation budget.
const DELETION_SWEEP_LIMIT = 1;
const DELETION_KV_BATCH_LIMIT = 20;
const R2_DELETE_PAGE_LIMIT = 1_000;
const R2_DELETE_MAX_PAGES_PER_PASS = 20;

export interface AccountR2ObjectLike {
  readonly key: string;
}

export interface AccountR2ListResultLike {
  objects: AccountR2ObjectLike[];
  truncated?: boolean;
  cursor?: string;
}

export interface AccountR2BucketLike extends DeletionLedgerBucketLike {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<AccountR2ListResultLike>;
  delete(keys: string | string[]): Promise<void>;
}

export interface AccountKVNamespaceLike {
  delete(key: string): Promise<void>;
}

export interface AccountEnv {
  DB: D1DatabaseLike;
  HOSTED_SURFACE?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  WORKOS_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
  LANDING_ORIGIN?: string;
  HOSTED_SIGNUP_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface AccountDeletionEnv extends AccountEnv {
  BODIES?: AccountR2BucketLike;
  APIKEY_KV?: AccountKVNamespaceLike;
  GATEWAY_KV?: AccountKVNamespaceLike;
}

function isAccountR2Bucket(value: unknown): value is AccountR2BucketLike {
  return typeof value === "object" && value !== null &&
    "head" in value && typeof value.head === "function" &&
    "get" in value && typeof value.get === "function" &&
    "put" in value && typeof value.put === "function" &&
    "list" in value && typeof value.list === "function" &&
    "delete" in value && typeof value.delete === "function";
}

function isAccountKVNamespace(value: unknown): value is AccountKVNamespaceLike {
  return typeof value === "object" && value !== null &&
    "delete" in value && typeof value.delete === "function";
}

/**
 * Project an arbitrary Worker env onto the deletion bindings after validating
 * the optional object-store surface. AccountEnv intentionally does not claim
 * BODIES: sibling modules use richer, different structural subsets of the
 * same generated R2 binding.
 */
export function accountDeletionEnv(env: AccountEnv): AccountDeletionEnv {
  const candidate = "BODIES" in env ? env.BODIES : undefined;
  const apiKeyKV = "APIKEY_KV" in env ? env.APIKEY_KV : undefined;
  const gatewayKV = "GATEWAY_KV" in env ? env.GATEWAY_KV : undefined;
  return {
    DB: env.DB,
    WORKOS_API_KEY: env.WORKOS_API_KEY,
    APP_ORIGIN: env.APP_ORIGIN,
    HOSTED_SURFACE: env.HOSTED_SURFACE,
    ...(isAccountR2Bucket(candidate) ? { BODIES: candidate } : {}),
    ...(isAccountKVNamespace(apiKeyKV) ? { APIKEY_KV: apiKeyKV } : {}),
    ...(isAccountKVNamespace(gatewayKV) ? { GATEWAY_KV: gatewayKV } : {}),
  };
}

export interface SessionAccount {
  sessionId: string;
  userId: string;
  /** Exact hash matched by the current request; never returned by sessionView. */
  tokenHash: string;
  /** Provider logout handle; never returned by sessionView. */
  workosSessionId: string;
  /** Immutable WorkOS user subject; never returned by sessionView. */
  workosProviderSubject: string;
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
  token_hash: string;
  workos_session_id: string;
  workos_provider_subject: string;
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
  access_token?: unknown;
  // Deliberately not modeled: refresh_token is discarded at the JSON boundary.
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type WorkOSAccessTokenVerifier = (
  accessToken: string,
  binding: WorkOSSessionBinding,
) => Promise<VerifiedWorkOSSession | null>;

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

/**
 * Opaque credential material for tokens this platform issues (browser
 * sessions, device tokens, invite links). Only the SHA-256 is ever persisted.
 */
export function randomSecret(byteLength = 32): string {
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

/** Parse a configured origin, rejecting anything that is not a bare https (or loopback) origin. */
export function normalizedOrigin(value: string | undefined): string | null {
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
  turnstile: TurnstileConfig | null;
}

interface TurnstileConfig {
  siteKey: string;
  secretKey: string;
}

interface TurnstileConfigState {
  config: TurnstileConfig | null;
  invalid: boolean;
}

type AuthIntent = "signin" | "signup";

function turnstileConfigState(env: AccountEnv): TurnstileConfigState {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (siteKey === "" && secretKey === "") return { config: null, invalid: false };
  // Sitekeys and secrets are opaque printable credentials. Reject partial,
  // oversized, or control-bearing values before they can affect HTML or an
  // outbound Siteverify request.
  if (
    siteKey === "" ||
    secretKey === "" ||
    siteKey.length > 256 ||
    secretKey.length > 512 ||
    !/^[\x21-\x7e]+$/.test(siteKey) ||
    !/^[\x21-\x7e]+$/.test(secretKey)
  ) {
    return { config: null, invalid: true };
  }
  return { config: { siteKey, secretKey }, invalid: false };
}

function authConfig(env: AccountEnv): AuthConfig | null {
  const appOrigin = normalizedOrigin(env.APP_ORIGIN);
  const landingOrigin = normalizedOrigin(env.LANDING_ORIGIN);
  const turnstileState = turnstileConfigState(env);
  if (
    !env.WORKOS_CLIENT_ID ||
    !env.WORKOS_API_KEY ||
    !env.WORKOS_REDIRECT_URI ||
    appOrigin === null ||
    turnstileState.invalid
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
    turnstile: turnstileState.config,
  };
}

/**
 * Return the same strict readiness result used by every hosted auth route.
 *
 * The account page uses this predicate to avoid rendering links that would
 * deterministically fail at /v1/auth/start because of a malformed origin or
 * callback. It intentionally exposes only a boolean; secrets and normalized
 * configuration never leave this module.
 */
export function hostedAuthConfigured(env: AccountEnv): boolean {
  return authConfig(env) !== null;
}

/** Return the public widget key only when the complete Turnstile pair is safe. */
export function hostedTurnstileSiteKey(env: AccountEnv): string | null {
  return authConfig(env)?.turnstile?.siteKey ?? null;
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

async function verifyTurnstileToken(
  request: Request,
  config: AuthConfig,
  intent: AuthIntent,
  token: string,
  fetcher: Fetcher,
): Promise<boolean> {
  const form = new URLSearchParams({
    secret: config.turnstile?.secretKey ?? "",
    response: token,
  });
  const remoteIP = request.headers.get("cf-connecting-ip");
  if (remoteIP !== null && remoteIP.length <= 128 && /^[\x20-\x7e]+$/.test(remoteIP)) {
    form.set("remoteip", remoteIP);
  }
  let response: Response;
  try {
    response = await fetcher(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const result = payload as Record<string, unknown>;
  return result.success === true &&
    result.action === `auth-${intent}` &&
    result.hostname === new URL(config.appOrigin).hostname;
}

export async function startAuth(
  request: Request,
  env: AccountEnv,
  fetcher: Fetcher = fetch,
): Promise<Response> {
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
  if (config.turnstile !== null) {
    if (request.method !== "POST" || request.headers.get("origin") !== config.appOrigin) {
      return json(403, {
        error: "turnstile_required",
        message: "Complete the security check before signing in.",
      });
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
    if (contentType !== "application/x-www-form-urlencoded") {
      return json(400, { error: "invalid_turnstile_request" });
    }
    const body = await readRequestBody(request, MAX_ACCOUNT_BODY_BYTES);
    if (!body.ok) return json(body.status, { error: "invalid_turnstile_request" });
    const token = new URLSearchParams(body.text).get("cf-turnstile-response") ?? "";
    if (
      token.length === 0 ||
      token.length > MAX_TURNSTILE_TOKEN_BYTES ||
      !/^[\x21-\x7e]+$/.test(token) ||
      !(await verifyTurnstileToken(request, config, intent, token, fetcher))
    ) {
      return json(403, {
        error: "turnstile_rejected",
        message: "The security check could not be verified. Please try again.",
      });
    }
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
  pkceVerifier: string,
  now: number,
  fetcher: Fetcher,
  accessTokenVerifier: WorkOSAccessTokenVerifier,
): Promise<{ user: WorkOSUser; workosSessionId: string } | null> {
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
        code_verifier: pkceVerifier,
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
    user.email_verified !== true ||
    typeof payload.access_token !== "string" ||
    payload.access_token === ""
  ) {
    return null;
  }
  let verified: VerifiedWorkOSSession | null;
  try {
    verified = await accessTokenVerifier(payload.access_token, {
      clientId: config.clientId,
      userId: user.id,
      now,
    });
  } catch {
    verified = null;
  }
  if (
    verified === null ||
    verified.subject !== user.id ||
    verified.clientId !== config.clientId ||
    !isValidWorkOSSessionID(verified.sessionId)
  ) {
    return null;
  }
  // Access and refresh tokens become unreachable here. Only the verified
  // immutable user and bounded logout handle cross into account logic.
  return { user, workosSessionId: verified.sessionId };
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
interface HostedCapacityRow { active_accounts: number }
interface ProviderSubjectRow { provider_subject: string }

async function provisionAccount(
  db: D1DatabaseLike,
  providerUser: WorkOSUser,
  now: number,
  allowCreate: boolean,
  capacityLedgerBinding: unknown,
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
    const capacity = await db.prepare(`
      SELECT active_accounts
      FROM hosted_beta_capacity
      WHERE id = 'global'`)
      .bind()
      .first<HostedCapacityRow>();
    if (capacity === null) throw new Error("hosted capacity unavailable");
    const currentIdentities = await db.prepare(`
      SELECT provider_subject
      FROM provider_identities
      WHERE provider = 'workos'
      ORDER BY provider_subject
      LIMIT 51`)
      .bind()
      .all<ProviderSubjectRow>();
    await auditHostedBetaCapacityCoverage(capacityLedgerBinding, {
      d1ActiveAccounts: capacity.active_accounts,
      currentProviderSubjects: currentIdentities.results.map((row) => row.provider_subject),
    });
    // Burn the external lifetime allocation before D1 account creation. D1
    // Time Travel can roll its local counter backwards; this ETag-CAS ledger
    // cannot. A later D1 failure intentionally leaves the issuance consumed.
    await reserveHostedBetaIssuance(capacityLedgerBinding, providerUser.id);
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
  } else {
    // Existing identities consume no new allocation, but a D1 restore can
    // resurrect an identity whose independent lifetime issuance is absent.
    // Membership verification is read-only and fails closed on that split.
    await verifyHostedBetaIssuanceMembership(capacityLedgerBinding, providerUser.id);
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
  workosSessionId: string,
  now: number,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = `hfg_session_${randomSecret()}`;
  const csrfToken = randomSecret();
  // Hosted beta accounts intentionally have one browser session. Replacing
  // it on login bounds D1 session growth and rotates credentials without a
  // background cleanup job. The delete and insert commit atomically.
  const results = await db.batch([
    db.prepare("DELETE FROM account_sessions WHERE user_id = ?1").bind(userId),
    db.prepare(`
      INSERT INTO account_sessions
        (id, user_id, token_hash, csrf_hash, created_at, expires_at,
         last_seen_at, revoked_at, workos_session_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, NULL, ?7)`)
      .bind(
        newAccountSessionID(),
        userId,
        await sha256Hex(sessionToken),
        await sha256Hex(csrfToken),
        now,
        now + SESSION_TTL_SECONDS,
        workosSessionId,
      ),
  ]);
  if (results[1]?.success !== true || results[1].meta?.changes !== 1) {
    throw new Error("browser session creation failed");
  }
  return { sessionToken, csrfToken };
}

async function rotateBrowserSession(
  db: D1DatabaseLike,
  predecessor: SessionAccount,
  providerUser: WorkOSUser,
  workosSessionId: string,
  now: number,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = `hfg_session_${randomSecret()}`;
  const csrfToken = randomSecret();
  const tokenHash = await sha256Hex(sessionToken);
  const csrfHash = await sha256Hex(csrfToken);
  const name = displayName(providerUser);
  const avatar = typeof providerUser.profile_picture_url === "string"
    ? providerUser.profile_picture_url.slice(0, 2_048)
    : null;
  const expiresAt = now + SESSION_TTL_SECONDS;

  // The session rotation is the first statement and the serialization point.
  // Profile/identity statements are then guarded by the *new* hash. If this
  // callback loses to sign-out or another callback, the first statement and
  // every following statement affect zero rows. D1 batch failures roll the
  // complete sequence back.
  const results = await db.batch([
    db.prepare(`
      /* account-reauth:rotate */
      UPDATE account_sessions
      SET token_hash = ?4,
          csrf_hash = ?5,
          expires_at = ?6,
          last_seen_at = ?7,
          workos_session_id = ?8
      WHERE id = ?1
        AND user_id = ?2
        AND token_hash = ?3
        AND revoked_at IS NULL
        AND expires_at > ?7
        AND EXISTS (
          SELECT 1
          FROM users AS guarded_user
          JOIN workspace_members AS guarded_member
            ON guarded_member.user_id = guarded_user.id
           AND guarded_member.workspace_id = guarded_user.personal_workspace_id
           AND guarded_member.status = 'active'
          JOIN workspaces AS guarded_workspace
            ON guarded_workspace.id = guarded_user.personal_workspace_id
           AND guarded_workspace.workspace_id = guarded_user.personal_workspace_id
           AND guarded_workspace.status = 'active'
          WHERE guarded_user.id = ?2
            AND guarded_user.personal_workspace_id = ?10
            AND guarded_user.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM provider_identities AS guarded_identity
          WHERE guarded_identity.provider = 'workos'
            AND guarded_identity.provider_subject = ?9
            AND guarded_identity.user_id = ?2
        )`)
      .bind(
        predecessor.sessionId,
        predecessor.userId,
        predecessor.tokenHash,
        tokenHash,
        csrfHash,
        expiresAt,
        now,
        workosSessionId,
        providerUser.id,
        predecessor.workspaceId,
      ),
    db.prepare(`
      /* account-reauth:profile */
      UPDATE users
      SET email = ?2,
          display_name = ?3,
          avatar_url = ?4,
          email_verified = 1,
          updated_at = ?5
      WHERE id = ?1
        AND status = 'active'
        AND personal_workspace_id = ?8
        AND EXISTS (
          SELECT 1 FROM account_sessions AS rotated_session
          WHERE rotated_session.id = ?6
            AND rotated_session.user_id = ?1
            AND rotated_session.token_hash = ?7
            AND rotated_session.workos_session_id = ?10
            AND rotated_session.revoked_at IS NULL
            AND rotated_session.expires_at > ?5
        )
        AND EXISTS (
          SELECT 1 FROM workspaces AS guarded_workspace
          WHERE guarded_workspace.id = ?8
            AND guarded_workspace.workspace_id = ?8
            AND guarded_workspace.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM provider_identities AS guarded_identity
          WHERE guarded_identity.provider = 'workos'
            AND guarded_identity.provider_subject = ?9
            AND guarded_identity.user_id = ?1
        )`)
      .bind(
        predecessor.userId,
        providerUser.email,
        name,
        avatar,
        now,
        predecessor.sessionId,
        tokenHash,
        predecessor.workspaceId,
        providerUser.id,
        workosSessionId,
      ),
    db.prepare(`
      /* account-reauth:provider-identity */
      UPDATE provider_identities
      SET email = ?3,
          updated_at = ?4
      WHERE provider = 'workos'
        AND provider_subject = ?1
        AND user_id = ?2
        AND EXISTS (
          SELECT 1 FROM account_sessions AS rotated_session
          JOIN users AS guarded_user
            ON guarded_user.id = rotated_session.user_id
           AND guarded_user.personal_workspace_id = ?7
           AND guarded_user.status = 'active'
          JOIN workspaces AS guarded_workspace
            ON guarded_workspace.id = guarded_user.personal_workspace_id
           AND guarded_workspace.workspace_id = guarded_user.personal_workspace_id
           AND guarded_workspace.status = 'active'
          WHERE rotated_session.id = ?5
            AND rotated_session.user_id = ?2
            AND rotated_session.token_hash = ?6
            AND rotated_session.workos_session_id = ?8
            AND rotated_session.revoked_at IS NULL
            AND rotated_session.expires_at > ?4
        )`)
      .bind(
        providerUser.id,
        predecessor.userId,
        providerUser.email,
        now,
        predecessor.sessionId,
        tokenHash,
        predecessor.workspaceId,
        workosSessionId,
      ),
  ]);
  if (
    results.length !== 3 ||
    results.some((result) => result.success !== true || result.meta?.changes !== 1)
  ) {
    throw new Error("browser session rotation lost");
  }
  return { sessionToken, csrfToken };
}

export async function finishAuth(
  request: Request,
  env: AccountEnv,
  fetcher: Fetcher = fetch,
  accessTokenVerifier: WorkOSAccessTokenVerifier = verifyWorkOSAccessToken,
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

  let predecessor: SessionAccount | null = null;
  if (cookies.has(SESSION_COOKIE)) {
    try {
      predecessor = await authenticateAccountSession(request, env);
    } catch {
      return json(503, { error: "hosted_beta_unavailable" }, clearAuthCookies());
    }
    if (predecessor === null) {
      // An invalid/stale local credential must never silently become an
      // anonymous provisioning callback. Clear it so a fresh flow can start.
      return json(401, { error: "invalid_auth_callback" }, [
        ...clearAuthCookies(),
        clearCookie(SESSION_COOKIE, true),
        clearCookie(CSRF_COOKIE, false),
      ]);
    }
  }

  const now = Math.floor(Date.now() / 1_000);
  const authenticated = await exchangeWorkOSCode(
    config,
    code,
    verifier,
    now,
    fetcher,
    accessTokenVerifier,
  );
  if (authenticated === null) {
    return json(502, { error: "authentication_unavailable" }, clearAuthCookies());
  }
  const { user: providerUser, workosSessionId } = authenticated;
  if (
    predecessor !== null &&
    providerUser.id !== predecessor.workosProviderSubject
  ) {
    return json(503, { error: "hosted_beta_unavailable" }, clearAuthCookies());
  }

  let account: { userId: string; workspaceId: string };
  let session: { sessionToken: string; csrfToken: string };
  try {
    if (predecessor !== null) {
      await verifyHostedBetaIssuanceMembership(
        deletionLedgerBinding(env),
        providerUser.id,
      );
      session = await rotateBrowserSession(
        env.DB,
        predecessor,
        providerUser,
        workosSessionId,
        now,
      );
      account = {
        userId: predecessor.userId,
        workspaceId: predecessor.workspaceId,
      };
    } else {
      const allowCreate =
        env.HOSTED_SIGNUP_ENABLED === "true" &&
        cookies.get(INTENT_COOKIE) === "signup";
      account = await provisionAccount(
        env.DB,
        providerUser,
        now,
        allowCreate,
        deletionLedgerBinding(env),
      );
      // A pre-deletion D1 Time Travel restore can bring the provider identity
      // and account row back. The independent R2 ledger is terminal: never mint
      // a fresh browser credential for a fenced workspace.
      if (await workspaceDeletionBlocksAuthentication(
        deletionLedgerBinding(env),
        account.workspaceId,
        deletionLedgerRequired(env),
      )) {
        return json(503, { error: "hosted_beta_unavailable" }, clearAuthCookies());
      }
      session = await createBrowserSession(
        env.DB,
        account.userId,
        workosSessionId,
        now,
      );
    }
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
    s.token_hash,
    s.workos_session_id,
    workos_identity.provider_subject AS workos_provider_subject,
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
  JOIN provider_identities AS workos_identity
    ON workos_identity.user_id = u.id
   AND workos_identity.provider = 'workos'
  JOIN workspace_members AS m
    ON m.user_id = u.id AND m.workspace_id = u.personal_workspace_id
  JOIN workspaces AS w ON w.id = m.workspace_id
  JOIN workspace_entitlements AS e ON e.workspace_id = m.workspace_id
  WHERE s.token_hash = ?1
    AND s.workos_session_id IS NOT NULL
    AND s.revoked_at IS NULL
    AND s.expires_at > ?2
    AND u.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM provider_identities AS other_workos_identity
      WHERE other_workos_identity.user_id = u.id
        AND other_workos_identity.provider = 'workos'
        AND other_workos_identity.provider_subject <>
            workos_identity.provider_subject
    )
    AND m.status = 'active'
    AND w.status = 'active'`;

export async function authenticateAccountSession(
  request: Request,
  source: D1DatabaseLike | AccountEnv,
): Promise<SessionAccount | null> {
  const sourceIsDatabase = "prepare" in source && typeof source.prepare === "function";
  const accountEnv: AccountEnv | null = sourceIsDatabase ? null : source as AccountEnv;
  const db: D1DatabaseLike = sourceIsDatabase ? source as D1DatabaseLike : (source as AccountEnv).DB;
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (token === undefined || token.length < 32 || token.length > 256) return null;
  const now = Math.floor(Date.now() / 1_000);
  const row = await db.prepare(SESSION_SQL)
    .bind(await sha256Hex(token), now)
    .first<SessionRow>();
  if (row === null) return null;
  if (await workspaceDeletionBlocksAuthentication(
    accountEnv === null ? undefined : deletionLedgerBinding(accountEnv),
    row.workspace_id,
    accountEnv !== null && deletionLedgerRequired(accountEnv),
  )) return null;
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
    tokenHash: row.token_hash,
    workosSessionId: row.workos_session_id,
    workosProviderSubject: row.workos_provider_subject,
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
  const session = await authenticateAccountSession(request, env);
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

/**
 * Gate for every state-changing account-plane route: exact same-origin, a
 * valid browser session, and a matching CSRF token. Exported so sibling
 * account-plane modules (teams.ts) enforce the identical contract rather than
 * reimplementing it.
 */
export async function authorizedUnsafeRequest(
  request: Request,
  env: AccountEnv,
): Promise<{ response: Response } | { session: SessionAccount }> {
  if (!allowedUnsafeOrigin(request, env)) {
    return { response: json(403, { error: "forbidden" }) };
  }
  const session = await authenticateAccountSession(request, env);
  if (session === null) return { response: json(401, { error: "unauthorized" }) };
  if (!(await validCsrf(request, session))) {
    return { response: json(403, { error: "invalid_csrf" }) };
  }
  return { session };
}

export async function signOut(request: Request, env: AccountEnv): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  const appOrigin = normalizedOrigin(env.APP_ORIGIN);
  if (appOrigin === null) return json(503, { error: "hosted_auth_unavailable" });
  const now = Math.floor(Date.now() / 1_000);
  let result;
  try {
    result = await env.DB.prepare(`
      /* account-signout:revoke-user */
      UPDATE account_sessions
      SET revoked_at = ?3
      WHERE user_id = ?1
        AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM account_sessions AS stable_session
          JOIN users AS guarded_user
            ON guarded_user.id = stable_session.user_id
           AND guarded_user.status = 'active'
          JOIN workspaces AS guarded_workspace
            ON guarded_workspace.id = guarded_user.personal_workspace_id
           AND guarded_workspace.workspace_id = guarded_user.personal_workspace_id
           AND guarded_workspace.status = 'active'
          WHERE stable_session.id = ?2
            AND stable_session.user_id = ?1
            AND stable_session.revoked_at IS NULL
            AND stable_session.expires_at > ?3
            AND stable_session.workos_session_id IS NOT NULL
        )
      RETURNING id, workos_session_id`)
      .bind(auth.session.userId, auth.session.sessionId, now)
      .all<{ id: string; workos_session_id: string }>();
  } catch {
    return json(503, { error: "signout_unavailable" });
  }
  if (
    result.success === false ||
    result.results.length !== 1 ||
    result.results[0].id !== auth.session.sessionId ||
    !isValidWorkOSSessionID(result.results[0].workos_session_id)
  ) {
    return json(401, { error: "unauthorized" });
  }
  const logoutURL = new URL("https://api.workos.com/user_management/sessions/logout");
  logoutURL.searchParams.set("session_id", result.results[0].workos_session_id);
  logoutURL.searchParams.set("return_to", `${appOrigin}/account`);
  return json(200, { logout_url: logoutURL.toString() }, [
    clearCookie(SESSION_COOKIE, true),
    clearCookie(CSRF_COOKIE, false),
    ...clearAuthCookies(),
  ]);
}

interface DeviceRow {
  id: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export async function listDevices(request: Request, env: AccountEnv): Promise<Response> {
  const session = await authenticateAccountSession(request, env);
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

/** Read a bounded (4 KiB) JSON object body; null when absent or malformed. */
export async function readAccountJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
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

  const body = await readAccountJsonBody(request);
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
    const inserted = await env.DB.prepare(`
      /* account-device:create */
      INSERT INTO devices
        (id, workspace_id, token_hash, label, capabilities, created_at, last_seen_at, revoked_at)
      SELECT ?1, ?2, ?3, ?4, 'ingest,read', ?5, NULL, NULL
      WHERE EXISTS (
        SELECT 1
        FROM account_sessions AS guarded_session
        JOIN users AS guarded_user
          ON guarded_user.id = guarded_session.user_id
         AND guarded_user.personal_workspace_id = ?2
         AND guarded_user.status = 'active'
        JOIN workspace_members AS guarded_member
          ON guarded_member.workspace_id = ?2
         AND guarded_member.user_id = guarded_user.id
         AND guarded_member.role = 'owner'
         AND guarded_member.status = 'active'
        JOIN workspaces AS guarded_workspace
          ON guarded_workspace.id = ?2
         AND guarded_workspace.workspace_id = ?2
         AND guarded_workspace.status = 'active'
        WHERE guarded_session.id = ?6
          AND guarded_session.user_id = ?7
          AND guarded_session.token_hash = ?8
          AND guarded_session.revoked_at IS NULL
          AND guarded_session.expires_at > ?5
      )
      RETURNING id`)
      .bind(
        deviceId,
        auth.session.workspaceId,
        await sha256Hex(token),
        label.trim(),
        now,
        auth.session.sessionId,
        auth.session.userId,
        auth.session.tokenHash,
      )
      .first<{ id: string }>();
    if (inserted === null) return json(401, { error: "unauthorized" });
  } catch (error) {
    if (error instanceof Error && error.message.includes("device quota exceeded")) {
      const current = await authenticateAccountSession(request, env);
      if (
        current === null ||
        current.sessionId !== auth.session.sessionId ||
        current.userId !== auth.session.userId ||
        current.tokenHash !== auth.session.tokenHash ||
        current.workspaceId !== auth.session.workspaceId ||
        current.role !== "owner"
      ) {
        return json(401, { error: "unauthorized" });
      }
      return quotaResponse(current);
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
    /* account-device:revoke */
    UPDATE devices
    SET revoked_at = ?3
    WHERE id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM account_sessions AS guarded_session
        JOIN users AS guarded_user
          ON guarded_user.id = guarded_session.user_id
         AND guarded_user.personal_workspace_id = ?2
         AND guarded_user.status = 'active'
        JOIN workspace_members AS guarded_member
          ON guarded_member.workspace_id = ?2
         AND guarded_member.user_id = guarded_user.id
         AND guarded_member.role = 'owner'
         AND guarded_member.status = 'active'
        JOIN workspaces AS guarded_workspace
          ON guarded_workspace.id = ?2
         AND guarded_workspace.workspace_id = ?2
         AND guarded_workspace.status = 'active'
        WHERE guarded_session.id = ?4
          AND guarded_session.user_id = ?5
          AND guarded_session.token_hash = ?6
          AND guarded_session.revoked_at IS NULL
          AND guarded_session.expires_at > ?3
      )
    RETURNING id`)
    .bind(
      deviceId,
      auth.session.workspaceId,
      now,
      auth.session.sessionId,
      auth.session.userId,
      auth.session.tokenHash,
    )
    .first<{ id: string }>();
  if (revoked === null) {
    // Distinguish a true tenant-scoped device miss from a session that lost
    // the commit race to sign-out, reauthentication, or account deletion.
    const current = await authenticateAccountSession(request, env);
    if (
      current === null ||
      current.sessionId !== auth.session.sessionId ||
      current.userId !== auth.session.userId ||
      current.tokenHash !== auth.session.tokenHash ||
      current.workspaceId !== auth.session.workspaceId ||
      current.role !== "owner"
    ) {
      return json(401, { error: "unauthorized" });
    }
    return json(404, { error: "not found" });
  }
  return json(200, { ok: true });
}

// -- owner-confirmed account/workspace deletion ----------------------------

export const WORKSPACE_PURGE_TABLES = Object.freeze([
  // Children before parents where a foreign key exists. Every statement is
  // still scoped by workspace_id; ordering is not used as an authorization
  // mechanism.
  "annotation_items",
  "annotation_queues",
  "dashboard_shares",
  "dashboard_versions",
  "dashboards",
  "gateway_capture_bodies",
  "gateway_requests",
  "gateway_keys",
  "webhook_deliveries",
  "webhook_cursors",
  "webhook_endpoints",
  "workspace_invites",
  "audit_chain",
  "attachments",
  "artifact_file_list",
  "alert_rules",
  "api_keys",
  "checkpoints",
  "devices",
  "ee_masking_rules",
  "ee_scim_tokens",
  "ee_sso_connections",
  "eval_runs",
  "eval_configs",
  "events",
  "exports",
  "handoffs",
  "idempotency_keys",
  "playground_runs",
  "quota_reservations",
  "repositories",
  "retention_policies",
  "sessions",
  "simulation_runs",
  "simulation_scenarios",
  "span_fingerprints",
  "span_observations",
  "spans",
  "traces",
  "workspace_entitlements",
  "workspace_members",
  "workspace_seats",
  "workstreams",
] as const);

export function workspaceObjectPrefixes(workspaceId: string): readonly string[] {
  return Object.freeze([
    `artifacts/${workspaceId}/`,
    `exports/${workspaceId}/`,
    `attachments/${workspaceId}/`,
    `gwcache/${workspaceId}/`,
  ]);
}

interface WorkspaceDeletionRow {
  workspace_id: string;
  requested_by_user_id: string | null;
  status: "pending" | "r2_grace" | "complete";
  next_attempt_at: number | null;
  workos_deleted_at: number | null;
}

interface DeletionBlockRow {
  blocked: number;
}

interface WorkOSIdentityRow {
  provider_subject: string;
}

interface WorkspaceDeletionKVKeyRow {
  namespace: "apikey" | "gateway";
  cache_key: string;
}

async function accountHasForeignWorkspaceLinks(
  db: D1DatabaseLike,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const row = await db.prepare(`
    /* account-deletion:foreign-workspace-links */
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM workspace_members
        WHERE user_id = ?1 AND workspace_id <> ?2
      ) OR EXISTS (
        SELECT 1 FROM workspace_invites
        WHERE workspace_id <> ?2
          AND (created_by = ?1 OR accepted_by = ?1)
      )
    THEN 1 ELSE 0 END AS blocked`)
    .bind(userId, workspaceId)
    .first<DeletionBlockRow>();
  return row?.blocked === 1;
}

async function deletionByWorkspace(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<WorkspaceDeletionRow | null> {
  return db.prepare(`
    /* account-deletion:job */
    SELECT workspace_id, requested_by_user_id, status, next_attempt_at,
           workos_deleted_at
    FROM workspace_deletions
    WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<WorkspaceDeletionRow>();
}

async function deleteWorkOSIdentity(
  env: AccountDeletionEnv,
  job: WorkspaceDeletionRow,
  now: number,
  fetcher: Fetcher,
): Promise<boolean> {
  if (job.workos_deleted_at !== null) return true;
  const apiKey = env.WORKOS_API_KEY;
  const userId = job.requested_by_user_id;
  if (typeof apiKey !== "string" || apiKey === "" || userId === null) return false;

  const identity = await env.DB.prepare(`
    /* account-deletion:workos-identity */
    SELECT provider_subject
    FROM provider_identities
    WHERE provider = 'workos' AND user_id = ?1
    LIMIT 1`)
    .bind(userId)
    .first<WorkOSIdentityRow>();
  if (identity === null || identity.provider_subject === "") return false;

  let response: Response;
  try {
    response = await fetcher(
      `https://api.workos.com/user_management/users/${encodeURIComponent(identity.provider_subject)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      },
    );
  } catch {
    return false;
  }
  if (!response.ok && response.status !== 404) return false;

  const marked = await env.DB.prepare(`
    /* account-deletion:workos-complete */
    UPDATE workspace_deletions
    SET workos_deleted_at = ?2,
        next_attempt_at = ?3
    WHERE workspace_id = ?1
      AND status = 'pending'
      AND workos_deleted_at IS NULL`)
    .bind(job.workspace_id, now, now + DELETION_RETRY_SECONDS)
    .run();
  return marked.success === true && marked.meta?.changes !== 0;
}

async function deleteWorkspaceKVBatch(
  env: AccountDeletionEnv,
  workspaceId: string,
  now: number,
): Promise<"complete" | "progress" | "unavailable" | "failed"> {
  const apiKeyKV = env.APIKEY_KV;
  const gatewayKV = env.GATEWAY_KV;
  const page = await env.DB.prepare(`
    /* account-deletion:kv-keys */
    SELECT namespace, cache_key
    FROM workspace_deletion_kv_keys
    WHERE workspace_id = ?1 AND deleted_at IS NULL
    ORDER BY namespace, cache_key
    LIMIT ?2`)
    .bind(workspaceId, DELETION_KV_BATCH_LIMIT)
    .all<WorkspaceDeletionKVKeyRow>();
  if (page.results.length === 0) return "complete";
  if (
    (page.results.some((row) => row.namespace === "apikey") && apiKeyKV === undefined) ||
    (page.results.some((row) => row.namespace === "gateway") && gatewayKV === undefined)
  ) {
    return "unavailable";
  }

  try {
    await Promise.all(page.results.map((row) => {
      const namespace = row.namespace === "apikey" ? apiKeyKV : gatewayKV;
      if (namespace === undefined) throw new Error("KV namespace unavailable");
      return namespace.delete(row.cache_key);
    }));
  } catch {
    return "failed";
  }

  const placeholders = page.results.map((_, index) => `?${index + 3}`).join(", ");
  const marked = await env.DB.prepare(`
    /* account-deletion:kv-mark-deleted */
    UPDATE workspace_deletion_kv_keys
    SET deleted_at = ?2
    WHERE workspace_id = ?1
      AND deleted_at IS NULL
      AND cache_key IN (${placeholders})`)
    .bind(workspaceId, now, ...page.results.map((row) => row.cache_key))
    .run();
  if (marked.success !== true ||
      (marked.meta?.changes !== undefined && marked.meta.changes !== page.results.length)) {
    return "failed";
  }
  return "progress";
}

async function sweepWorkspaceR2(
  bucket: AccountR2BucketLike,
  workspaceId: string,
): Promise<{ complete: boolean; deleted: number }> {
  let deleted = 0;
  let pages = 0;
  for (const prefix of workspaceObjectPrefixes(workspaceId)) {
    while (true) {
      if (pages >= R2_DELETE_MAX_PAGES_PER_PASS) {
        return { complete: false, deleted };
      }
      const page = await bucket.list({
        prefix,
        limit: R2_DELETE_PAGE_LIMIT,
      });
      pages += 1;
      const keys = page.objects.map((object) => object.key);
      if (keys.some((key) => !key.startsWith(prefix))) {
        // A broken fake/binding must never widen deletion beyond the exact
        // authenticated tenant prefix.
        throw new Error("R2 returned an object outside the requested prefix");
      }
      if (keys.length > 0) {
        await bucket.delete(keys);
        deleted += keys.length;
        // R2 listings and deletes are strongly consistent. Start again at the
        // exact tenant prefix instead of carrying a cursor across mutations;
        // the first page after deletion is the safest proof that nothing was
        // skipped.
        continue;
      }
      if (page.truncated === true) {
        throw new Error("R2 returned an empty truncated page");
      }
      break;
    }
  }
  return { complete: true, deleted };
}

async function recordDeletionRetry(
  db: D1DatabaseLike,
  workspaceId: string,
  now: number,
): Promise<void> {
  await db.prepare(`
    /* account-deletion:retry */
    UPDATE workspace_deletions
    SET next_attempt_at = ?2,
        r2_sweeps = r2_sweeps + 1
    WHERE workspace_id = ?1 AND status <> 'complete'`)
    .bind(workspaceId, now + DELETION_RETRY_SECONDS)
    .run();
}

function workspacePurgeStatements(
  db: D1DatabaseLike,
  workspaceId: string,
  userId: string,
  now: number,
): D1BoundStatement[] {
  const tenantDeletes = WORKSPACE_PURGE_TABLES.map((table) =>
    db.prepare(`/* account-deletion:purge:${table} */ DELETE FROM ${table} WHERE workspace_id = ?1`)
      .bind(workspaceId));
  return [
    db.prepare(`
      /* account-deletion:restart-kv-grace */
      UPDATE workspace_deletion_kv_keys
      SET deleted_at = NULL
      WHERE workspace_id = ?1`)
      .bind(workspaceId),
    ...tenantDeletes,
    db.prepare(`
      /* account-deletion:user */
      DELETE FROM users
      WHERE id = ?1 AND personal_workspace_id = ?2`)
      .bind(userId, workspaceId),
    db.prepare(`
      /* account-deletion:workspace */
      DELETE FROM workspaces
      WHERE id = ?1 AND workspace_id = ?1`)
      .bind(workspaceId),
    db.prepare(`
      /* account-deletion:enter-r2-grace */
      UPDATE workspace_deletions
      SET requested_by_user_id = NULL,
          status = 'r2_grace',
          next_attempt_at = ?2,
          r2_sweeps = r2_sweeps + 1
      WHERE workspace_id = ?1
        AND requested_by_user_id = ?3
        AND status = 'pending'
        AND workos_deleted_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM workspaces WHERE id = ?1 OR workspace_id = ?1
        )`)
      .bind(workspaceId, now + DELETION_RETRY_SECONDS, userId),
  ];
}

export async function processWorkspaceDeletion(
  env: AccountDeletionEnv,
  job: WorkspaceDeletionRow,
  now = Math.floor(Date.now() / 1_000),
  fetcher: Fetcher = fetch,
): Promise<WorkspaceDeletionRow["status"]> {
  if (job.status === "complete") return "complete";

  // The independently restored R2 ledger is the authorization record for
  // every destructive saga step. D1 Time Travel can resurrect a deletion job
  // (or its tenant rows) without the corresponding point in history; absent,
  // corrupt, conflicting, or unavailable ledger state must only schedule a
  // retry and must never reach WorkOS, KV, R2 tenant prefixes, or D1 purge.
  const bucket = env.BODIES;
  if (bucket === undefined) {
    await recordDeletionRetry(env.DB, job.workspace_id, now);
    return job.status;
  }
  try {
    const ledger = await readDeletionLedger(bucket, job.workspace_id);
    if (
      ledger === null ||
      (job.status === "pending" &&
        (job.requested_by_user_id === null ||
          !(await deletionLedgerMatchesOwner(ledger, job.requested_by_user_id))))
    ) {
      await recordDeletionRetry(env.DB, job.workspace_id, now);
      return job.status;
    }
  } catch {
    await recordDeletionRetry(env.DB, job.workspace_id, now);
    return job.status;
  }

  if (job.status === "pending" && job.workos_deleted_at === null) {
    let deleted = false;
    try {
      deleted = await deleteWorkOSIdentity(env, job, now, fetcher);
    } catch {
      deleted = false;
    }
    if (!deleted) await recordDeletionRetry(env.DB, job.workspace_id, now);
    return "pending";
  }

  let kvState: "complete" | "progress" | "unavailable" | "failed";
  try {
    kvState = await deleteWorkspaceKVBatch(env, job.workspace_id, now);
  } catch {
    kvState = "failed";
  }
  if (kvState !== "complete") {
    await recordDeletionRetry(env.DB, job.workspace_id, now);
    return job.status;
  }

  let sweep: { complete: boolean; deleted: number };
  try {
    sweep = await sweepWorkspaceR2(bucket, job.workspace_id);
  } catch {
    await recordDeletionRetry(env.DB, job.workspace_id, now);
    return job.status;
  }
  if (!sweep.complete) {
    await recordDeletionRetry(env.DB, job.workspace_id, now);
    return job.status;
  }

  if (job.status === "pending") {
    const userId = job.requested_by_user_id;
    if (userId === null) {
      await recordDeletionRetry(env.DB, job.workspace_id, now);
      return "pending";
    }
    try {
      // D1 batch is one transaction. Existing append-only DELETE triggers
      // permit these statements only because migration 0018's exact workspace
      // tombstone already exists; a failure rolls the entire purge back.
      const results = await env.DB.batch(
        workspacePurgeStatements(env.DB, job.workspace_id, userId, now),
      );
      const transition = results.at(-1);
      if (transition?.success !== true || transition.meta?.changes !== 1) {
        await recordDeletionRetry(env.DB, job.workspace_id, now);
        return "pending";
      }
    } catch {
      await recordDeletionRetry(env.DB, job.workspace_id, now);
      return "pending";
    }
    return "r2_grace";
  }

  if (sweep.deleted > 0) {
    // A request that authenticated immediately before credential revocation
    // may finish an object write late. Require a later empty sweep before the
    // tombstone becomes terminal.
    await env.DB.batch([
      env.DB.prepare(`
        /* account-deletion:restart-kv-after-late-object */
        UPDATE workspace_deletion_kv_keys
        SET deleted_at = NULL
        WHERE workspace_id = ?1`)
        .bind(job.workspace_id),
      env.DB.prepare(`
        /* account-deletion:retry-after-late-object */
        UPDATE workspace_deletions
        SET next_attempt_at = ?2,
            r2_sweeps = r2_sweeps + 1
        WHERE workspace_id = ?1 AND status = 'r2_grace'`)
        .bind(job.workspace_id, now + DELETION_RETRY_SECONDS),
    ]);
    return "r2_grace";
  }
  await env.DB.batch([
    env.DB.prepare(`
      /* account-deletion:forget-kv-keys */
      DELETE FROM workspace_deletion_kv_keys
      WHERE workspace_id = ?1`)
      .bind(job.workspace_id),
    env.DB.prepare(`
      /* account-deletion:complete */
      UPDATE workspace_deletions
      SET status = 'complete',
          next_attempt_at = NULL,
          completed_at = ?2,
          r2_sweeps = r2_sweeps + 1
      WHERE workspace_id = ?1 AND status = 'r2_grace'`)
      .bind(job.workspace_id, now),
  ]);
  return "complete";
}

export async function accountDeletionScheduled(
  env: AccountDeletionEnv,
  now = Math.floor(Date.now() / 1_000),
  fetcher: Fetcher = fetch,
): Promise<void> {
  const due = await env.DB.prepare(`
    /* account-deletion:due */
    SELECT workspace_id, requested_by_user_id, status, next_attempt_at,
           workos_deleted_at
    FROM workspace_deletions
    WHERE status <> 'complete' AND next_attempt_at <= ?1
    ORDER BY next_attempt_at, workspace_id
    LIMIT ?2`)
    .bind(now, DELETION_SWEEP_LIMIT)
    .all<WorkspaceDeletionRow>();
  for (const job of due.results) {
    await processWorkspaceDeletion(env, job, now, fetcher);
  }
}

export async function deleteAccount(request: Request, env: AccountDeletionEnv): Promise<Response> {
  const auth = await authorizedUnsafeRequest(request, env);
  if ("response" in auth) return auth.response;
  if (auth.session.role !== "owner") return json(403, { error: "forbidden" });

  const body = await readAccountJsonBody(request);
  const expected = `DELETE ${auth.session.workspaceId}`;
  if (body?.confirmation !== expected) {
    return json(400, {
      error: "confirmation_required",
      confirmation: expected,
    });
  }
  const bucket = env.BODIES;
  if (bucket === undefined) {
    return json(503, { error: "account_deletion_unavailable" });
  }
  if (await accountHasForeignWorkspaceLinks(
    env.DB,
    auth.session.userId,
    auth.session.workspaceId,
  )) {
    return json(409, {
      error: "account_has_other_workspace_links",
      message: "This account is still referenced by another workspace. Contact support before deleting it.",
    });
  }

  const now = Math.floor(Date.now() / 1_000);
  // D1 is the commit-order arbiter between sign-out, credential rotation, and
  // deletion. The exact active, unexpired credential observed during preflight
  // must still exist when the workspace is locked. If sign-out or callback
  // rotation serialized first, this changes no row and no permanent R2 ledger
  // is written. Once this prelock wins, account deletion owns completion even
  // if a concurrent sign-out follows.
  const locked = await env.DB.prepare(`
    /* account-deletion:prelock-workspace */
    UPDATE workspaces
    SET status = 'deleting'
    WHERE id = ?1
      AND workspace_id = ?1
      AND status = 'active'
      AND EXISTS (
        SELECT 1
        FROM account_sessions AS guarded_session
        JOIN users AS guarded_user
          ON guarded_user.id = guarded_session.user_id
         AND guarded_user.personal_workspace_id = ?1
         AND guarded_user.status = 'active'
        JOIN workspace_members AS guarded_member
          ON guarded_member.workspace_id = ?1
         AND guarded_member.user_id = guarded_user.id
         AND guarded_member.role = 'owner'
         AND guarded_member.status = 'active'
        WHERE guarded_session.id = ?2
          AND guarded_session.user_id = ?3
          AND guarded_session.token_hash = ?4
          AND guarded_session.revoked_at IS NULL
          AND guarded_session.expires_at > ?5
      )
    RETURNING id`)
    .bind(
      auth.session.workspaceId,
      auth.session.sessionId,
      auth.session.userId,
      auth.session.tokenHash,
      now,
    )
    .first<{ id: string }>();
  if (locked === null) {
    const existing = await deletionByWorkspace(env.DB, auth.session.workspaceId);
    if (existing !== null) {
      return json(202, { ok: true, status: "deleting" }, [
        clearCookie(SESSION_COOKIE, true),
        clearCookie(CSRF_COOKIE, false),
      ]);
    }
    return json(401, { error: "unauthorized" });
  }

  try {
    // Publish the independent, create-only resurrection fence after the D1
    // session/prelock serialization point and before any credential or tenant
    // purge. A failure leaves a deliberately locked, manual-reconcile state.
    await ensureDeletionLedger(bucket, {
      workspaceId: auth.session.workspaceId,
      userId: auth.session.userId,
      requestedAt: now,
    });
  } catch {
    return json(503, {
      error: "account_deletion_reconciliation_required",
      message: "The workspace is locked; deletion requires storage reconciliation.",
    });
  }
  try {
    // Revoke every credential, install the resurrection guard, and capture
    // only this workspace's exact KV cache keys in one transaction. The
    // beta-capacity singleton is intentionally absent: deleting an account
    // never refunds an issuance.
    await env.DB.batch([
      // Insert the tombstone first. Migration 0018's owner trigger requires
      // the exact prelocked workspace, so a missing/changed lock aborts this
      // transaction before any credential revocation or cache capture.
      env.DB.prepare(`
        /* account-deletion:create-job */
        INSERT INTO workspace_deletions
          (workspace_id, requested_by_user_id, status, requested_at, next_attempt_at)
        VALUES (?1, ?2, 'pending', ?3, ?3)`)
        .bind(auth.session.workspaceId, auth.session.userId, now),
      env.DB.prepare(`
        /* account-deletion:revoke-devices */
        UPDATE devices
        SET revoked_at = ?2
        WHERE workspace_id = ?1 AND revoked_at IS NULL`)
        .bind(auth.session.workspaceId, now),
      env.DB.prepare(`
        /* account-deletion:revoke-sessions */
        UPDATE account_sessions
        SET revoked_at = ?2
        WHERE user_id = ?1 AND revoked_at IS NULL`)
        .bind(auth.session.userId, now),
      env.DB.prepare(`
        /* account-deletion:revoke-api-keys */
        UPDATE api_keys
        SET revoked_at = ?2
        WHERE workspace_id = ?1 AND revoked_at IS NULL`)
        .bind(auth.session.workspaceId, now),
      env.DB.prepare(`
        /* account-deletion:disable-gateway-keys */
        UPDATE gateway_keys
        SET disabled = 1
        WHERE workspace_id = ?1 AND disabled = 0`)
        .bind(auth.session.workspaceId),
      env.DB.prepare(`
        /* account-deletion:capture-apikey-kv */
        INSERT INTO workspace_deletion_kv_keys
          (workspace_id, namespace, cache_key)
        SELECT workspace_id, 'apikey', 'apikey-verdict:' || secret_hash
        FROM api_keys
        WHERE workspace_id = ?1`)
        .bind(auth.session.workspaceId),
      env.DB.prepare(`
        /* account-deletion:capture-gateway-kv */
        INSERT INTO workspace_deletion_kv_keys
          (workspace_id, namespace, cache_key)
        SELECT workspace_id, 'gateway', 'vk:' || token_hash
        FROM gateway_keys
        WHERE workspace_id = ?1`)
        .bind(auth.session.workspaceId),
    ]);
  } catch (error) {
    const existing = await deletionByWorkspace(env.DB, auth.session.workspaceId);
    if (existing === null) {
      if (error instanceof Error && error.message.includes("account has other workspace links")) {
        return json(409, {
          error: "account_has_other_workspace_links",
          message: "This account is still referenced by another workspace. Contact support before deleting it.",
        });
      }
      throw error;
    }
  }

  try {
    // Promptly invalidate the first bounded KV page after the durable D1
    // acceptance commit. Failure is intentionally silent here: the exact key
    // list is durable and the scheduled saga retries before any local purge.
    await deleteWorkspaceKVBatch(env, auth.session.workspaceId, now);
  } catch {
    // The pending job is the source of truth for retry.
  }
  return json(202, {
    ok: true,
    status: "deleting",
    message: "Hosted account deletion was accepted and is being finalized.",
  }, [
    clearCookie(SESSION_COOKIE, true),
    clearCookie(CSRF_COOKIE, false),
  ]);
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
  if (
    (request.method === "GET" || request.method === "POST") &&
    pathname === "/v1/auth/start"
  ) return startAuth(request, env, fetcher);
  if (request.method === "GET" && pathname === "/v1/auth/callback") {
    return finishAuth(request, env, fetcher);
  }
  if (request.method === "GET" && pathname === "/v1/me") return getMe(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/signout") return signOut(request, env);
  if (request.method === "DELETE" && pathname === "/v1/account") {
    return deleteAccount(request, accountDeletionEnv(env));
  }
  if (request.method === "GET" && pathname === "/v1/devices") return listDevices(request, env);
  if (request.method === "POST" && pathname === "/v1/devices") return createDevice(request, env);
  const revoke = /^\/v1\/devices\/(dev_[0-9A-HJKMNP-TV-Z]{26})\/revoke$/.exec(pathname);
  if (request.method === "POST" && revoke !== null) return revokeDevice(request, env, revoke[1]);
  return null;
}
