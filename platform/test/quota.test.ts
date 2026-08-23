import { describe, expect, it } from "vitest";

import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1RunResultLike,
  D1Statement,
} from "../src/db";
import {
  prepareQuotaReservation,
  readIngestPolicy,
  validateBatchAgainstPlan,
  type PrepareQuotaInput,
  type PrepareQuotaReservationResult,
} from "../src/quota";

const NOW = 1_800_000_000;
const PERIOD = 30 * 24 * 60 * 60;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface EntitlementState {
  workspace_id: string;
  plan_id: string;
  status: string;
  max_batch_events: number;
  max_batch_bytes: number;
  max_monthly_events: number;
  max_monthly_bytes: number;
  max_lifetime_events: number;
  max_lifetime_bytes: number;
  used_monthly_events: number;
  used_monthly_bytes: number;
  used_lifetime_events: number;
  used_lifetime_bytes: number;
  period_start: number;
  period_end: number;
}

interface ReservationState {
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  event_count: number;
  body_bytes: number;
  status: "allowed";
  created_at: number;
  decided_at: number;
}

interface StatementMetadata {
  sql: string;
  binds: unknown[];
}

function entitlement(overrides: Partial<EntitlementState> = {}): EntitlementState {
  return {
    workspace_id: "wsp_test",
    plan_id: "basic",
    status: "active",
    max_batch_events: 100,
    max_batch_bytes: 10_000,
    max_monthly_events: 1_000,
    max_monthly_bytes: 100_000,
    max_lifetime_events: 10_000,
    max_lifetime_bytes: 1_000_000,
    used_monthly_events: 0,
    used_monthly_bytes: 0,
    used_lifetime_events: 0,
    used_lifetime_bytes: 0,
    period_start: NOW - 100,
    period_end: NOW + PERIOD,
    ...overrides,
  };
}

function reservationKey(workspaceId: string, idempotencyKey: string): string {
  return `${workspaceId}\u0000${idempotencyKey}`;
}

class FakeQuotaDatabase implements D1DatabaseLike {
  entitlement: EntitlementState | null;
  readonly reservations = new Map<string, ReservationState>();
  batchCalls = 0;

  private readonly metadata = new WeakMap<object, StatementMetadata>();

  constructor(initialEntitlement: EntitlementState | null) {
    this.entitlement = initialEntitlement === null ? null : { ...initialEntitlement };
  }

  prepare(sql: string): D1Statement {
    return {
      bind: (...binds: unknown[]): D1BoundStatement => {
        const bound: D1BoundStatement = {
          first: async <T>(): Promise<T | null> => {
            const value = this.read(sql, binds);
            return value === null ? null : value as T;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async <T>() => ({ success: true, results: [] as T[] }),
        };
        this.metadata.set(bound, { sql, binds });
        return bound;
      },
    };
  }

  async batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]> {
    this.batchCalls += 1;
    let nextEntitlement = this.entitlement === null ? null : { ...this.entitlement };
    const nextReservations = new Map<string, ReservationState>();
    for (const [key, value] of this.reservations) {
      nextReservations.set(key, { ...value });
    }

    const results: D1RunResultLike[] = [];
    for (const statement of statements) {
      const metadata = this.metadata.get(statement);
      if (metadata === undefined || !metadata.sql.includes("quota:insert-reservation")) {
        throw new Error("unexpected statement in quota batch");
      }

      const [workspaceIdValue, idempotencyKeyValue, requestHashValue, eventCountValue, bodyBytesValue, nowValue] = metadata.binds;
      const workspaceId = String(workspaceIdValue);
      const idempotencyKey = String(idempotencyKeyValue);
      const requestHash = String(requestHashValue);
      const eventCount = Number(eventCountValue);
      const bodyBytes = Number(bodyBytesValue);
      const now = Number(nowValue);
      const key = reservationKey(workspaceId, idempotencyKey);

      // INSERT OR IGNORE makes a concurrent replay free. The trigger only runs
      // for the request that actually creates the reservation row.
      if (nextReservations.has(key)) {
        results.push({ success: true, meta: { changes: 0 } });
        continue;
      }

      const current = nextEntitlement;
      if (current === null || current.workspace_id !== workspaceId || current.status !== "active") {
        throw new Error("active entitlement required");
      }

      let periodStart = current.period_start;
      let periodEnd = current.period_end;
      let monthlyEvents = current.used_monthly_events;
      let monthlyBytes = current.used_monthly_bytes;
      if (periodEnd <= now) {
        const duration = periodEnd - periodStart;
        const elapsedPeriods = Math.floor((now - periodStart) / duration);
        periodStart += elapsedPeriods * duration;
        periodEnd = periodStart + duration;
        monthlyEvents = 0;
        monthlyBytes = 0;
      }

      const allowed =
        eventCount <= current.max_batch_events &&
        bodyBytes <= current.max_batch_bytes &&
        monthlyEvents <= current.max_monthly_events - eventCount &&
        monthlyBytes <= current.max_monthly_bytes - bodyBytes &&
        current.used_lifetime_events <= current.max_lifetime_events - eventCount &&
        current.used_lifetime_bytes <= current.max_lifetime_bytes - bodyBytes;
      if (!allowed) throw new Error("quota exceeded");

      nextEntitlement = {
        ...current,
        used_monthly_events: monthlyEvents + eventCount,
        used_monthly_bytes: monthlyBytes + bodyBytes,
        used_lifetime_events: current.used_lifetime_events + eventCount,
        used_lifetime_bytes: current.used_lifetime_bytes + bodyBytes,
        period_start: periodStart,
        period_end: periodEnd,
      };
      nextReservations.set(key, {
        workspace_id: workspaceId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        event_count: eventCount,
        body_bytes: bodyBytes,
        status: "allowed",
        created_at: now,
        decided_at: now,
      });
      results.push({ success: true, meta: { changes: 1 } });
    }

    this.entitlement = nextEntitlement;
    this.reservations.clear();
    for (const [key, value] of nextReservations) this.reservations.set(key, value);
    return results;
  }

  private read(sql: string, binds: unknown[]): object | null {
    if (sql.includes("quota:read-policy")) {
      return this.entitlement?.workspace_id === binds[0] ? { ...this.entitlement } : null;
    }
    if (sql.includes("quota:read-reservation")) {
      const value = this.reservations.get(reservationKey(String(binds[0]), String(binds[1])));
      if (value === undefined) return null;
      return {
        request_hash: value.request_hash,
        event_count: value.event_count,
        body_bytes: value.body_bytes,
        status: value.status,
      };
    }
    throw new Error("unexpected read");
  }
}

function request(overrides: Partial<PrepareQuotaInput> = {}): PrepareQuotaInput {
  return {
    workspaceId: "wsp_test",
    idempotencyKey: "batch-1",
    requestHash: HASH_A,
    eventCount: 5,
    bodyBytes: 500,
    nowSeconds: NOW,
    ...overrides,
  };
}

function statementFrom(result: PrepareQuotaReservationResult): D1BoundStatement {
  if (!result.ok || !result.metered || result.duplicate) {
    throw new Error("expected a new metered reservation statement");
  }
  return result.statement;
}

describe("hosted ingestion quotas", () => {
  it("fails closed when a hosted workspace has no entitlement", async () => {
    const db = new FakeQuotaDatabase(null);
    const policy = await readIngestPolicy(db, "wsp_test", NOW);

    expect(policy.mode).toBe("invalid");
    expect(validateBatchAgainstPlan(policy, { eventCount: 1, bodyBytes: 1 })).toMatchObject({
      ok: false,
      status: 503,
      body: { code: "quota_configuration_error", local_capture_unaffected: true },
    });
    const prepared = await prepareQuotaReservation(db, request());
    expect(prepared).toMatchObject({
      ok: false,
      status: 503,
      body: { code: "quota_configuration_error", local_capture_unaffected: true },
    });
    expect(db.batchCalls).toBe(0);
  });

  it("allows an exact limit and prepares one trigger-backed reservation", async () => {
    const db = new FakeQuotaDatabase(entitlement({
      max_monthly_events: 10,
      max_monthly_bytes: 1_000,
      used_monthly_events: 5,
      used_monthly_bytes: 500,
    }));

    const prepared = await prepareQuotaReservation(db, request());
    await db.batch([statementFrom(prepared)]);

    expect(db.entitlement?.used_monthly_events).toBe(10);
    expect(db.entitlement?.used_monthly_bytes).toBe(1_000);
    expect(db.reservations.get(reservationKey("wsp_test", "batch-1"))?.status).toBe("allowed");
  });

  it("returns structured 429 detail one event over a monthly limit", async () => {
    const db = new FakeQuotaDatabase(entitlement({
      max_monthly_events: 10,
      used_monthly_events: 6,
    }));

    const result = await prepareQuotaReservation(db, request());

    expect(result).toEqual({
      ok: false,
      status: 429,
      body: {
        error: "hosted quota exceeded",
        code: "monthly_events_exceeded",
        local_capture_unaffected: true,
        detail: {
          scope: "month",
          resource: "events",
          limit: 10,
          used: 6,
          requested: 5,
          remaining: 4,
          resets_at: NOW + PERIOD,
        },
      },
    });
    expect(db.entitlement?.used_monthly_events).toBe(6);
    expect(db.reservations.size).toBe(0);
  });

  it("denies an inactive entitlement before preparing a write", async () => {
    const db = new FakeQuotaDatabase(entitlement({ status: "suspended" }));

    const result = await prepareQuotaReservation(db, request());

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      body: { code: "entitlement_inactive" },
    });
    expect(db.batchCalls).toBe(0);
  });

  it("resets an expired fixed-duration period but preserves lifetime usage", async () => {
    const db = new FakeQuotaDatabase(entitlement({
      max_monthly_events: 5,
      max_monthly_bytes: 500,
      used_monthly_events: 5,
      used_monthly_bytes: 500,
      used_lifetime_events: 40,
      used_lifetime_bytes: 4_000,
      period_start: NOW - PERIOD,
      period_end: NOW,
    }));

    const prepared = await prepareQuotaReservation(db, request({ eventCount: 3, bodyBytes: 300 }));
    await db.batch([statementFrom(prepared)]);

    expect(db.entitlement).toMatchObject({
      used_monthly_events: 3,
      used_monthly_bytes: 300,
      used_lifetime_events: 43,
      used_lifetime_bytes: 4_300,
      period_start: NOW,
      period_end: NOW + PERIOD,
    });
  });

  it("enforces the lifetime hard cap after a monthly reset", async () => {
    const db = new FakeQuotaDatabase(entitlement({
      max_lifetime_events: 10,
      used_lifetime_events: 9,
      period_start: NOW - PERIOD,
      period_end: NOW,
    }));

    const result = await prepareQuotaReservation(db, request({ eventCount: 2 }));

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: "lifetime_events_exceeded",
        detail: { scope: "lifetime", limit: 10, used: 9, requested: 2 },
      },
    });
    expect(db.entitlement?.used_lifetime_events).toBe(9);
  });

  it("does not double-charge duplicate statements with the same hash", async () => {
    const db = new FakeQuotaDatabase(entitlement());
    const [first, racedDuplicate] = await Promise.all([
      prepareQuotaReservation(db, request()),
      prepareQuotaReservation(db, request()),
    ]);

    await db.batch([statementFrom(first)]);
    await db.batch([statementFrom(racedDuplicate)]);
    const replay = await prepareQuotaReservation(db, request());

    expect(replay).toEqual({ ok: true, metered: true, duplicate: true });
    expect(db.entitlement?.used_monthly_events).toBe(5);
    expect(db.entitlement?.used_lifetime_events).toBe(5);
    expect(db.reservations.size).toBe(1);
  });

  it("serializes concurrent capacity checks so only one request reaches the cap", async () => {
    const db = new FakeQuotaDatabase(entitlement({
      max_monthly_events: 10,
      used_monthly_events: 4,
    }));
    const [first, second] = await Promise.all([
      prepareQuotaReservation(db, request({ idempotencyKey: "batch-a", eventCount: 6 })),
      prepareQuotaReservation(db, request({ idempotencyKey: "batch-b", requestHash: HASH_B, eventCount: 6 })),
    ]);

    await db.batch([statementFrom(first)]);
    await expect(db.batch([statementFrom(second)])).rejects.toThrow("quota exceeded");

    expect(db.entitlement?.used_monthly_events).toBe(10);
    expect(db.reservations.size).toBe(1);
  });

  it("fails closed if the entitlement disappears before the atomic batch", async () => {
    const db = new FakeQuotaDatabase(entitlement());
    const prepared = await prepareQuotaReservation(db, request());
    db.entitlement = null;

    await expect(db.batch([statementFrom(prepared)])).rejects.toThrow("active entitlement required");
    expect(db.reservations.size).toBe(0);
  });

  it("rejects reuse of an idempotency key with a different request hash", async () => {
    const db = new FakeQuotaDatabase(entitlement());
    const first = await prepareQuotaReservation(db, request());
    await db.batch([statementFrom(first)]);
    const countersAfterFirst = {
      monthly: db.entitlement?.used_monthly_events,
      lifetime: db.entitlement?.used_lifetime_events,
    };

    const conflict = await prepareQuotaReservation(db, request({ requestHash: HASH_B }));

    expect(conflict).toMatchObject({
      ok: false,
      status: 409,
      body: { code: "idempotency_conflict" },
    });
    expect(db.entitlement?.used_monthly_events).toBe(countersAfterFirst.monthly);
    expect(db.entitlement?.used_lifetime_events).toBe(countersAfterFirst.lifetime);
  });

  it("requires the canonical lowercase SHA-256 request hash", async () => {
    const db = new FakeQuotaDatabase(entitlement());

    for (const requestHash of ["sha256:request-a", "A".repeat(64), "a".repeat(63)]) {
      const result = await prepareQuotaReservation(db, request({ requestHash }));
      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { code: "invalid_quota_request" },
      });
    }
    expect(db.batchCalls).toBe(0);
  });
});
