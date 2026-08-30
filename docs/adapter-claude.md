# Claude Code adapter

The Claude Code adapter manages fail-closed capture hooks, detects native
JSONL transcripts, normalizes them into deterministic `hfg.event.v1` events,
and prepares native resume, fork, and checkpoint-seeded continuation specs.
Provider evidence remains `OBSERVED`; a user-selected HandoffGraph workstream
is routing metadata and never upgrades inferred data.

## Detect and import a native transcript

```bash
handoffgraph claude sessions --detect --json
handoffgraph workstream new "continue checkout investigation"
handoffgraph claude normalize <transcript.jsonl> --workstream <ws_id> --import
handoffgraph checkpoint --workstream <ws_id> --objective "continue safely"
```

`sessions --detect` reads `~/.claude/projects/**/*.jsonl` without importing or
modifying a transcript. JSON output includes each transcript path; the stable
text form remains the five-column provider/id/events/first/last listing.
Override that root with `HFG_CLAUDE_PROJECTS_DIR` or `--projects-dir`.

`normalize` accepts native Claude transcript records with `sessionId` as well
as hook/stream records with `session_id`. It requires all explicit native IDs
in one file to agree, applies one global sequence across the transcript, and
derives stable event IDs. If older records omit the native ID, the transcript
filename stem is the deterministic fallback.

`--import` requires an existing, valid workstream. The canonical session ID is
deterministically scoped by provider plus native session ID unless an explicit
valid `--session` is supplied. The batch runs in one `BEGIN IMMEDIATE`
transaction: an identical retry is a no-op, while any immutable-envelope or
canonical-session ownership conflict rolls back every insert before commit.
Omit `--import` for canonical JSONL, or use `--json` for an indented array; the
two flags are mutually exclusive.

## Hooks and native continuation

```bash
handoffgraph claude install --dry-run
handoffgraph claude install
handoffgraph claude uninstall
handoffgraph claude resume <native-session-id>
handoffgraph claude resume <native-session-id> --fork
```

Install adds one matcher group for each of Claude Code 2.1.227's eight pinned
events: `PostCompact`, `PostToolUse`, `PreCompact`, `PreToolUse`, `SessionEnd`,
`SessionStart`, `Stop`, and `UserPromptSubmit`. `Stop` closes a response/trace;
`SessionEnd` closes the native session. The generated handler uses only the
schema's command-handler fields:

```json
{
  "matcher": "",
  "hooks": [{
    "type": "command",
    "command": "/absolute/path/to/handoffgraph",
    "args": ["hook", "claude"]
  }]
}
```

The executable is stored raw and the arguments stay separate on every OS, so
Windows does not depend on a `cmd.exe`-combined command string. An explicit
`--hook-command` remains a shell-form override and is stored without `args`.
Tests pin the handler key set and current event names so schema drift fails
before release.

Claude settings contain no HandoffGraph-only marker key. Ownership is recorded
in the private `~/.claude/.handoffgraph-hooks.json` sidecar (mode `0600` on
POSIX; inherited ACL semantics on Windows) while a separate lock serializes
changes. Install and uninstall require one exact sidecar-owned group per event;
a missing, changed, or duplicate group and an unowned equivalent command fail
closed. User hooks and unrelated settings are preserved. Settings backups are
exact, no-overwrite, and symlink-safe; every settings/sidecar transaction edge
rechecks both files immediately before rename or removal.

The sidecar records `installing`/`uninstalling` transactions with before/after
digests. After a crash, the next operation completes only the uniquely matching
state; intervening edits cause `ErrHookConflict`. A historical exact seven-event
inline-marker install is migrated by removing those markers, switching to the
schema-native command/args shape, and adding `SessionEnd`. Partial, malformed,
foreign, or marker-stripped legacy shapes are never removed or duplicated.

The public handler accepts exactly one UTF-8 JSON object up to one MiB,
normalizes it, and appends the batch atomically to the local database. It emits
no stdout on success so hook capture cannot add model-visible context;
malformed, trailing, oversized, sessionless, or storage failures return an
error without a partial commit. Resume/fork IDs reject empty or option-shaped
values and are passed directly to the Claude executable without a shell.

`handoffgraph continue --to claude --workstream <ws_id>` records a bounded,
evidence-backed handoff and prints the native launch spec; `--preview` records
nothing. The receiving MCP client acknowledges it with `accept_handoff`, and
`handoffgraph handoff status` exposes the machine-verifiable result.
