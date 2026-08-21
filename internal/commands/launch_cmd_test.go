package commands

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/launch"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise `handoffgraph continue` and
// `handoffgraph handoff status` through the public cli.App surface with
// only RegisterLaunchCmd applied, so they stay independent of the other
// commands. Every test points HFG_DATA_DIR at a fresh temp directory and
// seeds a checkpoint through the same database the commands open.

func newLaunchApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterLaunchCmd(app)
	return app
}

func runLaunchApp(t *testing.T, app *cli.App, name string, args ...string) (string, error) {
	t.Helper()
	// Keep an already-isolated HFG_DATA_DIR (set by the seed helper) so
	// the command opens the seeded database; otherwise isolate fresh.
	if os.Getenv("HFG_DATA_DIR") == "" {
		t.Setenv("HFG_DATA_DIR", t.TempDir())
	}
	var out strings.Builder
	c := &cli.Context{Stdout: &out, Stderr: &out}
	err := app.Run(context.Background(), c, name, args)
	return out.String(), err
}

// seedLaunchCheckpoint isolates HFG_DATA_DIR, saves one codex-sourced
// checkpoint for the workstream, closes the handle, and returns the data
// dir's database path for later inspection.
func seedLaunchCheckpoint(t *testing.T, wsID string) string {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	cp := launchTestCheckpoint(wsID)
	if err := db.SaveCheckpoint(context.Background(), cp); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}
	return cfg.DBPath
}

// launchTestCheckpoint is a codex-sourced checkpoint: `continue --to codex`
// takes the native-resume path.
func launchTestCheckpoint(wsID string) *protocol.Checkpoint {
	return &protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  "cp_launch_test",
		WorkstreamID:  wsID,
		Objective:     "fix the checkout race in the cart service",
		Status:        "in_progress",
		Repository: protocol.RepositoryState{
			Remote: "github.com/acme/shop",
			Branch: "main",
			Head:   "abc123def456",
			Dirty:  true,
		},
		SourceSessions: []protocol.SourceSession{
			{Provider: protocol.ProviderCodex, NativeSessionID: "codex-sess-1", SessionID: "ses_a"},
		},
		FailedApproaches: []protocol.EvidenceItem{
			{Text: "retrying the lock in a loop", Provenance: protocol.ProvenanceObserved},
		},
		NextActions: []protocol.EvidenceItem{
			{Text: "add a regression test", Provenance: protocol.ProvenanceDeclared},
		},
	}
}

func launchEventCount(t *testing.T, dbPath string) int64 {
	t.Helper()
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatalf("EventCount: %v", err)
	}
	return n
}

func TestContinueCmdRecordsHandoffAndPrintsPayload(t *testing.T) {
	dbPath := seedLaunchCheckpoint(t, "ws_cli")
	app := newLaunchApp(t)

	out, err := runLaunchApp(t, app, "continue", "--to", "codex", "--workstream", "ws_cli")
	if err != nil {
		t.Fatalf("continue: %v\noutput:\n%s", err, out)
	}
	for _, want := range []string{
		"handoff ho_",
		"created: codex -> codex (mode native_resume)",
		"checkpoint: cp_launch_test",
		"drift:",
		"agent invocation (printed, not executed):",
		"codex resume codex-sess-1",
		"continuation payload",
		"fix the checkout race in the cart service",
		"Acknowledge checkpoint cp_launch_test",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("continue output missing %q\noutput:\n%s", want, out)
		}
	}
	if n := launchEventCount(t, dbPath); n != 1 {
		t.Errorf("event count = %d, want 1 (handoff.created recorded)", n)
	}
}

func TestContinueCmdPreviewRecordsNothing(t *testing.T) {
	dbPath := seedLaunchCheckpoint(t, "ws_prev")
	app := newLaunchApp(t)

	out, err := runLaunchApp(t, app, "continue", "--to", "codex", "--workstream", "ws_prev", "--preview")
	if err != nil {
		t.Fatalf("continue --preview: %v\noutput:\n%s", err, out)
	}
	for _, want := range []string{
		"# preview — nothing recorded, nothing executed",
		"checkpoint: cp_launch_test",
		"mode: native_resume",
		"Acknowledge checkpoint cp_launch_test",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("preview output missing %q\noutput:\n%s", want, out)
		}
	}
	if n := launchEventCount(t, dbPath); n != 0 {
		t.Errorf("event count = %d, want 0 (preview writes nothing)", n)
	}
}

func TestContinueCmdCrossProviderUnsupportedIsHonest(t *testing.T) {
	seedLaunchCheckpoint(t, "ws_cross")
	app := newLaunchApp(t)

	out, err := runLaunchApp(t, app, "continue", "--to", "claude", "--workstream", "ws_cross")
	if err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatalf("continue --to claude error = %v, want unsupported-capability error\noutput:\n%s", err, out)
	}
}

func TestContinueCmdFlagValidation(t *testing.T) {
	app := newLaunchApp(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"missing --to", []string{"--workstream", "ws_x"}, "usage: continue"},
		{"missing --workstream", []string{"--to", "codex"}, "usage: continue"},
		{"unknown agent", []string{"--to", "bogus", "--workstream", "ws_x"}, `unknown agent "bogus"`},
		{"unknown workstream", []string{"--to", "codex", "--workstream", "ws_missing"}, "no checkpoints found for workstream ws_missing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := runLaunchApp(t, app, "continue", tc.args...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q\noutput:\n%s", err, tc.want, out)
			}
		})
	}
}

func TestHandoffCmdStatusLifecycle(t *testing.T) {
	dbPath := seedLaunchCheckpoint(t, "ws_life")
	app := newLaunchApp(t)

	if _, err := runLaunchApp(t, app, "continue", "--to", "codex", "--workstream", "ws_life"); err != nil {
		t.Fatalf("continue: %v", err)
	}

	out, err := runLaunchApp(t, app, "handoff", "status")
	if err != nil {
		t.Fatalf("handoff status: %v\noutput:\n%s", err, out)
	}
	if !strings.Contains(out, "ho_") || !strings.Contains(out, "created\tcodex") {
		t.Errorf("handoff status missing created record:\n%s", out)
	}

	// Acknowledge through the library (the CLI surface for acceptance is
	// the MCP/agent loop), then the read model must show it.
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	recs, err := launch.ListHandoffs(context.Background(), db)
	if err != nil || len(recs) != 1 {
		db.Close()
		t.Fatalf("ListHandoffs = %v (err %v), want 1 record", recs, err)
	}
	if _, err := launch.AcceptHandoff(context.Background(), db, recs[0].ID,
		[]string{"objective", "next_actions"}, []string{"repo_state"}, nil); err != nil {
		db.Close()
		t.Fatalf("AcceptHandoff: %v", err)
	}
	db.Close()

	out, err = runLaunchApp(t, app, "handoff", "status", "--json")
	if err != nil {
		t.Fatalf("handoff status --json: %v\noutput:\n%s", err, out)
	}
	var rows []struct {
		ID          string   `json:"id"`
		TargetAgent string   `json:"target_agent"`
		Mode        string   `json:"mode"`
		Status      string   `json:"status"`
		SourceCP    string   `json:"source_checkpoint"`
		Accepted    []string `json:"accepted"`
		Missing     []string `json:"missing"`
		CreatedAt   string   `json:"created_at"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("JSON decode: %v\noutput:\n%s", err, out)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1\noutput:\n%s", len(rows), out)
	}
	r := rows[0]
	if r.Status != "accepted" || r.TargetAgent != "codex" || r.Mode != "native_resume" || r.SourceCP != "cp_launch_test" {
		t.Errorf("row = %+v, want accepted codex native_resume from cp_launch_test", r)
	}
	if strings.Join(r.Accepted, ",") != "next_actions,objective" || strings.Join(r.Missing, ",") != "repo_state" {
		t.Errorf("ack lists = %+v / %+v, want sorted accepted and repo_state missing", r.Accepted, r.Missing)
	}
	if _, err := time.Parse(time.RFC3339, r.CreatedAt); err != nil {
		t.Errorf("created_at %q is not RFC3339", r.CreatedAt)
	}
}

func TestHandoffCmdStatusEmpty(t *testing.T) {
	app := newLaunchApp(t)

	out, err := runLaunchApp(t, app, "handoff", "status")
	if err != nil {
		t.Fatalf("handoff status: %v", err)
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("empty status output = %q, want empty", out)
	}
	out, err = runLaunchApp(t, app, "handoff", "status", "--json")
	if err != nil {
		t.Fatalf("handoff status --json: %v", err)
	}
	if strings.TrimSpace(out) != "[]" {
		t.Errorf("empty JSON status output = %q, want []", out)
	}
	// Flags are accepted before or after the subcommand.
	out, err = runLaunchApp(t, app, "handoff", "--json", "status")
	if err != nil {
		t.Fatalf("handoff --json status: %v", err)
	}
	if strings.TrimSpace(out) != "[]" {
		t.Errorf("empty JSON status output (flag first) = %q, want []", out)
	}
}

func TestHandoffCmdUsage(t *testing.T) {
	app := newLaunchApp(t)
	for _, args := range [][]string{{}, {"bogus"}} {
		out, err := runLaunchApp(t, app, "handoff", args...)
		if err == nil || !strings.Contains(err.Error(), "usage: handoff status") {
			t.Fatalf("handoff %v error = %v, want usage error\noutput:\n%s", args, err, out)
		}
	}
}

func TestHandoffStatusDeterministicOrdering(t *testing.T) {
	dbPath := seedLaunchCheckpoint(t, "ws_det")
	app := newLaunchApp(t)
	// Two handoffs in one workstream (the same checkpoint continued twice).
	for range 2 {
		if _, err := runLaunchApp(t, app, "continue", "--to", "codex", "--workstream", "ws_det"); err != nil {
			t.Fatalf("continue: %v", err)
		}
	}
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	first, err := launch.ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	second, err := launch.ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatalf("ListHandoffs ordering unstable: %s vs %s", first[i].ID, second[i].ID)
		}
	}
	if len(first) != 2 {
		t.Fatalf("records = %d, want 2", len(first))
	}
}
