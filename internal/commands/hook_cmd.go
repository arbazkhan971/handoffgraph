package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/adapter/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// maxHookPayloadBytes bounds one provider callback before JSON decoding or
// opening the local database. Hook payloads can contain tool responses, but a
// callback large enough to exceed one MiB belongs in a transcript/object
// import path instead of an argv-triggered lifecycle hook.
const maxHookPayloadBytes int64 = 1 << 20

// RegisterHookCmd exposes the stdin-only live capture surface used by the
// default Codex and Claude hook installations.
func RegisterHookCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "hook",
		Summary: "Capture one Codex or Claude hook payload from stdin",
		Usage:   "codex | claude",
		Run:     hookCmd,
	})
}

func hookCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) != 1 {
		return errors.New("usage: hook codex|claude")
	}

	var normalizer adapter.Adapter
	switch args[0] {
	case protocol.ProviderCodex:
		normalizer = codex.New()
	case protocol.ProviderClaude:
		normalizer = claude.New()
	default:
		return fmt.Errorf("unknown hook provider %q (available: codex, claude)", args[0])
	}

	raw, err := readHookObject(c.Stdin)
	if err != nil {
		return fmt.Errorf("hook %s: %w", args[0], err)
	}
	if err := validateHookEnvelope(raw, args[0]); err != nil {
		return fmt.Errorf("hook %s: %w", args[0], err)
	}
	events, err := normalizer.Normalize(ctx, raw)
	if err != nil {
		return fmt.Errorf("hook %s: normalize: %w", args[0], err)
	}
	if len(events) == 0 {
		return fmt.Errorf("hook %s: normalize produced no events", args[0])
	}
	batch := make([]*protocol.Event, len(events))
	for i := range events {
		if events[i].NativeSessionID == "" {
			return fmt.Errorf("hook %s: payload is missing session_id", args[0])
		}
		batch[i] = &events[i]
	}

	_, db, err := loadHookConfigAndDB()
	if err != nil {
		return fmt.Errorf("hook %s: open local event store: %w", args[0], err)
	}
	defer db.Close()
	if _, err := db.AppendEventsAtomic(ctx, batch); err != nil {
		return fmt.Errorf("hook %s: append event batch: %w", args[0], err)
	}
	// Deliberately no stdout on success. Codex and Claude interpret hook stdout
	// as control/context output; capture must never inject model-visible text.
	return nil
}

// validateHookEnvelope enforces the fields shared by provider callbacks
// before normalization or opening the event store. The globally installed
// capture surface is pinned to the provider versions its installers target;
// unknown event names and malformed fields fail closed instead of being
// persisted as misleading logs. Direct transcript normalization remains the
// forward-compatible evidence path for unknown native records.
func validateHookEnvelope(raw json.RawMessage, provider string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return errors.New("stdin must contain exactly one JSON object")
	}
	v := hookEnvelopeValidator{object: object}
	eventName, err := v.requiredString("hook_event_name", true)
	if err != nil {
		return err
	}
	if _, err := v.requiredString("session_id", true); err != nil {
		return err
	}
	if value, present := object["timestamp"]; present {
		var timestamp string
		if json.Unmarshal(value, &timestamp) != nil || timestamp == "" {
			return errors.New("timestamp must be an RFC3339 string when present")
		}
		if _, err := time.Parse(time.RFC3339, timestamp); err != nil {
			return fmt.Errorf("timestamp must be RFC3339: %w", err)
		}
	}
	switch provider {
	case protocol.ProviderCodex:
		return validateCodexHook(v, eventName)
	case protocol.ProviderClaude:
		return validateClaudeHook(v, eventName)
	default:
		return fmt.Errorf("unsupported hook provider %q", provider)
	}
}

type hookEnvelopeValidator struct {
	object map[string]json.RawMessage
}

func (v hookEnvelopeValidator) requiredString(key string, nonEmpty bool) (string, error) {
	raw, present := v.object[key]
	if !present {
		return "", fmt.Errorf("%s is required", key)
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || (nonEmpty && value == "") {
		qualifier := "a string"
		if nonEmpty {
			qualifier = "a non-empty string"
		}
		return "", fmt.Errorf("%s must be %s", key, qualifier)
	}
	return value, nil
}

func (v hookEnvelopeValidator) optionalString(key string) error {
	if _, present := v.object[key]; !present {
		return nil
	}
	_, err := v.requiredString(key, false)
	return err
}

func (v hookEnvelopeValidator) requiredEnum(key string, allowed ...string) error {
	value, err := v.requiredString(key, false)
	if err != nil {
		return err
	}
	for _, candidate := range allowed {
		if value == candidate {
			return nil
		}
	}
	return fmt.Errorf("%s has unsupported value %q", key, value)
}

func (v hookEnvelopeValidator) optionalEnum(key string, allowed ...string) error {
	if _, present := v.object[key]; !present {
		return nil
	}
	return v.requiredEnum(key, allowed...)
}

func (v hookEnvelopeValidator) requiredBool(key string) error {
	raw, present := v.object[key]
	if !present {
		return fmt.Errorf("%s is required", key)
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return fmt.Errorf("%s must be a boolean", key)
	}
	return nil
}

func (v hookEnvelopeValidator) requiredAny(key string) error {
	if _, present := v.object[key]; !present {
		return fmt.Errorf("%s is required", key)
	}
	return nil
}

func (v hookEnvelopeValidator) requiredObject(key string) error {
	raw, present := v.object[key]
	if !present {
		return fmt.Errorf("%s is required", key)
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return fmt.Errorf("%s must be a JSON object", key)
	}
	return nil
}

func (v hookEnvelopeValidator) requiredNullableString(key string) error {
	raw, present := v.object[key]
	if !present {
		return fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	_, err := v.requiredString(key, false)
	return err
}

func (v hookEnvelopeValidator) optionalStringOrNull(key string) error {
	raw, present := v.object[key]
	if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	_, err := v.requiredString(key, false)
	return err
}

func (v hookEnvelopeValidator) optionalArray(key string) error {
	raw, present := v.object[key]
	if !present {
		return nil
	}
	var value []json.RawMessage
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return fmt.Errorf("%s must be a JSON array", key)
	}
	return nil
}

func (v hookEnvelopeValidator) optionalNonnegativeNumber(key string) error {
	raw, present := v.object[key]
	if !present {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if decoder.Decode(&decoded) != nil {
		return fmt.Errorf("%s must be a number", key)
	}
	value, ok := decoded.(json.Number)
	if !ok {
		return fmt.Errorf("%s must be a number", key)
	}
	number, err := value.Float64()
	if err != nil || number < 0 {
		return fmt.Errorf("%s must be a non-negative number", key)
	}
	return nil
}

func (v hookEnvelopeValidator) optionalEffort() error {
	raw, present := v.object["effort"]
	if !present {
		return nil
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return errors.New("effort must be a JSON object")
	}
	return (hookEnvelopeValidator{object: value}).requiredEnum("level", "low", "medium", "high", "xhigh", "max")
}

var codexPermissionModes = []string{"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"}
var claudePermissionModes = []string{"default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"}

func validateCodexHook(v hookEnvelopeValidator, event string) error {
	if err := v.requiredNullableString("transcript_path"); err != nil {
		return err
	}
	for _, key := range []string{"cwd", "model"} {
		if _, err := v.requiredString(key, false); err != nil {
			return err
		}
	}
	for _, key := range []string{"agent_id", "agent_type"} {
		if err := v.optionalString(key); err != nil {
			return err
		}
	}
	requireTool := func(response bool) error {
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		for _, key := range []string{"tool_name", "tool_use_id", "turn_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		if err := v.requiredAny("tool_input"); err != nil {
			return err
		}
		if response {
			return v.requiredAny("tool_response")
		}
		return nil
	}
	switch event {
	case "PermissionRequest":
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		for _, key := range []string{"tool_name", "turn_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		return v.requiredAny("tool_input")
	case "PostCompact", "PreCompact":
		if err := v.requiredEnum("trigger", "manual", "auto"); err != nil {
			return err
		}
		_, err := v.requiredString("turn_id", false)
		return err
	case "PostToolUse":
		return requireTool(true)
	case "PreToolUse":
		return requireTool(false)
	case "SessionStart":
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		return v.requiredEnum("source", "startup", "resume", "clear", "compact")
	case "Stop":
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		if err := v.requiredBool("stop_hook_active"); err != nil {
			return err
		}
		if err := v.requiredNullableString("last_assistant_message"); err != nil {
			return err
		}
		_, err := v.requiredString("turn_id", false)
		return err
	case "SubagentStart":
		for _, key := range []string{"agent_id", "agent_type", "turn_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		return v.requiredEnum("permission_mode", codexPermissionModes...)
	case "SubagentStop":
		for _, key := range []string{"agent_id", "agent_type", "turn_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		if err := v.requiredNullableString("agent_transcript_path"); err != nil {
			return err
		}
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		if err := v.requiredBool("stop_hook_active"); err != nil {
			return err
		}
		return v.requiredNullableString("last_assistant_message")
	case "UserPromptSubmit":
		if err := v.requiredEnum("permission_mode", codexPermissionModes...); err != nil {
			return err
		}
		for _, key := range []string{"prompt", "turn_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("hook_event_name %q is not supported for codex 0.144.3", event)
	}
}

func validateClaudeHook(v hookEnvelopeValidator, event string) error {
	for _, key := range []string{"transcript_path", "cwd"} {
		if _, err := v.requiredString(key, false); err != nil {
			return err
		}
	}
	for _, key := range []string{"prompt_id", "agent_id", "agent_type"} {
		if err := v.optionalString(key); err != nil {
			return err
		}
	}
	if err := v.optionalEnum("permission_mode", claudePermissionModes...); err != nil {
		return err
	}
	if err := v.optionalEffort(); err != nil {
		return err
	}
	requirePermission := func() error {
		return v.requiredEnum("permission_mode", claudePermissionModes...)
	}
	switch event {
	case "PreCompact":
		if err := v.requiredEnum("trigger", "manual", "auto"); err != nil {
			return err
		}
		return v.requiredNullableString("custom_instructions")
	case "PostCompact":
		if err := v.requiredEnum("trigger", "manual", "auto"); err != nil {
			return err
		}
		_, err := v.requiredString("compact_summary", false)
		return err
	case "SessionStart":
		if err := v.requiredEnum("source", "startup", "resume", "clear", "compact", "fork"); err != nil {
			return err
		}
		for _, key := range []string{"model", "session_title"} {
			if err := v.optionalString(key); err != nil {
				return err
			}
		}
		return nil
	case "SessionEnd":
		return v.requiredEnum("reason", "clear", "resume", "logout", "prompt_input_exit", "other", "bypass_permissions_disabled")
	case "Stop":
		if err := requirePermission(); err != nil {
			return err
		}
		if err := v.requiredBool("stop_hook_active"); err != nil {
			return err
		}
		if err := v.optionalStringOrNull("last_assistant_message"); err != nil {
			return err
		}
		if err := v.optionalArray("background_tasks"); err != nil {
			return err
		}
		return v.optionalArray("session_crons")
	case "PreToolUse", "PostToolUse":
		if err := requirePermission(); err != nil {
			return err
		}
		for _, key := range []string{"tool_name", "tool_use_id"} {
			if _, err := v.requiredString(key, false); err != nil {
				return err
			}
		}
		if err := v.requiredObject("tool_input"); err != nil {
			return err
		}
		if event == "PostToolUse" {
			if err := v.requiredAny("tool_response"); err != nil {
				return err
			}
			return v.optionalNonnegativeNumber("duration_ms")
		}
		return nil
	case "UserPromptSubmit":
		if err := requirePermission(); err != nil {
			return err
		}
		if _, err := v.requiredString("prompt", false); err != nil {
			return err
		}
		return v.optionalString("session_title")
	default:
		return fmt.Errorf("hook_event_name %q is not supported for claude 2.1.227", event)
	}
}

// loadHookConfigAndDB deliberately ignores repository configuration. A
// globally installed hook runs with the provider's repository cwd, which is
// not a trusted authority for selecting where private capture data is stored.
func loadHookConfigAndDB() (*config.Config, *storage.DB, error) {
	cfg, err := config.LoadUser()
	if err != nil {
		return nil, nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, nil, err
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		return nil, nil, err
	}
	return cfg, db, nil
}

func readHookObject(r io.Reader) (json.RawMessage, error) {
	if r == nil {
		return nil, errors.New("stdin is unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxHookPayloadBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read stdin: %w", err)
	}
	if int64(len(raw)) > maxHookPayloadBytes {
		return nil, fmt.Errorf("stdin JSON exceeds %d bytes", maxHookPayloadBytes)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errors.New("stdin JSON is empty")
	}
	if !utf8.Valid(raw) {
		return nil, errors.New("stdin JSON is not valid UTF-8")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, fmt.Errorf("stdin must contain exactly one JSON object: %w", err)
	}
	if object == nil {
		return nil, errors.New("stdin must contain exactly one JSON object")
	}
	return json.RawMessage(raw), nil
}
