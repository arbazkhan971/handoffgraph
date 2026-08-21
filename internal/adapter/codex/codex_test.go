package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func normalizeFixture(t *testing.T, path string) []protocol.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	evs, err := (&Codex{}).Normalize(context.Background(), f)
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	return evs
}

func TestNormalizeFixtureFile(t *testing.T) {
	path := filepath.Join("..", "..", "..", "testdata", "fixtures", "codex_session.jsonl")
	evs := normalizeFixture(t, path)

	wantKinds := []protocol.EventKind{
		protocol.EventSessionStarted,
		protocol.EventPromptSubmitted,
		protocol.EventToolStarted,
		protocol.EventToolCompleted,
		protocol.EventAssistantCompleted,
		protocol.EventLogObserved, // turn_context has no dedicated kind yet
	}
	if len(evs) != len(wantKinds) {
		t.Fatalf("len(evs) = %d, want %d", len(evs), len(wantKinds))
	}
	for i, ev := range evs {
		if ev.Kind != wantKinds[i] {
			t.Errorf("ev[%d].Kind = %q, want %q", i, ev.Kind, wantKinds[i])
		}
		if ev.Provider != protocol.ProviderCodex {
			t.Errorf("ev[%d].Provider = %q", i, ev.Provider)
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			t.Errorf("ev[%d].Provenance = %q, want OBSERVED", i, ev.Provenance)
		}
		if ev.SchemaVersion != protocol.SchemaVersionEvent {
			t.Errorf("ev[%d].SchemaVersion = %q", i, ev.SchemaVersion)
		}
		if ev.Sequence != int64(i+1) {
			t.Errorf("ev[%d].Sequence = %d, want %d", i, ev.Sequence, i+1)
		}
		if ev.ContentHash == "" {
			t.Errorf("ev[%d].ContentHash empty", i)
		}
	}

	first := evs[0]
	if first.NativeSessionID != "0f9c7a2e-1111-4222-8333-444455556666" {
		t.Errorf("NativeSessionID = %q", first.NativeSessionID)
	}
	var p0 struct {
		NativeSessionID string `json:"native_session_id"`
		SourceKind      string `json:"source_kind"`
	}
	if err := json.Unmarshal(first.Payload, &p0); err != nil {
		t.Fatal(err)
	}
	if p0.SourceKind != "session_meta" || p0.NativeSessionID != first.NativeSessionID {
		t.Errorf("payload source_kind/native_session_id = %q/%q", p0.SourceKind, p0.NativeSessionID)
	}

	// The unknown top-level field on the last line must survive.
	last := evs[len(evs)-1]
	if _, ok := last.Unknown["hfg_future_field"]; !ok {
		t.Error("unknown top-level native field was not preserved")
	}
	data, err := last.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("hfg_future_field")) {
		t.Error("unknown field lost in canonical JSON round-trip")
	}
}

func TestNormalizeDeterministic(t *testing.T) {
	path := filepath.Join("..", "..", "..", "testdata", "fixtures", "codex_session.jsonl")
	a := normalizeFixture(t, path)
	b := normalizeFixture(t, path)

	// EventIDs are deterministic per run: deriveEventID derives them from
	// (native session id, sequence, timestamp, content hash), so re-importing
	// the same rollout yields identical IDs. Assert that explicitly, then
	// compare the full events (EventIDs included) byte-for-byte.
	for i := range a {
		if a[i].EventID == "" {
			t.Errorf("ev[%d].EventID empty", i)
			continue
		}
		if a[i].EventID != b[i].EventID {
			t.Errorf("ev[%d].EventID differs across runs: %q vs %q", i, a[i].EventID, b[i].EventID)
		}
	}

	ja, err := content.CanonicalJSON(a)
	if err != nil {
		t.Fatal(err)
	}
	jb, err := content.CanonicalJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ja, jb) {
		t.Error("Normalize is not a pure function of its input (modulo minted IDs)")
	}
}

func TestNormalizeMalformedLineReportsLineNumber(t *testing.T) {
	in := strings.Join([]string{
		`{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"id":"x"}}`,
		`{"type": broken`,
	}, "\n")
	_, err := (&Codex{}).Normalize(context.Background(), strings.NewReader(in))
	if err == nil {
		t.Fatal("expected error for malformed line")
	}
	if !strings.Contains(err.Error(), "line 2") {
		t.Errorf("error = %v, want it to mention line 2", err)
	}
}

func TestNormalizeRejectsInvalidUTF8(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteString(`{"timestamp":"2026-08-21T15:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"ok"}}` + "\n")
	buf.WriteString(`{"type":"log","payload":{"note":"bad `)
	buf.WriteByte(0xFF)
	buf.WriteString("\"}}\n")

	evs, err := (&Codex{}).Normalize(context.Background(), &buf)
	if err == nil {
		t.Fatal("expected invalid UTF-8 error")
	}
	if !strings.Contains(err.Error(), "invalid UTF-8") {
		t.Errorf("error = %v, want invalid UTF-8 mention", err)
	}
	if evs != nil {
		t.Errorf("events = %v, want nil on hard failure", evs)
	}
}

func TestNormalizeEmptyInput(t *testing.T) {
	evs, err := (&Codex{}).Normalize(context.Background(), strings.NewReader("\n\n"))
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if len(evs) != 0 {
		t.Fatalf("len(evs) = %d, want 0", len(evs))
	}
}

func writeRollout(t *testing.T, dir, name, metaID string, startedAt string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	line := `{"timestamp":"` + startedAt + `","type":"session_meta","payload":{"id":"` + metaID + `","timestamp":"` + startedAt + `"}}`
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDetectNewestFirstAndDeterministic(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "2026", "08", "21")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	writeRollout(t, nested, "rollout-old.jsonl", "id-old", "2026-08-21T10:00:00Z")
	writeRollout(t, nested, "rollout-new.jsonl", "id-new", "2026-08-21T16:00:00Z")
	writeRollout(t, root, "stray.jsonl", "id-stray", "2026-08-21T12:00:00Z")
	if err := os.WriteFile(filepath.Join(root, "not-a-session.txt"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}

	c := &Codex{SessionsDir: root}
	refs, err := c.Detect(context.Background())
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if len(refs) != 3 {
		t.Fatalf("len(refs) = %d, want 3", len(refs))
	}
	wantOrder := []string{"id-new", "id-stray", "id-old"}
	for i, w := range wantOrder {
		if refs[i].NativeSessionID != w {
			t.Errorf("refs[%d] = %q, want %q (newest first)", i, refs[i].NativeSessionID, w)
		}
		if refs[i].Agent != adapter.NameCodex {
			t.Errorf("refs[%d].Agent = %q", i, refs[i].Agent)
		}
	}

	again, err := c.Detect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for i := range refs {
		if refs[i] != again[i] {
			t.Errorf("Detect not deterministic at %d", i)
		}
	}
}

func TestDetectMissingDirWrapsErrNotDetected(t *testing.T) {
	c := &Codex{SessionsDir: filepath.Join(t.TempDir(), "missing")}
	_, err := c.Detect(context.Background())
	if !errors.Is(err, adapter.ErrNotDetected) {
		t.Fatalf("err = %v, want ErrNotDetected", err)
	}
}

func TestCapabilitiesKindsSorted(t *testing.T) {
	kinds := (&Codex{}).Capabilities().NormalizesKinds
	if !sort.StringsAreSorted(kinds) {
		t.Errorf("NormalizesKinds not sorted: %v", kinds)
	}
	if len(kinds) == 0 {
		t.Error("NormalizesKinds must be non-empty")
	}
}

func TestDeferredOperationsWrapSentinel(t *testing.T) {
	// Install and Uninstall are implemented (see hooks.go and its tests) and
	// must NOT be asserted here: a zero-value Codex resolves ConfigDir to the
	// real ~/.codex. Only the deferred v0.2.x operations stay sentinel-only.
	c := &Codex{}
	ctx := context.Background()
	if err := c.Resume(ctx, adapter.SessionRef{}); !errors.Is(err, adapter.ErrUnsupported) {
		t.Errorf("Resume err = %v", err)
	}
	if _, err := c.StartFromCheckpoint(ctx, protocol.Checkpoint{}); !errors.Is(err, adapter.ErrUnsupported) {
		t.Errorf("StartFromCheckpoint err = %v", err)
	}
}

func TestDefaultRegistryHasCodex(t *testing.T) {
	r := DefaultRegistry()
	got, ok := r.ByName(adapter.NameCodex)
	if !ok {
		t.Fatal("codex not registered in default registry")
	}
	if got.Name() != adapter.NameCodex {
		t.Errorf("Name() = %q", got.Name())
	}
	names := r.Names()
	if !sort.StringsAreSorted(names) || len(names) != 1 {
		t.Errorf("Names() = %v", names)
	}
}
