package otlp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func loadFixture(t *testing.T) *ExportRequest {
	t.Helper()
	data, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var req ExportRequest
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return &req
}

// loadSemconvFixture loads the GenAI semconv v1.37.0 golden fixture:
// gen_ai.provider.name, gen_ai.conversation.id, and OpenInference
// EVALUATOR/PROMPT spans (2026-08-28 market audit, parity rows 2/3). It is a
// SEPARATE fixture from genai_session.json — existing fixtures/ids must not
// move — so this exercises only the new attribute mapping.
func loadSemconvFixture(t *testing.T) *ExportRequest {
	t.Helper()
	data, err := os.ReadFile("../../testdata/fixtures/otlp/semconv_v137.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var req ExportRequest
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return &req
}

func fixedObserved() time.Time { return time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC) }

func convertFixture(t *testing.T) *Result {
	t.Helper()
	res, err := Convert(loadFixture(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	return res
}

// TestConvertGenAISession walks the golden fixture end to end: kinds, order,
// mapping, sanitization, parent linkage, and token aggregation.
func TestConvertGenAISession(t *testing.T) {
	res := convertFixture(t)
	if len(res.SpanErrors) != 0 {
		t.Fatalf("unexpected span errors: %v", res.SpanErrors)
	}
	if res.DroppedAttributeKeys != 1 {
		t.Fatalf("dropped keys = %d, want 1 (reserved __proto__)", res.DroppedAttributeKeys)
	}
	// session.started + trace.started + 3 span.started + 3 span ends +
	// trace.completed = 9 events.
	if len(res.Events) != 9 {
		t.Fatalf("event count = %d, want 9", len(res.Events))
	}

	// Deterministic ordering: (occurred_at, class, event_id).
	for i := 1; i < len(res.Events); i++ {
		prev, cur := res.Events[i-1], res.Events[i]
		if cur.OccurredAt.Before(prev.OccurredAt) {
			t.Fatalf("events not time-sorted at %d: %s after %s", i, cur.EventID, prev.EventID)
		}
	}
	if got := res.Events[0].Kind; got != protocol.EventSessionStarted {
		t.Fatalf("first event = %s, want session.started", got)
	}
	if got := res.Events[len(res.Events)-1].Kind; got != protocol.EventTraceCompleted {
		t.Fatalf("last event = %s, want trace.completed", got)
	}

	// Every event carries the spine contract fields.
	sesIDs := map[string]bool{}
	for _, ev := range res.Events {
		if ev.SchemaVersion != protocol.SchemaVersionEvent {
			t.Fatalf("%s: schema %q", ev.EventID, ev.SchemaVersion)
		}
		if ev.Provider != protocol.ProviderOTLP {
			t.Fatalf("%s: provider %q", ev.EventID, ev.Provider)
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			t.Fatalf("%s: provenance %q", ev.EventID, ev.Provenance)
		}
		if ev.ObservedAt != fixedObserved() {
			t.Fatalf("%s: observed_at not the injected clock", ev.EventID)
		}
		if ev.SessionID == "" {
			t.Fatalf("%s: empty session id", ev.EventID)
		}
		sesIDs[ev.SessionID] = true
	}
	if len(sesIDs) != 1 {
		t.Fatalf("session.id attribute should collapse all events onto one session, got %d", len(sesIDs))
	}

	// The GenAI client span maps to MODEL with model + failure evidence.
	var chatEnd *protocol.Event
	for _, ev := range res.Events {
		if ev.Kind == protocol.EventSpanFailed {
			chatEnd = ev
			break
		}
	}
	if chatEnd == nil {
		t.Fatal("no span.failed event for the rate-limited chat span")
	}
	if chatEnd.Model != "gpt-5.3" {
		t.Fatalf("chat model = %q", chatEnd.Model)
	}
	var p map[string]any
	if err := json.Unmarshal(chatEnd.Payload, &p); err != nil {
		t.Fatal(err)
	}
	if p["error"] != "rate limited" {
		t.Fatalf("error = %v", p["error"])
	}
	attrs := p["attributes"].(map[string]any)
	if attrs["llm.prompt"] != "fix the duplicate checkout submission" {
		t.Fatalf("prompt attribute not preserved: %v", attrs["llm.prompt"])
	}
	if _, reserved := attrs["__proto__"]; reserved {
		t.Fatal("reserved key __proto__ survived sanitization")
	}

	// Parent linkage: the chat span's start event references the root span's
	// derived start event id.
	rootStartID := ""
	chatStartID := ""
	for _, ev := range res.Events {
		if ev.Kind != protocol.EventSpanStarted {
			continue
		}
		var sp map[string]any
		_ = json.Unmarshal(ev.Payload, &sp)
		switch sp["name"] {
		case "run agent":
			rootStartID = ev.EventID
		case "chat gpt-5.3":
			chatStartID = ev.EventID
		}
	}
	for _, ev := range res.Events {
		if ev.EventID == chatStartID {
			if len(ev.ParentEventIDs) != 1 || ev.ParentEventIDs[0] != rootStartID {
				t.Fatalf("chat parent linkage = %v, want [%s]", ev.ParentEventIDs, rootStartID)
			}
		}
	}

	// Usage aggregation lands on trace.completed.
	last := res.Events[len(res.Events)-1]
	var tp map[string]any
	if err := json.Unmarshal(last.Payload, &tp); err != nil {
		t.Fatal(err)
	}
	if tp["token_input"].(float64) != 1200 || tp["token_output"].(float64) != 350 || tp["token_cache_read"].(float64) != 200 {
		t.Fatalf("trace usage = %v", tp)
	}
}

// TestConvertSemconvV137 pins the GenAI semantic-conventions v1.37.0
// attribute mapping (2026-08-28 market audit, parity rows 2/3):
//   - provider detection: gen_ai.provider.name wins over the legacy
//     gen_ai.system when gen_ai.request.model is absent;
//   - session-key precedence: gen_ai.conversation.id outranks
//     langfuse.session.id;
//   - OpenInference's EVALUATOR and PROMPT kinds fold onto our
//     GUARDRAIL/WORKFLOW kinds instead of being dropped to OTHER.
//
// The session/trace ids are pinned literally so platform/test/otlp.test.ts
// can assert the exact same strings — cross-language id parity is a hard
// contract. Regenerate both together if convert.go's key formulas change.
func TestConvertSemconvV137(t *testing.T) {
	res, err := Convert(loadSemconvFixture(t), Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if len(res.SpanErrors) != 0 {
		t.Fatalf("unexpected span errors: %v", res.SpanErrors)
	}
	// session.started + trace.started + 3 span.started + 3 span.completed +
	// trace.completed = 9 events.
	if len(res.Events) != 9 {
		t.Fatalf("event count = %d, want 9", len(res.Events))
	}

	const traceHex = "748cd2e72cbe280d4242c6f65a237d76"
	const rootSpanHex = "0aacf703138cc694" // "assemble prompt" (PROMPT)
	const evalSpanHex = "b5f6be6764e48af6" // "verify claim" (EVALUATOR)
	const sessionKey = "conv-8842"         // gen_ai.conversation.id — NOT langfuse-loses

	wantSessionID := ids.Deterministic(ids.PrefixSession, "otlp|"+sessionKey, 0)
	wantTraceID := ids.Deterministic(ids.PrefixTrace, "otlp|"+traceHex, 0)
	// root span starts at 1787918400000000000 ns = 1787918400000 ms.
	wantRootStartEvtID := ids.Deterministic(ids.PrefixEvent, "otlp|span-start|"+traceHex+"|"+rootSpanHex, 1787918400000)
	// eval span starts at 1787918405000000000 ns = 1787918405000 ms.
	wantEvalStartEvtID := ids.Deterministic(ids.PrefixEvent, "otlp|span-start|"+traceHex+"|"+evalSpanHex, 1787918405000)
	if wantSessionID != "ses_0000000000WSSGPRQR3WX4YQ1E" {
		t.Fatalf("session id formula drifted from the pinned golden value: %s", wantSessionID)
	}
	if wantTraceID != "trc_0000000000Z2JW9HMJZYCDCS5C" {
		t.Fatalf("trace id formula drifted from the pinned golden value: %s", wantTraceID)
	}
	if wantRootStartEvtID != "evt_01M143VEG04WB39V9R2FZ184FV" {
		t.Fatalf("root span-start event id formula drifted from the pinned golden value: %s", wantRootStartEvtID)
	}
	if wantEvalStartEvtID != "evt_01M143VKC8DHPH5EH99NWN59BM" {
		t.Fatalf("eval span-start event id formula drifted from the pinned golden value: %s", wantEvalStartEvtID)
	}

	sesIDs := map[string]bool{}
	for _, ev := range res.Events {
		if ev.SessionID != wantSessionID {
			t.Fatalf("%s: session id = %s, want %s (gen_ai.conversation.id must outrank langfuse.session.id)",
				ev.EventID, ev.SessionID, wantSessionID)
		}
		sesIDs[ev.SessionID] = true
	}
	if len(sesIDs) != 1 {
		t.Fatalf("expected exactly one session (conversation.id must collapse the trace), got %d", len(sesIDs))
	}

	// Provider detection: the chat span sets both gen_ai.provider.name=
	// "anthropic" and the legacy gen_ai.system="anthropic-legacy" with no
	// gen_ai.request.model — the new key must win for the model field.
	var chatEnd *protocol.Event
	var promptStart, evalStart *protocol.Event
	for _, ev := range res.Events {
		switch ev.Kind {
		case protocol.EventSpanStarted:
			var p map[string]any
			_ = json.Unmarshal(ev.Payload, &p)
			switch p["name"] {
			case "assemble prompt":
				promptStart = ev
			case "verify claim":
				evalStart = ev
			}
		case protocol.EventSpanCompleted:
			if ev.Model == "anthropic" {
				chatEnd = ev
			}
		}
	}
	if chatEnd == nil {
		t.Fatal("no span.completed event with model resolved from gen_ai.provider.name (system fallback must not win)")
	}

	// mapKind: OpenInference PROMPT -> WORKFLOW, EVALUATOR -> GUARDRAIL.
	if promptStart == nil {
		t.Fatal("no span.started event for the PROMPT root span")
	}
	var promptPayload map[string]any
	_ = json.Unmarshal(promptStart.Payload, &promptPayload)
	if promptPayload["span_kind"] != string(protocol.SpanKindWorkflow) {
		t.Fatalf("PROMPT span_kind = %v, want %s", promptPayload["span_kind"], protocol.SpanKindWorkflow)
	}
	if evalStart == nil {
		t.Fatal("no span.started event for the EVALUATOR span")
	}
	var evalPayload map[string]any
	_ = json.Unmarshal(evalStart.Payload, &evalPayload)
	if evalPayload["span_kind"] != string(protocol.SpanKindGuardrail) {
		t.Fatalf("EVALUATOR span_kind = %v, want %s", evalPayload["span_kind"], protocol.SpanKindGuardrail)
	}
}

// TestConvertDeterministicIDs proves re-import idempotency: the same
// telemetry converts to identical event ids even with a different capture
// clock, so the store never duplicates.
func TestConvertDeterministicIDs(t *testing.T) {
	a := convertFixture(t)
	later := fixedObserved().Add(3 * time.Hour)
	b, err := Convert(loadFixture(t), Options{ObservedAt: later})
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Events) != len(b.Events) {
		t.Fatalf("event counts differ: %d vs %d", len(a.Events), len(b.Events))
	}
	for i := range a.Events {
		if a.Events[i].EventID != b.Events[i].EventID {
			t.Fatalf("event %d id differs across conversions: %s vs %s",
				i, a.Events[i].EventID, b.Events[i].EventID)
		}
		if a.Events[i].OccurredAt != b.Events[i].OccurredAt {
			t.Fatalf("event %d occurred_at differs", i)
		}
	}
}

// TestConvertRejectsBadSpans fail-closed: malformed spans are reported and
// skipped; valid siblings still convert.
func TestConvertRejectsBadSpans(t *testing.T) {
	req := &ExportRequest{ResourceSpans: []ResourceSpans{{
		ScopeSpans: []ScopeSpans{{
			Spans: []Span{
				{
					TraceID: "nothex", SpanID: "b7ad6b7169203331",
					Name: "bad trace", Kind: json.RawMessage("1"),
					StartTimeUnixNano: "1756334400000000000", EndTimeUnixNano: "1756334400000000001",
				},
				{
					TraceID: "0af7651916cd43dd8448eb211c80319c", SpanID: "b7ad6b7169203331",
					Name: "bad attr", Kind: json.RawMessage("1"),
					StartTimeUnixNano: "1756334400000000000", EndTimeUnixNano: "1756334400000000001",
					Attributes: []KeyValue{{Key: "k", Value: &AnyValue{v: "bad-\xff-utf8"}}},
				},
				{
					TraceID: "0AF7651916CD43DD8448EB211C80319C", SpanID: "5B8EFFF798038103",
					Name: "uppercase ok", Kind: json.RawMessage("3"),
					StartTimeUnixNano: "1756334400000000000", EndTimeUnixNano: "1756334400000000001",
					Attributes: []KeyValue{{Key: "gen_ai.request.model", Value: &AnyValue{v: "gpt-5.3"}}},
				},
			},
		}},
	}}}
	res, err := Convert(req, Options{ObservedAt: fixedObserved()})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.SpanErrors) != 2 {
		t.Fatalf("span errors = %d, want 2", len(res.SpanErrors))
	}
	// Exactly one good span: started + completed + trace pair + session.
	if len(res.Events) != 5 {
		t.Fatalf("event count = %d, want 5", len(res.Events))
	}
	// Uppercase hex normalizes so ids derive from the lowercase form.
	found := false
	for _, ev := range res.Events {
		if ev.Model == "gpt-5.3" {
			found = true
		}
	}
	if !found {
		t.Fatal("valid uppercase-hex span did not convert")
	}
}

// TestMaterializeOTLPEvents proves converted events flow through the
// unchanged deterministic materializer into correct read models.
func TestMaterializeOTLPEvents(t *testing.T) {
	res := convertFixture(t)
	m := materialize(t, res.Events)
	if len(m.Traces) != 1 {
		t.Fatalf("traces = %d, want 1", len(m.Traces))
	}
	tr := m.Traces[0]
	if tr.Status != protocol.TraceOK {
		t.Fatalf("trace status = %s", tr.Status)
	}
	if tr.SpanCount != 3 || tr.FailedSpanCount != 1 {
		t.Fatalf("span counters = %d/%d, want 3/1", tr.SpanCount, tr.FailedSpanCount)
	}
	if tr.TokenInput == nil || *tr.TokenInput != 1200 {
		t.Fatalf("token_input = %v", tr.TokenInput)
	}
	if tr.DurationNS <= 0 {
		t.Fatalf("duration = %d", tr.DurationNS)
	}
	if len(m.Spans) != 3 {
		t.Fatalf("spans = %d, want 3", len(m.Spans))
	}
	var modelSpan *protocol.Span
	for _, sp := range m.Spans {
		if sp.Kind == protocol.SpanKindModel {
			modelSpan = sp
		}
	}
	if modelSpan == nil {
		t.Fatal("no MODEL span materialized")
	}
	if modelSpan.Status != "error" || modelSpan.Model != "gpt-5.3" {
		t.Fatalf("model span = %+v", modelSpan)
	}
	if modelSpan.EndedAtNS <= modelSpan.StartedAtNS {
		t.Fatal("model span duration not derived from span pair times")
	}
}

// TestHandlerIngestIdempotent runs the HTTP path twice against one store:
// the first POST appends, the second is a no-op (duplicate ids rejected).
func TestHandlerIngestIdempotent(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { db.Close() })
	h := &Handler{Append: db.AppendEvent}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	data, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}

	post := func() *http.Response {
		resp, err := http.Post(srv.URL+"/v1/traces", "application/json", strings.NewReader(string(data)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}

	resp := post()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first POST status = %d", resp.StatusCode)
	}
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 9 {
		t.Fatalf("event count after first POST = %d, want 9", n)
	}

	resp2 := post()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("second POST status = %d", resp2.StatusCode)
	}
	n2, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n2 != n {
		t.Fatalf("re-import duplicated events: %d -> %d", n, n2)
	}

	// Health and method/protocol discipline.
	health, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	health.Body.Close()
	if health.StatusCode != 200 {
		t.Fatalf("healthz = %d", health.StatusCode)
	}
	// The protobuf flavor is served now (see proto_test.go), so a protobuf
	// content type with a garbage body is a decode failure, not a media-type
	// refusal; anything that is neither flavor still gets 415.
	pbResp, err := http.Post(srv.URL+"/v1/traces", "application/x-protobuf", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	pbResp.Body.Close()
	if pbResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed protobuf POST = %d, want 400", pbResp.StatusCode)
	}
	xmlResp, err := http.Post(srv.URL+"/v1/traces", "application/xml", strings.NewReader("<spans/>"))
	if err != nil {
		t.Fatal(err)
	}
	xmlResp.Body.Close()
	if xmlResp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("xml POST = %d, want 415", xmlResp.StatusCode)
	}
	badResp, err := http.Post(srv.URL+"/v1/traces", "application/json", strings.NewReader("{nope"))
	if err != nil {
		t.Fatal(err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed POST = %d, want 400", badResp.StatusCode)
	}
}

// TestHandlerPartialSuccess reports rejected spans per the OTLP contract
// while persisting the valid remainder.
func TestHandlerPartialSuccess(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { db.Close() })
	h := &Handler{Append: db.AppendEvent}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	body := `{"resourceSpans":[{"scopeSpans":[{"spans":[
		{"traceId":"bad","spanId":"b7ad6b7169203331","name":"x","kind":1,"startTimeUnixNano":"1756334400000000000","endTimeUnixNano":"1756334400000000001"},
		{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"5b8efff798038103","name":"ok span","kind":1,"startTimeUnixNano":"1756334400000000000","endTimeUnixNano":"1756334400000000001"}
	]}]}]}`
	resp, err := http.Post(srv.URL+"/v1/traces", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 with partialSuccess", resp.StatusCode)
	}
	var out exportResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.PartialSuccess == nil || out.PartialSuccess.RejectedSpans != 1 {
		t.Fatalf("partialSuccess = %+v", out.PartialSuccess)
	}
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// ok span: started + completed + trace.started + trace.completed + session.started
	if n != 5 {
		t.Fatalf("event count = %d, want 5", n)
	}
}

// TestHandlerBackpressure answers 429 + Retry-After once the in-flight cap
// is exhausted, instead of queueing without bound.
func TestHandlerBackpressure(t *testing.T) {
	release := make(chan struct{})
	db := openTestDB(t)
	t.Cleanup(func() { db.Close() })
	h := &Handler{
		Append: func(ctx context.Context, ev *protocol.Event) (bool, error) {
			<-release // hold every append open
			return true, nil
		},
		MaxInFlight: 1,
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	data, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	done := make(chan int, 1)
	go func() {
		resp, err := http.Post(srv.URL+"/v1/traces", "application/json", strings.NewReader(body))
		if err != nil {
			done <- -1
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()

	// Deterministic saturation: wait until the first request has actually
	// acquired the single in-flight slot (it is blocked inside Append)
	// before attempting the second one. Waiting on the counter instead of
	// racing the scheduler makes the 429 guaranteed.
	satDeadline := time.Now().Add(5 * time.Second)
	for h.inFlight.Load() != 1 {
		if time.Now().After(satDeadline) {
			t.Fatal("first request never acquired the in-flight slot")
		}
		time.Sleep(5 * time.Millisecond)
	}

	second, err := http.Post(srv.URL+"/v1/traces", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("saturated POST = %d, want 429", second.StatusCode)
	}
	if second.Header.Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	second.Body.Close()
	close(release)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("first POST = %d, want 200", code)
	}
}
