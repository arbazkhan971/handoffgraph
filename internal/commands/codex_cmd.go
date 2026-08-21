package commands

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	codexhooks "github.com/handoffgraph/handoffgraph/integrations/codex"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/cli"
)

// RegisterCodexCmd registers the Codex adapter management command.
//
// TODO(orchestrator): wire RegisterCodexCmd(app) into Register() in
// internal/commands/commands.go (next to the other Register*Cmd calls);
// commands.go is orchestrator-owned this wave, so the call is left here
// as a marker instead of editing that file.
//
// Usage:
//
//	handoffgraph codex install    [--config-dir <dir>] [--hook-command <cmd>] [--dry-run]
//	handoffgraph codex uninstall  [--config-dir <dir>] [--dry-run]
//	handoffgraph codex sessions   [--sessions-dir <dir>] [--json]
//	handoffgraph codex normalize  <file> [--json]
//
// install/uninstall manage the marker-scoped [hooks.<event>] tables in
// <config-dir>/config.toml (default ~/.codex) via integrations/codex —
// merge-safe, fail-closed, idempotent. sessions enumerates native rollout
// transcripts from disk (default ~/.codex/sessions; HFG_CODEX_SESSIONS_DIR
// overrides). normalize prints the canonical hfg.event.v1 events a native
// rollout transcript normalizes to, with deterministic ids (JSONL by
// default, an indented array with --json).
func RegisterCodexCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "codex",
		Summary: "Manage the Codex adapter (install, uninstall, sessions, normalize)",
		Usage:   "install | uninstall | sessions | normalize <file> [flags]",
		Flags:   codexRegisterFlags,
		Run:     codexCmd,
	})
}

// codexRegisterFlags declares the codex command flags. They are applied to
// both the outer flag set and a per-subcommand re-parse so flags work
// before or after the subcommand (`codex --dry-run install` and
// `codex install --dry-run`), mirroring the other lane commands.
func codexRegisterFlags(fs *flag.FlagSet) {
	fs.String("config-dir", "", "Codex config directory override (default ~/.codex, env HFG_CODEX_CONFIG_DIR)")
	fs.String("hook-command", "", "hook command to install (defaults to this binary)")
	fs.String("sessions-dir", "", "Codex sessions directory override (sessions; default ~/.codex/sessions, env HFG_CODEX_SESSIONS_DIR)")
	fs.Bool("dry-run", false, "perform all conflict checks without writing (install, uninstall)")
	fs.Bool("json", false, "emit JSON (sessions; indented array for normalize)")
}

// codexCmd dispatches the codex subcommand. Go's flag package stops parsing
// at the first positional argument, so flags placed after the subcommand
// are re-parsed here and merged (explicit inner values win; booleans
// combine) via the shared parseInterspersed helper.
func codexCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 {
		return fmt.Errorf("usage: codex install|uninstall|sessions|normalize <file> [flags]")
	}
	sub := args[0]
	subFS := flag.NewFlagSet("codex "+sub, flag.ContinueOnError)
	subFS.SetOutput(c.Stderr)
	codexRegisterFlags(subFS)
	positional, err := parseInterspersed(subFS, args[1:])
	if err != nil {
		return err
	}
	configDir := pickString(stringFlag(subFS, "config-dir"), stringFlag(fs, "config-dir"))
	hookCommand := pickString(stringFlag(subFS, "hook-command"), stringFlag(fs, "hook-command"))
	sessionsDir := pickString(stringFlag(subFS, "sessions-dir"), stringFlag(fs, "sessions-dir"))
	dryRun := boolFlag(fs, "dry-run") || boolFlag(subFS, "dry-run")

	switch sub {
	case "install":
		return codexInstallCmd(ctx, c, configDir, hookCommand, dryRun)
	case "uninstall":
		return codexUninstallCmd(ctx, c, configDir, dryRun)
	case "sessions":
		return codexSessionsCmd(ctx, c, sessionsDir, boolFlag(fs, "json") || boolFlag(subFS, "json"))
	case "normalize":
		return codexNormalizeCmd(ctx, c, positional, boolFlag(fs, "json") || boolFlag(subFS, "json"))
	default:
		return fmt.Errorf("unknown codex subcommand %q (install|uninstall|sessions|normalize)", sub)
	}
}

// defaultCodexHookCommand resolves the default hook command: this binary.
func defaultCodexHookCommand() string {
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return "handoffgraph"
}

func codexInstallCmd(ctx context.Context, c *cli.Context, configDir, hookCommand string, dryRun bool) error {
	if hookCommand == "" {
		hookCommand = defaultCodexHookCommand()
	}
	a := &codex.Codex{ConfigDir: configDir, HookCommand: hookCommand, DryRun: dryRun}
	if err := a.Install(ctx, adapter.ScopeUser); err != nil {
		switch {
		case errors.Is(err, adapter.ErrHookConflict):
			return fmt.Errorf("codex install: %w", err)
		case errors.Is(err, adapter.ErrUnsupported):
			return fmt.Errorf("codex install: %w", err)
		default:
			return fmt.Errorf("codex install: %w", err)
		}
	}
	events := append([]string(nil), codexhooks.ManagedEvents...)
	sort.Strings(events)
	trailer := " (config: default ~/.codex)"
	if configDir != "" {
		trailer = fmt.Sprintf(" (config: %s)", configDir)
	}
	if dryRun {
		trailer += " (dry run — no changes written)"
	}
	fmt.Fprintf(c.Stdout, "codex hooks installed for events: %s%s\n", strings.Join(events, ", "), trailer)
	return nil
}

func codexUninstallCmd(ctx context.Context, c *cli.Context, configDir string, dryRun bool) error {
	a := &codex.Codex{ConfigDir: configDir, DryRun: dryRun}
	if err := a.Uninstall(ctx, adapter.ScopeUser); err != nil {
		switch {
		case errors.Is(err, adapter.ErrHookConflict):
			return fmt.Errorf("codex uninstall: %w", err)
		case errors.Is(err, adapter.ErrUnsupported):
			return fmt.Errorf("codex uninstall: %w", err)
		default:
			return fmt.Errorf("codex uninstall: %w", err)
		}
	}
	if dryRun {
		fmt.Fprintln(c.Stdout, "codex hooks would be removed (dry run — no changes written)")
	} else {
		fmt.Fprintln(c.Stdout, "codex hooks removed (user configuration preserved)")
	}
	return nil
}

// codexSessionOut is one row of `codex sessions`. Times are preformatted
// as RFC3339 (zero times become "") so JSON output stays deterministic.
type codexSessionOut struct {
	Agent           string `json:"agent"`
	NativeSessionID string `json:"native_session_id"`
	Path            string `json:"path"`
	StartedAt       string `json:"started_at"`
	EndedAt         string `json:"ended_at"`
	Model           string `json:"model"`
}

// codexSessionsCmd lists native Codex sessions directly from disk via the
// adapter's Detect (newest first, ties by path — the adapter's own
// deterministic ordering).
func codexSessionsCmd(ctx context.Context, c *cli.Context, sessionsDir string, asJSON bool) error {
	if sessionsDir == "" {
		// Same override convention as `sessions --detect`.
		sessionsDir = os.Getenv("HFG_CODEX_SESSIONS_DIR")
	}
	a := &codex.Codex{SessionsDir: sessionsDir}
	refs, err := a.Detect(ctx, "")
	if err != nil {
		return fmt.Errorf("codex sessions: %w", err)
	}
	out := make([]codexSessionOut, 0, len(refs))
	for _, ref := range refs {
		out = append(out, codexSessionOut{
			Agent:           ref.Provider,
			NativeSessionID: ref.NativeID,
			Path:            ref.Path,
			StartedAt:       codexFormatRFC3339OrEmpty(ref.StartedAt),
			EndedAt:         codexFormatRFC3339OrEmpty(ref.EndedAt),
			Model:           ref.Model,
		})
	}
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	if len(out) == 0 {
		fmt.Fprintln(c.Stdout, "no codex sessions found")
		return nil
	}
	for _, s := range out {
		started := s.StartedAt
		if started == "" {
			started = "-"
		}
		model := s.Model
		if model == "" {
			model = "-"
		}
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\n", s.Agent, s.NativeSessionID, s.Path, started, model)
	}
	return nil
}

// codexNormalizeCmd prints the canonical events a native rollout
// transcript normalizes to. Default output is canonical JSONL (one event
// per line, ready for `event import`-style handling); --json emits an
// indented array. Output is deterministic: normalizing the same file
// twice prints identical bytes.
func codexNormalizeCmd(ctx context.Context, c *cli.Context, args []string, asJSON bool) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: codex normalize <file> [--json]")
	}
	f, err := os.Open(args[0])
	if err != nil {
		return fmt.Errorf("codex normalize: %w", err)
	}
	defer f.Close()

	events, err := (&codex.Codex{}).NormalizeStream(ctx, f)
	if err != nil {
		return fmt.Errorf("codex normalize: %w", err)
	}
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(events)
	}
	for i := range events {
		line, err := json.Marshal(&events[i])
		if err != nil {
			return fmt.Errorf("codex normalize: encode event %d: %w", i+1, err)
		}
		fmt.Fprintln(c.Stdout, string(line))
	}
	return nil
}

// codexFormatRFC3339OrEmpty renders t as RFC3339, or "" when zero.
func codexFormatRFC3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
