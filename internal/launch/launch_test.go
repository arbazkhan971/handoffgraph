package launch

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// testDB opens a throwaway SQLite database for one test.
func testDB(t *testing.T) *storage.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// codexCheckpoint is a checkpoint whose source session is a native codex
// session (same-provider continuation target).
func codexCheckpoint() *protocol.Checkpoint {
	cp := richCheckpoint()
	cp.CheckpointID = "cp_codex"
	cp.WorkstreamID = "ws_launch"
	return cp
}

func fixedTime() time.Time {
	return time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
}

func matchingRepo() *repository.RepoState {
	return &repository.RepoState{
		Remote: "github.com/acme/shop",
		Branch: "main",
		Head:   "abc123def456",
		Dirty:  true,
	}
}

func TestContinueSameProviderUsesNativeResume(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}

	res, err := Continue(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Handoff.Mode != ModeNativeResume {
		t.Errorf("mode = %q, want %q", res.Handoff.Mode, ModeNativeResume)
	}
	if res.Spec.Command != "codex" || strings.Join(res.Spec.Args, " ") != "resume codex-sess-1" {
		t.Errorf("spec = %s %v, want codex resume codex-sess-1", res.Spec.Command, res.Spec.Args)
	}
	if res.Handoff.SourceProvider != protocol.ProviderCodex {
		t.Errorf("source provider = %q, want codex", res.Handoff.SourceProvider)
	}
	if !res.Drift.Clean {
		t.Errorf("drift = %+v, want clean", res.Drift)
	}
	if !strings.HasPrefix(res.Handoff.ID, ids.PrefixHandoff) {
		t.Errorf("handoff id %q missing %s prefix", res.Handoff.ID, ids.PrefixHandoff)
	}
	if err := ids.Validate(res.Handoff.ID); err != nil {
		t.Errorf("handoff id %q is not a valid durable id: %v", res.Handoff.ID, err)
	}
	if !strings.Contains(res.Prompt, "Acknowledge checkpoint "+cp.CheckpointID) {
		t.Error("prompt missing acknowledgement instruction")
	}
}

func TestContinueCrossProviderSeedsFromCheckpoint(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	// Source session is claude; target codex is a different provider.
	cp.SourceSessions = []protocol.SourceSession{
		{Provider: protocol.ProviderClaude, NativeSessionID: "claude-sess-1", SessionID: "ses_b"},
	}
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}

	res, err := Continue(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Handoff.Mode != ModeCheckpointSeed {
		t.Errorf("mode = %q, want %q", res.Handoff.Mode, ModeCheckpointSeed)
	}
	if res.Spec.Command != "codex" {
		t.Errorf("spec command = %q, want codex", res.Spec.Command)
	}
	joined := strings.Join(res.Spec.Args, " ")
	if !strings.Contains(joined, cp.CheckpointID) {
		t.Errorf("checkpoint-seeded spec args %q missing checkpoint id", joined)
	}
	if got := res.Spec.Args[len(res.Spec.Args)-1]; got != res.Prompt {
		t.Error("checkpoint-seeded invocation does not carry the exact recorded payload")
	}
	if !strings.Contains(joined, "Failed approaches (do not repeat)") {
		t.Error("checkpoint-seeded invocation is missing bounded evidence sections")
	}
}

func TestContinueCrossProviderSupportsClaudeAndPi(t *testing.T) {
	for _, agent := range []string{protocol.ProviderClaude, protocol.ProviderPi} {
		t.Run(agent, func(t *testing.T) {
			db := testDB(t)
			ctx := context.Background()
			cp := codexCheckpoint()
			if err := db.SaveCheckpoint(ctx, cp); err != nil {
				t.Fatalf("SaveCheckpoint: %v", err)
			}

			res, err := Continue(ctx, db, Options{
				WorkstreamID: cp.WorkstreamID,
				TargetAgent:  agent,
				Repo:         matchingRepo(),
				Now:          fixedTime(),
			})
			if err != nil {
				t.Fatalf("Continue to %s: %v", agent, err)
			}
			if res.Handoff.Mode != ModeCheckpointSeed {
				t.Errorf("mode = %q, want %q", res.Handoff.Mode, ModeCheckpointSeed)
			}
			if res.Spec.Command != agent || len(res.Spec.Args) != 1 || !strings.Contains(res.Spec.Args[0], cp.CheckpointID) {
				t.Errorf("spec = %+v, want checkpoint-seeded %s invocation", res.Spec, agent)
			}
			if res.Spec.Args[0] != res.Prompt {
				t.Error("checkpoint-seeded invocation does not carry the exact recorded payload")
			}
			n, err := db.EventCount(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if n != 1 {
				t.Errorf("event count = %d, want 1 handoff.created event", n)
			}
		})
	}
}

func TestContinueRecordsHandoffCreatedEvent(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}
	now := fixedTime()

	res, err := Continue(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          now,
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}

	events, err := db.ListEvents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("stored %d events, want 1", len(events))
	}
	ev := events[0]
	if ev.Kind != protocol.EventHandoffCreated {
		t.Errorf("kind = %q, want handoff.created", ev.Kind)
	}
	if ev.Provenance != protocol.ProvenanceDeclared {
		t.Errorf("provenance = %q, want DECLARED", ev.Provenance)
	}
	if ev.WorkstreamID != cp.WorkstreamID {
		t.Errorf("workstream = %q, want %q", ev.WorkstreamID, cp.WorkstreamID)
	}
	if ev.Provider != protocol.ProviderCodex {
		t.Errorf("provider = %q, want codex", ev.Provider)
	}
	if !ev.OccurredAt.Equal(now) {
		t.Errorf("occurred_at = %v, want %v (clock override honored)", ev.OccurredAt, now)
	}

	var p createdPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		t.Fatalf("payload decode: %v", err)
	}
	if p.ID != res.Handoff.ID {
		t.Errorf("payload id = %q, want %q", p.ID, res.Handoff.ID)
	}
	if p.SourceCheckpoint != cp.CheckpointID {
		t.Errorf("payload source_checkpoint = %q, want %q", p.SourceCheckpoint, cp.CheckpointID)
	}
	if p.TargetAgent != protocol.ProviderCodex {
		t.Errorf("payload target_agent = %q, want codex", p.TargetAgent)
	}
	if p.Status != StatusCreated {
		t.Errorf("payload status = %q, want %q", p.Status, StatusCreated)
	}
	if !p.CreatedAt.Equal(now) {
		t.Errorf("payload created_at = %v, want %v", p.CreatedAt, now)
	}
	if p.Mode != ModeNativeResume {
		t.Errorf("payload mode = %q, want %q", p.Mode, ModeNativeResume)
	}
	if p.Spec == nil || p.Spec.Command != "codex" {
		t.Errorf("payload spec = %+v, want codex spec", p.Spec)
	}
	if p.Drift == nil || !p.Drift.Clean {
		t.Errorf("payload drift = %+v, want clean report", p.Drift)
	}
	if p.PromptChars != len(res.Prompt) {
		t.Errorf("payload prompt_chars = %d, want %d", p.PromptChars, len(res.Prompt))
	}
	if !strings.HasPrefix(p.PromptHash, "sha256:") {
		t.Errorf("payload prompt_hash = %q, want sha256 digest", p.PromptHash)
	}
}

func TestContinueUsesLatestStoredCheckpoint(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	older := codexCheckpoint()
	older.CheckpointID = "cp_old"
	if err := db.SaveCheckpoint(ctx, older); err != nil {
		t.Fatal(err)
	}
	newer := codexCheckpoint()
	newer.CheckpointID = "cp_new"
	time.Sleep(2 * time.Millisecond) // distinct created_at ordering
	if err := db.SaveCheckpoint(ctx, newer); err != nil {
		t.Fatal(err)
	}

	res, err := Continue(ctx, db, Options{
		WorkstreamID: older.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Checkpoint.CheckpointID != "cp_new" {
		t.Errorf("continued from %q, want latest cp_new", res.Checkpoint.CheckpointID)
	}
}

func TestContinueExplicitCheckpointOverride(t *testing.T) {
	db := testDB(t) // deliberately empty: no stored checkpoints
	cp := codexCheckpoint()

	res, err := Continue(context.Background(), db, Options{
		TargetAgent: protocol.ProviderCodex,
		Checkpoint:  cp,
		Repo:        matchingRepo(),
		Now:         fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Checkpoint.CheckpointID != cp.CheckpointID {
		t.Errorf("continued from %q, want the explicit checkpoint", res.Checkpoint.CheckpointID)
	}
	if res.Handoff.WorkstreamID != cp.WorkstreamID {
		t.Errorf("workstream = %q, want %q derived from the checkpoint", res.Handoff.WorkstreamID, cp.WorkstreamID)
	}
}

func TestContinueSameProviderWithoutNativeSessionSeeds(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	// Same provider but no native session id recorded: a native resume is
	// impossible, so the launch falls back to a checkpoint seed.
	cp.SourceSessions = []protocol.SourceSession{
		{Provider: protocol.ProviderCodex, NativeSessionID: "", SessionID: "ses_c"},
	}
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatal(err)
	}
	res, err := Continue(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Handoff.Mode != ModeCheckpointSeed {
		t.Errorf("mode = %q, want %q", res.Handoff.Mode, ModeCheckpointSeed)
	}
}

func TestContinueErrors(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		opts Options
		want string
	}{
		{
			name: "unknown agent",
			opts: Options{WorkstreamID: "ws_x", TargetAgent: "bogus"},
			want: `unknown agent "bogus"`,
		},
		{
			name: "missing agent",
			opts: Options{WorkstreamID: "ws_x"},
			want: "target agent is required",
		},
		{
			name: "missing workstream and checkpoint",
			opts: Options{TargetAgent: protocol.ProviderCodex},
			want: "workstream id or explicit checkpoint is required",
		},
		{
			name: "no stored checkpoints",
			opts: Options{WorkstreamID: "ws_none", TargetAgent: protocol.ProviderCodex},
			want: "no checkpoints found for workstream ws_none",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Continue(ctx, testDB(t), tc.opts)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Continue error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestContinueReportsDrift(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatal(err)
	}
	drifted := &repository.RepoState{
		Remote: "github.com/acme/shop",
		Branch: "feature/other",
		Head:   "moved",
		Dirty:  false,
	}
	res, err := Continue(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         drifted,
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	if res.Drift.Clean || !res.Drift.HeadMismatch || !res.Drift.BranchMismatch {
		t.Errorf("drift = %+v, want head+branch mismatch", res.Drift)
	}
}

func TestPrepareWritesNothing(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	cp := codexCheckpoint()
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatal(err)
	}
	res, err := Prepare(ctx, db, Options{
		WorkstreamID: cp.WorkstreamID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if res.Handoff == nil || res.Handoff.ID == "" {
		t.Fatal("Prepare must still build the handoff record")
	}
	n, err := db.EventCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("event count = %d, want 0 (preview path writes nothing)", n)
	}
}

func TestSourceSessionDeterministic(t *testing.T) {
	mk := func(order ...protocol.SourceSession) *protocol.Checkpoint {
		return &protocol.Checkpoint{SourceSessions: order}
	}
	sessions := []protocol.SourceSession{
		{Provider: "claude", NativeSessionID: "n-1", SessionID: "ses_a"},
		{Provider: "codex", NativeSessionID: "n-2", SessionID: "ses_b"},
		{Provider: "pi", NativeSessionID: "n-3", SessionID: ""},
	}
	cases := []struct {
		name     string
		cp       *protocol.Checkpoint
		provider string
		nativeID string
	}{
		{"picks greatest session key", mk(sessions...), protocol.ProviderCodex, "n-2"},
		{"order independent", mk(sessions[2], sessions[0], sessions[1]), protocol.ProviderCodex, "n-2"},
		{"no sessions", mk(), "", ""},
		{"only sessions without native ids", mk(protocol.SourceSession{Provider: "codex", SessionID: "ses_x"}), "", ""},
		{"native id breaks ties when session id empty", mk(protocol.SourceSession{Provider: "pi", NativeSessionID: "n-3"}), protocol.ProviderPi, "n-3"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, n := sourceSession(tc.cp)
			if p != tc.provider || n != tc.nativeID {
				t.Fatalf("sourceSession = (%q, %q), want (%q, %q)", p, n, tc.provider, tc.nativeID)
			}
		})
	}
}

func TestListHandoffsEmpty(t *testing.T) {
	db := testDB(t)
	recs, err := ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatalf("ListHandoffs: %v", err)
	}
	if len(recs) != 0 {
		t.Fatalf("records = %d, want 0", len(recs))
	}
}

func TestListHandoffsSkipsForeignHandoffEvents(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	// An MCP-style handoff.created event: different payload shape, no
	// handoff id. It must be skipped, not crash the fold.
	foreign := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       "evt_foreign",
		OccurredAt:    fixedTime(),
		ObservedAt:    fixedTime(),
		WorkstreamID:  "ws_x",
		Kind:          protocol.EventHandoffCreated,
		Provenance:    protocol.ProvenanceDeclared,
		Payload:       json.RawMessage(`{"checkpoint_id":"cp_1","reason":"switch"}`),
	}
	if _, err := db.AppendEvent(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	recs, err := ListHandoffs(ctx, db)
	if err != nil {
		t.Fatalf("ListHandoffs: %v", err)
	}
	if len(recs) != 0 {
		t.Fatalf("records = %d, want 0 (foreign payload skipped)", len(recs))
	}
}
