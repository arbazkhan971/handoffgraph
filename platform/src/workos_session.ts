// WorkOS AuthKit access-token verification and provider-session extraction.
//
// The hosted account callback uses this module only long enough to bind the
// WorkOS session (`sid`) to HandoffGraph's opaque browser session. Access and
// refresh tokens must never cross this boundary into D1, cookies, responses,
// or logs.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

const WORKOS_API_ORIGIN = "https://api.workos.com";
const MAX_WORKOS_ACCESS_TOKEN_BYTES = 65_536;
export const MIN_WORKOS_SESSION_ID_BYTES = 9;
export const MAX_WORKOS_SESSION_ID_BYTES = 128;

// WorkOS documents `sid` as a string and currently emits `session_<ULID>`.
// Keep the provider prefix and a conservative URL-safe alphabet without
// freezing an undocumented exact ULID length into the application contract.
const WORKOS_SESSION_ID_PATTERN = /^session_[A-Za-z0-9_-]{1,120}$/;

export interface WorkOSSessionBinding {
  clientId: string;
  userId: string;
  /** Unix seconds used for JWT NumericDate validation. Defaults to now. */
  now?: number;
}

export interface VerifiedWorkOSSession {
  sessionId: string;
  subject: string;
  clientId: string;
  expiresAt: number;
}

/** Injectable key boundary: production uses the client-specific WorkOS JWKS. */
export type WorkOSJWKResolver = JWTVerifyGetKey;

const remoteResolvers = new Map<string, WorkOSJWKResolver>();

export function isValidWorkOSSessionID(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= MIN_WORKOS_SESSION_ID_BYTES &&
    value.length <= MAX_WORKOS_SESSION_ID_BYTES &&
    WORKOS_SESSION_ID_PATTERN.test(value);
}

/** The client-specific AuthKit signing-key endpoint documented by WorkOS. */
export function workosJWKSURL(clientId: string): URL {
  const url = new URL(WORKOS_API_ORIGIN);
  url.pathname = `/sso/jwks/${encodeURIComponent(clientId)}`;
  return url;
}

function remoteResolver(clientId: string): WorkOSJWKResolver {
  let resolver = remoteResolvers.get(clientId);
  if (resolver === undefined) {
    resolver = createRemoteJWKSet(workosJWKSURL(clientId));
    remoteResolvers.set(clientId, resolver);
  }
  return resolver;
}

/**
 * Verify a WorkOS access token and return only the bounded provider-session
 * data needed for logout.
 *
 * Signature, algorithm, subject, expiration, and the application `client_id`
 * are all checked before `sid` is returned. The issuer is intentionally not
 * guessed here: WorkOS's current AuthKit documentation exposes more than one
 * issuer shape, while the client-specific JWKS plus exact `client_id` binding
 * prevents a token issued for another application from being accepted.
 */
export async function verifyWorkOSAccessToken(
  accessToken: string,
  binding: WorkOSSessionBinding,
  resolver: WorkOSJWKResolver = remoteResolver(binding.clientId),
): Promise<VerifiedWorkOSSession | null> {
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_WORKOS_ACCESS_TOKEN_BYTES ||
    typeof binding.clientId !== "string" ||
    binding.clientId.length === 0 ||
    typeof binding.userId !== "string" ||
    binding.userId.length === 0
  ) {
    return null;
  }

  const now = binding.now ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 0) return null;

  try {
    const { payload } = await jwtVerify(accessToken, resolver, {
      algorithms: ["RS256"],
      currentDate: new Date(now * 1_000),
      requiredClaims: ["sub", "client_id", "sid", "exp"],
      subject: binding.userId,
    });
    if (
      payload.client_id !== binding.clientId ||
      payload.sub !== binding.userId ||
      !Number.isSafeInteger(payload.exp) ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      !isValidWorkOSSessionID(payload.sid)
    ) {
      return null;
    }
    return {
      sessionId: payload.sid,
      subject: payload.sub,
      clientId: payload.client_id,
      expiresAt: payload.exp,
    };
  } catch {
    // Authentication failures are intentionally indistinguishable and never
    // include token material in logs or error objects.
    return null;
  }
}
