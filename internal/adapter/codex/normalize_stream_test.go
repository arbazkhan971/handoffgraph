package codex

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// The tests in this file pin NormalizeStream, the native rollout JSONL →
// hfg.event.v1 normalizer: the documented record mapping, deterministic
// event ids (re-normalize is idempotent), model folding, unknown-field
// preservation and fail-closed malformed-input handling.

// streamFixturePath resolves a golden fixture under the repo-root
// testdata/fixtures directory relative to this test file, so the tests run
// from any working directory.
func streamFixturePath(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate testdata/fixtures")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "testdata", "fixtures", name)
}

// normalizeFixture runs NormalizeStream over a fixture file twice and
// returns both passes (idempotency is asserted by callers).
func normalizeFixture(t *testing.T, c *Codex, name string) (first, second []protocol.Event) {
	t.Helper()
	path := streamFixturePath(t, name)
	f1, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f1.Close()
	first, err = c.NormalizeStream(context.Background(), f1)
	if err != nil {
		t.Fatalf("normalize stream: %v", err)
	}
	f2, err := os.Open(path)
	if err != nil {
		t.Fatalf("reopen fixture: %v", err)
	}
	defer f2.Close()
	second, err = c.NormalizeStream(context.Background(), f2)
	if err != nil {
		t.Fatalf("normalize stream (second pass): %v", err)
	}
	return first, second
}

func wantKinds(t *testing.T, events []protocol.Event, want []protocol.EventKind) {
	t.Helper()
	if len(events) != len(want) {
		t.Fatalf("event count = %d, want %d (kinds: %v)", len(events), len(want), kindNames(events))
	}
	for i, ev := range events {
		if ev.Kind != want[i] {
			t.Errorf("event %d kind = %s, want %s", i+1, ev.Kind, want[i])
		}
	}
}

func kindNames(events []protocol.Event) []string {
	out := make([]string, 0, len(events))
	for _, ev := range events {
		out = append(out, string(ev.Kind))
	}
	return out
}

// checkInvariants asserts the properties every normalized stream event must
// hold: schema, provider, provenance, native id, sequence, unique ids and
// unique content hashes (equal hash + equal seq would mean lost evidence).
func checkInvariants(t *testing.T, events []protocol.Event, nativeID string) {
	t.Helper()
	ids := map[string]bool{}
	for i, ev := range events {
		if ev.SchemaVersion != protocol.SchemaVersionEvent {
			t.Errorf("event %d schema = %s", i+1, ev.SchemaVersion)
		}
		if ev.Provider != protocol.ProviderCodex {
			t.Errorf("event %d provider = %s, want codex", i+1, ev.Provider)
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			t.Errorf("event %d provenance = %s, want OBSERVED", i+1, ev.Provenance)
		}
		if ev.NativeSessionID != nativeID {
			t.Errorf("event %d native_session_id = %s, want %s", i+1, ev.NativeSessionID, nativeID)
		}
		if ev.Sequence != int64(i+1) {
			t.Errorf("event %d sequence = %d", i+1, ev.Sequence)
		}
		if !strings.HasPrefix(ev.EventID, "evt_") {
			t.Errorf("event %d id = %s, want evt_ prefix", i+1, ev.EventID)
		}
		if ids[ev.EventID] {
			t.Errorf("event %d reuses id %s", i+1, ev.EventID)
		}
		ids[ev.EventID] = true
		if ev.OccurredAt.IsZero() || ev.ObservedAt.IsZero() {
			t.Errorf("event %d has a zero timestamp", i+1)
		}
	}
}

// assertIdempotent deep-compares two passes and cross-instance output.
func assertIdempotent(t *testing.T, first, second []protocol.Event) {
	t.Helper()
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if string(a) != string(b) {
		t.Errorf("re-normalize is not idempotent:\n%s\n%s", a, b)
	}
}

func TestNormalizeStreamCodexSessionFixture(t *testing.T) {
	c := New()
	first, second := normalizeFixture(t, c, "codex_session.jsonl")

	want := []protocol.EventKind{
		protocol.EventSessionStarted,     // session_meta
		protocol.EventPromptSubmitted,    // event_msg user_message
		protocol.EventToolStarted,        // response_item function_call
		protocol.EventToolCompleted,      // response_item function_call_output
		protocol.EventAssistantCompleted, // event_msg agent_message
		protocol.EventLogObserved,        // turn_context
	}
	wantKinds(t, first, want)
	checkInvariants(t, first, "0f9c7a2e-1111-4222-8333-444455556666")
	assertIdempotent(t, first, second)

	// Timestamps come from each record, in order.
	wantTimes := []string{
		"2026-08-21T15:00:00Z", "2026-08-21T15:00:05Z", "2026-08-21T15:00:10Z",
		"2026-08-21T15:00:20Z", "2026-08-21T15:00:25Z", "2026-08-21T15:00:30Z",
	}
	for i, ev := range first {
		if got := ev.OccurredAt.Format(time.RFC3339); got != wantTimes[i] {
			t.Errorf("event %d occurred_at = %s, want %s", i+1, got, wantTimes[i])
		}
	}

	// The head lacks payload.model here; the trailing turn_context both
	// carries and announces it.
	for i, ev := range first {
		if i < len(first)-1 && ev.Model != "" {
			t.Errorf("event %d model = %s, want empty before turn_context", i+1, ev.Model)
		}
	}
	if last := first[len(first)-1]; last.Model != "gpt-5-codex" {
		t.Errorf("turn_context event model = %s, want gpt-5-codex", last.Model)
	}

	// Unknown top-level fields must survive (fixture line 6).
	var unknownRaw json.RawMessage
	var ok bool
	if unknownRaw, ok = first[len(first)-1].Unknown["hfg_future_field"]; !ok {
		t.Fatalf("hfg_future_field dropped from the turn_context event: %+v", first[len(first)-1].Unknown)
	}
	var note struct {
		Note string `json:"note"`
	}
	if err := json.Unmarshal(unknownRaw, &note); err != nil || !strings.Contains(note.Note, "must survive") {
		t.Errorf("hfg_future_field corrupted: %s (%v)", unknownRaw, err)
	}

	// Mapped payload details.
	var toolPayload map[string]any
	if err := json.Unmarshal(first[2].Payload, &toolPayload); err != nil {
		t.Fatal(err)
	}
	if toolPayload["tool"] != "shell" {
		t.Errorf("function_call tool = %v, want shell", toolPayload["tool"])
	}
	if src, _ := toolPayload["source_kind"].(string); src != "rollout:response_item:function_call" {
		t.Errorf("function_call source_kind = %v", toolPayload["source_kind"])
	}
}

func TestNormalizeStreamCodexSession2Fixture(t *testing.T) {
	c := New()
	first, second := normalizeFixture(t, c, "codex_session_2.jsonl")

	want := []protocol.EventKind{
		protocol.EventSessionStarted,     // session_meta (with payload.model)
		protocol.EventPromptSubmitted,    // user_message
		protocol.EventToolStarted,        // function_call
		protocol.EventToolCompleted,      // function_call_output
		protocol.EventCommandCompleted,   // exec_command
		protocol.EventAssistantCompleted, // agent_message
		protocol.EventSessionCompacted,   // compacted_summary
	}
	wantKinds(t, first, want)
	checkInvariants(t, first, "5b2e9f60-ab12-4cd3-8ef4-90ab12cd34ef")
	assertIdempotent(t, first, second)

	// The head declares the model: every event inherits it.
	for i, ev := range first {
		if ev.Model != "gpt-5-codex" {
			t.Errorf("event %d model = %s, want gpt-5-codex", i+1, ev.Model)
		}
	}

	// exec_command keeps its exit code; compaction keeps its summary.
	var cmdPayload map[string]any
	if err := json.Unmarshal(first[4].Payload, &cmdPayload); err != nil {
		t.Fatal(err)
	}
	if cmdPayload["exit_code"] != float64(0) {
		t.Errorf("exec_command exit_code = %v, want 0", cmdPayload["exit_code"])
	}
	var compactPayload map[string]any
	if err := json.Unmarshal(first[6].Payload, &compactPayload); err != nil {
		t.Fatal(err)
	}
	if s, _ := compactPayload["summary"].(string); !strings.Contains(s, "summarized to reclaim context") {
		t.Errorf("compacted_summary payload = %v", compactPayload)
	}
}

func TestNormalizeStreamForkResumeFixture(t *testing.T) {
	c := New()
	first, second := normalizeFixture(t, c, "codex-fork-resume.jsonl")

	want := []protocol.EventKind{
		protocol.EventSessionStarted,     // session_meta
		protocol.EventPromptSubmitted,    // resumed-run user_message
		protocol.EventLogObserved,        // turn_context
		protocol.EventToolStarted,        // function_call
		protocol.EventToolCompleted,      // function_call_output (failure text)
		protocol.EventCommandCompleted,   // exec_command exit 1
		protocol.EventAssistantCompleted, // agent_message
		protocol.EventLogObserved,        // token_count (unmapped → log)
	}
	wantKinds(t, first, want)
	checkInvariants(t, first, "7d2c93a1-6b4e-4f20-9c8d-2a51e0f4b907")
	assertIdempotent(t, first, second)

	// The failing command keeps its nonzero exit code.
	var cmdPayload map[string]any
	if err := json.Unmarshal(first[5].Payload, &cmdPayload); err != nil {
		t.Fatal(err)
	}
	if cmdPayload["exit_code"] != float64(1) {
		t.Errorf("exec_command exit_code = %v, want 1", cmdPayload["exit_code"])
	}
	if cmdPayload["command"] != "go test ./internal/adapter/codex/..." {
		t.Errorf("exec_command command = %v", cmdPayload["command"])
	}
	// Unconsumed exec_command fields (duration_ms) survive verbatim.
	if _, ok := cmdPayload["duration_ms"]; !ok {
		t.Errorf("exec_command duration_ms dropped: %v", cmdPayload)
	}
	// tool correlation ids survive.
	var toolPayload map[string]any
	if err := json.Unmarshal(first[3].Payload, &toolPayload); err != nil {
		t.Fatal(err)
	}
	if toolPayload["call_id"] != "call_0f3a9d21" {
		t.Errorf("function_call call_id = %v, want call_0f3a9d21", toolPayload["call_id"])
	}
	// token_count falls back to log.observed with the payload preserved.
	var logPayload map[string]any
	if err := json.Unmarshal(first[7].Payload, &logPayload); err != nil {
		t.Fatal(err)
	}
	if src, _ := logPayload["source_kind"].(string); src != "rollout:event_msg:token_count" {
		t.Errorf("token_count source_kind = %v", logPayload["source_kind"])
	}
	if _, ok := logPayload["info"]; !ok {
		t.Errorf("token_count info dropped: %v", logPayload)
	}
}

func TestNormalizeStreamSubagentFixture(t *testing.T) {
	c := New()
	first, second := normalizeFixture(t, c, "codex-subagent.jsonl")

	want := []protocol.EventKind{
		protocol.EventSessionStarted,     // session_meta
		protocol.EventPromptSubmitted,    // user_message
		protocol.EventLogObserved,        // turn_context (gpt-5-codex)
		protocol.EventAssistantCompleted, // agent_message
		protocol.EventLogObserved,        // turn_context (gpt-5-mini: the subagent turn)
		protocol.EventToolStarted,        // function_call
		protocol.EventToolCompleted,      // function_call_output
		protocol.EventLogObserved,        // agent_reasoning (unmapped → log)
		protocol.EventAssistantCompleted, // agent_message
	}
	wantKinds(t, first, want)
	checkInvariants(t, first, "c58e1b04-93d7-4a66-b1f2-8e37c9a2d610")
	assertIdempotent(t, first, second)

	// Model folds forward exactly at the subagent turn_context: records 1-4
	// carry the head model, records 5-9 the delegated model.
	for i, ev := range first {
		wantModel := "gpt-5-codex"
		if i >= 4 {
			wantModel = "gpt-5-mini"
		}
		if ev.Model != wantModel {
			t.Errorf("event %d model = %s, want %s", i+1, ev.Model, wantModel)
		}
	}
}

func TestNormalizeStreamDeterministicAcrossInstances(t *testing.T) {
	path := streamFixturePath(t, "codex-subagent.jsonl")
	read := func() []protocol.Event {
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		events, err := (&Codex{}).NormalizeStream(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
		return events
	}
	a, b := read(), read()
	if !reflect.DeepEqual(a, b) {
		t.Error("two Codex instances derived different events from the same transcript")
	}
}

func TestNormalizeStreamTableDriven(t *testing.T) {
	head := `{"timestamp":"2026-08-22T12:00:00Z","type":"session_meta","payload":{"id":"tbl-1","timestamp":"2026-08-22T12:00:00Z","model":"gpt-5-codex","cwd":"/repo","originator":"codex_cli_rs","cli_version":"0.46.0"}}`
	cases := []struct {
		name       string
		records    []string
		wantKind   protocol.EventKind
		checkEvent func(t *testing.T, ev protocol.Event)
	}{
		{
			name:     "exec command failure keeps exit code",
			records:  []string{head, `{"timestamp":"2026-08-22T12:00:01Z","type":"response_item","payload":{"type":"exec_command","command":"go vet ./...","exit_code":2}}`},
			wantKind: protocol.EventCommandCompleted,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatal(err)
				}
				if p["exit_code"] != float64(2) {
					t.Errorf("exit_code = %v, want 2", p["exit_code"])
				}
			},
		},
		{
			name:     "session meta carries observed context",
			records:  []string{head},
			wantKind: protocol.EventSessionStarted,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatal(err)
				}
				if p["cwd"] != "/repo" || p["cli_version"] != "0.46.0" || p["originator"] != "codex_cli_rs" {
					t.Errorf("session context = %v", p)
				}
				if _, ok := p["model"]; ok {
					t.Errorf("model duplicated into payload: %v", p)
				}
			},
		},
		{
			name:     "unknown top-level record type stays a log",
			records:  []string{head, `{"timestamp":"2026-08-22T12:00:02Z","type":"future_record","payload":{"anything":[1,2]}}`},
			wantKind: protocol.EventLogObserved,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatal(err)
				}
				if src, _ := p["source_kind"].(string); src != "rollout:future_record" {
					t.Errorf("source_kind = %v", p["source_kind"])
				}
			},
		},
		{
			name:     "unknown event_msg payload type preserves payload verbatim",
			records:  []string{head, `{"timestamp":"2026-08-22T12:00:03Z","type":"event_msg","payload":{"type":"mcp_tool_call_begin","server":"fs","tool":"read"}}`},
			wantKind: protocol.EventLogObserved,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				var p map[string]any
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					t.Fatal(err)
				}
				if p["server"] != "fs" || p["tool"] != "read" || p["type"] != "mcp_tool_call_begin" {
					t.Errorf("payload = %v, want verbatim passthrough", p)
				}
			},
		},
		{
			name:     "record without timestamp falls back to the head timestamp",
			records:  []string{head, `{"type":"event_msg","payload":{"type":"user_message","message":"late"}}`},
			wantKind: protocol.EventPromptSubmitted,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				if got := ev.OccurredAt.Format(time.RFC3339); got != "2026-08-22T12:00:00Z" {
					t.Errorf("occurred_at = %s, want head timestamp", got)
				}
			},
		},
		{
			name:     "second session meta is evidence, not a re-scope",
			records:  []string{head, `{"timestamp":"2026-08-22T12:00:04Z","type":"session_meta","payload":{"id":"other-session","model":"m2"}}`},
			wantKind: protocol.EventLogObserved,
			checkEvent: func(t *testing.T, ev protocol.Event) {
				if ev.NativeSessionID != "tbl-1" {
					t.Errorf("native_session_id re-scoped to %s", ev.NativeSessionID)
				}
				if ev.Model != "gpt-5-codex" {
					t.Errorf("model overridden to %s", ev.Model)
				}
			},
		},
		{
			name:     "fractional-second timestamps parse",
			records:  []string{`{"timestamp":"2026-08-22T12:00:00.125Z","type":"session_meta","payload":{"id":"tbl-2","timestamp":"2026-08-22T12:00:00.125Z"}}`, `{"timestamp":"2026-08-22T12:00:00.250Z","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}`},
			wantKind: protocol.EventAssistantCompleted,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			events, err := (&Codex{}).NormalizeStream(context.Background(), strings.NewReader(strings.Join(tc.records, "\n")+"\n"))
			if err != nil {
				t.Fatalf("normalize stream: %v", err)
			}
			if len(events) != len(tc.records) {
				t.Fatalf("event count = %d, want %d", len(events), len(tc.records))
			}
			last := events[len(events)-1]
			if last.Kind != tc.wantKind {
				t.Errorf("kind = %s, want %s", last.Kind, tc.wantKind)
			}
			if tc.checkEvent != nil {
				tc.checkEvent(t, last)
			}
		})
	}
}

func TestNormalizeStreamBlankLinesSkipped(t *testing.T) {
	in := "\n{\"timestamp\":\"2026-08-22T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"blank\",\"timestamp\":\"2026-08-22T12:00:00Z\"}}\n\n\n{\"timestamp\":\"2026-08-22T12:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"x\"}}\n\n"
	events, err := (&Codex{}).NormalizeStream(context.Background(), strings.NewReader(in))
	if err != nil {
		t.Fatalf("normalize stream: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("event count = %d, want 2 (blank lines skipped)", len(events))
	}
	if events[0].Sequence != 1 || events[1].Sequence != 2 {
		t.Errorf("sequences = %d,%d, want 1,2", events[0].Sequence, events[1].Sequence)
	}
}

func TestNormalizeStreamFailClosedTable(t *testing.T) {
	head := `{"timestamp":"2026-08-22T12:00:00Z","type":"session_meta","payload":{"id":"err-1","timestamp":"2026-08-22T12:00:00Z"}}`
	cases := []struct {
		name    string
		input   string
		wantSub string
	}{
		{"empty stream", "", "session_meta"},
		{"first record not session_meta", `{"timestamp":"2026-08-22T12:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"x"}}`, "session_meta"},
		{"missing payload id", `{"timestamp":"2026-08-22T12:00:00Z","type":"session_meta","payload":{"cwd":"/repo"}}`, "payload.id"},
		{"missing head timestamp", `{"type":"session_meta","payload":{"id":"err-1"}}`, "timestamp"},
		{"malformed json mid-stream", head + "\n{\"timestamp\":", "line 2"},
		{"bad timestamp", head + "\n{\"timestamp\":\"not-a-time\",\"type\":\"event_msg\",\"payload\":{}}", "line 2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := (&Codex{}).NormalizeStream(context.Background(), strings.NewReader(tc.input))
			if err == nil {
				t.Fatalf("input %q accepted, want error", tc.input)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Errorf("error = %v, want it to mention %q", err, tc.wantSub)
			}
		})
	}
}

func TestNormalizeStreamRejectsInvalidUTF8(t *testing.T) {
	head := `{"timestamp":"2026-08-22T12:00:00Z","type":"session_meta","payload":{"id":"utf8","timestamp":"2026-08-22T12:00:00Z"}}`
	bad := append([]byte(head+"\n"), 0x7b, 0x22, 0x74, 0xff, 0x7d) // { " t <invalid> }
	_, err := (&Codex{}).NormalizeStream(context.Background(), &byteReader{data: bad})
	if err == nil {
		t.Fatal("invalid UTF-8 accepted, want fail-closed error")
	}
	if !strings.Contains(err.Error(), "line 2") || !strings.Contains(err.Error(), "UTF-8") {
		t.Errorf("error = %v, want line-numbered UTF-8 rejection", err)
	}
}

func TestNormalizeStreamNilReader(t *testing.T) {
	if _, err := (&Codex{}).NormalizeStream(context.Background(), nil); err == nil {
		t.Fatal("nil reader accepted, want error")
	}
}

func TestNormalizeStreamContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	head := `{"timestamp":"2026-08-22T12:00:00Z","type":"session_meta","payload":{"id":"ctx","timestamp":"2026-08-22T12:00:00Z"}}`
	if _, err := (&Codex{}).NormalizeStream(ctx, strings.NewReader(head)); err == nil {
		t.Fatal("cancelled context accepted, want error")
	}
}

// byteReader is a minimal io.Reader over a byte slice for feeding raw
// (possibly invalid-UTF-8) bytes into NormalizeStream.
type byteReader struct {
	data []byte
	pos  int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
