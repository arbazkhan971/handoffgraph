// Package commands registers the concrete HandoffGraph subcommands.
package commands

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/ingest"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
	"github.com/handoffgraph/handoffgraph/internal/verify"
)

// Register adds all commands to the app.
func Register(app *cli.App) {
	app.Register(&cli.Command{Name: "version", Summary: "Print the version", Run: versionCmd})
	app.Register(&cli.Command{Name: "init", Summary: "Initialize the local data directory", Run: initCmd})
	app.Register(&cli.Command{Name: "doctor", Summary: "Diagnose configuration and database health", Run: doctorCmd})
	app.Register(&cli.Command{Name: "status", Summary: "Show local capture status", Run: statusCmd})
	app.Register(&cli.Command{Name: "workstream", Summary: "Create or list workstreams", Usage: "new <title> | list", Run: workstreamCmd})
	app.Register(&cli.Command{Name: "event", Summary: "Import events from a JSONL fixture", Usage: "import <file>", Run: eventCmd})
	app.Register(&cli.Command{
		Name: "graph", Summary: "Export the derived workstream graph", Usage: "[--json]",
		Flags: func(fs *flag.FlagSet) { fs.Bool("json", false, "emit JSON") },
		Run:   graphCmd,
	})
	app.Register(&cli.Command{
		Name: "traces", Summary: "List materialized turn traces", Usage: "[--json]",
		Flags: func(fs *flag.FlagSet) { fs.Bool("json", false, "emit JSON") },
		Run:   tracesCmd,
	})
	app.Register(&cli.Command{
		Name: "checkpoint", Summary: "Build a checkpoint from captured events",
		Usage: "--workstream <id> [--objective text] [--status status]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "workstream id")
			fs.String("objective", "", "checkpoint objective")
			fs.String("status", "in_progress", "checkpoint status")
		},
		Run: checkpointCmd,
	})
	app.Register(&cli.Command{
		Name: "redact", Summary: "Preview redaction of an event file", Usage: "--preview <file>",
		Flags: func(fs *flag.FlagSet) { fs.String("preview", "", "file to preview redaction") },
		Run:   redactCmd,
	})
	app.Register(&cli.Command{Name: "fixture", Summary: "Verify golden fixtures", Usage: "verify <dir>", Run: fixtureCmd})
	app.Register(&cli.Command{
		Name: "install", Summary: "Install capture hooks for an agent adapter",
		Usage: "--agent codex [--dry-run] [--hook-command <cmd>] [--config-dir <dir>]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("agent", "codex", "agent adapter name")
			fs.Bool("dry-run", false, "show what would change without writing")
			fs.String("hook-command", "", "hook command to install (defaults to this binary)")
			fs.String("config-dir", "", "provider config directory override")
		},
		Run: installCmd,
	})
	app.Register(&cli.Command{
		Name: "sessions", Summary: "List native sessions known from captured events",
		Usage: "[--agent <name>] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("agent", "", "filter by provider name")
			fs.Bool("json", false, "emit JSON")
		},
		Run: sessionsCmd,
	})
	app.Register(&cli.Command{
		Name: "resume", Summary: "Resume a native session in its agent CLI",
		Usage: "<native-session-id> [--agent codex]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("agent", "codex", "agent adapter name")
		},
		Run: resumeCmd,
	})
}

// resolveAdapter looks up the named adapter in the default registry.
func resolveAdapter(name string) (adapter.Adapter, error) {
	reg := codex.DefaultRegistry()
	a, ok := reg.ByName(adapter.Name(name))
	if !ok {
		return nil, fmt.Errorf("unknown agent %q (available: %s)", name, strings.Join(reg.Names(), ", "))
	}
	return a, nil
}

// loadConfigAndDB loads config and opens the database, returning both.
func loadConfigAndDB() (*config.Config, *storage.DB, error) {
	cfg, err := config.Load(".")
	if err != nil {
		return nil, nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, nil, err
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		return nil, nil, err
	}
	return cfg, db, nil
}

func versionCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	fmt.Fprintf(c.Stdout, "handoffgraph %s\n", buildVersion)
	return nil
}

func initCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	cfg, err := config.Load(".")
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := cfg.EnsureDirs(); err != nil {
		return err
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()
	fmt.Fprintf(c.Stdout, "Initialized HandoffGraph at %s\n", cfg.DataDir)
	return nil
}

func doctorCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	cfg, err := config.Load(".")
	if err != nil {
		return err
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer db.Close()

	ok := true
	fmt.Fprintln(c.Stdout, "HandoffGraph doctor")
	fmt.Fprintln(c.Stdout, "-------------------")

	schemaVer, err := db.SchemaVersion()
	if err != nil {
		fmt.Fprintf(c.Stdout, "schema version: ERROR %v\n", err)
		ok = false
	} else {
		fmt.Fprintf(c.Stdout, "schema version: %d\n", schemaVer)
	}

	userVer, err := db.UserVersion()
	if err != nil {
		fmt.Fprintf(c.Stdout, "user_version: ERROR %v\n", err)
		ok = false
	} else {
		fmt.Fprintf(c.Stdout, "sqlite user_version: %d\n", userVer)
	}

	count, err := db.EventCount(ctx)
	if err != nil {
		fmt.Fprintf(c.Stdout, "event count: ERROR %v\n", err)
		ok = false
	} else {
		fmt.Fprintf(c.Stdout, "event count: %d\n", count)
	}

	if ok {
		fmt.Fprintln(c.Stdout, "status: OK")
	} else {
		fmt.Fprintln(c.Stdout, "status: PROBLEMS FOUND")
	}
	return nil
}

func statusCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	count, err := db.EventCount(ctx)
	if err != nil {
		return err
	}
	byKind, err := db.CountByKind(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "events: %d\n", count)
	fmt.Fprintln(c.Stdout, "by kind:")
	keys := make([]string, 0, len(byKind))
	for k := range byKind {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(c.Stdout, "  %-24s %d\n", k, byKind[k])
	}
	return nil
}

func workstreamCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) == 0 {
		return fmt.Errorf("usage: workstream new <title> | workstream list")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	switch args[0] {
	case "new":
		if len(args) < 2 {
			return fmt.Errorf("usage: workstream new <title>")
		}
		id := ids.Workstream()
		if err := db.CreateWorkstream(ctx, id, args[1], ""); err != nil {
			return err
		}
		fmt.Fprintln(c.Stdout, id)
		return nil
	case "list":
		ws, err := db.ListWorkstreams(ctx)
		if err != nil {
			return err
		}
		for _, w := range ws {
			fmt.Fprintf(c.Stdout, "%s\t%s\n", w.ID, w.Title)
		}
		return nil
	default:
		return fmt.Errorf("unknown workstream subcommand %q", args[0])
	}
}

func eventCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) < 2 || args[0] != "import" {
		return fmt.Errorf("usage: event import <file>")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	path := args[1]
	n, errs, err := ingest.ImportFile(ctx, path, db.AppendEvent)
	if err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "imported %d events from %s\n", n, path)
	for _, e := range errs {
		fmt.Fprintf(c.Stderr, "warning: %v\n", e)
	}
	return nil
}

func graphCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	g := graph.Reduce(events)
	hash, err := graph.RootHash(g)
	if err != nil {
		return err
	}
	if boolFlag(fs, "json") {
		out, err := g.ToJSON()
		if err != nil {
			return err
		}
		fmt.Fprintln(c.Stdout, string(out))
		return nil
	}
	fmt.Fprintf(c.Stdout, "nodes: %d\nedges: %d\nroot hash: %s\n", len(g.Nodes), len(g.Edges), hash)
	return nil
}

func tracesCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	res := trace.Materialize(events)

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(res.Traces)
	}
	for _, tr := range res.Traces {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%d spans\t%s\n",
			tr.TraceID, tr.Status, tr.Provider, tr.SpanCount, tr.VerificationState)
	}
	return nil
}

func checkpointCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	wsID := stringFlag(fs, "workstream")
	objective := stringFlag(fs, "objective")
	status := stringFlag(fs, "status")
	if wsID == "" {
		return fmt.Errorf("--workstream is required")
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
	repoState, _ := repository.State(ctx, ".")

	cp, err := checkpoint.Build(ctx, checkpoint.BuildOptions{
		WorkstreamID: wsID,
		Objective:    objective,
		Status:       status,
		Repo:         repoState,
		Events:       events,
	})
	if err != nil {
		return err
	}

	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		return err
	}

	out, err := json.MarshalIndent(cp, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(c.Stdout, string(out))
	return nil
}

func redactCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	preview := stringFlag(fs, "preview")
	if preview == "" {
		return fmt.Errorf("--preview <file> is required")
	}

	cfg, err := config.Load(".")
	if err != nil {
		return err
	}
	engine, err := redact.New(redact.Options{DenyPaths: cfg.RedactDenyPaths, UserPatterns: cfg.RedactPatterns})
	if err != nil {
		return err
	}

	data, err := os.ReadFile(preview)
	if err != nil {
		return err
	}

	// The preview input is JSONL: one event per line. Redaction is
	// fail-closed per line — any error aborts the whole preview.
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			return fmt.Errorf("line %d: %w", lineNo, err)
		}
		result, err := engine.RedactEvent(&ev)
		if err != nil {
			return fmt.Errorf("redaction failed (fail-closed) at line %d: %w", lineNo, err)
		}
		out, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		fmt.Fprintf(c.Stdout, "line %d redaction status: %s\n", lineNo, result.Status)
		if len(result.FieldsRemoved) > 0 {
			fmt.Fprintf(c.Stdout, "line %d fields removed: %v\n", lineNo, result.FieldsRemoved)
		}
		fmt.Fprintln(c.Stdout, string(out))
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func fixtureCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) < 2 || args[0] != "verify" {
		return fmt.Errorf("usage: fixture verify <dir>")
	}
	res, err := verify.Verify(ctx, args[1])
	if err != nil {
		return err
	}
	out, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(c.Stdout, string(out))
	if len(res.Failures) > 0 {
		return fmt.Errorf("%d fixture failure(s)", len(res.Failures))
	}
	return nil
}

func installCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	name := stringFlag(fs, "agent")
	dryRun := boolFlag(fs, "dry-run")
	hookFlag := stringFlag(fs, "hook-command")
	configDir := stringFlag(fs, "config-dir")

	hookCmd := hookFlag
	if hookCmd == "" {
		exe, err := os.Executable()
		if err != nil {
			hookCmd = "handoffgraph"
		} else {
			hookCmd = exe
		}
	}

	a, err := resolveAdapter(name)
	if err != nil {
		return err
	}
	err = a.Install(ctx, adapter.InstallOptions{DryRun: dryRun, HookCommand: hookCmd, ConfigDir: configDir})
	switch {
	case errors.Is(err, adapter.ErrHookConflict):
		return fmt.Errorf("install: %w", err)
	case errors.Is(err, adapter.ErrUnsupported):
		return fmt.Errorf("install: %w", err)
	case err != nil:
		return fmt.Errorf("install: %s: %w", name, err)
	}

	trailer := fmt.Sprintf(" (config: %s)", configDir)
	if trailer == " (config: )" {
		trailer = " (config: default)"
	}
	if dryRun {
		trailer = " (dry run — no changes written)"
	}
	fmt.Fprintf(c.Stdout, "install: agent %s ok%s\n", name, trailer)
	return nil
}

func sessionsCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	agentFilter := stringFlag(fs, "agent")
	asJSON := boolFlag(fs, "json")

	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}

	type sessionAgg struct {
		provider  string
		sessionID string
		count     int
		first     time.Time
		last      time.Time
	}
	agg := map[string]*sessionAgg{}
	for _, ev := range events {
		if ev.NativeSessionID == "" {
			continue
		}
		if agentFilter != "" && ev.Provider != agentFilter {
			continue
		}
		key := ev.Provider + "\x00" + ev.NativeSessionID
		s, ok := agg[key]
		if !ok {
			s = &sessionAgg{provider: ev.Provider, sessionID: ev.NativeSessionID, first: ev.OccurredAt, last: ev.OccurredAt}
			agg[key] = s
		}
		s.count++
		if ev.OccurredAt.Before(s.first) {
			s.first = ev.OccurredAt
		}
		if ev.OccurredAt.After(s.last) {
			s.last = ev.OccurredAt
		}
	}

	keys := make([]string, 0, len(agg))
	for k := range agg {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	type sessionOut struct {
		Provider        string `json:"provider"`
		NativeSessionID string `json:"native_session_id"`
		Events          int    `json:"events"`
		FirstSeen       string `json:"first_seen"`
		LastSeen        string `json:"last_seen"`
	}
	out := make([]sessionOut, 0, len(agg))
	for _, k := range keys {
		s := agg[k]
		out = append(out, sessionOut{
			Provider:        s.provider,
			NativeSessionID: s.sessionID,
			Events:          s.count,
			FirstSeen:       s.first.Format(time.RFC3339),
			LastSeen:        s.last.Format(time.RFC3339),
		})
	}

	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, s := range out {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%d\t%s\t%s\n", s.Provider, s.NativeSessionID, s.Events, s.FirstSeen, s.LastSeen)
	}
	return nil
}

func resumeCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) != 1 {
		return fmt.Errorf("usage: resume <native-session-id> [--agent <name>]")
	}
	name := stringFlag(fs, "agent")

	a, err := resolveAdapter(name)
	if err != nil {
		return err
	}
	if err := a.Resume(ctx, adapter.SessionRef{Agent: adapter.Name(name), NativeSessionID: args[0]}); err != nil {
		if errors.Is(err, adapter.ErrUnsupported) {
			return fmt.Errorf("resume: %s does not support native resume yet (planned v0.2.x)", name)
		}
		return fmt.Errorf("resume: %w", err)
	}
	return nil
}

// buildVersion is overridden at build time via -ldflags "-X ...".
var buildVersion = "v0.1.0-dev"
