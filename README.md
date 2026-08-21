# HandoffGraph

> **Switch AI coding agents without losing the work—or the evidence behind it.**

HandoffGraph is a local-first **verified cross-agent continuity and session-debugging layer** for AI coding agents (Claude Code, Codex, Pi). It shows exactly where a session failed, turns the evidence into a portable checkpoint, and lets another native agent continue safely.

Your agent stops. The work should not.

---

## Status

**v0.2.0 (Codex adapter, in progress).** This repository implements the crash-safe local event spine — append-only event storage, deterministic graph/trace reducers, fail-closed redaction, and the evidence-first checkpoint builder — plus the Codex adapter: session capture via Detect/Normalize over native rollout transcripts, hook install/uninstall in the Codex CLI config, deterministic event IDs so re-importing a session is idempotent, and native resume via the non-interactive `codex exec resume` command. Checkpoint-seeded launch (`StartFromCheckpoint`) remains deferred (planned v0.2.x); Claude and Pi adapters, the Session Debugger UI, and Cloudflare sync land in later versions per [ROADMAP.md](ROADMAP.md).

## Quickstart

```bash
go install github.com/handoffgraph/handoffgraph/cmd/handoffgraph@latest

handoffgraph init
handoffgraph workstream new "fix checkout race"
handoffgraph event import ./testdata/fixtures/claude.jsonl
handoffgraph traces
handoffgraph checkpoint --workstream <id> --objective "fix duplicate checkout"
handoffgraph graph --json
handoffgraph doctor
```

Local-first. No account required.

## Codex capture (v0.2.0)

Capturing Codex sessions requires a local Codex CLI install. Install the
observation hooks, then import what they capture:

```bash
handoffgraph install --agent codex --dry-run   # preview; writes nothing
handoffgraph install --agent codex             # manage [hooks.handoffgraph] in ~/.codex/config.toml
handoffgraph sessions                          # list captured native Codex sessions
handoffgraph sessions --detect                 # list native Codex sessions found on disk, without importing them
handoffgraph resume <native-session-id>        # continue a Codex session via codex exec resume
```

Install only ever touches the managed `[hooks.handoffgraph]` table: an
unparseable config is never modified, an existing differing hook is reported
as a conflict instead of being overwritten, and unrelated keys are preserved.
Re-importing the same session produces no duplicate events. `resume` performs
the native resume by launching the non-interactive `codex exec resume` form,
so hook observation still captures the resumed run; `sessions --detect`
reads native sessions directly from `~/.codex/sessions` without importing
them (override the directory with `HFG_CODEX_SESSIONS_DIR`). See
[docs/adapter-codex.md](docs/adapter-codex.md) for details.

## What it does

A **workstream** joins multiple native sessions from different agents and links trace evidence to a safe next-agent handoff:

```
Workstream: fix-checkout-race
├── Claude session: claude_abc
│   ├── decision: use an idempotency key
│   ├── changed: src/checkout.ts
│   └── test failed: checkout.concurrent.test.ts
├── Codex thread: codex_xyz
│   ├── continued from checkpoint cp_019
│   ├── changed: src/checkout.ts
│   └── test passed: checkout.concurrent.test.ts
└── Pi session: pi_123
    ├── reviewed commit: 71ab20
    └── found regression: refund flow
```

Every claim in a checkpoint is linked to evidence: an observed file edit points to the tool event and diff, a "tests pass" claim points to a captured command and exit status, and a decision is labelled `OBSERVED`, `DECLARED`, or `INFERRED`.

## CLI (current)

| Command | Purpose |
|---|---|
| `handoffgraph init` | Initialize the local data directory |
| `handoffgraph doctor` | Diagnose config and database health |
| `handoffgraph status` | Show local capture status |
| `handoffgraph workstream new <title>` | Create a workstream |
| `handoffgraph event import <file>` | Import a JSONL event fixture |
| `handoffgraph install --agent codex` | Install Codex hooks (`--dry-run` previews; `--hook-command`, `--config-dir` optional) |
| `handoffgraph sessions [--agent <name>] [--json]` | List native sessions derived from captured events, or detect native sessions on disk (`--detect`) |
| `handoffgraph resume <native-session-id> [--agent codex]` | Perform a native resume for codex via `codex exec resume` |
| `handoffgraph traces [--json]` | List materialized turn traces |
| `handoffgraph graph [--json]` | Export the derived workstream graph |
| `handoffgraph checkpoint --workstream <id>` | Build a checkpoint from evidence |
| `handoffgraph redact --preview <file>` | Preview fail-closed redaction |
| `handoffgraph fixture verify <dir>` | Verify golden fixtures |
| `handoffgraph version` | Print the HandoffGraph version |

## Architecture

```
Claude / Codex / Pi hooks
        │
        ▼
Local Go collector
  ├── crash-safe spool (JSONL)
  ├── SQLite (WAL) append-only event store
  ├── content-addressed compressed object store
  ├── deterministic graph reducer  ──► stable root hash
  ├── deterministic trace/span materializer
  ├── fail-closed redaction v1
  └── evidence-first checkpoint builder (no model)
```

See [docs/architecture.md](docs/architecture.md) for the full design and [docs/privacy.md](docs/privacy.md) for the privacy model.

## Design guarantees

- **Append-only.** Raw events are never rewritten; unknown fields are preserved.
- **Deterministic.** Rebuilding the graph from the event log produces the same root hash every time.
- **Fail-closed redaction.** If a redaction step errors, the object is marked `REDACTION_FAILED` and never exported in its original form.
- **No model dependency.** Checkpoints are built from observed evidence; model compression (if added later) is clearly labelled `INFERRED`.
- **No cloud dependency.** Local capture works with the network disabled.

## Layout

```
cmd/handoffgraph/          CLI entrypoint
internal/
  cli/                     command framework
  commands/                subcommand implementations
  adapter/                 provider adapters (interface, registry, capabilities)
    codex/                 Codex rollout capture + hook install/uninstall
  protocol/                versioned wire contracts (event, checkpoint, trace)
  ids/                     ULID identifiers
  content/                 canonical JSON + content hashing
  object/                  content-addressed compressed object store
  config/                  user/repo config loading
  repository/              Git identity + worktree state
  storage/                 SQLite migrations + event store
  ingest/                  crash-safe spool + JSONL importer
  graph/                   workstream graph + deterministic reducer
  trace/                   trace/span materializer
  redact/                  fail-closed redaction v1
  checkpoint/              checkpoint builder + handoff score
  fixture/                 synthetic event generator
  verify/                  fixture verification harness
protocol/schema/v1/        JSON Schemas
docs/                      architecture, privacy, adapters, roadmap
```

## Development

```bash
go test ./...
go test -race ./...
go vet ./...
gofmt -l .
```

## License

Apache-2.0. See [LICENSE](LICENSE). The hosted team service will be a separate commercial offering; the local core is and remains free.
