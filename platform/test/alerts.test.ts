// Unit tests for src/alerts.ts: exact decimal comparison vectors, the metric
// SQL run against real seeded span_observations/events (node:sqlite), the
// breach-transition state machine, the alert.fired append (shape, deterministic
// id, INSERT-only), channel dispatch through fakes, and the HTTP routes —
// plus a node:sqlite pass proving migration 0009's CHECK constraints, indexes
// and triggers hold.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ALERT_COMPARATORS,
  ALERT_EVENT_KIND,
  ALERT_GRID_SECONDS,
  ALERT_METRICS,
  ALERT_REFIRE_WINDOWS,
  ALERT_WINDOW_MINUTES,
  METRIC_SCALE,
  alertEventID,
  alertWindow,
  alertsScheduled,
  buildAlertEvent,
  compareDecimalStrings,
  comparatorHolds,
  decideFire,
  handleAlertsRoute,
  measureMetric,
  observationBucket,
  ratioToDecimalString,
  scaledToDecimalString,
  validateChannels,
  type AlertRuleRow,
  type AlertsEnv,
  type FetchLike,
  type SendEmailLike,
} from "../src/alerts";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { canonicalJsonStringify } from "../src/ingest";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts, test/webhooks.test.ts) ----

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function mockDb(handlers: {
  first?: (statement: RecordedStatement) => unknown | Promise<unknown>;
  all?: (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;
  run?: (statement: RecordedStatement) => void | Promise<void>;
  batch?: (statements: RecordedStatement[]) => void | Promise<void>;
} = {}) {
  const statements: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const db: D1DatabaseLike = {
    prepare(sql: string): D1Statement & D1BoundStatement & RecordedStatement {
      const statement: D1Statement & D1BoundStatement & RecordedStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) {
          statement.binds = values;
          return statement;
        },
        async first<T = unknown>() {
          return ((await handlers.first?.(statement)) ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: ((await handlers.all?.(statement)) ?? []) as T[] };
        },
        async run() {
          await handlers.run?.(statement);
          return { success: true };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(bound: D1BoundStatement[]) {
      const recorded = bound as unknown as RecordedStatement[];
      batches.push(recorded);
      await handlers.batch?.(recorded);
      return [];
    },
  };
  return { db, statements, batches };
}

// -- real-SQL adapter: D1DatabaseLike over node:sqlite ---------------------------
// The metric statements are the load-bearing part of this slice, so they run
// against the real schema (migrations 0001..0009 applied in order) rather than
// against a fake that would happily agree with a wrong query.

function sqliteDb(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string): D1Statement {
      let binds: unknown[] = [];
      const bound: D1BoundStatement = {
        async first<T = unknown>() {
          const row = db.prepare(sql).get(...(binds as never[]));
          return (row ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: db.prepare(sql).all(...(binds as never[])) as T[] };
        },
        async run<T = unknown>() {
          db.prepare(sql).run(...(binds as never[]));
          return { success: true } as { success: boolean; results?: T[] };
        },
      };
      return {
        bind(...values: unknown[]) {
          binds = values;
          return bound;
        },
      };
    },
    async batch(statements: D1BoundStatement[]) {
      db.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
}

// -- fixtures ---------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const DEVICE_TOKEN = "dev_test-token-alerts";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const ALR_ONE = `alr_01J${"A".repeat(23)}`;
const ALR_TWO = `alr_01J${"B".repeat(23)}`;
const WORKSTREAM_ONE = `ws_01J${"C".repeat(23)}`;

/** 2023-11-14T22:13:20Z — deliberately NOT on the 30-minute grid. */
const NOW = 1_700_000_000;

let TOKEN_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    workspace_id: TOKEN_WORKSPACE,
    token_hash: TOKEN_HASH,
    capabilities: "ingest,read",
    revoked_at: null,
    ...overrides,
  };
}

/** Resolves device auth from `FROM devices`, delegates everything else. */
function authedFirst(
  extra: (statement: RecordedStatement) => unknown | Promise<unknown> = () => null,
  deviceOverrides: Record<string, unknown> = {},
): (statement: RecordedStatement) => unknown | Promise<unknown> {
  return async (statement) => {
    if (statement.sql.includes("FROM devices")) return deviceRow(deviceOverrides);
    return extra(statement);
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

function ruleRow(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: ALR_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "Error rate too high",
    metric: "error_rate",
    window_minutes: 30,
    comparator: "gt",
    threshold: "0.100000",
    workstream_id: null,
    channels: canonicalJsonStringify([{ type: "webhook", url: "https://example.com/hook" }]),
    active: 1,
    created_at: 1_699_000_000,
    last_evaluated_at: null,
    last_fired_at: null,
    breach_state: "ok",
    ...overrides,
  };
}

const neverFetch: FetchLike = async () => {
  throw new Error("fetch should not have been called");
};

// -- exact decimal comparison -------------------------------------------------------

describe("compareDecimalStrings", () => {
  const vectors: Array<[string, string, -1 | 0 | 1]> = [
    ["0", "0", 0],
    ["0.0", "0", 0],
    ["0.100000", "0.1", 0],
    ["1.50", "1.5", 0],
    ["0.1", "0.2", -1],
    ["0.2", "0.1", 1],
    ["2", "10", -1],
    ["10", "2", 1],
    ["0009", "9", 0],
    ["0.000001", "0.000002", -1],
    ["1.000001", "1.000000", 1],
    // Beyond IEEE-754 exactness: a float comparison would collapse these.
    ["9007199254740993", "9007199254740992", 1],
    ["0.1000000000000000055511151231257827", "0.1", 1],
    ["123456789012345678901234567890", "123456789012345678901234567891", -1],
  ];

  for (const [a, b, expected] of vectors) {
    it(`compares ${a} against ${b} exactly`, () => {
      expect(compareDecimalStrings(a, b)).toBe(expected);
      expect(compareDecimalStrings(b, a)).toBe(expected === 0 ? 0 : ((-expected) as -1 | 1));
    });
  }

  it("does not route the comparison through a float", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754, and the usual float display rounding
    // hides it. The decimal comparator sees the sum's exact expansion for what
    // it is: strictly greater than 0.3.
    const floatSum = (0.1 + 0.2).toFixed(20); // "0.30000000000000004441"
    expect(0.1 + 0.2 === 0.3).toBe(false); // the float trap
    expect(Number(floatSum).toFixed(1)).toBe("0.3"); // ...and how it hides
    expect(compareDecimalStrings(floatSum, "0.3")).toBe(1); // exact decimal truth
    // Trailing zeros are value-preserving, not value-changing.
    expect(compareDecimalStrings("0.30", "0.3")).toBe(0);
  });

  it("orders negative values below positive ones and treats -0 as zero", () => {
    expect(compareDecimalStrings("-1", "1")).toBe(-1);
    expect(compareDecimalStrings("-2", "-1")).toBe(-1);
    expect(compareDecimalStrings("-0.00", "0")).toBe(0);
  });

  it("throws rather than guessing on a malformed operand", () => {
    expect(() => compareDecimalStrings("1e5", "1")).toThrow();
    expect(() => compareDecimalStrings("", "1")).toThrow();
    expect(() => compareDecimalStrings("abc", "1")).toThrow();
  });
});

describe("comparatorHolds", () => {
  it("implements every comparator against an exact decimal comparison", () => {
    expect(comparatorHolds("0.100001", "gt", "0.1")).toBe(true);
    expect(comparatorHolds("0.100000", "gt", "0.1")).toBe(false);
    expect(comparatorHolds("0.100000", "gte", "0.1")).toBe(true);
    expect(comparatorHolds("0.099999", "lt", "0.1")).toBe(true);
    expect(comparatorHolds("0.100000", "lt", "0.1")).toBe(false);
    expect(comparatorHolds("0.100000", "lte", "0.1")).toBe(true);
  });

  it("covers the declared comparator set", () => {
    expect([...ALERT_COMPARATORS].sort()).toEqual(["gt", "gte", "lt", "lte"]);
  });
});

describe("scaledToDecimalString / ratioToDecimalString", () => {
  it("renders scaled integers at a fixed scale", () => {
    expect(scaledToDecimalString(12_500n, 6)).toBe("0.012500");
    expect(scaledToDecimalString(12_000_000n, 6)).toBe("12.000000");
    expect(scaledToDecimalString(0n, 6)).toBe("0.000000");
    expect(scaledToDecimalString(-500_000n, 6)).toBe("-0.500000");
    expect(scaledToDecimalString(42n, 0)).toBe("42");
  });

  it("truncates a ratio at the metric scale and never divides by zero", () => {
    expect(ratioToDecimalString(1n, 4n, 6)).toBe("0.250000");
    expect(ratioToDecimalString(1n, 3n, 6)).toBe("0.333333");
    expect(ratioToDecimalString(2n, 3n, 6)).toBe("0.666666"); // truncated, never rounded up
    expect(ratioToDecimalString(0n, 0n, 6)).toBe("0.000000");
    expect(ratioToDecimalString(4n, 4n, 6)).toBe("1.000000");
  });
});

// -- windows --------------------------------------------------------------------------

describe("alertWindow", () => {
  it("ends on the 30-minute grid boundary at or before now", () => {
    const window = alertWindow(30, NOW);
    expect(window.endSeconds % ALERT_GRID_SECONDS).toBe(0);
    expect(window.endSeconds).toBeLessThanOrEqual(NOW);
    expect(NOW - window.endSeconds).toBeLessThan(ALERT_GRID_SECONDS);
    expect(window.startSeconds).toBe(window.endSeconds - 1_800);
  });

  it("derives exact bucket bounds with no slack bucket", () => {
    for (const minutes of ALERT_WINDOW_MINUTES) {
      const window = alertWindow(minutes, NOW);
      expect(window.startBucket).toBe(window.startSeconds / ALERT_GRID_SECONDS);
      expect(window.endBucket).toBe(window.endSeconds / ALERT_GRID_SECONDS - 1);
      expect(window.endBucket - window.startBucket + 1).toBe((minutes * 60) / ALERT_GRID_SECONDS);
      expect(observationBucket(window.startNs)).toBe(window.startBucket);
    }
  });

  it("emits nanosecond bounds as exact decimal strings beyond Number range", () => {
    const window = alertWindow(60, NOW);
    expect(window.startNs).toBe((BigInt(window.startSeconds) * 1_000_000_000n).toString());
    expect(Number.isSafeInteger(Number(window.startNs))).toBe(false);
  });

  it("is stable across every evaluation inside one grid slot", () => {
    const slotStart = Math.floor(NOW / ALERT_GRID_SECONDS) * ALERT_GRID_SECONDS;
    const a = alertWindow(30, slotStart);
    const b = alertWindow(30, slotStart + ALERT_GRID_SECONDS - 1);
    expect(a).toEqual(b);
  });
});

// -- migration + real-SQL fixtures ------------------------------------------------------

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0009_alerts.sql";
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql") && name <= THIS_MIGRATION)
  .sort();

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return db;
}

interface SeedSpan {
  span_id: string;
  workspace_id?: string;
  workstream_id?: string | null;
  status?: "unknown" | "running" | "ok" | "error";
  started_at_seconds: number;
  token_in?: number | null;
  token_out?: number | null;
  cost_amount?: string | null;
}

const STATUS_RANK: Record<string, number> = { unknown: 0, running: 1, ok: 2, error: 3 };

function seedSpan(db: DatabaseSync, span: SeedSpan): void {
  const status = span.status ?? "ok";
  const cost = span.cost_amount ?? null;
  db.prepare(`
    INSERT INTO span_observations
      (workspace_id, span_id, trace_id, workstream_id, kind, name, status, status_rank,
       started_at_ns, start_event_id, token_in, token_out, cost_amount, cost_provenance,
       fingerprint)
    VALUES (?1, ?2, 'trc_seed', ?3, 'llm.call', 'seed', ?4, ?5, CAST(?6 AS INTEGER), 'evt_seed',
            ?7, ?8, ?9, ?10, ?11)
  `).run(
    span.workspace_id ?? TOKEN_WORKSPACE,
    span.span_id,
    span.workstream_id ?? null,
    status,
    STATUS_RANK[status],
    (BigInt(span.started_at_seconds) * 1_000_000_000n).toString(),
    span.token_in ?? null,
    span.token_out ?? null,
    cost,
    cost === null ? null : "provider_reported",
    "a".repeat(24),
  );
}

function seedEvent(
  db: DatabaseSync,
  options: {
    event_id: string;
    workspace_id?: string;
    workstream_id?: string | null;
    ingested_at: number;
    kind?: string;
    raw_json?: string;
  },
): void {
  db.prepare(`
    INSERT INTO events
      (workspace_id, event_id, occurred_at, workstream_id, kind, ingested_at, raw_json)
    VALUES (?1, ?2, '2023-11-14T22:00:00Z', ?3, ?4, ?5, ?6)
  `).run(
    options.workspace_id ?? TOKEN_WORKSPACE,
    options.event_id,
    options.workstream_id ?? null,
    options.kind ?? "span.started",
    options.ingested_at,
    options.raw_json ?? "{}",
  );
}

// -- metric SQL over real seeded rows ---------------------------------------------------

describe("measureMetric (real SQL, node:sqlite)", () => {
  const window = alertWindow(30, NOW);
  const inWindow = window.startSeconds + 600;
  const beforeWindow = window.startSeconds - 600;
  const atWindowEnd = window.endSeconds; // exclusive bound: must NOT be counted

  function seededSpans(): DatabaseSync {
    const db = migratedDatabase();
    // Four spans in the window, one of them an error.
    seedSpan(db, { span_id: "s1", started_at_seconds: inWindow, status: "error", token_in: 10, token_out: 1, cost_amount: "0.012500" });
    seedSpan(db, { span_id: "s2", started_at_seconds: inWindow, status: "ok", token_in: 20, token_out: 2, cost_amount: "0.0125" });
    seedSpan(db, { span_id: "s3", started_at_seconds: inWindow, status: "ok", token_in: 30, token_out: 3, cost_amount: null });
    seedSpan(db, { span_id: "s4", started_at_seconds: inWindow, status: "running", token_in: null, token_out: null, cost_amount: "1" });
    // Outside the half-open window on both ends — never counted.
    seedSpan(db, { span_id: "s5", started_at_seconds: beforeWindow, status: "error", token_in: 999, cost_amount: "99" });
    seedSpan(db, { span_id: "s6", started_at_seconds: atWindowEnd, status: "error", token_in: 999, cost_amount: "99" });
    // Another tenant's data — never counted.
    seedSpan(db, { span_id: "s7", workspace_id: OTHER_WORKSPACE, started_at_seconds: inWindow, status: "error", token_in: 999, cost_amount: "99" });
    return db;
  }

  async function measure(db: DatabaseSync, metric: string, workstreamId: string | null = null) {
    return measureMetric(
      sqliteDb(db),
      { workspace_id: TOKEN_WORKSPACE, metric, workstream_id: workstreamId },
      window,
    );
  }

  it("computes error_rate from the numerator AND denominator of one scan", async () => {
    const db = seededSpans();
    // 1 error span / 4 in-window spans = 0.25 exactly.
    expect(await measure(db, "error_rate")).toEqual({ value: "0.250000", scale: METRIC_SCALE });
    db.close();
  });

  it("reports error_rate 0 rather than dividing by zero on an empty window", async () => {
    const db = migratedDatabase();
    expect(await measure(db, "error_rate")).toEqual({ value: "0.000000", scale: METRIC_SCALE });
    db.close();
  });

  it("counts failed spans as an integer", async () => {
    const db = seededSpans();
    expect(await measure(db, "failed_spans")).toEqual({ value: "1", scale: 0 });
    db.close();
  });

  it("sums token counters", async () => {
    const db = seededSpans();
    expect(await measure(db, "tokens_in")).toEqual({ value: "60", scale: 0 });
    expect(await measure(db, "tokens_out")).toEqual({ value: "6", scale: 0 });
    db.close();
  });

  it("sums decimal-string cost exactly, in SQL, without a float", async () => {
    const db = seededSpans();
    // 0.012500 + 0.0125 + (null) + 1 = 1.025000
    expect(await measure(db, "cost")).toEqual({ value: "1.025000", scale: METRIC_SCALE });
    db.close();
  });

  it("truncates cost beyond the metric scale rather than rounding through a float", async () => {
    const db = migratedDatabase();
    seedSpan(db, { span_id: "c1", started_at_seconds: inWindow, cost_amount: "0.1234567" });
    seedSpan(db, { span_id: "c2", started_at_seconds: inWindow, cost_amount: "0.0000004" });
    expect(await measure(db, "cost")).toEqual({ value: "0.123456", scale: METRIC_SCALE });
    db.close();
  });

  it("scopes span metrics to one workstream when the rule names one", async () => {
    const db = migratedDatabase();
    seedSpan(db, { span_id: "w1", started_at_seconds: inWindow, status: "error", workstream_id: WORKSTREAM_ONE });
    seedSpan(db, { span_id: "w2", started_at_seconds: inWindow, status: "ok", workstream_id: WORKSTREAM_ONE });
    seedSpan(db, { span_id: "w3", started_at_seconds: inWindow, status: "error", workstream_id: null });
    expect(await measure(db, "failed_spans")).toEqual({ value: "2", scale: 0 });
    expect(await measure(db, "failed_spans", WORKSTREAM_ONE)).toEqual({ value: "1", scale: 0 });
    expect(await measure(db, "error_rate", WORKSTREAM_ONE)).toEqual({
      value: "0.500000",
      scale: METRIC_SCALE,
    });
    db.close();
  });

  it("counts spine events by ingested_at, half-open and workspace-scoped", async () => {
    const db = migratedDatabase();
    seedEvent(db, { event_id: "evt_in_1", ingested_at: window.startSeconds });
    seedEvent(db, { event_id: "evt_in_2", ingested_at: inWindow, workstream_id: WORKSTREAM_ONE });
    seedEvent(db, { event_id: "evt_before", ingested_at: window.startSeconds - 1 });
    seedEvent(db, { event_id: "evt_after", ingested_at: window.endSeconds });
    seedEvent(db, { event_id: "evt_other", ingested_at: inWindow, workspace_id: OTHER_WORKSPACE });
    expect(await measure(db, "events")).toEqual({ value: "2", scale: 0 });
    expect(await measure(db, "events", WORKSTREAM_ONE)).toEqual({ value: "1", scale: 0 });
    db.close();
  });

  it("prunes by ts_bucket and by the exact nanosecond bound together", async () => {
    const db = seededSpans();
    // s5/s6 sit in adjacent buckets; the bucket predicate alone would still
    // exclude them, and the exact predicate keeps a partially-covered bucket
    // honest. Both are asserted by the totals above; here we prove the SQL
    // carries both predicates.
    const captured: string[] = [];
    const spy: D1DatabaseLike = {
      prepare(sql: string) {
        captured.push(sql);
        return sqliteDb(db).prepare(sql);
      },
      batch: (statements) => sqliteDb(db).batch(statements),
    };
    await measureMetric(
      spy,
      { workspace_id: TOKEN_WORKSPACE, metric: "failed_spans", workstream_id: null },
      window,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("ts_bucket >=");
    expect(captured[0]).toContain("ts_bucket <=");
    expect(captured[0]).toContain("started_at_ns >= CAST(?4 AS INTEGER)");
    expect(captured[0]).toContain("started_at_ns < CAST(?5 AS INTEGER)");
    db.close();
  });

  it("covers every declared metric", async () => {
    const db = seededSpans();
    for (const metric of ALERT_METRICS) {
      const measurement = await measure(db, metric);
      expect(typeof measurement.value).toBe("string");
      expect(() => compareDecimalStrings(measurement.value, "0")).not.toThrow();
    }
    db.close();
  });
});

// -- breach transition state machine -------------------------------------------------

describe("decideFire", () => {
  const window = alertWindow(30, NOW);

  it("fires on the ok -> breach transition", () => {
    expect(decideFire("ok", null, true, window, 30)).toEqual({
      breaching: true,
      fire: true,
      nextState: "breaching",
    });
  });

  it("stays silent while continuously breaching", () => {
    const lastFired = window.endSeconds - 1_800; // one window ago
    expect(decideFire("breaching", lastFired, true, window, 30)).toEqual({
      breaching: true,
      fire: false,
      nextState: "breaching",
    });
  });

  it("re-fires a sustained breach once the refire budget has elapsed", () => {
    const budget = ALERT_REFIRE_WINDOWS * 30 * 60;
    expect(decideFire("breaching", window.endSeconds - budget + 1, true, window, 30).fire).toBe(false);
    expect(decideFire("breaching", window.endSeconds - budget, true, window, 30).fire).toBe(true);
  });

  it("recovers to ok and then fires again on the next breach", () => {
    const recovered = decideFire("breaching", window.endSeconds - 60, false, window, 30);
    expect(recovered).toEqual({ breaching: false, fire: false, nextState: "ok" });
    expect(decideFire(recovered.nextState, window.endSeconds - 60, true, window, 30).fire).toBe(true);
  });
});

// -- alert.fired append ------------------------------------------------------------------

describe("buildAlertEvent", () => {
  const window = alertWindow(30, NOW);

  it("derives a deterministic evt_<ulid> id from the rule id and window end", async () => {
    const a = await alertEventID(ALR_ONE, window.endSeconds);
    const b = await alertEventID(ALR_ONE, window.endSeconds);
    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await alertEventID(ALR_TWO, window.endSeconds)).not.toBe(a);
    expect(await alertEventID(ALR_ONE, window.endSeconds + ALERT_GRID_SECONDS)).not.toBe(a);
  });

  it("builds a canonical OBSERVED hfg.event.v1 document with the payload the scope names", async () => {
    const rule = ruleRow({ workstream_id: WORKSTREAM_ONE });
    const event = await buildAlertEvent(rule, { value: "0.250000", scale: 6 }, window);
    const document = JSON.parse(event.rawJson) as Record<string, unknown>;

    expect(document.schema_version).toBe("hfg.event.v1");
    expect(document.kind).toBe(ALERT_EVENT_KIND);
    // A platform measurement over recorded evidence is OBSERVED, never INFERRED.
    expect(document.provenance).toBe("OBSERVED");
    expect(document.event_id).toBe(event.eventId);
    expect(document.occurred_at).toBe(new Date(window.endSeconds * 1000).toISOString());
    expect(document.workstream_id).toBe(WORKSTREAM_ONE);
    expect(document.payload).toEqual({
      rule_id: ALR_ONE,
      rule_name: "Error rate too high",
      metric: "error_rate",
      value: "0.250000",
      threshold: "0.100000",
      comparator: "gt",
      window_minutes: 30,
    });
    expect(event.contentHash).toBe(`sha256:${await sha256Hex(canonicalJsonStringify(document.payload))}`);
    expect(event.rawJson).toBe(canonicalJsonStringify(document));
  });

  it("omits workstream_id entirely for a workspace-wide rule", async () => {
    const event = await buildAlertEvent(ruleRow(), { value: "1", scale: 0 }, window);
    expect(Object.keys(JSON.parse(event.rawJson) as object)).not.toContain("workstream_id");
  });
});

// -- alertsScheduled ------------------------------------------------------------------------

interface SweepCapture {
  batches: RecordedStatement[][];
  statements: RecordedStatement[];
}

function sweepDb(
  rules: AlertRuleRow[],
  spanRow: Record<string, unknown> = {
    span_total: "4",
    span_errors: "2",
    token_in_total: "0",
    token_out_total: "0",
    cost_micro_total: "0",
  },
) {
  return mockDb({
    all: (statement) => (statement.sql.includes("alerts:due-rules") ? rules : []),
    first: (statement) => {
      if (statement.sql.includes("alerts:span-metrics")) return spanRow;
      if (statement.sql.includes("alerts:event-metrics")) return { event_total: "0" };
      return null;
    },
  });
}

function firedEventBind(capture: SweepCapture): unknown[] {
  const batch = capture.batches[0];
  expect(batch).toBeDefined();
  const insert = batch.find((s) => s.sql.includes("alerts:append-alert-fired"));
  expect(insert).toBeDefined();
  return insert!.binds;
}

describe("alertsScheduled", () => {
  it("fires on the ok -> breach transition and appends one alert.fired event", async () => {
    const rule = ruleRow();
    const { db, statements, batches } = sweepDb([rule]);
    await alertsScheduled({ DB: db }, neverFetch, NOW);

    const binds = firedEventBind({ batches, statements });
    const window = alertWindow(30, NOW);
    expect(binds[0]).toBe(TOKEN_WORKSPACE); // workspace-scoped
    expect(binds[1]).toBe(await alertEventID(ALR_ONE, window.endSeconds)); // deterministic id
    expect(binds[2]).toBe(new Date(window.endSeconds * 1000).toISOString());
    expect(binds[3]).toBe(null); // workstream_id
    expect(binds[4]).toBe("alert.fired");
    const document = JSON.parse(binds[7] as string) as Record<string, unknown>;
    expect(document.provenance).toBe("OBSERVED");
    // 2 errors / 4 spans = 0.5 > threshold 0.1
    expect((document.payload as Record<string, unknown>).value).toBe("0.500000");

    // The append and the bookkeeping commit together, in one batch.
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][1].sql).toContain("alerts:record-fire");
    expect(batches[0][1].binds).toEqual([ALR_ONE, TOKEN_WORKSPACE, NOW, window.endSeconds]);
  });

  it("appends by INSERT alone — it never UPDATEs or DELETEs the spine", async () => {
    const { db, statements, batches } = sweepDb([ruleRow()]);
    await alertsScheduled({ DB: db }, neverFetch, NOW);

    const eventStatements = [...statements, ...batches.flat()].filter((s) =>
      /\bevents\b/.test(s.sql),
    );
    expect(eventStatements.length).toBeGreaterThan(0);
    for (const statement of eventStatements) {
      expect(statement.sql).toContain("INSERT OR IGNORE INTO events");
      expect(statement.sql).not.toMatch(/UPDATE\s+events/);
      expect(statement.sql).not.toMatch(/DELETE\s+FROM\s+events/);
    }
  });

  it("stays silent while a breach is sustained", async () => {
    const window = alertWindow(30, NOW);
    const { db, batches, statements } = sweepDb([
      ruleRow({ breach_state: "breaching", last_fired_at: window.endSeconds - 1_800 }),
    ]);
    await alertsScheduled({ DB: db }, neverFetch, NOW);

    expect(batches).toHaveLength(0);
    const update = statements.find((s) => s.sql.includes("alerts:record-evaluation"));
    expect(update).toBeDefined();
    expect(update!.binds).toEqual([ALR_ONE, TOKEN_WORKSPACE, NOW, "breaching"]);
  });

  it("re-fires a sustained breach after the refire budget", async () => {
    const window = alertWindow(30, NOW);
    const { db, batches, statements } = sweepDb([
      ruleRow({
        breach_state: "breaching",
        last_fired_at: window.endSeconds - ALERT_REFIRE_WINDOWS * 30 * 60,
      }),
    ]);
    await alertsScheduled({ DB: db }, neverFetch, NOW);
    expect(batches).toHaveLength(1);
    expect(firedEventBind({ batches, statements })[1]).toBe(
      await alertEventID(ALR_ONE, window.endSeconds),
    );
  });

  it("records a recovery without firing, then fires again on the next breach", async () => {
    const okRow = {
      span_total: "4",
      span_errors: "0",
      token_in_total: "0",
      token_out_total: "0",
      cost_micro_total: "0",
    };
    const recovering = sweepDb([ruleRow({ breach_state: "breaching", last_fired_at: NOW - 60 })], okRow);
    await alertsScheduled({ DB: recovering.db }, neverFetch, NOW);
    expect(recovering.batches).toHaveLength(0);
    const recovery = recovering.statements.find((s) => s.sql.includes("alerts:record-evaluation"));
    expect(recovery!.binds[3]).toBe("ok");

    // Same rule, now back in the 'ok' state, breaching again: it fires.
    const refiring = sweepDb([ruleRow({ breach_state: "ok", last_fired_at: NOW - 60 })]);
    await alertsScheduled({ DB: refiring.db }, neverFetch, NOW);
    expect(refiring.batches).toHaveLength(1);
  });

  it("evaluates only rules that are due, in a deterministic order", async () => {
    const rules = [
      ruleRow({ id: ALR_TWO, workspace_id: OTHER_WORKSPACE }),
      ruleRow({ id: ALR_ONE, workspace_id: TOKEN_WORKSPACE }),
    ];
    const { db, statements, batches } = sweepDb(rules);
    await alertsScheduled({ DB: db }, neverFetch, NOW);

    const due = statements.find((s) => s.sql.includes("alerts:due-rules"));
    expect(due!.sql).toContain("active = 1");
    expect(due!.sql).toContain("?1 - last_evaluated_at >= window_minutes * 30");
    expect(due!.binds[0]).toBe(NOW);
    // Sorted (workspace_id, id) regardless of the order storage returned them.
    expect(batches.map((batch) => batch[0].binds[0])).toEqual([TOKEN_WORKSPACE, OTHER_WORKSPACE]);
  });

  it("keeps sweeping when one rule's evaluation throws", async () => {
    let metricCall = 0;
    const { db, batches } = mockDb({
      all: (statement) =>
        statement.sql.includes("alerts:due-rules")
          ? [ruleRow({ id: ALR_ONE }), ruleRow({ id: ALR_TWO })]
          : [],
      first: (statement) => {
        if (!statement.sql.includes("alerts:span-metrics")) return null;
        // Both rules share a workspace, so the sweep order is ALR_ONE then
        // ALR_TWO: fail the first measurement, serve the second.
        if (metricCall++ === 0) throw new Error("boom");
        return {
          span_total: "4",
          span_errors: "2",
          token_in_total: "0",
          token_out_total: "0",
          cost_micro_total: "0",
        };
      },
    });
    await expect(alertsScheduled({ DB: db }, neverFetch, NOW)).resolves.toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(batches[0][1].binds[0]).toBe(ALR_TWO);
  });
});

// -- channel dispatch -----------------------------------------------------------------------

describe("alert channel dispatch", () => {
  const slackChannel = { type: "slack", webhook_url: "https://hooks.slack.example/T/B/X" };
  const emailChannel = { type: "email", to: "oncall@example.com" };
  const webhookChannel = { type: "webhook", url: "https://example.com/hook" };

  function ruleWithChannels(channels: unknown[]): AlertRuleRow {
    return ruleRow({ channels: canonicalJsonStringify(channels) });
  }

  it("POSTs a Slack incoming-webhook payload of the shape Slack expects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response(null, { status: 200 });
    };
    const { db } = sweepDb([ruleWithChannels([slackChannel])]);
    await alertsScheduled({ DB: db }, fetcher, NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(slackChannel.webhook_url);
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toContain("Error rate too high");
    expect(body.text).toContain("0.500000");
  });

  it("sends email through the structural binding with the configured sender", async () => {
    const sent: Array<Record<string, string>> = [];
    const ALERT_EMAIL: SendEmailLike = {
      async send(message) {
        sent.push({ ...message });
      },
    };
    const { db } = sweepDb([ruleWithChannels([emailChannel])]);
    await alertsScheduled(
      { DB: db, ALERT_EMAIL, ALERT_SENDER: "alerts@handoffgraph.dev" },
      neverFetch,
      NOW,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("alerts@handoffgraph.dev");
    expect(sent[0].to).toBe("oncall@example.com");
    expect(sent[0].subject).toContain("Error rate too high");
    expect(sent[0].text).toContain("error_rate");
  });

  it("never POSTs a webhook channel — the row-47 sweep owns webhook egress", async () => {
    const { db, batches } = sweepDb([ruleWithChannels([webhookChannel])]);
    // neverFetch throws if the sweep tries to POST it.
    await alertsScheduled({ DB: db }, neverFetch, NOW);
    // The alert.fired event IS the delivery trigger for that pipeline.
    expect(batches).toHaveLength(1);
    expect(batches[0][0].binds[4]).toBe("alert.fired");
  });

  it("fails closed and keeps going when a channel throws", async () => {
    const sent: Array<Record<string, string>> = [];
    const ALERT_EMAIL: SendEmailLike = {
      async send(message) {
        sent.push({ ...message });
      },
    };
    const exploding: FetchLike = async () => {
      throw new Error("slack unreachable");
    };
    const { db, batches } = sweepDb([ruleWithChannels([slackChannel, emailChannel])]);

    await expect(
      alertsScheduled(
        { DB: db, ALERT_EMAIL, ALERT_SENDER: "alerts@handoffgraph.dev" },
        exploding,
        NOW,
      ),
    ).resolves.toBeUndefined();

    // The alert was still recorded, and the surviving channel still delivered.
    expect(batches).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("treats a non-2xx Slack response as a failed channel, not a failed sweep", async () => {
    const fetcher: FetchLike = async () => new Response(null, { status: 500 });
    const { db, batches } = sweepDb([ruleWithChannels([slackChannel])]);
    await expect(alertsScheduled({ DB: db }, fetcher, NOW)).resolves.toBeUndefined();
    expect(batches).toHaveLength(1);
  });

  it("skips email (never throws out) when the binding or sender is unset", async () => {
    const { db, batches } = sweepDb([ruleWithChannels([emailChannel])]);
    await expect(alertsScheduled({ DB: db }, neverFetch, NOW)).resolves.toBeUndefined();
    expect(batches).toHaveLength(1);

    const withoutSender = sweepDb([ruleWithChannels([emailChannel])]);
    const ALERT_EMAIL: SendEmailLike = {
      async send() {
        throw new Error("must not be called without a verified sender");
      },
    };
    await expect(
      alertsScheduled({ DB: withoutSender.db, ALERT_EMAIL }, neverFetch, NOW),
    ).resolves.toBeUndefined();
  });

  it("dispatches nothing at all when the rule does not fire", async () => {
    const okRow = {
      span_total: "4",
      span_errors: "0",
      token_in_total: "0",
      token_out_total: "0",
      cost_micro_total: "0",
    };
    const { db } = sweepDb([ruleWithChannels([slackChannel])], okRow);
    await expect(alertsScheduled({ DB: db }, neverFetch, NOW)).resolves.toBeUndefined();
  });
});

// -- validateChannels ----------------------------------------------------------------------

describe("validateChannels", () => {
  it("accepts the three channel shapes and sorts them canonically", () => {
    const result = validateChannels([
      { type: "slack", webhook_url: "https://hooks.slack.example/z" },
      { type: "email", to: "a@example.com" },
      { type: "webhook", url: "https://example.com/hook" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((channel) => channel.type)).toEqual(["email", "slack", "webhook"]);
  });

  it("rejects non-https channel URLs", () => {
    expect(validateChannels([{ type: "webhook", url: "http://example.com/hook" }]).ok).toBe(false);
    expect(validateChannels([{ type: "slack", webhook_url: "http://hooks.example/x" }]).ok).toBe(false);
    expect(validateChannels([{ type: "webhook", url: "ftp://example.com" }]).ok).toBe(false);
    expect(validateChannels([{ type: "webhook", url: "https://" }]).ok).toBe(false);
  });

  it("rejects malformed email addresses", () => {
    for (const to of ["not-an-email", "a@b", "a@@b.com", "a b@example.com", ""]) {
      expect(validateChannels([{ type: "email", to }]).ok).toBe(false);
    }
    expect(validateChannels([{ type: "email", to: "a@b.co" }]).ok).toBe(true);
  });

  it("rejects unknown channel types, empty arrays and non-objects", () => {
    expect(validateChannels([{ type: "sms", to: "+100" }]).ok).toBe(false);
    expect(validateChannels([]).ok).toBe(false);
    expect(validateChannels("nope").ok).toBe(false);
    expect(validateChannels(["https://example.com"]).ok).toBe(false);
  });
});

// -- HTTP routes --------------------------------------------------------------------------

const VALID_RULE = {
  name: "Error rate too high",
  metric: "error_rate",
  window_minutes: 30,
  comparator: "gt",
  threshold: "0.05",
  channels: [{ type: "webhook", url: "https://example.com/hook" }],
};

function createRequest(body: unknown, headers: Record<string, string> = authed()): Request {
  return request("/v1/alerts", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /v1/alerts", () => {
  it("requires authentication", async () => {
    const { db } = mockDb({ first: () => null });
    const response = await handleAlertsRoute(createRequest(VALID_RULE, {}), { DB: db });
    expect(response?.status).toBe(401);
  });

  it("requires the ingest capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "read" }) });
    const response = await handleAlertsRoute(createRequest(VALID_RULE), { DB: db });
    expect(response?.status).toBe(403);
  });

  it("creates a rule bound to the token's workspace", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(createRequest(VALID_RULE), { DB: db });
    expect(response?.status).toBe(201);

    const insert = statements.find((s) => s.sql.includes("alerts:insert-rule"));
    expect(insert).toBeDefined();
    expect(insert!.binds[0]).toMatch(/^alr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // Workspace comes from the device binding, never from the body.
    expect(insert!.binds[1]).toBe(TOKEN_WORKSPACE);
    expect(insert!.binds[8]).toBe(
      canonicalJsonStringify([{ type: "webhook", url: "https://example.com/hook" }]),
    );

    const body = (await response!.json()) as { alert: Record<string, unknown> };
    expect(body.alert.active).toBe(true);
    expect(body.alert.breach_state).toBe("ok");
    expect(body.alert.threshold).toBe("0.05");
  });

  it("ignores a workspace_id supplied in the body", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    await handleAlertsRoute(
      createRequest({ ...VALID_RULE, workspace_id: OTHER_WORKSPACE }),
      { DB: db },
    );
    const insert = statements.find((s) => s.sql.includes("alerts:insert-rule"));
    expect(insert!.binds[1]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects a non-https channel URL", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      createRequest({ ...VALID_RULE, channels: [{ type: "webhook", url: "http://example.com/hook" }] }),
      { DB: db },
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "webhook channel url must be an https:// URL" });
  });

  it("rejects an unsafe channel URL with 400 unsafe_url and the tripped rule", async () => {
    // Registration-time SSRF screen (src/urlguard.ts); full matrix in
    // test/urlguard.test.ts. Both URL-bearing channel types are screened.
    const cases: [unknown, string][] = [
      [
        { type: "webhook", url: "https://169.254.169.254/latest/meta-data" },
        "url host is a private, loopback, link-local, or metadata IPv4 address",
      ],
      [{ type: "webhook", url: "https://localhost/hook" }, "url host is a loopback hostname"],
      [
        { type: "slack", webhook_url: "https://hooks.internal/services/T/B/X" },
        "url host is in the private .internal name space",
      ],
      [{ type: "slack", webhook_url: "https://hooks.slack.example:9000/x" }, "url port must be 443 or 8443"],
    ];
    for (const [channel, reason] of cases) {
      const { db, statements } = mockDb({ first: authedFirst() });
      const response = await handleAlertsRoute(
        createRequest({ ...VALID_RULE, channels: [channel] }),
        { DB: db },
      );
      expect(response?.status).toBe(400);
      expect(await response!.json()).toEqual({ error: "unsafe_url", reason });
      expect(statements.some((s) => s.sql.includes("alerts:insert-rule"))).toBe(false);
    }
  });

  it("still accepts an email channel alongside a safe webhook channel", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      createRequest({
        ...VALID_RULE,
        channels: [
          { type: "email", to: "oncall@example.com" },
          { type: "webhook", url: "https://example.com/hook" },
        ],
      }),
      { DB: db },
    );
    expect(response?.status).toBe(201);
  });

  it("rejects a malformed email channel", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      createRequest({ ...VALID_RULE, channels: [{ type: "email", to: "nope" }] }),
      { DB: db },
    );
    expect(response?.status).toBe(400);
  });

  it("validates metric, window, comparator and threshold fail-closed", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const bad: Array<Record<string, unknown>> = [
      { ...VALID_RULE, metric: "latency" },
      { ...VALID_RULE, window_minutes: 45 },
      { ...VALID_RULE, window_minutes: "30" },
      { ...VALID_RULE, comparator: "eq" },
      { ...VALID_RULE, threshold: 0.05 },
      { ...VALID_RULE, threshold: "1e-2" },
      { ...VALID_RULE, threshold: "-1" },
      { ...VALID_RULE, threshold: "1.2.3" },
      { ...VALID_RULE, name: "" },
      { ...VALID_RULE, workstream_id: "not-a-workstream" },
    ];
    for (const body of bad) {
      const response = await handleAlertsRoute(createRequest(body), { DB: db });
      expect(response?.status).toBe(400);
    }
  });

  it("requires an integer threshold for the counter metrics but allows decimals for money", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const counter = await handleAlertsRoute(
      createRequest({ ...VALID_RULE, metric: "failed_spans", threshold: "1.5" }),
      { DB: db },
    );
    expect(counter?.status).toBe(400);
    const money = await handleAlertsRoute(
      createRequest({ ...VALID_RULE, metric: "cost", threshold: "12.505000" }),
      { DB: db },
    );
    expect(money?.status).toBe(201);
  });
});

describe("GET /v1/alerts", () => {
  it("returns an {items, next_cursor} envelope sorted newest first", async () => {
    const rows = [
      ruleRow({ id: ALR_ONE, created_at: 100 }),
      ruleRow({ id: ALR_TWO, created_at: 200 }),
    ];
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleAlertsRoute(
      request("/v1/alerts", { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(body.items.map((item) => item.id)).toEqual([ALR_TWO, ALR_ONE]);
    expect(body.next_cursor).toBe(null);
    expect(body.items[0].channels).toEqual([{ type: "webhook", url: "https://example.com/hook" }]);
  });

  it("requires the read capability", async () => {
    const { db } = mockDb({ first: authedFirst(undefined, { capabilities: "ingest" }) });
    const response = await handleAlertsRoute(request("/v1/alerts", { headers: authed() }), { DB: db });
    expect(response?.status).toBe(403);
  });
});

describe("POST /v1/alerts/{id}/disable", () => {
  it("disables a rule in the caller's workspace", async () => {
    const { db, statements } = mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("alerts:disable-rule") ? { id: ALR_ONE } : null,
      ),
    });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_ONE}/disable`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(200);
    const update = statements.find((s) => s.sql.includes("alerts:disable-rule"));
    expect(update!.binds).toEqual([ALR_ONE, TOKEN_WORKSPACE]);
  });

  it("404s a foreign or unknown rule without leaking its existence", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_TWO}/disable`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not found" });
  });
});

describe("POST /v1/alerts/{id}/test", () => {
  it("evaluates now and reports {value, threshold, would_fire} without writing anything", async () => {
    const { db, statements, batches } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("alerts:read-rule")) return ruleRow();
        if (statement.sql.includes("alerts:span-metrics")) {
          return {
            span_total: "4",
            span_errors: "1",
            token_in_total: "0",
            token_out_total: "0",
            cost_micro_total: "0",
          };
        }
        return null;
      }),
    });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_ONE}/test`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      value: "0.250000",
      threshold: "0.100000",
      would_fire: true,
    });

    // No append, no bookkeeping write, no channel dispatch.
    expect(batches).toHaveLength(0);
    for (const statement of statements) {
      expect(statement.sql).not.toContain("INSERT");
      expect(statement.sql).not.toContain("UPDATE");
    }
  });

  it("reports would_fire false below the threshold", async () => {
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("alerts:read-rule")) return ruleRow();
        if (statement.sql.includes("alerts:span-metrics")) {
          return {
            span_total: "100",
            span_errors: "1",
            token_in_total: "0",
            token_out_total: "0",
            cost_micro_total: "0",
          };
        }
        return null;
      }),
    });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_ONE}/test`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    expect(await response!.json()).toEqual({
      value: "0.010000",
      threshold: "0.100000",
      would_fire: false,
    });
  });

  it("404s a rule owned by another workspace", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_TWO}/test`, { method: "POST", headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
  });
});

describe("GET /v1/alerts/{id}/history", () => {
  function historyRow(seq: number, eventId: string): Record<string, unknown> {
    return {
      seq,
      event_id: eventId,
      occurred_at: "2023-11-14T22:00:00.000Z",
      raw_json: canonicalJsonStringify({
        schema_version: "hfg.event.v1",
        event_id: eventId,
        kind: "alert.fired",
        payload: {
          rule_id: ALR_ONE,
          rule_name: "Error rate too high",
          metric: "error_rate",
          value: "0.500000",
          threshold: "0.100000",
          comparator: "gt",
          window_minutes: 30,
        },
      }),
    };
  }

  it("reads alert.fired events for the rule from the spine", async () => {
    const { db, statements } = mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("alerts:read-rule") ? ruleRow() : null,
      ),
      all: () => [historyRow(2, "evt_b"), historyRow(1, "evt_a")],
    });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_ONE}/history`, { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      items: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      event_id: "evt_b",
      occurred_at: "2023-11-14T22:00:00.000Z",
      rule_id: ALR_ONE,
      rule_name: "Error rate too high",
      metric: "error_rate",
      value: "0.500000",
      threshold: "0.100000",
      comparator: "gt",
      window_minutes: 30,
    });

    const query = statements.find((s) => s.sql.includes("alerts:rule-history"));
    expect(query!.sql).toContain("kind = 'alert.fired'");
    expect(query!.sql).toContain("json_extract(raw_json, '$.payload.rule_id')");
    expect(query!.binds.slice(0, 2)).toEqual([TOKEN_WORKSPACE, ALR_ONE]);
  });

  it("404s before reading history for a rule in another workspace", async () => {
    const { db, statements } = mockDb({ first: authedFirst() });
    const response = await handleAlertsRoute(
      request(`/v1/alerts/${ALR_TWO}/history`, { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
    expect(statements.some((s) => s.sql.includes("alerts:rule-history"))).toBe(false);
  });
});

describe("alerts routing", () => {
  it("returns null for paths it does not own", async () => {
    const { db } = mockDb();
    expect(await handleAlertsRoute(request("/v1/webhooks"), { DB: db })).toBe(null);
    expect(await handleAlertsRoute(request("/v1/alerts/not-an-id/test"), { DB: db })).toBe(null);
  });

  it("returns null on a wrong method for an owned path, so index.ts answers 404", async () => {
    const { db } = mockDb();
    expect(await handleAlertsRoute(request("/v1/alerts", { method: "DELETE" }), { DB: db })).toBe(null);
    expect(
      await handleAlertsRoute(request(`/v1/alerts/${ALR_ONE}/disable`), { DB: db }),
    ).toBe(null);
    expect(
      await handleAlertsRoute(request(`/v1/alerts/${ALR_ONE}/history`, { method: "POST" }), { DB: db }),
    ).toBe(null);
  });
});

// -- end-to-end append against the real schema -------------------------------------------------

describe("alert.fired append against the real schema (node:sqlite)", () => {
  it("appends once, is idempotent on replay, and cannot be updated or deleted", async () => {
    const db = migratedDatabase();
    const window = alertWindow(30, NOW);
    const rule = ruleRow();
    db.prepare(`
      INSERT INTO alert_rules
        (id, workspace_id, name, metric, window_minutes, comparator, threshold,
         workstream_id, channels, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      rule.id, rule.workspace_id, rule.name, rule.metric, rule.window_minutes,
      rule.comparator, rule.threshold, rule.workstream_id, rule.channels, rule.created_at,
    );
    // 2 errors of 4 spans = 0.5 > 0.1 threshold.
    const inWindow = window.startSeconds + 60;
    seedSpan(db, { span_id: "e1", started_at_seconds: inWindow, status: "error" });
    seedSpan(db, { span_id: "e2", started_at_seconds: inWindow, status: "error" });
    seedSpan(db, { span_id: "e3", started_at_seconds: inWindow, status: "ok" });
    seedSpan(db, { span_id: "e4", started_at_seconds: inWindow, status: "ok" });

    const env: AlertsEnv = { DB: sqliteDb(db) };
    await alertsScheduled(env, neverFetch, NOW);

    const fired = db
      .prepare(`SELECT event_id, kind, provenance, workspace_id, raw_json FROM events`)
      .all() as Array<Record<string, string>>;
    expect(fired).toHaveLength(1);
    expect(fired[0].kind).toBe("alert.fired");
    expect(fired[0].provenance).toBe("OBSERVED");
    expect(fired[0].workspace_id).toBe(TOKEN_WORKSPACE);
    expect(fired[0].event_id).toBe(await alertEventID(rule.id, window.endSeconds));
    expect(JSON.parse(fired[0].raw_json).payload.value).toBe("0.500000");

    const state = db
      .prepare(`SELECT breach_state, last_fired_at, last_evaluated_at FROM alert_rules WHERE id = ?1`)
      .get(rule.id) as Record<string, number | string>;
    expect(state.breach_state).toBe("breaching");
    expect(state.last_fired_at).toBe(window.endSeconds);
    expect(state.last_evaluated_at).toBe(NOW);

    // Re-firing the same window (forced by resetting only the state machine)
    // is absorbed by the deterministic id + INSERT OR IGNORE.
    db.prepare(`UPDATE alert_rules SET breach_state = 'ok' WHERE id = ?1`).run(rule.id);
    await alertsScheduled(env, neverFetch, NOW);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n,
    ).toBe(1);

    // The spine guards make history immutable, not merely conventionally so.
    expect(() =>
      db.prepare(`UPDATE events SET kind = 'x' WHERE event_id = ?1`).run(fired[0].event_id),
    ).toThrow();
    expect(() =>
      db.prepare(`DELETE FROM events WHERE event_id = ?1`).run(fired[0].event_id),
    ).toThrow();

    db.close();
  });
});

// -- migration 0009: tables, CHECKs, indexes, triggers (node:sqlite) ---------------------------

function insertRule(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: ALR_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "rule",
    metric: "error_rate",
    window_minutes: 30,
    comparator: "gt",
    threshold: "0.05",
    workstream_id: null,
    channels: JSON.stringify([{ type: "webhook", url: "https://example.com/hook" }]),
    created_at: 1_700_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO alert_rules
      (id, workspace_id, name, metric, window_minutes, comparator, threshold,
       workstream_id, channels, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).run(
    row.id as string,
    row.workspace_id as string,
    row.name as string,
    row.metric as string,
    row.window_minutes as number,
    row.comparator as string,
    row.threshold as string,
    row.workstream_id as string | null,
    row.channels as string,
    row.created_at as number,
  );
}

describe("0009 alerts migration (node:sqlite)", () => {
  it("applies after every prior migration and creates its objects", () => {
    const db = migratedDatabase();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("alert_rules");

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const index of [
      "idx_alert_rules_workspace",
      "idx_alert_rules_workspace_created",
      "idx_alert_rules_due",
      "idx_events_workspace_ingested",
      "idx_events_alert_fired",
    ]) {
      expect(indexes).toContain(index);
    }
    db.close();
  });

  it("requires workspace_id and rejects a malformed one", () => {
    const db = migratedDatabase();
    expect(() =>
      db.prepare(`
        INSERT INTO alert_rules
          (id, name, metric, window_minutes, comparator, threshold, channels, created_at)
        VALUES (?1, 'r', 'events', 30, 'gt', '1', '[]', 1)
      `).run(ALR_ONE),
    ).toThrow();
    expect(() => insertRule(db, { workspace_id: "wsp_short" })).toThrow();
    db.close();
  });

  it("rejects a malformed alert rule id", () => {
    const db = migratedDatabase();
    expect(() => insertRule(db, { id: "not_an_id" })).toThrow();
    expect(() => insertRule(db, { id: `alr_${"9".repeat(26)}` })).toThrow(); // first char must be 0-7
    db.close();
  });

  it("constrains metric, window_minutes, comparator and breach_state to their sets", () => {
    const db = migratedDatabase();
    expect(() => insertRule(db, { metric: "latency" })).toThrow();
    expect(() => insertRule(db, { window_minutes: 45 })).toThrow();
    expect(() => insertRule(db, { comparator: "eq" })).toThrow();
    ALERT_METRICS.forEach((metric, index) => {
      // Distinct Crockford-legal ids (C, D, E, ... — never colliding).
      const id = `alr_01J${String.fromCharCode(67 + index).repeat(23)}`;
      expect(() => insertRule(db, { id, metric, threshold: "1" })).not.toThrow();
    });
    db.close();
  });

  it("keeps floats and junk out of threshold", () => {
    const db = migratedDatabase();
    expect(() => insertRule(db, { threshold: "1e5" })).toThrow();
    expect(() => insertRule(db, { threshold: "abc" })).toThrow();
    expect(() => insertRule(db, { threshold: "" })).toThrow();
    expect(() => insertRule(db, { id: ALR_TWO, threshold: "0.000001" })).not.toThrow();
    db.close();
  });

  it("requires channels to be a JSON array", () => {
    const db = migratedDatabase();
    expect(() => insertRule(db, { channels: "not-json" })).toThrow();
    expect(() => insertRule(db, { channels: JSON.stringify({ type: "webhook" }) })).toThrow();
    db.close();
  });

  it("forbids editing a rule's definition in place", () => {
    const db = migratedDatabase();
    insertRule(db);
    for (const [column, value] of [
      ["name", "renamed"],
      ["metric", "events"],
      ["window_minutes", 60],
      ["comparator", "lt"],
      ["threshold", "9"],
      ["channels", "[]"],
      ["created_at", 5],
    ] as Array<[string, unknown]>) {
      expect(() =>
        db.prepare(`UPDATE alert_rules SET ${column} = ?1 WHERE id = ?2`).run(value as never, ALR_ONE),
      ).toThrow();
    }
    db.close();
  });

  it("allows the evaluator's bookkeeping columns to move forward only", () => {
    const db = migratedDatabase();
    insertRule(db);
    db.prepare(
      `UPDATE alert_rules SET last_evaluated_at = 100, last_fired_at = 100, breach_state = 'breaching' WHERE id = ?1`,
    ).run(ALR_ONE);
    expect(() =>
      db.prepare(`UPDATE alert_rules SET last_evaluated_at = 200 WHERE id = ?1`).run(ALR_ONE),
    ).not.toThrow();
    expect(() =>
      db.prepare(`UPDATE alert_rules SET last_evaluated_at = 50 WHERE id = ?1`).run(ALR_ONE),
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE alert_rules SET last_fired_at = 50 WHERE id = ?1`).run(ALR_ONE),
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE alert_rules SET last_fired_at = NULL WHERE id = ?1`).run(ALR_ONE),
    ).toThrow();
    db.close();
  });

  it("makes disabling terminal", () => {
    const db = migratedDatabase();
    insertRule(db);
    db.prepare(`UPDATE alert_rules SET active = 0 WHERE id = ?1`).run(ALR_ONE);
    expect(() =>
      db.prepare(`UPDATE alert_rules SET active = 1 WHERE id = ?1`).run(ALR_ONE),
    ).toThrow();
    db.close();
  });
});
