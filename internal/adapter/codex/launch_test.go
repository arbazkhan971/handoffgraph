package codex

import (
	"context"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestCheckpointLaunchCapability(t *testing.T) {
	if !New().Capabilities().CheckpointLaunch {
		t.Fatal("CheckpointLaunch capability is false, want true")
	}
}

func TestStartFromCheckpoint(t *testing.T) {
	cp := &protocol.Checkpoint{
		CheckpointID: "cp_cross_agent",
		WorkstreamID: "ws_checkout",
		Objective:    "--dangerous-looking objective",
	}
	spec, err := New().StartFromCheckpoint(context.Background(), cp)
	if err != nil {
		t.Fatalf("StartFromCheckpoint: %v", err)
	}
	if spec.Command != "codex" || len(spec.Args) != 2 || spec.Args[0] != "--" {
		t.Fatalf("spec = %+v, want codex -- <prompt>", spec)
	}
	for _, want := range []string{cp.CheckpointID, cp.WorkstreamID, cp.Objective, "Acknowledge checkpoint"} {
		if !strings.Contains(spec.Args[1], want) {
			t.Errorf("prompt missing %q: %q", want, spec.Args[1])
		}
	}
	if _, err := New().StartFromCheckpoint(context.Background(), nil); err == nil {
		t.Fatal("nil checkpoint accepted, want error")
	}
}

func TestStartFromCheckpointBoundsObjectiveRuneSafely(t *testing.T) {
	cp := &protocol.Checkpoint{CheckpointID: "cp_bound", WorkstreamID: "ws_bound", Objective: strings.Repeat("é", 5000)}
	spec, err := New().StartFromCheckpoint(context.Background(), cp)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(spec.Args[1], "é"); got != 4000 {
		t.Errorf("objective rune count = %d, want 4000", got)
	}
}
