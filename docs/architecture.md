# Architecture

This document describes the local HandoffGraph architecture implemented in
this repository. It corresponds to the v0.6.0-level local product: the event
spine, Codex/Claude/Pi adapters, debugger, deterministic detections, local MCP,
and verified checkpoint continuation.

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
`repo_`, and hosted `usr_`, `wsp_`, `dev_`, `acs_`). ULIDs are
lexicographically sortable by time and safe to generate concurrently. Go IDs
are centralized in `internal/ids`; the Worker uses a single vetted
`platform/src/ids.ts` boundary backed by the ULID package. Opaque session and
device credentials are random secrets, not durable IDs, and only their hashes
are stored.

### Canonical JSON and content hashing

Canonical encoding sorts object keys and disables HTML escaping, so two
logically identical objects produce identical bytes and identical hashes.
This is what makes deterministic rebuild possible.

### Provider adapters (`internal/adapter`)

Each provider (Codex, Claude, and Pi) implements one narrow interface:
`Detect` (enumerate native sessions, newest first), `Normalize` (decode a
native transcript stream or hook payload into canonical `hfg.event.v1`
events), `Install` and `Uninstall` (manage the provider's hook
configuration), `Resume`, `StartFromCheckpoint`, and `Capabilities`. Codex,
Claude, and Pi return `ExecSpec`s for native resume and checkpoint-seeded
starts; the CLI selects the appropriate form, injects the exact bounded
checkpoint payload, prints the invocation shell-quoted for copy-paste, and
never launches agent processes itself. Native ids are validated and every
argument is quoted so hostile input cannot smuggle flags or shell syntax into
the printed command. A registry holds adapters keyed
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

The Codex adapter adds one marker-owned matcher group under `[hooks]` for each
of Codex 0.144.3's ten case-sensitive events: `PermissionRequest`,
`PostCompact`, `PostToolUse`, `PreCompact`, `PreToolUse`, `SessionStart`,
`Stop`, `SubagentStart`, `SubagentStop`, and `UserPromptSubmit`. `Stop` maps
to trace completion, not session end. The merge is fail-closed:

| Situation | Behavior |
|---|---|
| Config unparseable | Never modified |
| User groups, including the same event | Preserved byte-for-byte; managed group appended |
| Unmarked exact HandoffGraph command | `ErrHookConflict` to prevent double capture |
| Ambiguous/duplicate managed markers | `ErrHookConflict`; never modified |
| Exact managed groups already match | No-op (install is idempotent) |
| `--dry-run` | All checks run, nothing written |

Writes and backups are atomic and symlink-safe. Uninstall removes only the
marker-owned regions; neither install nor uninstall changes Codex trust state.
The stdin capture command is bounded, accepts exactly one JSON object matching
the pinned provider event's required fields and types, appends the normalized
batch atomically, and is silent on success so it cannot inject hook output into
the model. Codex's own hook-hash review remains an explicit user approval.

#### Claude hook installation contract

Claude Code 2.1.227 receives one additive group for each of `PostCompact`,
`PostToolUse`, `PreCompact`, `PreToolUse`, `SessionEnd`, `SessionStart`, `Stop`,
and `UserPromptSubmit`. `Stop` is trace completion; only `SessionEnd` closes the
native session. Default handlers have the closed key set `type`, `command`, and
`args`: the command is the raw absolute executable and args are exactly
`["hook", "claude"]`, including on Windows.

Because provider rewrites may strip unknown handler keys, Claude ownership is
external to `settings.json`. A `0600` POSIX sidecar (Windows uses inherited ACL
semantics) records the exact handler and event set. The installer requires a
unique exact match before reinstall or uninstall, preserves all other groups,
and uses guarded atomic settings/manifest writes that recheck both files at
every transaction edge, plus a recoverable pending transaction. Only a complete
exact historical seven-event marker set can be migrated or removed; partial,
malformed, foreign, or already-stripped markers fail closed.

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

### Cross-agent continuation

The launch layer turns the newest stored checkpoint into a deterministic,
provider-specific payload capped at 12,000 characters. It chooses
`native_resume` when the target provider matches a resumable source session;
otherwise it requests a checkpoint-seeded start from the Codex, Claude, or Pi
adapter. Repository state is compared with the checkpoint before handoff, and
unknown state remains explicitly unverifiable.

`handoffgraph continue --preview` performs resolution without writing.
Without preview, it appends `handoff.created`, including the selected launch
spec, drift result, and payload hash. The CLI prints the shell-quoted native
invocation and never executes the agent process. The bounded payload carries a
machine-readable `hfg://` checkpoint reference. A receiving MCP client can
call `accept_handoff` to append `handoff.accepted` with accepted, missing, and
unverifiable sections; `handoffgraph handoff status` deterministically folds
both event kinds into its read model.

## Performance budgets (v0.1.0)

| Budget | Target |
|---|---|
| Event append p95 | < 5 ms |
| 10,000-event ingestion | no loss (tested) |
| Graph rebuild hash | deterministic (tested) |
| Checkpoint without model | supported |

## Private hosted Basic foundation

`platform/` is a separate Cloudflare Worker surface; it is optional and never
sits on the local capture/checkpoint path. WorkOS AuthKit verifies a human
identity via authorization code + PKCE. HandoffGraph then creates a personal
workspace, an opaque hashed browser session, and scoped device credentials.
Cookie-authenticated account routes and bearer-authenticated ingest routes are
deliberately disjoint.

Hosted Basic limits are stored server-side. A quota-reservation INSERT trigger
serializes period rollover and batch/monthly/lifetime checks, charges usage,
then permits the idempotency receipt, append-only events, and projection to
commit in the same D1 batch. Any limit or storage failure rolls the transaction
back. Basic also permits at most 2 active devices and 10 device-token issuances
over the account lifetime; revocation releases the active slot but not the
issuance. A 50-account global beta ceiling bounds aggregate allocation before
public edge abuse controls exist. A hosted workspace without an entitlement
fails ingest closed; every account created through AuthKit receives a metered
Basic entitlement atomically.

The hosted foundation is present but not publicly deployed. The explicit-only
CLI sync now redacts through a fixed local high-water mark, requires
first-upload preview acceptance, and resumes deterministic batches from a
durable tenant-scoped cursor; self-service tenant deletion is also implemented.
Turnstile/WAF, remote migration, production domains, production retention,
private shares, and billing remain gates. See [hosted-sync.md](hosted-sync.md)
for the client boundary.

## Next versions

- **v0.6.x** Real-session acceptance across supported agent pairs and Codex
  App Server investigation.
- **v0.7.0** Canonical public repository, tagged archives, install and upgrade
  documentation, and open-source launch. Release builds are configured, but no
  native agent invocation is auto-executed.
- **v0.8.0** Productionize the existing hosted Basic account/quota/sync
  foundation and add private shares.

See [ROADMAP.md](../ROADMAP.md) for the full release train and
[adapter-codex.md](adapter-codex.md) for the Codex adapter reference.
