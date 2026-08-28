//go:build !race

package storage

// raceDetectorMultiplier scales latency gate thresholds. Without the race
// detector the measured budget applies as written.
const raceDetectorMultiplier = 1
