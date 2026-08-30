package codex

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestCodexNormalizeCurrentHookPayloads(t *testing.T) {
	tests := []struct {
		name     string
		payload  string
		wantKind protocol.EventKind
	}{
		{"session start", `{"hook_event_name":"SessionStart","session_id":"s1","source":"startup","model":"gpt-5.4","cwd":"/repo"}`, protocol.EventSessionStarted},
		{"session resume", `{"hook_event_name":"SessionStart","session_id":"s1","source":"resume","model":"gpt-5.4"}`, protocol.EventSessionResumed},
		{"prompt", `{"hook_event_name":"UserPromptSubmit","session_id":"s1","turn_id":"t1","prompt":"fix it"}`, protocol.EventPromptSubmitted},
		{"pre tool", `{"hook_event_name":"PreToolUse","session_id":"s1","turn_id":"t1","tool_name":"exec_command","tool_use_id":"call1","tool_input":{"cmd":"go test ./..."}}`, protocol.EventToolStarted},
		{"post tool", `{"hook_event_name":"PostToolUse","session_id":"s1","turn_id":"t1","tool_name":"exec_command","tool_use_id":"call1","tool_input":{"cmd":"go test ./..."},"tool_response":{"exit_code":0}}`, protocol.EventToolCompleted},
		{"failed tool", `{"hook_event_name":"PostToolUse","session_id":"s1","turn_id":"t1","tool_name":"exec_command","tool_use_id":"call2","tool_input":{},"tool_response":{"is_error":true,"error":"boom"}}`, protocol.EventToolFailed},
		{"pre compact", `{"hook_event_name":"PreCompact","session_id":"s1","turn_id":"t1","trigger":"auto"}`, protocol.EventSessionCompacted},
		{"post compact", `{"hook_event_name":"PostCompact","session_id":"s1","turn_id":"t1","trigger":"auto"}`, protocol.EventSessionCompacted},
		{"stop is turn completion", `{"hook_event_name":"Stop","session_id":"s1","turn_id":"t1","stop_hook_active":false,"last_assistant_message":"done"}`, protocol.EventTraceCompleted},
		{"permission stays evidence", `{"hook_event_name":"PermissionRequest","session_id":"s1","turn_id":"t1","tool_name":"exec_command","tool_input":{}}`, protocol.EventLogObserved},
		{"subagent start stays evidence", `{"hook_event_name":"SubagentStart","session_id":"s1","turn_id":"t1","agent_id":"a1"}`, protocol.EventLogObserved},
		{"subagent stop stays evidence", `{"hook_event_name":"SubagentStop","session_id":"s1","turn_id":"t1","agent_id":"a1"}`, protocol.EventLogObserved},
		{"future session end tolerated", `{"hook_event_name":"SessionEnd","session_id":"s1","reason":"logout"}`, protocol.EventSessionEnded},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			events, err := New().Normalize(context.Background(), json.RawMessage(tc.payload))
			if err != nil {
				t.Fatalf("Normalize: %v", err)
			}
			if len(events) != 1 || events[0].Kind != tc.wantKind {
				t.Fatalf("events = %+v, want one %s", events, tc.wantKind)
			}
			if events[0].NativeSessionID != "s1" || events[0].Provider != protocol.ProviderCodex {
				t.Errorf("identity = provider %q native %q", events[0].Provider, events[0].NativeSessionID)
			}
			if !events[0].OccurredAt.IsZero() || !events[0].ObservedAt.IsZero() {
				t.Errorf("timestamp-free hook was assigned fabricated times: %+v", events[0])
			}
		})
	}
}

func TestCodexNormalizeCurrentHookPreservesModelOnEveryEvent(t *testing.T) {
	raw := json.RawMessage(`{"hook_event_name":"PreToolUse","session_id":"s1","turn_id":"t1","model":"gpt-5.4","tool_name":"exec_command","tool_input":{"cmd":"go test ./..."},"tool_use_id":"call-1"}`)
	events, err := New().Normalize(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want one", len(events))
	}
	if events[0].Model != "gpt-5.4" {
		t.Fatalf("normalized model = %q, want gpt-5.4", events[0].Model)
	}
}

func TestCodexNormalizeStopPreservesNullVersusEmptyAssistantMessage(t *testing.T) {
	values := []struct {
		name string
		raw  string
		want any
	}{
		{name: "null", raw: "null", want: nil},
		{name: "empty", raw: `""`, want: ""},
	}
	ids := make(map[string]bool)
	for _, tc := range values {
		t.Run(tc.name, func(t *testing.T) {
			raw := json.RawMessage(`{"hook_event_name":"Stop","session_id":"s1","turn_id":"t1","stop_hook_active":false,"last_assistant_message":` + tc.raw + `}`)
			events, err := New().Normalize(context.Background(), raw)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if got := payload["last_assistant_message"]; got != tc.want {
				t.Fatalf("last_assistant_message = %#v, want %#v", got, tc.want)
			}
			if _, present := events[0].Unknown["last_assistant_message"]; present {
				t.Fatal("losslessly represented assistant message was duplicated in Unknown")
			}
			ids[events[0].EventID] = true
		})
	}
	if len(ids) != 2 {
		t.Fatal("null and empty assistant messages collapsed to one evidence identity")
	}
}

func TestCodexNormalizePreservesRawTextWhenCanonicalPayloadTruncates(t *testing.T) {
	long := strings.Repeat("evidence-", rolloutMaxText)
	tests := []struct {
		name       string
		hook       string
		field      string
		payloadKey string
		extra      map[string]any
	}{
		{
			name: "prompt", hook: "UserPromptSubmit", field: "prompt", payloadKey: "message",
			extra: map[string]any{"turn_id": "t1"},
		},
		{
			name: "assistant message", hook: "Stop", field: "last_assistant_message", payloadKey: "last_assistant_message",
			extra: map[string]any{"turn_id": "t1", "stop_hook_active": false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			native := map[string]any{
				"hook_event_name": tc.hook,
				"session_id":      "s1",
				tc.field:          long,
			}
			for key, value := range tc.extra {
				native[key] = value
			}
			raw, err := json.Marshal(native)
			if err != nil {
				t.Fatal(err)
			}
			events, err := New().Normalize(context.Background(), raw)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if got, _ := payload[tc.payloadKey].(string); got == long || got != truncateText(long, rolloutMaxText) {
				t.Fatalf("canonical %s was not deterministically truncated", tc.payloadKey)
			}
			var preserved string
			if err := json.Unmarshal(events[0].Unknown[tc.field], &preserved); err != nil {
				t.Fatalf("raw %s not preserved in Unknown: %v", tc.field, err)
			}
			if preserved != long {
				t.Fatalf("raw %s changed during preservation", tc.field)
			}
		})
	}
}

func TestCodexNormalizeCurrentHookIsImmutableAndRawSensitive(t *testing.T) {
	firstRaw := json.RawMessage(`{"hook_event_name":"PreToolUse","session_id":"s1","turn_id":"t1","tool_name":"shell","tool_use_id":"u1","tool_input":{},"future":{"revision":1}}`)
	first, err := New().Normalize(context.Background(), firstRaw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New().Normalize(context.Background(), firstRaw)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("exact hook retry changed immutable envelope:\nfirst=%+v\nsecond=%+v", first, second)
	}

	changed, err := New().Normalize(context.Background(), json.RawMessage(`{"hook_event_name":"PreToolUse","session_id":"s1","turn_id":"t1","tool_name":"shell","tool_use_id":"u1","tool_input":{},"future":{"revision":2}}`))
	if err != nil {
		t.Fatal(err)
	}
	if changed[0].EventID == first[0].EventID {
		t.Errorf("changed unknown native evidence reused event id %s", first[0].EventID)
	}
	if _, ok := first[0].Unknown["future"]; !ok {
		t.Fatalf("future field was not preserved: %+v", first[0].Unknown)
	}
}

func TestCodexNormalizeCurrentDialectTakesPrecedence(t *testing.T) {
	events, err := New().Normalize(context.Background(), json.RawMessage(`{"hook_event_name":"Stop","type":"session.start","session_id":"s1","turn_id":"t1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if events[0].Kind != protocol.EventTraceCompleted {
		t.Errorf("kind = %s, want current Stop mapping to win", events[0].Kind)
	}
}

// The tests in this file pin the hook-payload Normalize contract: the
// documented payload → kind mapping, deterministic event ids (re-delivery
// of the same payload is idempotent), and unknown-field preservation.

func TestCodexNormalizeHookPayloadsTableDriven(t *testing.T) {
	exit0 := 0
	cases := []struct {
		name         string
		payload      string
		wantKind     protocol.EventKind
		checkPayload func(t *testing.T, ev protocol.Event)
	}{
		{
			name:     "session start",
			payload:  `{"type":"session.start","session_id":"s1","model":"gpt-5-codex"}`,
			wantKind: protocol.EventSessionStarted,
		},
		{
			name:     "session end",
			payload:  `{"type":"session.end","session_id":"s1"}`,
			wantKind: protocol.EventSessionEnded,
		},
		{
			name:     "tool pre",
			payload:  `{"type":"tool.pre","session_id":"s1","tool_name":"shell","tool_use_id":"tu1","turn_id":"t1","tool_input":{"command":["go","test","./..."]}}`,
			wantKind: protocol.EventToolStarted,
			checkPayload: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatalf("payload: %v", err)
				}
				if p["tool_name"] != "shell" || p["tool_use_id"] != "tu1" || p["turn_id"] != "t1" {
					t.Errorf("payload = %v, want shell/tu1/t1", p)
				}
				input, ok := p["tool_input"].(map[string]any)
				if !ok {
					t.Errorf("payload tool_input = %v, want preserved object", p["tool_input"])
				} else if _, ok := input["command"]; !ok {
					t.Errorf("tool_input.command lost: %v", input)
				}
			},
		},
		{
			name:     "tool post",
			payload:  `{"type":"tool.post","session_id":"s1","tool_name":"shell","tool_use_id":"tu1","turn_id":"t1","exit_code":0}`,
			wantKind: protocol.EventToolCompleted,
			checkPayload: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatalf("payload: %v", err)
				}
				if p["exit_code"] != float64(exit0) {
					t.Errorf("exit_code = %v, want 0", p["exit_code"])
				}
			},
		},
		{
			name:     "turn start",
			payload:  `{"type":"turn.start","session_id":"s1","turn_id":"t1"}`,
			wantKind: protocol.EventTraceStarted,
			checkPayload: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatalf("payload: %v", err)
				}
				if p["trace_id"] != "t1" {
					t.Errorf("trace_id = %v, want t1", p["trace_id"])
				}
			},
		},
		{
			name:     "turn end",
			payload:  `{"type":"turn.end","session_id":"s1","turn_id":"t1"}`,
			wantKind: protocol.EventTraceCompleted,
		},
		{
			name:     "unknown type stays evidence",
			payload:  `{"type":"future.hook","session_id":"s1","nifty":{"x":1}}`,
			wantKind: protocol.EventLogObserved,
			checkPayload: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatalf("payload: %v", err)
				}
				if p["type"] != "future.hook" {
					t.Errorf("payload type = %v, want future.hook", p["type"])
				}
			},
		},
	}
	c := New()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			events, err := c.Normalize(context.Background(), json.RawMessage(tc.payload))
			if err != nil {
				t.Fatalf("normalize: %v", err)
			}
			if len(events) != 1 {
				t.Fatalf("len(events) = %d, want 1", len(events))
			}
			ev := events[0]
			if ev.Kind != tc.wantKind {
				t.Errorf("kind = %s, want %s", ev.Kind, tc.wantKind)
			}
			if ev.Provider != protocol.ProviderCodex {
				t.Errorf("provider = %s, want codex", ev.Provider)
			}
			if ev.NativeSessionID != "s1" {
				t.Errorf("native_session_id = %s, want s1", ev.NativeSessionID)
			}
			if ev.Provenance != protocol.ProvenanceObserved {
				t.Errorf("provenance = %s, want OBSERVED", ev.Provenance)
			}
			if !strings.HasPrefix(ev.EventID, "evt_") {
				t.Errorf("event id = %s, want evt_ prefix", ev.EventID)
			}
			if ev.ContentHash == "" {
				t.Error("content hash missing")
			}
			if tc.checkPayload != nil {
				tc.checkPayload(t, ev)
			}
		})
	}
}

func TestCodexNormalizeHookIDsDeterministicAcrossCalls(t *testing.T) {
	c := New()
	payload := json.RawMessage(`{"type":"tool.pre","session_id":"s1","tool_name":"shell","tool_use_id":"tu1"}`)
	first, err := c.Normalize(context.Background(), payload)
	if err != nil {
		t.Fatalf("first normalize: %v", err)
	}
	second, err := c.Normalize(context.Background(), payload)
	if err != nil {
		t.Fatalf("second normalize: %v", err)
	}
	// Observation time is honestly "now" per delivery, so only the
	// identity-bearing fields must be identical for re-import idempotency.
	a, b := first[0], second[0]
	if a.EventID != b.EventID {
		t.Errorf("event id unstable across deliveries: %s vs %s", a.EventID, b.EventID)
	}
	if a.ContentHash != b.ContentHash || string(a.Payload) != string(b.Payload) || a.Kind != b.Kind {
		t.Errorf("derived content drifted:\n%+v\n%+v", a, b)
	}
}

func TestCodexNormalizeHookUnidentifiablePayloadGetsFreshID(t *testing.T) {
	// A payload without a session id cannot be scoped: two deliveries must
	// not collide on one event id and silently drop evidence.
	c := New()
	payload := json.RawMessage(`{"type":"session.end"}`)
	first, err := c.Normalize(context.Background(), payload)
	if err != nil {
		t.Fatalf("first normalize: %v", err)
	}
	second, err := c.Normalize(context.Background(), payload)
	if err != nil {
		t.Fatalf("second normalize: %v", err)
	}
	if first[0].EventID == second[0].EventID {
		t.Errorf("unidentifiable payload reused event id %s", first[0].EventID)
	}
}

func TestCodexNormalizeHookPreservesUnknownFields(t *testing.T) {
	c := New()
	payload := json.RawMessage(`{"type":"session.start","session_id":"s1","model":"m","future_field":{"note":"keep me"}}`)
	events, err := c.Normalize(context.Background(), payload)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	raw, ok := events[0].Unknown["future_field"]
	if !ok {
		t.Fatalf("unknown field dropped: %+v", events[0].Unknown)
	}
	var note struct {
		Note string `json:"note"`
	}
	if err := json.Unmarshal(raw, &note); err != nil || note.Note != "keep me" {
		t.Errorf("unknown field corrupted: %s (%v)", raw, err)
	}
}

func TestCodexNormalizeHookRejectsInvalidJSON(t *testing.T) {
	c := New()
	if _, err := c.Normalize(context.Background(), json.RawMessage(`{"type":`)); err == nil {
		t.Fatal("invalid JSON accepted, want error")
	}
	if _, err := c.Normalize(context.Background(), json.RawMessage(`null`)); err == nil {
		t.Fatal("JSON null accepted, want object error")
	}
	if _, err := c.Normalize(context.Background(), json.RawMessage(`{"hook_event_name":"Stop","session_id":"s1","timestamp":"not-a-time"}`)); err == nil {
		t.Fatal("malformed declared timestamp accepted")
	}
}

func TestCodexNormalizeHookRespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New().Normalize(ctx, json.RawMessage(`{"type":"session.end","session_id":"s1"}`)); err == nil {
		t.Fatal("cancelled context accepted, want error")
	}
}
