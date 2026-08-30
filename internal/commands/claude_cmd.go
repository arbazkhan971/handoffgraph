package commands

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	claudehooks "github.com/handoffgraph/handoffgraph/integrations/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/claude"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// RegisterClaudeCmd registers the Claude Code adapter management command
// (v0.3.0), wired alongside Register by cmd/handoffgraph/main.go.
//
// Usage:
//
//	handoffgraph claude install    [--config-dir <dir>] [--hook-command <cmd>] [--dry-run]
//	handoffgraph claude uninstall  [--config-dir <dir>] [--dry-run]
//	handoffgraph claude sessions   [--projects-dir <dir>] [--detect] [--json]
//	handoffgraph claude normalize  <file> [--workstream <id>] [--session <id>] [--import | --json]
//	handoffgraph claude resume     <session-id> [--fork]
//
// install/uninstall manage additive schema-valid hook entries in
// <config-dir>/settings.json plus their private ownership sidecar (default
// ~/.claude). sessions lists Claude
// sessions derived from captured events, or enumerates native transcripts
// from ~/.claude/projects with --detect (HFG_CLAUDE_PROJECTS_DIR overrides
// the directory). normalize emits deterministic canonical events from one
// native transcript; --workstream derives a stable canonical session and
// --import appends the events locally. resume relaunches the Claude Code CLI
// on a native session id via `claude --resume` (add --fork for
// `--fork-session`).
func RegisterClaudeCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "claude",
		Summary: "Manage the Claude Code adapter (install, uninstall, sessions, normalize, resume)",
		Usage:   "install | uninstall | sessions | normalize <file> | resume <session-id> [flags]",
		Flags:   claudeRegisterFlags,
		Run:     claudeCmd,
	})
}

// newClaudeAdapter builds a Claude adapter honoring the CLI overrides.
func newClaudeAdapter(configDir, projectsDir, hookCommand string, dryRun bool) *claude.Claude {
	return &claude.Claude{
		ConfigDir:   configDir,
		ProjectsDir: projectsDir,
		HookCommand: hookCommand,
		DryRun:      dryRun,
	}
}

// claudeRegisterFlags declares the claude command flags. It is applied to
// both the outer flag set and a per-subcommand re-parse so flags work
// before or after the subcommand (`claude --dry-run install` and
// `claude install --dry-run`).
func claudeRegisterFlags(fs *flag.FlagSet) {
	fs.String("config-dir", "", "Claude config directory override (default ~/.claude)")
	fs.String("hook-command", "", "hook command to install (defaults to this binary)")
	fs.String("projects-dir", "", "Claude projects directory override (sessions --detect; default ~/.claude/projects, env HFG_CLAUDE_PROJECTS_DIR)")
	fs.String("workstream", "", "associate normalized events with this workstream id (normalize)")
	fs.String("session", "", "canonical session id override (normalize; default derives from provider/native session)")
	fs.Bool("import", false, "append normalized events to the local event log (normalize; requires --workstream)")
	fs.Bool("dry-run", false, "perform all conflict checks without writing (install, uninstall)")
	fs.Bool("detect", false, "detect native sessions from disk instead of captured events (sessions)")
	fs.Bool("json", false, "emit JSON (sessions; indented array for normalize)")
	fs.Bool("fork", false, "fork the session instead of resuming in place (resume)")
}

// claudeSubcommandFlags exposes only the flags meaningful to one
// subcommand, keeping grouped-command help precise.
func claudeSubcommandFlags(fs *flag.FlagSet, sub string) bool {
	switch sub {
	case "install":
		fs.String("config-dir", "", "Claude config directory override (default ~/.claude)")
		fs.String("hook-command", "", "hook command to install (defaults to this binary)")
		fs.Bool("dry-run", false, "perform all conflict checks without writing")
	case "uninstall":
		fs.String("config-dir", "", "Claude config directory override (default ~/.claude)")
		fs.Bool("dry-run", false, "perform all conflict checks without writing")
	case "sessions":
		fs.String("projects-dir", "", "Claude projects directory override (default ~/.claude/projects, env HFG_CLAUDE_PROJECTS_DIR)")
		fs.Bool("detect", false, "detect native sessions from disk instead of captured events")
		fs.Bool("json", false, "emit JSON")
	case "normalize":
		fs.String("workstream", "", "associate normalized events with this workstream id")
		fs.String("session", "", "canonical session id override (default derives from provider/native session)")
		fs.Bool("import", false, "append normalized events to the local event log (requires --workstream)")
		fs.Bool("json", false, "emit an indented JSON array")
	case "resume":
		fs.Bool("fork", false, "fork the session instead of resuming in place")
	default:
		return false
	}
	return true
}

// claudeCmd dispatches the claude subcommand. Go's flag package stops
// parsing at the first positional argument, so flags placed after the
// subcommand are re-parsed here and merged (explicit inner values win;
// booleans combine).
func claudeCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 {
		return fmt.Errorf("usage: claude install|uninstall|sessions|normalize <file>|resume <session-id> [flags]")
	}
	sub := args[0]
	subFS := flag.NewFlagSet("claude "+sub, flag.ContinueOnError)
	subFS.SetOutput(c.Stderr)
	if !claudeSubcommandFlags(subFS, sub) {
		return fmt.Errorf("unknown claude subcommand %q (install|uninstall|sessions|normalize|resume)", sub)
	}
	subFS.Usage = func() {
		fmt.Fprintf(c.Stdout, "Usage: handoffgraph claude %s [flags]\n\nFlags:\n", sub)
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
	configDir := stringFlag(subFS, "config-dir")
	if configDir == "" {
		configDir = stringFlag(fs, "config-dir")
	}
	hookCommand := stringFlag(subFS, "hook-command")
	if hookCommand == "" {
		hookCommand = stringFlag(fs, "hook-command")
	}
	projectsDir := stringFlag(subFS, "projects-dir")
	if projectsDir == "" {
		projectsDir = stringFlag(fs, "projects-dir")
	}
	dryRun := boolFlag(fs, "dry-run") || boolFlag(subFS, "dry-run")
	asJSON := boolFlag(fs, "json") || boolFlag(subFS, "json")
	workstreamID := pickString(stringFlag(subFS, "workstream"), stringFlag(fs, "workstream"))
	sessionID := pickString(stringFlag(subFS, "session"), stringFlag(fs, "session"))
	importEvents := boolFlag(fs, "import") || boolFlag(subFS, "import")
	if err := rejectNormalizeOnlyFlags("claude", sub, workstreamID, sessionID, importEvents); err != nil {
		return err
	}
	args = positional

	switch sub {
	case "install":
		a := newClaudeAdapter(configDir, projectsDir, hookCommand, dryRun)
		err := a.Install(ctx, adapter.ScopeUser)
		switch {
		case errors.Is(err, claudehooks.ErrHookConflict):
			return fmt.Errorf("claude install: %w", err)
		case errors.Is(err, claude.ErrUnsupported):
			return fmt.Errorf("claude install: %w", err)
		case err != nil:
			return fmt.Errorf("claude install: %w", err)
		}
		trailer := ""
		if configDir == "" {
			trailer = " (config: default ~/.claude)"
		} else {
			trailer = fmt.Sprintf(" (config: %s)", configDir)
		}
		if dryRun {
			trailer += " (dry run — no changes written)"
		}
		fmt.Fprintf(c.Stdout, "claude hooks installed for events: %s%s\n",
			strings.Join(claudehooks.HookEvents, ", "), trailer)
		return nil

	case "uninstall":
		a := newClaudeAdapter(configDir, projectsDir, "", dryRun)
		err := a.Uninstall(ctx, adapter.ScopeUser)
		switch {
		case errors.Is(err, claudehooks.ErrHookConflict):
			return fmt.Errorf("claude uninstall: %w", err)
		case errors.Is(err, claude.ErrUnsupported):
			return fmt.Errorf("claude uninstall: %w", err)
		case err != nil:
			return fmt.Errorf("claude uninstall: %w", err)
		}
		if dryRun {
			fmt.Fprintln(c.Stdout, "claude hooks would be removed (dry run — no changes written)")
		} else {
			fmt.Fprintln(c.Stdout, "claude hooks removed (user configuration preserved)")
		}
		return nil

	case "sessions":
		return claudeSessionsCmd(ctx, c, fs, subFS, projectsDir)

	case "normalize":
		return claudeNormalizeCmd(ctx, c, args, nativeNormalizeOptions{
			WorkstreamID: workstreamID,
			SessionID:    sessionID,
			Import:       importEvents,
			JSON:         asJSON,
		})

	case "resume":
		if len(args) != 1 {
			return fmt.Errorf("usage: claude resume <session-id> [--fork]")
		}
		a := newClaudeAdapter(configDir, projectsDir, "", false)
		ref := adapter.SessionRef{Provider: protocol.ProviderClaude, NativeID: args[0]}
		var (
			spec adapter.ExecSpec
			err  error
		)
		if boolFlag(fs, "fork") || boolFlag(subFS, "fork") {
			spec, err = a.Fork(ctx, ref)
		} else {
			spec, err = a.Resume(ctx, ref)
		}
		if err != nil {
			return fmt.Errorf("claude resume: %w", err)
		}
		fmt.Fprintln(c.Stdout, FormatExecSpec(spec.Command, spec.Args))
		return nil

	default:
		return fmt.Errorf("unknown claude subcommand %q (install|uninstall|sessions|normalize|resume)", sub)
	}
}

// parseInterspersed parses flags spread around positional arguments
// (`resume <id> --fork`, `resume --fork <id>`). The flag package stops at
// the first positional, so this moves leading positionals aside, parses the
// following flags, and repeats until every token is classified.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	rest := args
	for {
		i := 0
		for i < len(rest) && !strings.HasPrefix(rest[i], "-") {
			i++
		}
		positional = append(positional, rest[:i]...)
		rest = rest[i:]
		if len(rest) == 0 {
			return positional, nil
		}
		if err := fs.Parse(rest); err != nil {
			return nil, err
		}
		remaining := fs.Args()
		if len(remaining) == len(rest) {
			// No progress (a lone "-" token): treat the rest as positional.
			return append(positional, remaining...), nil
		}
		rest = remaining
	}
}

// claudeSessionOut is one row of the sessions listing. Times are
// preformatted as RFC3339 (zero times become "") so JSON output stays
// deterministic.
type claudeSessionOut struct {
	Agent           string `json:"agent"`
	NativeSessionID string `json:"native_session_id"`
	Path            string `json:"path,omitempty"`
	Events          int    `json:"events,omitempty"`
	FirstSeen       string `json:"first_seen,omitempty"`
	LastEventAt     string `json:"last_event_at,omitempty"`
}

// claudeSessionsCmd lists Claude sessions. Without --detect it aggregates
// captured events (provider claude) from the local database; with --detect
// it enumerates native transcripts from the projects directory.
func claudeSessionsCmd(ctx context.Context, c *cli.Context, fs, subFS *flag.FlagSet, projectsDir string) error {
	asJSON := boolFlag(fs, "json") || boolFlag(subFS, "json")

	if boolFlag(fs, "detect") || boolFlag(subFS, "detect") {
		if projectsDir == "" {
			// Same override convention as the codex lane's sessions dir.
			projectsDir = os.Getenv("HFG_CLAUDE_PROJECTS_DIR")
		}
		a := newClaudeAdapter("", projectsDir, "", false)
		refs, err := a.Detect(ctx, "")
		if err != nil {
			return fmt.Errorf("claude sessions: %w", err)
		}
		out := make([]claudeSessionOut, 0, len(refs))
		for _, ref := range refs {
			out = append(out, claudeSessionOut{
				Agent:           protocol.ProviderClaude,
				NativeSessionID: ref.NativeID,
				Path:            ref.Path,
				LastEventAt:     claudeFormatRFC3339OrEmpty(ref.LastEventAt),
			})
		}
		return emitClaudeSessions(c, out, asJSON)
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

	type agg struct {
		nativeID string
		count    int
		first    time.Time
		last     time.Time
	}
	byNative := map[string]*agg{}
	for _, ev := range events {
		if ev.Provider != protocol.ProviderClaude || ev.NativeSessionID == "" {
			continue
		}
		s, ok := byNative[ev.NativeSessionID]
		if !ok {
			s = &agg{nativeID: ev.NativeSessionID, first: ev.OccurredAt, last: ev.OccurredAt}
			byNative[ev.NativeSessionID] = s
		}
		s.count++
		if ev.OccurredAt.Before(s.first) {
			s.first = ev.OccurredAt
		}
		if ev.OccurredAt.After(s.last) {
			s.last = ev.OccurredAt
		}
	}

	// Deterministic order: sorted by native session id.
	keys := make([]string, 0, len(byNative))
	for k := range byNative {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]claudeSessionOut, 0, len(keys))
	for _, k := range keys {
		s := byNative[k]
		out = append(out, claudeSessionOut{
			Agent:           protocol.ProviderClaude,
			NativeSessionID: s.nativeID,
			Events:          s.count,
			FirstSeen:       s.first.Format(time.RFC3339),
			LastEventAt:     s.last.Format(time.RFC3339),
		})
	}
	return emitClaudeSessions(c, out, asJSON)
}

// emitClaudeSessions renders the session listing as JSON or TSV.
func emitClaudeSessions(c *cli.Context, out []claudeSessionOut, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, s := range out {
		last := s.LastEventAt
		if last == "" {
			last = "-"
		}
		fmt.Fprintf(c.Stdout, "%s\t%s\t%d\t%s\t%s\n",
			s.Agent, s.NativeSessionID, s.Events, s.FirstSeen, last)
	}
	return nil
}

// claudeNormalizeCmd converts a native Claude Code transcript into canonical
// events. The filename stem is a deterministic fallback for older transcript
// records that do not carry sessionId themselves.
func claudeNormalizeCmd(ctx context.Context, c *cli.Context, args []string, opts nativeNormalizeOptions) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: claude normalize <file> [--workstream <id>] [--session <id>] [--import | --json]")
	}
	path := args[0]
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("claude normalize: %w", err)
	}
	defer f.Close()

	fallbackNativeID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	events, err := (&claude.Claude{}).NormalizeTranscript(ctx, f, fallbackNativeID)
	if err != nil {
		return fmt.Errorf("claude normalize: %w", err)
	}
	return finishNativeNormalize(ctx, c, "claude normalize", protocol.ProviderClaude, events, opts)
}

// claudeFormatRFC3339OrEmpty renders t as RFC3339, or "" when zero.
func claudeFormatRFC3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
