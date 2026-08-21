package repository

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireGit skips the test when the git binary is unavailable.
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not found")
	}
}

// gitEnv returns an environment isolated from the host git configuration so
// tests are hermetic (no global hooks, templates, identity, or gpg signing).
func gitEnv(dir string) []string {
	return append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1",
		"HOME="+dir,
		"USERPROFILE="+dir,
	)
}

func runGitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv(dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// initRepo creates a hermetic temp repo with one commit on branch "hfg-main".
func initRepo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	dir := t.TempDir()
	runGitT(t, dir, "init", "-q")
	runGitT(t, dir, "symbolic-ref", "HEAD", "refs/heads/hfg-main")
	runGitT(t, dir, "config", "user.email", "hfg@example.com")
	runGitT(t, dir, "config", "user.name", "HandoffGraph Test")
	runGitT(t, dir, "config", "commit.gpgsign", "false")
	writeFile(t, filepath.Join(dir, "README.md"), "# test\n")
	runGitT(t, dir, "add", ".")
	runGitT(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestDetect_NotARepo(t *testing.T) {
	requireGit(t)
	dir := t.TempDir() // empty dir, no .git anywhere in its chain
	_, err := Detect(context.Background(), dir)
	if !errors.Is(err, ErrNotGit) {
		t.Fatalf("Detect on non-repo: got %v, want ErrNotGit", err)
	}
}

func TestState_NotARepo(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	if _, err := State(context.Background(), dir); !errors.Is(err, ErrNotGit) {
		t.Fatalf("State on non-repo: got %v, want ErrNotGit", err)
	}
}

func TestDetect_MissingDirIsNotGit(t *testing.T) {
	requireGit(t)
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := Detect(context.Background(), missing); !errors.Is(err, ErrNotGit) {
		t.Fatalf("Detect on missing dir: got %v, want ErrNotGit", err)
	}
}

func TestDetect_LocalFallbackStable(t *testing.T) {
	dir := initRepo(t)
	ctx := context.Background()

	id1, err := Detect(ctx, dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	id2, err := Detect(ctx, dir)
	if err != nil {
		t.Fatalf("Detect again: %v", err)
	}
	if id1.Remote != "" {
		t.Errorf("Remote with no origin configured: got %q, want empty", id1.Remote)
	}
	if !strings.HasPrefix(id1.ID, "local:") {
		t.Errorf("fallback ID %q should have prefix \"local:\"", id1.ID)
	}
	if id1.ID != id2.ID {
		t.Errorf("identity not stable across calls: %q vs %q", id1.ID, id2.ID)
	}
}

func TestDetect_RemotePreferred(t *testing.T) {
	dir := initRepo(t)
	runGitT(t, dir, "remote", "add", "origin", "git@github.com:org/repo.git")

	id, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if id.Remote != "github.com/org/repo" {
		t.Errorf("Remote = %q, want %q", id.Remote, "github.com/org/repo")
	}
	if id.ID != "github.com/org/repo" {
		t.Errorf("ID = %q, want remote-derived %q", id.ID, "github.com/org/repo")
	}
}

func TestState_CleanThenDirty(t *testing.T) {
	dir := initRepo(t)
	ctx := context.Background()

	clean, err := State(ctx, dir)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if clean.Dirty {
		t.Error("freshly committed repo reported Dirty")
	}
	if clean.Branch != "hfg-main" {
		t.Errorf("Branch = %q, want %q", clean.Branch, "hfg-main")
	}
	if len(clean.Head) != 40 {
		t.Errorf("Head = %q, want 40-char SHA-1", clean.Head)
	}

	// Untracked file makes the worktree dirty.
	writeFile(t, filepath.Join(dir, "untracked.txt"), "dirty\n")
	dirty, err := State(ctx, dir)
	if err != nil {
		t.Fatalf("State after write: %v", err)
	}
	if !dirty.Dirty {
		t.Error("repo with untracked file not reported Dirty")
	}
	if dirty.Head != clean.Head || dirty.Branch != clean.Branch {
		t.Error("writing an untracked file must not change Head or Branch")
	}
}

func TestState_DetachedHead(t *testing.T) {
	dir := initRepo(t)
	runGitT(t, dir, "checkout", "-q", "--detach", "HEAD")

	s, err := State(context.Background(), dir)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if s.Branch != "" {
		t.Errorf("Branch on detached HEAD = %q, want empty", s.Branch)
	}
	if len(s.Head) != 40 {
		t.Errorf("Head = %q, want 40-char SHA-1", s.Head)
	}
	if s.Dirty {
		t.Error("detached HEAD at clean commit reported Dirty")
	}
}

func TestState_RemoteAndEnsure(t *testing.T) {
	dir := initRepo(t)
	runGitT(t, dir, "remote", "add", "origin", "https://github.com/org/repo.git")

	s, err := State(context.Background(), dir)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if s.Remote != "github.com/org/repo" {
		t.Errorf("Remote = %q, want %q", s.Remote, "github.com/org/repo")
	}
	if err := s.Ensure(); err != nil {
		t.Errorf("Ensure on valid state: %v", err)
	}
	var nilState *RepoState
	if err := nilState.Ensure(); err == nil {
		t.Error("Ensure on nil state should fail")
	}
}

func TestIsGitDir(t *testing.T) {
	requireGit(t)
	ctx := context.Background()

	repo := initRepo(t)
	if !IsGitDir(ctx, repo) {
		t.Error("IsGitDir false inside a repo")
	}
	// A subdirectory of the repo is still inside the work tree.
	sub := filepath.Join(repo, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if !IsGitDir(ctx, sub) {
		t.Error("IsGitDir false inside repo subdirectory")
	}
	if IsGitDir(ctx, t.TempDir()) {
		t.Error("IsGitDir true outside any repo")
	}
	if IsGitDir(ctx, filepath.Join(repo, "no-such-dir")) {
		t.Error("IsGitDir true for missing directory")
	}
}
