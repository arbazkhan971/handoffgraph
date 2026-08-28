package otlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// defaultMaxInFlight bounds concurrent export processing. SQLite is a
// single writer; beyond a small number of concurrent exports every extra
// request only piles up memory, so answer 429 + Retry-After (the OTLP
// contract for throttling) instead of queueing without bound.
const defaultMaxInFlight = 4

// maxRequestBytes bounds one OTLP/JSON export body.
const maxRequestBytes = 64 << 20 // 64 MiB

// AppendFunc persists converted events. Returning an error aborts the
// remaining appends of the request and surfaces as a 500; duplicates are
// reported by the bool return (idempotent re-import) and simply counted.
type AppendFunc func(ctx context.Context, ev *protocol.Event) (appended bool, err error)

// Handler serves the OTLP/HTTP JSON ingest endpoint:
//
//	POST /v1/traces   (application/json, ExportTraceServiceRequest)
//	GET  /healthz
//
// The handler binds to whatever address the caller chooses; the CLI binds it
// to localhost by default so telemetry never leaves the machine unasked.
type Handler struct {
	Append AppendFunc
	// WorkstreamID attaches imported events to a workstream when non-empty.
	WorkstreamID string
	// ObservedAt overrides the capture timestamp (tests); zero means now.
	ObservedAt func() time.Time
	// CaptureTier gates attribute content at emit time. Empty = full.
	CaptureTier CaptureTier
	// MaxInFlight bounds concurrent exports; 0 means defaultMaxInFlight.
	MaxInFlight int64

	inFlight atomic.Int64
}

// exportResponse is the ExportTraceServiceResponse body.
type exportResponse struct {
	PartialSuccess *partialSuccess `json:"partialSuccess,omitempty"`
}

type partialSuccess struct {
	RejectedSpans int64  `json:"rejectedSpans"`
	ErrorMessage  string `json:"errorMessage,omitempty"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
		return
	case "/v1/traces":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "OTLP export requires POST", http.StatusMethodNotAllowed)
			return
		}
		h.serveTraces(w, r)
		return
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveTraces(w http.ResponseWriter, r *http.Request) {
	max := h.MaxInFlight
	if max <= 0 {
		max = defaultMaxInFlight
	}
	if h.inFlight.Load() >= max {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "ingest saturated; retry after 1s", http.StatusTooManyRequests)
		return
	}
	h.inFlight.Add(1)
	defer h.inFlight.Add(-1)

	ct := r.Header.Get("Content-Type")
	mediaType := strings.TrimSpace(strings.SplitN(ct, ";", 2)[0])
	switch mediaType {
	case "application/json", "":
		// The OTLP/HTTP JSON flavor; an absent content type is accepted
		// leniently because single-binary emitters often omit it.
	case "application/x-protobuf":
		http.Error(w, "protobuf OTLP is not accepted yet; send OTLP/JSON (application/json)", http.StatusUnsupportedMediaType)
		return
	default:
		http.Error(w, fmt.Sprintf("unsupported content type %q; send OTLP/JSON (application/json)", mediaType), http.StatusUnsupportedMediaType)
		return
	}

	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	var req ExportRequest
	dec := json.NewDecoder(body)
	if err := dec.Decode(&req); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, fmt.Sprintf("request body exceeds %d bytes", maxRequestBytes), http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, fmt.Sprintf("invalid OTLP/JSON: %v", err), http.StatusBadRequest)
		return
	}

	var observedAt time.Time
	if h.ObservedAt != nil {
		observedAt = h.ObservedAt()
	}
	result, err := Convert(&req, Options{WorkstreamID: h.WorkstreamID, ObservedAt: observedAt, CaptureTier: h.CaptureTier})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	appended := int64(0)
	for _, ev := range result.Events {
		inserted, err := h.Append(r.Context(), ev)
		if err != nil {
			http.Error(w, fmt.Sprintf("persist %s: %v", ev.EventID, err), http.StatusInternalServerError)
			return
		}
		if inserted {
			appended++
		}
	}

	resp := exportResponse{}
	rejected := int64(len(result.SpanErrors))
	if rejected > 0 {
		msgs := make([]string, 0, len(result.SpanErrors))
		for _, se := range result.SpanErrors {
			msgs = append(msgs, fmt.Sprintf("span %s: %v", se.SpanID, se.Err))
		}
		resp.PartialSuccess = &partialSuccess{
			RejectedSpans: rejected,
			ErrorMessage:  strings.Join(msgs, "; "),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
