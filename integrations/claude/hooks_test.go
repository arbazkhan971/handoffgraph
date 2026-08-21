package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The tests in this file never touch the real ~/.claude: every operation
// points ConfigDir at a temp directory owned by the test.

const testHookCommand = "/usr/local/bin/handoffgraph hook claude"

// opts builds install options for dir.
func opts(dir, cmd string) Options {
	return Options{ConfigDir: dir, HookCommand: cmd, LockTimeout: 2 * time.Second}
}

// unopts builds uninstall options for dir.
func unopts(dir string) Options {
	return Options{ConfigDir: dir, LockTimeout: 2 * time.Second}
}

// readDoc loads settings.json from dir as a generic map.
func readDoc(t *testing.T, dir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, settingsFile))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var doc map[string]any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	return doc
}

// settingsPath returns the settings file location for dir.
func settingsPath(dir string) string { return filepath.Join(dir, settingsFile) }

// managedEventsIn returns the sorted hook events whose arrays contain a
// marked entry, plus the marked commands found (for count assertions).
func managedEventsIn(t *testing.T, dir string) (events []string, commands []string) {
	t.Helper()
	doc := readDoc(t, dir)
	hooks, ok := doc["hooks"].(map[string]any)
	if !ok {
		return nil, nil
	}
	for event, entries := range hooks {
		arr, ok := entries.([]any)
		if !ok {
			continue
		}
		for _, group := range arr {
			g, ok := group.(map[string]any)
			if !ok {
				continue
			}
			for _, h := range mustArray(g["hooks"]) {
				hobj, ok := h.(map[string]any)
				if !ok {
					continue
				}
				if marked, _ := hookObject(hobj).marked(); marked {
					events = append(events, event)
					if cmd, _ := hobj["command"].(string); cmd != "" {
						commands = append(commands, cmd)
					}
				}
			}
		}
	}
	sort.Strings(events)
	sort.Strings(commands)
	return events, commands
}

func mustArray(v any) []any {
	arr, _ := v.([]any)
	return arr
}

// userSettings is a settings document with realistic user-owned content
// that installs must never disturb.
const userSettings = `{
  "model": "claude-sonnet-4-5",
  "permissions": {"allow": ["Bash(go test:*)"], "deny": []},
  "env": {"CLAUDE_CODE_MAX_OUTPUT_TOKENS": 32000},
  "bigNumber": 12345678901234567890,
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "/usr/bin/notify bash-start"}]},
      {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "/usr/bin/guard-edit"}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "/usr/bin/on-stop"}]}
    ]
  }
}`

func TestInstallIntoMissingFileCreatesAllEvents(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("InstallHooks: %v", err)
	}
	events, cmds := managedEventsIn(t, dir)
	if len(events) != len(HookEvents) {
		t.Fatalf("managed events = %v, want all %d of %v", events, len(HookEvents), HookEvents)
	}
	for i, ev := range events {
		if ev != HookEvents[i] {
			t.Errorf("events[%d] = %q, want %q", i, ev, HookEvents[i])
		}
	}
	for _, cmd := range cmds {
		if cmd != testHookCommand {
			t.Errorf("managed command = %q, want %q", cmd, testHookCommand)
		}
	}
}

func TestInstallPreservesUserHooksAndSettings(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("InstallHooks: %v", err)
	}
	doc := readDoc(t, dir)

	// Unrelated settings survive.
	if doc["model"] != "claude-sonnet-4-5" {
		t.Errorf("model = %v, want preserved", doc["model"])
	}
	if got, _ := doc["bigNumber"].(json.Number); got.String() != "12345678901234567890" {
		t.Errorf("bigNumber = %v, want exact lexeme preserved", doc["bigNumber"])
	}
	if _, ok := doc["permissions"].(map[string]any); !ok {
		t.Errorf("permissions lost: %v", doc["permissions"])
	}

	// User hooks survive verbatim.
	hooks := doc["hooks"].(map[string]any)
	pre := mustArray(hooks["PreToolUse"])
	if len(pre) != 3 { // 2 user groups + 1 managed
		t.Fatalf("PreToolUse groups = %d, want 3", len(pre))
	}
	first := pre[0].(map[string]any)
	if first["matcher"] != "Bash" {
		t.Errorf("user matcher = %v, want Bash", first["matcher"])
	}
	userCmd := mustArray(first["hooks"])[0].(map[string]any)["command"]
	if userCmd != "/usr/bin/notify bash-start" {
		t.Errorf("user hook command = %v, want preserved", userCmd)
	}

	stop := mustArray(hooks["Stop"])
	if len(stop) != 2 { // 1 user group + 1 managed
		t.Fatalf("Stop groups = %d, want 2", len(stop))
	}

	// Every managed group matches everything.
	for _, ev := range HookEvents {
		arr := mustArray(hooks[ev])
		last := arr[len(arr)-1].(map[string]any)
		if last["matcher"] != "" {
			t.Errorf("hooks.%s managed matcher = %v, want \"\"", ev, last["matcher"])
		}
	}
}

func TestInstallIdempotentNoRewriteNoBackup(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(10 * time.Millisecond) // ensure a new backup name would differ
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("second InstallHooks: %v", err)
	}
	second, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Error("idempotent install rewrote settings.json")
	}
	info2, err := os.Stat(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !info2.ModTime().Equal(info.ModTime()) {
		t.Error("idempotent install changed mtime")
	}
	backups := mustGlob(t, filepath.Join(dir, settingsFile+".hfg-backup-*"))
	if len(backups) != 0 {
		t.Errorf("idempotent install created backups: %v", backups)
	}
}

func TestInstallDifferentCommandOverManagedIsConflict(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(settingsPath(dir))
	err := InstallHooks(opts(dir, "/other/command"))
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("InstallHooks error = %v, want ErrHookConflict", err)
	}
	after, _ := os.ReadFile(settingsPath(dir))
	if string(before) != string(after) {
		t.Error("conflicting install modified settings.json")
	}
}

// TestInstallWeirdShapesIsFailClosed covers malformed hooks documents:
// every row must abort with ErrHookConflict and leave the file untouched.
func TestInstallWeirdShapesIsFailClosed(t *testing.T) {
	tests := []struct {
		name string
		doc  string
	}{
		{"hooks is a string", `{"hooks": "nope"}`},
		{"hooks is an array", `{"hooks": []}`},
		{"event is an object", `{"hooks": {"PreToolUse": {"matcher": ""}}}`},
		{"event is a string", `{"hooks": {"Stop": "yes"}}`},
		{"group is a string", `{"hooks": {"Stop": ["user-group"]}}`},
		{"group is a number", `{"hooks": {"Stop": [42]}}`},
		{"group hooks is a string", `{"hooks": {"Stop": [{"matcher": "", "hooks": "/bin/true"}]}}`},
		{"hook entry is a string", `{"hooks": {"Stop": [{"matcher": "", "hooks": ["/bin/true"]}]}}`},
		{"hook entry is a number", `{"hooks": {"Stop": [{"matcher": "", "hooks": [7]}]}}`},
		{"marker is a string", `{"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "x", "x_handoffgraph_managed": "yes"}]}]}}`},
		{"marker is a number", `{"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "x", "x_handoffgraph_managed": 1}]}]}}`},
		{"marker is null", `{"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "x", "x_handoffgraph_managed": null}]}]}}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := settingsPath(dir)
			if err := os.WriteFile(path, []byte(tc.doc), 0o600); err != nil {
				t.Fatal(err)
			}
			err := InstallHooks(opts(dir, testHookCommand))
			if !errors.Is(err, ErrHookConflict) {
				t.Fatalf("InstallHooks error = %v, want ErrHookConflict", err)
			}
			got, _ := os.ReadFile(path)
			if string(got) != tc.doc {
				t.Error("fail-closed install modified the file")
			}
		})
	}
}

func TestInstallUnparseableFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := settingsPath(dir)
	broken := []byte(`{"hooks": {"Stop": [`)
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}
	err := InstallHooks(opts(dir, testHookCommand))
	if err == nil {
		t.Fatal("InstallHooks on broken JSON = nil error, want fail-closed error")
	}
	if errors.Is(err, ErrHookConflict) {
		t.Logf("conflict error acceptable: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(broken) {
		t.Error("install modified unparseable file")
	}
}

func TestInstallCreatesTimestampedBackup(t *testing.T) {
	dir := t.TempDir()
	path := settingsPath(dir)
	if err := os.WriteFile(path, []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 10, 30, 0, 0, time.UTC)
	o := opts(dir, testHookCommand)
	o.Now = func() time.Time { return now }
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	want := path + ".hfg-backup-" + now.Format("20060102T150405Z")
	backup, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("backup not created at %s: %v", want, err)
	}
	if string(backup) != userSettings {
		t.Error("backup does not preserve the exact previous bytes")
	}
}

func TestInstallDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	o := opts(dir, testHookCommand)
	o.DryRun = true
	if err := InstallHooks(o); err != nil {
		t.Fatalf("dry-run InstallHooks: %v", err)
	}
	if _, err := os.Stat(settingsPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Error("dry-run created settings.json")
	}
	backups := mustGlob(t, filepath.Join(dir, "*backup*"))
	if len(backups) != 0 {
		t.Errorf("dry-run created backups: %v", backups)
	}
}

func TestInstallDryRunStillDetectsConflicts(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(settingsPath(dir))
	o := opts(dir, "/other/command")
	o.DryRun = true
	if err := InstallHooks(o); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("dry-run InstallHooks error = %v, want ErrHookConflict", err)
	}
	after, _ := os.ReadFile(settingsPath(dir))
	if string(before) != string(after) {
		t.Error("dry-run conflict modified settings")
	}
}

func TestInstallEmptyCommandRejected(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, "")); err == nil {
		t.Fatal("InstallHooks with empty command = nil error, want error")
	}
	if _, err := os.Stat(settingsPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Error("failed install created settings.json")
	}
}

func TestInstallRefusesSymlinkedSettings(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real-settings.json")
	if err := os.WriteFile(target, []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	linkDir := t.TempDir()
	if err := os.Symlink(target, settingsPath(linkDir)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	err := InstallHooks(opts(linkDir, testHookCommand))
	if err == nil {
		t.Fatal("InstallHooks through symlink = nil error, want refusal")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Errorf("error = %v, want symlink refusal", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != userSettings {
		t.Error("install wrote through the symlink")
	}
}

func TestUninstallRemovesOnlyManagedEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatalf("UninstallHooks: %v", err)
	}

	doc := readDoc(t, dir)
	hooks := doc["hooks"].(map[string]any)

	// User events and groups survive.
	pre := mustArray(hooks["PreToolUse"])
	if len(pre) != 2 {
		t.Fatalf("PreToolUse groups after uninstall = %d, want 2 (user only)", len(pre))
	}
	stop := mustArray(hooks["Stop"])
	if len(stop) != 1 {
		t.Fatalf("Stop groups after uninstall = %d, want 1 (user only)", len(stop))
	}

	// Managed-only events are gone entirely.
	for _, ev := range HookEvents {
		if ev == "PreToolUse" || ev == "Stop" {
			if _, present := hooks[ev]; !present {
				t.Errorf("hooks.%s removed entirely; user content must survive", ev)
			}
			continue
		}
		if _, present := hooks[ev]; present {
			t.Errorf("hooks.%s still present after uninstall", ev)
		}
	}

	// Unrelated settings survive.
	if doc["model"] != "claude-sonnet-4-5" {
		t.Error("uninstall disturbed unrelated settings")
	}
}

func TestUninstallIdempotentAndNoop(t *testing.T) {
	tests := []struct {
		name string
		doc  string
	}{
		{"no settings file", ""},
		{"no hooks key", `{"model": "claude-sonnet-4-5"}`},
		{"hooks without managed entries", userSettings},
		{"empty hooks object", `{"hooks": {}}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.doc != "" {
				if err := os.WriteFile(settingsPath(dir), []byte(tc.doc), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := UninstallHooks(unopts(dir)); err != nil {
				t.Fatalf("UninstallHooks: %v", err)
			}
			if tc.doc == "" {
				if _, err := os.Stat(settingsPath(dir)); !errors.Is(err, os.ErrNotExist) {
					t.Error("noop uninstall created settings.json")
				}
				return
			}
			got, _ := os.ReadFile(settingsPath(dir))
			if string(got) != tc.doc {
				t.Errorf("noop uninstall rewrote the file:\n got: %s\nwant: %s", got, tc.doc)
			}
		})
	}
}

func TestUninstallMarkerShapeConflict(t *testing.T) {
	dir := t.TempDir()
	doc := `{"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "x", "x_handoffgraph_managed": "yes"}]}]}}`
	if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("UninstallHooks error = %v, want ErrHookConflict", err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if string(got) != doc {
		t.Error("conflicting uninstall modified the file")
	}
}

func TestUninstallPreservesWeirdUnmarkedShapes(t *testing.T) {
	dir := t.TempDir()
	// A hooks value the uninstaller cannot interpret must be preserved, not
	// deleted by name.
	doc := `{"hooks": {"CustomEvent": "scalar", "Other": [{"stray": 1}]}}`
	if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatalf("UninstallHooks: %v", err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if !strings.Contains(string(got), "CustomEvent") || !strings.Contains(string(got), "stray") {
		t.Errorf("uninstall dropped user content it could not parse: %s", got)
	}
}

func TestUninstallDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(settingsPath(dir))
	o := unopts(dir)
	o.DryRun = true
	if err := UninstallHooks(o); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(settingsPath(dir))
	if string(before) != string(after) {
		t.Error("dry-run uninstall modified settings.json")
	}
}

func TestInstalledHookEvents(t *testing.T) {
	dir := t.TempDir()
	if got, err := InstalledHookEvents(Options{ConfigDir: dir}); err != nil || len(got) != 0 {
		t.Fatalf("InstalledHookEvents on empty dir = %v, %v; want empty, nil", got, err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	got, err := InstalledHookEvents(Options{ConfigDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(HookEvents) {
		t.Fatalf("InstalledHookEvents = %v, want %v", got, HookEvents)
	}
	for i := range got {
		if got[i] != HookEvents[i] {
			t.Errorf("InstalledHookEvents[%d] = %q, want %q", i, got[i], HookEvents[i])
		}
	}
}

func TestConcurrentInstallsSerializeSafely(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = InstallHooks(opts(dir, testHookCommand))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("goroutine %d: InstallHooks: %v", i, err)
		}
	}
	events, cmds := managedEventsIn(t, dir)
	if len(events) != len(HookEvents) {
		t.Fatalf("managed events after concurrent installs = %v, want one group per event", events)
	}
	for _, cmd := range cmds {
		if cmd != testHookCommand {
			t.Errorf("managed command = %q, want %q", cmd, testHookCommand)
		}
	}
	// User hooks still intact.
	doc := readDoc(t, dir)
	hooks := doc["hooks"].(map[string]any)
	if len(mustArray(hooks["PreToolUse"])) != 3 {
		t.Errorf("PreToolUse groups = %d, want 3 (2 user + 1 managed)", len(mustArray(hooks["PreToolUse"])))
	}
}

func TestConcurrentInstallAndUninstall(t *testing.T) {
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = InstallHooks(opts(dir, testHookCommand))
		}(i)
	}
	for i := 2; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = UninstallHooks(unopts(dir))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("operation %d: %v", i, err)
		}
	}
	// Whatever interleaving happened, the file must remain valid JSON with
	// no lock file left behind.
	doc := readDoc(t, dir)
	if _, ok := doc["hooks"]; ok && len(doc["hooks"].(map[string]any)) == 0 {
		t.Error("empty hooks object left behind")
	}
	if _, err := os.Stat(filepath.Join(dir, lockFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Error("lock file left behind after operations completed")
	}
}

func TestLockTimeout(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(lockPath, []byte("held"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Fresh lock: must time out quickly.
	o := opts(dir, testHookCommand)
	o.LockTimeout = 50 * time.Millisecond
	start := time.Now()
	err := InstallHooks(o)
	if err == nil {
		t.Fatal("InstallHooks under a held lock = nil error, want timeout")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("timeout took %v, want prompt failure", elapsed)
	}
	if _, err := os.Stat(settingsPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Error("locked-out install wrote settings.json")
	}
}

func TestStaleLockReclaimed(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(lockPath, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-2 * lockStaleAge)
	if err := os.Chtimes(lockPath, stale, stale); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("InstallHooks with stale lock: %v", err)
	}
	if _, err := os.Stat(settingsPath(dir)); err != nil {
		t.Fatalf("settings.json not written: %v", err)
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Error("stale lock not removed")
	}
}

func TestNumbersRoundTripExactly(t *testing.T) {
	dir := t.TempDir()
	doc := `{"hooks": {"Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "u", "timeout": 600}]}]}, "n": 9007199254740993}`
	if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	var round map[string]any
	dec := json.NewDecoder(strings.NewReader(string(got)))
	dec.UseNumber()
	if err := dec.Decode(&round); err != nil {
		t.Fatal(err)
	}
	if n, _ := round["n"].(json.Number); n.String() != "9007199254740993" {
		t.Errorf("n = %v, want exact integer preserved (float64 would round)", round["n"])
	}
	hooks := round["hooks"].(map[string]any)
	timeout := mustArray(mustArray(hooks["Stop"])[0].(map[string]any)["hooks"])[0].(map[string]any)["timeout"]
	if num, ok := timeout.(json.Number); !ok || num.String() != "600" {
		t.Errorf("user hook timeout = %v (%T), want json.Number 600", timeout, timeout)
	}
}

func TestNullDocumentTreatedAsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte("null"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("InstallHooks over `null` document: %v", err)
	}
	events, _ := managedEventsIn(t, dir)
	if len(events) != len(HookEvents) {
		t.Fatalf("managed events = %v", events)
	}
}

func TestUninstallEmptyHooksObjectRemovedWithHooksKey(t *testing.T) {
	// When our entries were the only content, uninstalling must leave no
	// dangling empty "hooks" object behind.
	dir := t.TempDir()
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatalf("settings.json after uninstall: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(got, &doc); err != nil {
		t.Fatal(err)
	}
	if _, present := doc["hooks"]; present {
		t.Errorf("empty hooks object left behind: %s", got)
	}
}

func TestUninstallUserGroupKeptWhenOtherMarksRemoved(t *testing.T) {
	// A user group adjacent to our managed entry in the SAME array must
	// survive, and a group mixing user + managed hooks must keep the user
	// hook.
	dir := t.TempDir()
	doc := fmt.Sprintf(`{"hooks": {"Stop": [%s, {"matcher": "X", "hooks": [{"type": "command", "command": "user-cmd"}, {"type": "command", "command": %q, %q: true}]}]}}`,
		`{"matcher": "", "hooks": [{"type": "command", "command": "plain-user"}]}`, testHookCommand, markerKey)
	if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	var parsed struct {
		Hooks struct {
			Stop []struct {
				Matcher string            `json:"matcher"`
				Hooks   []json.RawMessage `json:"hooks"`
			} `json:"Stop"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Hooks.Stop) != 2 {
		t.Fatalf("Stop groups = %d, want 2 (both user groups kept)", len(parsed.Hooks.Stop))
	}
	for i, g := range parsed.Hooks.Stop {
		if len(g.Hooks) != 1 {
			t.Errorf("group %d hooks = %d, want 1 (only the user hook)", i, len(g.Hooks))
		}
	}
	if !strings.Contains(string(got), "user-cmd") || !strings.Contains(string(got), "plain-user") {
		t.Errorf("user hooks dropped: %s", got)
	}
	if strings.Contains(string(got), testHookCommand) {
		t.Errorf("managed hook survived: %s", got)
	}
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	matches, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatal(err)
	}
	return matches
}
