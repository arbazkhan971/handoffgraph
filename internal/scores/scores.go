// Package scores derives the score read model from score.recorded events
// and builds validated score payloads for every recording surface (CLI,
// MCP, future APIs). One reducer, one validation path — analytics, the UI,
// and agents all see the same deterministic view.
//
// Scores are the universal quality primitive (parity-plan row 24): a
// numeric metric, categorical label, or boolean verdict attached to any
// spine object (trace, span, session, checkpoint, workstream), always
// source-tagged. LLM-judge scores must carry INFERRED provenance at the
// event envelope; deterministic sources record OBSERVED.
package scores

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// maxNameLen bounds score names so analytics keys stay sane.
const maxNameLen = 128

// Materialize derives scores from the event log. Deterministic: output is
// sorted by (occurred_at, score_id); input order never matters.
func Materialize(events []*protocol.Event) []*protocol.Score {
	out := make([]*protocol.Score, 0)
	for _, ev := range events {
		if ev.Kind != protocol.EventScoreRecorded {
			continue
		}
		if s := fromEvent(ev); s != nil {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		an, bn := a.OccurredAt.UnixNano(), b.OccurredAt.UnixNano()
		if an != bn {
			return an < bn
		}
		return a.ScoreID < b.ScoreID
	})
	return out
}

func fromEvent(ev *protocol.Event) *protocol.Score {
	var p payload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return nil // malformed payload never corrupts the read model
	}
	s := &protocol.Score{
		SchemaVersion: protocol.SchemaVersionScore,
		ScoreID:       ev.EventID,
		WorkstreamID:  ev.WorkstreamID,
		OccurredAt:    ev.OccurredAt,
		Name:          p.Name,
		DataType:      protocol.ScoreDataType(p.DataType),
		TargetType:    protocol.ScoreTargetType(p.TargetType),
		TargetID:      p.TargetID,
		Source:        protocol.ScoreSource(p.Source),
		Provenance:    ev.Provenance,
		Comment:       p.Comment,
	}
	switch s.DataType {
	case protocol.ScoreDataTypeNumeric:
		if v, err := strconv.ParseFloat(p.Value, 64); err == nil {
			s.Value = &v
		}
	case protocol.ScoreDataTypeCategory:
		s.StringValue = p.Value
	case protocol.ScoreDataTypeBoolean:
		if p.Value == "true" {
			t := true
			s.BoolValue = &t
		} else if p.Value == "false" {
			f := false
			s.BoolValue = &f
		}
	}
	return s
}

// payload is the canonical on-the-wire score payload (score.recorded). The
// value slot is a string regardless of data type so the payload round-trips
// deterministically through canonical JSON without float formatting drift.
type payload struct {
	Name       string `json:"name"`
	DataType   string `json:"data_type"`
	Value      string `json:"value"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Source     string `json:"source"`
	Comment    string `json:"comment,omitempty"`
}

// Input is a score to record, before validation.
type Input struct {
	Name        string
	DataType    protocol.ScoreDataType
	Value       *float64
	StringValue string
	BoolValue   *bool
	TargetType  protocol.ScoreTargetType
	TargetID    string
	Source      protocol.ScoreSource
	Comment     string
}

// Validate checks the input against the score contract and returns the
// canonical event payload plus the provenance the envelope must carry.
// Deterministic sources (human/api/detection/deterministic evaluators) are
// OBSERVED; a future llm_judge source will be INFERRED and is rejected
// today so an inferred verdict can never masquerade as observed evidence.
func Validate(in Input) (map[string]any, protocol.Provenance, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, "", fmt.Errorf("score name is required")
	}
	if len(name) > maxNameLen {
		return nil, "", fmt.Errorf("score name exceeds %d characters", maxNameLen)
	}
	if !protocol.ValidScoreDataType(in.DataType) {
		return nil, "", fmt.Errorf("invalid data_type %q (want NUMERIC, CATEGORY, or BOOLEAN)", in.DataType)
	}
	if !protocol.ValidScoreTargetType(in.TargetType) {
		return nil, "", fmt.Errorf("invalid target_type %q", in.TargetType)
	}
	if in.TargetID == "" {
		return nil, "", fmt.Errorf("target_id is required")
	}
	prefix := protocol.ScoreTargetPrefix(in.TargetType)
	if !strings.HasPrefix(in.TargetID, prefix) {
		return nil, "", fmt.Errorf("target_id %q does not look like a %s id (%s...)", in.TargetID, in.TargetType, prefix)
	}
	if !protocol.ValidScoreSource(in.Source) {
		return nil, "", fmt.Errorf("invalid source %q (want human, api, evaluation, or detection)", in.Source)
	}

	var value string
	switch in.DataType {
	case protocol.ScoreDataTypeNumeric:
		if in.Value == nil {
			return nil, "", fmt.Errorf("--value is required for NUMERIC scores")
		}
		// Format deterministically: strconv shortest round-trip form.
		value = strconv.FormatFloat(*in.Value, 'g', -1, 64)
	case protocol.ScoreDataTypeCategory:
		v := strings.TrimSpace(in.StringValue)
		if v == "" {
			return nil, "", fmt.Errorf("category value is required for CATEGORY scores")
		}
		value = v
	case protocol.ScoreDataTypeBoolean:
		if in.BoolValue == nil {
			return nil, "", fmt.Errorf("--bool is required for BOOLEAN scores")
		}
		value = strconv.FormatBool(*in.BoolValue)
	}

	p := map[string]any{
		"name":        name,
		"data_type":   string(in.DataType),
		"value":       value,
		"target_type": string(in.TargetType),
		"target_id":   in.TargetID,
		"source":      string(in.Source),
	}
	if in.Comment != "" {
		p["comment"] = in.Comment
	}
	return p, protocol.ProvenanceObserved, nil
}

// NewEvent builds an append-ready score.recorded event. The caller supplies
// a fresh id and capture timestamp; workstream scoping is the caller's
// responsibility, matching the other recording surfaces.
func NewEvent(eventID, workstreamID string, in Input, observedAt time.Time) (*protocol.Event, error) {
	payload, prov, err := Validate(in)
	if err != nil {
		return nil, err
	}
	now := observedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       eventID,
		OccurredAt:    now,
		ObservedAt:    now,
		WorkstreamID:  workstreamID,
		Kind:          protocol.EventScoreRecorded,
		Provenance:    prov,
		Payload:       mustJSON(payload),
	}, nil
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		// Payloads are pre-validated plain JSON types; unreachable.
		panic(fmt.Sprintf("scores: payload marshal: %v", err))
	}
	return b
}
