package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

func runHookApp(t *testing.T, dataDir, provider string, stdin []byte) (string, string, error) {
	t.Helper()
	t.Setenv("HFG_DATA_DIR", dataDir)
	app := cli.NewApp("handoffgraph", "test")
	RegisterHookCmd(app)
	var stdout, stderr bytes.Buffer
	err := app.Run(context.Background(), &cli.Context{
		Stdin:  bytes.NewReader(stdin),
		Stdout: &stdout,
		Stderr: &stderr,
	}, "hook", []string{provider})
	return stdout.String(), stderr.String(), err
}

func hookEvents(t *testing.T, dataDir string) []*protocol.Event {
	t.Helper()
	t.Setenv("HFG_DATA_DIR", dataDir)
	cfg := config.Default()
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open hook database: %v", err)
	}
	defer db.Close()
	events, err := db.ListEvents(context.Background())
	if err != nil {
		t.Fatalf("list hook events: %v", err)
	}
	return events
}

func TestHookCodexCapturesOfficialPayloadSilentlyAndIdempotently(t *testing.T) {
	dataDir := t.TempDir()
	raw := []byte(`{"hook_event_name":"PreToolUse","session_id":"codex-session","turn_id":"turn-1","transcript_path":null,"cwd":"/repo","model":"gpt-5.4","permission_mode":"default","tool_name":"exec_command","tool_input":{"cmd":"go test ./..."},"tool_use_id":"call-1"}`)
	for attempt := 1; attempt <= 2; attempt++ {
		stdout, stderr, err := runHookApp(t, dataDir, protocol.ProviderCodex, raw)
		if err != nil {
			t.Fatalf("attempt %d: hook codex: %v", attempt, err)
		}
		if stdout != "" || stderr != "" {
			t.Fatalf("attempt %d emitted hook output: stdout=%q stderr=%q", attempt, stdout, stderr)
		}
	}
	events := hookEvents(t, dataDir)
	if len(events) != 1 {
		t.Fatalf("captured events = %d, want one idempotent event", len(events))
	}
	if events[0].Kind != protocol.EventToolStarted || events[0].Provider != protocol.ProviderCodex || events[0].NativeSessionID != "codex-session" {
		t.Fatalf("captured event = %+v", events[0])
	}
	if !events[0].OccurredAt.IsZero() || !events[0].ObservedAt.IsZero() {
		t.Errorf("hook fabricated native timestamps: %+v", events[0])
	}
}

func TestHookClaudeCapturesOfficialPayloadSilentlyAndIdempotently(t *testing.T) {
	dataDir := t.TempDir()
	raw := []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"claude-session","transcript_path":"/tmp/session.jsonl","cwd":"/repo","permission_mode":"default","prompt":"run the tests"}`)
	for attempt := 1; attempt <= 2; attempt++ {
		stdout, stderr, err := runHookApp(t, dataDir, protocol.ProviderClaude, raw)
		if err != nil {
			t.Fatalf("attempt %d: hook claude: %v", attempt, err)
		}
		if stdout != "" || stderr != "" {
			t.Fatalf("attempt %d emitted hook output: stdout=%q stderr=%q", attempt, stdout, stderr)
		}
	}
	events := hookEvents(t, dataDir)
	if len(events) != 1 || events[0].Kind != protocol.EventPromptSubmitted || events[0].Provider != protocol.ProviderClaude {
		t.Fatalf("captured events = %+v", events)
	}
}

func TestHookIgnoresUntrustedRepositoryStoreRedirect(t *testing.T) {
	safeDataDir := t.TempDir()
	repo := t.TempDir()
	redirected := filepath.Join(repo, "captured-inside-repo")
	configBody := "data_dir = " + strconv.Quote(redirected) + "\n"
	if err := os.WriteFile(filepath.Join(repo, config.RepoConfigName), []byte(configBody), 0o600); err != nil {
		t.Fatal(err)
	}
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repo); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })

	raw := []byte(`{"hook_event_name":"SessionStart","session_id":"safe-session","transcript_path":null,"cwd":"/repo","model":"gpt-5.4","permission_mode":"default","source":"startup"}`)
	stdout, stderr, err := runHookApp(t, safeDataDir, protocol.ProviderCodex, raw)
	if err != nil || stdout != "" || stderr != "" {
		t.Fatalf("hook result stdout=%q stderr=%q err=%v", stdout, stderr, err)
	}
	if got := len(hookEvents(t, safeDataDir)); got != 1 {
		t.Fatalf("safe store events = %d, want one", got)
	}
	if _, err := os.Stat(redirected); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repository-controlled data directory was touched: %v", err)
	}
}

func TestHookRejectsInputBeforeOpeningDatabase(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		stdin    []byte
		want     string
	}{
		{"empty", "codex", nil, "empty"},
		{"malformed", "codex", []byte(`{"hook_event_name":`), "exactly one JSON object"},
		{"trailing object", "codex", []byte(`{"session_id":"s"}{"session_id":"s"}`), "exactly one JSON object"},
		{"array", "claude", []byte(`[{"session_id":"s"}]`), "exactly one JSON object"},
		{"null", "claude", []byte(`null`), "exactly one JSON object"},
		{"invalid utf8", "codex", []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, "UTF-8"},
		{"missing session", "codex", []byte(`{"hook_event_name":"SessionStart"}`), "session_id"},
		{"missing event", "codex", []byte(`{"session_id":"s"}`), "hook_event_name"},
		{"null event", "codex", []byte(`{"hook_event_name":null,"session_id":"s"}`), "hook_event_name"},
		{"numeric event", "claude", []byte(`{"hook_event_name":123,"session_id":"s"}`), "hook_event_name"},
		{"invalid timestamp", "claude", []byte(`{"hook_event_name":"SessionStart","session_id":"s","timestamp":"not-a-time"}`), "RFC3339"},
		{"numeric timestamp", "codex", []byte(`{"hook_event_name":"SessionStart","session_id":"s","timestamp":123}`), "RFC3339"},
		{"unknown provider", "future", []byte(`{"session_id":"s"}`), "unknown hook provider"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			stdout, _, err := runHookApp(t, dataDir, tc.provider, tc.stdin)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if stdout != "" {
				t.Errorf("failure wrote stdout %q", stdout)
			}
			if _, statErr := os.Stat(filepath.Join(dataDir, "handoffgraph.db")); !errors.Is(statErr, os.ErrNotExist) {
				t.Errorf("invalid input reached database open (stat err %v)", statErr)
			}
		})
	}
}

func TestHookRejectsOversizeInputBeforeOpeningDatabase(t *testing.T) {
	dataDir := t.TempDir()
	raw := append([]byte(`{"hook_event_name":"SessionStart","session_id":"s","padding":"`), bytes.Repeat([]byte("x"), int(maxHookPayloadBytes))...)
	raw = append(raw, []byte(`"}`)...)
	stdout, _, err := runHookApp(t, dataDir, protocol.ProviderCodex, raw)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversize error = %v", err)
	}
	if stdout != "" {
		t.Errorf("oversize failure wrote stdout %q", stdout)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "handoffgraph.db")); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("oversize input reached database open (stat err %v)", statErr)
	}
}

func TestReadHookObjectAllowsOnlyTrailingWhitespace(t *testing.T) {
	raw, err := readHookObject(strings.NewReader("  {\"session_id\":\"s\"} \n\t"))
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object["session_id"] != "s" {
		t.Fatalf("decoded = %v, err = %v", object, err)
	}
	if _, err := readHookObject(nil); err == nil {
		t.Fatal("nil stdin succeeded")
	}
}

func TestValidateHookEnvelopePinsCurrentProviderSchemas(t *testing.T) {
	type schemaCase struct {
		provider    string
		event       string
		requiredKey string
		fields      map[string]any
	}
	codex := func(event, required string, fields map[string]any) schemaCase {
		base := map[string]any{
			"hook_event_name": event,
			"session_id":      "codex-session",
			"transcript_path": nil,
			"cwd":             "/repo",
			"model":           "gpt-5.4",
		}
		for key, value := range fields {
			base[key] = value
		}
		return schemaCase{protocol.ProviderCodex, event, required, base}
	}
	claude := func(event, required string, fields map[string]any) schemaCase {
		base := map[string]any{
			"hook_event_name": event,
			"session_id":      "claude-session",
			"transcript_path": "/tmp/session.jsonl",
			"cwd":             "/repo",
		}
		for key, value := range fields {
			base[key] = value
		}
		return schemaCase{protocol.ProviderClaude, event, required, base}
	}
	cases := []schemaCase{
		codex("PermissionRequest", "tool_input", map[string]any{"permission_mode": "default", "tool_name": "exec_command", "tool_input": map[string]any{}, "turn_id": "t"}),
		codex("PostCompact", "trigger", map[string]any{"trigger": "auto", "turn_id": "t"}),
		codex("PostToolUse", "tool_response", map[string]any{"permission_mode": "default", "tool_name": "exec_command", "tool_input": map[string]any{}, "tool_response": map[string]any{}, "tool_use_id": "u", "turn_id": "t"}),
		codex("PreCompact", "trigger", map[string]any{"trigger": "manual", "turn_id": "t"}),
		codex("PreToolUse", "tool_input", map[string]any{"permission_mode": "default", "tool_name": "exec_command", "tool_input": map[string]any{}, "tool_use_id": "u", "turn_id": "t"}),
		codex("SessionStart", "source", map[string]any{"permission_mode": "default", "source": "startup"}),
		codex("Stop", "last_assistant_message", map[string]any{"permission_mode": "default", "stop_hook_active": false, "last_assistant_message": nil, "turn_id": "t"}),
		codex("SubagentStart", "agent_id", map[string]any{"agent_id": "a", "agent_type": "worker", "permission_mode": "default", "turn_id": "t"}),
		codex("SubagentStop", "agent_transcript_path", map[string]any{"agent_id": "a", "agent_type": "worker", "agent_transcript_path": nil, "permission_mode": "default", "stop_hook_active": false, "last_assistant_message": nil, "turn_id": "t"}),
		codex("UserPromptSubmit", "prompt", map[string]any{"permission_mode": "default", "prompt": "fix it", "turn_id": "t"}),
		claude("PostCompact", "compact_summary", map[string]any{"trigger": "auto", "compact_summary": "summary"}),
		claude("PostToolUse", "tool_response", map[string]any{"permission_mode": "default", "tool_name": "Bash", "tool_input": map[string]any{}, "tool_response": "ok", "tool_use_id": "u", "duration_ms": 1}),
		claude("PreCompact", "custom_instructions", map[string]any{"trigger": "manual", "custom_instructions": nil}),
		claude("PreToolUse", "tool_input", map[string]any{"permission_mode": "default", "tool_name": "Bash", "tool_input": map[string]any{}, "tool_use_id": "u"}),
		claude("SessionEnd", "reason", map[string]any{"reason": "logout"}),
		claude("SessionStart", "source", map[string]any{"source": "fork"}),
		claude("Stop", "stop_hook_active", map[string]any{"permission_mode": "default", "stop_hook_active": false}),
		claude("UserPromptSubmit", "prompt", map[string]any{"permission_mode": "default", "prompt": "fix it"}),
	}
	for _, tc := range cases {
		t.Run(tc.provider+"/"+tc.event, func(t *testing.T) {
			raw, err := json.Marshal(tc.fields)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateHookEnvelope(raw, tc.provider); err != nil {
				t.Fatalf("valid current payload rejected: %v\n%s", err, raw)
			}
			delete(tc.fields, tc.requiredKey)
			missing, err := json.Marshal(tc.fields)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateHookEnvelope(missing, tc.provider); err == nil || !strings.Contains(err.Error(), tc.requiredKey) {
				t.Fatalf("missing %s error = %v", tc.requiredKey, err)
			}
		})
	}
	unknown, _ := json.Marshal(map[string]any{
		"hook_event_name": "FutureEvent", "session_id": "s", "transcript_path": nil,
		"cwd": "/repo", "model": "gpt-5.4",
	})
	if err := validateHookEnvelope(unknown, protocol.ProviderCodex); err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("unknown event error = %v", err)
	}
}
