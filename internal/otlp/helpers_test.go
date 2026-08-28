package otlp

import (
	"path/filepath"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// materialize runs the deterministic materializer over converted events.
func materialize(t *testing.T, events []*protocol.Event) *trace.MaterializeResult {
	t.Helper()
	return trace.Materialize(events)
}

// openTestDB opens a throwaway event store.
func openTestDB(t *testing.T) *storage.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "otlp-test.db"))
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	return db
}
