package checkpoint

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func traceEvent(id string, seq int64, at time.Time, kind protocol.EventKind, traceID string, fields map[string]any) *protocol.Event {
	if fields == nil {
		fields = map[string]any{}
	}
	if traceID != "" {
		fields["trace_id"] = traceID
	}
	payload, _ := json.Marshal(fields)
	return &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         id,
		Sequence:        seq,
		OccurredAt:      at,
		ObservedAt:      at,
		WorkstreamID:    "ws_trace_selection",
		SessionID:       "ses_shared",
		NativeSessionID: "native-shared",
		Provider:        protocol.ProviderClaude,
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         payload,
	}
}

func twoTraceEvents() []*protocol.Event {
	base := time.Date(2026, 8, 23, 10, 0, 0, 0, time.UTC)
	return []*protocol.Event{
		traceEvent("evt_a_start", 1, base, protocol.EventTraceStarted, "trc_a", map[string]any{"objective": "fix trace A"}),
		traceEvent("evt_a_cmd", 2, base.Add(time.Second), protocol.EventCommandCompleted, "trc_a", map[string]any{"command": "go test ./a", "exit_code": 1}),
		traceEvent("evt_a_test", 3, base.Add(2*time.Second), protocol.EventTestCompleted, "trc_a", map[string]any{"name": "TestA", "result": "failed", "exit_code": 1}),
		traceEvent("evt_a_end", 4, base.Add(3*time.Second), protocol.EventTraceCompleted, "trc_a", nil),
		traceEvent("evt_b_start", 5, base.Add(4*time.Second), protocol.EventTraceStarted, "trc_b", map[string]any{"objective": "fix trace B"}),
		traceEvent("evt_b_cmd", 6, base.Add(5*time.Second), protocol.EventCommandCompleted, "trc_b", map[string]any{"command": "go test ./b", "exit_code": 0}),
		traceEvent("evt_b_end", 7, base.Add(6*time.Second), protocol.EventTraceCompleted, "trc_b", nil),
	}
}

func TestBuildFromTraceSelectsOnlyTargetEvidence(t *testing.T) {
	cp, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: "trc_a", Events: twoTraceEvents()})
	if err != nil {
		t.Fatalf("BuildFromTrace: %v", err)
	}
	if cp.WorkstreamID != "ws_trace_selection" || cp.Objective != "fix trace A" {
		t.Errorf("checkpoint identity = %s / %q", cp.WorkstreamID, cp.Objective)
	}
	if len(cp.Commands) != 1 || cp.Commands[0].Command != "go test ./a" {
		t.Fatalf("commands = %+v, want only trace A command", cp.Commands)
	}
	if len(cp.Tests) != 1 || cp.Tests[0].Name != "TestA" {
		t.Fatalf("tests = %+v, want only TestA", cp.Tests)
	}
	if len(cp.SourceSessions) != 1 || cp.SourceSessions[0].NativeSessionID != "native-shared" {
		t.Fatalf("source sessions = %+v", cp.SourceSessions)
	}
}

func TestBuildFromTraceObjectiveOverrideAndDeterminism(t *testing.T) {
	events := twoTraceEvents()
	a, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: "trc_a", Objective: "operator objective", Events: events})
	if err != nil {
		t.Fatal(err)
	}
	// Reverse input to ensure selection and graph hashing do not inherit
	// caller slice order.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	b, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: "trc_a", Objective: "operator objective", Events: events})
	if err != nil {
		t.Fatal(err)
	}
	if a.Objective != "operator objective" {
		t.Errorf("objective = %q", a.Objective)
	}
	if a.Integrity.GraphRootHash != b.Integrity.GraphRootHash || a.Integrity.Score != b.Integrity.Score {
		t.Errorf("trace checkpoint is not deterministic: %s/%d vs %s/%d", a.Integrity.GraphRootHash, a.Integrity.Score, b.Integrity.GraphRootHash, b.Integrity.Score)
	}
}

func TestBuildFromRunningTraceStopsAtNextTrace(t *testing.T) {
	base := time.Date(2026, 8, 23, 11, 0, 0, 0, time.UTC)
	events := []*protocol.Event{
		traceEvent("evt_a_start", 1, base, protocol.EventTraceStarted, "trc_a", map[string]any{"objective": "running A"}),
		// These commands intentionally omit trace_id, exercising the session
		// time-window fallback used for native hooks with partial correlation.
		traceEvent("evt_a_cmd", 2, base.Add(time.Second), protocol.EventCommandCompleted, "", map[string]any{"command": "go test ./a", "exit_code": 0}),
		traceEvent("evt_b_start", 3, base.Add(2*time.Second), protocol.EventTraceStarted, "trc_b", map[string]any{"objective": "running B"}),
		traceEvent("evt_b_cmd", 4, base.Add(3*time.Second), protocol.EventCommandCompleted, "", map[string]any{"command": "go test ./b", "exit_code": 0}),
	}
	cp, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: "trc_a", Events: events})
	if err != nil {
		t.Fatal(err)
	}
	if len(cp.Commands) != 1 || cp.Commands[0].Command != "go test ./a" {
		t.Fatalf("commands = %+v, neighboring running trace leaked into checkpoint", cp.Commands)
	}
}

func TestBuildFromTraceCarriesNativeSessionIdentity(t *testing.T) {
	events := twoTraceEvents()
	for _, ev := range events {
		ev.NativeSessionID = ""
	}
	identity := traceEvent("evt_session_start", 0, events[0].OccurredAt.Add(-time.Second), protocol.EventSessionStarted, "", nil)
	identity.NativeSessionID = "native-resumable"
	events = append(events, identity) // deliberately out of order

	cp, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: "trc_a", Events: events})
	if err != nil {
		t.Fatal(err)
	}
	if len(cp.SourceSessions) != 1 || cp.SourceSessions[0].NativeSessionID != "native-resumable" {
		t.Fatalf("source sessions = %+v, native identity was lost", cp.SourceSessions)
	}
}

func TestBuildFromTraceErrors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		traceID string
		events  []*protocol.Event
		want    string
	}{
		{name: "missing id", want: "trace_id is required"},
		{name: "unknown", traceID: "trc_missing", events: twoTraceEvents(), want: "not found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := BuildFromTrace(context.Background(), TraceBuildOptions{TraceID: tc.traceID, Events: tc.events})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}
