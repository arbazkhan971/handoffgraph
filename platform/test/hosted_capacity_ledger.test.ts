import { describe, expect, it } from "vitest";

import {
  HOSTED_BETA_MAX_ACCOUNTS,
  HOSTED_CAPACITY_KEY,
  HostedBetaCapacityExhaustedError,
  auditHostedBetaCapacityCoverage,
  reserveHostedBetaIssuance,
  verifyHostedBetaIssuanceMembership,
} from "../src/hosted_capacity_ledger";

class CasR2 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  gets = 0;
  puts = 0;
  getFailure = false;
  putFailure = false;
  private version = 0;

  async get(key: string) {
    this.gets += 1;
    if (this.getFailure) throw new Error("R2 read failed");
    const object = this.objects.get(key);
    if (object === undefined) return null;
    // Return an immutable point-in-time snapshot. A later writer may replace
    // the map entry while this caller still holds the old ETag/body.
    const snapshot = { ...object };
    return {
      key,
      etag: snapshot.etag,
      size: new TextEncoder().encode(snapshot.body).byteLength,
      text: async () => snapshot.body,
    };
  }

  async put(
    key: string,
    body: string,
    options?: { onlyIf?: Headers | { etagMatches?: string } },
  ) {
    if (this.putFailure) throw new Error("R2 write failed");
    // Let concurrent reservers all reach the conditional write. The check and
    // replacement below remain one synchronous operation, matching R2 CAS.
    await Promise.resolve();
    const current = this.objects.get(key);
    if (options?.onlyIf instanceof Headers) {
      if (options.onlyIf.get("if-none-match") === "*" && current !== undefined) return null;
    } else if (
      options?.onlyIf?.etagMatches !== undefined &&
      current?.etag !== options.onlyIf.etagMatches
    ) return null;
    this.version += 1;
    this.puts += 1;
    const etag = `etag-${this.version}`;
    this.objects.set(key, { body, etag });
    return { key, etag };
  }

  hashes(): string[] {
    const object = this.objects.get(HOSTED_CAPACITY_KEY);
    if (object === undefined) return [];
    return (JSON.parse(object.body) as { subject_hashes: string[] }).subject_hashes;
  }
}

describe("Hosted Basic R2 lifetime capacity ledger", () => {
  it("is idempotent for concurrent callbacks of the same WorkOS subject", async () => {
    const bucket = new CasR2();
    const results = await Promise.all([
      reserveHostedBetaIssuance(bucket, "workos-user-same"),
      reserveHostedBetaIssuance(bucket, "workos-user-same"),
      reserveHostedBetaIssuance(bucket, "workos-user-same"),
    ]);

    expect(bucket.hashes()).toHaveLength(1);
    expect(bucket.puts).toBe(1);
    expect(results.filter((result) => result.alreadyReserved)).toHaveLength(2);
    expect(bucket.objects.get(HOSTED_CAPACITY_KEY)?.body).not.toContain("workos-user-same");
  });

  it("uses conditional ETag retries without losing concurrent distinct allocations", async () => {
    const bucket = new CasR2();
    const [first, second] = await Promise.all([
      reserveHostedBetaIssuance(bucket, "workos-user-one"),
      reserveHostedBetaIssuance(bucket, "workos-user-two"),
    ]);

    expect(first.limit).toBe(HOSTED_BETA_MAX_ACCOUNTS);
    expect(second.limit).toBe(HOSTED_BETA_MAX_ACCOUNTS);
    expect(bucket.hashes()).toHaveLength(2);
    expect(new Set(bucket.hashes()).size).toBe(2);
    expect(bucket.puts).toBe(2);
  });

  it("remains full after a hypothetical D1 counter restore", async () => {
    const bucket = new CasR2();
    for (let index = 0; index < HOSTED_BETA_MAX_ACCOUNTS; index += 1) {
      await reserveHostedBetaIssuance(bucket, `workos-issued-${index}`);
    }

    // No D1 state participates in this decision. Restoring active_accounts to
    // an older value cannot refund any of these external lifetime issuances.
    await expect(reserveHostedBetaIssuance(bucket, "workos-issued-after-restore"))
      .rejects.toBeInstanceOf(HostedBetaCapacityExhaustedError);
    expect(bucket.hashes()).toHaveLength(HOSTED_BETA_MAX_ACCOUNTS);
  });

  it("fails closed on an absent/malformed binding and on R2 errors", async () => {
    await expect(reserveHostedBetaIssuance(undefined, "workos-user"))
      .rejects.toThrow(/binding unavailable/);
    await expect(reserveHostedBetaIssuance({}, "workos-user"))
      .rejects.toThrow(/binding unavailable/);

    const readFailure = new CasR2();
    readFailure.getFailure = true;
    await expect(reserveHostedBetaIssuance(readFailure, "workos-user"))
      .rejects.toThrow(/R2 read failed/);

    const writeFailure = new CasR2();
    writeFailure.putFailure = true;
    await expect(reserveHostedBetaIssuance(writeFailure, "workos-user"))
      .rejects.toThrow(/R2 write failed/);
  });

  it("accepts a lower restored D1 count covered by R2 including an orphan burn", async () => {
    const bucket = new CasR2();
    await reserveHostedBetaIssuance(bucket, "workos-current");
    await reserveHostedBetaIssuance(bucket, "workos-orphaned-before-d1");
    const putsBeforeAudit = bucket.puts;
    const hashesBeforeAudit = [...bucket.hashes()];

    const coverage = await auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: 1,
      currentProviderSubjects: ["workos-current"],
    });

    expect(coverage).toEqual({
      bootstrapAllowed: false,
      d1ActiveAccounts: 1,
      currentProviderSubjects: 1,
      reservedSubjects: 2,
      limit: HOSTED_BETA_MAX_ACCOUNTS,
    });
    expect(bucket.puts).toBe(putsBeforeAudit);
    expect(bucket.hashes()).toEqual(hashesBeforeAudit);
  });

  it("rejects an R2 ledger smaller than the restored D1 lifetime count", async () => {
    const bucket = new CasR2();
    await reserveHostedBetaIssuance(bucket, "workos-current");

    await expect(auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: 2,
      currentProviderSubjects: ["workos-current"],
    })).rejects.toThrow(/does not cover D1 lifetime count/);
  });

  it("rejects an oversized current-subject inventory before reading R2", async () => {
    const bucket = new CasR2();
    const subjects = Array.from(
      { length: HOSTED_BETA_MAX_ACCOUNTS + 1 },
      (_, index) => `workos-current-${index}`,
    );

    await expect(auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: HOSTED_BETA_MAX_ACCOUNTS,
      currentProviderSubjects: subjects,
    })).rejects.toThrow(/inventory exceeds hosted capacity/);
    expect(bucket.gets).toBe(0);
    expect(bucket.puts).toBe(0);
  });

  it("rejects a missing current subject even when R2 count exceeds D1", async () => {
    const bucket = new CasR2();
    await reserveHostedBetaIssuance(bucket, "workos-other");
    await reserveHostedBetaIssuance(bucket, "workos-orphan");

    await expect(auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: 1,
      currentProviderSubjects: ["workos-current-missing"],
    })).rejects.toThrow(/current WorkOS identity is missing/);
  });

  it("checks existing-account membership without putting or changing count", async () => {
    const bucket = new CasR2();
    await reserveHostedBetaIssuance(bucket, "workos-existing");
    const putsBeforeCheck = bucket.puts;
    const hashesBeforeCheck = [...bucket.hashes()];

    await expect(verifyHostedBetaIssuanceMembership(bucket, "workos-existing"))
      .resolves.toEqual({ used: 1, limit: HOSTED_BETA_MAX_ACCOUNTS });
    await expect(verifyHostedBetaIssuanceMembership(bucket, "workos-not-issued"))
      .rejects.toThrow(/subject is missing/);
    expect(bucket.puts).toBe(putsBeforeCheck);
    expect(bucket.hashes()).toEqual(hashesBeforeCheck);
  });

  it("allows only a truly empty D1 and missing ledger to bootstrap", async () => {
    const bucket = new CasR2();
    await expect(auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: 0,
      currentProviderSubjects: [],
    })).resolves.toEqual({
      bootstrapAllowed: true,
      d1ActiveAccounts: 0,
      currentProviderSubjects: 0,
      reservedSubjects: 0,
      limit: HOSTED_BETA_MAX_ACCOUNTS,
    });
    expect(bucket.puts).toBe(0);

    await expect(auditHostedBetaCapacityCoverage(bucket, {
      d1ActiveAccounts: 1,
      currentProviderSubjects: [],
    })).rejects.toThrow(/missing for non-empty D1/);
    await expect(verifyHostedBetaIssuanceMembership(bucket, "workos-existing"))
      .rejects.toThrow(/ledger is missing/);
    expect(bucket.puts).toBe(0);
  });

  it("fails coverage and membership closed on malformed state or R2 errors", async () => {
    await expect(auditHostedBetaCapacityCoverage(undefined, {
      d1ActiveAccounts: 0,
      currentProviderSubjects: [],
    })).rejects.toThrow(/binding unavailable/);
    await expect(verifyHostedBetaIssuanceMembership(undefined, "workos-existing"))
      .rejects.toThrow(/binding unavailable/);

    const malformed = new CasR2();
    malformed.objects.set(HOSTED_CAPACITY_KEY, {
      body: JSON.stringify({ schema_version: "wrong", subject_hashes: [] }),
      etag: "etag-malformed",
    });
    await expect(auditHostedBetaCapacityCoverage(malformed, {
      d1ActiveAccounts: 0,
      currentProviderSubjects: [],
    })).rejects.toThrow(/invalid hosted capacity ledger record/);
    await expect(verifyHostedBetaIssuanceMembership(malformed, "workos-existing"))
      .rejects.toThrow(/invalid hosted capacity ledger record/);

    const unavailable = new CasR2();
    unavailable.getFailure = true;
    await expect(auditHostedBetaCapacityCoverage(unavailable, {
      d1ActiveAccounts: 0,
      currentProviderSubjects: [],
    })).rejects.toThrow(/R2 read failed/);
    await expect(verifyHostedBetaIssuanceMembership(unavailable, "workos-existing"))
      .rejects.toThrow(/R2 read failed/);
  });
});
