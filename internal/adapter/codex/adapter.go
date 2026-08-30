// Package codex is the Codex adapter (v0.2.x).
//
// It captures OpenAI Codex CLI sessions into the local event spine:
//
//   - Install/Uninstall delegate to integrations/codex, the merge-safe
//     installer for Codex HooksToml matcher-group arrays in
//     ~/.codex/config.toml (additive, marker-scoped, fail-closed on
//     ambiguous ownership, idempotent, timestamped backup before the first
//     modification of an existing file);
//   - Normalize converts one documented Codex hook payload into canonical
//     events with deterministic event ids (same payload, same ids);
//   - NormalizeStream (normalize_stream.go) parses a native rollout JSONL
//     transcript into canonical events with deterministic event ids, so
//     re-importing the same transcript is idempotent;
//   - Detect enumerates rollout files under ~/.codex/sessions (recursive:
//     the layout varies by codex version, e.g. YYYY/MM/DD/rollout-*.jsonl);
//   - Resume returns the native resume invocation (codex resume <id>).
//
// The exported surface (New, Codex, Codex.SessionsDir, Codex.ConfigDir) is
// stable: internal/commands depends on it.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	codexhooks "github.com/handoffgraph/handoffgraph/integrations/codex"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Codex is the Codex adapter. Fields override default locations so tests
// and non-standard installs can point the adapter at scratch directories.
type Codex struct {
	// SessionsDir overrides the sessions directory used by Detect
	// (defaults to ~/.codex/sessions, then HFG_CODEX_SESSIONS_DIR).
	SessionsDir string
	// ConfigDir overrides ~/.codex for Install/Uninstall (then
	// HFG_CODEX_CONFIG_DIR).
	ConfigDir string
	// HookCommand is the complete command installed for each managed hook
	// event. Empty resolves to `<current executable> hook codex`.
	HookCommand string
	// HookCommandWindows overrides Codex's commandWindows field. On Windows,
	// an empty value resolves to the same cmd.exe-safe default as HookCommand.
	HookCommandWindows string
	// DryRun makes Install/Uninstall validate without writing.
	DryRun bool
}

// New returns a Codex adapter with default paths.
func New() *Codex { return &Codex{} }

// Name implements adapter.Adapter.
func (c *Codex) Name() string { return protocol.ProviderCodex }

// Capabilities reports what this adapter version supports honestly.
// Rollout normalization observes prompts, tool calls, command exits and
// compaction; hooks observe the same lifecycle live. Native resume exists
// via `codex resume`. Fork (a new session id seeded from an old
// transcript, à la claude --fork-session), diff-level events, native
// test-exit reporting and structured live streaming are not supported by
// this version and are never fabricated.
func (c *Codex) Capabilities() adapter.Capabilities {
	return adapter.Capabilities{
		NativeResume:        true,
		NativeFork:          false,
		CheckpointLaunch:    true,
		Hooks:               true,
		ToolEvents:          true,
		PromptEvents:        true,
		CompactionEvents:    true,
		DiffEvents:          false,
		TestExitStatus:      false,
		StructuredStreaming: false,
		SessionEnumeration:  true,
		// App Server support is deliberately narrower than structured live
		// streaming: HandoffGraph only performs stable, read-only session
		// enumeration over stdio. File-based Detect remains available.
		AppServerSessionEnumeration: true,
	}
}

// configDir resolves the Codex CLI configuration directory.
func (c *Codex) configDir() string {
	if c.ConfigDir != "" {
		return c.ConfigDir
	}
	if v := os.Getenv("HFG_CODEX_CONFIG_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// sessionsDir resolves the Codex CLI sessions directory.
func (c *Codex) sessionsDir() string {
	if c.SessionsDir != "" {
		return c.SessionsDir
	}
	if v := os.Getenv("HFG_CODEX_SESSIONS_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

// hookCommand resolves the complete stdin hook command. The executable path
// is shell-quoted because Codex executes configured command strings through a
// shell and os.Executable may contain whitespace or metacharacters.
func (c *Codex) hookCommand() (string, error) {
	if c.HookCommand != "" {
		return c.HookCommand, nil
	}
	if exe, err := os.Executable(); err == nil {
		return adapter.DefaultHookCommand(exe, c.Name())
	}
	return adapter.DefaultHookCommand("handoffgraph", c.Name())
}

// legacyHooksEntry is the entry name legacy HandoffGraph versions used for
// their single [hooks.handoffgraph] table (see docs/adapter-codex.md). The
// current installer manages current CamelCase event matcher-group arrays.
const legacyHooksEntry = "handoffgraph"

// refuseLegacyHooksTable fails closed when the config already holds a
// [hooks.handoffgraph] entry that this version does not manage (it carries
// no "# hfg:managed" marker): it is either a legacy HandoffGraph install or
// a user copy of one, and merging alongside it could double-fire hooks.
//
// The check is read-only. An unparseable file is deliberately left to the
// installer, which reports it fail-closed with its own precise message.
func refuseLegacyHooksTable(dir string) error {
	path := filepath.Join(dir, codexhooks.ConfigFile)
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("codex install: stat config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("codex install: %s is not a regular file; refusing to read it", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("codex install: read config: %w", err)
	}
	var cfg map[string]any
	if _, err := toml.Decode(string(data), &cfg); err != nil {
		return nil
	}
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok {
		return nil
	}
	if _, present := hooks[legacyHooksEntry]; present {
		return fmt.Errorf("codex install: %w: [hooks.%s] is present but is not managed by this HandoffGraph version (no %q marker); remove or migrate it manually",
			adapter.ErrHookConflict, legacyHooksEntry, "# hfg:managed")
	}
	return nil
}

// mapInstallError adapts integrations/codex errors to the adapter
// contract: its ErrHookConflict is reported as adapter.ErrHookConflict so
// callers can match either sentinel with errors.Is.
func mapInstallError(op string, err error) error {
	if errors.Is(err, codexhooks.ErrHookConflict) {
		return fmt.Errorf("%s: %w: %w", op, adapter.ErrHookConflict, err)
	}
	return fmt.Errorf("%s: %w", op, err)
}

// Install registers HandoffGraph hooks in ~/.codex/config.toml via
// integrations/codex: merge-safe (every byte outside our marker-carrying
// blocks is preserved verbatim), additive (user matcher groups remain in
// their original order), fail-closed on ambiguous markers or an unmarked
// exact-command collision, idempotent and dry-run-safe. Only user scope is
// supported; codex has no project-scoped hook configuration, so project scope
// fails with ErrUnsupported rather than fabricating support.
//
// Stub-era marker comments ("# managed-by: handoffgraph") written by the
// v0.2 stub are inert TOML comments: they neither conflict with the merge
// nor are rewritten, so an upgrade from the stub needs no migration.
func (c *Codex) Install(ctx context.Context, scope adapter.InstallScope) error {
	if scope == adapter.ScopeProject {
		return fmt.Errorf("codex install: project scope: %w", adapter.ErrUnsupported)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	dir := c.configDir()
	if err := refuseLegacyHooksTable(dir); err != nil {
		return err
	}
	command, err := c.hookCommand()
	if err != nil {
		return fmt.Errorf("codex install: resolve hook command: %w", err)
	}
	commandWindows := c.HookCommandWindows
	if commandWindows == "" && runtime.GOOS == "windows" {
		commandWindows = command
	}
	if _, err := codexhooks.Install(dir, codexhooks.Options{
		Command:        command,
		CommandWindows: commandWindows,
		DryRun:         c.DryRun,
	}); err != nil {
		return mapInstallError("codex install", err)
	}
	return nil
}

// Uninstall removes every marker-carrying HandoffGraph hook entry from
// ~/.codex/config.toml while preserving all other content verbatim, via
// integrations/codex. A missing file or a file without managed entries is
// a no-op. Only user scope is supported.
func (c *Codex) Uninstall(ctx context.Context, scope adapter.InstallScope) error {
	if scope == adapter.ScopeProject {
		return fmt.Errorf("codex uninstall: project scope: %w", adapter.ErrUnsupported)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := codexhooks.Uninstall(c.configDir(), codexhooks.Options{
		DryRun: c.DryRun,
	}); err != nil {
		return mapInstallError("codex uninstall", err)
	}
	return nil
}

// Detect enumerates Codex session files best-effort: every *.jsonl under
// the sessions dir (recursively — the rollout layout varies by codex
// version) contributes one ref. The head line (session_meta) is parsed for
// the native id, timestamp and model; the filename is only a fallback.
// Newest first, ties broken by path (deterministic). The dir argument is
// accepted for interface parity but deliberately ignored: callers override
// the location through SessionsDir (the CLI sets it from --sessions-dir /
// HFG_CODEX_SESSIONS_DIR), never through a path shared with other adapters.
// A missing or empty directory yields an empty slice, not an error.
func (c *Codex) Detect(ctx context.Context, dir string) ([]adapter.SessionRef, error) {
	sdir := c.sessionsDir()
	var refs []adapter.SessionRef
	err := filepath.WalkDir(sdir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal (best-effort)
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		ref := adapter.SessionRef{
			Provider: c.Name(),
			NativeID: strings.TrimSuffix(d.Name(), ".jsonl"),
			Path:     path,
		}
		if info, statErr := d.Info(); statErr == nil {
			ref.StartedAt = info.ModTime().UTC()
		}
		// Prefer the session_meta head line: timestamp + payload.id/model.
		if line := firstLine(path); line != "" {
			var head struct {
				Timestamp string `json:"timestamp"`
				Type      string `json:"type"`
				Payload   struct {
					ID    string `json:"id"`
					Model string `json:"model"`
				} `json:"payload"`
			}
			if json.Unmarshal([]byte(line), &head) == nil && head.Type == "session_meta" {
				if head.Payload.ID != "" {
					ref.NativeID = head.Payload.ID
				}
				if head.Payload.Model != "" {
					ref.Model = head.Payload.Model
				}
				if ts, ok := parseRolloutTime(head.Timestamp); ok {
					ref.StartedAt = ts
				}
			}
		}
		refs = append(refs, ref)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].StartedAt.Equal(refs[j].StartedAt) {
			return refs[i].StartedAt.After(refs[j].StartedAt)
		}
		return refs[i].Path < refs[j].Path
	})
	return refs, nil
}

// Normalize converts one Codex hook callback into canonical events. Current
// Codex payloads are discriminated by hook_event_name (CamelCase); the legacy
// lowercase type dialect remains accepted for compatibility. Unknown fields
// are preserved via Event.Unknown. Session-scoped event ids incorporate the
// canonical native payload, making exact callback retries immutable and
// idempotent even though Codex hook payloads do not carry timestamps.
func (c *Codex) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, errors.New("codex normalize: empty payload")
	}
	var view map[string]json.RawMessage
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, fmt.Errorf("codex normalize: payload is not a JSON object: %w", err)
	}
	if view == nil {
		return nil, errors.New("codex normalize: payload is not a JSON object")
	}
	if value, present := view["hook_event_name"]; present {
		var hookName string
		if json.Unmarshal(value, &hookName) != nil || hookName == "" {
			return nil, errors.New("codex normalize: hook_event_name must be a non-empty string")
		}
	}
	var p codexHook
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("codex normalize: decode payload fields: %w", err)
	}

	var native any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&native); err != nil {
		return nil, fmt.Errorf("codex normalize: decode native payload: %w", err)
	}
	canonicalNative, err := content.CanonicalJSON(native)
	if err != nil {
		return nil, fmt.Errorf("codex normalize: canonicalize native payload: %w", err)
	}
	nativeHash := content.HashBytes(canonicalNative)

	var occurredAt time.Time
	if _, present := view["timestamp"]; present {
		parsed, ok := parseRolloutTime(p.Timestamp)
		if !ok {
			return nil, errors.New("codex normalize: timestamp is not valid RFC3339")
		}
		occurredAt = parsed
	}
	consumed := legacyHookPayloadConsumed
	if p.HookEventName != "" {
		consumed = currentHookPayloadConsumed
	}
	var seq int64
	mk := func(kind protocol.EventKind, payload []byte) protocol.Event {
		seq++
		ev := protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			Sequence:        seq,
			OccurredAt:      occurredAt,
			ObservedAt:      occurredAt,
			NativeSessionID: p.SessionID,
			Provider:        c.Name(),
			Model:           p.Model,
			Kind:            kind,
			Provenance:      protocol.ProvenanceObserved,
			Payload:         payload,
			ContentHash:     content.HashBytes(payload),
		}
		if p.SessionID != "" {
			ev.EventID = deriveEventID(p.SessionID, seq, occurredAt, ev.ContentHash+"|"+nativeHash)
		} else {
			ev.EventID = ids.Event()
		}
		for k, v := range view {
			if !consumed[k] {
				if ev.Unknown == nil {
					ev.Unknown = make(map[string]json.RawMessage)
				}
				ev.Unknown[k] = v
			}
		}
		return ev
	}

	if p.HookEventName != "" {
		source := "hook:" + p.HookEventName
		payload := func(values map[string]any) []byte {
			if values == nil {
				values = map[string]any{}
			}
			values["source_kind"] = source
			return mustJSON(values)
		}
		switch p.HookEventName {
		case "SessionStart":
			kind := protocol.EventSessionStarted
			if p.Source == "resume" {
				kind = protocol.EventSessionResumed
			}
			return []protocol.Event{mk(kind, payload(map[string]any{"source": p.Source}))}, nil
		case "UserPromptSubmit":
			message, lossless, err := normalizedHookText(p.Prompt, false)
			if err != nil {
				return nil, fmt.Errorf("codex normalize: prompt: %w", err)
			}
			if lossless {
				consumed = withConsumedField(consumed, "prompt")
			}
			return []protocol.Event{mk(protocol.EventPromptSubmitted, payload(map[string]any{
				"message": message,
				"turn_id": p.TurnID,
			}))}, nil
		case "PreToolUse":
			return []protocol.Event{mk(protocol.EventToolStarted, payload(map[string]any{
				"tool_name":   p.ToolName,
				"tool_use_id": p.ToolUseID,
				"turn_id":     p.TurnID,
				"tool_input":  rawOrNull(p.ToolInput),
			}))}, nil
		case "PostToolUse":
			kind := protocol.EventToolCompleted
			values := map[string]any{
				"tool_name":     p.ToolName,
				"tool_use_id":   p.ToolUseID,
				"turn_id":       p.TurnID,
				"tool_input":    rawOrNull(p.ToolInput),
				"tool_response": rawOrNull(p.ToolResponse),
			}
			if failed, reason := codexToolResponseFailed(p.ToolResponse); failed {
				kind = protocol.EventToolFailed
				if reason != "" {
					values["error"] = truncateText(reason, rolloutMaxText)
				}
			}
			return []protocol.Event{mk(kind, payload(values))}, nil
		case "PreCompact", "PostCompact":
			phase := "post"
			if p.HookEventName == "PreCompact" {
				phase = "pre"
			}
			return []protocol.Event{mk(protocol.EventSessionCompacted, payload(map[string]any{
				"phase":   phase,
				"trigger": p.Trigger,
				"turn_id": p.TurnID,
			}))}, nil
		case "Stop":
			// Codex Stop means the current response/turn stopped, not that the
			// native session ended. Preserve that distinction in the trace kind.
			lastMessage, lossless, err := normalizedHookText(p.LastAssistantMessage, true)
			if err != nil {
				return nil, fmt.Errorf("codex normalize: last_assistant_message: %w", err)
			}
			if lossless {
				consumed = withConsumedField(consumed, "last_assistant_message")
			}
			return []protocol.Event{mk(protocol.EventTraceCompleted, payload(map[string]any{
				"trace_id":               p.TurnID,
				"stop_hook_active":       p.StopHookActive,
				"last_assistant_message": lastMessage,
			}))}, nil
		case "SessionEnd":
			// Not configurable in Codex 0.144.3 HooksToml, but tolerated for
			// forward/native compatibility when a provider emits it directly.
			return []protocol.Event{mk(protocol.EventSessionEnded, payload(map[string]any{"reason": p.Reason}))}, nil
		default:
			// PermissionRequest and subagent lifecycle callbacks currently have
			// no lossless dedicated hfg.event.v1 kind. Keep the complete native
			// object as observed log evidence instead of guessing.
			return []protocol.Event{mk(protocol.EventLogObserved, canonicalNative)}, nil
		}
	}

	switch {
	case p.Type == "session.start":
		return []protocol.Event{mk(protocol.EventSessionStarted, nil)}, nil
	case p.Type == "session.end":
		return []protocol.Event{mk(protocol.EventSessionEnded, nil)}, nil
	case p.Type == "tool.pre":
		ev := mk(protocol.EventToolStarted, mustJSON(map[string]any{"tool_name": p.ToolName, "tool_use_id": p.ToolUseID, "turn_id": p.TurnID, "tool_input": rawOrNull(p.ToolInput)}))
		return []protocol.Event{ev}, nil
	case p.Type == "tool.post":
		ev := mk(protocol.EventToolCompleted, mustJSON(map[string]any{"tool_name": p.ToolName, "tool_use_id": p.ToolUseID, "turn_id": p.TurnID, "exit_code": p.ExitCode}))
		return []protocol.Event{ev}, nil
	case p.Type == "turn.start":
		ev := mk(protocol.EventTraceStarted, mustJSON(map[string]any{"trace_id": p.TurnID}))
		return []protocol.Event{ev}, nil
	case p.Type == "turn.end":
		ev := mk(protocol.EventTraceCompleted, mustJSON(map[string]any{"trace_id": p.TurnID}))
		return []protocol.Event{ev}, nil
	default:
		// Unknown hook events are still evidence: canonicalize the raw
		// payload (sorted keys) so the content hash is stable.
		canon := raw
		var generic any
		if json.Unmarshal(raw, &generic) == nil {
			if b, err := content.CanonicalJSON(generic); err == nil {
				canon = b
			}
		}
		ev := mk(protocol.EventLogObserved, canon)
		return []protocol.Event{ev}, nil
	}
}

// Resume returns the native resume invocation (codex resume <id>).
func (c *Codex) Resume(ctx context.Context, ref adapter.SessionRef) (adapter.ExecSpec, error) {
	// Same guard as claude/pi: reject empty/dash-prefixed ids so a hostile
	// id cannot smuggle flags into the printed invocation.
	if ref.NativeID == "" {
		return adapter.ExecSpec{}, fmt.Errorf("codex resume: session id is required")
	}
	if strings.HasPrefix(ref.NativeID, "-") {
		return adapter.ExecSpec{}, fmt.Errorf("codex resume: invalid session id %q", ref.NativeID)
	}
	return adapter.ExecSpec{Command: "codex", Args: []string{"resume", ref.NativeID}}, nil
}

// StartFromCheckpoint starts a new interactive Codex session seeded by a
// checkpoint.
func (c *Codex) StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (adapter.ExecSpec, error) {
	if cp == nil {
		return adapter.ExecSpec{}, fmt.Errorf("checkpoint required")
	}
	// Clamp the objective (agent-influenced) and use an explicit `--`
	// separator so an objective beginning with '-' cannot be parsed as a
	// flag and a huge objective cannot exceed argv limits.
	objective := []rune(cp.Objective)
	if len(objective) > 4000 {
		objective = objective[:4000]
	}
	prompt := fmt.Sprintf("Continue workstream %s (checkpoint %s). Objective: %s. Acknowledge checkpoint %s before acting.",
		cp.WorkstreamID, cp.CheckpointID, string(objective), cp.CheckpointID)
	return adapter.ExecSpec{Command: "codex", Args: []string{"--", prompt}}, nil
}

// Compile-time interface compliance check.
var _ adapter.Adapter = (*Codex)(nil)

// codexHook mirrors the documented Codex hook payload fields.
type codexHook struct {
	Type                 string          `json:"type"`
	HookEventName        string          `json:"hook_event_name"`
	SessionID            string          `json:"session_id"`
	Timestamp            string          `json:"timestamp"`
	Cwd                  string          `json:"cwd"`
	Model                string          `json:"model"`
	Prompt               json.RawMessage `json:"prompt"`
	ToolName             string          `json:"tool_name"`
	ToolInput            json.RawMessage `json:"tool_input"`
	ToolResponse         json.RawMessage `json:"tool_response"`
	ToolUseID            string          `json:"tool_use_id"`
	TurnID               string          `json:"turn_id"`
	ExitCode             *int            `json:"exit_code"`
	Source               string          `json:"source"`
	Trigger              string          `json:"trigger"`
	StopHookActive       bool            `json:"stop_hook_active"`
	LastAssistantMessage json.RawMessage `json:"last_assistant_message"`
	Reason               string          `json:"reason"`
}

// legacyHookPayloadConsumed lists the legacy hook fields consumed by the
// mapping above; everything else is preserved in Event.Unknown.
var legacyHookPayloadConsumed = map[string]bool{
	"type":        true,
	"session_id":  true,
	"model":       true,
	"tool_name":   true,
	"tool_input":  true,
	"tool_use_id": true,
	"turn_id":     true,
	"exit_code":   true,
}

// currentHookPayloadConsumed lists current 0.144.3 fields represented in the
// canonical event envelope or payload. Provider fields not listed here (for
// example transcript_path, permission_mode, agent_id and agent_type) stay in
// Event.Unknown rather than being silently discarded.
var currentHookPayloadConsumed = map[string]bool{
	"hook_event_name":  true,
	"session_id":       true,
	"timestamp":        true,
	"model":            true,
	"tool_name":        true,
	"tool_input":       true,
	"tool_response":    true,
	"tool_use_id":      true,
	"turn_id":          true,
	"source":           true,
	"trigger":          true,
	"stop_hook_active": true,
	"reason":           true,
}

func withConsumedField(base map[string]bool, field string) map[string]bool {
	copy := make(map[string]bool, len(base)+1)
	for key, value := range base {
		copy[key] = value
	}
	copy[field] = true
	return copy
}

// normalizedHookText preserves null separately from the empty string and
// reports whether the canonical payload contains the complete native value.
// When truncation is necessary, callers keep the raw provider field in
// Event.Unknown so normalization never destroys observed evidence.
func normalizedHookText(raw json.RawMessage, nullable bool) (any, bool, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		if nullable {
			return nil, true, nil
		}
		return "", true, nil
	}
	if trimmed == "null" {
		if !nullable {
			return nil, false, errors.New("must be a string")
		}
		return nil, true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		if nullable {
			return nil, false, errors.New("must be a string or null")
		}
		return nil, false, errors.New("must be a string")
	}
	truncated := truncateText(value, rolloutMaxText)
	return truncated, truncated == value, nil
}

func codexToolResponseFailed(raw json.RawMessage) (bool, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, ""
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return false, ""
	}
	readBool := func(key string) bool {
		var value bool
		return json.Unmarshal(object[key], &value) == nil && value
	}
	readString := func(key string) string {
		var value string
		_ = json.Unmarshal(object[key], &value)
		return value
	}
	if reason := readString("error"); reason != "" {
		return true, reason
	}
	if readBool("is_error") {
		return true, "is_error"
	}
	if readBool("interrupted") {
		return true, "interrupted"
	}
	return false, ""
}

// parseRolloutTime parses an RFC3339 timestamp with optional fractional
// seconds (both forms appear in rollouts), reporting success.
func parseRolloutTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

// firstLine returns the first line of the file at path, or "" when it
// cannot be read.
func firstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if sc.Scan() {
		return sc.Text()
	}
	return ""
}

// mustJSON marshals v or panics (used only on map[string]any values that
// are always marshalable).
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// rawOrNull passes through raw JSON (or JSON null) for payload fields that
// keep structured values.
func rawOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}
