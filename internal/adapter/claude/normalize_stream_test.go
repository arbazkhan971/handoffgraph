package claude

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestNormalizeTranscriptNativeClaudeJSONLDeterministic(t *testing.T) {
	const nativeID = "4be3ac4e-17c9-48e8-ad14-c70f0a9dcb50"
	raw := strings.Join([]string{
		`{"type":"mode","sessionId":"` + nativeID + `","mode":"default"}`,
		`{"type":"user","sessionId":"` + nativeID + `","timestamp":"2026-08-30T10:00:00Z","message":{"role":"user","content":"run tests"}}`,
		`{"type":"assistant","sessionId":"` + nativeID + `","timestamp":"2026-08-30T10:00:01Z","message":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"running"},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"go test ./..."}}]}}`,
		`{"type":"file-history-snapshot","isSnapshotUpdate":true,"snapshot":{"tracked":true}}`,
	}, "\n") + "\n"

	normalize := func() []protocol.Event {
		events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(raw), "filename-fallback")
		if err != nil {
			t.Fatalf("NormalizeTranscript: %v", err)
		}
		return events
	}
	first := normalize()
	second := normalize()
	if len(first) != 5 {
		t.Fatalf("events = %d, want 5", len(first))
	}
	seen := map[string]bool{}
	for i := range first {
		if first[i].NativeSessionID != nativeID {
			t.Errorf("event %d native_session_id = %q", i+1, first[i].NativeSessionID)
		}
		if first[i].Sequence != int64(i+1) {
			t.Errorf("event %d sequence = %d", i+1, first[i].Sequence)
		}
		if first[i].Provider != protocol.ProviderClaude || first[i].Provenance != protocol.ProvenanceObserved {
			t.Errorf("event %d identity/provenance = %s/%s", i+1, first[i].Provider, first[i].Provenance)
		}
		if seen[first[i].EventID] {
			t.Errorf("duplicate event id %s", first[i].EventID)
		}
		seen[first[i].EventID] = true
		if first[i].EventID != second[i].EventID || first[i].ContentHash != second[i].ContentHash {
			t.Errorf("event %d is not deterministic", i+1)
		}
	}
	if !first[0].OccurredAt.IsZero() {
		t.Errorf("untimestamped metadata presented with observed time %s", first[0].OccurredAt)
	}
	if first[0].Kind != protocol.EventLogObserved || first[1].Kind != protocol.EventPromptSubmitted || first[2].Kind != protocol.EventAssistantCompleted || first[3].Kind != protocol.EventToolStarted {
		t.Errorf("kinds = %s, %s, %s, %s", first[0].Kind, first[1].Kind, first[2].Kind, first[3].Kind)
	}
	if _, ok := first[0].Unknown["sessionId"]; !ok {
		t.Error("native camelCase sessionId was not preserved as unknown evidence")
	}
	if _, ok := first[4].Unknown["snapshot"]; !ok {
		t.Error("unknown native snapshot was not preserved")
	}
	changed := strings.Replace(raw, `"mode":"default"`, `"mode":"plan"`, 1)
	changedEvents, err := New().NormalizeTranscript(context.Background(), strings.NewReader(changed), "filename-fallback")
	if err != nil {
		t.Fatal(err)
	}
	if changedEvents[0].ContentHash != first[0].ContentHash {
		t.Error("payload hash unexpectedly includes unknown native fields")
	}
	if changedEvents[0].EventID == first[0].EventID {
		t.Error("changed unknown native evidence reused the same deterministic event id")
	}
}

func TestNormalizeTranscriptFilenameFallbackAndErrors(t *testing.T) {
	events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(
		`{"type":"system","timestamp":"2026-08-30T10:00:00Z","content":"ready"}`+"\n"), "fallback-session")
	if err != nil {
		t.Fatalf("fallback normalize: %v", err)
	}
	if len(events) != 1 || events[0].NativeSessionID != "fallback-session" {
		t.Fatalf("fallback events = %+v", events)
	}

	tests := []struct {
		name string
		raw  string
		id   string
		want string
	}{
		{"empty", "", "x", "no records"},
		{"missing identity", `{"type":"system"}` + "\n", "", "native session id is required"},
		{"mixed ids", `{"type":"system","sessionId":"b"}` + "\n" + `{"type":"system","session_id":"a"}` + "\n", "", "a, b"},
		{"conflicting aliases", `{"type":"system","sessionId":"a","session_id":"b"}` + "\n", "", "conflicts"},
		{"numeric snake identity", `{"type":"system","session_id":42}` + "\n", "fallback", "line 1: field session_id"},
		{"object camel identity", `{"type":"system","sessionId":{"id":"a"}}` + "\n", "fallback", "line 1: field sessionId"},
		{"null camel identity", `{"type":"system","sessionId":null}` + "\n", "fallback", "line 1: field sessionId"},
		{"empty explicit identity", `{"type":"system","sessionId":""}` + "\n", "fallback", "line 1: field sessionId"},
		{"invalid timestamp", `{"type":"system","sessionId":"a","timestamp":"not-a-time"}` + "\n", "", "line 1: timestamp is not valid RFC3339"},
		{"numeric timestamp", `{"type":"system","sessionId":"a","timestamp":123}` + "\n", "", "line 1: field timestamp"},
		{"null timestamp", `{"type":"system","sessionId":"a","timestamp":null}` + "\n", "", "line 1: field timestamp"},
		{"malformed second line", `{"type":"system","sessionId":"a"}` + "\nnot-json\n", "", "line 2"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New().NormalizeTranscript(context.Background(), strings.NewReader(tc.raw), tc.id)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}

	if _, err := New().NormalizeTranscript(context.Background(), nil, "x"); err == nil {
		t.Fatal("nil reader accepted")
	}
}

func TestNormalizeTranscriptJSONRoundTripStable(t *testing.T) {
	const raw = `{"type":"assistant","sessionId":"s1","timestamp":"2026-08-30T10:00:00Z","message":{"content":[{"type":"text","text":"ok"}]},"future":{"n":1}}` + "\n"
	events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	var back []protocol.Event
	if err := json.Unmarshal(encoded, &back); err != nil {
		t.Fatal(err)
	}
	if len(back) != 1 || back[0].Unknown["future"] == nil {
		t.Fatalf("round-trip lost unknown evidence: %+v", back)
	}
}
