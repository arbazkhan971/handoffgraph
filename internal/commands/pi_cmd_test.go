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
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
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

func TestPiSubcommandHelpIsScopedAndSuccessful(t *testing.T) {
	out, stderr, err := runPiApp(t, newPiApp(t), "pi", "sessions", "--help")
	if err != nil {
		t.Fatalf("help returned error: %v", err)
	}
	if stderr != "" {
		t.Fatalf("help stderr=%q", stderr)
	}
	if !strings.Contains(out, "-sessions-dir") || strings.Contains(out, "-agent-dir") || strings.Contains(out, "-dry-run") {
		t.Fatalf("unscoped sessions help: %q", out)
	}
}

func TestPiNormalizeHelpIsScopedAndSuccessful(t *testing.T) {
	out, stderr, err := runPiApp(t, newPiApp(t), "pi", "normalize", "--help")
	if err != nil {
		t.Fatalf("help returned error: %v", err)
	}
	if stderr != "" {
		t.Fatalf("help stderr=%q", stderr)
	}
	for _, flag := range []string{"-workstream", "-session", "-import", "-json"} {
		if !strings.Contains(out, flag) {
			t.Errorf("normalize help missing %s: %q", flag, out)
		}
	}
	for _, unrelated := range []string{"-agent-dir", "-sessions-dir", "-dry-run"} {
		if strings.Contains(out, unrelated) {
			t.Errorf("normalize help contains unrelated %s: %q", unrelated, out)
		}
	}
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

func piNormalizeFixturePath(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "fixtures", "pi_native_all.jsonl")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("Pi native fixture: %v", err)
	}
	return path
}

func TestPiCmdNormalizeJSONLAndJSON(t *testing.T) {
	app := newPiApp(t)
	path := piNormalizeFixturePath(t)

	jsonl, stderr, err := runPiApp(t, app, "pi", "normalize", path)
	if err != nil {
		t.Fatalf("pi normalize: %v stderr=%s", err, stderr)
	}
	events := decodeNormalizedJSONL(t, jsonl)
	if len(events) != 17 {
		t.Fatalf("normalized events = %d, want 17", len(events))
	}
	if events[0].Kind != protocol.EventSessionStarted || events[6].Kind != protocol.EventToolStarted {
		t.Fatalf("unexpected event mapping: first=%s seventh=%s", events[0].Kind, events[6].Kind)
	}

	indented, _, err := runPiApp(t, app, "pi", "normalize", path, "--json")
	if err != nil {
		t.Fatalf("pi normalize --json: %v", err)
	}
	var array []protocol.Event
	if err := json.Unmarshal([]byte(indented), &array); err != nil {
		t.Fatalf("normalize JSON array: %v\n%s", err, indented)
	}
	if len(array) != len(events) {
		t.Fatalf("JSON events = %d, JSONL events = %d", len(array), len(events))
	}
	for i := range array {
		if array[i].EventID != events[i].EventID || array[i].Sequence != events[i].Sequence {
			t.Errorf("event %d differs between JSON and JSONL", i+1)
		}
	}

	// Interspersed flags work before the subcommand, before the file, and
	// after the file without treating flag values as positional paths.
	workstream := ids.Workstream()
	associated, _, err := runPiApp(t, app, "pi", "normalize", "--workstream", workstream, path)
	if err != nil {
		t.Fatal(err)
	}
	afterFile, _, err := runPiApp(t, app, "pi", "normalize", path, "--workstream", workstream)
	if err != nil {
		t.Fatal(err)
	}
	outer, _, err := runPiApp(t, app, "pi", "--workstream", workstream, "normalize", path)
	if err != nil {
		t.Fatal(err)
	}
	if associated != afterFile || associated != outer {
		t.Fatal("normalize output changed across supported flag positions")
	}
	assertNativeAssociation(t, decodeNormalizedJSONL(t, associated), protocol.ProviderPi, workstream)
}

func TestPiCmdNormalizeFlagValidation(t *testing.T) {
	path := piNormalizeFixturePath(t)
	app := newPiApp(t)
	tests := []struct {
		name     string
		args     []string
		wantPart string
	}{
		{name: "missing file", args: []string{"normalize"}, wantPart: "usage"},
		{name: "extra file", args: []string{"normalize", path, path}, wantPart: "usage"},
		{name: "invalid workstream", args: []string{"normalize", path, "--workstream", "ws_invalid"}, wantPart: "valid ws_"},
		{name: "invalid session", args: []string{"normalize", path, "--session", "ses_invalid"}, wantPart: "valid ses_"},
		{name: "import needs workstream", args: []string{"normalize", path, "--import"}, wantPart: "requires --workstream"},
		{name: "json import conflict", args: []string{"normalize", path, "--workstream", ids.Workstream(), "--import", "--json"}, wantPart: "mutually exclusive"},
		{name: "normalize flag after sessions", args: []string{"sessions", "--sessions-dir", t.TempDir(), "--workstream", ids.Workstream()}, wantPart: "flag provided but not defined"},
		{name: "normalize flag before sessions", args: []string{"--session", ids.Session(), "sessions", "--sessions-dir", t.TempDir()}, wantPart: "only valid with normalize"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := runPiApp(t, app, "pi", test.args...)
			if err == nil || !strings.Contains(err.Error(), test.wantPart) {
				t.Fatalf("error = %v, want %q", err, test.wantPart)
			}
		})
	}
}

func TestPiNormalizeImportTwiceAndCheckpointSource(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	workstreamOut, _, err := runRegisteredApp(app, "workstream", "new", "pi-native-acceptance")
	if err != nil {
		t.Fatalf("create workstream: %v", err)
	}
	workstream := strings.TrimSpace(workstreamOut)
	path := piNormalizeFixturePath(t)

	out, _, err := runRegisteredApp(app, "pi", "normalize", path, "--workstream", workstream, "--import")
	if err != nil {
		t.Fatalf("first Pi import: %v", err)
	}
	if !strings.Contains(out, "imported 17 new event(s), 0 already present") {
		t.Fatalf("first import output = %q", out)
	}
	out, _, err = runRegisteredApp(app, "pi", "normalize", path, "--workstream", workstream, "--import")
	if err != nil {
		t.Fatalf("second Pi import: %v", err)
	}
	if !strings.Contains(out, "imported 0 new event(s), 17 already present") {
		t.Fatalf("second import output = %q", out)
	}

	checkpointJSON, _, err := runRegisteredApp(app, "checkpoint", "--workstream", workstream, "--objective", "Pi native checkpoint")
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	var checkpoint protocol.Checkpoint
	if err := json.Unmarshal([]byte(checkpointJSON), &checkpoint); err != nil {
		t.Fatalf("checkpoint JSON: %v\n%s", err, checkpointJSON)
	}
	if len(checkpoint.SourceSessions) != 1 {
		t.Fatalf("checkpoint source sessions = %+v", checkpoint.SourceSessions)
	}
	source := checkpoint.SourceSessions[0]
	if source.Provider != protocol.ProviderPi || source.NativeSessionID != "pi-native-golden" || source.SessionID == "" {
		t.Fatalf("Pi checkpoint source = %+v", source)
	}
}

func writePiNativeFragment(t *testing.T, nativeID, timestamp, marker string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), marker+".jsonl")
	data := strings.Join([]string{
		`{"type":"session","id":"` + nativeID + `","timestamp":"` + timestamp + `","marker":"` + marker + `"}`,
		`{"type":"custom","id":"` + marker + `","timestamp":"` + timestamp + `","marker":"` + marker + `"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPiNormalizeAllowsSharedProviderNativeAcrossDistinctCanonicalSessions(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	workstreamOut, _, err := runRegisteredApp(app, "workstream", "new", "pi-shared-native")
	if err != nil {
		t.Fatal(err)
	}
	workstream := strings.TrimSpace(workstreamOut)
	nativeID := "pi-native-shared"
	firstPath := writePiNativeFragment(t, nativeID, "2026-08-30T11:00:00Z", "first")
	secondPath := writePiNativeFragment(t, nativeID, "2026-08-30T11:00:01Z", "second")
	firstSession := ids.Session()
	secondSession := ids.Session()

	if _, _, err := runRegisteredApp(app, "pi", "normalize", firstPath, "--workstream", workstream, "--session", firstSession, "--import"); err != nil {
		t.Fatalf("first shared-native import: %v", err)
	}
	if _, _, err := runRegisteredApp(app, "pi", "normalize", secondPath, "--workstream", workstream, "--session", secondSession, "--import"); err != nil {
		t.Fatalf("second shared-native import: %v", err)
	}

	checkpointJSON, _, err := runRegisteredApp(app, "checkpoint", "--workstream", workstream, "--objective", "shared native regression")
	if err != nil {
		t.Fatal(err)
	}
	var checkpoint protocol.Checkpoint
	if err := json.Unmarshal([]byte(checkpointJSON), &checkpoint); err != nil {
		t.Fatal(err)
	}
	if len(checkpoint.SourceSessions) != 2 {
		t.Fatalf("source sessions = %+v, want two canonical sessions", checkpoint.SourceSessions)
	}
	seen := map[string]bool{}
	for _, source := range checkpoint.SourceSessions {
		if source.Provider != protocol.ProviderPi || source.NativeSessionID != nativeID {
			t.Errorf("source = %+v", source)
		}
		seen[source.SessionID] = true
	}
	if !seen[firstSession] || !seen[secondSession] {
		t.Fatalf("canonical sessions = %+v", seen)
	}
}
