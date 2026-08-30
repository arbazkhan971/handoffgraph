# Parity Plan — reaching Langfuse-class capability, our way

> How HandoffGraph reaches **full feature parity** with the platforms studied in
> [`competitor-analysis.md`](./competitor-analysis.md) — without abandoning the
> verified-continuity core, the single-binary local model, or the invariants
> that make evidence trustworthy. Run this track **alongside** `ROADMAP.md`
> (release train unchanged; parity phases map onto it).

**Mandate:** if any competitor ships it, we ship it (matrix rows 1–55). The
stack is the substrate, never the excuse: Cloudflare-only for anything hosted;
Go single-binary for anything local.

---

## 0. Non-negotiable invariants (every phase, every PR)

1. Append-only events; all read models derived and rebuildable.
2. Deterministic reducers — sorted output, stable root hash, no map-order
   dependence. Re-import is idempotent (deterministic event IDs).
3. Fail-closed redaction at emit; a redaction error never exports originals.
4. Provenance (OBSERVED / DECLARED / INFERRED) on every derived claim —
   LLM-judge output is always INFERRED, never rendered as observed.
5. Money/cost is a decimal string, recorded as a fact — never a float estimate.
6. Local core works with the network off; hosted failure never blocks capture.
7. Hosted tier is **Cloudflare-only**: Workers, D1, R2, KV, Queues, Workflows,
   Durable Objects, Analytics Engine, AI Gateway, Cron Triggers, Turnstile/WAF.
   No Go servers to operate. No Vercel. No Docker/K8s for the hosted tier.
8. License hygiene: no AGPL (OpenObserve, SigNoz collector/foundry) or ELv2
   (Phoenix server) code or derivative config — ideas and public specs only.

## 1. Stack translation table (competitor pattern → our substrate)

| Their pattern | Their engine | Ours |
|---|---|---|
| Wide observations table (Langfuse V4) | ClickHouse | Local: derived wide `span_observations` table (SQLite, sorted reducer output). Hosted: D1 read model + Analytics Engine rollups |
| Time-bucket pruning (`ts_bucket_start`) | ClickHouse ORDER BY | Indexed `ts_bucket` generated column (5-min buckets locally; 30-min in D1/AE), enforced in query layer |
| Resource-fingerprint CTE | ClickHouse lookup table | `fingerprints(agent,repo,host,model)` D1/SQLite table joined before scans |
| Typed attr maps + promoted columns | ClickHouse Maps | JSON1 payload + promoted indexed columns (`tool_name`, `model`, `session_id`, `…_exists`) |
| Raw payload blob store | S3 / MinIO | Local: content-addressed object store (have). Hosted: **R2** + D1 file-list index |
| Ingest queue + workers | Redis/BullMQ (Langfuse), Redis Streams (Opik) | Local: crash-safe spool (have). Hosted: **Cloudflare Queues** → Workers |
| Sandboxed eval execution | Flask subprocess sandbox (Opik), Lambda (Langfuse) | **Workflows** (durable, retrying) + Workers; judge calls via AI Gateway/BYO keys |
| Scheduled-query alerts | Ruler + Alertmanager (SigNoz), Scheduler node (O2) | **Cron Triggers** + Workflows over D1/AE SQL; alert history = events in our own spine |
| Realtime trace streaming / presence | ClickHouse websockets, DOs | **Durable Objects** WebSockets (live `open` UI + shared workstreams) |
| Metadata store | Postgres (SQLite-default at SigNoz) | Local: SQLite (have). Hosted: **D1** — same migration discipline |
| Gateway proxy (baseURL capture, caching, budgets) | Helicone/LangWatch services | **Workers** OpenAI-compatible endpoint + KV virtual keys/rate limits |
| High-volume telemetry sampling | ClickHouse raw | **Workers Analytics Engine** (sampled rollups: cost/token/latency series) |

## 2. Phases

Ordering logic: P1 makes us *interoperable* (OTLP in, Langfuse-grade read
models, cost facts, scores) and starts the parity clock; P2 ships the *quality
loop* (evals/datasets/prompts) locally; P3 stands up the *hosted platform* on
Cloudflare primitives; P4 closes the *advanced/EE* rows. Threat-driven:
LangWatch/OpenLIT counters land in P1–P2.

### P1 — Interop spine + Langfuse-grade read models  (maps to v0.7→v0.9 track)
Matrix rows: 2, 3, 4, 9, 10, 11, 24, 37, 38.
- OTLP/HTTP ingest listener in the Go core (accept spans from OpenLLMetry,
  OpenLIT SDK, Phoenix exporters, Claude Code native OTel) with deterministic
  event-ID derivation (idempotent replay), reserved-key sanitizer, capture tiers.
  **Shipped (2026-08-28): both wire flavors, both languages** — `otlp import`
  + localhost `otlp serve`, GenAI/OpenInference/OpenLIT/Langfuse attribute
  mapping, deterministic ids with idempotent replay, fail-closed sanitizer,
  `partialSuccess` reporting (`docs/otlp.md`). OTLP/JSON landed first;
  **OTLP/protobuf then shipped local *and* hosted** with four-corner id parity
  (Go-protobuf == Go-JSON == TS-protobuf == TS-JSON), proven against a
  Go-authored golden fixture (`testdata/fixtures/otlp/genai_session.pb`,
  `platform/test/otlp_proto.test.ts`); the decoder is hand-rolled in both
  languages, so no protobuf runtime enters either dependency set.
  **Semconv v1.37 refresh (2026-08-28):** `gen_ai.provider.name`,
  `gen_ai.conversation.id`, plus a proto3 `arrayValue` spec fix.
  **Capture tiers shipped (2026-08-28):** `--capture full|metadata|minimal`
  gates attribute content at emit (body prefixes dropped+counted under
  metadata; key manifest only under minimal) — OpenLIT's tier concept with
  fail-closed semantics.
  **gRPC re-scoped out (2026-08-28), with rationale:** Cloudflare Workers
  cannot terminate inbound gRPC at all, so the hosted half is impossible on
  our declared substrate; and locally, OTLP/gRPC needs a full HTTP/2 +
  protobuf-service stack, which would break the single binary's three-
  dependency posture for a transport that has a standard workaround.
  Protobuf-only emitters point at a collector (`otlp` receiver →
  `otlphttp` exporter) and forward to `/v1/traces`. Documented in
  `docs/otlp.md` and in the row-2 matrix cell.
- `handoffgraph.*` attribute namespace mapped over `gen_ai.*` /
  `coding_agent.*`; interop docs for OpenInference/OpenLLMetry/Langfuse attrs.
  **Shipped (2026-08-28):** full **OpenInference 10-kind coverage in both Go
  and TypeScript**, with the two lossy folds documented at the case that
  performs them — `EVALUATOR → GUARDRAIL` (both are quality gates over
  content) and `PROMPT → WORKFLOW` (a prompt-rendering span is not a model
  call, so it folds alongside `CHAIN`).
- Read-model upgrade: wide `span_observations` (trace attrs denormalized),
  `ts_bucket` indexes, fingerprint tables, promoted columns.
  **Shipped (2026-08-28):** migration 9 + `internal/observations` +
  `index rebuild` / `query spans` (coarse bucket prune + exact predicates,
  stale auto-rebuild). **Hosted half shipped (2026-08-28, rows 9–11):**
  D1 `span_observations` wide table + first-class sessions + 30-minute
  `ts_bucket` + fingerprints (migration 0005), read through
  `GET /v1/observations`, `GET /v1/sessions`, `GET /v1/fingerprints`, with
  `POST /v1/admin/reindex` to rebuild. The same two-level prune as local: a
  coarse bucket predicate narrows the index, an exact `started_at_ns`
  predicate keeps the result precise. Remaining: runtime attribute promotion
  landed in P2 (row 12), so nothing is outstanding here.
- `score.recorded` event type + read model (numeric/categorical/bool, target
  trace/span/session/checkpoint/workstream, source-tagged) wired into
  CLI + MCP + UI. **Shipped (2026-08-28, event kind `score.recorded`):**
  `internal/scores` deterministic materializer + validated payload builder,
  `score record`/`score list` CLI, MCP `record_score`/`list_scores`.
  Source-tagged (human/api/evaluation/detection); target prefixes enforced.
  **Row 24 completed (2026-08-28):** the debugger-UI `ScoresView` shipped and
  the `llm_judge` INFERRED source became real via hosted evals (row 29), so
  the source enum is now fully exercised end to end; hosted reads via
  `GET /v1/scores`. Nothing outstanding.
- Coding-agent outcome analytics read models (edits accepted/rejected, commits,
  PRs, session outcomes) — we already capture the events.
  **Shipped (2026-08-28):** `query usage` (per provider/session token+cost
  rollups; cost always provenance-labelled) + `outcomes` (files touched,
  commands run/failed, tests passed/failed, handoffs created/acked, scores).
  **Hosted halves shipped (2026-08-28, rows 37/38):** `GET /v1/analytics/series`
  and `GET /v1/analytics/summary`, where the D1 aggregate is the correctness
  source and the Analytics Engine mirror is explicitly lossy/best-effort
  (AE `doubles` are IEEE floats; decimal-string cost facts and provenance
  labels never leave D1).
  **Remaining (2026-08-28, row 38 tail): edits accepted/rejected + commit/PR
  linkage still pending adapter events.** The adapters do not emit acceptance
  events yet, and we will not synthesize an acceptance signal we did not
  observe — that would put an INFERRED guess where a fact belongs.
- Batch import API with backpressure semantics + ingest-side dedup.
  **Local + hosted shipped (2026-08-31, row 4):** deterministic dedup and
  atomic D1 quota reservation; Basic-safe 100-event/256-KiB requests;
  structured 429s that distinguish monthly waiting from permanent unchanged
  batch/lifetime retries; and UTF-8-safe marked inline truncation. Explicit
  Go sync persists and replays the exact pending body/key without an automatic
  retry or cursor advance.
- **Acceptance gate:** golden fixtures for OTLP paths; re-import idempotency
  (duplicate batch = zero new events); deterministic rebuild hash stable across
  runs; p95 ingest < 5 ms maintained (BenchmarkAppend extension); every hot
  query EXPLAINs through a `ts_bucket` index; 10k-event properties unbroken.

### P2 — Quality loop + agent-facing surface  (v0.9→v0.11 track)
Matrix rows: 5, 12, 13, 23(tiers), 25, 26, 27(local), 33, 34, 44(start), 50, 52.
- Deterministic evaluators (code checks over traces/spans/checkpoints) emitting
  verdict events with evidence refs; `handoffgraph verify --baseline <cp>` CI
  gate (exit code, cached results, regression report).
  **Shipped (2026-08-28):** `verify` command — six deterministic checks
  (traces_closed, commands_ok, tests_pass, handoffs_acknowledged,
  scores_pass rubric, detections_clean) + baseline score/new-failure
  regression, exit codes, verification.recorded evidence per run.
  **Row 26 completed (2026-08-28):** a verify **result cache** landed
  (migration 12, `internal/storage/verify_cache.go`); reports carry
  `cached: true` when served from it and `--no-cache` forces a recompute.
  Remaining: custom evaluator registration (not a matrix row).
- Signal coalescing: `signal_source` precedence so a natively-emitted span
  wins over the same event seen through a hook, an SDK, or an import.
  **Shipped (2026-08-28, row 5):** `native > hook > sdk > import` coalescing
  in the observation derivation. Losing rows are kept as **shadow rows**, not
  deleted — coalescing is a read-model choice and must never destroy a signal
  we observed. `--signal-source` and `--include-shadowed` filters on
  `sessions` and `query spans` expose both views.
- Typed attribute maps + promoted indexed columns; derived exception groups.
  **Shipped (2026-08-28, rows 12–13):** promoted indexed columns with
  `_exists` markers (EXPLAIN-verified index use, `observations_promotion_test.go`)
  and an `exception_groups` read model with a deterministic grouping hash,
  queryable via `query exceptions`.
- Datasets & experiments v1: content-addressed dataset versions (hash-pinned),
  experiment runs as derived read models, comparison table in the debugger UI.
  **Shipped (2026-08-28):** `dataset create/list` (content-hash versions,
  bodies in the object store) + `experiment run/list/compare` (deterministic
  materialize+detections task per example, regression diff, exit codes).
  **Row 27 completed (2026-08-28):** debugger-UI `DatasetsView` with the
  compare panel, plus hosted reads `GET /v1/datasets`, `/v1/experiments`,
  `/v1/experiments/compare`.
- Prompt store: immutable versions + mutable labels + prompt↔trace linkage;
  MCP tools (`get_prompt`, `record_score`, `annotate`) extended.
  **Shipped (2026-08-28):** `prompt create/label/list/show` — immutable
  hashed versions (32 KiB fail-closed cap), mutable labels as derived state,
  linkage view over event payloads, plus the `get_prompt` MCP tool.
  **Rows 33/34 completed (2026-08-28):** debugger-UI `PromptsView` and hosted
  reads `GET /v1/prompts`, `GET /v1/prompts/show`, with a **gated** label
  repoint at `POST /v1/prompts/{name}/labels` (row 36 supplies the gate).
- Detection pack v2 = deterministic evaluator library (loop detection, arg
  correctness, handoff validity — DeepEval's deterministic set, ported).
- Capture tiers (`minimal` / `metadata` / `full`) enforced at emit with one
  redaction choke-point (OpenLIT's product concept, our fail-closed semantics).
- Agent skills/manifests (`.claude-plugin`-style) so Claude Code/Codex/Pi drive
  import→verify→debug autonomously via MCP.
  **Shipped (2026-08-28):** `skills/handoffgraph/SKILL.md` +
  `.claude-plugin/plugin.json` (skill + stdio MCP declaration).
- Batch import API with backpressure semantics + ingest-side dedup.
  **Backpressure shipped (2026-08-28):** 429 + Retry-After at the in-flight
  cap; dedup already deterministic. **Hosted tail shipped (2026-08-31):**
  monthly 429s carry a bounded `Retry-After`; batch/lifetime 429s declare an
  unchanged retry non-retryable; the explicit client preserves the exact
  pending request and never auto-sleeps.
- Public API v0 on Workers (read-only first) + pk/sk keys w/ edge-cached
  rejection; hosted MCP endpoint (remote MCP = v0.11 roadmap item pulled in).
  **Shipped (2026-08-28, rows 44 + 21):** `pk_`/`sk_` keys with KV
  edge-cached rejection — property-tested to perform **zero D1 queries** on a
  repeat bad key (and on a repeat good one); public `/api/v1/*` reads;
  OpenAPI 3.1 at `GET /api/v1/openapi.json` with a **bidirectional**
  completeness test (every routed path appears in the spec and every spec
  path is routable); and `POST /v1/mcp` mirroring the local tool contract.
- One-command UX: `handoffgraph doctor --verify`, clean reset, `open` single port.
  **Shipped (2026-08-28, row 52):** `doctor --verify` runs the deep checks,
  and a `reset` command clears derived read models and caches — with
  `--hard` (full data-directory wipe, event log included) **failing closed**
  unless `--yes` is also passed, and refusing outright on an empty data dir.
- **Acceptance gate:** evaluator fixtures (pass/fail/error golden); verify exits
  non-zero on regression vs pinned baseline; dataset replay reproduces byte-
  identical read models; label repoint is O(1) and audit-evented; API auth
  rejects bad keys without D1 read (KV cache) — property-tested.

### P3 — Hosted platform, Cloudflare-only  (v0.8 hosted-beta + v0.9 team track)
Matrix rows: 4(hosted), 6, 7, 14, 15, 21, 27(hosted), 28, 29, 39, 40, 41, 43, 45, 46, 47, 49.
- Workers ingest: OTLP + batch endpoints (P1 contract mirrored), Queues →
  normalization Workers → D1 read models + R2 raw artifacts + AE rollups.
  **Shipped (2026-08-28):** `POST /v1/otlp` in both wire flavors (see P1);
  AE mirroring via `recordIngestDataPoints`, fire-and-forget so a missing or
  throwing `ANALYTICS` binding can never affect an ingest response.
  **Batch endpoint completed (2026-08-31, row 4):** `POST /v1/event-batches`
  enforces atomic tenant quotas and deterministic receipts; monthly limits
  supply bounded retry guidance, while per-batch and lifetime limits reject
  hot-loop retries. The explicit Go client retains its byte-identical pending
  batch for the next operator invocation.
- D1 schema: fingerprints, `ts_bucket`-indexed observations, scores, datasets,
  prompts, alert rules; file-list index for R2 artifact compaction (Workflows
  compact on count/age triggers — OpenObserve's 256 MB/600 s pattern).
  **Shipped (2026-08-28, migrations 0004–0017; rows 9–11, 14, 15):** the wide
  observations table + sessions + fingerprints (0005); R2 artifact tiering
  with the D1 `artifact_file_list` index and a **cron compaction sweep**
  (0006, `*/5 * * * *`); retention that touches **derived models only** — the
  sweep refuses `NEVER_RETAINED_TABLES`, so the spine and the artifact index
  are never TTL'd (`docs/hosted-retention.md`, `PUT /v1/retention`).
- Evals on hosted: Workflows run deterministic evaluators + optional LLM-judge
  (AI Gateway, BYO keys; cron/online evals); results INFERRED-labelled.
  **Shipped (2026-08-28, row 29):** five deterministic checks
  (`commands_ok`, `handoffs_acknowledged`, `tests_pass`, `tool_error_rate`,
  `traces_closed`) recorded OBSERVED with `source=evaluation`, and an LLM
  judge recorded INFERRED with `source=llm_judge` **on every path — there is
  no input that produces an unlabelled judge verdict**. BYO provider keys are
  stored sealed; cron and manual triggers share one Workflows-durable
  contract with a resumable-step test.
- Annotation queues + scores via API/UI (Durable Objects for live queue state).
  **Shipped (2026-08-28, row 28):** claim/submit/skip over
  `/v1/annotation-queues/*`, each submission recording `score.recorded` with
  `source=human`; the `AnnotationQueueRoom` Durable Object holds live state
  with a D1 fallback so a DO outage degrades rather than blocks.
- Dashboards-as-config (versioned JSON, import/export, share links) + scheduled
  alerts (Cron + Workflows) with webhook/Slack/email channels; alert history
  appended to the spine.
  **Shipped (2026-08-28, rows 39–41, 43):** dashboards CRUD with **versioned
  immutable JSON**, `POST /v1/dashboards/validate` as a CI dry-run, an in-repo
  example (`deploy/dashboards/coding-agent-overview.json`), and share links
  (`/v1/dashboards/{id}/shares` → `GET /v1/shared/dashboards/{token}`).
  Dashboard *data* is read from D1 deterministically; AE is only ever the
  lossy mirror. Alert rules + a cron evaluator dispatch to webhook, Slack and
  email channels, and **every firing appends `alert.fired` to the spine**, so
  alert history inherits replay, export, retention-exemption and webhook
  delivery instead of needing a module of its own.
  **Row 42 pulled forward from P4 and shipped (2026-08-28):**
  `POST /v1/analytics/funnel`.
- Gateway capture mode: OpenAI-compatible proxy Worker (zero-code logging),
  virtual keys/budgets/rate limits in KV, response caching (R2 + edge).
  **Shipped (2026-08-28, rows 6–7):** OpenAI-compatible proxy, `vk_` virtual
  keys, budgets as **exact decimal strings** (never floats), rate limits,
  capture-to-spine events labelled OBSERVED (the proxy directly observes the
  call), an opt-in R2 response cache under a `gwcache/` prefix, and ordered
  provider fallbacks (max 3). **Streaming is rejected in v1 (dated re-scope,
  2026-08-28)** rather than silently buffered and replayed as a fake stream:
  a buffered "stream" would misrepresent a capability we do not have.
- Teams: orgs/projects/RBAC on D1; shared workstreams; tamper-evident audit via
  the same hash-chaining; batch export to R2; webhooks out (Queues consumers).
  **Shipped (2026-08-28, rows 45–47, 49):** workspace roles
  owner/admin/member/viewer, invites with **hash-only** tokens (plaintext
  shown once, never stored), seat accounting, and last-owner protection
  enforced at the route *and* again in the schema; a Team section on the
  account page. Audit is a hash-chained `team.*` event stream with `prev_hash`
  triggers enforcing the chain in-schema, read via `GET /v1/workspace/audit`
  with a `chain_verified` field. Batch export to R2 (`/v1/exports` +
  `/v1/exports/{id}/download`) and outbound webhooks over Queues with
  HMAC-signed, content-free summaries plus a reconciliation sweep for
  stranded `queued` rows.
- **Acceptance gate:** end-to-end redacted sync (pre-upload redaction preview —
  existing v0.8 gate); multi-tenant isolation tests; Queues DLQ + replay drill;
  Workflows eval run is resumable after kill (durable execution test); load
  profile at 10M observations with AE rollups answering dashboards < 500 ms
  p50; hosted failure never blocks local capture (forced-fault drill).

### P4 — Advanced & EE surface  (v0.12+ track)
Matrix rows: 30, 31, 32, 35, 36, 42, 48, 51, 53, 54.
- Prompt playground (variant diff, replay against datasets via gateway);
  prompt CI/CD (webhooks, GitHub Action, label-repoint rollback gated on evals).
  **Shipped (2026-08-28, rows 35–36):** `POST /v1/playground/run` +
  `GET /v1/playground/runs`; eval-gated label repoint with rollback, an
  example workflow at `.github/workflows/prompt-ci.yml.example`, and an
  outbound webhook on `prompt.labeled`.
  **Phase-conflict resolution (2026-08-28):** the matrix listed row 35 under
  **P3** while this plan listed it under **P4**. It shipped 2026-08-28 as part
  of the P4 wave; **P4 is the phase of record** and `competitor-analysis.md`
  row 35 now carries the same note.
  **Shipped (2026-08-28, row 30 — minimal):**
  `POST /v1/prompt-optimizer/suggest` returns an INFERRED suggestion and
  **never auto-applies it**; the only route to production is the normal gated
  label repoint, so an optimizer can propose but never promote.
- Agent simulations (Scenario-style user-simulator + judge on Workflows);
  optional benchmark harness locally.
  **Shipped (2026-08-28, row 31):** `/v1/simulations/*` — user-simulator plus
  judge, verdicts always INFERRED, on the same durable run contract as evals,
  with content-addressed transcripts.
  **Row 32 re-scoped (2026-08-28) — demand-gated, not built.** The row was
  marked "(optional)" from the start. Deterministic evaluators + datasets ×
  experiments already answer "did *this* agent regress on *our* corpus",
  which is the question our users actually ask; standard-benchmark
  leaderboards are a different product with a different buyer. Revisit on
  real demand.
- Trace funnels on AE rollups; embedding drift views (Vectorize) if demand.
  **Row 42 shipped early, in the P3 analytics wave (2026-08-28):**
  `POST /v1/analytics/funnel`, computed from D1 spans rather than AE
  (correctness over sampling).
  **Row 54 re-scoped (2026-08-28) — demand-gated, not built.** This bullet
  already conditioned it on demand ("if demand"). Nothing in the evidence
  model needs embeddings, and adding a vector store to a Cloudflare-only
  substrate for a hypothetical drift view is exactly the kind of speculative
  dependency §0 exists to prevent. Revisit on real demand.
- EE line (directory-fenced, separate license, Workers build target): SSO,
  SCIM, fine-grained RBAC, retention policies, in-product assistant (BYO model,
  INFERRED-labelled, powered by our own MCP tools).
  **Shipped (2026-08-28, rows 48 + 51):** the fence is real, not a label —
  `platform/ee/` with its own LICENSE, an `EE_ENABLED` flag where **only the
  exact string `"true"` opens it**, and a fence test asserting the OSS
  baseline is intact and the EE surface invisible by default. First features:
  SSO org binding (WorkOS still performs the dance through the existing
  callback), SCIM bearer token + `Users`, a masking rules engine, and audit
  export. The assistant (`POST /v1/assistant`) answers over our own MCP
  tools with a BYO model, and every answer is INFERRED and carries
  `evidence_refs`.
  **Still pending (2026-08-28):** SCIM is a subset — no `PATCH`, no
  deprovisioning, no Groups — and **masking is not wired into ingest**:
  `applyMaskingRules` is complete, deterministic and fail-closed, but nothing
  in `src/ingest.ts` calls it yet (`docs/ee.md` carries the follow-up).
- Multimodal attachments direct-to-R2 (presigned uploads).
  **Shipped substrate-adjusted (2026-08-28, row 53):** content-addressed
  uploads stream *through* the Worker to R2 (`/v1/attachments`, SHA-256 as
  row identity, dedup on repeat bytes, 8 MiB cap enforced mid-stream) and
  append `attachment.recorded` to the spine.
  **Presigned direct-to-R2 re-scoped (2026-08-28):** true browser-to-R2
  presigned upload needs S3-compatible R2 **account** API keys, which this
  deployment does not hold and which are a different credential class from
  the bucket binding. Recorded as a later re-scope rather than faked.
- **Acceptance gate:** each EE feature behind flags with OSS baseline intact;
  assistant answers carry provenance labels; playground runs are recorded as
  experiment events (dogfood).

## 3. Sequencing & dependencies

```
P1 interop ──► P2 quality loop ──► P3 hosted platform ──► P4 advanced/EE
   │                │                     │
   └─ v0.7 launch gates still precede public API/GA claims (ROADMAP §v0.7)
```
- v0.7.0 release-gate items (canonical repo, first tag, real-session acceptance)
  stay first — parity claims ship *on top of* a published product.
- The 20-real-session acceptance and cross-agent continuation drills double as
  P1 fixtures capture (real transcripts → golden cassettes, OpenLLMetry-style).
- Cloudflare-only rule: any PR introducing a non-CF hosted dependency is
  rejected by review (and by `doctor`'s hosted-mode check).

## 4. Non-goals

- Generic infra observability (SigNoz/O2 own it; we ingest via OTLP instead).
- Browser session replay (row 55).
- Running agent processes (we print invocations; Agenta wraps — we verify).
- Copying competitor code under incompatible licenses (§0.8).

## 5. Definition of done (whole plan)

Every matrix row 1–54 is either ✅ shipped behind a tested gate, or explicitly
re-scoped with a dated rationale edit in `competitor-analysis.md`. `doctor`
reports parity-relevant capability state; `docs/parity-plan.md` statuses are
updated in the same PR as the feature they declare.

**Status — 2026-08-31.** That condition is now met for all of rows 1–54:
every row is either shipped behind a tested gate or carries a dated re-scope
rationale (rows 32 and 54 demand-gated; gRPC on row 2 and presigned
direct-to-R2 on row 53 substrate-gated; row 55 was always out of scope).
Two *pending tails* remain inside otherwise-shipped rows and are stated
plainly rather than hidden behind a checkmark:

1. **Row 38** — edits accepted/rejected + commit/PR linkage, blocked on
   adapters emitting acceptance events; we will not synthesize them.
2. **Row 48** — SCIM provisioning beyond the `Users` subset, and wiring the
   (complete, fail-closed) masking engine into the ingest path.

Row 4's hosted tail closed on 2026-08-31: retryability is explicit and the
durable Go pending batch remains byte-identical until a validated receipt.

Parity is not the launch gate. The `ROADMAP.md` v0.7 gates — canonical repo
and module path, ~20 real sessions imported as acceptance evidence, first tag
— still come first, and remain owner work.
