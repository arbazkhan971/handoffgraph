package codex

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"

	"github.com/BurntSushi/toml"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
)

const (
	// hooksTableKey is the top-level config.toml table holding hook
	// configuration. Other tools may keep their own entries in it; only the
	// key below is ever touched.
	hooksTableKey = "hooks"
	// hookName is the managed key under hooksTableKey identifying the
	// HandoffGraph hook.
	hookName = "handoffgraph"
)

// HookEvents lists the Codex hook events HandoffGraph subscribes to, sorted.
var HookEvents = []string{
	"assistant.completed",
	"command.completed",
	"prompt.submitted",
	"session.ended",
	"session.started",
	"tool.completed",
}

// installHooks wires the HandoffGraph hook into configDir/config.toml. It
// fails closed: a config that cannot be parsed is never modified, an
// existing handoffgraph hook with a different command or event set is
// reported as adapter.ErrHookConflict instead of being overwritten or
// merged, and every write is atomic (temp file + rename + parent-directory
// fsync) so a failure leaves the original config intact. A symlinked
// config.toml (for example one managed by a dotfile manager) is refused
// outright rather than written through. Installing an identical hook is an
// idempotent no-op; DryRun performs all checks and writes nothing.
func installHooks(configDir string, opts adapter.InstallOptions) error {
	const op = "codex install"
	if configDir == "" {
		return errors.New(op + ": config directory could not be resolved")
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return fmt.Errorf("%s: create config directory: %w", op, err)
	}
	configPath := filepath.Join(configDir, "config.toml")

	cfg, mode, err := readConfig(op, configPath)
	if err != nil {
		return err
	}

	switch state, cerr := existingHookState(cfg, opts.HookCommand); {
	case cerr != nil:
		return cerr
	case state == hookIdentical:
		return nil
	}

	if opts.HookCommand == "" {
		return errors.New(op + ": hook command is required")
	}
	if opts.DryRun {
		return nil
	}

	hooks, ok := cfg[hooksTableKey].(map[string]any)
	if !ok {
		hooks = make(map[string]any)
	}
	hooks[hookName] = managedHook(opts.HookCommand)
	cfg[hooksTableKey] = hooks

	if err := refuseSymlinkedConfig(op, configPath); err != nil {
		return err
	}
	if err := writeConfigAtomic(configPath, cfg, mode); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	return nil
}

// refuseSymlinkedConfig fails closed when configPath itself is a symlink.
// A symlinked config is usually owned by a dotfile manager; writing through
// it would silently corrupt the link target's file format, so the write is
// refused instead of resolved. Read paths (conflict detection) still read
// through the link on purpose: an identical managed hook behind a symlink
// stays an idempotent no-op, and a differing one is reported as a conflict
// before this guard ever runs. Call it immediately before every write.
func refuseSymlinkedConfig(op, configPath string) error {
	info, err := os.Lstat(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%s: stat %s: %w", op, configPath, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s: %s is a symlink; refusing to write through it (managed by a dotfile manager?)", op, configPath)
	}
	return nil
}

// uninstallHooks removes the managed handoffgraph hook from
// configDir/config.toml, leaving every other entry untouched. It fails
// closed on an unparseable config (nothing is ever deleted in that case),
// refuses to touch a config where "hooks" or hooks.handoffgraph exists but
// is not a table (deletion is never name-blind), is a no-op when the config
// or the managed hook is absent, and writes atomically only when content
// actually changes. The parent [hooks] table survives unless removing the
// managed key would leave it completely empty (scalar keys count).
func uninstallHooks(configDir string) error {
	const op = "codex uninstall"
	if configDir == "" {
		return errors.New(op + ": config directory could not be resolved")
	}
	configPath := filepath.Join(configDir, "config.toml")
	cfg, mode, err := readConfig(op, configPath)
	if err != nil {
		return err
	}

	hooks, ok := cfg[hooksTableKey].(map[string]any)
	if !ok {
		if _, present := cfg[hooksTableKey]; present {
			return fmt.Errorf("%s: %w: existing %s entry is not a table; refusing to delete by name",
				op, adapter.ErrHookConflict, hooksTableKey)
		}
		return nil
	}
	existing, present := hooks[hookName]
	if !present {
		return nil
	}
	if _, ok := existing.(map[string]any); !ok {
		return fmt.Errorf("%s: %w: existing %s.%s entry is not a table; refusing to delete by name",
			op, adapter.ErrHookConflict, hooksTableKey, hookName)
	}

	delete(hooks, hookName)
	if len(hooks) == 0 {
		delete(cfg, hooksTableKey)
	}

	if err := refuseSymlinkedConfig(op, configPath); err != nil {
		return err
	}
	if err := writeConfigAtomic(configPath, cfg, mode); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	return nil
}

// readConfig loads configPath into a generic map. A missing file yields an
// empty configuration and the default new-file mode; an unparseable file is
// a fail-closed error — callers must never rewrite a config they could not
// read. The returned mode is the existing file's permission bits, or 0o600
// for a file that does not exist yet.
func readConfig(op, configPath string) (map[string]any, os.FileMode, error) {
	cfg := make(map[string]any)
	mode := os.FileMode(0o600)
	info, err := os.Stat(configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, 0, fmt.Errorf("%s: stat %s: %w", op, configPath, err)
		}
		return cfg, mode, nil
	}
	mode = info.Mode().Perm()
	if _, err := toml.DecodeFile(configPath, &cfg); err != nil {
		return nil, 0, fmt.Errorf("%s: %s is unparseable as TOML; it was NOT modified: %w", op, configPath, err)
	}
	return cfg, mode, nil
}

// hookState classifies the managed hook found in a decoded config.
type hookState int

const (
	hookAbsent hookState = iota
	hookIdentical
	hookDiffers
)

// existingHookState inspects the hooks table without mutating anything. It
// returns hookIdentical when the managed hook already matches command and
// HookEvents exactly, and adapter.ErrHookConflict when anything else
// occupies the managed slot (including a non-table value) — never overwrite.
func existingHookState(cfg map[string]any, command string) (hookState, error) {
	raw, present := cfg[hooksTableKey]
	if !present {
		return hookAbsent, nil
	}
	hooks, ok := raw.(map[string]any)
	if !ok {
		return hookDiffers, fmt.Errorf("codex install: %w: existing hooks entry is not a table", adapter.ErrHookConflict)
	}
	existing, present := hooks[hookName]
	if !present {
		return hookAbsent, nil
	}
	managed, ok := existing.(map[string]any)
	if !ok || !sameHook(managed, command) {
		return hookDiffers, fmt.Errorf("codex install: %w: existing handoffgraph hook configuration differs", adapter.ErrHookConflict)
	}
	return hookIdentical, nil
}

// sameHook reports whether a decoded managed hook matches the given command
// and the HookEvents set exactly. Decoded arrays arrive as []any; anything
// that cannot be normalized to strings counts as a mismatch (fail closed).
func sameHook(managed map[string]any, command string) bool {
	if cmd, ok := managed["command"].(string); !ok || cmd != command {
		return false
	}
	events, ok := decodeStrings(managed["events"])
	if !ok || len(events) != len(HookEvents) {
		return false
	}
	sort.Strings(events)
	for i, ev := range events {
		if ev != HookEvents[i] {
			return false
		}
	}
	return true
}

// decodeStrings normalizes a decoded TOML string array ([]any, or []string)
// into a copy the caller may sort.
func decodeStrings(v any) ([]string, bool) {
	switch raw := v.(type) {
	case []any:
		out := make([]string, 0, len(raw))
		for _, e := range raw {
			s, ok := e.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	case []string:
		return append([]string(nil), raw...), true
	default:
		return nil, false
	}
}

// managedHook builds the table written under hooks.<hookName>.
func managedHook(command string) map[string]any {
	return map[string]any{
		"command": command,
		"events":  append([]string(nil), HookEvents...),
	}
}

// writeConfigAtomic encodes cfg and replaces configPath atomically: the
// encoded config is written to a temp file in the same directory with the
// given mode, then renamed over the target. On any error the temp file is
// removed and the original file is left untouched.
func writeConfigAtomic(configPath string, cfg map[string]any, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(configPath), ".hfg-config-*.toml")
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		tmp.Close()
		os.Remove(tmpName)
	}

	if err := toml.NewEncoder(tmp).Encode(cfg); err != nil {
		discard()
		return fmt.Errorf("encode config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return fmt.Errorf("sync config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close config: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("set config mode: %w", err)
	}
	if err := os.Rename(tmpName, configPath); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("replace config: %w", err)
	}
	// Durability: after the rename, fsync the parent directory so the new
	// directory entry itself is flushed to disk. The config has already been
	// written at this point, so a failure here must NOT roll anything back —
	// it is reported as a durability warning only.
	//
	// Some platforms refuse fsync on a directory with an "invalid argument"
	// class error. That is a platform limitation, not a durability problem,
	// so it is treated as non-fatal for this one call: the error is dropped
	// silently and the write is reported as successful. Any other directory
	// sync failure is returned so the caller can surface that the config was
	// written but its durability is not guaranteed.
	if err := syncParentDir(configPath); err != nil {
		if errors.Is(err, syscall.EINVAL) {
			return nil
		}
		return fmt.Errorf("config written to %s, but durability is not guaranteed: fsync parent directory: %w", configPath, err)
	}
	return nil
}

// syncParentDir opens the directory containing configPath and fsyncs it so
// a completed rename survives a crash. os.Open + Sync on a directory works
// on macOS and Linux (the platforms CI runs on) without any build tags.
func syncParentDir(configPath string) error {
	dir, err := os.Open(filepath.Dir(configPath))
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Dir(configPath), err)
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return fmt.Errorf("sync %s: %w", filepath.Dir(configPath), err)
	}
	return dir.Close()
}
