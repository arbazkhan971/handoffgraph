import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  convertOtlpExport,
  deterministicID,
} from "../src/otlp";

const testDirectory = dirname(fileURLToPath(import.meta.url));

// Golden pairs generated from the Go implementation
// (internal/ids.Deterministic) — cross-language id parity is a hard
// contract: the same telemetry must produce the same ids locally and hosted.
const GOLDEN: Array<[prefix: string, key: string, ts: number, id: string]> = [
  [
    "evt_",
    "otlp|span-start|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331",
    1756334400000,
    "evt_01K3PV08G0MV7FMYGP6JTF36AN",
  ],
  [
    "evt_",
    "otlp|span-start|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331",
    0,
    "evt_0000000000MV7FMYGP6JTF36AN",
  ],
  ["ses_", "otlp|agent-session-77", 0, "ses_0000000000Z3NG62MJJ8C9XSQT"],
  ["trc_", "otlp|0af7651916cd43dd8448eb211c80319c", 0, "trc_00000000002VMVPQJ146EGCPXN"],
  ["spn_", "otlp|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331", 0, "spn_0000000000QXWGWJN939C0BB12"],
  // GenAI semconv v1.37.0 fixture (semconv_v137.json, parity rows 2/3):
  // gen_ai.conversation.id must outrank langfuse.session.id for the session
  // key — see TestConvertSemconvV137 in internal/otlp/otlp_test.go, which
  // pins these same literal ids from the Go reference implementation.
  ["ses_", "otlp|conv-8842", 0, "ses_0000000000WSSGPRQR3WX4YQ1E"],
  ["trc_", "otlp|748cd2e72cbe280d4242c6f65a237d76", 0, "trc_0000000000Z2JW9HMJZYCDCS5C"],
  [
    "evt_",
    "otlp|span-start|748cd2e72cbe280d4242c6f65a237d76|0aacf703138cc694",
    1787918400000,
    "evt_01M143VEG04WB39V9R2FZ184FV",
  ],
  [
    "evt_",
    "otlp|span-start|748cd2e72cbe280d4242c6f65a237d76|b5f6be6764e48af6",
    1787918405000,
    "evt_01M143VKC8DHPH5EH99NWN59BM",
  ],
];

describe("deterministicID (Go parity)", () => {
  for (const [prefix, key, ts, id] of GOLDEN) {
    it(`matches Go for ${prefix} ${key.slice(0, 24)}…@${ts}`, async () => {
      await expect(deterministicID(prefix, key, ts)).resolves.toBe(id);
    });
  }

  it("is stable and sensitive", async () => {
    const a = await deterministicID("evt_", "k", 123);
    const b = await deterministicID("evt_", "k", 123);
    expect(a).toBe(b);
    expect(await deterministicID("evt_", "k2", 123)).not.toBe(a);
    expect(await deterministicID("evt_", "k", 124)).not.toBe(a);
    // Beyond the ULID time range clamps to epoch, matching Go.
    expect(await deterministicID("evt_", "k", 2 ** 49)).toBe(
      await deterministicID("evt_", "k", 0),
    );
  });
});

const GENAI_EXPORT = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "codex-cli" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "github.com/handoffgraph/agent-instrumentation", version: "0.1.0" },
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              name: "run agent",
              kind: 1,
              startTimeUnixNano: "1756334400000000000",
              endTimeUnixNano: "1756334405000000000",
              status: { code: 1 },
              attributes: [{ key: "session.id", value: { stringValue: "agent-session-77" } }],
            },
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "5b8efff798038103",
              parentSpanId: "b7ad6b7169203331",
              name: "chat gpt-5.3",
              kind: 3,
              startTimeUnixNano: "1756334401000000000",
              endTimeUnixNano: "1756334404000000000",
              status: { code: 2, message: "rate limited" },
              attributes: [
                { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-5.3" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "350" } },
                { key: "__proto__", value: { stringValue: "dropped" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("convertOtlpExport", () => {
  it("converts a genai export into ordered canonical events", async () => {
    const res = await convertOtlpExport(GENAI_EXPORT, {
      captureTier: "full",
      observedAt: "2026-08-28T12:00:00Z",
    });
    expect(res.rejectedSpans).toEqual([]);
    // 2 spans × 2 + trace pair + session = 7 events.
    expect(res.events).toHaveLength(7);
    expect(res.events[0]["kind"]).toBe("session.started");
    expect(res.events[res.events.length - 1]["kind"]).toBe("trace.completed");

    // Deterministic order + Go-parity session id (session.id attr is used).
    const sessionIDs = new Set(res.events.map((e) => e["session_id"]));
    expect(sessionIDs.size).toBe(1);
    expect([...sessionIDs][0]).toBe("ses_0000000000Z3NG62MJJ8C9XSQT");

    const failed = res.events.find((e) => e["kind"] === "span.failed");
    expect(failed).toBeDefined();
    expect((failed as { model?: string })["model"]).toBe("gpt-5.3");
    expect((failed as { payload?: { error?: string } })["payload"]?.["error"]).toBe("rate limited");

    // Parent linkage: child span.started references the parent's derived evt id.
    const childStart = res.events.find(
      (e) => e["kind"] === "span.started" && (e["payload"] as { name?: string })["name"] === "chat gpt-5.3",
    );
    const parents = (childStart as { parent_event_ids?: string[] })["parent_event_ids"];
    expect(parents).toEqual(["evt_01K3PV08G0MV7FMYGP6JTF36AN"]);

    // Token aggregation on trace.completed.
    const done = res.events[res.events.length - 1];
    const payload = (done as { payload?: Record<string, unknown> })["payload"];
    expect(payload?.["token_input"]).toBe(1200);
    expect(payload?.["token_output"]).toBe(350);
  });

  it("is idempotent across conversions (same ids)", async () => {
    const a = await convertOtlpExport(GENAI_EXPORT, { captureTier: "full", observedAt: "2026-08-28T12:00:00Z" });
    const b = await convertOtlpExport(GENAI_EXPORT, { captureTier: "full", observedAt: "2026-08-29T01:00:00Z" });
    expect(a.events.map((e) => e["event_id"])).toEqual(b.events.map((e) => e["event_id"]));
  });

  it("rejects malformed spans fail-closed and converts the rest", async () => {
    const res = await convertOtlpExport(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  { traceId: "bad", spanId: "b7ad6b7169203331", startTimeUnixNano: "1", endTimeUnixNano: "2" },
                  {
                    traceId: "0af7651916cd43dd8448eb211c80319c",
                    spanId: "5b8efff798038103",
                    name: "ok",
                    kind: 1,
                    startTimeUnixNano: "1756334400000000000",
                    endTimeUnixNano: "1756334400000000001",
                  },
                ],
              },
            ],
          },
        ],
      },
      { captureTier: "full", observedAt: "2026-08-28T12:00:00Z" },
    );
    expect(res.rejectedSpans).toHaveLength(1);
    expect(res.events.length).toBe(5);
  });

  it("drops body attributes under the metadata tier and counts them", async () => {
    const res = await convertOtlpExport(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "0af7651916cd43dd8448eb211c80319c",
                    spanId: "5b8efff798038103",
                    name: "chat",
                    kind: 3,
                    startTimeUnixNano: "1756334400000000000",
                    endTimeUnixNano: "1756334400000000001",
                    attributes: [
                      { key: "gen_ai.request.model", value: { stringValue: "gpt-5.3" } },
                      { key: "gen_ai.input.messages", value: { stringValue: "secret prompt" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { captureTier: "metadata", observedAt: "2026-08-28T12:00:00Z" },
    );
    const done = res.events.find((e) => e["kind"] === "span.completed");
    const payload = (done as { payload?: Record<string, unknown> })["payload"];
    expect(payload?.["capture_dropped_keys"]).toBe(1);
    expect((payload?.["attributes"] as Record<string, unknown>)["gen_ai.request.model"]).toBe("gpt-5.3");
    expect((payload?.["attributes"] as Record<string, unknown>)["gen_ai.input.messages"]).toBeUndefined();
  });
});

// GenAI semconv v1.37.0 fixture (2026-08-28 market audit, parity rows 2/3).
// Loaded from testdata (not re-embedded) so the Go and TS suites convert
// byte-identical input — see internal/otlp/otlp_test.go's
// TestConvertSemconvV137, which pins the same derived ids from this file.
const SEMCONV_V137_EXPORT = JSON.parse(
  readFileSync(resolve(testDirectory, "../../testdata/fixtures/otlp/semconv_v137.json"), "utf8"),
) as unknown;

describe("convertOtlpExport (GenAI semconv v1.37.0 parity)", () => {
  it("prefers gen_ai.conversation.id over langfuse.session.id for the session key", async () => {
    const res = await convertOtlpExport(SEMCONV_V137_EXPORT, {
      captureTier: "full",
      observedAt: "2026-08-28T12:00:00Z",
    });
    expect(res.rejectedSpans).toEqual([]);
    // 3 spans × 2 + trace pair + session = 9 events.
    expect(res.events).toHaveLength(9);

    const sessionIDs = new Set(res.events.map((e) => e["session_id"]));
    expect(sessionIDs.size).toBe(1);
    // Go-parity id for key "otlp|conv-8842" — proves conversation.id won,
    // not "otlp|langfuse-loses".
    expect([...sessionIDs][0]).toBe("ses_0000000000WSSGPRQR3WX4YQ1E");
    expect(res.events.every((e) => e["native_session_id"] === "conv-8842")).toBe(true);
  });

  it("prefers gen_ai.provider.name over the legacy gen_ai.system for the model field", async () => {
    const res = await convertOtlpExport(SEMCONV_V137_EXPORT, {
      captureTier: "full",
      observedAt: "2026-08-28T12:00:00Z",
    });
    const chatEnd = res.events.find(
      (e) => e["kind"] === "span.completed" && e["model"] === "anthropic",
    );
    // The chat span sets gen_ai.provider.name="anthropic" AND the legacy
    // gen_ai.system="anthropic-legacy" with no gen_ai.request.model — the
    // new key must win, never falling through to the old one.
    expect(chatEnd).toBeDefined();
  });

  it("maps OpenInference PROMPT to WORKFLOW and EVALUATOR to GUARDRAIL", async () => {
    const res = await convertOtlpExport(SEMCONV_V137_EXPORT, {
      captureTier: "full",
      observedAt: "2026-08-28T12:00:00Z",
    });
    const promptStart = res.events.find(
      (e) => e["kind"] === "span.started" && (e["payload"] as { name?: string })["name"] === "assemble prompt",
    );
    const evalStart = res.events.find(
      (e) => e["kind"] === "span.started" && (e["payload"] as { name?: string })["name"] === "verify claim",
    );
    expect((promptStart?.["payload"] as { span_kind?: string })?.["span_kind"]).toBe("WORKFLOW");
    expect((evalStart?.["payload"] as { span_kind?: string })?.["span_kind"]).toBe("GUARDRAIL");
  });

  it("matches the Go-derived golden ids for the root span-start and eval span-start events", async () => {
    const res = await convertOtlpExport(SEMCONV_V137_EXPORT, {
      captureTier: "full",
      observedAt: "2026-08-28T12:00:00Z",
    });
    const promptStart = res.events.find(
      (e) => e["kind"] === "span.started" && (e["payload"] as { name?: string })["name"] === "assemble prompt",
    );
    const evalStart = res.events.find(
      (e) => e["kind"] === "span.started" && (e["payload"] as { name?: string })["name"] === "verify claim",
    );
    expect(promptStart?.["event_id"]).toBe("evt_01M143VEG04WB39V9R2FZ184FV");
    expect(evalStart?.["event_id"]).toBe("evt_01M143VKC8DHPH5EH99NWN59BM");
  });
});

// ---- arrayValue spellings (proto3 JSON) --------------------------------------
//
// The OTLP proto names ArrayValue's repeated field `values`. This converter
// historically only understood a bare array body, so a spec-correct emitter's
// array attribute survived as an undecoded wrapper object instead of a list.
// internal/otlp/arrayvalue_test.go pins the same three cases in Go.

const ARRAY_SPELLINGS_TRACE = "9f3c1d5b70a24e8ab6c0d1e2f3a4b5c6";

async function convertOneAttribute(value: unknown): Promise<unknown> {
  const res = await convertOtlpExport(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: ARRAY_SPELLINGS_TRACE,
                  spanId: "1a2b3c4d5e6f7081",
                  name: "execute_tool run_tests",
                  kind: 1,
                  startTimeUnixNano: "1787918400000000000",
                  endTimeUnixNano: "1787918402000000000",
                  attributes: [{ key: "tool.files", value }],
                },
              ],
            },
          ],
        },
      ],
    },
    { captureTier: "full", observedAt: "2026-08-28T12:00:00Z" },
  );
  expect(res.rejectedSpans).toEqual([]);
  const done = res.events.find((e) => e["kind"] === "span.completed");
  const payload = (done as { payload?: Record<string, unknown> })["payload"];
  return (payload?.["attributes"] as Record<string, unknown>)["tool.files"];
}

describe("convertOtlpExport (arrayValue spellings)", () => {
  it("decodes the spec spelling {arrayValue: {values}}", async () => {
    await expect(
      convertOneAttribute({
        arrayValue: { values: [{ stringValue: "cmd/main.go" }, { intValue: "2" }] },
      }),
    ).resolves.toEqual(["cmd/main.go", 2]);
  });

  it("still decodes the legacy {arrayValue: {elements}} spelling", async () => {
    await expect(
      convertOneAttribute({ arrayValue: { elements: [{ stringValue: "legacy" }] } }),
    ).resolves.toEqual(["legacy"]);
  });

  it("lets values win when a payload carries both spellings", async () => {
    await expect(
      convertOneAttribute({
        arrayValue: { elements: [{ stringValue: "legacy" }], values: [{ stringValue: "spec" }] },
      }),
    ).resolves.toEqual(["spec"]);
  });

  it("keeps accepting a bare array body and recurses into nested arrays", async () => {
    await expect(convertOneAttribute({ arrayValue: [{ stringValue: "bare" }] })).resolves.toEqual([
      "bare",
    ]);
    await expect(
      convertOneAttribute({
        arrayValue: { values: [{ arrayValue: { values: [{ stringValue: "unit" }] } }] },
      }),
    ).resolves.toEqual([["unit"]]);
  });

  it("decodes an empty values list as an empty array", async () => {
    await expect(convertOneAttribute({ arrayValue: { values: [] } })).resolves.toEqual([]);
    await expect(convertOneAttribute({ arrayValue: {} })).resolves.toEqual([]);
  });
});

// ---- worker route -----------------------------------------------------------

import { default as worker } from "../src/index";
import { sha256Hex } from "../src/auth";

const CTX = {} as never;

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
  batch?: (statements: unknown[]) => void;
} = {}) {
  const batches: unknown[][] = [];
  const db = {
    prepare(sql: string): unknown {
      const record: Record<string, unknown> = { sql, binds: [] as unknown[] };
      return {
        sql,
        get binds() { return record.binds as unknown[]; },
        bind(...values: unknown[]) {
          (record.binds as unknown[]) = values;
          return this;
        },
        async first<T = unknown>(): Promise<T | null> {
          const result = await handlers.first?.(sql, record.binds as unknown[]);
          return (result ?? null) as T | null;
        },
        async all<T = unknown>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
      handlers.batch?.(statements);
      return [];
    },
  };
  return { db, batches };
}

const DEVICE_TOKEN = "hfgd_test_token";
const TOKEN_WORKSPACE = "wsp_01TESTWORKSPACE0000000000000";
const DEVICE_ID = "dev_01TESTDEVICE000000000000000000";
const TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);

function deviceRegistry() {
  return async (sql: string): Promise<unknown> => {
    if (sql.includes("FROM devices")) {
      return {
        id: DEVICE_ID,
        workspace_id: TOKEN_WORKSPACE,
        token_hash: TOKEN_HASH,
        capabilities: "ingest,read",
        revoked_at: null,
      };
    }
    if (sql.includes("quota:read-policy")) {
      return {
        workspace_id: TOKEN_WORKSPACE,
        plan_id: "basic",
        status: "active",
        max_batch_events: 100,
        max_batch_bytes: 262_144,
        max_monthly_events: 5_000,
        max_monthly_bytes: 10_485_760,
        max_lifetime_events: 25_000,
        max_lifetime_bytes: 67_108_864,
        used_monthly_events: 0,
        used_monthly_bytes: 0,
        used_lifetime_events: 0,
        used_lifetime_bytes: 0,
        period_start: 1_700_000_000,
        period_end: 1_900_000_000,
      };
    }
    return null;
  };
}

function otlpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.handoffgraph.dev/v1/otlp", {
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("worker: POST /v1/otlp", () => {
  it("rejects unauthenticated requests fail-closed", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(
      new Request("https://api.handoffgraph.dev/v1/otlp", { method: "POST", body: "{}" }),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a bad capture tier header", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      otlpRequest(GENAI_EXPORT, { "x-hfg-capture": "yolo" }),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(400);
  });

  it("converts and stores an export through the event-batch pipeline", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      otlpRequest(GENAI_EXPORT, { "x-hfg-capture": "full" }),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["schema_version"]).toBe("hfg.event-batch.receipt.v1");
    expect((body["otlp"] as Record<string, unknown>)["capture_tier"]).toBe("full");
    // The full pipeline ran: one atomic D1 batch.
    expect(batches).toHaveLength(1);
    const eventInsert = (batches[0] as Array<Record<string, unknown>>).find((s) =>
      String(s["sql"]).includes("INSERT OR IGNORE INTO events"),
    );
    expect(eventInsert).toBeDefined();
    const stored = JSON.parse(String(((eventInsert!["binds"] ?? []) as unknown[])[3])) as Array<Record<string, unknown>>;
    // 7 converted events (2 spans × 2 + trace pair + session).
    expect(stored).toHaveLength(7);
    expect(stored.every((e) => e["schema_version"] === "hfg.event.v1")).toBe(true);
    // Deterministic Go-parity session id flowed into storage.
    expect(new Set(stored.map((e) => e["session_id"]))).toEqual(
      new Set(["ses_0000000000Z3NG62MJJ8C9XSQT"]),
    );
  });

  it("replays idempotently: same export, same derived key, one stored batch", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const env = { DB: db as never };
    const first = await worker.fetch(otlpRequest(GENAI_EXPORT, { "x-hfg-capture": "full" }), env, CTX);
    expect(first.status).toBe(200);
    const storedCount = batches.length;

    // Replay: the idempotency read returns an existing receipt (simulate the
    // committed key) and no second write batch is expected.
    let receipt: Record<string, unknown> | null = null;
    const replayDb = mockDb({
      first: async (sql, binds) => {
        if (sql.includes("FROM devices")) return (await deviceRegistry()(sql))!;
        if (sql.includes("quota:read-policy")) return (await deviceRegistry()(sql))!;
        if (sql.includes("FROM idempotency_keys")) {
          return receipt
            ? { workspace_id: TOKEN_WORKSPACE, request_hash: (receipt as Record<string, unknown>)["request_hash"], receipt_json: JSON.stringify(receipt) }
            : null;
        }
        return null;
      },
    });
    // Capture the derived idempotency key AND the committed request hash
    // from the first run's insert binds so the replay receipt verifies.
    const firstInsert = (batches[0] as Array<Record<string, unknown>>).find((s) =>
      String(s["sql"]).includes("INSERT INTO idempotency_keys"),
    );
    const firstBinds = (firstInsert!["binds"] ?? []) as unknown[];
    const derivedKey = String(firstBinds[0]);
    expect(derivedKey.startsWith("otlp-")).toBe(true);
    const committedHash = String(firstBinds[3]);
    expect(committedHash).toMatch(/^[0-9a-f]{64}$/);

    receipt = {
      request_hash: committedHash,
      accepted: 7,
      schema_version: "hfg.event-batch.receipt.v1",
    };
    const replay = await worker.fetch(
      otlpRequest(GENAI_EXPORT, { "x-hfg-capture": "full" }),
      { DB: replayDb.db as never },
      CTX,
    );
    expect(replay.status).toBe(200);
    expect(replayDb.batches).toHaveLength(0);
    expect(storedCount).toBe(1);
  });
});
