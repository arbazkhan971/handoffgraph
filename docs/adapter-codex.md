# Codex adapter (v0.2.0)

The Codex adapter captures OpenAI Codex CLI sessions into the local event
spine. It reads native rollout transcripts, normalizes them into
`hfg.event.v1` events, manages hook blocks in the Codex CLI config, and
produces the native `codex resume` invocation for continuing sessions.
Checkpoint-seeded interactive launch (`StartFromCheckpoint`) is wired into
the v0.6.0 `handoffgraph continue --to codex` flow. A separate read-only
App Server session lister is available for clients that want Codex's native
thread index without parsing rollout files.

## Capture

Codex stores session transcripts as JSONL rollout files under
`~/.codex/sessions` (layout varies by version, e.g.
`sessions/YYYY/MM/DD/rollout-*.jsonl`). `Detect` enumerates them newest
first; `Normalize` maps recognized line types onto canonical kinds:

| Native | Canonical kind |
|---|---|
| `session_meta` | `session.started` |
| `event_msg{user_message}` | `prompt.submitted` |
| `event_msg{agent_message}` | `assistant.completed` |
| `response_item{function_call}` | `tool.started` |
| `response_item{function_call_output}` | `tool.completed` |
| `response_item{exec_command, …exit}` | `command.completed` |
| anything else | `log.observed` (`source_kind` preserved) |

Nothing is dropped silently and no provenance is upgraded: every fact parsed
from a transcript is `OBSERVED`. Malformed lines fail with their line number.

## What gets installed

`handoffgraph install --agent codex` adds exactly one HandoffGraph matcher
group for each hook event supported by Codex 0.144.3:

`PermissionRequest`, `PostCompact`, `PostToolUse`, `PreCompact`, `PreToolUse`,
`SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`, and
`UserPromptSubmit`.

These are the exact, case-sensitive HooksToml enum names. `Stop` means the
current response/turn stopped and maps to `trace.completed`; it is not
presented as a session end. Direct adapter normalization tolerates an incoming
`SessionEnd` payload for forward compatibility, but the public installed hook
fails closed on it because Codex 0.144.3 does not expose it as an installable
event.

Each installed group carries the `# hfg:managed` ownership marker. Existing
user-owned matcher groups—even for the same event—remain byte-for-byte and in
their original order; HandoffGraph appends its own group. Before changing an
existing file, install writes a timestamped backup. Uninstall removes only the
marker-owned regions.

## Config schema

One of the ten generated groups has this shape (the installer repeats it for
the other events):

```toml
# hfg:managed
# hfg:prefix-newline=false
[[hooks.SessionStart]]
matcher = ""

[[hooks.SessionStart.hooks]]
type = "command"
command = "/absolute/path/to/handoffgraph hook codex"
# Windows installs also emit Codex's schema-native commandWindows field.
```

The default is the shell-quoted absolute path of the running executable. On
Windows the installer uses cmd.exe-safe double quoting and Codex's documented
`commandWindows` override; executable paths that cannot be represented safely
fail closed. A custom `--hook-command` replaces that complete command; no
per-event argument is appended because Codex supplies `hook_event_name` in the
stdin JSON.

## Conflict behavior (fail-closed)

| Situation | Behavior |
|---|---|
| Config unparseable | Never modified |
| Existing user matcher group for the same event | Preserved; managed group appended |
| Unmarked group already runs the exact HandoffGraph command | `ErrHookConflict` to prevent double capture |
| Duplicate/ambiguous marker or malformed hook shape | `ErrHookConflict`; never modified |
| Marker-owned group drifted | Reasserted from the requested command; user groups untouched |
| Exact managed groups already match | No-op (install is idempotent) |
| `--dry-run` | All checks run, nothing written |

Writes are atomic (temp file, fsync, rename, and parent-directory sync where
supported), HandoffGraph operations serialize on a user-config lock, and the
snapshot is compared again immediately before replacement so a concurrent
external edit fails closed. Backups are published without overwriting an
existing path, and a symlinked config is refused. The installer never writes
Codex trust state. Codex 0.144.3 reviews hook-specific hashes and may display
**Hooks need review** after install; the user must approve HandoffGraph in that
review before callbacks execute.

On a successful callback, `handoffgraph hook codex` writes nothing to stdout:
Codex treats hook stdout as control/context output, so capture cannot inject
text into the model. Input is bounded to one MiB and must be exactly one UTF-8
JSON object matching the required field/type contract for that exact 0.144.3
event. Unknown event names and malformed, trailing, oversized, sessionless,
normalization, or database errors fail closed before a partial batch can commit.

## Dry-run and flags

```bash
handoffgraph install --agent codex --dry-run            # preview only
handoffgraph install --agent codex --hook-command <cmd> # custom hook command
handoffgraph install --agent codex --config-dir <dir>   # non-default config dir
```

`handoffgraph codex uninstall [--config-dir <dir>] [--dry-run]` removes only
the marker-scoped managed hooks under the same fail-closed rules. An
unparseable config is never modified and unrelated keys are preserved.

## Deterministic import

Normalized events derive stable `evt_<ulid>` IDs from `(provider, native
session id, sequence, occurred-at, content hash)`. Importing the same
session twice yields identical event IDs, and because the event store is
idempotent on `event_id`, re-import adds no duplicate events.

The public native-import path associates those observed events with an
existing HandoffGraph workstream and a provider-scoped deterministic canonical
session. It rejects a missing workstream. The batch runs in one
`BEGIN IMMEDIATE` transaction; any immutable-envelope or canonical-session
ownership conflict rolls back every insert before commit.

```bash
handoffgraph codex sessions --json
handoffgraph codex normalize <rollout.jsonl> --workstream <ws_id> --import
handoffgraph checkpoint --workstream <ws_id> --objective "continue safely"
```

Omit `--import` to emit canonical JSONL, or add `--json` for an indented JSON
array. `--import` and `--json` are mutually exclusive.

## Session listing

- `handoffgraph sessions [--agent codex] [--json]` lists native sessions
  derived from captured events: provider, native session id, event count,
  first/last seen. For listing sessions straight from disk instead, see
  "Detecting local sessions" below.

### Read-only App Server listing

```bash
handoffgraph codex app-server-sessions
handoffgraph codex app-server-sessions --json
handoffgraph codex app-server-sessions --page-size 100 --max-pages 100
```

This is intentionally a distinct surface from file-based `codex sessions` and
`sessions --detect`; it does not replace them or change `Detect`. HandoffGraph
launches one executable directly as `codex app-server --stdio` (no shell),
performs the required `initialize` response / `initialized` notification
handshake, then sends only stable `thread/list` requests. It does not opt into
experimental capabilities and does not support the App Server WebSocket or
Unix-socket transports.

Every list request is explicit and read-only:

- `useStateDbOnly: true` prevents the default rollout scan-and-repair path;
- `sortKey: created_at` and `sortDirection: desc` are fixed, with a native-id
  tie-break after all pages are collected;
- page size and page count are bounded (defaults 100 × 100, hard maxima
  1,000 × 1,000); a remaining cursor at the bound is an error, never a
  silently truncated result;
- repeated cursors, duplicate thread ids, malformed JSON/results, wrong
  JSON-RPC ids, protocol errors, server-initiated requests, cancellation, and
  process failures all discard the partial result and fail closed;
- no thread/turn start, resume, fork, archive, delete, metadata update,
  command execution, or approval method is sent.

The stable thread summary is mapped into the same HandoffGraph
`adapter.SessionRef` used by native adapters:

| App Server field | HandoffGraph descriptor |
|---|---|
| `id` | `native_id` (opaque; no `thr_` prefix assumption) |
| `sessionId` | `metadata.native_group_id` |
| `createdAt` / `updatedAt` | `started_at` / `last_event_at` |
| `cwd` | `metadata.working_dir` |
| `name` / `preview` | `metadata.title` / `metadata.preview` |
| `modelProvider` / `cliVersion` | native metadata fields |
| `source` / `ephemeral` | canonical native metadata |

The App Server's unstable rollout `path` field is ignored, and a list response
that unexpectedly includes turn contents is rejected. Listing does not import
events or read message/turn bodies. The implementation and live acceptance
were verified against Codex CLI 0.144.3 using the stable stdio schema described
in the [official Codex App Server documentation](https://developers.openai.com/codex/app-server/).

## Resuming a session

`handoffgraph resume <native-session-id> [--agent codex]` prints the exact
shell-quoted native invocation (`codex resume <native-session-id>`) so you
can run it yourself — HandoffGraph never launches agent processes, and ids
are validated (empty and dash-prefixed values are rejected) so a hostile id
cannot smuggle flags into the printed command. `StartFromCheckpoint`
similarly produces an interactive new-session launch spec (`codex --
<payload>`) seeded by a checkpoint, with the objective clamped and passed
after an explicit `--` separator. `continue` prints that invocation and a
bounded, evidence-backed payload; it records `handoff.created` unless
`--preview` is used, but still never executes Codex. The payload carries an
`hfg://` checkpoint reference so a receiving MCP client can call
`accept_handoff`; the resulting acknowledgement is visible through
`handoffgraph handoff status`.

## Detecting local sessions

`handoffgraph sessions --detect [--agent codex] [--json]` lists native Codex
sessions directly from `~/.codex/sessions` without importing them. Override
the directory with the `HFG_CODEX_SESSIONS_DIR` environment variable. The
provider-specific `handoffgraph codex sessions [--json]` form includes each
transcript path for direct use with `codex normalize`. If detection is
unavailable the command reports an empty listing (`ErrNotDetected`).
