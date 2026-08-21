package verify

import (
	"bufio"
	"bytes"
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
// testdata/fixtures passes the full harness: clean ingestion plus a
// deterministic graph root hash.
func TestVerifyRepoGoldenFixtures(t *testing.T) {
	res, err := Verify(context.Background(), repoFixturesDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("golden fixtures failed verification: %v", res.Failures)
	}
	// claude.jsonl + the six golden expansions + codex_session.jsonl +
	// codex_session_2.jsonl (native codex rollout, swept like its sibling) +
	// codex_hook_events.jsonl (canonical codex hook events). The invalid/
	// subtree must never be picked up here (top-level glob wins over the
	// recursive walk).
	const wantFiles = 10
	if res.FilesChecked != wantFiles {
		t.Errorf("FilesChecked = %d, want %d", res.FilesChecked, wantFiles)
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

// importAll appends every JSONL line of path to db in file order.
func importAll(t *testing.T, db *storage.DB, path string) int {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	ctx := context.Background()
	var n int
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			t.Fatalf("fixture line %d: %v", n+1, err)
		}
		if _, err := db.AppendEvent(ctx, &ev); err != nil {
			t.Fatalf("append: %v", err)
		}
		n++
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return n
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
	for _, line := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			out = append(out, line)
		}
	}
	return out
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

// codexHookEventsPath resolves the canonical codex hook events fixture
// (hfg.event.v1 lines, importable like claude.jsonl).
func codexHookEventsPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(repoFixturesDir(t), "codex_hook_events.jsonl")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("codex_hook_events.jsonl not present yet: %v", err)
	}
	return path
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
	src := codexHookEventsPath(t)
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
	src := codexHookEventsPath(t)
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
