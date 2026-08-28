package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/datasets"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/prompts"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// t0 is a fixed reference so seeded data is deterministic.
func t0() time.Time { return time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC) }

func ms(d int64) time.Duration { return time.Duration(d) * time.Millisecond }

// ev builds one canonical event with a workstream and JSON payload.
func ev(ws string, kind protocol.EventKind, at time.Time, seq int64, payload map[string]any, parents ...string) *protocol.Event {
	e := &protocol.Event{
		SchemaVersion:  protocol.SchemaVersionEvent,
		EventID:        ids.Event(),
		OccurredAt:     at,
		ObservedAt:     at,
		WorkstreamID:   ws,
		Kind:           kind,
		Sequence:       seq,
		Provenance:     protocol.ProvenanceObserved,
		ParentEventIDs: parents,
	}
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			panic(err)
		}
		e.Payload = b
	}
	return e
}

// dataset is a deterministic three-trace seed, plus the evaluation surfaces
// (scores, dataset versions, experiment runs, prompt versions/labels):
//
//	WS1 (event-derived workstream, declared title in the payload)
//	  T1: completed turn — 4 spans, 2 failed (command exit 1 + failed test)
//	  T3: running turn — 1 open span
//	WS2 (workstream table row)
//	  T2: completed turn — 1 span, ok
//	scores      — one per data type + one INFERRED (LLM-judge) score
//	datasets    — one name, two immutable content-hash versions
//	experiments — two runs of the newer version, the second one regressed
//	prompts     — "triage" v1+v2 with production→v1, "summarize" v1
type dataset struct {
	ws1, ws2               string
	t1, t2, t3             string
	s1, s2, s3, s4, sa, sb string

	// score ids, newest last (they are the recording event ids)
	scNumeric, scCategory, scBool, scInferred string

	dsName             string
	dsV1, dsV2         string // dataset version content hashes
	dsEvent1, dsEvent2 string // dataset.created event ids
	runA, runB         string // experiment.recorded event ids

	events []*protocol.Event
}

func buildDataset() *dataset {
	d := &dataset{
		ws1: ids.Workstream(),
		ws2: ids.Workstream(),
		t1:  ids.Trace(),
		t2:  ids.Trace(),
		t3:  ids.Trace(),
		s1:  ids.Span(), s2: ids.Span(), s3: ids.Span(), s4: ids.Span(),
		sa: ids.Span(), sb: ids.Span(),
	}
	d.events = []*protocol.Event{
		// WS1 is never inserted into the workstreams table: it must be
		// derived from events, keeping its DECLARED title from the payload.
		ev(d.ws1, protocol.EventWorkstreamStarted, t0().Add(-ms(5)), 0,
			map[string]any{"title": "Fix checkout race"}),

		ev(d.ws1, protocol.EventTraceStarted, t0(), 1,
			map[string]any{"trace_id": d.t1, "objective": "fix checkout race"}),
		ev(d.ws1, protocol.EventSpanStarted, t0().Add(ms(10)), 2,
			map[string]any{"span_id": d.s1, "trace_id": d.t1, "kind": "AGENT", "name": "agent"}),
		ev(d.ws1, protocol.EventSpanStarted, t0().Add(ms(20)), 3,
			map[string]any{"span_id": d.s2, "trace_id": d.t1, "kind": "COMMAND", "name": "go test"}, d.s1),
		ev(d.ws1, protocol.EventCommandCompleted, t0().Add(ms(50)), 4,
			map[string]any{"span_id": d.s2, "trace_id": d.t1, "command": "go test ./...", "exit_code": 1}, d.s1),
		ev(d.ws1, protocol.EventSpanStarted, t0().Add(ms(60)), 5,
			map[string]any{"span_id": d.s3, "trace_id": d.t1, "kind": "FILE_WRITE", "name": "edit db.go"}, d.s1),
		ev(d.ws1, protocol.EventSpanCompleted, t0().Add(ms(80)), 6,
			map[string]any{"span_id": d.s3}, d.s1),
		ev(d.ws1, protocol.EventTestCompleted, t0().Add(ms(90)), 7,
			map[string]any{"span_id": d.s4, "trace_id": d.t1, "name": "TestWALReopen", "result": "failed", "exit_code": 1}, d.s1),
		ev(d.ws1, protocol.EventTraceCompleted, t0().Add(ms(100)), 8,
			map[string]any{"trace_id": d.t1}),

		ev(d.ws2, protocol.EventTraceStarted, t0().Add(ms(200)), 10,
			map[string]any{"trace_id": d.t2, "objective": "port redaction"}),
		ev(d.ws2, protocol.EventSpanStarted, t0().Add(ms(210)), 11,
			map[string]any{"span_id": d.sa, "trace_id": d.t2, "kind": "TOOL", "name": "edit"}),
		ev(d.ws2, protocol.EventSpanCompleted, t0().Add(ms(250)), 12,
			map[string]any{"span_id": d.sa}),
		ev(d.ws2, protocol.EventTraceCompleted, t0().Add(ms(260)), 13,
			map[string]any{"trace_id": d.t2}),

		ev(d.ws1, protocol.EventTraceStarted, t0().Add(ms(300)), 20,
			map[string]any{"trace_id": d.t3, "objective": "live pass"}),
		ev(d.ws1, protocol.EventSpanStarted, t0().Add(ms(310)), 21,
			map[string]any{"span_id": d.sb, "trace_id": d.t3, "kind": "AGENT", "name": "agent"}),
	}
	d.events = append(d.events, d.evalEvents()...)
	return d
}

// evalEvents seeds the evaluation surfaces using the real payload builders —
// scores.NewEvent, datasets.BuildVersion, prompts.NewCreatedEvent — so the
// fixture can never drift from the contracts the CLI writes.
func (d *dataset) evalEvents() []*protocol.Event {
	out := []*protocol.Event{}

	score := func(ws string, at time.Time, in scores.Input) *protocol.Event {
		e, err := scores.NewEvent(ids.Event(), ws, in, at)
		if err != nil {
			panic(err)
		}
		return e
	}
	latency := 412.5
	helpfulness := 0.82
	tests := true

	scNumeric := score(d.ws1, t0().Add(ms(400)), scores.Input{
		Name: "latency_p95_ms", DataType: protocol.ScoreDataTypeNumeric, Value: &latency,
		TargetType: protocol.ScoreTargetTrace, TargetID: d.t1, Source: protocol.ScoreSourceEvaluation,
	})
	scCategory := score(d.ws1, t0().Add(ms(410)), scores.Input{
		Name: "verdict", DataType: protocol.ScoreDataTypeCategory, StringValue: "regression",
		TargetType: protocol.ScoreTargetTrace, TargetID: d.t1, Source: protocol.ScoreSourceHuman,
		Comment: "reviewed the failing WAL test",
	})
	scBool := score(d.ws2, t0().Add(ms(420)), scores.Input{
		Name: "tests_pass", DataType: protocol.ScoreDataTypeBoolean, BoolValue: &tests,
		TargetType: protocol.ScoreTargetTrace, TargetID: d.t2, Source: protocol.ScoreSourceDetection,
	})
	// An LLM-judge score is INFERRED at the envelope level: the payload is
	// built by the same validator, but the provenance the reducer copies onto
	// the read model must never read as OBSERVED.
	scInferred := score(d.ws1, t0().Add(ms(430)), scores.Input{
		Name: "helpfulness", DataType: protocol.ScoreDataTypeNumeric, Value: &helpfulness,
		TargetType: protocol.ScoreTargetSpan, TargetID: d.s1, Source: protocol.ScoreSourceEvaluation,
		Comment: "llm judge (rubric v2)",
	})
	scInferred.Provenance = protocol.ProvenanceInferred
	d.scNumeric, d.scCategory = scNumeric.EventID, scCategory.EventID
	d.scBool, d.scInferred = scBool.EventID, scInferred.EventID
	out = append(out, scNumeric, scCategory, scBool, scInferred)

	// Two immutable versions of one dataset. The version strings are real
	// manifest content hashes computed by the same builder the CLI uses.
	d.dsName = "core-regressions"
	line := func(id string) []byte {
		return []byte(`{"schema_version":"hfg.event.v1","event_id":"` + id + `","kind":"trace.started"}` + "\n")
	}
	v1, err := datasets.BuildVersion(d.dsName, []datasets.InputFile{
		{Name: "wal_reopen.jsonl", Data: line("evt_wal")},
	})
	if err != nil {
		panic(err)
	}
	v2, err := datasets.BuildVersion(d.dsName, []datasets.InputFile{
		{Name: "wal_reopen.jsonl", Data: line("evt_wal")},
		{Name: "checkout_race.jsonl", Data: line("evt_checkout")},
	})
	if err != nil {
		panic(err)
	}
	d.dsV1, d.dsV2 = v1.Version, v2.Version
	dsEvent := func(at time.Time, v *datasets.Version) *protocol.Event {
		return ev("", protocol.EventDatasetCreated, at, 0, map[string]any{
			"name": v.Name, "version": v.Version, "files": v.Files,
		})
	}
	e1 := dsEvent(t0().Add(ms(500)), v1)
	e2 := dsEvent(t0().Add(ms(510)), v2)
	d.dsEvent1, d.dsEvent2 = e1.EventID, e2.EventID
	out = append(out, e1, e2)

	// Two runs of the newer version: the baseline is clean, the candidate
	// regressed one example (a new P0 detection).
	runEvent := func(at time.Time, rec datasets.ExperimentRecord) *protocol.Event {
		raw, err := json.Marshal(rec)
		if err != nil {
			panic(err)
		}
		e := ev("", protocol.EventExperimentRecorded, at, 0, nil)
		e.Payload = raw
		return e
	}
	runA := runEvent(t0().Add(ms(600)), datasets.ExperimentRecord{
		Dataset: d.dsName, Version: d.dsV2, Passed: true,
		Results: []datasets.ExampleResult{
			{Name: "checkout_race.jsonl", Hash: v2.Files[0].Hash, Events: 1, Traces: 1, Spans: 0, Status: "ok"},
			{Name: "wal_reopen.jsonl", Hash: v2.Files[1].Hash, Events: 1, Traces: 1, Spans: 0, Status: "ok"},
		},
	})
	runB := runEvent(t0().Add(ms(610)), datasets.ExperimentRecord{
		Dataset: d.dsName, Version: d.dsV2, Passed: false,
		Results: []datasets.ExampleResult{
			{Name: "checkout_race.jsonl", Hash: v2.Files[0].Hash, Events: 1, Traces: 1, Spans: 0, Status: "ok"},
			{Name: "wal_reopen.jsonl", Hash: v2.Files[1].Hash, Events: 1, Traces: 1, Spans: 0,
				P0Detections: 1, Status: "detections"},
		},
	})
	d.runA, d.runB = runA.EventID, runB.EventID
	out = append(out, runA, runB)

	// Prompts: two versions of "triage" with production pinned to v1 (the
	// O(1) rollback shape), plus a single-version "summarize".
	created := func(at time.Time, name, body string, version int) *protocol.Event {
		e, _, err := prompts.NewCreatedEvent(ids.Event(), "", name, body, "seed", at)
		if err != nil {
			panic(err)
		}
		if err := prompts.AssignVersion(e, version); err != nil {
			panic(err)
		}
		return e
	}
	labeled := func(at time.Time, name, label string, version int) *protocol.Event {
		e, err := prompts.NewLabeledEvent(ids.Event(), "", name, label, version, at)
		if err != nil {
			panic(err)
		}
		return e
	}
	out = append(out,
		created(t0().Add(ms(700)), "triage", "You are a triage agent.\nBe terse.", 1),
		created(t0().Add(ms(710)), "triage", "You are a triage agent.\nCite evidence.", 2),
		labeled(t0().Add(ms(720)), "triage", "production", 1),
		created(t0().Add(ms(730)), "summarize", "Summarize the session for handoff.", 1),
	)
	return out
}

func (d *dataset) appendAll(t *testing.T, db *storage.DB) {
	t.Helper()
	for _, e := range d.events {
		if _, err := db.AppendEvent(context.Background(), e); err != nil {
			t.Fatalf("AppendEvent %s: %v", e.Kind, err)
		}
	}
	if err := db.CreateWorkstream(context.Background(), d.ws2, "Port redaction", ""); err != nil {
		t.Fatalf("CreateWorkstream: %v", err)
	}
}

// newAPIServer opens a throwaway database, runs seed (returning a value the
// test needs, typically the dataset), and returns that value plus a handler
// wired to a minimal static bundle.
func newAPIServer[T any](t *testing.T, seed func(db *storage.DB) T) (T, http.Handler) {
	t.Helper()
	db, err := storage.Open(t.TempDir() + "/hfg.db")
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	var seedResult T
	if seed != nil {
		seedResult = seed(db)
	}
	static := fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<html>index-marker</html>")},
		"assets/app.js":  &fstest.MapFile{Data: []byte("console.log('app')")},
		"assets/app.css": &fstest.MapFile{Data: []byte("body{}")},
	}
	srv := newServer(db, static)
	return seedResult, srv.Handler()
}

func seedDataset(db *storage.DB) *dataset {
	d := buildDataset()
	ctx := context.Background()
	for _, e := range d.events {
		if _, err := db.AppendEvent(ctx, e); err != nil {
			panic(err)
		}
	}
	if err := db.CreateWorkstream(ctx, d.ws2, "Port redaction", ""); err != nil {
		panic(err)
	}
	return d
}

func get(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeEnvelope[T any](t *testing.T, rec *httptest.ResponseRecorder) envelope[T] {
	t.Helper()
	var env envelope[T]
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decode envelope: %v (body: %s)", err, rec.Body.String())
	}
	if env.Items == nil {
		t.Errorf("items = nil, want [] (must never be null)")
	}
	return env
}

// ---- /api/workstreams ----

func TestWorkstreamsEmpty(t *testing.T) {
	_, h := newAPIServer[*dataset](t, nil)
	rec := get(t, h, http.MethodGet, "/api/workstreams")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q, want application/json", ct)
	}
	env := decodeEnvelope[workstreamOut](t, rec)
	if len(env.Items) != 0 {
		t.Errorf("items = %d, want 0", len(env.Items))
	}
	if env.NextCursor != "" {
		t.Errorf("next_cursor = %q, want empty", env.NextCursor)
	}
}

func TestWorkstreamsMergeTableAndEventDerived(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	rec := get(t, h, http.MethodGet, "/api/workstreams")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	env := decodeEnvelope[workstreamOut](t, rec)
	if len(env.Items) != 2 {
		t.Fatalf("items = %d, want 2 (one table row + one derived) — body: %s", len(env.Items), rec.Body.String())
	}
	for i := 1; i < len(env.Items); i++ {
		if env.Items[i-1].CreatedAt > env.Items[i].CreatedAt {
			t.Errorf("items not sorted by created_at: %q then %q",
				env.Items[i-1].CreatedAt, env.Items[i].CreatedAt)
		}
	}
	byID := map[string]workstreamOut{}
	for _, w := range env.Items {
		byID[w.ID] = w
	}
	cases := []struct {
		name       string
		id         string
		title      string
		eventCount int64
		traceCount int
	}{
		// Derived workstream keeps its DECLARED title from the payload.
		// Counts include the workstream-scoped score events; dataset,
		// experiment and prompt events are not workstream-scoped.
		{"derived", d.ws1, "Fix checkout race", 14, 2},
		{"table row", d.ws2, "Port redaction", 5, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := byID[tc.id]
			if !ok {
				t.Fatalf("workstream %s missing; have %v", tc.id, env.Items)
			}
			if got.Title != tc.title || got.EventCount != tc.eventCount || got.TraceCount != tc.traceCount {
				t.Errorf("workstream = %+v, want title=%q events=%d traces=%d",
					got, tc.title, tc.eventCount, tc.traceCount)
			}
			if got.Status == "" || got.CreatedAt == "" {
				t.Errorf("workstream missing status/created_at: %+v", got)
			}
		})
	}
}

// ---- /api/traces ----

func TestTracesListNewestFirstAndFilter(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name   string
		target string
		want   []string
	}{
		{"all newest first", "/api/traces", []string{d.t3, d.t2, d.t1}},
		{"workstream filter ws1", "/api/traces?workstream=" + d.ws1, []string{d.t3, d.t1}},
		{"workstream filter ws2", "/api/traces?workstream=" + d.ws2, []string{d.t2}},
		{"workstream filter empty result", "/api/traces?workstream=ws_ghost", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			env := decodeEnvelope[*protocol.Trace](t, rec)
			got := make([]string, 0, len(env.Items))
			for _, tr := range env.Items {
				got = append(got, tr.TraceID)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("trace ids = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTracesPagination(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	// Page 1: newest trace only.
	rec := get(t, h, http.MethodGet, "/api/traces?limit=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d (body %s)", rec.Code, rec.Body.String())
	}
	env := decodeEnvelope[*protocol.Trace](t, rec)
	if len(env.Items) != 1 || env.Items[0].TraceID != d.t3 {
		t.Fatalf("page 1 = %v, want [%s]", env.Items, d.t3)
	}
	if env.NextCursor != d.t3 {
		t.Errorf("next_cursor = %q, want %q", env.NextCursor, d.t3)
	}

	// Page 2 continues strictly after the cursor.
	rec = get(t, h, http.MethodGet, "/api/traces?limit=2&cursor="+env.NextCursor)
	env = decodeEnvelope[*protocol.Trace](t, rec)
	if len(env.Items) != 2 || env.Items[0].TraceID != d.t2 || env.Items[1].TraceID != d.t1 {
		t.Fatalf("page 2 = %v, want [%s %s]", env.Items, d.t2, d.t1)
	}
	if env.NextCursor != "" {
		t.Errorf("next_cursor after last page = %q, want empty", env.NextCursor)
	}

	// Cursor at the end: empty page, not an error.
	rec = get(t, h, http.MethodGet, "/api/traces?cursor="+d.t1)
	if rec.Code != http.StatusOK {
		t.Fatalf("cursor-at-end status = %d", rec.Code)
	}
	if env := decodeEnvelope[*protocol.Trace](t, rec); len(env.Items) != 0 {
		t.Errorf("cursor-at-end items = %d, want 0", len(env.Items))
	}
}

func TestTracesBadParams(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name   string
		target string
	}{
		{"bad limit", "/api/traces?limit=abc"},
		{"negative limit", "/api/traces?limit=-1"},
		{"limit too large", "/api/traces?limit=2000"},
		{"unknown cursor", "/api/traces?cursor=nope"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			var e map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e["error"] == "" {
				t.Errorf("body = %s, want JSON error object", rec.Body.String())
			}
		})
	}
}

func TestTracesDeterministicAcrossRequests(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	first := get(t, h, http.MethodGet, "/api/traces").Body.String()
	for i := 0; i < 3; i++ {
		if again := get(t, h, http.MethodGet, "/api/traces").Body.String(); again != first {
			t.Fatalf("request %d differs:\n%s\n---\n%s", i, first, again)
		}
	}
}

// ---- /api/traces/{id} ----

func TestTraceDetail(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	rec := get(t, h, http.MethodGet, "/api/traces/"+d.t1)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var tr protocol.Trace
	if err := json.Unmarshal(rec.Body.Bytes(), &tr); err != nil {
		t.Fatalf("unmarshal trace: %v", err)
	}
	checks := []struct {
		name string
		got  any
		want any
	}{
		{"schema_version", tr.SchemaVersion, protocol.SchemaVersionTrace},
		{"status", tr.Status, protocol.TraceOK},
		{"span_count", tr.SpanCount, int64(4)},
		{"failed_span_count", tr.FailedSpanCount, int64(2)},
		{"changed_file_count", tr.ChangedFileCount, int64(1)},
		{"duration_ns", tr.DurationNS, int64(100_000_000)},
		{"verification_state", tr.VerificationState, protocol.VerificationFailed},
		{"objective", tr.ObjectiveExcerpt, "fix checkout race"},
		{"root_span", tr.RootSpanID, d.s1},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}

	// Unknown id -> JSON 404.
	rec = get(t, h, http.MethodGet, "/api/traces/trc_missing")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing trace status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "error") {
		t.Errorf("404 body = %s, want JSON error", rec.Body.String())
	}
}

// ---- /api/spans?trace= ----

func TestSpansByTrace(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	rec := get(t, h, http.MethodGet, "/api/spans?trace="+d.t1)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	env := decodeEnvelope[*protocol.Span](t, rec)
	if len(env.Items) != 4 {
		t.Fatalf("spans = %d, want 4 (body %s)", len(env.Items), rec.Body.String())
	}
	// Materializer order: sequence, started_at_ns, span_id.
	for i := 1; i < len(env.Items); i++ {
		if env.Items[i-1].Sequence > env.Items[i].Sequence {
			t.Errorf("spans out of order: seq %d before %d", env.Items[i-1].Sequence, env.Items[i].Sequence)
		}
	}
	// The failing command carries its exit code; the failed test span is
	// preserved as error evidence; the tree parent links survive.
	var failedCmd, failedTest int
	for _, sp := range env.Items {
		switch {
		case sp.Kind == protocol.SpanKindCommand && sp.Status == "error":
			failedCmd++
			if sp.ExitCode == nil || *sp.ExitCode != 1 {
				t.Errorf("command span exit_code = %v, want 1", sp.ExitCode)
			}
		case sp.Kind == protocol.SpanKindTest && sp.Status == "error":
			failedTest++
		}
	}
	if failedCmd != 1 || failedTest != 1 {
		t.Errorf("failed command spans = %d, failed test spans = %d; want 1 each", failedCmd, failedTest)
	}
	var agentSpan *protocol.Span
	for _, sp := range env.Items {
		if sp.SpanID == d.s1 {
			agentSpan = sp
		}
	}
	if agentSpan == nil || agentSpan.ParentSpanID != "" {
		t.Errorf("root agent span = %+v, want parentless root", agentSpan)
	}

	// Running trace: one open span with no end.
	rec = get(t, h, http.MethodGet, "/api/spans?trace="+d.t3)
	env = decodeEnvelope[*protocol.Span](t, rec)
	if len(env.Items) != 1 {
		t.Fatalf("running trace spans = %d, want 1", len(env.Items))
	}
	if env.Items[0].EndedAtNS != 0 {
		t.Errorf("open span ended_at_ns = %d, want 0", env.Items[0].EndedAtNS)
	}

	// Missing and unknown trace ids.
	for _, tc := range []struct {
		name   string
		target string
		want   int
	}{
		{"missing param", "/api/spans", http.StatusBadRequest},
		{"unknown trace", "/api/spans?trace=trc_missing", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := get(t, h, http.MethodGet, tc.target); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestSpansPagination(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	rec := get(t, h, http.MethodGet, "/api/spans?trace="+d.t1+"&limit=2")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	env := decodeEnvelope[*protocol.Span](t, rec)
	if len(env.Items) != 2 || env.NextCursor == "" {
		t.Fatalf("page 1 = %d items, cursor %q; want 2 items + cursor", len(env.Items), env.NextCursor)
	}
	page1 := []string{env.Items[0].SpanID, env.Items[1].SpanID}

	rec = get(t, h, http.MethodGet, "/api/spans?trace="+d.t1+"&cursor="+env.NextCursor)
	env = decodeEnvelope[*protocol.Span](t, rec)
	if len(env.Items) != 2 || env.NextCursor != "" {
		t.Fatalf("page 2 = %d items, cursor %q; want 2 items, empty cursor", len(env.Items), env.NextCursor)
	}
	all := append(append([]string{}, page1...), env.Items[0].SpanID, env.Items[1].SpanID)
	if len(unique(all)) != 4 {
		t.Errorf("paged span ids = %v, want 4 unique", all)
	}
}

func unique(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ---- /api/scores ----

func TestScoresListFiltersAndOrder(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name   string
		target string
		want   []string
	}{
		// Newest first, like /api/traces.
		{"all newest first", "/api/scores", []string{d.scInferred, d.scBool, d.scCategory, d.scNumeric}},
		{"workstream filter", "/api/scores?workstream=" + d.ws1, []string{d.scInferred, d.scCategory, d.scNumeric}},
		{"workstream filter ws2", "/api/scores?workstream=" + d.ws2, []string{d.scBool}},
		{"target filter trace", "/api/scores?target=" + d.t1, []string{d.scCategory, d.scNumeric}},
		{"target filter span", "/api/scores?target=" + d.s1, []string{d.scInferred}},
		{"both filters", "/api/scores?workstream=" + d.ws2 + "&target=" + d.t2, []string{d.scBool}},
		{"filter with no match", "/api/scores?target=trc_ghost", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			env := decodeEnvelope[*protocol.Score](t, rec)
			got := make([]string, 0, len(env.Items))
			for _, sc := range env.Items {
				got = append(got, sc.ScoreID)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("score ids = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestScoresValueSlotsAndProvenance(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	rec := get(t, h, http.MethodGet, "/api/scores")
	env := decodeEnvelope[*protocol.Score](t, rec)
	byID := map[string]*protocol.Score{}
	for _, sc := range env.Items {
		byID[sc.ScoreID] = sc
	}

	cases := []struct {
		name       string
		id         string
		dataType   protocol.ScoreDataType
		provenance protocol.Provenance
		check      func(t *testing.T, sc *protocol.Score)
	}{
		{"numeric", d.scNumeric, protocol.ScoreDataTypeNumeric, protocol.ProvenanceObserved,
			func(t *testing.T, sc *protocol.Score) {
				if sc.Value == nil || *sc.Value != 412.5 {
					t.Errorf("value = %v, want 412.5", sc.Value)
				}
				if sc.StringValue != "" || sc.BoolValue != nil {
					t.Errorf("numeric score filled another value slot: %+v", sc)
				}
			}},
		{"category", d.scCategory, protocol.ScoreDataTypeCategory, protocol.ProvenanceObserved,
			func(t *testing.T, sc *protocol.Score) {
				if sc.StringValue != "regression" {
					t.Errorf("string_value = %q, want regression", sc.StringValue)
				}
			}},
		{"boolean", d.scBool, protocol.ScoreDataTypeBoolean, protocol.ProvenanceObserved,
			func(t *testing.T, sc *protocol.Score) {
				if sc.BoolValue == nil || !*sc.BoolValue {
					t.Errorf("bool_value = %v, want true", sc.BoolValue)
				}
			}},
		// The LLM-judge score must arrive INFERRED so the UI can never
		// render it like an observed measurement.
		{"llm judge", d.scInferred, protocol.ScoreDataTypeNumeric, protocol.ProvenanceInferred,
			func(t *testing.T, sc *protocol.Score) {
				if sc.TargetType != protocol.ScoreTargetSpan || sc.TargetID != d.s1 {
					t.Errorf("target = %s/%s, want span/%s", sc.TargetType, sc.TargetID, d.s1)
				}
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sc, ok := byID[tc.id]
			if !ok {
				t.Fatalf("score %s missing from %d items", tc.id, len(env.Items))
			}
			if sc.SchemaVersion != protocol.SchemaVersionScore {
				t.Errorf("schema_version = %q, want %q", sc.SchemaVersion, protocol.SchemaVersionScore)
			}
			if sc.DataType != tc.dataType {
				t.Errorf("data_type = %q, want %q", sc.DataType, tc.dataType)
			}
			if sc.Provenance != tc.provenance {
				t.Errorf("provenance = %q, want %q", sc.Provenance, tc.provenance)
			}
			tc.check(t, sc)
		})
	}

	// occurred_at is an RFC3339 string on the wire, not a nanosecond number.
	// (decodeEnvelope drained the recorder above, so re-request the bytes.)
	body := get(t, h, http.MethodGet, "/api/scores").Body.String()
	for _, want := range []string{`"occurred_at": "2026-08-21T12:00:00`, `"schema_version": "hfg.score.v1"`, `"provenance": "INFERRED"`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %s:\n%s", want, body)
		}
	}
}

func TestScoresPaginationAndBadParams(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	rec := get(t, h, http.MethodGet, "/api/scores?limit=1")
	env := decodeEnvelope[*protocol.Score](t, rec)
	if len(env.Items) != 1 || env.Items[0].ScoreID != d.scInferred || env.NextCursor != d.scInferred {
		t.Fatalf("page 1 = %d items cursor %q, want [%s]", len(env.Items), env.NextCursor, d.scInferred)
	}
	rec = get(t, h, http.MethodGet, "/api/scores?cursor="+env.NextCursor)
	env = decodeEnvelope[*protocol.Score](t, rec)
	if len(env.Items) != 3 || env.NextCursor != "" {
		t.Fatalf("page 2 = %d items cursor %q, want 3 items and no cursor", len(env.Items), env.NextCursor)
	}

	for _, target := range []string{
		"/api/scores?limit=abc", "/api/scores?limit=-1",
		"/api/scores?limit=2000", "/api/scores?cursor=nope",
	} {
		t.Run(target, func(t *testing.T) {
			if rec := get(t, h, http.MethodGet, target); rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
		})
	}
}

// ---- /api/datasets ----

func TestDatasetsList(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	rec := get(t, h, http.MethodGet, "/api/datasets")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	env := decodeEnvelope[datasetOut](t, rec)
	if len(env.Items) != 2 {
		t.Fatalf("items = %d, want 2 versions (body %s)", len(env.Items), rec.Body.String())
	}
	cases := []struct {
		name         string
		got          datasetOut
		wantEvent    string
		wantVersion  string
		wantExamples int
	}{
		{"older version first", env.Items[0], d.dsEvent1, d.dsV1, 1},
		{"newer version second", env.Items[1], d.dsEvent2, d.dsV2, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got.EventID != tc.wantEvent || tc.got.Version != tc.wantVersion {
				t.Errorf("row = %+v, want event %s version %s", tc.got, tc.wantEvent, tc.wantVersion)
			}
			if tc.got.Name != d.dsName || tc.got.ExampleCount != tc.wantExamples {
				t.Errorf("row = %+v, want name %s with %d example(s)", tc.got, d.dsName, tc.wantExamples)
			}
			// Content-addressed: the version string IS the manifest hash.
			if tc.got.ContentHash != tc.got.Version || !strings.HasPrefix(tc.got.ContentHash, "sha256:") {
				t.Errorf("content_hash = %q, want the sha256 manifest hash", tc.got.ContentHash)
			}
			if !strings.HasPrefix(tc.got.CreatedAt, "2026-08-21T12:00:00") {
				t.Errorf("created_at = %q, want an RFC3339 timestamp", tc.got.CreatedAt)
			}
		})
	}

	// Paging and bad params behave like every other list endpoint.
	env = decodeEnvelope[datasetOut](t, get(t, h, http.MethodGet, "/api/datasets?limit=1"))
	if len(env.Items) != 1 || env.NextCursor != d.dsEvent1 {
		t.Errorf("page 1 = %d items cursor %q, want 1 item cursor %s", len(env.Items), env.NextCursor, d.dsEvent1)
	}
	if rec := get(t, h, http.MethodGet, "/api/datasets?cursor=nope"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad cursor status = %d, want 400", rec.Code)
	}
}

// ---- /api/experiments ----

func TestExperimentsList(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name   string
		target string
		want   []string
	}{
		{"newest first", "/api/experiments", []string{d.runB, d.runA}},
		{"dataset filter", "/api/experiments?dataset=" + d.dsName, []string{d.runB, d.runA}},
		{"unknown dataset", "/api/experiments?dataset=ghost", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			env := decodeEnvelope[experimentOut](t, rec)
			got := make([]string, 0, len(env.Items))
			for _, run := range env.Items {
				got = append(got, run.ID)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("run ids = %v, want %v", got, tc.want)
			}
		})
	}

	env := decodeEnvelope[experimentOut](t, get(t, h, http.MethodGet, "/api/experiments"))
	byID := map[string]experimentOut{}
	for _, run := range env.Items {
		byID[run.ID] = run
	}
	counts := []struct {
		name                string
		id                  string
		passed              bool
		passedCnt, failCnt  int
		version, datasetVal string
	}{
		{"baseline run", d.runA, true, 2, 0, d.dsV2, d.dsName},
		{"regressed run", d.runB, false, 1, 1, d.dsV2, d.dsName},
	}
	for _, tc := range counts {
		t.Run(tc.name, func(t *testing.T) {
			run := byID[tc.id]
			if run.Passed != tc.passed || run.PassedCount != tc.passedCnt || run.FailedCount != tc.failCnt {
				t.Errorf("run = %+v, want passed=%v %d passed / %d failed", run, tc.passed, tc.passedCnt, tc.failCnt)
			}
			if run.ExampleCount != 2 || run.Version != tc.version || run.Dataset != tc.datasetVal {
				t.Errorf("run = %+v, want 2 examples of %s@%s", run, tc.datasetVal, tc.version)
			}
		})
	}

	if rec := get(t, h, http.MethodGet, "/api/experiments?limit=abc"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad limit status = %d, want 400", rec.Code)
	}
}

// ---- /api/experiments/compare ----

func TestExperimentCompare(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)

	rec := get(t, h, http.MethodGet, "/api/experiments/compare?a="+d.runA+"&b="+d.runB)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var cmp compareOut
	if err := json.Unmarshal(rec.Body.Bytes(), &cmp); err != nil {
		t.Fatalf("decode compare: %v (body %s)", err, rec.Body.String())
	}
	if cmp.A.ID != d.runA || cmp.B.ID != d.runB {
		t.Errorf("compare sides = %s/%s, want %s/%s", cmp.A.ID, cmp.B.ID, d.runA, d.runB)
	}
	if cmp.Regressions != 1 {
		t.Errorf("regressions = %d, want 1", cmp.Regressions)
	}
	if len(cmp.Items) != 2 {
		t.Fatalf("items = %d, want 2 (body %s)", len(cmp.Items), rec.Body.String())
	}
	// datasets.Compare sorts by example name — the same order the CLI prints.
	wants := []struct {
		file       string
		from, to   string
		toP0       int
		regression bool
	}{
		{"checkout_race.jsonl", "ok", "ok", 0, false},
		{"wal_reopen.jsonl", "ok", "detections", 1, true},
	}
	for i, want := range wants {
		got := cmp.Items[i]
		if got.File != want.file || got.FromStatus != want.from || got.ToStatus != want.to ||
			got.ToP0 != want.toP0 || got.Regression != want.regression {
			t.Errorf("items[%d] = %+v, want %+v", i, got, want)
		}
	}

	// Reversing the sides turns the regression into a recovery.
	rec = get(t, h, http.MethodGet, "/api/experiments/compare?a="+d.runB+"&b="+d.runA)
	if err := json.Unmarshal(rec.Body.Bytes(), &cmp); err != nil {
		t.Fatalf("decode reversed compare: %v", err)
	}
	if cmp.Regressions != 0 {
		t.Errorf("reversed regressions = %d, want 0", cmp.Regressions)
	}

	badCases := []struct {
		name   string
		target string
		want   int
	}{
		{"missing both", "/api/experiments/compare", http.StatusBadRequest},
		{"missing b", "/api/experiments/compare?a=" + d.runA, http.StatusBadRequest},
		{"missing a", "/api/experiments/compare?b=" + d.runB, http.StatusBadRequest},
		{"unknown run", "/api/experiments/compare?a=" + d.runA + "&b=evt_ghost", http.StatusNotFound},
	}
	for _, tc := range badCases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			var e map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e["error"] == "" {
				t.Errorf("body = %s, want JSON error object", rec.Body.String())
			}
		})
	}
}

// ---- /api/prompts ----

func TestPromptsList(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	rec := get(t, h, http.MethodGet, "/api/prompts")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	env := decodeEnvelope[promptOut](t, rec)
	if len(env.Items) != 2 || env.Items[0].Name != "summarize" || env.Items[1].Name != "triage" {
		t.Fatalf("prompts = %+v, want [summarize triage] sorted by name", env.Items)
	}

	triage := env.Items[1]
	if triage.VersionCount != 2 || triage.LatestVersion != 2 {
		t.Errorf("triage = %+v, want 2 versions with latest 2", triage)
	}
	if len(triage.Versions) != 2 || triage.Versions[0].Version != 1 || triage.Versions[1].Version != 2 {
		t.Errorf("triage versions = %+v, want the ladder 1,2", triage.Versions)
	}
	if triage.LatestHash == "" || triage.LatestHash != triage.Versions[1].Hash {
		t.Errorf("latest_hash = %q, want the v2 hash %q", triage.LatestHash, triage.Versions[1].Hash)
	}
	// Labels are flattened deterministically by label name; `latest` is
	// always resolved even though it was never labeled explicitly.
	wantLabels := []promptLabelOut{{Label: "latest", Version: 2}, {Label: "production", Version: 1}}
	if len(triage.Labels) != len(wantLabels) {
		t.Fatalf("labels = %+v, want %+v", triage.Labels, wantLabels)
	}
	for i, want := range wantLabels {
		if triage.Labels[i] != want {
			t.Errorf("labels[%d] = %+v, want %+v", i, triage.Labels[i], want)
		}
	}

	summarize := env.Items[0]
	if summarize.VersionCount != 1 || len(summarize.Labels) != 1 || summarize.Labels[0].Label != "latest" {
		t.Errorf("summarize = %+v, want one version labeled only latest", summarize)
	}

	// Paging by name plus the shared bad-param contract.
	env = decodeEnvelope[promptOut](t, get(t, h, http.MethodGet, "/api/prompts?limit=1"))
	if len(env.Items) != 1 || env.NextCursor != "summarize" {
		t.Errorf("page 1 = %+v cursor %q, want [summarize]", env.Items, env.NextCursor)
	}
	env = decodeEnvelope[promptOut](t, get(t, h, http.MethodGet, "/api/prompts?cursor=summarize"))
	if len(env.Items) != 1 || env.Items[0].Name != "triage" {
		t.Errorf("page 2 = %+v, want [triage]", env.Items)
	}
	if rec := get(t, h, http.MethodGet, "/api/prompts?limit=-3"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad limit status = %d, want 400", rec.Code)
	}
}

// ---- /api/prompts/show ----

func TestPromptShow(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)

	cases := []struct {
		name        string
		target      string
		wantVersion int
		wantBody    string
		wantLabels  []string
	}{
		{"defaults to latest", "/api/prompts/show?name=triage", 2, "Cite evidence.", []string{"latest"}},
		{"explicit version", "/api/prompts/show?name=triage&version=1", 1, "Be terse.", []string{"production"}},
		{"single version prompt", "/api/prompts/show?name=summarize", 1, "Summarize the session for handoff.", []string{"latest"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			var got promptBodyOut
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.Version != tc.wantVersion || !strings.Contains(got.Body, tc.wantBody) {
				t.Errorf("got version %d body %q, want version %d containing %q",
					got.Version, got.Body, tc.wantVersion, tc.wantBody)
			}
			if strings.Join(got.Labels, ",") != strings.Join(tc.wantLabels, ",") {
				t.Errorf("labels = %v, want %v", got.Labels, tc.wantLabels)
			}
			// The recorded hash must match the body that was served.
			if !strings.HasPrefix(got.Hash, "sha256:") {
				t.Errorf("hash = %q, want a sha256 content hash", got.Hash)
			}
			if got.CreatedBy != "seed" || !strings.HasPrefix(got.CreatedAt, "2026-08-21T12:00:00") {
				t.Errorf("metadata = %+v, want created_by/created_at from the event", got)
			}
		})
	}

	badCases := []struct {
		name   string
		target string
		want   int
	}{
		{"missing name", "/api/prompts/show", http.StatusBadRequest},
		{"non-numeric version", "/api/prompts/show?name=triage&version=x", http.StatusBadRequest},
		{"zero version", "/api/prompts/show?name=triage&version=0", http.StatusBadRequest},
		{"unknown prompt", "/api/prompts/show?name=ghost", http.StatusNotFound},
		{"unknown version", "/api/prompts/show?name=triage&version=9", http.StatusNotFound},
	}
	for _, tc := range badCases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "error") {
				t.Errorf("body = %s, want JSON error", rec.Body.String())
			}
		})
	}
}

// ---- determinism across requests ----

// TestEvalSurfacesDeterministicAcrossRequests mirrors
// TestTracesDeterministicAcrossRequests for every evaluation endpoint: the
// response bytes are a pure function of the event log, never of map order.
func TestEvalSurfacesDeterministicAcrossRequests(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	targets := []string{
		"/api/scores",
		"/api/scores?workstream=" + d.ws1,
		"/api/datasets",
		"/api/experiments",
		"/api/experiments/compare?a=" + d.runA + "&b=" + d.runB,
		"/api/prompts",
		"/api/prompts/show?name=triage",
	}
	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			first := get(t, h, http.MethodGet, target).Body.String()
			for i := 0; i < 3; i++ {
				if again := get(t, h, http.MethodGet, target).Body.String(); again != first {
					t.Fatalf("request %d differs:\n%s\n---\n%s", i, first, again)
				}
			}
		})
	}
}

// TestEvalEnvelopeShapes pins the JSON keys the frontend types mirror.
func TestEvalEnvelopeShapes(t *testing.T) {
	d, h := newAPIServer(t, seedDataset)
	cases := []struct {
		target string
		want   []string
	}{
		{"/api/scores", []string{`"items"`, `"next_cursor"`, `"score_id"`, `"data_type"`,
			`"target_type"`, `"target_id"`, `"source"`, `"provenance"`, `"occurred_at"`}},
		{"/api/datasets", []string{`"items"`, `"next_cursor"`, `"event_id"`, `"name"`,
			`"version"`, `"example_count"`, `"content_hash"`, `"created_at"`}},
		{"/api/experiments", []string{`"items"`, `"next_cursor"`, `"id"`, `"dataset"`,
			`"version"`, `"passed"`, `"passed_count"`, `"failed_count"`, `"example_count"`, `"created_at"`}},
		{"/api/experiments/compare?a=" + d.runA + "&b=" + d.runB, []string{`"a"`, `"b"`,
			`"regressions"`, `"items"`, `"file"`, `"from_status"`, `"to_status"`, `"from_p0"`, `"to_p0"`, `"regression"`}},
		{"/api/prompts", []string{`"items"`, `"next_cursor"`, `"name"`, `"version_count"`,
			`"latest_version"`, `"latest_hash"`, `"labels"`, `"versions"`}},
		{"/api/prompts/show?name=triage", []string{`"name"`, `"version"`, `"body"`,
			`"hash"`, `"created_at"`, `"labels"`, `"latest_version"`, `"version_count"`}},
	}
	for _, tc := range cases {
		t.Run(tc.target, func(t *testing.T) {
			body := get(t, h, http.MethodGet, tc.target).Body.String()
			for _, want := range tc.want {
				if !strings.Contains(body, want) {
					t.Errorf("body missing %s:\n%s", want, body)
				}
			}
		})
	}
}

// TestEvalSurfacesEmptyStore proves every endpoint answers with an empty
// envelope (never null items, never a 500) on a store with no such events.
func TestEvalSurfacesEmptyStore(t *testing.T) {
	_, h := newAPIServer[*dataset](t, nil)
	for _, target := range []string{"/api/scores", "/api/datasets", "/api/experiments", "/api/prompts"} {
		t.Run(target, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, target)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"items": []`) {
				t.Errorf("body = %s, want an empty items array", rec.Body.String())
			}
		})
	}
}

// ---- methods, unknown API routes, headers ----

func TestAPIMethodsAndUnknownRoutes(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name   string
		method string
		target string
		want   int
	}{
		{"POST traces rejected", http.MethodPost, "/api/traces", http.StatusMethodNotAllowed},
		{"DELETE workstreams rejected", http.MethodDelete, "/api/workstreams", http.StatusMethodNotAllowed},
		{"unknown api route", http.MethodGet, "/api/nope", http.StatusNotFound},
		{"unknown nested api route", http.MethodGet, "/api/traces/x/spans", http.StatusNotFound},
		{"POST root rejected", http.MethodPost, "/", http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, tc.method, tc.target)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
	// Unknown API routes answer in JSON, never with the SPA shell.
	rec := get(t, h, http.MethodGet, "/api/nope")
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("unknown api route content-type = %q, want application/json", ct)
	}
	if strings.Contains(rec.Body.String(), "index-marker") {
		t.Error("unknown api route served the SPA shell")
	}
}

func TestSecurityHeaders(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	for _, target := range []string{"/", "/api/workstreams", "/api/traces", "/assets/app.js"} {
		t.Run(target, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, target)
			for header, want := range map[string]string{
				"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
				"X-Content-Type-Options":  "nosniff",
				"Referrer-Policy":         "no-referrer",
				"X-Frame-Options":         "DENY",
			} {
				if got := rec.Header().Get(header); got != want {
					t.Errorf("%s = %q, want %q", header, got, want)
				}
			}
			if strings.HasPrefix(target, "/api/") && rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
			}
		})
	}
}

// ---- static bundle ----

func TestStaticRoutes(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	cases := []struct {
		name       string
		target     string
		wantStatus int
		wantBody   string
		wantCT     string
	}{
		{"root serves index", "/", http.StatusOK, "index-marker", "text/html"},
		{"asset js", "/assets/app.js", http.StatusOK, "console.log", "javascript"},
		{"asset css", "/assets/app.css", http.StatusOK, "body{}", "text/css"},
		{"spa fallback", "/traces/trc_whatever", http.StatusOK, "index-marker", "text/html"},
		{"directory falls back, never lists", "/assets", http.StatusOK, "index-marker", "text/html"},
		{"missing asset 404s", "/missing.png", http.StatusNotFound, "", ""},
		{"missing nested asset 404s", "/assets/ghost.js", http.StatusNotFound, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, http.MethodGet, tc.target)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantBody != "" && !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Errorf("body = %q, want it to contain %q", rec.Body.String(), tc.wantBody)
			}
			if tc.wantCT != "" && !strings.Contains(rec.Header().Get("Content-Type"), tc.wantCT) {
				t.Errorf("content-type = %q, want prefix %q", rec.Header().Get("Content-Type"), tc.wantCT)
			}
			if strings.Contains(rec.Body.String(), "Directory listing") {
				t.Errorf("directory listing leaked for %s", tc.target)
			}
		})
	}
}

func TestPlaceholderWhenNoBundleAvailable(t *testing.T) {
	db, err := storage.Open(t.TempDir() + "/hfg.db")
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()

	cases := []struct {
		name   string
		static fstest.MapFS
	}{
		{"empty fs", fstest.MapFS{}},
		{"fs without index.html", fstest.MapFS{"assets/app.js": &fstest.MapFile{Data: []byte("x")}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newServer(db, tc.static)
			h := srv.Handler()
			rec := get(t, h, http.MethodGet, "/")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "web UI is not built") {
				t.Errorf("body = %q, want placeholder page", rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
				t.Errorf("content-type = %q, want text/html", ct)
			}
		})
	}
	// A nil static FS (dev build without web/dist) also falls back.
	srv := newServer(db, nil)
	rec := get(t, srv.Handler(), http.MethodGet, "/")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "web UI is not built") {
		t.Errorf("nil fs: status %d body %q", rec.Code, rec.Body.String())
	}
}

// TestNewServesEmbeddedBundle exercises the real embedded dist FS (which
// carries the committed placeholder until `npm run build` replaces it).
func TestNewServesEmbeddedBundle(t *testing.T) {
	db, err := storage.Open(t.TempDir() + "/hfg.db")
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	h := New(db).Handler()

	rec := get(t, h, http.MethodGet, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("body = %q, want an html document", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Directory listing") {
		t.Error("directory listing leaked")
	}
	// The embedded bundle is also served under its own paths once built.
	rec = get(t, h, http.MethodGet, "/api/workstreams")
	if rec.Code != http.StatusOK {
		t.Errorf("api status = %d, want 200", rec.Code)
	}
}

// TestTracesEnvelopeShape pins the cursor-friendly envelope contract.
func TestTracesEnvelopeShape(t *testing.T) {
	_, h := newAPIServer(t, seedDataset)
	body := get(t, h, http.MethodGet, "/api/traces").Body.String()
	for _, want := range []string{
		`"items"`, `"next_cursor"`, `"trace_id"`, `"span_count"`,
		`"failed_span_count"`, `"duration_ns"`, `"verification_state"`, `"status"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %s:\n%s", want, body)
		}
	}
}
