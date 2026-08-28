/**
 * OTLP/protobuf ingest for the hosted Worker (parity row 2, protobuf flavor).
 *
 * This is a faithful TypeScript port of internal/otlp/protowire.go +
 * internal/otlp/proto.go: a deliberately small, dependency-free protobuf wire
 * codec plus the ExportTraceServiceRequest decoder built on top of it.
 *
 * The whole design is that this module produces the SAME JSON-oriented shapes
 * `src/otlp.ts` already consumes, so conversion, sanitization, capture tiers
 * and every derived identifier live in `convertOtlpExport` and are reached by
 * both wire flavors unchanged. The same telemetry sent as JSON or protobuf
 * therefore yields byte-identical event ids — proved end to end by
 * test/otlp_proto.test.ts, which decodes the Go-authored golden fixture
 * testdata/fixtures/otlp/genai_session.pb and compares against
 * genai_session.json through the one converter.
 *
 * Bridging notes (protobuf -> the JSON-oriented shapes):
 *
 *   - trace_id/span_id/parent_span_id bytes become lowercase hex, the form
 *     the converter's per-span hex check already normalizes.
 *   - fixed64 timestamps become decimal STRINGS via BigInt. Never Number:
 *     nanosecond epochs (1.75e18) are far past Number.MAX_SAFE_INTEGER, so a
 *     numeric hop would silently move spans in time.
 *   - kind and status.code become plain numbers, the enum-number form
 *     kindName()/statusIsError() already accept from proto3 JSON.
 *   - AnyValue lands in exactly the proto3-JSON wrapper the JSON flavor
 *     carries ({stringValue}, {intValue: "<decimal>"}, {bytesValue: "<b64>"},
 *     {arrayValue: {values}}, {kvlistValue: {values}}). Emitting the wrapper
 *     rather than a pre-resolved JS value is what makes the two flavors
 *     identical BY CONSTRUCTION: the decoded request is the same object graph
 *     JSON.parse() would have produced, so whatever the converter's attribute
 *     mapping does, it does to both flavors alike. In particular bytes match
 *     the JSON path exactly, which carries base64 under `bytesValue`.
 *
 * Everything here is fail-closed: a truncated buffer, an overlong varint, a
 * group-encoded field, a wire type that does not match the schema, or nesting
 * past 32 levels is an error, never a best-effort partial value. Per-span
 * judgement (bad ids, bad times, unusable attribute strings) is deferred to
 * the converter so protobuf batches report rejected spans through the same
 * partial-success path as JSON batches.
 *
 * The one place protobuf cannot mirror JSON by construction is text: the wire
 * carries raw BYTES for span names, attribute keys and string values, and a JS
 * string cannot hold a sequence that is not valid UTF-8. Decoding those
 * leniently would rewrite them to U+FFFD and ACCEPT telemetry the Go path
 * rejects, so every string here is decoded STRICTLY; a per-span field that
 * fails becomes an `OtlpUndecodable` the converter turns into one rejected
 * span, and a structural field that fails rejects the request.
 */

import { MAX_BODY_BYTES } from "./ingest";
import { OtlpUndecodable } from "./otlp";

/**
 * Bounds nested-message recursion while decoding. OTLP's deepest legitimate
 * shape is request -> ResourceSpans -> ScopeSpans -> Span -> KeyValue ->
 * AnyValue -> KeyValueList -> KeyValue -> ...; 32 leaves generous room for
 * nested attribute trees (the converter caps those at 10) while making a
 * hostile self-nesting payload fail closed instead of exhausting the stack.
 */
const MAX_PROTO_DEPTH = 32;

/** The largest legal protobuf field number (2^29-1). */
const MAX_PROTO_FIELD_NUMBER = 536870911n;

// Protobuf wire types.
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_FIXED32 = 5;

/** Every decode failure raised by this module; nothing else escapes. */
export class OtlpProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpProtoError";
  }
}

const truncated = () => new OtlpProtoError("protobuf: truncated message");
const overflow = () => new OtlpProtoError("protobuf: varint overflows 64 bits");
const groups = () => new OtlpProtoError("protobuf: group wire types are not supported");
const tooDeep = () =>
  new OtlpProtoError(`protobuf: message nesting exceeds ${MAX_PROTO_DEPTH} levels`);

// -- wire codec ---------------------------------------------------------------

/**
 * One decoded field: its number, its wire type, and its payload.
 * Length-delimited payloads are subarray views over the input buffer (the
 * decoder never mutates its input and copies anything it retains).
 */
type ProtoField = {
  num: number;
  typ: number;
  /** varint / fixed64 / fixed32 payload, always exact (BigInt, never Number). */
  num64: bigint;
  /** length-delimited payload. */
  data: Uint8Array;
};

const EMPTY = new Uint8Array(0);

/** Walks a protobuf message buffer field by field with strict bounds. */
class ProtoReader {
  private readonly buf: Uint8Array;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Reads one field header plus its payload. */
  next(): ProtoField {
    const tag = this.readVarint();
    const num = tag >> 3n;
    const typ = Number(tag & 7n);
    if (num === 0n || num > MAX_PROTO_FIELD_NUMBER) {
      throw new OtlpProtoError(`protobuf: illegal field number: ${num}`);
    }
    switch (typ) {
      case WIRE_VARINT:
        return { num: Number(num), typ, num64: this.readVarint(), data: EMPTY };
      case WIRE_FIXED64:
        return { num: Number(num), typ, num64: this.readFixed(8), data: EMPTY };
      case WIRE_FIXED32:
        return { num: Number(num), typ, num64: this.readFixed(4), data: EMPTY };
      case WIRE_BYTES:
        return { num: Number(num), typ, num64: 0n, data: this.readLenDelim() };
      case WIRE_START_GROUP:
      case WIRE_END_GROUP:
        // Groups are proto2-only and removed from proto3; OTLP never uses
        // them. Skipping one correctly needs a second parser, so refuse.
        throw groups();
      default:
        throw new OtlpProtoError(`protobuf: unknown wire type ${typ} for field ${num}`);
    }
  }

  /** Decodes a base-128 varint with strict overflow bounds. */
  private readVarint(): bigint {
    let v = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw truncated();
      const b = this.buf[this.pos];
      this.pos++;
      // The 10th byte contributes only bit 63.
      if (i === 9 && b > 1) throw overflow();
      v |= BigInt(b & 0x7f) << BigInt(7 * i);
      if (b < 0x80) return v;
    }
    throw overflow();
  }

  /** Reads n little-endian bytes (n is 4 or 8). */
  private readFixed(n: number): bigint {
    if (this.buf.length - this.pos < n) throw truncated();
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += n;
    return v;
  }

  /** Reads a length-prefixed payload, bounded by what is left. */
  private readLenDelim(): Uint8Array {
    const n = this.readVarint();
    if (n > BigInt(this.buf.length - this.pos)) throw truncated();
    const len = Number(n);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

/**
 * Iterates every field of one message buffer. Fields the callback does not
 * recognize are simply skipped, which is how protobuf forward compatibility
 * works: a newer OTLP emitter may add fields and this decoder must ignore
 * them rather than reject the batch.
 */
function forEachField(buf: Uint8Array, fn: (field: ProtoField) => void): void {
  const reader = new ProtoReader(buf);
  while (!reader.done()) fn(reader.next());
}

// -- typed field accessors (schema/wire-type mismatch is an error) ------------

function fieldVarint(f: ProtoField, where: string): bigint {
  if (f.typ !== WIRE_VARINT) {
    throw new OtlpProtoError(`protobuf: ${where}: expected varint, got wire type ${f.typ}`);
  }
  return f.num64;
}

function fieldFixed64(f: ProtoField, where: string): bigint {
  if (f.typ !== WIRE_FIXED64) {
    throw new OtlpProtoError(`protobuf: ${where}: expected fixed64, got wire type ${f.typ}`);
  }
  return f.num64;
}

function fieldBytes(f: ProtoField, where: string): Uint8Array {
  if (f.typ !== WIRE_BYTES) {
    throw new OtlpProtoError(
      `protobuf: ${where}: expected length-delimited, got wire type ${f.typ}`,
    );
  }
  return f.data;
}

/**
 * A varint payload bounded to uint32, the wire type of every `dropped_*_count`
 * field in OTLP.
 */
function fieldCount(f: ProtoField, where: string): number {
  const v = fieldVarint(f, where);
  if (v > 2147483647n) {
    throw new OtlpProtoError(`protobuf: ${where}: count ${v} out of range`);
  }
  return Number(v);
}

// One strict decoder for every string on the wire: a lenient decode would
// rewrite bad bytes to U+FFFD and accept telemetry the Go path rejects. What
// differs between the two helpers below is only the blast radius of a failure
// — the whole request, or the one span the string belongs to. ignoreBOM keeps
// a leading U+FEFF instead of silently eating it.
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A string field that reaches the payload WITHOUT passing through the
 * per-span attribute sanitizer (scope name/version, schema urls, trace state,
 * status message). Invalid UTF-8 rejects the whole request here rather than
 * being silently rewritten to U+FFFD, mirroring internal/otlp
 * decodeStructuralString.
 */
function fieldStructuralString(f: ProtoField, where: string): string {
  const bytes = fieldBytes(f, where);
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    throw new OtlpProtoError(`protobuf: ${where} is not valid UTF-8`);
  }
}

/**
 * A string field the per-SPAN sanitizer judges (span/event names, attribute
 * keys, AnyValue.string_value).
 *
 * Go keeps the raw bytes in a Go string here and lets `utf8String` /
 * `validateSpan` reject that one span fail-closed while its siblings still
 * convert. A JS string cannot hold those bytes, and decoding them leniently
 * would rewrite them to U+FFFD and ACCEPT telemetry Go refuses — a fail-open
 * divergence. So an invalid sequence becomes an {@link OtlpUndecodable}
 * carrying the message Go reports, which the converter turns into the same
 * single rejected span (never a request-level throw: one hostile span must
 * not take the batch down with it).
 *
 * `reason` is the Go-side message for this field so the two implementations
 * report the same rejection.
 */
function fieldString(f: ProtoField, where: string, reason: string): string | OtlpUndecodable {
  const bytes = fieldBytes(f, where);
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return new OtlpUndecodable(reason);
  }
}

// -- OTLP field numbers (the public schema) -----------------------------------

const F_EXPORT_REQUEST_RESOURCE_SPANS = 1;

const F_RESOURCE_SPANS_RESOURCE = 1;
const F_RESOURCE_SPANS_SCOPE_SPANS = 2;
const F_RESOURCE_SPANS_SCHEMA_URL = 3;

const F_SCOPE_SPANS_SCOPE = 1;
const F_SCOPE_SPANS_SPANS = 2;
const F_SCOPE_SPANS_SCHEMA_URL = 3;

const F_SPAN_TRACE_ID = 1;
const F_SPAN_SPAN_ID = 2;
const F_SPAN_TRACE_STATE = 3;
const F_SPAN_PARENT_SPAN_ID = 4;
const F_SPAN_NAME = 5;
const F_SPAN_KIND = 6;
const F_SPAN_START_TIME = 7;
const F_SPAN_END_TIME = 8;
const F_SPAN_ATTRIBUTES = 9;
const F_SPAN_DROPPED_ATTRS = 10;
const F_SPAN_EVENTS = 11;
const F_SPAN_LINKS = 13;
const F_SPAN_STATUS = 15;

const F_SPAN_EVENT_TIME = 1;
const F_SPAN_EVENT_NAME = 2;
const F_SPAN_EVENT_ATTRIBUTES = 3;

const F_STATUS_MESSAGE = 2;
const F_STATUS_CODE = 3;

const F_RESOURCE_ATTRIBUTES = 1;
const F_RESOURCE_DROPPED_ATTRS = 2;

const F_SCOPE_NAME = 1;
const F_SCOPE_VERSION = 2;

const F_KEY_VALUE_KEY = 1;
const F_KEY_VALUE_VALUE = 2;

const F_ANY_VALUE_STRING = 1;
const F_ANY_VALUE_BOOL = 2;
const F_ANY_VALUE_INT = 3;
const F_ANY_VALUE_DOUBLE = 4;
const F_ANY_VALUE_ARRAY = 5;
const F_ANY_VALUE_KVLIST = 6;
const F_ANY_VALUE_BYTES = 7;

const F_ARRAY_VALUE_VALUES = 1;
const F_KEY_VALUE_LIST_VALUES = 1;

// -- decoded shapes (identical to the OTLP/JSON body the converter reads) -----

/**
 * The proto3-JSON AnyValue oneof; `{}` is the unset oneof.
 *
 * The string arms widen to {@link OtlpUndecodable} because protobuf carries
 * raw bytes where JSON carries text: bytes that are not valid UTF-8 reach the
 * converter as that marker and reject their own span, rather than being
 * rewritten to U+FFFD (see {@link fieldString}).
 */
export type OtlpAnyValue =
  | { stringValue: string | OtlpUndecodable }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } }
  | Record<string, never>;

export type OtlpKeyValue = { key: string | OtlpUndecodable; value?: OtlpAnyValue };

export type OtlpSpanEvent = {
  timeUnixNano?: string;
  name?: string | OtlpUndecodable;
  attributes?: OtlpKeyValue[];
};

export type OtlpStatus = { message?: string; code?: number };

export type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceState?: string;
  name?: string | OtlpUndecodable;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  events?: OtlpSpanEvent[];
  status?: OtlpStatus;
};

export type OtlpInstrumentationScope = { name?: string; version?: string };

export type OtlpResource = { attributes?: OtlpKeyValue[]; droppedAttributesCount?: number };

export type OtlpScopeSpans = {
  scope?: OtlpInstrumentationScope;
  spans?: OtlpSpan[];
  schemaUrl?: string;
};

export type OtlpResourceSpans = {
  resource?: OtlpResource;
  scopeSpans?: OtlpScopeSpans[];
  schemaUrl?: string;
};

/** The decoded ExportTraceServiceRequest, shaped exactly like the JSON body. */
export type OtlpExportRequest = { resourceSpans: OtlpResourceSpans[] };

// -- decoder ------------------------------------------------------------------

/**
 * Decodes an OTLP/protobuf ExportTraceServiceRequest into the same body shape
 * `convertOtlpExport` consumes. Throws {@link OtlpProtoError} for anything
 * that makes the buffer unreadable; per-span judgement is the converter's.
 */
export function decodeExportRequest(data: Uint8Array): OtlpExportRequest {
  if (data.byteLength > MAX_BODY_BYTES) {
    throw new OtlpProtoError(`protobuf body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const resourceSpans: OtlpResourceSpans[] = [];
  forEachField(data, (f) => {
    if (f.num !== F_EXPORT_REQUEST_RESOURCE_SPANS) return;
    const buf = fieldBytes(f, "ExportTraceServiceRequest.resource_spans");
    resourceSpans.push(decodeResourceSpans(buf, 1));
  });
  return { resourceSpans };
}

// Assembly rule for every message below: proto3 scalars are LAST-WINS, so a
// repeated scalar field is assigned unconditionally during the walk and only
// stripped afterwards when it still holds the zero value. That reproduces
// proto3 JSON's omit-zero rendering exactly, which is what makes a decoded
// protobuf body the same object graph JSON.parse() produces for the JSON
// flavor of the same telemetry.

function decodeResourceSpans(buf: Uint8Array, depth: number): OtlpResourceSpans {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let resource: OtlpResource | undefined;
  let schemaUrl = "";
  const scopeSpans: OtlpScopeSpans[] = [];
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_RESOURCE_SPANS_RESOURCE:
        resource = decodeResource(fieldBytes(f, "ResourceSpans.resource"), depth + 1);
        break;
      case F_RESOURCE_SPANS_SCOPE_SPANS:
        scopeSpans.push(
          decodeScopeSpans(fieldBytes(f, "ResourceSpans.scope_spans"), depth + 1),
        );
        break;
      case F_RESOURCE_SPANS_SCHEMA_URL:
        schemaUrl = fieldStructuralString(f, "ResourceSpans.schema_url");
        break;
      default:
        break;
    }
  });
  const out: OtlpResourceSpans = {};
  if (resource !== undefined) out.resource = resource;
  if (scopeSpans.length > 0) out.scopeSpans = scopeSpans;
  if (schemaUrl !== "") out.schemaUrl = schemaUrl;
  return out;
}

function decodeResource(buf: Uint8Array, depth: number): OtlpResource {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let droppedAttributesCount = 0;
  const attributes: OtlpKeyValue[] = [];
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_RESOURCE_ATTRIBUTES:
        attributes.push(decodeKeyValue(fieldBytes(f, "Resource.attributes"), depth + 1));
        break;
      case F_RESOURCE_DROPPED_ATTRS:
        droppedAttributesCount = fieldCount(f, "Resource.dropped_attributes_count");
        break;
      default:
        break;
    }
  });
  const out: OtlpResource = {};
  if (attributes.length > 0) out.attributes = attributes;
  if (droppedAttributesCount !== 0) out.droppedAttributesCount = droppedAttributesCount;
  return out;
}

function decodeScopeSpans(buf: Uint8Array, depth: number): OtlpScopeSpans {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let scope: OtlpInstrumentationScope | undefined;
  let schemaUrl = "";
  const spans: OtlpSpan[] = [];
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_SCOPE_SPANS_SCOPE:
        scope = decodeScope(fieldBytes(f, "ScopeSpans.scope"), depth + 1);
        break;
      case F_SCOPE_SPANS_SPANS:
        spans.push(decodeSpan(fieldBytes(f, "ScopeSpans.spans"), depth + 1));
        break;
      case F_SCOPE_SPANS_SCHEMA_URL:
        schemaUrl = fieldStructuralString(f, "ScopeSpans.schema_url");
        break;
      default:
        break;
    }
  });
  const out: OtlpScopeSpans = {};
  if (scope !== undefined) out.scope = scope;
  if (spans.length > 0) out.spans = spans;
  if (schemaUrl !== "") out.schemaUrl = schemaUrl;
  return out;
}

/**
 * Reads InstrumentationScope. Scope attributes (field 3) and the dropped
 * count (field 4) are skipped: the shared body shape has no home for them,
 * and inventing one would diverge the two flavors.
 */
function decodeScope(buf: Uint8Array, depth: number): OtlpInstrumentationScope {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let name = "";
  let version = "";
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_SCOPE_NAME:
        name = fieldStructuralString(f, "InstrumentationScope.name");
        break;
      case F_SCOPE_VERSION:
        version = fieldStructuralString(f, "InstrumentationScope.version");
        break;
      default:
        break;
    }
  });
  const out: OtlpInstrumentationScope = {};
  if (name !== "") out.name = name;
  if (version !== "") out.version = version;
  return out;
}

function decodeSpan(buf: Uint8Array, depth: number): OtlpSpan {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let traceId = "";
  let spanId = "";
  let parentSpanId = "";
  let traceState = "";
  let name: string | OtlpUndecodable = "";
  let kind: number | undefined;
  let startTimeUnixNano: string | undefined;
  let endTimeUnixNano: string | undefined;
  let droppedAttributesCount = 0;
  let status: OtlpStatus | undefined;
  const attributes: OtlpKeyValue[] = [];
  const events: OtlpSpanEvent[] = [];
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_SPAN_TRACE_ID:
        traceId = toHex(fieldBytes(f, "Span.trace_id"));
        break;
      case F_SPAN_SPAN_ID:
        spanId = toHex(fieldBytes(f, "Span.span_id"));
        break;
      case F_SPAN_PARENT_SPAN_ID:
        parentSpanId = toHex(fieldBytes(f, "Span.parent_span_id"));
        break;
      case F_SPAN_TRACE_STATE:
        traceState = fieldStructuralString(f, "Span.trace_state");
        break;
      case F_SPAN_NAME:
        // Judged per span by the converter, fail-closed, exactly as
        // internal/otlp/convert.go's validateSpan does over the raw bytes.
        name = fieldString(f, "Span.name", "span name is not valid UTF-8");
        break;
      case F_SPAN_KIND:
        kind = Number(fieldVarint(f, "Span.kind"));
        break;
      case F_SPAN_START_TIME:
        startTimeUnixNano = fieldFixed64(f, "Span.start_time_unix_nano").toString();
        break;
      case F_SPAN_END_TIME:
        endTimeUnixNano = fieldFixed64(f, "Span.end_time_unix_nano").toString();
        break;
      case F_SPAN_ATTRIBUTES:
        attributes.push(decodeKeyValue(fieldBytes(f, "Span.attributes"), depth + 1));
        break;
      case F_SPAN_DROPPED_ATTRS:
        droppedAttributesCount = fieldCount(f, "Span.dropped_attributes_count");
        break;
      case F_SPAN_EVENTS:
        events.push(decodeSpanEvent(fieldBytes(f, "Span.events"), depth + 1));
        break;
      case F_SPAN_LINKS:
        // Links are structurally validated (they must be a well-formed
        // length-delimited message) but not retained: the JSON path has no
        // home for them either, so keeping them would diverge the flavors.
        fieldBytes(f, "Span.links");
        break;
      case F_SPAN_STATUS:
        status = decodeStatus(fieldBytes(f, "Span.status"), depth + 1);
        break;
      default:
        break;
    }
  });
  const out: OtlpSpan = {};
  if (traceId !== "") out.traceId = traceId;
  if (spanId !== "") out.spanId = spanId;
  if (parentSpanId !== "") out.parentSpanId = parentSpanId;
  if (traceState !== "") out.traceState = traceState;
  if (name !== "") out.name = name;
  if (kind !== undefined) out.kind = kind;
  if (startTimeUnixNano !== undefined) out.startTimeUnixNano = startTimeUnixNano;
  if (endTimeUnixNano !== undefined) out.endTimeUnixNano = endTimeUnixNano;
  if (attributes.length > 0) out.attributes = attributes;
  if (droppedAttributesCount !== 0) out.droppedAttributesCount = droppedAttributesCount;
  if (events.length > 0) out.events = events;
  if (status !== undefined) out.status = status;
  return out;
}

function decodeSpanEvent(buf: Uint8Array, depth: number): OtlpSpanEvent {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let timeUnixNano: string | undefined;
  let name: string | OtlpUndecodable = "";
  const attributes: OtlpKeyValue[] = [];
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_SPAN_EVENT_TIME:
        timeUnixNano = fieldFixed64(f, "Span.Event.time_unix_nano").toString();
        break;
      case F_SPAN_EVENT_NAME:
        name = fieldString(f, "Span.Event.name", "span event name is not valid UTF-8");
        break;
      case F_SPAN_EVENT_ATTRIBUTES:
        attributes.push(decodeKeyValue(fieldBytes(f, "Span.Event.attributes"), depth + 1));
        break;
      default:
        break;
    }
  });
  const out: OtlpSpanEvent = {};
  if (timeUnixNano !== undefined) out.timeUnixNano = timeUnixNano;
  if (name !== "") out.name = name;
  if (attributes.length > 0) out.attributes = attributes;
  return out;
}

function decodeStatus(buf: Uint8Array, depth: number): OtlpStatus {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let message = "";
  let code: number | undefined;
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_STATUS_MESSAGE:
        // The status message reaches the payload without passing through the
        // attribute sanitizer, so it is validated here.
        message = fieldStructuralString(f, "Status.message");
        break;
      case F_STATUS_CODE:
        code = Number(fieldVarint(f, "Status.code"));
        break;
      default:
        break;
    }
  });
  const out: OtlpStatus = {};
  if (message !== "") out.message = message;
  if (code !== undefined) out.code = code;
  return out;
}

function decodeKeyValue(buf: Uint8Array, depth: number): OtlpKeyValue {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  const out: OtlpKeyValue = { key: "" };
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_KEY_VALUE_KEY:
        // Keys are judged per span by the converter's sanitizer, matching
        // the JSON path.
        out.key = fieldString(f, "KeyValue.key", "invalid attribute key: not valid UTF-8");
        break;
      case F_KEY_VALUE_VALUE:
        out.value = decodeAnyValue(fieldBytes(f, "KeyValue.value"), depth + 1);
        break;
      default:
        break;
    }
  });
  return out;
}

/**
 * Decodes the AnyValue oneof into its proto3-JSON wrapper. Later fields win,
 * which is the protobuf rule for a oneof encoded more than once. An AnyValue
 * with nothing set decodes to `{}`, exactly what OTLP/JSON carries for it.
 */
function decodeAnyValue(buf: Uint8Array, depth: number): OtlpAnyValue {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  let out: OtlpAnyValue = {};
  forEachField(buf, (f) => {
    switch (f.num) {
      case F_ANY_VALUE_STRING:
        // Judged per span by the converter's sanitizer, the same fail-closed
        // outcome Go's utf8String produces for these bytes.
        out = {
          stringValue: fieldString(
            f,
            "AnyValue.string_value",
            "attribute string is not valid UTF-8",
          ),
        };
        break;
      case F_ANY_VALUE_BOOL:
        out = { boolValue: fieldVarint(f, "AnyValue.bool_value") !== 0n };
        break;
      case F_ANY_VALUE_INT:
        // proto3 JSON renders int64 as a signed decimal string; the wire
        // form is the two's-complement varint.
        out = {
          intValue: BigInt.asIntN(64, fieldVarint(f, "AnyValue.int_value")).toString(),
        };
        break;
      case F_ANY_VALUE_DOUBLE:
        out = { doubleValue: float64FromBits(fieldFixed64(f, "AnyValue.double_value")) };
        break;
      case F_ANY_VALUE_BYTES:
        // Base64, the representation the JSON flavor carries under this key.
        out = { bytesValue: base64Encode(fieldBytes(f, "AnyValue.bytes_value")) };
        break;
      case F_ANY_VALUE_ARRAY:
        out = {
          arrayValue: {
            values: decodeArrayValue(fieldBytes(f, "AnyValue.array_value"), depth + 1),
          },
        };
        break;
      case F_ANY_VALUE_KVLIST:
        out = {
          kvlistValue: {
            values: decodeKeyValueList(fieldBytes(f, "AnyValue.kvlist_value"), depth + 1),
          },
        };
        break;
      default:
        break;
    }
  });
  return out;
}

function decodeArrayValue(buf: Uint8Array, depth: number): OtlpAnyValue[] {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  const out: OtlpAnyValue[] = [];
  forEachField(buf, (f) => {
    if (f.num !== F_ARRAY_VALUE_VALUES) return;
    out.push(decodeAnyValue(fieldBytes(f, "ArrayValue.values"), depth + 1));
  });
  return out;
}

function decodeKeyValueList(buf: Uint8Array, depth: number): OtlpKeyValue[] {
  if (depth > MAX_PROTO_DEPTH) throw tooDeep();
  const out: OtlpKeyValue[] = [];
  forEachField(buf, (f) => {
    if (f.num !== F_KEY_VALUE_LIST_VALUES) return;
    out.push(decodeKeyValue(fieldBytes(f, "KeyValueList.values"), depth + 1));
  });
  return out;
}

// -- small pure encoders ------------------------------------------------------

const HEX = "0123456789abcdef";

/** Lowercase hex, the form the converter's per-span id check normalizes. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard (padded) base64, matching what OTLP/JSON carries for bytesValue. */
function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

const SCRATCH = new DataView(new ArrayBuffer(8));

function float64FromBits(bits: bigint): number {
  SCRATCH.setBigUint64(0, bits, true);
  return SCRATCH.getFloat64(0, true);
}

// -- ExportTraceServiceResponse ----------------------------------------------

/** The partial-success arm of ExportTraceServiceResponse. */
export type OtlpPartialSuccess = { rejectedSpans: number; errorMessage: string };

function appendVarint(out: number[], v: number): void {
  let n = v;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function appendTag(out: number[], num: number, typ: number): void {
  appendVarint(out, num * 8 + typ);
}

/**
 * Renders ExportTraceServiceResponse on the wire:
 *
 *   ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1 }
 *   ExportTracePartialSuccess  { int64 rejected_spans = 1; string error_message = 2 }
 *
 * A full success is the empty message (zero bytes), which is exactly what
 * proto3 encodes for an unset submessage — OTLP clients read that as "all
 * spans accepted".
 */
export function encodeExportTraceServiceResponse(
  partial: OtlpPartialSuccess | null,
): Uint8Array {
  if (partial === null) return new Uint8Array(0);
  const ps: number[] = [];
  if (partial.rejectedSpans !== 0) {
    appendTag(ps, 1, WIRE_VARINT);
    appendVarint(ps, partial.rejectedSpans);
  }
  if (partial.errorMessage !== "") {
    const message = new TextEncoder().encode(partial.errorMessage);
    appendTag(ps, 2, WIRE_BYTES);
    appendVarint(ps, message.length);
    for (let i = 0; i < message.length; i++) ps.push(message[i]);
  }
  const out: number[] = [];
  appendTag(out, 1, WIRE_BYTES);
  appendVarint(out, ps.length);
  return new Uint8Array(out.concat(ps));
}

// -- HTTP glue ----------------------------------------------------------------

/**
 * The OTLP/HTTP binary flavor. `application/x-protobuf` is what the spec
 * names; `application/protobuf` is accepted because some SDKs send it —
 * the same leniency internal/otlp/http.go applies.
 */
export function isProtobufMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/x-protobuf" || mediaType === "application/protobuf";
}

export type ProtobufBodyRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 };

/** Read a binary request body without ever buffering beyond the stated cap. */
export async function readProtobufBody(
  request: Request,
  maxBytes: number,
): Promise<ProtobufBodyRead> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, status: 413 };
    }
  }

  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("request body too large");
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * The protobuf answer to a protobuf export, as OTLP/HTTP requires: the
 * response flavor mirrors the request flavor. Rejected spans are reported in
 * the body (never silently dropped) using the Go message format.
 */
export function protobufExportResponse(
  rejectedSpans: readonly { spanId: string; error: string }[],
): Response {
  const body = encodeExportTraceServiceResponse(
    rejectedSpans.length === 0
      ? null
      : {
          rejectedSpans: rejectedSpans.length,
          errorMessage: rejectedSpans.map((r) => `span ${r.spanId}: ${r.error}`).join("; "),
        },
  );
  return new Response(body, {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/x-protobuf" },
  });
}
