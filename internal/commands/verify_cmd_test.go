package commands

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// seedVerifyTrace appends a closed trace with one command span (exit code
// exitCode) to workstream ws, so the default check set has evidence to
// evaluate: a clean run makes every check pass.
func seedVerifyTrace(t *testing.T, db *storage.DB, ws, traceID string, exitCode int, at time.Time) {
	t.Helper()
	rows := []struct {
		kind    protocol.EventKind
		payload map[string]any
	}{
		{protocol.EventTraceStarted, map[string]any{"trace_id": traceID, "objective": "verify fixture"}},
		{protocol.EventCommandCompleted, map[string]any{"trace_id": traceID, "command": "go test ./...", "exit_code": exitCode}},
		{protocol.EventTraceCompleted, map[string]any{"trace_id": traceID}},
	}
	for i, row := range rows {
		payload, _ := json.Marshal(row.payload)
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    at.Add(time.Duration(i) * time.Second),
			ObservedAt:    at.Add(time.Duration(i) * time.Second),
			WorkstreamID:  ws,
			Provider:      protocol.ProviderCodex,
			Kind:          row.kind,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       payload,
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatalf("seed event %d: %v", i, err)
		}
	}
}

// appendRawEvent opens the same database the CLI commands open (HFG_DATA_DIR
// must already be set by the caller) and appends one event directly,
// bypassing any command. Used to simulate activity between two `verify`
// invocations within a single test.
func appendRawEvent(t *testing.T, ws string, kind protocol.EventKind, payload map[string]any, at time.Time) {
	t.Helper()
	db := openCommandDB(t)
	defer db.Close()
	raw, _ := json.Marshal(payload)
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    at,
		ObservedAt:    at,
		WorkstreamID:  ws,
		Provider:      protocol.ProviderCodex,
		Kind:          kind,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       raw,
	}
	if _, err := db.AppendEvent(context.Background(), ev); err != nil {
		t.Fatalf("append raw event: %v", err)
	}
}

func TestVerifySecondRunHitsCacheWithIdenticalChecks(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_cache", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	out1, errOut1, err := runRegisteredApp(app, "verify", "--workstream", "ws_cache", "--json")
	if err != nil {
		t.Fatalf("first verify: %v\n%s%s", err, out1, errOut1)
	}
	var r1 verifyReport
	if err := json.Unmarshal([]byte(out1), &r1); err != nil {
		t.Fatalf("decode first report: %v\n%s", err, out1)
	}
	if r1.Cached {
		t.Fatal("first run must be a cache miss (nothing cached yet)")
	}
	if !r1.Passed {
		t.Fatalf("first run expected to pass: %+v", r1)
	}

	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_cache", "--json")
	if err != nil {
		t.Fatalf("second verify: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatalf("decode second report: %v\n%s", err, out2)
	}
	if !r2.Cached {
		t.Fatal("second run must hit the cache: no non-verification event was added between runs")
	}
	if !r2.Passed {
		t.Fatalf("second run expected to pass: %+v", r2)
	}

	c1, _ := json.Marshal(r1.Checks)
	c2, _ := json.Marshal(r2.Checks)
	if string(c1) != string(c2) {
		t.Fatalf("checks differ between cache miss and cache hit:\nfirst:  %s\nsecond: %s", c1, c2)
	}
}

func TestVerifyRealEventInvalidatesCache(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_inval", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	out1, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_inval", "--json")
	if err != nil {
		t.Fatalf("first verify: %v\n%s", err, out1)
	}
	var r1 verifyReport
	if err := json.Unmarshal([]byte(out1), &r1); err != nil {
		t.Fatal(err)
	}
	if r1.Cached {
		t.Fatal("first run must be a cache miss")
	}
	if !r1.Passed {
		t.Fatalf("first run expected to pass: %+v", r1)
	}

	// A real, non-verification event lands on the same workstream: a failing
	// command. This must invalidate the cache and flip commands_ok.
	appendRawEvent(t, "ws_inval", protocol.EventCommandCompleted,
		map[string]any{"trace_id": "trc_1", "command": "go build ./...", "exit_code": 1},
		time.Date(2026, 8, 20, 9, 5, 0, 0, time.UTC))

	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_inval", "--json")
	if err != nil {
		t.Fatalf("second verify: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatal(err)
	}
	if r2.Cached {
		t.Fatal("a new command event on the same workstream must invalidate the cache")
	}
	if r2.Passed {
		t.Fatalf("second run must fail: the new command exited non-zero: %+v", r2)
	}
	found := false
	for _, ck := range r2.Checks {
		if ck.Name == "commands_ok" {
			found = true
			if ck.Passed {
				t.Errorf("commands_ok expected to fail after the new failing command: %+v", ck)
			}
		}
	}
	if !found {
		t.Fatal("commands_ok check missing from report")
	}
}

func TestVerifyVerificationRecordedDoesNotInvalidateCache(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_verev", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	out1, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_verev", "--json")
	if err != nil {
		t.Fatalf("first verify: %v\n%s", err, out1)
	}
	var r1 verifyReport
	if err := json.Unmarshal([]byte(out1), &r1); err != nil {
		t.Fatal(err)
	}

	// Directly append an extra verification.recorded event, simulating
	// evidence from another tool (e.g. the MCP record_verification tool)
	// rather than from `verify` itself. This must not count toward the
	// cache fingerprint either.
	appendRawEvent(t, "ws_verev", protocol.EventVerificationRecorded,
		map[string]any{"verification": "manual check", "result": "passed"},
		time.Date(2026, 8, 20, 9, 6, 0, 0, time.UTC))

	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_verev", "--json")
	if err != nil {
		t.Fatalf("second verify: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatal(err)
	}
	if !r2.Cached {
		t.Fatal("a verification.recorded event (verify's own evidence trail) must not invalidate the cache")
	}

	c1, _ := json.Marshal(r1.Checks)
	c2, _ := json.Marshal(r2.Checks)
	if string(c1) != string(c2) {
		t.Fatalf("checks changed across a verification.recorded-only gap:\n%s\n%s", c1, c2)
	}
}

func TestVerifyNoCacheBypasses(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_nocache", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	out1, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_nocache", "--json")
	if err != nil {
		t.Fatalf("first verify: %v\n%s", err, out1)
	}

	// A cache entry now exists. --no-cache must force a recompute anyway.
	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_nocache", "--json", "--no-cache")
	if err != nil {
		t.Fatalf("--no-cache verify: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatal(err)
	}
	if r2.Cached {
		t.Fatal("--no-cache must force a fresh computation even with a valid cache entry")
	}

	// A plain run right after must still hit the cache normally: --no-cache
	// does not poison or disable caching going forward.
	out3, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_nocache", "--json")
	if err != nil {
		t.Fatalf("post no-cache verify: %v\n%s", err, out3)
	}
	var r3 verifyReport
	if err := json.Unmarshal([]byte(out3), &r3); err != nil {
		t.Fatal(err)
	}
	if !r3.Cached {
		t.Fatal("a normal run after --no-cache must hit the cache it just rewrote")
	}
}

func TestVerifyBaselinePathStaysExactAcrossCache(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_base", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	cpOut, _, err := runRegisteredApp(app, "checkpoint", "--workstream", "ws_base", "--objective", "baseline check")
	if err != nil {
		t.Fatalf("checkpoint: %v\n%s", err, cpOut)
	}
	var cp protocol.Checkpoint
	if err := json.Unmarshal([]byte(cpOut), &cp); err != nil {
		t.Fatalf("decode checkpoint: %v\n%s", err, cpOut)
	}
	if cp.CheckpointID == "" {
		t.Fatalf("checkpoint id empty: %+v", cp)
	}

	out1, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_base", "--baseline", cp.CheckpointID, "--json")
	if err != nil {
		t.Fatalf("first verify --baseline: %v\n%s", err, out1)
	}
	var r1 verifyReport
	if err := json.Unmarshal([]byte(out1), &r1); err != nil {
		t.Fatal(err)
	}
	if r1.Cached {
		t.Fatal("first baseline run must be a cache miss")
	}
	if r1.BaselineID != cp.CheckpointID {
		t.Fatalf("baseline id = %q, want %q", r1.BaselineID, cp.CheckpointID)
	}
	if r1.NewFailures != 0 {
		t.Fatalf("no events landed after the baseline yet: new_failures = %d", r1.NewFailures)
	}
	if r1.ScoreDelta != 0 {
		// applyBaseline carries the baseline's objective into the comparison
		// build; a baseline recorded with --objective must not register a
		// spurious objective-point regression against an unchanged log.
		t.Fatalf("unchanged log vs objective-bearing baseline: score_delta = %d, want 0", r1.ScoreDelta)
	}

	// A new failing command lands strictly after the baseline checkpoint was
	// recorded.
	appendRawEvent(t, "ws_base", protocol.EventCommandCompleted,
		map[string]any{"trace_id": "trc_1", "command": "go vet ./...", "exit_code": 1},
		time.Now().UTC())

	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_base", "--baseline", cp.CheckpointID, "--json")
	if err != nil {
		t.Fatalf("second verify --baseline: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatal(err)
	}
	if r2.Cached {
		t.Fatal("the new command event must invalidate the check cache too")
	}
	if r2.NewFailures == 0 {
		t.Fatalf("expected a new observed failure after the baseline: %+v", r2)
	}
	if r2.BaselineID != cp.CheckpointID {
		t.Fatalf("baseline id = %q, want %q", r2.BaselineID, cp.CheckpointID)
	}
}

// TestVerifyBaselineStaysCorrectOnCacheHit exercises the shared
// trace.Materialize path specifically: a cache hit skips runVerifyChecks
// entirely (so it never touches the materialize result), yet applyBaseline
// is unconditional and still needs it — this is exactly the "pass the
// first Materialize result into applyBaseline" fix, and it must keep
// working once checks start coming from cache.
//
// The baseline checkpoint is built with no --objective here so the test
// exercises the objective-free comparison path too (the objective-bearing
// path is pinned by TestVerifyBaselinePathStaysExactAcrossCache).
func TestVerifyBaselineStaysCorrectOnCacheHit(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_base_cache", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	cpOut, _, err := runRegisteredApp(app, "checkpoint", "--workstream", "ws_base_cache")
	if err != nil {
		t.Fatalf("checkpoint: %v\n%s", err, cpOut)
	}
	var cp protocol.Checkpoint
	if err := json.Unmarshal([]byte(cpOut), &cp); err != nil {
		t.Fatalf("decode checkpoint: %v\n%s", err, cpOut)
	}

	out1, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_base_cache", "--baseline", cp.CheckpointID, "--json")
	if err != nil {
		t.Fatalf("first verify --baseline: %v\n%s", err, out1)
	}
	var r1 verifyReport
	if err := json.Unmarshal([]byte(out1), &r1); err != nil {
		t.Fatal(err)
	}
	if r1.Cached {
		t.Fatal("first run must be a cache miss")
	}

	// Nothing changed since: the second run must hit the check cache while
	// --baseline is still supplied, so applyBaseline runs against the
	// shared (not recomputed) materialize result.
	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_base_cache", "--baseline", cp.CheckpointID, "--json")
	if err != nil {
		t.Fatalf("second verify --baseline: %v\n%s", err, out2)
	}
	var r2 verifyReport
	if err := json.Unmarshal([]byte(out2), &r2); err != nil {
		t.Fatal(err)
	}
	if !r2.Cached {
		t.Fatal("second run must hit the check cache: nothing changed")
	}
	if r2.BaselineID != cp.CheckpointID {
		t.Fatalf("baseline id = %q, want %q (baseline must still resolve on a cache hit)", r2.BaselineID, cp.CheckpointID)
	}
	if r2.NewFailures != 0 {
		t.Fatalf("no failing evidence landed after the baseline: new_failures = %d", r2.NewFailures)
	}
	if !r2.Passed {
		t.Fatalf("expected the gate to still pass on a cache hit with a baseline: %+v", r2)
	}
}

func TestVerifyUnknownWorkstreamRejected(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	_, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_missing")
	if err == nil {
		t.Fatal("verify on an unknown workstream: want an error, got nil")
	}
}

func TestVerifyMissingWorkstreamFlag(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	_, _, err := runRegisteredApp(app, "verify")
	if err == nil {
		t.Fatal("verify without --workstream: want an error, got nil")
	}
}
