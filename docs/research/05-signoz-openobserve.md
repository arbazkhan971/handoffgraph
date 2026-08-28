# Research: SigNoz & OpenObserve — storage/query architecture references for HandoffGraph

Compiled 2026-08-27 from primary sources (GitHub repos, LICENSE files, GitHub API, official docs). All star counts and versions are as of 2026-08-27. Facts that could not be verified are explicitly marked.

---

# PART 1 — SigNoz

## 1.1 Position & pitch

**What it is.** SigNoz is an open-source, OpenTelemetry-native observability platform (traces, metrics, logs, alerts, dashboards, exceptions, trace funnels, infra monitoring) positioned as a Datadog / New Relic / Elastic alternative "on your terms, powered by open standards." The pitch: instrument once with OTLP, own your telemetry, correlate all signals in one columnar database (ClickHouse), and avoid per-host/per-seat pricing. [Source: README](https://github.com/SigNoz/signoz), [Source](https://signoz.io/docs/architecture/)

**Datadog-alternative story.** Explicit migration guides exist for Datadog, New Relic, ELK, Grafana LGTM, and Honeycomb, plus an automated Datadog dashboard migration tool. Benchmarks claim ~50% lower ingestion resources vs Elastic and that Loki hits max-stream errors on high-label logs where SigNoz does not. SigNoz Cloud starts at $49/month (incl. $49 usage; logs/traces $0.30/GB, metrics $0.10/M samples; Enterprise from $4,000/mo; 10 TB+/day ingestion track record). [Source: pricing](https://signoz.io/pricing.md), [Source: README](https://github.com/SigNoz/signoz)

**LLM/agent observability fit.** LLM observability is *not* a separate product — it is "OTLP in, `gen_ai.*` semantic conventions stored next to your app telemetry." No SigNoz SDK, no proprietary agent; any OpenTelemetry instrumentation works (OpenLLMetry, OpenLIT, OpenInference, OTel contrib). 46 documented LLM integrations including **Claude Code, Claude Agent SDK, Codex (OpenAI), OpenCode, Qwen Code, GitHub Copilot** — i.e., SigNoz already markets coding-agent telemetry. LLM spans appear in the same trace waterfall as SQL/HTTP spans; token/cost/latency dashboards come from dashboard templates. Agent-native extras: a SigNoz **MCP server** (self-hostable, HTTP transport, API-key auth) and **Agent Skills** (`npx skills add SigNoz/agent-skills`) so coding agents can query telemetry and build dashboards; "Noz" AI teammate is Cloud-only. [Source: LLM observability overview](https://signoz.io/docs/llm-observability/), [Source: docker install](https://signoz.io/docs/install/docker/), [Source: llms.txt](https://signoz.io/llms.txt)

## 1.2 Architecture

Verified from the [architecture doc](https://signoz.io/docs/architecture/) and the current repo layout ([github.com/SigNoz/signoz](https://github.com/SigNoz/signoz)):

- **SigNoz binary (Go)** — one bundled service containing: statically built **React frontend** (served by the API server), **Apiserver** (query APIs + org/user metadata), **OpAMP server** (dynamically configures log pipelines in the SigNoz OTel collector), **Ruler** (alert-rule evaluation), and **Alertmanager** (dedup/grouping/notification). The repo builds two entrypoints: `cmd/community/` (OSS) and `cmd/enterprise/` (EE). The old separate `query-service` + `frontend` containers are gone; a single `signoz/signoz` image runs `./signoz server`.
- **SigNoz OTel Collector** — their collector distro ([SigNoz/signoz-otel-collector](https://github.com/SigNoz/signoz-otel-collector), Go) accepts OTLP gRPC/HTTP, Jaeger, Zipkin, Kafka, OpenCensus and writes to ClickHouse. Adds a cardinality processor, tail sampling, routing connector, GeoIP, OTTL docs. Apps can send direct OTLP or via intermediate collectors.
- **ClickHouse** — sole telemetry store, replicated or non-replicated; Keeper (clickhouse-keeper) for replicated deployments.
- **Metadata store** — "SigNoz ships with SQLite by default… PostgreSQL for production" via `SIGNOZ_SQLSTORE_PROVIDER`; stores orgs, users, dashboards, configs only — "It does not replace ClickHouse." [Source](https://signoz.io/docs/manage/administrator-guide/configuration/relational-database.md)
- **Deployment** — **Foundry** ([SigNoz/foundry](https://github.com/SigNoz/foundry)): `foundryctl cast -f casting.yaml` validates Docker/K8s and *generates* compose/helm manifests. The repo's `deploy/install.sh` and root `docker-compose` manifests are **deprecated** ("SigNoz now installs and runs through Foundry"). [Source: deploy/README.md](https://github.com/SigNoz/signoz/blob/main/deploy/README.md)
- **Newer architecture claims (task asked about "Rust services / Zoe")**: **"Zoe" could not be verified** — zero matches in the SigNoz docs sitemap, blog sitemap, org repo search, or repo contents. No Rust services exist in the main repo (Go + TypeScript/React only). Verified timeline instead: 2021 monolith (query-service + frontend) → 2022 `ee/` carve-out → 2024-25 single bundled Go binary (`cmd/` package added 2025-07-17) → 2025-26 Foundry-driven deploys. Latest upgrade guide is v0.137 (so current ≥ v0.137; docs example pins v0.128.0).

### Storage schemas (traces) — verified column-by-column

From [Traces Schema docs](https://signoz.io/docs/userguide/writing-clickhouse-traces-query/):

- **`distributed_signoz_index_v3`** (main spans table): `ts_bucket_start UInt64` (timestamp rounded to **30-minute buckets**), `resource_fingerprint String`, `timestamp DateTime64(9)`, `trace_id FixedString(32)`, `span_id`, `parent_span_id`, `duration_nano`, `has_error Bool`, `events Array(String)`, plus:
  - **Attribute maps**: `attributes_string Map(LowCardinality(String), String)`, `attributes_number`, `attributes_bool`, and a `resource JSON(max_dynamic_paths=100)` column (newer; `resources_string` Map deprecated).
  - **Pre-extracted + "selected field" columns**: common attrs promoted to real columns, e.g. `attribute_string_http$$route DEFAULT attributes_string['http.route']`, `resource_string_service$$name`, plus `_exists` companion columns; users can promote arbitrary attributes to indexed columns at runtime.
  - **ORDER BY `(ts_bucket_start, resource_fingerprint, has_error, name, timestamp)`** with CODECs (DoubleDelta+LZ4 for time, ZSTD(1) elsewhere).
- **`distributed_traces_v3_resource`** — tiny fingerprint lookup (`labels` JSON, `fingerprint`, `seen_at_ts_bucket_start`); used via CTE + `resource_fingerprint GLOBAL IN __resource_filter` to prune the big table by resource attributes.
- **`distributed_signoz_error_index_v2`** — extracted exception events (`errorID`, `groupID`, `exceptionType/Message/Stacktrace`, `exceptionEscaped`) with **bloom_filter indexes** on `errorID` and on `mapKeys/mapValues(resourceTagsMap)`.
- **Lookup tables**: `distributed_top_level_operations`, `distributed_span_attributes_keys` (attribute key + data type + isColumn), `distributed_span_attributes` (attribute values).
- Mandatory query pattern: **always filter `ts_bucket_start BETWEEN $start-1800 AND $end`** (30-min slack) for partition pruning, and always use a resource-filter CTE.

**Partitioning/retention (self-host).** Defaults: traces & logs **15 days**, metrics **30 days**; TTL delete is permanent; changes apply only to newly ingested data; per-signal retention set in UI (Workspace → Retention Controls). Per-source custom retention is "COMING SOON". [Source](https://signoz.io/docs/userguide/retention-period/)

## 1.3 Feature inventory

| Area | What exists (community/OSS unless noted) |
|---|---|
| Traces | Trace explorer (List/Trace/Timeseries/Table views), flamegraphs/waterfalls, span details, >10K-span rendering, **Trace Funnels**, span links, derived span fields, tail sampling, PII scrubbing, drop-spans volume control |
| Logs | Logs explorer + query builder, quick filters, JSON logs, live tail, saved views, logs pipelines (grok/regex/JSON/severity/timestamp processors), drop logs, full-text search |
| Metrics | Metrics explorer, PromQL + ClickHouse SQL + Query Builder, custom histogram buckets, volume control/drop labels |
| Exceptions | Dedicated exceptions view built from trace data + `signoz_error_index_v2` grouping |
| Infra/Cloud | Host metrics, K8s (pods/nodes/etc.), AWS/Azure/GCP one-click (one-click is Teams+), messaging queues (Kafka/Celery), external API monitoring, CI/CD monitoring (GitHub Actions/Jenkins/GitLab traces), uptime monitoring |
| Dashboards | Panel types: timeseries, value, table, bar, histogram, pie, list; variables + interactivity; import/export; public sharing; **Dashboards V2 API**; **Terraform provider** (dashboards-as-code); ~80 dashboard templates incl. Claude Code, Claude Agent SDK, Codex, Qwen Code, OpenCode, LiteLLM, all major LLM providers |
| Alerts | Alert types: **metrics-based, logs-based, traces-based, exceptions-based, anomaly (Teams/EE)**; alert history v2 API; routing policy; planned maintenance; "no data" alerts for groups; 11 notification channels (Slack, PagerDuty, Opsgenie, MS Teams, webhook, Jira, email, …); **Terraform "Alert as Code"** |
| IAM/SSO | Roles, invite members, service accounts, self-service API keys, ingestion-key telemetry scoping; SSO ✓ / SAML ✗ in OSS (SAML is Cloud/EE); fine-grained RBAC = Enterprise **BETA**; multi-tenancy & audit logs = coming soon |
| APIs | Trace API (search/aggregate + payload model), Logs API, Metrics Query-Range API, Stats API, Cost Meter API; OpenAPI spec in repo (`docs/api/openapi.yml`) |
| AI/agent tooling | MCP server (self-host, HTTP + `SIGNOZ-API-KEY`, port 8000), Agent Skills/plugin for Claude Code/Cursor/Codex, Noz AI teammate (Cloud only) |

Sources: [pricing matrix](https://signoz.io/pricing.md), [docs sitemap](https://signoz.io/docs/sitemap.md), [README](https://github.com/SigNoz/signoz).

**LLM-specific capabilities (verified).** Full `gen_ai.*` semantic-convention coverage documented: `CLIENT` inference spans named `{operation} {model}`, required `gen_ai.operation.name`/`gen_ai.provider.name`, recommended usage attrs (`input_tokens`, `output_tokens`, `cache_read.input_tokens`, `reasoning.output_tokens` — cached/reasoning defined as *subsets*, not additive), `INTERNAL` tool spans named `execute_tool {tool}` with `gen_ai.tool.*`, agent spans with `gen_ai.agent.*`, histograms `gen_ai.client.token.usage` / `gen_ai.client.operation.duration` / `gen_ai.server.time_to_first_token`. **Prompt/response content is opt-in** (`gen_ai.input.messages` etc. — "deliberate privacy default"). Conventions still marked Development; pin versions. Cost = token counts × your rate table at **query time** ("multiply token counts by your own per-model rates… keeping the rate table in one place"). Alerting guidance: error-rate 2–5%, rate-limit ~1%, p95 (never mean), token-spend **anomaly** alerts, retrieval-empty detection, **agent iteration count ceilings**, no-data alerts. [Source](https://signoz.io/docs/llm-observability/)

## 1.4 Integration surface

- **OTel collector configs**: SigNoz ships the collector as the ingest boundary; collection agents exist for K8s (`k8s-infra`), VM (standalone binary), Docker, ECS/Fargate, OTel Operator; processors documented: cardinality, tail sampling, routing connector, GeoIP, OTTL. [Source](https://signoz.io/docs/opentelemetry-collection-agents/get-started/)
- **Claude Code (first-party doc)**: uses Claude Code's **native OTel support** — env vars only, no hooks: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`, endpoint+ingestion-key headers. Centralized MDM deploy via `managed-settings.json` `"env"` block ("cannot be overridden by users"). Captured metrics: `claude_code.session.count`, `token.usage` (incl. cacheRead/cacheCreation), `cost.usage` (USD estimates; "for billing data, refer to your Anthropic Console"), `lines_of_code.count`, `commit.count`, `pull_request.count`, `code_edit_tool.decision` (accept/reject), `active_time.total`. Events: `user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`, `permission_mode_changed`, `mcp_server_connection`, `compaction`, … **Spans are beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Content capture redacted by default with granular opt-ins; raw bodies truncated at 60 KB. Helper repo: `SigNoz/Claude-Code-OpenTelemetry`. [Source](https://signoz.io/docs/claude-code-monitoring/)
- **OpenLLMetry compatibility**: yes — first-class doc for Traceloop OpenLLMetry, plus OpenLIT and OpenInference ("all three emit standard OpenTelemetry spans over OTLP, so all three work with SigNoz"). [Source](https://signoz.io/docs/llm-observability/)
- **Cloudflare**: an OTel instrumentation page exists for Cloudflare Workers (notable for our hosted tier). [Source](https://signoz.io/docs/instrumentation/opentelemetry-cloudflare/)

## 1.5 Traction & licensing

- **Traction (GitHub API, 2026-08-27)**: 31,949 stars, 2,450 forks, 1,542 open issues, created 2021-01-03; primary language TypeScript (frontend-heavy repo; backend Go). Slack community; SOC 2 Type II & HIPAA (cloud).
- **Licenses (verified from LICENSE files & GitHub API)**:
  - **Main repo**: MIT (plain) from 2021-01-10 → MIT + `ee/` carve-out from 2022-09-14 → **MIT Expat for everything outside `ee/` and `cmd/enterprise/`** (current, since 2025-07-17). Root LICENSE states: `ee/` and `cmd/enterprise/` are governed by `ee/LICENSE`. [Source: LICENSE](https://github.com/SigNoz/signoz/blob/main/LICENSE)
  - **`ee/LICENSE` (Enterprise License)**: production use requires a SigNoz subscription with correct seat count; dev/test use free; forbidden to copy/merge/publish/distribute/sell. [Source: ee/LICENSE](https://github.com/SigNoz/signoz/blob/main/ee/LICENSE)
  - **`SigNoz/signoz-otel-collector`**: **AGPL-3.0** — LICENSE file added 2026-05-29 ("chore(license): add GNU AGPL v3 license"); the repo had **no LICENSE file at all** before that commit. [Source: commit](https://github.com/SigNoz/signoz-otel-collector/commit/733f95093852d5c2821ef94fccf25c1ab7077a69)
  - **`SigNoz/foundry`** (installer): **AGPL-3.0**. [Source: GitHub API](https://api.github.com/repos/SigNoz/foundry)
  - **SPLA-1.1**: **not found.** No SPLA-1.1 or "SigNoz Community License" text exists in the current main repo, collector, foundry, docs sitemap, or blog sitemap. The task's premise appears outdated or confused with another project; treat the verified MIT/AGPL/EE split above as ground truth.
- **Implications for Apache-2.0 HandoffGraph**: (1) Reading/learning from the MIT-Expat core is unambiguously safe; even verbatim code reuse is allowed with copyright-notice retention (we still won't copy — our stack is Go+SQLite/Cloudflare, theirs is Go+ClickHouse). (2) **Never copy code from `ee/`, `cmd/enterprise/`** (proprietary) **or from `signoz-otel-collector` / `foundry`** (AGPL-3.0 — §13 network-copyleft would infect a distributed combined work; even a hosted derivative triggers source-disclosure obligations). (3) Their directory-level license fence (`ee/` + `cmd/enterprise/` with separate build entrypoints and a separate `ee/LICENSE`) is the cleanest pattern in this space for open-core boundaries. (4) Specs/semantic conventions (OTel `gen_ai.*`) are CC/Apache-licensed by the OTel project — free to adopt.

## 1.6 Local runbook (Docker, current official path)

```bash
# 1. Install foundryctl
curl -fsSL https://signoz.io/foundry.sh | bash

# 2. casting.yaml
cat > casting.yaml <<'EOF'
apiVersion: v1alpha1
kind: Installation
metadata:
  name: signoz
spec:
  deployment:
    flavor: compose
    mode: docker
EOF

# 3. Deploy (validates Docker, generates compose into pours/deployment/, starts)
foundryctl cast -f casting.yaml
docker ps   # expect: clickhouse-server, clickhouse-keeper, postgres:16 (metastore),
            # signoz/signoz-otel-collector (ports 4317-4318), signoz/signoz (port 8080)
```

- **URL/ports**: UI `http://localhost:8080`; OTLP `4317`/`4318`; optional MCP server `8000` (`spec.mcp.spec.enabled: true` → `signoz-mcp` service; create API key under Settings → Service Accounts; `claude mcp add --transport http signoz http://localhost:8000/mcp --header "SIGNOZ-API-KEY: …"`).
- **Resources**: ≥ 4 GB memory allocated to Docker; Linux/macOS native or WSL2 (Keeper segfaults under Windows Docker Desktop virtualization).
- **First-run admin**: UI-driven org/user setup (root user config exists: JWT secret, root user docs; `Reset Admin Password` runbook in docs).
- **Legacy path** (still in repo, deprecated): `git clone github.com/SigNoz/signoz && cd deploy && ./install.sh` — no longer recommended. Pin versions via `spec.signoz.spec.image: signoz/signoz:v0.128.0`.
- **Customization loop**: edit `casting.yaml` → re-run `foundryctl cast`; raw compose edits are overwritten ("Do not edit the generated files in pours/"). Memory limits/networks via Foundry "patches".

[Source](https://signoz.io/docs/install/docker/), [Source: deploy/README.md](https://github.com/SigNoz/signoz/blob/main/deploy/README.md)

## 1.7 Top 8 concrete lessons for HandoffGraph

1. **Time-bucket as the leading sort/filter key.** `ORDER BY (ts_bucket_start, …)` with 30-minute buckets + a mandatory `ts_bucket_start BETWEEN start-1800 AND end` predicate is the single biggest trace-query-at-scale trick. Translate to SQLite: a persisted generated column `ts_bucket_start` (e.g., 5–15 min buckets) on the event spine, leading every index, and enforced by the query layer. (Their `-1800` slack rule matters: spans started before the window can land in-window.)
2. **Resource-fingerprint CTE for high-cardinality filtering.** A tiny `fingerprint(labels JSON) → id` table lets the planner prune the huge spans table via `GLOBAL IN` instead of scanning maps. Translate: a `session_fingerprint`/`agent_fingerprint` derived table for (agent, repo, host, model) tuples, joined into every read-model query; keep fingerprints in the reducer output so hosted D1 queries can do the same two-step prune.
3. **Typed attribute maps + runtime-promoted selected fields.** `attributes_{string,number,bool}` Maps for everything, plus promoted real columns (`attribute_string_http$$route`, `…_exists`) for hot keys. Translate: JSON1 columns on events for arbitrary attributes + promoted, indexed generated columns for the hot agent keys (tool name, model, session id), with an "exists" indicator per promoted column so absence is queryable — this preserves our append-only spine while giving columnar-style query speed.
4. **Separate derived exceptions table with error grouping.** `signoz_error_index_v2` (errorID + groupID + bloom-filter indexes) turns raw span events into a browsable exceptions surface. Translate: a deterministic `exception_groups` read model derived by our graph reducer from the event spine — grouping hash must be part of the deterministic output (sorted, hashed) so re-import is idempotent.
5. **Dashboards-as-config + alert-as-code from day one.** SigNoz ships a Terraform provider (dashboards *and* alerts), a Dashboards V2 API, and JSON import/export; alert types include **traces-based scheduled-query alerts** with documented time-aggregation/evaluation semantics and "no data" alerts. Translate: our embedded debugger UI should read dashboards/alert definitions from versioned JSON/YAML in the repo (PR-reviewable), backed by scheduled SQL over read models; ship a `handoffgraph alerts check` dry-run for CI.
6. **OTel Collector as an explicit ingest boundary with control-plane reconfiguration (OpAMP).** Apps never write to ClickHouse; the collector distro owns batching, cardinality limits, tail sampling, PII scrubbing, and is remotely reconfigured via an OpAMP server. Translate (Cloudflare-only): a Worker-based ingest endpoint that replays this role — OTLP-in, deterministic event-ID derivation, cardinality/fail-closed redaction at the edge before D1/R2 writes; keep adapters thin and idempotent (our `ErrHookConflict` posture matches their "never hand-edit generated files" philosophy).
7. **Retention semantics: per-signal TTLs applied to new data only; TTL = permanent delete.** SigNoz defaults 15d traces/logs, 30d metrics. Translate: apply TTL-style retention to *derived* read models and compacted artifacts, never silently to the append-only spine; document explicitly (unlike SigNoz) what survives deletion — our evidence-based checkpoints are exactly the thing a generic observability TTL destroys, which is a differentiator, not a gap to copy.
8. **Licensing boundaries worth copying structurally.** MIT core / AGPL satellites / proprietary `ee/` with directory fences and dual entrypoints is a deliberate, legible open-core map. For Apache-2.0 HandoffGraph: keep everything in-repo Apache-2.0; if we ever gate hosted-tier code, fence it in a directory with its own LICENSE and separate build target; never vendor code from `signoz-otel-collector`/`foundry` (AGPL) — patterns only.

## 1.8 What SigNoz does NOT do for LLM/agent workflows (our opening)

- **No verification or provenance anywhere.** Everything is fire-and-forget telemetry; there is no OBSERVED/DECLARED/INFERRED distinction, no evidence chains, no deterministic replay, no cryptographic/deterministic hashing of session state. Claude Code spans are *beta*; the primary path is metrics/logs with **cost as float USD "estimates"** ("for billing data, refer to your Anthropic Console") — directly at odds with our decimal-string, evidence-based cost records.
- **No cross-agent continuity or handoff graph.** Sessions are opaque `session.id` attributes; there is no model of "agent A hands context to agent B", no checkpoint/resume, no worktree/git-state linkage, no continuity verification. Trace Funnels approximate workflow shape but only from spans you already emit.
- **No local-first mode.** Minimum viable deployment is ClickHouse + Keeper + collector + SigNoz binary (≥4 GB) — a server fleet, not a laptop CLI. Nothing runs offline or syncs later.
- **Content handling is opt-in-knob-based**, not fail-closed pipeline-based: prompt capture toggles (`OTEL_LOG_RAW_API_BODIES`, 60 KB truncation) are exporter-side, and a wrong region/key "silently drops all data" — the opposite of our fail-closed redaction and fail-loud ingest contract.
- **No session debugging primitives**: no transcript-level turn reconstruction, no tool-call→file-diff correlation, no determinism guarantees on any read model (ClickHouse queries are not reproducible-by-construction), no idempotent re-import story for telemetry.

## 1.9 Sources (SigNoz)

- https://github.com/SigNoz/signoz (README, tree, deploy/README.md deprecation note)
- https://github.com/SigNoz/signoz/blob/main/LICENSE · /blob/main/ee/LICENSE (license split, verified)
- https://api.github.com/repos/SigNoz/signoz · /repos/SigNoz/signoz-otel-collector · /repos/SigNoz/foundry (stars, licenses)
- https://github.com/SigNoz/signoz-otel-collector/commit/733f95093852d5c2821ef94fccf25c1ab7077a69 (AGPL added 2026-05-29)
- https://signoz.io/docs/architecture/ (components: SigNoz binary, collector, ClickHouse, OpAMP, ruler, alertmanager)
- https://signoz.io/docs/install/docker/ (Foundry runbook, ports, 4 GB, MCP setup)
- https://signoz.io/docs/llm-observability/ (gen_ai.* conventions, 46 integrations, alert guidance, cost-at-query-time)
- https://signoz.io/docs/claude-code-monitoring/ (native OTel env vars, captured metrics/events, beta spans, opt-in content)
- https://signoz.io/docs/userguide/writing-clickhouse-traces-query/ (full spans/error/lookup table schemas, bucketing, fingerprint CTE)
- https://signoz.io/docs/userguide/retention-period/ (15/30-day defaults, TTL semantics)
- https://signoz.io/docs/manage/administrator-guide/configuration/relational-database.md (SQLite default / Postgres metadata)
- https://signoz.io/pricing.md (feature matrix Community/Teams/Enterprise, pricing)
- https://signoz.io/llms.txt · https://signoz.io/docs/sitemap.md · https://signoz.io/blogs/sitemap.md (doc maps; "Zoe" absence check)

---

# PART 2 — OpenObserve

## 2.1 Position & pitch

**What it is.** OpenObserve (O2) is a Rust, single-binary, cloud-native observability platform for logs, metrics, traces, RUM/session replay, pipelines and AI/LLM observability, pitched as an open-source **Datadog/Splunk/Elasticsearch alternative** with "**140x lower storage cost**" (Parquet + S3-native), "single binary deployment — up and running in under 2 minutes", SQL + PromQL (no proprietary query language), and ~¼ the hardware of Elasticsearch. [Source: README](https://github.com/openobserve/openobserve)

**Datadog-alternative story.** Comparison tables vs Datadog (self-host vs SaaS-only, per-GB vs per-host+per-GB), vs Elasticsearch (140x storage, single binary, ¼ resources), vs Splunk, vs the Grafana LGTM stack ("one platform, no multi-tool stitching"). Cloud free tier 50 GB/day; OSS edition described as "feature-complete and production-ready… will always remain actively maintained and free to use without restrictions"; 6,000+ orgs; largest deployment "2+ PB/day"; $10M Series A (April 2026, Nexus Venture Partners + Dell Technologies Capital). [Source: README](https://github.com/openobserve/openobserve), [Source: llms.txt](https://openobserve.ai/llms.txt)

**LLM/agent observability fit.** AI Observability is a first-class product surface: "track cost, tokens, latency percentiles, and error rates across models, with **agent graphs, session traces, and evaluation/quality scoring**"; multi-agent visibility via W3C context propagation; **configurable model pricing** ("match your real billing rates"); per-span input/output inspection; unified schema normalization across frameworks. Integration list is enormous: ~20 providers, ~45 frameworks/agent SDKs (incl. **Claude Agent SDK, Claude Code tracing, GitHub Copilot tracing, LangChain/LangGraph, CrewAI, AutoGen, Pydantic AI, Temporal**), 6 AI gateways (LiteLLM Proxy, OpenRouter, Portkey, Kong…), eval tools (Promptfoo, Ragas, Trubrics), **MCP server** ("query observability from any AI agent") and MCP-interaction tracing. OpenLLMetry is supported via standard OTLP ingestion (dedicated how-to blog for LangChain/LlamaIndex via OpenLLMetry). [Source: llms.txt](https://openobserve.ai/llms.txt), [Source: LLM Observability](https://openobserve.ai/llm-observability/)

## 2.2 Architecture

Verified from [architecture docs](https://openobserve.ai/docs/architecture/), README, and the repo's `Cargo.toml` workspace:

- **Rust workspace, ~30 crates**: `openobserve-core`, `src/db`, `src/search` + `search_service`, `openobserve-api-{http,grpc,ingest,search,management,pipelines}`, `openobserve-jobs`, `openobserve-mcp`, `promql{,-service}`, `metrics_index`, `src/enterprise/o2_*` behind a cargo `enterprise` feature flag; Vue.js web UI embedded via `rust-embed-for-web`. Toolchain: Rust edition 2024, version **0.93.0**, `publish = false`, allocator options mimalloc/jemalloc(+pprof). Query stack: **DataFusion 54 + Arrow 58 + Parquet 58 + `object_store` (aws/azure/gcp)**, `sqlparser`, forked `promql-parser`, and an experimental **Vortex** columnar format fork. Metadata: **sea-orm over sqlx with `sqlx-sqlite` and `sqlx-postgres`** — the same code path serves SQLite (single-node) and PostgreSQL (HA). [Source: Cargo.toml](https://github.com/openobserve/openobserve/blob/main/Cargo.toml)
- **Node types (5)**: Router (proxy + GUI), Ingester (stateful: WAL+memtable+local parquet), Compactor (merge small files, **enforce retention**, update file-list index), Querier (fully stateless), Scheduler (alert queries, report jobs, notifications). Horizontal scaling for all five in HA mode.
- **Deployment modes**: (a) **single node, SQLite + local disk** (default; "ingest and search over 2 TB/day… ~31 MB/s ≈ 2.6 TB/day on an Apple M2 with default config"); (b) **single node, SQLite + object storage** (`ZO_LOCAL_MODE_STORAGE` + S3/GCS/MinIO/Azure vars — durability without a cluster); (c) **HA mode**: Kubernetes+Helm, object storage required, **PostgreSQL for metadata** (orgs, users, functions, alert rules, stream schema, file list) and **NATS** for cluster coordination/events/node info. HA mode does not support local disk.
- **Ingest pipeline (per docs)**: HTTP/gRPC receive → parse line-by-line → run ingest functions → timestamp normalized to **microseconds** (or now()) → **schema-evolution check under lock** → evaluate real-time alerts → **WAL append in hourly buckets** (`data/wal/logs`) + Arrow RecordBatch into a **Memtable** (one per `organization/stream_type`) → Memtable sealed at `ZO_MAX_FILE_SIZE_IN_MEMORY=256 MB` or WAL at `ZO_MAX_FILE_SIZE_ON_DISK=128 MB` → sealed "Immutable" persisted to local parquet every `ZO_MEM_PERSIST_INTERVAL=5 s` → every `ZO_FILE_PUSH_INTERVAL=10 s`, small files merged per partition (≤ `ZO_COMPACT_MAX_FILE_SIZE=2048 MB`) after `ZO_MAX_FILE_RETENTION_TIME=600 s` and pushed to object storage. Queries must union Memtable + Immutable + unuploaded wal-files.
- **Query path**: leader querier parses/verifies SQL → time range → **file list from the file-list index** → partitions files across queriers → gRPC fan-out to workers → merge results. Queriers cache parquet in memory (default `ZO_MEMORY_CACHE_MAX_SIZE` = **50% of node RAM**); optional ingester-notifies-querier caching of fresh files. Federated search across clusters (Enterprise, "Super Cluster").
- **Durability stance**: deliberately single-copy in flight ("Why a single in-flight copy is fine") — EBS/S3 durability arguments, no in-app replication, low RPO/RTO via statelessness.
- **Data immutability**: "All data in OpenObserve is **immutable** — once ingested, it cannot be modified or deleted (only entire retention periods can be dropped). This is by design." [Source: README FAQ](https://github.com/openobserve/openobserve)

## 2.3 Feature inventory

- **Signals**: logs (full-text + SQL + quick filters + VRL pipelines), metrics (SQL/PromQL, 19+ chart types), traces (OTLP; waterfalls/flamegraphs/Gantt; **service graph**), RUM (Core Web Vitals, error tracking, **session replay**), incidents (alert correlation + lifecycle).
- **Dashboards**: drag-and-drop, 19+ chart types / "200+ visualization variations", template variables, geo maps, import/export.
- **Alerts**: threshold, scheduled, real-time, anomaly, composite types; alert history; notification channels (Slack, Teams, email, PagerDuty, webhooks); **incidents** module; alerts managed in-UI ("no YAML required" vs Prometheus Alertmanager).
- **Pipelines**: visual editor — source → transform (VRL functions/conditions) → destination; enrich/redact/reduce/normalize at ingest; logs-to-metrics conversion; **prebuilt destination catalog** (`config/prebuilt-destinations.json`).
- **AI observability**: agent graphs, session traces, token/cost/latency tracking, evaluation & quality scoring views, custom model pricing tables, per-span prompt/response inspection. O2 AI Assistant (NL→SQL/VRL/PromQL) and AI SRE Agent — Enterprise/Cloud only. MCP server for external agents.
- **Multi-tenancy**: native organizations/streams as first-class concepts with data isolation; org-level routing via OTel Collector.
- **Enterprise-gated**: SSO (SAML/OIDC/OAuth/LDAP), advanced RBAC (custom roles), audit trails, Sensitive Data Redaction (SDR) at ingest/query, federated search/Super Cluster, AES-256-SIV/Tink encryption, query & workload management (QoS). NOTE: llms.txt FAQ says Self-Hosted Enterprise is **free up to 50 GB/day and includes SSO, RBAC, and audit trail**. [Source: llms.txt](https://openobserve.ai/llms.txt)
- **APIs**: REST for ingestion (`/api/{org}/{stream}/_json`, OTLP endpoints, Elasticsearch bulk-compatible), SQL search APIs, trace search API, dashboards/alerts CRUD; "pure API spec guard" CI workflow in repo.
- **Compliance**: SOC 2 Type II, ISO 27001, GDPR, HIPAA-ready (BAA with Enterprise).

## 2.4 Integration surface

- **OTel-native**: OTLP HTTP/gRPC is the blessed path ("The native path. Any signal, any language."); docs recommend OTel Collector DaemonSet/sidecar for K8s; **OpenLLMetry works via standard OTLP** (dedicated guide: "add distributed tracing to LangChain and LlamaIndex apps using OpenLLMetry and the OpenTelemetry SDK, with traces flowing into OpenObserve"). [Source: llms.txt](https://openobserve.ai/llms.txt)
- **Agent install models**: single docker container; single binary (`download.sh`); Helm chart (HA, "under five minutes"); Cloud. No agent process needed for app telemetry — instrument apps with OTel SDKs; log shipping via FluentBit/FluentD/Vector/Filebeat/Logstash/Kinesis/syslog; metrics via Prometheus scrape/remote-write/Telegraf/CloudWatch pull; `curl` JSON ingest for ad-hoc loads.
- **Claude Code (first-party hook, verified from docs source)**: a Python hook script wired into Claude Code's hook system. Reads hook payload (session_id, transcript_path) on stdin; **incrementally tail-reads the transcript JSONL** using byte-offset+partial-line state stored in `~/.claude/state/openobserve_state.json` guarded by an flock (state pruned after 7 days); assembles **turns** (user msg → assistant msgs deduped by message.id → tool_results by tool_use_id); emits OTel spans — root "Claude Code - Turn N" (`session.id`, `claude_code.*`), child "Claude Response" (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.{input,output,cache_read,cache_write}_tokens`), child "Tool: {name}" spans (`gen_ai.tool.name`, `call.id`, `arguments`, `result`). **Fail-open everywhere** (`except: pass`, "Never block", exits 0 on any failure); text truncated at 20,000 chars with `{truncated, orig_len, sha256}` metadata; enabled by `TRACE_TO_OPENOBSERVE=true` + `OPENOBSERVE_AUTH_TOKEN`. [Source](https://openobserve.ai/docs/integration/ai/claude-code-tracing/)

## 2.5 Traction & licensing

- **Traction (GitHub API, 2026-08-27)**: 21,511 stars, 1,058 forks, 579 open issues, created 2023-02-02. GitHub lists primary language "TypeScript" (the Vue frontend dominates file counts), but the engine is Rust (llms.txt: "Language: Rust (backend), Vue.js (frontend)"; llms.txt's "19,000+ stars" is stale). 6,000+ organizations; 2 PB/day largest deployment (vendor-claimed).
- **License**: **AGPL-3.0** for the open-source edition (repo LICENSE verified as full AGPL-3.0 text; GitHub API `agpl-3.0`; Cargo.toml `license = "AGPL-3.0"`), plus a separate commercial Enterprise License Agreement. They **moved from Apache to AGPL** deliberately, with an explainer blog ("Why AGPL… free commercial use, improvements stay open"). [Source: README](https://github.com/openobserve/openobserve), [Source: blog](https://openobserve.ai/blog/what-are-apache-gpl-and-agpl-licenses-and-why-openobserve-moved-from-apache-to-agpl/)
- **Implications for Apache-2.0 HandoffGraph**: AGPL-3.0 is the most viral common license: §13 extends copyleft to **network use** — if we incorporated OpenObserve code (or AGPL-derived code) into anything users interact with over a network (our Cloudflare hosted tier) or distribute in our CLI, we would be obliged to release that combined work under AGPL, killing Apache-2.0 compatibility. **Rules of engagement: (a) never copy or translate-to-Go any OpenObserve source, including config defaults with copyrightable structure** — reading docs/architecture pages and re-implementing ideas is fine (ideas aren't copyrighted; patents are not asserted here but note them); (b) do not link their crates — they aren't published anyway (`publish = false`); (c) their AGPL move is itself the strategic lesson: a storage engine vendor chose AGPL specifically to stop cloud/competitor freeriding — as an Apache-2.0 project we must compete on verification/continuity value, not license lock-in, and should keep our Cloudflare-only hosted tier clearly separated from the OSS core so no AGPL question ever arises.**

## 2.6 Local runbook (single node)

```bash
docker run -d \
  --name openobserve \
  -v $PWD/data:/data \
  -p 5080:5080 \
  -e ZO_ROOT_USER_EMAIL="root@example.com" \
  -e ZO_ROOT_USER_PASSWORD="Complexpass#123" \
  public.ecr.aws/zinclabs/openobserve:latest
# UI: http://localhost:5080  (login = the env credentials above)

# Load sample data and verify
curl -L https://zinc-public-data.s3.us-west-2.amazonaws.com/zinc-enl/sample-k8s-logs/k8slog_json.json.zip -o k8slog_json.json.zip
unzip k8slog_json.json.zip
curl -u "root@example.com:Complexpass#123" -H "Content-Type: application/json" \
  http://localhost:5080/api/default/default/_json -d "@k8slog_json.json"
# expect {"code":200,"status":"ok","records":1000}
```

- **First-run admin setup**: none beyond the two env vars — root user is provisioned from `ZO_ROOT_USER_EMAIL`/`ZO_ROOT_USER_PASSWORD`; org "default" and stream "default" exist implicitly (URL pattern `/api/{org}/{stream}/_json`).
- **Resource footprint**: no official RAM minimum is published today. The relevant verified numbers: single-node SQLite+disk handles ~31 MB/s (~2.6 TB/day) ingest on an M2 per their tests; defaults that dominate memory are `ZO_MEMORY_CACHE_MAX_SIZE` (querier parquet cache = 50% of RAM), memtable seal at 256 MB, WAL at 128 MB per org/stream_type; SIMD-enabled image recommended for heavy full-text search ("Performance issues → Consider the SIMD Docker image"). For a laptop-class agent-telemetry workload, a small container (hundreds of MB) is realistic but **unverified officially — treat as estimate**.
- **Other install modes**: bare binary via `download.sh`/`downloadO2.sh`; SQLite+object-storage single node (`ZO_LOCAL_MODE_STORAGE=s3` + S3 vars); HA via Helm (requires K8s + object storage + PostgreSQL + NATS, ≥1 of each node type). [Source: architecture](https://openobserve.ai/docs/architecture/), [Source: quickstart](https://openobserve.ai/docs/quickstart/)

## 2.7 Top 8 concrete lessons for HandoffGraph

1. **The WAL→memtable→immutable→parquet tiering is the exact shape of our spine→read-model→artifact flow.** Their ingest writes an append-only WAL in **hourly buckets**, converts to in-memory Arrow batches, seals to immutable local parquet every 5 s, then compacts and ships to object storage on size (128–256 MB) or age (600 s) triggers. Translate: our append-only SQLite event spine *is* the WAL; derived graph/trace read models are the memtable equivalents (rebuildable); periodic compaction to immutable, content-addressed artifacts (R2 parquet/JSONL) should trigger on the same two axes — event-count and age — with deterministic output.
2. **SQLite-as-metadata, object-storage-as-truth maps 1:1 onto D1+R2.** Single-node OpenObserve keeps orgs/users/schemas/file-list in SQLite while all telemetry bytes live in parquet on S3; HA swaps SQLite→Postgres behind the *same* sea-orm code (`sqlx-sqlite`/`sqlx-postgres`). Translate: our storage layer should be one interface with two drivers — pure-Go SQLite locally, D1/R2 hosted — so the graph reducer never knows which. Their "file list index in the metadata DB" pattern is precisely how our hosted tier should index compacted artifacts in D1.
3. **Hourly buckets + file-list pruning before any scan.** WAL partitioned by hour; queriers consult the file-list index and prune by time range before opening files. Translate: every D1/SQLite query over events must carry a time-bucket predicate derived from an indexed bucket column (same lesson as SigNoz's `ts_bucket_start`, independently converged on by a parquet/S3 system — strong signal it's universal).
4. **Single-binary local-first is a deliberate product strategy, not an accident.** Default SQLite, embedded Vue UI (rust-embed), no external services, "running in under 2 minutes", env-var-first configuration (`ZO_*`), stateless-ish nodes with tiny state surface. Translate: keep HandoffGraph a single Go binary with embedded web debugger and zero required services; our "10,000-event ingestion + crash/reopen" property tests are the local-first equivalent of their WAL-recovery guarantee.
5. **Immutability as a marketed feature.** "Data cannot be modified or deleted — only retention periods dropped… a feature for compliance." This is our existing rule ("do not mutate stored events; derive read models") stated as product value — we should say it as loudly as they do, and extend it: our redaction is fail-closed *before* write, so there is no "warn and export original" failure mode; their Enterprise SDR (ingest/query-time redaction) is the paid add-on version of what we ship in OSS.
6. **Ingest-time transform pipelines with a visual editor (VRL) — but best-effort.** Pipelines enrich/redact/reduce/normalize at ingest with ordered functions and schema evolution under lock. The gap we exploit: their transforms are best-effort (functions can drop/alter data with no verdict recorded); our adapters must record a deterministic transform verdict per event (accepted/rejected/redacted, with hashes) so the spine stays verifiable evidence, not just telemetry.
7. **Scheduler-as-node for scheduled-query alerts and reports.** Alerts are decoupled from ingest (real-time alerts on hot path, scheduled/anomaly/composite via the Scheduler). Translate for Cloudflare-only: Cron Triggers + Workflows evaluating scheduled SQL over read models, with alert history as an append-only event type in our own spine — eat our own dog food (they store alert history in a separate module; we can make alerts *events*).
8. **AGPL boundary discipline.** Learn the architecture from their docs; never lift code or distinctive config structures. Also copy their *transparency* move in reverse: they explain "why AGPL is good for the community"; we should publish an explicit "what we borrow from OpenObserve/SigNoz is ideas-only" provenance note in docs so there's never ambiguity in due diligence.

Bonus (call it 8.5): their **Claude Code hook is the closest shipped competitor to our Claude Code adapter** — incremental JSONL tail with offset state, turn assembly, tool spans, token usage, fail-open. Ours must differentiate on: fail-closed redaction, deterministic event IDs (idempotent re-import — their hook dedupes only by in-file message IDs and can re-emit on state loss), provenance labels, and verification (they emit telemetry; we build evidence).

## 2.8 What OpenObserve does NOT do for LLM/agent workflows (our opening)

- **Telemetry, not evidence.** No verification, no provenance taxonomy, no deterministic reducers or replay; the Claude Code hook is explicitly **fail-open** ("Never block", silent `sys.exit(0)` on any error) — data can be silently lost, and mutable local state (`~/.claude/state/openobserve_state.json` offsets) means crashes can duplicate or skip turns. Nothing is checkpointable or resumable as *verified* continuity.
- **No cross-agent handoff semantics.** Traces stitch via W3C context propagation *if instrumentation cooperates*; there is no model of agent↔agent continuity, no session-graph, no "what did agent B know when it started" query, no evidence-based checkpoints, no git/worktree state correlation.
- **Truncation destroys evidence**: 20,000-char cap on prompts/tool IO (metadata records sha256, but the payload is gone for the platform); raw content is bounded by design — fine for monitoring, fatal for debugging/forensics.
- **Costs are estimates from a pricing table** ("custom model pricing… without relying on generic published estimates") — floats at query time, not decimal-string recorded facts tied to observed usage.
- **Evals are dashboards over traces** (Ragas/Promptfoo/Trubrics integrations), not verified evaluations; AI Assistant/SRE agent are Enterprise/Cloud-gated and LLM-dependent — the opposite of our no-LLM-calls verification stance.
- **Not local-first in our sense**: it *is* a single binary, but it's a *server* you run and point exporters at; there's no CLI-first, offline-capable, per-developer model with later sync, and no MCP stdio server for an agent's own continuity (their MCP is for querying observability from agents).
- **Mutability of user-visible data is zero but correctness is best-effort**: no out-of-order handling guarantees, no idempotency contract on ingestion (re-POST = duplicates), no deterministic ordering story — our out-of-order/idempotency/deterministic-hash properties are exactly the guarantees they don't offer.

## 2.9 Sources (OpenObserve)

- https://github.com/openobserve/openobserve (README incl. docker run, comparisons, FAQ immutability, license section)
- https://github.com/openobserve/openobserve/blob/main/LICENSE (AGPL-3.0, verified) · /blob/main/Cargo.toml (Rust workspace, DataFusion/Arrow/Parquet/sqlx-sqlite+postgres/sea-orm, enterprise feature flag, v0.93.0)
- https://api.github.com/repos/openobserve/openobserve (21,511 stars, AGPL-3.0, created 2023-02-02)
- https://openobserve.ai/docs/architecture/ (node types, ingest/query flows, WAL/memtable/immutable/parquet, ZO_* defaults, SQLite vs Postgres vs NATS, 31 MB/s single-node)
- https://openobserve.ai/docs/quickstart/ (docker run, sample-data load, `/api/default/default/_json`)
- https://openobserve.ai/llms.txt (facts: Rust/Vue, AGPL+commercial, funding, 6,000+ orgs, AI integration catalog, MCP, enterprise-free-50GB claim, LangChain/LlamaIndex-via-OpenLLMetry guide)
- https://openobserve.ai/llm-observability/ (agent graphs, session traces, evals, custom model pricing)
- https://openobserve.ai/docs/integration/ai/claude-code-tracing/ (full hook source: incremental JSONL tail, turn assembly, gen_ai.* spans, fail-open, truncation)
- https://openobserve.ai/blog/what-are-apache-gpl-and-agpl-licenses-and-why-openobserve-moved-from-apache-to-agpl/ (Apache→AGPL rationale)

---

# Cross-cutting notes for the gap analysis

1. **Both converge on time-bucket pruning + fingerprint/identity pre-filtering + immutable telemetry + scheduled-query alerts.** Those four patterns are table stakes for our hosted read models on D1/Analytics Engine; neither is optional.
2. **Neither does verification, provenance, or cross-agent continuity.** Their unit of trust is "the SDK said so"; ours is "the evidence says so." That is the entire product opening, and both vendors' Claude Code integrations (SigNoz via native OTel metrics/logs with beta spans; OpenObserve via a fail-open Python hook) confirm demand for coding-agent telemetry without satisfying continuity/debugging.
3. **License asymmetry favors caution**: SigNoz core = MIT (learn freely, cite), SigNoz collector/foundry = AGPL, OpenObserve = AGPL everywhere. For an Apache-2.0 project the rule is: patterns yes, code no.
4. **Cloudflare translation cheat-sheet**: ClickHouse `ts_bucket_start` ORDER BY → D1/SQLite indexed bucket column + Analytics Engine rollups; parquet-on-S3 → R2 artifacts; file-list index → D1 table; NATS/queue → Cloudflare Queues; Scheduler node → Cron Triggers/Workflows; OpAMP-controlled collector → Worker ingest endpoint with deterministic IDs; SQLite-default-metadata → D1 (same split OpenObserve already proves works at scale with sea-orm).

# Gaps / unverified items

- **"Zoe" (SigNoz)**: no trace of any such component in docs sitemap, blog sitemap, org repos, or code. Either internal codename, misremembered, or removed. Not included as fact.
- **"SPLA-1.1" (SigNoz)**: not present in any current SigNoz repo/license file. Verified license history documented instead (MIT → MIT+ee → MIT Expat + `cmd/enterprise`; collector AGPL since 2026-05-29). If SPLA-1.1 ever existed, it is no longer in effect in public repos.
- **OpenObserve RAM minimum**: no official current figure; only cache/memtable defaults and the M2 ingest benchmark are citable.
- **SigNoz exact current release**: ≥ v0.137 inferred from latest upgrade guide; not pinned via releases API.
- Star/issue counts are point-in-time (2026-08-27 GitHub API).
