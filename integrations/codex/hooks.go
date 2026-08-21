// Package codexhooks manages the HandoffGraph hook entries that live in the
// Codex CLI's configuration file (~/.codex/config.toml, [hooks] section).
//
// The installer is merge-safe by construction:
//
//   - The original file is never re-encoded wholesale. Every byte outside
//     HandoffGraph's own marked blocks is preserved verbatim, so user keys,
//     comments, ordering and formatting survive install and uninstall
//     unchanged.
//   - Managed entries carry a "# hfg:managed" marker comment. Only blocks
//     carrying that marker are ever rewritten or removed; ownership is
//     provenance, not name.
//   - A collision between a managed entry name and a user-owned entry fails
//     closed with ErrHookConflict and leaves the file untouched. User keys
//     are never overwritten.
//   - Before the first modification of an existing file, the original is
//     backed up to config.toml.hfg-backup-<timestamp>.
//   - Installing an already-identical configuration is an idempotent no-op:
//     no write, no backup, Changed=false.
package codexhooks

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/BurntSushi/toml"
)

const (
	// ConfigFile is the name of the Codex CLI configuration file inside the
	// Codex config directory.
	ConfigFile = "config.toml"

	// marker is the comment identifying a HandoffGraph-managed hook entry.
	// Only entries whose block carries this marker are written or removed.
	marker = "# hfg:managed"

	// hooksTable is the top-level TOML table holding Codex hook entries.
	hooksTable = "hooks"

	// backupPrefix decorates pre-install backups of config.toml.
	backupPrefix = "hfg-backup-"
)

// ErrHookConflict reports that installing HandoffGraph hooks would collide
// with an existing user-owned entry. It is fail-closed: when it is returned
// the configuration file has not been modified.
var ErrHookConflict = errors.New("codex hooks: refusing to overwrite existing user hook configuration")

// ManagedEvents lists the hook events HandoffGraph subscribes to, sorted:
// session lifecycle, pre/post tool use, and turn boundaries.
var ManagedEvents = []string{
	"post_tool_use",
	"pre_tool_use",
	"session_end",
	"session_start",
	"turn_end",
	"turn_start",
}

// Options controls an Install or Uninstall run.
type Options struct {
	// Command is the base hook command (without the per-event flag). Every
	// managed entry is written as `<Command> --event <event>`. Required.
	Command string
	// DryRun performs every conflict check and reports what would change
	// without writing or backing up anything.
	DryRun bool
	// Now supplies the timestamp used in backup file names. Defaults to
	// time.Now; injectable so tests are deterministic.
	Now func() time.Time
}

// Result reports what an Install or Uninstall did.
type Result struct {
	// Changed reports whether the configuration file was (or would be, on a
	// dry run) modified.
	Changed bool
	// Backup is the path of the pre-modification backup ("" when none was
	// written).
	Backup string
	// Entries lists the managed entry names present after the operation,
	// sorted.
	Entries []string
}

func (o Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Install deep-merges the managed hook entries into configDir/config.toml,
// creating the file when absent. See the package comment for the merge
// guarantees; on any error the original file is left untouched.
func Install(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks install"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	if opts.Command == "" {
		return nil, errors.New(op + ": hook command must not be empty")
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, fmt.Errorf("%s: create config directory: %w", op, err)
	}
	path := filepath.Join(configDir, ConfigFile)

	lines, mode, existed, err := readFileLines(op, path)
	if err != nil {
		return nil, err
	}
	decoded, err := decodeLines(op, lines)
	if err != nil {
		return nil, err
	}
	if err := checkHooksTableShape(op, decoded); err != nil {
		return nil, err
	}

	blocks := scanManagedBlocks(lines)
	byEvent := make(map[string]block, len(blocks))
	for _, b := range blocks {
		byEvent[b.event] = b
	}

	// Decide, per managed event: already ours (no change), ours but drifted
	// (replace), user-owned (fail closed), or absent (add).
	var add, replace []string
	for _, event := range ManagedEvents {
		want := entryCommand(opts.Command, event)
		userHas := hasHookEntry(decoded, event)
		existing, marked := byEvent[event]
		switch {
		case !userHas && !marked:
			add = append(add, event)
		case marked && userHas && existing.command == want:
			// Already installed exactly as we would write it.
		case marked:
			// Marked as ours but the content drifted (manual edit): the
			// marker proves ownership, so re-assert the canonical entry.
			replace = append(replace, event)
		default:
			// The entry name is occupied by something we did not mark:
			// never overwrite user configuration.
			return nil, fmt.Errorf("%s: %w: [hooks.%s] is already defined", op, ErrHookConflict, event)
		}
	}

	entries := append([]string(nil), ManagedEvents...)
	sort.Strings(entries)
	if len(add) == 0 && len(replace) == 0 {
		return &Result{Changed: false, Entries: entries}, nil
	}
	if opts.DryRun {
		return &Result{Changed: true, Entries: entries}, nil
	}
	if err := refuseSymlinkedConfig(op, path); err != nil {
		return nil, err
	}

	backupPath := ""
	if existed {
		backupPath, err = backupOriginal(path, mode, opts.now())
		if err != nil {
			return nil, fmt.Errorf("%s: %w", op, err)
		}
	}

	newLines := removeBlocks(lines, blocksFor(replace, blocks))
	// Re-insert both newly added AND replaced entries: a drifted managed
	// block was removed above, so it must be rebuilt here or it vanishes.
	rebuild := append(append([]string(nil), add...), replace...)
	sort.Strings(rebuild)
	newLines = insertBlocks(newLines, buildBlocks(rebuild, opts.Command))
	newText := joinLines(newLines)

	// Fail closed before writing: the merged file must still be valid TOML
	// and must leave every non-managed value byte-equivalent. The managed
	// set is ManagedEvents (not just pre-existing blocks): on a fresh or
	// growing install the newly added/managed entries are ours by contract,
	// and every [hooks] entry we ever write comes from ManagedEvents.
	newDecoded, err := decodeString(op, newText)
	if err != nil {
		return nil, fmt.Errorf("%s: merged config failed validation; original untouched: %w", op, err)
	}
	if err := assertUserConfigPreserved(decoded, newDecoded, ManagedEvents); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}

	if err := writeFileAtomic(path, newText, mode); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return &Result{Changed: true, Backup: backupPath, Entries: entries}, nil
}

// Uninstall removes every marker-carrying managed entry from
// configDir/config.toml while preserving all other content verbatim. A
// missing file, or a file with no managed entries, is a no-op.
func Uninstall(configDir string, opts Options) (*Result, error) {
	const op = "codex hooks uninstall"
	if configDir == "" {
		return nil, errors.New(op + ": config directory must not be empty")
	}
	path := filepath.Join(configDir, ConfigFile)

	lines, mode, existed, err := readFileLines(op, path)
	if err != nil {
		return nil, err
	}
	if !existed {
		return &Result{Changed: false, Entries: nil}, nil
	}
	decoded, err := decodeLines(op, lines)
	if err != nil {
		return nil, err
	}
	if err := checkHooksTableShape(op, decoded); err != nil {
		return nil, err
	}

	blocks := scanManagedBlocks(lines)
	if len(blocks) == 0 {
		return &Result{Changed: false, Entries: nil}, nil
	}
	if opts.DryRun {
		return &Result{Changed: true, Entries: nil}, nil
	}
	if err := refuseSymlinkedConfig(op, path); err != nil {
		return nil, err
	}

	removed := managedNames(blocks)
	newLines := removeBlocks(lines, blocks)
	newText := joinLines(newLines)

	newDecoded, err := decodeString(op, newText)
	if err != nil {
		return nil, fmt.Errorf("%s: cleaned config failed validation; original untouched: %w", op, err)
	}
	if err := assertUserConfigPreserved(decoded, newDecoded, removed); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}

	if err := writeFileAtomic(path, newText, mode); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return &Result{Changed: true, Entries: nil}, nil
}

// entryCommand renders the hook command for one event.
func entryCommand(base, event string) string {
	return base + " --event " + event
}

// block is one managed [hooks.<event>] table found in (or written to) the
// config text, together with its marker line.
type block struct {
	event string
	// start is the index of the marker line (the header line itself when the
	// marker rides as a trailing comment).
	start int
	// end is the exclusive index of the first line after the block (the next
	// table header, or EOF).
	end int
	// command is the decoded `command` value inside the block ("" when it
	// cannot be decoded as our canonical form).
	command string
}

// buildBlocks renders the canonical lines for the given events, sorted by
// event name.
func buildBlocks(events []string, base string) []block {
	sorted := append([]string(nil), events...)
	sort.Strings(sorted)
	out := make([]block, 0, len(sorted))
	for _, event := range sorted {
		out = append(out, block{
			event:   event,
			start:   -1,
			end:     -1,
			command: entryCommand(base, event),
		})
	}
	return out
}

// canonicalLines renders the exact file lines of one block.
func (b block) canonicalLines() []string {
	return []string{
		marker,
		"[hooks." + b.event + "]",
		"command = " + strconv.Quote(b.command),
	}
}

// scanManagedBlocks finds every marker-carrying [hooks.<event>] table in the
// file. A block is marker-carrying when the line above its header is exactly
// the marker comment, or the header line carries it as a trailing comment.
func scanManagedBlocks(lines []string) []block {
	var out []block
	for i := 0; i < len(lines); i++ {
		event, ok := hookHeader(lines[i])
		if !ok {
			continue
		}
		start := i
		marked := false
		if i > 0 && strings.TrimSpace(lines[i-1]) == marker {
			marked = true
			start = i - 1
		} else if hasTrailingMarker(lines[i]) {
			marked = true
		} else {
			// The marker may sit further above, separated by comment lines
			// (manual notes inside the managed region are tolerated and
			// removed with the block). Walk up over comment-only lines.
			for j := i - 1; j >= 0; j-- {
				t := strings.TrimSpace(lines[j])
				if t == "" {
					continue
				}
				if !strings.HasPrefix(t, "#") {
					break
				}
				if t == marker {
					marked = true
					start = j
					break
				}
			}
		}
		if !marked {
			continue
		}
		end := len(lines)
		for j := i + 1; j < len(lines); j++ {
			if _, isHeader := anyTableHeader(lines[j]); isHeader {
				end = j
				break
			}
		}
		out = append(out, block{
			event:   event,
			start:   start,
			end:     end,
			command: blockCommand(lines[i+1 : end]),
		})
		i = end - 1
	}
	return out
}

// hookHeader reports whether line is a `[hooks.<event>]` table header and
// returns the event name.
func hookHeader(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "[hooks.") {
		return "", false
	}
	rest := strings.TrimPrefix(trimmed, "[hooks.")
	close := strings.Index(rest, "]")
	if close <= 0 {
		return "", false
	}
	event := rest[:close]
	if event != strings.TrimSpace(event) || strings.ContainsAny(event, " \t\"[]") {
		return "", false
	}
	// Only whitespace and comments may follow the closing bracket.
	tail := strings.TrimSpace(rest[close+1:])
	if tail != "" && !strings.HasPrefix(tail, "#") {
		return "", false
	}
	return event, true
}

// anyTableHeader reports whether line opens any TOML table (or array of
// tables), which terminates the previous table's body.
func anyTableHeader(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "[") {
		return "", false
	}
	// A key like `[foo] = 1` is not a header; TOML table headers have no
	// assignment after the closing bracket.
	if close := strings.Index(trimmed, "]"); close > 0 {
		tail := strings.TrimSpace(trimmed[close+1:])
		if tail == "" || strings.HasPrefix(tail, "#") {
			return trimmed, true
		}
	}
	return "", false
}

// hasTrailingMarker reports whether a header line carries the marker as a
// trailing comment (the alternate written form we still honor on read).
func hasTrailingMarker(line string) bool {
	idx := strings.Index(line, "#")
	if idx < 0 {
		return false
	}
	return strings.Contains(line[idx:], "hfg:managed")
}

// blockCommand decodes the `command` key from the body lines of a block,
// accepting only our canonical double-quoted form.
func blockCommand(body []string) string {
	for _, line := range body {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "command") {
			continue
		}
		eq := strings.Index(trimmed, "=")
		if eq < 0 {
			continue
		}
		val := strings.TrimSpace(trimmed[eq+1:])
		if len(val) >= 2 && strings.HasPrefix(val, `"`) && strings.HasSuffix(val, `"`) {
			if unquoted, err := strconv.Unquote(val); err == nil {
				return unquoted
			}
		}
		return ""
	}
	return ""
}

// blocksFor returns the scanned blocks whose event is in events.
func blocksFor(events []string, blocks []block) []block {
	want := make(map[string]bool, len(events))
	for _, e := range events {
		want[e] = true
	}
	var out []block
	for _, b := range blocks {
		if want[b.event] {
			out = append(out, b)
		}
	}
	return out
}

// managedNames returns the sorted event names of the given blocks.
func managedNames(blocks []block) []string {
	out := make([]string, 0, len(blocks))
	for _, b := range blocks {
		out = append(out, b.event)
	}
	sort.Strings(out)
	return out
}

// removeBlocks deletes the given scanned blocks (marker line through the
// line before the next table header), swallowing at most one immediately
// following blank line so spacing stays tidy. All other lines are preserved
// verbatim and in order.
func removeBlocks(lines []string, blocks []block) []string {
	if len(blocks) == 0 {
		return lines
	}
	remove := make(map[int]bool)
	for _, b := range blocks {
		for i := b.start; i < b.end; i++ {
			remove[i] = true
		}
		if b.end < len(lines) && strings.TrimSpace(lines[b.end]) == "" {
			remove[b.end] = true
		}
	}
	out := make([]string, 0, len(lines))
	for i, line := range lines {
		if !remove[i] {
			out = append(out, line)
		}
	}
	return out
}

// insertBlocks appends the canonical text of the given new blocks inside
// the [hooks] section when one exists, otherwise immediately before the
// first [hooks.*] sub-table header (keeping hook entries grouped), and
// otherwise at the end of the file (sub-table headers define [hooks]
// implicitly). Existing lines are never rearranged.
func insertBlocks(lines []string, blocks []block) []string {
	if len(blocks) == 0 {
		return lines
	}
	var chunk []string
	for i, b := range blocks {
		if i > 0 {
			chunk = append(chunk, "")
		}
		chunk = append(chunk, b.canonicalLines()...)
	}

	at := len(lines)
	if h := bareHooksHeader(lines); h >= 0 {
		// End of the [hooks] section: just before the next table header (or
		// EOF), after any existing key lines.
		at = len(lines)
		for j := h + 1; j < len(lines); j++ {
			if _, isHeader := anyTableHeader(lines[j]); isHeader {
				at = j
				break
			}
		}
	} else if h := firstHooksSubHeader(lines); h >= 0 {
		at = h
	}

	out := make([]string, 0, len(lines)+len(chunk)+2)
	out = append(out, lines[:at]...)
	if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
		out = append(out, "")
	}
	out = append(out, chunk...)
	if at < len(lines) && len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
		// Keep a blank line between our blocks and the following header.
		out = append(out, "")
	}
	out = append(out, lines[at:]...)
	return out
}

// firstHooksSubHeader finds the index of the first [hooks.<name>] table
// header line of any name, or -1.
func firstHooksSubHeader(lines []string) int {
	for i, line := range lines {
		if _, ok := hookHeader(line); ok {
			return i
		}
	}
	return -1
}

// bareHooksHeader finds the index of a `[hooks]` table header line, or -1.
func bareHooksHeader(lines []string) int {
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "[hooks]") {
			continue
		}
		tail := strings.TrimSpace(strings.TrimPrefix(trimmed, "[hooks]"))
		if tail == "" || strings.HasPrefix(tail, "#") {
			return i
		}
	}
	return -1
}

// joinLines reassembles lines into file text with a single trailing newline.
func joinLines(lines []string) string {
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// readFileLines reads the config file into lines. A missing file yields an
// empty slice, the default new-file mode, existed=false. An unparseable
// TOML file is a fail-closed error: callers must never rewrite a config
// they could not read.
func readFileLines(op, path string) (lines []string, mode os.FileMode, existed bool, err error) {
	mode = 0o600
	info, statErr := os.Stat(path)
	if statErr != nil {
		if !os.IsNotExist(statErr) {
			return nil, 0, false, fmt.Errorf("%s: stat %s: %w", op, path, statErr)
		}
		return nil, mode, false, nil
	}
	mode = info.Mode().Perm()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, false, fmt.Errorf("%s: read %s: %w", op, path, err)
	}
	if _, err := decodeString(op, string(data)); err != nil {
		return nil, 0, false, err
	}
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" {
		return nil, mode, true, nil
	}
	return strings.Split(text, "\n"), mode, true, nil
}

// decodeLines validates and decodes already-split file lines.
func decodeLines(op string, lines []string) (map[string]any, error) {
	if len(lines) == 0 {
		return map[string]any{}, nil
	}
	return decodeString(op, strings.Join(lines, "\n")+"\n")
}

// decodeString parses TOML text into a generic map, failing closed on any
// parse error.
func decodeString(op, text string) (map[string]any, error) {
	var cfg map[string]any
	if _, err := toml.Decode(text, &cfg); err != nil {
		return nil, fmt.Errorf("%s: %s is unparseable as TOML; it was NOT modified: %w", op, ConfigFile, err)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	return cfg, nil
}

// checkHooksTableShape fails closed when a `hooks` key exists but is not a
// table: deletion and merge must never be name-blind.
func checkHooksTableShape(op string, decoded map[string]any) error {
	if raw, present := decoded[hooksTable]; present {
		if _, ok := raw.(map[string]any); !ok {
			return fmt.Errorf("%s: %w: existing %s entry is not a table", op, ErrHookConflict, hooksTable)
		}
	}
	return nil
}

// hasHookEntry reports whether the decoded config defines hooks[event].
func hasHookEntry(decoded map[string]any, event string) bool {
	hooks, ok := decoded[hooksTable].(map[string]any)
	if !ok {
		return false
	}
	_, present := hooks[event]
	return present
}

// assertUserConfigPreserved proves the merge kept every non-managed value:
// after stripping the managed entries from both sides, the decoded configs
// must be deeply equal.
func assertUserConfigPreserved(before, after map[string]any, managed []string) error {
	strippedBefore := stripManaged(deepCopyMap(before), managed)
	strippedAfter := stripManaged(deepCopyMap(after), managed)
	if !reflect.DeepEqual(strippedBefore, strippedAfter) {
		return errors.New("merge validation failed: non-managed configuration changed; original left untouched")
	}
	return nil
}

// stripManaged removes the named entries from the decoded hooks table,
// deleting the table itself when it becomes empty.
func stripManaged(cfg map[string]any, managed []string) map[string]any {
	hooks, ok := cfg[hooksTable].(map[string]any)
	if !ok {
		return cfg
	}
	for _, event := range managed {
		delete(hooks, event)
	}
	if len(hooks) == 0 {
		delete(cfg, hooksTable)
	}
	return cfg
}

// deepCopyMap copies nested generic maps so stripping never mutates the
// caller's decode result.
func deepCopyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		if m, ok := v.(map[string]any); ok {
			out[k] = deepCopyMap(m)
		} else {
			out[k] = v
		}
	}
	return out
}

// backupOriginal copies the current config to a timestamped
// config.toml.hfg-backup-<timestamp> sibling before it is modified, keeping
// the original permissions. Same-second collisions get a numeric suffix.
func backupOriginal(path string, mode os.FileMode, now time.Time) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read for backup: %w", err)
	}
	base := path + "." + backupPrefix + now.UTC().Format("20060102T150405Z")
	dst := base
	for i := 2; ; i++ {
		if i > 999 {
			return "", fmt.Errorf("backup %s: too many collisions", base)
		}
		if _, err := os.Stat(dst); os.IsNotExist(err) {
			break
		}
		dst = fmt.Sprintf("%s-%d", base, i)
	}
	if err := os.WriteFile(dst, data, mode); err != nil {
		return "", fmt.Errorf("write backup %s: %w", dst, err)
	}
	return dst, nil
}

// refuseSymlinkedConfig fails closed when the config path is a symlink: a
// symlinked config is usually owned by a dotfile manager and must not be
// replaced underneath it. Missing files pass.
func refuseSymlinkedConfig(op, path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%s: stat %s: %w", op, path, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s: %s is a symlink; refusing to write through it (managed by a dotfile manager?)", op, path)
	}
	return nil
}

// writeFileAtomic replaces the config atomically: the new text is written to
// a temp file in the same directory, fsynced, chmodded to the original mode
// (or 0600 for a new file), then renamed over the target. On any error the
// original file is left untouched.
func writeFileAtomic(path, text string, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hfg-config-*.toml")
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	tmpName := tmp.Name()
	discard := func() {
		tmp.Close()
		os.Remove(tmpName)
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
		os.Remove(tmpName)
		return fmt.Errorf("close temp config: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("set config mode: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("replace config: %w", err)
	}
	// Durability: fsync the parent directory so the rename itself survives
	// a crash. Some platforms reject directory fsync with EINVAL; that is a
	// platform limitation, not a durability problem, so it is non-fatal.
	if err := syncParentDir(path); err != nil {
		if errors.Is(err, syscall.EINVAL) {
			return nil
		}
		return fmt.Errorf("config written to %s, but durability is not guaranteed: fsync parent directory: %w", path, err)
	}
	return nil
}

// syncParentDir opens and fsyncs the directory containing path so a
// completed rename survives a crash.
func syncParentDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Dir(path), err)
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return fmt.Errorf("sync %s: %w", filepath.Dir(path), err)
	}
	return dir.Close()
}
