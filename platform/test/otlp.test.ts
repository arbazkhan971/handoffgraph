import { describe, expect, it } from "vitest";

import {
  convertOtlpExport,
  deterministicID,
} from "../src/otlp";

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
