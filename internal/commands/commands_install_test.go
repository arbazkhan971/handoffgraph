package commands

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the install and resume commands through
// the public cli.App surface, mirroring how cmd/handoffgraph/main.go wires
// the app. Every test points HFG_DATA_DIR at a fresh temp dir, and install
// at a throwaway --config-dir, so the user's real data directory and agent
// configuration are never touched.

// newRegisteredApp returns a fresh app with all commands registered.
func newRegisteredApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	Register(app)
	return app
}

// runRegisteredApp dispatches name with args, capturing stdout and stderr.
func runRegisteredApp(app *cli.App, name string, args ...string) (string, string, error) {
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf}
	err := app.Run(context.Background(), c, name, args)
	return out.String(), errBuf.String(), err
}

// isolateDataDir points HFG_DATA_DIR at a directory the test owns.
func isolateDataDir(t *testing.T) {
	t.Helper()
	t.Setenv("HFG_DATA_DIR", t.TempDir())
}

// seedEvents isolates the data dir, opens the same database the commands
// open (config.Load(".") + storage.Open(cfg.DBPath)), lets seed append
// events, then closes the handle before the command under test runs.
func seedEvents(t *testing.T, seed func(db *storage.DB)) {
	t.Helper()
	isolateDataDir(t)
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("cfg.Validate: %v", err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	seed(db)
}

// appendSessionEvent appends one canonical event with the given provider,
// native session id, kind and occurrence time.
func appendSessionEvent(t *testing.T, db *storage.DB, provider, nativeSessionID string, kind protocol.EventKind, at time.Time) {
	t.Helper()
	ev := &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         ids.Event(),
		OccurredAt:      at,
		ObservedAt:      at,
		Provider:        provider,
		NativeSessionID: nativeSessionID,
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
	}
	if _, err := db.AppendEvent(context.Background(), ev); err != nil {
		t.Fatalf("AppendEvent(%s/%s @ %s): %v", provider, nativeSessionID, at, err)
	}
}

func TestInstallFreshDir(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	cfgDir := t.TempDir()

	out, _, err := runRegisteredApp(app, "install", "--config-dir", cfgDir, "--hook-command", "/bin/true")
	if err != nil {
		t.Fatalf("install on fresh dir: %v", err)
	}
	want := "install: agent codex ok (config: " + cfgDir + ")\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
	if _, err := os.Stat(filepath.Join(cfgDir, "config.toml")); err != nil {
		t.Errorf("config.toml not written to config dir: %v", err)
	}
}

func TestInstallDryRunNoWrite(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	cfgDir := t.TempDir()

	out, _, err := runRegisteredApp(app, "install", "--dry-run", "--config-dir", cfgDir, "--hook-command", "/bin/true")
	if err != nil {
		t.Fatalf("install --dry-run: %v", err)
	}
	want := "install: agent codex ok (dry run — no changes written)\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
	if _, err := os.Stat(filepath.Join(cfgDir, "config.toml")); !os.IsNotExist(err) {
		t.Errorf("config.toml must not exist after --dry-run (stat err = %v)", err)
	}
}

func TestInstallIdempotent(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	cfgDir := t.TempDir()
	args := []string{"--config-dir", cfgDir, "--hook-command", "/bin/true"}

	want := "install: agent codex ok (config: " + cfgDir + ")\n"
	for i := 0; i < 2; i++ {
		out, _, err := runRegisteredApp(app, "install", args...)
		if err != nil {
			t.Fatalf("install run %d: %v", i+1, err)
		}
		if out != want {
			t.Errorf("install run %d stdout = %q, want %q", i+1, out, want)
		}
	}
	if _, err := os.Stat(filepath.Join(cfgDir, "config.toml")); err != nil {
		t.Errorf("config.toml not written to config dir: %v", err)
	}
}

func TestInstallConflict(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	cfgDir := t.TempDir()
	conflict := "[hooks.handoffgraph]\ncommand = \"/different\"\nevents = [\"session.started\"]\n"
	if err := os.WriteFile(filepath.Join(cfgDir, "config.toml"), []byte(conflict), 0o600); err != nil {
		t.Fatal(err)
	}

	_, _, err := runRegisteredApp(app, "install", "--config-dir", cfgDir, "--hook-command", "/bin/true")
	if err == nil {
		t.Fatal("install over a different existing hook: want error, got nil")
	}
	if !errors.Is(err, adapter.ErrHookConflict) {
		t.Fatalf("err = %v, want it to wrap adapter.ErrHookConflict", err)
	}
	if !strings.HasPrefix(err.Error(), "install: ") {
		t.Errorf("err = %v, want it to be prefixed %q", err, "install: ")
	}
}

func TestInstallUnknownAgent(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	_, _, err := runRegisteredApp(app, "install", "--agent", "nope", "--config-dir", t.TempDir(), "--hook-command", "/bin/true")
	if err == nil {
		t.Fatal("install --agent nope: want error, got nil")
	}
	if !strings.Contains(err.Error(), "codex") {
		t.Errorf("err = %v, want it to mention the available adapters (expect %q)", err, "codex")
	}
}

func TestInstallDefaultHookCommand(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	cfgDir := t.TempDir()

	// --hook-command is omitted: the command must default it to the running
	// executable. Only the success line is asserted, never the exe path.
	out, _, err := runRegisteredApp(app, "install", "--config-dir", cfgDir)
	if err != nil {
		t.Fatalf("install with default hook command: %v", err)
	}
	want := "install: agent codex ok (config: " + cfgDir + ")\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
}

func TestResumeUnsupported(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_resume", protocol.EventSessionStarted,
			time.Date(2026, 1, 15, 9, 0, 0, 0, time.UTC))
	})
	app := newRegisteredApp(t)

	_, _, err := runRegisteredApp(app, "resume", "sess_resume")
	if err == nil {
		t.Fatal("resume: want error (codex does not support native resume yet), got nil")
	}
	if !strings.Contains(err.Error(), "does not support native resume yet") {
		t.Errorf("err = %v, want it to contain %q", err, "does not support native resume yet")
	}
	if !strings.Contains(err.Error(), "codex") {
		t.Errorf("err = %v, want it to mention the agent name %q", err, "codex")
	}
}

func TestResumeMissingArg(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	_, _, err := runRegisteredApp(app, "resume")
	if err == nil {
		t.Fatal("resume without a native session id: want usage error, got nil")
	}
	if !strings.Contains(err.Error(), "usage") {
		t.Errorf("err = %v, want a usage error", err)
	}
}
