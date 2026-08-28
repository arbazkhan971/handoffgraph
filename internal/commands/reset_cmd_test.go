package commands

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

func TestResetDerivedOnlyKeepsEventsAndRebuilds(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_reset", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	// Warm the verify cache so we can prove reset actually clears it.
	if _, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_reset", "--json"); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	out, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_reset", "--json")
	if err != nil {
		t.Fatalf("second verify: %v", err)
	}
	var warm verifyReport
	if err := json.Unmarshal([]byte(out), &warm); err != nil {
		t.Fatal(err)
	}
	if !warm.Cached {
		t.Fatal("setup: expected the verify cache to be warm before reset")
	}

	db := openCommandDB(t)
	before, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	resetOut, _, err := runRegisteredApp(app, "reset", "--json")
	if err != nil {
		t.Fatalf("reset: %v\n%s", err, resetOut)
	}
	var report resetReport
	if err := json.Unmarshal([]byte(resetOut), &report); err != nil {
		t.Fatalf("decode reset report: %v\n%s", err, resetOut)
	}
	if report.Hard {
		t.Fatal("plain reset reported hard=true")
	}
	wantCleared := map[string]bool{
		"traces": true, "spans": true, "graph_nodes": true, "graph_edges": true,
		"span_observations": true, "span_fingerprints": true, "verify_results": true,
		"exception_groups": true,
	}
	if len(report.ClearedTables) != len(wantCleared) {
		t.Fatalf("cleared tables = %v, want exactly %v", report.ClearedTables, wantCleared)
	}
	for _, name := range report.ClearedTables {
		if !wantCleared[name] {
			t.Errorf("unexpected table cleared: %q", name)
		}
	}

	// The event log must survive untouched.
	db2 := openCommandDB(t)
	defer db2.Close()
	after, err := db2.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("event count changed by reset: before=%d after=%d", before, after)
	}

	// The verify cache must have been invalidated by the reset, even though
	// no new event landed: checks must recompute (and, since the same
	// evidence is still there, still pass).
	out2, _, err := runRegisteredApp(app, "verify", "--workstream", "ws_reset", "--json")
	if err != nil {
		t.Fatalf("verify after reset: %v\n%s", err, out2)
	}
	var afterReset verifyReport
	if err := json.Unmarshal([]byte(out2), &afterReset); err != nil {
		t.Fatal(err)
	}
	if afterReset.Cached {
		t.Fatal("verify cache must be cold immediately after reset")
	}
	if !afterReset.Passed {
		t.Fatalf("checks should still pass after reset: %+v", afterReset)
	}
}

func TestResetHardWithoutYesRefused(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_hard", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	_, _, err := runRegisteredApp(app, "reset", "--hard")
	if err == nil {
		t.Fatal("reset --hard without --yes: want a refusal error, got nil")
	}

	// Fail-closed: nothing must have been touched.
	db := openCommandDB(t)
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("reset --hard without --yes must not have wiped the data directory")
	}
}

func TestResetHardWithYesWipesDataDir(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_hard2", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)
	dataDir := config.UserDataDir()

	entriesBefore, err := os.ReadDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entriesBefore) == 0 {
		t.Fatal("setup: expected the data dir to be non-empty before --hard reset")
	}

	out, _, err := runRegisteredApp(app, "reset", "--hard", "--yes", "--json")
	if err != nil {
		t.Fatalf("reset --hard --yes: %v\n%s", err, out)
	}
	var report resetReport
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if !report.Hard || report.WipedDataDir != dataDir {
		t.Fatalf("report = %+v, want hard=true wiped_data_dir=%q", report, dataDir)
	}

	entriesAfter, err := os.ReadDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entriesAfter) != 0 {
		t.Fatalf("data dir not empty after --hard reset: %v", entriesAfter)
	}

	// A fresh open at the same path must behave like a brand-new store.
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("reopen after hard reset: %v", err)
	}
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("event count after hard reset + reopen = %d, want 0", n)
	}
}

func TestResetHardRefusesOutsideDataDirNeverTouched(t *testing.T) {
	// A sibling directory next to the isolated data dir must survive a
	// --hard reset untouched: reset only ever removes paths joined under
	// cfg.DataDir.
	isolateDataDir(t)
	app := newRegisteredApp(t)
	dataDir := config.UserDataDir()

	sibling := filepath.Join(filepath.Dir(dataDir), "sibling-must-survive")
	if err := os.MkdirAll(sibling, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(sibling, "marker.txt")
	if err := os.WriteFile(marker, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, _, err := runRegisteredApp(app, "reset", "--hard", "--yes"); err != nil {
		t.Fatalf("reset --hard --yes: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("sibling file outside the data dir was touched by --hard reset: %v", err)
	}
}
