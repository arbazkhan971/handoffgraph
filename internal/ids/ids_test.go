package ids

import (
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
