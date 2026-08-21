package codex

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
)

// wantHookEvents is the pinned, sorted hook event list that hooks.go must
// manage in the Codex config.
var wantHookEvents = []string{
	"assistant.completed",
	"command.completed",
	"prompt.submitted",
	"session.ended",
	"session.started",
	"tool.completed",
}

// hookOpts returns InstallOptions pointing at dir with the given command.
func hookOpts(dir, cmd string, dryRun bool) adapter.InstallOptions {
	return adapter.InstallOptions{
		ConfigDir:   dir,
		HookCommand: cmd,
		DryRun:      dryRun,
	}
}

// configBytes reads <dir>/config.toml, failing the test if it is missing.
func configBytes(t *testing.T, dir string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatalf("read config.toml: %v", err)
	}
	return data
}

// writeConfig writes data to <dir>/config.toml.
func writeConfig(t *testing.T, dir string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// bytesEqual reports whether two config snapshots are byte-for-byte equal.
func bytesEqual(a, b []byte) bool { return bytes.Equal(a, b) }

// decodeManagedHook decodes only the [hooks.handoffgraph] table from the config.
func decodeManagedHook(t *testing.T, dir string) (command string, events []string) {
	t.Helper()
	var cfg struct {
		Hooks struct {
			Handoffgraph *struct {
				Command string   `toml:"command"`
				Events  []string `toml:"events"`
			} `toml:"handoffgraph"`
		} `toml:"hooks"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), &cfg); err != nil {
		t.Fatalf("decode config.toml: %v", err)
	}
	if cfg.Hooks.Handoffgraph == nil {
		return "", nil
	}
	return cfg.Hooks.Handoffgraph.Command, cfg.Hooks.Handoffgraph.Events
}

func TestHookEventsSortedAndPinned(t *testing.T) {
	if !sort.StringsAreSorted(HookEvents) {
		t.Errorf("HookEvents not sorted: %v", HookEvents)
	}
	if !reflect.DeepEqual(HookEvents, wantHookEvents) {
		t.Errorf("HookEvents = %v, want %v", HookEvents, wantHookEvents)
	}
}

func TestInstallFreshDir(t *testing.T) {
	dir := t.TempDir()
	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err != nil {
		t.Fatalf("installHooks() error = %v", err)
	}

	cmd, events := decodeManagedHook(t, dir)
	if cmd != "hfg hook" {
		t.Errorf("managed command = %q, want %q", cmd, "hfg hook")
	}
	if !reflect.DeepEqual(events, wantHookEvents) {
		t.Errorf("managed events = %v, want %v", events, wantHookEvents)
	}

	info, err := os.Stat(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 && perm != 0o400 {
		t.Errorf("config.toml mode = %v, want 0600 or stricter", info.Mode().Perm())
	}
}

func TestInstallIdempotent(t *testing.T) {
	dir := t.TempDir()
	opts := hookOpts(dir, "hfg hook", false)
	if err := installHooks(dir, opts); err != nil {
		t.Fatalf("first installHooks() error = %v", err)
	}
	before := configBytes(t, dir)
	if err := installHooks(dir, opts); err != nil {
		t.Fatalf("second installHooks() error = %v", err)
	}
	after := configBytes(t, dir)
	if !bytesEqual(before, after) {
		t.Error("second identical install rewrote config.toml")
	}
}

func TestInstallConflict(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config string
	}{
		{
			name: "different command",
			config: "[hooks.handoffgraph]\n" +
				"command = \"other-tool\"\n" +
				"events = [\"session.started\", \"session.ended\"]\n",
		},
		{
			name: "same command but different events",
			config: "[hooks.handoffgraph]\n" +
				"command = \"hfg hook\"\n" +
				"events = [\"session.started\"]\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeConfig(t, dir, []byte(tc.config))

			if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); !errors.Is(err, adapter.ErrHookConflict) {
				t.Fatalf("installHooks() error = %v, want ErrHookConflict", err)
			}
			if got := configBytes(t, dir); !bytesEqual(got, []byte(tc.config)) {
				t.Errorf("conflicting install modified config.toml:\n%s", got)
			}
		})
	}
}

func TestInstallPreservesUnrelatedKeys(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, []byte(`model = "o4-mini"

[hooks.notify]
type = "other"
command = "notify-send"
mode = "loud"

[profiles.default]
model_reasoning_effort = "high"
`))

	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err != nil {
		t.Fatalf("installHooks() error = %v", err)
	}

	var cfg struct {
		Model string `toml:"model"`
		Hooks *struct {
			Notify *struct {
				Type    string `toml:"type"`
				Command string `toml:"command"`
				Mode    string `toml:"mode"`
			} `toml:"notify"`
		} `toml:"hooks"`
		Profiles *struct {
			Default *struct {
				ModelReasoningEffort string `toml:"model_reasoning_effort"`
			} `toml:"default"`
		} `toml:"profiles"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), &cfg); err != nil {
		t.Fatalf("post-install config.toml no longer parses: %v", err)
	}
	if cfg.Model != "o4-mini" {
		t.Errorf("model = %q, want %q", cfg.Model, "o4-mini")
	}
	if cfg.Hooks == nil || cfg.Hooks.Notify == nil ||
		cfg.Hooks.Notify.Type != "other" ||
		cfg.Hooks.Notify.Command != "notify-send" ||
		cfg.Hooks.Notify.Mode != "loud" {
		t.Errorf("[hooks.notify] = %+v, want preserved", cfg.Hooks)
	}
	if cfg.Profiles == nil || cfg.Profiles.Default == nil || cfg.Profiles.Default.ModelReasoningEffort != "high" {
		t.Errorf("[profiles.default] = %+v, want preserved", cfg.Profiles)
	}

	cmd, events := decodeManagedHook(t, dir)
	if cmd != "hfg hook" || !reflect.DeepEqual(events, wantHookEvents) {
		t.Errorf("managed hook = %q %v, want installed alongside preserved keys", cmd, events)
	}
}

// A [[hooks]] array of tables cannot coexist with a [hooks.handoffgraph]
// table in valid TOML without nesting into the user's array entries, so
// install must fail closed (ErrHookConflict) instead of rewriting them.
func TestInstallFailsClosedOnUserHooksArray(t *testing.T) {
	dir := t.TempDir()
	const seeded = "[[hooks]]\ntype = \"other\"\ncommand = \"notify-send\"\n"
	writeConfig(t, dir, []byte(seeded))

	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); !errors.Is(err, adapter.ErrHookConflict) {
		t.Fatalf("installHooks() error = %v, want ErrHookConflict", err)
	}
	if got := configBytes(t, dir); !bytesEqual(got, []byte(seeded)) {
		t.Errorf("failed install modified user hooks array:\n%s", got)
	}
}

func TestInstallDryRun(t *testing.T) {
	t.Run("fresh dir writes nothing", func(t *testing.T) {
		dir := t.TempDir()
		if err := installHooks(dir, hookOpts(dir, "hfg hook", true)); err != nil {
			t.Fatalf("dry-run installHooks() error = %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "config.toml")); !os.IsNotExist(err) {
			t.Errorf("dry run created config.toml (stat err = %v)", err)
		}
	})

	t.Run("conflict still detected", func(t *testing.T) {
		dir := t.TempDir()
		writeConfig(t, dir, []byte("[hooks.handoffgraph]\ncommand = \"someone-else\"\nevents = []\n"))

		if err := installHooks(dir, hookOpts(dir, "hfg hook", true)); !errors.Is(err, adapter.ErrHookConflict) {
			t.Fatalf("dry-run installHooks() error = %v, want ErrHookConflict", err)
		}
		if got := configBytes(t, dir); !bytesEqual(got, []byte("[hooks.handoffgraph]\ncommand = \"someone-else\"\nevents = []\n")) {
			t.Errorf("dry run modified config.toml:\n%s", got)
		}
	})
}

func TestInstallValidationErrors(t *testing.T) {
	t.Run("empty HookCommand", func(t *testing.T) {
		dir := t.TempDir()
		if err := installHooks(dir, hookOpts(dir, "", false)); err == nil {
			t.Fatal("installHooks() with empty HookCommand = nil, want error")
		}
	})

	t.Run("empty configDir", func(t *testing.T) {
		if err := installHooks("", hookOpts(t.TempDir(), "hfg hook", false)); err == nil {
			t.Fatal("installHooks(\"\") = nil, want error")
		}
	})
}

func TestUninstallLifecycle(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, []byte("model = \"o4-mini\"\n\n[hooks.other]\nmode = \"loud\"\n"))

	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err != nil {
		t.Fatalf("installHooks() error = %v", err)
	}
	if err := uninstallHooks(dir); err != nil {
		t.Fatalf("uninstallHooks() error = %v", err)
	}

	if cmd, events := decodeManagedHook(t, dir); cmd != "" || events != nil {
		t.Errorf("managed hook survived uninstall: %q %v", cmd, events)
	}

	var cfg struct {
		Model string `toml:"model"`
		Hooks *struct {
			Other *struct {
				Mode string `toml:"mode"`
			} `toml:"other"`
		} `toml:"hooks"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), &cfg); err != nil {
		t.Fatalf("post-uninstall config.toml no longer parses: %v", err)
	}
	if cfg.Model != "o4-mini" {
		t.Errorf("model = %q, want %q", cfg.Model, "o4-mini")
	}
	if cfg.Hooks == nil || cfg.Hooks.Other == nil || cfg.Hooks.Other.Mode != "loud" {
		t.Errorf("[hooks.other] = %+v, want preserved", cfg.Hooks)
	}

	// Second uninstall must stay a no-op.
	if err := uninstallHooks(dir); err != nil {
		t.Fatalf("second uninstallHooks() error = %v", err)
	}
}

func TestUninstallRemovesEmptyHooksTable(t *testing.T) {
	dir := t.TempDir()
	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err != nil {
		t.Fatalf("installHooks() error = %v", err)
	}
	if err := uninstallHooks(dir); err != nil {
		t.Fatalf("uninstallHooks() error = %v", err)
	}
	var cfg struct {
		Hooks *struct{} `toml:"hooks"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Hooks != nil {
		t.Error("empty parent [hooks] table survived uninstall")
	}
}

func TestUninstallMissingFiles(t *testing.T) {
	t.Run("missing config.toml", func(t *testing.T) {
		if err := uninstallHooks(t.TempDir()); err != nil {
			t.Fatalf("uninstallHooks() with no config.toml error = %v, want nil", err)
		}
	})

	t.Run("config without managed key", func(t *testing.T) {
		dir := t.TempDir()
		writeConfig(t, dir, []byte("model = \"o4-mini\"\n"))
		before := configBytes(t, dir)
		if err := uninstallHooks(dir); err != nil {
			t.Fatalf("uninstallHooks() with no managed hook error = %v, want nil", err)
		}
		if got := configBytes(t, dir); !bytesEqual(before, got) {
			t.Error("uninstall without managed hook rewrote config.toml")
		}
	})
}

func TestFailClosedOnUnparseableConfig(t *testing.T) {
	const broken = "not [ valid\n"
	t.Run("install", func(t *testing.T) {
		dir := t.TempDir()
		writeConfig(t, dir, []byte(broken))
		if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err == nil {
			t.Fatal("installHooks() on invalid TOML = nil, want error")
		}
		if got := configBytes(t, dir); !bytesEqual(got, []byte(broken)) {
			t.Errorf("failed install modified invalid config.toml:\n%s", got)
		}
	})

	t.Run("uninstall", func(t *testing.T) {
		dir := t.TempDir()
		writeConfig(t, dir, []byte(broken))
		if err := uninstallHooks(dir); err == nil {
			t.Fatal("uninstallHooks() on invalid TOML = nil, want error")
		}
		if got := configBytes(t, dir); !bytesEqual(got, []byte(broken)) {
			t.Errorf("failed uninstall modified invalid config.toml:\n%s", got)
		}
	})
}

// A symlinked config.toml usually belongs to a dotfile manager. Install must
// refuse to write through the link instead of silently corrupting its target,
// and no regular file may appear at the link path afterwards.
func TestInstallRefusesSymlinkedConfig(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real-config.toml")
	const seeded = "model = \"o4-mini\"\n"
	if err := os.WriteFile(target, []byte(seeded), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")
	if err := os.Symlink(target, configPath); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}

	err := installHooks(dir, hookOpts(dir, "hfg hook", false))
	if err == nil {
		t.Fatal("installHooks() through symlinked config.toml = nil, want error")
	}
	if !strings.Contains(err.Error(), "symlink") || !strings.Contains(err.Error(), configPath) {
		t.Errorf("installHooks() error = %v, want message naming %q as a symlink", err, configPath)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read through symlink: %v", err)
	}
	if !bytesEqual(got, []byte(seeded)) {
		t.Errorf("symlink target was modified:\n%s", got)
	}
	info, err := os.Lstat(configPath)
	if err != nil {
		t.Fatalf("lstat config.toml: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("config.toml mode = %v, want it to remain a symlink", info.Mode())
	}
}

// Uninstall obeys the same symlink policy: the managed hook behind the link
// stays exactly where it is rather than being deleted through the link.
func TestUninstallRefusesSymlinkedConfig(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real-config.toml")
	const seeded = "[hooks.handoffgraph]\ncommand = \"hfg hook\"\nevents = [" +
		"\"assistant.completed\", \"command.completed\", \"prompt.submitted\", " +
		"\"session.ended\", \"session.started\", \"tool.completed\"]\n"
	if err := os.WriteFile(target, []byte(seeded), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")
	if err := os.Symlink(target, configPath); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}

	err := uninstallHooks(dir)
	if err == nil {
		t.Fatal("uninstallHooks() through symlinked config.toml = nil, want error")
	}
	if !strings.Contains(err.Error(), "symlink") || !strings.Contains(err.Error(), configPath) {
		t.Errorf("uninstallHooks() error = %v, want message naming %q as a symlink", err, configPath)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read through symlink: %v", err)
	}
	if !bytesEqual(got, []byte(seeded)) {
		t.Errorf("symlink target was modified:\n%s", got)
	}
	if info, lerr := os.Lstat(configPath); lerr != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("config.toml survived as regular file or lstat failed: %v %v", info, lerr)
	}
}

// Uninstall never deletes name-blind: if "hooks" itself, or the managed
// handoffgraph slot inside it, holds something other than a table, removal
// fails closed with ErrHookConflict and the file is left untouched.
func TestUninstallFailsClosedOnNonTableShapes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config string
	}{
		{
			name:   "hooks is not a table",
			config: "hooks = \"not-a-table\"\n",
		},
		{
			name:   "managed hook is not a table",
			config: "[hooks]\nhandoffgraph = \"someone-else\"\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeConfig(t, dir, []byte(tc.config))

			if err := uninstallHooks(dir); !errors.Is(err, adapter.ErrHookConflict) {
				t.Fatalf("uninstallHooks() error = %v, want ErrHookConflict", err)
			}
			if got := configBytes(t, dir); !bytesEqual(got, []byte(tc.config)) {
				t.Errorf("failed uninstall modified config.toml:\n%s", got)
			}
		})
	}
}

// The parent [hooks] table is dropped only when removing the managed key
// leaves it completely empty; unrelated scalar keys keep it alive.
func TestUninstallKeepsHooksTableWithScalarKeys(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, []byte("[hooks]\nother = 1\n"))

	if err := installHooks(dir, hookOpts(dir, "hfg hook", false)); err != nil {
		t.Fatalf("installHooks() error = %v", err)
	}
	if err := uninstallHooks(dir); err != nil {
		t.Fatalf("uninstallHooks() error = %v", err)
	}

	var cfg struct {
		Hooks *struct {
			Other        *int64 `toml:"other"`
			Handoffgraph any    `toml:"handoffgraph"`
		} `toml:"hooks"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), &cfg); err != nil {
		t.Fatalf("post-uninstall config.toml no longer parses: %v", err)
	}
	if cfg.Hooks == nil {
		t.Fatal("[hooks] table was dropped although it still holds other = 1")
	}
	if cfg.Hooks.Other == nil || *cfg.Hooks.Other != 1 {
		t.Errorf("[hooks].other = %v, want preserved as 1", cfg.Hooks.Other)
	}
	if cfg.Hooks.Handoffgraph != nil {
		t.Errorf("managed hook survived uninstall: %v", cfg.Hooks.Handoffgraph)
	}
}
