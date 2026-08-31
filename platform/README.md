# HandoffGraph Platform (Cloudflare Worker)

Limited hosted-beta foundation: a D1-backed, workspace-scoped API Worker with
WorkOS AuthKit sign-up/sign-in, first-party browser sessions, one-time device
tokens, and transactionally enforced Basic-plan quotas. Local capture remains
account-free and is always the source of truth; reaching a hosted limit never
blocks the local CLI.

This code is deployment-ready but is not a claim that the public service is
live. All 22 migrations are applied and verified on the isolated staging D1;
production remains at the 0001 baseline. Production custom-domain routes are
already configured in Wrangler, but DNS/cutover and deployed HTTPS acceptance
remain open. WorkOS credentials, Turnstile, and WAF/rate controls must be in
place before production signup is enabled. Paid tiers and checkout are
deliberately not implemented.

## Layout

- `src/index.ts` — Worker entry, account pages, and API orchestration
- `src/auth.ts` — device-token authentication (SHA-256 hashing, constant-time
  compare, workspace binding)
- `src/account.ts` — AuthKit PKCE callback, hashed browser sessions, CSRF,
  account/device APIs, and retry-safe owner-confirmed deletion
- `src/account_page.ts` — framework-free, strict-CSP hosted account UI
- `src/plans.ts` — immutable public plan catalog (only Basic is provisionable)
- `src/quota.ts` — quota preflight and atomic reservation preparation
- `src/ids.ts` — centralized prefixed ULID generation for hosted durable IDs
- `src/db.ts` — minimal shared D1 seam for Worker code and tests
- `src/ingest.ts` — pure validation / receipt / pagination logic (no I/O)
- `migrations/` — D1 schema, accounts, entitlements, quota/deletion guards,
  and deterministic workstream projection metadata
- `test/` — vitest unit tests (pure functions + handlers against a mocked D1
  seam of plain objects)

## Setup

```bash
cd platform
npm install

# Create the D1 database (once), then paste the printed database_id into
# wrangler.toml, replacing "placeholder-replace-after-create".
npx wrangler d1 create handoffgraph

# Apply migrations — locally for dev. The staging remote is already current;
# production remains an explicit launch gate.
npx wrangler d1 migrations apply handoffgraph --local
npx wrangler d1 migrations apply handoffgraph-staging --env staging --remote

# Generate binding/runtime types, then run locally.
npm run types
npx wrangler dev        # http://localhost:8787
```

Do not run the production remote migration or production deploy until the
gates below are satisfied.

## AuthKit configuration

Create a WorkOS AuthKit application and allow these exact callbacks:

```text
https://handoffgraph-api-staging.arbaz-khan.workers.dev/v1/auth/callback
https://api.handoffgraph.dev/v1/auth/callback
```

Use the authenticated app origins below as the AuthKit **Homepage URL** for
their respective environments. The public marketing homepage remains
`https://handoffgraph.dev/`; it is not the callback or cookie origin.

```text
staging:    https://handoffgraph-api-staging.arbaz-khan.workers.dev/account
production: https://api.handoffgraph.dev/account
```

Register both exact URLs below as WorkOS **Sign-out redirect URIs**. Callback
registration alone is insufficient for provider logout:

```text
https://handoffgraph-api-staging.arbaz-khan.workers.dev/account
https://api.handoffgraph.dev/account
```

For local development, create `platform/.dev.vars` (gitignored):

```dotenv
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
TURNSTILE_SITE_KEY=0x4AAAA...
TURNSTILE_SECRET_KEY=0x4AAAA...
HOSTED_SIGNUP_ENABLED=true
```

For staging, set environment-specific credentials with the explicit Wrangler
environment flag; named-environment secrets are not inherited:

```bash
npx wrangler secret put WORKOS_CLIENT_ID --env staging
npx wrangler secret put WORKOS_API_KEY --env staging
npx wrangler secret put TURNSTILE_SITE_KEY --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
```

For production, set both in the default environment with `wrangler secret put`;
never commit them:

```bash
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Keep `HOSTED_SIGNUP_ENABLED` absent in production while staging and edge abuse
controls are incomplete. After those gates pass, enable new-account creation
with `wrangler secret put HOSTED_SIGNUP_ENABLED` and the exact value `true`.
Existing accounts can still sign in while the switch is absent or false, and
the sign-in callback is not allowed to create a new account.

`APP_ORIGIN`, `LANDING_ORIGIN`, and `WORKOS_REDIRECT_URI` are non-secret,
fixed values in `wrangler.toml`. If any auth setting is absent or malformed,
the auth start route fails closed; it never falls back to a local password
database or an unverified identity. When both Turnstile keys are configured,
the account page renders a form-integrated widget and only
`POST /v1/auth/start` with a same-origin, Siteverify-validated token can begin
the WorkOS redirect. A missing, replayed, expired, mismatched-action, or
provider-error token is rejected with no state cookies.

The AuthKit authentication response must contain an access token. HandoffGraph
verifies its signature with the client-specific WorkOS JWKS and binds its
`client_id`, `sub`, expiry, and bounded `sid` to the returned user before any
D1 mutation. The access token is then discarded, and any refresh token is
ignored. Only the verified WorkOS `sid` is retained as a provider logout
handle; it is not a bearer credential and is never returned by account read
models or as a standalone API field. After local revocation, it appears only
inside the no-store WorkOS logout URL sent to that authenticated browser.
HandoffGraph issues its own opaque browser session and device credentials and
stores only their SHA-256 hashes. Browser cookies never authorize ingestion;
bearer device tokens never authorize browser account actions.

Explicit sign-out first revokes the current user's active local session in D1.
Only after that commit succeeds does the account page receive a server-built,
fixed-return WorkOS logout URL and navigate the top-level browser through
WorkOS before returning to `/account`. A failed or lost local revoke returns no
logout URL and does not clear the browser cookies.

## Hosted Basic guardrails

The only provisionable hosted entitlement is Basic:

- 1 personal workspace and at most 2 active devices;
- 10 device-token issuances over the account lifetime (revocation releases an
  active slot but does not refund an issuance);
- 100 events and 256 KiB per batch;
- 5,000 events and 10 MiB per 30-day period;
- 25,000 events and 64 MiB for the account lifetime;
- no automatic overages and no checkout.

The quota reservation, counter update, idempotency receipt, events, and
projection commit in one D1 transaction. The trigger aborts the whole batch at
any limit. Reusing an idempotency key with another canonical request returns
`409`; identical retries return the original receipt and do not charge twice.
Legacy seeded workspaces without an entitlement fail hosted ingestion closed;
every newly created hosted account receives a Basic entitlement atomically.

Fields copied into indexed or projected D1 columns are independently bounded:
durable references must be canonical prefixed ULIDs, provenance is an explicit
three-value enum, content hashes are canonical SHA-256 strings, and provider,
native-session, kind, timestamp, and workstream-title fields have UTF-8 byte
caps. This prevents a valid-size request from multiplying into an oversized
index/read-model footprint. Reusing an event ID for different canonical
evidence returns `409` and rolls back its receipt and quota charge.

The limited beta also has a database-enforced lifetime ceiling of 50 account
issuances; removing an account does not refund a beta allocation. This bounds
aggregate allocation before public bot defenses exist. The
lifetime issuance cap prevents repeated create/revoke cycles from growing the
device table without bound. Device insertion/revocation and their entitlement
counters are coupled by D1 triggers, so failures cannot burn or bypass slots.
Keep both ceilings in place and add Turnstile/WAF rate controls before exposing
signup; these are cost backstops, not a complete abuse-prevention system.

## Environment bindings

Every deployed Worker surface needs its environment-specific D1 as `DB` and
R2 bucket as `BODIES`. Hosted Basic additionally pins
`HOSTED_SURFACE="basic"`. Basic has no object-producing HTTP,
queue, or scheduled path; R2 remains bound so deletion can fail closed and
sweep any pre-existing tenant objects during an upgrade. It also holds the
permanent `_hfg/` deletion and lifetime-capacity control records that keep D1
Time Travel from resurrecting a deleted workspace or refunding a Basic account
issuance. R2 read errors deny authenticated Basic requests; signup also fails
closed on control-record read/write errors. A missing or malformed `BODIES`
binding denies browser and device authentication at runtime under every
`HOSTED_SURFACE` value, including advanced; the TOML binding is not the only
guard. No
R2 lifecycle expiration rule may match `_hfg/`. Advanced objects are
tenant-prefixed under `artifacts/`, `exports/`, `attachments/`, and `gwcache/`;
the same exact prefixes bound self-service deletion. Analytics Engine, Queues,
`APIKEY_KV`, and `GATEWAY_KV`
are deliberately unbound because their advanced routes are outside Basic. If an
advanced deployment creates API/gateway keys, both exact KV bindings become
mandatory for deletion; the job fails closed if a captured key cannot be
invalidated. Account authentication and deletion make outbound HTTPS calls only
to WorkOS; ingest and read APIs do not call a model or identity provider.

Only the exact value `HOSTED_SURFACE="advanced"` enables ahead-of-gate routes
or their scheduled work. A missing, misspelled, or unexpected value stays on
the Basic surface, so configuration drift reduces privilege. The production
and staging Wrangler environments both pin the explicit Basic value.

## Explicit local-to-hosted sync

The CLI crosses the hosted boundary only when the user runs `handoffgraph
sync`; capture hooks never invoke it. Configure the API origin in the
user-level config or `HFG_HOSTED_API_URL`, and supply the device credential via
the protected token file or `HFG_DEVICE_TOKEN` rather than an argv flag.

```bash
handoffgraph sync --preview
handoffgraph sync --accept-redaction   # required for the first upload scope
handoffgraph sync                      # later incremental uploads
```

Preview is network-free and state-write-free. Sync snapshots a local high-water
mark, re-runs deep fail-closed redaction without mutating local events, and
persists the exact canonical pending batch before sending it so crash retries
reuse the same idempotency key and bytes. The server accepts external sync only
when every event attests `redaction.version = 1` and
`redaction.status = "clean"` or `"redacted"`; failed, missing, unknown, or
future-version attestations are rejected without storing the batch.

## Seeding a workspace + device (local dev)

```bash
TOKEN="dev_$(openssl rand -hex 24)"
TOKEN_HASH=$(printf %s "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $2}')
WS=wsp_01HTSTW0RKSPACE0000000000Z
npx wrangler d1 execute handoffgraph --local --command "
INSERT INTO workspaces (id, workspace_id, name, status, created_at) VALUES
  ('$WS', '$WS', 'local dev', 'active', strftime('%s','now'));
INSERT INTO devices (id, workspace_id, token_hash, label, capabilities, created_at) VALUES
  ('dev_01HTSTDEV0000000000000000Z', '$WS', '$TOKEN_HASH', 'dev box', 'ingest,read', strftime('%s','now'));
"
echo "device token: $TOKEN"
```

Smoke test:

```bash
curl -s localhost:8787/healthz
curl -s -X POST localhost:8787/v1/event-batches \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"schema_version":"hfg.event-batch.v1","events":[
        {"schema_version":"hfg.event.v1","event_id":"evt_01HTSTEVENT00000000000000Z",
         "kind":"command.completed","occurred_at":"2026-08-21T10:00:00Z",
         "observed_at":"2026-08-21T10:00:01Z",
         "redaction":{"version":1,"status":"clean","fields_removed":[]}}]}'
curl -s "localhost:8787/v1/workstreams?limit=10" -H "Authorization: Bearer $TOKEN"
```

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/account` | browser session optional | signed-in dashboard or signed-out entry |
| GET/POST | `/v1/auth/start` | none (+ Turnstile form when configured) | AuthKit redirect; `intent=signup\|signin` |
| GET | `/v1/auth/callback` | state + PKCE | verified identity → Basic account/session |
| GET | `/v1/me` | browser session | account, workspace, entitlement, usage |
| POST | `/v1/auth/signout` | session + Origin + CSRF | revoke local session; return fixed WorkOS logout URL |
| DELETE | `/v1/account` | owner session + Origin + CSRF + typed phrase | revoke credentials; durably purge the personal workspace |
| GET | `/v1/devices` | browser session | active devices in the personal workspace |
| POST | `/v1/devices` | owner session + Origin + CSRF | reserve a slot; return token once |
| POST | `/v1/devices/:id/revoke` | owner session + Origin + CSRF | revoke device and release its slot |
| GET | `/v1/plans` | none | honest catalog; Pro/Team unavailable |
| GET | `/healthz` | none | liveness |
| POST | `/v1/event-batches` | bearer device token | idempotent, globally ≤500/1 MiB; Basic ≤100/256 KiB |
| GET | `/v1/workstreams` | bearer device token | cursor pagination, `limit` ≤100 |

### POST /v1/event-batches

Headers: `Authorization: Bearer <device token>` (required),
`Idempotency-Key: <client-chosen unique key>` (required).

Body:

```json
{
  "schema_version": "hfg.event-batch.v1",
  "workspace_id": "wsp_...  (optional; must match the token binding if present)",
  "events": [ { "hfg.event.v1 envelope fields ...", "unknown fields are preserved" } ]
}
```

Behavior:

- **Workspace binding always comes from the token.** A body `workspace_id`
  that mismatches the token's workspace is a foreign write → `404` (foreign
  resources never confirm their existence).
- Batches are globally capped at **500 events** and **1 MiB** bodies (`413`
  beyond). Hosted Basic applies the smaller limits above and returns a
  structured `429` before storing anything.
- Quota 429s are intentionally not one generic retry signal. A monthly
  event/byte denial has `detail.retryable: true`, includes `resets_at`, and
  sends `Retry-After` delay-seconds until that reset. Per-batch and lifetime
  denials have `detail.retryable: false` and omit `Retry-After`: the former
  needs a smaller request and the latter an entitlement change. Every denial
  includes `local_capture_unaffected: true`.
- Envelope and per-event minimum validation is fail-closed: an invalid batch
  stores nothing (`400`). Required event timestamps and non-negative sequence
  values are checked; external sync requires redaction version 1 with status
  `clean` or `redacted`.
- A **duplicate `Idempotency-Key` returns the original receipt (`200`)**,
  byte-for-byte, without re-storing or re-charging. The key is tenant-scoped;
  reuse with a different canonical body returns `409`.
- Events are append-only: rows are `INSERT OR IGNORE` keyed on
  `(workspace_id, event_id)`, so re-sent events never duplicate.
- Accepted events transactionally update a derived workstream listing. The
  projection converges under replay and out-of-order delivery: earliest
  `workstream.started` title wins, latest lifecycle event determines status,
  and event IDs provide deterministic timestamp tiebreakers.
- Receipts are deterministic (`batch_id` = SHA-256 over the key, workspace,
  and event ids), so a recomputed replay equals the stored one.

### GET /v1/workstreams?cursor=&limit=

- `limit`: integer 1–100, default 50; `cursor`: opaque token from
  `next_cursor`.
- Requires the `read` capability on the device (else `403`).
- Ordering is deterministic: `created_at DESC, id DESC`.

### DELETE /v1/account

The JSON body must be exactly confirmed with
`{"confirmation":"DELETE <workspace_id>"}`. The account UI supplies the
workspace-specific phrase and a final browser confirmation. Accounts referenced
by another workspace are rejected with `409` and require support to resolve the
foreign membership/invite history, so the workflow never follows a user
relationship across tenant boundaries.

The exact active/unexpired browser session first wins a conditional D1
`active` → `deleting` prelock. A sign-out that commits first makes deletion
return `401` without a D1 deletion job or R2 ledger; once the prelock wins,
deletion owns completion. The Worker then conditionally creates and re-reads a
permanent R2 resurrection ledger outside all tenant prefixes. Only after that
does one D1 transaction install the tombstone first, revoke every browser
session/device and advanced credential, and capture only that tenant's exact
hashed KV cache names. The scheduled job validates the R2 ledger on every pass,
deletes the WorkOS user first (`404` is idempotent success), invalidates only
those KV keys, deletes only that workspace's four R2 prefixes, and purges every
tenant D1 table in one transaction. It then waits at least five minutes,
repeats exact KV invalidation, and requires an empty R2 sweep before completion.
WorkOS/KV/R2/D1 failures after job creation remain locked and retry; an R2
failure between prelock and job is a fail-closed manual-reconciliation state.
The local provider mapping is not purged before WorkOS succeeds. The permanent
D1 tombstone and one-way-hashed R2 ledger contain no email, provider subject,
payload, or credential hash. Local HandoffGraph stores are not affected.

### Security rules (platform-wide)

- Foreign resource → `404` (never leak existence); own-but-forbidden → `403`.
- All auth failures return an identical `401 {"error":"unauthorized"}`.
- Device tokens are stored only as SHA-256 hashes; comparisons are
  constant-time.
- Account sessions are opaque, host-only, `Secure`, `HttpOnly`,
  `SameSite=Lax` cookies; unsafe account requests require exact same-origin
  plus a per-session CSRF token.
- Account deletion additionally requires an owner role and an exact
  workspace-specific typed confirmation. Migration 0018 preserves ordinary
  append-only guards and opens deletes only for the exact tombstoned tenant.
- Device creation and revocation recheck the exact active/unexpired browser
  credential, including its token hash, in the final mutation. A sign-out or
  reauthentication rotation therefore cannot win after preflight while a
  stale request still creates or revokes a device. Device creation also
  requires the user, owner membership, and workspace remain active, so a
  deletion prelock is terminal.
- Every released Basic browser/device-auth route checks the independent R2
  deletion fence after D1 lookup. A matching ledger, missing/malformed Basic
  binding, or R2 read failure returns the same unauthorized boundary as an
  invalid credential.
- Device lookup joins the exact active workspace. Workstream listing repeats
  that authorization immediately before returning tenant rows, and migration
  0022 recreates the already-deployed 0019 ingestion trigger so the final
  receipt insert requires both an active device and active workspace. A
  prelock that wins during an in-flight read/write therefore returns `401` and
  commits no hosted write even if the permanent R2 ledger write then fails.
- WorkOS provider tokens, raw browser-session tokens, and raw device tokens
  are never stored or logged. A new device token is returned exactly once.
- Handler errors never leak internals (`500 {"error":"internal error"}`).

## Tests and validation

```bash
npm test                       # vitest unit tests
npm run typecheck              # generated-binding freshness + tsc --noEmit
npm run deploy:dry             # wrangler deploy --dry-run --outdir dist
```

CI also applies all migrations to an isolated local D1 database. The account
and quota suites cover PKCE/state failures, verified identities, cookie/CSRF
boundaries, plan truthfulness, exact/one-over limits, period reset, lifetime
caps, retry races, and migration triggers. The deletion suites use all real
migrations plus transactional SQLite, KV, R2, and fake-fetch seams to verify
tenant isolation, ordinary immutability, exact cache/object cleanup, WorkOS
success/retry/404 behavior, grace sweeps, failure rollback/retry, pre-deletion
D1-restore authentication blocking, session/logout commit races, R2 failure
denial, and ETag-linearized non-refundable beta capacity.

Latest launch-preflight verification (2026-08-31): 39 Vitest files and 1,619
tests pass; `tsc --noEmit` and both production/staging Wrangler dry bundles are
green. These local and dry-run results do not substitute for deployed browser
acceptance.

## Production gates

Before public signup:

1. configure WorkOS/AuthKit with both exact callback URLs and both exact
   staging/production Sign-out redirect URIs documented above;
2. provision Turnstile or equivalent WAF/rate controls for auth start/callback,
   signup, device creation, and event-batch ingestion;
3. redeploy/auth-enable the existing anonymous staging Worker with its
   already-verified 22-migration schema and prove the real callback, CLI sync,
   cross-tenant boundaries, quota rollback, and the full
   account-deletion/retry/grace-sweep flow;
4. preserve production rollback evidence, apply and verify all 22 migrations
   remotely, and confirm the 50-account capacity row;
5. deploy the already-configured API custom domain and test cookies on the
   real HTTPS origin during the controlled DNS cutover;
6. repeat anonymous, auth, logout, sync, tenant, quota, and deletion acceptance
   on production while signup remains absent;
7. enable signup with the exact value `true` only after every gate passes.

Billing is not a gate because billing is not present: Solo and Team are
non-purchasable previews. Adding paid self-service requires a separately
chosen payment provider, verified idempotent webhooks, and another review.

## Later versions (commented in wrangler.toml)

- **Queue ingestion** — `POST /v1/event-batches` enqueues instead of writing
  synchronously when volume requires it.
- **DO `WorkstreamRoom`** — live presence/subscription rooms per workstream.
