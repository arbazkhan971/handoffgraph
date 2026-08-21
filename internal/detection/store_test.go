package detection

import (
	"context"
	"database/sql"
	"reflect"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	st, err := OpenStore(context.Background(), db)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	return st
}

func sampleMatch(ruleID, version, scopeID, groupKey string, at time.Time) *Match {
	return &Match{
		RuleID:        ruleID,
		RuleVersion:   version,
		Scope:         ScopeTrace,
		ScopeID:       scopeID,
		GroupKey:      groupKey,
		Severity:      SeverityError,
		Message:       "sample message",
		SpanIDs:       []string{"spn_1", "spn_2"},
		MatchCount:    2,
		EvidenceLevel: protocol.ProvenanceObserved,
		EvaluatedAt:   at,
	}
}

var storeClock = func() time.Time {
	return time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)
}

func TestEnsureSchemaIdempotent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := EnsureSchema(ctx, st.db); err != nil {
		t.Fatalf("second EnsureSchema: %v", err)
	}
	if err := EnsureSchema(ctx, st.db); err != nil {
		t.Fatalf("third EnsureSchema: %v", err)
	}
	var n int
	if err := st.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM detection_matches").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("fresh table has %d rows, want 0", n)
	}
}

func TestEnsureSchemaRejectsNilDB(t *testing.T) {
	if err := EnsureSchema(context.Background(), nil); err == nil {
		t.Fatal("EnsureSchema(nil) must fail")
	}
}

func TestSaveAndListMatches(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	at := storeClock()

	in := []*Match{
		sampleMatch("b-rule", "1.0.0", "trc_2", "spn_9", at),
		sampleMatch("a-rule", "1.0.0", "trc_1", "spn_1", at),
		sampleMatch("a-rule", "1.0.0", "trc_1", "spn_2", at),
	}
	if n, err := st.SaveMatches(ctx, in); err != nil {
		t.Fatalf("SaveMatches: %v", err)
	} else if n != 3 {
		t.Fatalf("inserted = %d, want 3", n)
	}

	out, err := st.ListMatches(ctx, MatchFilter{})
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(out) != 3 {
		t.Fatalf("len(out) = %d, want 3", len(out))
	}
	// Deterministic order: rule_id, rule_version, scope_id, group_key.
	want := []struct{ rule, scopeID, group string }{
		{"a-rule", "trc_1", "spn_1"},
		{"a-rule", "trc_1", "spn_2"},
		{"b-rule", "trc_2", "spn_9"},
	}
	for i, w := range want {
		m := out[i]
		if m.RuleID != w.rule || m.ScopeID != w.scopeID || m.GroupKey != w.group {
			t.Errorf("out[%d] = %s/%s/%s, want %s/%s/%s", i, m.RuleID, m.ScopeID, m.GroupKey, w.rule, w.scopeID, w.group)
		}
		if !m.EvaluatedAt.Equal(at) {
			t.Errorf("out[%d].EvaluatedAt = %v, want %v", i, m.EvaluatedAt, at)
		}
	}
	m := out[0]
	if !reflect.DeepEqual(m.SpanIDs, []string{"spn_1", "spn_2"}) {
		t.Errorf("SpanIDs = %v", m.SpanIDs)
	}
	if m.EvidenceLevel != protocol.ProvenanceObserved || m.Severity != SeverityError || m.MatchCount != 2 {
		t.Errorf("round-tripped match = %+v", m)
	}
}

func TestSaveMatchesTraceIDs(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	in := &Match{
		RuleID: "trace-rule", RuleVersion: "1.0.0", Scope: ScopeTrace,
		ScopeID: "trc_1", GroupKey: "trc_1", Severity: SeverityInfo, Message: "m",
		TraceIDs: []string{"trc_1"}, MatchCount: 1,
		EvidenceLevel: protocol.ProvenanceObserved, EvaluatedAt: storeClock(),
	}
	if _, err := st.SaveMatches(ctx, []*Match{in}); err != nil {
		t.Fatalf("SaveMatches: %v", err)
	}
	out, err := st.ListMatches(ctx, MatchFilter{})
	if err != nil || len(out) != 1 {
		t.Fatalf("ListMatches: %v (%d rows)", err, len(out))
	}
	if !reflect.DeepEqual(out[0].TraceIDs, []string{"trc_1"}) || out[0].SpanIDs != nil {
		t.Errorf("TraceIDs = %v, SpanIDs = %v", out[0].TraceIDs, out[0].SpanIDs)
	}
}

func TestSaveMatchesIdempotent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	m := sampleMatch("r", "1.0.0", "trc_1", "g", storeClock())

	if n, err := st.SaveMatches(ctx, []*Match{m}); err != nil || n != 1 {
		t.Fatalf("first save = %d, %v", n, err)
	}
	// Re-saving the same natural key with a later evaluated_at must be
	// ignored: the first evaluation wins.
	later := sampleMatch("r", "1.0.0", "trc_1", "g", storeClock().Add(time.Hour))
	if n, err := st.SaveMatches(ctx, []*Match{later}); err != nil {
		t.Fatalf("second save: %v", err)
	} else if n != 0 {
		t.Fatalf("second save inserted %d rows, want 0", n)
	}

	out, err := st.ListMatches(ctx, MatchFilter{})
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("rows = %d, want 1", len(out))
	}
	if !out[0].EvaluatedAt.Equal(storeClock()) {
		t.Errorf("EvaluatedAt = %v, want original %v (history must not rewrite)", out[0].EvaluatedAt, storeClock())
	}
}

func TestNewRuleVersionAppendsHistory(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	t0 := storeClock()
	t1 := t0.Add(2 * time.Hour)

	v1 := sampleMatch("r", "1.0.0", "trc_1", "g", t0)
	if _, err := st.SaveMatches(ctx, []*Match{v1}); err != nil {
		t.Fatalf("save v1: %v", err)
	}
	v2 := sampleMatch("r", "2.0.0", "trc_1", "g", t1)
	if n, err := st.SaveMatches(ctx, []*Match{v2}); err != nil || n != 1 {
		t.Fatalf("save v2 = %d, %v", n, err)
	}

	out, err := st.ListMatches(ctx, MatchFilter{})
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("rows = %d, want 2 (both versions retained)", len(out))
	}
	// Ordered by version: v1 first, with its original evaluation time.
	if out[0].RuleVersion != "1.0.0" || !out[0].EvaluatedAt.Equal(t0) {
		t.Errorf("row 0 = %s @%v, want 1.0.0 @%v", out[0].RuleVersion, out[0].EvaluatedAt, t0)
	}
	if out[1].RuleVersion != "2.0.0" || !out[1].EvaluatedAt.Equal(t1) {
		t.Errorf("row 1 = %s @%v, want 2.0.0 @%v", out[1].RuleVersion, out[1].EvaluatedAt, t1)
	}
}

func TestListMatchesFilters(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	at := storeClock()
	in := []*Match{
		sampleMatch("rule-a", "1.0.0", "trc_1", "g1", at),
		sampleMatch("rule-b", "1.0.0", "trc_1", "g2", at),
		sampleMatch("rule-b", "1.0.0", "trc_2", "g3", at),
	}
	if _, err := st.SaveMatches(ctx, in); err != nil {
		t.Fatalf("SaveMatches: %v", err)
	}

	tests := []struct {
		name   string
		filter MatchFilter
		want   []string // rule/scope pairs
	}{
		{name: "all", filter: MatchFilter{}, want: []string{"rule-a/trc_1", "rule-b/trc_1", "rule-b/trc_2"}},
		{name: "by rule", filter: MatchFilter{RuleID: "rule-a"}, want: []string{"rule-a/trc_1"}},
		{name: "by scope", filter: MatchFilter{ScopeID: "trc_2"}, want: []string{"rule-b/trc_2"}},
		{name: "both", filter: MatchFilter{RuleID: "rule-b", ScopeID: "trc_1"}, want: []string{"rule-b/trc_1"}},
		{name: "no match", filter: MatchFilter{RuleID: "rule-z"}, want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := st.ListMatches(ctx, tt.filter)
			if err != nil {
				t.Fatalf("ListMatches: %v", err)
			}
			var got []string
			for _, m := range out {
				got = append(got, m.RuleID+"/"+m.ScopeID)
			}
			if len(got) == 0 && len(tt.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestOpenStoreFile(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := dir + "/detect.db"

	st, err := OpenStoreFile(ctx, path)
	if err != nil {
		t.Fatalf("OpenStoreFile: %v", err)
	}
	if _, err := st.SaveMatches(ctx, []*Match{sampleMatch("r", "1.0.0", "trc_1", "g", storeClock())}); err != nil {
		t.Fatalf("SaveMatches: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen: schema is idempotent and the row survived.
	st2, err := OpenStoreFile(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer st2.Close()
	out, err := st2.ListMatches(ctx, MatchFilter{})
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("rows = %d, want 1", len(out))
	}
}

func TestOpenStoreFileRejectsEmptyPath(t *testing.T) {
	if _, err := OpenStoreFile(context.Background(), ""); err == nil {
		t.Fatal("OpenStoreFile(\"\") must fail")
	}
}
