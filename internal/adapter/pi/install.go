package pi

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
)

//go:embed extension/handoffgraph-extension.ts
var extensionFS embed.FS

// ExtensionFileName is the extension entry file installed under
// ~/.pi/agent/extensions/handoffgraph/.
const ExtensionFileName = "handoffgraph-extension.ts"

// manifestFileName marks the extension directory as managed by
// HandoffGraph. Its presence is what makes uninstall safe: a directory
// without it is user-owned and is never touched.
const manifestFileName = "hfg-manifest.json"

// settingsFileName is Pi's agent settings file (~/.pi/agent/settings.json).
// The managed entry is a marked top-level "handoffgraph" object merged into
// the existing JSON (merge-safe), never an overwrite.
const (
	settingsFileName     = "settings.json"
	settingsBackupSuffix = ".hfg.bak"
	managedSettingsKey   = "handoffgraph"
	extensionDirName     = "handoffgraph"
)

// InstallOptions controls the Pi extension installer. DryRun performs all
// conflict checks and writes nothing.
type InstallOptions struct {
	DryRun bool
}

// managedSettingsValue is the deterministic value stored under the
// "handoffgraph" key of settings.json. It carries no timestamps so an
// identical install is a byte-stable no-op.
func managedSettingsValue() map[string]any {
	return map[string]any{
		"managed":   true,
		"adapter":   "pi",
		"extension": extensionDirName,
	}
}

// managedManifest marks the extension directory as HandoffGraph-owned.
func managedManifest() map[string]any {
	return map[string]any{
		"managed_by": "handoffgraph",
		"adapter":    "pi",
		"files":      []string{ExtensionFileName},
	}
}

// Install wires the managed Pi extension into the Pi agent directory: it
// copies the embedded TypeScript extension into
// <agentDir>/extensions/handoffgraph/ and merges a marked "handoffgraph"
// object into <agentDir>/settings.json. Only the user scope exists for Pi
// (extensions are per-user); the project scope is unsupported.
//
// Install is merge-safe, idempotent and fail-closed: existing settings keys
// are preserved, a backup of settings.json is written next to it before the
// first modification, pre-existing user-owned state under the managed names
// is reported as ErrInstallConflict without modifying anything, and every
// write is atomic (temp file + rename).
func (p *Pi) Install(ctx context.Context, scope adapter.InstallScope) error {
	if scope != adapter.ScopeUser {
		return fmt.Errorf("pi install: %w: only the user scope exists for Pi extensions", ErrUnsupported)
	}
	dir := p.agentDir()
	if dir == "" {
		return errors.New("pi install: agent directory could not be resolved")
	}
	return p.InstallExtension(ctx, dir, InstallOptions{})
}

// InstallExtension is the full-control installer used by the CLI: agentDir
// is the Pi agent directory (~/.pi/agent), opts carries DryRun.
func (p *Pi) InstallExtension(ctx context.Context, agentDir string, opts InstallOptions) error {
	const op = "pi install"
	if agentDir == "" {
		return errors.New(op + ": agent directory is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}

	extDir := filepath.Join(agentDir, "extensions", extensionDirName)
	settingsPath := filepath.Join(agentDir, settingsFileName)

	// Fail-closed conflict checks first; nothing is written before all of
	// them pass.
	if err := checkExtensionDir(op, extDir); err != nil {
		return err
	}
	settings, mode, err := readSettings(op, settingsPath)
	if err != nil {
		return err
	}
	state, err := existingManagedState(op, settings)
	if err != nil {
		return err
	}
	settingsIdentical := state == managedIdentical
	extIdentical, err := extensionIdentical(extDir)
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	if settingsIdentical && extIdentical {
		return nil // idempotent no-op
	}
	if opts.DryRun {
		return nil
	}

	// Backup settings.json once, before its first modification by us.
	if !settingsIdentical {
		if err := backupSettings(op, settingsPath); err != nil {
			return err
		}
		merged := map[string]any{}
		for k, v := range settings {
			merged[k] = v
		}
		merged[managedSettingsKey] = managedSettingsValue()
		if err := writeJSONAtomic(settingsPath, merged, mode); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}
	if !extIdentical {
		if err := writeExtension(extDir); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}
	return nil
}

// Uninstall removes the managed Pi extension and the managed settings
// entry, preserving every other settings key and never deleting a
// user-owned extension directory (a directory without our manifest is
// refused, not removed). Uninstalling a clean Pi home is a no-op. The
// settings backup (settings.json.hfg.bak) is deliberately kept as evidence
// of the pre-install state.
func (p *Pi) Uninstall(ctx context.Context, scope adapter.InstallScope) error {
	if scope != adapter.ScopeUser {
		return fmt.Errorf("pi uninstall: %w: only the user scope exists for Pi extensions", ErrUnsupported)
	}
	dir := p.agentDir()
	if dir == "" {
		return errors.New("pi uninstall: agent directory could not be resolved")
	}
	return p.UninstallExtension(ctx, dir)
}

// UninstallExtension removes the managed state from the given agent dir.
func (p *Pi) UninstallExtension(ctx context.Context, agentDir string) error {
	const op = "pi uninstall"
	if agentDir == "" {
		return errors.New(op + ": agent directory is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}

	extDir := filepath.Join(agentDir, "extensions", extensionDirName)
	if err := checkExtensionDirForRemoval(op, extDir); err != nil {
		return err
	}
	settingsPath := filepath.Join(agentDir, settingsFileName)
	settings, mode, err := readSettings(op, settingsPath)
	if err != nil {
		return err
	}
	raw, present := settings[managedSettingsKey]
	if present {
		if _, ok := raw.(map[string]any); !ok {
			// Never delete by name blindly: a non-object entry under the
			// managed key is user state.
			return fmt.Errorf("%s: %w: settings key %q is not an object; refusing to delete by name",
				op, ErrInstallConflict, managedSettingsKey)
		}
		delete(settings, managedSettingsKey)
		if err := writeJSONAtomic(settingsPath, settings, mode); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}

	if info, err := os.Lstat(extDir); err == nil {
		if info.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s: %s is a symlink; refusing to remove it", op, extDir)
		}
		if err := os.RemoveAll(extDir); err != nil {
			return fmt.Errorf("%s: remove extension directory: %w", op, err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("%s: stat %s: %w", op, extDir, err)
	}
	return nil
}

// checkExtensionDir fails closed when extDir already exists but is not
// managed by us (no manifest): that directory belongs to the user and is
// never overwritten or removed. A symlinked extDir is refused outright.
func checkExtensionDir(op, extDir string) error {
	info, err := os.Lstat(extDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s: stat %s: %w", op, extDir, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s: %s is a symlink; refusing to write through it (managed by a dotfile manager?)", op, extDir)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s: %w: %s exists and is not a directory", op, ErrInstallConflict, extDir)
	}
	if _, err := os.Stat(filepath.Join(extDir, manifestFileName)); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%s: %w: %s exists without %s; refusing to overwrite a user-owned extension directory",
				op, ErrInstallConflict, extDir, manifestFileName)
		}
		return fmt.Errorf("%s: stat manifest: %w", op, err)
	}
	return nil
}

// checkExtensionDirForRemoval refuses to remove a user-owned or symlinked
// extension directory during uninstall.
func checkExtensionDirForRemoval(op, extDir string) error {
	info, err := os.Lstat(extDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s: stat %s: %w", op, extDir, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s: %s is a symlink; refusing to remove it", op, extDir)
	}
	if _, err := os.Stat(filepath.Join(extDir, manifestFileName)); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%s: %w: %s exists without %s; refusing to remove a user-owned extension directory",
				op, ErrInstallConflict, extDir, manifestFileName)
		}
		return fmt.Errorf("%s: stat manifest: %w", op, err)
	}
	return nil
}

// managedState classifies the managed settings entry.
type managedState int

const (
	managedAbsent managedState = iota
	managedIdentical
	managedDiffers
)

// existingManagedState inspects the settings map without mutating it. A
// non-object or differing value under the managed key is a conflict — user
// state is never overwritten.
func existingManagedState(op string, settings map[string]any) (managedState, error) {
	raw, present := settings[managedSettingsKey]
	if !present {
		return managedAbsent, nil
	}
	existing, ok := raw.(map[string]any)
	if !ok {
		return managedDiffers, fmt.Errorf("%s: %w: settings key %q is not an object", op, ErrInstallConflict, managedSettingsKey)
	}
	want, err := json.Marshal(managedSettingsValue())
	if err != nil {
		return managedDiffers, err
	}
	got, err := json.Marshal(existing)
	if err != nil {
		return managedDiffers, err
	}
	if string(got) != string(want) {
		return managedDiffers, fmt.Errorf("%s: %w: settings key %q differs from the managed value", op, ErrInstallConflict, managedSettingsKey)
	}
	return managedIdentical, nil
}

// extensionIdentical reports whether extDir already holds exactly the
// managed extension files with matching bytes. Manifest presence was
// verified by checkExtensionDir.
func extensionIdentical(extDir string) (bool, error) {
	if _, err := os.Stat(extDir); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	src, err := extensionFS.ReadFile("extension/" + ExtensionFileName)
	if err != nil {
		return false, err
	}
	dst, err := os.ReadFile(filepath.Join(extDir, ExtensionFileName))
	if err != nil || string(dst) != string(src) {
		return false, nil
	}
	manifest, err := os.ReadFile(filepath.Join(extDir, manifestFileName))
	if err != nil {
		return false, nil
	}
	wantManifest, err := json.Marshal(managedManifest())
	if err != nil {
		return false, err
	}
	var have map[string]any
	if json.Unmarshal(manifest, &have) != nil {
		return false, nil
	}
	haveJSON, err := json.Marshal(have)
	if err != nil {
		return false, err
	}
	return string(haveJSON) == string(wantManifest), nil
}

// writeExtension writes the embedded extension and manifest into extDir
// atomically (each file via temp+rename).
func writeExtension(extDir string) error {
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return fmt.Errorf("create extension directory: %w", err)
	}
	src, err := extensionFS.ReadFile("extension/" + ExtensionFileName)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(extDir, ExtensionFileName), src, 0o644); err != nil {
		return fmt.Errorf("write extension: %w", err)
	}
	manifest, err := json.MarshalIndent(managedManifest(), "", "  ")
	if err != nil {
		return err
	}
	manifest = append(manifest, '\n')
	if err := writeFileAtomic(filepath.Join(extDir, manifestFileName), manifest, 0o644); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return nil
}

// readSettings loads settingsPath as JSON. A missing file yields an empty
// map and the default new-file mode; an unparseable file is fail-closed —
// callers must never rewrite a settings file they could not read. The
// returned mode is the existing file's permissions (0o600 for new files).
func readSettings(op, settingsPath string) (map[string]any, os.FileMode, error) {
	settings := make(map[string]any)
	mode := os.FileMode(0o600)
	info, err := os.Stat(settingsPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, 0, fmt.Errorf("%s: stat %s: %w", op, settingsPath, err)
		}
		return settings, mode, nil
	}
	mode = info.Mode().Perm()
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil, 0, fmt.Errorf("%s: read %s: %w", op, settingsPath, err)
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, 0, fmt.Errorf("%s: %w: %s is unparseable as JSON; it was NOT modified: %v", op, ErrInstallConflict, settingsPath, err)
	}
	return settings, mode, nil
}

// backupSettings snapshots settingsPath to settingsPath+settingsBackupSuffix
// before the first managed modification. The backup is overwritten on each
// pre-modification snapshot so exactly one rollback point exists.
func backupSettings(op, settingsPath string) error {
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%s: read for backup: %w", op, err)
	}
	info, err := os.Stat(settingsPath)
	if err != nil {
		return fmt.Errorf("%s: stat for backup: %w", op, err)
	}
	return writeFileAtomic(settingsPath+settingsBackupSuffix, data, info.Mode().Perm())
}

// writeJSONAtomic marshals v (keys are sorted by encoding/json) and
// replaces path atomically with the given mode.
func writeJSONAtomic(path string, v any, mode os.FileMode) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	data = append(data, '\n')
	return writeFileAtomic(path, data, mode)
}

// writeFileAtomic replaces path with data atomically: temp file in the same
// directory, chmod, rename. On error the temp file is removed and the
// original is untouched.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".hfg-pi-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	discard := func() {
		tmp.Close()
		os.Remove(tmpName)
	}
	if _, err := tmp.Write(data); err != nil {
		discard()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("set temp file mode: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
