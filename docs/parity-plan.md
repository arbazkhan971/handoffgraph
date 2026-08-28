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
  **Shipped (2026-08-28): OTLP/JSON flavor** — `otlp import` + localhost
  `otlp serve`, GenAI/OpenInference/OpenLIT/Langfuse attribute mapping,
  deterministic ids with idempotent replay, fail-closed sanitizer,
  `partialSuccess` reporting (`docs/otlp.md`). **Capture tiers shipped
  (2026-08-28):** `--capture full|metadata|minimal` gates attribute content
  at emit (body prefixes dropped+counted under metadata; key manifest only
  under minimal) — OpenLIT's tier concept with fail-closed semantics.
  Remaining: protobuf + gRPC flavors.
- `handoffgraph.*` attribute namespace mapped over `gen_ai.*` /
  `coding_agent.*`; interop docs for OpenInference/OpenLLMetry/Langfuse attrs.
- Read-model upgrade: wide `span_observations` (trace attrs denormalized),
  `ts_bucket` indexes, fingerprint tables, promoted columns.
  **Shipped (2026-08-28):** migration 9 + `internal/observations` +
  `index rebuild` / `query spans` (coarse bucket prune + exact predicates,
  stale auto-rebuild). Remaining: Analytics Engine rollups for the hosted
  tier (P3) and runtime attribute promotion (P2).
- `score.recorded` event type + read model (numeric/categorical/bool, target
  trace/span/session/checkpoint/workstream, source-tagged) wired into
  CLI + MCP + UI. **Shipped (2026-08-28, event kind `score.recorded`):**
  `internal/scores` deterministic materializer + validated payload builder,
  `score record`/`score list` CLI, MCP `record_score`/`list_scores` (now 11
  tools). Source-tagged (human/api/evaluation/detection); target prefixes
  enforced; the UI list view and an llm_judge INFERRED source remain open.
- Coding-agent outcome analytics read models (edits accepted/rejected, commits,
  PRs, session outcomes) — we already capture the events.
  **Shipped (2026-08-28):** `query usage` (per provider/session token+cost
  rollups; cost always provenance-labelled) + `outcomes` (files touched,
  commands run/failed, tests passed/failed, handoffs created/acked, scores).
  Remaining: edits accepted/rejected + commit/PR linkage once adapters emit
  acceptance events; hosted dashboards (P3).
- Batch import API with backpressure semantics + ingest-side dedup.
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
  Remaining: custom evaluator registration, cached results.
- Datasets & experiments v1: content-addressed dataset versions (hash-pinned),
  experiment runs as derived read models, comparison table in the debugger UI.
  **Shipped (2026-08-28):** `dataset create/list` (content-hash versions,
  bodies in the object store) + `experiment run/list/compare` (deterministic
  materialize+detections task per example, regression diff, exit codes).
  Remaining: UI comparison views (P3 hosted dashboards).
- Prompt store: immutable versions + mutable labels + prompt↔trace linkage;
  MCP tools (`get_prompt`, `record_score`, `annotate`) extended.
  **Shipped (2026-08-28):** `prompt create/label/list/show` — immutable
  hashed versions (32 KiB fail-closed cap), mutable labels as derived state,
  linkage view over event payloads. Remaining: `get_prompt` MCP tool,
  playground (P4).
- Detection pack v2 = deterministic evaluator library (loop detection, arg
  correctness, handoff validity — DeepEval's deterministic set, ported).
- Capture tiers (`minimal` / `metadata` / `full`) enforced at emit with one
  redaction choke-point (OpenLIT's product concept, our fail-closed semantics).
- Agent skills/manifests (`.claude-plugin`-style) so Claude Code/Codex/Pi drive
  import→verify→debug autonomously via MCP.
- Public API v0 on Workers (read-only first) + pk/sk keys w/ edge-cached
  rejection; hosted MCP endpoint (remote MCP = v0.11 roadmap item pulled in).
- One-command UX: `handoffgraph doctor --verify`, clean reset, `open` single port.
- **Acceptance gate:** evaluator fixtures (pass/fail/error golden); verify exits
  non-zero on regression vs pinned baseline; dataset replay reproduces byte-
  identical read models; label repoint is O(1) and audit-evented; API auth
  rejects bad keys without D1 read (KV cache) — property-tested.

### P3 — Hosted platform, Cloudflare-only  (v0.8 hosted-beta + v0.9 team track)
Matrix rows: 6, 7, 14, 15, 21, 27(hosted), 28, 29, 39, 40, 41, 43, 45, 46, 47, 49.
- Workers ingest: OTLP + batch endpoints (P1 contract mirrored), Queues →
  normalization Workers → D1 read models + R2 raw artifacts + AE rollups.
- D1 schema: fingerprints, `ts_bucket`-indexed observations, scores, datasets,
  prompts, alert rules; file-list index for R2 artifact compaction (Workflows
  compact on count/age triggers — OpenObserve's 256 MB/600 s pattern).
- Evals on hosted: Workflows run deterministic evaluators + optional LLM-judge
  (AI Gateway, BYO keys; cron/online evals); results INFERRED-labelled.
- Annotation queues + scores via API/UI (Durable Objects for live queue state).
- Dashboards-as-config (versioned JSON, import/export, share links) + scheduled
  alerts (Cron + Workflows) with webhook/Slack/email channels; alert history
  appended to the spine.
- Gateway capture mode: OpenAI-compatible proxy Worker (zero-code logging),
  virtual keys/budgets/rate limits in KV, response caching (R2 + edge).
- Teams: orgs/projects/RBAC on D1; shared workstreams; tamper-evident audit via
  the same hash-chaining; batch export to R2; webhooks out (Queues consumers).
- **Acceptance gate:** end-to-end redacted sync (pre-upload redaction preview —
  existing v0.8 gate); multi-tenant isolation tests; Queues DLQ + replay drill;
  Workflows eval run is resumable after kill (durable execution test); load
  profile at 10M observations with AE rollups answering dashboards < 500 ms
  p50; hosted failure never blocks local capture (forced-fault drill).

### P4 — Advanced & EE surface  (v0.12+ track)
Matrix rows: 30, 31, 32, 35, 36, 42, 48, 51, 53, 54.
- Prompt playground (variant diff, replay against datasets via gateway);
  prompt CI/CD (webhooks, GitHub Action, label-repoint rollback gated on evals).
- Agent simulations (Scenario-style user-simulator + judge on Workflows);
  optional benchmark harness locally.
- Trace funnels on AE rollups; embedding drift views (Vectorize) if demand.
- EE line (directory-fenced, separate license, Workers build target): SSO,
  SCIM, fine-grained RBAC, retention policies, in-product assistant (BYO model,
  INFERRED-labelled, powered by our own MCP tools).
- Multimodal attachments direct-to-R2 (presigned uploads).
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
