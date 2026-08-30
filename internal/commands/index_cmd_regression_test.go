package commands

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// A native adapter sequence is scoped to its source session; it is not the
// SQLite append sequence used by the observations freshness watermark. This
// regression test mirrors importing multiple real sessions whose native
// sequence numbers restart from zero.
func TestRebuildObservationsUsesDurableAppendWatermark(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := storage.Open(filepath.Join(t.TempDir(), "handoffgraph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	for i := 0; i < 3; i++ {
		now := time.Date(2026, 8, 30, 10, 0, i, 0, time.UTC)
		inserted, err := db.AppendEvent(ctx, &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			Sequence:      int64(i % 2), // source-local sequence restarts
			OccurredAt:    now,
			ObservedAt:    now,
			Kind:          protocol.EventLogObserved,
			Provenance:    protocol.ProvenanceObserved,
		})
		if err != nil {
			t.Fatal(err)
		}
		if !inserted {
			t.Fatal("event was not inserted")
		}
	}

	events, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rebuildObservations(ctx, db, events); err != nil {
		t.Fatal(err)
	}
	stale, err := db.ObservationsStale(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("freshly rebuilt observations remained stale")
	}
}
