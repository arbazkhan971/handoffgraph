package observations

import (
	"math/rand"
	"reflect"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func obsEvent(t *testing.T, seq int64, kind protocol.EventKind, at time.Time, session, payload string) *protocol.Event {
	t.Helper()
	ev := &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         ids.Event(),
		Sequence:        seq,
		OccurredAt:      at,
		ObservedAt:      at,
		WorkstreamID:    "ws_obs",
		SessionID:       session,
		NativeSessionID: session,
		Provider:        "otlp",
		Agent:           "codex-cli",
		Model:           "gpt-5.3",
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
	}
	if payload != "" {
		ev.Payload = jsonPayload(t, payload)
	}
	return ev
}

// TestDeriveDeterministic: shuffled event logs produce identical rows.
func TestDeriveDeterministic(t *testing.T) {
	events := seedObsEvents(t)
	shuffled := make([]*protocol.Event, len(events))
	copy(shuffled, events)
	rand.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })

	aRows, aFps := Derive(events)
	bRows, bFps := Derive(shuffled)
	if !reflect.DeepEqual(aRows, bRows) {
		t.Fatal("rows depend on input order")
	}
	if !reflect.DeepEqual(aFps, bFps) {
		t.Fatal("fingerprints depend on input order")
	}
	if len(aRows) != 3 {
		t.Fatalf("rows = %d, want 3", len(aRows))
	}
	// Denormalization: every row carries the trace's workstream + session.
	for _, r := range aRows {
		if r.WorkstreamID != "ws_obs" || r.SessionID != "ses_obs" {
			t.Fatalf("row %s not denormalized: %+v", r.SpanID, r)
		}
		if r.Fingerprint == "" {
			t.Fatalf("row %s missing fingerprint", r.SpanID)
		}
		if r.DurationNS <= 0 && r.Status == "ok" {
			t.Fatalf("ok row %s has no duration", r.SpanID)
		}
	}
	if aRows[0].Failed {
		t.Fatal("first row should not be failed")
	}
	// Exactly one fingerprint for one identity tuple.
	if len(aFps) != 1 || aFps[0].Agent != "codex-cli" || aFps[0].Model != "gpt-5.3" {
		t.Fatalf("fingerprints = %+v", aFps)
	}
}

// TestFingerprintStable pins fingerprint determinism and sensitivity.
func TestFingerprintStable(t *testing.T) {
	a := Fingerprint("otlp", "codex-cli", "gpt-5.3")
	b := Fingerprint("otlp", "codex-cli", "gpt-5.3")
	if a != b || len(a) != 24 {
		t.Fatalf("fingerprint unstable: %q vs %q", a, b)
	}
	if c := Fingerprint("otlp", "claude-code", "gpt-5.3"); c == a {
		t.Fatal("different tuples must not collide")
	}
}

func jsonPayload(t *testing.T, s string) []byte {
	t.Helper()
	return []byte(s)
}

func seedObsEvents(t *testing.T) []*protocol.Event {
	t.Helper()
	base := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	trc := map[string]any{"trace_id": "trc_obs"}
	var events []*protocol.Event
	events = append(events, obsEvent(t, 0, protocol.EventTraceStarted, base, "ses_obs", `{"trace_id":"trc_obs"}`))
	_ = trc
	events = append(events, obsEvent(t, 1, protocol.EventSpanStarted, base.Add(time.Second), "ses_obs",
		`{"span_id":"spn_root","span_kind":"AGENT","name":"run","trace_id":"trc_obs"}`))
	events = append(events, obsEvent(t, 2, protocol.EventSpanCompleted, base.Add(2*time.Second), "ses_obs",
		`{"span_id":"spn_root","trace_id":"trc_obs"}`))
	events = append(events, obsEvent(t, 3, protocol.EventSpanStarted, base.Add(3*time.Second), "ses_obs",
		`{"span_id":"spn_llm","span_kind":"MODEL","name":"chat","trace_id":"trc_obs","tool_name":""}`))
	events = append(events, obsEvent(t, 4, protocol.EventSpanFailed, base.Add(4*time.Second), "ses_obs",
		`{"span_id":"spn_llm","trace_id":"trc_obs","error":"rate limited"}`))
	events = append(events, obsEvent(t, 5, protocol.EventSpanStarted, base.Add(5*time.Second), "ses_obs",
		`{"span_id":"spn_tool","span_kind":"TOOL","name":"apply_patch","trace_id":"trc_obs","tool_name":"apply_patch"}`))
	events = append(events, obsEvent(t, 6, protocol.EventSpanCompleted, base.Add(6*time.Second), "ses_obs",
		`{"span_id":"spn_tool","trace_id":"trc_obs"}`))
	events = append(events, obsEvent(t, 7, protocol.EventTraceCompleted, base.Add(7*time.Second), "ses_obs", `{"trace_id":"trc_obs"}`))
	return events
}
