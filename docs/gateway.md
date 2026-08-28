# Gateway capture mode

An OpenAI-compatible proxy you reach by changing two lines of config. Parity
rows 6 (virtual keys, budgets, rate limits) and 7 (response caching, provider
fallback).

```python
client = OpenAI(
    base_url="https://api.handoffgraph.dev/gateway/openai/v1",
    api_key="vk_...",          # a HandoffGraph virtual key, not your provider key
)
```

## Why this exists

It is not because the world needs another router. Cloudflare's own AI Gateway
ships spend limits and unified billing, and LiteLLM and OpenRouter iterate on
routing faster than we will. Helicone — the closest thing to a direct
precedent — is in maintenance mode.

What none of them do is put the proxied call in the *same verified spine* as
the coding-agent evidence that caused it. When an agent's run produces a bad
diff, "which model calls did it make, in which workstream, at what cost" is a
question about one event log, not a join across two products.

So the design bias is explicit: **capture is first-class, routing is
adequate.** Where the two conflict, capture wins.

## Surfaces

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/v1/gateway/keys` | device bearer, `ingest` |
| `GET` | `/v1/gateway/keys` | device bearer, `read` |
| `POST` | `/v1/gateway/keys/{id}/disable` | device bearer, `ingest` |
| `POST` | `/gateway/openai/v1/chat/completions` | virtual key (`vk_…`) |
| `GET` | `/gateway/openai/v1/models` | virtual key (`vk_…`) |

Management routes use the platform's normal `{error}` envelope and denial
rules (foreign workspace → 404, own-but-forbidden → 403). Proxy routes speak
**OpenAI's** error shape instead — `{"error": {"message", "type", "code"}}` —
because the whole promise is that an unmodified OpenAI client works, and that
includes its error handling.

Proxy error codes:

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `stream_unsupported` | `stream: true` — see limitations |
| 400 | `invalid_request_body` | body is not a JSON object |
| 401 | `invalid_api_key` | unknown key, or no `vk_` bearer |
| 401 | `key_disabled` | key exists but was revoked |
| 429 | `budget_exhausted` | `budget_spent >= budget_amount` |
| 429 | `rate_limit_exceeded` | per-key per-minute limit |
| 502 | `upstream_unavailable` | primary and every fallback failed |
| 503 | `gateway_sealing_key_unavailable` | `GATEWAY_SEALING_KEY` is unset |

## Virtual keys

```http
POST /v1/gateway/keys
Authorization: Bearer dev_...

{
  "name": "prod",
  "budget_amount": "25.00",
  "rate_limit_per_min": 120,
  "capture": "metadata",
  "upstream": {
    "base_url": "https://api.openai.com/v1",
    "provider": "openai",
    "api_key": "sk-..."
  },
  "fallbacks": [{ "base_url": "https://...", "api_key": "sk-..." }]
}
```

The response contains `virtual_key` **once**. Only `sha256(token)` is
persisted, exactly like device tokens — there is no path that can read a
virtual key back out.

Upstream provider credentials are AES-256-GCM sealed under the worker secret
`GATEWAY_SEALING_KEY` (`wrangler secret put GATEWAY_SEALING_KEY`), the same
scheme as webhook signing secrets. **Both key creation and proxying fail
closed with 503 while that secret is unset.** A gateway that cannot seal a
credential must not be handed one, and it must never quietly fall back to
forwarding the caller's own key.

Keys are disabled, never deleted. Migration 0010 holds `token_hash` and
`workspace_id` immutable by trigger, so rotation means minting a new key —
otherwise historical ledger rows would silently change meaning.

### D1 is the truth, KV is the cache

`gateway_keys` in D1 is authoritative. `GATEWAY_KV` holds a copy under
`vk:<sha256(token)>` purely to save a database read at the edge.

Reconciliation is deliberately one-directional:

1. **Every mutation is a D1 write-through, then a KV put.** Create, disable
   and each spend advance all commit to D1 first. A KV write failing is
   ignored (logged, content-free) — it can only cost a cache miss.
2. **A KV miss reads D1 and backfills KV.** A corrupt or unparseable entry is
   treated as a miss and overwritten.
3. **Cached entries carry a 300 s TTL,** so even a lost revocation write
   self-heals inside five minutes.
4. **D1 wins on any disagreement.** Nothing reads back from KV into D1.

The proxy is fully functional with no KV binding at all: it reads D1 on every
call and stops enforcing rate limits (the budget, which is the hard stop,
still applies). That is why the `wrangler.toml` block ships commented out.

## Capture — the actual product

Every proxied call appends one `hfg.event.v1` event to the same append-only
`events` table as coding-agent evidence, via the same INSERT-only path.

- **Kinds:** `gateway.request.completed` (upstream status < 400) and
  `gateway.request.failed`.
- **Provenance: `OBSERVED`.** Status, latency and token counts are things
  this Worker directly measured or received.
- **Event ids are deterministic:** `evt_` + ULID(start-ms, sha256("gateway|" +
  key id + "|" + request digest)). The ledger row id (`gwr_`) is derived from
  the same material, so a retried write commits the same rows instead of
  double-charging.
- **Workstream linkage:** send `X-HandoffGraph-Workstream: ws_…` and the
  event is tagged with it. This is the join that makes the whole slice worth
  building. A malformed value is ignored rather than rejected — an annotation
  is not worth failing someone's LLM call over.

Payload (content-free at the default tier):

```json
{
  "cached": false,
  "capture_tier": "metadata",
  "cost_amount": "0.0021",
  "cost_provenance": "provider_reported",
  "fallback_index": 0,
  "latency_ms": 812,
  "model": "gpt-4o-mini",
  "request_hash": "sha256:…",
  "status": 200,
  "token_input": 11,
  "token_output": 7,
  "upstream_provider": "openai",
  "virtual_key_id": "gwk_…"
}
```

`fallback_index` is `0` for the primary upstream, `1..n` for the fallback
that actually answered, and `null` for a cache hit (no upstream was called).

### Cost is recorded, never estimated

`cost_amount` is populated **only when the upstream itself reported a cost**,
and then always alongside `cost_provenance: "provider_reported"`. Otherwise it
is `null`.

We could multiply token counts by a price table and produce a number for every
call. We don't. That number would be `INFERRED`, and this platform does not
write INFERRED money as fact — a plausible cost is worse than no cost, because
it is indistinguishable from a real one downstream. A JSON cost that cannot be
represented exactly as a decimal string (`1e-7`, a negative) is refused for
the same reason rather than reinterpreted.

All money is a **decimal string** end to end — `"0.0021"`, never `0.0021`.
Addition and comparison scale both operands to a common power of ten and work
in `BigInt`, so a thousand `"0.001"` charges sum to exactly `"1.000"`.

### Content discipline

The default capture tier is `metadata`:

- `gateway_requests` has **no column that could hold a prompt or completion**.
  Content-freeness is a property of the schema, not of the code that writes to
  it.
- The event payload carries digests only.
- The event's `content_hash` stays `NULL`, because a hash pointing at nothing
  retained is a lie about what was kept.

A key created with `"capture": "full"` additionally writes the request and
response bodies to `gateway_capture_bodies`, content-addressed by
`sha256:<hex>` and marked with their role. Those rows are immutable by trigger
but **deletable**, so downstream redaction has exactly one place to purge.
Only then does the event carry a `content_hash`.

### Capture never blocks the caller

The ledger row, the budget advance, the capture event and any captured bodies
commit as **one D1 batch**. If that batch fails, the failure is logged
content-free and the model's answer is still returned. Hosted bookkeeping
failing is our problem, not the caller's — the same rule that keeps hosted
failures from blocking local capture.

One retry exists. Because event ids are a pure function of (key, request
digest, start millisecond), two byte-identical requests in the *same
millisecond* derive the same id with different latency payloads, and the
spine's payload-conflict trigger rejects the batch. We retry once **without**
the event insert: the spine already holds an event for that identity, and the
spend must still be recorded.

### The ledger, not the counter, is the source of truth

`gateway_keys.budget_spent` is a fast cached counter so budgets can be
enforced *before* forwarding. `gateway_requests` is the ledger of record, and
`budget_spent` is always reconstructible from it.

Two properties keep them consistent:

- The advance is **derived inside SQL from the stored counter**, not from the
  value the worker read at request start, so two overlapping charges compose
  instead of one clobbering (or silently dropping) the other. SQLite has no
  decimal type, so both operands are scaled to a common power of ten and added
  as 64-bit integers — the same exact rule as `addDecimalStrings()`, result
  scale `max(scale(stored), scale(cost))`, nothing rounded. A sum that would
  need more than 18 digits at that scale evaluates to `NULL`, which the
  `NOT NULL` column rejects: the batch rolls back rather than committing a
  wrong amount.
- The single guard is that **this request's ledger row does not exist yet**,
  so a replay of a deterministic request id cannot charge twice. That
  statement is ordered *before* the ledger insert in the batch — D1 runs a
  batch sequentially in one transaction, so checking afterwards would always
  see the row just written and never charge at all.

### The KV mirror is a read-after-write, never a local sum

The edge budget gate reads `vk:<sha256(token)>` from KV, so that entry is what
actually enforces the hard cap. After the batch commits, the worker re-reads
`budget_spent` from D1 and mirrors **that** value. Deriving the mirror locally
(`value read at request start + cost`) is unsafe: under a concurrent charge or
a replay it is lower than what D1 holds, and writing it walks the enforced
counter *backwards*, letting further requests through past an exhausted budget.

The two failure directions are deliberately asymmetric. A mirror that is too
high over-enforces for at most the 300 s KV TTL and then self-heals from D1; a
mirror that is too low is a paid-for bypass. So the mirror is left untouched
when the committed value cannot be read, or when the cached entry already holds
a value at least as large.

## Budgets and rate limits

Budgets are checked **before** the upstream call: `budget_spent >=
budget_amount` returns 429 `budget_exhausted`. Comparison is scale-aware, so
`"10.00"` and `"10"` are the same boundary. A `null` budget is uncapped.

Rate limiting is a per-key fixed window counted in KV (`rl:<key id>:<minute>`,
60 s expiry). It is **best-effort by construction**: read-modify-write is not
atomic, so bursts spread across colocations can overshoot. It is a cost guard
rail, not a security control — the budget is the hard stop. Saying so is
better than implying an exactness the mechanism does not have.

## Fallbacks

`fallbacks` are tried in array order, **at most once each**, after the primary
returns 5xx or throws (timeout, DNS, reset — all the same signal). Each target
is called with its own unsealed credential.

A **4xx is not retried.** The request itself is wrong; replaying it against
another provider just burns a second credential for the same rejection.

If every target is exhausted, the proxy returns 502 `upstream_unavailable` and
still writes a `gateway.request.failed` capture event.

## Response cache

Opt in per request:

```http
X-HandoffGraph-Cache: true
```

- **Key:** `sha256` of the canonical JSON of `{model, messages, params}` —
  the semantic request, not its byte encoding, so key order cannot matter.
  `stream` is excluded (it never reaches an upstream here).
- **Storage:** the existing `BODIES` R2 bucket under
  `gwcache/<workspace_id>/<digest>.json`. No new binding.
- **TTL:** 300 s, checked against the object's `cached_at` custom metadata. An
  entry with no usable stamp is treated as a miss rather than served at
  unknown age.
- Only 200 responses are cached.

A hit is recorded with `cached = 1` and **no cost** — enforced by a schema
CHECK, so "cached calls are free" cannot be broken by a later code change — and
**still appends a capture event**. Omitting it would make the spine disagree
with the caller's own request count.

Responses carry `X-HandoffGraph-Cache: hit | miss` when caching was requested.

## Limitations in this version

These are decisions, not oversights.

**Streaming is rejected, not buffered.** `stream: true` returns 400
`stream_unsupported`. Buffering an SSE stream and replaying it would silently
destroy the time-to-first-token the caller asked for, and a proxy that
degrades performance without saying so is worse than one that refuses.
Supporting it properly means teeing the stream to the client while
accumulating usage from the terminal chunk.

**Custom base URLs get a literal-address guard only, not SSRF protection.**
`validateUpstreamBaseUrl` requires public https, rejects embedded credentials
and blocks literal loopback / RFC-1918 / link-local hosts, and upstream calls
use `redirect: "manual"`. It cannot see through DNS — a hostname that
*resolves* to `169.254.169.254` passes. A real guard needs
resolution-time address checks and redirect pinning.

**There is no Anthropic-native path.** `provider: "anthropic"` labels the
upstream for capture, but the wire format is still OpenAI's; point it at an
OpenAI-compatible endpoint. A native `/gateway/anthropic/v1/messages` route
would need its own request/response shape and usage extraction.

**`/models` is not written to the ledger.** It has no usage and no cost;
logging it would dilute the spend ledger with rows that can never carry
evidence.

## Operations

```sh
npx wrangler kv namespace create GATEWAY_KV   # then uncomment the block in wrangler.toml
npx wrangler secret put GATEWAY_SEALING_KEY
npx wrangler d1 migrations apply handoffgraph
```

Migration `0010_gateway.sql` creates `gateway_keys`, `gateway_requests` and
`gateway_capture_bodies`. Every table carries `workspace_id NOT NULL` and is
indexed on it, per platform convention.
