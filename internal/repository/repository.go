// Package repository derives a stable Git repository identity from a remote
// URL plus a stable local fallback, and captures the worktree state used by
// checkpoints and drift detection.
package repository

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"regexp"
	"runtime"
	"strings"
)

// Identity is a stable repository identifier independent of the local path.
type Identity struct {
	Remote string `json:"remote,omitempty"`
	ID     string `json:"id"` // stable identifier
}

// RepoState is the current worktree snapshot.
type RepoState struct {
	Remote string `json:"remote,omitempty"`
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	Dirty  bool   `json:"dirty"`
}

// ErrNotGit is returned when dir is not inside a Git repository.
var ErrNotGit = errors.New("not a git repository")

// Detect derives the repository identity for the working directory.
//
// It prefers the origin remote URL; when no remote exists it falls back to a
// stable hash of the top-level directory path so identity remains stable
// across sessions on the same machine.
func Detect(ctx context.Context, dir string) (*Identity, error) {
	top, err := runGit(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, ErrNotGit
	}
	top = strings.TrimSpace(top)

	remote, err := runGit(ctx, dir, "config", "--get", "remote.origin.url")
	var remoteURL string
	if err == nil {
		remoteURL = normalizeRemote(strings.TrimSpace(remote))
	}

	// Stable fallback: canonical, platform-normalized top-level path.
	id := remoteURL
	if id == "" {
		id = "local:" + normalizePath(top, runtime.GOOS == "windows")
	}
	return &Identity{Remote: remoteURL, ID: id}, nil
}

// State captures the current worktree state for checkpoint and drift checks.
func State(ctx context.Context, dir string) (*RepoState, error) {
	if _, err := runGit(ctx, dir, "rev-parse", "--is-inside-work-tree"); err != nil {
		return nil, ErrNotGit
	}
	s := &RepoState{}

	if remote, err := runGit(ctx, dir, "config", "--get", "remote.origin.url"); err == nil {
		s.Remote = normalizeRemote(strings.TrimSpace(remote))
	}
	if branch, err := runGit(ctx, dir, "branch", "--show-current"); err == nil {
		s.Branch = strings.TrimSpace(branch)
	}
	if head, err := runGit(ctx, dir, "rev-parse", "HEAD"); err == nil {
		s.Head = strings.TrimSpace(head)
	}
	if status, err := runGit(ctx, dir, "status", "--porcelain"); err == nil {
		s.Dirty = strings.TrimSpace(status) != ""
	}
	return s, nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

var (
	scpLike  = regexp.MustCompile(`^([^/@]+@)?([^/:]+):(.+)$`)
	urlProto = regexp.MustCompile(`^[a-z][a-z0-9+.-]*://`)
	winDrive = regexp.MustCompile(`^[A-Za-z]:`)
)

// normalizeRemote reduces common remote URL forms to a canonical form used
// for stable identity comparison.
func normalizeRemote(remote string) string {
	remote = strings.TrimSpace(remote)
	remote = strings.TrimSuffix(remote, ".git")
	// scp-like syntax: git@github.com:org/repo — but not a Windows drive
	// path like C:\repos\hfg, where the colon is a drive separator.
	if m := scpLike.FindStringSubmatch(remote); m != nil && !urlProto.MatchString(remote) && !winDrive.MatchString(remote) {
		return m[2] + "/" + m[3]
	}
	// strip protocol prefix
	if idx := strings.Index(remote, "://"); idx >= 0 {
		remote = remote[idx+3:]
	}
	// strip leading user@
	if at := strings.Index(remote, "@"); at >= 0 {
		remote = remote[at+1:]
	}
	return remote
}

// IsGitDir reports whether dir is inside a Git repository.
func IsGitDir(ctx context.Context, dir string) bool {
	_, err := runGit(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil
}

// normalizePath canonicalizes p for stable identity comparison. The Windows
// branch is injectable via isWindows so both branches are testable on any
// host OS: separators become '/', drive letters are upper-cased, and UNC
// prefixes are preserved. The Unix branch applies POSIX cleaning only;
// backslashes are literal characters, never separators.
func normalizePath(p string, isWindows bool) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !isWindows {
		return path.Clean(p)
	}
	unc := strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, `//`)
	slashed := strings.ReplaceAll(p, `\`, `/`)
	if unc {
		rest := strings.TrimPrefix(slashed, "//")
		return "//" + strings.TrimPrefix(path.Clean("/"+rest), "/")
	}
	cleaned := path.Clean(slashed)
	if len(cleaned) >= 2 && cleaned[1] == ':' {
		cleaned = strings.ToUpper(cleaned[:1]) + cleaned[1:]
	}
	return cleaned
}

// Ensure validates the repository state for use in a checkpoint.
func (s *RepoState) Ensure() error {
	if s == nil {
		return fmt.Errorf("repository state is nil")
	}
	return nil
}
