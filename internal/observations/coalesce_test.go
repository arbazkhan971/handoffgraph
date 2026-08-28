package observations

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file cover parity-plan row 5 (signal-source coalescing)
// and row 12 (typed attribute promotion) end to end through DeriveAll.

var coalesceBase = time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)

// pipeline describes one way a session reached us.
type pipeline struct {
	provider  string
	agent     string
	sessionID string
	traceID   string
	spanPfx   string
	attrs     map[string]any
}

// nativePipeline / hookPipeline / sdkPipeline are the three real-world
// sources of one claude-code run: the vendor's own OTel export, our hook
// adapter, and a third-party SDK wrapper.
func nativePipeline() pipeline {
	return pipeline{
		provider: protocol.ProviderOTLP, agent: "claude-code",
		sessionID: "ses_native", traceID: "trc_native", spanPfx: "spn_native",
		attrs: map[string]any{
			"otlp.scope.name":      "com.anthropic.claude_code",
			"gen_ai.request.model": "claude-opus",
		},
	}
}

func hookPipeline() pipeline {
	return pipeline{
		provider: protocol.ProviderClaude, agent: "claude-code",
		sessionID: "ses_hook", traceID: "trc_hook", spanPfx: "spn_hook",
	}
}

func sdkPipeline() pipeline {
	return pipeline{
		provider: protocol.ProviderOTLP, agent: "claude-code",
		sessionID: "ses_sdk", traceID: "trc_sdk", spanPfx: "spn_sdk",
		attrs: map[string]any{"telemetry.sdk.name": "opentelemetry"},
	}
}

func mustPayload(t *testing.T, m map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func pipeEvent(t *testing.T, p pipeline, nativeSession string, seq int64,
	kind protocol.EventKind, at time.Time, payload map[string]any) *protocol.Event {
	t.Helper()
	return &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         ids.Event(),
		Sequence:        seq,
		OccurredAt:      at,
		ObservedAt:      at,
		WorkstreamID:    "ws_coalesce",
		SessionID:       p.sessionID,
		NativeSessionID: nativeSession,
		Provider:        p.provider,
		Agent:           p.agent,
		Model:           "claude-opus",
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         mustPayload(t, payload),
	}
}

// pipelineEvents emits one trace with a single TOOL span named "Bash",
// started at the same instant in every pipeline: the same logical span seen
// more than once.
func pipelineEvents(t *testing.T, p pipeline, nativeSession string) []*protocol.Event {
	t.Helper()
	span := p.spanPfx + "_bash"
	end := map[string]any{"span_id": span, "trace_id": p.traceID}
	if p.attrs != nil {
		end["attributes"] = p.attrs
	}
	return []*protocol.Event{
		pipeEvent(t, p, nativeSession, 1, protocol.EventTraceStarted, coalesceBase,
			map[string]any{"trace_id": p.traceID}),
		pipeEvent(t, p, nativeSession, 2, protocol.EventSpanStarted, coalesceBase.Add(time.Second),
			map[string]any{"span_id": span, "span_kind": "TOOL", "name": "Bash",
				"trace_id": p.traceID, "tool_name": "Bash"}),
		pipeEvent(t, p, nativeSession, 3, protocol.EventSpanCompleted, coalesceBase.Add(2*time.Second), end),
		pipeEvent(t, p, nativeSession, 4, protocol.EventTraceCompleted, coalesceBase.Add(3*time.Second),
			map[string]any{"trace_id": p.traceID}),
	}
}

func rowBySpan(rows []storage.ObsRow, spanID string) *storage.ObsRow {
	for i := range rows {
		if rows[i].SpanID == spanID {
			return &rows[i]
		}
	}
	return nil
}

// TestCoalescePrecedenceMatrix: for every combination of pipelines reporting
// one session, the highest-precedence source stays visible and the rest are
// shadowed — never deleted.
func TestCoalescePrecedenceMatrix(t *testing.T) {
	cases := []struct {
		name      string
		pipelines []pipeline
		wantVisib string // span id expected to survive unshadowed
		wantSrc   SignalSource
	}{
		{"native alone", []pipeline{nativePipeline()}, "spn_native_bash", SignalNative},
		{"hook alone", []pipeline{hookPipeline()}, "spn_hook_bash", SignalHook},
		{"sdk alone", []pipeline{sdkPipeline()}, "spn_sdk_bash", SignalSDK},
		{"native beats hook", []pipeline{nativePipeline(), hookPipeline()}, "spn_native_bash", SignalNative},
		{"native beats sdk", []pipeline{nativePipeline(), sdkPipeline()}, "spn_native_bash", SignalNative},
		{"hook beats sdk", []pipeline{hookPipeline(), sdkPipeline()}, "spn_hook_bash", SignalHook},
		{"all three", []pipeline{nativePipeline(), hookPipeline(), sdkPipeline()}, "spn_native_bash", SignalNative},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var events []*protocol.Event
			for _, p := range tc.pipelines {
				events = append(events, pipelineEvents(t, p, "nat-session-1")...)
			}
			res := DeriveAll(events)
			if len(res.Rows) != len(tc.pipelines) {
				t.Fatalf("rows = %d, want %d (nothing may be deleted)", len(res.Rows), len(tc.pipelines))
			}
			winner := rowBySpan(res.Rows, tc.wantVisib)
			if winner == nil {
				t.Fatalf("winner %s missing from %+v", tc.wantVisib, res.Rows)
			}
			if winner.Shadowed {
				t.Fatalf("the highest-precedence observation was shadowed: %+v", winner)
			}
			if winner.SignalSource != string(tc.wantSrc) {
				t.Fatalf("winner signal = %q, want %q", winner.SignalSource, tc.wantSrc)
			}
			for i := range res.Rows {
				r := res.Rows[i]
				if r.SpanID == tc.wantVisib {
					continue
				}
				if !r.Shadowed {
					t.Errorf("lower-precedence duplicate %s (%s) was not shadowed", r.SpanID, r.SignalSource)
				}
				if r.CanonicalSessionID != winner.SessionID {
					t.Errorf("row %s canonical session = %q, want %q",
						r.SpanID, r.CanonicalSessionID, winner.SessionID)
				}
			}
		})
	}
}

// TestCoalesceOrderIndependent is the property that makes the verdicts
// trustworthy: the same event set must produce the same coalescing outcome no
// matter what order the pipelines were imported in.
func TestCoalesceOrderIndependent(t *testing.T) {
	var events []*protocol.Event
	for _, p := range []pipeline{nativePipeline(), hookPipeline(), sdkPipeline()} {
		events = append(events, pipelineEvents(t, p, "nat-session-1")...)
	}
	want := DeriveAll(events)

	rng := rand.New(rand.NewSource(20260828))
	for i := 0; i < 25; i++ {
		shuffled := make([]*protocol.Event, len(events))
		copy(shuffled, events)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		got := DeriveAll(shuffled)
		if !reflect.DeepEqual(got.Rows, want.Rows) {
			t.Fatalf("shuffle %d changed the observation rows", i)
		}
		if !reflect.DeepEqual(got.ExceptionGroups, want.ExceptionGroups) {
			t.Fatalf("shuffle %d changed the exception groups", i)
		}
	}
}

// TestCoalesceKeepsUniqueEvidence: a weaker pipeline that saw something no
// stronger one reported stays visible. Shadowing removes duplicates, not
// facts.
func TestCoalesceKeepsUniqueEvidence(t *testing.T) {
	hook := hookPipeline()
	events := pipelineEvents(t, nativePipeline(), "nat-session-1")
	events = append(events, pipelineEvents(t, hook, "nat-session-1")...)
	// The hook adapter also observed a command the native exporter missed.
	events = append(events,
		pipeEvent(t, hook, "nat-session-1", 5, protocol.EventSpanStarted,
			coalesceBase.Add(30*time.Second), map[string]any{
				"span_id": "spn_hook_only", "span_kind": "COMMAND", "name": "go test",
				"trace_id": hook.traceID}),
		pipeEvent(t, hook, "nat-session-1", 6, protocol.EventSpanCompleted,
			coalesceBase.Add(31*time.Second), map[string]any{
				"span_id": "spn_hook_only", "trace_id": hook.traceID}))

	res := DeriveAll(events)
	only := rowBySpan(res.Rows, "spn_hook_only")
	if only == nil {
		t.Fatal("hook-only span missing from the read model")
	}
	if only.Shadowed {
		t.Fatal("a span only the hook saw must stay visible")
	}
	if only.SignalSource != string(SignalHook) {
		t.Fatalf("hook-only span signal = %q, want hook", only.SignalSource)
	}
	// It still records the canonical session of the coalesced run.
	if only.CanonicalSessionID != "ses_native" {
		t.Fatalf("canonical session = %q, want ses_native", only.CanonicalSessionID)
	}
}

// TestCoalesceDistinctSessionsNeverMerge: different native sessions, and
// sessions with no native id at all, must never be folded together.
func TestCoalesceDistinctSessionsNeverMerge(t *testing.T) {
	events := pipelineEvents(t, nativePipeline(), "nat-session-1")
	hook := hookPipeline()
	events = append(events, pipelineEvents(t, hook, "nat-session-2")...)

	res := DeriveAll(events)
	for i := range res.Rows {
		if res.Rows[i].Shadowed {
			t.Fatalf("row %s from a different session was shadowed", res.Rows[i].SpanID)
		}
	}

	// A row with no native session id is not coalescable and cannot be
	// shadowed by anything.
	orphan := hookPipeline()
	orphan.sessionID = "ses_orphan"
	orphan.traceID = "trc_orphan"
	orphan.spanPfx = "spn_orphan"
	res = DeriveAll(append(pipelineEvents(t, nativePipeline(), "nat-session-1"),
		pipelineEvents(t, orphan, "")...))
	got := rowBySpan(res.Rows, "spn_orphan_bash")
	if got == nil || got.Shadowed || got.CoalesceKey != "" {
		t.Fatalf("uncoalescable row mishandled: %+v", got)
	}
}

// TestDeclaredSignalSourceWins: an emitter that declares its own signal
// source overrides the heuristics, including on an adapter-shaped event.
func TestDeclaredSignalSourceWins(t *testing.T) {
	p := sdkPipeline()
	p.attrs = map[string]any{
		"telemetry.sdk.name": "opentelemetry",
		SignalSourceAttr:     "native",
	}
	res := DeriveAll(pipelineEvents(t, p, "nat-session-1"))
	got := rowBySpan(res.Rows, "spn_sdk_bash")
	if got == nil || got.SignalSource != string(SignalNative) {
		t.Fatalf("declared signal source ignored: %+v", got)
	}
}

// TestPromotedColumnsPopulated covers row 12: Derive fills the typed columns
// and the presence markers from the span and its attributes.
func TestPromotedColumnsPopulated(t *testing.T) {
	p := nativePipeline()
	end := map[string]any{
		"span_id": "spn_native_bash", "trace_id": p.traceID,
		"error": "rate limited",
		"attributes": map[string]any{
			"otlp.scope.name":            "com.anthropic.claude_code",
			"gen_ai.request.model":       "claude-opus",
			"gen_ai.usage.input_tokens":  float64(1200),
			"gen_ai.usage.output_tokens": float64(340),
			"exception.type":             "RateLimitError",
			"exception.message":          "rate limited after 3 retries",
			"exception.stacktrace":       "at internal/client/retry.go:118\nat main.go:9",
		},
	}
	events := []*protocol.Event{
		pipeEvent(t, p, "nat-session-1", 1, protocol.EventTraceStarted, coalesceBase,
			map[string]any{"trace_id": p.traceID}),
		pipeEvent(t, p, "nat-session-1", 2, protocol.EventSpanStarted, coalesceBase.Add(time.Second),
			map[string]any{"span_id": "spn_native_bash", "span_kind": "MODEL", "name": "chat",
				"trace_id": p.traceID, "tool_name": "Bash"}),
		pipeEvent(t, p, "nat-session-1", 3, protocol.EventSpanFailed, coalesceBase.Add(2*time.Second), end),
		pipeEvent(t, p, "nat-session-1", 4, protocol.EventTraceCompleted, coalesceBase.Add(3*time.Second),
			map[string]any{"trace_id": p.traceID}),
	}

	res := DeriveAll(events)
	got := rowBySpan(res.Rows, "spn_native_bash")
	if got == nil {
		t.Fatalf("span missing: %+v", res.Rows)
	}
	if got.ErrorType != "RateLimitError" {
		t.Errorf("error_type = %q, want RateLimitError", got.ErrorType)
	}
	if !got.ErrorExists || !got.UsageExists || !got.ToolNameExists || !got.ModelExists {
		t.Errorf("exists markers = %+v, want all true", got)
	}
	if got.WorkstreamID != "ws_coalesce" {
		t.Errorf("workstream not denormalized: %q", got.WorkstreamID)
	}

	// The failure lands in exactly one group, keyed off the normalized
	// message and the normalized top frame.
	if len(res.ExceptionGroups) != 1 {
		t.Fatalf("exception groups = %+v, want 1", res.ExceptionGroups)
	}
	g := res.ExceptionGroups[0]
	if g.ErrorType != "RateLimitError" {
		t.Errorf("group error type = %q", g.ErrorType)
	}
	if g.MessageTemplate != "rate limited after <num> retries" {
		t.Errorf("group template = %q", g.MessageTemplate)
	}
	if g.TopFrame != "at <path>:<num>" {
		t.Errorf("group top frame = %q", g.TopFrame)
	}
	if g.SpanCount != 1 || g.SampleSpanID != "spn_native_bash" || g.WorkstreamID != "ws_coalesce" {
		t.Errorf("group aggregate = %+v", g)
	}
}

// TestHandledExceptionMarksErrorWithoutFailing: OTel records a handled
// exception on a span that still succeeded. error_exists must say so while
// failed stays false, and a succeeded span must not become an exception
// group — groups describe failures.
func TestHandledExceptionMarksErrorWithoutFailing(t *testing.T) {
	p := hookPipeline()
	events := []*protocol.Event{
		pipeEvent(t, p, "nat-session-1", 1, protocol.EventTraceStarted, coalesceBase,
			map[string]any{"trace_id": p.traceID}),
		pipeEvent(t, p, "nat-session-1", 2, protocol.EventSpanStarted, coalesceBase.Add(time.Second),
			map[string]any{"span_id": "spn_recovered", "span_kind": "TOOL", "name": "Bash",
				"trace_id": p.traceID}),
		pipeEvent(t, p, "nat-session-1", 3, protocol.EventSpanCompleted, coalesceBase.Add(2*time.Second),
			map[string]any{"span_id": "spn_recovered", "trace_id": p.traceID,
				"attributes": map[string]any{
					"exception.type":    "TransientError",
					"exception.message": "retried once",
				}}),
	}
	res := DeriveAll(events)
	got := rowBySpan(res.Rows, "spn_recovered")
	if got == nil {
		t.Fatal("span missing")
	}
	if got.Failed {
		t.Error("a recovered span must not be marked failed")
	}
	if !got.ErrorExists || got.ErrorType != "TransientError" {
		t.Errorf("handled exception not promoted: %+v", got)
	}
	if len(res.ExceptionGroups) != 0 {
		t.Errorf("a succeeded span produced exception groups: %+v", res.ExceptionGroups)
	}
}

// TestPromotedMarkersFalseWhenAbsent: an ordinary successful span must not
// claim attributes it does not have.
func TestPromotedMarkersFalseWhenAbsent(t *testing.T) {
	p := hookPipeline()
	events := []*protocol.Event{
		pipeEvent(t, p, "nat-session-1", 1, protocol.EventTraceStarted, coalesceBase,
			map[string]any{"trace_id": p.traceID}),
		pipeEvent(t, p, "nat-session-1", 2, protocol.EventSpanStarted, coalesceBase.Add(time.Second),
			map[string]any{"span_id": "spn_plain", "span_kind": "OTHER", "name": "noop",
				"trace_id": p.traceID}),
		pipeEvent(t, p, "nat-session-1", 3, protocol.EventSpanCompleted, coalesceBase.Add(2*time.Second),
			map[string]any{"span_id": "spn_plain", "trace_id": p.traceID}),
	}
	res := DeriveAll(events)
	got := rowBySpan(res.Rows, "spn_plain")
	if got == nil {
		t.Fatal("span missing")
	}
	if got.ToolNameExists || got.ErrorExists || got.UsageExists {
		t.Errorf("markers set for absent attributes: %+v", got)
	}
	if got.ErrorType != "" {
		t.Errorf("error_type = %q, want empty for a successful span", got.ErrorType)
	}
	// Model rides on the event envelope, so it is present and marked.
	if !got.ModelExists {
		t.Error("model_exists must follow the promoted model column")
	}
	if len(res.ExceptionGroups) != 0 {
		t.Errorf("a successful span produced exception groups: %+v", res.ExceptionGroups)
	}
}
