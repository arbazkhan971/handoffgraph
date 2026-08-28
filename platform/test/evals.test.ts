// Unit tests for src/evals.ts (parity row 29).
//
// Coverage map:
//   * migration 0012 truth — CHECK constraints and triggers applied for real
//     with node:sqlite (migrations 0001..0012), including the judge-column
//     guards (https, {{input}}, ciphertext) and the terminal run machine;
//   * every deterministic check, pass AND fail, over seeded span_observations,
//     plus the exact-decimal rate arithmetic that decides tool_error_rate;
//   * THE PROVENANCE SPLIT, asserted on the stored rows rather than inferred:
//     a deterministic verdict is OBSERVED with source 'evaluation', a judge
//     verdict is INFERRED with source 'llm_judge', and there is no input that
//     produces the other combination;
//   * deterministic ids — a second run of the same config over the same traces
//     appends ZERO new events;
//   * fail-closed judging — non-200, unparseable body, unparseable verdict, an
//     out-of-range score and a thrown (timed-out) fetch each error the run and
//     leave no INFERRED event behind;
//   * the sealing-key contract — 503 on create and on run, and a run started
//     without the secret settles instead of stranding;
//   * crash-then-resume through a structural fake step runner, proving only
//     the remaining traces re-run and nothing is double-recorded;
//   * cron due-selection, the 200-trace bound (413), foreign-workspace 404s,
//     capability denials and method fallthrough.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { sealUpstreamKey, unsealUpstreamKey } from "../src/gateway";
import {
  CHECK_FAIL_VALUE,
  CHECK_PASS_VALUE,
  EvalWorkflow,
  JUDGE_INPUT_PLACEHOLDER,
  KNOWN_CHECKS,
  MAX_TRACES_PER_RUN,
  SOURCE_DETERMINISTIC,
  SOURCE_JUDGE,
  TOOL_ERROR_RATE_THRESHOLD,
  belowRateThreshold,
  buildCheckScoreEvent,
  buildJudgeInput,
  buildJudgeScoreEvent,
  canonicalScore,
  checkScoreEventID,
  evalWindow,
  evalsScheduled,
  evaluateCheck,
  executeEvalRun,
  extractCompletionContent,
  handleEvalsRoute,
  inlineStepRunner,
  judgeScoreEventID,
  nanosToMs,
  parseChecks,
  parseJudge,
  parseJudgeVerdict,
  parseTargetFilter,
  ratioDecimal,
  renderJudgePrompt,
  runEvalWorkflow,
  tallyHandoffs,
  validateCreateConfigBody,
  type CheckName,
  type EvalRunParams,
  type EvalRunRow,
  type EvalWorkflowLike,
  type EvalsEnv,
  type FetchLike,
  type TraceAggregate,
  type WorkflowStepLike,
} from "../src/evals";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts, test/simulations.test.ts) ----

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

// -- real-SQL adapter: D1DatabaseLike over node:sqlite -----------------------------
// The verdict writes are the load-bearing part of this slice (append-only spine,
// terminal run state, deterministic ids), so they run against the real schema
// rather than a fake that would happily agree with a wrong statement.

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

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0012_evals.sql";
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

// -- fixtures ----------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const DEVICE_TOKEN = "dev_test-token-evals";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const CONFIG_ONE = `evc_01J${"A".repeat(23)}`;
const CONFIG_TWO = `evc_01J${"B".repeat(23)}`;
const RUN_ONE = `evr_01J${"C".repeat(23)}`;
const RUN_TWO = `evr_01J${"D".repeat(23)}`;

/** 2023-11-14T22:13:20Z. */
const NOW_SECONDS = 1_700_000_000;
const SEALING_KEY = "unit-test-eval-sealing-key";
const JUDGE_API_KEY = "sk-judge-secret";
const JUDGE_MODEL = "judge-1";
const JUDGE_BASE_URL = "https://judge.example.com/v1";
const JUDGE_TEMPLATE = `Grade this trace.\n${JUDGE_INPUT_PLACEHOLDER}\nReturn {"score","reason"}.`;
const FINGERPRINT = "0123456789abcdef01234567";

const ALL_CHECKS: CheckName[] = [...KNOWN_CHECKS];

let TOKEN_HASH = "";
let JUDGE_CIPHERTEXT = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  JUDGE_CIPHERTEXT = await sealUpstreamKey(JUDGE_API_KEY, SEALING_KEY);
});

const STATUS_RANK: Record<string, number> = { unknown: 0, running: 1, ok: 2, error: 3 };

interface SpanSeed {
  kind: string;
  status: "unknown" | "running" | "ok" | "error";
  /** Defaults true; false leaves the span open (traces_closed evidence). */
  ended?: boolean;
  name?: string;
  toolName?: string | null;
}

const SEED_SPAN_SQL = `
  INSERT INTO span_observations
    (workspace_id, span_id, trace_id, parent_span_id, session_id, native_session_id,
     workstream_id, provider, agent, model, kind, name, status, status_rank,
     started_at_ns, start_event_id, ended_at_ns, end_event_id, tool_name, exit_code,
     token_in, token_out, cost_amount, cost_provenance, fingerprint)
  VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, NULL, NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, NULL, NULL, NULL, NULL, NULL, ?14)`;

/** Seed one trace's spans. Times are decimal-string int64 nanoseconds. */
function seedTrace(
  db: DatabaseSync,
  traceId: string,
  spans: SpanSeed[],
  options: {
    workspaceId?: string;
    workstreamId?: string | null;
    atSeconds?: number;
  } = {},
): void {
  const workspaceId = options.workspaceId ?? TOKEN_WORKSPACE;
  const workstreamId = options.workstreamId === undefined ? "ws_alpha" : options.workstreamId;
  const at = options.atSeconds ?? NOW_SECONDS - 1800;
  spans.forEach((span, index) => {
    const startNs = (BigInt(at) * 1_000_000_000n + BigInt(index)).toString();
    const endNs = (BigInt(at + 100) * 1_000_000_000n + BigInt(index)).toString();
    const ended = span.ended !== false;
    db.prepare(SEED_SPAN_SQL).run(
      workspaceId,
      `${traceId}-span-${index}`,
      traceId,
      workstreamId,
      span.kind,
      span.name ?? `${span.kind.toLowerCase()} step`,
      span.status,
      STATUS_RANK[span.status],
      startNs,
      `evt_start_${traceId}_${index}`,
      ended ? endNs : null,
      ended ? `evt_end_${traceId}_${index}` : null,
      span.toolName ?? null,
      FINGERPRINT,
    );
  });
}

const SEED_EVENT_SQL = `
  INSERT INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id, session_id,
     native_session_id, provider, kind, provenance, content_hash, ingested_at, raw_json)
  VALUES (?1, ?2, NULL, ?3, ?4, NULL, NULL, 'test', ?5, 'OBSERVED', NULL, ?6, ?7)`;

function seedHandoffEvent(
  db: DatabaseSync,
  eventId: string,
  kind: "handoff.created" | "handoff.accepted",
  options: { workspaceId?: string; workstreamId?: string; occurredAt?: string } = {},
): void {
  const occurredAt =
    options.occurredAt ?? new Date((NOW_SECONDS - 1800) * 1000).toISOString();
  db.prepare(SEED_EVENT_SQL).run(
    options.workspaceId ?? TOKEN_WORKSPACE,
    eventId,
    occurredAt,
    options.workstreamId ?? "ws_alpha",
    kind,
    NOW_SECONDS,
    JSON.stringify({ event_id: eventId, kind, occurred_at: occurredAt }),
  );
}

const SEED_CONFIG_SQL = `
  INSERT INTO eval_configs
    (id, workspace_id, name, active, "trigger", target_filter, checks, judge,
     created_at, last_run_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`;

function seedConfig(
  db: DatabaseSync,
  options: {
    id?: string;
    workspaceId?: string;
    name?: string;
    active?: number;
    trigger?: "cron" | "manual";
    sinceMinutes?: number;
    workstream?: string | null;
    kind?: string | null;
    checks?: CheckName[];
    judge?: Record<string, unknown> | null;
    createdAt?: number;
    lastRunAt?: number | null;
  } = {},
): string {
  const id = options.id ?? CONFIG_ONE;
  db.prepare(SEED_CONFIG_SQL).run(
    id,
    options.workspaceId ?? TOKEN_WORKSPACE,
    options.name ?? "nightly",
    options.active ?? 1,
    options.trigger ?? "manual",
    JSON.stringify({
      kind: options.kind ?? null,
      since_minutes: options.sinceMinutes ?? 60,
      workstream: options.workstream ?? null,
    }),
    JSON.stringify(options.checks ?? ALL_CHECKS),
    options.judge === undefined || options.judge === null
      ? null
      : JSON.stringify(options.judge),
    options.createdAt ?? NOW_SECONDS - 10_000,
    options.lastRunAt ?? null,
  );
  return id;
}

function judgeColumn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_key_ciphertext: JUDGE_CIPHERTEXT,
    base_url: JUDGE_BASE_URL,
    include_bodies: false,
    model: JUDGE_MODEL,
    prompt_template: JUDGE_TEMPLATE,
    ...overrides,
  };
}

const SEED_RUN_SQL = `
  INSERT INTO eval_runs
    (id, workspace_id, config_id, status, traces_evaluated, scores_recorded, started_at)
  VALUES (?1, ?2, ?3, 'running', 0, 0, ?4)`;

function seedRun(
  db: DatabaseSync,
  options: {
    id?: string;
    workspaceId?: string;
    configId?: string;
    startedAt?: number;
  } = {},
): string {
  const id = options.id ?? RUN_ONE;
  db.prepare(SEED_RUN_SQL).run(
    id,
    options.workspaceId ?? TOKEN_WORKSPACE,
    options.configId ?? CONFIG_ONE,
    options.startedAt ?? NOW_SECONDS,
  );
  return id;
}

interface StoredEvent {
  event_id: string;
  kind: string;
  provenance: string;
  occurred_at: string;
  workstream_id: string | null;
  content_hash: string;
  raw_json: string;
}

function scoreEvents(db: DatabaseSync, workspaceId = TOKEN_WORKSPACE): StoredEvent[] {
  return db
    .prepare(
      `SELECT event_id, kind, provenance, occurred_at, workstream_id, content_hash, raw_json
       FROM events WHERE workspace_id = ?1 AND kind = 'score.recorded' ORDER BY seq`,
    )
    .all(workspaceId) as unknown as StoredEvent[];
}

function payloadsOf(events: StoredEvent[]): Record<string, unknown>[] {
  return events.map((event) => JSON.parse(event.raw_json).payload as Record<string, unknown>);
}

function runRow(db: DatabaseSync, id = RUN_ONE): EvalRunRow {
  return db
    .prepare("SELECT * FROM eval_runs WHERE id = ?1")
    .get(id) as unknown as EvalRunRow;
}

function configRow(db: DatabaseSync, id = CONFIG_ONE): Record<string, unknown> {
  return db.prepare("SELECT * FROM eval_configs WHERE id = ?1").get(id) as unknown as Record<
    string,
    unknown
  >;
}

const FIXED_NOW = () => NOW_SECONDS * 1000;

function execution(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: TOKEN_WORKSPACE,
    runId: RUN_ONE,
    deadlineAtMs: Number.POSITIVE_INFINITY,
    ...overrides,
  } as { workspaceId: string; runId: string; deadlineAtMs: number };
}

// -- scripted upstream --------------------------------------------------------------

interface UpstreamCall {
  url: string;
  model: string;
  prompt: string;
  authorization: string;
}

type JudgeReply = { status: number; body: string } | { throws: true };

function completionBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

function judgeReply(score: unknown, reason = "the trace met the criteria"): JudgeReply {
  return { status: 200, body: completionBody(JSON.stringify({ score, reason })) };
}

/** A scripted OpenAI-compatible upstream; the last reply repeats. */
function scriptedFetch(replies: JudgeReply[]): { fetcher: FetchLike; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  let index = 0;
  const fetcher: FetchLike = async (url, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: { content?: string }[];
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      model: parsed.model ?? "",
      prompt: parsed.messages?.[0]?.content ?? "",
      authorization: headers.authorization ?? "",
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if ("throws" in reply) throw new Error("upstream deadline exceeded");
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

function neverCalled(): { fetcher: FetchLike; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const fetcher: FetchLike = async () => {
    throw new Error("upstream must not be called");
  };
  return { fetcher, calls };
}

// =============================================================================
// migration 0012 truth
// =============================================================================

describe("migration 0012", () => {
  it("applies cleanly on top of 0001..0011 and creates both tables", () => {
    const db = migratedDatabase();
    expect(migrationFiles).toContain(THIS_MIGRATION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain("eval_configs");
    expect(tables).toContain("eval_runs");
    db.close();
  });

  it("enforces the evc_/evr_ id shapes", () => {
    const db = migratedDatabase();
    expect(() => seedConfig(db, { id: "cfg_not_a_ulid" })).toThrow();
    expect(() => seedConfig(db, { id: `evc_9${"A".repeat(25)}` })).toThrow();
    seedConfig(db);
    expect(() => seedRun(db, { id: "run_nope" })).toThrow();
    db.close();
  });

  it("guards the judge column: https, {{input}} and ciphertext are all required", () => {
    const db = migratedDatabase();
    expect(() =>
      seedConfig(db, { id: CONFIG_ONE, judge: judgeColumn({ base_url: "http://judge.local" }) }),
    ).toThrow();
    expect(() =>
      seedConfig(db, { id: CONFIG_ONE, judge: judgeColumn({ prompt_template: "no slot here" }) }),
    ).toThrow();
    const { api_key_ciphertext: _dropped, ...withoutKey } = judgeColumn();
    expect(() => seedConfig(db, { id: CONFIG_ONE, judge: withoutKey })).toThrow();
    // The well-formed judge stores.
    seedConfig(db, { id: CONFIG_ONE, judge: judgeColumn() });
    expect(configRow(db).judge).toContain(JUDGE_BASE_URL);
    db.close();
  });

  it("bounds since_minutes and requires a non-empty checks array in-schema", () => {
    const db = migratedDatabase();
    expect(() => seedConfig(db, { sinceMinutes: 0 })).toThrow();
    expect(() => seedConfig(db, { sinceMinutes: 10_081 })).toThrow();
    expect(() => seedConfig(db, { checks: [] })).toThrow();
    // An ABSENT window is rejected too: json_type() returns NULL for a missing
    // path, and a CHECK treats NULL as satisfied unless it is compared with IS.
    expect(() =>
      db
        .prepare(SEED_CONFIG_SQL)
        .run(CONFIG_ONE, TOKEN_WORKSPACE, "n", 1, "manual", "{}", '["traces_closed"]', null,
          NOW_SECONDS, null),
    ).toThrow();
    db.close();
  });

  it("freezes the config definition and makes disable terminal", () => {
    const db = migratedDatabase();
    seedConfig(db);
    expect(() => db.prepare("UPDATE eval_configs SET name = 'x' WHERE id = ?1").run(CONFIG_ONE))
      .toThrow(/definition is immutable/);
    expect(() => db.prepare('UPDATE eval_configs SET "trigger" = \'cron\' WHERE id = ?1').run(CONFIG_ONE))
      .toThrow(/definition is immutable/);
    db.prepare("UPDATE eval_configs SET active = 0 WHERE id = ?1").run(CONFIG_ONE);
    expect(() => db.prepare("UPDATE eval_configs SET active = 1 WHERE id = ?1").run(CONFIG_ONE))
      .toThrow(/disable is terminal/);
    db.close();
  });

  it("keeps last_run_at monotone", () => {
    const db = migratedDatabase();
    seedConfig(db);
    db.prepare("UPDATE eval_configs SET last_run_at = ?2 WHERE id = ?1").run(CONFIG_ONE, 500);
    expect(() =>
      db.prepare("UPDATE eval_configs SET last_run_at = ?2 WHERE id = ?1").run(CONFIG_ONE, 400),
    ).toThrow(/last_run_at regressed/);
    db.prepare("UPDATE eval_configs SET last_run_at = ?2 WHERE id = ?1").run(CONFIG_ONE, 600);
    expect(configRow(db).last_run_at).toBe(600);
    db.close();
  });

  it("settles a run exactly once, with monotone counters and a write-once completion", () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    db.prepare(
      "UPDATE eval_runs SET status = 'done', traces_evaluated = 3, scores_recorded = 15, completed_at = ?2 WHERE id = ?1",
    ).run(RUN_ONE, NOW_SECONDS + 5);
    expect(() =>
      db.prepare("UPDATE eval_runs SET status = 'error' WHERE id = ?1").run(RUN_ONE),
    ).toThrow(/status is terminal/);
    expect(() =>
      db.prepare("UPDATE eval_runs SET completed_at = ?2 WHERE id = ?1").run(RUN_ONE, NOW_SECONDS + 9),
    ).toThrow(/completion time is write-once/);
    expect(() =>
      db.prepare("UPDATE eval_runs SET traces_evaluated = 1 WHERE id = ?1").run(RUN_ONE),
    ).toThrow(/progress regressed/);
    expect(() =>
      db.prepare("UPDATE eval_runs SET config_id = ?2 WHERE id = ?1").run(RUN_ONE, CONFIG_TWO),
    ).toThrow(/identity is immutable/);
    db.close();
  });

  it("ties status to completion and keeps error_detail a content-free token", () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    // 'done' without a completion instant, and a completion without settling,
    // are both incoherent states.
    expect(() =>
      db.prepare("UPDATE eval_runs SET status = 'done' WHERE id = ?1").run(RUN_ONE),
    ).toThrow();
    // A reason may only accompany an errored run...
    expect(() =>
      db
        .prepare(
          "UPDATE eval_runs SET status = 'done', completed_at = ?2, error_detail = 'judge_unavailable' WHERE id = ?1",
        )
        .run(RUN_ONE, NOW_SECONDS + 1),
    ).toThrow();
    // ...and it can never be a provider message.
    expect(() =>
      db
        .prepare(
          "UPDATE eval_runs SET status = 'error', completed_at = ?2, error_detail = ?3 WHERE id = ?1",
        )
        .run(RUN_ONE, NOW_SECONDS + 1, "429 Too Many Requests from api.openai.com"),
    ).toThrow();
    db.prepare(
      "UPDATE eval_runs SET status = 'error', completed_at = ?2, error_detail = 'judge_unavailable' WHERE id = ?1",
    ).run(RUN_ONE, NOW_SECONDS + 1);
    expect(runRow(db).error_detail).toBe("judge_unavailable");
    db.close();
  });

  it("caps traces_evaluated at the same ceiling the run path enforces", () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    expect(() =>
      db
        .prepare("UPDATE eval_runs SET traces_evaluated = ?2 WHERE id = ?1")
        .run(RUN_ONE, MAX_TRACES_PER_RUN + 1),
    ).toThrow();
    db.close();
  });
});

// =============================================================================
// deterministic evaluators (pure functions)
// =============================================================================

function aggregate(overrides: Partial<TraceAggregate> = {}): TraceAggregate {
  return {
    trace_id: "trc_alpha",
    workstream_id: "ws_alpha",
    span_count: 10,
    open_spans: 0,
    error_spans: 0,
    command_total: 4,
    command_failed: 0,
    test_total: 2,
    test_failed: 0,
    tool_total: 4,
    tool_failed: 0,
    first_ns: "1699998200000000000",
    last_ns: "1699998300000000000",
    ...overrides,
  };
}

const NO_HANDOFFS = { created: 0, accepted: 0 };

describe("deterministic checks", () => {
  it("traces_closed passes on a fully closed trace and fails on an open span", () => {
    expect(evaluateCheck("traces_closed", aggregate(), NO_HANDOFFS).passed).toBe(true);
    const failing = evaluateCheck("traces_closed", aggregate({ open_spans: 2 }), NO_HANDOFFS);
    expect(failing.passed).toBe(false);
    expect(failing.detail).toBe("2 unclosed span(s) of 10");
  });

  it("commands_ok passes with no failing COMMAND span and fails with one", () => {
    expect(evaluateCheck("commands_ok", aggregate(), NO_HANDOFFS).passed).toBe(true);
    const failing = evaluateCheck("commands_ok", aggregate({ command_failed: 1 }), NO_HANDOFFS);
    expect(failing.passed).toBe(false);
    expect(failing.detail).toBe("1/4 failed");
  });

  it("tests_pass passes with no failing TEST span and fails with one", () => {
    expect(evaluateCheck("tests_pass", aggregate(), NO_HANDOFFS).detail).toBe("2 passed, 0 failed");
    const failing = evaluateCheck("tests_pass", aggregate({ test_failed: 1 }), NO_HANDOFFS);
    expect(failing.passed).toBe(false);
    expect(failing.detail).toBe("1 passed, 1 failed");
  });

  it("tool_error_rate compares exactly against the threshold, never through a float", () => {
    // 4/100 = 0.04 < 0.10.
    const passing = evaluateCheck(
      "tool_error_rate",
      aggregate({ tool_total: 100, tool_failed: 4 }),
      NO_HANDOFFS,
    );
    expect(passing.passed).toBe(true);
    expect(passing.detail).toContain("rate 0.0400");
    // 15/100 = 0.15 >= 0.10.
    expect(
      evaluateCheck("tool_error_rate", aggregate({ tool_total: 100, tool_failed: 15 }), NO_HANDOFFS)
        .passed,
    ).toBe(false);
    // Exactly at the threshold is NOT below it.
    expect(
      evaluateCheck("tool_error_rate", aggregate({ tool_total: 10, tool_failed: 1 }), NO_HANDOFFS)
        .passed,
    ).toBe(false);
    // No tool spans is vacuously fine.
    expect(
      evaluateCheck("tool_error_rate", aggregate({ tool_total: 0, tool_failed: 0 }), NO_HANDOFFS)
        .passed,
    ).toBe(true);
  });

  it("handoffs_acknowledged passes when nothing was handed off or a handoff was accepted", () => {
    expect(evaluateCheck("handoffs_acknowledged", aggregate(), NO_HANDOFFS).passed).toBe(true);
    expect(
      evaluateCheck("handoffs_acknowledged", aggregate(), { created: 2, accepted: 1 }).passed,
    ).toBe(true);
    const failing = evaluateCheck("handoffs_acknowledged", aggregate(), {
      created: 2,
      accepted: 0,
    });
    expect(failing.passed).toBe(false);
    expect(failing.detail).toBe("2 created, 0 accepted");
  });

  it("computes ratios and threshold comparisons with exact integer arithmetic", () => {
    expect(ratioDecimal(1, 3, 4)).toBe("0.3333");
    expect(ratioDecimal(0, 0, 4)).toBe("0");
    expect(ratioDecimal(3, 3, 2)).toBe("1.00");
    expect(belowRateThreshold(1, 10, "0.10")).toBe(false);
    expect(belowRateThreshold(9, 100, "0.10")).toBe(true);
    expect(belowRateThreshold(0, 0, "0.10")).toBe(true);
    expect(belowRateThreshold(1, 1000, "0")).toBe(false);
    expect(TOOL_ERROR_RATE_THRESHOLD).toBe("0.10");
  });

  it("reads int64 nanosecond bounds without going through a float", () => {
    expect(nanosToMs("1699998300000000000")).toBe(1_699_998_300_000);
    expect(nanosToMs(null)).toBe(0);
    expect(nanosToMs("not-a-number")).toBe(0);
  });

  it("re-applies the exact window to handoff events after the coarse SQL prune", () => {
    const sinceMs = Date.parse("2023-11-14T21:00:00Z");
    const counts = tallyHandoffs(
      [
        // Inside the window, expressed with a numeric offset — a lexical
        // compare would have sorted this one below the ISO-Z bound.
        { workstream_id: "ws_a", kind: "handoff.created", occurred_at: "2023-11-14T23:30:00+02:00" },
        { workstream_id: "ws_a", kind: "handoff.accepted", occurred_at: "2023-11-14T22:00:00Z" },
        // Before the window: dropped by the exact re-filter.
        { workstream_id: "ws_a", kind: "handoff.created", occurred_at: "2023-11-14T19:00:00Z" },
        { workstream_id: "ws_b", kind: "handoff.created", occurred_at: "2023-11-14T22:10:00Z" },
        { workstream_id: "ws_b", kind: "unrelated.kind", occurred_at: "2023-11-14T22:10:00Z" },
      ],
      sinceMs,
    );
    expect(counts.get("ws_a")).toEqual({ created: 1, accepted: 1 });
    expect(counts.get("ws_b")).toEqual({ created: 1, accepted: 0 });
  });

  it("derives the window from the run's stored start, not a wall clock", () => {
    const window = evalWindow(NOW_SECONDS, 60);
    expect(window.sinceNs).toBe("1699996400000000000");
    expect(window.sinceMs).toBe(1_699_996_400_000);
    expect(window.sinceBucket).toBe(Number(1_699_996_400_000_000_000n / 1_800_000_000_000n));
    // The handoff prune is slackened past any RFC3339 offset.
    expect(Date.parse(window.sinceCoarseISO)).toBeLessThan(window.sinceMs - 14 * 3600 * 1000);
    // Same input, same window: a resumed run re-derives the same population.
    expect(evalWindow(NOW_SECONDS, 60)).toEqual(window);
  });
});

// =============================================================================
// score event shapes — the provenance split
// =============================================================================

describe("score events", () => {
  it("labels a deterministic verdict OBSERVED with source 'evaluation'", async () => {
    const event = await buildCheckScoreEvent({
      configId: CONFIG_ONE,
      traceId: "trc_alpha",
      workstreamId: "ws_alpha",
      verdict: { check: "commands_ok", passed: false, detail: "1/4 failed" },
      traceEndMs: 1_699_998_300_000,
    });
    expect(event.provenance).toBe("OBSERVED");
    const document = JSON.parse(event.rawJson) as Record<string, unknown>;
    expect(document.kind).toBe("score.recorded");
    expect(document.provenance).toBe("OBSERVED");
    expect(document.workstream_id).toBe("ws_alpha");
    const payload = document.payload as Record<string, unknown>;
    expect(payload.source).toBe(SOURCE_DETERMINISTIC);
    expect(payload.name).toBe("eval.commands_ok");
    expect(payload.data_type).toBe("BOOLEAN");
    expect(payload.value).toBe(CHECK_FAIL_VALUE);
    expect(payload.target_type).toBe("trace");
    expect(payload.target_id).toBe("trc_alpha");
    expect(payload.comment).toBe("1/4 failed");
    expect(payload.eval_config_id).toBe(CONFIG_ONE);
    // No run id and no wall clock: that is what makes a re-run byte-identical.
    expect(Object.keys(payload)).not.toContain("eval_run_id");
    expect(event.rawJson).not.toContain(String(Date.now()).slice(0, 8));
  });

  it("labels a judge verdict INFERRED with source 'llm_judge' and hashes the reason", async () => {
    const event = await buildJudgeScoreEvent({
      configId: CONFIG_ONE,
      configName: "nightly",
      runId: RUN_ONE,
      traceId: "trc_alpha",
      workstreamId: null,
      judgeModel: JUDGE_MODEL,
      score: "0.75",
      reason: "the assistant never ran the tests",
      traceEndMs: 1_699_998_300_000,
    });
    expect(event.provenance).toBe("INFERRED");
    const document = JSON.parse(event.rawJson) as Record<string, unknown>;
    expect(document.provenance).toBe("INFERRED");
    expect(document.workstream_id).toBeUndefined();
    const payload = document.payload as Record<string, unknown>;
    expect(payload.source).toBe(SOURCE_JUDGE);
    expect(payload.name).toBe("judge.nightly");
    expect(payload.data_type).toBe("NUMERIC");
    expect(payload.value).toBe("0.75");
    expect(payload.score_provenance).toBe("INFERRED");
    expect(payload.eval_run_id).toBe(RUN_ONE);
    // The rationale is proved, never stored.
    expect(payload.reason_hash).toBe(
      `sha256:${await sha256Hex("the assistant never ran the tests")}`,
    );
    expect(event.rawJson).not.toContain("never ran the tests");
  });

  it("derives ids as pure functions: checks ignore the run, judgements do not", async () => {
    const first = await checkScoreEventID(CONFIG_ONE, "trc_alpha", "tests_pass", 1_000);
    const second = await checkScoreEventID(CONFIG_ONE, "trc_alpha", "tests_pass", 1_000);
    expect(first).toBe(second);
    expect(first).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await checkScoreEventID(CONFIG_ONE, "trc_alpha", "commands_ok", 1_000)).not.toBe(first);
    expect(await checkScoreEventID(CONFIG_TWO, "trc_alpha", "tests_pass", 1_000)).not.toBe(first);

    const judgeOne = await judgeScoreEventID(CONFIG_ONE, "trc_alpha", RUN_ONE, 1_000);
    expect(await judgeScoreEventID(CONFIG_ONE, "trc_alpha", RUN_ONE, 1_000)).toBe(judgeOne);
    expect(await judgeScoreEventID(CONFIG_ONE, "trc_alpha", RUN_TWO, 1_000)).not.toBe(judgeOne);
  });
});

// =============================================================================
// the judge (parsing and calling), fail-closed
// =============================================================================

describe("judge parsing", () => {
  it("accepts a bare object and one code fence", () => {
    expect(parseJudgeVerdict('{"score":"0.5","reason":"ok"}')).toEqual({
      score: "0.5",
      reason: "ok",
    });
    expect(parseJudgeVerdict('```json\n{"score":0.5,"reason":"ok"}\n```')?.score).toBe("0.5");
    expect(parseJudgeVerdict('{"score":1}')).toEqual({ score: "1", reason: "" });
  });

  it("refuses anything that is not an unambiguous in-range score", () => {
    expect(parseJudgeVerdict("not json")).toBeNull();
    expect(parseJudgeVerdict("[1,2]")).toBeNull();
    expect(parseJudgeVerdict('{"reason":"forgot the score"}')).toBeNull();
    expect(parseJudgeVerdict('{"score":"1.5"}')).toBeNull();
    expect(parseJudgeVerdict('{"score":"-0.1"}')).toBeNull();
    expect(parseJudgeVerdict('{"score":"pretty good"}')).toBeNull();
    expect(parseJudgeVerdict('Sure! Here is the JSON: {"score":"0.5"}')).toBeNull();
    // A number is accepted only when it stringifies to canonical decimal form,
    // so exponential notation is rejected rather than reinterpreted.
    expect(canonicalScore(1e-7)).toBeNull();
    expect(canonicalScore("1e-7")).toBeNull();
    expect(canonicalScore("0.001")).toBe("0.001");
    expect(canonicalScore(true)).toBeNull();
  });

  it("reads only choices[0].message.content", () => {
    expect(extractCompletionContent({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractCompletionContent({ choices: [] })).toBeNull();
    expect(extractCompletionContent({ choices: [{ message: {} }] })).toBeNull();
    expect(extractCompletionContent(null)).toBeNull();
  });

  it("renders a content-free trace summary and only widens it on include_bodies", () => {
    const summary = buildJudgeInput(aggregate({ error_spans: 1, open_spans: 0 }), null);
    expect(summary).toContain("trace: trc_alpha");
    expect(summary).toContain("spans: 10 (1 error, 0 unclosed)");
    expect(summary).toContain("commands: 4 (0 failed)");
    expect(summary).toContain("duration_ms: 100000");
    expect(summary).not.toContain("span timeline");

    const wide = buildJudgeInput(aggregate(), [
      { kind: "COMMAND", name: "go test ./...", status: "ok", tool_name: null, duration_ms: 12 },
      { kind: "TOOL", name: "read", status: "error", tool_name: "fs.read", duration_ms: null },
    ]);
    expect(wide).toContain("span timeline:");
    expect(wide).toContain("- COMMAND ok 12ms go test ./...");
    expect(wide).toContain("- TOOL error read tool=fs.read");
  });

  it("substitutes every occurrence of the template slot", () => {
    expect(renderJudgePrompt("a {{input}} b {{input}}", "X")).toBe("a X b X");
  });
});

// =============================================================================
// executing a run against the real schema
// =============================================================================

/** A trace with one failing command, one passing test, and a closed shape. */
function seedStandardTraces(db: DatabaseSync): void {
  seedTrace(db, "trc_alpha", [
    { kind: "COMMAND", status: "ok" },
    { kind: "TEST", status: "ok" },
    { kind: "TOOL", status: "ok" },
  ]);
  seedTrace(db, "trc_bravo", [
    { kind: "COMMAND", status: "error" },
    { kind: "TEST", status: "error" },
    { kind: "TOOL", status: "error" },
    { kind: "AGENT", status: "running", ended: false },
  ]);
}

describe("executeEvalRun — deterministic half", () => {
  it("appends one OBSERVED verdict per (trace, check) and settles the run done", async () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    seedStandardTraces(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };
    const { fetcher, calls } = neverCalled();

    const settled = await executeEvalRun(env, execution(), inlineStepRunner(), fetcher, FIXED_NOW);

    expect(settled?.status).toBe("done");
    expect(settled?.traces_evaluated).toBe(2);
    expect(settled?.scores_recorded).toBe(2 * ALL_CHECKS.length);
    expect(settled?.error_detail).toBeNull();
    expect(calls.length).toBe(0);

    const events = scoreEvents(db);
    expect(events.length).toBe(2 * ALL_CHECKS.length);
    // Every deterministic verdict is OBSERVED evidence, on the row itself.
    expect(new Set(events.map((event) => event.provenance))).toEqual(new Set(["OBSERVED"]));
    const payloads = payloadsOf(events);
    expect(new Set(payloads.map((payload) => payload.source))).toEqual(
      new Set([SOURCE_DETERMINISTIC]),
    );
    expect(new Set(payloads.map((payload) => payload.name))).toEqual(
      new Set(ALL_CHECKS.map((check) => `eval.${check}`)),
    );
    // The event carries the trace's own end instant, not the run's.
    expect(events[0].occurred_at).toBe(new Date((NOW_SECONDS - 1700) * 1000).toISOString());
    db.close();
  });

  it("records the right verdict per check, per trace", async () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    seedStandardTraces(db);
    // ws_alpha handed off and nobody accepted.
    seedHandoffEvent(db, "evt_handoff_1", "handoff.created");
    const env: EvalsEnv = { DB: sqliteDb(db) };

    await executeEvalRun(env, execution(), inlineStepRunner(), neverCalled().fetcher, FIXED_NOW);

    const byTraceAndCheck = new Map<string, string>();
    for (const payload of payloadsOf(scoreEvents(db))) {
      byTraceAndCheck.set(`${payload.target_id}|${payload.name}`, String(payload.value));
    }
    // The clean trace passes everything that is about its own spans.
    expect(byTraceAndCheck.get("trc_alpha|eval.traces_closed")).toBe(CHECK_PASS_VALUE);
    expect(byTraceAndCheck.get("trc_alpha|eval.commands_ok")).toBe(CHECK_PASS_VALUE);
    expect(byTraceAndCheck.get("trc_alpha|eval.tests_pass")).toBe(CHECK_PASS_VALUE);
    expect(byTraceAndCheck.get("trc_alpha|eval.tool_error_rate")).toBe(CHECK_PASS_VALUE);
    // The broken trace fails each of them.
    expect(byTraceAndCheck.get("trc_bravo|eval.traces_closed")).toBe(CHECK_FAIL_VALUE);
    expect(byTraceAndCheck.get("trc_bravo|eval.commands_ok")).toBe(CHECK_FAIL_VALUE);
    expect(byTraceAndCheck.get("trc_bravo|eval.tests_pass")).toBe(CHECK_FAIL_VALUE);
    expect(byTraceAndCheck.get("trc_bravo|eval.tool_error_rate")).toBe(CHECK_FAIL_VALUE);
    // The handoff obligation belongs to the workstream, so both traces inherit it.
    expect(byTraceAndCheck.get("trc_alpha|eval.handoffs_acknowledged")).toBe(CHECK_FAIL_VALUE);
    expect(byTraceAndCheck.get("trc_bravo|eval.handoffs_acknowledged")).toBe(CHECK_FAIL_VALUE);
    db.close();
  });

  it("passes handoffs_acknowledged once the handoff is accepted", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["handoffs_acknowledged"] });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    seedHandoffEvent(db, "evt_handoff_1", "handoff.created");
    seedHandoffEvent(db, "evt_handoff_2", "handoff.accepted");
    const env: EvalsEnv = { DB: sqliteDb(db) };

    await executeEvalRun(env, execution(), inlineStepRunner(), neverCalled().fetcher, FIXED_NOW);

    const payloads = payloadsOf(scoreEvents(db));
    expect(payloads.length).toBe(1);
    expect(payloads[0].value).toBe(CHECK_PASS_VALUE);
    expect(payloads[0].comment).toBe("1 created, 1 accepted");
    db.close();
  });

  it("re-running the same config over the same traces appends ZERO new events", async () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    seedStandardTraces(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };

    await executeEvalRun(env, execution(), inlineStepRunner(), neverCalled().fetcher, FIXED_NOW);
    const first = scoreEvents(db);
    expect(first.length).toBe(2 * ALL_CHECKS.length);

    // A brand-new run of the same config: same verdicts, same ids, same bytes.
    seedRun(db, { id: RUN_TWO, startedAt: NOW_SECONDS });
    const second = await executeEvalRun(
      env,
      execution({ runId: RUN_TWO }),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(second?.status).toBe("done");

    const after = scoreEvents(db);
    expect(after.length).toBe(first.length);
    expect(after.map((event) => event.event_id)).toEqual(first.map((event) => event.event_id));
    expect(after.map((event) => event.raw_json)).toEqual(first.map((event) => event.raw_json));
    db.close();
  });

  it("honours the target filter: workstream, kind and window all narrow the population", async () => {
    const db = migratedDatabase();
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }], { workstreamId: "ws_alpha" });
    seedTrace(db, "trc_bravo", [{ kind: "TEST", status: "ok" }], { workstreamId: "ws_beta" });
    // Outside the window (two hours before the run started).
    seedTrace(db, "trc_old", [{ kind: "COMMAND", status: "ok" }], {
      atSeconds: NOW_SECONDS - 7200,
    });
    // Another workspace's trace must never be visible.
    seedTrace(db, "trc_foreign", [{ kind: "COMMAND", status: "ok" }], {
      workspaceId: OTHER_WORKSPACE,
    });
    const env: EvalsEnv = { DB: sqliteDb(db) };

    seedConfig(db, { checks: ["traces_closed"], workstream: "ws_alpha" });
    seedRun(db);
    let settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.traces_evaluated).toBe(1);
    expect(payloadsOf(scoreEvents(db)).map((p) => p.target_id)).toEqual(["trc_alpha"]);

    seedConfig(db, { id: CONFIG_TWO, checks: ["traces_closed"], kind: "TEST" });
    seedRun(db, { id: RUN_TWO, configId: CONFIG_TWO });
    settled = await executeEvalRun(
      env,
      execution({ runId: RUN_TWO }),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.traces_evaluated).toBe(1);
    const targets = new Set(payloadsOf(scoreEvents(db)).map((p) => p.target_id));
    expect(targets).toEqual(new Set(["trc_alpha", "trc_bravo"]));
    expect(scoreEvents(db, OTHER_WORKSPACE).length).toBe(0);
    db.close();
  });

  it("returns null for a run in another workspace and is a no-op on a settled run", async () => {
    const db = migratedDatabase();
    seedConfig(db);
    seedRun(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };
    expect(
      await executeEvalRun(
        env,
        execution({ workspaceId: OTHER_WORKSPACE }),
        inlineStepRunner(),
        neverCalled().fetcher,
        FIXED_NOW,
      ),
    ).toBeNull();

    db.prepare(
      "UPDATE eval_runs SET status = 'done', completed_at = ?2 WHERE id = ?1",
    ).run(RUN_ONE, NOW_SECONDS + 1);
    const settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.completed_at).toBe(NOW_SECONDS + 1);
    expect(scoreEvents(db).length).toBe(0);
    db.close();
  });

  it("settles a run whose config vanished rather than stranding it", async () => {
    const db = migratedDatabase();
    seedRun(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };
    const settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("config_missing");
    db.close();
  });

  it("stops at a trace boundary when the inline deadline passes", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedRun(db);
    seedStandardTraces(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };

    // A clock that advances past the deadline after the first trace.
    let ticks = 0;
    const now = () => {
      ticks += 1;
      return ticks <= 1 ? NOW_SECONDS * 1000 : NOW_SECONDS * 1000 + 60_000;
    };
    const settled = await executeEvalRun(
      env,
      execution({ deadlineAtMs: NOW_SECONDS * 1000 + 1_000 }),
      inlineStepRunner(),
      neverCalled().fetcher,
      now,
    );
    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("deadline_exceeded");
    expect(settled?.traces_evaluated).toBe(1);
    expect(scoreEvents(db).length).toBe(1);
    db.close();
  });

  it("settles too_many_targets rather than grading an arbitrary prefix", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedRun(db);
    for (let index = 0; index <= MAX_TRACES_PER_RUN; index++) {
      seedTrace(db, `trc_${String(index).padStart(4, "0")}`, [{ kind: "COMMAND", status: "ok" }]);
    }
    const env: EvalsEnv = { DB: sqliteDb(db) };
    const settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("too_many_targets");
    expect(scoreEvents(db).length).toBe(0);
    db.close();
  });
});

// =============================================================================
// executing a run with a judge — the INFERRED half
// =============================================================================

describe("executeEvalRun — the LLM judge", () => {
  function judgingDatabase(): DatabaseSync {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"], judge: judgeColumn() });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    return db;
  }

  it("appends an INFERRED judge verdict alongside the OBSERVED check verdict", async () => {
    const db = judgingDatabase();
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
    const { fetcher, calls } = scriptedFetch([judgeReply("0.8")]);

    const settled = await executeEvalRun(env, execution(), inlineStepRunner(), fetcher, FIXED_NOW);

    expect(settled?.status).toBe("done");
    expect(settled?.scores_recorded).toBe(2);
    // The credential reached the upstream unsealed, and only there.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${JUDGE_BASE_URL}/chat/completions`);
    expect(calls[0].authorization).toBe(`Bearer ${JUDGE_API_KEY}`);
    expect(calls[0].model).toBe(JUDGE_MODEL);
    expect(calls[0].prompt).toContain("Grade this trace.");
    expect(calls[0].prompt).toContain("trace: trc_alpha");
    expect(calls[0].prompt).not.toContain(JUDGE_INPUT_PLACEHOLDER);

    const events = scoreEvents(db);
    expect(events.length).toBe(2);
    const bySource = new Map(
      events.map((event) => [
        String((JSON.parse(event.raw_json).payload as Record<string, unknown>).source),
        event,
      ]),
    );
    // THE invariant, asserted on the stored rows.
    expect(bySource.get(SOURCE_DETERMINISTIC)?.provenance).toBe("OBSERVED");
    expect(bySource.get(SOURCE_JUDGE)?.provenance).toBe("INFERRED");
    const judgePayload = JSON.parse(
      String(bySource.get(SOURCE_JUDGE)?.raw_json),
    ).payload as Record<string, unknown>;
    expect(judgePayload.value).toBe("0.8");
    expect(judgePayload.name).toBe("judge.nightly");
    expect(judgePayload.eval_run_id).toBe(RUN_ONE);
    db.close();
  });

  it("never lets a judge verdict be written as OBSERVED, on any path", async () => {
    const db = judgingDatabase();
    seedTrace(db, "trc_bravo", [{ kind: "TEST", status: "error" }]);
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
    const { fetcher } = scriptedFetch([judgeReply("0"), judgeReply("1")]);

    await executeEvalRun(env, execution(), inlineStepRunner(), fetcher, FIXED_NOW);

    for (const event of scoreEvents(db)) {
      const payload = JSON.parse(event.raw_json).payload as Record<string, unknown>;
      const isJudge = payload.source === SOURCE_JUDGE;
      expect(event.provenance).toBe(isJudge ? "INFERRED" : "OBSERVED");
      if (isJudge) expect(payload.score_provenance).toBe("INFERRED");
    }
    db.close();
  });

  it("widens the judge input to span names only when include_bodies is set", async () => {
    const db = migratedDatabase();
    seedConfig(db, {
      checks: ["traces_closed"],
      judge: judgeColumn({ include_bodies: true }),
    });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok", name: "go build ./..." }]);
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
    const { fetcher, calls } = scriptedFetch([judgeReply("0.5")]);

    await executeEvalRun(env, execution(), inlineStepRunner(), fetcher, FIXED_NOW);
    expect(calls[0].prompt).toContain("span timeline:");
    expect(calls[0].prompt).toContain("go build ./...");
    db.close();
  });

  for (const scenario of [
    { label: "a non-200 upstream", reply: { status: 500, body: "boom" } as JudgeReply,
      detail: "judge_unavailable" },
    { label: "a thrown (timed-out) fetch", reply: { throws: true } as JudgeReply,
      detail: "judge_unavailable" },
    { label: "an unparseable envelope", reply: { status: 200, body: "not json" } as JudgeReply,
      detail: "judge_unparseable" },
    { label: "a reply that is not the JSON contract",
      reply: { status: 200, body: completionBody("looks fine to me!") } as JudgeReply,
      detail: "judge_unparseable" },
    { label: "an out-of-range score", reply: judgeReply("1.5"), detail: "judge_unparseable" },
  ]) {
    it(`fails the run closed on ${scenario.label}, leaving no INFERRED event`, async () => {
      const db = judgingDatabase();
      const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
      const { fetcher } = scriptedFetch([scenario.reply]);

      const settled = await executeEvalRun(
        env,
        execution(),
        inlineStepRunner(),
        fetcher,
        FIXED_NOW,
      );

      expect(settled?.status).toBe("error");
      expect(settled?.error_detail).toBe(scenario.detail);
      const events = scoreEvents(db);
      // The OBSERVED check verdict stands — it is a fact about recorded spans
      // and does not become less true because a model was unreachable...
      expect(events.length).toBe(1);
      expect(events[0].provenance).toBe("OBSERVED");
      // ...and nothing model-derived leaked onto the spine, under any label.
      expect(events.filter((event) => event.provenance === "INFERRED").length).toBe(0);
      expect(events.some((event) => event.raw_json.includes(SOURCE_JUDGE))).toBe(false);
      db.close();
    });
  }

  it("settles sealing_key_unavailable without ever calling the upstream", async () => {
    const db = judgingDatabase();
    const env: EvalsEnv = { DB: sqliteDb(db) };
    const { fetcher, calls } = neverCalled();

    const settled = await executeEvalRun(env, execution(), inlineStepRunner(), fetcher, FIXED_NOW);

    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("sealing_key_unavailable");
    expect(calls.length).toBe(0);
    expect(scoreEvents(db).length).toBe(0);
    db.close();
  });

  it("settles judge_key_unusable when the stored ciphertext will not unseal", async () => {
    const db = migratedDatabase();
    seedConfig(db, {
      checks: ["traces_closed"],
      judge: judgeColumn({ api_key_ciphertext: "not-really-sealed" }),
    });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };

    const settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("judge_key_unusable");
    db.close();
  });

  it("settles config_unreadable on a stored definition it cannot parse", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    // Bypass the API to simulate a definition written by an older/newer build.
    db.exec("DROP TRIGGER eval_configs_definition_is_immutable");
    db.prepare("UPDATE eval_configs SET checks = '[\"no_such_check\"]' WHERE id = ?1").run(
      CONFIG_ONE,
    );
    seedRun(db);
    const env: EvalsEnv = { DB: sqliteDb(db) };
    const settled = await executeEvalRun(
      env,
      execution(),
      inlineStepRunner(),
      neverCalled().fetcher,
      FIXED_NOW,
    );
    expect(settled?.status).toBe("error");
    expect(settled?.error_detail).toBe("config_unreadable");
    db.close();
  });
});

// =============================================================================
// durability: crash then resume
// =============================================================================

/**
 * A structural stand-in for the Workflows `step` object. Results are memoized
 * by step name exactly as the real runtime memoizes a completed step, so a
 * resumed run replays the already-finished traces from cache instead of
 * re-evaluating (and, with a judge attached, re-billing) them.
 */
class FakeStepRunner implements WorkflowStepLike {
  readonly memo = new Map<string, unknown>();
  readonly executed: string[] = [];
  readonly replayed: string[] = [];
  crashAfter = Number.POSITIVE_INFINITY;

  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    if (this.memo.has(name)) {
      this.replayed.push(name);
      return this.memo.get(name) as T;
    }
    if (this.executed.length >= this.crashAfter) {
      throw new Error(`instance killed before ${name}`);
    }
    const value = await callback();
    this.memo.set(name, value);
    this.executed.push(name);
    return value;
  }
}

describe("durable execution", () => {
  it("resumes at the next trace and re-runs only what is left", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"], judge: judgeColumn() });
    seedRun(db);
    for (const name of ["trc_alpha", "trc_bravo", "trc_charlie"]) {
      seedTrace(db, name, [{ kind: "COMMAND", status: "ok" }]);
    }
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
    const { fetcher, calls } = scriptedFetch([judgeReply("0.9")]);

    const step = new FakeStepRunner();
    step.crashAfter = 2;
    await expect(
      executeEvalRun(env, execution(), step, fetcher, FIXED_NOW),
    ).rejects.toThrow(/instance killed/);

    // Two traces landed on the spine before the kill; the run is unsettled.
    expect(step.executed).toEqual(["trace-trc_alpha", "trace-trc_bravo"]);
    expect(calls.length).toBe(2);
    expect(scoreEvents(db).length).toBe(4);
    expect(runRow(db).status).toBe("running");
    expect(runRow(db).traces_evaluated).toBe(2);

    // Resume with the same memo, as the runtime would.
    step.crashAfter = Number.POSITIVE_INFINITY;
    const settled = await executeEvalRun(env, execution(), step, fetcher, FIXED_NOW);

    expect(step.replayed).toEqual(["trace-trc_alpha", "trace-trc_bravo"]);
    expect(step.executed).toEqual([
      "trace-trc_alpha",
      "trace-trc_bravo",
      "trace-trc_charlie",
    ]);
    // Only the third trace was re-billed.
    expect(calls.length).toBe(3);
    expect(settled?.status).toBe("done");
    expect(settled?.traces_evaluated).toBe(3);

    const events = scoreEvents(db);
    expect(events.length).toBe(6);
    // Idempotent by id: no trace was recorded twice.
    expect(new Set(events.map((event) => event.event_id)).size).toBe(6);
    db.close();
  });

  it("drives a run from instance params that carry no credential at all", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"], judge: judgeColumn() });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_SEALING_KEY: SEALING_KEY };
    const { fetcher, calls } = scriptedFetch([judgeReply("0.6")]);

    const params: EvalRunParams = {
      workspace_id: TOKEN_WORKSPACE,
      run_id: RUN_ONE,
      config_id: CONFIG_ONE,
    };
    expect(JSON.stringify(params)).not.toContain(JUDGE_API_KEY);
    expect(JSON.stringify(params)).not.toContain(JUDGE_CIPHERTEXT);

    await runEvalWorkflow(env, params, new FakeStepRunner(), fetcher, FIXED_NOW);

    expect(calls[0].authorization).toBe(`Bearer ${JUDGE_API_KEY}`);
    expect(runRow(db).status).toBe("done");
    db.close();
  });

  it("exposes the Workflows entrypoint shape without importing cloudflare:workers", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedRun(db);
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    const env: EvalsEnv = { DB: sqliteDb(db) };

    const workflow = new EvalWorkflow({}, env);
    await workflow.run(
      { payload: { workspace_id: TOKEN_WORKSPACE, run_id: RUN_ONE, config_id: CONFIG_ONE } },
      new FakeStepRunner(),
    );
    expect(runRow(db).status).toBe("done");
    db.close();
  });
});

// =============================================================================
// the cron sweep
// =============================================================================

function workflowBinding(): { binding: EvalWorkflowLike; created: EvalRunParams[] } {
  const created: EvalRunParams[] = [];
  const binding: EvalWorkflowLike = {
    async create(options) {
      if (options?.params !== undefined) created.push(options.params);
      return { id: options?.id ?? "wf_instance" };
    },
  };
  return { binding, created };
}

describe("evalsScheduled", () => {
  it("starts only due, active, cron configs and stamps last_run_at", async () => {
    const db = migratedDatabase();
    // Due: never run.
    seedConfig(db, { id: CONFIG_ONE, trigger: "cron", sinceMinutes: 60, checks: ["traces_closed"] });
    // Not due: ran 10 minutes ago against a 60-minute window.
    seedConfig(db, {
      id: CONFIG_TWO,
      trigger: "cron",
      sinceMinutes: 60,
      checks: ["traces_closed"],
      lastRunAt: NOW_SECONDS - 600,
    });
    // Manual configs are never swept.
    seedConfig(db, {
      id: `evc_01J${"E".repeat(23)}`,
      trigger: "manual",
      checks: ["traces_closed"],
    });
    // Disabled cron configs are never swept.
    seedConfig(db, {
      id: `evc_01J${"F".repeat(23)}`,
      trigger: "cron",
      active: 0,
      checks: ["traces_closed"],
    });
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }]);
    const { binding, created } = workflowBinding();
    const env: EvalsEnv = { DB: sqliteDb(db), EVAL_WORKFLOW: binding };

    await evalsScheduled(env, neverCalled().fetcher, NOW_SECONDS);

    expect(created.length).toBe(1);
    expect(created[0].config_id).toBe(CONFIG_ONE);
    expect(created[0].workspace_id).toBe(TOKEN_WORKSPACE);
    expect(configRow(db, CONFIG_ONE).last_run_at).toBe(NOW_SECONDS);
    expect(configRow(db, CONFIG_TWO).last_run_at).toBe(NOW_SECONDS - 600);
    // Enqueued, not executed: no verdicts yet.
    expect(scoreEvents(db).length).toBe(0);
    const runs = db.prepare("SELECT * FROM eval_runs").all();
    expect(runs.length).toBe(1);
    db.close();
  });

  it("becomes due again once a full window has elapsed", async () => {
    const db = migratedDatabase();
    seedConfig(db, {
      trigger: "cron",
      sinceMinutes: 60,
      checks: ["traces_closed"],
      lastRunAt: NOW_SECONDS - 3600,
    });
    const { binding, created } = workflowBinding();
    await evalsScheduled({ DB: sqliteDb(db), EVAL_WORKFLOW: binding }, neverCalled().fetcher,
      NOW_SECONDS);
    expect(created.length).toBe(1);
    db.close();
  });

  it("executes inline when no Workflow binding exists", async () => {
    const db = migratedDatabase();
    seedConfig(db, { trigger: "cron", checks: ["traces_closed"] });
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }], {
      atSeconds: Math.floor(Date.now() / 1000) - 60,
    });
    const env: EvalsEnv = { DB: sqliteDb(db) };

    await evalsScheduled(env, neverCalled().fetcher, Math.floor(Date.now() / 1000));

    expect(scoreEvents(db).length).toBe(1);
    expect(payloadsOf(scoreEvents(db))[0].source).toBe(SOURCE_DETERMINISTIC);
    db.close();
  });

  it("isolates one failing config from the rest of the tick", async () => {
    const configs = [
      { id: CONFIG_ONE, workspace_id: TOKEN_WORKSPACE },
      { id: CONFIG_TWO, workspace_id: TOKEN_WORKSPACE },
    ].map((row) => ({
      ...row,
      name: "n",
      active: 1,
      trigger: "cron",
      target_filter: JSON.stringify({ kind: null, since_minutes: 60, workstream: null }),
      checks: JSON.stringify(["traces_closed"]),
      judge: null,
      created_at: NOW_SECONDS,
      last_run_at: null,
    }));
    let attempted = 0;
    const { db } = mockDb({
      all: (statement) => (statement.sql.includes("due-configs") ? configs : []),
      run: (statement) => {
        if (statement.sql.includes("insert-run")) {
          attempted += 1;
          if (attempted === 1) throw new Error("D1 unavailable");
        }
      },
      first: () => null,
    });

    await evalsScheduled({ DB: db }, neverCalled().fetcher, NOW_SECONDS);
    // Both configs were attempted; the first failure did not starve the second.
    expect(attempted).toBe(2);
  });
});

// =============================================================================
// validation + HTTP surface
// =============================================================================

describe("validateCreateConfigBody", () => {
  const valid = {
    name: "nightly",
    trigger: "manual",
    checks: ["tests_pass", "traces_closed"],
    target: { since_minutes: 30 },
  };

  it("accepts a minimal deterministic config and sorts + dedupes the checks", () => {
    const result = validateCreateConfigBody({
      ...valid,
      checks: ["traces_closed", "tests_pass", "traces_closed"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.checks).toEqual(["tests_pass", "traces_closed"]);
      expect(result.value.judge).toBeNull();
      expect(result.value.target).toEqual({
        workstream: null,
        kind: null,
        since_minutes: 30,
      });
    }
  });

  it("defaults the window and rejects an out-of-range one", () => {
    const defaulted = validateCreateConfigBody({ ...valid, target: undefined });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) expect(defaulted.value.target.since_minutes).toBe(60);
    expect(validateCreateConfigBody({ ...valid, target: { since_minutes: 0 } }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, target: { since_minutes: 10_081 } }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, target: { since_minutes: 1.5 } }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, target: [] }).ok).toBe(false);
  });

  it("refuses unknown checks, an empty check set and a bad trigger", () => {
    expect(validateCreateConfigBody({ ...valid, checks: ["no_such_check"] }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, checks: [] }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, checks: "traces_closed" }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, trigger: "hourly" }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, name: "" }).ok).toBe(false);
    expect(validateCreateConfigBody({ ...valid, name: "x".repeat(201) }).ok).toBe(false);
  });

  it("holds the judge to https, a slotted template and a credential", () => {
    const judge = {
      model: JUDGE_MODEL,
      base_url: JUDGE_BASE_URL,
      prompt_template: JUDGE_TEMPLATE,
      api_key: JUDGE_API_KEY,
    };
    expect(validateCreateConfigBody({ ...valid, judge }).ok).toBe(true);
    expect(
      validateCreateConfigBody({ ...valid, judge: { ...judge, base_url: "http://judge.local" } }).ok,
    ).toBe(false);
    expect(
      validateCreateConfigBody({ ...valid, judge: { ...judge, base_url: "https://127.0.0.1" } }).ok,
    ).toBe(false);
    expect(
      validateCreateConfigBody({ ...valid, judge: { ...judge, prompt_template: "grade it" } }).ok,
    ).toBe(false);
    expect(validateCreateConfigBody({ ...valid, judge: { ...judge, api_key: "" } }).ok).toBe(false);
    expect(
      validateCreateConfigBody({ ...valid, judge: { ...judge, include_bodies: "yes" } }).ok,
    ).toBe(false);
    // A trailing slash is normalized away, as the gateway does.
    const trailing = validateCreateConfigBody({
      ...valid,
      judge: { ...judge, base_url: "https://judge.example.com/v1/" },
    });
    expect(trailing.ok).toBe(true);
    if (trailing.ok) expect(trailing.value.judge?.base_url).toBe(JUDGE_BASE_URL);
  });

  it("round-trips the stored columns and rejects the unreadable ones", () => {
    expect(parseTargetFilter('{"since_minutes":60,"workstream":"ws_a","kind":null}')).toEqual({
      workstream: "ws_a",
      kind: null,
      since_minutes: 60,
    });
    expect(parseTargetFilter("{}")).toBeNull();
    expect(parseTargetFilter("not json")).toBeNull();
    expect(parseChecks('["traces_closed","nope"]')).toEqual(["traces_closed"]);
    expect(parseChecks('["nope"]')).toBeNull();
    expect(parseChecks("{}")).toBeNull();
    expect(parseJudge(null)).toBeNull();
    expect(parseJudge(JSON.stringify(judgeColumn()))?.model).toBe(JUDGE_MODEL);
    expect(parseJudge(JSON.stringify(judgeColumn({ prompt_template: "no slot" })))).toBeNull();
  });
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

function authedFirst(
  extra: (statement: RecordedStatement) => unknown | Promise<unknown> = () => null,
  deviceOverrides: Record<string, unknown> = {},
): (statement: RecordedStatement) => unknown | Promise<unknown> {
  return async (statement) => {
    if (statement.sql.includes("FROM devices")) return deviceRow(deviceOverrides);
    return extra(statement);
  };
}

/** sqlite for everything except the device lookup, which is faked. */
function sqliteDbWithDevice(db: DatabaseSync): D1DatabaseLike {
  const base = sqliteDb(db);
  return {
    prepare(sql: string): D1Statement {
      if (sql.includes("FROM devices")) {
        const bound: D1BoundStatement = {
          async first<T = unknown>() {
            return deviceRow() as T;
          },
          async all<T = unknown>() {
            return { results: [deviceRow()] as T[] };
          },
          async run<T = unknown>() {
            return { success: true } as { success: boolean; results?: T[] };
          },
        };
        return { bind: () => bound };
      }
      return base.prepare(sql);
    },
    batch: (statements) => base.batch(statements),
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

describe("routing", () => {
  it("declines paths it does not own and methods it does not serve", async () => {
    const { db } = mockDb();
    const env: EvalsEnv = { DB: db };
    expect(await handleEvalsRoute(request("/v1/workstreams"), env)).toBeNull();
    expect(await handleEvalsRoute(request("/v1/evals", { method: "DELETE" }), env)).toBeNull();
    expect(
      await handleEvalsRoute(request(`/v1/evals/${CONFIG_ONE}/run`, { method: "GET" }), env),
    ).toBeNull();
    expect(
      await handleEvalsRoute(request(`/v1/evals/${CONFIG_ONE}/runs`, { method: "POST" }), env),
    ).toBeNull();
    expect(
      await handleEvalsRoute(request(`/v1/evals/${CONFIG_ONE}/disable`, { method: "GET" }), env),
    ).toBeNull();
    // A malformed id is simply not this module's path.
    expect(await handleEvalsRoute(request("/v1/evals/evc_nope/run", { method: "POST" }), env))
      .toBeNull();
  });

  it("answers 401 without a token and 403 without the capability", async () => {
    const readOnly = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const created = await handleEvalsRoute(
      request("/v1/evals", { method: "POST", headers: authed(), body: "{}" }),
      { DB: readOnly.db },
    );
    expect(created?.status).toBe(403);

    const anonymous = mockDb({ first: () => null });
    const unauthorized = await handleEvalsRoute(request("/v1/evals", { method: "GET" }), {
      DB: anonymous.db,
    });
    expect(unauthorized?.status).toBe(401);
  });
});

describe("POST /v1/evals", () => {
  it("creates a deterministic config and echoes it back", async () => {
    const inserts: RecordedStatement[] = [];
    const { db } = mockDb({
      first: authedFirst(),
      run: (statement) => {
        inserts.push(statement);
      },
    });
    const response = await handleEvalsRoute(
      request("/v1/evals", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          name: "nightly",
          trigger: "cron",
          checks: ["traces_closed", "commands_ok"],
          target: { since_minutes: 120, workstream: "ws_alpha" },
        }),
      }),
      { DB: db },
    );
    expect(response?.status).toBe(201);
    const body = (await response?.json()) as { config: Record<string, unknown> };
    expect(String(body.config.id)).toMatch(/^evc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.config.active).toBe(true);
    expect(body.config.trigger).toBe("cron");
    expect(body.config.checks).toEqual(["commands_ok", "traces_closed"]);
    expect(body.config.judge).toBeNull();
    expect(inserts[0].sql).toContain("INSERT INTO eval_configs");
    expect(inserts[0].binds[1]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects a non-object body and an invalid field", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const notObject = await handleEvalsRoute(
      request("/v1/evals", { method: "POST", headers: authed(), body: "[]" }),
      { DB: db },
    );
    expect(notObject?.status).toBe(400);

    const badCheck = await handleEvalsRoute(
      request("/v1/evals", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ name: "n", trigger: "manual", checks: ["nope"] }),
      }),
      { DB: db },
    );
    expect(badCheck?.status).toBe(400);
  });

  it("fails closed with 503 when a judge is asked for and EVAL_SEALING_KEY is unset", async () => {
    const writes: RecordedStatement[] = [];
    const { db } = mockDb({
      first: authedFirst(),
      run: (statement) => {
        writes.push(statement);
      },
    });
    const response = await handleEvalsRoute(
      request("/v1/evals", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          name: "judged",
          trigger: "manual",
          checks: ["traces_closed"],
          judge: {
            model: JUDGE_MODEL,
            base_url: JUDGE_BASE_URL,
            prompt_template: JUDGE_TEMPLATE,
            api_key: JUDGE_API_KEY,
          },
        }),
      }),
      { DB: db },
    );
    expect(response?.status).toBe(503);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.code).toBe("sealing_key_unavailable");
    expect(body.local_capture_unaffected).toBe(true);
    // Nothing was written, so no raw credential can be sitting in D1.
    expect(writes.length).toBe(0);
  });

  it("seals the judge credential and never echoes it back", async () => {
    const inserts: RecordedStatement[] = [];
    const { db } = mockDb({
      first: authedFirst(),
      run: (statement) => {
        inserts.push(statement);
      },
    });
    const response = await handleEvalsRoute(
      request("/v1/evals", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          name: "judged",
          trigger: "manual",
          checks: ["traces_closed"],
          judge: {
            model: JUDGE_MODEL,
            base_url: JUDGE_BASE_URL,
            prompt_template: JUDGE_TEMPLATE,
            api_key: JUDGE_API_KEY,
            include_bodies: true,
          },
        }),
      }),
      { DB: db, EVAL_SEALING_KEY: SEALING_KEY },
    );
    expect(response?.status).toBe(201);
    const raw = await response!.text();
    expect(raw).not.toContain(JUDGE_API_KEY);
    const body = JSON.parse(raw) as { config: { judge: Record<string, unknown> } };
    expect(body.config.judge.model).toBe(JUDGE_MODEL);
    expect(body.config.judge.include_bodies).toBe(true);
    // A judge's output is a model's opinion; the label travels with the config.
    expect(body.config.judge.provenance).toBe("INFERRED");
    expect(Object.keys(body.config.judge)).not.toContain("api_key_ciphertext");

    const stored = String(inserts[0].binds[6]);
    expect(stored).not.toContain(JUDGE_API_KEY);
    const ciphertext = (JSON.parse(stored) as { api_key_ciphertext: string }).api_key_ciphertext;
    expect(await unsealUpstreamKey(ciphertext, SEALING_KEY)).toBe(JUDGE_API_KEY);
  });
});

describe("GET /v1/evals", () => {
  it("returns an envelope and a cursor when another page exists", async () => {
    const db = migratedDatabase();
    for (let index = 0; index < 3; index++) {
      seedConfig(db, {
        id: `evc_01J${String.fromCharCode(80 + index).repeat(23)}`,
        checks: ["traces_closed"],
        createdAt: NOW_SECONDS - index,
      });
    }
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };
    const response = await handleEvalsRoute(
      request("/v1/evals?limit=2", { headers: authed() }),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body.items.length).toBe(2);
    expect(body.next_cursor).not.toBeNull();

    const page = await handleEvalsRoute(
      request(`/v1/evals?limit=2&cursor=${body.next_cursor}`, { headers: authed() }),
      env,
    );
    const second = (await page?.json()) as { items: unknown[]; next_cursor: string | null };
    expect(second.items.length).toBe(1);
    expect(second.next_cursor).toBeNull();
    db.close();
  });

  it("rejects an invalid cursor", async () => {
    const db = migratedDatabase();
    const response = await handleEvalsRoute(
      request("/v1/evals?cursor=%%%", { headers: authed() }),
      { DB: sqliteDbWithDevice(db) },
    );
    expect(response?.status).toBe(400);
    db.close();
  });
});

describe("POST /v1/evals/{id}/run", () => {
  function liveSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  it("runs inline and settles when no Workflow binding exists", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }], {
      atSeconds: liveSeconds() - 120,
    });
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };

    const response = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      run: Record<string, unknown>;
      durability: string;
    };
    expect(body.durability).toBe("inline");
    expect(body.run.status).toBe("done");
    expect(body.run.traces_evaluated).toBe(1);
    expect(scoreEvents(db).length).toBe(1);
    // last_run_at moved at START, so the cron sweep will not re-enqueue.
    expect(configRow(db).last_run_at).not.toBeNull();
    db.close();
  });

  it("enqueues a Workflow instance instead of running inline when bound", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedTrace(db, "trc_alpha", [{ kind: "COMMAND", status: "ok" }], {
      atSeconds: liveSeconds() - 120,
    });
    const { binding, created } = workflowBinding();
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db), EVAL_WORKFLOW: binding };

    const response = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(response?.status).toBe(202);
    const body = (await response?.json()) as {
      run: Record<string, unknown>;
      durability: string;
      workflow_instance_id: string;
    };
    expect(body.durability).toBe("workflow");
    expect(body.run.status).toBe("running");
    expect(created.length).toBe(1);
    expect(created[0].run_id).toBe(body.workflow_instance_id);
    expect(scoreEvents(db).length).toBe(0);
    db.close();
  });

  it("404s a foreign or unknown config and 409s an inactive one", async () => {
    const db = migratedDatabase();
    seedConfig(db, { id: CONFIG_TWO, workspaceId: OTHER_WORKSPACE, checks: ["traces_closed"] });
    seedConfig(db, { id: CONFIG_ONE, active: 0, checks: ["traces_closed"] });
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };

    const foreign = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_TWO}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(foreign?.status).toBe(404);

    const inactive = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(inactive?.status).toBe(409);
    db.close();
  });

  it("fails closed with 503 when the config needs a judge and the secret is unset", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"], judge: judgeColumn() });
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };
    const response = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(response?.status).toBe(503);
    expect(((await response?.json()) as Record<string, unknown>).code).toBe(
      "sealing_key_unavailable",
    );
    // No run row was created, so nothing is left half-graded.
    expect(db.prepare("SELECT COUNT(*) AS n FROM eval_runs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("refuses an over-wide window with 413 and actionable guidance", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    const at = liveSeconds() - 120;
    for (let index = 0; index <= MAX_TRACES_PER_RUN; index++) {
      seedTrace(db, `trc_${String(index).padStart(4, "0")}`, [{ kind: "COMMAND", status: "ok" }], {
        atSeconds: at,
      });
    }
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };

    const response = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/run`, { method: "POST", headers: authed() }),
      env,
      neverCalled().fetcher,
    );
    expect(response?.status).toBe(413);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.code).toBe("too_many_targets");
    expect(body.max_traces_per_run).toBe(MAX_TRACES_PER_RUN);
    expect(String(body.guidance)).toContain("since_minutes");
    expect(db.prepare("SELECT COUNT(*) AS n FROM eval_runs").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("GET /v1/evals/{id}/runs", () => {
  it("lists a config's runs newest first and 404s a foreign config", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedRun(db, { id: RUN_ONE, startedAt: NOW_SECONDS });
    seedRun(db, { id: RUN_TWO, startedAt: NOW_SECONDS + 10 });
    seedConfig(db, { id: CONFIG_TWO, workspaceId: OTHER_WORKSPACE, checks: ["traces_closed"] });
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };

    const response = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/runs`, { headers: authed() }),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((item) => item.id)).toEqual([RUN_TWO, RUN_ONE]);
    expect(body.items[0].status).toBe("running");

    const foreign = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_TWO}/runs`, { headers: authed() }),
      env,
    );
    expect(foreign?.status).toBe(404);
    db.close();
  });
});

describe("POST /v1/evals/{id}/disable", () => {
  it("disables a config idempotently and 404s a foreign one", async () => {
    const db = migratedDatabase();
    seedConfig(db, { checks: ["traces_closed"] });
    seedConfig(db, { id: CONFIG_TWO, workspaceId: OTHER_WORKSPACE, checks: ["traces_closed"] });
    const env: EvalsEnv = { DB: sqliteDbWithDevice(db) };

    const first = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/disable`, { method: "POST", headers: authed() }),
      env,
    );
    expect(first?.status).toBe(200);
    expect(((await first?.json()) as { config: { active: boolean } }).config.active).toBe(false);
    expect(configRow(db).active).toBe(0);

    // Idempotent: disabling twice is a no-op, not a conflict, and never trips
    // the terminal-disable trigger.
    const again = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_ONE}/disable`, { method: "POST", headers: authed() }),
      env,
    );
    expect(again?.status).toBe(200);

    const foreign = await handleEvalsRoute(
      request(`/v1/evals/${CONFIG_TWO}/disable`, { method: "POST", headers: authed() }),
      env,
    );
    expect(foreign?.status).toBe(404);
    db.close();
  });
});
