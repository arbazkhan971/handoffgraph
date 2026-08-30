// Package claude provides merge-safe management of Claude Code hook
// configuration in ~/.claude/settings.json.
//
// Claude validates hook handlers against a closed schema. HandoffGraph must
// therefore never put ownership markers in settings.json. Ownership lives in
// a private sidecar manifest instead. The manifest and settings changes form a
// small recoverable transaction: a crash can leave a pending manifest, but the
// before/after digests make the only safe recovery unambiguous.
package claude

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

// ErrHookConflict means existing state cannot be positively identified as
// HandoffGraph-owned. Install and uninstall fail closed in that case.
var ErrHookConflict = errors.New("claude hooks: conflicting hook configuration (files left untouched)")

const (
	settingsFile       = "settings.json"
	manifestFileName   = ".handoffgraph-hooks.json"
	lockFileName       = ".hfg-hooks.lock"
	legacyMarkerKey    = "x_handoffgraph_managed"
	manifestVersion    = 1
	manifestProvider   = "claude"
	manifestStateLive  = "active"
	manifestStateAdd   = "installing"
	manifestStateDrop  = "uninstalling"
	defaultLockTimeout = 5 * time.Second
	defaultFileMode    = os.FileMode(0o600)
	maxManifestBytes   = 64 << 10
)

// HookEvents is the complete, sorted Claude hook surface HandoffGraph owns.
// SessionEnd is intentionally included: capture must close native sessions as
// well as observe per-turn Stop events.
var HookEvents = []string{
	"PostCompact",
	"PostToolUse",
	"PreCompact",
	"PreToolUse",
	"SessionEnd",
	"SessionStart",
	"Stop",
	"UserPromptSubmit",
}

// legacyHookEvents is the exact event set emitted by the historical inline-
// marker installer. SessionEnd was added with the schema-valid sidecar format.
var legacyHookEvents = []string{
	"PostCompact",
	"PostToolUse",
	"PreCompact",
	"PreToolUse",
	"SessionStart",
	"Stop",
	"UserPromptSubmit",
}

// Options configures hook installation/removal.
type Options struct {
	ConfigDir string

	// HookCommand is written verbatim to the schema's command field. When
	// HookArgs is nil Claude treats it as an explicit shell-form command.
	HookCommand string
	// HookArgs selects Claude's native executable-plus-arguments form. The
	// default adapter supplies ["hook", "claude"] so Windows never needs a
	// cmd.exe-combined command string.
	HookArgs []string
	// LegacyHookCommand is the exact shell-form command emitted by the old
	// marker-based installer. It is used only for an exact legacy migration.
	LegacyHookCommand string

	DryRun      bool
	LockTimeout time.Duration
	Now         func() time.Time
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o Options) lockTimeout() time.Duration {
	if o.LockTimeout > 0 {
		return o.LockTimeout
	}
	return defaultLockTimeout
}

// hookSpec is exactly the schema-legal Claude command-handler payload. Keep
// this type closed: adding an ownership key here would invalidate settings.
type hookSpec struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
}

func specFromOptions(opts Options) (hookSpec, error) {
	spec := hookSpec{Type: "command", Command: opts.HookCommand}
	if len(opts.HookArgs) > 0 {
		spec.Args = append([]string(nil), opts.HookArgs...)
	}
	if err := validateHookSpec(spec); err != nil {
		return hookSpec{}, err
	}
	return spec, nil
}

func validateHookSpec(spec hookSpec) error {
	if spec.Type != "command" || strings.TrimSpace(spec.Command) == "" {
		return errors.New("claude hooks: install: hook command is required")
	}
	if strings.ContainsRune(spec.Command, '\x00') {
		return errors.New("claude hooks: install: hook command contains NUL")
	}
	for i, arg := range spec.Args {
		if strings.ContainsRune(arg, '\x00') {
			return fmt.Errorf("claude hooks: install: hook argument %d contains NUL", i)
		}
	}
	return nil
}

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

type settings struct {
	path   string
	raw    []byte
	cfg    map[string]any
	mode   os.FileMode
	exists bool
}

func readSettings(dir string) (*settings, error) {
	path := filepath.Join(dir, settingsFile)
	s := &settings{path: path, cfg: map[string]any{}, mode: defaultFileMode}
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return s, nil
		}
		return nil, fmt.Errorf("claude hooks: stat %s: %w", path, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return nil, fmt.Errorf("claude hooks: %s is a symlink; refusing to read or write through it", path)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("claude hooks: %s is not a regular file", path)
	}
	s.exists = true
	s.mode = info.Mode().Perm()
	s.raw, err = os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("claude hooks: read %s: %w", path, err)
	}
	if err := decodeOneJSON(s.raw, &s.cfg, false); err != nil {
		return nil, fmt.Errorf("claude hooks: %s is not exactly one JSON object; it was NOT modified: %w", path, err)
	}
	if s.cfg == nil {
		// Preserve the previous installer's documented treatment of a literal
		// null document as an empty settings object.
		s.cfg = map[string]any{}
	}
	return s, nil
}

func decodeOneJSON(data []byte, dst any, strict bool) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if strict {
		dec.DisallowUnknownFields()
	}
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return fmt.Errorf("trailing data: %w", err)
	}
	return nil
}

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
		return nil, fmt.Errorf("claude hooks: %w: existing hooks entry is not an object", ErrHookConflict)
	}
	return hooks, nil
}

func handlerObject(spec hookSpec) map[string]any {
	h := map[string]any{"type": spec.Type, "command": spec.Command}
	if spec.Args != nil {
		args := make([]any, len(spec.Args))
		for i := range spec.Args {
			args[i] = spec.Args[i]
		}
		h["args"] = args
	}
	return h
}

func managedGroup(spec hookSpec) map[string]any {
	return map[string]any{
		"matcher": "",
		"hooks":   []any{handlerObject(spec)},
	}
}

func exactKeys(obj map[string]any, want ...string) bool {
	if len(obj) != len(want) {
		return false
	}
	for _, key := range want {
		if _, ok := obj[key]; !ok {
			return false
		}
	}
	return true
}

func exactGroup(group map[string]any, spec hookSpec) bool {
	return exactKeys(group, "matcher", "hooks") && reflect.DeepEqual(group, managedGroup(spec))
}

// sameExecutionIdentity compares the invocation Claude will execute while
// deliberately ignoring schema-valid options such as timeout or async. Those
// options do not make a second copy of the same HandoffGraph command safe: it
// would still double-capture. Exact full-object equality remains required for
// ownership and removal.
func sameExecutionIdentity(handler map[string]any, spec hookSpec) bool {
	if handler["type"] != spec.Type || handler["command"] != spec.Command {
		return false
	}
	rawArgs, present := handler["args"]
	if spec.Args == nil {
		if !present {
			return true
		}
		args, ok := rawArgs.([]any)
		return ok && len(args) == 0
	}
	args, ok := rawArgs.([]any)
	if !ok || len(args) != len(spec.Args) {
		return false
	}
	for i, arg := range args {
		if arg != spec.Args[i] {
			return false
		}
	}
	return true
}

type scanResult struct {
	exactGroups    int
	exactHandlers  int
	legacyGroups   int
	legacyCommands []string
}

type legacyCandidate struct {
	event   string
	command string
}

func countKey(value any, key string) int {
	switch typed := value.(type) {
	case map[string]any:
		count := 0
		for k, child := range typed {
			if k == key {
				count++
			}
			count += countKey(child, key)
		}
		return count
	case []any:
		count := 0
		for _, child := range typed {
			count += countKey(child, key)
		}
		return count
	default:
		return 0
	}
}

// legacyInventory is deliberately lenient about unrelated malformed hook
// shapes, but exact about anything carrying the historical ownership key.
// Thus an uninstall with no sidecar preserves arbitrary user bytes, while a
// malformed/foreign marker can never be mistaken for ours or deleted.
func legacyInventory(hooks map[string]any) ([]legacyCandidate, error) {
	totalMarkers := countKey(hooks, legacyMarkerKey)
	if totalMarkers == 0 {
		return nil, nil
	}
	managedEvent := map[string]bool{}
	for _, event := range HookEvents {
		managedEvent[event] = true
	}
	var out []legacyCandidate
	for event, rawEntries := range hooks {
		entries, ok := rawEntries.([]any)
		if !ok {
			continue
		}
		for _, rawGroup := range entries {
			group, ok := rawGroup.(map[string]any)
			if !ok || !exactKeys(group, "matcher", "hooks") || group["matcher"] != "" {
				continue
			}
			handlers, ok := group["hooks"].([]any)
			if !ok || len(handlers) != 1 {
				continue
			}
			handler, ok := handlers[0].(map[string]any)
			if !ok {
				continue
			}
			command, safe := exactLegacyHandler(handler)
			if safe && managedEvent[event] {
				out = append(out, legacyCandidate{event: event, command: command})
			}
		}
	}
	if len(out) != totalMarkers {
		return nil, fmt.Errorf("claude hooks: %w: malformed or foreign legacy marker object", ErrHookConflict)
	}
	return out, nil
}

// scanEvent validates one managed event and inventories exact owned/collision
// candidates. A legacy marker is acceptable only on the exact object emitted
// by the old installer; every malformed or foreign marker is a conflict and
// remains untouched.
func scanEvent(event string, entries any, desired hookSpec) (scanResult, error) {
	arr, ok := entries.([]any)
	if !ok {
		return scanResult{}, fmt.Errorf("claude hooks: %w: existing hooks.%s is not an array", ErrHookConflict, event)
	}
	var out scanResult
	for _, rawGroup := range arr {
		group, ok := rawGroup.(map[string]any)
		if !ok {
			return out, fmt.Errorf("claude hooks: %w: hooks.%s group is not an object", ErrHookConflict, event)
		}
		rawHandlers, present := group["hooks"]
		if !present {
			continue
		}
		handlers, ok := rawHandlers.([]any)
		if !ok {
			return out, fmt.Errorf("claude hooks: %w: hooks.%s group hooks is not an array", ErrHookConflict, event)
		}
		for _, rawHandler := range handlers {
			handler, ok := rawHandler.(map[string]any)
			if !ok {
				return out, fmt.Errorf("claude hooks: %w: hooks.%s handler is not an object", ErrHookConflict, event)
			}
			if _, marked := handler[legacyMarkerKey]; marked {
				legacyCommand, safe := exactLegacyHandler(handler)
				if !safe || !exactKeys(group, "matcher", "hooks") || group["matcher"] != "" || len(handlers) != 1 {
					return out, fmt.Errorf("claude hooks: %w: hooks.%s contains a malformed or foreign legacy marker", ErrHookConflict, event)
				}
				out.legacyGroups++
				out.legacyCommands = append(out.legacyCommands, legacyCommand)
				continue
			}
			if sameExecutionIdentity(handler, desired) {
				out.exactHandlers++
			}
		}
		if exactGroup(group, desired) {
			out.exactGroups++
		}
	}
	return out, nil
}

func exactLegacyHandler(handler map[string]any) (string, bool) {
	if !exactKeys(handler, "type", "command", legacyMarkerKey) {
		return "", false
	}
	if handler[legacyMarkerKey] != true || handler["type"] != "command" {
		return "", false
	}
	command, ok := handler["command"].(string)
	return command, ok && command != ""
}

func allLegacyCommandsAllowed(commands []string, opts Options, desired hookSpec) bool {
	allowed := map[string]bool{}
	if opts.LegacyHookCommand != "" {
		allowed[opts.LegacyHookCommand] = true
	}
	// An explicit --hook-command was already shell-form in the legacy format.
	if desired.Args == nil {
		allowed[desired.Command] = true
	}
	for _, command := range commands {
		if !allowed[command] {
			return false
		}
	}
	return len(allowed) > 0
}

func validatedLegacyEvents(candidates []legacyCandidate) ([]string, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	counts := map[string]int{}
	for _, candidate := range candidates {
		counts[candidate.event]++
	}
	accept := func(events []string) bool {
		if len(candidates) != len(events) {
			return false
		}
		for _, event := range events {
			if counts[event] != 1 {
				return false
			}
		}
		return true
	}
	var events []string
	switch {
	case accept(legacyHookEvents):
		events = legacyHookEvents
	case accept(HookEvents):
		// Accept the short-lived eight-event marker build as an exact set too;
		// it was generated by this release candidate before the schema fix.
		events = HookEvents
	default:
		return nil, fmt.Errorf("claude hooks: %w: partial or foreign legacy marker set", ErrHookConflict)
	}
	return append([]string(nil), events...), nil
}

func legacyCommandInConfig(cfg map[string]any) (string, error) {
	hooks, err := hooksTable(cfg, false)
	if err != nil || hooks == nil {
		return "", err
	}
	legacy, err := legacyInventory(hooks)
	if err != nil || len(legacy) == 0 {
		return "", err
	}
	if _, err := validatedLegacyEvents(legacy); err != nil {
		return "", err
	}
	command := legacy[0].command
	for _, candidate := range legacy[1:] {
		if candidate.command != command {
			return "", fmt.Errorf("claude hooks: %w: legacy marker commands disagree", ErrHookConflict)
		}
	}
	return command, nil
}

func validateOwnedState(cfg map[string]any, spec hookSpec) error {
	hooks, err := hooksTable(cfg, false)
	if err != nil {
		return err
	}
	if hooks == nil {
		return fmt.Errorf("claude hooks: %w: ownership manifest exists but settings has no hooks", ErrHookConflict)
	}
	if legacy, err := legacyInventory(hooks); err != nil || len(legacy) != 0 {
		if err != nil {
			return err
		}
		return fmt.Errorf("claude hooks: %w: legacy marker coexists with ownership manifest", ErrHookConflict)
	}
	for _, event := range HookEvents {
		entries, present := hooks[event]
		if !present {
			return fmt.Errorf("claude hooks: %w: managed hooks.%s is missing", ErrHookConflict, event)
		}
		scan, err := scanEvent(event, entries, spec)
		if err != nil {
			return err
		}
		if scan.legacyGroups != 0 || scan.exactGroups != 1 || scan.exactHandlers != 1 {
			return fmt.Errorf("claude hooks: %w: hooks.%s drifted or has a duplicate command", ErrHookConflict, event)
		}
	}
	return nil
}

func mergeFreshInstall(cfg map[string]any, desired hookSpec, opts Options) error {
	hooks, err := hooksTable(cfg, true)
	if err != nil {
		return err
	}
	legacy, err := legacyInventory(hooks)
	if err != nil {
		return err
	}
	allLegacy := make([]string, 0, len(legacy))
	for _, candidate := range legacy {
		allLegacy = append(allLegacy, candidate.command)
	}
	for _, event := range HookEvents {
		entries, present := hooks[event]
		if !present {
			continue
		}
		scan, err := scanEvent(event, entries, desired)
		if err != nil {
			return err
		}
		if scan.exactHandlers != 0 {
			return fmt.Errorf("claude hooks: %w: hooks.%s already contains the requested command without ownership metadata", ErrHookConflict, event)
		}
		if opts.LegacyHookCommand != "" {
			legacyScan, err := scanEvent(event, entries, hookSpec{Type: "command", Command: opts.LegacyHookCommand})
			if err != nil {
				return err
			}
			if legacyScan.exactHandlers != 0 {
				return fmt.Errorf("claude hooks: %w: hooks.%s contains an unowned legacy command (marker may have been stripped)", ErrHookConflict, event)
			}
		}
	}

	if len(legacy) != 0 {
		legacyEvents, err := validatedLegacyEvents(legacy)
		if err != nil {
			return err
		}
		if !allLegacyCommandsAllowed(allLegacy, opts, desired) {
			return fmt.Errorf("claude hooks: %w: foreign legacy marker command", ErrHookConflict)
		}
		for _, command := range allLegacy[1:] {
			if command != allLegacy[0] {
				return fmt.Errorf("claude hooks: %w: legacy marker commands disagree", ErrHookConflict)
			}
		}
		legacySet := map[string]bool{}
		for _, event := range legacyEvents {
			legacySet[event] = true
			entries, present := hooks[event]
			if !present {
				return fmt.Errorf("claude hooks: %w: legacy hooks.%s is missing", ErrHookConflict, event)
			}
			arr := entries.([]any)
			replaced := false
			for i, rawGroup := range arr {
				group := rawGroup.(map[string]any)
				handlers, _ := group["hooks"].([]any)
				if len(handlers) != 1 {
					continue
				}
				handler, _ := handlers[0].(map[string]any)
				if _, safe := exactLegacyHandler(handler); safe {
					if replaced {
						return fmt.Errorf("claude hooks: %w: duplicate legacy hooks.%s", ErrHookConflict, event)
					}
					arr[i] = managedGroup(desired)
					replaced = true
				}
			}
			if !replaced {
				return fmt.Errorf("claude hooks: %w: legacy hooks.%s is incomplete", ErrHookConflict, event)
			}
			hooks[event] = arr
		}
		for _, event := range HookEvents {
			if legacySet[event] {
				continue
			}
			existing, present := hooks[event]
			if !present {
				hooks[event] = []any{managedGroup(desired)}
				continue
			}
			arr, ok := existing.([]any)
			if !ok {
				return fmt.Errorf("claude hooks: %w: existing hooks.%s is not an array", ErrHookConflict, event)
			}
			hooks[event] = append(append([]any(nil), arr...), managedGroup(desired))
		}
		return nil
	}

	for _, event := range HookEvents {
		existing, present := hooks[event]
		if !present {
			hooks[event] = []any{managedGroup(desired)}
			continue
		}
		arr := existing.([]any)
		hooks[event] = append(append([]any(nil), arr...), managedGroup(desired))
	}
	return nil
}

func mergeOwnedUninstall(cfg map[string]any, spec hookSpec) error {
	if err := validateOwnedState(cfg, spec); err != nil {
		return err
	}
	hooks, _ := hooksTable(cfg, false)
	for _, event := range HookEvents {
		arr := hooks[event].([]any)
		kept := make([]any, 0, len(arr)-1)
		removed := false
		for _, rawGroup := range arr {
			group := rawGroup.(map[string]any)
			if exactGroup(group, spec) {
				if removed {
					return fmt.Errorf("claude hooks: %w: duplicate managed hooks.%s", ErrHookConflict, event)
				}
				removed = true
				continue
			}
			kept = append(kept, rawGroup)
		}
		if len(kept) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = kept
		}
	}
	if len(hooks) == 0 {
		delete(cfg, "hooks")
	}
	return nil
}

func legacySpecForUninstall(cfg map[string]any) (hookSpec, []string, bool, error) {
	hooks, err := hooksTable(cfg, false)
	if err != nil || hooks == nil {
		return hookSpec{}, nil, false, err
	}
	legacy, err := legacyInventory(hooks)
	if err != nil {
		return hookSpec{}, nil, false, err
	}
	if len(legacy) == 0 {
		return hookSpec{}, nil, false, nil
	}
	events, err := validatedLegacyEvents(legacy)
	if err != nil {
		return hookSpec{}, nil, false, err
	}
	command := legacy[0].command
	for _, candidate := range legacy {
		if candidate.command != command {
			return hookSpec{}, nil, false, fmt.Errorf("claude hooks: %w: legacy marker commands disagree", ErrHookConflict)
		}
	}
	// The historical installer allowed an arbitrary explicit --hook-command.
	// Exact object shape, exact full event set, and one identical command across
	// all events prove ownership; imposing a suffix would strand valid custom
	// installations.
	return hookSpec{Type: "command", Command: command}, events, true, nil
}

func mergeLegacyUninstall(cfg map[string]any, legacy hookSpec, events []string) error {
	hooks, _ := hooksTable(cfg, false)
	for _, event := range events {
		arr, ok := hooks[event].([]any)
		if !ok {
			return fmt.Errorf("claude hooks: %w: legacy hooks.%s is missing", ErrHookConflict, event)
		}
		kept := make([]any, 0, len(arr)-1)
		removed := false
		for _, rawGroup := range arr {
			group, _ := rawGroup.(map[string]any)
			handlers, _ := group["hooks"].([]any)
			if len(handlers) == 1 {
				handler, _ := handlers[0].(map[string]any)
				command, safe := exactLegacyHandler(handler)
				if safe && command == legacy.Command && exactKeys(group, "matcher", "hooks") && group["matcher"] == "" {
					if removed {
						return fmt.Errorf("claude hooks: %w: duplicate legacy hooks.%s", ErrHookConflict, event)
					}
					removed = true
					continue
				}
			}
			kept = append(kept, rawGroup)
		}
		if !removed {
			return fmt.Errorf("claude hooks: %w: legacy hooks.%s is incomplete", ErrHookConflict, event)
		}
		if len(kept) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = kept
		}
	}
	if len(hooks) == 0 {
		delete(cfg, "hooks")
	}
	return nil
}

type ownershipManifest struct {
	Version           int      `json:"version"`
	Provider          string   `json:"provider"`
	SettingsFile      string   `json:"settings_file"`
	State             string   `json:"state"`
	Hook              hookSpec `json:"hook"`
	Events            []string `json:"events"`
	LegacyHookCommand string   `json:"legacy_hook_command,omitempty"`
	BeforeSHA256      string   `json:"before_sha256,omitempty"`
	AfterSHA256       string   `json:"after_sha256,omitempty"`
	raw               []byte
}

func activeManifest(spec hookSpec) ownershipManifest {
	return ownershipManifest{
		Version: manifestVersion, Provider: manifestProvider,
		SettingsFile: settingsFile, State: manifestStateLive,
		Hook: spec, Events: append([]string(nil), HookEvents...),
	}
}

func validateManifest(m ownershipManifest) error {
	if m.Version != manifestVersion || m.Provider != manifestProvider || m.SettingsFile != settingsFile {
		return fmt.Errorf("claude hooks: %w: ownership manifest identity/version is unsupported", ErrHookConflict)
	}
	if m.State != manifestStateLive && m.State != manifestStateAdd && m.State != manifestStateDrop {
		return fmt.Errorf("claude hooks: %w: ownership manifest state %q is invalid", ErrHookConflict, m.State)
	}
	if err := validateHookSpec(m.Hook); err != nil {
		return fmt.Errorf("claude hooks: %w: invalid ownership manifest hook: %v", ErrHookConflict, err)
	}
	if !reflect.DeepEqual(m.Events, HookEvents) {
		return fmt.Errorf("claude hooks: %w: ownership manifest event set drifted", ErrHookConflict)
	}
	if m.State == manifestStateLive {
		if m.LegacyHookCommand != "" || m.BeforeSHA256 != "" || m.AfterSHA256 != "" {
			return fmt.Errorf("claude hooks: %w: active manifest contains transaction digests", ErrHookConflict)
		}
	} else if len(m.BeforeSHA256) != sha256.Size*2 || len(m.AfterSHA256) != sha256.Size*2 {
		return fmt.Errorf("claude hooks: %w: pending manifest is missing transaction digests", ErrHookConflict)
	}
	return nil
}

func readManifest(dir string) (*ownershipManifest, error) {
	path := filepath.Join(dir, manifestFileName)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("claude hooks: stat ownership manifest: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("claude hooks: %w: ownership manifest is not a regular private file", ErrHookConflict)
	}
	if !manifestModeSecure(info.Mode(), runtime.GOOS) {
		return nil, fmt.Errorf("claude hooks: %w: ownership manifest mode is %04o, want 0600", ErrHookConflict, info.Mode().Perm())
	}
	if info.Size() > maxManifestBytes {
		return nil, fmt.Errorf("claude hooks: %w: ownership manifest is oversized", ErrHookConflict)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("claude hooks: read ownership manifest: %w", err)
	}
	var m ownershipManifest
	if err := decodeOneJSON(raw, &m, true); err != nil {
		return nil, fmt.Errorf("claude hooks: %w: ownership manifest is invalid: %v", ErrHookConflict, err)
	}
	if err := validateManifest(m); err != nil {
		return nil, err
	}
	m.raw = append([]byte(nil), raw...)
	return &m, nil
}

func manifestModeSecure(mode os.FileMode, goos string) bool {
	// Windows exposes readonly/writable through FileMode rather than POSIX
	// owner/group bits; a file created and chmodded 0600 commonly stats as
	// 0666. Access remains governed by the inherited ACL, so exact POSIX-mode
	// enforcement would reject our own sidecar on the next invocation.
	if goos == "windows" {
		return true
	}
	return mode.Perm() == defaultFileMode
}

func stateDigest(s *settings) string {
	h := sha256.New()
	if s.exists {
		_, _ = h.Write([]byte("present\x00"))
	} else {
		_, _ = h.Write([]byte("missing\x00"))
	}
	_, _ = h.Write(s.raw)
	return hex.EncodeToString(h.Sum(nil))
}

func renderedSettings(s *settings) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s.cfg); err != nil {
		return nil, fmt.Errorf("claude hooks: encode settings: %w", err)
	}
	return buf.Bytes(), nil
}

func pendingManifest(state string, spec hookSpec, legacyCommand, before string, after []byte) ownershipManifest {
	m := activeManifest(spec)
	m.State = state
	m.LegacyHookCommand = legacyCommand
	m.BeforeSHA256 = before
	h := sha256.New()
	_, _ = h.Write([]byte("present\x00"))
	_, _ = h.Write(after)
	m.AfterSHA256 = hex.EncodeToString(h.Sum(nil))
	return m
}

// recoverPending completes the only safe half-finished transaction. Hashes
// bind recovery to the exact bytes seen by the initiating operation; any user
// edit or unexplained state fails closed. Dry-run verifies recoverability but
// deliberately writes nothing.
func recoverPending(dir string, s *settings, m *ownershipManifest, dryRun bool, now time.Time) error {
	if m == nil || m.State == manifestStateLive {
		return nil
	}
	current := stateDigest(s)
	if current == m.AfterSHA256 {
		if dryRun {
			return nil
		}
		if m.State == manifestStateAdd {
			active := activeManifest(m.Hook)
			return writeManifestAtomic(dir, &active, m, s)
		}
		return removeManifest(dir, m, s)
	}
	if current != m.BeforeSHA256 {
		return fmt.Errorf("claude hooks: %w: pending %s transaction no longer matches settings", ErrHookConflict, m.State)
	}

	var err error
	switch m.State {
	case manifestStateAdd:
		err = mergeFreshInstall(s.cfg, m.Hook, Options{HookCommand: m.Hook.Command, HookArgs: m.Hook.Args, LegacyHookCommand: m.LegacyHookCommand})
	case manifestStateDrop:
		legacy, events, found, legacyErr := legacySpecForUninstall(s.cfg)
		if legacyErr != nil {
			err = legacyErr
		} else if found {
			if legacy.Command != m.Hook.Command {
				err = fmt.Errorf("claude hooks: %w: pending legacy uninstall command drifted", ErrHookConflict)
			} else {
				err = mergeLegacyUninstall(s.cfg, legacy, events)
			}
		} else {
			err = mergeOwnedUninstall(s.cfg, m.Hook)
		}
	}
	if err != nil {
		return fmt.Errorf("claude hooks: recover pending transaction: %w", err)
	}
	after, err := renderedSettings(s)
	if err != nil {
		return err
	}
	test := pendingManifest(m.State, m.Hook, m.LegacyHookCommand, m.BeforeSHA256, after)
	if test.AfterSHA256 != m.AfterSHA256 {
		return fmt.Errorf("claude hooks: %w: pending transaction output is not reproducible", ErrHookConflict)
	}
	if dryRun {
		return nil
	}
	if err := commitSettings(s, after, now, m); err != nil {
		return err
	}
	committed := committedSettingsSnapshot(s, after)
	if m.State == manifestStateAdd {
		active := activeManifest(m.Hook)
		return writeManifestAtomic(dir, &active, m, committed)
	}
	return removeManifest(dir, m, committed)
}

// InstallHooks adds one schema-valid matcher group per managed event.
func InstallHooks(opts Options) error {
	desired, err := specFromOptions(opts)
	if err != nil {
		return err
	}
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return err
	}
	operation := func() error {
		s, err := readSettings(dir)
		if err != nil {
			return err
		}
		m, err := readManifest(dir)
		if err != nil {
			return err
		}
		if m != nil && m.State != manifestStateLive {
			pendingState := m.State
			if m.State == manifestStateAdd && !reflect.DeepEqual(m.Hook, desired) {
				return fmt.Errorf("claude hooks: %w: pending install uses a different command", ErrHookConflict)
			}
			if err := recoverPending(dir, s, m, opts.DryRun, opts.now()); err != nil {
				return err
			}
			if opts.DryRun {
				if pendingState == manifestStateAdd {
					active := activeManifest(m.Hook)
					m = &active
				} else {
					m = nil
				}
			} else {
				s, err = readSettings(dir)
				if err != nil {
					return err
				}
				m, err = readManifest(dir)
				if err != nil {
					return err
				}
			}
		}
		if m != nil {
			if !reflect.DeepEqual(m.Hook, desired) {
				return fmt.Errorf("claude hooks: %w: installed command differs; uninstall first", ErrHookConflict)
			}
			return validateOwnedState(s.cfg, m.Hook)
		}

		before := stateDigest(s)
		legacyCommand, err := legacyCommandInConfig(s.cfg)
		if err != nil {
			return err
		}
		if err := mergeFreshInstall(s.cfg, desired, opts); err != nil {
			return err
		}
		after, err := renderedSettings(s)
		if err != nil {
			return err
		}
		pending := pendingManifest(manifestStateAdd, desired, legacyCommand, before, after)
		if opts.DryRun {
			return nil
		}
		if err := writeManifestAtomic(dir, &pending, nil, s); err != nil {
			return err
		}
		if err := commitSettings(s, after, opts.now(), &pending); err != nil {
			// A compare-before-rename conflict means settings were not changed by
			// us. Remove the fresh pending manifest so external state is left
			// exactly as the other writer published it.
			if errors.Is(err, ErrHookConflict) {
				_ = removeManifest(dir, &pending, nil)
			}
			return err
		}
		active := activeManifest(desired)
		return writeManifestAtomic(dir, &active, &pending, committedSettingsSnapshot(s, after))
	}
	// Dry-run is observational: it must not create the config directory or
	// even a transient lock file.
	if opts.DryRun {
		return operation()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("claude hooks: create config directory: %w", err)
	}
	return withLock(dir, opts.lockTimeout(), operation)
}

// UninstallHooks removes only groups positively owned by the sidecar. A full,
// exact legacy marker set from the old installer can also be removed safely.
func UninstallHooks(opts Options) error {
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return err
	}
	operation := func() error {
		s, err := readSettings(dir)
		if err != nil {
			return err
		}
		m, err := readManifest(dir)
		if err != nil {
			return err
		}
		if m != nil && m.State != manifestStateLive {
			pendingState := m.State
			if err := recoverPending(dir, s, m, opts.DryRun, opts.now()); err != nil {
				return err
			}
			if opts.DryRun {
				if pendingState == manifestStateAdd {
					active := activeManifest(m.Hook)
					m = &active
				} else {
					m = nil
				}
			} else {
				s, err = readSettings(dir)
				if err != nil {
					return err
				}
				m, err = readManifest(dir)
				if err != nil {
					return err
				}
			}
		}

		var spec hookSpec
		legacyCommand := ""
		if m != nil {
			spec = m.Hook
			if err := mergeOwnedUninstall(s.cfg, spec); err != nil {
				return err
			}
		} else {
			legacy, events, found, err := legacySpecForUninstall(s.cfg)
			if err != nil || !found {
				return err
			}
			spec = legacy
			legacyCommand = legacy.Command
			if err := mergeLegacyUninstall(s.cfg, legacy, events); err != nil {
				return err
			}
		}

		after, err := renderedSettings(s)
		if err != nil {
			return err
		}
		pending := pendingManifest(manifestStateDrop, spec, legacyCommand, stateDigest(s), after)
		if opts.DryRun {
			return nil
		}
		if err := writeManifestAtomic(dir, &pending, m, s); err != nil {
			return err
		}
		if err := commitSettings(s, after, opts.now(), &pending); err != nil {
			// Restore the active ownership record when our settings compare
			// failed; the exact managed groups are still present.
			if errors.Is(err, ErrHookConflict) && m != nil {
				active := activeManifest(spec)
				_ = writeManifestAtomic(dir, &active, &pending, s)
			} else if errors.Is(err, ErrHookConflict) {
				_ = removeManifest(dir, &pending, nil)
			}
			return err
		}
		return removeManifest(dir, &pending, committedSettingsSnapshot(s, after))
	}
	if opts.DryRun {
		return operation()
	}
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("claude hooks: stat config directory: %w", err)
	}
	return withLock(dir, opts.lockTimeout(), operation)
}

// InstalledHookEvents validates the sidecar and settings and returns the
// complete managed event set. It never infers ownership from an unmarked
// command. Pending transactions require the next mutating operation to recover.
func InstalledHookEvents(opts Options) ([]string, error) {
	dir, err := resolveConfigDir(opts.ConfigDir)
	if err != nil {
		return nil, err
	}
	s, err := readSettings(dir)
	if err != nil {
		return nil, err
	}
	m, err := readManifest(dir)
	if err != nil {
		return nil, err
	}
	if m == nil {
		_, events, found, err := legacySpecForUninstall(s.cfg)
		if err != nil || !found {
			return nil, err
		}
		return append([]string(nil), events...), nil
	}
	if m.State != manifestStateLive {
		return nil, fmt.Errorf("claude hooks: %w: ownership transaction is pending", ErrHookConflict)
	}
	if err := validateOwnedState(s.cfg, m.Hook); err != nil {
		return nil, err
	}
	return append([]string(nil), HookEvents...), nil
}

func commitSettings(s *settings, data []byte, now time.Time, expectedManifest *ownershipManifest) error {
	if err := snapshotUnchanged(s); err != nil {
		return err
	}
	manifestDir := filepath.Dir(s.path)
	if err := snapshotManifest(manifestDir, expectedManifest); err != nil {
		return err
	}
	if s.exists {
		if err := writeBackup(s, now); err != nil {
			return err
		}
	}
	if err := writeAtomic(s.path, data, s.mode, ".hfg-settings-*.json", func() error {
		beforeSettingsRename()
		if err := snapshotUnchanged(s); err != nil {
			return err
		}
		return snapshotManifest(manifestDir, expectedManifest)
	}); err != nil {
		return fmt.Errorf("claude hooks: write settings: %w", err)
	}
	return nil
}

func committedSettingsSnapshot(s *settings, data []byte) *settings {
	return &settings{
		path:   s.path,
		raw:    append([]byte(nil), data...),
		mode:   s.mode,
		exists: true,
	}
}

// beforeSettingsRename is a deterministic test seam for an external writer
// racing the final compare-and-rename window.
var beforeSettingsRename = func() {}

func snapshotUnchanged(s *settings) error {
	info, err := os.Lstat(s.path)
	if !s.exists {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("claude hooks: verify settings snapshot: %w", err)
		}
		return fmt.Errorf("claude hooks: %w: settings appeared during hook update", ErrHookConflict)
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("claude hooks: %w: settings disappeared during hook update", ErrHookConflict)
		}
		return fmt.Errorf("claude hooks: verify settings snapshot: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() || !settingsModeUnchanged(info.Mode(), s.mode, runtime.GOOS) {
		return fmt.Errorf("claude hooks: %w: settings type or mode changed during hook update", ErrHookConflict)
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return fmt.Errorf("claude hooks: verify settings snapshot: %w", err)
	}
	if !bytes.Equal(raw, s.raw) {
		return fmt.Errorf("claude hooks: %w: settings changed during hook update", ErrHookConflict)
	}
	return nil
}

func settingsModeUnchanged(actual, expected os.FileMode, goos string) bool {
	if goos == "windows" {
		// Go's Windows file mode maps only the owner-write bit to the native
		// readonly attribute. Other permission bits commonly stat as 0666/0444,
		// including for a file created with mode 0600.
		return actual.Perm()&0o200 == expected.Perm()&0o200
	}
	return actual.Perm() == expected.Perm()
}

func writeBackup(s *settings, now time.Time) error {
	base := s.path + ".hfg-backup-" + now.UTC().Format("20060102T150405Z")
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".hfg-backup-*.tmp")
	if err != nil {
		return fmt.Errorf("claude hooks: create backup temp: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(defaultFileMode); err != nil {
		discard()
		return fmt.Errorf("claude hooks: set backup mode: %w", err)
	}
	if _, err := tmp.Write(s.raw); err != nil {
		discard()
		return fmt.Errorf("claude hooks: write backup temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return fmt.Errorf("claude hooks: sync backup temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("claude hooks: close backup temp: %w", err)
	}
	for i := 0; ; i++ {
		backup := base
		if i > 0 {
			backup = fmt.Sprintf("%s-%d", base, i)
		}
		if err := os.Link(tmpName, backup); err == nil {
			if syncErr := syncParentDir(backup); syncErr != nil {
				_ = os.Remove(tmpName)
				return fmt.Errorf("claude hooks: publish backup %s: %w", backup, syncErr)
			}
			_ = os.Remove(tmpName)
			return nil
		} else if errors.Is(err, fs.ErrExist) {
			continue
		} else {
			_ = os.Remove(tmpName)
			return fmt.Errorf("claude hooks: publish backup %s: %w", backup, err)
		}
	}
}

func writeManifestAtomic(dir string, m *ownershipManifest, expected *ownershipManifest, expectedSettings *settings) error {
	if m == nil {
		return errors.New("claude hooks: nil ownership manifest")
	}
	if err := validateManifest(*m); err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("claude hooks: encode ownership manifest: %w", err)
	}
	data = append(data, '\n')
	if err := writeAtomic(filepath.Join(dir, manifestFileName), data, defaultFileMode, ".hfg-manifest-*.json", func() error {
		beforeManifestMutation()
		if err := snapshotManifest(dir, expected); err != nil {
			return err
		}
		if expectedSettings != nil {
			return snapshotUnchanged(expectedSettings)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("claude hooks: write ownership manifest: %w", err)
	}
	m.raw = append([]byte(nil), data...)
	return nil
}

// beforeManifestMutation is a deterministic seam for testing an external
// sidecar edit immediately before rename/remove.
var beforeManifestMutation = func() {}

func snapshotManifest(dir string, expected *ownershipManifest) error {
	path := filepath.Join(dir, manifestFileName)
	info, err := os.Lstat(path)
	if expected == nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("claude hooks: verify ownership manifest snapshot: %w", err)
		}
		return fmt.Errorf("claude hooks: %w: ownership manifest appeared during update", ErrHookConflict)
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("claude hooks: %w: ownership manifest disappeared during update", ErrHookConflict)
		}
		return fmt.Errorf("claude hooks: verify ownership manifest snapshot: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() || !manifestModeSecure(info.Mode(), runtime.GOOS) {
		return fmt.Errorf("claude hooks: %w: ownership manifest type or mode changed during update", ErrHookConflict)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("claude hooks: verify ownership manifest snapshot: %w", err)
	}
	if len(expected.raw) == 0 || !bytes.Equal(raw, expected.raw) {
		return fmt.Errorf("claude hooks: %w: ownership manifest changed during update", ErrHookConflict)
	}
	return nil
}

func writeAtomic(path string, data []byte, mode os.FileMode, pattern string, beforeRename func() error) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), pattern)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(mode); err != nil {
		discard()
		return fmt.Errorf("set temp mode: %w", err)
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
		_ = os.Remove(tmpName)
		return fmt.Errorf("close temp file: %w", err)
	}
	if beforeRename != nil {
		if err := beforeRename(); err != nil {
			_ = os.Remove(tmpName)
			return err
		}
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return syncParentDir(path)
}

func removeManifest(dir string, expected *ownershipManifest, expectedSettings *settings) error {
	path := filepath.Join(dir, manifestFileName)
	beforeManifestMutation()
	if err := snapshotManifest(dir, expected); err != nil {
		return err
	}
	if expectedSettings != nil {
		if err := snapshotUnchanged(expectedSettings); err != nil {
			return err
		}
	}
	if expected == nil {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("claude hooks: remove ownership manifest: %w", err)
	}
	return syncParentDir(path)
}

func syncParentDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open parent directory: %w", err)
	}
	if err := dir.Sync(); err != nil {
		_ = dir.Close()
		if errors.Is(err, syscall.EINVAL) {
			return nil
		}
		return fmt.Errorf("sync parent directory: %w", err)
	}
	return dir.Close()
}

func withLock(dir string, timeout time.Duration, fn func() error) error {
	lockPath := filepath.Join(dir, lockFileName)
	deadline := time.Now().Add(timeout)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, defaultFileMode)
		if err == nil {
			owned, statErr := f.Stat()
			if statErr != nil {
				_ = f.Close()
				_ = os.Remove(lockPath)
				return fmt.Errorf("claude hooks: identify acquired lock %s: %w", lockPath, statErr)
			}
			runErr := fn()
			if closeErr := f.Close(); closeErr != nil {
				runErr = errors.Join(runErr, closeErr)
			}
			if removeErr := removeOwnedLock(lockPath, owned); removeErr != nil {
				runErr = errors.Join(runErr, removeErr)
			}
			return runErr
		}
		if !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("claude hooks: acquire lock %s: %w", lockPath, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("claude hooks: another hooks operation holds %s (timed out after %s); if a previous process crashed, verify no hook operation is active before removing the lock", lockPath, timeout)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func removeOwnedLock(path string, owned fs.FileInfo) error {
	current, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("claude hooks: acquired lock %s disappeared before release", path)
		}
		return fmt.Errorf("claude hooks: inspect acquired lock %s before release: %w", path, err)
	}
	if !os.SameFile(owned, current) {
		return fmt.Errorf("claude hooks: lock ownership changed at %s; refusing to remove another operation's lock", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("claude hooks: release lock %s: %w", path, err)
	}
	return nil
}

// sortedKeys is used by tests and diagnostics to assert the closed handler
// schema without depending on map iteration order.
func sortedKeys(obj map[string]any) []string {
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
