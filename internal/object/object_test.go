package object

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorePutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	data := []byte("hello world, this is a test payload")
	hash, meta, err := s.Put(data, PolicyFullLocal, "test")
	if err != nil {
		t.Fatal(err)
	}
	if meta.SizeBytes != int64(len(data)) {
		t.Fatalf("size = %d, want %d", meta.SizeBytes, len(data))
	}
	if !meta.Compressed {
		t.Fatal("expected compressed object")
	}

	got, gotMeta, err := s.Get(hash)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("round trip mismatch: %q", got)
	}
	if gotMeta.ContentHash != hash {
		t.Fatalf("meta hash mismatch")
	}

	ok, err := s.Verify(hash)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("verify failed")
	}
}

func TestStoreImmutableDedup(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(dir)

	data := []byte("immutable payload")
	h1, _, err := s.Put(data, PolicySanitized, "x")
	if err != nil {
		t.Fatal(err)
	}
	h2, _, err := s.Put(data, PolicySanitized, "x")
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("same content produced different hashes")
	}
	// Only one object file should exist (plus one meta file).
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 files (object + meta), got %d", len(entries))
	}
}

func TestStoreNotFound(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(dir)
	if _, _, err := s.Get("sha256:" + "00"); err == nil {
		t.Fatal("expected not found")
	}
}

func TestValidateHash(t *testing.T) {
	if !ValidateHash("sha256:" + strings.Repeat("a", 64)) {
		t.Fatal("expected valid hash")
	}
	if ValidateHash("sha256:abc") {
		t.Fatal("expected invalid hash")
	}
	if ValidateHash("md5:" + strings.Repeat("a", 32)) {
		t.Fatal("expected invalid hash")
	}
}

func TestStoreRoot(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(dir)
	if s.Root() != filepath.Clean(dir) {
		t.Fatalf("root = %q, want %q", s.Root(), dir)
	}
}
