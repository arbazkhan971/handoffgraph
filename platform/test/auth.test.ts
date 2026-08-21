// Unit tests for src/auth.ts (pure functions + authenticate seam).

import { describe, expect, it } from "vitest";
import {
  authenticate,
  extractBearerToken,
  hasCapability,
  sha256Hex,
  timingSafeEqual,
  type DeviceBinding,
  type DeviceLookup,
} from "../src/auth";

const HEX_64 = "a".repeat(64);
// Valid 26-char ULID bodies (Crockford base32, no I/L/O/U).
const DEV_ULID = `01J${"A".repeat(23)}`;
const WSP_ULID = `01J${"B".repeat(23)}`;

function binding(overrides: Partial<DeviceBinding> = {}): DeviceBinding {
  return {
    deviceId: `dev_${DEV_ULID}`,
    workspaceId: `wsp_${WSP_ULID}`,
    tokenHash: HEX_64,
    capabilities: ["ingest", "read"],
    revokedAt: null,
    ...overrides,
  };
}

describe("extractBearerToken", () => {
  it("returns null for a missing header", () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer dev_tok")).toBe("dev_tok");
  });

  it("accepts the scheme in any case and ignores surrounding spaces", () => {
    expect(extractBearerToken("bearer dev_tok")).toBe("dev_tok");
    expect(extractBearerToken("BEARER dev_tok")).toBe("dev_tok");
    expect(extractBearerToken("Bearer   dev_tok   ")).toBe("dev_tok");
  });

  it("rejects malformed headers", () => {
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("dev_tok")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    // A token containing a space is not a single credential.
    expect(extractBearerToken("Bearer a b")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical fixed-length strings", () => {
    expect(timingSafeEqual(HEX_64, HEX_64)).toBe(true);
  });

  it("returns false when a single character differs", () => {
    const other = `b${HEX_64.slice(1)}`;
    expect(timingSafeEqual(HEX_64, other)).toBe(false);
    expect(timingSafeEqual(other, HEX_64)).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual(HEX_64, HEX_64.slice(1))).toBe(false);
  });

  it("returns false for empty operands", () => {
    expect(timingSafeEqual("", "")).toBe(false);
  });

  it("compares non-ASCII strings correctly", () => {
    expect(timingSafeEqual("héllo", "héllo")).toBe(true);
    expect(timingSafeEqual("héllo", "hélIo")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches known vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic", async () => {
    expect(await sha256Hex("handoffgraph")).toBe(await sha256Hex("handoffgraph"));
  });
});

describe("hasCapability", () => {
  it("reports held and missing capabilities", () => {
    expect(hasCapability(binding(), "ingest")).toBe(true);
    expect(hasCapability(binding(), "admin")).toBe(false);
    expect(hasCapability(binding({ capabilities: [] }), "ingest")).toBe(false);
  });
});

describe("authenticate", () => {
  it("rejects a missing header with a uniform 401", async () => {
    const result = await authenticate(null, { byTokenHash: async () => binding() });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a malformed header with the same 401 body", async () => {
    const result = await authenticate("Token abc", { byTokenHash: async () => binding() });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects an unknown token", async () => {
    const result = await authenticate("Bearer dev_unknown", { byTokenHash: async () => null });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a device whose stored hash does not match the lookup key", async () => {
    // Defensive: guards against a lookup that returns the wrong row.
    const result = await authenticate("Bearer dev_tok", {
      byTokenHash: async () => binding({ tokenHash: "f".repeat(64) }),
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("rejects a revoked device without revealing why", async () => {
    const result = await authenticate("Bearer dev_tok", {
      byTokenHash: async (hash) =>
        binding({
          tokenHash: hash,
          revokedAt: 1_700_000_000,
        }),
    });
    expect(result).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("accepts a valid token and derives the workspace from the binding", async () => {
    const expected = await sha256Hex("dev_tok");
    const seen: string[] = [];
    const lookup: DeviceLookup = {
      byTokenHash: async (hash) => {
        seen.push(hash);
        return binding({
          deviceId: `dev_${DEV_ULID}`,
          workspaceId: `wsp_${WSP_ULID}`,
          tokenHash: expected,
        });
      },
    };
    const result = await authenticate("Bearer dev_tok", lookup);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.device.workspaceId).toBe(`wsp_${WSP_ULID}`);
      expect(result.device.deviceId).toBe(`dev_${DEV_ULID}`);
      expect(result.device.capabilities).toEqual(["ingest", "read"]);
    }
    // The registry is always queried by the token's SHA-256, never the raw token.
    expect(seen).toEqual([expected]);
  });
});
