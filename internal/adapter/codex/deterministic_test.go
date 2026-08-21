package codex

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// stableRolloutJSONL mirrors the native line shape of
// testdata/fixtures/codex_session.jsonl: a session_meta head followed by an
// event_msg user_message and a response_item function_call.
const stableRolloutJSONL = `{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"id":"sess1","model":"m"}}
{"timestamp":"2026-08-21T15:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"fix the flaky checkout test"}}
{"timestamp":"2026-08-21T15:00:10Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":{"command":["go","test","./..."]}}}
`

// deterministicTestMS is a timestamp comfortably inside the ULID range
// (ULIDs top out far beyond any plausible wall clock in milliseconds).
var deterministicTestMS = uint64(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC).UnixMilli())

// deterministicULID parses the ULID carried by an "evt_<ulid>" identifier,
// failing the test unless id is well formed.
func deterministicULID(t *testing.T, id string) ulid.ULID {
	t.Helper()
	if !strings.HasPrefix(id, ids.PrefixEvent) {
		t.Fatalf("id %q missing %q prefix", id, ids.PrefixEvent)
	}
	u, err := ulid.Parse(strings.TrimPrefix(id, ids.PrefixEvent))
	if err != nil {
		t.Fatalf("ulid.Parse(%q) error = %v", id, err)
	}
	return u
}

func TestEventDeterministicStable(t *testing.T) {
	key := "codex|sess1|1|1767273600000|hash"
	first := ids.EventDeterministic(key, deterministicTestMS)
	second := ids.EventDeterministic(key, deterministicTestMS)

	if first == "" || second == "" {
		t.Fatalf("EventDeterministic returned empty id: %q / %q", first, second)
	}
	if first != second {
		t.Errorf("same inputs produced different IDs: %q vs %q", first, second)
	}
	if !strings.HasPrefix(first, ids.PrefixEvent) {
		t.Errorf("id = %q, want %q prefix", first, ids.PrefixEvent)
	}

	parsed := deterministicULID(t, first)
	if got := parsed.Time(); got != deterministicTestMS {
		t.Errorf("ULID timestamp = %d, want requested ms %d", got, deterministicTestMS)
	}
}

func TestEventDeterministicDistinct(t *testing.T) {
	ms := deterministicTestMS

	diffKey := ids.EventDeterministic("codex|sess2|1|x|hash", ms)
	sameKey := ids.EventDeterministic("codex|sess1|1|x|hash", ms)
	if diffKey == sameKey {
		t.Errorf("different keys collided: %q", sameKey)
	}

	diffMS := ids.EventDeterministic("codex|sess1|1|x|hash", ms+1)
	if diffMS == sameKey {
		t.Errorf("different timestamps collided: %q", sameKey)
	}

	seen := make(map[string]bool, 200)
	for seq := 0; seq < 200; seq++ {
		key := fmt.Sprintf("codex|sess1|%d|%d|hash", seq, ms)
		id := ids.EventDeterministic(key, ms)
		if seen[id] {
			t.Fatalf("duplicate ID %q at seq %d", id, seq)
		}
		seen[id] = true
	}
}

func TestEventDeterministicClampsBadTimestamp(t *testing.T) {
	cases := []struct {
		name string
		ms   uint64
	}{
		{"zero", 0},
		{"just past ULID max", ulid.MaxTime() + 1},
		{"max uint64", ^uint64(0)},
	}
	for _, tc := range cases {
		a := ids.EventDeterministic("clamp-key", tc.ms)
		b := ids.EventDeterministic("clamp-key", tc.ms)
		if a != b {
			t.Errorf("%s: unstable output %q vs %q", tc.name, a, b)
		}
		if !strings.HasPrefix(a, ids.PrefixEvent) {
			t.Errorf("%s: id = %q, want %q prefix", tc.name, a, ids.PrefixEvent)
		}
		// Parsing proves no panic and a valid ULID came back.
		parsed := deterministicULID(t, a)
		want := tc.ms
		if tc.ms > ulid.MaxTime() {
			want = 0 // out-of-range timestamps clamp to the epoch
		}
		if got := parsed.Time(); got != want {
			t.Errorf("%s: ULID timestamp = %d, want %d", tc.name, got, want)
		}
	}
}

func TestDeriveEventIDDeterministic(t *testing.T) {
	const (
		sess = "sess1"
		hash = "deadbeef"
	)
	var (
		seq = int64(7)
		at  = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	)

	base := deriveEventID(sess, seq, at, hash)
	if base == "" {
		t.Fatal("deriveEventID returned empty id")
	}
	if again := deriveEventID(sess, seq, at, hash); again != base {
		t.Errorf("identical args produced %q then %q", base, again)
	}
	if !strings.HasPrefix(base, ids.PrefixEvent) {
		t.Errorf("id = %q, want %q prefix", base, ids.PrefixEvent)
	}

	mutations := []struct {
		name string
		sess string
		seq  int64
		at   time.Time
		hash string
	}{
		{"session id", "sess2", seq, at, hash},
		{"seq", sess, seq + 1, at, hash},
		{"occurredAt", sess, seq, at.Add(time.Second), hash},
		{"contentHash", sess, seq, at, "feedface"},
	}
	for _, m := range mutations {
		got := deriveEventID(m.sess, m.seq, m.at, m.hash)
		if got == base {
			t.Errorf("%s changed but event ID stayed %q", m.name, base)
		}
	}

	// Pre-epoch times clamp instead of panicking or going negative.
	preEpoch := time.Unix(-1, 0).UTC()
	a := deriveEventID(sess, seq, preEpoch, hash)
	b := deriveEventID(sess, seq, preEpoch, hash)
	if a == "" || a != b {
		t.Errorf("pre-epoch time unstable or empty: %q / %q", a, b)
	}
	if !strings.HasPrefix(a, ids.PrefixEvent) {
		t.Errorf("pre-epoch id = %q, want %q prefix", a, ids.PrefixEvent)
	}
	deterministicULID(t, a)

	// Far-future times must neither panic nor produce unparseable IDs.
	// Year 2300 is still INSIDE the ULID range (ulid.MaxTime() ≈ year
	// 10889), so the ID carries that exact millisecond; year 11000 exceeds
	// MaxTime and must come back clamped (internal/ids.EventDeterministic
	// folds out-of-range timestamps onto the epoch).
	futures := []struct {
		name  string
		at    time.Time
		clamp bool
	}{
		{"year 2300", time.Date(2300, 1, 1, 0, 0, 0, 0, time.UTC), false},
		{"past ULID MaxTime", time.Date(11000, 1, 1, 0, 0, 0, 0, time.UTC), true},
	}
	for _, f := range futures {
		fa := deriveEventID(sess, seq, f.at, hash)
		fb := deriveEventID(sess, seq, f.at, hash)
		if fa == "" || fa != fb {
			t.Errorf("%s: unstable or empty id: %q / %q", f.name, fa, fb)
			continue
		}
		parsed := deterministicULID(t, fa) // parse proves validity, no panic
		want := uint64(f.at.UnixMilli())
		if f.clamp {
			want = 0
		}
		if got := parsed.Time(); got != want {
			t.Errorf("%s: ULID timestamp = %d, want %d", f.name, got, want)
		}
	}
}

func TestNormalizeStableIDs(t *testing.T) {
	run := func() []protocol.Event {
		evs, err := (&Codex{}).Normalize(context.Background(), strings.NewReader(stableRolloutJSONL))
		if err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		return evs
	}

	a := run()
	if len(a) == 0 {
		t.Fatal("Normalize emitted no events")
	}
	b := run()
	if len(b) != len(a) {
		t.Fatalf("len(events) differs across runs: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].EventID == "" {
			t.Errorf("ev[%d].EventID empty", i)
			continue
		}
		if a[i].EventID != b[i].EventID {
			t.Errorf("ev[%d].EventID differs across runs: %q vs %q", i, a[i].EventID, b[i].EventID)
		}
		for j := 0; j < i; j++ {
			if a[i].EventID == a[j].EventID {
				t.Errorf("lines %d and %d share EventID %q", j, i, a[i].EventID)
			}
		}
	}
}

func TestNormalizeImportIdempotent(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(filepath.Join(t.TempDir(), "hfg.db"))
	if err != nil {
		t.Fatalf("storage.Open() error = %v", err)
	}
	defer db.Close()

	importRun := func(label string) []protocol.Event {
		t.Helper()
		evs, err := (&Codex{}).Normalize(ctx, strings.NewReader(stableRolloutJSONL))
		if err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		if len(evs) == 0 {
			t.Fatalf("%s: Normalize emitted no events", label)
		}
		for i := range evs {
			inserted, err := db.AppendEvent(ctx, &evs[i])
			if err != nil {
				t.Fatalf("%s: AppendEvent(ev[%d] %q) error = %v", label, i, evs[i].EventID, err)
			}
			switch label {
			case "first":
				if !inserted {
					t.Errorf("first run: ev[%d] (%q) was not inserted", i, evs[i].EventID)
				}
			case "second":
				if inserted {
					t.Errorf("second run: ev[%d] (%q) was inserted again; event_id dedupe failed", i, evs[i].EventID)
				}
			}
		}
		return evs
	}

	first := importRun("first")
	importRun("second")

	n, err := db.EventCount(ctx)
	if err != nil {
		t.Fatalf("EventCount() error = %v", err)
	}
	if n != int64(len(first)) {
		t.Errorf("EventCount = %d, want %d (one row per distinct event)", n, len(first))
	}
}

// degenerateRolloutJSONL exercises timestamp edge cases: a session_meta line
// with NO timestamp field at all, a session_meta with a valid one, and an
// event_msg stamped with the largest instant RFC3339 can represent.
const degenerateRolloutJSONL = `{"type":"session_meta","payload":{"id":"degsess","model":"m"}}
{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"id":"degsess2","model":"m"}}
{"timestamp":"9999-12-31T23:59:59Z","type":"event_msg","payload":{"type":"user_message","message":"far future"}}
`

func TestNormalizeDegenerateTimestamps(t *testing.T) {
	// The task brief suggested "2200-01-01T00:00:00Z" as beyond-ULID-max,
	// but ulid.MaxTime() is 281474976710655 ms ≈ year 10889, so even
	// "9999-12-31T23:59:59Z" — the largest instant RFC3339 can represent
	// (the year field is fixed at four digits; Go rejects five-digit years)
	// — stays INSIDE the ULID range at 253402300799000 ms. A beyond-max
	// timestamp is therefore unrepresentable in the rollout's RFC3339
	// timestamp field; the clamp path is covered directly by
	// TestEventDeterministicClampsBadTimestamp and by the year-11000 case in
	// TestDeriveEventIDDeterministic above.
	const maxRFC3339 = "9999-12-31T23:59:59Z"
	max, err := time.Parse(time.RFC3339, maxRFC3339)
	if err != nil {
		t.Fatalf("test bug: %s unparseable: %v", maxRFC3339, err)
	}
	if ms := uint64(max.UnixMilli()); ms >= ulid.MaxTime() {
		t.Fatalf("test bug: %s (%d ms) unexpectedly reaches MaxTime %d",
			maxRFC3339, ms, ulid.MaxTime())
	}

	run := func() []protocol.Event {
		t.Helper()
		evs, err := (&Codex{}).Normalize(context.Background(), strings.NewReader(degenerateRolloutJSONL))
		if err != nil {
			t.Fatalf("Normalize() error = %v", err)
		}
		return evs
	}

	first := run()
	if len(first) != 3 {
		t.Fatalf("len(events) = %d, want 3", len(first))
	}
	second := run()
	for i := range first {
		ev := &first[i]
		if ev.EventID == "" {
			t.Fatalf("ev[%d].EventID empty", i)
		}
		u := deterministicULID(t, ev.EventID) // evt_ prefix + parses as ULID
		if i < len(second) && ev.EventID != second[i].EventID {
			t.Errorf("ev[%d].EventID differs across runs: %q vs %q", i, ev.EventID, second[i].EventID)
		}
		// Timestampless lines normalize to the epoch; the ULID time must
		// match (clamp before the unsigned conversion: a zero time.Time has
		// a hugely negative UnixMilli).
		ms := ev.OccurredAt.UnixMilli()
		if ms < 0 {
			ms = 0
		}
		if u.Time() != uint64(ms) {
			t.Errorf("ev[%d]: ULID time = %d, want occurred-at ms %d", i, u.Time(), ms)
		}
	}
}

// TestNormalizeEmptyNativeSessionIDNoCollision is the regression test for the
// FIX-FIRST P3 finding: two DIFFERENT rollouts whose session_meta lacks
// payload.id used to derive identical event IDs (key "codex||<seq>|..."), so
// importing both silently dropped the second file's evidence. The fallback in
// buildEvent must mint unique random IDs for every line of an unidentifiable
// rollout instead.
func TestNormalizeEmptyNativeSessionIDNoCollision(t *testing.T) {
	const rolloutA = `{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"model":"m"}}
{"timestamp":"2026-08-21T15:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"same"}}
`
	const rolloutB = `{"timestamp":"2026-08-21T15:00:00Z","type":"session_meta","payload":{"model":"m"}}
{"timestamp":"2026-08-21T15:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"same"}}
`

	ctx := context.Background()
	a, err := (&Codex{}).Normalize(ctx, strings.NewReader(rolloutA))
	if err != nil {
		t.Fatalf("Normalize(rolloutA) error = %v", err)
	}
	b, err := (&Codex{}).Normalize(ctx, strings.NewReader(rolloutB))
	if err != nil {
		t.Fatalf("Normalize(rolloutB) error = %v", err)
	}
	if len(a) == 0 || len(a) != len(b) {
		t.Fatalf("len(events) = %d / %d, want equal and non-empty", len(a), len(b))
	}
	for i := range a {
		deterministicULID(t, a[i].EventID) // evt_ prefix + parses as ULID
		if a[i].EventID == b[i].EventID {
			t.Errorf("distinct id-less rollouts collided at line %d on %q", i, a[i].EventID)
		}
	}
}
