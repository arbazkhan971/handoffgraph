package hostedsync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	stateVersion     = 1
	maxStateFileSize = 64 << 20
)

type diskState struct {
	Version int                    `json:"version"`
	Scopes  map[string]*scopeState `json:"scopes"`
}

type scopeState struct {
	Endpoint          string        `json:"endpoint"`
	WorkspaceID       string        `json:"workspace_id,omitempty"`
	Cursor            int64         `json:"cursor"`
	PreviewAcceptedAt string        `json:"preview_accepted_at,omitempty"`
	Pending           *pendingBatch `json:"pending,omitempty"`
}

type pendingBatch struct {
	AfterSeq       int64           `json:"after_seq"`
	ThroughSeq     int64           `json:"through_seq"`
	IdempotencyKey string          `json:"idempotency_key"`
	Body           json.RawMessage `json:"body"`
	Events         int             `json:"events"`
	Clean          int             `json:"clean"`
	Redacted       int             `json:"redacted"`
	FieldsRedacted int             `json:"fields_redacted"`
}

func newDiskState() *diskState {
	return &diskState{Version: stateVersion, Scopes: make(map[string]*scopeState)}
}

func loadState(path string) (*diskState, error) {
	info, err := os.Lstat(path)
	if isNotExist(err) {
		return newDiskState(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect hosted sync state: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("hosted sync state must be a regular file, not a symlink")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open hosted sync state: %w", err)
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("hosted sync state changed while it was being opened")
	}
	if runtime.GOOS != "windows" && opened.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("hosted sync state permissions are too broad: require mode 0600 or stricter")
	}
	if opened.Size() > maxStateFileSize {
		return nil, fmt.Errorf("hosted sync state exceeds %d bytes", maxStateFileSize)
	}
	dec := json.NewDecoder(io.LimitReader(f, maxStateFileSize+1))
	dec.DisallowUnknownFields()
	var state diskState
	if err := dec.Decode(&state); err != nil {
		return nil, fmt.Errorf("decode hosted sync state: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("decode hosted sync state: trailing JSON content")
	}
	if state.Version != stateVersion || state.Scopes == nil {
		return nil, fmt.Errorf("unsupported hosted sync state version %d", state.Version)
	}
	return &state, nil
}

func saveState(path string, state *diskState) error {
	if state == nil || state.Version != stateVersion || state.Scopes == nil {
		return fmt.Errorf("refusing to write invalid hosted sync state")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create hosted sync state directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".hosted-sync-state-*")
	if err != nil {
		return fmt.Errorf("create hosted sync state temp file: %w", err)
	}
	tmpPath := tmp.Name()
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect hosted sync state temp file: %w", err)
	}
	enc := json.NewEncoder(tmp)
	if err := enc.Encode(state); err != nil {
		return fmt.Errorf("encode hosted sync state: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync hosted sync state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close hosted sync state: %w", err)
	}
	if err := replaceFile(tmpPath, path); err != nil {
		return fmt.Errorf("replace hosted sync state: %w", err)
	}
	keep = true
	if runtime.GOOS != "windows" {
		if d, err := os.Open(dir); err == nil {
			_ = d.Sync()
			_ = d.Close()
		}
	}
	return nil
}

func scopeID(endpoint, token, storeID string) string {
	sum := sha256.Sum256([]byte(endpoint + "\x00" + token + "\x00" + storeID))
	return "scope_" + hex.EncodeToString(sum[:])
}

func getScope(state *diskState, endpoint, token, storeID string) (*scopeState, error) {
	id := scopeID(endpoint, token, storeID)
	if existing := state.Scopes[id]; existing != nil {
		if existing.Endpoint != endpoint || existing.Cursor < 0 {
			return nil, fmt.Errorf("hosted sync state is inconsistent for this credential scope")
		}
		return existing, nil
	}
	scope := &scopeState{Endpoint: endpoint}
	state.Scopes[id] = scope
	return scope, nil
}

func acceptPreview(scope *scopeState, now time.Time) {
	scope.PreviewAcceptedAt = now.UTC().Format(time.RFC3339)
}
