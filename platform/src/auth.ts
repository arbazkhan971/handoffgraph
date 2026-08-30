// Device-token authentication for the HandoffGraph platform Worker.
//
// Devices authenticate with an opaque bearer token (`dev_<random>`). Only a
// SHA-256 hash of the token is persisted (devices.token_hash); the raw token
// is never stored. The workspace binding is derived exclusively from the
// device row — values in a request body can never influence it.

import type { D1DatabaseLike } from "./db";
import { workspaceDeletionBlocksAuthentication } from "./deletion_ledger";

export interface DeviceBinding {
  /** Device id (`dev_<ulid>`). */
  deviceId: string;
  /** Workspace this device is bound to (`wsp_<ulid>`). Authoritative. */
  workspaceId: string;
  /** Hex SHA-256 of the raw token, as stored in D1. */
  tokenHash: string;
  /** Capabilities granted to this device (e.g. "ingest", "read"). */
  capabilities: string[];
  /** Unix seconds when the device was revoked, or null when active. */
  revokedAt: number | null;
}

/** Persistence seam for device lookup — D1 in production, plain objects in tests. */
export interface DeviceLookup {
  byTokenHash(hash: string): Promise<DeviceBinding | null>;
}

/** One row of the `devices` table, as the lookup query selects it. */
interface DeviceRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  capabilities: string | null;
  revoked_at: number | null;
}

/**
 * The canonical device-lookup query. The `auth:device-by-token` marker is the
 * dispatch key test fakes may match on; the `FROM devices` clause is what the
 * existing fakes across the suite already key on, and both are load-bearing —
 * do not reword either.
 */
const DEVICE_BY_TOKEN_SQL = `
  /* auth:device-by-token */
  SELECT d.id, d.workspace_id, d.token_hash, d.capabilities, d.revoked_at
  FROM devices AS d
  JOIN workspaces AS w
    ON w.id = d.workspace_id AND w.workspace_id = d.workspace_id
  WHERE d.token_hash = ?1
    AND w.status = 'active'`;

/**
 * The one D1-backed DeviceLookup. Every route module that authenticates a
 * device bearer token uses this adapter rather than repeating the query:
 * one place decides how a stored row becomes a DeviceBinding, so the
 * capabilities split and the revoked_at contract cannot drift per module.
 */
export function deviceLookup(
  db: D1DatabaseLike,
  deletionLedgerBinding?: unknown,
  deletionLedgerRequired = false,
): DeviceLookup {
  return {
    async byTokenHash(hash) {
      const record = await db.prepare(DEVICE_BY_TOKEN_SQL).bind(hash).first<DeviceRecord>();
      if (record === null) return null;
      // A deletion prelock makes the workspace non-active before its R2
      // ledger/job exists, so it is already terminal for device auth even if
      // the R2 write subsequently fails. D1 Time Travel can separately
      // restore a pre-deletion device hash; the independent R2 ledger covers
      // that case. Errors from a configured binding deny like an unknown token.
      if (await workspaceDeletionBlocksAuthentication(
        deletionLedgerBinding,
        record.workspace_id,
        deletionLedgerRequired,
      )) return null;
      const binding: DeviceBinding = {
        deviceId: record.id,
        workspaceId: record.workspace_id,
        tokenHash: record.token_hash,
        capabilities:
          record.capabilities === null
            ? []
            : record.capabilities
                .split(",")
                .map((capability) => capability.trim())
                .filter((capability) => capability.length > 0),
        revokedAt: record.revoked_at,
      };
      return binding;
    },
  };
}

export type AuthResult =
  | { ok: true; device: DeviceBinding }
  | { ok: false; status: 401; error: string };

const UNAUTHORIZED: { ok: false; status: 401; error: string } = {
  ok: false,
  status: 401,
  error: "unauthorized",
};

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match === null ? null : match[1];
}

/**
 * Constant-time equality over UTF-8 bytes. Both operands in this codebase are
 * fixed-length hex digests, so the early length check leaks nothing secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length === 0 || left.length !== right.length) return false;

  // Workers exposes a native constant-time primitive on SubtleCrypto. Node's
  // Web Crypto implementation used by the pure unit tests does not yet expose
  // it, so retain the fixed-length XOR loop as a test-runtime fallback.
  const platformCompare = crypto.subtle.timingSafeEqual;
  if (typeof platformCompare === "function") {
    return platformCompare.call(crypto.subtle, left, right);
  }

  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Hex SHA-256 digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** True when the device holds a capability. */
export function hasCapability(device: DeviceBinding, capability: string): boolean {
  return device.capabilities.includes(capability);
}

/**
 * Authenticate a request header against the device registry.
 *
 * Every failure mode returns the same 401 "unauthorized" so callers cannot
 * distinguish unknown tokens from revoked devices by the response body.
 */
export async function authenticate(
  header: string | null,
  lookup: DeviceLookup,
): Promise<AuthResult> {
  const token = extractBearerToken(header);
  if (token === null) return UNAUTHORIZED;
  const hash = await sha256Hex(token);
  const device = await lookup.byTokenHash(hash);
  if (device === null) return UNAUTHORIZED;
  if (!timingSafeEqual(hash, device.tokenHash)) return UNAUTHORIZED;
  if (device.revokedAt !== null) return UNAUTHORIZED;
  return { ok: true, device };
}
