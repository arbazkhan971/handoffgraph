// Package codexhooks installs HandoffGraph command hooks in Codex's
// config.toml without re-encoding user configuration.
package codexhooks

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/handoffgraph/handoffgraph/internal/lockfile"
)

const (
	ConfigFile         = "config.toml"
	marker             = "# hfg:managed"
	metaPrefix         = "# hfg:prefix-newline="
	backupPrefix       = "hfg-backup-"
	lockFileName       = ".hfg-hooks.lock"
	defaultLockTimeout = 5 * time.Second
	lockTokenBytes     = 32
)

type lockOwnership struct {
	info  fs.FileInfo
	token string
}

// ErrHookConflict means the installer could not prove that a hook fragment
// belongs to HandoffGraph. The config is left untouched in that case.
var ErrHookConflict = errors.New("codex hooks: refusing to overwrite existing user hook configuration")

// ManagedEvents is the complete HooksToml event surface in Codex 0.144.3.
// Keep these exact, case-sensitive names: they are serialized enum variants.
var ManagedEvents = []string{
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

var legacyEvents = map[string]bool{
	"post_tool_use": true,
	"pre_tool_use":  true,
	"session_end":   true,
	"session_start": true,
	"turn_end":      true,
	"turn_start":    true,
}

type Options struct {
	Command        string
	CommandWindows string
	DryRun         bool
	LockTimeout    time.Duration
	Now            func() time.Time
}

type Result struct {
	Changed bool
	Backup  string
	Entries []string
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

// Install adds one matcher group for every supported event. Existing user
// groups are additive: their bytes and order are never changed, and a new HFG
// group is appended after them. The marker owns every byte the installer adds.
func Install(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks install"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	if opts.Command == "" {
		return nil, errors.New(op + ": hook command must not be empty")
	}
	if opts.DryRun {
		return install(configDir, opts)
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, fmt.Errorf("%s: create config directory: %w", op, err)
	}
	var result *Result
	err := withLock(configDir, opts.lockTimeout(), func() error {
		var err error
		result, err = install(configDir, opts)
		return err
	})
	return result, err
}

func install(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks install"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	if opts.Command == "" {
		return nil, errors.New(op + ": hook command must not be empty")
	}

	path := filepath.Join(configDir, ConfigFile)
	original, mode, existed, err := readConfigFile(op, path)
	if err != nil {
		return nil, err
	}
	before, err := analyzeConfig(op, original, opts.Command, opts.CommandWindows, true)
	if err != nil {
		return nil, err
	}
	baseline, err := stripManaged(original, before.regions)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}

	// Remove obsolete marker-owned singleton tables and reassert drifted
	// current groups in place. Replacing in place preserves all group indices.
	var edits []textEdit
	for _, region := range before.regions {
		switch region.kind {
		case regionLegacy:
			edits = append(edits, textEdit{start: region.start, end: region.end})
		case regionAOT, regionInline:
			want := entryCommand(opts.Command, region.event)
			wantWindows := region.commandWindows
			if opts.CommandWindows != "" {
				wantWindows = entryCommand(opts.CommandWindows, region.event)
			}
			if region.command == want && region.commandWindows == wantWindows {
				continue
			}
			replacement := renderAOTWithWindows(region.event, want, wantWindows, region.prefixNewline)
			if region.kind == regionInline {
				replacement = renderInlineWithWindows(region.event, want, wantWindows, region.prefixNewline, region.leadingComma)
			}
			edits = append(edits, textEdit{start: region.start, end: region.end, replacement: replacement})
		}
	}
	interim, err := applyTextEdits(original, edits)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	mid, err := analyzeConfig(op, interim, opts.Command, opts.CommandWindows, true)
	if err != nil {
		return nil, err
	}

	// Inline-array events must stay inline because TOML forbids redefining an
	// array value as an array-of-tables. All other groups can be appended as
	// canonical array-of-tables entries at EOF.
	var additions []textEdit
	var appendText strings.Builder
	appendNeedsNewline := len(interim) > 0 && interim[len(interim)-1] != '\n'
	for _, event := range ManagedEvents {
		if _, installed := mid.current[event]; installed {
			continue
		}
		want := entryCommand(opts.Command, event)
		if inline, ok := mid.syntax.inline[event]; ok {
			groups := mid.groups[event]
			leadingComma := len(groups) > 0 && lastSignificant(interim[inline.open+1:inline.close]) != ','
			prefixNewline := inline.insert > 0 && interim[inline.insert-1] != '\n'
			additions = append(additions, textEdit{
				start:       inline.insert,
				end:         inline.insert,
				replacement: renderInlineWithWindows(event, want, opts.CommandWindows, prefixNewline, leadingComma),
			})
			continue
		}
		appendText.WriteString(renderAOTWithWindows(event, want, opts.CommandWindows, appendNeedsNewline))
		appendNeedsNewline = false
	}
	if appendText.Len() > 0 {
		additions = append(additions, textEdit{
			start:       len(interim),
			end:         len(interim),
			replacement: appendText.String(),
		})
	}
	finalText, err := applyTextEdits(interim, additions)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	final, err := analyzeConfig(op, finalText, opts.Command, opts.CommandWindows, true)
	if err != nil {
		return nil, fmt.Errorf("%s: generated configuration failed validation: %w", op, err)
	}
	for _, event := range ManagedEvents {
		region, ok := final.current[event]
		if !ok || region.command != entryCommand(opts.Command, event) ||
			(opts.CommandWindows != "" && region.commandWindows != entryCommand(opts.CommandWindows, event)) {
			return nil, fmt.Errorf("%s: generated configuration is missing managed %s", op, event)
		}
	}
	if len(final.legacy) != 0 {
		return nil, fmt.Errorf("%s: generated configuration retained legacy managed hooks", op)
	}
	withoutManaged, err := stripManaged(finalText, final.regions)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	if withoutManaged != baseline {
		return nil, fmt.Errorf("%s: merge validation failed: non-managed bytes changed; original left untouched", op)
	}

	entries := append([]string(nil), ManagedEvents...)
	changed := finalText != original
	if !changed || opts.DryRun {
		return &Result{Changed: changed, Entries: entries}, nil
	}
	backup := ""
	if existed {
		if err := ensureConfigUnchanged(op, path, original, mode, true); err != nil {
			return nil, err
		}
		backup, err = backupOriginal(path, original, mode, opts.now())
		if err != nil {
			return nil, fmt.Errorf("%s: %w", op, err)
		}
	}
	if err := writeFileAtomic(path, finalText, mode, original, existed, op); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return &Result{Changed: true, Backup: backup, Entries: entries}, nil
}

// Uninstall removes only safely recognized marker-owned current and legacy
// fragments. It never rewrites or deletes user state.
func Uninstall(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks uninstall"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	if opts.DryRun {
		return uninstall(configDir, opts)
	}
	if _, err := os.Stat(configDir); errors.Is(err, fs.ErrNotExist) {
		return &Result{}, nil
	} else if err != nil {
		return nil, fmt.Errorf("%s: stat config directory: %w", op, err)
	}
	var result *Result
	err := withLock(configDir, opts.lockTimeout(), func() error {
		var err error
		result, err = uninstall(configDir, opts)
		return err
	})
	return result, err
}

func uninstall(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks uninstall"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	path := filepath.Join(configDir, ConfigFile)
	original, mode, existed, err := readConfigFile(op, path)
	if err != nil {
		return nil, err
	}
	if !existed {
		return &Result{}, nil
	}
	parsed, err := analyzeConfig(op, original, "", "", false)
	if err != nil {
		return nil, err
	}
	if len(parsed.regions) == 0 {
		return &Result{}, nil
	}
	cleaned, err := stripManaged(original, parsed.regions)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	if _, err := analyzeConfig(op, cleaned, "", "", false); err != nil {
		return nil, fmt.Errorf("%s: cleaned configuration failed validation; original untouched: %w", op, err)
	}
	if opts.DryRun {
		return &Result{Changed: true}, nil
	}
	if err := ensureConfigUnchanged(op, path, original, mode, true); err != nil {
		return nil, err
	}
	backup, err := backupOriginal(path, original, mode, opts.now())
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	if err := writeFileAtomic(path, cleaned, mode, original, true, op); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return &Result{Changed: true, Backup: backup}, nil
}

func entryCommand(base, _ string) string { return base }

type regionKind uint8

const (
	regionAOT regionKind = iota + 1
	regionInline
	regionLegacy
)

type managedRegion struct {
	kind           regionKind
	event          string
	start          int
	end            int
	prefixNewline  bool
	leadingComma   bool
	groupIndex     int
	command        string
	commandWindows string
}

type sourceLine struct {
	start int
	end   int // excludes newline
	full  int // includes newline when present
	text  string
}

type header struct {
	valid   bool
	array   bool
	path    []string
	comment string
}

type inlineArray struct {
	event  string
	open   int
	close  int
	insert int
}

type aotGroup struct {
	event string
	line  int
}

type syntaxInfo struct {
	lines   []sourceLine
	headers map[int]header
	inline  map[string]inlineArray
	aot     map[string][]aotGroup
	outside []bool
}

type configAnalysis struct {
	syntax  syntaxInfo
	groups  map[string][]map[string]any
	regions []managedRegion
	current map[string]managedRegion
	legacy  []managedRegion
}

func analyzeConfig(op, text, desiredBase, desiredWindows string, checkCollision bool) (*configAnalysis, error) {
	decoded, err := decodeConfig(op, text)
	if err != nil {
		return nil, err
	}
	syntax, err := scanSyntax(text)
	if err != nil {
		return nil, conflict(op, err.Error())
	}

	result := &configAnalysis{
		syntax:  syntax,
		groups:  make(map[string][]map[string]any),
		current: make(map[string]managedRegion),
	}
	hooks := map[string]any{}
	if raw, ok := decoded["hooks"]; ok {
		var shapeOK bool
		hooks, shapeOK = raw.(map[string]any)
		if !shapeOK {
			return nil, conflict(op, "existing hooks entry is not a table")
		}
	}
	for _, event := range ManagedEvents {
		raw, present := hooks[event]
		if !present {
			continue
		}
		groups, ok := mapSlice(raw)
		if !ok {
			return nil, conflict(op, fmt.Sprintf("hooks.%s is not an array of matcher groups", event))
		}
		result.groups[event] = groups
		inline, isInline := syntax.inline[event]
		aot := syntax.aot[event]
		switch {
		case isInline && len(aot) != 0:
			return nil, conflict(op, fmt.Sprintf("hooks.%s has ambiguous inline and array-of-tables definitions", event))
		case isInline:
			if inline.close <= inline.open {
				return nil, conflict(op, fmt.Sprintf("hooks.%s inline array cannot be located safely", event))
			}
		case len(aot) != len(groups):
			return nil, conflict(op, fmt.Sprintf("hooks.%s matcher groups cannot be mapped safely", event))
		case len(aot) == 0:
			return nil, conflict(op, fmt.Sprintf("hooks.%s uses an unsupported or ambiguous key form", event))
		}
	}

	regions, err := scanManagedRegions(op, text, syntax, result.groups)
	if err != nil {
		return nil, err
	}
	hasCurrent, hasLegacy := false, false
	for _, region := range regions {
		if region.kind == regionLegacy {
			hasLegacy = true
		} else {
			hasCurrent = true
		}
	}
	if hasCurrent && hasLegacy {
		return nil, conflict(op, "mixed legacy and current managed markers are ambiguous")
	}
	result.regions = regions
	for i := range result.regions {
		region := &result.regions[i]
		if region.kind == regionLegacy {
			command, err := validateLegacyRegion(op, text, *region)
			if err != nil {
				return nil, err
			}
			region.command = command
			result.legacy = append(result.legacy, *region)
			continue
		}
		groups := result.groups[region.event]
		if region.groupIndex < 0 || region.groupIndex >= len(groups) {
			return nil, conflict(op, fmt.Sprintf("managed hooks.%s group index is ambiguous", region.event))
		}
		command, commandWindows, ok := canonicalGroupCommands(groups[region.groupIndex])
		if !ok {
			return nil, conflict(op, fmt.Sprintf("managed hooks.%s group has a malformed matcher or handler shape", region.event))
		}
		region.command = command
		region.commandWindows = commandWindows
		if _, duplicate := result.current[region.event]; duplicate {
			return nil, conflict(op, fmt.Sprintf("duplicate managed marker for hooks.%s", region.event))
		}
		result.current[region.event] = *region
	}
	// Copy the populated regions back into current after command validation.
	for _, region := range result.regions {
		if region.kind != regionLegacy {
			result.current[region.event] = region
		}
	}
	if len(result.legacy) != 0 {
		if err := validateLegacySet(op, result.legacy); err != nil {
			return nil, err
		}
	}

	if checkCollision {
		for _, event := range ManagedEvents {
			want := entryCommand(desiredBase, event)
			managedIndex := -1
			if managed, ok := result.current[event]; ok {
				managedIndex = managed.groupIndex
			}
			for groupIndex, group := range result.groups[event] {
				handlers, ok := mapSlice(group["hooks"])
				if !ok {
					continue
				}
				for _, handler := range handlers {
					command, _ := handler["command"].(string)
					commandWindows, windowsPresent, windowsValid := handlerWindowsCommand(handler)
					if windowsPresent && !windowsValid {
						return nil, conflict(op, fmt.Sprintf("hooks.%s handler has ambiguous or malformed Windows command fields", event))
					}
					typ, _ := handler["type"].(string)
					windowsCollision := desiredWindows != "" && commandWindows == entryCommand(desiredWindows, event)
					if typ == "command" && (command == want || windowsCollision) && groupIndex != managedIndex {
						return nil, conflict(op, fmt.Sprintf("unmarked exact HandoffGraph command already exists in hooks.%s", event))
					}
				}
			}
		}
	}
	return result, nil
}

func conflict(op, detail string) error {
	return fmt.Errorf("%s: %w: %s", op, ErrHookConflict, detail)
}

func decodeConfig(op, text string) (map[string]any, error) {
	var decoded map[string]any
	if _, err := toml.Decode(text, &decoded); err != nil {
		return nil, fmt.Errorf("%s: %s is unparseable as TOML; it was NOT modified: %w", op, ConfigFile, err)
	}
	if decoded == nil {
		decoded = map[string]any{}
	}
	return decoded, nil
}

func mapSlice(value any) ([]map[string]any, bool) {
	switch typed := value.(type) {
	case []map[string]any:
		return typed, true
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, false
			}
			out = append(out, m)
		}
		return out, true
	default:
		return nil, false
	}
}

func canonicalGroupCommand(group map[string]any) (string, bool) {
	command, _, ok := canonicalGroupCommands(group)
	return command, ok
}

func canonicalGroupCommands(group map[string]any) (string, string, bool) {
	if len(group) != 2 {
		return "", "", false
	}
	matcher, ok := group["matcher"].(string)
	if !ok || matcher != "" {
		return "", "", false
	}
	handlers, ok := mapSlice(group["hooks"])
	if !ok || len(handlers) != 1 || (len(handlers[0]) != 2 && len(handlers[0]) != 3) {
		return "", "", false
	}
	handler := handlers[0]
	for key := range handler {
		if key != "type" && key != "command" && key != "commandWindows" && key != "command_windows" {
			return "", "", false
		}
	}
	typ, typeOK := handler["type"].(string)
	command, commandOK := handler["command"].(string)
	commandWindows, _, windowsOK := handlerWindowsCommand(handler)
	if !windowsOK {
		return "", "", false
	}
	return command, commandWindows, typeOK && commandOK && typ == "command"
}

// Codex 0.144.3 serializes commandWindows and accepts command_windows as a
// compatibility alias. Treat them as one execution identity, while rejecting
// duplicate spellings so ownership and collision checks cannot disagree with
// Codex's deserializer.
func handlerWindowsCommand(handler map[string]any) (value string, present, valid bool) {
	camel, hasCamel := handler["commandWindows"]
	snake, hasSnake := handler["command_windows"]
	if hasCamel && hasSnake {
		return "", true, false
	}
	if !hasCamel && !hasSnake {
		return "", false, true
	}
	raw := camel
	if hasSnake {
		raw = snake
	}
	value, ok := raw.(string)
	return value, true, ok && value != ""
}

func scanSyntax(text string) (syntaxInfo, error) {
	info := syntaxInfo{
		lines:   splitSourceLines(text),
		headers: make(map[int]header),
		inline:  make(map[string]inlineArray),
		aot:     make(map[string][]aotGroup),
		outside: tomlOutsideStringMask(text),
	}
	inHooks := false
	for i, line := range info.lines {
		// The line-oriented structure scanner must not interpret TOML-looking
		// content inside a multiline string as a header, hook assignment, or
		// ownership marker.
		if !lineStartsOutsideString(info, line) {
			continue
		}
		h := parseHeader(line.text)
		if h.valid {
			info.headers[i] = h
			inHooks = !h.array && pathEqual(h.path, "hooks")
			if h.array && len(h.path) == 2 && h.path[0] == "hooks" && isManagedEvent(h.path[1]) {
				info.aot[h.path[1]] = append(info.aot[h.path[1]], aotGroup{event: h.path[1], line: i})
			}
			continue
		}
		if !inHooks {
			continue
		}
		inline, ok, err := parseInlineAssignment(text, line)
		if err != nil {
			return info, err
		}
		if !ok || !isManagedEvent(inline.event) {
			continue
		}
		if _, duplicate := info.inline[inline.event]; duplicate {
			return info, fmt.Errorf("duplicate inline assignment for hooks.%s", inline.event)
		}
		info.inline[inline.event] = inline
	}
	return info, nil
}

func splitSourceLines(text string) []sourceLine {
	if text == "" {
		return nil
	}
	var lines []sourceLine
	for start := 0; start < len(text); {
		rel := strings.IndexByte(text[start:], '\n')
		if rel < 0 {
			lines = append(lines, sourceLine{start: start, end: len(text), full: len(text), text: text[start:]})
			break
		}
		end := start + rel
		lines = append(lines, sourceLine{start: start, end: end, full: end + 1, text: text[start:end]})
		start = end + 1
	}
	return lines
}

// tomlOutsideStringMask records every byte that is structural TOML rather
// than string content. String delimiters themselves are structural so region
// boundaries still include the closing line of a multiline value. The '#'
// that begins a comment is also structural; the rest of the comment is not.
// The TOML decoder runs before this scanner, so malformed or unterminated
// strings have already failed closed.
func tomlOutsideStringMask(text string) []bool {
	const (
		lexNormal = iota
		lexComment
		lexBasic
		lexLiteral
		lexMultilineBasic
		lexMultilineLiteral
	)

	outside := make([]bool, len(text))
	state := lexNormal
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch state {
		case lexNormal:
			outside[i] = true
			switch c {
			case '#':
				state = lexComment
			case '"':
				if i+2 < len(text) && text[i+1] == '"' && text[i+2] == '"' {
					outside[i+1], outside[i+2] = true, true
					i += 2
					state = lexMultilineBasic
				} else {
					state = lexBasic
				}
			case '\'':
				if i+2 < len(text) && text[i+1] == '\'' && text[i+2] == '\'' {
					outside[i+1], outside[i+2] = true, true
					i += 2
					state = lexMultilineLiteral
				} else {
					state = lexLiteral
				}
			}
		case lexComment:
			if c == '\n' {
				outside[i] = true
				state = lexNormal
			}
		case lexBasic:
			if c == '\\' && i+1 < len(text) {
				i++
				continue
			}
			if c == '"' {
				outside[i] = true
				state = lexNormal
			}
		case lexLiteral:
			if c == '\'' {
				outside[i] = true
				state = lexNormal
			}
		case lexMultilineBasic:
			if c == '\\' && i+1 < len(text) {
				i++
				continue
			}
			if c != '"' {
				continue
			}
			run := 1
			for i+run < len(text) && text[i+run] == '"' {
				run++
			}
			if run >= 3 {
				for j := 0; j < run; j++ {
					outside[i+j] = true
				}
				i += run - 1
				state = lexNormal
			} else {
				i += run - 1
			}
		case lexMultilineLiteral:
			if c != '\'' {
				continue
			}
			run := 1
			for i+run < len(text) && text[i+run] == '\'' {
				run++
			}
			if run >= 3 {
				for j := 0; j < run; j++ {
					outside[i+j] = true
				}
				i += run - 1
				state = lexNormal
			} else {
				i += run - 1
			}
		}
	}
	return outside
}

func byteOutsideString(syntax syntaxInfo, offset int) bool {
	return offset >= 0 && offset < len(syntax.outside) && syntax.outside[offset]
}

func lineStartsOutsideString(syntax syntaxInfo, line sourceLine) bool {
	for i := 0; i < len(line.text); i++ {
		switch line.text[i] {
		case ' ', '\t', '\r':
			continue
		default:
			return byteOutsideString(syntax, line.start+i)
		}
	}
	return false
}

func lineHasOutsideCode(syntax syntaxInfo, line sourceLine) bool {
	for i := 0; i < len(line.text); i++ {
		if !byteOutsideString(syntax, line.start+i) {
			continue
		}
		switch line.text[i] {
		case ' ', '\t', '\r':
			continue
		case '#':
			return false
		default:
			return true
		}
	}
	return false
}

func parseHeader(line string) header {
	code, comment := splitComment(line)
	trimmed := strings.TrimSpace(code)
	result := header{comment: strings.TrimSpace(comment)}
	var inner string
	switch {
	case strings.HasPrefix(trimmed, "[[") && strings.HasSuffix(trimmed, "]]"):
		result.array = true
		inner = strings.TrimSpace(trimmed[2 : len(trimmed)-2])
	case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
		inner = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
	default:
		return result
	}
	if inner == "" {
		return result
	}
	parts := strings.Split(inner, ".")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
		if parts[i] == "" {
			return result
		}
	}
	result.valid = true
	result.path = parts
	return result
}

func parseInlineAssignment(text string, line sourceLine) (inlineArray, bool, error) {
	eq := findOutsideString(line.text, '=')
	if eq < 0 {
		return inlineArray{}, false, nil
	}
	key := strings.TrimSpace(line.text[:eq])
	if !isManagedEvent(key) {
		return inlineArray{}, false, nil
	}
	value := eq + 1
	for value < len(line.text) && (line.text[value] == ' ' || line.text[value] == '\t') {
		value++
	}
	if value >= len(line.text) || line.text[value] != '[' {
		return inlineArray{}, false, nil
	}
	open := line.start + value
	close, err := findMatchingSquare(text, open)
	if err != nil {
		return inlineArray{}, false, fmt.Errorf("hooks.%s inline array: %w", key, err)
	}
	insert := close
	lineStart := strings.LastIndexByte(text[:close], '\n') + 1
	if strings.Trim(text[lineStart:close], " \t\r") == "" {
		insert = lineStart
	}
	return inlineArray{event: key, open: open, close: close, insert: insert}, true, nil
}

func scanManagedRegions(op, text string, syntax syntaxInfo, groups map[string][]map[string]any) ([]managedRegion, error) {
	var regions []managedRegion
	usedMeta := make(map[int]bool)
	usedTrailing := make(map[int]bool)

	for i, line := range syntax.lines {
		if strings.TrimSpace(line.text) != marker {
			continue
		}
		markerColumn := strings.Index(line.text, "#")
		if !byteOutsideString(syntax, line.start+markerColumn) {
			continue
		}
		if markerColumn < 0 || strings.TrimSpace(line.text[:markerColumn]) != "" {
			return nil, conflict(op, "managed marker is not a standalone TOML comment")
		}
		markerAt := line.start + markerColumn
		if i+1 >= len(syntax.lines) {
			return nil, conflict(op, "managed marker is not followed by an owned hook")
		}

		next := syntax.lines[i+1]
		if prefix, ok := parsePrefixMetadata(next.text); ok && lineStartsOutsideString(syntax, next) {
			usedMeta[i+1] = true
			start, err := managedStart(text, markerAt, prefix)
			if err != nil {
				return nil, conflict(op, err.Error())
			}
			if i+2 >= len(syntax.lines) {
				return nil, conflict(op, "managed metadata is not followed by an owned hook")
			}
			ownedLine := syntax.lines[i+2]
			h, headerFound := syntax.headers[i+2]
			if headerFound && h.valid && h.array && len(h.path) == 2 && h.path[0] == "hooks" && isManagedEvent(h.path[1]) {
				index := aotIndexAtLine(syntax, h.path[1], i+2)
				if index < 0 {
					return nil, conflict(op, fmt.Sprintf("managed hooks.%s group cannot be mapped", h.path[1]))
				}
				regions = append(regions, managedRegion{
					kind:          regionAOT,
					event:         h.path[1],
					start:         start,
					end:           aotRegionEnd(syntax, i+2, h.path[1]),
					prefixNewline: prefix,
					groupIndex:    index,
				})
				continue
			}

			inline, found := inlineContaining(syntax.inline, markerAt, ownedLine.full)
			owned := strings.TrimSpace(ownedLine.text)
			leadingComma := strings.HasPrefix(owned, ",")
			if leadingComma {
				owned = strings.TrimSpace(strings.TrimPrefix(owned, ","))
			}
			if !found || !strings.HasPrefix(owned, "{") || !strings.HasSuffix(owned, "}") {
				return nil, conflict(op, "managed marker metadata has an unknown or ambiguous owner")
			}
			if ownedLine.full > inline.close || strings.TrimSpace(text[ownedLine.full:inline.close]) != "" {
				return nil, conflict(op, fmt.Sprintf("managed inline hooks.%s group is not the final array element", inline.event))
			}
			regions = append(regions, managedRegion{
				kind:          regionInline,
				event:         inline.event,
				start:         start,
				end:           ownedLine.full,
				prefixNewline: prefix,
				leadingComma:  leadingComma,
				groupIndex:    len(groups[inline.event]) - 1,
			})
			continue
		}

		// The pre-0.144 installer emitted marker-owned lowercase singleton
		// tables with no metadata. They are removable only in that exact form.
		h, headerFound := syntax.headers[i+1]
		if !headerFound || !h.valid || h.array || len(h.path) != 2 || h.path[0] != "hooks" || !legacyEvents[h.path[1]] {
			return nil, conflict(op, "managed marker is malformed or has an unknown owner")
		}
		regions = append(regions, managedRegion{
			kind:  regionLegacy,
			event: h.path[1],
			start: markerAt,
			end:   tableRegionEnd(syntax, i+1),
		})
	}

	// Honor the old trailing-marker spelling, but only for a safely recognized
	// legacy singleton table. Any other exact marker comment is ambiguous.
	for i, line := range syntax.lines {
		code, comment := splitComment(line.text)
		if strings.TrimSpace(comment) != marker {
			continue
		}
		if !byteOutsideString(syntax, line.start+len(code)) {
			continue
		}
		if strings.TrimSpace(code) == "" { // standalone marker handled above
			continue
		}
		h, headerFound := syntax.headers[i]
		if !headerFound || !h.valid || h.array || len(h.path) != 2 || h.path[0] != "hooks" || !legacyEvents[h.path[1]] {
			return nil, conflict(op, "managed marker appears on an unsupported or ambiguous line")
		}
		usedTrailing[i] = true
		regions = append(regions, managedRegion{
			kind:  regionLegacy,
			event: h.path[1],
			start: line.start,
			end:   tableRegionEnd(syntax, i),
		})
	}

	for i, line := range syntax.lines {
		trimmed := strings.TrimSpace(line.text)
		if strings.HasPrefix(trimmed, metaPrefix) && lineStartsOutsideString(syntax, line) && !usedMeta[i] {
			return nil, conflict(op, "orphaned or duplicate managed metadata")
		}
		code, comment := splitComment(line.text)
		if strings.TrimSpace(comment) == marker && byteOutsideString(syntax, line.start+len(code)) && strings.TrimSpace(code) != "" && !usedTrailing[i] {
			return nil, conflict(op, "unrecognized managed marker")
		}
	}

	sort.Slice(regions, func(i, j int) bool { return regions[i].start < regions[j].start })
	lastEnd := -1
	identities := make(map[string]bool)
	for _, region := range regions {
		if region.start < 0 || region.end <= region.start || region.end > len(text) {
			return nil, conflict(op, "managed marker region has invalid boundaries")
		}
		if region.start < lastEnd {
			return nil, conflict(op, "managed marker regions overlap or are duplicated")
		}
		lastEnd = region.end
		identity := fmt.Sprintf("%d:%s", region.kind, region.event)
		if identities[identity] {
			return nil, conflict(op, fmt.Sprintf("duplicate managed marker for hooks.%s", region.event))
		}
		identities[identity] = true
	}
	return regions, nil
}

func validateLegacyRegion(op, text string, region managedRegion) (string, error) {
	decoded, err := decodeConfig(op, text[region.start:region.end])
	if err != nil {
		return "", conflict(op, fmt.Sprintf("legacy managed hooks.%s block is malformed", region.event))
	}
	if len(decoded) != 1 {
		return "", conflict(op, fmt.Sprintf("legacy managed hooks.%s block contains unowned keys", region.event))
	}
	hooks, ok := decoded["hooks"].(map[string]any)
	if !ok || len(hooks) != 1 {
		return "", conflict(op, fmt.Sprintf("legacy managed hooks.%s block is ambiguous", region.event))
	}
	entry, ok := hooks[region.event].(map[string]any)
	if !ok || len(entry) != 1 {
		return "", conflict(op, fmt.Sprintf("legacy managed hooks.%s block has an unsafe shape", region.event))
	}
	command, ok := entry["command"].(string)
	if !ok || command == "" {
		return "", conflict(op, fmt.Sprintf("legacy managed hooks.%s command is malformed", region.event))
	}
	return command, nil
}

func validateLegacySet(op string, regions []managedRegion) error {
	if len(regions) != len(legacyEvents) {
		return conflict(op, "legacy managed hooks are partial; refusing ambiguous ownership")
	}
	seen := make(map[string]bool, len(regions))
	base := ""
	for _, region := range regions {
		if !legacyEvents[region.event] || seen[region.event] {
			return conflict(op, "legacy managed hooks do not match the exact historical event set")
		}
		seen[region.event] = true
		suffix := " --event " + region.event
		if !strings.HasSuffix(region.command, suffix) {
			return conflict(op, fmt.Sprintf("legacy managed hooks.%s command does not match the historical command form", region.event))
		}
		candidate := strings.TrimSuffix(region.command, suffix)
		if candidate == "" {
			return conflict(op, fmt.Sprintf("legacy managed hooks.%s command base is empty", region.event))
		}
		if base == "" {
			base = candidate
		} else if candidate != base {
			return conflict(op, "legacy managed hook commands do not share one exact command base")
		}
	}
	for event := range legacyEvents {
		if !seen[event] {
			return conflict(op, fmt.Sprintf("legacy managed hooks are missing hooks.%s", event))
		}
	}
	return nil
}

func managedStart(text string, markerAt int, prefix bool) (int, error) {
	if !prefix {
		return markerAt, nil
	}
	if markerAt == 0 || text[markerAt-1] != '\n' {
		return 0, errors.New("managed prefix-newline metadata does not match the text")
	}
	return markerAt - 1, nil
}

func parsePrefixMetadata(line string) (bool, bool) {
	trimmed := strings.TrimSpace(line)
	switch trimmed {
	case metaPrefix + "true":
		return true, true
	case metaPrefix + "false":
		return false, true
	default:
		return false, false
	}
}

func inlineContaining(all map[string]inlineArray, markerAt, ownedEnd int) (inlineArray, bool) {
	var found inlineArray
	count := 0
	for _, inline := range all {
		if markerAt > inline.open && ownedEnd <= inline.close {
			found = inline
			count++
		}
	}
	return found, count == 1
}

func aotIndexAtLine(syntax syntaxInfo, event string, line int) int {
	for i, group := range syntax.aot[event] {
		if group.line == line {
			return i
		}
	}
	return -1
}

func aotRegionEnd(syntax syntaxInfo, headerLine int, event string) int {
	// The marker owns the group through its last non-comment statement, not
	// blank lines or comments that happen to follow it. This boundary is what
	// lets uninstall preserve user annotations added immediately after a
	// managed block.
	end := syntax.lines[headerLine].full
	for i := headerLine + 1; i < len(syntax.lines); i++ {
		line := syntax.lines[i]
		markerColumn := strings.Index(line.text, "#")
		if strings.TrimSpace(line.text) == marker && byteOutsideString(syntax, line.start+markerColumn) {
			return end
		}
		if h, ok := syntax.headers[i]; ok {
			if h.array && pathEqual(h.path, "hooks", event, "hooks") {
				end = line.full
				continue
			}
			return end
		}
		if lineHasOutsideCode(syntax, line) {
			end = line.full
		}
	}
	return end
}

func tableRegionEnd(syntax syntaxInfo, headerLine int) int {
	end := syntax.lines[headerLine].full
	for i := headerLine + 1; i < len(syntax.lines); i++ {
		line := syntax.lines[i]
		markerColumn := strings.Index(line.text, "#")
		if strings.TrimSpace(line.text) == marker && byteOutsideString(syntax, line.start+markerColumn) {
			return end
		}
		if _, ok := syntax.headers[i]; ok {
			return end
		}
		if lineHasOutsideCode(syntax, line) {
			end = line.full
		}
	}
	return end
}

func renderAOT(event, command string, prefixNewline bool) string {
	return renderAOTWithWindows(event, command, "", prefixNewline)
}

func renderAOTWithWindows(event, command, commandWindows string, prefixNewline bool) string {
	prefix := ""
	if prefixNewline {
		prefix = "\n"
	}
	windowsLine := ""
	if commandWindows != "" {
		windowsLine = "commandWindows = " + strconv.Quote(commandWindows) + "\n"
	}
	return prefix + marker + "\n" +
		metaPrefix + strconv.FormatBool(prefixNewline) + "\n" +
		"[[hooks." + event + "]]\n" +
		"matcher = \"\"\n\n" +
		"[[hooks." + event + ".hooks]]\n" +
		"type = \"command\"\n" +
		"command = " + strconv.Quote(command) + "\n" +
		windowsLine
}

func renderInline(event, command string, prefixNewline, leadingComma bool) string {
	return renderInlineWithWindows(event, command, "", prefixNewline, leadingComma)
}

func renderInlineWithWindows(event, command, commandWindows string, prefixNewline, leadingComma bool) string {
	prefix := ""
	if prefixNewline {
		prefix = "\n"
	}
	comma := ""
	if leadingComma {
		comma = ", "
	}
	windowsField := ""
	if commandWindows != "" {
		windowsField = ", commandWindows = " + strconv.Quote(commandWindows)
	}
	return prefix + marker + "\n" +
		metaPrefix + strconv.FormatBool(prefixNewline) + "\n" +
		comma + "{ matcher = \"\", hooks = [{ type = \"command\", command = " + strconv.Quote(command) + windowsField + " }] }\n"
}

type textEdit struct {
	start       int
	end         int
	replacement string
}

func stripManaged(text string, regions []managedRegion) (string, error) {
	edits := make([]textEdit, 0, len(regions))
	for _, region := range regions {
		edits = append(edits, textEdit{start: region.start, end: region.end})
	}
	return applyTextEdits(text, edits)
}

func applyTextEdits(text string, edits []textEdit) (string, error) {
	if len(edits) == 0 {
		return text, nil
	}
	sorted := append([]textEdit(nil), edits...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].start == sorted[j].start {
			return sorted[i].end > sorted[j].end
		}
		return sorted[i].start > sorted[j].start
	})
	boundary := len(text)
	for _, edit := range sorted {
		if edit.start < 0 || edit.end < edit.start || edit.end > len(text) {
			return "", errors.New("managed text edit has invalid boundaries")
		}
		if edit.end > boundary {
			return "", errors.New("managed text edits overlap or are ambiguous")
		}
		text = text[:edit.start] + edit.replacement + text[edit.end:]
		boundary = edit.start
	}
	return text, nil
}

func isManagedEvent(event string) bool {
	i := sort.SearchStrings(ManagedEvents, event)
	return i < len(ManagedEvents) && ManagedEvents[i] == event
}

func pathEqual(path []string, want ...string) bool {
	if len(path) != len(want) {
		return false
	}
	for i := range want {
		if path[i] != want[i] {
			return false
		}
	}
	return true
}

func splitComment(line string) (string, string) {
	quote := byte(0)
	escaped := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if quote != 0 {
			if quote == '"' && escaped {
				escaped = false
				continue
			}
			if quote == '"' && c == '\\' {
				escaped = true
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			quote = c
		case '#':
			return line[:i], line[i:]
		}
	}
	return line, ""
}

func findOutsideString(line string, target byte) int {
	code, _ := splitComment(line)
	quote := byte(0)
	escaped := false
	for i := 0; i < len(code); i++ {
		c := code[i]
		if quote != 0 {
			if quote == '"' && escaped {
				escaped = false
				continue
			}
			if quote == '"' && c == '\\' {
				escaped = true
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			quote = c
			continue
		}
		if c == target {
			return i
		}
	}
	return -1
}

func findMatchingSquare(text string, open int) (int, error) {
	if open < 0 || open >= len(text) || text[open] != '[' {
		return 0, errors.New("array opening bracket is missing")
	}
	depth := 0
	quote := byte(0)
	triple := false
	escaped := false
	comment := false
	for i := open; i < len(text); i++ {
		c := text[i]
		if comment {
			if c == '\n' {
				comment = false
			}
			continue
		}
		if quote != 0 {
			if triple {
				if i+2 < len(text) && text[i] == quote && text[i+1] == quote && text[i+2] == quote {
					quote = 0
					triple = false
					i += 2
				}
				continue
			}
			if quote == '"' && escaped {
				escaped = false
				continue
			}
			if quote == '"' && c == '\\' {
				escaped = true
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '#' {
			comment = true
			continue
		}
		if c == '"' || c == '\'' {
			quote = c
			if i+2 < len(text) && text[i+1] == c && text[i+2] == c {
				triple = true
				i += 2
			}
			continue
		}
		switch c {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return i, nil
			}
		}
	}
	return 0, errors.New("array closing bracket is missing")
}

func lastSignificant(text string) byte {
	quote := byte(0)
	triple := false
	escaped := false
	comment := false
	var last byte
	for i := 0; i < len(text); i++ {
		c := text[i]
		if comment {
			if c == '\n' {
				comment = false
			}
			continue
		}
		if quote != 0 {
			if triple {
				if i+2 < len(text) && c == quote && text[i+1] == quote && text[i+2] == quote {
					last = quote
					quote = 0
					triple = false
					i += 2
				}
				continue
			}
			if quote == '"' && escaped {
				escaped = false
				continue
			}
			if quote == '"' && c == '\\' {
				escaped = true
				continue
			}
			if c == quote {
				last = quote
				quote = 0
			}
			continue
		}
		if c == '#' {
			comment = true
			continue
		}
		if c == '"' || c == '\'' {
			quote = c
			last = c
			if i+2 < len(text) && text[i+1] == c && text[i+2] == c {
				triple = true
				i += 2
			}
			continue
		}
		if c != ' ' && c != '\t' && c != '\r' && c != '\n' {
			last = c
		}
	}
	return last
}

func readConfigFile(op, path string) (text string, mode os.FileMode, existed bool, err error) {
	mode = 0o600
	info, statErr := os.Lstat(path)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return "", mode, false, nil
		}
		return "", 0, false, fmt.Errorf("%s: stat %s: %w", op, path, statErr)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return "", 0, false, fmt.Errorf("%s: %s is a symlink; refusing to write through it (managed by a dotfile manager?)", op, path)
	}
	if !info.Mode().IsRegular() {
		return "", 0, false, fmt.Errorf("%s: %s is not a regular file; refusing to read or replace it", op, path)
	}
	mode = info.Mode().Perm()
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		return "", 0, false, fmt.Errorf("%s: read %s: %w", op, path, readErr)
	}
	return string(data), mode, true, nil
}

func backupOriginal(path, original string, mode os.FileMode, now time.Time) (string, error) {
	base := path + "." + backupPrefix + now.UTC().Format("20060102T150405Z")
	for i := 1; i <= 999; i++ {
		dst := base
		if i > 1 {
			dst = fmt.Sprintf("%s-%d", base, i)
		}
		tmp, err := os.CreateTemp(filepath.Dir(path), ".hfg-backup-*")
		if err != nil {
			return "", fmt.Errorf("create backup temp: %w", err)
		}
		tmpName := tmp.Name()
		cleanup := func() {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
		if _, err := tmp.WriteString(original); err != nil {
			cleanup()
			return "", fmt.Errorf("write backup temp: %w", err)
		}
		if err := tmp.Sync(); err != nil {
			cleanup()
			return "", fmt.Errorf("sync backup temp: %w", err)
		}
		if err := tmp.Close(); err != nil {
			_ = os.Remove(tmpName)
			return "", fmt.Errorf("close backup temp: %w", err)
		}
		if err := os.Chmod(tmpName, mode); err != nil {
			_ = os.Remove(tmpName)
			return "", fmt.Errorf("set backup mode: %w", err)
		}
		if err := os.Link(tmpName, dst); err != nil {
			_ = os.Remove(tmpName)
			if errors.Is(err, fs.ErrExist) {
				continue
			}
			return "", fmt.Errorf("publish backup %s: %w", dst, err)
		}
		_ = os.Remove(tmpName)
		if err := syncParentDir(dst); err != nil && !errors.Is(err, syscall.EINVAL) {
			return "", fmt.Errorf("backup written to %s, but durability is not guaranteed: %w", dst, err)
		}
		return dst, nil
	}
	return "", fmt.Errorf("backup %s: too many collisions", base)
}

func ensureConfigUnchanged(op, path, original string, mode os.FileMode, existed bool) error {
	current, currentMode, currentExisted, err := readConfigFile(op, path)
	if err != nil {
		return err
	}
	if currentExisted != existed || current != original || (existed && currentMode != mode) {
		return conflict(op, "config.toml changed during hook operation; original left untouched")
	}
	return nil
}

func writeFileAtomic(path, text string, mode os.FileMode, original string, existed bool, op string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hfg-config-*.toml")
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if _, err := tmp.WriteString(text); err != nil {
		discard()
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return fmt.Errorf("sync temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("close temp config: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("set config mode: %w", err)
	}
	if err := ensureConfigUnchanged(op, path, original, mode, existed); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("replace config: %w", err)
	}
	if err := syncParentDir(path); err != nil && !errors.Is(err, syscall.EINVAL) {
		return fmt.Errorf("config written to %s, but durability is not guaranteed: fsync parent directory: %w", path, err)
	}
	return nil
}

func withLock(dir string, timeout time.Duration, fn func() error) error {
	lockPath := filepath.Join(dir, lockFileName)
	token, err := newLockToken()
	if err != nil {
		return fmt.Errorf("codex hooks: generate ownership token for %s: %w", lockPath, err)
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := lockfile.OpenExclusive(lockPath, 0o600)
		if err == nil {
			if n, writeErr := f.WriteString(token); writeErr != nil || n != len(token) {
				_ = f.Close()
				if writeErr == nil {
					writeErr = io.ErrShortWrite
				}
				return fmt.Errorf("codex hooks: record ownership token in acquired lock %s (lock left in place): %w", lockPath, writeErr)
			}
			ownedInfo, statErr := f.Stat()
			if statErr != nil {
				_ = f.Close()
				return fmt.Errorf("codex hooks: identify acquired lock %s (lock left in place): %w", lockPath, statErr)
			}
			owned := lockOwnership{info: ownedInfo, token: token}
			runErr := fn()
			if removeErr := removeOwnedLock(lockPath, f, owned); removeErr != nil {
				runErr = errors.Join(runErr, removeErr)
			}
			if closeErr := f.Close(); closeErr != nil {
				runErr = errors.Join(runErr, closeErr)
			}
			return runErr
		}
		if !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("codex hooks: acquire lock %s: %w", lockPath, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("codex hooks: another hooks operation holds %s (timed out after %s); if a previous process crashed, verify no hook operation is active before removing the lock", lockPath, timeout)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func newLockToken() (string, error) {
	raw := make([]byte, lockTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func removeOwnedLock(path string, acquired *os.File, owned lockOwnership) error {
	if owned.info == nil || owned.token == "" {
		return fmt.Errorf("codex hooks: lock ownership changed at %s; acquired ownership proof is incomplete", path)
	}
	if acquired == nil {
		return fmt.Errorf("codex hooks: lock ownership changed at %s; acquired lock handle is missing", path)
	}
	opened, err := acquired.Stat()
	if err != nil {
		return fmt.Errorf("codex hooks: inspect acquired lock %s before release: %w", path, err)
	}
	if !os.SameFile(owned.info, opened) {
		return fmt.Errorf("codex hooks: lock ownership changed at %s; refusing to remove another operation's lock", path)
	}
	if _, err := acquired.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("codex hooks: inspect acquired lock %s before release: %w", path, err)
	}
	proof, readErr := io.ReadAll(io.LimitReader(acquired, int64(len(owned.token)+1)))
	if readErr != nil {
		return fmt.Errorf("codex hooks: inspect acquired lock %s before release: %w", path, readErr)
	}
	if string(proof) != owned.token {
		return fmt.Errorf("codex hooks: lock ownership changed at %s; refusing to remove another operation's lock", path)
	}
	latest, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("codex hooks: acquired lock %s disappeared before release", path)
		}
		return fmt.Errorf("codex hooks: inspect acquired lock %s before release: %w", path, err)
	}
	if !latest.Mode().IsRegular() || !os.SameFile(opened, latest) {
		return fmt.Errorf("codex hooks: lock ownership changed at %s; refusing to remove another operation's lock", path)
	}
	// There is no portable conditional unlink. Cooperative lock users never
	// replace a live sentinel; a manual same-user replacement in the final
	// Lstat-to-Remove instruction window is outside this pathname protocol.
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("codex hooks: release lock %s: %w", path, err)
	}
	return nil
}

func syncParentDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Dir(path), err)
	}
	if err := dir.Sync(); err != nil {
		_ = dir.Close()
		return fmt.Errorf("sync %s: %w", filepath.Dir(path), err)
	}
	return dir.Close()
}
