# Hosted MCP endpoint + public API keys

Two related surfaces so the hosted platform can be reached by both API
clients and MCP-speaking agents, using one credential:

- **Public API keys** (parity row 44) — project-scoped `pk_`/`sk_` credential
  pairs, a public read REST API under `/api/v1/`, and a hand-written OpenAPI
  3.1 document.
- **Hosted MCP** (parity row 21) — the local MCP server's tool layer,
  re-exposed remotely as JSON-RPC 2.0 over `POST /v1/mcp`, backed by hosted
  D1 data instead of a local SQLite file.

Implemented in `platform/src/apikeys.ts`, `platform/src/mcp.ts`, and
`platform/migrations/0011_api_keys.sql`.

## Two credential planes

The platform now has two distinct bearer-token planes, kept visibly separate
by path prefix and token prefix:

| Plane | Token | Path prefix | Capability model |
| --- | --- | --- | --- |
| Device (existing) | `dev_...` | `/v1/...` | `capabilities: string[]` (`ingest`, `read`) |
| API key (new) | `sk_...` | `/v1/...` (management) and `/api/v1/...` (public read) | `scopes: string[]` (`read`, `write`) |

`POST /v1/mcp` and the public read endpoints under `/api/v1/` accept
**either** plane. Everywhere a write is possible, the two planes map onto
each other: a device needs `ingest`, an API key needs `write`.

## API keys

### Lifecycle

```
POST   /v1/api-keys              device bearer, 'ingest'  -> create
GET    /v1/api-keys              device bearer, 'ingest'  -> list (envelope; never secrets)
POST   /v1/api-keys/{id}/revoke  device bearer, 'ingest'  -> revoke (one-way)
```

A key has two parts, stored in `api_keys` (migration 0011):

- `public_key` — `pk_` + 12 chars. An identifier, not a secret. Safe in logs,
  dashboards, and the `GET /v1/api-keys` listing forever.
- The **secret** — `sk_` + 43 chars — is generated at creation, returned
  **exactly once** in the `POST /v1/api-keys` response body, and never
  stored raw. Only `secret_hash` (SHA-256 hex) is persisted, the same
  discipline `devices.token_hash` and `webhook_endpoints.secret_hash` already
  use.

```json
// POST /v1/api-keys { "name": "ci bot", "scopes": ["read", "write"] }
{
  "id": "apk_...",
  "name": "ci bot",
  "public_key": "pk_...",
  "secret_key": "sk_...",
  "scopes": ["read", "write"],
  "created_at": 1700000000,
  "warning": "Copy secret_key now. It cannot be shown again."
}
```

`scopes` defaults to `["read"]`. `"write"` is required to call the two
mutating hosted MCP tools (`record_score`, `accept_handoff`); there is no
mutating public REST route yet, but the scope already gates the door for one.

Revocation (`POST /v1/api-keys/{id}/revoke`) is one-way — migration 0011's
`api_keys_revocation_is_terminal` trigger aborts any attempt to clear
`revoked_at` once set — and every other column is immutable after creation
(`api_keys_identity_is_immutable`), so the only lifecycle move is
revoke-then-recreate, never in-place secret rotation.

### Verification: edge-cached rejection

`authenticateApiKey(header, env)` (exported for reuse by both the public API
and the MCP endpoint) hashes the presented `Authorization: Bearer sk_...`
token and looks it up in D1 — fronted by `env.APIKEY_KV`, which caches the
**verdict** (not the secret) for 60 seconds, keyed by the SHA-256 of the
token:

- A **bad** key caches `{v:"rejected"}`. A second request with the same bad
  key resolves entirely from KV — **zero D1 queries** — for the rest of the
  cache window. This is the load-bearing property: without it, a client (or
  attacker) hammering one invalid key would cost one D1 query per request
  forever.
- A **good** key caches `{v:"ok", workspace_id, scopes, key_id}`, so a
  legitimate high-QPS caller also skips D1 after the first hit.
- **Revocation writes an immediate KV tombstone.** `POST
  /v1/api-keys/{id}/revoke` looks up the row's `secret_hash` in the same
  statement that revokes it, then writes `{v:"rejected"}` to that key's cache
  slot right away — a cached "ok" verdict can never outlive the revocation by
  the TTL.
- `APIKEY_KV` is **optional** in code. While the namespace is not provisioned
  (see the commented block in `wrangler.toml`), `authenticateApiKey` simply
  always falls through to D1 — correct, just uncached.

### Public read API (`/api/v1/*`)

```
GET /api/v1/workstreams    ?limit=&cursor=
GET /api/v1/sessions       ?limit=&cursor=&provider=&workstream=&since=&until=
GET /api/v1/observations   ?limit=&cursor=&workstream=&trace=&session=&kind=&status=&since=&until=
GET /api/v1/scores         ?workstream=(required)&limit=&cursor=&target_type=&target_id=&name=
GET /api/v1/openapi.json
```

Every list endpoint returns the same envelope: `{ "items": [...],
"next_cursor": string | null }`.

Three of the four are thin delegations to logic another module already owns
and exports:

- `workstreams` re-runs `ingest.ts`'s `buildWorkstreamListResponse` (the SQL
  itself is a documented duplicate of `index.ts`'s un-exported
  `WORKSTREAMS_PAGE_SQL` — `index.ts` doesn't export it).
- `sessions` and `observations` re-run `observations.ts`'s exported
  `buildSessionQuery` / `buildObservationQuery` directly. Only the row → JSON
  shaping is duplicated (`observations.ts` keeps its shapers module-private);
  `apikeys.ts` exports its copies (`publicObservationItem`,
  `sortPublicObservations`) so `mcp.ts`'s `get_trace_context` tool reuses
  them too instead of a third copy.
- `scores` is new — no module owned a score read model before this slice.
  Scores live directly in the append-only `events` table
  (`kind = 'score.recorded'`); ordering/pagination use `events.seq` (the
  table's monotonic `AUTOINCREMENT` key), not `occurred_at`, because
  `occurred_at` is caller-supplied RFC 3339 text on events ingested through
  `POST /v1/event-batches` and is not safe to compare lexicographically
  across formats. `buildScoreQuery` + `shapeScoreRow` are exported and reused
  verbatim by `mcp.ts`'s `list_scores` tool (via a synthetic `URL` built from
  the tool's JSON-RPC arguments, so both callers share one validated query
  path).

**Known follow-up for the orchestrator:** `events(workspace_id,
workstream_id, kind)` has no composite index — only the three single-column
indexes from migration 0001. The scores query is correct but not maximally
efficient at large per-workstream event counts. A future migration adding
`CREATE INDEX ... ON events(workspace_id, workstream_id, kind, seq)` would
let both `/api/v1/scores` and the MCP `list_scores` tool use an index-only
scan; out of scope here since `events` belongs to migration 0001, not 0011.

### OpenAPI (`GET /api/v1/openapi.json`)

Hand-written OpenAPI 3.1, generated from `PUBLIC_API_ROUTES` — the same array
`handlePublicApiRoute` dispatches from. Routing and documentation are built
from one source of truth, so "every implemented path is documented" and
"every documented path is implemented" hold by construction rather than by
two hand-maintained lists staying in sync (`test/apikeys.test.ts` verifies
both directions anyway, including a live probe of every documented path).

Scope: exactly the four `/api/v1/*` GET routes above. `/v1/api-keys*` (device
plane) and `/v1/mcp` (JSON-RPC, not REST) are intentionally not part of this
document.

## Hosted MCP (`POST /v1/mcp`)

JSON-RPC 2.0 over a single HTTP POST per message (batch/array requests are
rejected with `400` — "send one JSON-RPC message per POST" — rather than
silently processing only the first element).

```
initialize   -> { protocolVersion, capabilities: { tools }, serverInfo, instructions }
tools/list   -> { tools: [{ name, description, inputSchema }, ...] }
tools/call   -> { content, structuredContent, isError } | JSON-RPC error
```

Auth: `authenticateReadPrincipal` (shared with the public REST API) accepts
either an `sk_` API key (any scope may read) or a device bearer token with
`read`. A missing/invalid credential 401s **before** the JSON-RPC body is
even parsed.

### Six tools, not twelve

The local server (`internal/mcp`) exposes twelve tools over a local SQLite
file. Six have a hosted counterpart where hosted data actually exists:

| Tool | Hosted data source |
| --- | --- |
| `get_workstream_context` | `workstreams` + event-kind counts + `sessions` |
| `get_trace_context` | `span_observations` (via `observations.ts`'s `buildObservationQuery`) |
| `list_scores` | `events` where `kind = 'score.recorded'` |
| `get_prompt` | **stub** — see below |
| `record_score` | writes `events` directly (write tool) |
| `accept_handoff` | writes `events` directly (write tool) |

The other six (`create_checkpoint`, `record_decision`,
`record_verification`, `claim_files`, `handoff_workstream`,
`complete_workstream`) depend on local-only derived models — checkpoints,
file claims, the graph reducer — that have no hosted equivalent yet, and are
out of scope for this slice.

**`get_prompt`** always returns a clean JSON-RPC error (`-32602`,
`"hosted prompt store is not available yet..."`) rather than crashing or
silently returning nothing: the hosted prompt store (parity rows 33-34) has
not landed on this plane.

### Error mapping

Unlike the local server (which uses `-32602 Invalid params` for nearly every
tool-level rejection, including "not found"), this endpoint uses exactly two
error paths, kept deliberately simple:

- **`-32601` Method not found** — an unrecognized top-level JSON-RPC method,
  *or* an unrecognized tool name inside `tools/call`. (This second case is an
  explicit, deliberate choice for this slice: the requested tool capability
  does not exist on this server, so it is reported the same way an
  unrecognized top-level method would be, rather than as `-32602`.)
- **`-32602` Invalid params** — everything else a tool handler rejects:
  missing/malformed arguments, a workstream not found in this workspace (a
  foreign workstream id and a genuinely unknown one are indistinguishable, by
  design — the platform-wide "foreign resource is never leaked" rule applied
  to the MCP error surface), an out-of-vocabulary enum value, or insufficient
  scope on a write tool.

There is no `isError: true` tool-result path in this hosted subset — none of
the six tools has a genuine domain-state conflict analogous to the local
server's "workstream already completed" (`ToolError`); every rejection here
is a client-input problem, so every rejection is a protocol-level error.

### `record_score` / `accept_handoff`: writes and scopes

Both are **write** tools: `record_score` requires `write` scope (API key) or
`ingest` capability (device); the hosted vocabulary for `source` is narrower
than local's four values — `human | api | evaluation` (no `detection`: that
names a hosted detection pipeline that does not exist on this plane yet, so
it is omitted rather than accepted and silently misrepresented).

Both write **directly** to the append-only `events` table
(`INSERT OR IGNORE`) — never through the full `POST /v1/event-batches`
pipeline in `index.ts`, which also runs quota/idempotency-key bookkeeping and
`observations.ts`'s span/session projections that do not apply to these
non-span event kinds.

Event ids are **deterministic**: `src/otlp.ts`'s `deterministicID`, seeded
with the real capture time (not `0`) so the id's embedded ULID timestamp
stays correctly time-ordered like every other event id in the system, while
the content-hashed entropy portion still makes a byte-identical retry within
the same millisecond collapse to one row via `INSERT OR IGNORE` instead of a
duplicate — real network-retry protection, not full cross-time dedup (two
calls one second apart with identical arguments are two rows, correctly:
re-scoring is a legitimate repeatable action).

`accept_handoff` reads the latest `handoff.created` event for the workstream,
**if one exists**, purely to report `handoff_status: "pending" | "none"` in
its result — it never requires one to already exist, mirroring the local
server's backward-compatible acknowledgement path.

**Known follow-up for the orchestrator:** these two writes do not bump
`workstreams.updated_at` and do not run through
`buildObservationStatements` — `score.recorded` / `handoff.accepted` are not
span-shaped kinds `observations.ts`'s `spanShapeFor` models. Unifying that
would mean routing these writes through the same batch pipeline `index.ts`
uses for ingest, which is a larger change than this slice's assigned scope.

## Testing

- `test/apikeys.test.ts` — key lifecycle (create/list/revoke), the shown-once
  secret, the KV tombstone-on-revoke, the zero-D1-queries-on-cached-verdict
  property (both the rejected and accepted cases), the public read API
  (all four endpoints, both credential planes), OpenAPI bidirectional
  completeness (structural **and** a live probe of every documented path),
  and a `node:sqlite` pass proving migration 0011's `CHECK` constraints and
  triggers hold.
- `test/mcp.test.ts` — `initialize` / `tools/list` / `tools/call` happy
  paths, per-tool input validation, unknown-tool `-32601`, the
  `record_score` append shape (`INSERT OR IGNORE`, deterministic `evt_` id,
  exact bound values), `accept_handoff`'s optional handoff-status read, scope
  enforcement (a read-only `sk_` key cannot call either write tool; a
  write-scoped one can), transport-level error shapes (batch rejection,
  parse errors, bad envelopes), and foreign-workspace scoping.

Both files use the plain-object `mockDb` pattern established by
`test/webhooks.test.ts` (D1 statements are counted by their marker comments,
which is what makes the zero-D1-queries property directly assertable) — no
`miniflare`, no new npm dependencies.
