# OTLP Ingest (P1 interop)

HandoffGraph is an **OpenTelemetry backend**: it accepts standard OTLP trace
exports — JSON *or* protobuf — and converts them into deterministic,
append-only `hfg.event.v1` events. Any emitter that speaks OTLP — OpenLLMetry,
OpenLIT, Arize Phoenix exporters, Claude Code native telemetry bridges, your
own OTel SDK — can feed the spine without a HandoffGraph SDK.

> Status: **OTLP/HTTP is shipped locally in both wire flavors** — JSON
> (`application/json`) and protobuf (`application/x-protobuf`), over the same
> `/v1/traces` endpoint and the same `otlp import`. The two flavors are one
> conversion path, so the same telemetry yields **byte-identical event ids**
> either way (`TestProtoFixtureIDParityWithJSON`).
>
> **gRPC is re-scoped out** of the local core: OTLP/gRPC needs a full HTTP/2 +
> protobuf-service stack, which is a dependency and attack-surface trade this
> local-first binary does not want. gRPC emitters should point at a collector
> (`otlp` receiver, `otlphttp` exporter) and forward to `/v1/traces`.
>
> **Hosted protobuf shipped (2026-08-28)** — the Worker (`POST /v1/otlp`)
> accepts `application/json` *and* `application/x-protobuf`, answering a
> protobuf export with a protobuf response. Both flavors reach the one
> converter, so ids match **four ways**: Go-protobuf == Go-JSON ==
> TS-protobuf == TS-JSON, proven against a Go-authored golden fixture
> (`testdata/fixtures/otlp/genai_session.pb`) in
> `platform/test/otlp_proto.test.ts`.
>
> The protobuf decoder is hand-rolled in both languages
> (`internal/otlp/protowire.go`, `platform/src/otlp_proto.ts`), with no
> `google.golang.org/protobuf`, `go.opentelemetry.io/proto/otlp`, or npm
> protobuf runtime — keeping the pure-Go CGO-free posture locally and a
> dependency-free Worker hosted.

## CLI

```bash
# One-shot import of an OTLP request body (JSON or protobuf)
handoffgraph otlp import ./export.json [--workstream ws_...] [--capture tier]
handoffgraph otlp import ./export.pb                 # flavor sniffed
handoffgraph otlp import ./export.bin --format protobuf   # or forced

# Local ingest listener (localhost by default; never expose it)
handoffgraph otlp serve --addr 127.0.0.1:4318 [--capture tier]
```

`--format` is `auto` (default), `json`, or `protobuf`. `auto` sniffs the
first non-space byte: `{` means OTLP/JSON, anything else is decoded as
protobuf. Forcing the wrong flavor fails closed with a decode error rather
than importing a partial batch.

Capture tiers (`--capture`, default `full` — local-first):

| Tier | What lands in `payload.attributes` |
|---|---|
| `full` | everything (still sanitized; reserved keys dropped+counted) |
| `metadata` | structural attrs (model, usage, tool names, session, kinds); prompt/completion/retrieval body prefixes dropped + counted (`capture_dropped_keys`, `capture_tier` on the payload) |
| `minimal` | no attribute values at all; sorted `attribute_keys` manifest preserves structure without content |

Tier drops are recorded on the payload — never silent. The hosted tier
will default to `metadata`; the local default stays `full` because
content never leaves the machine unasked.

Endpoints:

| Route | Method | Notes |
|---|---|---|
| `/v1/traces` | POST | `ExportTraceServiceRequest`, JSON (spec-encoded enums: number or name; `int64` values as decimal string or number) or protobuf. Responds `ExportTraceServiceResponse` **in the request's flavor**; rejected spans are reported via `partialSuccess` and never silently dropped. |
| `/healthz` | GET | liveness |

Content types: `application/json` (or absent — accepted leniently, single-
binary emitters often omit it) selects JSON; `application/x-protobuf` (and
the `application/protobuf` alias some SDKs send) selects protobuf. Anything
else is `415`. A protobuf request is answered with a protobuf
`ExportTraceServiceResponse` and `Content-Type: application/x-protobuf` — a
full success is the empty message (zero bytes). Error responses (4xx/5xx)
are plain text in both flavors. Body cap is 64 MiB either way.

Try it:

```bash
curl -X POST http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/json' \
  --data-binary @testdata/fixtures/otlp/genai_session.json

# The same telemetry, binary flavor, same nine events with the same ids
curl -X POST http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/x-protobuf' \
  --data-binary @testdata/fixtures/otlp/genai_session.pb
```

An OTel SDK exporting OTLP/HTTP works with just environment variables:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # or http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

`grpc` is **not** a supported value: run a collector for gRPC emitters.

### Protobuf decoding contract

The binary flavor is decoded by a small in-package wire reader
(`protowire.go`) against the public OTLP schema, then bridged onto the same
structs the JSON flavor fills (`proto.go`): id bytes become lowercase hex,
`fixed64` times become decimal strings, enums become their numeric form,
`AnyValue` becomes the same Go values the JSON decoder produces. Conversion,
sanitization, capture tiers and identity are therefore shared, unchanged
code.

Decoder rules, all fail-closed:

- Truncation, varint overflow, group wire types (proto2-only), a length that
  runs past the buffer, or a known field carrying the wrong wire type reject
  the **request** (`400`) — never a partial read.
- Nesting is capped at 32 message levels (attribute trees are separately
  capped at 10 by the sanitizer), so a self-nesting attribute bomb fails
  instead of exhausting the stack.
- Unknown fields are skipped, so a newer OTLP release does not break ingest.
  `Span.links` and scope attributes are parsed but not retained: the shared
  struct has no home for them on the JSON path either, and inventing one
  would diverge the flavors.
- Per-span judgement (bad ids, bad times, unusable strings) stays with
  `Convert`, so a protobuf batch reports rejected spans through the same
  `partialSuccess` path as a JSON batch.

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
`session.id` / `gen_ai.conversation.id` / `langfuse.session.id` /
`handoffgraph.session_id` / `session_id`; else the explicit key of the same
OTLP trace seen in the same batch; else `otlp-trace-<traceHex>`. Agent =
resource `service.name`.

`gen_ai.conversation.id` is the OTel GenAI semantic-conventions
session-correlation attribute (added ahead of `langfuse.session.id` /
`handoffgraph.session_id` / `session_id` on 2026-08-28, market-audit
finding). It ranks second — behind the more specific `session.id`, ahead of
the older vendor/generic keys.

### Attribute mapping

| Input convention | Lands in |
|---|---|
| `gen_ai.request.model` → `gen_ai.provider.name` → `gen_ai.system` → `llm.model_name` → `coding_agent.model` (first hit wins) | event `model` |
| `gen_ai.tool.name`, `coding_agent.tool`, `execute_tool …` name | span kind `TOOL` + payload `tool_name` |
| `openinference.span.kind`: `LLM`/`EMBEDDING`→`MODEL`, `AGENT`→`AGENT`, `TOOL`→`TOOL`, `RETRIEVER`/`RERANKER`→`RETRIEVAL`, `GUARDRAIL`/`EVALUATOR`→`GUARDRAIL`, `CHAIN`/`PROMPT`→`WORKFLOW` | normalized span kind (OpenInference's full 10-kind enum; source kind unchanged in `source_kind`) |
| GenAI `SPAN_KIND_CLIENT` with `gen_ai.*` | span kind `MODEL` |
| `gen_ai.usage.input_tokens` / `…output_tokens` / `…cache_read.input_tokens` / `…cache_creation_input_tokens` (and `llm.token_count.prompt/completion`) | summed onto `trace.completed` payload → trace read-model token fields |
| `status.code = ERROR` (number `2` or name) | `span.failed` + payload `error` message |
| everything else | preserved under completed-event payload `attributes` |
| OTLP span kind | payload `source_kind` (raw value preserved) |

**Provider detection** (2026-08-28, market-audit finding): `gen_ai.provider.name`
superseded `gen_ai.system` in GenAI semconv v1.37.0 (Aug 2025). We read the
new key first and keep `gen_ai.system` for older emitters that have not
migrated — the same precedence applies everywhere the vendor/system is
consulted (the `model` fallback above, and the GenAI-client detection that
feeds the `SPAN_KIND_CLIENT` → `MODEL` mapping).

**OpenInference EVALUATOR/PROMPT** (2026-08-28, market-audit finding):
OpenInference's span-kind enum grew from 8 to 10 values. We fold `EVALUATOR`
onto our `GUARDRAIL` kind — it renders a pass/fail or scored verdict over
content, the same quality-gate semantics — and `PROMPT` onto `WORKFLOW`,
since assembling/rendering a prompt template is a workflow step rather than
a model call. Both are new `case`s in `mapKind` (`convert.go` / `otlp.ts`),
not a change to the fallback kinds; a source span's raw OTLP kind is still
carried unchanged in payload `source_kind`.

> As of 2026-08-28, GenAI semantic conventions remain in **Development**
> status upstream: v1.37.0 (Aug 2025) is the reference version this mapping
> tracks, and the semantic-conventions repository split planned for Jun 2026
> means there is no stable, versioned schema URL to pin yet. We therefore
> track individual attribute names (with an old-key fallback per rename)
> rather than a `schema_url`, and expect to revisit this note as the spec
> stabilizes.

### Sanitizer (fail-closed)

- Reserved keys `__proto__`, `constructor`, `prototype` are dropped and
  counted (batch total + per-span `otlp_dropped_attribute_keys`).
- Strings that are not valid UTF-8 or exceed 64 KiB **reject the span**
  (reported via `partialSuccess`/stderr) — nothing is rewritten to U+FFFD.
- Bytes attributes are stored as hex fingerprints; nesting is capped at 10
  levels; resource-attribute errors poison that resource's spans rather than
  guess.
- Capture tiers (`minimal`/`metadata`/`full`) are shipped — see the table
  above. The local default is still `full`, so bodies are preserved verbatim
  unless you ask otherwise: do not point `serve` at untrusted networks.
- The protobuf decoder validates UTF-8 for the strings that bypass the
  attribute sanitizer (scope name/version, schema urls, trace state, status
  message) rather than let `encoding/json` rewrite them to U+FFFD. Span names
  and attribute strings stay raw so the existing per-span checks reject them
  exactly as they do on the JSON path.

## Layout

```
internal/otlp/        types.go (OTLP/JSON wire types, AnyValue oneof, sanitizer)
                      protowire.go (hand-rolled protobuf wire codec)
                      proto.go  (OTLP/protobuf → shared structs)
                      convert.go (deterministic span→event conversion)
                      http.go   (/v1/traces listener, partialSuccess semantics)
internal/commands/otlp_cmd.go   (otlp import [--format] | otlp serve)
testdata/fixtures/otlp/          genai_session.json + genai_session.pb
                                 (the same session in both flavors; the .pb is
                                  built by a test-only encoder and pinned byte
                                  for byte — regenerate with
                                  HFG_UPDATE_OTLP_FIXTURE=1 go test ./internal/otlp)
                                 semconv_v137.json (gen_ai.provider.name,
                                  gen_ai.conversation.id, OpenInference
                                  EVALUATOR/PROMPT — JSON only, no .pb sibling;
                                  ids cross-checked in platform/test/otlp.test.ts)
```
