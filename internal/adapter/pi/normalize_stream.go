package pi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// nativeTranscriptMaxLine is deliberately large enough for provider-emitted
// message and tool bodies while still placing a hard bound on one JSONL
// record. Scanner reports ErrTooLong when the bound is exceeded, and the
// whole transcript normalization fails without returning a partial prefix.
const nativeTranscriptMaxLine = 16 * 1024 * 1024

// NormalizeTranscript parses one native Pi JSONL transcript. Unlike Normalize,
// which accepts the installed extension's hfg.pi.event.v1 envelope, this method
// consumes Pi's durable session format whose first record is a session head.
//
// Every native record emits at least one canonical event. Assistant records
// additionally emit one tool.started event for each toolCall content item, and
// content variants without a canonical mapping are retained as log.observed.
// Source records/items are embedded as canonical JSON in the event payload so
// provider additions are not silently lost. Event sequences are global to the
// transcript and event IDs are a pure function of the provider, native session,
// sequence, observed time, and canonical source hash.
func (p *Pi) NormalizeTranscript(ctx context.Context, r io.Reader) ([]protocol.Event, error) {
	if r == nil {
		return nil, errors.New("pi normalize transcript: nil reader")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	events, err := p.normalizeTranscript(ctx, &nativeContextReader{ctx: ctx, reader: r})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	return events, err
}

// normalizeTranscript owns the reader loop. nativeContextReader checks the
// context before and after every underlying Read without taking ownership of
// or asynchronously retaining the caller's reader. As with all io.Reader APIs,
// a reader that can block indefinitely must itself provide an unblock/close
// mechanism; once Read returns, cancellation is propagated fail-closed.
func (p *Pi) normalizeTranscript(ctx context.Context, r io.Reader) ([]protocol.Event, error) {

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), nativeTranscriptMaxLine)
	state := &nativeTranscriptState{}
	lineNo := 0

	for scanner.Scan() {
		lineNo++
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("pi normalize transcript: line %d: invalid UTF-8", lineNo)
		}

		if !json.Valid(line) {
			var malformed any
			err := json.Unmarshal(line, &malformed)
			return nil, fmt.Errorf("pi normalize transcript: line %d: %w", lineNo, err)
		}
		if err := rejectDuplicateJSONKeys(line); err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: %w", lineNo, err)
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(line, &record); err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: record is not a JSON object", lineNo)
		}
		if record == nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: record is not a JSON object", lineNo)
		}
		canonicalRecord, err := content.CanonicalJSON(record)
		if err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: canonicalize record: %w", lineNo, err)
		}
		recordType, _ := nativeString(record["type"])
		occurredAt, hasTimestamp, err := nativeRecordTimestamp(record)
		if err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: %w", lineNo, err)
		}

		isHeadRecord := !state.headSeen
		if isHeadRecord {
			if recordType != "session" {
				return nil, fmt.Errorf("pi normalize transcript: line %d: first record must be session, got %q", lineNo, nativeKind(recordType))
			}
			nativeID, ok := nativeString(record["id"])
			if !ok || strings.TrimSpace(nativeID) == "" {
				return nil, fmt.Errorf("pi normalize transcript: line %d: session id must be a non-empty JSON string", lineNo)
			}
			if !hasTimestamp {
				return nil, fmt.Errorf("pi normalize transcript: line %d: session timestamp is required", lineNo)
			}
			state.headSeen = true
			state.nativeID = nativeID
			state.headAt = occurredAt
		}

		if err := state.validateSessionIdentity(recordType, record, isHeadRecord); err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: %w", lineNo, err)
		}
		emitted, err := state.normalizeRecord(ctx, recordType, record, canonicalRecord, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("pi normalize transcript: line %d: %w", lineNo, err)
		}
		state.events = append(state.events, emitted...)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("pi normalize transcript: read: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !state.headSeen {
		return nil, errors.New("pi normalize transcript: no records: the stream must begin with a session record")
	}
	return state.events, nil
}

type nativeTranscriptState struct {
	headSeen bool
	nativeID string
	headAt   time.Time
	model    string
	sequence int64
	events   []protocol.Event
}

// validateSessionIdentity rejects every second session head (with a distinct
// mismatch error when it names another native session) and rejects explicit
// top-level session identity fields that disagree with the head. Record
// id/parentId are Pi record graph IDs, so only a session record's id is
// interpreted as the native session identity.
func (s *nativeTranscriptState) validateSessionIdentity(recordType string, record map[string]json.RawMessage, isHeadRecord bool) error {
	if recordType == "session" {
		id, ok := nativeString(record["id"])
		if !ok || strings.TrimSpace(id) == "" {
			return errors.New("session id must be a non-empty JSON string")
		}
		if id != s.nativeID {
			return fmt.Errorf("inconsistent native session id %q (head is %q)", id, s.nativeID)
		}
		if !isHeadRecord {
			return fmt.Errorf("duplicate session head for native session %q", id)
		}
	}
	for _, field := range []string{"sessionId", "sessionID", "session_id"} {
		raw, present := record[field]
		if !present {
			continue
		}
		id, ok := nativeString(raw)
		if !ok || strings.TrimSpace(id) == "" {
			return fmt.Errorf("field %s must be a non-empty JSON string", field)
		}
		if id != s.nativeID {
			return fmt.Errorf("field %s identifies native session %q (head is %q)", field, id, s.nativeID)
		}
	}
	return nil
}

func (s *nativeTranscriptState) normalizeRecord(
	ctx context.Context,
	recordType string,
	record map[string]json.RawMessage,
	canonicalRecord []byte,
	at time.Time,
) ([]protocol.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sourceKind := "transcript:" + nativeKind(recordType)
	extras := nativeRecordExtras(record)

	switch recordType {
	case "session":
		if parent, present, err := nativeOptionalNonEmptyString(record, "parentSession"); err != nil {
			return nil, err
		} else if present {
			extras["source"] = "fork"
			extras["parent_session_id"] = parent
		}
		ev, err := s.event(protocol.EventSessionStarted, at, sourceKind, canonicalRecord, canonicalRecord, s.model, extras)
		return oneNativeEvent(ev, err)

	case "model_change":
		if model, ok := nativeString(record["modelId"]); ok {
			s.model = model
		}
		ev, err := s.event(protocol.EventLogObserved, at, sourceKind, canonicalRecord, canonicalRecord, s.model, extras)
		return oneNativeEvent(ev, err)

	case "message":
		return s.normalizeMessage(ctx, record, canonicalRecord, at, sourceKind, extras)

	default:
		ev, err := s.event(protocol.EventLogObserved, at, sourceKind, canonicalRecord, canonicalRecord, s.model, extras)
		return oneNativeEvent(ev, err)
	}
}

func (s *nativeTranscriptState) normalizeMessage(
	ctx context.Context,
	record map[string]json.RawMessage,
	canonicalRecord []byte,
	at time.Time,
	sourceKind string,
	extras map[string]any,
) ([]protocol.Event, error) {
	var message map[string]json.RawMessage
	if raw := record["message"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &message); err != nil || message == nil {
			// A structurally unfamiliar but valid message field is evidence, not
			// a reason to discard the record. The canonical source remains intact.
			ev, buildErr := s.event(protocol.EventLogObserved, at, sourceKind+":unknown-message", canonicalRecord, canonicalRecord, s.model, extras)
			return oneNativeEvent(ev, buildErr)
		}
	}
	role, _ := nativeString(message["role"])
	roleSource := sourceKind + ":" + nativeKind(role)
	if model, ok := nativeString(message["model"]); ok && role == "assistant" {
		s.model = model
	}
	if raw := message["content"]; len(raw) > 0 {
		extras["content"] = json.RawMessage(raw)
	}
	if raw := message["toolCallId"]; len(raw) > 0 {
		extras["tool_call_id"] = json.RawMessage(raw)
	}
	if raw := message["toolName"]; len(raw) > 0 {
		extras["tool"] = json.RawMessage(raw)
	}

	var kind protocol.EventKind
	switch role {
	case "user":
		kind = protocol.EventPromptSubmitted
	case "assistant":
		kind = protocol.EventAssistantCompleted
	case "toolResult":
		isError, err := nativeOptionalBool(message, "isError")
		if err != nil {
			return nil, err
		}
		kind = protocol.EventToolCompleted
		if isError {
			kind = protocol.EventToolFailed
		}
		extras["is_error"] = isError
	case "bashExecution":
		kind = protocol.EventCommandCompleted
		for sourceField, canonicalField := range map[string]string{
			"command":  "command",
			"output":   "output",
			"exitCode": "exit_code",
		} {
			if raw := message[sourceField]; len(raw) > 0 {
				extras[canonicalField] = json.RawMessage(raw)
			}
		}
	default:
		kind = protocol.EventLogObserved
	}

	base, err := s.event(kind, at, roleSource, canonicalRecord, canonicalRecord, s.model, extras)
	if err != nil {
		return nil, err
	}
	out := []protocol.Event{base}

	contentItems, isArray := nativeContentItems(message["content"])
	if !isArray {
		return out, nil
	}
	for itemIndex, itemRaw := range contentItems {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		canonicalItem, err := canonicalNativeRaw(itemRaw)
		if err != nil {
			return nil, fmt.Errorf("message content item %d: %w", itemIndex, err)
		}
		var item map[string]json.RawMessage
		_ = json.Unmarshal(itemRaw, &item)
		itemType, _ := nativeString(item["type"])

		if role == "assistant" && itemType == "toolCall" {
			itemExtras := map[string]any{
				"content_index": itemIndex,
			}
			if raw := item["id"]; len(raw) > 0 {
				itemExtras["tool_call_id"] = json.RawMessage(raw)
			}
			if raw := item["name"]; len(raw) > 0 {
				itemExtras["tool"] = json.RawMessage(raw)
			}
			if raw := item["arguments"]; len(raw) > 0 {
				itemExtras["input"] = json.RawMessage(raw)
			}
			tool, err := s.event(
				protocol.EventToolStarted,
				at,
				roleSource+":content:toolCall",
				canonicalItem,
				bytes.Join([][]byte{canonicalRecord, canonicalItem}, []byte("\n")),
				s.model,
				itemExtras,
			)
			if err != nil {
				return nil, err
			}
			out = append(out, tool)
			continue
		}

		// Text is already represented by prompt.submitted or
		// assistant.completed/tool.completed. Thinking and every unknown item
		// type have no narrower canonical mapping and therefore get their own
		// log event instead of disappearing inside a message aggregate.
		if itemType == "text" {
			continue
		}
		itemExtras := map[string]any{"content_index": itemIndex}
		logEvent, err := s.event(
			protocol.EventLogObserved,
			at,
			roleSource+":content:"+nativeKind(itemType),
			canonicalItem,
			bytes.Join([][]byte{canonicalRecord, canonicalItem}, []byte("\n")),
			s.model,
			itemExtras,
		)
		if err != nil {
			return nil, err
		}
		out = append(out, logEvent)
	}
	return out, nil
}

func (s *nativeTranscriptState) event(
	kind protocol.EventKind,
	at time.Time,
	sourceKind string,
	canonicalSource []byte,
	idSource []byte,
	model string,
	extras map[string]any,
) (protocol.Event, error) {
	s.sequence++
	payload := make(map[string]any, len(extras)+2)
	payload["source_kind"] = sourceKind
	payload["source_record"] = json.RawMessage(canonicalSource)
	for key, value := range extras {
		payload[key] = value
	}
	payloadJSON, err := content.CanonicalJSON(payload)
	if err != nil {
		return protocol.Event{}, fmt.Errorf("canonicalize payload: %w", err)
	}
	contentHash := content.HashBytes(payloadJSON)
	sourceHash := content.HashBytes(idSource)
	return protocol.Event{
		SchemaVersion:   protocol.SchemaVersionEvent,
		EventID:         deriveNativeTranscriptEventID(s.nativeID, s.sequence, at, sourceHash, contentHash),
		Sequence:        s.sequence,
		OccurredAt:      at,
		ObservedAt:      at,
		NativeSessionID: s.nativeID,
		Provider:        protocol.ProviderPi,
		Agent:           protocol.ProviderPi,
		Model:           model,
		Kind:            kind,
		Provenance:      protocol.ProvenanceObserved,
		Payload:         payloadJSON,
		ContentHash:     contentHash,
	}, nil
}

func deriveNativeTranscriptEventID(nativeSessionID string, sequence int64, occurredAt time.Time, sourceHash, contentHash string) string {
	ms := int64(0)
	if !occurredAt.IsZero() {
		ms = occurredAt.UnixMilli()
	}
	if ms < 0 {
		ms = 0
	}
	key := strings.Join([]string{
		protocol.ProviderPi,
		"native-transcript",
		nativeSessionID,
		strconv.FormatInt(sequence, 10),
		strconv.FormatInt(ms, 10),
		sourceHash,
		contentHash,
	}, "|")
	return ids.EventDeterministic(key, uint64(ms))
}

func nativeRecordTimestamp(record map[string]json.RawMessage) (time.Time, bool, error) {
	raw, present := record["timestamp"]
	if !present {
		return time.Time{}, false, nil
	}
	value, ok := nativeString(raw)
	if !ok || strings.TrimSpace(value) == "" {
		return time.Time{}, true, errors.New("timestamp must be a non-empty RFC3339 JSON string")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, true, fmt.Errorf("invalid timestamp %q: %w", value, err)
	}
	return parsed.UTC(), true, nil
}

func nativeRecordExtras(record map[string]json.RawMessage) map[string]any {
	extras := make(map[string]any, 2)
	if raw := record["id"]; len(raw) > 0 {
		extras["record_id"] = json.RawMessage(raw)
	}
	if raw := record["parentId"]; len(raw) > 0 {
		extras["parent_record_id"] = json.RawMessage(raw)
	}
	return extras
}

func nativeOptionalNonEmptyString(record map[string]json.RawMessage, field string) (string, bool, error) {
	raw, present := record[field]
	if !present {
		return "", false, nil
	}
	value, ok := nativeString(raw)
	if !ok || strings.TrimSpace(value) == "" {
		return "", true, fmt.Errorf("field %s must be a non-empty JSON string", field)
	}
	return value, true, nil
}

func nativeOptionalBool(record map[string]json.RawMessage, field string) (bool, error) {
	raw, present := record[field]
	if !present {
		return false, nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("field %s must be a JSON boolean", field)
	}
	return value, nil
}

func nativeString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func nativeContentItems(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	return items, true
}

func canonicalNativeRaw(raw json.RawMessage) ([]byte, error) {
	return content.CanonicalJSON(json.RawMessage(raw))
}

type nativeContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *nativeContextReader) Read(dst []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(dst)
	if ctxErr := r.ctx.Err(); ctxErr != nil {
		return 0, ctxErr
	}
	return n, err
}

// rejectDuplicateJSONKeys walks the complete JSON value with Decoder.Token
// and rejects duplicate object members at any nesting depth. Unmarshaling into
// maps would otherwise keep only the final value and silently discard native
// evidence before the canonical source hash is derived.
func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := consumeUniqueJSONValue(decoder, "$"); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return err
		}
		return fmt.Errorf("unexpected trailing JSON token %v", token)
	}
	return nil
}

func consumeUniqueJSONValue(decoder *json.Decoder, path string) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("object key at %s is not a string", path)
			}
			if seen[key] {
				return fmt.Errorf("duplicate JSON key %q at %s", key, path)
			}
			seen[key] = true
			if err := consumeUniqueJSONValue(decoder, path+"."+key); err != nil {
				return err
			}
		}
		_, err = decoder.Token() // closing }
		return err
	case '[':
		index := 0
		for decoder.More() {
			if err := consumeUniqueJSONValue(decoder, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
			index++
		}
		_, err = decoder.Token() // closing ]
		return err
	default:
		return fmt.Errorf("unexpected JSON delimiter %q at %s", delim, path)
	}
}

func nativeKind(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}

func oneNativeEvent(event protocol.Event, err error) ([]protocol.Event, error) {
	if err != nil {
		return nil, err
	}
	return []protocol.Event{event}, nil
}
