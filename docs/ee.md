# Enterprise tier + in-product assistant

Two slices that shipped together:

- **The EE line fence** (parity row 48) — SSO, SCIM, data masking, and audit
  export as a directory-fenced Enterprise tier, with the OSS baseline intact.
- **The in-product assistant** (parity row 51) — an assistant over the user's
  own telemetry, bring-your-own model, answers always labelled `INFERRED`,
  powered by our own hosted MCP tools.

Implemented in `platform/ee/src/ee.ts`, `platform/ee/src/assistant.ts`, and
`platform/migrations/0016_ee.sql`. Tests: `platform/test/ee.test.ts`.

---

## Part 1: the fence

### Three mechanisms, and only three

The plan's wording is "separate directory, separate license, flags — never
license soup". Concretely:

| Mechanism | What it is |
| --- | --- |
| **Directory** | Every line of EE code is under `platform/ee/`. Nothing in `platform/src/` implements an EE feature. "Which license covers this file?" is answered by its path alone. |
| **License** | `platform/ee/LICENSE` covers that directory tree and nothing else. It is explicitly not the repository's OSS license, and is currently an evaluation-only placeholder pending real EE legal text. |
| **Flag** | `handleEERoute` returns `null` unless `env.EE_ENABLED === "true"`. |

What "license soup" would have looked like, and what this avoids: per-file
license headers sprinkled through `platform/src/`, `#ifdef`-style conditionals
inside OSS modules, a second `migrations_dir`, or a separate build variant.
None of those exist.

### Why `null` and not 403

`handleEERoute` returns `null` when EE is off. `null` means "not my route" in
this codebase's dispatch convention, so `index.ts` continues its chain and
falls through to the platform-wide 404. The effect is that with the flag absent
— the default — every `/v1/ee/*` path and `/v1/assistant` are
**indistinguishable from a URL this Worker has never heard of**: same status,
same body bytes, same headers.

That is the acceptance gate "OSS baseline intact behind flags", and
`test/ee.test.ts` asserts it as such:

```
with EE off, every EE route answers byte-identically to an unknown route
with EE off, an EE path is not even authenticated (no D1 touched)
only the exact string 'true' opens the fence
```

The second one matters as much as the first. The flag check runs before the URL
is parsed and before any statement is prepared, so a disabled deployment cannot
be probed for whether the EE tables exist or whether a session is valid.

A `403 not_licensed` would have been the obvious alternative and is worse: it
advertises the surface, tells an unlicensed operator exactly what to buy by
enumerating paths, and makes the OSS 404 behavior depend on the tier.

### The one seam

```ts
// platform/src/index.ts
import { handleEERoute } from "../ee/src/ee";
...
const eeResponse = await handleEERoute(request, env);
if (eeResponse !== null) return eeResponse;
```

One import, one delegation pair, placed **last** in the chain — after account,
teams, artifacts, webhooks, dashboards, alerts, gateway, apikeys, mcp,
observations, analytics, quality, and simulations — so no EE route can shadow
an OSS one even by accident.

The dependency arrow points one way: `ee/` imports from `src/`, and `src/`
imports from `ee/` only here. If that reverses, the fence is gone.

`platform/tsconfig.json` gained `"ee/src/**/*.ts"` in `include` so the EE tree
type-checks with the rest of the Worker. (Without it `tsc` would still compile
the files transitively through the `index.ts` import, but they would not be
independently checked.)

### Why the migration is OSS

`platform/migrations/0016_ee.sql` carries the repository's OSS license, like
every other migration. That is deliberate:

- A migration is a data structure, not a feature. It declares three tables and
  their integrity constraints — no product logic, no policy.
- The one-way door that matters is the reverse one: OSS code must never depend
  on EE code. Keeping the schema OSS means an OSS operator applies
  `0001..NNNN` unconditionally, `wrangler d1 migrations apply` stays a single
  ordered list, and the D1 schema is identical on every deployment. Three empty
  tables cost nothing.
- Making the schema part of the fence would buy nothing while breaking
  migration ordering for everyone.

Same reasoning for `platform/test/ee.test.ts`: it lives in the normal OSS test
tree so one `vitest run` covers the whole Worker, including the assertion that
the EE surface is invisible by default. Testing the fence is an OSS concern.

### Enabling

```toml
# platform/wrangler.toml
EE_ENABLED = "true"
```

Shipped commented out with an enable note. Apply migration 0016 first. Only the
exact string `"true"` opens the fence — `"false"`, `"TRUE"`, `"1"`, and a
leading space all read as off, and that is tested.

---

## Part 2: EE features

### Schema (migration 0016)

```sql
ee_sso_connections (workspace_id PK NOT NULL, workos_org_id, connection_state, updated_at)
ee_scim_tokens     (workspace_id, token_hash, created_at, revoked_at)
ee_masking_rules   (id, workspace_id, field_pattern, action CHECK IN ('hash','drop'), created_at)
```

Platform conventions hold: every table carries `workspace_id NOT NULL` and is
indexed on it, secrets are stored only as SHA-256, revocation is one-way and
enforced by a trigger, and identity columns are immutable.

`workspace_id TEXT NOT NULL PRIMARY KEY` on the first table is not redundant.
SQLite keeps a long-standing quirk where a rowid table's `TEXT PRIMARY KEY`
still accepts `NULL`; a migration test caught it, and the column is now
`NOT NULL` in fact rather than by convention.

### SSO — `GET`/`PUT /v1/ee/sso`

WorkOS AuthKit already performs the SSO dance: a SAML/OIDC login lands on the
same `/v1/auth/callback` as a password login and yields the same verified
immutable subject (`platform/src/account.ts`). Nothing about that changes.

What was missing is the binding between a workspace and its WorkOS
*Organization* — which an admin needs in order to point their IdP at the right
place, and which the SCIM directory scopes to. This surface records it and
reports setup state.

```
GET /v1/ee/sso            session, admin
PUT /v1/ee/sso            session + CSRF, owner
```

```json
{
  "sso": {
    "workspace_id": "wsp_...",
    "workos_org_id": "org_01HXYZ",
    "connection_state": "pending",
    "updated_at": 1740000000
  },
  "setup": { "provider": "workos", "redirect_uri": "...", "next_step": "..." }
}
```

Stored states are `pending` and `active` (the column's `CHECK`). `unlinked` is
synthesized on read when no row exists, so the API always has a state to report
without the table carrying an "absent" row.

### SCIM — `/v1/ee/scim/*`

A real SCIM 2.0 subset, not a stub.

```
POST /v1/ee/scim/token       session + CSRF, owner  -> scim_<43 chars>, once
GET  /v1/ee/scim/v2/Users    scim_ bearer           -> ListResponse
POST /v1/ee/scim/v2/Users    scim_ bearer           -> provision via invite
```

**Token.** Same discipline as a device token, an API key, or an invite link:
the raw `scim_` credential is returned exactly once and only its SHA-256 is
persisted. Issuing revokes the previous live tokens **in the same D1 batch** as
the insert, so there is never a window with two working credentials. Revoked
rows stay as history, and revocation is one-way at the schema level.

**List.** A `urn:ietf:params:scim:api:messages:2.0:ListResponse` over active
workspace members, `application/scim+json`, paged by SCIM's 1-based
`startIndex`/`count`, ordered by ascending `user_id` (a stable total order,
which index paging requires).

The `userName eq "..."` filter is supported because it is the one filter every
directory actually sends before provisioning. Any other filter is rejected with
SCIM's `invalidFilter` rather than silently ignored — silently ignoring a
filter makes a directory believe a user does not exist and provision a
duplicate.

**Provision.** `POST /Users` creates a workspace invite through the same
audited, hash-chained flow `src/teams.ts` uses: the invite insert and its audit
event and chain link commit in **one** D1 batch, so an aborted chain rolls the
mutation back rather than recording an unaudited change. `buildAuditRecords`
is imported from `teams.ts`, so the chain construction is the real one; a test
verifies two consecutive SCIM-authored links with the OSS `verifyAuditPage`.

Two things are duplicated rather than imported, because `teams.ts` does not
export them: `commitAudited` and the invite/audit SQL. They carry `/* ee:... */`
markers. **If `teams.ts` later exports `commitAudited` and its invite
statements, delete the duplicated block in `ee.ts` and call it directly.**

The response is a SCIM User with `active: false` — provisioned but not yet
accepted; the invite exists, the account does not. The raw invite token is
deliberately **not** in the response: a directory has no use for it and IdPs
log SCIM responses.

`roles: [{value}]` is honored when it names an invitable role. Absent,
unrecognized, or `owner` all default to `member` — least privilege, and invites
can never confer ownership (migration 0004 enforces the same set).

### Data masking — `/v1/ee/masking-rules` + `applyMaskingRules`

A rule names a field-path pattern and what to do with a matching value.

```
GET    /v1/ee/masking-rules        session, admin
POST   /v1/ee/masking-rules        session + CSRF, owner   {field_pattern, action}
DELETE /v1/ee/masking-rules/{id}   session + CSRF, owner
```

**Pattern language.** Dotted path segments. `*` matches any run of characters
*within* one segment; `**` matches zero or more whole segments. Array elements
are addressed by index. Segment characters are `[A-Za-z0-9_-]` plus the
wildcards, and nothing else — an unrecognized character is a rejected rule, not
a literal.

```
user.email          the email under user
metadata.api_*      any metadata key starting with api_
**.content          content at any depth
messages.0.content  the first message's content
```

**Actions.** `hash` replaces the value with `sha256:<hex>` of its canonical
JSON — the field's presence and equality-joinability survive, the content does
not. `drop` removes the field from its parent object, or the element from its
parent array (which compacts the array). A matched node is not descended into:
replacing or removing it settles everything beneath it. `drop` beats `hash` on
the same path, because removing is strictly stronger.

**Deterministic.** Rules are sorted before use, object keys are visited in
sorted order, and the reported `hashed`/`dropped` path lists are sorted and
de-duplicated. The same `(rules, payload)` pair always yields identical output;
a test asserts that reversing the rule array changes nothing.

**Fail-closed**, in the only sense that matters for a masking function:

```ts
type MaskingResult =
  | { ok: true; value: unknown; hashed: string[]; dropped: string[] }
  | { ok: false; error: string };
```

If any rule fails to compile, or the payload exceeds 32 levels of nesting or
10,000 nodes, **nothing is returned** — there is no `value` field at all on the
failure branch, so a caller cannot accidentally forward a half-masked payload
by ignoring `ok`. A masking function that does its best on a rule it did not
understand is worse than no masking function, because it looks like it worked.

The same validator (`compileMaskingRule`) runs at write time on
`POST /v1/ee/masking-rules`, so an uncompilable rule can never reach the table
— where it would otherwise fail-close every subsequent call for that workspace
and drop real telemetry.

`applyMaskingRules` is `async` only because SHA-256 is. There is no I/O, no
clock, and no randomness in it.

#### Follow-up: wiring masking into ingest

**Not done, and deliberately out of scope for this slice.** Nothing in
`src/ingest.ts` was touched. The pure function and its CRUD surface exist; the
call site does not.

The wiring is a single point in the ingest path:

1. `loadMaskingRules(env.DB, workspaceId)` (exported from `ee/src/ee.ts`)
   for the batch's workspace — cacheable, since rules are immutable and change
   only by create/delete.
2. `applyMaskingRules(rules, event)` per event, before `buildReceipt` /
   `canonicalJsonStringify` — masking must happen before the content hash and
   the deterministic `event_id` are derived, or replays of the same telemetry
   will produce different ids.
3. On `{ok: false}`: reject the batch with a structured denial rather than
   ingesting unmasked. Fail-closed at the boundary is the whole point.

Two open decisions for whoever picks this up: whether masking runs before or
after OTLP conversion (before is more general, after is cheaper), and whether a
masked workspace's `test/ingest.test.ts` 7-statement pin needs to change (it
should not — masking transforms the payload, it does not add a statement).

### Audit export — `GET /v1/ee/audit/export`

A convenience surface, not new evidence. The tamper-evident hash chain already
lives on the spine (`src/teams.ts` + the `audit_chain` triggers in migration
0004); this streams it out for a SIEM.

```
GET /v1/ee/audit/export?after_seq=0&limit=1000    session, admin
-> application/x-ndjson
```

Covers `TEAM_EVENT_KINDS` (imported from `teams.ts`, so the two can never
drift) plus `alert.fired` — which *is* the alert history, parity row 43 — and
`verification.recorded`. One event document per line, `raw_json` verbatim, so
the exported bytes still verify against their content hashes.

Ordered by ascending `seq`. `x-hfg-audit-next-seq` names the resume point when
a full page was returned; a short page omits it. Scoped by
`WHERE workspace_id = ?1` in the query, not filtered afterwards — a test
asserts the bind.

Canonical JSON contains no literal newline by construction, but a row that
somehow did would corrupt the framing of the whole stream, so such a row is
skipped and counted in `x-hfg-audit-skipped` rather than emitted.

---

## Part 3: the assistant

```
POST /v1/assistant     sk_ API key, or device token with 'read'
{ "question": "...", "gateway_key": "vk_...", "model": "..." }
```

```json
{
  "answer": "...",
  "provenance": "INFERRED",
  "tools_used": ["get_workstream_context"],
  "evidence_refs": ["ses_...", "ws_..."],
  "model": "gpt-5",
  "tool_calls": 1
}
```

### Four commitments

**1. It cannot see more than the caller.** The assistant has no credential and
no workspace scope of its own. It authenticates the caller with
`authenticateReadPrincipal` — the same resolver the public REST API and
`POST /v1/mcp` use — then forwards the caller's *exact* `Authorization` header
into every tool call. Whatever the caller could not read through MCP, the
assistant cannot read either: not by policy, but because no code path exists.

**2. It uses our own MCP tools, in-process.** The tool catalogue is not a copy
of `src/mcp.ts`'s `TOOL_DEFS` maintained in parallel. It is fetched per request
by issuing a `tools/list` JSON-RPC message to `handleMcpRoute` through a
synthetic `Request`; execution goes the same way via `tools/call`. No HTTP hop,
no duplicated tool logic, and a tool added to `mcp.ts` appears here with no
change to `assistant.ts`. (The synthetic-Request idiom is the platform's own —
`index.ts`'s OTLP handler replays the event-batch pipeline the same way.)

**3. Bring your own model.** The caller supplies `gateway_key` and `model`. The
call goes through this platform's gateway (`src/gateway.ts`), which resolves the
`vk_` key, unseals the customer's upstream credential, applies their rate limit,
and captures the request. HandoffGraph never holds a model credential for the
assistant, and assistant spend shows up next to every other gateway request.

**4. `INFERRED`, always, and never fabricated.** Every successful answer carries
`"provenance": "INFERRED"`. A model's prose about telemetry is a model's prose;
it is not observed evidence and this platform never labels it as such.

`evidence_refs` carries platform ids **the tools returned**, harvested by shape
(`^[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{26}$`) from tool results and never from model
output — so a hallucinated id cannot reach it. A test writes a plausible but
invented `ws_` id into the model's answer and asserts it appears in the prose
and *not* in `evidence_refs`. That separation is why the field exists.

### The loop

Up to `MAX_TOOL_CALLS` (5) tool executions, so at most 6 model turns.

The model speaks exactly one JSON object per turn:

```json
{"tool_call": {"name": "get_workstream_context", "arguments": {"workstream_id": "ws_..."}}}
{"answer": "..."}
```

This is deliberately *not* OpenAI-native tool calling: `gateway_key` may point
at any upstream (OpenAI, Anthropic, or custom — see `UPSTREAM_PROVIDERS` in
`src/gateway.ts`), and a plain-JSON convention described in the system prompt is
the one calling convention all of them can honor. The cost is that parsing must
be strict, and it is. The single tolerated deviation is a wrapping markdown code
fence, because emitting one is near-universal model behavior and stripping it is
unambiguous.

### Every failure fails closed

No error response contains an `answer` field. Each is asserted.

| Condition | Response |
| --- | --- |
| Model unreachable / gateway denial | `502 assistant_model_unavailable` |
| Reply is not one valid JSON turn | `502 assistant_protocol_violation` |
| Model requests a nonexistent tool | `502 assistant_unknown_tool` |
| A tool call errors | `502 assistant_tool_failed` |
| A 6th tool call is requested | `502 assistant_tool_budget_exhausted` |
| `tools/list` unavailable | `502 assistant_tools_unavailable` |

A failed tool ends the request. The alternative — telling the model "that
failed, carry on" — invites it to answer from nothing, which is exactly the
fabrication this endpoint exists to prevent. The test scripts a tool error
followed by a confident answer and asserts the answer never reaches the caller.

### Note on the EE gate

The assistant is flag-gated under EE **for now**, and that is a product
decision rather than a technical one. The plan positions it as BYO-model with
`INFERRED` answers, which is equally coherent as an OSS feature: it holds no
proprietary model, bills through the customer's own gateway key, and reads only
what the caller could already read.

Moving it out of the fence is a file move plus moving one delegation pair in
`index.ts`; nothing in `assistant.ts` depends on being Enterprise. It is fenced
here only because rows 48 and 51 landed in one slice and the narrower default
was the safer one to ship.

---

## What is placeholder-grade

Stated plainly so nobody mistakes the seams for finished product:

- **`platform/ee/LICENSE` is a placeholder.** Clearly not Apache-2.0, clearly
  proprietary, evaluation-only, and explicitly superseded by real EE legal text
  when that is written. It exists so the boundary is unambiguous in source
  control from the first commit.
- **Masking is not wired into ingest.** See the follow-up section above.
- **SSO records a binding**; it does not implement SSO (AuthKit does, already).
- **SCIM is a subset**: no `PATCH`, no `DELETE`/deprovisioning, no Groups, and
  `totalResults` reports what the page returned rather than a `COUNT(*)`.
- **SCIM-provisioned invites are attributed to the workspace's
  longest-standing active owner**, because `workspace_invites.created_by` is a
  `NOT NULL` foreign key to `users(id)` and a directory has no human actor. A
  future migration can pin the issuing admin onto `ee_scim_tokens` instead.
  With no active owner, provisioning fails closed rather than writing an invite
  with no accountable creator.
- **The audit export is a read surface only** — no scheduled push, no S3/SIEM
  connector.
