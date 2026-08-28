package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func boolPtr(b bool) *bool { return &b }

func openDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "obs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func obsRows() []ObsRow {
	base := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC).UnixNano()
	return []ObsRow{
		{SpanID: "spn_a", TraceID: "trc_a", SessionID: "ses_a", WorkstreamID: "ws_a",
			Provider: "otlp", Agent: "codex-cli", Model: "gpt-5.3", Kind: "MODEL",
			Name: "chat", Status: "ok", StartedAtNS: base, EndedAtNS: base + 1e9,
			DurationNS: 1e9, Sequence: 1, Fingerprint: "fp1", Failed: false},
		{SpanID: "spn_b", TraceID: "trc_b", SessionID: "ses_a", WorkstreamID: "ws_a",
			Provider: "otlp", Agent: "codex-cli", Model: "gpt-5.3", Kind: "MODEL",
			Name: "chat", Status: "error", StartedAtNS: base + int64(400e9), EndedAtNS: base + int64(401e9),
			DurationNS: 1e9, Sequence: 2, Fingerprint: "fp1", Failed: true},
		{SpanID: "spn_c", TraceID: "trc_c", SessionID: "ses_b", WorkstreamID: "ws_b",
			Provider: "claude", Agent: "claude-code", Model: "opus", Kind: "TOOL",
			Name: "apply_patch", Status: "ok", StartedAtNS: base + int64(800e9),
			EndedAtNS: base + int64(801e9), DurationNS: 1e9, Sequence: 3,
			Fingerprint: "fp2", ToolName: "apply_patch"},
	}
}

func TestBucketOf(t *testing.T) {
	ns := time.Date(2026, 8, 28, 10, 7, 0, 0, time.UTC).UnixNano()
	if BucketOf(ns) != BucketOf(ns+int64(60e9)) {
		t.Fatal("times in the same 5-minute window must share a bucket")
	}
	if BucketOf(ns) == BucketOf(ns+int64(301e9)) {
		t.Fatal("times across a bucket boundary must differ")
	}
	if BucketOf(0) != 0 {
		t.Fatal("epoch must land in bucket 0")
	}
}

// snapshot reads the live event-log counters so test metas match reality.
func snapshot(t *testing.T, db *DB) ObsMeta {
	t.Helper()
	var count, maxSeq int64
	if err := db.sql.QueryRow(`SELECT COUNT(*), COALESCE(MAX(seq),0) FROM events`).Scan(&count, &maxSeq); err != nil {
		t.Fatal(err)
	}
	return ObsMeta{EventCount: count, MaxSeq: maxSeq, RebuiltAt: time.Now().UTC()}
}

func TestRebuildAndQueryObservations(t *testing.T) {
	db := openDB(t)
	ctx := context.Background()
	rows := obsRows()
	fps := []ObsFingerprint{{Fingerprint: "fp1", Provider: "otlp", Agent: "codex-cli", Model: "gpt-5.3"}}
	if err := db.RebuildObservations(ctx, rows, fps, snapshot(t, db)); err != nil {
		t.Fatal(err)
	}

	// Idempotent rebuild: same rows twice leaves the same table.
	if err := db.RebuildObservations(ctx, rows, fps, snapshot(t, db)); err != nil {
		t.Fatal(err)
	}

	stale, err := db.ObservationsStale(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("freshly rebuilt index must not be stale")
	}

	// ts_bucket pruning: a window that only covers the first span (plus the
	// one-bucket slack before it) must not return the later spans.
	base := rows[0].StartedAtNS
	got, err := db.QueryObservations(ctx, ObsFilter{FromNS: base, ToNS: base + int64(10e9)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SpanID != "spn_a" {
		t.Fatalf("bucket-pruned query = %+v", got)
	}

	// Slack: a window starting 1ns into the second bucket still includes
	// spans from the bucket before it.
	got, err = db.QueryObservations(ctx, ObsFilter{FromNS: base + int64(301e9), ToNS: base + int64(810e9)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("slack query = %d rows, want 2", len(got))
	}

	// Promoted-column filters.
	got, err = db.QueryObservations(ctx, ObsFilter{Agent: "codex-cli", Failed: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SpanID != "spn_b" {
		t.Fatalf("failed+agent query = %+v", got)
	}
	got, err = db.QueryObservations(ctx, ObsFilter{WorkstreamID: "ws_b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SpanID != "spn_c" || got[0].ToolName != "apply_patch" {
		t.Fatalf("workstream query = %+v", got)
	}

	// Fingerprint pruning path.
	got, err = db.QueryObservations(ctx, ObsFilter{Fingerprint: "fp1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("fingerprint query = %d rows, want 2", len(got))
	}

	prints, err := db.ListFingerprints(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(prints) != 1 || prints[0].Fingerprint != "fp1" {
		t.Fatalf("fingerprints = %+v", prints)
	}
}

func TestObservationsStaleAfterAppend(t *testing.T) {
	db := openDB(t)
	ctx := context.Background()
	if err := db.RebuildObservations(ctx, nil, nil, snapshot(t, db)); err != nil {
		t.Fatal(err)
	}
	stale, err := db.ObservationsStale(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("empty log with matching snapshot must not be stale")
	}
	// Simulate the log moving: append an event via the normal path.
	now := time.Now().UTC()
	if _, err := db.AppendEvent(ctx, &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    now,
		ObservedAt:    now,
		Kind:          protocol.EventLogObserved,
		Provenance:    protocol.ProvenanceObserved,
	}); err != nil {
		t.Fatal(err)
	}
	stale, err = db.ObservationsStale(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !stale {
		t.Fatal("index must go stale after a new append")
	}
}
