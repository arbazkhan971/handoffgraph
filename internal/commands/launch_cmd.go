package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/launch"
)

// RegisterLaunchCmd registers the v0.6.0 cross-agent continuation commands.
//
// TODO(orchestrator): wire into Register() in commands.go alongside the
// other lane registrations (commands.go is orchestrator-owned this wave):
//
//	RegisterLaunchCmd(app)
//
// Usage:
//
//	handoffgraph continue --to codex|claude|pi --workstream <id> [--preview]
//	handoffgraph handoff status [--json]
//
// continue renders the bounded continuation payload from the workstream's
// latest checkpoint and resolves the native launch spec (same provider:
// native resume of the source session; cross provider: checkpoint-seeded
// start). Without --preview it records the handoff as an append-only
// handoff.created event. --preview prints the exact payload and records
// nothing. Neither mode execs the target agent: the exact invocation is
// printed for the user to run.
//
// handoff status lists recorded handoffs and their acknowledgement state
// (derived read model over handoff.created / handoff.accepted events).
func RegisterLaunchCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "continue",
		Summary: "Continue a workstream in a target agent from its latest checkpoint",
		Usage:   "--to codex|claude|pi --workstream <id> [--preview]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("to", "", "target agent (codex|claude|pi)")
			fs.String("workstream", "", "workstream id")
			fs.Bool("preview", false, "print the exact payload without recording a handoff (never execs the agent)")
		},
		Run: continueCmd,
	})
	app.Register(&cli.Command{
		Name:    "handoff",
		Summary: "Show recorded cross-agent handoffs and their acknowledgement status",
		Usage:   "status [--json]",
		Flags:   func(fs *flag.FlagSet) { fs.Bool("json", false, "emit JSON") },
		Run:     handoffCmd,
	})
}

// continueCmd prepares (and by default records) a cross-agent continuation.
// It never execs the target agent.
func continueCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	to := stringFlag(fs, "to")
	ws := stringFlag(fs, "workstream")
	preview := boolFlag(fs, "preview")
	if to == "" || ws == "" {
		return fmt.Errorf("usage: continue --to codex|claude|pi --workstream <id> [--preview]")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	opts := launch.Options{WorkstreamID: ws, TargetAgent: to}

	if preview {
		// Preview resolves everything Continue would, but writes nothing.
		res, err := launch.Prepare(ctx, db, opts)
		if err != nil {
			return fmt.Errorf("continue: %w", err)
		}
		fmt.Fprintln(c.Stdout, "# preview — nothing recorded, nothing executed")
		fmt.Fprintf(c.Stdout, "checkpoint: %s\nmode: %s\n", res.Checkpoint.CheckpointID, res.Handoff.Mode)
		fmt.Fprintf(c.Stdout, "payload (%d chars):\n\n%s", len(res.Prompt), res.Prompt)
		return nil
	}

	res, err := launch.Continue(ctx, db, opts)
	if err != nil {
		return fmt.Errorf("continue: %w", err)
	}
	fmt.Fprintf(c.Stdout, "handoff %s created: %s -> %s (mode %s)\n",
		res.Handoff.ID, launchSourceLabel(res.Handoff.SourceProvider), res.Handoff.TargetAgent, res.Handoff.Mode)
	fmt.Fprintf(c.Stdout, "checkpoint: %s\n", res.Checkpoint.CheckpointID)
	fmt.Fprintf(c.Stdout, "drift: %s\n", launchDriftLabel(res.Drift))
	fmt.Fprintf(c.Stdout, "agent invocation (printed, not executed):\n  %s\n\n",
		FormatExecSpec(res.Spec.Command, res.Spec.Args))
	fmt.Fprintf(c.Stdout, "continuation payload (%d chars):\n\n%s", len(res.Prompt), res.Prompt)
	return nil
}

// handoffCmd prints the derived handoff status read model.
func handoffCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 || args[0] != "status" {
		return fmt.Errorf("usage: handoff status [--json]")
	}
	// Re-parse flags placed after the subcommand (`handoff status --json`):
	// the flag package stops at the first positional. Explicit values from
	// either position win (same convention as the claude lane).
	subFS := flag.NewFlagSet("handoff status", flag.ContinueOnError)
	subFS.SetOutput(c.Stderr)
	subFS.Bool("json", false, "emit JSON")
	if _, err := parseInterspersed(subFS, args[1:]); err != nil {
		return err
	}
	asJSON := boolFlag(fs, "json") || boolFlag(subFS, "json")

	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	recs, err := launch.ListHandoffs(ctx, db)
	if err != nil {
		return err
	}

	// Times are preformatted as RFC3339 (zero times become "") so the JSON
	// output stays deterministic (same convention as sessions --detect).
	type handoffOut struct {
		ID               string   `json:"id"`
		WorkstreamID     string   `json:"workstream_id"`
		SourceCheckpoint string   `json:"source_checkpoint"`
		SourceProvider   string   `json:"source_provider,omitempty"`
		TargetAgent      string   `json:"target_agent"`
		Mode             string   `json:"mode"`
		Status           string   `json:"status"`
		CreatedAt        string   `json:"created_at"`
		AcceptedAt       string   `json:"accepted_at,omitempty"`
		Accepted         []string `json:"accepted,omitempty"`
		Missing          []string `json:"missing,omitempty"`
		Unverifiable     []string `json:"unverifiable,omitempty"`
	}
	out := make([]handoffOut, 0, len(recs))
	for _, r := range recs {
		out = append(out, handoffOut{
			ID:               r.ID,
			WorkstreamID:     r.WorkstreamID,
			SourceCheckpoint: r.SourceCheckpoint,
			SourceProvider:   r.SourceProvider,
			TargetAgent:      r.TargetAgent,
			Mode:             r.Mode,
			Status:           r.Status,
			CreatedAt:        formatRFC3339OrEmpty(r.CreatedAt),
			AcceptedAt:       formatRFC3339OrEmpty(r.AcceptedAt),
			Accepted:         r.Accepted,
			Missing:          r.Missing,
			Unverifiable:     r.Unverifiable,
		})
	}

	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, r := range out {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			r.ID, r.Status, r.TargetAgent, launchSourceLabel(r.SourceProvider), r.Mode, r.SourceCheckpoint, r.CreatedAt)
		if r.Status == launch.StatusAccepted {
			details := fmt.Sprintf("  acknowledged at %s: accepted [%s] missing [%s] unverifiable [%s]",
				r.AcceptedAt, strings.Join(r.Accepted, ", "), strings.Join(r.Missing, ", "), strings.Join(r.Unverifiable, ", "))
			fmt.Fprintln(c.Stdout, details)
		}
	}
	return nil
}

// launchSourceLabel renders the handoff's source; an empty source means no
// resumable native session was recorded.
func launchSourceLabel(provider string) string {
	if provider == "" {
		return "no native session"
	}
	return provider
}

// launchDriftLabel renders the drift verdict for the continue command.
func launchDriftLabel(r launch.DriftReport) string {
	if r.Clean {
		return "clean (repository matches the checkpoint)"
	}
	var parts []string
	if r.HeadMismatch {
		parts = append(parts, "head mismatch")
	}
	if r.BranchMismatch {
		parts = append(parts, "branch mismatch")
	}
	if r.DirtyIntroduced {
		parts = append(parts, "dirty files introduced since the checkpoint")
	}
	if len(parts) == 0 {
		return "unverified (no repository state recorded in the checkpoint, or none could be captured)"
	}
	return "detected: " + strings.Join(parts, ", ")
}
