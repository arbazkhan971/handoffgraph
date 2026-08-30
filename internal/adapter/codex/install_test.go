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

func codexMatcherGroups(t *testing.T, hooks map[string]any, event string) []map[string]any {
	t.Helper()
	raw, ok := hooks[event]
	if !ok {
		t.Fatalf("hooks.%s is missing: %v", event, hooks)
	}
	switch groups := raw.(type) {
	case []map[string]any:
		return groups
	case []any:
		out := make([]map[string]any, 0, len(groups))
		for i, rawGroup := range groups {
			group, ok := rawGroup.(map[string]any)
			if !ok {
				t.Fatalf("hooks.%s[%d] = %T, want matcher group", event, i, rawGroup)
			}
			out = append(out, group)
		}
		return out
	default:
		t.Fatalf("hooks.%s = %T, want matcher-group array", event, raw)
		return nil
	}
}

func codexMatcherCommand(t *testing.T, event string, group map[string]any) string {
	t.Helper()
	rawHandlers, ok := group["hooks"]
	if !ok {
		t.Fatalf("hooks.%s matcher group lacks handlers: %v", event, group)
	}
	var handlers []map[string]any
	switch raw := rawHandlers.(type) {
	case []map[string]any:
		handlers = raw
	case []any:
		for i, rawHandler := range raw {
			handler, ok := rawHandler.(map[string]any)
			if !ok {
				t.Fatalf("hooks.%s handler %d = %T, want table", event, i, rawHandler)
			}
			handlers = append(handlers, handler)
		}
	default:
		t.Fatalf("hooks.%s handlers = %T, want array", event, rawHandlers)
	}
	if len(handlers) != 1 || handlers[0]["type"] != "command" {
		t.Fatalf("hooks.%s handlers = %v, want one command handler", event, handlers)
	}
	command, ok := handlers[0]["command"].(string)
	if !ok {
		t.Fatalf("hooks.%s command = %T, want string", event, handlers[0]["command"])
	}
	return command
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
		groups := codexMatcherGroups(t, hooks, event)
		if len(groups) != 1 {
			t.Errorf("hooks.%s groups = %d, want one managed matcher group", event, len(groups))
			continue
		}
		if got := codexMatcherCommand(t, event, groups[0]); got != testHookCommand {
			t.Errorf("hooks.%s command = %q, want exact handler %q", event, got, testHookCommand)
		}
	}
	if extra := len(hooks) - len(codexhooks.ManagedEvents); extra != 0 {
		t.Errorf("install wrote %d unexpected hook entries: %v", extra, hooks)
	}
}

func TestCodexLegacyGuardRefusesNonRegularConfigBeforeRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, codexhooks.ConfigFile)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := refuseLegacyHooksTable(dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("legacy guard error = %v, want non-regular-file refusal", err)
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

func TestCodexInstallPreservesAndAppendsToUserMatcherGroups(t *testing.T) {
	dir := t.TempDir()
	user := "model = \"gpt-5\"\n\n# user-owned pre-tool matcher\n[hooks]\nPreToolUse = [{ matcher = \"Bash\", hooks = [{ type = \"command\", command = \"/usr/bin/notify-send\" }] }]\n"
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
	if !strings.Contains(text, "# user-owned pre-tool matcher") {
		t.Errorf("user comment lost:\n%s", text)
	}
	cfg := decodeCodexConfig(t, text)
	if cfg["model"] != "gpt-5" {
		t.Errorf("user top-level key lost:\n%s", text)
	}
	hooks := cfg["hooks"].(map[string]any)
	for _, event := range codexhooks.ManagedEvents {
		groups := codexMatcherGroups(t, hooks, event)
		want := 1
		if event == "PreToolUse" {
			want = 2
			if groups[0]["matcher"] != "Bash" || codexMatcherCommand(t, event, groups[0]) != "/usr/bin/notify-send" {
				t.Errorf("user hooks.%s matcher moved or changed: %v", event, groups[0])
			}
		}
		if len(groups) != want {
			t.Errorf("hooks.%s groups = %d, want %d", event, len(groups), want)
		}
		if got := codexMatcherCommand(t, event, groups[len(groups)-1]); got != testHookCommand {
			t.Errorf("managed hooks.%s command = %q, want %q", event, got, testHookCommand)
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

func TestCodexInstallConflictOnUnmarkedExactCommandCollision(t *testing.T) {
	dir := t.TempDir()
	conflict := "[hooks]\nPreToolUse = [{ matcher = \"\", hooks = [{ type = \"command\", command = \"" + testHookCommand + "\" }] }]\n"
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
	hooks := cfg["hooks"].(map[string]any)
	groups := codexMatcherGroups(t, hooks, "SessionStart")
	cmd := codexMatcherCommand(t, "SessionStart", groups[len(groups)-1])
	if cmd == "" || !strings.HasSuffix(cmd, " hook codex") || strings.Contains(cmd, "--event") {
		t.Errorf("hooks.SessionStart command = %q, want exact <executable> hook codex", cmd)
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
	codexMatcherGroups(t, cfg["hooks"].(map[string]any), "SessionStart")
}

func TestCodexInstallProjectScopeUnsupported(t *testing.T) {
	c := &Codex{ConfigDir: t.TempDir()}
	if err := c.Install(context.Background(), adapter.ScopeProject); !errors.Is(err, adapter.ErrUnsupported) {
		t.Fatalf("project scope error = %v, want adapter.ErrUnsupported", err)
	}
}

func TestCodexUninstallRemovesOnlyManagedEntries(t *testing.T) {
	dir := t.TempDir()
	user := "model = \"gpt-5\"\n\n# user bytes must round-trip exactly\n[hooks]\nPreToolUse = [{ matcher = \"Bash\", hooks = [{ type = \"command\", command = \"/usr/bin/notify-send\" }] }]\n"
	path := filepath.Join(dir, codexhooks.ConfigFile)
	if err := os.WriteFile(path, []byte(user), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installCodexHooks(t, dir); err != nil {
		t.Fatalf("install: %v", err)
	}

	c := &Codex{ConfigDir: dir}
	if err := c.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	text := readCodexConfig(t, dir)
	if strings.Contains(text, "# hfg:managed") {
		t.Errorf("managed marker survived uninstall:\n%s", text)
	}
	if text != user {
		t.Errorf("uninstall did not restore user bytes exactly:\nwant:\n%s\ngot:\n%s", user, text)
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
