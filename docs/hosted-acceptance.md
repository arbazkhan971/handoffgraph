# Hosted end-to-end acceptance

The hosted acceptance runner proves the released user story across the real
browser, Worker, durable stores, and a clean-installed CLI. It is deliberately
not part of ordinary CI: lifecycle and deletion phases use real identities and
mutate the selected hosted environment.

The runner never bypasses AuthKit or Turnstile. It opens two isolated,
non-persistent Chromium contexts and waits while the operator completes the
real identity and challenge UI. Before it clicks an AuthKit action, each
authentication must observe both a successful `challenges.cloudflare.com`
response and a non-empty standard `cf-turnstile-response` inside the matching
`data-hfg-turnstile-action="auth-<intent>"` marker while the top-level document
is the selected HandoffGraph origin's exact `/account` page. A WorkOS-owned or
other provider-side challenge cannot satisfy this check. A flow with no
HandoffGraph-owned challenge fails. It
does not save browser storage state, traces, HAR files, screenshots, video,
cookies, CSRF values, authorization URLs, email addresses, or provider
subjects.

## Phases

`preflight` is read-only. It proves:

- exact immutable Worker version and `git-<source-sha>` tag;
- maintenance mode is absent;
- anonymous account and ingest boundaries;
- the public plans endpoint; and
- the Hosted Basic fence that keeps advanced routes unreachable.

`lifecycle` includes preflight, then performs one launch acceptance run with
two dedicated identities:

1. Complete real AuthKit and Turnstile sign-in or signup in two memory-only
   browser contexts.
2. Refuse identities unless both active-device and lifetime-issuance usage are
   zero with the exact Basic limits of 2 and 10. Create one device credential
   per account through the account UI. The raw values remain in process memory
   and child-process environments only.
3. Exercise the two-active-device quota and revoke the temporary second
   device.
4. Resolve the expected tag through the canonical GitHub repository and bind it
   to the exact deployed source SHA. Require a published, non-draft, immutable
   release with the exact seven-asset inventory and GitHub-computed digests;
   byte-match the local `checksums.txt` to the published asset, verify the exact
   platform archive against it, extract its CLI into a private temporary
   directory, and require its exact expected version. For each account, create a local workstream from a fresh
   config-free working directory, import the digest-pinned checked-in synthetic
   Codex fixture at `testdata/fixtures/codex_session.jsonl` (there is no
   operator-supplied fixture flag), prove `sync --preview` writes no state,
   perform the accepted first sync, and prove a repeat is up to date. Every resolved database,
   object, cache, log, and sync-state path must remain below the temporary data
   directory.
5. Prove each device sees its own workstream and not the other tenant's, and
   that both reciprocal foreign-workspace submissions return 404.
6. Sign account B out, observe the browser traverse the exact WorkOS logout
   endpoint and return, prove its browser session is unauthorized, and prove
   its independent device credential still reads its workspace. Reauthenticate
   B interactively, revoke its primary device, and prove the credential is
   denied. Lifecycle also revokes A's primary device before it succeeds.

`deletion` includes the complete lifecycle, then permanently deletes account A.
Before the one-shot boundary, the supplied WorkOS key must read that account's
exact provider subject with HTTP 200; this binds the later 404 proof to the same
WorkOS environment. It then requires a TTY and the operator must type
`DELETE <workspace_id>` exactly.
After that confirmation the runner deliberately consumes account A's remaining
device issuances, revoking each temporary credential, and proves the 11th
issuance is denied by the lifetime limit of 10. It then creates one known,
content-free sentinel
inside each of the four tenant R2 prefixes. It submits deletion through the
account UI and proves:

- browser and device credentials are denied immediately;
- the same pre-bound WorkOS key returns 404 for the deleted provider identity;
- the D1 tombstone is `complete`, has provider-deletion and completion times,
  and records at least two R2 sweeps;
- every declared workspace purge table plus the user, workspace, provider
  identity, and temporary KV-key ledger has zero matching rows;
- D1's full `PRAGMA foreign_key_check` is empty;
- all four known R2 sentinels return Wrangler's exact not-found result twice,
  and Cloudflare's paginated object API reports every entire tenant prefix is
  empty; and
- the permanent `_hfg/account-deletion-ledger/v1/` resurrection fence remains.

The deletion dispatcher runs every five minutes and needs multiple passes.
The default terminal timeout is 30 minutes.

The app-origin marker observation proves only that the real HandoffGraph
browser surface ran its challenge. It does not certify server-side Siteverify
missing-token/replay rejection or reviewed Cloudflare WAF and rate-limit
rules. Those remain separate fail-closed launch gates until their negative
tests and control-plane evidence exist.

## One-time setup

From `platform/`:

```bash
npm ci
npx playwright install chromium
```

Download the exact platform `.tar.gz` release archive and the same release's
published `checksums.txt`. The runner accepts neither a loose binary nor a ZIP:
it queries the canonical `handoffgraph/handoffgraph` repository through
GitHub's read-only release and
Git-data APIs, resolves either a lightweight or one-level annotated tag to the
exact `--expected-source-sha`, requires the release to be immutable and
published with exactly six platform archives plus `checksums.txt`, validates
GitHub's SHA-256 asset digests, byte-matches the downloaded manifest, verifies
the current OS/architecture archive, extracts only `handoffgraph`, hashes it,
and requires the exact version supplied with `--expected-cli-version`. It never
substitutes `go run` for release acceptance. Public releases need no GitHub
credential; if API rate limits require one, supply `GITHUB_TOKEN` only through
the environment.

Use only fresh, dedicated, single-run test identities. Fresh signup permanently
consumes the 50-account hosted-beta issuance ledger, and account deletion does
not refund that issuance. Device-token issuances are also lifetime-capped per
account, so the harness refuses an identity with any prior issuance instead of
silently weakening or eventually exhausting the proof. A successful lifecycle
leaves no active acceptance device, but its lifetime issuance counters remain
consumed. A deletion run exhausts A's ten issuances only after the exact TTY
confirmation and then deletes A; B's primary device is revoked.

Failure paths attempt to revoke every active acceptance device before closing
the in-memory browser. If the fixed error is `active_device_cleanup_failed`,
sign in to the dedicated identity and revoke every `hfg-acceptance-*` device
before retiring that identity; do not assume an unseen raw credential is gone.

## Run preflight

```bash
npm run acceptance:hosted -- \
  --phase preflight \
  --environment staging \
  --expected-source-sha <40-hex-deployed-commit>
```

Origins are fail-closed to the exact staging and production values checked
into the harness. Override `--origin` only to restate that environment's exact
configured origin; arbitrary hosts, paths, queries, and credentials are
rejected.

## Run the two-account lifecycle

```bash
npm run acceptance:hosted -- \
  --phase lifecycle \
  --environment staging \
  --expected-source-sha <40-hex-deployed-commit> \
  --cli-archive /absolute/path/to/handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz \
  --checksums /absolute/path/to/checksums.txt \
  --expected-cli-version v0.8.0-beta.1 \
  --auth-intent-a signup \
  --auth-intent-b signup
```

Use `signin` for either lane when the dedicated identity already exists.

## Run permanent deletion proof

The operator-side proof uses Wrangler for exact D1 queries and exact R2 object
operations, plus WorkOS's user read endpoint. Supply credentials only as
environment variables; never put them in arguments, shell history, evidence,
or repository files.

```bash
export CLOUDFLARE_API_TOKEN='<scoped token>'
export CLOUDFLARE_ACCOUNT_ID='<32-character account id>'
export WORKOS_API_KEY='<environment API key>'
# Optional for GitHub API rate limits; never place it in command arguments.
export GITHUB_TOKEN='<read-only token>'

npm run acceptance:hosted -- \
  --phase deletion \
  --environment staging \
  --expected-source-sha <40-hex-deployed-commit> \
  --cli-archive /absolute/path/to/handoffgraph_0.8.0-beta.1_darwin_arm64.tar.gz \
  --checksums /absolute/path/to/checksums.txt \
  --expected-cli-version v0.8.0-beta.1 \
  --auth-intent-a signin \
  --auth-intent-b signin
```

The Cloudflare token needs read/write access to the selected D1 database and R2
bucket, including object listing, because this phase creates four exact
sentinels before asking the product to delete them. The account ID is passed to
both Wrangler and the direct R2 listing API so mutation and proof cannot target
different Cloudflare accounts. The runner removes only the exact sentinels it
created, and only when dispatch never began or the response is certainly
prelock. Authentication, network, bucket, and tooling failures are never
accepted as proof that an R2 object is absent.

Deletion dispatch is tracked as `not_dispatched`, `uncertain`, `rejected`, or
`accepted`. The runner removes sentinels only before dispatch or after an
observed 400 or 403 response, whose current handler paths precede the D1
workspace prelock. A 409 or 5xx remains uncertain because either can follow the
prelock; for example, a foreign-link race can return 409 after the resurrection
ledger is written, and ledger reconciliation can return 503. If the DELETE
response or navigation is lost, the runner also leaves the sentinels for the
server saga.

The one-shot boundary begins immediately after the exact TTY confirmation,
before the runner consumes the remaining lifetime issuances. Any later failure
may require retiring that identity, and uncertain or accepted dispatch must not
be retried or cleaned up without operational reconciliation. After an observed
202, direct proof is intentionally not resumable: resuming the WorkOS check
would require retaining the provider subject, which this harness forbids.
Inspect the server tombstone operationally and use a fresh dedicated identity
for a new complete evidence run; never persist the provider subject or device
credential as a checkpoint. The TTY warning states this consequence before it
asks for the exact phrase.

Production requires the same command with `--environment production`, but
only after staging evidence passes and the production cutover is explicitly
approved.

## Evidence and secret handling

Successful runs write an immutable, mode-0600 JSON record beneath
`platform/.acceptance/`. The schema is `hfg.hosted-acceptance.v1`; it contains
only environment, bare origin, source/deployment identity, release archive and
CLI version/hashes,
workspace/workstream IDs, content-free counts, HTTP statuses, and terminal
deletion facts.

The serializer recursively rejects credential-bearing keys and values. Child
process errors, response bodies, WorkOS subjects, emails, browser URLs, device
credentials, cookies, CSRF values, and API keys are never copied into evidence.
Review the sanitized JSON, then copy its allowlisted facts into the appropriate
release acceptance record. Do not commit `platform/.acceptance/` itself.
