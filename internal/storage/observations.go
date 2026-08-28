package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ObsBucketNS is the width of the ts_bucket time partition on
// span_observations: 5 minutes in nanoseconds. Every hot query must carry a
// ts_bucket predicate (parity-plan rows 10); the query layer enforces it the
// same way SigNoz enforces ts_bucket_start.
const ObsBucketNS = int64(300) * 1_000_000_000

// BucketOf floors a nanosecond timestamp into its 5-minute bucket.
func BucketOf(ns int64) int64 { return ns / ObsBucketNS }

// ObsRow is one denormalized span observation (parity-plan row 9):
// trace-level attributes are copied onto every row so no hot read path
// joins traces against spans — the Langfuse V4 lesson applied to SQLite.
type ObsRow struct {
	SpanID       string `json:"span_id"`
	TraceID      string `json:"trace_id"`
	SessionID    string `json:"session_id,omitempty"`
	WorkstreamID string `json:"workstream_id,omitempty"`
	ParentSpanID string `json:"parent_span_id,omitempty"`
	Provider     string `json:"provider,omitempty"`
	Agent        string `json:"agent,omitempty"`
	Model        string `json:"model,omitempty"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	ToolName     string `json:"tool_name,omitempty"`
	StartedAtNS  int64  `json:"started_at_ns"`
	EndedAtNS    int64  `json:"ended_at_ns,omitempty"`
	DurationNS   int64  `json:"duration_ns,omitempty"`
	ExitCode     *int   `json:"exit_code,omitempty"`
	Sequence     int64  `json:"sequence"`
	Failed       bool   `json:"failed"`
	Fingerprint  string `json:"fingerprint"`
}

// ObsFingerprint groups the identity labels shared by many observations so
// high-cardinality filters prune via a tiny lookup table first (the
// resource-fingerprint pattern, parity-plan row 11).
type ObsFingerprint struct {
	Fingerprint string `json:"fingerprint"`
	Provider    string `json:"provider,omitempty"`
	Agent       string `json:"agent,omitempty"`
	Model       string `json:"model,omitempty"`
}

// ObsFilter selects observations. Time bounds are nanosecond epoch values;
// the query always prunes through ts_bucket (with one bucket of slack before
// FromNS so spans that started just before the window still match).
type ObsFilter struct {
	WorkstreamID string
	TraceID      string
	SessionID    string
	Agent        string
	Provider     string
	Model        string
	Kind         string
	Fingerprint  string
	Failed       *bool
	FromNS       int64
	ToNS         int64
	Limit        int
}

// ObsMeta describes the event-log snapshot the observations table was built
// from. A stale table is rebuilt before any query reads it.
type ObsMeta struct {
	EventCount int64     `json:"event_count"`
	MaxSeq     int64     `json:"max_seq"`
	RebuiltAt  time.Time `json:"rebuilt_at"`
}

// RebuildObservations atomically replaces the derived wide read model.
// Deterministic: identical rows always produce an identical table regardless
// of insert order (rows are written sorted; the reducer guarantees stable
// input).
func (d *DB) RebuildObservations(ctx context.Context, rows []ObsRow, prints []ObsFingerprint, meta ObsMeta) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM span_observations`); err != nil {
		return fmt.Errorf("clear observations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM span_fingerprints`); err != nil {
		return fmt.Errorf("clear fingerprints: %w", err)
	}

	// Sort before emitting: the reducer's output order is part of the
	// deterministic contract (AGENTS.md — sort before emitting).
	sortRows(rows)
	for _, r := range rows {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO span_observations
    (span_id, trace_id, session_id, workstream_id, parent_span_id, provider,
     agent, model, kind, name, status, tool_name, started_at_ns, ended_at_ns,
     duration_ns, exit_code, sequence, failed, fingerprint, ts_bucket)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			r.SpanID, r.TraceID, nullable(r.SessionID), nullable(r.WorkstreamID),
			nullable(r.ParentSpanID), nullable(r.Provider), nullable(r.Agent),
			nullable(r.Model), r.Kind, r.Name, r.Status, nullable(r.ToolName),
			r.StartedAtNS, nullableInt(r.EndedAtNS), nullableInt(r.DurationNS),
			r.ExitCode, r.Sequence, boolToInt(r.Failed), r.Fingerprint,
			BucketOf(r.StartedAtNS),
		); err != nil {
			return fmt.Errorf("insert observation %s: %w", r.SpanID, err)
		}
	}
	for _, f := range prints {
		if _, err := tx.ExecContext(ctx, `
INSERT OR REPLACE INTO span_fingerprints (fingerprint, provider, agent, model)
VALUES (?,?,?,?)`, f.Fingerprint, nullable(f.Provider), nullable(f.Agent), nullable(f.Model),
		); err != nil {
			return fmt.Errorf("insert fingerprint: %w", err)
		}
	}

	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO observations_meta (id, snapshot) VALUES (1, ?)
ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot`, string(raw)); err != nil {
		return fmt.Errorf("record snapshot: %w", err)
	}
	return tx.Commit()
}

// ObservationsStale reports whether the derived table is missing events.
func (d *DB) ObservationsStale(ctx context.Context) (bool, error) {
	var count int64
	var maxSeq int64
	if err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(seq),0) FROM events`).Scan(&count, &maxSeq); err != nil {
		return false, err
	}
	raw, err := d.sql.QueryContext(ctx, `SELECT snapshot FROM observations_meta WHERE id = 1`)
	if err != nil {
		return true, nil // no snapshot yet → stale by definition
	}
	defer raw.Close()
	if !raw.Next() {
		return true, nil
	}
	var snapshot string
	if err := raw.Scan(&snapshot); err != nil {
		return false, err
	}
	var meta ObsMeta
	if err := json.Unmarshal([]byte(snapshot), &meta); err != nil {
		return true, nil
	}
	return meta.EventCount != count || meta.MaxSeq != maxSeq, nil
}

// QueryObservations runs a ts_bucket-pruned query over the wide read model.
// It never scans the append-only events table.
func (d *DB) QueryObservations(ctx context.Context, f ObsFilter) ([]ObsRow, error) {
	where := []string{"1=1"}
	args := []any{}
	if f.FromNS > 0 {
		// Two-level filtering (the SigNoz pattern): the bucket predicate
		// prunes partitions the index can skip; the exact predicate keeps
		// results precise despite the one-bucket slack on the prune.
		where = append(where, "ts_bucket >= ?")
		args = append(args, BucketOf(f.FromNS)-1)
		where = append(where, "started_at_ns >= ?")
		args = append(args, f.FromNS)
	}
	if f.ToNS > 0 {
		where = append(where, "ts_bucket <= ?")
		args = append(args, BucketOf(f.ToNS))
		where = append(where, "started_at_ns <= ?")
		args = append(args, f.ToNS)
	}
	equals := func(col, val string) {
		if val != "" {
			where = append(where, col+" = ?")
			args = append(args, val)
		}
	}
	equals("workstream_id", f.WorkstreamID)
	equals("trace_id", f.TraceID)
	equals("session_id", f.SessionID)
	equals("agent", f.Agent)
	equals("provider", f.Provider)
	equals("model", f.Model)
	equals("kind", f.Kind)
	equals("fingerprint", f.Fingerprint)
	if f.Failed != nil {
		where = append(where, "failed = ?")
		args = append(args, boolToInt(*f.Failed))
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 500
	}
	q := `SELECT span_id, trace_id, session_id, workstream_id, parent_span_id,
        provider, agent, model, kind, name, status, tool_name, started_at_ns,
        ended_at_ns, duration_ns, exit_code, sequence, failed, fingerprint
        FROM span_observations WHERE ` + strings.Join(where, " AND ") + `
        ORDER BY started_at_ns, span_id LIMIT ?`
	args = append(args, limit)

	res, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer res.Close()

	out := []ObsRow{}
	for res.Next() {
		var r ObsRow
		var session, ws, parent, provider, agent, model, tool *string
		var ended, duration *int64
		if err := res.Scan(&r.SpanID, &r.TraceID, &session, &ws, &parent,
			&provider, &agent, &model, &r.Kind, &r.Name, &r.Status, &tool,
			&r.StartedAtNS, &ended, &duration, &r.ExitCode, &r.Sequence,
			&r.Failed, &r.Fingerprint); err != nil {
			return nil, err
		}
		deref := func(p *string) string {
			if p == nil {
				return ""
			}
			return *p
		}
		r.SessionID, r.WorkstreamID, r.ParentSpanID = deref(session), deref(ws), deref(parent)
		r.Provider, r.Agent, r.Model, r.ToolName = deref(provider), deref(agent), deref(model), deref(tool)
		if ended != nil {
			r.EndedAtNS = *ended
		}
		if duration != nil {
			r.DurationNS = *duration
		}
		out = append(out, r)
	}
	return out, res.Err()
}

// ListFingerprints returns the fingerprint lookup table (tiny by design).
func (d *DB) ListFingerprints(ctx context.Context) ([]ObsFingerprint, error) {
	res, err := d.sql.QueryContext(ctx,
		`SELECT fingerprint, provider, agent, model FROM span_fingerprints ORDER BY fingerprint`)
	if err != nil {
		return nil, err
	}
	defer res.Close()
	out := []ObsFingerprint{}
	for res.Next() {
		var f ObsFingerprint
		var p, a, m *string
		if err := res.Scan(&f.Fingerprint, &p, &a, &m); err != nil {
			return nil, err
		}
		deref := func(x *string) string {
			if x == nil {
				return ""
			}
			return *x
		}
		f.Provider, f.Agent, f.Model = deref(p), deref(a), deref(m)
		out = append(out, f)
	}
	return out, res.Err()
}

func sortRows(rows []ObsRow) {
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.StartedAtNS != b.StartedAtNS {
			return a.StartedAtNS < b.StartedAtNS
		}
		return a.SpanID < b.SpanID
	})
}

func nullableInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
