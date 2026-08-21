package detection

import (
	"reflect"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

var fixedClock = func() time.Time {
	return time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
}

func intPtr(i int) *int { return &i }

func i64Ptr(i int64) *int64 { return &i }

func mkSpan(id, traceID string, kind protocol.SpanKind, name, status string) *protocol.Span {
	return &protocol.Span{
		SpanID:        id,
		TraceID:       traceID,
		Kind:          kind,
		Name:          name,
		Status:        status,
		Sequence:      1,
		EvidenceLevel: protocol.ProvenanceObserved,
	}
}

func newTestEngine(t *testing.T, rules ...*Rule) *Engine {
	t.Helper()
	e, err := NewEngine(rules, WithClock(fixedClock))
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	return e
}

func TestNewEngineRejectsInvalidRules(t *testing.T) {
	tests := []struct {
		name string
		rule *Rule
	}{
		{name: "nil rule", rule: nil},
		{name: "bad rule", rule: &Rule{ID: "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewEngine([]*Rule{tt.rule}); err == nil {
				t.Fatal("NewEngine accepted an invalid rule (fail-closed violation)")
			}
		})
	}
}

func TestEvaluateNonzeroCommandExit(t *testing.T) {
	rule := baseRule() // span.kind eq COMMAND && span.exit_code neq 0
	e := newTestEngine(t, rule)

	spans := []*protocol.Span{
		func() *protocol.Span {
			sp := mkSpan("spn_fail", "trc_1", protocol.SpanKindCommand, "make check", "error")
			sp.ExitCode = intPtr(2)
			return sp
		}(),
		func() *protocol.Span {
			sp := mkSpan("spn_ok", "trc_1", protocol.SpanKindCommand, "make check", "ok")
			sp.ExitCode = intPtr(0)
			return sp
		}(),
		func() *protocol.Span {
			sp := mkSpan("spn_nil", "trc_1", protocol.SpanKindCommand, "go build", "unknown")
			return sp // no exit code: neq must not fire (fail-closed)
		}(),
		func() *protocol.Span {
			sp := mkSpan("spn_tool", "trc_1", protocol.SpanKindTool, "exit helper", "error")
			sp.ExitCode = intPtr(1)
			return sp // wrong kind
		}(),
	}
	matches, err := e.Evaluate(Input{Traces: nil, Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("len(matches) = %d, want 1: %+v", len(matches), matches)
	}
	m := matches[0]
	if m.RuleID != rule.ID || m.RuleVersion != rule.Version {
		t.Errorf("match rule = %s/%s, want %s/%s", m.RuleID, m.RuleVersion, rule.ID, rule.Version)
	}
	if !reflect.DeepEqual(m.SpanIDs, []string{"spn_fail"}) {
		t.Errorf("SpanIDs = %v, want [spn_fail]", m.SpanIDs)
	}
	if m.Scope != ScopeTrace || m.ScopeID != "trc_1" {
		t.Errorf("scope = %s/%s, want trace/trc_1", m.Scope, m.ScopeID)
	}
	if m.GroupKey != "spn_fail" {
		t.Errorf("GroupKey = %q, want spn_fail", m.GroupKey)
	}
	if m.EvidenceLevel != protocol.ProvenanceObserved {
		t.Errorf("EvidenceLevel = %q, want OBSERVED", m.EvidenceLevel)
	}
	if !m.EvaluatedAt.Equal(fixedClock()) {
		t.Errorf("EvaluatedAt = %v, want %v", m.EvaluatedAt, fixedClock())
	}
}

func TestEvaluateWorkstreamGrouping(t *testing.T) {
	// Same failing fingerprint three times across two traces -> one
	// workstream-scope match with three span ids.
	rule := &Rule{
		ID:      "repeated-failing",
		Version: "1.0.0",
		Scope:   ScopeWorkstream,
		When: When{Conditions: []Condition{
			{Field: "span.status", Op: OpEq, Value: "error"},
			{Field: "span.command_fingerprint", Op: OpExists},
		}},
		GroupBy:   "span.command_fingerprint",
		Threshold: Threshold{CountGte: 3},
		Severity:  SeverityWarning,
		Message:   "repeated failure",
	}
	e := newTestEngine(t, rule)

	spans := []*protocol.Span{}
	for i, tc := range []struct{ id, trace string }{
		{"spn_a", "trc_1"}, {"spn_b", "trc_1"}, {"spn_c", "trc_2"},
	} {
		sp := mkSpan(tc.id, tc.trace, protocol.SpanKindCommand, "npm ci", "error")
		sp.CommandFingerprint = "sha256:npm-ci"
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}
	// Two failures only: below threshold.
	sp := mkSpan("spn_d", "trc_2", protocol.SpanKindCommand, "make", "error")
	sp.CommandFingerprint = "sha256:make"
	spans = append(spans, sp)

	matches, err := e.Evaluate(Input{WorkstreamID: "ws_1", Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("len(matches) = %d, want 1: %+v", len(matches), matches)
	}
	m := matches[0]
	if m.GroupKey != "sha256:npm-ci" {
		t.Errorf("GroupKey = %q, want sha256:npm-ci", m.GroupKey)
	}
	if m.MatchCount != 3 || !reflect.DeepEqual(m.SpanIDs, []string{"spn_a", "spn_b", "spn_c"}) {
		t.Errorf("MatchCount=%d SpanIDs=%v, want 3 [spn_a spn_b spn_c]", m.MatchCount, m.SpanIDs)
	}
	if m.Scope != ScopeWorkstream || m.ScopeID != "ws_1" {
		t.Errorf("scope = %s/%s, want workstream/ws_1", m.Scope, m.ScopeID)
	}
}

func TestEvaluatePerTraceGrouping(t *testing.T) {
	// likely-loop style rule: >= 5 same-name spans within ONE trace.
	rule := &Rule{
		ID:      "loop",
		Version: "1.0.0",
		Scope:   ScopeTrace,
		When: When{Conditions: []Condition{
			{Field: "span.kind", Op: OpNeq, Value: "WORKFLOW"},
			{Field: "span.kind", Op: OpNeq, Value: "AGENT"},
			{Field: "span.kind", Op: OpNeq, Value: "MODEL"},
		}},
		GroupBy:   "span.name",
		Threshold: Threshold{CountGte: 5},
		Severity:  SeverityWarning,
		Message:   "loop",
	}
	e := newTestEngine(t, rule)

	var spans []*protocol.Span
	for i := 0; i < 5; i++ {
		sp := mkSpan("spn_a"+string(rune('0'+i)), "trc_big", protocol.SpanKindTool, "read file", "ok")
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}
	for i := 0; i < 4; i++ {
		sp := mkSpan("spn_b"+string(rune('0'+i)), "trc_small", protocol.SpanKindTool, "read file", "ok")
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}
	// The same 5 occurrences spread over two traces must NOT group together.
	for i := 0; i < 3; i++ {
		sp := mkSpan("spn_c"+string(rune('0'+i)), "trc_split_a", protocol.SpanKindTool, "write file", "ok")
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}
	for i := 0; i < 2; i++ {
		sp := mkSpan("spn_d"+string(rune('0'+i)), "trc_split_b", protocol.SpanKindTool, "write file", "ok")
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}

	matches, err := e.Evaluate(Input{Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("len(matches) = %d, want 1 (only trc_big): %+v", len(matches), matches)
	}
	if matches[0].ScopeID != "trc_big" || matches[0].GroupKey != "read file" {
		t.Errorf("match = %s/%s, want trc_big/read file", matches[0].ScopeID, matches[0].GroupKey)
	}
	if matches[0].MatchCount != 5 {
		t.Errorf("MatchCount = %d, want 5", matches[0].MatchCount)
	}
}

func TestEvaluateTraceSubjectRules(t *testing.T) {
	rule := &Rule{
		ID:      "completion-claim",
		Version: "1.0.0",
		Scope:   ScopeTrace,
		When: When{Conditions: []Condition{
			{Field: "trace.status", Op: OpEq, Value: "OK"},
			{Field: "trace.verification_state", Op: OpNeq, Value: "verified"},
		}},
		GroupBy:   "trace.trace_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityWarning,
		Message:   "claim without verification",
	}
	e := newTestEngine(t, rule)

	traces := []*protocol.Trace{
		{TraceID: "trc_ok_verified", Status: protocol.TraceOK, VerificationState: protocol.VerificationVerified},
		{TraceID: "trc_ok_missing", Status: protocol.TraceOK, VerificationState: protocol.VerificationMissing},
		{TraceID: "trc_err_missing", Status: protocol.TraceError, VerificationState: protocol.VerificationMissing},
		{TraceID: "trc_ok_failed", Status: protocol.TraceOK, VerificationState: protocol.VerificationFailed},
		{TraceID: "trc_ok_noverif", Status: protocol.TraceOK, VerificationState: protocol.VerificationUnknown},
	}
	matches, err := e.Evaluate(Input{Traces: traces})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	wantIDs := []string{"trc_ok_failed", "trc_ok_missing", "trc_ok_noverif"}
	if len(matches) != len(wantIDs) {
		t.Fatalf("len(matches) = %d, want %d: %+v", len(matches), len(wantIDs), matches)
	}
	for i, m := range matches {
		if m.ScopeID != wantIDs[i] || m.GroupKey != wantIDs[i] {
			t.Errorf("matches[%d] = %s/%s, want %s", i, m.ScopeID, m.GroupKey, wantIDs[i])
		}
		if !reflect.DeepEqual(m.TraceIDs, []string{wantIDs[i]}) {
			t.Errorf("matches[%d].TraceIDs = %v", i, m.TraceIDs)
		}
		if m.SpanIDs != nil {
			t.Errorf("matches[%d].SpanIDs = %v, want nil", i, m.SpanIDs)
		}
	}
}

func TestEvaluateNumericAndExistsConditions(t *testing.T) {
	rule := &Rule{
		ID:      "slow-trace",
		Version: "1.0.0",
		Scope:   ScopeTrace,
		When: When{Conditions: []Condition{
			{Field: "trace.duration_ns", Op: OpExists},
			{Field: "trace.duration_ns", Op: OpGt, Value: 100},
		}},
		GroupBy:   "trace.trace_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityInfo,
		Message:   "slow",
	}
	e := newTestEngine(t, rule)

	traces := []*protocol.Trace{
		{TraceID: "trc_slow", DurationNS: 500},
		{TraceID: "trc_fast", DurationNS: 50},
		{TraceID: "trc_open"},                // duration 0: exists fails (no reliable data)
		{TraceID: "trc_zero", DurationNS: 0}, // explicitly zero: still absent
	}
	matches, err := e.Evaluate(Input{Traces: traces})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 || matches[0].ScopeID != "trc_slow" {
		t.Fatalf("matches = %+v, want single trc_slow", matches)
	}

	// lt mirrors gt.
	ltRule := *rule
	ltRule.ID = "fast-trace"
	ltRule.When.Conditions = []Condition{{Field: "trace.duration_ns", Op: OpLt, Value: 100}}
	ltRule.GroupBy = "trace.trace_id"
	e2 := newTestEngine(t, &ltRule)
	matches, err = e2.Evaluate(Input{Traces: traces})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 || matches[0].ScopeID != "trc_fast" {
		t.Fatalf("matches = %+v, want single trc_fast", matches)
	}
}

func TestEvaluateTokenFields(t *testing.T) {
	rule := &Rule{
		ID:      "token-heavy",
		Version: "1.0.0",
		Scope:   ScopeWorkstream,
		When: When{Conditions: []Condition{
			{Field: "trace.token_total", Op: OpGt, Value: 1000},
		}},
		GroupBy:   "trace.trace_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityInfo,
		Message:   "token heavy",
	}
	e := newTestEngine(t, rule)

	traces := []*protocol.Trace{
		{TraceID: "trc_tokens", TokenInput: i64Ptr(700), TokenOutput: i64Ptr(400)}, // 1100 > 1000
		{TraceID: "trc_small", TokenInput: i64Ptr(100)},                            // 100
		{TraceID: "trc_none"}, // no token data: absent
	}
	matches, err := e.Evaluate(Input{WorkstreamID: "ws_tok", Traces: traces})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 || matches[0].TraceIDs[0] != "trc_tokens" {
		t.Fatalf("matches = %+v, want single trc_tokens", matches)
	}
	if matches[0].ScopeID != "ws_tok" {
		t.Errorf("ScopeID = %q, want ws_tok (workstream window)", matches[0].ScopeID)
	}
}

func TestEvaluateSecretMatch(t *testing.T) {
	rule := &Rule{
		ID:      "secret-blocker",
		Version: "1.0.0",
		Scope:   ScopeWorkstream,
		When: When{Conditions: []Condition{
			{Field: "span.secret_match", Op: OpEq, Value: true},
		}},
		GroupBy:   "span.span_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityCritical,
		Message:   "secret",
	}
	e := newTestEngine(t, rule)

	spans := []*protocol.Span{
		mkSpan("spn_secret", "trc_1", protocol.SpanKindTool, "AKIAIOSFODNN7EXAMPLE", "ok"),
		mkSpan("spn_plain", "trc_1", protocol.SpanKindTool, "read src/app.go", "ok"),
	}
	matches, err := e.Evaluate(Input{Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 || matches[0].GroupKey != "spn_secret" {
		t.Fatalf("matches = %+v, want single spn_secret", matches)
	}
	if matches[0].Severity != SeverityCritical {
		t.Errorf("severity = %q, want critical", matches[0].Severity)
	}
}

func TestEvaluateDeterministic(t *testing.T) {
	rules := DefaultPack()
	e := newTestEngine(t, rules...)

	spans := []*protocol.Span{}
	for i := 0; i < 6; i++ {
		sp := mkSpan("spn_loop"+string(rune('0'+i)), "trc_1", protocol.SpanKindTool, "repeat me", "ok")
		sp.Sequence = int64(i)
		spans = append(spans, sp)
	}
	cmd := mkSpan("spn_cmd", "trc_1", protocol.SpanKindCommand, "make check", "error")
	cmd.ExitCode = intPtr(2)
	spans = append(spans, cmd)
	traces := []*protocol.Trace{
		{TraceID: "trc_1", WorkstreamID: "ws_1", Status: protocol.TraceOK, VerificationState: protocol.VerificationMissing, SpanCount: 7},
	}

	run := func(shuffle bool) []*Match {
		in := Input{WorkstreamID: "ws_1", Traces: traces, Spans: spans}
		if shuffle {
			in.Spans = shuffledCopy(in.Spans)
			in.Traces = []*protocol.Trace{traces[0]}
		}
		ms, err := e.Evaluate(in)
		if err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
		return ms
	}

	first := run(false)
	second := run(true)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("Evaluate not deterministic across runs and input orderings")
	}
	if len(first) == 0 {
		t.Fatal("expected at least one match from the default pack")
	}
}

// shuffledCopy reverses a copy of the slice to prove order independence.
func shuffledCopy(spans []*protocol.Span) []*protocol.Span {
	out := append([]*protocol.Span(nil), spans...)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func TestEvaluateSortedByRuleIDGroupKey(t *testing.T) {
	mk := func(id string) *Rule {
		return &Rule{
			ID: id, Version: "1.0.0", Scope: ScopeTrace,
			When:      When{Conditions: []Condition{{Field: "span.name", Op: OpExists}}},
			GroupBy:   "span.name",
			Threshold: Threshold{CountGte: 1},
			Severity:  SeverityInfo,
			Message:   "m",
		}
	}
	e := newTestEngine(t, mk("b-rule"), mk("a-rule"))

	spans := []*protocol.Span{
		mkSpan("spn_1", "trc_1", protocol.SpanKindTool, "zzz", "ok"),
		mkSpan("spn_2", "trc_1", protocol.SpanKindTool, "aaa", "ok"),
	}
	matches, err := e.Evaluate(Input{Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	want := []struct{ rule, group string }{
		{"a-rule", "aaa"},
		{"a-rule", "zzz"},
		{"b-rule", "aaa"},
		{"b-rule", "zzz"},
	}
	if len(matches) != len(want) {
		t.Fatalf("len(matches) = %d, want %d", len(matches), len(want))
	}
	for i, w := range want {
		if matches[i].RuleID != w.rule || matches[i].GroupKey != w.group {
			t.Errorf("matches[%d] = %s/%s, want %s/%s", i, matches[i].RuleID, matches[i].GroupKey, w.rule, w.group)
		}
	}
}

func TestEvaluateEmptyInput(t *testing.T) {
	e := newTestEngine(t, DefaultPack()...)
	matches, err := e.Evaluate(Input{})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("len(matches) = %d, want 0", len(matches))
	}
}

func TestEvaluateSpansOfUnknownTraceFormOwnUnit(t *testing.T) {
	// A span whose trace id matches no materialized trace still forms its
	// own evaluation unit (evidence is not silently dropped).
	rule := baseRule()
	cmd := mkSpan("spn_orphan", "trc_ghost", protocol.SpanKindCommand, "make check", "error")
	cmd.ExitCode = intPtr(1)

	e := newTestEngine(t, rule)
	matches, err := e.Evaluate(Input{Spans: []*protocol.Span{cmd}})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 1 || matches[0].ScopeID != "trc_ghost" {
		t.Fatalf("matches = %+v, want one match scoped to trc_ghost", matches)
	}
}
