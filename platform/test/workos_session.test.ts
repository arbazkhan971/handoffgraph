import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_WORKOS_SESSION_ID_BYTES,
  MIN_WORKOS_SESSION_ID_BYTES,
  isValidWorkOSSessionID,
  verifyWorkOSAccessToken,
  workosJWKSURL,
  type WorkOSJWKResolver,
} from "../src/workos_session";

const CLIENT_ID = "client_01K4HANDOFFGRAPH";
const USER_ID = "user_01K4VERIFIEDSUBJECT";
const NOW = 1_800_000_000;
const SESSION_ID = "session_01HQSXZGF8FHF7A9ZZFCW4387R";

let privateKey: CryptoKey;
let resolver: WorkOSJWKResolver;
let wrongResolver: WorkOSJWKResolver;

async function signingFixture(kid: string): Promise<{
  privateKey: CryptoKey;
  jwk: JWK;
}> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.alg = "RS256";
  jwk.kid = kid;
  jwk.use = "sig";
  return { privateKey: pair.privateKey, jwk };
}

async function token(
  claims: Record<string, unknown> = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT({
    sub: USER_ID,
    client_id: CLIENT_ID,
    sid: SESSION_ID,
    iat: NOW - 30,
    exp: NOW + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: key === privateKey ? "workos-test" : "wrong-key" })
    .sign(key);
}

beforeAll(async () => {
  const primary = await signingFixture("workos-test");
  const wrong = await signingFixture("wrong-key");
  privateKey = primary.privateKey;
  resolver = createLocalJWKSet({ keys: [primary.jwk] });
  wrongResolver = createLocalJWKSet({ keys: [wrong.jwk] });
});

describe("WorkOS AuthKit session verification", () => {
  it("uses the client-specific WorkOS JWKS URL", () => {
    expect(workosJWKSURL(CLIENT_ID).toString()).toBe(
      `https://api.workos.com/sso/jwks/${CLIENT_ID}`,
    );
    expect(workosJWKSURL("client_with/slash").toString()).toBe(
      "https://api.workos.com/sso/jwks/client_with%2Fslash",
    );
  });

  it("verifies RS256, expiration, subject, client, and returns only the SID binding", async () => {
    const accessToken = await token();
    await expect(verifyWorkOSAccessToken(accessToken, {
      clientId: CLIENT_ID,
      userId: USER_ID,
      now: NOW,
    }, resolver)).resolves.toEqual({
      sessionId: SESSION_ID,
      subject: USER_ID,
      clientId: CLIENT_ID,
      expiresAt: NOW + 300,
    });
  });

  it("rejects a token whose signature is not in the client-specific JWKS", async () => {
    const accessToken = await token();
    await expect(verifyWorkOSAccessToken(accessToken, {
      clientId: CLIENT_ID,
      userId: USER_ID,
      now: NOW,
    }, wrongResolver)).resolves.toBeNull();
  });

  it.each([
    ["expired", { exp: NOW }],
    ["wrong subject", { sub: "user_attacker" }],
    ["wrong client", { client_id: "client_other" }],
    ["missing subject", { sub: undefined }],
    ["missing client", { client_id: undefined }],
    ["missing sid", { sid: undefined }],
    ["missing expiry", { exp: undefined }],
    ["bad sid prefix", { sid: "other_01HQSXZGF8FHF7A9ZZFCW4387R" }],
    ["bad sid alphabet", { sid: "session_bad/value" }],
    ["oversized sid", { sid: `session_${"A".repeat(121)}` }],
  ])("rejects %s claims", async (_name, claims) => {
    await expect(verifyWorkOSAccessToken(await token(claims), {
      clientId: CLIENT_ID,
      userId: USER_ID,
      now: NOW,
    }, resolver)).resolves.toBeNull();
  });

  it("bounds the documented session_ identifier without freezing its ULID length", () => {
    const minimum = "session_a";
    const maximum = `session_${"Z".repeat(120)}`;
    expect(minimum).toHaveLength(MIN_WORKOS_SESSION_ID_BYTES);
    expect(maximum).toHaveLength(MAX_WORKOS_SESSION_ID_BYTES);
    expect(isValidWorkOSSessionID(minimum)).toBe(true);
    expect(isValidWorkOSSessionID(maximum)).toBe(true);
    for (const invalid of [
      "session_",
      `session_${"Z".repeat(121)}`,
      "session_bad value",
      "session_\u0000",
      "session_é",
      null,
    ]) {
      expect(isValidWorkOSSessionID(invalid)).toBe(false);
    }
  });

  it("fails closed without logging or reflecting access-token material", async () => {
    const accessToken = await token();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingResolver: WorkOSJWKResolver = async () => {
      throw new Error(`JWKS unavailable for ${accessToken}`);
    };
    await expect(verifyWorkOSAccessToken(accessToken, {
      clientId: CLIENT_ID,
      userId: USER_ID,
      now: NOW,
    }, failingResolver)).resolves.toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("rejects an oversized token before consulting JWKS", async () => {
    const key = vi.fn<WorkOSJWKResolver>();
    await expect(verifyWorkOSAccessToken("x".repeat(65_537), {
      clientId: CLIENT_ID,
      userId: USER_ID,
      now: NOW,
    }, key)).resolves.toBeNull();
    expect(key).not.toHaveBeenCalled();
  });
});
