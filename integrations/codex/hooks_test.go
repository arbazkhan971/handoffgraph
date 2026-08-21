package codexhooks

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/BurntSushi/toml"
)

const testCommand = "handoffgraph hook --agent codex"

// fixedTime gives every backup a deterministic timestamp in tests.
var fixedTime, _ = time.Parse(time.RFC3339, "2026-08-22T10:00:00Z")

func fixedNow() time.Time { return fixedTime }

func testOptions() Options {
	return Options{Command: testCommand, Now: fixedNow}
}

func writeConfig(t *testing.T, dir, text string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ConfigFile)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readConfig(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func mustParse(t *testing.T, text string) map[string]any {
	t.Helper()
	var cfg map[string]any
	if _, err := toml.Decode(text, &cfg); err != nil {
		t.Fatalf("resulting config does not parse: %v\nconfig:\n%s", err, text)
	}
	return cfg
}

func hookCommand(t *testing.T, cfg map[string]any, event string) string {
	t.Helper()
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("no [hooks] table in %+v", cfg)
	}
	entry, ok := hooks[event].(map[string]any)
	if !ok {
		t.Fatalf("no [hooks.%s] entry", event)
	}
	cmd, _ := entry["command"].(string)
	return cmd
}

// isSubsequence reports whether every line of want appears in got in order:
// the merge may add lines but must never drop or reorder user lines.
func isSubsequence(want, got []string) bool {
	i := 0
	for _, line := range got {
		if i < len(want) && line == want[i] {
			i++
		}
	}
	return i == len(want)
}

func TestManagedEventsSortedAndPinned(t *testing.T) {
	want := []string{
		"post_tool_use", "pre_tool_use",
		"session_end", "session_start",
		"turn_end", "turn_start",
	}
	if !sort.StringsAreSorted(ManagedEvents) {
		t.Fatalf("ManagedEvents not sorted: %v", ManagedEvents)
	}
	if strings.Join(ManagedEvents, ",") != strings.Join(want, ",") {
		t.Fatalf("ManagedEvents = %v, want %v", ManagedEvents, want)
	}
}

func TestInstallFreshDir(t *testing.T) {
	dir := t.TempDir()
	res, err := Install(dir, testOptions())
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !res.Changed {
		t.Fatal("fresh install must report Changed=true")
	}
	if res.Backup != "" {
		t.Fatalf("fresh install must not create a backup, got %q", res.Backup)
	}
	if strings.Join(res.Entries, ",") != strings.Join(ManagedEvents, ",") {
		t.Fatalf("Entries = %v, want %v", res.Entries, ManagedEvents)
	}

	text := readConfig(t, filepath.Join(dir, ConfigFile))
	cfg := mustParse(t, text)
	for _, event := range ManagedEvents {
		if got := hookCommand(t, cfg, event); got != testCommand+" --event "+event {
			t.Fatalf("hooks.%s.command = %q", event, got)
		}
	}
	if !strings.Contains(text, marker) {
		t.Fatal("installed entries must carry the hfg marker comment")
	}
}

func TestInstallIdempotentSecondRunChangesNothing(t *testing.T) {
	dir := t.TempDir()
	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatal(err)
	}
	first := readConfig(t, filepath.Join(dir, ConfigFile))

	res, err := Install(dir, testOptions())
	if err != nil {
		t.Fatalf("second Install: %v", err)
	}
	if res.Changed {
		t.Fatal("duplicate install must be a no-op (Changed=false)")
	}
	if res.Backup != "" {
		t.Fatal("duplicate install must not write a backup")
	}
	if second := readConfig(t, filepath.Join(dir, ConfigFile)); second != first {
		t.Fatalf("duplicate install changed the file:\nfirst:\n%s\nsecond:\n%s", first, second)
	}

	// No stray backup files either.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("config dir has %d entries after idempotent install, want 1: %v", len(entries), entries)
	}
}

func TestInstallMergesWithExistingUserHooks(t *testing.T) {
	userConfig := `# my codex config — do not touch
model = "gpt-5-codex"
approval_mode = "auto"

[hooks.user_notifier]
command = "notify-send codex"

[mcp_servers.weather]
url = "https://example.com/mcp"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	res, err := Install(dir, testOptions())
	if err != nil {
		t.Fatalf("Install over user config: %v", err)
	}
	if !res.Changed {
		t.Fatal("merge must change the file")
	}
	if res.Backup == "" {
		t.Fatal("modifying an existing config must create a backup")
	}
	if got := readConfig(t, res.Backup); got != userConfig {
		t.Fatal("backup must contain the original bytes")
	}

	after := readConfig(t, path)
	cfg := mustParse(t, after)

	// Every user line survives, in order.
	if !isSubsequence(strings.Split(strings.TrimSuffix(userConfig, "\n"), "\n"), strings.Split(strings.TrimSuffix(after, "\n"), "\n")) {
		t.Fatalf("user lines were dropped or reordered:\n%s", after)
	}
	// User entries are intact and untouched.
	if got := hookCommand(t, cfg, "user_notifier"); got != "notify-send codex" {
		t.Fatalf("user hook command rewritten: %q", got)
	}
	if model, _ := cfg["model"].(string); model != "gpt-5-codex" {
		t.Fatalf("user top-level key lost: %q", model)
	}
	servers, ok := cfg["mcp_servers"].(map[string]any)
	if !ok || len(servers) != 1 {
		t.Fatalf("user mcp_servers table lost: %+v", cfg["mcp_servers"])
	}
	// Our entries merged alongside the user's.
	for _, event := range ManagedEvents {
		if got := hookCommand(t, cfg, event); got != testCommand+" --event "+event {
			t.Fatalf("hooks.%s.command = %q", event, got)
		}
	}
}

func TestInstallInsideBareHooksSection(t *testing.T) {
	userConfig := `[hooks]
user_notifier = { command = "notify-send codex" }
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatalf("Install: %v", err)
	}
	after := readConfig(t, path)
	cfg := mustParse(t, after)
	hooks := cfg["hooks"].(map[string]any)
	if _, ok := hooks["user_notifier"]; !ok {
		t.Fatalf("bare-section user key lost:\n%s", after)
	}
	for _, event := range ManagedEvents {
		if got := hookCommand(t, cfg, event); got != testCommand+" --event "+event {
			t.Fatalf("hooks.%s.command = %q", event, got)
		}
	}
}

func TestInstallFailsClosedOnUserCollision(t *testing.T) {
	userConfig := `[hooks.session_start]
command = "echo my own session hook"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	res, err := Install(dir, testOptions())
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("Install error = %v, want ErrHookConflict", err)
	}
	if res != nil {
		t.Fatalf("conflict must return a nil result, got %+v", res)
	}
	if got := readConfig(t, path); got != userConfig {
		t.Fatalf("conflict must leave the file untouched:\n%s", got)
	}
	if _, err := os.Stat(path + "." + backupPrefix); !os.IsNotExist(err) {
		t.Fatal("conflict must not leave a backup")
	}
}

func TestInstallFailsClosedOnDottedCollision(t *testing.T) {
	userConfig := `hooks.turn_start.command = "echo mine"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	if _, err := Install(dir, testOptions()); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("Install error = %v, want ErrHookConflict", err)
	}
	if got := readConfig(t, path); got != userConfig {
		t.Fatalf("conflict must leave the file untouched:\n%s", got)
	}
}

func TestInstallFailsClosedOnNonTableHooks(t *testing.T) {
	userConfig := `hooks = "not a table"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	if _, err := Install(dir, testOptions()); !errors.Is(err, ErrHookConflict) {
		t.Fatalf("Install error = %v, want ErrHookConflict", err)
	}
	if got := readConfig(t, path); got != userConfig {
		t.Fatalf("conflict must leave the file untouched:\n%s", got)
	}
}

func TestInstallFailsClosedOnUnparseableConfig(t *testing.T) {
	dir := t.TempDir()
	garbage := "model = [unclosed"
	path := writeConfig(t, dir, garbage)

	if _, err := Install(dir, testOptions()); err == nil {
		t.Fatal("unparseable config must fail, not be rewritten")
	}
	if got := readConfig(t, path); got != garbage {
		t.Fatalf("unparseable config must be left untouched:\n%s", got)
	}
}

func TestInstallDryRunWritesNothing(t *testing.T) {
	userConfig := `model = "gpt-5-codex"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	res, err := Install(dir, Options{Command: testCommand, DryRun: true, Now: fixedNow})
	if err != nil {
		t.Fatalf("dry-run Install: %v", err)
	}
	if !res.Changed {
		t.Fatal("dry run over a fresh config must report would-change")
	}
	if got := readConfig(t, path); got != userConfig {
		t.Fatalf("dry run must not modify the file:\n%s", got)
	}
	if res.Backup != "" {
		t.Fatal("dry run must not report a backup")
	}
	if _, err := os.Stat(filepath.Join(dir, ConfigFile+"."+backupPrefix)); err == nil {
		t.Fatal("dry run must not write a backup")
	}
}

func TestInstallReassertsDriftedManagedEntry(t *testing.T) {
	dir := t.TempDir()
	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ConfigFile)

	// Simulate a manual edit inside our marked block.
	edited := strings.Replace(readConfig(t, path),
		testCommand+" --event session_start", "echo user override", 1)
	if edited == readConfig(t, path) {
		t.Fatal("test setup failed to edit the managed command")
	}
	if err := os.WriteFile(path, []byte(edited), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := Install(dir, testOptions())
	if err != nil {
		t.Fatalf("Install over drifted managed entry: %v", err)
	}
	if !res.Changed {
		t.Fatal("drifted managed entry must be re-asserted (Changed=true)")
	}
	cfg := mustParse(t, readConfig(t, path))
	if got := hookCommand(t, cfg, "session_start"); got != testCommand+" --event session_start" {
		t.Fatalf("drifted entry not restored: %q", got)
	}
}

func TestInstallBackupTimestampAndCollisions(t *testing.T) {
	dir := t.TempDir()
	userConfig := "model = \"gpt-5-codex\"\n"
	writeConfig(t, dir, userConfig)

	res, err := Install(dir, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, ConfigFile+".hfg-backup-20260822T100000Z")
	if res.Backup != want {
		t.Fatalf("Backup = %q, want %q", res.Backup, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("backup file missing: %v", err)
	}

	// Force a same-timestamp second backup by drifting the managed entry.
	path := filepath.Join(dir, ConfigFile)
	edited := strings.Replace(readConfig(t, path), testCommand+" --event turn_start", "echo drift", 1)
	if edited == readConfig(t, path) {
		t.Fatal("test setup failed to drift the managed command")
	}
	if err := os.WriteFile(path, []byte(edited), 0o600); err != nil {
		t.Fatal(err)
	}
	res2, err := Install(dir, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if want2 := want + "-2"; res2.Backup != want2 {
		t.Fatalf("second Backup = %q, want %q", res2.Backup, want2)
	}
}

func TestInstallPreservesFileMode(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "model = \"gpt-5-codex\"\n")
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("file mode = %v, want 0644", info.Mode().Perm())
	}
}

func TestInstallRefusesSymlinkedConfig(t *testing.T) {
	dir := t.TempDir()
	real := writeConfig(t, dir, "model = \"gpt-5-codex\"\n")
	linkDir := t.TempDir()
	link := filepath.Join(linkDir, ConfigFile)
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := Install(linkDir, testOptions()); err == nil {
		t.Fatal("install through a symlinked config must be refused")
	}
	if got := readConfig(t, real); got != "model = \"gpt-5-codex\"\n" {
		t.Fatalf("symlink target was modified:\n%s", got)
	}
}

func TestInstallValidationErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Install("", testOptions()); err == nil {
		t.Fatal("empty config dir must fail")
	}
	if _, err := Install(dir, Options{Command: "", Now: fixedNow}); err == nil {
		t.Fatal("empty hook command must fail")
	}
}

func TestUninstallRemovesOnlyManagedEntries(t *testing.T) {
	userOnly := `# my codex config
model = "gpt-5-codex"

[hooks.user_notifier]
command = "notify-send codex"

[mcp_servers.weather]
url = "https://example.com/mcp"
`
	dir := t.TempDir()
	writeConfig(t, dir, userOnly)
	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatalf("Install: %v", err)
	}
	path := filepath.Join(dir, ConfigFile)
	installed := readConfig(t, path)
	if installed == userOnly {
		t.Fatal("test setup: install did not change the file")
	}

	res, err := Uninstall(dir, Options{Now: fixedNow})
	if err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if !res.Changed {
		t.Fatal("uninstall after install must change the file")
	}
	if got := readConfig(t, path); got != userOnly {
		t.Fatalf("uninstall must restore the user config exactly:\ngot:\n%s\nwant:\n%s", got, userOnly)
	}
	mustParse(t, readConfig(t, path))
}

func TestUninstallAfterManualEditStillRemovesManagedEntry(t *testing.T) {
	dir := t.TempDir()
	userConfig := `model = "gpt-5-codex"

[hooks.user_notifier]
command = "notify-send codex"
`
	writeConfig(t, dir, userConfig)
	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ConfigFile)

	// Manual edits inside our marked block (marker retained).
	text := readConfig(t, path)
	text = strings.Replace(text, testCommand+" --event post_tool_use", "echo user override", 1)
	text = strings.Replace(text, marker+"", marker+"\n# user note inside the managed block", 1)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Uninstall(dir, Options{Now: fixedNow}); err != nil {
		t.Fatalf("Uninstall after manual edits: %v", err)
	}
	after := readConfig(t, path)
	if strings.Contains(after, "hfg:managed") || strings.Contains(after, "user override") {
		t.Fatalf("marker-carrying entry must be removed even after manual edits:\n%s", after)
	}
	if !strings.Contains(after, "notify-send codex") || !strings.Contains(after, "gpt-5-codex") {
		t.Fatalf("user entries must survive:\n%s", after)
	}
	mustParse(t, after)
}

func TestUninstallRemovesManagedEventNotInCurrentSet(t *testing.T) {
	// An entry installed by an older HandoffGraph version (marker present,
	// event name no longer managed) must still be removed on uninstall.
	config := `model = "gpt-5-codex"

# hfg:managed
[hooks.legacy_hook]
command = "handoffgraph hook --agent codex --event legacy_hook"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, config)

	res, err := Uninstall(dir, Options{Now: fixedNow})
	if err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if !res.Changed {
		t.Fatal("legacy managed entry must be removed")
	}
	after := readConfig(t, path)
	if strings.Contains(after, "legacy_hook") || strings.Contains(after, "hfg:managed") {
		t.Fatalf("legacy managed entry survived:\n%s", after)
	}
	if !strings.Contains(after, "model = \"gpt-5-codex\"") {
		t.Fatalf("user keys lost:\n%s", after)
	}
}

func TestUninstallNoopCases(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		res, err := Uninstall(t.TempDir(), Options{Now: fixedNow})
		if err != nil || res.Changed {
			t.Fatalf("missing config must be a no-op, got (%v, %+v)", err, res)
		}
	})
	t.Run("no managed entries", func(t *testing.T) {
		userConfig := `[hooks.user_notifier]
command = "notify-send codex"
`
		dir := t.TempDir()
		path := writeConfig(t, dir, userConfig)
		res, err := Uninstall(dir, Options{Now: fixedNow})
		if err != nil || res.Changed {
			t.Fatalf("user-only config must be a no-op, got (%v, %+v)", err, res)
		}
		if got := readConfig(t, path); got != userConfig {
			t.Fatalf("no-op uninstall modified the file:\n%s", got)
		}
	})
	t.Run("dry run changes nothing", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := Install(dir, testOptions()); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, ConfigFile)
		before := readConfig(t, path)
		res, err := Uninstall(dir, Options{DryRun: true, Now: fixedNow})
		if err != nil || !res.Changed {
			t.Fatalf("dry-run uninstall = (%v, %+v), want (nil, Changed=true)", err, res)
		}
		if got := readConfig(t, path); got != before {
			t.Fatal("dry-run uninstall must not modify the file")
		}
	})
}

func TestUninstallFailsClosed(t *testing.T) {
	t.Run("unparseable config", func(t *testing.T) {
		dir := t.TempDir()
		garbage := "[hooks"
		path := writeConfig(t, dir, garbage)
		if _, err := Uninstall(dir, Options{Now: fixedNow}); err == nil {
			t.Fatal("unparseable config must fail uninstall")
		}
		if got := readConfig(t, path); got != garbage {
			t.Fatalf("file must be untouched:\n%s", got)
		}
	})
	t.Run("non-table hooks entry", func(t *testing.T) {
		dir := t.TempDir()
		path := writeConfig(t, dir, "hooks = \"nope\"\n")
		if _, err := Uninstall(dir, Options{Now: fixedNow}); !errors.Is(err, ErrHookConflict) {
			t.Fatalf("error = %v, want ErrHookConflict", err)
		}
		if got := readConfig(t, path); got != "hooks = \"nope\"\n" {
			t.Fatalf("file must be untouched:\n%s", got)
		}
	})
	t.Run("symlinked config", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := Install(dir, testOptions()); err != nil {
			t.Fatal(err)
		}
		linkDir := t.TempDir()
		if err := os.Symlink(filepath.Join(dir, ConfigFile), filepath.Join(linkDir, ConfigFile)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if _, err := Uninstall(linkDir, Options{Now: fixedNow}); err == nil {
			t.Fatal("uninstall through a symlinked config must be refused")
		}
	})
	t.Run("empty config dir", func(t *testing.T) {
		if _, err := Uninstall("", Options{Now: fixedNow}); err == nil {
			t.Fatal("empty config dir must fail")
		}
	})
}

func TestInstallUninstallRoundTripPreservesUserBytes(t *testing.T) {
	userConfig := `# leading comment
model = "o4-mini"

[profiles.fast]
model = "gpt-5-codex"

[hooks.my_hook]
command = "echo mine"
timeout_ms = 500

[[projects]]
path = "/repo/a"
trust = "trusted"
`
	dir := t.TempDir()
	path := writeConfig(t, dir, userConfig)

	if _, err := Install(dir, testOptions()); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := Uninstall(dir, Options{Now: fixedNow}); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if got := readConfig(t, path); got != userConfig {
		t.Fatalf("round trip must restore the user config byte-for-byte:\ngot:\n%q\nwant:\n%q", got, userConfig)
	}
}

func TestScanManagedBlocksFindsOnlyMarkedEntries(t *testing.T) {
	lines := strings.Split(strings.TrimSuffix(`# hfg:managed
[hooks.session_start]
command = "ours"

[hooks.user_hook]
command = "theirs"

[hooks.turn_end] # hfg:managed
command = "ours trailing"
`, "\n"), "\n")

	blocks := scanManagedBlocks(lines)
	var events []string
	for _, b := range blocks {
		events = append(events, b.event)
	}
	sort.Strings(events)
	want := []string{"session_start", "turn_end"}
	if strings.Join(events, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v, want %v", events, want)
	}
	for _, b := range blocks {
		if b.event == "session_start" {
			if b.command != "ours" {
				t.Fatalf("session_start command = %q", b.command)
			}
		}
		if b.event == "turn_end" {
			if b.command != "ours trailing" {
				t.Fatalf("turn_end command = %q", b.command)
			}
		}
	}
}
