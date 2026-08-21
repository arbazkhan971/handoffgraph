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

**Version: v0.1.0 "local event spine" + v0.2.0 Codex adapter (hooks, CLI wiring, deterministic IDs). Working and tested (as of 2026-08-21).**

### Verified green

```bash
go build ./...        # Success
go vet ./...          # No issues
go test ./...         # 115+ tests passing in 15 packages
go test -race ./...   # All pass
gofmt -l .            # clean (no output)
```

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
| Codex adapter (Detect + Normalize + hook Install/Uninstall + deterministic event IDs; native resume deferred) | `internal/adapter/codex` | ✅ tested |
| CLI framework + subcommands (flag helpers, JSONL redact preview) | `internal/cli`, `internal/commands` | ✅ tested |
| Codex CLI wiring (`install`, `sessions`, `resume`; resume returns not-supported-yet for codex) | `internal/commands` | ✅ tested |
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
redact        --preview <file>
fixture       verify <dir>
install       --agent codex [--dry-run --hook-command --config-dir]  install managed hooks
sessions      [--agent] [--json]  list sessions derived from captured events, per provider
resume        <id> [--agent]  relaunch an agent from a checkpoint (codex: clean not-supported-yet error)
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
  trace/                   trace.go (materializer)
  redact/                  redact.go + patterns.go
  checkpoint/              checkpoint.go (builder) + render.go (Markdown)
  fixture/                 synthetic event generator (leaf, no deps)
  verify/                  fixture verify harness (imports storage+graph)
  adapter/                 provider Adapter interface + Registry (v0.2.0)
    codex/                 Codex adapter: Detect + Normalize + hook Install/Uninstall (resume deferred)
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
- Codex native resume (and `StartFromCheckpoint` launch) still open — targeted for a later v0.2.x cut.
- Acceptance run over 20 real Codex sessions (no config loss, resume path) still open — targeted for v0.2.x/v0.3.0.
- Codex App Server integration remains deferred (see §9).

### Deliberately deferred (per roadmap)
- Provider adapters full integration (Codex hooks/App Server v0.2.x, Claude v0.3.0, Pi v0.4.0)
- Session Debugger UI (React/Vite, v0.5.0)
- MCP server (local v0.4.0, remote v0.11.0)
- Cloudflare hosted platform (private repo, v0.8.0+)
- Cross-agent `continue` launcher (v0.6.0)

---

## 9. Next recommended work (in priority order)

### A. Finish the v0.2.0 Codex adapter
The `internal/adapter` interface + registry and the Codex `Detect`/`Normalize`
core are done and tested (see §8). As of 2026-08-21, hook `Install`/`Uninstall`
(managed `[hooks.handoffgraph]` table in `~/.codex/config.toml`, fail-closed,
idempotent, dry-run-safe) and the `install` / `sessions` / `resume` CLI wiring
are also done and tested, with deterministic event IDs so re-import is
idempotent (`resume` returns a clean not-supported-yet error for codex).
Remaining for full v0.2.0 acceptance, in priority order:
- App Server integration — the release-hold condition for the milestone.
- Acceptance run: 20 real sessions, no config loss.
- Native resume works (`StartFromCheckpoint` + native Resume; both still `ErrUnsupported`).

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

- **Not yet a git repository** — no `git init` has been run, no commits, no pushes (per the plan's "no commits without explicit authorization").
- The `handoffgraph` GitHub org name was **not verified as available** — confirm before first public push.
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
