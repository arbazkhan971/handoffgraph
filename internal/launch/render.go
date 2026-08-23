package launch

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Bounded-prompt limits. The continuation prompt is the payload handed to
// the next agent, so it must fit comfortably in any provider's context
// window and CLI argument limits.
const (
	maxPromptChars    = 12000
	maxObjectiveChars = 2000
	maxItemChars      = 400
	initialListCap    = 8
)

// agentLead returns the agent-specific lead sentence for the continuation
// prompt. Unknown agents get the generic lead; the body is shared because
// the evidence is identical for every receiver.
func agentLead(agent string) string {
	switch agent {
	case protocol.ProviderCodex:
		return "You are Codex, taking over an in-flight coding workstream from another agent. The evidence below was captured from real sessions; trust it over assumptions about prior work."
	case protocol.ProviderClaude:
		return "You are Claude Code, taking over an in-flight coding workstream from another agent. The evidence below was captured from real sessions; trust it over assumptions about prior work."
	case protocol.ProviderPi:
		return "You are Pi, taking over an in-flight coding workstream from another agent. The evidence below was captured from real sessions; trust it over assumptions about prior work."
	default:
		return "You are taking over an in-flight coding workstream from another coding agent. The evidence below was captured from real sessions; trust it over assumptions about prior work."
	}
}

// RenderForAgent renders the agent-specific bounded Markdown continuation
// prompt for a checkpoint.
//
// Guarantees:
//   - Deterministic: the same checkpoint and agent always render the exact
//     same string (no map iteration, no clocks).
//   - Bounded: the output is capped at maxPromptChars (~12000). Lists are
//     first truncated with a "(+N more)" marker; as a final safety net the
//     whole prompt is cut at a rune boundary with an explicit truncation
//     note.
//   - Complete: the objective, repository state, failed approaches, next
//     actions, and the acknowledgement instruction are ALWAYS present,
//     even when empty ("(none recorded)") — a missing section must never
//     look like an empty one.
//   - Provenance-preserving: each evidence item carries its provenance tag
//     so an inferred statement can never look like an observed one.
func RenderForAgent(cp *protocol.Checkpoint, agent string) string {
	if cp == nil {
		return ""
	}
	for listCap := initialListCap; listCap >= 1; listCap-- {
		s := renderPrompt(cp, agent, listCap)
		if len(s) <= maxPromptChars {
			return s
		}
	}
	return hardTruncate(renderPrompt(cp, agent, 1), maxPromptChars)
}

// renderPrompt builds the full prompt with every list capped at listCap
// items (beyond the cap a "(+N more)" marker is emitted).
func renderPrompt(cp *protocol.Checkpoint, agent string, listCap int) string {
	var b strings.Builder

	title := agent
	if title == "" {
		title = "agent"
	}
	fmt.Fprintf(&b, "# Continuation handoff for %s\n\n", title)
	fmt.Fprintf(&b, "%s\n\n", agentLead(agent))

	// Objective — always present.
	b.WriteString("## Objective\n\n")
	fmt.Fprintf(&b, "%s\n\n", orText(clampRunes(cp.Objective, maxObjectiveChars)))

	// Repository state — always present.
	b.WriteString("## Repository state (at checkpoint)\n\n")
	fmt.Fprintf(&b, "- Remote: %s\n", orBacktick(clampRunes(cp.Repository.Remote, maxItemChars)))
	fmt.Fprintf(&b, "- Branch: %s\n", orBacktick(clampRunes(cp.Repository.Branch, maxItemChars)))
	fmt.Fprintf(&b, "- HEAD: %s\n", orBacktick(clampRunes(cp.Repository.Head, maxItemChars)))
	fmt.Fprintf(&b, "- Dirty: %t\n\n", cp.Repository.Dirty)

	// Failed approaches — always present; the next agent must not repeat
	// them.
	b.WriteString("## Failed approaches (do not repeat)\n\n")
	writeList(&b, evidenceLines(cp.FailedApproaches, listCap, false))

	// Next actions — always present.
	b.WriteString("## Next actions\n\n")
	writeList(&b, evidenceLines(cp.NextActions, listCap, true))

	// Context sections — included only when evidence exists.
	if len(cp.Completed) > 0 {
		b.WriteString("## Completed work\n\n")
		writeList(&b, evidenceLines(cp.Completed, listCap, false))
	}
	if len(cp.Decisions) > 0 {
		b.WriteString("## Decisions\n\n")
		writeList(&b, decisionLines(cp.Decisions, listCap))
	}
	if len(cp.Files) > 0 {
		b.WriteString("## Files changed\n\n")
		writeList(&b, fileLines(cp.Files, listCap))
	}
	if len(cp.Commands) > 0 {
		b.WriteString("## Commands\n\n")
		writeList(&b, commandLines(cp.Commands, listCap))
	}
	if len(cp.Tests) > 0 {
		b.WriteString("## Tests\n\n")
		writeList(&b, testLines(cp.Tests, listCap))
	}
	if len(cp.Constraints) > 0 {
		b.WriteString("## Constraints\n\n")
		writeList(&b, evidenceLines(cp.Constraints, listCap, false))
	}
	if len(cp.OpenQuestions) > 0 {
		b.WriteString("## Open questions\n\n")
		writeList(&b, evidenceLines(cp.OpenQuestions, listCap, false))
	}

	// Instruction — always present.
	b.WriteString("## Instruction\n\n")
	fmt.Fprintf(&b, "Acknowledge checkpoint %s in your first reply (e.g. \"ACK %s\") before taking any action. Then continue from the next actions above.\n\n",
		cp.CheckpointID, cp.CheckpointID)
	if cp.WorkstreamID != "" {
		fmt.Fprintf(&b, "Machine reference: `hfg://workstreams/%s/checkpoints/%s`. If the HandoffGraph MCP server is available, call `accept_handoff` with `workstream_id` `%s`, `checkpoint_id` `%s`, and the sections you accepted, found missing, or could not verify.\n\n",
			cp.WorkstreamID, cp.CheckpointID, cp.WorkstreamID, cp.CheckpointID)
	}

	fmt.Fprintf(&b, "---\nCheckpoint %s", cp.CheckpointID)
	if cp.Integrity.GraphRootHash != "" {
		fmt.Fprintf(&b, " · integrity `%s`", cp.Integrity.GraphRootHash)
	}
	b.WriteString("\n")
	return b.String()
}

// writeList writes pre-rendered lines (already capped and marker-terminated)
// plus a trailing blank line.
func writeList(b *strings.Builder, lines []string) {
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

// evidenceLines renders EvidenceItems, numbered or bulleted, capped at
// listCap entries with a "(+N more)" marker; an empty list renders as
// "(none recorded)".
func evidenceLines(items []protocol.EvidenceItem, listCap int, numbered bool) []string {
	if len(items) == 0 {
		return []string{"(none recorded)"}
	}
	limit := len(items)
	if listCap < limit {
		limit = listCap
	}
	out := make([]string, 0, limit+1)
	for i := 0; i < limit; i++ {
		prefix := "- "
		if numbered {
			prefix = fmt.Sprintf("%d. ", i+1)
		}
		out = append(out, prefix+clampRunes(items[i].Text, maxItemChars)+provSuffix(items[i].Provenance))
	}
	if len(items) > limit {
		out = append(out, fmt.Sprintf("(+%d more)", len(items)-limit))
	}
	return out
}

// decisionLines renders Decisions with their rationale.
func decisionLines(items []protocol.Decision, listCap int) []string {
	if len(items) == 0 {
		return []string{"(none recorded)"}
	}
	limit := len(items)
	if listCap < limit {
		limit = listCap
	}
	out := make([]string, 0, limit+1)
	for i := 0; i < limit; i++ {
		line := "- " + clampRunes(items[i].Text, maxItemChars) + provSuffix(items[i].Provenance)
		if items[i].Rationale != "" {
			line += " — " + clampRunes(items[i].Rationale, maxItemChars)
		}
		out = append(out, line)
	}
	if len(items) > limit {
		out = append(out, fmt.Sprintf("(+%d more)", len(items)-limit))
	}
	return out
}

// fileLines renders changed files with their observed status and hash.
func fileLines(items []protocol.FileEvidence, listCap int) []string {
	if len(items) == 0 {
		return []string{"(none recorded)"}
	}
	limit := len(items)
	if listCap < limit {
		limit = listCap
	}
	out := make([]string, 0, limit+1)
	for i := 0; i < limit; i++ {
		f := items[i]
		line := "- `" + f.Path + "` (" + orText(f.Status) + ")" + provSuffix(f.Provenance)
		if f.ContentHash != "" {
			line += " `" + f.ContentHash + "`"
		}
		out = append(out, line)
	}
	if len(items) > limit {
		out = append(out, fmt.Sprintf("(+%d more)", len(items)-limit))
	}
	return out
}

// commandLines renders observed commands with their exit codes.
func commandLines(items []protocol.CommandEvidence, listCap int) []string {
	if len(items) == 0 {
		return []string{"(none recorded)"}
	}
	limit := len(items)
	if listCap < limit {
		limit = listCap
	}
	out := make([]string, 0, limit+1)
	for i := 0; i < limit; i++ {
		c := items[i]
		exit := "exit unknown"
		if c.ExitCode != nil {
			exit = fmt.Sprintf("exit %d", *c.ExitCode)
		}
		out = append(out, "- `"+clampRunes(c.Command, maxItemChars)+"` ("+exit+")"+provSuffix(c.Provenance))
	}
	if len(items) > limit {
		out = append(out, fmt.Sprintf("(+%d more)", len(items)-limit))
	}
	return out
}

// testLines renders test evidence with results and exit codes.
func testLines(items []protocol.TestEvidence, listCap int) []string {
	if len(items) == 0 {
		return []string{"(none recorded)"}
	}
	limit := len(items)
	if listCap < limit {
		limit = listCap
	}
	out := make([]string, 0, limit+1)
	for i := 0; i < limit; i++ {
		t := items[i]
		line := "- " + clampRunes(t.Name, maxItemChars) + ": " + orText(t.Result)
		if t.ExitCode != nil {
			line += fmt.Sprintf(" (exit %d)", *t.ExitCode)
		}
		out = append(out, line+provSuffix(t.Provenance))
	}
	if len(items) > limit {
		out = append(out, fmt.Sprintf("(+%d more)", len(items)-limit))
	}
	return out
}

// provSuffix renders a provenance tag inline, matching the checkpoint
// Markdown renderer's style (lowercase, italic) so inferred statements are
// visually distinct from observed ones.
func provSuffix(p protocol.Provenance) string {
	if p == "" {
		return ""
	}
	return " _[" + strings.ToLower(string(p)) + "]_"
}

// clampRunes truncates s to a conservative UTF-8-safe field budget,
// appending "..." when truncated. ASCII keeps the historical maxChars-rune
// behavior; multi-byte text is also byte-bounded so a handful of required
// fields cannot exhaust the whole continuation prompt before its instruction.
func clampRunes(s string, maxChars int) string {
	if maxChars <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= maxChars && len(s) <= maxChars {
		return s
	}
	if len(r) > maxChars {
		s = string(r[:maxChars])
	}
	return utf8Prefix(s, maxChars) + "..."
}

// hardTruncate cuts s to at most maxChars bytes on a rune boundary. When the
// prompt contains its required instruction tail, that tail is reserved first:
// pathological optional metadata can never remove the ACK, MCP reference, or
// checkpoint footer that makes the continuation verifiable.
func hardTruncate(s string, maxChars int) string {
	if len(s) <= maxChars {
		return s
	}
	marker := "\n(prompt body truncated to fit the size limit)\n"
	if maxChars < len(marker) {
		return utf8Prefix(s, maxChars)
	}
	const instructionHeading = "\n## Instruction\n\n"
	if tailAt := strings.LastIndex(s, instructionHeading); tailAt >= 0 {
		tail := s[tailAt:]
		if len(tail)+len(marker) <= maxChars {
			prefix := utf8Prefix(s[:tailAt], maxChars-len(marker)-len(tail))
			return prefix + marker + tail
		}
	}
	return utf8Prefix(s, maxChars-len(marker)) + marker
}

func utf8Prefix(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	for maxBytes > 0 && !utf8.RuneStart(s[maxBytes]) {
		maxBytes--
	}
	return s[:maxBytes]
}

// orText substitutes "(none recorded)" for empty text so an absent value is
// explicit rather than silently blank.
func orText(s string) string {
	if s == "" {
		return "(none recorded)"
	}
	return s
}

// orBacktick renders a code value or an explicit unknown marker.
func orBacktick(s string) string {
	if s == "" {
		return "(unknown)"
	}
	return "`" + s + "`"
}
