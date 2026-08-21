// Package graph defines the workstream graph model: nodes, edges, and the
// deterministic reducer that derives them from the append-only event log.
//
// The event log is the source of truth. Rebuilding the graph from events
// must always produce an identical result, verified by a stable root hash.
package graph

import (
	"encoding/json"
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// NodeKind enumerates graph node types.
type NodeKind string

const (
	NodeWorkstream NodeKind = "Workstream"
	NodeSession    NodeKind = "Session"
	NodeTurnTrace  NodeKind = "TurnTrace"
	NodeSpan       NodeKind = "Span"
	NodeLogRecord  NodeKind = "LogRecord"
	NodeAgent      NodeKind = "Agent"
	NodeModel      NodeKind = "Model"
	NodePrompt     NodeKind = "Prompt"
	NodeToolCall   NodeKind = "ToolCall"
	NodeFile       NodeKind = "File"
	NodeDiff       NodeKind = "Diff"
	NodeCommit     NodeKind = "Commit"
	NodeBranch     NodeKind = "Branch"
	NodeCommand    NodeKind = "Command"
	NodeTest       NodeKind = "Test"
	NodeDecision   NodeKind = "Decision"
	NodeError      NodeKind = "Error"
	NodeCheckpoint NodeKind = "Checkpoint"
	NodeUser       NodeKind = "User"
)

// Relation enumerates graph edge relations.
type Relation string

const (
	RelBelongsTo    Relation = "BELONGS_TO"
	RelCaused       Relation = "CAUSED"
	RelRead         Relation = "READ"
	RelModified     Relation = "MODIFIED"
	RelProduced     Relation = "PRODUCED"
	RelVerifiedBy   Relation = "VERIFIED_BY"
	RelFailedWith   Relation = "FAILED_WITH"
	RelSupersedes   Relation = "SUPERSEDES"
	RelContinuedAs  Relation = "CONTINUED_AS"
	RelBranchedFrom Relation = "BRANCHED_FROM"
	RelBlockedBy    Relation = "BLOCKED_BY"
	RelTouched      Relation = "TOUCHED"
	RelBasedOn      Relation = "BASED_ON"
	RelContradicts  Relation = "CONTRADICTS"
	RelAcceptedBy   Relation = "ACCEPTED_BY"
)

// Node is a graph node.
type Node struct {
	ID    string          `json:"id"`
	Kind  NodeKind        `json:"kind"`
	Label string          `json:"label"`
	Attrs json.RawMessage `json:"attrs,omitempty"`
}

// Edge is a directed graph edge.
type Edge struct {
	Source   string   `json:"source"`
	Relation Relation `json:"relation"`
	Target   string   `json:"target"`
}

// Graph is the derived workstream graph.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// New returns an empty graph.
func New() *Graph { return &Graph{} }

// AddNode inserts a node if not already present.
func (g *Graph) AddNode(n Node) {
	for _, existing := range g.Nodes {
		if existing.ID == n.ID {
			return
		}
	}
	g.Nodes = append(g.Nodes, n)
}

// AddEdge inserts an edge if not already present.
func (g *Graph) AddEdge(e Edge) {
	for _, existing := range g.Edges {
		if existing == e {
			return
		}
	}
	g.Edges = append(g.Edges, e)
}

// Normalize sorts nodes and edges into a deterministic order.
func (g *Graph) Normalize() {
	sort.Slice(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	sort.Slice(g.Edges, func(i, j int) bool {
		a, b := g.Edges[i], g.Edges[j]
		if a.Source != b.Source {
			return a.Source < b.Source
		}
		if a.Relation != b.Relation {
			return a.Relation < b.Relation
		}
		return a.Target < b.Target
	})
}

// payloadID extracts a string field from an event payload, if present.
func payloadID(ev *protocol.Event, key string) string {
	if len(ev.Payload) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func or(a, b string) string {
	if a == "" {
		return b
	}
	return a
}

// nodeFor maps an event to zero or more nodes.
func nodeFor(ev *protocol.Event) []Node {
	switch ev.Kind {
	case protocol.EventWorkstreamStarted:
		return []Node{{ID: ev.WorkstreamID, Kind: NodeWorkstream, Label: ev.WorkstreamID}}
	case protocol.EventSessionStarted, protocol.EventSessionResumed:
		return []Node{{ID: ev.SessionID, Kind: NodeSession, Label: ev.NativeSessionID}}
	case protocol.EventTraceStarted:
		return []Node{{ID: or(payloadID(ev, "trace_id"), ev.SessionID), Kind: NodeTurnTrace, Label: ev.SessionID}}
	case protocol.EventSpanStarted:
		return []Node{{ID: or(payloadID(ev, "span_id"), ev.EventID), Kind: NodeSpan, Label: ev.EventID}}
	case protocol.EventDecisionRecorded:
		return []Node{{ID: ev.EventID, Kind: NodeDecision, Label: "decision"}}
	case protocol.EventErrorObserved:
		return []Node{{ID: ev.EventID, Kind: NodeError, Label: "error"}}
	case protocol.EventCheckpointCreated:
		return []Node{{ID: or(payloadID(ev, "checkpoint_id"), ev.EventID), Kind: NodeCheckpoint, Label: "checkpoint"}}
	case protocol.EventCommandStarted, protocol.EventCommandCompleted:
		return []Node{{ID: ev.EventID, Kind: NodeCommand, Label: ev.EventID}}
	case protocol.EventTestStarted, protocol.EventTestCompleted:
		return []Node{{ID: ev.EventID, Kind: NodeTest, Label: ev.EventID}}
	}
	return nil
}
