package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// rolloutMaxText caps inline text fields; larger bodies belong in the
// object store as references, never inlined into events (same convention
// as the claude lane).
const rolloutMaxText = 4096

// NormalizeStream parses a native Codex rollout transcript (JSONL, one
// record per line) into canonical hfg.event.v1 events:
//
//	session_meta head line        → session.started (native id, model)
//	event_msg{user_message}       → prompt.submitted
//	event_msg{agent_message}      → assistant.completed
//	response_item{function_call}  → tool.started
//	response_item{function_call_output} → tool.completed
//	response_item{exec_command}   → command.completed (exit_code preserved)
//	compacted_summary             → session.compacted
//	turn_context                  → log.observed (model folds forward)
//	anything else                 → log.observed (source kind preserved)
//
// Nothing is dropped silently and no provenance is upgraded: every record
// maps to exactly one event carrying Provider "codex" and Provenance
// OBSERVED, with unknown top-level fields preserved via Event.Unknown and
// unrecognized payload fields copied verbatim into the canonical payload.
//
// Event ids are deterministic — derived from (provider, native session id,
// sequence, occurred-at, content hash) — so normalizing the same transcript
// twice yields identical events and re-import is idempotent. Malformed
// lines fail closed with their line number. The first record must be a
// session_meta carrying payload.id and a timestamp: without them the
// session cannot be identified deterministically and normalizing would
// risk cross-session id collisions, so it is refused rather than guessed
// at. Records after the head that lack a timestamp fall back to the head
// timestamp (a content-derived, therefore deterministic, choice).
func (c *Codex) NormalizeStream(ctx context.Context, r io.Reader) ([]protocol.Event, error) {
	if r == nil {
		return nil, errors.New("codex normalize stream: nil reader")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	st := &streamState{}
	lineNo := 0
	for sc.Scan() {
		lineNo++
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue // blank lines are structural noise, not records
		}
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("codex normalize stream: line %d: invalid UTF-8", lineNo)
		}
		rec, err := decodeRolloutLine(line)
		if err != nil {
			return nil, fmt.Errorf("codex normalize stream: line %d: %w", lineNo, err)
		}
		ev, err := st.record(rec, line)
		if err != nil {
			return nil, fmt.Errorf("codex normalize stream: line %d: %w", lineNo, err)
		}
		st.events = append(st.events, *ev)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("codex normalize stream: read: %w", err)
	}
	if !st.headSeen {
		return nil, errors.New("codex normalize stream: no records: the stream must begin with a session_meta line")
	}
	return st.events, nil
}

// streamState carries the session-scoped facts established while walking a
// rollout transcript.
type streamState struct {
	headSeen    bool
	headEmitted bool
	nativeID    string
	model       string
	fallbackAt  time.Time
	seq         int64
	events      []protocol.Event
}

// record maps one decoded rollout record onto one canonical event.
func (s *streamState) record(rec rolloutLine, rawLine []byte) (*protocol.Event, error) {
	at := s.fallbackAt
	if rec.hasTS {
		at = rec.timestamp
	}

	if !s.headSeen {
		if rec.lineType != "session_meta" {
			return nil, fmt.Errorf("first record must be session_meta, got %q", orDash(rec.lineType))
		}
		id := rawStr(rec.payload["id"])
		if id == "" {
			return nil, errors.New("session_meta payload.id is required to identify the session")
		}
		if !rec.hasTS {
			return nil, errors.New("session_meta timestamp is required to derive deterministic event ids")
		}
		s.headSeen = true
		s.nativeID = id
		s.fallbackAt = at
		if m := rawStr(rec.payload["model"]); m != "" {
			s.model = m
		}
	}
	headRecord := rec.lineType == "session_meta" && !s.headEmitted
	s.headEmitted = s.headEmitted || headRecord

	var (
		kind     protocol.EventKind
		payload  = map[string]any{}
		consumed map[string]bool
	)
	switch {
	case headRecord:
		kind = protocol.EventSessionStarted
		consumed = map[string]bool{"id": true, "timestamp": true, "cwd": true, "originator": true, "cli_version": true, "model": true}
		for _, k := range []string{"cwd", "originator", "cli_version"} {
			if v := rawStr(rec.payload[k]); v != "" {
				payload[k] = v
			}
		}

	case rec.lineType == "event_msg" && rawStr(rec.payload["type"]) == "user_message":
		kind = protocol.EventPromptSubmitted
		consumed = map[string]bool{"type": true, "message": true}
		payload["message"] = truncateText(rawStr(rec.payload["message"]), rolloutMaxText)

	case rec.lineType == "event_msg" && rawStr(rec.payload["type"]) == "agent_message":
		kind = protocol.EventAssistantCompleted
		consumed = map[string]bool{"type": true, "message": true}
		payload["message"] = truncateText(rawStr(rec.payload["message"]), rolloutMaxText)

	case rec.lineType == "response_item" && rawStr(rec.payload["type"]) == "function_call":
		kind = protocol.EventToolStarted
		consumed = map[string]bool{"type": true, "name": true, "arguments": true}
		payload["tool"] = rawStr(rec.payload["name"])
		payload["input"] = rawOrNull(rec.payload["arguments"])

	case rec.lineType == "response_item" && rawStr(rec.payload["type"]) == "function_call_output":
		kind = protocol.EventToolCompleted
		consumed = map[string]bool{"type": true, "output": true}
		payload["output"] = truncateText(rawStr(rec.payload["output"]), rolloutMaxText)

	case rec.lineType == "response_item" && rawStr(rec.payload["type"]) == "exec_command":
		kind = protocol.EventCommandCompleted
		consumed = map[string]bool{"type": true, "command": true, "exit_code": true}
		payload["command"] = rawStr(rec.payload["command"])
		if raw := rec.payload["exit_code"]; len(raw) > 0 {
			payload["exit_code"] = json.RawMessage(raw)
		}

	case rec.lineType == "turn_context":
		// Turn context is observed metadata, not work output: it stays a
		// log event, but its model applies to every record that follows.
		kind = protocol.EventLogObserved
		consumed = map[string]bool{"type": true}
		if m := rawStr(rec.payload["model"]); m != "" {
			s.model = m
		}

	case rec.lineType == "compacted_summary":
		kind = protocol.EventSessionCompacted
		consumed = map[string]bool{"type": true, "summary": true, "token_count": true}
		if v := rawStr(rec.payload["summary"]); v != "" {
			payload["summary"] = truncateText(v, rolloutMaxText)
		}
		if raw := rec.payload["token_count"]; len(raw) > 0 {
			payload["token_count"] = json.RawMessage(raw)
		}

	default:
		// Unrecognized records are still evidence: keep them as logs with
		// the payload preserved verbatim, never dropped or guessed at.
		kind = protocol.EventLogObserved
	}

	src := "rollout:" + rec.lineType
	if pt := rawStr(rec.payload["type"]); pt != "" && !headRecord {
		src += ":" + pt
	}
	payload["source_kind"] = src
	for k, v := range rec.payload {
		if consumed[k] {
			continue
		}
		payload[k] = json.RawMessage(v)
	}

	s.seq++
	payloadJSON, err := content.CanonicalJSON(payload)
	if err != nil {
		return nil, fmt.Errorf("canonicalize payload: %w", err)
	}
	ev := &protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         deriveEventID(s.nativeID, s.seq, at, content.HashBytes(payloadJSON)),
		Sequence:        s.seq,
		OccurredAt:      at,
		ObservedAt:      at,
		NativeSessionID: s.nativeID,
		Provider:        protocol.ProviderCodex,
		Model:           s.model,
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         payloadJSON,
		ContentHash:     content.HashBytes(payloadJSON),
	}
	// Preserve unknown top-level fields so future rollout additions lose
	// no evidence (and round-trip through the event envelope untouched).
	var top map[string]json.RawMessage
	if json.Unmarshal(rawLine, &top) == nil {
		for k, v := range top {
			if k == "timestamp" || k == "type" || k == "payload" {
				continue
			}
			if ev.Unknown == nil {
				ev.Unknown = make(map[string]json.RawMessage)
			}
			ev.Unknown[k] = v
		}
	}
	return ev, nil
}

// rolloutLine is one decoded top-level record of a rollout transcript.
type rolloutLine struct {
	timestamp time.Time
	hasTS     bool
	lineType  string
	payload   map[string]json.RawMessage
}

// decodeRolloutLine validates and decodes one rollout record. The payload
// decodes as a generic view: shape drift between codex versions must never
// hard-fail on fields, only on structurally invalid JSON.
func decodeRolloutLine(data []byte) (rolloutLine, error) {
	var top struct {
		Timestamp string          `json:"timestamp"`
		Type      string          `json:"type"`
		Payload   json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(data, &top); err != nil {
		return rolloutLine{}, err
	}
	rec := rolloutLine{lineType: top.Type}
	if top.Timestamp != "" {
		ts, err := time.Parse(time.RFC3339Nano, top.Timestamp)
		if err != nil {
			return rolloutLine{}, fmt.Errorf("invalid timestamp %q: %w", top.Timestamp, err)
		}
		rec.timestamp, rec.hasTS = ts.UTC(), true
	}
	if len(top.Payload) > 0 && string(top.Payload) != "null" {
		if err := json.Unmarshal(top.Payload, &rec.payload); err != nil {
			return rolloutLine{}, fmt.Errorf("invalid payload: %w", err)
		}
	}
	if rec.payload == nil {
		rec.payload = map[string]json.RawMessage{}
	}
	return rec, nil
}

// rawStr decodes a JSON string field ("" when absent or not a string).
func rawStr(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// orDash renders s, or "<missing>" when empty, for error messages.
func orDash(s string) string {
	if s == "" {
		return "<missing>"
	}
	return s
}

// truncateText caps oversized text fields on a rune boundary so a cut
// never produces invalid UTF-8.
func truncateText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "…[truncated]"
}
