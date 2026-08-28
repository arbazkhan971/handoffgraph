package commands

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file drive the coalescing and promotion surface through
// the public CLI: `query spans` filters, `query exceptions`, and the
// `sessions` listing. Every test seeds the same database the commands open
// under an isolated HFG_DATA_DIR.

var coalesceAt = time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)

type seedSpan struct {
	provider  string
	agent     string
	sessionID string
	nativeID  string
	traceID   string
	spanID    string
	name      string
	kind      string
	toolName  string
	attrs     map[string]any
	failed    bool
	errorText string
	at        time.Time
}

func appendJSON(t *testing.T, db *storage.DB, ev *protocol.Event, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	ev.Payload = raw
	if _, err := db.AppendEvent(context.Background(), ev); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
}

// seedSpanEvents writes a trace with one span, in the shape the pipeline
// described by s would have produced.
func seedSpanEvents(t *testing.T, db *storage.DB, s seedSpan, seq int64) {
	t.Helper()
	mk := func(kind protocol.EventKind, at time.Time) *protocol.Event {
		seq++
		return &protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			EventID:         ids.Event(),
			Sequence:        seq,
			OccurredAt:      at,
			ObservedAt:      at,
			WorkstreamID:    "ws_cli",
			SessionID:       s.sessionID,
			NativeSessionID: s.nativeID,
			Provider:        s.provider,
			Agent:           s.agent,
			Model:           "claude-opus",
			Kind:            kind,
			Provenance:      protocol.ProvenanceObserved,
		}
	}
	appendJSON(t, db, mk(protocol.EventTraceStarted, s.at),
		map[string]any{"trace_id": s.traceID})
	appendJSON(t, db, mk(protocol.EventSpanStarted, s.at.Add(time.Second)),
		map[string]any{"span_id": s.spanID, "span_kind": s.kind, "name": s.name,
			"trace_id": s.traceID, "tool_name": s.toolName})
	end := map[string]any{"span_id": s.spanID, "trace_id": s.traceID}
	if s.attrs != nil {
		end["attributes"] = s.attrs
	}
	endKind := protocol.EventSpanCompleted
	if s.failed {
		endKind = protocol.EventSpanFailed
		end["error"] = s.errorText
	}
	appendJSON(t, db, mk(endKind, s.at.Add(2*time.Second)), end)
	appendJSON(t, db, mk(protocol.EventTraceCompleted, s.at.Add(3*time.Second)),
		map[string]any{"trace_id": s.traceID})
}

// seedCoalescedRun writes one logical claude-code run observed three ways:
// the vendor's native OTel export, our hook adapter, and an SDK wrapper.
func seedCoalescedRun(t *testing.T) {
	t.Helper()
	seedEvents(t, func(db *storage.DB) {
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderOTLP, agent: "claude-code",
			sessionID: "ses_native", nativeID: "nat-1", traceID: "trc_native",
			spanID: "spn_native", name: "Bash", kind: "TOOL", toolName: "Bash",
			attrs: map[string]any{"otlp.scope.name": "com.anthropic.claude_code"},
			at:    coalesceAt,
		}, 0)
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_hook", nativeID: "nat-1", traceID: "trc_hook",
			spanID: "spn_hook", name: "Bash", kind: "TOOL", toolName: "Bash",
			at: coalesceAt,
		}, 100)
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderOTLP, agent: "claude-code",
			sessionID: "ses_sdk", nativeID: "nat-1", traceID: "trc_sdk",
			spanID: "spn_sdk", name: "Bash", kind: "TOOL", toolName: "Bash",
			attrs: map[string]any{"telemetry.sdk.name": "opentelemetry"},
			at:    coalesceAt,
		}, 200)
	})
}

func queryRows(t *testing.T, out string) []storage.ObsRow {
	t.Helper()
	var rows []storage.ObsRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("query output is not valid JSON: %v\n%s", err, out)
	}
	return rows
}

// TestQuerySpansHidesShadowed: the default listing presents one canonical
// observation per logical span; --include-shadowed reveals the duplicates
// that were kept but marked.
func TestQuerySpansHidesShadowed(t *testing.T) {
	seedCoalescedRun(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "query", "spans", "--json")
	if err != nil {
		t.Fatalf("query spans: %v", err)
	}
	rows := queryRows(t, out)
	if len(rows) != 1 {
		t.Fatalf("default listing = %d rows, want 1 canonical observation\n%s", len(rows), out)
	}
	if rows[0].SpanID != "spn_native" || rows[0].SignalSource != "native" {
		t.Fatalf("canonical row = %+v, want the native observation", rows[0])
	}
	if rows[0].CanonicalSessionID != "ses_native" {
		t.Fatalf("canonical session = %q, want ses_native", rows[0].CanonicalSessionID)
	}

	out, _, err = runRegisteredApp(app, "query", "spans", "--include-shadowed", "--json")
	if err != nil {
		t.Fatalf("query spans --include-shadowed: %v", err)
	}
	rows = queryRows(t, out)
	if len(rows) != 3 {
		t.Fatalf("--include-shadowed = %d rows, want 3 (nothing is deleted)\n%s", len(rows), out)
	}
	shadowed := 0
	for _, r := range rows {
		if r.Shadowed {
			shadowed++
		}
	}
	if shadowed != 2 {
		t.Fatalf("shadowed rows = %d, want 2", shadowed)
	}
}

// TestQuerySpansSignalSourceFilter exercises the --signal-source filter,
// including its rejection of an unknown source.
func TestQuerySpansSignalSourceFilter(t *testing.T) {
	seedCoalescedRun(t)
	app := newRegisteredApp(t)

	// A shadowed source yields nothing until shadowed rows are revealed.
	out, _, err := runRegisteredApp(app, "query", "spans", "--signal-source", "hook", "--json")
	if err != nil {
		t.Fatalf("query spans --signal-source hook: %v", err)
	}
	if rows := queryRows(t, out); len(rows) != 0 {
		t.Fatalf("hook rows are shadowed and must be hidden by default: %+v", rows)
	}

	out, _, err = runRegisteredApp(app, "query", "spans",
		"--signal-source", "hook", "--include-shadowed", "--json")
	if err != nil {
		t.Fatalf("query spans --signal-source hook --include-shadowed: %v", err)
	}
	rows := queryRows(t, out)
	if len(rows) != 1 || rows[0].SpanID != "spn_hook" {
		t.Fatalf("hook filter = %+v", rows)
	}

	if _, _, err := runRegisteredApp(app, "query", "spans", "--signal-source", "telepathy"); err == nil {
		t.Fatal("an unknown signal source must be rejected")
	}
}

// TestQuerySpansPromotedFilters covers the row-12 filters end to end.
func TestQuerySpansPromotedFilters(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_a", nativeID: "nat-a", traceID: "trc_a",
			spanID: "spn_bash", name: "Bash", kind: "TOOL", toolName: "Bash",
			at: coalesceAt,
		}, 0)
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_a", nativeID: "nat-a", traceID: "trc_b",
			spanID: "spn_read", name: "Read", kind: "TOOL", toolName: "Read",
			at: coalesceAt.Add(time.Minute),
		}, 100)
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_a", nativeID: "nat-a", traceID: "trc_c",
			spanID: "spn_fail", name: "chat", kind: "MODEL",
			failed: true, errorText: "rate limited",
			attrs: map[string]any{
				"exception.type":    "RateLimitError",
				"exception.message": "rate limited after 3 retries",
			},
			at: coalesceAt.Add(2 * time.Minute),
		}, 200)
	})
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "query", "spans", "--tool", "Bash", "--json")
	if err != nil {
		t.Fatalf("query spans --tool: %v", err)
	}
	rows := queryRows(t, out)
	if len(rows) != 1 || rows[0].SpanID != "spn_bash" || !rows[0].ToolNameExists {
		t.Fatalf("--tool Bash = %+v", rows)
	}

	out, _, err = runRegisteredApp(app, "query", "spans", "--has-error", "--json")
	if err != nil {
		t.Fatalf("query spans --has-error: %v", err)
	}
	rows = queryRows(t, out)
	if len(rows) != 1 || rows[0].ErrorType != "RateLimitError" {
		t.Fatalf("--has-error = %+v", rows)
	}

	out, _, err = runRegisteredApp(app, "query", "spans", "--model", "claude-opus", "--json")
	if err != nil {
		t.Fatalf("query spans --model: %v", err)
	}
	if rows = queryRows(t, out); len(rows) != 3 {
		t.Fatalf("--model = %d rows, want 3", len(rows))
	}
}

// TestQueryExceptions covers row 13 through the CLI: two runs of one bug
// whose messages differ only in their variable parts land in a single group.
func TestQueryExceptions(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		for i, msg := range []string{
			"timed out after 30000ms (request 4f8a2b1c-9d3e-4a5b-8c7d-1e2f3a4b5c6d)",
			"timed out after 45000ms (request 11112222-3333-4444-5555-666677778888)",
		} {
			seedSpanEvents(t, db, seedSpan{
				provider: protocol.ProviderClaude, agent: "claude-code",
				sessionID: "ses_a", nativeID: "nat-a",
				traceID: "trc_t" + string(rune('a'+i)),
				spanID:  "spn_t" + string(rune('a'+i)),
				name:    "chat", kind: "MODEL", failed: true, errorText: "timeout",
				attrs: map[string]any{
					"exception.type":       "TimeoutError",
					"exception.message":    msg,
					"exception.stacktrace": "at internal/client/retry.go:118\nat main.go:9",
				},
				at: coalesceAt.Add(time.Duration(i) * time.Minute),
			}, int64(i*100))
		}
		// A second, different failure must land in its own group.
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_a", nativeID: "nat-a", traceID: "trc_other",
			spanID: "spn_other", name: "chat", kind: "MODEL",
			failed: true, errorText: "connection refused",
			attrs: map[string]any{"exception.type": "ConnError"},
			at:    coalesceAt.Add(5 * time.Minute),
		}, 500)
	})
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "query", "exceptions", "--json")
	if err != nil {
		t.Fatalf("query exceptions: %v", err)
	}
	var groups []storage.ExceptionGroup
	if err := json.Unmarshal([]byte(out), &groups); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2\n%s", len(groups), out)
	}
	// Most frequent first.
	if groups[0].ErrorType != "TimeoutError" || groups[0].SpanCount != 2 {
		t.Fatalf("first group = %+v, want the 2-span TimeoutError group", groups[0])
	}
	if groups[0].MessageTemplate != "timed out after <num>ms (request <uuid>)" {
		t.Fatalf("template = %q", groups[0].MessageTemplate)
	}
	if groups[0].FirstSeenNS >= groups[0].LastSeenNS {
		t.Fatalf("first/last seen not spread across the two occurrences: %+v", groups[0])
	}
	if len(groups[0].GroupHash) != 64 {
		t.Fatalf("group hash = %q, want 64 hex chars", groups[0].GroupHash)
	}
	if groups[1].ErrorType != "ConnError" || groups[1].SpanCount != 1 {
		t.Fatalf("second group = %+v", groups[1])
	}

	// Text mode renders the same groups.
	out, _, err = runRegisteredApp(app, "query", "exceptions")
	if err != nil {
		t.Fatalf("query exceptions (text): %v", err)
	}
	if !strings.Contains(out, "TimeoutError") || !strings.Contains(out, "2 exception group(s)") {
		t.Fatalf("text output = %q", out)
	}
}

// TestQueryExceptionsStableAcrossRebuilds: rebuilding the derived tables from
// the same log must reproduce byte-identical groups.
func TestQueryExceptionsStableAcrossRebuilds(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		seedSpanEvents(t, db, seedSpan{
			provider: protocol.ProviderClaude, agent: "claude-code",
			sessionID: "ses_a", nativeID: "nat-a", traceID: "trc_a",
			spanID: "spn_a", name: "chat", kind: "MODEL",
			failed: true, errorText: "boom",
			attrs: map[string]any{"exception.type": "BoomError", "exception.message": "boom at 42"},
			at:    coalesceAt,
		}, 0)
	})
	app := newRegisteredApp(t)

	first, _, err := runRegisteredApp(app, "query", "exceptions", "--json")
	if err != nil {
		t.Fatalf("query exceptions: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, _, err := runRegisteredApp(app, "index", "rebuild"); err != nil {
			t.Fatalf("index rebuild %d: %v", i, err)
		}
		again, _, err := runRegisteredApp(app, "query", "exceptions", "--json")
		if err != nil {
			t.Fatalf("query exceptions after rebuild %d: %v", i, err)
		}
		if again != first {
			t.Fatalf("rebuild %d changed the derived groups:\n%s\n%s", i, first, again)
		}
	}
}

// TestSessionsCoalescesAndFilters: the sessions listing folds the three
// pipelines into one canonical session and honours the new filters.
func TestSessionsCoalescesAndFilters(t *testing.T) {
	seedCoalescedRun(t)
	app := newRegisteredApp(t)

	type sessionRowV2 struct {
		Provider        string `json:"provider"`
		NativeSessionID string `json:"native_session_id"`
		SignalSource    string `json:"signal_source"`
		Shadowed        bool   `json:"shadowed"`
	}
	decode := func(out string) []sessionRowV2 {
		t.Helper()
		var rows []sessionRowV2
		if err := json.Unmarshal([]byte(out), &rows); err != nil {
			t.Fatalf("sessions output is not valid JSON: %v\n%s", err, out)
		}
		return rows
	}

	out, _, err := runRegisteredApp(app, "sessions", "--json")
	if err != nil {
		t.Fatalf("sessions: %v", err)
	}
	rows := decode(out)
	if len(rows) != 1 {
		t.Fatalf("sessions = %d rows, want 1 canonical session\n%s", len(rows), out)
	}
	if rows[0].SignalSource != "native" || rows[0].Shadowed {
		t.Fatalf("canonical session row = %+v", rows[0])
	}

	out, _, err = runRegisteredApp(app, "sessions", "--include-shadowed", "--json")
	if err != nil {
		t.Fatalf("sessions --include-shadowed: %v", err)
	}
	if rows = decode(out); len(rows) != 2 {
		// Two raw (provider, native_session_id) rows exist: claude/nat-1 and
		// otlp/nat-1. The otlp row carries the winning native source; the
		// claude row is folded into it.
		t.Fatalf("--include-shadowed = %d rows, want 2\n%s", len(rows), out)
	}

	out, _, err = runRegisteredApp(app, "sessions", "--signal-source", "native", "--json")
	if err != nil {
		t.Fatalf("sessions --signal-source native: %v", err)
	}
	if rows = decode(out); len(rows) != 1 || rows[0].SignalSource != "native" {
		t.Fatalf("--signal-source native = %+v", rows)
	}

	out, _, err = runRegisteredApp(app, "sessions", "--signal-source", "hook", "--include-shadowed", "--json")
	if err != nil {
		t.Fatalf("sessions --signal-source hook: %v", err)
	}
	if rows = decode(out); len(rows) != 1 || rows[0].Provider != protocol.ProviderClaude {
		t.Fatalf("--signal-source hook = %+v", rows)
	}

	if _, _, err := runRegisteredApp(app, "sessions", "--signal-source", "telepathy"); err == nil {
		t.Fatal("an unknown signal source must be rejected")
	}
}
