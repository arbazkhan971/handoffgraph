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
// rows 9-13).
//
// Usage:
//
//	handoffgraph index rebuild          force a deterministic rebuild
//	handoffgraph query spans [...]      ts_bucket-pruned observation queries
//	handoffgraph query exceptions [...] derived exception groups
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
			"             [--provider <p>] [--model <m>] [--kind <k>] [--tool <t>] [--failed]\n" +
			"             [--has-error] [--signal-source native|hook|sdk|import] [--include-shadowed]\n" +
			"             [--from <rfc3339|unix_ns>] [--to <rfc3339|unix_ns>] [--limit N] [--json]\n" +
			"       exceptions [--workstream <id>] [--error-type <t>] [--limit N] [--json]\n" +
			"       usage [--workstream <id>] [--group-by provider|session] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "filter by workstream id")
			fs.String("trace", "", "filter by trace id")
			fs.String("session", "", "filter by session id")
			fs.String("agent", "", "filter by agent name")
			fs.String("provider", "", "filter by provider")
			fs.String("model", "", "filter by model")
			fs.String("kind", "", "filter by span kind (MODEL, TOOL, ...)")
			fs.String("tool", "", "filter by promoted tool_name column")
			fs.String("error-type", "", "filter by promoted error_type column")
			fs.Bool("has-error", false, "only spans carrying an error (promoted error_exists marker)")
			fs.String("signal-source", "", "filter by signal source: native | hook | sdk | import")
			fs.Bool("include-shadowed", false, "include observations coalescing marked as duplicates")
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

// rebuildObservations derives and persists the wide read model and every
// table derived alongside it, returning the observation row count.
func rebuildObservations(ctx context.Context, db *storage.DB, events []*protocol.Event) (int, error) {
	derived := observations.DeriveAll(events)
	if err := db.RebuildObservations(ctx, derived.Rows, derived.Fingerprints,
		derived.ExceptionGroups, storage.ObsMeta{
			EventCount: int64(len(events)),
			MaxSeq:     maxSeq(events),
			RebuiltAt:  time.Now().UTC(),
		}); err != nil {
		return 0, err
	}
	return len(derived.Rows), nil
}

// freshenObservations rebuilds the derived tables when the event log has
// moved past the last snapshot, so a read never silently serves a stale
// index.
func freshenObservations(ctx context.Context, db *storage.DB) error {
	stale, err := db.ObservationsStale(ctx)
	if err != nil {
		return err
	}
	if !stale {
		return nil
	}
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	_, err = rebuildObservations(ctx, db, events)
	return err
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
	if len(args) >= 1 && args[0] == "exceptions" {
		return queryExceptionsCmd(ctx, c, fs)
	}
	if len(args) != 1 || args[0] != "spans" {
		return fmt.Errorf("usage: query spans [...] | query exceptions [...] | query usage [...]")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	if err := freshenObservations(ctx, db); err != nil {
		return err
	}

	f := storage.ObsFilter{
		WorkstreamID:    stringFlag(fs, "workstream"),
		TraceID:         stringFlag(fs, "trace"),
		SessionID:       stringFlag(fs, "session"),
		Agent:           stringFlag(fs, "agent"),
		Provider:        stringFlag(fs, "provider"),
		Model:           stringFlag(fs, "model"),
		Kind:            stringFlag(fs, "kind"),
		ToolName:        stringFlag(fs, "tool"),
		ErrorType:       stringFlag(fs, "error-type"),
		IncludeShadowed: boolFlag(fs, "include-shadowed"),
		Limit:           intFlag(fs, "limit"),
	}
	if v := stringFlag(fs, "signal-source"); v != "" {
		src, ok := observations.ParseSignalSource(v)
		if !ok {
			return fmt.Errorf("--signal-source must be native, hook, sdk or import")
		}
		f.SignalSource = string(src)
	}
	if boolFlag(fs, "failed") {
		t := true
		f.Failed = &t
	}
	if boolFlag(fs, "has-error") {
		t := true
		f.HasError = &t
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
		shadow := ""
		if r.Shadowed {
			shadow = "\tshadowed"
		}
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\t%s\t%.1fms\t%s%s\n",
			time.Unix(0, r.StartedAtNS).UTC().Format(time.RFC3339),
			r.SpanID, r.Kind, r.Name, r.Status, r.Agent,
			float64(r.DurationNS)/1e6, r.SignalSource, shadow)
	}
	fmt.Fprintf(c.Stdout, "%d observation(s)\n", len(rows))
	return nil
}

// queryExceptionsCmd lists derived exception groups (parity-plan row 13),
// most frequent first with the grouping hash breaking ties.
func queryExceptionsCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	if err := freshenObservations(ctx, db); err != nil {
		return err
	}
	groups, err := db.ListExceptionGroups(ctx, storage.ExceptionFilter{
		WorkstreamID: stringFlag(fs, "workstream"),
		ErrorType:    stringFlag(fs, "error-type"),
		Limit:        intFlag(fs, "limit"),
	})
	if err != nil {
		return err
	}
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(groups)
	}
	for _, g := range groups {
		frame := g.TopFrame
		if frame == "" {
			frame = "-"
		}
		fmt.Fprintf(c.Stdout, "%s\t%d\t%s\t%s\t%s\t%s\t%s\n",
			g.GroupHash[:12], g.SpanCount, g.ErrorType, g.MessageTemplate, frame,
			time.Unix(0, g.FirstSeenNS).UTC().Format(time.RFC3339),
			time.Unix(0, g.LastSeenNS).UTC().Format(time.RFC3339))
	}
	fmt.Fprintf(c.Stdout, "%d exception group(s)\n", len(groups))
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
