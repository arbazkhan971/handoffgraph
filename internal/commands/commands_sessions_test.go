package commands

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the sessions command through the public
// cli.App surface. State is seeded into the same database the command opens
// (config.Load(".") + storage.Open(cfg.DBPath) under HFG_DATA_DIR), so the
// user's real data directory is never touched.

// seedSessions writes two codex native sessions plus one claude event with
// an empty native session id (which must be excluded from the output).
func seedSessions(t *testing.T) {
	t.Helper()
	seedEvents(t, func(db *storage.DB) {
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_b", protocol.EventSessionStarted,
			time.Date(2026, 2, 10, 12, 0, 0, 0, time.UTC))
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_b", protocol.EventPromptSubmitted,
			time.Date(2026, 2, 10, 12, 5, 0, 0, time.UTC))
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_b", protocol.EventAssistantCompleted,
			time.Date(2026, 2, 10, 12, 9, 0, 0, time.UTC))
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_a", protocol.EventSessionStarted,
			time.Date(2026, 2, 11, 8, 30, 0, 0, time.UTC))
		appendSessionEvent(t, db, protocol.ProviderCodex, "sess_a", protocol.EventToolCompleted,
			time.Date(2026, 2, 11, 8, 45, 0, 0, time.UTC))
		// claude event with no native session id: excluded from grouping.
		appendSessionEvent(t, db, protocol.ProviderClaude, "", protocol.EventLogObserved,
			time.Date(2026, 2, 12, 10, 0, 0, 0, time.UTC))
	})
}

// wantSessionsText is the expected text output: distinct (provider,
// native_session_id) groups sorted by provider then id.
func wantSessionsText() string {
	return strings.Join([]string{
		"codex\tsess_a\t2\t2026-02-11T08:30:00Z\t2026-02-11T08:45:00Z",
		"codex\tsess_b\t3\t2026-02-10T12:00:00Z\t2026-02-10T12:09:00Z",
	}, "\n") + "\n"
}

type sessionRow struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"native_session_id"`
	Events          int    `json:"events"`
	FirstSeen       string `json:"first_seen"`
	LastSeen        string `json:"last_seen"`
}

func TestSessionsText(t *testing.T) {
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

func TestSessionsJSON(t *testing.T) {
	seedSessions(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--json")
	if err != nil {
		t.Fatalf("sessions --json: %v", err)
	}
	var rows []sessionRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if len(rows) != 2 {
		t.Fatalf("len(rows) = %d, want 2\n%s", len(rows), out)
	}
	want := []sessionRow{
		{Provider: "codex", NativeSessionID: "sess_a", Events: 2,
			FirstSeen: "2026-02-11T08:30:00Z", LastSeen: "2026-02-11T08:45:00Z"},
		{Provider: "codex", NativeSessionID: "sess_b", Events: 3,
			FirstSeen: "2026-02-10T12:00:00Z", LastSeen: "2026-02-10T12:09:00Z"},
	}
	for i, w := range want {
		got := rows[i]
		if got != w {
			t.Errorf("rows[%d] = %+v, want %+v", i, got, w)
		}
		for _, ts := range []string{got.FirstSeen, got.LastSeen} {
			if _, err := time.Parse(time.RFC3339, ts); err != nil {
				t.Errorf("rows[%d] timestamp %q is not RFC3339: %v", i, ts, err)
			}
		}
	}
}

func TestSessionsAgentFilter(t *testing.T) {
	seedSessions(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions", "--agent", "claude")
	if err != nil {
		t.Fatalf("sessions --agent claude: %v", err)
	}
	// The only claude event has an empty native session id and must be
	// skipped, so the filtered listing is empty.
	if out != "" {
		t.Errorf("stdout = %q, want no rows for claude", out)
	}

	out, _, err = runRegisteredApp(app, "sessions", "--agent", "codex")
	if err != nil {
		t.Fatalf("sessions --agent codex: %v", err)
	}
	if want := wantSessionsText(); out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
}

func TestSessionsEmpty(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "sessions")
	if err != nil {
		t.Fatalf("sessions on empty db: %v", err)
	}
	if out != "" {
		t.Errorf("stdout = %q, want no output in text mode", out)
	}
}
