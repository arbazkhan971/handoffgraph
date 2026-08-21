package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/detection"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the detect command through the public
// cli.App surface, seeded like the sessions tests: events are appended into
// the same database the command opens under an isolated HFG_DATA_DIR.

// newDetectApp returns an app with the core commands plus the detection
// pack registered the same way cmd/handoffgraph/main.go wires it.
func newDetectApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	Register(app)
	RegisterDetectionCmd(app)
	return app
}

func detPayload(t *testing.T, m map[string]any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return b
}

func appendDetEvent(t *testing.T, db *storage.DB, kind protocol.EventKind, at time.Time, seq int64, payload map[string]any) {
	t.Helper()
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		Sequence:      seq,
		OccurredAt:    at,
		ObservedAt:    at,
		WorkstreamID:  "ws_det",
		SessionID:     "ses_det",
		Provider:      protocol.ProviderCodex,
		Kind:          kind,
		Provenance:    protocol.ProvenanceObserved,
	}
	if payload != nil {
		ev.Payload = detPayload(t, payload)
	}
	if _, err := db.AppendEvent(context.Background(), ev); err != nil {
		t.Fatalf("AppendEvent(%s @%s): %v", kind, at, err)
	}
}

// seedDetectEvents seeds two traces in one workstream:
//
//	trc_a: two FILE_WRITE spans on src/app.go, a failing command
//	       (exit 2), a failed test, and a trace.completed claim.
//	trc_b: a passing command (exit 0) and a trace.completed claim.
func seedDetectEvents(t *testing.T) {
	t.Helper()
	seedEvents(t, func(db *storage.DB) {
		base := time.Date(2026, 8, 22, 11, 0, 0, 0, time.UTC)
		step := func(i int64) time.Time { return base.Add(time.Duration(i) * time.Second) }

		// trc_a
		appendDetEvent(t, db, protocol.EventTraceStarted, step(0), 0, map[string]any{"trace_id": "trc_a"})
		appendDetEvent(t, db, protocol.EventSpanStarted, step(1), 1, map[string]any{
			"span_id": "spn_w1", "trace_id": "trc_a", "kind": "FILE_WRITE", "name": "src/app.go"})
		appendDetEvent(t, db, protocol.EventSpanStarted, step(2), 2, map[string]any{
			"span_id": "spn_w2", "trace_id": "trc_a", "kind": "FILE_WRITE", "name": "src/app.go"})
		appendDetEvent(t, db, protocol.EventSpanStarted, step(3), 3, map[string]any{
			"span_id": "spn_c1", "trace_id": "trc_a", "kind": "COMMAND", "name": "make check"})
		appendDetEvent(t, db, protocol.EventCommandCompleted, step(4), 4, map[string]any{
			"span_id": "spn_c1", "trace_id": "trc_a", "command": "make check", "exit_code": 2})
		appendDetEvent(t, db, protocol.EventTestCompleted, step(5), 5, map[string]any{
			"span_id": "spn_t1", "trace_id": "trc_a", "name": "TestFoo", "result": "failed", "exit_code": 1})
		appendDetEvent(t, db, protocol.EventTraceCompleted, step(6), 6, map[string]any{"trace_id": "trc_a"})

		// trc_b
		appendDetEvent(t, db, protocol.EventTraceStarted, step(10), 10, map[string]any{"trace_id": "trc_b"})
		appendDetEvent(t, db, protocol.EventSpanStarted, step(11), 11, map[string]any{
			"span_id": "spn_c2", "trace_id": "trc_b", "kind": "COMMAND", "name": "go build ./..."})
		appendDetEvent(t, db, protocol.EventCommandCompleted, step(12), 12, map[string]any{
			"span_id": "spn_c2", "trace_id": "trc_b", "command": "go build ./...", "exit_code": 0})
		appendDetEvent(t, db, protocol.EventTraceCompleted, step(13), 13, map[string]any{"trace_id": "trc_b"})
	})
}

type matchOut struct {
	RuleID        string   `json:"rule_id"`
	RuleVersion   string   `json:"rule_version"`
	Scope         string   `json:"scope"`
	ScopeID       string   `json:"scope_id"`
	GroupKey      string   `json:"group_key"`
	Severity      string   `json:"severity"`
	SpanIDs       []string `json:"span_ids"`
	TraceIDs      []string `json:"trace_ids"`
	MatchCount    int      `json:"match_count"`
	EvidenceLevel string   `json:"evidence_level"`
}

func runDetectJSON(t *testing.T, app *cli.App, args ...string) []matchOut {
	t.Helper()
	out, _, err := runRegisteredApp(app, "detect", append(args, "--json")...)
	if err != nil {
		t.Fatalf("detect %v: %v\n%s", args, err, out)
	}
	var ms []matchOut
	if err := json.Unmarshal([]byte(out), &ms); err != nil {
		t.Fatalf("detect output is not a JSON array: %v\n%s", err, out)
	}
	return ms
}

func matchesByRule(ms []matchOut) map[string][]matchOut {
	by := map[string][]matchOut{}
	for _, m := range ms {
		by[m.RuleID] = append(by[m.RuleID], m)
	}
	return by
}

func TestDetectJSONFiresLaunchRules(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	ms := runDetectJSON(t, app)
	if len(ms) == 0 {
		t.Fatal("expected at least one detection")
	}
	by := matchesByRule(ms)

	checks := []struct {
		rule     string
		scopeID  string
		groupKey string
	}{
		{rule: "nonzero-command-exit", scopeID: "trc_a", groupKey: "spn_c1"},
		{rule: "failed-test", scopeID: "trc_a", groupKey: "spn_t1"},
		{rule: "concurrent-file-touch", scopeID: "trc_a", groupKey: "src/app.go"},
		{rule: "completion-claim-without-verification", scopeID: "trc_a", groupKey: "trc_a"},
	}
	for _, c := range checks {
		got, ok := by[c.rule]
		if !ok {
			t.Errorf("rule %q did not fire; got %+v", c.rule, ms)
			continue
		}
		found := false
		for _, m := range got {
			if m.ScopeID == c.scopeID && m.GroupKey == c.groupKey {
				found = true
				if m.EvidenceLevel != "OBSERVED" {
					t.Errorf("%s evidence_level = %q, want OBSERVED", c.rule, m.EvidenceLevel)
				}
				if m.RuleVersion != "1.0.0" {
					t.Errorf("%s rule_version = %q, want 1.0.0", c.rule, m.RuleVersion)
				}
			}
		}
		if !found {
			t.Errorf("rule %q fired without expected match %s/%s: %+v", c.rule, c.scopeID, c.groupKey, got)
		}
	}

	// The clean trace must not produce a nonzero-command-exit match.
	for _, m := range by["nonzero-command-exit"] {
		if m.ScopeID == "trc_b" {
			t.Errorf("nonzero-command-exit fired on trc_b: %+v", m)
		}
	}
}

func TestDetectTextOutputAndIdempotentReRun(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	out, _, err := runRegisteredApp(app, "detect")
	if err != nil {
		t.Fatalf("detect: %v\n%s", err, out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected match lines plus summary, got %q", out)
	}
	// Rows are sorted by rule id; the summary line carries the count.
	found := false
	for _, ln := range lines[:len(lines)-1] {
		if strings.Count(ln, "\t") != 6 {
			t.Errorf("row %q must have 7 tab-separated fields", ln)
		}
		if strings.Contains(ln, "nonzero-command-exit") {
			found = true
		}
	}
	if !found {
		t.Errorf("no nonzero-command-exit row in output:\n%s", out)
	}
	wantSummary := fmt.Sprintf("%d detection(s), %d newly persisted", len(lines)-1, len(lines)-1)
	if lines[len(lines)-1] != wantSummary {
		t.Errorf("summary = %q, want %q", lines[len(lines)-1], wantSummary)
	}

	// Re-running the same pack over the same events persists nothing new.
	out2, _, err := runRegisteredApp(app, "detect")
	if err != nil {
		t.Fatalf("second detect: %v\n%s", err, out2)
	}
	summary2 := lastLine(out2)
	want2 := fmt.Sprintf("%d detection(s), 0 newly persisted", len(lines)-1)
	if summary2 != want2 {
		t.Errorf("second-run summary = %q, want %q", summary2, want2)
	}
}

func lastLine(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	return lines[len(lines)-1]
}

func TestDetectTraceFilter(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	ms := runDetectJSON(t, app, "--trace", "trc_b")
	by := matchesByRule(ms)
	if len(by["nonzero-command-exit"]) != 0 {
		t.Errorf("nonzero-command-exit fired on clean trc_b: %+v", by["nonzero-command-exit"])
	}
	if len(by["concurrent-file-touch"]) != 0 {
		t.Errorf("concurrent-file-touch fired on trc_b: %+v", by["concurrent-file-touch"])
	}

	ms = runDetectJSON(t, app, "--trace", "trc_a")
	by = matchesByRule(ms)
	if len(by["nonzero-command-exit"]) != 1 {
		t.Errorf("nonzero-command-exit on trc_a = %+v, want exactly one", by["nonzero-command-exit"])
	}
	if len(by["concurrent-file-touch"]) != 1 {
		t.Errorf("concurrent-file-touch on trc_a = %+v, want exactly one", by["concurrent-file-touch"])
	}
}

func TestDetectWorkstreamFilter(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	ms := runDetectJSON(t, app, "--workstream", "ws_det")
	if len(ms) == 0 {
		t.Fatal("expected detections for ws_det")
	}
	seenTraces := map[string]bool{}
	for _, m := range ms {
		if m.RuleID == "concurrent-file-touch" {
			seenTraces[m.ScopeID] = true
		}
	}
	if !seenTraces["trc_a"] {
		t.Errorf("workstream filter missed trc_a: %+v", ms)
	}

	_, _, err := runRegisteredApp(app, "detect", "--workstream", "ws_missing")
	if err == nil || !strings.Contains(err.Error(), "has no materialized traces") {
		t.Fatalf("unknown workstream error = %v, want 'has no materialized traces'", err)
	}
}

func TestDetectUnknownTrace(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	_, _, err := runRegisteredApp(app, "detect", "--trace", "trc_missing")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unknown trace error = %v, want 'not found'", err)
	}
}

func TestDetectMutuallyExclusiveFlags(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)

	_, _, err := runRegisteredApp(app, "detect", "--trace", "trc_a", "--workstream", "ws_det")
	if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("error = %v, want 'mutually exclusive'", err)
	}
}

func TestDetectEmptyDB(t *testing.T) {
	isolateDataDir(t)
	app := newDetectApp(t)

	out, _, err := runRegisteredApp(app, "detect")
	if err != nil {
		t.Fatalf("detect on empty db: %v", err)
	}
	if want := "0 detection(s), 0 newly persisted"; out != want+"\n" {
		t.Errorf("stdout = %q, want %q", out, want)
	}

	ms := runDetectJSON(t, app)
	if ms == nil || len(ms) != 0 {
		t.Errorf("json output = %#v, want empty array", ms)
	}
}

func TestDetectPersistsMatches(t *testing.T) {
	seedDetectEvents(t)
	app := newDetectApp(t)
	if _, _, err := runRegisteredApp(app, "detect"); err != nil {
		t.Fatalf("detect: %v", err)
	}

	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	ctx := context.Background()
	store, err := detection.OpenStoreFile(ctx, cfg.DBPath)
	if err != nil {
		t.Fatalf("OpenStoreFile: %v", err)
	}
	defer store.Close()

	stored, err := store.ListMatches(ctx, detection.MatchFilter{})
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(stored) == 0 {
		t.Fatal("no matches persisted")
	}
	seen := map[string]bool{}
	for _, m := range stored {
		if m.EvidenceLevel != protocol.ProvenanceObserved {
			t.Errorf("stored %s evidence level = %q, want OBSERVED", m.RuleID, m.EvidenceLevel)
		}
		seen[m.RuleID] = true
	}
	for _, want := range []string{"nonzero-command-exit", "failed-test", "concurrent-file-touch"} {
		if !seen[want] {
			t.Errorf("stored rules missing %q; stored = %v", want, seen)
		}
	}

	// The detection table is additive and must not disturb the event spine.
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	n, err := db.EventCount(ctx)
	if err != nil {
		t.Fatalf("EventCount: %v", err)
	}
	if n != 11 {
		t.Errorf("event count = %d, want 11 (detection must not touch events)", n)
	}
}
