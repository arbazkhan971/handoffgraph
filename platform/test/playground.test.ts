// Unit tests for src/playground.ts (parity rows 35, 36, 30).
//
// Coverage map:
//   * migration 0014 truth — CHECK constraints, the three run triggers and the
//     partial/expression indexes, applied for real with node:sqlite
//     (migrations 0001..0014);
//   * version resolution + variable substitution, including the fail-closed
//     400 on an unbound {{placeholder}} and the single-pass rule;
//   * a two-variant run: 2 deterministic playground.completed events, OBSERVED,
//     content-addressed, wall-clock-free — and a rerun under a frozen clock
//     that appends nothing and forks no second run row;
//   * upstream failure is fail-closed: run row 'error', 502, and NO variants
//     array in the response (while the variant that did run keeps its event);
//   * the eval-gated label repoint — pass, 409 fail with latest_score/min_score,
//     force override with the refusal audited into the payload — plus rollback
//     through the same route actually moving the label in quality.ts's reader;
//   * the optimizer: INFERRED provenance in the event AND the response, no
//     auto-apply (zero prompt.labeled events), fail-closed on an unparseable
//     model reply;
//   * virtual-key gating: bad vk_ => 401 {error} in OUR envelope, a
//     foreign-workspace key indistinguishable from an unknown one, disabled,
//     budget, and the 503 when no sealing key is configured;
//   * foreign-workspace 404s and method fallthrough;
//   * a structural sanity check over .github/workflows/prompt-ci.yml.example
//     (string assertions only — no YAML parser, no new dependency) including
//     that no runnable sibling workflow exists.
//
// Every handler test runs against REAL SQLite through a D1DatabaseLike adapter:
// this module's correctness lives in append-only writes, deterministic ids and
// literal SQL, all of which a hand-rolled mock would happily agree with when
// wrong. fetch is injected everywhere, so no test touches the network, and the
// clock is injected, so "deterministic" is asserted rather than hoped for.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth";
import type {
  D1BoundStatement,
  D1DatabaseLike,
  D1RunResultLike,
  D1Statement,
} from "../src/db";
import { sealUpstreamKey } from "../src/gateway";
import {
  DEFAULT_LOW_SCORE_THRESHOLD,
  EVENT_KIND_PLAYGROUND_COMPLETED,
  EVENT_KIND_PROMPT_LABELED,
  EVENT_KIND_SUGGESTION_RECORDED,
  MAX_RENDERED_BODY_BYTES,
  MAX_VARIANTS,
  buildLabelEvent,
  buildSuggestionEvent,
  buildVariantEvent,
  callPlaygroundModel,
  diffSummary,
  evaluateEvalGate,
  extractCompletionContent,
  handlePlaygroundRoute,
  labelEventID,
  loadLinkedScores,
  optimizerPrompt,
  parseSuggestion,
  playgroundEventID,
  playgroundRunID,
  renderPromptBody,
  scoreTargetsPromptVersion,
  suggestionEventID,
  validateLabelBody,
  validateRunBody,
  validateSuggestBody,
  type FetchLike,
  type PlaygroundEnv,
} from "../src/playground";
import { materializePromptEvents, resolveLabels } from "../src/quality";

// -- real-SQL adapter: D1DatabaseLike over node:sqlite ------------------------------

function sqliteDb(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string): D1Statement {
      return {
        bind(...values: unknown[]): D1BoundStatement {
          const params = values as (null | number | bigint | string | Uint8Array)[];
          return {
            async first<T>(): Promise<T | null> {
              const row = db.prepare(sql).get(...params);
              return (row === undefined ? null : (row as T));
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: db.prepare(sql).all(...params) as T[] };
            },
            async run<T>(): Promise<D1RunResultLike<T>> {
              db.prepare(sql).run(...params);
              return { success: true };
            },
          };
        },
      };
    },
    async batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]> {
      db.exec("BEGIN");
      try {
        const out: D1RunResultLike[] = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDirectory, "../..");
const migrationsDir = resolve(testDirectory, "../migrations");
const THIS_MIGRATION = "0014_playground.sql";
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql") && name <= THIS_MIGRATION)
  .sort();

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles) {
    db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return db;
}

// -- fixtures ----------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";

const DEVICE_TOKEN = "dev_test-token-playground";
const DEVICE_ID = "dev_01HTSTDEVPLAYGROUND0000Z";
const READ_ONLY_TOKEN = "dev_test-token-playground-ro";
const READ_ONLY_DEVICE_ID = "dev_01HTSTDEVPLAYREADONLY0Z";

const GWK_ID = `gwk_01J${"A".repeat(23)}`;
const GWK_OTHER_ID = `gwk_01J${"B".repeat(23)}`;
const VK_TOKEN = "vk_test-virtual-key-playground";
const VK_OTHER_TOKEN = "vk_test-virtual-key-foreign";
const SEALING_KEY = "test-gateway-sealing-key-material";
const UPSTREAM_KEY = "sk-upstream-playground";
const UPSTREAM_BASE = "https://api.openai.example/v1";

const API_KEY_WRITE = "sk_test-write-key-playground";
const API_KEY_READ = "sk_test-read-key-playground";
const APK_WRITE_ID = `apk_01J${"C".repeat(23)}`;
const APK_READ_ID = `apk_01J${"D".repeat(23)}`;

const PROMPT = "support-triage";
const MODEL = "gpt-4o-mini";

/** 2023-11-14T22:13:20Z. Frozen everywhere, so determinism is asserted. */
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const frozenClock = () => NOW_MS;

let TOKEN_HASH = "";
let READ_ONLY_HASH = "";
let VK_HASH = "";
let VK_OTHER_HASH = "";
let UPSTREAM_CIPHERTEXT = "";
let API_KEY_WRITE_HASH = "";
let API_KEY_READ_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  READ_ONLY_HASH = await sha256Hex(READ_ONLY_TOKEN);
  VK_HASH = await sha256Hex(VK_TOKEN);
  VK_OTHER_HASH = await sha256Hex(VK_OTHER_TOKEN);
  UPSTREAM_CIPHERTEXT = await sealUpstreamKey(UPSTREAM_KEY, SEALING_KEY);
  API_KEY_WRITE_HASH = await sha256Hex(API_KEY_WRITE);
  API_KEY_READ_HASH = await sha256Hex(API_KEY_READ);
});

function seedWorkspace(db: DatabaseSync, workspaceId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, workspace_id, name, status, created_at)
     VALUES (?, ?, 'test', 'active', 0)`,
  ).run(workspaceId, workspaceId);
  // The devices_charge_entitlement trigger (migration 0003) refuses a device
  // insert without an active entitlement that still has slots, so the fixture
  // creates a real one rather than routing around the schema.
  db.prepare(
    `INSERT INTO workspace_entitlements
       (workspace_id, plan_id, status, max_devices, max_device_issuances,
        period_start, period_end, created_at, updated_at)
     VALUES (?, 'basic', 'active', 10, 100, 0, 1, 0, 0)`,
  ).run(workspaceId);
}

function insertDevice(
  db: DatabaseSync,
  params: { id: string; workspaceId: string; tokenHash: string; capabilities: string },
): void {
  db.prepare(
    `INSERT INTO devices (id, workspace_id, token_hash, capabilities, created_at)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(params.id, params.workspaceId, params.tokenHash, params.capabilities);
}

function seedGatewayKey(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: GWK_ID,
    workspace_id: TOKEN_WORKSPACE,
    name: "playground",
    token_hash: VK_HASH,
    budget_amount: null as string | null,
    budget_spent: "0",
    rate_limit_per_min: 60,
    upstream_base_url: UPSTREAM_BASE,
    upstream_provider: "openai",
    upstream_key_ciphertext: UPSTREAM_CIPHERTEXT,
    fallbacks: "[]",
    capture_tier: "metadata",
    disabled: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO gateway_keys
       (id, workspace_id, name, token_hash, budget_amount, budget_spent,
        rate_limit_per_min, upstream_base_url, upstream_provider,
        upstream_key_ciphertext, fallbacks, capture_tier, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    row.id as string,
    row.workspace_id as string,
    row.name as string,
    row.token_hash as string,
    row.budget_amount as string | null,
    row.budget_spent as string,
    row.rate_limit_per_min as number,
    row.upstream_base_url as string,
    row.upstream_provider as string,
    row.upstream_key_ciphertext as string,
    row.fallbacks as string,
    row.capture_tier as string,
    row.disabled as number,
  );
}

function seedApiKeys(db: DatabaseSync): void {
  for (const key of [
    { id: APK_WRITE_ID, hash: API_KEY_WRITE_HASH, scopes: '["read","write"]', pk: "pk_write0000000" },
    { id: APK_READ_ID, hash: API_KEY_READ_HASH, scopes: '["read"]', pk: "pk_read00000000" },
  ]) {
    db.prepare(
      `INSERT INTO api_keys (id, workspace_id, name, public_key, secret_hash, scopes, created_at)
       VALUES (?, ?, 'ci', ?, ?, ?, 0)`,
    ).run(key.id, TOKEN_WORKSPACE, key.pk, key.hash, key.scopes);
  }
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  const head = `01HTEST${String(eventCounter).padStart(4, "0")}`;
  return `evt_${head}${"0".repeat(26 - head.length - 1)}Z`;
}

const INSERT_EVENT_SQL = `
  INSERT INTO events
    (workspace_id, event_id, idempotency_key, occurred_at, workstream_id,
     session_id, native_session_id, provider, kind, provenance, content_hash,
     ingested_at, raw_json)
  VALUES (?, ?, 'test-key', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, 0, ?)`;

/** One event row with a fully-formed hfg.event.v1 envelope wrapping `payload`. */
function insertEvent(
  db: DatabaseSync,
  workspaceId: string,
  params: { kind: string; occurredAt: string; payload: unknown; eventId?: string },
): string {
  const eventId = params.eventId ?? nextEventId();
  const envelope = {
    schema_version: "hfg.event.v1",
    event_id: eventId,
    kind: params.kind,
    occurred_at: params.occurredAt,
    observed_at: params.occurredAt,
    provenance: "OBSERVED",
    payload: params.payload,
  };
  db.prepare(INSERT_EVENT_SQL).run(
    workspaceId,
    eventId,
    params.occurredAt,
    params.kind,
    "OBSERVED",
    JSON.stringify(envelope),
  );
  return eventId;
}

/** Mirrors internal/prompts NewCreatedEvent's payload. */
function promptCreated(name: string, version: number, body: string): unknown {
  return { name, version, body, hash: `sha256:${"a".repeat(64)}`, created_by: "" };
}

/** Mirrors scores.Validate's payload map, with an explicit prompt target. */
function promptScore(fields: {
  name: string;
  value: string;
  promptName: string;
  version: number;
  comment?: string;
}): unknown {
  return {
    name: fields.name,
    data_type: "NUMERIC",
    value: fields.value,
    target_type: "prompt",
    target_id: `${fields.promptName}@${fields.version}`,
    source: "evaluation",
    comment: fields.comment ?? "",
  };
}

/** A score on a TRACE that links back through Go's internal/prompts.Links keys. */
function traceScore(fields: {
  name: string;
  value: string;
  promptName: string;
  version: number;
}): unknown {
  return {
    name: fields.name,
    data_type: "NUMERIC",
    value: fields.value,
    target_type: "trace",
    target_id: "trc_01HTEST000000000000000000",
    source: "evaluation",
    comment: "",
    prompt_name: fields.promptName,
    prompt_version: fields.version,
  };
}

/** The standard world: workspace, devices, api keys, gateway key, two prompt versions. */
function seedWorld(db: DatabaseSync): void {
  seedWorkspace(db, TOKEN_WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  insertDevice(db, {
    id: DEVICE_ID,
    workspaceId: TOKEN_WORKSPACE,
    tokenHash: TOKEN_HASH,
    capabilities: "ingest,read",
  });
  insertDevice(db, {
    id: READ_ONLY_DEVICE_ID,
    workspaceId: TOKEN_WORKSPACE,
    tokenHash: READ_ONLY_HASH,
    capabilities: "read",
  });
  seedApiKeys(db);
  seedGatewayKey(db);
  insertEvent(db, TOKEN_WORKSPACE, {
    kind: "prompt.created",
    occurredAt: "2026-01-01T00:00:00Z",
    payload: promptCreated(PROMPT, 1, "Answer {{customer_name}} tersely."),
  });
  insertEvent(db, TOKEN_WORKSPACE, {
    kind: "prompt.created",
    occurredAt: "2026-01-02T00:00:00Z",
    payload: promptCreated(PROMPT, 2, "Answer {{customer_name}} warmly and completely."),
  });
}

function makeEnv(db: DatabaseSync, overrides: Partial<PlaygroundEnv> = {}): PlaygroundEnv {
  return { DB: sqliteDb(db), GATEWAY_SEALING_KEY: SEALING_KEY, ...overrides };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(token: string = DEVICE_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function body(response: Response): Promise<any> {
  return await response.json();
}

// -- scripted upstream ---------------------------------------------------------------

interface UpstreamCall {
  url: string;
  authorization: string;
  model: string;
  maxTokens: number | null;
  prompt: string;
  stream: unknown;
}

function completionBody(
  content: string,
  usage: Record<string, unknown> | null = { prompt_tokens: 11, completion_tokens: 7 },
): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ message: { role: "assistant", content } }],
    ...(usage === null ? {} : { usage }),
  });
}

/** Records every call and replays a scripted outcome keyed on the sent prompt. */
function scriptedFetch(reply: (prompt: string, index: number) => string | Response) {
  const calls: UpstreamCall[] = [];
  let index = 0;
  const fetcher: FetchLike = async (input, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      max_tokens?: number;
      stream?: unknown;
      messages?: { role: string; content: string }[];
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const prompt = parsed.messages?.[0]?.content ?? "";
    calls.push({
      url: input,
      authorization: headers.authorization ?? "",
      model: parsed.model ?? "",
      maxTokens: parsed.max_tokens ?? null,
      prompt,
      stream: parsed.stream,
    });
    const outcome = reply(prompt, index++);
    if (outcome instanceof Response) return outcome;
    return new Response(outcome, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls };
}

const neverFetch: FetchLike = async () => {
  throw new Error("fetch should not have been called");
};

/** The happy playground script: each variant answers with its own text. */
function variantScript(): (prompt: string) => string {
  return (prompt) =>
    prompt.includes("tersely")
      ? completionBody("line one\nterse answer")
      : completionBody("line one\nwarm and complete answer", {
          prompt_tokens: 20,
          completion_tokens: 30,
          cost: "0.0004",
        });
}

// -- DB readers ------------------------------------------------------------------------

interface StoredEvent {
  event_id: string;
  kind: string;
  provenance: string;
  content_hash: string;
  occurred_at: string;
  ingested_at: number;
  provider: string;
  raw_json: string;
}

function storedEvents(db: DatabaseSync, kind?: string): StoredEvent[] {
  const rows =
    kind === undefined
      ? db.prepare("SELECT * FROM events ORDER BY seq").all()
      : db.prepare("SELECT * FROM events WHERE kind = ?1 ORDER BY seq").all(kind);
  return rows as unknown as StoredEvent[];
}

function payloadOf(event: StoredEvent): any {
  return JSON.parse(event.raw_json).payload;
}

function runRows(db: DatabaseSync): any[] {
  return db.prepare("SELECT * FROM playground_runs ORDER BY id").all() as any[];
}

async function runPlayground(
  db: DatabaseSync,
  overrides: Record<string, unknown> = {},
  fetcher: FetchLike = scriptedFetch(variantScript()).fetcher,
  env: PlaygroundEnv = makeEnv(db),
): Promise<Response> {
  const response = await handlePlaygroundRoute(
    request("/v1/playground/run", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        prompt_name: PROMPT,
        versions: [1, 2],
        variables: { customer_name: "Ada" },
        gateway_key: VK_TOKEN,
        model: MODEL,
        ...overrides,
      }),
    }),
    env,
    fetcher,
    frozenClock,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

// =============================================================================
// migration 0014 truth
// =============================================================================

describe("migration 0014 (node:sqlite)", () => {
  function insertRun(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
    const row = {
      id: `plr_01J${"E".repeat(23)}`,
      workspace_id: TOKEN_WORKSPACE,
      prompt_name: PROMPT,
      versions: "[1,2]",
      model: MODEL,
      status: "running",
      created_at: NOW_SECONDS,
      ...overrides,
    };
    db.prepare(
      `INSERT INTO playground_runs
         (id, workspace_id, prompt_name, versions, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id as string,
      row.workspace_id as string,
      row.prompt_name as string,
      row.versions as string,
      row.model as string,
      row.status as string,
      row.created_at as number,
    );
  }

  it("applies on top of every earlier migration and creates playground_runs", () => {
    const db = migratedDatabase();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("playground_runs");
    db.close();
  });

  it("creates the three read-path indexes", () => {
    const db = migratedDatabase();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("idx_events_playground");
    expect(names).toContain("idx_events_playground_run");
    expect(names).toContain("idx_events_score_recorded");
    db.close();
  });

  it("rejects an id that is not a plr_<ulid>", () => {
    const db = migratedDatabase();
    expect(() => insertRun(db, { id: "plr_not-a-ulid" })).toThrow(/CHECK/);
    expect(() => insertRun(db, { id: `smr_01J${"E".repeat(23)}` })).toThrow(/CHECK/);
    db.close();
  });

  it("requires workspace_id to be a wsp_<ulid>", () => {
    const db = migratedDatabase();
    expect(() => insertRun(db, { workspace_id: "not-a-workspace" })).toThrow(/CHECK/);
    db.close();
  });

  it("caps versions at the diff ceiling and requires a JSON array", () => {
    const db = migratedDatabase();
    expect(() => insertRun(db, { versions: "[1,2,3]" })).toThrow(/CHECK/);
    expect(() => insertRun(db, { versions: "[]" })).toThrow(/CHECK/);
    expect(() => insertRun(db, { versions: "not json" })).toThrow(/CHECK/);
    expect(() => insertRun(db, { versions: '{"a":1}' })).toThrow(/CHECK/);
    expect(MAX_VARIANTS).toBe(2);
    db.close();
  });

  it("keeps status and completed_at in agreement", () => {
    const db = migratedDatabase();
    insertRun(db);
    // 'done' without a completion instant is not a state this schema admits.
    expect(() =>
      db.prepare("UPDATE playground_runs SET status='done' WHERE workspace_id=?1").run(TOKEN_WORKSPACE),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("refuses a completed_at earlier than created_at", () => {
    const db = migratedDatabase();
    insertRun(db);
    expect(() =>
      db
        .prepare("UPDATE playground_runs SET status='done', completed_at=?1")
        .run(NOW_SECONDS - 1),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("makes run identity immutable", () => {
    const db = migratedDatabase();
    insertRun(db);
    expect(() =>
      db.prepare("UPDATE playground_runs SET prompt_name='other'").run(),
    ).toThrow(/identity is immutable/);
    expect(() => db.prepare("UPDATE playground_runs SET versions='[9]'").run()).toThrow(
      /identity is immutable/,
    );
    expect(() => db.prepare("UPDATE playground_runs SET model='other'").run()).toThrow(
      /identity is immutable/,
    );
    db.close();
  });

  it("makes settlement terminal and completed_at write-once", () => {
    const db = migratedDatabase();
    insertRun(db);
    db.prepare("UPDATE playground_runs SET status='done', completed_at=?1").run(NOW_SECONDS);
    expect(() =>
      db.prepare("UPDATE playground_runs SET status='error'").run(),
    ).toThrow(/status is terminal/);
    expect(() =>
      db.prepare("UPDATE playground_runs SET completed_at=?1").run(NOW_SECONDS + 10),
    ).toThrow(/completion time is write-once/);
    // Rewriting the SAME terminal outcome stays permitted: a replayed
    // settlement is deterministic and must be a no-op, not an abort.
    expect(() =>
      db.prepare("UPDATE playground_runs SET status='done', completed_at=?1").run(NOW_SECONDS),
    ).not.toThrow();
    db.close();
  });

  it("still enforces the append-only event spine it writes into", () => {
    const db = migratedDatabase();
    seedWorkspace(db, TOKEN_WORKSPACE);
    const id = insertEvent(db, TOKEN_WORKSPACE, {
      kind: EVENT_KIND_PLAYGROUND_COMPLETED,
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { run_id: "plr_x" },
    });
    expect(() =>
      insertEvent(db, TOKEN_WORKSPACE, {
        kind: EVENT_KIND_PLAYGROUND_COMPLETED,
        occurredAt: "2026-01-01T00:00:00Z",
        payload: { run_id: "plr_y" },
        eventId: id,
      }),
    ).toThrow(/event payload conflict/);
    db.close();
  });
});

// =============================================================================
// pure helpers
// =============================================================================

describe("renderPromptBody", () => {
  it("substitutes placeholders, tolerating inner whitespace", () => {
    const result = renderPromptBody("Hi {{name}}, from {{ city }}.", { name: "Ada", city: "Lovelace" });
    expect(result).toEqual({ ok: true, text: "Hi Ada, from Lovelace." });
  });

  it("fails closed on a missing variable, listing every one, sorted", () => {
    const result = renderPromptBody("{{zeta}} {{alpha}} {{zeta}}", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["alpha", "zeta"]);
  });

  it("never forwards an unrendered placeholder to the model", () => {
    // The whole point: a plausible completion for an unrendered template hides
    // exactly the bug a playground exists to catch.
    const result = renderPromptBody("Dear {{customer_name}}", { other: "x" });
    expect(result.ok).toBe(false);
  });

  it("is single-pass: a value containing a placeholder is never re-expanded", () => {
    const result = renderPromptBody("{{a}}", { a: "{{b}}", b: "SHOULD NOT APPEAR" });
    expect(result).toEqual({ ok: true, text: "{{b}}" });
  });

  it("ignores extra variables so one map can cover both variants", () => {
    const result = renderPromptBody("only {{a}}", { a: "1", b: "2", c: "3" });
    expect(result).toEqual({ ok: true, text: "only 1" });
  });

  it("leaves a body with no placeholders untouched", () => {
    expect(renderPromptBody("plain", {})).toEqual({ ok: true, text: "plain" });
  });
});

describe("diffSummary", () => {
  it("reports identical outputs", () => {
    expect(diffSummary("same\ntext", "same\ntext")).toEqual({
      identical: true,
      length_delta: 0,
      first_divergent_line: null,
    });
  });

  it("finds the first divergent line, 1-based, with the length delta", () => {
    const summary = diffSummary("one\ntwo\nthree", "one\nTWO\nthree");
    expect(summary.identical).toBe(false);
    expect(summary.length_delta).toBe(0);
    expect(summary.first_divergent_line).toEqual({ line: 2, a: "two", b: "TWO" });
  });

  it("reports a null side when one output ran out of lines", () => {
    const summary = diffSummary("one", "one\ntwo");
    expect(summary.first_divergent_line).toEqual({ line: 2, a: null, b: "two" });
    expect(summary.length_delta).toBe(4);
  });

  it("normalizes CRLF so a Windows-authored prompt is not all divergent", () => {
    const summary = diffSummary("a\r\nb", "a\nb");
    // The strings differ, but every LINE matches.
    expect(summary.identical).toBe(false);
    expect(summary.first_divergent_line).toBeNull();
  });
});

describe("scoreTargetsPromptVersion", () => {
  it("accepts the explicit prompt target form", () => {
    expect(
      scoreTargetsPromptVersion({ target_type: "prompt", target_id: "p@3" }, "p", 3),
    ).toBe(true);
    expect(
      scoreTargetsPromptVersion({ target_type: "prompt", target_id: "p@4" }, "p", 3),
    ).toBe(false);
  });

  it("accepts Go's internal/prompts.Links key set", () => {
    expect(scoreTargetsPromptVersion({ prompt_name: "p", prompt_version: 3 }, "p", 3)).toBe(true);
    expect(scoreTargetsPromptVersion({ "prompt.name": "p", "prompt.version": 3 }, "p", 3)).toBe(true);
    expect(
      scoreTargetsPromptVersion(
        { "langfuse.observation.prompt.name": "p", prompt_version: 3 },
        "p",
        3,
      ),
    ).toBe(true);
  });

  it("refuses a payload that names the prompt but not the version", () => {
    // Promoting v4 on a score that might have been about v1 is exactly the
    // mistake the gate exists to prevent.
    expect(scoreTargetsPromptVersion({ prompt_name: "p" }, "p", 3)).toBe(false);
    expect(scoreTargetsPromptVersion({ prompt_name: "p", prompt_version: 1 }, "p", 3)).toBe(false);
  });

  it("refuses non-objects and unrelated payloads", () => {
    expect(scoreTargetsPromptVersion(null, "p", 3)).toBe(false);
    expect(scoreTargetsPromptVersion("nope", "p", 3)).toBe(false);
    expect(scoreTargetsPromptVersion({ target_type: "trace", target_id: "trc_x" }, "p", 3)).toBe(false);
  });
});

describe("parseSuggestion", () => {
  it("parses a bare JSON object", () => {
    expect(parseSuggestion('{"suggested_body":"better","rationale":"why"}')).toEqual({
      suggestedBody: "better",
      rationale: "why",
    });
  });

  it("tolerates exactly one markdown code fence", () => {
    expect(parseSuggestion('```json\n{"suggested_body":"better","rationale":"r"}\n```')).toEqual({
      suggestedBody: "better",
      rationale: "r",
    });
  });

  it("fails closed on prose, missing fields, and an oversized body", () => {
    expect(parseSuggestion("Sure! Here you go: better")).toBeNull();
    expect(parseSuggestion('{"rationale":"r"}')).toBeNull();
    expect(parseSuggestion('{"suggested_body":"   "}')).toBeNull();
    expect(parseSuggestion('["suggested_body"]')).toBeNull();
    const huge = JSON.stringify({ suggested_body: "x".repeat(MAX_RENDERED_BODY_BYTES + 1) });
    expect(parseSuggestion(huge)).toBeNull();
  });
});

describe("deterministic ids", () => {
  it("are pure functions of their inputs", async () => {
    expect(await playgroundRunID("id-a", NOW_MS)).toBe(await playgroundRunID("id-a", NOW_MS));
    expect(await playgroundRunID("id-a", NOW_MS)).not.toBe(await playgroundRunID("id-b", NOW_MS));
    expect(await playgroundRunID("id-a", NOW_MS)).not.toBe(await playgroundRunID("id-a", NOW_MS + 1));
    expect(await playgroundEventID("id", 1, NOW_MS)).not.toBe(
      await playgroundEventID("id", 2, NOW_MS),
    );
    expect(await suggestionEventID("p", 1, "sha256:x", NOW_MS)).toBe(
      await suggestionEventID("p", 1, "sha256:x", NOW_MS),
    );
  });

  it("gives the run id the plr_ shape migration 0014 requires", async () => {
    expect(await playgroundRunID("id-a", NOW_MS)).toMatch(/^plr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("makes a rollback repoint its own event even though (name,label,version) repeats", async () => {
    // If the label id ignored the clock, repointing production back to v3
    // would replay the original event, INSERT OR IGNORE would drop it, and the
    // label would silently never move. See docs/prompt-cicd.md §5.
    const first = await labelEventID("p", "production", 3, NOW_MS);
    const rollback = await labelEventID("p", "production", 3, NOW_MS + 5000);
    expect(first).not.toBe(rollback);
    expect(await labelEventID("p", "production", 3, NOW_MS)).toBe(first);
  });
});

describe("event documents", () => {
  it("builds an OBSERVED, wall-clock-free variant event", async () => {
    const event = await buildVariantEvent({
      runId: "plr_x",
      identity: "abc",
      promptName: PROMPT,
      version: 2,
      variantIndex: 1,
      model: MODEL,
      promptHash: `sha256:${"1".repeat(64)}`,
      outputHash: `sha256:${"2".repeat(64)}`,
      tokensIn: 11,
      tokensOut: 7,
      cost: null,
      startedAtMs: NOW_MS,
    });
    expect(event.provenance).toBe("OBSERVED");
    expect(event.kind).toBe(EVENT_KIND_PLAYGROUND_COMPLETED);
    const document = JSON.parse(event.rawJson);
    expect(document.payload).toEqual({
      cost: null,
      model: MODEL,
      output_hash: `sha256:${"2".repeat(64)}`,
      prompt_hash: `sha256:${"1".repeat(64)}`,
      prompt_name: PROMPT,
      run_id: "plr_x",
      tokens: { input: 11, output: 7 },
      variant_index: 1,
      version: 2,
    });
    // No latency, no timestamps, nothing that could differ under replay.
    expect(event.rawJson).not.toContain("latency");
  });

  it("labels a provider-reported cost and never writes an unlabelled one", async () => {
    const withCost = await buildVariantEvent({
      runId: "plr_x",
      identity: "abc",
      promptName: PROMPT,
      version: 1,
      variantIndex: 0,
      model: MODEL,
      promptHash: "sha256:h",
      outputHash: "sha256:o",
      tokensIn: null,
      tokensOut: null,
      cost: "0.0004",
      startedAtMs: NOW_MS,
    });
    const payload = JSON.parse(withCost.rawJson).payload;
    expect(payload.cost).toBe("0.0004");
    expect(payload.cost_provenance).toBe("provider_reported");
  });

  it("keeps prompt.labeled byte-compatible with the Go payload, gate additive", async () => {
    const plain = await buildLabelEvent({
      promptName: PROMPT,
      label: "production",
      version: 2,
      atMs: NOW_MS,
      gate: null,
    });
    expect(JSON.parse(plain.rawJson).payload).toEqual({
      label: "production",
      name: PROMPT,
      version: 2,
    });
    expect(plain.provenance).toBe("OBSERVED");
  });

  it("marks a suggestion INFERRED and records that it was not applied", async () => {
    const event = await buildSuggestionEvent({
      promptName: PROMPT,
      baseVersion: 2,
      model: MODEL,
      suggestedBodyHash: "sha256:s",
      rationaleHash: "sha256:r",
      rationaleSummary: "shorter",
      sampleSize: 2,
      evidenceEventIds: ["evt_b", "evt_a"],
      atMs: NOW_MS,
    });
    expect(event.provenance).toBe("INFERRED");
    const payload = JSON.parse(event.rawJson).payload;
    expect(payload.applied).toBe(false);
    expect(payload.suggestion_provenance).toBe("INFERRED");
    // Deterministic sorted output, so replays are byte-identical.
    expect(payload.evidence_event_ids).toEqual(["evt_a", "evt_b"]);
  });
});

describe("callPlaygroundModel", () => {
  it("extracts content, usage and a provider-reported cost", async () => {
    const { fetcher, calls } = scriptedFetch(() =>
      completionBody("hello", { prompt_tokens: 3, completion_tokens: 4, cost: "0.002" }),
    );
    const result = await callPlaygroundModel(
      fetcher,
      UPSTREAM_BASE,
      UPSTREAM_KEY,
      MODEL,
      "prompt text",
      256,
      frozenClock,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("hello");
      expect(result.tokensIn).toBe(3);
      expect(result.tokensOut).toBe(4);
      expect(result.cost).toBe("0.002");
    }
    // Header allow-list: the provider sees the unsealed upstream key and
    // nothing else the caller sent.
    expect(calls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[0].url).toBe(`${UPSTREAM_BASE}/chat/completions`);
    expect(calls[0].maxTokens).toBe(256);
    expect(calls[0].stream).toBe(false);
  });

  it("returns null cost when the upstream did not report one", async () => {
    const { fetcher } = scriptedFetch(() => completionBody("hi"));
    const result = await callPlaygroundModel(
      fetcher, UPSTREAM_BASE, UPSTREAM_KEY, MODEL, "p", null, frozenClock,
    );
    expect(result.ok && result.cost).toBeNull();
  });

  it("types every failure instead of throwing", async () => {
    const thrown = await callPlaygroundModel(
      async () => {
        throw new Error("connection reset");
      },
      UPSTREAM_BASE, UPSTREAM_KEY, MODEL, "p", null, frozenClock,
    );
    expect(thrown).toMatchObject({ ok: false, reason: "upstream_unavailable" });

    const errored = await callPlaygroundModel(
      async () => new Response("{}", { status: 503 }),
      UPSTREAM_BASE, UPSTREAM_KEY, MODEL, "p", null, frozenClock,
    );
    expect(errored).toMatchObject({ ok: false, reason: "upstream_error", status: 503 });

    const garbage = await callPlaygroundModel(
      async () => new Response("not json", { status: 200 }),
      UPSTREAM_BASE, UPSTREAM_KEY, MODEL, "p", null, frozenClock,
    );
    expect(garbage).toMatchObject({ ok: false, reason: "unparseable_response" });

    const empty = await callPlaygroundModel(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      UPSTREAM_BASE, UPSTREAM_KEY, MODEL, "p", null, frozenClock,
    );
    expect(empty).toMatchObject({ ok: false, reason: "unparseable_response" });
  });

  it("extractCompletionContent tolerates every malformed shape", () => {
    expect(extractCompletionContent(null)).toBeNull();
    expect(extractCompletionContent({ choices: "x" })).toBeNull();
    expect(extractCompletionContent({ choices: [null] })).toBeNull();
    expect(extractCompletionContent({ choices: [{ message: {} }] })).toBeNull();
    expect(extractCompletionContent({ choices: [{ message: { content: "" } }] })).toBeNull();
  });
});

describe("validation", () => {
  it("rejects a versions array outside 1..2 and a self-comparison", () => {
    const base = { prompt_name: PROMPT, gateway_key: VK_TOKEN, model: MODEL };
    expect(validateRunBody({ ...base, versions: [] }).ok).toBe(false);
    expect(validateRunBody({ ...base, versions: [1, 2, 3] }).ok).toBe(false);
    expect(validateRunBody({ ...base, versions: [0] }).ok).toBe(false);
    expect(validateRunBody({ ...base, versions: [1, 1] }).ok).toBe(false);
    expect(validateRunBody({ ...base, versions: [1, 2] }).ok).toBe(true);
  });

  it("requires string variable values and a bounded max_tokens", () => {
    const base = { prompt_name: PROMPT, gateway_key: VK_TOKEN, model: MODEL, versions: [1] };
    expect(validateRunBody({ ...base, variables: { a: 1 } }).ok).toBe(false);
    expect(validateRunBody({ ...base, variables: [] }).ok).toBe(false);
    expect(validateRunBody({ ...base, max_tokens: 0 }).ok).toBe(false);
    expect(validateRunBody({ ...base, max_tokens: 1_000_000 }).ok).toBe(false);
  });

  it("normalizes a label and refuses the computed 'latest'", () => {
    const ok = validateLabelBody({ label: "  Production  ", version: 2 });
    expect(ok.ok && ok.value.label).toBe("production");
    expect(validateLabelBody({ label: "latest", version: 2 }).ok).toBe(false);
    expect(validateLabelBody({ label: "LATEST", version: 2 }).ok).toBe(false);
    expect(validateLabelBody({ label: "bad label", version: 2 }).ok).toBe(false);
    expect(validateLabelBody({ label: "production", version: 0 }).ok).toBe(false);
  });

  it("requires score_name whenever min_score is given", () => {
    expect(validateLabelBody({ label: "p", version: 1, min_score: "0.8" }).ok).toBe(false);
    expect(
      validateLabelBody({ label: "p", version: 1, min_score: "0.8", score_name: "acc" }).ok,
    ).toBe(true);
    expect(
      validateLabelBody({ label: "p", version: 1, min_score: 0.8, score_name: "acc" }).ok,
    ).toBe(false);
  });

  it("bounds the optimizer's sample size and defaults its threshold", () => {
    const base = { prompt_name: PROMPT, gateway_key: VK_TOKEN, model: MODEL };
    expect(validateSuggestBody({ ...base, sample_size: 21 }).ok).toBe(false);
    expect(validateSuggestBody({ ...base, sample_size: 0 }).ok).toBe(false);
    const ok = validateSuggestBody(base);
    expect(ok.ok && ok.value.maxScore).toBe(DEFAULT_LOW_SCORE_THRESHOLD);
  });
});

// =============================================================================
// the eval gate, over real SQL
// =============================================================================

describe("evaluateEvalGate", () => {
  function gateDb(): DatabaseSync {
    const db = migratedDatabase();
    seedWorkspace(db, TOKEN_WORKSPACE);
    return db;
  }

  it("passes when the latest linked score clears the threshold", async () => {
    const db = gateDb();
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.91", promptName: PROMPT, version: 2 }),
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict).toMatchObject({ passed: true, latestScore: "0.91" });
    db.close();
  });

  it("fails closed when NO evaluation has ever scored the version", async () => {
    const db = gateDb();
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict).toEqual({ passed: false, latestScore: null, latestScoreEventId: null });
    db.close();
  });

  it("uses the LATEST score, not the best one", async () => {
    const db = gateDb();
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.99", promptName: PROMPT, version: 2 }),
    });
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-03-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.40", promptName: PROMPT, version: 2 }),
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict).toMatchObject({ passed: false, latestScore: "0.40" });
    db.close();
  });

  it("compares decimals exactly, so 0.80 clears a 0.80 threshold", async () => {
    const db = gateDb();
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.8", promptName: PROMPT, version: 2 }),
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict.passed).toBe(true);
    db.close();
  });

  it("ignores another version, another score name, and a non-decimal value", async () => {
    const db = gateDb();
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.99", promptName: PROMPT, version: 1 }),
    });
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-02T00:00:00Z",
      payload: promptScore({ name: "other", value: "0.99", promptName: PROMPT, version: 2 }),
    });
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-03T00:00:00Z",
      payload: { ...(promptScore({ name: "acc", value: "x", promptName: PROMPT, version: 2 }) as object), value: "PASS" },
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict.passed).toBe(false);
    expect(verdict.latestScore).toBeNull();
    db.close();
  });

  it("never reads another workspace's scores", async () => {
    const db = gateDb();
    seedWorkspace(db, OTHER_WORKSPACE);
    insertEvent(db, OTHER_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.99", promptName: PROMPT, version: 2 }),
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict.passed).toBe(false);
    db.close();
  });

  it("links a trace score through Go's prompts.Links key set", async () => {
    const db = gateDb();
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: traceScore({ name: "acc", value: "0.95", promptName: PROMPT, version: 2 }),
    });
    const linked = await loadLinkedScores(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc");
    expect(linked).toHaveLength(1);
    expect(linked[0].value).toBe("0.95");
    db.close();
  });

  it("keeps the NEWEST scores when the scan bound bites, not the oldest", async () => {
    const db = gateDb();
    for (const [occurredAt, value] of [
      ["2026-02-01T00:00:00Z", "0.10"],
      ["2026-02-02T00:00:00Z", "0.20"],
      ["2026-02-03T00:00:00Z", "0.95"],
    ]) {
      insertEvent(db, TOKEN_WORKSPACE, {
        kind: "score.recorded",
        occurredAt,
        payload: promptScore({ name: "acc", value, promptName: PROMPT, version: 2 }),
      });
    }
    // An ASCENDING bounded scan would keep 0.10/0.20 and report a stale gate
    // verdict forever once a workspace outgrows the cap.
    const bounded = await loadLinkedScores(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", 2);
    expect(bounded.map((score) => score.value)).toEqual(["0.20", "0.95"]);
    db.close();
  });

  it("skips a malformed row instead of blocking the deploy", async () => {
    const db = gateDb();
    db.prepare(INSERT_EVENT_SQL).run(
      TOKEN_WORKSPACE, nextEventId(), "2026-02-01T00:00:00Z", "score.recorded", "OBSERVED", "{not json",
    );
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-02T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.91", promptName: PROMPT, version: 2 }),
    });
    const verdict = await evaluateEvalGate(sqliteDb(db), TOKEN_WORKSPACE, PROMPT, 2, "acc", "0.80");
    expect(verdict.passed).toBe(true);
    db.close();
  });
});

// =============================================================================
// POST /v1/playground/run
// =============================================================================

describe("POST /v1/playground/run", () => {
  it("401s with no credential and 403s a read-only device", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const anonymous = await handlePlaygroundRoute(
      request("/v1/playground/run", { method: "POST", body: "{}" }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    expect(anonymous?.status).toBe(401);

    const readOnly = await handlePlaygroundRoute(
      request("/v1/playground/run", {
        method: "POST",
        headers: authed(READ_ONLY_TOKEN),
        body: JSON.stringify({ prompt_name: PROMPT, versions: [1], gateway_key: VK_TOKEN, model: MODEL }),
      }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    expect(readOnly?.status).toBe(403);
    db.close();
  });

  it("404s an unknown prompt and an unknown version", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const unknownPrompt = await runPlayground(db, { prompt_name: "nope" }, neverFetch);
    expect(unknownPrompt.status).toBe(404);
    expect((await body(unknownPrompt)).error).toBe("prompt not found");

    const unknownVersion = await runPlayground(db, { versions: [1, 9] }, neverFetch);
    expect(unknownVersion.status).toBe(404);
    expect(await body(unknownVersion)).toMatchObject({ error: "prompt version not found", version: 9 });
    db.close();
  });

  it("404s a prompt that exists only in another workspace", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, OTHER_WORKSPACE, {
      kind: "prompt.created",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: promptCreated("foreign-only", 1, "secret body"),
    });
    const response = await runPlayground(db, { prompt_name: "foreign-only", versions: [1] }, neverFetch);
    expect(response.status).toBe(404);
    db.close();
  });

  it("400s fail-closed on a missing variable, before spending anything", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await runPlayground(db, { variables: {} }, neverFetch);
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({
      error: "missing_variables",
      missing: ["customer_name"],
      version: 1,
    });
    // Nothing was created, because nothing could run.
    expect(runRows(db)).toHaveLength(0);
    db.close();
  });

  it("runs two variants, records 2 OBSERVED events, and returns a diff", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const { fetcher, calls } = scriptedFetch(variantScript());
    const response = await runPlayground(db, {}, fetcher);
    expect(response.status).toBe(200);
    const result = await body(response);

    expect(result.run).toMatchObject({
      prompt_name: PROMPT,
      versions: [1, 2],
      model: MODEL,
      status: "done",
      created_at: NOW_SECONDS,
      completed_at: NOW_SECONDS,
    });
    expect(result.run.id).toMatch(/^plr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toMatchObject({
      version: 1,
      output: "line one\nterse answer",
      tokens: { input: 11, output: 7 },
      cost: null,
      recorded: true,
    });
    expect(result.variants[1]).toMatchObject({
      version: 2,
      cost: "0.0004",
      cost_provenance: "provider_reported",
      recorded: true,
    });
    expect(result.diff).toEqual({
      identical: false,
      length_delta: "line one\nwarm and complete answer".length - "line one\nterse answer".length,
      first_divergent_line: { line: 2, a: "terse answer", b: "warm and complete answer" },
    });
    expect(result.content_policy).toBe("content_addressed_only");

    // Two calls, each carrying its own RENDERED body and the unsealed key.
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toBe("Answer Ada tersely.");
    expect(calls[1].prompt).toBe("Answer Ada warmly and completely.");
    expect(calls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);

    const events = storedEvents(db, EVENT_KIND_PLAYGROUND_COMPLETED);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.provenance).toBe("OBSERVED");
      expect(event.provider).toBe("playground");
      expect(event.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(payloadOf(event).run_id).toBe(result.run.id);
    }
    expect(events.map((event) => payloadOf(event).version)).toEqual([1, 2]);
    expect(events.map((event) => event.event_id)).toEqual(
      result.variants.map((variant: any) => variant.event_id),
    );
    // Deterministic, distinct ids for the two variants.
    expect(events[0].event_id).not.toBe(events[1].event_id);
    db.close();
  });

  it("stores digests, never the prompt or the completion", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await runPlayground(db);
    const raw = storedEvents(db, EVENT_KIND_PLAYGROUND_COMPLETED)
      .map((event) => event.raw_json)
      .join("");
    expect(raw).not.toContain("Ada");
    expect(raw).not.toContain("terse answer");
    expect(raw).not.toContain("warm and complete");
    // Nothing was written to the capture table at the default metadata tier.
    const bodies = db.prepare("SELECT COUNT(*) AS n FROM gateway_capture_bodies").get() as { n: number };
    expect(bodies.n).toBe(0);
    db.close();
  });

  it("captures bodies only for a capture_tier='full' key, in the gateway's own table", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    db.prepare("UPDATE gateway_keys SET capture_tier='full' WHERE id=?1").run(GWK_ID);
    const response = await runPlayground(db);
    expect((await body(response)).content_policy).toBe("bodies_captured_full");
    const rows = db
      .prepare("SELECT role, body, key_id, request_id FROM gateway_capture_bodies ORDER BY role, body")
      .all() as { role: string; body: string; key_id: string; request_id: string }[];
    // Two variants x (request, response).
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.role))).toEqual(new Set(["request", "response"]));
    expect(rows.every((row) => row.key_id === GWK_ID)).toBe(true);
    expect(rows.every((row) => row.request_id.startsWith("plr_"))).toBe(true);
    db.close();
  });

  it("is idempotent: a rerun under a frozen clock appends nothing new", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const first = await body(await runPlayground(db));
    const second = await body(await runPlayground(db));

    expect(second.run.id).toBe(first.run.id);
    expect(second.variants.map((v: any) => v.event_id)).toEqual(
      first.variants.map((v: any) => v.event_id),
    );
    expect(runRows(db)).toHaveLength(1);
    expect(storedEvents(db, EVENT_KIND_PLAYGROUND_COMPLETED)).toHaveLength(2);
    db.close();
  });

  it("gives a different variable value its own run identity", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const first = await body(await runPlayground(db));
    const second = await body(await runPlayground(db, { variables: { customer_name: "Grace" } }));
    expect(second.run.id).not.toBe(first.run.id);
    expect(runRows(db)).toHaveLength(2);
    db.close();
  });

  it("fails closed on an upstream error: run 'error', 502, no variants body", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const { fetcher } = scriptedFetch((prompt) =>
      prompt.includes("tersely")
        ? completionBody("first variant worked")
        : new Response("{}", { status: 503 }),
    );
    const response = await runPlayground(db, {}, fetcher);
    expect(response.status).toBe(502);
    const result = await body(response);
    expect(result).toMatchObject({
      error: "upstream_error",
      status: "error",
      failed_version: 2,
      upstream_status: 503,
      variants_recorded: 1,
    });
    // No partial success the caller could mistake for a completed comparison.
    expect(result.variants).toBeUndefined();
    expect(result.diff).toBeUndefined();

    expect(runRows(db)[0].status).toBe("error");
    expect(runRows(db)[0].completed_at).toBe(NOW_SECONDS);
    // The variant that DID run keeps its evidence: those tokens were spent.
    expect(storedEvents(db, EVENT_KIND_PLAYGROUND_COMPLETED)).toHaveLength(1);
    db.close();
  });

  it("fails closed when the upstream is unreachable, with nothing recorded", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await runPlayground(db, {}, async () => {
      throw new Error("connection reset");
    });
    expect(response.status).toBe(502);
    expect((await body(response)).error).toBe("upstream_unavailable");
    expect(runRows(db)[0].status).toBe("error");
    expect(storedEvents(db, EVENT_KIND_PLAYGROUND_COMPLETED)).toHaveLength(0);
    db.close();
  });

  it("401s a bad vk_ in OUR error envelope, not the gateway's OpenAI shape", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    for (const key of ["sk-not-a-virtual-key", "vk_unknown-key"]) {
      const response = await runPlayground(db, { gateway_key: key }, neverFetch);
      expect(response.status).toBe(401);
      const result = await body(response);
      // Platform envelope: a flat string, never {error:{message,type,code}}.
      expect(result).toEqual({ error: "invalid_gateway_key" });
      expect(typeof result.error).toBe("string");
    }
    db.close();
  });

  it("answers a foreign-workspace vk_ exactly like an unknown one", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    seedGatewayKey(db, {
      id: GWK_OTHER_ID,
      workspace_id: OTHER_WORKSPACE,
      token_hash: VK_OTHER_HASH,
    });
    const response = await runPlayground(db, { gateway_key: VK_OTHER_TOKEN }, neverFetch);
    expect(response.status).toBe(401);
    // Byte-identical to the unknown-key answer: key ids cannot be probed.
    expect(await body(response)).toEqual({ error: "invalid_gateway_key" });
    db.close();
  });

  it("401s a disabled key and 429s an exhausted budget", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    db.prepare("UPDATE gateway_keys SET disabled=1 WHERE id=?1").run(GWK_ID);
    const disabled = await runPlayground(db, {}, neverFetch);
    expect(disabled.status).toBe(401);
    expect((await body(disabled)).error).toBe("gateway_key_disabled");

    db.prepare("UPDATE gateway_keys SET disabled=0, budget_amount='1', budget_spent='1' WHERE id=?1").run(GWK_ID);
    const broke = await runPlayground(db, {}, neverFetch);
    expect(broke.status).toBe(429);
    expect((await body(broke)).error).toBe("budget_exhausted");
    db.close();
  });

  it("503s fail-closed with no sealing key, without creating a run", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await runPlayground(db, {}, neverFetch, { DB: sqliteDb(db) });
    expect(response.status).toBe(503);
    expect((await body(response)).error).toBe("gateway_sealing_key_unavailable");
    expect(runRows(db)).toHaveLength(0);
    db.close();
  });

  it("400s a body that is not a JSON object", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await handlePlaygroundRoute(
      request("/v1/playground/run", { method: "POST", headers: authed(), body: "[]" }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    expect(response?.status).toBe(400);
    db.close();
  });
});

// =============================================================================
// GET /v1/playground/runs
// =============================================================================

describe("GET /v1/playground/runs", () => {
  it("returns the {items, next_cursor} envelope, newest first", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await runPlayground(db);
    await runPlayground(db, { variables: { customer_name: "Grace" } });

    const response = await handlePlaygroundRoute(
      request("/v1/playground/runs", { headers: authed(READ_ONLY_TOKEN) }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    expect(response?.status).toBe(200);
    const result = await body(response as Response);
    expect(result.items).toHaveLength(2);
    expect(result.next_cursor).toBeNull();
    expect(result.items[0]).toMatchObject({ prompt_name: PROMPT, versions: [1, 2], status: "done" });
    db.close();
  });

  it("emits a cursor when another page exists", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await runPlayground(db);
    await runPlayground(db, { variables: { customer_name: "Grace" } });
    const response = await handlePlaygroundRoute(
      request("/v1/playground/runs?limit=1", { headers: authed() }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    const result = await body(response as Response);
    expect(result.items).toHaveLength(1);
    expect(typeof result.next_cursor).toBe("string");
    db.close();
  });

  it("never lists another workspace's runs", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await runPlayground(db);
    // A foreign run, inserted directly: migration 0014's identity trigger
    // refuses to MOVE an existing run between workspaces, which is the
    // stronger guarantee and is asserted right below.
    db.prepare(
      `INSERT INTO playground_runs
         (id, workspace_id, prompt_name, versions, model, status, created_at)
       VALUES (?1, ?2, 'foreign', '[1]', 'm', 'running', ?3)`,
    ).run(`plr_01J${"F".repeat(23)}`, OTHER_WORKSPACE, NOW_SECONDS);
    expect(() =>
      db.prepare("UPDATE playground_runs SET workspace_id=?1 WHERE workspace_id=?2")
        .run(OTHER_WORKSPACE, TOKEN_WORKSPACE),
    ).toThrow(/identity is immutable/);

    const response = await handlePlaygroundRoute(
      request("/v1/playground/runs", { headers: authed() }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    const items = (await body(response as Response)).items;
    expect(items).toHaveLength(1);
    expect(items[0].prompt_name).toBe(PROMPT);
    db.close();
  });
});

// =============================================================================
// POST /v1/prompts/{name}/labels — the CI gate (parity row 36)
// =============================================================================

describe("POST /v1/prompts/{name}/labels", () => {
  async function repoint(
    db: DatabaseSync,
    payload: Record<string, unknown>,
    token = DEVICE_TOKEN,
    now: () => number = frozenClock,
    name = PROMPT,
  ): Promise<Response> {
    const response = await handlePlaygroundRoute(
      request(`/v1/prompts/${encodeURIComponent(name)}/labels`, {
        method: "POST",
        headers: authed(token),
        body: JSON.stringify(payload),
      }),
      makeEnv(db),
      neverFetch,
      now,
    );
    expect(response).not.toBeNull();
    return response as Response;
  }

  it("appends an OBSERVED prompt.labeled event with no gate requested", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await repoint(db, { label: "production", version: 2 });
    expect(response.status).toBe(201);
    const result = await body(response);
    expect(result).toMatchObject({
      label: { name: PROMPT, label: "production", version: 2 },
      provenance: "OBSERVED",
      gate: null,
    });

    const events = storedEvents(db, EVENT_KIND_PROMPT_LABELED);
    expect(events).toHaveLength(1);
    expect(events[0].provenance).toBe("OBSERVED");
    // Byte-compatible with the Go CLI's own payload.
    expect(payloadOf(events[0])).toEqual({ label: "production", name: PROMPT, version: 2 });
    db.close();
  });

  it("moves the label as quality.ts's own read model resolves it", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await repoint(db, { label: "production", version: 1 });
    const { byName } = await materializePromptEvents(sqliteDb(db), TOKEN_WORKSPACE);
    const resolved = resolveLabels(byName.get(PROMPT)!);
    expect(resolved.get("production")).toBe(1);
    expect(resolved.get("latest")).toBe(2);
    db.close();
  });

  it("passes the gate when the latest linked score clears min_score", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.91", promptName: PROMPT, version: 2 }),
    });
    const response = await repoint(db, {
      label: "production",
      version: 2,
      score_name: "acc",
      min_score: "0.80",
    });
    expect(response.status).toBe(201);
    const result = await body(response);
    expect(result.gate).toMatchObject({
      score_name: "acc",
      min_score: "0.80",
      latest_score: "0.91",
      passed: true,
      forced: false,
    });
    // The audit is on the spine too, not just in the response.
    expect(payloadOf(storedEvents(db, EVENT_KIND_PROMPT_LABELED)[0]).gate.passed).toBe(true);
    db.close();
  });

  it("409s eval_gate_failed below the threshold, and does NOT move the label", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.40", promptName: PROMPT, version: 2 }),
    });
    const response = await repoint(db, {
      label: "production",
      version: 2,
      score_name: "acc",
      min_score: "0.80",
    });
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({
      error: "eval_gate_failed",
      latest_score: "0.40",
      min_score: "0.80",
    });
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(0);
    db.close();
  });

  it("409s with latest_score null when no evaluation has ever run", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await repoint(db, {
      label: "production",
      version: 2,
      score_name: "acc",
      min_score: "0.80",
    });
    expect(response.status).toBe(409);
    // Absent evidence is a failure, not a pass. A gate that defaults open is
    // decoration.
    expect(await body(response)).toMatchObject({ error: "eval_gate_failed", latest_score: null });
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(0);
    db.close();
  });

  it("force:true overrides the gate and AUDITS the refusal into the payload", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.40", promptName: PROMPT, version: 2 }),
    });
    const response = await repoint(db, {
      label: "production",
      version: 2,
      score_name: "acc",
      min_score: "0.80",
      force: true,
    });
    expect(response.status).toBe(201);

    const gate = payloadOf(storedEvents(db, EVENT_KIND_PROMPT_LABELED)[0]).gate;
    // An override that left no trace would make `force` a way to launder an
    // unevaluated prompt into production.
    expect(gate).toMatchObject({
      score_name: "acc",
      min_score: "0.80",
      latest_score: "0.40",
      passed: false,
      forced: true,
    });
    expect(typeof gate.latest_score_event_id).toBe("string");
    db.close();
  });

  it("rolls back through the same gated route, and the label actually moves", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await repoint(db, { label: "production", version: 1 }, DEVICE_TOKEN, () => NOW_MS);
    await repoint(db, { label: "production", version: 2 }, DEVICE_TOKEN, () => NOW_MS + 1000);
    // The rollback: (name, label, version) repeats the first event exactly.
    const rollback = await repoint(
      db,
      { label: "production", version: 1 },
      DEVICE_TOKEN,
      () => NOW_MS + 2000,
    );
    expect(rollback.status).toBe(201);

    const events = storedEvents(db, EVENT_KIND_PROMPT_LABELED);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.event_id)).size).toBe(3);

    const { byName } = await materializePromptEvents(sqliteDb(db), TOKEN_WORKSPACE);
    expect(resolveLabels(byName.get(PROMPT)!).get("production")).toBe(1);
    db.close();
  });

  it("is idempotent for a retried write inside the same millisecond", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    await repoint(db, { label: "production", version: 2 });
    await repoint(db, { label: "production", version: 2 });
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(1);
    db.close();
  });

  it("404s an unknown prompt, an unknown version, and another workspace's prompt", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, OTHER_WORKSPACE, {
      kind: "prompt.created",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: promptCreated("foreign-only", 1, "secret"),
    });
    expect((await repoint(db, { label: "p", version: 1 }, DEVICE_TOKEN, frozenClock, "nope")).status).toBe(404);
    expect((await repoint(db, { label: "p", version: 9 })).status).toBe(404);
    expect(
      (await repoint(db, { label: "p", version: 1 }, DEVICE_TOKEN, frozenClock, "foreign-only")).status,
    ).toBe(404);
    db.close();
  });

  it("accepts an sk_ key with the write scope and refuses a read-only one", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const written = await repoint(db, { label: "production", version: 2 }, API_KEY_WRITE);
    expect(written.status).toBe(201);

    const refused = await repoint(db, { label: "staging", version: 2 }, API_KEY_READ);
    expect(refused.status).toBe(403);
    expect(await body(refused)).toEqual({ error: "forbidden" });

    const unknown = await repoint(db, { label: "staging", version: 2 }, "sk_totally-unknown");
    expect(unknown.status).toBe(401);
    db.close();
  });

  it("dry_run runs every check and appends nothing", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.91", promptName: PROMPT, version: 2 }),
    });
    const response = await repoint(
      db,
      { label: "production", version: 2, score_name: "acc", min_score: "0.80", dry_run: true },
      API_KEY_WRITE,
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      dry_run: true,
      would_apply: true,
      label: { name: PROMPT, label: "production", version: 2 },
      gate: { passed: true, latest_score: "0.91" },
    });
    // Nothing appended, so the label did NOT move.
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(0);
    db.close();
  });

  it("dry_run still 404s an unknown version and 409s a failing gate", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    expect((await repoint(db, { label: "production", version: 9, dry_run: true })).status).toBe(404);

    const gated = await repoint(db, {
      label: "production",
      version: 2,
      score_name: "acc",
      min_score: "0.80",
      dry_run: true,
    });
    expect(gated.status).toBe(409);
    expect((await body(gated)).error).toBe("eval_gate_failed");
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(0);
    db.close();
  });

  it("400s a non-boolean dry_run", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await repoint(db, { label: "production", version: 2, dry_run: "yes" });
    expect(response.status).toBe(400);
    db.close();
  });

  it("400s the computed 'latest' label", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await repoint(db, { label: "latest", version: 1 });
    expect(response.status).toBe(400);
    db.close();
  });

  it("does not shadow quality.ts's GET /v1/prompts routes", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    for (const path of ["/v1/prompts", "/v1/prompts/show?name=x"]) {
      const response = await handlePlaygroundRoute(
        request(path, { headers: authed() }),
        makeEnv(db),
        neverFetch,
        frozenClock,
      );
      expect(response).toBeNull();
    }
    db.close();
  });
});

// =============================================================================
// POST /v1/prompt-optimizer/suggest (parity row 30)
// =============================================================================

describe("POST /v1/prompt-optimizer/suggest", () => {
  const SUGGESTION = JSON.stringify({
    suggested_body: "Answer {{customer_name}} warmly, with a concrete next step.",
    rationale: "Low scores cite missing next steps.",
  });

  async function suggest(
    db: DatabaseSync,
    overrides: Record<string, unknown> = {},
    fetcher: FetchLike = scriptedFetch(() => completionBody(SUGGESTION)).fetcher,
  ): Promise<Response> {
    const response = await handlePlaygroundRoute(
      request("/v1/prompt-optimizer/suggest", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          prompt_name: PROMPT,
          gateway_key: VK_TOKEN,
          model: MODEL,
          ...overrides,
        }),
      }),
      makeEnv(db),
      fetcher,
      frozenClock,
    );
    expect(response).not.toBeNull();
    return response as Response;
  }

  it("records an INFERRED suggestion, says so in the response, and applies nothing", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({
        name: "acc",
        value: "0.20",
        promptName: PROMPT,
        version: 2,
        comment: "no next step offered",
      }),
    });
    const response = await suggest(db);
    expect(response.status).toBe(200);
    const result = await body(response);

    expect(result.provenance).toBe("INFERRED");
    expect(result.auto_applied).toBe(false);
    expect(result.suggestion).toMatchObject({
      prompt_name: PROMPT,
      base_version: 2,
      suggested_body: "Answer {{customer_name}} warmly, with a concrete next step.",
      sample_size: 1,
    });
    expect(result.suggestion.suggested_body_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.suggestion.evidence_event_ids).toHaveLength(1);

    const events = storedEvents(db, EVENT_KIND_SUGGESTION_RECORDED);
    expect(events).toHaveLength(1);
    expect(events[0].provenance).toBe("INFERRED");
    const payload = payloadOf(events[0]);
    expect(payload.suggestion_provenance).toBe("INFERRED");
    expect(payload.applied).toBe(false);
    // The suggested body itself is never stored — only its digest.
    expect(events[0].raw_json).not.toContain("concrete next step");
    expect(payload.suggested_body_hash).toBe(result.suggestion.suggested_body_hash);

    // NOTHING was applied: no label moved, no version created.
    expect(storedEvents(db, EVENT_KIND_PROMPT_LABELED)).toHaveLength(0);
    expect(storedEvents(db, "prompt.created")).toHaveLength(2);
    db.close();
  });

  it("shows the model only low-scoring evidence for the base version", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-01T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.95", promptName: PROMPT, version: 2, comment: "HIGH" }),
    });
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-02T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.10", promptName: PROMPT, version: 2, comment: "LOW" }),
    });
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-02-03T00:00:00Z",
      payload: promptScore({ name: "acc", value: "0.10", promptName: PROMPT, version: 1, comment: "OTHERVERSION" }),
    });
    const { fetcher, calls } = scriptedFetch(() => completionBody(SUGGESTION));
    await suggest(db, {}, fetcher);
    expect(calls[0].prompt).toContain("LOW");
    expect(calls[0].prompt).not.toContain("HIGH");
    expect(calls[0].prompt).not.toContain("OTHERVERSION");
    db.close();
  });

  it("still suggests with no evidence, and says the sample was empty", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const result = await body(await suggest(db));
    expect(result.suggestion.sample_size).toBe(0);
    expect(result.suggestion.evidence_event_ids).toEqual([]);
    db.close();
  });

  it("502s fail-closed on an unparseable model reply, appending nothing", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await suggest(
      db,
      {},
      scriptedFetch(() => completionBody("Sure! Here's a better prompt: be nicer.")).fetcher,
    );
    expect(response.status).toBe(502);
    expect((await body(response)).error).toBe("unparseable_suggestion");
    expect(storedEvents(db, EVENT_KIND_SUGGESTION_RECORDED)).toHaveLength(0);
    db.close();
  });

  it("502s when the upstream itself failed", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await suggest(db, {}, async () => new Response("{}", { status: 500 }));
    expect(response.status).toBe(502);
    expect(storedEvents(db, EVENT_KIND_SUGGESTION_RECORDED)).toHaveLength(0);
    db.close();
  });

  it("404s an unknown prompt and another workspace's prompt", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    insertEvent(db, OTHER_WORKSPACE, {
      kind: "prompt.created",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: promptCreated("foreign-only", 1, "secret"),
    });
    expect((await suggest(db, { prompt_name: "nope" }, neverFetch)).status).toBe(404);
    expect((await suggest(db, { prompt_name: "foreign-only" }, neverFetch)).status).toBe(404);
    db.close();
  });

  it("403s a read-only device: proposing a rewrite spends money", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const response = await handlePlaygroundRoute(
      request("/v1/prompt-optimizer/suggest", {
        method: "POST",
        headers: authed(READ_ONLY_TOKEN),
        body: JSON.stringify({ prompt_name: PROMPT, gateway_key: VK_TOKEN, model: MODEL }),
      }),
      makeEnv(db),
      neverFetch,
      frozenClock,
    );
    expect(response?.status).toBe(403);
    db.close();
  });

  it("optimizerPrompt states the no-new-placeholder rule", () => {
    const rendered = optimizerPrompt(PROMPT, 2, "Hi {{name}}", []);
    expect(rendered).toContain("{{variable}}");
    expect(rendered).toContain("exactly ONE improved prompt body");
    expect(rendered).toContain("no low-scoring evaluations");
  });
});

// =============================================================================
// routing
// =============================================================================

describe("routing", () => {
  it("returns null for unknown paths and for a known path with the wrong method", async () => {
    const db = migratedDatabase();
    seedWorld(db);
    const env = makeEnv(db);
    const cases: [string, string][] = [
      ["/v1/unknown", "GET"],
      ["/v1/playground/run", "GET"],
      ["/v1/playground/runs", "POST"],
      ["/v1/prompt-optimizer/suggest", "GET"],
      [`/v1/prompts/${PROMPT}/labels`, "GET"],
      [`/v1/prompts/${PROMPT}/labels/extra`, "POST"],
    ];
    for (const [path, method] of cases) {
      const response = await handlePlaygroundRoute(
        request(path, { method, headers: authed(), ...(method === "POST" ? { body: "{}" } : {}) }),
        env,
        neverFetch,
        frozenClock,
      );
      expect(response, `${method} ${path}`).toBeNull();
    }
    db.close();
  });
});

// =============================================================================
// the shipped GitHub Action example (parity row 36)
// =============================================================================

describe(".github/workflows/prompt-ci.yml.example", () => {
  const examplePath = resolve(repoRoot, ".github/workflows/prompt-ci.yml.example");
  const source = readFileSync(examplePath, "utf8");

  it("carries the .example suffix and has no runnable sibling in this repo", () => {
    // GitHub Actions only loads .yml/.yaml, so the suffix is what keeps this
    // documentation from firing a job here or needing secrets in this repo.
    expect(existsSync(examplePath)).toBe(true);
    expect(existsSync(resolve(repoRoot, ".github/workflows/prompt-ci.yml"))).toBe(false);
    expect(existsSync(resolve(repoRoot, ".github/workflows/prompt-ci.yaml"))).toBe(false);
  });

  it("is structurally a workflow: top-level keys at column 0, spaces only", () => {
    expect(source).not.toContain("\t");
    for (const key of ["name:", "on:", "concurrency:", "env:", "jobs:"]) {
      expect(source).toMatch(new RegExp(`^${key}`, "m"));
    }
    expect(source).toMatch(/^name: prompt-ci$/m);
    expect(source).toMatch(/^ {2}promote:$/m);
    expect(source).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(source).toMatch(/^ {4}steps:$/m);
  });

  it("validates with dry_run before promoting, on the endpoint this slice ships", () => {
    expect(source).toContain("/v1/prompts/${encoded}/labels");
    expect(source).toContain("dry_run:true");
    expect(source).toContain("-X POST");
    // The dry run must come BEFORE the real repoint, or it validates nothing.
    expect(source.indexOf("dry_run:true")).toBeLessThan(source.indexOf("Repoint the label"));
    // It must not reach for a device-token-only read route with an sk_ key.
    expect(source).not.toContain("/v1/prompts/show");
  });

  it("uses an sk_ secret and never a device token", () => {
    expect(source).toContain("secrets.HANDOFFGRAPH_API_KEY");
    expect(source).toContain("Authorization: Bearer ${HANDOFFGRAPH_API_KEY}");
    // Exactly one secret is referenced, so a copy-paste user has one thing to set.
    const referenced = new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect([...referenced]).toEqual(["HANDOFFGRAPH_API_KEY"]);
    expect(source).not.toContain("DEVICE_TOKEN=");
  });

  it("sends the eval gate and handles its 409 as a build failure", () => {
    expect(source).toContain("min_score");
    expect(source).toContain("score_name");
    expect(source).toContain("eval_gate_failed");
    expect(source).toMatch(/409\)/);
    // The gate must FAIL the build, never warn and continue.
    expect(source).toContain("exit 1");
  });

  it("documents rollback as the same route and needs no marketplace action", () => {
    expect(source).toContain("workflow_dispatch");
    expect(source).toMatch(/rollback/i);
    expect(source).not.toMatch(/^\s*- uses: /m);
    expect(source).toContain("set -euo pipefail");
  });

  it("never interpolates a ${{ }} expression into a shell script", () => {
    // `${{ }}` is substituted before the shell sees it, so an expression inline
    // in a `run:` block is a script-injection hole. Every dynamic value must be
    // bound through `env:` and referenced as "$VAR".
    const runBlocks = source.split(/^ {6}- name: /m).slice(1);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      const script = block.slice(block.indexOf("run: |"));
      expect(script).not.toContain("${{");
    }
    for (const name of ["PROMPT_NAME", "PROMPT_VERSION", "PROMPT_LABEL", "PROMPT_FORCE"]) {
      expect(source).toMatch(new RegExp(`^ {6}${name}: \\$\\{\\{`, "m"));
      expect(source).toContain(`"$${name}"`);
    }
  });

  it("notes that prompt.labeled already fans out over webhooks", () => {
    expect(source).toContain("prompt.labeled");
    expect(source).toContain("DEFAULT_INTERESTING_KINDS");
  });
});
