package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/launch"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// seedFixture is a deterministic database layout used by handler tests.
type seedFixture struct {
	db            *storage.DB
	wsA           string // "fix checkout race", repository repo_alpha
	wsB           string // unrelated workstream, repository repo_beta
	ses           string // session in wsA
	trc           string // trace in wsA
	trcB          string // trace in wsB
	decisionEvent *protocol.Event
}

// openSeed opens a temp DB with two workstreams. wsA has a codex session,
// one trace with a failing command and a failing test, one recorded
// decision, and one recorded verification. wsB has its own trace so
// cross-workstream rejection can be asserted.
func openSeed(t *testing.T) *seedFixture {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "handlers.db"))
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	ctx := context.Background()
	f := &seedFixture{db: db, wsA: "ws_alpha", wsB: "ws_beta", ses: "ses_a", trc: "trc_a", trcB: "trc_b"}
	if err := db.CreateWorkstream(ctx, f.wsA, "fix checkout race", "repo_alpha"); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateWorkstream(ctx, f.wsB, "unrelated workstream", "repo_beta"); err != nil {
		t.Fatal(err)
	}

	base := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	seq := 0
	add := func(ws, kind string, prov protocol.Provenance, payload map[string]any, mut ...func(*protocol.Event)) *protocol.Event {
		seq++
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    base.Add(time.Duration(seq) * time.Minute),
			ObservedAt:    base.Add(time.Duration(seq) * time.Minute),
			WorkstreamID:  ws,
			Kind:          protocol.EventKind(kind),
			Provenance:    prov,
		}
		if payload != nil {
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			ev.Payload = raw
		}
		for _, m := range mut {
			m(ev)
		}
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
		return ev
	}

	add(f.wsA, string(protocol.EventSessionStarted), protocol.ProvenanceObserved, nil,
		func(ev *protocol.Event) {
			ev.SessionID = f.ses
			ev.NativeSessionID = "codex-abc"
			ev.Provider = protocol.ProviderCodex
			ev.RepositoryID = "repo_alpha"
		})
	add(f.wsA, string(protocol.EventTraceStarted), protocol.ProvenanceObserved,
		map[string]any{"trace_id": f.trc, "objective": "fix the checkout race"},
		func(ev *protocol.Event) { ev.SessionID = f.ses; ev.Provider = protocol.ProviderCodex })
	add(f.wsA, string(protocol.EventSpanStarted), protocol.ProvenanceObserved,
		map[string]any{"span_id": "spn_root", "trace_id": f.trc, "kind": "AGENT", "name": "agent"},
		func(ev *protocol.Event) { ev.SessionID = f.ses })
	add(f.wsA, string(protocol.EventCommandCompleted), protocol.ProvenanceObserved,
		map[string]any{"span_id": "spn_cmd", "trace_id": f.trc, "command": "go build ./...", "exit_code": 1},
		func(ev *protocol.Event) { ev.SessionID = f.ses })
	add(f.wsA, string(protocol.EventTestCompleted), protocol.ProvenanceObserved,
		map[string]any{"span_id": "spn_test", "trace_id": f.trc, "name": "TestCheckout", "result": "failed", "exit_code": 1},
		func(ev *protocol.Event) { ev.SessionID = f.ses })
	f.decisionEvent = add(f.wsA, string(protocol.EventDecisionRecorded), protocol.ProvenanceDeclared,
		map[string]any{"decision": "guard with a mutex"})
	add(f.wsA, string(protocol.EventVerificationRecorded), protocol.ProvenanceObserved,
		map[string]any{"verification": "go test ./...", "result": "passed", "exit_code": 0})

	// wsB gets its own session and trace.
	add(f.wsB, string(protocol.EventSessionStarted), protocol.ProvenanceObserved, nil,
		func(ev *protocol.Event) {
			ev.SessionID = "ses_b"
			ev.NativeSessionID = "claude-xyz"
			ev.Provider = protocol.ProviderClaude
			ev.RepositoryID = "repo_beta"
		})
	add(f.wsB, string(protocol.EventTraceStarted), protocol.ProvenanceObserved,
		map[string]any{"trace_id": f.trcB, "objective": "unrelated"},
		func(ev *protocol.Event) { ev.SessionID = "ses_b"; ev.Provider = protocol.ProviderClaude })
	return f
}

// call invokes a tool handler directly with JSON arguments and decodes the
// structured payload into out (when wantErr is nil).
func call(t *testing.T, f *seedFixture, name, args string, out any) error {
	t.Helper()
	tool := (&Server{tools: newToolset(f.db)}).toolByName(name)
	if tool == nil {
		t.Fatalf("tool %q not found", name)
	}
	payload, err := tool.Handler(context.Background(), json.RawMessage(args))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("decode %s result: %v", name, err)
	}
	return nil
}

// wantRPCCode asserts err carries a *rpcError with the given code.
func wantRPCCode(t *testing.T, err error, code int) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected rpc error %d, got nil", code)
	}
	var re *rpcError
	if !errors.As(err, &re) {
		t.Fatalf("expected *rpcError, got %T: %v", err, err)
	}
	if re.Code != code {
		t.Fatalf("rpc code = %d (%s), want %d", re.Code, re.Message, code)
	}
}

func lastEvent(t *testing.T, f *seedFixture) *protocol.Event {
	t.Helper()
	events, err := f.db.ListEvents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("no events")
	}
	return events[len(events)-1]
}

// TestToolScopedAccessRejectsUnknownWorkstream is the acceptance-gate
// matrix: every tool rejects ids not in the local database, and none of
// them append events while doing so.
func TestToolScopedAccessRejectsUnknownWorkstream(t *testing.T) {
	tests := []struct {
		tool string
		args string
	}{
		{"get_workstream_context", `{"workstream_id":"ws_missing"}`},
		{"get_trace_context", `{"workstream_id":"ws_missing","trace_id":"trc_a"}`},
		{"create_checkpoint", `{"workstream_id":"ws_missing"}`},
		{"record_decision", `{"workstream_id":"ws_missing","decision":"d"}`},
		{"record_verification", `{"workstream_id":"ws_missing","verification":"v","result":"passed"}`},
		{"claim_files", `{"workstream_id":"ws_missing","paths":["a.go"]}`},
		{"handoff_workstream", `{"workstream_id":"ws_missing"}`},
		{"accept_handoff", `{"workstream_id":"ws_missing"}`},
		{"complete_workstream", `{"workstream_id":"ws_missing"}`},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			f := openSeed(t)
			ctx := context.Background()
			before, err := f.db.EventCount(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = call(t, f, tt.tool, tt.args, &map[string]any{})
			wantRPCCode(t, err, CodeInvalidParams)
			after, err := f.db.EventCount(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if after != before {
				t.Fatalf("rejected call appended events: %d -> %d", before, after)
			}
		})
	}
}

// TestGetWorkstreamContext covers the read model and its scoping.
func TestGetWorkstreamContext(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		f := openSeed(t)
		var out workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &out); err != nil {
			t.Fatal(err)
		}
		if out.WorkstreamID != f.wsA || out.Title != "fix checkout race" {
			t.Fatalf("workstream = %q/%q", out.WorkstreamID, out.Title)
		}
		if out.CreatedAt == "" {
			t.Fatal("created_at empty")
		}
		if out.Status.Value != "active" || out.Status.Provenance != "INFERRED" {
			t.Fatalf("status = %+v, want active/INFERRED", out.Status)
		}
		if out.EventCount != 7 {
			t.Fatalf("event_count = %d, want 7 (wsB events must not leak)", out.EventCount)
		}
		if len(out.Sessions) != 1 || out.Sessions[0].SessionID != f.ses || out.Sessions[0].NativeSessionID != "codex-abc" {
			t.Fatalf("sessions = %+v", out.Sessions)
		}
		if out.Decisions != 1 || out.Verifications != 1 {
			t.Fatalf("decisions=%d verifications=%d, want 1/1", out.Decisions, out.Verifications)
		}
		if len(out.ClaimedFiles) != 0 {
			t.Fatalf("claimed_files = %v, want empty", out.ClaimedFiles)
		}
		if out.Graph.NodeCount == 0 || out.Graph.EdgeCount == 0 || out.Graph.RootHash == "" {
			t.Fatalf("graph summary = %+v", out.Graph)
		}
		if out.LatestCheckpoint != nil {
			t.Fatalf("latest_checkpoint = %+v, want nil", out.LatestCheckpoint)
		}
	})
	t.Run("deterministic repeat", func(t *testing.T) {
		f := openSeed(t)
		var a, b map[string]any
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &a); err != nil {
			t.Fatal(err)
		}
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &b); err != nil {
			t.Fatal(err)
		}
		ra, _ := json.Marshal(a)
		rb, _ := json.Marshal(b)
		if string(ra) != string(rb) {
			t.Fatalf("output not deterministic:\n%s\n%s", ra, rb)
		}
	})
	t.Run("missing workstream_id", func(t *testing.T) {
		f := openSeed(t)
		err := call(t, f, "get_workstream_context", `{}`, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("unknown argument field", func(t *testing.T) {
		f := openSeed(t)
		err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q,"extra":1}`, f.wsA), &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
}

// TestGetTraceContext covers trace reads and cross-workstream rejection.
func TestGetTraceContext(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		f := openSeed(t)
		var out traceContextResult
		args := fmt.Sprintf(`{"workstream_id":%q,"trace_id":%q}`, f.wsA, f.trc)
		if err := call(t, f, "get_trace_context", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.TraceID != f.trc || out.SessionID != f.ses || out.Provider != "codex" {
			t.Fatalf("trace = %+v", out)
		}
		if out.Status != string(protocol.TraceRunning) {
			t.Fatalf("status = %q, want RUNNING (trace never completed)", out.Status)
		}
		if out.VerificationState != string(protocol.VerificationFailed) {
			t.Fatalf("verification_state = %q, want failed", out.VerificationState)
		}
		// The materializer orders spans by (sequence, started_at, span_id);
		// the seed has zero sequences and increasing timestamps, so the
		// expected order is the insertion order.
		wantOrder := []string{"spn_root", "spn_cmd", "spn_test"}
		if len(out.Spans) != len(wantOrder) {
			t.Fatalf("spans = %d, want 3 (agent + command + test): %+v", len(out.Spans), out.Spans)
		}
		for i, want := range wantOrder {
			if out.Spans[i].SpanID != want {
				t.Fatalf("spans[%d] = %+v, want %s", i, out.Spans[i], want)
			}
		}
		var testSpan *spanSummary
		for i := range out.Spans {
			if out.Spans[i].Kind == string(protocol.SpanKindTest) {
				testSpan = &out.Spans[i]
			}
		}
		if testSpan == nil || testSpan.Status != "error" || testSpan.ExitCode == nil || *testSpan.ExitCode != 1 {
			t.Fatalf("test span = %+v, want error status with exit code 1", testSpan)
		}
	})
	t.Run("cross-workstream trace rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"trace_id":%q}`, f.wsA, f.trcB)
		err := call(t, f, "get_trace_context", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("missing trace_id", func(t *testing.T) {
		f := openSeed(t)
		err := call(t, f, "get_trace_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
}

// TestCreateCheckpoint reuses checkpoint.Build and persists the result.
func TestCreateCheckpoint(t *testing.T) {
	t.Run("happy path with defaults", func(t *testing.T) {
		f := openSeed(t)
		var out checkpointResult
		if err := call(t, f, "create_checkpoint", fmt.Sprintf(`{"workstream_id":%q,"objective":"fix the race"}`, f.wsA), &out); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out.CheckpointID, "cp_") {
			t.Fatalf("checkpoint id = %q, want cp_ prefix", out.CheckpointID)
		}
		if out.Status != "in_progress" {
			t.Fatalf("status = %q, want in_progress default", out.Status)
		}
		if out.Objective != "fix the race" {
			t.Fatalf("objective = %q", out.Objective)
		}
		if out.GraphRootHash == "" || out.Score < 0 {
			t.Fatalf("integrity = %+v", out)
		}
		if out.Decisions != 1 || out.Tests != 1 || out.SourceSessions != 1 {
			t.Fatalf("counts = %+v, want 1 decision/test/session (wsB excluded)", out)
		}
		cps, err := f.db.ListCheckpoints(context.Background(), f.wsA)
		if err != nil {
			t.Fatal(err)
		}
		if len(cps) != 1 || cps[0].CheckpointID != out.CheckpointID {
			t.Fatalf("stored checkpoints = %+v", cps)
		}
	})
	t.Run("latest checkpoint surfaces in context", func(t *testing.T) {
		f := openSeed(t)
		var cp checkpointResult
		if err := call(t, f, "create_checkpoint", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &cp); err != nil {
			t.Fatal(err)
		}
		var ctxOut workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &ctxOut); err != nil {
			t.Fatal(err)
		}
		if ctxOut.LatestCheckpoint == nil || ctxOut.LatestCheckpoint.CheckpointID != cp.CheckpointID {
			t.Fatalf("latest_checkpoint = %+v, want %s", ctxOut.LatestCheckpoint, cp.CheckpointID)
		}
	})
}

func TestCreateCheckpointUsesServerRedactionPolicy(t *testing.T) {
	f := openSeed(t)
	server := &Server{tools: newToolsetWithRedaction(f.db, &redact.Options{
		UserPatterns: []string{`private-[0-9]+`},
	})}
	tool := server.toolByName("create_checkpoint")
	if tool == nil {
		t.Fatal("create_checkpoint tool not found")
	}
	payload, err := tool.Handler(context.Background(), json.RawMessage(fmt.Sprintf(
		`{"workstream_id":%q,"objective":"continue private-98765"}`, f.wsA,
	)))
	if err != nil {
		t.Fatal(err)
	}
	out, ok := payload.(checkpointResult)
	if !ok {
		t.Fatalf("result type = %T, want checkpointResult", payload)
	}
	if strings.Contains(out.Objective, "private-98765") || !strings.Contains(out.Objective, "[REDACTED]") {
		t.Fatalf("MCP checkpoint objective was not redacted: %q", out.Objective)
	}
}

// TestRecordDecision covers DECLARED provenance and evidence scoping.
func TestRecordDecision(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		f := openSeed(t)
		var out recordDecisionResult
		args := fmt.Sprintf(`{"workstream_id":%q,"decision":"use a channel","rationale":"simpler","evidence_refs":[%q]}`,
			f.wsA, f.decisionEvent.EventID)
		if err := call(t, f, "record_decision", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.Kind != "decision.recorded" || out.Provenance != "DECLARED" || out.Decision != "use a channel" {
			t.Fatalf("result = %+v", out)
		}
		ev := lastEvent(t, f)
		if ev.EventID != out.EventID || ev.WorkstreamID != f.wsA {
			t.Fatalf("stored event mismatch: %+v", ev)
		}
		if got := payloadString(ev, "decision"); got != "use a channel" {
			t.Fatalf("payload decision = %q", got)
		}
		if got := payloadString(ev, "rationale"); got != "simpler" {
			t.Fatalf("payload rationale = %q", got)
		}
		refs := payloadStrings(ev, "evidence_refs")
		if len(refs) != 1 || refs[0] != f.decisionEvent.EventID {
			t.Fatalf("payload evidence_refs = %v", refs)
		}
	})
	t.Run("missing decision", func(t *testing.T) {
		f := openSeed(t)
		err := call(t, f, "record_decision", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("unknown evidence ref", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"decision":"d","evidence_refs":["evt_nonexistent"]}`, f.wsA)
		err := call(t, f, "record_decision", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("empty evidence ref entry", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"decision":"d","evidence_refs":[""]}`, f.wsA)
		err := call(t, f, "record_decision", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("wrong argument type", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"decision":42}`, f.wsA)
		err := call(t, f, "record_decision", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
}

// TestRecordVerification covers the OBSERVED/DECLARED provenance split.
func TestRecordVerification(t *testing.T) {
	tests := []struct {
		name           string
		args           string
		wantErrCode    int
		wantProvenance string
	}{
		{
			name:           "observed with exit code",
			args:           `,"command":"go test ./...","exit_code":0`,
			wantProvenance: "OBSERVED",
		},
		{
			name:           "declared without exit code",
			args:           ``,
			wantProvenance: "DECLARED",
		},
		{
			name:        "bad result value",
			args:        ``,
			wantErrCode: CodeInvalidParams,
		},
		{
			name:        "missing verification",
			args:        ``,
			wantErrCode: CodeInvalidParams,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := openSeed(t)
			var args string
			switch tt.name {
			case "bad result value":
				args = fmt.Sprintf(`{"workstream_id":%q,"verification":"v","result":"maybe"}`, f.wsA)
			case "missing verification":
				args = fmt.Sprintf(`{"workstream_id":%q,"result":"passed"}`, f.wsA)
			default:
				args = fmt.Sprintf(`{"workstream_id":%q,"verification":"go test ./...","result":"passed"%s}`, f.wsA, tt.args)
			}
			var out recordVerificationResult
			err := call(t, f, "record_verification", args, &out)
			if tt.wantErrCode != 0 {
				wantRPCCode(t, err, tt.wantErrCode)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if out.Provenance != tt.wantProvenance {
				t.Fatalf("provenance = %q, want %q", out.Provenance, tt.wantProvenance)
			}
			ev := lastEvent(t, f)
			if ev.Kind != protocol.EventVerificationRecorded || string(ev.Provenance) != tt.wantProvenance {
				t.Fatalf("stored event = %s/%s", ev.Kind, ev.Provenance)
			}
		})
	}
	t.Run("exit code not integer", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"verification":"v","result":"passed","exit_code":"zero"}`, f.wsA)
		err := call(t, f, "record_verification", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("verification surfaces in context", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"verification":"manual review","result":"skipped"}`, f.wsA)
		if err := call(t, f, "record_verification", args, &map[string]any{}); err != nil {
			t.Fatal(err)
		}
		var out workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &out); err != nil {
			t.Fatal(err)
		}
		if out.Verifications != 2 {
			t.Fatalf("verifications = %d, want 2", out.Verifications)
		}
	})
}

// TestClaimFiles covers claims, conflicts, and repository scoping.
func TestClaimFiles(t *testing.T) {
	t.Run("happy path sorts and dedupes", func(t *testing.T) {
		f := openSeed(t)
		var out claimFilesResult
		args := fmt.Sprintf(`{"workstream_id":%q,"repository_id":"repo_alpha","paths":["b.go","a.go","b.go"]}`, f.wsA)
		if err := call(t, f, "claim_files", args, &out); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(out.Paths) != "[a.go b.go]" {
			t.Fatalf("paths = %v", out.Paths)
		}
		if len(out.Conflicts) != 0 {
			t.Fatalf("conflicts = %+v, want none", out.Conflicts)
		}
		ev := lastEvent(t, f)
		if ev.Kind != eventKindFilesClaimed {
			t.Fatalf("kind = %s", ev.Kind)
		}
		if got := payloadStrings(ev, "paths"); fmt.Sprint(got) != "[a.go b.go]" {
			t.Fatalf("payload paths = %v", got)
		}
	})
	t.Run("conflict with earlier claim", func(t *testing.T) {
		f := openSeed(t)
		first := fmt.Sprintf(`{"workstream_id":%q,"paths":["a.go"]}`, f.wsA)
		if err := call(t, f, "claim_files", first, &claimFilesResult{}); err != nil {
			t.Fatal(err)
		}
		second := fmt.Sprintf(`{"workstream_id":%q,"paths":["a.go","c.go"]}`, f.wsA)
		var out claimFilesResult
		if err := call(t, f, "claim_files", second, &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Conflicts) != 1 || out.Conflicts[0].Path != "a.go" || len(out.Conflicts[0].ClaimedBy) != 1 {
			t.Fatalf("conflicts = %+v", out.Conflicts)
		}
		if !strings.HasPrefix(out.Conflicts[0].ClaimedBy[0], "evt_") {
			t.Fatalf("claimed_by = %v", out.Conflicts[0].ClaimedBy)
		}
	})
	t.Run("repository mismatch rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"repository_id":"repo_beta","paths":["a.go"]}`, f.wsA)
		err := call(t, f, "claim_files", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("unknown repository rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"repository_id":"repo_missing","paths":["a.go"]}`, f.wsA)
		err := call(t, f, "claim_files", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("empty paths rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"paths":[]}`, f.wsA)
		err := call(t, f, "claim_files", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("empty path entry rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"paths":[""]}`, f.wsA)
		err := call(t, f, "claim_files", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("non-string path entry rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"paths":[42]}`, f.wsA)
		err := call(t, f, "claim_files", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("claimed files surface in context", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"paths":["z.go","a.go"]}`, f.wsA)
		if err := call(t, f, "claim_files", args, &claimFilesResult{}); err != nil {
			t.Fatal(err)
		}
		var out workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &out); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(out.ClaimedFiles) != "[a.go z.go]" {
			t.Fatalf("claimed_files = %v", out.ClaimedFiles)
		}
	})
}

// TestHandoffWorkstream covers checkpoint creation plus the handoff event.
func TestHandoffWorkstream(t *testing.T) {
	f := openSeed(t)
	var out handoffWorkstreamResult
	args := fmt.Sprintf(`{"workstream_id":%q,"reason":"end of day","to_agent":"claude"}`, f.wsA)
	if err := call(t, f, "handoff_workstream", args, &out); err != nil {
		t.Fatal(err)
	}
	if out.Kind != "handoff.created" || out.Provenance != "DECLARED" {
		t.Fatalf("result = %+v", out.recordedEventResult)
	}
	if out.Checkpoint.Status != "handed_off" || !strings.HasPrefix(out.Checkpoint.CheckpointID, "cp_") {
		t.Fatalf("checkpoint = %+v", out.Checkpoint)
	}
	ev := lastEvent(t, f)
	if ev.Kind != protocol.EventHandoffCreated {
		t.Fatalf("kind = %s", ev.Kind)
	}
	if got := payloadString(ev, "checkpoint_id"); got != out.Checkpoint.CheckpointID {
		t.Fatalf("payload checkpoint_id = %q, want %q", got, out.Checkpoint.CheckpointID)
	}
	if got := payloadString(ev, "to_agent"); got != "claude" {
		t.Fatalf("payload to_agent = %q", got)
	}
	// The derived status must flip to handed_off.
	var ctxOut workstreamContextResult
	if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &ctxOut); err != nil {
		t.Fatal(err)
	}
	if ctxOut.Status.Value != "handed_off" {
		t.Fatalf("derived status = %q, want handed_off", ctxOut.Status.Value)
	}
}

// TestAcceptHandoff covers checkpoint binding and scoping.
func TestAcceptHandoff(t *testing.T) {
	t.Run("accepts a CLI continuation for an imported event-only workstream", func(t *testing.T) {
		db, err := storage.Open(filepath.Join(t.TempDir(), "imported.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		ctx := context.Background()
		wsID := ids.Workstream()
		sessionID := ids.Session()
		now := time.Date(2026, 8, 21, 15, 0, 0, 0, time.UTC)
		for _, ev := range []*protocol.Event{
			{SchemaVersion: protocol.SchemaVersionEvent, EventID: ids.Event(), OccurredAt: now, ObservedAt: now, WorkstreamID: wsID, Kind: protocol.EventWorkstreamStarted, Provenance: protocol.ProvenanceObserved},
			{SchemaVersion: protocol.SchemaVersionEvent, EventID: ids.Event(), OccurredAt: now.Add(time.Second), ObservedAt: now.Add(time.Second), WorkstreamID: wsID, SessionID: sessionID, NativeSessionID: "codex-imported-session", Provider: protocol.ProviderCodex, Kind: protocol.EventSessionStarted, Provenance: protocol.ProvenanceObserved},
		} {
			if _, err := db.AppendEvent(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
		cp := &protocol.Checkpoint{
			SchemaVersion: protocol.SchemaVersionCheckpoint,
			CheckpointID:  ids.Checkpoint(),
			WorkstreamID:  wsID,
			Objective:     "continue imported work",
			Status:        "in_progress",
			SourceSessions: []protocol.SourceSession{{
				Provider: protocol.ProviderCodex, NativeSessionID: "codex-imported-session", SessionID: sessionID,
			}},
		}
		if err := db.SaveCheckpoint(ctx, cp); err != nil {
			t.Fatal(err)
		}
		continued, err := launch.Continue(ctx, db, launch.Options{WorkstreamID: wsID, TargetAgent: protocol.ProviderCodex, Checkpoint: cp})
		if err != nil {
			t.Fatal(err)
		}
		f := &seedFixture{db: db, wsA: wsID}
		var out acceptHandoffResult
		args := fmt.Sprintf(`{"workstream_id":%q,"checkpoint_id":%q,"agent":"codex","accepted":["objective"]}`, wsID, cp.CheckpointID)
		if err := call(t, f, "accept_handoff", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.HandoffID != continued.Handoff.ID || out.EventID == "" {
			t.Fatalf("accept result = %+v, want structured handoff %s", out, continued.Handoff.ID)
		}
	})

	t.Run("folds a structured continuation into handoff status", func(t *testing.T) {
		f := openSeed(t)
		var cpOut checkpointResult
		if err := call(t, f, "create_checkpoint", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &cpOut); err != nil {
			t.Fatal(err)
		}
		cps, err := f.db.ListCheckpoints(context.Background(), f.wsA)
		if err != nil || len(cps) != 1 {
			t.Fatalf("ListCheckpoints = %v, err %v", cps, err)
		}
		continued, err := launch.Continue(context.Background(), f.db, launch.Options{
			WorkstreamID: f.wsA,
			TargetAgent:  protocol.ProviderCodex,
			Checkpoint:   cps[0],
		})
		if err != nil {
			t.Fatalf("launch.Continue: %v", err)
		}

		var out acceptHandoffResult
		args := fmt.Sprintf(`{"workstream_id":%q,"checkpoint_id":%q,"agent":"codex","accepted":["objective","next_actions","objective"],"missing":["tests"],"unverifiable":["repository"]}`,
			f.wsA, cpOut.CheckpointID)
		if err := call(t, f, "accept_handoff", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.HandoffID != continued.Handoff.ID || out.EventID == "" {
			t.Fatalf("accept result = %+v, want handoff %s with event evidence", out, continued.Handoff.ID)
		}
		if strings.Join(out.Accepted, ",") != "next_actions,objective" {
			t.Fatalf("accepted sections = %v, want sorted and de-duplicated", out.Accepted)
		}
		recs, err := launch.ListHandoffs(context.Background(), f.db)
		if err != nil || len(recs) != 1 {
			t.Fatalf("ListHandoffs = %v, err %v", recs, err)
		}
		if recs[0].Status != launch.StatusAccepted || recs[0].ID != continued.Handoff.ID {
			t.Fatalf("derived handoff = %+v, want accepted %s", recs[0], continued.Handoff.ID)
		}
		if got := payloadString(lastEvent(t, f), "handoff_id"); got != continued.Handoff.ID {
			t.Fatalf("acceptance handoff_id = %q, want %q", got, continued.Handoff.ID)
		}
		var contextOut workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &contextOut); err != nil {
			t.Fatal(err)
		}
		if contextOut.Status.Value != "active" || contextOut.Status.Provenance != string(protocol.ProvenanceInferred) {
			t.Fatalf("post-acceptance context status = %+v, want inferred active", contextOut.Status)
		}
	})

	t.Run("binds to a valid checkpoint", func(t *testing.T) {
		f := openSeed(t)
		var ho handoffWorkstreamResult
		if err := call(t, f, "handoff_workstream", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &ho); err != nil {
			t.Fatal(err)
		}
		var out acceptHandoffResult
		args := fmt.Sprintf(`{"workstream_id":%q,"checkpoint_id":%q,"agent":"codex"}`, f.wsA, ho.Checkpoint.CheckpointID)
		if err := call(t, f, "accept_handoff", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.Kind != "handoff.accepted" || out.CheckpointID != ho.Checkpoint.CheckpointID {
			t.Fatalf("result = %+v", out)
		}
		ev := lastEvent(t, f)
		if ev.Kind != protocol.EventHandoffAccepted || payloadString(ev, "agent") != "codex" {
			t.Fatalf("stored event = %s payload=%s", ev.Kind, ev.Payload)
		}
	})
	t.Run("unknown checkpoint rejected", func(t *testing.T) {
		f := openSeed(t)
		args := fmt.Sprintf(`{"workstream_id":%q,"checkpoint_id":"cp_missing"}`, f.wsA)
		err := call(t, f, "accept_handoff", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("other workstreams checkpoint rejected", func(t *testing.T) {
		f := openSeed(t)
		var other checkpointResult
		if err := call(t, f, "create_checkpoint", fmt.Sprintf(`{"workstream_id":%q}`, f.wsB), &other); err != nil {
			t.Fatal(err)
		}
		args := fmt.Sprintf(`{"workstream_id":%q,"checkpoint_id":%q}`, f.wsA, other.CheckpointID)
		err := call(t, f, "accept_handoff", args, &map[string]any{})
		wantRPCCode(t, err, CodeInvalidParams)
	})
	t.Run("without checkpoint is allowed", func(t *testing.T) {
		f := openSeed(t)
		var out acceptHandoffResult
		if err := call(t, f, "accept_handoff", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &out); err != nil {
			t.Fatal(err)
		}
		if out.CheckpointID != "" || out.Kind != "handoff.accepted" {
			t.Fatalf("result = %+v", out)
		}
	})
}

// TestCompleteWorkstream covers completion and the already-completed
// domain error (isValidTool=false).
func TestCompleteWorkstream(t *testing.T) {
	t.Run("first completion", func(t *testing.T) {
		f := openSeed(t)
		var out completeWorkstreamResult
		args := fmt.Sprintf(`{"workstream_id":%q,"summary":"race fixed"}`, f.wsA)
		if err := call(t, f, "complete_workstream", args, &out); err != nil {
			t.Fatal(err)
		}
		if out.Kind != "workstream.completed" || out.Summary != "race fixed" {
			t.Fatalf("result = %+v", out)
		}
		ev := lastEvent(t, f)
		if ev.Kind != protocol.EventWorkstreamCompleted || payloadString(ev, "summary") != "race fixed" {
			t.Fatalf("stored event = %s payload=%s", ev.Kind, ev.Payload)
		}
		var ctxOut workstreamContextResult
		if err := call(t, f, "get_workstream_context", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &ctxOut); err != nil {
			t.Fatal(err)
		}
		if ctxOut.Status.Value != "completed" {
			t.Fatalf("derived status = %q, want completed", ctxOut.Status.Value)
		}
	})
	t.Run("second completion is a tool error, not an event", func(t *testing.T) {
		f := openSeed(t)
		ctx := context.Background()
		if err := call(t, f, "complete_workstream", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &completeWorkstreamResult{}); err != nil {
			t.Fatal(err)
		}
		before, err := f.db.EventCount(ctx)
		if err != nil {
			t.Fatal(err)
		}
		err = call(t, f, "complete_workstream", fmt.Sprintf(`{"workstream_id":%q}`, f.wsA), &completeWorkstreamResult{})
		var te *ToolError
		if !errors.As(err, &te) {
			t.Fatalf("expected ToolError, got %T: %v", err, err)
		}
		if !strings.Contains(te.Msg, "already completed") {
			t.Fatalf("message = %q", te.Msg)
		}
		after, err := f.db.EventCount(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if after != before {
			t.Fatalf("duplicate completion appended an event: %d -> %d", before, after)
		}
	})
}

// TestToolsetShape pins the exposed surface order and completeness.
func TestToolsetShape(t *testing.T) {
	f := openSeed(t)
	tools := newToolset(f.db)
	if len(tools) != len(wantToolOrder) {
		t.Fatalf("got %d tools, want %d", len(tools), len(wantToolOrder))
	}
	seen := map[string]bool{}
	for i, tool := range tools {
		if tool.Name != wantToolOrder[i] {
			t.Fatalf("tool[%d] = %q, want %q", i, tool.Name, wantToolOrder[i])
		}
		if tool.Handler == nil || tool.InputSchema == nil || tool.Description == "" {
			t.Fatalf("tool %q incomplete", tool.Name)
		}
		seen[tool.Name] = true
	}
	if len(seen) != len(wantToolOrder) {
		t.Fatal("duplicate tool names")
	}
}
