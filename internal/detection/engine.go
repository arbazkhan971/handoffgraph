package detection

import (
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
)

// Input is the deterministic evaluation input: materialized traces and
// spans. Evaluation never mutates the input.
type Input struct {
	// WorkstreamID labels scope=workstream matches. It may be empty when
	// evaluating an unlabelled corpus.
	WorkstreamID string            `json:"workstream_id,omitempty"`
	Traces       []*protocol.Trace `json:"traces"`
	Spans        []*protocol.Span  `json:"spans"`
}

// Match is one detection result. EvidenceLevel is always OBSERVED: every
// matched span/trace id was observed in the materialized event log.
type Match struct {
	RuleID        string              `json:"rule_id"`
	RuleVersion   string              `json:"rule_version"`
	Scope         string              `json:"scope"`
	ScopeID       string              `json:"scope_id"`
	GroupKey      string              `json:"group_key"`
	Severity      string              `json:"severity"`
	Message       string              `json:"message"`
	SpanIDs       []string            `json:"span_ids,omitempty"`
	TraceIDs      []string            `json:"trace_ids,omitempty"`
	MatchCount    int                 `json:"match_count"`
	EvidenceLevel protocol.Provenance `json:"evidence_level"`
	EvaluatedAt   time.Time           `json:"evaluated_at"`
}

// Engine evaluates rules deterministically over an Input.
type Engine struct {
	rules    []*Rule
	redactor *redact.Engine
	now      func() time.Time
}

// EngineOption configures an Engine.
type EngineOption func(*Engine)

// WithClock overrides the engine clock used for Match.EvaluatedAt. Tests use
// it to make evaluation fully deterministic.
func WithClock(now func() time.Time) EngineOption {
	return func(e *Engine) {
		if now != nil {
			e.now = now
		}
	}
}

// NewEngine validates the rules and builds an engine. Invalid rules are
// rejected here (fail-closed) rather than silently skipped at evaluation.
func NewEngine(rules []*Rule, opts ...EngineOption) (*Engine, error) {
	redactor, err := redact.New(redact.Options{})
	if err != nil {
		return nil, fmt.Errorf("detection engine redactor: %w", err)
	}
	e := &Engine{rules: append([]*Rule(nil), rules...), redactor: redactor, now: time.Now}
	for _, r := range e.rules {
		if err := r.Validate(); err != nil {
			return nil, err
		}
	}
	for _, opt := range opts {
		opt(e)
	}
	return e, nil
}

// Rules returns the engine's rules (read-only; shared with callers of
// DefaultPack).
func (e *Engine) Rules() []*Rule { return e.rules }

// Evaluate runs every rule over the input and returns matches sorted by
// (rule_id, group_key), then rule_version, scope_id and first id for a total
// order. Identical inputs (and clock) always produce identical results.
func (e *Engine) Evaluate(in Input) ([]*Match, error) {
	spans := sortedSpans(in.Spans)
	traces := sortedTraces(in.Traces)
	now := e.now()

	var matches []*Match
	for _, r := range e.rules {
		matches = append(matches, e.evaluateRule(r, in.WorkstreamID, traces, spans, now)...)
	}
	sortMatches(matches)
	return matches, nil
}

// unit is one evaluation window: the spans and traces a rule evaluates over,
// labeled by the scope id reported in matches.
type unit struct {
	scopeID string
	spans   []*protocol.Span
	traces  []*protocol.Trace
}

// evaluateRule fans a rule out over its evaluation windows: scope=workstream
// evaluates one unit over the whole input; scope=trace evaluates one unit
// per trace (spans partitioned by trace id; spans pointing at unknown trace
// ids keep their own unit so evidence is never silently dropped).
func (e *Engine) evaluateRule(r *Rule, workstreamID string, traces []*protocol.Trace, spans []*protocol.Span, now time.Time) []*Match {
	subject, _ := fieldSubject(r.GroupBy)

	var units []unit
	if r.Scope == ScopeWorkstream {
		units = append(units, unit{scopeID: workstreamID, spans: spans, traces: traces})
	} else {
		byTrace := map[string][]*protocol.Span{}
		for _, sp := range spans {
			byTrace[sp.TraceID] = append(byTrace[sp.TraceID], sp)
		}
		traceIDs := make([]string, 0, len(byTrace)+len(traces))
		for id := range byTrace {
			traceIDs = append(traceIDs, id)
		}
		for _, tr := range traces {
			if _, ok := byTrace[tr.TraceID]; !ok {
				traceIDs = append(traceIDs, tr.TraceID)
			}
		}
		sort.Strings(traceIDs)
		for _, id := range traceIDs {
			u := unit{scopeID: id, spans: byTrace[id]}
			for _, tr := range traces {
				if tr.TraceID == id {
					u.traces = append(u.traces, tr)
				}
			}
			units = append(units, u)
		}
	}

	var out []*Match
	for _, u := range units {
		if subject == "trace" {
			out = append(out, e.evaluateTraces(r, u, now)...)
		} else {
			out = append(out, e.evaluateSpans(r, u, now)...)
		}
	}
	return out
}

// evaluateSpans evaluates a span-subject rule over one unit: spans that
// satisfy all conditions are grouped by the group_by fingerprint, and every
// group reaching the threshold emits a match.
func (e *Engine) evaluateSpans(r *Rule, u unit, now time.Time) []*Match {
	type group struct {
		spanIDs []string
	}
	groups := map[string]*group{}
	for _, sp := range u.spans {
		if !e.spanMatches(r, sp) {
			continue
		}
		key, ok := e.groupKey(r.GroupBy, sp, nil)
		if !ok {
			continue // no group_by value: cannot fingerprint
		}
		g := groups[key]
		if g == nil {
			g = &group{}
			groups[key] = g
		}
		g.spanIDs = append(g.spanIDs, sp.SpanID)
	}

	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic emission independent of map order

	var out []*Match
	for _, k := range keys {
		g := groups[k]
		if len(g.spanIDs) < r.Threshold.CountGte {
			continue
		}
		ids := append([]string(nil), g.spanIDs...)
		sort.Strings(ids)
		out = append(out, &Match{
			RuleID:        r.ID,
			RuleVersion:   r.Version,
			Scope:         r.Scope,
			ScopeID:       u.scopeID,
			GroupKey:      k,
			Severity:      r.Severity,
			Message:       r.Message,
			SpanIDs:       ids,
			MatchCount:    len(ids),
			EvidenceLevel: protocol.ProvenanceObserved,
			EvaluatedAt:   now,
		})
	}
	return out
}

// evaluateTraces evaluates a trace-subject rule over one unit: matching
// traces are grouped by the group_by fingerprint and threshold-counted.
func (e *Engine) evaluateTraces(r *Rule, u unit, now time.Time) []*Match {
	type group struct {
		traceIDs []string
	}
	groups := map[string]*group{}
	for _, tr := range u.traces {
		if !e.traceMatches(r, tr) {
			continue
		}
		key, ok := e.groupKey(r.GroupBy, nil, tr)
		if !ok {
			continue
		}
		g := groups[key]
		if g == nil {
			g = &group{}
			groups[key] = g
		}
		g.traceIDs = append(g.traceIDs, tr.TraceID)
	}

	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var out []*Match
	for _, k := range keys {
		g := groups[k]
		if len(g.traceIDs) < r.Threshold.CountGte {
			continue
		}
		ids := append([]string(nil), g.traceIDs...)
		sort.Strings(ids)
		out = append(out, &Match{
			RuleID:        r.ID,
			RuleVersion:   r.Version,
			Scope:         r.Scope,
			ScopeID:       u.scopeID,
			GroupKey:      k,
			Severity:      r.Severity,
			Message:       r.Message,
			TraceIDs:      ids,
			MatchCount:    len(ids),
			EvidenceLevel: protocol.ProvenanceObserved,
			EvaluatedAt:   now,
		})
	}
	return out
}

func (e *Engine) spanMatches(r *Rule, sp *protocol.Span) bool {
	for i := range r.When.Conditions {
		c := &r.When.Conditions[i]
		v, present := e.resolveSpanField(sp, c.Field)
		if !conditionHolds(c, v, present) {
			return false
		}
	}
	return true
}

func (e *Engine) traceMatches(r *Rule, tr *protocol.Trace) bool {
	for i := range r.When.Conditions {
		c := &r.When.Conditions[i]
		v, present := resolveTraceField(tr, c.Field)
		if !conditionHolds(c, v, present) {
			return false
		}
	}
	return true
}

// groupKey resolves the group_by fingerprint for a span or trace. Missing
// values (empty strings, nil pointers) yield ok=false so the candidate is
// skipped instead of grouped under an empty key.
func (e *Engine) groupKey(field string, sp *protocol.Span, tr *protocol.Trace) (string, bool) {
	var (
		v       any
		present bool
	)
	if sp != nil {
		v, present = e.resolveSpanField(sp, field)
	} else {
		v, present = resolveTraceField(tr, field)
	}
	if !present {
		return "", false
	}
	switch t := v.(type) {
	case string:
		return t, t != ""
	case int64:
		return strconv.FormatInt(t, 10), true
	case bool:
		return strconv.FormatBool(t), true
	}
	return "", false
}

// conditionHolds evaluates one condition against a resolved field value.
// Comparisons against absent values are false (fail-closed: neq never fires
// on a missing field).
func conditionHolds(c *Condition, v any, present bool) bool {
	switch c.Op {
	case OpExists:
		return present
	case OpEq:
		return present && valuesEqual(c.Value, v)
	case OpNeq:
		return present && !valuesEqual(c.Value, v)
	case OpGt, OpLt:
		if !present {
			return false
		}
		got, ok1 := valueAsInt64(v)
		want, ok2 := valueAsInt64(c.Value)
		if !ok1 || !ok2 {
			return false
		}
		if c.Op == OpGt {
			return got > want
		}
		return got < want
	}
	return false
}

// valuesEqual compares a condition value with a resolved field value using
// strict same-type semantics.
func valuesEqual(want, got any) bool {
	switch g := got.(type) {
	case string:
		w, ok := want.(string)
		return ok && w == g
	case int64:
		w, ok := valueAsInt64(want)
		return ok && w == g
	case bool:
		switch w := want.(type) {
		case bool:
			return w == g
		case string:
			b, err := strconv.ParseBool(w)
			return err == nil && b == g
		}
	}
	return false
}

// resolveSpanField resolves a span.* field path to a typed value. Empty
// strings and nil pointers resolve as not present; secret_match is computed
// by the redaction engine over the span name.
func (e *Engine) resolveSpanField(sp *protocol.Span, field string) (any, bool) {
	switch field {
	case "span.span_id":
		return sp.SpanID, sp.SpanID != ""
	case "span.trace_id":
		return sp.TraceID, sp.TraceID != ""
	case "span.session_id":
		return sp.SessionID, sp.SessionID != ""
	case "span.parent_span_id":
		return sp.ParentSpanID, sp.ParentSpanID != ""
	case "span.source_span_id":
		return sp.SourceSpanID, sp.SourceSpanID != ""
	case "span.source_trace_id":
		return sp.SourceTraceID, sp.SourceTraceID != ""
	case "span.kind":
		return string(sp.Kind), sp.Kind != ""
	case "span.source_kind":
		return sp.SourceKind, sp.SourceKind != ""
	case "span.name":
		return sp.Name, sp.Name != ""
	case "span.status":
		return sp.Status, sp.Status != ""
	case "span.started_at_ns":
		return sp.StartedAtNS, true
	case "span.ended_at_ns":
		return sp.EndedAtNS, sp.EndedAtNS != 0
	case "span.duration_ns":
		if sp.EndedAtNS == 0 {
			return nil, false
		}
		return sp.EndedAtNS - sp.StartedAtNS, true
	case "span.sequence":
		return sp.Sequence, true
	case "span.provider":
		return sp.Provider, sp.Provider != ""
	case "span.model":
		return sp.Model, sp.Model != ""
	case "span.tool_name":
		return sp.ToolName, sp.ToolName != ""
	case "span.command_fingerprint":
		return sp.CommandFingerprint, sp.CommandFingerprint != ""
	case "span.file_identity_hash":
		return sp.FileIdentityHash, sp.FileIdentityHash != ""
	case "span.exit_code":
		if sp.ExitCode == nil {
			return nil, false
		}
		return int64(*sp.ExitCode), true
	case "span.evidence_level":
		return string(sp.EvidenceLevel), sp.EvidenceLevel != ""
	case "span.input_object_hash":
		return sp.InputObjectHash, sp.InputObjectHash != ""
	case "span.output_object_hash":
		return sp.OutputObjectHash, sp.OutputObjectHash != ""
	case "span.attributes_object_hash":
		return sp.AttributesObjectHash, sp.AttributesObjectHash != ""
	case "span.error_object_hash":
		return sp.ErrorObjectHash, sp.ErrorObjectHash != ""
	case "span.secret_match":
		_, changed := e.redactor.RedactValue(sp.Name)
		return changed, true
	}
	return nil, false
}

// resolveTraceField resolves a trace.* field path to a typed value.
func resolveTraceField(tr *protocol.Trace, field string) (any, bool) {
	switch field {
	case "trace.trace_id":
		return tr.TraceID, tr.TraceID != ""
	case "trace.workstream_id":
		return tr.WorkstreamID, tr.WorkstreamID != ""
	case "trace.session_id":
		return tr.SessionID, tr.SessionID != ""
	case "trace.provider":
		return tr.Provider, tr.Provider != ""
	case "trace.objective_excerpt":
		return tr.ObjectiveExcerpt, tr.ObjectiveExcerpt != ""
	case "trace.status":
		return string(tr.Status), tr.Status != ""
	case "trace.started_at_ns":
		return tr.StartedAtNS, true
	case "trace.ended_at_ns":
		return tr.EndedAtNS, tr.EndedAtNS != 0
	case "trace.duration_ns":
		return tr.DurationNS, tr.DurationNS != 0
	case "trace.span_count":
		return tr.SpanCount, true
	case "trace.failed_span_count":
		return tr.FailedSpanCount, true
	case "trace.changed_file_count":
		return tr.ChangedFileCount, true
	case "trace.verification_state":
		return string(tr.VerificationState), tr.VerificationState != ""
	case "trace.root_span_id":
		return tr.RootSpanID, tr.RootSpanID != ""
	case "trace.token_input":
		return ptrInt64(tr.TokenInput)
	case "trace.token_output":
		return ptrInt64(tr.TokenOutput)
	case "trace.token_cache_read":
		return ptrInt64(tr.TokenCacheRead)
	case "trace.token_cache_write":
		return ptrInt64(tr.TokenCacheWrite)
	case "trace.token_total":
		var total int64
		present := false
		for _, p := range []*int64{tr.TokenInput, tr.TokenOutput, tr.TokenCacheRead, tr.TokenCacheWrite} {
			if p != nil {
				total += *p
				present = true
			}
		}
		if !present {
			return nil, false
		}
		return total, true
	case "trace.cost_currency":
		return tr.CostCurrency, tr.CostCurrency != ""
	case "trace.cost_provenance":
		return string(tr.CostProvenance), tr.CostProvenance != ""
	case "trace.content_policy":
		return tr.ContentPolicy, tr.ContentPolicy != ""
	}
	return nil, false
}

func ptrInt64(p *int64) (any, bool) {
	if p == nil {
		return nil, false
	}
	return *p, true
}

// sortedSpans returns a copy ordered like the trace materializer output:
// (Sequence, StartedAtNS, SpanID).
func sortedSpans(spans []*protocol.Span) []*protocol.Span {
	out := append([]*protocol.Span(nil), spans...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Sequence != out[j].Sequence {
			return out[i].Sequence < out[j].Sequence
		}
		if out[i].StartedAtNS != out[j].StartedAtNS {
			return out[i].StartedAtNS < out[j].StartedAtNS
		}
		return out[i].SpanID < out[j].SpanID
	})
	return out
}

// sortedTraces returns a copy ordered by trace id.
func sortedTraces(traces []*protocol.Trace) []*protocol.Trace {
	out := append([]*protocol.Trace(nil), traces...)
	sort.Slice(out, func(i, j int) bool { return out[i].TraceID < out[j].TraceID })
	return out
}

// sortMatches orders matches by (rule_id, group_key) with deterministic
// tiebreaks for a total order.
func sortMatches(matches []*Match) {
	sort.Slice(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.RuleID != b.RuleID {
			return a.RuleID < b.RuleID
		}
		if a.GroupKey != b.GroupKey {
			return a.GroupKey < b.GroupKey
		}
		if a.RuleVersion != b.RuleVersion {
			return a.RuleVersion < b.RuleVersion
		}
		if a.ScopeID != b.ScopeID {
			return a.ScopeID < b.ScopeID
		}
		return firstID(a) < firstID(b)
	})
}

func firstID(m *Match) string {
	if len(m.SpanIDs) > 0 {
		return m.SpanIDs[0]
	}
	if len(m.TraceIDs) > 0 {
		return m.TraceIDs[0]
	}
	return ""
}
