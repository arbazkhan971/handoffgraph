# OTLP Ingest (P1 interop)

HandoffGraph is an **OpenTelemetry backend**: it accepts standard OTLP/JSON
trace exports and converts them into deterministic, append-only
`hfg.event.v1` events. Any emitter that speaks OTLP — OpenLLMetry, OpenLIT,
Arize Phoenix exporters, Claude Code native telemetry bridges, your own OTel
SDK — can feed the spine without a HandoffGraph SDK.

> Status: OTLP/**JSON** over HTTP is shipped. Protobuf and gRPC flavors are
> the next ingest work item (`docs/parity-plan.md` P1); protobuf-only
> emitters should run a converting collector in front for now.

## CLI

```bash
# One-shot import of an OTLP/JSON request body
handoffgraph otlp import ./export.json [--workstream ws_...]

# Local ingest listener (localhost by default; never expose it)
handoffgraph otlp serve --addr 127.0.0.1:4318
```

Endpoints:

| Route | Method | Notes |
|---|---|---|
| `/v1/traces` | POST | OTLP/JSON `ExportTraceServiceRequest` (spec-encoded enums: number or name; `int64` values as decimal string or number). Responds `ExportTraceServiceResponse`; rejected spans are reported via `partialSuccess` and never silently dropped. |
| `/healthz` | GET | liveness |

Body cap is 64 MiB. `application/x-protobuf` gets `415` with guidance.

Try it:

```bash
curl -X POST http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/json' \
  --data-binary @testdata/fixtures/otlp/genai_session.json
```

An OTel SDK exporting OTLP/HTTP JSON works with just environment variables:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # SDK support permitting
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

## Conversion contract

One OTLP span becomes a **`span.started` + `span.completed`/`span.failed`
pair** at the span's own start/end times, so durations, statuses, counters,
and root-span selection are derived by the *unchanged* deterministic trace
materializer. Each OTLP trace also yields `trace.started`/`trace.completed`;
each distinct session yields one `session.started`. Provider is `otlp`;
every event is `OBSERVED`.

### Deterministic identity (idempotent re-import)

All ids are derived via `internal/ids` deterministic helpers
(`sha256(prefix|key)` entropy):

| Id | Key |
|---|---|
| `evt_` span-start/end | `otlp|span-start|<traceHex>|<spanHex>` + boundary time |
| `evt_` trace-start/end | `otlp|trace-…|<traceHex>` + boundary time |
| `evt_` session-start | `otlp|session-start|<sessionKey>` + first-seen time |
| `spn_` | `otlp|<traceHex>|<spanHex>` + start time |
| `trc_` | `otlp|<traceHex>` (timestamp 0 — pure key function) |
| `ses_` | `otlp|<sessionKey>` (timestamp 0 — pure key function) |

Re-importing identical telemetry yields identical event ids → the store
rejects every duplicate → **replays are free**. Note: a duplicate is never
re-bound to a new `--workstream`; import into the intended workstream the
first time.

### Sessions and traces

Session key precedence (first hit wins): span attribute
`session.id` / `langfuse.session.id` / `handoffgraph.session_id` /
`session_id`; else the explicit key of the same OTLP trace seen in the same
batch; else `otlp-trace-<traceHex>`. Agent = resource `service.name`.

### Attribute mapping

| Input convention | Lands in |
|---|---|
| `gen_ai.request.model`, `gen_ai.system`, `llm.model_name`, `coding_agent.model` | event `model` |
| `gen_ai.tool.name`, `coding_agent.tool`, `execute_tool …` name | span kind `TOOL` + payload `tool_name` |
| `openinference.span.kind` (`LLM/AGENT/TOOL/RETRIEVER/RERANKER/GUARDRAIL/CHAIN/EMBEDDING`) | normalized span kind (`MODEL/AGENT/TOOL/RETRIEVAL/GUARDRAIL/WORKFLOW/MODEL`) |
| GenAI `SPAN_KIND_CLIENT` with `gen_ai.*` | span kind `MODEL` |
| `gen_ai.usage.input_tokens` / `…output_tokens` / `…cache_read.input_tokens` / `…cache_creation_input_tokens` (and `llm.token_count.prompt/completion`) | summed onto `trace.completed` payload → trace read-model token fields |
| `status.code = ERROR` (number `2` or name) | `span.failed` + payload `error` message |
| everything else | preserved under completed-event payload `attributes` |
| OTLP span kind | payload `source_kind` (raw value preserved) |

### Sanitizer (fail-closed)

- Reserved keys `__proto__`, `constructor`, `prototype` are dropped and
  counted (batch total + per-span `otlp_dropped_attribute_keys`).
- Strings that are not valid UTF-8 or exceed 64 KiB **reject the span**
  (reported via `partialSuccess`/stderr) — nothing is rewritten to U+FFFD.
- Bytes attributes are stored as hex fingerprints; nesting is capped at 10
  levels; resource-attribute errors poison that resource's spans rather than
  guess.
- Capture tiers (`minimal`/`metadata`/`full`) arrive in P2 — bodies are
  preserved verbatim today, so do not point `serve` at untrusted networks.

## Layout

```
internal/otlp/        types.go (OTLP/JSON wire types, AnyValue oneof, sanitizer)
                      convert.go (deterministic span→event conversion)
                      http.go   (/v1/traces listener, partialSuccess semantics)
internal/commands/otlp_cmd.go   (otlp import | otlp serve)
testdata/fixtures/otlp/          (golden OTLP/JSON fixture)
```
