package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// The tests in this file exercise `handoffgraph codex ...` through the
// public cli.App surface with only RegisterCodexCmd applied, so they stay
// independent of the other adapter commands. Every test points the codex
// config/sessions dirs at throwaway directories (and HOME at a scratch
// dir); the real ~/.codex is never touched.

func newCodexApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterCodexCmd(app)
	return app
}

func runCodexApp(t *testing.T, app *cli.App, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf}
	err := app.Run(context.Background(), c, "codex", args)
	return out.String(), errBuf.String(), err
}

func TestCodexSubcommandHelpIsScopedAndSuccessful(t *testing.T) {
	out, stderr, err := runCodexApp(t, newCodexApp(t), "app-server-sessions", "--help")
	if err != nil {
		t.Fatalf("help returned error: %v", err)
	}
	if stderr != "" {
		t.Fatalf("help stderr=%q", stderr)
	}
	if !strings.Contains(out, "-page-size") || strings.Contains(out, "-workstream") || strings.Contains(out, "-hook-command") {
		t.Fatalf("unscoped app-server help: %q", out)
	}
}

// writeCodexRollout writes one rollout file whose head line carries the
// given id/timestamp/model.
func writeCodexRollout(t *testing.T, dir, rel, id, ts, model string) string {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"` + ts + `","type":"session_meta","payload":{"id":"` + id + `","timestamp":"` + ts + `","model":"` + model + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// codexTestFixturePath resolves a fixture under the repo-root
// testdata/fixtures relative to this file.
func codexTestFixturePath(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate testdata/fixtures")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "testdata", "fixtures", name)
}

func TestCodexCmdRequiresSubcommand(t *testing.T) {
	app := newCodexApp(t)
	if _, _, err := runCodexApp(t, app); err == nil {
		t.Fatal("codex with no subcommand succeeded, want usage error")
	}
	_, _, err := runCodexApp(t, app, "bogus")
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("codex bogus error = %v, want unknown-subcommand error", err)
	}
}

func TestCodexCmdInstallUninstallLifecycle(t *testing.T) {
	cfgDir := t.TempDir()
	app := newCodexApp(t)

	out, _, err := runCodexApp(t, app, "install", "--config-dir", cfgDir, "--hook-command", "/bin/true")
	if err != nil {
		t.Fatalf("codex install: %v", err)
	}
	if !strings.Contains(out, "codex hooks installed for events:") {
		t.Errorf("install output = %q", out)
	}
	if !strings.Contains(out, "SessionStart") || !strings.Contains(out, "Stop") {
		t.Errorf("install output lacks managed events: %q", out)
	}
	data, err := os.ReadFile(filepath.Join(cfgDir, "config.toml"))
	if err != nil {
		t.Fatalf("config.toml missing: %v", err)
	}
	if !strings.Contains(string(data), "# hfg:managed") {
		t.Errorf("config lacks managed marker: %s", data)
	}

	// Idempotent second install (flags in both positions).
	out2, _, err := runCodexApp(t, app, "--config-dir", cfgDir, "install", "--hook-command", "/bin/true")
	if err != nil {
		t.Fatalf("second codex install: %v", err)
	}
	if out2 != out {
		t.Errorf("second install output = %q, want %q", out2, out)
	}

	out, _, err = runCodexApp(t, app, "uninstall", "--config-dir", cfgDir)
	if err != nil {
		t.Fatalf("codex uninstall: %v", err)
	}
	if !strings.Contains(out, "codex hooks removed") {
		t.Errorf("uninstall output = %q", out)
	}
	data, _ = os.ReadFile(filepath.Join(cfgDir, "config.toml"))
	if strings.Contains(string(data), "# hfg:managed") {
		t.Errorf("managed marker survived uninstall: %s", data)
	}
}

func TestCodexCmdInstallDryRun(t *testing.T) {
	cfgDir := t.TempDir()
	app := newCodexApp(t)
	out, _, err := runCodexApp(t, app, "install", "--config-dir", cfgDir, "--hook-command", "/bin/true", "--dry-run")
	if err != nil {
		t.Fatalf("codex install --dry-run: %v", err)
	}
	if !strings.Contains(out, "dry run") {
		t.Errorf("dry-run output = %q", out)
	}
	if _, err := os.Stat(filepath.Join(cfgDir, "config.toml")); !os.IsNotExist(err) {
		t.Error("dry run wrote config.toml")
	}
}

func TestCodexCmdDefaultInstallUsesPublicHookHandler(t *testing.T) {
	cfgDir := t.TempDir()
	if _, _, err := runCodexApp(t, newCodexApp(t), "install", "--config-dir", cfgDir); err != nil {
		t.Fatalf("codex default install: %v", err)
	}
	var decoded map[string]any
	if _, err := toml.DecodeFile(filepath.Join(cfgDir, "config.toml"), &decoded); err != nil {
		t.Fatalf("decode installed Codex config: %v", err)
	}
	commands := collectStringFields(decoded, "command")
	if len(commands) == 0 {
		t.Fatalf("installed Codex config has no hook commands: %#v", decoded)
	}
	for _, command := range commands {
		if !strings.HasSuffix(command, " hook codex") {
			t.Errorf("installed Codex command %q does not end in public handler", command)
		}
	}
}

func TestCodexCmdInstallConflictFailsClosed(t *testing.T) {
	cfgDir := t.TempDir()
	legacy := "[hooks.handoffgraph]\ncommand = \"/different\"\n"
	if err := os.WriteFile(filepath.Join(cfgDir, "config.toml"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newCodexApp(t)
	_, _, err := runCodexApp(t, app, "install", "--config-dir", cfgDir, "--hook-command", "/bin/true")
	if err == nil {
		t.Fatal("install over a legacy handoffgraph hook succeeded, want fail-closed error")
	}
	data, _ := os.ReadFile(filepath.Join(cfgDir, "config.toml"))
	if string(data) != legacy {
		t.Errorf("config modified despite conflict: %s", data)
	}
}

func TestCodexCmdSessions(t *testing.T) {
	sessionsDir := t.TempDir()
	pathA := writeCodexRollout(t, sessionsDir, "rollout-a.jsonl", "sess_a", "2026-08-20T09:00:00Z", "m1")
	nested := writeCodexRollout(t, sessionsDir, filepath.Join("2026", "08", "21", "rollout-b.jsonl"), "sess_b", "2026-08-21T11:30:00Z", "m2")
	app := newCodexApp(t)

	out, _, err := runCodexApp(t, app, "sessions", "--sessions-dir", sessionsDir)
	if err != nil {
		t.Fatalf("codex sessions: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		t.Fatalf("sessions output = %q, want 2 lines", out)
	}
	if !strings.Contains(lines[0], "sess_b") || !strings.Contains(lines[0], nested) || !strings.Contains(lines[0], "m2") {
		t.Errorf("newest session not first: %q", lines[0])
	}
	if !strings.Contains(lines[1], "sess_a") || !strings.Contains(lines[1], pathA) {
		t.Errorf("older session not second: %q", lines[1])
	}

	jsonOut, _, err := runCodexApp(t, app, "sessions", "--sessions-dir", sessionsDir, "--json")
	if err != nil {
		t.Fatalf("codex sessions --json: %v", err)
	}
	var rows []codexSessionOut
	if err := json.Unmarshal([]byte(jsonOut), &rows); err != nil {
		t.Fatalf("sessions JSON invalid: %v\n%s", err, jsonOut)
	}
	if len(rows) != 2 || rows[0].NativeSessionID != "sess_b" || rows[1].NativeSessionID != "sess_a" {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].StartedAt != "2026-08-21T11:30:00Z" {
		t.Errorf("rows[0].started_at = %s", rows[0].StartedAt)
	}
}

func TestCodexCmdSessionsEnvOverride(t *testing.T) {
	sessionsDir := t.TempDir()
	writeCodexRollout(t, sessionsDir, "rollout-a.jsonl", "env_sess", "2026-08-20T09:00:00Z", "m1")
	t.Setenv("HFG_CODEX_SESSIONS_DIR", sessionsDir)
	app := newCodexApp(t)

	out, _, err := runCodexApp(t, app, "sessions")
	if err != nil {
		t.Fatalf("codex sessions (env override): %v", err)
	}
	if !strings.Contains(out, "env_sess") {
		t.Errorf("sessions output = %q, want the env-override session", out)
	}
}

func TestCodexCmdSessionsEmpty(t *testing.T) {
	app := newCodexApp(t)
	out, _, err := runCodexApp(t, app, "sessions", "--sessions-dir", t.TempDir())
	if err != nil {
		t.Fatalf("codex sessions on empty dir: %v", err)
	}
	if !strings.Contains(out, "no codex sessions found") {
		t.Errorf("empty sessions output = %q", out)
	}
}

func TestCodexCmdAppServerSessionsIsSeparateAndValidatesUsage(t *testing.T) {
	app := newCodexApp(t)
	if _, _, err := runCodexApp(t, app, "app-server-sessions", "unexpected-positional"); err == nil || !strings.Contains(err.Error(), "usage: codex app-server-sessions") {
		t.Fatalf("positional app-server-sessions error = %v", err)
	}

	missing := filepath.Join(t.TempDir(), "missing-codex")
	_, _, err := runCodexApp(t, app, "--codex-binary", missing, "app-server-sessions", "--page-size", "1", "--max-pages", "1")
	if err == nil || !strings.Contains(err.Error(), "app-server-sessions") || !strings.Contains(err.Error(), "start") {
		t.Fatalf("missing app-server binary error = %v", err)
	}

	// The existing file-backed command remains independently reachable.
	out, _, err := runCodexApp(t, app, "sessions", "--sessions-dir", t.TempDir())
	if err != nil || !strings.Contains(out, "no codex sessions found") {
		t.Fatalf("file sessions after App Server dispatch: out=%q err=%v", out, err)
	}
}

func TestWriteCodexAppServerSessionsJSONAndText(t *testing.T) {
	ref := adapter.SessionRef{
		Provider:    protocol.ProviderCodex,
		NativeID:    "018f0f70-7b5c-7000-8000-000000000001",
		StartedAt:   time.Unix(100, 0).UTC(),
		LastEventAt: time.Unix(200, 0).UTC(),
		Metadata: &adapter.SessionMetadata{
			NativeGroupID: "018f0f70-7b5c-7000-8000-000000000000",
			Title:         "Read-only listing",
			Preview:       "Inspect sessions",
			WorkingDir:    "/repo/with\nnewline",
			ModelProvider: "openai",
			CLIVersion:    "0.144.3",
			NativeSource:  json.RawMessage(`"cli"`),
		},
	}

	var jsonOut bytes.Buffer
	ctx := &cli.Context{Stdout: &jsonOut, Stderr: &bytes.Buffer{}}
	if err := writeCodexAppServerSessions(ctx, []adapter.SessionRef{ref}, true); err != nil {
		t.Fatalf("write JSON: %v", err)
	}
	var rows []codexAppServerSessionOut
	if err := json.Unmarshal(jsonOut.Bytes(), &rows); err != nil {
		t.Fatalf("JSON output: %v\n%s", err, jsonOut.String())
	}
	if len(rows) != 1 || rows[0].Transport != codex.AppServerTransport || rows[0].NativeSessionID != ref.NativeID || rows[0].CodexCLIVersion != "0.144.3" {
		t.Fatalf("rows = %+v", rows)
	}

	var textOut bytes.Buffer
	ctx.Stdout = &textOut
	if err := writeCodexAppServerSessions(ctx, []adapter.SessionRef{ref}, false); err != nil {
		t.Fatalf("write text: %v", err)
	}
	if strings.Count(strings.TrimSpace(textOut.String()), "\n") != 0 || !strings.Contains(textOut.String(), `/repo/with\nnewline`) {
		t.Fatalf("text output was not single-line escaped: %q", textOut.String())
	}

	var empty bytes.Buffer
	ctx.Stdout = &empty
	if err := writeCodexAppServerSessions(ctx, nil, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(empty.String(), "file-based `codex sessions` is unchanged") {
		t.Fatalf("empty output = %q", empty.String())
	}

	ref.Metadata = nil
	if err := writeCodexAppServerSessions(ctx, []adapter.SessionRef{ref}, true); err == nil {
		t.Fatal("missing mapped metadata succeeded")
	}
}

func TestCodexCmdNormalizeJSONL(t *testing.T) {
	path := codexTestFixturePath(t, "codex_session.jsonl")
	app := newCodexApp(t)

	out, _, err := runCodexApp(t, app, "normalize", path)
	if err != nil {
		t.Fatalf("codex normalize: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 6 {
		t.Fatalf("normalize lines = %d, want 6:\n%s", len(lines), out)
	}
	var events []protocol.Event
	for i, line := range lines {
		var ev protocol.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("line %d is not a canonical event: %v\n%s", i+1, err, line)
		}
		if ev.Provider != protocol.ProviderCodex {
			t.Errorf("line %d provider = %s, want codex", i+1, ev.Provider)
		}
		events = append(events, ev)
	}
	if events[0].Kind != protocol.EventSessionStarted {
		t.Errorf("first event kind = %s, want session.started", events[0].Kind)
	}

	// Deterministic output: a second run prints identical bytes.
	out2, _, err := runCodexApp(t, app, "normalize", path)
	if err != nil {
		t.Fatalf("second codex normalize: %v", err)
	}
	if out2 != out {
		t.Error("normalize output differs between runs, want identical bytes")
	}
}

func TestCodexCmdNormalizeJSONArray(t *testing.T) {
	path := codexTestFixturePath(t, "codex-subagent.jsonl")
	app := newCodexApp(t)

	out, _, err := runCodexApp(t, app, "normalize", path, "--json")
	if err != nil {
		t.Fatalf("codex normalize --json: %v", err)
	}
	var events []protocol.Event
	if err := json.Unmarshal([]byte(out), &events); err != nil {
		t.Fatalf("output is not a JSON array: %v\n%s", err, out)
	}
	if len(events) != 9 {
		t.Fatalf("events = %d, want 9", len(events))
	}
	// The subagent model switch must be visible in the array output.
	if events[3].Model != "gpt-5-codex" || events[4].Model != "gpt-5-mini" {
		t.Errorf("model switch lost: %s → %s", events[3].Model, events[4].Model)
	}
}

func TestCodexCmdNormalizeErrors(t *testing.T) {
	app := newCodexApp(t)
	if _, _, err := runCodexApp(t, app, "normalize"); err == nil {
		t.Error("normalize without a file succeeded, want usage error")
	}
	if _, _, err := runCodexApp(t, app, "normalize", filepath.Join(t.TempDir(), "missing.jsonl")); err == nil {
		t.Error("normalize of a missing file succeeded, want error")
	}
	bad := filepath.Join(t.TempDir(), "bad.jsonl")
	if err := os.WriteFile(bad, []byte("{\"type\":\"event_msg\",\"payload\":{}}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := runCodexApp(t, app, "normalize", bad)
	if err == nil || !strings.Contains(err.Error(), "session_meta") {
		t.Errorf("normalize of a non-rollout file error = %v, want session_meta complaint", err)
	}
	malformed := filepath.Join(t.TempDir(), "malformed.jsonl")
	if err := os.WriteFile(malformed, []byte("{\"timestamp\":\"2026-08-22T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"x\",\"timestamp\":\"2026-08-22T12:00:00Z\"}}\nnot json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err = runCodexApp(t, app, "normalize", malformed)
	if err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Errorf("normalize of a malformed stream error = %v, want a line-numbered failure", err)
	}
}
