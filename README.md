# HandoffGraph

> **Switch AI coding agents without losing the work—or the evidence behind it.**

HandoffGraph is a local-first **verified cross-agent continuity and session-debugging layer** for AI coding agents (Claude Code, Codex, Pi). It shows exactly where a session failed, turns the evidence into a portable checkpoint, and lets another native agent continue safely.

Your agent stops. The work should not.

---

## Status

**v0.6.0-level local product, pre-release** — test suite race-clean. Implemented: the crash-safe local event spine (append-only events, SQLite, deterministic graph/trace reducers, fail-closed redaction, checkpoints); **Codex, Claude, and Pi adapters** with merge-safe hook installers, native-rollout normalization with deterministic (idempotent) event IDs, and native resume; the **local MCP stdio server** (11 goal-oriented tools incl. the scores primitive); the **deterministic detection pack**; the embedded **Session Debugger UI** (`handoffgraph open`); and **verified cross-agent continuation** (`continue --to`) with repository-drift checks and machine-readable acknowledgement.

The repository now also contains an ahead-of-roadmap **private hosted Basic
foundation** under `platform/`: AuthKit-compatible sign-up/sign-in, hashed
browser sessions and device credentials, a D1 entitlement schema, atomic hard
quotas including 2 active devices and 10 lifetime device-token issuances, a
50-account beta ceiling, and an account/usage UI. It is not publicly deployed
and no paid checkout exists. Production identity credentials, edge
abuse controls, remote migration, domains, deletion/privacy operations, and
explicit CLI sync policy remain release gates in [ROADMAP.md](ROADMAP.md).

## Quickstart

Until the first tagged public release, build the CLI from a source checkout:

```bash
git clone https://github.com/arbazkhan971/handoffgraph.git
cd handoffgraph
go install ./cmd/handoffgraph

handoffgraph init
handoffgraph workstream new "fix checkout race"
handoffgraph event import ./testdata/fixtures/claude.jsonl
handoffgraph traces
handoffgraph detect
handoffgraph checkpoint --workstream <id> --objective "fix duplicate checkout"
handoffgraph open            # local session debugger UI
handoffgraph doctor
```

After the repository is available at its canonical module path and a release
has been tagged, installation becomes:

```bash
go install github.com/handoffgraph/handoffgraph/cmd/handoffgraph@latest
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
handoffgraph resume <native-session-id>        # print the native continue command (codex resume <id>)
```

Install only ever touches the managed `[hooks.handoffgraph]` table: an
unparseable config is never modified, an existing differing hook is reported
as a conflict instead of being overwritten, and unrelated keys are preserved.
Re-importing the same session produces no duplicate events. `resume` prints
the exact shell-quoted native invocation (`codex resume <id>`) for you to
run — HandoffGraph never launches agent processes itself; `sessions --detect`
reads native sessions directly from `~/.codex/sessions` without importing
them (override the directory with `HFG_CODEX_SESSIONS_DIR`). See
[docs/adapter-codex.md](docs/adapter-codex.md) for details.

## Verified continuation (v0.6.0)

Create a checkpoint, preview the exact bounded payload without writing
anything, then record the handoff:

```bash
handoffgraph checkpoint --workstream <id> --objective "fix duplicate checkout"
handoffgraph continue --to codex --workstream <id> --preview
handoffgraph continue --to codex --workstream <id>
handoffgraph handoff status --json
```

`continue` chooses native resume when the target matches a resumable source
session; otherwise it creates a checkpoint-seeded start for Codex, Claude, or
Pi. It compares the current repository with the checkpoint, preserves
provenance in a payload capped at 12,000 characters, and records an append-only
`handoff.created` event unless `--preview` is used. The CLI prints the
shell-quoted native invocation and the payload for the user to run; it never
starts an agent process itself.

The payload includes an `hfg://` checkpoint reference and asks an MCP-capable
receiving agent to call `accept_handoff`. That tool records
`handoff.accepted` plus the sections accepted, missing, or unverifiable;
`handoffgraph handoff status` derives the current acknowledgement state from
those events.

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
| `handoffgraph otlp import <file>` / `otlp serve` | Ingest OTLP/JSON telemetry into the spine (idempotent, localhost listener) |
| `handoffgraph install --agent codex\|claude\|pi` | Install merge-safe capture hooks (`--dry-run` previews) |
| `handoffgraph sessions [--agent <name>] [--json]` | List native sessions derived from captured events, or detect native sessions on disk (`--detect`) |
| `handoffgraph resume <native-session-id>` | Print the native resume invocation; never execute it |
| `handoffgraph continue --to <agent> --workstream <id> [--preview]` | Prepare or record a verified continuation and print its native invocation |
| `handoffgraph handoff status [--json]` | Show recorded handoffs and machine acknowledgement state |
| `handoffgraph traces [--json]` | List materialized turn traces |
| `handoffgraph detect` | Run the deterministic detection pack over traces |
| `handoffgraph graph [--json]` | Export the derived workstream graph |
| `handoffgraph checkpoint --workstream <id>` | Build a checkpoint from workstream evidence |
| `handoffgraph checkpoint --from-trace <id>` | Build a checkpoint from one materialized trace |
| `handoffgraph checkpoint show <id> [--json]` | Inspect a stored checkpoint |
| `handoffgraph mcp serve` | Run the local MCP stdio server (11 goal-oriented tools) |
| `handoffgraph open` | Serve the local Session Debugger UI (localhost only) |
| `handoffgraph score record ...` / `score list` | Record/list source-tagged quality scores (numeric, category, boolean) on any spine object |
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
  launch/                  continuation payload, drift, acknowledgement read model
  detection/               deterministic session-pathology rules
  mcp/                     local MCP stdio server (11 tools incl. scores)
  scores/                  score read model + validated payload builder
  webui/                   embedded debugger API and static assets
  fixture/                 synthetic event generator
  verify/                  fixture verification harness
protocol/schema/v1/        JSON Schemas
platform/                  Private hosted-beta Worker, accounts, D1 quotas
landing/                   Public landing Worker and waitlist
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
