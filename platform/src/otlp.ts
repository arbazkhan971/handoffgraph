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

// ---- OTLP wire types (loose; validated during conversion) -----------------

type KV = { key: string; value?: unknown };
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
        const isError = statusIsError(sp.status);
        if (isError) {
          endPayload["error"] = statusMessage(sp.status);
          emit(endEvtID, conv.endNS, sessionID, sessionKey, "span.failed", endPayload, { model, agent: serviceName });
        } else {
          if (Object.keys(tiered.attrs).length > 0) endPayload["attributes"] = tiered.attrs;
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

function rawStrAttr(kvs: unknown, ...keys: string[]): string {
  if (!Array.isArray(kvs)) return "";
  for (const kv of kvs as KV[]) {
    if (kv && typeof kv === "object" && typeof kv.key === "string" && keys.includes(kv.key)) {
      const v = decodeAnyValue(kv.value);
      if (typeof v === "string" && v !== "") return v;
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

function decodeAnyValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o["stringValue"] === "string" && Object.keys(o).length === 1) return o["stringValue"];
  if (typeof o["boolValue"] === "boolean" && Object.keys(o).length === 1) return o["boolValue"];
  if ((typeof o["intValue"] === "string" || typeof o["intValue"] === "number") && Object.keys(o).length === 1) {
    return typeof o["intValue"] === "string" ? Number(o["intValue"]) : o["intValue"];
  }
  if (typeof o["doubleValue"] === "number" && Object.keys(o).length === 1) return o["doubleValue"];
  if ("arrayValue" in o) {
    const decoded = decodeArrayValue(o["arrayValue"]);
    if (decoded !== null) return decoded;
  }
  return v;
}

function sanitizeKV(kvs: unknown, depth: number): { map: Record<string, unknown>; error: string | null; dropped: number } {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(kvs)) return { map: out, error: null, dropped: 0 };
  if (depth > MAX_ATTR_DEPTH) return { map: out, error: `attribute nesting exceeds ${MAX_ATTR_DEPTH} levels`, dropped: 0 };
  for (const kv of kvs as KV[]) {
    if (!kv || typeof kv !== "object" || typeof kv.key !== "string") continue;
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
  const sanitized = sanitizeKV(sp.attributes, 0);
  if (sanitized.error) return fail(sanitized.error);
  return { attrs: sanitized.map, startNS, endNS, error: null };
}
