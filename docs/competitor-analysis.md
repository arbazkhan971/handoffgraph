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
| Langfuse | 33,817 | MIT + `ee/` | TS (Next.js web, Express worker) | ClickHouse + Postgres + Redis + S3 | Acquired by ClickHouse 2026-01; V4 rewrite | Features |
| SigNoz | 31,949 | MIT core; AGPL collector/foundry; `ee/` | Go (single bundled binary) + OTel collector | ClickHouse (+ SQLite/PG metadata) | Very active | Go backend patterns |
| DeepEval | ~17.5k | Apache-2.0 | Python library (no server) | local `.deepeval/` artifacts | Very active | Library-first model |
| Opik | 21,577 | Apache-2.0 (full platform in-repo) | Java + Flask + React | ClickHouse + MySQL + Redis + MinIO | Very active | Platform completeness |
| OpenObserve | 21,511 | **AGPL-3.0** | Rust (single binary) | Parquet on S3 + SQLite metadata | Very active, $10M Series A | Single-binary shape (ideas only — AGPL) |
| Phoenix | ~11.1k | **ELv2 server**; Apache client/otel | Python server + React | SQLite default → Postgres | Very active | OTel/OpenInference conventions |
| OpenLLMetry | ~7.4k | Apache-2.0 | Python/TS instrumentation (no server) | — (exports OTLP to ~30 backends) | Active | Vendor-neutral OTLP lesson |
| Helicone | 6,106 | Apache-2.0 | TS (Next.js, Express, Workers in cloud) | Postgres + ClickHouse + MinIO | Active (YC W23) | Gateway capture mode |
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
  blobs split; self-host parity drift warning. **Lunary: repo deleted while the
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
**Phase**: P1–P4 (see `parity-plan.md`). ✅ = shipped today.

### 3.1 Capture & ingestion
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 1 | Native coding-agent adapters (Claude Code, Codex, Pi) + merge-safe idempotent hook install | ours (unique depth) | L | ✅ |
| 2 | OTLP/HTTP(+gRPC) ingest — be an OTel *backend* (OpenLLMetry/OpenLIT/Phoenix/Claude-native data lands here) — **local ✅ + hosted converter ✅ w/ Go-parity ids (2026-08-28); route wiring pending** | Langfuse, SigNoz, OpenObserve, OpenLLMetry | L + C | P1 ✅L |
| 3 | `handoffgraph.*` attribute namespace over `gen_ai.*` / `coding_agent.*` semconv + interop mappings + reserved-key sanitizer | Langfuse, OpenLIT, SigNoz | L + C | P1 |
| 4 | Batch ingest API with ingest-side dedup + backpressure semantics (429/retry, truncation markers) — **local ✅ (2026-08-28); hosted batch pending** | Opik, Langfuse | L + C | P1 ✅L / P3 |
| 5 | Native-vendor telemetry coalescing (`signal_source` precedence: native vs hook vs sdk) | OpenLIT, SigNoz | L | P2 |
| 6 | Proxy/gateway capture mode (OpenAI-compatible endpoint; zero-code baseURL swap) + virtual keys/budgets/rate limits | Helicone, LangWatch, OpenRouter | C | P3 |
| 7 | Response caching + provider fallback/routing | Helicone, LangWatch | C | P3 |

### 3.2 Storage & query architecture
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 8 | Append-only immutable event spine; derive everything | ours (validated by Langfuse V4, OpenObserve, LangWatch v3) | L | ✅ |
| 9 | Wide denormalized observations read model (trace attrs on every row; trace_id = correlation handle) — **local ✅ (2026-08-28)** | Langfuse V4 | L + C | P1 ✅L / C P3 |
| 10 | Time-bucket indexed pruning (`ts_bucket`) on every hot query — **local ✅ (2026-08-28)** | SigNoz, OpenObserve | L + C | P1 ✅L / C P3 |
| 11 | Resource/session fingerprint pre-filter tables — **local ✅ (2026-08-28)** | SigNoz | L + C | P1 ✅L / AE P3 |
| 12 | Typed attribute maps + promoted indexed columns (`...$$key` + `_exists`) | SigNoz | L + C | P2 |
| 13 | Derived exception groups (deterministic grouping hash) | SigNoz | L | P2 |
| 14 | Object-store artifact tiering (compacted JSONL/parquet on R2) + D1 file-list index | OpenObserve, Helicone, Langfuse | C | P3 |
| 15 | Retention policies on derived models only — **spine never TTL'd** (documented) | SigNoz, OpenObserve | C | P3 |

### 3.3 Session debugging & continuity (our core)
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 16 | Session → trace → observation hierarchy; sessions as the debugging unit | Langfuse, Phoenix | L | ✅ |
| 17 | Turn reconstruction, tool-call→file-diff→test correlation, git/worktree state | ours (unique) | L | ✅ |
| 18 | Verified checkpoints with provenance (OBSERVED/DECLARED/INFERRED) + evidence refs | ours (unique) | L | ✅ |
| 19 | Cross-agent handoff graph + `continue`/`accept_handoff` acknowledgement loop | ours (unique) | L | ✅ |
| 20 | Local MCP stdio server; UI calls the same tools agents call | Langfuse (pattern), ours | L | ✅ → extend P2 |
| 21 | Remote/hosted MCP server over the same tool layer | Langfuse, SigNoz, Opik, OpenObserve | C | P2 |
| 22 | Embedded debugger UI (trace tree, waterfall, detections) | ours | L | ✅ → extend P2–P3 |
| 23 | Fail-closed redaction + capture tiers (minimal/metadata/full) enforced at emit — **tiers ✅ (2026-08-28)** | ours (stricter than OpenLIT's best-effort tiers) | L | ✅ |

### 3.4 Evals & quality
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 24 | Universal **scores** primitive (numeric/categorical/bool; attach to trace/span/session; source-tagged) — **local ✅ (CLI + MCP, 2026-08-28)** | Langfuse, Phoenix | L + C | P1 ✅L / C P3 |
| 25 | Deterministic code evaluators (no-LLM checks, verdicts as evidence) — **✅ via verify checks + detection pack (2026-08-28)** | Phoenix, DeepEval | L | P2 ✅ |
| 26 | CI regression gate: pinned baseline, cached results, exit-code semantics (`handoffgraph verify`) — **✅ baseline+exit codes (2026-08-28); caching pending** | DeepEval `--official`, Phoenix pytest | L | P2 ✅/partial |
| 27 | Versioned datasets (hash-pinned) × experiments + run comparison — **local CLI ✅ (2026-08-28); UI pending** | Langfuse, Phoenix, Opik | L + C | P2 ✅L / P3 |
| 28 | Human annotation queues + scores via UI/MCP/API | Langfuse, LangWatch, Phoenix | C | P3 |
| 29 | LLM-as-judge + online/cron evals (BYO keys; results always INFERRED-labelled) | Langfuse, Opik, Phoenix, DeepEval | C (Workflows + AI Gateway) | P3 |
| 30 | Prompt optimization loop (eval-driven) | DeepEval, LangWatch, Opik | C | P4 |
| 31 | Agent simulations (user-simulator + judge scenarios) | LangWatch Scenario | C | P4 |
| 32 | Benchmark suites against standard evals | DeepEval | L | P4 (optional) |

### 3.5 Prompt management
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 33 | Prompts as immutable versions + mutable labels (production/latest/custom) — **local ✅ (2026-08-28)** | Langfuse, Opik, Agenta | L + C | P2 ✅L / C P3 |
| 34 | Prompt↔trace linkage (`which prompt version produced this session`) — **local ✅ (2026-08-28)** | Langfuse | L + C | P2 ✅L / C P3 |
| 35 | Prompt playground (variant diffing; replay traced calls) | Phoenix, Langfuse, Opik | C + L(UI) | P3 |
| 36 | Prompt CI/CD: webhooks, GitHub Action, label-repoint rollback gated on eval scores | Langfuse | C | P4 |

### 3.6 Analytics, dashboards, alerts
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 37 | Cost/token/latency analytics — **decimal-string money, recorded facts** (vs their float estimates) — **local rollups ✅ (2026-08-28)** | all; ours is stricter | L + C | P1 ✅L / C P3 |
| 38 | Coding-agent outcome analytics: code-impact (edits accepted/rejected), commits, PRs, DORA-style session outcomes — **core ✅ (2026-08-28); acceptance/PR linkage pending adapter events** | OpenLIT, SigNoz (Claude Code metrics) | L + C | P2 |
| 39 | Custom dashboards (widgets, variables, JSON import/export, share links) | SigNoz, Langfuse, OpenObserve | C | P3 |
| 40 | Dashboards/alerts-as-config (versioned JSON in-repo; PR-reviewable) + CI dry-run | SigNoz (Terraform) | L + C | P3 |
| 41 | Alerts: scheduled-query/threshold/anomaly over read models; channels: webhook, Slack, email | SigNoz, OpenObserve, Langfuse | C (Cron + Workflows + Queues) | P3 |
| 42 | Trace funnels / conversion-style workflow analysis | SigNoz | C | P4 |
| 43 | Alert history as append-only events (dogfooded in our own spine) | ours (better than their modules) | L + C | P3 |

### 3.7 Platform, API, governance
| # | Feature | Provenance | Target | Phase |
|---|---|---|---|---|
| 44 | Public REST API + OpenAPI spec + project-scoped pk/sk keys with edge-cached rejection | Langfuse, SigNoz, Opik | C | P2 |
| 45 | Orgs/projects/teams + RBAC (org-level OSS; fine-grained hosted) | Langfuse, Opik | C (D1) | P3 |
| 46 | Batch export to object storage + analytics-tool exports (PostHog-class) | Langfuse, Helicone | C | P3 |
| 47 | Webhooks on events (prompts, handoffs, detections, alerts) | Langfuse, Helicone | C (Queues) | P3 |
| 48 | SSO / SCIM / audit logs / data masking (EE tier) | Langfuse EE, SigNoz EE, LangWatch EE | C | P4 |
| 49 | Tamper-evident audit trail — we get this from the hash-chained spine, free | LangWatch EE sells this | L + C | P3 (market it) |
| 50 | Agent skills / plugin manifests so coding agents drive the product — **✅ (2026-08-28)** | DeepEval, SigNoz, Confident AI | L + C | P2 ✅ |
| 51 | In-product AI assistant over your telemetry (BYO model; answers INFERRED-labelled) | Langfuse, OpenObserve, SigNoz Noz | C | P4 |
| 52 | One-command local UX with verify/stop/clean + clean reset | Opik, LangWatch (`npx`) | L | P2 |
| 53 | Multimodal attachments direct-to-object-store | Langfuse | C (R2) | P4 |
| 54 | Embedding views / drift analysis | Phoenix | C | P4 (optional) |
| 55 | Session replay (browser RUM) | OpenObserve | — | Out of scope (not our domain) |

**Coverage rule:** no matrix row may be dropped; re-scoping requires editing
this doc with rationale. Rows 55 is the only explicit out-of-scope.

---

## 4. What none of them do (our moat — press hard)

1. **Verification**: hash-chained append-only evidence, deterministic reducers
   with reproducible root hashes, idempotent re-import, provenance taxonomy.
   Their unit of trust is "the SDK said so"; ours is "the evidence says so."
2. **Cross-agent continuity**: workstreams joining Claude Code ↔ Codex ↔ Pi
   sessions, evidence-based checkpoints, verified handoffs with drift checks and
   machine acknowledgement. Nobody models agent→agent handoff at all.
3. **Fail-closed redaction**: competitors are opt-in-knob (SigNoz), best-effort
   (OpenObserve's fail-open hook), or paid-EE (Langfuse). Refuse-to-export is ours.
4. **Local-first single binary**: pure-Go SQLite + embedded UI + MCP stdio —
   no ClickHouse, no Docker fleet, works offline; hosted tier never leaks
   backward into local requirements (the Helicone/Agenta failure mode).
5. **Decimal-string money + recorded cost facts** vs their query-time float
   estimates (OpenLIT documented `$NaN`/100× bugs; SigNoz: "for billing, refer
   to your Anthropic Console").

## 5. Threat watch (live risks to our position)

| Threat | Why it matters | Our counter |
|---|---|---|
| **LangWatch** | Event-sourced spine + Go gateway + shipping code-agent plugins/auth NOW | Own *verified* continuity they can't copy cheaply; parity items 24–26 fast |
| **Agenta** | Wraps Claude Code/Pi/Codex as harnesses w/ approval gates + R2 workspaces | They run agents; we verify them — partner posture, not feature war |
| **OpenLIT** | Already a Go CLI on coding-agent hooks with dashboards | Beat on verification/debugging/continuity + fail-closed redaction; keep OTLP interop so their data lands in us too |
| **SigNoz/OpenObserve** | 46/~70 LLM integrations incl. Claude Code/Codex dashboards | They're generic; coding-agent semantics + evidence + handoff graph stay ours |
| **Lunary precedent** | OSS repo deleted while SaaS lives | Keep Apache-2.0, deploy defs in-repo, publish real releases — trust as feature |

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
