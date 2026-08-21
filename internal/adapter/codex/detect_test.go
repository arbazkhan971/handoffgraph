package codex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The tests in this file pin Detect: recursive rollout enumeration, the
// session_meta head preference, deterministic newest-first ordering and the
// HFG_CODEX_SESSIONS_DIR override. Every test points Detect at throwaway
// directories; the real ~/.codex is never touched.

// writeRollout writes one rollout file whose head line is a session_meta
// record with the given id/timestamp/model.
func writeRollout(t *testing.T, dir, rel, id, ts, model string) string {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	head := `{"timestamp":"` + ts + `","type":"session_meta","payload":{"id":"` + id + `","timestamp":"` + ts + `","model":"` + model + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(head), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDetectRecursiveLayout(t *testing.T) {
	dir := t.TempDir()
	// Codex lays out rollouts by date: sessions/YYYY/MM/DD/rollout-*.jsonl.
	older := writeRollout(t, dir, filepath.Join("2026", "08", "20", "rollout-a.jsonl"),
		"a-uuid", "2026-08-20T09:00:00Z", "gpt-5-codex")
	newer := writeRollout(t, dir, filepath.Join("2026", "08", "21", "rollout-b.jsonl"),
		"b-uuid", "2026-08-21T11:30:00Z", "gpt-5-codex")
	// A flat file must still be found (older layouts wrote directly under
	// the sessions dir).
	flat := writeRollout(t, dir, "rollout-flat.jsonl",
		"flat-uuid", "2026-08-19T08:00:00Z", "gpt-5-codex")

	refs, err := (&Codex{SessionsDir: dir}).Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 3 {
		t.Fatalf("refs = %d, want 3: %+v", len(refs), refs)
	}
	wantOrder := []string{"b-uuid", "a-uuid", "flat-uuid"}
	for i, want := range wantOrder {
		if refs[i].NativeID != want {
			t.Errorf("refs[%d].NativeID = %s, want %s (order: %+v)", i, refs[i].NativeID, want, refs)
		}
		if refs[i].Path == "" {
			t.Errorf("refs[%d].Path empty", i)
		}
	}
	if refs[0].Path != newer || refs[1].Path != older || refs[2].Path != flat {
		t.Errorf("paths not aligned with ordering: %+v", refs)
	}
}

func TestDetectSessionMetaPreferredOverFilename(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-08-21T09-00-00-opaque-name.jsonl",
		"head-uuid", "2026-08-21T09:00:00Z", "gpt-5-codex")

	refs, err := (&Codex{SessionsDir: dir}).Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs = %d, want 1", len(refs))
	}
	ref := refs[0]
	if ref.NativeID != "head-uuid" {
		t.Errorf("NativeID = %s, want head payload.id (head-uuid)", ref.NativeID)
	}
	if ref.Model != "gpt-5-codex" {
		t.Errorf("Model = %s, want gpt-5-codex", ref.Model)
	}
	if !ref.StartedAt.Equal(time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("StartedAt = %s, want the head timestamp", ref.StartedAt)
	}
	if ref.Path != path {
		t.Errorf("Path = %s, want %s", ref.Path, path)
	}
	if ref.Provider != "codex" {
		t.Errorf("Provider = %s, want codex", ref.Provider)
	}
}

func TestDetectFilenameFallbackWhenHeadUnparseable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-degraded.jsonl")
	if err := os.WriteFile(path, []byte("not json at all\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	refs, err := (&Codex{SessionsDir: dir}).Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs = %d, want 1", len(refs))
	}
	if refs[0].NativeID != "rollout-degraded" {
		t.Errorf("NativeID = %s, want filename fallback", refs[0].NativeID)
	}
	if refs[0].StartedAt.IsZero() {
		t.Error("StartedAt zero, want file modification time fallback")
	}
}

func TestDetectTiesBrokenByPath(t *testing.T) {
	dir := t.TempDir()
	a := writeRollout(t, dir, "rollout-a.jsonl", "same-ts", "2026-08-21T09:00:00Z", "m")
	b := writeRollout(t, dir, "rollout-b.jsonl", "same-ts", "2026-08-21T09:00:00Z", "m")

	refs, err := (&Codex{SessionsDir: dir}).Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %d, want 2", len(refs))
	}
	if refs[0].Path != a || refs[1].Path != b {
		t.Errorf("tie order not by path: %+v", refs)
	}
}

func TestDetectEnvOverride(t *testing.T) {
	dir := t.TempDir()
	writeRollout(t, dir, "rollout-a.jsonl", "env-uuid", "2026-08-21T09:00:00Z", "m")
	t.Setenv("HFG_CODEX_SESSIONS_DIR", dir)
	t.Setenv("HOME", t.TempDir()) // the default path must not leak in

	refs, err := New().Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 1 || refs[0].NativeID != "env-uuid" {
		t.Fatalf("refs = %+v, want the env-override session", refs)
	}
}

func TestDetectFieldOverridesEnv(t *testing.T) {
	fieldDir := t.TempDir()
	writeRollout(t, fieldDir, "rollout-field.jsonl", "field-uuid", "2026-08-21T09:00:00Z", "m")
	envDir := t.TempDir()
	writeRollout(t, envDir, "rollout-env.jsonl", "env-uuid", "2026-08-21T09:00:00Z", "m")
	t.Setenv("HFG_CODEX_SESSIONS_DIR", envDir)

	refs, err := (&Codex{SessionsDir: fieldDir}).Detect(context.Background(), "")
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(refs) != 1 || refs[0].NativeID != "field-uuid" {
		t.Fatalf("refs = %+v, want the field-override session", refs)
	}
}

func TestDetectEmptyAndMissingDirsAreNotErrors(t *testing.T) {
	empty := t.TempDir()
	for _, dir := range []string{empty, filepath.Join(empty, "does-not-exist")} {
		refs, err := (&Codex{SessionsDir: dir}).Detect(context.Background(), "")
		if err != nil {
			t.Fatalf("detect(%s): %v", dir, err)
		}
		if len(refs) != 0 {
			t.Errorf("detect(%s) = %+v, want none", dir, refs)
		}
	}
}

func TestDetectHonorsContextCancellation(t *testing.T) {
	dir := t.TempDir()
	writeRollout(t, dir, "rollout-a.jsonl", "cancel-uuid", "2026-08-21T09:00:00Z", "m")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Codex{SessionsDir: dir}).Detect(ctx, ""); err == nil {
		t.Fatal("detect with a cancelled context succeeded, want error")
	}
}
