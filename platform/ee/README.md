# HandoffGraph Enterprise

**This directory is NOT open source.** See [`LICENSE`](./LICENSE). The
repository's OSS license covers everything in this repo *except* this
directory tree.

Parity rows 48 (SSO / SCIM / audit / data masking as a directory-fenced EE
tier) and 51 (in-product assistant). Full narrative documentation, including
the API surface and the operator runbook, is in
[`../../docs/ee.md`](../../docs/ee.md).

## The fence

Three mechanisms keep the tiers apart — a separate directory, a separate
license, and a flag. Never license soup: no per-file license headers scattered
through `platform/src/`, no build variants, no conditional migrations.

| | |
|---|---|
| **Directory** | Every line of EE code is under `platform/ee/`. Nothing in `platform/src/` implements an EE feature. Which license covers a file is answered by its path. |
| **License** | `platform/ee/LICENSE` covers this tree and nothing else. |
| **Flag** | `handleEERoute` returns `null` unless `env.EE_ENABLED === "true"`. |

`null` — not `403`, not a stub `404` — is the load-bearing detail. Returning
`null` hands the request back to `index.ts`'s dispatch chain, which falls
through to the platform-wide 404. With the flag absent (the default), every
`/v1/ee/*` path and `/v1/assistant` are indistinguishable from a URL this
Worker has never heard of: same status, same body bytes, same headers.
`test/ee.test.ts` asserts that byte-for-byte rather than merely asserting 404,
and asserts that no D1 statement is prepared either — a disabled deployment
cannot be probed for the existence of the EE tables.

The dependency arrow points one way. `ee/` imports from `src/`; `src/` imports
from `ee/` exactly once:

```ts
// platform/src/index.ts
import { handleEERoute } from "../ee/src/ee";
...
const eeResponse = await handleEERoute(request, env);
if (eeResponse !== null) return eeResponse;
```

One import, one delegation pair, placed last in the chain so no EE route can
shadow an OSS one. If that arrow ever reverses, the fence is gone.

## Layout

```
platform/ee/
  LICENSE           proprietary; covers this tree only
  README.md         this file
  src/ee.ts         the fence + SSO, SCIM, masking, audit export
  src/assistant.ts  the in-product assistant tool loop
```

Two things deliberately live **outside** this tree:

- **`platform/migrations/0016_ee.sql`** — OSS. A migration declares data
  structures, not product behavior. Keeping the schema OSS keeps
  `wrangler d1 migrations apply` a single ordered list on every deployment,
  licensed or not. Three empty tables cost nothing. The migration's header
  comment says the same at length.
- **`platform/test/ee.test.ts`** — OSS, in the normal test tree, so one
  `vitest run` covers the whole Worker including the assertion that this
  surface is invisible by default. Testing the fence is an OSS concern.

## Enabling

```toml
# platform/wrangler.toml — only on a deployment licensed under ee/LICENSE
EE_ENABLED = "true"
```

Apply migration 0016 first. The assistant additionally needs the gateway
configured (`GATEWAY_SEALING_KEY`), because it calls the customer's own model
through it.

## Surface

| Method | Path | Auth |
|---|---|---|
| `GET` | `/v1/ee/sso` | session, admin |
| `PUT` | `/v1/ee/sso` | session + CSRF, owner |
| `POST` | `/v1/ee/scim/token` | session + CSRF, owner |
| `GET` | `/v1/ee/scim/v2/Users` | `scim_` bearer |
| `POST` | `/v1/ee/scim/v2/Users` | `scim_` bearer |
| `GET` | `/v1/ee/masking-rules` | session, admin |
| `POST` | `/v1/ee/masking-rules` | session + CSRF, owner |
| `DELETE` | `/v1/ee/masking-rules/{id}` | session + CSRF, owner |
| `GET` | `/v1/ee/audit/export` | session, admin |
| `POST` | `/v1/assistant` | `sk_` key or device token with `read` |

## Known scope limits

- **Masking is not wired into ingest.** `applyMaskingRules` is complete,
  deterministic, and fail-closed, and its CRUD surface is real, but nothing in
  `src/ingest.ts` calls it yet. That is deliberate and out of scope for this
  slice; see the follow-up section in `docs/ee.md`.
- **SCIM is a subset**: bearer auth, `ListResponse`, the `userName eq` filter,
  and provisioning via invite. No `PATCH`, no `DELETE`/deprovisioning, no
  Groups.
- **SSO records the org binding**; WorkOS AuthKit performs the actual SSO
  dance, unchanged, through the existing `/v1/auth/callback`.
- **The assistant's EE gate is a product call**, not a technical one — see the
  note above `handleAssistantRoute` in `src/assistant.ts`.
