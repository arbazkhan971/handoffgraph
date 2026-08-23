package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// GetCheckpoint returns a checkpoint by its durable id.
func (d *DB) GetCheckpoint(ctx context.Context, checkpointID string) (*protocol.Checkpoint, error) {
	if checkpointID == "" {
		return nil, fmt.Errorf("checkpoint id is required")
	}
	var raw string
	err := d.sql.QueryRowContext(ctx, "SELECT raw_json FROM checkpoints WHERE id = ?", checkpointID).Scan(&raw)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("checkpoint %s: %w", checkpointID, ErrNotFound)
		}
		return nil, err
	}
	var cp protocol.Checkpoint
	if err := json.Unmarshal([]byte(raw), &cp); err != nil {
		return nil, fmt.Errorf("checkpoint %s decode: %w", checkpointID, err)
	}
	return &cp, nil
}
