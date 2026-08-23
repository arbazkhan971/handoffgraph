package storage

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestGetCheckpoint(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "checkpoint.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cp := &protocol.Checkpoint{
		SchemaVersion: protocol.SchemaVersionCheckpoint,
		CheckpointID:  "cp_lookup",
		WorkstreamID:  "ws_lookup",
		Objective:     "show this checkpoint",
	}
	if err := db.SaveCheckpoint(context.Background(), cp); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetCheckpoint(context.Background(), cp.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CheckpointID != cp.CheckpointID || got.Objective != cp.Objective {
		t.Fatalf("GetCheckpoint = %+v", got)
	}
}

func TestGetCheckpointNotFound(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "checkpoint.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.GetCheckpoint(context.Background(), "cp_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
	if _, err := db.GetCheckpoint(context.Background(), ""); err == nil {
		t.Fatal("empty checkpoint id accepted")
	}
}
