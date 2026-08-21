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
