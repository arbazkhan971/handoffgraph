package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	claudehooks "github.com/handoffgraph/handoffgraph/integrations/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestNameAndRegistry(t *testing.T) {
	c := New()
	if c.Name() != protocol.ProviderClaude {
		t.Errorf("Name() = %q, want %q", c.Name(), protocol.ProviderClaude)
	}
	reg := DefaultRegistry()
	if names := reg.Names(); len(names) != 1 || names[0] != "claude" {
		t.Errorf("registry names = %v, want [claude]", names)
	}
	got, ok := reg.Get("claude")
	if !ok || got.Name() != "claude" {
		t.Errorf("registry Get(claude) = %v, %v", got, ok)
	}
}

func TestCapabilitiesHonest(t *testing.T) {
	caps := New().Capabilities()
	wantTrue := []bool{
		caps.NativeResume, caps.NativeFork, caps.CheckpointLaunch, caps.Hooks, caps.ToolEvents,
		caps.PromptEvents, caps.CompactionEvents, caps.StructuredStreaming,
		caps.SessionEnumeration,
	}
	for i, v := range wantTrue {
		if !v {
			t.Errorf("capability bit %d reported false; hooks/tools/prompts/compaction/stream/enumeration/resume/fork are supported", i)
		}
	}
	if caps.DiffEvents {
		t.Error("DiffEvents must be reported honestly as unsupported")
	}
	if caps.TestExitStatus {
		t.Error("TestExitStatus must be reported honestly as unsupported (no native test-exit signal)")
	}
}

func TestDetectEnumeratesTranscripts(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "-Users-arbaz-Projects-tools")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	older := time.Now().Add(-2 * time.Hour)
	newer := time.Now().Add(-1 * time.Hour)
	files := map[string]time.Time{
		"9f3c1a7e-0d2b-4c8e-9a1f-5b6c7d8e9f0a.jsonl": newer,
		"1a2b3c4d-0000-0000-0000-000000000000.jsonl": older,
	}
	for name, mtime := range files {
		p := filepath.Join(project, name)
		if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}

	c := &Claude{ProjectsDir: root}
	refs, err := c.Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %d, want 2", len(refs))
	}
	// Newest first.
	if refs[0].NativeID != "9f3c1a7e-0d2b-4c8e-9a1f-5b6c7d8e9f0a" {
		t.Errorf("refs[0].NativeID = %q, want newest session first", refs[0].NativeID)
	}
	if refs[0].Provider != protocol.ProviderClaude {
		t.Errorf("Provider = %q", refs[0].Provider)
	}
	if !refs[0].LastEventAt.After(refs[1].LastEventAt) {
		t.Error("refs not ordered newest first")
	}
}

func TestDetectMissingDirectoryIsEmptyNotError(t *testing.T) {
	c := &Claude{ProjectsDir: filepath.Join(t.TempDir(), "does-not-exist")}
	refs, err := c.Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("Detect on missing dir: %v (best-effort must not fail)", err)
	}
	if len(refs) != 0 {
		t.Errorf("refs = %d, want 0", len(refs))
	}
}

func TestDetectDirArgumentOverrides(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	if err := os.WriteFile(filepath.Join(a, "sess-a.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := &Claude{ProjectsDir: b}
	refs, err := c.Detect(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].NativeID != "sess-a" {
		t.Fatalf("refs = %+v, want one sess-a", refs)
	}
}

func TestInstallAndUninstallViaAdapter(t *testing.T) {
	dir := t.TempDir()
	c := &Claude{ConfigDir: dir, HookCommand: "/bin/handoffgraph hook claude"}

	if err := c.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Install: %v", err)
	}
	events, err := claudehooks.InstalledHookEvents(claudehooks.Options{ConfigDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != len(claudehooks.HookEvents) {
		t.Fatalf("installed events = %v", events)
	}

	// Idempotent re-install.
	if err := c.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("re-Install: %v", err)
	}

	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	events, err = claudehooks.InstalledHookEvents(claudehooks.Options{ConfigDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Errorf("installed events after uninstall = %v", events)
	}
}

func TestInstallProjectScopeUnsupported(t *testing.T) {
	c := &Claude{ConfigDir: t.TempDir(), HookCommand: "x"}
	err := c.Install(context.Background(), adapter.ScopeProject)
	if !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Install(project) error = %v, want ErrUnsupported", err)
	}
	if err := c.Uninstall(context.Background(), adapter.ScopeProject); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Uninstall(project) error = %v, want ErrUnsupported", err)
	}
}

func TestInstallDefaultHookCommandIsExecutable(t *testing.T) {
	dir := t.TempDir()
	c := &Claude{ConfigDir: dir}
	if err := c.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Install: %v", err)
	}
	doc := readSettingsDoc(t, filepath.Join(dir, "settings.json"))
	hooks := doc["hooks"].(map[string]any)
	stop := hooks["Stop"].([]any)
	managed := stop[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)
	cmd, _ := managed["command"].(string)
	if cmd == "" || cmd == "handoffgraph" {
		// An empty resolution or the bare fallback is acceptable only when
		// os.Executable failed; on test binaries it must resolve.
		exe, err := os.Executable()
		if err == nil && cmd != exe {
			t.Errorf("default hook command = %q, want executable path %q", cmd, exe)
		}
	}
}

func TestResumeSpec(t *testing.T) {
	c := New()
	spec, err := c.Resume(context.Background(), adapter.SessionRef{NativeID: sessID})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if spec.Command != "claude" {
		t.Errorf("Command = %q, want claude", spec.Command)
	}
	if strings.Join(spec.Args, " ") != "--resume "+sessID {
		t.Errorf("Args = %v", spec.Args)
	}
}

func TestForkSpec(t *testing.T) {
	c := New()
	spec, err := c.Fork(context.Background(), adapter.SessionRef{NativeID: sessID})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	want := "--resume " + sessID + " --fork-session"
	if strings.Join(spec.Args, " ") != want {
		t.Errorf("Args = %v, want %s", spec.Args, want)
	}
}

func TestResumeRejectsUnsafeSessionIDs(t *testing.T) {
	c := New()
	for _, id := range []string{"", "--dangerous", "-x"} {
		if _, err := c.Resume(context.Background(), adapter.SessionRef{NativeID: id}); err == nil {
			t.Errorf("Resume(%q) = nil error, want rejection", id)
		}
		if _, err := c.Fork(context.Background(), adapter.SessionRef{NativeID: id}); err == nil {
			t.Errorf("Fork(%q) = nil error, want rejection", id)
		}
	}
}

func TestStartFromCheckpoint(t *testing.T) {
	cp := &protocol.Checkpoint{
		CheckpointID: "cp_cross_agent",
		WorkstreamID: "ws_checkout",
		Objective:    "--dangerous-looking objective",
	}
	spec, err := New().StartFromCheckpoint(context.Background(), cp)
	if err != nil {
		t.Fatalf("StartFromCheckpoint: %v", err)
	}
	if spec.Command != "claude" || len(spec.Args) != 1 {
		t.Fatalf("spec = %+v, want one-argument claude invocation", spec)
	}
	for _, want := range []string{cp.CheckpointID, cp.WorkstreamID, cp.Objective, "Acknowledge checkpoint"} {
		if !strings.Contains(spec.Args[0], want) {
			t.Errorf("prompt missing %q: %q", want, spec.Args[0])
		}
	}
	if strings.HasPrefix(spec.Args[0], "-") {
		t.Errorf("prompt %q can be interpreted as a CLI flag", spec.Args[0])
	}

	if _, err := New().StartFromCheckpoint(context.Background(), nil); err == nil {
		t.Fatal("nil checkpoint accepted, want error")
	}
}

func TestStartFromCheckpointBoundsObjectiveRuneSafely(t *testing.T) {
	cp := &protocol.Checkpoint{CheckpointID: "cp_bound", WorkstreamID: "ws_bound", Objective: strings.Repeat("é", 5000)}
	spec, err := New().StartFromCheckpoint(context.Background(), cp)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(spec.Args[0], "é"); got != 4000 {
		t.Errorf("objective rune count = %d, want 4000", got)
	}
}

// fixturePath resolves a golden fixture under the repo-root testdata/fixtures
// directory relative to this test file's own location, so the tests run
// correctly from any working directory.
func fixturePath(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate testdata/fixtures")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "testdata", "fixtures", name)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("fixture %s unavailable: %v", name, err)
	}
	return path
}

// TestClaudeFullSessionFixtureGuards the v0.3.0 golden fixture: fifteen
// canonical events for one claude session covering compaction, a tool
// failure and a failing test.
func TestClaudeFullSessionFixture(t *testing.T) {
	data, err := os.ReadFile(fixturePath(t, "claude-full-session.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 15 {
		t.Fatalf("fixture lines = %d, want 15", len(lines))
	}

	seenKinds := map[protocol.EventKind]int{}
	idsSeen := map[string]bool{}
	var nativeIDs []string
	for i, line := range lines {
		var ev protocol.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("line %d: %v", i+1, err)
		}
		if ev.SchemaVersion != protocol.SchemaVersionEvent {
			t.Errorf("line %d: schema_version = %q", i+1, ev.SchemaVersion)
		}
		// Session-scoped lines must carry the claude provider; the leading
		// workstream.started line is provider-less by fixture convention.
		if ev.SessionID != "" && ev.Provider != protocol.ProviderClaude {
			t.Errorf("line %d: provider = %q, want claude", i+1, ev.Provider)
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			t.Errorf("line %d: provenance = %q, want OBSERVED", i+1, ev.Provenance)
		}
		if idsSeen[ev.EventID] {
			t.Errorf("line %d: duplicate event id %s", i+1, ev.EventID)
		}
		idsSeen[ev.EventID] = true
		if ev.NativeSessionID != "" {
			nativeIDs = append(nativeIDs, ev.NativeSessionID)
		}
		seenKinds[ev.Kind]++
	}

	// The three required failure/lifecycle signals.
	for _, kind := range []protocol.EventKind{
		protocol.EventSessionCompacted,
		protocol.EventToolFailed,
		protocol.EventTestCompleted,
	} {
		if seenKinds[kind] == 0 {
			t.Errorf("fixture missing %s events", kind)
		}
	}
	// The failing test must actually be recorded as failed.
	foundFailedTest := false
	for _, line := range lines {
		if strings.Contains(line, `"kind":"test.completed"`) && strings.Contains(line, `"result":"failed"`) {
			foundFailedTest = true
		}
	}
	if !foundFailedTest {
		t.Error("fixture test.completed event is not a failure")
	}
	// One consistent native session.
	if len(nativeIDs) == 0 {
		t.Fatal("fixture has no native_session_id")
	}
	for _, id := range nativeIDs {
		if id != nativeIDs[0] {
			t.Fatalf("inconsistent native session ids: %q vs %q", id, nativeIDs[0])
		}
	}
}

// readSettingsDoc decodes settings.json in dir.
func readSettingsDoc(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		t.Fatal(err)
	}
	return doc
}
