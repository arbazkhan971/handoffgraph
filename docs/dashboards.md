# Dashboards as config

A HandoffGraph dashboard is a JSON document, not a pile of rows. There is no
widget table, no layout table, and no partial update. You write a config, the
platform validates and canonicalizes it, and it is appended as an immutable
version. Reading a version back gives you exactly those bytes.

That single decision is why "custom dashboards" (parity row 39) and
"dashboards-as-config" (parity row 40) are the same feature here:

| You want | You use |
| --- | --- |
| Export a dashboard | `GET /v1/dashboards/{id}/versions/{n}` — the body *is* the config file |
| Import a dashboard | `POST /v1/dashboards` or `POST /v1/dashboards/{id}/versions` with the same bytes |
| Review a change | A diff of the committed JSON in a pull request |
| Gate CI on it | `POST /v1/dashboards/validate` — no reads, no writes, no side effects |
| Share a view | `POST /v1/dashboards/{id}/shares` → one unauthenticated read-only URL |

Implemented in `platform/src/dashboards.ts` and
`platform/migrations/0008_dashboards.sql`. A working example lives at
`deploy/dashboards/coding-agent-overview.json`, and the test suite validates it
from disk on every run — that file cannot rot.

## The config schema: `hfg.dashboard.v1`

```json
{
  "schema": "hfg.dashboard.v1",
  "name": "Coding agent overview",
  "variables": [{ "name": "window", "default": "-24h" }],
  "widgets": [
    {
      "id": "events-over-time",
      "title": "Events over time",
      "type": "series",
      "query": {
        "source": "events",
        "metric": "count",
        "interval": "1h",
        "since": "$window",
        "filters": { "workstream": "$workstream" }
      },
      "layout": { "x": 0, "y": 0, "w": 8, "h": 4 }
    }
  ]
}
```

All four top-level keys are required. `variables` must be present even when
empty — an omitted list is an error, not an implied `[]`, so a truncated file
is never mistaken for a valid one.

### Widgets

| Field | Rule |
| --- | --- |
| `id` | lowercase kebab-case, ≤ 40 chars, **unique within the document** |
| `title` | 1–120 characters |
| `type` | `series`, `summary`, `funnel`, or `table` |
| `query` | see below; the shape depends on `type` |
| `layout` | `{x, y, w, h}` integers on a 12-column grid |

Layout bounds: `0 ≤ x ≤ 11`, `0 ≤ y ≤ 999`, `1 ≤ w ≤ 12`, `1 ≤ h ≤ 24`, and
`x + w ≤ 12`. A widget that hangs off the grid is rejected rather than clipped.

### Queries

A widget query mirrors the request shape of the authenticated read APIs the
widget will actually call, so a config that validates names a query a browser
can issue.

| Field | Values |
| --- | --- |
| `source` | `events`, `observations`, `sessions` |
| `metric` | `count`, `error_rate`, `p50_duration_ms`, `p95_duration_ms`, `token_in`, `token_out`, `cost_amount` |
| `interval` | `5m`, `30m`, `1h`, `6h`, `1d` |
| `group_by` | `agent`, `kind`, `model`, `provider`, `session_id`, `status`, `tool_name`, `workstream_id` |
| `filters` | keys drawn from `agent`, `fingerprint`, `has`, `kind`, `model`, `provider`, `session`, `status`, `tool`, `workstream` |
| `since` / `until` | RFC 3339 (`2026-08-28T00:00:00Z`), relative (`-24h`, `-7d`, `-30m`), or `$variable` |
| `limit` | 1–1000 |
| `steps` | funnel only: 2–8 `{name, filters?}` entries with distinct names |

Per-type rules — enforced, not merely documented:

| Type | Requires | Forbids |
| --- | --- | --- |
| `series` | `interval` | `steps` |
| `summary` | — | `interval`, `group_by`, `steps` |
| `funnel` | `steps`, `metric: "count"` | `interval`, `group_by` |
| `table` | `group_by` | `interval`, `steps` |

A `summary` widget carrying an `interval` is **rejected**, not silently
stripped. The author plainly meant a `series`; shipping their document with the
bucketing quietly dropped would render something they never reviewed.

`cost_amount` is a decimal **string** everywhere at the API edge — money is
never a float on this platform. The config only names it as the quantity to
plot.

### Variables

```json
"variables": [{ "name": "window", "default": "-24h" }]
```

Names are lowercase snake_case (≤ 32 chars, unique, at most 8 per document).
Defaults are always strings, even when they stand for a number: one type makes
substitution total, and the canonical bytes never depend on how a JSON number
happened to be formatted.

A filter value or time bound of the form `$name` is a variable reference. **An
undeclared reference is an error.** Substituting an empty string for a typo'd
`$workstrem` would silently widen a query from one workstream to the whole
workspace.

A leading `$` always means "reference", so a *literal* value starting with `$`
(`"$100"`) is rejected as a malformed reference. That is deliberate: guessing
which `$…` the author meant is exactly the kind of silent reinterpretation this
schema refuses to do.

## Fail-closed validation

`validateDashboardConfig(doc)` is exported from `platform/src/dashboards.ts`.
It is pure: no clock, no randomness, no database. The same document always
yields the same verdict and the same bytes.

- **Unknown keys are rejected at every level** — document, variable, widget,
  query, layout, filter map, funnel step. A misspelled `widths` is a real
  layout change, so it fails loudly instead of being ignored.
- **Ceilings** — at most 24 widgets, at most 8 variables, at least 1 widget,
  and a canonical encoding of at most 32 KiB. The size limit is about the whole
  document: a config can sit under every per-field limit and still be rejected.
- **All errors, not the first.** CI gets the complete list, each with a
  precise path (`widgets[2].query.interval`), sorted by path so output is
  deterministic. The list is capped at 50 entries; when it is capped, a final
  `"N further errors were not reported"` entry is appended, so a truncated
  list can never be mistaken for a complete one.

### Canonical bytes and digests

An accepted config is **rebuilt from the validated parts**, not echoed back.
That is what makes two authors who type the same dashboard with different key
ordering — `{h,w,x,y}` versus `{x,y,w,h}` — produce the same stored bytes and
therefore the same `content_sha256`. The encoding is
`canonicalJsonStringify` from `platform/src/ingest.ts` (sorted keys, no
insignificant whitespace), the same encoder used for event content hashing.

## Routes

All routes take a device bearer token (`Authorization: Bearer dev_…`) except
the last one. Writes need the `ingest` capability, reads need `read`. Foreign
workspaces 404; own-but-forbidden 403. A wrong method on a known path is a 404.

| Method | Path | Cap | Does |
| --- | --- | --- | --- |
| `POST` | `/v1/dashboards` | ingest | Validate and store version 1 |
| `POST` | `/v1/dashboards/{id}/versions` | ingest | Append the next version |
| `GET` | `/v1/dashboards` | read | List: `{items: [{id, name, latest_version, updated_at}], next_cursor}` |
| `GET` | `/v1/dashboards/{id}` | read | Latest config (parsed) + version list + share metadata |
| `GET` | `/v1/dashboards/{id}/versions/{n}` | read | **The export.** Exact stored bytes |
| `POST` | `/v1/dashboards/validate` | read | CI dry-run. No reads, no writes |
| `POST` | `/v1/dashboards/{id}/shares` | ingest | Mint a share URL, returned **once** |
| `POST` | `/v1/dashboards/{id}/shares/revoke` | ingest | Revoke one link, or all of them |
| `GET` | `/v1/shared/dashboards/{token}` | **none** | Read-only: the latest config, nothing else |

### Creating and versioning

```bash
curl -sS -X POST https://api.handoffgraph.dev/v1/dashboards \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -n --slurpfile c deploy/dashboards/coding-agent-overview.json '{config: $c[0]}')"
```

`name` in the request body is optional; when supplied it must equal
`config.name`. The dashboard's name is then fixed, and every later version's
`config.name` must keep matching it — enforced by a trigger in migration 0008,
not just by the Worker. There is no rename route: renaming would either fork
the history or rewrite an immutable version.

Versions are dense from 1. If a concurrent writer claims the number you
computed, you get a `409` telling you to re-read and retry. The API never
silently bumps you to `N+2`, because that would let the other edit vanish from
the chain while still appearing to succeed.

### Export and round-trip

`GET /v1/dashboards/{id}/versions/{n}` returns the config document itself, with
no envelope around it:

```bash
curl -sS https://api.handoffgraph.dev/v1/dashboards/$ID/versions/3 \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  > deploy/dashboards/coding-agent-overview.json
```

The response carries `ETag: "sha256-<content_sha256>"` and
`X-HFG-Dashboard-Version`. The digest is the one recorded at write time over
exactly these bytes — the API serves stored bytes, never a re-serialization, so
the hash a reviewer quotes in a pull request is the hash the platform holds.

### CI dry-run

```bash
for f in deploy/dashboards/*.json; do
  curl -sS -X POST https://api.handoffgraph.dev/v1/dashboards/validate \
    -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
    -H 'content-type: application/json' \
    --data "$(jq -n --slurpfile c "$f" '{config: $c[0]}')" \
    --fail-with-body || exit 1
done
```

Valid configs return `200 {"valid": true, "content_sha256", "canonical_bytes",
"widget_count"}`. Invalid ones return `400` with the full error list:

```json
{
  "error": "dashboard config is invalid",
  "valid": false,
  "errors": [
    { "path": "widgets[1].query.interval", "message": "is not allowed on a summary widget" },
    { "path": "widgets[2].id", "message": "duplicate widget id \"error-rate\"" }
  ]
}
```

The in-repo half of this gate needs no network at all:
`platform/test/dashboards.test.ts` reads every file in `deploy/dashboards/`
with `readFileSync` and validates it, so a broken config fails `npm test`.

## Share links, and exactly what they expose

```bash
curl -sS -X POST https://api.handoffgraph.dev/v1/dashboards/$ID/shares \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN"
```

```json
{
  "share": { "dashboard_id": "dsh_…", "created_at": 1793000000, "revoked_at": null },
  "share_url": "https://api.handoffgraph.dev/v1/shared/dashboards/dshtok_…",
  "token": "dshtok_…",
  "warning": "Copy this share link now. Only its hash is stored; it cannot be shown again."
}
```

The token is `dshtok_` plus 256 bits of CSPRNG entropy. Only its SHA-256 is
persisted, so nobody — including someone holding a database dump — can mint a
working link from stored state. It is shown exactly once.

### The trust boundary

> **A share link hands out the layout. It never hands out the data.**

`GET /v1/shared/dashboards/{token}` is the only unauthenticated route on this
Worker. It resolves an unrevoked token to the dashboard's **latest config
document** and returns that and nothing else:

**Crosses the boundary:** widget titles, widget types, layout coordinates,
variable names and defaults, and the query shapes (source, metric, interval,
group-by, filter keys and values).

**Does not cross it:** every observation, event, session, span, token count,
cost figure, workstream title, member identity, device, workspace name and
workspace id. The response body has exactly four keys — `schema`, `name`,
`variables`, `widgets` — and the tests assert that the workspace id, device id
and dashboard id appear nowhere in it.

A shared dashboard renders because the viewer's browser runs those widget
queries against the **authenticated** read APIs using the viewer's own
credentials. Someone who opens the link without credentials sees the shape of a
dashboard and no numbers in it.

Two consequences worth being explicit about:

1. **Query shapes are metadata.** A filter value like
   `{"workstream": "ws_01J…"}` is baked into the config and therefore visible
   to anyone with the link. Do not put a secret in a filter value.
2. **The link is a bearer credential.** Anyone who has the URL can read the
   config. Responses are `no-store` and `X-Robots-Tag: noindex, nofollow`, but
   the only real control is revocation.

Unknown, malformed and revoked tokens all return the same `404 {"error": "not
found"}`, so the endpoint never confirms that a token once existed.

### Revocation

```bash
# Revoke every live link for this dashboard (the panic button — you do not
# need to still have the token).
curl -sS -X POST https://api.handoffgraph.dev/v1/dashboards/$ID/shares/revoke \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN"

# Or revoke exactly one.
curl -sS -X POST https://api.handoffgraph.dev/v1/dashboards/$ID/shares/revoke \
  -H "authorization: Bearer $HFG_DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"token": "dshtok_…"}'
```

An absent body means "revoke everything". A *malformed* body is a `400`, not an
absent one — a typo must never become a mass revocation.

Revocation is one-way, enforced by the `dashboard_shares_revoke_only` trigger.
Un-revoking a leaked link, or re-pointing a live token at a different
dashboard, are both silent privilege changes for whoever already holds the URL,
so the schema refuses them.

## Storage and schema guarantees

Migration `0008_dashboards.sql` creates three tables, each carrying an indexed
`workspace_id NOT NULL`.

| Table | Key | Guarantees |
| --- | --- | --- |
| `dashboards` | `id` (`dsh_<ulid>`) | Immutable after insert (`dashboards_immutable`) |
| `dashboard_versions` | `(dashboard_id, version)` | Append-only; dense from 1; config must be an `hfg.dashboard.v1` object ≤ 32 KiB and carry the dashboard's name |
| `dashboard_shares` | `token_hash` | Hash-only; revoke-only; must match its dashboard's workspace |

The invariants are triggers, not conventions:

- `dashboard_versions_forbid_update` / `_forbid_delete` — a published version
  is what a reviewer approved and what a share link serves. Rewriting one would
  change the meaning of a digest already quoted in a pull request. The delete
  guard is scoped to "while the parent dashboard still exists", so deleting a
  dashboard still cascades cleanly.
- `dashboard_versions_dense_sequence` — the version number must be exactly one
  past the current maximum, and the row's workspace and `config.name` must
  match the parent. Skipping ahead in the chain aborts.
- `dashboard_shares_revoke_only` — the only permitted mutation is
  `revoked_at: NULL → t`.

## Bindings

Dashboards need **no new Cloudflare binding**. Config documents and share-token
hashes live in D1; the export path serves stored bytes.

`platform/wrangler.toml` carries one commented, deliberately disabled
`DASHBOARD_SHARE_CACHE` KV block. It would cache token → latest-config
resolutions at the edge so an unauthenticated share read could skip D1. Enable
it only with a short TTL and open eyes: **a cached entry outlives a revocation
until it expires**, so the cache trades revocation latency for read latency.

## Related

- `docs/hosted-retention.md` — what the platform keeps and what it may reclaim.
- `platform/src/observations.ts` — the read APIs a widget query targets.
- `deploy/dashboards/coding-agent-overview.json` — the worked example.
