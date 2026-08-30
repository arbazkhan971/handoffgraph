package storage

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func batchEvent(eventID, workstream, session, provider, native, marker string) *protocol.Event {
	at := time.Date(2026, 8, 30, 18, 0, 0, 0, time.UTC)
	return &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         eventID,
		OccurredAt:      at,
		ObservedAt:      at,
		WorkstreamID:    workstream,
		SessionID:       session,
		NativeSessionID: native,
		Provider:        provider,
		Kind:            protocol.EventLogObserved,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         json.RawMessage(`{"marker":"` + marker + `"}`),
	}
}

func cloneBatchEvent(event *protocol.Event) *protocol.Event {
	clone := *event
	clone.Payload = append(json.RawMessage(nil), event.Payload...)
	clone.Unknown = nil
	if event.Unknown != nil {
		clone.Unknown = make(map[string]json.RawMessage, len(event.Unknown))
		for key, value := range event.Unknown {
			clone.Unknown[key] = append(json.RawMessage(nil), value...)
		}
	}
	return &clone
}

func TestAppendEventsAtomicExactIdempotencyAndInputValidation(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	first := batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "first")
	second := batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "second")
	batch := []*protocol.Event{first, second}

	result, err := db.AppendEventsAtomic(ctx, batch)
	if err != nil || result.Inserted != 2 || result.Existing != 0 {
		t.Fatalf("first result=%+v err=%v", result, err)
	}
	maxBefore, _ := db.MaxSeq(ctx)
	result, err = db.AppendEventsAtomic(ctx, batch)
	if err != nil || result.Inserted != 0 || result.Existing != 2 {
		t.Fatalf("retry result=%+v err=%v", result, err)
	}
	maxAfter, _ := db.MaxSeq(ctx)
	if maxAfter != maxBefore {
		t.Fatalf("idempotent retry advanced max seq: %d -> %d", maxBefore, maxAfter)
	}

	for name, invalid := range map[string][]*protocol.Event{
		"duplicate": {first, first},
		"nil":       {nil},
		"empty id":  {batchEvent("", "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "empty")},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := db.AppendEventsAtomic(ctx, invalid); err == nil {
				t.Fatal("invalid batch succeeded")
			}
			n, _ := db.EventCount(ctx)
			if n != 2 {
				t.Fatalf("invalid batch changed count to %d", n)
			}
		})
	}
	if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{first, first}); !errors.Is(err, ErrDuplicateBatchEvent) {
		t.Fatalf("duplicate error = %v, want ErrDuplicateBatchEvent", err)
	}
}

func TestAppendEventsAtomicLateConflictRollsBackAndRetryCommits(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	existing := batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "original")
	if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{existing}); err != nil {
		t.Fatal(err)
	}
	maxBefore, _ := db.MaxSeq(ctx)

	newEvent := batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "new")
	conflict := cloneBatchEvent(existing)
	conflict.Payload = json.RawMessage(`{"marker":"changed"}`)
	if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{newEvent, conflict}); !errors.Is(err, ErrEventConflict) {
		t.Fatalf("late conflict error = %v, want ErrEventConflict", err)
	}
	n, _ := db.EventCount(ctx)
	maxAfter, _ := db.MaxSeq(ctx)
	if n != 1 || maxAfter != maxBefore {
		t.Fatalf("late conflict partially committed: count=%d max=%d (before=%d)", n, maxAfter, maxBefore)
	}
	stored, err := db.ListEvents(ctx)
	if err != nil || len(stored) != 1 || string(stored[0].Payload) != string(existing.Payload) {
		t.Fatalf("original event mutated: events=%+v err=%v", stored, err)
	}

	result, err := db.AppendEventsAtomic(ctx, []*protocol.Event{newEvent, existing})
	if err != nil || result.Inserted != 1 || result.Existing != 1 {
		t.Fatalf("retry result=%+v err=%v", result, err)
	}
	maxAfter, _ = db.MaxSeq(ctx)
	if maxAfter != maxBefore+1 {
		t.Fatalf("retry max seq=%d, want %d", maxAfter, maxBefore+1)
	}
}

func TestAppendEventsAtomicRollbackOnCancellationAfterInsert(t *testing.T) {
	db, _ := openTempDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	batch := []*protocol.Event{
		batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "one"),
		batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "two"),
	}
	_, err := db.appendEventsAtomic(ctx, batch, func(index int) error {
		if index == 1 {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
	n, _ := db.EventCount(context.Background())
	maxSeq, _ := db.MaxSeq(context.Background())
	if n != 0 || maxSeq != 0 {
		t.Fatalf("canceled batch committed: count=%d max=%d", n, maxSeq)
	}
}

func TestAppendEventsAtomicCanonicalSessionOwnership(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	base := batchEvent(ids.Event(), "ws_one", "ses_explicit", protocol.ProviderClaude, "native-one", "base")
	if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{base}); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		event *protocol.Event
	}{
		{"same session other workstream", batchEvent(ids.Event(), "ws_two", "ses_explicit", protocol.ProviderClaude, "native-one", "x")},
		{"same session other provider", batchEvent(ids.Event(), "ws_one", "ses_explicit", protocol.ProviderCodex, "native-one", "x")},
		{"same session other native", batchEvent(ids.Event(), "ws_one", "ses_explicit", protocol.ProviderClaude, "native-two", "x")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			maxBefore, _ := db.MaxSeq(ctx)
			if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{tc.event}); !errors.Is(err, ErrSessionOwnershipConflict) {
				t.Fatalf("ownership error = %v", err)
			}
			maxAfter, _ := db.MaxSeq(ctx)
			if maxAfter != maxBefore {
				t.Fatalf("ownership conflict advanced max seq: %d -> %d", maxBefore, maxAfter)
			}
		})
	}

	matching := batchEvent(ids.Event(), "ws_one", "ses_explicit", protocol.ProviderClaude, "native-one", "matching")
	if result, err := db.AppendEventsAtomic(ctx, []*protocol.Event{matching}); err != nil || result.Inserted != 1 {
		t.Fatalf("matching owner result=%+v err=%v", result, err)
	}

	t.Run("mixed owner inside incoming batch", func(t *testing.T) {
		mixedSession := ids.Session()
		mixed := []*protocol.Event{
			batchEvent(ids.Event(), "ws_one", mixedSession, protocol.ProviderClaude, "native-one", "one"),
			batchEvent(ids.Event(), "ws_two", mixedSession, protocol.ProviderClaude, "native-one", "two"),
		}
		maxBefore, _ := db.MaxSeq(ctx)
		if _, err := db.AppendEventsAtomic(ctx, mixed); !errors.Is(err, ErrSessionOwnershipConflict) {
			t.Fatalf("mixed incoming ownership error = %v", err)
		}
		maxAfter, _ := db.MaxSeq(ctx)
		if maxAfter != maxBefore {
			t.Fatalf("mixed incoming owner advanced max seq: %d -> %d", maxBefore, maxAfter)
		}
	})
}

func TestAppendEventsAtomicBlankLegacyOwnershipFieldsAreNonClaims(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	session := ids.Session()
	legacy := batchEvent(ids.Event(), "", session, "", "", "legacy")
	if _, err := db.AppendEventsAtomic(ctx, []*protocol.Event{legacy}); err != nil {
		t.Fatal(err)
	}
	anchored := batchEvent(ids.Event(), "ws_one", session, protocol.ProviderClaude, "native-one", "anchored")
	if result, err := db.AppendEventsAtomic(ctx, []*protocol.Event{anchored}); err != nil || result.Inserted != 1 {
		t.Fatalf("anchoring blank legacy claims result=%+v err=%v", result, err)
	}
}

func TestAppendEventsAtomicAllowsSharedProviderNativeAcrossCanonicalSessions(t *testing.T) {
	db, _ := openTempDB(t)
	ctx := context.Background()
	first := batchEvent(ids.Event(), "ws_one", ids.Session(), protocol.ProviderClaude, "native-shared", "first")
	second := batchEvent(ids.Event(), "ws_two", ids.Session(), protocol.ProviderClaude, "native-shared", "second")
	result, err := db.AppendEventsAtomic(ctx, []*protocol.Event{first, second})
	if err != nil || result.Inserted != 2 {
		t.Fatalf("shared provider/native result=%+v err=%v", result, err)
	}
}

func openTwoEventBatchDBs(t *testing.T) (*DB, *DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "concurrent.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Open(path)
	if err != nil {
		first.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		first.Close()
		second.Close()
	})
	return first, second
}

func TestAppendEventsAtomicConcurrentHandlesIdentical(t *testing.T) {
	firstDB, secondDB := openTwoEventBatchDBs(t)
	batch := []*protocol.Event{
		batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "one"),
		batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "two"),
	}
	type outcome struct {
		result EventBatchResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wg sync.WaitGroup
	for _, db := range []*DB{firstDB, secondDB} {
		wg.Add(1)
		go func(db *DB) {
			defer wg.Done()
			<-start
			result, err := db.AppendEventsAtomic(context.Background(), batch)
			outcomes <- outcome{result: result, err: err}
		}(db)
	}
	close(start)
	wg.Wait()
	close(outcomes)
	insertedResults, existingResults := 0, 0
	for outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("concurrent identical import: %v", outcome.err)
		}
		if outcome.result.Inserted == 2 && outcome.result.Existing == 0 {
			insertedResults++
		}
		if outcome.result.Inserted == 0 && outcome.result.Existing == 2 {
			existingResults++
		}
	}
	if insertedResults != 1 || existingResults != 1 {
		t.Fatalf("outcomes inserted=%d existing=%d", insertedResults, existingResults)
	}
	n, _ := firstDB.EventCount(context.Background())
	if n != 2 {
		t.Fatalf("concurrent identical count=%d", n)
	}
}

func TestAppendEventsAtomicConcurrentHandlesConflictHasOneWholeWinner(t *testing.T) {
	firstDB, secondDB := openTwoEventBatchDBs(t)
	id1, id2 := ids.Event(), ids.Event()
	batchA := []*protocol.Event{
		batchEvent(id1, "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "A"),
		batchEvent(id2, "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "A"),
	}
	batchB := []*protocol.Event{
		batchEvent(id1, "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "B"),
		batchEvent(id2, "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "B"),
	}
	type outcome struct {
		result EventBatchResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wg sync.WaitGroup
	for _, input := range []struct {
		db    *DB
		batch []*protocol.Event
	}{{firstDB, batchA}, {secondDB, batchB}} {
		wg.Add(1)
		go func(db *DB, batch []*protocol.Event) {
			defer wg.Done()
			<-start
			result, err := db.AppendEventsAtomic(context.Background(), batch)
			outcomes <- outcome{result: result, err: err}
		}(input.db, input.batch)
	}
	close(start)
	wg.Wait()
	close(outcomes)
	successes, conflicts := 0, 0
	for outcome := range outcomes {
		switch {
		case outcome.err == nil && outcome.result.Inserted == 2:
			successes++
		case errors.Is(outcome.err, ErrEventConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent conflict outcome: result=%+v err=%v", outcome.result, outcome.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	stored, err := firstDB.ListEvents(context.Background())
	if err != nil || len(stored) != 2 {
		t.Fatalf("stored=%+v err=%v", stored, err)
	}
	var marker string
	for i, event := range stored {
		var payload struct {
			Marker string `json:"marker"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			marker = payload.Marker
		} else if payload.Marker != marker {
			t.Fatalf("mixed concurrent winner payloads: %q and %q", marker, payload.Marker)
		}
	}
}

func TestAppendEventsAtomicCanceledWaiterLeavesDatabaseEmpty(t *testing.T) {
	firstDB, secondDB := openTwoEventBatchDBs(t)
	conn, err := firstDB.sql.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
		}
	}()
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		_, err := secondDB.AppendEventsAtomic(ctx, []*protocol.Event{
			batchEvent(ids.Event(), "ws_one", "ses_one", protocol.ProviderClaude, "native-one", "waiter"),
		})
		done <- err
	}()
	<-started
	select {
	case err := <-done:
		t.Fatalf("waiter returned while competing writer lock was held: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled waiter succeeded")
		}
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled waiter error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter did not return promptly")
	}
	if _, err := conn.ExecContext(context.Background(), "ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	n, _ := firstDB.EventCount(context.Background())
	if n != 0 {
		t.Fatalf("canceled waiter wrote %d events", n)
	}
}
