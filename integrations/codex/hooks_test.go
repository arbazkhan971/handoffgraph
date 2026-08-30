package codexhooks

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BurntSushi/toml"
)

const testCommand = "/usr/local/bin/hfg hook"

func legacyManagedConfig(base string, trailingMarker bool) string {
	var out strings.Builder
	for _, event := range []string{
		"post_tool_use", "pre_tool_use", "session_end",
		"session_start", "turn_end", "turn_start",
	} {
		if trailingMarker {
			out.WriteString("[hooks." + event + "] " + marker + "\n")
		} else {
			out.WriteString(marker + "\n[hooks." + event + "]\n")
		}
		out.WriteString("command = " + strconv.Quote(base+" --event "+event) + "\n")
	}
	return out.String()
}

func TestManagedEventsMatchCodex01443(t *testing.T) {
	want := []string{
		"PermissionRequest",
		"PostCompact",
		"PostToolUse",
		"PreCompact",
		"PreToolUse",
		"SessionStart",
		"Stop",
		"SubagentStart",
		"SubagentStop",
		"UserPromptSubmit",
	}
	if !reflect.DeepEqual(ManagedEvents, want) {
		t.Fatalf("ManagedEvents = %#v, want %#v", ManagedEvents, want)
	}
}

func TestInstallFreshConfigUsesStrictHooksTomlShape(t *testing.T) {
	dir := t.TempDir()
	result, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || !reflect.DeepEqual(result.Entries, ManagedEvents) {
		t.Fatalf("unexpected result: %+v", result)
	}
	text := loadConfig(t, dir)
	if got := strings.Count(text, marker); got != len(ManagedEvents) {
		t.Fatalf("marker count = %d, want %d\n%s", got, len(ManagedEvents), text)
	}
	for _, event := range ManagedEvents {
		if !strings.Contains(text, "[[hooks."+event+"]]\nmatcher = \"\"") {
			t.Errorf("missing matcher-group AoT for %s\n%s", event, text)
		}
		if !strings.Contains(text, "[[hooks."+event+".hooks]]\ntype = \"command\"") {
			t.Errorf("missing nested command handler AoT for %s\n%s", event, text)
		}
		groups := decodedGroups(t, text, event)
		if len(groups) != 1 {
			t.Fatalf("hooks.%s has %d groups, want 1", event, len(groups))
		}
		command, ok := canonicalGroupCommand(groups[0])
		if !ok || command != entryCommand(testCommand, event) {
			t.Fatalf("hooks.%s group = %#v", event, groups[0])
		}
	}
	for legacy := range legacyEvents {
		if strings.Contains(text, "[hooks."+legacy+"]") {
			t.Errorf("legacy singleton hook %q was emitted", legacy)
		}
	}
}

func TestInstallIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	first, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed {
		t.Fatal("first install was not changed")
	}
	want := loadConfig(t, dir)
	second, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed || second.Backup != "" {
		t.Fatalf("second install = %+v, want unchanged without backup", second)
	}
	if got := loadConfig(t, dir); got != want {
		t.Fatal("idempotent install changed config bytes")
	}
}

func TestInstallEmitsAndPreservesWindowsCommandOverride(t *testing.T) {
	dir := t.TempDir()
	windowsCommand := `"C:\Program Files\HandoffGraph\handoffgraph.exe" hook codex`
	first, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed {
		t.Fatal("first install was unchanged")
	}
	for _, event := range ManagedEvents {
		groups := decodedGroups(t, loadConfig(t, dir), event)
		command, commandWindows, ok := canonicalGroupCommands(groups[0])
		if !ok || command != testCommand || commandWindows != windowsCommand {
			t.Fatalf("hooks.%s commands = %q / %q (ok=%v)", event, command, commandWindows, ok)
		}
	}
	second, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed || second.Backup != "" {
		t.Fatalf("second install = %+v, want idempotent no-op", second)
	}
	// A non-Windows reinstall does not know a Windows path, so it preserves a
	// previously managed commandWindows field instead of erasing it.
	third, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if third.Changed {
		t.Fatalf("platform-neutral reinstall erased Windows command: %+v", third)
	}
}

func TestWindowsCommandAliasParticipatesInOwnershipAndCollisionChecks(t *testing.T) {
	windowsCommand := `"C:\Program Files\HandoffGraph\handoffgraph.exe" hook codex`

	t.Run("unmarked snake-case alias collides", func(t *testing.T) {
		dir := t.TempDir()
		original := "[hooks]\nSessionStart = [{ matcher = \"\", hooks = [{ type = \"command\", command = \"other\", command_windows = " + strconv.Quote(windowsCommand) + " }] }]\n"
		storeConfig(t, dir, original, 0o600)
		_, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand})
		if !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		if got := loadConfig(t, dir); got != original {
			t.Fatal("collision changed config bytes")
		}
	})

	t.Run("managed snake-case alias is official and removable", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand}); err != nil {
			t.Fatal(err)
		}
		original := strings.ReplaceAll(loadConfig(t, dir), "commandWindows =", "command_windows =")
		storeConfig(t, dir, original, 0o600)
		result, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand})
		if err != nil {
			t.Fatal(err)
		}
		if result.Changed || loadConfig(t, dir) != original {
			t.Fatal("idempotent install rewrote the official snake-case alias")
		}
		if _, err := Uninstall(dir, Options{}); err != nil {
			t.Fatal(err)
		}
		if got := loadConfig(t, dir); got != "" {
			t.Fatalf("uninstall left managed snake-case aliases:\n%s", got)
		}
	})

	for name, mutate := range map[string]func(string) string{
		"both aliases": func(text string) string {
			return strings.Replace(text, "commandWindows = "+strconv.Quote(windowsCommand)+"\n", "commandWindows = "+strconv.Quote(windowsCommand)+"\ncommand_windows = "+strconv.Quote(windowsCommand)+"\n", 1)
		},
		"unknown third key": func(text string) string {
			text = strings.Replace(text, "command = "+strconv.Quote(testCommand)+"\n", "command = "+strconv.Quote(testCommand)+"\nbogus = true\n", 1)
			return strings.Replace(text, "commandWindows = "+strconv.Quote(windowsCommand)+"\n", "", 1)
		},
	} {
		t.Run("managed "+name+" fails closed", func(t *testing.T) {
			dir := t.TempDir()
			if _, err := Install(dir, Options{Command: testCommand, CommandWindows: windowsCommand}); err != nil {
				t.Fatal(err)
			}
			original := mutate(loadConfig(t, dir))
			storeConfig(t, dir, original, 0o600)
			if _, err := Uninstall(dir, Options{}); !errors.Is(err, ErrHookConflict) {
				t.Fatalf("error = %v, want ErrHookConflict", err)
			}
			if got := loadConfig(t, dir); got != original {
				t.Fatal("failed-closed uninstall changed bytes")
			}
		})
	}
}

func TestGeneratedConfigPassesInstalledCodexStrictConfig(t *testing.T) {
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex CLI is not installed")
	}
	dir := t.TempDir()
	if _, err := Install(dir, Options{
		Command:        testCommand,
		CommandWindows: `"C:\Program Files\HandoffGraph\handoffgraph.exe" hook codex`,
	}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(codex, "--strict-config", "doctor", "--json")
	cmd.Dir = dir
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "CODEX_HOME=") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "CODEX_HOME="+dir)
	output, _ := cmd.CombinedOutput() // doctor may fail overall without auth.
	var report struct {
		Checks map[string]struct {
			Status  string         `json:"status"`
			Details map[string]any `json:"details"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("codex --strict-config doctor did not return JSON: %v\n%s", err, output)
	}
	configCheck, ok := report.Checks["config.load"]
	if !ok || configCheck.Status != "ok" || configCheck.Details["config.toml parse"] != "ok" {
		t.Fatalf("strict config check = %+v, want parsed ok", configCheck)
	}
}

func TestConcurrentInstallsSerializeWithoutLostUpdate(t *testing.T) {
	dir := t.TempDir()
	results := make(chan *Result, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			result, err := Install(dir, Options{Command: testCommand})
			results <- result
			errs <- err
		}()
	}
	changed := 0
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if result := <-results; result != nil && result.Changed {
			changed++
		}
	}
	if changed != 1 {
		t.Fatalf("changed installs = %d, want exactly one", changed)
	}
	for _, event := range ManagedEvents {
		if groups := decodedGroups(t, loadConfig(t, dir), event); len(groups) != 1 {
			t.Fatalf("hooks.%s groups = %d, want one", event, len(groups))
		}
	}
}

func TestConfigVersionChangeFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFile)
	original := "model = \"gpt-5\"\n"
	storeConfig(t, dir, original, 0o600)
	if err := os.WriteFile(path, []byte("model = \"gpt-5.4\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ensureConfigUnchanged("test", path, original, 0o600, true)
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("version check error = %v, want ErrHookConflict", err)
	}
	if got := loadConfig(t, dir); got != "model = \"gpt-5.4\"\n" {
		t.Fatalf("version check changed config to %q", got)
	}
}

func TestInstallReassertsDriftedManagedCommandAndPreservesAdjacentUserBytes(t *testing.T) {
	dir := t.TempDir()
	userPrefix := "model = \"gpt-5\"\n"
	userTail := "\n# user comment immediately after the managed group\n[user]\nvalue = \"keep\"\n"
	drifted := renderAOT("SessionStart", "/old/hfg hook codex", false)
	original := userPrefix + drifted + userTail
	storeConfig(t, dir, original, 0o640)

	result, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Backup == "" {
		t.Fatalf("drift reassert result = %+v, want changed with backup", result)
	}
	if got := loadFile(t, result.Backup); got != original {
		t.Fatalf("backup lost pre-reassert bytes\nwant %q\n got %q", original, got)
	}
	installed := loadConfig(t, dir)
	wantLocalBytes := userPrefix + renderAOT("SessionStart", testCommand, false) + userTail
	if !strings.Contains(installed, wantLocalBytes) {
		t.Fatalf("managed command was not canonically reasserted in place or adjacent user bytes changed\nwant local bytes %q\ninstalled:\n%s", wantLocalBytes, installed)
	}
	groups := decodedGroups(t, installed, "SessionStart")
	if len(groups) != 1 {
		t.Fatalf("SessionStart groups = %d, want one reasserted group", len(groups))
	}
	if command, ok := canonicalGroupCommand(groups[0]); !ok || command != testCommand {
		t.Fatalf("reasserted SessionStart group = %#v", groups[0])
	}

	second, err := Install(dir, Options{Command: testCommand})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed || second.Backup != "" {
		t.Fatalf("second install after reassert = %+v, want idempotent no-op", second)
	}
	if got := loadConfig(t, dir); got != installed {
		t.Fatal("idempotent install changed reasserted bytes")
	}

	if _, err := Uninstall(dir, Options{}); err != nil {
		t.Fatal(err)
	}
	if got, want := loadConfig(t, dir), userPrefix+userTail; got != want {
		t.Fatalf("uninstall after reassert changed adjacent user bytes\nwant %q\n got %q", want, got)
	}
	assertMode(t, filepath.Join(dir, ConfigFile), 0o640)
}

func TestSameEventAOTGroupsAreAdditiveAndStateRoundTrips(t *testing.T) {
	dir := t.TempDir()
	original := "model = \"gpt-5\"\n" +
		"\n[[hooks.SessionStart]]\n" +
		"matcher = \"startup\"\n" +
		"\n[[hooks.SessionStart.hooks]]\n" +
		"type = \"command\"\n" +
		"command = \"/usr/bin/user-hook\"\n" +
		"\n[hooks.state.\"SessionStart:0:0\"]\n" +
		"trusted_hash = \"user-trust-hash\"\n"
	storeConfig(t, dir, original, 0o640)

	if _, err := Install(dir, Options{Command: testCommand}); err != nil {
		t.Fatal(err)
	}
	installed := loadConfig(t, dir)
	groups := decodedGroups(t, installed, "SessionStart")
	if len(groups) != 2 {
		t.Fatalf("SessionStart groups = %d, want 2\n%s", len(groups), installed)
	}
	if matcher, _ := groups[0]["matcher"].(string); matcher != "startup" {
		t.Fatalf("user group moved or changed: %#v", groups[0])
	}
	managed, ok := canonicalGroupCommand(groups[1])
	if !ok || managed != entryCommand(testCommand, "SessionStart") {
		t.Fatalf("managed group was not appended last: %#v", groups[1])
	}
	state := "[hooks.state.\"SessionStart:0:0\"]\ntrusted_hash = \"user-trust-hash\"\n"
	if strings.Count(installed, state) != 1 {
		t.Fatalf("hooks.state/trusted_hash changed\n%s", installed)
	}

	if _, err := Uninstall(dir, Options{}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatalf("uninstall did not restore exact bytes\nwant %q\n got %q", original, got)
	}
	assertMode(t, filepath.Join(dir, ConfigFile), 0o640)
}

func TestInlineArraySpliceIsAdditiveAndExactlyReversible(t *testing.T) {
	dir := t.TempDir()
	original := "model = \"gpt-5\"\n[hooks]\n" +
		"SessionStart = [{ matcher = \"user\", hooks = [{ type = \"command\", command = \"/usr/bin/user-hook\" }] }]\n" +
		"[hooks.state.\"SessionStart:0:0\"]\ntrusted_hash = \"keep-me\""
	storeConfig(t, dir, original, 0o600)

	if _, err := Install(dir, Options{Command: testCommand}); err != nil {
		t.Fatal(err)
	}
	installed := loadConfig(t, dir)
	if !strings.Contains(installed, marker+"\n"+metaPrefix+"true\n, { matcher = \"\"") {
		t.Fatalf("inline splice did not own its leading comma/newline\n%s", installed)
	}
	groups := decodedGroups(t, installed, "SessionStart")
	if len(groups) != 2 {
		t.Fatalf("inline groups = %d, want 2\n%s", len(groups), installed)
	}
	if matcher, _ := groups[0]["matcher"].(string); matcher != "user" {
		t.Fatalf("user inline group changed: %#v", groups[0])
	}
	command, ok := canonicalGroupCommand(groups[1])
	if !ok || command != entryCommand(testCommand, "SessionStart") {
		t.Fatalf("managed inline group malformed: %#v", groups[1])
	}
	if !strings.Contains(installed, "trusted_hash = \"keep-me\"") {
		t.Fatal("trusted hash was lost")
	}

	if _, err := Uninstall(dir, Options{}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatalf("inline uninstall did not restore exact bytes\nwant %q\n got %q", original, got)
	}
}

func TestInlineArrayWithTrailingCommaUsesNoExtraComma(t *testing.T) {
	dir := t.TempDir()
	original := "[hooks]\nSessionStart = [\n" +
		"  { matcher = \"user\", hooks = [{ type = \"command\", command = \"user\" }] }, # retained\n" +
		"]\n"
	storeConfig(t, dir, original, 0o600)
	if _, err := Install(dir, Options{Command: testCommand}); err != nil {
		t.Fatal(err)
	}
	installed := loadConfig(t, dir)
	needle := marker + "\n" + metaPrefix + "false\n{ matcher = \"\""
	if !strings.Contains(installed, needle) {
		t.Fatalf("trailing-comma splice is wrong\n%s", installed)
	}
	if len(decodedGroups(t, installed, "SessionStart")) != 2 {
		t.Fatal("trailing-comma inline array did not decode to two groups")
	}
	if _, err := Uninstall(dir, Options{}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatalf("round-trip changed bytes: %q != %q", got, original)
	}
}

func TestUnmarkedExactCommandCollisionFailsClosed(t *testing.T) {
	dir := t.TempDir()
	original := "[[hooks.SessionStart]]\nmatcher = \"\"\n\n" +
		"[[hooks.SessionStart.hooks]]\ntype = \"command\"\n" +
		"command = \"" + entryCommand(testCommand, "SessionStart") + "\"\n"
	storeConfig(t, dir, original, 0o600)
	_, err := Install(dir, Options{Command: testCommand})
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatal("conflicting install changed config")
	}
	assertNoBackups(t, dir)
}

func TestMalformedManagedMarkersFailClosed(t *testing.T) {
	canonical := renderAOT("SessionStart", entryCommand(testCommand, "SessionStart"), false)
	tests := map[string]string{
		"orphan marker":    marker + "\n",
		"orphan metadata":  metaPrefix + "false\n",
		"unknown owner":    marker + "\n[hooks.state]\ntrusted_hash = \"x\"\n",
		"duplicate marker": canonical + canonical,
		"malformed managed group": marker + "\n" + metaPrefix + "false\n" +
			"[[hooks.SessionStart]]\nmatcher = \"not-managed\"\n\n" +
			"[[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = \"x\"\n",
		"managed inline not last": "[hooks]\nSessionStart = [\n" + marker + "\n" + metaPrefix + "false\n" +
			"{ matcher = \"\", hooks = [{ type = \"command\", command = \"x\" }] },\n" +
			"{ matcher = \"user\", hooks = [{ type = \"command\", command = \"user\" }] }\n]\n",
	}
	for name, original := range tests {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			storeConfig(t, dir, original, 0o600)
			_, err := Install(dir, Options{Command: testCommand})
			if !errors.Is(err, ErrHookConflict) {
				t.Fatalf("error = %v, want ErrHookConflict", err)
			}
			if got := loadConfig(t, dir); got != original {
				t.Fatal("failed-closed install changed bytes")
			}
			assertNoBackups(t, dir)
		})
	}
}

func TestUninstallPreservesCommentsImmediatelyAfterManagedBlocks(t *testing.T) {
	t.Run("current", func(t *testing.T) {
		dir := t.TempDir()
		managed := renderAOT("SessionStart", testCommand, false)
		userTail := "# user comment after managed group\n[user]\nvalue = \"keep\"\n"
		storeConfig(t, dir, managed+userTail, 0o600)
		if _, err := Uninstall(dir, Options{}); err != nil {
			t.Fatal(err)
		}
		if got := loadConfig(t, dir); got != userTail {
			t.Fatalf("uninstall consumed user tail\nwant %q\n got %q", userTail, got)
		}
	})

	t.Run("legacy", func(t *testing.T) {
		dir := t.TempDir()
		managed := legacyManagedConfig("old-hfg", false)
		userTail := "\n# user comment after legacy block\n[user]\nvalue = \"keep\"\n"
		storeConfig(t, dir, managed+userTail, 0o600)
		if _, err := Uninstall(dir, Options{}); err != nil {
			t.Fatal(err)
		}
		if got := loadConfig(t, dir); got != userTail {
			t.Fatalf("legacy uninstall consumed user tail\nwant %q\n got %q", userTail, got)
		}
	})
}

func TestMixedLegacyAndCurrentManagedMarkersFailClosed(t *testing.T) {
	dir := t.TempDir()
	original := legacyManagedConfig("old-hfg", false) +
		renderAOT("SessionStart", testCommand, false)
	storeConfig(t, dir, original, 0o600)
	for _, run := range []struct {
		name string
		fn   func() error
	}{
		{name: "install", fn: func() error {
			_, err := Install(dir, Options{Command: testCommand})
			return err
		}},
		{name: "uninstall", fn: func() error {
			_, err := Uninstall(dir, Options{})
			return err
		}},
	} {
		t.Run(run.name, func(t *testing.T) {
			if err := run.fn(); !errors.Is(err, ErrHookConflict) {
				t.Fatalf("error = %v, want ErrHookConflict", err)
			}
			if got := loadConfig(t, dir); got != original {
				t.Fatal("mixed-marker failure changed config")
			}
		})
	}
}

func TestLegacyManagedSingletonsMigrateAndUninstallCleanly(t *testing.T) {
	dir := t.TempDir()
	baseline := "model = \"gpt-5\"\n"
	original := baseline + legacyManagedConfig("old-hfg", false)
	storeConfig(t, dir, original, 0o600)

	if _, err := Install(dir, Options{Command: testCommand}); err != nil {
		t.Fatal(err)
	}
	installed := loadConfig(t, dir)
	if strings.Contains(installed, "[hooks.session_start]") {
		t.Fatalf("legacy block survived migration\n%s", installed)
	}
	if len(decodedGroups(t, installed, "SessionStart")) != 1 {
		t.Fatal("current SessionStart matcher group missing after migration")
	}
	if _, err := Uninstall(dir, Options{}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(t, dir); got != baseline {
		t.Fatalf("migration round-trip = %q, want %q", got, baseline)
	}
}

func TestUninstallRemovesSafelyRecognizedTrailingLegacyMarker(t *testing.T) {
	dir := t.TempDir()
	baseline := "model = \"gpt-5\"\n"
	original := baseline + legacyManagedConfig("old-hfg", true)
	storeConfig(t, dir, original, 0o600)
	result, err := Uninstall(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatal("legacy uninstall did not report a change")
	}
	if got := loadConfig(t, dir); got != baseline {
		t.Fatalf("legacy uninstall = %q, want %q", got, baseline)
	}
}

func TestPartialOrInconsistentLegacyOwnershipFailsClosed(t *testing.T) {
	partial := marker + "\n[hooks.session_start]\ncommand = \"old-hfg --event session_start\"\n"
	inconsistent := strings.Replace(
		legacyManagedConfig("old-hfg", false),
		"old-hfg --event turn_start",
		"different-hfg --event turn_start",
		1,
	)
	for name, original := range map[string]string{
		"partial set":          partial,
		"inconsistent command": inconsistent,
	} {
		for _, operation := range []string{"install", "uninstall"} {
			t.Run(name+"/"+operation, func(t *testing.T) {
				dir := t.TempDir()
				storeConfig(t, dir, original, 0o600)
				var err error
				if operation == "install" {
					_, err = Install(dir, Options{Command: testCommand})
				} else {
					_, err = Uninstall(dir, Options{})
				}
				if !errors.Is(err, ErrHookConflict) {
					t.Fatalf("error = %v, want ErrHookConflict", err)
				}
				if got := loadConfig(t, dir); got != original {
					t.Fatal("failed-closed legacy operation changed bytes")
				}
				assertNoBackups(t, dir)
			})
		}
	}
}

func TestUnsafeLegacyMarkerDoesNotDeleteUserKeys(t *testing.T) {
	dir := t.TempDir()
	original := marker + "\n[hooks.session_start]\ncommand = \"old\"\nuser_key = \"keep\"\n"
	storeConfig(t, dir, original, 0o600)
	_, err := Uninstall(dir, Options{})
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("error = %v, want ErrHookConflict", err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatal("unsafe legacy uninstall deleted user state")
	}
}

func TestDryRunDoesNotCreateWriteOrBackup(t *testing.T) {
	root := t.TempDir()
	missingDir := filepath.Join(root, "missing", "codex")
	result, err := Install(missingDir, Options{Command: testCommand, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Backup != "" {
		t.Fatalf("dry-run result = %+v", result)
	}
	if _, err := os.Stat(missingDir); !os.IsNotExist(err) {
		t.Fatalf("dry run created directory: %v", err)
	}

	dir := t.TempDir()
	original := "model = \"gpt-5\"\n"
	storeConfig(t, dir, original, 0o600)
	if _, err := Install(dir, Options{Command: testCommand, DryRun: true}); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatal("dry run changed existing config")
	}
	assertNoBackups(t, dir)
}

func TestInstallBacksUpOriginalAndHandlesTimestampCollision(t *testing.T) {
	dir := t.TempDir()
	original := "model = \"gpt-5\"\n"
	storeConfig(t, dir, original, 0o640)
	now := func() time.Time { return time.Date(2026, 8, 30, 12, 34, 56, 0, time.UTC) }
	first, err := Install(dir, Options{Command: testCommand, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	wantFirst := filepath.Join(dir, ConfigFile+".hfg-backup-20260830T123456Z")
	if first.Backup != wantFirst {
		t.Fatalf("first backup = %q, want %q", first.Backup, wantFirst)
	}
	if got := loadFile(t, wantFirst); got != original {
		t.Fatal("first backup does not contain original bytes")
	}
	assertMode(t, wantFirst, 0o640)
	firstInstalled := loadConfig(t, dir)

	second, err := Install(dir, Options{Command: testCommand + "-v2", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	wantSecond := wantFirst + "-2"
	if second.Backup != wantSecond {
		t.Fatalf("second backup = %q, want %q", second.Backup, wantSecond)
	}
	if got := loadFile(t, wantSecond); got != firstInstalled {
		t.Fatal("collision backup does not contain pre-change bytes")
	}
}

func TestSymlinkedConfigIsRefused(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.toml")
	if err := os.WriteFile(target, []byte("model = \"gpt-5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configDir := filepath.Join(dir, "codex")
	if err := os.Mkdir(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(configDir, ConfigFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(configDir, Options{Command: testCommand}); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("install error = %v, want symlink refusal", err)
	}
	if _, err := Uninstall(configDir, Options{}); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("uninstall error = %v, want symlink refusal", err)
	}
	if got := loadFile(t, target); got != "model = \"gpt-5\"\n" {
		t.Fatal("symlink target changed")
	}
}

func TestNonRegularConfigIsRefusedBeforeRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFile)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(dir, Options{Command: testCommand}); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("install error = %v, want non-regular-file refusal", err)
	}
	if _, err := Uninstall(dir, Options{}); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("uninstall error = %v, want non-regular-file refusal", err)
	}
}

func TestLockReleaseNeverRemovesReplacementOwner(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, lockFileName)
	if err := os.WriteFile(path, []byte("first"), 0o600); err != nil {
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
		t.Fatalf("release error = %v, want changed-ownership refusal", err)
	}
	if got := loadFile(t, path); got != "replacement" {
		t.Fatalf("replacement lock = %q, want preserved", got)
	}
}

func TestUnparseableConfigFailsClosed(t *testing.T) {
	dir := t.TempDir()
	original := "[hooks\nnot toml"
	storeConfig(t, dir, original, 0o600)
	if _, err := Install(dir, Options{Command: testCommand}); err == nil {
		t.Fatal("install accepted malformed TOML")
	}
	if _, err := Uninstall(dir, Options{}); err == nil {
		t.Fatal("uninstall accepted malformed TOML")
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatal("malformed config was changed")
	}
	assertNoBackups(t, dir)
}

func TestUninstallWithoutManagedMarkersIsNoOp(t *testing.T) {
	dir := t.TempDir()
	original := "# contains hfg:managed but is not an ownership marker\nmodel = \"gpt-5\""
	storeConfig(t, dir, original, 0o600)
	result, err := Uninstall(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed {
		t.Fatalf("result = %+v, want no-op", result)
	}
	if got := loadConfig(t, dir); got != original {
		t.Fatal("no-op uninstall changed bytes")
	}
}

func TestMultilineStringLookalikesNeverBecomeManagedRegions(t *testing.T) {
	tests := map[string]string{
		"literal": `note = '''
# hfg:managed
[hooks.session_start]
command = "not-a-hook"
[user]
'''
model = "gpt-5"
`,
		"basic": `note = """
# hfg:managed
[hooks.session_start]
command = \"not-a-hook\"
[user]
"""
model = "gpt-5"
`,
	}

	for name, original := range tests {
		t.Run(name+"/install-uninstall", func(t *testing.T) {
			dir := t.TempDir()
			storeConfig(t, dir, original, 0o600)
			installed, err := Install(dir, Options{Command: testCommand})
			if err != nil {
				t.Fatal(err)
			}
			if !installed.Changed {
				t.Fatal("install was unexpectedly a no-op")
			}
			if got := loadConfig(t, dir); !strings.HasPrefix(got, original) {
				t.Fatalf("install changed multiline string bytes\nwant prefix:\n%s\ngot:\n%s", original, got)
			}
			removed, err := Uninstall(dir, Options{})
			if err != nil {
				t.Fatal(err)
			}
			if !removed.Changed {
				t.Fatal("uninstall was unexpectedly a no-op")
			}
			if got := loadConfig(t, dir); got != original {
				t.Fatalf("round trip changed multiline string bytes\nwant:\n%s\ngot:\n%s", original, got)
			}
		})

		t.Run(name+"/uninstall-no-op", func(t *testing.T) {
			dir := t.TempDir()
			storeConfig(t, dir, original, 0o600)
			result, err := Uninstall(dir, Options{})
			if err != nil {
				t.Fatal(err)
			}
			if result.Changed || result.Backup != "" {
				t.Fatalf("uninstall = %+v, want exact no-op", result)
			}
			if got := loadConfig(t, dir); got != original {
				t.Fatalf("no-op uninstall changed multiline string bytes\nwant:\n%s\ngot:\n%s", original, got)
			}
		})
	}
}

func storeConfig(t *testing.T, dir, text string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ConfigFile), []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

func loadConfig(t *testing.T, dir string) string {
	t.Helper()
	return loadFile(t, filepath.Join(dir, ConfigFile))
}

func loadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func decodedGroups(t *testing.T, text, event string) []map[string]any {
	t.Helper()
	var decoded map[string]any
	if _, err := toml.Decode(text, &decoded); err != nil {
		t.Fatalf("decode installed TOML: %v\n%s", err, text)
	}
	hooks, ok := decoded["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("hooks is not a table: %#v", decoded["hooks"])
	}
	groups, ok := mapSlice(hooks[event])
	if !ok {
		t.Fatalf("hooks.%s is not an array of matcher groups: %#v", event, hooks[event])
	}
	return groups
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode(%s) = %o, want %o", path, got, want)
	}
}

func assertNoBackups(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ConfigFile+".hfg-backup-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("unexpected backups: %v", matches)
	}
}
