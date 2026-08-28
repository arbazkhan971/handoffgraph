package prompts

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestVersionsAndLabels(t *testing.T) {
	base := time.Date(2026, 8, 28, 14, 0, 0, 0, time.UTC)
	var events []*protocol.Event
	ev, _, err := NewCreatedEvent(ids.Event(), "", "refund", "body v1", "", base)
	if err != nil {
		t.Fatal(err)
	}
	if err := AssignVersion(ev, 1); err != nil {
		t.Fatal(err)
	}
	events = append(events, ev)
	ev2, _, err := NewCreatedEvent(ids.Event(), "", "refund", "body v2", "", base.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if err := AssignVersion(ev2, 2); err != nil {
		t.Fatal(err)
	}
	events = append(events, ev2)
	lbl, err2 := NewLabeledEvent(ids.Event(), "", "refund", "production", 1, base.Add(2*time.Second))
	if err2 != nil {
		t.Fatal(err2)
	}
	if err != nil {
		t.Fatal(err)
	}
	events = append(events, lbl)

	byName := Materialize(events)
	pr, ok := byName["refund"]
	if !ok || len(pr.Versions) != 2 {
		t.Fatalf("prompt = %+v", pr)
	}
	if pr.Versions[0].Hash == pr.Versions[1].Hash {
		t.Fatal("different bodies must not share a hash")
	}
	resolved := pr.Resolve()
	if resolved["production"] != 1 || resolved["latest"] != 2 {
		t.Fatalf("resolve = %v", resolved)
	}
}

func TestNewCreatedEventFailClosed(t *testing.T) {
	if _, _, err := NewCreatedEvent(ids.Event(), "", "", "body", "", time.Now()); err == nil {
		t.Fatal("empty name accepted")
	}
	if _, _, err := NewCreatedEvent(ids.Event(), "", "p", "", "", time.Now()); err == nil {
		t.Fatal("empty body accepted")
	}
	if _, _, err := NewCreatedEvent(ids.Event(), "", "p", string(make([]byte, maxPromptBytes+1)), "", time.Now()); err == nil {
		t.Fatal("oversize body accepted")
	}
	if _, err := NewLabeledEvent(ids.Event(), "", "p", "prod", 0, time.Now()); err == nil {
		t.Fatal("version 0 label accepted")
	}
}

func TestLinksAndMalformedIgnored(t *testing.T) {
	base := time.Now()
	created, _, _ := NewCreatedEvent(ids.Event(), "", "p", "body", "", base)
	_ = AssignVersion(created, 1)
	linked := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    base,
		ObservedAt:    base,
		Kind:          protocol.EventTraceStarted,
		Payload:       json.RawMessage(`{"trace_id":"trc_x","prompt_name":"p","prompt_version":1}`),
	}
	broken := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    base,
		ObservedAt:    base,
		Kind:          protocol.EventPromptCreated,
		Payload:       json.RawMessage(`{nope`),
	}
	byName := Materialize([]*protocol.Event{created, linked, broken})
	if _, ok := byName["p"]; !ok {
		t.Fatal("created event lost")
	}
	links := Links([]*protocol.Event{linked}, "p", 0)
	if len(links) != 1 || links[0] != linked.EventID {
		t.Fatalf("links = %v", links)
	}
}
