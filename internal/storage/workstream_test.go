package storage

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestListWorkstreamsDerivesImportedEventOnlyWorkstream(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "derived.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	at := time.Date(2026, 8, 21, 13, 0, 0, 0, time.UTC)
	wsID := ids.Workstream()
	repoID := ids.Repository()
	payload, _ := json.Marshal(map[string]string{"title": "Fix checkout race"})
	events := []*protocol.Event{
		{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    at,
			ObservedAt:    at,
			WorkstreamID:  wsID,
			RepositoryID:  repoID,
			Kind:          protocol.EventWorkstreamStarted,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       payload,
		},
		{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    at.Add(time.Second),
			ObservedAt:    at.Add(time.Second),
			WorkstreamID:  wsID,
			Kind:          protocol.EventHandoffCreated,
			Provenance:    protocol.ProvenanceDeclared,
		},
	}
	for _, ev := range events {
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}

	got, err := db.ListWorkstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("workstreams = %d, want 1: %+v", len(got), got)
	}
	w := got[0]
	if w.ID != wsID || w.Title != "Fix checkout race" || w.RepositoryID != repoID || w.Status != "handed_off" {
		t.Fatalf("derived workstream = %+v", w)
	}
	if !w.CreatedAt.Equal(at) {
		t.Fatalf("created_at = %v, want %v", w.CreatedAt, at)
	}
}

func TestListWorkstreamsMergesTableAndEventStateWithoutOverwritingTitle(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "merged.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	wsID := ids.Workstream()
	if err := db.CreateWorkstream(ctx, wsID, "User title", ""); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	payload, _ := json.Marshal(map[string]string{"title": "Imported title"})
	for _, ev := range []*protocol.Event{
		{SchemaVersion: protocol.SchemaVersionEvent, EventID: ids.Event(), OccurredAt: at, ObservedAt: at, WorkstreamID: wsID, Kind: protocol.EventWorkstreamStarted, Payload: payload},
		{SchemaVersion: protocol.SchemaVersionEvent, EventID: ids.Event(), OccurredAt: at.Add(time.Second), ObservedAt: at.Add(time.Second), WorkstreamID: wsID, Kind: protocol.EventWorkstreamCompleted},
	} {
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	got, err := db.ListWorkstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Title != "User title" || got[0].Status != "completed" {
		t.Fatalf("merged workstream = %+v, want preserved title and completed status", got)
	}
}
