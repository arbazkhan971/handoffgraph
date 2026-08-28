// Package observations derives the wide denormalized span-observation rows
// and identity fingerprints from the event log (parity-plan rows 9-13).
//
// Design provenance: the observations-first shape is the Langfuse V4 lesson
// (trace-level attributes copied onto every row; trace_id is a correlation
// handle), ts_bucket partitioning is the SigNoz/OpenObserve lesson, and the
// fingerprint lookup is SigNoz's resource-fingerprint pruning. Typed
// attribute promotion (row 12) and derived exception groups (row 13) follow
// the same shape. All are re-implemented on our append-only spine as pure
// functions of the event log — ideas only, no code from those projects
// (license hygiene).
//
// Determinism: DeriveAll is a pure function of the input. Rows sort by
// (started_at_ns, span_id); fingerprints are sha256 of sorted label pairs;
// coalescing verdicts are computed from the whole row set with total-order
// tie-breaks, so a shuffled event log produces identical output.
package observations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// Result is the full derived read model for one event log.
type Result struct {
	Rows            []storage.ObsRow
	Fingerprints    []storage.ObsFingerprint
	ExceptionGroups []storage.ExceptionGroup
}

// Derive returns the observation rows and fingerprint rows for the event
// log. It never mutates its input.
func Derive(events []*protocol.Event) ([]storage.ObsRow, []storage.ObsFingerprint) {
	res := DeriveAll(events)
	return res.Rows, res.Fingerprints
}

// DeriveAll builds every table derived from the event log in one pass:
// observation rows (with promoted columns and coalescing verdicts),
// fingerprints, and exception groups.
func DeriveAll(events []*protocol.Event) Result {
	res := trace.Materialize(events)
	// Spans do not carry a workstream; the trace is the authority. Denormalize
	// it onto every row (that is the whole point of the wide table).
	wsByTrace := map[string]string{}
	for _, tr := range res.Traces {
		wsByTrace[tr.TraceID] = tr.WorkstreamID
	}
	bySpan, bySession := collectFacts(events)

	rows := make([]storage.ObsRow, 0, len(res.Spans))
	for _, sp := range res.Spans {
		f := factsFor(sp.SpanID, sp.SessionID, bySpan, bySession)
		failed := sp.Status == "error" || sp.Status == "failed"
		errType := f.errorType
		if errType == "" && failed {
			// A failure with no exception.type still has a class: fall back to
			// the span status so the promoted column is never empty for a
			// failed span.
			errType = sp.Status
		}
		canonicalProvider := CanonicalProvider(sp.Provider, sp.Agent)
		rows = append(rows, storage.ObsRow{
			SpanID:       sp.SpanID,
			TraceID:      sp.TraceID,
			SessionID:    sp.SessionID,
			WorkstreamID: wsByTrace[sp.TraceID],
			ParentSpanID: sp.ParentSpanID,
			Provider:     sp.Provider,
			Agent:        sp.Agent,
			Model:        sp.Model,
			Kind:         string(sp.Kind),
			Name:         sp.Name,
			Status:       sp.Status,
			ToolName:     sp.ToolName,
			StartedAtNS:  sp.StartedAtNS,
			EndedAtNS:    sp.EndedAtNS,
			DurationNS:   sp.EndedAtNS - sp.StartedAtNS,
			ExitCode:     sp.ExitCode,
			Sequence:     sp.Sequence,
			Failed:       failed,
			Fingerprint:  Fingerprint(sp.Provider, sp.Agent, sp.Model),

			// Promotion (row 12): hot attributes become typed columns and
			// presence markers so filters never scan a JSON payload.
			ErrorType:      errType,
			ToolNameExists: sp.ToolName != "",
			ModelExists:    sp.Model != "",
			ErrorExists:    failed || errType != "",
			UsageExists:    f.hasUsage,

			// Coalescing (row 5): recorded per row here; the canonical
			// session and shadow verdicts need the whole set and are applied
			// by coalesce below.
			SignalSource: string(f.signal),
			CoalesceKey:  CoalesceKey(canonicalProvider, f.nativeSession),
		})
	}
	// Deterministic row order (started_at_ns, span_id) — matches the query
	// output ordering and keeps rebuilds byte-stable.
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.StartedAtNS != b.StartedAtNS {
			return a.StartedAtNS < b.StartedAtNS
		}
		return a.SpanID < b.SpanID
	})
	coalesce(rows)

	return Result{
		Rows:            rows,
		Fingerprints:    fingerprintsOf(rows),
		ExceptionGroups: groupExceptions(rows, bySpan, bySession),
	}
}

// spanFacts are the per-span facts read straight off the event payloads,
// which the materialized span model does not carry (attributes, exception
// details, the emitting pipeline).
//
// Merging is commutative so a shuffled event log yields identical facts: the
// signal source takes the strongest declaration, strings take the first
// non-empty value and break conflicts lexicographically, and flags are OR-ed.
type spanFacts struct {
	signal         SignalSource
	signalDeclared bool
	nativeSession  string
	errorType      string
	// exceptionMessage comes from exception.message and describes the
	// failure; statusMessage is the span's coarser status text. They are
	// kept apart so the richer one always wins, rather than the two
	// competing through a tie-break that would pick by spelling.
	exceptionMessage string
	statusMessage    string
	topFrame         string
	hasUsage         bool
}

// message returns the best available description of the failure.
func (f spanFacts) message() string {
	if f.exceptionMessage != "" {
		return f.exceptionMessage
	}
	return f.statusMessage
}

func (f *spanFacts) merge(o spanFacts) {
	// An explicit declaration outranks a heuristic; between two declarations
	// (or two heuristics) the higher-precedence source wins. Both rules are
	// order-independent.
	switch {
	case o.signalDeclared && !f.signalDeclared:
		f.signal, f.signalDeclared = o.signal, true
	case o.signalDeclared == f.signalDeclared && Precedence(o.signal) > Precedence(f.signal):
		f.signal = o.signal
	}
	f.nativeSession = mergeStr(f.nativeSession, o.nativeSession)
	f.errorType = mergeStr(f.errorType, o.errorType)
	f.exceptionMessage = mergeStr(f.exceptionMessage, o.exceptionMessage)
	f.statusMessage = mergeStr(f.statusMessage, o.statusMessage)
	f.topFrame = mergeStr(f.topFrame, o.topFrame)
	f.hasUsage = f.hasUsage || o.hasUsage
}

// mergeStr combines two observations of the same field without depending on
// which arrived first: a non-empty value beats an empty one, and two
// different non-empty values resolve to the lexicographically smaller.
func mergeStr(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	case b < a:
		return b
	default:
		return a
	}
}

// usageAttrPrefixes mark token-usage attributes. Their presence is what the
// usage_exists promoted marker records.
var usageAttrPrefixes = []string{
	"gen_ai.usage.",
	"llm.token_count.",
	"gen_ai.client.token.usage",
}

// collectFacts scans the event log once and indexes span facts by span id and
// by session id. The session index is the fallback for spans whose events did
// not name a span_id, so a session's signal source still reaches its rows.
func collectFacts(events []*protocol.Event) (map[string]*spanFacts, map[string]*spanFacts) {
	bySpan := map[string]*spanFacts{}
	bySession := map[string]*spanFacts{}
	for _, ev := range events {
		payload := decodePayload(ev)
		attrs, _ := payload["attributes"].(map[string]any)
		manifest := payloadStrings(payload, "attribute_keys")
		signal, declared := DeriveSignalSource(ev.Provider, attrs, manifest...)

		f := spanFacts{
			signal:         signal,
			signalDeclared: declared,
			nativeSession:  ev.NativeSessionID,
			hasUsage:       hasUsageAttr(attrs) || hasUsageKeys(manifest),
			// Exception attributes are read whatever the span's status: OTel
			// records a handled exception on a span that still succeeded, and
			// error_exists is meant to say "this span carries error
			// information", which is a different question from "it failed".
			errorType:        attrStr(attrs, "exception.type", "error.type"),
			exceptionMessage: attrStr(attrs, "exception.message", "error.message"),
			topFrame:         TopFrame(attrStr(attrs, "exception.stacktrace", "error.stack")),
		}
		if ev.Kind == protocol.EventSpanFailed || payloadStr(payload, "error") != "" {
			f.statusMessage = payloadStr(payload, "error")
		}

		spanID := payloadStr(payload, "span_id")
		if spanID == "" {
			// The materializer falls back to the event id when a payload
			// carries no span_id; mirror that so facts still land on the row.
			spanID = ev.EventID
		}
		mergeInto(bySpan, spanID, f)
		if ev.SessionID != "" {
			mergeInto(bySession, ev.SessionID, f)
		}
	}
	return bySpan, bySession
}

func mergeInto(m map[string]*spanFacts, key string, f spanFacts) {
	cur, ok := m[key]
	if !ok {
		cp := f
		m[key] = &cp
		return
	}
	cur.merge(f)
}

// factsFor resolves a span's facts, falling back to its session's facts and
// finally to an import-classified default (we saw the span but learned
// nothing about how it reached us).
func factsFor(spanID, sessionID string, bySpan, bySession map[string]*spanFacts) spanFacts {
	if f, ok := bySpan[spanID]; ok {
		return *f
	}
	if f, ok := bySession[sessionID]; ok {
		return *f
	}
	return spanFacts{signal: SignalImport}
}

// coalesce applies the cross-pipeline verdicts (parity-plan row 5) in place.
//
// Two passes, both pure functions of the row set:
//
//  1. Per coalesce key, pick the canonical signal source (highest
//     precedence) and the canonical session id (the smallest session id
//     among rows carrying that source). Every row in the group records the
//     same canonical session, so the read models present ONE session for a
//     logical run no matter how many pipelines reported it.
//  2. Per logical span, shadow the observations that came from a
//     lower-precedence source than the best source that saw that same span.
//     Only genuine duplicates are shadowed: evidence a weaker pipeline saw
//     alone stays visible, because dropping it would lose a fact rather than
//     de-duplicate one.
func coalesce(rows []storage.ObsRow) {
	type group struct {
		best    int
		session string
	}
	groups := map[string]*group{}
	for i := range rows {
		key := rows[i].CoalesceKey
		if key == "" {
			continue
		}
		p := Precedence(SignalSource(rows[i].SignalSource))
		g, ok := groups[key]
		if !ok {
			groups[key] = &group{best: p, session: rows[i].SessionID}
			continue
		}
		switch {
		case p > g.best:
			g.best, g.session = p, rows[i].SessionID
		case p == g.best && rows[i].SessionID != "" &&
			(g.session == "" || rows[i].SessionID < g.session):
			// Lexicographic tie-break: the canonical session must not depend
			// on which pipeline's events were imported first.
			g.session = rows[i].SessionID
		}
	}

	// Best source per logical span, then the shadow verdict.
	bestBySpan := map[string]int{}
	for i := range rows {
		if rows[i].CoalesceKey == "" {
			continue
		}
		key := logicalSpanKey(&rows[i])
		if p := Precedence(SignalSource(rows[i].SignalSource)); p > bestBySpan[key] {
			bestBySpan[key] = p
		}
	}
	for i := range rows {
		key := rows[i].CoalesceKey
		if key == "" {
			continue
		}
		if g, ok := groups[key]; ok {
			rows[i].CanonicalSessionID = g.session
		}
		lk := logicalSpanKey(&rows[i])
		rows[i].Shadowed = Precedence(SignalSource(rows[i].SignalSource)) < bestBySpan[lk]
	}
}

// shadowGranularityNS is how precisely two pipelines must agree on a span's
// start before they are treated as describing the same logical span. One
// millisecond: independent observers of one run read the same clock, so they
// agree to well under a millisecond, while two genuinely distinct spans in
// one session practically never share a kind, a name, a tool AND a
// millisecond. The bias is deliberate — being too strict merely leaves a
// duplicate visible, whereas being too loose would hide real evidence.
const shadowGranularityNS = int64(1_000_000)

// logicalSpanKey identifies "the same span" across pipelines.
//
// It deliberately does NOT use the vendor's own span id. When two pipelines
// both preserve that id they derive the same span id, the same event id, and
// the append layer has already collapsed them into one row — there is nothing
// left to coalesce. The case that reaches here is the one where the ids
// differ (a vendor-native export next to a hook adapter watching the same
// session), and there the only common ground is the span's shape within the
// session plus when it started.
func logicalSpanKey(r *storage.ObsRow) string {
	return r.CoalesceKey + "\x00" +
		strings.ToLower(r.Kind) + "\x00" +
		strings.ToLower(r.Name) + "\x00" +
		strings.ToLower(r.ToolName) + "\x00" +
		strconv.FormatInt(r.StartedAtNS/shadowGranularityNS, 10)
}

// groupExceptions folds error-status spans into derived exception groups
// (parity-plan row 13). Shadowed rows are excluded: they are duplicates of a
// failure another pipeline already reported, and counting them twice would
// misstate how often the bug actually happened.
func groupExceptions(rows []storage.ObsRow, bySpan, bySession map[string]*spanFacts) []storage.ExceptionGroup {
	agg := map[string]*storage.ExceptionGroup{}
	for i := range rows {
		r := &rows[i]
		if !r.Failed || r.Shadowed {
			continue
		}
		f := factsFor(r.SpanID, r.SessionID, bySpan, bySession)
		errType := f.errorType
		if errType == "" {
			errType = r.ErrorType
		}
		if errType == "" {
			errType = "error"
		}
		message := f.message()
		if message == "" {
			// No exception message and no status message: the span name is
			// the only description of what failed.
			message = r.Name
		}
		template := NormalizeMessage(message)
		frame := NormalizeFrame(f.topFrame)
		hash := GroupHash(errType, template, frame)

		key := r.WorkstreamID + "\x00" + hash
		g, ok := agg[key]
		if !ok {
			agg[key] = &storage.ExceptionGroup{
				GroupHash:       hash,
				WorkstreamID:    r.WorkstreamID,
				ErrorType:       errType,
				MessageTemplate: template,
				TopFrame:        frame,
				FirstSeenNS:     r.StartedAtNS,
				LastSeenNS:      r.StartedAtNS,
				SpanCount:       1,
				SampleSpanID:    r.SpanID,
			}
			continue
		}
		g.SpanCount++
		if r.StartedAtNS < g.FirstSeenNS {
			g.FirstSeenNS = r.StartedAtNS
		}
		if r.StartedAtNS > g.LastSeenNS {
			g.LastSeenNS = r.StartedAtNS
		}
		if r.SpanID < g.SampleSpanID {
			// Smallest span id wins so the sample is a pure function of the
			// group's members, not of iteration order.
			g.SampleSpanID = r.SpanID
		}
	}
	keys := make([]string, 0, len(agg))
	for k := range agg {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]storage.ExceptionGroup, 0, len(keys))
	for _, k := range keys {
		out = append(out, *agg[k])
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SpanCount != out[j].SpanCount {
			return out[i].SpanCount > out[j].SpanCount
		}
		if out[i].WorkstreamID != out[j].WorkstreamID {
			return out[i].WorkstreamID < out[j].WorkstreamID
		}
		return out[i].GroupHash < out[j].GroupHash
	})
	return out
}

func fingerprintsOf(rows []storage.ObsRow) []storage.ObsFingerprint {
	prints := map[string]storage.ObsFingerprint{}
	for _, r := range rows {
		if _, ok := prints[r.Fingerprint]; !ok {
			prints[r.Fingerprint] = storage.ObsFingerprint{
				Fingerprint: r.Fingerprint,
				Provider:    r.Provider,
				Agent:       r.Agent,
				Model:       r.Model,
			}
		}
	}
	keys := make([]string, 0, len(prints))
	for k := range prints {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fps := make([]storage.ObsFingerprint, 0, len(keys))
	for _, k := range keys {
		fps = append(fps, prints[k])
	}
	return fps
}

// Fingerprint hashes the identity label tuple. Sorted-key construction means
// the same tuple always yields the same fingerprint.
func Fingerprint(provider, agent, model string) string {
	h := sha256.Sum256([]byte("provider=" + provider + "\x00agent=" + agent + "\x00model=" + model))
	return hex.EncodeToString(h[:12])
}

func decodePayload(ev *protocol.Event) map[string]any {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	return m
}

func payloadStr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func attrStr(attrs map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := attrs[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func hasUsageAttr(attrs map[string]any) bool {
	for k := range attrs {
		if isUsageKey(k) {
			return true
		}
	}
	return false
}

// hasUsageKeys reads the minimal-tier key manifest, where the keys survive
// but the values do not — enough to answer "was usage reported at all".
func hasUsageKeys(keys []string) bool {
	for _, k := range keys {
		if isUsageKey(k) {
			return true
		}
	}
	return false
}

func isUsageKey(key string) bool {
	lk := strings.ToLower(key)
	for _, p := range usageAttrPrefixes {
		if strings.HasPrefix(lk, p) {
			return true
		}
	}
	return false
}

// payloadStrings reads a JSON string array from a payload field.
func payloadStrings(m map[string]any, key string) []string {
	raw, ok := m[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
