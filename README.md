# HandoffGraph

> **Switch AI coding agents without losing the work—or the evidence behind it.**

HandoffGraph is a local-first **verified cross-agent continuity and session-debugging layer** for AI coding agents (Claude Code, Codex, Pi). It shows exactly where a session failed, turns the evidence into a portable checkpoint, and lets another native agent continue safely.

Your agent stops. The work should not.

---

## Status

**v0.7.0-beta.1 release candidate** — implemented and under final publication
validation. The local product includes the crash-safe event spine (append-only
events, SQLite, deterministic graph/trace reducers, fail-closed redaction,
checkpoints); **Codex, Claude, and Pi adapters** with merge-safe hook
installers, native-rollout normalization with deterministic event IDs, and
native resume; the **local MCP stdio server** (12 goal-oriented tools); the
**deterministic detection pack**; the embedded **Session Debugger UI**
(`handoffgraph open`); and **verified cross-agent continuation** (`continue
--to`) with repository-drift checks and machine-readable acknowledgement.

Since then the local core also gained OTLP/HTTP ingest in both wire flavors, a
scores primitive, a wide observation index with `signal_source` coalescing and
exception groups, the `verify` CI gate with result caching, datasets ×
experiments, an immutable prompt store, explicit redacted hosted `sync`, and
`reset` — 34 commands in all. The beta remains pre-1.0: interfaces may change
under the versioning policy, and hosted production is not part of this tag.

The repository also contains an ahead-of-roadmap **private hosted tier** under
`platform/` — a **Cloudflare-only** Worker (D1, R2, KV, Queues, Workflows,
Durable Objects, Analytics Engine, Cron Triggers; no Go servers, no Docker).
On top of the original Basic foundation (AuthKit-compatible sign-up/sign-in,
hashed browser sessions and device credentials, a D1 entitlement schema,
atomic hard quotas including 2 active devices and 10 lifetime device-token
issuances, a 50-account beta ceiling, and an account/usage UI), it now
implements:

- **Ingest** — OTLP/HTTP in both wire flavors (JSON **and** protobuf), with
  event ids byte-identical to the Go core's; idempotent batch events.
- **Read models** — wide `span_observations`, first-class sessions, 30-minute
  `ts_bucket` pruning, resource fingerprints, admin reindex.
- **Teams & governance** — workspace roles (owner/admin/member/viewer),
  invites with hash-only tokens, seats, last-owner protection, and a
  hash-chained audit trail whose chain is enforced by D1 triggers.
- **Storage lifecycle** — R2 artifact tiering with a D1 file-list index and
  cron compaction; batch export to R2 with download; retention that sweeps
  **derived models only** — the event spine is never TTL'd.
- **Operations** — outbound webhooks over Queues (HMAC-signed, content-free);
  dashboards-as-config (versioned immutable JSON, CI dry-run validate, share
  links); scheduled alerts with webhook/Slack/email channels, each firing
  appended to the spine as history; analytics series/summary and trace funnels.
- **Capture & access** — an OpenAI-compatible gateway (virtual keys, budgets
  as exact decimal strings, rate limits, opt-in response cache, provider
  fallback); a hosted MCP endpoint mirroring the local tool contract; a
  public REST API with `pk_`/`sk_` keys, edge-cached rejection, and an
  OpenAPI 3.1 document; and an explicit-only local CLI sync with fail-closed
  first-upload redaction acceptance and crash-safe idempotent resume.
- **Quality loop** — evals (deterministic checks recorded OBSERVED, LLM judge
  always recorded INFERRED, BYO sealed keys, cron + manual on a durable
  contract); human annotation queues; datasets × experiments and prompt
  reads; a prompt playground with eval-gated CI/CD label repoint and
  rollback; agent simulations; content-addressed multimodal attachments.
- **Enterprise line** — a real directory fence (`platform/ee/`, its own
  LICENSE, an `EE_ENABLED` flag, and a test asserting the OSS baseline stays
  intact) carrying SSO org binding, a SCIM subset, a masking rules engine,
  audit export, and an in-product assistant that answers over our own MCP
  tools with a BYO model and labels every answer INFERRED.

**None of this is serving public production traffic, and no paid checkout
exists.** An isolated, sign-up-closed staging Worker is deployed only for
release verification. Known gaps are stated rather than implied: masking is
not yet wired into the ingest path, SCIM provisioning is a subset, and hosted
batch backpressure is outstanding. Production identity credentials, edge
abuse controls, remote migration, domains, and remaining production
privacy/edge operations remain release gates in [ROADMAP.md](ROADMAP.md).
Feature status per
competitor-parity row lives in
[docs/competitor-analysis.md](docs/competitor-analysis.md) §3.

## Quickstart

For the published beta, install the exact immutable version:

```bash
go install github.com/handoffgraph/handoffgraph/cmd/handoffgraph@v0.7.0-beta.1
handoffgraph version
```

To evaluate an unpublished checkout or contribute, build from source:

```bash
git clone https://github.com/handoffgraph/handoffgraph.git
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

Local-first. No account required.

## Codex capture (v0.2.0)

Capturing Codex sessions requires a local Codex CLI install. Install the
observation hooks; each callback is normalized and appended atomically to the
local event store by the silent `handoffgraph hook codex` handler:

```bash
handoffgraph install --agent codex --dry-run   # preview; writes nothing
handoffgraph install --agent codex             # add marker-scoped groups under [hooks]
handoffgraph sessions                          # list captured native Codex sessions
handoffgraph sessions --detect                 # list native Codex sessions found on disk, without importing them
handoffgraph resume <native-session-id>        # print the native continue command (codex resume <id>)
```

Install adds one marker-owned matcher group for each of Codex 0.144.3's ten
CamelCase hook events. Existing user groups for the same event remain in place;
unparseable or ambiguous configuration and an unmarked duplicate HandoffGraph
command fail closed. A timestamped backup precedes modification, uninstall
removes only marker-owned bytes, and an identical reinstall is a no-op. Codex
reviews hook-specific hashes and may show **Hooks need review** after install;
approve HandoffGraph there before expecting capture. HandoffGraph never writes
or bypasses that trust state. Re-importing the same session produces no duplicate events. `resume` prints
the exact shell-quoted native invocation (`codex resume <id>`) for you to
run — HandoffGraph never launches agent processes itself; `sessions --detect`
reads native sessions directly from `~/.codex/sessions` without importing
them (override the directory with `HFG_CODEX_SESSIONS_DIR`). See
[docs/adapter-codex.md](docs/adapter-codex.md) for details.

## Claude Code capture

`handoffgraph install --agent claude` installs eight additive Claude Code
2.1.227 hook groups, including distinct `Stop` (response/trace completion) and
`SessionEnd` (native-session completion) callbacks. The default handler stores
the raw absolute HandoffGraph executable and `["hook", "claude"]` as separate
arguments on every OS. Its settings objects contain only Claude's schema fields;
ownership lives in a locked, private `.handoffgraph-hooks.json` sidecar under
`~/.claude`. Exact sidecar checks make reinstall idempotent and make drift,
duplicates, and marker-stripped legacy commands fail closed. A complete
historical seven-event marker install migrates safely and gains `SessionEnd`;
partial or malformed legacy objects are preserved as conflicts. Pending
install/uninstall digests provide deterministic crash recovery. See
[docs/adapter-claude.md](docs/adapter-claude.md).

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
| `handoffgraph doctor [--verify]` | Diagnose config and database health; `--verify` runs the deeper checks |
| `handoffgraph reset [--hard --yes]` | Clear derived read models and caches; `--hard` wipes the whole data directory (event log included) and fails closed without `--yes` |
| `handoffgraph sync --preview` / `sync [--accept-redaction]` | Explicit-only hosted transfer: content-free redaction preview, required first-upload acceptance, tenant-scoped deterministic batches, and crash-safe resume; never runs during capture |
| `handoffgraph status` | Show local capture status |
| `handoffgraph workstream new <title>` | Create a workstream |
| `handoffgraph event import <file>` | Import a JSONL event fixture |
| `handoffgraph <codex|claude> normalize <transcript> --workstream <id> --import` | Normalize and idempotently import one native transcript into an existing workstream; canonical session IDs are provider-scoped and deterministic |
| `handoffgraph otlp import <file>` / `otlp serve` | Ingest OTLP/HTTP telemetry into the spine — **JSON and protobuf**, same ids either way (idempotent, localhost listener, `--capture full\|metadata\|minimal` fail-closed privacy tiers) |
| `handoffgraph install --agent <codex|claude|pi>` | Install merge-safe capture hooks (`--dry-run` runs every conflict check without writing) |
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
| `handoffgraph mcp serve` | Run the local MCP stdio server (12 goal-oriented tools) |
| `handoffgraph open` | Serve the local Session Debugger UI (localhost only) |
| `handoffgraph score record ...` / `score list` | Record/list source-tagged quality scores (numeric, category, boolean) on any spine object |
| `handoffgraph index rebuild` / `query spans ...` | Wide denormalized observation index: ts_bucket-pruned, fingerprint-filterable span queries with `--signal-source` / `--include-shadowed` coalescing views (auto-rebuilds when stale) |
| `handoffgraph query exceptions ...` | Derived exception groups (deterministic grouping hash) |
| `handoffgraph query usage ...` / `outcomes ...` | Token/cost rollups per provider or session; per-workstream coding-agent outcomes (files, commands, tests, handoffs, scores) |
| `handoffgraph verify --workstream <id> [--baseline <cp>] [--no-cache]` | Deterministic evidence checks + baseline regression gate; exit 0/1 for CI; appends `verification.recorded` evidence; results are cached (`cached: true` in the report, `--no-cache` recomputes) |
| `handoffgraph dataset create/list` / `experiment run/list/compare` | Immutable content-hash dataset versions; deterministic experiment runs (materialize + detections per example); regression comparison |
| `handoffgraph prompt create/label/list/show` | Immutable prompt versions + mutable labels (production/latest/custom), content-hashed bodies, linkage view |
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
  hostedsync/              explicit hosted batching, preview acceptance,
                           credential isolation, durable cursor/retry state
  checkpoint/              checkpoint builder + handoff score
  launch/                  continuation payload, drift, acknowledgement read model
  detection/               deterministic session-pathology rules
  mcp/                     local MCP stdio server (12 tools incl. prompts + scores)
  otlp/                    OTLP/HTTP ingest — JSON + hand-rolled protobuf decoder
  scores/                  score read model + validated payload builder
  observations/            wide denormalized observation derivation (ts_bucket,
                           fingerprints, signal_source coalescing, exception groups)
  datasets/                content-hashed dataset versions
  prompts/                 immutable prompt versions + mutable labels
  webui/                   embedded debugger API and static assets
  fixture/                 synthetic event generator
  verify/                  deterministic evidence checks + baseline regression gate
                           (also the golden-fixture verification harness)
protocol/schema/v1/        JSON Schemas
web/                       debugger UI source (traces, scores, datasets, prompts)
platform/                  Private hosted-beta Worker (Cloudflare-only):
  src/                       ingest, OTLP (JSON + protobuf), observations,
                             analytics, dashboards, alerts, webhooks, gateway,
                             evals, annotations, playground, simulations,
                             attachments, quality, teams, apikeys, artifacts, mcp
  ee/                        directory-fenced Enterprise line (own LICENSE)
  migrations/                D1 schema, 0001–0019
platform/ee/               EE line: separate LICENSE, EE_ENABLED-gated
deploy/dashboards/         Dashboards-as-config examples (PR-reviewable JSON)
landing/                   Public landing Worker
docs/                      architecture, privacy, adapters, OTLP, hosted tier,
                           parity plan, competitor analysis
```

## Development

```bash
go test ./...                                    # local Go core
go test -race ./...
go vet ./...
gofmt -l .

cd platform && npx tsc --noEmit && npx vitest run # hosted Worker
cd web && npx vitest run                          # debugger UI
node --test landing/*.test.mjs                    # landing Worker
```

## Agent skills

Ship an agent-native surface: `skills/handoffgraph/SKILL.md` (install with
`npx skills add handoffgraph/handoffgraph` or copy into your agent's skills
directory) plus `.claude-plugin/plugin.json` declaring the skill and the
stdio MCP server, so Claude Code / Cursor / Codex can drive the whole
verify → checkpoint → handoff loop autonomously.

## License

Apache-2.0. See [LICENSE](LICENSE). The hosted team service will be a separate commercial offering; the local core is and remains free.
