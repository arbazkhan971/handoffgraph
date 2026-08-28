package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strconv"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/observations"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// RegisterIndexCmd registers the derived wide read model surface (parity
// rows 9-11).
//
// Usage:
//
//	handoffgraph index rebuild          force a deterministic rebuild
//	handoffgraph query spans [...]      ts_bucket-pruned observation queries
//
// The wide table is fully derived and rebuildable; `query` auto-rebuilds
// when the event log has moved past the last snapshot.
func RegisterIndexCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "index",
		Summary: "Rebuild the derived wide observation index",
		Usage:   "rebuild",
		Run:     indexCmd,
	})
	app.Register(&cli.Command{
		Name:    "query",
		Summary: "Query the derived wide observation index",
		Usage: "spans [--workstream <id>] [--trace <id>] [--session <id>] [--agent <a>]\n" +
			"             [--provider <p>] [--model <m>] [--kind <k>] [--failed]\n" +
			"             [--from <rfc3339|unix_ns>] [--to <rfc3339|unix_ns>] [--limit N] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "filter by workstream id")
			fs.String("trace", "", "filter by trace id")
			fs.String("session", "", "filter by session id")
			fs.String("agent", "", "filter by agent name")
			fs.String("provider", "", "filter by provider")
			fs.String("model", "", "filter by model")
			fs.String("kind", "", "filter by span kind (MODEL, TOOL, ...)")
			fs.Bool("failed", false, "only failed spans")
			fs.String("from", "", "window start (RFC3339 or unix nanoseconds)")
			fs.String("to", "", "window end (RFC3339 or unix nanoseconds)")
			fs.Int("limit", 100, "max rows")
			fs.Bool("json", false, "emit JSON")
			fs.String("group-by", "provider", "usage rollup key: provider | session")
		},
		Run: queryCmd,
	})
}

func indexCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) != 1 || args[0] != "rebuild" {
		return fmt.Errorf("usage: index rebuild")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	n, err := rebuildObservations(ctx, db, events)
	if err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "rebuilt %d observation(s) from %d event(s)\n", n, len(events))
	return nil
}

// rebuildObservations derives and persists the wide read model, returning
// the row count.
func rebuildObservations(ctx context.Context, db *storage.DB, events []*protocol.Event) (int, error) {
	rows, prints := observations.Derive(events)
	if err := db.RebuildObservations(ctx, rows, prints, storage.ObsMeta{
		EventCount: int64(len(events)),
		MaxSeq:     maxSeq(events),
		RebuiltAt:  time.Now().UTC(),
	}); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// maxSeq returns the highest append sequence in the log (0 when empty).
func maxSeq(events []*protocol.Event) int64 {
	var max int64
	for _, ev := range events {
		if ev.Sequence > max {
			max = ev.Sequence
		}
	}
	return max
}

func queryCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) >= 1 && args[0] == "usage" {
		return queryUsageCmd(ctx, c, fs)
	}
	if len(args) != 1 || args[0] != "spans" {
		return fmt.Errorf("usage: query spans [...] | query usage [...]")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	// Auto-rebuild when the event log moved past the last snapshot: reads
	// never silently serve a stale index.
	stale, err := db.ObservationsStale(ctx)
	if err != nil {
		return err
	}
	if stale {
		events, err := db.ListEvents(ctx)
		if err != nil {
			return err
		}
		if _, err := rebuildObservations(ctx, db, events); err != nil {
			return err
		}
	}

	f := storage.ObsFilter{
		WorkstreamID: stringFlag(fs, "workstream"),
		TraceID:      stringFlag(fs, "trace"),
		SessionID:    stringFlag(fs, "session"),
		Agent:        stringFlag(fs, "agent"),
		Provider:     stringFlag(fs, "provider"),
		Model:        stringFlag(fs, "model"),
		Kind:         stringFlag(fs, "kind"),
		Limit:        intFlag(fs, "limit"),
	}
	if boolFlag(fs, "failed") {
		t := true
		f.Failed = &t
	}
	if v := stringFlag(fs, "from"); v != "" {
		if f.FromNS, err = parseTimeArg(v); err != nil {
			return fmt.Errorf("--from: %w", err)
		}
	}
	if v := stringFlag(fs, "to"); v != "" {
		if f.ToNS, err = parseTimeArg(v); err != nil {
			return fmt.Errorf("--to: %w", err)
		}
	}

	rows, err := db.QueryObservations(ctx, f)
	if err != nil {
		return err
	}
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(rows)
	}
	for _, r := range rows {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\t%s\t%.1fms\n",
			time.Unix(0, r.StartedAtNS).UTC().Format(time.RFC3339),
			r.SpanID, r.Kind, r.Name, r.Status, r.Agent,
			float64(r.DurationNS)/1e6)
	}
	fmt.Fprintf(c.Stdout, "%d observation(s)\n", len(rows))
	return nil
}

// parseTimeArg accepts RFC3339 or raw unix nanoseconds.
func parseTimeArg(v string) (int64, error) {
	if ns, err := strconv.ParseInt(v, 10, 64); err == nil {
		return ns, nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return 0, fmt.Errorf("want RFC3339 or unix nanoseconds")
	}
	return t.UnixNano(), nil
}
