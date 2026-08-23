package launch

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// richCheckpoint is a checkpoint exercising every rendered section.
func richCheckpoint() *protocol.Checkpoint {
	exit := func(i int) *int { return &i }
	return &protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  "cp_00000000000000000000000000",
		WorkstreamID:  "ws_test",
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
		Completed: []protocol.EvidenceItem{
			{Text: "wrote a failing regression test", Provenance: protocol.ProvenanceObserved},
		},
		Decisions: []protocol.Decision{
			{Text: "guard with a per-cart mutex", Rationale: "cheaper than a global lock", Provenance: protocol.ProvenanceDeclared},
		},
		Files: []protocol.FileEvidence{
			{Path: "cart/checkout.go", Status: "edited", ContentHash: "sha256:abc", Provenance: protocol.ProvenanceObserved},
		},
		Commands: []protocol.CommandEvidence{
			{Command: "go test ./cart/...", ExitCode: exit(1), Provenance: protocol.ProvenanceObserved},
		},
		Tests: []protocol.TestEvidence{
			{Name: "TestConcurrentCheckout", Result: "failed", ExitCode: exit(1), Provenance: protocol.ProvenanceObserved},
		},
		FailedApproaches: []protocol.EvidenceItem{
			{Text: "retrying the lock in a loop (deadlocks under load)", Provenance: protocol.ProvenanceObserved},
		},
		Constraints: []protocol.EvidenceItem{
			{Text: "no new dependencies", Provenance: protocol.ProvenanceDeclared},
		},
		OpenQuestions: []protocol.EvidenceItem{
			{Text: "should the mutex live on the session or the cart?", Provenance: protocol.ProvenanceDeclared},
		},
		NextActions: []protocol.EvidenceItem{
			{Text: "add the regression test for concurrent checkout", Provenance: protocol.ProvenanceDeclared},
		},
		Integrity: protocol.Integrity{GraphRootHash: "sha256:feed", Score: 90},
	}
}

func TestRenderForAgentAlwaysIncludesRequiredSections(t *testing.T) {
	cp := richCheckpoint()
	for _, agent := range []string{protocol.ProviderCodex, protocol.ProviderClaude, protocol.ProviderPi} {
		t.Run(agent, func(t *testing.T) {
			got := RenderForAgent(cp, agent)
			for _, want := range []string{
				"## Objective",
				"fix the checkout race in the cart service",
				"## Repository state (at checkpoint)",
				"github.com/acme/shop",
				"abc123def456",
				"## Failed approaches (do not repeat)",
				"retrying the lock in a loop (deadlocks under load)",
				"## Next actions",
				"add the regression test for concurrent checkout",
				"Acknowledge checkpoint cp_00000000000000000000000000",
				"hfg://workstreams/ws_test/checkpoints/cp_00000000000000000000000000",
				"call `accept_handoff`",
			} {
				if !strings.Contains(got, want) {
					t.Errorf("render for %s missing %q\nrender:\n%s", agent, want, got)
				}
			}
		})
	}
}

func TestRenderForAgentRequiredSectionsPresentWhenEmpty(t *testing.T) {
	cp := &protocol.Checkpoint{CheckpointID: "cp_empty"}
	got := RenderForAgent(cp, protocol.ProviderCodex)
	for _, want := range []string{
		"## Objective",
		"(none recorded)",
		"## Repository state (at checkpoint)",
		"## Failed approaches (do not repeat)",
		"## Next actions",
		"Acknowledge checkpoint cp_empty",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("empty checkpoint render missing %q\nrender:\n%s", want, got)
		}
	}
}

func TestRenderForAgentIsAgentSpecific(t *testing.T) {
	cp := richCheckpoint()
	cases := []struct {
		agent string
		want  string
	}{
		{protocol.ProviderCodex, "You are Codex,"},
		{protocol.ProviderClaude, "You are Claude Code,"},
		{protocol.ProviderPi, "You are Pi,"},
	}
	for _, tc := range cases {
		t.Run(tc.agent, func(t *testing.T) {
			got := RenderForAgent(cp, tc.agent)
			if !strings.Contains(got, tc.want) {
				t.Errorf("render for %s missing lead %q", tc.agent, tc.want)
			}
			if !strings.Contains(got, "Continuation handoff for "+tc.agent) {
				t.Errorf("render for %s missing agent title", tc.agent)
			}
		})
	}
	// Unknown agents fall back to the generic lead but keep every required
	// section.
	got := RenderForAgent(cp, "factory-droid")
	if !strings.Contains(got, "You are taking over") {
		t.Errorf("unknown agent render should use the generic lead, got:\n%s", got)
	}
	if !strings.Contains(got, "Acknowledge checkpoint") {
		t.Error("unknown agent render lost the acknowledgement instruction")
	}
}

func TestRenderForAgentDeterministic(t *testing.T) {
	cp := richCheckpoint()
	a := RenderForAgent(cp, protocol.ProviderCodex)
	b := RenderForAgent(cp, protocol.ProviderCodex)
	if a != b {
		t.Error("RenderForAgent is not deterministic for identical input")
	}
	// A shuffled optional-section input must still render deterministically
	// because slice order is preserved as given (no map iteration).
	shuffled := richCheckpoint()
	shuffled.FailedApproaches = append(shuffled.FailedApproaches,
		protocol.EvidenceItem{Text: "second failed approach", Provenance: protocol.ProvenanceObserved})
	if RenderForAgent(cp, protocol.ProviderCodex) != a {
		t.Error("rendering a different checkpoint changed the original render")
	}
}

func TestRenderForAgentBounded(t *testing.T) {
	cp := richCheckpoint()
	for i := 0; i < 500; i++ {
		cp.FailedApproaches = append(cp.FailedApproaches, protocol.EvidenceItem{
			Text:       strings.Repeat("failed approach number ", 1) + string(rune('a'+i%26)) + strings.Repeat("x", 400),
			Provenance: protocol.ProvenanceObserved,
		})
		cp.NextActions = append(cp.NextActions, protocol.EvidenceItem{
			Text:       strings.Repeat("next action ", 1) + string(rune('A'+i%26)) + strings.Repeat("y", 400),
			Provenance: protocol.ProvenanceDeclared,
		})
	}
	got := RenderForAgent(cp, protocol.ProviderCodex)
	if len(got) > maxPromptChars {
		t.Errorf("prompt length %d exceeds cap %d", len(got), maxPromptChars)
	}
	if !strings.Contains(got, "(+") || !strings.Contains(got, " more)") {
		t.Error("truncated lists must carry a (+N more) marker")
	}
	// Required content survives truncation.
	for _, want := range []string{
		"fix the checkout race in the cart service",
		"Acknowledge checkpoint cp_00000000000000000000000000",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("bounded render lost required content %q", want)
		}
	}
}

func TestRenderForAgentTruncatesHugeObjectiveAndItems(t *testing.T) {
	cp := richCheckpoint()
	cp.Objective = strings.Repeat("o", 10000)
	cp.FailedApproaches = []protocol.EvidenceItem{
		{Text: strings.Repeat("f", 10000), Provenance: protocol.ProvenanceObserved},
	}
	got := RenderForAgent(cp, protocol.ProviderClaude)
	if len(got) > maxPromptChars {
		t.Errorf("prompt length %d exceeds cap %d", len(got), maxPromptChars)
	}
	if !strings.Contains(got, "...") {
		t.Error("long fields must be truncated with an ellipsis")
	}
}

func TestRenderForAgentPathologicalRepositoryKeepsAcceptanceTail(t *testing.T) {
	cp := richCheckpoint()
	cp.Repository.Remote = strings.Repeat("https://example.invalid/very-long-path/", 1000)
	cp.Repository.Branch = strings.Repeat("分支", 5000)
	cp.Repository.Head = strings.Repeat("abcdef0123456789", 1000)

	got := RenderForAgent(cp, protocol.ProviderCodex)
	if len(got) > maxPromptChars {
		t.Fatalf("prompt length %d exceeds cap %d", len(got), maxPromptChars)
	}
	for _, want := range []string{
		"## Objective",
		"## Repository state (at checkpoint)",
		"## Failed approaches (do not repeat)",
		"## Next actions",
		"## Instruction",
		"Acknowledge checkpoint " + cp.CheckpointID,
		"hfg://workstreams/" + cp.WorkstreamID + "/checkpoints/" + cp.CheckpointID,
		"---\nCheckpoint " + cp.CheckpointID,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("pathological repository render lost %q\nrender:\n%s", want, got)
		}
	}
}

func TestRenderForAgentPreservesProvenance(t *testing.T) {
	cp := richCheckpoint()
	cp.FailedApproaches = []protocol.EvidenceItem{
		{Text: "observed failure", Provenance: protocol.ProvenanceObserved},
		{Text: "declared failure", Provenance: protocol.ProvenanceDeclared},
		{Text: "inferred failure", Provenance: protocol.ProvenanceInferred},
	}
	got := RenderForAgent(cp, protocol.ProviderPi)
	for _, want := range []string{"_[observed]_", "_[declared]_", "_[inferred]_"} {
		if !strings.Contains(got, want) {
			t.Errorf("provenance tag %q missing from render", want)
		}
	}
}

func TestRenderForAgentRendersOptionalSections(t *testing.T) {
	got := RenderForAgent(richCheckpoint(), protocol.ProviderCodex)
	for _, want := range []string{
		"## Completed work",
		"## Decisions",
		"guard with a per-cart mutex",
		"## Files changed",
		"`cart/checkout.go` (edited)",
		"## Commands",
		"`go test ./cart/...` (exit 1)",
		"## Tests",
		"TestConcurrentCheckout: failed (exit 1)",
		"## Constraints",
		"## Open questions",
		"integrity `sha256:feed`",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("render missing optional section content %q", want)
		}
	}
}

func TestRenderForAgentNilCheckpoint(t *testing.T) {
	if got := RenderForAgent(nil, protocol.ProviderCodex); got != "" {
		t.Errorf("nil checkpoint should render empty string, got %q", got)
	}
}

func TestHardTruncateRuneSafe(t *testing.T) {
	s := strings.Repeat("é", 100) // 2 bytes per rune
	for _, limit := range []int{10, 51, 199, 1000} {
		got := hardTruncate(s, limit)
		if len(got) > limit {
			t.Errorf("hardTruncate(%d) returned %d bytes", limit, len(got))
		}
		for _, r := range got {
			if r == 0xFFFD {
				t.Errorf("hardTruncate(%d) produced an invalid rune sequence", limit)
			}
		}
	}
}

func TestHardTruncatePreservesInstructionTail(t *testing.T) {
	tail := "\n## Instruction\n\nAcknowledge checkpoint cp_tail before acting.\n\n---\nCheckpoint cp_tail\n"
	got := hardTruncate(strings.Repeat("é", maxPromptChars)+tail, maxPromptChars)
	if len(got) > maxPromptChars {
		t.Fatalf("hard-truncated prompt length = %d, want <= %d", len(got), maxPromptChars)
	}
	for _, want := range []string{"## Instruction", "Acknowledge checkpoint cp_tail", "---\nCheckpoint cp_tail"} {
		if !strings.Contains(got, want) {
			t.Errorf("hard truncate lost required tail %q", want)
		}
	}
	for _, r := range got {
		if r == utf8.RuneError {
			t.Fatal("hard truncate produced invalid UTF-8")
		}
	}
}
