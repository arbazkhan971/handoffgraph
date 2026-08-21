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
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/repository"
)

// BuildOptions configures checkpoint generation.
type BuildOptions struct {
	WorkstreamID string
	Objective    string
	Status       string
	Repo         *repository.RepoState
	Events       []*protocol.Event // events ordered by occurred_at
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

	cp := &protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  ids.Checkpoint(),
		WorkstreamID:  opts.WorkstreamID,
		Objective:     opts.Objective,
		Status:        opts.Status,
	}

	if opts.Repo != nil {
		cp.Repository = protocol.RepositoryState{
			Remote: opts.Repo.Remote,
			Branch: opts.Repo.Branch,
			Head:   opts.Repo.Head,
			Dirty:  opts.Repo.Dirty,
		}
	}

	// Accumulate evidence from events.
	sessions := map[string]*protocol.SourceSession{}
	var lastEventID string
	for _, ev := range opts.Events {
		if ev.WorkstreamID != "" && ev.WorkstreamID != opts.WorkstreamID {
			continue
		}
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
		lastEventID = ev.EventID
		applyEvent(cp, ev)
	}

	for _, s := range sessions {
		cp.SourceSessions = append(cp.SourceSessions, *s)
	}
	sort.Slice(cp.SourceSessions, func(i, j int) bool {
		return cp.SourceSessions[i].SessionID < cp.SourceSessions[j].SessionID
	})
	_ = lastEventID

	// Graph integrity hash.
	hash, err := graph.RootHashForEvents(opts.Events)
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
		cp.Decisions = append(cp.Decisions, protocol.Decision{
			Text:         payloadStr(ev, "decision", ev.EventID),
			Rationale:    payloadStr(ev, "rationale", ""),
			Provenance:   ev.Provenance,
			EvidenceRefs: payloadStrs(ev, "evidence_refs"),
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
