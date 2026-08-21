// Package pi implements the provider adapter for Pi (badlogic/pi-mono
// coding agent) sessions (v0.4.0 scope).
//
// Pi is extension-based rather than hook-based: observation is performed by
// a managed TypeScript extension that HandoffGraph installs under
// ~/.pi/agent/extensions/handoffgraph/. The extension subscribes to Pi's
// session lifecycle (start/switch/fork), message and tool events, and ships
// each one as a normalized `hfg.pi.event.v1` JSON line to the local
// collector (POST /v1/events), falling back to appending to
// ~/.handoffgraph/spool/pi-spool.jsonl when the daemon is unreachable.
//
// Normalize parses those envelope lines into canonical hfg.event.v1 events
// with Provider "pi" and provenance OBSERVED (the extension relays what it
// observed; nothing is inferred). Unrecognized event types are preserved as
// log.observed events with their source kind — evidence is never dropped
// silently.
//
// Native Pi sessions live as JSONL transcripts under
// ~/.pi/agent/sessions/<encoded-cwd>/..., whose first line is a
// {"type":"session","id":...,"timestamp":...} record. Detect enumerates
// them best-effort from that directory.
package pi

import (
	"bufio"
	"bytes"
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

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Errors reported by this adapter. Install never overwrites user
// configuration: any collision on the managed extension directory or the
// managed settings key is reported as ErrInstallConflict (fail-closed).
var (
	// ErrInstallConflict reports a collision between the managed Pi
	// extension/config and pre-existing user-owned state. Nothing is
	// modified when it is returned.
	ErrInstallConflict = errors.New("pi: existing handoffgraph configuration conflicts with install")
	// ErrUnsupported reports a capability this adapter version does not
	// implement yet (never a partial or fabricated result).
	ErrUnsupported = errors.New("pi: operation not supported by this adapter version")
)

// EnvelopeSchema is the marker every normalized Pi extension event carries.
const EnvelopeSchema = "hfg.pi.event.v1"

// Pi event types (wire contract with the TypeScript extension). The dot
// forms follow the pi-mono extension event names; the extension is the only
// producer and this package is the only consumer.
const (
	TypeSessionStart     = "session.start"
	TypeSessionSwitch    = "session.switch"
	TypeSessionFork      = "session.fork"
	TypeMessageUser      = "message.user"
	TypeMessageAssistant = "message.assistant"
	TypeToolStart        = "tool.start"
	TypeToolEnd          = "tool.end"
)

// Pi adapts the Pi coding agent. The zero value resolves the real Pi home
// (~/.pi/agent). Fields exist for tests and non-standard installs.
type Pi struct {
	// AgentDir overrides the Pi agent directory (~/.pi/agent) that holds
	// extensions/ and settings.json.
	AgentDir string
	// SessionsDir overrides the sessions directory (~/.pi/agent/sessions)
	// used by Detect.
	SessionsDir string
	// ExtensionSourceDir overrides the directory the installer copies the
	// extension from. Empty uses the copy embedded in this binary.
	ExtensionSourceDir string
}

// New returns a Pi adapter using the default Pi home.
func New() *Pi { return &Pi{} }

// ResolvedAgentDir returns the effective Pi agent directory: the
// AgentDir field when set, otherwise ~/.pi/agent. The CLI uses it to
// report where the extension landed; an empty result means the home
// directory could not be resolved.
func (p *Pi) ResolvedAgentDir() string { return p.agentDir() }

// agentDir resolves the Pi agent directory.
func (p *Pi) agentDir() string {
	if p.AgentDir != "" {
		return p.AgentDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent")
}

// Name implements adapter.Adapter.
func (p *Pi) Name() string { return protocol.ProviderPi }

// Capabilities reports what this adapter supports honestly: Pi observation
// is extension-based (not hooks), message and tool events are captured, and
// native resume exists. Fork/compaction/diff events, exit-status fidelity
// and structured streaming are not captured by the v0.4.0 extension
// skeleton, and session enumeration is best-effort file scanning rather
// than a native session-list API.
func (p *Pi) Capabilities() adapter.Capabilities {
	return adapter.Capabilities{
		NativeResume:        true,
		NativeFork:          false,
		Hooks:               false,
		ToolEvents:          true,
		PromptEvents:        true,
		CompactionEvents:    false,
		DiffEvents:          false,
		TestExitStatus:      false,
		StructuredStreaming: false,
		SessionEnumeration:  false,
	}
}

// DefaultRegistry returns a fresh registry with the Pi adapter registered.
func DefaultRegistry() *adapter.Registry {
	return adapter.NewRegistry(&Pi{})
}

// Detect enumerates Pi session transcripts under the sessions directory,
// newest first. dir is used when non-empty, then p.SessionsDir, then
// ~/.pi/agent/sessions. Detection is best-effort: a missing directory or
// unreadable entries yield no sessions (never a partial or fabricated
// session), and every Pi transcript starts with a
// {"type":"session","id":...} line — files whose head cannot be parsed are
// skipped, not guessed at. Output is sorted deterministically (newest
// first, then native id) so repeated runs over the same directory emit the
// same slice.
func (p *Pi) Detect(ctx context.Context, dir string) ([]adapter.SessionRef, error) {
	if dir == "" {
		dir = p.SessionsDir
	}
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("pi detect: cannot resolve home: %w", err)
		}
		dir = filepath.Join(home, ".pi", "agent", "sessions")
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
	if walkErr != nil && !errors.Is(walkErr, context.Canceled) {
		return nil, walkErr
	}
	if walkErr != nil {
		return nil, walkErr
	}

	// Newest first; NativeID breaks ties deterministically.
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].LastEventAt.Equal(refs[j].LastEventAt) {
			return refs[i].LastEventAt.After(refs[j].LastEventAt)
		}
		return refs[i].NativeID < refs[j].NativeID
	})
	return refs, nil
}

// detectSession peeks at the head of a Pi transcript: the first line must
// be the native {"type":"session","id":...,"timestamp":...} record. The
// head timestamp is the best available session-start time without reading
// the whole transcript (best-effort by design).
func detectSession(path string) (adapter.SessionRef, bool) {
	f, err := os.Open(path)
	if err != nil {
		return adapter.SessionRef{}, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return adapter.SessionRef{}, false
	}
	var head struct {
		Type      string    `json:"type"`
		ID        string    `json:"id"`
		Timestamp time.Time `json:"timestamp"`
	}
	if json.Unmarshal(scanner.Bytes(), &head) != nil || head.Type != "session" || head.ID == "" {
		return adapter.SessionRef{}, false
	}
	return adapter.SessionRef{
		Provider:    protocol.ProviderPi,
		NativeID:    head.ID,
		LastEventAt: head.Timestamp,
	}, true
}

// envelope is the normalized Pi extension event (hfg.pi.event.v1). Unknown
// top-level fields are preserved on the canonical event.
type envelope struct {
	Schema          string          `json:"schema"`
	Type            string          `json:"type"`
	SessionID       string          `json:"sessionID"`
	ParentSessionID string          `json:"parentSessionID,omitempty"`
	Timestamp       time.Time       `json:"timestamp"`
	CWD             string          `json:"cwd,omitempty"`
	Model           string          `json:"model,omitempty"`
	Message         string          `json:"message,omitempty"`
	Tool            string          `json:"tool,omitempty"`
	Input           json.RawMessage `json:"input,omitempty"`
	Output          string          `json:"output,omitempty"`
	Error           string          `json:"error,omitempty"`

	// Unknown preserves envelope fields outside this schema version.
	Unknown map[string]json.RawMessage `json:"-"`
}

func (e *envelope) UnmarshalJSON(data []byte) error {
	type alias envelope
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*e = envelope(a)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for k, v := range raw {
		switch k {
		case "schema", "type", "sessionID", "parentSessionID", "timestamp",
			"cwd", "model", "message", "tool", "input", "output", "error":
		default:
			if e.Unknown == nil {
				e.Unknown = make(map[string]json.RawMessage)
			}
			e.Unknown[k] = v
		}
	}
	return nil
}

// mapKind is the documented envelope→canonical mapping:
//
//	session.start      → session.started
//	session.switch     → session.resumed
//	session.fork       → session.started (payload.source=fork, parent kept)
//	message.user       → prompt.submitted
//	message.assistant  → assistant.completed
//	tool.start         → tool.started
//	tool.end           → tool.completed / tool.failed (when error present)
//	anything else      → log.observed (source kind preserved)
func mapKind(t string, hasError bool) protocol.EventKind {
	switch t {
	case TypeSessionStart:
		return protocol.EventSessionStarted
	case TypeSessionSwitch:
		return protocol.EventSessionResumed
	case TypeSessionFork:
		return protocol.EventSessionStarted
	case TypeMessageUser:
		return protocol.EventPromptSubmitted
	case TypeMessageAssistant:
		return protocol.EventAssistantCompleted
	case TypeToolStart:
		return protocol.EventToolStarted
	case TypeToolEnd:
		if hasError {
			return protocol.EventToolFailed
		}
		return protocol.EventToolCompleted
	}
	return protocol.EventLogObserved
}

// buildEvent converts one decoded envelope into a canonical event. The
// payload keeps the source kind so no provenance is lost, and the event ID
// is derived deterministically from (native session id, type, occurred-at,
// content hash) so re-importing the same extension event is idempotent. An
// envelope without a session id cannot be scoped: it gets a fresh random
// event ID (unique evidence, at the cost of idempotency for that event
// only), mirroring the codex adapter's unidentifiable-rollout rule.
func buildEvent(e *envelope) (*protocol.Event, error) {
	payload := map[string]any{
		"source_kind": e.Type,
	}
	if e.ParentSessionID != "" {
		payload["parent_session_id"] = e.ParentSessionID
	}
	if e.CWD != "" {
		payload["cwd"] = e.CWD
	}

	ev := &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		OccurredAt:      e.Timestamp,
		ObservedAt:      e.Timestamp,
		Provider:        protocol.ProviderPi,
		Agent:           protocol.ProviderPi,
		Kind:            mapKind(e.Type, e.Error != ""),
		NativeSessionID: e.SessionID,
		Provenance:      protocol.ProvenanceObserved,
	}

	switch ev.Kind {
	case protocol.EventSessionStarted:
		if e.Type == TypeSessionFork {
			payload["source"] = "fork"
		}
		if e.Model != "" {
			ev.Model = e.Model
			payload["model"] = e.Model
		}
	case protocol.EventSessionResumed:
		payload["source"] = "switch"
	case protocol.EventPromptSubmitted, protocol.EventAssistantCompleted:
		payload["message"] = truncate(e.Message, 4096)
		if e.Model != "" {
			ev.Model = e.Model
			payload["model"] = e.Model
		}
	case protocol.EventToolStarted:
		payload["tool"] = e.Tool
		payload["input"] = json.RawMessage(orNull(e.Input))
	case protocol.EventToolCompleted, protocol.EventToolFailed:
		payload["tool"] = e.Tool
		payload["output"] = truncate(e.Output, 4096)
		if e.Error != "" {
			payload["error"] = truncate(e.Error, 4096)
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

	ms := e.Timestamp.UnixMilli()
	if ms < 0 {
		ms = 0
	}
	if e.SessionID == "" {
		ev.EventID = ids.Event()
	} else {
		key := strings.Join([]string{"pi", e.SessionID, e.Type, fmt.Sprintf("%d", ms), hash}, "|")
		ev.EventID = ids.EventDeterministic(key, uint64(ms))
	}

	// Preserve unknown envelope fields so no evidence is lost.
	for k, v := range e.Unknown {
		if ev.Unknown == nil {
			ev.Unknown = make(map[string]json.RawMessage)
		}
		ev.Unknown[k] = v
	}
	return ev, nil
}

// Normalize converts one Pi extension event (a single hfg.pi.event.v1 JSON
// object, as POSTed by the installed extension or spooled by it) into
// canonical events. It is a pure function of the input bytes: same input,
// same events (including IDs). Malformed JSON is rejected; an envelope with
// an unrecognized envelope marker or event type still normalizes to a
// log.observed event so nothing is dropped silently.
func (p *Pi) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errors.New("pi normalize: empty payload")
	}
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("pi normalize: %w", err)
	}
	ev, err := buildEvent(&e)
	if err != nil {
		return nil, fmt.Errorf("pi normalize: %w", err)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return []protocol.Event{*ev}, nil
}

// Resume returns the native resume invocation for a Pi session:
// `pi --resume <session-id>`. The id is validated first: empty and
// dash-prefixed ids are rejected so they can never be mistaken for flags.
func (p *Pi) Resume(ctx context.Context, ref adapter.SessionRef) (adapter.ExecSpec, error) {
	id := ref.NativeID
	if id == "" {
		return adapter.ExecSpec{}, errors.New("pi resume: session id is required")
	}
	if strings.HasPrefix(id, "-") {
		return adapter.ExecSpec{}, fmt.Errorf("pi resume: invalid session id %q", id)
	}
	return adapter.ExecSpec{Command: "pi", Args: []string{"--resume", id}}, nil
}

// StartFromCheckpoint is not implemented in this adapter version.
func (p *Pi) StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (adapter.ExecSpec, error) {
	return adapter.ExecSpec{}, fmt.Errorf("pi start-from-checkpoint: %w (planned for a later v0.4.x cut)", ErrUnsupported)
}

// truncate caps oversized text fields; large bodies belong in the object
// store as references, never inlined into events.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// orNull renders an optional raw JSON field as "null" when absent.
func orNull(v json.RawMessage) string {
	if len(v) == 0 {
		return "null"
	}
	return string(v)
}

// Compile-time interface compliance check.
var _ adapter.Adapter = (*Pi)(nil)
