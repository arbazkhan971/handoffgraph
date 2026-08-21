package detection

import (
	"context"
	"database/sql"
	"fmt"
)

// detectionSchemaSQL is the idempotent DDL for the detection_matches table.
//
// The detection pack owns this table: it is created here, outside the
// storage migrations, so detection can evolve its persistence without
// touching the append-only event spine. CREATE TABLE IF NOT EXISTS makes the
// helper safe to run on every open (migration-style).
//
// History is append-only: the primary key is the natural key
// (rule_id, rule_version, scope_id, group_key), so re-evaluating the same
// rule version over the same evidence is idempotent (INSERT OR IGNORE in
// Store.SaveMatches) and a new rule version adds rows without rewriting
// prior ones.
const detectionSchemaSQL = `
CREATE TABLE IF NOT EXISTS detection_matches (
    rule_id        TEXT NOT NULL,
    rule_version   TEXT NOT NULL,
    scope          TEXT NOT NULL,
    scope_id       TEXT NOT NULL,
    group_key      TEXT NOT NULL,
    severity       TEXT NOT NULL,
    message        TEXT NOT NULL,
    span_ids       TEXT NOT NULL,
    trace_ids      TEXT NOT NULL,
    match_count    INTEGER NOT NULL,
    evidence_level TEXT NOT NULL,
    evaluated_at   TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (rule_id, rule_version, scope_id, group_key)
);
CREATE INDEX IF NOT EXISTS idx_detection_matches_rule ON detection_matches(rule_id);
CREATE INDEX IF NOT EXISTS idx_detection_matches_scope ON detection_matches(scope, scope_id);
`

// EnsureSchema applies the idempotent detection_matches DDL to db. It is
// safe to call repeatedly and never touches any other table.
func EnsureSchema(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("detection: EnsureSchema: nil db")
	}
	if _, err := db.ExecContext(ctx, detectionSchemaSQL); err != nil {
		return fmt.Errorf("detection schema: %w", err)
	}
	return nil
}
