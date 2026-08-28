package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

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

// resetHard wipes the local data directory: it only ever removes paths it
// has joined under cfg.DataDir itself, never cfg.ObjectDir/LogDir/CacheDir
// as independently configured paths, so a config that points one of those
// outside the data directory is never reached — the safe, narrower
// behavior when there is any doubt about a path's boundary.
func resetHard(c *cli.Context, asJSON bool) error {
	cfg, err := config.Load(".")
	if err != nil {
		return err
	}
	if cfg.DataDir == "" {
		return fmt.Errorf("reset --hard: refusing to act, data_dir is empty")
	}

	entries, err := os.ReadDir(cfg.DataDir)
	if err != nil {
		if os.IsNotExist(err) {
			entries = nil // nothing to wipe: an empty directory is a valid reset outcome
		} else {
			return fmt.Errorf("read data dir %s: %w", cfg.DataDir, err)
		}
	}
	for _, e := range entries {
		p := filepath.Join(cfg.DataDir, e.Name())
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("remove %s: %w", p, err)
		}
	}

	report := resetReport{Hard: true, WipedDataDir: cfg.DataDir}
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Fprintf(c.Stdout, "reset --hard: wiped %s (events and all derived data removed)\n", cfg.DataDir)
	return nil
}
