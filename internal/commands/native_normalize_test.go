package commands

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func writeClaudeNativeTranscript(t *testing.T) string {
	return writeClaudeNativeTranscriptWithID(t, "claude-native-session", "done")
}

func writeClaudeNativeTranscriptWithID(t *testing.T, nativeID, marker string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, nativeID+".jsonl")
	data := strings.Join([]string{
		`{"type":"mode","sessionId":"` + nativeID + `","mode":"default"}`,
		`{"type":"user","sessionId":"` + nativeID + `","timestamp":"2026-08-30T10:00:00Z","message":{"content":"run tests"}}`,
		`{"type":"assistant","sessionId":"` + nativeID + `","timestamp":"2026-08-30T10:00:01Z","message":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"` + marker + `"}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func decodeNormalizedJSONL(t *testing.T, output string) []protocol.Event {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	events := make([]protocol.Event, 0, len(lines))
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event protocol.Event
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("line %d: %v\n%s", i+1, err, line)
		}
		events = append(events, event)
	}
	return events
}

func assertNativeAssociation(t *testing.T, events []protocol.Event, provider, workstream string) string {
	t.Helper()
	if len(events) == 0 {
		t.Fatal("no normalized events")
	}
	nativeID := events[0].NativeSessionID
	wantSession := ids.Deterministic(ids.PrefixSession, "native-session|"+provider+"|"+nativeID, 0)
	for i, event := range events {
		if event.Provider != provider || event.NativeSessionID != nativeID {
			t.Errorf("event %d provider/native = %s/%s", i+1, event.Provider, event.NativeSessionID)
		}
		if event.WorkstreamID != workstream || event.SessionID != wantSession {
			t.Errorf("event %d association = %s/%s, want %s/%s", i+1, event.WorkstreamID, event.SessionID, workstream, wantSession)
		}
		if event.Provenance != protocol.ProvenanceObserved {
			t.Errorf("event %d provenance changed to %s", i+1, event.Provenance)
		}
	}
	return wantSession
}

func TestNativeNormalizeAssociationMatchesCodexAndClaude(t *testing.T) {
	workstream := ids.Workstream()

	codexPath := codexTestFixturePath(t, "codex_session.jsonl")
	codexOut, _, err := runCodexApp(t, newCodexApp(t), "normalize", codexPath, "--workstream", workstream)
	if err != nil {
		t.Fatalf("codex normalize association: %v", err)
	}
	codexEvents := decodeNormalizedJSONL(t, codexOut)
	codexSession := assertNativeAssociation(t, codexEvents, protocol.ProviderCodex, workstream)

	claudePath := writeClaudeNativeTranscript(t)
	claudeOut, _, err := runClaude(t, "normalize", claudePath, "--workstream", workstream)
	if err != nil {
		t.Fatalf("claude normalize association: %v", err)
	}
	claudeEvents := decodeNormalizedJSONL(t, claudeOut)
	claudeSession := assertNativeAssociation(t, claudeEvents, protocol.ProviderClaude, workstream)
	if codexSession == claudeSession {
		t.Fatal("provider-scoped native sessions collided")
	}

	claudeAgain, _, err := runClaude(t, "--workstream", workstream, "normalize", claudePath)
	if err != nil {
		t.Fatalf("claude normalize outer flags: %v", err)
	}
	if claudeAgain != claudeOut {
		t.Error("associated Claude output is not byte-deterministic across flag positions")
	}
}

func TestNativeNormalizeExplicitSessionOverride(t *testing.T) {
	workstream := ids.Workstream()
	session := ids.Session()
	out, _, err := runClaude(t, "normalize", writeClaudeNativeTranscript(t), "--workstream", workstream, "--session", session)
	if err != nil {
		t.Fatal(err)
	}
	for i, event := range decodeNormalizedJSONL(t, out) {
		if event.WorkstreamID != workstream || event.SessionID != session {
			t.Errorf("event %d association = %s/%s", i+1, event.WorkstreamID, event.SessionID)
		}
	}
}

func TestCodexAndClaudeNormalizeImportOneWorkstreamIsIdempotentAndCheckpointable(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	workstreamOut, _, err := runRegisteredApp(app, "workstream", "new", "native-acceptance")
	if err != nil {
		t.Fatalf("create workstream: %v", err)
	}
	workstream := strings.TrimSpace(workstreamOut)
	path := writeClaudeNativeTranscript(t)

	out, _, err := runRegisteredApp(app, "claude", "normalize", path, "--workstream", workstream, "--import")
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if !strings.Contains(out, "imported 3 new event(s), 0 already present") {
		t.Fatalf("first import output = %q", out)
	}
	out, _, err = runRegisteredApp(app, "claude", "normalize", path, "--workstream", workstream, "--import")
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if !strings.Contains(out, "imported 0 new event(s), 3 already present") {
		t.Fatalf("second import output = %q", out)
	}

	codexPath := codexTestFixturePath(t, "codex_session.jsonl")
	out, _, err = runRegisteredApp(app, "codex", "normalize", codexPath, "--workstream", workstream, "--import")
	if err != nil {
		t.Fatalf("codex import: %v", err)
	}
	if !strings.Contains(out, "imported 6 new event(s), 0 already present") {
		t.Fatalf("codex import output = %q", out)
	}
	out, _, err = runRegisteredApp(app, "codex", "normalize", codexPath, "--workstream", workstream, "--import")
	if err != nil || !strings.Contains(out, "imported 0 new event(s), 6 already present") {
		t.Fatalf("codex idempotent import output=%q err=%v", out, err)
	}

	checkpointJSON, _, err := runRegisteredApp(app, "checkpoint", "--workstream", workstream, "--objective", "cross-provider acceptance")
	if err != nil {
		t.Fatalf("checkpoint imported transcript: %v", err)
	}
	var checkpoint protocol.Checkpoint
	if err := json.Unmarshal([]byte(checkpointJSON), &checkpoint); err != nil {
		t.Fatalf("decode checkpoint: %v\n%s", err, checkpointJSON)
	}
	if checkpoint.WorkstreamID != workstream || len(checkpoint.SourceSessions) != 2 {
		t.Fatalf("checkpoint identity = %s, sessions=%+v", checkpoint.WorkstreamID, checkpoint.SourceSessions)
	}
	providers := map[string]protocol.SourceSession{}
	for _, source := range checkpoint.SourceSessions {
		providers[source.Provider] = source
	}
	claudeSource := providers[protocol.ProviderClaude]
	if claudeSource.NativeSessionID != "claude-native-session" || claudeSource.SessionID == "" {
		t.Fatalf("Claude checkpoint source session = %+v", claudeSource)
	}
	codexSource := providers[protocol.ProviderCodex]
	if codexSource.NativeSessionID == "" || codexSource.SessionID == "" || codexSource.SessionID == claudeSource.SessionID {
		t.Fatalf("Codex checkpoint source session = %+v", codexSource)
	}
}

func TestNativeNormalizeImportRequiresExistingWorkstreamAndRejectsAssociationConflict(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	path := writeClaudeNativeTranscript(t)

	missing := ids.Workstream()
	if _, _, err := runRegisteredApp(app, "claude", "normalize", path, "--workstream", missing, "--import"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing workstream error = %v", err)
	}
	status, _, err := runRegisteredApp(app, "status")
	if err != nil || !strings.Contains(status, "events: 0") {
		t.Fatalf("missing workstream wrote events: status=%q err=%v", status, err)
	}

	create := func(title string) string {
		t.Helper()
		out, _, err := runRegisteredApp(app, "workstream", "new", title)
		if err != nil {
			t.Fatalf("create %s: %v", title, err)
		}
		return strings.TrimSpace(out)
	}
	firstWorkstream := create("first")
	secondWorkstream := create("second")
	if _, _, err := runRegisteredApp(app, "claude", "normalize", path, "--workstream", firstWorkstream, "--import"); err != nil {
		t.Fatalf("first association import: %v", err)
	}
	_, _, err = runRegisteredApp(app, "claude", "normalize", path, "--workstream", secondWorkstream, "--import")
	if err == nil || !strings.Contains(err.Error(), "session ownership conflict") || !strings.Contains(err.Error(), firstWorkstream) || !strings.Contains(err.Error(), secondWorkstream) {
		t.Fatalf("cross-workstream conflict error = %v", err)
	}
	status, _, err = runRegisteredApp(app, "status")
	if err != nil || !strings.Contains(status, "events: 3") {
		t.Fatalf("association conflict changed event log: status=%q err=%v", status, err)
	}

	differentSession := ids.Session()
	_, _, err = runRegisteredApp(app, "claude", "normalize", path, "--workstream", firstWorkstream, "--session", differentSession, "--import")
	if err == nil || !strings.Contains(err.Error(), "event id conflict") {
		t.Fatalf("cross-session conflict error = %v", err)
	}
}

func TestNativeNormalizeExplicitSessionOwnershipFailsClosed(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)
	createWorkstream := func(title string) string {
		t.Helper()
		out, _, err := runRegisteredApp(app, "workstream", "new", title)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(out)
	}
	firstWorkstream := createWorkstream("owner-one")
	secondWorkstream := createWorkstream("owner-two")
	explicitSession := ids.Session()
	firstPath := writeClaudeNativeTranscriptWithID(t, "native-owner-one", "first")
	if _, _, err := runRegisteredApp(app, "claude", "normalize", firstPath, "--workstream", firstWorkstream, "--session", explicitSession, "--import"); err != nil {
		t.Fatalf("seed explicit owner: %v", err)
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		t.Fatal(err)
	}
	countBefore, _ := db.EventCount(context.Background())
	maxBefore, _ := db.MaxSeq(context.Background())
	db.Close()

	tests := []struct {
		name     string
		command  string
		args     []string
		wantPart string
	}{
		{
			name:     "different native",
			command:  "claude",
			args:     []string{"normalize", writeClaudeNativeTranscriptWithID(t, "native-owner-two", "second"), "--workstream", firstWorkstream, "--session", explicitSession, "--import"},
			wantPart: "native session",
		},
		{
			name:     "different provider",
			command:  "codex",
			args:     []string{"normalize", codexTestFixturePath(t, "codex_session.jsonl"), "--workstream", firstWorkstream, "--session", explicitSession, "--import"},
			wantPart: "provider",
		},
		{
			name:     "same native different workstream",
			command:  "claude",
			args:     []string{"normalize", firstPath, "--workstream", secondWorkstream, "--session", explicitSession, "--import"},
			wantPart: "workstream",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := runRegisteredApp(app, tc.command, tc.args...)
			if err == nil || !strings.Contains(err.Error(), "session ownership conflict") || !strings.Contains(err.Error(), tc.wantPart) {
				t.Fatalf("ownership error = %v", err)
			}
			_, db, openErr := loadConfigAndDB()
			if openErr != nil {
				t.Fatal(openErr)
			}
			countAfter, _ := db.EventCount(context.Background())
			maxAfter, _ := db.MaxSeq(context.Background())
			db.Close()
			if countAfter != countBefore || maxAfter != maxBefore {
				t.Fatalf("ownership conflict mutated log: count %d->%d max %d->%d", countBefore, countAfter, maxBefore, maxAfter)
			}
		})
	}

	out, _, err := runRegisteredApp(app, "claude", "normalize", firstPath, "--workstream", firstWorkstream, "--session", explicitSession, "--import")
	if err != nil || !strings.Contains(out, "imported 0 new event(s), 3 already present") {
		t.Fatalf("matching owner retry output=%q err=%v", out, err)
	}
}

func TestNativeNormalizeAssociationRejectsUnsafeFlags(t *testing.T) {
	path := writeClaudeNativeTranscript(t)
	tests := [][]string{
		{"normalize", path, "--workstream", "ws_not-a-ulid"},
		{"normalize", path, "--session", "ses_not-a-ulid"},
		{"normalize", path, "--import"},
		{"normalize", path, "--workstream", ids.Workstream(), "--import", "--json"},
	}
	for _, args := range tests {
		if _, _, err := runClaude(t, args...); err == nil {
			t.Errorf("claude %v succeeded, want error", args)
		}
	}
}

func TestNormalizeOnlyFlagsRejectedByUnrelatedProviderSubcommands(t *testing.T) {
	workstream := ids.Workstream()
	session := ids.Session()
	claudeCases := []struct {
		args     []string
		wantPart string
	}{
		{args: []string{"sessions", "--workstream", workstream}, wantPart: "flag provided but not defined"},
		{args: []string{"--session", session, "sessions"}, wantPart: "only valid with normalize"},
		{args: []string{"resume", "native-safe", "--import"}, wantPart: "flag provided but not defined"},
	}
	for _, tc := range claudeCases {
		if _, _, err := runClaude(t, tc.args...); err == nil || !strings.Contains(err.Error(), tc.wantPart) {
			t.Errorf("claude %v error = %v", tc.args, err)
		}
	}

	for _, tc := range []struct {
		args     []string
		wantPart string
	}{
		{args: []string{"sessions", "--sessions-dir", t.TempDir(), "--workstream", workstream}, wantPart: "flag provided but not defined"},
		{args: []string{"--session", session, "sessions", "--sessions-dir", t.TempDir()}, wantPart: "only valid with normalize"},
		{args: []string{"app-server-sessions", "--import"}, wantPart: "flag provided but not defined"},
	} {
		if _, _, err := runCodexApp(t, newCodexApp(t), tc.args...); err == nil || !strings.Contains(err.Error(), tc.wantPart) {
			t.Errorf("codex %v error = %v", tc.args, err)
		}
	}
}
