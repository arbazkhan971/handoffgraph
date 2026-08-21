package adapter

import (
	"context"
	"errors"
	"io"
	"sort"
	"sync"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Name identifies a provider adapter. Values match the provider identifiers
// in internal/protocol (claude | codex | pi).
type Name string

// Supported adapter names.
const (
	NameClaude Name = "claude"
	NameCodex  Name = "codex"
	NamePi     Name = "pi"
)

// Capabilities declares what an adapter can honestly do. The UI must display
// missing capabilities instead of manufacturing equivalence.
type Capabilities struct {
	// Hooks reports whether the provider supports hook-based observation.
	Hooks bool
	// AppServer reports whether the provider exposes an app-server /
	// structured streaming integration.
	AppServer bool
	// ResumeFromCheckpoint reports whether StartFromCheckpoint is
	// implemented (native resume of a checkpoint-derived session).
	ResumeFromCheckpoint bool
	// NativeSessionList reports whether Detect can enumerate sessions
	// natively (as opposed to scanning on-disk transcript files).
	NativeSessionList bool
	// NormalizesKinds lists the canonical hfg.event.v1 kinds this adapter
	// can produce from native events. Sorted before emitting.
	NormalizesKinds []string
}

// SessionRef is a minimal reference to one native agent session.
type SessionRef struct {
	Agent           Name
	NativeSessionID string
	Path            string
	StartedAt       time.Time
	EndedAt         time.Time
	Model           string
}

// InstallOptions controls adapter installation into a provider's config.
//
// DryRun must be supported by every adapter: a dry run performs all conflict
// checks and reports what would change without writing anything.
type InstallOptions struct {
	DryRun      bool
	ConfigDir   string
	HookCommand string
}

// Sentinel errors returned by adapters. Callers must compare with errors.Is.
var (
	// ErrNotDetected is returned by Detect when no native sessions exist.
	ErrNotDetected = errors.New("adapter: no native sessions detected")
	// ErrUnsupported is returned for operations not implemented by this
	// adapter version (install/resume land incrementally per provider).
	ErrUnsupported = errors.New("not supported by this adapter version")
	// ErrHookConflict is returned when installing would overwrite existing
	// user hook configuration. Never resolve by overwriting; this is a
	// release-hold condition.
	ErrHookConflict = errors.New("adapter: install would overwrite existing user hook configuration")
)

// Adapter normalizes one provider's native sessions into hfg.event.v1
// events and optionally manages that provider's hook configuration and
// resume flow.
type Adapter interface {
	// Name returns the stable adapter identifier.
	Name() Name
	// Detect enumerates discoverable native sessions, newest first.
	// Returns ErrNotDetected when none are found.
	Detect(ctx context.Context) ([]SessionRef, error)
	// Install wires HandoffGraph hooks into the provider's configuration.
	// Must honor InstallOptions.DryRun and return ErrHookConflict rather
	// than overwrite user configuration.
	Install(ctx context.Context, opts InstallOptions) error
	// Uninstall removes previously installed HandoffGraph hooks.
	Uninstall(ctx context.Context) error
	// Normalize decodes raw native events from src and converts them to
	// canonical protocol.Events. The source kind is always preserved in
	// the event payload; provenance is never upgraded.
	Normalize(ctx context.Context, src io.Reader) ([]protocol.Event, error)
	// Resume continues an existing native session in the provider's own
	// CLI. Returns ErrUnsupported until implemented.
	Resume(ctx context.Context, session SessionRef) error
	// StartFromCheckpoint launches a new native session seeded from a
	// portable checkpoint. Returns ErrUnsupported until implemented.
	StartFromCheckpoint(ctx context.Context, cp protocol.Checkpoint) (SessionRef, error)
	// Capabilities reports what this adapter version supports.
	Capabilities() Capabilities
}

// Registry holds the registered adapters. Safe for concurrent use.
type Registry struct {
	mu       sync.RWMutex
	adapters map[Name]Adapter
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry {
	return &Registry{adapters: make(map[Name]Adapter)}
}

// Register adds an adapter. If an adapter with the same name is already
// registered, the first registration wins and the new one is ignored, so
// registration order across packages cannot silently replace an adapter.
func (r *Registry) Register(a Adapter) {
	if a == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	name := a.Name()
	if _, exists := r.adapters[name]; exists {
		return
	}
	r.adapters[name] = a
}

// ByName looks up an adapter by name.
func (r *Registry) ByName(name Name) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[name]
	return a, ok
}

// Names returns all registered adapter names sorted deterministically.
func (r *Registry) Names() []string {
	r.mu.RLock()
	names := make([]string, 0, len(r.adapters))
	for name := range r.adapters {
		names = append(names, string(name))
	}
	r.mu.RUnlock()
	sort.Strings(names)
	return names
}
