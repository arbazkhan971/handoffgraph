package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// NormalizeTranscript parses one native Claude Code JSONL transcript into
// canonical hfg.event.v1 events. Native transcripts use the camelCase
// sessionId field, while print-mode stream-json uses session_id; this method
// accepts both and requires every explicit id in the file to identify the
// same native session. fallbackNativeID is used only when the transcript has
// no explicit session id (normally it is the transcript filename stem).
//
// Normalize still owns the per-record dialect mapping. This transcript layer
// supplies the stable native identity to records that omit it, then rewrites
// the record-local sequence numbers into one session-global sequence and
// derives event ids from that sequence. Consequently the same transcript
// always emits identical bytes and can be imported repeatedly without
// duplicate events. Missing record timestamps stay zero rather than being
// presented as observed; their deterministic ids use the epoch ULID bucket.
func (c *Claude) NormalizeTranscript(ctx context.Context, r io.Reader, fallbackNativeID string) ([]protocol.Event, error) {
	if r == nil {
		return nil, errors.New("claude normalize transcript: nil reader")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	type record struct {
		lineNo int
		view   map[string]json.RawMessage
	}
	var records []record
	idsSeen := map[string]bool{}

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("claude normalize transcript: line %d: invalid UTF-8", lineNo)
		}
		var view map[string]json.RawMessage
		if err := json.Unmarshal(line, &view); err != nil || view == nil {
			if err == nil {
				err = errors.New("record is not a JSON object")
			}
			return nil, fmt.Errorf("claude normalize transcript: line %d: %w", lineNo, err)
		}
		snake, _, err := transcriptStringField(view, "session_id")
		if err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: %w", lineNo, err)
		}
		camel, _, err := transcriptStringField(view, "sessionId")
		if err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: %w", lineNo, err)
		}
		if snake != "" && camel != "" && snake != camel {
			return nil, fmt.Errorf("claude normalize transcript: line %d: session_id %q conflicts with sessionId %q", lineNo, snake, camel)
		}
		if timestamp, present, err := transcriptStringField(view, "timestamp"); err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: %w", lineNo, err)
		} else if present {
			if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
				return nil, fmt.Errorf("claude normalize transcript: line %d: timestamp is not valid RFC3339: %w", lineNo, err)
			}
		}
		if snake != "" {
			idsSeen[snake] = true
		} else if camel != "" {
			idsSeen[camel] = true
		}
		records = append(records, record{
			lineNo: lineNo,
			view:   view,
		})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("claude normalize transcript: read: %w", err)
	}
	if len(records) == 0 {
		return nil, errors.New("claude normalize transcript: no records")
	}
	if len(idsSeen) > 1 {
		ids := make([]string, 0, len(idsSeen))
		for id := range idsSeen {
			ids = append(ids, id)
		}
		// The exact order of conflicting ids must not depend on map iteration.
		sort.Strings(ids)
		return nil, fmt.Errorf("claude normalize transcript: mixed native sessions: %s", strings.Join(ids, ", "))
	}

	nativeID := strings.TrimSpace(fallbackNativeID)
	for id := range idsSeen {
		nativeID = id // one entry at most; explicit transcript evidence wins
	}
	if nativeID == "" {
		return nil, errors.New("claude normalize transcript: native session id is required (transcript field or filename fallback)")
	}

	out := make([]protocol.Event, 0, len(records))
	var sequence int64
	for _, rec := range records {
		view := make(map[string]json.RawMessage, len(rec.view)+1)
		for key, value := range rec.view {
			view[key] = value
		}
		if payloadView(view).str("session_id") == "" {
			encodedID, _ := json.Marshal(nativeID)
			view["session_id"] = encodedID
		}
		normalizedRaw, err := json.Marshal(view)
		if err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: encode normalized record: %w", rec.lineNo, err)
		}
		canonicalRecord, err := content.CanonicalJSON(view)
		if err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: canonicalize native record: %w", rec.lineNo, err)
		}
		nativeHash := content.HashBytes(canonicalRecord)
		events, err := c.Normalize(ctx, normalizedRaw)
		if err != nil {
			return nil, fmt.Errorf("claude normalize transcript: line %d: %w", rec.lineNo, err)
		}
		for i := range events {
			sequence++
			events[i].Sequence = sequence
			events[i].NativeSessionID = nativeID
			// Include the canonical native record hash in the id key. Unknown
			// top-level evidence lives in Event.Unknown rather than Payload, so
			// Payload's ContentHash alone would not distinguish two changed
			// unknown records at the same position and timestamp.
			events[i].EventID = deriveEventID(nativeID, sequence, events[i].OccurredAt, events[i].ContentHash+"|"+nativeHash)
			out = append(out, events[i])
		}
	}
	return out, nil
}

// transcriptStringField distinguishes an absent field from an explicitly
// malformed one. payloadView.str intentionally tolerates provider shape drift
// for individual hook payloads, but a native transcript import cannot safely
// overwrite or consume a present non-string identity/timestamp field.
func transcriptStringField(view map[string]json.RawMessage, field string) (string, bool, error) {
	raw, present := view[field]
	if !present {
		return "", false, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, fmt.Errorf("field %s must be a non-empty JSON string", field)
	}
	if strings.TrimSpace(value) == "" {
		return "", true, fmt.Errorf("field %s must be a non-empty JSON string", field)
	}
	return value, true, nil
}
