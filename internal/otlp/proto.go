package otlp

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

// OTLP/protobuf ingest.
//
// DecodeExportRequest reads the binary
// opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest and fills
// the SAME structs the OTLP/JSON flavor produces. That is the whole design:
// conversion, sanitization, capture tiers and every derived identifier live
// in convert.go and are reached by both flavors unchanged, so the same
// telemetry sent as JSON or as protobuf yields byte-identical event ids
// (proved by TestProtoFixtureIDParityWithJSON).
//
// Field numbers below are the public OTLP schema (proto/opentelemetry/proto/
// {collector/trace,trace,common,resource}/v1). Unknown fields are skipped so
// a newer emitter never breaks ingest; a known field carrying the wrong wire
// type is an error, never a guess.
//
// Bridging notes (protobuf -> the JSON-oriented structs):
//
//   - trace_id/span_id/parent_span_id bytes become lowercase hex, the form
//     validHex/Convert already normalize (a wrong-length id therefore fails
//     the existing per-span check instead of a new one).
//   - fixed64 timestamps become decimal strings, the proto3-JSON form
//     parseNano already contracts on.
//   - kind and status.code become numeric json.RawMessage, the enum-number
//     form kindName/statusName already accept.
//   - AnyValue lands directly in the unexported AnyValue.v (in-package), so
//     the sanitizer sees exactly what the JSON decoder would have produced.

// Field numbers: ExportTraceServiceRequest.
const (
	fExportRequestResourceSpans = 1
)

// Field numbers: trace.v1.ResourceSpans / ScopeSpans / Span / Status.
const (
	fResourceSpansResource   = 1
	fResourceSpansScopeSpans = 2
	fResourceSpansSchemaURL  = 3

	fScopeSpansScope     = 1
	fScopeSpansSpans     = 2
	fScopeSpansSchemaURL = 3

	fSpanTraceID      = 1
	fSpanSpanID       = 2
	fSpanTraceState   = 3
	fSpanParentSpanID = 4
	fSpanName         = 5
	fSpanKind         = 6
	fSpanStartTime    = 7
	fSpanEndTime      = 8
	fSpanAttributes   = 9
	fSpanDroppedAttrs = 10
	fSpanEvents       = 11
	fSpanLinks        = 13
	fSpanStatus       = 15

	fSpanEventTime       = 1
	fSpanEventName       = 2
	fSpanEventAttributes = 3

	fStatusMessage = 2
	fStatusCode    = 3
)

// Field numbers: resource.v1.Resource and common.v1.*.
const (
	fResourceAttributes   = 1
	fResourceDroppedAttrs = 2

	fScopeName    = 1
	fScopeVersion = 2

	fKeyValueKey   = 1
	fKeyValueValue = 2

	fAnyValueString = 1
	fAnyValueBool   = 2
	fAnyValueInt    = 3
	fAnyValueDouble = 4
	fAnyValueArray  = 5
	fAnyValueKVList = 6
	fAnyValueBytes  = 7

	fArrayValueValues   = 1
	fKeyValueListValues = 1
)

// DecodeExportRequest decodes an OTLP/protobuf ExportTraceServiceRequest.
//
// It is fail-closed at the request level for anything that makes the buffer
// unreadable (truncation, varint overflow, groups, wire-type/schema
// mismatch) and defers per-span judgement — bad ids, bad times, unusable
// attribute strings — to Convert, so protobuf batches report rejected spans
// through the same partialSuccess path as JSON batches.
func DecodeExportRequest(data []byte) (*ExportRequest, error) {
	if len(data) > maxRequestBytes {
		return nil, fmt.Errorf("protobuf body exceeds %d bytes", maxRequestBytes)
	}
	req := &ExportRequest{}
	err := forEachField(data, func(f protoField) error {
		if f.num != fExportRequestResourceSpans {
			return nil
		}
		b, err := f.bytes("ExportTraceServiceRequest.resource_spans")
		if err != nil {
			return err
		}
		rs, err := decodeResourceSpans(b, 1)
		if err != nil {
			return err
		}
		req.ResourceSpans = append(req.ResourceSpans, rs)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return req, nil
}

func decodeResourceSpans(buf []byte, depth int) (ResourceSpans, error) {
	var out ResourceSpans
	if depth > maxProtoDepth {
		return out, errProtoDepth
	}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fResourceSpansResource:
			b, err := f.bytes("ResourceSpans.resource")
			if err != nil {
				return err
			}
			res, err := decodeResource(b, depth+1)
			if err != nil {
				return err
			}
			out.Resource = res
		case fResourceSpansScopeSpans:
			b, err := f.bytes("ResourceSpans.scope_spans")
			if err != nil {
				return err
			}
			ss, err := decodeScopeSpans(b, depth+1)
			if err != nil {
				return err
			}
			out.ScopeSpans = append(out.ScopeSpans, ss)
		case fResourceSpansSchemaURL:
			s, err := decodeStructuralString(f, "ResourceSpans.schema_url")
			if err != nil {
				return err
			}
			out.SchemaURL = s
		}
		return nil
	})
	return out, err
}

func decodeResource(buf []byte, depth int) (*Resource, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := &Resource{}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fResourceAttributes:
			b, err := f.bytes("Resource.attributes")
			if err != nil {
				return err
			}
			kv, err := decodeKeyValue(b, depth+1)
			if err != nil {
				return err
			}
			out.Attributes = append(out.Attributes, kv)
		case fResourceDroppedAttrs:
			n, err := f.uint32Field("Resource.dropped_attributes_count")
			if err != nil {
				return err
			}
			out.DroppedAttributesCount = n
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeScopeSpans(buf []byte, depth int) (ScopeSpans, error) {
	var out ScopeSpans
	if depth > maxProtoDepth {
		return out, errProtoDepth
	}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fScopeSpansScope:
			b, err := f.bytes("ScopeSpans.scope")
			if err != nil {
				return err
			}
			scope, err := decodeScope(b, depth+1)
			if err != nil {
				return err
			}
			out.Scope = scope
		case fScopeSpansSpans:
			b, err := f.bytes("ScopeSpans.spans")
			if err != nil {
				return err
			}
			sp, err := decodeSpan(b, depth+1)
			if err != nil {
				return err
			}
			out.Spans = append(out.Spans, sp)
		case fScopeSpansSchemaURL:
			s, err := decodeStructuralString(f, "ScopeSpans.schema_url")
			if err != nil {
				return err
			}
			out.SchemaURL = s
		}
		return nil
	})
	return out, err
}

// decodeScope reads InstrumentationScope. Scope attributes (field 3) and the
// dropped count (field 4) are skipped: the shared struct has no home for
// them, and inventing one would diverge the two flavors.
func decodeScope(buf []byte, depth int) (*InstrumentationScope, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := &InstrumentationScope{}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fScopeName:
			s, err := decodeStructuralString(f, "InstrumentationScope.name")
			if err != nil {
				return err
			}
			out.Name = s
		case fScopeVersion:
			s, err := decodeStructuralString(f, "InstrumentationScope.version")
			if err != nil {
				return err
			}
			out.Version = s
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeSpan(buf []byte, depth int) (Span, error) {
	var out Span
	if depth > maxProtoDepth {
		return out, errProtoDepth
	}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fSpanTraceID:
			b, err := f.bytes("Span.trace_id")
			if err != nil {
				return err
			}
			out.TraceID = hex.EncodeToString(b)
		case fSpanSpanID:
			b, err := f.bytes("Span.span_id")
			if err != nil {
				return err
			}
			out.SpanID = hex.EncodeToString(b)
		case fSpanParentSpanID:
			b, err := f.bytes("Span.parent_span_id")
			if err != nil {
				return err
			}
			out.ParentSpanID = hex.EncodeToString(b)
		case fSpanTraceState:
			s, err := decodeStructuralString(f, "Span.trace_state")
			if err != nil {
				return err
			}
			out.TraceState = s
		case fSpanName:
			// Left un-validated on purpose: validateSpan already rejects a
			// non-UTF-8 span name fail-closed, per span, exactly as on the
			// JSON path.
			s, err := f.str("Span.name")
			if err != nil {
				return err
			}
			out.Name = s
		case fSpanKind:
			v, err := f.varint("Span.kind")
			if err != nil {
				return err
			}
			out.Kind = enumRaw(v)
		case fSpanStartTime:
			v, err := f.fixed64("Span.start_time_unix_nano")
			if err != nil {
				return err
			}
			out.StartTimeUnixNano = strconv.FormatUint(v, 10)
		case fSpanEndTime:
			v, err := f.fixed64("Span.end_time_unix_nano")
			if err != nil {
				return err
			}
			out.EndTimeUnixNano = strconv.FormatUint(v, 10)
		case fSpanAttributes:
			b, err := f.bytes("Span.attributes")
			if err != nil {
				return err
			}
			kv, err := decodeKeyValue(b, depth+1)
			if err != nil {
				return err
			}
			out.Attributes = append(out.Attributes, kv)
		case fSpanDroppedAttrs:
			n, err := f.uint32Field("Span.dropped_attributes_count")
			if err != nil {
				return err
			}
			out.DroppedAttributesCount = n
		case fSpanEvents:
			b, err := f.bytes("Span.events")
			if err != nil {
				return err
			}
			ev, err := decodeSpanEvent(b, depth+1)
			if err != nil {
				return err
			}
			out.Events = append(out.Events, ev)
		case fSpanLinks:
			// Links are structurally validated (they must be a well-formed
			// message) but not retained: the shared struct has no Links field
			// on the JSON path either, so keeping them here would diverge the
			// flavors.
			if _, err := f.bytes("Span.links"); err != nil {
				return err
			}
		case fSpanStatus:
			b, err := f.bytes("Span.status")
			if err != nil {
				return err
			}
			st, err := decodeStatus(b, depth+1)
			if err != nil {
				return err
			}
			out.Status = st
		}
		return nil
	})
	return out, err
}

func decodeSpanEvent(buf []byte, depth int) (SpanEvent, error) {
	var out SpanEvent
	if depth > maxProtoDepth {
		return out, errProtoDepth
	}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fSpanEventTime:
			v, err := f.fixed64("Span.Event.time_unix_nano")
			if err != nil {
				return err
			}
			out.TimeUnixNano = strconv.FormatUint(v, 10)
		case fSpanEventName:
			s, err := f.str("Span.Event.name")
			if err != nil {
				return err
			}
			out.Name = s
		case fSpanEventAttributes:
			b, err := f.bytes("Span.Event.attributes")
			if err != nil {
				return err
			}
			kv, err := decodeKeyValue(b, depth+1)
			if err != nil {
				return err
			}
			out.Attributes = append(out.Attributes, kv)
		}
		return nil
	})
	return out, err
}

func decodeStatus(buf []byte, depth int) (*Status, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := &Status{}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fStatusMessage:
			// The status message reaches the payload without passing through
			// the attribute sanitizer, so it is validated here rather than
			// letting encoding/json silently rewrite it to U+FFFD.
			s, err := decodeStructuralString(f, "Status.message")
			if err != nil {
				return err
			}
			out.Message = s
		case fStatusCode:
			v, err := f.varint("Status.code")
			if err != nil {
				return err
			}
			out.Code = enumRaw(v)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeKeyValue(buf []byte, depth int) (KeyValue, error) {
	var out KeyValue
	if depth > maxProtoDepth {
		return out, errProtoDepth
	}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fKeyValueKey:
			// Keys are validated per span by sanitizeKeyValues (invalid
			// UTF-8 rejects the span), matching the JSON path.
			s, err := f.str("KeyValue.key")
			if err != nil {
				return err
			}
			out.Key = s
		case fKeyValueValue:
			b, err := f.bytes("KeyValue.value")
			if err != nil {
				return err
			}
			av, err := decodeAnyValue(b, depth+1)
			if err != nil {
				return err
			}
			out.Value = av
		}
		return nil
	})
	return out, err
}

// decodeAnyValue decodes the AnyValue oneof. Later fields win, which is the
// protobuf rule for a oneof encoded more than once. An AnyValue with nothing
// set decodes to a nil value, which the sanitizer stores as JSON null.
func decodeAnyValue(buf []byte, depth int) (*AnyValue, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := &AnyValue{}
	err := forEachField(buf, func(f protoField) error {
		switch f.num {
		case fAnyValueString:
			// Deliberately raw: utf8String rejects the span fail-closed, the
			// same per-span outcome the JSON flavor produces.
			s, err := f.str("AnyValue.string_value")
			if err != nil {
				return err
			}
			out.v = s
		case fAnyValueBool:
			v, err := f.varint("AnyValue.bool_value")
			if err != nil {
				return err
			}
			out.v = v != 0
		case fAnyValueInt:
			v, err := f.varint("AnyValue.int_value")
			if err != nil {
				return err
			}
			out.v = int64(v)
		case fAnyValueDouble:
			v, err := f.fixed64("AnyValue.double_value")
			if err != nil {
				return err
			}
			out.v = math.Float64frombits(v)
		case fAnyValueBytes:
			b, err := f.bytes("AnyValue.bytes_value")
			if err != nil {
				return err
			}
			// Copy: f.data aliases the request buffer.
			cp := make([]byte, len(b))
			copy(cp, b)
			out.v = cp
		case fAnyValueArray:
			b, err := f.bytes("AnyValue.array_value")
			if err != nil {
				return err
			}
			arr, err := decodeArrayValue(b, depth+1)
			if err != nil {
				return err
			}
			out.v = arr
		case fAnyValueKVList:
			b, err := f.bytes("AnyValue.kvlist_value")
			if err != nil {
				return err
			}
			m, err := decodeKeyValueList(b, depth+1)
			if err != nil {
				return err
			}
			out.v = m
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeArrayValue(buf []byte, depth int) ([]any, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := []any{}
	err := forEachField(buf, func(f protoField) error {
		if f.num != fArrayValueValues {
			return nil
		}
		b, err := f.bytes("ArrayValue.values")
		if err != nil {
			return err
		}
		av, err := decodeAnyValue(b, depth+1)
		if err != nil {
			return err
		}
		out = append(out, av.Value())
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeKeyValueList(buf []byte, depth int) (map[string]any, error) {
	if depth > maxProtoDepth {
		return nil, errProtoDepth
	}
	out := map[string]any{}
	err := forEachField(buf, func(f protoField) error {
		if f.num != fKeyValueListValues {
			return nil
		}
		b, err := f.bytes("KeyValueList.values")
		if err != nil {
			return err
		}
		kv, err := decodeKeyValue(b, depth+1)
		if err != nil {
			return err
		}
		out[kv.Key] = kv.Value.Value()
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// decodeStructuralString reads a string field that bypasses the per-span
// attribute sanitizer (scope name/version, schema urls, trace state, status
// message). Those land in payloads directly, so invalid UTF-8 is rejected
// here rather than silently rewritten to U+FFFD by encoding/json.
func decodeStructuralString(f protoField, where string) (string, error) {
	s, err := f.str(where)
	if err != nil {
		return "", err
	}
	if !utf8.ValidString(s) {
		return "", fmt.Errorf("protobuf: %s is not valid UTF-8", where)
	}
	return s, nil
}

// enumRaw renders an enum/uint64 as the numeric json.RawMessage form that
// kindName/statusName already accept from proto3 JSON.
func enumRaw(v uint64) json.RawMessage {
	return json.RawMessage(strconv.FormatUint(v, 10))
}
