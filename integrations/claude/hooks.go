// Package claude provides merge-safe management of Claude Code hook
// configuration in ~/.claude/settings.json.
//
// Claude Code stores hooks as a nested JSON document:
//
//	{
//	  "hooks": {
//	    "PreToolUse": [
//	      {"matcher": "Bash", "hooks": [{"type": "command", "command": "..."}]}
//	    ]
//	  }
//	}
//
// HandoffGraph never owns this file: the user may keep their own hooks,
// matchers, and unrelated settings there. Every operation in this package
// is therefore additive and fail-closed:
//
//   - the existing document is decoded and re-encoded with unknown content
//     preserved (numbers keep their exact lexemes via json.Number);
//   - our matcher groups are appended per event, never replacing existing
//     entries;
//   - an entry we could not merge into (a scalar where an array is
//     expected, an ambiguous managed marker, a differently-commanded
//     managed hook) aborts with ErrHookConflict and leaves the file
//     untouched;
//   - only hook objects carrying the x_handoffgraph_managed marker are ever
//     removed on uninstall;
//   - a timestamped backup is written before every content-changing write;
//   - writes are atomic (temp file + rename + parent fsync);
//   - concurrent installs serialize through a lock file in the config
//     directory.
package claude

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
)

// Sentinel errors returned by this package.
var (
	// ErrHookConflict reports an existing hook configuration that cannot be
	// merged with (install) or safely interpreted by (uninstall)
	// HandoffGraph. The file is never modified when this is returned.
	ErrHookConflict = errors.New("claude hooks: conflicting hook configuration (file left untouched)")
)

const (
	// settingsFile is the Claude Code user settings file managed here.
	settingsFile = "settings.json"
	// markerKey marks hook command entries owned by HandoffGraph. Only
	// entries carrying this marker are ever removed by UninstallHooks.
	markerKey = "x_handoffgraph_managed"
	// lockFileName serializes concurrent installs in the config directory.
	lockFileName = ".hfg-hooks.lock"
	// defaultLockTimeout bounds how long an operation waits for the lock.
	defaultLockTimeout = 5 * time.Second
	// lockStaleAge: a lock file older than this is considered abandoned
	// (crashed holder) and reclaimed.
	lockStaleAge = 30 * time.Second
	// defaultFileMode is used for settings files that do not exist yet.
	defaultFileMode os.FileMode = 0o600
)

// HookEvents lists the Claude Code hook events HandoffGraph subscribes to,
// sorted. Every event gets one managed matcher group (matcher "" — matches
// every tool) whose single hook command receives the event JSON on stdin.
var HookEvents = []string{
	"PostCompact",
	"PostToolUse",
	"PreCompact",
	"PreToolUse",
	"SessionStart",
	"Stop",
	"UserPromptSubmit",
}

// Options configures InstallHooks and UninstallHooks.
type Options struct {
	// ConfigDir overrides the ~/.claude configuration directory.
	ConfigDir string
	// HookCommand is the command line installed for each hook event
	// (install only).
	HookCommand string
	// DryRun performs every check but writes nothing.
	DryRun bool
	// LockTimeout bounds the wait for the install lock. Defaults to 5s.
	LockTimeout time.Duration
	// Now overrides the clock used for backup file naming (tests).
	Now func() time.Time
}

// now returns the effective clock.
func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// lockTimeout returns the effective lock wait.
func (o Options) lockTimeout() time.Duration {
	if o.LockTimeout > 0 {
		return o.LockTimeout
	}
	return defaultLockTimeout
}

// resolveConfigDir returns the configuration directory to operate on.
func resolveConfigDir(dir string) (string, error) {
	if dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("claude hooks: cannot resolve home directory: %w", err)
	}
	return filepath.Join(home, ".claude"), nil
}

// settings represents a decoded settings document.
type settings struct {
	path string         // settings.json location
	raw  []byte         // original bytes (empty when the file did not exist)
	cfg  map[string]any // decoded document
	mode os.FileMode    // original permission bits
}

// readSettings loads settings.json. A missing file yields an empty
// configuration; an unparseable file is a fail-closed error — callers must
// never rewrite a document they could not read.
func readSettings(dir string) (*settings, error) {
	path := filepath.Join(dir, settingsFile)
	s := &settings{path: path, cfg: map[string]any{}, mode: defaultFileMode}
	info, err := os.Stat(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("claude hooks: stat %s: %w", path, err)
		}
		return s, nil
	}
	s.mode = info.Mode().Perm()
	s.raw, err = os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("claude hooks: read %s: %w", path, err)
	}
	dec := json.NewDecoder(bytes.NewReader(s.raw))
	dec.UseNumber()
	if err := dec.Decode(&s.cfg); err != nil {
		return nil, fmt.Errorf("claude hooks: %s is not parseable JSON; it was NOT modified: %w", path, err)
	}
	if s.cfg == nil {
		// A literal `null` document decodes to a nil map; treat as empty.
		s.cfg = map[string]any{}
	}
	return s, nil
}

// managedGroup builds the matcher group appended per hook event. matcher ""
// matches every tool; the marker identifies the entry as ours.
func managedGroup(command string) map[string]any {
	return map[string]any{
		"matcher": "",
		"hooks": []any{
			map[string]any{
				"type":    "command",
				"command": command,
				markerKey: true,
			},
		},
	}
}

// hookObject is one decoded {"type":"command","command":...} entry.
type hookObject map[string]any

// marked reports whether the object carries our managed marker, and whether
// that marker is a well-formed bool. A marker with a non-bool value is an
// ambiguous shape: callers must treat it as a conflict rather than guess.
func (h hookObject) marked() (present, valid bool) {
	v, ok := h[markerKey]
	if !ok {
		return false, true
	}
	b, isBool := v.(bool)
	return true, isBool && b
}

// hooksTable returns the top-level "hooks" object, creating it when create
// is set and it is absent. A present-but-not-an-object value is a conflict.
func hooksTable(cfg map[string]any, create bool) (map[string]any, error) {
	raw, present := cfg["hooks"]
	if !present {
		if !create {
			return nil, nil
		}
		hooks := map[string]any{}
		cfg["hooks"] = hooks
		return hooks, nil
	}
	hooks, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("claude hooks: %w: existing \"hooks\" entry is not an object", ErrHookConflict)
	}
	return hooks, nil
}

// mergeInstall computes the merged configuration for installing command.
// It mutates cfg only after every event has validated, appends one managed
// matcher group per event not already carrying our command, and returns
// whether anything changed. A marked entry with a different command is a
// conflict (never overwrite; uninstall first).
func mergeInstall(cfg map[string]any, command string) (bool, error) {
	hooks, err := hooksTable(cfg, true)
	if err != nil {
		return false, err
	}
	pending := make([]string, 0, len(HookEvents))
	for _, event := range HookEvents {
		entries, present := hooks[event]
		if !present {
			pending = append(pending, event)
			continue
		}
		found, err := scanEventEntries(event, entries, command)
		if err != nil {
			return false, err
		}
		if !found {
			pending = append(pending, event)
		}
	}
	if len(pending) == 0 {
		return false, nil
	}
	if command == "" {
		return false, errors.New("claude hooks: install: hook command is required")
	}
	for _, event := range pending {
		existing, _ := hooks[event].([]any)
		merged := append([]any{}, existing...)
		hooks[event] = append(merged, managedGroup(command))
	}
	return true, nil
}

// scanEventEntries inspects the matcher-group array of one hook event. It
// reports whether our command is already installed there (a marked entry
// with the same command, or any entry — even unmarked — whose command
// matches exactly, so a user's hand-copied copy is not duplicated).
// Ambiguous or conflicting shapes fail closed with ErrHookConflict.
func scanEventEntries(event string, entries any, command string) (bool, error) {
	arr, ok := entries.([]any)
	if !ok {
		return false, fmt.Errorf("claude hooks: %w: existing hooks.%s is not an array", ErrHookConflict, event)
	}
	found := false
	for _, group := range arr {
		g, ok := group.(map[string]any)
		if !ok {
			return false, fmt.Errorf("claude hooks: %w: existing hooks.%s entry is not an object", ErrHookConflict, event)
		}
		rawHooks, present := g["hooks"]
		if !present {
			continue // a matcher group without hooks cannot conflict with us
		}
		hookArr, ok := rawHooks.([]any)
		if !ok {
			return false, fmt.Errorf("claude hooks: %w: existing hooks.%s entry \"hooks\" is not an array", ErrHookConflict, event)
		}
		for _, h := range hookArr {
			hobj, ok := h.(map[string]any)
			if !ok {
				return false, fmt.Errorf("claude hooks: %w: existing hooks.%s hook entry is not an object", ErrHookConflict, event)
			}
			marked, valid := hookObject(hobj).marked()
			if marked && !valid {
				return false, fmt.Errorf("claude hooks: %w: hooks.%s managed marker %q is not a boolean", ErrHookConflict, event, markerKey)
			}
			cmd, _ := hobj["command"].(string)
			if marked && valid && cmd != "" && cmd != command {
				return false, fmt.Errorf("claude hooks: %w: hooks.%s already has a managed hook with a different command (%q); uninstall first", ErrHookConflict, event, cmd)
			}
			if cmd != "" && cmd == command {
				found = true
			}
		}
	}
	return found, nil
}

// mergeUninstall removes every marked hook entry from every hook event,
// preserving all other entries. Matcher groups left without hooks are
// dropped; event keys left without groups are dropped; a "hooks" object
// emptied by our removals is dropped entirely. It reports whether anything
// changed. Shapes it cannot positively identify as marked are preserved.
func mergeUninstall(cfg map[string]any) (bool, error) {
	hooks, err := hooksTable(cfg, false)
	if err != nil || hooks == nil {
		return false, err
	}

	events := make([]string, 0, len(hooks))
	for k := range hooks {
		events = append(events, k)
	}
	sort.Strings(events) // deterministic processing order

	changed := false
	for _, event := range events {
		arr, ok := hooks[event].([]any)
		if !ok {
			// Not ours and not removable by name; leave untouched.
			continue
		}
		kept := make([]any, 0, len(arr))
		for _, group := range arr {
			g, ok := group.(map[string]any)
			if !ok {
				kept = append(kept, group) // user entry, preserved verbatim
				continue
			}
			hookArr, ok := g["hooks"].([]any)
			if !ok {
				kept = append(kept, group)
				continue
			}
			keptHooks := make([]any, 0, len(hookArr))
			for _, h := range hookArr {
				hobj, ok := h.(map[string]any)
				if !ok {
					keptHooks = append(keptHooks, h)
					continue
				}
				marked, valid := hookObject(hobj).marked()
				if marked && !valid {
					return false, fmt.Errorf("claude hooks: %w: hooks.%s managed marker %q is not a boolean", ErrHookConflict, event, markerKey)
				}
				if marked && valid {
					changed = true
					continue // remove only our marked entries
				}
				keptHooks = append(keptHooks, h)
			}
			if len(keptHooks) == len(hookArr) {
				kept = append(kept, group) // no marked hooks inside
				continue
			}
			if len(keptHooks) > 0 {
				g["hooks"] = keptHooks
				kept = append(kept, g)
			}
			// A group reduced to zero hooks is dropped entirely.
		}
		if len(kept) == len(arr) {
			continue
		}
		if len(kept) > 0 {
			hooks[event] = kept
		} else {
			delete(hooks, event)
		}
	}
	if changed && len(hooks) == 0 {
		delete(cfg, "hooks")
	}
	return changed, nil
}

// InstallHooks merges the HandoffGraph hook command into every HookEvents
// entry of settings.json under the resolved config directory. It is
// idempotent (an identical install is a no-op that writes nothing), creates
// a timestamped backup before every content-changing write, and refuses to
// write through a symlinked settings.json.
func InstallHooks(opts Options) error {
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("claude hooks: create config directory: %w", err)
	}
	return withLock(dir, opts.lockTimeout(), func() error {
		s, err := readSettings(dir)
		if err != nil {
			return err
		}
		changed, err := mergeInstall(s.cfg, opts.HookCommand)
		if err != nil || !changed {
			return err
		}
		if opts.DryRun {
			return nil
		}
		return commit(s, opts.now())
	})
}

// UninstallHooks removes every marked HandoffGraph hook entry from
// settings.json, leaving every unmarked entry (user hooks, matchers,
// unrelated settings) untouched. It is a no-op when nothing is installed.
func UninstallHooks(opts Options) error {
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("claude hooks: create config directory: %w", err)
	}
	return withLock(dir, opts.lockTimeout(), func() error {
		s, err := readSettings(dir)
		if err != nil {
			return err
		}
		changed, err := mergeUninstall(s.cfg)
		if err != nil || !changed {
			return err
		}
		if opts.DryRun {
			return nil
		}
		return commit(s, opts.now())
	})
}

// InstalledHookEvents returns the sorted hook events that currently carry
// a managed (marked) HandoffGraph entry. Read-only helper for CLI status
// output; it takes no lock and writes nothing.
func InstalledHookEvents(opts Options) ([]string, error) {
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return nil, err
	}
	s, err := readSettings(dir)
	if err != nil {
		return nil, err
	}
	hooks, err := hooksTable(s.cfg, false)
	if err != nil || hooks == nil {
		return nil, err
	}
	var out []string
	for event, entries := range hooks {
		arr, ok := entries.([]any)
		if !ok {
			continue
		}
	scan:
		for _, group := range arr {
			g, ok := group.(map[string]any)
			if !ok {
				continue
			}
			hookArr, ok := g["hooks"].([]any)
			if !ok {
				continue
			}
			for _, h := range hookArr {
				hobj, ok := h.(map[string]any)
				if !ok {
					continue
				}
				if marked, valid := hookObject(hobj).marked(); marked && valid {
					out = append(out, event)
					break scan
				}
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

// commit writes the (already merged) settings back: backup, then atomic
// replace. The backup preserves the exact previous bytes; its name embeds
// a UTC timestamp, with a numeric suffix on same-instant collisions.
func commit(s *settings, now time.Time) error {
	if len(s.raw) > 0 {
		if err := refuseSymlinkedSettings(s.path); err != nil {
			return err
		}
		if err := writeBackup(s, now); err != nil {
			return err
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s.cfg); err != nil {
		return fmt.Errorf("claude hooks: encode settings: %w", err)
	}
	if err := writeSettingsAtomic(s.path, buf.Bytes(), s.mode); err != nil {
		return fmt.Errorf("claude hooks: %w", err)
	}
	return nil
}

// writeBackup persists the original bytes next to the settings file under a
// timestamped name, suffixing numerically on same-instant collisions.
func writeBackup(s *settings, now time.Time) error {
	base := s.path + ".hfg-backup-" + now.UTC().Format("20060102T150405Z")
	backup := base
	for i := 1; ; i++ {
		_, err := os.Stat(backup)
		if errors.Is(err, fs.ErrNotExist) {
			break
		}
		if err != nil {
			return fmt.Errorf("claude hooks: stat backup %s: %w", backup, err)
		}
		backup = fmt.Sprintf("%s-%d", base, i)
	}
	if err := os.WriteFile(backup, s.raw, 0o600); err != nil {
		return fmt.Errorf("claude hooks: write backup %s: %w", backup, err)
	}
	return nil
}

// refuseSymlinkedSettings fails closed when settings.json itself is a
// symlink: such files are usually managed by a dotfile manager, and writing
// through the link could corrupt the target's format or ownership.
func refuseSymlinkedSettings(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("claude hooks: stat %s: %w", path, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("claude hooks: %s is a symlink; refusing to write through it (managed by a dotfile manager?)", path)
	}
	return nil
}

// writeSettingsAtomic replaces path with data atomically: write to a temp
// file in the same directory, sync, restore the original permission mode,
// rename over the target, then fsync the parent directory so the rename
// itself is durable. On any pre-rename failure the original file is left
// untouched.
func writeSettingsAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hfg-settings-*.json")
	if err != nil {
		return fmt.Errorf("create temp settings: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		tmp.Close()
		os.Remove(tmpName)
	}
	if _, err := tmp.Write(data); err != nil {
		discard()
		return fmt.Errorf("write temp settings: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return fmt.Errorf("sync temp settings: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close temp settings: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("set settings mode: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("replace settings: %w", err)
	}
	if err := syncParentDir(path); err != nil {
		return fmt.Errorf("settings written to %s, but durability is not guaranteed: %w", path, err)
	}
	return nil
}

// syncParentDir opens the containing directory and fsyncs it. Some
// platforms reject directory fsync with EINVAL; that is a platform
// limitation, not a durability problem, so it is tolerated.
func syncParentDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Dir(path), err)
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		if errors.Is(err, syscall.EINVAL) {
			return nil
		}
		return fmt.Errorf("sync %s: %w", filepath.Dir(path), err)
	}
	return dir.Close()
}

// withLock runs fn while holding an exclusive lock file in dir. The lock is
// a plain O_CREATE|O_EXCL file: portable, and crash-safe to detect (a
// holder that died leaves the file behind; anything older than lockStaleAge
// is reclaimed). It waits up to timeout before failing.
func withLock(dir string, timeout time.Duration, fn func() error) error {
	lockPath := filepath.Join(dir, lockFileName)
	deadline := time.Now().Add(timeout)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			runErr := fn()
			if closeErr := f.Close(); runErr == nil {
				runErr = closeErr
			}
			if rmErr := os.Remove(lockPath); runErr == nil {
				runErr = rmErr
			}
			return runErr
		}
		if !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("claude hooks: acquire lock %s: %w", lockPath, err)
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > lockStaleAge {
			// Abandoned lock (crashed holder): reclaim and retry.
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("claude hooks: another hooks operation holds %s (timed out after %s)", lockPath, timeout)
		}
		time.Sleep(2 * time.Millisecond)
	}
}
