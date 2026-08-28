// Tests for src/quality.ts: the hosted quality-loop read APIs (datasets x
// experiments, the prompt store, scores) derived at read time from the
// events table.
//
// Every handler-level test runs against REAL SQLite (node:sqlite
// DatabaseSync with migration 0001 applied — the only migration that
// matters here, since this module owns no tables of its own and only reads
// `devices` for auth and `events` for derivation), wrapped in a small
// D1DatabaseLike adapter. This module's correctness lives almost entirely in
// its SQL scan text (WHERE kind [=|IN], ORDER BY seq, LIMIT) and in the
// Go-payload-shape parsing, so exercising literal SQL through real SQLite
// catches mistakes a hand-rolled JS mock could hide; unlike sibling test
// files there is no separate "schema truth" section because every test
// already is one.
//
// Payload fixtures below copy the exact wire key names emitted by the Go
// CLI (internal/datasets, internal/prompts, internal/scores + their
// internal/commands callers) — see the comment above each payload builder
// for the Go source it mirrors.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { D1BoundStatement, D1DatabaseLike, D1RunResultLike, D1Statement } from "../src/db";
import {
  MAX_MATERIALIZE_ROWS,
  compareExperimentRuns,
  handleQualityRoute,
  latestVersion,
  materializeDatasets,
  materializeExperiments,
  materializePromptEvents,
  materializeScores,
  resolveLabels,
  type ExampleResult,
  type ExperimentRecord,
  type QualityEnv,
} from "../src/quality";

// -- SQLite-backed D1DatabaseLike adapter --------------------------------------

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(sql: string): D1Statement {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]): D1BoundStatement {
        const params = values as (null | number | bigint | string | Uint8Array)[];
        return {
          async first<T>(): Promise<T | null> {
            const row = sqlite.prepare(sql).get(...params);
            return (row === undefined ? null : (row as T));
          },
          async all<T>(): Promise<{ results: T[] }> {
            const rows = sqlite.prepare(sql).all(...params);
            return { results: rows as T[] };
          },
          async run<T>(): Promise<D1RunResultLike<T>> {
            sqlite.prepare(sql).run(...params);
            return { success: true };
          },
        };
      },
    };
  }

  async batch(statements: D1BoundStatement[]): Promise<D1RunResultLike[]> {
    const out: D1RunResultLike[] = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const testDirectory = dirname(fileURLToPath(import.meta.url));

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(testDirectory, "../migrations/0001_init.sql"), "utf8"));
  return db;
}

function makeEnv(db: DatabaseSync): QualityEnv {
  return { DB: new SqliteD1(db) };
}

// -- fixtures -------------------------------------------------------------------

const TOKEN_WORKSPACE = "wsp_01HTSTW0RKSPACE0000000000Z";
const OTHER_WORKSPACE = "wsp_01HTSTW0RKSPEER0000000000Z";
const DEVICE_TOKEN = "dev_test-token-0001";
const DEVICE_ID = "dev_01HTSTDEV0000000000000000Z";
const READ_ONLY_TOKEN = "dev_test-token-read-only";
const READ_ONLY_DEVICE_ID = "dev_01HTSTDEVREADONLY00000Z";
const NO_CAPS_TOKEN = "dev_test-token-no-caps";
const NO_CAPS_DEVICE_ID = "dev_01HTSTDEVNOCAPS000000Z";

let TOKEN_HASH = "";
let READ_ONLY_HASH = "";
let NO_CAPS_HASH = "";

beforeAll(async () => {
  TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
  READ_ONLY_HASH = await sha256Hex(READ_ONLY_TOKEN);
  NO_CAPS_HASH = await sha256Hex(NO_CAPS_TOKEN);
});

function insertDevice(
  db: DatabaseSync,
  params: { id: string; workspaceId: string; tokenHash: string; capabilities: string },
): void {
  db.prepare(
    `INSERT INTO devices (id, workspace_id, token_hash, capabilities, created_at)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(params.id, params.workspaceId, params.tokenHash, params.capabilities);
}

function seedDevices(db: DatabaseSync): void {
  insertDevice(db, { id: DEVICE_ID, workspaceId: TOKEN_WORKSPACE, tokenHash: TOKEN_HASH, capabilities: "ingest,read" });
  insertDevice(db, { id: READ_ONLY_DEVICE_ID, workspaceId: TOKEN_WORKSPACE, tokenHash: READ_ONLY_HASH, capabilities: "read" });
  insertDevice(db, { id: NO_CAPS_DEVICE_ID, workspaceId: TOKEN_WORKSPACE, tokenHash: NO_CAPS_HASH, capabilities: "ingest" });
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

/** Insert one event row with a fully-formed hfg.event.v1 envelope wrapping `payload`. */
function insertEvent(
  db: DatabaseSync,
  workspaceId: string,
  params: { eventId?: string; kind: string; occurredAt: string; provenance?: string | null; payload: unknown },
): string {
  const eventId = params.eventId ?? nextEventId();
  const provenance = params.provenance === undefined ? "OBSERVED" : params.provenance;
  const envelope: Record<string, unknown> = {
    schema_version: "hfg.event.v1",
    event_id: eventId,
    kind: params.kind,
    occurred_at: params.occurredAt,
    observed_at: params.occurredAt,
    payload: params.payload,
  };
  if (provenance !== null) envelope.provenance = provenance;
  db.prepare(INSERT_EVENT_SQL).run(workspaceId, eventId, params.occurredAt, params.kind, provenance, JSON.stringify(envelope));
  return eventId;
}

/** Insert a row whose raw_json is exactly the caller's string — for envelope-level malformed-row cases. */
function insertRawEvent(db: DatabaseSync, workspaceId: string, kind: string, rawJson: string): void {
  db.prepare(INSERT_EVENT_SQL).run(workspaceId, nextEventId(), "2026-01-01T00:00:00Z", kind, "OBSERVED", rawJson);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.handoffgraph.dev${path}`, init);
}

function authed(token: string = DEVICE_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function body(response: Response): Promise<any> {
  return await response.json();
}

// -- Go-shaped payload builders ---------------------------------------------------

/** Mirrors dataset_cmd.go's datasetCreate: json.Marshal({name, version, files}). */
function datasetPayload(
  name: string,
  version: string,
  files: { name: string; hash: string; event_count: number }[],
): unknown {
  return { name, version, files };
}

/**
 * Mirrors dataset_cmd.go's experimentRunCmd: json.Marshal(datasets.
 * ExperimentRecord{Dataset, Version, Passed, Results}) — which, because it
 * marshals the WHOLE struct, also puts dead zero-valued `event_id`/
 * `created_at` keys on the wire. `includeDeadFields` reproduces that
 * literally so a test can prove they are ignored in favor of the envelope.
 */
function experimentPayload(
  dataset: string,
  version: string,
  passed: boolean,
  results: unknown[],
  includeDeadFields = false,
): unknown {
  const out: Record<string, unknown> = { dataset, version, passed, results };
  if (includeDeadFields) {
    out.event_id = "";
    out.created_at = "0001-01-01T00:00:00Z";
  }
  return out;
}

function exampleResult(overrides: Partial<ExampleResult>): ExampleResult {
  return { name: "example.jsonl", hash: "sha256:aa", events: 1, traces: 1, spans: 1, p0_detections: 0, status: "ok", ...overrides };
}

/** Mirrors prompts.NewCreatedEvent + AssignVersion: {name, version, body, hash, created_by}. */
function promptCreatedPayload(name: string, version: number, body_: string, hash: string, createdBy = ""): unknown {
  return { name, version, body: body_, hash, created_by: createdBy };
}

/** Mirrors prompts.NewLabeledEvent: {name, label, version}. */
function promptLabeledPayload(name: string, label: string, version: number): unknown {
  return { name, label, version };
}

/** Mirrors scores.Validate's payload map: {name, data_type, value, target_type, target_id, source, comment?}. */
function scorePayload(fields: {
  name: string;
  data_type: string;
  value: string;
  target_type: string;
  target_id: string;
  source: string;
  comment?: string;
}): unknown {
  const { comment, ...rest } = fields;
  return comment === undefined ? rest : { ...rest, comment };
}

// =============================================================================
// auth & routing
// =============================================================================

describe("auth and routing", () => {
  it("returns null for a path this module does not own", async () => {
    const db = migratedDatabase();
    const response = await handleQualityRoute(request("/v1/other"), makeEnv(db));
    expect(response).toBeNull();
  });

  it("returns null (not 405) for a known path with the wrong method", async () => {
    const db = migratedDatabase();
    const response = await handleQualityRoute(request("/v1/datasets", { method: "POST" }), makeEnv(db));
    expect(response).toBeNull();
  });

  it("401s with no Authorization header", async () => {
    const db = migratedDatabase();
    const response = await handleQualityRoute(request("/v1/datasets"), makeEnv(db));
    expect(response?.status).toBe(401);
  });

  it("401s for an unknown token", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed("dev_no-such-token") }), makeEnv(db));
    expect(response?.status).toBe(401);
  });

  it("403s for a device lacking the read capability", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed(NO_CAPS_TOKEN) }), makeEnv(db));
    expect(response?.status).toBe(403);
  });

  it("allows a read-only device", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed(READ_ONLY_TOKEN) }), makeEnv(db));
    expect(response?.status).toBe(200);
  });
});

// =============================================================================
// GET /v1/datasets
// =============================================================================

describe("GET /v1/datasets", () => {
  it("returns an empty envelope with meta.skipped_malformed=0 for an empty workspace", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(200);
    const b = await body(response!);
    expect(b).toEqual({ items: [], next_cursor: null, meta: { skipped_malformed: 0 } });
  });

  it("flattens one dataset.created event: content_hash mirrors version, example_count is len(files)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "dataset.created",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: datasetPayload("regressions", "sha256:aaaa", [
        { name: "a.jsonl", hash: "sha256:1111", event_count: 3 },
        { name: "b.jsonl", hash: "sha256:2222", event_count: 5 },
      ]),
    });
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([
      { name: "regressions", version: "sha256:aaaa", example_count: 2, content_hash: "sha256:aaaa", created_at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("sorts name-then-version and groups multiple versions of one name", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-03T00:00:00Z", payload: datasetPayload("zeta", "sha256:z1", [{ name: "a", hash: "h", event_count: 1 }]) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: datasetPayload("alpha", "sha256:b", [{ name: "a", hash: "h", event_count: 1 }]) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-02T00:00:00Z", payload: datasetPayload("alpha", "sha256:a", [{ name: "a", hash: "h", event_count: 1 }]) });
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items.map((i: any) => [i.name, i.version])).toEqual([
      ["alpha", "sha256:a"],
      ["alpha", "sha256:b"],
      ["zeta", "sha256:z1"],
    ]);
  });

  it("skips malformed rows and counts them without failing the request", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    // valid
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: datasetPayload("good", "sha256:g", [{ name: "a", hash: "h", event_count: 1 }]) });
    // payload is not an object
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: "not-an-object" });
    // missing name
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: { version: "sha256:x", files: [] } });
    // empty version
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: { name: "n", version: "", files: [] } });
    // files is the wrong type
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: { name: "n", version: "v", files: "not-an-array" } });
    // one nested file entry has a wrong-typed event_count -> the WHOLE event is dropped, not just that file
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "dataset.created",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { name: "n2", version: "v2", files: [{ name: "a", hash: "h", event_count: "three" }] },
    });
    // envelope-level malformed: event_id is not a string
    insertRawEvent(db, TOKEN_WORKSPACE, "dataset.created", JSON.stringify({ event_id: 42, kind: "dataset.created", occurred_at: "2026-01-01T00:00:00Z", payload: datasetPayload("x", "sha256:x", []) }));

    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].name).toBe("good");
    expect(b.meta.skipped_malformed).toBe(6);
  });

  it("never returns another workspace's datasets (foreign workspace 404-equivalent: simply absent)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, OTHER_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: datasetPayload("secret", "sha256:s", [{ name: "a", hash: "h", event_count: 1 }]) });
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([]);
  });

  it("is deterministic across repeated requests", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-01T00:00:00Z", payload: datasetPayload("a", "sha256:1", [{ name: "x", hash: "h", event_count: 1 }]) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "dataset.created", occurredAt: "2026-01-02T00:00:00Z", payload: datasetPayload("b", "sha256:2", [{ name: "x", hash: "h", event_count: 1 }]) });
    const env = makeEnv(db);
    const first = await body((await handleQualityRoute(request("/v1/datasets", { headers: authed() }), env))!);
    const second = await body((await handleQualityRoute(request("/v1/datasets", { headers: authed() }), env))!);
    expect(second).toEqual(first);
  });
});

// =============================================================================
// GET /v1/experiments
// =============================================================================

describe("GET /v1/experiments", () => {
  it("computes passed_count/failed_count from per-example status (only 'ok' counts as passed)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "experiment.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: experimentPayload("ds", "sha256:v1", false, [
        exampleResult({ name: "a", status: "ok" }),
        exampleResult({ name: "b", status: "detections", p0_detections: 1 }),
        exampleResult({ name: "c", status: "invalid" }),
      ]),
    });
    const response = await handleQualityRoute(request("/v1/experiments", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].passed_count).toBe(1);
    expect(b.items[0].failed_count).toBe(2);
  });

  it("ignores the payload's own dead event_id/created_at and uses the envelope instead", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const realId = insertEvent(db, TOKEN_WORKSPACE, {
      kind: "experiment.recorded",
      occurredAt: "2026-05-05T00:00:00Z",
      payload: experimentPayload("ds", "sha256:v1", true, [exampleResult({})], true),
    });
    const response = await handleQualityRoute(request("/v1/experiments", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items[0].id).toBe(realId);
    expect(b.items[0].created_at).toBe("2026-05-05T00:00:00Z");
  });

  it("filters by ?dataset=", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("alpha", "v1", true, [exampleResult({})]) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("beta", "v1", true, [exampleResult({})]) });
    const response = await handleQualityRoute(request("/v1/experiments?dataset=alpha", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].dataset).toBe("alpha");
  });

  it("sorts ascending by (occurred_at, id) — the raw materializer's own order", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    // Insert the chronologically-later run first so insertion order cannot
    // be mistaken for the sort key.
    const later = insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-02-01T00:00:00Z", payload: experimentPayload("ds", "v2", true, [exampleResult({})]) });
    const earlier = insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("ds", "v1", true, [exampleResult({})]) });
    const response = await handleQualityRoute(request("/v1/experiments", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items.map((i: any) => i.id)).toEqual([earlier, later]);
  });

  it("skips a malformed nested result and drops the WHOLE event, not just that entry", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "experiment.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: experimentPayload("ds", "v1", true, [exampleResult({ name: "a" }), { name: "b", events: "not-a-number" }]),
    });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: { dataset: "", version: "v1", passed: true, results: [] } });
    const response = await handleQualityRoute(request("/v1/experiments", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([]);
    expect(b.meta.skipped_malformed).toBe(2);
  });
});

// =============================================================================
// GET /v1/experiments/compare
// =============================================================================

describe("GET /v1/experiments/compare", () => {
  it("400s when a or b is missing", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/experiments/compare?a=evt_x", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(400);
  });

  it("404s for unknown run ids", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/experiments/compare?a=evt_nope&b=evt_also-nope", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(404);
  });

  it("404s for a run id that only exists in a foreign workspace", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const foreignId = insertEvent(db, OTHER_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("ds", "v1", true, [exampleResult({})]) });
    const ownId = insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("ds", "v1", true, [exampleResult({})]) });
    const response = await handleQualityRoute(
      request(`/v1/experiments/compare?a=${ownId}&b=${foreignId}`, { headers: authed() }),
      makeEnv(db),
    );
    expect(response?.status).toBe(404);
  });

  it("mirrors Compare semantics: regressions, recoveries, p0 increases, and missing-from-baseline skip", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const a = insertEvent(db, TOKEN_WORKSPACE, {
      kind: "experiment.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: experimentPayload("ds", "v1", true, [
        exampleResult({ name: "regressed.jsonl", status: "ok", p0_detections: 0 }),
        exampleResult({ name: "recovered.jsonl", status: "detections", p0_detections: 1 }),
        exampleResult({ name: "same.jsonl", status: "ok", p0_detections: 0 }),
        exampleResult({ name: "more-p0.jsonl", status: "detections", p0_detections: 1 }),
      ]),
    });
    const b = insertEvent(db, TOKEN_WORKSPACE, {
      kind: "experiment.recorded",
      occurredAt: "2026-01-02T00:00:00Z",
      payload: experimentPayload("ds", "v2", false, [
        exampleResult({ name: "regressed.jsonl", status: "detections", p0_detections: 1 }),
        exampleResult({ name: "recovered.jsonl", status: "ok", p0_detections: 0 }),
        exampleResult({ name: "same.jsonl", status: "ok", p0_detections: 0 }),
        exampleResult({ name: "more-p0.jsonl", status: "detections", p0_detections: 2 }),
        exampleResult({ name: "new-example.jsonl", status: "ok", p0_detections: 0 }), // absent from baseline -> skipped
      ]),
    });
    const response = await handleQualityRoute(request(`/v1/experiments/compare?a=${a}&b=${b}`, { headers: authed() }), makeEnv(db));
    const body_ = await body(response!);
    expect(body_.items.map((i: any) => i.file)).toEqual(["more-p0.jsonl", "recovered.jsonl", "regressed.jsonl", "same.jsonl"]);
    const byFile = Object.fromEntries(body_.items.map((i: any) => [i.file, i]));
    expect(byFile["regressed.jsonl"].regression).toBe(true);
    expect(byFile["recovered.jsonl"].regression).toBe(false);
    expect(byFile["same.jsonl"].regression).toBe(false);
    expect(byFile["more-p0.jsonl"].regression).toBe(true); // same status, p0 went up
    expect(body_.items.find((i: any) => i.file === "new-example.jsonl")).toBeUndefined();
    expect(body_.regressions).toBe(2);
    expect(body_.a.id).toBe(a);
    expect(body_.b.id).toBe(b);
  });
});

describe("compareExperimentRuns (pure)", () => {
  it("skips an example missing from the baseline run", () => {
    const a: ExperimentRecord = { seq: 1, event_id: "a", dataset: "d", version: "v1", passed: true, results: [exampleResult({ name: "only-in-a" })], created_at: "2026-01-01T00:00:00Z" };
    const b: ExperimentRecord = { seq: 2, event_id: "b", dataset: "d", version: "v2", passed: true, results: [exampleResult({ name: "only-in-b" })], created_at: "2026-01-02T00:00:00Z" };
    expect(compareExperimentRuns(a, b)).toEqual([]);
  });
});

// =============================================================================
// GET /v1/prompts
// =============================================================================

describe("GET /v1/prompts", () => {
  it("resolves 'latest' to the newest version even with no explicit label", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("greeting", 1, "hello v1", "sha256:h1") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-02T00:00:00Z", payload: promptCreatedPayload("greeting", 2, "hello v2", "sha256:h2") });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([
      { name: "greeting", version_count: 2, latest_version: 2, labels: [{ label: "latest", version: 2 }] },
    ]);
  });

  it("flattens labels sorted by label name, alongside the auto 'latest'", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "v1", "sha256:h1") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-02T00:00:00Z", payload: promptCreatedPayload("p", 2, "v2", "sha256:h2") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-03T00:00:00Z", payload: promptLabeledPayload("p", "production", 1) });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items[0].labels).toEqual([
      { label: "latest", version: 2 },
      { label: "production", version: 1 },
    ]);
  });

  it("resolves a label by ingestion order (seq), not by occurred_at — the documented divergence from Go", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "v1", "h1") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-02T00:00:00Z", payload: promptCreatedPayload("p", 2, "v2", "h2") });
    // Inserted FIRST (lower seq) but with a LATER occurred_at.
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-06-01T00:00:00Z", payload: promptLabeledPayload("p", "production", 1) });
    // Inserted SECOND (higher seq) but with an EARLIER occurred_at.
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-15T00:00:00Z", payload: promptLabeledPayload("p", "production", 2) });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    const production = b.items[0].labels.find((l: any) => l.label === "production");
    // If resolution were occurred_at-ordered (Go's SetAt), this would be 1.
    expect(production.version).toBe(2);
  });

  it("lists prompts name-ascending", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("zeta", 1, "v", "h") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("alpha", 1, "v", "h") });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items.map((i: any) => i.name)).toEqual(["alpha", "zeta"]);
  });

  it("skips malformed prompt.created (name empty, version<=0) and prompt.labeled (name/label empty) rows", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("", 1, "v", "h") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("good", 0, "v", "h") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("good", -1, "v", "h") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-01T00:00:00Z", payload: promptLabeledPayload("", "production", 1) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-01T00:00:00Z", payload: promptLabeledPayload("good", "", 1) });
    // valid, to prove the workspace is not simply empty
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("good", 1, "v", "h") });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ name: "good", version_count: 1 });
    expect(b.meta.skipped_malformed).toBe(5);
  });

  it("a prompt.labeled event with version<=0 is still materialized (Go has no positivity guard at read time)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "v", "h") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-02T00:00:00Z", payload: promptLabeledPayload("p", "weird", 0) });
    const response = await handleQualityRoute(request("/v1/prompts", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items[0].labels).toContainEqual({ label: "weird", version: 0 });
    expect(b.meta.skipped_malformed).toBe(0);
  });
});

// =============================================================================
// GET /v1/prompts/show
// =============================================================================

describe("GET /v1/prompts/show", () => {
  it("400s with no ?name=", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/prompts/show", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(400);
  });

  it("404s for an unknown name", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/prompts/show?name=nope", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(404);
  });

  it("404s for a name that only exists in a foreign workspace", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, OTHER_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("shared-name", 1, "foreign body", "h") });
    const response = await handleQualityRoute(request("/v1/prompts/show?name=shared-name", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(404);
  });

  it("defaults to 'latest' and returns body + metadata + labels pointing at it", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "body v1", "sha256:h1", "alice") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-02T00:00:00Z", payload: promptCreatedPayload("p", 2, "body v2", "sha256:h2") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.labeled", occurredAt: "2026-01-03T00:00:00Z", payload: promptLabeledPayload("p", "production", 2) });
    const response = await handleQualityRoute(request("/v1/prompts/show?name=p", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.version).toBe(2);
    expect(b.body).toBe("body v2");
    expect(b.hash).toBe("sha256:h2");
    expect(b.labels.sort()).toEqual(["latest", "production"]);
    expect(b.latest_version).toBe(2);
    expect(b.version_count).toBe(2);
    expect(b.created_by).toBeUndefined(); // omitted: this version's created_by was never supplied
  });

  it("honors an explicit ?version= and includes created_by when it was supplied", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "body v1", "sha256:h1", "alice") });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-02T00:00:00Z", payload: promptCreatedPayload("p", 2, "body v2", "sha256:h2") });
    const response = await handleQualityRoute(request("/v1/prompts/show?name=p&version=1", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.version).toBe(1);
    expect(b.body).toBe("body v1");
    expect(b.created_by).toBe("alice");
    expect(b.labels).toEqual([]); // no label currently points at v1 ('latest' resolves to v2)
  });

  it("400s an invalid ?version=", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "v", "h") });
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const response = await handleQualityRoute(request(`/v1/prompts/show?name=p&version=${bad}`, { headers: authed() }), makeEnv(db));
      expect(response?.status, `version=${bad}`).toBe(400);
    }
  });

  it("404s a version number that does not exist for a known name", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "v", "h") });
    const response = await handleQualityRoute(request("/v1/prompts/show?name=p&version=99", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(404);
  });
});

// =============================================================================
// GET /v1/scores
// =============================================================================

describe("GET /v1/scores", () => {
  it("flattens a score.recorded event, keeping value as the wire string verbatim", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      provenance: "OBSERVED",
      payload: scorePayload({ name: "handoff.validity", data_type: "NUMERIC", value: "0.9", target_type: "trace", target_id: "trc_1", source: "human" }),
    });
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([
      { name: "handoff.validity", data_type: "NUMERIC", value: "0.9", target_type: "trace", target_id: "trc_1", source: "human", occurred_at: "2026-01-01T00:00:00Z", provenance: "OBSERVED" },
    ]);
    expect(typeof b.items[0].value).toBe("string");
  });

  it("surfaces INFERRED provenance distinctly (never silently equal to OBSERVED)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      provenance: "INFERRED",
      payload: scorePayload({ name: "llm.judge", data_type: "CATEGORY", value: "good", target_type: "trace", target_id: "trc_1", source: "evaluation" }),
    });
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items[0].provenance).toBe("INFERRED");
  });

  it("parses comment for malformed-detection fidelity but does not expose it on the wire (SCOPE's field list for this route excludes it, unlike Go's protocol.Score)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: scorePayload({ name: "n", data_type: "BOOLEAN", value: "true", target_type: "span", target_id: "spn_1", source: "api", comment: "looks right" }),
    });
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items[0].comment).toBeUndefined();
    // Still parsed and type-checked internally: a wrong-typed comment must
    // still poison the whole event, matching Go's struct-unmarshal fidelity.
    const { items } = await materializeScores(new SqliteD1(db), TOKEN_WORKSPACE);
    expect(items[0].comment).toBe("looks right");
  });

  it("a wrong-typed comment (number instead of string) still malforms the whole event", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertRawEvent(
      db,
      TOKEN_WORKSPACE,
      "score.recorded",
      JSON.stringify({
        event_id: nextEventId(),
        kind: "score.recorded",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { name: "n", data_type: "NUMERIC", value: "1", target_type: "trace", target_id: "trc_1", source: "human", comment: 123 },
      }),
    );
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([]);
    expect(b.meta.skipped_malformed).toBe(1);
  });

  it("filters by ?target= and ?source=", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, { kind: "score.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: scorePayload({ name: "a", data_type: "NUMERIC", value: "1", target_type: "trace", target_id: "trc_1", source: "human" }) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "score.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: scorePayload({ name: "b", data_type: "NUMERIC", value: "2", target_type: "trace", target_id: "trc_2", source: "detection" }) });
    const byTarget = await body((await handleQualityRoute(request("/v1/scores?target=trc_1", { headers: authed() }), makeEnv(db)))!);
    expect(byTarget.items.map((i: any) => i.name)).toEqual(["a"]);
    const bySource = await body((await handleQualityRoute(request("/v1/scores?source=detection", { headers: authed() }), makeEnv(db)))!);
    expect(bySource.items.map((i: any) => i.name)).toEqual(["b"]);
  });

  it("400s an unrecognized ?source=", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const response = await handleQualityRoute(request("/v1/scores?source=nonsense", { headers: authed() }), makeEnv(db));
    expect(response?.status).toBe(400);
  });

  it("sorts ascending by (occurred_at, score_id)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    const later = insertEvent(db, TOKEN_WORKSPACE, { kind: "score.recorded", occurredAt: "2026-02-01T00:00:00Z", payload: scorePayload({ name: "a", data_type: "NUMERIC", value: "1", target_type: "trace", target_id: "trc_1", source: "human" }) });
    const earlier = insertEvent(db, TOKEN_WORKSPACE, { kind: "score.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: scorePayload({ name: "a", data_type: "NUMERIC", value: "1", target_type: "trace", target_id: "trc_1", source: "human" }) });
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    // score_id is not exposed on the wire (per the narrowed field list), so
    // this asserts ordering indirectly via occurred_at, which is exposed.
    expect(b.items.map((i: any) => i.occurred_at)).toEqual(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
    void later;
    void earlier;
  });

  it("skips a payload where a typed field has the wrong JSON type (e.g. value is a number, not a string)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertRawEvent(
      db,
      TOKEN_WORKSPACE,
      "score.recorded",
      JSON.stringify({
        event_id: nextEventId(),
        kind: "score.recorded",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { name: "n", data_type: "NUMERIC", value: 0.9, target_type: "trace", target_id: "trc_1", source: "human" },
      }),
    );
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toEqual([]);
    expect(b.meta.skipped_malformed).toBe(1);
  });

  it("does not require name/data_type/source to be non-empty or a known enum (Go's fromEvent has no such guard)", async () => {
    const db = migratedDatabase();
    seedDevices(db);
    insertEvent(db, TOKEN_WORKSPACE, {
      kind: "score.recorded",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: scorePayload({ name: "", data_type: "WEIRD_TYPE", value: "x", target_type: "trace", target_id: "trc_1", source: "human" }),
    });
    const response = await handleQualityRoute(request("/v1/scores", { headers: authed() }), makeEnv(db));
    const b = await body(response!);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].data_type).toBe("WEIRD_TYPE");
    expect(b.meta.skipped_malformed).toBe(0);
  });
});

// =============================================================================
// pure materializer functions (label resolution, latest, determinism)
// =============================================================================

describe("resolveLabels / latestVersion (pure)", () => {
  it("returns 0 latest for a prompt with no versions", () => {
    expect(latestVersion({ name: "p", versions: [], labelEvents: [] })).toBe(0);
    expect(resolveLabels({ name: "p", versions: [], labelEvents: [] }).has("latest")).toBe(false);
  });

  it("later seq overwrites an earlier seq for the same (name,label)", () => {
    const aggregate = {
      name: "p",
      versions: [{ seq: 1, version: 1, body: "b", hash: "h", created_by: "", created_at: "2026-01-01T00:00:00Z" }],
      labelEvents: [
        { seq: 2, label: "production", version: 1, set_at: "2026-06-01T00:00:00Z" },
        { seq: 3, label: "production", version: 1, set_at: "2026-01-01T00:00:00Z" }, // later seq, earlier timestamp
      ],
    };
    expect(resolveLabels(aggregate).get("production")).toBe(1);
  });
});

describe("scan-bound truncation (fake large-scale db)", () => {
  function fakeLargeScanDb(totalRows: number, tokenHash: string): D1DatabaseLike {
    return {
      prepare(sql: string): D1Statement {
        return {
          bind(...values: unknown[]): D1BoundStatement {
            return {
              async first<T>(): Promise<T | null> {
                if (sql.includes("FROM devices")) {
                  return {
                    id: DEVICE_ID,
                    workspace_id: TOKEN_WORKSPACE,
                    token_hash: tokenHash,
                    capabilities: "read",
                    revoked_at: null,
                  } as unknown as T;
                }
                return null;
              },
              async all<T>(): Promise<{ results: T[] }> {
                const limit = Number(values[values.length - 1]);
                const count = Math.min(totalRows, limit);
                const rows: { seq: number; raw_json: string }[] = [];
                for (let i = 0; i < count; i++) {
                  rows.push({
                    seq: i + 1,
                    raw_json: JSON.stringify({
                      event_id: `evt_synthetic_${i}`,
                      kind: "dataset.created",
                      occurred_at: "2026-01-01T00:00:00Z",
                      payload: datasetPayload(`ds-${String(i).padStart(6, "0")}`, `sha256:${i}`, [{ name: "a.jsonl", hash: "sha256:aa", event_count: 1 }]),
                    }),
                  });
                }
                return { results: rows as unknown as T[] };
              },
              async run<T>(): Promise<D1RunResultLike<T>> {
                return { success: true };
              },
            };
          },
        };
      },
      async batch(): Promise<D1RunResultLike[]> {
        return [];
      },
    };
  }

  it("does not truncate at exactly the cap", async () => {
    const db = fakeLargeScanDb(MAX_MATERIALIZE_ROWS, TOKEN_HASH);
    const { items, truncated } = await materializeDatasets(db, TOKEN_WORKSPACE);
    expect(items).toHaveLength(MAX_MATERIALIZE_ROWS);
    expect(truncated).toBe(false);
  });

  it("caps items at MAX_MATERIALIZE_ROWS and flags truncation one row past the cap", async () => {
    const db = fakeLargeScanDb(MAX_MATERIALIZE_ROWS + 1, TOKEN_HASH);
    const { items, truncated } = await materializeDatasets(db, TOKEN_WORKSPACE);
    expect(items).toHaveLength(MAX_MATERIALIZE_ROWS);
    expect(truncated).toBe(true);
  });

  it("surfaces truncation in the HTTP envelope's meta", async () => {
    const db = fakeLargeScanDb(MAX_MATERIALIZE_ROWS + 1, TOKEN_HASH);
    const response = await handleQualityRoute(request("/v1/datasets", { headers: authed() }), { DB: db });
    expect(response?.status).toBe(200);
    const b = await body(response!);
    expect(b.items).toHaveLength(MAX_MATERIALIZE_ROWS);
    expect(b.meta.truncated).toBe(true);
    expect(typeof b.meta.note).toBe("string");
  });
});

// =============================================================================
// cross-endpoint: pure materializer smoke (materializeExperiments / Prompts / Scores)
// =============================================================================

describe("materialize* pure smoke (direct, no HTTP layer)", () => {
  it("materializeExperiments sorts ascending and materializePromptEvents groups by name", async () => {
    const db = migratedDatabase();
    insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-02T00:00:00Z", payload: experimentPayload("d", "v2", true, [exampleResult({})]) });
    insertEvent(db, TOKEN_WORKSPACE, { kind: "experiment.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: experimentPayload("d", "v1", true, [exampleResult({})]) });
    const { items } = await materializeExperiments(new SqliteD1(db), TOKEN_WORKSPACE);
    expect(items.map((i) => i.version)).toEqual(["v1", "v2"]);

    insertEvent(db, TOKEN_WORKSPACE, { kind: "prompt.created", occurredAt: "2026-01-01T00:00:00Z", payload: promptCreatedPayload("p", 1, "b", "h") });
    const { byName } = await materializePromptEvents(new SqliteD1(db), TOKEN_WORKSPACE);
    expect(byName.has("p")).toBe(true);
  });

  it("materializeScores is deterministic across repeated calls", async () => {
    const db = migratedDatabase();
    insertEvent(db, TOKEN_WORKSPACE, { kind: "score.recorded", occurredAt: "2026-01-01T00:00:00Z", payload: scorePayload({ name: "a", data_type: "NUMERIC", value: "1", target_type: "trace", target_id: "trc_1", source: "human" }) });
    const db1 = new SqliteD1(db);
    const first = await materializeScores(db1, TOKEN_WORKSPACE);
    const second = await materializeScores(db1, TOKEN_WORKSPACE);
    expect(second.items).toEqual(first.items);
  });
});
