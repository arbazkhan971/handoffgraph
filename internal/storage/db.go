// Package storage implements the local SQLite persistence layer: migrations,
// the append-only event store, and derived graph/trace read models.
//
// Design rules (from the roadmap):
//   - Migrations are ordered, run in a transaction, and record the schema
//     version in a dedicated migration table plus SQLite user_version.
//   - Raw event objects are never rewritten during a normal migration.
//   - A timestamped backup is created before any destructive migration.
//   - WAL mode is enabled for crash safety.
package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// ErrNotFound is returned when a requested record does not exist.
var ErrNotFound = errors.New("not found")

// DB wraps the SQLite connection.
type DB struct {
	sql *sql.DB
}

// Open opens (and migrates) the database at path.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("db parent dir: %w", err)
	}
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	sdb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	sdb.SetMaxOpenConns(1) // SQLite: single writer avoids SQLITE_BUSY

	db := &DB{sql: sdb}
	if err := db.migrate(path); err != nil {
		sdb.Close()
		return nil, err
	}
	return db, nil
}

// Close closes the underlying connection.
func (d *DB) Close() error { return d.sql.Close() }

// Ping verifies the connection is usable.
func (d *DB) Ping(ctx context.Context) error { return d.sql.PingContext(ctx) }

// migration is a single ordered schema migration.
type migration struct {
	version int
	sql     string
}

var migrations = []migration{
	{1, `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
`},
	{2, `
CREATE TABLE IF NOT EXISTS events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL UNIQUE,
    occurred_at  INTEGER NOT NULL,
    observed_at  INTEGER NOT NULL,
    workstream_id TEXT,
    session_id    TEXT,
    native_session_id TEXT,
    provider      TEXT,
    kind          TEXT NOT NULL,
    provenance    TEXT,
    content_hash  TEXT,
    raw_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_workstream ON events(workstream_id);
CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
`},
	{3, `
CREATE TABLE IF NOT EXISTS workstreams (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    repository_id TEXT,
    created_at INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active'
);
`},
	{4, `
CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    workstream_id TEXT,
    provider     TEXT NOT NULL,
    native_session_id TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
`},
	{5, `
CREATE TABLE IF NOT EXISTS traces (
    trace_id       TEXT PRIMARY KEY,
    workstream_id  TEXT NOT NULL,
    session_id     TEXT,
    provider       TEXT,
    status         TEXT NOT NULL,
    started_at_ns  INTEGER NOT NULL,
    ended_at_ns    INTEGER,
    duration_ns    INTEGER,
    span_count     INTEGER NOT NULL DEFAULT 0,
    failed_span_count INTEGER NOT NULL DEFAULT 0,
    changed_file_count INTEGER NOT NULL DEFAULT 0,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    root_span_id   TEXT,
    graph_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_workstream ON traces(workstream_id);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
`},
	{6, `
CREATE TABLE IF NOT EXISTS spans (
    span_id        TEXT PRIMARY KEY,
    trace_id       TEXT NOT NULL,
    parent_span_id TEXT,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL,
    started_at_ns  INTEGER NOT NULL,
    ended_at_ns    INTEGER,
    sequence       INTEGER NOT NULL,
    provider       TEXT,
    model          TEXT,
    tool_name      TEXT,
    exit_code      INTEGER,
    evidence_level TEXT,
    raw_json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
`},
	{7, `
CREATE TABLE IF NOT EXISTS graph_nodes (
    id       TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    label    TEXT NOT NULL,
    attrs    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges (
    source   TEXT NOT NULL,
    relation TEXT NOT NULL,
    target   TEXT NOT NULL,
    PRIMARY KEY (source, relation, target)
);
`},
	{8, `
CREATE TABLE IF NOT EXISTS checkpoints (
    id            TEXT PRIMARY KEY,
    workstream_id TEXT NOT NULL,
    objective     TEXT,
    status        TEXT,
    graph_hash    TEXT,
    score         INTEGER,
    created_at    INTEGER NOT NULL,
    raw_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_workstream ON checkpoints(workstream_id);
`},
	{9, `
-- Wide denormalized span observations (parity-plan rows 9-11): trace-level
-- attributes copied onto every row; ts_bucket partitions every hot query;
-- fingerprints pre-group identity labels. Fully derived + rebuildable.
CREATE TABLE IF NOT EXISTS span_observations (
    span_id        TEXT PRIMARY KEY,
    trace_id       TEXT NOT NULL,
    session_id     TEXT,
    workstream_id  TEXT,
    parent_span_id TEXT,
    provider       TEXT,
    agent          TEXT,
    model          TEXT,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL,
    tool_name      TEXT,
    started_at_ns  INTEGER NOT NULL,
    ended_at_ns    INTEGER,
    duration_ns    INTEGER,
    exit_code      INTEGER,
    sequence       INTEGER NOT NULL,
    failed         INTEGER NOT NULL DEFAULT 0,
    fingerprint    TEXT NOT NULL DEFAULT '',
    ts_bucket      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_bucket    ON span_observations(ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_ws_bucket ON span_observations(workstream_id, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_trace     ON span_observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_session   ON span_observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_fp        ON span_observations(fingerprint, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_agent     ON span_observations(agent, ts_bucket);
CREATE TABLE IF NOT EXISTS span_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    provider    TEXT,
    agent       TEXT,
    model       TEXT
);
CREATE TABLE IF NOT EXISTS observations_meta (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL
);
`},
	{10, `
-- Typed attribute promotion (parity-plan row 12) and native-vendor signal
-- coalescing (parity-plan row 5), both on the derived observation table.
--
-- Promotion: the hot filters (tool, model, error class) become real indexed
-- columns instead of predicates over a JSON attribute blob, and each hot
-- attribute gets an *_exists marker so "was this attribute present at all"
-- is an indexed integer comparison rather than a scan. Ideas from the
-- typed-column promotion pattern in ClickHouse-backed tracing backends,
-- re-implemented on SQLite.
--
-- Coalescing: signal_source records which pipeline observed the span
-- (native > hook > sdk > import); coalesce_key is the logical session the
-- span belongs to across pipelines; canonical_session_id names the one
-- session the read models present for that key; is_shadowed records the
-- verdict for a lower-precedence duplicate of the same logical span.
-- Shadowed rows are kept, never deleted: the derived table encodes the
-- verdict so it can be inspected and re-derived.
--
-- Every column here is rebuilt from the append-only event log.
ALTER TABLE span_observations ADD COLUMN error_type TEXT;
ALTER TABLE span_observations ADD COLUMN tool_name_exists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE span_observations ADD COLUMN model_exists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE span_observations ADD COLUMN error_exists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE span_observations ADD COLUMN usage_exists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE span_observations ADD COLUMN signal_source TEXT NOT NULL DEFAULT 'import';
ALTER TABLE span_observations ADD COLUMN coalesce_key TEXT NOT NULL DEFAULT '';
ALTER TABLE span_observations ADD COLUMN canonical_session_id TEXT;
ALTER TABLE span_observations ADD COLUMN is_shadowed INTEGER NOT NULL DEFAULT 0;
-- One index per promoted filter. is_shadowed deliberately has NO index of
-- its own: it is a near-constant column, and an index on it would tempt the
-- planner away from the selective promoted index on every default query
-- (which always carries is_shadowed = 0). It stays a cheap post-filter.
CREATE INDEX IF NOT EXISTS idx_obs_tool     ON span_observations(tool_name, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_model    ON span_observations(model, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_error    ON span_observations(error_exists, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_etype    ON span_observations(error_type, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_signal   ON span_observations(signal_source, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_obs_coalesce ON span_observations(coalesce_key);
`},
	{11, `
-- Derived exception groups (parity-plan row 13): error-status spans folded
-- into stable groups keyed by a deterministic hash over
-- (error_type | normalized message template | top stack frame). The
-- normalization replaces the parts that vary between otherwise-identical
-- failures (digit runs, uuids, hex ids, quoted strings, paths) so the same
-- bug lands in the same group across runs and machines.
--
-- Fully derived: rebuilt from the event log in the same transaction as
-- span_observations, never mutated in place.
CREATE TABLE IF NOT EXISTS exception_groups (
    group_hash       TEXT NOT NULL,
    workstream_id    TEXT NOT NULL,
    error_type       TEXT NOT NULL,
    message_template TEXT NOT NULL,
    top_frame        TEXT NOT NULL DEFAULT '',
    first_seen_ns    INTEGER NOT NULL,
    last_seen_ns     INTEGER NOT NULL,
    span_count       INTEGER NOT NULL DEFAULT 0,
    sample_span_id   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (workstream_id, group_hash)
);
CREATE INDEX IF NOT EXISTS idx_exc_count ON exception_groups(workstream_id, span_count DESC);
CREATE INDEX IF NOT EXISTS idx_exc_type  ON exception_groups(error_type);
`},
	{12, `
-- Cached verify reports (parity row 26 tail: "cached results"). Keyed by
-- workstream; snapshot is the freshness fingerprint from
-- storage.VerifySnapshotJSON (event_count/max_seq over that workstream's
-- events, excluding verification.recorded rows — see verify_cache.go for
-- why). Fully derived from the event log and safe to drop/rebuild.
CREATE TABLE IF NOT EXISTS verify_results (
    workstream_id TEXT PRIMARY KEY,
    snapshot      TEXT NOT NULL,
    report        TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
`},
}

// migrate applies pending migrations in order.
func (d *DB) migrate(path string) error {
	// Apply the built-in schema_migrations table first so it always exists.
	if _, err := d.sql.Exec(migrations[0].sql); err != nil {
		return fmt.Errorf("migration 0: %w", err)
	}

	current, err := d.schemaVersion()
	if err != nil {
		return err
	}

	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		if err := d.applyMigration(path, m); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) applyMigration(path string, m migration) error {
	backup, err := d.backup(path)
	if err != nil {
		return err
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(m.sql); err != nil {
		tx.Rollback()
		return fmt.Errorf("migration %d: %w", m.version, err)
	}
	if _, err := tx.Exec(
		"INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)",
		m.version, time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		tx.Rollback()
		return fmt.Errorf("record migration %d: %w", m.version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %d: %w", m.version, err)
	}
	if err := d.setUserVersion(m.version); err != nil {
		return err
	}
	_ = backup // retained for the operation; kept on failure or success
	return nil
}

func (d *DB) schemaVersion() (int, error) {
	var v int
	err := d.sql.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&v)
	return v, err
}

func (d *DB) setUserVersion(v int) error {
	_, err := d.sql.Exec(fmt.Sprintf("PRAGMA user_version = %d", v))
	return err
}

// UserVersion returns the SQLite user_version pragma value.
func (d *DB) UserVersion() (int, error) {
	var v int
	err := d.sql.QueryRow("PRAGMA user_version").Scan(&v)
	return v, err
}

// SchemaVersion returns the highest applied migration version.
func (d *DB) SchemaVersion() (int, error) { return d.schemaVersion() }

// LatestSchemaVersion returns the newest migration version this running
// binary knows about (the last entry's declared version, not the slice
// length — migration numbers can carry gaps when they were assigned to
// parallel work ahead of merge). Health checks (`doctor --verify`) compare
// the applied schema against this to catch a binary/database mismatch.
func LatestSchemaVersion() int {
	if len(migrations) == 0 {
		return 0
	}
	return migrations[len(migrations)-1].version
}

// MaxSeq returns the highest event sequence number, or 0 when the events
// table is empty. Paired with EventCount for health checks and caches that
// need a cheap fingerprint of "how much log there is".
func (d *DB) MaxSeq(ctx context.Context) (int64, error) {
	var maxSeq int64
	err := d.sql.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM events`).Scan(&maxSeq)
	return maxSeq, err
}

// TableExists reports whether name is a table in this database, probed via
// sqlite_master rather than assumed. Used by `reset` to clear only the
// derived tables that actually exist in the running binary's schema (some
// table names in that list are forward-looking and may not be present
// yet).
func (d *DB) TableExists(ctx context.Context, name string) (bool, error) {
	var found string
	err := d.sql.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ClearTable deletes every row from a table. name must come from a
// compile-time constant list the caller controls (never from external or
// user input): the identifier is concatenated directly, since
// database/sql placeholders bind values, not identifiers.
func (d *DB) ClearTable(ctx context.Context, name string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM `+name)
	return err
}

// backup creates a timestamped copy of the database file before a migration.
// It is best-effort: for a brand-new database there is nothing to copy.
func (d *DB) backup(path string) (string, error) {
	if _, err := os.Stat(path); err != nil {
		return "", nil // new database, nothing to back up
	}
	backup := path + ".bak." + time.Now().UTC().Format("20060102T150405.000")
	src, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("backup read: %w", err)
	}
	if err := os.WriteFile(backup, src, 0o600); err != nil {
		return "", fmt.Errorf("backup write: %w", err)
	}
	return backup, nil
}

// StoredEvent is the row representation of an event.
type StoredEvent struct {
	Seq             int64
	EventID         string
	OccurredAt      time.Time
	ObservedAt      time.Time
	WorkstreamID    string
	SessionID       string
	NativeSessionID string
	Provider        string
	Kind            string
	Provenance      string
	ContentHash     string
	Raw             json.RawMessage
}

// AppendEvent inserts an event if its event_id has not been seen before.
// It returns (false, nil) when the event is a duplicate. Appends are
// idempotent and preserve out-of-order input by relying on occurred_at for
// ordering rather than the auto-increment sequence.
func (d *DB) AppendEvent(ctx context.Context, ev *protocol.Event) (bool, error) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return false, err
	}
	res, err := d.sql.ExecContext(ctx, `
INSERT OR IGNORE INTO events
    (event_id, occurred_at, observed_at, workstream_id, session_id,
     native_session_id, provider, kind, provenance, content_hash, raw_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ev.EventID, ev.OccurredAt.UnixNano(), ev.ObservedAt.UnixNano(),
		nullable(ev.WorkstreamID), nullable(ev.SessionID),
		nullable(ev.NativeSessionID), nullable(ev.Provider),
		string(ev.Kind), nullable(string(ev.Provenance)),
		nullable(ev.ContentHash), string(raw),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// EventCount returns the total number of stored events.
func (d *DB) EventCount(ctx context.Context) (int64, error) {
	var n int64
	err := d.sql.QueryRowContext(ctx, "SELECT COUNT(*) FROM events").Scan(&n)
	return n, err
}

// ListEvents returns events ordered by occurred_at, then sequence, for the
// deterministic reducer.
func (d *DB) ListEvents(ctx context.Context) ([]*protocol.Event, error) {
	rows, err := d.sql.QueryContext(ctx, `
SELECT event_id, occurred_at, observed_at, workstream_id, session_id,
       native_session_id, provider, kind, provenance, content_hash, raw_json
FROM events ORDER BY occurred_at, seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*protocol.Event
	for rows.Next() {
		var (
			eventID     string
			occ         int64
			obs         int64
			workstream  sql.NullString
			session     sql.NullString
			native      sql.NullString
			provider    sql.NullString
			kind        string
			provenance  sql.NullString
			contentHash sql.NullString
			raw         string
		)
		if err := rows.Scan(&eventID, &occ, &obs, &workstream, &session,
			&native, &provider, &kind, &provenance, &contentHash, &raw); err != nil {
			return nil, err
		}
		var ev protocol.Event
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			return nil, err
		}
		out = append(out, &ev)
	}
	return out, rows.Err()
}

// CountByKind returns a map of event kind -> count, used by doctor/status.
func (d *DB) CountByKind(ctx context.Context) (map[string]int64, error) {
	rows, err := d.sql.QueryContext(ctx, "SELECT kind, COUNT(*) FROM events GROUP BY kind")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
