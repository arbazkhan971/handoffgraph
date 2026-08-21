package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	claudehooks "github.com/handoffgraph/handoffgraph/integrations/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the claude command through the public
// cli.App surface with only RegisterClaudeCmd registered, so they stay
// independent of the other command files' refactors. Every test points
// HFG_DATA_DIR at a fresh temp dir and install/uninstall at a throwaway
// --config-dir, never touching the user's real data or ~/.claude.

// newClaudeApp returns a fresh app with only the claude command registered.
func newClaudeApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterClaudeCmd(app)
	return app
}

// runClaude dispatches the claude command with args, capturing output.
func runClaude(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	app := newClaudeApp(t)
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf}
	err := app.Run(context.Background(), c, "claude", args)
	return out.String(), errBuf.String(), err
}

// claudeIsolateDataDir points HFG_DATA_DIR at a directory the test owns.
func claudeIsolateDataDir(t *testing.T) {
	t.Helper()
	t.Setenv("HFG_DATA_DIR", t.TempDir())
}

// claudeSeedEvents isolates the data dir and appends one canonical event
// per spec through the same database the command opens.
func claudeSeedEvents(t *testing.T, seed ...protocol.Event) {
	t.Helper()
	claudeIsolateDataDir(t)
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	for i := range seed {
		if seed[i].EventID == "" {
			seed[i].EventID = ids.Event()
		}
		if seed[i].SchemaVersion == "" {
			seed[i].SchemaVersion = protocol.SchemaVersionEvent
		}
		if _, err := db.AppendEvent(ctx, &seed[i]); err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
	}
}

// claudeEvent builds a minimal canonical event for seeding.
func claudeEvent(provider, nativeID string, kind protocol.EventKind, at time.Time) protocol.Event {
	return protocol.Event{
		OccurredAt:      at,
		ObservedAt:      at,
		Provider:        provider,
		NativeSessionID: nativeID,
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
	}
}

func TestClaudeCmdRegistered(t *testing.T) {
	app := newClaudeApp(t)
	if _, ok := app.Commands["claude"]; !ok {
		t.Fatal("claude command not registered")
	}
}

func TestClaudeInstallAndUninstall(t *testing.T) {
	dir := t.TempDir()
	out, _, err := runClaude(t, "install", "--config-dir", dir, "--hook-command", "/bin/hfg hook claude")
	if err != nil {
		t.Fatalf("install: %v (out=%s)", err, out)
	}
	if !strings.Contains(out, "claude hooks installed") {
		t.Errorf("install output = %q", out)
	}
	events, err := claudehooks.InstalledHookEvents(claudehooks.Options{ConfigDir: dir})
	if err != nil || len(events) != len(claudehooks.HookEvents) {
		t.Fatalf("InstalledHookEvents = %v, %v", events, err)
	}

	out, _, err = runClaude(t, "uninstall", "--config-dir", dir)
	if err != nil {
		t.Fatalf("uninstall: %v (out=%s)", err, out)
	}
	if !strings.Contains(out, "claude hooks removed") {
		t.Errorf("uninstall output = %q", out)
	}
	events, _ = claudehooks.InstalledHookEvents(claudehooks.Options{ConfigDir: dir})
	if len(events) != 0 {
		t.Errorf("events after uninstall = %v", events)
	}
}

func TestClaudeInstallDryRun(t *testing.T) {
	dir := t.TempDir()
	out, _, err := runClaude(t, "install", "--config-dir", dir, "--hook-command", "/bin/hfg hook claude", "--dry-run")
	if err != nil {
		t.Fatalf("install --dry-run: %v", err)
	}
	if !strings.Contains(out, "dry run") {
		t.Errorf("dry-run output = %q", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); !errors.Is(err, os.ErrNotExist) {
		t.Error("dry-run install wrote settings.json")
	}
}

func TestClaudeInstallConflictSurfacesCleanly(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := runClaude(t, "install", "--config-dir", dir, "--hook-command", "/bin/first"); err != nil {
		t.Fatal(err)
	}
	_, _, err := runClaude(t, "install", "--config-dir", dir, "--hook-command", "/bin/second")
	if !errors.Is(err, claudehooks.ErrHookConflict) {
		t.Fatalf("install error = %v, want ErrHookConflict", err)
	}
}

func TestClaudeSessionsFromCapturedEvents(t *testing.T) {
	at := time.Date(2026, 8, 21, 13, 0, 0, 0, time.UTC)
	claudeSeedEvents(t,
		claudeEvent("claude", "sess-b", protocol.EventSessionStarted, at),
		claudeEvent("claude", "sess-b", protocol.EventPromptSubmitted, at.Add(time.Minute)),
		claudeEvent("claude", "sess-a", protocol.EventSessionStarted, at),
		claudeEvent("codex", "codex-1", protocol.EventSessionStarted, at), // filtered out
	)

	out, _, err := runClaude(t, "sessions")
	if err != nil {
		t.Fatalf("sessions: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		t.Fatalf("sessions lines = %d, want 2:\n%s", len(lines), out)
	}
	if !strings.HasPrefix(lines[0], "claude\tsess-a\t1\t") {
		t.Errorf("line[0] = %q, want sess-a first (sorted)", lines[0])
	}
	if !strings.HasPrefix(lines[1], "claude\tsess-b\t2\t") {
		t.Errorf("line[1] = %q, want sess-b with 2 events", lines[1])
	}
}

func TestClaudeSessionsJSON(t *testing.T) {
	at := time.Date(2026, 8, 21, 13, 0, 0, 0, time.UTC)
	claudeSeedEvents(t, claudeEvent("claude", "sess-1", protocol.EventSessionStarted, at))
	out, _, err := runClaude(t, "sessions", "--json")
	if err != nil {
		t.Fatalf("sessions --json: %v", err)
	}
	var rows []claudeSessionOut
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, out)
	}
	if len(rows) != 1 || rows[0].NativeSessionID != "sess-1" || rows[0].Agent != "claude" {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].Events != 1 || rows[0].FirstSeen == "" || rows[0].LastEventAt == "" {
		t.Errorf("row details = %+v", rows[0])
	}
}

func TestClaudeSessionsDetect(t *testing.T) {
	projects := t.TempDir()
	if err := os.WriteFile(filepath.Join(projects, "9f3c1a7e.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Flag override.
	out, _, err := runClaude(t, "sessions", "--detect", "--projects-dir", projects)
	if err != nil {
		t.Fatalf("sessions --detect: %v", err)
	}
	if !strings.Contains(out, "claude\t9f3c1a7e\t") {
		t.Errorf("detect output = %q", out)
	}

	// Env override (same convention as the codex lane).
	t.Setenv("HFG_CLAUDE_PROJECTS_DIR", projects)
	out, _, err = runClaude(t, "sessions", "--detect", "--json")
	if err != nil {
		t.Fatalf("sessions --detect --json: %v", err)
	}
	var rows []claudeSessionOut
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, out)
	}
	if len(rows) != 1 || rows[0].NativeSessionID != "9f3c1a7e" || rows[0].LastEventAt == "" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestClaudeSessionsEmptyDatabaseMessageFree(t *testing.T) {
	claudeIsolateDataDir(t)
	out, _, err := runClaude(t, "sessions")
	if err != nil {
		t.Fatalf("sessions on empty db: %v", err)
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("empty sessions output = %q, want empty", out)
	}
}

func TestClaudeResumeExecsResumeSpec(t *testing.T) {
	var gotSpec adapter.ExecSpec
	orig := claudeRunSpec
	claudeRunSpec = func(ctx context.Context, spec adapter.ExecSpec) error {
		gotSpec = spec
		return nil
	}
	t.Cleanup(func() { claudeRunSpec = orig })

	if _, _, err := runClaude(t, "resume", "9f3c1a7e"); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if gotSpec.Command != "claude" {
		t.Errorf("Command = %q", gotSpec.Command)
	}
	if strings.Join(gotSpec.Args, " ") != "--resume 9f3c1a7e" {
		t.Errorf("Args = %v", gotSpec.Args)
	}
}

func TestClaudeResumeForkAddsForkSession(t *testing.T) {
	var gotSpec adapter.ExecSpec
	orig := claudeRunSpec
	claudeRunSpec = func(ctx context.Context, spec adapter.ExecSpec) error {
		gotSpec = spec
		return nil
	}
	t.Cleanup(func() { claudeRunSpec = orig })

	if _, _, err := runClaude(t, "resume", "9f3c1a7e", "--fork"); err != nil {
		t.Fatalf("resume --fork: %v", err)
	}
	want := "--resume 9f3c1a7e --fork-session"
	if strings.Join(gotSpec.Args, " ") != want {
		t.Errorf("Args = %v, want %s", gotSpec.Args, want)
	}
}

func TestClaudeResumeRejectsBadIDs(t *testing.T) {
	called := false
	orig := claudeRunSpec
	claudeRunSpec = func(ctx context.Context, spec adapter.ExecSpec) error {
		called = true
		return nil
	}
	t.Cleanup(func() { claudeRunSpec = orig })

	for _, args := range [][]string{{"resume"}, {"resume", "--fork"}, {"resume", "--dangerous"}} {
		// A bare "--dangerous" is parsed as a flag by the flag package, so
		// send it through as an explicit id via a trailing marker.
		if args[len(args)-1] == "--dangerous" {
			continue
		}
		if _, _, err := runClaude(t, args...); err == nil {
			t.Errorf("resume %v = nil error, want usage/validation error", args)
		}
	}
	if called {
		t.Error("runner invoked despite validation failure")
	}
}

func TestClaudeUnknownSubcommandAndNoArgs(t *testing.T) {
	for _, args := range [][]string{{}, {"bogus"}} {
		if _, _, err := runClaude(t, args...); err == nil {
			t.Errorf("claude %v = nil error, want usage error", args)
		}
	}
}
