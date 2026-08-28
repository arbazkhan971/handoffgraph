# Hosted evals

Parity row 29. An **eval config** says which traces to grade, how, and how
often. HandoffGraph runs the deterministic checks itself, optionally asks a
model of your choosing for a second opinion over your own API key, and appends
every verdict to the same append-only event spine as captured coding-agent
evidence — each one labelled with where it came from.

```bash
# 1. define what to evaluate (deterministic only — no credential needed)
curl -X POST https://api.handoffgraph.dev/v1/evals \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  -d '{
        "name": "nightly",
        "trigger": "cron",
        "checks": ["traces_closed", "commands_ok", "tests_pass",
                   "tool_error_rate", "handoffs_acknowledged"],
        "target": { "since_minutes": 60, "workstream": "ws_..." }
      }'

# 2. run it now
curl -X POST https://api.handoffgraph.dev/v1/evals/evc_.../run \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN"

# 3. read the verdicts back as scores
curl "https://api.handoffgraph.dev/v1/scores?source=evaluation" \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN"
```

## The split that matters

An eval has two halves, and keeping them apart is the entire point of the
feature.

| | Deterministic checks | LLM judge |
| --- | --- | --- |
| What it is | code, over spans we recorded | a model's opinion |
| Provenance | `OBSERVED` | `INFERRED`, always |
| `source` | `evaluation` | `llm_judge` |
| Score name | `eval.<check>` | `judge.<config name>` |
| Needs a credential | no | yes, yours |
| Reproducible | yes, byte-for-byte | no — it is an opinion |

There is no code path in `platform/src/evals.ts` that writes a judge verdict as
`OBSERVED`, and none that writes a deterministic verdict as `INFERRED`. That is
asserted directly on the stored rows in `platform/test/evals.test.ts`, not
inferred from the shape of the code, including on every failure path.

Why it matters: a number that says "0.8" is worthless unless you know whether a
machine measured it or a machine guessed it. Most of this category records both
into the same column. We do not.

## The deterministic checks

These are the hosted port of the local `handoffgraph verify` pack
(`internal/commands/verify_cmd.go`), evaluated over the `span_observations`
read model instead of a local trace materialization.

| Check | Passes when | Detail recorded |
| --- | --- | --- |
| `traces_closed` | no span of the trace is still open | `N unclosed span(s) of M` |
| `commands_ok` | no `COMMAND` span ended in error | `N/M failed` |
| `tests_pass` | no `TEST` span ended in error | `N passed, M failed` |
| `tool_error_rate` | tool-span error rate is **strictly below** the threshold | `N/M tool span(s) failed (rate R, threshold T)` |
| `handoffs_acknowledged` | nothing was handed off, or a handoff was accepted | `N created, M accepted` |

Notes on the translation from local to hosted:

* `traces_closed` counts unclosed **spans** rather than running **traces**. On
  the hosted read model that is the same evidence at finer grain, and it names
  the offender.
* `tool_error_rate` has no local counterpart. It exists because a rate-shaped
  check is cheap against a wide span table and expensive against an event log.
  Tool spans are `TOOL`, `MCP_CLIENT` and `MCP_SERVER`.
* `handoffs_acknowledged` is a property of a **workstream**, not of a trace —
  handoff events carry no trace id. Each targeted trace inherits its own
  workstream's counts; a trace with no workstream has no handoff obligation and
  passes.
* The rate comparison is exact integer cross-multiplication against the
  threshold's decimal parts. No float ever decides a verdict, for the same
  reason money is a decimal string everywhere else in this platform.

The threshold (`0.10`) is a module constant, `TOOL_ERROR_RATE_THRESHOLD`, not a
per-config field. Migration 0012's `checks` column is an array of names;
promoting the threshold to configuration is a one-field schema change, and the
`checks` array is deliberately kept a *set of names* so a verdict's identity
(see below) stays a function of the config id and the check name alone.

## Surfaces

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/evals` | create a config (`ingest`) |
| `GET` | `/v1/evals` | list configs, `{items, next_cursor}` (`read`) |
| `POST` | `/v1/evals/{id}/run` | run now (`ingest`) |
| `GET` | `/v1/evals/{id}/runs` | list runs, `{items, next_cursor}` (`read`) |
| `POST` | `/v1/evals/{id}/disable` | disable, idempotent (`ingest`) |

Foreign or unknown ids are `404` — existence is never leaked. A known path with
an unserved method falls through to the platform 404. Verdicts themselves are
read through the existing `GET /v1/scores` (`platform/src/quality.ts`), which
already surfaces the `provenance` label alongside every score.

### Creating a config

```json
{
  "name": "nightly",
  "trigger": "cron",
  "checks": ["traces_closed", "tests_pass"],
  "target": { "since_minutes": 60, "workstream": "ws_...", "kind": "COMMAND" },
  "judge": {
    "model": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "prompt_template": "Grade this coding-agent trace 0..1.\n{{input}}\nReply with only {\"score\":\"<0..1>\",\"reason\":\"<one sentence>\"}.",
    "api_key": "sk-your-own-key",
    "include_bodies": false
  }
}
```

* `trigger` is `cron` (swept automatically) or `manual`.
* `target.since_minutes` is 1..10080 and defaults to 60. It is part of the
  definition, not a per-run argument, so a cron run and a manual re-run of the
  same config evaluate the same population.
* `target.kind` selects which traces are **in scope** (a trace qualifies if it
  has at least one span of that kind). The checks then evaluate over *all* of
  that trace's spans in the window, because "did every command succeed" is a
  question about the trace, not about the filtered subset.
* `checks` is deduplicated and **sorted** before storage: the stored document is
  part of every verdict's identity, so its bytes must depend on what you asked
  for and not on key order in your request.
* `judge.base_url` must be public `https://`, and `judge.prompt_template` must
  contain `{{input}}` — both enforced by the API *and* in-schema by migration
  0012, so a definition that reached D1 another way still cannot run.

### A config is immutable

`name`, `trigger`, `target`, `checks` and `judge` cannot be edited — migration
0012 aborts the UPDATE. Only `active` (forward, to disabled) and `last_run_at`
(forward) ever move. If the check set could change under a config id, history
would silently start describing an evaluation that never ran, and a re-run would
collide with an existing verdict id carrying different bytes. Disable and create
a new config; the new evaluation gets its own identity in history.

## What a run produces

Every verdict is a `score.recorded` event in the canonical Go score wire shape
(`internal/scores`), so it reads correctly through both `GET /v1/scores` hosted
and the local Go reducer:

```jsonc
// deterministic — OBSERVED
{
  "schema_version": "hfg.event.v1",
  "event_id": "evt_...",
  "kind": "score.recorded",
  "occurred_at": "<the TRACE's end instant>",
  "provider": "evaluation",
  "provenance": "OBSERVED",
  "workstream_id": "ws_...",
  "payload": {
    "check": "commands_ok",
    "comment": "1/4 failed",
    "data_type": "BOOLEAN",
    "eval_config_id": "evc_...",
    "name": "eval.commands_ok",
    "source": "evaluation",
    "target_id": "trc_...",
    "target_type": "trace",
    "value": "0"
  }
}
```

```jsonc
// judge — INFERRED
{
  "kind": "score.recorded",
  "provenance": "INFERRED",
  "payload": {
    "data_type": "NUMERIC",
    "eval_config_id": "evc_...",
    "eval_run_id": "evr_...",
    "judge_model": "gpt-4o-mini",
    "name": "judge.nightly",
    "reason_hash": "sha256:...",
    "score_provenance": "INFERRED",
    "source": "llm_judge",
    "target_id": "trc_...",
    "target_type": "trace",
    "value": "0.8"
  }
}
```

The judge payload labels provenance a second time, field-wise, so a consumer
reading only the payload can never mistake a model's grade for a measurement —
the same discipline `gateway.ts` uses for `cost_provenance`.

## Replay determinism

`events` is append-only and migration 0003's `events_reject_payload_conflict`
trigger ABORTS any insert that reuses an id for different bytes. So every id
here is a pure function of its inputs, and no payload contains a wall clock:

| Verdict | Id derived from | Timed at |
| --- | --- | --- |
| deterministic check | config id, trace id, check name | the trace's end |
| judge | config id, trace id, **run id** | the trace's end |

The consequence you can rely on: **re-running the same config over the same
traces appends zero new events.** The verdicts are byte-identical, so
`INSERT OR IGNORE` absorbs them.

A judge verdict is keyed on the run instead, because a model's grade is *not* a
function of the trace — two runs may legitimately disagree, and each
disagreement is its own piece of INFERRED evidence. A resumed run replays the
same id with the same bytes; a new run appends a new, separately identified
verdict.

If the derived span model grows after a verdict was recorded (a late-arriving
span changes a count), the re-run's bytes differ from the stored ones and the
spine refuses the write. That is logged content-free and swallowed: the FIRST
recorded verdict stands, and the rest of the run continues.

## Content discipline

The judge is handed a **summary** of what a trace did:

```
trace: trc_...
workstream: ws_...
duration_ms: 100000
spans: 10 (1 error, 0 unclosed)
commands: 4 (1 failed)
tests: 2 (0 failed)
tools: 4 (0 failed)
```

This is not a redaction pass. `span_observations` stores no prompts,
completions, diffs or command output in the first place, so there is nothing
here to strip. Setting `judge.include_bodies: true` widens the summary to the
only content-ish columns the read model does hold — **span names and tool
names** — appended as a `span timeline:` section. It cannot reveal prompt or
completion text, because the platform never stored any.

The judge's rationale is hashed (`reason_hash`), never stored, so a holder of
the reply can prove what the judge said and the platform holds nothing it would
later have to redact.

## Failure modes — all fail closed

| Situation | Result |
| --- | --- |
| judge returns non-2xx | run `error`, `error_detail = judge_unavailable` |
| judge call throws / times out (30s) | run `error`, `judge_unavailable` |
| judge body is not JSON, or has no `choices[0].message.content` | run `error`, `judge_unparseable` |
| judge reply is not `{"score": 0..1, "reason": ...}` | run `error`, `judge_unparseable` |
| score outside `[0, 1]`, or in exponential notation | run `error`, `judge_unparseable` |
| `EVAL_SEALING_KEY` unset, config has a judge | `503` on create and on run; a run started without it settles `error`, `sealing_key_unavailable` |
| stored ciphertext will not unseal | run `error`, `judge_key_unusable` |
| window selects > 200 traces | `413` with guidance; **no run row is created** |
| inline deadline (25s) reached | run `error`, `deadline_exceeded`, verdicts so far stand |

A judge failure never fabricates a score. The deterministic verdicts already
appended stay — they are OBSERVED facts about recorded spans and do not become
less true because a model was unreachable — but the run settles as `error`, so
nothing reports a judged result that never happened.

`error_detail` is constrained in-schema to lowercase letters and underscores:
a provider message, a prompt or a model reply can never be written into it.

The parser tolerates exactly one surrounding markdown code fence and nothing
else. No brace-scanning, no "find the JSON somewhere in the prose": a judge that
could not follow the reply contract has not produced a gradeable answer.

## Scheduling

`trigger: "cron"` configs are started by the evals sweep in the Worker's
scheduled dispatcher, on the same `*/5 * * * *` cron as every other sweep. A
config is due once a **full window** has elapsed since its last start, so
consecutive runs evaluate adjacent windows instead of re-grading the same traces
every tick.

`last_run_at` moves at run **start**, not completion, and is monotone by
trigger — so a long or crashed run is never re-enqueued on the next tick. At
most `EVAL_SWEEP_CONFIG_LIMIT` (10) configs start per tick, in a deterministic
`(workspace_id, id)` order, each isolated in its own try/catch: one bad config
never starves the rest, and hosted evaluation can never affect ingest or local
capture.

## Durability

With the optional `EVAL_WORKFLOW` binding, `POST .../run` and the cron sweep
**enqueue** a Workflow instance instead of executing inline, and each trace is
evaluated inside `step.do('trace-<id>')`. An instance killed mid-run resumes at
the next trace: the finished traces replay from the runtime's step memo, so they
are neither re-graded nor re-billed. `POST .../run` answers `202` with the
instance id in that mode, `200` with the settled run inline.

Instance params carry **no credential at all** — only `workspace_id`, `run_id`
and `config_id`. The judge's key lives sealed in the `eval_configs` row and is
unsealed from D1 inside the run, so the Workflows runtime (which persists
params) never holds one.

Without the binding, a run executes inline under a 25-second wall-clock deadline
checked at each trace boundary. Correctness never depends on which path ran: the
deterministic ids make both idempotent.

### Enabling the Workflow

```bash
npx wrangler workflows create handoffgraph-evals
```

then uncomment the `[[workflows]]` block in `platform/wrangler.toml` and, in
`platform/src/evals.ts`, add

```ts
import { WorkflowEntrypoint } from "cloudflare:workers";
```

and make the class `extends WorkflowEntrypoint<EvalsEnv, EvalRunParams>`. The
class already has the constructor/`run` shape that contract requires; the import
is omitted today because the platform test suite runs in plain node (no
miniflare) and could not load it.

### The sealing key

```bash
npx wrangler secret put EVAL_SEALING_KEY
```

AES-GCM, the same construction the gateway uses for upstream credentials.
Creating a judge config and starting a judging run both fail closed with `503`
while it is unset. Deterministic-only configs never touch it and keep working.

## Storage

Two tables (migration 0012), and only two, because everything else is derivable:

* `eval_configs` — the definition. Immutable except `active` and `last_run_at`.
* `eval_runs` — one execution: `status` (`running` → `done` | `error`, terminal
  and settled once), `traces_evaluated`, `scores_recorded`, timing,
  `error_detail`.

There is no `eval_results` table. A verdict's evidence **is** its
`score.recorded` event on the spine; a results table would be a second,
divergeable copy of something the spine already holds append-only.

Wall-clock timing lives on `eval_runs` and never in an event payload, because
event payloads must be byte-stable under replay and a wall clock is not.

Migration 0012 also adds two **partial** read-path indexes on `events` — one for
the handoff tally, one for `score.recorded` — so an evaluator never scans
captured coding-agent evidence it is not asking about. No column of the
append-only events table changes.

## Limitations in this version

* **`tool_error_rate`'s threshold is a constant**, not per-config. See above.
* **200 traces per run.** A wider window is a `413`, not a silent prefix.
* **One judge per config**, one call per trace, no batching and no retry. A
  transient upstream blip errors the run; re-run it.
* **`handoffs_acknowledged` is workstream-scoped**, so every trace in a
  workstream shares its verdict. That is the honest reading of the evidence
  (handoff events carry no trace id), but it does mean the check is not
  independent per trace.
* **No `GET /v1/evals/{id}` detail route** and no per-run verdict listing; read
  verdicts through `GET /v1/scores`, which already filters on `source`.
* **Judge scores are not aggregated.** There is no "average judge score over
  time" view yet; the events are on the spine and the analytics module can
  derive it.
* **Boolean encoding.** Deterministic verdicts record `data_type: "BOOLEAN"`
  with `value` `"1"` / `"0"`. Go's `scores.fromEvent` maps only `"true"` /
  `"false"` onto `Score.BoolValue`, so these currently materialize locally with
  a nil `BoolValue` (the raw `value` string is intact either way, and the hosted
  `GET /v1/scores` returns it verbatim). `CHECK_PASS_VALUE` /
  `CHECK_FAIL_VALUE` in `platform/src/evals.ts` are the single place to change
  if the two encodings are aligned.
* **`source: "llm_judge"` is new.** The local Go `scores.Validate` deliberately
  rejects it today ("a future llm_judge source will be INFERRED and is rejected
  today so an inferred verdict can never masquerade as observed evidence"). The
  hosted writer is that future: it only ever writes the source alongside
  `INFERRED`. Both read paths — Go's `scores.Materialize` and hosted
  `quality.ts` — accept any source string at read time, so the events are
  readable on both sides; only the local *write* path still refuses to mint one.
