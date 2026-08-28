package scores

import (
	"encoding/json"
	"math/rand"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func scoreEvent(t *testing.T, in Input, at time.Time) *protocol.Event {
	t.Helper()
	ev, err := NewEvent(ids.Event(), "ws_score", in, at)
	if err != nil {
		t.Fatalf("NewEvent(%s): %v", in.Name, err)
	}
	return ev
}

func num(v float64) *float64 { return &v }
func boolean(b bool) *bool   { return &b }

// TestValidateAndRoundTrip covers the full contract for each data type and
// the deterministic payload shape.
func TestValidateAndRoundTrip(t *testing.T) {
	cases := []Input{
		{
			Name: "handoff.validity", DataType: protocol.ScoreDataTypeNumeric,
			Value: num(0.85), TargetType: protocol.ScoreTargetCheckpoint,
			TargetID: "cp_01JZZ", Source: protocol.ScoreSourceEvaluation,
			Comment: "evidence coverage",
		},
		{
			Name: "human.review", DataType: protocol.ScoreDataTypeCategory,
			StringValue: "approved", TargetType: protocol.ScoreTargetTrace,
			TargetID: "trc_01JZZ", Source: protocol.ScoreSourceHuman,
		},
		{
			Name: "tests.passed", DataType: protocol.ScoreDataTypeBoolean,
			BoolValue: boolean(true), TargetType: protocol.ScoreTargetWorkstream,
			TargetID: "ws_01JZZ", Source: protocol.ScoreSourceDetection,
		},
	}
	base := time.Date(2026, 8, 28, 9, 0, 0, 0, time.UTC)
	var events []*protocol.Event
	for i, in := range cases {
		payload, prov, err := Validate(in)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if prov != protocol.ProvenanceObserved {
			t.Fatalf("case %d: provenance = %s", i, prov)
		}
		events = append(events, scoreEvent(t, in, base.Add(time.Duration(i)*time.Second)))
		_ = payload
	}

	got := Materialize(events)
	if len(got) != 3 {
		t.Fatalf("scores = %d, want 3", len(got))
	}
	if got[0].Name != "handoff.validity" || got[0].Value == nil || *got[0].Value != 0.85 {
		t.Fatalf("numeric score = %+v", got[0])
	}
	if got[1].StringValue != "approved" {
		t.Fatalf("category score = %+v", got[1])
	}
	if got[2].BoolValue == nil || !*got[2].BoolValue {
		t.Fatalf("boolean score = %+v", got[2])
	}
	for _, s := range got {
		if s.SchemaVersion != protocol.SchemaVersionScore {
			t.Fatalf("%s schema = %s", s.ScoreID, s.SchemaVersion)
		}
		if s.Provenance != protocol.ProvenanceObserved {
			t.Fatalf("%s provenance = %s", s.ScoreID, s.Provenance)
		}
	}
}

// TestMaterializeDeterministic shuffles the input log: identical output.
func TestMaterializeDeterministic(t *testing.T) {
	base := time.Date(2026, 8, 28, 9, 0, 0, 0, time.UTC)
	var events []*protocol.Event
	for i := 0; i < 8; i++ {
		v := float64(i)
		events = append(events, scoreEvent(t, Input{
			Name: "s", DataType: protocol.ScoreDataTypeNumeric, Value: num(v),
			TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI,
		}, base.Add(time.Duration(i)*time.Second)))
	}
	shuffled := make([]*protocol.Event, len(events))
	copy(shuffled, events)
	rand.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })

	a := Materialize(events)
	b := Materialize(shuffled)
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	if string(ab) != string(bb) {
		t.Fatal("materialize depends on input order")
	}
	for i := 1; i < len(a); i++ {
		if a[i].OccurredAt.Before(a[i-1].OccurredAt) {
			t.Fatal("output not time-sorted")
		}
	}
}

// TestValidateRejects pins the fail-closed validation surface.
func TestValidateRejects(t *testing.T) {
	bad := []struct {
		name string
		in   Input
	}{
		{"empty name", Input{DataType: protocol.ScoreDataTypeNumeric, Value: num(1), TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
		{"bad data type", Input{Name: "n", DataType: "WEIRD", TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
		{"bad target type", Input{Name: "n", DataType: protocol.ScoreDataTypeNumeric, Value: num(1), TargetType: "agent", TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
		{"empty target", Input{Name: "n", DataType: protocol.ScoreDataTypeNumeric, Value: num(1), TargetType: protocol.ScoreTargetTrace, Source: protocol.ScoreSourceAPI}},
		{"prefix mismatch", Input{Name: "n", DataType: protocol.ScoreDataTypeNumeric, Value: num(1), TargetType: protocol.ScoreTargetTrace, TargetID: "ws_01JZZ", Source: protocol.ScoreSourceAPI}},
		{"bad source", Input{Name: "n", DataType: protocol.ScoreDataTypeNumeric, Value: num(1), TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: "llm_judge"}},
		{"numeric missing", Input{Name: "n", DataType: protocol.ScoreDataTypeNumeric, TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
		{"category empty", Input{Name: "n", DataType: protocol.ScoreDataTypeCategory, StringValue: "  ", TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
		{"boolean missing", Input{Name: "n", DataType: protocol.ScoreDataTypeBoolean, TargetType: protocol.ScoreTargetTrace, TargetID: "trc_x", Source: protocol.ScoreSourceAPI}},
	}
	for _, tc := range bad {
		if _, _, err := Validate(tc.in); err == nil {
			t.Fatalf("%s: expected rejection", tc.name)
		}
	}
}

// TestMalformedPayloadIgnored proves a broken score payload can never
// corrupt the derived read model.
func TestMalformedPayloadIgnored(t *testing.T) {
	events := []*protocol.Event{{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		Kind:          protocol.EventScoreRecorded,
		Payload:       json.RawMessage(`{not-json`),
	}}
	if got := Materialize(events); len(got) != 0 {
		t.Fatalf("malformed payload produced %d scores", len(got))
	}
}
