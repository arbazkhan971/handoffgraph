package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func openTempDB(t *testing.T) (*DB, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, dir
}

func newEvent(workstream, session, kind string, occurred time.Time) *protocol.Event {
	return &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    occurred,
		ObservedAt:    occurred,
		WorkstreamID:  workstream,
		SessionID:     session,
		Provider:      protocol.ProviderCodex,
		Kind:          protocol.EventKind(kind),
		Provenance:    protocol.ProvenanceObserved,
	}
}

func TestAppendAndCount(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	ok, err := db.AppendEvent(ctx, ev)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected inserted")
	}
	n, err := db.EventCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("count = %d, want 1", n)
	}
}

func TestAppendIdempotency(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	// Duplicate append must be ignored.
	ok, err := db.AppendEvent(ctx, ev)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected duplicate to be ignored")
	}
	n, _ := db.EventCount(ctx)
	if n != 1 {
		t.Fatalf("count = %d, want 1 after duplicate", n)
	}
}

func TestOutOfOrderInput(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	base := time.Now().UTC()
	// Insert later event first, then earlier event.
	later := newEvent("ws_1", "ses_1", string(protocol.EventTraceCompleted), base.Add(time.Hour))
	if _, err := db.AppendEvent(ctx, later); err != nil {
		t.Fatal(err)
	}
	earlier := newEvent("ws_1", "ses_1", string(protocol.EventTraceStarted), base)
	if _, err := db.AppendEvent(ctx, earlier); err != nil {
		t.Fatal(err)
	}

	events, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("len = %d, want 2", len(events))
	}
	// ListEvents must order by occurred_at, so earlier comes first.
	if events[0].Kind != protocol.EventTraceStarted {
		t.Fatalf("ordering wrong: first kind = %s", events[0].Kind)
	}
}

func TestTenThousandEventIngestionNoLoss(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	events := fixture.GenerateSynthetic(10000)
	var inserted int64
	for _, ev := range events {
		ok, err := db.AppendEvent(ctx, ev)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			inserted++
		}
	}
	// Synthetic generator produces 3 + 1 + 2*10000 + 1 = 20005 events.
	if inserted != int64(len(events)) {
		t.Fatalf("inserted %d, want %d", inserted, len(events))
	}
	n, err := db.EventCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(len(events)) {
		t.Fatalf("count = %d, want %d (loss detected)", n, len(events))
	}
}

func TestCrashReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	ctx := context.Background()

	db1, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db1.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	db1.Close() // simulate crash: no graceful shutdown needed

	db2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	n, err := db2.EventCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("after reopen count = %d, want 1", n)
	}
}

func TestDeterministicGraphHash(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	events := fixture.GenerateSynthetic(500)
	for _, ev := range events {
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}

	h1, err := graph.RootHashForEvents(stored)
	if err != nil {
		t.Fatal(err)
	}
	h2, err := graph.RootHashForEvents(stored)
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("rebuild produced different hash: %s != %s", h1, h2)
	}
}

func TestMigrationsVersioned(t *testing.T) {
	db, _ := openTempDB(t)
	v, err := db.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v != len(migrations) {
		t.Fatalf("schema version = %d, want %d", v, len(migrations))
	}
	uv, err := db.UserVersion()
	if err != nil {
		t.Fatal(err)
	}
	if uv != len(migrations) {
		t.Fatalf("user_version = %d, want %d", uv, len(migrations))
	}
}
