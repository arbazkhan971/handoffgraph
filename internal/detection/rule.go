// Package detection implements the v0.5.0 deterministic detection pack: a
// versioned YAML rule schema (hfg.detection.rule.v1) and a deterministic
// evaluator over materialized traces and spans.
//
// Design rules (inherited from AGENTS.md):
//   - Evaluation is a pure function of the ordered input: identical traces
//     and spans always yield identical matches (no map-iteration-order
//     dependence); results are sorted before returning.
//   - Matches carry their rule id + version and evidence level OBSERVED:
//     every matched span/trace was observed in the event log.
//   - History is append-only: persisting a new rule version adds new rows
//     and never rewrites prior results (see Store).
package detection

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// SchemaVersionRule is the versioned wire contract for detection rules.
const SchemaVersionRule = "hfg.detection.rule.v1"

// Rule evaluation scopes.
const (
	// ScopeTrace evaluates a rule within a single trace: groups are
	// per-trace and matches report the trace id as their scope.
	ScopeTrace = "trace"
	// ScopeWorkstream evaluates a rule across the whole input: groups
	// aggregate matching candidates from every trace.
	ScopeWorkstream = "workstream"
)

// Rule severities, ordered info < warning < error < critical.
const (
	SeverityInfo     = "info"
	SeverityWarning  = "warning"
	SeverityError    = "error"
	SeverityCritical = "critical"
)

// Condition operators.
const (
	OpEq     = "eq"
	OpNeq    = "neq"
	OpGt     = "gt"
	OpLt     = "lt"
	OpExists = "exists"
)

// Field path prefixes. A rule's conditions and group_by must all address the
// same subject (all span.* or all trace.*).
const (
	PrefixSpan  = "span."
	PrefixTrace = "trace."
)

var validSeverities = map[string]bool{
	SeverityInfo:     true,
	SeverityWarning:  true,
	SeverityError:    true,
	SeverityCritical: true,
}

var validOps = map[string]bool{
	OpEq:     true,
	OpNeq:    true,
	OpGt:     true,
	OpLt:     true,
	OpExists: true,
}

var validRuleID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
var validRuleVersion = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// Condition is a single field test over a span or trace field path. All
// conditions of a rule must hold (they are ANDed).
type Condition struct {
	Field string `yaml:"field" json:"field"`
	Op    string `yaml:"op" json:"op"`
	// Value is the comparison target. It is ignored for the exists
	// operator.
	Value any `yaml:"value,omitempty" json:"value,omitempty"`
}

// When groups the rule's matching conditions.
type When struct {
	Conditions []Condition `yaml:"conditions" json:"conditions"`
}

// Threshold is the group size a rule must reach to match.
type Threshold struct {
	CountGte int `yaml:"count_gte" json:"count_gte"`
}

// Rule is one versioned detection rule. ID+Version identify a rule revision;
// changing behavior requires a new version, never an edit of history.
type Rule struct {
	ID        string    `yaml:"id" json:"id"`
	Version   string    `yaml:"version" json:"version"`
	Scope     string    `yaml:"scope" json:"scope"`
	When      When      `yaml:"when" json:"when"`
	GroupBy   string    `yaml:"group_by" json:"group_by"`
	Threshold Threshold `yaml:"threshold" json:"threshold"`
	Severity  string    `yaml:"severity" json:"severity"`
	Message   string    `yaml:"message" json:"message"`
}

// spanFields are the resolvable span.* field paths. Fields absent from a
// concrete span (empty strings, nil pointers, zero end times) resolve as
// "not present" rather than zero values.
var spanFields = map[string]bool{
	"span.span_id":                true,
	"span.trace_id":               true,
	"span.session_id":             true,
	"span.parent_span_id":         true,
	"span.source_span_id":         true,
	"span.source_trace_id":        true,
	"span.kind":                   true,
	"span.source_kind":            true,
	"span.name":                   true,
	"span.status":                 true,
	"span.started_at_ns":          true,
	"span.ended_at_ns":            true,
	"span.duration_ns":            true,
	"span.sequence":               true,
	"span.provider":               true,
	"span.model":                  true,
	"span.tool_name":              true,
	"span.command_fingerprint":    true,
	"span.file_identity_hash":     true,
	"span.exit_code":              true,
	"span.evidence_level":         true,
	"span.input_object_hash":      true,
	"span.output_object_hash":     true,
	"span.attributes_object_hash": true,
	"span.error_object_hash":      true,
	"span.secret_match":           true,
}

// traceFields are the resolvable trace.* field paths.
var traceFields = map[string]bool{
	"trace.trace_id":           true,
	"trace.workstream_id":      true,
	"trace.session_id":         true,
	"trace.provider":           true,
	"trace.objective_excerpt":  true,
	"trace.status":             true,
	"trace.started_at_ns":      true,
	"trace.ended_at_ns":        true,
	"trace.duration_ns":        true,
	"trace.span_count":         true,
	"trace.failed_span_count":  true,
	"trace.changed_file_count": true,
	"trace.verification_state": true,
	"trace.root_span_id":       true,
	"trace.token_input":        true,
	"trace.token_output":       true,
	"trace.token_cache_read":   true,
	"trace.token_cache_write":  true,
	"trace.token_total":        true,
	"trace.cost_currency":      true,
	"trace.cost_provenance":    true,
	"trace.content_policy":     true,
}

// fieldSubject reports the subject ("span" or "trace") a field path
// addresses, and whether the field is resolvable.
func fieldSubject(field string) (string, bool) {
	switch {
	case strings.HasPrefix(field, PrefixSpan):
		return "span", spanFields[field]
	case strings.HasPrefix(field, PrefixTrace):
		return "trace", traceFields[field]
	}
	return "", false
}

// Validate checks the rule against the schema contract, returning clear
// errors that name the rule and the violated constraint.
func (r *Rule) Validate() error {
	if r == nil {
		return fmt.Errorf("rule: nil rule")
	}
	if r.ID == "" {
		return fmt.Errorf("rule: id is required")
	}
	if !validRuleID.MatchString(r.ID) {
		return fmt.Errorf("rule %q: id must be lowercase letters, digits and hyphens (got %q)", r.ID, r.ID)
	}
	if r.Version == "" {
		return fmt.Errorf("rule %q: version is required", r.ID)
	}
	if !validRuleVersion.MatchString(r.Version) {
		return fmt.Errorf("rule %q: version must be semver MAJOR.MINOR.PATCH (got %q)", r.ID, r.Version)
	}
	if r.Scope != ScopeTrace && r.Scope != ScopeWorkstream {
		return fmt.Errorf("rule %q: scope must be %q or %q (got %q)", r.ID, ScopeTrace, ScopeWorkstream, r.Scope)
	}
	if len(r.When.Conditions) == 0 {
		return fmt.Errorf("rule %q: when.conditions must contain at least one condition", r.ID)
	}

	subject := ""
	for i := range r.When.Conditions {
		c := &r.When.Conditions[i]
		if c.Field == "" {
			return fmt.Errorf("rule %q: conditions[%d].field is required", r.ID, i)
		}
		s, known := fieldSubject(c.Field)
		if !known {
			return fmt.Errorf("rule %q: conditions[%d].field %q is not a resolvable span.* or trace.* field", r.ID, i, c.Field)
		}
		if subject == "" {
			subject = s
		} else if subject != s {
			return fmt.Errorf("rule %q: conditions mix span.* and trace.* subjects (first mismatch at %q)", r.ID, c.Field)
		}
		if !validOps[c.Op] {
			return fmt.Errorf("rule %q: conditions[%d].op must be one of eq, neq, gt, lt, exists (got %q)", r.ID, i, c.Op)
		}
		if c.Op != OpExists && c.Value == nil {
			return fmt.Errorf("rule %q: conditions[%d].value is required for op %q", r.ID, i, c.Op)
		}
		if (c.Op == OpGt || c.Op == OpLt) && c.Value != nil {
			if _, ok := valueAsInt64(c.Value); !ok {
				return fmt.Errorf("rule %q: conditions[%d].op %q requires an integer value (got %v)", r.ID, i, c.Op, c.Value)
			}
		}
	}

	if r.GroupBy == "" {
		return fmt.Errorf("rule %q: group_by is required", r.ID)
	}
	gs, known := fieldSubject(r.GroupBy)
	if !known {
		return fmt.Errorf("rule %q: group_by %q is not a resolvable span.* or trace.* field", r.ID, r.GroupBy)
	}
	if gs != subject {
		return fmt.Errorf("rule %q: group_by %q must address the same subject as the conditions (%s)", r.ID, r.GroupBy, subject)
	}
	if r.Threshold.CountGte < 1 {
		return fmt.Errorf("rule %q: threshold.count_gte must be >= 1 (got %d)", r.ID, r.Threshold.CountGte)
	}
	if !validSeverities[r.Severity] {
		return fmt.Errorf("rule %q: severity must be one of info, warning, error, critical (got %q)", r.ID, r.Severity)
	}
	if strings.TrimSpace(r.Message) == "" {
		return fmt.Errorf("rule %q: message is required", r.ID)
	}
	return nil
}

// ParseRules parses a YAML rule-pack document and validates every rule.
// Duplicate rule ids within one document are rejected: a pack cannot carry
// two rules under the same id (new behavior needs a new version).
func ParseRules(data []byte) ([]*Rule, error) {
	var rules []*Rule
	if err := yaml.Unmarshal(data, &rules); err != nil {
		return nil, fmt.Errorf("parse rule pack: %w", err)
	}
	if len(rules) == 0 {
		return nil, fmt.Errorf("parse rule pack: no rules found")
	}
	seen := map[string]bool{}
	for _, r := range rules {
		if err := r.Validate(); err != nil {
			return nil, err
		}
		if seen[r.ID] {
			return nil, fmt.Errorf("rule %q: duplicate id in pack", r.ID)
		}
		seen[r.ID] = true
	}
	return rules, nil
}

// valueAsInt64 coerces a YAML condition value to int64. Supported inputs are
// int, int64, uint64 within range, integral floats, and numeric strings.
func valueAsInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case int:
		return int64(t), true
	case int64:
		return t, true
	case uint64:
		if t <= uint64(math.MaxInt64) {
			return int64(t), true
		}
		return 0, false
	case float64:
		if t == math.Trunc(t) {
			return int64(t), true
		}
		return 0, false
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
