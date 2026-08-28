package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The tests in this file cover the derived-table storage added by
// parity-plan rows 5, 12 and 13: promoted columns and their indexes, the
// coalescing verdict columns, and the exception_groups table.

func promotedRows() []ObsRow {
	base := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC).UnixNano()
	return []ObsRow{
		{SpanID: "spn_tool", TraceID: "trc_a", SessionID: "ses_a", WorkstreamID: "ws_a",
			Provider: "claude", Agent: "claude-code", Model: "opus", Kind: "TOOL",
			Name: "Bash", Status: "ok", ToolName: "Bash", StartedAtNS: base,
			EndedAtNS: base + 1e9, DurationNS: 1e9, Sequence: 1, Fingerprint: "fp1",
			ToolNameExists: true, ModelExists: true,
			SignalSource: "hook", CoalesceKey: "claude\x00nat1", CanonicalSessionID: "ses_a"},
		{SpanID: "spn_err", TraceID: "trc_a", SessionID: "ses_a", WorkstreamID: "ws_a",
			Provider: "claude", Agent: "claude-code", Model: "opus", Kind: "MODEL",
			Name: "chat", Status: "error", StartedAtNS: base + int64(2e9),
			EndedAtNS: base + int64(3e9), DurationNS: 1e9, Sequence: 2, Fingerprint: "fp1",
			Failed: true, ErrorType: "RateLimitError", ErrorExists: true,
			ModelExists: true, UsageExists: true,
			SignalSource: "native", CoalesceKey: "claude\x00nat1", CanonicalSessionID: "ses_a"},
		{SpanID: "spn_dup", TraceID: "trc_b", SessionID: "ses_b", WorkstreamID: "ws_a",
			Provider: "claude", Agent: "claude-code", Model: "opus", Kind: "TOOL",
			Name: "Bash", Status: "ok", ToolName: "Bash", StartedAtNS: base,
			EndedAtNS: base + 1e9, DurationNS: 1e9, Sequence: 3, Fingerprint: "fp1",
			ToolNameExists: true, ModelExists: true, Shadowed: true,
			SignalSource: "sdk", CoalesceKey: "claude\x00nat1", CanonicalSessionID: "ses_a"},
	}
}

func excGroups() []ExceptionGroup {
	base := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC).UnixNano()
	return []ExceptionGroup{
		{GroupHash: "aaa1", WorkstreamID: "ws_a", ErrorType: "RateLimitError",
			MessageTemplate: "rate limited after <num> retries", TopFrame: "client.go:<num>",
			FirstSeenNS: base, LastSeenNS: base + int64(9e9), SpanCount: 4, SampleSpanID: "spn_err"},
		{GroupHash: "bbb2", WorkstreamID: "ws_a", ErrorType: "TimeoutError",
			MessageTemplate: "deadline exceeded", FirstSeenNS: base, LastSeenNS: base,
			SpanCount: 9, SampleSpanID: "spn_to"},
		{GroupHash: "ccc3", WorkstreamID: "ws_b", ErrorType: "TimeoutError",
			MessageTemplate: "deadline exceeded", FirstSeenNS: base, LastSeenNS: base,
			SpanCount: 1, SampleSpanID: "spn_x"},
	}
}

func seedPromoted(t *testing.T) (*DB, context.Context) {
	t.Helper()
	db := openDB(t)
	ctx := context.Background()
	if err := db.RebuildObservations(ctx, promotedRows(), nil, excGroups(), snapshot(t, db)); err != nil {
		t.Fatal(err)
	}
	return db, ctx
}

// TestPromotedColumnsRoundTrip: every promoted column and coalescing verdict
// survives a write/read cycle.
func TestPromotedColumnsRoundTrip(t *testing.T) {
	db, ctx := seedPromoted(t)

	got, err := db.QueryObservations(ctx, ObsFilter{ToolName: "Bash"})
	if err != nil {
		t.Fatal(err)
	}
	// spn_dup carries the same tool but is shadowed, so it is hidden.
	if len(got) != 1 || got[0].SpanID != "spn_tool" {
		t.Fatalf("--tool query = %+v, want only spn_tool", got)
	}
	if !got[0].ToolNameExists || !got[0].ModelExists || got[0].ErrorExists {
		t.Fatalf("exists markers not round-tripped: %+v", got[0])
	}
	if got[0].SignalSource != "hook" || got[0].CanonicalSessionID != "ses_a" {
		t.Fatalf("coalescing columns not round-tripped: %+v", got[0])
	}

	yes := true
	got, err = db.QueryObservations(ctx, ObsFilter{HasError: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ErrorType != "RateLimitError" || !got[0].UsageExists {
		t.Fatalf("--has-error query = %+v", got)
	}

	got, err = db.QueryObservations(ctx, ObsFilter{SignalSource: "native"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SpanID != "spn_err" {
		t.Fatalf("--signal-source native = %+v", got)
	}
}

// TestShadowedHiddenByDefault: shadowed rows are retained in the table and
// revealed only on request — the verdict is recorded, the evidence is kept.
func TestShadowedHiddenByDefault(t *testing.T) {
	db, ctx := seedPromoted(t)

	got, err := db.QueryObservations(ctx, ObsFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("default query returned %d rows, want 2 (shadowed hidden)", len(got))
	}
	for _, r := range got {
		if r.Shadowed {
			t.Fatalf("shadowed row %s leaked into the default listing", r.SpanID)
		}
	}

	got, err = db.QueryObservations(ctx, ObsFilter{IncludeShadowed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("--include-shadowed returned %d rows, want 3", len(got))
	}
	var sawShadow bool
	for _, r := range got {
		if r.SpanID == "spn_dup" {
			sawShadow = r.Shadowed
		}
	}
	if !sawShadow {
		t.Fatal("spn_dup must be present and flagged shadowed with --include-shadowed")
	}
}

// TestPromotedFiltersUseIndex asserts the whole point of promotion: a hot
// filter resolves through an index instead of scanning the wide table.
func TestPromotedFiltersUseIndex(t *testing.T) {
	db, ctx := seedPromoted(t)

	yes := true
	cases := []struct {
		name  string
		f     ObsFilter
		index string
	}{
		{"tool", ObsFilter{ToolName: "Bash"}, "idx_obs_tool"},
		{"model", ObsFilter{Model: "opus"}, "idx_obs_model"},
		{"has-error", ObsFilter{HasError: &yes}, "idx_obs_error"},
		{"error-type", ObsFilter{ErrorType: "RateLimitError"}, "idx_obs_etype"},
		{"signal-source", ObsFilter{SignalSource: "native"}, "idx_obs_signal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := db.ExplainObservations(ctx, tc.f)
			if err != nil {
				t.Fatal(err)
			}
			joined := strings.Join(plan, "\n")
			if strings.Contains(joined, "SCAN span_observations") &&
				!strings.Contains(joined, "USING INDEX") {
				t.Fatalf("filter degraded to a full scan:\n%s", joined)
			}
			if !strings.Contains(joined, tc.index) {
				t.Fatalf("plan does not use %s:\n%s", tc.index, joined)
			}
		})
	}
}

// TestExceptionGroupsOrdering pins the listing contract: span_count
// descending, group_hash breaking ties, filters on workstream and type.
func TestExceptionGroupsOrdering(t *testing.T) {
	db, ctx := seedPromoted(t)

	got, err := db.ListExceptionGroups(ctx, ExceptionFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("groups = %d, want 3", len(got))
	}
	if got[0].GroupHash != "bbb2" || got[0].SpanCount != 9 {
		t.Fatalf("most frequent group must come first, got %+v", got[0])
	}
	if got[1].SpanCount < got[2].SpanCount {
		t.Fatalf("groups not sorted by span_count desc: %+v", got)
	}

	got, err = db.ListExceptionGroups(ctx, ExceptionFilter{WorkstreamID: "ws_b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].GroupHash != "ccc3" {
		t.Fatalf("workstream filter = %+v", got)
	}

	got, err = db.ListExceptionGroups(ctx, ExceptionFilter{ErrorType: "RateLimitError"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].MessageTemplate != "rate limited after <num> retries" {
		t.Fatalf("error-type filter = %+v", got)
	}
}

// TestExceptionGroupsRebuiltNotMutated: a rebuild replaces the derived table
// wholesale, so a group that no longer occurs disappears instead of lingering.
func TestExceptionGroupsRebuiltNotMutated(t *testing.T) {
	db, ctx := seedPromoted(t)
	if err := db.RebuildObservations(ctx, promotedRows(), nil, excGroups()[:1], snapshot(t, db)); err != nil {
		t.Fatal(err)
	}
	got, err := db.ListExceptionGroups(ctx, ExceptionFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].GroupHash != "aaa1" {
		t.Fatalf("rebuild did not replace the derived table: %+v", got)
	}
}

// TestMigrations10And11ApplyOnV9 builds a database frozen at schema version 9
// (the shape shipped before this slice), reopens it through the normal Open
// path, and asserts migrations 10 and 11 apply cleanly on top of existing
// rows without rewriting them.
func TestMigrations10And11ApplyOnV9(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v9.db")
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	raw, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations {
		if m.version > 9 {
			continue
		}
		if _, err := raw.Exec(m.sql); err != nil {
			raw.Close()
			t.Fatalf("seed migration %d: %v", m.version, err)
		}
		if _, err := raw.Exec(
			"INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)",
			m.version, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			raw.Close()
			t.Fatalf("record migration %d: %v", m.version, err)
		}
	}
	// A pre-existing row must survive the upgrade with defaulted new columns.
	if _, err := raw.Exec(`
INSERT INTO span_observations
    (span_id, trace_id, kind, name, status, started_at_ns, sequence, failed,
     fingerprint, ts_bucket)
VALUES ('spn_old','trc_old','TOOL','Bash','ok',1,1,0,'fp_old',0)`); err != nil {
		raw.Close()
		t.Fatalf("seed v9 row: %v", err)
	}
	if _, err := raw.Exec("PRAGMA user_version = 9"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("migrating a v9 database: %v", err)
	}
	defer db.Close()

	v, err := db.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v != len(migrations) {
		t.Fatalf("schema version after upgrade = %d, want %d", v, len(migrations))
	}

	ctx := context.Background()
	got, err := db.QueryObservations(ctx, ObsFilter{})
	if err != nil {
		t.Fatalf("querying an upgraded v9 row: %v", err)
	}
	if len(got) != 1 || got[0].SpanID != "spn_old" {
		t.Fatalf("pre-existing row lost across migration: %+v", got)
	}
	if got[0].SignalSource != string("import") || got[0].Shadowed {
		t.Fatalf("new columns did not default safely: %+v", got[0])
	}
	if _, err := db.ListExceptionGroups(ctx, ExceptionFilter{}); err != nil {
		t.Fatalf("exception_groups not created by migration 11: %v", err)
	}
}
