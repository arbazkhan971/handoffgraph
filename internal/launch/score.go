package launch

import (
	"github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// ComputeFinalScore completes the documented 100-point handoff quality
// scale (see internal/checkpoint.Score). checkpoint.Score awards up to 90
// points at build time and deliberately holds back 10 points of
// handoff-time evidence:
//
//	+5  the target agent acknowledged the checkpoint (accepted)
//	+5  the current repository matches the checkpoint's recorded state
//	    (drift clean)
//
// The held-back points are only ever awarded on verified evidence, never
// guessed. ComputeFinalScore is deterministic and never exceeds 100.
func ComputeFinalScore(cp *protocol.Checkpoint, accepted bool, driftClean bool) int {
	if cp == nil {
		return 0
	}
	score := checkpoint.Score(cp)
	if accepted {
		score += 5
	}
	if driftClean {
		score += 5
	}
	if score > 100 {
		score = 100 // defensive: the documented scale tops out at 100
	}
	return score
}
