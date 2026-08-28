//go:build race

package storage

// raceDetectorMultiplier scales latency gate thresholds under the race
// detector. Instrumentation slows every append by roughly an order of
// magnitude, so the unmodified 5ms p95 gate flakes when the full suite runs
// concurrently on a loaded machine (observed 2026-08-28). The multiplier
// keeps the gate meaningful under instrumentation; the uninstrumented
// default still enforces the real roadmap budget. The absolute override
// HG_APPEND_P95_MAX_MS always wins.
const raceDetectorMultiplier = 25
