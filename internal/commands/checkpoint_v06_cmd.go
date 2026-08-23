package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"

	checkpointcore "github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

// checkpointV06Cmd handles the v0.6 checkpoint forms while allowing the
// legacy --workstream builder to remain in checkpointCmd. The commands
// registry calls this first; handled=false means checkpointCmd should execute
// its existing workstream-wide path.
func checkpointV06Cmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) (handled bool, err error) {
	args := fs.Args()
	if len(args) > 0 {
		if args[0] != "show" {
			return true, fmt.Errorf("usage: checkpoint --from-trace <id> | checkpoint show <id> [--json]")
		}
		if stringFlag(fs, "from-trace") != "" {
			return true, fmt.Errorf("checkpoint show cannot be combined with --from-trace")
		}
		subFS := flag.NewFlagSet("checkpoint show", flag.ContinueOnError)
		subFS.SetOutput(c.Stderr)
		subFS.Bool("json", false, "emit JSON")
		positional, parseErr := parseInterspersed(subFS, args[1:])
		if parseErr != nil {
			return true, parseErr
		}
		if len(positional) != 1 {
			return true, fmt.Errorf("usage: checkpoint show <id> [--json]")
		}
		return true, checkpointShow(ctx, c, positional[0], boolFlag(fs, "json") || boolFlag(subFS, "json"))
	}

	traceID := stringFlag(fs, "from-trace")
	if traceID == "" {
		return false, nil
	}
	return true, checkpointFromTrace(ctx, c, traceID, stringFlag(fs, "workstream"), stringFlag(fs, "objective"), stringFlag(fs, "status"))
}

func checkpointFromTrace(ctx context.Context, c *cli.Context, traceID, expectedWorkstream, objective, status string) error {
	cfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	repoState, _ := repository.State(ctx, ".")
	cp, err := checkpointcore.BuildFromTrace(ctx, checkpointcore.TraceBuildOptions{
		TraceID:   traceID,
		Objective: objective,
		Status:    status,
		Repo:      repoState,
		Events:    events,
		Redaction: &redact.Options{
			DenyPaths:    cfg.RedactDenyPaths,
			UserPatterns: cfg.RedactPatterns,
		},
	})
	if err != nil {
		return err
	}
	if expectedWorkstream != "" && expectedWorkstream != cp.WorkstreamID {
		return fmt.Errorf("trace %s belongs to workstream %s, not %s", traceID, cp.WorkstreamID, expectedWorkstream)
	}
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		return err
	}
	return writeCheckpointJSON(c, cp)
}

func checkpointShow(ctx context.Context, c *cli.Context, checkpointID string, asJSON bool) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	cp, err := db.GetCheckpoint(ctx, checkpointID)
	if err != nil {
		return err
	}
	if asJSON {
		return writeCheckpointJSON(c, cp)
	}
	_, err = fmt.Fprint(c.Stdout, checkpointcore.RenderMarkdown(cp))
	return err
}

func writeCheckpointJSON(c *cli.Context, cp any) error {
	out, err := json.MarshalIndent(cp, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(c.Stdout, string(out))
	return err
}
