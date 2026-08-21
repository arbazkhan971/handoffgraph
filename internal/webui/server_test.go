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

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
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

// dataset is a deterministic three-trace seed:
//
//	WS1 (event-derived workstream, declared title in the payload)
//	  T1: completed turn — 4 spans, 2 failed (command exit 1 + failed test)
//	  T3: running turn — 1 open span
//	WS2 (workstream table row)
//	  T2: completed turn — 1 span, ok
type dataset struct {
	ws1, ws2               string
	t1, t2, t3             string
	s1, s2, s3, s4, sa, sb string
	events                 []*protocol.Event
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
	return d
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
		{"derived", d.ws1, "Fix checkout race", 11, 2},
		{"table row", d.ws2, "Port redaction", 4, 1},
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
				"Content-Security-Policy": "default-src 'self'",
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
