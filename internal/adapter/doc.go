// Package adapter defines the provider-adapter foundation for HandoffGraph:
// the narrow Adapter interface that normalizes native AI-agent sessions into
// hfg.event.v1 events, plus the registry and capability vocabulary used to
// discover adapters at runtime.
//
// v0.2.0 scope: this package is foundation-only. Adapters are expected to
// fully support Detect, Normalize, and Capabilities. Install, Uninstall,
// Resume, and StartFromCheckpoint land incrementally per provider
// (Codex v0.2.0, Claude v0.3.0, Pi v0.4.0); until an adapter implements one
// of those operations it must return ErrUnsupported rather than a partial or
// fabricated result. Install must never overwrite user hook configuration;
// a conflicting hook is reported as ErrHookConflict and is a release-hold
// condition.
package adapter
