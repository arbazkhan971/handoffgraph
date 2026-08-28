package otlp

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Options parameterizes conversion.
type Options struct {
	// WorkstreamID attaches events to an existing workstream when non-empty.
	WorkstreamID string
	// ObservedAt overrides the capture timestamp; zero means time.Now().UTC().
	// It never participates in identifier derivation, so re-import is
	// idempotent regardless of when it runs.
	ObservedAt time.Time
	// CaptureTier gates attribute content at emit time (minimal/metadata/
	// full). Empty means full. Tier drops are counted on the payload, never
	// silent.
	CaptureTier CaptureTier
}

// SpanError reports one rejected span. The rest of the batch still converts.
type SpanError struct {
	TraceID string
	SpanID  string
	Err     error
}

// Result is the outcome of one Convert call.
type Result struct {
	Events []*protocol.Event
	// DroppedAttributeKeys counts reserved attribute keys removed by the
	// sanitizer across all accepted spans. Drops are never silent: the
	// per-span count also rides on each completed-event payload.
	DroppedAttributeKeys int
	SpanErrors           []SpanError
}

// Event class ranks for deterministic ordering within one timestamp.
const (
	classSessionStart = iota
	classTraceStart
	classSpanStart
	classSpanEnd
	classTraceEnd
)

// Convert turns one OTLP/JSON request into deterministic, append-ready
// events. It never mutates its input. Spans that fail validation are
// reported in Result.SpanErrors and skipped; remaining spans still convert
// (partial success mirrors the OTLP contract).
//
// Phases: (1) validate every span and record start times so a child's
// ParentEventIDs can reference the parent's derived event id even when the
// parent is converted later in the same batch; (2) emit events. Output
// ordering is a pure function of the input: (occurred_at, class, event_id).
func Convert(req *ExportRequest, opts Options) (*Result, error) {
	if req == nil {
		return nil, errors.New("nil export request")
	}
	observedAt := opts.ObservedAt
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	tier := opts.CaptureTier
	if tier == "" {
		tier = CaptureFull
	}

	res := &Result{}
	// startNSByKey: "traceHex|spanHex" -> start nanos, for parent linkage.
	startNSByKey := map[string]uint64{}
	// sessionKeyByTrace: explicit session ids are trace-wide when the
	// emitter only stamps them on one span (commonly the root).
	sessionKeyByTrace := map[string]string{}
	serviceNames := make([]string, len(req.ResourceSpans))

	for ri := range req.ResourceSpans {
		rs := &req.ResourceSpans[ri]
		resourceAttrs, rerrs := sanitizeKeyValues(rs.Resource.attrs(), 0)
		res.DroppedAttributeKeys += countDropped(rs.Resource.attrs())
		if len(rerrs) > 0 {
			// A broken resource poisons every span under it: reject those
			// spans fail-closed rather than guess at partial attributes.
			for si := range rs.ScopeSpans {
				for pi := range rs.ScopeSpans[si].Spans {
					sp := &rs.ScopeSpans[si].Spans[pi]
					res.SpanErrors = append(res.SpanErrors, SpanError{
						TraceID: sp.TraceID, SpanID: sp.SpanID, Err: rerrs[0],
					})
				}
			}
			serviceNames[ri] = "\x00invalid"
			continue
		}
		serviceNames[ri] = strAttr(resourceAttrs, "service.name")

		for si := range rs.ScopeSpans {
			for pi := range rs.ScopeSpans[si].Spans {
				sp := &rs.ScopeSpans[si].Spans[pi]
				if !validHex(sp.TraceID, 32) || !validHex(sp.SpanID, 16) {
					continue // reported during phase 2
				}
				traceHex := strings.ToLower(sp.TraceID)
				if ns, err := parseNano(sp.StartTimeUnixNano); err == nil {
					startNSByKey[traceHex+"|"+strings.ToLower(sp.SpanID)] = ns
				}
				if _, has := sessionKeyByTrace[traceHex]; !has {
					// Session-key precedence (first hit wins): session.id,
					// then the OTel GenAI semconv session-correlation
					// attribute gen_ai.conversation.id, then the older
					// Langfuse/HandoffGraph/generic keys. Mirrored in the
					// per-span lookup below and in platform/src/otlp.ts.
					if key := rawStrAttr(sp.Attributes, "session.id", "gen_ai.conversation.id", "langfuse.session.id", "handoffgraph.session_id", "session_id"); key != "" {
						sessionKeyByTrace[traceHex] = key
					}
				}
			}
		}
	}

	type traceAccum struct {
		sessionKey            string
		minStartNS, maxEndNS  uint64
		tokIn, tokOut         int64
		cacheRead, cacheWrite int64
		hasUsage              bool
	}
	traces := map[string]*traceAccum{}
	type sessionAccum struct {
		minStartNS uint64
		agent      string
	}
	sessions := map[string]*sessionAccum{}
	var events []*protocol.Event

	emit := func(evtID string, atNS uint64, sesID, sessionKey string, kind protocol.EventKind, payload map[string]any, model, agent string, parents []string) {
		events = append(events, &protocol.Event{
			SchemaVersion:   protocol.SchemaVersionEvent,
			EventID:         evtID,
			OccurredAt:      time.Unix(0, int64(atNS)).UTC(),
			ObservedAt:      observedAt,
			WorkstreamID:    opts.WorkstreamID,
			SessionID:       sesID,
			NativeSessionID: sessionKey,
			Provider:        protocol.ProviderOTLP,
			Agent:           agent,
			Model:           model,
			Kind:            kind,
			ParentEventIDs:  parents,
			Provenance:      protocol.ProvenanceObserved,
			Payload:         mustJSON(payload),
		})
	}

	for ri := range req.ResourceSpans {
		rs := &req.ResourceSpans[ri]
		serviceName := serviceNames[ri]
		for si := range rs.ScopeSpans {
			ss := &rs.ScopeSpans[si]
			scopeAttrs := map[string]any{}
			if ss.Scope != nil && ss.Scope.Name != "" {
				scopeAttrs["otlp.scope.name"] = ss.Scope.Name
				if ss.Scope.Version != "" {
					scopeAttrs["otlp.scope.version"] = ss.Scope.Version
				}
			}
			for pi := range ss.Spans {
				sp := &ss.Spans[pi]
				spanAttrs, startNS, endNS, cerr := validateSpan(sp)
				if cerr != nil {
					res.SpanErrors = append(res.SpanErrors, SpanError{TraceID: sp.TraceID, SpanID: sp.SpanID, Err: cerr})
					continue
				}
				if serviceName == "\x00invalid" {
					res.SpanErrors = append(res.SpanErrors, SpanError{TraceID: sp.TraceID, SpanID: sp.SpanID, Err: errors.New("resource attributes invalid")})
					continue
				}
				res.DroppedAttributeKeys += countDropped(sp.Attributes)
				for k, v := range scopeAttrs {
					if _, taken := spanAttrs[k]; !taken {
						spanAttrs[k] = v
					}
				}
				tierAttrs, tierDropped, keyManifest := applyTier(spanAttrs, tier)

				traceHex := strings.ToLower(sp.TraceID)
				spanHex := strings.ToLower(sp.SpanID)
				parentHex := strings.ToLower(sp.ParentSpanID)

				// Session-key precedence — see the phase-1 scan above.
				sessionKey := strAttr(spanAttrs, "session.id", "gen_ai.conversation.id", "langfuse.session.id", "handoffgraph.session_id", "session_id")
				if sessionKey == "" {
					sessionKey = sessionKeyByTrace[traceHex]
				}
				if sessionKey == "" {
					sessionKey = "otlp-trace-" + traceHex
				}
				// Provider detection: gen_ai.provider.name superseded
				// gen_ai.system in GenAI semconv v1.37.0 (Aug 2025); read
				// the new key first, fall back to gen_ai.system for older
				// emitters, then the pre-GenAI heuristics.
				model := strAttr(spanAttrs, "gen_ai.request.model", "gen_ai.provider.name", "gen_ai.system", "llm.model_name", "coding_agent.model")
				toolName := strAttr(spanAttrs, "gen_ai.tool.name", "coding_agent.tool")
				spanKind := mapKind(kindName(sp.Kind), sp.Name, spanAttrs)

				// Session/trace identity is a pure function of the key
				// (timestamp 0): every event of one session/trace must
				// derive the SAME id regardless of which span emitted it.
				// occurred_at carries the timing; spn_ ids keep the span's
				// own start so span identity still varies per span.
				sesID := ids.Deterministic(ids.PrefixSession, "otlp|"+sessionKey, 0)
				trcID := ids.Deterministic(ids.PrefixTrace, "otlp|"+traceHex, 0)
				spnID := ids.Deterministic(ids.PrefixSpan, "otlp|"+traceHex+"|"+spanHex, nsToMS(startNS))
				startEvt := ids.Deterministic(ids.PrefixEvent, "otlp|span-start|"+traceHex+"|"+spanHex, nsToMS(startNS))
				endEvt := ids.Deterministic(ids.PrefixEvent, "otlp|span-end|"+traceHex+"|"+spanHex, nsToMS(endNS))

				tr := traces[traceHex]
				if tr == nil {
					tr = &traceAccum{sessionKey: sessionKey, minStartNS: startNS, maxEndNS: endNS}
					traces[traceHex] = tr
				}
				tr.minStartNS = minU64(tr.minStartNS, startNS)
				tr.maxEndNS = maxU64(tr.maxEndNS, endNS)
				if v, ok := intAttr(spanAttrs, "gen_ai.usage.input_tokens", "llm.token_count.prompt"); ok {
					tr.tokIn += v
					tr.hasUsage = true
				}
				if v, ok := intAttr(spanAttrs, "gen_ai.usage.output_tokens", "llm.token_count.completion"); ok {
					tr.tokOut += v
					tr.hasUsage = true
				}
				if v, ok := intAttr(spanAttrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_tokens"); ok {
					tr.cacheRead += v
					tr.hasUsage = true
				}
				if v, ok := intAttr(spanAttrs, "gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_write_tokens"); ok {
					tr.cacheWrite += v
					tr.hasUsage = true
				}
				ses := sessions[sessionKey]
				if ses == nil {
					ses = &sessionAccum{minStartNS: startNS, agent: serviceName}
					sessions[sessionKey] = ses
				}
				ses.minStartNS = minU64(ses.minStartNS, startNS)
				if ses.agent == "" {
					ses.agent = serviceName
				}

				// span.started — carries the normalized span identity.
				startPayload := map[string]any{
					"span_id":        spnID,
					"span_kind":      string(spanKind),
					"name":           sp.Name,
					"trace_id":       trcID,
					"source_kind":    kindName(sp.Kind),
					"source_span_id": spanHex,
				}
				var parents []string
				if parentHex != "" {
					startPayload["parent_span_source_id"] = parentHex
					if parentStart, ok := startNSByKey[traceHex+"|"+parentHex]; ok {
						parents = []string{ids.Deterministic(ids.PrefixEvent,
							"otlp|span-start|"+traceHex+"|"+parentHex, nsToMS(parentStart))}
					}
				}
				if toolName != "" {
					startPayload["tool_name"] = toolName
				}
				emit(startEvt, startNS, sesID, sessionKey, protocol.EventSpanStarted, startPayload, model, serviceName, parents)

				// span.completed / span.failed — carries the attributes as
				// observed evidence.
				endPayload := map[string]any{"span_id": spnID, "trace_id": trcID}
				if dropped := countDropped(sp.Attributes); dropped > 0 {
					endPayload["otlp_dropped_attribute_keys"] = dropped
				}
				endKind := protocol.EventSpanCompleted
				if sp.Status.isError() {
					endKind = protocol.EventSpanFailed
					endPayload["error"] = sp.Status.errorString()
				}
				if len(tierAttrs) > 0 {
					endPayload["attributes"] = tierAttrs
				}
				if keyManifest != nil {
					endPayload["attribute_keys"] = keyManifest
				}
				if tierDropped > 0 {
					endPayload["capture_dropped_keys"] = tierDropped
					endPayload["capture_tier"] = string(tier)
				}
				emit(endEvt, endNS, sesID, sessionKey, endKind, endPayload, model, serviceName, nil)
			}
		}
	}

	// trace.started + trace.completed per trace, then session.started per
	// session. Sorted key iteration keeps output deterministic.
	traceKeys := make([]string, 0, len(traces))
	for k := range traces {
		traceKeys = append(traceKeys, k)
	}
	sort.Strings(traceKeys)
	for _, k := range traceKeys {
		tr := traces[k]
		trcID := ids.Deterministic(ids.PrefixTrace, "otlp|"+k, 0)
		sesID := ids.Deterministic(ids.PrefixSession, "otlp|"+tr.sessionKey, 0)
		emit(ids.Deterministic(ids.PrefixEvent, "otlp|trace-start|"+k, nsToMS(tr.minStartNS)),
			tr.minStartNS, sesID, tr.sessionKey, protocol.EventTraceStarted,
			map[string]any{"trace_id": trcID}, "", "", nil)
		completed := map[string]any{"trace_id": trcID}
		if tr.hasUsage {
			if tr.tokIn > 0 {
				completed["token_input"] = tr.tokIn
			}
			if tr.tokOut > 0 {
				completed["token_output"] = tr.tokOut
			}
			if tr.cacheRead > 0 {
				completed["token_cache_read"] = tr.cacheRead
			}
			if tr.cacheWrite > 0 {
				completed["token_cache_write"] = tr.cacheWrite
			}
		}
		emit(ids.Deterministic(ids.PrefixEvent, "otlp|trace-end|"+k, nsToMS(tr.maxEndNS)),
			tr.maxEndNS, sesID, tr.sessionKey, protocol.EventTraceCompleted, completed, "", "", nil)
	}
	sessionKeys := make([]string, 0, len(sessions))
	for k := range sessions {
		sessionKeys = append(sessionKeys, k)
	}
	sort.Strings(sessionKeys)
	for _, k := range sessionKeys {
		ses := sessions[k]
		emit(ids.Deterministic(ids.PrefixEvent, "otlp|session-start|"+k, nsToMS(ses.minStartNS)),
			ses.minStartNS,
			ids.Deterministic(ids.PrefixSession, "otlp|"+k, 0),
			k, protocol.EventSessionStarted, map[string]any{"service": ses.agent}, "", ses.agent, nil)
	}

	// Deterministic total order: (occurred_at, class, event_id).
	rank := map[protocol.EventKind]int{
		protocol.EventSessionStarted: classSessionStart,
		protocol.EventTraceStarted:   classTraceStart,
		protocol.EventSpanStarted:    classSpanStart,
		protocol.EventSpanCompleted:  classSpanEnd,
		protocol.EventSpanFailed:     classSpanEnd,
		protocol.EventTraceCompleted: classTraceEnd,
	}
	sort.SliceStable(events, func(i, j int) bool {
		a, b := events[i], events[j]
		an, bn := a.OccurredAt.UnixNano(), b.OccurredAt.UnixNano()
		if an != bn {
			return an < bn
		}
		if rank[a.Kind] != rank[b.Kind] {
			return rank[a.Kind] < rank[b.Kind]
		}
		return a.EventID < b.EventID
	})
	res.Events = events
	return res, nil
}

// validateSpan enforces the fail-closed span contract and returns sanitized
// attributes plus parsed start/end times.
func validateSpan(sp *Span) (map[string]any, uint64, uint64, error) {
	if !validHex(sp.TraceID, 32) {
		return nil, 0, 0, fmt.Errorf("traceId %q is not 32 hex chars", sp.TraceID)
	}
	if !validHex(sp.SpanID, 16) {
		return nil, 0, 0, fmt.Errorf("spanId %q is not 16 hex chars", sp.SpanID)
	}
	if sp.ParentSpanID != "" && !validHex(sp.ParentSpanID, 16) {
		return nil, 0, 0, fmt.Errorf("parentSpanId %q is not 16 hex chars", sp.ParentSpanID)
	}
	startNS, err := parseNano(sp.StartTimeUnixNano)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("startTimeUnixNano %q: %w", sp.StartTimeUnixNano, err)
	}
	endNS, err := parseNano(sp.EndTimeUnixNano)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("endTimeUnixNano %q: %w", sp.EndTimeUnixNano, err)
	}
	if endNS < startNS {
		return nil, 0, 0, errors.New("endTimeUnixNano precedes startTimeUnixNano")
	}
	if !utf8.ValidString(sp.Name) {
		return nil, 0, 0, errors.New("span name is not valid UTF-8")
	}
	attrs, aerrs := sanitizeKeyValues(sp.Attributes, 0)
	if len(aerrs) > 0 {
		return nil, 0, 0, aerrs[0]
	}
	return attrs, startNS, endNS, nil
}

// otlpKindName normalizes the OTLP span kind (enum number or name).
func otlpKindName(raw string) string {
	switch raw {
	case "0", "":
		return "SPAN_KIND_UNSPECIFIED"
	case "1":
		return "SPAN_KIND_INTERNAL"
	case "2":
		return "SPAN_KIND_SERVER"
	case "3":
		return "SPAN_KIND_CLIENT"
	case "4":
		return "SPAN_KIND_PRODUCER"
	case "5":
		return "SPAN_KIND_CONSUMER"
	default:
		return raw
	}
}

// mapKind maps OTLP kind + conventions onto the normalized SpanKind. The
// raw OTLP kind is preserved separately (payload source_kind). GenAI CLIENT
// spans are model calls; OpenInference's 10-kind enum wins when present
// (EVALUATOR -> GUARDRAIL, PROMPT -> WORKFLOW — documented on the cases
// below); tool spans are recognized from gen_ai.tool.name / execute_tool
// naming / coding_agent.tool.
func mapKind(rawKind, name string, attrs map[string]any) protocol.SpanKind {
	oi := strAttr(attrs, "openinference.span.kind")
	// hasGenAI: gen_ai.provider.name (semconv v1.37.0, Aug 2025) is checked
	// ahead of the legacy gen_ai.system attribute — same precedence as the
	// model resolution in Convert.
	hasGenAI := strAttr(attrs, "gen_ai.operation.name", "gen_ai.request.model", "gen_ai.provider.name", "gen_ai.system") != ""
	isTool := strAttr(attrs, "gen_ai.tool.name", "coding_agent.tool") != "" ||
		strings.HasPrefix(name, "execute_tool ")
	switch {
	case oi == "LLM" || oi == "EMBEDDING":
		return protocol.SpanKindModel
	case oi == "AGENT":
		return protocol.SpanKindAgent
	case oi == "TOOL":
		return protocol.SpanKindTool
	case oi == "RETRIEVER" || oi == "RERANKER":
		return protocol.SpanKindRetrieval
	case oi == "GUARDRAIL" || oi == "EVALUATOR":
		// EVALUATOR renders a pass/fail or scored verdict over content —
		// the same quality-gate semantics as GUARDRAIL, so both fold onto
		// our GUARDRAIL kind.
		return protocol.SpanKindGuardrail
	case oi == "CHAIN" || oi == "PROMPT":
		// PROMPT assembles/renders a prompt template — a workflow step,
		// not a model call — so it folds onto WORKFLOW alongside CHAIN.
		return protocol.SpanKindWorkflow
	case isTool:
		return protocol.SpanKindTool
	case hasGenAI && rawKind == "SPAN_KIND_CLIENT":
		return protocol.SpanKindModel
	case strings.HasPrefix(name, "coding_agent.") || strAttr(attrs, "coding_agent.session") != "":
		return protocol.SpanKindAgent
	}
	switch rawKind {
	case "SPAN_KIND_SERVER":
		return protocol.SpanKindMCPServer
	default:
		return protocol.SpanKindOther
	}
}

// sanitizeKeyValues converts KeyValue pairs into a plain map, dropping
// reserved keys and rejecting (fail-closed) invalid keys or strings.
//
// The returned map is ALWAYS initialized, including for a span carrying zero
// attributes: Convert merges the instrumentation-scope attributes into it,
// and writing into a nil map panics. Every OTel SDK stamps a scope name, so a
// nil return here took down any batch containing one attribute-less span.
func sanitizeKeyValues(kvs []KeyValue, depth int) (map[string]any, []error) {
	out := make(map[string]any, len(kvs))
	if len(kvs) == 0 {
		return out, nil
	}
	if depth > maxAttrDepth {
		return out, []error{fmt.Errorf("attribute nesting exceeds %d levels", maxAttrDepth)}
	}
	var errs []error
	for _, kv := range kvs {
		if reservedAttrKeys[kv.Key] {
			continue
		}
		if kv.Key == "" || !utf8.ValidString(kv.Key) || strings.ContainsAny(kv.Key, "\x00\n\r") {
			errs = append(errs, fmt.Errorf("invalid attribute key %q", kv.Key))
			continue
		}
		v, vErrs := sanitizeValue(kv.Value.Value(), depth)
		if len(vErrs) > 0 {
			errs = append(errs, vErrs...)
			continue
		}
		out[kv.Key] = v
	}
	return out, errs
}

func sanitizeValue(v any, depth int) (any, []error) {
	switch t := v.(type) {
	case nil, bool, int64, float64:
		return v, nil
	case string:
		s, err := utf8String(t)
		if err != nil {
			return nil, []error{err}
		}
		return s, nil
	case []byte:
		// Binary attributes are preserved as hex fingerprints, never raw.
		return hex.EncodeToString(t), nil
	case []any:
		if depth+1 > maxAttrDepth {
			return nil, []error{fmt.Errorf("attribute nesting exceeds %d levels", maxAttrDepth)}
		}
		out := make([]any, 0, len(t))
		for _, e := range t {
			ev, errs := sanitizeValue(e, depth+1)
			if len(errs) > 0 {
				return nil, errs
			}
			out = append(out, ev)
		}
		return out, nil
	case map[string]any:
		if depth+1 > maxAttrDepth {
			return nil, []error{fmt.Errorf("attribute nesting exceeds %d levels", maxAttrDepth)}
		}
		out := make(map[string]any, len(t))
		for k, e := range t {
			if reservedAttrKeys[k] {
				continue
			}
			if !utf8.ValidString(k) {
				return nil, []error{fmt.Errorf("invalid attribute key %q", k)}
			}
			ev, errs := sanitizeValue(e, depth+1)
			if len(errs) > 0 {
				return nil, errs
			}
			out[k] = ev
		}
		return out, nil
	default:
		return fmt.Sprintf("%v", v), nil
	}
}

// countDropped counts reserved keys at the top level of a KeyValue list so
// the drop is visible in metrics and payloads.
func countDropped(kvs []KeyValue) int {
	n := 0
	for _, kv := range kvs {
		if reservedAttrKeys[kv.Key] {
			n++
		}
	}
	return n
}

func strAttr(attrs map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := attrs[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func intAttr(attrs map[string]any, keys ...string) (int64, bool) {
	for _, k := range keys {
		switch v := attrs[k].(type) {
		case int64:
			return v, true
		case float64:
			return int64(v), true
		}
	}
	return 0, false
}

// parseNano parses a proto3-JSON uint64 (decimal string).
func parseNano(s string) (uint64, error) {
	if s == "" {
		return 0, errors.New("missing")
	}
	return strconv.ParseUint(s, 10, 64)
}

func nsToMS(ns uint64) uint64 { return ns / 1_000_000 }

func minU64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

func maxU64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		// Payloads are pre-sanitized plain JSON types, so this is unreachable
		// in practice; the spine never stores a half-marshalled event.
		panic(fmt.Sprintf("otlp: payload marshal: %v", err))
	}
	return b
}

// rawStrAttr reads a string-valued attribute out of raw KeyValue pairs during
// the phase-1 scan, honouring KEY precedence rather than emit order: the keys
// are the outer loop and the attribute list the inner one, so the caller's
// ranking decides, exactly like strAttr does over a sanitized map. Looping the
// attributes first would let a span that carries both session.id and
// gen_ai.conversation.id resolve to whichever the SDK happened to append
// first, splitting one logical trace across two derived session ids.
//
// The candidate is validated through utf8String before it is accepted. The
// phase-1 scan feeds a TRACE-WIDE session key, so a span that phase 2 will
// reject for an unusable session.id must not donate that string to its
// accepted siblings' native_session_id.
func rawStrAttr(kvs []KeyValue, keys ...string) string {
	for _, k := range keys {
		for _, kv := range kvs {
			if kv.Key != k || kv.Value == nil {
				continue
			}
			s, ok := kv.Value.Value().(string)
			if !ok || s == "" {
				continue
			}
			valid, err := utf8String(s)
			if err != nil {
				continue
			}
			return valid
		}
	}
	return ""
}
