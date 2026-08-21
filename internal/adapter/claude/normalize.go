package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Normalize converts one provider-native Claude payload into canonical
// hfg.event.v1 events. Two input dialects are recognized:
//
//  1. Claude Code hook payloads (delivered as JSON on stdin to installed
//     hook commands), discriminated by a "hook_event_name" field:
//
//     SessionStart        → session.started (source "resume" → session.resumed)
//     UserPromptSubmit    → prompt.submitted
//     PreToolUse          → tool.started
//     PostToolUse         → tool.completed / tool.failed (response error)
//     PreCompact          → session.compacted (phase "pre")
//     PostCompact         → session.compacted (phase "post")
//     Stop                → session.ended
//     SessionEnd          → session.ended (tolerated newer event)
//     anything else       → log.observed (source kind preserved)
//
//  2. print-mode stream-json lines (claude -p --output-format stream-json),
//     discriminated by a "type" field:
//
//     {"type":"user", message.content string}                    → prompt.submitted
//     {"type":"user", content[].type tool_result}               → tool.completed / tool.failed
//     {"type":"user", content[].type text}                      → prompt.submitted
//     {"type":"assistant", content[].type text}                 → assistant.completed
//     {"type":"assistant", content[].type tool_use}             → tool.started
//     {"type":"system"}                                         → log.observed
//     {"type":"result"}                                         → session.ended
//     anything else                                             → log.observed
//
// Every emitted event carries Provider "claude" and Provenance OBSERVED —
// everything here was directly captured from Claude Code, never inferred.
// Nothing is dropped: native fields not consumed by the mapping are
// preserved verbatim in Event.Unknown.
//
// Normalize is a pure function of its input: the same bytes always produce
// the same events, including deterministic event IDs (see
// deterministic.go). Payloads that declare neither a session id nor a
// timestamp cannot be identified deterministically; their events get fresh
// random ids instead of risking cross-session collisions on re-import.
func (c *Claude) Normalize(ctx context.Context, raw json.RawMessage) ([]protocol.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("claude normalize: empty payload")
	}
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("claude normalize: payload is not valid UTF-8")
	}
	var view map[string]json.RawMessage
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, fmt.Errorf("claude normalize: payload is not a JSON object: %w", err)
	}
	if view == nil {
		return nil, fmt.Errorf("claude normalize: payload is not a JSON object")
	}

	base := baseFields{sessionID: payloadView(view).str("session_id")}
	if ts, ok := payloadView(view).time("timestamp"); ok {
		base.occurredAt = ts
	}

	var (
		kinds    []mappedEvent
		err      error
		isStream bool
	)
	if hookName := payloadView(view).str("hook_event_name"); hookName != "" {
		kinds, err = mapHookPayload(view, hookName)
	} else {
		isStream = true
		kinds, err = mapStreamLine(view)
	}
	if err != nil {
		return nil, err
	}

	consumed := consumedFields(kinds, isStream, payloadView(view))
	out := make([]protocol.Event, 0, len(kinds))
	for i, m := range kinds {
		ev, err := buildEvent(base, int64(i+1), m, raw, consumed)
		if err != nil {
			return nil, err
		}
		out = append(out, *ev)
	}
	return out, nil
}

// baseFields carries the fields shared by every event derived from one
// payload.
type baseFields struct {
	sessionID  string
	occurredAt time.Time
}

// mappedEvent is one canonical event to build from a payload: the target
// kind plus the mapped payload view.
type mappedEvent struct {
	kind    protocol.EventKind
	payload map[string]any
	model   string
}

// payloadView probes a decoded JSON object without hard-failing on shape
// drift.
type payloadView map[string]json.RawMessage

func (p payloadView) str(key string) string {
	if p == nil {
		return ""
	}
	var s string
	if err := json.Unmarshal(p[key], &s); err != nil {
		return ""
	}
	return s
}

func (p payloadView) bool(key string) (bool, bool) {
	if p == nil {
		return false, false
	}
	var b bool
	if err := json.Unmarshal(p[key], &b); err != nil {
		return false, false
	}
	return b, true
}

// time parses an RFC3339 timestamp field.
func (p payloadView) time(key string) (time.Time, bool) {
	s := p.str(key)
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

// raw returns the raw JSON of a field (nil when absent).
func (p payloadView) raw(key string) json.RawMessage {
	if p == nil {
		return nil
	}
	return p[key]
}

// mapHookPayload maps one Claude Code hook payload onto mapped events.
func mapHookPayload(view payloadView, hookName string) ([]mappedEvent, error) {
	src := "hook:" + hookName
	me := func(kind protocol.EventKind, extra map[string]any) mappedEvent {
		payload := map[string]any{"source_kind": src}
		for k, v := range extra {
			payload[k] = v
		}
		return mappedEvent{kind: kind, payload: payload}
	}

	switch hookName {
	case "SessionStart":
		source := view.str("source")
		kind := protocol.EventSessionStarted
		if source == "resume" {
			// An honest distinction: Claude Code tells us this session
			// continued an earlier one.
			kind = protocol.EventSessionResumed
		}
		extra := map[string]any{}
		if source != "" {
			extra["source"] = source
		}
		return []mappedEvent{me(kind, extra)}, nil

	case "UserPromptSubmit":
		return []mappedEvent{me(protocol.EventPromptSubmitted, map[string]any{
			"message": truncate(view.str("prompt"), maxInlineText),
		})}, nil

	case "PreToolUse":
		return []mappedEvent{me(protocol.EventToolStarted, map[string]any{
			"tool":  view.str("tool_name"),
			"input": rawOrNull(view.raw("tool_input")),
		})}, nil

	case "PostToolUse":
		kind := protocol.EventToolCompleted
		extra := map[string]any{
			"tool":     view.str("tool_name"),
			"input":    rawOrNull(view.raw("tool_input")),
			"response": rawOrNull(view.raw("tool_response")),
		}
		if failed, reason := toolResponseFailed(view.raw("tool_response")); failed {
			kind = protocol.EventToolFailed
			if reason != "" {
				extra["error"] = truncate(reason, maxInlineText)
			}
		}
		return []mappedEvent{me(kind, extra)}, nil

	case "PreCompact", "PostCompact":
		phase := "post"
		if hookName == "PreCompact" {
			phase = "pre"
		}
		extra := map[string]any{
			"phase": phase,
		}
		if trigger := view.str("trigger"); trigger != "" {
			extra["trigger"] = trigger
		}
		if ci := view.str("custom_instructions"); ci != "" {
			extra["custom_instructions"] = truncate(ci, maxInlineText)
		}
		return []mappedEvent{me(protocol.EventSessionCompacted, extra)}, nil

	case "Stop", "SessionEnd":
		extra := map[string]any{}
		if v, ok := view.bool("stop_hook_active"); ok {
			extra["stop_hook_active"] = v
		}
		if reason := view.str("reason"); reason != "" {
			extra["reason"] = truncate(reason, maxInlineText)
		}
		return []mappedEvent{me(protocol.EventSessionEnded, extra)}, nil

	default:
		// Unknown hook events are still evidence: keep them as logs with
		// the native name preserved, never dropped or guessed at.
		return []mappedEvent{me(protocol.EventLogObserved, nil)}, nil
	}
}

// toolResponseFailed inspects a PostToolUse tool_response value. Claude
// Code reports failures inconsistently across tool implementations: an
// "error" member, an is_error flag, or an "interrupted" flag. Any of those
// marks the tool call failed.
func toolResponseFailed(resp json.RawMessage) (bool, string) {
	if len(resp) == 0 || string(resp) == "null" {
		return false, ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(resp, &obj); err != nil || obj == nil {
		// A plain string response has no failure signal.
		return false, ""
	}
	v := payloadView(obj)
	if isErr, ok := v.bool("is_error"); ok && isErr {
		if msg := v.str("error"); msg != "" {
			return true, msg
		}
		return true, "is_error"
	}
	if msg := v.str("error"); msg != "" {
		return true, msg
	}
	if interrupted, ok := v.bool("interrupted"); ok && interrupted {
		return true, "interrupted"
	}
	return false, ""
}

// mapStreamLine maps one print-mode stream-json line onto mapped events.
// One line can expand to several events (a user message with multiple
// tool_result blocks; an assistant message with text plus tool_use blocks).
func mapStreamLine(view payloadView) ([]mappedEvent, error) {
	lineType := view.str("type")
	src := "stream:" + lineType
	me := func(kind protocol.EventKind, extra map[string]any) mappedEvent {
		payload := map[string]any{"source_kind": src}
		for k, v := range extra {
			payload[k] = v
		}
		return mappedEvent{kind: kind, payload: payload}
	}

	switch lineType {
	case "assistant":
		return mapAssistantMessage(view, src), nil
	case "user":
		return mapUserMessage(view, src), nil
	case "system":
		extra := map[string]any{}
		if sub := view.str("subtype"); sub != "" {
			extra["subtype"] = sub
		}
		if c := view.str("content"); c != "" {
			extra["message"] = truncate(c, maxInlineText)
		}
		return []mappedEvent{me(protocol.EventLogObserved, extra)}, nil
	case "result":
		// The terminal line of a print-mode run: the run is over.
		extra := map[string]any{}
		if sub := view.str("subtype"); sub != "" {
			extra["subtype"] = sub
		}
		if r := view.str("result"); r != "" {
			extra["result"] = truncate(r, maxInlineText)
		}
		if isErr, ok := view.bool("is_error"); ok {
			extra["is_error"] = isErr
		}
		return []mappedEvent{me(protocol.EventSessionEnded, extra)}, nil
	default:
		return []mappedEvent{me(protocol.EventLogObserved, nil)}, nil
	}
}

// decodeMessage decodes the nested "message" object of a stream line.
func decodeMessage(view payloadView) payloadView {
	raw := view.raw("message")
	if len(raw) == 0 {
		return nil
	}
	var m payloadView
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil
	}
	return m
}

// mapAssistantMessage maps {"type":"assistant","message":{...}}: each text
// content block becomes assistant.completed, each tool_use block
// tool.started (carrying tool_use_id for later correlation).
func mapAssistantMessage(view payloadView, src string) []mappedEvent {
	msg := decodeMessage(view)
	model := msg.str("model")
	var out []mappedEvent
	for _, block := range contentBlocks(msg) {
		switch block.str("type") {
		case "text":
			out = append(out, mappedEvent{
				kind:  protocol.EventAssistantCompleted,
				model: model,
				payload: map[string]any{
					"source_kind": src,
					"message":     truncate(block.str("text"), maxInlineText),
				},
			})
		case "tool_use":
			out = append(out, mappedEvent{
				kind:  protocol.EventToolStarted,
				model: model,
				payload: map[string]any{
					"source_kind": src,
					"tool":        block.str("name"),
					"tool_use_id": block.str("id"),
					"input":       rawOrNull(block.raw("input")),
				},
			})
		case "thinking":
			// Reasoning blocks are model context, not work evidence.
			continue
		}
	}
	return out
}

// mapUserMessage maps {"type":"user","message":{...}}: tool_result blocks
// become tool.completed/tool.failed (correlated by tool_use_id), plain text
// becomes prompt.submitted.
func mapUserMessage(view payloadView, src string) []mappedEvent {
	msg := decodeMessage(view)

	// A bare string content is a typed prompt.
	if s := msg.str("content"); s != "" && msg.raw("content") != nil {
		var asString string
		if err := json.Unmarshal(msg.raw("content"), &asString); err == nil {
			return []mappedEvent{{
				kind: protocol.EventPromptSubmitted,
				payload: map[string]any{
					"source_kind": src,
					"message":     truncate(asString, maxInlineText),
				},
			}}
		}
	}

	var out []mappedEvent
	for _, block := range contentBlocks(msg) {
		switch block.str("type") {
		case "tool_result":
			kind := protocol.EventToolCompleted
			extra := map[string]any{
				"source_kind": src,
				"tool_use_id": block.str("tool_use_id"),
				"output":      blockOutput(block),
			}
			if isErr, ok := block.bool("is_error"); ok && isErr {
				kind = protocol.EventToolFailed
				extra["is_error"] = true
			}
			out = append(out, mappedEvent{kind: kind, payload: extra})
		case "text":
			if block.str("text") != "" {
				out = append(out, mappedEvent{
					kind: protocol.EventPromptSubmitted,
					payload: map[string]any{
						"source_kind": src,
						"message":     truncate(block.str("text"), maxInlineText),
					},
				})
			}
		}
	}
	return out
}

// contentBlocks returns the message.content blocks as views. Content may be
// a plain string (handled by callers) or an array of typed blocks.
func contentBlocks(msg payloadView) []payloadView {
	raw := msg.raw("content")
	if len(raw) == 0 {
		return nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	blocks := make([]payloadView, 0, len(arr))
	for _, b := range arr {
		var v payloadView
		if err := json.Unmarshal(b, &v); err != nil || v == nil {
			continue // tolerate non-object blocks without dropping the line
		}
		blocks = append(blocks, v)
	}
	return blocks
}

// blockOutput renders a tool_result content value: strings are truncated
// inline; structured content is preserved as raw JSON.
func blockOutput(block payloadView) any {
	raw := block.raw("content")
	if len(raw) == 0 {
		return nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return truncate(s, maxInlineText)
	}
	return json.RawMessage(raw)
}

// consumedFields computes the set of top-level native field names consumed
// by the mapping, so buildEvent can preserve everything else in
// Event.Unknown without duplication.
func consumedFields(kinds []mappedEvent, isStream bool, view payloadView) map[string]bool {
	consumed := map[string]bool{
		"session_id": true,
		"timestamp":  true,
	}
	if isStream {
		consumed["type"] = true
		consumed["message"] = true
	} else {
		consumed["hook_event_name"] = true
		consumed["prompt"] = true
		consumed["tool_name"] = true
		consumed["tool_input"] = true
		consumed["tool_response"] = true
		consumed["source"] = true
		consumed["trigger"] = true
		consumed["custom_instructions"] = true
		consumed["stop_hook_active"] = true
		consumed["reason"] = true
	}
	// Stream extras consumed per type.
	if isStream {
		for k := range view {
			switch k {
			case "subtype", "content", "result", "is_error":
				consumed[k] = true
			}
		}
	}
	return consumed
}

// buildEvent materializes one mapped event. Sequence numbers are positions
// within this payload's expansion. Event IDs are deterministic when the
// payload identifies its session and time; otherwise fresh (see
// deterministic.go for the collision rationale).
func buildEvent(base baseFields, seq int64, m mappedEvent, raw json.RawMessage, consumed map[string]bool) (*protocol.Event, error) {
	ev := &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		Sequence:        seq,
		OccurredAt:      base.occurredAt,
		ObservedAt:      base.occurredAt,
		NativeSessionID: base.sessionID,
		Provider:        protocol.ProviderClaude,
		Model:           m.model,
		Kind:            m.kind,
		Provenance:      protocol.ProvenanceObserved,
	}

	payload, err := content.CanonicalJSON(m.payload)
	if err != nil {
		return nil, fmt.Errorf("claude normalize: canonicalize payload: %w", err)
	}
	ev.Payload = payload
	ev.ContentHash = content.HashBytes(payload)

	if base.sessionID != "" && !base.occurredAt.IsZero() {
		ev.EventID = deriveEventID(base.sessionID, seq, base.occurredAt, ev.ContentHash)
	} else {
		ev.EventID = ids.Event()
	}

	// Preserve unconsumed native fields so no evidence is lost.
	var rawView map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawView); err == nil {
		for k, v := range rawView {
			if !consumed[k] {
				if ev.Unknown == nil {
					ev.Unknown = make(map[string]json.RawMessage)
				}
				ev.Unknown[k] = v
			}
		}
	}
	return ev, nil
}

// maxInlineText caps inline text fields; large bodies belong in the object
// store as references, never inlined into events.
const maxInlineText = 4096

// rawOrNull passes through raw JSON (or JSON null) for payload fields that
// keep structured values.
func rawOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

// truncate caps oversized text fields on a rune boundary so a cut never
// produces invalid UTF-8.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}
