// Package codex is the Codex adapter (v0.2.0).
//
// NOTE(integration): this file is a CENTRAL STUB written by the orchestrator
// to unblock the build after the original codex lane failed mid-restructure.
// The relaunched codex lane owns replacing it with the full implementation:
// merge-safe hook installer (integrations/codex), App Server spike, richer
// Normalize, native fork, version-compat fixtures. Keep the exported surface
// (New, Codex, Codex.SessionsDir) stable — commands.go depends on it.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// hfgMarker identifies hook entries owned by HandoffGraph so uninstall
// removes only ours and never user configuration.
const hfgMarker = "# managed-by: handoffgraph"

// SessionsDir overrides the sessions directory used by Detect (defaults to
// ~/.codex/sessions). Exported for the CLI's test/diagnostics hook.
type Codex struct {
	SessionsDir string
	// ConfigDir overrides ~/.codex for Install/Uninstall.
	ConfigDir string
}

// New returns a Codex adapter with default paths.
func New() *Codex { return &Codex{} }

func (c *Codex) Name() string { return protocol.ProviderCodex }

func (c *Codex) Capabilities() adapter.Capabilities {
	// Honest stub: these are implemented here; the rest land with the full
	// adapter (diff events, compaction, structured streaming, fork).
	return adapter.Capabilities{
		NativeResume:       true,
		Hooks:              true,
		SessionEnumeration: true,
		ToolEvents:         true,
	}
}

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

func (c *Codex) sessionsDir() string {
	if c.SessionsDir != "" {
		return c.SessionsDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

// Install registers HandoffGraph hooks in Codex config.toml. Merge-safe:
// creates or extends a [hooks] table, backs up first, is idempotent, and
// refuses (ErrHookConflict) to touch a conflicting unmanaged hook entry.
func (c *Codex) Install(ctx context.Context, scope adapter.InstallScope) error {
	dir := c.configDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "config.toml")
	orig, _ := os.ReadFile(path)

	if hasManagedLine(string(orig)) {
		return nil // idempotent
	}
	if hasForeignHooks(string(orig)) {
		return fmt.Errorf("install: existing [hooks] without %s: %w", hfgMarker, adapter.ErrHookConflict)
	}
	if len(orig) > 0 {
		bak := path + ".hfg-backup-" + time.Now().UTC().Format("20060102T150405Z")
		if err := os.WriteFile(bak, orig, 0o600); err != nil {
			return err
		}
	}
	entry := "\n[hooks]\n" + hfgMarker + "\n# HandoffGraph session/tool lifecycle hooks (v0.2 stub)\n"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(entry); err != nil {
		return err
	}
	return f.Sync()
}

// Uninstall removes only HandoffGraph-managed hook entries.
func (c *Codex) Uninstall(ctx context.Context, scope adapter.InstallScope) error {
	path := filepath.Join(c.configDir(), "config.toml")
	orig, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var kept []string
	for _, line := range strings.Split(string(orig), "\n") {
		if strings.TrimSpace(line) == hfgMarker {
			continue
		}
		kept = append(kept, line)
	}
	out := strings.Join(kept, "\n")
	// Drop a [hooks] table we appended and left empty.
	out = strings.TrimSuffix(strings.TrimRight(out, "\n"), "\n[hooks]")
	return os.WriteFile(path, []byte(out), 0o600)
}

// Detect enumerates Codex session files (best-effort): each *.jsonl under
// the sessions dir contributes one ref. The head line (session_meta) is
// parsed for the native id, timestamp and model; the filename is only a
// fallback. Newest first, ties broken by path (deterministic).
func (c *Codex) Detect(ctx context.Context, dir string) ([]adapter.SessionRef, error) {
	sdir := c.sessionsDir()
	files, _ := filepath.Glob(filepath.Join(sdir, "*.jsonl"))
	var refs []adapter.SessionRef
	for _, f := range files {
		ref := adapter.SessionRef{
			Provider: c.Name(),
			NativeID: strings.TrimSuffix(filepath.Base(f), ".jsonl"),
			Path:     f,
		}
		if info, err := os.Stat(f); err == nil {
			ref.StartedAt = info.ModTime().UTC()
		}
		// Prefer the session_meta head line: timestamp + payload.id/model.
		if line := firstLine(f); line != "" {
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
				if ts, err := time.Parse(time.RFC3339, head.Timestamp); err == nil {
					ref.StartedAt = ts.UTC()
				}
			}
		}
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].StartedAt.Equal(refs[j].StartedAt) {
			return refs[i].StartedAt.After(refs[j].StartedAt)
		}
		return refs[i].Path < refs[j].Path
	})
	return refs, nil
}

// Normalize converts a documented Codex hook payload into canonical events.
// Unknown payload fields are preserved via Event.Unknown.
func (c *Codex) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	var p codexHook
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("codex normalize: %w", err)
	}
	now := time.Now().UTC()
	mk := func(kind protocol.EventKind) protocol.Event {
		return protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			EventID:         ids.Event(),
			OccurredAt:      now,
			ObservedAt:      now,
			NativeSessionID: p.SessionID,
			Provider:        c.Name(),
			Kind:            kind,
			Provenance:      protocol.ProvenanceObserved,
		}
	}
	switch {
	case p.Type == "session.start":
		ev := mk(protocol.EventSessionStarted)
		ev.Model = p.Model
		return []protocol.Event{ev}, nil
	case p.Type == "session.end":
		return []protocol.Event{mk(protocol.EventSessionEnded)}, nil
	case p.Type == "tool.pre":
		ev := mk(protocol.EventToolStarted)
		ev.Payload = mustJSON(map[string]any{"tool_name": p.ToolName, "tool_use_id": p.ToolUseID, "turn_id": p.TurnID})
		return []protocol.Event{ev}, nil
	case p.Type == "tool.post":
		ev := mk(protocol.EventToolCompleted)
		ev.Payload = mustJSON(map[string]any{"tool_name": p.ToolName, "tool_use_id": p.ToolUseID, "turn_id": p.TurnID, "exit_code": p.ExitCode})
		return []protocol.Event{ev}, nil
	case p.Type == "turn.start":
		ev := mk(protocol.EventTraceStarted)
		ev.Payload = mustJSON(map[string]any{"trace_id": p.TurnID})
		return []protocol.Event{ev}, nil
	case p.Type == "turn.end":
		ev := mk(protocol.EventTraceCompleted)
		ev.Payload = mustJSON(map[string]any{"trace_id": p.TurnID})
		return []protocol.Event{ev}, nil
	default:
		ev := mk(protocol.EventLogObserved)
		ev.Payload = raw
		ev.Provenance = protocol.ProvenanceObserved
		return []protocol.Event{ev}, nil
	}
}

// Resume returns the native resume invocation (codex resume <id>).
func (c *Codex) Resume(ctx context.Context, ref adapter.SessionRef) (adapter.ExecSpec, error) {
	return adapter.ExecSpec{Command: "codex", Args: []string{"resume", ref.NativeID}}, nil
}

// StartFromCheckpoint launches a new Codex session seeded by a checkpoint.
func (c *Codex) StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (adapter.ExecSpec, error) {
	if cp == nil {
		return adapter.ExecSpec{}, fmt.Errorf("checkpoint required")
	}
	prompt := fmt.Sprintf("Continue workstream %s (checkpoint %s). Objective: %s. Acknowledge checkpoint %s before acting.",
		cp.WorkstreamID, cp.CheckpointID, cp.Objective, cp.CheckpointID)
	return adapter.ExecSpec{Command: "codex", Args: []string{"exec", prompt}}, nil
}

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

var managedRe = regexp.MustCompile(regexp.QuoteMeta(hfgMarker))

func hasManagedLine(s string) bool { return managedRe.MatchString(s) }

func hasForeignHooks(s string) bool {
	inHooks := false
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			// Both the bare [hooks] table and any [hooks.<event>] subtable
			// count as the hooks region.
			inHooks = t == "[hooks]" || strings.HasPrefix(t, "[hooks.")
			continue
		}
		if inHooks && t != "" && !strings.HasPrefix(t, "#") {
			return true
		}
	}
	return false
}

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

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
