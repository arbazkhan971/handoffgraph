package otlp

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// payload_parity is the Go-authored statement of two payload-shape contracts
// the hosted TypeScript converter has to reproduce byte for byte
// (platform/test/otlp.test.ts + platform/test/otlp_proto.test.ts read these
// exact files):
//
//   - every AnyValue arm resolves to a plain JSON value, never to an
//     undecoded proto3-JSON wrapper: bytes become a lowercase hex
//     fingerprint, a kvlist becomes an object with reserved keys dropped, and
//     an int64 keeps its exact value;
//   - a FAILED span carries payload.attributes exactly like a completed one —
//     failure is when evidence matters most.
//
// It is a SEPARATE fixture from genai_session/array_values: existing fixtures
// and their derived ids must not move.

const payloadParityJSONPath = "../../testdata/fixtures/otlp/payload_parity.json"
const payloadParityPBPath = "../../testdata/fixtures/otlp/payload_parity.pb"

// pbAnyBytes wraps raw bytes in AnyValue.bytes_value (field 7).
func pbAnyBytes(b []byte) []byte { return protoAppendLenDelim(nil, 7, b) }

// pbAnyKVList wraps encoded common.v1.KeyValue bodies in
// AnyValue.kvlist_value (field 6) -> KeyValueList.values (field 1).
func pbAnyKVList(pairs ...[]byte) []byte {
	var list []byte
	for _, p := range pairs {
		list = protoAppendLenDelim(list, 1, p)
	}
	return protoAppendLenDelim(nil, 6, list)
}

// payloadParityFixture mirrors testdata/fixtures/otlp/payload_parity.json.
func payloadParityFixture() pbFixture {
	const traceID = "3d9b1c77aa4f4e2f9c0b5a6d7e8f9012"
	return pbFixture{
		resource: []pbAttr{
			{key: "service.name", str: "payload-harness"},
			{key: "deployment.environment", str: "ci"},
		},
		scopeName:    "github.com/handoffgraph/agent-instrumentation",
		scopeVersion: "0.4.0",
		spans: []pbSpan{
			{
				traceID: traceID, spanID: "0102030405060708",
				name: "execute_tool sign_artifact", kind: 1,
				startNS: 1787918400000000000, endNS: 1787918401000000000,
				statusOK: 1,
				attrs: []pbAttr{
					{key: "gen_ai.tool.name", str: "sign_artifact"},
					{key: "tool.fingerprint", anyValue: pbAnyBytes([]byte{0xde, 0xad, 0xbe, 0xef})},
					{key: "tool.meta", anyValue: pbAnyKVList(
						pbAttr{key: "runner", str: "linux-arm64"}.encode(),
						pbAttr{key: "retries", i64: 2, isInt: true}.encode(),
						pbAttr{key: "__proto__", str: "dropped-me"}.encode(),
					)},
					// 2^53-1: the largest integer JSON transports exactly, so
					// every corner of the parity square agrees on the digits.
					{key: "tool.duration_ns", i64: 9007199254740991, isInt: true},
				},
			},
			{
				traceID: traceID, spanID: "090a0b0c0d0e0f10", parentID: "0102030405060708",
				name: "chat gpt-5.3", kind: 3,
				startNS: 1787918400200000000, endNS: 1787918400900000000,
				statusOK: 2, statusMsg: "rate limited",
				attrs: []pbAttr{
					{key: "gen_ai.request.model", str: "gpt-5.3"},
					{key: "gen_ai.usage.input_tokens", i64: 1200, isInt: true},
				},
			},
		},
	}
}

// completedPayloadRaw returns the marshalled payload of the single
// span.completed event, exactly as it reaches storage.
func completedPayloadRaw(t *testing.T, res *Result) string {
	t.Helper()
	for _, ev := range res.Events {
		if ev.Kind == "span.completed" {
			return string(ev.Payload)
		}
	}
	t.Fatal("no span.completed event")
	return ""
}

func loadPayloadParityJSON(t *testing.T) *ExportRequest {
	t.Helper()
	data, err := os.ReadFile(payloadParityJSONPath)
	if err != nil {
		t.Fatalf("read payload parity json fixture: %v", err)
	}
	var req ExportRequest
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatalf("unmarshal payload parity json fixture: %v", err)
	}
	return &req
}

func readPayloadParityPB(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(payloadParityPBPath)
	if err != nil {
		t.Fatalf("read payload parity protobuf fixture: %v", err)
	}
	return data
}

// TestPayloadParityFixtureIsGolden pins the committed .pb to the independent
// encoder. Regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp.
func TestPayloadParityFixtureIsGolden(t *testing.T) {
	want := payloadParityFixture().encode(t)
	if os.Getenv("HFG_UPDATE_OTLP_FIXTURE") == "1" {
		if err := os.WriteFile(payloadParityPBPath, want, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}
	if got := readPayloadParityPB(t); !bytes.Equal(got, want) {
		t.Fatalf("committed %s (%d bytes) differs from the encoder output (%d bytes); "+
			"regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp",
			payloadParityPBPath, len(got), len(want))
	}
}

// TestPayloadParityAttributeShapes pins the exact payload values both
// languages must produce for every AnyValue arm.
func TestPayloadParityAttributeShapes(t *testing.T) {
	for _, flavor := range []struct {
		name string
		load func(*testing.T) *ExportRequest
	}{
		{"json", loadPayloadParityJSON},
		{"protobuf", func(t *testing.T) *ExportRequest {
			t.Helper()
			req, err := DecodeExportRequest(readPayloadParityPB(t))
			if err != nil {
				t.Fatalf("DecodeExportRequest: %v", err)
			}
			return req
		}},
	} {
		t.Run(flavor.name, func(t *testing.T) {
			res, err := Convert(flavor.load(t), Options{ObservedAt: fixedObserved()})
			if err != nil {
				t.Fatalf("Convert: %v", err)
			}
			if len(res.SpanErrors) != 0 {
				t.Fatalf("span errors: %v", res.SpanErrors)
			}
			attrs := completedAttributes(t, res)
			// Bytes: a lowercase hex fingerprint, never base64 and never a
			// {"bytesValue": …} wrapper.
			if attrs["tool.fingerprint"] != "deadbeef" {
				t.Fatalf("tool.fingerprint = %#v, want \"deadbeef\"", attrs["tool.fingerprint"])
			}
			// kvlist: a plain object, with the reserved key dropped.
			meta, ok := attrs["tool.meta"].(map[string]any)
			if !ok {
				t.Fatalf("tool.meta = %#v, want an object", attrs["tool.meta"])
			}
			if want := (map[string]any{"runner": "linux-arm64", "retries": float64(2)}); !reflect.DeepEqual(meta, want) {
				t.Fatalf("tool.meta = %#v, want %#v", meta, want)
			}
			// int64: the exact value, not a rounded double.
			if attrs["tool.duration_ns"] != float64(9007199254740991) {
				t.Fatalf("tool.duration_ns = %#v", attrs["tool.duration_ns"])
			}
			// And the digits that actually reach storage, straight off the
			// marshalled payload rather than through a float64 hop.
			if raw := completedPayloadRaw(t, res); !strings.Contains(raw, `"tool.duration_ns":9007199254740991`) {
				t.Fatalf("int64 lost its exact digits on the way to storage: %s", raw)
			}
		})
	}
}

// TestPayloadParityFailedSpanKeepsAttributes is the fix-6 contract: a span
// with STATUS_CODE_ERROR carries its attributes exactly like a completed one.
func TestPayloadParityFailedSpanKeepsAttributes(t *testing.T) {
	res, err := Convert(loadPayloadParityJSON(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	var failed *json.RawMessage
	for _, ev := range res.Events {
		if ev.Kind == "span.failed" {
			payload := ev.Payload
			failed = &payload
		}
	}
	if failed == nil {
		t.Fatal("no span.failed event for the error span")
	}
	var p map[string]any
	if err := json.Unmarshal(*failed, &p); err != nil {
		t.Fatal(err)
	}
	if p["error"] != "rate limited" {
		t.Fatalf("error = %#v", p["error"])
	}
	attrs, ok := p["attributes"].(map[string]any)
	if !ok {
		t.Fatalf("span.failed dropped payload.attributes: %#v", p)
	}
	if attrs["gen_ai.request.model"] != "gpt-5.3" || attrs["gen_ai.usage.input_tokens"] != float64(1200) {
		t.Fatalf("span.failed attributes = %#v", attrs)
	}
}

// TestPayloadParityCrossFlavor is the headline: the same telemetry sent as
// protobuf and as spec-correct proto3 JSON converts to identical events.
func TestPayloadParityCrossFlavor(t *testing.T) {
	decoded, err := DecodeExportRequest(readPayloadParityPB(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	pb, err := Convert(decoded, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(protobuf): %v", err)
	}
	js, err := Convert(loadPayloadParityJSON(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(json): %v", err)
	}
	if len(pb.SpanErrors) != 0 || len(js.SpanErrors) != 0 {
		t.Fatalf("span errors: protobuf %v / json %v", pb.SpanErrors, js.SpanErrors)
	}
	// 2 spans x 2 + trace pair + session.started.
	if len(pb.Events) != 7 || len(js.Events) != 7 {
		t.Fatalf("event counts = %d (protobuf) / %d (json), want 7 / 7", len(pb.Events), len(js.Events))
	}
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

// --- protobuf UTF-8 rejection --------------------------------------------

const utf8RejectPBPath = "../../testdata/fixtures/otlp/utf8_reject.pb"

// utf8RejectFixture is protobuf-only by nature: JSON cannot carry invalid
// UTF-8, so there is no JSON twin. Three spans each break one of the three
// per-span string paths (span name, attribute value, attribute key) and one
// clean sibling proves the batch still partially succeeds. The clean span
// deliberately carries NO attributes, under a NAMED scope, so this fixture
// also pins the attribute-less-span merge.
func utf8RejectFixture() pbFixture {
	const traceID = "6b2c9e10df4a4c85b1e37a5d0c8f2413"
	return pbFixture{
		resource:     []pbAttr{{key: "service.name", str: "utf8-harness"}},
		scopeName:    "io.opentelemetry.sdk",
		scopeVersion: "1.42.0",
		spans: []pbSpan{
			{
				traceID: traceID, spanID: "1111111111111111",
				name: "bad-\xff-name", kind: 1,
				startNS: 1787918400000000000, endNS: 1787918401000000000,
			},
			{
				traceID: traceID, spanID: "2222222222222222",
				name: "bad value span", kind: 1,
				startNS: 1787918400100000000, endNS: 1787918401000000000,
				attrs: []pbAttr{{key: "note", str: "oops-\xff"}},
			},
			{
				traceID: traceID, spanID: "3333333333333333",
				name: "bad key span", kind: 1,
				startNS: 1787918400200000000, endNS: 1787918401000000000,
				attrs: []pbAttr{{key: "k\xffey", str: "fine"}},
			},
			{
				traceID: traceID, spanID: "4444444444444444",
				name: "clean sibling", kind: 1,
				startNS: 1787918400300000000, endNS: 1787918401000000000,
			},
		},
	}
}

func readUTF8RejectPB(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(utf8RejectPBPath)
	if err != nil {
		t.Fatalf("read utf8 reject fixture: %v", err)
	}
	return data
}

// TestUTF8RejectFixtureIsGolden pins the committed .pb to the encoder.
func TestUTF8RejectFixtureIsGolden(t *testing.T) {
	want := utf8RejectFixture().encode(t)
	if os.Getenv("HFG_UPDATE_OTLP_FIXTURE") == "1" {
		if err := os.WriteFile(utf8RejectPBPath, want, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}
	if got := readUTF8RejectPB(t); !bytes.Equal(got, want) {
		t.Fatalf("committed %s (%d bytes) differs from the encoder output (%d bytes); "+
			"regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp",
			utf8RejectPBPath, len(got), len(want))
	}
}

// TestUTF8RejectPerSpanFailClosed is the reference outcome the hosted
// protobuf decoder must reproduce: three rejected spans, one accepted
// sibling, no request-level failure.
func TestUTF8RejectPerSpanFailClosed(t *testing.T) {
	req, err := DecodeExportRequest(readUTF8RejectPB(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	res, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if len(res.SpanErrors) != 3 {
		t.Fatalf("span errors = %d, want 3: %v", len(res.SpanErrors), res.SpanErrors)
	}
	rejected := map[string]string{}
	for _, se := range res.SpanErrors {
		rejected[se.SpanID] = se.Err.Error()
	}
	for spanID, want := range map[string]string{
		"1111111111111111": "span name is not valid UTF-8",
		"2222222222222222": "attribute string is not valid UTF-8",
		"3333333333333333": "invalid attribute key",
	} {
		got, ok := rejected[spanID]
		if !ok {
			t.Fatalf("span %s was accepted; want rejected (%s)", spanID, want)
		}
		if !strings.Contains(got, want) {
			t.Fatalf("span %s rejected with %q, want it to mention %q", spanID, got, want)
		}
	}
	// The clean sibling still converts: started + completed + trace pair +
	// session.started.
	if len(res.Events) != 5 {
		t.Fatalf("event count = %d, want 5", len(res.Events))
	}
	for _, ev := range res.Events {
		if ev.Kind != "span.started" {
			continue
		}
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		if p["source_span_id"] != "4444444444444444" {
			t.Fatalf("converted span = %#v, want only the clean sibling", p)
		}
	}
}
