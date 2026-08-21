# Contributing to HandoffGraph

Thanks for helping build a local-first, verified cross-agent continuity
layer for AI coding agents. This document covers setup, testing, the golden
fixture workflow, and how to contribute detection rules and provider
adapters. For architecture, read [docs/architecture.md](docs/architecture.md)
first; for agent-facing conventions, [AGENTS.md](AGENTS.md) applies to
humans too.

## Ground rules (non-negotiable)

These come from the project's core guarantees. A PR that breaks any of
them will not merge, whatever its other merits:

1. **Events are append-only.** Never mutate stored events; derive read
   models (graph, traces, checkpoints) from the ordered log.
2. **Deterministic reducers.** The graph reducer and trace materializer
   must be pure functions of the ordered event log. Sort before emitting;
   no map-iteration-order leakage into output.
3. **Fail-closed redaction.** A redaction error blocks export. Never
   "warn and export original".
4. **Provenance is preserved.** `OBSERVED` / `DECLARED` / `INFERRED` must
   survive every transformation; an inferred summary must never look like
   an observed passing test.
5. **IDs are ULIDs** via `internal/ids` with self-describing prefixes
   (`evt_`, `ws_`, `ses_`, `trc_`, `spn_`, `cp_`, `repo_`). Never hand-roll
   an ID in product code.
6. **Money/cost is a decimal string**, never a float, and always carries a
   provenance label.
7. **Adapter installs are idempotent and fail-closed.** Never overwrite
   existing user hook config (`ErrHookConflict`); derived event IDs must be
   deterministic so re-import is idempotent.

## Setup

- Go **1.25**+ (CI pins `go-version: "1.25"`; see `.github/workflows/ci.yml`).
- The `git` binary is required for `internal/repository` tests (they skip
  politely when absent).
- No other dependencies: SQLite is pure Go (`modernc.org/sqlite`), config
  is TOML (`github.com/BurntSushi/toml`).

```bash
git clone https://github.com/handoffgraph/handoffgraph
cd handoffgraph
go build ./...
go test ./...
```

Always point the CLI at a throwaway data dir when smoke-testing — never
your real `~/.handoffgraph`:

```bash
export HFG_DATA_DIR=$(mktemp -d)
go build -o /tmp/hfg ./cmd/handoffgraph
/tmp/hfg init
/tmp/hfg workstream new "try my change"
/tmp/hfg event import testdata/fixtures/claude.jsonl
/tmp/hfg doctor
```

## Testing and CI

Before opening a PR, run the same gates CI runs:

```bash
gofmt -l .            # must print nothing
go vet ./...
go build ./...
go test ./...
go test -race ./...
```

Conventions:

- **New behavior needs a test.** Table-driven tests are the house style
  (see `internal/repository/paths_test.go` for the pattern).
- The 10,000-event ingestion, idempotency, out-of-order delivery,
  crash/reopen, and deterministic-hash properties are protected by
  dedicated tests — keep them green.
- Performance budgets live in `internal/storage/bench_test.go` (p95 append
  < 5 ms, overridable on slow machines via `HG_APPEND_P95_MAX_MS`) and in
  [docs/architecture.md](docs/architecture.md#performance-budgets-v0100).
- CI runs build/vet/fmt/test/race on ubuntu-latest and macos-latest.
- When iterating on one package, test just that package
  (`go test ./internal/storage/...`) rather than the whole module.

## Golden fixture guide

Golden fixtures live in `testdata/fixtures/` — one JSONL file per captured
scenario; each line is one event (canonical fixtures use the `hfg.event.v1`
envelope). See [testdata/fixtures/README.md](testdata/fixtures/README.md)
for the full inventory and the verify contract:

```bash
go run ./cmd/handoffgraph fixture verify testdata/fixtures
```

Rules of thumb:

- **Realistic, not synthetic-looking.** Real session shapes: spines
  (`workstream.started`, `session.started`), a mix of kinds, plausible
  payloads, honest provenance labels.
- **Unique IDs across the whole directory.** Verification imports every
  top-level fixture into one shared store, so `event_id`s must not collide
  across files. Reserve a distinct ULID prefix block per fixture.
- **Duplicates are legal** when you are testing delivery idempotency —
  byte-identical repeated lines import with no error (see
  `codex-duplicate-delivery.jsonl`).
- **A fixture that must fail is a contract, not a mistake.** Either put it
  under `invalid/` or document the exact expected failure in the fixtures
  README (see `truncated.jsonl`, which must fail with exactly one bad-line
  error).
- **Keep lines under 16 MB** (the verifier's scanner bound).
- If you add or remove a top-level fixture, update the expected file count
  in `internal/verify/verify_test.go` and the fixtures README table.
- Malformed-line handling (truncated JSON, invalid UTF-8) must fail with
  the line number — never silently rewrite to U+FFFD.

## Contributing a detection rule

"Detections" are deterministic heuristics that flag session pathology
(dead-end loops, silent test failures, context-loss cliff, drift between
declared and observed state). They run over the derived graph/traces, never
mutate the event log, and must:

1. Be deterministic and unit-tested against a golden fixture that exhibits
   the pathology (add the fixture alongside the rule).
2. Label their output `INFERRED` — a detection is a derived claim, not an
   observation.
3. Avoid duplicating an existing kind; extend the canonical vocabulary in
   `internal/protocol/protocol.go` only after discussing the need in an
   issue.

Open a `feature_request` issue (or `adapter_request` if provider-specific)
describing the pathology and the evidence the rule keys on before
implementing.

## Contributing an adapter

Provider adapters (Claude, Codex, Pi, later Factory Droid) normalize
native session data into `hfg.event.v1`. The interface and registry live in
`internal/adapter`; the Codex adapter is the reference implementation —
start with [docs/adapter-codex.md](docs/adapter-codex.md).

Every adapter must:

- Implement `Detect` (find native sessions) and `Normalize` (native →
  canonical events) without mutating native files.
- Preserve unknown native fields via the envelope's `Unknown` map — never
  drop data a future version may need.
- Derive event IDs deterministically (see
  `internal/ids/deterministic.go`) so re-importing the same native session
  is a no-op.
- Install/uninstall hooks idempotently and fail-closed: refuse to overwrite
  user hook config (`ErrHookConflict`), support `--dry-run`.
- Ship golden fixtures: a native-source fixture plus (where meaningful) its
  normalized canonical form.
- Mark capture provenance `OBSERVED`; adapter-added metadata is `INFERRED`.

## Pull requests

- Keep PRs small and single-purpose; reference the issue they close.
- Follow the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
- New user-visible behavior needs a `README.md` / `docs/` update in the
  same PR.
- By contributing, you agree your contributions are licensed under the
  Apache-2.0 license terms in [LICENSE](LICENSE); see
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for standards of conduct.
