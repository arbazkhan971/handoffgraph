package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// fakeAdapter implements Adapter for tests. Normalize decodes a JSON array
// of protocol.Event from src (a real round-trip through the envelope).
type fakeAdapter struct {
	name         Name
	caps         Capabilities
	detect       []SessionRef
	detectErr    error
	installErr   error
	uninstallErr error
	resumeErr    error
	startCPRef   SessionRef
	startCPErr   error

	installed   []InstallOptions
	uninstalled int
	resumed     []SessionRef
}

func (f *fakeAdapter) Name() Name { return f.name }

func (f *fakeAdapter) Detect(ctx context.Context) ([]SessionRef, error) {
	if f.detectErr != nil {
		return nil, f.detectErr
	}
	return f.detect, nil
}

func (f *fakeAdapter) Install(ctx context.Context, opts InstallOptions) error {
	if f.installErr != nil {
		return f.installErr
	}
	f.installed = append(f.installed, opts)
	return nil
}

func (f *fakeAdapter) Uninstall(ctx context.Context) error {
	if f.uninstallErr != nil {
		return f.uninstallErr
	}
	f.uninstalled++
	return nil
}

func (f *fakeAdapter) Normalize(ctx context.Context, src io.Reader) ([]protocol.Event, error) {
	var events []protocol.Event
	if err := json.NewDecoder(src).Decode(&events); err != nil {
		return nil, err
	}
	return events, nil
}

func (f *fakeAdapter) Resume(ctx context.Context, session SessionRef) error {
	if f.resumeErr != nil {
		return f.resumeErr
	}
	f.resumed = append(f.resumed, session)
	return nil
}

func (f *fakeAdapter) StartFromCheckpoint(ctx context.Context, cp protocol.Checkpoint) (SessionRef, error) {
	if f.startCPErr != nil {
		return SessionRef{}, f.startCPErr
	}
	return f.startCPRef, nil
}

func (f *fakeAdapter) Capabilities() Capabilities { return f.caps }

// Compile-time interface compliance.
var _ Adapter = (*fakeAdapter)(nil)

func TestRegistryRegisterLookup(t *testing.T) {
	r := NewRegistry()
	codex := &fakeAdapter{name: NameCodex}
	pi := &fakeAdapter{name: NamePi}
	claude := &fakeAdapter{name: NameClaude}

	r.Register(codex)
	r.Register(pi)
	r.Register(claude)

	got, ok := r.ByName(NameCodex)
	if !ok || got != codex {
		t.Fatalf("ByName(codex) = (%v, %v), want codex adapter", got, ok)
	}
	if _, ok := r.ByName(NameClaude); !ok {
		t.Fatal("ByName(claude) missing")
	}
	if _, ok := r.ByName(NamePi); !ok {
		t.Fatal("ByName(pi) missing")
	}
}

func TestRegistryDuplicateFirstWins(t *testing.T) {
	r := NewRegistry()
	first := &fakeAdapter{name: NameCodex}
	second := &fakeAdapter{name: NameCodex}

	r.Register(first)
	r.Register(second)

	got, ok := r.ByName(NameCodex)
	if !ok || got != first {
		t.Fatalf("duplicate registration replaced adapter: got (%v, %v), want first", got, ok)
	}
	if names := r.Names(); len(names) != 1 {
		t.Fatalf("Names() = %v, want exactly one entry", names)
	}
}

func TestRegistryMissingLookup(t *testing.T) {
	r := NewRegistry()
	if _, ok := r.ByName(NameCodex); ok {
		t.Fatal("empty registry returned an adapter")
	}
	r.Register(&fakeAdapter{name: NamePi})
	if _, ok := r.ByName(NameClaude); ok {
		t.Fatal("lookup of unregistered name succeeded")
	}
}

func TestRegistryNamesSortedDeterministically(t *testing.T) {
	r := NewRegistry()
	for _, n := range []Name{NamePi, NameClaude, NameCodex} {
		r.Register(&fakeAdapter{name: n})
	}
	want := []string{"claude", "codex", "pi"}
	for i := 0; i < 3; i++ {
		got := r.Names()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Names() = %v, want %v", got, want)
		}
	}
}

func TestRegistryNilIgnored(t *testing.T) {
	r := NewRegistry()
	r.Register(nil)
	if names := r.Names(); len(names) != 0 {
		t.Fatalf("Names() = %v after nil Register, want empty", names)
	}
}

func TestFakeAdapterFullRoundTrip(t *testing.T) {
	started := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	ended := started.Add(30 * time.Minute)
	ref := SessionRef{
		Agent:           NameCodex,
		NativeSessionID: "native-123",
		Path:            "/tmp/session.jsonl",
		StartedAt:       started,
		EndedAt:         ended,
		Model:           "gpt-5-codex",
	}

	minimal := protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         "evt_01J00000000000000000000000",
		OccurredAt:      started,
		ObservedAt:      ended,
		NativeSessionID: ref.NativeSessionID,
		Provider:        protocol.ProviderCodex,
		Model:           ref.Model,
		Kind:            protocol.EventCommandCompleted,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         json.RawMessage(`{"exit_code":0}`),
		Unknown: map[string]json.RawMessage{
			"codex_native_kind": json.RawMessage(`"exec.end"`),
		},
	}

	raw, err := json.Marshal([]protocol.Event{minimal})
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}

	fa := &fakeAdapter{name: NameCodex}
	events, err := fa.Normalize(context.Background(), bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("Normalize returned %d events, want 1", len(events))
	}
	if !reflect.DeepEqual(events[0], minimal) {
		t.Fatalf("round-trip mismatch:\n got %+v\nwant %+v", events[0], minimal)
	}
	if events[0].SchemaVersion != protocol.SchemaVersionEvent {
		t.Fatalf("schema version = %q, want %q", events[0].SchemaVersion, protocol.SchemaVersionEvent)
	}
	if _, ok := events[0].Unknown["codex_native_kind"]; !ok {
		t.Fatal("unknown native field was not preserved through round-trip")
	}
}

func TestFakeAdapterEveryMethod(t *testing.T) {
	ctx := context.Background()
	ref := SessionRef{Agent: NamePi, NativeSessionID: "pi-1"}

	fa := &fakeAdapter{
		name: NamePi,
		caps: Capabilities{
			Hooks:                true,
			AppServer:            true,
			ResumeFromCheckpoint: true,
			NativeSessionList:    true,
			NormalizesKinds:      []string{"command.completed", "session.started"},
		},
		detect:     []SessionRef{ref},
		startCPRef: ref,
	}

	if got := fa.Name(); got != NamePi {
		t.Fatalf("Name() = %q, want %q", got, NamePi)
	}
	sessions, err := fa.Detect(ctx)
	if err != nil || len(sessions) != 1 || sessions[0] != ref {
		t.Fatalf("Detect() = (%v, %v), want [%v]", sessions, err, ref)
	}
	opts := InstallOptions{DryRun: true, ConfigDir: "/tmp/cfg", HookCommand: "hfg hook --agent pi"}
	if err := fa.Install(ctx, opts); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if len(fa.installed) != 1 || fa.installed[0] != opts {
		t.Fatalf("Install did not record options: %+v", fa.installed)
	}
	if err := fa.Uninstall(ctx); err != nil || fa.uninstalled != 1 {
		t.Fatalf("Uninstall = (%v, %d), want (nil, 1)", err, fa.uninstalled)
	}
	if err := fa.Resume(ctx, ref); err != nil || len(fa.resumed) != 1 {
		t.Fatalf("Resume = (%v, %d resumed), want (nil, 1)", err, len(fa.resumed))
	}
	cp := protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  "cp_01J00000000000000000000000",
		WorkstreamID:  "ws_01J00000000000000000000000",
		Objective:     "fix checkout race",
		Status:        "draft",
	}
	out, err := fa.StartFromCheckpoint(ctx, cp)
	if err != nil || out != ref {
		t.Fatalf("StartFromCheckpoint = (%v, %v), want %v", out, err, ref)
	}
	caps := fa.Capabilities()
	if !caps.Hooks || !caps.AppServer || !caps.ResumeFromCheckpoint || !caps.NativeSessionList {
		t.Fatalf("Capabilities lost flags: %+v", caps)
	}
	if !sortStringsEqual(caps.NormalizesKinds, []string{"command.completed", "session.started"}) {
		t.Fatalf("NormalizesKinds = %v", caps.NormalizesKinds)
	}
}

func TestSentinelErrorsIdentity(t *testing.T) {
	notDetected := &fakeAdapter{name: NameClaude, detectErr: ErrNotDetected}
	if _, err := notDetected.Detect(context.Background()); !errors.Is(err, ErrNotDetected) {
		t.Fatalf("Detect error = %v, want ErrNotDetected", err)
	}

	hookConflict := &fakeAdapter{name: NameClaude, installErr: ErrHookConflict}
	err := hookConflict.Install(context.Background(), InstallOptions{DryRun: false})
	if !errors.Is(err, ErrHookConflict) {
		t.Fatalf("Install error = %v, want ErrHookConflict", err)
	}

	unsupported := &fakeAdapter{name: NameClaude, resumeErr: ErrUnsupported, startCPErr: ErrUnsupported}
	if err := unsupported.Resume(context.Background(), SessionRef{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Resume error = %v, want ErrUnsupported", err)
	}
	if _, err := unsupported.StartFromCheckpoint(context.Background(), protocol.Checkpoint{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("StartFromCheckpoint error = %v, want ErrUnsupported", err)
	}

	wrapped := &fakeAdapter{name: NameClaude, detectErr: io.ErrUnexpectedEOF}
	if _, err := wrapped.Detect(context.Background()); errors.Is(err, ErrNotDetected) {
		t.Fatal("unrelated error matched ErrNotDetected")
	}

	for _, msg := range []struct {
		err  error
		want string
	}{
		{ErrNotDetected, "no native sessions detected"},
		{ErrUnsupported, "not supported by this adapter version"},
		{ErrHookConflict, "overwrite existing user hook configuration"},
	} {
		if !strings.Contains(msg.err.Error(), msg.want) {
			t.Errorf("%v message %q does not contain %q", msg.err, msg.err.Error(), msg.want)
		}
	}
}

func sortStringsEqual(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
