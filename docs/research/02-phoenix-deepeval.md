# Research: Eval-Platform Gap Analysis — Arize Phoenix vs Confident AI DeepEval (for HandoffGraph)

## Summary
Phoenix is a self-hostable **AI observability server** (Python backend, React UI, SQLite/Postgres storage) built on OpenTelemetry + the OpenInference span spec, free under Elastic License 2.0 with no feature gates; DeepEval is a **library-first, zero-server eval framework** (pip/pytest, Apache-2.0) whose metrics run locally and whose visibility UI is the paid Confident AI cloud. Neither models **coding-agent session continuity** (cross-agent handoffs, file edits, tamper-evident evidence chains, fail-closed redaction) — that is exactly HandoffGraph's differentiation surface.

Verification notes: all licenses, star counts, and download figures below were checked against the GitHub repos, `pyproject.toml` files, PyPI, and official docs (facts as of late Aug 2026). DeepEval internals were verified directly from a cloned checkout (`/private/tmp/pi-github-repos/162a4bfcc3ede0418b17d145319cfb1dc0068b4ea37b2f903aca0ba106d085e0`).

---

# REPORT A — Arize Phoenix

## A1. Position & pitch
- **What it is:** "Open-source AI observability platform designed for experimentation, evaluation, and troubleshooting" — a web UI + trace collector + SQL storage that you self-host (or use Phoenix Cloud). Tagline: "Trace, evaluate, experiment, and optimize AI with full transparency and control."
- **Eval-first story:** Tracing is the substrate; evals, datasets/experiments, and the prompt playground are the iteration loop on top: "score outputs using evaluation tests to identify failures and regressions, iterate on prompts using real production examples, and optimize your app with experiments that compare changes on the same inputs."
- **Who uses it:** Teams building LLM apps/agents (OpenAI Agents SDK, Claude Agent SDK, LangGraph, LlamaIndex, CrewAI, DSPy, Vercel AI SDK, Mastra integrations); marketed at "teams building production agents," with a scale-up path to Arize AX (the paid, separate enterprise platform).

## A2. Architecture
- **Backend language(s):** Python server (pip package `arize-phoenix`, requires Python ≥3.10) serving the trace collector (OTLP over **gRPC :4317** and HTTP :6006) plus a **GraphQL + REST API** and a **React/TypeScript** front end (repo shows TypeScript/React/Relay tooling; server skills reference GraphQL + database patterns).
- **Storage:** Two backends — **SQLite is the default** (data in `~/.phoenix/` or `PHOENIX_WORKING_DIR`), **PostgreSQL ≥14** for production/multi-user via `PHOENIX_SQL_DATABASE_URL`. A dedicated `arize-phoenix-sqlean` package extends SQLite. Single-tenant per instance; scale out by running more instances against one DB (or per-team instances). DB is accessed through SQLAlchemy-style URL config; Phoenix handles schema migrations.
- **Deployment:** `python -m phoenix.server.main serve` (or `phoenix serve`), Docker (`arizephoenix/phoenix:latest`, incl. `-nonroot`/`-debug` variants), Docker Compose, Helm/K8s, CloudFormation, pip/conda. Explicitly "free to self-host with no feature limitations… fully air-gapped."

## A3. Feature inventory (OSS vs paid)
**Open source (self-hosted Phoenix, ELv2 — all features included):**
- **Trace ingestion:** OTel-native (OTLP gRPC + HTTP); auto-instrumentation for dozens of frameworks/providers via OpenInference conventions; manual instrumentation via `arize-phoenix-otel` (a thin OTel wrapper with Phoenix-aware defaults).
- **OpenInference semantic conventions:** span kinds `LLM, CHAIN, AGENT, TOOL, RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR` with standardized attributes (`input.value`, `output.value`, `llm.model_name`, `retrieval.documents`, `embedding.*`…).
- **Evals:** separate lightweight SDK packages — `arize-phoenix-evals` (Python + TypeScript) with built-in **LLM evaluators** (faithfulness, Q&A correctness, relevance, conciseness, hallucination-class judges) and **code evaluators** (exact match, regex, heuristics); unified `LLM` wrapper (OpenAI/Anthropic/Google/LiteLLM); batch eval over DataFrames (`evaluate_dataframe` / `async_evaluate_dataframe`); custom evaluators via `create_evaluator`; evaluator-accuracy benchmark datasets. Results log back into the UI as annotations / EVALUATOR spans. Uses your own model keys.
- **Datasets & experiments:** versioned datasets of examples; experiments = runs of a dataset version through a task with evaluators; REST API now covers dataset splits and experiment tags.
- **Prompt playground & prompt management:** compare prompt variants side-by-side, replay traced LLM calls in the playground, Prompt Hub with versioning/tagging.
- **Annotations:** span, trace, and **session** annotations via REST/SDK (`/v1/trace_annotations`, `/v1/session_annotations`, span annotations in TS client) — label, score, explanation, annotator identity, metadata.
- **Sessions:** group traces by `session_id` into conversation threads with cross-turn metrics; session-level evaluations (session-scoped judges over whole transcripts).
- **Embeddings:** UMAP point-cloud embedding views of datasets/traces + embedding **drift** analysis (two-dataset projection comparison).
- **PXI (Phoenix Intelligence):** built-in AI engineering agent for debugging traces/iterating prompts; trace-filter expressions and **read-only analytics SQL over MCP** (20.3.0+).
- **Remote MCP server:** `/mcp` endpoint on your instance so Claude Code/Cursor/Codex can query traces, datasets, experiments (Cursor deeplink install in README).
- **pytest/Vitest/Jest plugin (new, 2025–2026):** `@pytest.mark.phoenix` in `arize-phoenix-client ≥2.10.0` — marked test file → dataset, each `parametrize` case → example, each run → experiment, assert outcome → reserved `pass` annotation; pytest exit code is the CI gate.
- **Access control:** role-based RBAC (OSS); resource-scoped tags "planned for later in 2026."

**Paid (Arize AX — separate product):** managed SaaS with longer retention (15d Free → custom Enterprise), collaboration, SOC2/HIPAA/SSO/SLA, higher spans limits. Phoenix itself has **no** paid feature gates; Arize monetizes the hosted AX platform, not Phoenix.

## A4. Integration surface
- **OTel + OpenInference** everywhere; OTLP gRPC 4317 / HTTP 6006; traces also flow to Datadog/Honeycomb/Tempo (OTel-native claim).
- **SDKs:** Python (`arize-phoenix` incl. client, `-otel`, `-evals`, `-client`, `-sqlean`) and TypeScript (`@arizeai/phoenix-client`, `@arizeai/phoenix-otel`); REST + GraphQL APIs with OpenAPI spec; remote MCP server; agent-assisted setup (`npx -y @arizeai/phoenix-cli setup`).
- **CI:** pytest plugin (also Vitest/Jest) recording experiments from CI; OpenTelemetry Collector friendly.

## A5. Traction (verified late Aug 2026)
- **Stars:** ~11.1k (GitHub API snapshots 11,132–11,151), ~1.07k forks, ~930–950 open issues. Repo created 2022-11-09.
- **Downloads:** `arize-phoenix` core ≈ **2.2–2.4M/month** (pypistats/pyrank); vendor claims "3M+ downloads" across packages.
- **Activity:** extremely active — `arize-phoenix` v20.4.0 released 2026-08-26 with breaking-change changelogs; sub-packages versioned independently (evals 3.5.1, client 3.3.0, sqlean 0.1.1).
- **License (important correction):** the *server* is **Elastic License 2.0 (ELv2)** — not Apache. `arize-phoenix-otel` was relicensed to Apache-2.0 earlier, and `arize-phoenix-client` followed on 2025-11-19 (issue #9890 → PR #10332) precisely because ELv2 blocked OSS interoperability. GitHub displays license as "Other."

## A6. Local runbook
```bash
# 1) Server + UI (ELv2, free)
pip install arize-phoenix
python -m phoenix.server.main serve        # or: phoenix serve
# → Web UI http://localhost:6006, OTLP gRPC :4317, SQLite in ~/.phoenix (PHOENIX_WORKING_DIR)

# Docker alternative
docker run -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest

# 2) Send traces (Apache-2.0 otel package)
pip install arize-phoenix-otel openinference-instrumentation-openai
python - <<'PY'
from phoenix.otel import register
tp = register(project_name="demo", endpoint="http://localhost:6006/v1/traces")
from openinference.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument(tracer_provider=tp)
# ...call OpenAI SDK; trace appears in the UI
PY

# 3) Evals + experiments (evals SDK is vendor-optional)
pip install arize-phoenix-evals arize-phoenix-client

# 4) Notebook mode
# python: import phoenix as px; px.launch_app()
```

## A7. Top 6 lessons for HandoffGraph
1. **Adopt OpenInference/OTel as an export surface, not the spine.** Phoenix proves a standardized span taxonomy (`openinference.span.kind` + attributes) makes a store instantly consumable by the whole ecosystem. HandoffGraph's Go event spine can derive **OTLP-compatible spans** (AGENT/LLM/TOOL/EVALUATOR kinds) as a read model — we stay deterministic and append-only internally while gaining free interop with Jaeger/Phoenix/Datadog and any OTel Go SDK.
2. **Evals and feedback are data, not code, in the store.** Phoenix models eval results as EVALUATOR spans *and* annotations (span/trace/session) with score+label+explanation+annotator. For HandoffGraph: checkpoint/verify verdicts should be first-class append-only events with provenance (OBSERVED vs INFERRED judge), attachable at turn-, session-, or handoff-granularity.
3. **Sessions are the unit of debugging.** Phoenix's `session_id` grouping + session-level annotations ("did the session achieve its goal?") maps 1:1 to HandoffGraph's cross-agent session continuity — steal the session-level evaluation framing (per-turn can pass while the session fails).
4. **Versioned datasets × experiments = reproducible iteration.** Dataset *versions* + experiment runs (dataset-version × task × evaluators) with REST-managed splits/tags is the right model for HandoffGraph checkpoints: an immutable snapshot + derived replay runs, hash-pinned for determinism (matches our deterministic-reducer/hash invariants).
5. **Local SQLite default with a one-env-var Postgres path.** Phoenix's `~/.phoenix/` SQLite default → `PHOENIX_SQL_DATABASE_URL` upgrade mirrors our local-first SQLite (modernc.org/sqlite) → Cloudflare D1 hosted path; env-var-driven config + single binary/container + air-gap support is the distribution shape to match.
6. **Test-framework integration as a CI gate.** Phoenix's pytest plugin (test file→dataset, case→example, assert→`pass` annotation, exit code as gate) is a blueprint for `hgraph verify` as a CI command: each checkpoint replay becomes a recorded experiment-like run in the local DB, with a plain exit code for pipelines.

## A8. What Phoenix does NOT do (differentiation openings)
- **No coding-agent domain model.** Traces are generic LLM/agent spans: no file edits/diffs, no plan/act cycles, no agent-to-agent **handoffs**, no importers for Claude Code/Codex/Pi session JSONL. Our event spine speaks the native formats of coding agents.
- **No evidence/verification layer.** No tamper-evident hashes, no "verified checkpoint" concept, no OBSERVED/DECLARED/INFERRED provenance discipline. HandoffGraph's deterministic-hash verification is a real differentiator.
- **No fail-closed redaction.** Phoenix keeps data local (air-gap) but has no redaction pipeline, let alone fail-closed semantics.
- **No LLM-free quality gates.** Evals/playground presume model calls (your keys); HandoffGraph's evidence-based checkpoints need zero LLM calls.
- **Still client-server, not a CLI.** Local-first but you run a server; no single-binary `hgraph`-style CLI + embedded debugger over a plain local DB. Also **no Go SDK** (Python/TS only).
- **ELv2 strings attached.** ELv2 forbids offering the Phoenix server itself as a competing managed service; Apache-2.0 HandoffGraph can be embedded/OEM'd freely.
- Openings we can also take: **session-filter/eval expression language** and **read-only SQL over MCP** (Phoenix added these only in Aug 2026 — evidence the debugging UX frontier is still moving), and **PXI-style in-product agent**, which depends on hosted models rather than a strictly local evidence store.

## A9. Sources (kept)
- GitHub README/repo: https://github.com/Arize-ai/phoenix (features, packages, MCP, stars, languages)
- Self-hosting architecture: https://arize.com/docs/phoenix/self-hosting/architecture (SQLite/Postgres, tenancy, scaling)
- Self-hosting + license: https://arize.com/docs/phoenix/self-hosting , https://arize.com/docs/phoenix/self-hosting/license (ELv2, free, air-gap, Docker/Helm)
- License switch PRs: https://github.com/Arize-ai/phoenix/issues/9890 , https://github.com/Arize-ai/phoenix/commit/ee6f6ee15deca45430aff2732fb5ac7253d82522 (client → Apache-2.0)
- pyproject.toml: https://github.com/Arize-ai/phoenix/blob/master/pyproject.toml (Elastic-2.0, Python ≥3.10)
- Evals: https://arize.com/docs/phoenix/evaluation/llm-evals , https://arize.com/docs/phoenix/evaluation/pre-built-metrics , https://arize.com/docs/phoenix/sdk-api-reference/python/arize-phoenix-evals (evaluators, DataFrame batch, packages)
- pytest plugin: https://arize.com/docs/phoenix/evaluation/integrations/pytest , https://github.com/Arize-ai/phoenix/pull/13874
- Sessions/annotations: https://arize.com/docs/phoenix/tracing/tutorial/sessions , https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/capture-feedback , REST `/v1/trace_annotations`, `/v1/session_annotations` docs
- OpenInference spec: https://arize-ai.github.io/openinference/spec/semantic_conventions.html
- Releases: https://github.com/Arize-ai/phoenix/releases , https://arize.com/docs/phoenix/release-notes (v20.4.0, filter expressions, SQL-over-MCP)
- Traction: https://pypistats.org/packages/arize-phoenix , https://pyrank.org/package/arize-phoenix/
- Dropped: aitoolsatlas.ai / llmtools.cc / cekura.ai pricing blogs (SEO commentary; superseded by arize.com/pricing and docs), mintlify mirror pages where canonical arize.com docs existed.

---

# REPORT B — Confident AI DeepEval

## B1. Position & pitch
- **What it is:** "The LLM Evaluation Framework" — open-source (Apache-2.0) unit-testing framework for LLM apps, "similar to Pytest but specialized for unit testing LLM apps," built by Confident AI's founders. Runs **locally on your machine** (LLM-as-judge via any LLM, or statistical/NLP models).
- **Eval-first story:** evals are literally tests: `LLMTestCase` in, metrics with 0–1 score + threshold + human-readable `reason` out, pass/fail via pytest semantics. Evals are the *primary* artifact; tracing exists to serve evaluation (trajectory and component-level metrics over span trees).
- **Who uses it:** Python (and now TypeScript) devs/SDETs adding LLM quality gates to CI — RAG, chatbots, agents; org-scale users get pushed to Confident AI (the platform) for collaboration/monitoring. FAQ frames it as "Next.js (deepeval) vs Vercel (Confident AI)."

## B2. Architecture
- **Library-only, no server.** A pip package (`deepeval`, Python ≥3.9 <4.0; TS SDK in-repo `typescript/`, published to npm) — no backend to run, no DB to host. Verified from `pyproject.toml`: pytest plugin entry point (`[tool.poetry.plugins."pytest11"] deepeval = "deepeval.plugins.plugin"`), CLI app (`deepeval = 'deepeval.cli.main:app'`, typer/click).
- **Local state:** a hidden `.deepeval/` cache dir (`DEEPEVAL_CACHE_FOLDER`, default `.deepeval`) holding metric cache, keystore, telemetry file (`.deepeval_telemetry.txt`), and `.latest_test_run.json` artifacts; `DEEPEVAL_RESULTS_FOLDER` exports timestamped JSON of the latest run; `deepeval view` (textual TUI, `inspect` extra) reads it; `npx deepeval inspect` for TS. `DEEPEVAL_FILE_SYSTEM=READ_ONLY` stops all writes; `DEEPEVAL_DISABLE_DOTENV=1` disables auto-`.env` loading (it auto-loads `.env.local` then `.env` **at import time** — a notable behavior).
- **Tracing model:** proprietary developer API — `@observe(type="llm"|"retriever"|"tool"|"agent")` decorators, `trace()` context manager, `update_current_span`/`update_current_trace`. A trace is the ordered tree of spans; the trace's top-level fields are an `LLMTestCase` (end-to-end evals) and each span is itself an `LLMTestCase` (component-level evals). In 4.x the implementation sits on `opentelemetry-api/sdk ^1.24.0` (verified in pyproject; release notes fix "otel integration"), but visibility of traces is designed for **Confident AI's Observatory**, not a local UI.
- **Deployment:** your pytest run is the deployment. Cloud (optional): `deepeval login` → `CONFIDENT_API_KEY`; when set, results/traces auto-upload (US/EU endpoints); Confident AI offers managed cloud or **self-hosted-in-your-cloud** (AWS/Azure/GCP) as paid deployment.

## B3. Feature inventory (OSS library vs Confident AI platform)
**Open-source `deepeval` (Apache-2.0):**
- **Metrics (all output 0–1 score + reason; LLM-as-judge via G-Eval/QAG/DAG, deterministic judges where possible):**
  - Custom: **G-Eval** (LLM-judge on any plain-language criteria), **DAG** (deterministic graph-structured judge builder).
  - Agentic: Task Completion, Tool Correctness, Goal Accuracy, Step Efficiency, Plan Adherence, Plan Quality, Tool Use, Argument Correctness (+ community `AgentLoopDetectionMetric`, `ToolPermissionMetric` — deterministic, v4.1.3).
  - RAG: Answer Relevancy, Faithfulness, Contextual Recall/Precision/Relevancy, RAGAS composite.
  - Multi-turn: Knowledge Retention, Conversation Completeness, Turn Relevancy/Faithfulness, Role Adherence.
  - **MCP metrics:** MCP Task Completion, MCP Use, Multi-Turn MCP Use.
  - Multimodal: Text-to-Image, Image Editing/Coherence/Helpfulness/Reference.
  - Other: Hallucination, Summarization, Bias, Toxicity, JSON Correctness, Prompt Alignment.
- **Custom metrics:** subclass/`G-Eval`/`create_metric` — integrated with the same ecosystem (platform-compatible).
- **Datasets & goldens:** `EvaluationDataset`/`Golden` (single- and multi-turn), synthetic dataset generation; SDK support for golden update/delete (4.1.6); `evals_iterator()` streams goldens through your app while tracing + evaluating.
- **Tracing SDK** (`@observe`, span types, tags/metadata) + framework integrations: LangChain/LangGraph callbacks, OpenAI/Anthropic wrappers, OpenAI Agents, Pydantic AI, CrewAI, LlamaIndex, Google ADK, AWS AgentCore, Strands; TS: AI SDK (`configureAiSdkTracing`), Mastra (`DeepEvalExporter`).
- **Benchmarks:** MMLU, HellaSwag, DROP, BBH, TruthfulQA, HumanEval, GSM8K, ARC, BBQ, BoolQ, LogiQA, MathQA, SQuAD, Lambada, IFEval, EquityMedQA — "any LLM in <10 lines."
- **Pytest + CI:** native plugin; `deepeval test run` (wraps pytest; flags `-xdist`, `--repeat` + `--cache` cached metric results, `--ignore-errors`, `--skip-on-missing-params`, `--mark`, `--official` baseline gating); plain `evaluate()` for notebooks; standalone `metric.measure(test_case)`.
- **Extras:** prompt optimizer ("optimize prompts automatically based on evaluation results"), red-teaming (DeepTeam sibling OSS), voice features (4.1.10), MCP-server support (4.1.8), agent-distribution: repo ships `skills/` (deepeval, deepeval-tracing, deepeval-otel) plus `.claude-plugin/` and `.cursor-plugin/` marketplace manifests so coding agents install DeepEval and write eval suites for you.

**Paid Confident AI platform:** cloud persistence of datasets/eval reports (sharable), regression tracking with `--official` baselines, trace Observatory + production monitoring with **online evals on live traffic**, annotation queues/workflows, no-code custom metrics, org-wide governance/standards, red-teaming enforcement, managed cloud or self-hosted-in-your-cloud, its own TS SDK + **OTLP ingest** + MCP server (`confident-mcp-server`) as a persistence layer for Claude Code/Cursor. Pricing: Free / **$200/mo** / Enterprise.

## B4. Integration surface
- **Pytest-first** (plugin entry point) and any CI; pytest-xdist/repeat/rerunfailures bundled as deps.
- **Tracing:** native decorator model; **OTel story is platform-side** — Confident AI accepts raw **OTLP/HTTP** traces from *any* OTel SDK/language with `x-confident-api-key` header and `confident.span.*`/`confident.trace.*` attributes (span types `agent/llm/retriever/tool`; parent/child from native OTel span context; HTTP-only, no gRPC; GenAI-semconv fallbacks documented). The OSS library itself does not export OTLP to arbitrary backends.
- **SDK languages:** Python (PyPI) + TypeScript (npm); everything else via framework integrations.
- **Env/config:** `CONFIDENT_API_KEY` (unset ⇒ fully local), `.env.local`/`.env` auto-load, per-metric model customization (any LLM incl. local via custom LLM class / Ollama in dev deps).

## B5. Traction (verified late Aug 2026)
- **Stars:** ~17.4–17.9k (GitHub API snapshots 17,432 → 17,851 within days), ~1.8k forks, ~420–470 open issues. Repo created 2023-08-10. Trendshift-listed; blog notes crossing 15k stars.
- **Downloads:** PyPI project page shows ≈ **5.9M downloads/month** (293k/day, 1.3M/week) — several× Phoenix's core package, consistent with a library (installed everywhere) vs a server.
- **Activity:** very high cadence — v4.1.9 released 2026-08-21, 4.1.x series through Aug 2026, 2026 year-in-review changelog; multiple GitHub workflow suites (test_core, test_metrics, typescript_*).
- **License:** Apache-2.0 (verified in `pyproject.toml` and LICENSE.md).

## B6. Local runbook
```bash
pip install -U deepeval          # Apache-2.0; Python ≥3.9
export OPENAI_API_KEY="..."      # judge model (or a custom LLM class; optional login below)

# optional — only for Confident AI cloud sync (evals run fine without it):
# deepeval login

cat > test_chatbot.py <<'PY'
import pytest
from deepeval import assert_test
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCase, SingleTurnParams

def test_case():
    correctness = GEval(
        name="Correctness",
        criteria="Determine if the 'actual output' is correct based on the 'expected output'.",
        evaluation_params=[SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT],
        threshold=0.5,
    )
    assert_test(LLMTestCase(
        input="What if these shoes don't fit?",
        actual_output="You have 30 days to get a full refund at no extra cost.",
        expected_output="We offer a 30-day full refund at no extra costs.",
    ), [correctness])
PY

deepeval test run test_chatbot.py    # pytest under the hood; writes .deepeval/.latest_test_run.json
deepeval view                        # TUI over the local run artifact (textual extra)

# Trajectory/component-level evals without pytest:
#   from deepeval.tracing import observe, update_current_span
#   @observe() ... app(...)  →  trace tree evaluated by TaskCompletionMetric
```
No server, no DB, no container. Fully offline except the judge-model API call (which can also be a local model).

## B7. Top 6 lessons for HandoffGraph
1. **Library-first distribution works — stay zero-dependency-local.** DeepEval proves the "cloud optional, local complete" split: one install, runs offline, uploads only when an API key exists, explicit `READ_ONLY`/telemetry-opt-out switches. HandoffGraph's local-first CLI already matches this shape; copy the affordances (opt-in sync, no mandatory account, documented local artifacts dir).
2. **Standardize a small, serializable "test case" vocabulary.** `LLMTestCase` (input/actual_output/expected_output/retrieval_context/tools_called…) is the atomic unit every metric consumes. HandoffGraph should define the equivalent **session test case** vocabulary over its event spine (turn, tool call, file edit, handoff, checkpoint) so metrics/checks are uniform, golden-serializable, and deterministic-hashable.
3. **One metric contract everywhere.** Score 0–1 + threshold + human-readable `reason` (+ error path), and two metric kinds: LLM-judge and deterministic code. HandoffGraph's no-LLM checkpoints should emit the same verdict shape (label/score/explanation + evidence pointer) so a future optional LLM-judge metric slots in without schema churn — and provenance (OBSERVED deterministic vs INFERRED judge) rides along.
4. **Make traces evaluable at both ends.** DeepEval evaluates a trace end-to-end *and* every span independently (trajectory metrics over the ordered span tree). Our trace materializer can expose each derived span/turn as a checkable unit (tool-arg correctness, handoff validity) plus whole-session verdicts — that's the "component-level eval" idea applied to coding-agent sessions.
5. **Regression gating via a pinned baseline run.** `--official` marks the baseline test run on the platform for regression comparison; `--repeat`+`--cache` makes CI cheap. HandoffGraph: `hgraph verify` should support a pinned baseline checkpoint + cached deterministic results + non-zero exit on regression — a CI gate without any server.
6. **Ship your tooling as agent skills/plugins.** DeepEval's `.claude-plugin`/`.cursor-plugin` manifests and `skills/` (plus Confident AI's MCP-as-persistence) turn the product into something Claude Code/Cursor/Codex can *use autonomously*. HandoffGraph's 9-tool MCP server should ship matching skill manifests so agents can drive session import, verify, and debug loops — this is now table stakes in this category.

## B8. What DeepEval does NOT do (differentiation openings)
- **No local observability UI.** Traces are only *viewable* in Confident AI cloud; locally you get terminal output + JSON artifacts. HandoffGraph's **embedded web debugger UI** over local data is a direct differentiator.
- **No self-hostable OSS server at all.** The persistence/collaboration layer is paid cloud (or paid self-hosted-in-your-cloud); the OSS library alone has no durable store beyond JSON/cache files. HandoffGraph's append-only SQLite spine + optional D1 is the missing middle.
- **Not a session store / no continuity model.** Evals are sample-in/sample-out; there's no long-lived record of coding-agent sessions, no cross-agent handoff graph, no session replay, no integration with Claude Code/Codex/Pi session files (DeepEval *tests* agents; it doesn't *record* them).
- **Python/TS only, needs a runtime.** A Go toolchain can't embed it; HandoffGraph is a single static Go binary.
- **No evidence/tamper-evidence, no redaction.** No cryptographic verification of stored runs, no fail-closed redaction pipeline, default-on PostHog telemetry + import-time `.env` auto-load (opt-outs exist but are opt-out, not opt-in) — trust posture HandoffGraph can beat with fail-closed redaction and no-phone-home defaults.
- **LLM-judge costs & nondeterminism** are inherent to most of its metric value; deterministic judges exist (DAG, JSON correctness, loop detection) but there's no notion of *verified* results. "Deterministic, evidence-based, zero-LLM session verification" is ours alone.

## B9. Sources (kept)
- GitHub README/repo + cloned checkout: https://github.com/confident-ai/deepeval (metrics taxonomy, integrations, quickstart, license); pyproject.toml at clone root (v4.2.0, Apache-2.0, pytest11 plugin, OTel deps); `deepeval/config/settings.py` (`.deepeval` cache), `deepeval/telemetry.py`, `skills/deepeval-tracing/references/tracing.md`, `skills/deepeval-otel/SKILL.md` (Confident AI OTLP ingest, `confident.*` attributes)
- Docs: https://deepeval.com/docs/getting-started , https://deepeval.com/docs/evaluation-llm-tracing , https://deepeval.com/docs/metrics-introduction , https://deepeval.com/docs/environment-variables , https://deepeval.com/docs/command-line-interface , https://deepeval.com/docs/evaluation-flags-and-configs (`--official`), https://deepeval.com/docs/faq (library vs platform split)
- G-Eval / judges: https://www.confident-ai.com/docs/metrics/custom-metrics/g-eval , https://www.confident-ai.com/docs/llm-evaluation/core-concepts/llm-as-a-judge
- Hallucination metric: https://www.confident-ai.com/docs/metrics/single-turn/hallucination-metric.mdx
- CI/CD unit-testing: https://documentation.confident-ai.com/llm-evaluation/evaluation-features/unit-testing-in-cicd
- Pricing/platform: https://www.confident-ai.com/pricing , https://www.confident-ai.com/frameworks/deepeval
- PyPI: https://pypi.org/project/deepeval/ (license, downloads, versions)
- Releases: https://github.com/confident-ai/deepeval/releases (4.1.x series, community deterministic metrics, MCP/voice), https://deepeval.com/changelog
- Dropped: aitestingguide.com DeepEval review (SEO commentary; facts re-verified from primary docs).

---

## Gaps (both reports)
- Exact current star counts move daily; reported as verified ranges (Phoenix ~11.1k, DeepEval ~17.4–17.9k) from two GitHub API snapshots days apart in late Aug 2026.
- Phoenix: which PXI capabilities require hosted LLMs vs fully-local models is not fully documented; the ELv2 → "free self-host" boundary is explicit, but enterprise-support packaging around self-hosted Phoenix is sales-gated.
- DeepEval: precise on-the-wire behavior of 4.x trace storage when no API key is set (what exactly persists in `.deepeval/` beyond the latest-run JSON) was inferred from docs/env-var references, not runtime-verified.
- Neither project publishes benchmark-accuracy numbers for their judges in a single canonical place; we did not independently audit metric quality.

## Supervisor coordination
No blockers or decisions needed; returning the completed brief. (No progress_update sent — no plan change.)
```

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings returned with file paths and sources: license fields verified at github.com/Arize-ai/phoenix/blob/master/pyproject.toml (Elastic-2.0) and cloned deepeval pyproject.toml v4.2.0 (Apache-2.0, pytest11 plugin, opentelemetry-api/sdk deps); local-state paths verified in deepeval/config/settings.py (DEEPEVAL_CACHE_FOLDER=.deepeval) and docs (~/.phoenix/, PHOENIX_WORKING_DIR, PHOENIX_SQL_DATABASE_URL); stars/downloads verified via GitHub API snapshots and PyPI/pypistats. Severity not applicable (research-only, no code changed)."
    }
  ],
  "changedFiles": [
    "/Users/arbaz/.pi/agent/sessions/--Users-arbaz-Projects-tools-handoffgraph--/subagent-artifacts/outputs/50e6aa4e-c9b7-46a3-813c-86ad857ff6b5/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Verified Phoenix license via pyproject.toml (Elastic-2.0) and license-switch PR #10332 (client/otel → Apache-2.0)",
    "Verified Phoenix storage backends (SQLite default ~/.phoenix, Postgres ≥14) from arize.com/docs/phoenix/self-hosting/architecture",
    "Verified DeepEval Apache-2.0, ~17.4-17.9k stars, ~5.9M PyPI downloads/month, pytest11 entry point and OTel deps from cloned repo",
    "Verified local runbooks: python -m phoenix.server.main serve (UI :6006, OTLP gRPC :4317) and deepeval test run (GEval example from official README)"
  ],
  "residualRisks": [
    "Star/download counts drift daily; reported as ranges verified late Aug 2026",
    "DeepEval 4.x local trace persistence when no cloud key is set inferred from docs/env vars, not runtime-verified",
    "Phoenix PXI hosted-vs-local model dependency not fully documented; noted as gap"
  ],
  "noStagedFiles": true,
  "diffSummary": "New research artifact only: two-platform eval landscape brief (Phoenix + DeepEval) with verified facts, runbooks, 6 HandoffGraph lessons each, and differentiation gaps",
  "reviewFindings": [
    "no blockers",
    "correction worth propagating: Phoenix server is ELv2, not Apache-2.0 (GitHub shows license 'Other'); only arize-phoenix-client (Nov 2025) and arize-phoenix-otel are Apache-2.0 — relevant to HandoffGraph license comparisons",
    "note: DeepEval's OTel support is a Confident-AI-platform ingest path (OTLP/HTTP + confident.* attributes); the OSS library's tracing is a proprietary @observe model — do not conflate in the gap analysis"
  ],
  "manualNotes": "Report written to the authoritative output path in a single write; both reports include the 9 requested sections; acceptance criteria evidence = review-findings and residual-risks fields above."
}
```