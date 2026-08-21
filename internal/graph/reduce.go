package graph

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Reduce derives a deterministic graph from the append-only event log.
// Events must be sorted by occurred_at; the caller is responsible for
// ordering (the store lists events in that order).
func Reduce(events []*protocol.Event) *Graph {
	g := New()

	for _, ev := range events {
		// Link each event to its workstream/session context.
		if ev.WorkstreamID != "" {
			g.AddNode(Node{ID: ev.WorkstreamID, Kind: NodeWorkstream, Label: ev.WorkstreamID})
		}
		if ev.SessionID != "" {
			g.AddNode(Node{ID: ev.SessionID, Kind: NodeSession, Label: ev.NativeSessionID})
		}

		nodes := nodeFor(ev)
		for _, n := range nodes {
			g.AddNode(n)
			// Attach to session/workstream.
			if ev.SessionID != "" && n.Kind != NodeSession && n.Kind != NodeWorkstream {
				g.AddEdge(Edge{Source: n.ID, Relation: RelBelongsTo, Target: ev.SessionID})
			}
			if ev.WorkstreamID != "" && n.Kind != NodeWorkstream {
				g.AddEdge(Edge{Source: n.ID, Relation: RelBelongsTo, Target: ev.WorkstreamID})
			}
			// Parent/child links.
			for _, parent := range ev.ParentEventIDs {
				g.AddEdge(Edge{Source: n.ID, Relation: RelCaused, Target: parent})
			}
		}

		// Decisions produce evidence edges to their referenced events.
		if ev.Kind == protocol.EventDecisionRecorded {
			for _, ref := range payloadStringSlice(ev, "evidence_refs") {
				g.AddEdge(Edge{Source: ev.EventID, Relation: RelBasedOn, Target: ref})
			}
		}
	}

	g.Normalize()
	return g
}

// RootHash computes a stable integrity hash of the normalized graph.
func RootHash(g *Graph) (string, error) {
	g.Normalize()
	return content.Hash(struct {
		Nodes []Node `json:"nodes"`
		Edges []Edge `json:"edges"`
	}{g.Nodes, g.Edges})
}

// RootHashForEvents reduces and hashes in one step.
func RootHashForEvents(events []*protocol.Event) (string, error) {
	return RootHash(Reduce(events))
}

// ToJSON serializes the graph deterministically.
func (g *Graph) ToJSON() ([]byte, error) {
	g.Normalize()
	return content.CanonicalJSON(struct {
		Nodes []Node `json:"nodes"`
		Edges []Edge `json:"edges"`
	}{g.Nodes, g.Edges})
}

// MarshalJSON ensures Normalize runs before encoding.
func (g *Graph) MarshalJSON() ([]byte, error) { return g.ToJSON() }

func payloadStringSlice(ev *protocol.Event, key string) []string {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	raw, ok := m[key]
	if !ok {
		return nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, it := range items {
		if s, ok := it.(string); ok {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// Validate ensures the graph is internally consistent enough to hash.
func (g *Graph) Validate() error {
	seen := map[string]bool{}
	for _, n := range g.Nodes {
		if n.ID == "" {
			return fmt.Errorf("graph node with empty id")
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate graph node %q", n.ID)
		}
		seen[n.ID] = true
	}
	for _, e := range g.Edges {
		if !seen[e.Source] || !seen[e.Target] {
			return fmt.Errorf("edge %s -[%s]-> %s references missing node", e.Source, e.Relation, e.Target)
		}
	}
	return nil
}
