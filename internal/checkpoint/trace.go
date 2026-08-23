package checkpoint

import (
	"context"
	"fmt"
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// TraceBuildOptions configures a checkpoint built from one selected turn
// trace. Events is the append-only event log; only evidence belonging to the
// selected trace is passed to the ordinary deterministic checkpoint builder.
type TraceBuildOptions struct {
	TraceID   string
	Objective string
	Status    string
	Repo      *repository.RepoState
	Events    []*protocol.Event
	Redaction *redact.Options
}

// BuildFromTrace turns one materialized trace into a portable checkpoint.
// It deliberately excludes evidence from neighboring traces, even when they
// share a workstream and native session. This is the evidence-selection step
// behind `checkpoint --from-trace <id>`.
func BuildFromTrace(ctx context.Context, opts TraceBuildOptions) (*protocol.Checkpoint, error) {
	if opts.TraceID == "" {
		return nil, fmt.Errorf("trace_id is required")
	}
	materialized := trace.Materialize(opts.Events)
	var selected *protocol.Trace
	for _, candidate := range materialized.Traces {
		if candidate.TraceID == opts.TraceID {
			selected = candidate
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("trace %s not found", opts.TraceID)
	}
	if selected.WorkstreamID == "" {
		return nil, fmt.Errorf("trace %s has no workstream id", opts.TraceID)
	}

	events := eventsForTrace(opts.Events, materialized, selected)
	if len(events) == 0 {
		return nil, fmt.Errorf("trace %s has no selectable evidence", opts.TraceID)
	}
	objective := opts.Objective
	if objective == "" {
		objective = selected.ObjectiveExcerpt
	}
	return Build(ctx, BuildOptions{
		WorkstreamID: selected.WorkstreamID,
		Objective:    objective,
		Status:       opts.Status,
		Repo:         opts.Repo,
		Events:       events,
		Redaction:    opts.Redaction,
	})
}

// eventsForTrace selects source events for target. Explicit trace/span links
// win. For provider events that do not carry those links, a conservative
// fallback admits only checkpoint-relevant evidence in the same session and
// trace time window. The next trace start is an exclusive upper bound for a
// still-running trace, preventing evidence from a neighboring turn leaking in.
func eventsForTrace(events []*protocol.Event, materialized *trace.MaterializeResult, target *protocol.Trace) []*protocol.Event {
	spanIDs := make(map[string]bool)
	for _, span := range materialized.Spans {
		if span.TraceID == target.TraceID && span.SpanID != "" {
			spanIDs[span.SpanID] = true
		}
	}

	var nextStart int64
	for _, candidate := range materialized.Traces {
		if candidate.TraceID == target.TraceID || candidate.SessionID != target.SessionID || candidate.StartedAtNS <= target.StartedAtNS {
			continue
		}
		if nextStart == 0 || candidate.StartedAtNS < nextStart {
			nextStart = candidate.StartedAtNS
		}
	}

	// Preserve the latest native-session identity observed before this trace.
	// Trace/span events commonly omit NativeSessionID; without this anchor the
	// resulting checkpoint cannot take the same-provider native-resume path.
	var sessionIdentity *protocol.Event
	for _, ev := range events {
		if ev == nil || ev.SessionID != target.SessionID || ev.NativeSessionID == "" {
			continue
		}
		if ev.Kind != protocol.EventSessionStarted && ev.Kind != protocol.EventSessionResumed {
			continue
		}
		if ev.OccurredAt.UnixNano() > target.StartedAtNS {
			continue
		}
		if sessionIdentity == nil || eventOrderLess(sessionIdentity, ev) {
			sessionIdentity = ev
		}
	}

	out := make([]*protocol.Event, 0)
	if sessionIdentity != nil {
		out = append(out, sessionIdentity)
	}
	for _, ev := range events {
		if ev == nil {
			continue
		}
		if sessionIdentity != nil && ev.EventID == sessionIdentity.EventID {
			continue
		}
		if target.WorkstreamID != "" && ev.WorkstreamID != "" && ev.WorkstreamID != target.WorkstreamID {
			continue
		}
		explicit := payloadStr(ev, "trace_id", "") == target.TraceID
		spanID := payloadStr(ev, "span_id", "")
		if spanIDs[spanID] || spanIDs[ev.EventID] {
			explicit = true
		}
		if !explicit && !(checkpointEvidenceKind(ev.Kind) && eventInTraceWindow(ev, target, nextStart)) {
			continue
		}
		out = append(out, ev)
	}

	// Callers normally pass storage.ListEvents order, but keep this API a
	// deterministic pure function for arbitrary callers too.
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].OccurredAt.Equal(out[j].OccurredAt) {
			return out[i].OccurredAt.Before(out[j].OccurredAt)
		}
		if out[i].Sequence != out[j].Sequence {
			return out[i].Sequence < out[j].Sequence
		}
		return out[i].EventID < out[j].EventID
	})
	return out
}

// eventOrderLess applies the same total order used for selected output.
func eventOrderLess(a, b *protocol.Event) bool {
	if !a.OccurredAt.Equal(b.OccurredAt) {
		return a.OccurredAt.Before(b.OccurredAt)
	}
	if a.Sequence != b.Sequence {
		return a.Sequence < b.Sequence
	}
	return a.EventID < b.EventID
}

func eventInTraceWindow(ev *protocol.Event, target *protocol.Trace, nextStart int64) bool {
	if target.SessionID != "" && ev.SessionID != target.SessionID {
		return false
	}
	at := ev.OccurredAt.UnixNano()
	if at < target.StartedAtNS {
		return false
	}
	if target.EndedAtNS > 0 && at > target.EndedAtNS {
		return false
	}
	if nextStart > 0 && at >= nextStart {
		return false
	}
	return true
}

func checkpointEvidenceKind(kind protocol.EventKind) bool {
	switch kind {
	case protocol.EventTraceStarted,
		protocol.EventTraceCompleted,
		protocol.EventTraceInterrupted,
		protocol.EventSpanStarted,
		protocol.EventSpanCompleted,
		protocol.EventSpanFailed,
		protocol.EventFileCreated,
		protocol.EventFileEdited,
		protocol.EventFileDeleted,
		protocol.EventCommandCompleted,
		protocol.EventTestCompleted,
		protocol.EventDecisionRecorded,
		protocol.EventErrorObserved,
		protocol.EventVerificationRecorded:
		return true
	default:
		return false
	}
}
