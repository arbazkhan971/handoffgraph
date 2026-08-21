package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// fixturePath resolves a golden fixture under the repo-root testdata/fixtures
// directory relative to this test file's own location, so the tests run
// correctly from any working directory. Missing fixtures are sibling-owned;
// skip rather than fail when one is absent.
func fixturePath(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate testdata/fixtures")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "testdata", "fixtures", name)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("fixture %s unavailable: %v", name, err)
	}
	return path
}

// normalizeFixtureFile normalizes one rollout fixture from disk, skipping the
// test if the fixture cannot be opened.
func normalizeFixtureFile(t *testing.T, path string) []protocol.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("fixture %s unavailable: %v", path, err)
	}
	defer f.Close()
	evs, err := (&Codex{}).Normalize(context.Background(), f)
	if err != nil {
		t.Fatalf("Normalize(%s) error = %v", path, err)
	}
	return evs
}

func TestNativeFixtureSession2Normalizes(t *testing.T) {
	evs := normalizeFixtureFile(t, fixturePath(t, "codex_session_2.jsonl"))

	if len(evs) < 7 {
		t.Fatalf("len(evs) = %d, want >= 7", len(evs))
	}

	first := evs[0]
	if first.Kind != protocol.EventSessionStarted {
		t.Errorf("ev[0].Kind = %q, want %q", first.Kind, protocol.EventSessionStarted)
	}
	if first.NativeSessionID != "5b2e9f60-ab12-4cd3-8ef4-90ab12cd34ef" {
		t.Errorf("ev[0].NativeSessionID = %q", first.NativeSessionID)
	}
	if first.Model != "gpt-5-codex" {
		t.Errorf("ev[0].Model = %q, want gpt-5-codex", first.Model)
	}

	wantKinds := []protocol.EventKind{
		protocol.EventSessionStarted,
		protocol.EventPromptSubmitted,
		protocol.EventToolStarted,
		protocol.EventToolCompleted,
		protocol.EventCommandCompleted,
		protocol.EventAssistantCompleted,
		protocol.EventLogObserved, // unknown compacted_summary line keeps its source kind
	}
	for i, want := range wantKinds {
		if evs[i].Kind != want {
			t.Errorf("ev[%d].Kind = %q, want %q", i, evs[i].Kind, want)
		}
	}

	// command.completed must carry the observed exit code in its payload.
	var cmd struct {
		Command  string `json:"command"`
		ExitCode *int64 `json:"exit_code"`
	}
	if err := json.Unmarshal(evs[4].Payload, &cmd); err != nil {
		t.Fatal(err)
	}
	if cmd.ExitCode == nil || *cmd.ExitCode != 0 {
		t.Errorf("command.completed exit_code = %v, want 0", cmd.ExitCode)
	}

	// The unrecognized compacted_summary line becomes log.observed with its
	// native source kind preserved.
	var logEv struct {
		SourceKind string `json:"source_kind"`
	}
	if err := json.Unmarshal(evs[6].Payload, &logEv); err != nil {
		t.Fatal(err)
	}
	if logEv.SourceKind != "compacted_summary" {
		t.Errorf("log.observed source_kind = %q, want compacted_summary", logEv.SourceKind)
	}

	// Unknown top-level native fields survive normalization untouched.
	raw, ok := evs[5].Unknown["turn_id"]
	if !ok {
		t.Fatalf(`agent_message event lost unknown top-level field "turn_id"`)
	}
	var turnID string
	if err := json.Unmarshal(raw, &turnID); err != nil {
		t.Fatalf("unmarshal turn_id: %v", err)
	}
	if turnID != "turn_02" {
		t.Errorf(`turn_id = %q, want "turn_02"`, turnID)
	}
}

func TestNativeFixtureBothSessionsDeterministic(t *testing.T) {
	fixtures := []string{"codex_session.jsonl", "codex_session_2.jsonl"}

	// EventID -> fixture that produced it, used to prove the two sessions'
	// ID sets stay disjoint (different native session ids -> different keys).
	owner := make(map[string]string)

	for _, name := range fixtures {
		path := fixturePath(t, name)
		first := normalizeFixtureFile(t, path)
		second := normalizeFixtureFile(t, path)
		if len(first) == 0 || len(first) != len(second) {
			t.Fatalf("%s: len(events) = %d vs %d across runs", name, len(first), len(second))
		}
		for i := range first {
			a, b := first[i].EventID, second[i].EventID
			if a == "" {
				t.Errorf("%s ev[%d]: empty EventID", name, i)
				continue
			}
			if a != b {
				t.Errorf("%s ev[%d]: EventID differs across runs: %q vs %q", name, i, a, b)
			}
			if prev, clash := owner[a]; clash && prev != name {
				t.Errorf("%s ev[%d]: EventID %q also produced by %s; distinct sessions must not share IDs", name, i, a, prev)
			} else {
				owner[a] = name
			}
		}
	}
}
