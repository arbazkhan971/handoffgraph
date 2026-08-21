package graph

import (
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
)

func TestReduceDeterministic(t *testing.T) {
	events := fixture.GenerateSynthetic(200)
	g1 := Reduce(events)
	g2 := Reduce(events)

	h1, err := RootHash(g1)
	if err != nil {
		t.Fatal(err)
	}
	h2, err := RootHash(g2)
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("reduce not deterministic: %s != %s", h1, h2)
	}
}

func TestReduceProducesNodesAndEdges(t *testing.T) {
	events := fixture.GenerateSynthetic(50)
	g := Reduce(events)

	if len(g.Nodes) == 0 {
		t.Fatal("expected nodes")
	}
	if len(g.Edges) == 0 {
		t.Fatal("expected edges")
	}
	if err := g.Validate(); err != nil {
		t.Fatalf("graph invalid: %v", err)
	}
}

func TestGraphMarshalStable(t *testing.T) {
	events := fixture.GenerateSynthetic(20)
	g := Reduce(events)
	b1, err := g.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	b2, err := g.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(b1) != string(b2) {
		t.Fatal("marshal not stable")
	}
}
