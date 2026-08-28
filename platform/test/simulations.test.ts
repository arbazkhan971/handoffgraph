// Unit tests for src/simulations.ts (parity row 31).
//
// Coverage map:
//   * migration 0015 truth — CHECK constraints, triggers and the json_extract
//     expression index, applied for real with node:sqlite (migrations 0001..0015);
//   * the turn loop against the real schema — max_turns termination, DONE-token
//     termination, and the empty-DONE case that records nothing;
//   * fail-closed judging — unparseable output settles the run as `error` with
//     no verdict, no score and no simulation.completed event;
//   * the provenance split, asserted explicitly on the stored rows: turn events
//     OBSERVED, the completion event INFERRED, with per-field labels;
//   * deterministic ids — replaying a settled run appends zero events;
//   * crash-then-resume through a structural fake step runner, proving only the
//     remaining exchanges re-run;
//   * transcript reconstruction order and malformed-row tolerance;
//   * the HTTP surface over the mockDb fake: auth, capability, validation,
//     foreign-workspace 404s, method fallthrough, and workflow dispatch
//     (including that the credential handed to the binding is sealed).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1Statement } from "../src/db";
import { unsealUpstreamKey } from "../src/gateway";
import {
  DEFAULT_BASE_URL,
  DONE_TOKEN,
  EVENT_KIND_COMPLETED,
  EVENT_KIND_TURN,
  MAX_TURNS_CEILING,
  buildCompletedEvent,
  buildTranscript,
  buildTurnEvent,
  callChatModel,
  canonicalScore,
  completedEventID,
  executeSimulationRun,
  extractCompletionContent,
  handleSimulationsRoute,
  inlineStepRunner,
  judgePrompt,
  parseJudgeVerdict,
  runSimulationWorkflow,
  turnEventID,
  userSimulatorPrompt,
  validateCreateScenarioBody,
  validateStartRunBody,
  type ChatMessage,
  type FetchLike,
  type RunRow,
  type ScenarioRow,
  type SimulationRunParams,
  type SimulationWorkflowLike,
  type SimulationsEnv,
  type WorkflowStepLike,
} from "../src/simulations";

// -- fake D1 (mockDb pattern; see test/ingest.test.ts, test/alerts.test.ts) --------

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

// -- real-SQL adapter: D1DatabaseLike over node:sqlite -------------------------------
// The loop's writes are the load-bearing part of this slice (append-only spine,
// terminal run state, monotone turns), so they run against the real schema
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
const THIS_MIGRATION = "0015_simulations.sql";
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

// -- fixtures --------------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const DEVICE_TOKEN = "dev_test-token-simulations";
const DEVICE_ID = `dev_01HTSTDEV${"0".repeat(16)}Z`;
const SIM_ONE = `sim_01J${"A".repeat(23)}`;
const SIM_TWO = `sim_01J${"B".repeat(23)}`;
const RUN_ONE = `smr_01J${"C".repeat(23)}`;
const RUN_TWO = `smr_01J${"D".repeat(23)}`;

/** 2023-11-14T22:13:20Z. */
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const USER_MODEL = "sim-user-1";
const ASSISTANT_MODEL = "target-assistant-1";
const JUDGE_MODEL = "judge-1";

let TOKEN_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
});

function scenarioRow(overrides: Partial<ScenarioRow> = {}): ScenarioRow {
  return {
    id: SIM_ONE,
    workspace_id: TOKEN_WORKSPACE,
    name: "Refund request",
    persona: "A frustrated customer whose order arrived broken.",
    goal: "Obtain a full refund without escalating to a human.",
    success_criteria: "The assistant offers a refund and states the timeline.",
    max_turns: 3,
    created_at: NOW_SECONDS - 1000,
    active: 1,
    ...overrides,
  };
}

function seedScenario(db: DatabaseSync, overrides: Partial<ScenarioRow> = {}): ScenarioRow {
  const row = scenarioRow(overrides);
  db.prepare(`
    INSERT INTO simulation_scenarios
      (id, workspace_id, name, persona, goal, success_criteria, max_turns, created_at, active)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).run(
    row.id,
    row.workspace_id,
    row.name,
    row.persona,
    row.goal,
    row.success_criteria,
    row.max_turns,
    row.created_at,
    row.active,
  );
  return row;
}

function seedRun(db: DatabaseSync, overrides: Partial<RunRow> = {}): RunRow {
  const row: RunRow = {
    id: RUN_ONE,
    workspace_id: TOKEN_WORKSPACE,
    scenario_id: SIM_ONE,
    status: "running",
    turns_taken: 0,
    verdict: null,
    judge_score: null,
    started_at: NOW_SECONDS,
    completed_at: null,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO simulation_runs
      (id, workspace_id, scenario_id, status, turns_taken, started_at)
    VALUES (?1, ?2, ?3, 'running', ?4, ?5)
  `).run(row.id, row.workspace_id, row.scenario_id, row.turns_taken, row.started_at);
  return row;
}

function execution(overrides: Partial<Parameters<typeof executeSimulationRun>[1]> = {}) {
  return {
    workspaceId: TOKEN_WORKSPACE,
    runId: RUN_ONE,
    apiKey: "sk-upstream-secret",
    baseUrl: DEFAULT_BASE_URL,
    userModel: USER_MODEL,
    assistantModel: ASSISTANT_MODEL,
    judgeModel: JUDGE_MODEL,
    assistantSystem: null,
    deadlineAtMs: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

// -- scripted upstream ------------------------------------------------------------------

interface UpstreamCall {
  url: string;
  model: string;
  messages: ChatMessage[];
  authorization: string;
}

function completionBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

/**
 * A scripted OpenAI-compatible upstream. `reply` is keyed on the model name and
 * the per-model call index, which is exactly how the three roles are told apart
 * — the loop calls one endpoint with three different models.
 */
function scriptedFetch(
  reply: (model: string, index: number, messages: ChatMessage[]) => string | Response,
): { fetcher: FetchLike; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const counters = new Map<string, number>();
  const fetcher: FetchLike = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: ChatMessage[];
    };
    const model = body.model ?? "";
    const index = counters.get(model) ?? 0;
    counters.set(model, index + 1);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      model,
      messages: body.messages ?? [],
      authorization: headers.authorization ?? "",
    });
    const outcome = reply(model, index, body.messages ?? []);
    if (outcome instanceof Response) return outcome;
    return new Response(completionBody(outcome), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const PASSING_JUDGEMENT = JSON.stringify({
  verdict: "pass",
  score: "0.875",
  reason: "The assistant offered a refund and gave a timeline.",
});

/** The happy path: the simulator never stops early, the judge passes. */
function happyScript(): (model: string, index: number) => string {
  return (model, index) => {
    if (model === USER_MODEL) return `user message ${index}`;
    if (model === ASSISTANT_MODEL) return `assistant reply ${index}`;
    return PASSING_JUDGEMENT;
  };
}

function eventRows(db: DatabaseSync): {
  event_id: string;
  kind: string;
  provenance: string;
  content_hash: string;
  occurred_at: string;
  ingested_at: number;
  raw_json: string;
}[] {
  return db
    .prepare(
      "SELECT event_id, kind, provenance, content_hash, occurred_at, ingested_at, raw_json " +
        "FROM events ORDER BY seq",
    )
    .all() as never;
}

function runRow(db: DatabaseSync, id = RUN_ONE): RunRow {
  return db.prepare("SELECT * FROM simulation_runs WHERE id = ?1").get(id) as never;
}

// -- migration truth ---------------------------------------------------------------------

describe("migration 0015 (node:sqlite)", () => {
  it("applies on top of every earlier migration and creates both tables", () => {
    const db = migratedDatabase();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("simulation_scenarios");
    expect(names).toContain("simulation_runs");
    db.close();
  });

  it("caps max_turns at the schema ceiling", () => {
    const db = migratedDatabase();
    expect(() => seedScenario(db, { max_turns: MAX_TURNS_CEILING + 1 })).toThrow(/CHECK/);
    expect(() => seedScenario(db, { max_turns: 0 })).toThrow(/CHECK/);
    db.close();
  });

  it("rejects a scenario id that is not a sim_<ulid>", () => {
    const db = migratedDatabase();
    expect(() => seedScenario(db, { id: "sim_not-a-ulid" })).toThrow(/CHECK/);
    db.close();
  });

  it("refuses a verdict on a run that is not done", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    expect(() =>
      db
        .prepare(
          "UPDATE simulation_runs SET status='error', verdict='pass', completed_at=?2 WHERE id=?1",
        )
        .run(RUN_ONE, NOW_SECONDS + 1),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("refuses a score on a run that is not done", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    expect(() =>
      db
        .prepare(
          "UPDATE simulation_runs SET status='error', judge_score='0.5', completed_at=?2 WHERE id=?1",
        )
        .run(RUN_ONE, NOW_SECONDS + 1),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("keeps status and completed_at in agreement", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    // 'done' without a completion instant is not a state this schema admits.
    expect(() =>
      db.prepare("UPDATE simulation_runs SET status='done' WHERE id=?1").run(RUN_ONE),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("rejects a non-decimal judge_score", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    expect(() =>
      db
        .prepare(
          "UPDATE simulation_runs SET status='done', judge_score='0.5e1', completed_at=?2 WHERE id=?1",
        )
        .run(RUN_ONE, NOW_SECONDS + 1),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("makes a settled status terminal", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    db.prepare(
      "UPDATE simulation_runs SET status='done', verdict='pass', judge_score='1', completed_at=?2 WHERE id=?1",
    ).run(RUN_ONE, NOW_SECONDS + 5);
    expect(() =>
      db.prepare("UPDATE simulation_runs SET status='error' WHERE id=?1").run(RUN_ONE),
    ).toThrow(/terminal/);
    db.close();
  });

  it("writes completed_at exactly once", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    db.prepare(
      "UPDATE simulation_runs SET status='done', verdict='pass', judge_score='1', completed_at=?2 WHERE id=?1",
    ).run(RUN_ONE, NOW_SECONDS + 5);
    expect(() =>
      db.prepare("UPDATE simulation_runs SET completed_at=?2 WHERE id=?1").run(RUN_ONE, NOW_SECONDS + 9),
    ).toThrow(/write-once/);
    db.close();
  });

  it("refuses a turn-count regression", () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    db.prepare("UPDATE simulation_runs SET turns_taken=3 WHERE id=?1").run(RUN_ONE);
    expect(() =>
      db.prepare("UPDATE simulation_runs SET turns_taken=2 WHERE id=?1").run(RUN_ONE),
    ).toThrow(/regressed/);
    db.close();
  });

  it("refuses to edit a scenario definition and to re-activate one", () => {
    const db = migratedDatabase();
    seedScenario(db);
    expect(() =>
      db.prepare("UPDATE simulation_scenarios SET success_criteria='other' WHERE id=?1").run(SIM_ONE),
    ).toThrow(/immutable/);
    db.prepare("UPDATE simulation_scenarios SET active=0 WHERE id=?1").run(SIM_ONE);
    expect(() =>
      db.prepare("UPDATE simulation_scenarios SET active=1 WHERE id=?1").run(SIM_ONE),
    ).toThrow(/terminal/);
    db.close();
  });

  it("prunes the transcript read with the json_extract expression index", () => {
    const db = migratedDatabase();
    db.prepare(
      "INSERT INTO events (workspace_id, event_id, occurred_at, kind, ingested_at, raw_json) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run(
      TOKEN_WORKSPACE,
      `evt_${"0".repeat(26)}`,
      "2023-11-14T22:13:20.000Z",
      EVENT_KIND_TURN,
      NOW_SECONDS,
      JSON.stringify({ payload: { run_id: RUN_ONE } }),
    );
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT event_id FROM events WHERE workspace_id = ?1 " +
          "AND kind IN ('simulation.turn.completed', 'simulation.completed') " +
          "AND json_extract(raw_json, '$.payload.run_id') = ?2 ORDER BY seq",
      )
      .all(TOKEN_WORKSPACE, RUN_ONE)
      .map((row) => (row as { detail: string }).detail)
      .join(" ");
    expect(plan).toContain("idx_events_simulation_run");
    expect(plan).not.toContain("SCAN events");
    db.close();
  });
});

// -- judge parsing ------------------------------------------------------------------------

describe("parseJudgeVerdict", () => {
  it("accepts a bare JSON object", () => {
    expect(parseJudgeVerdict(PASSING_JUDGEMENT)).toEqual({
      verdict: "pass",
      score: "0.875",
      reason: "The assistant offered a refund and gave a timeline.",
    });
  });

  it("tolerates exactly one surrounding markdown fence", () => {
    const fenced = "```json\n" + PASSING_JUDGEMENT + "\n```";
    expect(parseJudgeVerdict(fenced)?.verdict).toBe("pass");
    expect(parseJudgeVerdict("```\n" + PASSING_JUDGEMENT + "\n```")?.score).toBe("0.875");
  });

  it("accepts a JSON number score only in canonical decimal form", () => {
    expect(parseJudgeVerdict('{"verdict":"fail","score":0.5}')?.score).toBe("0.5");
    expect(parseJudgeVerdict('{"verdict":"fail","score":1}')?.score).toBe("1");
    // 1e-7 stringifies to exponent notation, which we will not reinterpret.
    expect(parseJudgeVerdict('{"verdict":"fail","score":1e-7}')).toBeNull();
  });

  it("bounds the score to [0, 1]", () => {
    expect(parseJudgeVerdict('{"verdict":"pass","score":"1.0000001"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"pass","score":"1.000000"}')?.score).toBe("1.000000");
    expect(parseJudgeVerdict('{"verdict":"pass","score":"0"}')?.score).toBe("0");
  });

  it("fails closed on anything that is not an unambiguous verdict", () => {
    expect(parseJudgeVerdict("not json at all")).toBeNull();
    expect(parseJudgeVerdict("[]")).toBeNull();
    expect(parseJudgeVerdict("null")).toBeNull();
    expect(parseJudgeVerdict('{"score":"0.5"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"PASS","score":"0.5"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"maybe","score":"0.5"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"pass"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"pass","score":"-0.5"}')).toBeNull();
    expect(parseJudgeVerdict('Here is my answer: {"verdict":"pass","score":"1"}')).toBeNull();
  });

  it("treats a missing reason as empty and truncates a long one", () => {
    expect(parseJudgeVerdict('{"verdict":"fail","score":"0"}')?.reason).toBe("");
    const long = JSON.stringify({ verdict: "fail", score: "0", reason: "x".repeat(900) });
    expect(parseJudgeVerdict(long)?.reason.length).toBe(500);
  });
});

describe("canonicalScore", () => {
  it("rejects non-decimal shapes outright", () => {
    expect(canonicalScore(undefined)).toBeNull();
    expect(canonicalScore(null)).toBeNull();
    expect(canonicalScore("")).toBeNull();
    expect(canonicalScore("abc")).toBeNull();
    expect(canonicalScore(Number.NaN)).toBeNull();
    expect(canonicalScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(canonicalScore(true)).toBeNull();
  });

  it("compares exactly, without floats", () => {
    expect(canonicalScore("0.30000000000000004")).toBe("0.30000000000000004");
    expect(canonicalScore("1.0")).toBe("1.0");
    expect(canonicalScore("1.1")).toBeNull();
  });
});

describe("extractCompletionContent", () => {
  it("reads choices[0].message.content and nothing else", () => {
    expect(extractCompletionContent({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractCompletionContent({ choices: [] })).toBeNull();
    expect(extractCompletionContent({ choices: [{ message: {} }] })).toBeNull();
    expect(extractCompletionContent({ choices: [{ message: { content: "" } }] })).toBeNull();
    expect(extractCompletionContent({ choices: [{}] })).toBeNull();
    expect(extractCompletionContent({})).toBeNull();
    expect(extractCompletionContent(null)).toBeNull();
    expect(extractCompletionContent("nope")).toBeNull();
  });
});

// -- the upstream caller -------------------------------------------------------------------

describe("callChatModel", () => {
  it("sends only the allow-listed headers and the BYO credential", async () => {
    const { fetcher, calls } = scriptedFetch(() => "ok");
    const result = await callChatModel(fetcher, DEFAULT_BASE_URL, "sk-secret", "m1", [
      { role: "user", content: "hello" },
    ]);
    expect(result).toEqual({ ok: true, content: "ok" });
    expect(calls[0].url).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
    expect(calls[0].authorization).toBe("Bearer sk-secret");
  });

  it("classifies every failure without throwing", async () => {
    const failing: FetchLike = async () => new Response("{}", { status: 500 });
    expect(await callChatModel(failing, DEFAULT_BASE_URL, "k", "m", [])).toEqual({
      ok: false,
      reason: "upstream_error",
    });

    const throwing: FetchLike = async () => {
      throw new Error("connection reset");
    };
    expect(await callChatModel(throwing, DEFAULT_BASE_URL, "k", "m", [])).toEqual({
      ok: false,
      reason: "upstream_unavailable",
    });

    const garbage: FetchLike = async () => new Response("not json", { status: 200 });
    expect(await callChatModel(garbage, DEFAULT_BASE_URL, "k", "m", [])).toEqual({
      ok: false,
      reason: "unparseable_response",
    });

    const empty: FetchLike = async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 });
    expect(await callChatModel(empty, DEFAULT_BASE_URL, "k", "m", [])).toEqual({
      ok: false,
      reason: "unparseable_response",
    });
  });
});

// -- event documents ------------------------------------------------------------------------

describe("event documents", () => {
  it("mints turn ids as a pure function of (run, index, role, start)", async () => {
    const a = await turnEventID(RUN_ONE, 2, "user", NOW_MS);
    const b = await turnEventID(RUN_ONE, 2, "user", NOW_MS);
    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await turnEventID(RUN_ONE, 2, "assistant", NOW_MS)).not.toBe(a);
    expect(await turnEventID(RUN_ONE, 3, "user", NOW_MS)).not.toBe(a);
    expect(await turnEventID(RUN_TWO, 2, "user", NOW_MS)).not.toBe(a);
    expect(await completedEventID(RUN_ONE, NOW_MS)).not.toBe(a);
  });

  it("labels a turn event OBSERVED and carries no wall clock", async () => {
    const event = await buildTurnEvent({
      runId: RUN_ONE,
      scenarioId: SIM_ONE,
      role: "assistant",
      turnIndex: 1,
      contentHash: `sha256:${"a".repeat(64)}`,
      model: ASSISTANT_MODEL,
      startedAtMs: NOW_MS,
    });
    expect(event.provenance).toBe("OBSERVED");
    expect(event.kind).toBe(EVENT_KIND_TURN);
    const document = JSON.parse(event.rawJson) as Record<string, unknown>;
    expect(document.provenance).toBe("OBSERVED");
    expect(document.occurred_at).toBe(new Date(NOW_MS).toISOString());
    expect(document.observed_at).toBe(document.occurred_at);
    const payload = document.payload as Record<string, unknown>;
    expect(payload).toEqual({
      content_hash: `sha256:${"a".repeat(64)}`,
      model: ASSISTANT_MODEL,
      role: "assistant",
      run_id: RUN_ONE,
      scenario_id: SIM_ONE,
      turn_index: 1,
    });
    // Byte-identical on a rebuild: this is what makes replay idempotent.
    const again = await buildTurnEvent({
      runId: RUN_ONE,
      scenarioId: SIM_ONE,
      role: "assistant",
      turnIndex: 1,
      contentHash: `sha256:${"a".repeat(64)}`,
      model: ASSISTANT_MODEL,
      startedAtMs: NOW_MS,
    });
    expect(again.rawJson).toBe(event.rawJson);
  });

  it("labels the completion event INFERRED and the turn count OBSERVED", async () => {
    const event = await buildCompletedEvent({
      runId: RUN_ONE,
      scenarioId: SIM_ONE,
      verdict: "pass",
      judgeScore: "0.875",
      judgeModel: JUDGE_MODEL,
      reasonHash: `sha256:${"b".repeat(64)}`,
      turnsTaken: 3,
      startedAtMs: NOW_MS,
    });
    expect(event.provenance).toBe("INFERRED");
    const document = JSON.parse(event.rawJson) as Record<string, unknown>;
    expect(document.provenance).toBe("INFERRED");
    const payload = document.payload as Record<string, unknown>;
    expect(payload.verdict_provenance).toBe("INFERRED");
    expect(payload.score_provenance).toBe("INFERRED");
    expect(payload.turns_provenance).toBe("OBSERVED");
    expect(payload.turns_taken).toBe(3);
    expect(payload.judge_score).toBe("0.875");
  });
});

// -- prompts ----------------------------------------------------------------------------------

describe("prompts", () => {
  it("tells the simulator to emit only the user side and how to stop", () => {
    const prompt = userSimulatorPrompt(scenarioRow());
    expect(prompt).toContain("A frustrated customer");
    expect(prompt).toContain("Obtain a full refund");
    expect(prompt).toContain(DONE_TOKEN);
    expect(prompt).toContain("Never write the assistant's reply");
  });

  it("hands the judge the criteria and a numbered transcript", () => {
    const prompt = judgePrompt(scenarioRow(), [
      { role: "user", content: "my order broke" },
      { role: "assistant", content: "here is a refund" },
    ]);
    expect(prompt).toContain("The assistant offers a refund");
    expect(prompt).toContain("1. user: my order broke");
    expect(prompt).toContain("2. assistant: here is a refund");
    expect(prompt).toContain('{"verdict"');
  });
});

// -- the loop, against the real schema ----------------------------------------------------------

describe("executeSimulationRun (real schema)", () => {
  function setup(overrides: Partial<ScenarioRow> = {}) {
    const db = migratedDatabase();
    seedScenario(db, overrides);
    seedRun(db);
    return { db, env: { DB: sqliteDb(db) } satisfies SimulationsEnv };
  }

  it("runs exactly max_turns exchanges and settles with the judge's verdict", async () => {
    const { db, env } = setup({ max_turns: 3 });
    const { fetcher, calls } = scriptedFetch(happyScript());

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    // 3 exchanges x (user + assistant) + 1 judge call.
    expect(calls.length).toBe(7);
    expect(calls.filter((call) => call.model === JUDGE_MODEL).length).toBe(1);
    expect(settled?.status).toBe("done");
    expect(settled?.turns_taken).toBe(3);
    expect(settled?.verdict).toBe("pass");
    expect(settled?.judge_score).toBe("0.875");
    expect(settled?.completed_at).not.toBeNull();

    const rows = eventRows(db);
    expect(rows.filter((row) => row.kind === EVENT_KIND_TURN).length).toBe(6);
    expect(rows.filter((row) => row.kind === EVENT_KIND_COMPLETED).length).toBe(1);
    db.close();
  });

  it("stops as soon as the simulator emits the DONE token", async () => {
    const { db, env } = setup({ max_turns: 6 });
    const { fetcher, calls } = scriptedFetch((model, index) => {
      if (model === USER_MODEL) {
        return index === 1 ? `thanks, all sorted ${DONE_TOKEN}` : `user message ${index}`;
      }
      if (model === ASSISTANT_MODEL) return `assistant reply ${index}`;
      return PASSING_JUDGEMENT;
    });

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    // Exchange 0 is a full pair; exchange 1 stops after the user turn.
    expect(calls.filter((call) => call.model === USER_MODEL).length).toBe(2);
    expect(calls.filter((call) => call.model === ASSISTANT_MODEL).length).toBe(1);
    expect(settled?.turns_taken).toBe(2);
    expect(settled?.status).toBe("done");

    const rows = eventRows(db);
    const turns = rows.filter((row) => row.kind === EVENT_KIND_TURN);
    expect(turns.length).toBe(3);
    // The DONE token itself is stripped before hashing: what was recorded is
    // the message the assistant would have seen.
    const last = JSON.parse(turns[2].raw_json) as { payload: Record<string, unknown> };
    expect(last.payload.role).toBe("user");
    expect(last.payload.content_hash).toBe(`sha256:${await sha256Hex("thanks, all sorted")}`);
    db.close();
  });

  it("records nothing for an exchange whose simulator stopped without a message", async () => {
    const { db, env } = setup({ max_turns: 4 });
    const { fetcher } = scriptedFetch((model, index) => {
      if (model === USER_MODEL) return index === 1 ? DONE_TOKEN : `user message ${index}`;
      if (model === ASSISTANT_MODEL) return `assistant reply ${index}`;
      return PASSING_JUDGEMENT;
    });

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    expect(settled?.turns_taken).toBe(1);
    expect(eventRows(db).filter((row) => row.kind === EVENT_KIND_TURN).length).toBe(2);
    db.close();
  });

  it("settles as error with no verdict when the judge output cannot be parsed", async () => {
    const { db, env } = setup({ max_turns: 2 });
    const { fetcher } = scriptedFetch((model, index) => {
      if (model === USER_MODEL) return `user message ${index}`;
      if (model === ASSISTANT_MODEL) return `assistant reply ${index}`;
      return "Sure! Overall I would say this was a pass.";
    });

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    expect(settled?.status).toBe("error");
    expect(settled?.verdict).toBeNull();
    expect(settled?.judge_score).toBeNull();
    expect(settled?.completed_at).not.toBeNull();
    // The turns that really happened stay on the spine; the verdict never does.
    const rows = eventRows(db);
    expect(rows.filter((row) => row.kind === EVENT_KIND_TURN).length).toBe(4);
    expect(rows.filter((row) => row.kind === EVENT_KIND_COMPLETED).length).toBe(0);
    db.close();
  });

  it("settles as error when the judge call itself fails", async () => {
    const { db, env } = setup({ max_turns: 1 });
    const { fetcher } = scriptedFetch((model, index) => {
      if (model === JUDGE_MODEL) return new Response("{}", { status: 503 });
      return model === USER_MODEL ? `user ${index}` : `assistant ${index}`;
    });

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);
    expect(settled?.status).toBe("error");
    expect(settled?.verdict).toBeNull();
    expect(eventRows(db).filter((row) => row.kind === EVENT_KIND_COMPLETED).length).toBe(0);
    db.close();
  });

  it("settles as error when the very first simulator call fails", async () => {
    const { db, env } = setup();
    const { fetcher, calls } = scriptedFetch(() => new Response("{}", { status: 500 }));

    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);
    expect(settled?.status).toBe("error");
    expect(settled?.turns_taken).toBe(0);
    expect(calls.length).toBe(1);
    expect(eventRows(db).length).toBe(0);
    db.close();
  });

  it("splits provenance across the two event kinds, on the stored rows", async () => {
    const { db, env } = setup({ max_turns: 2 });
    const { fetcher } = scriptedFetch(happyScript());

    await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    const rows = eventRows(db);
    const turns = rows.filter((row) => row.kind === EVENT_KIND_TURN);
    const completed = rows.filter((row) => row.kind === EVENT_KIND_COMPLETED);

    // OBSERVED: the platform watched each exchange happen.
    expect(turns.length).toBe(4);
    expect(turns.every((row) => row.provenance === "OBSERVED")).toBe(true);
    for (const row of turns) {
      const document = JSON.parse(row.raw_json) as Record<string, unknown>;
      expect(document.provenance).toBe("OBSERVED");
      expect(document.provider).toBe("simulation");
    }

    // INFERRED: the headline claim is a model's opinion.
    expect(completed.length).toBe(1);
    expect(completed[0].provenance).toBe("INFERRED");
    const document = JSON.parse(completed[0].raw_json) as { payload: Record<string, unknown> };
    expect(document.payload.verdict_provenance).toBe("INFERRED");
    expect(document.payload.score_provenance).toBe("INFERRED");
    // ...but the count of turns is a fact this Worker measured.
    expect(document.payload.turns_provenance).toBe("OBSERVED");
    expect(document.payload.turns_taken).toBe(2);
    db.close();
  });

  it("never stores prompt or reply text, only digests", async () => {
    const { db, env } = setup({ max_turns: 2 });
    const { fetcher } = scriptedFetch(happyScript());
    await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);

    const spine = eventRows(db).map((row) => row.raw_json).join("\n");
    expect(spine).not.toContain("user message");
    expect(spine).not.toContain("assistant reply");
    expect(spine).not.toContain("The assistant offered a refund");
    expect(spine).toContain("sha256:");
    db.close();
  });

  it("adds zero events when a settled run is replayed", async () => {
    const { db, env } = setup({ max_turns: 3 });
    const { fetcher } = scriptedFetch(happyScript());

    await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);
    const first = eventRows(db);
    const firstRun = runRow(db);
    expect(first.length).toBe(7);

    // A byte-identical re-execution. Deterministic ids mean every INSERT OR
    // IGNORE lands on the row that is already there, and the settlement is
    // guarded on completed_at IS NULL.
    const replayFetch = scriptedFetch(happyScript());
    const replayed = await executeSimulationRun(
      env,
      execution(),
      inlineStepRunner(),
      replayFetch.fetcher,
    );

    // The replay really did run the whole loop again — the zero-growth below is
    // a property of the ids, not of an early return.
    expect(replayFetch.calls.length).toBe(7);
    const second = eventRows(db);
    expect(second.length).toBe(7);
    expect(second.map((row) => row.event_id)).toEqual(first.map((row) => row.event_id));
    expect(second.map((row) => row.raw_json)).toEqual(first.map((row) => row.raw_json));
    expect(replayed?.completed_at).toBe(firstRun.completed_at);
    expect(replayed?.verdict).toBe("pass");
    db.close();
  });

  it("keeps the original evidence when a re-execution answers differently", async () => {
    const { db, env } = setup({ max_turns: 1 });
    await executeSimulationRun(
      env,
      execution(),
      inlineStepRunner(),
      scriptedFetch(happyScript()).fetcher,
    );
    const first = eventRows(db);
    expect(first.length).toBe(3);

    // Same run id, different model output. Reusing an event id for different
    // bytes is exactly what the spine's payload-conflict trigger exists to
    // refuse; the run must absorb that, not crash on it.
    const divergent = scriptedFetch((model, index) => {
      if (model === USER_MODEL) return `DIFFERENT user message ${index}`;
      if (model === ASSISTANT_MODEL) return `DIFFERENT assistant reply ${index}`;
      return JSON.stringify({ verdict: "fail", score: "0", reason: "different" });
    });
    const replayed = await executeSimulationRun(env, execution(), inlineStepRunner(), divergent.fetcher);

    const second = eventRows(db);
    expect(second.map((row) => row.raw_json)).toEqual(first.map((row) => row.raw_json));
    // The first settlement stands: a verdict is written once.
    expect(replayed?.verdict).toBe("pass");
    expect(replayed?.status).toBe("done");
    db.close();
  });

  it("stops at the inline deadline without truncating an exchange", async () => {
    const { db, env } = setup({ max_turns: 6 });
    const { fetcher, calls } = scriptedFetch(happyScript());
    let clock = NOW_MS;
    // Advance past the deadline while the second exchange is being set up.
    const now = () => {
      clock += 5_000;
      return clock;
    };

    const settled = await executeSimulationRun(
      env,
      execution({ deadlineAtMs: NOW_MS + 12_000 }),
      inlineStepRunner(),
      fetcher,
      now,
    );

    expect(settled?.status).toBe("done");
    expect(settled?.turns_taken).toBeLessThan(6);
    // Whatever it managed, it managed in whole exchanges.
    const turns = eventRows(db).filter((row) => row.kind === EVENT_KIND_TURN);
    expect(turns.length % 2).toBe(0);
    expect(calls.filter((call) => call.model === JUDGE_MODEL).length).toBe(1);
    db.close();
  });

  it("returns null for a run in another workspace", async () => {
    const { db, env } = setup();
    const { fetcher, calls } = scriptedFetch(happyScript());
    const settled = await executeSimulationRun(
      env,
      execution({ workspaceId: OTHER_WORKSPACE }),
      inlineStepRunner(),
      fetcher,
    );
    expect(settled).toBeNull();
    expect(calls.length).toBe(0);
    db.close();
  });

  it("settles as error when the scenario has vanished from the workspace", async () => {
    const db = migratedDatabase();
    seedRun(db);
    const env: SimulationsEnv = { DB: sqliteDb(db) };
    const { fetcher, calls } = scriptedFetch(happyScript());
    const settled = await executeSimulationRun(env, execution(), inlineStepRunner(), fetcher);
    expect(settled?.status).toBe("error");
    expect(calls.length).toBe(0);
    db.close();
  });
});

// -- durability: crash then resume ---------------------------------------------------------------

/**
 * A structural stand-in for the Workflows `step` object. Results are memoized
 * by step name exactly as the real runtime memoizes a completed step, so a
 * resumed run replays the already-finished exchanges from cache instead of
 * calling the upstream again.
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
  it("resumes at the next exchange and re-runs only what is left", async () => {
    const db = migratedDatabase();
    seedScenario(db, { max_turns: 3 });
    seedRun(db);
    const env: SimulationsEnv = { DB: sqliteDb(db) };
    const { fetcher, calls } = scriptedFetch(happyScript());

    const step = new FakeStepRunner();
    step.crashAfter = 2;
    await expect(
      executeSimulationRun(env, execution(), step, fetcher),
    ).rejects.toThrow(/instance killed/);

    // Two exchanges landed on the spine before the kill; the run is unsettled.
    expect(step.executed).toEqual(["turn-0", "turn-1"]);
    expect(calls.length).toBe(4);
    expect(eventRows(db).length).toBe(4);
    expect(runRow(db).status).toBe("running");
    expect(runRow(db).turns_taken).toBe(2);

    // Resume with the same memo, as the runtime would.
    step.crashAfter = Number.POSITIVE_INFINITY;
    const settled = await executeSimulationRun(env, execution(), step, fetcher);

    expect(step.replayed).toEqual(["turn-0", "turn-1"]);
    expect(step.executed).toEqual(["turn-0", "turn-1", "turn-2", "judge"]);
    // Only the third exchange (2 calls) and the judge (1) were re-billed.
    expect(calls.length).toBe(7);
    expect(settled?.status).toBe("done");
    expect(settled?.turns_taken).toBe(3);

    const rows = eventRows(db);
    expect(rows.length).toBe(7);
    // Idempotent by id: no exchange was recorded twice.
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(7);
    db.close();
  });

  it("unseals the credential before running and never sees it in params", async () => {
    const db = migratedDatabase();
    seedScenario(db, { max_turns: 1 });
    seedRun(db);
    const env: SimulationsEnv = { DB: sqliteDb(db), GATEWAY_SEALING_KEY: "unit-test-sealing-key" };
    const { fetcher, calls } = scriptedFetch(happyScript());

    const { sealUpstreamKey } = await import("../src/gateway");
    const params: SimulationRunParams = {
      workspace_id: TOKEN_WORKSPACE,
      run_id: RUN_ONE,
      sealed_key: await sealUpstreamKey("sk-upstream-secret", "unit-test-sealing-key"),
      base_url: DEFAULT_BASE_URL,
      user_model: USER_MODEL,
      assistant_model: ASSISTANT_MODEL,
      judge_model: JUDGE_MODEL,
      assistant_system: null,
    };
    expect(params.sealed_key).not.toContain("sk-upstream-secret");

    await runSimulationWorkflow(env, params, new FakeStepRunner(), fetcher);

    expect(calls[0].authorization).toBe("Bearer sk-upstream-secret");
    expect(runRow(db).status).toBe("done");
    db.close();
  });

  it("settles the run rather than stranding it when the sealing key is gone", async () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    const env: SimulationsEnv = { DB: sqliteDb(db) };
    const { fetcher, calls } = scriptedFetch(happyScript());

    await runSimulationWorkflow(
      env,
      {
        workspace_id: TOKEN_WORKSPACE,
        run_id: RUN_ONE,
        sealed_key: "irrelevant",
        base_url: DEFAULT_BASE_URL,
        user_model: USER_MODEL,
        assistant_model: ASSISTANT_MODEL,
        judge_model: JUDGE_MODEL,
        assistant_system: null,
      },
      new FakeStepRunner(),
      fetcher,
    );

    expect(calls.length).toBe(0);
    expect(runRow(db).status).toBe("error");
    expect(runRow(db).verdict).toBeNull();
    db.close();
  });

  it("settles the run when the sealed credential will not unseal", async () => {
    const db = migratedDatabase();
    seedScenario(db);
    seedRun(db);
    const env: SimulationsEnv = { DB: sqliteDb(db), GATEWAY_SEALING_KEY: "unit-test-sealing-key" };
    const { fetcher, calls } = scriptedFetch(happyScript());

    await runSimulationWorkflow(
      env,
      {
        workspace_id: TOKEN_WORKSPACE,
        run_id: RUN_ONE,
        sealed_key: "not-base64-sealed",
        base_url: DEFAULT_BASE_URL,
        user_model: USER_MODEL,
        assistant_model: ASSISTANT_MODEL,
        judge_model: JUDGE_MODEL,
        assistant_system: null,
      },
      new FakeStepRunner(),
      fetcher,
    );

    expect(calls.length).toBe(0);
    expect(runRow(db).status).toBe("error");
    db.close();
  });
});

// -- transcript reconstruction -------------------------------------------------------------------

describe("buildTranscript", () => {
  function turnRow(index: number, role: "user" | "assistant", seqTag: string) {
    return {
      event_id: `evt_${seqTag}`,
      kind: EVENT_KIND_TURN,
      occurred_at: "2023-11-14T22:13:20.000Z",
      ingested_at: NOW_SECONDS + index,
      raw_json: JSON.stringify({
        payload: {
          content_hash: `sha256:${role[0].repeat(64)}`,
          model: role === "user" ? USER_MODEL : ASSISTANT_MODEL,
          role,
          run_id: RUN_ONE,
          scenario_id: SIM_ONE,
          turn_index: index,
        },
      }),
    };
  }

  it("orders by (turn_index, role) regardless of the order rows arrive in", () => {
    const { turns } = buildTranscript([
      turnRow(1, "assistant", "D"),
      turnRow(0, "assistant", "B"),
      turnRow(1, "user", "C"),
      turnRow(0, "user", "A"),
    ]);
    expect(turns.map((turn) => `${turn.turn_index}:${turn.role}`)).toEqual([
      "0:user",
      "0:assistant",
      "1:user",
      "1:assistant",
    ]);
    expect(turns.every((turn) => turn.provenance === "OBSERVED")).toBe(true);
    // Timing comes from the spine's own server-assigned ingestion clock.
    expect(turns[0].recorded_at).toBe(NOW_SECONDS);
  });

  it("skips malformed rows instead of failing the whole transcript", () => {
    const { turns, verdict } = buildTranscript([
      turnRow(0, "user", "A"),
      { ...turnRow(0, "assistant", "B"), raw_json: "not json" },
      { ...turnRow(1, "user", "C"), raw_json: JSON.stringify({ payload: { role: "narrator" } }) },
      { ...turnRow(1, "assistant", "D"), raw_json: JSON.stringify({ payload: null }) },
      {
        ...turnRow(2, "user", "E"),
        raw_json: JSON.stringify({ payload: { role: "user", turn_index: -1, content_hash: "x" } }),
      },
    ]);
    expect(turns.length).toBe(1);
    expect(verdict).toBeNull();
  });

  it("surfaces the verdict with its INFERRED label and takes the first one only", () => {
    const completed = (score: string, tag: string) => ({
      event_id: `evt_${tag}`,
      kind: EVENT_KIND_COMPLETED,
      occurred_at: "2023-11-14T22:13:20.000Z",
      ingested_at: NOW_SECONDS + 99,
      raw_json: JSON.stringify({
        payload: {
          judge_model: JUDGE_MODEL,
          judge_score: score,
          reason_hash: `sha256:${"c".repeat(64)}`,
          run_id: RUN_ONE,
          turns_taken: 2,
          verdict: "pass",
        },
      }),
    });
    const { verdict } = buildTranscript([completed("0.5", "X"), completed("0.9", "Y")]);
    expect(verdict?.judge_score).toBe("0.5");
    expect(verdict?.provenance).toBe("INFERRED");
    expect(verdict?.turns_taken).toBe(2);
  });

  it("ignores a completion event with no readable verdict", () => {
    const { verdict } = buildTranscript([
      {
        event_id: "evt_Z",
        kind: EVENT_KIND_COMPLETED,
        occurred_at: "2023-11-14T22:13:20.000Z",
        ingested_at: NOW_SECONDS,
        raw_json: JSON.stringify({ payload: { run_id: RUN_ONE } }),
      },
    ]);
    expect(verdict).toBeNull();
  });
});

// -- validation --------------------------------------------------------------------------------

describe("validateCreateScenarioBody", () => {
  const valid = {
    name: "Refund request",
    persona: "A frustrated customer",
    goal: "Get a refund",
    success_criteria: "A refund is offered",
  };

  it("defaults max_turns and trims text", () => {
    const result = validateCreateScenarioBody({ ...valid, name: "  Refund request  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Refund request");
      expect(result.value.maxTurns).toBe(6);
    }
  });

  it("rejects every missing or out-of-range field", () => {
    for (const field of ["name", "persona", "goal", "success_criteria"]) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(validateCreateScenarioBody(body).ok).toBe(false);
      expect(validateCreateScenarioBody({ ...valid, [field]: "   " }).ok).toBe(false);
      expect(validateCreateScenarioBody({ ...valid, [field]: 7 }).ok).toBe(false);
    }
    expect(validateCreateScenarioBody({ ...valid, name: "x".repeat(201) }).ok).toBe(false);
    expect(validateCreateScenarioBody({ ...valid, persona: "x".repeat(2001) }).ok).toBe(false);
    expect(validateCreateScenarioBody({ ...valid, max_turns: 0 }).ok).toBe(false);
    expect(validateCreateScenarioBody({ ...valid, max_turns: 13 }).ok).toBe(false);
    expect(validateCreateScenarioBody({ ...valid, max_turns: 2.5 }).ok).toBe(false);
    expect(validateCreateScenarioBody({ ...valid, max_turns: "3" }).ok).toBe(false);
  });
});

describe("validateStartRunBody", () => {
  const valid = {
    gateway_key: "sk-upstream",
    user_model: USER_MODEL,
    assistant_model: ASSISTANT_MODEL,
    judge_model: JUDGE_MODEL,
  };

  it("defaults the upstream and accepts a public https override", () => {
    const result = validateStartRunBody(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.baseUrl).toBe(DEFAULT_BASE_URL);

    const custom = validateStartRunBody({ ...valid, base_url: "https://proxy.example.com/v1/" });
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.value.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("refuses a private or non-https upstream", () => {
    expect(validateStartRunBody({ ...valid, base_url: "http://example.com" }).ok).toBe(false);
    expect(validateStartRunBody({ ...valid, base_url: "https://127.0.0.1/v1" }).ok).toBe(false);
    expect(validateStartRunBody({ ...valid, base_url: "https://169.254.169.254" }).ok).toBe(false);
  });

  it("requires a credential and all three model names", () => {
    for (const field of ["gateway_key", "user_model", "assistant_model", "judge_model"]) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(validateStartRunBody(body).ok).toBe(false);
    }
    expect(validateStartRunBody({ ...valid, gateway_key: "x".repeat(513) }).ok).toBe(false);
    expect(validateStartRunBody({ ...valid, judge_model: "x".repeat(201) }).ok).toBe(false);
  });
});

// -- HTTP surface ---------------------------------------------------------------------------------

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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${DEVICE_TOKEN}`, ...extra };
}

describe("routing", () => {
  it("declines paths it does not own and methods it does not serve", async () => {
    const { db } = mockDb();
    const env: SimulationsEnv = { DB: db };
    expect(await handleSimulationsRoute(request("/v1/workstreams"), env)).toBeNull();
    expect(await handleSimulationsRoute(request("/v1/simulations", { method: "DELETE" }), env)).toBeNull();
    expect(
      await handleSimulationsRoute(request(`/v1/simulations/${SIM_ONE}/run`, { method: "GET" }), env),
    ).toBeNull();
    expect(
      await handleSimulationsRoute(request(`/v1/simulations/${SIM_ONE}/runs`, { method: "POST" }), env),
    ).toBeNull();
    expect(
      await handleSimulationsRoute(
        request(`/v1/simulations/runs/${RUN_ONE}/transcript`, { method: "POST" }),
        env,
      ),
    ).toBeNull();
    // A malformed id is simply not this module's path.
    expect(await handleSimulationsRoute(request("/v1/simulations/sim_nope/run", { method: "POST" }), env))
      .toBeNull();
  });

  it("answers 401 without a token and 403 without the capability", async () => {
    const withDevice = mockDb({ first: authedFirst(() => null, { capabilities: "read" }) });
    const created = await handleSimulationsRoute(
      request("/v1/simulations", { method: "POST", headers: authed(), body: "{}" }),
      { DB: withDevice.db },
    );
    expect(created?.status).toBe(403);

    const anonymous = mockDb({ first: () => null });
    const unauthorized = await handleSimulationsRoute(
      request("/v1/simulations", { method: "GET" }),
      { DB: anonymous.db },
    );
    expect(unauthorized?.status).toBe(401);
  });
});

describe("POST /v1/simulations", () => {
  it("creates a scenario and echoes it back", async () => {
    const inserts: RecordedStatement[] = [];
    const { db } = mockDb({
      first: authedFirst(),
      run: (statement) => {
        inserts.push(statement);
      },
    });
    const response = await handleSimulationsRoute(
      request("/v1/simulations", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          name: "Refund request",
          persona: "A frustrated customer",
          goal: "Get a refund",
          success_criteria: "A refund is offered",
          max_turns: 4,
        }),
      }),
      { DB: db },
    );
    expect(response?.status).toBe(201);
    const body = (await response?.json()) as { scenario: Record<string, unknown> };
    expect(body.scenario.max_turns).toBe(4);
    expect(body.scenario.active).toBe(true);
    expect(String(body.scenario.id)).toMatch(/^sim_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(inserts[0].sql).toContain("INSERT INTO simulation_scenarios");
    expect(inserts[0].binds[1]).toBe(TOKEN_WORKSPACE);
  });

  it("rejects a non-object body and an invalid field", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const notObject = await handleSimulationsRoute(
      request("/v1/simulations", { method: "POST", headers: authed(), body: "[]" }),
      { DB: db },
    );
    expect(notObject?.status).toBe(400);

    const badField = await handleSimulationsRoute(
      request("/v1/simulations", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ name: "n", persona: "p", goal: "g", success_criteria: "s", max_turns: 99 }),
      }),
      { DB: db },
    );
    expect(badField?.status).toBe(400);
    expect(await badField?.json()).toEqual({ error: "max_turns must be an integer between 1 and 12" });
  });
});

describe("GET /v1/simulations", () => {
  it("returns an {items, next_cursor} envelope sorted newest first", async () => {
    const rows = [
      scenarioRow({ id: SIM_ONE, created_at: 100 }),
      scenarioRow({ id: SIM_TWO, created_at: 300 }),
    ];
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleSimulationsRoute(
      request("/v1/simulations", { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(body.items.map((item) => item.id)).toEqual([SIM_TWO, SIM_ONE]);
    expect(body.next_cursor).toBeNull();
  });

  it("emits a cursor when the prefetched extra row proves another page", async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) =>
      scenarioRow({ id: `sim_01J${String.fromCharCode(65 + index).repeat(23)}`, created_at: 100 + index }),
    );
    const { db } = mockDb({ first: authedFirst(), all: () => rows });
    const response = await handleSimulationsRoute(
      request("/v1/simulations?limit=2", { headers: authed() }),
      { DB: db },
    );
    const body = (await response?.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body.items.length).toBe(2);
    expect(body.next_cursor).not.toBeNull();
  });

  it("rejects a malformed pagination request", async () => {
    const { db } = mockDb({ first: authedFirst() });
    const response = await handleSimulationsRoute(
      request("/v1/simulations?limit=0", { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(400);
  });
});

describe("POST /v1/simulations/{id}/run", () => {
  const body = JSON.stringify({
    gateway_key: "sk-upstream-secret",
    user_model: USER_MODEL,
    assistant_model: ASSISTANT_MODEL,
    judge_model: JUDGE_MODEL,
  });

  it("404s a scenario that belongs to another workspace", async () => {
    // The scenario read is workspace-scoped, so a foreign id simply misses.
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/run`, { method: "POST", headers: authed(), body }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "not found" });
  });

  it("409s a deactivated scenario", async () => {
    const { db } = mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("FROM simulation_scenarios") ? scenarioRow({ active: 0 }) : null,
      ),
    });
    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/run`, { method: "POST", headers: authed(), body }),
      { DB: db },
    );
    expect(response?.status).toBe(409);
  });

  it("runs inline and returns the settled run when no Workflow is bound", async () => {
    const db = migratedDatabase();
    seedScenario(db, { max_turns: 2 });
    const real = sqliteDb(db);
    const env: SimulationsEnv = {
      DB: {
        prepare(sql: string) {
          if (sql.includes("FROM devices")) {
            return {
              bind: () => ({
                async first<T>() {
                  return deviceRow() as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true };
                },
              }),
            };
          }
          return real.prepare(sql);
        },
        batch: (statements) => real.batch(statements),
      },
    };
    const { fetcher, calls } = scriptedFetch(happyScript());

    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/run`, { method: "POST", headers: authed(), body }),
      env,
      fetcher,
    );
    expect(response?.status).toBe(200);
    const payload = (await response?.json()) as {
      durability: string;
      run: { status: string; verdict: string; verdict_provenance: string; turns_taken: number };
    };
    expect(payload.durability).toBe("inline");
    expect(payload.run.status).toBe("done");
    expect(payload.run.verdict).toBe("pass");
    // A verdict never renders without the label saying a model produced it.
    expect(payload.run.verdict_provenance).toBe("INFERRED");
    expect(payload.run.turns_taken).toBe(2);
    expect(calls.length).toBe(5);
    db.close();
  });

  it("hands the run to the Workflow binding with a SEALED credential", async () => {
    const created: { id?: string; params?: SimulationRunParams }[] = [];
    const runRecord = {
      id: RUN_ONE,
      workspace_id: TOKEN_WORKSPACE,
      scenario_id: SIM_ONE,
      status: "running",
      turns_taken: 0,
      verdict: null,
      judge_score: null,
      started_at: NOW_SECONDS,
      completed_at: null,
    };
    const { db } = mockDb({
      first: authedFirst((statement) => {
        if (statement.sql.includes("FROM simulation_scenarios")) return scenarioRow();
        if (statement.sql.includes("FROM simulation_runs")) return runRecord;
        return null;
      }),
    });
    const binding: SimulationWorkflowLike = {
      async create(options) {
        created.push(options ?? {});
        return { id: options?.id ?? "instance" };
      },
    };
    const { fetcher, calls } = scriptedFetch(happyScript());

    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/run`, { method: "POST", headers: authed(), body }),
      { DB: db, SIM_WORKFLOW: binding, GATEWAY_SEALING_KEY: "unit-test-sealing-key" },
      fetcher,
    );

    expect(response?.status).toBe(202);
    const payload = (await response?.json()) as { durability: string; workflow_instance_id: string };
    expect(payload.durability).toBe("workflow");
    expect(payload.workflow_instance_id).not.toBe("");
    // The dispatch itself must not call the upstream.
    expect(calls.length).toBe(0);

    const params = created[0].params as SimulationRunParams;
    expect(JSON.stringify(params)).not.toContain("sk-upstream-secret");
    expect(await unsealUpstreamKey(params.sealed_key, "unit-test-sealing-key")).toBe(
      "sk-upstream-secret",
    );
  });

  it("falls back to inline rather than persisting a raw credential", async () => {
    const db = migratedDatabase();
    seedScenario(db, { max_turns: 1 });
    const real = sqliteDb(db);
    let createCalled = false;
    const env: SimulationsEnv = {
      DB: {
        prepare(sql: string) {
          if (sql.includes("FROM devices")) {
            return {
              bind: () => ({
                async first<T>() {
                  return deviceRow() as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true };
                },
              }),
            };
          }
          return real.prepare(sql);
        },
        batch: (statements) => real.batch(statements),
      },
      // Bound, but with no sealing key: the params would be persisted in the
      // clear, so dispatch is refused.
      SIM_WORKFLOW: {
        async create() {
          createCalled = true;
          return { id: "instance" };
        },
      },
    };
    const { fetcher } = scriptedFetch(happyScript());

    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/run`, { method: "POST", headers: authed(), body }),
      env,
      fetcher,
    );
    expect(createCalled).toBe(false);
    expect(response?.status).toBe(200);
    expect((await response?.json() as { durability: string }).durability).toBe("inline");
    db.close();
  });
});

describe("GET /v1/simulations/{id}/runs", () => {
  it("404s when the scenario is not in the caller's workspace", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/runs`, { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
  });

  it("returns the run envelope newest first", async () => {
    const rows: RunRow[] = [
      {
        id: RUN_ONE,
        workspace_id: TOKEN_WORKSPACE,
        scenario_id: SIM_ONE,
        status: "done",
        turns_taken: 2,
        verdict: "pass",
        judge_score: "0.9",
        started_at: 100,
        completed_at: 130,
      },
      {
        id: RUN_TWO,
        workspace_id: TOKEN_WORKSPACE,
        scenario_id: SIM_ONE,
        status: "error",
        turns_taken: 1,
        verdict: null,
        judge_score: null,
        started_at: 400,
        completed_at: 410,
      },
    ];
    const { db } = mockDb({
      first: authedFirst((statement) =>
        statement.sql.includes("FROM simulation_scenarios") ? scenarioRow() : null,
      ),
      all: () => rows,
    });
    const response = await handleSimulationsRoute(
      request(`/v1/simulations/${SIM_ONE}/runs`, { headers: authed() }),
      { DB: db },
    );
    const body = (await response?.json()) as {
      items: { id: string; verdict_provenance: string | null }[];
      next_cursor: string | null;
    };
    expect(body.items.map((item) => item.id)).toEqual([RUN_TWO, RUN_ONE]);
    expect(body.items[0].verdict_provenance).toBeNull();
    expect(body.items[1].verdict_provenance).toBe("INFERRED");
    expect(body.next_cursor).toBeNull();
  });
});

describe("GET /v1/simulations/runs/{run_id}/transcript", () => {
  it("404s a run in another workspace", async () => {
    const { db } = mockDb({ first: authedFirst(() => null) });
    const response = await handleSimulationsRoute(
      request(`/v1/simulations/runs/${RUN_ONE}/transcript`, { headers: authed() }),
      { DB: db },
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "not found" });
  });

  it("rebuilds a real run's transcript from the spine, digests only", async () => {
    const db = migratedDatabase();
    seedScenario(db, { max_turns: 2 });
    seedRun(db);
    const real = sqliteDb(db);
    const env: SimulationsEnv = {
      DB: {
        prepare(sql: string) {
          if (sql.includes("FROM devices")) {
            return {
              bind: () => ({
                async first<T>() {
                  return deviceRow() as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true };
                },
              }),
            };
          }
          return real.prepare(sql);
        },
        batch: (statements) => real.batch(statements),
      },
    };
    const { fetcher } = scriptedFetch(happyScript());
    await executeSimulationRun({ DB: real }, execution(), inlineStepRunner(), fetcher);

    // A second run of a DIFFERENT scenario id must not leak into this one.
    seedScenario(db, { id: SIM_TWO, max_turns: 1 });
    seedRun(db, { id: RUN_TWO, scenario_id: SIM_TWO });
    await executeSimulationRun(
      { DB: real },
      execution({ runId: RUN_TWO }),
      inlineStepRunner(),
      scriptedFetch(happyScript()).fetcher,
    );

    const response = await handleSimulationsRoute(
      request(`/v1/simulations/runs/${RUN_ONE}/transcript`, { headers: authed() }),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      run: { id: string; status: string };
      turns: { turn_index: number; role: string; content_hash: string; provenance: string }[];
      verdict: { verdict: string; provenance: string } | null;
      content_policy: string;
    };
    expect(body.run.id).toBe(RUN_ONE);
    expect(body.turns.map((turn) => `${turn.turn_index}:${turn.role}`)).toEqual([
      "0:user",
      "0:assistant",
      "1:user",
      "1:assistant",
    ]);
    expect(body.turns.every((turn) => turn.content_hash.startsWith("sha256:"))).toBe(true);
    expect(body.turns.every((turn) => turn.provenance === "OBSERVED")).toBe(true);
    expect(body.verdict?.verdict).toBe("pass");
    expect(body.verdict?.provenance).toBe("INFERRED");
    expect(body.content_policy).toBe("content_addressed_only");
    expect(JSON.stringify(body)).not.toContain("user message");
    db.close();
  });
});
