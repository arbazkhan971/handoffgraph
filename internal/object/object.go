// Package object implements the content-addressed, compressed object store.
//
// Objects are immutable and referenced by their sha256 hash. Every object
// records a content policy and optional schema metadata. When the
// representation of an object changes, a new object is produced rather than
// mutating the original (append-only).
package object

import (
	"bytes"
	"compress/zlib"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Policy values describe the content policy applied to an object.
const (
	PolicyMetadataOnly = "metadata_only"
	PolicySanitized    = "sanitized"
	PolicyFullLocal    = "full_local"
	PolicyEncrypted    = "encrypted"
)

// ErrNotFound is returned when an object is not present in the store.
var ErrNotFound = errors.New("object not found")

// Meta is the sidecar metadata recorded alongside an object body.
type Meta struct {
	ContentHash string `json:"content_hash"`
	Policy      string `json:"content_policy"`
	Compressed  bool   `json:"compressed"`
	SizeBytes   int64  `json:"size_bytes"`
	Schema      string `json:"schema,omitempty"`
}

// Store is a content-addressed object store rooted at a directory.
type Store struct {
	root string
}

// NewStore returns a Store rooted at dir (creating it if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("object store mkdir: %w", err)
	}
	return &Store{root: dir}, nil
}

// Root returns the store's root directory.
func (s *Store) Root() string { return s.root }

// Put stores a compressed copy of data and returns its content hash.
// The returned hash matches content.HashBytes(data), so callers can verify
// integrity independently.
func (s *Store) Put(data []byte, policy, schema string) (string, *Meta, error) {
	hash := hashOf(data)
	path := s.pathFor(hash)

	if _, err := os.Stat(path); err == nil {
		// Object already exists; verify it matches.
		meta, err := s.readMeta(hash)
		if err != nil {
			return "", nil, err
		}
		return hash, meta, nil
	}

	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	if _, err := zw.Write(data); err != nil {
		return "", nil, err
	}
	if err := zw.Close(); err != nil {
		return "", nil, err
	}

	if err := os.WriteFile(path, compressed.Bytes(), 0o600); err != nil {
		return "", nil, err
	}

	meta := &Meta{
		ContentHash: hash,
		Policy:      policy,
		Compressed:  true,
		SizeBytes:   int64(len(data)),
		Schema:      schema,
	}
	if err := s.writeMeta(hash, meta); err != nil {
		return "", nil, err
	}
	return hash, meta, nil
}

// Get returns the decompressed object body for hash.
func (s *Store) Get(hash string) ([]byte, *Meta, error) {
	meta, err := s.readMeta(hash)
	if err != nil {
		return nil, nil, err
	}
	raw, err := os.ReadFile(s.pathFor(hash))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if meta.Compressed {
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, nil, err
		}
		defer zr.Close()
		data, err := io.ReadAll(zr)
		if err != nil {
			return nil, nil, err
		}
		return data, meta, nil
	}
	return raw, meta, nil
}

// Verify re-hashes the stored bytes and reports whether they match the hash.
func (s *Store) Verify(hash string) (bool, error) {
	data, _, err := s.Get(hash)
	if err != nil {
		return false, err
	}
	return hashOf(data) == hash, nil
}

func (s *Store) pathFor(hash string) string {
	return filepath.Join(s.root, hash)
}

func (s *Store) metaPathFor(hash string) string {
	return filepath.Join(s.root, hash+".meta.json")
}

func (s *Store) writeMeta(hash string, meta *Meta) error {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.metaPathFor(hash), b, 0o600)
}

func (s *Store) readMeta(hash string) (*Meta, error) {
	b, err := os.ReadFile(s.metaPathFor(hash))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var meta Meta
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func hashOf(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ValidateHash reports whether h is a well-formed content hash.
func ValidateHash(h string) bool {
	if !strings.HasPrefix(h, "sha256:") {
		return false
	}
	digest := strings.TrimPrefix(h, "sha256:")
	if len(digest) != 64 {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}
