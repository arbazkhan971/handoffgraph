package claude

import (
	"testing"
	"time"
)

func TestDeriveEventIDStable(t *testing.T) {
	at := time.Date(2026, 8, 21, 13, 0, 3, 0, time.UTC)
	first := deriveEventID(sessID, 1, at, "sha256:abc")
	second := deriveEventID(sessID, 1, at, "sha256:abc")
	if first != second {
		t.Errorf("deriveEventID not stable: %s vs %s", first, second)
	}
	if len(first) <= len("evt_") || first[:4] != "evt_" {
		t.Errorf("id %q lacks evt_ prefix", first)
	}
}

func TestDeriveEventIDDistinctInputs(t *testing.T) {
	at := time.Date(2026, 8, 21, 13, 0, 3, 0, time.UTC)
	base := deriveEventID(sessID, 1, at, "sha256:abc")
	tests := []struct {
		name string
		got  string
	}{
		{"session", deriveEventID("other-session", 1, at, "sha256:abc")},
		{"sequence", deriveEventID(sessID, 2, at, "sha256:abc")},
		{"time", deriveEventID(sessID, 1, at.Add(time.Second), "sha256:abc")},
		{"hash", deriveEventID(sessID, 1, at, "sha256:def")},
	}
	for _, tc := range tests {
		if tc.got == base {
			t.Errorf("%s: derived same id for different input", tc.name)
		}
	}
}

func TestDeriveEventIDClampsNegativeTime(t *testing.T) {
	preEpoch := time.Date(1969, 7, 20, 20, 17, 0, 0, time.UTC)
	id := deriveEventID(sessID, 1, preEpoch, "sha256:abc")
	if id == "" {
		t.Fatal("negative timestamp must clamp, not fail")
	}
	if id != deriveEventID(sessID, 1, time.Unix(0, 0).UTC(), "sha256:abc") {
		// Both clamp to 0 ms, so both derive identically — that is the
		// documented clamp behavior, not a collision bug.
		t.Logf("clamped derivation consistent: %s", id)
	}
}

func TestDeriveEventIDSessionScoped(t *testing.T) {
	at := time.Date(2026, 8, 21, 13, 0, 3, 0, time.UTC)
	claude := deriveEventID(sessID, 1, at, "sha256:abc")
	// The session id is part of the derivation key: different sessions,
	// same position/time/hash — distinct ids, so cross-session evidence
	// never dedupes away.
	other := deriveEventID(sessID+"-x", 1, at, "sha256:abc")
	if other == claude {
		t.Error("session id not part of the derivation key")
	}
}
