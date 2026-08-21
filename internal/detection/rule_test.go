package detection

import (
	"strings"
	"testing"
)

// baseRule returns a valid rule used as the table-test baseline.
func baseRule() *Rule {
	return &Rule{
		ID:      "sample-rule",
		Version: "1.0.0",
		Scope:   ScopeTrace,
		When: When{
			Conditions: []Condition{
				{Field: "span.kind", Op: OpEq, Value: "COMMAND"},
				{Field: "span.exit_code", Op: OpNeq, Value: 0},
			},
		},
		GroupBy:   "span.span_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityWarning,
		Message:   "sample message",
	}
}

func TestRuleValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Rule)
		wantErr string // empty means the rule must validate
	}{
		{name: "valid baseline", mutate: func(r *Rule) {}, wantErr: ""},
		{
			name:    "empty id",
			mutate:  func(r *Rule) { r.ID = "" },
			wantErr: "id is required",
		},
		{
			name:    "uppercase id",
			mutate:  func(r *Rule) { r.ID = "Bad-ID" },
			wantErr: `id must be lowercase`,
		},
		{
			name:    "empty version",
			mutate:  func(r *Rule) { r.Version = "" },
			wantErr: "version is required",
		},
		{
			name:    "non-semver version",
			mutate:  func(r *Rule) { r.Version = "latest" },
			wantErr: "version must be semver",
		},
		{
			name:    "bad scope",
			mutate:  func(r *Rule) { r.Scope = "session" },
			wantErr: `scope must be "trace" or "workstream"`,
		},
		{
			name:    "no conditions",
			mutate:  func(r *Rule) { r.When.Conditions = nil },
			wantErr: "at least one condition",
		},
		{
			name:    "unknown field",
			mutate:  func(r *Rule) { r.When.Conditions[0].Field = "span.bogus" },
			wantErr: `not a resolvable`,
		},
		{
			name:    "unprefixed field",
			mutate:  func(r *Rule) { r.When.Conditions[0].Field = "kind" },
			wantErr: `not a resolvable`,
		},
		{
			name: "mixed subjects",
			mutate: func(r *Rule) {
				r.When.Conditions = []Condition{
					{Field: "span.kind", Op: OpEq, Value: "COMMAND"},
					{Field: "trace.status", Op: OpEq, Value: "ERROR"},
				}
			},
			wantErr: "mix span.* and trace.*",
		},
		{
			name:    "unknown op",
			mutate:  func(r *Rule) { r.When.Conditions[0].Op = "contains" },
			wantErr: "op must be one of",
		},
		{
			name:    "missing value for eq",
			mutate:  func(r *Rule) { r.When.Conditions[0].Value = nil },
			wantErr: "value is required for op",
		},
		{
			name: "gt with non-numeric value",
			mutate: func(r *Rule) {
				r.When.Conditions = []Condition{{Field: "span.exit_code", Op: OpGt, Value: "many"}}
			},
			wantErr: "requires an integer value",
		},
		{
			name:    "empty group_by",
			mutate:  func(r *Rule) { r.GroupBy = "" },
			wantErr: "group_by is required",
		},
		{
			name:    "unknown group_by field",
			mutate:  func(r *Rule) { r.GroupBy = "span.wat" },
			wantErr: `group_by "span.wat" is not a resolvable`,
		},
		{
			name:    "group_by subject mismatch",
			mutate:  func(r *Rule) { r.GroupBy = "trace.trace_id" },
			wantErr: "same subject",
		},
		{
			name:    "zero threshold",
			mutate:  func(r *Rule) { r.Threshold.CountGte = 0 },
			wantErr: "count_gte must be >= 1",
		},
		{
			name:    "bad severity",
			mutate:  func(r *Rule) { r.Severity = "loud" },
			wantErr: "severity must be one of",
		},
		{
			name:    "empty message",
			mutate:  func(r *Rule) { r.Message = "  " },
			wantErr: "message is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := baseRule()
			tt.mutate(r)
			err := r.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() = nil, want error containing %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Validate() = %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestRuleValidateTraceSubject(t *testing.T) {
	r := &Rule{
		ID:      "trace-rule",
		Version: "1.2.3",
		Scope:   ScopeTrace,
		When: When{
			Conditions: []Condition{
				{Field: "trace.status", Op: OpEq, Value: "OK"},
				{Field: "trace.duration_ns", Op: OpGt, Value: 1000},
			},
		},
		GroupBy:   "trace.trace_id",
		Threshold: Threshold{CountGte: 1},
		Severity:  SeverityInfo,
		Message:   "msg",
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}

func TestRuleValidateNil(t *testing.T) {
	var r *Rule
	if err := r.Validate(); err == nil {
		t.Fatal("nil rule must not validate")
	}
}

func TestParseRules(t *testing.T) {
	const doc = `
- id: alpha-rule
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.status
        op: eq
        value: error
  group_by: span.span_id
  threshold:
    count_gte: 1
  severity: error
  message: "alpha fired"
- id: beta-rule
  version: 2.0.0-rc.1
  scope: workstream
  when:
    conditions:
      - field: trace.token_total
        op: exists
  group_by: trace.trace_id
  threshold:
    count_gte: 2
  severity: info
  message: "beta fired"
`
	rules, err := ParseRules([]byte(doc))
	if err != nil {
		t.Fatalf("ParseRules: %v", err)
	}
	if len(rules) != 2 {
		t.Fatalf("len(rules) = %d, want 2", len(rules))
	}
	alpha := rules[0]
	if alpha.ID != "alpha-rule" || alpha.Scope != ScopeTrace || alpha.Severity != SeverityError {
		t.Errorf("alpha = %+v", alpha)
	}
	if len(alpha.When.Conditions) != 1 || alpha.When.Conditions[0].Value != "error" {
		t.Errorf("alpha conditions = %+v", alpha.When.Conditions)
	}
	if alpha.Threshold.CountGte != 1 {
		t.Errorf("alpha threshold = %+v", alpha.Threshold)
	}
	beta := rules[1]
	if beta.Version != "2.0.0-rc.1" || beta.GroupBy != "trace.trace_id" {
		t.Errorf("beta = %+v", beta)
	}
}

func TestParseRulesErrors(t *testing.T) {
	tests := []struct {
		name    string
		doc     string
		wantErr string
	}{
		{
			name:    "invalid yaml",
			doc:     "\t- id: bad\n   version: [",
			wantErr: "parse rule pack",
		},
		{
			name:    "empty document",
			doc:     "",
			wantErr: "no rules found",
		},
		{
			name: "invalid rule",
			doc: `- id: broken
  version: 1.0.0
  scope: trace
  when:
    conditions:
      - field: span.nope
        op: eq
        value: x
  group_by: span.span_id
  threshold: {count_gte: 1}
  severity: info
  message: "m"
`,
			wantErr: "not a resolvable",
		},
		{
			name: "duplicate ids",
			doc: `- id: dup
  version: 1.0.0
  scope: trace
  when:
    conditions: [{field: span.name, op: exists}]
  group_by: span.span_id
  threshold: {count_gte: 1}
  severity: info
  message: "m"
- id: dup
  version: 1.1.0
  scope: trace
  when:
    conditions: [{field: span.name, op: exists}]
  group_by: span.span_id
  threshold: {count_gte: 1}
  severity: info
  message: "m2"
`,
			wantErr: "duplicate id",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseRules([]byte(tt.doc))
			if err == nil {
				t.Fatalf("ParseRules succeeded, want error containing %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("ParseRules = %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}
