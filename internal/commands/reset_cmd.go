package commands

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
)

// derivedTables lists every purely-derived SQL table `reset` clears by
// default: read models and caches rebuildable from the append-only event
// log, never the log itself. Probed via storage.DB.TableExists before
// deleting rather than assumed present — some names here are
// forward-looking schema surfaces (e.g. exception_groups) this build does
// not populate yet, and probing keeps `reset` correct as the schema grows
// without needing to track every migration that has landed.
var derivedTables = []string{
	"traces", "spans", "graph_nodes", "graph_edges",
	"span_observations", "span_fingerprints",
	"exception_groups", "verify_results",
}

// RegisterResetCmd registers the one-command local clean-reset (parity row
// 52): by default it clears only derived read models and caches and
// rebuilds the observations index, leaving the event log untouched;
// --hard additionally wipes the entire local data directory, including
// events, and refuses to run without --yes.
func RegisterResetCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "reset",
		Summary: "Clear derived read models and caches, or (--hard --yes) wipe the local data directory entirely",
		Usage:   "[--hard --yes] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.Bool("hard", false, "also delete the event log and the entire local data directory (requires --yes)")
			fs.Bool("yes", false, "confirm a --hard reset; required, not implied by --hard alone")
			fs.Bool("json", false, "emit JSON")
		},
		Run: resetCmd,
	})
}

// resetReport is the structured `reset` output.
type resetReport struct {
	Hard                bool     `json:"hard"`
	ClearedTables       []string `json:"cleared_tables,omitempty"`
	RebuiltObservations int      `json:"rebuilt_observations,omitempty"`
	WipedDataDir        string   `json:"wiped_data_dir,omitempty"`
}

func resetCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	hard := boolFlag(fs, "hard")
	asJSON := boolFlag(fs, "json")

	if hard {
		// Fail-closed: refuse before touching the filesystem at all when
		// confirmation is missing.
		if !boolFlag(fs, "yes") {
			return fmt.Errorf("reset --hard requires --yes: it deletes the entire local data directory, including the event log, and cannot be undone")
		}
		return resetHard(c, asJSON)
	}
	return resetDerivedOnly(ctx, c, asJSON)
}

// resetDerivedOnly clears every derived table that exists, then rebuilds
// the observations index from the surviving (untouched) event log.
func resetDerivedOnly(ctx context.Context, c *cli.Context, asJSON bool) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	var report resetReport
	for _, name := range derivedTables {
		exists, err := db.TableExists(ctx, name)
		if err != nil {
			return fmt.Errorf("probe table %s: %w", name, err)
		}
		if !exists {
			continue
		}
		if err := db.ClearTable(ctx, name); err != nil {
			return fmt.Errorf("clear table %s: %w", name, err)
		}
		report.ClearedTables = append(report.ClearedTables, name)
	}

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	n, err := rebuildObservations(ctx, db, events)
	if err != nil {
		return fmt.Errorf("rebuild observations: %w", err)
	}
	report.RebuiltObservations = n

	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Fprintf(c.Stdout, "reset: cleared %d derived table(s): %v\n", len(report.ClearedTables), report.ClearedTables)
	fmt.Fprintf(c.Stdout, "reset: rebuilt %d observation(s) from %d event(s) — the event log was not touched\n", n, len(events))
	return nil
}

// hardResetTarget resolves the one directory `reset --hard` is allowed to
// wipe, or refuses.
//
// The rule it enforces is that the directory must demonstrably *be* the
// store this config points at: an absolute path that actually holds
// cfg.DBPath. That is what makes the command's "events and all derived data
// removed" claim true. A config whose data_dir and db_path describe
// different places used to make the claim a lie in the most expensive
// direction — the recursive delete landed on data_dir while the event log
// sat safely at db_path — so the two must agree before anything is removed.
//
// Every check fails closed: on any doubt it returns an error naming the
// absolute resolved path, never a wider delete. The returned path is
// absolute but symlink-preserving (the form the user configured); the
// symlink-resolved form is used only for the boundary comparisons, so a
// data_dir that is a symlink is judged by where it actually lands.
func hardResetTarget(cfg *config.Config) (string, error) {
	if cfg.DataDir == "" {
		return "", fmt.Errorf("reset --hard: refusing to act, data_dir is empty")
	}

	abs, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return "", fmt.Errorf("reset --hard: refusing to act, cannot resolve data_dir %q: %w", cfg.DataDir, err)
	}
	if !filepath.IsAbs(cfg.DataDir) {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — data_dir %q is a relative path, so it means whatever directory the command happens to run from; set an absolute data_dir", abs, cfg.DataDir)
	}

	realDataDir, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — cannot resolve it on disk: %w", abs, err)
	}
	if parent := filepath.Dir(realDataDir); parent == realDataDir {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — that is a filesystem root", abs)
	}
	// A cwd that cannot be resolved is one that no longer exists, so it
	// cannot be the directory about to be emptied either.
	if cwd, err := os.Getwd(); err == nil {
		if realCwd, err := filepath.EvalSymlinks(cwd); err == nil && realCwd == realDataDir {
			return "", fmt.Errorf("reset --hard: refusing to wipe %s — that is the current working directory, not a dedicated data directory", abs)
		}
	}
	// .git may be a directory (normal clone) or a file (worktree/submodule);
	// Lstat catches both, and anything other than a clean "not there" is
	// treated as present so an unreadable entry cannot open the gate.
	if _, err := os.Lstat(filepath.Join(realDataDir, ".git")); !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — it contains .git, so it is a working tree rather than a data directory", abs)
	}

	// The store itself must live inside the directory we are about to empty.
	// Without this a config that moved data_dir while leaving db_path behind
	// would delete an unrelated directory and leave the events untouched.
	dbPath, err := filepath.Abs(cfg.DBPath)
	if err != nil {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — cannot resolve db_path %q: %w", abs, cfg.DBPath, err)
	}
	realDBDir, err := filepath.EvalSymlinks(filepath.Dir(dbPath))
	if err != nil || !containedIn(realDataDir, realDBDir) {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — the event store this config points at lives at %s, outside that directory; wiping it would destroy unrelated files and leave the events behind", abs, dbPath)
	}
	if st, err := os.Stat(dbPath); err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("reset --hard: refusing to wipe %s — it holds no event store at %s, so it is not this config's data directory", abs, dbPath)
	}

	return abs, nil
}

// containedIn reports whether p is root or lives beneath it. Both paths must
// already be absolute and symlink-resolved.
func containedIn(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resetHard wipes the local data directory. It only ever removes paths it
// has joined under the directory hardResetTarget cleared, never
// cfg.ObjectDir/LogDir/CacheDir as independently configured paths, so a
// config that points one of those outside the data directory is never
// reached — the safe, narrower behavior when there is any doubt about a
// path's boundary.
func resetHard(c *cli.Context, asJSON bool) error {
	cfg, err := config.Load(".")
	if err != nil {
		return err
	}
	dataDir, err := hardResetTarget(cfg)
	if err != nil {
		return err
	}

	entries, err := os.ReadDir(dataDir)
	if err != nil {
		if os.IsNotExist(err) {
			entries = nil // nothing to wipe: an empty directory is a valid reset outcome
		} else {
			return fmt.Errorf("read data dir %s: %w", dataDir, err)
		}
	}
	for _, e := range entries {
		p := filepath.Join(dataDir, e.Name())
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("remove %s: %w", p, err)
		}
	}

	report := resetReport{Hard: true, WipedDataDir: dataDir}
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Fprintf(c.Stdout, "reset --hard: wiped %s (events and all derived data removed)\n", dataDir)
	return nil
}
