package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/cli"
)

// The tests in this file exercise `handoffgraph pi ...` through the public
// cli.App surface with only RegisterPiCmd applied, so they stay independent
// of the other adapter commands. Every test points the Pi agent/sessions
// dirs at a throwaway temp directory; the real ~/.pi is never touched.

// newPiApp returns a fresh app with the Pi command registered.
func newPiApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterPiCmd(app)
	return app
}

// runPiApp dispatches name with args, capturing stdout and stderr. HOME is
// pointed at a throwaway directory so a regression in flag handling can
// never touch the real ~/.pi.
func runPiApp(t *testing.T, app *cli.App, name string, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf}
	err := app.Run(context.Background(), c, name, args)
	return out.String(), errBuf.String(), err
}

// writePiSession writes one native Pi transcript for sessions detection.
func writePiSession(t *testing.T, sessionsDir, rel, id, ts string) {
	t.Helper()
	path := filepath.Join(sessionsDir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"session","version":3,"id":"` + id + `","timestamp":"` + ts + `","cwd":"/repo"}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPiCmdRequiresSubcommand(t *testing.T) {
	app := newPiApp(t)
	_, _, err := runPiApp(t, app, "pi")
	if err == nil {
		t.Fatal("pi with no subcommand succeeded, want usage error")
	}
	_, _, err = runPiApp(t, app, "pi", "bogus")
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("pi bogus error = %v, want unknown-subcommand error", err)
	}
}

func TestPiCmdInstallUninstall(t *testing.T) {
	agentDir := t.TempDir()
	app := newPiApp(t)

	// Flags are accepted both before and after the subcommand.
	out, _, err := runPiApp(t, app, "pi", "--agent-dir", agentDir, "install")
	if err != nil {
		t.Fatalf("pi install (flags first): %v", err)
	}
	if !strings.Contains(out, "extension installed") {
		t.Errorf("install output = %q, want install confirmation", out)
	}

	out, _, err = runPiApp(t, app, "pi", "install", "--agent-dir", agentDir)
	if err != nil {
		t.Fatalf("pi install (flags last): %v", err)
	}
	if !strings.Contains(out, "extension installed") {
		t.Errorf("install output = %q, want install confirmation", out)
	}
	extPath := filepath.Join(agentDir, "extensions", "handoffgraph", "handoffgraph-extension.ts")
	if _, err := os.Stat(extPath); err != nil {
		t.Fatalf("extension not installed: %v", err)
	}
	settings, err := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if err != nil {
		t.Fatalf("settings.json missing: %v", err)
	}
	if !strings.Contains(string(settings), `"handoffgraph"`) {
		t.Errorf("settings.json missing managed key: %s", settings)
	}

	// Idempotent second install.
	if _, _, err := runPiApp(t, app, "pi", "install", "--agent-dir", agentDir); err != nil {
		t.Fatalf("second pi install: %v", err)
	}

	out, _, err = runPiApp(t, app, "pi", "uninstall", "--agent-dir", agentDir)
	if err != nil {
		t.Fatalf("pi uninstall: %v", err)
	}
	if !strings.Contains(out, "extension uninstalled") {
		t.Errorf("uninstall output = %q, want uninstall confirmation", out)
	}
	if _, err := os.Stat(filepath.Join(agentDir, "extensions", "handoffgraph")); !os.IsNotExist(err) {
		t.Error("extension directory survived uninstall")
	}
	settings, _ = os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if strings.Contains(string(settings), `"handoffgraph"`) {
		t.Errorf("managed key survived uninstall: %s", settings)
	}
}

func TestPiCmdInstallDryRun(t *testing.T) {
	agentDir := t.TempDir()
	app := newPiApp(t)
	out, _, err := runPiApp(t, app, "pi", "install", "--agent-dir", agentDir, "--dry-run")
	if err != nil {
		t.Fatalf("pi install --dry-run: %v", err)
	}
	if !strings.Contains(out, "dry run") {
		t.Errorf("dry-run output = %q, want dry-run note", out)
	}
	if _, err := os.Stat(filepath.Join(agentDir, "settings.json")); !os.IsNotExist(err) {
		t.Error("dry run wrote settings.json")
	}
	if _, err := os.Stat(filepath.Join(agentDir, "extensions")); !os.IsNotExist(err) {
		t.Error("dry run wrote the extensions directory")
	}
}

func TestPiCmdInstallConflictFailsClosed(t *testing.T) {
	agentDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(`{"handoffgraph":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newPiApp(t)
	_, _, err := runPiApp(t, app, "pi", "install", "--agent-dir", agentDir)
	if err == nil {
		t.Fatal("install over a user-owned settings key succeeded, want fail-closed error")
	}
	data, _ := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if string(data) != `{"handoffgraph":"user"}` {
		t.Errorf("settings modified despite conflict: %s", data)
	}
}

func TestPiCmdSessions(t *testing.T) {
	sessionsDir := t.TempDir()
	writePiSession(t, sessionsDir,
		filepath.Join("--Users-x-repo--", "2026-08-20T11-59-43-125Z_01a01f0a-9815-726e-96d9-8d16cb2ce479.jsonl"),
		"01a01f0a-9815-726e-96d9-8d16cb2ce479", "2026-08-20T11:59:43.125Z")
	writePiSession(t, sessionsDir,
		filepath.Join("--Users-x-repo--", "2026-08-21T19-07-42-151Z_01a02092-6cc7-7a51-844a-8919597a8ec6", "run-0", "session.jsonl"),
		"01a025bd-c76a-7ce4-8558-2f6b2d2cb865", "2026-08-21T19:13:09.482Z")

	app := newPiApp(t)

	out, _, err := runPiApp(t, app, "pi", "sessions", "--sessions-dir", sessionsDir)
	if err != nil {
		t.Fatalf("pi sessions: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		t.Fatalf("sessions output = %q, want 2 lines", out)
	}
	if !strings.Contains(lines[0], "01a025bd-c76a-7ce4-8558-2f6b2d2cb865") {
		t.Errorf("newest session not first: %q", lines[0])
	}
	if !strings.Contains(lines[1], "01a01f0a-9815-726e-96d9-8d16cb2ce479") {
		t.Errorf("older session not second: %q", lines[1])
	}

	jsonOut, _, err := runPiApp(t, app, "pi", "sessions", "--sessions-dir", sessionsDir, "--json")
	if err != nil {
		t.Fatalf("pi sessions --json: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(jsonOut), &rows); err != nil {
		t.Fatalf("sessions JSON invalid: %v\n%s", err, jsonOut)
	}
	if len(rows) != 2 {
		t.Fatalf("sessions JSON rows = %d, want 2", len(rows))
	}
	if rows[0]["native_session_id"] != "01a025bd-c76a-7ce4-8558-2f6b2d2cb865" || rows[0]["provider"] != "pi" {
		t.Errorf("first JSON row = %v", rows[0])
	}
}

func TestPiCmdSessionsEmptyDir(t *testing.T) {
	app := newPiApp(t)
	out, _, err := runPiApp(t, app, "pi", "sessions", "--sessions-dir", t.TempDir())
	if err != nil {
		t.Fatalf("pi sessions on empty dir: %v", err)
	}
	if !strings.Contains(out, "no pi sessions found") {
		t.Errorf("empty sessions output = %q", out)
	}
}
