package trace

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestMaterializeProducesTraces(t *testing.T) {
	events := fixture.GenerateSynthetic(100)
	res := Materialize(events)

	if len(res.Traces) == 0 {
		t.Fatal("expected at least one trace")
	}
	if len(res.Spans) == 0 {
		t.Fatal("expected spans")
	}
	if err := res.Validate(); err != nil {
		t.Fatalf("result invalid: %v", err)
	}
}

func TestMaterializeDeterministic(t *testing.T) {
	events := fixture.GenerateSynthetic(100)
	r1 := Materialize(events)
	r2 := Materialize(events)

	if len(r1.Traces) != len(r2.Traces) || len(r1.Spans) != len(r2.Spans) {
		t.Fatal("materialize not deterministic")
	}
	for i := range r1.Traces {
		if r1.Traces[i].TraceID != r2.Traces[i].TraceID {
			t.Fatal("trace ordering not deterministic")
		}
	}
}

func TestFailingTestMarksVerificationFailed(t *testing.T) {
	events := fixture.GenerateSynthetic(10)
	res := Materialize(events)

	// The synthetic fixture ends with a failed test; at least one trace must
	// be marked failed and have a failed span counted.
	found := false
	for _, tr := range res.Traces {
		if tr.VerificationState == protocol.VerificationFailed {
			found = true
		}
	}
	if !found {
		t.Fatal("expected a trace with failed verification state")
	}
}

func TestOrphanSpanPreserved(t *testing.T) {
	// A span.completed event with no matching span.started must not be
	// discarded; it is preserved with status unknown.
	events := fixture.GenerateSynthetic(0)
	// Strip span started events to force orphans.
	var orphaned []*protocol.Event
	for _, ev := range events {
		if ev.Kind == protocol.EventSpanStarted {
			continue
		}
		orphaned = append(orphaned, ev)
	}
	res := Materialize(orphaned)
	if len(res.Spans) == 0 {
		t.Fatal("expected orphan spans to be preserved")
	}
}

// spanStartEvent builds a minimal span.started event whose derived span has
// the given SpanID, Sequence, and StartedAtNS (from OccurredAt).
func spanStartEvent(spanID string, at time.Time, seq int64) *protocol.Event {
	payload, err := json.Marshal(map[string]any{"span_id": spanID})
	if err != nil {
		panic(err)
	}
	return &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       "evt-" + spanID,
		Sequence:      seq,
		OccurredAt:    at,
		ObservedAt:    at,
		SessionID:     "sess-ordering",
		Kind:          protocol.EventSpanStarted,
		Payload:       payload,
	}
}

func spanIDs(spans []*protocol.Span) []string {
	ids := make([]string, 0, len(spans))
	for _, sp := range spans {
		ids = append(ids, sp.SpanID)
	}
	return ids
}

func TestSpanOrderingUsesStartedAtWhenSequencesEqual(t *testing.T) {
	base := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	// All Sequences are zero; IDs are deliberately anti-chronological so an
	// ID-based order would differ from the expected time-based order.
	events := []*protocol.Event{
		spanStartEvent("span-late", base.Add(2*time.Second), 0),
		spanStartEvent("span-mid", base.Add(1*time.Second), 0),
		spanStartEvent("span-early", base, 0),
	}
	want := []string{"span-early", "span-mid", "span-late"}

	got := spanIDs(Materialize(events).Spans)
	if !slices.Equal(got, want) {
		t.Fatalf("span order = %v, want %v", got, want)
	}

	// The comparator must be a pure function of the spans: reversing the
	// input log must not change the emitted order.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	if got := spanIDs(Materialize(events).Spans); !slices.Equal(got, want) {
		t.Fatalf("reversed-input span order = %v, want %v", got, want)
	}
}

func TestSpanOrderingSpanIDBreaksFullTie(t *testing.T) {
	// Identical Sequence and StartedAtNS degenerate to the SpanID tiebreak;
	// zero values stay deterministic.
	at := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	events := []*protocol.Event{
		spanStartEvent("c", at, 0),
		spanStartEvent("a", at, 0),
		spanStartEvent("b", at, 0),
	}
	want := []string{"a", "b", "c"}

	got := spanIDs(Materialize(events).Spans)
	if !slices.Equal(got, want) {
		t.Fatalf("span order = %v, want %v", got, want)
	}
}

func TestSpanOrderingSequenceDominatesStartedAt(t *testing.T) {
	// A higher Sequence wins even when its StartedAtNS is later.
	base := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	events := []*protocol.Event{
		spanStartEvent("seq-7", base.Add(time.Second), 7),
		spanStartEvent("seq-3", base, 3),
	}
	want := []string{"seq-3", "seq-7"}

	got := spanIDs(Materialize(events).Spans)
	if !slices.Equal(got, want) {
		t.Fatalf("span order = %v, want %v", got, want)
	}
}

func TestFileEventsPromoteToSpansAndOnlyWritesCountAsChanged(t *testing.T) {
	base := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	event := func(id string, seq int64, kind protocol.EventKind, payload map[string]any) *protocol.Event {
		body, _ := json.Marshal(payload)
		return &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       id,
			Sequence:      seq,
			OccurredAt:    base.Add(time.Duration(seq) * time.Millisecond),
			ObservedAt:    base.Add(time.Duration(seq) * time.Millisecond),
			WorkstreamID:  "ws_files",
			SessionID:     "ses_files",
			Provider:      protocol.ProviderCodex,
			Kind:          kind,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       body,
		}
	}
	events := []*protocol.Event{
		event("evt_trace", 1, protocol.EventTraceStarted, map[string]any{"trace_id": "trc_files"}),
		event("evt_read", 2, protocol.EventFileRead, map[string]any{"trace_id": "trc_files", "path": "README.md"}),
		event("evt_write", 3, protocol.EventFileEdited, map[string]any{"trace_id": "trc_files", "path": "main.go"}),
		event("evt_done", 4, protocol.EventTraceCompleted, map[string]any{"trace_id": "trc_files"}),
	}
	res := Materialize(events)
	if len(res.Traces) != 1 || res.Traces[0].ChangedFileCount != 1 {
		t.Fatalf("traces = %+v, want one changed file (read must not count)", res.Traces)
	}
	if len(res.Spans) != 2 {
		t.Fatalf("spans = %d, want read + write", len(res.Spans))
	}
	if res.Spans[0].Kind != protocol.SpanKindFileRead || res.Spans[1].Kind != protocol.SpanKindFileWrite {
		t.Fatalf("span kinds = %s, %s", res.Spans[0].Kind, res.Spans[1].Kind)
	}
}

func TestSpanKindAcceptsCanonicalSpanKindField(t *testing.T) {
	base := time.Date(2026, 8, 23, 13, 0, 0, 0, time.UTC)
	payload, _ := json.Marshal(map[string]any{"span_id": "spn_command", "trace_id": "trc_command", "span_kind": "COMMAND"})
	events := []*protocol.Event{
		{SchemaVersion: protocol.SchemaVersionEvent, EventID: "evt_trace", Sequence: 1, OccurredAt: base, ObservedAt: base, SessionID: "ses_command", Kind: protocol.EventTraceStarted, Payload: json.RawMessage(`{"trace_id":"trc_command"}`)},
		{SchemaVersion: protocol.SchemaVersionEvent, EventID: "evt_span", Sequence: 2, OccurredAt: base.Add(time.Millisecond), ObservedAt: base.Add(time.Millisecond), SessionID: "ses_command", Kind: protocol.EventSpanStarted, Payload: payload},
	}
	res := Materialize(events)
	if len(res.Spans) != 1 || res.Spans[0].Kind != protocol.SpanKindCommand {
		t.Fatalf("spans = %+v, want COMMAND kind", res.Spans)
	}
}

func TestEqualTimeTraceOrderingAndProviderFallbackAreDeterministic(t *testing.T) {
	at := time.Date(2026, 8, 23, 14, 0, 0, 0, time.UTC)
	traceStart := func(eventID, traceID, sessionID string) *protocol.Event {
		payload, _ := json.Marshal(map[string]any{"trace_id": traceID})
		return &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       eventID,
			OccurredAt:    at,
			ObservedAt:    at,
			SessionID:     sessionID,
			Provider:      protocol.ProviderCodex,
			Kind:          protocol.EventTraceStarted,
			Payload:       payload,
		}
	}
	commandPayload, _ := json.Marshal(map[string]any{
		"trace_id":  "trc_missing",
		"command":   "go test ./...",
		"exit_code": 0,
	})
	events := []*protocol.Event{
		traceStart("evt_trace_z", "trc_z", "ses_z"),
		traceStart("evt_trace_a", "trc_a", "ses_a"),
		{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       "evt_orphan_command",
			OccurredAt:    at.Add(time.Second),
			ObservedAt:    at.Add(time.Second),
			Provider:      protocol.ProviderCodex,
			Kind:          protocol.EventCommandCompleted,
			Payload:       commandPayload,
		},
	}

	for i := 0; i < 100; i++ {
		res := Materialize(events)
		if got := []string{res.Traces[0].TraceID, res.Traces[1].TraceID}; !slices.Equal(got, []string{"trc_a", "trc_z"}) {
			t.Fatalf("equal-time trace order = %v, want [trc_a trc_z]", got)
		}
		if len(res.Spans) != 1 || res.Spans[0].TraceID != "trc_z" {
			t.Fatalf("provider fallback = %+v, want deterministic latest trace-id trc_z", res.Spans)
		}
	}
}
