// Package otlp converts OTLP/JSON trace-export requests into canonical
// hfg.event.v1 events, and serves the OTLP/HTTP JSON ingest endpoint.
//
// Design (P1 of docs/parity-plan.md):
//
//   - One OTLP span becomes a span.started + span.completed/span.failed
//     event pair at the span's own start/end times, so the existing
//     deterministic trace materializer derives durations and status without
//     any change to the event vocabulary.
//   - Every identifier (event, session, trace, span) is derived
//     deterministically from the OTLP trace/span ids plus content, so
//     re-importing the same telemetry is idempotent by construction.
//   - Attribute sanitization is fail-closed: reserved keys are dropped and
//     counted, strings that are not valid UTF-8 or exceed the size cap
//     reject the span. Nothing is silently rewritten (no U+FFFD).
//   - GenAI semantic conventions (gen_ai.*), OpenInference
//     (openinference.span.kind, llm.*), OpenLIT coding_agent.*, and
//     Langfuse session attributes are mapped into HandoffGraph fields;
//     unknown attributes are preserved under payload.attributes.
//
// Only OTLP/JSON (application/json) is accepted today; protobuf and gRPC
// ingestion are tracked in docs/parity-plan.md as follow-up work.
package otlp

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// maxAttrStringBytes caps any single string inside an attribute tree.
// Anything larger rejects the span (fail-closed) instead of truncating
// evidence.
const maxAttrStringBytes = 64 * 1024

// maxAttrDepth bounds recursive attribute values.
const maxAttrDepth = 10

// reservedAttrKeys are dropped (and counted) before any attribute is stored.
// The list mirrors the prototype-pollution guards used by OTel-native
// backends: these keys are dangerous downstream, never legitimate evidence.
var reservedAttrKeys = map[string]bool{
	"__proto__":   true,
	"constructor": true,
	"prototype":   true,
}

// ExportRequest is the OTLP/JSON ExportTraceServiceRequest body.
type ExportRequest struct {
	ResourceSpans []ResourceSpans `json:"resourceSpans"`
}

// ResourceSpans groups spans sharing one Resource (one instrumented process).
type ResourceSpans struct {
	Resource   *Resource    `json:"resource,omitempty"`
	ScopeSpans []ScopeSpans `json:"scopeSpans,omitempty"`
	SchemaURL  string       `json:"schemaUrl,omitempty"`
}

// Resource carries resource-level attributes (service.name, ...).
type Resource struct {
	Attributes             []KeyValue `json:"attributes,omitempty"`
	DroppedAttributesCount int        `json:"droppedAttributesCount,omitempty"`
}

func (r *Resource) attrs() []KeyValue {
	if r == nil {
		return nil
	}
	return r.Attributes
}

// ScopeSpans groups spans from one instrumentation scope.
type ScopeSpans struct {
	Scope     *InstrumentationScope `json:"scope,omitempty"`
	Spans     []Span                `json:"spans,omitempty"`
	SchemaURL string                `json:"schemaUrl,omitempty"`
}

// InstrumentationScope identifies the library that emitted the spans.
type InstrumentationScope struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
}

// Span is one OTLP span. proto3 JSON carries the fixed64 time fields as
// decimal strings and enum fields (kind, status.code) as either enum numbers
// or names; both are accepted. Numeric JSON for the time fields is rejected
// fail-closed (the spec is clear and spec-violating emitters must be told,
// not guessed around).
type Span struct {
	TraceID                string          `json:"traceId,omitempty"`
	SpanID                 string          `json:"spanId,omitempty"`
	ParentSpanID           string          `json:"parentSpanId,omitempty"`
	Name                   string          `json:"name,omitempty"`
	Kind                   json.RawMessage `json:"kind,omitempty"`
	StartTimeUnixNano      string          `json:"startTimeUnixNano,omitempty"`
	EndTimeUnixNano        string          `json:"endTimeUnixNano,omitempty"`
	Attributes             []KeyValue      `json:"attributes,omitempty"`
	DroppedAttributesCount int             `json:"droppedAttributesCount,omitempty"`
	Events                 []SpanEvent     `json:"events,omitempty"`
	Status                 *Status         `json:"status,omitempty"`
	TraceState             string          `json:"traceState,omitempty"`
}

// SpanEvent is a timestamped annotation on a span.
type SpanEvent struct {
	TimeUnixNano string     `json:"timeUnixNano,omitempty"`
	Name         string     `json:"name,omitempty"`
	Attributes   []KeyValue `json:"attributes,omitempty"`
}

// Status is the OTLP span status. The code may arrive as the enum number
// (proto3 JSON default) or its name.
type Status struct {
	Message string          `json:"message,omitempty"`
	Code    json.RawMessage `json:"code,omitempty"`
}

// isError reports whether the status marks the span failed.
func (s *Status) isError() bool {
	if s == nil {
		return false
	}
	switch statusName(s.Code) {
	case "STATUS_CODE_ERROR":
		return true
	default:
		return false
	}
}

func (s *Status) errorString() string {
	if s == nil || s.Message == "" {
		return "error"
	}
	return s.Message
}

// AnyValue is one OTLP attribute value. proto3 JSON encodes int64 as a
// string, but hand-written exporters sometimes emit bare numbers; both are
// accepted. Decoding is strict about shapes it does not understand so a
// malformed attribute rejects its span instead of corrupting the spine.
type AnyValue struct {
	v any // nil | string | bool | int64 | float64 | []any | map[string]any | []byte
}

// Value returns the decoded Go value.
func (a *AnyValue) Value() any {
	if a == nil {
		return nil
	}
	return a.v
}

// MarshalJSON renders the decoded value (never the OTLP wrapper).
func (a AnyValue) MarshalJSON() ([]byte, error) { return json.Marshal(a.v) }

// UnmarshalJSON decodes the OTLP AnyValue oneof.
func (a *AnyValue) UnmarshalJSON(data []byte) error {
	trimmed := trimSpaceBytes(data)
	if len(trimmed) == 0 {
		return errors.New("empty attribute value")
	}
	switch trimmed[0] {
	case '"':
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		a.v = s
		return nil
	case 't', 'f':
		var b bool
		if err := json.Unmarshal(data, &b); err != nil {
			return err
		}
		a.v = b
		return nil
	case 'n':
		a.v = nil
		return nil
	case '[', '{':
		return a.decodeNested(data)
	default:
		var n json.Number
		if err := json.Unmarshal(data, &n); err != nil {
			return err
		}
		if i, err := n.Int64(); err == nil {
			a.v = i
			return nil
		}
		f, err := n.Float64()
		if err != nil {
			return fmt.Errorf("attribute number %q: %w", n.String(), err)
		}
		a.v = f
		return nil
	}
}

// decodeNested decodes the object/array forms of the AnyValue oneof.
func (a *AnyValue) decodeNested(data []byte) error {
	if data[0] == '[' {
		var arr []AnyValue
		if err := json.Unmarshal(data, &arr); err != nil {
			return err
		}
		out := make([]any, 0, len(arr))
		for _, e := range arr {
			out = append(out, e.Value())
		}
		a.v = out
		return nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	one := func(field string) (json.RawMessage, bool) {
		raw, ok := probe[field]
		return raw, ok && len(probe) == 1
	}
	if raw, ok := one("stringValue"); ok {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		a.v = s
		return nil
	}
	if raw, ok := one("boolValue"); ok {
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		a.v = b
		return nil
	}
	if raw, ok := one("intValue"); ok {
		// proto3 JSON encodes int64 as a decimal string; accept bare numbers too.
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			i, perr := strconv.ParseInt(s, 10, 64)
			if perr != nil {
				return fmt.Errorf("intValue %q: %w", s, perr)
			}
			a.v = i
			return nil
		}
		var av AnyValue
		if err := av.UnmarshalJSON(raw); err != nil {
			return err
		}
		switch av.v.(type) {
		case int64, float64:
			a.v = av.v
			return nil
		default:
			return errors.New("intValue must be a number or decimal string")
		}
	}
	if raw, ok := one("doubleValue"); ok {
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return err
		}
		a.v = f
		return nil
	}
	if raw, ok := one("bytesValue"); ok {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return fmt.Errorf("bytesValue base64: %w", err)
		}
		a.v = b
		return nil
	}
	if raw, ok := one("arrayValue"); ok {
		// The OTLP proto names ArrayValue's repeated field "values", which is
		// what proto3-JSON emitters (and the protobuf decoder in proto.go)
		// produce. Earlier builds of this decoder read "elements" instead, so
		// both spellings are accepted; "values" wins when a payload carries
		// both, since that is the spec-defined field.
		var arr struct {
			Values   []AnyValue `json:"values"`
			Elements []AnyValue `json:"elements"`
		}
		if err := json.Unmarshal(raw, &arr); err != nil {
			return err
		}
		items := arr.Values
		if items == nil {
			items = arr.Elements
		}
		out := make([]any, 0, len(items))
		for _, e := range items {
			out = append(out, e.Value())
		}
		a.v = out
		return nil
	}
	if raw, ok := one("kvlistValue"); ok {
		var kv struct {
			Values []KeyValue `json:"values"`
		}
		if err := json.Unmarshal(raw, &kv); err != nil {
			return err
		}
		m := make(map[string]any, len(kv.Values))
		for _, pair := range kv.Values {
			m[pair.Key] = pair.Value.Value()
		}
		a.v = m
		return nil
	}
	return fmt.Errorf("unsupported attribute value object with %d key(s)", len(probe))
}

// KeyValue is one attribute pair.
type KeyValue struct {
	Key   string    `json:"key"`
	Value *AnyValue `json:"value,omitempty"`
}

// statusName normalizes an OTLP status code (enum number or name).
func statusName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "STATUS_CODE_UNSET"
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			switch s {
			case "STATUS_CODE_ERROR", "ERROR", "2":
				return "STATUS_CODE_ERROR"
			case "STATUS_CODE_OK", "OK", "1":
				return "STATUS_CODE_OK"
			}
			return "STATUS_CODE_UNSET"
		}
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		switch n {
		case 1:
			return "STATUS_CODE_OK"
		case 2:
			return "STATUS_CODE_ERROR"
		}
	}
	return "STATUS_CODE_UNSET"
}

// kindName normalizes an OTLP span kind (enum number or name).
func kindName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "SPAN_KIND_UNSPECIFIED"
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return otlpKindName(s)
		}
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		switch n {
		case 1:
			return "SPAN_KIND_INTERNAL"
		case 2:
			return "SPAN_KIND_SERVER"
		case 3:
			return "SPAN_KIND_CLIENT"
		case 4:
			return "SPAN_KIND_PRODUCER"
		case 5:
			return "SPAN_KIND_CONSUMER"
		}
		return "SPAN_KIND_UNSPECIFIED"
	}
	return "SPAN_KIND_UNSPECIFIED"
}

func trimSpaceBytes(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && isSpaceByte(b[i]) {
		i++
	}
	for j > i && isSpaceByte(b[j-1]) {
		j--
	}
	return b[i:j]
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// validHex reports whether s is exactly n hex chars (either case).
func validHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// utf8String validates a decoded string for the spine: valid UTF-8 (never
// silently rewritten to U+FFFD) and within the size cap.
func utf8String(s string) (string, error) {
	if !utf8.ValidString(s) {
		return "", errors.New("attribute string is not valid UTF-8")
	}
	if len(s) > maxAttrStringBytes {
		return "", fmt.Errorf("attribute string exceeds %d bytes", maxAttrStringBytes)
	}
	return s, nil
}
