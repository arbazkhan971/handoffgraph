// Durable account-deletion resurrection fence.
//
// D1 Time Travel can restore credential rows from before an account deletion.
// The deletion ledger therefore lives in the independently restored BODIES R2
// bucket. Authentication treats the presence of a workspace ledger object --
// and any R2 read failure while the binding is present -- as a terminal deny.
// Ledger keys are deliberately outside every tenant-data purge prefix.

export const DELETION_LEDGER_SCHEMA = "hfg.account-deletion-ledger.v1";
export const DELETION_LEDGER_PREFIX = "_hfg/account-deletion-ledger/v1/";

const MAX_LEDGER_BYTES = 2_048;
const WORKSPACE_ID = /^wsp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const USER_ID = /^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface DeletionLedgerHeadObjectLike {
  readonly key: string;
}

export interface DeletionLedgerBodyLike extends DeletionLedgerHeadObjectLike {
  readonly size: number;
  text(): Promise<string>;
}

export interface DeletionLedgerReaderLike {
  head(key: string): Promise<DeletionLedgerHeadObjectLike | null>;
  get(key: string): Promise<DeletionLedgerBodyLike | null>;
}

export interface DeletionLedgerPutOptionsLike {
  onlyIf?: Headers;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface DeletionLedgerBucketLike extends DeletionLedgerReaderLike {
  put(
    key: string,
    value: string,
    options?: DeletionLedgerPutOptionsLike,
  ): Promise<DeletionLedgerHeadObjectLike | null>;
}

export interface DeletionLedgerRecord {
  schema_version: typeof DELETION_LEDGER_SCHEMA;
  workspace_id: string;
  requested_by_user_hash: string;
  requested_at: number;
}

function validWorkspaceID(workspaceId: string): boolean {
  return WORKSPACE_ID.test(workspaceId);
}

function validUserID(userId: string): boolean {
  return USER_ID.test(userId);
}

async function ownerHash(userId: string): Promise<string> {
  if (!validUserID(userId)) throw new Error("invalid deletion-ledger user id");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hfg.deletion-owner.v1\0${userId}`),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function deletionLedgerKey(workspaceId: string): string {
  if (!validWorkspaceID(workspaceId)) throw new Error("invalid deletion-ledger workspace id");
  return `${DELETION_LEDGER_PREFIX}${workspaceId}.json`;
}

/** Read the BODIES candidate without making every structural route env claim R2. */
export function deletionLedgerBinding(env: object): unknown {
  return "BODIES" in env ? env.BODIES : undefined;
}

/**
 * Hosted Basic cannot safely authenticate without its independent R2 control
 * plane. Keep the requirement explicit instead of relying on wrangler.toml.
 * Every Worker surface, including advanced, still exposes the account and
 * device routes whose deletion decisions live in this ledger. Pure DB-only
 * callers retain the optional binding seam by passing `required = false` to
 * the authentication fence directly.
 */
export function deletionLedgerRequired(_env: object): boolean {
  return true;
}

function isHeadReader(value: unknown): value is Pick<DeletionLedgerReaderLike, "head"> {
  return typeof value === "object" && value !== null &&
    "head" in value && typeof value.head === "function";
}

/**
 * Authentication fence. A missing binding is tolerated for pure/local tests;
 * a configured binding that is malformed, unavailable, or contains a ledger
 * always denies. Every deployed Worker surface declares BODIES.
 */
export async function workspaceDeletionBlocksAuthentication(
  binding: unknown,
  workspaceId: string,
  required = false,
): Promise<boolean> {
  if (binding === undefined) return required;
  if (!validWorkspaceID(workspaceId) || !isHeadReader(binding)) return true;
  try {
    return (await binding.head(deletionLedgerKey(workspaceId))) !== null;
  } catch {
    return true;
  }
}

function parseLedger(value: unknown): DeletionLedgerRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== [
    "requested_at",
    "requested_by_user_hash",
    "schema_version",
    "workspace_id",
  ].join("\n")) return null;
  if (record.schema_version !== DELETION_LEDGER_SCHEMA) return null;
  if (typeof record.workspace_id !== "string" || !validWorkspaceID(record.workspace_id)) {
    return null;
  }
  if (
    typeof record.requested_by_user_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.requested_by_user_hash)
  ) return null;
  if (
    typeof record.requested_at !== "number" ||
    !Number.isSafeInteger(record.requested_at) ||
    record.requested_at < 0
  ) return null;
  return {
    schema_version: DELETION_LEDGER_SCHEMA,
    workspace_id: record.workspace_id,
    requested_by_user_hash: record.requested_by_user_hash,
    requested_at: record.requested_at,
  };
}

export async function readDeletionLedger(
  bucket: DeletionLedgerReaderLike,
  workspaceId: string,
): Promise<DeletionLedgerRecord | null> {
  const object = await bucket.get(deletionLedgerKey(workspaceId));
  if (object === null) return null;
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_LEDGER_BYTES) {
    throw new Error("invalid deletion ledger size");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await object.text());
  } catch {
    throw new Error("invalid deletion ledger JSON");
  }
  const record = parseLedger(decoded);
  if (record === null || record.workspace_id !== workspaceId) {
    throw new Error("invalid deletion ledger record");
  }
  return record;
}

/**
 * Create one immutable ledger record. If another invocation won the
 * If-None-Match race, accept only the exact same owner/workspace record.
 * Existing records are never overwritten or deleted.
 */
export async function ensureDeletionLedger(
  bucket: DeletionLedgerBucketLike,
  input: { workspaceId: string; userId: string; requestedAt: number },
): Promise<DeletionLedgerRecord> {
  if (!validWorkspaceID(input.workspaceId) || !validUserID(input.userId)) {
    throw new Error("invalid deletion ledger identity");
  }
  if (!Number.isSafeInteger(input.requestedAt) || input.requestedAt < 0) {
    throw new Error("invalid deletion ledger timestamp");
  }
  const expectedOwnerHash = await ownerHash(input.userId);
  const verifyOwner = (record: DeletionLedgerRecord): DeletionLedgerRecord => {
    if (
      record.workspace_id !== input.workspaceId ||
      record.requested_by_user_hash !== expectedOwnerHash
    ) throw new Error("deletion ledger identity conflict");
    return record;
  };

  const existing = await readDeletionLedger(bucket, input.workspaceId);
  if (existing !== null) return verifyOwner(existing);

  const record: DeletionLedgerRecord = {
    schema_version: DELETION_LEDGER_SCHEMA,
    workspace_id: input.workspaceId,
    requested_by_user_hash: expectedOwnerHash,
    requested_at: input.requestedAt,
  };
  const condition = new Headers({ "if-none-match": "*" });
  await bucket.put(
    deletionLedgerKey(input.workspaceId),
    JSON.stringify(record),
    {
      onlyIf: condition,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { schema: DELETION_LEDGER_SCHEMA },
    },
  );

  // R2 writes are strongly consistent. Re-read even when the conditional put
  // returned an object: this both proves durability and handles a concurrent
  // writer that won the create-only condition.
  const stored = await readDeletionLedger(bucket, input.workspaceId);
  if (stored === null) throw new Error("deletion ledger was not durably stored");
  return verifyOwner(stored);
}

export async function deletionLedgerMatchesOwner(
  record: DeletionLedgerRecord,
  userId: string,
): Promise<boolean> {
  try {
    return record.requested_by_user_hash === await ownerHash(userId);
  } catch {
    return false;
  }
}
