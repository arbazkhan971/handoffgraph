package commands

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

func newCheckpointV06App() *cli.App {
	app := cli.NewApp("handoffgraph", "test")
	app.Register(&cli.Command{
		Name:  "checkpoint",
		Usage: "--from-trace <id> | show <id> [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("from-trace", "", "build from one trace")
			fs.String("workstream", "", "expected workstream id")
			fs.String("objective", "", "checkpoint objective")
			fs.String("status", "in_progress", "checkpoint status")
			fs.Bool("json", false, "emit JSON")
		},
		Run: func(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
			handled, err := checkpointV06Cmd(ctx, c, fs)
			if !handled && err == nil {
				return nil
			}
			return err
		},
	})
	return app
}

func appendCheckpointTrace(t *testing.T, db *storage.DB) {
	t.Helper()
	base := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	rows := []struct {
		id      string
		kind    protocol.EventKind
		payload map[string]any
	}{
		{"evt_trace_start", protocol.EventTraceStarted, map[string]any{"trace_id": "trc_cli", "objective": "repair checkout"}},
		{"evt_trace_cmd", protocol.EventCommandCompleted, map[string]any{"trace_id": "trc_cli", "command": "go test ./checkout", "exit_code": 0}},
		{"evt_trace_end", protocol.EventTraceCompleted, map[string]any{"trace_id": "trc_cli"}},
	}
	for i, row := range rows {
		payload, _ := json.Marshal(row.payload)
		ev := &protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			EventID:         row.id,
			Sequence:        int64(i + 1),
			OccurredAt:      base.Add(time.Duration(i) * time.Second),
			ObservedAt:      base.Add(time.Duration(i) * time.Second),
			WorkstreamID:    "ws_cli_trace",
			SessionID:       "ses_cli_trace",
			NativeSessionID: "native-cli-trace",
			Provider:        protocol.ProviderCodex,
			Kind:            row.kind,
			Provenance:      protocol.ProvenanceObserved,
			Payload:         payload,
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
}

func setupCheckpointV06DB(t *testing.T) string {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	appendCheckpointTrace(t, db)
	db.Close()
	return cfg.DBPath
}

func runCheckpointV06(t *testing.T, app *cli.App, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	c := &cli.Context{Stdout: &out, Stderr: &out, Stdin: strings.NewReader("")}
	err := app.Run(context.Background(), c, "checkpoint", args)
	return out.String(), err
}

func TestCheckpointFromTraceAndShowGoldenFlow(t *testing.T) {
	dbPath := setupCheckpointV06DB(t)
	app := newCheckpointV06App()
	out, err := runCheckpointV06(t, app, "--from-trace", "trc_cli")
	if err != nil {
		t.Fatalf("checkpoint --from-trace: %v\n%s", err, out)
	}
	var created protocol.Checkpoint
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatalf("decode checkpoint: %v\n%s", err, out)
	}
	if created.WorkstreamID != "ws_cli_trace" || created.Objective != "repair checkout" {
		t.Fatalf("created checkpoint = %+v", created)
	}
	if len(created.Commands) != 1 || created.Commands[0].Command != "go test ./checkout" {
		t.Fatalf("commands = %+v", created.Commands)
	}

	out, err = runCheckpointV06(t, app, "show", created.CheckpointID)
	if err != nil {
		t.Fatalf("checkpoint show: %v", err)
	}
	for _, want := range []string{"# Checkpoint " + created.CheckpointID, "repair checkout", "go test ./checkout", created.Integrity.GraphRootHash} {
		if !strings.Contains(out, want) {
			t.Errorf("checkpoint show missing %q\n%s", want, out)
		}
	}

	out, err = runCheckpointV06(t, app, "show", "--json", created.CheckpointID)
	if err != nil {
		t.Fatalf("checkpoint show --json: %v", err)
	}
	var shown protocol.Checkpoint
	if err := json.Unmarshal([]byte(out), &shown); err != nil || shown.CheckpointID != created.CheckpointID {
		t.Fatalf("JSON show = %+v, err %v", shown, err)
	}

	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stored, err := db.GetCheckpoint(context.Background(), created.CheckpointID)
	if err != nil || stored.CheckpointID != created.CheckpointID {
		t.Fatalf("stored checkpoint = %+v, err %v", stored, err)
	}
}

func TestCheckpointV06Validation(t *testing.T) {
	setupCheckpointV06DB(t)
	app := newCheckpointV06App()
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{name: "unknown trace", args: []string{"--from-trace", "trc_missing"}, want: "not found"},
		{name: "wrong expected workstream", args: []string{"--from-trace", "trc_cli", "--workstream", "ws_other"}, want: "belongs to workstream"},
		{name: "missing show id", args: []string{"show"}, want: "usage: checkpoint show"},
		{name: "unknown checkpoint", args: []string{"show", "cp_missing"}, want: "not found"},
		{name: "unknown subcommand", args: []string{"bogus"}, want: "usage: checkpoint"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runCheckpointV06(t, app, tc.args...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestCheckpointV06LegacyPathIsNotClaimed(t *testing.T) {
	fs := flag.NewFlagSet("checkpoint", flag.ContinueOnError)
	fs.String("from-trace", "", "")
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	handled, err := checkpointV06Cmd(context.Background(), &cli.Context{Stdout: os.Stdout, Stderr: os.Stderr}, fs)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v, want legacy fallthrough", handled, err)
	}
}
