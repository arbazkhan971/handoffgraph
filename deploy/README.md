# Domain & deployment topology

Target (per the 300-day plan §7.1): all serving on Cloudflare; the domain
registration stays at Vercel (registrar only) with nameservers pointed at
Cloudflare.

## One-time zone setup (dashboard, ~2 minutes)

1. dash.cloudflare.com → **Add a site** → `handoffgraph.dev` → **Free** plan.
   Cloudflare assigns two nameservers (shown on the final screen).
2. vercel.com → **Domains → handoffgraph.dev → Advanced → Nameservers** →
   replace `ns1/ns2.vercel-dns.com` with the two Cloudflare nameservers.
3. Wait for the zone to activate (usually minutes; up to 24h worst case).

## After the zone is active

Before deploying the landing Worker, provision a KV namespace for waitlist
submissions and uncomment its `WAITLIST` binding in `landing/wrangler.toml`.
This is an external deployment blocker: without the binding the endpoint
intentionally returns 503 and the page preserves answers locally for the
email fallback; it never reports a signup that was not durably stored.
Accepted records are deduplicated by a pseudonymous email hash and expire
after 90 days. Before enabling the public custom domain, also configure a
Cloudflare WAF rate-limit rule or Turnstile for `/api/waitlist`; storage
retention does not replace bot and abuse controls.

    cd landing
    npx wrangler kv namespace create WAITLIST

Paste the returned namespace id into `landing/wrangler.toml`, then deploy.

Before deploying the platform Worker, create/configure the WorkOS AuthKit
application with this exact callback:

    https://api.handoffgraph.dev/v1/auth/callback

Set both credentials through Wrangler; never commit them:

    cd platform
    npx wrangler secret put WORKOS_CLIENT_ID
    npx wrangler secret put WORKOS_API_KEY

Apply `platform/migrations/0001` through `0003` remotely, confirm the
`hosted_beta_capacity` singleton is capped at 50 lifetime account issuances,
and configure
Turnstile or equivalent Cloudflare WAF/rate controls for account creation and
device issuance. Confirm the Basic entitlement still enforces 2 active devices
and 10 device-token issuances over an account lifetime; revocation must not
refund an issuance. The database ceiling and per-workspace quotas bound cost,
but they do not replace edge bot controls. Auth intentionally returns `503`
until WorkOS is configured. Keep the signup switch absent until those gates
pass; then set its exact value to `true`:

    npx wrangler secret put HOSTED_SIGNUP_ENABLED

Existing users may sign in while signup is closed. Paid checkout is not part
of this deployment.

After staging verifies the real AuthKit callback, cookies, quota rollback, and
waitlist persistence, uncomment the `routes` blocks in
`landing/wrangler.toml` and `platform/wrangler.toml` (custom_domain entries),
then:

    cd landing  && npx wrangler deploy   # serves https://handoffgraph.dev
    cd platform && npx wrangler deploy   # serves https://api.handoffgraph.dev

Wrangler creates the DNS records and Universal SSL certificates itself.

## Cleanup (after Cloudflare is verified live)

    vercel project rm handoffgraph-landing
    vercel project rm handoffgraph-api

The Vercel *deployments* go away; the domain registration remains at Vercel
until deliberately transferred.
