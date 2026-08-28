package storage

import (
	"context"
	"encoding/json"
	"sort"
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

// ListWorkstreams returns the deterministic workstream read model ordered by
// creation time. Explicit table rows are merged with workstreams observed in
// the append-only event log, so a plain fixture/native-session import is
// immediately addressable by the CLI, UI, and MCP tools without fabricating a
// separate create operation.
func (d *DB) ListWorkstreams(ctx context.Context) ([]*Workstream, error) {
	rows, err := d.sql.QueryContext(ctx,
		"SELECT id, title, repository_id, created_at, status FROM workstreams ORDER BY created_at, id")
	if err != nil {
		return nil, err
	}
	var out []*Workstream
	byID := map[string]*Workstream{}
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
		row := w
		out = append(out, &row)
		byID[row.ID] = &row
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	events, err := d.ListEvents(ctx)
	if err != nil {
		return nil, err
	}
	for _, ev := range events {
		if ev.WorkstreamID == "" {
			continue
		}
		w, ok := byID[ev.WorkstreamID]
		if !ok {
			at := ev.OccurredAt
			if at.IsZero() {
				at = ev.ObservedAt
			}
			if at.IsZero() {
				at = time.Unix(0, 0).UTC()
			}
			w = &Workstream{ID: ev.WorkstreamID, Title: ev.WorkstreamID, CreatedAt: at, Status: "active"}
			byID[w.ID] = w
			out = append(out, w)
		} else if !ev.OccurredAt.IsZero() && ev.OccurredAt.Before(w.CreatedAt) {
			w.CreatedAt = ev.OccurredAt
		}
		if w.RepositoryID == "" && ev.RepositoryID != "" {
			w.RepositoryID = ev.RepositoryID
		}
		if ev.Kind == protocol.EventWorkstreamStarted && (w.Title == "" || w.Title == w.ID) {
			var payload struct {
				Title string `json:"title"`
			}
			if json.Unmarshal(ev.Payload, &payload) == nil && payload.Title != "" {
				w.Title = payload.Title
			}
		}
		if w.Status != "completed" {
			switch ev.Kind {
			case protocol.EventHandoffCreated:
				w.Status = "handed_off"
			case protocol.EventHandoffAccepted:
				w.Status = "active"
			case protocol.EventWorkstreamCompleted:
				w.Status = "completed"
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
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

// CheckpointCreatedAt returns the wall-clock creation time (unix nanos) of
// one checkpoint, for baseline comparisons. Not found → ok=false.
func (d *DB) CheckpointCreatedAt(ctx context.Context, workstreamID, checkpointID string) (int64, bool, error) {
	var createdAt int64
	err := d.sql.QueryRowContext(ctx, `
SELECT created_at FROM checkpoints WHERE workstream_id = ? AND id = ?`,
		workstreamID, checkpointID).Scan(&createdAt)
	if err == nil {
		return createdAt, true, nil
	}
	return 0, false, nil
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
