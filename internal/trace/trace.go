// Package trace materializes the bounded turn-trace and span read models from
// raw events. The materializer is deterministic: identical events produce
// identical traces and spans, which supports rebuild-verification.
package trace

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// MaterializeResult holds the derived traces and spans for a workstream.
type MaterializeResult struct {
	Traces []*protocol.Trace `json:"traces"`
	Spans  []*protocol.Span  `json:"spans"`
}

// Materialize derives turn traces and spans from the event log.
//
// Turn boundaries are detected from trace.started/trace.completed and
// trace.interrupted events. Spans come from span.started/span.completed plus
// command/test/file events, which are promoted to spans so evidence such as a
// failing test or a non-zero command exit is visible in the trace. Orphan
// spans (a completion without a start) are preserved with best-effort status
// rather than discarded.
func Materialize(events []*protocol.Event) *MaterializeResult {
	res := &MaterializeResult{}

	traces := map[string]*protocol.Trace{}
	spans := map[string]*protocol.Span{}

	// First pass: create traces and span starts.
	for _, ev := range events {
		switch ev.Kind {
		case protocol.EventTraceStarted:
			tr := &protocol.Trace{
				SchemaVersion:     protocol.SchemaVersionTrace,
				TraceID:           payloadString(ev, "trace_id", fallbackID(ev)),
				WorkstreamID:      ev.WorkstreamID,
				SessionID:         ev.SessionID,
				Provider:          ev.Provider,
				Status:            protocol.TraceRunning,
				StartedAtNS:       ev.OccurredAt.UnixNano(),
				VerificationState: protocol.VerificationUnknown,
				ObjectiveExcerpt:  payloadString(ev, "objective", ""),
			}
			if tr.TraceID == "" {
				tr.TraceID = ev.EventID
			}
			traces[tr.TraceID] = tr
		case protocol.EventSpanStarted:
			sp := spanFromEvent(ev)
			sp.Status = "running"
			spans[sp.SpanID] = sp
		}
	}

	// Second pass: process completions, failures, and evidence events.
	for _, ev := range events {
		switch ev.Kind {
		case protocol.EventTraceCompleted:
			if tr := traceFor(ev, traces); tr != nil {
				tr.Status = protocol.TraceOK
				tr.EndedAtNS = ev.OccurredAt.UnixNano()
				tr.DurationNS = tr.EndedAtNS - tr.StartedAtNS
			}
		case protocol.EventTraceInterrupted:
			if tr := traceFor(ev, traces); tr != nil {
				tr.Status = protocol.TraceInterrupted
				tr.EndedAtNS = ev.OccurredAt.UnixNano()
				tr.DurationNS = tr.EndedAtNS - tr.StartedAtNS
			}
		case protocol.EventSessionCompacted:
			for _, tr := range traces {
				if tr.Status == protocol.TraceRunning {
					tr.Status = protocol.TraceCompacted
				}
			}
		case protocol.EventSpanCompleted, protocol.EventSpanFailed:
			id := payloadString(ev, "span_id", firstParent(ev))
			sp := spans[id]
			if sp == nil {
				// Orphan completion: synthesize a span so evidence is preserved.
				sp = spanFromEvent(ev)
				sp.Status = "unknown"
				spans[sp.SpanID] = sp
			}
			sp.EndedAtNS = ev.OccurredAt.UnixNano()
			if ev.Kind == protocol.EventSpanFailed {
				sp.Status = "error"
			} else {
				sp.Status = "ok"
			}
			sp.ExitCode = payloadInt(ev, "exit_code")
		case protocol.EventCommandCompleted:
			id := payloadString(ev, "span_id", ev.EventID)
			sp := spans[id]
			if sp == nil {
				sp = spanFromEvent(ev)
				sp.Kind = protocol.SpanKindCommand
				sp.Status = "unknown"
				spans[id] = sp
			}
			sp.EndedAtNS = ev.OccurredAt.UnixNano()
			sp.ExitCode = payloadInt(ev, "exit_code")
			sp.Name = payloadString(ev, "command", sp.Name)
			if sp.ExitCode != nil && *sp.ExitCode != 0 {
				sp.Status = "error"
			} else {
				sp.Status = "ok"
			}
		case protocol.EventTestCompleted:
			id := payloadString(ev, "span_id", ev.EventID)
			sp := spans[id]
			if sp == nil {
				sp = spanFromEvent(ev)
				sp.Kind = protocol.SpanKindTest
				sp.Status = "unknown"
				spans[id] = sp
			}
			sp.EndedAtNS = ev.OccurredAt.UnixNano()
			sp.ExitCode = payloadInt(ev, "exit_code")
			sp.Name = payloadString(ev, "name", sp.Name)
			result := payloadString(ev, "result", "")
			if result == "failed" || (sp.ExitCode != nil && *sp.ExitCode != 0) {
				sp.Status = "error"
			} else {
				sp.Status = "ok"
			}
		}
	}

	// Attach spans to traces and compute counters. Spans whose trace_id is
	// empty or not a known trace are re-resolved to their session's most
	// recent running trace (or any trace for that session) so evidence from
	// partial/real hook input is not lost.
	for _, sp := range spans {
		tr := traces[sp.TraceID]
		if tr == nil {
			tr = resolveTraceForSpan(sp, traces)
			if tr != nil {
				sp.TraceID = tr.TraceID
			}
		}
		if tr == nil {
			continue
		}
		if sp.Status == "error" || sp.Status == "failed" {
			tr.FailedSpanCount++
		}
		tr.SpanCount++
		switch sp.Kind {
		case protocol.SpanKindFileWrite, protocol.SpanKindFileRead:
			tr.ChangedFileCount++
		case protocol.SpanKindTest:
			if sp.Status == "error" {
				tr.VerificationState = protocol.VerificationFailed
			} else if tr.VerificationState == protocol.VerificationUnknown {
				tr.VerificationState = protocol.VerificationVerified
			}
		}
		if tr.RootSpanID == "" && sp.ParentSpanID == "" {
			tr.RootSpanID = sp.SpanID
		}
	}

	// Order output deterministically.
	for _, tr := range traces {
		res.Traces = append(res.Traces, tr)
	}
	for _, sp := range spans {
		res.Spans = append(res.Spans, sp)
	}
	sort.Slice(res.Traces, func(i, j int) bool { return res.Traces[i].StartedAtNS < res.Traces[j].StartedAtNS })
	// Span order is a total order on (Sequence, StartedAtNS, SpanID): a pure
	// function of the spans themselves, so zero-valued Sequence/StartedAtNS
	// (common in fixtures) still sort deterministically by SpanID.
	sort.Slice(res.Spans, func(i, j int) bool {
		if res.Spans[i].Sequence != res.Spans[j].Sequence {
			return res.Spans[i].Sequence < res.Spans[j].Sequence
		}
		if res.Spans[i].StartedAtNS != res.Spans[j].StartedAtNS {
			return res.Spans[i].StartedAtNS < res.Spans[j].StartedAtNS
		}
		return res.Spans[i].SpanID < res.Spans[j].SpanID
	})
	return res
}

func spanFromEvent(ev *protocol.Event) *protocol.Span {
	kind := protocol.SpanKind(payloadString(ev, "kind", string(protocol.SpanKindOther)))
	return &protocol.Span{
		SpanID:              payloadString(ev, "span_id", ev.EventID),
		TraceID:             payloadString(ev, "trace_id", ev.SessionID),
		SessionID:           ev.SessionID,
		ParentSpanID:        firstParent(ev),
		SourceSpanID:        payloadString(ev, "source_span_id", ""),
		Kind:                kind,
		SourceKind:          payloadString(ev, "source_kind", ""),
		Name:                payloadString(ev, "name", string(ev.Kind)),
		StartedAtNS:         ev.OccurredAt.UnixNano(),
		Sequence:            ev.Sequence,
		Provider:            ev.Provider,
		Model:               ev.Model,
		ToolName:            payloadString(ev, "tool_name", ""),
		EvidenceLevel:       protocol.Provenance(ev.Provenance),
		NormalizerVersion:   "v1",
		SourceSchemaVersion: ev.SchemaVersion,
	}
}

func traceFor(ev *protocol.Event, traces map[string]*protocol.Trace) *protocol.Trace {
	id := payloadString(ev, "trace_id", "")
	if tr, ok := traces[id]; ok {
		return tr
	}
	// Fallback: latest trace in the same session.
	var best *protocol.Trace
	for _, tr := range traces {
		if tr.SessionID == ev.SessionID && tr.Status == protocol.TraceRunning {
			if best == nil || tr.StartedAtNS > best.StartedAtNS {
				best = tr
			}
		}
	}
	return best
}

// resolveTraceForSpan finds the trace a span belongs to when its trace_id is
// missing or unknown. It prefers the most recent running trace for the span's
// session; if none is running, it falls back to the latest trace for that
// session. The span carries no session_id directly, so we look up by the
// provider session id recorded at span creation.
func resolveTraceForSpan(sp *protocol.Span, traces map[string]*protocol.Trace) *protocol.Trace {
	if sp.TraceID != "" {
		if tr, ok := traces[sp.TraceID]; ok {
			return tr
		}
	}
	// Spans inherit their session via their trace_id normally; when absent,
	// match by session id first, then by provider.
	var best *protocol.Trace
	for _, tr := range traces {
		if sp.SessionID != "" && tr.SessionID == sp.SessionID {
			if best == nil || tr.StartedAtNS > best.StartedAtNS {
				best = tr
			}
		}
	}
	if best != nil {
		return best
	}
	for _, tr := range traces {
		if tr.Provider != "" && sp.Provider != "" && tr.Provider != sp.Provider {
			continue
		}
		if best == nil || tr.StartedAtNS > best.StartedAtNS {
			best = tr
		}
	}
	return best
}

func firstParent(ev *protocol.Event) string {
	if len(ev.ParentEventIDs) > 0 {
		return ev.ParentEventIDs[0]
	}
	return ""
}

func fallbackID(ev *protocol.Event) string {
	if ev.SessionID != "" {
		return ev.SessionID
	}
	return ev.EventID
}

func payloadString(ev *protocol.Event, key, def string) string {
	if len(ev.Payload) == 0 {
		return def
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return def
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}

func payloadInt(ev *protocol.Event, key string) *int {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	switch v := m[key].(type) {
	case float64:
		i := int(v)
		return &i
	case int:
		return &v
	}
	return nil
}

// Validate reports whether a materialized result is well-formed.
func (r *MaterializeResult) Validate() error {
	for _, tr := range r.Traces {
		if tr.TraceID == "" {
			return fmt.Errorf("trace with empty id")
		}
	}
	seen := map[string]bool{}
	for _, sp := range r.Spans {
		if sp.SpanID == "" {
			return fmt.Errorf("span with empty id")
		}
		if seen[sp.SpanID] {
			return fmt.Errorf("duplicate span %q", sp.SpanID)
		}
		seen[sp.SpanID] = true
	}
	return nil
}
