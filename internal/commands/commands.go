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
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/adapter/pi"
	"github.com/handoffgraph/handoffgraph/internal/buildinfo"
	"github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/ingest"
	"github.com/handoffgraph/handoffgraph/internal/observations"
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
	app.Register(&cli.Command{
		Name: "doctor", Summary: "Diagnose configuration and database health",
		Usage: "[--verify] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.Bool("verify", false, "run deep health checks: schema version, observations freshness, redaction pattern compile, data-dir disk usage (parity row 52)")
			fs.Bool("json", false, "emit JSON")
		},
		Run: doctorCmd,
	})
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
		Usage: "--workstream <id> ... | --from-trace <id> ... | show <id> [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "workstream id")
			fs.String("from-trace", "", "build from one materialized trace")
			fs.String("objective", "", "checkpoint objective")
			fs.String("status", "in_progress", "checkpoint status")
			fs.Bool("json", false, "emit JSON for checkpoint show")
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
		Usage: "[--agent <name>] [--signal-source native|hook|sdk|import] [--include-shadowed] [--json] [--detect]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("agent", "", "filter by provider name")
			fs.String("signal-source", "", "filter by signal source: native | hook | sdk | import")
			fs.Bool("include-shadowed", false, "include sessions coalescing folded into a higher-precedence source")
			fs.Bool("json", false, "emit JSON")
			fs.Bool("detect", false, "detect native sessions from disk (HFG_CODEX_SESSIONS_DIR overrides the codex sessions dir)")
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

	// Register every shipped product surface in the application used by the
	// real binary. The focused Register*Cmd helpers also make each lane easy
	// to test in isolation without leaving it unreachable from the CLI.
	RegisterCodexCmd(app)
	RegisterClaudeCmd(app)
	RegisterHookCmd(app)
	RegisterPiCmd(app)
	RegisterMCPCmd(app)
	RegisterDetectionCmd(app)
	RegisterWebUICmd(app)
	RegisterLaunchCmd(app)
	RegisterOTLPCmd(app)
	RegisterScoreCmd(app)
	RegisterIndexCmd(app)
	RegisterAnalyticsCmd(app)
	RegisterVerifyCmd(app)
	RegisterDatasetCmd(app)
	RegisterPromptCmd(app)
	RegisterResetCmd(app)
	RegisterSyncCmd(app)
}

// resolveAdapter looks up the named adapter in the default registry.
//
// It builds a fresh registry (and therefore fresh concrete adapters) on
// every call, so mutating the returned adapter — e.g. pointing the codex
// adapter at an override sessions directory before Detect — cannot leak
// into other invocations. If this ever becomes a shared registry, such
// mutation must be reworked into explicit configuration.
func resolveAdapter(name string) (adapter.Adapter, error) {
	if name == "" {
		name = protocol.ProviderCodex // default agent mirrors the roadmap UX
	}
	reg := adapter.NewRegistry(codex.New(), claude.New(), pi.New())
	a, ok := reg.Get(name)
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
	fmt.Fprintf(c.Stdout, "handoffgraph %s\n", buildinfo.Version())
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

// doctorReport is the structured `doctor` output. It reuses the verify
// package's Check shape (name/passed/detail) so both diagnostic surfaces
// render the same way.
type doctorReport struct {
	Passed bool    `json:"passed"`
	Deep   bool    `json:"deep"`
	Checks []Check `json:"checks"`
}

// doctorCmd runs basic config/DB health checks, and with --verify (parity
// row 52) a deeper pass beyond that: schema-at-expected-version, event
// count + max seq, observations freshness, redaction pattern compile, and
// data-dir disk usage. It never bails out early on a failing check — every
// check that can run does, so one report always covers the whole picture —
// and exits non-zero (via a returned error, matching `verify`'s CI-ready
// convention) when any check failed.
func doctorCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	deep := boolFlag(fs, "verify")
	asJSON := boolFlag(fs, "json")

	var report doctorReport
	report.Deep = deep
	add := func(name string, passed bool, detail string) {
		report.Checks = append(report.Checks, Check{Name: name, Passed: passed, Detail: detail})
	}

	cfg, err := config.Load(".")
	if err != nil {
		// No data directory could even be resolved: nothing further to
		// check against, so this stays a hard error rather than a check.
		return err
	}

	db, dbErr := storage.Open(cfg.DBPath)
	add("db_opens", dbErr == nil, errDetail(dbErr))
	if dbErr != nil {
		return finishDoctor(c, &report, asJSON)
	}
	defer db.Close()

	schemaVer, verErr := db.SchemaVersion()
	add("schema_version", verErr == nil, firstNonEmpty(errDetail(verErr), fmt.Sprintf("version %d", schemaVer)))

	userVer, uvErr := db.UserVersion()
	add("user_version", uvErr == nil, firstNonEmpty(errDetail(uvErr), fmt.Sprintf("sqlite user_version %d", userVer)))

	count, cntErr := db.EventCount(ctx)
	add("event_count", cntErr == nil, firstNonEmpty(errDetail(cntErr), fmt.Sprintf("%d event(s)", count)))

	if deep {
		expected := storage.LatestSchemaVersion()
		add("schema_at_expected_version", verErr == nil && schemaVer == expected,
			fmt.Sprintf("applied %d, binary expects %d", schemaVer, expected))

		maxSeq, seqErr := db.MaxSeq(ctx)
		add("max_seq", seqErr == nil, firstNonEmpty(errDetail(seqErr), fmt.Sprintf("max_seq %d", maxSeq)))

		stale, staleErr := db.ObservationsStale(ctx)
		add("observations_fresh", staleErr == nil && !stale,
			firstNonEmpty(errDetail(staleErr), staleDetail(stale)))

		_, redErr := redact.New(redact.Options{DenyPaths: cfg.RedactDenyPaths, UserPatterns: cfg.RedactPatterns})
		add("redaction_patterns_compile", redErr == nil,
			firstNonEmpty(errDetail(redErr), fmt.Sprintf("%d deny path(s), %d user pattern(s)", len(cfg.RedactDenyPaths), len(cfg.RedactPatterns))))

		size, sizeErr := dirSize(cfg.DataDir)
		add("data_dir_disk_usage", sizeErr == nil,
			firstNonEmpty(errDetail(sizeErr), fmt.Sprintf("%s at %s", humanBytes(size), cfg.DataDir)))
	}

	report.Passed = true
	for _, ck := range report.Checks {
		if !ck.Passed {
			report.Passed = false
		}
	}
	return finishDoctor(c, &report, asJSON)
}

// finishDoctor renders the report (JSON or text) and turns an overall
// failure into a non-nil error so main.go exits non-zero.
func finishDoctor(c *cli.Context, report *doctorReport, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(c.Stdout, "HandoffGraph doctor")
		fmt.Fprintln(c.Stdout, "-------------------")
		for _, ck := range report.Checks {
			mark := "OK"
			if !ck.Passed {
				mark = "FAIL"
			}
			fmt.Fprintf(c.Stdout, "%-28s %s", ck.Name, mark)
			if ck.Detail != "" {
				fmt.Fprintf(c.Stdout, "  (%s)", ck.Detail)
			}
			fmt.Fprintln(c.Stdout)
		}
		if report.Passed {
			fmt.Fprintln(c.Stdout, "status: OK")
		} else {
			fmt.Fprintln(c.Stdout, "status: PROBLEMS FOUND")
		}
	}
	if !report.Passed {
		failed := 0
		for _, ck := range report.Checks {
			if !ck.Passed {
				failed++
			}
		}
		return fmt.Errorf("doctor: %d check(s) failed", failed)
	}
	return nil
}

// errDetail renders err for a check's Detail field, or "" when err is nil.
func errDetail(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// firstNonEmpty returns a if it is non-empty, else b. Used to prefer an
// error string over the success detail when a check failed.
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func staleDetail(stale bool) string {
	if stale {
		return "derived observations table is behind the event log; run `handoffgraph index rebuild`"
	}
	return "up to date with the event log"
}

// dirSize sums the apparent size of every regular file under root.
func dirSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, err
	}
	return total, nil
}

// humanBytes renders n as a binary-prefixed size (KiB/MiB/...), matching
// the conventional Go idiom for byte-count display.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
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
	if handled, err := checkpointV06Cmd(ctx, c, fs); handled {
		return err
	}
	wsID := stringFlag(fs, "workstream")
	objective := stringFlag(fs, "objective")
	status := stringFlag(fs, "status")
	if wsID == "" {
		return fmt.Errorf("--workstream is required")
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
	repoState, _ := repository.State(ctx, ".")

	cp, err := checkpoint.Build(ctx, checkpoint.BuildOptions{
		WorkstreamID: wsID,
		Objective:    objective,
		Status:       status,
		Repo:         repoState,
		Events:       events,
		Redaction: &redact.Options{
			DenyPaths:    cfg.RedactDenyPaths,
			UserPatterns: cfg.RedactPatterns,
		},
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
	// Native codex rollouts are verified through the adapter's stream
	// normalizer (injected here at the commands layer; the verify package
	// itself stays free of concrete-adapter imports).
	res, err := verify.Verify(ctx, args[1], verify.VerifyOptions{
		NormalizeNative: (&codex.Codex{}).NormalizeStream,
	})
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
	hookCommand := stringFlag(fs, "hook-command")
	configDir := stringFlag(fs, "config-dir")

	a, err := resolveAdapter(name)
	if err != nil {
		return err
	}
	// The generic entrypoint must be behaviorally equivalent to each
	// provider-specific installer. In particular, dry-run still executes all
	// fail-closed conflict checks, and every advertised override is routed to
	// the selected provider instead of being silently ignored.
	switch v := a.(type) {
	case *codex.Codex:
		v.ConfigDir = configDir
		v.HookCommand = hookCommand
		v.DryRun = dryRun
	case *claude.Claude:
		v.ConfigDir = configDir
		v.HookCommand = hookCommand
		v.DryRun = dryRun
	case *pi.Pi:
		if hookCommand != "" {
			return fmt.Errorf("install: agent pi does not support --hook-command")
		}
		v.AgentDir = configDir
		if dryRun {
			dir := v.ResolvedAgentDir()
			if err := v.InstallExtension(ctx, dir, pi.InstallOptions{DryRun: true}); err != nil {
				return fmt.Errorf("install: pi: %w", err)
			}
			fmt.Fprintln(c.Stdout, "install: agent pi ok (dry run — no changes written)")
			return nil
		}
	}
	err = a.Install(ctx, adapter.ScopeUser)
	switch {
	case errors.Is(err, adapter.ErrHookConflict):
		return fmt.Errorf("install: %w", err)
	case errors.Is(err, adapter.ErrUnsupported):
		return fmt.Errorf("install: %w", err)
	case err != nil:
		return fmt.Errorf("install: %s: %w", name, err)
	}
	if dryRun {
		fmt.Fprintf(c.Stdout, "install: agent %s ok (dry run — no changes written)\n", name)
		return nil
	}

	trailer := fmt.Sprintf(" (config: %s)", configDir)
	if trailer == " (config: )" {
		trailer = " (config: default)"
	}
	fmt.Fprintf(c.Stdout, "install: agent %s ok%s\n", name, trailer)
	return nil
}

// detectSessionOut is one row of the sessions --detect listing. Times are
// preformatted as RFC3339 (zero times become "") so the JSON output stays
// deterministic and free of time.Time marshaling surprises.
type detectSessionOut struct {
	Agent           string `json:"agent"`
	NativeSessionID string `json:"native_session_id"`
	Path            string `json:"path"`
	StartedAt       string `json:"started_at"`
	EndedAt         string `json:"ended_at"`
	LastEventAt     string `json:"last_event_at"`
	Model           string `json:"model"`
}

// formatRFC3339OrEmpty renders t as RFC3339, or "" when zero.
func formatRFC3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func sessionsCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	agentFilter := stringFlag(fs, "agent")
	asJSON := boolFlag(fs, "json")

	if boolFlag(fs, "detect") {
		return sessionsDetect(ctx, c, agentFilter, asJSON)
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

	sourceFilter := stringFlag(fs, "signal-source")
	if sourceFilter != "" {
		src, ok := observations.ParseSignalSource(sourceFilter)
		if !ok {
			return fmt.Errorf("--signal-source must be native, hook, sdk or import")
		}
		sourceFilter = string(src)
	}

	// Signal coalescing (parity-plan row 5): one logical agent run can reach
	// us through the vendor's native OTel export, our hook adapter and an SDK
	// wrapper at once. Rows are aggregated per (provider, native_session_id)
	// as before, then folded into their cross-pipeline coalesce key so the
	// listing presents ONE canonical session per run. The lower-precedence
	// rows are marked shadowed and hidden by default rather than dropped.
	type sessionAgg struct {
		provider  string
		sessionID string
		count     int
		first     time.Time
		last      time.Time
		signal    observations.SignalSource
		coalesce  string
		shadowed  bool
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
		signal := sessionSignalSource(ev)
		s, ok := agg[key]
		if !ok {
			s = &sessionAgg{
				provider: ev.Provider, sessionID: ev.NativeSessionID,
				first: ev.OccurredAt, last: ev.OccurredAt, signal: signal,
				coalesce: observations.CoalesceKey(
					observations.CanonicalProvider(ev.Provider, ev.Agent), ev.NativeSessionID),
			}
			agg[key] = s
		}
		if observations.Precedence(signal) > observations.Precedence(s.signal) {
			s.signal = signal
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

	// Canonical source per coalesce key, then the shadow verdict. Both are
	// pure functions of the aggregate set: iteration runs over the sorted
	// keys, so import order cannot change who wins.
	best := map[string]int{}
	for _, k := range keys {
		s := agg[k]
		if s.coalesce == "" {
			continue
		}
		if p := observations.Precedence(s.signal); p > best[s.coalesce] {
			best[s.coalesce] = p
		}
	}
	for _, k := range keys {
		s := agg[k]
		if s.coalesce == "" {
			continue
		}
		s.shadowed = observations.Precedence(s.signal) < best[s.coalesce]
	}

	type sessionOut struct {
		Provider        string `json:"provider"`
		NativeSessionID string `json:"native_session_id"`
		Events          int    `json:"events"`
		FirstSeen       string `json:"first_seen"`
		LastSeen        string `json:"last_seen"`
		SignalSource    string `json:"signal_source"`
		Shadowed        bool   `json:"shadowed"`
	}
	out := make([]sessionOut, 0, len(agg))
	for _, k := range keys {
		s := agg[k]
		if sourceFilter != "" && string(s.signal) != sourceFilter {
			continue
		}
		if s.shadowed && !boolFlag(fs, "include-shadowed") {
			continue
		}
		out = append(out, sessionOut{
			Provider:        s.provider,
			NativeSessionID: s.sessionID,
			Events:          s.count,
			FirstSeen:       s.first.Format(time.RFC3339),
			LastSeen:        s.last.Format(time.RFC3339),
			SignalSource:    string(s.signal),
			Shadowed:        s.shadowed,
		})
	}

	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	// The text columns are stable across releases; the signal source and the
	// coalescing verdict ride on the JSON form.
	for _, s := range out {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%d\t%s\t%s\n", s.Provider, s.NativeSessionID, s.Events, s.FirstSeen, s.LastSeen)
	}
	return nil
}

// sessionSignalSource classifies one raw event's pipeline. OTLP events carry
// their instrumentation hints in the span payload's attributes; adapter
// events are classified from the event shape alone.
func sessionSignalSource(ev *protocol.Event) observations.SignalSource {
	var attrs map[string]any
	if len(ev.Payload) > 0 {
		var m map[string]any
		if err := json.Unmarshal(ev.Payload, &m); err == nil {
			attrs, _ = m["attributes"].(map[string]any)
		}
	}
	src, _ := observations.DeriveSignalSource(ev.Provider, attrs)
	return src
}

// sessionsDetect enumerates native sessions directly from disk via the
// adapter's Detect, bypassing config and the database entirely. It is the
// sessions command's --detect mode.
func sessionsDetect(ctx context.Context, c *cli.Context, agentFilter string, asJSON bool) error {
	// Detect enumerates one adapter's native sessions, so an unset --agent
	// means the default adapter (codex), mirroring install/resume. This does
	// not touch the DB-backed path, where "" still means "no filter".
	if agentFilter == "" {
		agentFilter = protocol.ProviderCodex
	}
	a, err := resolveAdapter(agentFilter)
	if err != nil {
		return err
	}
	// Test/diagnostics hook: point the codex adapter at an override
	// sessions directory without widening the Adapter interface. Safe
	// because resolveAdapter builds a fresh registry (and fresh concrete
	// adapter) per invocation; see its doc comment.
	if dir := os.Getenv("HFG_CODEX_SESSIONS_DIR"); dir != "" {
		if cx, ok := a.(*codex.Codex); ok {
			cx.SessionsDir = dir
		}
	}

	refs, err := a.Detect(ctx, "")
	if errors.Is(err, adapter.ErrNotDetected) {
		refs = nil // nothing on disk: an empty listing, not an error
	} else if err != nil {
		return fmt.Errorf("sessions: %w", err)
	}

	// Newest first using the timestamp the provider actually supplies:
	// Codex reports StartedAt, while Claude and Pi report LastEventAt. Path
	// and native id break ties deterministically. Sort before formatting so
	// both text and JSON output stay deterministic.
	sort.Slice(refs, func(i, j int) bool {
		iTime := refs[i].StartedAt
		if iTime.IsZero() {
			iTime = refs[i].LastEventAt
		}
		jTime := refs[j].StartedAt
		if jTime.IsZero() {
			jTime = refs[j].LastEventAt
		}
		if !iTime.Equal(jTime) {
			return iTime.After(jTime)
		}
		if refs[i].Path != refs[j].Path {
			return refs[i].Path < refs[j].Path
		}
		return refs[i].NativeID < refs[j].NativeID
	})

	out := make([]detectSessionOut, 0, len(refs))
	for _, ref := range refs {
		out = append(out, detectSessionOut{
			Agent:           ref.Provider,
			NativeSessionID: ref.NativeID,
			Path:            ref.Path,
			StartedAt:       formatRFC3339OrEmpty(ref.StartedAt),
			EndedAt:         formatRFC3339OrEmpty(ref.EndedAt),
			LastEventAt:     formatRFC3339OrEmpty(ref.LastEventAt),
			Model:           ref.Model,
		})
	}

	if asJSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
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
		last := s.LastEventAt
		if last == "" {
			last = "-"
		}
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s\t%s\t%s\n", s.Agent, s.NativeSessionID, s.Path, started, last, model)
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
	spec, err := a.Resume(ctx, adapter.SessionRef{Provider: name, NativeID: args[0]})
	if err != nil {
		if errors.Is(err, adapter.ErrUnsupported) {
			return fmt.Errorf("resume: %s does not support native resume yet (planned v0.2.x)", name)
		}
		return fmt.Errorf("resume: %w", err)
	}
	// Print the exact native invocation, shell-quoted for safe copy-paste;
	// never exec the agent from here.
	fmt.Fprintln(c.Stdout, FormatExecSpec(spec.Command, spec.Args))
	return nil
}
