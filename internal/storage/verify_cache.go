package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// VerifyCacheSnapshot is the event-log fingerprint a cached `verify` report
// was computed from, scoped to one workstream (parity row 26 tail: "cached
// results"). It follows the same snapshot-freshness pattern as
// ObsMeta/ObservationsStale: a cached report is reusable only while the
// fingerprint it was built from still matches the live event log.
//
// DESIGN DECISION (orchestrator-made): the fingerprint deliberately excludes
// verification.recorded events from both EventCount and MaxSeq. Every
// `handoffgraph verify` run appends its own OBSERVED verification.recorded
// event so the gate stays evidenced (see verify_cmd.go) — if that append
// counted toward the fingerprint, the very act of recording one run's
// result would invalidate the cache entry that same run just wrote, and a
// second, otherwise-unchanged run could never hit the cache. No verify
// check reads events of kind verification.recorded (runVerifyChecks reads
// only traces/spans/scores/handoff events), so omitting them from the
// fingerprint can never hide a change that would flip a check's outcome:
// correctness holds while the cache stays usable across repeated runs.
type VerifyCacheSnapshot struct {
	EventCount int64 `json:"event_count"`
	MaxSeq     int64 `json:"max_seq"`
}

// computeVerifySnapshot computes the current cache-freshness fingerprint for
// workstreamID's events, excluding verification.recorded rows.
func (d *DB) computeVerifySnapshot(ctx context.Context, workstreamID string) (VerifyCacheSnapshot, error) {
	var snap VerifyCacheSnapshot
	err := d.sql.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(MAX(seq), 0) FROM events
WHERE workstream_id = ? AND kind != ?`,
		workstreamID, string(protocol.EventVerificationRecorded),
	).Scan(&snap.EventCount, &snap.MaxSeq)
	if err != nil {
		return VerifyCacheSnapshot{}, err
	}
	return snap, nil
}

// VerifySnapshotJSON returns the current cache-freshness fingerprint for
// workstreamID as canonical JSON, for the caller to persist via
// VerifyCacheSave alongside the report it was computed from.
func (d *DB) VerifySnapshotJSON(ctx context.Context, workstreamID string) (string, error) {
	snap, err := d.computeVerifySnapshot(ctx, workstreamID)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// VerifyCacheGet returns the cached verify report for workstreamID when the
// snapshot it was stored with still matches the workstream's current event
// log (excluding verification.recorded rows). ok is false on any kind of
// miss — no cached entry, a stale entry (the workstream gained
// non-verification events since the cache was written), or a malformed
// stored snapshot — never a hard error in that case; err is reserved for
// genuine query failures.
func (d *DB) VerifyCacheGet(ctx context.Context, workstreamID string) (reportJSON string, ok bool, err error) {
	var storedRaw string
	err = d.sql.QueryRowContext(ctx,
		`SELECT snapshot, report FROM verify_results WHERE workstream_id = ?`,
		workstreamID,
	).Scan(&storedRaw, &reportJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}

	var stored VerifyCacheSnapshot
	if jsonErr := json.Unmarshal([]byte(storedRaw), &stored); jsonErr != nil {
		return "", false, nil // malformed snapshot: treat as stale, not fatal
	}
	current, err := d.computeVerifySnapshot(ctx, workstreamID)
	if err != nil {
		return "", false, err
	}
	if stored != current {
		return "", false, nil
	}
	return reportJSON, true, nil
}

// VerifyCacheSave stores (or replaces) the cached verify report for
// workstreamID together with the snapshot it was computed from.
// snapshotJSON is normally obtained from VerifySnapshotJSON at the same
// point in the run the checks themselves were computed.
func (d *DB) VerifyCacheSave(ctx context.Context, workstreamID, snapshotJSON, reportJSON string) error {
	_, err := d.sql.ExecContext(ctx, `
INSERT INTO verify_results (workstream_id, snapshot, report, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(workstream_id) DO UPDATE SET
    snapshot   = excluded.snapshot,
    report     = excluded.report,
    created_at = excluded.created_at`,
		workstreamID, snapshotJSON, reportJSON, time.Now().UTC().UnixNano(),
	)
	return err
}
