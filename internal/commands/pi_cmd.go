package commands

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter/pi"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// RegisterPiCmd registers the Pi adapter management command. It is wired
// alongside Register (cmd/handoffgraph/main.go) as the v0.4.0 Pi entrypoint.
//
// Usage:
//
//	handoffgraph pi install    [--agent-dir <dir>] [--dry-run]
//	handoffgraph pi uninstall  [--agent-dir <dir>]
//	handoffgraph pi sessions   [--sessions-dir <dir>] [--json]
//	handoffgraph pi normalize  <file> [--workstream <id>] [--session <id>] [--import | --json]
//
// The subcommands manage the managed TypeScript extension under
// <agent-dir>/extensions/handoffgraph/ (default ~/.pi/agent) and enumerate
// native Pi sessions from <sessions-dir> (default ~/.pi/agent/sessions).
// Nothing here touches a provider configuration beyond the managed names
// documented in internal/adapter/pi.
func RegisterPiCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "pi",
		Summary: "Manage the Pi adapter (install, uninstall, sessions, normalize)",
		Usage:   "install | uninstall | sessions | normalize <file> [flags]",
		Flags:   registerPiFlags,
		Run:     piCmd,
	})
}

// registerPiFlags defines the shared flag set for every pi subcommand.
func registerPiFlags(fs *flag.FlagSet) {
	fs.String("agent-dir", "", "Pi agent directory override (default ~/.pi/agent)")
	fs.String("sessions-dir", "", "Pi sessions directory override (default ~/.pi/agent/sessions)")
	fs.String("workstream", "", "associate normalized events with this workstream id (normalize)")
	fs.String("session", "", "canonical session id override (normalize; default derives from provider/native session)")
	fs.Bool("import", false, "append normalized events to the local event log (normalize; requires --workstream)")
	fs.Bool("dry-run", false, "perform all conflict checks without writing (install)")
	fs.Bool("json", false, "emit JSON (sessions; indented array for normalize)")
}

func piSubcommandFlags(fs *flag.FlagSet, sub string) bool {
	switch sub {
	case "install":
		fs.String("agent-dir", "", "Pi agent directory override (default ~/.pi/agent)")
		fs.Bool("dry-run", false, "perform all conflict checks without writing")
	case "uninstall":
		fs.String("agent-dir", "", "Pi agent directory override (default ~/.pi/agent)")
	case "sessions":
		fs.String("sessions-dir", "", "Pi sessions directory override (default ~/.pi/agent/sessions)")
		fs.Bool("json", false, "emit JSON")
	case "normalize":
		fs.String("workstream", "", "associate normalized events with this workstream id")
		fs.String("session", "", "canonical session id override (default derives from provider/native session)")
		fs.Bool("import", false, "append normalized events to the local event log (requires --workstream)")
		fs.Bool("json", false, "emit an indented JSON array")
	default:
		return false
	}
	return true
}

// newPiAdapter builds a Pi adapter honoring the dir overrides.
func newPiAdapter(agentDir, sessionsDir string) *pi.Pi {
	return &pi.Pi{AgentDir: agentDir, SessionsDir: sessionsDir}
}

// piCmd dispatches the pi subcommand. The cli framework parses flags only
// before the first positional argument, so flags typed after the
// subcommand (`pi install --agent-dir X`) remain in fs.Args(); they are
// re-parsed here so both orders behave identically.
func piCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 {
		return fmt.Errorf("usage: pi install | uninstall | sessions | normalize <file>")
	}
	sub := args[0]
	subFS := flag.NewFlagSet("pi "+sub, flag.ContinueOnError)
	subFS.SetOutput(c.Stderr)
	if !piSubcommandFlags(subFS, sub) {
		return fmt.Errorf("unknown pi subcommand %q (want install, uninstall, sessions or normalize)", sub)
	}
	subFS.Usage = func() {
		fmt.Fprintf(c.Stdout, "Usage: handoffgraph pi %s [flags]\n\nFlags:\n", sub)
		subFS.SetOutput(c.Stdout)
		subFS.PrintDefaults()
		subFS.SetOutput(c.Stderr)
	}
	positional, err := parseInterspersed(subFS, args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	p := newPiAdapter(
		pickString(stringFlag(subFS, "agent-dir"), stringFlag(fs, "agent-dir")),
		pickString(stringFlag(subFS, "sessions-dir"), stringFlag(fs, "sessions-dir")),
	)
	asJSON := boolFlag(subFS, "json") || boolFlag(fs, "json")
	workstreamID := pickString(stringFlag(subFS, "workstream"), stringFlag(fs, "workstream"))
	sessionID := pickString(stringFlag(subFS, "session"), stringFlag(fs, "session"))
	importEvents := boolFlag(subFS, "import") || boolFlag(fs, "import")
	if err := rejectNormalizeOnlyFlags("pi", sub, workstreamID, sessionID, importEvents); err != nil {
		return err
	}
	switch sub {
	case "install":
		return piInstallCmd(ctx, c, p, boolFlag(subFS, "dry-run") || boolFlag(fs, "dry-run"))
	case "uninstall":
		return piUninstallCmd(ctx, c, p)
	case "sessions":
		if len(positional) != 0 {
			return fmt.Errorf("usage: pi sessions [--sessions-dir <dir>] [--json]")
		}
		return piSessionsCmd(ctx, c, p, asJSON)
	case "normalize":
		return piNormalizeCmd(ctx, c, positional, nativeNormalizeOptions{
			WorkstreamID: workstreamID,
			SessionID:    sessionID,
			Import:       importEvents,
			JSON:         asJSON,
		})
	default:
		return fmt.Errorf("unknown pi subcommand %q (want install, uninstall, sessions or normalize)", sub)
	}
}

// pickString returns a when non-empty, else b.
func pickString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func piInstallCmd(ctx context.Context, c *cli.Context, p *pi.Pi, dryRun bool) error {
	dir := p.ResolvedAgentDir()
	if err := p.InstallExtension(ctx, dir, pi.InstallOptions{DryRun: dryRun}); err != nil {
		return fmt.Errorf("pi install: %w", err)
	}
	trailer := fmt.Sprintf(" (extensions: %s)", dir)
	if dryRun {
		trailer = " (dry run — no changes written)"
	}
	fmt.Fprintf(c.Stdout, "pi: extension installed%s\n", trailer)
	return nil
}

func piUninstallCmd(ctx context.Context, c *cli.Context, p *pi.Pi) error {
	dir := p.ResolvedAgentDir()
	if err := p.UninstallExtension(ctx, dir); err != nil {
		if errors.Is(err, pi.ErrInstallConflict) {
			return fmt.Errorf("pi uninstall: %w", err)
		}
		return fmt.Errorf("pi uninstall: %w", err)
	}
	fmt.Fprintf(c.Stdout, "pi: extension uninstalled (extensions: %s)\n", dir)
	return nil
}

// piSessionOut is one row of `pi sessions`. Times are preformatted as
// RFC3339 (zero times become "") so the JSON output stays deterministic.
type piSessionOut struct {
	Provider    string `json:"provider"`
	NativeID    string `json:"native_session_id"`
	LastEventAt string `json:"last_event_at"`
}

func piSessionsCmd(ctx context.Context, c *cli.Context, p *pi.Pi, asJSON bool) error {
	refs, err := p.Detect(ctx, "")
	if err != nil {
		return fmt.Errorf("pi sessions: %w", err)
	}
	out := make([]piSessionOut, 0, len(refs))
	for _, ref := range refs {
		last := ""
		if !ref.LastEventAt.IsZero() {
			last = ref.LastEventAt.Format(time.RFC3339)
		}
		out = append(out, piSessionOut{Provider: ref.Provider, NativeID: ref.NativeID, LastEventAt: last})
	}
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	if len(out) == 0 {
		fmt.Fprintln(c.Stdout, "no pi sessions found")
		return nil
	}
	for _, s := range out {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\n", s.Provider, s.NativeID, s.LastEventAt)
	}
	return nil
}

// piNormalizeCmd converts a native Pi JSONL transcript into canonical events.
// Association and import use the same atomic, ownership-checked path as the
// Codex and Claude native transcript commands.
func piNormalizeCmd(ctx context.Context, c *cli.Context, args []string, opts nativeNormalizeOptions) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: pi normalize <file> [--workstream <id>] [--session <id>] [--import | --json]")
	}
	f, err := os.Open(args[0])
	if err != nil {
		return fmt.Errorf("pi normalize: %w", err)
	}
	defer f.Close()

	events, err := (&pi.Pi{}).NormalizeTranscript(ctx, f)
	if err != nil {
		return fmt.Errorf("pi normalize: %w", err)
	}
	return finishNativeNormalize(ctx, c, "pi normalize", protocol.ProviderPi, events, opts)
}
