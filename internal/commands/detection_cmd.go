package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/detection"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// RegisterDetectionCmd registers the v0.5.0 detection pack CLI. It is wired
// alongside Register (cmd/handoffgraph/main.go).
//
// Usage:
//
//	handoffgraph detect [--trace <id> | --workstream <id>] [--json]
//
// The command materializes traces/spans from the event log, runs the
// deterministic default pack over them, appends matches to the
// detection_matches table (idempotently; new rule versions never rewrite
// history), and prints them. All evidence is OBSERVED.
func RegisterDetectionCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "detect",
		Summary: "Run the detection pack over materialized traces and print matches",
		Usage:   "[--trace <id>] [--workstream <id>] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("trace", "", "restrict detection to a single trace id")
			fs.String("workstream", "", "restrict detection to a workstream id")
			fs.Bool("json", false, "emit JSON")
		},
		Run: detectCmd,
	})
}

func detectCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	traceID := stringFlag(fs, "trace")
	wsID := stringFlag(fs, "workstream")
	if traceID != "" && wsID != "" {
		return fmt.Errorf("--trace and --workstream are mutually exclusive")
	}

	cfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	res := trace.Materialize(events)

	traces, spans, workstreamID, err := detectInput(res, traceID, wsID)
	if err != nil {
		return err
	}

	engine, err := detection.NewEngine(detection.DefaultPack())
	if err != nil {
		return err
	}
	matches, err := engine.Evaluate(detection.Input{
		WorkstreamID: workstreamID,
		Traces:       traces,
		Spans:        spans,
	})
	if err != nil {
		return err
	}
	if matches == nil {
		matches = []*detection.Match{}
	}

	store, err := detection.OpenStoreFile(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer store.Close()
	inserted, err := store.SaveMatches(ctx, matches)
	if err != nil {
		return fmt.Errorf("persist detections: %w", err)
	}

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(matches)
	}
	for _, m := range matches {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\t%s\t%d\n",
			m.RuleID, m.RuleVersion, m.Severity, m.Scope, m.ScopeID, m.GroupKey, m.MatchCount)
	}
	fmt.Fprintf(c.Stdout, "%d detection(s), %d newly persisted\n", len(matches), inserted)
	return nil
}

// detectInput filters materialized traces and spans to the requested
// evaluation window and returns the workstream id workstream-scoped rules
// should report (empty when none is known).
func detectInput(res *trace.MaterializeResult, traceID, wsID string) ([]*protocol.Trace, []*protocol.Span, string, error) {
	switch {
	case traceID != "":
		var traces []*protocol.Trace
		for _, tr := range res.Traces {
			if tr.TraceID == traceID {
				traces = append(traces, tr)
			}
		}
		var spans []*protocol.Span
		for _, sp := range res.Spans {
			if sp.TraceID == traceID {
				spans = append(spans, sp)
			}
		}
		if len(traces) == 0 && len(spans) == 0 {
			return nil, nil, "", fmt.Errorf("trace %q not found", traceID)
		}
		ws := ""
		if len(traces) > 0 {
			ws = traces[0].WorkstreamID
		}
		return traces, spans, ws, nil
	case wsID != "":
		keep := map[string]bool{}
		var traces []*protocol.Trace
		for _, tr := range res.Traces {
			if tr.WorkstreamID == wsID {
				traces = append(traces, tr)
				keep[tr.TraceID] = true
			}
		}
		if len(traces) == 0 {
			return nil, nil, "", fmt.Errorf("workstream %q has no materialized traces", wsID)
		}
		var spans []*protocol.Span
		for _, sp := range res.Spans {
			if keep[sp.TraceID] {
				spans = append(spans, sp)
			}
		}
		return traces, spans, wsID, nil
	default:
		return res.Traces, res.Spans, commonWorkstreamID(res.Traces), nil
	}
}

// commonWorkstreamID returns the single workstream id shared by all traces,
// or "" when traces span multiple workstreams or none carries an id.
func commonWorkstreamID(traces []*protocol.Trace) string {
	ws := ""
	for _, tr := range traces {
		if tr.WorkstreamID == "" {
			continue
		}
		if ws != "" && ws != tr.WorkstreamID {
			return ""
		}
		ws = tr.WorkstreamID
	}
	return ws
}
