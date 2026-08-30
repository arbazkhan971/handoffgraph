# HANDOVER.md — HandoffGraph (takeover doc; launch preflight)

> Written for a fresh AI coding agent (originally OpenCode; refreshed
> 2026-08-31 for the release/Hosted Basic preflight). Read this first, then
> `docs/architecture.md`, `docs/parity-plan.md`, and
> `docs/competitor-analysis.md`.

---

## 1. What this project is

**HandoffGraph** is a local-first **verified cross-agent continuity + session-debugging layer** for AI coding agents (Claude Code, Codex, Pi, later Factory Droid).

The one-line promise:

> **Switch AI coding agents without losing the work—or the evidence behind it.**

It is **not** generic LLM observability, not a memory API, not a terminal multiplexer, not a codebase knowledge graph. The defensible object is a **workstream graph** that joins multiple native sessions and links trace evidence to a safe next-agent handoff.

Source documents that drive everything (full product + 300-day plan):

- `/Users/arbaz/Downloads/HANDOFFGRAPH_STARTUP_PLAN.md`
- `/Users/arbaz/Downloads/HANDOFFGRAPH_VERSION_ROADMAP.md`

`ROADMAP.md` in this repo is the condensed version.

---

## 2. Current state (what exists, what works)

**Version: untagged v0.7 beta preflight with a v0.6 local core and an
ahead-of-gate Hosted Basic foundation (2026-08-31 working tree).** The event
spine, Codex/Claude/Pi adapters, Session Debugger, parity modules, explicit
hosted sync, and verified continuation are implemented. Twenty real Codex
sessions were imported twice with the same 45,567-event result and a clean deep
doctor run. The separate read-only Codex App Server listing path was exercised
against Codex CLI 0.144.3 and returned deterministic state-DB thread metadata.
Directed continuation and acknowledgement acceptance is complete across all
six supported provider handoff pairs.

The Cloudflare zone and isolated staging/production durable resources exist,
and all 22 migrations are applied and verified on staging D1. Production is
**not live**: the canonical GitHub organization/repository and first tag do not
exist, production D1 is not migrated, the public domains still serve the old
Vercel projects, and WorkOS, Turnstile, WAF/rate controls, domain cutover, and
deployed browser/CLI acceptance remain launch gates. Production signup stays
absent and fail-closed.

### Verified green

```bash
go build ./...        # Success
go vet ./...          # No issues
go test ./...         # full repository suite
go test -race ./...   # All pass
gofmt -l .            # clean (no output)
```

Also green: `web/` React+TS+Vite build (dist copied into `internal/webui/dist` for go:embed); golden workflow smoke-tested: init → workstream → import → traces → detect → checkpoint (score 70) → `open`.

### Implemented and tested

| Area | Package(s) | Status |
|---|---|---|
| ULID identifiers | `internal/ids` | ✅ tested |
| Canonical JSON + sha256 hashing | `internal/content` | ✅ tested |
| Content-addressed compressed object store | `internal/object` | ✅ tested |
| Config (user+repo scope, `HFG_DATA_DIR`) | `internal/config` | ✅ tested |
| Git identity + worktree state (+ Windows path logic) | `internal/repository` | ✅ tested |
| SQLite migrations + event store (+ append latency benchmark) | `internal/storage` | ✅ tested |
| Crash-safe JSONL spool + importer (rejects invalid UTF-8) | `internal/ingest` | ✅ tested |
| Workstream graph + deterministic reducer | `internal/graph` | ✅ tested |
| Trace/span materializer (time-based span tiebreak) | `internal/trace` | ✅ tested |
| Fail-closed redaction v1 (real globbing: `?`, `[...]`, bad-pattern rejection) | `internal/redact` | ✅ tested |
| Checkpoint builder + handoff score | `internal/checkpoint` | ✅ tested |
| Synthetic event generator | `internal/fixture` | ✅ (leaf pkg) |
| Fixture verification harness (+ golden fixture coverage) | `internal/verify` | ✅ tested |
| Adapter interface + registry (v0.2.0 groundwork) | `internal/adapter` | ✅ tested |
| Codex adapter (Detect + Normalize + hook Install/Uninstall + deterministic event IDs; native Resume + StartFromCheckpoint as ExecSpec) | `internal/adapter/codex` | ✅ tested |
| Codex App Server thread listing (stable stdio, state-DB-only, read-only; file detection unchanged) | `internal/adapter/codex`, `internal/commands` | ✅ tested + real CLI exercised |
| Claude adapter (Detect + Normalize + merge-safe hooks + native Resume + checkpoint-seeded ExecSpec) | `internal/adapter/claude` | ✅ tested |
| Pi adapter (Detect + Normalize + merge-safe hooks + native Resume + checkpoint-seeded ExecSpec) | `internal/adapter/pi` | ✅ tested |
| CLI framework + subcommands (flag helpers, JSONL redact preview) | `internal/cli`, `internal/commands` | ✅ tested |
| Explicit hosted sync (network-free preview, first-upload acceptance, durable canonical retry batches, tenant-scoped cursor) | `internal/hostedsync`, `internal/config`, `internal/commands` | ✅ tested |
| Codex CLI wiring (`install`, `sessions`, `resume`; resume prints the shell-quoted `codex resume <id>` invocation) | `internal/commands` | ✅ tested |
| Cross-agent continuation (bounded payload, drift, append-only status + MCP acknowledgement) | `internal/launch`, `internal/commands`, `internal/mcp` | ✅ tested |
| OTLP/JSON ingest — `otlp import` + localhost `otlp serve` (deterministic ids, idempotent re-import, fail-closed sanitizer, GenAI/OpenInference/OpenLIT/Langfuse attr mapping, partialSuccess) | `internal/otlp`, `internal/commands` | ✅ tested (docs/otlp.md; protobuf/gRPC pending; capture tiers shipped) |
| Scores primitive — `score record`/`list` + MCP `record_score`/`list_scores` (NUMERIC/CATEGORY/BOOLEAN on trace/span/session/checkpoint/workstream, source-tagged, deterministic derived read model, prefix-validated targets) | `internal/scores`, `internal/protocol`, `internal/commands`, `internal/mcp` | ✅ tested |
| Wide observations read model — `index rebuild` + `query spans` (denormalized trace attrs on every row, 5-minute ts_bucket prune + exact time predicates, identity fingerprints, stale auto-rebuild; Langfuse-V4/SigNoz patterns re-implemented ideas-only) | `internal/observations`, `internal/storage`, `internal/commands` | ✅ tested (migration 9) |
| Usage + outcome analytics — `query usage` (token/cost rollups per provider/session, decimal-string costs with provenance) and `outcomes` (per-workstream files/commands/tests/handoffs/scores) | `internal/commands` | ✅ tested |
| Verify gate — `verify --workstream <id> [--baseline <cp>]`: deterministic checks (traces closed, commands ok, tests pass, handoffs acknowledged, score rubric, P0 detections) + baseline score/new-failure regression; CI exit codes; every run appends verification.recorded evidence | `internal/commands` | ✅ tested |
| Datasets × experiments — `dataset create/list` (immutable content-hash versions, bodies in the object store), `experiment run/list/compare` (deterministic materialize+detection verdicts per example, regression diff) | `internal/datasets`, `internal/commands` | ✅ tested |
| Prompt store — `prompt create/label/list/show`: immutable hashed versions + mutable labels (production/latest/custom) as derived state, size-capped bodies (fail-closed), prompt↔event linkage view; MCP `get_prompt` (12 tools) | `internal/prompts`, `internal/commands`, `internal/mcp` | ✅ tested |
| Agent skills — `skills/handoffgraph/SKILL.md` (installable agent workflow) + `.claude-plugin/plugin.json` (skill + stdio MCP declaration); ingest backpressure (429 + Retry-After at in-flight cap) | repo packaging, `internal/otlp` | ✅ |
| JSON Schemas | `protocol/schema/v1/` | ✅ (3 files) |

### CLI commands (all work)

```
init          Initialize local data directory
doctor        Diagnose config + DB health
status        Show local capture status
workstream    new <title> | list
event         import <file>
graph         [--json]   export derived workstream graph
traces        [--json]   list materialized turn traces
checkpoint    --workstream <id> [--objective] [--status]
              | --from-trace <id> [--objective] [--status]
              | show <checkpoint-id> [--json]
redact        --preview <file>
fixture       verify <dir>
install       --agent codex|claude|pi [--dry-run --hook-command --config-dir]
              install managed hooks
codex         install|uninstall|sessions|app-server-sessions|normalize
              manage the Codex adapter; app-server-sessions is a separate
              read-only stdio listing path with bounded pagination
sessions      [--agent] [--json] | --detect [--json]
              list sessions derived from captured events, per provider;
              --detect lists native sessions directly from disk
              (~/.codex/sessions; override with HFG_CODEX_SESSIONS_DIR)
resume        <id> [--agent codex|claude|pi]
              print the shell-quoted native resume command; HandoffGraph
              never launches agents itself
sync          [--preview] [--accept-redaction] [--json]
              explicitly preview/upload pending local events; preview has no
              network or state writes, and first upload requires acceptance
continue      --to codex|claude|pi --workstream <id> [--preview]
              resolve the handoff and print (never execute) the native invocation
handoff       status [--json]  derive created/accepted acknowledgement state
detect        run deterministic detections over materialized traces
index         rebuild the derived wide observation index
query         spans [...]| usage [--workstream] [--group-by provider|session]
              ts_bucket-pruned span queries (auto-rebuilds) + usage rollups
outcomes      per-workstream coding-agent outcomes (files/commands/tests/
              handoffs/scores), derived from the event log
verify        --workstream <id> [--baseline <cp>]  deterministic evidence
              checks + regression gate; exit 0/1; CI-ready
otlp          import <file> | serve [--addr 127.0.0.1:4318] [--capture tier]
              ingest OTLP/JSON telemetry into the event spine (idempotent;
              capture tiers full/metadata/minimal gate attribute content at
              emit, fail-closed; serve listens on localhost only)
mcp           serve  run the local twelve-tool MCP stdio server
dataset       create <name> --file ... | list   immutable dataset versions
experiment    run --dataset <name> | list | compare <a> <b>
prompt        create | label | list | show        versioned prompts + labels
score         record ... | list ...
              record/list source-tagged quality scores (NUMERIC/CATEGORY/
              BOOLEAN) on trace/span/session/checkpoint/workstream objects
open          serve the embedded debugger UI on localhost
version
```

`handoffgraph codex app-server-sessions [--codex-binary <path>] [--page-size
<n>] [--max-pages <n>] [--json]` sends only `initialize`, `initialized`, and
state-DB-only `thread/list` requests over stdio. It never mutates Codex state
and never replaces `codex sessions`, which continues to detect rollout files
from disk.

`handoffgraph sync` is the only local-to-hosted network path. Endpoint settings
come only from the user config or `HFG_HOSTED_API_URL`; entering an untrusted
repository cannot redirect the device token. Supply the credential via a
protected token file or `HFG_DEVICE_TOKEN`, never argv. Sync re-runs deep
fail-closed redaction and uploads only events attested with
`redaction.version = 1` and status `clean` or `redacted`. The first upload scope
stops after its content-free preview unless the user reruns with
`--accept-redaction`.

---

## 3. Repository layout

```
cmd/handoffgraph/          CLI entrypoint (main.go)
internal/
  cli/                     command framework (App, Command, Context)
  commands/                subcommand implementations (Register(), flag helpers)
  protocol/                versioned wire contracts: event.go, checkpoint.go,
                           trace.go, protocol.go (enums/constants)
  ids/                     ULID generation + validation
  content/                 CanonicalJSON() + Hash()
  object/                  content-addressed compressed object store
  config/                  config.go + load.go (TOML)
  hostedsync/              explicit redacted hosted transfer + durable cursor
  repository/              Git identity (Detect) + worktree state (State)
  storage/                 db.go (migrations+events), workstream.go, bench_test.go
  ingest/                  spool + JSONL import
  graph/                   graph.go (model) + reduce.go (reducer)
  trace/                   trace.go (materializer; token/cost usage from trace.completed)
  otlp/                    OTLP/JSON ingest: types + deterministic convert + HTTP listener
  observations/            wide observation derivation (rows 9-11) + fingerprints
  redact/                  redact.go + patterns.go
  checkpoint/              checkpoint.go (builder) + render.go (Markdown)
  launch/                  bounded continuation + drift + handoff read model
  fixture/                 synthetic event generator (leaf, no deps)
  verify/                  fixture verify harness (imports storage+graph)
  adapter/                 provider Adapter interface + Registry (v0.2.0)
    codex/                 Codex adapter: Detect + Normalize + hook Install/Uninstall
                          + deterministic event IDs + Resume/StartFromCheckpoint (ExecSpec)
                          + stable read-only App Server thread listing
    claude/, pi/           Claude Code and Pi adapters (v0.3.0/v0.4.0 scope, same contract)
protocol/schema/v1/        event.schema.json, checkpoint.schema.json, trace.schema.json
docs/                      architecture.md, privacy.md
platform/                  Cloudflare Hosted Basic + ahead-of-gate modules
landing/                   Cloudflare landing Worker
testdata/fixtures/         golden JSONL fixtures (claude, tool success/failure,
                           out-of-order, windows paths, orphan spans, object refs,
                           codex session) + invalid/ subtree (truncated, bad UTF-8)
.github/workflows/ci.yml   Go build/vet/fmt/test/race on ubuntu+macos (Go 1.25)
ROADMAP.md                 condensed release train
AGENTS.md                  agent conventions (read this)
config.example.toml        sample user config
LICENSE                    Apache-2.0
```

---

## 4. Key architecture decisions (do NOT reverse these without discussion)

1. **Events are append-only source of truth.** Graph, traces, spans, checkpoints are all *derived*, never mutated in place.
2. **Deterministic reducers.** Graph reducer and trace materializer must be pure functions of the ordered event log. **Never** introduce map-iteration-order dependence — sort before emitting. (`graph.Normalize()`, sorted trace/span output.)
3. **Fail-closed redaction.** A redaction error blocks export; never "warn and export original". Original secret is never written to the audit record.
4. **Provenance is mandatory.** `OBSERVED` / `DECLARED` / `INFERRED` must be preserved and rendered distinctly. An inferred summary must never look like an observed passing test.
5. **No model in the core path.** Checkpoint building is model-free. Model compression (future) must be labelled `INFERRED`.
6. **Money/cost is a decimal string, never a float.** (`cost_amount` string in `protocol/trace.go`.)
7. **ID format:** ULID with self-describing prefixes — `evt_`, `ws_`, `ses_`, `trc_`, `spn_`, `cp_`, `repo_`. Use `internal/ids`, never hand-roll.
8. **Go 1.25.0** (note: `go mod tidy` bumped the `go` directive from 1.24; CI uses 1.24 — **this mismatch needs fixing**, see §8).
9. **SQLite pure-Go driver** (`modernc.org/sqlite`), WAL mode, single writer (`SetMaxOpenConns(1)`).

### Import layering (to avoid cycles)

```
fixture (leaf: no internal deps except ids/protocol)
   ↑
storage, graph, trace, checkpoint, redact, object, content, config, repository
   ↑
verify (imports storage + graph)     ← top of the tree
commands (imports everything)
```

`fixture` is deliberately dependency-free of `storage`/`graph` so those packages' tests can import it without a cycle. `verify` was split out of `fixture` for exactly this reason — **do not re-merge them.**

---

## 5. The core data model

### Event envelope (`hfg.event.v1`) — `internal/protocol/event.go`

```go
type Event struct {
    SchemaVersion   string          // "hfg.event.v1"
    EventID         string          // evt_<ulid>
    Sequence        int64
    OccurredAt      time.Time
    ObservedAt      time.Time
    WorkstreamID    string
    SessionID       string
    NativeSessionID string
    Provider        string          // claude | codex | pi
    Agent           string
    Model           string
    Kind            EventKind       // e.g. "command.completed"
    ParentEventIDs  []string
    RepositoryID    string
    Git             *GitState
    Provenance      Provenance      // OBSERVED|DECLARED|INFERRED
    Payload         json.RawMessage
    Redaction       *Redaction
    ContentHash     string
    Unknown         map[string]json.RawMessage // preserved unknown fields
}
```

### Checkpoint (`hfg.checkpoint.v1`) — `internal/protocol/checkpoint.go`

Objective, repository state (remote/branch/head/dirty), source sessions, completed work, decisions, files (with content hashes), commands (with exit codes), tests, failed approaches, constraints, open questions, next actions, integrity (graph root hash + score). Every evidence item carries `EvidenceRefs []string`.

### Trace/span read models (`hfg.trace.v1`) — `internal/protocol/trace.go`

`Trace`: status (RUNNING/OK/ERROR/CANCELLED/INTERRUPTED/COMPACTED/ABANDONED/UNKNOWN), span counters, verification state, root span, token/cost (provenance-labelled).

`Span`: normalized kind (WORKFLOW/AGENT/MODEL/TOOL/MCP_CLIENT/MCP_SERVER/COMMAND/FILE_READ/FILE_WRITE/GIT/TEST/BUILD/RETRIEVAL/GUARDRAIL/LOG/OTHER), source kind preserved, status, timing, exit code, object hashes (input/output/attributes/error are *references*, never inlined).

---

## 6. Database schema (migrations in `internal/storage/db.go`)

12 migrations, run in order and recorded in `schema_migrations` +
`user_version`:

1. `schema_migrations` table
2. `events` (append-only, `event_id UNIQUE`, indexed by workstream/session/kind)
3. `workstreams`
4. `sessions`
5. `traces` (read model, indexed workstream/status)
6. `spans` (read model, indexed trace/parent)
7. `graph_nodes` + `graph_edges`
8. `checkpoints`
9. Wide `span_observations`, fingerprints, and observation snapshot metadata
10. Promoted observation columns plus native-signal coalescing/shadow state
11. Derived exception groups
12. Derived verify-result cache

**Rules:** ordered, idempotent, timestamped backup before destructive migrations, never rewrite raw events during migration, rebuild derived indexes from raw events rather than mutating them.

---

## 7. How to run and test manually

```bash
go build -o /tmp/hfg ./cmd/handoffgraph

# Use a throwaway data dir (never pollute ~/.handoffgraph while testing)
export HFG_DATA_DIR=$(mktemp -d)

/tmp/hfg init
WS=$(/tmp/hfg workstream new "fix checkout race")
/tmp/hfg event import testdata/fixtures/claude.jsonl
/tmp/hfg traces
/tmp/hfg checkpoint --workstream $WS --objective "fix duplicate checkout"
/tmp/hfg graph --json
/tmp/hfg doctor
/tmp/hfg redact --preview testdata/fixtures/claude.jsonl
/tmp/hfg fixture verify testdata/fixtures
/tmp/hfg sessions --detect
/tmp/hfg resume <native-session-id> --agent codex
```

Expected `checkpoint` output includes: decisions (DECLARED), files (OBSERVED + content_hash), commands (exit_code 1), tests (failed), a graph root hash, and a score (60 for the claude fixture without next_actions).

---

## 8. Known issues / open items

### Resolved (2026-08-21 takeover)

1. ~~**Go version mismatch.**~~ CI now pins `go-version: "1.25"` to match go.mod's `go 1.25.0` (the bump was forced by dependency requirements; downgrading to 1.24 was rejected).
2. ~~No tests for `internal/config` and `internal/repository`.~~ Both packages fully tested; Windows path logic is table-tested via an injectable `normalizePath(p, isWindows)` (also fixed a real bug: scp-like remote parsing mangled `C:\...` drive-letter remotes).
3. ~~Windows path fixtures~~ — covered by `internal/repository` path tests + `testdata/fixtures/windows_paths.jsonl`.
4. ~~p95 append < 5ms benchmark~~ — `BenchmarkAppend` + `TestAppendLatencyP95` in `internal/storage/bench_test.go`; measured p95 ≈ 0.2ms on Apple Silicon (~25x headroom). Threshold overridable via `HG_APPEND_P95_MAX_MS`.
5. ~~redact glob matching~~ — now real globbing on `path.Match` semantics (`?`, `[...]`, escapes); malformed deny patterns are rejected at construction (fail-closed); v1 literal+`*` patterns keep their crossing behavior as a compat fallback.
6. ~~trace span ordering~~ — spans sort by `Sequence`, then `StartedAtNS`, then `SpanID`; covered by dedicated tests.
7. ~~CLI flag value clunkiness~~ — `boolFlag`/`stringFlag` helpers in `internal/commands/flags.go`, all call sites refactored.

### Fixed during takeover (bugs found by new fixtures/tests)

- **Invalid UTF-8 was silently rewritten to U+FFFD on import** (encoding/json replacement behavior) in both `internal/ingest` and the verify harness. Now rejected fail-closed with a line number.
- **`redact --preview` crashed on any multi-event JSONL file** (it unmarshaled the whole file as one event). Now iterates JSONL line-by-line with per-line status output.

### Remaining nice-to-haves
- ~~Consider stable/deterministic event-ID derivation for adapter re-import idempotency~~ — **DONE (2026-08-21):** `internal/ids` deterministic helper derives a stable `evt_<ulid>` from (provider, native session ID, sequence, occurred-at, content hash), so re-importing the same Codex session is idempotent.
- ~~Codex adapter: hook install/uninstall + `sessions`/`resume` CLI wiring~~ — **DONE (updated 2026-08-30):** ten additive, marker-owned Codex 0.144.3 matcher groups in `~/.codex/config.toml`, fail-closed dry-run/uninstall, and a bounded silent `hook codex` capture handler; `install --agent codex`, `sessions`, `resume` commands wired.
- ~~Codex native resume and checkpoint continuation~~ — **DONE:** adapter `Resume` returns the native `ExecSpec` (`codex resume <id>`, empty/dash-prefixed ids rejected); `StartFromCheckpoint` returns an injection-safe checkpoint-seeded spec. The v0.6 `continue` command selects a spec, checks drift, records `handoff.created`, and prints the invocation and bounded payload. It deliberately never launches agent processes itself.
- ~~Acceptance run over 20 real Codex sessions~~ — **DONE (2026-08-30):**
  exactly 20 stable real sessions imported twice as 45,567 events both times;
  deep doctor stayed green and the file-based detection path was preserved.
- ~~Codex App Server integration~~ — **DONE (2026-08-30):** a separate,
  bounded, read-only stdio client lists state-DB threads deterministically. It
  sends only the stable initialization/listing methods and does not replace
  file-based `codex sessions`.

### Deliberately deferred (per roadmap)
- Remote MCP (v0.11.0); the local twelve-tool MCP server is implemented.
- Advanced hosted features remain behind the exact
  `HOSTED_SURFACE="advanced"` fence. Hosted Basic is implemented and its
  staging schema is ready, but production publication is still gated.

---

## 9. Next recommended work (in priority order)

### A. Finish release acceptance
The `internal/adapter` interface + registry and all three providers' capture
cores are done and tested (see §8). Hook `Install`/`Uninstall` (fail-closed,
idempotent, dry-run-safe), the `install` / `sessions` / `resume` CLI wiring,
deterministic event IDs, native `Resume`, and `StartFromCheckpoint` are all
done and tested for Codex, Claude, and Pi: resume/checkpoint launch return
`ExecSpec`s that the v0.6 `continue` command selects and prints shell-quoted.
The command never executes the target process. It appends a structured
handoff, prints the bounded provenance-labelled payload and machine checkpoint
reference, and exposes receiving-agent acknowledgement through MCP
`accept_handoff` and `handoff status`. The verify harness classifies fixtures too:
canonical `hfg.event.v1` fixtures go through the event-store import path,
while native codex rollout fixtures are verified via the adapter's
`Normalize`.
Remaining acceptance work, in priority order:
- Exercise real cross-agent continuations and acknowledgements across the
  supported provider pairs.
- Transfer or mirror the repository to the canonical module location before
  publishing the first tag; see `docs/releasing.md`.
- Publish `v0.7.0-beta.1`, then prove clean install and upgrade from the
  canonical module path.

### B. Golden fixtures expansion — DONE (2026-08-21)
Added: Claude tool success/failure, out-of-order delivery, truncated JSONL,
invalid UTF-8, Windows paths, orphan spans, large-object references, and a
Codex session fixture — all wired into `internal/verify` tests. Malformed
fixtures live under `testdata/fixtures/invalid/`.

### C. ~~Fix the §8 "must fix" first.~~ Done — see §8 resolved list.

---

## 10. Conventions (from AGENTS.md — follow strictly)

- Go 1.24+, Apache-2.0, module `github.com/handoffgraph/handoffgraph`.
- IDs via `internal/ids`; never hand-roll.
- Events append-only; derive read models, don't mutate.
- Reducers deterministic; sort before emitting.
- Redaction fail-closed.
- Provenance preserved.
- New behavior needs a test; fixtures under `testdata/fixtures/`.
- The 10k-ingestion / idempotency / out-of-order / crash-reopen / deterministic-hash properties are non-negotiable.

---

## 11. Git / repo status

- The working tree is prepared for a future canonical remote at
  `github.com/handoffgraph/handoffgraph`, but that organization/repository has
  not been created and no transfer or publication should be inferred from the
  module path. Update the checkout origin only after the owner completes the
  transfer.
- The canonical module path is `github.com/handoffgraph/handoffgraph`, but that
  GitHub repository must exist before public `go install ...@version` works.
- Tag-triggered, checksummed cross-platform releases are defined in
  `.github/workflows/release.yml`; follow `docs/releasing.md` and never reuse a
  published tag. No canonical prerelease has been published yet.
- Local path: `/Users/arbaz/Projects/tools/handoffgraph`
- The sibling project dirs `/Users/arbaz/Projects/tools/ccrank` and `grok-usage` are unrelated (different owners/licenses).

---

## 12. Verification checklist for a takeover agent

After making changes, confirm:

```bash
cd /Users/arbaz/Projects/tools/handoffgraph
gofmt -l .                          # empty
go vet ./...                        # no issues
go build ./...                      # success
go test ./...                       # all pass
go test -race ./...                 # all pass
```

And manually smoke-test the CLI flow in §7.


---

## 13. Parity-program takeover brief (2026-08-28) — for the next agent

### Where we are

The competitor-parity program (`docs/parity-plan.md`, matrix in
`docs/competitor-analysis.md`) has shipped **~34 of 55 rows** in 15 commits
(5b8a98c → f1747c4). Everything is property-tested; `go test ./...`,
`go test -race ./...`, `gofmt`, `go vet` green at every commit; platform
(TypeScript Worker) suite is 176 vitest tests green + `tsc --noEmit` clean.

Shipped parity rows (see matrix for the authoritative list): 2 (OTLP local +
hosted), 3, 4 (local), 8–11, 16–23, 24, 25, 26 (local), 27 (local), 33, 34
(local), 37, 38, 50.

### Key surfaces added since the v0.6 handover above

- CLI (28 commands): new `otlp import|serve`, `score record|list`,
  `index rebuild`, `query spans|usage`, `outcomes`, `verify`, `dataset
  create|list`, `experiment run|list|compare`, `prompt create|label|list|show`.
- MCP: 12 tools (added `record_score`, `list_scores`, `get_prompt`).
- New packages: `internal/otlp`, `internal/scores`, `internal/observations`,
  `internal/datasets`, `internal/prompts`.
- Migrations: #9 (`span_observations` wide table + `span_fingerprints` +
  `observations_meta`); migrations are append-only and ordered.
- Hosted: `platform/src/otlp.ts` (TypeScript port of the OTLP converter with
  **cross-language id parity** — golden tests in `platform/test/otlp.test.ts`
  pin ids generated from the Go `internal/ids.Deterministic`) and worker
  route `POST /v1/otlp` (auth + quota + idempotency via the existing
  event-batch pipeline).
- Agent packaging: `skills/handoffgraph/SKILL.md` + `.claude-plugin/plugin.json`.

### Non-obvious gotchas (learned the hard way — read before editing)

1. **Go `flag` stops at the first positional.** Subcommand-style commands
   must call `consumePositionals(fs)` (`internal/commands/flags.go`).
2. **JS/TS nanosecond epochs exceed `Number.MAX_SAFE_INTEGER`.** The TS
   converter uses BigInt internally; naive `Number()` silently corrupts ids.
3. **The `ulid` npm package cannot reproduce Go's byte-exact entropy.**
   `platform/src/otlp.ts` hand-rolls the canonical Crockford ULID encoding;
   golden-test any change against Go outputs.
4. **OTLP replay idempotency requires a deterministic `observed_at`** —
   hosted derives it PER EVENT from that event's own boundary instant (its
   `occurred_at`), never wall clock and never a whole-export aggregate
   (`handleOtlpExport` in `platform/src/index.ts`). `observed_at` rides inside
   `raw_json`, which migration 0003's `events_reject_payload_conflict` trigger
   compares, so an export-wide value made one span's events depend on the
   COMPOSITION of the batch carrying them: re-sending that span with different
   siblings aborted the whole batch with a 409.
5. **The append p95 latency gate flakes under parallel-suite load.** It is
   race-scaled (`race_multiplier*.go`) and re-measures once on breach; real
   regressions fail both measures.
6. **Commit discipline:** never commit until `go test ./...` AND
   `go test -race ./...` BOTH exit 0 (learned twice), plus the platform
   suite when `platform/` changed.
7. **Test count pins exist:** `register_test.go` pins the CLI command list
   (28); `internal/mcp/server_test.go` `wantToolOrder` pins the 12 tools;
   `internal/commands/mcp_cmd_test.go` pins 12. Update them together.
8. **proto3 JSON quirks:** enums may be numbers or names; int64 values may
   be decimal strings or numbers. Handle both (see `internal/otlp/types.go`).

### Work queue (priority order)

1. **P3 hosted platform** (Cloudflare-only, per `docs/parity-plan.md` §P3):
   R2 artifact store + D1 file-list index for compacted batches; Analytics
   Engine rollups for dashboards; Workflows eval runs (LLM-judge = INFERRED
   BYO-key); Cron alerts + webhook channels; dashboards-as-config; gateway
   capture mode; teams/RBAC; batch export; webhooks.
2. **P2 tails:** evaluator caching for `verify`; debugger-UI surfaces for
   scores/datasets/prompts (web/ React app).
3. **P4:** playground, simulations, funnels, EE line (directory-fenced).
4. **Protobuf + gRPC OTLP flavors** (both local and hosted) — JSON only today.

### Launch gates (owner: Arbaz, not the agent)

- Transfer/mirror repo to `github.com/handoffgraph/handoffgraph` (module path).
- Run ~20 real sessions through the hooks; import as acceptance + golden
  cassettes (`docs/releasing.md` for the tag process after that).
- Then tag `v0.7.0-beta.1` (release workflow is already wired).

### Verification checklist (same as §12, plus platform)

```bash
gofmt -l .                          # empty
go vet ./... && go build ./...
go test ./... && go test -race ./...
cd platform && npx tsc --noEmit && npx vitest run   # 176 green
```

*(§13 is preserved as a dated snapshot. Its work queue, launch gates, and
counts — 28 commands, 176 vitest, ~34/55 rows — are historical; the 20-session
gate it lists is now complete. Read §14 for current state.)*

---

## 14. 2026-08-28 ultracode wave and 2026-08-30 launch overlay

### Where the parity wave landed

**27 commits after `9ed8dda` (head `9bbeede`).** The parity program is
effectively complete: **~54 of 55 matrix rows are shipped behind a tested
gate or carry a dated re-scope rationale**, with row 55 (browser session
replay) the one deliberate out-of-scope. `docs/competitor-analysis.md` §3 is
the authoritative per-row status; `docs/parity-plan.md` mirrors it inside the
owning phase bullets.

Four rows are re-scopes, not builds, and each carries its rationale in-doc:
gRPC on row 2 (Workers cannot terminate inbound gRPC; locally it would cost
the single binary's three-dependency posture — front a collector instead),
presigned direct-to-R2 on row 53 (needs S3-compatible R2 *account* keys we do
not hold), and rows 32 + 54 (both marked "(optional)" in the plan from day
one; demand-gated, not built).

Three **pending tails** live inside otherwise-shipped rows. Do not let a
future edit quietly checkmark them:

1. **Row 4** — hosted batch-endpoint backpressure (local 429/Retry-After ships).
2. **Row 38** — edits accepted/rejected + commit/PR linkage, blocked on the
   adapters emitting acceptance events. Do **not** synthesize them.
3. **Row 48** — SCIM beyond the `Users` subset, and wiring the finished,
   fail-closed masking engine into `platform/src/ingest.ts`.

**The owner gates are unchanged** and still precede any public claim — see
"Launch gates" below. Nothing in this wave moved them.

### New surfaces

**Local Go core.** `internal/otlp` gained a hand-rolled protobuf wire decoder
(`protowire.go`) alongside the JSON path; `internal/observations` gained
`signal_source` coalescing, shadow rows and exception groups;
`internal/storage/verify_cache.go` backs the row-26 result cache.
**Go migrations 10–12** landed (10–11: promoted columns / coalescing /
exception groups; 12: verify result cache). Migrations are append-only and
ordered — never renumber, never edit a shipped one.

**CLI: 34 commands.** Verified from `internal/commands/register_test.go`,
which pins the exact list and asserts the count matches:

```
checkpoint claude codex continue detect doctor event fixture graph handoff hook
init install mcp dataset experiment index open otlp outcomes pi prompt query
redact reset resume score sessions status sync traces verify version workstream
```

New since §13: `reset` (and `doctor --verify`). MCP stays at **12 tools**
(`internal/mcp/server_test.go` `wantToolOrder` pins them).

**Debugger UI (`web/`).** `ScoresView`, `DatasetsView` (with the compare
panel) and `PromptsView` shipped — these were the P2 "UI pending" tails on
rows 24, 27, 33/34.

**Hosted Worker (`platform/`).** The nineteen parity modules listed below sit
within the current 28-module `platform/src` surface. Each owns one parity area
and has a header comment stating its rows and design provenance — read that
header before editing a module:

```
src/ingest.ts        src/otlp.ts        src/otlp_proto.ts   src/observations.ts
src/analytics.ts     src/dashboards.ts  src/alerts.ts       src/webhooks.ts
src/gateway.ts       src/apikeys.ts     src/mcp.ts          src/evals.ts
src/annotations.ts   src/playground.ts  src/simulations.ts  src/quality.ts
src/artifacts.ts     src/attachments.ts src/teams.ts
ee/src/ee.ts         ee/src/assistant.ts        (fenced, own LICENSE)
```

**D1 migrations 0004–0019**: teams/RBAC, observations+sessions,
artifacts+exports, webhooks, dashboards, alerts, gateway, api_keys, evals,
annotations, playground, simulations, ee, attachments, and the durable
account-deletion/tombstone path, and commit-time device-revocation fencing. One cron
(`*/5 * * * *`) drives every sweep through the `scheduled` dispatcher in
`src/index.ts`.

### Suite counts (measured 2026-08-28, all green)

| Suite | Command | Result |
|---|---|---|
| Go core | `go test ./...` | **1038 passed** (560 top-level across 29 packages); `-race` clean |
| Hosted Worker | `cd platform && npx vitest run` | **1381 passed**, 28 files |
| Debugger UI | `cd web && npx vitest run` | **129 passed**, 4 files |
| Landing | `node --test landing/*.test.mjs` | **10 passed** |
| Types | `cd platform && npx tsc --noEmit` | clean |

Count these from raw tool output. A summarizing wrapper in the loop will
happily invent a plausible number (it reported 1039/33 and 1387 for the first
two rows above); `go test ./... -json` and vitest's own footer are the truth.

### Wave-merge integration gotchas (earned the hard way)

The waves ran parallel agents against the same tree. These are the failure
modes that actually bit, and the resolutions that stuck:

1. **Index-name collisions across parallel migrations.** Two agents each
   wrote a migration creating `idx_events_score_recorded`; both were correct
   in isolation and the pair failed on apply (fixed in `3a0757c`).
   **Rule:** namespace every new index by its migration's subject
   (`idx_<table>_<cols>` is not enough when two waves touch `events`), and
   apply the full migration chain from scratch before committing — not just
   the new file.
2. **Merging the route delegation chain: keep BOTH sides, never pick one.**
   `platform/src/index.ts` dispatches by trying `handleXRoute(request, env)`
   in order, each returning `null` when it does not own the path. Parallel
   waves each append their own line, so a conflict there is *always* a
   keep-both, and a "resolve by taking theirs" silently deletes a whole
   feature's routing. The same applies to the `scheduled` dispatcher's sweep
   list.
3. **Worker type regeneration is centralized, not per-wave.** Each wave adds
   bindings to `wrangler.toml`; regenerating `worker-configuration.d.ts` per
   wave produces a 568 KB file with conflicting hunks in every merge. Do it
   **once**, after the wave's bindings have all landed (that is what
   `b85eeea` is).
4. **Cross-flavor divergence hides in the decoders, not the converter.**
   Row 2's proto3 `arrayValue` bug (fixed in `9bbeede`) had the *same*
   telemetry decode correctly as protobuf and wrongly as JSON, in both
   languages, because the JSON decoders read a non-spec field name. The
   converter was innocent. **Any decoder change needs a fixture pair
   (`.json` + `.pb`) read by BOTH suites** — see
   `testdata/fixtures/otlp/array_values.*`.
5. **Duplicated adapters drift.** An identical ~20-line D1 device lookup had
   been copy-pasted into two modules; it is now one `deviceLookup(db)` in
   `src/auth.ts`. When two waves need the same helper, promote it rather than
   letting each keep a copy.
6. Everything in §13's gotcha list still applies — especially #1 (Go `flag`
   stops at the first positional), #2/#3 (BigInt nanosecond epochs; the
   hand-rolled ULID), and #6 (never commit until `go test ./...` **and**
   `go test -race ./...` both exit 0, plus the platform suite when
   `platform/` changed).

### 2026-08-30 release and Hosted Basic overlay

Completed since the ultracode wave:

- exactly 20 real Codex sessions were imported twice with a stable 45,567
  events, and deep doctor stayed green;
- the stable read-only Codex App Server thread-listing integration is complete
  without changing the rollout-file detection path;
- explicit hosted sync is implemented with a network/state-free preview,
  first-upload acceptance, exact durable retry batches, and a server-side
  requirement for redaction version 1 with status `clean` or `redacted`;
- account deletion/privacy is implemented, reviewed, and covered across
  WorkOS, exact R2 prefixes, D1 purge, retry/grace sweeps, and resurrection;
- all 22 migrations are applied and verified on staging D1; Hosted Basic binds
  only D1 and R2, and advanced routes enable only for the exact
  `HOSTED_SURFACE="advanced"` value;
- the latest platform run is green at 37 files / 1,553 Vitest tests, with
  typecheck and production/staging Wrangler dry bundles also green.

Remaining launch gates:

- create/transfer the canonical repository at
  `github.com/handoffgraph/handoffgraph`, publish `v0.7.0-beta.1`, and prove a
  clean install/upgrade;
- configure real WorkOS staging/production identity plus Turnstile and
  WAF/rate controls;
- deploy and browser-test staging auth, CLI sync, cross-tenant boundaries,
  quotas, logout, and the full deletion saga;
- preserve production rollback evidence, migrate production D1, cut the
  already-configured custom domains from the still-live Vercel projects, and
  repeat acceptance on public HTTPS;
- keep `HOSTED_SIGNUP_ENABLED` absent until every preceding gate passes, then
  retire `handoffgraph-landing` and `handoffgraph-api` on Vercel only after
  Cloudflare public verification.

### One competitive fact worth carrying into any launch copy

`docs/competitor-analysis.md` §4.1 (dated 2026-08-28) retires the old line
"nobody models agent→agent handoff at all" — OpenAI's Codex CLI has shipped
one-directional import **plus ongoing sync** of Claude Code/Cursor
conversations since v0.147.0 (2026-08-07), with no verification or evidence
semantics. The defensible claim is now **"nobody ships verified,
evidence-provenance cross-agent continuity."** Use that wording.
