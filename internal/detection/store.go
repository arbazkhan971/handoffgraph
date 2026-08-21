package detection

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"

	// The pure-Go SQLite driver backs both OpenStoreFile and the in-memory
	// stores used by tests.
	_ "modernc.org/sqlite"
)

// Store persists detection matches into the local SQLite database.
type Store struct {
	db *sql.DB
}

// MatchFilter narrows ListMatches. Empty fields match everything.
type MatchFilter struct {
	RuleID  string
	ScopeID string
}

// OpenStore wraps an existing SQLite handle and ensures the detection schema
// exists (idempotent). The caller remains responsible for closing the
// underlying handle unless the store was opened with OpenStoreFile.
func OpenStore(ctx context.Context, db *sql.DB) (*Store, error) {
	if db == nil {
		return nil, fmt.Errorf("detection: OpenStore: nil db")
	}
	if err := EnsureSchema(ctx, db); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// OpenStoreFile opens its own SQLite handle at path with the same WAL +
// busy-timeout pragmas the storage layer uses, and ensures the detection
// schema. The handle is independent from storage.DB's; WAL mode and a 5s
// busy timeout make short concurrent access safe. Callers must Close it.
func OpenStoreFile(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("detection: OpenStoreFile: empty path")
	}
	sdb, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, fmt.Errorf("detection: open db: %w", err)
	}
	sdb.SetMaxOpenConns(1) // SQLite: single writer avoids SQLITE_BUSY
	st, err := OpenStore(ctx, sdb)
	if err != nil {
		sdb.Close()
		return nil, err
	}
	return st, nil
}

// Close closes the underlying handle (no-op handles owned elsewhere close
// via this too; callers that passed their own handle may skip it).
func (s *Store) Close() error { return s.db.Close() }

// SaveMatches persists matches in deterministic order using INSERT OR IGNORE
// on the natural key (rule_id, rule_version, scope_id, group_key): the first
// write wins, so re-running the same rule version over the same evidence is
// idempotent, while a new rule version adds rows and never rewrites history.
// It returns the number of newly inserted rows.
func (s *Store) SaveMatches(ctx context.Context, matches []*Match) (int, error) {
	ordered := append([]*Match(nil), matches...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.RuleID != b.RuleID {
			return a.RuleID < b.RuleID
		}
		if a.RuleVersion != b.RuleVersion {
			return a.RuleVersion < b.RuleVersion
		}
		if a.ScopeID != b.ScopeID {
			return a.ScopeID < b.ScopeID
		}
		return a.GroupKey < b.GroupKey
	})

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	inserted := 0
	for _, m := range ordered {
		spanIDs, err := marshalIDs(m.SpanIDs)
		if err != nil {
			tx.Rollback()
			return 0, err
		}
		traceIDs, err := marshalIDs(m.TraceIDs)
		if err != nil {
			tx.Rollback()
			return 0, err
		}
		res, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO detection_matches
    (rule_id, rule_version, scope, scope_id, group_key, severity, message,
     span_ids, trace_ids, match_count, evidence_level, evaluated_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.RuleID, m.RuleVersion, m.Scope, m.ScopeID, m.GroupKey, m.Severity, m.Message,
			spanIDs, traceIDs, m.MatchCount, string(m.EvidenceLevel),
			m.EvaluatedAt.UTC().Format(time.RFC3339Nano), time.Now().UTC().UnixNano(),
		)
		if err != nil {
			tx.Rollback()
			return 0, fmt.Errorf("save detection match %s/%s: %w", m.RuleID, m.RuleVersion, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			tx.Rollback()
			return 0, err
		}
		inserted += int(n)
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

// ListMatches returns stored matches ordered deterministically by
// (rule_id, rule_version, scope_id, group_key).
func (s *Store) ListMatches(ctx context.Context, f MatchFilter) ([]*Match, error) {
	query := `SELECT rule_id, rule_version, scope, scope_id, group_key, severity, message,
       span_ids, trace_ids, match_count, evidence_level, evaluated_at
FROM detection_matches`
	var (
		where []string
		args  []any
	)
	if f.RuleID != "" {
		where = append(where, "rule_id = ?")
		args = append(args, f.RuleID)
	}
	if f.ScopeID != "" {
		where = append(where, "scope_id = ?")
		args = append(args, f.ScopeID)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY rule_id, rule_version, scope_id, group_key"

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Match
	for rows.Next() {
		var (
			m             Match
			spanIDs       string
			traceIDs      string
			evidenceLevel string
			evaluatedAt   string
		)
		if err := rows.Scan(&m.RuleID, &m.RuleVersion, &m.Scope, &m.ScopeID, &m.GroupKey,
			&m.Severity, &m.Message, &spanIDs, &traceIDs, &m.MatchCount,
			&evidenceLevel, &evaluatedAt); err != nil {
			return nil, err
		}
		if m.SpanIDs, err = unmarshalIDs(spanIDs); err != nil {
			return nil, fmt.Errorf("span_ids for %s/%s: %w", m.RuleID, m.RuleVersion, err)
		}
		if m.TraceIDs, err = unmarshalIDs(traceIDs); err != nil {
			return nil, fmt.Errorf("trace_ids for %s/%s: %w", m.RuleID, m.RuleVersion, err)
		}
		m.EvidenceLevel = protocol.Provenance(evidenceLevel)
		at, err := time.Parse(time.RFC3339Nano, evaluatedAt)
		if err != nil {
			return nil, fmt.Errorf("evaluated_at for %s/%s: %w", m.RuleID, m.RuleVersion, err)
		}
		m.EvaluatedAt = at
		out = append(out, &m)
	}
	return out, rows.Err()
}

func marshalIDs(ids []string) (string, error) {
	if len(ids) == 0 {
		return "[]", nil
	}
	b, err := json.Marshal(ids)
	if err != nil {
		return "", fmt.Errorf("marshal ids: %w", err)
	}
	return string(b), nil
}

func unmarshalIDs(s string) ([]string, error) {
	var ids []string
	if err := json.Unmarshal([]byte(s), &ids); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	return ids, nil
}
