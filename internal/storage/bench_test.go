package storage

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

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

// appendP95MaxMS returns the p95 assertion threshold in milliseconds.
// Default is the roadmap gate of 5ms. On slow or shared CI machines where
// 5ms cannot be met reliably, set HG_APPEND_P95_MAX_MS=<float> to override
// the threshold without editing the test.
func appendP95MaxMS() (float64, error) {
	if v := os.Getenv("HG_APPEND_P95_MAX_MS"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 {
			return 0, fmt.Errorf("invalid HG_APPEND_P95_MAX_MS %q: want positive number of milliseconds", v)
		}
		return f, nil
	}
	return 5, nil
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
		t.Fatalf("p95 append latency %v exceeds %.2fms gate (set HG_APPEND_P95_MAX_MS to override on slow machines)",
			p95, maxMS)
	}
}
