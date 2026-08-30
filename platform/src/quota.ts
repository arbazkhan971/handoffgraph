// Server-authoritative hosted ingestion quotas.
//
// The migration's quota_reservations INSERT triggers are the serialization
// point: they reset an expired period, check every cap, charge the entitlement,
// and finalize the reservation as `allowed`. The prepared INSERT returned by
// this module must be included in the same D1 batch as the receipt and event
// writes so a quota failure rolls the entire ingestion transaction back.

import type { D1BoundStatement, D1DatabaseLike } from "./db";

export interface BatchUsage {
  eventCount: number;
  bodyBytes: number;
}

export interface IngestLimits {
  batchEvents: number;
  batchBytes: number;
  monthlyEvents: number;
  monthlyBytes: number;
  lifetimeEvents: number;
  lifetimeBytes: number;
}

export interface IngestUsage {
  monthlyEvents: number;
  monthlyBytes: number;
  lifetimeEvents: number;
  lifetimeBytes: number;
}

export type IngestPolicy =
  | {
      mode: "inactive";
      workspaceId: string;
      planId: string;
      entitlementStatus: string;
    }
  | {
      mode: "invalid";
      workspaceId: string;
    }
  | {
      mode: "metered";
      workspaceId: string;
      planId: string;
      limits: IngestLimits;
      usage: IngestUsage;
      periodStart: number;
      periodEnd: number;
      resetRequired: boolean;
    };

export type QuotaErrorCode =
  | "invalid_quota_request"
  | "entitlement_inactive"
  | "quota_configuration_error"
  | "batch_events_exceeded"
  | "batch_bytes_exceeded"
  | "monthly_events_exceeded"
  | "monthly_bytes_exceeded"
  | "lifetime_events_exceeded"
  | "lifetime_bytes_exceeded"
  | "idempotency_conflict"
  | "quota_reservation_rejected"
  | "quota_unavailable";

export interface QuotaErrorBody {
  error: string;
  code: QuotaErrorCode;
  local_capture_unaffected: true;
  detail?: {
    scope?: "batch" | "month" | "lifetime";
    resource?: "events" | "bytes";
    limit?: number;
    used?: number;
    requested?: number;
    remaining?: number;
    resets_at?: number;
    retryable?: boolean;
  };
}

export interface QuotaDenial {
  ok: false;
  status: 400 | 403 | 409 | 429 | 503;
  body: QuotaErrorBody;
}

export interface QuotaValidationAllowance {
  ok: true;
}

export type QuotaValidationResult = QuotaValidationAllowance | QuotaDenial;

export interface PrepareQuotaInput extends BatchUsage {
  workspaceId: string;
  idempotencyKey: string;
  /** Canonical SHA-256: exactly 64 lowercase hexadecimal characters. */
  requestHash: string;
  nowSeconds?: number;
}

export type QuotaPreparationAllowance =
  | {
      ok: true;
      metered: true;
      duplicate: true;
    }
  | {
      ok: true;
      metered: true;
      duplicate: false;
      statement: D1BoundStatement;
    };

export type PrepareQuotaReservationResult = QuotaPreparationAllowance | QuotaDenial;

interface EntitlementRow {
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

interface ReservationRow {
  request_hash: string;
  event_count: number;
  body_bytes: number;
  status: string;
}

const CANONICAL_HASH = /^[0-9a-f]{64}$/;

// Hosted Basic provisions fixed 30-day accounting periods. The HTTP boundary
// uses this horizon to reject corrupted reset metadata before emitting retry
// policy; quota accounting itself remains conservative for existing rows.
export const MAX_QUOTA_RETRY_AFTER_SECONDS = 30 * 24 * 60 * 60;

const READ_POLICY_SQL = `
  /* quota:read-policy */
  SELECT workspace_id, plan_id, status,
         max_batch_events, max_batch_bytes,
         max_monthly_events, max_monthly_bytes,
         max_lifetime_events, max_lifetime_bytes,
         used_monthly_events, used_monthly_bytes,
         used_lifetime_events, used_lifetime_bytes,
         period_start, period_end
  FROM workspace_entitlements
  WHERE workspace_id = ?1
  LIMIT 1`;

const READ_RESERVATION_SQL = `
  /* quota:read-reservation */
  SELECT request_hash, event_count, body_bytes, status
  FROM quota_reservations
  WHERE workspace_id = ?1 AND idempotency_key = ?2
  LIMIT 1`;

const INSERT_RESERVATION_SQL = `
  /* quota:insert-reservation */
  INSERT OR IGNORE INTO quota_reservations
    (workspace_id, idempotency_key, request_hash, event_count, body_bytes,
     status, created_at, decided_at)
  VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL)`;

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validUsage(usage: BatchUsage): boolean {
  return (
    Number.isSafeInteger(usage.eventCount) &&
    usage.eventCount > 0 &&
    Number.isSafeInteger(usage.bodyBytes) &&
    usage.bodyBytes > 0
  );
}

function invalidRequest(): QuotaDenial {
  return {
    ok: false,
    status: 400,
    body: {
      error: "invalid quota request",
      code: "invalid_quota_request",
      local_capture_unaffected: true,
    },
  };
}

function unavailable(code: "quota_configuration_error" | "quota_unavailable"): QuotaDenial {
  return {
    ok: false,
    status: 503,
    body: {
      error: code === "quota_configuration_error"
        ? "hosted quota is not configured safely"
        : "hosted quota is temporarily unavailable",
      code,
      local_capture_unaffected: true,
      detail: { retryable: code === "quota_unavailable" },
    },
  };
}

function limitDenial(
  code: QuotaErrorCode,
  scope: "batch" | "month" | "lifetime",
  resource: "events" | "bytes",
  limit: number,
  used: number,
  requested: number,
  resetsAt?: number,
): QuotaDenial {
  return {
    ok: false,
    status: 429,
    body: {
      error: "hosted quota exceeded",
      code,
      local_capture_unaffected: true,
      detail: {
        scope,
        resource,
        limit,
        used,
        requested,
        remaining: Math.max(0, limit - used),
        ...(resetsAt === undefined ? {} : { resets_at: resetsAt }),
        // A byte-identical retry can succeed after a monthly period rolls
        // over. Per-batch requests must be made smaller and lifetime caps need
        // an entitlement change, so retrying either unchanged would only
        // create a hot loop. Keep this server-authoritative classification in
        // the response instead of making clients infer it from an error code.
        retryable: scope === "month",
      },
    },
  };
}

function exceeds(used: number, requested: number, limit: number): boolean {
  // Subtraction avoids overflowing when a counter approaches MAX_SAFE_INTEGER.
  return used > limit || requested > limit - used;
}

function advancePeriod(
  periodStart: number,
  periodEnd: number,
  nowSeconds: number,
): { start: number; end: number } | null {
  const duration = periodEnd - periodStart;
  const elapsedPeriods = Math.floor((nowSeconds - periodStart) / duration);
  const start = periodStart + elapsedPeriods * duration;
  const end = start + duration;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
  return { start, end };
}

export async function readIngestPolicy(
  db: D1DatabaseLike,
  workspaceId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IngestPolicy> {
  const row = await db.prepare(READ_POLICY_SQL).bind(workspaceId).first<EntitlementRow>();
  // Missing entitlement is an invalid hosted configuration. Treating seeded
  // workspaces as implicitly unmetered would create a permanent cost bypass
  // for every pre-migration device token.
  if (row === null) return { mode: "invalid", workspaceId };

  if (
    row.workspace_id !== workspaceId ||
    typeof row.plan_id !== "string" ||
    row.plan_id.length === 0 ||
    typeof row.status !== "string" ||
    row.status.length === 0
  ) {
    return { mode: "invalid", workspaceId };
  }

  if (row.status !== "active") {
    return {
      mode: "inactive",
      workspaceId,
      planId: row.plan_id,
      entitlementStatus: row.status,
    };
  }

  const numericValues: unknown[] = [
    row.max_batch_events,
    row.max_batch_bytes,
    row.max_monthly_events,
    row.max_monthly_bytes,
    row.max_lifetime_events,
    row.max_lifetime_bytes,
    row.used_monthly_events,
    row.used_monthly_bytes,
    row.used_lifetime_events,
    row.used_lifetime_bytes,
    row.period_start,
    row.period_end,
    nowSeconds,
  ];
  if (
    !numericValues.every(safeNonNegativeInteger) ||
    row.period_end <= row.period_start
  ) {
    return { mode: "invalid", workspaceId };
  }

  const resetRequired = nowSeconds >= row.period_end;
  const advanced = resetRequired
    ? advancePeriod(row.period_start, row.period_end, nowSeconds)
    : { start: row.period_start, end: row.period_end };
  if (advanced === null) return { mode: "invalid", workspaceId };

  return {
    mode: "metered",
    workspaceId,
    planId: row.plan_id,
    limits: {
      batchEvents: row.max_batch_events,
      batchBytes: row.max_batch_bytes,
      monthlyEvents: row.max_monthly_events,
      monthlyBytes: row.max_monthly_bytes,
      lifetimeEvents: row.max_lifetime_events,
      lifetimeBytes: row.max_lifetime_bytes,
    },
    usage: {
      monthlyEvents: resetRequired ? 0 : row.used_monthly_events,
      monthlyBytes: resetRequired ? 0 : row.used_monthly_bytes,
      lifetimeEvents: row.used_lifetime_events,
      lifetimeBytes: row.used_lifetime_bytes,
    },
    periodStart: advanced.start,
    periodEnd: advanced.end,
    resetRequired,
  };
}

export function validateBatchAgainstPlan(
  policy: IngestPolicy,
  usage: BatchUsage,
): QuotaValidationResult {
  if (!validUsage(usage)) return invalidRequest();
  if (policy.mode === "invalid") return unavailable("quota_configuration_error");
  if (policy.mode === "inactive") {
    return {
      ok: false,
      status: 403,
      body: {
        error: "hosted entitlement is not active",
        code: "entitlement_inactive",
        local_capture_unaffected: true,
      },
    };
  }

  const checks: Array<{
    code: QuotaErrorCode;
    scope: "batch" | "month" | "lifetime";
    resource: "events" | "bytes";
    limit: number;
    used: number;
    requested: number;
    resetsAt?: number;
  }> = [
    {
      code: "batch_events_exceeded",
      scope: "batch",
      resource: "events",
      limit: policy.limits.batchEvents,
      used: 0,
      requested: usage.eventCount,
    },
    {
      code: "batch_bytes_exceeded",
      scope: "batch",
      resource: "bytes",
      limit: policy.limits.batchBytes,
      used: 0,
      requested: usage.bodyBytes,
    },
    {
      code: "monthly_events_exceeded",
      scope: "month",
      resource: "events",
      limit: policy.limits.monthlyEvents,
      used: policy.usage.monthlyEvents,
      requested: usage.eventCount,
      resetsAt: policy.periodEnd,
    },
    {
      code: "monthly_bytes_exceeded",
      scope: "month",
      resource: "bytes",
      limit: policy.limits.monthlyBytes,
      used: policy.usage.monthlyBytes,
      requested: usage.bodyBytes,
      resetsAt: policy.periodEnd,
    },
    {
      code: "lifetime_events_exceeded",
      scope: "lifetime",
      resource: "events",
      limit: policy.limits.lifetimeEvents,
      used: policy.usage.lifetimeEvents,
      requested: usage.eventCount,
    },
    {
      code: "lifetime_bytes_exceeded",
      scope: "lifetime",
      resource: "bytes",
      limit: policy.limits.lifetimeBytes,
      used: policy.usage.lifetimeBytes,
      requested: usage.bodyBytes,
    },
  ];

  for (const check of checks) {
    if (exceeds(check.used, check.requested, check.limit)) {
      return limitDenial(
        check.code,
        check.scope,
        check.resource,
        check.limit,
        check.used,
        check.requested,
        check.resetsAt,
      );
    }
  }
  return { ok: true };
}

async function readReservation(
  db: D1DatabaseLike,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ReservationRow | null> {
  return await db
    .prepare(READ_RESERVATION_SQL)
    .bind(workspaceId, idempotencyKey)
    .first<ReservationRow>();
}

function reservationConflict(
  row: ReservationRow,
  input: PrepareQuotaInput,
): QuotaDenial | null {
  if (
    row.request_hash !== input.requestHash ||
    row.event_count !== input.eventCount ||
    row.body_bytes !== input.bodyBytes
  ) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "idempotency key was already used for a different request",
        code: "idempotency_conflict",
        local_capture_unaffected: true,
      },
    };
  }
  return null;
}

/**
 * Prepare the single reservation statement that must be prepended to the
 * ingestion D1 batch. This function never charges counters itself.
 */
export async function prepareQuotaReservation(
  db: D1DatabaseLike,
  input: PrepareQuotaInput,
): Promise<PrepareQuotaReservationResult> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    input.workspaceId.trim().length === 0 ||
    input.idempotencyKey.trim().length === 0 ||
    input.idempotencyKey.length > 256 ||
    !CANONICAL_HASH.test(input.requestHash) ||
    !safeNonNegativeInteger(nowSeconds) ||
    !validUsage(input)
  ) {
    return invalidRequest();
  }

  try {
    const existing = await readReservation(db, input.workspaceId, input.idempotencyKey);
    if (existing !== null) {
      const conflict = reservationConflict(existing, input);
      if (conflict !== null) return conflict;
      if (existing.status === "allowed") {
        return { ok: true, metered: true, duplicate: true };
      }
      if (existing.status === "rejected") {
        return {
          ok: false,
          status: 429,
          body: {
            error: "hosted quota reservation was rejected",
            code: "quota_reservation_rejected",
            local_capture_unaffected: true,
            detail: { retryable: false },
          },
        };
      }
      // A pending reservation cannot survive a successful trigger-backed D1
      // transaction. Treat pending or unknown state as corruption, not a free
      // retry, so quota storage can never fail open.
      return unavailable(
        existing.status === "pending"
          ? "quota_unavailable"
          : "quota_configuration_error",
      );
    }

    const policy = await readIngestPolicy(db, input.workspaceId, nowSeconds);
    const validation = validateBatchAgainstPlan(policy, input);
    if (!validation.ok) return validation;

    return {
      ok: true,
      metered: true,
      duplicate: false,
      statement: db.prepare(INSERT_RESERVATION_SQL).bind(
        input.workspaceId,
        input.idempotencyKey,
        input.requestHash,
        input.eventCount,
        input.bodyBytes,
        nowSeconds,
      ),
    };
  } catch {
    // Quota storage is a cost-control boundary. Never continue hosted ingest
    // when an entitlement or reservation lookup is unavailable.
    return unavailable("quota_unavailable");
  }
}
