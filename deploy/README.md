# Domain and deployment topology

The target serving topology is **Cloudflare-only**: a landing Worker, a Hosted
Basic API Worker, D1, R2, and Cron Triggers. The Cloudflare zone and isolated
staging/production durable resources are provisioned, but the production
service is **not live**. The current `handoffgraph.dev` records still serve the
old Vercel deployments until the controlled cutover succeeds.

The domain registration remains at Vercel (registrar only) and its nameservers
already point at the active Cloudflare zone. The old Vercel projects also still
exist and must be retained as the rollback surface until post-cutover browser
acceptance:

- `handoffgraph-landing`
- `handoffgraph-api`

Do not describe either project as retired before Cloudflare serves the public
domains and the complete acceptance checklist below passes.

## Provisioned Cloudflare topology

Hosted Basic deliberately binds only the stores that support exact
tenant-scoped deletion:

- production D1 `handoffgraph` and R2 `handoffgraph-bodies`;
- staging D1 `handoffgraph-staging` and R2
  `handoffgraph-bodies-staging`;
- `HOSTED_SURFACE="basic"`, which exposes only account, device, event-batch,
  workstream, plan, and health routes.

Queues and KV namespaces have been provisioned for later advanced releases but
are intentionally **not bound** to either Hosted Basic environment. Analytics
Engine is also unbound because its retention model does not provide the exact
per-workspace purge required by account deletion. The advanced surface is
fail-closed: only the exact value `HOSTED_SURFACE="advanced"` enables it;
missing, misspelled, or unexpected values remain on Basic.

The production custom-domain routes are already configured in
`landing/wrangler.toml` and `platform/wrangler.toml`; they are not a commented
setup step. Staging intentionally has `routes = []` and stays on its isolated
`workers.dev` hostname.

## Current migration and launch state

All 22 D1 migrations have been applied to the isolated staging database and
the resulting schema, terminal device-revocation triggers, and beta-capacity
row were verified. Production remains at the 0001 baseline; migrations 0002
through 0022 have **not** been applied there. Do not migrate production until
staging has passed real AuthKit, cross-tenant, quota, sync, and deletion
acceptance.

Production signup remains fail-closed because `HOSTED_SIGNUP_ENABLED` is
absent. Auth also returns `503` until both WorkOS credentials are configured;
there is no fallback identity path. Existing-user sign-in is allowed only once
the real identity configuration is present, while a closed signup callback may
not create an account.

## Remaining staging gates

1. Configure the WorkOS AuthKit application with the exact staging and
   production callbacks, plus both exact **Sign-out redirect URIs** below;
   callback registration alone is insufficient. Add the staging-only client
   ID/API key through Wrangler secrets.

   ```text
   https://handoffgraph-api-staging.arbaz-khan.workers.dev/account
   https://api.handoffgraph.dev/account
   ```

   Set the AuthKit Homepage URL to the matching authenticated `/account`
   origin above. Keep `https://handoffgraph.dev/` as the separate public
   marketing homepage; it is not a WorkOS callback or shared-cookie origin.
   Install the staging credentials only in the named environment:

   ```bash
   npx wrangler secret put WORKOS_CLIENT_ID --env staging
   npx wrangler secret put WORKOS_API_KEY --env staging
   npx wrangler secret put TURNSTILE_SITE_KEY --env staging
   npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
   ```
2. Redeploy/auth-enable the existing anonymous staging Worker and prove the
   real PKCE callback, host-only cookies, CSRF, provider logout and final
   return to the environment's `/account`,
   two-device and ten-lifetime-token limits, quota rollback, and signed-out
   behavior in a browser.

   Every acceptance deployment must carry the exact source identity in its
   Cloudflare Version tag. Pass `--tag git-<SHA-prefix>` to `wrangler deploy`,
   where `<SHA-prefix>` is the first 12 lowercase characters of the 40-character
   commit SHA (for example, `--tag git-96117a900681`). An untagged or
   differently tagged version is not source-pinned and must not receive
   acceptance traffic.
3. Install both Turnstile keys and configure reviewed Cloudflare WAF/rate-limit
   rules for auth start/callback, signup, device issuance, and
   `/v1/event-batches`; the Worker validates auth-start tokens server-side, but
   callback and write-path abuse still need edge controls.
4. Exercise CLI sync against staging. The first upload must show a complete
   content-free preview and require `--accept-redaction`; every uploaded event
   must attest `redaction.version = 1` and `redaction.status` of `clean` or
   `redacted`.
5. Prove cross-tenant reads/writes fail with the documented `404`/`403`
   boundaries.
6. Run owner-confirmed account deletion through WorkOS, R2, and D1, including
   retry/grace-sweep and post-deletion resurrection checks. The implementation
   and local test coverage are reviewed; this gate is the real deployed-flow
   acceptance.

## D1 Time Travel restore runbook

A D1 restore is not a live rollback. Never point a serving Worker at a restored
database until this entire procedure passes. Application triggers are restored
with D1 and cannot prove which terminal credential/deletion decisions the
chosen bookmark predates.

1. Deploy the exact reviewed Worker candidate with
   `HOSTED_MAINTENANCE="true"`, then prove Cloudflare has moved 100% of traffic
   to that version. `GET /healthz` must remain `200`, identify the expected
   Worker version/tag, and return `x-handoffgraph-maintenance: true`; every
   other probe (including `/`, `/account`, auth start/callback, device,
   event-batch, and workstream routes) must return the same no-store `503`
   `hosted_maintenance` response with `Retry-After`. Wait for older in-flight
   invocations to drain before restoring D1. The same fence suppresses cron
   storage sweeps and retries queue deliveries without touching storage. Any
   configured value other than the exact `false` fails closed into this mode,
   so a typo cannot reopen traffic. Keep the fence active through step 9.
2. While the pre-restore D1 is quiesced, export an exact allowlist of every
   credential that is currently usable. Record one cutoff Unix second and
   export these tuples, without emails or raw tokens:

   - browser: `account_sessions.id`, `token_hash`, `user_id`, and the joined
     `users.personal_workspace_id`, limited to unrevoked, unexpired sessions
     whose user, membership, and workspace are all active at the cutoff;
   - device: `devices.id`, `token_hash`, and `workspace_id`, limited to
     unrevoked rows.

   Canonically sort both lists, reject duplicate IDs or hashes, validate every
   ID/hash shape and tuple count, and write the cutoff, counts, and SHA-256 of
   the canonical file to a separate protected manifest. Re-open the file and
   verify that manifest before starting the restore. This active allowlist is
   required because a rotation may have deleted the older credential row;
   exporting only rows with `revoked_at` set, or only an audit of revocation
   actions, is not sufficient. Treat hashes as sensitive credential material:
   use a mode-0600 encrypted temporary location and never log or ticket them.
3. Do **not** restore, replace, or roll back the environment's `BODIES` bucket.
   D1 Time Travel and the independent R2 control plane must have different
   failure domains. Never delete either `_hfg/account-deletion-ledger/v1/` or
   `_hfg/hosted-beta-capacity/v1/`.
4. Inspect lifecycle policy on the exact environment bucket:

   ```bash
   npx wrangler r2 bucket lifecycle list handoffgraph-bodies-staging
   npx wrangler r2 bucket lifecycle list handoffgraph-bodies
   ```

   No expiration rule may use an empty prefix, `_hfg/`, either full control
   prefix, or another prefix that contains those keys. This is an external
   launch/restore gate; Wrangler configuration in this repository does not
   prove the bucket has no dashboard- or API-created lifecycle rule.
5. Validate the bounded capacity object and every deletion-ledger object before
   traffic. Bodies must match their exact schema, hashes must be lowercase
   SHA-256, the capacity list must be sorted/unique and at most 50 entries, and
   a ledger's workspace ID must match its key. Keep any downloaded control
   object in a protected temporary file; do not paste it into logs or tickets.
6. Restore D1. For each permanent R2 deletion ledger, verify the restored D1
   workspace is still absent/deleting and has the matching deletion job. A
   restore from before acceptance may resurrect tenant rows while removing the
   job; browser and device authentication remain blocked by R2, but the cron
   cannot invent the missing job. Reconstruct and review that exact job while
   traffic stays off, then let the normal WorkOS/KV/R2/D1 saga finish. Never
   clear the ledger to make the restored account usable.
7. Before any Worker can serve the restored D1, apply the verified pre-restore
   allowlist as a retention filter, never as a source for recreating or
   un-revoking rows. Leave every already-revoked row revoked. For each restored
   unrevoked browser session, retain it only if its exact
   `(id, token_hash, user_id, personal_workspace_id)` tuple appears in the
   allowlist. For each restored unrevoked device, retain it only if its exact
   `(id, token_hash, workspace_id)` tuple appears. Revoke every other restored
   credential at one reconciliation timestamp. The same ID with a different
   hash, user, or tenant binding is a mismatch and must be revoked; a tuple in
   the allowlist that is absent after restore stays absent.

   If the allowlist or manifest is missing, corrupt, unreadable, fails its
   digest/count/schema checks, or cannot be joined to an exact current binding,
   fail closed by revoking **all** restored browser sessions and device rows.
   Never fall back to a revocation-only audit. After the transaction commits,
   independently query every unrevoked session/device and prove that every
   remaining exact tuple is in the verified allowlist (or prove the unrevoked
   counts are both zero after the revoke-all path). Keep traffic disabled on
   any mismatch.
8. Compare the external capacity record with the complete lifetime WorkOS
   issuance inventory. D1's `hosted_beta_capacity.active_accounts` may be lower
   after Time Travel and is not authoritative for lifetime allocation. Before
   the first signup on an upgraded environment, the R2 record must already
   include one hash per prior issued WorkOS subject; if it is absent while
   prior issuances exist, keep signup disabled and perform a reviewed bootstrap.
9. Deploy the candidate against the restored D1 and unchanged R2 while the
   maintenance fence remains. Use an isolated, non-serving verification path
   to prove a deleted workspace's old browser cookie and device token both
   return `401`, a simulated R2 read failure also denies both, existing-account
   sign-in does not consume capacity, and a new signup fails closed when the
   capacity object is unavailable or full. Only then restore the exact
   `HOSTED_MAINTENANCE="false"` value, deploy that reviewed version, prove the
   maintenance header is absent, and restore user traffic.

An R2 failure after the exact-session D1 prelock but before the permanent
deletion ledger/job is created leaves `workspaces.status = 'deleting'` with no
automatic job. Keep it locked and reconcile the intended ledger/job manually;
do not flip it back to active as a generic retry. This state is deliberately
fail-closed so a sign-out/deletion race cannot reopen credentials.

## Production cutover

Only after every staging gate passes:

1. Put the production API candidate behind the verified maintenance fence
   above, record the previous Worker version for code rollback, then preserve
   a production D1 rollback bookmark/export. Apply all migrations remotely
   through 0022 and verify all 22 entries plus the
   `hosted_beta_capacity = 50` row while public traffic remains fenced.
2. Install production WorkOS and Turnstile secrets while keeping
   `HOSTED_SIGNUP_ENABLED` absent. The public Turnstile site key is safe to
   expose in the account page; its paired secret stays a Wrangler secret.
3. Deploy the API and landing Workers using the already-configured custom
   domains. Replace the stale Vercel DNS records only as part of this
   controlled cutover.
4. Verify anonymous, failed-auth, authenticated, logout, CLI-sync,
   cross-tenant, quota, and account-deletion journeys on the public HTTPS
   origins.
5. Enable signup with the exact value `true` only after Turnstile and the full
   auth/callback/device/event-batch WAF/rate policy are active and the
   closed-signup checks still pass.

Wrangler creates the Worker-domain DNS records and Universal SSL certificates
for the configured custom-domain routes; their presence in TOML does not prove
that the routes have been deployed or that public DNS has been cut over.

## Post-cutover Vercel retirement

Delete the old deployments only after Cloudflare public acceptance is complete
and rollback is no longer needed:

```bash
vercel project rm handoffgraph-landing
vercel project rm handoffgraph-api
```

The deployments go away at this step; the domain registration stays at Vercel
until a separate, deliberate registrar transfer.
