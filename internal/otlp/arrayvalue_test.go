package otlp

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// ArrayValue's repeated field is named "values" in the OTLP proto, so that is
// what proto3-JSON emitters write and what the protobuf decoder reads. This
// decoder historically read "elements", which meant a spec-correct JSON
// emitter silently produced an EMPTY array while the identical telemetry sent
// as protobuf produced the real one — a cross-flavor divergence in derived
// payloads. These tests pin the fix: both spellings decode, "values" wins, and
// the two wire flavors of one fixture convert to byte-identical events.

const arrayFixtureJSONPath = "../../testdata/fixtures/otlp/array_values.json"
const arrayFixturePBPath = "../../testdata/fixtures/otlp/array_values.pb"

// --- fixture encoder (independent of the decoder, like proto_test.go) -------

// pbAnyString / pbAnyInt / pbAnyArray build common.v1.AnyValue bodies.
func pbAnyString(s string) []byte { return protoAppendString(nil, 1, s) }

func pbAnyInt(v int64) []byte { return protoAppendVarintField(nil, 3, uint64(v)) }

// pbAnyArray wraps element AnyValue bodies in AnyValue.array_value (field 5)
// -> ArrayValue.values (field 1), the shape the proto defines.
func pbAnyArray(elements ...[]byte) []byte {
	var arr []byte
	for _, e := range elements {
		arr = protoAppendLenDelim(arr, 1, e)
	}
	return protoAppendLenDelim(nil, 5, arr)
}

// arrayValuesFixture mirrors testdata/fixtures/otlp/array_values.json.
func arrayValuesFixture() pbFixture {
	return pbFixture{
		resource: []pbAttr{
			{key: "service.name", str: "array-harness"},
			{key: "deployment.environment", str: "ci"},
		},
		scopeName:    "github.com/handoffgraph/agent-instrumentation",
		scopeVersion: "0.3.0",
		spans: []pbSpan{
			{
				traceID: "9f3c1d5b70a24e8ab6c0d1e2f3a4b5c6", spanID: "1a2b3c4d5e6f7081",
				name: "execute_tool run_tests", kind: 1,
				startNS: 1787918400000000000, endNS: 1787918402000000000,
				statusOK: 1,
				attrs: []pbAttr{
					{key: "gen_ai.tool.name", str: "run_tests"},
					{key: "tool.files", anyValue: pbAnyArray(
						pbAnyString("cmd/main.go"),
						pbAnyString("internal/otlp/types.go"),
					)},
					{key: "tool.exit_codes", anyValue: pbAnyArray(pbAnyInt(0), pbAnyInt(2))},
					{key: "tool.matrix", anyValue: pbAnyArray(
						pbAnyArray(pbAnyString("unit"), pbAnyString("race")),
					)},
				},
			},
		},
	}
}

func readArrayPBFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(arrayFixturePBPath)
	if err != nil {
		t.Fatalf("read array protobuf fixture: %v", err)
	}
	return data
}

func loadArrayJSONFixture(t *testing.T) *ExportRequest {
	t.Helper()
	data, err := os.ReadFile(arrayFixtureJSONPath)
	if err != nil {
		t.Fatalf("read array json fixture: %v", err)
	}
	var req ExportRequest
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatalf("unmarshal array json fixture: %v", err)
	}
	return &req
}

// TestArrayFixtureIsGolden pins the committed .pb to the independent encoder.
// Regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp.
func TestArrayFixtureIsGolden(t *testing.T) {
	want := arrayValuesFixture().encode(t)
	if os.Getenv("HFG_UPDATE_OTLP_FIXTURE") == "1" {
		if err := os.WriteFile(arrayFixturePBPath, want, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}
	if got := readArrayPBFixture(t); !bytes.Equal(got, want) {
		t.Fatalf("committed %s (%d bytes) differs from the encoder output (%d bytes); "+
			"regenerate with HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp",
			arrayFixturePBPath, len(got), len(want))
	}
}

// TestArrayValueSurvivesJSONFlavor is the regression proper: the JSON flavor
// must carry the array through to the event payload, not an empty list.
func TestArrayValueSurvivesJSONFlavor(t *testing.T) {
	res, err := Convert(loadArrayJSONFixture(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(json): %v", err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}

	files := arrayAttrFromEvents(t, res, "tool.files")
	if want := []any{"cmd/main.go", "internal/otlp/types.go"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("tool.files = %#v, want %#v", files, want)
	}
	codes := arrayAttrFromEvents(t, res, "tool.exit_codes")
	if want := []any{float64(0), float64(2)}; !reflect.DeepEqual(codes, want) {
		t.Fatalf("tool.exit_codes = %#v, want %#v", codes, want)
	}
	matrix := arrayAttrFromEvents(t, res, "tool.matrix")
	if want := []any{[]any{"unit", "race"}}; !reflect.DeepEqual(matrix, want) {
		t.Fatalf("tool.matrix = %#v, want %#v", matrix, want)
	}
}

// arrayAttrFromEvents finds one attribute in the converted event stream by
// round-tripping the events through JSON, which is how they reach storage.
func arrayAttrFromEvents(t *testing.T, res *Result, key string) any {
	t.Helper()
	for _, ev := range res.Events {
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatal(err)
		}
		if found, ok := findAttrValue(decoded, key); ok {
			return found
		}
	}
	t.Fatalf("attribute %q not found in any converted event", key)
	return nil
}

func findAttrValue(node any, key string) (any, bool) {
	switch typed := node.(type) {
	case map[string]any:
		for k, v := range typed {
			if k == key {
				return v, true
			}
			if found, ok := findAttrValue(v, key); ok {
				return found, true
			}
		}
	case []any:
		for _, v := range typed {
			if found, ok := findAttrValue(v, key); ok {
				return found, true
			}
		}
	}
	return nil, false
}

// TestArrayFixtureCrossFlavorParity is the headline: the same array-bearing
// telemetry, sent as protobuf and as spec-correct proto3 JSON, produces
// identical events — same ids, same payloads, same order.
func TestArrayFixtureCrossFlavorParity(t *testing.T) {
	decoded, err := DecodeExportRequest(readArrayPBFixture(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	pb, err := Convert(decoded, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(protobuf): %v", err)
	}
	js, err := Convert(loadArrayJSONFixture(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert(json): %v", err)
	}

	if len(pb.SpanErrors) != 0 || len(js.SpanErrors) != 0 {
		t.Fatalf("span errors: protobuf %v / json %v", pb.SpanErrors, js.SpanErrors)
	}
	if len(pb.Events) == 0 || len(pb.Events) != len(js.Events) {
		t.Fatalf("event counts = %d (protobuf) / %d (json)", len(pb.Events), len(js.Events))
	}

	pbIDs := make([]string, len(pb.Events))
	jsIDs := make([]string, len(js.Events))
	for i := range pb.Events {
		pbIDs[i] = pb.Events[i].EventID
		jsIDs[i] = js.Events[i].EventID
	}
	if strings.Join(pbIDs, "\n") != strings.Join(jsIDs, "\n") {
		t.Fatalf("event ids differ across flavors:\nprotobuf: %v\njson:     %v", pbIDs, jsIDs)
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

// TestAnyValueArraySpellings covers the decoder contract directly: the spec
// spelling decodes, the legacy one still decodes, and "values" wins when a
// payload carries both.
func TestAnyValueArraySpellings(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []any
	}{
		{
			name: "spec values",
			raw:  `{"arrayValue":{"values":[{"stringValue":"a"},{"stringValue":"b"}]}}`,
			want: []any{"a", "b"},
		},
		{
			name: "legacy elements",
			raw:  `{"arrayValue":{"elements":[{"stringValue":"a"}]}}`,
			want: []any{"a"},
		},
		{
			name: "values wins over elements",
			raw:  `{"arrayValue":{"elements":[{"stringValue":"legacy"}],"values":[{"stringValue":"spec"}]}}`,
			want: []any{"spec"},
		},
		{
			name: "empty values",
			raw:  `{"arrayValue":{"values":[]}}`,
			want: []any{},
		},
		{
			name: "no members at all",
			raw:  `{"arrayValue":{}}`,
			want: []any{},
		},
		{
			name: "nested arrays recurse",
			raw:  `{"arrayValue":{"values":[{"arrayValue":{"values":[{"intValue":"7"}]}}]}}`,
			want: []any{[]any{int64(7)}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var av AnyValue
			if err := av.UnmarshalJSON([]byte(tt.raw)); err != nil {
				t.Fatalf("UnmarshalJSON(%s): %v", tt.raw, err)
			}
			if got := av.Value(); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Value() = %#v, want %#v", got, tt.want)
			}
		})
	}
}
