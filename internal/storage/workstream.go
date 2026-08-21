package storage

import (
	"context"
	"encoding/json"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Workstream is the local workstream row.
type Workstream struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	RepositoryID string    `json:"repository_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	Status       string    `json:"status"`
}

// CreateWorkstream inserts a new workstream.
func (d *DB) CreateWorkstream(ctx context.Context, id, title, repoID string) error {
	_, err := d.sql.ExecContext(ctx, `
INSERT OR IGNORE INTO workstreams(id, title, repository_id, created_at, status)
VALUES (?, ?, ?, ?, 'active')`,
		id, title, nullable(repoID), time.Now().UTC().UnixNano())
	return err
}

// ListWorkstreams returns all workstreams ordered by creation time.
func (d *DB) ListWorkstreams(ctx context.Context) ([]*Workstream, error) {
	rows, err := d.sql.QueryContext(ctx,
		"SELECT id, title, repository_id, created_at, status FROM workstreams ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Workstream
	for rows.Next() {
		var w Workstream
		var repoID *string
		var created int64
		if err := rows.Scan(&w.ID, &w.Title, &repoID, &created, &w.Status); err != nil {
			return nil, err
		}
		if repoID != nil {
			w.RepositoryID = *repoID
		}
		w.CreatedAt = time.Unix(0, created)
		out = append(out, &w)
	}
	return out, rows.Err()
}

// SaveCheckpoint persists a checkpoint as raw JSON plus indexed columns.
func (d *DB) SaveCheckpoint(ctx context.Context, cp *protocol.Checkpoint) error {
	raw, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	_, err = d.sql.ExecContext(ctx, `
INSERT OR REPLACE INTO checkpoints(id, workstream_id, objective, status, graph_hash, score, created_at, raw_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		cp.CheckpointID, cp.WorkstreamID, cp.Objective, cp.Status,
		cp.Integrity.GraphRootHash, cp.Integrity.Score,
		time.Now().UTC().UnixNano(), string(raw))
	return err
}

// ListCheckpoints returns checkpoints for a workstream.
func (d *DB) ListCheckpoints(ctx context.Context, workstreamID string) ([]*protocol.Checkpoint, error) {
	rows, err := d.sql.QueryContext(ctx, `
SELECT raw_json FROM checkpoints WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*protocol.Checkpoint
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var cp protocol.Checkpoint
		if err := json.Unmarshal([]byte(raw), &cp); err != nil {
			return nil, err
		}
		out = append(out, &cp)
	}
	return out, rows.Err()
}
