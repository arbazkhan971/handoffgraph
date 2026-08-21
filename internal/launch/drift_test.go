package launch

import (
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

func driftCheckpoint(rs protocol.RepositoryState) *protocol.Checkpoint {
	return &protocol.Checkpoint{
		CheckpointID: "cp_drift",
		WorkstreamID: "ws_drift",
		Repository:   rs,
	}
}

func TestDetectDrift(t *testing.T) {
	cases := []struct {
		name    string
		base    protocol.RepositoryState
		current repository.RepoState
		want    DriftReport
	}{
		{
			name:    "identical state is clean",
			base:    protocol.RepositoryState{Remote: "github.com/acme/app", Branch: "main", Head: "abc", Dirty: true},
			current: repository.RepoState{Remote: "github.com/acme/app", Branch: "main", Head: "abc", Dirty: true},
			want:    DriftReport{Clean: true},
		},
		{
			name:    "head moved",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc"},
			current: repository.RepoState{Branch: "main", Head: "def"},
			want:    DriftReport{HeadMismatch: true},
		},
		{
			name:    "branch switched",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc"},
			current: repository.RepoState{Branch: "feature", Head: "abc"},
			want:    DriftReport{BranchMismatch: true},
		},
		{
			name:    "clean worktree dirtied since checkpoint",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc", Dirty: false},
			current: repository.RepoState{Branch: "main", Head: "abc", Dirty: true},
			want:    DriftReport{DirtyIntroduced: true},
		},
		{
			name:    "already dirty at checkpoint stays clean when still dirty",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc", Dirty: true},
			current: repository.RepoState{Branch: "main", Head: "abc", Dirty: true},
			want:    DriftReport{Clean: true},
		},
		{
			name:    "multiple mismatches",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc", Dirty: false},
			current: repository.RepoState{Branch: "feature", Head: "def", Dirty: true},
			want:    DriftReport{HeadMismatch: true, BranchMismatch: true, DirtyIntroduced: true},
		},
		{
			name:    "unknown current head is not a fabricated mismatch",
			base:    protocol.RepositoryState{Branch: "main", Head: "abc"},
			current: repository.RepoState{Branch: "main", Head: ""},
			want:    DriftReport{Clean: true},
		},
		{
			name:    "unknown recorded head is not a fabricated mismatch",
			base:    protocol.RepositoryState{Branch: "main", Head: ""},
			current: repository.RepoState{Branch: "main", Head: "def"},
			want:    DriftReport{Clean: true},
		},
		{
			name:    "no baseline recorded is unverifiable, not clean",
			base:    protocol.RepositoryState{},
			current: repository.RepoState{Branch: "main", Head: "abc", Dirty: true},
			want:    DriftReport{}, // Clean=false, no asserted mismatch
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DetectDrift(driftCheckpoint(tc.base), tc.current)
			if got.Clean != tc.want.Clean || got.HeadMismatch != tc.want.HeadMismatch ||
				got.BranchMismatch != tc.want.BranchMismatch || got.DirtyIntroduced != tc.want.DirtyIntroduced {
				t.Fatalf("DetectDrift = %+v, want %+v", got, tc.want)
			}
			if len(got.ChangedFiles) != 0 {
				t.Errorf("ChangedFiles must stay empty in v0.6.0 (no per-file source available), got %v", got.ChangedFiles)
			}
		})
	}
}

func TestDetectDriftNilCheckpoint(t *testing.T) {
	got := DetectDrift(nil, repository.RepoState{Branch: "main", Dirty: true})
	if got.Clean {
		t.Error("nil checkpoint must not report clean (unverifiable)")
	}
	if got.HeadMismatch || got.BranchMismatch || got.DirtyIntroduced {
		t.Errorf("nil checkpoint must not assert mismatches, got %+v", got)
	}
}
