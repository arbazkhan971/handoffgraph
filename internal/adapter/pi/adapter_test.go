package pi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// rawEvent builds one envelope JSON object from the given fields.
func rawEvent(t *testing.T, fields map[string]any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return b
}

func TestNameAndCapabilities(t *testing.T) {
	p := New()
	if got := p.Name(); got != "pi" {
		t.Fatalf("Name() = %q, want %q", got, "pi")
	}
	caps := p.Capabilities()
	want := adapter.Capabilities{
		NativeResume:        true,
		NativeFork:          false,
		Hooks:               false,
		ToolEvents:          true,
		PromptEvents:        true,
		CompactionEvents:    false,
		DiffEvents:          false,
		TestExitStatus:      false,
		StructuredStreaming: false,
		SessionEnumeration:  false,
	}
	if caps != want {
		t.Fatalf("Capabilities() = %+v, want %+v", caps, want)
	}
}

func TestResume(t *testing.T) {
	p := New()
	tests := []struct {
		name    string
		native  string
		wantCmd string
		wantArg []string
		wantErr bool
	}{
		{name: "valid session", native: "01a025bd-c76a-7ce4-8558-2f6b2d2cb865", wantCmd: "pi", wantArg: []string{"--resume", "01a025bd-c76a-7ce4-8558-2f6b2d2cb865"}},
		{name: "empty session", native: "", wantErr: true},
		{name: "dash prefixed session looks like a flag", native: "--resume", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec, err := p.Resume(context.Background(), adapter.SessionRef{NativeID: tt.native})
			if tt.wantErr {
				if err == nil {
					t.Fatalf("Resume(%q) = %+v, want error", tt.native, spec)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resume(%q): %v", tt.native, err)
			}
			if spec.Command != tt.wantCmd {
				t.Errorf("Command = %q, want %q", spec.Command, tt.wantCmd)
			}
			if strings.Join(spec.Args, " ") != strings.Join(tt.wantArg, " ") {
				t.Errorf("Args = %v, want %v", spec.Args, tt.wantArg)
			}
		})
	}
}

func TestStartFromCheckpointUnsupported(t *testing.T) {
	p := New()
	_, err := p.StartFromCheckpoint(context.Background(), &protocol.Checkpoint{})
	if !errors.Is(err, ErrUnsupported) {
		t.Fatalf("StartFromCheckpoint error = %v, want ErrUnsupported", err)
	}
}

func TestNormalize(t *testing.T) {
	p := New()
	ts := "2026-08-21T19:13:09.482Z"
	tests := []struct {
		name         string
		raw          json.RawMessage
		wantKind     protocol.EventKind
		wantModel    string
		checkPayload map[string]any // payload keys that must be present with these values
		wantNativeID string
	}{
		{
			name:         "session.start",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "session.start", "sessionID": "s1", "timestamp": ts, "cwd": "/repo", "model": "glm-5.3"}),
			wantKind:     protocol.EventSessionStarted,
			wantModel:    "glm-5.3",
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "session.start", "cwd": "/repo", "model": "glm-5.3"},
		},
		{
			name:         "session.switch maps to session.resumed with parent",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "session.switch", "sessionID": "s2", "parentSessionID": "s1", "timestamp": ts}),
			wantKind:     protocol.EventSessionResumed,
			wantNativeID: "s2",
			checkPayload: map[string]any{"source_kind": "session.switch", "source": "switch", "parent_session_id": "s1"},
		},
		{
			name:         "session.fork maps to session.started with fork source",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "session.fork", "sessionID": "s3", "parentSessionID": "s1", "timestamp": ts}),
			wantKind:     protocol.EventSessionStarted,
			wantNativeID: "s3",
			checkPayload: map[string]any{"source_kind": "session.fork", "source": "fork", "parent_session_id": "s1"},
		},
		{
			name:         "message.user maps to prompt.submitted",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "message.user", "sessionID": "s1", "timestamp": ts, "message": "fix the race"}),
			wantKind:     protocol.EventPromptSubmitted,
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "message.user", "message": "fix the race"},
		},
		{
			name:         "message.assistant maps to assistant.completed with model",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "message.assistant", "sessionID": "s1", "timestamp": ts, "message": "done", "model": "glm-5.3"}),
			wantKind:     protocol.EventAssistantCompleted,
			wantModel:    "glm-5.3",
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "message.assistant", "message": "done"},
		},
		{
			name:         "tool.start maps to tool.started with input",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "tool.start", "sessionID": "s1", "timestamp": ts, "tool": "bash", "input": map[string]any{"command": "go test ./..."}}),
			wantKind:     protocol.EventToolStarted,
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "tool.start", "tool": "bash"},
		},
		{
			name:         "tool.end without error maps to tool.completed",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "tool.end", "sessionID": "s1", "timestamp": ts, "tool": "bash", "output": "ok"}),
			wantKind:     protocol.EventToolCompleted,
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "tool.end", "tool": "bash", "output": "ok"},
		},
		{
			name:         "tool.end with error maps to tool.failed",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "tool.end", "sessionID": "s1", "timestamp": ts, "tool": "bash", "output": "boom", "error": "exit 1"}),
			wantKind:     protocol.EventToolFailed,
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "tool.end", "error": "exit 1"},
		},
		{
			name:         "unknown type maps to log.observed with source kind preserved",
			raw:          rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "compaction", "sessionID": "s1", "timestamp": ts}),
			wantKind:     protocol.EventLogObserved,
			wantNativeID: "s1",
			checkPayload: map[string]any{"source_kind": "compaction"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			evs, err := p.Normalize(context.Background(), tt.raw)
			if err != nil {
				t.Fatalf("Normalize: %v", err)
			}
			if len(evs) != 1 {
				t.Fatalf("got %d events, want 1", len(evs))
			}
			ev := evs[0]
			if ev.Kind != tt.wantKind {
				t.Errorf("Kind = %q, want %q", ev.Kind, tt.wantKind)
			}
			if ev.Provider != protocol.ProviderPi {
				t.Errorf("Provider = %q, want %q", ev.Provider, protocol.ProviderPi)
			}
			if ev.Provenance != protocol.ProvenanceObserved {
				t.Errorf("Provenance = %q, want %q", ev.Provenance, protocol.ProvenanceObserved)
			}
			if ev.NativeSessionID != tt.wantNativeID {
				t.Errorf("NativeSessionID = %q, want %q", ev.NativeSessionID, tt.wantNativeID)
			}
			if ev.SchemaVersion != protocol.SchemaVersionEvent {
				t.Errorf("SchemaVersion = %q, want %q", ev.SchemaVersion, protocol.SchemaVersionEvent)
			}
			if tt.wantModel != "" && ev.Model != tt.wantModel {
				t.Errorf("Model = %q, want %q", ev.Model, tt.wantModel)
			}
			var payload map[string]any
			if err := json.Unmarshal(ev.Payload, &payload); err != nil {
				t.Fatalf("payload is not JSON: %v", err)
			}
			for k, want := range tt.checkPayload {
				got, ok := payload[k]
				if !ok {
					t.Errorf("payload missing key %q (payload: %s)", k, ev.Payload)
					continue
				}
				if fmtEqual(got, want) {
					continue
				}
				// Compare via JSON round-trip to avoid float64/int mismatches.
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(want)
				if string(gj) != string(wj) {
					t.Errorf("payload[%q] = %v, want %v", k, got, want)
				}
			}
			if ev.ContentHash == "" {
				t.Error("ContentHash is empty")
			}
			if !strings.HasPrefix(ev.EventID, "evt_") {
				t.Errorf("EventID = %q, want evt_ prefix", ev.EventID)
			}
		})
	}
}

// fmtEqual reports deep equality for the small value shapes tests compare.
func fmtEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

func TestNormalizeDeterministicIDs(t *testing.T) {
	p := New()
	raw := rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "message.user", "sessionID": "s1", "timestamp": "2026-08-21T19:13:09.482Z", "message": "hello"})
	first, err := p.Normalize(context.Background(), raw)
	if err != nil {
		t.Fatalf("first Normalize: %v", err)
	}
	second, err := p.Normalize(context.Background(), raw)
	if err != nil {
		t.Fatalf("second Normalize: %v", err)
	}
	if first[0].EventID != second[0].EventID {
		t.Fatalf("re-normalizing the same envelope changed the event ID: %s vs %s", first[0].EventID, second[0].EventID)
	}
	// Different content must never collide.
	other := rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "message.user", "sessionID": "s1", "timestamp": "2026-08-21T19:13:09.482Z", "message": "different"})
	third, err := p.Normalize(context.Background(), other)
	if err != nil {
		t.Fatalf("third Normalize: %v", err)
	}
	if first[0].EventID == third[0].EventID {
		t.Fatal("distinct envelopes derived the same event ID")
	}
}

func TestNormalizeEnvelopeWithoutSessionID(t *testing.T) {
	p := New()
	raw := rawEvent(t, map[string]any{"schema": EnvelopeSchema, "type": "message.user", "timestamp": "2026-08-21T19:13:09.482Z", "message": "x"})
	a, err := p.Normalize(context.Background(), raw)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	b, err := p.Normalize(context.Background(), raw)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if a[0].NativeSessionID != "" {
		t.Errorf("NativeSessionID = %q, want empty", a[0].NativeSessionID)
	}
	// Unscopable envelopes get fresh random IDs (evidence preserved, at the
	// documented cost of idempotency for that event).
	if a[0].EventID == b[0].EventID {
		t.Fatal("session-less envelopes must not derive colliding deterministic IDs")
	}
}

func TestNormalizePreservesUnknownFieldsAndTruncates(t *testing.T) {
	p := New()
	long := strings.Repeat("x", 5000)
	raw := rawEvent(t, map[string]any{
		"schema": EnvelopeSchema, "type": "message.user", "sessionID": "s1",
		"timestamp": "2026-08-21T19:13:09.482Z", "message": long,
		"futureField": map[string]any{"a": 1},
	})
	evs, err := p.Normalize(context.Background(), raw)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	ev := evs[0]
	var payload map[string]any
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if got := len(payload["message"].(string)); got != 4096 {
		t.Errorf("message length = %d, want 4096 (truncated)", got)
	}
	if _, ok := ev.Unknown["futureField"]; !ok {
		t.Errorf("unknown envelope field not preserved: %+v", ev.Unknown)
	}
}

func TestNormalizeMalformed(t *testing.T) {
	p := New()
	tests := []struct {
		name string
		raw  json.RawMessage
	}{
		{name: "empty payload", raw: json.RawMessage("   ")},
		{name: "not json", raw: json.RawMessage("{nope")},
		{name: "json array is not an envelope", raw: json.RawMessage("[1,2]")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := p.Normalize(context.Background(), tt.raw); err == nil {
				t.Fatalf("Normalize(%s) succeeded, want error", tt.raw)
			}
		})
	}
}

// writeSessionFile writes a Pi transcript whose first line is the native
// session record, followed by body lines.
func writeSessionFile(t *testing.T, path, id, timestamp string, body ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	lines := []string{`{"type":"session","version":3,"id":"` + id + `","timestamp":"` + timestamp + `","cwd":"/repo"}`}
	lines = append(lines, body...)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
}

func TestDetect(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	// Flat transcript (real Pi layout: <encoded-cwd>/<ts>_<uuid>.jsonl).
	writeSessionFile(t,
		filepath.Join(sessions, "--Users-x-repo--", "2026-08-20T11-59-43-125Z_01a01f0a-9815-726e-96d9-8d16cb2ce479.jsonl"),
		"01a01f0a-9815-726e-96d9-8d16cb2ce479", "2026-08-20T11:59:43.125Z")
	// Nested subagent transcript (.../<run>/session.jsonl).
	writeSessionFile(t,
		filepath.Join(sessions, "--Users-x-repo--", "2026-08-21T19-07-42-151Z_01a02092-6cc7-7a51-844a-8919597a8ec6", "73c1255e-91f1-448a-9f33-c84980cfcbb2", "run-0", "session.jsonl"),
		"01a025bd-c76a-7ce4-8558-2f6b2d2cb865", "2026-08-21T19:13:09.482Z")
	// Skipped: first line is not a session record.
	if err := os.WriteFile(filepath.Join(sessions, "--Users-x-repo--", "junk.jsonl"), []byte("{\"type\":\"message\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Skipped: not JSONL.
	if err := os.WriteFile(filepath.Join(sessions, "--Users-x-repo--", "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := &Pi{SessionsDir: sessions}
	refs, err := p.Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("detected %d sessions, want 2: %+v", len(refs), refs)
	}
	// Newest first, deterministic.
	wantOrder := []string{"01a025bd-c76a-7ce4-8558-2f6b2d2cb865", "01a01f0a-9815-726e-96d9-8d16cb2ce479"}
	for i, ref := range refs {
		if ref.Provider != protocol.ProviderPi {
			t.Errorf("refs[%d].Provider = %q, want pi", i, ref.Provider)
		}
		if ref.NativeID != wantOrder[i] {
			t.Errorf("refs[%d].NativeID = %q, want %q (newest first)", i, ref.NativeID, wantOrder[i])
		}
	}
	if !refs[0].LastEventAt.Equal(time.Date(2026, 8, 21, 19, 13, 9, 482000000, time.UTC)) {
		t.Errorf("refs[0].LastEventAt = %v, want the head timestamp", refs[0].LastEventAt)
	}

	// Explicit dir argument wins over the struct field.
	refs2, err := p.Detect(context.Background(), sessions)
	if err != nil || len(refs2) != 2 {
		t.Fatalf("Detect with explicit dir = %v, %v; want 2 sessions", refs2, err)
	}

	// Best-effort: a missing sessions directory is not an error.
	refs3, err := p.Detect(context.Background(), filepath.Join(root, "missing"))
	if err != nil {
		t.Fatalf("Detect on missing dir: %v, want nil error", err)
	}
	if len(refs3) != 0 {
		t.Fatalf("Detect on missing dir returned %d sessions, want 0", len(refs3))
	}
}

func TestInstallFreshAndIdempotent(t *testing.T) {
	agentDir := t.TempDir()
	settings := filepath.Join(agentDir, settingsFileName)
	if err := os.WriteFile(settings, []byte("{\"theme\":\"dark\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Pi{AgentDir: agentDir}

	if err := p.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// Extension files exist and match the embedded source.
	extFile := filepath.Join(agentDir, "extensions", extensionDirName, ExtensionFileName)
	got, err := os.ReadFile(extFile)
	if err != nil {
		t.Fatalf("extension file missing: %v", err)
	}
	want, err := extensionFS.ReadFile("extension/" + ExtensionFileName)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Error("installed extension does not match the embedded source")
	}
	if _, err := os.Stat(filepath.Join(agentDir, "extensions", extensionDirName, manifestFileName)); err != nil {
		t.Fatalf("manifest missing: %v", err)
	}

	// settings.json: user key preserved, managed key merged, mode preserved.
	var cfg map[string]any
	data, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("settings became unparseable: %v\n%s", err, data)
	}
	if cfg["theme"] != "dark" {
		t.Errorf("user key %q lost: %s", "theme", data)
	}
	if v, ok := cfg[managedSettingsKey].(map[string]any); !ok || v["adapter"] != "pi" {
		t.Errorf("managed key missing or wrong: %s", data)
	}
	info, _ := os.Stat(settings)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("settings mode = %v, want 0600 preserved", info.Mode().Perm())
	}

	// Backup holds the pre-install content.
	bak, err := os.ReadFile(settings + settingsBackupSuffix)
	if err != nil {
		t.Fatalf("backup missing: %v", err)
	}
	if string(bak) != "{\"theme\":\"dark\"}\n" {
		t.Errorf("backup content = %q, want the pre-install settings", bak)
	}

	// Second install is an idempotent no-op: bytes unchanged.
	before, _ := os.ReadFile(settings)
	extBefore, _ := os.ReadFile(extFile)
	if err := p.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("second Install: %v", err)
	}
	after, _ := os.ReadFile(settings)
	extAfter, _ := os.ReadFile(extFile)
	if string(before) != string(after) || string(extBefore) != string(extAfter) {
		t.Error("idempotent install rewrote unchanged content")
	}
}

func TestInstallDryRunWritesNothing(t *testing.T) {
	agentDir := t.TempDir()
	p := &Pi{AgentDir: agentDir}
	if err := p.InstallExtension(context.Background(), agentDir, InstallOptions{DryRun: true}); err != nil {
		t.Fatalf("dry-run Install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(agentDir, settingsFileName)); !os.IsNotExist(err) {
		t.Error("dry run wrote settings.json")
	}
	if _, err := os.Stat(filepath.Join(agentDir, "extensions", extensionDirName)); !os.IsNotExist(err) {
		t.Error("dry run wrote the extension directory")
	}
}

func TestInstallScopeProjectUnsupported(t *testing.T) {
	p := &Pi{AgentDir: t.TempDir()}
	if err := p.Install(context.Background(), adapter.ScopeProject); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Install(project) error = %v, want ErrUnsupported", err)
	}
	if err := p.Uninstall(context.Background(), adapter.ScopeProject); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Uninstall(project) error = %v, want ErrUnsupported", err)
	}
}

func TestInstallConflicts(t *testing.T) {
	tests := []struct {
		name   string
		setup  func(t *testing.T, agentDir string)
		wantOp string
	}{
		{
			name: "unparseable settings is never modified",
			setup: func(t *testing.T, agentDir string) {
				if err := os.WriteFile(filepath.Join(agentDir, settingsFileName), []byte("{not json"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "managed settings key is not an object",
			setup: func(t *testing.T, agentDir string) {
				if err := os.WriteFile(filepath.Join(agentDir, settingsFileName), []byte(`{"handoffgraph":true}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "managed settings key differs from managed value",
			setup: func(t *testing.T, agentDir string) {
				if err := os.WriteFile(filepath.Join(agentDir, settingsFileName), []byte(`{"handoffgraph":{"adapter":"other"}}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "user-owned extension directory without manifest",
			setup: func(t *testing.T, agentDir string) {
				dir := filepath.Join(agentDir, "extensions", extensionDirName)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, ExtensionFileName), []byte("// user code"), 0o644); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "extension path exists as a file",
			setup: func(t *testing.T, agentDir string) {
				if err := os.MkdirAll(filepath.Join(agentDir, "extensions"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(agentDir, "extensions", extensionDirName), []byte("x"), 0o644); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			agentDir := t.TempDir()
			tt.setup(t, agentDir)
			p := &Pi{AgentDir: agentDir}
			err := p.InstallExtension(context.Background(), agentDir, InstallOptions{})
			if !errors.Is(err, ErrInstallConflict) {
				t.Fatalf("error = %v, want ErrInstallConflict", err)
			}
			// Nothing was written: no manifest, no backup.
			if _, err := os.Stat(filepath.Join(agentDir, "extensions", extensionDirName, manifestFileName)); err == nil {
				t.Error("conflicting install wrote a manifest")
			}
			if _, err := os.Stat(filepath.Join(agentDir, settingsFileName+settingsBackupSuffix)); err == nil {
				t.Error("conflicting install wrote a backup")
			}
		})
	}
}

func TestUninstall(t *testing.T) {
	agentDir := t.TempDir()
	settings := filepath.Join(agentDir, settingsFileName)
	if err := os.WriteFile(settings, []byte("{\"theme\":\"dark\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Pi{AgentDir: agentDir}
	if err := p.Install(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if err := p.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}

	// Managed key and extension dir are gone; user key survives; backup kept.
	data, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("settings unparseable after uninstall: %v", err)
	}
	if _, still := cfg[managedSettingsKey]; still {
		t.Errorf("managed key survived uninstall: %s", data)
	}
	if cfg["theme"] != "dark" {
		t.Errorf("user key lost on uninstall: %s", data)
	}
	if _, err := os.Stat(filepath.Join(agentDir, "extensions", extensionDirName)); !os.IsNotExist(err) {
		t.Error("extension directory survived uninstall")
	}
	if _, err := os.Stat(settings + settingsBackupSuffix); err != nil {
		t.Errorf("backup removed by uninstall (kept deliberately as evidence): %v", err)
	}

	// Uninstalling a clean home is a no-op.
	if err := p.Uninstall(context.Background(), adapter.ScopeUser); err != nil {
		t.Fatalf("second Uninstall: %v", err)
	}
}

func TestUninstallRefusesUserState(t *testing.T) {
	t.Run("user-owned extension directory without manifest", func(t *testing.T) {
		agentDir := t.TempDir()
		dir := filepath.Join(agentDir, "extensions", extensionDirName)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ExtensionFileName), []byte("// user"), 0o644); err != nil {
			t.Fatal(err)
		}
		p := &Pi{AgentDir: agentDir}
		if err := p.UninstallExtension(context.Background(), agentDir); !errors.Is(err, ErrInstallConflict) {
			t.Fatalf("error = %v, want ErrInstallConflict", err)
		}
		if _, err := os.Stat(filepath.Join(dir, ExtensionFileName)); err != nil {
			t.Error("user-owned extension file was removed")
		}
	})

	t.Run("managed settings key is not an object", func(t *testing.T) {
		agentDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(agentDir, settingsFileName), []byte(`{"handoffgraph":[1]}`), 0o600); err != nil {
			t.Fatal(err)
		}
		p := &Pi{AgentDir: agentDir}
		if err := p.UninstallExtension(context.Background(), agentDir); !errors.Is(err, ErrInstallConflict) {
			t.Fatalf("error = %v, want ErrInstallConflict", err)
		}
		data, _ := os.ReadFile(filepath.Join(agentDir, settingsFileName))
		if string(data) != `{"handoffgraph":[1]}` {
			t.Errorf("settings modified on refused uninstall: %s", data)
		}
	})
}

// TestEmbeddedExtensionMatchesIntegrations guards the two copies of the
// extension source: integrations/pi/handoffgraph-extension.ts is canonical,
// internal/adapter/pi/extension/ is the embedded copy the installer ships.
func TestEmbeddedExtensionMatchesIntegrations(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("repo root not found at %s: %v", root, err)
	}
	integrations, err := os.ReadFile(filepath.Join(root, "integrations", "pi", "handoffgraph-extension.ts"))
	if err != nil {
		t.Fatalf("read canonical extension source: %v", err)
	}
	embedded, err := extensionFS.ReadFile("extension/" + ExtensionFileName)
	if err != nil {
		t.Fatal(err)
	}
	if string(integrations) != string(embedded) {
		t.Error("integrations/pi/handoffgraph-extension.ts and internal/adapter/pi/extension/ have diverged; re-copy the file")
	}
}
