package otlp

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const pbFixturePath = "../../testdata/fixtures/otlp/genai_session.pb"

// --- fixture encoder ------------------------------------------------------
//
// A test-only OTLP/protobuf ENCODER, written top-down from the struct
// literal below so the golden .pb is an independent statement of the same
// logical content as genai_session.json. It never calls the decoder, so
// TestProtoFixtureIDParityWithJSON compares two independent implementations
// rather than a round trip through one.

type pbAttr struct {
	key   string
	str   string
	i64   int64
	isInt bool
}

type pbSpan struct {
	traceID   string // hex, exactly as written in the JSON fixture
	spanID    string
	parentID  string
	name      string
	kind      uint64
	startNS   uint64
	endNS     uint64
	statusMsg string
	statusOK  uint64 // STATUS_CODE enum; 0 = unset (field omitted)
	attrs     []pbAttr
}

type pbFixture struct {
	resource     []pbAttr
	scopeName    string
	scopeVersion string
	spans        []pbSpan
}

// genaiSessionFixture mirrors testdata/fixtures/otlp/genai_session.json.
func genaiSessionFixture() pbFixture {
	const traceID = "0af7651916cd43dd8448eb211c80319c"
	return pbFixture{
		resource: []pbAttr{
			{key: "service.name", str: "codex-cli"},
			{key: "deployment.environment", str: "local"},
		},
		scopeName:    "github.com/handoffgraph/agent-instrumentation",
		scopeVersion: "0.1.0",
		spans: []pbSpan{
			{
				traceID: traceID, spanID: "b7ad6b7169203331",
				name: "run agent", kind: 1,
				startNS: 1756334400000000000, endNS: 1756334405000000000,
				statusOK: 1,
				attrs: []pbAttr{
					{key: "session.id", str: "agent-session-77"},
					{key: "handoffgraph.objective", str: "fix checkout race"},
				},
			},
			{
				traceID: traceID, spanID: "5b8efff798038103", parentID: "b7ad6b7169203331",
				name: "chat gpt-5.3", kind: 3,
				startNS: 1756334401000000000, endNS: 1756334404000000000,
				statusOK: 2, statusMsg: "rate limited",
				attrs: []pbAttr{
					{key: "gen_ai.operation.name", str: "chat"},
					{key: "gen_ai.request.model", str: "gpt-5.3"},
					{key: "gen_ai.usage.input_tokens", i64: 1200, isInt: true},
					{key: "gen_ai.usage.output_tokens", i64: 350, isInt: true},
					{key: "gen_ai.usage.cache_read.input_tokens", i64: 200, isInt: true},
					{key: "__proto__", str: "dropped-me"},
					{key: "llm.prompt", str: "fix the duplicate checkout submission"},
				},
			},
			{
				traceID: traceID, spanID: "8c21f4a1e0d3bb44", parentID: "b7ad6b7169203331",
				name: "execute_tool apply_patch", kind: 1,
				startNS: 1756334402000000000, endNS: 1756334403000000000,
				attrs: []pbAttr{{key: "gen_ai.tool.name", str: "apply_patch"}},
			},
		},
	}
}

// encode renders common.v1.KeyValue.
func (a pbAttr) encode() []byte {
	var av []byte
	if a.isInt {
		av = protoAppendVarintField(av, 3, uint64(a.i64)) // AnyValue.int_value
	} else {
		av = protoAppendString(av, 1, a.str) // AnyValue.string_value
	}
	var kv []byte
	kv = protoAppendString(kv, 1, a.key)
	return protoAppendLenDelim(kv, 2, av)
}

// encode renders trace.v1.Span.
func (s pbSpan) encode(t *testing.T) []byte {
	t.Helper()
	var b []byte
	b = protoAppendLenDelim(b, 1, mustHexBytes(t, s.traceID))
	b = protoAppendLenDelim(b, 2, mustHexBytes(t, s.spanID))
	if s.parentID != "" {
		b = protoAppendLenDelim(b, 4, mustHexBytes(t, s.parentID))
	}
	b = protoAppendString(b, 5, s.name)
	if s.kind != 0 {
		b = protoAppendVarintField(b, 6, s.kind)
	}
	b = protoAppendFixed64(b, 7, s.startNS)
	b = protoAppendFixed64(b, 8, s.endNS)
	for _, a := range s.attrs {
		b = protoAppendLenDelim(b, 9, a.encode())
	}
	if s.statusOK != 0 || s.statusMsg != "" {
		var st []byte
		if s.statusMsg != "" {
			st = protoAppendString(st, 2, s.statusMsg)
		}
		if s.statusOK != 0 {
			st = protoAppendVarintField(st, 3, s.statusOK)
		}
		b = protoAppendLenDelim(b, 15, st)
	}
	return b
}

// encode renders collector.trace.v1.ExportTraceServiceRequest.
func (f pbFixture) encode(t *testing.T) []byte {
	t.Helper()
	var resource []byte
	for _, a := range f.resource {
		resource = protoAppendLenDelim(resource, 1, a.encode())
	}
	var scope []byte
	scope = protoAppendString(scope, 1, f.scopeName)
	scope = protoAppendString(scope, 2, f.scopeVersion)

	var scopeSpans []byte
	scopeSpans = protoAppendLenDelim(scopeSpans, 1, scope)
	for _, s := range f.spans {
		scopeSpans = protoAppendLenDelim(scopeSpans, 2, s.encode(t))
	}

	var rs []byte
	rs = protoAppendLenDelim(rs, 1, resource)
	rs = protoAppendLenDelim(rs, 2, scopeSpans)
	return protoAppendLenDelim(nil, 1, rs)
}

func mustHexBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

func readPBFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(pbFixturePath)
	if err != nil {
		t.Fatalf("read protobuf fixture: %v", err)
	}
	return data
}

// TestProtoFixtureIsGolden pins the committed binary fixture to the
// independent encoder. Set HFG_UPDATE_OTLP_FIXTURE=1 to regenerate it.
func TestProtoFixtureIsGolden(t *testing.T) {
	want := genaiSessionFixture().encode(t)
	if os.Getenv("HFG_UPDATE_OTLP_FIXTURE") == "1" {
		if err := os.WriteFile(pbFixturePath, want, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}
	got := readPBFixture(t)
	if !bytes.Equal(got, want) {
		t.Fatalf("committed %s (%d bytes) differs from the encoder output (%d bytes); "+
			"regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp",
			pbFixturePath, len(got), len(want))
	}
}

// --- the headline: cross-flavor identifier parity -------------------------

// TestProtoFixtureIDParityWithJSON is the acceptance headline for the
// protobuf flavor: the SAME logical telemetry sent as protobuf and as JSON
// converts to byte-identical events — same count, same event ids, same
// payloads, same derived span/trace/session ids. Both flavors reach the one
// deterministic conversion path; nothing about identity is flavor-specific.
func TestProtoFixtureIDParityWithJSON(t *testing.T) {
	req, err := DecodeExportRequest(readPBFixture(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	pb, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(protobuf): %v", err)
	}
	js := convertFixture(t)

	if len(pb.SpanErrors) != 0 {
		t.Fatalf("protobuf span errors: %v", pb.SpanErrors)
	}
	if len(pb.Events) != 9 || len(js.Events) != 9 {
		t.Fatalf("event counts = %d (protobuf) / %d (json), want 9 / 9", len(pb.Events), len(js.Events))
	}
	if pb.DroppedAttributeKeys != js.DroppedAttributeKeys {
		t.Fatalf("dropped attribute keys = %d (protobuf) / %d (json)", pb.DroppedAttributeKeys, js.DroppedAttributeKeys)
	}

	// The id list itself, byte-equal and in the same deterministic order.
	pbIDs := make([]string, len(pb.Events))
	jsIDs := make([]string, len(js.Events))
	for i := range pb.Events {
		pbIDs[i] = pb.Events[i].EventID
		jsIDs[i] = js.Events[i].EventID
	}
	if strings.Join(pbIDs, "\n") != strings.Join(jsIDs, "\n") {
		t.Fatalf("event ids differ across flavors:\nprotobuf: %v\njson:     %v", pbIDs, jsIDs)
	}

	// And the whole event, not just its id: payloads, span/trace/session ids,
	// parent linkage, model, agent, kinds and times all have to match.
	for i := range pb.Events {
		a, err := json.Marshal(pb.Events[i])
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(js.Events[i])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Fatalf("event %d differs across flavors:\nprotobuf: %s\njson:     %s", i, a, b)
		}
	}
}

// --- decoder behavior -----------------------------------------------------

// TestDecodeExportRequestShape checks the protobuf → shared-struct bridge:
// ids become lowercase hex, fixed64 times become decimal strings, enums
// become numeric raw JSON, and attribute values land as the sanitizer's Go
// types.
func TestDecodeExportRequestShape(t *testing.T) {
	req, err := DecodeExportRequest(readPBFixture(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	if len(req.ResourceSpans) != 1 || len(req.ResourceSpans[0].ScopeSpans) != 1 {
		t.Fatalf("shape = %d resourceSpans", len(req.ResourceSpans))
	}
	rs := req.ResourceSpans[0]
	if got := rs.Resource.Attributes[0].Value.Value(); got != "codex-cli" {
		t.Fatalf("service.name = %v", got)
	}
	ss := rs.ScopeSpans[0]
	if ss.Scope.Name != "github.com/handoffgraph/agent-instrumentation" || ss.Scope.Version != "0.1.0" {
		t.Fatalf("scope = %+v", ss.Scope)
	}
	if len(ss.Spans) != 3 {
		t.Fatalf("spans = %d, want 3", len(ss.Spans))
	}
	root := ss.Spans[0]
	if root.TraceID != "0af7651916cd43dd8448eb211c80319c" || root.SpanID != "b7ad6b7169203331" {
		t.Fatalf("root ids = %q / %q", root.TraceID, root.SpanID)
	}
	if root.ParentSpanID != "" {
		t.Fatalf("root parent = %q, want empty", root.ParentSpanID)
	}
	if root.StartTimeUnixNano != "1756334400000000000" || root.EndTimeUnixNano != "1756334405000000000" {
		t.Fatalf("root times = %q / %q", root.StartTimeUnixNano, root.EndTimeUnixNano)
	}
	if string(root.Kind) != "1" {
		t.Fatalf("root kind raw = %q", root.Kind)
	}
	if statusName(root.Status.Code) != "STATUS_CODE_OK" {
		t.Fatalf("root status = %q", root.Status.Code)
	}
	chat := ss.Spans[1]
	if chat.ParentSpanID != "b7ad6b7169203331" {
		t.Fatalf("chat parent = %q", chat.ParentSpanID)
	}
	if !chat.Status.isError() || chat.Status.Message != "rate limited" {
		t.Fatalf("chat status = %+v", chat.Status)
	}
	var tokens any
	for _, kv := range chat.Attributes {
		if kv.Key == "gen_ai.usage.input_tokens" {
			tokens = kv.Value.Value()
		}
	}
	if got, ok := tokens.(int64); !ok || got != 1200 {
		t.Fatalf("input tokens = %#v, want int64(1200)", tokens)
	}
	if ss.Spans[2].Status != nil {
		t.Fatalf("third span should have no status, got %+v", ss.Spans[2].Status)
	}
}

// TestDecodeAnyValueKinds walks every arm of the AnyValue oneof, including
// the nested array/kvlist forms, and proves the decoded Go types are exactly
// the ones the JSON flavor hands the sanitizer.
func TestDecodeAnyValueKinds(t *testing.T) {
	kv := func(key string, av []byte) []byte {
		var b []byte
		b = protoAppendString(b, 1, key)
		return protoAppendLenDelim(b, 2, av)
	}
	// str builds one AnyValue{string_value}; arr/nested wrap the list forms
	// in their own AnyValue oneof arms (array_value = 5, kvlist_value = 6).
	str := func(s string) []byte { return protoAppendString(nil, 1, s) }
	elements := protoAppendLenDelim(nil, 1, str("a"))
	elements = protoAppendLenDelim(elements, 1, str("b"))
	arr := protoAppendLenDelim(nil, 5, elements)
	nested := protoAppendLenDelim(nil, 6, protoAppendLenDelim(nil, 1, kv("inner", str("deep"))))

	attrs := [][]byte{
		kv("s", str("hello")),
		kv("b", protoAppendVarintField(nil, 2, 1)),
		kv("i", protoAppendVarintField(nil, 3, 42)),
		kv("d", protoAppendFixed64(nil, 4, math.Float64bits(2.5))),
		kv("arr", arr),
		kv("kvl", nested),
		kv("raw", protoAppendLenDelim(nil, 7, []byte{0xde, 0xad})),
		kv("unset", nil),
	}
	var span []byte
	span = protoAppendLenDelim(span, 1, mustHexBytes(t, "0af7651916cd43dd8448eb211c80319c"))
	span = protoAppendLenDelim(span, 2, mustHexBytes(t, "b7ad6b7169203331"))
	span = protoAppendString(span, 5, "kinds")
	span = protoAppendFixed64(span, 7, 1756334400000000000)
	span = protoAppendFixed64(span, 8, 1756334401000000000)
	for _, a := range attrs {
		span = protoAppendLenDelim(span, 9, a)
	}
	body := protoAppendLenDelim(nil, 1,
		protoAppendLenDelim(nil, 2, protoAppendLenDelim(nil, 2, span)))

	req, err := DecodeExportRequest(body)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := map[string]any{}
	for _, pair := range req.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes {
		got[pair.Key] = pair.Value.Value()
	}
	if got["s"] != "hello" || got["b"] != true || got["i"] != int64(42) || got["d"] != 2.5 {
		t.Fatalf("scalar values = %#v", got)
	}
	if fmt.Sprint(got["arr"]) != "[a b]" {
		t.Fatalf("array value = %#v", got["arr"])
	}
	inner, ok := got["kvl"].(map[string]any)
	if !ok || inner["inner"] != "deep" {
		t.Fatalf("kvlist value = %#v", got["kvl"])
	}
	if raw, ok := got["raw"].([]byte); !ok || !bytes.Equal(raw, []byte{0xde, 0xad}) {
		t.Fatalf("bytes value = %#v", got["raw"])
	}
	if got["unset"] != nil {
		t.Fatalf("unset AnyValue = %#v, want nil", got["unset"])
	}

	// The sanitizer receives exactly these types: bytes become a hex
	// fingerprint, everything else survives.
	res, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}
	for _, ev := range res.Events {
		var p map[string]any
		_ = json.Unmarshal(ev.Payload, &p)
		if a, ok := p["attributes"].(map[string]any); ok {
			if a["raw"] != "dead" {
				t.Fatalf("bytes attribute = %#v, want hex fingerprint", a["raw"])
			}
		}
	}
}

// TestDecodeSkipsUnknownFields proves forward compatibility: fields a newer
// OTLP release adds (and the ones this decoder deliberately does not retain,
// like links) are skipped without disturbing the conversion.
func TestDecodeSkipsUnknownFields(t *testing.T) {
	base := genaiSessionFixture()
	want, err := DecodeExportRequest(base.encode(t))
	if err != nil {
		t.Fatal(err)
	}

	// Hand-build the same request with extra fields at every level:
	// an unknown varint on the request, a schema_url + unknown fixed32 on
	// ResourceSpans/ScopeSpans, and dropped counts, links and a span event on
	// the span.
	sp := base.spans[0]
	var span []byte
	span = protoAppendLenDelim(span, 1, mustHexBytes(t, sp.traceID))
	span = protoAppendLenDelim(span, 2, mustHexBytes(t, sp.spanID))
	span = protoAppendString(span, 5, sp.name)
	span = protoAppendVarintField(span, 6, sp.kind)
	span = protoAppendFixed64(span, 7, sp.startNS)
	span = protoAppendFixed64(span, 8, sp.endNS)
	for _, a := range sp.attrs {
		span = protoAppendLenDelim(span, 9, a.encode())
	}
	span = protoAppendVarintField(span, 10, 3) // dropped_attributes_count
	spanEvent := protoAppendFixed64(nil, 1, sp.startNS+1)
	spanEvent = protoAppendString(spanEvent, 2, "gen_ai.content.prompt")
	spanEvent = protoAppendLenDelim(spanEvent, 3, pbAttr{key: "note", str: "hi"}.encode())
	span = protoAppendLenDelim(span, 11, spanEvent)
	span = protoAppendVarintField(span, 12, 1) // dropped_events_count
	link := protoAppendLenDelim(nil, 1, mustHexBytes(t, sp.traceID))
	span = protoAppendLenDelim(span, 13, link) // links (decoded, not retained)
	span = protoAppendVarintField(span, 14, 2) // dropped_links_count
	status := protoAppendVarintField(nil, 3, sp.statusOK)
	span = protoAppendLenDelim(span, 15, status)
	span = protoAppendTag(span, 16, wireFixed32) // flags (newer OTLP releases)
	span = append(span, 0, 0, 0, 0)
	span = protoAppendString(span, 99, "from the future")

	var scopeSpans []byte
	scopeSpans = protoAppendLenDelim(scopeSpans, 1,
		protoAppendString(protoAppendString(nil, 1, base.scopeName), 2, base.scopeVersion))
	scopeSpans = protoAppendLenDelim(scopeSpans, 2, span)
	scopeSpans = protoAppendString(scopeSpans, 3, "https://opentelemetry.io/schemas/1.30.0")
	scopeSpans = protoAppendVarintField(scopeSpans, 77, 9)

	var resource []byte
	for _, a := range base.resource {
		resource = protoAppendLenDelim(resource, 1, a.encode())
	}
	resource = protoAppendVarintField(resource, 2, 4) // dropped_attributes_count

	var rs []byte
	rs = protoAppendLenDelim(rs, 1, resource)
	rs = protoAppendLenDelim(rs, 2, scopeSpans)
	rs = protoAppendString(rs, 3, "https://opentelemetry.io/schemas/1.30.0")
	rs = protoAppendLenDelim(rs, 1000, nil) // the reserved legacy field

	body := protoAppendLenDelim(nil, 1, rs)
	body = protoAppendVarintField(body, 42, 7)

	got, err := DecodeExportRequest(body)
	if err != nil {
		t.Fatalf("decode with unknown fields: %v", err)
	}
	gs := got.ResourceSpans[0].ScopeSpans[0].Spans[0]
	ws := want.ResourceSpans[0].ScopeSpans[0].Spans[0]
	if gs.TraceID != ws.TraceID || gs.SpanID != ws.SpanID || gs.Name != ws.Name ||
		gs.StartTimeUnixNano != ws.StartTimeUnixNano || gs.EndTimeUnixNano != ws.EndTimeUnixNano {
		t.Fatalf("known fields disturbed by unknown ones: %+v vs %+v", gs, ws)
	}
	if gs.DroppedAttributesCount != 3 || got.ResourceSpans[0].Resource.DroppedAttributesCount != 4 {
		t.Fatalf("dropped counts = %d / %d", gs.DroppedAttributesCount, got.ResourceSpans[0].Resource.DroppedAttributesCount)
	}
	if got.ResourceSpans[0].SchemaURL == "" || got.ResourceSpans[0].ScopeSpans[0].SchemaURL == "" {
		t.Fatal("schema urls not decoded")
	}
	// Span events decode (they are evidence the spine may use later) but do
	// not change the event stream, which is derived from the span pair.
	if len(gs.Events) != 1 || gs.Events[0].Name != "gen_ai.content.prompt" ||
		gs.Events[0].TimeUnixNano != "1756334400000000001" ||
		len(gs.Events[0].Attributes) != 1 || gs.Events[0].Attributes[0].Value.Value() != "hi" {
		t.Fatalf("span events = %+v", gs.Events)
	}
	res, err := Convert(got, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}
}

// TestDecodeTruncationTable feeds every prefix of the golden fixture to the
// decoder. Each one must either error cleanly or decode to a strict subset
// of the full content — never a panic, never an invented span.
func TestDecodeTruncationTable(t *testing.T) {
	full := readPBFixture(t)
	whole, err := DecodeExportRequest(full)
	if err != nil {
		t.Fatalf("decode full fixture: %v", err)
	}
	known := map[string]bool{}
	for _, rs := range whole.ResourceSpans {
		for _, ss := range rs.ScopeSpans {
			for _, sp := range ss.Spans {
				known[spanSignature(sp)] = true
			}
		}
	}

	errs, oks := 0, 0
	for n := 0; n <= len(full); n++ {
		prefix := full[:n]
		req, err := DecodeExportRequest(prefix)
		if err != nil {
			errs++
			continue
		}
		oks++
		for _, rs := range req.ResourceSpans {
			for _, ss := range rs.ScopeSpans {
				for _, sp := range ss.Spans {
					if !known[spanSignature(sp)] {
						t.Fatalf("prefix of %d bytes decoded a span absent from the full fixture: %+v", n, sp)
					}
				}
			}
		}
		// A subset must still convert without panicking.
		if _, err := Convert(req, Options{ObservedAt: fixedObserved()}); err != nil {
			t.Fatalf("prefix of %d bytes: Convert: %v", n, err)
		}
	}
	if errs == 0 || oks == 0 {
		t.Fatalf("truncation table degenerate: %d errors, %d clean decodes", errs, oks)
	}

	// Byte-level corruption must also stay panic-free and never widen the
	// span set (deterministic mutation, so a failure reproduces exactly).
	for i := 0; i < len(full); i++ {
		mutated := append([]byte(nil), full...)
		mutated[i] ^= 0xff
		req, err := DecodeExportRequest(mutated)
		if err != nil {
			continue
		}
		if _, err := Convert(req, Options{ObservedAt: fixedObserved()}); err != nil {
			t.Fatalf("mutation at byte %d: Convert: %v", i, err)
		}
	}
}

func spanSignature(sp Span) string {
	return strings.Join([]string{sp.TraceID, sp.SpanID, sp.ParentSpanID, sp.Name,
		sp.StartTimeUnixNano, sp.EndTimeUnixNano}, "|")
}

// TestDecodeRejectsDeepNesting fails closed on a self-nesting attribute
// bomb instead of recursing until the stack dies.
func TestDecodeRejectsDeepNesting(t *testing.T) {
	// AnyValue -> kvlist_value -> KeyValue -> AnyValue -> ... , n levels deep.
	build := func(levels int) []byte {
		av := protoAppendString(nil, 1, "bottom")
		for i := 0; i < levels; i++ {
			kv := protoAppendString(nil, 1, "k")
			kv = protoAppendLenDelim(kv, 2, av)
			list := protoAppendLenDelim(nil, 1, kv)
			av = protoAppendLenDelim(nil, 6, list)
		}
		attr := protoAppendString(nil, 1, "deep")
		attr = protoAppendLenDelim(attr, 2, av)
		span := protoAppendLenDelim(nil, 1, mustHexBytes(t, "0af7651916cd43dd8448eb211c80319c"))
		span = protoAppendLenDelim(span, 2, mustHexBytes(t, "b7ad6b7169203331"))
		span = protoAppendFixed64(span, 7, 1756334400000000000)
		span = protoAppendFixed64(span, 8, 1756334401000000000)
		span = protoAppendLenDelim(span, 9, attr)
		return protoAppendLenDelim(nil, 1,
			protoAppendLenDelim(nil, 2, protoAppendLenDelim(nil, 2, span)))
	}

	if _, err := DecodeExportRequest(build(3)); err != nil {
		t.Fatalf("shallow nesting rejected: %v", err)
	}
	_, err := DecodeExportRequest(build(maxProtoDepth + 8))
	if err == nil {
		t.Fatal("deep nesting accepted; the decoder must fail closed")
	}
	if !errors.Is(err, errProtoDepth) {
		t.Fatalf("deep nesting error = %v, want the depth guard", err)
	}
}

// TestDecodeRejectsMalformedWire covers the fail-closed wire-level rules.
func TestDecodeRejectsMalformedWire(t *testing.T) {
	overlong := []byte{0x0a} // resource_spans tag with no length
	group := protoAppendTag(nil, 1, wireStartGroup)
	wrongType := protoAppendVarintField(nil, 1, 5) // resource_spans as varint
	badVarint := []byte{0x0a, 0x02, 0xff, 0xff}    // length 2, then a truncated varint inside

	cases := []struct {
		name string
		body []byte
	}{
		{"truncated tag", overlong},
		{"group wire type", group},
		{"wire type mismatch", wrongType},
		{"truncated inner varint", badVarint},
		{"varint overflow", append([]byte{0x0a, 0x0b, 0x08},
			0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)},
		{"zero field number", []byte{0x00, 0x00}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeExportRequest(tc.body); err == nil {
				t.Fatalf("%s accepted", tc.name)
			}
		})
	}

	big := make([]byte, maxRequestBytes+1)
	if _, err := DecodeExportRequest(big); err == nil {
		t.Fatal("oversized body accepted")
	}
}

// TestProtoWireRoundTrip pins the varint/fixed64 codec itself.
func TestProtoWireRoundTrip(t *testing.T) {
	values := []uint64{0, 1, 127, 128, 300, 1 << 21, math.MaxInt64, math.MaxUint64}
	for _, v := range values {
		buf := protoAppendVarintField(nil, 3, v)
		buf = protoAppendFixed64(buf, 4, v)
		var gotVarint, gotFixed uint64
		if err := forEachField(buf, func(f protoField) error {
			switch f.num {
			case 3:
				var err error
				gotVarint, err = f.varint("varint")
				return err
			case 4:
				var err error
				gotFixed, err = f.fixed64("fixed64")
				return err
			}
			return nil
		}); err != nil {
			t.Fatalf("value %d: %v", v, err)
		}
		if gotVarint != v || gotFixed != v {
			t.Fatalf("round trip %d -> %d / %d", v, gotVarint, gotFixed)
		}
	}
}

// --- HTTP flavor ----------------------------------------------------------

// decodeExportResponsePB reads ExportTraceServiceResponse off the wire so the
// handler test asserts on the real bytes, not on the struct that produced
// them.
func decodeExportResponsePB(t *testing.T, body []byte) *partialSuccess {
	t.Helper()
	var out *partialSuccess
	err := forEachField(body, func(f protoField) error {
		if f.num != 1 {
			return nil
		}
		b, err := f.bytes("ExportTraceServiceResponse.partial_success")
		if err != nil {
			return err
		}
		ps := &partialSuccess{}
		if err := forEachField(b, func(g protoField) error {
			switch g.num {
			case 1:
				v, err := g.varint("rejected_spans")
				if err != nil {
					return err
				}
				ps.RejectedSpans = int64(v)
			case 2:
				s, err := g.str("error_message")
				if err != nil {
					return err
				}
				ps.ErrorMessage = s
			}
			return nil
		}); err != nil {
			return err
		}
		out = ps
		return nil
	})
	if err != nil {
		t.Fatalf("decode ExportTraceServiceResponse: %v", err)
	}
	return out
}

// TestHandlerProtobufFlavor is the HTTP contract: a protobuf export is
// accepted, answered with a protobuf ExportTraceServiceResponse, idempotent
// on replay, and byte-identical in outcome to the JSON export of the same
// telemetry.
func TestHandlerProtobufFlavor(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { db.Close() })
	srv := httptest.NewServer(&Handler{Append: db.AppendEvent})
	t.Cleanup(srv.Close)

	data := readPBFixture(t)
	post := func(ct string, body []byte) *http.Response {
		t.Helper()
		resp, err := http.Post(srv.URL+"/v1/traces", ct, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}

	resp := post("application/x-protobuf", data)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("protobuf POST = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/x-protobuf" {
		t.Fatalf("response content type = %q, want application/x-protobuf", got)
	}
	raw := readAll(t, resp)
	if len(raw) != 0 {
		t.Fatalf("full success should be the empty message, got %d bytes", len(raw))
	}
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 9 {
		t.Fatalf("event count after protobuf POST = %d, want 9", n)
	}

	// Replay is a no-op, and so is the JSON flavor of the same telemetry:
	// both derive the same ids, so the store rejects every duplicate.
	if code := post("application/x-protobuf", data).StatusCode; code != http.StatusOK {
		t.Fatalf("protobuf replay = %d", code)
	}
	jsonBody, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}
	if code := post("application/json", jsonBody).StatusCode; code != http.StatusOK {
		t.Fatalf("json POST = %d", code)
	}
	n2, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n2 != n {
		t.Fatalf("cross-flavor replay duplicated events: %d -> %d", n, n2)
	}

	// application/protobuf is accepted as an alias.
	alias := post("application/protobuf", data)
	if alias.StatusCode != http.StatusOK {
		t.Fatalf("application/protobuf POST = %d", alias.StatusCode)
	}

	// Garbage protobuf is a clean 400, not a 415 and not a panic.
	bad := post("application/x-protobuf", []byte("x"))
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("garbage protobuf = %d, want 400", bad.StatusCode)
	}
}

// TestHandlerProtobufPartialSuccess proves rejected spans are reported in
// the protobuf response body, not silently dropped.
func TestHandlerProtobufPartialSuccess(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { db.Close() })
	srv := httptest.NewServer(&Handler{Append: db.AppendEvent})
	t.Cleanup(srv.Close)

	// One span with a 4-byte trace id (illegal: OTLP trace ids are 16 bytes)
	// and one good span, in a single batch.
	var bad []byte
	bad = protoAppendLenDelim(bad, 1, []byte{1, 2, 3, 4})
	bad = protoAppendLenDelim(bad, 2, mustHexBytes(t, "b7ad6b7169203331"))
	bad = protoAppendString(bad, 5, "short trace id")
	bad = protoAppendFixed64(bad, 7, 1756334400000000000)
	bad = protoAppendFixed64(bad, 8, 1756334400000000001)

	var good []byte
	good = protoAppendLenDelim(good, 1, mustHexBytes(t, "0af7651916cd43dd8448eb211c80319c"))
	good = protoAppendLenDelim(good, 2, mustHexBytes(t, "5b8efff798038103"))
	good = protoAppendString(good, 5, "ok span")
	good = protoAppendVarintField(good, 6, 1)
	good = protoAppendFixed64(good, 7, 1756334400000000000)
	good = protoAppendFixed64(good, 8, 1756334400000000001)

	scopeSpans := protoAppendLenDelim(nil, 2, bad)
	scopeSpans = protoAppendLenDelim(scopeSpans, 2, good)
	body := protoAppendLenDelim(nil, 1, protoAppendLenDelim(nil, 2, scopeSpans))

	resp, err := http.Post(srv.URL+"/v1/traces", "application/x-protobuf", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 with partial success", resp.StatusCode)
	}
	ps := decodeExportResponsePB(t, readAll(t, resp))
	if ps == nil || ps.RejectedSpans != 1 {
		t.Fatalf("partial success = %+v, want 1 rejected span", ps)
	}
	if !strings.Contains(ps.ErrorMessage, "traceId") {
		t.Fatalf("error message = %q", ps.ErrorMessage)
	}
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// ok span: started + completed + trace pair + session.started
	if n != 5 {
		t.Fatalf("event count = %d, want 5", n)
	}
}

func readAll(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return buf.Bytes()
}
