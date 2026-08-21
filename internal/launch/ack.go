package launch

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// acceptNow is the clock used by AcceptHandoff; a package-level variable
// so tests can pin it for deterministic event ordering.
var acceptNow = func() time.Time { return time.Now().UTC() }

// AcceptHandoff records the target agent's acknowledgement of a handoff by
// appending a handoff.accepted event to the storage DB. The three lists
// classify the checkpoint sections from the receiving agent's point of
// view:
//
//	accepted      — sections the agent confirmed it received and understood
//	missing       — sections the agent reports were absent or empty
//	unverifiable  — sections whose evidence the agent could not verify
//
// The lists are sorted and de-duplicated before emitting so the payload is
// deterministic. Accepting an unknown handoff fails closed: no event is
// written. The updated derived record (status accepted) is returned.
func AcceptHandoff(ctx context.Context, db *storage.DB, handoffID string, accepted, missing, unverifiable []string) (*HandoffRecord, error) {
	if handoffID == "" {
		return nil, fmt.Errorf("accept handoff: handoff id is required")
	}
	recs, err := ListHandoffs(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("accept handoff: %w", err)
	}
	var rec *HandoffRecord
	for _, r := range recs {
		if r.ID == handoffID {
			rec = r
			break
		}
	}
	if rec == nil {
		return nil, fmt.Errorf("accept handoff: no handoff %s (create one with `continue --to <agent> --workstream <id>`)", handoffID)
	}

	now := acceptNow()
	p := acceptedPayload{
		HandoffID:    handoffID,
		Agent:        rec.TargetAgent,
		AcceptedAt:   now,
		Accepted:     sortedUnique(accepted),
		Missing:      sortedUnique(missing),
		Unverifiable: sortedUnique(unverifiable),
	}
	payload, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("accept handoff: encode payload: %w", err)
	}

	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    now,
		ObservedAt:    now,
		WorkstreamID:  rec.WorkstreamID,
		Provider:      rec.TargetAgent,
		Kind:          protocol.EventHandoffAccepted,
		Provenance:    protocol.ProvenanceDeclared,
		Payload:       payload,
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return nil, fmt.Errorf("accept handoff: %w", err)
	}

	out := *rec
	out.Status = StatusAccepted
	out.AcceptedAt = now
	out.Accepted = p.Accepted
	out.Missing = p.Missing
	out.Unverifiable = p.Unverifiable
	return &out, nil
}
