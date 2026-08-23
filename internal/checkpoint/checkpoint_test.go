package checkpoint

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
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

func TestBuildRedactsPortableEvidenceWithoutMutatingSourceOrIntegrity(t *testing.T) {
	events := fixture.GenerateSynthetic(1)
	var command *protocol.Event
	for _, ev := range events {
		if ev.Kind == protocol.EventCommandCompleted {
			command = ev
			break
		}
	}
	if command == nil {
		t.Fatal("synthetic fixture has no command event")
	}
	secret := "sk-" + strings.Repeat("a", 24)
	command.Payload, _ = json.Marshal(map[string]any{
		"command":   "deploy --api-key=" + secret,
		"exit_code": 0,
	})
	originalPayload := append([]byte(nil), command.Payload...)
	rawHash, err := graph.RootHashForEvents(events)
	if err != nil {
		t.Fatal(err)
	}

	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "verify with token " + secret,
		Repo: &repository.RepoState{
			Remote: "https://api_key=" + secret + "@example.invalid/repo.git",
			Branch: "main",
		},
		Events: events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(command.Payload, originalPayload) {
		t.Fatalf("checkpoint build mutated append-only source payload\nbefore: %s\nafter:  %s", originalPayload, command.Payload)
	}
	if cp.Integrity.GraphRootHash != rawHash {
		t.Fatalf("checkpoint graph hash = %s, raw event graph hash = %s", cp.Integrity.GraphRootHash, rawHash)
	}
	if len(cp.Commands) != 1 {
		t.Fatalf("commands = %d, want 1", len(cp.Commands))
	}
	if strings.Contains(cp.Commands[0].Command, secret) || !strings.Contains(cp.Commands[0].Command, "[REDACTED]") {
		t.Fatalf("portable command was not redacted: %q", cp.Commands[0].Command)
	}
	if strings.Contains(cp.Objective, secret) || !strings.Contains(cp.Objective, "[REDACTED]") {
		t.Fatalf("portable objective was not redacted: %q", cp.Objective)
	}
	if strings.Contains(cp.Repository.Remote, secret) || !strings.Contains(cp.Repository.Remote, "[REDACTED]") {
		t.Fatalf("portable repository remote was not redacted: %q", cp.Repository.Remote)
	}
}

func TestBuildPreservesOrdinaryRemoteAndEvidenceLinksDecisions(t *testing.T) {
	events := fixture.GenerateSynthetic(0)
	decision := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		WorkstreamID:  events[0].WorkstreamID,
		Kind:          protocol.EventDecisionRecorded,
		Provenance:    protocol.ProvenanceDeclared,
		Payload:       json.RawMessage(`{"decision":"keep the append-only event spine"}`),
	}
	events = append(events, decision)
	remote := "https://github.com/arbazkhan971/handoffgraph.git"
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Repo:         &repository.RepoState{Remote: remote, Branch: "feature/issue-1234567890"},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cp.Repository.Remote != remote {
		t.Fatalf("ordinary remote = %q, want preserved %q", cp.Repository.Remote, remote)
	}
	if cp.Repository.Branch != "feature/issue-1234567890" {
		t.Fatalf("ordinary branch was falsely redacted: %q", cp.Repository.Branch)
	}
	if len(cp.Decisions) != 1 || len(cp.Decisions[0].EvidenceRefs) != 1 || cp.Decisions[0].EvidenceRefs[0] != decision.EventID {
		t.Fatalf("decision evidence refs = %+v, want source event %s", cp.Decisions, decision.EventID)
	}
}

func TestBuildAppliesConfiguredRedactionAndFailsClosed(t *testing.T) {
	events := fixture.GenerateSynthetic(0)
	pattern := redact.Options{UserPatterns: []string{`private-[0-9]+`}}
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Objective:    "continue private-12345 safely",
		Events:       events,
		Redaction:    &pattern,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(cp.Objective, "private-12345") || !strings.Contains(cp.Objective, "[REDACTED]") {
		t.Fatalf("configured pattern did not redact objective: %q", cp.Objective)
	}

	invalid := redact.Options{UserPatterns: []string{"["}}
	if _, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Events:       events,
		Redaction:    &invalid,
	}); err == nil || !strings.Contains(err.Error(), "checkpoint redaction engine") {
		t.Fatalf("invalid export redaction policy error = %v, want fail-closed rejection", err)
	}
}

func TestBuildIntegrityIsScopedToCheckpointWorkstream(t *testing.T) {
	events := fixture.GenerateSynthetic(1)
	workstreamID := events[0].WorkstreamID
	other := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		WorkstreamID:  "ws_unrelated",
		Kind:          protocol.EventDecisionRecorded,
		Provenance:    protocol.ProvenanceDeclared,
		Payload:       json.RawMessage(`{"decision":"unrelated"}`),
	}

	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: workstreamID,
		Events:       append(append([]*protocol.Event(nil), events...), other),
	})
	if err != nil {
		t.Fatal(err)
	}
	want, err := graph.RootHashForEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	if cp.Integrity.GraphRootHash != want {
		t.Fatalf("checkpoint graph hash = %s, scoped workstream hash = %s", cp.Integrity.GraphRootHash, want)
	}
}

func TestBuildRepositoryRemoteRedactionComposesCredentialsAndTokens(t *testing.T) {
	events := fixture.GenerateSynthetic(0)
	githubToken := "ghp_" + strings.Repeat("a", 36)
	remote := "https://alice:supersecret@example.invalid/acme/" + githubToken + ".git"
	cp, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Repo:         &repository.RepoState{Remote: remote},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"alice", "supersecret", githubToken, "ghp_"} {
		if strings.Contains(cp.Repository.Remote, secret) {
			t.Fatalf("repository remote leaked %q after composed redaction: %q", secret, cp.Repository.Remote)
		}
	}

	malformed, err := Build(context.Background(), BuildOptions{
		WorkstreamID: events[0].WorkstreamID,
		Repo:         &repository.RepoState{Remote: "https://alice:supersecret@example.invalid/%zz"},
		Events:       events,
	})
	if err != nil {
		t.Fatal(err)
	}
	if malformed.Repository.Remote != redact.Mask {
		t.Fatalf("malformed credential-bearing remote = %q, want fail-closed mask", malformed.Repository.Remote)
	}
}
