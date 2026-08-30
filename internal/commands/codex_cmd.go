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
	"github.com/handoffgraph/handoffgraph/internal/buildinfo"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// RegisterCodexCmd registers the Codex adapter management command.
//
// Usage:
//
//	handoffgraph codex install    [--config-dir <dir>] [--hook-command <cmd>] [--dry-run]
//	handoffgraph codex uninstall  [--config-dir <dir>] [--dry-run]
//	handoffgraph codex sessions   [--sessions-dir <dir>] [--json]
//	handoffgraph codex app-server-sessions [--page-size <n>] [--max-pages <n>] [--json]
//	handoffgraph codex normalize  <file> [--workstream <id>] [--session <id>] [--import | --json]
//
// install/uninstall manage the marker-scoped [hooks.<event>] tables in
// <config-dir>/config.toml (default ~/.codex) via integrations/codex —
// merge-safe, fail-closed, idempotent. sessions enumerates native rollout
// transcripts from disk (default ~/.codex/sessions; HFG_CODEX_SESSIONS_DIR
// overrides). normalize prints the canonical hfg.event.v1 events a native
// rollout transcript normalizes to, with deterministic ids (JSONL by
// default, an indented array with --json). --workstream associates every
// event and derives a stable canonical session id; --import appends the
// associated events directly to the local event log. app-server-sessions is
// a separate, read-only stable-stdio listing path; it never replaces
// sessions/Detect.
func RegisterCodexCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "codex",
		Summary: "Manage the Codex adapter (install, uninstall, sessions, app-server-sessions, normalize)",
		Usage:   "install | uninstall | sessions | app-server-sessions | normalize <file> [flags]",
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
	fs.String("codex-binary", "", "Codex executable for app-server-sessions (default: codex from PATH)")
	fs.Int("page-size", 0, "App Server thread/list page size (default 100, maximum 1000)")
	fs.Int("max-pages", 0, "App Server pagination safety bound (default 100, maximum 1000)")
	fs.String("workstream", "", "associate normalized events with this workstream id (normalize)")
	fs.String("session", "", "canonical session id override (normalize; default derives from provider/native session)")
	fs.Bool("import", false, "append normalized events to the local event log (normalize; requires --workstream)")
	fs.Bool("dry-run", false, "perform all conflict checks without writing (install, uninstall)")
	fs.Bool("json", false, "emit JSON (session listings; indented array for normalize)")
}

// codexSubcommandFlags exposes only the flags meaningful to one subcommand.
// The outer command still accepts flags before the subcommand; help shown
// after it must not advertise unrelated install/normalize controls.
func codexSubcommandFlags(fs *flag.FlagSet, sub string) bool {
	switch sub {
	case "install":
		fs.String("config-dir", "", "Codex config directory override (default ~/.codex, env HFG_CODEX_CONFIG_DIR)")
		fs.String("hook-command", "", "hook command to install (defaults to this binary)")
		fs.Bool("dry-run", false, "perform all conflict checks without writing")
	case "uninstall":
		fs.String("config-dir", "", "Codex config directory override (default ~/.codex, env HFG_CODEX_CONFIG_DIR)")
		fs.Bool("dry-run", false, "perform all conflict checks without writing")
	case "sessions":
		fs.String("sessions-dir", "", "Codex sessions directory override (default ~/.codex/sessions, env HFG_CODEX_SESSIONS_DIR)")
		fs.Bool("json", false, "emit JSON")
	case "app-server-sessions":
		fs.String("codex-binary", "", "Codex executable (default: codex from PATH)")
		fs.Int("page-size", 0, "App Server thread/list page size (default 100, maximum 1000)")
		fs.Int("max-pages", 0, "App Server pagination safety bound (default 100, maximum 1000)")
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

// codexCmd dispatches the codex subcommand. Go's flag package stops parsing
// at the first positional argument, so flags placed after the subcommand
// are re-parsed here and merged (explicit inner values win; booleans
// combine) via the shared parseInterspersed helper.
func codexCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 {
		return fmt.Errorf("usage: codex install|uninstall|sessions|app-server-sessions|normalize <file> [flags]")
	}
	sub := args[0]
	subFS := flag.NewFlagSet("codex "+sub, flag.ContinueOnError)
	subFS.SetOutput(c.Stderr)
	if !codexSubcommandFlags(subFS, sub) {
		return fmt.Errorf("unknown codex subcommand %q (install|uninstall|sessions|app-server-sessions|normalize)", sub)
	}
	subFS.Usage = func() {
		fmt.Fprintf(c.Stdout, "Usage: handoffgraph codex %s [flags]\n\nFlags:\n", sub)
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
	configDir := pickString(stringFlag(subFS, "config-dir"), stringFlag(fs, "config-dir"))
	hookCommand := pickString(stringFlag(subFS, "hook-command"), stringFlag(fs, "hook-command"))
	sessionsDir := pickString(stringFlag(subFS, "sessions-dir"), stringFlag(fs, "sessions-dir"))
	codexBinary := pickString(stringFlag(subFS, "codex-binary"), stringFlag(fs, "codex-binary"))
	pageSize := intFlag(subFS, "page-size")
	if pageSize == 0 {
		pageSize = intFlag(fs, "page-size")
	}
	maxPages := intFlag(subFS, "max-pages")
	if maxPages == 0 {
		maxPages = intFlag(fs, "max-pages")
	}
	dryRun := boolFlag(fs, "dry-run") || boolFlag(subFS, "dry-run")
	asJSON := boolFlag(fs, "json") || boolFlag(subFS, "json")
	workstreamID := pickString(stringFlag(subFS, "workstream"), stringFlag(fs, "workstream"))
	sessionID := pickString(stringFlag(subFS, "session"), stringFlag(fs, "session"))
	importEvents := boolFlag(fs, "import") || boolFlag(subFS, "import")
	if err := rejectNormalizeOnlyFlags("codex", sub, workstreamID, sessionID, importEvents); err != nil {
		return err
	}

	switch sub {
	case "install":
		return codexInstallCmd(ctx, c, configDir, hookCommand, dryRun)
	case "uninstall":
		return codexUninstallCmd(ctx, c, configDir, dryRun)
	case "sessions":
		return codexSessionsCmd(ctx, c, sessionsDir, asJSON)
	case "app-server-sessions":
		if len(positional) != 0 {
			return fmt.Errorf("usage: codex app-server-sessions [--codex-binary <path>] [--page-size <n>] [--max-pages <n>] [--json]")
		}
		return codexAppServerSessionsCmd(ctx, c, codexBinary, pageSize, maxPages, asJSON)
	case "normalize":
		return codexNormalizeCmd(ctx, c, positional, nativeNormalizeOptions{
			WorkstreamID: workstreamID,
			SessionID:    sessionID,
			Import:       importEvents,
			JSON:         asJSON,
		})
	default:
		return fmt.Errorf("unknown codex subcommand %q (install|uninstall|sessions|app-server-sessions|normalize)", sub)
	}
}

type codexAppServerSessionOut struct {
	Agent                string          `json:"agent"`
	Transport            string          `json:"transport"`
	NativeSessionID      string          `json:"native_session_id"`
	NativeSessionGroupID string          `json:"native_session_group_id"`
	StartedAt            string          `json:"started_at"`
	LastEventAt          string          `json:"last_event_at"`
	WorkingDirectory     string          `json:"working_directory"`
	Title                string          `json:"title,omitempty"`
	Preview              string          `json:"preview,omitempty"`
	ModelProvider        string          `json:"model_provider"`
	CodexCLIVersion      string          `json:"codex_cli_version"`
	NativeSource         json.RawMessage `json:"native_source"`
	Ephemeral            bool            `json:"ephemeral"`
}

// codexAppServerSessionsCmd lists stable thread metadata through a separate
// read-only App Server client. The client sends only initialize, initialized,
// and state-DB-only thread/list requests over stdio. It does not alter the
// file-based `codex sessions`/Detect path.
func codexAppServerSessionsCmd(ctx context.Context, c *cli.Context, binary string, pageSize, maxPages int, asJSON bool) error {
	refs, err := codex.NewAppServerClient(codex.AppServerOptions{
		Binary:        binary,
		ClientVersion: buildinfo.Version(),
		PageSize:      pageSize,
		MaxPages:      maxPages,
	}).ListSessions(ctx)
	if err != nil {
		return fmt.Errorf("codex app-server-sessions: %w", err)
	}
	return writeCodexAppServerSessions(c, refs, asJSON)
}

func writeCodexAppServerSessions(c *cli.Context, refs []adapter.SessionRef, asJSON bool) error {
	rows := make([]codexAppServerSessionOut, 0, len(refs))
	for _, ref := range refs {
		if ref.Metadata == nil {
			return fmt.Errorf("codex app-server-sessions: session %q is missing native metadata", ref.NativeID)
		}
		rows = append(rows, codexAppServerSessionOut{
			Agent:                ref.Provider,
			Transport:            codex.AppServerTransport,
			NativeSessionID:      ref.NativeID,
			NativeSessionGroupID: ref.Metadata.NativeGroupID,
			StartedAt:            codexFormatRFC3339OrEmpty(ref.StartedAt),
			LastEventAt:          codexFormatRFC3339OrEmpty(ref.LastEventAt),
			WorkingDirectory:     ref.Metadata.WorkingDir,
			Title:                ref.Metadata.Title,
			Preview:              ref.Metadata.Preview,
			ModelProvider:        ref.Metadata.ModelProvider,
			CodexCLIVersion:      ref.Metadata.CLIVersion,
			NativeSource:         append(json.RawMessage(nil), ref.Metadata.NativeSource...),
			Ephemeral:            ref.Metadata.Ephemeral,
		})
	}
	if asJSON {
		encoder := json.NewEncoder(c.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(rows)
	}
	if len(rows) == 0 {
		fmt.Fprintln(c.Stdout, "no codex App Server sessions found (file-based `codex sessions` is unchanged)")
		return nil
	}
	for _, row := range rows {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\n",
			row.Agent,
			row.NativeSessionID,
			row.LastEventAt,
			codexSingleLine(row.WorkingDirectory),
			string(row.NativeSource),
		)
	}
	return nil
}

func codexSingleLine(value string) string {
	return strings.NewReplacer("\t", `\t`, "\r", `\r`, "\n", `\n`).Replace(value)
}

// defaultCodexHookCommand resolves the default hook command to the public
// stdin-ingest surface of this binary.
func defaultCodexHookCommand() (string, error) {
	if exe, err := os.Executable(); err == nil {
		return adapter.DefaultHookCommand(exe, protocol.ProviderCodex)
	}
	return adapter.DefaultHookCommand("handoffgraph", protocol.ProviderCodex)
}

func codexInstallCmd(ctx context.Context, c *cli.Context, configDir, hookCommand string, dryRun bool) error {
	if hookCommand == "" {
		var err error
		hookCommand, err = defaultCodexHookCommand()
		if err != nil {
			return fmt.Errorf("codex install: resolve hook command: %w", err)
		}
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
func codexNormalizeCmd(ctx context.Context, c *cli.Context, args []string, opts nativeNormalizeOptions) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: codex normalize <file> [--workstream <id>] [--session <id>] [--import | --json]")
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
	return finishNativeNormalize(ctx, c, "codex normalize", protocol.ProviderCodex, events, opts)
}

// codexFormatRFC3339OrEmpty renders t as RFC3339, or "" when zero.
func codexFormatRFC3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
