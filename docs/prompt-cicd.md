# Prompt playground, prompt CI/CD, and the optimization loop

Parity rows **35** (playground: variant diffing, replay via the gateway),
**36** (prompt CI/CD: webhooks, GitHub Action, label-repoint rollback gated on
evals) and **30** (eval-driven prompt optimization).

Implementation: `platform/src/playground.ts`, migration
`platform/migrations/0014_playground.sql`, tests
`platform/test/playground.test.ts`, copy-paste Action
`.github/workflows/prompt-ci.yml.example`.

> **Doc conflict, noted rather than silently resolved.**
> `docs/competitor-analysis.md` files row 35 under **P3**;
> `docs/parity-plan.md` lists it under **P4**. The feature ships either way and
> nothing in the code depends on the answer; reconciling the two documents is a
> separate editorial change.

---

## 1. The one idea

A playground is normally a scratchpad. You try two prompts, squint at the
difference, and the comparison evaporates — which is exactly the artifact this
platform exists to stop losing.

So every variant executed here **appends a `playground.completed` event to the
same append-only spine** as the coding-agent evidence sitting next to it. That
is `docs/parity-plan.md`'s own P4 acceptance gate for this row — *"playground
runs are recorded as experiment events (dogfood)"* — and it is why migration
0014 adds a run **metadata** table and nothing else. Drop `playground_runs`
entirely and every comparison is still fully reconstructible from `events`.

The CI/CD half runs on the same idea. **There is no labels table anywhere in
this platform, hosted or local.** A label is derived state over `prompt.labeled`
events (`src/quality.ts`'s `resolveLabels`, mirroring Go's
`internal/prompts.Resolve`). Repointing `production` from v3 to v4 is an
*append*; rolling back from v4 to v3 is the *identical* operation through the
*identical* gate. There is no separate rollback code path to get wrong.

---

## 2. Surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/playground/run` | device `ingest` | Run 1–2 prompt versions, diff them, record evidence |
| GET | `/v1/playground/runs` | device `read` | Cursor-paginated run list |
| POST | `/v1/prompts/{name}/labels` | device `ingest` **or** `sk_` key with `write` | Eval-gated label repoint, rollback, and `dry_run` validation |
| POST | `/v1/prompt-optimizer/suggest` | device `ingest` | One model-proposed prompt rewrite, INFERRED, never applied |

Wrong method on a known path falls through to the platform 404, as everywhere
else. Foreign-workspace resources 404 without confirming they exist.

### Bindings

None new. The playground reuses `DB`, the gateway's `GATEWAY_KV` cache, the
gateway's `GATEWAY_SEALING_KEY` secret, and — only at capture tier `full` —
migration 0010's `gateway_capture_bodies` table. Every binding except `DB` is
optional in code, so the Worker deploys before any of them exist.

---

## 3. `POST /v1/playground/run`

```jsonc
{
  "prompt_name": "support-triage",
  "versions": [3, 4],                       // 1 or 2; two must differ
  "variables": { "customer_name": "Ada" },  // {{placeholders}} in the body
  "gateway_key": "vk_...",                  // a virtual key you already minted
  "model": "gpt-4o-mini",
  "max_tokens": 512                         // optional, 1..8192
}
```

### What happens, in order

1. **Version resolution.** Each requested version is materialized from the event
   spine using `src/quality.ts`'s `materializePromptEvents` — the same read
   model that serves `GET /v1/prompts/show`, so the playground can never run a
   version the prompt store would not show you. Unknown prompt → `404`.
   Unknown version → `404` with the offending `version`.
2. **Variable substitution, fail-closed.** `{{ name }}` placeholders (optional
   inner whitespace) are replaced from `variables`. **Every placeholder must
   have a value**; an unbound one is a `400`:

   ```json
   { "error": "missing_variables", "missing": ["customer_name"], "version": 4 }
   ```

   Silently forwarding an unrendered `{{customer_name}}` to a model is precisely
   the bug a playground exists to catch, and answering it with a plausible
   completion would hide it. Substitution is **single-pass**: a value containing
   `{{other}}` is inserted verbatim and never re-expanded. Extra variables are
   permitted and ignored — comparing a v3 that uses `{{a}}` against a v4 that
   also uses `{{b}}` needs one map covering both.

   This is deliberately **not** a template language: no expressions, no filters,
   no conditionals. Every construct added here is one more thing that can differ
   between the version you tested and the version you shipped.
3. **Virtual-key resolution.** The `vk_` key is resolved through the gateway's
   own registry (`resolveGatewayKey`: KV first, D1 on a miss), checked for
   workspace ownership, disabled state, budget and rate limit, and its upstream
   credential unsealed with `GATEWAY_SEALING_KEY`. See §6 for the error shapes.
4. **Run row.** A `playground_runs` row is inserted `INSERT OR IGNORE` with a
   **deterministic id** (§5).
5. **Execution.** Each variant is one OpenAI-compatible chat completion against
   the key's **primary** upstream. See §7 for why fallbacks are excluded.
6. **Evidence.** One `playground.completed` event per variant that actually ran.
7. **Response.**

```jsonc
{
  "run": { "id": "plr_...", "prompt_name": "support-triage", "versions": [3, 4],
           "model": "gpt-4o-mini", "status": "done",
           "created_at": 1700000000, "completed_at": 1700000000 },
  "variants": [
    { "version": 3, "output": "…full text…", "output_hash": "sha256:…",
      "prompt_hash": "sha256:…", "tokens": { "input": 11, "output": 7 },
      "cost": null, "latency_ms": 42, "event_id": "evt_…", "recorded": true }
  ],
  "diff": { "identical": false, "length_delta": -18,
            "first_divergent_line": { "line": 2, "a": "…", "b": "…" } },
  "content_policy": "content_addressed_only"
}
```

`diff` is `null` for a single-variant run. It is deliberately **not** a full LCS
diff: "where do these first disagree, and by how much do they differ in size" is
what a human uses to decide whether a prompt change did what they meant, and the
complete outputs are in the same response for anyone who wants to diff them
properly client-side. Line splitting normalizes CRLF.

`recorded` is per-variant honesty: `false` means the spine refused the append
(an event id already carries different bytes) so the response is not claiming
evidence that is not there.

### Failure is all-or-nothing — in the response

An upstream failure settles the run row as `error` and answers `502`:

```json
{ "error": "upstream_error", "run_id": "plr_…", "status": "error",
  "failed_version": 4, "upstream_status": 503, "variants_recorded": 1 }
```

There is **no partial success body**: a diff of one variant is not a diff.

But note `variants_recorded`. The variants that *did* complete still get their
events. Those calls really happened and those tokens were really spent;
discarding the record to make the response tidy would hide real spend. The
response is all-or-nothing; the *evidence* is not.

---

## 4. Provenance and content discipline

| Kind | Provenance | The assertion |
| --- | --- | --- |
| `playground.completed` | **OBSERVED** | "Variant V of prompt P, rendered with these variables, was sent to model M and produced output whose digest is H, consuming these tokens." |
| `prompt.labeled` | **OBSERVED** | "Label L now points at version N of prompt P" (+ the gate audit, when gated). |
| `prompt.suggestion.recorded` | **INFERRED** | "A model proposed this rewrite." |

`playground.completed` is OBSERVED even though the *output* came from a model.
The claim is that the call happened and what it hashes to — the Worker watched
all of it. Nothing asserts the output is good, true, or better than the other
variant. `prompt.suggestion.recorded` is INFERRED because its headline claim is
an opinion, and the payload *also* carries
`"suggestion_provenance": "INFERRED"` so a consumer reading payloads alone
cannot mistake a proposal for fact (the same field-level discipline as
`gateway.ts`'s `cost_provenance` and `simulations.ts`'s `verdict_provenance`).

**Cost is written only when the upstream reported it**, and only ever beside
`"cost_provenance": "provider_reported"`. A figure derived from a price table
would be INFERRED, and this platform does not write INFERRED money as fact. No
cost is more honest than a plausible one.

### What is stored, and what is not

No rendered prompt and no completion is written into `events`. Playground events
are **content-addressed**: they carry `sha256:<hex>` of the rendered prompt and
of the output, so a holder of the text can prove it is the text that ran. The
caller gets the full outputs in the HTTP response — that is the entire point of
a playground — while the platform keeps only digests.

Bodies are persisted **only** when the virtual key was created with
`capture: "full"`, and then into the existing `gateway_capture_bodies` table
(migration 0010), reusing the gateway's single redaction choke-point rather than
opening a second place content can hide. The response says which happened:
`content_policy` is `bodies_captured_full` or `content_addressed_only`.

**One deliberate exception, stated plainly.** The optimizer stores a bounded
`rationale_summary` (≤ 280 characters of model-authored text) in the
`prompt.suggestion.recorded` payload, alongside its `rationale_hash`. That is
commentary the platform generated about *operator-authored configuration* (a
prompt), never captured agent evidence — and a suggestion nobody can read is a
suggestion nobody can act on. Everything else in this slice is digest-only.

---

## 5. Determinism and idempotency

Event payloads contain **no wall clock**. Migration 0003's
`events_reject_payload_conflict` trigger aborts any insert reusing an event id
for different bytes, so a replayed run must produce byte-identical documents.
Run timing therefore lives on the `playground_runs` row and, per event, in the
spine's server-assigned `ingested_at` column. **Latency is reported in the HTTP
response and nowhere else.**

Ids are pure functions of a semantic identity and a millisecond:

* **run id** — `plr_` + ULID(run start ms, sha256 of {workspace, prompt name,
  versions, model, `max_tokens`, and the digests of the rendered bodies actually
  sent}). Two runs differing only in a variable value are different runs.
* **variant event id** — the run identity plus the version number.
* **suggestion event id** — prompt name, base version, suggested-body digest.

Re-POSTing a byte-identical run **inside the same millisecond** lands on the
same run row and the same events under `INSERT OR IGNORE`: nothing is
duplicated. Re-POSTing a second later is a genuinely different call at a
different time and gets its own identity — which is honest, because the model
may well answer differently.

### The one place the clock is load-bearing

`prompt.labeled` ids **include the millisecond on purpose**. A rollback repoints
`production` from v4 back to v3 — a `(name, label, version)` triple that already
appears in history. If the id ignored time, that rollback would be an exact
replay of the original event, `INSERT OR IGNORE` would drop it, and
`resolveLabels` (last-write-wins by `seq`) would never see the label move. **The
label would silently stay on v4.** Including the millisecond makes every repoint
its own event while keeping a retried write inside one millisecond idempotent.

---

## 6. Error shapes

The playground speaks the **platform** envelope `{"error": "..."}` — *not* the
OpenAI-shaped `{"error": {"message", "type", "code"}}` that `gateway.ts`'s proxy
returns. That is deliberate and worth stating: the proxy exists so an unmodified
OpenAI client works against it, whereas `/v1/playground/*` is a first-party
HandoffGraph API whose callers already parse `{error}` everywhere else.

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | No/invalid device token or `sk_` key |
| 401 | `invalid_gateway_key` | Not a `vk_`, unknown, **or owned by another workspace** — all identical, so key ids cannot be probed |
| 401 | `gateway_key_disabled` | Your own key, revoked |
| 403 | `forbidden` | Device without `ingest`; `sk_` key without `write` |
| 404 | `prompt not found` / `prompt version not found` | Also the answer for another workspace's prompt |
| 400 | `missing_variables` | Unbound `{{placeholder}}` (with `missing[]`) |
| 409 | `eval_gate_failed` | The gate refused (§7) |
| 409 | `label_event_conflict` | The spine refused the append; the label did **not** move |
| 429 | `budget_exhausted` / `rate_limit_exceeded` | The virtual key's own guard rails |
| 502 | `upstream_unavailable` / `upstream_error` / `unparseable_response` / `unparseable_suggestion` | Model call or model reply |
| 503 | `gateway_sealing_key_unavailable` / `gateway_key_unreadable` | Cannot unseal a provider credential — fail closed |

---

## 7. Prompt CI/CD (row 36)

### `POST /v1/prompts/{name}/labels`

```jsonc
{
  "label": "production",       // trimmed + lowercased, [a-z0-9][a-z0-9._-]*
  "version": 4,
  "score_name": "answer_accuracy",  // required when min_score is given
  "min_score": "0.80",              // decimal STRING, never a float
  "require_observed": false,        // demand an OBSERVED score, not an LLM judge's
  "force": false,                   // override a failing gate, audited
  "dry_run": false                  // run every check, append nothing
}
```

### `dry_run: true`

Runs **every** check — prompt exists, version exists, eval gate — and appends
nothing. `200` with `{"dry_run": true, "would_apply": true, "gate": {...}}`; the
same `404` / `409` as a real promotion otherwise. This is what a PR check wants:
*"would this promotion pass?"* answered without promoting.

It is also the **only** validation an `sk_` key can reach. The prompt read routes
(`GET /v1/prompts`, `GET /v1/prompts/show`) authenticate device bearer tokens
only, by design — so a CI job holding one repository secret validates through
this route rather than being handed a device token it should not have.

`201` on success:

```jsonc
{
  "label": { "name": "support-triage", "label": "production", "version": 4 },
  "event_id": "evt_…",
  "provenance": "OBSERVED",
  "gate": { "score_name": "answer_accuracy", "min_score": "0.80",
            "latest_score": "0.91", "latest_score_event_id": "evt_…",
            "latest_score_provenance": "OBSERVED", "require_observed": false,
            "passed": true, "forced": false },
  "rollback_hint": "POST /v1/prompts/support-triage/labels with an earlier version"
}
```

**`latest` is rejected with 400.** It is a *computed* label (`resolveLabels`
seeds it from the highest version number); an explicit `latest` event would
override that and let "latest" point at an older version — a trap, not a
feature.

### The gate

When `min_score` is present, the platform reads `score.recorded` events, finds
those **linked to that exact prompt version**, keeps the ones matching
`score_name`, and requires the **latest** one to be `>= min_score`.

* Comparison is exact decimal-string arithmetic (`compareDecimalStrings`),
  because a promotion threshold is precisely the number a reviewer will argue
  about and `0.1 + 0.2` is not `0.3` in binary floating point.
* Only scores whose `value` is a canonical decimal string are considered. A
  CATEGORY or BOOLEAN score cannot be compared against a numeric threshold, and
  coercing one would invent a number the evaluator never recorded.
* **Absent evidence is a failure, not a pass.** "No eval has ever run against
  this version" and "this version scored 0.9" must never produce the same deploy
  decision. A gate that defaults open is decoration.
* The score scan is bounded (`MAX_SCORE_SCAN_ROWS`) and ordered `seq DESC`, so
  when a workspace's score history outgrows the cap the gate keeps the
  **newest** rows. Ascending would keep the oldest and the gate would go on
  answering confidently with superseded evidence — worse than no gate.

Refusal is `409`, with a `reason` naming which of the three failures happened
(`no_score`, `below_threshold`, `provenance_not_observed`) — three different
things for a CI log to say, and three different fixes:

```json
{ "error": "eval_gate_failed", "reason": "no_score",
  "latest_score": null, "latest_score_provenance": null,
  "require_observed": false, "min_score": "0.80",
  "score_name": "answer_accuracy", "prompt_name": "support-triage", "version": 4 }
```

#### Provenance: which kind of evidence promoted this version

A `score.recorded` event may be **OBSERVED** (a deterministic evaluator, a human
review) or **INFERRED** (an LLM-as-judge — migration `0012_evals.sql` is explicit
about this). Both are legitimate evidence; they are not the same evidence.

The gate therefore always reads the provenance alongside the value and records
it as `latest_score_provenance` in the `gate` audit — **unconditionally**, not
only when `require_observed` is set. `prompt.labeled` is an OBSERVED event; one
that quotes a passing score while withholding where the score came from is
precisely how an INFERRED number gets read later as an observed one. An
unrecognised or absent label is recorded as `UNKNOWN`, never optimistically as
`OBSERVED`.

`require_observed: true` additionally refuses to pass on anything but an
OBSERVED latest score (`reason: "provenance_not_observed"`, `409`). It defaults
to `false` so existing pipelines keep their behavior, and it is rejected with
`400` when no `min_score` gate was requested — protection that is not actually
running must not look like protection.

It gates the **latest** score, not "the latest OBSERVED score": scanning past a
newer INFERRED result to find an older OBSERVED one would resurrect exactly the
stale-evidence pass the ordering rules above exist to prevent.

#### Linkage: how a score attaches to a prompt version

Two accepted forms, both explicit:

1. **Explicit prompt target** — `"target_type": "prompt"` with
   `"target_id": "<name>@<version>"`. Use this for an offline eval scored
   *about* the prompt version itself.
2. **The Go linkage keys**, mirrored verbatim from `internal/prompts.Links`:
   name in `prompt_name` / `prompt.name` /
   `langfuse.observation.prompt.name`, **and** version in `prompt_version` /
   `prompt.version`. This is how a score about a *trace* that used the prompt
   links back to it, and copying Go's exact key set is what keeps
   `handoffgraph prompt links` and this gate agreeing about the same events.

A payload that names the prompt but **not** the version does not gate a specific
version: promoting v4 on the strength of a score that might have been about v1
is exactly the mistake this route exists to prevent.

### `force: true`

Overrides a failing gate — and writes the whole verdict into the event payload:

```jsonc
"gate": { "score_name": "answer_accuracy", "min_score": "0.80",
          "latest_score": "0.40", "latest_score_event_id": "evt_…",
          "latest_score_provenance": "INFERRED", "require_observed": true,
          "passed": false, "forced": true }
```

An override that left no trace would make `force` a way to launder an
unevaluated prompt into production, which is the one thing a CI gate must never
permit. The audit object is present whenever a gate was *requested*, pass or
fail.

The payload stays byte-compatible with the Go CLI's own `prompt.labeled`
(`{name, label, version}`); `gate` is additive, and both Go's
`json.Unmarshal`-into-struct and `src/quality.ts`'s `parsePromptLabeledPayload`
ignore unknown keys.

### Rollback

Repoint the label at an earlier version through the same route. Same gate, same
audit trail, same event kind. There is no separate rollback endpoint to keep in
sync — and because `resolveLabels` is last-write-wins by `seq`, the rollback
takes effect the moment its event lands.

### Webhooks

`prompt.labeled` is **already** in the outbound webhook sweep's kind list
(`platform/src/webhooks.ts`, `DEFAULT_INTERESTING_KINDS` — verified, no change
needed). A workspace with an endpoint subscribed to `prompt.labeled` receives a
signed, content-free notification of every promotion and rollback with no extra
wiring.

### GitHub Action

`.github/workflows/prompt-ci.yml.example` is the copy-paste workflow:
`dry_run` the promotion, then repoint the label for real, using only `curl`,
`jq` and one `sk_` secret — no marketplace action, no vendored SDK. A promotion
gate that depends on a third-party action is a promotion gate you do not
control. It carries the `.example` suffix so it **never runs in this
repository** (GitHub Actions only loads `.yml`/`.yaml`) — copy it into your own
repo as `.github/workflows/prompt-ci.yml`.

---

## 8. Optimization loop (row 30) — the minimal honest version

```jsonc
POST /v1/prompt-optimizer/suggest
{
  "prompt_name": "support-triage",
  "gateway_key": "vk_...",
  "model": "gpt-4o-mini",
  "sample_size": 5,          // optional, 1..20
  "max_score": "0.5",        // optional: what counts as "low"
  "base_version": 4,         // optional, defaults to latest
  "score_name": "answer_accuracy"  // optional filter
}
```

The route gathers the most recent low-scoring evaluations linked to that exact
version (§7 linkage), asks the model for **one** improved variant, and appends
`prompt.suggestion.recorded`.

```jsonc
{
  "suggestion": { "prompt_name": "support-triage", "base_version": 4,
                  "base_hash": "sha256:…", "suggested_body": "…full text…",
                  "suggested_body_hash": "sha256:…", "rationale": "…",
                  "model": "gpt-4o-mini",
                  "evidence_event_ids": ["evt_…"], "sample_size": 3 },
  "provenance": "INFERRED",
  "auto_applied": false,
  "next_step": "POST /v1/prompts/support-triage/labels (eval-gated) after creating a new version",
  "event_id": "evt_…",
  "recorded": true
}
```

**It never auto-applies.** No prompt version is created, no label moves. The
payload records `"applied": false` explicitly rather than leaving it implied.
The only path to production is a human creating a version and repointing a label
through the gated route above. That constraint is the feature: an optimizer that
edits production prompts by itself is an outage generator.

**Fail-closed judging.** The model must reply with a single JSON object
`{"suggested_body": "...", "rationale": "..."}`; one surrounding markdown code
fence is tolerated because that is a formatting habit, not an ambiguity.
Anything else is `502 unparseable_suggestion` with **nothing appended** —
inventing a rewrite would put a fabricated INFERRED proposal on the spine, which
is strictly worse than reporting that the model could not be read.

**What leaves the platform.** The optimizer sends the caller's *own* upstream
(reached with the caller's *own* virtual key) the prompt body plus, for each
sampled evaluation, its score name, decimal value and comment. Score comments
are evaluator rationales and are the most useful signal available; they are sent
to the caller's own model and are never stored anywhere new by this route.

---

## 9. Known gaps, stated rather than hidden

`gateway.ts` does not export `callUpstream` / `callWithFallbacks`, so
`playground.ts` carries a **thin duplicate** of the gateway's calling discipline
(explicit header allow-list, `redirect: "manual"`, hard subrequest deadline,
timeout treated as a 5xx). Two consequences, both deliberate, both flagged for
unification:

1. **No provider fallbacks.** A playground variant calls the virtual key's
   *primary* upstream only. Falling through to a fallback provider mid-diff
   would silently compare two prompts against two different models — worse than
   failing.
2. **Playground spend does not advance `gateway_keys.budget_spent`.** Cost lands
   on the spine (provider-reported only), but not in the `gateway_requests`
   ledger. The key's budget and rate limit are still **checked before every
   run**, so an exhausted key cannot be used here; but a long playground session
   can spend past a budget that only the proxy path advances.

Unifying both means exporting the gateway's call+capture composition so this
module can reuse it instead of mirroring it — a change to `gateway.ts`, kept out
of this slice on purpose.

A third, smaller one: a re-POST of an identical run inside the same millisecond
**re-calls the model** — it just does not duplicate any evidence, because the
run row and both event ids resolve to the ones already stored. Short-circuiting
on the existing run row instead would have to answer with no outputs (they are
never stored hosted), which is less useful than simply running it again.

Also outstanding:

* `GET /v1/playground/runs` lists run metadata only. Reading a run's variant
  events back is a spine read; migration 0014 ships the expression index
  (`idx_events_playground_run`) that a future `GET
  /v1/playground/runs/{id}/variants` would need.
* Replay against a **dataset** (row 35's "replay against datasets via gateway")
  runs one prompt at a time here. Fanning a dataset's examples through the same
  machinery is additive and needs no schema change.
