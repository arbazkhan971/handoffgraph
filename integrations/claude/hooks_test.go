package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const testHookCommand = "/usr/local/bin/handoffgraph hook claude"

func opts(dir, command string) Options {
	return Options{ConfigDir: dir, HookCommand: command, LockTimeout: 2 * time.Second}
}

func nativeOpts(dir, executable string) Options {
	return Options{
		ConfigDir:         dir,
		HookCommand:       executable,
		HookArgs:          []string{"hook", "claude"},
		LegacyHookCommand: testHookCommand,
		LockTimeout:       2 * time.Second,
	}
}

func unopts(dir string) Options {
	return Options{ConfigDir: dir, LockTimeout: 2 * time.Second}
}

func settingsPath(dir string) string { return filepath.Join(dir, settingsFile) }
func manifestPath(dir string) string { return filepath.Join(dir, manifestFileName) }

func readDoc(t *testing.T, dir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(settingsPath(dir))
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

func mustArray(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func installedHandler(t *testing.T, dir, event string) map[string]any {
	t.Helper()
	doc := readDoc(t, dir)
	hooks := doc["hooks"].(map[string]any)
	groups := mustArray(hooks[event])
	if len(groups) == 0 {
		t.Fatalf("hooks.%s has no groups", event)
	}
	group := groups[len(groups)-1].(map[string]any)
	handlers := mustArray(group["hooks"])
	if len(handlers) != 1 {
		t.Fatalf("hooks.%s managed handlers = %d, want 1", event, len(handlers))
	}
	return handlers[0].(map[string]any)
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	matches, err := filepath.Glob(pattern)
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

const userSettings = `{
  "model": "claude-sonnet-4-5",
  "permissions": {"allow": ["Bash(go test:*)"], "deny": []},
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

func TestInstallUsesOnlyClaudeSchemaHandlerKeys(t *testing.T) {
	dir := t.TempDir()
	windowsExecutable := `C:\Program Files\HandoffGraph\handoffgraph.exe`
	if err := InstallHooks(nativeOpts(dir, windowsExecutable)); err != nil {
		t.Fatal(err)
	}
	for _, event := range HookEvents {
		handler := installedHandler(t, dir, event)
		if got, want := sortedKeys(handler), []string{"args", "command", "type"}; !reflect.DeepEqual(got, want) {
			t.Errorf("hooks.%s handler keys = %v, want schema-only %v", event, got, want)
		}
		if handler["command"] != windowsExecutable {
			t.Errorf("hooks.%s command = %q, want raw executable %q", event, handler["command"], windowsExecutable)
		}
		if got := mustArray(handler["args"]); !reflect.DeepEqual(got, []any{"hook", "claude"}) {
			t.Errorf("hooks.%s args = %#v", event, got)
		}
		if countKey(handler, legacyMarkerKey) != 0 {
			t.Errorf("hooks.%s contains forbidden ownership marker", event)
		}
	}
	if !contains(HookEvents, "SessionEnd") {
		t.Fatal("managed event list omits SessionEnd")
	}
	info, err := os.Stat(manifestPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("manifest mode = %04o, want 0600", info.Mode().Perm())
	}
	m, err := readManifest(dir)
	if err != nil || m == nil || m.State != manifestStateLive {
		t.Fatalf("active manifest = %+v, %v", m, err)
	}
}

func TestManifestModeValidationIsPlatformAware(t *testing.T) {
	if !manifestModeSecure(0o600, "linux") || manifestModeSecure(0o644, "linux") {
		t.Fatal("POSIX manifest mode validation must require exact 0600")
	}
	if !manifestModeSecure(0o666, "windows") || !manifestModeSecure(0o600, "windows") {
		t.Fatal("Windows manifest mode validation must defer to inherited ACL semantics")
	}
}

func TestSettingsModeSnapshotIsPlatformAware(t *testing.T) {
	if !settingsModeUnchanged(0o600, 0o600, "linux") || settingsModeUnchanged(0o644, 0o600, "linux") {
		t.Fatal("POSIX settings snapshot must compare exact permission bits")
	}
	if !settingsModeUnchanged(0o666, 0o600, "windows") {
		t.Fatal("Windows settings snapshot rejected the writable mode reported for a 0600 file")
	}
	if settingsModeUnchanged(0o444, 0o600, "windows") {
		t.Fatal("Windows settings snapshot missed a writable-to-readonly change")
	}
}

func TestExplicitHookCommandRemainsShellForm(t *testing.T) {
	dir := t.TempDir()
	command := `wrapper --flag "two words"`
	if err := InstallHooks(opts(dir, command)); err != nil {
		t.Fatal(err)
	}
	handler := installedHandler(t, dir, "SessionEnd")
	if got, want := sortedKeys(handler), []string{"command", "type"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("handler keys = %v, want %v", got, want)
	}
	if handler["command"] != command {
		t.Fatalf("command = %q", handler["command"])
	}
}

func TestInstallPreservesUserSettingsAndHooks(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, dir)
	if doc["model"] != "claude-sonnet-4-5" {
		t.Fatalf("model lost: %v", doc["model"])
	}
	if n := doc["bigNumber"].(json.Number).String(); n != "12345678901234567890" {
		t.Fatalf("number rounded: %s", n)
	}
	hooks := doc["hooks"].(map[string]any)
	pre := mustArray(hooks["PreToolUse"])
	if len(pre) != 3 || pre[0].(map[string]any)["matcher"] != "Bash" || pre[1].(map[string]any)["matcher"] != "Edit|Write" {
		t.Fatalf("user hooks changed: %#v", pre)
	}
	info, err := os.Stat(settingsPath(dir))
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("settings mode = %v, %v; want 0640", info.Mode().Perm(), err)
	}
}

func TestInstallIdempotentNoRewriteOrBackup(t *testing.T) {
	dir := t.TempDir()
	o := opts(dir, testHookCommand)
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	settingsBefore, _ := os.ReadFile(settingsPath(dir))
	manifestBefore, _ := os.ReadFile(manifestPath(dir))
	settingsInfo, _ := os.Stat(settingsPath(dir))
	manifestInfo, _ := os.Stat(manifestPath(dir))
	time.Sleep(10 * time.Millisecond)
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	settingsAfter, _ := os.ReadFile(settingsPath(dir))
	manifestAfter, _ := os.ReadFile(manifestPath(dir))
	settingsInfoAfter, _ := os.Stat(settingsPath(dir))
	manifestInfoAfter, _ := os.Stat(manifestPath(dir))
	if !reflect.DeepEqual(settingsBefore, settingsAfter) || !settingsInfo.ModTime().Equal(settingsInfoAfter.ModTime()) {
		t.Error("idempotent install rewrote settings")
	}
	if !reflect.DeepEqual(manifestBefore, manifestAfter) || !manifestInfo.ModTime().Equal(manifestInfoAfter.ModTime()) {
		t.Error("idempotent install rewrote manifest")
	}
	if backups := mustGlob(t, settingsPath(dir)+".hfg-backup-*"); len(backups) != 0 {
		t.Fatalf("idempotent fresh install created backups: %v", backups)
	}
}

func TestInstallDifferentCommandOrUnownedCollisionFailsClosed(t *testing.T) {
	t.Run("manifest command drift", func(t *testing.T) {
		dir := t.TempDir()
		if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
			t.Fatal(err)
		}
		beforeSettings, _ := os.ReadFile(settingsPath(dir))
		beforeManifest, _ := os.ReadFile(manifestPath(dir))
		err := InstallHooks(opts(dir, "/different hook claude"))
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		afterSettings, _ := os.ReadFile(settingsPath(dir))
		afterManifest, _ := os.ReadFile(manifestPath(dir))
		if !reflect.DeepEqual(beforeSettings, afterSettings) || !reflect.DeepEqual(beforeManifest, afterManifest) {
			t.Fatal("conflict modified installer state")
		}
	})

	t.Run("unowned exact command", func(t *testing.T) {
		dir := t.TempDir()
		doc := fmt.Sprintf(`{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":%q}]}]}}`, testHookCommand)
		if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
			t.Fatal(err)
		}
		err := InstallHooks(opts(dir, testHookCommand))
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want collision", err)
		}
		got, _ := os.ReadFile(settingsPath(dir))
		if string(got) != doc {
			t.Fatal("collision modified settings")
		}
		if _, err := os.Stat(manifestPath(dir)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("collision created a manifest")
		}
	})
}

func TestOwnedDriftAndDuplicateFailClosed(t *testing.T) {
	for _, mutation := range []string{"drift", "duplicate"} {
		t.Run(mutation, func(t *testing.T) {
			dir := t.TempDir()
			o := opts(dir, testHookCommand)
			if err := InstallHooks(o); err != nil {
				t.Fatal(err)
			}
			doc := readDoc(t, dir)
			hooks := doc["hooks"].(map[string]any)
			stop := mustArray(hooks["Stop"])
			if mutation == "drift" {
				stop[len(stop)-1].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"] = "changed"
			} else {
				stop = append(stop, managedGroup(hookSpec{Type: "command", Command: testHookCommand}))
				hooks["Stop"] = stop
			}
			raw, _ := json.Marshal(doc)
			if err := os.WriteFile(settingsPath(dir), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			before := append([]byte(nil), raw...)
			if err := InstallHooks(o); !errors.Is(err, ErrHookConflict) {
				t.Fatalf("reinstall error = %v", err)
			}
			if err := UninstallHooks(unopts(dir)); !errors.Is(err, ErrHookConflict) {
				t.Fatalf("uninstall error = %v", err)
			}
			after, _ := os.ReadFile(settingsPath(dir))
			if !reflect.DeepEqual(before, after) {
				t.Fatal("drift conflict modified settings")
			}
		})
	}
}

func legacySettings(command string) []byte {
	hooks := map[string]any{}
	for _, event := range legacyHookEvents {
		hooks[event] = []any{map[string]any{
			"matcher": "",
			"hooks": []any{map[string]any{
				"type": "command", "command": command, legacyMarkerKey: true,
			}},
		}}
	}
	raw, _ := json.Marshal(map[string]any{"model": "keep", "hooks": hooks})
	return raw
}

func TestExactLegacyInstallMigratesToSchemaNativeSidecar(t *testing.T) {
	dir := t.TempDir()
	legacy := testHookCommand
	if err := os.WriteFile(settingsPath(dir), legacySettings(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	o := nativeOpts(dir, `C:\Program Files\HandoffGraph\handoffgraph.exe`)
	o.LegacyHookCommand = legacy
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(settingsPath(dir))
	if strings.Contains(string(raw), legacyMarkerKey) {
		t.Fatalf("legacy marker remains in schema document: %s", raw)
	}
	h := installedHandler(t, dir, "SessionEnd")
	if h["command"] != o.HookCommand || !reflect.DeepEqual(mustArray(h["args"]), []any{"hook", "claude"}) {
		t.Fatalf("legacy handler not migrated: %#v", h)
	}
	if events, err := InstalledHookEvents(unopts(dir)); err != nil || !reflect.DeepEqual(events, HookEvents) {
		t.Fatalf("events = %v, %v", events, err)
	}
}

func TestStrippedLegacyHandlersFailClosedInsteadOfDoubleCapture(t *testing.T) {
	dir := t.TempDir()
	hooks := map[string]any{}
	for _, event := range legacyHookEvents {
		hooks[event] = []any{map[string]any{
			"matcher": "",
			"hooks":   []any{map[string]any{"type": "command", "command": testHookCommand}},
		}}
	}
	raw, _ := json.Marshal(map[string]any{"hooks": hooks})
	if err := os.WriteFile(settingsPath(dir), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	o := nativeOpts(dir, "/new/handoffgraph")
	o.LegacyHookCommand = testHookCommand
	if err := InstallHooks(o); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if !reflect.DeepEqual(got, raw) {
		t.Fatal("stripped-marker collision modified settings")
	}
	if _, err := os.Stat(manifestPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stripped-marker collision created manifest")
	}
}

func TestExecutionIdentityCollisionIgnoresExtraHandlerOptions(t *testing.T) {
	tests := []struct {
		name    string
		handler map[string]any
		opts    Options
	}{
		{
			name: "native desired with timeout",
			handler: map[string]any{
				"type": "command", "command": "/new/handoffgraph",
				"args": []any{"hook", "claude"}, "timeout": json.Number("30"),
			},
			opts: nativeOpts("", "/new/handoffgraph"),
		},
		{
			name: "stripped legacy with async",
			handler: map[string]any{
				"type": "command", "command": testHookCommand, "async": true,
			},
			opts: nativeOpts("", "/new/handoffgraph"),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			tc.opts.ConfigDir = dir
			tc.opts.LegacyHookCommand = testHookCommand
			doc := map[string]any{"hooks": map[string]any{
				"Stop": []any{map[string]any{"matcher": "", "hooks": []any{tc.handler}}},
			}}
			raw, _ := json.Marshal(doc)
			if err := os.WriteFile(settingsPath(dir), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := InstallHooks(tc.opts); !errors.Is(err, ErrHookConflict) {
				t.Fatalf("error = %v, want execution-identity collision", err)
			}
			got, _ := os.ReadFile(settingsPath(dir))
			if !reflect.DeepEqual(got, raw) {
				t.Fatal("collision modified settings")
			}
		})
	}
}

func TestExactLegacyUninstallAndMalformedMarkers(t *testing.T) {
	t.Run("exact full legacy removed", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(settingsPath(dir), legacySettings(testHookCommand), 0o600); err != nil {
			t.Fatal(err)
		}
		if events, err := InstalledHookEvents(unopts(dir)); err != nil || !reflect.DeepEqual(events, legacyHookEvents) {
			t.Fatalf("historical installed events = %v, %v; want exact seven-event set", events, err)
		}
		if err := UninstallHooks(unopts(dir)); err != nil {
			t.Fatal(err)
		}
		doc := readDoc(t, dir)
		if doc["model"] != "keep" {
			t.Fatalf("user setting lost: %v", doc)
		}
		if _, exists := doc["hooks"]; exists {
			t.Fatalf("legacy hooks remain: %v", doc["hooks"])
		}
	})

	badDocs := []string{
		`{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"x","x_handoffgraph_managed":"yes"}]}]}}`,
		`{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"x","x_handoffgraph_managed":true,"foreign":1}]}]}}`,
		`{"hooks":{"CustomEvent":[{"matcher":"","hooks":[{"type":"command","command":"x hook claude","x_handoffgraph_managed":true}]}]}}`,
		fmt.Sprintf(`{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":%q,"x_handoffgraph_managed":true}]}]}}`, testHookCommand),
	}
	for i, doc := range badDocs {
		t.Run(fmt.Sprintf("malformed-%d", i), func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, operation := range []func() error{
				func() error { return InstallHooks(opts(dir, testHookCommand)) },
				func() error { return UninstallHooks(unopts(dir)) },
			} {
				if err := operation(); !errors.Is(err, ErrHookConflict) {
					t.Fatalf("error = %v, want ErrHookConflict", err)
				}
				got, _ := os.ReadFile(settingsPath(dir))
				if string(got) != doc {
					t.Fatal("malformed marker was modified or deleted")
				}
			}
		})
	}
}

func TestEmptyHookArgsCanonicalizeToShellForm(t *testing.T) {
	dir := t.TempDir()
	o := opts(dir, testHookCommand)
	o.HookArgs = []string{}
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	handler := installedHandler(t, dir, "Stop")
	if _, exists := handler["args"]; exists {
		t.Fatalf("empty args were not canonicalized: %#v", handler)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatalf("canonical reinstall drifted: %v", err)
	}
}

func TestExactLegacyCustomCommandCanBeUninstalled(t *testing.T) {
	dir := t.TempDir()
	custom := "custom-wrapper --capture"
	if err := os.WriteFile(settingsPath(dir), legacySettings(custom), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, dir)
	if doc["model"] != "keep" {
		t.Fatalf("custom legacy uninstall lost user settings: %v", doc)
	}
	if _, exists := doc["hooks"]; exists {
		t.Fatalf("custom legacy hooks remain: %v", doc["hooks"])
	}
}

func TestUninstallWithoutManifestPreservesUnmarkedWeirdShapes(t *testing.T) {
	dir := t.TempDir()
	doc := `{"hooks":{"Stop":"scalar","Custom":[{"stray":1}]},"model":"keep"}`
	if err := os.WriteFile(settingsPath(dir), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if string(got) != doc {
		t.Fatalf("noop uninstall rewrote user settings: %s", got)
	}
}

func TestDryRunMissingDirectoryIsTrulyWriteFree(t *testing.T) {
	for _, operation := range []string{"install", "uninstall"} {
		t.Run(operation, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "missing", "claude")
			var err error
			if operation == "install" {
				o := opts(target, testHookCommand)
				o.DryRun = true
				err = InstallHooks(o)
			} else {
				o := unopts(target)
				o.DryRun = true
				err = UninstallHooks(o)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("dry-run created config directory: %v", statErr)
			}
		})
	}
}

func TestUninstallMissingDirectoryIsNoopWithoutCreatingIt(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing", "claude")
	if err := UninstallHooks(unopts(target)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("noop uninstall created config directory: %v", err)
	}
}

func TestTrailingJSONAndJunkFailClosedForInstallAndUninstall(t *testing.T) {
	inputs := []string{
		"{\"model\":\"keep\"}\n{\"second\":\"user bytes\"}",
		"{\"model\":\"keep\"}\ntrailing-junk",
	}
	for i, input := range inputs {
		for _, operation := range []string{"install", "uninstall"} {
			t.Run(fmt.Sprintf("%s-%d", operation, i), func(t *testing.T) {
				dir := t.TempDir()
				if err := os.WriteFile(settingsPath(dir), []byte(input), 0o600); err != nil {
					t.Fatal(err)
				}
				var err error
				if operation == "install" {
					err = InstallHooks(opts(dir, testHookCommand))
				} else {
					err = UninstallHooks(unopts(dir))
				}
				if err == nil {
					t.Fatal("operation accepted trailing bytes")
				}
				got, _ := os.ReadFile(settingsPath(dir))
				if string(got) != input {
					t.Fatal("operation lost trailing user bytes")
				}
				if backups := mustGlob(t, settingsPath(dir)+".hfg-backup-*"); len(backups) != 0 {
					t.Fatalf("failed parse created backup: %v", backups)
				}
				if _, statErr := os.Stat(manifestPath(dir)); !errors.Is(statErr, os.ErrNotExist) {
					t.Fatal("failed parse created manifest")
				}
			})
		}
	}
}

func TestBackupIsExactNoOverwriteAndSymlinkSafe(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	base := settingsPath(dir) + ".hfg-backup-" + now.Format("20060102T150405Z")
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte("do-not-overwrite"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, base); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	o := opts(dir, testHookCommand)
	o.Now = func() time.Time { return now }
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	victimBytes, _ := os.ReadFile(victim)
	if string(victimBytes) != "do-not-overwrite" {
		t.Fatal("backup publication followed/overwrote symlink")
	}
	backup, err := os.ReadFile(base + "-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(backup) != userSettings {
		t.Fatal("backup does not preserve exact original bytes")
	}
}

func TestExternalSettingsWriteWinsCompareBeforeRename(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	external := []byte(`{"external":"wins"}`)
	originalSeam := beforeSettingsRename
	called := false
	beforeSettingsRename = func() {
		if called {
			return
		}
		called = true
		if err := os.WriteFile(settingsPath(dir), external, 0o600); err != nil {
			t.Fatalf("external write: %v", err)
		}
	}
	t.Cleanup(func() { beforeSettingsRename = originalSeam })
	err := InstallHooks(opts(dir, testHookCommand))
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if !reflect.DeepEqual(got, external) {
		t.Fatalf("installer overwrote external write: %s", got)
	}
	if _, err := os.Stat(manifestPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed fresh install left an ownership manifest")
	}
}

func TestExternalManifestWriteWinsCompareBeforeRename(t *testing.T) {
	dir := t.TempDir()
	external := []byte(`{"external":"manifest wins"}`)
	originalSeam := beforeManifestMutation
	called := false
	beforeManifestMutation = func() {
		if called {
			return
		}
		called = true
		if err := os.WriteFile(manifestPath(dir), external, 0o600); err != nil {
			t.Fatalf("external manifest write: %v", err)
		}
	}
	t.Cleanup(func() { beforeManifestMutation = originalSeam })
	err := InstallHooks(opts(dir, testHookCommand))
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	got, _ := os.ReadFile(manifestPath(dir))
	if !reflect.DeepEqual(got, external) {
		t.Fatalf("installer overwrote external manifest: %s", got)
	}
	if _, err := os.Stat(settingsPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("manifest collision still wrote settings")
	}
}

func TestSettingsRenameRequiresExactPendingManifest(t *testing.T) {
	for _, operation := range []string{"install", "uninstall"} {
		for _, mutation := range []string{"delete", "replace"} {
			t.Run(operation+"-"+mutation, func(t *testing.T) {
				dir := t.TempDir()
				o := opts(dir, testHookCommand)
				if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
					t.Fatal(err)
				}
				if operation == "uninstall" {
					if err := InstallHooks(o); err != nil {
						t.Fatal(err)
					}
				}
				settingsBefore, err := os.ReadFile(settingsPath(dir))
				if err != nil {
					t.Fatal(err)
				}

				foreign := []byte(`{"external":"manifest wins at settings rename"}`)
				originalSeam := beforeSettingsRename
				called := false
				beforeSettingsRename = func() {
					if called {
						return
					}
					called = true
					if err := os.Remove(manifestPath(dir)); err != nil {
						t.Fatalf("remove pending manifest: %v", err)
					}
					if mutation == "replace" {
						if err := os.WriteFile(manifestPath(dir), foreign, 0o600); err != nil {
							t.Fatalf("replace pending manifest: %v", err)
						}
					}
				}
				t.Cleanup(func() { beforeSettingsRename = originalSeam })

				if operation == "install" {
					err = InstallHooks(o)
				} else {
					err = UninstallHooks(unopts(dir))
				}
				if !errors.Is(err, ErrHookConflict) {
					t.Fatalf("error = %v, want ErrHookConflict", err)
				}
				if !called {
					t.Fatal("settings rename seam was not reached")
				}
				settingsAfter, readErr := os.ReadFile(settingsPath(dir))
				if readErr != nil {
					t.Fatal(readErr)
				}
				if !reflect.DeepEqual(settingsAfter, settingsBefore) {
					t.Fatal("settings changed after pending manifest CAS conflict")
				}
				manifestAfter, readErr := os.ReadFile(manifestPath(dir))
				if mutation == "delete" {
					if !errors.Is(readErr, os.ErrNotExist) {
						t.Fatalf("deleted pending manifest was recreated: %q, %v", manifestAfter, readErr)
					}
				} else if readErr != nil || !reflect.DeepEqual(manifestAfter, foreign) {
					t.Fatalf("foreign manifest was changed: %q, %v", manifestAfter, readErr)
				}
			})
		}
	}
}

func TestFinalManifestTransitionRequiresExactSettingsPostimage(t *testing.T) {
	t.Run("install", func(t *testing.T) {
		dir := t.TempDir()
		external := []byte(`{"external":"settings wins before active publish"}`)
		originalSeam := beforeManifestMutation
		calls := 0
		beforeManifestMutation = func() {
			calls++
			if calls == 2 {
				if err := os.WriteFile(settingsPath(dir), external, 0o600); err != nil {
					t.Fatalf("external settings write: %v", err)
				}
			}
		}
		t.Cleanup(func() { beforeManifestMutation = originalSeam })

		err := InstallHooks(opts(dir, testHookCommand))
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		if calls != 2 {
			t.Fatalf("manifest mutation calls = %d, want 2", calls)
		}
		got, readErr := os.ReadFile(settingsPath(dir))
		if readErr != nil || !reflect.DeepEqual(got, external) {
			t.Fatalf("external settings = %q, %v; want preserved", got, readErr)
		}
		m, readErr := readManifest(dir)
		if readErr != nil || m == nil || m.State != manifestStateAdd {
			t.Fatalf("manifest = %+v, %v; want pending install", m, readErr)
		}
	})

	t.Run("uninstall", func(t *testing.T) {
		dir := t.TempDir()
		o := opts(dir, testHookCommand)
		if err := InstallHooks(o); err != nil {
			t.Fatal(err)
		}
		installed, err := os.ReadFile(settingsPath(dir))
		if err != nil {
			t.Fatal(err)
		}
		originalSeam := beforeManifestMutation
		calls := 0
		beforeManifestMutation = func() {
			calls++
			if calls == 2 {
				if err := os.WriteFile(settingsPath(dir), installed, 0o600); err != nil {
					t.Fatalf("re-add managed settings: %v", err)
				}
			}
		}
		t.Cleanup(func() { beforeManifestMutation = originalSeam })

		err = UninstallHooks(unopts(dir))
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		if calls != 2 {
			t.Fatalf("manifest mutation calls = %d, want 2", calls)
		}
		got, readErr := os.ReadFile(settingsPath(dir))
		if readErr != nil || !reflect.DeepEqual(got, installed) {
			t.Fatalf("re-added settings changed: %q, %v", got, readErr)
		}
		m, readErr := readManifest(dir)
		if readErr != nil || m == nil || m.State != manifestStateDrop {
			t.Fatalf("manifest = %+v, %v; want pending uninstall", m, readErr)
		}
	})
}

func stagePendingInstall(t *testing.T, dir string, o Options, writeAfter bool) {
	t.Helper()
	s, err := readSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := specFromOptions(o)
	if err != nil {
		t.Fatal(err)
	}
	before := stateDigest(s)
	legacyCommand, err := legacyCommandInConfig(s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := mergeFreshInstall(s.cfg, spec, o); err != nil {
		t.Fatal(err)
	}
	after, err := renderedSettings(s)
	if err != nil {
		t.Fatal(err)
	}
	pending := pendingManifest(manifestStateAdd, spec, legacyCommand, before, after)
	if err := writeManifestAtomic(dir, &pending, nil, s); err != nil {
		t.Fatal(err)
	}
	if writeAfter {
		if err := os.WriteFile(settingsPath(dir), after, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPendingInstallRecoversBeforeOrAfterSettingsRename(t *testing.T) {
	for _, writeAfter := range []bool{false, true} {
		t.Run(fmt.Sprintf("after=%v", writeAfter), func(t *testing.T) {
			dir := t.TempDir()
			o := opts(dir, testHookCommand)
			stagePendingInstall(t, dir, o, writeAfter)
			if err := InstallHooks(o); err != nil {
				t.Fatal(err)
			}
			m, err := readManifest(dir)
			if err != nil || m == nil || m.State != manifestStateLive {
				t.Fatalf("manifest = %+v, %v", m, err)
			}
			if err := InstallHooks(o); err != nil {
				t.Fatalf("post-recovery idempotent install: %v", err)
			}
		})
	}
}

func TestPendingRecoverySettingsRenameRequiresExactManifest(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	originalSettings, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	o := opts(dir, testHookCommand)
	stagePendingInstall(t, dir, o, false)
	foreign := []byte(`{"external":"recovery manifest wins"}`)
	originalSeam := beforeSettingsRename
	beforeSettingsRename = func() {
		if err := os.Remove(manifestPath(dir)); err != nil {
			t.Fatalf("remove recovery manifest: %v", err)
		}
		if err := os.WriteFile(manifestPath(dir), foreign, 0o600); err != nil {
			t.Fatalf("replace recovery manifest: %v", err)
		}
	}
	t.Cleanup(func() { beforeSettingsRename = originalSeam })

	err = InstallHooks(o)
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	gotSettings, readErr := os.ReadFile(settingsPath(dir))
	if readErr != nil || !reflect.DeepEqual(gotSettings, originalSettings) {
		t.Fatalf("settings = %q, %v; want exact pre-recovery bytes", gotSettings, readErr)
	}
	gotManifest, readErr := os.ReadFile(manifestPath(dir))
	if readErr != nil || !reflect.DeepEqual(gotManifest, foreign) {
		t.Fatalf("foreign manifest = %q, %v; want preserved", gotManifest, readErr)
	}
}

func TestPendingRecoveryFinalTransitionRequiresExactSettingsPostimage(t *testing.T) {
	t.Run("install", func(t *testing.T) {
		dir := t.TempDir()
		o := opts(dir, testHookCommand)
		stagePendingInstall(t, dir, o, true)
		external := []byte(`{"external":"recovery settings wins"}`)
		originalSeam := beforeManifestMutation
		beforeManifestMutation = func() {
			if err := os.WriteFile(settingsPath(dir), external, 0o600); err != nil {
				t.Fatalf("external settings write: %v", err)
			}
		}
		t.Cleanup(func() { beforeManifestMutation = originalSeam })

		err := InstallHooks(o)
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		got, readErr := os.ReadFile(settingsPath(dir))
		if readErr != nil || !reflect.DeepEqual(got, external) {
			t.Fatalf("external settings = %q, %v; want preserved", got, readErr)
		}
		m, readErr := readManifest(dir)
		if readErr != nil || m == nil || m.State != manifestStateAdd {
			t.Fatalf("manifest = %+v, %v; want pending install", m, readErr)
		}
	})

	t.Run("uninstall", func(t *testing.T) {
		dir := t.TempDir()
		o := opts(dir, testHookCommand)
		if err := InstallHooks(o); err != nil {
			t.Fatal(err)
		}
		installed, err := os.ReadFile(settingsPath(dir))
		if err != nil {
			t.Fatal(err)
		}
		s, err := readSettings(dir)
		if err != nil {
			t.Fatal(err)
		}
		m, err := readManifest(dir)
		if err != nil {
			t.Fatal(err)
		}
		before := stateDigest(s)
		if err := mergeOwnedUninstall(s.cfg, m.Hook); err != nil {
			t.Fatal(err)
		}
		after, err := renderedSettings(s)
		if err != nil {
			t.Fatal(err)
		}
		pending := pendingManifest(manifestStateDrop, m.Hook, "", before, after)
		if err := writeManifestAtomic(dir, &pending, m, s); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(settingsPath(dir), after, s.mode); err != nil {
			t.Fatal(err)
		}

		originalSeam := beforeManifestMutation
		beforeManifestMutation = func() {
			if err := os.WriteFile(settingsPath(dir), installed, s.mode); err != nil {
				t.Fatalf("re-add managed settings: %v", err)
			}
		}
		t.Cleanup(func() { beforeManifestMutation = originalSeam })

		err = UninstallHooks(unopts(dir))
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		got, readErr := os.ReadFile(settingsPath(dir))
		if readErr != nil || !reflect.DeepEqual(got, installed) {
			t.Fatalf("re-added settings = %q, %v; want preserved", got, readErr)
		}
		m, readErr = readManifest(dir)
		if readErr != nil || m == nil || m.State != manifestStateDrop {
			t.Fatalf("manifest = %+v, %v; want pending uninstall", m, readErr)
		}
	})
}

func TestPendingLegacyInstallRecoversAndAddsSessionEnd(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), legacySettings(testHookCommand), 0o600); err != nil {
		t.Fatal(err)
	}
	o := nativeOpts(dir, "/new/handoffgraph")
	o.LegacyHookCommand = testHookCommand
	stagePendingInstall(t, dir, o, false)
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	if h := installedHandler(t, dir, "SessionEnd"); h["command"] != "/new/handoffgraph" {
		t.Fatalf("SessionEnd not added during recovery: %#v", h)
	}
	raw, _ := os.ReadFile(settingsPath(dir))
	if strings.Contains(string(raw), legacyMarkerKey) {
		t.Fatal("recovered migration left inline markers")
	}
}

func TestPendingTransactionTamperFailsClosed(t *testing.T) {
	dir := t.TempDir()
	o := opts(dir, testHookCommand)
	stagePendingInstall(t, dir, o, false)
	tampered := []byte(`{"user":"changed during crash"}`)
	if err := os.WriteFile(settingsPath(dir), tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(o); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	got, _ := os.ReadFile(settingsPath(dir))
	if !reflect.DeepEqual(got, tampered) {
		t.Fatal("recovery overwrote tampered settings")
	}
}

func TestPendingUninstallRecovers(t *testing.T) {
	dir := t.TempDir()
	o := opts(dir, testHookCommand)
	if err := InstallHooks(o); err != nil {
		t.Fatal(err)
	}
	s, err := readSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	before := stateDigest(s)
	if err := mergeOwnedUninstall(s.cfg, m.Hook); err != nil {
		t.Fatal(err)
	}
	after, _ := renderedSettings(s)
	pending := pendingManifest(manifestStateDrop, m.Hook, "", before, after)
	if err := writeManifestAtomic(dir, &pending, m, s); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manifestPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("recovered uninstall left manifest")
	}
	events, err := InstalledHookEvents(unopts(dir))
	if err != nil || len(events) != 0 {
		t.Fatalf("events after recovery = %v, %v", events, err)
	}
}

func TestPendingLegacyUninstallRecovers(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), legacySettings(testHookCommand), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := readSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	legacy, events, found, err := legacySpecForUninstall(s.cfg)
	if err != nil || !found {
		t.Fatalf("legacy state = %+v, %v, %v", legacy, found, err)
	}
	before := stateDigest(s)
	if err := mergeLegacyUninstall(s.cfg, legacy, events); err != nil {
		t.Fatal(err)
	}
	after, _ := renderedSettings(s)
	pending := pendingManifest(manifestStateDrop, legacy, legacy.Command, before, after)
	if err := writeManifestAtomic(dir, &pending, nil, s); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, dir)
	if doc["model"] != "keep" {
		t.Fatalf("recovered legacy uninstall lost user settings: %v", doc)
	}
	if _, exists := doc["hooks"]; exists {
		t.Fatalf("recovered legacy hooks remain: %v", doc["hooks"])
	}
}

func TestUninstallPreservesUserHooksAndLaterUserEdits(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, dir)
	doc["after_install"] = "preserve"
	raw, _ := json.Marshal(doc)
	if err := os.WriteFile(settingsPath(dir), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	doc = readDoc(t, dir)
	if doc["after_install"] != "preserve" || doc["model"] != "claude-sonnet-4-5" {
		t.Fatalf("user edits lost: %v", doc)
	}
	hooks := doc["hooks"].(map[string]any)
	if len(mustArray(hooks["PreToolUse"])) != 2 || len(mustArray(hooks["Stop"])) != 1 {
		t.Fatalf("user hooks changed: %v", hooks)
	}
	for _, event := range HookEvents {
		if event == "PreToolUse" || event == "Stop" {
			continue
		}
		if _, exists := hooks[event]; exists {
			t.Errorf("managed-only event %s remains", event)
		}
	}
	if _, err := os.Stat(manifestPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("uninstall left manifest")
	}
}

func TestManifestMalformedModeAndSymlinkFailClosed(t *testing.T) {
	t.Run("mode", func(t *testing.T) {
		dir := t.TempDir()
		o := opts(dir, testHookCommand)
		if err := InstallHooks(o); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(manifestPath(dir), 0o644); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(settingsPath(dir))
		if err := InstallHooks(o); !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v", err)
		}
		after, _ := os.ReadFile(settingsPath(dir))
		if !reflect.DeepEqual(before, after) {
			t.Fatal("bad manifest mode modified settings")
		}
	})

	t.Run("unknown field", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(manifestPath(dir), []byte(`{"version":1,"provider":"claude","settings_file":"settings.json","state":"active","hook":{"type":"command","command":"x"},"events":[],"foreign":true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := InstallHooks(opts(dir, testHookCommand)); !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(t.TempDir(), "manifest")
		if err := os.WriteFile(target, []byte("foreign"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, manifestPath(dir)); err != nil {
			t.Skip(err)
		}
		if err := InstallHooks(opts(dir, testHookCommand)); !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestConcurrentInstallsSerialize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(settingsPath(dir), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = InstallHooks(opts(dir, testHookCommand))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("install %d: %v", i, err)
		}
	}
	if events, err := InstalledHookEvents(unopts(dir)); err != nil || !reflect.DeepEqual(events, HookEvents) {
		t.Fatalf("events = %v, %v", events, err)
	}
	for _, event := range HookEvents {
		hooks := readDoc(t, dir)["hooks"].(map[string]any)
		count := 0
		for _, rawGroup := range mustArray(hooks[event]) {
			if exactGroup(rawGroup.(map[string]any), hookSpec{Type: "command", Command: testHookCommand}) {
				count++
			}
		}
		if count != 1 {
			t.Errorf("hooks.%s managed group count = %d", event, count)
		}
	}
}

func TestLockTimeoutNeverReclaimsAnApparentlyStaleLock(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(lockPath, []byte("held"), 0o600); err != nil {
		t.Fatal(err)
	}
	o := opts(dir, testHookCommand)
	o.LockTimeout = 25 * time.Millisecond
	if err := InstallHooks(o); err == nil {
		t.Fatal("fresh held lock did not time out")
	}
	stale := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(lockPath, stale, stale); err != nil {
		t.Fatal(err)
	}
	o.LockTimeout = 25 * time.Millisecond
	if err := InstallHooks(o); err == nil || !strings.Contains(err.Error(), "verify no hook operation") {
		t.Fatalf("stale-looking lock error = %v", err)
	}
	if got, err := os.ReadFile(lockPath); err != nil || string(got) != "held" {
		t.Fatalf("stale-looking lock was reclaimed: %q, %v", got, err)
	}
}

func TestRemoveOwnedLockPreservesReplacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(path, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	owned, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedLock(path, owned); err == nil || !strings.Contains(err.Error(), "ownership changed") {
		t.Fatalf("release error = %v, want ownership refusal", err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != "replacement" {
		t.Fatalf("replacement lock = %q, %v; want preserved", got, err)
	}
}

func TestInstalledHookEventsNoopAndSorted(t *testing.T) {
	dir := t.TempDir()
	if got, err := InstalledHookEvents(unopts(dir)); err != nil || len(got) != 0 {
		t.Fatalf("empty events = %v, %v", got, err)
	}
	if err := InstallHooks(opts(dir, testHookCommand)); err != nil {
		t.Fatal(err)
	}
	got, err := InstalledHookEvents(unopts(dir))
	if err != nil || !sort.StringsAreSorted(got) || !reflect.DeepEqual(got, HookEvents) {
		t.Fatalf("events = %v, %v", got, err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatal(err)
	}
	if err := UninstallHooks(unopts(dir)); err != nil {
		t.Fatalf("idempotent uninstall: %v", err)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
