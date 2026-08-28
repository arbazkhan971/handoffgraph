package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func openBenchDB(b *testing.B) *DB {
	b.Helper()
	db, err := Open(filepath.Join(b.TempDir(), "bench.db"))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { db.Close() })
	return db
}

// BenchmarkAppend measures single-event append latency against a real temp
// SQLite database. It opens the DB exactly like the storage tests (same
// migrations, same pragmas) via Open.
//
// Roadmap acceptance gate: p95 append < 5ms (HANDOVER.md §8 item 4).
func BenchmarkAppend(b *testing.B) {
	db := openBenchDB(b)
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)

	for i := 0; i < 100; i++ {
		ev := newEvent("ws_bench", "ses_bench",
			string(protocol.EventSessionStarted), base.Add(time.Duration(i)*time.Second))
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		ev := newEvent("ws_bench", "ses_bench",
			string(protocol.EventSessionStarted), base.Add(time.Duration(100+i)*time.Second))
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkAppendEvent measures raw ns/op for single-event appends through
// AppendEvent (marshal + INSERT OR IGNORE) against a real temp SQLite
// database. It asserts nothing beyond "no error" — it exists to report
// ns/op and allocations per append, complementing BenchmarkAppend (which
// uses the same store setup) and TestAppendLatencyP95 (which enforces the
// p95 < 5ms roadmap gate).
func BenchmarkAppendEvent(b *testing.B) {
	db := openBenchDB(b)
	ctx := context.Background()
	base := time.Now().UTC().Add(-2 * time.Hour)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ev := newEvent("ws_bench", "ses_bench",
			string(protocol.EventSpanStarted), base.Add(time.Duration(i)*time.Second))
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			b.Fatal(err)
		}
	}
}

// benchEvents builds exactly n deterministic events with a realistic kind
// mix (workstream/session spine, spans, commands, file edits, tests,
// decisions, logs) so the reducer and hasher do representative work.
func benchEvents(n int) []*protocol.Event {
	if n < 2 {
		n = 2
	}
	ws := ids.Workstream()
	session := ids.Session()
	traceID := ids.Trace()
	base := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)

	mk := func(i int, kind protocol.EventKind, payload any, parent []string) *protocol.Event {
		ev := newEvent(ws, session, string(kind), base.Add(time.Duration(i)*time.Second))
		ev.Sequence = int64(i)
		ev.ParentEventIDs = parent
		if payload != nil {
			raw, err := json.Marshal(payload)
			if err != nil {
				panic(err)
			}
			ev.Payload = raw
		}
		return ev
	}

	events := make([]*protocol.Event, 0, n)
	events = append(events,
		mk(0, protocol.EventWorkstreamStarted, map[string]any{"title": "bench workstream"}, nil),
		mk(1, protocol.EventSessionStarted, map[string]any{"native_session_id": "bench-session"}, nil),
	)
	kinds := []protocol.EventKind{
		protocol.EventSpanStarted,
		protocol.EventCommandCompleted,
		protocol.EventFileEdited,
		protocol.EventTestCompleted,
		protocol.EventDecisionRecorded,
		protocol.EventLogObserved,
	}
	for i := 2; i < n; i++ {
		kind := kinds[i%len(kinds)]
		var payload any
		switch kind {
		case protocol.EventSpanStarted:
			payload = map[string]any{"span_id": ids.Span(), "trace_id": traceID, "span_kind": "COMMAND", "name": fmt.Sprintf("command-%d", i)}
		case protocol.EventCommandCompleted:
			payload = map[string]any{"command": fmt.Sprintf("run-%d", i), "exit_code": 0}
		case protocol.EventFileEdited:
			payload = map[string]any{"path": fmt.Sprintf("src/file%d.go", i), "status": "edited", "content_hash": fmt.Sprintf("sha256:%064d", i)}
		case protocol.EventTestCompleted:
			payload = map[string]any{"name": fmt.Sprintf("Test%d", i), "result": "passed", "exit_code": 0}
		case protocol.EventDecisionRecorded:
			payload = map[string]any{"decision": fmt.Sprintf("decision %d", i), "rationale": "bench"}
		default:
			payload = map[string]any{"message": fmt.Sprintf("log line %d", i), "level": "info"}
		}
		events = append(events, mk(i, kind, payload, nil))
	}
	return events
}

// BenchmarkGraphHash10k measures ns/op for a full deterministic reduce +
// root-hash over a 10,000-event log (the roadmap's 10k-ingestion property's
// read-side twin). It asserts nothing about timing — it reports ns/op and
// allocations for graph.RootHashForEvents at the 10k scale.
//
// Note: the reducer's AddNode/AddEdge membership scans are linear, so cost
// grows super-linearly with log size (~seconds per reduce at 10k events on
// Apple Silicon at time of writing). The benchmark reports the truth; do
// not add a timing assertion here until the reducer is indexed.
func BenchmarkGraphHash10k(b *testing.B) {
	events := benchEvents(10_000)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := graph.RootHashForEvents(events); err != nil {
			b.Fatal(err)
		}
	}
}

// appendP95MaxMS returns the p95 assertion threshold in milliseconds.
// Default is the roadmap gate of 5ms. On slow or shared CI machines where
// 5ms cannot be met reliably, set HG_APPEND_P95_MAX_MS=<float> to override
// the threshold without editing the test. Under the race detector the
// default is scaled by raceDetectorMultiplier (instrumentation slows every
// append by ~an order of magnitude; the uninstrumented gate stays strict).
func appendP95MaxMS() (float64, error) {
	if v := os.Getenv("HG_APPEND_P95_MAX_MS"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 {
			return 0, fmt.Errorf("invalid HG_APPEND_P95_MAX_MS %q: want positive number of milliseconds", v)
		}
		return f, nil
	}
	return 5 * raceDetectorMultiplier, nil
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// TestAppendLatencyP95 records p50/p95/p99 append latency over direct timing
// of N appends and asserts the roadmap gate p95 < 5ms. Skipped under
// `go test -short`; runs as part of the normal suite. Total runtime is well
// under 10s (2200 appends).
func TestAppendLatencyP95(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping append-latency check in -short mode")
	}
	maxMS, err := appendP95MaxMS()
	if err != nil {
		t.Fatal(err)
	}

	db, _ := openTempDB(t)
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)

	const (
		warmup  = 200
		samples = 2000
	)
	appendAt := func(i int) error {
		ev := newEvent("ws_bench", "ses_bench",
			string(protocol.EventSessionStarted), base.Add(time.Duration(i)*time.Second))
		_, err := db.AppendEvent(ctx, ev)
		return err
	}
	for i := 0; i < warmup; i++ {
		if err := appendAt(i); err != nil {
			t.Fatal(err)
		}
	}

	durations := make([]time.Duration, 0, samples)
	for i := 0; i < samples; i++ {
		start := time.Now()
		if err := appendAt(warmup + i); err != nil {
			t.Fatal(err)
		}
		durations = append(durations, time.Since(start))
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })

	p50 := percentile(durations, 50)
	p95 := percentile(durations, 95)
	p99 := percentile(durations, 99)
	t.Logf("append latency over %d samples: p50=%v p95=%v p99=%v",
		samples, p50, p95, p99)

	limit := time.Duration(maxMS * float64(time.Millisecond))
	if p95 >= limit {
		// One re-measure on breach: when the full suite runs in parallel,
		// machine-load spikes can push a single sample set over the gate even
		// though steady-state p95 sits ~25x under it. A real regression blows
		// the gate on both measures.
		t.Logf("p95 %v exceeded %.2fms; re-measuring once (possible load spike)", p95, maxMS)
		durations = durations[:0]
		for i := 0; i < samples; i++ {
			start := time.Now()
			if err := appendAt(warmup + samples + i); err != nil {
				t.Fatal(err)
			}
			durations = append(durations, time.Since(start))
		}
		sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
		p95 = percentile(durations, 95)
		t.Logf("re-measured p95=%v", p95)
		if p95 >= limit {
			t.Fatalf("p95 append latency %v exceeds %.2fms gate on re-measure (set HG_APPEND_P95_MAX_MS to override on slow machines)",
				p95, maxMS)
		}
	}
}
