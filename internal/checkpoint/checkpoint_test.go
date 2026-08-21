package checkpoint

import (
	"context"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

func TestBuildNoModel(t *testing.T) {
	events := fixture.GenerateSynthetic(50)
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "fix duplicate checkout",
		Status:       "in_progress",
		Repo: &repository.RepoState{
			Remote: "github.com/acme/shop",
			Branch: "fix/checkout-race",
			Head:   "71ab20",
			Dirty:  true,
		},
		Events: events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cp.CheckpointID == "" {
		t.Fatal("missing checkpoint id")
	}
	if cp.SchemaVersion != "hfg.checkpoint.v1" {
		t.Fatalf("schema version = %s", cp.SchemaVersion)
	}
	if cp.Integrity.GraphRootHash == "" {
		t.Fatal("missing graph root hash")
	}
	if cp.Integrity.Score <= 0 {
		t.Fatalf("score = %d, want > 0", cp.Integrity.Score)
	}
	if len(cp.SourceSessions) == 0 {
		t.Fatal("expected source sessions")
	}
	if len(cp.Commands) == 0 {
		t.Fatal("expected commands to be captured")
	}
	if len(cp.Tests) == 0 {
		t.Fatal("expected tests to be captured")
	}
}

func TestScoreBounds(t *testing.T) {
	events := fixture.GenerateSynthetic(10)
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "test",
		Repo:         &repository.RepoState{Dirty: true},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cp.Integrity.Score < 0 || cp.Integrity.Score > 100 {
		t.Fatalf("score out of bounds: %d", cp.Integrity.Score)
	}
}

func TestRenderMarkdown(t *testing.T) {
	events := fixture.GenerateSynthetic(5)
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "render test",
		Repo:         &repository.RepoState{Branch: "main", Head: "abc", Dirty: false},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	md := RenderMarkdown(cp)
	if !strings.Contains(md, cp.CheckpointID) {
		t.Fatal("markdown missing checkpoint id")
	}
	if !strings.Contains(md, "render test") {
		t.Fatal("markdown missing objective")
	}
	if !strings.Contains(md, cp.Integrity.GraphRootHash) {
		t.Fatal("markdown missing graph hash")
	}
}

func TestDeterministicBuild(t *testing.T) {
	events := fixture.GenerateSynthetic(20)
	a, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "x",
		Repo:         &repository.RepoState{Dirty: false},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Checkpoint IDs differ (ULID), but the graph hash and score must match.
	b, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "x",
		Repo:         &repository.RepoState{Dirty: false},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.Integrity.GraphRootHash != b.Integrity.GraphRootHash {
		t.Fatal("graph hash not deterministic")
	}
	if a.Integrity.Score != b.Integrity.Score {
		t.Fatal("score not deterministic")
	}
}
