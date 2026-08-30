package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The tests in this file exercise `sessions --detect`: direct enumeration of
// native agent sessions from disk through the public cli.App surface, with
// HFG_CODEX_SESSIONS_DIR pointing the codex adapter at throwaway rollout
// directories. Per the pinned contract, --detect never reads config or the
// database, so these tests must not (and do not) isolate HFG_DATA_DIR except
// where they explicitly assert that the data directory is left untouched.
//
// Rollout fixtures mirror the head shape of
// testdata/fixtures/codex_session.jsonl: a single JSONL session_meta line
// carrying a top-level timestamp plus payload.id / payload.model.

// writeDetectRollout writes one fake codex rollout file whose session_meta
// head line declares the given native id, start time (RFC3339) and model,
// and returns the file's full path.
func writeDetectRollout(t *testing.T, dir, name, id, startedAt, model string) string {
	t.Helper()
	line := `{"timestamp":"` + startedAt + `","type":"session_meta","payload":{"id":"` + id + `","model":"` + model + `"}}`
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write rollout %s: %v", path, err)
	}
	return path
}

// seedDetectSessionsDir creates a fresh sessions directory holding two
// rollouts (sess_detect_a older, sess_detect_b newer) and returns the dir
// plus both file paths. Callers wire it up with
// t.Setenv("HFG_CODEX_SESSIONS_DIR", dir).
func seedDetectSessionsDir(t *testing.T) (dir, pathA, pathB string) {
	t.Helper()
	dir = t.TempDir()
	pathA = writeDetectRollout(t, dir, "rollout-detect-a.jsonl", "sess_detect_a", "2026-08-20T09:00:00Z", "m1")
	pathB = writeDetectRollout(t, dir, "rollout-detect-b.jsonl", "sess_detect_b", "2026-08-20T11:30:00Z", "m2")
	return dir, pathA, pathB
}

// detectRow mirrors one row of the --detect listing (same field names as
// the command's JSON output).
type detectRow struct {
	Agent           string `json:"agent"`
	NativeSessionID string `json:"native_session_id"`
	Path            string `json:"path"`
	StartedAt       string `json:"started_at"`
	EndedAt         string `json:"ended_at"`
	LastEventAt     string `json:"last_event_at"`
	Model           string `json:"model"`
}

func TestSessionsDetectText(t *testing.T) {
	dir, pathA, pathB := seedDetectSessionsDir(t)
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect", "--agent", "codex")
	if err != nil {
		t.Fatalf("sessions --detect: %v", err)
	}

	// Newest first: sess_detect_b (11:30) before sess_detect_a (09:00),
	// tab-separated as agent \t id \t path \t started \t last-event \t model.
	// Codex does not expose last-event time through file detection, so that
	// column is the explicit "-" placeholder.
	want := strings.Join([]string{
		"codex\tsess_detect_b\t" + pathB + "\t2026-08-20T11:30:00Z\t-\tm2",
		"codex\tsess_detect_a\t" + pathA + "\t2026-08-20T09:00:00Z\t-\tm1",
	}, "\n") + "\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
}

func TestSessionsDetectJSON(t *testing.T) {
	dir, pathA, pathB := seedDetectSessionsDir(t)
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect", "--json")
	if err != nil {
		t.Fatalf("sessions --detect --json: %v", err)
	}

	// Indented array: two-space indent, "agent" is the first key of each
	// element object (four spaces deep inside the array).
	if !strings.HasPrefix(out, "[\n") || !strings.Contains(out, "\n    \"agent\"") {
		t.Errorf("stdout is not an indented JSON array: %q", out)
	}

	var rows []detectRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if len(rows) != 2 {
		t.Fatalf("len(rows) = %d, want 2\n%s", len(rows), out)
	}

	// Newest first.
	want := []detectRow{
		{Agent: "codex", NativeSessionID: "sess_detect_b", Path: pathB,
			StartedAt: "2026-08-20T11:30:00Z", EndedAt: "", LastEventAt: "", Model: "m2"},
		{Agent: "codex", NativeSessionID: "sess_detect_a", Path: pathA,
			StartedAt: "2026-08-20T09:00:00Z", EndedAt: "", LastEventAt: "", Model: "m1"},
	}
	for i, w := range want {
		if got := rows[i]; got != w {
			t.Errorf("rows[%d] = %+v, want %+v", i, got, w)
		}
		if rows[i].StartedAt == "" {
			t.Errorf("rows[%d].started_at is empty, want an RFC3339 timestamp", i)
		} else if _, err := time.Parse(time.RFC3339, rows[i].StartedAt); err != nil {
			t.Errorf("rows[%d].started_at %q is not RFC3339: %v", i, rows[i].StartedAt, err)
		}
	}

	// Every contracted field must be present on each object (missing JSON
	// keys decode silently, so check the raw objects too).
	var raws []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &raws); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	for i, raw := range raws {
		for _, field := range []string{"agent", "native_session_id", "path", "started_at", "ended_at", "last_event_at", "model"} {
			if _, ok := raw[field]; !ok {
				t.Errorf("rows[%d] is missing JSON field %q", i, field)
			}
		}
	}
}

func TestSessionsDetectClaudeUsesProviderRootAndLastEventAt(t *testing.T) {
	home := t.TempDir()
	projects := filepath.Join(home, ".claude", "projects", "repo")
	if err := os.MkdirAll(projects, 0o700); err != nil {
		t.Fatal(err)
	}
	older := filepath.Join(projects, "claude-old.jsonl")
	newer := filepath.Join(projects, "claude-new.jsonl")
	for _, path := range []string{older, newer} {
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	oldTime := time.Date(2026, 8, 20, 9, 0, 0, 0, time.UTC)
	newTime := time.Date(2026, 8, 20, 11, 30, 0, 0, time.UTC)
	if err := os.Chtimes(older, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, newTime, newTime); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect", "--agent", "claude", "--json")
	if err != nil {
		t.Fatalf("sessions --detect --agent claude: %v", err)
	}
	var rows []detectRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows=%+v, want two provider-root transcripts", rows)
	}
	if rows[0].NativeSessionID != "claude-new" || rows[0].Path != newer || rows[0].LastEventAt != "2026-08-20T11:30:00Z" {
		t.Fatalf("newest claude row=%+v", rows[0])
	}
	if rows[0].StartedAt != "" {
		t.Fatalf("claude started_at fabricated: %+v", rows[0])
	}
}

func TestSessionsDetectPiUsesProviderRootAndLastEventAt(t *testing.T) {
	home := t.TempDir()
	sessions := filepath.Join(home, ".pi", "agent", "sessions")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, line := range map[string]string{
		"old.jsonl": `{"type":"session","id":"pi-old","timestamp":"2026-08-20T09:00:00Z"}`,
		"new.jsonl": `{"type":"session","id":"pi-new","timestamp":"2026-08-20T11:30:00Z"}`,
	} {
		if err := os.WriteFile(filepath.Join(sessions, name), []byte(line+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect", "--agent", "pi", "--json")
	if err != nil {
		t.Fatalf("sessions --detect --agent pi: %v", err)
	}
	var rows []detectRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].NativeSessionID != "pi-new" || rows[0].LastEventAt != "2026-08-20T11:30:00Z" {
		t.Fatalf("pi rows=%+v", rows)
	}
	if rows[0].StartedAt != "" {
		t.Fatalf("pi started_at fabricated: %+v", rows[0])
	}
}

func TestSessionsDetectEmpty(t *testing.T) {
	dir := t.TempDir() // exists, but holds no rollout files
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect")
	if err != nil {
		t.Fatalf("sessions --detect over an empty dir: %v", err)
	}
	if out != "" {
		t.Errorf("stdout = %q, want no output in text mode", out)
	}
}

func TestSessionsDetectJSONEmpty(t *testing.T) {
	dir := t.TempDir() // exists, but holds no rollout files
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect", "--json")
	if err != nil {
		t.Fatalf("sessions --detect --json over an empty dir: %v", err)
	}
	if trimmed := strings.TrimSpace(out); trimmed != "[]" {
		t.Errorf("stdout = %q, want []", trimmed)
	}
	var rows []detectRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if len(rows) != 0 {
		t.Errorf("len(rows) = %d, want 0", len(rows))
	}
}

func TestSessionsDetectNoEnv(t *testing.T) {
	// No override directory: point the default ~/.codex/sessions resolution
	// at a scratch home where nothing exists, so Detect reports
	// ErrNotDetected, which the command must turn into an empty listing —
	// not an error. An explicit empty override keeps the test immune to an
	// HFG_CODEX_SESSIONS_DIR leaked in from the surrounding environment.
	t.Setenv("HFG_CODEX_SESSIONS_DIR", "")
	t.Setenv("HOME", t.TempDir())
	app := newRegisteredApp(t)

	out, stderr, err := runRegisteredApp(app, "sessions", "--detect")
	if err != nil {
		t.Fatalf("sessions --detect without any sessions on disk: %v", err)
	}
	if out != "" {
		t.Errorf("stdout = %q, want no output", out)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want silent handling of ErrNotDetected", stderr)
	}
}

// TestSessionsDetectDoesNotTouchDataDir pins the isolation guarantee: with
// --detect set the command must not load config or open the database, so a
// nonexistent HFG_DATA_DIR stays nonexistent (config.Load would create it,
// and a DB open would drop a database file inside it).
func TestSessionsDetectDoesNotTouchDataDir(t *testing.T) {
	dir, pathA, _ := seedDetectSessionsDir(t)
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	dataDir := filepath.Join(t.TempDir(), "never-created")
	t.Setenv("HFG_DATA_DIR", dataDir)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--detect")
	if err != nil {
		t.Fatalf("sessions --detect: %v", err)
	}
	if !strings.Contains(out, "sess_detect_b") || !strings.Contains(out, pathA) {
		t.Errorf("stdout = %q, want the detected rows (missing sess_detect_b/%s)", out, pathA)
	}
	if _, err := os.Lstat(dataDir); !os.IsNotExist(err) {
		t.Errorf("HFG_DATA_DIR %s was touched by --detect (stat err = %v)", dataDir, err)
	}
}

func TestSessionsDetectWithoutFlagUnchanged(t *testing.T) {
	// Regression guard: seeding the database and omitting --detect must
	// still produce the DB-derived listing, untouched by the detect mode
	// sharing the command (and by any ambient HFG_CODEX_SESSIONS_DIR).
	seedSessions(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions")
	if err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if want := wantSessionsText(); out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
}
