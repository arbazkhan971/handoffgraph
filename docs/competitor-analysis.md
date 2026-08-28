# Competitor Analysis — LLM/Agent Observability & Eval Platforms

> Study of 12 open-source platforms to bring HandoffGraph to **full feature parity**
> while keeping our differentiators. Raw research (verified against GitHub APIs,
> LICENSE files, and official docs, late Aug 2026) lives in
> [`docs/research/01..05-*.md`](./research/). Feature commitments feed
> [`docs/parity-plan.md`](./parity-plan.md).

**Parity rule (product law):** *if any competitor ships it, we ship it.* Every
feature in the union matrix below has a named implementation on our split:
**local Go core** (single binary, pure-Go SQLite) or **Cloudflare-only hosted
tier** (Workers/D1/R2/KV/Queues/Workflows/Durable Objects/Analytics Engine).
No feature is dropped for stack reasons; where Cloudflare lacks a primitive,
the plan documents the compensating pattern.

---

## 1. Landscape snapshot (verified late Aug 2026)

| Project | Stars | License | Backend(s) | Telemetry store | Status | Closest to us? |
|---|---:|---|---|---|---|---|
| Langfuse | 33,817 | MIT + `ee/` | TS (Next.js web, Express worker) | ClickHouse + Postgres + Redis + S3 | **Acquired by ClickHouse, announced 2026-01-16** (alongside CH's $400M Series D); V4 GA 2026-08-17 | Features |
| SigNoz | 31,949 | MIT core; AGPL collector/foundry; `ee/` | Go (single bundled binary) + OTel collector | ClickHouse (+ SQLite/PG metadata) | Very active | Go backend patterns |
| DeepEval | ~17.5k | Apache-2.0 | Python library (no server) | local `.deepeval/` artifacts | Very active | Library-first model |
| Opik | 21,577 | Apache-2.0 (full platform in-repo) | Java + Flask + React | ClickHouse + MySQL + Redis + MinIO | Very active | Platform completeness |
| OpenObserve | 21,511 | **AGPL-3.0** | Rust (single binary) | Parquet on S3 + SQLite metadata | Very active, $10M Series A | Single-binary shape (ideas only — AGPL) |
| Phoenix | ~11.1k | **ELv2 server**; Apache client/otel | Python server + React | SQLite default → Postgres | Very active; **Arize being acquired by Dynatrace (agreement announced Aug 2026)** — both AX and Phoenix stated to continue, no integration timeline | OTel/OpenInference conventions |
| OpenLLMetry | ~7.4k | Apache-2.0 | Python/TS instrumentation (no server) | — (exports OTLP to ~30 backends) | Active | Vendor-neutral OTLP lesson |
| Helicone | 6,106 | Apache-2.0 | TS (Next.js, Express, Workers in cloud) | Postgres + ClickHouse + MinIO | **Maintenance mode** since the Mintlify acquisition (announced 2026-03-03): security patches, new-model support, bug fixes only | Gateway capture mode (historical reference — **re-anchor live gateway comparisons to LiteLLM / OpenRouter / Cloudflare AI Gateway**, 2026-08-28) |
| Agenta | 4,568 | MIT + `ee/` | Python FastAPI + Next.js + Node runner | Postgres + Redis + S3 (R2 supported) | Active — **pivoted to coding-agent workspace** | Threat/validation |
| LangWatch | 3,514 | Apache-2.0 + `platform/app/ee/` | TS app + **Go gateway** + Python evals | ClickHouse (event-sourced v3) + S3 | Very active — **moving into coding agents** | **Threat** |
| OpenLIT | ~2.7k | Open-core (CI-enforced boundary) | **Go CLI** + Node UI + ClickHouse | ClickHouse (+ SQLite app state) | Active | **Closest structural neighbor** |
| Lunary | — | repo **deleted** (~Dec 2025) | TS/Bun | Postgres (via deleted ops repo) | **Dead OSS; SaaS continues** | Cautionary tale |

---

## 2. Per-project capsules (full detail in `docs/research/`)

- **Langfuse** (`01`) — flagship. OTLP/HTTP ingest is the contract (`langfuse.*`
  attrs over GenAI semconv); V4 is *observations-first*: trace attrs denormalized
  onto every span row, `trace_id` a correlation handle, immutability removed
  read-time dedup (−85% S3 cost). Prompts = immutable versions + mutable labels.
  Universal **scores** primitive. MCP server powers their in-app Assistant.
  Self-host = 6 containers / 16 GiB recommended.
- **Phoenix + DeepEval** (`02`) — eval tier. Phoenix: OpenInference span kinds
  (`LLM/AGENT/TOOL/GUARDRAIL/EVALUATOR`), evals as annotations, versioned
  datasets × experiments, pytest→dataset→experiment CI gate, remote MCP.
  DeepEval: library-first, cloud-optional; one metric contract
  (0–1 score + threshold + reason); span-level and trace-level evals; pinned
  `--official` baseline regression gating; ships `.claude-plugin` manifests.
- **Opik + OpenLIT + OpenLLMetry** (`03`) — Opik: Apache-2.0 *whole platform*;
  ingest-side dedup on batch endpoints; OLAP/ACID storage split; sandboxed
  out-of-process eval execution; one-command local UX (`opik.sh --verify/--stop`).
  **OpenLIT: a Go CLI hooking Claude Code/Codex/Cursor** with deterministic
  HMAC(sessionID) TraceIDs, session-state cache + flock, byte-capped transcript
  tails, emit-time capture tiers, and a coding-agent dashboard (cost/DORA/
  code-impact) — analytics only, no verification/continuity, float64 money.
  OpenLLMetry: 32 instrumentations → any of ~30 OTLP backends; cassette-replay
  test model; semconv contributed upstream.
- **Helicone + Lunary + Agenta + LangWatch** (`04`) — Helicone: zero-code
  gateway capture (baseURL swap), virtual keys/budgets/caching, hot-metadata vs
  blobs split; self-host parity drift warning. *(2026-08-28: Helicone is a
  **design reference, not a live roadmap** — maintenance mode since the
  Mintlify acquisition, 2026-03-03. Benchmark rows 6/7 against LiteLLM,
  OpenRouter and Cloudflare AI Gateway instead.)* **Lunary: repo deleted while the
  SaaS claims "self-hostable" — the trust-event of the category.** Agenta:
  pivoted to wrapping **Claude Code/Pi/Codex** harnesses in sandboxes with
  durable R2-backed workspaces and human-approval/per-tool permission gates.
  LangWatch: event-sourced v3, Go AI gateway, agent simulations, and shipping
  code-agent plugins/auth — the nearest-term competitive threat.
- **SigNoz + OpenObserve** (`05`) — storage/query references. SigNoz:
  30-minute `ts_bucket_start` leading ORDER BY, resource-fingerprint CTE
  pruning, typed attribute maps + runtime-promoted columns, derived exceptions
  index, dashboards/alerts-as-code (Terraform), traces-based scheduled-query
  alerts; MIT core / AGPL satellites / `ee/` fence. OpenObserve:
  WAL→memtable→immutable-parquet tiering on S3, SQLite metadata + file-list
  index (maps 1:1 to D1+R2), single binary <2 min, immutable-by-design
  marketing, **fail-open** Claude Code hook (our anti-pattern),
  **AGPL-3.0** (ideas only, never code).

---

## 3. Union feature-parity matrix

Legend — **Target**: `L` = local Go core, `C` = Cloudflare hosted tier.
**Phase**: P1–P4 (see `parity-plan.md`). ✅ = shipped today; a Phase cell
carrying prose instead of a phase label is a **dated re-scope** with its
rationale stated inline (rows 32, 54).

### 3.1 Capture & ingestion
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 1 | Native coding-agent adapters (Claude Code, Codex, Pi) + merge-safe idempotent hook install | ours (unique depth) | L | ✅ |
| 2 | OTLP/HTTP ingest (JSON **and** protobuf) — be an OTel *backend* (OpenLLMetry/OpenLIT/Phoenix/Claude-native data lands here) — **protobuf flavor ✅ local *and* hosted (2026-08-28): four-corner Go/TS × JSON/protobuf id parity, golden-fixture-proven (`testdata/fixtures/otlp/genai_session.pb`, `platform/test/otlp_proto.test.ts`)** — **semconv v1.37 mapping refresh ✅ (2026-08-28): `gen_ai.provider.name`, `gen_ai.conversation.id`, proto3 `arrayValue` spec fix** — **gRPC re-scoped out (2026-08-28):** Workers cannot terminate inbound gRPC, and the local single-binary posture keeps its 3 dependencies; protobuf-only emitters front a collector (`otlp` receiver → `otlphttp` exporter), per [`docs/otlp.md`](./otlp.md) | Langfuse, SigNoz, OpenObserve, OpenLLMetry | L + C | P1 ✅ |
| 3 | `handoffgraph.*` attribute namespace over `gen_ai.*` / `coding_agent.*` semconv + interop mappings + reserved-key sanitizer — **✅ (2026-08-28): OpenInference 10-kind coverage in both languages (EVALUATOR→GUARDRAIL, PROMPT→WORKFLOW folds documented at the case)** | Langfuse, OpenLIT, SigNoz | L + C | P1 ✅ |
| 4 | Batch ingest API with ingest-side dedup + backpressure semantics (429/retry, truncation markers) — **local ✅ (2026-08-28); hosted batch pending** | Opik, Langfuse | L + C | P1 ✅L / P3 |
| 5 | Native-vendor telemetry coalescing (`signal_source` precedence: native vs hook vs sdk) — **local ✅ (2026-08-28): `native > hook > sdk > import` coalescing, losing rows kept as shadow rows (never deleted), `--signal-source` / `--include-shadowed` filters on `sessions` and `query spans`** | OpenLIT, SigNoz | L | P2 ✅L |
| 6 | Proxy/gateway capture mode (OpenAI-compatible endpoint; zero-code baseURL swap) + virtual keys/budgets/rate limits — **✅ (2026-08-28): `vk_` virtual keys, budgets as exact decimal strings, KV rate limits, capture-to-spine events (OBSERVED), `POST/GET /v1/gateway/keys`; streaming rejected in v1 rather than silently buffered (dated re-scope — a buffered "stream" would fake a capability)** | Helicone, LangWatch, OpenRouter | C | P3 ✅ |
| 7 | Response caching + provider fallback/routing — **✅ (2026-08-28): opt-in R2 response cache (`gwcache/` prefix) + ordered provider fallbacks (max 3)** | Helicone, LangWatch | C | P3 ✅ |

### 3.2 Storage & query architecture
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 8 | Append-only immutable event spine; derive everything | ours (validated by Langfuse V4, OpenObserve, LangWatch v3) | L | ✅ |
| 9 | Wide denormalized observations read model (trace attrs on every row; trace_id = correlation handle) — **local ✅ + hosted ✅ (2026-08-28): D1 `span_observations` wide table (migration 0005) + first-class session tracking, `GET /v1/observations`, `GET /v1/sessions`, `POST /v1/admin/reindex`** | Langfuse V4 | L + C | P1 ✅L / C ✅ |
| 10 | Time-bucket indexed pruning (`ts_bucket`) on every hot query — **local ✅ + hosted ✅ (2026-08-28): 30-minute `ts_bucket` in D1, two-level prune (coarse bucket predicate → exact `started_at_ns`) on every hot read** | SigNoz, OpenObserve | L + C | P1 ✅L / C ✅ |
| 11 | Resource/session fingerprint pre-filter tables — **local ✅ + hosted ✅ (2026-08-28): D1 fingerprints + `GET /v1/fingerprints`** | SigNoz | L + C | P1 ✅L / C ✅ |
| 12 | Typed attribute maps + promoted indexed columns (`...$$key` + `_exists`) — **local ✅ (2026-08-28): promoted indexed columns + `_exists` markers, EXPLAIN-verified index use** | SigNoz | L + C | P2 ✅L |
| 13 | Derived exception groups (deterministic grouping hash) — **local ✅ (2026-08-28): `exception_groups` read model + `query exceptions`** | SigNoz | L | P2 ✅L |
| 14 | Object-store artifact tiering (compacted JSONL/parquet on R2) + D1 file-list index — **✅ (2026-08-28): R2 tiering + D1 `artifact_file_list` + cron compaction sweep (`*/5 * * * *`)** | OpenObserve, Helicone, Langfuse | C | P3 ✅ |
| 15 | Retention policies on derived models only — **spine never TTL'd** (documented) — **✅ (2026-08-28): `PUT /v1/retention`, sweep refuses `NEVER_RETAINED_TABLES` (spine + artifact index), rationale in [`docs/hosted-retention.md`](./hosted-retention.md)** | SigNoz, OpenObserve | C | P3 ✅ |

### 3.3 Session debugging & continuity (our core)
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 16 | Session → trace → observation hierarchy; sessions as the debugging unit | Langfuse, Phoenix | L | ✅ |
| 17 | Turn reconstruction, tool-call→file-diff→test correlation, git/worktree state | ours (unique) | L | ✅ |
| 18 | Verified checkpoints with provenance (OBSERVED/DECLARED/INFERRED) + evidence refs | ours — *product-unique, taxonomy not novel* (2026-08-28: GRADE, [arXiv 2606.22741](https://arxiv.org/abs/2606.22741) / [yzhao062/grade](https://github.com/yzhao062/grade), grades agent-graph edges with the same three terms academically) | L | ✅ |
| 19 | Cross-agent handoff graph + `continue`/`accept_handoff` acknowledgement loop | ours — *the **verified, acknowledged** loop is unique; agent→agent transfer is not* (see §4 competitive update, 2026-08-28) | L | ✅ |
| 20 | Local MCP stdio server; UI calls the same tools agents call | Langfuse (pattern), ours | L | ✅ → extend P2 |
| 21 | Remote/hosted MCP server over the same tool layer — **✅ (2026-08-28): `POST /v1/mcp` mirroring the local tool contract** | Langfuse, SigNoz, Opik, OpenObserve | C | P2 ✅ |
| 22 | Embedded debugger UI (trace tree, waterfall, detections) | ours | L | ✅ → extend P2–P3 |
| 23 | Fail-closed redaction + capture tiers (minimal/metadata/full) enforced at emit — **tiers ✅ (2026-08-28)** | ours (stricter than OpenLIT's best-effort tiers) | L | ✅ |

### 3.4 Evals & quality
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 24 | Universal **scores** primitive (numeric/categorical/bool; attach to trace/span/session; source-tagged) — **fully ✅ (2026-08-28): local CLI + MCP, debugger-UI `ScoresView`, hosted `GET /v1/scores`; the `llm_judge` INFERRED source now exists for real via hosted evals** | Langfuse, Phoenix | L + C | P1 ✅ |
| 25 | Deterministic code evaluators (no-LLM checks, verdicts as evidence) — **✅ via verify checks + detection pack (2026-08-28)** | Phoenix, DeepEval | L | P2 ✅ |
| 26 | CI regression gate: pinned baseline, cached results, exit-code semantics (`handoffgraph verify`) — **fully ✅ (2026-08-28): baseline + exit codes + result cache (migration 12, `cached: true` in the report, `--no-cache` forces recompute)** | DeepEval `--official`, Phoenix pytest | L | P2 ✅ |
| 27 | Versioned datasets (hash-pinned) × experiments + run comparison — **fully ✅ (2026-08-28): local CLI + debugger-UI `DatasetsView` with a compare panel + hosted `GET /v1/datasets`, `/v1/experiments`, `/v1/experiments/compare`** | Langfuse, Phoenix, Opik | L + C | P2 ✅ / P3 ✅ |
| 28 | Human annotation queues + scores via UI/MCP/API — **✅ (2026-08-28): claim/submit/skip → `score.recorded` with `source=human`; Durable Object live queue state with a D1 fallback path** | Langfuse, LangWatch, Phoenix | C | P3 ✅ |
| 29 | LLM-as-judge + online/cron evals (BYO keys; results always INFERRED-labelled) — **✅ (2026-08-28): 5 deterministic checks (`commands_ok`, `handoffs_acknowledged`, `tests_pass`, `tool_error_rate`, `traces_closed`) recorded OBSERVED `source=evaluation`, plus an LLM judge recorded INFERRED `source=llm_judge` on every path; BYO sealed provider keys; cron + manual triggers on a Workflows-durable contract with a resumable-step test** | Langfuse, Opik, Phoenix, DeepEval | C (Workflows + AI Gateway) | P3 ✅ |
| 30 | Prompt optimization loop (eval-driven) — **✅ minimal (2026-08-28): `POST /v1/prompt-optimizer/suggest` returns an INFERRED suggestion and *never* auto-applies — a version only reaches production through the normal gated label repoint** | DeepEval, LangWatch, Opik | C | P4 ✅ |
| 31 | Agent simulations (user-simulator + judge scenarios) — **✅ (2026-08-28): user-simulator + judge, verdicts INFERRED, durable run contract, content-addressed transcripts** | LangWatch Scenario | C | P4 ✅ |
| 32 | Benchmark suites against standard evals | DeepEval | L | **re-scoped 2026-08-28 — demand-gated, not built.** The plan marked this "(optional)" from day one; our deterministic evaluators + datasets × experiments already answer "did *this* agent regress", which is the question our users have. Standard-benchmark leaderboards are a different product. Revisit on real demand. |

### 3.5 Prompt management
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 33 | Prompts as immutable versions + mutable labels (production/latest/custom) — **fully ✅ (2026-08-28): local CLI + debugger-UI `PromptsView` + hosted `GET /v1/prompts`, `/v1/prompts/show`, gated `POST /v1/prompts/{name}/labels`** | Langfuse, Opik, Agenta | L + C | P2 ✅ / C ✅ |
| 34 | Prompt↔trace linkage (`which prompt version produced this session`) — **fully ✅ (2026-08-28): local + hosted reads over the same event payloads** | Langfuse | L + C | P2 ✅ / C ✅ |
| 35 | Prompt playground (variant diffing; replay traced calls) — **✅ (2026-08-28): `POST /v1/playground/run`, `GET /v1/playground/runs`.** *Phase note (2026-08-28): this matrix listed row 35 under P3 while `parity-plan.md` listed it under P4. It shipped 2026-08-28 in the P4 wave; **P4 is the correct phase** and both docs now say so.* | Phoenix, Langfuse, Opik | C + L(UI) | P4 ✅ |
| 36 | Prompt CI/CD: webhooks, GitHub Action, label-repoint rollback gated on eval scores — **✅ (2026-08-28): eval-gated label repoint + rollback, `.github/workflows/prompt-ci.yml.example`, outbound webhook on `prompt.labeled`** | Langfuse | C | P4 ✅ |

### 3.6 Analytics, dashboards, alerts
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 37 | Cost/token/latency analytics — **decimal-string money, recorded facts** (vs their float estimates) — **local rollups ✅ + hosted ✅ (2026-08-28): `GET /v1/analytics/series`, `GET /v1/analytics/summary`; D1 aggregates are the correctness source, Analytics Engine is a lossy best-effort mirror only** | all; ours is stricter | L + C | P1 ✅L / C ✅ |
| 38 | Coding-agent outcome analytics: code-impact (edits accepted/rejected), commits, PRs, DORA-style session outcomes — **core ✅ (2026-08-28); hosted half ✅ (2026-08-28) via `/v1/analytics/*`; edits accepted/rejected + commit/PR linkage still pending adapter events (2026-08-28) — the adapters do not emit acceptance events yet, so we will not synthesize them** | OpenLIT, SigNoz (Claude Code metrics) | L + C | P2 ✅ / C ✅ |
| 39 | Custom dashboards (widgets, variables, JSON import/export, share links) — **✅ (2026-08-28): dashboards CRUD + `recordIngestDataPoints` AE rollup mirror; dashboard data itself is D1-deterministic, never AE-sampled** | SigNoz, Langfuse, OpenObserve | C | P3 ✅ |
| 40 | Dashboards/alerts-as-config (versioned JSON in-repo; PR-reviewable) + CI dry-run — **✅ (2026-08-28): versioned immutable JSON, `POST /v1/dashboards/validate` CI dry-run, in-repo example `deploy/dashboards/coding-agent-overview.json`, share links (`POST /v1/dashboards/{id}/shares`, `GET /v1/shared/dashboards/{token}`)** | SigNoz (Terraform) | L + C | P3 ✅ |
| 41 | Alerts: scheduled-query/threshold/anomaly over read models; channels: webhook, Slack, email — **✅ (2026-08-28): alert rules + cron sweep evaluator + webhook/Slack/email channels** | SigNoz, OpenObserve, Langfuse | C (Cron + Workflows + Queues) | P3 ✅ |
| 42 | Trace funnels / conversion-style workflow analysis — **✅ (2026-08-28): `POST /v1/analytics/funnel` (sequential step matching over spans we already store)** | SigNoz | C | P4 ✅ |
| 43 | Alert history as append-only events (dogfooded in our own spine) — **✅ (2026-08-28): every firing appends `alert.fired` to the spine, so history inherits replay, export, retention-exemption and webhook delivery for free** | ours (better than their modules) | L + C | P3 ✅ |

### 3.7 Platform, API, governance
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 44 | Public REST API + OpenAPI spec + project-scoped pk/sk keys with edge-cached rejection — **✅ (2026-08-28): `pk_`/`sk_` keys, KV edge-cached rejection (property-tested: zero D1 queries on a repeat bad key), public `/api/v1/*` reads, OpenAPI 3.1 at `GET /api/v1/openapi.json` with a bidirectional completeness test (every route in the spec, every spec path routable)** | Langfuse, SigNoz, Opik | C | P2 ✅ |
| 45 | Orgs/projects/teams + RBAC (org-level OSS; fine-grained hosted) — **✅ (2026-08-28): workspace roles owner/admin/member/viewer, invites with hash-only tokens (the plaintext is shown once, never stored), seat accounting, last-owner protection enforced at the route *and* again in the schema, Team section on the account page** | Langfuse, Opik | C (D1) | P3 ✅ |
| 46 | Batch export to object storage + analytics-tool exports (PostHog-class) — **✅ (2026-08-28): `POST/GET /v1/exports` batch export to R2 + `GET /v1/exports/{id}/download`** | Langfuse, Helicone | C | P3 ✅ |
| 47 | Webhooks on events (prompts, handoffs, detections, alerts) — **✅ (2026-08-28): outbound delivery via Queues, HMAC-signed content-free summaries, sealed secrets, and a reconciliation sweep for stranded `queued` rows** | Langfuse, Helicone | C (Queues) | P3 ✅ |
| 48 | SSO / SCIM / audit logs / data masking (EE tier) — **fence + first features ✅ (2026-08-28); SCIM provisioning + masking-at-ingest pending.** The fence is real, not a label: `platform/ee/` with its own LICENSE, an `EE_ENABLED` flag where only the exact string `"true"` opens it, and an OSS-baseline-intact fence test. Shipped: SSO org binding, SCIM bearer token + `Users` (subset — no `PATCH`, no deprovisioning, no Groups), a complete masking rules engine, audit export. **Not yet wired:** `applyMaskingRules` is finished and fail-closed but nothing in `src/ingest.ts` calls it. | Langfuse EE, SigNoz EE, LangWatch EE | C | P4 ✅ partial |
| 49 | Tamper-evident audit trail — we get this from the hash-chained spine, free — **✅ (2026-08-28): hash-chained `team.*` events with `prev_hash` triggers enforcing the chain in-schema, surfaced by `GET /v1/workspace/audit` with a `chain_verified` field** | LangWatch EE sells this | L + C | P3 ✅ |
| 50 | Agent skills / plugin manifests so coding agents drive the product — **✅ (2026-08-28)** | DeepEval, SigNoz, Confident AI | L + C | P2 ✅ |
| 51 | In-product AI assistant over your telemetry (BYO model; answers INFERRED-labelled) — **✅ (2026-08-28): `POST /v1/assistant` answers over our *own* MCP tools, BYO model, every answer INFERRED and carrying `evidence_refs`** | Langfuse, OpenObserve, SigNoz Noz | C | P4 ✅ |
| 52 | One-command local UX with verify/stop/clean + clean reset — **✅ (2026-08-28): `doctor --verify` deep checks + a `reset` command whose `--hard` wipe fails closed without `--yes`** | Opik, LangWatch (`npx`) | L | P2 ✅ |
| 53 | Multimodal attachments direct-to-object-store — **✅ substrate-adjusted (2026-08-28):** content-addressed uploads stream *through* the Worker to R2 (`POST/GET /v1/attachments`, SHA-256 identity, dedup, 8 MiB cap) and append `attachment.recorded` to the spine. **Presigned direct-to-R2 re-scoped (2026-08-28):** it needs S3-compatible R2 account API keys, which this deployment does not hold; revisit when it does. | Langfuse | C (R2) | P4 ✅ |
| 54 | Embedding views / drift analysis | Phoenix | C | **re-scoped 2026-08-28 — demand-gated, not built.** The plan marked this "(optional)" and conditioned it on demand ("Vectorize if demand"). Nothing in our evidence model needs embeddings today, and shipping a drift view nobody asked for would add a vector store to a Cloudflare-only substrate for a hypothetical. Revisit on real demand. |
| 55 | Session replay (browser RUM) | OpenObserve | — | Out of scope (not our domain) |

**Coverage rule:** no matrix row may be dropped; re-scoping requires editing
this doc with rationale. Row 55 is the only explicit out-of-scope. Rows 32 and
54 are **demand-gated re-scopes** (dated above, both "(optional)" in the plan
from the start); gRPC (row 2) and presigned direct-to-R2 (row 53) are
**substrate re-scopes** with the rationale recorded in their cells.

**Status as of 2026-08-28:** every row 1–54 is either ✅ shipped behind a
tested gate or carries a dated re-scope rationale above. The residual
*pending* tails, stated plainly rather than hidden behind a checkmark: hosted
batch backpressure (row 4), edits-accepted/rejected + commit/PR linkage
awaiting adapter events (row 38), and SCIM provisioning + masking-at-ingest
(row 48).

---

## 4. What none of them do (our moat — press hard)

1. **Verification**: hash-chained append-only evidence, deterministic reducers
   with reproducible root hashes, idempotent re-import, provenance taxonomy.
   Their unit of trust is "the SDK said so"; ours is "the evidence says so."
2. **Verified cross-agent continuity**: workstreams joining Claude Code ↔ Codex
   ↔ Pi sessions, evidence-based checkpoints, verified handoffs with drift
   checks and *machine acknowledgement* (`accept_handoff` records what the
   receiving agent accepted, missed, or could not verify).
   **Nobody ships verified, evidence-provenance cross-agent continuity.**
   *(Do not say "nobody models agent→agent handoff at all" — that claim went
   false on 2026-08-07; see §4.1.)*
3. **Fail-closed redaction**: competitors are opt-in-knob (SigNoz), best-effort
   (OpenObserve's fail-open hook), or paid-EE (Langfuse). Refuse-to-export is ours.
4. **Local-first single binary**: pure-Go SQLite + embedded UI + MCP stdio —
   no ClickHouse, no Docker fleet, works offline; hosted tier never leaks
   backward into local requirements (the Helicone/Agenta failure mode).
5. **Decimal-string money + recorded cost facts** vs their query-time float
   estimates (OpenLIT documented `$NaN`/100× bugs; SigNoz: "for billing, refer
   to your Anthropic Console").

### 4.1 Competitive update — 2026-08-28 (the moat claim, corrected)

The old §4 item 2 wording ("Nobody models agent→agent handoff at all") is **now
false as literally stated**, and a reviewer, journalist, or competitor could
disprove it with one link. It is retired here, not softened away: the
*defensible* claim is that nobody ships **verified, evidence-provenance
cross-agent continuity**. What changed, with sources:

**A major lab now moves session state agent-to-agent in production.**
OpenAI's Codex CLI shipped `/import` of Claude Code *and* Cursor sessions in
v0.145 (~2026-07-24), and **v0.147.0 (2026-08-07)** added *ongoing sync* of
imported Claude/Cursor conversations without duplicates
([release notes](https://github.com/openai/codex/releases/tag/rust-v0.147.0)).
It is one-directional (migration is *into* Codex; v0.148.0 later added an
`/export` of TUI chats to Markdown, which is transcript export, not session
migration back out), window-limited, and carries **zero verification,
evidence, or provenance semantics**. That gap is exactly our claim — but the
mere *existence* of agent→agent transfer is no longer ours to claim.

**Open-source pitch-alikes now own the word "handoff".** None of them are
verified or evidence-grade, but all of them dilute the category claim and the
name in search:

- **PROJECTMEM** — MIT, local-first append-only typed-event log with
  deterministic MCP-served projections across Claude Code / Cursor /
  Antigravity / Codex; the closest architectural doppelganger found.
  [arXiv 2606.12329](https://arxiv.org/abs/2606.12329) ·
  [riponcm/projectmem](https://github.com/riponcm/projectmem).
  Lacks: provenance labels, hash-chained tamper evidence, OTLP, hosted tier,
  and any accept/reject acknowledgement loop.
- **[akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory)** —
  explicitly "facilitate handoff between different agent vendors", unusually
  long agent list including Pi. No verification, no evidence.
- **[authsec-ai/authsec-bridge](https://github.com/authsec-ai/authsec-bridge)**
  — "stop re-explaining" bridge across Claude/Codex/Gemini. No verification.
- **[OpenMOSS/claude-codex-handoff](https://github.com/OpenMOSS/claude-codex-handoff)**
  — file-based `.handoff/` protocol for Claude Code + Codex. No verification.

**Our provenance taxonomy has academic prior art.** **GRADE**
([arXiv 2606.22741](https://arxiv.org/abs/2606.22741) ·
[yzhao062/grade](https://github.com/yzhao062/grade)) grades every dependency
edge in an LLM-agent execution graph as exactly *observed, declared, or
inferred* — our three terms — and its execution layer even carries a literal
`handoff_to` edge type, validated on coding-agent corpora. It is a paper, not
a product; the shipping CLI that applies the taxonomy to cross-agent
checkpoints is still, as far as this research found, a first. But **rows 18
and 19 no longer say "ours (unique)" unqualified** — see the matrix.

**Same-vendor continuity is now table stakes, which narrows the pitch (and
sharpens it).** Claude Code `--teleport`/`/rewind`, Cursor Cloud Handoff,
GitHub Copilot `/chronicle`, and Google Antigravity Knowledge Items all ship
continuity *within one vendor*. None is cross-vendor; none is evidence-
verified. The honest framing is no longer "agents have zero continuity" but
**"agents have same-vendor continuity; cross-vendor *verified* continuity is
the gap"** — narrower, still ours, and much harder to falsify.

**Platform risk to watch:** Anthropic keeps absorbing adjacent primitives
(Agent SDK memory stores, `/rewind` checkpoints, `--teleport`). The substrate
a third-party continuity tool needs increasingly ships free, one layer down,
from the vendor whose CLI we instrument. Our answer stays the same: they ship
*convenience*; we ship *evidence you can check*.

**Scope note for whoever next edits this file:** §§1–3 are scoped to
LLM/agent *observability* platforms. The cross-agent-handoff-specific
competitive set above lives almost entirely outside that scope and is not
represented in `docs/research/01..05`. Treat this subsection as its own
research lane.

## 5. Threat watch (live risks to our position)

| Threat | Why it matters | Our counter |
|---|---|---|
| **LangWatch** | Event-sourced spine + Go gateway + shipping code-agent plugins/auth NOW | Own *verified* continuity they can't copy cheaply; parity items 24–26 fast |
| **Agenta** | Wraps Claude Code/Pi/Codex as harnesses w/ approval gates + R2 workspaces | They run agents; we verify them — partner posture, not feature war |
| **OpenLIT** | Already a Go CLI on coding-agent hooks with dashboards | Beat on verification/debugging/continuity + fail-closed redaction; keep OTLP interop so their data lands in us too |
| **SigNoz/OpenObserve** | 46/~70 LLM integrations incl. Claude Code/Codex dashboards | They're generic; coding-agent semantics + evidence + handoff graph stay ours |
| **Lunary precedent** | OSS repo deleted while SaaS lives | Keep Apache-2.0, deploy defs in-repo, publish real releases — trust as feature |
| **OpenAI Codex CLI** *(added 2026-08-28)* | Ships one-directional import **+ ongoing sync** of Claude Code/Cursor sessions since v0.147.0 (2026-08-07) — a lab, not a startup, doing cross-agent session portability | It moves *text*; we move *checked evidence* with drift detection and an acknowledgement loop. Never claim handoff-as-a-category again — claim verification |
| **PROJECTMEM / ai-memory / authsec-bridge / claude-codex-handoff** *(added 2026-08-28)* | OSS, cross-agent, free, already own the word "handoff" in GitHub topics and search | Verification, provenance, hash-chained tamper evidence, OTLP interop and the hosted tier are all outside what any of them do — lead with those, not with "handoff" |
| **Helicone → Mintlify** *(re-anchored 2026-08-28)* | Helicone is in maintenance mode; its ~16k-org base is being migrated by third-party guides | Stop benchmarking our gateway (rows 6/7) against Helicone's roadmap — the live comparison set is **LiteLLM, OpenRouter, Cloudflare AI Gateway** |

## 6. Licensing rules of engagement (Apache-2.0 project)

- **Safe to learn/cite**: Langfuse (MIT core), SigNoz core (MIT), DeepEval,
  Opik, OpenLLMetry, Helicone, LangWatch floor (Apache-2.0), Agenta (MIT core).
- **Ideas only, never code/derivative config**: OpenObserve (AGPL-3.0 — §13
  network copyleft would reach our hosted tier), SigNoz `signoz-otel-collector`
  + `foundry` (AGPL), Phoenix server (**ELv2** — no competing managed service
  from their code), all `ee/` directories anywhere.
- If we ever gate hosted code: directory fence + separate LICENSE + separate
  build target (the SigNoz/Langfuse pattern), never license soup.
- OTel GenAI semconv / OpenInference specs are explicitly adoptable.

## 7. Hands-on test runbook (for studying each stack)

Light → heavy; each was verified from official docs (details in research files):

```bash
# DeepEval (library, ~2 min)      pip install -U deepeval && deepeval test run ... && deepeval view
# Phoenix (SQLite server)         pip install arize-phoenix && phoenix serve          # :6006, OTLP :4317
# OpenLLMetry (instrumentation)   pip install traceloop-sdk && Traceloop.init(disable_batch=True)
# OpenObserve (single binary)     docker run -p 5080:5080 public.ecr.aws/zinclabs/openobserve:latest + ZO_ROOT_USER_*
# SigNoz (foundry)                curl -fsSL https://signoz.io/foundry.sh | bash && foundryctl cast -f casting.yaml
# OpenLIT (UI + ClickHouse)       git clone OpenLIT/OpenLIT && docker compose up -d   # :3000; openlit coding install --vendor=all
# LangWatch (npx one-command)     npx @langwatch/server                               # :5560
# Langfuse (6 containers)         git clone langfuse/langfuse && docker compose up    # 4C/16GB, edit # CHANGEME secrets
# Opik (8 containers)             git clone comet-ml/opik && ./opik.sh --verify
# Helicone (6 services)           docker && ./helicone-compose.sh helicone up         # note unauth :8585 proxy
# Agenta (compose + FUSE)         sparse clone + docker-compose.gh.yml (needs /dev/fuse, docker.sock)
```

Testing focus per stack: ingest its OTLP/samples into our P1 endpoint; compare
trace models against our materializer; record UX gaps in this doc's matrix.

---

*Sources: primary repos/docs/APIs as catalogued in `docs/research/01..05`.
Star counts are 2026-08-27/28 snapshots. Corrections land in this file with a
note in the research file they amend.*
