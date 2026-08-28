# Agent simulations

Parity row 31. A scenario describes a user; HandoffGraph plays that user against
your assistant for a bounded number of turns, has a judge grade the transcript
against your success criteria, and appends the whole thing to the same
append-only event spine as captured coding-agent evidence.

```bash
# 1. define the scenario once
curl -X POST https://api.handoffgraph.dev/v1/simulations \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  -d '{
        "name": "Refund request",
        "persona": "A frustrated customer whose order arrived broken.",
        "goal": "Obtain a full refund without escalating to a human.",
        "success_criteria": "The assistant offers a refund and states the timeline.",
        "max_turns": 4
      }'

# 2. run it against three models, on your own upstream credential
curl -X POST https://api.handoffgraph.dev/v1/simulations/sim_.../run \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  -d '{
        "gateway_key": "sk-your-own-provider-key",
        "user_model": "gpt-4o-mini",
        "assistant_model": "gpt-4o",
        "judge_model": "gpt-4o"
      }'
```

## What a simulation is — and is not

**It is not a running agent.** Nothing here starts a process, mounts a
filesystem, or supervises a sandbox. A simulation is a structured multi-turn
conversation between three model roles:

| Role | Prompted with | Produces |
| --- | --- | --- |
| user | the scenario's `persona` + `goal` | the next **user** message, and nothing else |
| assistant | the conversation so far (plus an optional `assistant_system`) | the reply under test |
| judge | the finished transcript + `success_criteria` | `{verdict, score, reason}` |

That constraint is deliberate. It keeps the feature inside the platform's
Cloudflare-only envelope — bounded subrequests and D1, no runtime to operate —
and it means the thing you are testing is your assistant's *behaviour in
conversation*, which is what a scenario can honestly measure.

LangWatch's Scenario is the ideas-only reference for the shape (simulate a user,
judge the transcript). No code or configuration from it, or from any other
AGPL/ELv2 project, is used.

## Surfaces

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/v1/simulations` | device bearer, `ingest` |
| `GET` | `/v1/simulations` | device bearer, `read` |
| `POST` | `/v1/simulations/{sim_id}/run` | device bearer, `ingest` |
| `GET` | `/v1/simulations/{sim_id}/runs` | device bearer, `read` |
| `GET` | `/v1/simulations/runs/{smr_id}/transcript` | device bearer, `read` |

Standard platform denial rules apply: a resource in another workspace is `404`
(existence is never leaked), own-but-forbidden is `403`. Listings use the
`{items, next_cursor}` envelope. A known path with the wrong method falls
through to the platform-wide `404`.

`POST .../run` answers `200` when the run executed inline (the body carries the
settled run) and `202` when it was handed to a Workflow (the body carries the
instance id and a `running` run). Both include `durability: "inline" |
"workflow"`.

### Run request

| Field | Required | Notes |
| --- | --- | --- |
| `gateway_key` | yes | **your** upstream credential. Never stored. |
| `user_model` / `assistant_model` / `judge_model` | yes | model ids on that upstream |
| `base_url` | no | defaults to `https://api.openai.com/v1`; must be a public `https://` URL |
| `assistant_system` | no | system prompt for the assistant under test |

The credential is BYO and passes through the same discipline as the gateway's
upstream calls: an explicit header allow-list, `redirect: "manual"`, and a hard
30s subrequest deadline where a timeout is indistinguishable from a 5xx. The
same literal-address guard rejects `http://`, loopback, link-local and RFC1918
`base_url`s — and, as in `docs/gateway.md`, that is a guard against the obvious
mistake, **not** a full SSRF defence (it cannot see through DNS).

## Termination

A run stops at whichever comes first:

1. `max_turns` exchanges (schema ceiling: 12, default 6);
2. the user-simulator emits the literal token `[[SIM_DONE]]`;
3. on the inline path only, a 25s wall-clock deadline checked **between**
   exchanges — so a transcript is always whole exchanges, never a call cut in
   half.

A sentinel token beats "did the model say goodbye": it is exact, it cannot be
produced by accident, and termination stays something the scenario author can
reason about. The token is stripped before the message is hashed and before it
reaches the assistant, so the recorded digest covers exactly the bytes the
assistant saw. A simulator that emits the token *and nothing else* ends the run
without recording a turn — a digest of the empty string would be a claim that a
message existed.

## Provenance

This is the reason a simulation result is worth storing next to real evidence.

| Event kind | Provenance | Why |
| --- | --- | --- |
| `simulation.turn.completed` | `OBSERVED` | The claim is "at exchange N, role R produced content whose digest is H, using model M". The Worker watched all of it. |
| `simulation.completed` | `INFERRED` | Its headline claim is a model's verdict and score. A model's opinion is never an observation. |

`simulation.completed` additionally labels provenance **field by field**, so a
consumer reading `turns_taken` never has to guess whether the platform measured
it or a model asserted it:

```json
{
  "verdict": "pass",
  "verdict_provenance": "INFERRED",
  "judge_score": "0.875",
  "score_provenance": "INFERRED",
  "turns_taken": 3,
  "turns_provenance": "OBSERVED"
}
```

Every surface that renders a verdict renders the label with it: the run views
returned by `/run`, `/runs` and `/transcript` all carry
`verdict_provenance: "INFERRED"` whenever a verdict is present. `judge_score` is
a decimal **string** in `[0, 1]`, never a float — a score is the number a
reviewer will argue about, and a score that silently rounded is not a score.

## Content discipline

**No prompt, reply, or judge rationale is ever persisted hosted.** Turn events
are content-*addressed*: the payload carries `sha256:<hex>` of the turn text so
whoever holds the transcript can prove it is the text that ran, and the platform
stores nothing it would later have to redact. `/transcript` states this back in
the response as `content_policy: "content_addressed_only"`, so an absent body is
never mistaken for a withheld one.

The event's own `content_hash` is the digest of its canonical payload (the
`alerts.ts` convention) — never a pointer to a body that was not kept.

## Replay determinism

Event ids are pure functions of `(run id, exchange index, role)` and the run's
stored start instant:

```
evt_id = ULID(started_at_ms, sha256("evt_|sim|turn|<run>|<index>|<role>")[0..10])
```

— the same `internal/ids.Deterministic` layout the OTLP converter uses. Payloads
contain **no wall clock**. That is load-bearing rather than stylistic: `events`
is append-only and migration 0003's `events_reject_payload_conflict` trigger
aborts any insert that reuses an id for different bytes, so a resumed or
replayed run must produce byte-identical documents.

Consequences worth knowing:

* Re-executing a settled run appends **zero** events. Every `INSERT OR IGNORE`
  lands on the row already there, and the settlement is guarded on
  `completed_at IS NULL`.
* Wall-clock timing therefore lives on the `simulation_runs` row
  (`started_at` / `completed_at`) and, per turn, in the spine's own
  server-assigned `ingested_at` column — observed, monotone, and not part of
  `raw_json`, so it can differ between the first write and an ignored replay
  without ever tripping the guard. `/transcript` reports it as `recorded_at`.
* If a genuine re-execution produces *different* model output, the trigger
  refuses the write. That is correct — one id must not mean two things — and the
  run swallows it (logged content-free) rather than failing. The original
  evidence and the original verdict stand.

## Durability

With the optional `SIM_WORKFLOW` binding, each exchange runs inside
`step.do('turn-<n>')` and the judge inside `step.do('judge')`. A run killed
mid-conversation resumes at the next exchange: the completed steps replay from
the runtime's memo, so they are never re-billed, and the deterministic ids make
the replay idempotent on the spine.

Without the binding the run executes inline under the 25s deadline. **Which path
ran never changes the evidence.** That equivalence is what makes the fallbacks
below safe.

Dispatch falls back to inline when:

* `SIM_WORKFLOW` is unbound;
* `GATEWAY_SEALING_KEY` is unset — the Workflows runtime persists instance
  params, and this platform will not write a raw provider credential to any
  store, so the params carry the credential **sealed** with the same AES-256-GCM
  scheme the gateway uses for upstream keys;
* instance creation threw (logged content-free).

### Enabling the Workflow

Two steps, both required. `wrangler.toml` carries the commented block:

```toml
[[workflows]]
name = "handoffgraph-simulations"
binding = "SIM_WORKFLOW"
class_name = "SimulationWorkflow"
```

and `src/simulations.ts` needs the entrypoint to become a real one:

```ts
import { WorkflowEntrypoint } from "cloudflare:workers";

export class SimulationWorkflow
  extends WorkflowEntrypoint<SimulationsEnv, SimulationRunParams> { ... }
```

The class already has exactly the constructor/`run` shape that contract
requires, and all behaviour lives in `runSimulationWorkflow`, so nothing about
the loop changes when it flips on. The import is omitted today because the
platform test suite runs in plain node with no miniflare and could not load
`cloudflare:workers`. This is a known, deliberate seam — not an oversight.

## Storage

Migration `0015_simulations.sql`. Two tables, because everything else is
derivable from the spine.

`simulation_scenarios` — the definition is the identity. Every run and every
`simulation.completed` event names a `scenario_id` and was judged against *that*
scenario's criteria, so editing is not an operation (the same rule
`alert_rules` follows): the definition is immutable in-schema, deactivation is
terminal, and resuming means creating a new scenario with its own identity in
history.

`simulation_runs` — one execution. Enforced in-schema:

* status settles exactly once into `done` or `error`, and never flips after;
* `completed_at` is write-once, and `('running') = (completed_at IS NULL)`;
* a verdict or score can only exist on a `done` run — **an errored run, including
  one whose judge could not be parsed, can never carry a verdict**;
* `turns_taken` never regresses, so the row cannot under-report evidence that is
  already on the spine;
* `judge_score` is GLOB-constrained to decimal digits, the schema-level backstop
  behind the API's decimal-string rule.

There is no `simulation_turns` table: a turn's evidence *is* its event.

Two partial indexes on `events` support the transcript read. `events` has no
`run_id` column and cannot grow one, so the run id is projected out of the
canonical payload by a deterministic expression and indexed:

```sql
CREATE INDEX idx_events_simulation_run
    ON events(workspace_id, json_extract(raw_json, '$.payload.run_id'), seq)
    WHERE kind IN ('simulation.turn.completed', 'simulation.completed');
```

The read query writes that expression verbatim and matches the partial `WHERE`
exactly, so it is an index prune rather than a spine scan (asserted with
`EXPLAIN QUERY PLAN` in `platform/test/simulations.test.ts`).

## Failure modes

Every one of these settles the run rather than leaving it stranded in `running`:

| Cause | Result |
| --- | --- |
| judge output is not an unambiguous JSON verdict | `status: error`, **no** verdict, **no** score, **no** `simulation.completed` event |
| judge call fails (5xx, timeout, unreadable body) | same |
| user or assistant call fails | same; the turns that did happen stay on the spine |
| scenario deleted mid-run | same |
| sealing key gone, or the sealed credential will not unseal | same, with no upstream call at all |

The judge parser tolerates exactly one surrounding markdown code fence and
nothing else. No brace-scanning, no "find the JSON somewhere in the prose": a
judge that could not follow the reply contract has not produced a gradeable
answer, and a guessed verdict on the spine is strictly worse than a recorded
failure to read one. A number score is accepted only when it stringifies to
canonical decimal form, so `1e-7` is rejected rather than reinterpreted — the
same rule `gateway.ts` applies to provider-reported cost.

## Limitations

Stated so nobody mistakes them for oversights.

* **No streaming and no tool calls.** The assistant under test is exercised
  through plain chat completions. An assistant whose behaviour depends on tool
  execution is not fully covered by this.
* **One judge, one pass.** No ensemble, no rubric decomposition, no
  human-in-the-loop adjudication. The score is one model's opinion, labelled as
  such.
* **No per-step retry.** An upstream failure inside an exchange settles the run
  as `error` instead of throwing to let the Workflows runtime retry the step.
  Deterministic, testable, and no half-retried state — but it does mean a
  transient 500 costs you the run rather than a retry.
* **No cost accounting.** Simulations spend on your own credential and the
  platform does not meter it. The gateway is where spend is ledgered; pointing
  `base_url` at your own gateway virtual key is the way to get both.
* **The inline deadline is wall-clock.** Two runs of the same scenario can take
  a different number of turns inline. `turns_taken` reports what actually
  happened, and the Workflow path has no deadline at all.
