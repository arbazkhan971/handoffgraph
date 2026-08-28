import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { convertOtlpExport, otlpEventID, otlpSessionID, type HfgEvent } from "../src/otlp";
import { decodeExportRequest } from "../src/otlp_proto";
import { default as worker } from "../src/index";
import { sha256Hex } from "../src/auth";

/**
 * Cross-language regressions for the hosted OTLP converter. Every claim here
 * has a twin in internal/otlp (convert_hardening_test.go and
 * payload_parity_test.go) so the two implementations are held to one
 * behaviour, and the fixtures are read off disk rather than re-embedded so
 * both languages judge the same bytes.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../testdata/fixtures/otlp");
const PAYLOAD_PARITY_PB = new Uint8Array(readFileSync(join(FIXTURE_DIR, "payload_parity.pb")));
const PAYLOAD_PARITY_JSON = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "payload_parity.json"), "utf8"),
) as unknown;
const UTF8_REJECT_PB = new Uint8Array(readFileSync(join(FIXTURE_DIR, "utf8_reject.pb")));

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const CONVERT = { captureTier: "full", observedAt: OBSERVED_AT } as const;

const HARDENING_TRACE = "5c1d2e3f40516273849506a7b8c9d0e1";

function payloadOf(event: HfgEvent | undefined): Record<string, unknown> {
  return (event?.["payload"] ?? {}) as Record<string, unknown>;
}

function attributesOf(events: readonly HfgEvent[], kind: string): Record<string, unknown> {
  const found = events.find((e) => e["kind"] === kind);
  return (payloadOf(found)["attributes"] ?? {}) as Record<string, unknown>;
}

// ---- session-key precedence (mirrors TestSessionKeyPrecedence… in Go) -------

describe("session-key precedence is by key, not attribute emit order", () => {
  const export_ = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: HARDENING_TRACE,
                spanId: "1122334455667788",
                name: "root",
                kind: 1,
                startTimeUnixNano: "1787918400000000000",
                endTimeUnixNano: "1787918402000000000",
                attributes: [
                  // Deliberately reversed: the LOWER-precedence key first.
                  { key: "gen_ai.conversation.id", value: { stringValue: "conversation-loses" } },
                  { key: "session.id", value: { stringValue: "session-wins" } },
                ],
              },
              {
                traceId: HARDENING_TRACE,
                spanId: "99aabbccddeeff00",
                parentSpanId: "1122334455667788",
                name: "child with no session attribute",
                kind: 1,
                startTimeUnixNano: "1787918400500000000",
                endTimeUnixNano: "1787918401000000000",
              },
            ],
          },
        ],
      },
    ],
  };

  it("collapses the whole trace onto the highest-precedence key", async () => {
    const res = await convertOtlpExport(export_, CONVERT);
    expect(res.rejectedSpans).toEqual([]);
    // The sibling inherits the TRACE-WIDE key, so honouring emit order here
    // would split one logical trace across two derived session ids.
    expect(new Set(res.events.map((e) => e["native_session_id"]))).toEqual(
      new Set(["session-wins"]),
    );
    const sessionIDs = new Set(res.events.map((e) => e["session_id"]));
    expect(sessionIDs.size).toBe(1);
    expect([...sessionIDs][0]).toBe(await otlpSessionID("session-wins"));
  });
});

// ---- the promoted session key is sanitized first ---------------------------

describe("a rejected span's session key never reaches its accepted siblings", () => {
  it("skips a session.id past the attribute string cap (JSON flavor)", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const res = await convertOtlpExport(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: HARDENING_TRACE,
                    spanId: "1122334455667788",
                    name: "poisoned",
                    kind: 1,
                    startTimeUnixNano: "1787918400000000000",
                    endTimeUnixNano: "1787918402000000000",
                    attributes: [{ key: "session.id", value: { stringValue: oversized } }],
                  },
                  {
                    traceId: HARDENING_TRACE,
                    spanId: "99aabbccddeeff00",
                    name: "clean sibling",
                    kind: 1,
                    startTimeUnixNano: "1787918400500000000",
                    endTimeUnixNano: "1787918401000000000",
                  },
                ],
              },
            ],
          },
        ],
      },
      CONVERT,
    );
    // The oversized span is rejected fail-closed...
    expect(res.rejectedSpans).toHaveLength(1);
    expect(res.rejectedSpans[0].spanId).toBe("1122334455667788");
    // ...and its unusable key did not escape onto the clean sibling.
    expect(new Set(res.events.map((e) => e["native_session_id"]))).toEqual(
      new Set([`otlp-trace-${HARDENING_TRACE}`]),
    );
    // started + completed + trace pair + session.started.
    expect(res.events).toHaveLength(5);
  });

  it("skips a session.id whose bytes are not valid UTF-8 (protobuf flavor)", async () => {
    // The Go-authored fixture's first span carries an invalid-UTF-8 NAME; this
    // case needs an invalid session.id, so it is assembled here from the same
    // decoder the fixture uses.
    const decoded = decodeExportRequest(UTF8_REJECT_PB);
    const spans = (decoded.resourceSpans[0].scopeSpans ?? [])[0].spans ?? [];
    // Span 2 of the fixture carries an attribute whose string value is not
    // valid UTF-8; rename that key to session.id and the promotion path is
    // exercised with real undecodable bytes.
    const poisoned = spans[1];
    expect(poisoned.attributes?.[0].key).toBe("note");
    poisoned.attributes![0].key = "session.id";

    const res = await convertOtlpExport(decoded, CONVERT);
    expect(res.rejectedSpans.map((r) => r.spanId)).toEqual([
      "1111111111111111",
      "2222222222222222",
      "3333333333333333",
    ]);
    expect(new Set(res.events.map((e) => e["native_session_id"]))).toEqual(
      new Set(["otlp-trace-6b2c9e10df4a4c85b1e37a5d0c8f2413"]),
    );
  });
});

// ---- protobuf UTF-8 is fail-closed PER SPAN --------------------------------

describe("protobuf UTF-8 rejection matches the Go reference outcome", () => {
  it("rejects exactly the three hostile spans and converts the clean sibling", async () => {
    const res = await convertOtlpExport(decodeExportRequest(UTF8_REJECT_PB), CONVERT);
    // Same three spans, same three reasons internal/otlp reports for these
    // very bytes (TestUTF8RejectPerSpanFailClosed).
    expect(res.rejectedSpans).toEqual([
      {
        traceId: "6b2c9e10df4a4c85b1e37a5d0c8f2413",
        spanId: "1111111111111111",
        error: "span name is not valid UTF-8",
      },
      {
        traceId: "6b2c9e10df4a4c85b1e37a5d0c8f2413",
        spanId: "2222222222222222",
        error: "attribute string is not valid UTF-8",
      },
      {
        traceId: "6b2c9e10df4a4c85b1e37a5d0c8f2413",
        spanId: "3333333333333333",
        error: "invalid attribute key: not valid UTF-8",
      },
    ]);
    // The clean sibling still lands: started + completed + trace pair +
    // session.started. Nothing was rewritten to U+FFFD to get there.
    expect(res.events).toHaveLength(5);
    const started = res.events.find((e) => e["kind"] === "span.started");
    expect(payloadOf(started)["source_span_id"]).toBe("4444444444444444");
    expect(JSON.stringify(res.events)).not.toContain("�");
  });
});

// ---- AnyValue arms: four-corner payload parity -----------------------------

describe("AnyValue payload parity (payload_parity fixture)", () => {
  it("decodes the .pb into the very object graph the .json parses to", () => {
    expect(decodeExportRequest(PAYLOAD_PARITY_PB)).toEqual(PAYLOAD_PARITY_JSON);
  });

  for (const [flavor, load] of [
    ["json", () => PAYLOAD_PARITY_JSON],
    ["protobuf", () => decodeExportRequest(PAYLOAD_PARITY_PB)],
  ] as const) {
    it(`resolves every AnyValue arm to a plain value (${flavor})`, async () => {
      const res = await convertOtlpExport(load(), CONVERT);
      expect(res.rejectedSpans).toEqual([]);
      const attrs = attributesOf(res.events, "span.completed");

      // Bytes: Go's hex.EncodeToString of the decoded bytes — never the
      // base64 the wire carries, never an undecoded {bytesValue: …} wrapper.
      expect(attrs["tool.fingerprint"]).toBe("deadbeef");
      // kvlist: a plain object, with the reserved key dropped and NOT written
      // onto the object's prototype.
      expect(attrs["tool.meta"]).toEqual({ runner: "linux-arm64", retries: 2 });
      expect(Object.getPrototypeOf(attrs["tool.meta"] as object)).toBe(Object.prototype);
      // int64: the exact value, not a rounded double.
      expect(attrs["tool.duration_ns"]).toBe(9007199254740991);
      expect(JSON.stringify(attrs)).toContain(`"tool.duration_ns":9007199254740991`);
    });
  }

  it("converts both wire flavors to byte-identical events", async () => {
    const fromProto = await convertOtlpExport(decodeExportRequest(PAYLOAD_PARITY_PB), CONVERT);
    const fromJson = await convertOtlpExport(PAYLOAD_PARITY_JSON, CONVERT);
    // 2 spans x 2 + trace pair + session.started, exactly as the Go suite
    // asserts for these same bytes.
    expect(fromProto.events).toHaveLength(7);
    expect(fromProto.events).toEqual(fromJson.events);
  });

  it("keeps payload.attributes on a FAILED span", async () => {
    const res = await convertOtlpExport(PAYLOAD_PARITY_JSON, CONVERT);
    const failed = res.events.find((e) => e["kind"] === "span.failed");
    expect(failed).toBeDefined();
    expect(payloadOf(failed)["error"]).toBe("rate limited");
    // Failure is when the evidence matters most; Go attaches attributes to
    // both end arms alike.
    expect(payloadOf(failed)["attributes"]).toEqual({
      "gen_ai.request.model": "gpt-5.3",
      "gen_ai.usage.input_tokens": 1200,
    });
  });
});

describe("intValue and bytesValue edge cases", () => {
  async function oneAttribute(value: unknown): Promise<{
    attrs: Record<string, unknown>;
    rejected: { error: string }[];
  }> {
    const res = await convertOtlpExport(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: HARDENING_TRACE,
                    spanId: "1122334455667788",
                    name: "edge",
                    kind: 1,
                    startTimeUnixNano: "1787918400000000000",
                    endTimeUnixNano: "1787918401000000000",
                    attributes: [{ key: "edge", value }],
                  },
                ],
              },
            ],
          },
        ],
      },
      CONVERT,
    );
    return { attrs: attributesOf(res.events, "span.completed"), rejected: res.rejectedSpans };
  }

  it("never rounds an int64: past 2^53 the exact digits are kept", async () => {
    // Number("9007199254740993") is 9007199254740992 — the old truncation.
    const { attrs } = await oneAttribute({ intValue: "9007199254740993" });
    expect(attrs["edge"]).toBe("9007199254740993");
    const { attrs: negative } = await oneAttribute({ intValue: "-9223372036854775808" });
    expect(negative["edge"]).toBe("-9223372036854775808");
  });

  it("rejects an int64 out of range instead of storing a rounded double", async () => {
    // strconv.ParseInt refuses the same input in Go (there at request scope,
    // since Go decodes AnyValue during json.Unmarshal); both fail closed, and
    // neither stores 9223372036854775808 as an approximate float.
    const { rejected } = await oneAttribute({ intValue: "9223372036854775808" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toContain("out of int64 range");
  });

  it("rejects bytesValue that is not standard base64", async () => {
    for (const bad of ["3q2+7w=", "3q2+7w", "!!!!", "3q2=7w=="]) {
      const { rejected } = await oneAttribute({ bytesValue: bad });
      expect(rejected, bad).toHaveLength(1);
      expect(rejected[0].error).toContain("not valid base64");
    }
    const { attrs } = await oneAttribute({ bytesValue: "" });
    expect(attrs["edge"]).toBe("");
  });

  it("decodes a kvlist with no members as an empty object", async () => {
    const { attrs } = await oneAttribute({ kvlistValue: {} });
    expect(attrs["edge"]).toEqual({});
  });
});

// ---- per-event observed_at (replay across differently-composed batches) ----

const DEVICE_TOKEN = "hfgd_test_token";
const TOKEN_WORKSPACE = "wsp_01TESTWORKSPACE0000000000000";
const DEVICE_ID = "dev_01TESTDEVICE000000000000000000";
const TOKEN_HASH = await sha256Hex(DEVICE_TOKEN);
const CTX = {} as never;

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

/**
 * A D1 stand-in that enforces the two spine rules this regression is about:
 * INSERT OR IGNORE on (workspace_id, event_id), and migration 0003's
 * events_reject_payload_conflict trigger, which ABORTS the batch when an
 * event id is reused with different raw_json.
 */
function spineDb() {
  const rows = new Map<string, string>();
  const inserts: number[] = [];
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
          return ((await deviceRegistry()(sql)) ?? null) as T | null;
        },
        async all<T = unknown>() { return { results: [] as T[] }; },
        async run() { return { success: true }; },
      };
    },
    async batch(statements: unknown[]) {
      let inserted = 0;
      for (const statement of statements as Array<Record<string, unknown>>) {
        if (!String(statement["sql"]).includes("INSERT OR IGNORE INTO events")) continue;
        const events = JSON.parse(
          String(((statement["binds"] ?? []) as unknown[])[3]),
        ) as Array<Record<string, unknown>>;
        for (const event of events) {
          const id = String(event["event_id"]);
          const raw = JSON.stringify(event);
          const existing = rows.get(id);
          if (existing === undefined) {
            rows.set(id, raw);
            inserted++;
            continue;
          }
          if (existing !== raw) {
            // What D1 raises for RAISE(ABORT, 'event payload conflict').
            throw new Error(`event payload conflict: ${id}`);
          }
        }
      }
      inserts.push(inserted);
      return [];
    },
  };
  return { db, rows, inserts };
}

function spanFor(spanId: string, startMS: number, endMS: number, session = true) {
  return {
    traceId: HARDENING_TRACE,
    spanId,
    name: `span ${spanId}`,
    kind: 1,
    startTimeUnixNano: `${startMS}000000`,
    endTimeUnixNano: `${endMS}000000`,
    ...(session
      ? { attributes: [{ key: "session.id", value: { stringValue: "replay-session" } }] }
      : {}),
  };
}

function otlpRequest(spans: unknown[]): Request {
  return new Request("https://api.handoffgraph.dev/v1/otlp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEVICE_TOKEN}`,
      "content-type": "application/json",
      "x-hfg-capture": "full",
    },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  });
}

describe("worker: POST /v1/otlp observed_at is per event, not per export", () => {
  // Three spans of one trace; the SHARED span carries the session key so the
  // session identity never depends on batch composition either.
  const spanA = spanFor("aaaaaaaaaaaaaaa1", 1787918400000, 1787918401000, false);
  const shared = spanFor("bbbbbbbbbbbbbbb2", 1787918402000, 1787918403000);
  const spanC = spanFor("ccccccccccccccc3", 1787918404000, 1787918409000, false);

  it("re-sends an overlapping, differently-composed batch without a payload conflict", async () => {
    const spine = spineDb();
    const env = { DB: spine.db as never };

    const first = await worker.fetch(otlpRequest([spanA, shared]), env, CTX);
    expect(first.status).toBe(200);
    const afterFirst = new Map(spine.rows);
    expect(afterFirst.size).toBe(2 * 2 + 2 + 1); // 2 spans x 2 + trace pair + session

    // A DIFFERENT composition that re-includes the shared span. Under a
    // whole-export observed_at the shared span's events would carry a new
    // timestamp here and RAISE(ABORT, 'event payload conflict').
    const second = await worker.fetch(otlpRequest([shared, spanC]), env, CTX);
    expect(second.status).toBe(200);

    // The shared span's two events are byte-identical in both batches, so
    // INSERT OR IGNORE deduped them: zero new rows from that span.
    const sharedIDs = [
      await otlpEventID(`span-start|${HARDENING_TRACE}|${shared.spanId}`, 1787918402000),
      await otlpEventID(`span-end|${HARDENING_TRACE}|${shared.spanId}`, 1787918403000),
    ];
    for (const id of sharedIDs) {
      expect(afterFirst.has(id)).toBe(true);
      expect(spine.rows.get(id)).toBe(afterFirst.get(id));
    }

    // And a straight replay of the first batch adds nothing at all.
    const sizeBeforeReplay = spine.rows.size;
    const replay = await worker.fetch(otlpRequest([spanA, shared]), env, CTX);
    expect(replay.status).toBe(200);
    expect(spine.rows.size).toBe(sizeBeforeReplay);
    expect(spine.inserts[spine.inserts.length - 1]).toBe(0);
  });

  it("derives observed_at from the event's own instant, never the wall clock", async () => {
    const spine = spineDb();
    const response = await worker.fetch(
      otlpRequest([spanA, shared, spanC]),
      { DB: spine.db as never },
      CTX,
    );
    expect(response.status).toBe(200);
    for (const raw of spine.rows.values()) {
      const event = JSON.parse(raw) as Record<string, unknown>;
      expect(event["observed_at"]).toBe(event["occurred_at"]);
    }
    // The whole-export maximum (the latest span end) is NOT what every event
    // carries — that was the batch-composition dependence.
    const observed = new Set([...spine.rows.values()].map((raw) => JSON.parse(raw)["observed_at"]));
    expect(observed.size).toBeGreaterThan(1);
  });
});
