package codex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

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
}

func TestCodexNormalizeHookRespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New().Normalize(ctx, json.RawMessage(`{"type":"session.end","session_id":"s1"}`)); err == nil {
		t.Fatal("cancelled context accepted, want error")
	}
}
