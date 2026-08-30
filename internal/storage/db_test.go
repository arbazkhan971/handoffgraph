package storage

import (
	"context"
	"os"
	"os/exec"
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

func TestListEventsAfterSeqUsesAppendCursorAndHighWatermark(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)

	// Deliberately append in the opposite order from occurred_at. The hosted
	// cursor is the durable append sequence, never event time or the adapter's
	// source-local Sequence field.
	first := newEvent("ws_1", "ses_1", string(protocol.EventTraceCompleted), base.Add(time.Hour))
	first.Sequence = 99
	second := newEvent("ws_1", "ses_1", string(protocol.EventTraceStarted), base)
	second.Sequence = 0
	third := newEvent("ws_1", "ses_1", string(protocol.EventSessionEnded), base.Add(2*time.Hour))
	for _, ev := range []*protocol.Event{first, second, third} {
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}

	page, err := db.ListEventsAfterSeq(ctx, 0, 2, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || page[0].Seq != 1 || page[0].Event.EventID != first.EventID || page[1].Seq != 2 || page[1].Event.EventID != second.EventID {
		t.Fatalf("page = %+v, want append sequences 1 and 2", page)
	}
	next, err := db.ListEventsAfterSeq(ctx, 1, 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 1 || next[0].Seq != 2 || next[0].Event.EventID != second.EventID {
		t.Fatalf("next = %+v, want sequence 2", next)
	}
}

func TestListEventsAfterSeqRejectsInvalidBounds(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	for _, tc := range []struct {
		after, through int64
		limit          int
	}{{-1, 0, 1}, {2, 1, 1}, {0, 1, 0}, {0, 1, 501}} {
		if _, err := db.ListEventsAfterSeq(ctx, tc.after, tc.through, tc.limit); err == nil {
			t.Fatalf("ListEventsAfterSeq(%d, %d, %d) succeeded", tc.after, tc.through, tc.limit)
		}
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
	const crashDBEnv = "HFG_TEST_CRASH_REOPEN_DB"
	if path := os.Getenv(crashDBEnv); path != "" {
		// This branch runs in the child process. Commit one append and exit
		// immediately without calling DB.Close, so the parent exercises SQLite
		// WAL recovery rather than an orderly close/reopen cycle.
		db, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
		inserted, err := db.AppendEvent(context.Background(), ev)
		if err != nil {
			t.Fatal(err)
		}
		if !inserted {
			t.Fatal("expected crash-writer append to insert")
		}
		os.Exit(0) // deliberately bypass deferred cleanup and testing teardown
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	ctx := context.Background()

	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashReopen$", "-test.count=1")
	cmd.Env = append(os.Environ(), crashDBEnv+"="+path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("crash-writer subprocess: %v\n%s", err, out)
	}

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
