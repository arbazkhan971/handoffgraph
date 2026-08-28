# Review follow-ups (2026-08-28 ultracode wave)

The adversarial review that closed the ultracode waves confirmed and **fixed 13
findings** (4 commits, `fix(review): …`). It also surfaced lower-severity items
that were deliberately **deferred** rather than fixed in that pass. They are
recorded here so they are not lost. None blocks the `v0.7.0-beta.1` tag; each is
a hardening or polish item for a later cut.

## Deferred P2 findings (verified real, not yet fixed)

1. **`platform/src/otlp.ts` — TS `kindName` rejects the proto3-JSON enum NAME
   form** the docs promise to accept (only the numeric form is honored on one
   path). Low impact: emitters overwhelmingly send the numeric enum. Fix: accept
   both spellings, mirror Go.
2. **`platform/src/otlp.ts` — reserved-attribute-key drops are silent on the
   hosted path** (`otlp_dropped_attribute_keys` count not surfaced the way the
   local path surfaces it). Fix: count and report, matching Go `partialSuccess`.
3. **`platform/ee/src/assistant.ts` — assistant accepts a `gateway_key` from any
   workspace** (writes the caller's own spend, so no cross-tenant data leak, but
   the key is not bound to the caller's workspace). Fix: bind the vk_ key's
   workspace to the caller's before use.
4. **`platform/src/gateway.ts` — response cache is keyed per workspace only**, so
   one virtual key can serve another key's cached completion within the same
   workspace. Fix: fold the key id (or a per-key salt) into the cache key.
5. **`internal/commands/verify_cmd.go` — verify result cache is keyed only on the
   event log**, so an upgraded check set (new binary, same events) can serve a
   stale cached report. Fix: include a check-set version in the cache snapshot.
6. **`internal/otlp/proto.go` — protobuf decoder rejects the entire export with
   400 for a per-span structural error** where the JSON path rejects only the one
   span. Fix: downgrade recoverable per-span structural failures to a rejected
   span + partialSuccess.
7. **`platform/src/teams.ts` — `GET /v1/workspaces` emits a `next_cursor` its
   query never applies**, so pagination past the first page loops. Fix: honor the
   cursor in the query or stop emitting it.
8. **`platform/src/observations.ts` — `POST /v1/admin/reindex` truncates all
   three derived read models in a separate step** before rebuilding, so a crash
   mid-reindex leaves them empty until the next successful run. Fix: rebuild into
   shadow tables and swap, or wrap in one transaction.
9. **`platform/src/webhooks.ts` / `alerts.ts` — deliveries follow HTTP
   redirects**, letting a registered (guarded-at-registration) receiver 3xx the
   signed request to an internal address at delivery time. This is the
   egress-time half of the SSRF story the registration-time `urlguard` explicitly
   documents as out of its scope. Fix: `redirect: "manual"` on delivery fetches,
   or a Cloudflare egress policy.
10. **`internal/webui/server.go` — the local debugger API validates neither Host
    nor Origin**, so a visited web page could DNS-rebind to `localhost:<port>` and
    read the developer's captured event store. Localhost-bound and local-only, but
    worth a Host allowlist. Fix: reject requests whose Host is not
    `127.0.0.1`/`localhost:<port>`.

## Carry-forward caveats from the fixes that DID land

- **Gateway budget edge window (fix C):** the D1 charge and the KV mirror are two
  operations. If the KV put is lost or the worker dies between them, the edge
  gate under-enforces until `GATEWAY_KEY_KV_TTL_SECONDS` (300 s) heals it from
  D1. Pre-existing window, unchanged. Closing it needs a shorter TTL for
  budgeted keys or an authoritative D1 read at the gate for capped keys.
- **Eval-gate default (fix D):** an INFERRED LLM-judge score still *satisfies* a
  `min_score` gate by default; what changed is that the provenance is now always
  **recorded** in the `prompt.labeled` audit, and `require_observed: true` rejects
  an INFERRED-only pass. Flipping the default to require-observed is a separate,
  breaking policy decision.
- **Assistant tool surface (fix D):** a NEW MCP tool no longer appears in the EE
  assistant automatically — it must be declared `write: false` (the compiler
  forces the flag). Safe direction to be wrong in (fail-closed), but note it.
