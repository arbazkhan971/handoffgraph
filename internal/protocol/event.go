package protocol

import (
	"encoding/json"
	"time"
)

// Event is the append-only canonical envelope (hfg.event.v1).
//
// Events are never mutated after append. Readers that encounter unknown
// fields must preserve them (see Unknown below), and normalizers must not
// silently repurpose an existing field.
type Event struct {
	SchemaVersion   string          `json:"schema_version"`
	EventID         string          `json:"event_id"`
	Sequence        int64           `json:"sequence,omitempty"`
	OccurredAt      time.Time       `json:"occurred_at"`
	ObservedAt      time.Time       `json:"observed_at"`
	WorkstreamID    string          `json:"workstream_id,omitempty"`
	SessionID       string          `json:"session_id,omitempty"`
	NativeSessionID string          `json:"native_session_id,omitempty"`
	Provider        string          `json:"provider,omitempty"`
	Agent           string          `json:"agent,omitempty"`
	Model           string          `json:"model,omitempty"`
	Kind            EventKind       `json:"kind"`
	ParentEventIDs  []string        `json:"parent_event_ids,omitempty"`
	RepositoryID    string          `json:"repository_id,omitempty"`
	Git             *GitState       `json:"git,omitempty"`
	Provenance      Provenance      `json:"provenance,omitempty"`
	Payload         json.RawMessage `json:"payload,omitempty"`
	Redaction       *Redaction      `json:"redaction,omitempty"`
	ContentHash     string          `json:"content_hash,omitempty"`

	// Unknown preserves fields not part of this schema version so a
	// future reader can forward them without data loss.
	Unknown map[string]json.RawMessage `json:"-"`
}

// GitState is the repository snapshot captured with an event, when known.
type GitState struct {
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	Dirty  bool   `json:"dirty,omitempty"`
	Remote string `json:"remote,omitempty"`
}

// Redaction records what the redaction pipeline did to an event payload.
type Redaction struct {
	Version       int      `json:"version"`
	FieldsRemoved []string `json:"fields_removed,omitempty"`
	Status        string   `json:"status,omitempty"` // clean | redacted | failed
}

// MarshalJSON implements deterministic (canonical) encoding and stashes
// unknown fields so they survive round-trips.
func (e Event) MarshalJSON() ([]byte, error) {
	type alias Event
	base, err := json.Marshal(alias(e))
	if err != nil {
		return nil, err
	}
	if len(e.Unknown) == 0 {
		return base, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	for k, v := range e.Unknown {
		if _, exists := m[k]; !exists {
			m[k] = v
		}
	}
	return json.Marshal(m)
}

// UnmarshalJSON decodes an event while preserving unknown fields.
func (e *Event) UnmarshalJSON(data []byte) error {
	type alias Event
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*e = Event(a)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	known := map[string]bool{
		"schema_version": true, "event_id": true, "sequence": true,
		"occurred_at": true, "observed_at": true, "workstream_id": true,
		"session_id": true, "native_session_id": true, "provider": true,
		"agent": true, "model": true, "kind": true, "parent_event_ids": true,
		"repository_id": true, "git": true, "provenance": true, "payload": true,
		"redaction": true, "content_hash": true,
	}
	for k, v := range raw {
		if !known[k] {
			if e.Unknown == nil {
				e.Unknown = make(map[string]json.RawMessage)
			}
			e.Unknown[k] = v
		}
	}
	return nil
}
