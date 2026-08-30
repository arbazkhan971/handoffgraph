package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// The tests in this file drive Normalize with realistic Claude Code hook
// payloads (stdin JSON) and print-mode stream-json lines. Every case
// asserts the canonical kind, provider, provenance and the mapped payload
// essentials; the fixture-shaped cases additionally assert event-id
// determinism across calls.

const (
	sessID    = "9f3c1a7e-0d2b-4c8e-9a1f-5b6c7d8e9f0a"
	sessTime  = "2026-08-21T13:00:03Z"
	otherTime = "2026-08-21T13:05:00Z"
)

// hookPayload builds a hook payload with the common fields.
func hookPayload(hookEvent string, extra string) string {
	return fmt.Sprintf(`{"session_id":%q,"timestamp":%q,"hook_event_name":%q,%s}`,
		sessID, sessTime, hookEvent, strings.TrimSuffix(extra, ","))
}

func mustNormalize(t *testing.T, raw string) []protocol.Event {
	t.Helper()
	evs, err := New().Normalize(context.Background(), json.RawMessage(raw))
	if err != nil {
		t.Fatalf("Normalize(%s): %v", raw, err)
	}
	return evs
}

func TestNormalizeHookPayloads(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantKinds []protocol.EventKind
		check     func(t *testing.T, evs []protocol.Event)
	}{
		{
			name:      "session start",
			raw:       hookPayload("SessionStart", `"source":"startup","cwd":"/repo","model":"claude-opus-4-1"`),
			wantKinds: []protocol.EventKind{protocol.EventSessionStarted},
			check: func(t *testing.T, evs []protocol.Event) {
				if evs[0].NativeSessionID != sessID {
					t.Errorf("NativeSessionID = %q", evs[0].NativeSessionID)
				}
				if evs[0].OccurredAt.Format(time.RFC3339) != sessTime {
					t.Errorf("OccurredAt = %v", evs[0].OccurredAt)
				}
				assertPayload(t, evs[0], "source", "startup")
				if evs[0].Model != "claude-opus-4-1" {
					t.Errorf("Model = %q", evs[0].Model)
				}
			},
		},
		{
			name:      "session start from resume",
			raw:       hookPayload("SessionStart", `"source":"resume"`),
			wantKinds: []protocol.EventKind{protocol.EventSessionResumed},
		},
		{
			name:      "user prompt submit",
			raw:       hookPayload("UserPromptSubmit", `"prompt":"fix the flaky checkout race"`),
			wantKinds: []protocol.EventKind{protocol.EventPromptSubmitted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "message", "fix the flaky checkout race")
			},
		},
		{
			name:      "pre tool use",
			raw:       hookPayload("PreToolUse", `"tool_name":"Bash","tool_input":{"command":"npm test"}`),
			wantKinds: []protocol.EventKind{protocol.EventToolStarted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "tool", "Bash")
			},
		},
		{
			name:      "post tool use success",
			raw:       hookPayload("PostToolUse", `"tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":"ok","exit_code":0}`),
			wantKinds: []protocol.EventKind{protocol.EventToolCompleted},
		},
		{
			name:      "post tool use error member",
			raw:       hookPayload("PostToolUse", `"tool_name":"Bash","tool_response":{"error":"command timed out"}`),
			wantKinds: []protocol.EventKind{protocol.EventToolFailed},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "error", "command timed out")
			},
		},
		{
			name:      "post tool use is_error flag",
			raw:       hookPayload("PostToolUse", `"tool_name":"WebFetch","tool_response":{"is_error":true,"output":"404"}`),
			wantKinds: []protocol.EventKind{protocol.EventToolFailed},
		},
		{
			name:      "post tool use interrupted bash",
			raw:       hookPayload("PostToolUse", `"tool_name":"Bash","tool_response":{"interrupted":true,"exit_code":130}`),
			wantKinds: []protocol.EventKind{protocol.EventToolFailed},
		},
		{
			name:      "post tool use plain string response",
			raw:       hookPayload("PostToolUse", `"tool_name":"Read","tool_response":"file contents here"`),
			wantKinds: []protocol.EventKind{protocol.EventToolCompleted},
		},
		{
			name:      "pre compact",
			raw:       hookPayload("PreCompact", `"trigger":"manual","custom_instructions":"keep the race analysis"`),
			wantKinds: []protocol.EventKind{protocol.EventSessionCompacted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "phase", "pre")
				assertPayload(t, evs[0], "trigger", "manual")
			},
		},
		{
			name:      "post compact auto",
			raw:       hookPayload("PostCompact", `"trigger":"auto"`),
			wantKinds: []protocol.EventKind{protocol.EventSessionCompacted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "phase", "post")
				assertPayload(t, evs[0], "trigger", "auto")
			},
		},
		{
			name:      "stop",
			raw:       hookPayload("Stop", `"stop_hook_active":false`),
			wantKinds: []protocol.EventKind{protocol.EventTraceCompleted},
		},
		{
			name:      "session end",
			raw:       hookPayload("SessionEnd", `"reason":"clear"`),
			wantKinds: []protocol.EventKind{protocol.EventSessionEnded},
		},
		{
			name:      "unknown hook event stays a log",
			raw:       hookPayload("Notification", `"message":"Claude needs permission"`),
			wantKinds: []protocol.EventKind{protocol.EventLogObserved},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "source_kind", "hook:Notification")
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			evs := mustNormalize(t, string(tc.raw))
			if len(evs) != len(tc.wantKinds) {
				t.Fatalf("events = %d, want %d", len(evs), len(tc.wantKinds))
			}
			for i, want := range tc.wantKinds {
				if evs[i].Kind != want {
					t.Errorf("ev[%d].Kind = %q, want %q", i, evs[i].Kind, want)
				}
				if evs[i].Provider != protocol.ProviderClaude {
					t.Errorf("ev[%d].Provider = %q, want claude", i, evs[i].Provider)
				}
				if evs[i].Provenance != protocol.ProvenanceObserved {
					t.Errorf("ev[%d].Provenance = %q, want OBSERVED", i, evs[i].Provenance)
				}
				if evs[i].EventID == "" {
					t.Errorf("ev[%d].EventID empty", i)
				}
				if evs[i].SchemaVersion != protocol.SchemaVersionEvent {
					t.Errorf("ev[%d].SchemaVersion = %q", i, evs[i].SchemaVersion)
				}
			}
			if tc.check != nil {
				tc.check(t, evs)
			}
		})
	}
}

func TestNormalizeStreamLines(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantKinds []protocol.EventKind
		check     func(t *testing.T, evs []protocol.Event)
	}{
		{
			name:      "user typed prompt as string content",
			raw:       `{"type":"user","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"role":"user","content":"run the tests"}}`,
			wantKinds: []protocol.EventKind{protocol.EventPromptSubmitted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "message", "run the tests")
			},
		},
		{
			name:      "user tool result success",
			raw:       `{"type":"user","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"exit 0"}]}}`,
			wantKinds: []protocol.EventKind{protocol.EventToolCompleted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "tool_use_id", "toolu_01")
			},
		},
		{
			name:      "user tool result error",
			raw:       `{"type":"user","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"exit 1","is_error":true}]}}`,
			wantKinds: []protocol.EventKind{protocol.EventToolFailed},
		},
		{
			name:      "user message with multiple tool results",
			raw:       `{"type":"user","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"1"},{"type":"tool_result","tool_use_id":"b","content":"boom","is_error":true}]}}`,
			wantKinds: []protocol.EventKind{protocol.EventToolCompleted, protocol.EventToolFailed},
		},
		{
			name:      "assistant text and tool use",
			raw:       `{"type":"assistant","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"editing the checkout module"},{"type":"tool_use","id":"toolu_03","name":"Edit","input":{"file_path":"src/checkout.ts"}}]}}`,
			wantKinds: []protocol.EventKind{protocol.EventAssistantCompleted, protocol.EventToolStarted},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "message", "editing the checkout module")
				if evs[0].Model != "claude-sonnet-4-5" {
					t.Errorf("Model = %q, want claude-sonnet-4-5", evs[0].Model)
				}
				assertPayload(t, evs[1], "tool", "Edit")
				assertPayload(t, evs[1], "tool_use_id", "toolu_03")
			},
		},
		{
			name:      "assistant thinking block skipped",
			raw:       `{"type":"assistant","session_id":"` + sessID + `","timestamp":"` + sessTime + `","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"done"}]}}`,
			wantKinds: []protocol.EventKind{protocol.EventAssistantCompleted},
		},
		{
			name:      "system line",
			raw:       `{"type":"system","subtype":"init","session_id":"` + sessID + `","timestamp":"` + sessTime + `","content":"Session started"}`,
			wantKinds: []protocol.EventKind{protocol.EventLogObserved},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "subtype", "init")
				assertPayload(t, evs[0], "source_kind", "stream:system")
			},
		},
		{
			name:      "result line ends session",
			raw:       `{"type":"result","subtype":"success","session_id":"` + sessID + `","timestamp":"` + otherTime + `","result":"tests fixed","is_error":false}`,
			wantKinds: []protocol.EventKind{protocol.EventSessionEnded},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "subtype", "success")
			},
		},
		{
			name:      "unknown stream type stays a log",
			raw:       `{"type":"future_thing","session_id":"` + sessID + `","timestamp":"` + sessTime + `","payload":1}`,
			wantKinds: []protocol.EventKind{protocol.EventLogObserved},
			check: func(t *testing.T, evs []protocol.Event) {
				assertPayload(t, evs[0], "source_kind", "stream:future_thing")
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			evs := mustNormalize(t, tc.raw)
			if len(evs) != len(tc.wantKinds) {
				t.Fatalf("events = %d, want %d (%+v)", len(evs), len(tc.wantKinds), evs)
			}
			for i, want := range tc.wantKinds {
				if evs[i].Kind != want {
					t.Errorf("ev[%d].Kind = %q, want %q", i, evs[i].Kind, want)
				}
				if evs[i].Provider != protocol.ProviderClaude {
					t.Errorf("ev[%d].Provider = %q, want claude", i, evs[i].Provider)
				}
			}
			if tc.check != nil {
				tc.check(t, evs)
			}
		})
	}
}

func TestNormalizePreservesUnknownFields(t *testing.T) {
	evs := mustNormalize(t, hookPayload("PreToolUse", `"tool_name":"Bash","tool_input":{},"cwd":"/repo","transcript_path":"/~/.claude/projects/x.jsonl","permission_mode":"default"`))
	ev := evs[0]
	for _, key := range []string{"cwd", "transcript_path", "permission_mode"} {
		if _, ok := ev.Unknown[key]; !ok {
			t.Errorf("Unknown[%q] lost; got %+v", key, ev.Unknown)
		}
	}
	// Consumed fields must not leak into Unknown.
	for _, key := range []string{"session_id", "timestamp", "hook_event_name", "tool_name", "tool_input"} {
		if _, ok := ev.Unknown[key]; ok {
			t.Errorf("Unknown[%q] should have been consumed by the mapping", key)
		}
	}
	// Round-trip: unknown fields survive a marshal/unmarshal cycle.
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var back protocol.Event
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if _, ok := back.Unknown["cwd"]; !ok {
		t.Error("unknown fields lost on round-trip")
	}
}

func TestNormalizeUnknownHookPreservesAllNonEnvelopeEvidence(t *testing.T) {
	raw := `{"hook_event_name":"FutureEvent","session_id":"s","prompt":"must-keep","tool_input":{"x":1}}`
	events := mustNormalize(t, raw)
	if len(events) != 1 || events[0].Kind != protocol.EventLogObserved {
		t.Fatalf("events = %+v, want one log.observed", events)
	}
	if got := string(events[0].Unknown["prompt"]); got != `"must-keep"` {
		t.Errorf("Unknown[prompt] = %s", got)
	}
	if got := string(events[0].Unknown["tool_input"]); got != `{"x":1}` {
		t.Errorf("Unknown[tool_input] = %s", got)
	}
}

func TestNormalizeMalformedKnownFieldIsPreservedInsteadOfDiscarded(t *testing.T) {
	raw := `{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":{"future":"shape"}}`
	events := mustNormalize(t, raw)
	if got := string(events[0].Unknown["prompt"]); got != `{"future":"shape"}` {
		t.Fatalf("malformed prompt evidence = %s", got)
	}
}

func TestNormalizeRejectsMalformedPresentHookMetadata(t *testing.T) {
	for _, raw := range []string{
		`{"hook_event_name":null,"session_id":"s"}`,
		`{"hook_event_name":123,"session_id":"s"}`,
		`{"hook_event_name":"SessionStart","session_id":"s","timestamp":"not-a-time"}`,
		`{"hook_event_name":"SessionStart","session_id":"s","timestamp":123}`,
	} {
		if _, err := New().Normalize(context.Background(), json.RawMessage(raw)); err == nil {
			t.Errorf("Normalize(%s) succeeded", raw)
		}
	}
}

func TestNormalizeDeterministicIDs(t *testing.T) {
	raw := hookPayload("UserPromptSubmit", `"prompt":"identical prompt"`)
	first := mustNormalize(t, string(raw))
	second := mustNormalize(t, string(raw))
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("expected one event each")
	}
	if first[0].EventID != second[0].EventID {
		t.Errorf("event id not deterministic: %s vs %s", first[0].EventID, second[0].EventID)
	}
	if first[0].ContentHash != second[0].ContentHash {
		t.Error("content hash not deterministic")
	}
	if first[0].EventID == second[0].EventID && first[0].EventID == "" {
		t.Fatal("empty event id")
	}
}

func TestNormalizeUnidentifiedPayloadsGetFreshIDs(t *testing.T) {
	// No session id and no timestamp: deterministic derivation would risk
	// cross-session collisions, so each normalization yields fresh ids.
	raw := `{"hook_event_name":"UserPromptSubmit","prompt":"x"}`
	first := mustNormalize(t, raw)
	second := mustNormalize(t, raw)
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("expected one event each")
	}
	if first[0].EventID == second[0].EventID {
		t.Error("unidentified payload produced identical event ids; collision risk")
	}
	if first[0].NativeSessionID != "" {
		t.Errorf("NativeSessionID = %q, want empty", first[0].NativeSessionID)
	}
}

func TestNormalizeSequencePerPayload(t *testing.T) {
	// One assistant line expanding to two events: sequences are 1, 2 within
	// the expansion.
	evs := mustNormalize(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`)
	if len(evs) != 2 {
		t.Fatalf("events = %d, want 2", len(evs))
	}
	if evs[0].Sequence != 1 || evs[1].Sequence != 2 {
		t.Errorf("sequences = %d,%d, want 1,2", evs[0].Sequence, evs[1].Sequence)
	}
}

func TestNormalizeErrors(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"empty payload", ``},
		{"invalid utf-8", string([]byte{0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d})},
		{"not json", `nope`},
		{"json array", `[1,2,3]`},
		{"json scalar", `"hello"`},
		{"json null", `null`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New().Normalize(context.Background(), json.RawMessage(tc.raw))
			if err == nil {
				t.Fatalf("Normalize(%q) = nil error, want error", tc.raw)
			}
		})
	}
}

func TestNormalizeContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New().Normalize(ctx, json.RawMessage(`{"type":"system"}`)); err == nil {
		t.Fatal("Normalize with canceled context = nil error, want context error")
	}
}

func TestNormalizeTruncatesOversizedText(t *testing.T) {
	for _, tt := range []struct {
		name string
		text string
	}{
		{name: "ASCII", text: strings.Repeat("x", 10*maxInlineText)},
		{name: "multibyte", text: strings.Repeat("🙂", 2*maxInlineText)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			evs := mustNormalize(t, hookPayload("UserPromptSubmit", fmt.Sprintf(`"prompt":%q`, tt.text)))
			msg, _ := payloadField(evs[0], "message").(string)
			if len(msg) > maxInlineText {
				t.Errorf("message len = %d, want <= %d", len(msg), maxInlineText)
			}
			if !strings.HasSuffix(msg, truncationMarker) {
				t.Errorf("message suffix = %q, want explicit truncation marker", msg[len(msg)-len(truncationMarker):])
			}
			if !utf8.ValidString(msg) {
				t.Error("truncated message is not valid UTF-8")
			}
		})
	}
}

// payloadField decodes one field of an event payload.
func payloadField(ev protocol.Event, key string) any {
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	return m[key]
}

// assertPayload asserts a payload field equals want.
func assertPayload(t *testing.T, ev protocol.Event, key string, want any) {
	t.Helper()
	if got := payloadField(ev, key); got != want {
		t.Errorf("payload[%q] = %v (%T), want %v (%T)", key, got, got, want, want)
	}
}
