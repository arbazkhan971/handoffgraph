# Hosted retention, artifact tiering, and batch export

HandoffGraph's hosted platform stores evidence. Evidence that quietly expires
is worse than no evidence, because a missing row and a deleted row look
identical after the fact. This document states exactly what is kept forever,
what can be reclaimed, and what a retention policy can and cannot reach.

Implemented in `platform/src/artifacts.ts` and `platform/migrations/0006_artifacts_exports.sql`.

## The one rule

> **The event spine is never TTL'd. Only rebuildable derived models are.**

Everything below follows from that.

| Layer | Table / location | Retention |
| --- | --- | --- |
| Spine | `events` (D1) | **Forever.** Append-only; never updated, never deleted. |
| Cold tier | `artifacts/<workspace_id>/*.jsonl` (R2) | **Forever.** Immutable objects. |
| Cold-tier index | `artifact_file_list` (D1) | **Forever.** Rows are immutable and undeletable. |
| Exports | `exports/<workspace_id>/*.ndjson` (R2) + `exports` (D1) | Kept; terminal manifests are immutable. |
| Derived read models | `traces`, `spans`, and later projections | **TTL-eligible.** Rebuildable by replaying the spine. |

The rule is enforced in the schema, not only in application code. Migration
0006 installs `events_reject_update` and `events_reject_delete`, so any
statement that tries to slim the spine — from this sweep or any future one —
aborts the transaction instead of silently destroying evidence. The artifact
index carries the same guards (`artifact_file_list_reject_update`,
`artifact_file_list_reject_delete`).

## Artifact tiering (compaction)

A scheduled sweep (`*/10 * * * *`, `artifactsScheduled`) copies runs of spine
rows into compacted JSONL objects on R2 and records each object in
`artifact_file_list`.

- **Triggers.** A workspace's uncompacted run is flushed when it is old enough
  (`COMPACTION_AGE_SECONDS = 600`) **or** large enough
  (`COMPACTION_SIZE_BYTES = 256 KiB` of pending `raw_json`). Age alone starves a
  busy workspace of object turnover; size alone leaves a quiet workspace with an
  uncompacted tail forever, so both exist.
- **Post-hoc, never inline.** The compactor reads D1 after the fact. There is no
  ingest hook, so a slow or failing sweep cannot add latency to — or block —
  `POST /v1/event-batches`, and local capture is unaffected either way.
- **Copy, not move.** Compaction never deletes or mutates a row in `events`. The
  object is a derived cold copy whose only purpose is to make it safe to slim
  *derived* tables later.
- **Deterministic and idempotent.** Every page is re-sorted by `seq` before
  encoding, and lines are canonical JSON, so the same rows always produce the
  same bytes and the same `content_sha256`. Object keys are derived from
  `(workspace_id, min_seq, max_seq)`, so a repeated sweep rewrites the same key
  with identical bytes rather than orphaning a second copy; the unique index on
  `(workspace_id, min_seq, max_seq)` plus `INSERT OR IGNORE` keeps the index row
  singular.
- **`min_occurred_at` / `max_occurred_at` are lexicographic hints.**
  `occurred_at` is stored exactly as observed and may carry any UTC offset, so
  those columns locate an object; they are not a normalized time range.

## Retention policy

`GET /v1/retention` and `PUT /v1/retention` (device bearer, `read` capability)
manage one number per workspace: `derived_ttl_days`.

- `null` (the default) means derived models are kept indefinitely.
- The floor is **7 days**, enforced at the API edge *and* by a `CHECK` in
  `retention_policies`. Anything shorter would delete read models inside the
  window a human needs to debug a live incident.
- The ceiling is 3650 days.

`retentionSweep` runs on the same cron. For each workspace with a TTL it deletes
rows older than `now - ttl_days` from the declared derived targets only:

```
traces             (started_at_ns, unix ns)  — migration 0001
spans              (started_at_ns, unix ns)  — migration 0001
span_observations  (started_at_ns, unix ns)  — migration 0005
span_fingerprints  (last_seen,     unix ms)  — migration 0005
```

The cutoff is bound once as unix **seconds** and scaled inside SQL into each
table's own native unit, so the multiplication stays in SQLite's exact 64-bit
integer arithmetic instead of leaving JavaScript's safe-integer range.
`span_observations.ts_bucket` is a STORED generated column derived from
`started_at_ns`, so pruning on `started_at_ns` prunes the bucket index with it.

Targets that a sibling slice has not created yet are probed via `sqlite_master`
and skipped gracefully — which is exactly why every declared `(table, column)`
pair has to name a real column: an unknown name is indistinguishable from "not
shipped yet", so a typo silently turns retention into a no-op rather than
failing loudly. `NEVER_RETAINED_TABLES` is a second, in-code guard: even if a
future edit adds `events`, `artifact_file_list`, or `exports` to the target
list, the sweep refuses to touch them.

**What retention never does:** it never deletes an event, never deletes an
artifact index row, and never deletes an R2 object. Purging a workspace's cold
storage is an explicit operator action that has to drop the immutability trigger
first — it is deliberately not something a TTL can reach.

### Rebuilding after a sweep

Derived models are projections. After a TTL sweep, replaying `events` (or the
compacted artifacts, which are a faithful row-level copy) reconstructs them
exactly. That is the property that makes TTLs safe here and unsafe on the spine.

## Batch export

`POST /v1/exports` writes a bounded NDJSON extract to
`exports/<workspace_id>/<export_id>.ndjson` and records a manifest row
(`status`, `object_key`, `byte_size`, `event_count`, `sha256`).

- Selectors are mutually exclusive and fail closed: exactly one of `full: true`,
  `workstream_id`, or `since`/`until`. Unknown fields are rejected, so a typo
  can never silently widen an export to the whole workspace.
- `since`/`until` bound `events.ingested_at` — the server-assigned ingestion
  clock — accepting either unix seconds or an RFC 3339 string. They do **not**
  bound `occurred_at`, which is preserved exactly as observed and may carry any
  UTC offset, making it unsafe to compare in SQL.
- Execution is synchronous in-request today, hence the bounds
  (`EXPORT_MAX_EVENTS = 50_000`, `EXPORT_MAX_BYTES = 8 MiB`). Exceeding them
  fails the job closed with `413` and settles the row as `error` rather than
  returning a truncated extract. A durable Workflows-backed executor will lift
  the bound without changing the API surface — the `queued` status and the
  manifest columns already describe that shape.
- `GET /v1/exports` lists manifests (`{items, next_cursor}`),
  `GET /v1/exports/{id}` returns one, and `GET /v1/exports/{id}/download`
  streams the object back as an attachment. An export belonging to another
  workspace answers `404`, never `403`: existence is never leaked.

## Configuration

```toml
[[r2_buckets]]
binding = "BODIES"
bucket_name = "handoffgraph-bodies"

[triggers]
crons = ["*/10 * * * *"]
```

Create the bucket once with `npx wrangler r2 bucket create handoffgraph-bodies`.
Without the binding, compaction fails closed (logged content-free by the
scheduled dispatcher) and `POST /v1/exports` answers `503`; ingestion and local
capture are unaffected.
