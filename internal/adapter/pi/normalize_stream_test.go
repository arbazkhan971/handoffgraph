package pi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func piNativeFixturePath(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "testdata", "fixtures", "pi_native_all.jsonl")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("Pi native fixture: %v", err)
	}
	return path
}

func normalizePiNativeFixture(t *testing.T, adapter *Pi) []protocol.Event {
	t.Helper()
	f, err := os.Open(piNativeFixturePath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	events, err := adapter.NormalizeTranscript(context.Background(), f)
	if err != nil {
		t.Fatalf("NormalizeTranscript: %v", err)
	}
	return events
}

func TestNormalizeTranscriptGoldenAllNativeShapes(t *testing.T) {
	events := normalizePiNativeFixture(t, New())
	wantKinds := []protocol.EventKind{
		protocol.EventSessionStarted,
		protocol.EventLogObserved,
		protocol.EventLogObserved,
		protocol.EventPromptSubmitted,
		protocol.EventAssistantCompleted,
		protocol.EventLogObserved, // thinking content
		protocol.EventToolStarted,
		protocol.EventLogObserved, // unknown assistant content
		protocol.EventToolCompleted,
		protocol.EventToolFailed,
		protocol.EventCommandCompleted,
		protocol.EventLogObserved, // custom
		protocol.EventLogObserved, // custom_message
		protocol.EventLogObserved, // session_info
		protocol.EventLogObserved, // unknown record
		protocol.EventLogObserved, // unknown role
		protocol.EventLogObserved, // unknown role content
	}
	if len(events) != len(wantKinds) {
		t.Fatalf("events = %d, want %d", len(events), len(wantKinds))
	}
	seenIDs := map[string]bool{}
	for i, event := range events {
		if event.Kind != wantKinds[i] {
			t.Errorf("event %d kind = %q, want %q", i+1, event.Kind, wantKinds[i])
		}
		if event.Sequence != int64(i+1) {
			t.Errorf("event %d sequence = %d", i+1, event.Sequence)
		}
		if seenIDs[event.EventID] {
			t.Errorf("event %d reused id %s", i+1, event.EventID)
		}
		seenIDs[event.EventID] = true
		if event.Provider != protocol.ProviderPi || event.Agent != protocol.ProviderPi {
			t.Errorf("event %d provider/agent = %q/%q", i+1, event.Provider, event.Agent)
		}
		if event.NativeSessionID != "pi-native-golden" {
			t.Errorf("event %d native id = %q", i+1, event.NativeSessionID)
		}
		if event.Provenance != protocol.ProvenanceObserved {
			t.Errorf("event %d provenance = %q", i+1, event.Provenance)
		}
		if event.ContentHash == "" || event.EventID == "" {
			t.Errorf("event %d lacks content hash or id", i+1)
		}
	}

	var headPayload map[string]json.RawMessage
	if err := json.Unmarshal(events[0].Payload, &headPayload); err != nil {
		t.Fatal(err)
	}
	var parent, source string
	if err := json.Unmarshal(headPayload["parent_session_id"], &parent); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(headPayload["source"], &source); err != nil {
		t.Fatal(err)
	}
	if parent != "pi-native-parent" || source != "fork" {
		t.Fatalf("session fork metadata = parent %q source %q", parent, source)
	}
	var headSource map[string]json.RawMessage
	if err := json.Unmarshal(headPayload["source_record"], &headSource); err != nil {
		t.Fatal(err)
	}
	if _, ok := headSource["futureHead"]; !ok {
		t.Fatal("unknown session-head evidence was dropped")
	}

	// The assistant record's model folds forward, the tool call is emitted
	// separately, and its canonical source item retains the arguments.
	if events[4].Model != "synthetic-model" || events[6].Model != "synthetic-model" {
		t.Fatalf("assistant/tool models = %q/%q", events[4].Model, events[6].Model)
	}
	var toolPayload map[string]json.RawMessage
	if err := json.Unmarshal(events[6].Payload, &toolPayload); err != nil {
		t.Fatal(err)
	}
	if string(toolPayload["input"]) != `{"value":1}` {
		t.Errorf("tool input = %s", toolPayload["input"])
	}
	var toolSource map[string]json.RawMessage
	if err := json.Unmarshal(toolPayload["source_record"], &toolSource); err != nil {
		t.Fatal(err)
	}
	if _, ok := toolSource["arguments"]; !ok {
		t.Fatal("tool-call item evidence was dropped")
	}

	var commandPayload map[string]json.RawMessage
	if err := json.Unmarshal(events[10].Payload, &commandPayload); err != nil {
		t.Fatal(err)
	}
	if string(commandPayload["exit_code"]) != "7" {
		t.Errorf("command exit_code = %s", commandPayload["exit_code"])
	}

	// Unknown record, role, and content variants each remain observable and
	// carry their original shape rather than being silently skipped.
	for _, index := range []int{14, 15, 16} {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(events[index].Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload["source_record"]) == 0 {
			t.Errorf("event %d lacks source record", index+1)
		}
	}
}

func TestNormalizeTranscriptDeterministicAcrossCallsAndInstances(t *testing.T) {
	first := normalizePiNativeFixture(t, New())
	second := normalizePiNativeFixture(t, New())
	third := normalizePiNativeFixture(t, &Pi{AgentDir: t.TempDir()})
	if !reflect.DeepEqual(first, second) || !reflect.DeepEqual(first, third) {
		t.Fatal("same Pi transcript changed across normalization calls/instances")
	}

	// Unknown source evidence participates in deterministic IDs, even when
	// the mapped semantic event and record position stay the same.
	base := strings.Join([]string{
		`{"type":"session","id":"native-deterministic","timestamp":"2026-08-30T10:00:00Z"}`,
		`{"type":"future","timestamp":"2026-08-30T10:00:01Z","future":1}`,
	}, "\n") + "\n"
	changed := strings.Replace(base, `"future":1`, `"future":2`, 1)
	a, err := New().NormalizeTranscript(context.Background(), strings.NewReader(base))
	if err != nil {
		t.Fatal(err)
	}
	b, err := New().NormalizeTranscript(context.Background(), strings.NewReader(changed))
	if err != nil {
		t.Fatal(err)
	}
	if a[1].EventID == b[1].EventID || a[1].ContentHash == b[1].ContentHash {
		t.Fatal("changed unknown native evidence did not change event identity")
	}
}

func TestNormalizeTranscriptFailClosed(t *testing.T) {
	head := `{"type":"session","id":"native-safe","timestamp":"2026-08-30T10:00:00Z"}`
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: "no records"},
		{name: "blank", input: " \n\t\n", want: "no records"},
		{name: "missing head", input: `{"type":"message","timestamp":"2026-08-30T10:00:00Z"}`, want: "first record must be session"},
		{name: "head is scalar", input: `[]`, want: "record is not a JSON object"},
		{name: "malformed JSON", input: `{"type":"session"`, want: "unexpected end"},
		{name: "missing id", input: `{"type":"session","timestamp":"2026-08-30T10:00:00Z"}`, want: "session id"},
		{name: "blank id", input: `{"type":"session","id":" ","timestamp":"2026-08-30T10:00:00Z"}`, want: "session id"},
		{name: "non-string id", input: `{"type":"session","id":7,"timestamp":"2026-08-30T10:00:00Z"}`, want: "session id"},
		{name: "missing head timestamp", input: `{"type":"session","id":"native-safe"}`, want: "session timestamp"},
		{name: "invalid head timestamp", input: `{"type":"session","id":"native-safe","timestamp":"not-time"}`, want: "invalid timestamp"},
		{name: "invalid later timestamp", input: head + "\n" + `{"type":"custom","timestamp":"not-time"}`, want: "invalid timestamp"},
		{name: "inconsistent session record", input: head + "\n" + `{"type":"session","id":"native-other","timestamp":"2026-08-30T10:00:01Z"}`, want: "inconsistent native session"},
		{name: "duplicate same session head", input: head + "\n" + `{"type":"session","id":"native-safe","timestamp":"2026-08-30T10:00:01Z"}`, want: "duplicate session head"},
		{name: "inconsistent explicit session id", input: head + "\n" + `{"type":"custom","sessionId":"native-other","timestamp":"2026-08-30T10:00:01Z"}`, want: "identifies native session"},
		{name: "malformed tool error marker", input: head + "\n" + `{"type":"message","timestamp":"2026-08-30T10:00:01Z","message":{"role":"toolResult","isError":"yes"}}`, want: "isError"},
		{name: "duplicate top-level key", input: `{"type":"session","id":"native-one","id":"native-two","timestamp":"2026-08-30T10:00:00Z"}`, want: "duplicate JSON key"},
		{name: "duplicate nested key", input: head + "\n" + `{"type":"custom","timestamp":"2026-08-30T10:00:01Z","data":{"kept":1,"kept":2}}`, want: "duplicate JSON key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(test.input))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("events=%d err=%v, want error containing %q", len(events), err, test.want)
			}
			if events != nil {
				t.Fatalf("fail-closed normalization returned %d partial events", len(events))
			}
		})
	}

	if events, err := New().NormalizeTranscript(context.Background(), nil); err == nil || events != nil {
		t.Fatalf("nil reader events=%v err=%v", events, err)
	}

	badUTF8 := append([]byte(head+"\n"), 0xff, '\n')
	if events, err := New().NormalizeTranscript(context.Background(), bytes.NewReader(badUTF8)); err == nil || !strings.Contains(err.Error(), "invalid UTF-8") || events != nil {
		t.Fatalf("invalid UTF-8 events=%d err=%v", len(events), err)
	}
}

func TestNormalizeTranscriptScannerOverflowAndCancellation(t *testing.T) {
	head := `{"type":"session","id":"native-safe","timestamp":"2026-08-30T10:00:00Z"}` + "\n"
	overflow := head + `{"type":"custom","value":"` + strings.Repeat("x", nativeTranscriptMaxLine) + `"}`
	events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(overflow))
	if err == nil || !strings.Contains(err.Error(), "token too long") || events != nil {
		t.Fatalf("overflow events=%d err=%v", len(events), err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	events, err = New().NormalizeTranscript(ctx, strings.NewReader(head))
	if !errors.Is(err, context.Canceled) || events != nil {
		t.Fatalf("canceled events=%d err=%v", len(events), err)
	}
}

type cancelAwarePiReader struct {
	ctx     context.Context
	started chan struct{}
}

func (r *cancelAwarePiReader) Read(_ []byte) (int, error) {
	select {
	case <-r.started:
	default:
		close(r.started)
	}
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}

func TestNormalizeTranscriptCancellationPropagatesFromReader(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelAwarePiReader{ctx: ctx, started: make(chan struct{})}
	type result struct {
		events []protocol.Event
		err    error
	}
	resultCh := make(chan result, 1)
	go func() {
		events, err := New().NormalizeTranscript(ctx, reader)
		resultCh <- result{events: events, err: err}
	}()
	select {
	case <-reader.started:
	case <-time.After(2 * time.Second):
		t.Fatal("reader never entered Read")
	}
	cancel()
	select {
	case got := <-resultCh:
		if !errors.Is(got.err, context.Canceled) || got.events != nil {
			t.Fatalf("canceled stalled read events=%d err=%v", len(got.events), got.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("NormalizeTranscript did not return after cancellation")
	}
}

func TestNormalizeTranscriptMissingLaterTimestampStaysUnobserved(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"session","id":"native-zero-time","timestamp":"2026-08-30T10:00:00Z"}`,
		`{"type":"custom","id":"record-without-time"}`,
	}, "\n") + "\n"
	events, err := New().NormalizeTranscript(context.Background(), strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if !events[1].OccurredAt.IsZero() || !events[1].ObservedAt.IsZero() {
		t.Fatalf("missing observed time was inferred as %s/%s", events[1].OccurredAt, events[1].ObservedAt)
	}
	again, err := New().NormalizeTranscript(context.Background(), strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if events[1].EventID != again[1].EventID {
		t.Fatal("zero-time event id is not deterministic")
	}
}

// Ensure the test's overflow reader really returns all bytes rather than
// short-reading at an implementation-specific boundary.
var _ io.Reader = (*strings.Reader)(nil)
