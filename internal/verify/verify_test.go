package verify

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

func TestGenerateSyntheticDeterministicCount(t *testing.T) {
	events := fixture.GenerateSynthetic(100)
	// 3 (workstream/session/trace) + 1 (agent span) + 2*100 (span start+command)
	// + 1 (failing test) = 205.
	if len(events) != 205 {
		t.Fatalf("len = %d, want 205", len(events))
	}
}

func TestVerifyFixtureDir(t *testing.T) {
	dir := t.TempDir()
	events := fixture.GenerateSynthetic(20)

	var out []byte
	for _, ev := range events {
		b, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b...)
		out = append(out, '\n')
	}
	if err := os.WriteFile(filepath.Join(dir, "synthetic.jsonl"), out, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("failures: %v", res.Failures)
	}
	if res.Events == 0 {
		t.Fatal("expected events")
	}
}

func TestVerifyFixtureDirWithCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "corrupt.jsonl"), []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) == 0 {
		t.Fatal("expected failures for corrupt file")
	}
}

// TestClassifyJSONL pins the format-classification contract: canonical
// hfg.event.v1 envelopes vs native codex rollout records vs anything else
// (which must never be silently imported).
func TestClassifyJSONL(t *testing.T) {
	canonical := `{"schema_version":"hfg.event.v1","event_id":"evt_01J2F7A0000000000000000001","occurred_at":"2026-08-21T12:00:00Z","kind":"workstream.started","provenance":"OBSERVED"}`
	native := `{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"id":"0f9c7a2e","originator":"codex-cli"}}`

	tests := []struct {
		name  string
		lines []string
		want  string
	}{
		{"canonical fixture line", []string{canonical}, FormatCanonical},
		{"native codex fixture line", []string{native}, FormatNativeCodex},
		{"garbage is unknown", []string{"{not valid json"}, FormatUnknown},
		{"empty input is unknown", nil, FormatUnknown},
		{"blank-only input is unknown", []string{"", "   ", ""}, FormatUnknown},
		{"blank lines skipped before canonical", []string{"", canonical}, FormatCanonical},
		{
			"type without payload is unknown",
			[]string{`{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta"}`},
			FormatUnknown,
		},
		{
			"schema_version with non-evt id is unknown",
			[]string{`{"schema_version":"hfg.event.v1","event_id":"abc123","kind":"log.observed"}`},
			FormatUnknown,
		},
		{
			"native shape carrying schema_version is unknown",
			[]string{`{"schema_version":"hfg.event.v2","type":"session_meta","payload":{"id":"x"}}`},
			FormatUnknown,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyJSONL(tt.lines); got != tt.want {
				t.Errorf("classifyJSONL() = %q, want %q", got, tt.want)
			}
		})
	}
}

// repoFixturesDir resolves testdata/fixtures relative to this package.
func repoFixturesDir(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("testdata/fixtures missing: %v", err)
	}
	return abs
}

// TestVerifyRepoGoldenFixtures verifies every top-level golden fixture in
// testdata/fixtures passes the harness under the right regime: canonical
// hfg.event.v1 fixtures through the event store plus a deterministic graph
// root hash, and the two NATIVE codex rollouts (codex_session.jsonl,
// codex_session_2.jsonl) through the codex adapter's Normalize instead —
// never imported as degenerate zero-value events.
func TestVerifyRepoGoldenFixtures(t *testing.T) {
	res, err := Verify(context.Background(), repoFixturesDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("golden fixtures failed verification: %v", res.Failures)
	}
	// claude.jsonl + the six golden expansions + codex_session.jsonl +
	// codex_session_2.jsonl (native codex rollouts, verified NATIVE through
	// the adapter) + codex_hook_events.jsonl (canonical codex hook events).
	// The invalid/ subtree must never be picked up here (top-level glob wins
	// over the recursive walk).
	const wantFiles = 10
	if res.FilesChecked != wantFiles {
		t.Errorf("FilesChecked = %d, want %d", res.FilesChecked, wantFiles)
	}
	// The two native rollouts must be genuinely verified through the adapter,
	// not silently imported or skipped.
	wantNative := map[string]bool{
		"codex_session.jsonl":   false,
		"codex_session_2.jsonl": false,
	}
	for _, name := range res.NativeVerified {
		if _, ok := wantNative[name]; !ok {
			t.Errorf("unexpected native-verified file %q (canonical fixtures must go through the event store)", name)
			continue
		}
		wantNative[name] = true
	}
	for name, ok := range wantNative {
		if !ok {
			t.Errorf("native rollout %s was not native-verified (got %v)", name, res.NativeVerified)
		}
	}
	if res.Events == 0 {
		t.Error("expected events from golden fixtures")
	}
}

// TestTruncatedFixtureRejected proves a final line cut mid-JSON surfaces as
// a verification failure instead of being silently imported.
func TestTruncatedFixtureRejected(t *testing.T) {
	dir := filepath.Join(repoFixturesDir(t), "invalid", "truncated")
	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) == 0 {
		t.Fatal("expected failure for truncated.jsonl")
	}
	if res.Events != 2 {
		t.Errorf("Events = %d, want 2 (only the complete lines)", res.Events)
	}
}

// TestInvalidUTF8FixtureRejected proves a line containing a raw invalid
// UTF-8 byte (0xFF) fails verification rather than crashing or importing.
func TestInvalidUTF8FixtureRejected(t *testing.T) {
	dir := filepath.Join(repoFixturesDir(t), "invalid", "utf8")
	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) == 0 {
		t.Fatal("expected failure for invalid_utf8.jsonl")
	}
	if res.Events != 1 {
		t.Errorf("Events = %d, want 1 (only the valid line)", res.Events)
	}
}

// TestUnknownFormatRejected proves a parseable JSON file that is neither a
// canonical hfg.event.v1 envelope nor a recognizable native rollout fails
// verification instead of decoding into degenerate zero-value events.
func TestUnknownFormatRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "alien.jsonl"), []byte("{\"foo\":1,\"bar\":[2,3]}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) == 0 {
		t.Fatal("expected failure for unrecognized-format file")
	}
	if res.Events != 0 {
		t.Errorf("Events = %d, want 0 (nothing may be imported)", res.Events)
	}
}

// TestNativeCodexRolloutVerifiedNatively isolates one native rollout fixture
// and proves Verify routes it through the codex adapter: clean result, the
// file reported in NativeVerified, and zero events imported into the store.
func TestNativeCodexRolloutVerifiedNatively(t *testing.T) {
	src := filepath.Join(repoFixturesDir(t), "codex_session.jsonl")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex_session.jsonl"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("native rollout failed native verification: %v", res.Failures)
	}
	if len(res.NativeVerified) != 1 || res.NativeVerified[0] != "codex_session.jsonl" {
		t.Errorf("NativeVerified = %v, want [codex_session.jsonl]", res.NativeVerified)
	}
	if res.Events != 1 {
		t.Errorf("Events = %d, want 1 (the verified transcript itself, not imported lines)", res.Events)
	}
}

// failingNormalize is a scripted NormalizeFn for exercising the native
// verification checks without depending on adapter internals.
type scriptedNormalizer struct {
	eventsA []protocol.Event // returned on every odd pass
	eventsB []protocol.Event // returned on every even pass
	calls   int
}

func (s *scriptedNormalizer) normalize(ctx context.Context, _ ioReader) ([]protocol.Event, error) {
	s.calls++
	if s.calls%2 == 1 {
		return s.eventsA, nil
	}
	return s.eventsB, nil
}

// ioReader aliases io.Reader so the table below stays readable; the injected
// normalizer ignores the stream anyway.
type ioReader = interface {
	Read(p []byte) (int, error)
}

// TestNativeVerificationChecksEnforced proves the native path actually
// enforces its contract: a normalizer emitting the wrong provider, upgraded
// provenance, or unstable identities must fail verification.
func TestNativeVerificationChecksEnforced(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	nativeLine := `{"timestamp":"2026-08-21T15:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"hi"}}`
	if err := os.WriteFile(path, []byte(nativeLine+"\n"+nativeLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	mkEv := func(provider string, prov protocol.Provenance, payload string) protocol.Event {
		return protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       "evt_01J2F9C00000000000000000XY",
			Provider:      provider,
			Kind:          protocol.EventPromptSubmitted,
			Provenance:    prov,
			Payload:       json.RawMessage(payload),
		}
	}

	tests := []struct {
		name string
		a, b []protocol.Event
	}{
		{
			name: "wrong provider rejected",
			a:    []protocol.Event{mkEv("claude", protocol.ProvenanceObserved, `{"k":1}`)},
			b:    []protocol.Event{mkEv("claude", protocol.ProvenanceObserved, `{"k":1}`)},
		},
		{
			name: "upgraded provenance rejected",
			a:    []protocol.Event{mkEv("codex", protocol.ProvenanceInferred, `{"k":1}`)},
			b:    []protocol.Event{mkEv("codex", protocol.ProvenanceInferred, `{"k":1}`)},
		},
		{
			name: "unstable identity rejected",
			a:    []protocol.Event{mkEv("codex", protocol.ProvenanceObserved, `{"k":1}`)},
			b:    []protocol.Event{mkEv("codex", protocol.ProvenanceObserved, `{"k":2}`)},
		},
		{
			name: "pass count drift rejected",
			a:    []protocol.Event{mkEv("codex", protocol.ProvenanceObserved, `{"k":1}`), mkEv("codex", protocol.ProvenanceObserved, `{"k":2}`)},
			b:    []protocol.Event{mkEv("codex", protocol.ProvenanceObserved, `{"k":1}`)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scripted := &scriptedNormalizer{eventsA: tt.a, eventsB: tt.b}
			res, err := Verify(context.Background(), dir, &VerifyOptions{
				NormalizeNative: scripted.normalize,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Failures) == 0 {
				t.Fatalf("expected verification failure for scenario %q", tt.name)
			}
			if len(res.NativeVerified) != 0 {
				t.Errorf("NativeVerified = %v, want empty on failure", res.NativeVerified)
			}
		})
	}
}

// rootHash opens a fresh temp DB, imports path in the given line order,
// and returns the graph root hash of the stored events.
func rootHashForLineOrder(t *testing.T, path string, reverse bool) string {
	t.Helper()
	tmp := t.TempDir()
	db, err := storage.Open(filepath.Join(tmp, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	lines := readNonEmptyLines(t, path)
	if reverse {
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	ctx := context.Background()
	for i, line := range lines {
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			t.Fatalf("line %d: %v", i+1, err)
		}
		if _, err := db.AppendEvent(ctx, &ev); err != nil {
			t.Fatalf("append line %d: %v", i+1, err)
		}
	}
	events, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	h, err := graph.RootHashForEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func readNonEmptyLines(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for _, line := range splitLines(data) {
		if len(line) > 0 {
			out = append(out, line)
		}
	}
	return out
}

// splitLines splits data on '\n' keeping only non-empty trimmed segments;
// the trailing artifact after a final newline is dropped naturally.
func splitLines(data []byte) [][]byte {
	var out [][]byte
	start := 0
	for i := 0; i <= len(data); i++ {
		if i == len(data) || data[i] == '\n' {
			seg := trimSpace(data[start:i])
			if len(seg) > 0 {
				out = append(out, seg)
			}
			start = i + 1
		}
	}
	return out
}

func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\t' || b[0] == '\r') {
		b = b[1:]
	}
	for len(b) > 0 && (b[len(b)-1] == ' ' || b[len(b)-1] == '\t' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// TestOutOfOrderFixtureOrderIndependent proves the out_of_order golden
// fixture reduces to an identical graph root hash regardless of delivery
// order (forward vs reversed file order).
func TestOutOfOrderFixtureOrderIndependent(t *testing.T) {
	path := filepath.Join(repoFixturesDir(t), "out_of_order.jsonl")
	fwd := rootHashForLineOrder(t, path, false)
	rev := rootHashForLineOrder(t, path, true)
	if fwd != rev {
		t.Fatalf("root hash depends on delivery order: fwd=%s rev=%s", fwd, rev)
	}
}

// TestOrphanSpansFixtureStable proves dangling parent references reduce
// deterministically instead of panicking or flapping.
func TestOrphanSpansFixtureStable(t *testing.T) {
	path := filepath.Join(repoFixturesDir(t), "orphan_spans.jsonl")
	h1 := rootHashForLineOrder(t, path, false)
	h2 := rootHashForLineOrder(t, path, true)
	if h1 == "" || h1 != h2 {
		t.Fatalf("orphan spans root hash unstable: %s vs %s", h1, h2)
	}
}

// importFixtureInto opens a fresh temp DB, imports path in file order, and
// returns the stored events plus the number of non-empty JSONL lines.
func importFixtureInto(t *testing.T, path string) ([]*protocol.Event, int) {
	t.Helper()
	tmp := t.TempDir()
	db, err := storage.Open(filepath.Join(tmp, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	ctx := context.Background()
	lines := readNonEmptyLines(t, path)
	for i, line := range lines {
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			t.Fatalf("line %d: %v", i+1, err)
		}
		if _, err := db.AppendEvent(ctx, &ev); err != nil {
			t.Fatalf("append line %d: %v", i+1, err)
		}
	}
	events, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return events, len(lines)
}

// TestCodexHookEventsVerifyCleanly runs the full harness over the canonical
// codex hook events fixture: clean ingestion, a deterministic graph root hash
// across two reduces, materialized traces that validate, and an event count
// matching the fixture's non-empty line count.
func TestCodexHookEventsVerifyCleanly(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(repoFixturesDir(t), "codex_hook_events.jsonl")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "codex_hook_events.jsonl"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("codex hook events failed verification: %v", res.Failures)
	}
	if len(res.NativeVerified) != 0 {
		t.Errorf("canonical fixture misclassified as native: %v", res.NativeVerified)
	}

	events, wantLines := importFixtureInto(t, src)
	if len(events) == 0 {
		t.Fatal("expected imported events from codex_hook_events.jsonl")
	}
	if len(events) != wantLines {
		t.Errorf("stored %d events for %d non-empty fixture lines (idempotency or parse loss?)",
			len(events), wantLines)
	}

	h1, err := graph.RootHashForEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	h2, err := graph.RootHashForEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	if h1 == "" || h1 != h2 {
		t.Fatalf("codex hook events root hash unstable: %s vs %s", h1, h2)
	}

	mr := trace.Materialize(events)
	if err := mr.Validate(); err != nil {
		t.Errorf("materialized read models invalid: %v", err)
	}
	// The fixture carries command.completed evidence, which the materializer
	// promotes to a COMMAND span even without an explicit trace.started (the
	// fixture has none, so zero traces is the correct derivation).
	if len(mr.Spans) == 0 {
		t.Error("expected ≥1 materialized span from codex hook events")
	}
}

// TestCodexHookEventsSessionGroup asserts the codex hook events produce at
// least one session group in the reduced graph whose backing events carry
// provider "codex".
func TestCodexHookEventsSessionGroup(t *testing.T) {
	src := filepath.Join(repoFixturesDir(t), "codex_hook_events.jsonl")
	events, _ := importFixtureInto(t, src)

	g := graph.Reduce(events)
	sessionNodes := map[string]bool{}
	for _, n := range g.Nodes {
		if n.Kind == graph.NodeSession {
			sessionNodes[n.ID] = true
		}
	}
	if len(sessionNodes) < 1 {
		t.Fatalf("expected ≥1 session group in reduced graph, got nodes: %+v", g.Nodes)
	}

	bySession := map[string][]*protocol.Event{}
	for _, ev := range events {
		if ev.SessionID != "" {
			bySession[ev.SessionID] = append(bySession[ev.SessionID], ev)
		}
	}
	codexGroup := false
	for id := range sessionNodes {
		for _, ev := range bySession[id] {
			if ev.Provider == "codex" {
				codexGroup = true
			}
		}
	}
	if !codexGroup {
		t.Error(`expected ≥1 session group whose events have provider "codex"`)
	}
}
