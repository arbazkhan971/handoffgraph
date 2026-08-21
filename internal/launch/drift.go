package launch

import (
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

// DriftReport is the result of comparing the repository state recorded in a
// checkpoint against the current worktree. The mismatch flags are fail-safe:
// each fires only when both sides are actually known, and Clean is false
// whenever the comparison is unverifiable (no recorded baseline).
type DriftReport struct {
	Clean           bool     `json:"clean"`
	HeadMismatch    bool     `json:"head_mismatch"`
	BranchMismatch  bool     `json:"branch_mismatch"`
	DirtyIntroduced bool     `json:"dirty_introduced"`
	ChangedFiles    []string `json:"changed_files,omitempty"`
}

// DetectDrift compares the checkpoint's recorded repository state with the
// current state. Rules (deterministic, fail-closed):
//
//   - A nil checkpoint, or one with no recorded repository identity at all,
//     yields an empty report with Clean=false: the repository match is
//     unverifiable, and no mismatch is asserted without a baseline.
//   - HeadMismatch / BranchMismatch fire only when the checkpoint recorded a
//     value AND the current state knows its counterpart, and they differ.
//   - DirtyIntroduced fires when the checkpoint recorded a clean worktree
//     and the current worktree is dirty (work introduced outside the
//     checkpointed sessions).
//   - ChangedFiles is reserved: repository.RepoState carries only aggregate
//     flags, not per-file state, so a per-file diff cannot be derived here
//     without fabricating evidence. It stays empty in v0.6.0.
func DetectDrift(cp *protocol.Checkpoint, current repository.RepoState) DriftReport {
	if cp == nil || !recordedRepoState(cp.Repository) {
		return DriftReport{}
	}
	base := cp.Repository
	r := DriftReport{
		HeadMismatch:    knownAndDifferent(base.Head, current.Head),
		BranchMismatch:  knownAndDifferent(base.Branch, current.Branch),
		DirtyIntroduced: !base.Dirty && current.Dirty,
	}
	r.Clean = !r.HeadMismatch && !r.BranchMismatch && !r.DirtyIntroduced && len(r.ChangedFiles) == 0
	return r
}

// recordedRepoState reports whether the checkpoint recorded any repository
// identity baseline. A dirty-only record (no remote/branch/head) is NOT a
// usable baseline: without an identity field there is nothing to compare,
// so drift stays unverifiable instead of awarding a clean match.
func recordedRepoState(rs protocol.RepositoryState) bool {
	return rs.Remote != "" || rs.Branch != "" || rs.Head != ""
}

// knownAndDifferent reports a mismatch only when both values are known and
// they differ; an unknown side never fabricates a mismatch.
func knownAndDifferent(recorded, current string) bool {
	return recorded != "" && current != "" && recorded != current
}
