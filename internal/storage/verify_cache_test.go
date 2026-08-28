package storage

import (
	"context"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestVerifyCacheMissWhenEmpty(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	report, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("expected miss on an empty cache, got report %q", report)
	}
}

func TestVerifyCacheSaveThenGetHits(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}

	snap, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap, `[{"name":"traces_closed","passed":true}]`); err != nil {
		t.Fatal(err)
	}

	report, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected a hit right after save with no intervening events")
	}
	if report != `[{"name":"traces_closed","passed":true}]` {
		t.Fatalf("report = %q, unexpected", report)
	}
}

func TestVerifyCacheInvalidatedByNewEvent(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	snap, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap, `[]`); err != nil {
		t.Fatal(err)
	}

	// A real, non-verification event on the same workstream changes the
	// fingerprint and must invalidate the cache.
	ev2 := newEvent("ws_1", "ses_1", string(protocol.EventCommandCompleted), time.Now())
	if _, err := db.AppendEvent(ctx, ev2); err != nil {
		t.Fatal(err)
	}

	_, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected a miss after a new event on the same workstream")
	}
}

func TestVerifyCacheSnapshotExcludesVerificationRecorded(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	snap, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap, `[]`); err != nil {
		t.Fatal(err)
	}

	// verification.recorded events (the gate's own evidence trail) must not
	// count toward the fingerprint, or the cache could never warm across
	// repeated runs — appending one is the exact effect a real `verify` run
	// has on the log.
	verEvent := newEvent("ws_1", "ses_1", string(protocol.EventVerificationRecorded), time.Now())
	if _, err := db.AppendEvent(ctx, verEvent); err != nil {
		t.Fatal(err)
	}

	_, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("a verification.recorded append must not invalidate the cache")
	}

	// Direct check on the fingerprint computation itself: the count/max_seq
	// must be identical before and after the verification.recorded append.
	before, err := db.computeVerifySnapshot(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	verEvent2 := newEvent("ws_1", "ses_1", string(protocol.EventVerificationRecorded), time.Now())
	if _, err := db.AppendEvent(ctx, verEvent2); err != nil {
		t.Fatal(err)
	}
	after, err := db.computeVerifySnapshot(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("snapshot changed after a verification.recorded append: %+v -> %+v", before, after)
	}
}

func TestVerifyCacheScopedPerWorkstream(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev1 := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev1); err != nil {
		t.Fatal(err)
	}
	snap1, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap1, `["ws1-report"]`); err != nil {
		t.Fatal(err)
	}

	// A second workstream has never been cached; it must miss even though
	// ws_1 has a fresh cache entry, and appending its own events must not
	// disturb ws_1's cache.
	ev2 := newEvent("ws_2", "ses_2", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev2); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := db.VerifyCacheGet(ctx, "ws_2"); err != nil || ok {
		t.Fatalf("ws_2 ok=%v err=%v, want a miss", ok, err)
	}

	report, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || report != `["ws1-report"]` {
		t.Fatalf("ws_1 cache disturbed by ws_2 activity: ok=%v report=%q", ok, report)
	}
}

func TestVerifyCacheSaveOverwritesPriorEntry(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	snap, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap, `["first"]`); err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyCacheSave(ctx, "ws_1", snap, `["second"]`); err != nil {
		t.Fatal(err)
	}

	report, ok, err := db.VerifyCacheGet(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || report != `["second"]` {
		t.Fatalf("report = %q, ok = %v, want the second save to win", report, ok)
	}
}

func TestVerifySnapshotJSONFieldNames(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()

	ev := newEvent("ws_1", "ses_1", string(protocol.EventSessionStarted), time.Now())
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		t.Fatal(err)
	}
	snap, err := db.VerifySnapshotJSON(ctx, "ws_1")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"event_count":1,"max_seq":1}`
	if snap != want {
		t.Fatalf("snapshot JSON = %q, want %q", snap, want)
	}
}
