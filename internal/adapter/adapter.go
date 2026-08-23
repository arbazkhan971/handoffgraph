// Package adapter defines the provider adapter contract.
//
// Adapters normalize provider-native coding-agent telemetry into
// hfg.event.v1 events. They must be honest about capabilities: unsupported
// capabilities are reported as unavailable and never fabricated.
package adapter

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Sentinel errors adapters may return. Adapters that have their own richer
// error types should wrap these so callers can use errors.Is uniformly.
var (
	// ErrUnsupported reports a capability this adapter version lacks.
	ErrUnsupported = errors.New("adapter: capability not supported")
	// ErrNotDetected reports that no native sessions were found.
	ErrNotDetected = errors.New("adapter: no native sessions detected")
	// ErrHookConflict reports an existing hook configuration that
	// HandoffGraph refuses to overwrite (release-hold condition).
	ErrHookConflict = errors.New("adapter: existing hook configuration conflicts; refusing to overwrite")
)

// InstallScope selects where an adapter installs its hooks.
type InstallScope string

const (
	ScopeUser    InstallScope = "user"
	ScopeProject InstallScope = "project"
)

// Capabilities declares what a provider supports. The UI must display
// missing capabilities honestly instead of manufacturing equivalence.
type Capabilities struct {
	NativeResume        bool `json:"native_resume"`
	NativeFork          bool `json:"native_fork"`
	CheckpointLaunch    bool `json:"checkpoint_launch"`
	Hooks               bool `json:"hooks"`
	ToolEvents          bool `json:"tool_events"`
	PromptEvents        bool `json:"prompt_events"`
	CompactionEvents    bool `json:"compaction_events"`
	DiffEvents          bool `json:"diff_events"`
	TestExitStatus      bool `json:"test_exit_status"`
	StructuredStreaming bool `json:"structured_streaming"`
	SessionEnumeration  bool `json:"session_enumeration"`
}

// SessionRef references a provider-native session.
type SessionRef struct {
	Provider     string    `json:"provider"`
	NativeID     string    `json:"native_id"`
	SessionID    string    `json:"session_id,omitempty"`
	LastEventAt  time.Time `json:"last_event_at,omitempty"`
	WorkstreamID string    `json:"workstream_id,omitempty"`

	// Optional listing metadata (Detect --detect mode). Zero values mean
	// unknown; adapters fill what the provider exposes.
	Path      string    `json:"path,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
	EndedAt   time.Time `json:"ended_at,omitempty"`
	Model     string    `json:"model,omitempty"`
}

// ExecSpec describes how to launch a native agent process.
type ExecSpec struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Dir     string            `json:"dir,omitempty"`
}

// Adapter is the narrow provider contract (roadmap §6.2).
type Adapter interface {
	// Name returns the provider name (claude | codex | pi).
	Name() string
	// Detect enumerates sessions visible on this machine.
	Detect(ctx context.Context, dir string) ([]SessionRef, error)
	// Install registers hooks/config. It MUST merge with existing user
	// configuration and never overwrite blindly.
	Install(ctx context.Context, scope InstallScope) error
	// Uninstall removes HandoffGraph hooks while preserving user config.
	Uninstall(ctx context.Context, scope InstallScope) error
	// Normalize converts a provider-native hook payload into canonical events.
	Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error)
	// Resume returns the native resume invocation for a session.
	Resume(ctx context.Context, ref SessionRef) (ExecSpec, error)
	// StartFromCheckpoint returns a launch spec seeded by a checkpoint. The
	// checkpoint prompt must be the final argv element: the continuation layer
	// replaces that seed with its exact bounded, provenance-preserving payload
	// before recording or displaying the spec.
	StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (ExecSpec, error)
	// Capabilities declares supported provider features.
	Capabilities() Capabilities
}

// Registry holds installed adapters by provider name.
type Registry struct {
	byName map[string]Adapter
}

// NewRegistry returns an empty registry.
func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{byName: map[string]Adapter{}}
	for _, a := range adapters {
		r.byName[a.Name()] = a
	}
	return r
}

// Get returns the adapter for a provider name.
func (r *Registry) Get(name string) (Adapter, bool) {
	a, ok := r.byName[name]
	return a, ok
}

// Names returns the registered provider names in sorted order.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.byName))
	for k := range r.byName {
		out = append(out, k)
	}
	// deterministic order
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
