import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { convertOtlpExport } from "../src/otlp";
import {
  OtlpProtoError,
  decodeExportRequest,
  encodeExportTraceServiceResponse,
  isProtobufMediaType,
  type OtlpExportRequest,
  type OtlpSpan,
} from "../src/otlp_proto";
import { default as worker } from "../src/index";
import { sha256Hex } from "../src/auth";

// The Go-authored golden fixtures. Nothing is copied into this file: the same
// bytes the Go suite pins are read from disk and decoded here, which is what
// makes the four-corner claim (Go-protobuf == Go-JSON == TS-JSON ==
// TS-protobuf) a cross-language statement rather than a local round trip.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../testdata/fixtures/otlp");
const PB_FIXTURE = new Uint8Array(readFileSync(join(FIXTURE_DIR, "genai_session.pb")));
const JSON_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "genai_session.json"), "utf8"),
) as unknown;

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const CONVERT = { captureTier: "full", observedAt: OBSERVED_AT } as const;

// ---- an independent protobuf encoder ---------------------------------------
//
// Written top-down from the wire format so the tests below never lean on the
// decoder to build their inputs. Two independent implementations, one fixture.

function varint(v: number | bigint): number[] {
  const out: number[] = [];
  let n = BigInt(v);
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

const tag = (num: number, typ: number): number[] => varint(num * 8 + typ);

function lenDelim(num: number, payload: number[]): number[] {
  return [...tag(num, 2), ...varint(payload.length), ...payload];
}

function strField(num: number, s: string): number[] {
  return lenDelim(num, [...new TextEncoder().encode(s)]);
}

const varintField = (num: number, v: number | bigint): number[] => [...tag(num, 0), ...varint(v)];

function fixed64Field(num: number, v: bigint): number[] {
  const out = [...tag(num, 1)];
  let n = v;
  for (let i = 0; i < 8; i++) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return out;
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

type Attr = { key: string; str?: string; int?: number };

/** common.v1.KeyValue. */
function attr(a: Attr): number[] {
  const value = a.int === undefined ? strField(1, a.str ?? "") : varintField(3, a.int);
  return [...strField(1, a.key), ...lenDelim(2, value)];
}

type SpanSpec = {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  kind?: number;
  startNS: bigint;
  endNS: bigint;
  statusCode?: number;
  statusMessage?: string;
  attrs?: Attr[];
};

/** trace.v1.Span. */
function span(s: SpanSpec): number[] {
  let out = [...lenDelim(1, hexBytes(s.traceId)), ...lenDelim(2, hexBytes(s.spanId))];
  if (s.parentId) out = [...out, ...lenDelim(4, hexBytes(s.parentId))];
  out = [...out, ...strField(5, s.name)];
  if (s.kind) out = [...out, ...varintField(6, s.kind)];
  out = [...out, ...fixed64Field(7, s.startNS), ...fixed64Field(8, s.endNS)];
  for (const a of s.attrs ?? []) out = [...out, ...lenDelim(9, attr(a))];
  if (s.statusCode || s.statusMessage) {
    let status: number[] = [];
    if (s.statusMessage) status = [...status, ...strField(2, s.statusMessage)];
    if (s.statusCode) status = [...status, ...varintField(3, s.statusCode)];
    out = [...out, ...lenDelim(15, status)];
  }
  return out;
}

/** collector.trace.v1.ExportTraceServiceRequest from one scope of spans. */
function exportRequest(opts: {
  resource?: Attr[];
  scopeName?: string;
  scopeVersion?: string;
  spans: number[][];
}): Uint8Array {
  let scopeSpans: number[] = [];
  if (opts.scopeName !== undefined || opts.scopeVersion !== undefined) {
    scopeSpans = lenDelim(1, [
      ...strField(1, opts.scopeName ?? ""),
      ...strField(2, opts.scopeVersion ?? ""),
    ]);
  }
  for (const s of opts.spans) scopeSpans = [...scopeSpans, ...lenDelim(2, s)];
  let rs: number[] = [];
  if (opts.resource) {
    let resource: number[] = [];
    for (const a of opts.resource) resource = [...resource, ...lenDelim(1, attr(a))];
    rs = lenDelim(1, resource);
  }
  rs = [...rs, ...lenDelim(2, scopeSpans)];
  return new Uint8Array(lenDelim(1, rs));
}

const TRACE = "0af7651916cd43dd8448eb211c80319c";

/** The struct-literal twin of testdata/fixtures/otlp/genai_session.json. */
function genaiSessionFixture(): Uint8Array {
  return exportRequest({
    resource: [
      { key: "service.name", str: "codex-cli" },
      { key: "deployment.environment", str: "local" },
    ],
    scopeName: "github.com/handoffgraph/agent-instrumentation",
    scopeVersion: "0.1.0",
    spans: [
      span({
        traceId: TRACE,
        spanId: "b7ad6b7169203331",
        name: "run agent",
        kind: 1,
        startNS: 1756334400000000000n,
        endNS: 1756334405000000000n,
        statusCode: 1,
        attrs: [
          { key: "session.id", str: "agent-session-77" },
          { key: "handoffgraph.objective", str: "fix checkout race" },
        ],
      }),
      span({
        traceId: TRACE,
        spanId: "5b8efff798038103",
        parentId: "b7ad6b7169203331",
        name: "chat gpt-5.3",
        kind: 3,
        startNS: 1756334401000000000n,
        endNS: 1756334404000000000n,
        statusCode: 2,
        statusMessage: "rate limited",
        attrs: [
          { key: "gen_ai.operation.name", str: "chat" },
          { key: "gen_ai.request.model", str: "gpt-5.3" },
          { key: "gen_ai.usage.input_tokens", int: 1200 },
          { key: "gen_ai.usage.output_tokens", int: 350 },
          { key: "gen_ai.usage.cache_read.input_tokens", int: 200 },
          { key: "__proto__", str: "dropped-me" },
          { key: "llm.prompt", str: "fix the duplicate checkout submission" },
        ],
      }),
      span({
        traceId: TRACE,
        spanId: "8c21f4a1e0d3bb44",
        parentId: "b7ad6b7169203331",
        name: "execute_tool apply_patch",
        kind: 1,
        startNS: 1756334402000000000n,
        endNS: 1756334403000000000n,
        attrs: [{ key: "gen_ai.tool.name", str: "apply_patch" }],
      }),
    ],
  });
}

/** A minimal one-span request, for the wire-level tests. */
function oneSpanRequest(body: number[]): Uint8Array {
  return new Uint8Array(lenDelim(1, lenDelim(2, lenDelim(2, body))));
}

// ---- the golden fixture -----------------------------------------------------

describe("OTLP/protobuf golden fixture", () => {
  it("matches the committed Go-authored bytes byte for byte", () => {
    // A third independent implementation of the same logical content: if this
    // fails, either the fixture drifted or one of the encoders is wrong.
    expect([...genaiSessionFixture()]).toEqual([...PB_FIXTURE]);
    expect(PB_FIXTURE.byteLength).toBe(753);
  });

  it("decodes to the very object graph the JSON fixture parses to", () => {
    // The strongest statement of flavor parity available: after decoding,
    // protobuf and JSON are not merely equivalent, they are the same body.
    expect(decodeExportRequest(PB_FIXTURE)).toEqual(JSON_FIXTURE);
  });

  it("bridges protobuf into the shapes the converter reads", () => {
    const req = decodeExportRequest(PB_FIXTURE);
    expect(req.resourceSpans).toHaveLength(1);
    const scopeSpans = req.resourceSpans[0].scopeSpans ?? [];
    expect(scopeSpans).toHaveLength(1);
    expect(scopeSpans[0].scope).toEqual({
      name: "github.com/handoffgraph/agent-instrumentation",
      version: "0.1.0",
    });
    const spans = scopeSpans[0].spans ?? [];
    expect(spans).toHaveLength(3);

    // Ids are lowercase hex; times are decimal strings, not numbers.
    expect(spans[0].traceId).toBe(TRACE);
    expect(spans[0].spanId).toBe("b7ad6b7169203331");
    expect(spans[0].parentSpanId).toBeUndefined();
    expect(spans[0].startTimeUnixNano).toBe("1756334400000000000");
    expect(spans[0].endTimeUnixNano).toBe("1756334405000000000");
    expect(typeof spans[0].startTimeUnixNano).toBe("string");

    // Enums are numbers, the proto3-JSON enum-number form.
    expect(spans[0].kind).toBe(1);
    expect(spans[0].status).toEqual({ code: 1 });
    expect(spans[1].parentSpanId).toBe("b7ad6b7169203331");
    expect(spans[1].status).toEqual({ code: 2, message: "rate limited" });
    // A span with no status message carries no status at all.
    expect(spans[2].status).toBeUndefined();

    // int64 attributes arrive as proto3-JSON decimal strings.
    const tokens = (spans[1].attributes ?? []).find(
      (kv) => kv.key === "gen_ai.usage.input_tokens",
    );
    expect(tokens?.value).toEqual({ intValue: "1200" });
  });
});

// ---- the headline: four-corner id parity ------------------------------------

describe("cross-flavor, cross-language id parity", () => {
  it("produces the same event ids from the .pb and the .json fixture", async () => {
    const fromProto = await convertOtlpExport(decodeExportRequest(PB_FIXTURE), CONVERT);
    const fromJson = await convertOtlpExport(JSON_FIXTURE, CONVERT);

    expect(fromProto.rejectedSpans).toEqual([]);
    expect(fromJson.rejectedSpans).toEqual([]);
    // 3 spans x 2 + trace pair + session.started.
    expect(fromProto.events).toHaveLength(9);
    expect(fromJson.events).toHaveLength(9);

    const protoIDs = fromProto.events.map((e) => e["event_id"] as string);
    const jsonIDs = fromJson.events.map((e) => e["event_id"] as string);
    expect(protoIDs.join("\n")).toBe(jsonIDs.join("\n"));

    // The Go suite pins this same id for the root span.started, so equality
    // here closes all four corners: Go-protobuf, Go-JSON, TS-JSON, TS-protobuf.
    expect(protoIDs).toContain("evt_01K3PV08G0MV7FMYGP6JTF36AN");

    // Not just the ids: the whole event stream, payloads and all.
    expect(fromProto.events).toEqual(fromJson.events);
    expect(fromProto.droppedAttributeKeys).toBe(fromJson.droppedAttributeKeys);
  });

  it("derives the same session/trace/span ids as the Go implementation", async () => {
    const res = await convertOtlpExport(decodeExportRequest(PB_FIXTURE), CONVERT);
    expect(new Set(res.events.map((e) => e["session_id"]))).toEqual(
      new Set(["ses_0000000000Z3NG62MJJ8C9XSQT"]),
    );
    const started = res.events.find((e) => e["kind"] === "trace.started");
    expect((started?.["payload"] as Record<string, unknown>)["trace_id"]).toBe(
      "trc_00000000002VMVPQJ146EGCPXN",
    );
  });

  it("is idempotent: decoding twice yields identical ids", async () => {
    const a = await convertOtlpExport(decodeExportRequest(PB_FIXTURE), CONVERT);
    const b = await convertOtlpExport(decodeExportRequest(PB_FIXTURE), {
      captureTier: "full",
      observedAt: "2027-01-01T00:00:00.000Z",
    });
    expect(a.events.map((e) => e["event_id"])).toEqual(b.events.map((e) => e["event_id"]));
  });
});

// ---- arrayValue fixture: the cross-flavor regression ------------------------
//
// ArrayValue's repeated field is `values` in the proto, so protobuf always
// decoded it correctly while the JSON converter did not understand the spec
// wrapper at all — the same telemetry diverged by wire flavor. This pair of
// fixtures is the Go-authored statement of that case
// (internal/otlp/arrayvalue_test.go pins the identical claim), read from disk
// here so the two languages judge the same bytes.

const ARRAY_PB_FIXTURE = new Uint8Array(readFileSync(join(FIXTURE_DIR, "array_values.pb")));
const ARRAY_JSON_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "array_values.json"), "utf8"),
) as unknown;

function completedAttributes(events: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const done = events.find((e) => e["kind"] === "span.completed");
  const payload = (done as { payload?: Record<string, unknown> } | undefined)?.["payload"];
  return (payload?.["attributes"] ?? {}) as Record<string, unknown>;
}

describe("arrayValue cross-flavor parity", () => {
  it("decodes the .pb into the very object graph the .json parses to", () => {
    expect(decodeExportRequest(ARRAY_PB_FIXTURE)).toEqual(ARRAY_JSON_FIXTURE);
  });

  it("carries arrayValue attributes through conversion identically in both flavors", async () => {
    const fromProto = await convertOtlpExport(decodeExportRequest(ARRAY_PB_FIXTURE), CONVERT);
    const fromJson = await convertOtlpExport(ARRAY_JSON_FIXTURE, CONVERT);

    expect(fromProto.rejectedSpans).toEqual([]);
    expect(fromJson.rejectedSpans).toEqual([]);
    expect(fromProto.events.length).toBeGreaterThan(0);

    // The arrays themselves: real lists, not an undecoded {arrayValue: …}
    // wrapper and not an empty list.
    const attributes = completedAttributes(fromJson.events);
    expect(attributes["tool.files"]).toEqual(["cmd/main.go", "internal/otlp/types.go"]);
    expect(attributes["tool.exit_codes"]).toEqual([0, 2]);
    expect(attributes["tool.matrix"]).toEqual([["unit", "race"]]);

    // And the flavors agree on every byte of every event, ids included.
    expect(fromProto.events.map((e) => e["event_id"])).toEqual(
      fromJson.events.map((e) => e["event_id"]),
    );
    expect(fromProto.events).toEqual(fromJson.events);
    expect(completedAttributes(fromProto.events)).toEqual(attributes);
  });
});

// ---- decoder behavior -------------------------------------------------------

describe("decodeExportRequest wire rules", () => {
  it("keeps nanosecond times exact past Number.MAX_SAFE_INTEGER", () => {
    // 2^63 - 1 ns: any hop through Number would round this to ...775808.
    const huge = 9223372036854775807n;
    // Sanity: a Number hop conflates these two distinct nanosecond instants,
    // which is exactly why the decoder must never take one.
    expect(Number(huge)).toBe(Number(huge - 1n));
    const body = oneSpanRequest(
      span({
        traceId: TRACE,
        spanId: "b7ad6b7169203331",
        name: "far future",
        startNS: huge - 1n,
        endNS: huge,
      }),
    );
    const decoded = decodeExportRequest(body);
    const decodedSpan = (decoded.resourceSpans[0].scopeSpans ?? [])[0].spans?.[0];
    expect(decodedSpan?.startTimeUnixNano).toBe("9223372036854775806");
    expect(decodedSpan?.endTimeUnixNano).toBe("9223372036854775807");
    expect(BigInt(decodedSpan?.endTimeUnixNano ?? "0")).toBe(huge);

    // And the full unsigned range survives too (fixed64 is unsigned on the wire).
    const max = oneSpanRequest(
      span({
        traceId: TRACE,
        spanId: "b7ad6b7169203331",
        name: "max",
        startNS: 0n,
        endNS: 18446744073709551615n,
      }),
    );
    const maxSpan = (decodeExportRequest(max).resourceSpans[0].scopeSpans ?? [])[0].spans?.[0];
    expect(maxSpan?.endTimeUnixNano).toBe("18446744073709551615");
  });

  it("walks every arm of the AnyValue oneof", () => {
    const anyValue = (payload: number[]): number[] => payload;
    const str = (s: string) => strField(1, s);
    const elements = [...lenDelim(1, str("a")), ...lenDelim(1, str("b"))];
    const kv = (key: string, value: number[]) => [...strField(1, key), ...lenDelim(2, value)];
    const attrs: number[][] = [
      kv("s", str("hello")),
      kv("b", varintField(2, 1)),
      kv("i", varintField(3, 42)),
      // 2.5 = 0x4004000000000000
      kv("d", fixed64Field(4, 0x4004000000000000n)),
      kv("arr", anyValue(lenDelim(5, elements))),
      kv("kvl", anyValue(lenDelim(6, lenDelim(1, kv("inner", str("deep")))))),
      kv("raw", anyValue(lenDelim(7, [0xde, 0xad]))),
      kv("unset", []),
    ];
    let body = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...strField(5, "kinds"),
      ...fixed64Field(7, 1756334400000000000n),
      ...fixed64Field(8, 1756334401000000000n),
    ];
    for (const a of attrs) body = [...body, ...lenDelim(9, a)];

    const decoded = decodeExportRequest(oneSpanRequest(body));
    const got = new Map(
      ((decodeSpans(decoded)[0].attributes ?? []) as { key: string; value?: unknown }[]).map(
        (pair) => [pair.key, pair.value],
      ),
    );
    expect(got.get("s")).toEqual({ stringValue: "hello" });
    expect(got.get("b")).toEqual({ boolValue: true });
    expect(got.get("i")).toEqual({ intValue: "42" });
    expect(got.get("d")).toEqual({ doubleValue: 2.5 });
    expect(got.get("arr")).toEqual({
      arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] },
    });
    expect(got.get("kvl")).toEqual({
      kvlistValue: { values: [{ key: "inner", value: { stringValue: "deep" } }] },
    });
    // bytes take the representation the JSON flavor carries: standard base64.
    expect(got.get("raw")).toEqual({ bytesValue: "3q0=" });
    // An AnyValue with nothing set is the empty message, exactly as in JSON.
    expect(got.get("unset")).toEqual({});
  });

  it("reads a negative int64 as its signed decimal string", () => {
    const kv = [...strField(1, "delta"), ...lenDelim(2, varintField(3, 18446744073709551615n))];
    const body = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
      ...lenDelim(9, kv),
    ];
    const decoded = decodeExportRequest(oneSpanRequest(body));
    expect(decodeSpans(decoded)[0].attributes?.[0].value).toEqual({ intValue: "-1" });
  });

  it("applies proto3 last-wins to repeated scalars and the AnyValue oneof", () => {
    const kv = [
      ...strField(1, "first"),
      ...strField(1, "second"), // key: last wins
      ...lenDelim(2, [...strField(1, "ignored"), ...varintField(3, 7)]), // oneof: last wins
    ];
    const body = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...strField(5, "first name"),
      ...strField(5, "second name"),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
      ...lenDelim(9, kv),
    ];
    const sp = decodeSpans(decodeExportRequest(oneSpanRequest(body)))[0];
    expect(sp.name).toBe("second name");
    expect(sp.attributes).toEqual([{ key: "second", value: { intValue: "7" } }]);

    // A later EMPTY scalar still overrides an earlier non-empty one, so the
    // decoded body is what proto3 JSON would have carried (the field omitted).
    const cleared = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...strField(5, "named"),
      ...strField(5, ""),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
    ];
    expect(decodeSpans(decodeExportRequest(oneSpanRequest(cleared)))[0].name).toBeUndefined();
  });

  it("skips unknown fields so a newer emitter never breaks ingest", async () => {
    const base = decodeExportRequest(PB_FIXTURE);
    const known = (base.resourceSpans[0].scopeSpans ?? [])[0].spans?.[0];

    let body = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...strField(5, "run agent"),
      ...varintField(6, 1),
      ...fixed64Field(7, 1756334400000000000n),
      ...fixed64Field(8, 1756334405000000000n),
      ...lenDelim(9, attr({ key: "session.id", str: "agent-session-77" })),
      ...lenDelim(9, attr({ key: "handoffgraph.objective", str: "fix checkout race" })),
      ...varintField(10, 3), // dropped_attributes_count
    ];
    // A span event (decoded, unused by the converter), then the counts, links
    // and flags that newer OTLP releases carry.
    const spanEvent = [
      ...fixed64Field(1, 1756334400000000001n),
      ...strField(2, "gen_ai.content.prompt"),
      ...lenDelim(3, attr({ key: "note", str: "hi" })),
    ];
    body = [
      ...body,
      ...lenDelim(11, spanEvent),
      ...varintField(12, 1), // dropped_events_count
      ...lenDelim(13, lenDelim(1, hexBytes(TRACE))), // links (validated, dropped)
      ...varintField(14, 2), // dropped_links_count
      ...lenDelim(15, varintField(3, 1)),
      ...tag(16, 5), 0, 0, 0, 0, // flags, fixed32
      ...strField(99, "from the future"),
    ];

    let scopeSpans = lenDelim(1, [
      ...strField(1, "github.com/handoffgraph/agent-instrumentation"),
      ...strField(2, "0.1.0"),
    ]);
    scopeSpans = [
      ...scopeSpans,
      ...lenDelim(2, body),
      ...strField(3, "https://opentelemetry.io/schemas/1.30.0"),
      ...varintField(77, 9),
    ];
    let resource = lenDelim(1, attr({ key: "service.name", str: "codex-cli" }));
    resource = [...resource, ...varintField(2, 4)]; // dropped_attributes_count
    let rs = [...lenDelim(1, resource), ...lenDelim(2, scopeSpans)];
    rs = [
      ...rs,
      ...strField(3, "https://opentelemetry.io/schemas/1.30.0"),
      ...lenDelim(1000, []), // the reserved legacy field
    ];
    const wire = new Uint8Array([...lenDelim(1, rs), ...varintField(42, 7)]);

    const decoded = decodeExportRequest(wire);
    const got = decodeSpans(decoded)[0];
    expect(got.traceId).toBe(known?.traceId);
    expect(got.spanId).toBe(known?.spanId);
    expect(got.name).toBe(known?.name);
    expect(got.startTimeUnixNano).toBe(known?.startTimeUnixNano);
    expect(got.endTimeUnixNano).toBe(known?.endTimeUnixNano);
    expect(got.droppedAttributesCount).toBe(3);
    expect(decoded.resourceSpans[0].resource?.droppedAttributesCount).toBe(4);
    expect(decoded.resourceSpans[0].schemaUrl).toBe("https://opentelemetry.io/schemas/1.30.0");
    expect((decoded.resourceSpans[0].scopeSpans ?? [])[0].schemaUrl).toBe(
      "https://opentelemetry.io/schemas/1.30.0",
    );
    // Span events decode, and do not disturb the derived event stream.
    expect(got.events).toEqual([
      {
        timeUnixNano: "1756334400000000001",
        name: "gen_ai.content.prompt",
        attributes: [{ key: "note", value: { stringValue: "hi" } }],
      },
    ]);
    const converted = await convertOtlpExport(decoded, CONVERT);
    expect(converted.rejectedSpans).toEqual([]);
    expect(converted.events).toHaveLength(5);
  });

  it("fails closed on every truncation prefix, cleanly and without inventing spans", async () => {
    const whole = decodeExportRequest(PB_FIXTURE);
    const known = new Set(decodeSpans(whole).map(spanSignature));

    let errors = 0;
    let clean = 0;
    for (let n = 0; n <= PB_FIXTURE.byteLength; n++) {
      const prefix = PB_FIXTURE.subarray(0, n);
      let decoded;
      try {
        decoded = decodeExportRequest(prefix);
      } catch (error) {
        // Clean, typed errors only — no TypeError/RangeError leaking out of
        // the wire reader.
        expect(error).toBeInstanceOf(OtlpProtoError);
        expect((error as Error).message.startsWith("protobuf: ")).toBe(true);
        errors++;
        continue;
      }
      clean++;
      for (const sp of decodeSpans(decoded)) {
        expect(known.has(spanSignature(sp))).toBe(true);
      }
      // A subset must still convert without throwing.
      await convertOtlpExport(decoded, CONVERT);
    }
    expect(errors).toBeGreaterThan(0);
    expect(clean).toBeGreaterThan(0);
  });

  it("stays panic-free under single-byte corruption", async () => {
    // Deterministic mutation, so a failure reproduces exactly. Corrupted
    // bytes may legitimately change a decoded id, so the contract here is
    // narrower than for truncation: either a clean typed error, or a body
    // the converter digests without throwing.
    let errors = 0;
    for (let i = 0; i < PB_FIXTURE.byteLength; i++) {
      const mutated = new Uint8Array(PB_FIXTURE);
      mutated[i] ^= 0xff;
      let decoded;
      try {
        decoded = decodeExportRequest(mutated);
      } catch (error) {
        expect(error, `byte ${i}`).toBeInstanceOf(OtlpProtoError);
        errors++;
        continue;
      }
      await convertOtlpExport(decoded, CONVERT);
    }
    expect(errors).toBeGreaterThan(0);
  });

  it("rejects a self-nesting attribute bomb instead of blowing the stack", () => {
    const build = (levels: number): Uint8Array => {
      let anyValue = strField(1, "bottom");
      for (let i = 0; i < levels; i++) {
        const kv = [...strField(1, "k"), ...lenDelim(2, anyValue)];
        anyValue = lenDelim(6, lenDelim(1, kv));
      }
      const body = [
        ...lenDelim(1, hexBytes(TRACE)),
        ...lenDelim(2, hexBytes("b7ad6b7169203331")),
        ...fixed64Field(7, 1756334400000000000n),
        ...fixed64Field(8, 1756334401000000000n),
        ...lenDelim(9, [...strField(1, "deep"), ...lenDelim(2, anyValue)]),
      ];
      return oneSpanRequest(body);
    };
    expect(() => decodeExportRequest(build(3))).not.toThrow();
    expect(() => decodeExportRequest(build(40))).toThrow(OtlpProtoError);
    expect(() => decodeExportRequest(build(40))).toThrow(/nesting exceeds 32 levels/);
  });

  it("rejects malformed wire encodings fail-closed", () => {
    const cases: [name: string, body: number[]][] = [
      ["truncated tag", [0x0a]],
      ["group wire type", tag(1, 3)],
      ["end-group wire type", tag(1, 4)],
      ["wire type mismatch", varintField(1, 5)],
      ["truncated inner varint", [0x0a, 0x02, 0xff, 0xff]],
      [
        "varint overflow",
        [0x0a, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      ],
      ["zero field number", [0x00, 0x00]],
      ["length beyond the buffer", [0x0a, 0x7f, 0x01]],
    ];
    for (const [name, body] of cases) {
      expect(() => decodeExportRequest(new Uint8Array(body)), name).toThrow(OtlpProtoError);
    }
    // The body cap is enforced by the decoder itself, not only by the reader.
    expect(() => decodeExportRequest(new Uint8Array(1_048_577))).toThrow(/exceeds 1048576 bytes/);
  });

  it("splits the UTF-8 policy: structural strings reject, span strings do not", async () => {
    const invalid = [0xff, 0xfe]; // never a valid UTF-8 sequence
    const goodSpan = span({
      traceId: TRACE,
      spanId: "b7ad6b7169203331",
      name: "ok",
      startNS: 1756334400000000000n,
      endNS: 1756334401000000000n,
    });

    // Structural: scope name, schema urls, trace state and status message
    // land in payloads without passing the per-span sanitizer, so bad bytes
    // reject the whole request.
    const scopeSpans = [...lenDelim(1, lenDelim(1, invalid)), ...lenDelim(2, goodSpan)];
    expect(() => decodeExportRequest(new Uint8Array(lenDelim(1, lenDelim(2, scopeSpans)))))
      .toThrow(/InstrumentationScope.name is not valid UTF-8/);

    const withSchemaUrl = [...lenDelim(2, lenDelim(2, goodSpan)), ...lenDelim(3, invalid)];
    expect(() => decodeExportRequest(new Uint8Array(lenDelim(1, withSchemaUrl))))
      .toThrow(/ResourceSpans.schema_url is not valid UTF-8/);

    const withTraceState = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...lenDelim(3, invalid), // trace_state
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
    ];
    expect(() => decodeExportRequest(oneSpanRequest(withTraceState)))
      .toThrow(/Span.trace_state is not valid UTF-8/);

    const withStatusMessage = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
      ...lenDelim(15, [...lenDelim(2, invalid), ...varintField(3, 2)]),
    ];
    expect(() => decodeExportRequest(oneSpanRequest(withStatusMessage)))
      .toThrow(/Status.message is not valid UTF-8/);

    // Per-span: the span name and attribute strings are handed to the
    // sanitizer instead of rejecting the batch, so one hostile span never
    // takes the export down with it.
    const spanLevel = [
      ...lenDelim(1, hexBytes(TRACE)),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...lenDelim(5, invalid), // name
      ...fixed64Field(7, 1756334400000000000n),
      ...fixed64Field(8, 1756334401000000000n),
      ...lenDelim(9, [...lenDelim(1, invalid), ...lenDelim(2, lenDelim(1, invalid))]),
    ];
    const decoded = decodeExportRequest(oneSpanRequest(spanLevel));
    const converted = await convertOtlpExport(decoded, CONVERT);
    expect(converted.events.length).toBeGreaterThan(0);
  });

  it("accepts an empty request and an empty resource_spans entry", async () => {
    expect(decodeExportRequest(new Uint8Array(0))).toEqual({ resourceSpans: [] });
    expect(decodeExportRequest(new Uint8Array(lenDelim(1, [])))).toEqual({
      resourceSpans: [{}],
    });
    const res = await convertOtlpExport(decodeExportRequest(new Uint8Array(0)), CONVERT);
    expect(res.events).toEqual([]);
  });
});

/** Every span of a decoded request, flattened. */
function decodeSpans(req: OtlpExportRequest): OtlpSpan[] {
  const out: OtlpSpan[] = [];
  for (const rs of req.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) out.push(...(ss.spans ?? []));
  }
  return out;
}

function spanSignature(sp: OtlpSpan): string {
  return [
    sp.traceId ?? "",
    sp.spanId ?? "",
    sp.parentSpanId ?? "",
    sp.name ?? "",
    sp.startTimeUnixNano ?? "",
    sp.endTimeUnixNano ?? "",
  ].join("|");
}

// ---- ExportTraceServiceResponse --------------------------------------------

/**
 * An independent reader for the response bytes, so the handler tests assert
 * on the real wire form rather than on the struct that produced it.
 */
function decodeExportResponse(
  body: Uint8Array,
): { rejectedSpans: number; errorMessage: string } | null {
  let pos = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 1;
    for (;;) {
      const b = body[pos++];
      v += (b & 0x7f) * shift;
      if (b < 0x80) return v;
      shift *= 128;
    }
  };
  let out: { rejectedSpans: number; errorMessage: string } | null = null;
  while (pos < body.length) {
    const t = readVarint();
    const num = Math.floor(t / 8);
    const typ = t & 7;
    if (typ !== 2) throw new Error(`unexpected wire type ${typ}`);
    const len = readVarint();
    const payload = body.subarray(pos, pos + len);
    pos += len;
    if (num !== 1) continue;
    const partial = { rejectedSpans: 0, errorMessage: "" };
    let inner = 0;
    const readInnerVarint = (): number => {
      let v = 0;
      let shift = 1;
      for (;;) {
        const b = payload[inner++];
        v += (b & 0x7f) * shift;
        if (b < 0x80) return v;
        shift *= 128;
      }
    };
    while (inner < payload.length) {
      const it = readInnerVarint();
      const inum = Math.floor(it / 8);
      const ityp = it & 7;
      if (ityp === 0) {
        const v = readInnerVarint();
        if (inum === 1) partial.rejectedSpans = v;
      } else if (ityp === 2) {
        const ilen = readInnerVarint();
        const chunk = payload.subarray(inner, inner + ilen);
        inner += ilen;
        if (inum === 2) partial.errorMessage = new TextDecoder().decode(chunk);
      } else {
        throw new Error(`unexpected inner wire type ${ityp}`);
      }
    }
    out = partial;
  }
  return out;
}

describe("encodeExportTraceServiceResponse", () => {
  it("encodes a full success as the empty message", () => {
    const bytes = encodeExportTraceServiceResponse(null);
    expect(bytes.byteLength).toBe(0);
    expect(decodeExportResponse(bytes)).toBeNull();
  });

  it("round-trips rejected spans and the error message", () => {
    const bytes = encodeExportTraceServiceResponse({
      rejectedSpans: 300,
      errorMessage: "span b7ad6b7169203331: traceId must be 32 hex chars",
    });
    expect(decodeExportResponse(bytes)).toEqual({
      rejectedSpans: 300,
      errorMessage: "span b7ad6b7169203331: traceId must be 32 hex chars",
    });
  });

  it("omits the zero fields, as proto3 requires", () => {
    // partial_success present but empty: a 2-byte message (tag + length 0).
    expect([...encodeExportTraceServiceResponse({ rejectedSpans: 0, errorMessage: "" })])
      .toEqual([0x0a, 0x00]);
  });
});

describe("isProtobufMediaType", () => {
  const cases: [string, boolean][] = [
    ["application/x-protobuf", true],
    ["application/protobuf", true],
    ["application/x-protobuf; charset=binary", true],
    ["  APPLICATION/X-PROTOBUF  ", true],
    ["application/json", false],
    ["", false],
    ["text/plain;charset=UTF-8", false],
  ];
  for (const [value, want] of cases) {
    it(`${JSON.stringify(value)} -> ${want}`, () => {
      expect(isProtobufMediaType(value)).toBe(want);
    });
  }
});

// ---- worker route -----------------------------------------------------------

const CTX = {} as never;

function mockDb(handlers: {
  first?: (sql: string, binds: unknown[]) => unknown;
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

function protobufRequest(body: Uint8Array, contentType = "application/x-protobuf"): Request {
  return new Request("https://api.handoffgraph.dev/v1/otlp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEVICE_TOKEN}`,
      "content-type": contentType,
      "x-hfg-capture": "full",
    },
    body,
  });
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe("worker: POST /v1/otlp (protobuf flavor)", () => {
  it("accepts a protobuf export and answers with a protobuf response", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(protobufRequest(PB_FIXTURE), { DB: db as never }, CTX);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-protobuf");
    // A full success is the empty ExportTraceServiceResponse.
    const bytes = await responseBytes(response);
    expect(bytes.byteLength).toBe(0);
    expect(decodeExportResponse(bytes)).toBeNull();

    // The full pipeline ran: one atomic D1 batch with the 9 converted events.
    expect(batches).toHaveLength(1);
    const insert = (batches[0] as Array<Record<string, unknown>>).find((s) =>
      String(s["sql"]).includes("INSERT OR IGNORE INTO events"),
    );
    const stored = JSON.parse(
      String(((insert?.["binds"] ?? []) as unknown[])[3]),
    ) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(9);
    expect(new Set(stored.map((e) => e["session_id"]))).toEqual(
      new Set(["ses_0000000000Z3NG62MJJ8C9XSQT"]),
    );
  });

  it("stores exactly what the JSON flavor of the same telemetry stores", async () => {
    const storedFor = async (request: Request): Promise<Array<Record<string, unknown>>> => {
      const { db, batches } = mockDb({ first: deviceRegistry() });
      const response = await worker.fetch(request, { DB: db as never }, CTX);
      expect(response.status).toBe(200);
      const insert = (batches[0] as Array<Record<string, unknown>>).find((s) =>
        String(s["sql"]).includes("INSERT OR IGNORE INTO events"),
      );
      return JSON.parse(String(((insert?.["binds"] ?? []) as unknown[])[3]));
    };

    const fromProto = await storedFor(protobufRequest(PB_FIXTURE));
    const fromJson = await storedFor(
      new Request("https://api.handoffgraph.dev/v1/otlp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          "content-type": "application/json",
          "x-hfg-capture": "full",
        },
        body: JSON.stringify(JSON_FIXTURE),
      }),
    );
    // Byte-identical storage: the flavor never reaches the spine.
    expect(JSON.stringify(fromProto)).toBe(JSON.stringify(fromJson));
  });

  it("derives the same idempotency key for both flavors", async () => {
    const keyFor = async (request: Request): Promise<string> => {
      const { db, batches } = mockDb({ first: deviceRegistry() });
      await worker.fetch(request, { DB: db as never }, CTX);
      const insert = (batches[0] as Array<Record<string, unknown>>).find((s) =>
        String(s["sql"]).includes("INSERT INTO idempotency_keys"),
      );
      return String(((insert?.["binds"] ?? []) as unknown[])[0]);
    };
    const protoKey = await keyFor(protobufRequest(PB_FIXTURE));
    const jsonKey = await keyFor(
      new Request("https://api.handoffgraph.dev/v1/otlp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          "content-type": "application/json",
          "x-hfg-capture": "full",
        },
        body: JSON.stringify(JSON_FIXTURE),
      }),
    );
    expect(protoKey.startsWith("otlp-")).toBe(true);
    expect(protoKey).toBe(jsonKey);
  });

  it("accepts the application/protobuf alias", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      protobufRequest(PB_FIXTURE, "application/protobuf"),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-protobuf");
  });

  it("reports rejected spans in the protobuf response body", async () => {
    // One span with a 4-byte trace id (illegal: OTLP trace ids are 16 bytes)
    // and one good span, in a single batch.
    const bad = [
      ...lenDelim(1, [1, 2, 3, 4]),
      ...lenDelim(2, hexBytes("b7ad6b7169203331")),
      ...strField(5, "short trace id"),
      ...fixed64Field(7, 1756334400000000000n),
      ...fixed64Field(8, 1756334400000000001n),
    ];
    const good = span({
      traceId: TRACE,
      spanId: "5b8efff798038103",
      name: "ok span",
      kind: 1,
      startNS: 1756334400000000000n,
      endNS: 1756334400000000001n,
    });
    const body = new Uint8Array(
      lenDelim(1, lenDelim(2, [...lenDelim(2, bad), ...lenDelim(2, good)])),
    );

    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(protobufRequest(body), { DB: db as never }, CTX);
    expect(response.status).toBe(200);
    const partial = decodeExportResponse(await responseBytes(response));
    expect(partial?.rejectedSpans).toBe(1);
    expect(partial?.errorMessage).toContain("traceId");
    expect(partial?.errorMessage.startsWith("span b7ad6b7169203331: ")).toBe(true);
  });

  it("answers garbage protobuf with a clean 400, never a 500", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      protobufRequest(new Uint8Array([0x78])),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await response.json()) as { error?: string };
    expect(body.error?.startsWith("protobuf: ")).toBe(true);
  });

  it("respects the shared 1 MiB body cap before decoding", async () => {
    const { db, batches } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      protobufRequest(new Uint8Array(1_048_577)),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body exceeds 1 MiB" });
    expect(batches).toHaveLength(0);
  });

  it("rejects an unauthenticated protobuf export before reading the body", async () => {
    const { db } = mockDb();
    const response = await worker.fetch(
      new Request("https://api.handoffgraph.dev/v1/otlp", {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: PB_FIXTURE,
      }),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(401);
  });

  it("rejects an empty protobuf export as JSON, not as a protobuf response", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      protobufRequest(new Uint8Array(0)),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no convertible spans", rejected_spans: 0 });
  });

  it("leaves the JSON flavor byte-identical to today", async () => {
    const { db } = mockDb({ first: deviceRegistry() });
    const response = await worker.fetch(
      new Request("https://api.handoffgraph.dev/v1/otlp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          "content-type": "application/json",
          "x-hfg-capture": "full",
        },
        body: JSON.stringify(JSON_FIXTURE),
      }),
      { DB: db as never },
      CTX,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const receipt = (await response.json()) as Record<string, unknown>;
    expect(receipt["schema_version"]).toBe("hfg.event-batch.receipt.v1");
    expect(receipt["otlp"]).toEqual({
      rejected_spans: 0,
      dropped_attribute_keys: 0,
      capture_tier: "full",
    });
  });
});
