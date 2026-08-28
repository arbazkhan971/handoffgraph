# Research: Opik vs OpenLIT vs OpenLLMetry — capability & gap analysis inputs for HandoffGraph

*Researched Aug 2026 from GitHub repos (API + cloned trees), official docs (comet.com/docs/opik, docs.openlit.io, traceloop.com/docs), and registry stats. Star counts are point-in-time snapshots.*

## Summary

- **Opik (Comet)** is a full self-hostable LLM observability/eval platform under Apache-2.0 — the claim checks out: the entire platform (Java 25+Dropwizard API, Flask evaluator service, React UI, ClickHouse/MySQL/Redis/MinIO datastores, docker-compose + Helm) lives in the public repo. It does NOT trace coding-agent CLIs, and its evals are LLM-as-judge (nondeterministic, LLM-costed).
- **OpenLIT** is the closest structural neighbor to HandoffGraph: it now ships a **Go CLI that hooks Claude Code, Cursor, Codex (and Windsurf)** and emits OTel traces under `gen_ai.*` + `coding_agent.*` conventions to any OTLP backend, with deterministic per-session TraceIDs, emit-time redaction gating, and a ClickHouse-backed UI. It is observability/analytics only — **no verification, no integrity model, no cross-agent continuity**.
- **OpenLLMetry (Traceloop)** is pure vendor-neutral OTel instrumentation (32 Python packages + a thin SDK + a JS repo) that can be pointed at ~30 backends; it has no storage/UI/eval of its own. Its "point at any backend" claim is real and is the cheapest interoperability lesson for HandoffGraph: **accept standard OTLP and you become a destination for all of these ecosystems' data**.

---

# Report 1 of 3 — Opik by Comet

## 1. Position & pitch
- **What**: "Open-source LLM observability and evaluation platform for AI agent tracing, LLM evaluation, prompt management, and production monitoring." Covers the full LLM app lifecycle: dev tracing → datasets/experiments → production monitoring/online eval. [GitHub README](https://github.com/comet-ml/opik)
- **Who**: Built by [Comet](https://www.comet.com) (the ML experiment-tracking company); Opik is their flagship OSS bet, "battle-tested in Comet's managed cloud." 20,000+ stars claimed in README; 21,577 per GitHub API at research time.
- **Value prop**: "Apache-2.0 licensed, free to self-host the full platform"; designed for scale (40M+ traces/day); same codebase as the hosted product.

## 2. Architecture (verified from official self-host docs)
⚠️ The task's assumption "Python FastAPI" is **wrong** — verified against [Platform Architecture docs](https://www.comet.com/docs/opik/self-host/architecture):
- **Java backend (main API)**: Java 25 + Dropwizard — REST API, auth (workspace-scoped), business logic, Liquibase migrations for both MySQL and ClickHouse. R2DBC→ClickHouse, JDBI→MySQL, Redisson→Redis. Guava AsyncEventBus + virtual threads in-process; Redis Streams for distributed async (online scoring, experiment aggregation). Code: `apps/opik-backend`.
- **Python backend (secondary)**: **Flask + Gunicorn** (not FastAPI) — evaluator execution in sandboxed subprocesses (timeouts, memory caps, network isolation), Optimization Studio workflows, RQ (Redis Queue) background jobs. Code: `apps/opik-python-backend`.
- **Frontend**: TypeScript + React SPA (Vite, TanStack Router/Query, Zustand), served by **Nginx** which also reverse-proxies `/api/*` to the Java backend (port 8080), incl. WebSocket upgrades. Code: `apps/opik-frontend`.
- **SDKs**: Python (httpx; message-queue batch manager, memory-capped 50MB batches, exponential backoff 0.5–10s) and TypeScript (fetch; debounce 300ms / 100 items) hitting bulk endpoints (`POST /v1/private/traces/batch`, `/spans/batch`). Code: `sdks/python`, `sdks/typescript`.
- **Datastores**:
  - **ClickHouse** — traces, spans, feedback scores, experiment items, dataset items. **Async inserts with configurable batching and deduplication** (ingest-side idempotency). Altinity operator + ZooKeeper in k8s.
  - **MySQL** — ACID data: workspaces, projects, dataset/prompt definitions, feedback definitions, automation rules.
  - **Redis** — cache, distributed locks, token-bucket rate limiting, Streams (consumer groups with message claiming for fault tolerance), RQ job queue bridging Java↔Python.
  - **MinIO** (S3-compatible) — attachments, dataset file uploads, artifacts, custom eval code.
- **Deployment**: `deployment/docker-compose` with profiles: infrastructure (always: MySQL, Redis, ClickHouse, ZooKeeper, MinIO), `backend` (+Python backend), `opik` (full suite), `guardrails` (opt-in guardrails services). Single launcher scripts `opik.sh` (bash, 28KB) / `opik.ps1` (PowerShell, 30KB). Kubernetes via Helm chart "designed to be highly configurable and battle-tested in Comet's managed cloud." Containers run as non-root.
- **Platform self-observability**: OTel instrumentation on all three app services; optional OTel Collector → Jaeger/Grafana.

## 3. Feature inventory (OSS vs paid)
**OSS (self-host, Apache-2.0)** — [FAQ](https://www.comet.com/docs/opik/faq.mdx) + README:
- Tracing: traces/spans with full trace trees for multi-step agents and tool calls, conversation/threads, feedback-score annotation (SDK or UI).
- Evals: datasets, experiments, **advanced experiment comparison UI**; **LLM-as-judge metrics** — hallucination detection, moderation, answer relevance, context precision/recall, groundedness (all require LLM calls); custom Python evaluators (sandboxed Python backend); PyTest CI/CD integration.
- Production: dashboards (feedback, trace counts, token usage), **online evaluation rules** (LLM-judge scoring of live traffic via Redis Streams consumer groups).
- Prompt: Prompt Hub (management + versioning), Prompt Playground.
- Opik Agent Optimizer SDK; Opik Guardrails (own docker-compose profile ⇒ OSS).
- Integrations (per FAQ): 18 model providers (OpenAI, Anthropic, Bedrock, Gemini, Groq, Mistral, Ollama, WatsonX, xAI…), 23 agent/LLM frameworks (LangChain/py+js, LangGraph, LlamaIndex, CrewAI, Autogen/AG2, OpenAI Agents, Google ADK, DSPy, Haystack, Smolagents, Strands, Mastra, Spring AI…), Ragas, gateways (LiteLLM, OpenRouter, AISuite), no-code (Dify, Flowise), OTel (Python & Ruby SDK ingestion), Guardrails AI.
- **MCP**: official `comet-ml/opik-mcp` server (separate repo, TypeScript, ~204 stars, Apache-2.0, PyPI `opik-mcp`) — read traces, log scores, manage prompts from Claude Code/Cursor/VS Code, plus "Ask Ollie" AI assistant.
**Paid (Opik Cloud / Enterprise)**: hosting, **user management, billing, support** (FAQ's explicit delta vs OSS). Free cloud tier is rate-limited (2,000 req/min/user; 10K events/min/user ingestion; 30 req/min search/export endpoints) and capped (span quotas, 60-day data retention per third-party pricing summary [apis.io](https://apis.io/plans/opik/opik-plans-pricing/) — retention not re-verified on comet.com).

## 4. Integration surface
- SDK languages: **Python (most complete), TypeScript**; everything else via REST API. No Go SDK.
- Ingest: proprietary REST batch API (primary) + OTel ingestion documented for Python/Ruby SDKs.
- Not an OTel-first product: the SDK protocol is Opik-specific batching, not OTLP.

## 5. Traction
- 21,577 stars / 1,723 forks; repo created 2023-05-10; ~214 open issues; enormous CI matrix (per-lib integration workflows for 25+ frameworks, multi-locale README).
- PyPI `opik`: **~3.28M downloads/month** ([pypistats](https://pypistats.org/packages/opik)); ~6.1M lifetime per PyRank (older snapshot).
- Passes "12K stars in first year" per [Agentic Index review](https://agenticindex.io/vendors/opik).

## 6. Local runbook (verified)
```bash
git clone https://github.com/comet-ml/opik.git
cd opik
./opik.sh                 # full suite (opik.ps1 on Windows)
./opik.sh --infra         # only MySQL/Redis/ClickHouse/ZK/MinIO
./opik.sh --backend       # infra + Java/Python backends
./opik.sh --guardrails    # add guardrails services
./opik.sh --build --verify --stop --clean --help   # build from source / healthcheck / teardown
# UI: http://localhost:5173
```
SDK side:
```bash
pip install opik
opik configure            # set url_override=http://localhost:5173/api for self-host
opik healthcheck          # diagnose config + backend connectivity
```

## 7. Top 5 lessons for HandoffGraph
1. **Ingest-side dedup, not just at-rest idempotency**: ClickHouse async inserts "with configurable batching and deduplication" + deterministic batch endpoints. HandoffGraph's deterministic derived event IDs already do this at rest — mirror the pattern in any OTLP/HTTP intake path so replays are free.
2. **Split storage by access pattern**: Opik separates OLAP (ClickHouse) from ACID (MySQL). Our analog with pure-Go SQLite: keep the append-only event spine sacred and push all analytics into derived, rebuildable read models (we already do) — never let dashboard queries touch the spine.
3. **SDK batching/backpressure is a first-class feature**: memory-capped batches, debouncing, exponential backoff, explicit 429 handling with "ingestion rate limited, retrying in 55s" UX, per-field truncation with markers + 413 rejection with guidance. Our (future) Workers/D1 ingest and any exporter should specify these semantics exactly.
4. **One-command local UX**: `./opik.sh --verify/--stop/--clean` with compose healthchecks and one proxied port for UI+API is why people actually self-host. `handoffgraph serve` should hit the same bar (healthcheck subcommand, verify, clean, single port, embedded UI).
5. **Eval execution is a separate sandboxed process** (Flask service, subprocess with timeout/memory/network caps). If HandoffGraph ever adds evals, keep them out-of-process — and keep our differentiator: evidence checks that are deterministic and LLM-free stay in-process.
- (Bonus) **opik-mcp exists** — "has an MCP server" is table stakes now; our MCP differentiation must be *evidence-verified session debugging tools*, not MCP per se.

## 8. What they DON'T do (openings for HandoffGraph)
- **No coding-agent ingestion**: no Claude Code / Codex / Cursor hook or transcript adapters; "agents" are traced only via framework SDKs inside *your* app. The AI-coding-agent session domain is unaddressed.
- **No local-first footprint**: ~8 containers (MySQL, ClickHouse, ZooKeeper, Redis, MinIO, 2 backends, Nginx/UI) vs our single Go binary + SQLite.
- **No integrity/verification model**: traces are trusted writes; no hash chaining, no deterministic-reducer proofs, no "verify this checkpoint reproduces" story. Our core thesis is absent.
- **Evals are LLM-as-judge**: nondeterministic, costs LLM calls, and can't serve as evidence. Nothing does no-LLM verification of agent behavior.
- **No cross-agent continuity**: nothing links a Claude Code session to a Codex handoff to a human review; no handoff graph.
- **No fail-closed redaction tiers**: size caps and client-side truncation exist, but privacy gating is not a documented capture-mode model.

## 9. Sources
- Kept: [comet-ml/opik (GitHub)](https://github.com/comet-ml/opik) — README, license, repo layout, install script options
- Kept: [Opik Platform Architecture (official docs)](https://www.comet.com/docs/opik/self-host/architecture) — authoritative component/language/datastore breakdown
- Kept: [deployment/docker-compose README](https://github.com/comet-ml/opik/blob/main/deployment/docker-compose/README.md) — compose profile inventory
- Kept: [Opik FAQ](https://www.comet.com/docs/opik/faq.mdx) — OSS vs Cloud delta, rate limits, SDK/CLI commands, integration counts
- Kept: [Opik k8s docs](https://www.comet.com/docs/opik/self-host/kubernetes.mdx) — Helm chart, ClickHouse operator
- Kept: [Comet engineering blog on Opik architecture](https://www.comet.com/site/blog/llm-observability-architecture-engineering/) — rationale for ClickHouse/MySQL/Redis
- Kept: [comet-ml/opik-mcp](https://github.com/comet-ml/opik-mcp) — official MCP server scope
- Kept: [pypistats opik](https://pypistats.org/packages/opik) — downloads
- Dropped: agenticindex.io & apisc.io pricing summaries — third-party; used only for the unverified 60-day-retention datapoint (flagged above)
- Dropped: generic "Opik vs Langfuse" SEO listicles — no primary value

---

# Report 2 of 3 — OpenLIT

## 1. Position & pitch
- **What**: Open-source "platform for AI engineering" — observability, evaluations, rule engine, guardrails, prompt hub, vault, playground — **built OpenTelemetry-native end-to-end** ("follows and maintains the OTel GenAI semantic conventions"). Now brands itself a "Harness Engineering Platform" on its homepage. [GitHub](https://github.com/OpenLIT/OpenLIT), [openlit.io](https://openlit.io/)
- **Who**: Community-backed org (sponsors include DigitalOcean; third-party writeups link it to Transilience AI). Created Jan 2024, India-based maintainers.
- **Value prop**: "One line of code" OTel-native instrumentation (50+ integrations), a UI included out of the box, your data goes to **any OTLP endpoint** — "OpenLIT is just one possible viewer." And, since mid-2026: **coding-agent observability for Claude Code, Cursor, Codex (+Windsurf) via a single Go CLI** — no SDK import, vendor hooks only. This makes OpenLIT the closest public precedent to HandoffGraph.

## 2. Architecture
- **SDKs** (`sdk/python`, `sdk/typescript`, `sdk/go`): auto-instrumentation by wrapping provider SDKs; emit standard OTel spans/metrics using `gen_ai.*` semconv; no endpoint configured ⇒ console output (dev mode). Vendor-neutral by construction.
- **Server + UI** (verified from `docker-compose.yml`, 2 services):
  - `clickhouse/clickhouse-server:24.4.1` — trace store (ports 9000/8123, init script + custom config from `assets/`).
  - `ghcr.io/openlit/openlit` — Node/TypeScript app (healthcheck = `node fetch('http://localhost:3000')`); serves UI on **:3000** AND embeds **OTLP gRPC :4317 + HTTP :4318 receivers**; keeps **internal SQLite DB** at `/app/client/data/data.db` for app state; OPAMP (with mTLS options) for collector/agent management; Google/GitHub OAuth envs.
  - Kubernetes via [openlit/helm](https://github.com/openlit/helm).
- **Go CLI** (single binary; brew / curl-script / docker install): commands `openlit configure|doctor|version` and `openlit coding install|launch|uninstall|hook`. Internals (`cli/`, Go):
  - Per-vendor hook adapters: `cli/internal/coding/hook/{claudecode,codex,cursor}` with transcript tailing; plugin manifests under `plugins/<vendor>/`.
  - **Session-state cache**: `$XDG_CACHE_HOME/openlit/sessions/<sid>.json` — identity/cwd/repo/branch/model/permission-mode persisted on lifecycle events, replayed on every short-lived hook process.
  - **Deterministic TraceID**: HMAC-SHA256 of session id, optional `OPENLIT_TRACEID_SALT` — "(sessionID) → traceID stable across hook processes" so readers can rejoin the trace.
  - **Emit-time redaction**: every string passes `setStr(..., scrub)` → `redact.ForCapture(mode)`; bodies gated by `bodyAllowed(mode)` in `cli/internal/otlp/attrs.go`.
  - Head sampling rules (`OPENLIT_CODING_SAMPLE_EVENTS`, e.g. drop noisy `*.requested` events); bounded transcript reads via `tailfile.Tail(path, cap)`; token-cost pricing tables (`cli/internal/coding/pricing`).
  - Session-state locking via flock (`sessionstate/`), install/uninstall with vendor config scrub (`vendor_config_scrub.go`) — idempotent install/uninstall with cleanup of vendor config edits.
- **Open-core boundary, CI-enforced**: `.github/scripts/check-oss-boundary.sh` fails CI if `src/client/src/ee`, `deploy/enterprise`, or `deploy/cloud` exist in the public repo, or if OSS code imports `@/ee`. PR #1226 added oss/enterprise/cloud edition helpers with an intentionally **empty OSS feature list** — paid code lives outside the public repo.

## 3. Feature inventory (OSS vs paid)
**OSS**:
- Dashboards: traces/metrics/costs, exceptions monitoring, **GPU monitoring** (eBPF collector, `opentelemetry-gpu-collector/`).
- **11 LLM-as-judge eval types** (SDK-side, context-aware): hallucination, bias, toxicity, safety, instruction-following, completeness, conciseness, sensitivity, relevance, coherence, faithfulness.
- **Rule engine**: AND/OR conditions over runtime trace attributes → dynamically retrieve contexts, prompts, eval configs (Python/TS/Go SDK support).
- Prompt Hub (versioning), **Vault** (API keys/secrets), OpenGround (LLM comparison playground), custom-model cost tracking (pricing files), real-time guardrails.
- **Coding-agent observability**: `/coding-agents` dashboard — sessions, per-vendor breakdowns, cost/token rollups, code-impact (lines added/accepted/rejected, commits, PRs), edit-decision outcomes, subagent linkage, work/personal classification, DORA-style session outcomes, cohort-K privacy floor, dispute trail for classifications.
- Roadmap (not yet): auto-evals from usage, human feedback, dataset generation from events, trace search.
**Paid**: enterprise/managed cloud (edition plumbing exists; openlit.io/pricing markets "Free Open Source Self-Host and Cloud"; DINAO sells managed hosting).

## 4. Integration surface
- SDK languages: **Python, TypeScript, Go** (Go SDK: `github.com/openlit/openlit/sdk/go`).
- 50+ auto-instrumented integrations: LLM providers (OpenAI, Anthropic, Cohere, Mistral, Groq, Google, Together, Ollama, Bedrock, Azure AI, Vertex, vLLM, HF, LiteLLM…), frameworks (LangChain, LlamaIndex, CrewAI, Pydantic AI, OpenAI Agents, Google ADK, Claude Agent SDK, Vercel AI, LangGraph, MS Agent Framework…), vector DBs (Pinecone, Chroma, Qdrant, Milvus, Astra, Postgres/pgvector), specialized (ElevenLabs, AssemblyAI, MCP).
- Export target: **any OTLP endpoint** — README: "Anything that speaks OTLP (Datadog, Honeycomb, Grafana Tempo, raw OTel Collector) can consume the same data."
- Dual-path for Claude Code: consumes **native Claude Code OTel telemetry** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `claude_code.*` metrics/events) AND its own hook spans, coalesced at query time.

## 5. Traction
- ~2,683 stars / ~351 forks (created 2024-01-23); 37 open issues; health index 94/100 (inspect.software).
- PyPI `openlit`: **8.9M lifetime downloads** (pepy); npm `openlit` ~7.1K/month; npm 24 versions / PyPI 175 versions; active releases every ~10 days.
- Recent explosive scope growth: Go CLI + coding agents + controller + GPU collector all landed within the last ~year.

## 6. Local runbook (verified)
```bash
# Stack (UI + ClickHouse + OTLP receivers)
git clone https://github.com/OpenLIT/OpenLIT && cd OpenLIT
docker compose up -d
# UI: http://127.0.0.1:3000  (default: user@openlit.io / openlituser)

# Python SDK
pip install openlit
python -c "import openlit; openlit.init(otlp_endpoint='http://127.0.0.1:4318')"
# or: export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 && openlit.init()

# Coding agents (Claude Code / Cursor / Codex)
curl -fsSL https://raw.githubusercontent.com/openlit/openlit/main/cli/scripts/install.sh | sh
openlit configure --endpoint http://127.0.0.1:4318 [--api-key <key>]
openlit coding install --vendor=all      # or: claude-code / cursor / codex
openlit doctor                            # config + OTLP reachability + installed plugins
# dashboard: http://127.0.0.1:3000/coding-agents
openlit coding uninstall --vendor=all
```

## 7. Top 5 lessons for HandoffGraph
1. **Deterministic trace identity across short-lived processes**: TraceID = HMAC-SHA256(sessionID, optional salt). Every hook invocation is a new process; readers depend on `(sessionID) → traceID` being stable. HandoffGraph's deterministic derived event IDs are the same idea — adopt the explicit salt guidance (document reversal-resistance tradeoff) and keep the derivation frozen once readers depend on it.
2. **Session-state cache + bounded tails**: persist session identity/cwd/repo/branch/model once (on lifecycle events) into a per-session JSON cache with flock, replay on every event; read transcripts with a byte-capped tail (`tailfile.Tail`) — OpenLIT documented OOM/latency spikes from reading whole Claude transcripts as a "do not regress" item. Directly applicable to our Claude Code/Codex ingest paths.
3. **Tiered capture modes enforced at emit time**: `minimal` / `metadata_only` / `full` with a single scrubbing choke-point (`setStr` → `redact.ForCapture`) and `bodyAllowed(mode)` gating body-bearing attributes. This is OpenLIT's version of our fail-closed redaction — steal the *product concept* (operator-selectable privacy tiers) while keeping our stricter fail-closed semantics (they filter post-hoc at query time in one place; we should gate at emit and fail closed).
4. **Emit-once rollups + dual-source coalesce**: session-root span emitted only on SessionEnd (duplicates were a real bug class), and native vendor OTel vs hook spans coalesced at read time with explicit precedence — native wins tokens/cost (authoritative), hook wins identity/cwd/repo (only the hook sees them), keyed by `coding_agent.signal_source` ∈ {hook, native, sdk}. This is provenance-aware merging — conceptually our OBSERVED/DECLARED split. Consider a `signal_source`-style attribute when we ingest native vendor OTel so coalescing stays deterministic and explainable.
5. **"The UI is just one OTel viewer"** positioning + a Go CLI that's a single binary with `configure/doctor/install/uninstall` — the exact UX shape of HandoffGraph. The cheapest strategic move: expose **OTLP :4318/:4317 on our spine** so HandoffGraph becomes a destination for openlit-SDK/traceloop-sdk/Claude-Code-native data, then out-differentiate on verification.
- (Also: their war stories — `any()` in GROUP BY breaking rollups, `ReplacingMergeTree ORDER BY agent_key` FINAL flip-flops, a three-barrier dedup chain to stop phantom rows — are all *non-determinism taxes* on a store-then-derive architecture. Our sorted, deterministic reducers + SQLite avoid most of these; keep it that way.)

## 8. What they DON'T do (openings for HandoffGraph)
- **No verification or integrity**: no hash chains, no deterministic-reducer proofs, no checkpoint verification; data is as-good-as-the-vendor-payload. HandoffGraph's "verified" layer is entirely absent here.
- **Analytics, not debugging**: coding-agent surface is cost/DORA/code-impact dashboards. No step-through session debugger, no replay, no evidence-based checkpoints, no MCP tools to query session evidence.
- **No cross-agent continuity**: subagent/parent linkage exists *within* one vendor's session; nothing joins Claude Code ↔ Codex ↔ human handoffs.
- **Evals are LLM-judge**: nondeterministic, LLM-costed; no no-LLM verification.
- **Not single-binary local**: ClickHouse + Node app (SQLite only for app metadata). Heavier ops story than ours.
- **Money as float64**: their convention doc mandates cost as `float64` USD (they've been bitten: "$NaN" and 100× bugs are documented). Our decimal-string money convention is a correctness differentiator — keep it.
- **They document their own blind spots**: Cursor's unstable thread id across process restarts (N user-chats render as N+1 sessions) and no cwd/repo in Claude Code's native path. A cross-session graph using repo+time+content correlation with DECLARED provenance could close gaps they explicitly punt on.

## 9. Sources
- Kept: [OpenLIT/OpenLIT (GitHub, cloned & inspected)](https://github.com/OpenLIT/OpenLIT) — README quickstarts, cli/ tree, docker-compose.yml, agent-guides, OSS-boundary script
- Kept: [agent-guides/coding-agents-convention.md](https://github.com/openlit/openlit/blob/main/.cursor/rules/coding-agents-convention.md) — canonical schema, dual-path coalesce, privacy guardrails, documented limitations
- Kept: [agent-guides/coding-agents-hook.md](https://github.com/openlit/openlit/blob/main/.cursor/rules/coding-agents-hook.mdc) — deterministic TraceID, session cache, capture modes, idempotency lessons
- Kept: [docs.openlit.io CLI overview](https://docs.openlit.io/latest/cli/overview) + [commands](https://docs.openlit.io/latest/cli/commands) + [coding-agents setup](https://docs.openlit.io/latest/openlit/coding-agents/setup-and-configure) — official runbook
- Kept: [openlit.io/pricing](https://www.openlit.io/pricing) and [PR #1226 enterprise foundation](https://github.com/openlit/openlit/pull/1226) — OSS vs paid split
- Kept: pepy.tech (8.9M PyPI lifetime), inspect.software (stars/downloads/npm) — traction
- Dropped: ChatForest/EveryDev vendor blurbs — marketing-derived, partially stale (claimed "no cloud product" vs live pricing page)

---

# Report 3 of 3 — Traceloop OpenLLMetry

## 1. Position & pitch
- **What**: "A set of extensions built on top of OpenTelemetry that gives you complete observability over your LLM application. Because it uses OpenTelemetry under the hood, it can be connected to your existing observability solutions — Datadog, Honeycomb, and others." Pure instrumentation + thin convenience SDK; **not** a storage/UI/eval product. [GitHub](https://github.com/traceloop/openllmetry)
- **Who**: Built and maintained by **Traceloop** (Y Combinator-backed); Apache-2.0. Their LLM semantic conventions were upstreamed into OpenTelemetry's GenAI semconv effort.
- **Value prop**: zero-lock-in — instrument once with OTel-native spans, export to any backend; incremental adoption ("if you already have OpenTelemetry instrumented, just add our instrumentations").

## 2. Architecture
- **Python monorepo** (nx-managed), `packages/` (verified via GitHub API — exact inventory):
  - **32 instrumentation packages** `opentelemetry-instrumentation-*`: agno, alephalpha, anthropic, bedrock, chromadb, cohere, crewai, google-generativeai, groq, haystack, lancedb, langchain, litellm, llamaindex, marqo, **mcp**, milvus, mistralai, ollama, openai, openai-agents, pinecone, qdrant, replicate, sagemaker, together, transformers, vertexai, voyageai, watsonx, weaviate, writer.
  - `opentelemetry-semantic-conventions-ai` — first-class, versioned semconv package.
  - `traceloop-sdk` — one-line `Traceloop.init()` convenience layer (default export to Traceloop or any OTLP endpoint; `disable_batch=True` for local dev; association properties to correlate traces with customers/sessions).
  - `sample-app` + per-package VCR **cassette test suites** (`tests/cassettes/*.yaml`) replaying recorded provider API responses; dedicated semconv-compliance tests (e.g., `test_semconv_span_attrs.py`).
- **How auto-instrumentation works**: each package wraps the provider SDK's methods (sync/async/streaming), creates OTel spans with `gen_ai.*` attributes (model, token usage, finish reasons, prompt/completion events), handles streaming chunk aggregation, and emits via whatever OTLP exporter the host app configured. Everything that OTel core already instruments (DBs, HTTP) composes on top.
- **JS/TS version**: separate repo [traceloop/openllmetry-js](https://github.com/traceloop/openllmetry-js).
- **No backend**: no storage, no UI, no query API in this repo — those are the Traceloop SaaS. SDK telemetry collection was **removed entirely as of v0.49.2** (privacy/trust move).

## 3. Feature inventory (OSS vs paid)
**OSS (this repo)**: instrumentations for ~16 LLM providers, 7 vector DBs, ~10 frameworks, MCP protocol; OTel-native spans/metrics; thin SDK (init, batching toggle, association properties, prompt *association*); semconv package; 30 documented export destination guides.
**Paid (Traceloop platform, not in repo)**: dashboards/trace UI, prompt management (playground/CI), evals, monitoring/alerting. OpenLLMetry itself is 100% Apache-2.0 with no feature gates.

## 4. Integration surface — the "point at any backend" claim (verified)
Documented, tested destinations ([README](https://github.com/traceloop/openllmetry) + [exporting docs](https://www.traceloop.com/docs/openllmetry/integrations/exporting)): Traceloop, Axiom, Azure App Insights, Braintrust, BMC, Dash0, Datadog, Dynatrace, Elasticsearch APM, Google Cloud, Grafana (Tempo), groundcover, Highlight, Honeycomb, HyperDX, IBM Instana, KloudMate, Laminar, Langfuse, LangSmith, Middleware, New Relic, OpenTelemetry Collector, Oracle Cloud, Scorecard, ServiceNow Cloud Observability, SigNoz, Sentry, Splunk, Tencent Cloud — **~30 backends**, all via standard OTLP env/args (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, or SDK args). Languages: Python (this repo) + JavaScript/TypeScript (sibling repo). No Go SDK.

## 5. Traction
- 7,388–7,397 stars / ~1,060 forks; created 2023-09-02; ~656 open issues (breadth-driven); frequent releases.
- PyPI `traceloop-sdk`: **~2.25M downloads/month** (~53K/day); the flagship `opentelemetry-instrumentation-openai` package has its own monthly download badge; JS repo separate.
- YC badge; active Slack/Discussions community; "Top 7% on SourcePulse."

## 6. Local runbook (verified)
```bash
pip install traceloop-sdk
```
```python
from traceloop.sdk import Traceloop
Traceloop.init()                        # traces all supported providers
Traceloop.init(disable_batch=True)      # local dev: immediate spans
# point anywhere:
Traceloop.init(app_name="my-app", api_key="...", exporter=...)  # or env:
#   OTEL_EXPORTER_OTLP_ENDPOINT=https://my-collector:4318
#   OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ..."
```
Or use instrumentations directly with your existing OTel setup:
```bash
pip install opentelemetry-instrumentation-openai opentelemetry-instrumentation-anthropic
```

## 7. Top 5 lessons for HandoffGraph
1. **Accept standard OTLP and inherit an ecosystem**: a spine that exposes OTLP/HTTP :4318 (+ gRPC :4317) becomes an instant destination for traceloop-sdk, openlit SDK, *and* Claude Code's native OTel telemetry — maximal interoperability for near-zero code. This is the single highest-leverage item on this list for our roadmap.
2. **VCR-cassette testing against provider drift**: every instrumentation package replays recorded API interactions (hundreds of YAML cassettes — streaming, tool use, thinking, prompt caching, error paths) plus semconv-compliance tests. HandoffGraph's parsers of Claude/Codex transcript formats face the same drift; golden fixtures under `testdata/fixtures/` (already mandated) should grow into cassette-style replay suites covering streaming and error shapes.
3. **Semconv as a first-class versioned package, contributed upstream**: `opentelemetry-semantic-conventions-ai` → OTel GenAI semconv gave them legitimacy and longevity. Map HandoffGraph's event/attribute names onto `gen_ai.*` (and OpenLIT-compatible `coding_agent.*` where sensible) while keeping our evidence/provenance extensions in a clearly-owned namespace.
4. **Thin SDK over composable parts**: one-line `Traceloop.init()` for the 80% case, per-package instrumentations for the 20%. Our adapter story (`hg agents install <vendor>`) should be equally one-line, idempotent, and fail-closed (`ErrHookConflict`) — we already have the right invariant; match their packaging ergonomics.
5. **Radical de-locking as growth strategy**: 30 documented destinations, telemetry collection removed entirely (v0.49.2), everything OSS. Trust drove adoption for a YC startup competing against its own paid platform. HandoffGraph's analog: make *export out* (OTLP/JSONL) as easy as ingest in, and never hold sessions hostage.

## 8. What they DON'T do (openings for HandoffGraph)
- **No storage, UI, queries, or evals** in the OSS project — everything user-facing is Traceloop's paid SaaS. There is no OSS "OpenLLMetry server."
- **No coding-agent support** (no hook/CLI adapters; that space was filled by OpenLIT, not them).
- **No privacy/capture tiers, no redaction pipeline** — bodies are emitted per span attributes with an env-level content opt-out; nothing like fail-closed gating.
- **No verification/integrity/continuity** of any kind — it's client-side span emission only.
- **Python/TS only** — no Go.

## 9. Sources
- Kept: [traceloop/openllmetry (GitHub, cloned & inspected)](https://github.com/traceloop/openllmetry) — README destinations & quickstart, packages/ inventory, cassette test layout, LICENSE
- Kept: [OpenLLMetry exporting docs](https://www.traceloop.com/docs/openllmetry/integrations/exporting) — full destination catalog
- Kept: [PyPI traceloop-sdk](https://pypi.org/project/traceloop-sdk/) — download stats, maintainers, license
- Kept: [traceloop/openllmetry-js](https://github.com/traceloop/openllmetry-js) — JS/TS split
- Dropped: tokensand.com / SourcePulse profiles — secondary aggregators, used only as corroboration

---

# Cross-project synthesis for the HandoffGraph gap analysis

**Capability ladder observed**: OpenLLMetry (instrumentation only) → OpenLIT (instrumentation + ClickHouse UI + coding-agent Go CLI + evals/rules) → Opik (full platform: evals, datasets/experiments, guardrails, prompt mgmt, MCP, k8s-scale). HandoffGraph should target OpenLIT's interop surface + Opik's platform completeness, while owning two axes **none** of them occupy:

1. **Verification**: hash-chained append-only evidence, deterministic reducers, fail-closed redaction, no-LLM evidence-based checkpoints. All three rely on trusted writes and (for evals) nondeterministic LLM judges.
2. **Cross-agent continuity**: a handoff graph across Claude Code ↔ Codex ↔ Pi ↔ human. OpenLIT links subagents within one vendor only; nobody models handoffs between agents.
3. **Local-first single binary**: Opik needs ~8 containers; OpenLIT needs ClickHouse+Node; OpenLLMetry has no server at all. A Go binary + pure-Go SQLite with an embedded debugger is a genuinely underserved point in the design space.
4. **Concrete tactical moves surfaced by this research**: expose OTLP :4318/:4317 on the spine; adopt `gen_ai.*`/`coding_agent.*`-compatible attribute naming + a `signal_source`-style provenance attribute; copy OpenLIT's session-state cache + bounded-tail + emit-once-session-span patterns; grow golden fixtures into cassette suites (OpenLLMetry model); match Opik's one-command local UX (`--verify/--stop/--clean`); keep decimal-string money (OpenLIT's float64 cost already caused documented bugs); use repo+time+content correlation with DECLARED provenance to attack Cursor's documented session-fragmentation problem.

## Gaps / residual uncertainty
- **Opik Cloud free-tier retention (60 days) and span quotas** come from a third-party pricing summary (apis.io), not comet.com's pricing page — treat as indicative.
- **Opik Agent Optimizer licensing** (in-repo Apache-2.0 vs any enterprise gating) was not individually verified; everything else in the platform is confirmed in-repo.
- **OpenLIT's enterprise feature list** is intentionally empty in the public repo (edition plumbing only); what exactly ships paid is not publicly enumerated.
- **OpenLIT PyPI monthly downloads** not retrieved (lifetime 8.9M only); npm monthly (~7.1K) is small — the Go CLI is new and its adoption isn't yet measurable from registries.
- **Star counts drift daily**; treat numbers as Aug-2026 snapshots.
- Not covered (out of scope per task): Langfuse/Langfuse-style platforms, Arize Phoenix, W&B Weave — natural next research targets for a wider competitive matrix.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "research.md contains three complete structured reports (Opik, OpenLIT, OpenLLMetry), each with the 9 required sections (position, architecture, features OSS/paid, integration surface, traction, local runbook, top-5 lessons for HandoffGraph, differentiation openings, sources), plus a cross-project synthesis and gaps section, all with inline source URLs; key claims verified against primary sources (Opik architecture docs, OpenLIT cloned repo internals incl. docker-compose.yml / agent-guides / check-oss-boundary.sh, OpenLLMetry packages API listing). Written to the authoritative output path."
    }
  ],
  "changedFiles": [
    "/Users/arbaz/.pi/agent/sessions/--Users-arbaz-Projects-tools-handoffgraph--/subagent-artifacts/outputs/cf2869c5-89d5-407d-b236-109e4d3b4f55/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web_search (multi-angle) + fetch_content (GitHub repos, official docs, GitHub API contents, docker-compose, raw README) + get_search_content slices + local reads of cloned OpenLIT repo files",
      "result": "passed",
      "summary": "All primary sources retrieved and verified; task's 'Opik = Python FastAPI' assumption corrected to Java 25+Dropwizard main API with Flask evaluator service; Apache-2.0 full-platform claim, OpenLIT OTel/coding-agent CLI claims, and OpenLLMetry any-backend claim all verified."
    }
  ],
  "validationOutput": [
    "Opik: architecture verified from comet.com/docs/opik/self-host/architecture; opik.sh flags verified from raw README; OSS-vs-Cloud delta from official FAQ; 21,577 stars; ~3.28M PyPI dl/month.",
    "OpenLIT: repo cloned and inspected (cli/ Go tree, agent-guides convention+hook docs, docker-compose.yml 2 services, OSS-boundary CI script); coding-agent runbook verified from README + docs.openlit.io; ~2,683 stars; 8.9M PyPI lifetime.",
    "OpenLLMetry: packages/ inventoried via GitHub API (32 instrumentation packages + semconv + traceloop-sdk); 30 documented export destinations; 7,388 stars; ~2.25M traceloop-sdk dl/month."
  ],
  "residualRisks": [
    "Opik Cloud free-tier 60-day retention/span quotas sourced from third-party summary (apis.io), not comet.com pricing page.",
    "Opik Agent Optimizer in-repo licensing not individually verified.",
    "OpenLIT enterprise feature list intentionally not public (empty OSS feature list by design).",
    "Star counts are point-in-time (Aug 2026) snapshots and will drift."
  ],
  "noStagedFiles": true,
  "diffSummary": "Single new artifact: research.md (three-project competitive research brief with verified architecture/runbook/traction data and HandoffGraph gap analysis).",
  "reviewFindings": [
    "no blockers",
    "note: task brief assumed Opik backend is 'Python FastAPI' — primary docs show main API is Java 25+Dropwizard with a secondary Flask (not FastAPI) evaluator service; report corrects this.",
    "note: OpenLIT has become a direct adjacent competitor (Go CLI hooking Claude Code/Cursor/Codex with deterministic TraceIDs, session-state cache, emit-time redaction tiers) — flagged prominently for the gap analysis."
  ],
  "manualNotes": "OpenLIT's coding-agent internals (agent-guides/coding-agents-convention.md and coding-agents-hook.md) are the most HandoffGraph-relevant primary material found; recommend the parent consider reading those two files directly before finalizing the roadmap. Cloned repos remain at /private/tmp/pi-github-repos/ if deeper inspection is needed."
}
```