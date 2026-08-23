// Package claude implements the provider adapter for Anthropic Claude Code
// sessions (v0.3.0 scope).
//
// Claude Code exposes three observation surfaces this adapter builds on:
//
//   - hooks: lifecycle events delivered as JSON on stdin (SessionStart,
//     UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact,
//     PostCompact) configured in ~/.claude/settings.json; managed
//     additively and fail-closed by integrations/claude;
//   - transcripts: session logs stored as JSONL under
//     ~/.claude/projects/<project>/<session-id>.jsonl, enumerated
//     best-effort by Detect;
//   - print-mode stream-json: `claude -p --output-format stream-json` lines
//     (type assistant/user/system/result) normalized by Normalize.
//
// Native resume (`claude --resume <id>`) and fork
// (`claude --resume <id> --fork-session`) return exec specs the CLI runs so
// the resumed session keeps flowing through installed hooks.
package claude

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	claudehooks "github.com/handoffgraph/handoffgraph/integrations/claude"
	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Sentinel errors for capabilities this adapter version does not implement.
var (
	// ErrUnsupported marks operations planned for a later release.
	ErrUnsupported = errors.New("claude: not supported by this adapter version")
)

// Claude adapts Anthropic Claude Code sessions. Fields override default
// locations so tests and non-standard installs can point the adapter at
// scratch directories.
type Claude struct {
	// ConfigDir overrides ~/.claude for hook Install/Uninstall.
	ConfigDir string
	// ProjectsDir overrides ~/.claude/projects for Detect.
	ProjectsDir string
	// HookCommand is the command installed for each hook event. Empty
	// resolves to the current executable.
	HookCommand string
	// DryRun makes Install/Uninstall validate without writing.
	DryRun bool
}

// New returns a Claude adapter using default locations.
func New() *Claude { return &Claude{} }

// configDir resolves the Claude Code configuration directory.
func (c *Claude) configDir() string {
	if c.ConfigDir != "" {
		return c.ConfigDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// projectsDir resolves the Claude Code projects (transcript) directory.
func (c *Claude) projectsDir() string {
	if c.ProjectsDir != "" {
		return c.ProjectsDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// Name implements adapter.Adapter.
func (c *Claude) Name() string { return protocol.ProviderClaude }

// Capabilities reports what this adapter version supports honestly:
// hook-based observation of prompts, tools, and compaction; stream-json
// normalization; on-disk session enumeration; native resume and fork.
// Diff-level events and native test-exit reporting are not supported (test
// outcomes are only visible indirectly through observed tool/command
// output).
func (c *Claude) Capabilities() adapter.Capabilities {
	return adapter.Capabilities{
		NativeResume:        true,
		NativeFork:          true,
		CheckpointLaunch:    true,
		Hooks:               true,
		ToolEvents:          true,
		PromptEvents:        true,
		CompactionEvents:    true,
		DiffEvents:          false,
		TestExitStatus:      false,
		StructuredStreaming: true,
		SessionEnumeration:  true,
	}
}

// DefaultRegistry returns a fresh registry with this adapter registered.
func DefaultRegistry() *adapter.Registry {
	return adapter.NewRegistry(New())
}

// Detect enumerates Claude Code session transcripts under the projects
// directory (~/.claude/projects/**/*.jsonl), best-effort: session ids come
// from file names, and recency from file modification times, because
// transcript filenames are opaque ULID-ish ids. An explicit dir argument
// overrides the configured projects directory. A missing or empty directory
// yields an empty slice, not an error — absence of sessions is not a
// failure. Results are newest first, ties broken by native id.
func (c *Claude) Detect(ctx context.Context, dir string) ([]adapter.SessionRef, error) {
	root := dir
	if root == "" {
		root = c.projectsDir()
	}
	if root == "" {
		return nil, fmt.Errorf("claude detect: projects directory could not be resolved")
	}

	var refs []adapter.SessionRef
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal (best-effort)
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		refs = append(refs, adapter.SessionRef{
			Provider:    protocol.ProviderClaude,
			NativeID:    strings.TrimSuffix(d.Name(), ".jsonl"),
			LastEventAt: info.ModTime().UTC(),
		})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	if refs == nil {
		refs = []adapter.SessionRef{}
	}
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].LastEventAt.Equal(refs[j].LastEventAt) {
			return refs[i].LastEventAt.After(refs[j].LastEventAt)
		}
		return refs[i].NativeID < refs[j].NativeID
	})
	return refs, nil
}

// hookCommand resolves the hook command to install, defaulting to the
// current executable (same convention as the codex lane).
func (c *Claude) hookCommand() string {
	if c.HookCommand != "" {
		return c.HookCommand
	}
	exe, err := os.Executable()
	if err != nil {
		return "handoffgraph"
	}
	return exe
}

// Install merges HandoffGraph hook entries into ~/.claude/settings.json via
// integrations/claude (additive, fail-closed, idempotent, timestamped
// backup). Only user scope is supported; project scope (.claude/settings.json
// inside a repository) is deferred and fails with ErrUnsupported rather
// than fabricating support.
func (c *Claude) Install(ctx context.Context, scope adapter.InstallScope) error {
	if scope == adapter.ScopeProject {
		return fmt.Errorf("claude install: project scope: %w (deferred)", ErrUnsupported)
	}
	return claudehooks.InstallHooks(claudehooks.Options{
		ConfigDir:   c.configDir(),
		HookCommand: c.hookCommand(),
		DryRun:      c.DryRun,
	})
}

// Uninstall removes every marked HandoffGraph hook entry from
// ~/.claude/settings.json, preserving all user configuration. Only user
// scope is supported.
func (c *Claude) Uninstall(ctx context.Context, scope adapter.InstallScope) error {
	if scope == adapter.ScopeProject {
		return fmt.Errorf("claude uninstall: project scope: %w (deferred)", ErrUnsupported)
	}
	return claudehooks.UninstallHooks(claudehooks.Options{
		ConfigDir: c.configDir(),
		DryRun:    c.DryRun,
	})
}

// NewResumeCommand builds the native resume invocation for a Claude Code
// session: `claude --resume <session-id>`.
func NewResumeCommand(sessionID string) (string, []string) {
	return "claude", []string{"--resume", sessionID}
}

// NewForkCommand builds the native fork invocation: `claude --resume
// <session-id> --fork-session`. Forking starts a new session id seeded with
// the old transcript, leaving the original untouched.
func NewForkCommand(sessionID string) (string, []string) {
	return "claude", []string{"--resume", sessionID, "--fork-session"}
}

// validateSessionID rejects empty and dash-prefixed session ids so a
// hostile or mistyped id can never smuggle extra CLI flags into the
// resumed invocation.
func validateSessionID(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("claude resume: session id is required")
	}
	if strings.HasPrefix(sessionID, "-") {
		return fmt.Errorf("claude resume: invalid session id %q", sessionID)
	}
	return nil
}

// Resume returns the exec spec continuing an existing native session
// (`claude --resume <session-id>`).
func (c *Claude) Resume(ctx context.Context, ref adapter.SessionRef) (adapter.ExecSpec, error) {
	if err := validateSessionID(ref.NativeID); err != nil {
		return adapter.ExecSpec{}, err
	}
	name, args := NewResumeCommand(ref.NativeID)
	return adapter.ExecSpec{Command: name, Args: args}, nil
}

// Fork returns the exec spec forking an existing native session into a new
// one (`claude --resume <session-id> --fork-session`).
func (c *Claude) Fork(ctx context.Context, ref adapter.SessionRef) (adapter.ExecSpec, error) {
	if err := validateSessionID(ref.NativeID); err != nil {
		return adapter.ExecSpec{}, err
	}
	name, args := NewForkCommand(ref.NativeID)
	return adapter.ExecSpec{Command: name, Args: args}, nil
}

// StartFromCheckpoint starts a new interactive Claude Code session seeded by
// a bounded checkpoint prompt. The prompt is a single argv element with a
// fixed non-option prefix, so checkpoint-controlled text cannot be interpreted
// as Claude CLI flags and no shell is involved.
func (c *Claude) StartFromCheckpoint(ctx context.Context, cp *protocol.Checkpoint) (adapter.ExecSpec, error) {
	if cp == nil {
		return adapter.ExecSpec{}, fmt.Errorf("claude start-from-checkpoint: checkpoint required")
	}
	return adapter.ExecSpec{Command: "claude", Args: []string{checkpointPrompt(cp)}}, nil
}

// checkpointPrompt is deliberately small enough for a CLI argument. The
// continuation layer prints the complete evidence payload alongside this
// native invocation; this seed identifies the exact checkpoint and requires
// acknowledgement before the receiving agent acts.
func checkpointPrompt(cp *protocol.Checkpoint) string {
	objective := []rune(cp.Objective)
	if len(objective) > 4000 {
		objective = objective[:4000]
	}
	return fmt.Sprintf("Continue workstream %s (checkpoint %s). Objective: %s. Acknowledge checkpoint %s before acting.",
		cp.WorkstreamID, cp.CheckpointID, string(objective), cp.CheckpointID)
}

// Compile-time interface compliance check.
var _ adapter.Adapter = (*Claude)(nil)
