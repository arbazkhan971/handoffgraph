# Research: LLM Observability / Agent-Management Tier — Helicone, Lunary, Agenta, LangWatch

*Compiled 2026-08-28 for the HandoffGraph gap analysis. All GitHub metadata pulled live from the GitHub API on this date; quotes from official docs/READMEs.*

## Cross-project snapshot

| | **Helicone** | **Lunary** | **Agenta** | **LangWatch** |
|---|---|---|---|---|
| Repo | Helicone/helicone | ~~lunary-ai/lunary~~ **DELETED** | Agenta-AI/agenta | langwatch/langwatch |
| Stars | 6,106 | ~1.1–1.3k at deletion (unverifiable now) | 4,568 | 3,514 |
| License | Apache-2.0 | Apache-2.0 (survives only in community archives) | MIT core + separate `ee/` license | Apache-2.0 floor + Enterprise (`platform/app/ee/`) |
| Languages | TypeScript | TypeScript (Bun monorepo) | TypeScript (31MB) + Python (20MB) | TypeScript + Go (gateway) + Python (evals/NLP) |
| Last push | 2026-08-26 | ~Oct 2025 (repo removed ~Dec 2025) | 2026-08-27 | 2026-08-27 |
| Latest release | v2025.08.21-1 (deploys continuously; sparse GH releases) | v1.11.12 (2025-10-21; 195 releases total) | rolling GHCR images | v3.17.0 (2026-08-27, release-please automated) |
| Status | Very active (YC W23) | **OSS dead; SaaS continues, repo 404** | Very active — pivoted to agent workspace | Very active — expanding into coding-agent testing |

---

# 1. Helicone (github.com/Helicone/helicone)

## 1.1 Position & pitch
"AI Gateway & LLM Observability Platform for AI Engineers" (YC W23). The pitch is two products sharing one integration: (a) an **AI gateway** — access 100+ models through one OpenAI-compatible API with routing and automatic fallbacks; (b) **observability** — logs, cost/latency analytics, traces and "sessions" for agents. Its signature move is **zero-code integration**: you log every request by changing the client `baseURL` (e.g. `baseURL: "https://ai-gateway.helicone.ai"`, `apiKey: HELICONE_API_KEY`) — no SDK code change. An async OpenLLMetry-based path exists for when a proxy is undesirable. Cloud free tier: 10k requests/month; SOC 2 + GDPR compliance marketed for enterprise.

## 1.2 Architecture
Five/six services (from README + official self-host architecture docs):
- **Web** — Next.js 14 + React + Tailwind, port 3000. Dashboard, traces, prompt UI, user/org management.
- **Jawn** — Node.js/Express + TypeScript + Tsoa (OpenAPI), port 8585. Main REST API: request logging, prompt versioning, analytics aggregation, webhooks, datasets.
- **Worker** — TypeScript. In cloud: **Cloudflare Workers**. Self-hosted: Node.js processes — OpenAI Proxy (:8787), Anthropic Proxy (:8790), Gateway API (:8789, unified routing/fallbacks), Helicone API (:8788, async logging).
- **PostgreSQL 17** (Supabase in cloud) — users, orgs, API keys, prompt versions, feedback (Better Auth for sessions).
- **ClickHouse 24.3** — request metadata/logs (`request_response_rmt` etc.), properties, scores, `cache_hits`. Chosen for billion-row aggregations and ~10x compression; default 90-day TTL.
- **MinIO (S3)** — request/response bodies, prompt bodies, `hql-store` query results. Bodies referenced by ID from ClickHouse — deliberate separation of hot metadata from fat blobs.
- HQL ("Helicone Query Language") for analytics queries. Enterprise Helm chart is **gated behind contacting sales**.

## 1.3 Feature inventory (OSS vs cloud/enterprise)
- **Logging/tracing**: request logs, sessions/agent tracing, playground to replay prompts/traces — core product, Apache-2.0.
- **Cost & latency analytics**, custom properties, user management (per-end-user tracking), webhooks, PostHog export — OSS.
- **Prompt management**: version prompts from production data, deploy via gateway without code changes — OSS.
- **Caching**: LLM response caching (Cloudflare **edge** cache in cloud — self-hosted gets ClickHouse cache tracking but not the Cloudflare edge layer). **Rate limits**, **virtual keys/budgets**, **fallbacks/routing** — gateway features, strongest in cloud.
- **Evaluations/scoring UI**, fine-tuning handoff to partners (OpenPipe, Autonomi) — OSS/cloud.
- **Enterprise**: SOC 2 workflows, Helm chart, advanced support; some gateway providers (Vertex/Bedrock/Azure) are **cloud-only — explicitly unsupported self-hosted**.

## 1.4 Integration surface
JS/TS + Python SDKs; cURL; proxy mode for OpenAI/Anthropic/Azure/Gemini/Bedrock/Ollama/LangChain/Vercel AI SDK; async OpenLLMetry logging; AI Gateway (OpenAI-compatible unified API, 100+ providers); PostHog export.

## 1.5 Traction & maintenance
6,106 stars, 658 forks, Apache-2.0, pushed 2026-08-26 (daily activity). GitHub *releases* are sparse (last v2025.08.21-1) because deployment is continuous — a discoverability weakness. 151 open issues. Very much alive.

## 1.6 Local runbook
```bash
git clone https://github.com/Helicone/helicone.git
cd helicone/docker && cp .env.example .env
./helicone-compose.sh helicone up
# Web :3000, Jawn API+proxy :8585, MinIO :9080; workers :8787/:8788 if run separately
```
Or the all-in-one image: `docker run -d --name helicone -p 3000:3000 -p 8585:8585 -p 9080:9080 helicone/helicone-all-in-one:latest`.
**Actual requirements / gotchas (official docs):** 6 services incl. ClickHouse + Postgres + MinIO — heavy (docs' own sizing suggests 8–16GB for ClickHouse alone at scale); **no email service in the container** (manual user verification in DB); **only OpenAI + Anthropic proxy routes supported self-hosted**; **port 8585 proxy requires no auth** ("Anyone with access can proxy LLM requests through your endpoint"); container restarts wipe data unless volumes are mounted; self-hosted HTTPS needs your own reverse proxy; Helm is enterprise-gated.

## 1.7 Top 4 lessons for HandoffGraph
1. **Zero-code integration wins adoption.** One `baseURL` swap beats SDK work for uptake. HandoffGraph's adapter installs (idempotent, fail-closed hooks) are the equivalent — keep the "one command, no repo edits" story sacred and market it like Helicone markets the proxy.
2. **Split storage by access pattern.** Hot relational metadata (Postgres) vs analytics columnar (ClickHouse) vs blobs (S3/MinIO) is exactly HandoffGraph's local SQLite + hosted R2/Analytics Engine tiering — validate that bodies/payloads stay out of the indexed spine, referenced by deterministic ID.
3. **Self-host/parity drift destroys trust.** Helicone self-hosted lacks provider routes, edge cache, email, and Helm. HandoffGraph's commitment should be: *one binary, same features local and on Workers* — that is a marketable differentiator against Helicone's tiered reality.
4. **Security defaults matter in proxies.** An unauthenticated LLM-proxy port is a spend-fraud footgun. HandoffGraph's local MCP/API surfaces should authenticate by default and redact fail-closed before anything ever leaves the machine.

## 1.8 Cautionary notes
Even the biggest OSS player in this tier keeps its best operational features (edge cache, Helm, multi-cloud routes) out of the OSS build — "open source" as on-ramp, not parity promise. Continuous deployment with no meaningful GitHub releases makes auditing versions hard for self-hosters.

---

# 2. Lunary (lunary-ai/lunary) — ⚠️ REPO DELETED

## 2.1 Position & pitch
Was: "The production toolkit for LLMs. Observability, prompt management and evaluations." — agent monitoring/chatbot analytics: traces with error stack traces, chat replays, topic classification, user satisfaction, human reviews, PII masking, alerts. Today lunary.ai is live as **"The AI platform for enterprises"** (IBM, Zurich, Netomi, DHL logos) still claiming "Self Hostable", SOC 2 Type II + ISO 27001 — but the code is gone.

## 2.2 Architecture (as archived)
TypeScript/Bun monorepo (`packages/`, `bun.lock`); JS + Python SDKs posting to a REST API; self-hosting wired through a **separate infra repo (`lunary-ai/ops`) that was also deleted** (it was a git submodule of the main repo). Postgres-backed per archived docs; exact storage engines no longer verifiable from primary sources.

## 2.3 Feature inventory (as archived; all claims now unverifiable in code)
Traces & error stack traces, instant search/filter, label-for-fine-tuning; analytics (model usage/costs, frequent topics, satisfaction, custom dashboards); prompt templates with versioning and A/B testing; playground; human reviews; PII masking; multi-modal support; alerts; RBAC/SSO ("enterprise"); self-host or cloud.

## 2.4 Integration surface (as archived)
`lunary` PyPI + npm SDKs (one-line init), LangChain integrations, OpenAI/Anthropic/etc. Any-framework wrappers.

## 2.5 Traction & maintenance status
195 releases with steady cadence through **v1.11.12 on 2025-10-21** — then the GitHub repo went **404 by ~Dec 11, 2025** (documented by jimmysong.io as "an AI chat dev tool went 404"). The org still exists with side repos: `lunary-js` (pushed 2026-04-08), `abso` (TS multi-provider SDK, MIT, dormant since 2025-06), `lunary-py` (archived, merged into main monorepo). Community forks exist: `Tenount/backup-lunary` (archived snapshot, Apache-2.0) and `maxjeffwell/lunary` ("community edition"). **Do not treat Lunary as a viable OSS dependency.**

## 2.6 Local runbook
No official path exists anymore. Historical: `git clone https://github.com/lunary-ai/lunary && docker compose up` (infra in the now-deleted `ops` submodule). Today the only options are unsupported community snapshots — a dead end for self-hosters.

## 2.7 Top 4 lessons for HandoffGraph
1. **Vendor-controlled "open source" can vanish overnight.** Apache-2.0 is necessary but insufficient — governance and public commitment matter. HandoffGraph should state its license stewardship explicitly and never make the event spine's existence contingent on one company's mood.
2. **Category homogeneity is lethal at small scale.** Lunary offered traces+prompts+evals+dashboards+PII — the same list as Langfuse/LangWatch with a fraction of the resources. HandoffGraph must own a niche incumbents don't serve (verified cross-agent continuity and session debugging for *coding* agents), not the generic LLM-observability checklist.
3. **Feature breadth exceeded team size.** 195 releases in ~2.5 years across five feature areas, then abandonment. Scope HandoffGraph's hosted tier ruthlessly; the 10k-event/idempotency/determinism invariants are the product, not a UI feature race.
4. **Never orphan the deployment story.** Lunary deleted even its ops/infra repo. HandoffGraph's docker/compose + Workers deploy definitions must live in-repo, versioned with the code.

## 2.8 Cautionary tale (the sharpest of the four)
lunary.ai still advertises "Self Hostable" while the repo is 404 — the exact trust failure that makes buyers flee to Langfuse. If HandoffGraph ever sunsets the local/open tier while continuing the SaaS, it should expect the same reputational outcome.

---

# 3. Agenta (Agenta-AI/agenta)

## 3.1 Position & pitch
**Pivoted.** Was "the open-source LLMOps platform: prompt playground, prompt management, LLM evaluation, and LLM observability all in one place." Now: **"The open-source workspace for building and running agents"** — you build agents by chatting with them, wire them to apps, give them durable workspaces, and run them in the background on schedules/events. Critically for HandoffGraph: Agenta now treats **Claude Code, Pi, and Codex as first-class harnesses** it spawns and manages (Gemini, OpenCode on the roadmap), and even ships a self-hosting *skill* for coding agents (`npx skills add Agenta-AI/agenta-skills`). It positions against n8n/Zapier (workflows) and Claude Cowork (locked to Claude): "Agenta adds the shared workspace around that execution layer: files, team access, triggers, versions, and traces."

## 3.2 Architecture (official self-host architecture docs)
- **Traefik/Nginx** entrypoint (SSL/routing) → **Next.js web** (:3000) + two FastAPI services.
- **API Service** — Python/FastAPI/SQLAlchemy (:8000): core business logic, CRUD, evaluation coordination.
- **Services API** — Python/FastAPI (:8080): LLM-facing `/services/completion`, `/services/chat`, provider abstraction.
- **Worker pool** — Python, two container kinds: `worker-streams` (Redis Streams consumers for `records`, `events`, `spans` — including **OTLP span ingestion**) and `worker-queues` (TaskIQ: webhooks, triggers, interactions, evaluations) + cron.
- **Agent Runner** — Node.js/TypeScript sidecar (:8765): receives `/run`, **starts harness processes (Pi, Claude Code, Codex) in sandboxes** (local container default; Docker and Daytona cloud sandboxes), mounts durable working directories from the object store into each sandbox, relays server-side tools back without exposing full env.
- **Infrastructure**: PostgreSQL 17 (core / tracing / SuperTokens auth DBs), **Redis** (6379 volatile + 6381 durable; TaskIQ broker, streams, caching, rate-limit counters), **SuperTokens** (:3567, OAuth Google/GitHub), **SeaweedFS** (:8333) or any S3-compatible store (AWS S3, **Cloudflare R2**, MinIO) backing durable agent workspaces ("files… remounted automatically on the next turn, so agent workspaces survive sandbox teardown"). Helm chart with `postgresql.enabled` / `store.seaweedfs.enabled` toggles. Repo language mix: TypeScript 31MB, Python 20MB.

## 3.3 Feature inventory (OSS vs EE)
- **OSS (MIT core)**: agent workspace + chat building; **Claude Code/Pi/Codex harness support**; local/Docker/Daytona runtimes; background agents (schedules + app-event triggers); **human approval and per-tool permissions** (auto / needs-approval / blocked); tracing of every model+tool call with token usage and estimated cost; **agent config version history**; team sharing with role-based access; MCP server connections + Composio integration (1,000+ apps: Gmail, Slack, Notion, GitHub).
- **EE (`ee/` directories, separate license)**: historically SSO/advanced RBAC/enterprise features; directory-level split, so the boundary is inspectable.
- Legacy LLMOps features (prompt playground/evals) remain in the codebase but are no longer the headline.

## 3.4 Integration surface
agenta PyPI SDK; OpenAI-compatible provider abstraction (OpenAI, Anthropic, OpenRouter, Bedrock, Azure, Ollama, …); OTLP tracing pipeline (worker-streams spans); MCP (API-key + unauthenticated transports; OAuth planned); Composio; harness adapters (Claude Code, Pi, Codex); sandboxes (local, Docker, Daytona; E2B/Vercel/Cloudflare/Modal planned).

## 3.5 Traction & maintenance
4,568 stars, 644 forks, 310 open issues, pushed 2026-08-27 — active, funded (Agentatech UG), trending on Trendshift. License on GitHub reads "Other/NOASSERTION" because of the MIT+EE combo.

## 3.6 Local runbook
```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/Agenta-AI/agenta
cd agenta
git sparse-checkout set hosting/docker-compose api/oss/databases/postgres api/ee/databases/postgres
cp hosting/docker-compose/oss/env.oss.gh.example hosting/docker-compose/oss/.env.oss.gh
docker compose -f hosting/docker-compose/oss/docker-compose.gh.yml \
  --env-file hosting/docker-compose/oss/.env.oss.gh \
  --profile with-web --profile with-traefik up -d
# → http://localhost  (custom port: TRAEFIK_PORT=90 + URL env vars)
# upgrade: re-up with --pull always, then:
docker exec -e PYTHONPATH=/app -w /app/oss/databases/postgres/migrations/core \
  agenta-oss-gh-api-1 alembic -c alembic.ini upgrade head
```
**Gotchas (official docs):** needs real memory (web container OOM-restarts otherwise); the agent **runner requires `/dev/fuse`** and **docker.sock access** (docker group ≈ root); image tags must be pinned to published versions; Kubernetes via Helm for prod.

## 3.7 Top 4 lessons for HandoffGraph
1. **Independent validation of HandoffGraph's target surface.** Agenta — an observability company — pivoted to wrapping exactly Claude Code/Pi/Codex sessions with workspaces, versions, and traces. The "coding agents need continuity tooling" thesis is now consensus; HandoffGraph's differentiation must be *verification and debuggability* (deterministic reducers, evidence-based checkpoints, fail-closed redaction), not session capture alone.
2. **The runner/sandbox/durable-workspace pattern.** Harness process spawned per run in a sandbox, with a durable working dir remounted each turn from object storage, is a clean mental model HandoffGraph can mirror for checkpoint replay: local SQLite spine as the "durable workspace," hosted R2 as the remount tier.
3. **Approval gates and per-tool permissions as product surface.** "Which actions run automatically / need approval / are blocked" is exactly the checkpoint/verification UX HandoffGraph's evidence model implies — make approve/deny a first-class, persisted event.
4. **Directory-level EE licensing done honestly.** MIT core + `ee/` under a separate license keeps the boundary auditable. If HandoffGraph's Cloudflare-hosted tier ever needs an EE line, adopt the same per-directory pattern instead of license soup.

## 3.8 Cautionary notes
Self-hosting complexity crept up (sparse clone, three services + workers + Redis + SeaweedFS + FUSE + docker.sock + alembic). HandoffGraph's single-binary, pure-Go-SQLite local core is a genuine advantage — guard it. Also: Agenta's pivot orphaned its former LLMOps positioning mid-flight; pick a positioning you can hold for years.

---

# 4. LangWatch (langwatch/langwatch)

## 4.1 Position & pitch
"The platform for LLM evaluations and AI agent testing" — test/simulate/evaluate/monitor agents end-to-end. Pillars: **Scenario** (agent simulations against the full stack with user simulator + judge), **evals + observability + prompts in one loop** (trace → dataset → evaluate → optimize → re-test), **Optimization Studio**, datasets, and human annotation queues. Raised €1M pre-seed (Feb 2025, Passion Capital). OpenTelemetry-native, framework-agnostic, "no lock-in."

## 4.2 Architecture
- **App**: TypeScript/Node (Next.js-style platform app), same image powers cloud and self-host ("no separate community build").
- **v3 storage**: **ClickHouse replaced Elasticsearch as the primary data store**; **event-sourcing architecture** for "reliable, ordered processing of traces, evaluations, and experiment runs"; **S3 cold-storage tiering**; native ClickHouse backup/restore; auto-tuned `clickhouse-serverless` Helm subchart. Plus Postgres + Redis (compose/`npx` install them).
- **Python services**: `langevals` (evaluator/guardrail engine, on PyPI) and `langwatch_nlp` (DSPy-based optimization); optional Presidio PII evaluator (~670MB) and Lingua language detection.
- **Go AI Gateway**: separate binary (`services/aigateway/`) + Helm sub-chart — OpenAI/Anthropic-compatible proxy with virtual keys, hierarchical budgets, inline guardrails, provider fallback, claimed ~700ns hot-path overhead; ships signed, per-platform release binaries + CycloneDX SBOMs.
- **Deployment**: Docker Compose (`platform/app`), Helm (composable overlays), Hybrid/OnPrem data-residency modes; `npx @langwatch/server` local launcher (see runbook).

## 4.3 Feature inventory (OSS vs Enterprise)
- **Unlicensed self-host is uncapped**: unlimited members, teams, projects, traces — the full platform, self-hosted, free. This is the most generous open-core stance of the four.
- **OSS**: tracing (OTLP ingest), evaluations & LangeVals guardrails (block/modify responses in real time), datasets, Scenario simulations, prompt management (versions in **Git via GitHub integration**, prompt-version↔trace links), annotations/queues, Optimization Studio, AI Gateway, MCP server for Claude Desktop, OTel export of platform metrics/logs.
- **Enterprise** (`platform/app/ee/`): SSO (Auth0/Okta/Azure AD/Google/GitHub/GitLab), custom-role RBAC, SCIM, tamper-evident audit logs, gateway spend/budget webhooks, AI Governance (anomaly rules, OCSF/SIEM export, no-spy mode), extended retention, SLA.
- **Licensing behavior worth copying**: no license = uncapped OSS; expired license keeps working (fail-open on expiry, renewal logged); an invalid/forged key fails closed to the OSS baseline; SSO misconfiguration deliberately falls back to email-mode sign-in "so a typo cannot lock everyone out."

## 4.4 Integration surface
OTel/OTLP-native ingest (any OTel library works); SDKs: Python, TypeScript/JS, **Go**; framework integrations (LangChain/LangGraph, Vercel AI SDK, Mastra, CrewAI, Google ADK…); OpenAI-compatible gateway proxy; MCP server (use LangWatch from Claude Desktop/MCP clients); `npx @langwatch/server` + CLI (`langwatch login` minting user-scoped keys).

## 4.5 Traction & maintenance
3,514 stars, 355 forks, 816 open issues, pushed 2026-08-27; **v3.17.0 released 2026-08-27** (automated release-please cadence with SBOMs and signed gateway binaries). Extremely alive and shipping fast.

## 4.6 Local runbook
```bash
# Option A — one command, Node.js only (installs uv, postgres, redis,
# clickhouse, gateway binary, Langy runtime under ~/.langwatch/):
npx @langwatch/server          # → http://localhost:5560
# reset = rm -rf ~/.langwatch

# Option B — docker compose:
git clone https://github.com/langwatch/langwatch.git
cd langwatch/platform/app
cp .env.example .env
docker compose up -d --wait --build   # → http://localhost:5560

# Production: Helm (charts/langwatch + charts/clickhouse-serverless + charts/gateway)
```
Optional heavy evaluators off by default (`LANGWATCH_ENABLE_PRESIDIO=false`, `LINGUA=false`); Langy assistant on by default (~45MB, unsandboxed). This is the **best local runbook of the four** — `npx`-single-command with a clean `rm -rf` reset, versus Helicone's 6-container compose.

## 4.7 Top 4 lessons for HandoffGraph
1. **Event sourcing is converging on HandoffGraph's design.** LangWatch v3 rebuilt trace/eval/experiment processing on an event-sourced, ordered spine after outgrowing Elasticsearch. HandoffGraph's append-only event spine + deterministic reducers is validated by a well-funded competitor arriving at the same architecture from the observability side — but LangWatch has no *verification* layer (cryptographic evidence, fail-closed redaction, replayability guarantees). That's the gap to press.
2. **One-command local runbook is table stakes.** `npx @langwatch/server` with a self-contained `~/.langwatch` and clean reset should be the UX bar for HandoffGraph's installer story (single Go binary + embedded UI already beats it on dependencies — make the story equally crisp).
3. **Open-core licensing as a trust design.** Uncapped unlicensed self-host, EE behind `platform/app/ee/`, fail-open expiry, fail-closed invalid keys, no-lockout fallbacks — a mature, defensible model to emulate for HandoffGraph's future hosted-tier licensing.
4. **Competitive threat is explicit and near-term.** LangWatch's latest releases add **agent testing v2**, an **agent-plugin declaring "working context with langwatch ingest context"**, **agent-cache so "a code agent logs in once for a whole run"**, CLI auth for code agents, and a new authz engine. They are building directly toward coding-agent session/telemetry territory. HandoffGraph's window to own *verified continuity* (not just ingest) is real but narrowing.

## 4.8 Cautionary notes
Rapid v3 surface growth (gateway, simulations, governance, Langy assistant) with 816 open issues signals breadth-over-depth risk; the Langy assistant running "unsandboxed as you" locally is a security posture HandoffGraph should never adopt — its fail-closed, no-LLM local core is a differentiator.

---

# 5. Cautionary tales — why smaller players struggle vs Langfuse, and what HandoffGraph should avoid

1. **Homogeneity + low switching costs.** Every project here sells the same trio (traces, prompts, evals). The category leader (Langfuse) compounds via developer mindshare, docs/SEO, and generous OSS scope; the rest fight for the same keywords with less engineering leverage. Lunary (smallest) died; LangWatch survives by *differentiating* (simulations, governance, gateway) rather than out-Langfuse-ing Langfuse.
2. **"Open source" as branding is fragile.** Lunary deleted its repo (and its ops repo) while marketing "self-hostable" — the single most damaging move observed. HandoffGraph: keep Apache-2.0, keep deploy definitions in-repo, publish real releases/changelogs, and if a pivot ever comes, don't disappear the code.
3. **Self-host parity drift.** Helicone's self-hosted build lacks provider routes, edge caching, and Helm; docs carry warnings (no auth on the proxy port, data loss on restart). Users notice. HandoffGraph's promise — same Go core local (pure-Go SQLite) and on Cloudflare — should be enforced by CI, not marketing.
4. **Operational weight kills grassroots adoption.** Helicone (6 services incl. ClickHouse+MinIO) and Agenta (FUSE + docker.sock + Redis + SeaweedFS) demand real infrastructure; LangWatch's `npx`-style single entrypoint and Langfuse's simple container are why they spread. HandoffGraph's single static binary is the right instinct — never let the hosted tier's architecture leak backward into local setup requirements.
5. **Don't fight the harnesses — instrument them.** Agenta wraps Claude Code/Pi/Codex; LangWatch is adding agent plugins and code-agent auth. The durable position is neutral, verifiable, local-first continuity *under* the agent, with provenance-preserving evidence (OBSERVED/DECLARED/INFERRED) — a thing neither wrapper-approach can honestly claim.

---

# 6. Sources

**Kept (primary / official):**
- Helicone README + repo metadata — https://github.com/Helicone/helicone ; https://api.github.com/repos/Helicone/helicone
- Helicone self-host docker docs — https://docs.helicone.ai/getting-started/self-host/docker
- Helicone architecture (self-host) — https://mintlify.wiki/helicone/helicone/self-hosting/architecture
- Helicone self-host overview — https://docs.helicone.ai/getting-started/self-host/overview
- Agenta repo metadata + LICENSE + README — https://api.github.com/repos/Agenta-AI/agenta ; https://raw.githubusercontent.com/Agenta-AI/agenta/main/LICENSE ; https://raw.githubusercontent.com/Agenta-AI/agenta/main/README.md
- Agenta self-host quick start — https://agenta.ai/docs/self-host/quick-start
- Agenta system architecture — https://agenta.ai/docs/self-host/infrastructure/architecture
- LangWatch repo metadata + README — https://api.github.com/repos/langwatch/langwatch ; https://github.com/langwatch/langwatch
- LangWatch editions & licensing — https://langwatch.ai/docs/self-hosting/licensing
- LangWatch self-hosting overview — https://docs.langwatch.ai/self-hosting/overview
- Lunary release history — https://releasealert.dev/github/lunary-ai/lunary
- Lunary repo-deletion analysis — https://jimmysong.io/blog/ai-project-lunary-404/
- Lunary org + surviving SDK repos — https://github.com/lunary-ai ; https://api.github.com/orgs/lunary-ai/repos
- Lunary archived snapshot — https://github.com/Tenount/backup-lunary
- Lunary SaaS site (current) — https://lunary.ai

**Dropped:** mintlify.wiki copies duplicating live docs where live docs were reachable; third-party "alternatives/comparison" listicles (zairalabs.ai, agentbrisk.com, aipedia.wiki, launchvault.dev, o-mega.ai) — SEO commentary with unverified claims; DeepWiki mirrors (deepwiki.com) superseded by official architecture docs; fork mirrors of Agenta/Lunary content (Subh24ai, AlgoTech92, RBKunnela, djxqwq) — stale duplicates.

# 7. Gaps

- **Lunary exact star count at deletion** — unverifiable post-404; estimate ~1.1–1.3k from archived ecosystem context. Next step: Wayback Machine capture of the repo page if precision matters.
- **Lunary historical storage engines** — primary infra repo (`lunary-ai/ops`) deleted; Postgres confirmed via archives, ClickHouse unconfirmed. Next step: inspect `Tenount/backup-lunary/packages/` source.
- **Agenta EE feature list** — `ee/LICENSE` and `ee/` contents not enumerated in this pass; boundary confirmed as directory-based only.
- **Helicone OSS-vs-cloud feature matrix** — official docs don't publish a single authoritative table; cloud-only items (Vertex/Bedrock/Azure routes, edge cache, email, Helm) were triangulated from self-host docs + README. Next step: run both builds and diff surfaces empirically.
