package detection

import (
	"reflect"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestDefaultPackHasTenLaunchRules(t *testing.T) {
	rules := DefaultPack()
	want := []string{
		"compaction-before-checkpoint",
		"completion-claim-without-verification",
		"concurrent-file-touch",
		"failed-test",
		"likely-loop",
		"nonzero-command-exit",
		"repeated-failing-operation",
		"repo-drift-from-checkpoint",
		"secret-match-blocker",
		"token-latency-threshold",
	}
	got := make([]string, 0, len(rules))
	for _, r := range rules {
		got = append(got, r.ID)
	}
	// The comparison is order-insensitive for readability; ParseRules
	// preserves document order.
	if !reflect.DeepEqual(sortStrings(got), sortStrings(want)) {
		t.Fatalf("pack ids = %v, want %v", got, want)
	}
}

func sortStrings(s []string) []string {
	out := append([]string(nil), s...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func TestDefaultPackRulesValidate(t *testing.T) {
	for _, r := range DefaultPack() {
		if err := r.Validate(); err != nil {
			t.Errorf("rule %s: Validate() = %v, want nil", r.ID, err)
		}
	}
}

func TestDefaultPackSmoke(t *testing.T) {
	// A trace with a failing command, a failing test, five repeated tool
	// names, two writes to one file, and a completion claim without
	// verification must fire the corresponding rules.
	e, err := NewEngine(DefaultPack(), WithClock(fixedClock))
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}

	var spans []*protocol.Span
	cmd := mkSpan("spn_cmd", "trc_x", protocol.SpanKindCommand, "npm test", "error")
	cmd.ExitCode = intPtr(2)
	spans = append(spans, cmd)
	test := mkSpan("spn_test", "trc_x", protocol.SpanKindTest, "TestCheckout", "error")
	spans = append(spans, test)
	for i := 0; i < 5; i++ {
		sp := mkSpan("spn_loop"+string(rune('0'+i)), "trc_x", protocol.SpanKindTool, "read cfg", "ok")
		spans = append(spans, sp)
	}
	for _, id := range []string{"spn_w1", "spn_w2"} {
		spans = append(spans, mkSpan(id, "trc_x", protocol.SpanKindFileWrite, "src/app.go", "ok"))
	}

	traces := []*protocol.Trace{{
		TraceID: "trc_x", WorkstreamID: "ws_x", Status: protocol.TraceOK,
		VerificationState: protocol.VerificationMissing, SpanCount: 9, ChangedFileCount: 2,
	}}

	matches, err := e.Evaluate(Input{WorkstreamID: "ws_x", Traces: traces, Spans: spans})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	got := map[string]*Match{}
	for _, m := range matches {
		got[m.RuleID] = m
	}
	for _, want := range []string{
		"nonzero-command-exit",
		"failed-test",
		"likely-loop",
		"concurrent-file-touch",
		"completion-claim-without-verification",
	} {
		m, ok := got[want]
		if !ok {
			t.Errorf("rule %q did not fire; matches: %+v", want, matches)
			continue
		}
		if m.EvidenceLevel != protocol.ProvenanceObserved {
			t.Errorf("rule %q evidence level = %q, want OBSERVED", want, m.EvidenceLevel)
		}
		if m.RuleVersion != "1.0.0" {
			t.Errorf("rule %q version = %q, want 1.0.0", want, m.RuleVersion)
		}
	}

	if m := got["likely-loop"]; m != nil && m.MatchCount != 5 {
		t.Errorf("likely-loop MatchCount = %d, want 5", m.MatchCount)
	}
	if m := got["concurrent-file-touch"]; m != nil && (m.MatchCount != 2 || m.GroupKey != "src/app.go") {
		t.Errorf("concurrent-file-touch = %+v, want 2x src/app.go", m)
	}
}

func TestDefaultPackNegativeControl(t *testing.T) {
	// A clean trace with a passing test and verified state fires none of
	// the launch rules.
	e, err := NewEngine(DefaultPack(), WithClock(fixedClock))
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	cmd := mkSpan("spn_cmd", "trc_clean", protocol.SpanKindCommand, "go build ./...", "ok")
	cmd.ExitCode = intPtr(0)
	test := mkSpan("spn_test", "trc_clean", protocol.SpanKindTest, "TestAll", "ok")

	traces := []*protocol.Trace{{
		TraceID: "trc_clean", WorkstreamID: "ws_c", Status: protocol.TraceOK,
		VerificationState: protocol.VerificationVerified,
	}}
	matches, err := e.Evaluate(Input{WorkstreamID: "ws_c", Traces: traces, Spans: []*protocol.Span{cmd, test}})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("matches = %+v, want none", matches)
	}
}

func TestDefaultPackCopiesSlice(t *testing.T) {
	a := DefaultPack()
	if len(a) != len(defaultPack) {
		t.Fatalf("len = %d, want %d", len(a), len(defaultPack))
	}
	a[0] = nil // mutating the copy must not corrupt the shared pack
	if defaultPack[0] == nil {
		t.Fatal("DefaultPack returned a shared slice")
	}
}
