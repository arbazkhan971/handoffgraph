// Package codex is the Codex adapter (v0.2.x).
//
// It captures OpenAI Codex CLI sessions into the local event spine:
//
//   - Install/Uninstall delegate to integrations/codex, the merge-safe
//     installer for the managed [hooks.<event>] tables in
//     ~/.codex/config.toml (additive, marker-scoped, fail-closed on
//     collisions, idempotent, timestamped backup before the first
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
	// HookCommand is the base command installed for each managed hook
	// event, written as `<command> --event <event>`. Empty resolves to the
	// current executable.
	HookCommand string
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
// via `codex exec resume`. Fork (a new session id seeded from an old
// transcript, à la claude --fork-session), diff-level events, native
// test-exit reporting and structured live streaming are not supported by
// this version and are never fabricated.
func (c *Codex) Capabilities() adapter.Capabilities {
	return adapter.Capabilities{
		NativeResume:        true,
		NativeFork:          false,
		Hooks:               true,
		ToolEvents:          true,
		PromptEvents:        true,
		CompactionEvents:    true,
		DiffEvents:          false,
		TestExitStatus:      false,
		StructuredStreaming: false,
		SessionEnumeration:  true,
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

// hookCommand resolves the base hook command to install, defaulting to the
// current executable (same convention as the claude lane).
func (c *Codex) hookCommand() string {
	if c.HookCommand != "" {
		return c.HookCommand
	}
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return "handoffgraph"
}

// legacyHooksEntry is the entry name legacy HandoffGraph versions used for
// their single [hooks.handoffgraph] table (see docs/adapter-codex.md). The
// current installer manages per-event [hooks.<event>] tables instead.
const legacyHooksEntry = "handoffgraph"

// refuseLegacyHooksTable fails closed when the config already holds a
// [hooks.handoffgraph] entry that this version does not manage (it carries
// no "# hfg:managed" marker): it is either a legacy HandoffGraph install or
// a user copy of one, and merging alongside it could double-fire hooks.
//
// The check is read-only. An unparseable file is deliberately left to the
// installer, which reports it fail-closed with its own precise message.
func refuseLegacyHooksTable(dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, codexhooks.ConfigFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
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
// blocks is preserved verbatim), fail-closed (an entry name already taken
// by user configuration is never overwritten), idempotent (installing an
// identical configuration is a no-op) and dry-run-safe. Only user scope is
// supported; codex has no project-scoped hook configuration, so project
// scope fails with ErrUnsupported rather than fabricating support.
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
	if _, err := codexhooks.Install(dir, codexhooks.Options{
		Command: c.hookCommand(),
		DryRun:  c.DryRun,
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

// Normalize converts one documented Codex hook payload into canonical
// events. Unknown payload fields are preserved via Event.Unknown. Event
// ids are deterministic: a hook payload carrying a session id always
// derives the same evt_<ulid> from (provider, session id, sequence,
// content hash), so re-delivering the same payload is idempotent in the
// event store. A payload without a session id cannot be scoped without
// risking cross-session collisions, so those events get fresh random ids
// (unique evidence, at the cost of idempotency for that event only).
func (c *Codex) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var p codexHook
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("codex normalize: %w", err)
	}
	var view map[string]json.RawMessage
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, fmt.Errorf("codex normalize: %w", err)
	}
	now := time.Now().UTC()
	var seq int64
	mk := func(kind protocol.EventKind, payload []byte) protocol.Event {
		seq++
		ev := protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			Sequence:        seq,
			OccurredAt:      now,
			ObservedAt:      now,
			NativeSessionID: p.SessionID,
			Provider:        c.Name(),
			Kind:            kind,
			Provenance:      protocol.ProvenanceObserved,
			Payload:         payload,
			ContentHash:     content.HashBytes(payload),
		}
		if p.SessionID != "" {
			// Hook payloads carry no timestamp, so the derivation key uses
			// a zero time: the id stays a pure function of content.
			ev.EventID = deriveEventID(p.SessionID, seq, time.Time{}, ev.ContentHash)
		} else {
			ev.EventID = ids.Event()
		}
		for k, v := range view {
			if !hookPayloadConsumed[k] {
				if ev.Unknown == nil {
					ev.Unknown = make(map[string]json.RawMessage)
				}
				ev.Unknown[k] = v
			}
		}
		return ev
	}
	switch {
	case p.Type == "session.start":
		ev := mk(protocol.EventSessionStarted, nil)
		ev.Model = p.Model
		return []protocol.Event{ev}, nil
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

// StartFromCheckpoint launches a new Codex session seeded by a checkpoint.
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
	return adapter.ExecSpec{Command: "codex", Args: []string{"exec", "--", prompt}}, nil
}

// Compile-time interface compliance check.
var _ adapter.Adapter = (*Codex)(nil)

// codexHook mirrors the documented Codex hook payload fields.
type codexHook struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id"`
	Cwd       string          `json:"cwd"`
	Model     string          `json:"model"`
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
	TurnID    string          `json:"turn_id"`
	ExitCode  *int            `json:"exit_code"`
}

// hookPayloadConsumed lists the hook payload fields consumed by the
// mapping above; everything else is preserved in Event.Unknown.
var hookPayloadConsumed = map[string]bool{
	"type":        true,
	"session_id":  true,
	"cwd":         true,
	"model":       true,
	"tool_name":   true,
	"tool_input":  true,
	"tool_use_id": true,
	"turn_id":     true,
	"exit_code":   true,
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
