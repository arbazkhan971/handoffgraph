// Package observations derives the wide denormalized span-observation rows
// and identity fingerprints from the event log (parity-plan rows 9-11).
//
// Design provenance: the observations-first shape is the Langfuse V4 lesson
// (trace-level attributes copied onto every row; trace_id is a correlation
// handle), ts_bucket partitioning is the SigNoz/OpenObserve lesson, and the
// fingerprint lookup is SigNoz's resource-fingerprint pruning. All three are
// re-implemented on our append-only spine as pure functions of the event
// log — ideas only, no code from those projects (license hygiene).
//
// Determinism: DeriveRows is a pure function of the input; rows sort by
// (started_at_ns, span_id); fingerprints are sha256 of sorted label pairs.
package observations

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// Derive returns the observation rows and fingerprint rows for the event
// log. It never mutates its input.
func Derive(events []*protocol.Event) ([]storage.ObsRow, []storage.ObsFingerprint) {
	res := trace.Materialize(events)
	// Spans do not carry a workstream; the trace is the authority. Denormalize
	// it onto every row (that is the whole point of the wide table).
	wsByTrace := map[string]string{}
	for _, tr := range res.Traces {
		wsByTrace[tr.TraceID] = tr.WorkstreamID
	}
	rows := make([]storage.ObsRow, 0, len(res.Spans))
	for _, sp := range res.Spans {
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
			Failed:       sp.Status == "error" || sp.Status == "failed",
			Fingerprint:  Fingerprint(sp.Provider, sp.Agent, sp.Model),
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
	return rows, fps
}

// Fingerprint hashes the identity label tuple. Sorted-key construction means
// the same tuple always yields the same fingerprint.
func Fingerprint(provider, agent, model string) string {
	h := sha256.Sum256([]byte("provider=" + provider + "\x00agent=" + agent + "\x00model=" + model))
	return hex.EncodeToString(h[:12])
}
