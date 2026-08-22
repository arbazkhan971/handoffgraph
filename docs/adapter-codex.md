# Codex adapter (v0.2.0)

The Codex adapter captures OpenAI Codex CLI sessions into the local event
spine. It reads native rollout transcripts, normalizes them into
`hfg.event.v1` events, manages hook blocks in the Codex CLI config, and
produces the native `codex resume` invocation for continuing sessions.
Checkpoint-seeded launch (`StartFromCheckpoint`) produces a launch spec;
executing specs from the CLI is deferred to v0.6.0.

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

`handoffgraph install --agent codex` writes exactly six managed per-event
tables into the Codex CLI config (`~/.codex/config.toml`), one per hook
event (`session_start`, `session_end`, `pre_tool_use`, `post_tool_use`,
`turn_start`, `turn_end`). Each block carries the `# hfg:managed` marker so
uninstall removes exactly our blocks and nothing else. Nothing else in the
file is created or changed; a timestamped backup is written before any
modification. The managed tables replace the single-table form below — `session.started`, `prompt.submitted`,
`assistant.completed`, `tool.completed`, `command.completed`,
`session.ended`. Nothing else in the file is created or changed. Uninstall
removes only that table.

## Config schema

```toml
[hooks.handoffgraph]
command = "handoffgraph hook codex"   # override with --hook-command

[hooks.handoffgraph.events]
session.started       = true
prompt.submitted      = true
assistant.completed   = true
tool.completed        = true
command.completed     = true
session.ended         = true
```

## Conflict behavior (fail-closed)

| Situation | Behavior |
|---|---|
| Config unparseable | Never modified |
| Existing managed hook differs from desired | `ErrHookConflict`; never overwritten |
| Unrelated keys or tables present | Preserved |
| Managed table already matches | No-op (install is idempotent) |
| `--dry-run` | All checks run, nothing written |

Writes are atomic (temp file + rename). A conflicting hook is never resolved
by overwriting user configuration; resolve it manually or pass
`--hook-command` to match what is already there.

## Dry-run and flags

```bash
handoffgraph install --agent codex --dry-run            # preview only
handoffgraph install --agent codex --hook-command <cmd> # custom hook command
handoffgraph install --agent codex --config-dir <dir>   # non-default config dir
```

There is no `uninstall` subcommand yet (planned): removing hooks is currently
API-only via the adapter's `Uninstall` method. It removes exactly the managed
table above, under the same fail-closed rules as install (an unparseable
config is never modified, unrelated keys are preserved).

## Deterministic import

Normalized events derive stable `evt_<ulid>` IDs from `(provider, native
session id, sequence, occurred-at, content hash)`. Importing the same
session twice yields identical event IDs, and because the event store is
idempotent on `event_id`, re-import adds no duplicate events.

## Session listing

- `handoffgraph sessions [--agent codex] [--json]` lists native sessions
  derived from captured events: provider, native session id, event count,
  first/last seen. For listing sessions straight from disk instead, see
  "Detecting local sessions" below.

## Resuming a session

`handoffgraph resume <native-session-id> [--agent codex]` prints the exact
shell-quoted native invocation (`codex resume <native-session-id>`) so you
can run it yourself — HandoffGraph never launches agent processes, and ids
are validated (empty and dash-prefixed values are rejected) so a hostile id
cannot smuggle flags into the printed command. `StartFromCheckpoint`
similarly produces a launch spec seeded by a checkpoint (objective clamped,
passed after an explicit `--` separator); executing these specs from the CLI
is deferred to the v0.6.0 cross-agent continuation work per ROADMAP.md.

## Detecting local sessions

`handoffgraph sessions --detect [--agent codex] [--json]` lists native Codex
sessions directly from `~/.codex/sessions` without importing them. Override
the directory with the `HFG_CODEX_SESSIONS_DIR` environment variable. Only
codex is supported today; if detection is unavailable the command reports an
empty listing (`ErrNotDetected`).
