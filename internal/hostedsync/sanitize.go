package hostedsync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
)

type redactionStats struct {
	Events         int `json:"events"`
	Clean          int `json:"clean"`
	Redacted       int `json:"redacted"`
	FieldsRedacted int `json:"fields_redacted"`
}

func (s *redactionStats) add(other redactionStats) {
	s.Events += other.Events
	s.Clean += other.Clean
	s.Redacted += other.Redacted
	s.FieldsRedacted += other.FieldsRedacted
}

// sanitizeEvent deep-copies and redacts an event for the hosted boundary. It
// never mutates the append-only local event. Payloads receive the complete
// fail-closed pipeline; free-form metadata and forward-compatible unknown
// fields are covered as well so those preservation surfaces cannot become a
// redaction bypass.
func sanitizeEvent(source *protocol.Event, engine *redact.Engine) (*protocol.Event, redactionStats, error) {
	if source == nil {
		return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): nil event")
	}
	raw, err := json.Marshal(source)
	if err != nil {
		return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): copy event: %w", err)
	}
	var out protocol.Event
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): copy event: %w", err)
	}
	if out.Redaction != nil {
		status := strings.ToLower(out.Redaction.Status)
		if status == redact.StatusFailed || status == "redaction_failed" {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): event is already marked failed")
		}
		if status != "" && status != redact.StatusClean && status != redact.StatusRedacted {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): event has unknown redaction status")
		}
	}

	result, err := engine.RedactEvent(&out)
	if err != nil || result.Status == redact.StatusFailed {
		if err == nil {
			err = fmt.Errorf("pipeline returned failed status")
		}
		return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): %w", err)
	}
	fields := append([]string(nil), result.FieldsRemoved...)
	if out.Redaction != nil {
		fields = append(fields, out.Redaction.FieldsRemoved...)
	}

	redactMetadata := func(name string, value *string, entropy bool) {
		if value == nil || *value == "" {
			return
		}
		var next string
		var changed bool
		if entropy {
			next, changed = engine.RedactValue(*value)
		} else {
			next, changed = engine.RedactKnownPatterns(*value)
		}
		if changed {
			*value = next
			fields = append(fields, name)
		}
	}
	redactMetadata("native_session_id", &out.NativeSessionID, false)
	redactMetadata("provider", &out.Provider, false)
	redactMetadata("agent", &out.Agent, false)
	redactMetadata("model", &out.Model, false)
	for i := range out.ParentEventIDs {
		if next, changed := engine.RedactKnownPatterns(out.ParentEventIDs[i]); changed {
			out.ParentEventIDs[i] = next
			fields = append(fields, "parent_event_ids")
		}
	}
	if out.Git != nil {
		remote, changed := redactRepositoryRemote(out.Git.Remote, engine)
		if changed {
			out.Git.Remote = remote
			fields = append(fields, "git.remote")
		}
		redactMetadata("git.branch", &out.Git.Branch, false)
		redactMetadata("git.head", &out.Git.Head, false)
	}
	if len(out.Payload) > 0 {
		// Canonicalize even a clean payload. Retaining the original bytes when
		// JSON contained duplicate keys could otherwise transmit a shadowed
		// earlier value that neither Go nor the hosted JSON parser considers
		// semantically present (and therefore neither would redact).
		var payload any
		dec := json.NewDecoder(bytes.NewReader(out.Payload))
		dec.UseNumber()
		if err := dec.Decode(&payload); err != nil {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): canonicalize payload: %w", err)
		}
		if _, ok := payload.(map[string]any); !ok {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): payload must be a JSON object")
		}
		next, err := content.CanonicalJSON(payload)
		if err != nil {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): canonicalize payload: %w", err)
		}
		out.Payload = next
	}

	for key, value := range out.Unknown {
		var decoded any
		dec := json.NewDecoder(bytes.NewReader(value))
		dec.UseNumber()
		if err := dec.Decode(&decoded); err != nil {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): unknown field %q is invalid JSON", key)
		}
		redactUnknown(engine, key, &decoded, &fields)
		// As with payload, always canonicalize so duplicate-key raw bytes can
		// never bypass the semantic redaction pass.
		next, err := content.CanonicalJSON(decoded)
		if err != nil {
			return nil, redactionStats{}, fmt.Errorf("redaction failed (fail-closed): unknown field %q: %w", key, err)
		}
		out.Unknown[key] = next
	}

	fields = sortedUnique(fields)
	status := redact.StatusClean
	if len(fields) > 0 || (out.Redaction != nil && out.Redaction.Status == redact.StatusRedacted) {
		status = redact.StatusRedacted
	}
	out.Redaction = &protocol.Redaction{
		Version:       redact.RedactionVersion,
		FieldsRemoved: fields,
		Status:        status,
	}
	if len(out.Payload) > 0 {
		out.ContentHash = content.HashBytes(out.Payload)
	}
	stats := redactionStats{Events: 1, FieldsRedacted: len(fields)}
	if status == redact.StatusRedacted {
		stats.Redacted = 1
	} else {
		stats.Clean = 1
	}
	return &out, stats, nil
}

func redactUnknown(engine *redact.Engine, key string, value *any, fields *[]string) bool {
	if engine.DeniedPath(key) {
		*value = redact.Mask
		*fields = append(*fields, key)
		return true
	}
	changed := false
	switch typed := (*value).(type) {
	case string:
		if next, ok := engine.RedactValue(typed); ok {
			*value = next
			*fields = append(*fields, key)
			changed = true
		}
	case map[string]any:
		for childKey, child := range typed {
			childValue := child
			if redactUnknown(engine, childKey, &childValue, fields) {
				typed[childKey] = childValue
				changed = true
			}
		}
	case []any:
		for i, child := range typed {
			childValue := child
			if redactUnknown(engine, key, &childValue, fields) {
				typed[i] = childValue
				changed = true
			}
		}
	}
	return changed
}

func redactRepositoryRemote(remote string, engine *redact.Engine) (string, bool) {
	if remote == "" {
		return "", false
	}
	out := remote
	u, err := url.Parse(out)
	lower := strings.ToLower(out)
	if err != nil && (strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")) && strings.Contains(out, "@") {
		return redact.Mask, true
	}
	changed := false
	if err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.User != nil {
		u.User = url.User(redact.Mask)
		out = strings.Replace(u.String(), url.User(redact.Mask).String(), redact.Mask, 1)
		changed = true
	}
	if next, ok := engine.RedactKnownPatterns(out); ok {
		out = next
		changed = true
	}
	return out, changed
}

func sortedUnique(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	sort.Strings(values)
	out := values[:0]
	for _, value := range values {
		if len(out) == 0 || out[len(out)-1] != value {
			out = append(out, value)
		}
	}
	return out
}
