package launch

import (
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func exitCode(i int) *int { return &i }

// fullScoreCheckpoint earns the full 90 build-time points.
func fullScoreCheckpoint() *protocol.Checkpoint {
	return &protocol.Checkpoint{
		Objective:        "fix the race",
		Repository:       protocol.RepositoryState{Branch: "main", Head: "abc", Dirty: true},
		Decisions:        []protocol.Decision{{Text: "use a mutex"}},
		Files:            []protocol.FileEvidence{{Path: "a.go", Status: "edited"}},
		Commands:         []protocol.CommandEvidence{{Command: "go build ./...", ExitCode: exitCode(0)}},
		Tests:            []protocol.TestEvidence{{Name: "TestRace", Result: "passed", ExitCode: exitCode(0)}},
		FailedApproaches: []protocol.EvidenceItem{{Text: "spin loop"}},
		NextActions:      []protocol.EvidenceItem{{Text: "land the fix"}},
	}
}

func TestComputeFinalScore(t *testing.T) {
	full := fullScoreCheckpoint()
	minimal := &protocol.Checkpoint{}
	cases := []struct {
		name       string
		cp         *protocol.Checkpoint
		accepted   bool
		driftClean bool
		want       int
	}{
		{"full checkpoint, accepted, clean", full, true, true, 100},
		{"full checkpoint, accepted only", full, true, false, 95},
		{"full checkpoint, clean only", full, false, true, 95},
		{"full checkpoint, neither", full, false, false, 90},
		{"minimal checkpoint, neither", minimal, false, false, 0},
		{"minimal checkpoint, both", minimal, true, true, 10},
		{"nil checkpoint", nil, true, true, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ComputeFinalScore(tc.cp, tc.accepted, tc.driftClean)
			if got != tc.want {
				t.Fatalf("ComputeFinalScore = %d, want %d", got, tc.want)
			}
			if tc.cp != nil && got < checkpoint.Score(tc.cp) {
				t.Error("final score must never be lower than the build-time score")
			}
		})
	}
}

func TestComputeFinalScoreRecomputesAndCaps(t *testing.T) {
	// The final score is recomputed from the checkpoint's evidence, not
	// trusted from the stored Integrity.Score field, and can never exceed
	// the documented 100-point ceiling.
	cp := fullScoreCheckpoint()
	cp.Integrity.Score = 120
	if got := ComputeFinalScore(cp, true, true); got != 100 {
		t.Fatalf("ComputeFinalScore = %d, want 100", got)
	}
	cp.Integrity.Score = 0
	if got := ComputeFinalScore(cp, true, true); got != 100 {
		t.Fatalf("ComputeFinalScore with zeroed stored score = %d, want 100 (recomputed)", got)
	}
}
