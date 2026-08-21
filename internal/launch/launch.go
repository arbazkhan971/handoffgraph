// Package launch implements the v0.6.0 cross-agent continuation layer: it
// turns a stored checkpoint into a bounded, agent-specific continuation
// payload plus the native launch spec, records the handoff as an
// append-only handoff.created event in the storage DB, and derives the
// handoff status read model back out of the event log.
//
// The handoff record (id, source checkpoint, target agent, status,
// created_at, launch mode, exec spec, drift summary) is stored inside the
// handoff.created event payload — events are the append-only source of
// truth and read models are always derived, never mutated in place
// (AGENTS.md). Acceptance is a second append-only event (handoff.accepted).
package launch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/adapter/pi"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// Launch modes. Same provider resumes the source native session; a cross
// provider starts a new session seeded by the checkpoint.
const (
	ModeNativeResume   = "native_resume"
	ModeCheckpointSeed = "checkpoint_seed"
)

// Handoff record statuses (derived from the event log).
const (
	StatusCreated  = "created"
	StatusAccepted = "accepted"
)

// PrefixHandoff is the self-describing ULID prefix for handoff ids.
const PrefixHandoff = "ho_"

// HandoffRecord is the durable handoff record. It is written once inside
// the handoff.created event payload and re-derived (with acknowledgement
// state folded in from handoff.accepted events) by ListHandoffs.
type HandoffRecord struct {
	ID               string    `json:"id"`
	WorkstreamID     string    `json:"workstream_id"`
	SourceCheckpoint string    `json:"source_checkpoint"`
	SourceProvider   string    `json:"source_provider,omitempty"`
	TargetAgent      string    `json:"target_agent"`
	Mode             string    `json:"mode"`
	Status           string    `json:"status"`
	CreatedAt        time.Time `json:"created_at"`
	AcceptedAt       time.Time `json:"accepted_at,omitempty"`
	Accepted         []string  `json:"accepted,omitempty"`
	Missing          []string  `json:"missing,omitempty"`
	Unverifiable     []string  `json:"unverifiable,omitempty"`
}

// Options configures Prepare and Continue.
type Options struct {
	WorkstreamID string                // required unless Checkpoint is set
	TargetAgent  string                // required: codex | claude | pi
	Checkpoint   *protocol.Checkpoint  // optional: use directly instead of the latest stored checkpoint
	Repo         *repository.RepoState // optional: current repo state; detected from "." when nil
	Now          time.Time             // optional: clock override for deterministic tests
}

// Result is the outcome of preparing (and, for Continue, recording) a
// cross-agent continuation. Spec is the native launch invocation — the
// caller decides whether and how to exec it; this layer never does.
type Result struct {
	Handoff    *HandoffRecord
	Checkpoint *protocol.Checkpoint
	Spec       adapter.ExecSpec
	Prompt     string
	Drift      DriftReport
}

// createdPayload is the handoff.created event payload: the durable handoff
// record plus the launch context (spec, drift, bounded prompt digest).
type createdPayload struct {
	HandoffRecord
	Spec        *adapter.ExecSpec `json:"spec,omitempty"`
	Drift       *DriftReport      `json:"drift"`
	PromptChars int               `json:"prompt_chars,omitempty"`
	PromptHash  string            `json:"prompt_hash,omitempty"`
}

// acceptedPayload is the handoff.accepted event payload.
type acceptedPayload struct {
	HandoffID    string    `json:"handoff_id"`
	Agent        string    `json:"agent,omitempty"`
	AcceptedAt   time.Time `json:"accepted_at"`
	Accepted     []string  `json:"accepted,omitempty"`
	Missing      []string  `json:"missing,omitempty"`
	Unverifiable []string  `json:"unverifiable,omitempty"`
}

// resolveLaunchAdapter looks up the named adapter in a fresh registry. It
// mirrors internal/commands.resolveAdapter locally: the commands package
// owns CLI wiring and must not become a dependency of the launch layer.
// A fresh registry per call also keeps any adapter mutation from leaking
// between invocations.
func resolveLaunchAdapter(name string) (adapter.Adapter, error) {
	if name == "" {
		return nil, fmt.Errorf("target agent is required (available: %s)", adapterNames())
	}
	reg := adapter.NewRegistry(codex.New(), claude.New(), pi.New())
	a, ok := reg.Get(name)
	if !ok {
		return nil, fmt.Errorf("unknown agent %q (available: %s)", name, adapterNames())
	}
	return a, nil
}

func adapterNames() string {
	reg := adapter.NewRegistry(codex.New(), claude.New(), pi.New())
	return strings.Join(reg.Names(), ", ")
}

// Prepare resolves the continuation for opts without writing anything: it
// loads the checkpoint, detects drift against the current repository
// state, picks the launch mode (same provider: native resume of the source
// session; cross provider: checkpoint-seeded start), renders the bounded
// agent payload, and builds the handoff record. The CLI's --preview mode
// uses it so a preview records nothing and never execs the agent.
func Prepare(ctx context.Context, db *storage.DB, opts Options) (*Result, error) {
	tgt, err := resolveLaunchAdapter(opts.TargetAgent)
	if err != nil {
		return nil, err
	}

	cp := opts.Checkpoint
	if cp == nil {
		if opts.WorkstreamID == "" {
			return nil, fmt.Errorf("workstream id or explicit checkpoint is required")
		}
		if cp, err = latestCheckpoint(ctx, db, opts.WorkstreamID); err != nil {
			return nil, err
		}
	}
	wsID := opts.WorkstreamID
	if wsID == "" {
		wsID = cp.WorkstreamID
	}
	// Cross-check: an explicit checkpoint from a different workstream must
	// never be silently re-labeled under this workstream's handoff.
	if opts.WorkstreamID != "" && cp.WorkstreamID != "" && opts.WorkstreamID != cp.WorkstreamID {
		return nil, fmt.Errorf("continue: checkpoint %s belongs to workstream %s, not %s",
			cp.CheckpointID, cp.WorkstreamID, opts.WorkstreamID)
	}

	// Current repository state for drift detection. When it cannot be
	// captured the drift report stays zero (Clean=false, unverifiable)
	// rather than guessing — no repository-match points are ever awarded
	// on unverified state.
	var drift DriftReport
	repo := opts.Repo
	if repo == nil {
		if r, rerr := repository.State(ctx, "."); rerr == nil {
			repo = r
		}
	}
	if repo != nil {
		drift = DetectDrift(cp, *repo)
	}

	srcProvider, nativeID := sourceSession(cp)
	var (
		spec adapter.ExecSpec
		mode string
	)
	if srcProvider != "" && srcProvider == opts.TargetAgent && nativeID != "" {
		mode = ModeNativeResume
		spec, err = tgt.Resume(ctx, adapter.SessionRef{Provider: srcProvider, NativeID: nativeID})
	} else {
		mode = ModeCheckpointSeed
		spec, err = tgt.StartFromCheckpoint(ctx, cp)
	}
	if err != nil {
		if isUnsupported(err) {
			return nil, fmt.Errorf("continue: %s does not support %s launches yet: %w", opts.TargetAgent, mode, err)
		}
		return nil, fmt.Errorf("continue: %s launch: %w", opts.TargetAgent, err)
	}

	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return &Result{
		Handoff: &HandoffRecord{
			ID:               ids.NewPrefixed(PrefixHandoff),
			WorkstreamID:     wsID,
			SourceCheckpoint: cp.CheckpointID,
			SourceProvider:   srcProvider,
			TargetAgent:      opts.TargetAgent,
			Mode:             mode,
			Status:           StatusCreated,
			CreatedAt:        now,
		},
		Checkpoint: cp,
		Spec:       spec,
		Prompt:     RenderForAgent(cp, opts.TargetAgent),
		Drift:      drift,
	}, nil
}

// Continue prepares the continuation and records it: the handoff record is
// stored durably as an append-only handoff.created event in the storage DB
// (id, source checkpoint, target agent, status, created_at, mode, spec,
// drift, prompt digest). Continue never execs the target agent — launching
// stays with the caller.
func Continue(ctx context.Context, db *storage.DB, opts Options) (*Result, error) {
	res, err := Prepare(ctx, db, opts)
	if err != nil {
		return nil, err
	}

	spec := res.Spec
	drift := res.Drift
	payload, err := json.Marshal(createdPayload{
		HandoffRecord: *res.Handoff,
		Spec:          &spec,
		Drift:         &drift,
		PromptChars:   len(res.Prompt),
		PromptHash:    content.HashBytes([]byte(res.Prompt)),
	})
	if err != nil {
		return nil, fmt.Errorf("continue: encode handoff record: %w", err)
	}

	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    res.Handoff.CreatedAt,
		ObservedAt:    res.Handoff.CreatedAt,
		WorkstreamID:  res.Handoff.WorkstreamID,
		Provider:      res.Handoff.TargetAgent,
		Kind:          protocol.EventHandoffCreated,
		Provenance:    protocol.ProvenanceDeclared,
		Payload:       payload,
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return nil, fmt.Errorf("continue: record handoff: %w", err)
	}
	return res, nil
}

// isUnsupported reports whether err marks a capability the adapter
// honestly declined. The shared adapter.ErrUnsupported is the contract
// sentinel; the claude and pi adapters additionally declare their own
// package-local sentinels, so all three are matched here.
func isUnsupported(err error) bool {
	return errors.Is(err, adapter.ErrUnsupported) ||
		errors.Is(err, claude.ErrUnsupported) ||
		errors.Is(err, pi.ErrUnsupported)
}

// latestCheckpoint returns the newest stored checkpoint for the workstream.
func latestCheckpoint(ctx context.Context, db *storage.DB, workstreamID string) (*protocol.Checkpoint, error) {
	cps, err := db.ListCheckpoints(ctx, workstreamID)
	if err != nil {
		return nil, err
	}
	if len(cps) == 0 {
		return nil, fmt.Errorf("no checkpoints found for workstream %s (build one with `checkpoint --workstream %s` first)", workstreamID, workstreamID)
	}
	return cps[len(cps)-1], nil
}

// sourceSession picks the source native session to resume: the session with
// the lexicographically greatest session key that carries a native session
// id (deterministic regardless of slice order). It returns empty strings
// when no resumable native session exists.
func sourceSession(cp *protocol.Checkpoint) (provider, nativeID string) {
	best := -1
	var bestKey string
	for i, s := range cp.SourceSessions {
		if s.NativeSessionID == "" {
			continue
		}
		key := s.SessionID
		if key == "" {
			key = s.NativeSessionID
		}
		if best == -1 || key > bestKey {
			best, bestKey = i, key
		}
	}
	if best == -1 {
		return "", ""
	}
	return cp.SourceSessions[best].Provider, cp.SourceSessions[best].NativeSessionID
}

// ListHandoffs derives the handoff read model from the event log: each
// handoff.created event carrying a launch handoff record becomes a record,
// and matching handoff.accepted events fold in the acknowledgement
// (status, accepted-at, accepted/missing/unverifiable lists; later
// accepts win). The fold is two-pass so out-of-order delivery — a core
// property of the event store — cannot lose an acknowledgement. Records
// are ordered by creation time, then id — sorted before emitting, never
// map-ordered. handoff.created events emitted by other surfaces (e.g. the
// MCP server) use a different payload shape without a handoff id and are
// skipped.
func ListHandoffs(ctx context.Context, db *storage.DB) ([]*HandoffRecord, error) {
	events, err := db.ListEvents(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]*HandoffRecord{}
	var accepts []acceptedPayload
	for _, ev := range events {
		switch ev.Kind {
		case protocol.EventHandoffCreated:
			var p createdPayload
			if err := json.Unmarshal(ev.Payload, &p); err != nil || p.ID == "" {
				continue
			}
			rec := p.HandoffRecord
			rec.Status = StatusCreated
			byID[p.ID] = &rec
		case protocol.EventHandoffAccepted:
			var p acceptedPayload
			if err := json.Unmarshal(ev.Payload, &p); err != nil || p.HandoffID == "" {
				continue
			}
			accepts = append(accepts, p)
		}
	}
	for _, p := range accepts {
		rec, ok := byID[p.HandoffID]
		if !ok {
			continue
		}
		rec.Status = StatusAccepted
		rec.AcceptedAt = p.AcceptedAt
		rec.Accepted = p.Accepted
		rec.Missing = p.Missing
		rec.Unverifiable = p.Unverifiable
	}
	out := make([]*HandoffRecord, 0, len(byID))
	for _, r := range byID {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// sortedUnique returns a sorted, de-duplicated copy of in so emitted event
// payloads stay deterministic regardless of caller input order.
func sortedUnique(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
