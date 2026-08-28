package otlp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Regression suite for three converter defects that only surface on inputs no
// earlier fixture carried:
//
//  1. an attribute-less span under a NAMED instrumentation scope (every OTel
//     SDK names its scope) wrote scope attributes into a nil map and panicked;
//  2. the phase-1 trace-wide session scan resolved precedence by ATTRIBUTE
//     order instead of KEY order, so one logical trace could split across two
//     derived session ids;
//  3. that same scan promoted an UNSANITIZED session key, so a span rejected
//     for an unusable session.id still donated the string to its accepted
//     siblings' native_session_id.
//
// Every existing fixture id stays unchanged: none of them carries an
// attribute-less span, a lower-precedence key ahead of a higher one, or an
// invalid session key.

const hardeningTrace = "5c1d2e3f40516273849506a7b8c9d0e1"

// TestConvertAttributelessSpanUnderNamedScope pins defect (1) on the JSON
// flavor: the span carries no attributes at all, the scope carries a name, and
// the scope attributes must land on the span instead of panicking.
func TestConvertAttributelessSpanUnderNamedScope(t *testing.T) {
	body := `{"resourceSpans":[{"resource":{"attributes":[
		{"key":"service.name","value":{"stringValue":"codex-cli"}}]},
		"scopeSpans":[{"scope":{"name":"io.opentelemetry.sdk","version":"1.42.0"},
		"spans":[{"traceId":"` + hardeningTrace + `","spanId":"1122334455667788",
		"name":"bare span","kind":1,
		"startTimeUnixNano":"1787918400000000000","endTimeUnixNano":"1787918401000000000"}]}]}]}`

	var req ExportRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(req.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes) != 0 {
		t.Fatal("fixture drifted: the span must carry zero attributes")
	}

	res, err := Convert(&req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}
	// started + completed + trace pair + session.started.
	if len(res.Events) != 5 {
		t.Fatalf("event count = %d, want 5", len(res.Events))
	}
	assertScopeAttrs(t, res, "io.opentelemetry.sdk", "1.42.0")
}

// TestConvertAttributelessSpanUnderNamedScopeProtobuf pins defect (1) on the
// protobuf flavor, which reaches the identical converter.
func TestConvertAttributelessSpanUnderNamedScopeProtobuf(t *testing.T) {
	fixture := pbFixture{
		resource:     []pbAttr{{key: "service.name", str: "codex-cli"}},
		scopeName:    "io.opentelemetry.sdk",
		scopeVersion: "1.42.0",
		spans: []pbSpan{{
			traceID: hardeningTrace, spanID: "1122334455667788",
			name: "bare span", kind: 1,
			startNS: 1787918400000000000, endNS: 1787918401000000000,
		}},
	}
	req, err := DecodeExportRequest(fixture.encode(t))
	if err != nil {
		t.Fatalf("DecodeExportRequest: %v", err)
	}
	if len(req.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes) != 0 {
		t.Fatal("fixture drifted: the span must carry zero attributes")
	}
	res, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}
	if len(res.Events) != 5 {
		t.Fatalf("event count = %d, want 5", len(res.Events))
	}
	assertScopeAttrs(t, res, "io.opentelemetry.sdk", "1.42.0")
}

func assertScopeAttrs(t *testing.T, res *Result, name, version string) {
	t.Helper()
	attrs := completedAttributes(t, res)
	if attrs["otlp.scope.name"] != name || attrs["otlp.scope.version"] != version {
		t.Fatalf("scope attributes = %#v, want name %q version %q", attrs, name, version)
	}
}

// completedAttributes returns payload.attributes of the single span.completed
// event, as it reaches storage (through JSON).
func completedAttributes(t *testing.T, res *Result) map[string]any {
	t.Helper()
	for _, ev := range res.Events {
		if ev.Kind != protocol.EventSpanCompleted {
			continue
		}
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		attrs, _ := p["attributes"].(map[string]any)
		return attrs
	}
	t.Fatal("no span.completed event")
	return nil
}

// TestSessionKeyPrecedenceIsByKeyNotAttributeOrder pins defect (2): the root
// span emits gen_ai.conversation.id BEFORE session.id, and a sibling span
// carries no session attribute at all. The sibling inherits the trace-wide key,
// so if the scan honoured emit order the trace would split across two sessions.
func TestSessionKeyPrecedenceIsByKeyNotAttributeOrder(t *testing.T) {
	req := &ExportRequest{ResourceSpans: []ResourceSpans{{
		ScopeSpans: []ScopeSpans{{
			Spans: []Span{
				{
					TraceID: hardeningTrace, SpanID: "1122334455667788",
					Name: "root", Kind: json.RawMessage("1"),
					StartTimeUnixNano: "1787918400000000000", EndTimeUnixNano: "1787918402000000000",
					Attributes: []KeyValue{
						// Deliberately reversed: the LOWER-precedence key first.
						{Key: "gen_ai.conversation.id", Value: &AnyValue{v: "conversation-loses"}},
						{Key: "session.id", Value: &AnyValue{v: "session-wins"}},
					},
				},
				{
					TraceID: hardeningTrace, SpanID: "99aabbccddeeff00",
					ParentSpanID: "1122334455667788",
					Name:         "child with no session attribute", Kind: json.RawMessage("1"),
					StartTimeUnixNano: "1787918400500000000", EndTimeUnixNano: "1787918401000000000",
				},
			},
		}},
	}}}

	res, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("span errors: %v", res.SpanErrors)
	}
	keys := map[string]bool{}
	sessions := map[string]bool{}
	for _, ev := range res.Events {
		keys[ev.NativeSessionID] = true
		sessions[ev.SessionID] = true
	}
	if len(keys) != 1 || !keys["session-wins"] {
		t.Fatalf("native session keys = %v, want exactly {session-wins} (key precedence, not emit order)", keys)
	}
	if len(sessions) != 1 {
		t.Fatalf("one logical trace split across %d derived session ids", len(sessions))
	}
	// The derived id is a pure function of the winning key, so it is stable.
	want := ids.Deterministic(ids.PrefixSession, "otlp|session-wins", 0)
	if got := onlyKey(sessions); got != want {
		t.Fatalf("session id = %s, want %s", got, want)
	}
}

// TestRawSessionKeyIsSanitizedBeforePromotion pins defect (3): the span that
// owns the bad session.id is itself rejected, and its unusable key must not
// escape onto the accepted sibling.
func TestRawSessionKeyIsSanitizedBeforePromotion(t *testing.T) {
	cases := []struct {
		name string
		bad  string
	}{
		{"invalid utf-8", "sess-\xff-broken"},
		{"exceeds the string cap", strings.Repeat("x", maxAttrStringBytes+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := &ExportRequest{ResourceSpans: []ResourceSpans{{
				ScopeSpans: []ScopeSpans{{
					Spans: []Span{
						{
							TraceID: hardeningTrace, SpanID: "1122334455667788",
							Name: "poisoned", Kind: json.RawMessage("1"),
							StartTimeUnixNano: "1787918400000000000", EndTimeUnixNano: "1787918402000000000",
							Attributes: []KeyValue{{Key: "session.id", Value: &AnyValue{v: tc.bad}}},
						},
						{
							TraceID: hardeningTrace, SpanID: "99aabbccddeeff00",
							Name: "clean sibling", Kind: json.RawMessage("1"),
							StartTimeUnixNano: "1787918400500000000", EndTimeUnixNano: "1787918401000000000",
						},
					},
				}},
			}}}

			res, err := Convert(req, Options{ObservedAt: fixedObserved()})
			if err != nil {
				t.Fatalf("Convert: %v", err)
			}
			if len(res.SpanErrors) != 1 {
				t.Fatalf("span errors = %d, want 1 (the poisoned span)", len(res.SpanErrors))
			}
			want := "otlp-trace-" + hardeningTrace
			for _, ev := range res.Events {
				if ev.NativeSessionID != want {
					t.Fatalf("%s: native_session_id = %q, want the derived %q — the rejected span's key escaped",
						ev.EventID, ev.NativeSessionID, want)
				}
			}
			// The clean sibling still converts: started + completed + trace
			// pair + session.started.
			if len(res.Events) != 5 {
				t.Fatalf("event count = %d, want 5", len(res.Events))
			}
		})
	}
}

func onlyKey(m map[string]bool) string {
	for k := range m {
		return k
	}
	return ""
}
