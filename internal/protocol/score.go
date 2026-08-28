package protocol

import (
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
)

// SchemaVersionScore is the derived read-model contract for scores.
const SchemaVersionScore = "hfg.score.v1"

// ScoreDataType selects which value slot a score carries. Modeled on the
// universal quality-primitive pattern proven by Langfuse/Phoenix: one score
// object for numeric metrics, categorical labels, and boolean verdicts.
type ScoreDataType string

const (
	ScoreDataTypeNumeric  ScoreDataType = "NUMERIC"
	ScoreDataTypeCategory ScoreDataType = "CATEGORY"
	ScoreDataTypeBoolean  ScoreDataType = "BOOLEAN"
)

// ScoreTargetType names the spine object a score attaches to.
type ScoreTargetType string

const (
	ScoreTargetTrace      ScoreTargetType = "trace"
	ScoreTargetSpan       ScoreTargetType = "span"
	ScoreTargetSession    ScoreTargetType = "session"
	ScoreTargetCheckpoint ScoreTargetType = "checkpoint"
	ScoreTargetWorkstream ScoreTargetType = "workstream"
)

// ScoreSource labels who produced the score, so analytics can separate
// human judgment from machine evaluation.
type ScoreSource string

const (
	ScoreSourceHuman      ScoreSource = "human"
	ScoreSourceAPI        ScoreSource = "api"
	ScoreSourceEvaluation ScoreSource = "evaluation"
	ScoreSourceDetection  ScoreSource = "detection"
)

// Score is the derived read model for one recorded score (hfg.score.v1).
// Scores are append-only events (score.recorded); this struct is derived by
// the deterministic scores reducer. An LLM-judge score is INFERRED at the
// envelope level and must never render as observed evidence.
type Score struct {
	SchemaVersion string    `json:"schema_version"`
	ScoreID       string    `json:"score_id"` // the recording event id (evt_...)
	WorkstreamID  string    `json:"workstream_id,omitempty"`
	OccurredAt    time.Time `json:"occurred_at"`

	Name string `json:"name"`

	DataType ScoreDataType `json:"data_type"`
	// Exactly one of Value / StringValue / BoolValue is set per DataType.
	Value       *float64 `json:"value,omitempty"`
	StringValue string   `json:"string_value,omitempty"`
	BoolValue   *bool    `json:"bool_value,omitempty"`

	TargetType ScoreTargetType `json:"target_type"`
	TargetID   string          `json:"target_id"`
	Source     ScoreSource     `json:"source"`

	Provenance Provenance `json:"provenance,omitempty"`
	Comment    string     `json:"comment,omitempty"`
}

// ValidScoreDataType reports whether dt is a known score data type.
func ValidScoreDataType(dt ScoreDataType) bool {
	switch dt {
	case ScoreDataTypeNumeric, ScoreDataTypeCategory, ScoreDataTypeBoolean:
		return true
	}
	return false
}

// ValidScoreTargetType reports whether tt is a known score target type.
func ValidScoreTargetType(tt ScoreTargetType) bool {
	switch tt {
	case ScoreTargetTrace, ScoreTargetSpan, ScoreTargetSession,
		ScoreTargetCheckpoint, ScoreTargetWorkstream:
		return true
	}
	return false
}

// ValidScoreSource reports whether src is a known score source.
func ValidScoreSource(src ScoreSource) bool {
	switch src {
	case ScoreSourceHuman, ScoreSourceAPI, ScoreSourceEvaluation, ScoreSourceDetection:
		return true
	}
	return false
}

// ScoreTargetPrefix returns the identifier prefix expected for a target
// type, so misaddressed scores are rejected at record time.
func ScoreTargetPrefix(tt ScoreTargetType) string {
	switch tt {
	case ScoreTargetTrace:
		return ids.PrefixTrace
	case ScoreTargetSpan:
		return ids.PrefixSpan
	case ScoreTargetSession:
		return ids.PrefixSession
	case ScoreTargetCheckpoint:
		return ids.PrefixCheckpoint
	case ScoreTargetWorkstream:
		return ids.PrefixWorkstream
	}
	return ""
}
