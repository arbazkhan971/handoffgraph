// Package codex implements the provider adapter for OpenAI Codex CLI
// sessions (v0.2.0 scope).
//
// Codex stores session transcripts as JSONL "rollout" files under
// ~/.codex/sessions (layout varies by version, e.g.
// sessions/YYYY/MM/DD/rollout-*.jsonl). Each line is a JSON object with at
// least a "type" discriminator and usually a "timestamp" plus a nested
// "payload". Because the native format evolves, Normalize is deliberately
// tolerant: recognized types map onto canonical hfg.event.v1 kinds, and any
// unrecognized line still becomes a log.observed event with its source kind
// preserved in payload.source_kind. Nothing is dropped silently and no
// provenance is upgraded: every fact parsed from a transcript is OBSERVED.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Codex adapts OpenAI Codex CLI sessions. SessionsDir overrides the default
// ~/.codex/sessions location (used by tests and non-standard installs).
// ConfigDir overrides the default ~/.codex configuration directory used by
// Install/Uninstall (used by tests and non-standard installs).
type Codex struct {
	SessionsDir string
	ConfigDir   string
}

// New returns a Codex adapter using the default sessions directory.
func New() *Codex { return &Codex{} }

// configDir resolves the Codex configuration directory.
func (c *Codex) configDir() string {
	if c.ConfigDir != "" {
		return c.ConfigDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// Name implements Adapter.
func (c *Codex) Name() adapter.Name { return adapter.NameCodex }

// Capabilities reports what this adapter version supports honestly. Native
// resume and checkpoint-seeded launch land in later v0.2.x cuts.
func (c *Codex) Capabilities() adapter.Capabilities {
	return adapter.Capabilities{
		Hooks:                true,
		AppServer:            false,
		ResumeFromCheckpoint: false,
		NativeSessionList:    false,
		NormalizesKinds:      normalizedKinds(),
	}
}

// normalizedKinds lists the canonical kinds Normalize can emit, sorted.
func normalizedKinds() []string {
	kinds := []string{
		string(protocol.EventAssistantCompleted),
		string(protocol.EventCommandCompleted),
		string(protocol.EventLogObserved),
		string(protocol.EventPromptSubmitted),
		string(protocol.EventSessionStarted),
		string(protocol.EventToolCompleted),
		string(protocol.EventToolStarted),
	}
	sort.Strings(kinds)
	return kinds
}

// DefaultRegistry returns a fresh registry with the Codex adapter registered.
func DefaultRegistry() *adapter.Registry {
	r := adapter.NewRegistry()
	r.Register(&Codex{})
	return r
}

// Detect enumerates Codex rollout transcripts under the sessions directory,
// newest first. It returns an error wrapping adapter.ErrNotDetected when the
// directory is missing or contains no parseable sessions.
func (c *Codex) Detect(ctx context.Context) ([]adapter.SessionRef, error) {
	dir := c.SessionsDir
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("%w: cannot resolve home: %v", adapter.ErrNotDetected, err)
		}
		dir = filepath.Join(home, ".codex", "sessions")
	}

	var refs []adapter.SessionRef
	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if ref, ok := detectSession(path); ok {
			refs = append(refs, ref)
		}
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	if len(refs) == 0 {
		return nil, fmt.Errorf("%w: no codex rollout files under %s", adapter.ErrNotDetected, dir)
	}

	// Newest first; Path breaks ties deterministically.
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].StartedAt.Equal(refs[j].StartedAt) {
			return refs[i].StartedAt.After(refs[j].StartedAt)
		}
		return refs[i].Path < refs[j].Path
	})
	return refs, nil
}

// detectSession peeks at the head of a rollout file to extract the native
// session id and start time without reading the whole transcript.
func detectSession(path string) (adapter.SessionRef, bool) {
	f, err := os.Open(path)
	if err != nil {
		return adapter.SessionRef{}, false
	}
	defer f.Close()

	ref := adapter.SessionRef{Agent: adapter.NameCodex, Path: path}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() && ref.NativeSessionID == "" {
		line := scanner.Bytes()
		if !utf8.Valid(line) {
			continue
		}
		var raw struct {
			Type      string          `json:"type"`
			Timestamp time.Time       `json:"timestamp"`
			Payload   json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(line, &raw) != nil {
			continue
		}
		if ref.StartedAt.IsZero() && !raw.Timestamp.IsZero() {
			ref.StartedAt = raw.Timestamp
		}
		if raw.Type != "session_meta" || len(raw.Payload) == 0 {
			continue
		}
		var meta struct {
			ID    string    `json:"id"`
			Model string    `json:"model"`
			Time  time.Time `json:"timestamp"`
		}
		if json.Unmarshal(raw.Payload, &meta) == nil {
			ref.NativeSessionID = meta.ID
			ref.Model = meta.Model
			if !meta.Time.IsZero() {
				ref.StartedAt = meta.Time
			}
		}
	}
	if ref.NativeSessionID == "" {
		return adapter.SessionRef{}, false
	}
	return ref, true
}

// nativeLine mirrors one rollout JSONL line. Unknown fields are preserved by
// keeping the full raw object alongside the decoded view.
type nativeLine struct {
	Type      string          `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`

	// Unknown preserves top-level fields outside the schema above.
	Unknown map[string]json.RawMessage `json:"-"`
}

func (n *nativeLine) UnmarshalJSON(data []byte) error {
	type alias nativeLine
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*n = nativeLine(a)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for k, v := range raw {
		switch k {
		case "type", "timestamp", "payload":
		default:
			if n.Unknown == nil {
				n.Unknown = make(map[string]json.RawMessage)
			}
			n.Unknown[k] = v
		}
	}
	return nil
}

// payloadView decodes the nested payload as a generic object so mapping
// rules can probe optional fields without hard-failing on shape drift.
type payloadView map[string]json.RawMessage

func (n *nativeLine) payload() payloadView {
	if len(n.Payload) == 0 {
		return payloadView{}
	}
	var m payloadView
	if json.Unmarshal(n.Payload, &m) != nil || m == nil {
		return payloadView{}
	}
	return m
}

func (p payloadView) str(key string) string {
	if p == nil {
		return ""
	}
	var s string
	if err := json.Unmarshal(p[key], &s); err != nil {
		return ""
	}
	return s
}

func (p payloadView) num(key string) (float64, bool) {
	if p == nil {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(p[key], &f); err != nil {
		return 0, false
	}
	return f, true
}

// kindMapping is the documented native→canonical mapping table.
//
//	session_meta                          → session.started
//	event_msg{user_message}               → prompt.submitted
//	event_msg{agent_message}              → assistant.completed
//	response_item{function_call}          → tool.started
//	response_item{function_call_output}   → tool.completed
//	response_item{exec_command, ...exit}  → command.completed
//	anything else                         → log.observed (source_kind kept)
func mapKind(lineType string, p payloadView) protocol.EventKind {
	switch lineType {
	case "session_meta":
		return protocol.EventSessionStarted
	case "event_msg":
		switch p.str("type") {
		case "user_message":
			return protocol.EventPromptSubmitted
		case "agent_message":
			return protocol.EventAssistantCompleted
		}
	case "response_item":
		switch p.str("type") {
		case "function_call":
			return protocol.EventToolStarted
		case "function_call_output":
			return protocol.EventToolCompleted
		case "exec_command":
			return protocol.EventCommandCompleted
		}
	}
	return protocol.EventLogObserved
}

// buildEvent converts one decoded native line into a canonical event.
// rolloutSessionID is the native session id declared by the stream's
// session_meta line ("" when the rollout declares none): only session.started
// lines carry it on the event itself, but every line of an identified
// rollout must derive its event ID from it.
func buildEvent(rolloutSessionID string, seq int64, n *nativeLine) (*protocol.Event, error) {
	p := n.payload()
	payload := map[string]any{
		"source_kind": n.Type,
	}
	if inner := p.str("type"); inner != "" {
		payload["source_payload_type"] = inner
	}

	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		Sequence:      seq,
		OccurredAt:    n.Timestamp,
		ObservedAt:    n.Timestamp,
		Provider:      protocol.ProviderCodex,
		Kind:          mapKind(n.Type, p),
		Provenance:    protocol.ProvenanceObserved,
	}

	switch ev.Kind {
	case protocol.EventSessionStarted:
		payload["native_session_id"] = p.str("id")
		ev.NativeSessionID = p.str("id")
		if m := p.str("model"); m != "" {
			ev.Model = m
			payload["model"] = m
		}
	case protocol.EventPromptSubmitted:
		payload["message"] = truncate(p.str("message"), 4096)
	case protocol.EventAssistantCompleted:
		payload["message"] = truncate(p.str("message"), 4096)
	case protocol.EventToolStarted:
		payload["tool"] = p.str("name")
		payload["arguments"] = json.RawMessage(orNull(p["arguments"]))
	case protocol.EventToolCompleted:
		payload["output"] = truncate(p.str("output"), 4096)
	case protocol.EventCommandCompleted:
		payload["command"] = p.str("command")
		if code, ok := p.num("exit_code"); ok {
			payload["exit_code"] = int64(code)
		}
	}

	rawPayload, err := content.CanonicalJSON(payload)
	if err != nil {
		return nil, fmt.Errorf("canonicalize payload: %w", err)
	}
	ev.Payload = rawPayload
	hash, err := content.Hash(rawPayload)
	if err != nil {
		return nil, fmt.Errorf("hash payload: %w", err)
	}
	ev.ContentHash = hash
	// Stable event ID: derived from the rollout's native session id (the
	// session_meta payload.id; set on ev.NativeSessionID above only for
	// session.started lines), sequence, timestamp and content hash so
	// re-importing the same rollout yields identical event IDs.
	// Rollouts whose session_meta lacks payload.id are unidentifiable: two
	// DIFFERENT such files with equal seq/timestamp/hash would collide on the
	// same derived ID and the second import would silently drop evidence.
	// Fail safe instead: every line of an unidentifiable rollout gets a fresh
	// random event ID (unique, at the cost of re-import idempotency for that
	// rollout only); identifiable rollouts stay fully deterministic.
	if rolloutSessionID == "" {
		ev.EventID = ids.Event()
	} else {
		ev.EventID = deriveEventID(rolloutSessionID, seq, ev.OccurredAt, hash)
	}
	// Preserve unknown top-level native fields so no evidence is lost.
	for k, v := range n.Unknown {
		if ev.Unknown == nil {
			ev.Unknown = make(map[string]json.RawMessage)
		}
		ev.Unknown[k] = v
	}
	return ev, nil
}

func orNull(v json.RawMessage) string {
	if len(v) == 0 {
		return "null"
	}
	return string(v)
}

// truncate caps oversized text fields; large bodies belong in the object
// store as references, never inlined into events.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// Normalize decodes a Codex rollout stream into canonical events. It is a
// pure function of the input: same bytes in, same events out. Malformed
// lines fail with their line number rather than being skipped.
func (c *Codex) Normalize(ctx context.Context, src io.Reader) ([]protocol.Event, error) {
	out := []protocol.Event{}
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	var seq int64
	lineNo := 0
	// rolloutSessionID is the native session id declared by the stream's
	// session_meta payload.id ("" when absent). It scopes every derived event
	// ID: lines of an identified rollout stay deterministic across re-import,
	// while an unidentifiable rollout falls back to random ids.Event() per
	// line so two different id-less rollouts can never collide.
	var rolloutSessionID string
	for scanner.Scan() {
		lineNo++
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("codex normalize line %d: invalid UTF-8", lineNo)
		}
		var n nativeLine
		if err := json.Unmarshal(line, &n); err != nil {
			return nil, fmt.Errorf("codex normalize line %d: %w", lineNo, err)
		}
		seq++
		if n.Type == "session_meta" {
			rolloutSessionID = n.payload().str("id")
		}
		ev, err := buildEvent(rolloutSessionID, seq, &n)
		if err != nil {
			return nil, fmt.Errorf("codex normalize line %d: %w", lineNo, err)
		}
		out = append(out, *ev)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("codex normalize: %w", err)
	}
	return out, nil
}

// Install wires HandoffGraph observation hooks into the Codex CLI config
// (see hooks.go). It honors DryRun and fails closed on conflicts. A
// non-empty opts.ConfigDir overrides the adapter's resolved config dir.
func (c *Codex) Install(ctx context.Context, opts adapter.InstallOptions) error {
	dir := opts.ConfigDir
	if dir == "" {
		dir = c.configDir()
	}
	return installHooks(dir, opts)
}

// Uninstall removes previously installed HandoffGraph hooks from the Codex
// CLI config (see hooks.go).
func (c *Codex) Uninstall(ctx context.Context) error {
	return uninstallHooks(c.configDir())
}

// Resume is not implemented in this adapter version.
func (c *Codex) Resume(ctx context.Context, session adapter.SessionRef) error {
	return fmt.Errorf("codex resume: %w (planned for v0.2.x)", adapter.ErrUnsupported)
}

// StartFromCheckpoint is not implemented in this adapter version.
func (c *Codex) StartFromCheckpoint(ctx context.Context, cp protocol.Checkpoint) (adapter.SessionRef, error) {
	return adapter.SessionRef{}, fmt.Errorf("codex start-from-checkpoint: %w (planned for v0.2.x)", adapter.ErrUnsupported)
}

// Compile-time interface compliance check.
var _ adapter.Adapter = (*Codex)(nil)
