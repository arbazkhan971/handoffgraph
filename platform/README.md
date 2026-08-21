# HandoffGraph Platform (Cloudflare Worker)

Skeleton for the hosted platform (v0.8.0+): a D1-backed, workspace-scoped
API Worker. Local-first capture stays the source of truth; the platform only
ever receives validated, workspace-bound event batches and serves derived
listings.

## Layout

- `src/index.ts` — Worker entry: routing + handlers (`/healthz`,
  `/v1/event-batches`, `/v1/workstreams`)
- `src/auth.ts` — device-token authentication (SHA-256 hashing, constant-time
  compare, workspace binding)
- `src/ingest.ts` — pure validation / receipt / pagination logic (no I/O)
- `migrations/` — D1 schema (`0001_init.sql`)
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

# Run and deploy.
npx wrangler dev        # http://localhost:8787
npx wrangler deploy     # https://handoffgraph-api.<account>.workers.dev
```

## Environment variables

No secrets are required for the skeleton: authentication uses device tokens
stored (SHA-256 hashed) in D1, and no external services are called. When the
commented-out bindings in `wrangler.toml` are enabled (R2 `BODIES`, Queue
ingestion, DO `WorkstreamRoom`), add any credentials with
`npx wrangler secret put <NAME>`.

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
         "kind":"command.completed","occurred_at":"2026-08-21T10:00:00Z"}]}'
curl -s "localhost:8787/v1/workstreams?limit=10" -H "Authorization: Bearer $TOKEN"
```

## API

| Method | Path                | Auth                  | Notes                                       |
| ------ | ------------------- | --------------------- | ------------------------------------------- |
| GET    | `/healthz`          | none                  | liveness                                    |
| POST   | `/v1/event-batches` | Bearer device token   | idempotent ingestion, ≤500 events, ≤1 MiB   |
| GET    | `/v1/workstreams`   | Bearer device token   | cursor pagination, `limit` ≤100 (default 50) |

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
- Batches are capped at **500 events** and **1 MiB** bodies (`413` beyond).
- Envelope and per-event minimum validation is fail-closed: an invalid batch
  stores nothing (`400`).
- A **duplicate `Idempotency-Key` returns the original receipt (`200`)**,
  byte-for-byte, without re-storing.
- Events are append-only: rows are `INSERT OR IGNORE` keyed on
  `(workspace_id, event_id)`, so re-sent events never duplicate.
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
- Handler errors never leak internals (`500 {"error":"internal error"}`).

## Tests and validation

```bash
npm test                       # vitest unit tests
npm run typecheck              # tsc --noEmit
npm run deploy:dry             # wrangler deploy --dry-run --outdir dist
```

## Later versions (commented in wrangler.toml)

- **R2 `BODIES`** — content-addressed span bodies, referenced from
  `spans.body_ref`, never inlined into D1.
- **Queue ingestion** — `POST /v1/event-batches` enqueues instead of writing
  synchronously when volume requires it.
- **DO `WorkstreamRoom`** — live presence/subscription rooms per workstream.
