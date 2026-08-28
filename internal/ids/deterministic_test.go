package ids

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
)

// deterministicTestMS is a timestamp comfortably inside the ULID range
// (ULIDs top out far beyond any plausible wall clock in milliseconds).
var deterministicTestMS = uint64(time.Date(2026, 8, 21, 15, 0, 0, 0, time.UTC).UnixMilli())

// deterministicULID parses the ULID carried by an "evt_<ulid>" identifier,
// failing the test unless id is well formed.
func deterministicULID(t *testing.T, id string) ulid.ULID {
	t.Helper()
	if !strings.HasPrefix(id, PrefixEvent) {
		t.Fatalf("id %q missing %q prefix", id, PrefixEvent)
	}
	u, err := ulid.Parse(strings.TrimPrefix(id, PrefixEvent))
	if err != nil {
		t.Fatalf("ulid.Parse(%q) error = %v", id, err)
	}
	return u
}

func TestEventDeterministicStable(t *testing.T) {
	key := "codex|sess1|1|1767298800000|hash"
	first := EventDeterministic(key, deterministicTestMS)
	second := EventDeterministic(key, deterministicTestMS)

	if first == "" || second == "" {
		t.Fatalf("EventDeterministic returned empty id: %q / %q", first, second)
	}
	if first != second {
		t.Errorf("same inputs produced different IDs: %q vs %q", first, second)
	}
	if !strings.HasPrefix(first, PrefixEvent) {
		t.Errorf("id = %q, want %q prefix", first, PrefixEvent)
	}

	parsed := deterministicULID(t, first)
	if got := parsed.Time(); got != deterministicTestMS {
		t.Errorf("ULID timestamp = %d, want requested ms %d", got, deterministicTestMS)
	}
}

func TestEventDeterministicDistinct(t *testing.T) {
	ms := deterministicTestMS

	diffKey := EventDeterministic("codex|sess2|1|x|hash", ms)
	sameKey := EventDeterministic("codex|sess1|1|x|hash", ms)
	if diffKey == sameKey {
		t.Errorf("different keys collided: %q", sameKey)
	}

	diffMS := EventDeterministic("codex|sess1|1|x|hash", ms+1)
	if diffMS == sameKey {
		t.Errorf("different timestamps collided: %q", sameKey)
	}

	seen := make(map[string]bool, 500)
	for seq := 0; seq < 500; seq++ {
		key := fmt.Sprintf("codex|sess1|%d|%d|hash", seq, ms)
		id := EventDeterministic(key, ms)
		if seen[id] {
			t.Fatalf("duplicate ID %q at seq %d", id, seq)
		}
		seen[id] = true
	}
	if len(seen) != 500 {
		t.Errorf("unique IDs = %d, want 500", len(seen))
	}
}

func TestEventDeterministicClamp(t *testing.T) {
	cases := []struct {
		name string
		ms   uint64
		want uint64 // expected parsed ULID timestamp after clamping
	}{
		{"zero", 0, 0},
		{"ULID max", ulid.MaxTime(), ulid.MaxTime()},
		{"just past ULID max", ulid.MaxTime() + 1, 0}, // clamps to epoch
		{"max uint64", ^uint64(0), 0},                 // clamps to epoch
	}
	for _, tc := range cases {
		a := EventDeterministic("clamp-key", tc.ms)
		b := EventDeterministic("clamp-key", tc.ms)
		if a != b {
			t.Errorf("%s: unstable output %q vs %q", tc.name, a, b)
		}
		if !strings.HasPrefix(a, PrefixEvent) {
			t.Errorf("%s: id = %q, want %q prefix", tc.name, a, PrefixEvent)
		}
		// Parsing proves no panic and a valid ULID came back.
		parsed := deterministicULID(t, a)
		if got := parsed.Time(); got != tc.want {
			t.Errorf("%s: ULID timestamp = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestEventDeterministicEntropyDerivedFromKey(t *testing.T) {
	ms := deterministicTestMS

	base := deterministicULID(t, EventDeterministic("codex|sess1|x|hash", ms))
	again := deterministicULID(t, EventDeterministic("codex|sess1|x|hash", ms))
	if !bytes.Equal(base.Entropy(), again.Entropy()) {
		t.Errorf("same key produced different entropy: %x vs %x", base.Entropy(), again.Entropy())
	}
	if len(base.Entropy()) != 10 {
		t.Errorf("entropy length = %d, want 10 (80 bits)", len(base.Entropy()))
	}

	mutated := deterministicULID(t, EventDeterministic("codex|sess2|x|hash", ms))
	if bytes.Equal(mutated.Entropy(), base.Entropy()) {
		t.Errorf("key differing in one character kept entropy %x", base.Entropy())
	}
}

func TestEventDeterministicEmptyKey(t *testing.T) {
	id := EventDeterministic("", deterministicTestMS)
	if id == "" {
		t.Fatal("empty key produced empty id")
	}
	if !strings.HasPrefix(id, PrefixEvent) {
		t.Errorf("id = %q, want %q prefix", id, PrefixEvent)
	}
	deterministicULID(t, id)
}

// TestDeterministicPrefixGuard pins the prefix contract: known prefixes pass
// through, unknown prefixes fall back to evt_ so an identifier is never
// emitted without a known shape, and derivation stays content-sensitive
// across prefixes (session and event ids for the same key differ).
func TestDeterministicPrefixGuard(t *testing.T) {
	got := Deterministic(PrefixSession, "otlp|agent-77", 1000)
	if !strings.HasPrefix(got, PrefixSession) {
		t.Fatalf("session derivation = %q", got)
	}
	if again := Deterministic(PrefixSession, "otlp|agent-77", 1000); again != got {
		t.Fatalf("derivation not stable: %q vs %q", got, again)
	}
	if other := Deterministic(PrefixSession, "otlp|agent-77", 1001); other == got {
		t.Fatal("timestamp must participate in derivation")
	}
	if fallback := Deterministic("bogus_", "k", 1000); !strings.HasPrefix(fallback, PrefixEvent) {
		t.Fatalf("unknown prefix = %q, want evt_ fallback", fallback)
	}
	if evt := EventDeterministic("k", 1000); evt != Deterministic(PrefixEvent, "k", 1000) {
		t.Fatal("EventDeterministic and Deterministic(evt) must agree")
	}
}
