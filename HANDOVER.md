# HANDOVER.md — HandoffGraph (for OpenCode takeover)

> Written for a fresh AI coding agent (OpenCode) taking over this repository.
> Read this first, then `docs/architecture.md` and `ROADMAP.md`.

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

**Version: v0.6.0-level local product (as of 2026-08-23): event spine + Codex/Claude/Pi adapters + MCP server + detection pack + Session Debugger UI + verified cross-agent continuation. Release packaging is wired; real-session acceptance and the canonical public repository remain release gates.**

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
| Claude adapter (Detect + Normalize + merge-safe hooks + native Resume + checkpoint-seeded ExecSpec) | `internal/adapter/claude` | ✅ tested |
| Pi adapter (Detect + Normalize + merge-safe hooks + native Resume + checkpoint-seeded ExecSpec) | `internal/adapter/pi` | ✅ tested |
| CLI framework + subcommands (flag helpers, JSONL redact preview) | `internal/cli`, `internal/commands` | ✅ tested |
| Codex CLI wiring (`install`, `sessions`, `resume`; resume prints the shell-quoted `codex resume <id>` invocation) | `internal/commands` | ✅ tested |
| Cross-agent continuation (bounded payload, drift, append-only status + MCP acknowledgement) | `internal/launch`, `internal/commands`, `internal/mcp` | ✅ tested |
| OTLP/JSON ingest — `otlp import` + localhost `otlp serve` (deterministic ids, idempotent re-import, fail-closed sanitizer, GenAI/OpenInference/OpenLIT/Langfuse attr mapping, partialSuccess) | `internal/otlp`, `internal/commands` | ✅ tested (docs/otlp.md; protobuf/gRPC pending; capture tiers shipped) |
| Scores primitive — `score record`/`list` + MCP `record_score`/`list_scores` (NUMERIC/CATEGORY/BOOLEAN on trace/span/session/checkpoint/workstream, source-tagged, deterministic derived read model, prefix-validated targets) | `internal/scores`, `internal/protocol`, `internal/commands`, `internal/mcp` | ✅ tested |
| Wide observations read model — `index rebuild` + `query spans` (denormalized trace attrs on every row, 5-minute ts_bucket prune + exact time predicates, identity fingerprints, stale auto-rebuild; Langfuse-V4/SigNoz patterns re-implemented ideas-only) | `internal/observations`, `internal/storage`, `internal/commands` | ✅ tested (migration 9) |
| Usage + outcome analytics — `query usage` (token/cost rollups per provider/session, decimal-string costs with provenance) and `outcomes` (per-workstream files/commands/tests/handoffs/scores) | `internal/commands` | ✅ tested |
| Verify gate — `verify --workstream <id> [--baseline <cp>]`: deterministic checks (traces closed, commands ok, tests pass, handoffs acknowledged, score rubric, P0 detections) + baseline score/new-failure regression; CI exit codes; every run appends verification.recorded evidence | `internal/commands` | ✅ tested |
| Datasets × experiments — `dataset create/list` (immutable content-hash versions, bodies in the object store), `experiment run/list/compare` (deterministic materialize+detection verdicts per example, regression diff) | `internal/datasets`, `internal/commands` | ✅ tested |
| Prompt store — `prompt create/label/list/show`: immutable hashed versions + mutable labels (production/latest/custom) as derived state, size-capped bodies (fail-closed), prompt↔event linkage view | `internal/prompts`, `internal/commands` | ✅ tested |
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
sessions      [--agent] [--json] | --detect [--json]
              list sessions derived from captured events, per provider;
              --detect lists native sessions directly from disk
              (~/.codex/sessions; override with HFG_CODEX_SESSIONS_DIR)
resume        <id> [--agent codex|claude|pi]
              print the shell-quoted native resume command; HandoffGraph
              never launches agents itself
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
mcp           serve  run the local eleven-tool MCP stdio server
dataset       create <name> --file ... | list   immutable dataset versions
experiment    run --dataset <name> | list | compare <a> <b>
prompt        create | label | list | show        versioned prompts + labels
score         record ... | list ...
              record/list source-tagged quality scores (NUMERIC/CATEGORY/
              BOOLEAN) on trace/span/session/checkpoint/workstream objects
open          serve the embedded debugger UI on localhost
version
```

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
    claude/, pi/           Claude Code and Pi adapters (v0.3.0/v0.4.0 scope, same contract)
protocol/schema/v1/        event.schema.json, checkpoint.schema.json, trace.schema.json
docs/                      architecture.md, privacy.md
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

8 migrations, run in a transaction, recorded in `schema_migrations` + `user_version`:

1. `schema_migrations` table
2. `events` (append-only, `event_id UNIQUE`, indexed by workstream/session/kind)
3. `workstreams`
4. `sessions`
5. `traces` (read model, indexed workstream/status)
6. `spans` (read model, indexed trace/parent)
7. `graph_nodes` + `graph_edges`
8. `checkpoints`

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
- ~~Codex adapter: hook install/uninstall + `sessions`/`resume` CLI wiring~~ — **DONE (2026-08-21):** managed `[hooks.handoffgraph]` table in `~/.codex/config.toml`, fail-closed with dry-run; `install --agent codex`, `sessions`, `resume` commands wired.
- ~~Codex native resume and checkpoint continuation~~ — **DONE:** adapter `Resume` returns the native `ExecSpec` (`codex resume <id>`, empty/dash-prefixed ids rejected); `StartFromCheckpoint` returns an injection-safe checkpoint-seeded spec. The v0.6 `continue` command selects a spec, checks drift, records `handoff.created`, and prints the invocation and bounded payload. It deliberately never launches agent processes itself.
- Acceptance run over 20 real Codex sessions (no config loss, resume path) still open — targeted for v0.2.x/v0.3.0.
- Codex App Server integration remains deferred (see §9).

### Deliberately deferred (per roadmap)
- Codex App Server integration and 20-real-session acceptance
- Remote MCP (v0.11.0); the local eleven-tool MCP server is implemented
- Cloudflare hosted platform (private repo, v0.8.0+)

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
- App Server integration — the release-hold condition for the milestone.
- Acceptance run: 20 real sessions, no config loss.
- Exercise real cross-agent continuations and acknowledgements across the
  supported provider pairs.
- Transfer or mirror the repository to the canonical module location before
  publishing the first tag; see `docs/releasing.md`.

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

- The repository is on `main`; the current remote is
  `github.com/arbazkhan971/handoffgraph`.
- The canonical module path is `github.com/handoffgraph/handoffgraph`, but that
  GitHub repository must exist before public `go install ...@version` works.
- Tag-triggered, checksummed cross-platform releases are defined in
  `.github/workflows/release.yml`; follow `docs/releasing.md` and never reuse a
  published tag.
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
