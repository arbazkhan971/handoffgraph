# HandoffGraph Platform (Cloudflare Worker)

Limited hosted-beta foundation: a D1-backed, workspace-scoped API Worker with
WorkOS AuthKit sign-up/sign-in, first-party browser sessions, one-time device
tokens, and transactionally enforced Basic-plan quotas. Local capture remains
account-free and is always the source of truth; reaching a hosted limit never
blocks the local CLI.

This code is deployment-ready but is not a claim that the public service is
live. WorkOS credentials, remote migration, custom domains, and edge abuse
controls must be configured before production signup is enabled. Paid tiers
and checkout are deliberately not implemented.

## Layout

- `src/index.ts` — Worker entry, account pages, and API orchestration
- `src/auth.ts` — device-token authentication (SHA-256 hashing, constant-time
  compare, workspace binding)
- `src/account.ts` — AuthKit PKCE callback, hashed browser sessions, CSRF,
  account/device APIs
- `src/account_page.ts` — framework-free, strict-CSP hosted account UI
- `src/plans.ts` — immutable public plan catalog (only Basic is provisionable)
- `src/quota.ts` — quota preflight and atomic reservation preparation
- `src/ids.ts` — centralized prefixed ULID generation for hosted durable IDs
- `src/db.ts` — minimal shared D1 seam for Worker code and tests
- `src/ingest.ts` — pure validation / receipt / pagination logic (no I/O)
- `migrations/` — D1 schema, accounts, entitlements, quota triggers, and
  deterministic workstream projection metadata
- `test/` — vitest unit tests (pure functions + handlers against a mocked D1
  seam of plain objects)

## Setup

```bash
cd platform
npm install

# Create the D1 database (once), then paste the printed database_id into
# wrangler.toml, replacing "placeholder-replace-after-create".
npx wrangler d1 create handoffgraph

# Apply migrations — locally for dev, remotely before deploy.
npx wrangler d1 migrations apply handoffgraph --local
npx wrangler d1 migrations apply handoffgraph --remote

# Generate binding/runtime types, then run locally.
npm run types
npx wrangler dev        # http://localhost:8787
```

Do not run the remote migration or deploy commands until the production gates
below are satisfied.

## AuthKit configuration

Create a WorkOS AuthKit application and allow this exact callback:

```text
https://api.handoffgraph.dev/v1/auth/callback
```

For local development, create `platform/.dev.vars` (gitignored):

```dotenv
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
HOSTED_SIGNUP_ENABLED=true
```

For production, set both with `wrangler secret put`; never commit them:

```bash
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
```

Keep `HOSTED_SIGNUP_ENABLED` absent in production while staging and edge abuse
controls are incomplete. After those gates pass, enable new-account creation
with `wrangler secret put HOSTED_SIGNUP_ENABLED` and the exact value `true`.
Existing accounts can still sign in while the switch is absent or false, and
the sign-in callback is not allowed to create a new account.

`APP_ORIGIN`, `LANDING_ORIGIN`, and `WORKOS_REDIRECT_URI` are non-secret,
fixed values in `wrangler.toml`. If any auth setting is absent or malformed,
`GET /v1/auth/start` fails closed with `503`; it never falls back to a local
password database or an unverified identity.

AuthKit access and refresh tokens are consumed only long enough to read the
verified immutable WorkOS user subject, then discarded. HandoffGraph issues
its own opaque browser session and device credentials and stores only SHA-256
hashes. Browser cookies never authorize ingestion; bearer device tokens never
authorize browser account actions.

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

The Worker currently needs only D1. R2, queues, and Durable Objects remain
commented future bindings. Account authentication makes an outbound HTTPS call
only to WorkOS during the authorization-code exchange; ingest and read APIs do
not call a model or identity provider.

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
         "observed_at":"2026-08-21T10:00:01Z"}]}'
curl -s "localhost:8787/v1/workstreams?limit=10" -H "Authorization: Bearer $TOKEN"
```

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/account` | browser session optional | signed-in dashboard or signed-out entry |
| GET | `/v1/auth/start` | none | AuthKit redirect; `intent=signup\|signin` |
| GET | `/v1/auth/callback` | state + PKCE | verified identity → Basic account/session |
| GET | `/v1/me` | browser session | account, workspace, entitlement, usage |
| POST | `/v1/auth/signout` | session + Origin + CSRF | revoke current browser session |
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
- Envelope and per-event minimum validation is fail-closed: an invalid batch
  stores nothing (`400`). Required event timestamps and non-negative sequence
  values are checked; an event marked `redaction.status=failed` is never
  accepted for sync.
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

### Security rules (platform-wide)

- Foreign resource → `404` (never leak existence); own-but-forbidden → `403`.
- All auth failures return an identical `401 {"error":"unauthorized"}`.
- Device tokens are stored only as SHA-256 hashes; comparisons are
  constant-time.
- Account sessions are opaque, host-only, `Secure`, `HttpOnly`,
  `SameSite=Lax` cookies; unsafe account requests require exact same-origin
  plus a per-session CSRF token.
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
caps, retry races, and migration triggers.

## Production gates

Before public signup:

1. configure WorkOS/AuthKit and its exact callback;
2. provision Turnstile or equivalent WAF/rate controls for auth/device-create;
3. apply migrations remotely and verify the 50-account capacity row;
4. deploy the API custom domain and test cookies on the real HTTPS origin;
5. verify account deletion/privacy/support procedures;
6. only then point landing-page signup links at the live service.

Billing is not a gate because billing is not present: Solo and Team are
non-purchasable previews. Adding paid self-service requires a separately
chosen payment provider, verified idempotent webhooks, and another review.

## Later versions (commented in wrangler.toml)

- **R2 `BODIES`** — content-addressed span bodies, referenced from
  `spans.body_ref`, never inlined into D1.
- **Queue ingestion** — `POST /v1/event-batches` enqueues instead of writing
  synchronously when volume requires it.
- **DO `WorkstreamRoom`** — live presence/subscription rooms per workstream.
