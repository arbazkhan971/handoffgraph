// Package checkpoint implements the deterministic, evidence-first checkpoint
// builder and the transparent handoff quality score.
//
// The builder runs without a model: it reads the event log and Git state and
// assembles observed evidence. Model compression may be added later and must
// then be clearly labelled INFERRED; it is never the source of truth here.
package checkpoint

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

// BuildOptions configures checkpoint generation.
type BuildOptions struct {
	WorkstreamID string
	Objective    string
	Status       string
	Repo         *repository.RepoState
	Events       []*protocol.Event // events ordered by occurred_at
	// Redaction optionally supplies the user's fail-closed deny/regex policy.
	// Nil keeps the built-in token and entropy pipeline.
	Redaction *redact.Options
}

// Build assembles a checkpoint from events and repository state.
// It is deterministic given the same inputs.
func Build(ctx context.Context, opts BuildOptions) (*protocol.Checkpoint, error) {
	if opts.WorkstreamID == "" {
		return nil, fmt.Errorf("workstream_id is required")
	}
	if opts.Status == "" {
		opts.Status = "in_progress"
	}
	// The checkpoint is a portable export surface. Initialize its redactor
	// before copying any caller-provided text so objective and repository
	// metadata receive the same known-secret protection as event evidence.
	redactionOptions := redact.Options{}
	if opts.Redaction != nil {
		redactionOptions = *opts.Redaction
	}
	engine, err := redact.New(redactionOptions)
	if err != nil {
		return nil, fmt.Errorf("checkpoint redaction engine: %w", err)
	}
	objective, _ := engine.RedactValue(opts.Objective)

	cp := &protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  ids.Checkpoint(),
		WorkstreamID:  opts.WorkstreamID,
		Objective:     objective,
		Status:        opts.Status,
	}

	if opts.Repo != nil {
		remote := redactRepositoryRemote(opts.Repo.Remote, engine)
		branch, _ := engine.RedactKnownPatterns(opts.Repo.Branch)
		head, _ := engine.RedactKnownPatterns(opts.Repo.Head)
		cp.Repository = protocol.RepositoryState{
			Remote: remote,
			Branch: branch,
			Head:   head,
			Dirty:  opts.Repo.Dirty,
		}
	}

	// Accumulate evidence from events.
	sessions := map[string]*protocol.SourceSession{}
	// Keep the original, unredacted events selected for this checkpoint in a
	// separate slice. The integrity root must cover exactly the same
	// workstream evidence as the portable projection below; callers such as
	// the CLI may pass the entire database event log.
	selectedEvents := make([]*protocol.Event, 0, len(opts.Events))
	// Redaction engine for the portable artifact. The checkpoint is the
	// export surface that leaves the local store (rendered to another
	// agent), so its payload-derived fields pass the fail-closed pipeline:
	// a redaction error aborts the build; a matched secret is masked and
	// recorded. Local viewing surfaces (graph/traces/webui) intentionally
	// show full local bodies per the capture policy; upload/share surfaces
	// will re-run redaction again (double redaction) per docs/privacy.md.
	for _, ev := range opts.Events {
		if ev.WorkstreamID != "" && ev.WorkstreamID != opts.WorkstreamID {
			continue
		}
		selectedEvents = append(selectedEvents, ev)
		if ev.SessionID != "" {
			if _, ok := sessions[ev.SessionID]; !ok {
				sessions[ev.SessionID] = &protocol.SourceSession{
					Provider:        ev.Provider,
					NativeSessionID: ev.NativeSessionID,
					SessionID:       ev.SessionID,
				}
			}
			sessions[ev.SessionID].LastEventID = ev.EventID
		}
		// Redact a copy: raw events are append-only source evidence and must
		// remain byte-for-byte unchanged in memory as well as on disk. The
		// sanitized copy feeds the portable checkpoint, while graph integrity
		// below is calculated from the original event log.
		sanitized := *ev
		sanitized.Payload = append([]byte(nil), ev.Payload...)
		if _, err := engine.RedactEvent(&sanitized); err != nil {
			return nil, fmt.Errorf("checkpoint redaction (fail-closed) on event %s: %w", ev.EventID, err)
		}
		applyEvent(cp, &sanitized)
	}

	for _, s := range sessions {
		cp.SourceSessions = append(cp.SourceSessions, *s)
	}
	sort.Slice(cp.SourceSessions, func(i, j int) bool {
		return cp.SourceSessions[i].SessionID < cp.SourceSessions[j].SessionID
	})
	// Graph integrity hash.
	hash, err := graph.RootHashForEvents(selectedEvents)
	if err != nil {
		return nil, fmt.Errorf("graph root hash: %w", err)
	}
	cp.Integrity.GraphRootHash = hash
	cp.Integrity.Score = Score(cp)

	return cp, nil
}

func applyEvent(cp *protocol.Checkpoint, ev *protocol.Event) {
	switch ev.Kind {
	case protocol.EventDecisionRecorded:
		refs := payloadStrs(ev, "evidence_refs")
		if len(refs) == 0 {
			refs = []string{ev.EventID}
		}
		cp.Decisions = append(cp.Decisions, protocol.Decision{
			Text:         payloadStr(ev, "decision", ev.EventID),
			Rationale:    payloadStr(ev, "rationale", ""),
			Provenance:   ev.Provenance,
			EvidenceRefs: refs,
		})
	case protocol.EventFileCreated, protocol.EventFileEdited, protocol.EventFileDeleted:
		cp.Files = append(cp.Files, protocol.FileEvidence{
			Path:         payloadStr(ev, "path", ""),
			Status:       fileStatus(ev.Kind),
			ContentHash:  payloadStr(ev, "content_hash", ""),
			Provenance:   ev.Provenance,
			EvidenceRefs: []string{ev.EventID},
		})
	case protocol.EventCommandCompleted:
		code := payloadInt(ev, "exit_code")
		cp.Commands = append(cp.Commands, protocol.CommandEvidence{
			Command:       payloadStr(ev, "command", ""),
			ExitCode:      code,
			OutputExcerpt: payloadStr(ev, "output_excerpt", ""),
			Provenance:    ev.Provenance,
			EvidenceRefs:  []string{ev.EventID},
		})
	case protocol.EventTestCompleted:
		code := payloadInt(ev, "exit_code")
		cp.Tests = append(cp.Tests, protocol.TestEvidence{
			Name:          payloadStr(ev, "name", ""),
			Result:        payloadStr(ev, "result", ""),
			ExitCode:      code,
			OutputExcerpt: payloadStr(ev, "output_excerpt", ""),
			Provenance:    ev.Provenance,
			EvidenceRefs:  []string{ev.EventID},
		})
	case protocol.EventErrorObserved:
		cp.FailedApproaches = append(cp.FailedApproaches, protocol.EvidenceItem{
			Text:         payloadStr(ev, "message", ev.EventID),
			Provenance:   ev.Provenance,
			EvidenceRefs: []string{ev.EventID},
		})
	}
}

// redactRepositoryRemote protects credentials and known token shapes while
// preserving an ordinary repository URL. Applying entropy detection to the
// entire URL produces false positives for commonplace account names that
// contain digits, destroying repository identity needed for drift checks.
func redactRepositoryRemote(remote string, engine *redact.Engine) string {
	if remote == "" {
		return ""
	}
	// Strip URL userinfo independently of token/regex matching. Returning
	// after the first successful stage would leak credentials whenever a
	// different part of the same URL also matched a known token pattern.
	out := remote
	u, err := url.Parse(out)
	lower := strings.ToLower(out)
	if err != nil && (strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")) && strings.Contains(out, "@") {
		// A malformed credential-bearing URL cannot be safely decomposed. Mask
		// the whole value rather than exporting the original on a parse error.
		return redact.Mask
	}
	if err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.User != nil {
		u.User = url.User(redact.Mask)
		// url.URL.String percent-escapes square brackets in userinfo. Restore
		// the standard visible mask so all checkpoint surfaces consistently
		// communicate that a value was removed.
		out = strings.Replace(u.String(), url.User(redact.Mask).String(), redact.Mask, 1)
	}
	out, _ = engine.RedactKnownPatterns(out)
	return out
}

func fileStatus(k protocol.EventKind) string {
	switch k {
	case protocol.EventFileCreated:
		return "created"
	case protocol.EventFileDeleted:
		return "deleted"
	default:
		return "edited"
	}
}

// Score computes the transparent handoff quality score (0-100).
// Weights are fixed and documented; no mysterious AI score.
func Score(cp *protocol.Checkpoint) int {
	score := 0
	if cp.Objective != "" {
		score += 10
	}
	if cp.Repository.Remote != "" || cp.Repository.Branch != "" || cp.Repository.Head != "" {
		score += 10
	}
	if cp.Repository.Dirty || len(cp.Files) > 0 {
		score += 15
	}
	if len(cp.Decisions) > 0 {
		score += 10
	}
	if len(cp.FailedApproaches) > 0 {
		score += 10
	}
	if len(cp.Commands) > 0 {
		score += 10
	}
	hasTestExit := false
	for _, t := range cp.Tests {
		if t.ExitCode != nil {
			hasTestExit = true
			break
		}
	}
	if hasTestExit {
		score += 15
	}
	if len(cp.NextActions) > 0 {
		score += 10
	}
	// Target acceptance (+5) and repository match (+5) are added at handoff
	// time by the continuation layer; not available at build time.
	return score
}

func payloadStr(ev *protocol.Event, key, def string) string {
	if len(ev.Payload) == 0 {
		return def
	}
	var m map[string]any
	if err := jsonUnmarshal(ev.Payload, &m); err != nil {
		return def
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}

func payloadStrs(ev *protocol.Event, key string) []string {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := jsonUnmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	raw, ok := m[key].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, it := range raw {
		if s, ok := it.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func payloadInt(ev *protocol.Event, key string) *int {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := jsonUnmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	switch v := m[key].(type) {
	case float64:
		i := int(v)
		return &i
	case int:
		return &v
	}
	return nil
}
