package checkpoint

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }

// RenderMarkdown renders a human-readable Markdown view of a checkpoint.
// The rendering is deterministic and never invents evidence: provenance and
// evidence references are shown inline.
func RenderMarkdown(cp *protocol.Checkpoint) string {
	var b bytes.Buffer

	fmt.Fprintf(&b, "# Checkpoint %s\n\n", cp.CheckpointID)
	fmt.Fprintf(&b, "**Objective:** %s\n\n", or(cp.Objective, "(none)"))
	fmt.Fprintf(&b, "**Status:** %s\n\n", cp.Status)
	fmt.Fprintf(&b, "**Score:** %d/100\n\n", cp.Integrity.Score)

	if cp.Repository.Remote != "" || cp.Repository.Branch != "" || cp.Repository.Head != "" {
		b.WriteString("## Repository\n\n")
		fmt.Fprintf(&b, "- Remote: `%s`\n", or(cp.Repository.Remote, "(unknown)"))
		fmt.Fprintf(&b, "- Branch: `%s`\n", or(cp.Repository.Branch, "(unknown)"))
		fmt.Fprintf(&b, "- HEAD: `%s`\n", or(cp.Repository.Head, "(unknown)"))
		fmt.Fprintf(&b, "- Dirty: %t\n\n", cp.Repository.Dirty)
	}

	if len(cp.SourceSessions) > 0 {
		b.WriteString("## Source Sessions\n\n")
		for _, s := range cp.SourceSessions {
			fmt.Fprintf(&b, "- `%s` (%s) last event `%s`\n", s.NativeSessionID, s.Provider, or(s.LastEventID, "-"))
		}
		b.WriteString("\n")
	}

	if len(cp.Completed) > 0 {
		b.WriteString("## Completed\n\n")
		for _, item := range cp.Completed {
			fmt.Fprintf(&b, "- %s%s\n", item.Text, provSuffix(item.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.Decisions) > 0 {
		b.WriteString("## Decisions\n\n")
		for _, d := range cp.Decisions {
			fmt.Fprintf(&b, "- %s%s", d.Text, provSuffix(d.Provenance))
			if d.Rationale != "" {
				fmt.Fprintf(&b, "\n  - _%s_", d.Rationale)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	if len(cp.Files) > 0 {
		b.WriteString("## Files Changed\n\n")
		for _, f := range cp.Files {
			fmt.Fprintf(&b, "- `%s` (%s)%s", f.Path, or(f.Status, "changed"), provSuffix(f.Provenance))
			if f.ContentHash != "" {
				fmt.Fprintf(&b, " `%s`", f.ContentHash)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	if len(cp.Commands) > 0 {
		b.WriteString("## Commands\n\n")
		for _, c := range cp.Commands {
			exit := ""
			if c.ExitCode != nil {
				exit = fmt.Sprintf(" (exit %d)", *c.ExitCode)
			}
			fmt.Fprintf(&b, "- `%s`%s%s\n", c.Command, exit, provSuffix(c.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.Tests) > 0 {
		b.WriteString("## Tests\n\n")
		for _, t := range cp.Tests {
			fmt.Fprintf(&b, "- %s: %s%s\n", t.Name, or(t.Result, "unknown"), provSuffix(t.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.FailedApproaches) > 0 {
		b.WriteString("## Failed Approaches\n\n")
		for _, item := range cp.FailedApproaches {
			fmt.Fprintf(&b, "- %s%s\n", item.Text, provSuffix(item.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.Constraints) > 0 {
		b.WriteString("## Constraints\n\n")
		for _, item := range cp.Constraints {
			fmt.Fprintf(&b, "- %s%s\n", item.Text, provSuffix(item.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.OpenQuestions) > 0 {
		b.WriteString("## Open Questions\n\n")
		for _, item := range cp.OpenQuestions {
			fmt.Fprintf(&b, "- %s%s\n", item.Text, provSuffix(item.Provenance))
		}
		b.WriteString("\n")
	}

	if len(cp.NextActions) > 0 {
		b.WriteString("## Next Actions\n\n")
		for i, item := range cp.NextActions {
			fmt.Fprintf(&b, "%d. %s%s\n", i+1, item.Text, provSuffix(item.Provenance))
		}
		b.WriteString("\n")
	}

	fmt.Fprintf(&b, "---\nGraph root hash: `%s`\n", cp.Integrity.GraphRootHash)
	return b.String()
}

func provSuffix(p protocol.Provenance) string {
	if p == "" {
		return ""
	}
	return " _[" + strings.ToLower(string(p)) + "]_"
}

func or(a, b string) string {
	if a == "" {
		return b
	}
	return a
}
