# Privacy and trust model

HandoffGraph captures sensitive material — prompts, commands, file diffs,
test output, and sometimes secrets. Privacy is therefore a purchase driver,
not a checkbox. This document describes the implemented and planned posture.

## Default posture

- **Local-first.** No account is required for local use.
- **No source upload by default.** The local core never uploads anything.
- **Hosted transfer is explicit.** The local CLI does not auto-sync. The
  private-beta API accepts a batch only when a user-created, workspace-scoped
  device token sends it.
- **Redaction preview before first upload.** `handoffgraph sync --preview`
  performs a content-free, network-free preview. The first real transfer for
  an endpoint/device scope refuses without `--accept-redaction`.
- **No metadata-only claim.** Hosted Basic currently preserves validated event
  envelopes within hard byte/count limits. An envelope marked with a redaction
  failure is rejected, but callers must still review what they send.

## Capture vs. sync policy

Capturing a value locally never silently authorizes upload. The following
client-side capture modes remain distinct from the explicit sync action. Only
`full_local` is enforced by the current capture pipeline; the other accepted
config values remain reserved and must not be read as shipped capture claims:

| Mode | Local body | Cloud body |
|---|---|---|
| `metadata_only` (reserved) | not enforced yet | any stored event still gets a redacted copy on explicit sync |
| `full_local` (default) | full local body | redacted copy, only on explicit sync |
| `sanitized` (reserved) | not enforced yet | redacted copy, only on explicit sync |
| `encrypted` (reserved) | not enforced yet | client-encrypted hosted body is not implemented |

Each manual sync fixes an append-sequence high-water mark, previews every
pending event through it, and fails before network I/O if any event cannot be
redacted or fit the hosted limit. The exact redacted batch and deterministic
idempotency key are persisted locally before a request; the cursor advances
only after a validated tenant-bound receipt. See
[`docs/hosted-sync.md`](hosted-sync.md).

## Hook installation

Installing Codex hooks adds only marker-owned matcher groups to
`~/.codex/config.toml`. Claude installation instead adds schema-only groups to
`~/.claude/settings.json` and keeps ownership in the private, locked
`~/.claude/.handoffgraph-hooks.json` sidecar; no HandoffGraph-only key is added
to Claude's handler objects. Exact ownership checks, pre-rename snapshots, and
recoverable before/after transaction digests prevent uninstall from guessing
after drift or a crash. User groups and unrelated settings remain untouched,
and uninstall removes only positively identified groups. The hook callback accepts one
bounded JSON object that matches the pinned provider event schema and appends
its normalized evidence atomically to the user-scoped local event store;
repository `.handoffgraph.toml` files are deliberately ignored by global hook
callbacks, so an untrusted checkout cannot redirect private capture data.
Success emits no stdout. Installation and capture do not upload provider data,
modify Codex trust state, or enable hosted sync. The redaction model is
unchanged: captured events stay local under the same policies as above.

## Redaction pipeline (implemented)

1. **Path denylist** — `.env`, credentials, key files, `*.pem`, `*.key`,
   `id_rsa`, `secrets.yaml`, etc.
2. **Known token patterns** — AWS, GitHub, OpenAI, Anthropic, Slack, Stripe,
   Google, JWTs, bearer/authorization values.
3. **High-entropy detection** — Shannon entropy over tokens with
   mixed-case+digit heuristics.
4. **User regex rules** — configurable.

**Fail-closed**: if a stage errors, the object is marked `REDACTION_FAILED`
and is never exported in its original form. The original secret is never
written into the redaction audit record. Redaction runs once before object
hashing for upload, and again before public sharing.

## What is never in telemetry

Analytics events (when enabled) contain only content-free signals: CLI
version, OS, adapter names/versions, event-kind counts, latency, and error
codes. Never repository names, file paths, prompts, tool arguments, command
output, Git remotes, or source code.

## Threat model (summary)

- **Untrusted content**: all captured terminal/Markdown content is treated as
  untrusted input. The UI must escape HTML, sanitize Markdown, enforce a
  strict Content Security Policy, validate attachment MIME types, and
  neutralize terminal escape sequences (UI ships in v0.5.0).
- **Cross-tenant isolation**: the hosted Worker in `platform/` derives the
  workspace from a hashed device-token binding and scopes every read/write.
  Browser membership never substitutes for device authentication.
- **Secrets in logs**: Worker logs and analytics must never contain sensitive
  payloads.

## Hosted account data

The private-beta account foundation stores the verified WorkOS subject,
verified email address, optional display name/avatar URL, personal workspace
membership, plan/usage counters, and hashes of HandoffGraph session/device
secrets. The callback verifies the WorkOS access token before any account
mutation, then discards it; any refresh token is ignored and discarded. The
only provider-session value retained is the verified, bounded WorkOS `sid`,
used solely as the logout handle. It is not an access/refresh token and is
never exposed by account read models or as a standalone API field. After local
revocation, it appears only inside the no-store WorkOS logout URL returned to
that authenticated browser. Browser sessions expire after 30 days and can be
revoked. A raw device token is returned once and cannot be recovered from the
database.

Explicit sign-out atomically revokes the user's active local browser session,
then navigates the top-level browser through WorkOS's session logout endpoint
with a fixed return to that environment's `/account`. If the local revoke does
not commit, HandoffGraph returns no provider logout URL and clears no cookies.
Both exact staging and production `/account` Sign-out redirect URIs must be
registered with WorkOS; registering only the authentication callback is not
enough.

```text
https://handoffgraph-api-staging.arbaz-khan.workers.dev/account
https://api.handoffgraph.dev/account
```

Hosted Basic is capped at 2 active devices and 10 device-token issuances over
the account lifetime, plus 5,000 events/10 MiB per 30-day period and 25,000
events/64 MiB for the account lifetime. Revoking a device releases an active
slot but does not refund an issuance. Limits stop new hosted writes without
stopping local capture. These caps bound storage; they are not a
retention/deletion policy.

## Hosted self-service deletion (implemented)

The signed-in account page lets the owner of a personal workspace permanently
delete the hosted account and workspace. The unsafe request requires all of an
exact same-origin check, a valid browser session, the session's CSRF token, and
the typed phrase `DELETE <workspace_id>`. The UI adds a final browser
confirmation. An account that is still referenced by any membership or invite
in another workspace is rejected before the purge and must have that link
resolved through support; deletion never follows a user relationship into
another tenant.

Acceptance first serializes against sign-out and reauthentication in D1: the
exact browser credential, including the token hash that passed CSRF preflight,
must still be active and unexpired when the personal workspace changes from
`active` to `deleting`. If sign-out or credential rotation commits first, the
deletion request returns unauthorized without writing the permanent R2 ledger.
If the prelock commits first, deletion owns completion even if sign-out follows.
The prelock immediately removes the workspace from browser-session and device
lookup queries. A workstream read that authenticated just before the prelock
reauthenticates immediately before returning tenant rows, and migration 0022
requires the workspace still be active at the final event-batch receipt insert.
Thus a prelock that wins during an in-flight read/write is terminal even if the
following R2 ledger write fails.

After that prelock, the Worker conditionally creates
`_hfg/account-deletion-ledger/v1/<workspace_id>.json` in the independently
restored `BODIES` R2 bucket. It contains only a schema version, workspace ID,
domain-separated SHA-256 of the deleting user ID, and request time. It contains
no email, name, WorkOS subject, credential hash, or payload. This object is a
permanent resurrection fence: application code never overwrites or deletes it,
it is outside every tenant-data prefix, and bucket lifecycle rules must never
expire `_hfg/` control objects.

Only after the R2 write is durably re-read does one D1 transaction create the
deletion job, revoke every HandoffGraph browser session, device token, public
API key, and gateway key for the workspace, and capture only those
API/gateway keys' exact hashed KV cache names. Every destructive scheduled pass
re-reads and validates the matching R2 ledger before it calls WorkOS or touches
KV, tenant R2 prefixes, or D1. The job then:

1. asks WorkOS to delete the verified provider user. A successful response or
   confirmed `404` is durable progress; HandoffGraph keeps the local provider
   mapping and all tenant D1 data until this succeeds;
2. deletes only the captured `apikey-verdict:<secret_hash>` and
   `vk:<token_hash>` entries from their respective KV namespaces;
3. deletes only objects under the exact `artifacts/<workspace_id>/`,
   `exports/<workspace_id>/`, `attachments/<workspace_id>/`, and
   `gwcache/<workspace_id>/` R2 prefixes;
4. deletes every row scoped to that workspace, its account sessions, and its
   local WorkOS identity mapping in one D1 batch; and
5. waits at least five minutes, invalidates those same KV entries again, and
   requires a later empty R2 sweep before marking the job complete. This catches
   an edge-cache copy or object write that authenticated immediately before
   credential revocation.

WorkOS, KV, R2, or D1 failures after job creation leave the workspace locked and
retry automatically. If R2 fails after the D1 prelock but before the external
ledger/job exists, the workspace remains deliberately locked and requires
operator reconciliation; silently returning it to active would reopen the
sign-out/deletion race. Stored device/session rows may still be unrevoked in
that intermediate state, but the non-active workspace and final commit/read
fences make them unusable. If a captured KV key's namespace is unavailable, the
local purge fails closed instead of leaving a usable cached credential behind.
A failed D1 purge statement rolls the whole tenant purge back, while schema
resurrection guards prevent in-flight requests from recreating data for a
tombstoned workspace.

Every released Hosted Basic browser-session route and both released
device-token routes (`POST /v1/event-batches` and `GET /v1/workstreams`) check
the R2 fence after their D1 credential lookup and before returning data or
writing. A present ledger is indistinguishable from an invalid credential.
When `BODIES` is configured, a malformed binding or R2 `head` failure also
denies authentication. A Worker that declares `HOSTED_SURFACE="basic"` also
denies browser and device authentication when `BODIES` is missing; checked-in
TOML is not treated as runtime proof that the binding exists. The AuthKit
callback checks the same required fence before minting a new local browser
session, so a pre-deletion D1 Time Travel restore cannot reissue access.
Ordinary event, audit, manifest, attachment, dashboard-version, and
gateway-request updates/deletes remain forbidden; migration 0018 permits a
delete only for the exact workspace carrying the owner-authorized tombstone.

After completion, the permanent D1 tombstone retains only the workspace ID,
request/provider-deletion/completion times, terminal status, and sweep count.
The temporary hashed KV-key list is removed. The D1 tombstone retains no email,
name, provider subject, credential hash, payload, or R2 object key. The separate
permanent R2 ledger remains as described above and is never included in a
workspace purge. Deletion does not touch local HandoffGraph stores on the
user's machines.

The 50-account lifetime ceiling also has an independent R2 control record at
`_hfg/hosted-beta-capacity/v1/allocations.json`. Before a new WorkOS identity
can enter the D1 account transaction, the Worker burns one issuance by adding a
domain-separated SHA-256 of the immutable WorkOS subject with conditional ETag
compare-and-swap and bounded retry. Concurrent callbacks cannot overwrite each
other, same-subject retries are idempotent, and a later D1 failure deliberately
does not refund the issuance. Existing-account sign-in does not consume a new
entry. The record contains at most 50 hashes and no email, token, or raw WorkOS
subject. Each domain-separated subject hash survives account deletion
indefinitely, is outside every tenant prefix, and is deliberately excluded from
the tenant purge solely to enforce the 50-lifetime-issuance cap. Signup fails
closed if this R2 record cannot be read or conditionally written, so restoring
D1 to an older `active_accounts` value cannot issue a 51st lifetime account.

## External-store launch fence

Hosted Basic runs with `HOSTED_SURFACE="basic"`: advanced team, webhook,
gateway, public-API-key, analytics, and related routes are not reachable. Its
production and staging configurations deliberately bind neither Analytics
Engine nor Queues. This is required for an honest tenant-selective deletion
promise:

- Cloudflare Analytics Engine retains data for three months and exposes query,
  not tenant-selective row deletion, in its SQL API. Workspace identifiers must
  not be mirrored there for Hosted Basic.
- Cloudflare Queues retain unacknowledged messages until delivery or configured
  expiry. Purge operates on the whole queue, so it cannot safely remove one
  workspace's webhook payloads without affecting other tenants.

Keep Analytics Engine and the advanced webhook/queue surface disabled for the
Hosted Basic launch. An advanced launch needs either an external-store design
that can delete one tenant without crossing another or an explicitly reviewed
retention/privacy contract that does not promise immediate selective erasure.
See Cloudflare's [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/),
[Analytics Engine SQL statements](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/),
[Queues retention configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/),
and [queue purge behavior](https://developers.cloudflare.com/queues/configuration/pause-purge/).

## Limits of this implementation

The open-source repository now contains a private-beta hosted account/API
foundation, explicit fail-closed CLI sync, and self-service deletion path, but
this document is not a claim that they are publicly deployed. Encrypted body
storage, shares, billing, production retention, and edge bot controls remain
unfinished. Staging already has its isolated R2 bucket and all 22 D1
migrations through 0022. WorkOS credentials, Turnstile/WAF, the production R2
binding, production D1 migrations 0002 through 0022, production domains, and
authenticated staging deletion/retry verification across WorkOS, R2, and D1
are mandatory before public signup. Local Core remains fully usable offline
without an account or cloud service.

The external deletion ledger is intentionally narrow: it makes credentials for
a deleted workspace terminal across a D1 restore. It does not record ordinary
sign-out or individual device-revocation events for an otherwise active
workspace. Those D1 `revoked_at` values can move backwards under out-of-band
Time Travel, and credential rotation can remove the old row entirely. A
restored D1 database must therefore never receive user traffic until every
restored active session/device is filtered against the exact
ID/hash/user-or-tenant tuple in a verified allowlist exported while the
pre-restore database was quiesced. A same-ID row with any different binding is
revoked. The allowlist never recreates or un-revokes a row. If the allowlist is
missing, corrupt, unreadable, or unverifiable, every restored session and
device is revoked before traffic; a revocation-only audit is not an acceptable
fallback. The exact validation and revoke-all acceptance are in
`deploy/README.md`.
