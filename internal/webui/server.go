// Package webui serves the v0.5.0 local session debugger: an embedded
// React bundle plus read-only JSON APIs over the local event store.
//
// The server is localhost-only by design and never mutates the database.
// All API responses are derived read models (hfg.trace.v1) materialized
// deterministically from the ordered event log, and every list response
// uses a cursor-friendly envelope ({"items": [...], "next_cursor": ""}).
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

	"github.com/handoffgraph/handoffgraph/internal/protocol"
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
