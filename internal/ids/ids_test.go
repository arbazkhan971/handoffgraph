package ids

import (
	"strings"
	"testing"
)

func TestNewPrefixed(t *testing.T) {
	id := Event()
	if len(id) == 0 {
		t.Fatal("empty id")
	}
	if id[:4] != PrefixEvent {
		t.Fatalf("event id missing prefix: %q", id)
	}
	if !IsValid(id) {
		t.Fatalf("id not valid: %q", id)
	}
}

func TestUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 10000; i++ {
		id := New()
		if seen[id] {
			t.Fatalf("duplicate id: %s", id)
		}
		seen[id] = true
	}
}

func TestSequentialIDsAreLexicographicallyIncreasing(t *testing.T) {
	previous := New()
	for i := 0; i < 10000; i++ {
		current := New()
		if strings.Compare(current, previous) <= 0 {
			t.Fatalf("id %d = %s sorts before previous %s", i, current, previous)
		}
		previous = current
	}
}

func TestIsValid(t *testing.T) {
	cases := []struct {
		id    string
		valid bool
	}{
		{Event(), true},
		{Workstream(), true},
		{Session(), true},
		{Trace(), true},
		{Span(), true},
		{Checkpoint(), true},
		{Repository(), true},
		{Handoff(), true},
		{"", false},
		{"evt_zzz", false},
		{"evt_00000000000000000000000000", true}, // 26 zeros is a valid ULID
	}
	for _, c := range cases {
		if got := IsValid(c.id); got != c.valid {
			t.Errorf("IsValid(%q) = %v, want %v", c.id, got, c.valid)
		}
	}
}

func TestHandoff(t *testing.T) {
	id := Handoff()
	if !strings.HasPrefix(id, PrefixHandoff) {
		t.Fatalf("Handoff() = %q, want %q prefix", id, PrefixHandoff)
	}
	if err := Validate(id); err != nil {
		t.Fatalf("Validate(Handoff()) = %v", err)
	}
}
