// Monotone Hosted Basic lifetime-allocation ledger.
//
// D1 Time Travel can move hosted_beta_capacity.active_accounts backwards.
// This independently restored, bounded R2 object is therefore the terminal
// lifetime issuance counter. It stores only domain-separated SHA-256 hashes
// of immutable WorkOS subjects -- never email addresses, tokens, or raw ids.

export const HOSTED_CAPACITY_SCHEMA = "hfg.hosted-beta-capacity.v1";
export const HOSTED_CAPACITY_KEY = "_hfg/hosted-beta-capacity/v1/allocations.json";
export const HOSTED_BETA_MAX_ACCOUNTS = 50;

const MAX_CONTROL_BYTES = 8_192;
const MAX_CAS_ATTEMPTS = 16;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface CapacityObjectBodyLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  text(): Promise<string>;
}

interface CapacityPutOptionsLike {
  onlyIf?: Headers | { etagMatches?: string };
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface CapacityReaderLike {
  get(key: string): Promise<CapacityObjectBodyLike | null>;
}

interface CapacityBucketLike extends CapacityReaderLike {
  put(
    key: string,
    value: string,
    options?: CapacityPutOptionsLike,
  ): Promise<{ readonly key: string } | null>;
}

interface CapacityLedger {
  schema_version: typeof HOSTED_CAPACITY_SCHEMA;
  max_accounts: typeof HOSTED_BETA_MAX_ACCOUNTS;
  subject_hashes: string[];
}

export class HostedBetaCapacityExhaustedError extends Error {
  constructor() {
    super("hosted beta lifetime capacity exhausted");
    this.name = "HostedBetaCapacityExhaustedError";
  }
}

function isCapacityBucket(value: unknown): value is CapacityBucketLike {
  return isCapacityReader(value) &&
    "put" in value && typeof value.put === "function";
}

function isCapacityReader(value: unknown): value is CapacityReaderLike {
  return typeof value === "object" && value !== null &&
    "get" in value && typeof value.get === "function";
}

async function subjectHash(providerSubject: string): Promise<string> {
  if (
    typeof providerSubject !== "string" ||
    providerSubject.length < 1 ||
    providerSubject.length > 1_024
  ) {
    throw new Error("invalid WorkOS subject for capacity ledger");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hfg.workos-subject.v1\0${providerSubject}`),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function parseLedger(value: unknown): CapacityLedger | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\n") !== [
    "max_accounts",
    "schema_version",
    "subject_hashes",
  ].join("\n")) return null;
  if (record.schema_version !== HOSTED_CAPACITY_SCHEMA) return null;
  if (record.max_accounts !== HOSTED_BETA_MAX_ACCOUNTS) return null;
  if (!Array.isArray(record.subject_hashes)) return null;
  if (record.subject_hashes.length > HOSTED_BETA_MAX_ACCOUNTS) return null;
  const hashes = record.subject_hashes;
  if (!hashes.every((hash) => typeof hash === "string" && SHA256_HEX.test(hash))) {
    return null;
  }
  const sorted = [...hashes].sort();
  if (new Set(sorted).size !== sorted.length) return null;
  if (sorted.some((hash, index) => hash !== hashes[index])) return null;
  return {
    schema_version: HOSTED_CAPACITY_SCHEMA,
    max_accounts: HOSTED_BETA_MAX_ACCOUNTS,
    subject_hashes: sorted,
  };
}

async function readCapacityLedger(
  bucket: CapacityReaderLike,
): Promise<{ ledger: CapacityLedger; etag: string } | null> {
  const object = await bucket.get(HOSTED_CAPACITY_KEY);
  if (object === null) return null;
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > MAX_CONTROL_BYTES ||
    typeof object.etag !== "string" ||
    object.etag === ""
  ) throw new Error("invalid hosted capacity ledger object");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await object.text());
  } catch {
    throw new Error("invalid hosted capacity ledger JSON");
  }
  const ledger = parseLedger(decoded);
  if (ledger === null) throw new Error("invalid hosted capacity ledger record");
  return { ledger, etag: object.etag };
}

function body(subjectHashes: string[]): string {
  return JSON.stringify({
    schema_version: HOSTED_CAPACITY_SCHEMA,
    max_accounts: HOSTED_BETA_MAX_ACCOUNTS,
    subject_hashes: subjectHashes,
  } satisfies CapacityLedger);
}

export interface HostedBetaCapacityCoverageInput {
  /** Current D1 hosted_beta_capacity.active_accounts lifetime counter. */
  d1ActiveAccounts: number;
  /** Immutable WorkOS subjects currently referenced by D1 provider identities. */
  currentProviderSubjects: readonly string[];
}

export interface HostedBetaCapacityCoverage {
  /** True only for a genuinely empty D1 and an absent R2 object. */
  bootstrapAllowed: boolean;
  d1ActiveAccounts: number;
  currentProviderSubjects: number;
  reservedSubjects: number;
  limit: typeof HOSTED_BETA_MAX_ACCOUNTS;
}

/**
 * Read-only restore/startup coverage audit.
 *
 * R2 is authoritative for the lifetime cap, but its count can legitimately
 * exceed D1 because an issuance is burned before account creation. Never copy
 * that larger count into D1: a same-subject retry may still need D1's normal
 * provisioning trigger. Instead prove that R2 covers the restored D1 lifetime
 * count and every provider identity that currently exists in D1. Extra R2
 * hashes are valid permanent/orphaned reservations.
 */
export async function auditHostedBetaCapacityCoverage(
  binding: unknown,
  input: HostedBetaCapacityCoverageInput,
): Promise<HostedBetaCapacityCoverage> {
  if (!isCapacityReader(binding)) {
    throw new Error("hosted capacity ledger binding unavailable");
  }
  if (
    !Number.isSafeInteger(input.d1ActiveAccounts) ||
    input.d1ActiveAccounts < 0 ||
    input.d1ActiveAccounts > HOSTED_BETA_MAX_ACCOUNTS
  ) throw new Error("invalid D1 hosted capacity count");
  if (!Array.isArray(input.currentProviderSubjects)) {
    throw new Error("invalid current WorkOS subject inventory");
  }
  if (input.currentProviderSubjects.length > HOSTED_BETA_MAX_ACCOUNTS) {
    throw new Error("current WorkOS subject inventory exceeds hosted capacity");
  }

  const currentHashes = await Promise.all(
    input.currentProviderSubjects.map((subject) => subjectHash(subject)),
  );
  if (new Set(currentHashes).size !== currentHashes.length) {
    throw new Error("duplicate current WorkOS subject inventory");
  }
  if (currentHashes.length > input.d1ActiveAccounts) {
    throw new Error("D1 hosted capacity count does not cover current identities");
  }

  const current = await readCapacityLedger(binding);
  if (current === null) {
    if (input.d1ActiveAccounts === 0 && currentHashes.length === 0) {
      return {
        bootstrapAllowed: true,
        d1ActiveAccounts: 0,
        currentProviderSubjects: 0,
        reservedSubjects: 0,
        limit: HOSTED_BETA_MAX_ACCOUNTS,
      };
    }
    throw new Error("hosted capacity ledger is missing for non-empty D1");
  }
  if (current.ledger.subject_hashes.length < input.d1ActiveAccounts) {
    throw new Error("hosted capacity ledger does not cover D1 lifetime count");
  }
  if (currentHashes.some((hash) => !current.ledger.subject_hashes.includes(hash))) {
    throw new Error("current WorkOS identity is missing from hosted capacity ledger");
  }
  return {
    bootstrapAllowed: false,
    d1ActiveAccounts: input.d1ActiveAccounts,
    currentProviderSubjects: currentHashes.length,
    reservedSubjects: current.ledger.subject_hashes.length,
    limit: HOSTED_BETA_MAX_ACCOUNTS,
  };
}

/**
 * Read-only existing-account sign-in fence. It never creates or updates the
 * capacity object: an absent/malformed ledger, read error, or subject without
 * an exact domain-separated hash is a terminal failure for hosted sign-in.
 */
export async function verifyHostedBetaIssuanceMembership(
  binding: unknown,
  providerSubject: string,
): Promise<{ used: number; limit: typeof HOSTED_BETA_MAX_ACCOUNTS }> {
  if (!isCapacityReader(binding)) {
    throw new Error("hosted capacity ledger binding unavailable");
  }
  const hash = await subjectHash(providerSubject);
  const current = await readCapacityLedger(binding);
  if (current === null) throw new Error("hosted capacity ledger is missing");
  if (!current.ledger.subject_hashes.includes(hash)) {
    throw new Error("WorkOS subject is missing from hosted capacity ledger");
  }
  return {
    used: current.ledger.subject_hashes.length,
    limit: HOSTED_BETA_MAX_ACCOUNTS,
  };
}

/**
 * Burn one lifetime Hosted Basic issuance before attempting the D1 account
 * transaction. A D1 failure intentionally does not roll this reservation
 * back. Same-subject callback retries are idempotent; different subjects use
 * conditional ETag writes and retry a bounded number of CAS conflicts.
 */
export async function reserveHostedBetaIssuance(
  binding: unknown,
  providerSubject: string,
): Promise<{ alreadyReserved: boolean; used: number; limit: number }> {
  if (!isCapacityBucket(binding)) {
    throw new Error("hosted capacity ledger binding unavailable");
  }
  const hash = await subjectHash(providerSubject);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await readCapacityLedger(binding);
    if (current !== null && current.ledger.subject_hashes.includes(hash)) {
      return {
        alreadyReserved: true,
        used: current.ledger.subject_hashes.length,
        limit: HOSTED_BETA_MAX_ACCOUNTS,
      };
    }
    const hashes = current === null
      ? [hash]
      : [...current.ledger.subject_hashes, hash].sort();
    if (hashes.length > HOSTED_BETA_MAX_ACCOUNTS) {
      throw new HostedBetaCapacityExhaustedError();
    }
    const onlyIf = current === null
      ? new Headers({ "if-none-match": "*" })
      : { etagMatches: current.etag };
    const stored = await binding.put(
      HOSTED_CAPACITY_KEY,
      body(hashes),
      {
        onlyIf,
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { schema: HOSTED_CAPACITY_SCHEMA },
      },
    );
    if (stored !== null) {
      // R2 promises strong consistency after a successful put. Re-read the
      // control object anyway so D1 provisioning never begins on a malformed
      // fake/binding response or on a write that cannot be observed.
      const durable = await readCapacityLedger(binding);
      if (durable === null || !durable.ledger.subject_hashes.includes(hash)) {
        throw new Error("hosted capacity issuance was not durably stored");
      }
      return {
        alreadyReserved: false,
        used: durable.ledger.subject_hashes.length,
        limit: HOSTED_BETA_MAX_ACCOUNTS,
      };
    }
    // A concurrent conditional write won. Re-read its ETag/body and retry;
    // never fall back to an unconditional overwrite.
  }
  throw new Error("hosted capacity ledger contention");
}
