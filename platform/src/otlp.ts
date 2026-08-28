/**
 * OTLP/JSON → hfg.event.v1 conversion for the hosted Worker (parity row 2,
 * hosted flavor). Pure functions; mirrors internal/otlp exactly so the same
 * telemetry yields the same deterministic ids locally and hosted.
 *
 * Identifier parity is pinned by golden tests against the Go implementation
 * (internal/ids.Deterministic): ULID = encodeTime(ms) ‖ encodeEntropy(
 * sha256(prefix + "|" + key)[0..10]) using the canonical Crockford layout.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_MAX_TIME = 2 ** 48 - 1;

const EVENT_PREFIX = "evt_";
const SESSION_PREFIX = "ses_";
const TRACE_PREFIX = "trc_";
const SPAN_PREFIX = "spn_";

/** Reserved attribute keys dropped (and counted) everywhere. */
const RESERVED_ATTR_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_ATTR_STRING_BYTES = 64 * 1024;
const MAX_ATTR_DEPTH = 10;

export type CaptureTier = "minimal" | "metadata" | "full";

const BODY_ATTR_PREFIXES = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.content",
  "llm.prompt",
  "llm.completion",
  "input.value",
  "output.value",
  "retrieval.documents",
  "prompt.body",
  "response.body",
  "coding_agent.transcript",
  "coding_agent.diff",
];

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Canonical ULID time encoding: 48-bit ms → 10 Crockford chars. */
function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[ms & 31] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Canonical ULID entropy encoding: 10 bytes → 16 Crockford chars. */
function encodeEntropy(e: Uint8Array): string {
  const at = (i: number) => e[i];
  let out = "";
  for (let i = 0; i < 10; i += 5) {
    const b0 = at(i), b1 = at(i + 1), b2 = at(i + 2), b3 = at(i + 3), b4 = at(i + 4);
    out +=
      CROCKFORD[b0 >> 3] +
      CROCKFORD[((b0 & 7) << 2) | (b1 >> 6)] +
      CROCKFORD[(b1 & 63) >> 1] +
      CROCKFORD[((b1 & 1) << 4) | (b2 >> 4)] +
      CROCKFORD[((b2 & 15) << 1) | (b3 >> 7)] +
      CROCKFORD[(b3 & 127) >> 2] +
      CROCKFORD[((b3 & 3) << 3) | (b4 >> 5)] +
      CROCKFORD[b4 & 31];
  }
  return out;
}

/**
 * Deterministic id, byte-compatible with Go internal/ids.Deterministic:
 * prefix + ULID(ms, sha256(prefix + "|" + key)[0..10]).
 */
export async function deterministicID(
  prefix: string,
  key: string,
  timestampMS: number,
): Promise<string> {
  let ms = Math.trunc(timestampMS);
  if (ms < 0) ms = 0;
  if (ms > ULID_MAX_TIME) ms = 0;
  const entropy = (await sha256Bytes(`${prefix}|${key}`)).slice(0, 10);
  return prefix + encodeTime(ms) + encodeEntropy(entropy);
}

export const otlpEventID = (key: string, tsMS: number) => deterministicID(EVENT_PREFIX, `otlp|${key}`, tsMS);
export const otlpSessionID = (sessionKey: string) => deterministicID(SESSION_PREFIX, `otlp|${sessionKey}`, 0);
export const otlpTraceID = (traceHex: string) => deterministicID(TRACE_PREFIX, `otlp|${traceHex}`, 0);
export const otlpSpanID = (traceHex: string, spanHex: string, tsMS: number) =>
  deterministicID(SPAN_PREFIX, `otlp|${traceHex}|${spanHex}`, tsMS);

/**
 * A value a wire decoder could not represent losslessly, carrying the message
 * the Go implementation reports for the same input.
 *
 * It exists because JS strings cannot hold what Go strings can: OTLP/protobuf
 * carries raw bytes for span names, attribute keys and string values, and Go
 * defers judging them to the per-span sanitizer (`utf8String`), which rejects
 * the SPAN fail-closed while its siblings still convert. Decoding those bytes
 * leniently here would rewrite them to U+FFFD and accept telemetry Go refuses,
 * so `src/otlp_proto.ts` hands the converter one of these instead and the
 * sanitizer below turns it into the same per-span rejection.
 *
 * It is a class, not a plain object, precisely so a hostile payload cannot
 * forge one: `JSON.parse` never produces a class instance.
 */
export class OtlpUndecodable {
  constructor(readonly reason: string) {}
}

/** Narrowing guard for {@link OtlpUndecodable}. */
export function isOtlpUndecodable(value: unknown): value is OtlpUndecodable {
  return value instanceof OtlpUndecodable;
}

// ---- OTLP wire types (loose; validated during conversion) -----------------

type KV = { key: unknown; value?: unknown };
type OTLPSpan = {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  kind?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: unknown;
  status?: { message?: unknown; code?: unknown } | null;
};
type ResourceSpans = {
  resource?: { attributes?: unknown } | null;
  scopeSpans?: { scope?: { name?: unknown; version?: unknown } | null; spans?: unknown }[];
};

export type HfgEvent = Record<string, unknown>;

export type ConvertResult = {
  /** Canonical hfg.event.v1 events (not yet enveloped). */
  events: HfgEvent[];
  droppedAttributeKeys: number;
  rejectedSpans: { traceId: string; spanId: string; error: string }[];
};

type TraceAccum = {
  sessionKey: string;
  minStartNS: bigint;
  maxEndNS: bigint;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  hasUsage: boolean;
};

type SessionAccum = { minStartNS: bigint; agent: string };

/** Convert one OTLP/JSON export request into canonical events. */
export async function convertOtlpExport(
  body: unknown,
  opts: { workstreamID?: string; captureTier: CaptureTier; observedAt?: string },
): Promise<ConvertResult> {
  const result: ConvertResult = { events: [], droppedAttributeKeys: 0, rejectedSpans: [] };
  if (body === null || typeof body !== "object") return result;
  const req = body as { resourceSpans?: ResourceSpans[] };
  if (!Array.isArray(req.resourceSpans)) return result;

  const observedAt = opts.observedAt ?? new Date().toISOString();
  const startNSByKey = new Map<string, bigint>();
  const sessionKeyByTrace = new Map<string, string>();

  // Phase 1: record start times + explicit session keys for linkage.
  for (const rs of req.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of (ss.spans ?? []) as OTLPSpan[]) {
        const traceHex = typeof sp.traceId === "string" ? sp.traceId.toLowerCase() : "";
        const spanHex = typeof sp.spanId === "string" ? sp.spanId.toLowerCase() : "";
        if (!isHex(traceHex, 32) || !isHex(spanHex, 16)) continue;
        const ns = parseNano(sp.startTimeUnixNano);
        if (ns !== null) startNSByKey.set(`${traceHex}|${spanHex}`, ns);
        if (!sessionKeyByTrace.has(traceHex)) {
          // Session-key precedence (first hit wins): session.id, then the
          // OTel GenAI semconv session-correlation attribute
          // gen_ai.conversation.id, then the older Langfuse/HandoffGraph/
          // generic keys. Mirrored in the per-span lookup below and in
          // internal/otlp/convert.go.
          const key = rawStrAttr(sp.attributes, "session.id", "gen_ai.conversation.id", "langfuse.session.id", "handoffgraph.session_id", "session_id");
          if (key) sessionKeyByTrace.set(traceHex, key);
        }
      }
    }
  }

  const traces = new Map<string, TraceAccum>();
  const sessions = new Map<string, SessionAccum>();
  const emit = (
    id: string,
    atNS: bigint,
    sessionID: string,
    sessionKey: string,
    kind: string,
    payload: Record<string, unknown>,
    extra: { model?: string; agent?: string; parents?: string[] },
  ) => {
    const ev: HfgEvent = {
      schema_version: "hfg.event.v1",
      event_id: id,
      occurred_at: isoFromNS(atNS),
      observed_at: observedAt,
      provider: "otlp",
      kind,
      provenance: "OBSERVED",
      payload,
    };
    if (opts.workstreamID) ev.workstream_id = opts.workstreamID;
    ev.session_id = sessionID;
    ev.native_session_id = sessionKey;
    if (extra.model) ev.model = extra.model;
    if (extra.agent) ev.agent = extra.agent;
    if (extra.parents && extra.parents.length > 0) ev.parent_event_ids = extra.parents;
    result.events.push(ev);
  };

  for (const rs of req.resourceSpans) {
    const resourceAttrs = sanitizeKV(rs.resource?.attributes, 0);
    if (resourceAttrs.error) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const sp of (ss.spans ?? []) as OTLPSpan[]) {
          result.rejectedSpans.push({
            traceId: String(sp.traceId ?? ""),
            spanId: String(sp.spanId ?? ""),
            error: resourceAttrs.error,
          });
        }
      }
      continue;
    }
    const serviceName = typeof resourceAttrs.map["service.name"] === "string"
      ? (resourceAttrs.map["service.name"] as string)
      : "";

    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of (ss.spans ?? []) as OTLPSpan[]) {
        const conv = validateSpan(sp);
        if (conv.error) {
          result.rejectedSpans.push({
            traceId: String(sp.traceId ?? ""),
            spanId: String(sp.spanId ?? ""),
            error: conv.error,
          });
          continue;
        }
        const traceHex = (sp.traceId as string).toLowerCase();
        const spanHex = (sp.spanId as string).toLowerCase();
        const parentHex = typeof sp.parentSpanId === "string" ? sp.parentSpanId.toLowerCase() : "";

        // Session-key precedence — see the phase-1 scan above.
        let sessionKey = strAttr(conv.attrs, "session.id", "gen_ai.conversation.id", "langfuse.session.id", "handoffgraph.session_id", "session_id");
        if (!sessionKey) sessionKey = sessionKeyByTrace.get(traceHex) ?? "";
        if (!sessionKey) sessionKey = `otlp-trace-${traceHex}`;
        // Provider detection: gen_ai.provider.name superseded gen_ai.system
        // in GenAI semconv v1.37.0 (Aug 2025); read the new key first, fall
        // back to gen_ai.system for older emitters, then the pre-GenAI
        // heuristics.
        const model = strAttr(conv.attrs, "gen_ai.request.model", "gen_ai.provider.name", "gen_ai.system", "llm.model_name", "coding_agent.model");
        const toolName = strAttr(conv.attrs, "gen_ai.tool.name", "coding_agent.tool");

        const [sessionID, traceID, spanID] = await Promise.all([
          otlpSessionID(sessionKey),
          otlpTraceID(traceHex),
          otlpSpanID(traceHex, spanHex, nsToMS(conv.startNS)),
        ]);
        const startEvtID = await otlpEventID(`span-start|${traceHex}|${spanHex}`, nsToMS(conv.startNS));
        const endEvtID = await otlpEventID(`span-end|${traceHex}|${spanHex}`, nsToMS(conv.endNS));

        let tr = traces.get(traceHex);
        if (!tr) {
          tr = { sessionKey, minStartNS: conv.startNS, maxEndNS: conv.endNS, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hasUsage: false };
          traces.set(traceHex, tr);
        }
        tr.minStartNS = minNS(tr.minStartNS, conv.startNS);
        tr.maxEndNS = maxNS(tr.maxEndNS, conv.endNS);
        const usage = intAttr(conv.attrs, "gen_ai.usage.input_tokens", "llm.token_count.prompt");
        if (usage !== null) { tr.tokens.input += usage; tr.hasUsage = true; }
        const outTok = intAttr(conv.attrs, "gen_ai.usage.output_tokens", "llm.token_count.completion");
        if (outTok !== null) { tr.tokens.output += outTok; tr.hasUsage = true; }
        const cacheRead = intAttr(conv.attrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_tokens");
        if (cacheRead !== null) { tr.tokens.cacheRead += cacheRead; tr.hasUsage = true; }
        const cacheWrite = intAttr(conv.attrs, "gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_write_tokens");
        if (cacheWrite !== null) { tr.tokens.cacheWrite += cacheWrite; tr.hasUsage = true; }

        let ses = sessions.get(sessionKey);
        if (!ses) { ses = { minStartNS: conv.startNS, agent: serviceName }; sessions.set(sessionKey, ses); }
        ses.minStartNS = minNS(ses.minStartNS, conv.startNS);
        if (!ses.agent) ses.agent = serviceName;

        // span.started
        const startPayload: Record<string, unknown> = {
          span_id: spanID,
          span_kind: mapKind(sp.kind, typeof sp.name === "string" ? sp.name : "", conv.attrs),
          name: sp.name,
          trace_id: traceID,
          source_kind: kindName(sp.kind),
          source_span_id: spanHex,
        };
        let parents: string[] | undefined;
        if (parentHex) {
          startPayload["parent_span_source_id"] = parentHex;
          const parentStart = startNSByKey.get(`${traceHex}|${parentHex}`);
          if (parentStart !== undefined) {
            parents = [await otlpEventID(`span-start|${traceHex}|${parentHex}`, nsToMS(parentStart))];
          }
        }
        if (toolName) startPayload["tool_name"] = toolName;
        emit(startEvtID, conv.startNS, sessionID, sessionKey, "span.started", startPayload, { model, agent: serviceName, parents });

        // span.completed / span.failed
        const tiered = applyTier(conv.attrs, opts.captureTier);
        const endPayload: Record<string, unknown> = { span_id: spanID, trace_id: traceID };
        if (tiered.dropped > 0) {
          endPayload["capture_dropped_keys"] = tiered.dropped;
          endPayload["capture_tier"] = opts.captureTier;
        }
        if (tiered.manifest) endPayload["attribute_keys"] = tiered.manifest;
        // Attributes ride on FAILED spans as well as completed ones — failure
        // is when the evidence matters most, and internal/otlp/convert.go
        // attaches them to both arms alike. Assigning inside the else branch
        // silently dropped every attribute of every errored span.
        if (Object.keys(tiered.attrs).length > 0) endPayload["attributes"] = tiered.attrs;
        const isError = statusIsError(sp.status);
        if (isError) {
          endPayload["error"] = statusMessage(sp.status);
          emit(endEvtID, conv.endNS, sessionID, sessionKey, "span.failed", endPayload, { model, agent: serviceName });
        } else {
          emit(endEvtID, conv.endNS, sessionID, sessionKey, "span.completed", endPayload, { model, agent: serviceName });
        }
      }
    }
  }

  // trace.started / trace.completed / session.started (sorted keys).
  const traceKeys = [...traces.keys()].sort();
  for (const k of traceKeys) {
    const tr = traces.get(k)!;
    const [traceID, sessionID] = await Promise.all([otlpTraceID(k), otlpSessionID(tr.sessionKey)]);
    emit(await otlpEventID(`trace-start|${k}`, nsToMS(tr.minStartNS)), tr.minStartNS, sessionID, tr.sessionKey, "trace.started", { trace_id: traceID }, {});
    const completed: Record<string, unknown> = { trace_id: traceID };
    if (tr.hasUsage) {
      if (tr.tokens.input > 0) completed["token_input"] = tr.tokens.input;
      if (tr.tokens.output > 0) completed["token_output"] = tr.tokens.output;
      if (tr.tokens.cacheRead > 0) completed["token_cache_read"] = tr.tokens.cacheRead;
      if (tr.tokens.cacheWrite > 0) completed["token_cache_write"] = tr.tokens.cacheWrite;
    }
    emit(await otlpEventID(`trace-end|${k}`, nsToMS(tr.maxEndNS)), tr.maxEndNS, sessionID, tr.sessionKey, "trace.completed", completed, {});
  }
  const sessionKeys = [...sessions.keys()].sort();
  for (const k of sessionKeys) {
    const ses = sessions.get(k)!;
    emit(
      await otlpEventID(`session-start|${k}`, nsToMS(ses.minStartNS)),
      ses.minStartNS,
      await otlpSessionID(k),
      k,
      "session.started",
      { service: ses.agent },
      { agent: ses.agent },
    );
  }

  // Deterministic total order: (occurred_at, class, event_id).
  const rank: Record<string, number> = {
    "session.started": 0,
    "trace.started": 1,
    "span.started": 2,
    "span.completed": 3,
    "span.failed": 3,
    "trace.completed": 4,
  };
  result.events.sort((a, b) => {
    const an = Date.parse(a["occurred_at"] as string);
    const bn = Date.parse(b["occurred_at"] as string);
    if (an !== bn) return an - bn;
    const ar = rank[a["kind"] as string] ?? 9;
    const br = rank[b["kind"] as string] ?? 9;
    if (ar !== br) return ar - br;
    return (a["event_id"] as string) < (b["event_id"] as string) ? -1 : 1;
  });
  return result;
}

// ---- validation helpers ----------------------------------------------------

function isHex(s: string, n: number): boolean {
  if (s.length !== n) return false;
  return /^[0-9a-f]+$/i.test(s);
}

/** Nanosecond epochs exceed JS safe integers; parse as bigint. */
function parseNano(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  if (!/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

const nsToMS = (ns: bigint): number => Number(ns / 1_000_000n);
const isoFromNS = (ns: bigint): string => new Date(nsToMS(ns)).toISOString();
const minNS = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxNS = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * Reads a string attribute out of the RAW proto3-JSON KeyValue list during the
 * phase-1 scan, honouring KEY precedence rather than emit order: the keys are
 * the outer loop and the attribute list the inner one, so the caller's ranking
 * decides — exactly as strAttr does over a sanitized map. Scanning attributes
 * first would let a span carrying BOTH session.id and gen_ai.conversation.id
 * resolve to whichever the SDK happened to append first, splitting one logical
 * trace across two derived session ids.
 *
 * The candidate is validated the way the per-span sanitizer would. This scan
 * feeds a TRACE-WIDE session key, so a span that phase 2 will reject for an
 * unusable session.id must not donate that string to its accepted siblings'
 * native_session_id. Mirrors internal/otlp/convert.go's rawStrAttr exactly.
 */
function rawStrAttr(kvs: unknown, ...keys: string[]): string {
  if (!Array.isArray(kvs)) return "";
  for (const key of keys) {
    for (const kv of kvs as KV[]) {
      if (!kv || typeof kv !== "object" || kv.key !== key) continue;
      const v = decodeAnyValue(kv.value);
      // Anything the sanitizer would refuse (not a string at all, an
      // undecodable protobuf blob, past the size cap) is skipped, not promoted.
      if (typeof v !== "string" || v === "") continue;
      if (utf8Bytes(v) > MAX_ATTR_STRING_BYTES) continue;
      return v;
    }
  }
  return "";
}

/**
 * Decode one proto3-JSON ArrayValue body.
 *
 * The OTLP proto names ArrayValue's repeated field `values`, so a spec-correct
 * emitter (and src/otlp_proto.ts, which bridges protobuf into these same
 * shapes) writes {arrayValue: {values: [...]}}. Historic HandoffGraph builds
 * read `elements` instead, and some emitters copied that, so both spellings
 * are accepted and `values` wins when a payload carries both. A bare array
 * body ({arrayValue: [...]}) is the third accepted legacy shape.
 *
 * Elements are AnyValue wrappers themselves, so each one recurses.
 */
function decodeArrayValue(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body.map(decodeAnyValue);
  if (body === null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  // An ArrayValue message with no members is an empty array, matching what
  // the Go decoder produces for the same bytes — never an undecoded wrapper.
  const items = Array.isArray(o["values"])
    ? o["values"]
    : Array.isArray(o["elements"])
      ? o["elements"]
      : [];
  return items.map(decodeAnyValue);
}

/**
 * Decode one proto3-JSON KeyValueList body ({kvlistValue: {values: [...]}}).
 *
 * Go builds a plain map here and lets the sanitizer drop reserved keys; this
 * port drops them in the decoder instead, because assigning `__proto__` onto a
 * `{}` literal would mutate its prototype rather than store an entry — the
 * exact pollution the reserved list exists to prevent. Net result is Go's.
 */
function decodeKvlistValue(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object") return null;
  const values = (body as Record<string, unknown>)["values"];
  const out: Record<string, unknown> = {};
  // A KeyValueList message with no members is an empty object, matching what
  // the Go decoder produces for the same bytes — never an undecoded wrapper.
  if (values === undefined) return out;
  if (!Array.isArray(values)) return null;
  for (const pair of values as KV[]) {
    if (!pair || typeof pair !== "object") continue;
    const key = pair.key;
    if (isOtlpUndecodable(key)) return null; // judged per span by the sanitizer
    if (typeof key !== "string" || RESERVED_ATTR_KEYS.has(key)) continue;
    out[key] = decodeAnyValue(pair.value);
  }
  return out;
}

/**
 * proto3 JSON renders int64 as a decimal string (bare numbers are accepted
 * too, since hand-written exporters emit them).
 *
 * Go parses it with strconv.ParseInt into an exact int64, so this parses with
 * BigInt rather than Number(), which silently rounds anything past 2^53.
 * A value inside the IEEE-754 safe range becomes the same JSON number Go
 * writes; beyond it the exact decimal digits are kept as a string, because the
 * spine's JSON transport cannot carry such an integer as a number without
 * corrupting it — lossless and visibly different beats silently wrong. Out of
 * int64 range rejects the span, exactly as ParseInt's failure does in Go.
 */
function decodeIntValue(raw: string | number): unknown {
  if (typeof raw === "number") return raw;
  if (!/^[+-]?\d+$/.test(raw)) {
    return new OtlpUndecodable(`intValue ${JSON.stringify(raw)} is not a decimal integer`);
  }
  const n = BigInt(raw);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) {
    return new OtlpUndecodable(`intValue ${raw} is out of int64 range`);
  }
  const asNumber = Number(n);
  return Number.isSafeInteger(asNumber) ? asNumber : n.toString();
}

function decodeAnyValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (isOtlpUndecodable(v)) return v;
  const o = v as Record<string, unknown>;
  const only = Object.keys(o).length === 1;
  if (only && (typeof o["stringValue"] === "string" || isOtlpUndecodable(o["stringValue"]))) {
    return o["stringValue"];
  }
  if (only && typeof o["boolValue"] === "boolean") return o["boolValue"];
  if (only && (typeof o["intValue"] === "string" || typeof o["intValue"] === "number")) {
    return decodeIntValue(o["intValue"] as string | number);
  }
  if (only && typeof o["doubleValue"] === "number") return o["doubleValue"];
  if (only && typeof o["bytesValue"] === "string") {
    // Binary attributes are preserved as hex fingerprints, never raw and never
    // as the base64 the wire carries — Go's hex.EncodeToString of the decoded
    // bytes. Base64 that does not decode rejects the span, as it does in Go.
    const hex = base64ToHex(o["bytesValue"] as string);
    return hex === null ? new OtlpUndecodable("bytesValue is not valid base64") : hex;
  }
  if ("arrayValue" in o) {
    const decoded = decodeArrayValue(o["arrayValue"]);
    if (decoded !== null) return decoded;
  }
  if ("kvlistValue" in o) {
    const decoded = decodeKvlistValue(o["kvlistValue"]);
    if (decoded !== null) return decoded;
  }
  return v;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map<string, number>(
  [...B64_ALPHABET].map((character, index) => [character, index]),
);
const HEX_DIGITS = "0123456789abcdef";

/**
 * Standard (padded) base64 to lowercase hex, the two representations Go moves
 * between for a bytes attribute: base64.StdEncoding.DecodeString on the way in,
 * hex.EncodeToString on the way out. Returns null for anything Go's strict
 * standard decoder would reject, so the span fails closed instead of storing a
 * guess.
 */
function base64ToHex(input: string): string | null {
  // Go's decoder ignores line breaks in the encoded form; nothing else.
  const encoded = input.replace(/[\r\n]/g, "");
  if (encoded.length % 4 !== 0) return null;
  let hex = "";
  for (let i = 0; i < encoded.length; i += 4) {
    const sextets = [0, 0, 0, 0];
    let padding = 0;
    for (let j = 0; j < 4; j++) {
      const character = encoded[i + j];
      if (character === "=") {
        // Padding is legal only as the last one or two characters of the
        // final quantum.
        if (i + 4 !== encoded.length || j < 2) return null;
        padding++;
        continue;
      }
      if (padding > 0) return null; // data may not follow padding
      const value = B64_INDEX.get(character);
      if (value === undefined) return null;
      sextets[j] = value;
    }
    const quantum = (sextets[0] << 18) | (sextets[1] << 12) | (sextets[2] << 6) | sextets[3];
    const bytes = [(quantum >> 16) & 255, (quantum >> 8) & 255, quantum & 255];
    for (let b = 0; b < 3 - padding; b++) {
      hex += HEX_DIGITS[bytes[b] >> 4] + HEX_DIGITS[bytes[b] & 15];
    }
  }
  return hex;
}

function sanitizeKV(kvs: unknown, depth: number): { map: Record<string, unknown>; error: string | null; dropped: number } {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(kvs)) return { map: out, error: null, dropped: 0 };
  if (depth > MAX_ATTR_DEPTH) return { map: out, error: `attribute nesting exceeds ${MAX_ATTR_DEPTH} levels`, dropped: 0 };
  for (const kv of kvs as KV[]) {
    if (!kv || typeof kv !== "object") continue;
    // A key the protobuf decoder could not represent rejects the SPAN, exactly
    // as Go's utf8.ValidString check over the raw key bytes does.
    if (isOtlpUndecodable(kv.key)) return { map: out, error: kv.key.reason, dropped: 0 };
    if (typeof kv.key !== "string") continue;
    if (RESERVED_ATTR_KEYS.has(kv.key)) continue;
    if (kv.key === "" || /[\u0000\n\r]/.test(kv.key)) {
      return { map: out, error: `invalid attribute key ${JSON.stringify(kv.key)}`, dropped: 0 };
    }
    const v = sanitizeValue(decodeAnyValue(kv.value), depth);
    if (v.error) return { map: out, error: v.error, dropped: 0 };
    out[kv.key] = v.value;
  }
  return { map: out, error: null, dropped: 0 };
}

function sanitizeValue(v: unknown, depth: number): { value: unknown; error: string | null } {
  // Fail-closed, per span: a value the wire decoder could not represent
  // (invalid UTF-8 bytes, undecodable base64, an out-of-range int64) is
  // reported, never rewritten into something storable.
  if (isOtlpUndecodable(v)) return { value: null, error: v.reason };
  if (v === null || typeof v === "boolean" || typeof v === "number") return { value: v, error: null };
  if (typeof v === "string") {
    if (utf8Bytes(v) > MAX_ATTR_STRING_BYTES) {
      return { value: null, error: `attribute string exceeds ${MAX_ATTR_STRING_BYTES} bytes` };
    }
    return { value: v, error: null };
  }
  if (Array.isArray(v)) {
    if (depth + 1 > MAX_ATTR_DEPTH) return { value: null, error: `attribute nesting exceeds ${MAX_ATTR_DEPTH} levels` };
    const out: unknown[] = [];
    for (const e of v) {
      const s = sanitizeValue(e, depth + 1);
      if (s.error) return { value: null, error: s.error };
      out.push(s.value);
    }
    return { value: out, error: null };
  }
  if (typeof v === "object") {
    if (depth + 1 > MAX_ATTR_DEPTH) return { value: null, error: `attribute nesting exceeds ${MAX_ATTR_DEPTH} levels` };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (RESERVED_ATTR_KEYS.has(k)) continue;
      const s = sanitizeValue(val, depth + 1);
      if (s.error) return { value: null, error: s.error };
      out[k] = s.value;
    }
    return { value: out, error: null };
  }
  return { value: null, error: "unsupported attribute value" };
}

function applyTier(
  attrs: Record<string, unknown>,
  tier: CaptureTier,
): { attrs: Record<string, unknown>; dropped: number; manifest: string[] | null } {
  if (tier === "full" || Object.keys(attrs).length === 0) return { attrs, dropped: 0, manifest: null };
  if (tier === "minimal") {
    return { attrs: {}, dropped: Object.keys(attrs).length, manifest: Object.keys(attrs).sort() };
  }
  const out: Record<string, unknown> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (BODY_ATTR_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) {
      dropped++;
      continue;
    }
    out[k] = v;
  }
  return { attrs: out, dropped, manifest: null };
}

function statusIsError(status: { code?: unknown } | null | undefined): boolean {
  if (!status) return false;
  const code = status.code;
  return code === 2 || code === "2" || code === "STATUS_CODE_ERROR" || code === "ERROR";
}

function statusMessage(status: { message?: unknown } | null | undefined): string {
  return typeof status?.message === "string" && status.message !== "" ? status.message : "error";
}

function kindName(raw: unknown): string {
  switch (raw) {
    case 1: return "SPAN_KIND_INTERNAL";
    case 2: return "SPAN_KIND_SERVER";
    case 3: return "SPAN_KIND_CLIENT";
    case 4: return "SPAN_KIND_PRODUCER";
    case 5: return "SPAN_KIND_CONSUMER";
    case "1": return "SPAN_KIND_INTERNAL";
    case "2": return "SPAN_KIND_SERVER";
    case "3": return "SPAN_KIND_CLIENT";
    case "4": return "SPAN_KIND_PRODUCER";
    case "5": return "SPAN_KIND_CONSUMER";
    default: return "SPAN_KIND_UNSPECIFIED";
  }
}

// mapKind maps OTLP kind + conventions onto the normalized SpanKind. The
// raw OTLP kind is preserved separately (payload source_kind). GenAI CLIENT
// spans are model calls; OpenInference's 10-kind enum wins when present
// (EVALUATOR -> GUARDRAIL, PROMPT -> WORKFLOW — documented below); tool
// spans are recognized from gen_ai.tool.name / execute_tool naming /
// coding_agent.tool. Mirrors internal/otlp/convert.go's mapKind exactly.
function mapKind(rawKind: unknown, name: string, attrs: Record<string, unknown>): string {
  const oi = strAttr(attrs, "openinference.span.kind");
  // hasGenAI: gen_ai.provider.name (semconv v1.37.0, Aug 2025) is checked
  // ahead of the legacy gen_ai.system attribute — same precedence as the
  // model resolution above.
  const hasGenAI = strAttr(attrs, "gen_ai.operation.name", "gen_ai.request.model", "gen_ai.provider.name", "gen_ai.system") !== "";
  const isTool =
    strAttr(attrs, "gen_ai.tool.name", "coding_agent.tool") !== "" || name.startsWith("execute_tool ");
  if (oi === "LLM" || oi === "EMBEDDING") return "MODEL";
  if (oi === "AGENT") return "AGENT";
  if (oi === "TOOL") return "TOOL";
  if (oi === "RETRIEVER" || oi === "RERANKER") return "RETRIEVAL";
  // EVALUATOR renders a pass/fail or scored verdict over content — the same
  // quality-gate semantics as GUARDRAIL, so both fold onto our GUARDRAIL kind.
  if (oi === "GUARDRAIL" || oi === "EVALUATOR") return "GUARDRAIL";
  // PROMPT assembles/renders a prompt template — a workflow step, not a
  // model call — so it folds onto WORKFLOW alongside CHAIN.
  if (oi === "CHAIN" || oi === "PROMPT") return "WORKFLOW";
  if (isTool) return "TOOL";
  if (hasGenAI && kindName(rawKind) === "SPAN_KIND_CLIENT") return "MODEL";
  if (name.startsWith("coding_agent.") || strAttr(attrs, "coding_agent.session") !== "") return "AGENT";
  return kindName(rawKind) === "SPAN_KIND_SERVER" ? "MCP_SERVER" : "OTHER";
}

function strAttr(attrs: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function intAttr(attrs: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  }
  return null;
}

function validateSpan(sp: OTLPSpan): { attrs: Record<string, unknown>; startNS: bigint; endNS: bigint; error: string | null } {
  const fail = (error: string) => ({ attrs: {}, startNS: 0n, endNS: 0n, error });
  if (typeof sp.traceId !== "string" || !isHex(sp.traceId, 32)) return fail(`traceId must be 32 hex chars`);
  if (typeof sp.spanId !== "string" || !isHex(sp.spanId, 16)) return fail(`spanId must be 16 hex chars`);
  if (sp.parentSpanId !== undefined && sp.parentSpanId !== "" && (typeof sp.parentSpanId !== "string" || !isHex(sp.parentSpanId, 16))) {
    return fail(`parentSpanId must be 16 hex chars`);
  }
  const startNS = parseNano(sp.startTimeUnixNano);
  if (startNS === null) return fail(`startTimeUnixNano must be a decimal string`);
  const endNS = parseNano(sp.endTimeUnixNano);
  if (endNS === null) return fail(`endTimeUnixNano must be a decimal string`);
  if (endNS < startNS) return fail(`endTimeUnixNano precedes startTimeUnixNano`);
  // A span name the protobuf decoder could not represent rejects this span and
  // only this span — the same fail-closed, partial-success outcome as Go's
  // utf8.ValidString(sp.Name) check.
  if (isOtlpUndecodable(sp.name)) return fail(sp.name.reason);
  const sanitized = sanitizeKV(sp.attributes, 0);
  if (sanitized.error) return fail(sanitized.error);
  return { attrs: sanitized.map, startNS, endNS, error: null };
}
