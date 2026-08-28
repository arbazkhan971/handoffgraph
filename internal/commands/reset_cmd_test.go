package commands

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_sibling", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
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

// writeRepoConfig drops a repository-scoped .handoffgraph.toml into dir.
func writeRepoConfig(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, config.RepoConfigName), []byte(body), 0o600); err != nil {
		t.Fatalf("write repo config: %v", err)
	}
}

// makeWorkingTree builds a directory that looks like a checkout the user
// would be standing in: a .git entry and a sentinel file that must never be
// removed by any reset.
func makeWorkingTree(t *testing.T) (dir, sentinel, gitDir string) {
	t.Helper()
	dir = t.TempDir()
	gitDir = filepath.Join(dir, ".git")
	if err := os.MkdirAll(filepath.Join(gitDir, "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sentinel = filepath.Join(dir, "SENTINEL.txt")
	if err := os.WriteFile(sentinel, []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, sentinel, gitDir
}

func assertWorkingTreeIntact(t *testing.T, sentinel, gitDir string) {
	t.Helper()
	if b, err := os.ReadFile(sentinel); err != nil || string(b) != "must survive" {
		t.Fatalf("sentinel %s destroyed by reset --hard (content=%q err=%v)", sentinel, b, err)
	}
	if st, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil || st.IsDir() {
		t.Fatalf("%s/HEAD destroyed by reset --hard (err=%v)", gitDir, err)
	}
}

// eventsInStore reopens the real store and reports how many events survived.
func eventsInStore(t *testing.T, dbPath string) int64 {
	t.Helper()
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen store %s: %v", dbPath, err)
	}
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatalf("count events: %v", err)
	}
	return n
}

// TestResetHardRefusesRelativeDataDirFromRepoConfig is the P0 regression: a
// committed or stale .handoffgraph.toml with data_dir = "." made `reset
// --hard --yes` recursively remove every entry of the process working
// directory — the user's checkout, .git included — while the store the
// config's un-overridden db_path pointed at survived and the command still
// claimed "events and all derived data removed".
func TestResetHardRefusesRelativeDataDirFromRepoConfig(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_dot", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	realDataDir := config.UserDataDir()
	realDB := filepath.Join(realDataDir, "handoffgraph.db")
	before := eventsInStore(t, realDB)
	if before == 0 {
		t.Fatal("setup: expected seeded events in the real store")
	}

	work, sentinel, gitDir := makeWorkingTree(t)
	writeRepoConfig(t, work, "data_dir = \".\"\n")
	t.Chdir(work)

	app := newRegisteredApp(t)
	out, _, err := runRegisteredApp(app, "reset", "--hard", "--yes")
	if err == nil {
		t.Fatalf("reset --hard --yes with data_dir=\".\": want a refusal, got success\n%s", out)
	}
	if !strings.Contains(err.Error(), work) && !strings.Contains(err.Error(), mustEvalSymlinks(t, work)) {
		t.Errorf("refusal must name the absolute resolved path %q, got: %v", work, err)
	}
	assertWorkingTreeIntact(t, sentinel, gitDir)
	if got := eventsInStore(t, realDB); got != before {
		t.Fatalf("event count changed by a refused reset: before=%d after=%d", before, got)
	}
}

// TestResetHardRefusesAbsoluteDataDirWithoutStore covers the other half of
// the split: an absolute data_dir that does not actually hold the store this
// config points at must be refused, whether db_path was pinned elsewhere or
// simply has no database under the directory.
func TestResetHardRefusesAbsoluteDataDirWithoutStore(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_split", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	realDataDir := config.UserDataDir()
	realDB := filepath.Join(realDataDir, "handoffgraph.db")
	before := eventsInStore(t, realDB)

	// A foreign directory holding files that are not ours.
	foreign := t.TempDir()
	keep := filepath.Join(foreign, "not-ours.txt")
	if err := os.WriteFile(keep, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		body string
	}{
		{
			// db_path pinned at the real store, data_dir pointed elsewhere:
			// filepath.Dir(db_path) is not inside data_dir.
			name: "db_path outside data_dir",
			body: "data_dir = " + strconv.Quote(foreign) + "\ndb_path = " + strconv.Quote(realDB) + "\n",
		},
		{
			// data_dir alone: the store re-derives under it, and no database
			// exists there, so the directory does not hold this config's store.
			name: "no store under data_dir",
			body: "data_dir = " + strconv.Quote(foreign) + "\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			work := t.TempDir()
			writeRepoConfig(t, work, tc.body)
			t.Chdir(work)

			app := newRegisteredApp(t)
			out, _, err := runRegisteredApp(app, "reset", "--hard", "--yes")
			if err == nil {
				t.Fatalf("reset --hard --yes: want a refusal, got success\n%s", out)
			}
			if !strings.Contains(err.Error(), foreign) && !strings.Contains(err.Error(), mustEvalSymlinks(t, foreign)) {
				t.Errorf("refusal must name the absolute resolved path %q, got: %v", foreign, err)
			}
			if _, err := os.Stat(keep); err != nil {
				t.Fatalf("foreign directory was wiped by a refused reset: %v", err)
			}
		})
	}

	if got := eventsInStore(t, realDB); got != before {
		t.Fatalf("event count changed by refused resets: before=%d after=%d", before, got)
	}
}

// TestResetHardRefusesProcessWorkingDirectory pins the cwd/.git guards
// independently of how the path was spelled: even an absolute data_dir is
// refused when it resolves to the directory the command was run from or to a
// git worktree root.
func TestResetHardRefusesProcessWorkingDirectory(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedVerifyTrace(t, db, "ws_cwd", "trc_1", 0, time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC))
	})
	work, sentinel, gitDir := makeWorkingTree(t)
	// Absolute, and it even holds a database file, so only the cwd/.git
	// guards can save it.
	if err := os.WriteFile(filepath.Join(work, "handoffgraph.db"), []byte("not a real db"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRepoConfig(t, work, "data_dir = "+strconv.Quote(work)+"\n")
	t.Chdir(work)

	app := newRegisteredApp(t)
	out, _, err := runRegisteredApp(app, "reset", "--hard", "--yes")
	if err == nil {
		t.Fatalf("reset --hard --yes on the process working directory: want a refusal, got success\n%s", out)
	}
	assertWorkingTreeIntact(t, sentinel, gitDir)
}

func mustEvalSymlinks(t *testing.T, p string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return p
	}
	return resolved
}
