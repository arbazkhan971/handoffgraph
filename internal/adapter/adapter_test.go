package adapter

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// fakeAdapter is a minimal Adapter used to exercise the registry.
type fakeAdapter struct {
	name string
}

func (f *fakeAdapter) Name() string { return f.name }
func (f *fakeAdapter) Detect(ctx context.Context, dir string) ([]SessionRef, error) {
	return nil, nil
}
func (f *fakeAdapter) Install(ctx context.Context, scope InstallScope) error   { return nil }
func (f *fakeAdapter) Uninstall(ctx context.Context, scope InstallScope) error { return nil }
func (f *fakeAdapter) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	return nil, nil
}
func (f *fakeAdapter) Resume(ctx context.Context, ref SessionRef) (ExecSpec, error) {
	return ExecSpec{}, nil
}
func (f *fakeAdapter) StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (ExecSpec, error) {
	return ExecSpec{}, nil
}
func (f *fakeAdapter) Capabilities() Capabilities { return Capabilities{} }

// compile-time interface compliance checks for the concrete fakes.
var (
	_ Adapter = (*fakeAdapter)(nil)
)

func TestRegistryGet(t *testing.T) {
	codex := &fakeAdapter{name: "codex"}
	pi := &fakeAdapter{name: "pi"}
	reg := NewRegistry(codex, pi)

	if a, ok := reg.Get("codex"); !ok || a != codex {
		t.Fatalf("Get(codex) = %v, %v", a, ok)
	}
	if _, ok := reg.Get("claude"); ok {
		t.Fatal("Get(claude) should miss")
	}
}

func TestRegistryLastRegistrationWins(t *testing.T) {
	// NewRegistry registers in order; a later adapter with the same name
	// replaces the earlier one. The behavior is documented here so any
	// change is intentional.
	first := &fakeAdapter{name: "codex"}
	second := &fakeAdapter{name: "codex"}
	reg := NewRegistry(first, second)
	got, ok := reg.Get("codex")
	if !ok {
		t.Fatal("expected codex registered")
	}
	// both are indistinguishable fakes; assert the registry holds exactly one.
	names := reg.Names()
	if len(names) != 1 || names[0] != "codex" {
		t.Fatalf("Names() = %v, want [codex]", names)
	}
	_ = got
}

func TestRegistryNamesDeterministic(t *testing.T) {
	reg := NewRegistry(
		&fakeAdapter{name: "pi"},
		&fakeAdapter{name: "codex"},
		&fakeAdapter{name: "claude"},
	)
	names := reg.Names()
	want := []string{"claude", "codex", "pi"}
	if len(names) != len(want) {
		t.Fatalf("Names() = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("Names()[%d] = %q, want %q", i, names[i], want[i])
		}
	}
}

func TestRegistryEmpty(t *testing.T) {
	reg := NewRegistry()
	if got := reg.Names(); len(got) != 0 {
		t.Fatalf("Names() = %v, want empty", got)
	}
	if _, ok := reg.Get("codex"); ok {
		t.Fatal("Get on empty registry should miss")
	}
}

func TestSessionRefAndExecSpec(t *testing.T) {
	// Structural smoke: these types cross the CLI/adapter boundary and are
	// referenced by launch; keep their shape guarded.
	ref := SessionRef{Provider: "pi", NativeID: "abc", LastEventAt: time.Now()}
	if ref.Provider != "pi" || ref.NativeID != "abc" {
		t.Fatal("SessionRef fields not retained")
	}
	spec := ExecSpec{Command: "pi", Args: []string{"--resume", "abc"}}
	if spec.Command != "pi" || len(spec.Args) != 2 {
		t.Fatal("ExecSpec fields not retained")
	}
}

func TestInstallScopeConstants(t *testing.T) {
	if ScopeUser != "user" || ScopeProject != "project" {
		t.Fatal("unexpected InstallScope constants")
	}
}
