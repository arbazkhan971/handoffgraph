// Package webui serves the local session debugger: an embedded React bundle
// plus read-only JSON APIs over the local event store.
//
// The server is localhost-only by design and never mutates the database.
// All API responses are derived read models (hfg.trace.v1, hfg.score.v1, the
// datasets/experiments and prompt views) materialized deterministically from
// the ordered event log, and every list response uses a cursor-friendly
// envelope ({"items": [...], "next_cursor": ""}).
//
// Every derivation reuses the same reducer the CLI uses — trace.Materialize,
// scores.Materialize, datasets.Materialize/MaterializeExperiments/Compare,
// prompts.Materialize — so the UI can never disagree with the command line
// about what the event log says.
package webui

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/buildinfo"
	"github.com/handoffgraph/handoffgraph/internal/datasets"
	"github.com/handoffgraph/handoffgraph/internal/prompts"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// DefaultAddr is the localhost-only address the debugger binds by default.
const DefaultAddr = "127.0.0.1:7788"

// DefaultPort is the default localhost port (part of DefaultAddr).
const DefaultPort = 7788

// maxLimit caps a single page so responses stay bounded; larger requests
// must page with cursors.
const maxLimit = 1000

// placeholderPage is served when no built bundle is available. It is
// intentionally free of inline styles and scripts so it renders under the
// strict CSP applied to every response.
const placeholderPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>HandoffGraph — web UI not built</title></head>
<body>
<h1>HandoffGraph web UI is not built yet</h1>
<p>Build the frontend and recompile:</p>
<pre>cd web
npm install
npm run build</pre>
<p>(npm run build also copies web/dist into internal/webui/dist, which this
binary embeds.)</p>
</body>
</html>
`

// Server serves the session debugger: read-only JSON APIs under /api plus
// the embedded static bundle at /.
type Server struct {
	db     *storage.DB
	static fs.FS // built bundle contents; nil when unavailable
}

// New returns a server over db serving the embedded web bundle.
func New(db *storage.DB) *Server {
	return newServer(db, distAssets())
}

func newServer(db *storage.DB, static fs.FS) *Server {
	return &Server{db: db, static: static}
}

// Handler returns the fully wrapped root handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/workstreams", s.handleWorkstreams)
	mux.HandleFunc("GET /api/traces", s.handleTraces)
	mux.HandleFunc("GET /api/traces/{id}", s.handleTraceDetail)
	mux.HandleFunc("GET /api/spans", s.handleSpans)
	mux.HandleFunc("GET /api/scores", s.handleScores)
	mux.HandleFunc("GET /api/datasets", s.handleDatasets)
	mux.HandleFunc("GET /api/experiments", s.handleExperiments)
	mux.HandleFunc("GET /api/experiments/compare", s.handleExperimentCompare)
	mux.HandleFunc("GET /api/prompts", s.handlePrompts)
	mux.HandleFunc("GET /api/prompts/show", s.handlePromptShow)
	mux.HandleFunc("GET /api/version", s.handleVersion)
	mux.Handle("/", http.HandlerFunc(s.handleStatic))
	return withSecurityHeaders(mux)
}

// ---- shared helpers ----

// withSecurityHeaders applies the debugger's security policy to every
// response. The CSP is `default-src 'self'`: same-origin scripts, styles,
// images, fonts and fetches only.
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// envelope is the cursor-friendly list response shared by every list
// endpoint. Items is never null: empty lists serialize as [].
type envelope[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor"`
}

// pageParams parses ?limit= and ?cursor= for a list endpoint. limit <= 0
// means "no limit"; cursors are opaque item ids.
func pageParams(r *http.Request) (limit int, cursor string, err error) {
	limit = 0
	cursor = r.URL.Query().Get("cursor")
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, perr := strconv.Atoi(raw)
		if perr != nil || n < 0 {
			return 0, "", fmt.Errorf("invalid limit %q", raw)
		}
		if n > maxLimit {
			return 0, "", fmt.Errorf("limit %d exceeds maximum %d", n, maxLimit)
		}
		limit = n
	}
	return limit, cursor, nil
}

// paginate applies an optional cursor and limit to an already-sorted slice.
// The cursor is the id of the last item the caller consumed; the returned
// page continues strictly after it. nextCursor is "" when the list is
// exhausted.
func paginate[T any](items []T, limit int, cursor string, idOf func(T) string) (page []T, next string, err error) {
	start := 0
	if cursor != "" {
		found := -1
		for i, it := range items {
			if idOf(it) == cursor {
				found = i
				break
			}
		}
		if found < 0 {
			return nil, "", fmt.Errorf("invalid cursor %q", cursor)
		}
		start = found + 1
	}
	rest := items[start:]
	if limit > 0 && len(rest) > limit {
		rest = rest[:limit]
		return rest, idOf(rest[len(rest)-1]), nil
	}
	return rest, "", nil
}

// materialize loads the ordered event log and derives the read models.
func (s *Server) materialize(ctx context.Context) (*trace.MaterializeResult, error) {
	events, err := s.db.ListEvents(ctx)
	if err != nil {
		return nil, err
	}
	return trace.Materialize(events), nil
}

// ---- /api/version ----

// versionOut is the whole payload: the binary's build version, so the UI shows
// what is actually serving it instead of a constant compiled into the bundle.
type versionOut struct {
	Version string `json:"version"`
}

// handleVersion reports the running binary's version. It touches no database,
// so it answers even when the event store is unreadable — a UI that cannot
// load data can still say which build it is talking to.
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, versionOut{Version: buildinfo.Version()})
}

// ---- /api/workstreams ----

type workstreamOut struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	CreatedAt  string `json:"created_at"`
	EventCount int64  `json:"event_count"`
	TraceCount int    `json:"trace_count"`
}

func (s *Server) handleWorkstreams(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.ListWorkstreams(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read workstreams: "+err.Error())
		return
	}
	events, err := s.db.ListEvents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read events: "+err.Error())
		return
	}

	eventCount := map[string]int64{}
	firstSeen := map[string]int64{}
	for _, ev := range events {
		if ev.WorkstreamID == "" {
			continue
		}
		eventCount[ev.WorkstreamID]++
		at := ev.OccurredAt.UnixNano()
		if cur, ok := firstSeen[ev.WorkstreamID]; !ok || at < cur {
			firstSeen[ev.WorkstreamID] = at
		}
	}
	res := trace.Materialize(events)
	traceCount := map[string]int{}
	for _, tr := range res.Traces {
		if tr.WorkstreamID != "" {
			traceCount[tr.WorkstreamID]++
		}
	}

	// Workstreams live in a table, but events can reference workstream ids
	// that were never inserted (e.g. a plain `event import`). Those are
	// derived observations too, so they are listed — deterministically —
	// after the table rows.
	seen := map[string]bool{}
	items := make([]workstreamOut, 0, len(rows)+len(eventCount))
	for _, row := range rows {
		seen[row.ID] = true
		items = append(items, workstreamOut{
			ID:         row.ID,
			Title:      row.Title,
			Status:     row.Status,
			CreatedAt:  row.CreatedAt.UTC().Format(time.RFC3339),
			EventCount: eventCount[row.ID],
			TraceCount: traceCount[row.ID],
		})
	}
	derived := make([]string, 0)
	for id := range eventCount {
		if !seen[id] {
			derived = append(derived, id)
		}
	}
	sort.Strings(derived)
	for _, id := range derived {
		items = append(items, workstreamOut{
			ID:         id,
			Title:      workstreamTitle(events, id),
			Status:     "active",
			CreatedAt:  time.Unix(0, firstSeen[id]).UTC().Format(time.RFC3339),
			EventCount: eventCount[id],
			TraceCount: traceCount[id],
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt != items[j].CreatedAt {
			return items[i].CreatedAt < items[j].CreatedAt
		}
		return items[i].ID < items[j].ID
	})

	writeJSON(w, http.StatusOK, envelope[workstreamOut]{Items: items})
}

// workstreamTitle extracts a declared title from a workstream.started
// event, if any. Events arrive time-ordered; the first declared title wins.
func workstreamTitle(events []*protocol.Event, workstreamID string) string {
	for _, ev := range events {
		if ev.WorkstreamID != workstreamID || ev.Kind != protocol.EventWorkstreamStarted {
			continue
		}
		var payload struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal(ev.Payload, &payload); err == nil && payload.Title != "" {
			return payload.Title
		}
	}
	return ""
}

// ---- /api/traces ----

func (s *Server) handleTraces(w http.ResponseWriter, r *http.Request) {
	wsFilter := r.URL.Query().Get("workstream")
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.materialize(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read traces: "+err.Error())
		return
	}

	// Newest first, with a total-order tiebreak so the listing is a pure
	// function of the materialized result.
	traces := make([]*protocol.Trace, 0, len(res.Traces))
	for _, tr := range res.Traces {
		if wsFilter != "" && tr.WorkstreamID != wsFilter {
			continue
		}
		traces = append(traces, tr)
	}
	sort.Slice(traces, func(i, j int) bool {
		if traces[i].StartedAtNS != traces[j].StartedAtNS {
			return traces[i].StartedAtNS > traces[j].StartedAtNS
		}
		return traces[i].TraceID > traces[j].TraceID
	})

	page, next, err := paginate(traces, limit, cursor, func(tr *protocol.Trace) string { return tr.TraceID })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[*protocol.Trace]{Items: page, NextCursor: next})
}

// ---- /api/traces/{id} ----

func (s *Server) handleTraceDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	res, err := s.materialize(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read trace: "+err.Error())
		return
	}
	for _, tr := range res.Traces {
		if tr.TraceID == id {
			writeJSON(w, http.StatusOK, tr)
			return
		}
	}
	writeError(w, http.StatusNotFound, "trace not found")
}

// ---- /api/spans?trace= ----

func (s *Server) handleSpans(w http.ResponseWriter, r *http.Request) {
	traceID := r.URL.Query().Get("trace")
	if traceID == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameter: trace")
		return
	}
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.materialize(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read spans: "+err.Error())
		return
	}
	known := false
	spans := make([]*protocol.Span, 0)
	for _, sp := range res.Spans { // materializer order: sequence, started_at_ns, span_id
		if sp.TraceID != traceID {
			continue
		}
		known = true
		spans = append(spans, sp)
	}
	if !known {
		writeError(w, http.StatusNotFound, "trace not found")
		return
	}
	page, next, err := paginate(spans, limit, cursor, func(sp *protocol.Span) string { return sp.SpanID })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[*protocol.Span]{Items: page, NextCursor: next})
}

// ---- /api/scores?workstream=&target= ----

// handleScores lists the derived score read model (hfg.score.v1). Items are
// protocol.Score values verbatim, so `occurred_at` is an RFC3339 timestamp
// string (not nanoseconds like the trace/span models) and `provenance`
// carries the envelope level — an INFERRED (LLM-judge) score must render
// distinctly from an OBSERVED one.
func (s *Server) handleScores(w http.ResponseWriter, r *http.Request) {
	wsFilter := r.URL.Query().Get("workstream")
	targetFilter := r.URL.Query().Get("target")
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	events, err := s.db.ListEvents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read scores: "+err.Error())
		return
	}

	items := make([]*protocol.Score, 0)
	for _, sc := range scores.Materialize(events) {
		if wsFilter != "" && sc.WorkstreamID != wsFilter {
			continue
		}
		if targetFilter != "" && sc.TargetID != targetFilter {
			continue
		}
		items = append(items, sc)
	}
	// Newest first, with a total-order tiebreak on the score id so the
	// listing is a pure function of the reducer output (same shape as
	// /api/traces).
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i].OccurredAt.UnixNano(), items[j].OccurredAt.UnixNano()
		if a != b {
			return a > b
		}
		return items[i].ScoreID > items[j].ScoreID
	})

	page, next, err := paginate(items, limit, cursor, func(sc *protocol.Score) string { return sc.ScoreID })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[*protocol.Score]{Items: page, NextCursor: next})
}

// ---- /api/datasets ----

// datasetOut is one immutable dataset version, flattened for a list view.
//
// Datasets are content-addressed: the version string IS the content hash of
// the sorted example manifest. It is surfaced under both names so the UI can
// label identity (`version`, the value `experiment run --version` takes) and
// integrity (`content_hash`) without coupling either label to the other's
// string format.
type datasetOut struct {
	EventID      string `json:"event_id"`
	Name         string `json:"name"`
	Version      string `json:"version"`
	ExampleCount int    `json:"example_count"`
	ContentHash  string `json:"content_hash"`
	CreatedAt    string `json:"created_at"`
}

func (s *Server) handleDatasets(w http.ResponseWriter, r *http.Request) {
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	events, err := s.db.ListEvents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read datasets: "+err.Error())
		return
	}
	records := datasets.Materialize(events) // ascending (created_at, event_id)
	items := make([]datasetOut, 0, len(records))
	for _, rec := range records {
		items = append(items, datasetOut{
			EventID:      rec.EventID,
			Name:         rec.Name,
			Version:      rec.Version,
			ExampleCount: len(rec.Files),
			ContentHash:  rec.Version,
			CreatedAt:    rec.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	// Versions of one dataset group together in creation order; the event id
	// breaks any remaining tie into a total order.
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		if items[i].CreatedAt != items[j].CreatedAt {
			return items[i].CreatedAt < items[j].CreatedAt
		}
		return items[i].EventID < items[j].EventID
	})

	page, next, err := paginate(items, limit, cursor, func(d datasetOut) string { return d.EventID })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[datasetOut]{Items: page, NextCursor: next})
}

// ---- /api/experiments?dataset= ----

// experimentOut is one recorded experiment run. The pass/fail counts are the
// per-example verdicts (`ok` vs everything else); `passed` is the run-level
// gate the CLI exits non-zero on.
type experimentOut struct {
	ID           string `json:"id"`
	Dataset      string `json:"dataset"`
	Version      string `json:"version"`
	Passed       bool   `json:"passed"`
	PassedCount  int    `json:"passed_count"`
	FailedCount  int    `json:"failed_count"`
	ExampleCount int    `json:"example_count"`
	CreatedAt    string `json:"created_at"`
}

func experimentRow(rec datasets.ExperimentRecord) experimentOut {
	out := experimentOut{
		ID:           rec.EventID,
		Dataset:      rec.Dataset,
		Version:      rec.Version,
		Passed:       rec.Passed,
		ExampleCount: len(rec.Results),
		CreatedAt:    rec.CreatedAt.UTC().Format(time.RFC3339),
	}
	for _, res := range rec.Results {
		if res.Status == "ok" {
			out.PassedCount++
		} else {
			out.FailedCount++
		}
	}
	return out
}

func (s *Server) handleExperiments(w http.ResponseWriter, r *http.Request) {
	dsFilter := r.URL.Query().Get("dataset")
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	runs, err := s.experimentRuns(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read experiments: "+err.Error())
		return
	}
	items := make([]experimentOut, 0, len(runs))
	for _, rec := range runs {
		if dsFilter != "" && rec.Dataset != dsFilter {
			continue
		}
		items = append(items, experimentRow(rec))
	}
	// Newest first with a total-order tiebreak: the comparison view reads
	// the most recent run as the candidate against an older baseline.
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt != items[j].CreatedAt {
			return items[i].CreatedAt > items[j].CreatedAt
		}
		return items[i].ID > items[j].ID
	})

	page, next, err := paginate(items, limit, cursor, func(e experimentOut) string { return e.ID })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[experimentOut]{Items: page, NextCursor: next})
}

func (s *Server) experimentRuns(ctx context.Context) ([]datasets.ExperimentRecord, error) {
	events, err := s.db.ListEvents(ctx)
	if err != nil {
		return nil, err
	}
	return datasets.MaterializeExperiments(events), nil
}

// ---- /api/experiments/compare?a=&b= ----

// compareOut is the regression diff between two runs. It is the exact result
// of datasets.Compare — the same function `handoffgraph experiment compare`
// calls — so the UI and the CLI can never disagree about what regressed.
// Items lists only examples present in both runs (an example that only exists
// on one side is not a regression, it is a different dataset version).
type compareOut struct {
	A           experimentOut         `json:"a"`
	B           experimentOut         `json:"b"`
	Regressions int                   `json:"regressions"`
	Items       []datasets.Comparison `json:"items"`
}

func (s *Server) handleExperimentCompare(w http.ResponseWriter, r *http.Request) {
	aID := r.URL.Query().Get("a")
	bID := r.URL.Query().Get("b")
	if aID == "" || bID == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameters: a and b")
		return
	}
	runs, err := s.experimentRuns(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read experiments: "+err.Error())
		return
	}
	var a, b *datasets.ExperimentRecord
	for i := range runs {
		if runs[i].EventID == aID {
			a = &runs[i]
		}
		if runs[i].EventID == bID {
			b = &runs[i]
		}
	}
	if a == nil || b == nil {
		writeError(w, http.StatusNotFound, "experiment run(s) not found")
		return
	}
	items := datasets.Compare(*a, *b) // sorted by example name
	regressions := 0
	for _, c := range items {
		if c.Regression {
			regressions++
		}
	}
	writeJSON(w, http.StatusOK, compareOut{
		A:           experimentRow(*a),
		B:           experimentRow(*b),
		Regressions: regressions,
		Items:       items,
	})
}

// ---- /api/prompts ----

// promptLabelOut is one resolved label pointer. `latest` is always present
// once a prompt has any version, even when it was never labeled explicitly.
type promptLabelOut struct {
	Label   string `json:"label"`
	Version int    `json:"version"`
}

// promptVersionRef is one immutable version without its body: the list view
// shows the version ladder, /api/prompts/show returns the body.
type promptVersionRef struct {
	Version   int    `json:"version"`
	Hash      string `json:"hash"`
	CreatedAt string `json:"created_at"`
	CreatedBy string `json:"created_by,omitempty"`
}

type promptOut struct {
	Name            string             `json:"name"`
	VersionCount    int                `json:"version_count"`
	LatestVersion   int                `json:"latest_version"`
	LatestHash      string             `json:"latest_hash"`
	LatestCreatedAt string             `json:"latest_created_at"`
	Labels          []promptLabelOut   `json:"labels"`
	Versions        []promptVersionRef `json:"versions"`
}

// promptRows flattens the derived prompt map into a name-sorted slice. Label
// maps are flattened by sorted label name so the response is byte-stable.
func promptRows(byName map[string]*prompts.Prompt) []promptOut {
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)

	rows := make([]promptOut, 0, len(names))
	for _, name := range names {
		p := byName[name]
		row := promptOut{
			Name:          name,
			VersionCount:  len(p.Versions),
			LatestVersion: p.Latest(),
			Labels:        make([]promptLabelOut, 0, len(p.Labels)+1),
			Versions:      make([]promptVersionRef, 0, len(p.Versions)),
		}
		for _, v := range p.Versions { // reducer order: ascending version
			row.Versions = append(row.Versions, promptVersionRef{
				Version:   v.Version,
				Hash:      v.Hash,
				CreatedAt: v.CreatedAt.UTC().Format(time.RFC3339),
				CreatedBy: v.CreatedBy,
			})
			if v.Version == row.LatestVersion {
				row.LatestHash = v.Hash
				row.LatestCreatedAt = v.CreatedAt.UTC().Format(time.RFC3339)
			}
		}
		resolved := p.Resolve()
		labels := make([]string, 0, len(resolved))
		for label := range resolved {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		for _, label := range labels {
			row.Labels = append(row.Labels, promptLabelOut{Label: label, Version: resolved[label]})
		}
		rows = append(rows, row)
	}
	return rows
}

func (s *Server) handlePrompts(w http.ResponseWriter, r *http.Request) {
	limit, cursor, err := pageParams(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	events, err := s.db.ListEvents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read prompts: "+err.Error())
		return
	}
	items := promptRows(prompts.Materialize(events))
	page, next, err := paginate(items, limit, cursor, func(p promptOut) string { return p.Name })
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope[promptOut]{Items: page, NextCursor: next})
}

// ---- /api/prompts/show?name=&version= ----

// promptBodyOut is one prompt version with its body. Bodies were size-capped
// when the version was created, so this response is bounded; the UI renders
// it as preformatted text without interpreting it.
type promptBodyOut struct {
	Name          string   `json:"name"`
	Version       int      `json:"version"`
	Body          string   `json:"body"`
	Hash          string   `json:"hash"`
	CreatedAt     string   `json:"created_at"`
	CreatedBy     string   `json:"created_by,omitempty"`
	Labels        []string `json:"labels"`
	LatestVersion int      `json:"latest_version"`
	VersionCount  int      `json:"version_count"`
}

func (s *Server) handlePromptShow(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameter: name")
		return
	}
	want := 0 // 0 means "whatever `latest` resolves to"
	if raw := r.URL.Query().Get("version"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid version %q", raw))
			return
		}
		want = n
	}
	events, err := s.db.ListEvents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read prompt: "+err.Error())
		return
	}
	p, ok := prompts.Materialize(events)[name]
	if !ok {
		writeError(w, http.StatusNotFound, "prompt not found")
		return
	}
	resolved := p.Resolve()
	if want == 0 {
		want = resolved[prompts.LabelLatest]
	}
	idx := -1
	for i := range p.Versions {
		if p.Versions[i].Version == want {
			idx = i
		}
	}
	if idx < 0 {
		writeError(w, http.StatusNotFound, "prompt version not found")
		return
	}
	v := p.Versions[idx]

	labels := make([]string, 0, len(resolved))
	for label, version := range resolved {
		if version == v.Version {
			labels = append(labels, label)
		}
	}
	sort.Strings(labels)

	writeJSON(w, http.StatusOK, promptBodyOut{
		Name:          p.Name,
		Version:       v.Version,
		Body:          v.Body,
		Hash:          v.Hash,
		CreatedAt:     v.CreatedAt.UTC().Format(time.RFC3339),
		CreatedBy:     v.CreatedBy,
		Labels:        labels,
		LatestVersion: p.Latest(),
		VersionCount:  len(p.Versions),
	})
}

// ---- static bundle ----

// handleStatic serves the embedded bundle. Directories are never listed:
// only regular files are served, and client routes (paths without a file
// extension) fall back to index.html for the hash router. Anything else
// under /api returns a JSON 404 rather than HTML.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "unknown API endpoint")
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	if s.static != nil {
		if st, err := fs.Stat(s.static, name); err == nil && st.Mode().IsRegular() {
			// The path is constrained to a regular file, so the standard
			// file server cannot produce a directory listing here.
			http.FileServerFS(s.static).ServeHTTP(w, r)
			return
		}
	}
	// Asset-shaped paths (with an extension) 404 instead of falling back,
	// so a missing asset is visible rather than masked by HTML. The app
	// entry point itself is not asset-shaped.
	if name != "index.html" && path.Ext(name) != "" {
		http.NotFound(w, r)
		return
	}
	s.serveIndex(w, r)
}

// serveIndex serves the app entry point: the embedded index.html when a
// built bundle is available, otherwise the inline placeholder page.
func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	if s.static != nil {
		if data, err := fs.ReadFile(s.static, "index.html"); err == nil {
			serveHTML(w, string(data))
			return
		}
	}
	serveHTML(w, placeholderPage)
}

func serveHTML(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, body)
}
