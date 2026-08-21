// Package fixture provides the synthetic event generator used by tests and
// `handoffgraph fixture verify`. It has no dependencies on storage or graph
// so it can be imported freely by those packages' tests without a cycle.
package fixture

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// t0 is a fixed reference time so synthetic fixtures are deterministic.
func t0() time.Time {
	return time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
}

// GenerateSynthetic produces n deterministic synthetic events forming a
// workstream with sessions, traces, spans, commands, tests, and a failure.
// It is used for the 10,000-event ingestion benchmark and determinism tests.
//
// Event count = 3 (workstream/session/trace) + 1 (agent span) + 2*n
// (span start + command complete) + 1 (failing test) = 5 + 2n.
func GenerateSynthetic(n int) []*protocol.Event {
	ws := ids.Workstream()
	session := ids.Session()
	traceID := ids.Trace()

	events := []*protocol.Event{
		{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    t0(),
			ObservedAt:    t0(),
			WorkstreamID:  ws,
			Kind:          protocol.EventWorkstreamStarted,
			Provenance:    protocol.ProvenanceObserved,
		},
		{
			SchemaVersion:   protocol.SchemaVersionEvent,
			EventID:         ids.Event(),
			OccurredAt:      t0(),
			ObservedAt:      t0(),
			WorkstreamID:    ws,
			SessionID:       session,
			NativeSessionID: "synthetic-session",
			Provider:        protocol.ProviderCodex,
			Kind:            protocol.EventSessionStarted,
			Provenance:      protocol.ProvenanceObserved,
		},
		{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    t0(),
			ObservedAt:    t0(),
			WorkstreamID:  ws,
			SessionID:     session,
			Provider:      protocol.ProviderCodex,
			Kind:          protocol.EventTraceStarted,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       mustJSON(map[string]any{"trace_id": traceID}),
		},
	}

	parent := ids.Span()
	events = append(events, &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    t0(),
		ObservedAt:    t0(),
		WorkstreamID:  ws,
		SessionID:     session,
		Provider:      protocol.ProviderCodex,
		Kind:          protocol.EventSpanStarted,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       mustJSON(map[string]any{"span_id": parent, "trace_id": traceID, "kind": "AGENT", "name": "synthetic-agent"}),
	})

	for i := 0; i < n; i++ {
		spanID := ids.Span()
		events = append(events, &protocol.Event{
			SchemaVersion:  protocol.SchemaVersionEvent,
			EventID:        ids.Event(),
			Sequence:       int64(i),
			OccurredAt:     t0(),
			ObservedAt:     t0(),
			WorkstreamID:   ws,
			SessionID:      session,
			Provider:       protocol.ProviderCodex,
			Kind:           protocol.EventSpanStarted,
			Provenance:     protocol.ProvenanceObserved,
			ParentEventIDs: []string{parent},
			Payload: mustJSON(map[string]any{
				"span_id": spanID, "trace_id": traceID,
				"kind": "COMMAND", "name": fmt.Sprintf("command-%d", i),
			}),
		})
		events = append(events, &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			Sequence:      int64(i),
			OccurredAt:    t0(),
			ObservedAt:    t0(),
			WorkstreamID:  ws,
			SessionID:     session,
			Provider:      protocol.ProviderCodex,
			Kind:          protocol.EventCommandCompleted,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       mustJSON(map[string]any{"span_id": spanID, "trace_id": traceID, "command": fmt.Sprintf("run-%d", i), "exit_code": 0}),
		})
	}

	// A failing test to exercise verification state.
	failSpan := ids.Span()
	events = append(events, &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    t0(),
		ObservedAt:    t0(),
		WorkstreamID:  ws,
		SessionID:     session,
		Provider:      protocol.ProviderCodex,
		Kind:          protocol.EventTestCompleted,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       mustJSON(map[string]any{"span_id": failSpan, "trace_id": traceID, "name": "synthetic-test", "result": "failed", "exit_code": 1}),
	})

	return events
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
