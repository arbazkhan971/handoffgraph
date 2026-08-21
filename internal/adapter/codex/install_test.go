package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codexhooks "github.com/handoffgraph/handoffgraph/integrations/codex"
	"github.com/handoffgraph/handoffgraph/internal/adapter"

	"github.com/BurntSushi/toml"
)

// The tests in this file pin the adapter's Install/Uninstall contract: the
// work is delegated to integrations/codex (merge-safe, marker-scoped,
// fail-closed), the adapter adds the adapter-level sentinel mapping and the
// legacy [hooks.handoffgraph] guard. Every test points ConfigDir at a
// throwaway directory; the real ~/.codex is never touched.

const testHookCommand = "/bin/hfg-hook --agent codex"

func installCodexHooks(t *testing.T, dir string) error {
	t.Helper()
	c := &Codex{ConfigDir: dir, HookCommand: testHookCommand}
	return c.Install(context.Background(), adapter.ScopeUser)
}

func readCodexConfig(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, codexhooks.ConfigFile))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	return string(data)
}

func decodeCodexConfig(t *testing.T, text string) map[string]any {
	t.Helper()
	var cfg map[string]any
	if _, err := toml.Decode(text, &cfg); err != nil {
		t.Fatalf("config is not valid TOML: %v\n%s", err, text)
	}
	return cfg
}

func TestCodexInstallFreshConfigDir(t *testing.T) {
	dir := t.TempDir()
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install: %v", err)
	}
	text := readCodexConfig(t, dir)
	if !strings.Contains(text, "# hfg:managed") {
		t.Errorf("config lacks the managed marker:\n%s", text)
	}
	cfg := decodeCodexConfig(t, text)
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("config lacks a [hooks] table:\n%s", text)
	}
	for _, event := range codexhooks.ManagedEvents {
		entry, ok := hooks[event].(map[string]any)
		if !ok {
			t.Errorf("hooks.%s missing or not a table:\n%s", event, text)
			continue
		}
		if got := entry["command"]; got != testHookCommand+" --event "+event {
			t.Errorf("hooks.%s.command = %v, want %q", event, got, testHookCommand+" --event "+event)
		}
	}
	if extra := len(hooks) - len(codexhooks.ManagedEvents); extra != 0 {
		t.Errorf("install wrote %d unexpected hook entries: %v", extra, hooks)
	}
}

func TestCodexInstallIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("first install: %v", err)
	}
	before := readCodexConfig(t, dir)
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("second install: %v", err)
	}
	if after := readCodexConfig(t, dir); after != before {
		t.Errorf("second install changed the config:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func TestCodexInstallPreservesForeignUserHooks(t *testing.T) {
	dir := t.TempDir()
	user := "model = \"gpt-5\"\n\n# user-owned notification hook\n[hooks.notify]\ncommand = \"/usr/bin/notify-send\"\n"
	if err := os.WriteFile(filepath.Join(dir, codexhooks.ConfigFile), []byte(user), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install alongside user hooks: %v", err)
	}
	text := readCodexConfig(t, dir)
	if !strings.Contains(text, "/usr/bin/notify-send") {
		t.Errorf("user hook command lost:\n%s", text)
	}
	if !strings.Contains(text, "# user-owned notification hook") {
		t.Errorf("user comment lost:\n%s", text)
	}
	cfg := decodeCodexConfig(t, text)
	if cfg["model"] != "gpt-5" {
		t.Errorf("user top-level key lost:\n%s", text)
	}
	hooks := cfg["hooks"].(map[string]any)
	if _, ok := hooks["notify"].(map[string]any); !ok {
		t.Errorf("user [hooks.notify] lost:\n%s", text)
	}
	for _, event := range codexhooks.ManagedEvents {
		if _, ok := hooks[event].(map[string]any); !ok {
			t.Errorf("managed hooks.%s missing:\n%s", event, text)
		}
	}
}

func TestCodexInstallConflictOnLegacyHandoffgraphTable(t *testing.T) {
	dir := t.TempDir()
	// A legacy v0.2-era managed table (or a user copy of one): it carries
	// no marker, so ownership cannot be proven — fail closed, touch nothing.
	legacy := "[hooks.handoffgraph]\ncommand = \"/different\"\nevents = [\"session.started\"]\n"
	path := filepath.Join(dir, codexhooks.ConfigFile)
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	err := installCodexHooks(t, dir)
	if !errors.Is(err, adapter.ErrHookConflict) {
		t.Fatalf("install error = %v, want adapter.ErrHookConflict", err)
	}
	if after, _ := os.ReadFile(path); string(after) != legacy {
		t.Errorf("config modified despite conflict:\n%s", after)
	}
}

func TestCodexInstallConflictOnUserOwnedManagedEvent(t *testing.T) {
	dir := t.TempDir()
	conflict := "[hooks.session_start]\ncommand = \"/user/owned\"\n"
	path := filepath.Join(dir, codexhooks.ConfigFile)
	if err := os.WriteFile(path, []byte(conflict), 0o600); err != nil {
		t.Fatal(err)
	}
	err := installCodexHooks(t, dir)
	if !errors.Is(err, adapter.ErrHookConflict) {
		t.Fatalf("install error = %v, want adapter.ErrHookConflict", err)
	}
	if !errors.Is(err, codexhooks.ErrHookConflict) {
		t.Errorf("install error = %v, want it to keep matching codexhooks.ErrHookConflict", err)
	}
	if after, _ := os.ReadFile(path); string(after) != conflict {
		t.Errorf("config modified despite conflict:\n%s", after)
	}
}

func TestCodexInstallUnparseableConfigUntouched(t *testing.T) {
	dir := t.TempDir()
	garbage := "[hooks\nnot = toml"
	path := filepath.Join(dir, codexhooks.ConfigFile)
	if err := os.WriteFile(path, []byte(garbage), 0o600); err != nil {
		t.Fatal(err)
	}
	err := installCodexHooks(t, dir)
	if err == nil {
		t.Fatal("install over unparseable config succeeded, want fail-closed error")
	}
	if after, _ := os.ReadFile(path); string(after) != garbage {
		t.Errorf("config modified despite unparseable input:\n%s", after)
	}
}

func TestCodexInstallDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	c := &Codex{ConfigDir: dir, HookCommand: testHookCommand, DryRun: true}
	if err := c.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("dry-run install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, codexhooks.ConfigFile)); !os.IsNotExist(err) {
		t.Errorf("dry run wrote config.toml (stat err = %v)", err)
	}
}

func TestCodexInstallDefaultHookCommandIsThisExecutable(t *testing.T) {
	dir := t.TempDir()
	c := &Codex{ConfigDir: dir}
	if err := c.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("install with default hook command: %v", err)
	}
	cfg := decodeCodexConfig(t, readCodexConfig(t, dir))
	entry := cfg["hooks"].(map[string]any)["session_start"].(map[string]any)
	cmd, _ := entry["command"].(string)
	if cmd == "" || !strings.HasSuffix(cmd, " --event session_start") {
		t.Errorf("hooks.session_start.command = %q, want <executable> --event session_start", cmd)
	}
}

func TestCodexInstallLegacyStubMarkerIsInert(t *testing.T) {
	dir := t.TempDir()
	// Config written by the v0.2 stub: a bare [hooks] table with inert
	// marker comments. It must neither conflict with nor block the
	// merge-safe installer, and it must survive unmodified.
	stubForm := "[hooks]\n# managed-by: handoffgraph\n# HandoffGraph session/tool lifecycle hooks (v0.2 stub)\n"
	if err := os.WriteFile(filepath.Join(dir, codexhooks.ConfigFile), []byte(stubForm), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install over stub-era comments: %v", err)
	}
	text := readCodexConfig(t, dir)
	if !strings.Contains(text, "# managed-by: handoffgraph") {
		t.Errorf("stub-era comment lost (must be preserved verbatim):\n%s", text)
	}
	cfg := decodeCodexConfig(t, text)
	if _, ok := cfg["hooks"].(map[string]any)["session_start"].(map[string]any); !ok {
		t.Errorf("managed entry missing alongside stub comments:\n%s", text)
	}
}

func TestCodexInstallProjectScopeUnsupported(t *testing.T) {
	c := &Codex{ConfigDir: t.TempDir()}
	if err := c.Install(context.Background(), adapter.ScopeProject); !errors.Is(err, adapter.ErrUnsupported) {
		t.Fatalf("project scope error = %v, want adapter.ErrUnsupported", err)
	}
}

func TestCodexUninstallRemovesOnlyManagedEntries(t *testing.T) {
	dir := t.TempDir()
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install: %v", err)
	}
	// A user-owned hook added after install must survive uninstall.
	path := filepath.Join(dir, codexhooks.ConfigFile)
	withUser := readCodexConfig(t, dir) + "\n[hooks.notify]\ncommand = \"/usr/bin/notify-send\"\n"
	if err := os.WriteFile(path, []byte(withUser), 0o600); err != nil {
		t.Fatal(err)
	}

	c := &Codex{ConfigDir: dir}
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	text := readCodexConfig(t, dir)
	if strings.Contains(text, "# hfg:managed") {
		t.Errorf("managed marker survived uninstall:\n%s", text)
	}
	cfg := decodeCodexConfig(t, text)
	hooks, _ := cfg["hooks"].(map[string]any)
	for _, event := range codexhooks.ManagedEvents {
		if _, ok := hooks[event]; ok {
			t.Errorf("managed hooks.%s survived uninstall:\n%s", event, text)
		}
	}
	if entry, ok := hooks["notify"].(map[string]any); !ok || entry["command"] != "/usr/bin/notify-send" {
		t.Errorf("user [hooks.notify] lost:\n%s", text)
	}
}

func TestCodexUninstallMissingFileIsNoop(t *testing.T) {
	c := &Codex{ConfigDir: t.TempDir()}
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("uninstall without config: %v", err)
	}
}

func TestCodexUninstallIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install: %v", err)
	}
	c := &Codex{ConfigDir: dir}
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("first uninstall: %v", err)
	}
	after := readCodexConfig(t, dir)
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("second uninstall: %v", err)
	}
	if again := readCodexConfig(t, dir); again != after {
		t.Errorf("second uninstall changed the config:\nbefore:\n%s\nafter:\n%s", after, again)
	}
}

func TestCodexUninstallDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install: %v", err)
	}
	before := readCodexConfig(t, dir)
	c := &Codex{ConfigDir: dir, DryRun: true}
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("dry-run uninstall: %v", err)
	}
	if after := readCodexConfig(t, dir); after != before {
		t.Errorf("dry-run uninstall modified the config:\n%s", after)
	}
}
