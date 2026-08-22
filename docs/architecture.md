# Architecture

This document describes the local HandoffGraph architecture implemented in
this repository. It corresponds to v0.2.0 of the version roadmap (the local
event spine plus the Codex adapter) and lays the foundation for v0.3–v0.6
(Claude/Pi adapters, debugger, checkpoint continuation).

## Guiding principles

1. **Append-only events are the source of truth.** Everything derived (graph,
   traces, spans, checkpoints) is recomputed from the event log.
2. **Determinism.** The graph reducer and trace materializer are pure
   functions of the ordered event log; rebuilds produce identical hashes.
3. **Fail-closed privacy.** Redaction errors block export, never "warn and
   continue" with the original value.
4. **Local-first.** No cloud account, no network call, and no model call is
   required for the core capture/checkpoint path.
5. **Provenance.** Every statement is `OBSERVED`, `DECLARED`, or `INFERRED`,
   and the UI/checkpoint must render them distinctly.

## Data flow

```
hook adapters (Codex hooks)     fixture JSONL files
        │                              │
        ▼                              ▼
   crash-safe spool ────────────►  JSONL importer
        │                              │
        └──────────►  event store (SQLite)  ◄──────┘
                              │
                 ┌────────────┼────────────────┐
                 ▼            ▼                ▼
          graph reducer  trace/span        checkpoint
          (deterministic) materializer     builder
                 │            │                │
                 ▼            ▼                ▼
          root hash      read models      portable JSON/Markdown
```

## Components

### Event envelope (`hfg.event.v1`)

The append-only canonical envelope records `event_id`, `sequence`,
`occurred_at`, `observed_at`, workstream/session/native identity, provider,
kind, provenance, an opaque payload, redaction metadata, and a content hash.
Unknown fields are preserved on decode so future readers never drop data.

### Identifiers

All durable IDs are ULIDs (`evt_`, `ws_`, `ses_`, `trc_`, `spn_`, `cp_`,
`repo_`). ULIDs are lexicographically sortable by time and safe to generate
concurrently.

### Canonical JSON and content hashing

Canonical encoding sorts object keys and disables HTML escaping, so two
logically identical objects produce identical bytes and identical hashes.
This is what makes deterministic rebuild possible.

### Provider adapters (`internal/adapter`)

Each provider (Codex, plus Claude and Pi) implements one narrow interface:
`Detect` (enumerate native sessions, newest first), `Normalize` (decode a
native transcript stream or hook payload into canonical `hfg.event.v1`
events), `Install` and `Uninstall` (manage the provider's hook
configuration), `Resume`, `StartFromCheckpoint`, and `Capabilities`. For
Codex, `Resume` and `StartFromCheckpoint` return an `ExecSpec` describing the
native invocation (e.g. `codex resume <id>`); the CLI prints it shell-quoted
for copy-paste and never launches agent processes itself, and ids are
validated so a hostile id cannot smuggle flags into the printed command. A
registry holds adapters keyed
by name; first registration wins so package init order cannot silently
replace an adapter.

Capabilities are declared honestly: an adapter lists what it supports
(hooks, app-server integration, checkpoint launch, native session listing,
normalizable kinds), and callers must surface missing capabilities instead of
manufacturing equivalence. Operations an adapter version does not implement
return `ErrUnsupported`; they are planned per the roadmap.

Normalization is tolerant and lossless: recognized native event types map to
canonical kinds (`session_meta` → `session.started`, user/agent messages →
`prompt.submitted`/`assistant.completed`, function calls and outputs →
`tool.started`/`tool.completed`, exec commands → `command.completed`), and
anything unrecognized still becomes a `log.observed` event with its source
kind preserved in the payload. Nothing is dropped silently; every fact parsed
from a transcript is `OBSERVED`.

#### Codex hook installation contract

The Codex adapter manages exactly one table in the Codex CLI config
(`~/.codex/config.toml`): `[hooks.handoffgraph]`, containing the hook command
plus six events (`session.started`, `prompt.submitted`,
`assistant.completed`, `tool.completed`, `command.completed`,
`session.ended`). The merge is fail-closed:

| Situation | Behavior |
|---|---|
| Config unparseable | Never modified |
| Existing managed hook differs from desired | `ErrHookConflict`; never overwritten |
| Unrelated keys or tables present | Preserved byte-for-byte |
| Managed table already matches | No-op (install is idempotent) |
| `--dry-run` | All checks run, nothing written |

Writes are atomic: temp file plus rename. Uninstall removes only the managed
table.

#### Deterministic event IDs and re-import idempotency

Normalized Codex events do not mint fresh ULIDs per import run. Each event's
`evt_<ulid>` ID is derived deterministically from `(provider, native session
id, sequence, occurred-at, content hash)`, so normalizing the same session
twice yields identical event IDs. Because the event store appends idempotently
keyed on `event_id`, re-importing a session adds no duplicate events.

### Object store

Content-addressed, zlib-compressed, immutable objects. Each object carries a
sidecar with content hash, policy (`metadata_only`, `sanitized`,
`full_local`, `encrypted`), and optional schema metadata. Large span bodies
are stored here and referenced by hash from read models — never inlined.

### Event store (SQLite)

- WAL mode, single writer, busy timeout.
- Ordered migrations run in a transaction, recorded in `schema_migrations`
  and mirrored to `user_version`.
- Timestamped backup before each migration.
- Idempotent append keyed on `event_id`.
- Out-of-order input preserved via `occurred_at` ordering.

### Graph reducer

Builds a deterministic node/edge graph from the event log. Node kinds
(Workstream, Session, TurnTrace, Span, Command, Test, Decision, Error,
Checkpoint, …) and edge relations (`BELONGS_TO`, `CAUSED`, `BASED_ON`, …)
match the roadmap's graph model. A stable root hash verifies rebuild
equivalence.

### Trace/span materializer

Derives bounded turn traces and normalized spans from events. Turn boundaries
come from `trace.started`/`trace.completed`/`trace.interrupted`. Spans come
from `span.*` events plus `command.*`/`test.*`/`file.*` events promoted to
spans so evidence (non-zero exit, failing test) is visible. Orphan spans are
preserved under best-effort status, never discarded.

### Redaction v1 (fail-closed)

Pipeline: path denylist → known token patterns → high-entropy detection →
user regexes. Fail-closed: a stage error marks the object `REDACTION_FAILED`
and blocks export. The original secret is never written into the audit
record.

### Checkpoint builder

Deterministic, evidence-first, model-free. Reads Git state and the event log
to assemble objective, repository state, source sessions, decisions, files,
commands, tests, failed approaches, constraints, open questions, and ordered
next actions — each with evidence references. Computes the transparent
handoff quality score (documented weights, 0–100) and a graph root hash.

## Performance budgets (v0.1.0)

| Budget | Target |
|---|---|
| Event append p95 | < 5 ms |
| 10,000-event ingestion | no loss (tested) |
| Graph rebuild hash | deterministic (tested) |
| Checkpoint without model | supported |

## Next versions

- **v0.2.x** Codex App Server integration + 20-real-session acceptance run.
- **v0.3.0** First Claude→Codex proof (Claude adapter groundwork landed).
- **v0.4.0** Pi extension + local MCP hardening.
- **v0.5.0** Local Session Debugger polish.
- **v0.6.0** Verified checkpoint + cross-agent continuation (`continue --to` executes the `ExecSpec`s).

See [ROADMAP.md](../ROADMAP.md) for the full release train and
[adapter-codex.md](adapter-codex.md) for the Codex adapter reference.
